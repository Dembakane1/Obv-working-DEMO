/**
 * Portfolio Intelligence read layer.
 *
 * Every function here (except the two snapshot writers at the bottom) is a
 * plain SELECT over the verified primary records owned by the existing
 * repositories. This module NEVER updates, deletes, or inserts into any
 * pre-existing table: the only write surface in the whole portfolio layer
 * is the append-only portfolio_snapshots table, and the government
 * foundation tables have no write path at all (architecture only).
 *
 * Rows are narrowed to the columns analytics actually needs; tenancy
 * filtering happens in the service layer against authz.accessibleProjectIds
 * so the same-404 doctrine stays in exactly one place.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./index";

type Row = Record<string, unknown>;

export function newId(): string {
  return randomUUID();
}

const s = (v: unknown): string => String(v);
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number => Number(v ?? 0);
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const b = (v: unknown): boolean => Boolean(v);

// ---------------------------------------------------------------- entities

export interface OrgRow {
  id: string;
  name: string;
  kind: string;
  country: string | null;
  region: string | null;
}

export function organizationRows(): OrgRow[] {
  return getDb()
    .prepare("SELECT id, name, kind, country, region FROM organizations")
    .all()
    .map((r) => {
      const x = r as Row;
      return { id: s(x.id), name: s(x.name), kind: s(x.kind), country: sn(x.country), region: sn(x.region) };
    });
}

export interface UserRow {
  id: string;
  organizationId: string;
  name: string;
  role: string;
  title: string;
}

export function userRows(): UserRow[] {
  return getDb()
    .prepare("SELECT id, organization_id, name, role, title FROM users")
    .all()
    .map((r) => {
      const x = r as Row;
      return { id: s(x.id), organizationId: s(x.organization_id), name: s(x.name), role: s(x.role), title: s(x.title) };
    });
}

// ---------------------------------------------------------------- projects

export interface MilestoneRow {
  id: string;
  projectId: string;
  seq: number;
  title: string;
  trancheAmount: number;
  status: string;
  accountStatus: string;
  plannedStart: string | null;
  plannedEnd: string | null;
  weight: number | null;
  archived: boolean;
}

export function milestoneRows(): MilestoneRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, seq, title, tranche_amount, status, account_status,
              planned_start, planned_end, weight, archived
         FROM milestones`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        seq: n(x.seq),
        title: s(x.title),
        trancheAmount: n(x.tranche_amount),
        status: s(x.status),
        accountStatus: s(x.account_status),
        plannedStart: sn(x.planned_start),
        plannedEnd: sn(x.planned_end),
        weight: nn(x.weight),
        archived: b(x.archived),
      };
    });
}

export interface DrawRow {
  id: string;
  projectId: string;
  organizationId: string;
  requestedByOrganizationId: string | null;
  drawNumber: number;
  submittedAt: string | null;
  requestedAmount: number;
  approvedAmount: number | null;
  status: string;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

export function drawRows(): DrawRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, organization_id, requested_by_organization_id, draw_number,
              submitted_at, requested_amount, approved_amount, status, period_start,
              period_end, created_at, updated_at
         FROM draw_requests`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        organizationId: s(x.organization_id),
        requestedByOrganizationId: sn(x.requested_by_organization_id),
        drawNumber: n(x.draw_number),
        submittedAt: sn(x.submitted_at),
        requestedAmount: n(x.requested_amount),
        approvedAmount: nn(x.approved_amount),
        status: s(x.status),
        periodStart: sn(x.period_start),
        periodEnd: sn(x.period_end),
        createdAt: s(x.created_at),
        updatedAt: s(x.updated_at),
      };
    });
}

export interface DrawLineRow {
  id: string;
  drawRequestId: string;
  budgetLineId: string | null;
  milestoneId: string | null;
  currentRequested: number;
  supportedAmount: number | null;
  percentClaimed: number | null;
  percentVerified: number | null;
  status: string;
}

export function drawLineRows(): DrawLineRow[] {
  return getDb()
    .prepare(
      `SELECT id, draw_request_id, budget_line_id, milestone_id, current_requested,
              supported_amount, percent_complete_claimed, percent_complete_verified, status
         FROM draw_line_items`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        drawRequestId: s(x.draw_request_id),
        budgetLineId: sn(x.budget_line_id),
        milestoneId: sn(x.milestone_id),
        currentRequested: n(x.current_requested),
        supportedAmount: nn(x.supported_amount),
        percentClaimed: nn(x.percent_complete_claimed),
        percentVerified: nn(x.percent_complete_verified),
        status: s(x.status),
      };
    });
}

export interface DrawDocumentRow {
  id: string;
  drawRequestId: string;
  lineItemId: string | null;
  docType: string;
  status: string;
  vendor: string | null;
  invoiceNumber: string | null;
  amount: number | null;
  receivedAt: string;
  reviewedAt: string | null;
  expiresAt: string | null;
}

export function drawDocumentRows(): DrawDocumentRow[] {
  return getDb()
    .prepare(
      `SELECT id, draw_request_id, line_item_id, doc_type, status, vendor, invoice_number,
              amount, received_at, reviewed_at, expires_at
         FROM draw_documents`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        drawRequestId: s(x.draw_request_id),
        lineItemId: sn(x.line_item_id),
        docType: s(x.doc_type),
        status: s(x.status),
        vendor: sn(x.vendor),
        invoiceNumber: sn(x.invoice_number),
        amount: nn(x.amount),
        receivedAt: s(x.received_at),
        reviewedAt: sn(x.reviewed_at),
        expiresAt: sn(x.expires_at),
      };
    });
}

export interface LenderDecisionRow {
  id: string;
  projectId: string;
  drawRequestId: string;
  decision: string;
  requestedAmount: number;
  approvedAmount: number | null;
  decisionAt: string | null;
  reviewerUserId: string;
  createdAt: string;
  /** The lender's recorded justification, when one was required. */
  exceptionsAccepted: string | null;
  decisionReason: string | null;
}

