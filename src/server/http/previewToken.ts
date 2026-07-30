/**
 * Render tokens for the headless-PDF path.
 *
 * Generating a PDF means Chromium fetches the report HTML back from this
 * server, and Chromium has no session. The previous design handed it a
 * single process-wide `randomUUID()` that never expired and was accepted
 * for ANY report id — so one leaked URL was a permanent, unscoped read
 * capability over every report the process would ever cache.
 *
 * A render token is now:
 *   - cryptographically random (32 bytes from node:crypto);
 *   - scoped to exactly ONE subject (a report id or package key);
 *   - single-purpose (accepted only by /report-cache, never by any other
 *     route, and never in place of a session);
 *   - short-lived (seconds, not the process lifetime);
 *   - single-use (consumed on first successful fetch);
 *   - non-transferable: presenting it for a different subject fails, so a
 *     token minted for one tenant's report can never read another's.
 *
 * Tenant authorization happens BEFORE minting — the caller has already
 * passed the report's own access check — so the token carries no authority
 * of its own beyond the one object it names.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Deliberately short: it only has to survive one local Chromium fetch. */
const DEFAULT_TTL_MS = 60_000;

interface RenderTokenRecord {
  subjectId: string;
  expiresAt: number;
}

const tokens = new Map<string, RenderTokenRecord>();

/** Drop expired records so a long-running process cannot accumulate them. */
function sweep(now: number): void {
  for (const [token, rec] of tokens) {
    if (rec.expiresAt <= now) tokens.delete(token);
  }
}

/** Mint a token bound to one subject. The caller must already have
 *  authorized the subject for the requesting user. */
export function mintRenderToken(subjectId: string, ttlMs = DEFAULT_TTL_MS): string {
  const now = Date.now();
  sweep(now);
  const token = randomBytes(32).toString("base64url");
  tokens.set(token, { subjectId, expiresAt: now + ttlMs });
  return token;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Validate and CONSUME a token for a specific subject.
 *
 * Returns false for unknown, expired, already-used, and — critically —
 * for a token that is valid but was minted for a different subject.
 */
export function consumeRenderToken(token: string | null | undefined, subjectId: string): boolean {
  if (!token) return false;
  const now = Date.now();
  sweep(now);
  const rec = tokens.get(token);
  if (!rec) return false;
  // Always consume on any match attempt, so a token cannot be probed
  // against subject after subject.
  tokens.delete(token);
  if (rec.expiresAt <= now) return false;
  return constantTimeEquals(rec.subjectId, subjectId);
}

/** Test/diagnostic only: how many tokens are currently outstanding. */
export function outstandingRenderTokens(): number {
  sweep(Date.now());
  return tokens.size;
}
