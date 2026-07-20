/**
 * Lender-pilot operating layer — repository.
 *
 * Additive module: all SQL for the lender domain lives here so the core
 * repo remains untouched. Same conventions: snake_case columns, hand
 * row-mapping, ISO string timestamps, whole-currency integers, JSON as
 * TEXT. History tables (ownership, servicing, stage events, inspection
 * events) are append-only — no update or delete functions exist for them.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./index";
import type {
  DrawInspection,
  DrawInspectionEvent,
  DrawInspectionLine,
  DrawInspectionReportVersion,
  DrawStageEvent,
  DrawWorkflowStage,
  ExternalFundingRecord,
  JurisdictionProfile,
  LenderDecisionCondition,
  LenderDrawDecision,
  LenderDrawPolicy,
  LienWaiverRecord,
  LoanAsset,
  LoanOwnershipEvent,
  LoanServicingEvent,
  ProjectMembership,
  ProjectPartyAssignment,
} from "../../shared/types";

type Row = Record<string, unknown>;

export function newId(): string {
  return randomUUID();
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const b = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));

// ------------------------------------------------------------ loan assets

function toLoanAsset(r: Row): LoanAsset {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    projectId: String(r.project_id),
    loanNumber: String(r.loan_number),
    propertyAddress: s(r.property_address),
    propertyType: s(r.property_type),
    borrowerOrganizationId: s(r.borrower_organization_id),
    primaryContractorOrganizationId: s(r.primary_contractor_organization_id),
    lenderOrganizationId: s(r.lender_organization_id),
    originalLoanAmount: n(r.original_loan_amount),
    currentLoanAmount: n(r.current_loan_amount),
    originalConstructionBudget: n(r.original_construction_budget),
    currentApprovedConstructionBudget: n(r.current_approved_construction_budget),
    originalConstructionReserve: n(r.original_construction_reserve),
    currentConstructionReserve: n(r.current_construction_reserve),
    closingDate: s(r.closing_date),
    estimatedConstructionCompletionDate: s(r.estimated_construction_completion_date),
    originalMaturityDate: s(r.original_maturity_date),
    currentMaturityDate: s(r.current_maturity_date),
    servicingSystemName: s(r.servicing_system_name),
    servicingSystemReference: s(r.servicing_system_reference),
    currentServicerOrganizationId: s(r.current_servicer_organization_id),
    currentLoanOwnerOrganizationId: s(r.current_loan_owner_organization_id),
    warehouseLenderOrganizationId: s(r.warehouse_lender_organization_id),
    secondaryMarketPurchaserOrganizationId: s(r.secondary_market_purchaser_organization_id),
    occupancyType: s(r.occupancy_type),
    loanPurpose: s(r.loan_purpose),
    riskLevel: String(r.risk_level) as LoanAsset["riskLevel"],
    status: String(r.status) as LoanAsset["status"],
    inspectorAssignedUserId: s(r.inspector_assigned_user_id),
    lenderReviewerAssignedUserId: s(r.lender_reviewer_assigned_user_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

const LOAN_COLS = [
  "property_address", "property_type", "borrower_organization_id",
  "primary_contractor_organization_id", "lender_organization_id",
  "original_loan_amount", "current_loan_amount", "original_construction_budget",
  "current_approved_construction_budget", "original_construction_reserve",
  "current_construction_reserve", "closing_date",
  "estimated_construction_completion_date", "original_maturity_date",
  "current_maturity_date", "servicing_system_name", "servicing_system_reference",
  "current_servicer_organization_id", "current_loan_owner_organization_id",
  "warehouse_lender_organization_id", "secondary_market_purchaser_organization_id",
  "occupancy_type", "loan_purpose", "risk_level", "status",
  "inspector_assigned_user_id", "lender_reviewer_assigned_user_id",
];

const camel = (col: string): string => col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

export function insertLoanAsset(a: LoanAsset): void {
  getDb()
    .prepare(
      `INSERT INTO loan_assets (id, organization_id, project_id, loan_number,
        ${LOAN_COLS.join(", ")}, created_at, updated_at)
       VALUES (?, ?, ?, ?, ${LOAN_COLS.map(() => "?").join(", ")}, ?, ?)`
    )
    .run(
      a.id, a.organizationId, a.projectId, a.loanNumber,
      ...LOAN_COLS.map((c) => (a as unknown as Row)[camel(c)] as never ?? null),
      a.createdAt, a.updatedAt
    );
}

export function getLoanAsset(id: string): LoanAsset | null {
  const r = getDb().prepare("SELECT * FROM loan_assets WHERE id = ?").get(id);
  return r ? toLoanAsset(r as Row) : null;
}

export function getLoanAssetForProject(projectId: string): LoanAsset | null {
  const r = getDb().prepare("SELECT * FROM loan_assets WHERE project_id = ? ORDER BY created_at LIMIT 1").get(projectId);
  return r ? toLoanAsset(r as Row) : null;
}

export function listLoanAssets(): LoanAsset[] {
  return getDb().prepare("SELECT * FROM loan_assets ORDER BY created_at").all().map((r) => toLoanAsset(r as Row));
}

export function updateLoanAsset(id: string, patch: Partial<LoanAsset>): void {
  const cur = getLoanAsset(id);
  if (!cur) return;
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  getDb()
    .prepare(
      `UPDATE loan_assets SET ${LOAN_COLS.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
    )
    .run(...LOAN_COLS.map((c) => (next as unknown as Row)[camel(c)] as never ?? null), next.updatedAt, id);
}

export function insertLoanOwnershipEvent(e: LoanOwnershipEvent): void {
  getDb()
    .prepare(
      `INSERT INTO loan_ownership_events (id, loan_asset_id, prior_owner_organization_id,
        new_owner_organization_id, effective_at, transfer_type, reference,
        recorded_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.loanAssetId, e.priorOwnerOrganizationId, e.newOwnerOrganizationId,
      e.effectiveAt, e.transferType, e.reference, e.recordedByUserId, e.createdAt);
}

export function listLoanOwnershipEvents(loanAssetId: string): LoanOwnershipEvent[] {
  return getDb()
    .prepare("SELECT * FROM loan_ownership_events WHERE loan_asset_id = ? ORDER BY created_at")
    .all(loanAssetId)
    .map((r: Row) => ({
      id: String(r.id), loanAssetId: String(r.loan_asset_id),
      priorOwnerOrganizationId: s(r.prior_owner_organization_id),
      newOwnerOrganizationId: String(r.new_owner_organization_id),
      effectiveAt: String(r.effective_at), transferType: s(r.transfer_type),
      reference: s(r.reference), recordedByUserId: String(r.recorded_by_user_id),
      createdAt: String(r.created_at),
    }));
}

export function insertLoanServicingEvent(e: LoanServicingEvent): void {
  getDb()
    .prepare(
      `INSERT INTO loan_servicing_events (id, loan_asset_id, prior_servicer_organization_id,
        new_servicer_organization_id, effective_at, reference, recorded_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.loanAssetId, e.priorServicerOrganizationId, e.newServicerOrganizationId,
      e.effectiveAt, e.reference, e.recordedByUserId, e.createdAt);
}

export function listLoanServicingEvents(loanAssetId: string): LoanServicingEvent[] {
  return getDb()
    .prepare("SELECT * FROM loan_servicing_events WHERE loan_asset_id = ? ORDER BY created_at")
    .all(loanAssetId)
    .map((r: Row) => ({
      id: String(r.id), loanAssetId: String(r.loan_asset_id),
      priorServicerOrganizationId: s(r.prior_servicer_organization_id),
      newServicerOrganizationId: String(r.new_servicer_organization_id),
      effectiveAt: String(r.effective_at), reference: s(r.reference),
      recordedByUserId: String(r.recorded_by_user_id), createdAt: String(r.created_at),
    }));
}

// ------------------------------------------------------------ parties

function toParty(r: Row): ProjectPartyAssignment {
  return {
    id: String(r.id), organizationId: String(r.organization_id),
    projectId: String(r.project_id), partyOrganizationId: String(r.party_organization_id),
    partyType: String(r.party_type) as ProjectPartyAssignment["partyType"],
    effectiveFrom: s(r.effective_from), effectiveTo: s(r.effective_to),
    active: Boolean(r.active), reference: s(r.reference), notes: s(r.notes),
    createdByUserId: String(r.created_by_user_id), createdAt: String(r.created_at),
  };
}

export function insertPartyAssignment(p: ProjectPartyAssignment): void {
  getDb()
    .prepare(
      `INSERT INTO project_party_assignments (id, organization_id, project_id,
        party_organization_id, party_type, effective_from, effective_to, active,
        reference, notes, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(p.id, p.organizationId, p.projectId, p.partyOrganizationId, p.partyType,
      p.effectiveFrom, p.effectiveTo, p.active ? 1 : 0, p.reference, p.notes,
      p.createdByUserId, p.createdAt);
}

export function listPartyAssignments(projectId: string): ProjectPartyAssignment[] {
  return getDb()
    .prepare("SELECT * FROM project_party_assignments WHERE project_id = ? ORDER BY created_at")
    .all(projectId)
    .map((r) => toParty(r as Row));
}

export function getPartyAssignment(id: string): ProjectPartyAssignment | null {
  const r = getDb().prepare("SELECT * FROM project_party_assignments WHERE id = ?").get(id);
  return r ? toParty(r as Row) : null;
}

/** Ending a party is an update of active/effectiveTo — history rows persist. */
export function endPartyAssignment(id: string, effectiveTo: string): void {
  getDb()
    .prepare("UPDATE project_party_assignments SET active = 0, effective_to = ? WHERE id = ?")
    .run(effectiveTo, id);
}

