/**
 * The shared authorization boundary.
 *
 * The newer layers (banking, disputes, lender decisions, draw inspections,
 * retainage, change orders, exceptions, permits, audit packages) already
 * enforce tenancy through `lenderAccess.assertProjectAccess`. The original
 * core — approvals, chat, field operations, pilot onboarding, reports — did
 * not. This module is the single place those call sites now go through, so
 * the rule is stated once and can be audited in one file.
 *
 * Two invariants hold everywhere:
 *
 *   1. SAME-404. A caller outside the tenant is told exactly what a caller
 *      asking about a nonexistent object is told: "not found". Existence is
 *      never disclosed by a different status code, message or timing branch.
 *      403 is reserved for callers who ARE inside the tenant but lack the
 *      capability — that distinction is safe because they can already see
 *      the object exists.
 *
 *   2. The check lives at the SERVICE boundary, not the route. Internal call
 *      paths (a service calling another service, a page handler, a webhook)
 *      cannot reach a project-scoped mutation without passing through it.
 *
 * This module imports ONLY the database layer. It is deliberately a leaf so
 * that every service can depend on it without creating a cycle — the earlier
 * arrangement (authz -> lenderAccess -> budgetProgress -> pilot/onboarding ->
 * orchestrator -> chat -> authz) failed at module-evaluation time.
 */
import * as repo from "../db/repo";
import * as lrepo from "../db/lenderRepo";
import type {
  ApprovalRequest,
  Milestone,
  Project,
  ProjectMembership,
  User,
} from "../../shared/types";

