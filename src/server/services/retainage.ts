/**
 * Retainage control — transparent withholding and separately governed
 * release.
 *
 * Retainage is financial-control state on the virtual project account —
 * not real bank movement. The percent comes from a configurable project
 * policy (clamped to safe bounds; no policy = 0%, nothing is withheld
 * silently). Withholding is recorded ONLY inside the governed draw
 * release transition, and releasing retainage requires its own
 * RetainageReleaseRequest whose required conditions are satisfied and
 * whose RETAINAGE ApprovalRequest completes — exactly once, through the
 * VirtualAccountService. Retainage is NEVER released automatically.
 */
import * as repo from "../db/repo";
import { audit } from "./pilot/onboarding";
import { canAccessProjectFinance, canManageBudget } from "./budgetProgress";
import { virtualAccountService } from "./VirtualAccountService";
import type {
  ApprovalRecord,
  ApprovalRequest,
  RetainageCondition,
  RetainageConditionType,
  RetainagePolicy,
  RetainageReleaseRequest,
  RetainageSummary,
  User,
  UserRole,
} from "../../shared/types";

export class RetainageError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

const money = (n: number) => "$" + n.toLocaleString("en-US");

/** Safe policy bounds: 0–20%. Draw-level overrides clamp the same way. */
export const RETAINAGE_MIN_PCT = 0;
export const RETAINAGE_MAX_PCT = 20;
export const clampRetainage = (pct: number): number =>
  Math.min(RETAINAGE_MAX_PCT, Math.max(RETAINAGE_MIN_PCT, Math.round(pct * 10) / 10));

export const DEFAULT_CONDITIONS: RetainageConditionType[] = [
  "FINAL_LIEN_WAIVER",
  "CERTIFICATE_OF_COMPLETION",
  "ALL_EXCEPTIONS_RESOLVED",
];

export const ALL_CONDITIONS: RetainageConditionType[] = [
  "SUBSTANTIAL_COMPLETION", "FINAL_COMPLETION", "PUNCH_LIST_CLOSURE",
  "FINAL_LIEN_WAIVER", "CERTIFICATE_OF_COMPLETION", "FINAL_INSPECTION",
  "ALL_EXCEPTIONS_RESOLVED",
];

// ------------------------------------------------------------ policy

export function effectivePolicy(projectId: string): RetainagePolicy {
  return (
    repo.getRetainagePolicy(projectId) ?? {
      projectId,
      retainagePercent: 0,
      requiredConditions: DEFAULT_CONDITIONS,
      updatedAt: "",
      updatedBy: null,
    }
  );
}

export function setPolicy(
  user: User,
  input: { projectId: string; retainagePercent: number; requiredConditions?: RetainageConditionType[] }
): RetainagePolicy {
  const project = repo.getProject(input.projectId);
  if (!project || !canAccessProjectFinance(user, project)) throw new RetainageError("Unknown project", 404);
  if (!canManageBudget(user)) throw new RetainageError("Retainage policy requires a lender review role", 403);
  const pct = clampRetainage(Number(input.retainagePercent));
  if (!Number.isFinite(pct)) throw new RetainageError("retainagePercent must be a number");
  const conditions = (input.requiredConditions ?? DEFAULT_CONDITIONS).filter((c) =>
    ALL_CONDITIONS.includes(c)
  );
  const before = repo.getRetainagePolicy(project.id);
  repo.upsertRetainagePolicy({
    projectId: project.id,
    retainagePercent: pct,
    requiredConditions: conditions,
    updatedAt: new Date().toISOString(),
    updatedBy: user.id,
  });
  audit({
    projectId: project.id, actorUserId: user.id, action: "RETAINAGE_POLICY_SET",
    entityType: "retainage_policy", entityId: project.id, reason: null,
    beforeSummary: before ? `${before.retainagePercent}%` : "no policy (0%)",
    afterSummary: `${pct}% · conditions: ${conditions.join(", ")}`,
  });
  return repo.getRetainagePolicy(project.id)!;
}

