/**
 * Change Order Management — governed construction change control.
 *
 * A SUBMITTED change order never modifies budget or milestone
 * configuration. Only formal governance — an ApprovalRequest with the
 * project's approval matrix (at least two distinct roles), one decision
 * per role, no submitter self-approval — can approve it, and only the
 * completed-approval path applies the impact: transactionally, with a
 * configuration audit event and a new configuration snapshot/version
 * linked back to the change order. There is no direct state-edit
 * endpoint, and historic evidence keeps the configuration/policy version
 * it was evaluated under (verifications are never rewritten).
 */
import * as repo from "../db/repo";
import { getDb } from "../db/index";
import { audit, snapshotProject } from "./pilot/onboarding";
import { canAccessProjectFinance, canManageBudget } from "./budgetProgress";
import { mirrorEvent } from "./chat";
import { teamsNotifier } from "./TeamsNotifier";
import type {
  ApprovalRecord,
  ApprovalRequest,
  ChangeOrder,
  ChangeOrderAllocation,
  ChangeOrderEvent,
  ChangeOrderReason,
  User,
  UserRole,
} from "../../shared/types";

export class ChangeOrderError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

const money = (n: number) => "$" + n.toLocaleString("en-US");
const EDITABLE = ["DRAFT", "CLARIFICATION_REQUIRED"];
const REVIEWABLE = ["SUBMITTED", "UNDER_REVIEW"];

function getOr404(id: string, user?: User): ChangeOrder {
  const co = repo.getChangeOrder(id);
  if (!co) throw new ChangeOrderError("Change order not found", 404);
  if (user) {
    const project = repo.getProject(co.projectId);
    if (!project || !canAccessProjectFinance(user, project)) {
      throw new ChangeOrderError("Change order not found", 404);
    }
  }
  return co;
}

function event(
  changeOrderId: string,
  type: ChangeOrderEvent["type"],
  detail: string,
  actorUserId: string | null
): void {
  repo.insertCoEvent({
    id: repo.newId(),
    changeOrderId,
    type,
    detail,
    actorUserId,
    createdAt: new Date().toISOString(),
  });
}

/** Change orders are managed by non-field roles with project access. */
export function canManageChangeOrders(user: User): boolean {
  return user.role !== "FIELD";
}

// ------------------------------------------------------------ lifecycle

export function createChangeOrder(
  user: User,
  input: {
    projectId: string;
    title: string;
    description?: string;
    reasonCategory: ChangeOrderReason;
    requestedAmount?: number;
    scheduleImpactDays?: number | null;
    affectedMilestoneIds?: string[];
  }
): ChangeOrder {
  const project = repo.getProject(input.projectId);
  if (!project) throw new ChangeOrderError("Unknown project", 404);
  if (!canAccessProjectFinance(user, project)) throw new ChangeOrderError("Unknown project", 404);
  if (!canManageChangeOrders(user)) throw new ChangeOrderError("Not authorized to raise change orders", 403);
  const title = (input.title ?? "").trim();
  if (!title) throw new ChangeOrderError("A change order title is required");
  const requestedAmount = Math.round(Number(input.requestedAmount ?? 0));
  if (!Number.isFinite(requestedAmount)) throw new ChangeOrderError("requestedAmount must be a number");
  const affectedMilestoneIds = (input.affectedMilestoneIds ?? []).filter(Boolean);
  for (const id of affectedMilestoneIds) {
    if (repo.getMilestone(id)?.projectId !== project.id) {
      throw new ChangeOrderError("Affected milestones must belong to the project");
    }
  }
  const now = new Date().toISOString();
  const co: ChangeOrder = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    changeOrderNumber: repo.nextChangeOrderNumber(project.id),
    title,
    description: input.description?.trim() ?? "",
    reasonCategory: input.reasonCategory,
    requestedByUserId: user.id,
    requestedAt: null,
    requestedAmount,
    approvedAmount: null,
    currency: project.pilot?.currency ?? "USD",
    scheduleImpactDays:
      input.scheduleImpactDays != null ? Math.round(Number(input.scheduleImpactDays)) : null,
    status: "DRAFT",
    affectedMilestoneIds,
    affectedBudgetLineIds: [],
    appliedAt: null,
    appliedSnapshotVersion: null,
    createdAt: now,
    updatedAt: now,
    supportingDocumentCount: 0,
  };
  repo.insertChangeOrder(co);
  event(co.id, "CREATED", `Draft change order CO-${co.changeOrderNumber} created by ${user.name}: "${title}" (${money(requestedAmount)} requested).`, user.id);
  return repo.getChangeOrder(co.id)!;
}

