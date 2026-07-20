/**
 * Lender draw decisions, decision conditions, lien-waiver lifecycle and
 * external funding records.
 *
 * The lender decision is the lender's BUSINESS decision recorded after
 * OBV's formal governance completes — ApprovalRequest/ApprovalRecord stay
 * the governance truth and the decision must reference the completed
 * approval. Nothing in this module imports or calls VirtualAccountService:
 * external funding records are administrative mirrors of actions the
 * lender takes in its own systems, and OBV's exactly-once governed
 * release remains the only financial state machine.
 */
import * as repo from "../db/repo";
import * as lrepo from "../db/lenderRepo";
import { teamsNotifier } from "./TeamsNotifier";
import { LenderError, assertCapability, assertProjectAccess } from "./lenderAccess";
import type {
  DrawRequest,
  ExternalFundingRecord,
  LenderDecisionCondition,
  LenderDrawDecision,
  LienWaiverRecord,
  User,
} from "../../shared/types";

function getDrawFor(user: User, drawRequestId: string): DrawRequest {
  const draw = repo.getDrawRequest(drawRequestId);
  if (!draw) throw new LenderError("Draw request not found", 404);
  assertProjectAccess(user, draw.projectId);
  return draw;
}

export function currentDecision(drawRequestId: string): LenderDrawDecision | null {
  const all = lrepo.listLenderDecisions(drawRequestId);
  const active = all.filter((d) => d.supersededByDecisionId === null);
  return active.length > 0 ? active[active.length - 1] : null;
}

/** Mandatory conditions still open on the current decision — a
 *  conditionally approved draw is NOT fundable while any remain. */
export function openConditions(decisionId: string): LenderDecisionCondition[] {
  return lrepo.listDecisionConditions(decisionId).filter((c) =>
    ["OPEN", "IN_PROGRESS"].includes(c.status)
  );
}

// ------------------------------------------------------------ decisions