/** Rate for a draw: bounded draw override (if any) else project policy. */
export function rateForDraw(projectId: string, drawOverridePct?: number | null): number {
  if (drawOverridePct != null && Number.isFinite(Number(drawOverridePct))) {
    return clampRetainage(Number(drawOverridePct));
  }
  return effectivePolicy(projectId).retainagePercent;
}

/** Gross → retainage → net arithmetic (transparent, deterministic). */
export function computeRetainage(gross: number, ratePct: number): {
  gross: number;
  ratePct: number;
  withheld: number;
  netEligible: number;
} {
  const withheld = Math.round((gross * ratePct) / 100);
  return { gross, ratePct, withheld, netEligible: gross - withheld };
}

// ------------------------------------------------------------ summary

export function retainageSummary(projectId: string): RetainageSummary {
  const events = repo.listRetainageEventsForProject(projectId);
  const withheldToDate = events.filter((e) => e.type === "WITHHELD").reduce((s, e) => s + e.amount, 0);
  const releasedToDate = events.filter((e) => e.type === "RELEASED").reduce((s, e) => s + e.amount, 0);
  const releases = repo.listRetainageReleasesForProject(projectId);
  const pending = releases.filter((r) =>
    ["PENDING_CONDITIONS", "READY_FOR_GOVERNANCE", "APPROVED"].includes(r.status)
  );
  const conditionsOutstanding = pending.reduce(
    (s, r) => s + conditionStates(r.id).filter((c) => !c.satisfied).length,
    0
  );
  return {
    projectId,
    retainagePercent: effectivePolicy(projectId).retainagePercent,
    withheldToDate,
    releasedToDate,
    remaining: withheldToDate - releasedToDate,
    pendingReleaseRequests: pending.length,
    conditionsOutstanding,
  };
}

// ------------------------------------------------- release requests

/** Live condition state: ALL_EXCEPTIONS_RESOLVED is computed from the
 *  exception register; other conditions use their recorded state. */
