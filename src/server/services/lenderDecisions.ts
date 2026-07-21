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
import { parseIsoDate, PermitError } from "./permits";
import { makeWholeCurrency } from "./money";
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

/** Conditions that BLOCK funding. A conditional approval is fundable only
 *  when every condition is SATISFIED or formally WAIVED (with a reason, by
 *  an authorized lender role). OPEN, IN_PROGRESS, FAILED and CANCELLED all
 *  block: a FAILED condition never becomes fundable merely because it is
 *  no longer open, and a CANCELLED condition only stops blocking when a
 *  superseding lender decision formally removes it (new decision → new
 *  condition set). */
export function blockingConditions(decisionId: string): LenderDecisionCondition[] {
  return lrepo.listDecisionConditions(decisionId).filter((c) =>
    ["OPEN", "IN_PROGRESS", "FAILED", "CANCELLED"].includes(c.status)
  );
}

/** @deprecated retained for callers that only track open work. */
export function openConditions(decisionId: string): LenderDecisionCondition[] {
  return lrepo.listDecisionConditions(decisionId).filter((c) =>
    ["OPEN", "IN_PROGRESS"].includes(c.status)
  );
}

/** STRICT normalized whole-currency validation, shared by decisions,
 *  waivers and funding — the ONE shared validator (services/money.ts)
 *  bound to LenderError: fractional, NaN, infinite, negative and unsafe
 *  values are rejected with 400, never silently rounded. */
