/**
 * Evidence Review Queue + unified evidence timeline.
 *
 * The queue is where advisory findings reach a reviewer. Reviewer state
 * lives on the queue item; the signal is immutable. The ONLY way a
 * finding becomes governed is a reviewer PROMOTING it into a formal
 * exception — which reuses the existing exceptions service and its
 * authorization. The platform never promotes automatically, never
 * approves, never rejects, never releases.
 */
import * as repo from "../../db/repo";
import * as evidenceIntelRepo from "../../db/evidenceIntelRepo";
import * as exceptions from "../exceptions";
import * as authz from "../authz";
import type {
  EvidenceReviewItem,
  EvidenceSignal,
  ObvException,
  User,
} from "../../../shared/types";
import {
  EvidenceIntelError,
  assertReviewer,
  assertViewer,
  documentContext,
  evidenceContext,
  nowIso,
  projectContext,
} from "./core";

// ------------------------------------------------------------ enqueue

/** Enqueue a review item for a signal (idempotent on signal id). Only
 *  actionable (non-INFO) findings are queued; INFO findings remain
 *  visible on the subject and dashboard without cluttering the queue. */
export function enqueueSignal(signal: EvidenceSignal): EvidenceReviewItem | null {
  if (signal.severity === "INFO") return null;
  const existing = evidenceIntelRepo.findReviewItemBySignal(signal.id);
  if (existing) return existing;
  const item: EvidenceReviewItem = {
    id: repo.newId(),
    signalId: signal.id,
    organizationId: signal.organizationId,
    projectId: signal.projectId,
    subjectType: signal.subjectType,
    subjectId: signal.subjectId,
    severity: signal.severity,
    confidence: signal.confidence,
    status: "OPEN",
    recommendation: signal.recommendation,
    resolutionNote: null,
    promotedExceptionId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    resolvedByUserId: null,
    resolvedAt: null,
  };
  if (!evidenceIntelRepo.insertReviewItem(item)) {
    return evidenceIntelRepo.findReviewItemBySignal(signal.id);
  }
  reviewEvent(item.id, null, "CREATED", `Queued from ${signal.category} finding.`);
  return item;
}

function reviewEvent(queueItemId: string, actor: User | null, kind: "CREATED" | "ACKNOWLEDGED" | "DISMISSED" | "PROMOTED" | "REOPENED" | "NOTE", detail: string | null): void {
  evidenceIntelRepo.insertReviewEvent({
    id: repo.newId(),
    queueItemId,
    occurredAt: nowIso(),
    actorUserId: actor?.id ?? null,
    kind,
    detail,
  });
}

// --------------------------------------------------------------- reads

function requireItem(user: User, id: string): EvidenceReviewItem {
  const item = evidenceIntelRepo.getReviewItem(String(id ?? ""));
  if (!item || !item.projectId || !authz.accessibleProjectIds(user).has(item.projectId)) {
    // Same-404: a queue item on a project the caller cannot see is
    // indistinguishable from one that does not exist.
    throw new EvidenceIntelError("Not found", 404);
  }
  return item;
}

export function listQueue(user: User, status?: string): EvidenceReviewItem[] {
  assertViewer(user);
  return evidenceIntelRepo.listReviewForProjects([...authz.accessibleProjectIds(user)], { status });
}

export function queueItemDetail(user: User, id: string): {
  item: EvidenceReviewItem;
  signal: EvidenceSignal | null;
  events: ReturnType<typeof evidenceIntelRepo.listReviewEvents>;
} {
  assertViewer(user);
  const item = requireItem(user, id);
  return {
    item,
    signal: evidenceIntelRepo.getSignal(item.signalId),
    events: evidenceIntelRepo.listReviewEvents(item.id),
  };
}

// ------------------------------------------------------ reviewer actions

export function acknowledge(user: User, id: string, note: string | null): EvidenceReviewItem {
  assertReviewer(user);
  const item = requireItem(user, id);
  if (item.status !== "OPEN") throw new EvidenceIntelError(`This item is already ${item.status.toLowerCase()}`, 409);
  evidenceIntelRepo.updateReviewStatus(item.id, "ACKNOWLEDGED", { resolutionNote: note, resolvedByUserId: user.id });
  reviewEvent(item.id, user, "ACKNOWLEDGED", note);
  return evidenceIntelRepo.getReviewItem(item.id)!;
}

