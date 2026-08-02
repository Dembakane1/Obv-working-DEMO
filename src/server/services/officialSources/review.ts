/**
 * Official Source Review Queue — where retrieval outcomes reach a HUMAN.
 *
 * The queue holds advisory items derived from matches and change events.
 * Only an authorized reviewer moves an item, and the ONLY paths to an
 * authoritative OBV record run through the existing governed commands:
 *
 *   confirm+attach   -> permits.recordOfficialSource (its roles + checks)
 *   discrepancy      -> dmvCompliance.recordSourceVerification (its roles)
 *   promote          -> exceptions.createManualException (its roles)
 *
 * The connector layer itself NEVER writes permit-basis, inspection-
 * result, verification, or exception records, never approves or rejects
 * a draw, never releases funds, and never touches historical packages.
 */
import * as repo from "../../db/repo";
import * as osRepo from "../../db/officialSourcesRepo";
import * as authz from "../authz";
import * as permits from "../permits";
import * as dmvCompliance from "../dmvCompliance";
import * as exceptions from "../exceptions";
import type {
  OfficialSource,
  Permit,
  Project,
  SourceCandidate,
  SourceChangeEvent,
  SourceMatch,
  SourceReviewEventKind,
  SourceReviewItem,
  SourceSnapshot,
  User,
} from "../../../shared/types";
import type { CandidateEvaluation } from "./matching";
import {
  OfficialSourceError,
  assertSourceReviewer,
  assertSourceViewer,
  nowIso,
  sha256Hex,
} from "./core";
import { signalEnforcement, signalLicenseInconsistent, signalRecordMissing, signalSourceConflict } from "./evidenceLink";

// ============================================================ enqueue

interface ItemDraft {
  eventKind: SourceReviewEventKind;
  severity: SourceReviewItem["severity"];
  title: string;
  explanation: string;
  suggestedAction: string;
  blockingImplications: string | null;
  candidateId: string | null;
  matchId: string | null;
  changeEventId: string | null;
  affectedEntityType: string | null;
  affectedEntityId: string | null;
  organizationId: string | null;
  projectId: string | null;
  itemKey: string;
}

function pushItem(draft: ItemDraft): boolean {
  // Items without a project have no tenant to review them — they surface
  // in the workspace candidate lists instead of anyone's queue.
  if (!draft.projectId) return false;
  const at = nowIso();
  const item: SourceReviewItem = {
    id: repo.newId(),
    organizationId: draft.organizationId,
    projectId: draft.projectId,
    eventKind: draft.eventKind,
    candidateId: draft.candidateId,
    matchId: draft.matchId,
    changeEventId: draft.changeEventId,
    affectedEntityType: draft.affectedEntityType,
    affectedEntityId: draft.affectedEntityId,
    severity: draft.severity,
    title: draft.title,
    explanation: draft.explanation,
    suggestedAction: draft.suggestedAction,
    blockingImplications: draft.blockingImplications,
    status: "OPEN",
    resolvedByUserId: null,
    resolvedAt: null,
    resolutionNote: null,
    linkedOfficialSourceRecordId: null,
    linkedSourceVerificationId: null,
    promotedExceptionId: null,
    createdAt: at,
    updatedAt: at,
    itemKey: draft.itemKey,
  };
  const inserted = osRepo.insertReviewItem(item);
  if (inserted) {
    osRepo.insertReviewEvent({
      id: repo.newId(), itemId: item.id, occurredAt: at, actorUserId: null,
      kind: "CREATED", detail: draft.eventKind,
    });
  }
  return inserted;
}

function licenseProblemKind(candidate: SourceCandidate): SourceReviewEventKind | null {
  const s = (candidate.normalizedStatus ?? "").toLowerCase();
  if (/suspend/.test(s)) return "LICENSE_SUSPENDED";
  if (/expir|lapsed|inactive/.test(s)) return "LICENSE_EXPIRED";
  return null;
}