export const wholeAmount = makeWholeCurrency((m) => new LenderError(m, 400));

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
  const requested = draw.requestedAmount;
  const reason = (input.decisionReason ?? "").trim();

  // Amount reconciliation per decision type. STRICT whole-currency rule:
  // every amount is normalized with Number() and must be a finite,
  // non-negative INTEGER (whole currency units) — fractional amounts are
  // rejected, never silently rounded. Categories may never total more than
  // the request.
  const holdback = wholeAmount(input.holdbackAmount ?? null, "holdbackAmount");
  const retainage = wholeAmount(input.retainageAmount ?? null, "retainageAmount");
  const approved = wholeAmount(input.approvedAmount ?? null, "approvedAmount");
  const reduced = wholeAmount(input.reducedAmount ?? null, "reducedAmount");
  const rejected = wholeAmount(input.rejectedAmount ?? null, "rejectedAmount");
  if ((approved ?? 0) + (reduced ?? 0) + (rejected ?? 0) > requested) {
    throw new LenderError("Approved + reduced + rejected amounts cannot exceed the requested amount", 400);
  }
  if ((holdback ?? 0) > (approved ?? 0) || (retainage ?? 0) > (approved ?? 0)) {
    throw new LenderError("Holdback and retainage cannot exceed the approved amount", 400);
  }
  if (input.decision === "APPROVED") {
    if (approved === null || approved !== requested) {
      throw new LenderError("APPROVED requires approvedAmount equal to the full requested amount (use REDUCED otherwise)", 400);
    }
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
    // The undisposed difference must be explicitly categorized.
    const undisposed = requested - approved;
    if (undisposed > 0 && (holdback ?? 0) + (reduced ?? 0) + (rejected ?? 0) !== undisposed) {
      throw new LenderError(
        `CONDITIONALLY_APPROVED must categorize the undisposed ${undisposed} as holdback, reduced or rejected`,
        400
      );
    }
  }

  // Governance → decision truth table, checked after input-shape
  // validation (malformed input is 400; a state conflict is 409). The
  // ApprovalRequest is the current authoritative request for this draw;
  // getApprovalRequestForDraw returns the latest:
  //   APPROVED / CONDITIONALLY_APPROVED / REDUCED  → approval.status APPROVED
  //   REJECTED                                     → approval.status REJECTED
  //   PENDING / WITHDRAWN                          → non-final, no governance needed
  const approval = repo.getApprovalRequestForDraw(draw.id);
  const requiresGovernance = ["APPROVED", "CONDITIONALLY_APPROVED", "REDUCED", "REJECTED"].includes(input.decision);
  if (requiresGovernance) {
    if (!approval || approval.status === "PENDING") {
      throw new LenderError(
        "A final lender decision requires the completed formal approval process (OBV governance is the source of record)",
        409
      );
    }
    const favorable = input.decision !== "REJECTED";
    if (favorable && approval.status !== "APPROVED") {
      throw new LenderError(
        `A ${input.decision} lender decision cannot be recorded against ${approval.status} formal governance`,
        409
      );
    }
    if (!favorable && approval.status !== "REJECTED") {
      throw new LenderError(
        "A REJECTED lender decision requires REJECTED formal governance (record an amendment if governance later changes)",
        409
      );
    }
    // Completed every required role, with no contradictory records.
    const records = repo.listApprovalRecordsForRequest(approval.id);
    const byRole = new Map(records.map((r) => [r.role, r]));
    const missing = approval.requiredRoles.filter((role) => !byRole.has(role));
    if (approval.status === "APPROVED") {
      if (missing.length > 0) {
        throw new LenderError(`Formal governance is incomplete: awaiting ${missing.join(", ")}`, 409);
      }
      if (records.some((r) => r.decision !== "APPROVED")) {
        throw new LenderError("Approval records contradict the APPROVED governance outcome", 409);
      }
    }
    if (approval.status === "REJECTED" && !records.some((r) => r.decision === "REJECTED")) {
      throw new LenderError("REJECTED governance has no rejecting approval record", 409);
    }
  }

  // Supersede rather than overwrite: prior final decisions stay history.
  // PENDING placeholders: at most one active PENDING; a final decision
  // automatically supersedes the active PENDING so no orphan remains.
  const prior = currentDecision(draw.id);
  const supersedeIds: string[] = [];
  if (prior && prior.decision === "PENDING") {
    if (input.decision === "PENDING") {
      throw new LenderError("An active PENDING decision already exists", 409);
    }
    supersedeIds.push(prior.id);
  }
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
    if (!supersedeIds.includes(superseded.id)) supersedeIds.push(superseded.id);
  }

  const now = new Date().toISOString();
  // Distinct amount provenance (never copied from one another):
  //  - verifiedAmount: derived from the COMPLETE line review — a SUPPORTED
  //    line contributes its full currentRequested, a PARTIALLY_SUPPORTED
  //    line contributes its reviewed supportedAmount, and EXCEPTION or
  //    REJECTED lines contribute nothing. Null until every line carries a
  //    review outcome (a partial review never masquerades as verified).
  //  - recommendedAmount: the finalized advisory recommendation
  //  - approvedAmount: the lender's formal business decision (input).
  const lines = repo.listDrawLines(draw.id);
  const allLinesReviewed = lines.length > 0 && lines.every((l) => l.status !== "PENDING");
  const verifiedFromLines = allLinesReviewed
    ? lines.reduce((sum, l) => {
        if (l.status === "SUPPORTED") return sum + l.currentRequested;
        if (l.status === "PARTIALLY_SUPPORTED") return sum + (l.supportedAmount ?? 0);
        return sum; // EXCEPTION / REJECTED contribute nothing
      }, 0)
    : null;
  const decision: LenderDrawDecision = {
    id: lrepo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    drawRequestId: draw.id,
    requestedAmount: requested,
    verifiedAmount: verifiedFromLines,
    verifiedAmountSource: verifiedFromLines !== null
      ? "complete line review: SUPPORTED at currentRequested + PARTIALLY_SUPPORTED at supportedAmount (line/evidence assessment)"
      : null,
    recommendedAmount: draw.recommendedAmount ?? null,
    recommendedAmountSource: draw.recommendedAmount !== null && draw.recommendedAmount !== undefined
      ? "finalized reviewer recommendation (advisory)"
      : null,
    approvedAmount: approved,
    reducedAmount: reduced,
    rejectedAmount: input.decision === "REJECTED" ? requested : rejected,
    decision: input.decision,
    reviewerUserId: user.id,
    decisionAt: input.decision === "PENDING" ? null : now,
    decisionReason: reason || null,
    holdbackAmount: holdback,
    retainageAmount: retainage ?? draw.retainageWithheld ?? null,
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
  // Validate EVERY condition before writing anything, then insert the
  // decision + supersedes + conditions in one transaction. The partial
  // unique index (one non-superseded decision per draw) turns concurrent
  // final-decision races into one success and one controlled 409.
  const conditionRows = (input.conditions ?? []).map((c) => {
    if (!c.description?.trim()) throw new LenderError("Each condition needs a description", 400);
    if (c.responsiblePartyOrganizationId && !repo.getOrganization(c.responsiblePartyOrganizationId)) {
      throw new LenderError("Condition responsible party references an unknown organization", 422);
    }
    return {
      id: lrepo.newId(),
      lenderDecisionId: decision.id,
      conditionType: c.conditionType?.trim() || "OTHER",
      description: c.description.trim(),
      responsiblePartyOrganizationId: c.responsiblePartyOrganizationId ?? null,
      dueAt: parseIsoDate(c.dueAt ?? null, "condition dueAt"),
      status: "OPEN" as const,
      supportingDocumentId: null,
      satisfiedByUserId: null,
      satisfiedAt: null,
      waiverReason: null,
      waivedByUserId: null,
      createdAt: now,
      updatedAt: now,
    };
  });
  const creationEvents = conditionRows.map((c) => ({
    id: lrepo.newId(), conditionId: c.id, priorStatus: null, newStatus: "OPEN",
    reason: "Created with the lender decision", actorUserId: user.id, createdAt: now,
  }));
  try {
    // Decision + supersedes + conditions + their creation events commit or
    // roll back as ONE unit — no condition can exist without its event.
    lrepo.createDecisionTx(decision, conditionRows, supersedeIds, creationEvents);
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint/.test(e.message)) {
      throw new LenderError("Another current lender decision was recorded concurrently", 409);
    }
    throw e;
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
  const now = new Date().toISOString();
  try {
    // State change + history event commit as ONE unit; the guarded UPDATE
    // (status must still be non-terminal) turns a concurrent transition
    // into a controlled 409 instead of a lost update.
    lrepo.updateConditionTx(
      conditionId,
      {
        status: input.status,
        waiverReason: input.status === "WAIVED" ? input.waiverReason!.trim() : condition.waiverReason,
        waivedByUserId: input.status === "WAIVED" ? user.id : condition.waivedByUserId,
        satisfiedByUserId: input.status === "SATISFIED" ? user.id : condition.satisfiedByUserId,
        satisfiedAt: input.status === "SATISFIED" ? now : condition.satisfiedAt,
        supportingDocumentId: input.supportingDocumentId ?? condition.supportingDocumentId,
        updatedAt: now,
      },
      {
        id: lrepo.newId(),
        conditionId,
        priorStatus: condition.status,
        newStatus: input.status,
        reason: input.status === "WAIVED" ? input.waiverReason!.trim() : null,
        actorUserId: user.id,
        createdAt: now,
      },
      ["OPEN", "IN_PROGRESS"]
    );
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("CONFLICT")) {
      throw new LenderError("This condition was transitioned concurrently — reload and retry", 409);
    }
    throw e;
  }
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
    relatedAmount: wholeAmount(input.relatedAmount ?? null, "relatedAmount"),
    coveredThrough: parseIsoDate(input.coveredThrough, "coveredThrough"),
    requestedAt: null,
    receivedAt: null,
    reviewedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    signatureDate: parseIsoDate(input.signatureDate, "signatureDate"),
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
    // Strict permit-module date validation on the TRANSITION path too:
    // locale-formatted, impossible, timezone-less or malformed dates are
    // rejected; an absent/empty value preserves the stored date.
    signatureDate: parseIsoDate(input.signatureDate, "signatureDate") ?? waiver.signatureDate,
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
  if (decision.supersededByDecisionId) {
    throw new LenderError("A superseded lender decision cannot be funded", 409);
  }
  if (!["APPROVED", "CONDITIONALLY_APPROVED", "REDUCED"].includes(decision.decision)) {
    throw new LenderError("Funding can only be scheduled against an approved decision", 409);
  }
  const blocking = blockingConditions(decision.id);
  if (decision.decision === "CONDITIONALLY_APPROVED" && blocking.length > 0) {
    throw new LenderError(
      `Conditional approval is not fundable while ${blocking.length} condition(s) are unsatisfied and unwaived`,
      409
    );
  }
  const available = (decision.approvedAmount ?? 0) - lrepo.disbursedTotal(draw.id);
  const scheduledAmount = wholeAmount(input.amountScheduled ?? decision.approvedAmount, "amountScheduled");
  const wireFee = wholeAmount(input.wireFee ?? null, "wireFee");
  if (scheduledAmount === null || scheduledAmount <= 0) {
    throw new LenderError("amountScheduled must be a positive whole-currency amount", 400);
  }
  if (scheduledAmount > available) {
    throw new LenderError(
      `amountScheduled (${scheduledAmount}) exceeds the remaining lender-approved amount (${available})`,
      409
    );
  }
  parseIsoDate(input.scheduledAt ?? null, "scheduledAt");
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
    amountScheduled: scheduledAmount,
    amountDisbursed: null,
    wireFee,
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
  try {
    lrepo.insertFundingRecord(record);
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint/.test(e.message)) {
      throw new LenderError("An active external funding record already exists for this draw", 409);
    }
    throw e;
  }
  void teamsNotifier.notify("FUNDING_SCHEDULED", `External funding scheduled for Draw #${draw.drawNumber} (administrative record)`, {
    projectId: project.id,
  });
  return record;
}

