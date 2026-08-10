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
import { composeEmail, sendEmail } from "../integrations/email";
import { productionPosture } from "../posture";
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
  deliveryMode: "file" | "off" | "email";
}

// Production posture comes from the single resolver in services/posture.ts
// (OBV_ENVIRONMENT plus legacy-flag compatibility), never NODE_ENV.

export function identityConfig(): IdentityConfig {
  const configured = (process.env.OBV_AUTH_LINK_DELIVERY ?? "").trim().toLowerCase();
  if (!configured && productionPosture()) {
    // The file outbox writes live (single-use, short-TTL) sign-in links to
    // the data volume. That is a deliberate development affordance — a
    // production operator must CHOOSE it, not inherit it silently.
    throw new IdentityError(
      "OBV_AUTH_LINK_DELIVERY must be set explicitly in production: 'email' delivers sign-in links " +
        "through the configured OBV_EMAIL_PROVIDER (the pilot setting), 'file' writes them to the " +
        "data-directory outbox (development only — live links land on the data volume), 'off' mints " +
        "without delivering.",
      500
    );
  }
  const mode = configured || "file";
  if (mode !== "file" && mode !== "off" && mode !== "email") {
    throw new IdentityError(
      `OBV_AUTH_LINK_DELIVERY must be "email" (deliver through the configured email provider), ` +
        `"file" (development outbox under the data directory) or "off" (got "${mode}").`,
      500
    );
  }
  if (mode === "email") {
    // 'email' promises real delivery. The development outbox is not a
    // wire — a magic link "sent" there is redacted and reaches no one —
    // so this combination is a black hole and refuses to start. There is
    // no silent fallback from a real provider to the outbox, in any
    // posture.
    const provider = (process.env.OBV_EMAIL_PROVIDER ?? "outbox").trim().toLowerCase() || "outbox";
    if (provider === "outbox") {
      throw new IdentityError(
        // Names the setting, not a vendor: identity must stay correct when
        // the deployment's delivery provider changes.
        "OBV_AUTH_LINK_DELIVERY=email requires a real email provider, but OBV_EMAIL_PROVIDER " +
          "is 'outbox' (the development mailbox). Set OBV_EMAIL_PROVIDER to a live provider " +
          "with its credentials, or use OBV_AUTH_LINK_DELIVERY=file for development.",
        500
      );
    }
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
  return cfg.deliveryMode === "email"
    ? "identity: magic-link sign-in active (link delivery: EMAIL through the configured provider)"
    : cfg.deliveryMode === "file"
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
 * THE delivery seam. Every sign-in link leaves the process through here;
 * nothing else in the platform knows or cares how the link travels.
 *
 *  - "email": the link goes to the configured REAL provider through
 *    sendEmail. The outbox row is redacted BY KIND (MAGIC_LINK), so the
 *    raw link reaches the wire but can never be read back out of the
 *    database or an outbox dashboard. Startup already refused this mode
 *    without a real provider — there is no fallback to the file outbox.
 *  - "file": development. A redacted observability record is written via
 *    sendEmail, and the raw link is appended to the data-directory
 *    outbox file (deterministic capture for tests and local sign-in).
 *  - "off": the redacted record only; the link is dropped.
 *
 * The raw link is never logged and never written to the database in any
 * mode.
 */
export function deliverSignInLink(email: string, link: string, purpose: string): void {
  const cfg = identityConfig();
  if (cfg.deliveryMode === "email") {
    // Provider failure is recorded on the outbox row and the integration
    // audit trail; it never throws into the sign-in flow (the requester
    // response stays the same non-oracle either way).
    try {
      const composed = composeEmail("MAGIC_LINK", { link });
      sendEmail({ kind: "MAGIC_LINK", to: email, subject: composed.subject, text: composed.text, containsCredential: true });
    } catch {
      /* recorded by the email layer; sign-in flow is never interrupted */
    }
    return;
  }
  try {
    const composed = composeEmail("MAGIC_LINK", {});
    sendEmail({ kind: "MAGIC_LINK", to: email, subject: composed.subject, text: composed.text, containsCredential: true });
  } catch {
    // The redacted record is observability, never a delivery dependency.
  }
  if (cfg.deliveryMode === "off") return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(
    authOutboxPath(),
    JSON.stringify({ at: nowIso(), to: email, purpose, link }) + "\n",
    "utf8"
  );
}