export function allocate(
  user: User,
  changeOrderId: string,
  input: { budgetLineId: string; amount: number; note?: string | null }
): ChangeOrderAllocation {
  const co = getOr404(changeOrderId, user);
  if (!EDITABLE.includes(co.status)) {
    throw new ChangeOrderError(`A ${co.status} change order can no longer be edited`, 409);
  }
  const line = repo.getBudgetLine(input.budgetLineId);
  if (!line || line.projectId !== co.projectId) {
    throw new ChangeOrderError("budgetLineId must reference a budget line of the project");
  }
  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount === 0) throw new ChangeOrderError("Allocation amount must be a non-zero number");
  const allocation: ChangeOrderAllocation = {
    id: repo.newId(),
    changeOrderId: co.id,
    budgetLineId: line.id,
    amount,
    note: input.note?.trim() || null,
  };
  repo.insertCoAllocation(allocation);
  repo.updateChangeOrder(co.id, {
    affectedBudgetLineIds: [...new Set([...co.affectedBudgetLineIds, line.id])],
  });
  event(co.id, "UPDATED", `Allocation added by ${user.name}: ${money(amount)} to ${line.code} ${line.category}.`, user.id);
  return allocation;
}

export function addDocument(
  user: User,
  changeOrderId: string,
  input: { title: string; docType?: string; note?: string | null }
): void {
  const co = getOr404(changeOrderId, user);
  if (!EDITABLE.includes(co.status) && !REVIEWABLE.includes(co.status)) {
    throw new ChangeOrderError(`A ${co.status} change order can no longer receive documents`, 409);
  }
  const title = (input.title ?? "").trim();
  if (!title) throw new ChangeOrderError("Document title is required");
  repo.insertCoDocument({
    id: repo.newId(),
    changeOrderId: co.id,
    title,
    docType: input.docType?.trim() || "OTHER",
    note: input.note?.trim() || null,
    uploadedByUserId: user.id,
    createdAt: new Date().toISOString(),
  });
  event(co.id, "UPDATED", `Supporting document recorded: "${title}".`, user.id);
}

export function reconcileAllocations(co: ChangeOrder): { total: number; reconciled: boolean } {
  const total = repo.listCoAllocations(co.id).reduce((s, a) => s + a.amount, 0);
  return { total, reconciled: total === co.requestedAmount };
}

export function submitChangeOrder(user: User, changeOrderId: string): ChangeOrder {
  const co = getOr404(changeOrderId, user);
  if (!EDITABLE.includes(co.status)) throw new ChangeOrderError(`A ${co.status} change order cannot be submitted`, 409);
  if (co.requestedAmount !== 0) {
    const rec = reconcileAllocations(co);
    if (!rec.reconciled) {
      throw new ChangeOrderError(
        `Budget allocations (${money(rec.total)}) must reconcile exactly to the requested amount (${money(co.requestedAmount)})`,
        422
      );
    }
  }
  repo.updateChangeOrder(co.id, { status: "SUBMITTED", requestedAt: new Date().toISOString() });
  event(co.id, "SUBMITTED", `CO-${co.changeOrderNumber} submitted by ${user.name}. A submitted change order does not modify budget or milestone configuration — only formal approval can.`, user.id);
  mirrorEvent(
    `Change order CO-${co.changeOrderNumber} "${co.title}" submitted — ${money(co.requestedAmount)} requested. Configuration is unchanged until formal approval.`,
    { projectId: co.projectId }
  );
  return repo.getChangeOrder(co.id)!;
}