/** Current (non-superseded) lender decisions only. */
export function lenderDecisionRows(): LenderDecisionRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, draw_request_id, decision, requested_amount, approved_amount,
              decision_at, reviewer_user_id, created_at, exceptions_accepted, decision_reason
         FROM lender_draw_decisions
        WHERE superseded_by_decision_id IS NULL
        ORDER BY created_at ASC`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        drawRequestId: s(x.draw_request_id),
        decision: s(x.decision),
        requestedAmount: n(x.requested_amount),
        approvedAmount: nn(x.approved_amount),
        decisionAt: sn(x.decision_at),
        reviewerUserId: s(x.reviewer_user_id),
        createdAt: s(x.created_at),
        exceptionsAccepted: sn(x.exceptions_accepted),
        decisionReason: sn(x.decision_reason),
      };
    });
}

export interface ApprovalRow {
  id: string;
  subjectType: string;
  status: string;
  createdAt: string;
  milestoneId: string | null;
  drawRequestId: string | null;
  /** Owning project resolved through whichever subject pointer is set
   *  (milestone, draw, change order, or retainage release). */
  projectId: string | null;
  decidedAt: string | null;
}

export function approvalRows(): ApprovalRow[] {
  return getDb()
    .prepare(
      `SELECT ar.id, ar.subject_type, ar.status, ar.created_at, ar.milestone_id, ar.draw_request_id,
              COALESCE(
                (SELECT m.project_id FROM milestones m WHERE m.id = ar.milestone_id),
                (SELECT d.project_id FROM draw_requests d WHERE d.id = ar.draw_request_id),
                (SELECT c.project_id FROM change_orders c WHERE c.id = ar.change_order_id),
                (SELECT rr.project_id FROM retainage_release_requests rr WHERE rr.id = ar.retainage_release_id)
              ) AS project_id,
              (SELECT MAX(rec.created_at) FROM approval_records rec
                WHERE rec.approval_request_id = ar.id) AS decided_at
         FROM approval_requests ar`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        subjectType: s(x.subject_type),
        status: s(x.status),
        createdAt: s(x.created_at),
        milestoneId: sn(x.milestone_id),
        drawRequestId: sn(x.draw_request_id),
        projectId: sn(x.project_id),
        decidedAt: sn(x.decided_at),
      };
    });
}

export interface ExceptionRow {
  id: string;
  projectId: string;
  category: string;
  severity: string;
  status: string;
  sourceType: string;
  drawRequestId: string | null;
  openedAt: string;
  resolvedAt: string | null;
  dueAt: string | null;
}

export function exceptionRows(): ExceptionRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, category, severity, status, source_type, draw_request_id,
              opened_at, resolved_at, due_at
         FROM exceptions`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        category: s(x.category),
        severity: s(x.severity),
        status: s(x.status),
        sourceType: s(x.source_type),
        drawRequestId: sn(x.draw_request_id),
        openedAt: s(x.opened_at),
        resolvedAt: sn(x.resolved_at),
        dueAt: sn(x.due_at),
      };
    });
}