// ------------------------------------------------------------ jurisdiction

function toJurisdiction(r: Row): JurisdictionProfile {
  return {
    id: String(r.id), projectId: String(r.project_id),
    templateKey: String(r.template_key) as JurisdictionProfile["templateKey"],
    state: s(r.state), countyOrCity: s(r.county_or_city),
    jurisdictionName: s(r.jurisdiction_name), permitAuthority: s(r.permit_authority),
    permitSystemName: s(r.permit_system_name), officialSystemUrl: s(r.official_system_url),
    timezone: s(r.timezone), jurisdictionCode: s(r.jurisdiction_code), notes: s(r.notes),
    configuredByUserId: String(r.configured_by_user_id),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export function upsertJurisdictionProfile(j: JurisdictionProfile): void {
  getDb()
    .prepare(
      `INSERT INTO jurisdiction_profiles (id, project_id, template_key, state,
        county_or_city, jurisdiction_name, permit_authority, permit_system_name,
        official_system_url, timezone, jurisdiction_code, notes,
        configured_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
        template_key=excluded.template_key, state=excluded.state,
        county_or_city=excluded.county_or_city, jurisdiction_name=excluded.jurisdiction_name,
        permit_authority=excluded.permit_authority, permit_system_name=excluded.permit_system_name,
        official_system_url=excluded.official_system_url, timezone=excluded.timezone,
        jurisdiction_code=excluded.jurisdiction_code, notes=excluded.notes,
        configured_by_user_id=excluded.configured_by_user_id, updated_at=excluded.updated_at`
    )
    .run(j.id, j.projectId, j.templateKey, j.state, j.countyOrCity, j.jurisdictionName,
      j.permitAuthority, j.permitSystemName, j.officialSystemUrl, j.timezone,
      j.jurisdictionCode, j.notes, j.configuredByUserId, j.createdAt, j.updatedAt);
}

export function getJurisdictionProfile(projectId: string): JurisdictionProfile | null {
  const r = getDb().prepare("SELECT * FROM jurisdiction_profiles WHERE project_id = ?").get(projectId);
  return r ? toJurisdiction(r as Row) : null;
}

// ------------------------------------------------------------ draw inspections

function toInspection(r: Row): DrawInspection {
  return {
    id: String(r.id), organizationId: String(r.organization_id),
    projectId: String(r.project_id), drawRequestId: String(r.draw_request_id),
    inspectionType: String(r.inspection_type),
    inspectionCompanyOrganizationId: s(r.inspection_company_organization_id),
    inspectorUserId: s(r.inspector_user_id), inspectorDisplayName: s(r.inspector_display_name),
    inspectorCredential: s(r.inspector_credential), inspectorContact: s(r.inspector_contact),
    requestedAt: s(r.requested_at), requestedByUserId: s(r.requested_by_user_id),
    scheduledAt: s(r.scheduled_at), propertyAccessContact: s(r.property_access_contact),
    preferredInspectionStart: s(r.preferred_inspection_start),
    preferredInspectionEnd: s(r.preferred_inspection_end),
    completedAt: s(r.completed_at), reportReceivedAt: s(r.report_received_at),
    finalizedAt: s(r.finalized_at),
    status: String(r.status) as DrawInspection["status"],
    reinspectionOfInspectionId: s(r.reinspection_of_inspection_id),
    borrowerResponseStatus: s(r.borrower_response_status) as DrawInspection["borrowerResponseStatus"],
    borrowerResponseNote: s(r.borrower_response_note),
    obvReviewStatus: s(r.obv_review_status) as DrawInspection["obvReviewStatus"],
    obvReviewedByUserId: s(r.obv_reviewed_by_user_id),
    lenderAcceptanceStatus: s(r.lender_acceptance_status) as DrawInspection["lenderAcceptanceStatus"],
    lenderAcceptedByUserId: s(r.lender_accepted_by_user_id),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

const INSPECTION_COLS = [
  "inspection_type", "inspection_company_organization_id", "inspector_user_id",
  "inspector_display_name", "inspector_credential", "inspector_contact",
  "requested_at", "requested_by_user_id", "scheduled_at", "property_access_contact",
  "preferred_inspection_start", "preferred_inspection_end", "completed_at",
  "report_received_at", "finalized_at", "status", "reinspection_of_inspection_id",
  "borrower_response_status", "borrower_response_note", "obv_review_status",
  "obv_reviewed_by_user_id", "lender_acceptance_status", "lender_accepted_by_user_id",
];

export function insertDrawInspection(i: DrawInspection): void {
  getDb()
    .prepare(
      `INSERT INTO draw_inspections (id, organization_id, project_id, draw_request_id,
        ${INSPECTION_COLS.join(", ")}, created_at, updated_at)
       VALUES (?, ?, ?, ?, ${INSPECTION_COLS.map(() => "?").join(", ")}, ?, ?)`
    )
    .run(i.id, i.organizationId, i.projectId, i.drawRequestId,
      ...INSPECTION_COLS.map((c) => (i as unknown as Row)[camel(c)] as never ?? null),
      i.createdAt, i.updatedAt);
}

export function getDrawInspection(id: string): DrawInspection | null {
  const r = getDb().prepare("SELECT * FROM draw_inspections WHERE id = ?").get(id);
  return r ? toInspection(r as Row) : null;
}

export function listDrawInspections(drawRequestId: string): DrawInspection[] {
  return getDb()
    .prepare("SELECT * FROM draw_inspections WHERE draw_request_id = ? ORDER BY created_at")
    .all(drawRequestId)
    .map((r) => toInspection(r as Row));
}

export function listDrawInspectionsForProject(projectId: string): DrawInspection[] {
  return getDb()
    .prepare("SELECT * FROM draw_inspections WHERE project_id = ? ORDER BY created_at")
    .all(projectId)
    .map((r) => toInspection(r as Row));
}

export function updateDrawInspection(id: string, patch: Partial<DrawInspection>): void {
  const cur = getDrawInspection(id);
  if (!cur) return;
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  getDb()
    .prepare(
      `UPDATE draw_inspections SET ${INSPECTION_COLS.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
    )
    .run(...INSPECTION_COLS.map((c) => (next as unknown as Row)[camel(c)] as never ?? null), next.updatedAt, id);
}

export function insertInspectionEvent(e: DrawInspectionEvent): void {
  getDb()
    .prepare(
      "INSERT INTO draw_inspection_events (id, draw_inspection_id, type, detail, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(e.id, e.drawInspectionId, e.type, e.detail, e.actorUserId, e.createdAt);
}

export function listInspectionEvents(drawInspectionId: string): DrawInspectionEvent[] {
  return getDb()
    .prepare("SELECT * FROM draw_inspection_events WHERE draw_inspection_id = ? ORDER BY created_at")
    .all(drawInspectionId)
    .map((r: Row) => ({
      id: String(r.id), drawInspectionId: String(r.draw_inspection_id),
      type: String(r.type), detail: String(r.detail),
      actorUserId: s(r.actor_user_id), createdAt: String(r.created_at),
    }));
}

// -------------------------------------------------- inspection lines

function toInspectionLine(r: Row): DrawInspectionLine {
  return {
    id: String(r.id), drawInspectionId: String(r.draw_inspection_id),
    drawLineItemId: s(r.draw_line_item_id), budgetLineId: s(r.budget_line_id),
    milestoneId: s(r.milestone_id),
    percentCompleteReported: n(r.percent_complete_reported),
    materialsPresent: b(r.materials_present),
    materialsStoredOnSite: b(r.materials_stored_on_site),
    materialsStoredOffSite: b(r.materials_stored_off_site),
    workConsistentWithPlans: b(r.work_consistent_with_plans),
    workmanshipObservation: s(r.workmanship_observation),
    visibleDefects: s(r.visible_defects), safetyConcerns: s(r.safety_concerns),
    inaccessibleAreas: s(r.inaccessible_areas), inspectorNote: s(r.inspector_note),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export function insertInspectionLine(l: DrawInspectionLine): void {
  getDb()
    .prepare(
      `INSERT INTO draw_inspection_lines (id, draw_inspection_id, draw_line_item_id,
        budget_line_id, milestone_id, percent_complete_reported, materials_present,
        materials_stored_on_site, materials_stored_off_site, work_consistent_with_plans,
        workmanship_observation, visible_defects, safety_concerns, inaccessible_areas,
        inspector_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(l.id, l.drawInspectionId, l.drawLineItemId, l.budgetLineId, l.milestoneId,
      l.percentCompleteReported,
      l.materialsPresent === null ? null : l.materialsPresent ? 1 : 0,
      l.materialsStoredOnSite === null ? null : l.materialsStoredOnSite ? 1 : 0,
      l.materialsStoredOffSite === null ? null : l.materialsStoredOffSite ? 1 : 0,
      l.workConsistentWithPlans === null ? null : l.workConsistentWithPlans ? 1 : 0,
      l.workmanshipObservation, l.visibleDefects, l.safetyConcerns,
      l.inaccessibleAreas, l.inspectorNote, l.createdAt, l.updatedAt);
}

export function listInspectionLines(drawInspectionId: string): DrawInspectionLine[] {
  return getDb()
    .prepare("SELECT * FROM draw_inspection_lines WHERE draw_inspection_id = ? ORDER BY created_at")
    .all(drawInspectionId)
    .map((r) => toInspectionLine(r as Row));
}

// -------------------------------------------------- report versions

function toReportVersion(r: Row): DrawInspectionReportVersion {
  return {
    id: String(r.id), drawInspectionId: String(r.draw_inspection_id),
    version: Number(r.version),
    status: String(r.status) as DrawInspectionReportVersion["status"],
    reportDate: s(r.report_date), summary: s(r.summary), conclusion: s(r.conclusion),
    preparedByUserId: String(r.prepared_by_user_id),
    finalizedByUserId: s(r.finalized_by_user_id),
    createdAt: String(r.created_at), finalizedAt: s(r.finalized_at),
    priorVersionId: s(r.prior_version_id), correctionReason: s(r.correction_reason),
    documentPath: s(r.document_path), documentHash: s(r.document_hash),
  };
}

export function insertReportVersion(v: DrawInspectionReportVersion): void {
  getDb()
    .prepare(
      `INSERT INTO draw_inspection_report_versions (id, draw_inspection_id, version,
        status, report_date, summary, conclusion, prepared_by_user_id,
        finalized_by_user_id, created_at, finalized_at, prior_version_id,
        correction_reason, document_path, document_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(v.id, v.drawInspectionId, v.version, v.status, v.reportDate, v.summary,
      v.conclusion, v.preparedByUserId, v.finalizedByUserId, v.createdAt,
      v.finalizedAt, v.priorVersionId, v.correctionReason, v.documentPath, v.documentHash);
}

export function getReportVersion(id: string): DrawInspectionReportVersion | null {
  const r = getDb().prepare("SELECT * FROM draw_inspection_report_versions WHERE id = ?").get(id);
  return r ? toReportVersion(r as Row) : null;
}

export function listReportVersions(drawInspectionId: string): DrawInspectionReportVersion[] {
  return getDb()
    .prepare("SELECT * FROM draw_inspection_report_versions WHERE draw_inspection_id = ? ORDER BY version")
    .all(drawInspectionId)
    .map((r) => toReportVersion(r as Row));
}

/** DRAFT-only mutation. Finalized/superseded versions are immutable — the
 *  WHERE clause enforces it at the SQL layer and callers must check changes. */
export function updateDraftReportVersion(
  id: string,
  patch: Partial<Pick<DrawInspectionReportVersion, "reportDate" | "summary" | "conclusion" | "documentPath" | "documentHash">>
): boolean {
  const cur = getReportVersion(id);
  if (!cur) return false;
  const next = { ...cur, ...patch };
  const res = getDb()
    .prepare(
      `UPDATE draw_inspection_report_versions
       SET report_date = ?, summary = ?, conclusion = ?, document_path = ?, document_hash = ?
       WHERE id = ? AND status = 'DRAFT'`
    )
    .run(next.reportDate, next.summary, next.conclusion, next.documentPath, next.documentHash, id);
  return res.changes === 1;
}

/** Finalize atomically: the draft becomes FINALIZED and any previously
 *  finalized version becomes SUPERSEDED — history rows are never deleted. */
export function finalizeReportVersionTx(id: string, finalizedByUserId: string, finalizedAt: string): boolean {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const cur = getReportVersion(id);
    if (!cur || cur.status !== "DRAFT") {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare(
      `UPDATE draw_inspection_report_versions SET status = 'SUPERSEDED'
       WHERE draw_inspection_id = ? AND status = 'FINALIZED'`
    ).run(cur.drawInspectionId);
    const res = db
      .prepare(
        `UPDATE draw_inspection_report_versions
         SET status = 'FINALIZED', finalized_by_user_id = ?, finalized_at = ?
         WHERE id = ? AND status = 'DRAFT'`
      )
      .run(finalizedByUserId, finalizedAt, id);
    if (res.changes !== 1) throw new Error("finalize conflict");
    db.exec("COMMIT");
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// -------------------------------------------------- lender decisions

function toDecision(r: Row): LenderDrawDecision {
  return {
    id: String(r.id), organizationId: String(r.organization_id),
    projectId: String(r.project_id), drawRequestId: String(r.draw_request_id),
    requestedAmount: Number(r.requested_amount), verifiedAmount: n(r.verified_amount),
    recommendedAmount: n(r.recommended_amount), approvedAmount: n(r.approved_amount),
    reducedAmount: n(r.reduced_amount), rejectedAmount: n(r.rejected_amount),
    decision: String(r.decision) as LenderDrawDecision["decision"],
    reviewerUserId: String(r.reviewer_user_id), decisionAt: s(r.decision_at),
    decisionReason: s(r.decision_reason), holdbackAmount: n(r.holdback_amount),
    retainageAmount: n(r.retainage_amount), exceptionsAccepted: s(r.exceptions_accepted),
    governmentInspectionRequirement: s(r.government_inspection_requirement),
    lienReleaseRequirement: s(r.lien_release_requirement),
    fundingInstructions: s(r.funding_instructions), notes: s(r.notes),
    approvalRequestId: s(r.approval_request_id),
    supersedesDecisionId: s(r.supersedes_decision_id),
    supersededByDecisionId: s(r.superseded_by_decision_id),
    verifiedAmountSource: s(r.verified_amount_source),
    recommendedAmountSource: s(r.recommended_amount_source),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

const DECISION_COLS = [
  "requested_amount", "verified_amount", "recommended_amount", "approved_amount",
  "reduced_amount", "rejected_amount", "decision", "reviewer_user_id",
  "decision_at", "decision_reason", "holdback_amount", "retainage_amount",
  "exceptions_accepted", "government_inspection_requirement",
  "lien_release_requirement", "funding_instructions", "notes",
  "approval_request_id", "supersedes_decision_id", "superseded_by_decision_id",
  "verified_amount_source", "recommended_amount_source",
];

export function insertLenderDecision(d: LenderDrawDecision): void {
  getDb()
    .prepare(
      `INSERT INTO lender_draw_decisions (id, organization_id, project_id, draw_request_id,
        ${DECISION_COLS.join(", ")}, created_at, updated_at)
       VALUES (?, ?, ?, ?, ${DECISION_COLS.map(() => "?").join(", ")}, ?, ?)`
    )
    .run(d.id, d.organizationId, d.projectId, d.drawRequestId,
      ...DECISION_COLS.map((c) => (d as unknown as Row)[camel(c)] as never ?? null),
      d.createdAt, d.updatedAt);
}

export function getLenderDecision(id: string): LenderDrawDecision | null {
  const r = getDb().prepare("SELECT * FROM lender_draw_decisions WHERE id = ?").get(id);
  return r ? toDecision(r as Row) : null;
}

export function listLenderDecisions(drawRequestId: string): LenderDrawDecision[] {
  return getDb()
    .prepare("SELECT * FROM lender_draw_decisions WHERE draw_request_id = ? ORDER BY created_at")
    .all(drawRequestId)
    .map((r) => toDecision(r as Row));
}

export function listLenderDecisionsForProject(projectId: string): LenderDrawDecision[] {
  return getDb()
    .prepare("SELECT * FROM lender_draw_decisions WHERE project_id = ? ORDER BY created_at")
    .all(projectId)
    .map((r) => toDecision(r as Row));
}

export function updateLenderDecision(id: string, patch: Partial<LenderDrawDecision>): void {
  const cur = getLenderDecision(id);
  if (!cur) return;
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  getDb()
    .prepare(
      `UPDATE lender_draw_decisions SET ${DECISION_COLS.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
    )
    .run(...DECISION_COLS.map((c) => (next as unknown as Row)[camel(c)] as never ?? null), next.updatedAt, id);
}

function toCondition(r: Row): LenderDecisionCondition {
  return {
    id: String(r.id), lenderDecisionId: String(r.lender_decision_id),
    conditionType: String(r.condition_type), description: String(r.description),
    responsiblePartyOrganizationId: s(r.responsible_party_organization_id),
    dueAt: s(r.due_at),
    status: String(r.status) as LenderDecisionCondition["status"],
    supportingDocumentId: s(r.supporting_document_id),
    satisfiedByUserId: s(r.satisfied_by_user_id), satisfiedAt: s(r.satisfied_at),
    waiverReason: s(r.waiver_reason), waivedByUserId: s(r.waived_by_user_id),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export function insertDecisionCondition(c: LenderDecisionCondition): void {
  getDb()
    .prepare(
      `INSERT INTO lender_decision_conditions (id, lender_decision_id, condition_type,
        description, responsible_party_organization_id, due_at, status,
        supporting_document_id, satisfied_by_user_id, satisfied_at, waiver_reason,
        waived_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(c.id, c.lenderDecisionId, c.conditionType, c.description,
      c.responsiblePartyOrganizationId, c.dueAt, c.status, c.supportingDocumentId,
      c.satisfiedByUserId, c.satisfiedAt, c.waiverReason, c.waivedByUserId,
      c.createdAt, c.updatedAt);
}

export function getDecisionCondition(id: string): LenderDecisionCondition | null {
  const r = getDb().prepare("SELECT * FROM lender_decision_conditions WHERE id = ?").get(id);
  return r ? toCondition(r as Row) : null;
}

export function listDecisionConditions(lenderDecisionId: string): LenderDecisionCondition[] {
  return getDb()
    .prepare("SELECT * FROM lender_decision_conditions WHERE lender_decision_id = ? ORDER BY created_at")
    .all(lenderDecisionId)
    .map((r) => toCondition(r as Row));
}

export function updateDecisionCondition(id: string, patch: Partial<LenderDecisionCondition>): void {
  const cur = getDecisionCondition(id);
  if (!cur) return;
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  getDb()
    .prepare(
      `UPDATE lender_decision_conditions SET condition_type = ?, description = ?,
        responsible_party_organization_id = ?, due_at = ?, status = ?,
        supporting_document_id = ?, satisfied_by_user_id = ?, satisfied_at = ?,
        waiver_reason = ?, waived_by_user_id = ?, updated_at = ? WHERE id = ?`
    )
    .run(next.conditionType, next.description, next.responsiblePartyOrganizationId,
      next.dueAt, next.status, next.supportingDocumentId, next.satisfiedByUserId,
      next.satisfiedAt, next.waiverReason, next.waivedByUserId, next.updatedAt, id);
}

// -------------------------------------------------- lien waivers

function toWaiver(r: Row): LienWaiverRecord {
  return {
    id: String(r.id), organizationId: String(r.organization_id),
    projectId: String(r.project_id), drawRequestId: String(r.draw_request_id),
    drawLineItemId: s(r.draw_line_item_id), drawDocumentId: s(r.draw_document_id),
    contractorOrSupplierOrganizationId: s(r.contractor_or_supplier_organization_id),
    signingParty: s(r.signing_party), waiverType: s(r.waiver_type),
    waiverScope: s(r.waiver_scope), relatedAmount: n(r.related_amount),
    coveredThrough: s(r.covered_through), requestedAt: s(r.requested_at),
    receivedAt: s(r.received_at), reviewedAt: s(r.reviewed_at),
    acceptedAt: s(r.accepted_at), rejectedAt: s(r.rejected_at),
    signatureDate: s(r.signature_date),
    status: String(r.status) as LienWaiverRecord["status"],
    reviewedByUserId: s(r.reviewed_by_user_id), rejectionReason: s(r.rejection_reason),
    documentHash: s(r.document_hash),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

const WAIVER_COLS = [
  "draw_line_item_id", "draw_document_id", "contractor_or_supplier_organization_id",
  "signing_party", "waiver_type", "waiver_scope", "related_amount", "covered_through",
  "requested_at", "received_at", "reviewed_at", "accepted_at", "rejected_at",
  "signature_date", "status", "reviewed_by_user_id", "rejection_reason", "document_hash",
];

export function insertLienWaiver(w: LienWaiverRecord): void {
  getDb()
    .prepare(
      `INSERT INTO lien_waiver_records (id, organization_id, project_id, draw_request_id,
        ${WAIVER_COLS.join(", ")}, created_at, updated_at)
       VALUES (?, ?, ?, ?, ${WAIVER_COLS.map(() => "?").join(", ")}, ?, ?)`
    )
    .run(w.id, w.organizationId, w.projectId, w.drawRequestId,
      ...WAIVER_COLS.map((c) => (w as unknown as Row)[camel(c)] as never ?? null),
      w.createdAt, w.updatedAt);
}

export function getLienWaiver(id: string): LienWaiverRecord | null {
  const r = getDb().prepare("SELECT * FROM lien_waiver_records WHERE id = ?").get(id);
  return r ? toWaiver(r as Row) : null;
}

export function listLienWaivers(drawRequestId: string): LienWaiverRecord[] {
  return getDb()
    .prepare("SELECT * FROM lien_waiver_records WHERE draw_request_id = ? ORDER BY created_at")
    .all(drawRequestId)
    .map((r) => toWaiver(r as Row));
}

export function listLienWaiversForProject(projectId: string): LienWaiverRecord[] {
  return getDb()
    .prepare("SELECT * FROM lien_waiver_records WHERE project_id = ? ORDER BY created_at")
    .all(projectId)
    .map((r) => toWaiver(r as Row));
}

export function updateLienWaiver(id: string, patch: Partial<LienWaiverRecord>): void {
  const cur = getLienWaiver(id);
  if (!cur) return;
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  getDb()
    .prepare(
      `UPDATE lien_waiver_records SET ${WAIVER_COLS.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
    )
    .run(...WAIVER_COLS.map((c) => (next as unknown as Row)[camel(c)] as never ?? null), next.updatedAt, id);
}

// -------------------------------------------------- external funding

function toFunding(r: Row): ExternalFundingRecord {
  return {
    id: String(r.id), organizationId: String(r.organization_id),
    projectId: String(r.project_id), drawRequestId: String(r.draw_request_id),
    lenderDecisionId: s(r.lender_decision_id), fundingMethod: s(r.funding_method),
    scheduledAt: s(r.scheduled_at), fundedAt: s(r.funded_at),
    amountScheduled: n(r.amount_scheduled), amountDisbursed: n(r.amount_disbursed),
    wireFee: n(r.wire_fee), transactionReference: s(r.transaction_reference),
    confirmationDocumentId: s(r.confirmation_document_id),
    status: String(r.status) as ExternalFundingRecord["status"],
    failureReason: s(r.failure_reason), reversalReference: s(r.reversal_reference),
    reversedAt: s(r.reversed_at), closedAt: s(r.closed_at),
    recordedByUserId: String(r.recorded_by_user_id),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

const FUNDING_COLS = [
  "lender_decision_id", "funding_method", "scheduled_at", "funded_at",
  "amount_scheduled", "amount_disbursed", "wire_fee", "transaction_reference",
  "confirmation_document_id", "status", "failure_reason", "reversal_reference",
  "reversed_at", "closed_at", "recorded_by_user_id",
];

export function insertFundingRecord(f: ExternalFundingRecord): void {
  getDb()
    .prepare(
      `INSERT INTO external_funding_records (id, organization_id, project_id, draw_request_id,
        ${FUNDING_COLS.join(", ")}, created_at, updated_at)
       VALUES (?, ?, ?, ?, ${FUNDING_COLS.map(() => "?").join(", ")}, ?, ?)`
    )
    .run(f.id, f.organizationId, f.projectId, f.drawRequestId,
      ...FUNDING_COLS.map((c) => (f as unknown as Row)[camel(c)] as never ?? null),
      f.createdAt, f.updatedAt);
}

export function getFundingRecord(id: string): ExternalFundingRecord | null {
  const r = getDb().prepare("SELECT * FROM external_funding_records WHERE id = ?").get(id);
  return r ? toFunding(r as Row) : null;
}

export function listFundingRecords(drawRequestId: string): ExternalFundingRecord[] {
  return getDb()
    .prepare("SELECT * FROM external_funding_records WHERE draw_request_id = ? ORDER BY created_at")
    .all(drawRequestId)
    .map((r) => toFunding(r as Row));
}

export function listFundingRecordsForProject(projectId: string): ExternalFundingRecord[] {
  return getDb()
    .prepare("SELECT * FROM external_funding_records WHERE project_id = ? ORDER BY created_at")
    .all(projectId)
    .map((r) => toFunding(r as Row));
}

export function updateFundingRecord(id: string, patch: Partial<ExternalFundingRecord>): void {
  const cur = getFundingRecord(id);
  if (!cur) return;
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  getDb()
    .prepare(
      `UPDATE external_funding_records SET ${FUNDING_COLS.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
    )
    .run(...FUNDING_COLS.map((c) => (next as unknown as Row)[camel(c)] as never ?? null), next.updatedAt, id);
}

// -------------------------------------------------- memberships

function toMembership(r: Row): ProjectMembership {
  return {
    id: String(r.id), projectId: String(r.project_id), userId: String(r.user_id),
    participantType: String(r.participant_type) as ProjectMembership["participantType"],
    capabilitySet: JSON.parse(String(r.capability_set ?? "[]")),
    effectiveFrom: s(r.effective_from), effectiveTo: s(r.effective_to),
    active: Boolean(r.active), assignedByUserId: String(r.assigned_by_user_id),
    createdAt: String(r.created_at),
  };
}

export function insertMembership(m: ProjectMembership): void {
  getDb()
    .prepare(
      `INSERT INTO project_memberships (id, project_id, user_id, participant_type,
        capability_set, effective_from, effective_to, active, assigned_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(m.id, m.projectId, m.userId, m.participantType, JSON.stringify(m.capabilitySet),
      m.effectiveFrom, m.effectiveTo, m.active ? 1 : 0, m.assignedByUserId, m.createdAt);
}

export function listMemberships(projectId: string): ProjectMembership[] {
  return getDb()
    .prepare("SELECT * FROM project_memberships WHERE project_id = ? ORDER BY created_at")
    .all(projectId)
    .map((r) => toMembership(r as Row));
}

export function listMembershipsForUser(userId: string): ProjectMembership[] {
  return getDb()
    .prepare("SELECT * FROM project_memberships WHERE user_id = ? ORDER BY created_at")
    .all(userId)
    .map((r) => toMembership(r as Row));
}

export function deactivateMembership(id: string, effectiveTo: string): void {
  getDb()
    .prepare("UPDATE project_memberships SET active = 0, effective_to = ? WHERE id = ?")
    .run(effectiveTo, id);
}

// -------------------------------------------------- lender policy

function toPolicy(r: Row): LenderDrawPolicy {
  return {
    id: String(r.id), organizationId: String(r.organization_id),
    projectId: s(r.project_id), version: Number(r.version),
    requiredDocumentTypes: JSON.parse(String(r.required_document_types ?? "[]")),
    requiredEvidence: s(r.required_evidence),
    independentInspectionRequired: Boolean(r.independent_inspection_required),
    governmentInspectionRequired: Boolean(r.government_inspection_required),
    maxDrawFrequencyDays: n(r.max_draw_frequency_days),
    minDrawAmount: n(r.min_draw_amount), retainagePct: n(r.retainage_pct),
    storedMaterialRule: s(r.stored_material_rule),
    offsiteMaterialRule: s(r.offsite_material_rule),
    changeOrderRule: s(r.change_order_rule),
    budgetTransferRule: s(r.budget_transfer_rule),
    lienWaiverRule: s(r.lien_waiver_rule), approvalLimit: n(r.approval_limit),
    reviewerHierarchy: s(r.reviewer_hierarchy),
    exceptionSeverityMap: s(r.exception_severity_map),
    mandatoryFundingConditions: JSON.parse(String(r.mandatory_funding_conditions ?? "[]")),
    turnaroundTargetDays: n(r.turnaround_target_days),
    borrowerCertification: s(r.borrower_certification),
    contractorCertification: s(r.contractor_certification),
    active: Boolean(r.active), configuredByUserId: String(r.configured_by_user_id),
    reason: s(r.reason), createdAt: String(r.created_at),
  };
}

export function insertLenderPolicy(p: LenderDrawPolicy): void {
  getDb()
    .prepare(
      `INSERT INTO lender_draw_policies (id, organization_id, project_id, version,
        required_document_types, required_evidence, independent_inspection_required,
        government_inspection_required, max_draw_frequency_days, min_draw_amount,
        retainage_pct, stored_material_rule, offsite_material_rule, change_order_rule,
        budget_transfer_rule, lien_waiver_rule, approval_limit, reviewer_hierarchy,
        exception_severity_map, mandatory_funding_conditions, turnaround_target_days,
        borrower_certification, contractor_certification, active,
        configured_by_user_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(p.id, p.organizationId, p.projectId, p.version,
      JSON.stringify(p.requiredDocumentTypes), p.requiredEvidence,
      p.independentInspectionRequired ? 1 : 0, p.governmentInspectionRequired ? 1 : 0,
      p.maxDrawFrequencyDays, p.minDrawAmount, p.retainagePct, p.storedMaterialRule,
      p.offsiteMaterialRule, p.changeOrderRule, p.budgetTransferRule, p.lienWaiverRule,
      p.approvalLimit, p.reviewerHierarchy, p.exceptionSeverityMap,
      JSON.stringify(p.mandatoryFundingConditions), p.turnaroundTargetDays,
      p.borrowerCertification, p.contractorCertification, p.active ? 1 : 0,
      p.configuredByUserId, p.reason, p.createdAt);
}

export function deactivatePolicies(organizationId: string, projectId: string | null): void {
  getDb()
    .prepare(
      "UPDATE lender_draw_policies SET active = 0 WHERE organization_id = ? AND project_id IS ?"
    )
    .run(organizationId, projectId);
}

/** The effective policy: active project override else active org default. */
export function getEffectivePolicy(organizationId: string, projectId: string): LenderDrawPolicy | null {
  const proj = getDb()
    .prepare(
      "SELECT * FROM lender_draw_policies WHERE organization_id = ? AND project_id = ? AND active = 1 ORDER BY version DESC LIMIT 1"
    )
    .get(organizationId, projectId);
  if (proj) return toPolicy(proj as Row);
  const org = getDb()
    .prepare(
      "SELECT * FROM lender_draw_policies WHERE organization_id = ? AND project_id IS NULL AND active = 1 ORDER BY version DESC LIMIT 1"
    )
    .get(organizationId);
  return org ? toPolicy(org as Row) : null;
}

export function getPolicy(id: string): LenderDrawPolicy | null {
  const r = getDb().prepare("SELECT * FROM lender_draw_policies WHERE id = ?").get(id);
  return r ? toPolicy(r as Row) : null;
}

export function listPolicies(organizationId: string): LenderDrawPolicy[] {
  return getDb()
    .prepare("SELECT * FROM lender_draw_policies WHERE organization_id = ? ORDER BY created_at")
    .all(organizationId)
    .map((r) => toPolicy(r as Row));
}

export function nextPolicyVersion(organizationId: string, projectId: string | null): number {
  const r = getDb()
    .prepare(
      "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM lender_draw_policies WHERE organization_id = ? AND project_id IS ?"
    )
    .get(organizationId, projectId) as Row;
  return Number(r.v);
}

// -------------------------------------------------- stage events

export function insertStageEvent(e: DrawStageEvent): void {
  getDb()
    .prepare(
      `INSERT INTO draw_stage_events (id, draw_request_id, prior_stage, new_stage,
        actor_user_id, reason, source_record_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.drawRequestId, e.priorStage, e.newStage, e.actorUserId, e.reason,
      e.sourceRecordId, e.createdAt);
}

export function listStageEvents(drawRequestId: string): DrawStageEvent[] {
  return getDb()
    .prepare("SELECT * FROM draw_stage_events WHERE draw_request_id = ? ORDER BY created_at")
    .all(drawRequestId)
    .map((r: Row) => ({
      id: String(r.id), drawRequestId: String(r.draw_request_id),
      priorStage: s(r.prior_stage) as DrawWorkflowStage | null,
      newStage: String(r.new_stage) as DrawWorkflowStage,
      actorUserId: s(r.actor_user_id), reason: s(r.reason),
      sourceRecordId: s(r.source_record_id), createdAt: String(r.created_at),
    }));
}

export function lastStageEvent(drawRequestId: string): DrawStageEvent | null {
  const events = listStageEvents(drawRequestId);
  return events.length > 0 ? events[events.length - 1] : null;
}

// ================= hardening: transactions, events, applications =================

import type { DrawPolicyApplication, LenderConditionEvent } from "../../shared/types";

/** Insert a decision, supersede priors (including any active PENDING), and
 *  insert its conditions AND their creation events in ONE transaction. The
 *  partial unique index idx_one_current_lender_decision turns concurrent
 *  races into a controlled UNIQUE-constraint failure. */
export function createDecisionTx(
  decision: LenderDrawDecision,
  conditions: LenderDecisionCondition[],
  supersedeIds: string[],
  conditionEvents: LenderConditionEvent[] = []
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    // The supersede UPDATE points priors at the NEW decision id before that
    // row is inserted (insert-first would instead trip the one-current
    // partial unique index). Defer FK enforcement to COMMIT so the forward
    // reference is validated once the whole transaction is consistent.
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const priorId of supersedeIds) {
      const res = db
        .prepare(
          "UPDATE lender_draw_decisions SET superseded_by_decision_id = ?, updated_at = ? WHERE id = ? AND superseded_by_decision_id IS NULL"
        )
        .run(decision.id, decision.updatedAt, priorId);
      if (res.changes !== 1) throw new Error("UNIQUE constraint: decision supersede conflict");
    }
    insertLenderDecision(decision);
    for (const c of conditions) insertDecisionCondition(c);
    for (const e of conditionEvents) insertConditionEvent(e);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Condition state change + its history event in ONE transaction. The
 *  guarded UPDATE (status must still be one of allowedPrior) makes a
 *  concurrent transition a controlled CONFLICT instead of a lost update or
 *  an event row that contradicts the stored state. */
export function updateConditionTx(
  conditionId: string,
  patch: {
    status: string;
    waiverReason: string | null;
    waivedByUserId: string | null;
    satisfiedByUserId: string | null;
    satisfiedAt: string | null;
    supportingDocumentId: string | null;
    updatedAt: string;
  },
  event: LenderConditionEvent,
  allowedPrior: string[]
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const placeholders = allowedPrior.map(() => "?").join(", ");
    const res = db
      .prepare(
        `UPDATE lender_decision_conditions
         SET status = ?, waiver_reason = ?, waived_by_user_id = ?, satisfied_by_user_id = ?,
             satisfied_at = ?, supporting_document_id = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`
      )
      .run(
        patch.status, patch.waiverReason, patch.waivedByUserId, patch.satisfiedByUserId,
        patch.satisfiedAt, patch.supportingDocumentId, patch.updatedAt,
        conditionId, ...allowedPrior
      );
    if (res.changes !== 1) throw new Error("CONFLICT: condition state changed concurrently");
    insertConditionEvent(event);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Party replacement in ONE transaction: end the displaced active
 *  assignment(s) with a guarded UPDATE (active must still be 1) and insert
 *  the successor. Concurrency produces one success + one CONFLICT — never
 *  two active holders or a silently dropped predecessor. */
export function replacePartyAssignmentTx(
  assignment: ProjectPartyAssignment,
  endIds: string[],
  endedAt: string
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of endIds) {
      const res = db
        .prepare("UPDATE project_party_assignments SET active = 0, effective_to = ? WHERE id = ? AND active = 1")
        .run(endedAt, id);
      if (res.changes !== 1) throw new Error("CONFLICT: party assignment changed concurrently");
    }
    insertPartyAssignment(assignment);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** One or more guarded inspection status transitions plus their events in
 *  ONE transaction. Each step's UPDATE requires the CURRENT stored status
 *  to be in step.from — a concurrent transition surfaces as CONFLICT, and
 *  no event row is ever committed without its state change. */
export function inspectionTransitionsTx(
  inspectionId: string,
  steps: Array<{ from: string[]; to: string; patch: Partial<DrawInspection> }>,
  events: Array<{ id: string; drawInspectionId: string; type: string; detail: string; actorUserId: string | null; createdAt: string }>
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of steps) {
      applyInspectionStep(db, inspectionId, step);
    }
    for (const e of events) {
      db.prepare(
        "INSERT INTO draw_inspection_events (id, draw_inspection_id, type, detail, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(e.id, e.drawInspectionId, e.type, e.detail, e.actorUserId, e.createdAt);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const INSPECTION_PATCH_COLS: Record<string, string> = {
  scheduledAt: "scheduled_at",
  completedAt: "completed_at",
  reportReceivedAt: "report_received_at",
  finalizedAt: "finalized_at",
  inspectorDisplayName: "inspector_display_name",
  inspectorContact: "inspector_contact",
  obvReviewStatus: "obv_review_status",
  obvReviewedByUserId: "obv_reviewed_by_user_id",
  lenderAcceptanceStatus: "lender_acceptance_status",
  lenderAcceptedByUserId: "lender_accepted_by_user_id",
  borrowerResponseStatus: "borrower_response_status",
  borrowerResponseNote: "borrower_response_note",
};

function applyInspectionStep(
  db: ReturnType<typeof getDb>,
  inspectionId: string,
  step: { from: string[]; to: string; patch: Partial<DrawInspection> }
): void {
  const sets: string[] = ["status = ?", "updated_at = ?"];
  const now = new Date().toISOString();
  const values: Array<string | null> = [step.to, now];
  for (const [key, col] of Object.entries(INSPECTION_PATCH_COLS)) {
    if (key in step.patch) {
      sets.push(`${col} = ?`);
      values.push((step.patch as Record<string, string | null>)[key] ?? null);
    }
  }
  const placeholders = step.from.map(() => "?").join(", ");
  const res = db
    .prepare(`UPDATE draw_inspections SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`)
    .run(...values, inspectionId, ...step.from);
  if (res.changes !== 1) {
    throw new Error(`CONFLICT: inspection is no longer ${step.from.join("/")}`);
  }
}

/** Report version creation + any inspection transitions + events in ONE
 *  transaction. The partial unique index idx_one_draft_report_version
 *  turns a concurrent duplicate draft into a UNIQUE-constraint failure
 *  inside the same transaction. */
export function createReportVersionTx(
  version: DrawInspectionReportVersion,
  steps: Array<{ from: string[]; to: string; patch: Partial<DrawInspection> }>,
  events: Array<{ id: string; drawInspectionId: string; type: string; detail: string; actorUserId: string | null; createdAt: string }>
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    insertReportVersion(version);
    for (const step of steps) applyInspectionStep(db, version.drawInspectionId, step);
    for (const e of events) {
      db.prepare(
        "INSERT INTO draw_inspection_events (id, draw_inspection_id, type, detail, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(e.id, e.drawInspectionId, e.type, e.detail, e.actorUserId, e.createdAt);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Report finalization + inspection transitions + events in ONE
 *  transaction: prior FINALIZED versions become SUPERSEDED (immutable
 *  history, chain intact), the guarded version UPDATE (must still be
 *  DRAFT) flips the draft to FINALIZED, and the inspection state machine
 *  plus the audit events commit or roll back with it as a unit. */
export function finalizeReportLifecycleTx(
  versionId: string,
  finalizedByUserId: string,
  finalizedAt: string,
  inspectionId: string,
  steps: Array<{ from: string[]; to: string; patch: Partial<DrawInspection> }>,
  events: Array<{ id: string; drawInspectionId: string; type: string; detail: string; actorUserId: string | null; createdAt: string }>
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE draw_inspection_report_versions SET status = 'SUPERSEDED'
       WHERE draw_inspection_id = ? AND status = 'FINALIZED'`
    ).run(inspectionId);
    const res = db
      .prepare(
        "UPDATE draw_inspection_report_versions SET status = 'FINALIZED', finalized_by_user_id = ?, finalized_at = ? WHERE id = ? AND status = 'DRAFT'"
      )
      .run(finalizedByUserId, finalizedAt, versionId);
    if (res.changes !== 1) throw new Error("CONFLICT: only a draft version can be finalized");
    for (const step of steps) applyInspectionStep(db, inspectionId, step);
    for (const e of events) {
      db.prepare(
        "INSERT INTO draw_inspection_events (id, draw_inspection_id, type, detail, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(e.id, e.drawInspectionId, e.type, e.detail, e.actorUserId, e.createdAt);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Inspection creation + its REQUESTED event in ONE transaction. */
export function createDrawInspectionTx(
  inspection: DrawInspection,
  event: { id: string; drawInspectionId: string; type: string; detail: string; actorUserId: string | null; createdAt: string }
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    insertDrawInspection(inspection);
    db.prepare(
      "INSERT INTO draw_inspection_events (id, draw_inspection_id, type, detail, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(event.id, event.drawInspectionId, event.type, event.detail, event.actorUserId, event.createdAt);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Line finding + its event in ONE transaction (duplicate findings surface
 *  as the UNIQUE failure of idx_inspection_line_unique inside the tx). */
export function insertInspectionLineTx(
  line: DrawInspectionLine,
  event: { id: string; drawInspectionId: string; type: string; detail: string; actorUserId: string | null; createdAt: string }
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    insertInspectionLine(line);
    db.prepare(
      "INSERT INTO draw_inspection_events (id, draw_inspection_id, type, detail, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(event.id, event.drawInspectionId, event.type, event.detail, event.actorUserId, event.createdAt);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Non-status inspection field update + event in ONE transaction (e.g. an
 *  OBV review outcome that does not move the status machine). */
export function updateInspectionFieldsTx(
  inspectionId: string,
  patch: Partial<DrawInspection>,
  event: { id: string; drawInspectionId: string; type: string; detail: string; actorUserId: string | null; createdAt: string },
  allowedStatuses: string[]
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const sets: string[] = ["updated_at = ?"];
    const values: Array<string | null> = [new Date().toISOString()];
    for (const [key, col] of Object.entries(INSPECTION_PATCH_COLS)) {
      if (key in patch) {
        sets.push(`${col} = ?`);
        values.push((patch as Record<string, string | null>)[key] ?? null);
      }
    }
    // Guarded: the caller's status precondition is re-checked INSIDE the
    // transaction so fields and their event can never contradict a
    // concurrently-changed inspection state.
    const placeholders = allowedStatuses.map(() => "?").join(", ");
    const res = db
      .prepare(`UPDATE draw_inspections SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`)
      .run(...values, inspectionId, ...allowedStatuses);
    if (res.changes !== 1) throw new Error("CONFLICT: inspection state changed concurrently");
    db.prepare(
      "INSERT INTO draw_inspection_events (id, draw_inspection_id, type, detail, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(event.id, event.drawInspectionId, event.type, event.detail, event.actorUserId, event.createdAt);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function insertConditionEvent(e: LenderConditionEvent): void {
  getDb()
    .prepare(
      "INSERT INTO lender_condition_events (id, condition_id, prior_status, new_status, reason, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(e.id, e.conditionId, e.priorStatus, e.newStatus, e.reason, e.actorUserId, e.createdAt);
}

export function listConditionEvents(conditionId: string): LenderConditionEvent[] {
  return getDb()
    .prepare("SELECT * FROM lender_condition_events WHERE condition_id = ? ORDER BY created_at")
    .all(conditionId)
    .map((r: Row) => ({
      id: String(r.id), conditionId: String(r.condition_id),
      priorStatus: s(r.prior_status), newStatus: String(r.new_status),
      reason: s(r.reason), actorUserId: s(r.actor_user_id), createdAt: String(r.created_at),
    }));
}

/** Reinspection: flag the prior, insert the child AND both lifecycle
 *  events atomically. The conditional UPDATE plus
 *  idx_draw_reinspection_single_child guarantee one success / one
 *  controlled conflict under concurrency. */
export function createDrawReinspectionTx(
  child: DrawInspection,
  priorId: string,
  events: Array<{ id: string; drawInspectionId: string; type: string; detail: string; actorUserId: string | null; createdAt: string }> = []
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const res = db
      .prepare(
        `UPDATE draw_inspections SET status = 'REINSPECTION_REQUIRED', updated_at = ?
         WHERE id = ? AND status IN ('FINALIZED', 'FAILED', 'CORRECTION_REQUIRED')`
      )
      .run(child.createdAt, priorId);
    if (res.changes !== 1) throw new Error("UNIQUE constraint: prior inspection not eligible for reinspection");
    insertDrawInspection(child);
    for (const e of events) {
      db.prepare(
        "INSERT INTO draw_inspection_events (id, draw_inspection_id, type, detail, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(e.id, e.drawInspectionId, e.type, e.detail, e.actorUserId, e.createdAt);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Ownership/servicing: append the event and move the pointer atomically. */
export function recordLoanTransferTx(
  kind: "ownership" | "servicing",
  event: LoanOwnershipEvent | LoanServicingEvent,
  loanAssetId: string,
  newOrgId: string
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (kind === "ownership") insertLoanOwnershipEvent(event as LoanOwnershipEvent);
    else insertLoanServicingEvent(event as LoanServicingEvent);
    const col = kind === "ownership" ? "current_loan_owner_organization_id" : "current_servicer_organization_id";
    db.prepare(`UPDATE loan_assets SET ${col} = ?, updated_at = ? WHERE id = ?`)
      .run(newOrgId, event.createdAt, loanAssetId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Policy versioning: deactivate priors and insert the new version in one
 *  transaction. */
export function createPolicyVersionTx(policy: LenderDrawPolicy): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE lender_draw_policies SET active = 0 WHERE organization_id = ? AND project_id IS ?")
      .run(policy.organizationId, policy.projectId);
    insertLenderPolicy(policy);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function insertPolicyApplication(a: DrawPolicyApplication): void {
  getDb()
    .prepare(
      "INSERT INTO draw_policy_applications (id, draw_request_id, policy_id, policy_version, applied_at, source) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(a.id, a.drawRequestId, a.policyId, a.policyVersion, a.appliedAt, a.source);
}

export function getPolicyApplication(drawRequestId: string): DrawPolicyApplication | null {
  const r = getDb()
    .prepare("SELECT * FROM draw_policy_applications WHERE draw_request_id = ?")
    .get(drawRequestId);
  if (!r) return null;
  const row = r as Row;
  return {
    id: String(row.id), drawRequestId: String(row.draw_request_id),
    policyId: String(row.policy_id), policyVersion: Number(row.policy_version),
    appliedAt: String(row.applied_at), source: String(row.source),
  };
}

/** Cumulative non-reversed external disbursements for a draw (tx helper). */
export function disbursedTotal(drawRequestId: string): number {
  const r = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_disbursed), 0) AS total
       FROM external_funding_records
       WHERE draw_request_id = ? AND status IN ('DISBURSED', 'CLOSED') AND reversed_at IS NULL`
    )
    .get(drawRequestId) as Row;
  return Number(r.total);
}

/** Funding transition inside one transaction, guarded on the OBSERVED
 *  prior status (optimistic concurrency: a concurrent transition surfaces
 *  as CONFLICT — never a double-applied status or a lost update) and with
 *  the cumulative-cap check for disbursements. */
export function transitionFundingTx(
  id: string,
  expectedStatus: string,
  patch: Partial<ExternalFundingRecord>,
  cap: { approvedAmount: number | null; drawRequestId: string } | null
): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT status FROM external_funding_records WHERE id = ?").get(id) as
      | { status: string }
      | undefined;
    if (!row || row.status !== expectedStatus) {
      throw new Error("CONFLICT: funding record transitioned concurrently");
    }
    if (patch.status === "DISBURSED" && cap && cap.approvedAmount !== null) {
      const already = disbursedTotal(cap.drawRequestId);
      const amount = patch.amountDisbursed ?? 0;
      if (already + amount > cap.approvedAmount) {
        throw new Error(
          `CAP: cumulative disbursements (${already + amount}) would exceed the lender-approved amount (${cap.approvedAmount})`
        );
      }
    }
    updateFundingRecord(id, patch);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
