/**
 * Construction Payment Dispute + Release Hold Management.
 *
 * OBV records disputes, pauses release ELIGIBILITY, collects evidence,
 * tracks cure requirements, requests inspections, records advisory
 * recommendations and records decisions made by authorized parties —
 * with immutable history throughout.
 *
 * OBV is NOT a licensed escrow service, arbitration, legal
 * adjudication, banking custody, money transmission, real payment
 * initiation, or a replacement for a lender, bank, attorney or licensed
 * escrow provider. A dispute hold is an eligibility and workflow
 * control: it never moves funds, reduces a bank balance, creates
 * settlement, generates a provider event, rewrites payment history or
 * implies that OBV holds legal escrow funds.
 *
 * Authorization rides the existing membership/capability framework
 * (lenderAccess). Capabilities are never granted broadly:
 *   FUNDER_REP (legacy fallback)          → open, respond, manage,
 *                                           decide, legal hold (activate)
 *   COMPLIANCE_REVIEWER (legacy fallback) → open, manage, decide,
 *                                           legal hold (activate+remove)
 *   PROJECT_MANAGER (legacy fallback)     → open, respond
 *   everyone else                         → explicit membership grant only
 * Separation of duties: the dispute opener can never record its final
 * resolution, in every authority mode.
 */
import * as repo from "../db/repo";
import * as drepo from "../db/disputeRepo";
import * as brepo from "../db/bankingRepo";
import * as lrepo from "../db/lenderRepo";
import * as lenderAccess from "./lenderAccess";
import { makeWholeCurrency } from "./money";
import { parseIsoDate } from "./permits";
import type {
  Dispute,
  DisputeCapability,
  DisputeCureItem,
  DisputeEscalation,
  DisputeEvent,
  DisputeEvidenceRecord,
  DisputeInspectionRequest,
  DisputeRecommendation,
  DisputeResolutionType,
  DisputeResponse,
  DisputeStatus,
  DisputeSubjectType,
  Project,
  User,
} from "../../shared/types";

export class DisputeError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const wholeAmount = makeWholeCurrency((m) => new DisputeError(m, 400));

export const ADVISORY_NOTE =
  "Advisory recommendation only. OBV does not act as the escrow agent, make a binding legal determination, or move funds.";

export const RESOLUTION_ACKNOWLEDGEMENT =
  "This action records an authorized project decision. OBV does not hold funds or execute the payment or return. Actual financial activity must be performed and confirmed by the lender, bank, payment provider, or licensed escrow partner.";

// ------------------------------------------------------------ access

const FULL_DISPUTE: DisputeCapability[] = [
  "OPEN_DISPUTE", "RESPOND_TO_DISPUTE", "MANAGE_DISPUTE", "DECIDE_DISPUTE", "MANAGE_LEGAL_HOLD",
];

const ROLE_FALLBACK: Partial<Record<User["role"], DisputeCapability[]>> = {
  FUNDER_REP: FULL_DISPUTE,
  COMPLIANCE_REVIEWER: ["OPEN_DISPUTE", "MANAGE_DISPUTE", "DECIDE_DISPUTE", "MANAGE_LEGAL_HOLD"],
  PROJECT_MANAGER: ["OPEN_DISPUTE", "RESPOND_TO_DISPUTE"],
};

export function disputeCapabilitiesFor(user: User, projectId: string): Set<DisputeCapability> {
  const caps = new Set<DisputeCapability>();
  const all = lenderAccess.capabilitiesFor(user, projectId);
  for (const c of FULL_DISPUTE) if (all.has(c)) caps.add(c);
  const fallback = ROLE_FALLBACK[user.role];
  if (fallback) for (const c of fallback) caps.add(c);
  return caps;
}

export function hasDisputeCapability(user: User, projectId: string, cap: DisputeCapability): boolean {
  return disputeCapabilitiesFor(user, projectId).has(cap);
}

/** Tenant boundary (same-404 doctrine) — delegates to lenderAccess. */
export function assertProjectAccess(user: User, projectId: string): Project {
  try {
    return lenderAccess.assertProjectAccess(user, projectId);
  } catch (e) {
    if (e instanceof lenderAccess.LenderError) throw new DisputeError(e.message, e.statusCode);
    throw e;
  }
}

function assertCapability(user: User, projectId: string, cap: DisputeCapability): void {
  if (!hasDisputeCapability(user, projectId, cap)) {
    throw new DisputeError(`This action requires the ${cap} capability`, 403);
  }
}

/** Dispute by id with the tenant boundary: unknown id and out-of-tenant
 *  id are the identical 404. */
export function getDisputeChecked(user: User, disputeId: string): Dispute {
  const dispute = drepo.getDispute(disputeId);
  if (!dispute) throw new DisputeError("Dispute not found", 404);
  assertProjectAccess(user, dispute.projectId);
  return dispute;
}

function logEvent(
  disputeId: string,
  type: DisputeEvent["type"],
  detail: string,
  actorUserId: string | null,
  refId: string | null = null
): void {
  drepo.insertDisputeEvent({
    id: drepo.newId(),
    disputeId,
    type,
    detail,
    actorUserId,
    refId,
    createdAt: new Date().toISOString(),
  });
}

// ================================================== release-hold reads

/** Statuses whose hold has ended for the FULL amount. Everything else —
 *  including a dispute under legal hold regardless of status — pauses
 *  release eligibility for the attached scope. */
const HOLD_ENDED: DisputeStatus[] = ["RESOLVED_RELEASE", "CLOSED"];

/** All disputes attached to a draw: directly, via one of its payment
 *  instructions, or via a milestone one of its lines bills. */
export function disputesAttachedToDraw(drawRequestId: string): Dispute[] {
  const seen = new Map<string, Dispute>();
  for (const d of drepo.listDisputesForDraw(drawRequestId)) seen.set(d.id, d);
  const instructionIds = brepo.listInstructionsForDraw(drawRequestId).map((i) => i.id);
  for (const d of drepo.listDisputesForInstructions(instructionIds)) seen.set(d.id, d);
  const milestoneIds = [
    ...new Set(repo.listDrawLines(drawRequestId).map((l) => l.milestoneId).filter((x): x is string => Boolean(x))),
  ];
  for (const d of drepo.listDisputesForMilestones(milestoneIds)) seen.set(d.id, d);
  return [...seen.values()];
}

export interface DrawDisputeHold {
  /** Full block: any attached dispute still holding, or any legal hold. */
  blocked: boolean;
  blockedReasons: string[];
  /** Disputed amounts that stay held after a PARTIAL release resolution
   *  (reduces the remaining instructable cap; never a balance change). */
  partialHeldAmount: number;
  legalHold: boolean;
  activeDisputes: Dispute[];
}

/** The release-hold read model the payment boundary consults. Pure read:
 *  nothing here mutates anything. `ignoreDisputeId` lets a resolution
 *  revalidate the UNDERLYING gates without its own hold blocking it. */
