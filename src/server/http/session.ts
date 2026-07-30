/**
 * Tamper-evident demo sessions.
 *
 * The identity cookie used to be the raw user primary key: `obv_user=user-funder`
 * was a complete, forgeable credential that anyone could type without ever
 * signing in. Identity is now a signed, expiring token
 *
 *     v1.<base64url(payload)>.<base64url(HMAC-SHA256(payload))>
 *
 * where the MAC is computed under a server-held secret. A forged, modified,
 * truncated or expired cookie fails verification and is treated as no session
 * at all — never as a partially trusted one.
 *
 * This does NOT add passwords. The seeded role switcher remains how a demo
 * session is obtained; what changes is that the resulting cookie can no
 * longer be fabricated or edited by the client.
 *
 * Node built-ins only (node:crypto) — the application has zero runtime
 * dependencies.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";

export const SESSION_COOKIE = "obv_user";

const VERSION = "v1";
/** Sessions last a day, matching the previous cookie Max-Age. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Shortest secret we will accept when one is required. */
const MIN_SECRET_LENGTH = 32;

/**
 * A deployment is treated as production when it says so. In that posture a
 * real secret is mandatory and the process refuses to start without one —
 * the same "refuse rather than silently degrade" rule the banking layer
 * already applies to non-mock providers.
 */
function productionPosture(): boolean {
  // Deliberately NOT keyed on NODE_ENV. The Dockerfile sets
  // NODE_ENV=production for Node's own runtime behaviour, so treating it as
  // a security posture signal would make every container refuse to start
  // unless a secret happened to be supplied — turning a hardening change
  // into a deploy outage. Posture is declared explicitly instead, using the
  // same OBV_BANKING_MODE switch the banking layer already keys on.
  return (
    process.env.OBV_BANKING_MODE === "production" ||
    /^(1|true)$/i.test(process.env.OBV_SESSION_REQUIRE_SECRET ?? "")
  );
}

export class SessionConfigError extends Error {}

function resolveSecret(): { secret: string; ephemeral: boolean } {
  const configured = (process.env.OBV_SESSION_SECRET ?? "").trim();
  if (configured) {
    if (configured.length < MIN_SECRET_LENGTH) {
      throw new SessionConfigError(
        `OBV_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters ` +
          `(got ${configured.length}). Generate one with: ` +
          `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
      );
    }
    return { secret: configured, ephemeral: false };
  }
  if (productionPosture()) {
    throw new SessionConfigError(
      "OBV_SESSION_SECRET is required in production. Sessions are signed with it; " +
        "without it identity cookies would be forgeable. Generate one with: " +
        'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  // Demo / development / test: mint a per-boot secret so the app runs with
  // zero configuration and cookies are still unforgeable. Sessions simply do
  // not survive a restart, which is the honest trade and is stated at boot.
  return { secret: randomBytes(32).toString("hex"), ephemeral: true };
}

/**
 * Resolved lazily so a misconfiguration surfaces as a controlled startup
 * failure (see assertSessionConfig) rather than an uncaught exception
 * during module import, which would print a stack trace instead of the
 * one-line instruction an operator needs.
 */
let resolved: { secret: string; ephemeral: boolean } | null = null;
function secretState(): { secret: string; ephemeral: boolean } {
  if (!resolved) resolved = resolveSecret();
  return resolved;
}

/** Validate session configuration at startup, alongside the banking check. */
export function assertSessionConfig(): void {
  secretState();
}

export function sessionSecretIsEphemeral(): boolean {
  return secretState().ephemeral;
}

/**
 * Whether the seeded role switcher (`GET /demo`, `POST /api/session`) is
 * available. It is a passwordless demo affordance, so it is enabled for the
 * demo and disabled under production posture, where impersonating any user
 * by id would be an authentication bypass rather than a feature.
 * `OBV_DEMO_AUTH=1|0` overrides either way.
 */
export function demoAuthEnabled(): boolean {
  const override = (process.env.OBV_DEMO_AUTH ?? "").trim();
  if (override) return /^(1|true)$/i.test(override);
  return !productionPosture();
}

/**
 * Seeded demo identities are `user-<name>`; people created through real pilot
 * invitations get a UUID. Only the seeded ones may be listed, so the switcher
 * can never enumerate a tenant's actual staff.
 */
export function isSeededDemoUserId(id: string): boolean {
  return /^user-[a-z0-9-]+$/.test(id);
}

/** One-line startup disclosure — never prints the secret itself. */
export function sessionStartupNotice(): string {
  return secretState().ephemeral
    ? "sessions: signed with an EPHEMERAL per-boot secret (set OBV_SESSION_SECRET to survive restarts)"
    : "sessions: signed with the configured OBV_SESSION_SECRET";
}

const b64url = (b: Buffer): string => b.toString("base64url");

function sign(payload: string): string {
  return b64url(createHmac("sha256", secretState().secret).update(`${VERSION}.${payload}`).digest());
}

function macMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Mint a signed session token for a user id. */
export function issueSessionToken(userId: string, nowMs = Date.now()): string {
  const payload = b64url(
    Buffer.from(JSON.stringify({ u: userId, iat: nowMs, exp: nowMs + SESSION_TTL_MS }), "utf8")
  );
  return `${VERSION}.${payload}.${sign(payload)}`;
}

/**
 * Recover the user id from a cookie value, or null.
 *
 * Returns null for every failure mode — wrong version, malformed shape, bad
 * MAC, unparseable payload, expired — so a caller cannot accidentally treat
 * a rejected token as anything other than "not signed in".
 */
export function readSessionToken(token: string | undefined, nowMs = Date.now()): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, payload, mac] = parts;
  if (version !== VERSION || !payload || !mac) return null;
  if (!macMatches(sign(payload), mac)) return null;
  let claims: { u?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims.u !== "string" || !claims.u) return null;
  if (typeof claims.exp !== "number" || !(claims.exp > nowMs)) return null;
  return claims.u;
}

/**
 * Whether cookies should carry Secure. The app terminates plain HTTP behind
 * a TLS-terminating proxy (Render), so the forwarded protocol is the signal.
 * Trusting that header can only ever ADD Secure — a client cannot use it to
 * remove the flag — so it carries no downgrade risk, and local development
 * over http keeps working.
 */
export function requestIsSecure(req: http.IncomingMessage): boolean {
  if (/^(1|true)$/i.test(process.env.OBV_FORCE_SECURE_COOKIES ?? "")) return true;
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  if (forwarded) return forwarded.toLowerCase() === "https";
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

/** The complete Set-Cookie header value for a new session. */
export function sessionCookieHeader(req: http.IncomingMessage, userId: string): string {
  const flags = ["Path=/", "SameSite=Lax", "HttpOnly", `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (requestIsSecure(req)) flags.push("Secure");
  return `${SESSION_COOKIE}=${issueSessionToken(userId)}; ${flags.join("; ")}`;
}
