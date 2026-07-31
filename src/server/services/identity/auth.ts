/**
 * Passwordless authentication: magic-link issue/complete, server-side
 * sessions (idle + absolute expiry, trusted devices, rotation,
 * revocation), brute-force lockout, and CSRF verification.
 *
 * SESSION MODEL
 *  The cookie value is `<sessionId>.<secret>`, both halves random. The
 *  database stores sha256(secret) only, so reading the database cannot
 *  produce a working cookie. Every request re-validates against the
 *  server-side row: revocation is immediate, idle expiry slides with
 *  activity, and the absolute expiry set at sign-in NEVER extends — org
 *  switching rotates the session but inherits the original deadline.
 */
import { randomBytes } from "node:crypto";
import * as identityRepo from "../../db/identityRepo";
import * as repo from "../../db/repo";
import type { AuthSession, Identity, IdentityMembership, User } from "../../../shared/types";
import {
  DAY,
  GENERIC_AUTH_FAILURE,
  GENERIC_LINK_RESPONSE,
  HOUR,
  IdentityError,
  MINUTE,
  deliverSignInLink,
  identityConfig,
  normalizeEmail,
  nowIso,
  recordAuthEvent,
  safeStringEqual,
  sha256Hex,
} from "./core";

export const AUTH_COOKIE = "obv_auth";
export const CSRF_COOKIE = "obv_csrf";

const TOKEN_SHAPE = /^[a-f0-9]{64}$/;
const SESSION_ID_SHAPE = /^[a-f0-9]{32}$/;
/** Touches are throttled so read-only traffic does not write per request. */
const TOUCH_THROTTLE_MS = 60_000;

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

// ----------------------------------------------------------- lockouts

function lockoutScopes(meta: RequestMeta, email: string | null): string[] {
  const scopes: string[] = [];
  if (email) scopes.push(`email:${email}`);
  if (meta.ip) scopes.push(`ip:${meta.ip}`);
  return scopes;
}

export function isLockedOut(scope: string, nowMs = Date.now()): boolean {
  const l = identityRepo.getLockout(scope);
  return Boolean(l?.lockedUntil && Date.parse(l.lockedUntil) > nowMs);
}

function anyLocked(meta: RequestMeta, email: string | null): boolean {
  return lockoutScopes(meta, email).some((s) => isLockedOut(s));
}

/** Count a failure toward every applicable scope; start a lockout when
 *  the threshold is crossed inside the rolling window. */
function registerFailure(meta: RequestMeta, email: string | null, identityId: string | null): void {
  const cfg = identityConfig();
  const now = Date.now();
  for (const scope of lockoutScopes(meta, email)) {
    const existing = identityRepo.getLockout(scope);
    const windowStart =
      existing?.firstFailureAt && now - Date.parse(existing.firstFailureAt) < cfg.lockoutWindowMinutes * MINUTE
        ? existing.firstFailureAt
        : new Date(now).toISOString();
    const count =
      existing && windowStart === existing.firstFailureAt ? existing.failureCount + 1 : 1;
    const locking = count >= cfg.lockoutThreshold;
    identityRepo.upsertLockout({
      scope,
      failureCount: count,
      firstFailureAt: windowStart,
      lastFailureAt: new Date(now).toISOString(),
      lockedUntil: locking
        ? new Date(now + cfg.lockoutDurationMinutes * MINUTE).toISOString()
        : (existing?.lockedUntil ?? null),
    });
    if (locking) {
      recordAuthEvent({
        kind: "ACCOUNT_LOCKED",
        identityId,
        email,
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: `scope=${scope} failures=${count} lockedMinutes=${cfg.lockoutDurationMinutes}`,
      });
    }
  }
}

function clearFailures(meta: RequestMeta, email: string | null): void {
  for (const scope of lockoutScopes(meta, email)) identityRepo.clearLockout(scope);
}

// ------------------------------------------------- magic link request

/**
 * Request a sign-in link. ALWAYS resolves to the same generic message —
 * unknown address, inactive identity, throttle, and lockout all look
 * identical to the caller. The reasons live in the audit log instead.
 */
