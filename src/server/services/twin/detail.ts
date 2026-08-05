/**
 * Evidence pin detail — everything OBV already records about one photo,
 * read-only, with the subsystem gates inherited rather than widened.
 *
 * Distances are computed ONLY between real recorded coordinates (the
 * pin's GPS fix, the milestone's recorded segment geometry, the recorded
 * site boundary). When either side has no coordinates the distance is
 * null — stated as not computable, never guessed.
 */
import * as repo from "../../db/repo";
import * as evidenceIntel from "../evidenceIntel";
import { canViewEvidenceIntel } from "../evidenceIntel/core";
import { TimelineError, requireVisibleProject } from "../timeline/core";
import type { TwinPinDetail, User } from "../../../shared/types";
import {
  distanceToPolylineM,
  insidePolygon,
  makeFrame,
  projectRing,
  ringCentroid,
  toLocal,
} from "./geometry";

const safe = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export function twinPinDetail(user: User, projectId: string, evidenceId: string): TwinPinDetail {
  const project = requireVisibleProject(user, projectId);
  const evidence = repo.getEvidence(String(evidenceId ?? ""));
  const milestone = evidence ? repo.getMilestone(evidence.milestoneId) : null;
  // Same-404: an evidence item outside this project is indistinguishable
  // from one that does not exist.
  if (!evidence || !milestone || milestone.projectId !== project.id) {
    throw new TimelineError("Not found", 404);
  }

  const verification = safe(() => repo.getVerificationForEvidence(evidence.id), null);
  const capturedBy = safe(() => repo.getUser(evidence.userId), null);

  // ---- distances over real coordinates only ----
  let toPlannedGeometryM: number | null = null;
  let toSiteCentroidM: number | null = null;
  let insideBoundary: boolean | null = null;
  const centroid = ringCentroid(project.siteBoundary);
  if (evidence.latitude !== null && evidence.longitude !== null && centroid) {
    const frame = makeFrame(centroid.lat, centroid.lng);
    const p = toLocal(frame, evidence.longitude, evidence.latitude);
    toSiteCentroidM = round1(Math.hypot(p.x, p.y));
    insideBoundary = insidePolygon(p, projectRing(frame, project.siteBoundary));
    const segment = safe(() => repo.listSpatialFeatures(project.id), []).find(
      (f) => f.kind === "SEGMENT" && f.milestoneId === milestone.id && f.geometry.length > 0
    );
    if (segment) {
      toPlannedGeometryM = round1(
        distanceToPolylineM(p, projectRing(frame, segment.geometry)) ?? NaN
      );
      if (Number.isNaN(toPlannedGeometryM)) toPlannedGeometryM = null;
    }
  }

  // ---- role-gated advisory sections (null = not visible to this role) ----
  const advisoryVisible = canViewEvidenceIntel(user);
  const advisorySignals = advisoryVisible
    ? safe(() => evidenceIntel.signalsForSubject(user, "EVIDENCE_ITEM", evidence.id), []).map((s) => ({
        id: s.id,
        category: s.category,
        severity: s.severity,
        confidence: s.confidence,
        title: s.title,
        explanation: s.explanation,
        recommendation: s.recommendation,
      }))
    : null;
  const facts = advisoryVisible ? safe(() => evidenceIntel.getMetadataFacts(evidence.id), null) : null;
  const ocr = advisoryVisible
    ? safe(() => evidenceIntel.listExtractionsForSubject("EVIDENCE_ITEM", evidence.id), []).map((x) => ({
        docKind: x.docKind,
        status: x.status,
        overallConfidence: x.overallConfidence,
        extractedAt: x.extractedAt,
      }))
    : null;

  // ---- nearby records, by real distance where possible ----
  const inspections = safe(() => repo.listInspectionsForMilestone(milestone.id), []).map((i) => ({
    id: i.id,
    status: i.status,
    label: `${i.inspectionType ?? "Inspection"}${i.inspectionReference ? ` ${i.inspectionReference}` : ""}`,
  }));
  const siblings = safe(() => repo.listEvidenceForMilestone(milestone.id), [])
    .filter((e) => e.id !== evidence.id)
    .slice(0, 8)
    .map((e) => {
      let d: number | null = null;
      if (
        evidence.latitude !== null && evidence.longitude !== null &&
        e.latitude !== null && e.longitude !== null && centroid
      ) {
        const frame = makeFrame(centroid.lat, centroid.lng);
        const a = toLocal(frame, evidence.longitude, evidence.latitude);
        const b = toLocal(frame, e.longitude, e.latitude);
        d = round1(Math.hypot(a.x - b.x, a.y - b.y));
      }
      return { id: e.id, label: `Captured ${e.capturedAt.slice(0, 16).replace("T", " ")} UTC`, distanceM: d };
    });

  return {
    evidence: {
      id: evidence.id,
      milestoneId: milestone.id,
      milestoneTitle: milestone.title,
      photoPath: evidence.photoPath,
      capturedAt: evidence.capturedAt,
      uploadedAt: evidence.uploadedAt,
      capturedBy: capturedBy?.name ?? null,
      device: evidence.deviceMetadata?.userAgent ?? "not recorded",
      hasGps: evidence.latitude !== null && evidence.longitude !== null,
      latitude: evidence.latitude,
      longitude: evidence.longitude,
      isDemoFallback: evidence.isDemoFallback,
    },
    verification: verification
      ? {
          verdict: verification.verdict,
          confidence: verification.confidence,
          source: verification.source,
          checks: verification.checks,
          reasoning: verification.reasoning,
        }
      : null,
    distances: { toPlannedGeometryM, toSiteCentroidM, insideBoundary },
    advisorySignals,
    metadataFacts: facts
      ? {
          uploadDelaySeconds: facts.uploadDelaySeconds,
          mimeType: facts.mimeType,
          fileSize: facts.fileSize,
          width: facts.width,
          height: facts.height,
          deviceFingerprint: facts.deviceFingerprint,
        }
      : null,
    ocr,
    timelineEventId: `EVIDENCE:EVIDENCE_UPLOADED:${evidence.id}`,
    stage: { milestoneId: milestone.id, title: milestone.title, status: milestone.status },
    nearby: { inspections, evidence: siblings },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