const CHANGE_KIND_TO_EVENT: Partial<Record<SourceChangeEvent["changeKind"], SourceReviewEventKind>> = {
  STOP_WORK: "STOP_WORK_DETECTED",
  ENFORCEMENT_ACTION: "ENFORCEMENT_DETECTED",
  REVOKED: "PERMIT_STATUS_CHANGED",
  LICENSE_EXPIRED: "LICENSE_EXPIRED",
  LICENSE_SUSPENDED: "LICENSE_SUSPENDED",
  RECORD_UNAVAILABLE: "RECORD_DISAPPEARED",
  INSPECTION_RESULT_CHANGED: "INSPECTION_RESULT_CHANGED",
  STATUS_CHANGED: "PERMIT_STATUS_CHANGED",
  EXPIRED: "PERMIT_STATUS_CHANGED",
  EXPIRATION_CHANGED: "PERMIT_STATUS_CHANGED",
  PARTY_CHANGED: "CONTRACTOR_NAME_MISMATCH",
  ISSUED: "PERMIT_STATUS_CHANGED",
  NEW_INSPECTION: "INSPECTION_RESULT_CHANGED",
  FIELD_CHANGED: "PERMIT_STATUS_CHANGED",
};

/** Derive review-queue items (and Evidence Intelligence advisory
 *  signals) from one candidate's evaluation + any change events. Called
 *  by the polling pipeline after each retrieval. Returns items queued. */