export function requestClarification(user: User, changeOrderId: string, question: string): ChangeOrder {
  const co = getOr404(changeOrderId, user);
  if (!REVIEWABLE.includes(co.status)) throw new ChangeOrderError(`A ${co.status} change order cannot enter clarification`, 409);
  const q = question.trim();
  if (!q) throw new ChangeOrderError("A clarification question is required");
  repo.updateChangeOrder(co.id, { status: "CLARIFICATION_REQUIRED" });
  event(co.id, "CLARIFICATION_REQUESTED", `Clarification requested by ${user.name}: ${q}`, user.id);
  return repo.getChangeOrder(co.id)!;
}

export function cancelChangeOrder(user: User, changeOrderId: string): ChangeOrder {
  const co = getOr404(changeOrderId, user);
  if (!["DRAFT", "SUBMITTED", "CLARIFICATION_REQUIRED"].includes(co.status)) {
    throw new ChangeOrderError(`A ${co.status} change order cannot be cancelled`, 409);
  }
  repo.updateChangeOrder(co.id, { status: "CANCELLED" });
  event(co.id, "CANCELLED", `Cancelled by ${user.name}.`, user.id);
  return repo.getChangeOrder(co.id)!;
}

export function markImplemented(user: User, changeOrderId: string, note?: string | null): ChangeOrder {
  const co = getOr404(changeOrderId, user);
  if (co.status !== "APPROVED" && co.status !== "PARTIALLY_APPROVED") {
    throw new ChangeOrderError("Only an approved change order can be marked implemented", 409);
  }
  repo.updateChangeOrder(co.id, { status: "IMPLEMENTED" });
  event(co.id, "IMPLEMENTED", `Implementation confirmed by ${user.name}${note?.trim() ? `: ${note.trim()}` : ""}.`, user.id);
  return repo.getChangeOrder(co.id)!;
}

// --------------------------------------------------------- impact preview

export interface ChangeOrderImpactPreview {
  currentProjectBudget: number;
  requestedChange: number;
  projectedRevisedBudget: number;
  currentCompletionDate: string | null;
  scheduleImpactDays: number | null;
  projectedRevisedCompletion: string | null;
  affectedMilestones: Array<{ id: string; label: string; plannedEnd: string | null; projectedEnd: string | null }>;
  affectedBudgetLines: Array<{ id: string; code: string; category: string; currentBudget: number; allocation: number; projectedBudget: number }>;
  affectedEvidenceRequirements: Array<{ milestoneId: string; count: number }>;
  preview: true;
}

/** PREVIEW ONLY — computes what approval would change without touching
 *  any configuration. */
export function impactPreview(changeOrderId: string): ChangeOrderImpactPreview {
  const co = repo.getChangeOrder(changeOrderId);
  if (!co) throw new ChangeOrderError("Change order not found", 404);
  const lines = repo.listBudgetLines(co.projectId).filter((l) => l.active);
  const currentProjectBudget = lines.length
    ? lines.reduce((s, l) => s + l.currentBudget, 0)
    : repo.getProject(co.projectId)!.totalBudget;
  const allocations = repo.listCoAllocations(co.id);
  const byLine = new Map<string, number>();
  for (const a of allocations) byLine.set(a.budgetLineId, (byLine.get(a.budgetLineId) ?? 0) + a.amount);

  const milestones = co.affectedMilestoneIds
    .map((id) => repo.getMilestone(id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));
  const shift = (iso: string | null): string | null =>
    iso && co.scheduleImpactDays
      ? new Date(Date.parse(iso) + co.scheduleImpactDays * 86_400_000).toISOString().slice(0, 10)
      : iso;
  const allPlannedEnds = repo
    .listMilestones(co.projectId)
    .map((m) => m.plannedEnd)
    .filter((d): d is string => Boolean(d))
    .sort();
  const currentCompletionDate = allPlannedEnds.length ? allPlannedEnds[allPlannedEnds.length - 1] : null;

  return {
    currentProjectBudget,
    requestedChange: co.requestedAmount,
    projectedRevisedBudget: currentProjectBudget + co.requestedAmount,
    currentCompletionDate,
    scheduleImpactDays: co.scheduleImpactDays,
    projectedRevisedCompletion:
      currentCompletionDate && co.scheduleImpactDays
        ? shift(currentCompletionDate)
        : currentCompletionDate,
    affectedMilestones: milestones.map((m) => ({
      id: m.id,
      label: `M${m.seq} · ${m.title}`,
      plannedEnd: m.plannedEnd?.slice(0, 10) ?? null,
      projectedEnd: shift(m.plannedEnd ?? null),
    })),
    affectedBudgetLines: [...byLine.entries()].map(([lineId, allocation]) => {
      const line = repo.getBudgetLine(lineId)!;
      return {
        id: line.id, code: line.code, category: line.category,
        currentBudget: line.currentBudget, allocation,
        projectedBudget: line.currentBudget + allocation,
      };
    }),
    affectedEvidenceRequirements: co.affectedMilestoneIds.map((id) => ({
      milestoneId: id,
      count: repo.listRequirementsForMilestone(id).length,
    })),
    preview: true,
  };
}

