/**
 * User administration: directory, suspension/restore, MFA readiness,
 * invitation management readouts, sign-in and device history, and a
 * descriptive permission matrix. Org-scoped (an administrator manages
 * only their own organization), and every action is audited.
 *
 * Suspension is enforced at session resolution: a suspended user's
 * existing session stops resolving on their next request, and new
 * sign-ins are refused (recorded as SIGN_IN_REFUSED).
 */
import type { Invitation, User } from "../../../shared/types";
import * as repo from "../../db/repo";
import * as prepo from "../../db/pilotOpsRepo";
import { PilotOpsError, assertOrgAdmin, assertSameOrganization, audit } from "./core";

export interface DirectoryEntry {
  user: User;
  status: "ACTIVE" | "SUSPENDED";
  mfaReady: boolean;
  lastSignInAt: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
}

export interface UserDirectory {
  organizationId: string;
  users: DirectoryEntry[];
  invitations: Invitation[];
}

export function userDirectory(user: User): UserDirectory {
  assertOrgAdmin(user);
  const lastSignIn = prepo.lastSignInByUser();
  const users = repo
    .listUsers()
    .filter((u) => u.organizationId === user.organizationId)
    .map((u) => {
      const state = prepo.getUserAdminState(u.id);
      return {
        user: u,
        status: state?.status ?? "ACTIVE",
        mfaReady: state?.mfaReady ?? false,
        lastSignInAt: lastSignIn.get(u.id) ?? null,
        suspendedAt: state?.suspendedAt ?? null,
        suspensionReason: state?.suspensionReason ?? null,
      } as DirectoryEntry;
    });
  const invitations = repo
    .listInvitations()
    .filter((i) => i.organizationId === user.organizationId);
  return { organizationId: user.organizationId, users, invitations };
}

function requireOrgUser(actor: User, userId: string): User {
  const target = repo.getUser(userId);
  // Same-404: a user outside the administrator's organization is
  // indistinguishable from one that does not exist.
  if (!target || target.organizationId !== actor.organizationId) {
    throw new PilotOpsError("User not found", 404);
  }
  return target;
}

export function suspendUser(actor: User, userId: string, reason: string): prepo.UserAdminState {
  assertOrgAdmin(actor);
  const target = requireOrgUser(actor, userId);
  if (target.id === actor.id) {
    throw new PilotOpsError("You cannot suspend your own account", 400);
  }
  const state = prepo.setUserSuspended(target.id, true, actor.id, reason || null);
  audit(actor, "USER_SUSPENDED", "user", target.id, { reason: reason || null });
  return state;
}

export function restoreUser(actor: User, userId: string): prepo.UserAdminState {
  assertOrgAdmin(actor);
  const target = requireOrgUser(actor, userId);
  const state = prepo.setUserSuspended(target.id, false, actor.id, null);
  audit(actor, "USER_RESTORED", "user", target.id);
  return state;
}

export function setMfaReadiness(actor: User, userId: string, ready: boolean): prepo.UserAdminState {
  assertOrgAdmin(actor);
  const target = requireOrgUser(actor, userId);
  prepo.setMfaReady(target.id, ready);
  audit(actor, ready ? "USER_MFA_READY" : "USER_MFA_UNREADY", "user", target.id);
  return prepo.getUserAdminState(target.id)!;
}

export function accessHistory(actor: User, userId: string): prepo.AccessEvent[] {
  assertOrgAdmin(actor);
  const target = requireOrgUser(actor, userId);
  return prepo.listAccessEvents(target.id);
}

/** Distinct user agents observed for a user — the device history view. */
export function deviceHistory(actor: User, userId: string): { userAgent: string; firstSeen: string; lastSeen: string; signIns: number }[] {
  const events = accessHistory(actor, userId).filter((e) => e.event === "SIGN_IN");
  const byAgent = new Map<string, { userAgent: string; firstSeen: string; lastSeen: string; signIns: number }>();
  for (const event of events) {
    const key = event.userAgent ?? "(unknown device)";
    const entry = byAgent.get(key) ?? { userAgent: key, firstSeen: event.createdAt, lastSeen: event.createdAt, signIns: 0 };
    entry.signIns += 1;
    if (event.createdAt < entry.firstSeen) entry.firstSeen = event.createdAt;
    if (event.createdAt > entry.lastSeen) entry.lastSeen = event.createdAt;
    byAgent.set(key, entry);
  }
  return [...byAgent.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** Descriptive role/permission matrix (documentation of enforced rules —
 *  the enforcement itself lives in the services). */
export const PERMISSION_MATRIX: { area: string; FUNDER_REP: string; PROJECT_MANAGER: string; COMPLIANCE_REVIEWER: string; FIELD: string }[] = [
  { area: "Evidence capture", FUNDER_REP: "—", PROJECT_MANAGER: "—", COMPLIANCE_REVIEWER: "—", FIELD: "Capture & submit" },
  { area: "Evidence review / verification", FUNDER_REP: "Review", PROJECT_MANAGER: "View", COMPLIANCE_REVIEWER: "Review", FIELD: "—" },
  { area: "Milestone / draw approvals", FUNDER_REP: "Approve", PROJECT_MANAGER: "View", COMPLIANCE_REVIEWER: "Approve", FIELD: "—" },
  { area: "Lender decisions & conditions", FUNDER_REP: "Decide", PROJECT_MANAGER: "View", COMPLIANCE_REVIEWER: "Review", FIELD: "—" },
  { area: "DMV compliance determinations", FUNDER_REP: "Determine", PROJECT_MANAGER: "Record", COMPLIANCE_REVIEWER: "Determine", FIELD: "—" },
  { area: "Banking (mock/demo)", FUNDER_REP: "Dual-control", PROJECT_MANAGER: "View", COMPLIANCE_REVIEWER: "Dual-control", FIELD: "—" },
  { area: "Portfolio intelligence", FUNDER_REP: "Full", PROJECT_MANAGER: "Full", COMPLIANCE_REVIEWER: "Full", FIELD: "—" },
  { area: "Organization administration", FUNDER_REP: "Admin", PROJECT_MANAGER: "Admin", COMPLIANCE_REVIEWER: "Admin", FIELD: "—" },
  { area: "Internal operator console", FUNDER_REP: "—", PROJECT_MANAGER: "—", COMPLIANCE_REVIEWER: "Operator", FIELD: "—" },
];

export function resendInvitationEmail(actor: User, invitationId: string): Invitation {
  assertOrgAdmin(actor);
  const invitation = repo.getInvitation(invitationId);
  if (!invitation) throw new PilotOpsError("Invitation not found", 404);
  assertSameOrganization(actor, invitation.organizationId);
  audit(actor, "INVITATION_EMAIL_RESENT", "invitation", invitation.id);
  return invitation;
}
