/**
 * Identity lifecycle: bootstrap, invitation attachment (the anti-
 * duplication rule), org membership administration (suspend / restore /
 * deactivate / ownership transfer), and history views.
 *
 * THE ANTI-DUPLICATION RULE
 *  An email address resolves to exactly one identity, forever. Accepting
 *  an invitation NEVER creates a second identity, and never creates a
 *  second users row inside an organization the identity already belongs
 *  to — it reuses (and if needed reactivates) the existing membership.
 *  A brand-new organization gets a brand-new users row linked to the SAME
 *  identity, which is how one person carries several org roles without
 *  the authorization model changing shape.
 */
import * as identityRepo from "../../db/identityRepo";
import * as repo from "../../db/repo";
import * as pilot from "../pilot/onboarding";
import { SubmissionError } from "../../workflow/orchestrator";
import type {
  AuthEvent,
  AuthSession,
  Identity,
  IdentityMembership,
  User,
} from "../../../shared/types";
import { IdentityError, normalizeEmail, nowIso, recordAuthEvent } from "./core";
import { createSession, type RequestMeta, type ResolvedSession } from "./auth";

// ------------------------------------------------------------ bootstrap

/**
 * First-admin bootstrap: when OBV_BOOTSTRAP_ADMIN_EMAIL is set and NO
 * identity exists yet, mint the founding identity, its organization, and
 * a PROJECT_MANAGER users row so the first magic link has somewhere to
 * land. Runs at startup; a non-empty identities table makes it a no-op,
 * so it can never resurrect or duplicate anything.
 */