export interface DisputeRow {
  id: string;
  projectId: string;
  status: string;
  disputedAmount: number;
  legalHold: boolean;
  drawRequestId: string | null;
  openedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
}

export function disputeRows(): DisputeRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, status, disputed_amount, legal_hold, draw_request_id,
              opened_at, resolved_at, closed_at
         FROM disputes`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        status: s(x.status),
        disputedAmount: n(x.disputed_amount),
        legalHold: b(x.legal_hold),
        drawRequestId: sn(x.draw_request_id),
        openedAt: s(x.opened_at),
        resolvedAt: sn(x.resolved_at),
        closedAt: sn(x.closed_at),
      };
    });
}

export interface PermitRow {
  id: string;
  projectId: string;
  permitType: string;
  jurisdiction: string | null;
  issuingAuthority: string | null;
  status: string;
  issuedAt: string | null;
  expiresAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export function permitRows(): PermitRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, permit_type, jurisdiction, issuing_authority, status,
              issued_at, expires_at, closed_at, created_at
         FROM permits`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        permitType: s(x.permit_type),
        jurisdiction: sn(x.jurisdiction),
        issuingAuthority: sn(x.issuing_authority),
        status: s(x.status),
        issuedAt: sn(x.issued_at),
        expiresAt: sn(x.expires_at),
        closedAt: sn(x.closed_at),
        createdAt: s(x.created_at),
      };
    });
}

export interface JurisdictionProfileRow {
  projectId: string;
  state: string | null;
  countyOrCity: string | null;
  jurisdictionName: string | null;
  permitAuthority: string | null;
}

export function jurisdictionProfileRows(): JurisdictionProfileRow[] {
  return getDb()
    .prepare(
      `SELECT project_id, state, county_or_city, jurisdiction_name, permit_authority
         FROM jurisdiction_profiles`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        projectId: s(x.project_id),
        state: sn(x.state),
        countyOrCity: sn(x.county_or_city),
        jurisdictionName: sn(x.jurisdiction_name),
        permitAuthority: sn(x.permit_authority),
      };
    });
}

export interface DrawInspectionRow {
  id: string;
  projectId: string;
  drawRequestId: string;
  companyOrganizationId: string | null;
  inspectorUserId: string | null;
  inspectorDisplayName: string | null;
  requestedAt: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  reportReceivedAt: string | null;
  status: string;
  reinspectionOfInspectionId: string | null;
}

export function drawInspectionRows(): DrawInspectionRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, draw_request_id, inspection_company_organization_id,
              inspector_user_id, inspector_display_name, requested_at, scheduled_at,
              completed_at, report_received_at, status, reinspection_of_inspection_id
         FROM draw_inspections`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        drawRequestId: s(x.draw_request_id),
        companyOrganizationId: sn(x.inspection_company_organization_id),
        inspectorUserId: sn(x.inspector_user_id),
        inspectorDisplayName: sn(x.inspector_display_name),
        requestedAt: sn(x.requested_at),
        scheduledAt: sn(x.scheduled_at),
        completedAt: sn(x.completed_at),
        reportReceivedAt: sn(x.report_received_at),
        status: s(x.status),
        reinspectionOfInspectionId: sn(x.reinspection_of_inspection_id),
      };
    });
}

export interface JurisdictionalInspectionRow {
  id: string;
  projectId: string;
  milestoneId: string;
  jurisdiction: string | null;
  status: string;
  result: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  governmentInspectorName: string | null;
  reinspectionOfInspectionId: string | null;
  correctionDueAt: string | null;
  correctionClearedAt: string | null;
}

export function jurisdictionalInspectionRows(): JurisdictionalInspectionRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, milestone_id, jurisdiction, status, result, scheduled_at,
              completed_at, government_inspector_name, reinspection_of_inspection_id,
              correction_due_at, correction_cleared_at
         FROM jurisdictional_inspections`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        milestoneId: s(x.milestone_id),
        jurisdiction: sn(x.jurisdiction),
        status: s(x.status),
        result: sn(x.result),
        scheduledAt: sn(x.scheduled_at),
        completedAt: sn(x.completed_at),
        governmentInspectorName: sn(x.government_inspector_name),
        reinspectionOfInspectionId: sn(x.reinspection_of_inspection_id),
        correctionDueAt: sn(x.correction_due_at),
        correctionClearedAt: sn(x.correction_cleared_at),
      };
    });
}