export function enqueueFromRetrieval(
  candidate: SourceCandidate,
  evaluation: CandidateEvaluation,
  changeEvents: SourceChangeEvent[]
): number {
  let queued = 0;

  for (const match of evaluation.matches) {
    if (match.verdict === "CONFLICT") {
      signalSourceConflict(candidate, match);
      if (pushItem({
        eventKind: "SOURCE_CONFLICT",
        severity: "HIGH",
        title: `Official record ${candidate.externalId} conflicts with an OBV record`,
        explanation:
          "The official source record matches on identity but disagrees on other recorded fields. The " +
          "side-by-side comparison shows exactly what differs.",
        suggestedAction: "Resolve the discrepancy before attaching; record a discrepancy if the sources disagree.",
        blockingImplications:
          "If promoted to an exception, draws relying on the affected permit may be held until resolved.",
        candidateId: candidate.id, matchId: match.id, changeEventId: null,
        affectedEntityType: match.obvEntityType, affectedEntityId: match.obvEntityId,
        organizationId: match.organizationId, projectId: match.projectId,
        itemKey: `conflict:${match.matchKey}`,
      })) queued += 1;
    } else if (match.verdict === "AMBIGUOUS") {
      if (pushItem({
        eventKind: "AMBIGUOUS_MATCH",
        severity: "MEDIUM",
        title: `Official record ${candidate.externalId} matches multiple OBV records`,
        explanation:
          "The record matches more than one OBV entity with similar strength; it will not be linked " +
          "automatically. A reviewer must decide which (if any) it belongs to.",
        suggestedAction: "Compare each possible target and confirm the right one, or reject the match.",
        blockingImplications: null,
        candidateId: candidate.id, matchId: match.id, changeEventId: null,
        affectedEntityType: match.obvEntityType, affectedEntityId: match.obvEntityId,
        organizationId: match.organizationId, projectId: match.projectId,
        itemKey: `ambiguous:${match.matchKey}`,
      })) queued += 1;
    } else if (match.verdict === "EXACT_MATCH" || match.verdict === "HIGH_CONFIDENCE_MATCH") {
      const licenseKind = licenseProblemKind(candidate);
      if (licenseKind) {
        signalLicenseInconsistent(candidate, match);
        if (pushItem({
          eventKind: licenseKind,
          severity: "HIGH",
          title: `Matched contractor license ${candidate.externalId} reports "${candidate.verbatimStatus ?? candidate.normalizedStatus}"`,
          explanation:
            "The official license record matched to this project's contractor carries wording that indicates " +
            "it is not currently active. An expired or missing license is a compliance signal requiring " +
            "review — not automatic proof of wrongdoing.",
          suggestedAction: "Verify on the official portal and review with the contractor; attach the record if confirmed.",
          blockingImplications: "If promoted to an exception, compliance review may hold related draws.",
          candidateId: candidate.id, matchId: match.id, changeEventId: null,
          affectedEntityType: match.obvEntityType, affectedEntityId: match.obvEntityId,
          organizationId: match.organizationId, projectId: match.projectId,
          itemKey: `license:${match.matchKey}:${candidate.candidateKey}`,
        })) queued += 1;
      } else if (candidate.recordType === "ENFORCEMENT" || candidate.recordType === "STOP_WORK") {
        if (pushItem({
          eventKind: candidate.recordType === "STOP_WORK" ? "STOP_WORK_DETECTED" : "ENFORCEMENT_DETECTED",
          severity: "HIGH",
          title: `Official ${candidate.recordType === "STOP_WORK" ? "stop-work" : "enforcement"} record matches this project`,
          explanation: "An official enforcement-type record matches a permit on this project. Verbatim wording is preserved on the candidate record.",
          suggestedAction: "Verify on the official portal; consider promoting to a governed exception if confirmed.",
          blockingImplications: "If promoted to an exception, related draws may be held until it is resolved.",
          candidateId: candidate.id, matchId: match.id, changeEventId: null,
          affectedEntityType: match.obvEntityType, affectedEntityId: match.obvEntityId,
          organizationId: match.organizationId, projectId: match.projectId,
          itemKey: `enforcement:${match.matchKey}`,
        })) queued += 1;
      } else if (pushItem({
        eventKind: "NEW_PERMIT_CANDIDATE",
        severity: "LOW",
        title: `Official record ${candidate.externalId} matches ${match.obvEntityType === "PERMIT" ? "a permit" : "a record"} on this project`,
        explanation:
          `${match.verdict === "EXACT_MATCH" ? "Exact" : "High-confidence"} match between the official record and ` +
          "an OBV record. Confirming attaches it as an official source reference — it never changes the OBV " +
          "record itself.",
        suggestedAction: "Review the comparison and confirm & attach, or reject the match.",
        blockingImplications: null,
        candidateId: candidate.id, matchId: match.id, changeEventId: null,
        affectedEntityType: match.obvEntityType, affectedEntityId: match.obvEntityId,
        organizationId: match.organizationId, projectId: match.projectId,
        itemKey: `candidate:${match.matchKey}:${candidate.candidateKey}`,
      })) queued += 1;
    } else if (match.verdict === "POSSIBLE_MATCH" && match.reasonCodes.includes("BUSINESS_NAME_PARTIAL")) {
      if (pushItem({
        eventKind: "CONTRACTOR_NAME_MISMATCH",
        severity: "MEDIUM",
        title: `Licensed name "${candidate.partyName ?? "?"}" only partially matches the contractor`,
        explanation:
          "The official license's business name overlaps but does not equal this project's contractor name. " +
          "Trade name vs. legal name is common; a reviewer should confirm whether they are the same entity.",
        suggestedAction: "Confirm entity identity before attaching; record a discrepancy if they differ.",
        blockingImplications: null,
        candidateId: candidate.id, matchId: match.id, changeEventId: null,
        affectedEntityType: match.obvEntityType, affectedEntityId: match.obvEntityId,
        organizationId: match.organizationId, projectId: match.projectId,
        itemKey: `namemismatch:${match.matchKey}`,
      })) queued += 1;
    }
  }

  for (const change of changeEvents) {
    signalRecordMissing(change);
    signalEnforcement(change);
    const eventKind = CHANGE_KIND_TO_EVENT[change.changeKind] ?? "PERMIT_STATUS_CHANGED";
    const failedInspection =
      change.changeKind === "INSPECTION_RESULT_CHANGED" &&
      /fail|correction|reinspect/i.test(change.changedFields.find((f) => f.field === "inspection result")?.current ?? "");
    if (pushItem({
      eventKind: failedInspection ? "FAILED_INSPECTION" : eventKind,
      severity: change.severity === "INFO" ? "LOW" : change.severity,
      title: `Official record ${change.externalId}: ${change.changeKind.toLowerCase().replace(/_/g, " ")}`,
      explanation: change.explanation,
      suggestedAction:
        change.changeKind === "RECORD_UNAVAILABLE"
          ? "Check the official portal; the record is labeled unavailable — never assumed revoked."
          : "Review the change; if it affects OBV records, use the existing governed commands to update them.",
      blockingImplications:
        failedInspection || change.changeKind === "STOP_WORK" || change.changeKind === "REVOKED"
          ? "If promoted to an exception, draw eligibility for affected lines may be held until resolved."
          : null,
      candidateId: change.currentCandidateId, matchId: null, changeEventId: change.id,
      affectedEntityType: null, affectedEntityId: null,
      organizationId: change.organizationId, projectId: change.projectId,
      itemKey: `change:${change.changeKey}`,
    })) queued += 1;
  }

  return queued;
}

// ============================================================ reads

export function listQueue(user: User, status?: string): SourceReviewItem[] {
  assertSourceViewer(user);
  const allowed = [...authz.accessibleProjectIds(user)];
  return osRepo.listReviewForProjects(allowed, { status: status || undefined });
}

export function queueStats(user: User): Record<string, number> {
  assertSourceViewer(user);
  return osRepo.reviewStatsForProjects([...authz.accessibleProjectIds(user)]);
}