// ------------------------------------------------------------ governance

/** Approval matrix: project default policy, else two distinct roles. */
export function resolveChangeOrderRoles(projectId: string): UserRole[] {
  const projectDefault = repo.listApprovalPolicies(projectId).find((p) => p.milestoneId === null);
  if (projectDefault && projectDefault.requiredRoles.length >= 2) return projectDefault.requiredRoles;
  return ["FUNDER_REP", "COMPLIANCE_REVIEWER"];
}

export function sendToGovernance(
  user: User,
  changeOrderId: string,
  approvedAmount?: number | null
): { changeOrder: ChangeOrder; approvalRequest: ApprovalRequest } {
  const co = getOr404(changeOrderId, user);
  if (!canManageBudget(user)) {
    throw new ChangeOrderError("Sending a change order to governance requires a lender review role", 403);
  }
  if (!REVIEWABLE.includes(co.status)) {
    throw new ChangeOrderError(`A ${co.status} change order cannot be sent to governance`, 409);
  }
  const proposed = approvedAmount != null ? Math.round(Number(approvedAmount)) : co.requestedAmount;
  if (!Number.isFinite(proposed)) throw new ChangeOrderError("approvedAmount must be a number");
  repo.updateChangeOrder(co.id, { status: "UNDER_REVIEW", approvedAmount: proposed });
  let approvalRequest = repo.getApprovalRequestForChangeOrder(co.id);
  if (!approvalRequest || approvalRequest.status !== "PENDING") {
    approvalRequest = {
      id: repo.newId(),
      milestoneId: null,
      drawRequestId: null,
      changeOrderId: co.id,
      retainageReleaseId: null,
      subjectType: "CHANGE_ORDER",
      status: "PENDING",
      requiredRoles: resolveChangeOrderRoles(co.projectId),
      createdAt: new Date().toISOString(),
    };
    repo.insertApprovalRequest(approvalRequest);
  }
  event(
    co.id,
    "SENT_TO_GOVERNANCE",
    `Formal approval opened by ${user.name} — requires ${approvalRequest.requiredRoles.join(" + ")} for ${money(proposed)}${proposed !== co.requestedAmount ? ` (of ${money(co.requestedAmount)} requested)` : ""}. Configuration remains unchanged until every required role approves.`,
    user.id
  );
  return { changeOrder: repo.getChangeOrder(co.id)!, approvalRequest };
}

export interface ChangeOrderDecisionResult {
  approvalRequest: ApprovalRequest;
  records: ApprovalRecord[];
  changeOrder: ChangeOrder;
  applied: boolean;
}

/**
 * Human governance decision on a CHANGE_ORDER-subject ApprovalRequest.
 * One decision per required role; the submitter can never approve their
 * own change order. Completion applies the approved impact exactly once.
 */