export function dismiss(user: User, id: string, note: string | null): EvidenceReviewItem {
  assertReviewer(user);
  const item = requireItem(user, id);
  if (item.status === "PROMOTED") throw new EvidenceIntelError("A promoted finding cannot be dismissed", 409);
  if (!evidenceIntelRepo.updateReviewStatus(item.id, "DISMISSED", { resolutionNote: note, resolvedByUserId: user.id })) {
    throw new EvidenceIntelError("This item was already resolved", 409);
  }
  reviewEvent(item.id, user, "DISMISSED", note);
  return evidenceIntelRepo.getReviewItem(item.id)!;
}

const EXCEPTION_CATEGORY: Record<string, ObvException["category"]> = {
  DUPLICATE_FILE: "EVIDENCE",
  CROSS_PROJECT_DUPLICATE: "EVIDENCE",
  CROSS_CONTRACTOR_DUPLICATE: "EVIDENCE",
  DUPLICATE_INVOICE: "DOCUMENT",
  DUPLICATE_RECEIPT: "DOCUMENT",
  DUPLICATE_PERMIT: "DOCUMENT",
  DUPLICATE_LIEN_WAIVER: "DOCUMENT",
  DUPLICATE_INVOICE_NUMBER: "DOCUMENT",
  REUSED_DOCUMENT: "DOCUMENT",
  CONTRACTOR_NAME_CONFLICT: "DOCUMENT",
  TOTAL_INCONSISTENCY: "COST",
  SUSPICIOUS_EDIT: "INTEGRITY",
  PROJECT_REFERENCE_INCONSISTENCY: "DOCUMENT",
  MISSING_METADATA: "METADATA",
  TIMESTAMP_INCONSISTENCY: "METADATA",
  GPS_CONFLICT: "LOCATION",
  SUSPICIOUS_UPLOAD_TIMING: "METADATA",
  FILE_TRANSFORMATION: "INTEGRITY",
  DUPLICATE_DEVICE_PATTERN: "METADATA",
  LOW_COMPLETENESS: "QUALITY",
  LOW_QUALITY: "QUALITY",
};

const EXCEPTION_SEVERITY: Record<string, "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"> = {
  INFO: "LOW",
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
};

/**
 * Promote a finding into a governed exception. This is the SINGLE bridge
 * from advisory to governed, and it:
 *  - requires a reviewer (assertReviewer), and
 *  - delegates creation to exceptions.createManualException, which
 *    independently enforces project-finance access and exception-raise
 *    authority (so promotion cannot exceed the reviewer's own authority).
 * The exception is a normal governed record from that point on; the
 * finding itself remains immutable and is marked PROMOTED.
 */
export function promote(user: User, id: string, note: string | null): { item: EvidenceReviewItem; exception: ObvException } {
  assertReviewer(user);
  const item = requireItem(user, id);
  if (item.status === "PROMOTED") throw new EvidenceIntelError("This finding is already promoted", 409);
  if (item.status === "DISMISSED") throw new EvidenceIntelError("A dismissed finding cannot be promoted", 409);
  const signal = evidenceIntelRepo.getSignal(item.signalId);
  if (!signal) throw new EvidenceIntelError("Underlying finding not found", 404);
  if (!signal.projectId) throw new EvidenceIntelError("This finding is not scoped to a project and cannot be promoted", 422);

  const milestoneId = signal.subjectType === "EVIDENCE_ITEM"
    ? repo.getEvidence(signal.subjectId)?.milestoneId ?? null
    : null;
  const exception = exceptions.createManualException(user, {
    projectId: signal.projectId,
    milestoneId,
    category: EXCEPTION_CATEGORY[signal.category] ?? "OTHER",
    severity: EXCEPTION_SEVERITY[signal.severity] ?? "MEDIUM",
    title: `Evidence Intelligence: ${signal.title}`,
    description:
      `${signal.explanation}\n\nRecommended: ${signal.recommendation}\n\n` +
      `Promoted from advisory finding ${signal.id} (${signal.category}) by ${user.name}.` +
      (note ? `\nReviewer note: ${note}` : ""),
  });
  if (!evidenceIntelRepo.updateReviewStatus(item.id, "PROMOTED", {
    resolutionNote: note,
    promotedExceptionId: exception.id,
    resolvedByUserId: user.id,
  })) {
    throw new EvidenceIntelError("This item was already resolved", 409);
  }
  reviewEvent(item.id, user, "PROMOTED", `Promoted to exception ${exception.id}.${note ? ` ${note}` : ""}`);
  return { item: evidenceIntelRepo.getReviewItem(item.id)!, exception };
}