export interface LineRequirementRow {
  id: string;
  projectId: string;
  inspectionType: string;
  status: string;
  scheduledDate: string | null;
  completedDate: string | null;
  reinspectionRequired: boolean;
}

export function lineRequirementRows(): LineRequirementRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, inspection_type, status, scheduled_date, completed_date,
              reinspection_required
         FROM line_inspection_requirements`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        inspectionType: s(x.inspection_type),
        status: s(x.status),
        scheduledDate: sn(x.scheduled_date),
        completedDate: sn(x.completed_date),
        reinspectionRequired: b(x.reinspection_required),
      };
    });
}

export interface LienWaiverRow {
  id: string;
  projectId: string;
  drawRequestId: string;
  supplierOrganizationId: string | null;
  signingParty: string | null;
  status: string;
  relatedAmount: number | null;
  requestedAt: string | null;
  receivedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
}

export function lienWaiverRows(): LienWaiverRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, draw_request_id, contractor_or_supplier_organization_id,
              signing_party, status, related_amount, requested_at, received_at,
              accepted_at, rejected_at
         FROM lien_waiver_records`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        drawRequestId: s(x.draw_request_id),
        supplierOrganizationId: sn(x.contractor_or_supplier_organization_id),
        signingParty: sn(x.signing_party),
        status: s(x.status),
        relatedAmount: nn(x.related_amount),
        requestedAt: sn(x.requested_at),
        receivedAt: sn(x.received_at),
        acceptedAt: sn(x.accepted_at),
        rejectedAt: sn(x.rejected_at),
      };
    });
}

export interface FundingRow {
  id: string;
  projectId: string;
  drawRequestId: string;
  status: string;
  amountScheduled: number | null;
  amountDisbursed: number | null;
  scheduledAt: string | null;
  fundedAt: string | null;
}

export function fundingRows(): FundingRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, draw_request_id, status, amount_scheduled, amount_disbursed,
              scheduled_at, funded_at
         FROM external_funding_records`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        drawRequestId: s(x.draw_request_id),
        status: s(x.status),
        amountScheduled: nn(x.amount_scheduled),
        amountDisbursed: nn(x.amount_disbursed),
        scheduledAt: sn(x.scheduled_at),
        fundedAt: sn(x.funded_at),
      };
    });
}

export interface LoanAssetRow {
  id: string;
  projectId: string;
  lenderOrganizationId: string | null;
  borrowerOrganizationId: string | null;
  primaryContractorOrganizationId: string | null;
  originalLoanAmount: number | null;
  currentLoanAmount: number | null;
  status: string;
  riskLevel: string;
  closingDate: string | null;
  estimatedConstructionCompletionDate: string | null;
}

export function loanAssetRows(): LoanAssetRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, lender_organization_id, borrower_organization_id,
              primary_contractor_organization_id, original_loan_amount, current_loan_amount,
              status, risk_level, closing_date, estimated_construction_completion_date
         FROM loan_assets`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        lenderOrganizationId: sn(x.lender_organization_id),
        borrowerOrganizationId: sn(x.borrower_organization_id),
        primaryContractorOrganizationId: sn(x.primary_contractor_organization_id),
        originalLoanAmount: nn(x.original_loan_amount),
        currentLoanAmount: nn(x.current_loan_amount),
        status: s(x.status),
        riskLevel: s(x.risk_level),
        closingDate: sn(x.closing_date),
        estimatedConstructionCompletionDate: sn(x.estimated_construction_completion_date),
      };
    });
}

export interface PartyAssignmentRow {
  projectId: string;
  partyOrganizationId: string;
  partyType: string;
  active: boolean;
}

