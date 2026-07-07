/**
 * Verification policy — every threshold used by the hybrid verification
 * pipeline lives here. Nothing in routes, components, or services may
 * hard-code a verdict threshold.
 *
 * Roles in the architecture:
 *   AI evaluates the physical image.       (visual.ts)
 *   Code evaluates objective system facts. (geofence.ts, metadata.ts)
 *   Humans authorize financial release.    (approval governance — untouched)
 */

export const VERIFICATION_POLICY = {
  /** Minimum aggregate confidence for a VERIFIED verdict. */
  VERIFIED_MIN_CONFIDENCE: 0.75,

  /** Each REVIEW-status deterministic check scales aggregate confidence. */
  REVIEW_CONFIDENCE_FACTOR: 0.7,

  /**
   * A failed visual assessment with at least this confidence is treated as
   * a strong visual mismatch (hard fail -> REJECTED). A lower-confidence
   * visual fail is ambiguity -> NEEDS_REVIEW.
   */
  VISUAL_HARD_FAIL_MIN_CONFIDENCE: 0.75,

  /**
   * Verdict when coordinates are clearly outside the authorized boundary.
   * "Clearly" means beyond GEOFENCE_REVIEW_MARGIN_DEG of the boundary
   * bounding box; points outside the polygon but within the margin are
   * treated as indeterminate (REVIEW).
   */
  GEOFENCE_OUTSIDE_VERDICT: "REJECTED" as "REJECTED" | "NEEDS_REVIEW",
  GEOFENCE_REVIEW_MARGIN_DEG: 0.01, // ~1.1 km

  /** Offline capture queue: uploads this late are still legitimate. */
  MAX_OFFLINE_UPLOAD_DELAY_DAYS: 7,
  /** Device-clock skew tolerated between capture and upload ordering. */
  CLOCK_SKEW_TOLERANCE_MS: 5 * 60_000,
  /** Captures further in the future than this are impossible metadata. */
  FUTURE_CAPTURE_TOLERANCE_MS: 10 * 60_000,
} as const;

/** Live AI provider configuration (server-side only; key never leaves env). */
export const AI_PROVIDER = {
  apiKey: () => process.env.ANTHROPIC_API_KEY ?? "",
  baseUrl: () => process.env.OBV_AI_BASE_URL ?? "https://api.anthropic.com",
  model: () => process.env.OBV_AI_MODEL ?? "claude-haiku-4-5-20251001",
  timeoutMs: () => {
    const n = Number(process.env.OBV_AI_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : 8000;
  },
  /** One retry, only for transient transport failures (network / 5xx). */
  maxTransientRetries: 1,
  /** Sanity cap on provider response size before parsing. */
  maxResponseChars: 8000,
} as const;
