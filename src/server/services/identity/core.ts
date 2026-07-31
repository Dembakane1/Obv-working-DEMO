/**
 * Identity platform core: typed error, configuration, hashing, the
 * append-only event recorder, and sign-in link delivery.
 *
 * SECURITY DOCTRINE
 *  - Sign-in is passwordless: possession of a short-lived, single-use,
 *    cryptographically random link token is the credential. Passwords have
 *    an architectural slot in the schema and NOTHING else — no code path
 *    accepts, stores, or verifies one.
 *  - Responses about sign-in attempts are non-oracles: requesting a link
 *    for an unknown, suspended, throttled, or locked address produces the
 *    same generic success as a real one, and every failed completion
 *    produces the same generic message and status regardless of cause.
 *  - The raw link token exists in exactly one place: the delivered link.
 *    Storage holds sha256 only; logs and events never contain it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../db/index";
import * as identityRepo from "../../db/identityRepo";
import * as repo from "../../db/repo";
import type { AuthEvent } from "../../../shared/types";

export class IdentityError extends Error {
  constructor(
    message: string,
    public statusCode = 400
  ) {
    super(message);
  }
}

/** The one message every failed sign-in completion gets, so the response
 *  cannot distinguish unknown, expired, consumed, or tampered tokens. */
export const GENERIC_AUTH_FAILURE =
  "This sign-in link is invalid, expired, or has already been used. Request a new one.";

/** The one message every link request gets, real address or not. */
export const GENERIC_LINK_RESPONSE =
  "If that email address belongs to an account, a sign-in link has been sent to it.";

// ------------------------------------------------------------- config

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new IdentityError(
      `${name} must be a number between ${min} and ${max} (got "${raw}")`,
      500
    );
  }
  return Math.floor(n);
}

export interface IdentityConfig {
  magicLinkTtlMinutes: number;
  linkRequestsPerWindow: number;
  linkRequestWindowMinutes: number;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  trustedDeviceDays: number;
  lockoutThreshold: number;
  lockoutWindowMinutes: number;
  lockoutDurationMinutes: number;
  deliveryMode: "file" | "off";
}

/** Same explicit-declaration rule the session layer uses: production
 *  posture is OBV_BANKING_MODE=production or OBV_SESSION_REQUIRE_SECRET,
 *  never NODE_ENV. */
function productionPosture(): boolean {
  return (
    process.env.OBV_BANKING_MODE === "production" ||
    /^(1|true)$/i.test(process.env.OBV_SESSION_REQUIRE_SECRET ?? "")
  );
}

export function identityConfig(): IdentityConfig {
  const configured = (process.env.OBV_AUTH_LINK_DELIVERY ?? "").trim().toLowerCase();
  if (!configured && productionPosture()) {
    // The file outbox writes live (single-use, short-TTL) sign-in links to
    // the data volume. That is a deliberate development affordance — a
    // production operator must CHOOSE it, not inherit it silently.
    throw new IdentityError(
      "OBV_AUTH_LINK_DELIVERY must be set explicitly in production ('file' for the data-directory outbox, " +
        "'off' to mint without delivering). The file outbox stores live sign-in links on the data volume, " +
        "so production must opt into it deliberately — or plug an email provider into deliverSignInLink.",
      500
    );
  }
  const mode = configured || "file";
  if (mode !== "file" && mode !== "off") {
    throw new IdentityError(
      `OBV_AUTH_LINK_DELIVERY must be "file" (development outbox under the data directory) or "off" (got "${mode}"). ` +
        "A real deployment plugs its email provider into deliverSignInLink — that function is the single delivery seam.",
      500
    );
  }
  return {
    magicLinkTtlMinutes: intEnv("OBV_AUTH_LINK_TTL_MINUTES", 15, 1, 120),
    linkRequestsPerWindow: intEnv("OBV_AUTH_LINK_MAX_PER_WINDOW", 5, 1, 100),
    linkRequestWindowMinutes: intEnv("OBV_AUTH_LINK_WINDOW_MINUTES", 15, 1, 1440),
    sessionIdleMinutes: intEnv("OBV_AUTH_IDLE_MINUTES", 60, 1, 24 * 60),
    sessionAbsoluteHours: intEnv("OBV_AUTH_ABSOLUTE_HOURS", 12, 1, 24 * 90),
    trustedDeviceDays: intEnv("OBV_AUTH_TRUSTED_DEVICE_DAYS", 30, 1, 365),
    lockoutThreshold: intEnv("OBV_AUTH_LOCKOUT_THRESHOLD", 5, 2, 100),
    lockoutWindowMinutes: intEnv("OBV_AUTH_LOCKOUT_WINDOW_MINUTES", 15, 1, 1440),
    lockoutDurationMinutes: intEnv("OBV_AUTH_LOCKOUT_MINUTES", 15, 1, 1440),
    deliveryMode: mode,
  };
}