export function partyAssignmentRows(): PartyAssignmentRow[] {
  return getDb()
    .prepare(
      `SELECT project_id, party_organization_id, party_type, active
         FROM project_party_assignments`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        projectId: s(x.project_id),
        partyOrganizationId: s(x.party_organization_id),
        partyType: s(x.party_type),
        active: b(x.active),
      };
    });
}

export interface MembershipRow {
  projectId: string;
  userId: string;
  participantType: string;
  active: boolean;
}

export function membershipRows(): MembershipRow[] {
  return getDb()
    .prepare(
      `SELECT project_id, user_id, participant_type, active FROM project_memberships`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        projectId: s(x.project_id),
        userId: s(x.user_id),
        participantType: s(x.participant_type),
        active: b(x.active),
      };
    });
}

export interface BudgetLineRow {
  id: string;
  projectId: string;
  code: string;
  category: string;
  originalBudget: number;
  approvedChanges: number;
  committedAmount: number | null;
  paidToDate: number;
  retainageHeld: number | null;
  active: boolean;
}

export function budgetLineRows(): BudgetLineRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, code, category, original_budget, approved_changes,
              committed_amount, paid_to_date, retainage_held, active
         FROM budget_lines`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        code: s(x.code),
        category: s(x.category),
        originalBudget: n(x.original_budget),
        approvedChanges: n(x.approved_changes),
        committedAmount: nn(x.committed_amount),
        paidToDate: n(x.paid_to_date),
        retainageHeld: nn(x.retainage_held),
        active: b(x.active),
      };
    });
}

export interface ChangeOrderRow {
  id: string;
  projectId: string;
  status: string;
  reasonCategory: string;
  requestedAmount: number;
  approvedAmount: number | null;
  scheduleImpactDays: number | null;
  requestedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
}

export function changeOrderRows(): ChangeOrderRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, status, reason_category, requested_amount, approved_amount,
              schedule_impact_days, requested_at, applied_at, created_at
         FROM change_orders`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        status: s(x.status),
        reasonCategory: s(x.reason_category),
        requestedAmount: n(x.requested_amount),
        approvedAmount: nn(x.approved_amount),
        scheduleImpactDays: nn(x.schedule_impact_days),
        requestedAt: sn(x.requested_at),
        appliedAt: sn(x.applied_at),
        createdAt: s(x.created_at),
      };
    });
}

export interface CtcRow {
  projectId: string;
  budgetLineId: string;
  estimatedCostToComplete: number;
  estimateDate: string;
  confidence: string;
}

/** Latest cost-to-complete estimate per budget line (append-only source).
 *  rowid breaks created_at ties so a line never yields two "latest" rows. */
export function latestCtcRows(): CtcRow[] {
  return getDb()
    .prepare(
      `SELECT c.project_id, c.budget_line_id, c.estimated_cost_to_complete,
              c.estimate_date, c.confidence
         FROM cost_to_complete_estimates c
        WHERE c.rowid = (
          SELECT c2.rowid FROM cost_to_complete_estimates c2
           WHERE c2.budget_line_id = c.budget_line_id
           ORDER BY c2.created_at DESC, c2.rowid DESC LIMIT 1
        )`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        projectId: s(x.project_id),
        budgetLineId: s(x.budget_line_id),
        estimatedCostToComplete: n(x.estimated_cost_to_complete),
        estimateDate: s(x.estimate_date),
        confidence: s(x.confidence),
      };
    });
}

export interface EvidenceStatRow {
  milestoneId: string;
  total: number;
  fallbackCount: number;
  lastCapturedAt: string | null;
}

export function evidenceStatRows(): EvidenceStatRow[] {
  return getDb()
    .prepare(
      `SELECT milestone_id, COUNT(*) AS total, SUM(is_demo_fallback) AS fallback_count,
              MAX(captured_at) AS last_captured_at
         FROM evidence_items GROUP BY milestone_id`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        milestoneId: s(x.milestone_id),
        total: n(x.total),
        fallbackCount: n(x.fallback_count),
        lastCapturedAt: sn(x.last_captured_at),
      };
    });
}

export interface VerificationStatRow {
  milestoneId: string;
  verified: number;
  needsReview: number;
  rejected: number;
}

