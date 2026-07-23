/**
 * Dispute + release-hold repository.
 *
 * Additive module (lenderRepo/bankingRepo conventions): snake_case
 * columns, hand row-mapping, ISO string timestamps, whole-currency
 * INTEGER amounts, JSON as TEXT. dispute_events and
 * dispute_cure_extensions are APPEND-ONLY — no update or delete
 * functions exist for them, and dispute_responses rows are immutable
 * after insert (corrections are new versions referencing the original).
 * Status changes are GUARDED single-statement updates so a stale read
 * can never double-apply a transition.
 */
import { randomUUID, createHash } from "node:crypto";
import { getDb } from "./index";
import type {
  Dispute,
  DisputeCureExtension,
  DisputeCureItem,
  DisputeEscalation,
  DisputeEvent,
  DisputeEvidenceRecord,
  DisputeInspectionRequest,
  DisputeRecommendation,
  DisputeResponse,
  DisputeStatus,
} from "../../shared/types";

type Row = Record<string, unknown>;

export function newId(): string {
  return randomUUID();
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function withDisputeTx<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ------------------------------------------------------------- disputes

function toDispute(r: Row): Dispute {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    projectId: String(r.project_id),
    subjectType: String(r.subject_type) as Dispute["subjectType"],
    subjectId: String(r.subject_id),
    drawRequestId: s(r.draw_request_id),
    milestoneId: s(r.milestone_id),
    paymentInstructionId: s(r.payment_instruction_id),
    disputedAmount: num(r.disputed_amount),
    undisputedAmount: numOrNull(r.undisputed_amount),
    affectedScope: String(r.affected_scope),
    affectedLineIds: String(r.affected_line_ids),
    reason: String(r.reason),
    status: String(r.status) as DisputeStatus,
    openedByUserId: String(r.opened_by_user_id),
    openedByOrganizationId: String(r.opened_by_organization_id),
    openedAt: String(r.opened_at),
    responsibleReviewerUserId: s(r.responsible_reviewer_user_id),
    legalHold: Boolean(r.legal_hold),
    legalHoldByUserId: s(r.legal_hold_by_user_id),
    legalHoldReason: s(r.legal_hold_reason),
    legalHoldAt: s(r.legal_hold_at),
    resolutionType: s(r.resolution_type) as Dispute["resolutionType"],
    resolutionAmount: numOrNull(r.resolution_amount),
    resolutionReasoning: s(r.resolution_reasoning),
    resolutionConditions: s(r.resolution_conditions),
    resolutionEvidenceIds: s(r.resolution_evidence_ids),
    resolutionExternalReference: s(r.resolution_external_reference),
    resolvedByUserId: s(r.resolved_by_user_id),
    resolvedByRole: s(r.resolved_by_role),
    resolvedByOrganizationId: s(r.resolved_by_organization_id),
    resolvedAt: s(r.resolved_at),
    closedAt: s(r.closed_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function insertDispute(d: Dispute): void {
  getDb()
    .prepare(
      `INSERT INTO disputes (id, organization_id, project_id, subject_type, subject_id,
        draw_request_id, milestone_id, payment_instruction_id, disputed_amount, undisputed_amount,
        affected_scope, affected_line_ids, reason, status, opened_by_user_id,
        opened_by_organization_id, opened_at, responsible_reviewer_user_id,
        legal_hold, legal_hold_by_user_id, legal_hold_reason, legal_hold_at,
        resolution_type, resolution_amount, resolution_reasoning, resolution_conditions,
        resolution_evidence_ids, resolution_external_reference, resolved_by_user_id,
        resolved_by_role, resolved_by_organization_id, resolved_at, closed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.id, d.organizationId, d.projectId, d.subjectType, d.subjectId,
      d.drawRequestId, d.milestoneId, d.paymentInstructionId, d.disputedAmount, d.undisputedAmount,
      d.affectedScope, d.affectedLineIds, d.reason, d.status, d.openedByUserId,
      d.openedByOrganizationId, d.openedAt, d.responsibleReviewerUserId,
      d.legalHold ? 1 : 0, d.legalHoldByUserId, d.legalHoldReason, d.legalHoldAt,
      d.resolutionType, d.resolutionAmount, d.resolutionReasoning, d.resolutionConditions,
      d.resolutionEvidenceIds, d.resolutionExternalReference, d.resolvedByUserId,
      d.resolvedByRole, d.resolvedByOrganizationId, d.resolvedAt, d.closedAt, d.createdAt, d.updatedAt
    );
}

export function getDispute(id: string): Dispute | null {
  const r = getDb().prepare(`SELECT * FROM disputes WHERE id = ?`).get(id) as Row | undefined;
  return r ? toDispute(r) : null;
}

export function listDisputesForProject(projectId: string): Dispute[] {
  return (getDb().prepare(`SELECT * FROM disputes WHERE project_id = ? ORDER BY opened_at, rowid`).all(projectId) as Row[]).map(toDispute);
}

export function listDisputesForDraw(drawRequestId: string): Dispute[] {
  return (getDb()
    .prepare(`SELECT * FROM disputes WHERE draw_request_id = ? ORDER BY opened_at, rowid`)
    .all(drawRequestId) as Row[]).map(toDispute);
}

export function listDisputesForMilestones(milestoneIds: string[]): Dispute[] {
  if (milestoneIds.length === 0) return [];
  const ph = milestoneIds.map(() => "?").join(",");
  return (getDb()
    .prepare(`SELECT * FROM disputes WHERE milestone_id IN (${ph}) ORDER BY opened_at, rowid`)
    .all(...milestoneIds) as Row[]).map(toDispute);
}

export function listDisputesForInstructions(instructionIds: string[]): Dispute[] {
  if (instructionIds.length === 0) return [];
  const ph = instructionIds.map(() => "?").join(",");
  return (getDb()
    .prepare(`SELECT * FROM disputes WHERE payment_instruction_id IN (${ph}) ORDER BY opened_at, rowid`)
    .all(...instructionIds) as Row[]).map(toDispute);
}

/** Guarded status transition — exactly-once from one of `fromStatuses`. */
export function transitionDisputeGuarded(
  id: string,
  fromStatuses: DisputeStatus[],
  toStatus: DisputeStatus,
  patch: Partial<{
    responsibleReviewerUserId: string;
    resolutionType: string;
    resolutionAmount: number;
    resolutionReasoning: string;
    resolutionConditions: string;
    resolutionEvidenceIds: string;
    resolutionExternalReference: string;
    resolvedByUserId: string;
    resolvedByRole: string;
    resolvedByOrganizationId: string;
    resolvedAt: string;
    closedAt: string;
  }> = {}
): boolean {
  const ph = fromStatuses.map(() => "?").join(",");
  const res = getDb()
    .prepare(
      `UPDATE disputes SET status = ?, updated_at = ?,
        responsible_reviewer_user_id = COALESCE(?, responsible_reviewer_user_id),
        resolution_type = COALESCE(?, resolution_type),
        resolution_amount = COALESCE(?, resolution_amount),
        resolution_reasoning = COALESCE(?, resolution_reasoning),
        resolution_conditions = COALESCE(?, resolution_conditions),
        resolution_evidence_ids = COALESCE(?, resolution_evidence_ids),
        resolution_external_reference = COALESCE(?, resolution_external_reference),
        resolved_by_user_id = COALESCE(?, resolved_by_user_id),
        resolved_by_role = COALESCE(?, resolved_by_role),
        resolved_by_organization_id = COALESCE(?, resolved_by_organization_id),
        resolved_at = COALESCE(?, resolved_at),
        closed_at = COALESCE(?, closed_at)
       WHERE id = ? AND status IN (${ph})`
    )
    .run(
      toStatus, new Date().toISOString(),
      patch.responsibleReviewerUserId ?? null, patch.resolutionType ?? null,
      patch.resolutionAmount ?? null, patch.resolutionReasoning ?? null,
      patch.resolutionConditions ?? null, patch.resolutionEvidenceIds ?? null,
      patch.resolutionExternalReference ?? null, patch.resolvedByUserId ?? null,
      patch.resolvedByRole ?? null, patch.resolvedByOrganizationId ?? null,
      patch.resolvedAt ?? null, patch.closedAt ?? null,
      id, ...fromStatuses
    );
  return Number(res.changes) === 1;
}

/** Guarded legal-hold flips (activation requires it OFF, removal ON). */
export function setLegalHoldGuarded(
  id: string,
  active: boolean,
  byUserId: string,
  reason: string,
  at: string
): boolean {
  const res = active
    ? getDb()
        .prepare(
          `UPDATE disputes SET legal_hold = 1, legal_hold_by_user_id = ?, legal_hold_reason = ?, legal_hold_at = ?, updated_at = ?
           WHERE id = ? AND legal_hold = 0`
        )
        .run(byUserId, reason, at, at, id)
    : getDb()
        .prepare(
          `UPDATE disputes SET legal_hold = 0, updated_at = ? WHERE id = ? AND legal_hold = 1`
        )
        .run(at, id);
  return Number(res.changes) === 1;
}

// ------------------------------------------------------------ events

function toEvent(r: Row): DisputeEvent {
  return {
    id: String(r.id),
    disputeId: String(r.dispute_id),
    type: String(r.type) as DisputeEvent["type"],
    detail: String(r.detail),
    actorUserId: s(r.actor_user_id),
    refId: s(r.ref_id),
    createdAt: String(r.created_at),
  };
}

/** Append-only. There is intentionally no update or delete function. */
export function insertDisputeEvent(e: DisputeEvent): void {
  getDb()
    .prepare(
      `INSERT INTO dispute_events (id, dispute_id, type, detail, actor_user_id, ref_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.disputeId, e.type, e.detail, e.actorUserId, e.refId, e.createdAt);
}

export function listDisputeEvents(disputeId: string): DisputeEvent[] {
  return (getDb()
    .prepare(`SELECT * FROM dispute_events WHERE dispute_id = ? ORDER BY created_at, rowid`)
    .all(disputeId) as Row[]).map(toEvent);
}

// ---------------------------------------------------------- responses

function toResponse(r: Row): DisputeResponse {
  return {
    id: String(r.id),
    disputeId: String(r.dispute_id),
    version: num(r.version),
    kind: String(r.kind) as DisputeResponse["kind"],
    body: String(r.body),
    submittedByUserId: String(r.submitted_by_user_id),
    submittedByOrganizationId: String(r.submitted_by_organization_id),
    supersedesResponseId: s(r.supersedes_response_id),
    createdAt: String(r.created_at),
  };
}

export function insertDisputeResponse(x: DisputeResponse): void {
  getDb()
    .prepare(
      `INSERT INTO dispute_responses (id, dispute_id, version, kind, body,
        submitted_by_user_id, submitted_by_organization_id, supersedes_response_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(x.id, x.disputeId, x.version, x.kind, x.body, x.submittedByUserId, x.submittedByOrganizationId, x.supersedesResponseId, x.createdAt);
}

export function listDisputeResponses(disputeId: string): DisputeResponse[] {
  return (getDb()
    .prepare(`SELECT * FROM dispute_responses WHERE dispute_id = ? ORDER BY version`)
    .all(disputeId) as Row[]).map(toResponse);
}

export function getDisputeResponse(id: string): DisputeResponse | null {
  const r = getDb().prepare(`SELECT * FROM dispute_responses WHERE id = ?`).get(id) as Row | undefined;
  return r ? toResponse(r) : null;
}

export function nextResponseVersion(disputeId: string): number {
  const r = getDb()
    .prepare(`SELECT COALESCE(MAX(version), 0) v FROM dispute_responses WHERE dispute_id = ?`)
    .get(disputeId) as Row;
  return num(r.v) + 1;
}

// ----------------------------------------------------------- evidence

function toEvidence(r: Row): DisputeEvidenceRecord {
  return {
    id: String(r.id),
    disputeId: String(r.dispute_id),
    evidenceType: String(r.evidence_type),
    title: String(r.title),
    description: s(r.description),
    linkedType: String(r.linked_type) as DisputeEvidenceRecord["linkedType"],
    linkedId: s(r.linked_id),
    externalReference: s(r.external_reference),
    documentHash: String(r.document_hash),
    version: num(r.version),
    supersedesEvidenceId: s(r.supersedes_evidence_id),
    submittedByUserId: String(r.submitted_by_user_id),
    submittedByOrganizationId: String(r.submitted_by_organization_id),
    reviewStatus: String(r.review_status) as DisputeEvidenceRecord["reviewStatus"],
    reviewedByUserId: s(r.reviewed_by_user_id),
    reviewedAt: s(r.reviewed_at),
    reviewerNotes: s(r.reviewer_notes),
    createdAt: String(r.created_at),
  };
}

export function insertDisputeEvidence(x: DisputeEvidenceRecord): void {
  getDb()
    .prepare(
      `INSERT INTO dispute_evidence_records (id, dispute_id, evidence_type, title, description,
        linked_type, linked_id, external_reference, document_hash, version, supersedes_evidence_id,
        submitted_by_user_id, submitted_by_organization_id, review_status, reviewed_by_user_id,
        reviewed_at, reviewer_notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      x.id, x.disputeId, x.evidenceType, x.title, x.description, x.linkedType, x.linkedId,
      x.externalReference, x.documentHash, x.version, x.supersedesEvidenceId,
      x.submittedByUserId, x.submittedByOrganizationId, x.reviewStatus, x.reviewedByUserId,
      x.reviewedAt, x.reviewerNotes, x.createdAt
    );
}

export function getDisputeEvidence(id: string): DisputeEvidenceRecord | null {
  const r = getDb().prepare(`SELECT * FROM dispute_evidence_records WHERE id = ?`).get(id) as Row | undefined;
  return r ? toEvidence(r) : null;
}

export function listDisputeEvidence(disputeId: string): DisputeEvidenceRecord[] {
  return (getDb()
    .prepare(`SELECT * FROM dispute_evidence_records WHERE dispute_id = ? ORDER BY created_at, rowid`)
    .all(disputeId) as Row[]).map(toEvidence);
}

/** Review fields are set exactly once (PENDING → decided). The original
 *  submission fields are never touched. */
export function reviewDisputeEvidenceGuarded(
  id: string,
  status: "ACCEPTED" | "REJECTED",
  reviewerUserId: string,
  notes: string | null,
  at: string
): boolean {
  const res = getDb()
    .prepare(
      `UPDATE dispute_evidence_records SET review_status = ?, reviewed_by_user_id = ?, reviewed_at = ?, reviewer_notes = ?
       WHERE id = ? AND review_status = 'PENDING'`
    )
    .run(status, reviewerUserId, at, notes, id);
  return Number(res.changes) === 1;
}

// -------------------------------------------------------------- cures

function toCure(r: Row): DisputeCureItem {
  return {
    id: String(r.id),
    disputeId: String(r.dispute_id),
    title: String(r.title),
    description: String(r.description),
    responsiblePartyUserId: s(r.responsible_party_user_id),
    responsibleOrganizationId: s(r.responsible_organization_id),
    dueAt: s(r.due_at),
    evidenceRequired: s(r.evidence_required),
    affectedScope: s(r.affected_scope),
    affectedAmount: numOrNull(r.affected_amount),
    priority: String(r.priority) as DisputeCureItem["priority"],
    status: String(r.status) as DisputeCureItem["status"],
    completionNote: s(r.completion_note),
    completionEvidenceId: s(r.completion_evidence_id),
    submittedAt: s(r.submitted_at),
    reviewedByUserId: s(r.reviewed_by_user_id),
    reviewedAt: s(r.reviewed_at),
    reviewDecisionNote: s(r.review_decision_note),
    waiverReason: s(r.waiver_reason),
    createdByUserId: String(r.created_by_user_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function insertCureItem(x: DisputeCureItem): void {
  getDb()
    .prepare(
      `INSERT INTO dispute_cure_items (id, dispute_id, title, description,
        responsible_party_user_id, responsible_organization_id, due_at, evidence_required,
        affected_scope, affected_amount, priority, status, completion_note, completion_evidence_id,
        submitted_at, reviewed_by_user_id, reviewed_at, review_decision_note, waiver_reason,
        created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      x.id, x.disputeId, x.title, x.description, x.responsiblePartyUserId, x.responsibleOrganizationId,
      x.dueAt, x.evidenceRequired, x.affectedScope, x.affectedAmount, x.priority, x.status,
      x.completionNote, x.completionEvidenceId, x.submittedAt, x.reviewedByUserId, x.reviewedAt,
      x.reviewDecisionNote, x.waiverReason, x.createdByUserId, x.createdAt, x.updatedAt
    );
}

export function getCureItem(id: string): DisputeCureItem | null {
  const r = getDb().prepare(`SELECT * FROM dispute_cure_items WHERE id = ?`).get(id) as Row | undefined;
  return r ? toCure(r) : null;
}

export function listCureItems(disputeId: string): DisputeCureItem[] {
  return (getDb()
    .prepare(`SELECT * FROM dispute_cure_items WHERE dispute_id = ? ORDER BY created_at, rowid`)
    .all(disputeId) as Row[]).map(toCure);
}

/** Guarded cure status transition with a field patch. */
export function transitionCureGuarded(
  id: string,
  fromStatuses: DisputeCureItem["status"][],
  toStatus: DisputeCureItem["status"],
  patch: Partial<{
    completionNote: string;
    completionEvidenceId: string;
    submittedAt: string;
    reviewedByUserId: string;
    reviewedAt: string;
    reviewDecisionNote: string;
    waiverReason: string;
  }> = {}
): boolean {
  const ph = fromStatuses.map(() => "?").join(",");
  const res = getDb()
    .prepare(
      `UPDATE dispute_cure_items SET status = ?, updated_at = ?,
        completion_note = COALESCE(?, completion_note),
        completion_evidence_id = COALESCE(?, completion_evidence_id),
        submitted_at = COALESCE(?, submitted_at),
        reviewed_by_user_id = COALESCE(?, reviewed_by_user_id),
        reviewed_at = COALESCE(?, reviewed_at),
        review_decision_note = COALESCE(?, review_decision_note),
        waiver_reason = COALESCE(?, waiver_reason)
       WHERE id = ? AND status IN (${ph})`
    )
    .run(
      toStatus, new Date().toISOString(),
      patch.completionNote ?? null, patch.completionEvidenceId ?? null, patch.submittedAt ?? null,
      patch.reviewedByUserId ?? null, patch.reviewedAt ?? null, patch.reviewDecisionNote ?? null,
      patch.waiverReason ?? null, id, ...fromStatuses
    );
  return Number(res.changes) === 1;
}

/** Deadline change: guarded due_at swap; history rows are append-only. */
export function extendCureDueGuarded(id: string, priorDueAt: string | null, newDueAt: string): boolean {
  const res = priorDueAt === null
    ? getDb()
        .prepare(`UPDATE dispute_cure_items SET due_at = ?, updated_at = ? WHERE id = ? AND due_at IS NULL AND status IN ('OPEN','SUBMITTED','REJECTED')`)
        .run(newDueAt, new Date().toISOString(), id)
    : getDb()
        .prepare(`UPDATE dispute_cure_items SET due_at = ?, updated_at = ? WHERE id = ? AND due_at = ? AND status IN ('OPEN','SUBMITTED','REJECTED')`)
        .run(newDueAt, new Date().toISOString(), id, priorDueAt);
  return Number(res.changes) === 1;
}

export function insertCureExtension(x: DisputeCureExtension): void {
  getDb()
    .prepare(
      `INSERT INTO dispute_cure_extensions (id, cure_item_id, prior_due_at, new_due_at, reason, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(x.id, x.cureItemId, x.priorDueAt, x.newDueAt, x.reason, x.actorUserId, x.createdAt);
}

export function listCureExtensions(cureItemId: string): DisputeCureExtension[] {
  return (getDb()
    .prepare(`SELECT * FROM dispute_cure_extensions WHERE cure_item_id = ? ORDER BY created_at, rowid`)
    .all(cureItemId) as Row[]).map((r) => ({
    id: String(r.id),
    cureItemId: String(r.cure_item_id),
    priorDueAt: s(r.prior_due_at),
    newDueAt: String(r.new_due_at),
    reason: String(r.reason),
    actorUserId: String(r.actor_user_id),
    createdAt: String(r.created_at),
  }));
}

// -------------------------------------------------------- inspections

function toInspection(r: Row): DisputeInspectionRequest {
  return {
    id: String(r.id),
    disputeId: String(r.dispute_id),
    inspectionType: String(r.inspection_type),
    requestedAt: String(r.requested_at),
    requestedByUserId: String(r.requested_by_user_id),
    assignedInspectorUserId: s(r.assigned_inspector_user_id),
    scheduledAt: s(r.scheduled_at),
    completedAt: s(r.completed_at),
    locationScope: s(r.location_scope),
    result: s(r.result) as DisputeInspectionRequest["result"],
    notes: s(r.notes),
    status: String(r.status) as DisputeInspectionRequest["status"],
    followUp: s(r.follow_up),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function insertDisputeInspection(x: DisputeInspectionRequest): void {
  getDb()
    .prepare(
      `INSERT INTO dispute_inspection_requests (id, dispute_id, inspection_type, requested_at,
        requested_by_user_id, assigned_inspector_user_id, scheduled_at, completed_at,
        location_scope, result, notes, status, follow_up, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      x.id, x.disputeId, x.inspectionType, x.requestedAt, x.requestedByUserId,
      x.assignedInspectorUserId, x.scheduledAt, x.completedAt, x.locationScope, x.result,
      x.notes, x.status, x.followUp, x.createdAt, x.updatedAt
    );
}

export function getDisputeInspection(id: string): DisputeInspectionRequest | null {
  const r = getDb().prepare(`SELECT * FROM dispute_inspection_requests WHERE id = ?`).get(id) as Row | undefined;
  return r ? toInspection(r) : null;
}

export function listDisputeInspections(disputeId: string): DisputeInspectionRequest[] {
  return (getDb()
    .prepare(`SELECT * FROM dispute_inspection_requests WHERE dispute_id = ? ORDER BY created_at, rowid`)
    .all(disputeId) as Row[]).map(toInspection);
}

export function transitionInspectionGuarded(
  id: string,
  fromStatuses: DisputeInspectionRequest["status"][],
  toStatus: DisputeInspectionRequest["status"],
  patch: Partial<{
    assignedInspectorUserId: string;
    scheduledAt: string;
    completedAt: string;
    result: string;
    notes: string;
    followUp: string;
  }> = {}
): boolean {
  const ph = fromStatuses.map(() => "?").join(",");
  const res = getDb()
    .prepare(
      `UPDATE dispute_inspection_requests SET status = ?, updated_at = ?,
        assigned_inspector_user_id = COALESCE(?, assigned_inspector_user_id),
        scheduled_at = COALESCE(?, scheduled_at),
        completed_at = COALESCE(?, completed_at),
        result = COALESCE(?, result),
        notes = COALESCE(?, notes),
        follow_up = COALESCE(?, follow_up)
       WHERE id = ? AND status IN (${ph})`
    )
    .run(
      toStatus, new Date().toISOString(),
      patch.assignedInspectorUserId ?? null, patch.scheduledAt ?? null, patch.completedAt ?? null,
      patch.result ?? null, patch.notes ?? null, patch.followUp ?? null, id, ...fromStatuses
    );
  return Number(res.changes) === 1;
}

// ---------------------------------------------------- recommendations

function toRecommendation(r: Row): DisputeRecommendation {
  return {
    id: String(r.id),
    disputeId: String(r.dispute_id),
    kind: String(r.kind) as DisputeRecommendation["kind"],
    summary: String(r.summary),
    basis: s(r.basis),
    aiGenerated: Boolean(r.ai_generated),
    official: Boolean(r.official),
    createdByUserId: String(r.created_by_user_id),
    approvedByUserId: s(r.approved_by_user_id),
    supersedesRecommendationId: s(r.supersedes_recommendation_id),
    createdAt: String(r.created_at),
  };
}

export function insertRecommendation(x: DisputeRecommendation): void {
  getDb()
    .prepare(
      `INSERT INTO dispute_recommendations (id, dispute_id, kind, summary, basis, ai_generated,
        official, created_by_user_id, approved_by_user_id, supersedes_recommendation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      x.id, x.disputeId, x.kind, x.summary, x.basis, x.aiGenerated ? 1 : 0, x.official ? 1 : 0,
      x.createdByUserId, x.approvedByUserId, x.supersedesRecommendationId, x.createdAt
    );
}

export function getRecommendation(id: string): DisputeRecommendation | null {
  const r = getDb().prepare(`SELECT * FROM dispute_recommendations WHERE id = ?`).get(id) as Row | undefined;
  return r ? toRecommendation(r) : null;
}

export function listRecommendations(disputeId: string): DisputeRecommendation[] {
  return (getDb()
    .prepare(`SELECT * FROM dispute_recommendations WHERE dispute_id = ? ORDER BY created_at, rowid`)
    .all(disputeId) as Row[]).map(toRecommendation);
}

/** AI-generated content becomes official exactly once, via a human. */
export function approveRecommendationGuarded(id: string, approverUserId: string): boolean {
  const res = getDb()
    .prepare(
      `UPDATE dispute_recommendations SET official = 1, approved_by_user_id = ?
       WHERE id = ? AND official = 0`
    )
    .run(approverUserId, id);
  return Number(res.changes) === 1;
}

// ------------------------------------------------------- escalations

function toEscalation(r: Row): DisputeEscalation {
  return {
    id: String(r.id),
    disputeId: String(r.dispute_id),
    escalationType: String(r.escalation_type) as DisputeEscalation["escalationType"],
    recipientName: String(r.recipient_name),
    recipientOrganization: s(r.recipient_organization),
    reason: String(r.reason),
    transmittedMaterials: s(r.transmitted_materials),
    status: String(r.status) as DisputeEscalation["status"],
    response: s(r.response),
    submittedByUserId: String(r.submitted_by_user_id),
    createdAt: String(r.created_at),
    respondedAt: s(r.responded_at),
    closedAt: s(r.closed_at),
  };
}

export function insertEscalation(x: DisputeEscalation): void {
  getDb()
    .prepare(
      `INSERT INTO dispute_escalations (id, dispute_id, escalation_type, recipient_name,
        recipient_organization, reason, transmitted_materials, status, response,
        submitted_by_user_id, created_at, responded_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      x.id, x.disputeId, x.escalationType, x.recipientName, x.recipientOrganization, x.reason,
      x.transmittedMaterials, x.status, x.response, x.submittedByUserId, x.createdAt,
      x.respondedAt, x.closedAt
    );
}

export function getEscalation(id: string): DisputeEscalation | null {
  const r = getDb().prepare(`SELECT * FROM dispute_escalations WHERE id = ?`).get(id) as Row | undefined;
  return r ? toEscalation(r) : null;
}

export function listEscalations(disputeId: string): DisputeEscalation[] {
  return (getDb()
    .prepare(`SELECT * FROM dispute_escalations WHERE dispute_id = ? ORDER BY created_at, rowid`)
    .all(disputeId) as Row[]).map(toEscalation);
}

export function transitionEscalationGuarded(
  id: string,
  fromStatuses: DisputeEscalation["status"][],
  toStatus: DisputeEscalation["status"],
  patch: Partial<{ response: string; respondedAt: string; closedAt: string }> = {}
): boolean {
  const ph = fromStatuses.map(() => "?").join(",");
  const res = getDb()
    .prepare(
      `UPDATE dispute_escalations SET status = ?,
        response = COALESCE(?, response),
        responded_at = COALESCE(?, responded_at),
        closed_at = COALESCE(?, closed_at)
       WHERE id = ? AND status IN (${ph})`
    )
    .run(toStatus, patch.response ?? null, patch.respondedAt ?? null, patch.closedAt ?? null, id, ...fromStatuses);
  return Number(res.changes) === 1;
}