export interface QueueItemDetail {
  item: SourceReviewItem;
  candidate: SourceCandidate | null;
  match: SourceMatch | null;
  change: SourceChangeEvent | null;
  snapshot: SourceSnapshot | null;
  source: OfficialSource | null;
  project: Project | null;
  obvPermit: Permit | null;
  events: ReturnType<typeof osRepo.listReviewEvents>;
}

function requireItem(user: User, id: string): SourceReviewItem {
  assertSourceViewer(user);
  const item = osRepo.getReviewItem(String(id ?? ""));
  if (!item || !item.projectId || !authz.accessibleProjectIds(user).has(item.projectId)) {
    throw new OfficialSourceError("Not found", 404);
  }
  return item;
}

export function queueItemDetail(user: User, id: string): QueueItemDetail {
  const item = requireItem(user, id);
  const candidate = item.candidateId ? osRepo.getCandidate(item.candidateId) : null;
  const match = item.matchId ? osRepo.getMatch(item.matchId) : null;
  const change = item.changeEventId ? osRepo.getChangeEvent(item.changeEventId) : null;
  const snapshot = candidate ? osRepo.getSnapshot(candidate.snapshotId) : null;
  const source = candidate ? osRepo.getSource(candidate.sourceId) : change ? osRepo.getSource(change.sourceId) : null;
  const project = item.projectId ? repo.getProject(item.projectId) : null;
  const obvPermit =
    match?.obvEntityType === "PERMIT" && match.obvEntityId ? repo.getPermit(match.obvEntityId) : null;
  return {
    item, candidate, match, change, snapshot, source, project, obvPermit,
    events: osRepo.listReviewEvents(item.id),
  };
}

// ============================================================ actions

function transition(
  user: User,
  item: SourceReviewItem,
  next: SourceReviewItem["status"],
  eventKind: "CONFIRMED" | "REJECTED" | "DEFERRED" | "MANUAL_VERIFICATION" | "DISCREPANCY_RECORDED" | "PROMOTED",
  note: string | null,
  links: { officialSourceRecordId?: string | null; sourceVerificationId?: string | null; exceptionId?: string | null } = {}
): SourceReviewItem {
  const ok = osRepo.updateReviewStatus(item.id, next, {
    resolvedByUserId: user.id,
    resolvedAt: nowIso(),
    resolutionNote: note,
    linkedOfficialSourceRecordId: links.officialSourceRecordId ?? null,
    linkedSourceVerificationId: links.sourceVerificationId ?? null,
    promotedExceptionId: links.exceptionId ?? null,
  });
  if (!ok) throw new OfficialSourceError("This review item was already resolved", 409);
  osRepo.insertReviewEvent({
    id: repo.newId(), itemId: item.id, occurredAt: nowIso(), actorUserId: user.id,
    kind: eventKind, detail: note,
  });
  return osRepo.getReviewItem(item.id)!;
}

/** CONFIRM & ATTACH — the advisory→authoritative bridge for source
 *  references. Delegates to permits.recordOfficialSource (which applies
 *  its own DETERMINATION_ROLES check, referential validation, and
 *  audit); optionally also records a DMV source verification. */