export function drawDisputeHold(drawRequestId: string, ignoreDisputeId: string | null = null): DrawDisputeHold {
  const attached = disputesAttachedToDraw(drawRequestId).filter((d) => d.id !== ignoreDisputeId);
  const reasons: string[] = [];
  let partialHeld = 0;
  let legalHold = false;
  const active: Dispute[] = [];
  for (const d of attached) {
    if (d.legalHold) {
      legalHold = true;
      active.push(d);
      reasons.push(`Legal hold active on dispute ${d.id.slice(0, 8)} (${d.affectedScope}).`);
      continue;
    }
    if (!HOLD_ENDED.includes(d.status)) {
      if (d.status === "RESOLVED_PARTIAL_RELEASE") {
        partialHeld += d.disputedAmount;
        active.push(d);
        reasons.push(
          `Dispute ${d.id.slice(0, 8)} resolved for partial release — the disputed ${d.disputedAmount} remains held.`
        );
      } else {
        active.push(d);
        reasons.push(
          `Active dispute ${d.id.slice(0, 8)} (${d.status}) holds release eligibility for ${d.affectedScope}.`
        );
      }
    }
  }
  const fullBlock = legalHold || active.some((d) => d.legalHold || (!HOLD_ENDED.includes(d.status) && d.status !== "RESOLVED_PARTIAL_RELEASE"));
  return { blocked: fullBlock, blockedReasons: reasons, partialHeldAmount: partialHeld, legalHold, activeDisputes: active };
}

// ====================================================== state machine

/** Explicitly allowed workflow transitions. RESOLVED_* states are
 *  reachable ONLY through resolve(); CLOSED only through close(). There
 *  are no silent fallbacks and no direct status editing. */
export const DISPUTE_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  OPEN: ["UNDER_REVIEW"],
  UNDER_REVIEW: [
    "WAITING_FOR_CONTRACTOR", "WAITING_FOR_LENDER", "WAITING_FOR_OWNER",
    "WAITING_FOR_INSPECTION", "WAITING_FOR_DOCUMENTS", "CURE_IN_PROGRESS",
    "READY_FOR_DECISION", "ESCALATED",
  ],
  WAITING_FOR_CONTRACTOR: ["UNDER_REVIEW", "CURE_IN_PROGRESS", "ESCALATED"],
  WAITING_FOR_LENDER: ["UNDER_REVIEW", "READY_FOR_DECISION", "ESCALATED"],
  WAITING_FOR_OWNER: ["UNDER_REVIEW", "READY_FOR_DECISION", "ESCALATED"],
  WAITING_FOR_INSPECTION: ["UNDER_REVIEW", "READY_FOR_DECISION"],
  WAITING_FOR_DOCUMENTS: ["UNDER_REVIEW", "CURE_IN_PROGRESS"],
  CURE_IN_PROGRESS: ["UNDER_REVIEW", "WAITING_FOR_CONTRACTOR", "READY_FOR_DECISION", "ESCALATED"],
  READY_FOR_DECISION: ["UNDER_REVIEW", "ESCALATED"],
  ESCALATED: ["UNDER_REVIEW", "READY_FOR_DECISION"],
  RESOLVED_RELEASE: ["UNDER_REVIEW"],
  RESOLVED_PARTIAL_RELEASE: ["UNDER_REVIEW"],
  RESOLVED_CONTINUE_HOLD: ["UNDER_REVIEW"],
  RESOLVED_RETURN_RECOMMENDATION: ["UNDER_REVIEW"],
  CLOSED: [],
};

const RESOLVED_STATUSES: DisputeStatus[] = [
  "RESOLVED_RELEASE", "RESOLVED_PARTIAL_RELEASE", "RESOLVED_CONTINUE_HOLD", "RESOLVED_RETURN_RECOMMENDATION",
];

const DECISION_READY: DisputeStatus[] = ["READY_FOR_DECISION", "ESCALATED"];

// ------------------------------------------------------------ creation

const SUBJECT_TYPES: DisputeSubjectType[] = [
  "PROJECT", "DRAW_REQUEST", "DRAW_LINE_ITEM", "MILESTONE", "PAYMENT_INSTRUCTION",
  "CHANGE_ORDER", "INVOICE_DOCUMENT", "RETAINAGE_RELEASE", "INSPECTION_RESULT", "EVIDENCE_ITEM",
];

/** Resolve + tenant-check the subject, deriving hold attachment points.
 *  The subject must exist and belong to the SAME project — a dispute can
 *  never attach to another tenant's records. */
function resolveSubject(
  projectId: string,
  subjectType: DisputeSubjectType,
  subjectId: string
): { drawRequestId: string | null; milestoneId: string | null; paymentInstructionId: string | null } {
  const wrong = () => new DisputeError(`${subjectType} subject not found in this project`, 422);
  switch (subjectType) {
    case "PROJECT": {
      if (subjectId !== projectId) throw wrong();
      return { drawRequestId: null, milestoneId: null, paymentInstructionId: null };
    }
    case "DRAW_REQUEST": {
      const draw = repo.getDrawRequest(subjectId);
      if (!draw || draw.projectId !== projectId) throw wrong();
      return { drawRequestId: draw.id, milestoneId: null, paymentInstructionId: null };
    }
    case "DRAW_LINE_ITEM": {
      const line = repo.getDrawLine(subjectId);
      const draw = line ? repo.getDrawRequest(line.drawRequestId) : null;
      if (!line || !draw || draw.projectId !== projectId) throw wrong();
      return { drawRequestId: draw.id, milestoneId: line.milestoneId ?? null, paymentInstructionId: null };
    }
    case "MILESTONE": {
      const ms = repo.getMilestone(subjectId);
      if (!ms || ms.projectId !== projectId) throw wrong();
      return { drawRequestId: null, milestoneId: ms.id, paymentInstructionId: null };
    }
    case "PAYMENT_INSTRUCTION": {
      const pi = brepo.getInstruction(subjectId);
      if (!pi) throw wrong();
      const account = brepo.getAccount(pi.projectVirtualAccountId);
      if (!account || account.projectId !== projectId) throw wrong();
      return { drawRequestId: pi.drawRequestId, milestoneId: null, paymentInstructionId: pi.id };
    }
    case "CHANGE_ORDER": {
      const co = repo.getChangeOrder(subjectId);
      if (!co || co.projectId !== projectId) throw wrong();
      return { drawRequestId: null, milestoneId: null, paymentInstructionId: null };
    }
    case "INVOICE_DOCUMENT": {
      const doc = repo.getDrawDocument(subjectId);
      const draw = doc ? repo.getDrawRequest(doc.drawRequestId) : null;
      if (!doc || !draw || draw.projectId !== projectId) throw wrong();
      return { drawRequestId: draw.id, milestoneId: null, paymentInstructionId: null };
    }
    case "RETAINAGE_RELEASE": {
      const rr = repo.getRetainageRelease(subjectId);
      if (!rr || rr.projectId !== projectId) throw wrong();
      return { drawRequestId: null, milestoneId: null, paymentInstructionId: null };
    }
    case "INSPECTION_RESULT": {
      const insp = lrepo.getDrawInspection(subjectId);
      if (!insp || insp.projectId !== projectId) throw wrong();
      return { drawRequestId: insp.drawRequestId, milestoneId: null, paymentInstructionId: null };
    }
    case "EVIDENCE_ITEM": {
      const ev = repo.getEvidence(subjectId);
      const ms = ev ? repo.getMilestone(ev.milestoneId) : null;
      if (!ev || !ms || ms.projectId !== projectId) throw wrong();
      return { drawRequestId: null, milestoneId: ms.id, paymentInstructionId: null };
    }
  }
}