export async function processChangeOrderApprovalDecision(
  approvalRequestId: string,
  userId: string,
  decision: "APPROVED" | "REJECTED"
): Promise<ChangeOrderDecisionResult> {
  const request = repo.getApprovalRequest(approvalRequestId);
  if (!request || !request.changeOrderId || request.subjectType !== "CHANGE_ORDER") {
    throw new ChangeOrderError("Unknown change order approval request", 404);
  }
  if (request.status !== "PENDING") {
    throw new ChangeOrderError("This approval request has already been resolved", 409);
  }
  const user = repo.getUser(userId);
  if (!user) throw new ChangeOrderError("Select a demo user first", 401);
  const co = getOr404(request.changeOrderId, user);
  if (!request.requiredRoles.includes(user.role)) {
    throw new ChangeOrderError(
      `Role ${user.role} is not part of this approval (requires ${request.requiredRoles.join(", ")})`,
      403
    );
  }
  const existing = repo.listApprovalRecordsForRequest(request.id);
  if (existing.some((r) => r.role === user.role)) {
    throw new ChangeOrderError(`A ${user.role} decision has already been recorded`, 409);
  }
  // Separation of duties: the change order submitter never self-approves.
  if (co.requestedByUserId === user.id) {
    throw new ChangeOrderError("Separation of duties: the change order submitter cannot approve their own change order", 403);
  }

  repo.insertApprovalRecord({
    id: repo.newId(),
    approvalRequestId: request.id,
    userId: user.id,
    role: user.role,
    decision,
    createdAt: new Date().toISOString(),
  });
  const records = repo.listApprovalRecordsForRequest(request.id);
  let applied = false;

  if (decision === "REJECTED") {
    repo.updateApprovalRequestStatus(request.id, "REJECTED");
    repo.updateChangeOrder(co.id, { status: "REJECTED", approvedAmount: null });
    event(co.id, "GOVERNANCE_DECISION", `${user.name} (${user.title}) rejected CO-${co.changeOrderNumber}. Configuration unchanged.`, user.id);
  } else {
    const approvedRoles = new Set(records.filter((r) => r.decision === "APPROVED").map((r) => r.role));
    const complete = request.requiredRoles.every((role) => approvedRoles.has(role));
    if (complete) {
      repo.updateApprovalRequestStatus(request.id, "APPROVED");
      const finalAmount = co.approvedAmount ?? co.requestedAmount;
      const partial = finalAmount !== co.requestedAmount;
      repo.updateChangeOrder(co.id, { status: partial ? "PARTIALLY_APPROVED" : "APPROVED" });
      event(
        co.id,
        "GOVERNANCE_DECISION",
        `All required approvals complete (${request.requiredRoles.join(" + ")}). CO-${co.changeOrderNumber} ${partial ? "partially approved" : "approved"} for ${money(finalAmount)}.`,
        user.id
      );
      applyApprovedChangeOrder(repo.getChangeOrder(co.id)!, user);
      applied = true;
      await teamsNotifier.notify(
        "CHANGE_ORDER_APPROVED",
        `Change order CO-${co.changeOrderNumber} approved for ${money(finalAmount)} and applied (audited, new configuration version).`,
        { projectId: co.projectId }
      );
      mirrorEvent(
        `Change order CO-${co.changeOrderNumber} approved for ${money(finalAmount)} — configuration updated with a new audited snapshot version.`,
        { projectId: co.projectId }
      );
    } else {
      const missing = request.requiredRoles.filter((role) => !approvedRoles.has(role));
      event(
        co.id,
        "GOVERNANCE_DECISION",
        `${user.name} (${user.title}) approved CO-${co.changeOrderNumber} (${approvedRoles.size} of ${request.requiredRoles.length}). Awaiting ${missing.join(", ")}. Configuration unchanged.`,
        user.id
      );
    }
  }

  return {
    approvalRequest: repo.getApprovalRequest(request.id)!,
    records,
    changeOrder: repo.getChangeOrder(co.id)!,
    applied,
  };
}

/**
 * APPLY THE APPROVED IMPACT — exactly once, transactionally:
 * allocations scale to the approved amount and land in each line's
 * approvedChanges (currentBudget recalculates by derivation); approved
 * schedule impact shifts affected milestones' planned dates; a
 * configuration audit event and a new configuration snapshot/version are
 * recorded and linked to the change order. Historic evidence keeps its
 * original policy/config version — nothing about verification is touched.
 */