export function confirmAndAttach(
  user: User,
  itemId: string,
  opts: { note?: string | null; alsoRecordVerification?: boolean } = {}
): { item: SourceReviewItem; officialSourceRecordId: string; sourceVerificationId: string | null } {
  assertSourceReviewer(user);
  const item = requireItem(user, itemId);
  if (!item.candidateId) throw new OfficialSourceError("This item has no candidate record to attach", 422);
  const candidate = osRepo.getCandidate(item.candidateId);
  const match = item.matchId ? osRepo.getMatch(item.matchId) : null;
  if (!candidate || !item.projectId) throw new OfficialSourceError("Not found", 404);
  if (match && (match.verdict === "AMBIGUOUS" || match.verdict === "CONFLICT")) {
    throw new OfficialSourceError(
      "An ambiguous or conflicting match cannot be attached — resolve the discrepancy first (reject, defer, or record a discrepancy)",
      422
    );
  }
  const source = osRepo.getSource(candidate.sourceId);
  const permitId = match?.obvEntityType === "PERMIT" ? match.obvEntityId : null;

  // Governed command #1: the official source reference (permits domain).
  const record = permits.recordOfficialSource(user, {
    projectId: item.projectId,
    permitId,
    sourceType: source?.category === "OFFICIAL_PORTAL_MANUAL" ? "OFFICIAL_PORTAL_LOOKUP" : "API_LOOKUP",
    officialSystemName: source ? `${source.agency} — ${source.name}` : candidate.agency,
    officialRecordNumber: candidate.permitNumber ?? candidate.externalId,
    officialRecordUrl: candidate.sourceUrl,
    lookupPerformedAt: candidate.createdAt,
    officialStatusText: candidate.verbatimStatus,
    notes:
      `${opts.note?.trim() ? opts.note.trim() + " — " : ""}Attached from Official Sources review ` +
      `(candidate ${candidate.externalId}, snapshot ${candidate.snapshotId.slice(0, 8)}, ` +
      `verdict ${match?.verdict ?? "n/a"}).`,
  });

  // Governed command #2 (optional): a DMV source verification run.
  let verificationId: string | null = null;
  if (opts.alsoRecordVerification !== false) {
    const verification = dmvCompliance.recordSourceVerification(user, {
      projectId: item.projectId,
      officialService: source ? `${source.agency} — ${source.name}` : candidate.agency,
      searchCriteria: JSON.stringify({ externalId: candidate.externalId, permitNumber: candidate.permitNumber }),
      sourceRecordIdentifier: candidate.externalId,
      lookupAt: candidate.createdAt,
      resultStatus: match?.verdict === "EXACT_MATCH" ? "VERIFIED_MATCH" : "PARTIAL_MATCH",
      resultSummary: `Official status: "${candidate.verbatimStatus ?? "(none)"}" — confirmed by reviewer.`,
      verificationMethod: source?.category === "OFFICIAL_PORTAL_MANUAL" ? "MANUAL_PORTAL_LOOKUP" : "API_LOOKUP",
      confidence: match?.verdict === "EXACT_MATCH" ? "HIGH" : "MEDIUM",
      permitId,
      notes: opts.note?.trim() || null,
    });
    verificationId = verification.id;
  }

  const updated = transition(user, item, "CONFIRMED", "CONFIRMED", opts.note ?? null, {
    officialSourceRecordId: record.id,
    sourceVerificationId: verificationId,
  });
  return { item: updated, officialSourceRecordId: record.id, sourceVerificationId: verificationId };
}

export function rejectMatch(user: User, itemId: string, note: string | null): SourceReviewItem {
  assertSourceReviewer(user);
  return transition(user, requireItem(user, itemId), "REJECTED", "REJECTED", note);
}

export function deferItem(user: User, itemId: string, note: string | null): SourceReviewItem {
  assertSourceReviewer(user);
  const item = requireItem(user, itemId);
  if (item.status !== "OPEN") throw new OfficialSourceError("Only an open item can be deferred", 409);
  const ok = osRepo.updateReviewStatus(item.id, "DEFERRED", {
    resolvedByUserId: user.id, resolvedAt: nowIso(), resolutionNote: note,
  });
  if (!ok) throw new OfficialSourceError("This review item was already resolved", 409);
  osRepo.insertReviewEvent({
    id: repo.newId(), itemId: item.id, occurredAt: nowIso(), actorUserId: user.id,
    kind: "DEFERRED", detail: note,
  });
  return osRepo.getReviewItem(item.id)!;
}

/** Mark the item as requiring a manual portal verification (the
 *  reviewer then performs the lookup and records it via the existing
 *  DMV command, which this marks as the expected follow-up). */
export function requestManualVerification(user: User, itemId: string, note: string | null): SourceReviewItem {
  assertSourceReviewer(user);
  return transition(user, requireItem(user, itemId), "MANUAL_VERIFICATION", "MANUAL_VERIFICATION", note);
}

/** Record a discrepancy: a DMV source verification documenting that the
 *  official record and OBV's records disagree (through the governed
 *  command), then mark the item. */
