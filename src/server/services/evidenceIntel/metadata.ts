/**
 * Metadata Intelligence engine.
 *
 * Derives per-evidence metadata facts and generates ADVISORY findings.
 * Missing metadata is never treated as fraud — it is reported as an
 * INFO-level completeness note. Every finding explains what it compared
 * and recommends a reviewer action, never a control decision.
 */
import * as repo from "../../db/repo";
import * as evidenceIntelRepo from "../../db/evidenceIntelRepo";
import { pointInPolygon } from "../geo";
import type { EvidenceItem, EvidenceMetadataFacts } from "../../../shared/types";
import { evidenceContext, nowIso, sha256Hex, type SignalDraft } from "./core";

/** How long after capture an upload is unremarkable. Beyond this the
 *  timing is surfaced for a look — never as a verdict. */
const LATE_UPLOAD_HOURS = 72;

/** Compute (and cache) the metadata facts for one evidence item. Pure
 *  derivation — the evidence row is never modified. */
export function computeMetadataFacts(evidence: EvidenceItem): EvidenceMetadataFacts {
  const ctx = evidenceContext(evidence.id);
  const capturedMs = Date.parse(evidence.capturedAt);
  const uploadedMs = Date.parse(evidence.uploadedAt);
  const uploadDelaySeconds =
    Number.isFinite(capturedMs) && Number.isFinite(uploadedMs)
      ? Math.round((uploadedMs - capturedMs) / 1000)
      : null;
  // Device metadata is coarse (userAgent/platform/screen/language); its
  // fingerprint is a stable hash, deliberately NOT identifying.
  const deviceFingerprint = evidence.deviceMetadata
    ? sha256Hex(
        [
          evidence.deviceMetadata.platform,
          evidence.deviceMetadata.screen,
          evidence.deviceMetadata.language,
          evidence.deviceMetadata.userAgent,
        ].join("|")
      )
    : null;
  const facts: EvidenceMetadataFacts = {
    evidenceItemId: evidence.id,
    organizationId: ctx?.organizationId ?? null,
    projectId: ctx?.projectId ?? null,
    capturedAt: evidence.capturedAt,
    uploadedAt: evidence.uploadedAt,
    uploadDelaySeconds,
    hasGps: evidence.latitude !== null && evidence.longitude !== null,
    latitude: evidence.latitude,
    longitude: evidence.longitude,
    // Photo dimensions / size / MIME are not captured on the evidence row
    // in this build; they are reported as "not available" rather than
    // invented, which is itself a completeness signal.
    mimeType: null,
    fileSize: null,
    width: null,
    height: null,
    deviceFingerprint,
    documentCreationDate: null,
    contentHash: evidence.hash,
    computedAt: nowIso(),
  };
  evidenceIntelRepo.upsertMetadataFacts(facts);
  return facts;
}

/** Advisory findings from one item's metadata. Returns drafts; the
 *  caller records them under an analysis run. */
export function metadataFindings(evidence: EvidenceItem, facts: EvidenceMetadataFacts): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  const base = {
    subjectType: "EVIDENCE_ITEM" as const,
    subjectId: evidence.id,
    organizationId: facts.organizationId,
    projectId: facts.projectId,
  };

  // Missing metadata — INFO, explicitly not fraud.
  const missing: string[] = [];
  if (!facts.hasGps) missing.push("GPS location");
  if (!facts.mimeType) missing.push("MIME type");
  if (facts.width === null || facts.height === null) missing.push("image dimensions");
  if (facts.fileSize === null) missing.push("file size");
  if (missing.length > 0) {
    drafts.push({
      ...base,
      category: "MISSING_METADATA",
      severity: "INFO",
      confidence: 0.4,
      title: `Evidence is missing metadata: ${missing.join(", ")}`,
      explanation:
        `This evidence item does not carry ${missing.join(", ")}. Missing metadata is common ` +
        "(older devices, permission-restricted capture, offline submission) and is NOT evidence of a problem. " +
        "It is surfaced only so a reviewer can decide whether richer metadata is worth requesting.",
      comparison: { present: { gps: facts.hasGps, contentHash: Boolean(facts.contentHash) }, missing },
      recommendation: "No action required unless your policy needs this metadata; then request a recapture.",
      signalKey: `missing-metadata:${evidence.id}`,
    });
  }

  // Timestamp inconsistency — captured AFTER upload is physically
  // impossible; a large capture->upload gap is merely notable.
  if (facts.uploadDelaySeconds !== null && facts.uploadDelaySeconds < -60) {
    drafts.push({
      ...base,
      category: "TIMESTAMP_INCONSISTENCY",
      severity: "MEDIUM",
      confidence: 0.75,
      title: "Capture timestamp is after the upload timestamp",
      explanation:
        `The recorded capture time (${evidence.capturedAt}) is later than the upload time ` +
        `(${evidence.uploadedAt}). A photo cannot be uploaded before it is taken, so one of the two ` +
        "device clocks is likely wrong. This is advisory — it does not by itself mean the evidence is invalid.",
      comparison: { capturedAt: evidence.capturedAt, uploadedAt: evidence.uploadedAt, deltaSeconds: facts.uploadDelaySeconds },
      recommendation: "Confirm the capturing device's clock; consider a recapture if the timeline cannot be reconciled.",
      signalKey: `timestamp-inconsistency:${evidence.id}`,
    });
  } else if (facts.uploadDelaySeconds !== null && facts.uploadDelaySeconds > LATE_UPLOAD_HOURS * 3600) {
    drafts.push({
      ...base,
      category: "SUSPICIOUS_UPLOAD_TIMING",
      severity: "LOW",
      confidence: 0.5,
      title: `Evidence uploaded ${Math.round(facts.uploadDelaySeconds / 3600)}h after capture`,
      explanation:
        "A long gap between capture and upload is normal for offline field work, but it widens the window " +
        "in which the file could change. Surfaced for awareness only; it is not a defect.",
      comparison: { capturedAt: evidence.capturedAt, uploadedAt: evidence.uploadedAt, gapHours: Math.round(facts.uploadDelaySeconds / 3600) },
      recommendation: "No action required; note the delay if the milestone timeline is sensitive.",
      signalKey: `late-upload:${evidence.id}`,
    });
  }

  // GPS conflict — evidence carries a fix that lies outside the project's
  // recorded site boundary. Advisory; the authoritative geofence check
  // lives in the verification layer and is unchanged.
  if (facts.hasGps && facts.projectId) {
    const project = repo.getProject(facts.projectId);
    const boundary = project?.siteBoundary;
    if (boundary && boundary.length >= 4 && !pointInPolygon(facts.longitude!, facts.latitude!, boundary)) {
      drafts.push({
        ...base,
        category: "GPS_CONFLICT",
        severity: "MEDIUM",
        confidence: 0.7,
        title: "Evidence GPS is outside the recorded project boundary",
        explanation:
          `The evidence GPS (${facts.latitude!.toFixed(5)}, ${facts.longitude!.toFixed(5)}) falls outside the ` +
          "project's recorded site boundary. Boundaries are approximate and phones drift, so this is advisory — " +
          "a reviewer should confirm the capture location, not treat it as proof of anything.",
        comparison: { evidenceGps: { lat: facts.latitude, lng: facts.longitude }, boundaryVertices: boundary.length },
        recommendation: "Confirm the capture location with the field team; the governed geofence check is unchanged.",
        signalKey: `gps-conflict:${evidence.id}`,
      });
    }
  }

  return drafts;
}