/** Derived payment status for a decision — funded state comes from the
 *  external funding records, never from rewriting decision history. */
export function derivedPaymentStatus(drawRequestId: string): {
  status: "NOT_FUNDED" | "SCHEDULED" | "DISBURSED" | "REVERSED" | "CLOSED";
  disbursedTotal: number;
} {
  const records = lrepo.listFundingRecords(drawRequestId);
  const active = records.filter((f) => !f.reversedAt);
  const anyReversed = records.some((f) => f.status === "REVERSED" || f.reversedAt !== null);
  if (records.some((f) => f.status === "CLOSED" && !f.reversedAt)) {
    return { status: "CLOSED", disbursedTotal: lrepo.disbursedTotal(drawRequestId) };
  }
  if (active.some((f) => f.status === "DISBURSED")) {
    return { status: "DISBURSED", disbursedTotal: lrepo.disbursedTotal(drawRequestId) };
  }
  if (active.some((f) => ["SCHEDULED", "PROCESSING"].includes(f.status))) {
    return { status: "SCHEDULED", disbursedTotal: lrepo.disbursedTotal(drawRequestId) };
  }
  if (anyReversed) return { status: "REVERSED", disbursedTotal: lrepo.disbursedTotal(drawRequestId) };
  return { status: "NOT_FUNDED", disbursedTotal: lrepo.disbursedTotal(drawRequestId) };
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
  // REVALIDATION at money-adjacent transitions: entering PROCESSING or
  // DISBURSED re-checks the decision and its conditions AS OF NOW — a
  // record scheduled while everything was valid must not proceed if the
  // decision has since been superseded/withdrawn or a condition has
  // regressed to a blocking state.
  if (input.status === "PROCESSING" || input.status === "DISBURSED") {
    const decisionNow = record.lenderDecisionId ? lrepo.getLenderDecision(record.lenderDecisionId) : null;
    if (!decisionNow || decisionNow.supersededByDecisionId) {
      throw new LenderError(
        "The lender decision behind this funding record has been superseded — cancel and reschedule against the current decision",
        409
      );
    }
    if (!["APPROVED", "CONDITIONALLY_APPROVED", "REDUCED"].includes(decisionNow.decision)) {
      throw new LenderError(`A ${decisionNow.decision} decision cannot be funded`, 409);
    }
    const blocking = blockingConditions(decisionNow.id);
    if (blocking.length > 0) {
      throw new LenderError(
        `Funding cannot proceed while ${blocking.length} decision condition(s) are unsatisfied and unwaived`,
        409
      );
    }
    const pending = input.status === "DISBURSED"
      ? wholeAmount(input.amountDisbursed ?? record.amountScheduled, "amountDisbursed")
      : record.amountScheduled;
    if (
      decisionNow.approvedAmount !== null && pending !== null &&
      lrepo.disbursedTotal(record.drawRequestId) + pending > decisionNow.approvedAmount
    ) {
      throw new LenderError(
        "This transition would take cumulative disbursements past the lender-approved amount",
        409
      );
    }
  }
  const now = new Date().toISOString();
  const patch: Partial<ExternalFundingRecord> = { status: input.status };
  if (input.status === "DISBURSED") {
    const ref = (input.transactionReference ?? "").trim();
    if (!ref) throw new LenderError("DISBURSED requires a transactionReference", 400);
    const amount = wholeAmount(input.amountDisbursed ?? record.amountScheduled, "amountDisbursed");
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
  // AUTHORITATIVE revalidation happens INSIDE transitionFundingTx, after
  // its BEGIN IMMEDIATE write lock: prior status, current decision (same
  // draw, not superseded, fundable type), every condition SATISFIED or
  // WAIVED, the cumulative-disbursement cap and the confirmation-document
  // ownership are all re-read from the database in the same transaction —
  // a supersede or condition change committed before the lock is always
  // observed and blocks funding with NO mutation. The service checks above
  // are an early-exit courtesy only. The FINALIZED lender decision itself
  // is NEVER mutated — funded state is DERIVED from ExternalFundingRecord.
  try {
    lrepo.transitionFundingTx(fundingId, record.status, patch);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("CAP:")) {
      throw new LenderError(e.message.slice(5).trim(), 409);
    }
    if (e instanceof Error && e.message.startsWith("REVALIDATION:")) {
      throw new LenderError(e.message.slice("REVALIDATION:".length).trim(), 409);
    }
    if (e instanceof Error && e.message.startsWith("CONFLICT")) {
      throw new LenderError("The funding record was transitioned concurrently — reload and retry", 409);
    }
    if (e instanceof Error && /UNIQUE constraint/.test(e.message)) {
      // FAILED → SCHEDULED reschedule while another record is already
      // in flight: the one-active partial unique index refuses inside the
      // transaction — same controlled 409 the scheduling path gives.
      throw new LenderError("An active external funding record already exists for this draw", 409);
    }
    throw e;
  }
  const updated = lrepo.getFundingRecord(fundingId)!;
  if (input.status === "DISBURSED") {
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