export function recordDiscrepancy(
  user: User,
  itemId: string,
  opts: { summary: string; note?: string | null }
): { item: SourceReviewItem; sourceVerificationId: string } {
  assertSourceReviewer(user);
  const item = requireItem(user, itemId);
  if (!item.projectId) throw new OfficialSourceError("Not found", 404);
  const candidate = item.candidateId ? osRepo.getCandidate(item.candidateId) : null;
  const source = candidate ? osRepo.getSource(candidate.sourceId) : null;
  const summary = String(opts.summary ?? "").trim();
  if (summary.length < 10) {
    throw new OfficialSourceError("A discrepancy record needs a meaningful summary (at least 10 characters)");
  }
  const verification = dmvCompliance.recordSourceVerification(user, {
    projectId: item.projectId,
    officialService: source ? `${source.agency} — ${source.name}` : "Official source",
    searchCriteria: candidate
      ? JSON.stringify({ externalId: candidate.externalId, permitNumber: candidate.permitNumber })
      : item.title,
    sourceRecordIdentifier: candidate?.externalId ?? null,
    lookupAt: candidate?.createdAt ?? nowIso(),
    resultStatus: "PARTIAL_MATCH",
    resultSummary: summary,
    verificationMethod: source?.category === "OFFICIAL_PORTAL_MANUAL" ? "MANUAL_PORTAL_LOOKUP" : "API_LOOKUP",
    confidence: "MEDIUM",
    notes: opts.note?.trim() || null,
  });
  const updated = transition(user, item, "DISCREPANCY_RECORDED", "DISCREPANCY_RECORDED", opts.note ?? summary, {
    sourceVerificationId: verification.id,
  });
  return { item: updated, sourceVerificationId: verification.id };
}

const EXCEPTION_CATEGORY: Partial<Record<SourceReviewEventKind, "DOCUMENT" | "INTEGRITY" | "QUALITY" | "OTHER">> = {
  STOP_WORK_DETECTED: "INTEGRITY",
  ENFORCEMENT_DETECTED: "INTEGRITY",
  FAILED_INSPECTION: "QUALITY",
  LICENSE_EXPIRED: "DOCUMENT",
  LICENSE_SUSPENDED: "INTEGRITY",
  LICENSE_NOT_FOUND: "DOCUMENT",
  SOURCE_CONFLICT: "DOCUMENT",
  CONTRACTOR_NAME_MISMATCH: "DOCUMENT",
  RECORD_DISAPPEARED: "DOCUMENT",
};

/** PROMOTE — the advisory→governed bridge. Delegates entirely to the
 *  exceptions service and its authorization. */
export function promoteToException(
  user: User,
  itemId: string,
  note: string | null
): { item: SourceReviewItem; exceptionId: string } {
  assertSourceReviewer(user);
  const item = requireItem(user, itemId);
  if (!item.projectId) throw new OfficialSourceError("Not found", 404);
  const exception = exceptions.createManualException(user, {
    projectId: item.projectId,
    category: EXCEPTION_CATEGORY[item.eventKind] ?? "OTHER",
    severity: item.severity === "INFO" ? "LOW" : item.severity,
    title: `Official source: ${item.title}`.slice(0, 180),
    description:
      `${item.explanation}\n\nPromoted from the Official Sources review queue by ${user.name}.` +
      (note?.trim() ? `\nReviewer note: ${note.trim()}` : ""),
  });
  const updated = transition(user, item, "PROMOTED", "PROMOTED", note, { exceptionId: exception.id });
  return { item: updated, exceptionId: exception.id };
}

/** Gated raw-snapshot read for the preview page: viewer role required;
 *  a snapshot scoped to a project the caller cannot see is a plain 404
 *  (an unscoped snapshot of public source data is viewer-visible). */
export function snapshotPreview(user: User, snapshotId: string): {
  snapshot: SourceSnapshot;
  source: OfficialSource | null;
  candidates: SourceCandidate[];
} {
  assertSourceViewer(user);
  const snapshot = osRepo.getSnapshot(String(snapshotId ?? ""));
  if (!snapshot || (snapshot.projectId && !authz.accessibleProjectIds(user).has(snapshot.projectId))) {
    throw new OfficialSourceError("Not found", 404);
  }
  return {
    snapshot,
    source: osRepo.getSource(snapshot.sourceId),
    candidates: osRepo.listCandidatesForSnapshot(snapshot.id),
  };
}

// ============================================================ record views

/** Source records visible on a project page: candidates + matches +
 *  changes for the caller's project (viewer-gated, same-404). */
export function projectSourceRecords(user: User, projectId: string): {
  project: Project;
  candidates: SourceCandidate[];
  changes: SourceChangeEvent[];
  attachedRecords: ReturnType<typeof repo.listOfficialSourcesForProject>;
} {
  assertSourceViewer(user);
  const project = (() => {
    const p = repo.getProject(String(projectId ?? ""));
    if (!p || !authz.accessibleProjectIds(user).has(p.id)) throw new OfficialSourceError("Not found", 404);
    return p;
  })();
  return {
    project,
    candidates: osRepo.listCandidatesForProjects([project.id], 100),
    changes: osRepo.listChangesForProjects([project.id], 100),
    attachedRecords: repo.listOfficialSourcesForProject(project.id),
  };
}
