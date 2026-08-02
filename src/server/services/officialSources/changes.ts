/**
 * Deterministic change detection between successive snapshots of one
 * external record.
 *
 * Diffs compare the latest two CANDIDATE normalizations (each pinned to
 * its immutable snapshot), field by field, and classify the change with
 * a plain-language explanation. A record that stops appearing at the
 * source is labeled UNAVAILABLE/MISSING — never inferred to be revoked.
 * Change events are idempotent on (record, prev, current, kind).
 */
import * as repo from "../../db/repo";
import * as osRepo from "../../db/officialSourcesRepo";
import type { SourceCandidate, SourceChangeEvent, SourceChangeKind } from "../../../shared/types";
import { nowIso, sha256Hex } from "./core";

const DIFF_FIELDS: Array<{ field: keyof SourceCandidate; label: string }> = [
  { field: "verbatimStatus", label: "status" },
  { field: "issuanceDate", label: "issuance date" },
  { field: "expirationDate", label: "expiration date" },
  { field: "inspectionDate", label: "inspection date" },
  { field: "inspectionResult", label: "inspection result" },
  { field: "partyName", label: "contractor / party name" },
  { field: "address", label: "address" },
];

interface Classified {
  kind: SourceChangeKind;
  severity: SourceChangeEvent["severity"];
  explanation: string;
}

/** Classify a status-text change using the source's own wording. The
 *  classification quotes the verbatim values — OBV never replaces the
 *  source's terminology with its own conclusion. */
function classifyStatusChange(prev: string | null, curr: string | null, recordType: string): Classified {
  const c = (curr ?? "").toLowerCase();
  const quote = `The source now reports "${curr ?? "(blank)"}" where it previously reported "${prev ?? "(blank)"}".`;
  if (/revok/.test(c)) {
    return { kind: "REVOKED", severity: "HIGH", explanation: `${quote} The official wording indicates a revocation — review before any further reliance on this record.` };
  }
  if (/stop[\s-]?work/.test(c)) {
    return { kind: "STOP_WORK", severity: "HIGH", explanation: `${quote} The official wording indicates a stop-work condition.` };
  }
  if (/suspend/.test(c) && recordType === "LICENSE") {
    return { kind: "LICENSE_SUSPENDED", severity: "HIGH", explanation: `${quote} The official wording indicates a suspended license.` };
  }
  if (/expir/.test(c)) {
    return {
      kind: recordType === "LICENSE" ? "LICENSE_EXPIRED" : "EXPIRED",
      severity: "MEDIUM",
      explanation: `${quote} The official wording indicates expiration.`,
    };
  }
  if (/issued|active|approved/.test(c) && !prev) {
    return { kind: "ISSUED", severity: "INFO", explanation: quote };
  }
  return { kind: "STATUS_CHANGED", severity: "MEDIUM", explanation: quote };
}

/** Detect changes for one external record after a new candidate was
 *  recorded. Returns the change events that were newly created. */