export function ensureBootstrapIdentity(): Identity | null {
  const email = normalizeEmail(process.env.OBV_BOOTSTRAP_ADMIN_EMAIL);
  if (!email) return null;
  if (identityRepo.countIdentities() > 0) return identityRepo.findIdentityByEmail(email);
  const orgName = (process.env.OBV_BOOTSTRAP_ORG_NAME ?? "").trim() || "OBV Operations";
  const org = { id: repo.newId(), name: orgName, kind: "LENDER" };
  repo.insertOrganization(org);
  const displayName = email.split("@")[0].replace(/[._-]+/g, " ").trim() || "Administrator";
  const user: User = {
    id: repo.newId(),
    organizationId: org.id,
    name: displayName,
    role: "PROJECT_MANAGER",
    title: "Administrator",
  };
  repo.insertUser(user);
  const identity: Identity = {
    id: repo.newId(),
    email,
    displayName,
    emailVerifiedAt: null,
    status: "ACTIVE",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  identityRepo.insertIdentity(identity);
  identityRepo.insertMembership({
    id: repo.newId(),
    identityId: identity.id,
    userId: user.id,
    organizationId: org.id,
    status: "ACTIVE",
    isOwner: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  recordAuthEvent({
    kind: "IDENTITY_BOOTSTRAPPED",
    identityId: identity.id,
    userId: user.id,
    organizationId: org.id,
    email,
    detail: `org=${orgName}`,
  });
  return identity;
}

// -------------------------------------------- invitation attachment

/**
 * Accept an invitation AND attach the result to a durable identity.
 *
 *  - identity already a member of the inviting org → reuse the existing
 *    users row (no duplicate person), reactivate the membership if it was
 *    suspended/deactivated, and mark the invitation accepted against the
 *    EXISTING user id. The existing role is kept — an invitation is not a
 *    silent role-change instrument; the difference is audited instead.
 *  - otherwise → the standard acceptance path creates the org's users row
 *    and a membership links it to the identity (created on first contact).
 *
 * Either way the accepted invitation proves mailbox control, so the
 * identity's email becomes verified, and a signed-in session is created.
 */
export function acceptInvitationWithIdentity(
  rawToken: string,
  profile: { name: string; title: string },
  meta: RequestMeta
): { user: User; identity: Identity; session: AuthSession; cookieValue: string } {
  const inv = pilot.findInvitationForToken(rawToken);
  if (!inv) throw new SubmissionError("Invitation not found", 404);
  if (inv.status === "EXPIRED") throw new SubmissionError("This invitation has expired", 410);
  if (inv.status === "REVOKED") throw new SubmissionError("This invitation was revoked", 410);
  if (inv.status === "ACCEPTED") throw new SubmissionError("This invitation was already used", 409);
  const name = String(profile.name ?? "").trim().slice(0, 120);
  if (!name) throw new SubmissionError("Your name is required");
  const email = normalizeEmail(inv.email);
  if (!email) throw new SubmissionError("Invitation email is invalid", 422);

  let identity = identityRepo.findIdentityByEmail(email);
  if (!identity) {
    identity = {
      id: repo.newId(),
      email,
      displayName: name,
      emailVerifiedAt: null,
      status: "ACTIVE",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    identityRepo.insertIdentity(identity);
    recordAuthEvent({ kind: "IDENTITY_CREATED", identityId: identity.id, email, ip: meta.ip, userAgent: meta.userAgent });
  }
  if (identity.status !== "ACTIVE") {
    throw new SubmissionError("This account is not active", 403);
  }

  const existing = identityRepo.findMembershipForOrg(identity.id, inv.organizationId);
  let user: User;
  let membership: IdentityMembership;
  if (existing) {
    const existingUser = repo.getUser(existing.userId);
    if (!existingUser) throw new SubmissionError("Invitation not found", 404);
    user = existingUser;
    membership = existing;
    repo.updateInvitation(inv.id, {
      status: "ACCEPTED",
      acceptedAt: nowIso(),
      acceptedUserId: user.id,
    });
    if (inv.projectId && inv.role === "FIELD") {
      repo.insertAssignment({
        id: repo.newId(),
        projectId: inv.projectId,
        userId: user.id,
        milestoneIds: [],
        effectiveFrom: null,
        effectiveTo: null,
        active: true,
        createdBy: inv.createdBy,
        createdAt: nowIso(),
      });
    }
    if (existing.status !== "ACTIVE") {
      identityRepo.updateMembershipFields(existing.id, { status: "ACTIVE" });
      membership = identityRepo.getMembership(existing.id)!;
      recordAuthEvent({
        kind: "MEMBERSHIP_RESTORED",
        identityId: identity.id,
        userId: user.id,
        organizationId: inv.organizationId,
        detail: "restored by invitation acceptance",
      });
    }
    pilot.audit({
      projectId: inv.projectId,
      actorUserId: user.id,
      action: "INVITATION_ACCEPTED",
      entityType: "invitation",
      entityId: inv.id,
      reason: null,
      beforeSummary: null,
      afterSummary: `${user.name} (existing member${inv.role !== user.role ? `; invited as ${inv.role}, role unchanged` : ""})`,
    });
    recordAuthEvent({
      kind: "INVITATION_ACCEPTED",
      identityId: identity.id,
      userId: user.id,
      organizationId: inv.organizationId,
      email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: "attached to existing membership — no duplicate user created",
    });
  } else {
    const accepted = pilot.acceptInvitation(rawToken, profile);
    user = accepted.user;
    const orgHasOwner = identityRepo
      .listMembershipsForOrganization(inv.organizationId)
      .some((m) => m.isOwner && m.status === "ACTIVE");
    membership = {
      id: repo.newId(),
      identityId: identity.id,
      userId: user.id,
      organizationId: inv.organizationId,
      status: "ACTIVE",
      // The organization's first identity-linked member stewards it until
      // ownership is transferred.
      isOwner: !orgHasOwner,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    identityRepo.insertMembership(membership);
    recordAuthEvent({
      kind: "INVITATION_ACCEPTED",
      identityId: identity.id,
      userId: user.id,
      organizationId: inv.organizationId,
      email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: `new membership created (role ${user.role})`,
    });
  }

  if (!identity.emailVerifiedAt) {
    identityRepo.updateIdentityFields(identity.id, { emailVerifiedAt: nowIso() });
    recordAuthEvent({ kind: "EMAIL_VERIFIED", identityId: identity.id, email, detail: "via invitation acceptance" });
  }
  const { session, cookieValue } = createSession(
    identityRepo.getIdentity(identity.id)!,
    membership,
    { trustDevice: false, deviceLabel: null },
    meta,
    null
  );
  recordAuthEvent({
    kind: "SIGN_IN",
    identityId: identity.id,
    userId: user.id,
    organizationId: membership.organizationId,
    sessionId: session.id,
    email,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail: "via invitation acceptance",
  });
  return { user, identity: identityRepo.getIdentity(identity.id)!, session, cookieValue };
}

// ------------------------------------------- membership administration

/** Owner authority over one organization, same-404: a caller who is not
 *  an active owner cannot distinguish the org from a nonexistent one. */
function requireOwner(resolved: ResolvedSession, organizationId: string): IdentityMembership {
  const mine = identityRepo.findMembershipForOrg(resolved.identity.id, organizationId);
  if (!mine || mine.status !== "ACTIVE" || !mine.isOwner) {
    throw new IdentityError("Not found", 404);
  }
  return mine;
}

function targetMembership(resolved: ResolvedSession, membershipId: string): IdentityMembership {
  const target = identityRepo.getMembership(String(membershipId ?? ""));
  if (!target) throw new IdentityError("Not found", 404);
  // Owner check first — it produces the same 404 for an org the caller
  // does not own, keeping foreign membership ids unprobeable.
  requireOwner(resolved, target.organizationId);
  return target;
}

function revokeMembershipSessions(membership: IdentityMembership, reason: string): number {
  let count = 0;
  for (const s of identityRepo.listSessionsForIdentity(membership.identityId)) {
    if (s.userId === membership.userId && identityRepo.revokeAuthSession(s.id, nowIso(), reason)) count++;
  }
  return count;
}

function adminAudit(resolved: ResolvedSession, action: string, target: IdentityMembership, detail: string): void {
  repo.insertConfigAudit({
    id: repo.newId(),
    projectId: null,
    actorUserId: resolved.user.id,
    action,
    entityType: "identity_membership",
    entityId: target.id,
    reason: null,
    beforeSummary: null,
    afterSummary: detail,
    createdAt: nowIso(),
  });
}

export function suspendMembership(resolved: ResolvedSession, membershipId: string, meta: RequestMeta): IdentityMembership {
  const target = targetMembership(resolved, membershipId);
  if (target.isOwner) {
    throw new IdentityError("Transfer ownership before suspending the owner", 409);
  }
  if (target.status !== "ACTIVE") {
    throw new IdentityError("Only an active membership can be suspended", 409);
  }
  identityRepo.updateMembershipFields(target.id, { status: "SUSPENDED" });
  const revoked = revokeMembershipSessions(target, "MEMBERSHIP_SUSPENDED");
  recordAuthEvent({
    kind: "MEMBERSHIP_SUSPENDED",
    identityId: target.identityId,
    userId: target.userId,
    organizationId: target.organizationId,
    actorIdentityId: resolved.identity.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail: `sessionsRevoked=${revoked}`,
  });
  adminAudit(resolved, "MEMBERSHIP_SUSPENDED", target, `suspended (${revoked} session(s) revoked)`);
  return identityRepo.getMembership(target.id)!;
}

export function restoreMembership(resolved: ResolvedSession, membershipId: string, meta: RequestMeta): IdentityMembership {
  const target = targetMembership(resolved, membershipId);
  if (target.status !== "SUSPENDED") {
    throw new IdentityError("Only a suspended membership can be restored", 409);
  }
  identityRepo.updateMembershipFields(target.id, { status: "ACTIVE" });
  recordAuthEvent({
    kind: "MEMBERSHIP_RESTORED",
    identityId: target.identityId,
    userId: target.userId,
    organizationId: target.organizationId,
    actorIdentityId: resolved.identity.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  adminAudit(resolved, "MEMBERSHIP_RESTORED", target, "restored");
  return identityRepo.getMembership(target.id)!;
}

/** Deactivation is the terminal administrative state; the only way back
 *  in is accepting a fresh invitation (which reactivates in place —
 *  never duplicates). */
export function deactivateMembership(resolved: ResolvedSession, membershipId: string, meta: RequestMeta): IdentityMembership {
  const target = targetMembership(resolved, membershipId);
  if (target.isOwner) {
    throw new IdentityError("Transfer ownership before deactivating the owner", 409);
  }
  if (target.status === "DEACTIVATED") {
    throw new IdentityError("This membership is already deactivated", 409);
  }
  identityRepo.updateMembershipFields(target.id, { status: "DEACTIVATED" });
  const revoked = revokeMembershipSessions(target, "MEMBERSHIP_DEACTIVATED");
  recordAuthEvent({
    kind: "MEMBERSHIP_DEACTIVATED",
    identityId: target.identityId,
    userId: target.userId,
    organizationId: target.organizationId,
    actorIdentityId: resolved.identity.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail: `sessionsRevoked=${revoked}`,
  });
  adminAudit(resolved, "MEMBERSHIP_DEACTIVATED", target, `deactivated (${revoked} session(s) revoked)`);
  return identityRepo.getMembership(target.id)!;
}

/** Move organization stewardship to another ACTIVE membership of the same
 *  org. The actor loses the owner flag in the same operation. */
export function transferOwnership(
  resolved: ResolvedSession,
  organizationId: string,
  targetMembershipId: string,
  meta: RequestMeta
): IdentityMembership {
  const mine = requireOwner(resolved, String(organizationId ?? ""));
  const target = identityRepo.getMembership(String(targetMembershipId ?? ""));
  if (!target || target.organizationId !== mine.organizationId) {
    throw new IdentityError("Not found", 404);
  }
  if (target.id === mine.id) {
    throw new IdentityError("You already own this organization", 409);
  }
  if (target.status !== "ACTIVE") {
    throw new IdentityError("Ownership can only transfer to an active membership", 409);
  }
  identityRepo.updateMembershipFields(mine.id, { isOwner: false });
  identityRepo.updateMembershipFields(target.id, { isOwner: true });
  recordAuthEvent({
    kind: "OWNERSHIP_TRANSFERRED",
    identityId: target.identityId,
    userId: target.userId,
    organizationId: target.organizationId,
    actorIdentityId: resolved.identity.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail: `from membership ${mine.id}`,
  });
  adminAudit(resolved, "OWNERSHIP_TRANSFERRED", target, `ownership transferred from ${mine.id}`);
  return identityRepo.getMembership(target.id)!;
}

// ---------------------------------------------------------- histories

export function membershipsForIdentity(identity: Identity): IdentityMembership[] {
  return identityRepo.listMembershipsForIdentity(identity.id);
}

/** Memberships an owner can administer, scoped to organizations they own. */
export function administrableMemberships(resolved: ResolvedSession): IdentityMembership[] {
  return identityRepo
    .listMembershipsForIdentity(resolved.identity.id)
    .filter((m) => m.isOwner && m.status === "ACTIVE")
    .flatMap((m) => identityRepo.listMembershipsForOrganization(m.organizationId));
}

const HISTORY_KINDS = new Set([
  "SIGN_IN", "SIGN_OUT", "SIGN_OUT_EVERYWHERE", "SESSION_REVOKED", "SESSION_EXPIRED",
  "SESSION_ROTATED", "ORG_SWITCHED", "EMAIL_VERIFIED", "LINK_ISSUED",
  "LOGIN_REPLAY_BLOCKED", "LOGIN_FAILED_EXPIRED_LINK", "LOGIN_BLOCKED_LOCKED_OUT",
  "ACCOUNT_LOCKED", "INVITATION_ACCEPTED", "IDENTITY_CREATED", "IDENTITY_BOOTSTRAPPED",
  "MEMBERSHIP_SUSPENDED", "MEMBERSHIP_RESTORED", "MEMBERSHIP_DEACTIVATED",
  "OWNERSHIP_TRANSFERRED",
]);

/** The identity's own security history (sign-ins, failures, sessions,
 *  membership changes). Internal probe noise is filtered; the raw log
 *  keeps everything. */
export function loginHistory(identity: Identity, limit = 50): AuthEvent[] {
  return identityRepo
    .listAuthEventsForIdentity(identity.id, Math.min(200, Math.max(1, limit)))
    .filter((e) => HISTORY_KINDS.has(e.kind));
}