export function verificationStatRows(): VerificationStatRow[] {
  return getDb()
    .prepare(
      `SELECT e.milestone_id AS milestone_id,
              SUM(CASE WHEN v.verdict = 'VERIFIED' THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN v.verdict = 'NEEDS_REVIEW' THEN 1 ELSE 0 END) AS needs_review,
              SUM(CASE WHEN v.verdict = 'REJECTED' THEN 1 ELSE 0 END) AS rejected
         FROM verifications v
         JOIN evidence_items e ON e.id = v.evidence_item_id
        GROUP BY e.milestone_id`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        milestoneId: s(x.milestone_id),
        verified: n(x.verified),
        needsReview: n(x.needs_review),
        rejected: n(x.rejected),
      };
    });
}

export interface DuplicateEvidenceRow {
  hash: string;
  count: number;
  milestoneIds: string;
}

/** Evidence content hashes appearing on more than one evidence item. */
export function duplicateEvidenceRows(): DuplicateEvidenceRow[] {
  return getDb()
    .prepare(
      `SELECT hash, COUNT(*) AS count, GROUP_CONCAT(DISTINCT milestone_id) AS milestone_ids
         FROM evidence_items GROUP BY hash HAVING COUNT(*) > 1`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return { hash: s(x.hash), count: n(x.count), milestoneIds: s(x.milestone_ids) };
    });
}

export interface AccountEventRow {
  milestoneId: string;
  projectId: string;
  type: string;
  amount: number;
  createdAt: string;
}

export function accountEventRows(): AccountEventRow[] {
  return getDb()
    .prepare(
      `SELECT v.milestone_id, m.project_id, v.type, v.amount, v.created_at
         FROM virtual_account_events v JOIN milestones m ON m.id = v.milestone_id`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        milestoneId: s(x.milestone_id),
        projectId: s(x.project_id),
        type: s(x.type),
        amount: n(x.amount),
        createdAt: s(x.created_at),
      };
    });
}

export interface DrawAccountEventRow {
  drawRequestId: string;
  projectId: string;
  type: string;
  amount: number;
  createdAt: string;
}

export function drawAccountEventRows(): DrawAccountEventRow[] {
  return getDb()
    .prepare(
      `SELECT e.draw_request_id, d.project_id, e.type, e.amount, e.created_at
         FROM draw_account_events e JOIN draw_requests d ON d.id = e.draw_request_id`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        drawRequestId: s(x.draw_request_id),
        projectId: s(x.project_id),
        type: s(x.type),
        amount: n(x.amount),
        createdAt: s(x.created_at),
      };
    });
}

export interface FieldIssueRow {
  id: string;
  projectId: string;
  category: string;
  severity: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  dueAt: string | null;
}

export function fieldIssueRows(): FieldIssueRow[] {
  return getDb()
    .prepare(
      `SELECT id, project_id, category, severity, status, created_at, resolved_at, due_at
         FROM field_issues`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        projectId: s(x.project_id),
        category: s(x.category),
        severity: s(x.severity),
        status: s(x.status),
        createdAt: s(x.created_at),
        resolvedAt: sn(x.resolved_at),
        dueAt: sn(x.due_at),
      };
    });
}

export interface PermitBasisRow {
  projectId: string;
  permitId: string;
  status: string;
  governingBasis: string;
  expirationDate: string | null;
  version: number;
}

export function permitBasisRows(): PermitBasisRow[] {
  return getDb()
    .prepare(
      `SELECT project_id, permit_id, status, governing_basis, expiration_date, version
         FROM permit_basis_versions`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        projectId: s(x.project_id),
        permitId: s(x.permit_id),
        status: s(x.status),
        governingBasis: s(x.governing_basis),
        expirationDate: sn(x.expiration_date),
        version: n(x.version),
      };
    });
}

export interface SourceVerificationRow {
  projectId: string;
  resultStatus: string;
  lookupAt: string;
  nextReviewDate: string | null;
}

export function sourceVerificationRows(): SourceVerificationRow[] {
  return getDb()
    .prepare(
      `SELECT project_id, result_status, lookup_at, next_review_date FROM source_verifications`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        projectId: s(x.project_id),
        resultStatus: s(x.result_status),
        lookupAt: s(x.lookup_at),
        nextReviewDate: sn(x.next_review_date),
      };
    });
}

export interface PaymentInstructionRow {
  drawRequestId: string;
  status: string;
  amount: number;
  requestedAt: string;
  settledAt: string | null;
}