/** Startup validation, run alongside the banking and session checks: a
 *  misconfigured identity platform must refuse to start with a one-line
 *  instruction, never silently degrade. */
export function assertIdentityConfig(): void {
  identityConfig();
  const bootstrap = (process.env.OBV_BOOTSTRAP_ADMIN_EMAIL ?? "").trim();
  if (bootstrap && !normalizeEmail(bootstrap)) {
    throw new IdentityError(
      `OBV_BOOTSTRAP_ADMIN_EMAIL is set but is not a valid email address ("${bootstrap}")`,
      500
    );
  }
}

export function identityStartupNotice(): string {
  const cfg = identityConfig();
  return cfg.deliveryMode === "file"
    ? "identity: magic-link sign-in active (link delivery: development file outbox under the data directory)"
    : "identity: magic-link sign-in active (link delivery: OFF — links are minted but not delivered)";
}

// ------------------------------------------------------------ helpers

/** Lowercased, trimmed, shape-validated — or null. The normalized form is
 *  the identity key, so the same person never forks on case or spacing. */
export function normalizeEmail(raw: unknown): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
  return email;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison of two same-purpose strings. */
export function safeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const nowIso = (): string => new Date().toISOString();
export const plusMs = (ms: number): string => new Date(Date.now() + ms).toISOString();
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

// ---------------------------------------------------- event recording

/** Append one immutable auth event. Callers pass what they know; identity
 *  and session references are nullable by design (failed attempts against
 *  unknown addresses still leave a trace). */
export function recordAuthEvent(
  entry: Omit<AuthEvent, "id" | "occurredAt"> | (Partial<AuthEvent> & { kind: string })
): void {
  identityRepo.insertAuthEvent({
    id: repo.newId(),
    occurredAt: nowIso(),
    kind: entry.kind,
    identityId: entry.identityId ?? null,
    userId: entry.userId ?? null,
    organizationId: entry.organizationId ?? null,
    sessionId: entry.sessionId ?? null,
    actorIdentityId: entry.actorIdentityId ?? null,
    email: entry.email ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    detail: entry.detail ?? null,
  });
}

// ------------------------------------------------------ link delivery

/** Where the development outbox lives. It is data, not code: under the
 *  runtime data directory, never in the repository. */
export function authOutboxPath(): string {
  return path.join(DATA_DIR, "auth-outbox.jsonl");
}

/**
 * THE delivery seam. Production deployments replace the body of the
 * "file" branch with their email provider; nothing else in the platform
 * knows or cares how the link travels. The raw link is passed through —
 * it is never logged, never written to the database, and in "off" mode it
 * is simply dropped (minted but undeliverable, stated at startup).
 */
export function deliverSignInLink(email: string, link: string, purpose: string): void {
  const cfg = identityConfig();
  if (cfg.deliveryMode === "off") return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(
    authOutboxPath(),
    JSON.stringify({ at: nowIso(), to: email, purpose, link }) + "\n",
    "utf8"
  );
}
