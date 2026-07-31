/**
 * Identity platform repository — all SQL for durable identities, org
 * memberships (identity_users), single-use auth tokens, server-side
 * sessions, the append-only auth event log, and brute-force lockout state.
 *
 * INVARIANTS ENFORCED HERE
 *  - auth_events is append-only: this module exposes insert and SELECT
 *    only. No update or delete statement for auth_events exists anywhere.
 *  - auth_tokens are single-use: consumption is a guarded UPDATE
 *    (`WHERE consumed_at IS NULL`) whose change count is the truth — under
 *    a race exactly one caller wins.
 *  - session revocation is equally guarded, so a session revokes once and
 *    the audit trail cannot double-report.
 *  - identity_providers and mfa_methods are READ-ONLY readiness registries:
 *    no insert function is defined for either (government-foundation
 *    pattern — the shape exists, no write path does).
 */
import { getDb } from "./index";
import type {
  AuthEvent,
  AuthLockout,
  AuthSession,
  AuthToken,
  Identity,
  IdentityMembership,
  IdentityProviderRecord,
  MfaMethodRecord,
} from "../../shared/types";

type Row = Record<string, unknown>;

// ---------- identities ----------

function toIdentity(r: Row): Identity {
  return {
    id: r.id as string,
    email: r.email as string,
    displayName: r.display_name as string,
    emailVerifiedAt: (r.email_verified_at as string) ?? null,
    status: r.status as Identity["status"],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertIdentity(i: Identity): void {
  getDb()
    .prepare(
      `INSERT INTO identities (id, email, display_name, email_verified_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(i.id, i.email, i.displayName, i.emailVerifiedAt, i.status, i.createdAt, i.updatedAt);
}

export function getIdentity(id: string): Identity | null {
  const r = getDb().prepare("SELECT * FROM identities WHERE id = ?").get(id);
  return r ? toIdentity(r as Row) : null;
}

export function findIdentityByEmail(normalizedEmail: string): Identity | null {
  const r = getDb().prepare("SELECT * FROM identities WHERE email = ?").get(normalizedEmail);
  return r ? toIdentity(r as Row) : null;
}

export function countIdentities(): number {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM identities").get() as Row;
  return r.n as number;
}

export function updateIdentityFields(
  id: string,
  patch: Partial<Pick<Identity, "displayName" | "emailVerifiedAt" | "status">>
): void {
  const cur = getIdentity(id);
  if (!cur) return;
  getDb()
    .prepare(
      `UPDATE identities SET display_name = ?, email_verified_at = ?, status = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      patch.displayName ?? cur.displayName,
      patch.emailVerifiedAt !== undefined ? patch.emailVerifiedAt : cur.emailVerifiedAt,
      patch.status ?? cur.status,
      new Date().toISOString(),
      id
    );
}

// ---------- memberships (identity_users) ----------

function toMembership(r: Row): IdentityMembership {
  return {
    id: r.id as string,
    identityId: r.identity_id as string,
    userId: r.user_id as string,
    organizationId: r.organization_id as string,
    status: r.status as IdentityMembership["status"],
    isOwner: Boolean(r.is_owner),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertMembership(m: IdentityMembership): void {
  getDb()
    .prepare(
      `INSERT INTO identity_users (id, identity_id, user_id, organization_id, status, is_owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(m.id, m.identityId, m.userId, m.organizationId, m.status, m.isOwner ? 1 : 0, m.createdAt, m.updatedAt);
}

export function getMembership(id: string): IdentityMembership | null {
  const r = getDb().prepare("SELECT * FROM identity_users WHERE id = ?").get(id);
  return r ? toMembership(r as Row) : null;
}

export function findMembershipByUserId(userId: string): IdentityMembership | null {
  const r = getDb().prepare("SELECT * FROM identity_users WHERE user_id = ?").get(userId);
  return r ? toMembership(r as Row) : null;
}

export function findMembershipForOrg(identityId: string, organizationId: string): IdentityMembership | null {
  const r = getDb()
    .prepare("SELECT * FROM identity_users WHERE identity_id = ? AND organization_id = ?")
    .get(identityId, organizationId);
  return r ? toMembership(r as Row) : null;
}

export function listMembershipsForIdentity(identityId: string): IdentityMembership[] {
  return getDb()
    .prepare("SELECT * FROM identity_users WHERE identity_id = ? ORDER BY created_at ASC")
    .all(identityId)
    .map((r) => toMembership(r as Row));
}

export function listMembershipsForOrganization(organizationId: string): IdentityMembership[] {
  return getDb()
    .prepare("SELECT * FROM identity_users WHERE organization_id = ? ORDER BY created_at ASC")
    .all(organizationId)
    .map((r) => toMembership(r as Row));
}

export function updateMembershipFields(
  id: string,
  patch: Partial<Pick<IdentityMembership, "status" | "isOwner">>
): void {
  const cur = getMembership(id);
  if (!cur) return;
  getDb()
    .prepare("UPDATE identity_users SET status = ?, is_owner = ?, updated_at = ? WHERE id = ?")
    .run(
      patch.status ?? cur.status,
      (patch.isOwner !== undefined ? patch.isOwner : cur.isOwner) ? 1 : 0,
      new Date().toISOString(),
      id
    );
}

// ---------- auth tokens (single-use) ----------

function toAuthToken(r: Row): AuthToken {
  return {
    id: r.id as string,
    identityId: r.identity_id as string,
    purpose: r.purpose as AuthToken["purpose"],
    tokenHash: r.token_hash as string,
    createdAt: r.created_at as string,
    expiresAt: r.expires_at as string,
    consumedAt: (r.consumed_at as string) ?? null,
    requestIp: (r.request_ip as string) ?? null,
    requestAgent: (r.request_agent as string) ?? null,
  };
}

export function insertAuthToken(t: AuthToken): void {
  getDb()
    .prepare(
      `INSERT INTO auth_tokens (id, identity_id, purpose, token_hash, created_at, expires_at, consumed_at, request_ip, request_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      t.id, t.identityId, t.purpose, t.tokenHash, t.createdAt, t.expiresAt,
      t.consumedAt, t.requestIp, t.requestAgent
    );
}

export function findAuthTokenByHash(tokenHash: string): AuthToken | null {
  const r = getDb().prepare("SELECT * FROM auth_tokens WHERE token_hash = ?").get(tokenHash);
  return r ? toAuthToken(r as Row) : null;
}

/** Consume a token exactly once. Returns false when it was already
 *  consumed — the loser of a replay race learns only that it lost. */
export function consumeAuthToken(id: string, consumedAt: string): boolean {
  const result = getDb()
    .prepare("UPDATE auth_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
    .run(consumedAt, id);
  return result.changes === 1;
}

/** Issuance throttle input: tokens created for an identity since a cutoff. */
export function countRecentAuthTokens(identityId: string, purpose: string, sinceIso: string): number {
  const r = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM auth_tokens WHERE identity_id = ? AND purpose = ? AND created_at >= ?"
    )
    .get(identityId, purpose, sinceIso) as Row;
  return r.n as number;
}

// ---------- auth sessions ----------

function toAuthSession(r: Row): AuthSession {
  return {
    id: r.id as string,
    identityId: r.identity_id as string,
    userId: r.user_id as string,
    secretHash: r.secret_hash as string,
    csrfToken: r.csrf_token as string,
    createdAt: r.created_at as string,
    lastSeenAt: r.last_seen_at as string,
    idleExpiresAt: r.idle_expires_at as string,
    absoluteExpiresAt: r.absolute_expires_at as string,
    trustedDevice: Boolean(r.trusted_device),
    deviceLabel: (r.device_label as string) ?? null,
    ip: (r.ip as string) ?? null,
    userAgent: (r.user_agent as string) ?? null,
    revokedAt: (r.revoked_at as string) ?? null,
    revokedReason: (r.revoked_reason as string) ?? null,
    rotatedTo: (r.rotated_to as string) ?? null,
  };
}

export function insertAuthSession(s: AuthSession): void {
  getDb()
    .prepare(
      `INSERT INTO auth_sessions (
         id, identity_id, user_id, secret_hash, csrf_token, created_at, last_seen_at,
         idle_expires_at, absolute_expires_at, trusted_device, device_label, ip,
         user_agent, revoked_at, revoked_reason, rotated_to
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      s.id, s.identityId, s.userId, s.secretHash, s.csrfToken, s.createdAt,
      s.lastSeenAt, s.idleExpiresAt, s.absoluteExpiresAt, s.trustedDevice ? 1 : 0,
      s.deviceLabel, s.ip, s.userAgent, s.revokedAt, s.revokedReason, s.rotatedTo
    );
}

export function getAuthSession(id: string): AuthSession | null {
  const r = getDb().prepare("SELECT * FROM auth_sessions WHERE id = ?").get(id);
  return r ? toAuthSession(r as Row) : null;
}

export function listSessionsForIdentity(identityId: string, includeRevoked = false): AuthSession[] {
  const sql = includeRevoked
    ? "SELECT * FROM auth_sessions WHERE identity_id = ? ORDER BY created_at DESC"
    : "SELECT * FROM auth_sessions WHERE identity_id = ? AND revoked_at IS NULL ORDER BY created_at DESC";
  return getDb().prepare(sql).all(identityId).map((r) => toAuthSession(r as Row));
}

/** Activity touch: slides the idle window forward. Never extends the
 *  absolute expiry — that is fixed at sign-in. */
export function touchAuthSession(id: string, lastSeenAt: string, idleExpiresAt: string): void {
  getDb()
    .prepare("UPDATE auth_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(lastSeenAt, idleExpiresAt, id);
}

/** Revoke exactly once; returns false if the session was already revoked. */
export function revokeAuthSession(id: string, at: string, reason: string, rotatedTo: string | null = null): boolean {
  const result = getDb()
    .prepare(
      "UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ?, rotated_to = ? WHERE id = ? AND revoked_at IS NULL"
    )
    .run(at, reason, rotatedTo, id);
  return result.changes === 1;
}

/** Sign out everywhere. Returns the number of sessions revoked. */
export function revokeAllSessionsForIdentity(
  identityId: string,
  at: string,
  reason: string,
  exceptSessionId: string | null = null
): number {
  const result = exceptSessionId
    ? getDb()
        .prepare(
          "UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE identity_id = ? AND revoked_at IS NULL AND id <> ?"
        )
        .run(at, reason, identityId, exceptSessionId)
    : getDb()
        .prepare(
          "UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE identity_id = ? AND revoked_at IS NULL"
        )
        .run(at, reason, identityId);
  return Number(result.changes);
}

// ---------- auth events (append-only) ----------

function toAuthEvent(r: Row): AuthEvent {
  return {
    id: r.id as string,
    occurredAt: r.occurred_at as string,
    kind: r.kind as string,
    identityId: (r.identity_id as string) ?? null,
    userId: (r.user_id as string) ?? null,
    organizationId: (r.organization_id as string) ?? null,
    sessionId: (r.session_id as string) ?? null,
    actorIdentityId: (r.actor_identity_id as string) ?? null,
    email: (r.email as string) ?? null,
    ip: (r.ip as string) ?? null,
    userAgent: (r.user_agent as string) ?? null,
    detail: (r.detail as string) ?? null,
  };
}

export function insertAuthEvent(e: AuthEvent): void {
  getDb()
    .prepare(
      `INSERT INTO auth_events (
         id, occurred_at, kind, identity_id, user_id, organization_id, session_id,
         actor_identity_id, email, ip, user_agent, detail
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.occurredAt, e.kind, e.identityId, e.userId, e.organizationId,
      e.sessionId, e.actorIdentityId, e.email, e.ip, e.userAgent, e.detail
    );
}

export function listAuthEventsForIdentity(identityId: string, limit = 50): AuthEvent[] {
  return getDb()
    .prepare("SELECT * FROM auth_events WHERE identity_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?")
    .all(identityId, limit)
    .map((r) => toAuthEvent(r as Row));
}

export function listAuthEventsByKind(kind: string, limit = 50): AuthEvent[] {
  return getDb()
    .prepare("SELECT * FROM auth_events WHERE kind = ? ORDER BY occurred_at DESC, id DESC LIMIT ?")
    .all(kind, limit)
    .map((r) => toAuthEvent(r as Row));
}

// ---------- lockouts ----------

function toLockout(r: Row): AuthLockout {
  return {
    scope: r.scope as string,
    failureCount: r.failure_count as number,
    firstFailureAt: (r.first_failure_at as string) ?? null,
    lastFailureAt: (r.last_failure_at as string) ?? null,
    lockedUntil: (r.locked_until as string) ?? null,
  };
}

export function getLockout(scope: string): AuthLockout | null {
  const r = getDb().prepare("SELECT * FROM auth_lockouts WHERE scope = ?").get(scope);
  return r ? toLockout(r as Row) : null;
}

export function upsertLockout(l: AuthLockout): void {
  getDb()
    .prepare(
      `INSERT INTO auth_lockouts (scope, failure_count, first_failure_at, last_failure_at, locked_until)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         failure_count = excluded.failure_count,
         first_failure_at = excluded.first_failure_at,
         last_failure_at = excluded.last_failure_at,
         locked_until = excluded.locked_until`
    )
    .run(l.scope, l.failureCount, l.firstFailureAt, l.lastFailureAt, l.lockedUntil);
}

export function clearLockout(scope: string): void {
  getDb().prepare("DELETE FROM auth_lockouts WHERE scope = ?").run(scope);
}

// ---------- readiness registries (SELECT only — no write path) ----------

export function listIdentityProviders(): IdentityProviderRecord[] {
  return getDb()
    .prepare("SELECT * FROM identity_providers ORDER BY created_at ASC")
    .all()
    .map((r) => {
      const row = r as Row;
      return {
        id: row.id as string,
        kind: row.kind as IdentityProviderRecord["kind"],
        protocol: row.protocol as IdentityProviderRecord["protocol"],
        displayName: row.display_name as string,
        organizationId: (row.organization_id as string) ?? null,
        issuer: (row.issuer as string) ?? null,
        status: "DISABLED",
        createdAt: row.created_at as string,
      };
    });
}

export function listMfaMethodsForIdentity(identityId: string): MfaMethodRecord[] {
  return getDb()
    .prepare("SELECT * FROM mfa_methods WHERE identity_id = ? ORDER BY created_at ASC")
    .all(identityId)
    .map((r) => {
      const row = r as Row;
      return {
        id: row.id as string,
        identityId: row.identity_id as string,
        kind: row.kind as MfaMethodRecord["kind"],
        label: (row.label as string) ?? null,
        status: "DISABLED",
        createdAt: row.created_at as string,
      };
    });
}
