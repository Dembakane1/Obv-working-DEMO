/**
 * DMV compliance repository — Governing Code and Permit Basis versions,
 * transition-rule determinations, line-level required official
 * inspections, manual source verifications, cost-to-complete estimates
 * and draw permit-basis pins.
 *
 * Doctrine (dispute/banking repo conventions): snake_case columns, hand
 * row-mapping, ISO string timestamps, whole-currency INTEGER amounts.
 * permit_basis_versions content is IMMUTABLE — the only updates are the
 * guarded status transitions DRAFT→AUTHORITATIVE and
 * AUTHORITATIVE→SUPERSEDED; corrections INSERT a new version.
 * source_verifications and cost_to_complete_estimates are append-only —
 * no update or delete functions exist for them.
 */
import { randomUUID, createHash } from "node:crypto";
import { getDb } from "./index";
import type {
  CostToCompleteEstimate,
  DrawPermitBasisPin,
  LineInspectionRequirement,
  LineInspectionStatus,
  PermitBasisVersion,
  SourceVerification,
  TransitionRuleRecord,
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

export function withComplianceTx<T>(fn: () => T): T {
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

// ------------------------------------------------- permit basis versions

function toBasis(r: Row): PermitBasisVersion {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    projectId: String(r.project_id),
    permitId: String(r.permit_id),
    version: num(r.version),
    supersedesVersionId: s(r.supersedes_version_id),
    status: String(r.status) as PermitBasisVersion["status"],
    jurisdiction: String(r.jurisdiction),
    permittingAuthority: String(r.permitting_authority),
    propertyAddress: s(r.property_address),
    parcelIdentifier: s(r.parcel_identifier),
    permitNumber: String(r.permit_number),
    permitType: String(r.permit_type),
    tradeType: s(r.trade_type),
    workCategory: s(r.work_category),
    applicationDate: s(r.application_date),
    issuanceDate: s(r.issuance_date),
    expirationDate: s(r.expiration_date),
    permitStatus: String(r.permit_status),
    governingCodeEdition: s(r.governing_code_edition),
    localAmendments: s(r.local_amendments),
    transitionRuleId: s(r.transition_rule_id),
    governingBasis: String(r.governing_basis) as PermitBasisVersion["governingBasis"],
    applicabilityExplanation: s(r.applicability_explanation),
    sourceSystem: s(r.source_system),
    sourceUrl: s(r.source_url),
    sourceRecordId: s(r.source_record_id),
    lookupAt: s(r.lookup_at),
    lookupByUserId: s(r.lookup_by_user_id),
    verificationMethod: String(r.verification_method) as PermitBasisVersion["verificationMethod"],
    sourceEvidenceId: s(r.source_evidence_id),
    notes: s(r.notes),
    correctionReason: s(r.correction_reason),
    correctedByUserId: s(r.corrected_by_user_id),
    recordHash: String(r.record_hash),
    effectiveFrom: s(r.effective_from),
    supersededAt: s(r.superseded_at),
    finalizedAt: s(r.finalized_at),
    finalizedByUserId: s(r.finalized_by_user_id),
    createdByUserId: String(r.created_by_user_id),
    createdAt: String(r.created_at),
  };
}

export function insertPermitBasis(b: PermitBasisVersion): void {
  getDb()
    .prepare(
      `INSERT INTO permit_basis_versions (id, organization_id, project_id, permit_id, version,
        supersedes_version_id, status, jurisdiction, permitting_authority, property_address,
        parcel_identifier, permit_number, permit_type, trade_type, work_category,
        application_date, issuance_date, expiration_date, permit_status,
        governing_code_edition, local_amendments, transition_rule_id, governing_basis,
        applicability_explanation, source_system, source_url, source_record_id, lookup_at,
        lookup_by_user_id, verification_method, source_evidence_id, notes, correction_reason,
        corrected_by_user_id, record_hash, effective_from, superseded_at, finalized_at,
        finalized_by_user_id, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      b.id, b.organizationId, b.projectId, b.permitId, b.version,
      b.supersedesVersionId, b.status, b.jurisdiction, b.permittingAuthority, b.propertyAddress,
      b.parcelIdentifier, b.permitNumber, b.permitType, b.tradeType, b.workCategory,
      b.applicationDate, b.issuanceDate, b.expirationDate, b.permitStatus,
      b.governingCodeEdition, b.localAmendments, b.transitionRuleId, b.governingBasis,
      b.applicabilityExplanation, b.sourceSystem, b.sourceUrl, b.sourceRecordId, b.lookupAt,
      b.lookupByUserId, b.verificationMethod, b.sourceEvidenceId, b.notes, b.correctionReason,
      b.correctedByUserId, b.recordHash, b.effectiveFrom, b.supersededAt, b.finalizedAt,
      b.finalizedByUserId, b.createdByUserId, b.createdAt
    );
}

export function getPermitBasis(id: string): PermitBasisVersion | null {
  const r = getDb().prepare(`SELECT * FROM permit_basis_versions WHERE id = ?`).get(id) as Row | undefined;
  return r ? toBasis(r) : null;
}

export function listPermitBasisForPermit(permitId: string): PermitBasisVersion[] {
  return (getDb()
    .prepare(`SELECT * FROM permit_basis_versions WHERE permit_id = ? ORDER BY version`)
    .all(permitId) as Row[]).map(toBasis);
}

export function listPermitBasisForProject(projectId: string): PermitBasisVersion[] {
  return (getDb()
    .prepare(`SELECT * FROM permit_basis_versions WHERE project_id = ? ORDER BY permit_id, version`)
    .all(projectId) as Row[]).map(toBasis);
}

export function nextBasisVersion(permitId: string): number {
  const r = getDb()
    .prepare(`SELECT COALESCE(MAX(version), 0) v FROM permit_basis_versions WHERE permit_id = ?`)
    .get(permitId) as Row;
  return num(r.v) + 1;
}

/** The AUTHORITATIVE version for a permit (at most one by construction). */
export function authoritativeBasisForPermit(permitId: string): PermitBasisVersion | null {
  const r = getDb()
    .prepare(`SELECT * FROM permit_basis_versions WHERE permit_id = ? AND status = 'AUTHORITATIVE' ORDER BY version DESC LIMIT 1`)
    .get(permitId) as Row | undefined;
  return r ? toBasis(r) : null;
}

/** The version whose effective period covers asOf — for as-of-honest
 *  package generation: AUTHORITATIVE or SUPERSEDED versions with
 *  effective_from <= asOf and (superseded_at IS NULL OR superseded_at > asOf). */
export function basisEffectiveAt(permitId: string, asOf: string): PermitBasisVersion | null {
  const r = getDb()
    .prepare(
      `SELECT * FROM permit_basis_versions
       WHERE permit_id = ? AND status IN ('AUTHORITATIVE','SUPERSEDED')
         AND effective_from IS NOT NULL AND effective_from <= ?
         AND (superseded_at IS NULL OR superseded_at > ?)
       ORDER BY version DESC LIMIT 1`
    )
    .get(permitId, asOf, asOf) as Row | undefined;
  return r ? toBasis(r) : null;
}

/** Guarded finalization: DRAFT → AUTHORITATIVE exactly once. Content
 *  columns are untouched — only status/effective/finalization metadata. */
export function finalizeBasisGuarded(id: string, byUserId: string, at: string): boolean {
  const res = getDb()
    .prepare(
      `UPDATE permit_basis_versions
       SET status = 'AUTHORITATIVE', effective_from = ?, finalized_at = ?, finalized_by_user_id = ?
       WHERE id = ? AND status = 'DRAFT'`
    )
    .run(at, at, byUserId, id);
  return Number(res.changes) === 1;
}

/** Guarded supersession: AUTHORITATIVE → SUPERSEDED exactly once (used
 *  only inside the correction transaction that inserts the new version). */
export function supersedeBasisGuarded(id: string, at: string): boolean {
  const res = getDb()
    .prepare(
      `UPDATE permit_basis_versions SET status = 'SUPERSEDED', superseded_at = ?
       WHERE id = ? AND status = 'AUTHORITATIVE'`
    )
    .run(at, id);
  return Number(res.changes) === 1;
}

// -------------------------------------------------- transition rules

function toTransition(r: Row): TransitionRuleRecord {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    projectId: String(r.project_id),
    jurisdiction: String(r.jurisdiction),
    priorCodeEdition: String(r.prior_code_edition),
    replacementCodeEdition: String(r.replacement_code_edition),
    transitionPeriodStart: s(r.transition_period_start),
    transitionPeriodEnd: s(r.transition_period_end),
    applicationDateCutoff: s(r.application_date_cutoff),
    permitIssuanceCutoff: s(r.permit_issuance_cutoff),
    eligibility: String(r.eligibility) as TransitionRuleRecord["eligibility"],
    governingInterpretation: s(r.governing_interpretation),
    officialSourceId: s(r.official_source_id),
    lookupAt: s(r.lookup_at),
    reviewerUserId: String(r.reviewer_user_id),
    notes: s(r.notes),
    determinedAt: s(r.determined_at),
    createdAt: String(r.created_at),
  };
}

export function insertTransitionRule(t: TransitionRuleRecord): void {
  getDb()
    .prepare(
      `INSERT INTO transition_rule_records (id, organization_id, project_id, jurisdiction,
        prior_code_edition, replacement_code_edition, transition_period_start, transition_period_end,
        application_date_cutoff, permit_issuance_cutoff, eligibility, governing_interpretation,
        official_source_id, lookup_at, reviewer_user_id, notes, determined_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      t.id, t.organizationId, t.projectId, t.jurisdiction,
      t.priorCodeEdition, t.replacementCodeEdition, t.transitionPeriodStart, t.transitionPeriodEnd,
      t.applicationDateCutoff, t.permitIssuanceCutoff, t.eligibility, t.governingInterpretation,
      t.officialSourceId, t.lookupAt, t.reviewerUserId, t.notes, t.determinedAt, t.createdAt
    );
}

export function getTransitionRule(id: string): TransitionRuleRecord | null {
  const r = getDb().prepare(`SELECT * FROM transition_rule_records WHERE id = ?`).get(id) as Row | undefined;
  return r ? toTransition(r) : null;
}

export function listTransitionRulesForProject(projectId: string): TransitionRuleRecord[] {
  return (getDb()
    .prepare(`SELECT * FROM transition_rule_records WHERE project_id = ? ORDER BY created_at, rowid`)
    .all(projectId) as Row[]).map(toTransition);
}

/** Guarded eligibility determination: only a PENDING_DETERMINATION record
 *  can receive its (single) human determination. */
export function determineTransitionGuarded(
  id: string,
  eligibility: "ELIGIBLE_PRIOR_CODE" | "NOT_ELIGIBLE",
  interpretation: string | null,
  reviewerUserId: string,
  at: string
): boolean {
  const res = getDb()
    .prepare(
      `UPDATE transition_rule_records
       SET eligibility = ?, governing_interpretation = COALESCE(?, governing_interpretation),
           reviewer_user_id = ?, determined_at = ?
       WHERE id = ? AND eligibility = 'PENDING_DETERMINATION'`
    )
    .run(eligibility, interpretation, reviewerUserId, at, id);
  return Number(res.changes) === 1;
}

// -------------------------------------- line inspection requirements

function toLineReq(r: Row): LineInspectionRequirement {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    projectId: String(r.project_id),
    budgetLineId: s(r.budget_line_id),
    milestoneId: s(r.milestone_id),
    jurisdiction: s(r.jurisdiction),
    inspectionAuthority: s(r.inspection_authority),
    inspectionType: String(r.inspection_type),
    description: s(r.description),
    permitId: s(r.permit_id),
    permitBasisVersionId: s(r.permit_basis_version_id),
    prerequisiteRequirementId: s(r.prerequisite_requirement_id),
    sequence: num(r.sequence),
    requiredBeforeConcealment: Boolean(r.required_before_concealment),
    requiredBeforePayment: Boolean(r.required_before_payment),
    requiredBeforeFinal: Boolean(r.required_before_final),
    status: String(r.status) as LineInspectionStatus,
    scheduledDate: s(r.scheduled_date),
    completedDate: s(r.completed_date),
    officialResultText: s(r.official_result_text),
    correctionNotice: s(r.correction_notice),
    reinspectionRequired: Boolean(r.reinspection_required),
    reinspectionResult: s(r.reinspection_result),
    jurisdictionalInspectionId: s(r.jurisdictional_inspection_id),
    officialSourceId: s(r.official_source_id),
    lookupAt: s(r.lookup_at),
    externalIdentifier: s(r.external_identifier),
    reviewerUserId: s(r.reviewer_user_id),
    notes: s(r.notes),
    createdByUserId: String(r.created_by_user_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function insertLineRequirement(x: LineInspectionRequirement): void {
  getDb()
    .prepare(
      `INSERT INTO line_inspection_requirements (id, organization_id, project_id, budget_line_id,
        milestone_id, jurisdiction, inspection_authority, inspection_type, description, permit_id,
        permit_basis_version_id, prerequisite_requirement_id, sequence, required_before_concealment,
        required_before_payment, required_before_final, status, scheduled_date, completed_date,
        official_result_text, correction_notice, reinspection_required, reinspection_result,
        jurisdictional_inspection_id, official_source_id, lookup_at, external_identifier,
        reviewer_user_id, notes, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      x.id, x.organizationId, x.projectId, x.budgetLineId, x.milestoneId, x.jurisdiction,
      x.inspectionAuthority, x.inspectionType, x.description, x.permitId, x.permitBasisVersionId,
      x.prerequisiteRequirementId, x.sequence, x.requiredBeforeConcealment ? 1 : 0,
      x.requiredBeforePayment ? 1 : 0, x.requiredBeforeFinal ? 1 : 0, x.status, x.scheduledDate,
      x.completedDate, x.officialResultText, x.correctionNotice, x.reinspectionRequired ? 1 : 0,
      x.reinspectionResult, x.jurisdictionalInspectionId, x.officialSourceId, x.lookupAt,
      x.externalIdentifier, x.reviewerUserId, x.notes, x.createdByUserId, x.createdAt, x.updatedAt
    );
}

export function getLineRequirement(id: string): LineInspectionRequirement | null {
  const r = getDb().prepare(`SELECT * FROM line_inspection_requirements WHERE id = ?`).get(id) as Row | undefined;
  return r ? toLineReq(r) : null;
}

export function listLineRequirementsForProject(projectId: string): LineInspectionRequirement[] {
  return (getDb()
    .prepare(`SELECT * FROM line_inspection_requirements WHERE project_id = ? ORDER BY sequence, created_at, rowid`)
    .all(projectId) as Row[]).map(toLineReq);
}

/** Guarded status update with official-result fields. The from-status list
 *  makes concurrent duplicate updates lose cleanly (exactly-once). */
export function updateLineRequirementStatusGuarded(
  id: string,
  fromStatuses: LineInspectionStatus[],
  toStatus: LineInspectionStatus,
  patch: Partial<{
    scheduledDate: string;
    completedDate: string;
    officialResultText: string;
    correctionNotice: string;
    reinspectionRequired: boolean;
    reinspectionResult: string;
    jurisdictionalInspectionId: string;
    officialSourceId: string;
    lookupAt: string;
    externalIdentifier: string;
    reviewerUserId: string;
    notes: string;
  }> = {}
): boolean {
  const ph = fromStatuses.map(() => "?").join(",");
  const res = getDb()
    .prepare(
      `UPDATE line_inspection_requirements SET status = ?, updated_at = ?,
        scheduled_date = COALESCE(?, scheduled_date),
        completed_date = COALESCE(?, completed_date),
        official_result_text = COALESCE(?, official_result_text),
        correction_notice = COALESCE(?, correction_notice),
        reinspection_required = COALESCE(?, reinspection_required),
        reinspection_result = COALESCE(?, reinspection_result),
        jurisdictional_inspection_id = COALESCE(?, jurisdictional_inspection_id),
        official_source_id = COALESCE(?, official_source_id),
        lookup_at = COALESCE(?, lookup_at),
        external_identifier = COALESCE(?, external_identifier),
        reviewer_user_id = COALESCE(?, reviewer_user_id),
        notes = COALESCE(?, notes)
       WHERE id = ? AND status IN (${ph})`
    )
    .run(
      toStatus, new Date().toISOString(),
      patch.scheduledDate ?? null, patch.completedDate ?? null, patch.officialResultText ?? null,
      patch.correctionNotice ?? null,
      patch.reinspectionRequired === undefined ? null : patch.reinspectionRequired ? 1 : 0,
      patch.reinspectionResult ?? null, patch.jurisdictionalInspectionId ?? null,
      patch.officialSourceId ?? null, patch.lookupAt ?? null, patch.externalIdentifier ?? null,
      patch.reviewerUserId ?? null, patch.notes ?? null,
      id, ...fromStatuses
    );
  return Number(res.changes) === 1;
}

// ------------------------------------------------ source verifications

function toVerification(r: Row): SourceVerification {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    projectId: String(r.project_id),
    officialService: String(r.official_service),
    searchCriteria: String(r.search_criteria),
    sourceRecordIdentifier: s(r.source_record_identifier),
    lookupAt: String(r.lookup_at),
    performedByUserId: String(r.performed_by_user_id),
    resultStatus: String(r.result_status) as SourceVerification["resultStatus"],
    resultSummary: s(r.result_summary),
    evidenceSourceId: s(r.evidence_source_id),
    verificationMethod: String(r.verification_method) as SourceVerification["verificationMethod"],
    confidence: s(r.confidence) as SourceVerification["confidence"],
    nextReviewDate: s(r.next_review_date),
    notes: s(r.notes),
    permitId: s(r.permit_id),
    permitBasisVersionId: s(r.permit_basis_version_id),
    lineRequirementId: s(r.line_requirement_id),
    createdAt: String(r.created_at),
  };
}

/** Append-only. There is intentionally no update or delete function. */
export function insertSourceVerification(v: SourceVerification): void {
  getDb()
    .prepare(
      `INSERT INTO source_verifications (id, organization_id, project_id, official_service,
        search_criteria, source_record_identifier, lookup_at, performed_by_user_id, result_status,
        result_summary, evidence_source_id, verification_method, confidence, next_review_date,
        notes, permit_id, permit_basis_version_id, line_requirement_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      v.id, v.organizationId, v.projectId, v.officialService, v.searchCriteria,
      v.sourceRecordIdentifier, v.lookupAt, v.performedByUserId, v.resultStatus, v.resultSummary,
      v.evidenceSourceId, v.verificationMethod, v.confidence, v.nextReviewDate, v.notes,
      v.permitId, v.permitBasisVersionId, v.lineRequirementId, v.createdAt
    );
}

export function getSourceVerification(id: string): SourceVerification | null {
  const r = getDb().prepare(`SELECT * FROM source_verifications WHERE id = ?`).get(id) as Row | undefined;
  return r ? toVerification(r) : null;
}

export function listSourceVerificationsForProject(projectId: string): SourceVerification[] {
  return (getDb()
    .prepare(`SELECT * FROM source_verifications WHERE project_id = ? ORDER BY lookup_at, rowid`)
    .all(projectId) as Row[]).map(toVerification);
}

// -------------------------------------------- cost-to-complete estimates

function toEstimate(r: Row): CostToCompleteEstimate {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    projectId: String(r.project_id),
    budgetLineId: String(r.budget_line_id),
    drawRequestId: s(r.draw_request_id),
    verifiedCompletedValue: numOrNull(r.verified_completed_value),
    remainingCommittedCost: numOrNull(r.remaining_committed_cost),
    estimatedCostToComplete: num(r.estimated_cost_to_complete),
    sourceOfEstimate: String(r.source_of_estimate),
    estimatorUserId: String(r.estimator_user_id),
    estimateDate: String(r.estimate_date),
    confidence: String(r.confidence) as CostToCompleteEstimate["confidence"],
    notes: s(r.notes),
    createdAt: String(r.created_at),
  };
}

/** Append-only estimate history; computations use the latest per line. */
export function insertEstimate(e: CostToCompleteEstimate): void {
  getDb()
    .prepare(
      `INSERT INTO cost_to_complete_estimates (id, organization_id, project_id, budget_line_id,
        draw_request_id, verified_completed_value, remaining_committed_cost,
        estimated_cost_to_complete, source_of_estimate, estimator_user_id, estimate_date,
        confidence, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.organizationId, e.projectId, e.budgetLineId, e.drawRequestId,
      e.verifiedCompletedValue, e.remainingCommittedCost, e.estimatedCostToComplete,
      e.sourceOfEstimate, e.estimatorUserId, e.estimateDate, e.confidence, e.notes, e.createdAt
    );
}

export function listEstimatesForProject(projectId: string): CostToCompleteEstimate[] {
  return (getDb()
    .prepare(`SELECT * FROM cost_to_complete_estimates WHERE project_id = ? ORDER BY created_at, rowid`)
    .all(projectId) as Row[]).map(toEstimate);
}

export function latestEstimateForLine(budgetLineId: string): CostToCompleteEstimate | null {
  const r = getDb()
    .prepare(`SELECT * FROM cost_to_complete_estimates WHERE budget_line_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(budgetLineId) as Row | undefined;
  return r ? toEstimate(r) : null;
}

/** Latest estimate per line that existed at asOf (as-of-honest packages). */
export function latestEstimateForLineAt(budgetLineId: string, asOf: string): CostToCompleteEstimate | null {
  const r = getDb()
    .prepare(
      `SELECT * FROM cost_to_complete_estimates
       WHERE budget_line_id = ? AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(budgetLineId, asOf) as Row | undefined;
  return r ? toEstimate(r) : null;
}

// ---------------------------------------------- draw permit-basis pins

function toPin(r: Row): DrawPermitBasisPin {
  return {
    id: String(r.id),
    drawRequestId: String(r.draw_request_id),
    permitId: String(r.permit_id),
    permitBasisVersionId: String(r.permit_basis_version_id),
    pinnedAt: String(r.pinned_at),
    pinnedByUserId: s(r.pinned_by_user_id),
  };
}

/** Idempotent pin: the FIRST pin for (draw, permit) wins permanently —
 *  a later correction never rewrites which version governed the draw. */
export function pinDrawBasis(p: DrawPermitBasisPin): boolean {
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO draw_permit_basis_pins
        (id, draw_request_id, permit_id, permit_basis_version_id, pinned_at, pinned_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(p.id, p.drawRequestId, p.permitId, p.permitBasisVersionId, p.pinnedAt, p.pinnedByUserId);
  return Number(res.changes) === 1;
}

export function listPinsForDraw(drawRequestId: string): DrawPermitBasisPin[] {
  return (getDb()
    .prepare(`SELECT * FROM draw_permit_basis_pins WHERE draw_request_id = ? ORDER BY pinned_at, rowid`)
    .all(drawRequestId) as Row[]).map(toPin);
}