export function openDispute(
  user: User,
  input: {
    projectId: string;
    subjectType: string;
    subjectId: string;
    disputedAmount: unknown;
    undisputedAmount?: unknown;
    affectedScope: string;
    affectedLineIds?: string[] | null;
    reason: string;
    responsibleReviewerUserId?: string | null;
  }
): Dispute {
  const project = assertProjectAccess(user, input.projectId);
  assertCapability(user, project.id, "OPEN_DISPUTE");
  const subjectType = (input.subjectType ?? "").trim() as DisputeSubjectType;
  if (!SUBJECT_TYPES.includes(subjectType)) {
    throw new DisputeError(`subjectType must be one of ${SUBJECT_TYPES.join(", ")}`, 400);
  }
  const subjectId = (input.subjectId ?? "").trim();
  if (!subjectId) throw new DisputeError("subjectId is required", 400);
  const attach = resolveSubject(project.id, subjectType, subjectId);
  const disputedAmount = wholeAmount(input.disputedAmount, "disputedAmount");
  if (disputedAmount === null || disputedAmount <= 0) {
    throw new DisputeError("disputedAmount must be a positive whole-currency amount", 400);
  }
  const undisputedAmount = wholeAmount(input.undisputedAmount ?? null, "undisputedAmount");
  const reason = (input.reason ?? "").trim();
  if (!reason) throw new DisputeError("A dispute reason is required", 400);
  const affectedScope = (input.affectedScope ?? "").trim();
  if (!affectedScope) throw new DisputeError("affectedScope is required", 400);
  const lineIds = Array.isArray(input.affectedLineIds) ? input.affectedLineIds.map(String) : [];
  if (input.responsibleReviewerUserId && !repo.getUser(input.responsibleReviewerUserId)) {
    throw new DisputeError("responsibleReviewerUserId does not exist", 422);
  }
  const now = new Date().toISOString();
  const user2 = repo.getUser(user.id)!;
  const dispute: Dispute = {
    id: drepo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    subjectType,
    subjectId,
    drawRequestId: attach.drawRequestId,
    milestoneId: attach.milestoneId,
    paymentInstructionId: attach.paymentInstructionId,
    disputedAmount,
    undisputedAmount,
    affectedScope,
    affectedLineIds: JSON.stringify(lineIds),
    reason,
    status: "OPEN",
    openedByUserId: user.id,
    openedByOrganizationId: user2.organizationId,
    openedAt: now,
    responsibleReviewerUserId: input.responsibleReviewerUserId ?? null,
    legalHold: false,
    legalHoldByUserId: null,
    legalHoldReason: null,
    legalHoldAt: null,
    resolutionType: null,
    resolutionAmount: null,
    resolutionReasoning: null,
    resolutionConditions: null,
    resolutionEvidenceIds: null,
    resolutionExternalReference: null,
    resolvedByUserId: null,
    resolvedByRole: null,
    resolvedByOrganizationId: null,
    resolvedAt: null,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  drepo.withDisputeTx(() => {
    drepo.insertDispute(dispute);
    logEvent(dispute.id, "CREATED", `Dispute opened over ${affectedScope} (disputed ${disputedAmount}). Reason: ${reason.slice(0, 200)}`, user.id);
  });
  return drepo.getDispute(dispute.id)!;
}

// --------------------------------------------------------- transitions

export function transitionDispute(user: User, disputeId: string, to: string, reason?: string | null): Dispute {
  const dispute = getDisputeChecked(user, disputeId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  const target = (to ?? "").trim() as DisputeStatus;
  if (!(target in DISPUTE_TRANSITIONS)) throw new DisputeError(`Unknown dispute status ${to}`, 400);
  if (RESOLVED_STATUSES.includes(target)) {
    throw new DisputeError("Resolved states are recorded only through the authorized resolution action", 409);
  }
  if (target === "CLOSED") {
    throw new DisputeError("Closure is recorded only through the authorized close action", 409);
  }
  const allowed = DISPUTE_TRANSITIONS[dispute.status] ?? [];
  if (!allowed.includes(target)) {
    throw new DisputeError(`Transition ${dispute.status} → ${target} is not allowed`, 409);
  }
  if (RESOLVED_STATUSES.includes(dispute.status) && dispute.legalHold) {
    throw new DisputeError("Legal hold active — the dispute cannot be reopened or changed until it is removed", 409);
  }
  drepo.withDisputeTx(() => {
    if (!drepo.transitionDisputeGuarded(dispute.id, [dispute.status], target)) {
      throw new DisputeError("The dispute was transitioned concurrently — reload and retry", 409);
    }
    const kind = RESOLVED_STATUSES.includes(dispute.status) ? "REOPENED" : "STATUS_CHANGED";
    logEvent(dispute.id, kind, `${dispute.status} → ${target}${reason ? ` — ${String(reason).slice(0, 200)}` : ""}`, user.id);
  });
  return drepo.getDispute(dispute.id)!;
}

// ----------------------------------------------------------- responses

export function submitResponse(
  user: User,
  disputeId: string,
  input: { kind?: string | null; body: string; supersedesResponseId?: string | null }
): DisputeResponse {
  const dispute = getDisputeChecked(user, disputeId);
  const caps = disputeCapabilitiesFor(user, dispute.projectId);
  if (!caps.has("RESPOND_TO_DISPUTE") && !caps.has("MANAGE_DISPUTE")) {
    throw new DisputeError("This action requires the RESPOND_TO_DISPUTE capability", 403);
  }
  if (["CLOSED"].includes(dispute.status)) {
    throw new DisputeError("A closed dispute accepts no further submissions", 409);
  }
  const body = (input.body ?? "").trim();
  if (!body) throw new DisputeError("A written response body is required", 400);
  const kinds = ["RESPONSE", "QUESTION", "ANSWER", "DISPUTED_FACTS", "CURE_PROPOSAL", "CLARIFICATION_REQUEST"];
  const kind = (input.kind ?? "RESPONSE").trim().toUpperCase();
  if (!kinds.includes(kind)) throw new DisputeError(`kind must be one of ${kinds.join(", ")}`, 400);
  let supersedes: string | null = null;
  if (input.supersedesResponseId) {
    const prior = drepo.getDisputeResponse(input.supersedesResponseId);
    if (!prior || prior.disputeId !== dispute.id) throw new DisputeError("supersedesResponseId not found on this dispute", 422);
    if (prior.submittedByUserId !== user.id && !caps.has("MANAGE_DISPUTE")) {
      throw new DisputeError("Only the original submitter may issue a correction", 403);
    }
    supersedes = prior.id;
  }
  const user2 = repo.getUser(user.id)!;
  let created: DisputeResponse | null = null;
  drepo.withDisputeTx(() => {
    const response: DisputeResponse = {
      id: drepo.newId(),
      disputeId: dispute.id,
      version: drepo.nextResponseVersion(dispute.id),
      kind: kind as DisputeResponse["kind"],
      body,
      submittedByUserId: user.id,
      submittedByOrganizationId: user2.organizationId,
      supersedesResponseId: supersedes,
      createdAt: new Date().toISOString(),
    };
    drepo.insertDisputeResponse(response);
    logEvent(dispute.id, "RESPONSE_SUBMITTED", `${kind} v${response.version} submitted${supersedes ? " (corrects an earlier submission — the original remains on record)" : ""}.`, user.id, response.id);
    created = response;
  });
  return created!;
}

// ------------------------------------------------------------ evidence

const EVIDENCE_LINK_TYPES = ["EVIDENCE_ITEM", "DRAW_DOCUMENT", "REPORT", "DRAW_INSPECTION", "NONE"];

export function submitEvidence(
  user: User,
  disputeId: string,
  input: {
    evidenceType: string;
    title: string;
    description?: string | null;
    linkedType?: string | null;
    linkedId?: string | null;
    externalReference?: string | null;
    supersedesEvidenceId?: string | null;
  }
): DisputeEvidenceRecord {
  const dispute = getDisputeChecked(user, disputeId);
  const caps = disputeCapabilitiesFor(user, dispute.projectId);
  if (!caps.has("RESPOND_TO_DISPUTE") && !caps.has("MANAGE_DISPUTE")) {
    throw new DisputeError("This action requires the RESPOND_TO_DISPUTE capability", 403);
  }
  if (dispute.status === "CLOSED") throw new DisputeError("A closed dispute accepts no further evidence", 409);
  const title = (input.title ?? "").trim();
  if (!title) throw new DisputeError("An evidence title is required", 400);
  const evidenceType = (input.evidenceType ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40);
  if (!evidenceType) throw new DisputeError("evidenceType is required", 400);
  const linkedType = ((input.linkedType ?? "NONE").trim().toUpperCase() || "NONE") as DisputeEvidenceRecord["linkedType"];
  if (!EVIDENCE_LINK_TYPES.includes(linkedType)) {
    throw new DisputeError(`linkedType must be one of ${EVIDENCE_LINK_TYPES.join(", ")}`, 400);
  }
  const linkedId = (input.linkedId ?? "").toString().trim() || null;

  // Linked objects must exist IN THIS TENANT/PROJECT and carry their own
  // integrity hash where one exists — no weaker parallel evidence system.
  let documentHash: string | null = null;
  if (linkedType !== "NONE") {
    if (!linkedId) throw new DisputeError("linkedId is required for a linked evidence record", 400);
    if (linkedType === "EVIDENCE_ITEM") {
      const ev = repo.getEvidence(linkedId);
      const ms = ev ? repo.getMilestone(ev.milestoneId) : null;
      if (!ev || !ms || ms.projectId !== dispute.projectId) throw new DisputeError("Linked evidence item not found in this project", 422);
      documentHash = ev.hash ?? null;
    } else if (linkedType === "DRAW_DOCUMENT") {
      const doc = repo.getDrawDocument(linkedId);
      const draw = doc ? repo.getDrawRequest(doc.drawRequestId) : null;
      if (!doc || !draw || draw.projectId !== dispute.projectId) throw new DisputeError("Linked draw document not found in this project", 422);
      documentHash = (doc as { documentHash?: string | null }).documentHash ?? null;
    } else if (linkedType === "REPORT") {
      const report = repo.getReport(linkedId);
      if (!report || report.projectId !== dispute.projectId) throw new DisputeError("Linked report not found in this project", 422);
      documentHash = (report as { fileHash?: string | null }).fileHash ?? null;
    } else if (linkedType === "DRAW_INSPECTION") {
      const insp = lrepo.getDrawInspection(linkedId);
      if (!insp || insp.projectId !== dispute.projectId) throw new DisputeError("Linked inspection not found in this project", 422);
    }
  }
  let supersedes: string | null = null;
  let version = 1;
  if (input.supersedesEvidenceId) {
    const prior = drepo.getDisputeEvidence(input.supersedesEvidenceId);
    if (!prior || prior.disputeId !== dispute.id) throw new DisputeError("supersedesEvidenceId not found on this dispute", 422);
    supersedes = prior.id;
    version = prior.version + 1;
  }
  const user2 = repo.getUser(user.id)!;
  const now = new Date().toISOString();
  const id = drepo.newId();
  // Integrity metadata: the linked object's stored hash when one exists,
  // otherwise a SHA-256 over the canonical submission descriptor.
  const hash =
    documentHash ??
    drepo.sha256Hex(
      JSON.stringify({ disputeId: dispute.id, id, evidenceType, title, linkedType, linkedId, externalReference: input.externalReference ?? null, submittedBy: user.id, version, at: now })
    );
  let created: DisputeEvidenceRecord | null = null;
  drepo.withDisputeTx(() => {
    const record: DisputeEvidenceRecord = {
      id,
      disputeId: dispute.id,
      evidenceType,
      title,
      description: (input.description ?? "").toString().trim().slice(0, 2000) || null,
      linkedType,
      linkedId,
      externalReference: (input.externalReference ?? "").toString().trim().slice(0, 200) || null,
      documentHash: hash,
      version,
      supersedesEvidenceId: supersedes,
      submittedByUserId: user.id,
      submittedByOrganizationId: user2.organizationId,
      reviewStatus: "PENDING",
      reviewedByUserId: null,
      reviewedAt: null,
      reviewerNotes: null,
      createdAt: now,
    };
    drepo.insertDisputeEvidence(record);
    logEvent(dispute.id, "EVIDENCE_SUBMITTED", `Evidence "${title}" (${evidenceType}, v${version}) submitted${supersedes ? " as an additive correction" : ""}.`, user.id, record.id);
    created = record;
  });
  return created!;
}

export function reviewEvidence(
  user: User,
  evidenceId: string,
  input: { status: string; notes?: string | null }
): DisputeEvidenceRecord {
  const record = drepo.getDisputeEvidence(evidenceId);
  if (!record) throw new DisputeError("Evidence record not found", 404);
  const dispute = getDisputeChecked(user, record.disputeId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  const status = (input.status ?? "").trim().toUpperCase();
  if (!["ACCEPTED", "REJECTED"].includes(status)) {
    throw new DisputeError("status must be ACCEPTED or REJECTED", 400);
  }
  const now = new Date().toISOString();
  drepo.withDisputeTx(() => {
    if (!drepo.reviewDisputeEvidenceGuarded(record.id, status as "ACCEPTED" | "REJECTED", user.id, (input.notes ?? "").toString().trim().slice(0, 1000) || null, now)) {
      throw new DisputeError("The evidence record was already reviewed", 409);
    }
    logEvent(dispute.id, "EVIDENCE_REVIEWED", `Evidence "${record.title}" ${status.toLowerCase()}.`, user.id, record.id);
  });
  return drepo.getDisputeEvidence(record.id)!;
}

// ---------------------------------------------------------------- cures

export function createCureItem(
  user: User,
  disputeId: string,
  input: {
    title: string;
    description: string;
    responsiblePartyUserId?: string | null;
    responsibleOrganizationId?: string | null;
    dueAt?: string | null;
    evidenceRequired?: string | null;
    affectedScope?: string | null;
    affectedAmount?: unknown;
    priority?: string | null;
  }
): DisputeCureItem {
  const dispute = getDisputeChecked(user, disputeId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  if (["CLOSED", ...RESOLVED_STATUSES].includes(dispute.status)) {
    throw new DisputeError("Cure requirements can only be created on an active dispute", 409);
  }
  const title = (input.title ?? "").trim();
  const description = (input.description ?? "").trim();
  if (!title || !description) throw new DisputeError("A cure item requires a title and description", 400);
  const priority = ((input.priority ?? "MEDIUM").trim().toUpperCase() || "MEDIUM") as DisputeCureItem["priority"];
  if (!["LOW", "MEDIUM", "HIGH"].includes(priority)) throw new DisputeError("priority must be LOW, MEDIUM or HIGH", 400);
  const dueAt = parseIsoDate(input.dueAt ?? null, "dueAt");
  const affectedAmount = wholeAmount(input.affectedAmount ?? null, "affectedAmount");
  if (input.responsiblePartyUserId && !repo.getUser(input.responsiblePartyUserId)) {
    throw new DisputeError("responsiblePartyUserId does not exist", 422);
  }
  const now = new Date().toISOString();
  let created: DisputeCureItem | null = null;
  drepo.withDisputeTx(() => {
    const cure: DisputeCureItem = {
      id: drepo.newId(),
      disputeId: dispute.id,
      title,
      description,
      responsiblePartyUserId: input.responsiblePartyUserId ?? null,
      responsibleOrganizationId: input.responsibleOrganizationId ?? null,
      dueAt,
      evidenceRequired: (input.evidenceRequired ?? "").toString().trim().slice(0, 500) || null,
      affectedScope: (input.affectedScope ?? "").toString().trim().slice(0, 300) || null,
      affectedAmount,
      priority,
      status: "OPEN",
      completionNote: null,
      completionEvidenceId: null,
      submittedAt: null,
      reviewedByUserId: null,
      reviewedAt: null,
      reviewDecisionNote: null,
      waiverReason: null,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now,
    };
    drepo.insertCureItem(cure);
    logEvent(dispute.id, "CURE_CREATED", `Cure requirement "${title}" created (${priority}${dueAt ? `, due ${dueAt}` : ""}).`, user.id, cure.id);
    created = cure;
  });
  return created!;
}

function getCureChecked(user: User, cureId: string): { cure: DisputeCureItem; dispute: Dispute } {
  const cure = drepo.getCureItem(cureId);
  if (!cure) throw new DisputeError("Cure item not found", 404);
  const dispute = getDisputeChecked(user, cure.disputeId);
  return { cure, dispute };
}

export function submitCure(
  user: User,
  cureId: string,
  input: { completionNote: string; completionEvidenceId?: string | null }
): DisputeCureItem {
  const { cure, dispute } = getCureChecked(user, cureId);
  const caps = disputeCapabilitiesFor(user, dispute.projectId);
  if (!caps.has("RESPOND_TO_DISPUTE") && !caps.has("MANAGE_DISPUTE")) {
    throw new DisputeError("This action requires the RESPOND_TO_DISPUTE capability", 403);
  }
  const note = (input.completionNote ?? "").trim();
  if (!note) throw new DisputeError("A completion note is required", 400);
  let evidenceId: string | null = null;
  if (input.completionEvidenceId) {
    const ev = drepo.getDisputeEvidence(input.completionEvidenceId);
    if (!ev || ev.disputeId !== dispute.id) throw new DisputeError("completionEvidenceId not found on this dispute", 422);
    evidenceId = ev.id;
  }
  const now = new Date().toISOString();
  drepo.withDisputeTx(() => {
    if (!drepo.transitionCureGuarded(cure.id, ["OPEN", "REJECTED"], "SUBMITTED", { completionNote: note, completionEvidenceId: evidenceId ?? undefined, submittedAt: now })) {
      throw new DisputeError(`The cure item is not open for submission (current status ${cure.status})`, 409);
    }
    logEvent(dispute.id, "CURE_SUBMITTED", `Cure "${cure.title}" marked ready for review.`, user.id, cure.id);
  });
  return drepo.getCureItem(cure.id)!;
}

export function reviewCure(
  user: User,
  cureId: string,
  input: { decision: string; note?: string | null }
): DisputeCureItem {
  const { cure, dispute } = getCureChecked(user, cureId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  const decision = (input.decision ?? "").trim().toUpperCase();
  if (!["ACCEPTED", "REJECTED"].includes(decision)) throw new DisputeError("decision must be ACCEPTED or REJECTED", 400);
  const now = new Date().toISOString();
  drepo.withDisputeTx(() => {
    if (!drepo.transitionCureGuarded(cure.id, ["SUBMITTED"], decision as "ACCEPTED" | "REJECTED", { reviewedByUserId: user.id, reviewedAt: now, reviewDecisionNote: (input.note ?? "").toString().trim().slice(0, 1000) || undefined })) {
      throw new DisputeError("The cure item is not awaiting review", 409);
    }
    logEvent(dispute.id, "CURE_REVIEWED", `Cure "${cure.title}" ${decision.toLowerCase()}.`, user.id, cure.id);
  });
  return drepo.getCureItem(cure.id)!;
}

export function waiveCure(user: User, cureId: string, reason: string): DisputeCureItem {
  const { cure, dispute } = getCureChecked(user, cureId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  const trimmed = (reason ?? "").trim();
  if (!trimmed) throw new DisputeError("A waiver reason is required", 400);
  drepo.withDisputeTx(() => {
    if (!drepo.transitionCureGuarded(cure.id, ["OPEN", "SUBMITTED", "REJECTED"], "WAIVED", { waiverReason: trimmed.slice(0, 500), reviewedByUserId: user.id, reviewedAt: new Date().toISOString() })) {
      throw new DisputeError("The cure item cannot be waived from its current status", 409);
    }
    logEvent(dispute.id, "CURE_WAIVED", `Cure "${cure.title}" waived: ${trimmed.slice(0, 200)}`, user.id, cure.id);
  });
  return drepo.getCureItem(cure.id)!;
}

export function cancelCure(user: User, cureId: string, reason?: string | null): DisputeCureItem {
  const { cure, dispute } = getCureChecked(user, cureId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  drepo.withDisputeTx(() => {
    if (!drepo.transitionCureGuarded(cure.id, ["OPEN", "SUBMITTED", "REJECTED"], "CANCELLED", {})) {
      throw new DisputeError("The cure item cannot be cancelled from its current status", 409);
    }
    logEvent(dispute.id, "CURE_CANCELLED", `Cure "${cure.title}" cancelled${reason ? `: ${String(reason).slice(0, 200)}` : ""}.`, user.id, cure.id);
  });
  return drepo.getCureItem(cure.id)!;
}

export function extendCureDeadline(
  user: User,
  cureId: string,
  input: { newDueAt: string; reason: string }
): DisputeCureItem {
  const { cure, dispute } = getCureChecked(user, cureId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  const newDueAt = parseIsoDate(input.newDueAt, "newDueAt");
  if (!newDueAt) throw new DisputeError("newDueAt is required", 400);
  const reason = (input.reason ?? "").trim();
  if (!reason) throw new DisputeError("A recorded reason is required to extend a deadline", 400);
  const now = new Date().toISOString();
  drepo.withDisputeTx(() => {
    if (!drepo.extendCureDueGuarded(cure.id, cure.dueAt, newDueAt)) {
      throw new DisputeError("The deadline could not be extended (status or a concurrent change)", 409);
    }
    drepo.insertCureExtension({
      id: drepo.newId(),
      cureItemId: cure.id,
      priorDueAt: cure.dueAt,
      newDueAt,
      reason: reason.slice(0, 500),
      actorUserId: user.id,
      createdAt: now,
    });
    logEvent(dispute.id, "CURE_EXTENDED", `Cure "${cure.title}" deadline moved ${cure.dueAt ?? "unset"} → ${newDueAt}: ${reason.slice(0, 200)}`, user.id, cure.id);
  });
  return drepo.getCureItem(cure.id)!;
}

/** DISPLAY-ONLY overdue calculation. Nothing auto-resolves, auto-waives
 *  or auto-releases because of a date. */
export function cureIsOverdue(cure: DisputeCureItem, nowMs = Date.now()): boolean {
  if (!cure.dueAt || !["OPEN", "SUBMITTED", "REJECTED"].includes(cure.status)) return false;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(cure.dueAt) ? cure.dueAt + "T23:59:59.999Z" : cure.dueAt;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms < nowMs;
}

// ----------------------------------------------------------- inspections

export function requestDisputeInspection(
  user: User,
  disputeId: string,
  input: { inspectionType: string; assignedInspectorUserId?: string | null; locationScope?: string | null }
): DisputeInspectionRequest {
  const dispute = getDisputeChecked(user, disputeId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  if (["CLOSED", ...RESOLVED_STATUSES].includes(dispute.status)) {
    throw new DisputeError("Inspections can only be requested on an active dispute", 409);
  }
  const inspectionType = (input.inspectionType ?? "").trim();
  if (!inspectionType) throw new DisputeError("inspectionType is required", 400);
  if (input.assignedInspectorUserId && !repo.getUser(input.assignedInspectorUserId)) {
    throw new DisputeError("assignedInspectorUserId does not exist", 422);
  }
  const now = new Date().toISOString();
  let created: DisputeInspectionRequest | null = null;
  drepo.withDisputeTx(() => {
    const insp: DisputeInspectionRequest = {
      id: drepo.newId(),
      disputeId: dispute.id,
      inspectionType: inspectionType.slice(0, 80),
      requestedAt: now,
      requestedByUserId: user.id,
      assignedInspectorUserId: input.assignedInspectorUserId ?? null,
      scheduledAt: null,
      completedAt: null,
      locationScope: (input.locationScope ?? "").toString().trim().slice(0, 300) || null,
      result: null,
      notes: null,
      status: "REQUESTED",
      followUp: null,
      createdAt: now,
      updatedAt: now,
    };
    drepo.insertDisputeInspection(insp);
    logEvent(dispute.id, "INSPECTION_REQUESTED", `${inspectionType} inspection requested.`, user.id, insp.id);
    created = insp;
  });
  return created!;
}

function getInspectionChecked(user: User, id: string): { insp: DisputeInspectionRequest; dispute: Dispute } {
  const insp = drepo.getDisputeInspection(id);
  if (!insp) throw new DisputeError("Inspection request not found", 404);
  const dispute = getDisputeChecked(user, insp.disputeId);
  return { insp, dispute };
}

export function updateDisputeInspection(
  user: User,
  inspectionId: string,
  input: {
    action: string; // schedule | complete | access-failed | cancel
    scheduledAt?: string | null;
    assignedInspectorUserId?: string | null;
    result?: string | null;
    notes?: string | null;
    followUp?: string | null;
  }
): DisputeInspectionRequest {
  const { insp, dispute } = getInspectionChecked(user, inspectionId);
  const isAssignedInspector = insp.assignedInspectorUserId === user.id;
  if (!isAssignedInspector) assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  const action = (input.action ?? "").trim().toLowerCase();
  const now = new Date().toISOString();
  drepo.withDisputeTx(() => {
    let ok = false;
    let detail = "";
    if (action === "schedule") {
      const scheduledAt = parseIsoDate(input.scheduledAt ?? null, "scheduledAt");
      if (!scheduledAt) throw new DisputeError("scheduledAt is required", 400);
      if (input.assignedInspectorUserId && !repo.getUser(input.assignedInspectorUserId)) {
        throw new DisputeError("assignedInspectorUserId does not exist", 422);
      }
      ok = drepo.transitionInspectionGuarded(insp.id, ["REQUESTED", "ACCESS_FAILED"], "SCHEDULED", {
        scheduledAt,
        assignedInspectorUserId: input.assignedInspectorUserId ?? undefined,
      });
      detail = `Inspection scheduled for ${scheduledAt}.`;
    } else if (action === "complete") {
      const result = (input.result ?? "").trim().toUpperCase();
      if (!["PASSED", "FAILED", "INCONCLUSIVE", "NOT_APPLICABLE"].includes(result)) {
        throw new DisputeError("result must be PASSED, FAILED, INCONCLUSIVE or NOT_APPLICABLE", 400);
      }
      ok = drepo.transitionInspectionGuarded(insp.id, ["SCHEDULED", "REQUESTED"], "COMPLETED", {
        completedAt: now,
        result,
        notes: (input.notes ?? "").toString().trim().slice(0, 2000) || undefined,
        followUp: (input.followUp ?? "").toString().trim().slice(0, 500) || undefined,
      });
      detail = `Inspection completed (${result}). Results are EVIDENCE — they never auto-resolve the dispute or authorize payment.`;
    } else if (action === "access-failed") {
      ok = drepo.transitionInspectionGuarded(insp.id, ["SCHEDULED", "REQUESTED"], "ACCESS_FAILED", {
        notes: (input.notes ?? "").toString().trim().slice(0, 2000) || undefined,
      });
      detail = "Inspection attempt failed (property access).";
    } else if (action === "cancel") {
      ok = drepo.transitionInspectionGuarded(insp.id, ["REQUESTED", "SCHEDULED", "ACCESS_FAILED"], "CANCELLED", {});
      detail = "Inspection request cancelled.";
    } else {
      throw new DisputeError("action must be schedule, complete, access-failed or cancel", 400);
    }
    if (!ok) throw new DisputeError(`The inspection cannot ${action} from status ${insp.status}`, 409);
    logEvent(dispute.id, "INSPECTION_UPDATED", detail, user.id, insp.id);
  });
  return drepo.getDisputeInspection(insp.id)!;
}

// ------------------------------------------------------ recommendations

export function recordRecommendation(
  user: User,
  disputeId: string,
  input: { kind: string; summary: string; basis?: string | null; aiGenerated?: boolean; supersedesRecommendationId?: string | null }
): DisputeRecommendation {
  const dispute = getDisputeChecked(user, disputeId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  const kinds = [
    "RECOMMEND_FULL_RELEASE", "RECOMMEND_PARTIAL_RELEASE", "RECOMMEND_CONTINUED_HOLD",
    "RECOMMEND_CORRECTIVE_WORK", "RECOMMEND_EXTERNAL_ESCALATION", "RECOMMEND_RETURN_CONSIDERATION",
  ];
  const kind = (input.kind ?? "").trim().toUpperCase();
  if (!kinds.includes(kind)) throw new DisputeError(`kind must be one of ${kinds.join(", ")}`, 400);
  const summary = (input.summary ?? "").trim();
  if (!summary) throw new DisputeError("A recommendation summary is required", 400);
  const aiGenerated = Boolean(input.aiGenerated);
  let supersedes: string | null = null;
  if (input.supersedesRecommendationId) {
    const prior = drepo.getRecommendation(input.supersedesRecommendationId);
    if (!prior || prior.disputeId !== dispute.id) throw new DisputeError("supersedesRecommendationId not found on this dispute", 422);
    supersedes = prior.id;
  }
  const now = new Date().toISOString();
  let created: DisputeRecommendation | null = null;
  drepo.withDisputeTx(() => {
    const rec: DisputeRecommendation = {
      id: drepo.newId(),
      disputeId: dispute.id,
      kind: kind as DisputeRecommendation["kind"],
      summary: summary.slice(0, 4000),
      basis: (input.basis ?? "").toString().trim().slice(0, 4000) || null,
      aiGenerated,
      // A human-authored recommendation is official on entry; AI-generated
      // content requires explicit human approval first.
      official: !aiGenerated,
      createdByUserId: user.id,
      approvedByUserId: aiGenerated ? null : user.id,
      supersedesRecommendationId: supersedes,
      createdAt: now,
    };
    drepo.insertRecommendation(rec);
    logEvent(dispute.id, "RECOMMENDATION_RECORDED", `${kind} recorded${aiGenerated ? " (AI-generated draft — human approval required before it is official)" : ""}. ${ADVISORY_NOTE}`, user.id, rec.id);
    created = rec;
  });
  return created!;
}

export function approveRecommendation(user: User, recommendationId: string): DisputeRecommendation {
  const rec = drepo.getRecommendation(recommendationId);
  if (!rec) throw new DisputeError("Recommendation not found", 404);
  const dispute = getDisputeChecked(user, rec.disputeId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  drepo.withDisputeTx(() => {
    if (!drepo.approveRecommendationGuarded(rec.id, user.id)) {
      throw new DisputeError("The recommendation is already official", 409);
    }
    logEvent(dispute.id, "RECOMMENDATION_APPROVED", "AI-generated recommendation reviewed and approved by a human reviewer.", user.id, rec.id);
  });
  return drepo.getRecommendation(rec.id)!;
}

// ------------------------------------------------------------ legal hold

export function setLegalHold(
  user: User,
  disputeId: string,
  input: { active: boolean; reason: string }
): Dispute {
  const dispute = getDisputeChecked(user, disputeId);
  assertCapability(user, dispute.projectId, "MANAGE_LEGAL_HOLD");
  const reason = (input.reason ?? "").trim();
  if (!reason) throw new DisputeError("A recorded reason is required", 400);
  if (!input.active) {
    // ELEVATED removal authorization: a compliance reviewer, or a user
    // holding MANAGE_LEGAL_HOLD through an explicit membership grant.
    const viaMembership = lenderAccess.capabilitiesFor(user, dispute.projectId).has("MANAGE_LEGAL_HOLD");
    if (user.role !== "COMPLIANCE_REVIEWER" && !viaMembership) {
      throw new DisputeError("Removing a legal hold requires elevated authorization (compliance reviewer or an explicit MANAGE_LEGAL_HOLD grant)", 403);
    }
  }
  const now = new Date().toISOString();
  drepo.withDisputeTx(() => {
    if (!drepo.setLegalHoldGuarded(dispute.id, input.active, user.id, reason.slice(0, 500), now)) {
      throw new DisputeError(input.active ? "A legal hold is already active" : "No legal hold is active", 409);
    }
    logEvent(
      dispute.id,
      input.active ? "LEGAL_HOLD_ACTIVATED" : "LEGAL_HOLD_REMOVED",
      `${input.active ? "Legal hold activated" : "Legal hold removed"}: ${reason.slice(0, 300)}. A legal-hold flag is a record-preservation and workflow control — not legal advice or a court order.`,
      user.id
    );
  });
  return drepo.getDispute(dispute.id)!;
}

// ------------------------------------------------------------ escalation

export function recordEscalation(
  user: User,
  disputeId: string,
  input: {
    escalationType: string;
    recipientName: string;
    recipientOrganization?: string | null;
    reason: string;
    transmittedMaterials?: string | null;
  }
): DisputeEscalation {
  const dispute = getDisputeChecked(user, disputeId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  const types = [
    "LENDER", "OWNER", "ATTORNEY", "INSURER", "SURETY", "INDEPENDENT_INSPECTOR",
    "EXTERNAL_REVIEWER", "ESCROW_PARTNER", "BANK_REPRESENTATIVE",
  ];
  const escalationType = (input.escalationType ?? "").trim().toUpperCase();
  if (!types.includes(escalationType)) throw new DisputeError(`escalationType must be one of ${types.join(", ")}`, 400);
  const recipientName = (input.recipientName ?? "").trim();
  const reason = (input.reason ?? "").trim();
  if (!recipientName || !reason) throw new DisputeError("recipientName and reason are required", 400);
  const now = new Date().toISOString();
  let created: DisputeEscalation | null = null;
  drepo.withDisputeTx(() => {
    const esc: DisputeEscalation = {
      id: drepo.newId(),
      disputeId: dispute.id,
      escalationType: escalationType as DisputeEscalation["escalationType"],
      recipientName: recipientName.slice(0, 200),
      recipientOrganization: (input.recipientOrganization ?? "").toString().trim().slice(0, 200) || null,
      reason: reason.slice(0, 1000),
      transmittedMaterials: (input.transmittedMaterials ?? "").toString().trim().slice(0, 2000) || null,
      status: "RECORDED",
      response: null,
      submittedByUserId: user.id,
      createdAt: now,
      respondedAt: null,
      closedAt: null,
    };
    drepo.insertEscalation(esc);
    logEvent(dispute.id, "ESCALATED", `Escalated to ${escalationType} (${recipientName}): ${reason.slice(0, 200)}`, user.id, esc.id);
    created = esc;
  });
  return created!;
}

export function updateEscalation(
  user: User,
  escalationId: string,
  input: { action: string; response?: string | null }
): DisputeEscalation {
  const esc = drepo.getEscalation(escalationId);
  if (!esc) throw new DisputeError("Escalation not found", 404);
  const dispute = getDisputeChecked(user, esc.disputeId);
  assertCapability(user, dispute.projectId, "MANAGE_DISPUTE");
  const action = (input.action ?? "").trim().toLowerCase();
  const now = new Date().toISOString();
  drepo.withDisputeTx(() => {
    let ok = false;
    if (action === "respond") {
      const response = (input.response ?? "").trim();
      if (!response) throw new DisputeError("A response body is required", 400);
      ok = drepo.transitionEscalationGuarded(esc.id, ["RECORDED"], "RESPONDED", { response: response.slice(0, 2000), respondedAt: now });
    } else if (action === "close") {
      ok = drepo.transitionEscalationGuarded(esc.id, ["RECORDED", "RESPONDED"], "CLOSED", { closedAt: now });
    } else {
      throw new DisputeError("action must be respond or close", 400);
    }
    if (!ok) throw new DisputeError(`The escalation cannot ${action} from status ${esc.status}`, 409);
    logEvent(dispute.id, "ESCALATION_UPDATED", `Escalation to ${esc.recipientName} ${action === "respond" ? "received a response" : "closed"}.`, user.id, esc.id);
  });
  return drepo.getEscalation(esc.id)!;
}

// ------------------------------------------------- authorized resolution

const RESOLUTION_TYPES: DisputeResolutionType[] = [
  "AUTHORIZE_FULL_RELEASE", "AUTHORIZE_PARTIAL_RELEASE", "CONTINUE_HOLD",
  "REQUIRE_ADDITIONAL_CURE", "ESCALATE_EXTERNALLY", "CLOSE_WITHOUT_RELEASE",
  "RETURN_TO_AUTHORIZED_PARTY",
];

const RESOLUTION_TARGET: Record<DisputeResolutionType, DisputeStatus> = {
  AUTHORIZE_FULL_RELEASE: "RESOLVED_RELEASE",
  AUTHORIZE_PARTIAL_RELEASE: "RESOLVED_PARTIAL_RELEASE",
  CONTINUE_HOLD: "RESOLVED_CONTINUE_HOLD",
  REQUIRE_ADDITIONAL_CURE: "CURE_IN_PROGRESS",
  ESCALATE_EXTERNALLY: "ESCALATED",
  CLOSE_WITHOUT_RELEASE: "RESOLVED_CONTINUE_HOLD",
  RETURN_TO_AUTHORIZED_PARTY: "RESOLVED_RETURN_RECOMMENDATION",
};

export function resolveDispute(
  user: User,
  disputeId: string,
  input: {
    resolutionType: string;
    amount?: unknown;
    reasoning: string;
    conditions?: string | null;
    evidenceIds?: string[] | null;
    externalReference?: string | null;
    acknowledged?: boolean;
  }
): Dispute {
  const dispute = getDisputeChecked(user, disputeId);
  const project = repo.getProject(dispute.projectId)!;
  assertCapability(user, dispute.projectId, "DECIDE_DISPUTE");

  // Separation of duties: the opener never decides their own dispute.
  if (dispute.openedByUserId === user.id) {
    throw new DisputeError("The dispute opener cannot record its final resolution", 403);
  }
  if (input.acknowledged !== true && String(input.acknowledged) !== "true") {
    throw new DisputeError("The resolution acknowledgement is required: " + RESOLUTION_ACKNOWLEDGEMENT, 400);
  }
  const resolutionType = (input.resolutionType ?? "").trim().toUpperCase() as DisputeResolutionType;
  if (!RESOLUTION_TYPES.includes(resolutionType)) {
    throw new DisputeError(`resolutionType must be one of ${RESOLUTION_TYPES.join(", ")}`, 400);
  }
  const reasoning = (input.reasoning ?? "").trim();
  if (!reasoning) throw new DisputeError("Written reasoning is required for a resolution", 400);
  const amount = wholeAmount(input.amount ?? null, "amount");

  // -------- full revalidation INSIDE the write lock --------
  const now = new Date().toISOString();
  drepo.withDisputeTx(() => {
    const fresh = drepo.getDispute(dispute.id)!;
    if (!DECISION_READY.includes(fresh.status)) {
      throw new DisputeError(`A resolution requires the dispute to be READY_FOR_DECISION or ESCALATED (current: ${fresh.status})`, 409);
    }
    if (fresh.legalHold) {
      throw new DisputeError("Legal hold active — no resolution can be recorded until it is removed", 409);
    }
    // Required evidence: every PENDING evidence record must be reviewed.
    const pendingEvidence = drepo.listDisputeEvidence(fresh.id).filter((e) => e.reviewStatus === "PENDING");
    if (pendingEvidence.length > 0) {
      throw new DisputeError(`${pendingEvidence.length} evidence record(s) are still awaiting review`, 409);
    }
    // Cure requirements: for release-type resolutions, every cure item
    // must be terminal (accepted / waived / cancelled).
    const cures = drepo.listCureItems(fresh.id);
    const unresolvedCures = cures.filter((c) => !["ACCEPTED", "WAIVED", "CANCELLED"].includes(c.status));
    if (["AUTHORIZE_FULL_RELEASE", "AUTHORIZE_PARTIAL_RELEASE"].includes(resolutionType) && unresolvedCures.length > 0) {
      throw new DisputeError(`${unresolvedCures.length} cure requirement(s) are not accepted, waived or cancelled`, 409);
    }
    // Inspection requirements: no inspection may be in flight.
    const openInspections = drepo.listDisputeInspections(fresh.id).filter((i) => ["REQUESTED", "SCHEDULED"].includes(i.status));
    if (openInspections.length > 0) {
      throw new DisputeError(`${openInspections.length} inspection request(s) are still open`, 409);
    }
    // Amounts.
    if (resolutionType === "AUTHORIZE_PARTIAL_RELEASE") {
      if (amount === null || amount <= 0) throw new DisputeError("A positive partial-release amount is required", 400);
      const cap = fresh.undisputedAmount ?? 0;
      if (amount > cap) {
        throw new DisputeError(`The partial-release amount (${amount}) exceeds the recorded undisputed amount (${cap})`, 409);
      }
    }
    // Existing construction eligibility gates for release-type
    // resolutions on draw-attached disputes: the EXISTING authoritative
    // boundary must pass for the underlying draw, ignoring only this
    // dispute's own hold. Nothing is released automatically — this only
    // validates that a release decision is not recorded against a draw
    // that the existing controls would refuse anyway.
    if (["AUTHORIZE_FULL_RELEASE", "AUTHORIZE_PARTIAL_RELEASE"].includes(resolutionType) && fresh.drawRequestId) {
      const draw = repo.getDrawRequest(fresh.drawRequestId);
      if (draw) {
        // Lazy import breaks the banking→disputes→banking cycle at module
        // load time; the call itself is a pure read.
        const { paymentEligibility } = require("./banking/paymentInstructions") as typeof import("./banking/paymentInstructions");
        const account = brepo.getOpenAccountForProject(draw.projectId);
        const gate = paymentEligibility(draw, account, null, { ignoreDisputeId: fresh.id });
        if (!gate.eligible) {
          throw new DisputeError(`The underlying draw does not pass the existing release-eligibility gates: ${gate.blockers[0]}`, 409);
        }
      }
    }
    // Evidence relied upon must belong to this dispute.
    const evidenceIds = Array.isArray(input.evidenceIds) ? input.evidenceIds.map(String) : [];
    for (const id of evidenceIds) {
      const ev = drepo.getDisputeEvidence(id);
      if (!ev || ev.disputeId !== fresh.id) throw new DisputeError(`Evidence ${id} does not belong to this dispute`, 422);
    }
    const target = RESOLUTION_TARGET[resolutionType];
    const isResolved = RESOLVED_STATUSES.includes(target);
    const user2 = repo.getUser(user.id)!;
    if (
      !drepo.transitionDisputeGuarded(fresh.id, DECISION_READY, target, isResolved ? {
        resolutionType,
        resolutionAmount: amount ?? undefined,
        resolutionReasoning: reasoning.slice(0, 4000),
        resolutionConditions: (input.conditions ?? "").toString().trim().slice(0, 2000) || undefined,
        resolutionEvidenceIds: JSON.stringify(evidenceIds),
        resolutionExternalReference: (input.externalReference ?? "").toString().trim().slice(0, 200) || undefined,
        resolvedByUserId: user.id,
        resolvedByRole: user.role,
        resolvedByOrganizationId: user2.organizationId,
        resolvedAt: now,
      } : {})
    ) {
      throw new DisputeError("The dispute was transitioned concurrently — reload and retry", 409);
    }
    logEvent(
      fresh.id,
      "RESOLVED",
      `${resolutionType}${amount !== null ? ` (${amount})` : ""} recorded by ${user2.name} (${user.role}). ${RESOLUTION_ACKNOWLEDGEMENT}`,
      user.id
    );
  });
  return drepo.getDispute(dispute.id)!;
}

export function closeDispute(user: User, disputeId: string, note?: string | null): Dispute {
  const dispute = getDisputeChecked(user, disputeId);
  assertCapability(user, dispute.projectId, "DECIDE_DISPUTE");
  drepo.withDisputeTx(() => {
    const fresh = drepo.getDispute(dispute.id)!;
    if (fresh.legalHold) {
      throw new DisputeError("Legal Hold Active — the dispute cannot be closed until the hold is removed", 409);
    }
    if (!RESOLVED_STATUSES.includes(fresh.status)) {
      throw new DisputeError("Only a resolved dispute can be closed", 409);
    }
    if (!drepo.transitionDisputeGuarded(fresh.id, RESOLVED_STATUSES, "CLOSED", { closedAt: new Date().toISOString() })) {
      throw new DisputeError("The dispute was transitioned concurrently — reload and retry", 409);
    }
    logEvent(fresh.id, "CLOSED", `Dispute closed${note ? `: ${String(note).slice(0, 200)}` : ""}.`, user.id);
  });
  return drepo.getDispute(dispute.id)!;
}

// ------------------------------------------------------------ read model

export function disputeDetail(user: User, disputeId: string) {
  const dispute = getDisputeChecked(user, disputeId);
  const cures = drepo.listCureItems(dispute.id);
  return {
    dispute,
    events: drepo.listDisputeEvents(dispute.id),
    responses: drepo.listDisputeResponses(dispute.id),
    evidence: drepo.listDisputeEvidence(dispute.id),
    cures: cures.map((c) => ({ ...c, overdue: cureIsOverdue(c), extensions: drepo.listCureExtensions(c.id) })),
    inspections: drepo.listDisputeInspections(dispute.id),
    recommendations: drepo.listRecommendations(dispute.id),
    escalations: drepo.listEscalations(dispute.id),
    caps: [...disputeCapabilitiesFor(user, dispute.projectId)],
    allowedTransitions: DISPUTE_TRANSITIONS[dispute.status] ?? [],
  };
}

export function listProjectDisputes(user: User, projectId: string): Dispute[] {
  const project = assertProjectAccess(user, projectId);
  return drepo.listDisputesForProject(project.id);
}