export function requestMagicLink(
  rawEmail: unknown,
  origin: string,
  meta: RequestMeta
): { message: string } {
  const cfg = identityConfig();
  const email = normalizeEmail(rawEmail);
  const generic = { message: GENERIC_LINK_RESPONSE };
  if (!email) {
    recordAuthEvent({ kind: "LINK_REQUEST_INVALID_EMAIL", ip: meta.ip, userAgent: meta.userAgent });
    return generic;
  }
  if (anyLocked(meta, email)) {
    recordAuthEvent({ kind: "LINK_REQUEST_WHILE_LOCKED", email, ip: meta.ip, userAgent: meta.userAgent });
    return generic;
  }
  const identity = identityRepo.findIdentityByEmail(email);
  if (!identity) {
    recordAuthEvent({ kind: "LINK_REQUEST_UNKNOWN_EMAIL", email, ip: meta.ip, userAgent: meta.userAgent });
    return generic;
  }
  if (identity.status !== "ACTIVE") {
    recordAuthEvent({
      kind: "LINK_REQUEST_INACTIVE_IDENTITY",
      identityId: identity.id,
      email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: identity.status,
    });
    return generic;
  }
  const windowStart = new Date(Date.now() - cfg.linkRequestWindowMinutes * MINUTE).toISOString();
  if (identityRepo.countRecentAuthTokens(identity.id, "MAGIC_LINK", windowStart) >= cfg.linkRequestsPerWindow) {
    recordAuthEvent({
      kind: "LINK_REQUEST_THROTTLED",
      identityId: identity.id,
      email,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return generic;
  }
  const rawToken = randomBytes(32).toString("hex");
  identityRepo.insertAuthToken({
    id: repo.newId(),
    identityId: identity.id,
    purpose: "MAGIC_LINK",
    tokenHash: sha256Hex(rawToken),
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + cfg.magicLinkTtlMinutes * MINUTE).toISOString(),
    consumedAt: null,
    requestIp: meta.ip,
    requestAgent: meta.userAgent,
  });
  recordAuthEvent({
    kind: "LINK_ISSUED",
    identityId: identity.id,
    email,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail: `ttlMinutes=${cfg.magicLinkTtlMinutes}`,
  });
  deliverSignInLink(email, `${origin}/auth/complete?token=${rawToken}`, "MAGIC_LINK");
  return generic;
}

// ---------------------------------------------- magic link completion

/** Peek at a link token WITHOUT consuming it — the GET confirmation page
 *  uses this so mail scanners that prefetch links cannot burn them. Tells
 *  the holder (who already possesses the token) whether it is still
 *  usable; reveals nothing they could not learn by submitting it. */
export function previewMagicLink(rawToken: string): { usable: boolean; email: string | null } {
  if (!TOKEN_SHAPE.test(rawToken)) return { usable: false, email: null };
  const token = identityRepo.findAuthTokenByHash(sha256Hex(rawToken));
  if (!token || token.purpose !== "MAGIC_LINK" || token.consumedAt) return { usable: false, email: null };
  if (Date.parse(token.expiresAt) <= Date.now()) return { usable: false, email: null };
  const identity = identityRepo.getIdentity(token.identityId);
  if (!identity || identity.status !== "ACTIVE") return { usable: false, email: null };
  return { usable: true, email: identity.email };
}

/**
 * Complete sign-in. Single-use is enforced by a guarded consume — a
 * replayed link fails even when two requests race — and EVERY failure
 * throws the same message and status while the audit log keeps the
 * distinct reason.
 */
export function completeMagicLink(
  rawToken: string,
  options: { trustDevice: boolean; deviceLabel: string | null },
  meta: RequestMeta
): { session: AuthSession; cookieValue: string; user: User; identity: Identity } {
  const fail = (kind: string, identity: Identity | null, detail?: string): never => {
    recordAuthEvent({
      kind,
      identityId: identity?.id ?? null,
      email: identity?.email ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: detail ?? null,
    });
    registerFailure(meta, identity?.email ?? null, identity?.id ?? null);
    throw new IdentityError(GENERIC_AUTH_FAILURE, 400);
  };

  if (anyLocked(meta, null)) {
    recordAuthEvent({ kind: "LOGIN_BLOCKED_LOCKED_OUT", ip: meta.ip, userAgent: meta.userAgent });
    throw new IdentityError(GENERIC_AUTH_FAILURE, 400);
  }
  if (!TOKEN_SHAPE.test(rawToken)) fail("LOGIN_FAILED_MALFORMED_TOKEN", null);
  const token = identityRepo.findAuthTokenByHash(sha256Hex(rawToken));
  if (!token || token.purpose !== "MAGIC_LINK") fail("LOGIN_FAILED_UNKNOWN_TOKEN", null);
  const identity = identityRepo.getIdentity(token!.identityId);
  if (!identity) fail("LOGIN_FAILED_MISSING_IDENTITY", null);
  if (anyLocked(meta, identity!.email)) {
    recordAuthEvent({
      kind: "LOGIN_BLOCKED_LOCKED_OUT",
      identityId: identity!.id,
      email: identity!.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    throw new IdentityError(GENERIC_AUTH_FAILURE, 400);
  }
  if (token!.consumedAt) fail("LOGIN_REPLAY_BLOCKED", identity);
  if (Date.parse(token!.expiresAt) <= Date.now()) fail("LOGIN_FAILED_EXPIRED_LINK", identity);
  if (identity!.status !== "ACTIVE") fail("LOGIN_FAILED_INACTIVE_IDENTITY", identity, identity!.status);
  // The guarded consume is the replay barrier: under a race exactly one
  // request flips consumed_at, and the loser lands here.
  if (!identityRepo.consumeAuthToken(token!.id, nowIso())) fail("LOGIN_REPLAY_BLOCKED", identity);

  const membership = defaultMembership(identity!);
  if (!membership) {
    recordAuthEvent({
      kind: "LOGIN_FAILED_NO_MEMBERSHIP",
      identityId: identity!.id,
      email: identity!.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    throw new IdentityError(
      "Your account has no active organization membership. Ask an administrator to invite you.",
      403
    );
  }
  if (!identity!.emailVerifiedAt) {
    identityRepo.updateIdentityFields(identity!.id, { emailVerifiedAt: nowIso() });
    recordAuthEvent({ kind: "EMAIL_VERIFIED", identityId: identity!.id, email: identity!.email });
  }
  clearFailures(meta, identity!.email);
  const { session, cookieValue } = createSession(identity!, membership, options, meta, null);
  const user = repo.getUser(membership.userId)!;
  recordAuthEvent({
    kind: "SIGN_IN",
    identityId: identity!.id,
    userId: membership.userId,
    organizationId: membership.organizationId,
    sessionId: session.id,
    email: identity!.email,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail: options.trustDevice ? "trustedDevice=true" : null,
  });
  return { session, cookieValue, user, identity: identityRepo.getIdentity(identity!.id)! };
}

/** The membership a fresh sign-in lands on: the most recently used one
 *  that is still ACTIVE, else the oldest ACTIVE membership. */
function defaultMembership(identity: Identity): IdentityMembership | null {
  const active = identityRepo
    .listMembershipsForIdentity(identity.id)
    .filter((m) => m.status === "ACTIVE" && repo.getUser(m.userId));
  if (active.length === 0) return null;
  const lastSession = identityRepo.listSessionsForIdentity(identity.id, true)[0];
  if (lastSession) {
    const last = active.find((m) => m.userId === lastSession.userId);
    if (last) return last;
  }
  return active[0];
}

// ------------------------------------------------------------ sessions

export function createSession(
  identity: Identity,
  membership: IdentityMembership,
  options: { trustDevice: boolean; deviceLabel: string | null },
  meta: RequestMeta,
  inheritFrom: AuthSession | null
): { session: AuthSession; cookieValue: string } {
  const cfg = identityConfig();
  const id = randomBytes(16).toString("hex");
  const secret = randomBytes(32).toString("hex");
  const now = Date.now();
  const trusted = inheritFrom ? inheritFrom.trustedDevice : options.trustDevice;
  // The absolute deadline is fixed at initial sign-in; rotation inherits it.
  const absolute = inheritFrom
    ? inheritFrom.absoluteExpiresAt
    : new Date(now + (trusted ? cfg.trustedDeviceDays * DAY : cfg.sessionAbsoluteHours * HOUR)).toISOString();
  const idle = new Date(
    Math.min(now + cfg.sessionIdleMinutes * MINUTE, Date.parse(absolute))
  ).toISOString();
  const session: AuthSession = {
    id,
    identityId: identity.id,
    userId: membership.userId,
    secretHash: sha256Hex(secret),
    csrfToken: randomBytes(16).toString("hex"),
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    idleExpiresAt: idle,
    absoluteExpiresAt: absolute,
    trustedDevice: trusted,
    deviceLabel:
      (inheritFrom ? inheritFrom.deviceLabel : options.deviceLabel)?.slice(0, 120) ?? null,
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    revokedAt: null,
    revokedReason: null,
    rotatedTo: null,
  };
  identityRepo.insertAuthSession(session);
  return { session, cookieValue: `${id}.${secret}` };
}

export interface ResolvedSession {
  session: AuthSession;
  identity: Identity;
  membership: IdentityMembership;
  user: User;
}

/**
 * Validate a cookie value against the server-side record. Null for every
 * failure mode — malformed, unknown, wrong secret, revoked, idle-expired,
 * absolute-expired, inactive identity, inactive membership — so a caller
 * can only ever see "signed in" or "not signed in".
 */
export function resolveSession(cookieValue: string | undefined): ResolvedSession | null {
  if (!cookieValue) return null;
  const dot = cookieValue.indexOf(".");
  if (dot <= 0) return null;
  const id = cookieValue.slice(0, dot);
  const secret = cookieValue.slice(dot + 1);
  if (!SESSION_ID_SHAPE.test(id) || !TOKEN_SHAPE.test(secret)) return null;
  const session = identityRepo.getAuthSession(id);
  if (!session) return null;
  if (!safeStringEqual(sha256Hex(secret), session.secretHash)) return null;
  if (session.revokedAt) return null;
  const now = Date.now();
  if (Date.parse(session.absoluteExpiresAt) <= now) {
    // Expiry is recorded once, by revoking the row — later requests with
    // the same cookie short-circuit on revokedAt above.
    identityRepo.revokeAuthSession(session.id, nowIso(), "ABSOLUTE_TIMEOUT");
    recordAuthEvent({
      kind: "SESSION_EXPIRED",
      identityId: session.identityId,
      userId: session.userId,
      sessionId: session.id,
      detail: "absolute",
    });
    return null;
  }
  if (Date.parse(session.idleExpiresAt) <= now) {
    identityRepo.revokeAuthSession(session.id, nowIso(), "IDLE_TIMEOUT");
    recordAuthEvent({
      kind: "SESSION_EXPIRED",
      identityId: session.identityId,
      userId: session.userId,
      sessionId: session.id,
      detail: "idle",
    });
    return null;
  }
  const identity = identityRepo.getIdentity(session.identityId);
  if (!identity || identity.status !== "ACTIVE") return null;
  const membership = identityRepo.findMembershipByUserId(session.userId);
  if (!membership || membership.status !== "ACTIVE" || membership.identityId !== identity.id) return null;
  const user = repo.getUser(session.userId);
  if (!user) return null;
  if (now - Date.parse(session.lastSeenAt) > TOUCH_THROTTLE_MS) {
    const cfg = identityConfig();
    const idle = new Date(
      Math.min(now + cfg.sessionIdleMinutes * MINUTE, Date.parse(session.absoluteExpiresAt))
    ).toISOString();
    identityRepo.touchAuthSession(session.id, new Date(now).toISOString(), idle);
    session.lastSeenAt = new Date(now).toISOString();
    session.idleExpiresAt = idle;
  }
  return { session, identity, membership, user };
}

// ----------------------------------------------------- logout / revoke

export function logout(resolved: ResolvedSession, meta: RequestMeta): void {
  identityRepo.revokeAuthSession(resolved.session.id, nowIso(), "LOGOUT");
  recordAuthEvent({
    kind: "SIGN_OUT",
    identityId: resolved.identity.id,
    userId: resolved.user.id,
    sessionId: resolved.session.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

/** Sign out everywhere (including the current device). */
export function logoutEverywhere(resolved: ResolvedSession, meta: RequestMeta): number {
  const count = identityRepo.revokeAllSessionsForIdentity(
    resolved.identity.id,
    nowIso(),
    "LOGOUT_EVERYWHERE"
  );
  recordAuthEvent({
    kind: "SIGN_OUT_EVERYWHERE",
    identityId: resolved.identity.id,
    userId: resolved.user.id,
    sessionId: resolved.session.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    detail: `revoked=${count}`,
  });
  return count;
}

/** Per-device logout. A session id outside the caller's identity is
 *  indistinguishable from one that does not exist (same-404). */
export function revokeOwnSession(resolved: ResolvedSession, sessionId: string, meta: RequestMeta): void {
  const target = identityRepo.getAuthSession(String(sessionId ?? ""));
  if (!target || target.identityId !== resolved.identity.id || target.revokedAt) {
    throw new IdentityError("Not found", 404);
  }
  identityRepo.revokeAuthSession(target.id, nowIso(), "REVOKED_BY_OWNER");
  recordAuthEvent({
    kind: "SESSION_REVOKED",
    identityId: resolved.identity.id,
    userId: target.userId,
    sessionId: target.id,
    actorIdentityId: resolved.identity.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

// -------------------------------------------------------- org switching

/**
 * Switch the active organization: rotate to a NEW session bound to the
 * target membership's users row. The old session is revoked and points at
 * its successor; the absolute deadline carries over unchanged. A
 * membership id the identity does not hold is a plain 404.
 */
export function switchOrganization(
  resolved: ResolvedSession,
  membershipId: string,
  meta: RequestMeta
): { session: AuthSession; cookieValue: string; user: User } {
  const target = identityRepo.getMembership(String(membershipId ?? ""));
  if (!target || target.identityId !== resolved.identity.id) {
    throw new IdentityError("Not found", 404);
  }
  if (target.status !== "ACTIVE") {
    throw new IdentityError("This membership is not active", 403);
  }
  const user = repo.getUser(target.userId);
  if (!user) throw new IdentityError("Not found", 404);
  const { session, cookieValue } = createSession(
    resolved.identity,
    target,
    { trustDevice: resolved.session.trustedDevice, deviceLabel: resolved.session.deviceLabel },
    meta,
    resolved.session
  );
  identityRepo.revokeAuthSession(resolved.session.id, nowIso(), "ROTATED", session.id);
  recordAuthEvent({
    kind: "SESSION_ROTATED",
    identityId: resolved.identity.id,
    userId: target.userId,
    sessionId: resolved.session.id,
    detail: `to=${session.id}`,
  });
  recordAuthEvent({
    kind: "ORG_SWITCHED",
    identityId: resolved.identity.id,
    userId: target.userId,
    organizationId: target.organizationId,
    sessionId: session.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { session, cookieValue, user };
}

// ---------------------------------------------------------------- CSRF

/**
 * Synchronizer-token CSRF check for session-management POSTs: the
 * submitted value (header `x-obv-csrf` or form field `csrf`) must equal
 * the token stored on the server-side session row, compared in constant
 * time. The obv_csrf cookie is a convenience copy for fetch() callers —
 * validation never trusts it.
 */
export function requireCsrf(resolved: ResolvedSession, submitted: string | null | undefined): void {
  if (!submitted || !safeStringEqual(String(submitted), resolved.session.csrfToken)) {
    recordAuthEvent({
      kind: "CSRF_REJECTED",
      identityId: resolved.identity.id,
      sessionId: resolved.session.id,
    });
    throw new IdentityError("Invalid or missing CSRF token", 403);
  }
}

// -------------------------------------------------------- cookie headers

/** Set-Cookie headers for a live session (auth + csrf copy). */
export function authCookieHeaders(secure: boolean, cookieValue: string, session: AuthSession): string[] {
  const maxAge = Math.max(1, Math.floor((Date.parse(session.absoluteExpiresAt) - Date.now()) / 1000));
  const base = ["Path=/", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (secure) base.push("Secure");
  return [
    `${AUTH_COOKIE}=${cookieValue}; ${[...base, "HttpOnly"].join("; ")}`,
    `${CSRF_COOKIE}=${session.csrfToken}; ${base.join("; ")}`,
  ];
}

/** Expire both auth cookies. */
export function clearAuthCookieHeaders(secure: boolean): string[] {
  const base = ["Path=/", "SameSite=Lax", "Max-Age=0"];
  if (secure) base.push("Secure");
  return [
    `${AUTH_COOKIE}=; ${[...base, "HttpOnly"].join("; ")}`,
    `${CSRF_COOKIE}=; ${base.join("; ")}`,
  ];
}