export function recordLenderDecision(
  user: User,
  input: {
    drawRequestId: string;
    decision: LenderDrawDecision["decision"];
    approvedAmount?: number | null;
    reducedAmount?: number | null;
    rejectedAmount?: number | null;
    holdbackAmount?: number | null;
    retainageAmount?: number | null;
    decisionReason?: string | null;
    exceptionsAccepted?: string | null;
    governmentInspectionRequirement?: string | null;
    lienReleaseRequirement?: string | null;
    fundingInstructions?: string | null;
    notes?: string | null;
    conditions?: Array<{ conditionType: string; description: string; dueAt?: string | null; responsiblePartyOrganizationId?: string | null }>;
    supersedesDecisionId?: string | null;
  }
): LenderDrawDecision {
  const draw = getDrawFor(user, input.drawRequestId);
  const project = repo.getProject(draw.projectId)!;
  assertCapability(user, project.id, "RECORD_LENDER_DECISION");
  // Separation of duties: the draw submitter cannot decide their own draw.
  if (draw.requestedByUserId === user.id) {
    throw new LenderError("The draw submitter cannot record the lender decision on their own draw", 403);
  }
  const valid: LenderDrawDecision["decision"][] = [
    "PENDING", "APPROVED", "CONDITIONALLY_APPROVED", "REDUCED", "REJECTED", "WITHDRAWN", "FUNDED",
  ];
  if (!valid.includes(input.decision)) {
    throw new LenderError(`decision must be one of ${valid.join(", ")}`, 400);
  }
  if (input.decision === "FUNDED") {
    throw new LenderError(
      "FUNDED is recorded by the external-funding workflow after a disbursement record exists",
      409
    );
  }
  // The decision must reference COMPLETED formal governance (except a
  // provisional PENDING placeholder or a WITHDRAWN closure).
  const approval = repo.getApprovalRequestForDraw(draw.id);
  const requiresGovernance = ["APPROVED", "CONDITIONALLY_APPROVED", "REDUCED", "REJECTED"].includes(input.decision);
  if (requiresGovernance) {
    if (!approval || approval.status === "PENDING") {
      throw new LenderError(
        "A final lender decision requires the completed formal approval process (OBV governance is the source of record)",
        409
      );
    }
  }
  const requested = draw.requestedAmount;
  const approved = input.approvedAmount ?? null;
  const reduced = input.reducedAmount ?? null;
  const rejected = input.rejectedAmount ?? null;
  const reason = (input.decisionReason ?? "").trim();

  // Amount reconciliation per decision type.
  if (input.decision === "APPROVED") {
    if (approved === null || approved <= 0) throw new LenderError("APPROVED requires approvedAmount", 400);
    if (approved > requested) throw new LenderError("approvedAmount cannot exceed the requested amount", 400);
  }
  if (input.decision === "REDUCED") {
    if (!reason) throw new LenderError("REDUCED requires a reduction reason", 400);
    if (approved === null || reduced === null || reduced <= 0) {
      throw new LenderError("REDUCED requires approvedAmount and a positive reducedAmount", 400);
    }
    if (approved + reduced !== requested) {
      throw new LenderError(
        `REDUCED amounts must reconcile: approved (${approved}) + reduced (${reduced}) must equal requested (${requested})`,
        400
      );
    }
  }
  if (input.decision === "REJECTED") {
    if (!reason) throw new LenderError("REJECTED requires a rejection reason", 400);
    if ((rejected ?? requested) !== requested) {
      throw new LenderError("REJECTED must account for the full requested amount", 400);
    }
  }
  if (input.decision === "CONDITIONALLY_APPROVED") {
    if (!input.conditions || input.conditions.length === 0) {
      throw new LenderError("CONDITIONALLY_APPROVED requires at least one open condition", 400);
    }
    if (approved === null || approved <= 0 || approved > requested) {
      throw new LenderError("CONDITIONALLY_APPROVED requires a valid approvedAmount", 400);
    }
  }

  // Supersede rather than overwrite: prior final decisions stay history.
  const prior = currentDecision(draw.id);
  if (prior && prior.decision !== "PENDING" && !input.supersedesDecisionId) {
    throw new LenderError(
      "A final decision already exists — record an amendment by passing supersedesDecisionId",
      409
    );
  }
  if (input.supersedesDecisionId) {
    const superseded = lrepo.getLenderDecision(input.supersedesDecisionId);
    if (!superseded || superseded.drawRequestId !== draw.id) {
      throw new LenderError("supersedesDecisionId does not belong to this draw", 422);
    }
    if (superseded.supersededByDecisionId) {
      throw new LenderError("That decision has already been superseded", 409);
    }
  }

  const now = new Date().toISOString();
  const decision: LenderDrawDecision = {
    id: lrepo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    drawRequestId: draw.id,
    requestedAmount: requested,
    verifiedAmount: draw.recommendedAmount ?? null,
    recommendedAmount: draw.recommendedAmount ?? null,
    approvedAmount: approved,
    reducedAmount: reduced,
    rejectedAmount: input.decision === "REJECTED" ? requested : rejected,
    decision: input.decision,
    reviewerUserId: user.id,
    decisionAt: input.decision === "PENDING" ? null : now,
    decisionReason: reason || null,
    holdbackAmount: input.holdbackAmount ?? null,
    retainageAmount: input.retainageAmount ?? draw.retainageWithheld ?? null,
    exceptionsAccepted: input.exceptionsAccepted?.trim() || null,
    governmentInspectionRequirement: input.governmentInspectionRequirement?.trim() || null,
    lienReleaseRequirement: input.lienReleaseRequirement?.trim() || null,
    fundingInstructions: input.fundingInstructions?.trim() || null,
    notes: input.notes?.trim() || null,
    approvalRequestId: approval?.id ?? null,
    supersedesDecisionId: input.supersedesDecisionId ?? null,
    supersededByDecisionId: null,
    createdAt: now,
    updatedAt: now,
  };
  lrepo.insertLenderDecision(decision);
  if (input.supersedesDecisionId) {
    lrepo.updateLenderDecision(input.supersedesDecisionId, { supersededByDecisionId: decision.id });
  }
  for (const c of input.conditions ?? []) {
    if (!c.description?.trim()) throw new LenderError("Each condition needs a description", 400);
    lrepo.insertDecisionCondition({
      id: lrepo.newId(),
      lenderDecisionId: decision.id,
      conditionType: c.conditionType?.trim() || "OTHER",
      description: c.description.trim(),
      responsiblePartyOrganizationId: c.responsiblePartyOrganizationId ?? null,
      dueAt: c.dueAt?.trim() || null,
      status: "OPEN",
      supportingDocumentId: null,
      satisfiedByUserId: null,
      satisfiedAt: null,
      waiverReason: null,
      waivedByUserId: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  void teamsNotifier.notify(
    input.decision === "CONDITIONALLY_APPROVED" ? "CONDITIONAL_APPROVAL_ISSUED" : "LENDER_DECISION_RECORDED",
    `Lender decision ${input.decision} recorded for Draw #${draw.drawNumber}`,
    { projectId: project.id }
  );
  return decision;
}

export function updateCondition(
  user: User,
  conditionId: string,
  input: { status: LenderDecisionCondition["status"]; waiverReason?: string | null; supportingDocumentId?: string | null }
): LenderDecisionCondition {
  const condition = lrepo.getDecisionCondition(conditionId);
  if (!condition) throw new LenderError("Condition not found", 404);
  const decision = lrepo.getLenderDecision(condition.lenderDecisionId)!;
  assertProjectAccess(user, decision.projectId);
  assertCapability(user, decision.projectId, "RECORD_LENDER_DECISION");
  const valid: LenderDecisionCondition["status"][] = ["OPEN", "IN_PROGRESS", "SATISFIED", "WAIVED", "FAILED", "CANCELLED"];
  if (!valid.includes(input.status)) throw new LenderError("Invalid condition status", 400);
  if (["SATISFIED", "WAIVED", "FAILED", "CANCELLED"].includes(condition.status)) {
    throw new LenderError("This condition has already reached a terminal state", 409);
  }
  if (input.status === "WAIVED" && !(input.waiverReason ?? "").trim()) {
    throw new LenderError("Waiving a condition requires a waiverReason", 400);
  }
  if (input.supportingDocumentId) {
    const doc = repo.getDrawDocument(input.supportingDocumentId);
    if (!doc || doc.drawRequestId !== decision.drawRequestId) {
      throw new LenderError("supportingDocumentId does not belong to this draw", 422);
    }
  }
  lrepo.updateDecisionCondition(conditionId, {
    status: input.status,
    waiverReason: input.status === "WAIVED" ? input.waiverReason!.trim() : condition.waiverReason,
    waivedByUserId: input.status === "WAIVED" ? user.id : condition.waivedByUserId,
    satisfiedByUserId: input.status === "SATISFIED" ? user.id : condition.satisfiedByUserId,
    satisfiedAt: input.status === "SATISFIED" ? new Date().toISOString() : condition.satisfiedAt,
    supportingDocumentId: input.supportingDocumentId ?? condition.supportingDocumentId,
  });
  return lrepo.getDecisionCondition(conditionId)!;
}

// ------------------------------------------------------------ lien waivers

const WAIVER_TRANSITIONS: Record<LienWaiverRecord["status"], LienWaiverRecord["status"][]> = {
  NOT_REQUIRED: ["REQUIRED"],
  REQUIRED: ["REQUESTED", "RECEIVED", "NOT_REQUIRED"],
  REQUESTED: ["RECEIVED", "EXPIRED"],
  RECEIVED: ["UNDER_REVIEW"],
  UNDER_REVIEW: ["ACCEPTED", "REJECTED"],
  ACCEPTED: ["SUPERSEDED", "EXPIRED"],
  REJECTED: ["REQUESTED", "RECEIVED", "SUPERSEDED"],
  EXPIRED: ["REQUESTED", "SUPERSEDED"],
  SUPERSEDED: [],
};

export function createLienWaiver(
  user: User,
  input: Partial<LienWaiverRecord> & { drawRequestId: string }
): LienWaiverRecord {
  const draw = getDrawFor(user, input.drawRequestId);
  const project = repo.getProject(draw.projectId)!;
  assertCapability(user, project.id, "REVIEW_DRAW");
  if (input.drawLineItemId) {
    const line = repo.getDrawLine(input.drawLineItemId);
    if (!line || line.drawRequestId !== draw.id) {
      throw new LenderError("drawLineItemId does not belong to this draw", 422);
    }
  }
  if (input.drawDocumentId) {
    const doc = repo.getDrawDocument(input.drawDocumentId);
    if (!doc || doc.drawRequestId !== draw.id) {
      throw new LenderError("drawDocumentId does not belong to this draw", 422);
    }
  }
  const now = new Date().toISOString();
  const record: LienWaiverRecord = {
    id: lrepo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    drawRequestId: draw.id,
    drawLineItemId: input.drawLineItemId ?? null,
    drawDocumentId: input.drawDocumentId ?? null,
    contractorOrSupplierOrganizationId: input.contractorOrSupplierOrganizationId ?? null,
    signingParty: input.signingParty?.trim() || null,
    waiverType: input.waiverType?.trim() || null,
    waiverScope: input.waiverScope?.trim() || null,
    relatedAmount: input.relatedAmount ?? null,
    coveredThrough: input.coveredThrough?.trim() || null,
    requestedAt: null,
    receivedAt: null,
    reviewedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    signatureDate: input.signatureDate?.trim() || null,
    status: "REQUIRED",
    reviewedByUserId: null,
    rejectionReason: null,
    documentHash: input.documentHash ?? null,
    createdAt: now,
    updatedAt: now,
  };
  lrepo.insertLienWaiver(record);
  void teamsNotifier.notify("LIEN_WAIVER_REQUIRED", `Lien waiver required for Draw #${draw.drawNumber}`, {
    projectId: project.id,
  });
  return record;
}

export function transitionLienWaiver(
  user: User,
  waiverId: string,
  input: {
    status: LienWaiverRecord["status"];
    rejectionReason?: string | null;
    drawDocumentId?: string | null;
    signatureDate?: string | null;
  }
): LienWaiverRecord {
  const waiver = lrepo.getLienWaiver(waiverId);
  if (!waiver) throw new LenderError("Lien waiver record not found", 404);
  assertProjectAccess(user, waiver.projectId);
  assertCapability(user, waiver.projectId, "REVIEW_DRAW");
  if (!WAIVER_TRANSITIONS[waiver.status].includes(input.status)) {
    throw new LenderError(`A ${waiver.status} lien waiver cannot become ${input.status}`, 409);
  }
  // Acceptance is an explicit reviewed act — a document upload alone can
  // only move the record to RECEIVED, never to ACCEPTED.
  if (input.status === "ACCEPTED" && waiver.status !== "UNDER_REVIEW") {
    throw new LenderError("A lien waiver must be reviewed before acceptance", 409);
  }
  if (input.status === "REJECTED" && !(input.rejectionReason ?? "").trim()) {
    throw new LenderError("Rejecting a lien waiver requires a rejectionReason", 400);
  }
  if (input.drawDocumentId) {
    const doc = repo.getDrawDocument(input.drawDocumentId);
    if (!doc || doc.drawRequestId !== waiver.drawRequestId) {
      throw new LenderError("drawDocumentId does not belong to this draw", 422);
    }
  }
  const now = new Date().toISOString();
  lrepo.updateLienWaiver(waiverId, {
    status: input.status,
    requestedAt: input.status === "REQUESTED" ? now : waiver.requestedAt,
    receivedAt: input.status === "RECEIVED" ? now : waiver.receivedAt,
    reviewedAt: input.status === "UNDER_REVIEW" ? now : waiver.reviewedAt,
    acceptedAt: input.status === "ACCEPTED" ? now : waiver.acceptedAt,
    rejectedAt: input.status === "REJECTED" ? now : waiver.rejectedAt,
    reviewedByUserId: ["UNDER_REVIEW", "ACCEPTED", "REJECTED"].includes(input.status) ? user.id : waiver.reviewedByUserId,
    rejectionReason: input.status === "REJECTED" ? input.rejectionReason!.trim() : waiver.rejectionReason,
    drawDocumentId: input.drawDocumentId ?? waiver.drawDocumentId,
    signatureDate: input.signatureDate?.trim() || waiver.signatureDate,
  });
  const updated = lrepo.getLienWaiver(waiverId)!;
  if (input.status === "ACCEPTED") {
    void teamsNotifier.notify("LIEN_WAIVER_ACCEPTED", "Lien waiver accepted after review", {
      projectId: waiver.projectId,
    });
  }
  return updated;
}

// ------------------------------------------------------------ external funding

const FUNDING_TRANSITIONS: Record<ExternalFundingRecord["status"], ExternalFundingRecord["status"][]> = {
  NOT_SCHEDULED: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["PROCESSING", "DISBURSED", "FAILED", "CANCELLED"],
  PROCESSING: ["DISBURSED", "FAILED"],
  DISBURSED: ["REVERSED", "CLOSED"],
  FAILED: ["SCHEDULED", "CANCELLED"],
  REVERSED: ["CLOSED"],
  CANCELLED: [],
  CLOSED: [],
};

export function scheduleFunding(
  user: User,
  input: {
    drawRequestId: string;
    lenderDecisionId?: string | null;
    fundingMethod?: string | null;
    scheduledAt?: string | null;
    amountScheduled?: number | null;
    wireFee?: number | null;
  }
): ExternalFundingRecord {
  const draw = getDrawFor(user, input.drawRequestId);
  const project = repo.getProject(draw.projectId)!;
  assertCapability(user, project.id, "RECORD_EXTERNAL_FUNDING");
  const decision = input.lenderDecisionId ? lrepo.getLenderDecision(input.lenderDecisionId) : currentDecision(draw.id);
  if (!decision || decision.drawRequestId !== draw.id) {
    throw new LenderError("Funding requires the lender decision it executes", 422);
  }
  if (!["APPROVED", "CONDITIONALLY_APPROVED", "REDUCED"].includes(decision.decision)) {
    throw new LenderError("Funding can only be scheduled against an approved decision", 409);
  }
  const blocking = openConditions(decision.id);
  if (decision.decision === "CONDITIONALLY_APPROVED" && blocking.length > 0) {
    throw new LenderError(
      `Conditional approval is not fundable while ${blocking.length} mandatory condition(s) remain open`,
      409
    );
  }
  const now = new Date().toISOString();
  const record: ExternalFundingRecord = {
    id: lrepo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    drawRequestId: draw.id,
    lenderDecisionId: decision.id,
    fundingMethod: input.fundingMethod?.trim() || null,
    scheduledAt: input.scheduledAt?.trim() || now,
    fundedAt: null,
    amountScheduled: input.amountScheduled ?? decision.approvedAmount,
    amountDisbursed: null,
    wireFee: input.wireFee ?? null,
    transactionReference: null,
    confirmationDocumentId: null,
    status: "SCHEDULED",
    failureReason: null,
    reversalReference: null,
    reversedAt: null,
    closedAt: null,
    recordedByUserId: user.id,
    createdAt: now,
    updatedAt: now,
  };
  lrepo.insertFundingRecord(record);
  void teamsNotifier.notify("FUNDING_SCHEDULED", `External funding scheduled for Draw #${draw.drawNumber} (administrative record)`, {
    projectId: project.id,
  });
  return record;
}

export function transitionFunding(
  user: User,
  fundingId: string,
  input: {
    status: ExternalFundingRecord["status"];
    amountDisbursed?: number | null;
    transactionReference?: string | null;
    confirmationDocumentId?: string | null;
    failureReason?: string | null;
    reversalReference?: string | null;
  }
): ExternalFundingRecord {
  const record = lrepo.getFundingRecord(fundingId);
  if (!record) throw new LenderError("Funding record not found", 404);
  assertProjectAccess(user, record.projectId);
  assertCapability(user, record.projectId, "RECORD_EXTERNAL_FUNDING");
  if (!FUNDING_TRANSITIONS[record.status].includes(input.status)) {
    throw new LenderError(`A ${record.status} funding record cannot become ${input.status}`, 409);
  }
  const now = new Date().toISOString();
  const patch: Partial<ExternalFundingRecord> = { status: input.status };
  if (input.status === "DISBURSED") {
    const ref = (input.transactionReference ?? "").trim();
    if (!ref) throw new LenderError("DISBURSED requires a transactionReference", 400);
    const amount = input.amountDisbursed ?? record.amountScheduled;
    if (amount === null || amount <= 0) throw new LenderError("DISBURSED requires a positive amountDisbursed", 400);
    patch.transactionReference = ref;
    patch.amountDisbursed = amount;
    patch.fundedAt = now;
    if (input.confirmationDocumentId) {
      const doc = repo.getDrawDocument(input.confirmationDocumentId);
      if (!doc || doc.drawRequestId !== record.drawRequestId) {
        throw new LenderError("confirmationDocumentId does not belong to this draw", 422);
      }
      patch.confirmationDocumentId = input.confirmationDocumentId;
    }
  }
  if (input.status === "FAILED") {
    if (!(input.failureReason ?? "").trim()) throw new LenderError("FAILED requires a failureReason", 400);
    patch.failureReason = input.failureReason!.trim();
  }
  if (input.status === "REVERSED") {
    if (!(input.reversalReference ?? "").trim()) throw new LenderError("REVERSED requires a reversalReference", 400);
    // The original disbursement figures are preserved — only reversal
    // metadata is added.
    patch.reversalReference = input.reversalReference!.trim();
    patch.reversedAt = now;
  }
  if (input.status === "CLOSED") patch.closedAt = now;
  lrepo.updateFundingRecord(fundingId, patch);
  const updated = lrepo.getFundingRecord(fundingId)!;
  if (input.status === "DISBURSED") {
    // Recording the external disbursement also marks the decision FUNDED —
    // an administrative status, still with zero contact with the governed
    // virtual account.
    if (updated.lenderDecisionId) {
      const decision = lrepo.getLenderDecision(updated.lenderDecisionId);
      if (decision && !decision.supersededByDecisionId && decision.decision !== "FUNDED") {
        lrepo.updateLenderDecision(decision.id, { decision: "FUNDED" });
      }
    }
    void teamsNotifier.notify("EXTERNAL_FUNDS_DISBURSED", `External disbursement recorded (${updated.transactionReference})`, {
      projectId: record.projectId,
    });
  }
  if (input.status === "FAILED") {
    void teamsNotifier.notify("EXTERNAL_FUNDING_FAILED", updated.failureReason ?? "External funding failed", {
      projectId: record.projectId,
    });
  }
  return updated;
}