/** Thrown for every denial that must not disclose existence. */
export class AccessError extends Error {
  statusCode: number;
  constructor(message = "Not found", statusCode = 404) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Chronological instant for a stored effective date (date-only values are
 *  calendar days in UTC: effectiveTo remains effective THROUGH that day). */
function chronoMs(value: string | null | undefined, endOfDay: boolean): number | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z")
    : raw;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function membershipActive(m: ProjectMembership, nowMs: number): boolean {
  if (!m.active) return false;
  const from = chronoMs(m.effectiveFrom, false);
  if (from !== null && from > nowMs) return false;
  const to = chronoMs(m.effectiveTo, true);
  if (to !== null && to < nowMs) return false;
  return true;
}

/** At least one currently-effective membership on the project. Additive: it
 *  extends access, never restricts it. */
export function hasActiveMembership(user: User, projectId: string): boolean {
  const now = Date.now();
  return lrepo
    .listMembershipsForUser(user.id)
    .some((m) => m.projectId === projectId && membershipActive(m, now));
}

/**
 * The organisational relationship test: the project's own organisation, any
 * pilot counterparty organisation, or an organisation that has raised a draw
 * on this project. This is the canonical definition — budgetProgress
 * re-exports it so there is exactly one implementation.
 */
export function canAccessProjectFinance(user: User, project: Project): boolean {
  if (user.organizationId === project.organizationId) return true;
  const pilot = project.pilot;
  if (
    [pilot?.implementingOrgId, pilot?.contractorOrgId, pilot?.funderOrgId, pilot?.engineerOrgId].some(
      (orgId) => orgId && orgId === user.organizationId
    )
  ) {
    return true;
  }
  return repo
    .listDrawRequestsForProject(project.id)
    .some((d) => d.requestedByOrganizationId === user.organizationId);
}

/**
 * Whether a user may see a project at all.
 *
 * This is the same predicate `assertProjectAccess` enforces: organisational
 * relationship (owner org, or any pilot counterparty org, or an org that has
 * requested a draw) OR an explicit active project membership.
 */
export function canAccessProject(user: User, project: Project): boolean {
  return (
    canAccessProjectFinance(user, project) ||
    hasActiveMembership(user, project.id) ||
    participatesInPilotProject(user, project)
  );
}

/**
 * Explicit person-level participation in a pilot project, independent of
 * organisation: the administrator who created the draft, anyone holding an
 * active field assignment, and anyone who accepted a project-scoped
 * invitation. A pilot project is routinely owned by a counterparty
 * organisation the administrator does not belong to, so organisation
 * relationship alone is not the whole picture.
 *
 * This mirrors the participation set the approval matrix and readiness
 * engine already use (pilot/onboarding.projectParticipants); it is stated
 * here in repo-only terms because this module must stay a leaf.
 */
export function participatesInPilotProject(user: User, project: Project): boolean {
  if (project.pilot?.createdBy === user.id) return true;
  if (
    repo
      .listAssignmentsForProject(project.id)
      .some((a) => a.active && a.userId === user.id)
  ) {
    return true;
  }
  return repo
    .listInvitations()
    .some(
      (inv) =>
        inv.projectId === project.id &&
        inv.status === "ACCEPTED" &&
        inv.acceptedUserId === user.id
    );
}

/** Assert access to a project id; throws the same 404 for absent and foreign. */
export function requireProject(user: User, projectId: string | null | undefined): Project {
  if (!projectId) throw new AccessError();
  const project = repo.getProject(projectId);
  // Identical outcome for "absent" and "foreign" — that IS the contract.
  if (!project || !canAccessProject(user, project)) throw new AccessError();
  return project;
}

/** Every project the caller may see. The basis for all scoped listings. */
export function accessibleProjects(user: User): Project[] {
  return repo.listProjects().filter((p) => canAccessProject(user, p));
}

/** The set of accessible project ids — cheap membership tests for listings. */
export function accessibleProjectIds(user: User): Set<string> {
  return new Set(accessibleProjects(user).map((p) => p.id));
}

/**
 * Resolve a milestone AND prove it belongs to a project the caller may
 * reach. This is the nested-object guard: a milestone id from another
 * tenant resolves to a real row, so the row alone proves nothing.
 */
export function requireMilestone(user: User, milestoneId: string | null | undefined): {
  milestone: Milestone;
  project: Project;
} {
  if (!milestoneId) throw new AccessError();
  const milestone = repo.getMilestone(milestoneId);
  if (!milestone) throw new AccessError();
  const project = requireProject(user, milestone.projectId);
  return { milestone, project };
}

/**
 * Assert that a milestone belongs to the stated project. Routes that accept
 * both a project id and a child id must never assume the pair is consistent —
 * substituting another project's milestone is a real attack.
 */
export function requireMilestoneInProject(
  user: User,
  projectId: string,
  milestoneId: string
): { milestone: Milestone; project: Project } {
  const project = requireProject(user, projectId);
  const milestone = repo.getMilestone(milestoneId);
  if (!milestone || milestone.projectId !== project.id) throw new AccessError();
  return { milestone, project };
}

/**
 * The project that owns an approval request, whatever its subject type.
 * Returns null when the subject cannot be resolved, which callers must treat
 * as "not found" rather than "unrestricted".
 */
export function projectForApprovalRequest(request: ApprovalRequest): Project | null {
  if (request.milestoneId) {
    const milestone = repo.getMilestone(request.milestoneId);
    return milestone ? repo.getProject(milestone.projectId) ?? null : null;
  }
  if (request.drawRequestId) {
    const draw = repo.getDrawRequest(request.drawRequestId);
    return draw ? repo.getProject(draw.projectId) ?? null : null;
  }
  if (request.changeOrderId) {
    const co = repo.getChangeOrder(request.changeOrderId);
    return co ? repo.getProject(co.projectId) ?? null : null;
  }
  if (request.retainageReleaseId) {
    const rr = repo.getRetainageRelease(request.retainageReleaseId);
    return rr ? repo.getProject(rr.projectId) ?? null : null;
  }
  return null;
}

/**
 * Assert the caller may act on an approval request. Returns the owning
 * project. Used by the orchestrator BEFORE any status, role or
 * separation-of-duties message is produced, because those messages would
 * otherwise disclose that a foreign tenant's request exists and what state
 * it is in.
 */
export function requireApprovalRequestAccess(user: User, request: ApprovalRequest): Project {
  const project = projectForApprovalRequest(request);
  if (!project || !canAccessProject(user, project)) throw new AccessError();
  return project;
}
