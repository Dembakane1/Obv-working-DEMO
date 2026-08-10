/**
 * Deterministic notification recipient resolution.
 *
 * WHO gets told about a governed event is derived from authoritative
 * records only: active project memberships (participant types), the
 * draw's own submitter, and — when a project has no explicit memberships
 * for a slot — an organization-role fallback within the project's
 * tenancy. No inference, no "probably interested" heuristics.
 *
 * TENANCY WALL: every candidate, from every source, must pass the
 * canonical `authz.canAccessProject` predicate before becoming a
 * recipient. A user who cannot open the project can never be notified
 * about it, so recipient resolution can never leak an event across
 * organizations even if a membership row or role set is misconfigured.
 *
 * EXPLAINABILITY: each recipient carries a deterministic, non-secret
 * `reason` ("active LENDER_REVIEWER membership on this project",
 * "FUNDER_REP in the project's organization", "submitted this draw") that
 * is stored on the in-app notification row, so an operator can always
 * answer "why did this user receive this notification?".
 */
import * as repo from "../../db/repo";
import * as lrepo from "../../db/lenderRepo";
import * as identityRepo from "../../db/identityRepo";
import * as authz from "../authz";
import type { Project, User, UserRole } from "../../../shared/types";
import type { PilotEventKind } from "./notify";

export interface ResolvedRecipient {
  user: User;
  /** The identity email for real (invited) people; null for demo-seeded
   *  users with no linked identity — they receive in-app only. */
  email: string | null;
  /** Deterministic, non-secret explanation of the selection. */
  reason: string;
}

type MembershipType =
  | "BORROWER" | "CONTRACTOR" | "INSPECTOR" | "OBV_REVIEWER" | "LENDER_REVIEWER" | "ADMINISTRATOR";

interface RecipientRule {
  /** Explicit project participants, by membership participant type. */
  memberships: MembershipType[];
  /** Tenancy-scoped role fallback, used when no membership matched. */
  fallbackRoles: UserRole[];
  /** Include the draw's submitter (when the event carries a draw). */
  includeSubmitter: boolean;
}

/**
 * The documented routing table. One rule per governed event kind —
 * changing WHO is told about WHAT is a reviewed change to this constant,
 * never scattered conditionals.
 */
export const RECIPIENT_RULES: Record<PilotEventKind, RecipientRule> = {
  DRAW_SUBMITTED:        { memberships: ["LENDER_REVIEWER", "OBV_REVIEWER"], fallbackRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"], includeSubmitter: false },
  EVIDENCE_RESUBMITTED:  { memberships: ["LENDER_REVIEWER", "OBV_REVIEWER"], fallbackRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"], includeSubmitter: false },
  DRAW_READY_FOR_REVIEW: { memberships: ["LENDER_REVIEWER", "OBV_REVIEWER"], fallbackRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"], includeSubmitter: false },
  EVIDENCE_MISSING:      { memberships: ["CONTRACTOR", "BORROWER"], fallbackRoles: ["PROJECT_MANAGER"], includeSubmitter: true },
  APPROVAL_REQUIRED:     { memberships: ["LENDER_REVIEWER", "ADMINISTRATOR"], fallbackRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"], includeSubmitter: false },
  DRAW_RETURNED:         { memberships: ["CONTRACTOR", "BORROWER"], fallbackRoles: ["PROJECT_MANAGER"], includeSubmitter: true },
  DRAW_DECISION_RECORDED:{ memberships: ["LENDER_REVIEWER", "ADMINISTRATOR", "BORROWER", "CONTRACTOR"], fallbackRoles: ["FUNDER_REP"], includeSubmitter: true },
  EXCEPTION_OPENED:      { memberships: ["OBV_REVIEWER", "ADMINISTRATOR"], fallbackRoles: ["COMPLIANCE_REVIEWER"], includeSubmitter: false },
  DISPUTE_OPENED:        { memberships: ["ADMINISTRATOR", "LENDER_REVIEWER"], fallbackRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"], includeSubmitter: false },
  INSPECTION_ATTENTION:  { memberships: ["INSPECTOR", "OBV_REVIEWER"], fallbackRoles: ["COMPLIANCE_REVIEWER"], includeSubmitter: false },
};

/** The identity email for a user, when one is linked. Demo-seeded users
 *  have no identity row and resolve to null (in-app delivery only). */
export function emailForUser(userId: string): string | null {
  const membership = identityRepo.findMembershipByUserId(userId);
  if (!membership || membership.status !== "ACTIVE") return null;
  const identity = identityRepo.getIdentity(membership.identityId);
  return identity && identity.status === "ACTIVE" ? identity.email : null;
}

function candidateOrganizationIds(project: Project): string[] {
  const ids = new Set<string>([project.organizationId]);
  const pilot = project.pilot;
  for (const orgId of [pilot?.implementingOrgId, pilot?.contractorOrgId, pilot?.funderOrgId, pilot?.engineerOrgId]) {
    if (orgId) ids.add(orgId);
  }
  return [...ids];
}

/**
 * Resolve the recipients for one governed event. Deterministic: same
 * records in, same recipients out, ordered by user id.
 */
export function resolveRecipients(
  kind: PilotEventKind,
  ctx: { projectId?: string | null; drawRequestId?: string | null }
): ResolvedRecipient[] {
  const rule = RECIPIENT_RULES[kind];
  const project = ctx.projectId ? repo.getProject(ctx.projectId) : null;
  if (!project) return []; // events without project context stay broadcast-only
  const chosen = new Map<string, ResolvedRecipient>();
  const add = (user: User | null, reason: string): void => {
    if (!user) return;
    if (chosen.has(user.id)) return;
    // THE tenancy wall — identical predicate to opening the project page.
    if (!authz.canAccessProject(user, project)) return;
    chosen.set(user.id, { user, email: emailForUser(user.id), reason });
  };

  // 1) Explicit active project memberships, by participant type.
  for (const m of lrepo.listMemberships(project.id)) {
    if (!m.active) continue;
    if (!(rule.memberships as string[]).includes(m.participantType)) continue;
    add(repo.getUser(m.userId), `active ${m.participantType} membership on this project`);
  }

  // 2) The draw's submitter, where the rule includes them.
  if (rule.includeSubmitter && ctx.drawRequestId) {
    const draw = repo.getDrawRequest(ctx.drawRequestId);
    if (draw && draw.projectId === project.id && draw.requestedByUserId) {
      add(repo.getUser(draw.requestedByUserId), "submitted this draw");
    }
  }

  // 3) Organization-role fallback WITHIN the project's tenancy, only when
  //    no explicit membership matched (memberships are the configured
  //    truth; the fallback keeps a young project from being silent).
  if (chosen.size === 0 || (rule.includeSubmitter && chosen.size <= 1)) {
    for (const orgId of candidateOrganizationIds(project)) {
      for (const user of repo.listUsers().filter((u) => u.organizationId === orgId)) {
        if (!rule.fallbackRoles.includes(user.role)) continue;
        add(user, `${user.role} in ${orgId === project.organizationId ? "the project's organization" : "a counterparty organization on this project"}`);
      }
    }
  }

  return [...chosen.values()].sort((a, b) => (a.user.id < b.user.id ? -1 : 1));
}