function applyApprovedChangeOrder(co: ChangeOrder, actor: User): void {
  if (co.appliedAt) throw new ChangeOrderError("This change order has already been applied", 409);
  const project = repo.getProject(co.projectId)!;
  const finalAmount = co.approvedAmount ?? co.requestedAmount;
  const scale = co.requestedAmount !== 0 ? finalAmount / co.requestedAmount : 0;
  const allocations = repo.listCoAllocations(co.id);
  const db = getDb();
  db.exec("BEGIN");
  try {
    // budget: approvedChanges per allocation (scaled to approved amount;
    // rounding remainder lands on the last allocation so Σ = approved).
    let appliedSum = 0;
    allocations.forEach((a, i) => {
      const line = repo.getBudgetLine(a.budgetLineId)!;
      const portion =
        i === allocations.length - 1 ? finalAmount - appliedSum : Math.round(a.amount * scale);
      appliedSum += portion;
      repo.updateBudgetLine(line.id, { approvedChanges: line.approvedChanges + portion });
    });
    // schedule: shift approved planned dates on affected milestones.
    if (co.scheduleImpactDays) {
      for (const milestoneId of co.affectedMilestoneIds) {
        const m = repo.getMilestone(milestoneId);
        if (!m?.plannedEnd) continue;
        repo.updateMilestoneFields(milestoneId, {
          plannedEnd: new Date(Date.parse(m.plannedEnd) + co.scheduleImpactDays * 86_400_000)
            .toISOString()
            .slice(0, 10),
        });
      }
    }
    // audited configuration version + snapshot linked to the CO.
    const nextVersion = (project.pilot?.configVersion ?? 1) + 1;
    repo.updateProjectFields(project.id, { configVersion: nextVersion });
    const snapshot = snapshotProject(
      project.id,
      `Change order CO-${co.changeOrderNumber} applied: ${co.title} (${money(finalAmount)})`,
      actor
    );
    repo.updateChangeOrder(co.id, {
      appliedAt: new Date().toISOString(),
      appliedSnapshotVersion: snapshot.version,
    });
    audit({
      projectId: project.id,
      actorUserId: actor.id,
      action: "CHANGE_ORDER_APPLIED",
      entityType: "change_order",
      entityId: co.id,
      reason: `CO-${co.changeOrderNumber}: ${co.title}`,
      beforeSummary: `configVersion ${project.pilot?.configVersion ?? 1}`,
      afterSummary: `configVersion ${nextVersion} · snapshot v${snapshot.version} · ${money(finalAmount)} applied across ${allocations.length} budget line(s)${co.scheduleImpactDays ? ` · +${co.scheduleImpactDays}d schedule` : ""}`,
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  event(
    co.id,
    "APPLIED",
    `Approved impact applied transactionally: ${money(finalAmount)} across ${allocations.length} budget line(s)${co.scheduleImpactDays ? `, +${co.scheduleImpactDays} day(s) on affected milestones` : ""}; configuration snapshot v${repo.getChangeOrder(co.id)!.appliedSnapshotVersion} recorded.`,
    actor.id
  );
}

// -------------------------------------------------------------- queries

export function listChangeOrdersForUser(user: User): ChangeOrder[] {
  const projects = new Map(repo.listProjects().map((p) => [p.id, p]));
  return repo.listChangeOrders().filter((co) => {
    const project = projects.get(co.projectId);
    return project && canAccessProjectFinance(user, project);
  });
}

/** Approved change-order totals for contract-value displays. */
export function approvedChangeTotal(projectId: string): number {
  return repo
    .listChangeOrdersForProject(projectId)
    .filter((co) => ["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(co.status))
    .reduce((s, co) => s + (co.approvedAmount ?? 0), 0);
}

export function nextAction(co: ChangeOrder): string {
  switch (co.status) {
    case "DRAFT": return "Complete allocations and submit";
    case "SUBMITTED": return "Review and send to governance";
    case "UNDER_REVIEW": return "Awaiting formal approvals";
    case "CLARIFICATION_REQUIRED": return "Awaiting requester response";
    case "APPROVED":
    case "PARTIALLY_APPROVED": return "Track implementation";
    case "IMPLEMENTED": return "Complete — no action";
    case "REJECTED": return "Rejected — revise or close out";
    case "CANCELLED": return "Cancelled — no action";
  }
}