// --------------------------------------------------------- evidence timeline

export interface TimelineEntry {
  at: string;
  kind: string;
  label: string;
  detail: string | null;
  reference: string | null;
}

/** A unified, chronological timeline for one evidence item: capture,
 *  upload, verification, review activity, and every governed record that
 *  references it (draws, disputes, permits, lender review, payment). All
 *  derived from existing records; nothing is invented. */
export function evidenceTimeline(user: User, evidenceItemId: string): { evidence: import("../../../shared/types").EvidenceItem; entries: TimelineEntry[] } {
  assertViewer(user);
  const evidence = repo.getEvidence(String(evidenceItemId ?? ""));
  if (!evidence) throw new EvidenceIntelError("Not found", 404);
  const milestone = repo.getMilestone(evidence.milestoneId);
  const project = milestone ? repo.getProject(milestone.projectId) : null;
  if (!project || !authz.accessibleProjectIds(user).has(project.id)) {
    throw new EvidenceIntelError("Not found", 404);
  }
  const entries: TimelineEntry[] = [];
  const push = (at: string | null, kind: string, label: string, detail: string | null = null, reference: string | null = null) => {
    if (at) entries.push({ at, kind, label, detail, reference });
  };

  push(evidence.capturedAt, "UPLOAD", "Evidence captured", milestone ? `Milestone: ${milestone.title}` : null, evidence.id);
  push(evidence.uploadedAt, "UPLOAD", "Evidence uploaded", null, evidence.id);

  const verification = repo.getVerificationForEvidence(evidence.id);
  if (verification) {
    push(verification.createdAt, "REVIEW", `Verification: ${verification.verdict}`, `Confidence ${(verification.confidence * 100).toFixed(0)}% · ${verification.source}`, verification.id);
  }

  const ledger = repo.getLedgerEntryForEvidence(evidence.id);
  if (ledger) push(ledger.timestamp, "LEDGER", "Recorded in evidence ledger", null, ledger.id);

  // Draw references (evidence linked to a draw).
  for (const project2 of [project]) {
    for (const draw of repo.listDrawRequestsForProject(project2.id)) {
      for (const link of repo.listDrawEvidenceLinks(draw.id)) {
        if (link.evidenceItemId === evidence.id) {
          push(draw.submittedAt ?? draw.createdAt ?? null, "DRAW", `Referenced by draw ${draw.drawNumber}`, `Status: ${draw.status}`, draw.id);
        }
      }
    }
  }

  // Advisory signals about this item and its review activity.
  for (const signal of evidenceIntelRepo.listSignalsForSubject("EVIDENCE_ITEM", evidence.id)) {
    push(signal.occurredAt, "ADVISORY", `Advisory: ${signal.title}`, `${signal.severity} · ${(signal.confidence * 100).toFixed(0)}%`, signal.id);
    const item = evidenceIntelRepo.findReviewItemBySignal(signal.id);
    if (item) {
      for (const ev of evidenceIntelRepo.listReviewEvents(item.id)) {
        push(ev.occurredAt, "REVIEW", `Review: ${ev.kind.toLowerCase()}`, ev.detail, item.id);
      }
    }
  }

  entries.sort((a, b) => a.at.localeCompare(b.at));
  return { evidence, entries };
}

// --------------------------------------------------------- scoped signal read

/** Advisory signals for one subject, gated and tenant-scoped. Resolves the
 *  subject's project and refuses unless the caller may view Evidence
 *  Intelligence AND can see that project — a subject in an inaccessible or
 *  nonexistent project is a plain 404, indistinguishable from one that does
 *  not exist. This is the ONLY read path the routes may use to fetch a
 *  subject's signals; the raw repository read is never exposed to a request. */
export function signalsForSubject(user: User, subjectType: string, subjectId: string): EvidenceSignal[] {
  assertViewer(user);
  const id = String(subjectId ?? "");
  const projectId =
    subjectType === "PROJECT"
      ? projectContext(id).projectId
      : subjectType === "EVIDENCE_ITEM"
      ? evidenceContext(id)?.projectId ?? null
      : subjectType === "DOCUMENT"
      ? (() => {
          const doc = repo.getDrawDocument(id);
          return doc ? documentContext(doc).projectId : null;
        })()
      : null;
  if (!projectId || !authz.accessibleProjectIds(user).has(projectId)) {
    throw new EvidenceIntelError("Not found", 404);
  }
  return evidenceIntelRepo.listSignalsForSubject(subjectType, id);
}