export function paymentInstructionRows(): PaymentInstructionRow[] {
  return getDb()
    .prepare(
      `SELECT draw_request_id, status, amount, requested_at, settled_at FROM payment_instructions`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        drawRequestId: s(x.draw_request_id),
        status: s(x.status),
        amount: n(x.amount),
        requestedAt: s(x.requested_at),
        settledAt: sn(x.settled_at),
      };
    });
}

// ----------------------------------------------------- portfolio snapshots

export interface PortfolioSnapshotRow {
  id: string;
  scopeOrganizationId: string;
  takenByUserId: string;
  takenAt: string;
  projectCount: number;
  activeProjectCount: number;
  totalBudget: number;
  totalReleased: number;
  totalPaidToDate: number;
  openExceptionCount: number;
  openDisputeCount: number;
  averageHealth: number;
  attentionCount: number;
  detail: Record<string, unknown>;
}

/**
 * Append one derived portfolio observation. This is the ONLY insert in the
 * portfolio layer and the table is append-only: no update or delete
 * function exists in this module or anywhere else.
 */
export function insertPortfolioSnapshot(row: PortfolioSnapshotRow): void {
  getDb()
    .prepare(
      `INSERT INTO portfolio_snapshots (
         id, scope_organization_id, taken_by_user_id, taken_at, project_count,
         active_project_count, total_budget, total_released, total_paid_to_date,
         open_exception_count, open_dispute_count, average_health, attention_count, detail
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.scopeOrganizationId,
      row.takenByUserId,
      row.takenAt,
      row.projectCount,
      row.activeProjectCount,
      row.totalBudget,
      row.totalReleased,
      row.totalPaidToDate,
      row.openExceptionCount,
      row.openDisputeCount,
      row.averageHealth,
      row.attentionCount,
      JSON.stringify(row.detail)
    );
}

export function listPortfolioSnapshots(scopeOrganizationId: string): PortfolioSnapshotRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM portfolio_snapshots WHERE scope_organization_id = ? ORDER BY taken_at`
    )
    .all(scopeOrganizationId)
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        scopeOrganizationId: s(x.scope_organization_id),
        takenByUserId: s(x.taken_by_user_id),
        takenAt: s(x.taken_at),
        projectCount: n(x.project_count),
        activeProjectCount: n(x.active_project_count),
        totalBudget: n(x.total_budget),
        totalReleased: n(x.total_released),
        totalPaidToDate: n(x.total_paid_to_date),
        openExceptionCount: n(x.open_exception_count),
        openDisputeCount: n(x.open_dispute_count),
        averageHealth: n(x.average_health),
        attentionCount: n(x.attention_count),
        detail: JSON.parse(s(x.detail)) as Record<string, unknown>,
      };
    });
}

export interface DrawEventRow {
  id: string;
  drawRequestId: string;
  type: string;
  detail: string;
  actorUserId: string | null;
  createdAt: string;
}

/**
 * Every draw event, ordered oldest first. Loaded once per request and
 * grouped in the context, so a portfolio-wide history never degrades into
 * one listDrawEvents call per draw. Tenancy is applied in the context by
 * draw id, exactly like lines and documents.
 */
export function drawEventRows(): DrawEventRow[] {
  return getDb()
    .prepare(
      `SELECT id, draw_request_id, type, detail, actor_user_id, created_at
         FROM draw_events
        ORDER BY created_at ASC, rowid ASC`
    )
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        drawRequestId: s(x.draw_request_id),
        type: s(x.type),
        detail: s(x.detail),
        actorUserId: sn(x.actor_user_id),
        createdAt: s(x.created_at),
      };
    });
}

// ------------------------------------------------ government foundation

/**
 * Read-only visibility into the disabled government-foundation tables.
 * There is intentionally NO insert/update/delete for gov_* anywhere in the
 * application — the architecture exists, the workflow does not.
 */
export function govTableCounts(): { portfolios: number; programs: number; links: number } {
  const db = getDb();
  const count = (sql: string): number => n((db.prepare(sql).get() as Row).c);
  return {
    portfolios: count("SELECT COUNT(*) AS c FROM gov_portfolios"),
    programs: count("SELECT COUNT(*) AS c FROM gov_programs"),
    links: count("SELECT COUNT(*) AS c FROM gov_program_links"),
  };
}