export function detectChangesForRecord(sourceId: string, externalId: string): SourceChangeEvent[] {
  const latest = osRepo.latestCandidatesForRecord(sourceId, externalId, 2);
  if (latest.length < 2) return [];
  const [current, previous] = latest;
  if (current.candidateKey === previous.candidateKey) return [];

  const changedFields: Array<{ field: string; previous: string | null; current: string | null }> = [];
  for (const { field, label } of DIFF_FIELDS) {
    const prevValue = (previous[field] as string | null) ?? null;
    const currValue = (current[field] as string | null) ?? null;
    if (prevValue !== currValue) changedFields.push({ field: label, previous: prevValue, current: currValue });
  }
  if (changedFields.length === 0) return [];

  // Primary classification: status first, then inspection result, then
  // expiration, then party, else generic field change.
  let classified: Classified;
  const statusChange = changedFields.find((c) => c.field === "status");
  const inspectionChange = changedFields.find((c) => c.field === "inspection result");
  const expirationChange = changedFields.find((c) => c.field === "expiration date");
  const partyChange = changedFields.find((c) => c.field === "contractor / party name");
  if (statusChange) {
    classified = classifyStatusChange(statusChange.previous, statusChange.current, current.recordType);
  } else if (inspectionChange) {
    const failed = /fail|correction|reinspect/i.test(inspectionChange.current ?? "");
    classified = {
      kind: "INSPECTION_RESULT_CHANGED",
      severity: failed ? "HIGH" : "MEDIUM",
      explanation:
        `The official inspection result changed from "${inspectionChange.previous ?? "(none)"}" to ` +
        `"${inspectionChange.current ?? "(none)"}".` + (failed ? " The new wording indicates a failed or corrective outcome." : ""),
    };
  } else if (expirationChange) {
    classified = {
      kind: "EXPIRATION_CHANGED",
      severity: "LOW",
      explanation: `The recorded expiration date changed from ${expirationChange.previous ?? "(none)"} to ${expirationChange.current ?? "(none)"}.`,
    };
  } else if (partyChange) {
    classified = {
      kind: "PARTY_CHANGED",
      severity: "MEDIUM",
      explanation: `The recorded contractor/party changed from "${partyChange.previous ?? "(none)"}" to "${partyChange.current ?? "(none)"}".`,
    };
  } else {
    classified = {
      kind: "FIELD_CHANGED",
      severity: "LOW",
      explanation: `Recorded fields changed at the source: ${changedFields.map((c) => c.field).join(", ")}.`,
    };
  }

  const event: SourceChangeEvent = {
    id: repo.newId(),
    sourceId,
    externalId,
    previousSnapshotId: previous.snapshotId,
    currentSnapshotId: current.snapshotId,
    previousCandidateId: previous.id,
    currentCandidateId: current.id,
    changeKind: classified.kind,
    changedFields,
    sourceUpdatedAt: null,
    retrievedAt: current.createdAt,
    connectorVersion: current.connectorVersion,
    severity: classified.severity,
    explanation: classified.explanation,
    organizationId: current.organizationId ?? previous.organizationId,
    projectId: current.projectId ?? previous.projectId,
    createdAt: nowIso(),
    changeKey: sha256Hex(`${sourceId}:${externalId}:${previous.id}:${current.id}:${classified.kind}`),
  };
  return osRepo.insertChangeEvent(event) ? [event] : [];
}

/** Record that a previously-seen record no longer appears at the source.
 *  Explicitly labeled unavailable/missing — NOT revoked — until a human
 *  reviews it. */
export function recordUnavailable(
  sourceId: string,
  externalId: string,
  currentSnapshotId: string
): SourceChangeEvent | null {
  const latest = osRepo.latestCandidatesForRecord(sourceId, externalId, 1);
  if (latest.length === 0) return null;
  const previous = latest[0];
  const event: SourceChangeEvent = {
    id: repo.newId(),
    sourceId,
    externalId,
    previousSnapshotId: previous.snapshotId,
    currentSnapshotId,
    previousCandidateId: previous.id,
    currentCandidateId: null,
    changeKind: "RECORD_UNAVAILABLE",
    changedFields: [{ field: "availability", previous: "present at source", current: "not returned by source" }],
    sourceUpdatedAt: null,
    retrievedAt: nowIso(),
    connectorVersion: previous.connectorVersion,
    severity: "MEDIUM",
    explanation:
      "The source no longer returns this record. That does NOT mean it was revoked — records disappear from " +
      "feeds for many reasons (renumbering, dataset lag, publication changes). Labeled unavailable until a " +
      "reviewer checks the official portal.",
    organizationId: previous.organizationId,
    projectId: previous.projectId,
    createdAt: nowIso(),
    changeKey: sha256Hex(`${sourceId}:${externalId}:${previous.id}:unavailable:${currentSnapshotId}`),
  };
  return osRepo.insertChangeEvent(event) ? event : null;
}