export function conditionStates(releaseRequestId: string): RetainageCondition[] {
  const release = repo.getRetainageRelease(releaseRequestId);
  const rows = repo.listRetainageConditions(releaseRequestId);
  if (!release) return rows;
  return rows.map((c) => {
    if (c.condition !== "ALL_EXCEPTIONS_RESOLVED") return c;
    const openExceptions = repo
      .listExceptionsForProject(release.projectId)
      .filter((e) => ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"].includes(e.status));
    return {
      ...c,
      satisfied: openExceptions.length === 0,
      note:
        openExceptions.length === 0
          ? "Computed live: no open exceptions on the project."
          : `Computed live: ${openExceptions.length} open exception(s) block this condition.`,
    };
  });
}

export function createReleaseRequest(
  user: User,
  input: { projectId: string; amount?: number; note?: string | null }
): RetainageReleaseRequest {
  const project = repo.getProject(input.projectId);
  if (!project || !canAccessProjectFinance(user, project)) throw new RetainageError("Unknown project", 404);
  if (!canManageBudget(user)) throw new RetainageError("Retainage release requires a lender review role", 403);
  const summary = retainageSummary(project.id);
  const amount = input.amount != null ? Math.round(Number(input.amount)) : summary.remaining;
  if (!Number.isFinite(amount) || amount <= 0) throw new RetainageError("Release amount must be a positive number");
  if (amount > summary.remaining) {
    throw new RetainageError(
      `Release amount ${money(amount)} exceeds retainage remaining ${money(summary.remaining)}`,
      422
    );
  }
  const now = new Date().toISOString();
  const release: RetainageReleaseRequest = {
    id: repo.newId(),
    projectId: project.id,
    requestedByUserId: user.id,
    amount,
    status: "PENDING_CONDITIONS",
    note: input.note?.trim() || null,
    createdAt: now,
    updatedAt: now,
  };
  repo.insertRetainageRelease(release);
  for (const condition of effectivePolicy(project.id).requiredConditions) {
    repo.insertRetainageCondition({
      id: repo.newId(),
      releaseRequestId: release.id,
      condition,
      satisfied: false,
      note: null,
      satisfiedByUserId: null,
      satisfiedAt: null,
    });
  }
  audit({
    projectId: project.id, actorUserId: user.id, action: "RETAINAGE_RELEASE_REQUESTED",
    entityType: "retainage_release", entityId: release.id, reason: input.note?.trim() || null,
    beforeSummary: null,
    afterSummary: `${money(amount)} of ${money(summary.remaining)} remaining · conditions: ${effectivePolicy(project.id).requiredConditions.join(", ")}`,
  });
  return release;
}

export function satisfyCondition(
  user: User,
  releaseRequestId: string,
  condition: RetainageConditionType,
  note: string
): RetainageCondition[] {
  const release = repo.getRetainageRelease(releaseRequestId);
  if (!release) throw new RetainageError("Release request not found", 404);
  const project = repo.getProject(release.projectId)!;
  if (!canAccessProjectFinance(user, project)) throw new RetainageError("Release request not found", 404);
  if (!canManageBudget(user)) throw new RetainageError("Recording closeout conditions requires a lender review role", 403);
  if (condition === "ALL_EXCEPTIONS_RESOLVED") {
    throw new RetainageError("ALL_EXCEPTIONS_RESOLVED is computed from the exception register and cannot be recorded manually", 422);
  }
  const n = note.trim();
  if (!n) throw new RetainageError("A note describing the closeout document/verification is required");
  const row = repo.listRetainageConditions(releaseRequestId).find((c) => c.condition === condition);
  if (!row) throw new RetainageError("This condition is not part of the release request", 404);
  repo.updateRetainageCondition(row.id, {
    satisfied: true,
    note: n,
    satisfiedByUserId: user.id,
    satisfiedAt: new Date().toISOString(),
  });
  audit({
    projectId: project.id, actorUserId: user.id, action: "RETAINAGE_CONDITION_SATISFIED",
    entityType: "retainage_condition", entityId: row.id, reason: n,
    beforeSummary: condition, afterSummary: "satisfied",
  });
  return conditionStates(releaseRequestId);
}

/** Approval matrix for retainage releases (two roles minimum). */
export function resolveRetainageRoles(projectId: string): UserRole[] {
  const projectDefault = repo.listApprovalPolicies(projectId).find((p) => p.milestoneId === null);
  if (projectDefault && projectDefault.requiredRoles.length >= 2) return projectDefault.requiredRoles;
  return ["FUNDER_REP", "COMPLIANCE_REVIEWER"];
}

/** Open formal governance once every required condition is satisfied.
 *  Nothing is released here. */
export function sendReleaseToGovernance(
  user: User,
  releaseRequestId: string
): { release: RetainageReleaseRequest; approvalRequest: ApprovalRequest } {
  const release = repo.getRetainageRelease(releaseRequestId);
  if (!release) throw new RetainageError("Release request not found", 404);
  const project = repo.getProject(release.projectId)!;
  if (!canAccessProjectFinance(user, project)) throw new RetainageError("Release request not found", 404);
  if (!canManageBudget(user)) throw new RetainageError("Not authorized", 403);
  if (release.status !== "PENDING_CONDITIONS") {
    throw new RetainageError(`A ${release.status} release request cannot be sent to governance`, 409);
  }
  const unsatisfied = conditionStates(release.id).filter((c) => !c.satisfied);
  if (unsatisfied.length > 0) {
    throw new RetainageError(
      `Required conditions outstanding: ${unsatisfied.map((c) => c.condition.replace(/_/g, " ").toLowerCase()).join(", ")}`,
      422
    );
  }
  repo.updateRetainageRelease(release.id, { status: "READY_FOR_GOVERNANCE" });
  let approvalRequest = repo.getApprovalRequestForRetainageRelease(release.id);
  if (!approvalRequest || approvalRequest.status !== "PENDING") {
    approvalRequest = {
      id: repo.newId(),
      milestoneId: null,
      drawRequestId: null,
      changeOrderId: null,
      retainageReleaseId: release.id,
      subjectType: "RETAINAGE",
      status: "PENDING",
      requiredRoles: resolveRetainageRoles(release.projectId),
      createdAt: new Date().toISOString(),
    };
    repo.insertApprovalRequest(approvalRequest);
  }
  audit({
    projectId: project.id, actorUserId: user.id, action: "RETAINAGE_RELEASE_TO_GOVERNANCE",
    entityType: "retainage_release", entityId: release.id, reason: null,
    beforeSummary: "PENDING_CONDITIONS (all satisfied)",
    afterSummary: `READY_FOR_GOVERNANCE — requires ${approvalRequest.requiredRoles.join(" + ")}`,
  });
  return { release: repo.getRetainageRelease(release.id)!, approvalRequest };
}

export interface RetainageDecisionResult {
  approvalRequest: ApprovalRequest;
  records: ApprovalRecord[];
  release: RetainageReleaseRequest;
  released: boolean;
}

/**
 * Human governance decision on a RETAINAGE-subject ApprovalRequest — the
 * ONLY path that can release retainage state, exactly once through the
 * VirtualAccountService. First approvals leave retainage held.
 */
export async function processRetainageApprovalDecision(
  approvalRequestId: string,
  userId: string,
  decision: "APPROVED" | "REJECTED"
): Promise<RetainageDecisionResult> {
  const request = repo.getApprovalRequest(approvalRequestId);
  if (!request || !request.retainageReleaseId || request.subjectType !== "RETAINAGE") {
    throw new RetainageError("Unknown retainage approval request", 404);
  }
  if (request.status !== "PENDING") {
    throw new RetainageError("This approval request has already been resolved", 409);
  }
  const user = repo.getUser(userId);
  if (!user) throw new RetainageError("Select a demo user first", 401);
  const release = repo.getRetainageRelease(request.retainageReleaseId)!;
  const project = repo.getProject(release.projectId)!;
  if (!canAccessProjectFinance(user, project)) throw new RetainageError("Unknown retainage approval request", 404);
  if (!request.requiredRoles.includes(user.role)) {
    throw new RetainageError(
      `Role ${user.role} is not part of this approval (requires ${request.requiredRoles.join(", ")})`,
      403
    );
  }
  const existing = repo.listApprovalRecordsForRequest(request.id);
  if (existing.some((r) => r.role === user.role)) {
    throw new RetainageError(`A ${user.role} decision has already been recorded`, 409);
  }
  if (release.requestedByUserId === user.id) {
    throw new RetainageError("Separation of duties: the release requester cannot approve their own request", 403);
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
  let released = false;

  if (decision === "REJECTED") {
    repo.updateApprovalRequestStatus(request.id, "REJECTED");
    repo.updateRetainageRelease(release.id, { status: "RETURNED" });
    audit({
      projectId: project.id, actorUserId: user.id, action: "RETAINAGE_RELEASE_REJECTED",
      entityType: "retainage_release", entityId: release.id, reason: null,
      beforeSummary: `${money(release.amount)} requested`, afterSummary: "RETURNED — retainage remains held",
    });
  } else {
    const approvedRoles = new Set(records.filter((r) => r.decision === "APPROVED").map((r) => r.role));
    const complete = request.requiredRoles.every((role) => approvedRoles.has(role));
    if (complete) {
      repo.updateApprovalRequestStatus(request.id, "APPROVED");
      repo.updateRetainageRelease(release.id, { status: "APPROVED" });
      // Governed release transition — exactly once, via the
      // VirtualAccountService (UNIQUE(retainage_release_id) backstop).
      await virtualAccountService.releaseRetainage(repo.getRetainageRelease(release.id)!);
      repo.updateRetainageRelease(release.id, { status: "RELEASED" });
      released = true;
      audit({
        projectId: project.id, actorUserId: user.id, action: "RETAINAGE_RELEASED",
        entityType: "retainage_release", entityId: release.id, reason: null,
        beforeSummary: `${money(release.amount)} approved by ${request.requiredRoles.join(" + ")}`,
        afterSummary: "RELEASED on the virtual project account (exactly once)",
      });
    }
  }

  return {
    approvalRequest: repo.getApprovalRequest(request.id)!,
    records,
    release: repo.getRetainageRelease(release.id)!,
    released,
  };
}
