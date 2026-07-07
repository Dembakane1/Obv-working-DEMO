/**
 * AiVisualVerificationService — evaluates ONLY whether the submitted image
 * is visually consistent with the milestone requirement.
 *
 * The model never sees or decides: GPS validity, timestamp ordering,
 * financial eligibility, approval requirements, or the final OBV verdict.
 * Those are deterministic application concerns (geofence.ts, metadata.ts,
 * aggregator.ts) and human governance.
 */
import { createHash } from "node:crypto";
import { AI_PROVIDER } from "./config";
import type { Milestone, Project } from "../../../shared/types";

export interface VisualAssessment {
  passed: boolean;
  confidence: number; // 0..1
  detail: string;
  reasoning: string;
}

export type VerificationSource = "LIVE_AI" | "MOCK_FALLBACK" | "MOCK_DEFAULT";

export interface VisualInput {
  milestone: Milestone;
  project: Project;
  /** Raw photo bytes when available (uploaded captures). */
  photoBytes?: Buffer;
  /** image/jpeg | image/png | image/webp — required for the live path. */
  photoMediaType?: string;
  /** Served path (used by the deterministic mock and for hash seeding). */
  photoPath: string;
  /** Stable seed so mock results are deterministic per evidence item. */
  seedHash: string;
  isDemoFallback: boolean;
}

export interface AiVisualVerificationService {
  assess(input: VisualInput): Promise<VisualAssessment>;
}

// ------------------------------------------------------------------ mock

/**
 * Deterministic mock — same behavior the demo has always had: results are
 * derived from the evidence hash (never randomness), so seeded evidence
 * and repeated demos verify identically.
 */
export class MockAiVisualVerificationService implements AiVisualVerificationService {
  async assess(input: VisualInput): Promise<VisualAssessment> {
    const hasPhoto =
      input.photoPath.length > 0 &&
      (input.photoBytes ? input.photoBytes.length > 256 : true);
    const seed = parseInt(input.seedHash.slice(0, 8), 16) / 0xffffffff;
    if (!hasPhoto) {
      return {
        passed: false,
        confidence: round2(0.75 + seed * 0.2),
        detail: "No usable image content was found in the submission.",
        reasoning: "The submission does not contain usable photographic evidence.",
      };
    }
    return {
      passed: true,
      confidence: round2(0.9 + seed * 0.08), // 0.90–0.98
      detail:
        `Image content is consistent with the requirement: "${truncate(input.milestone.requirement, 90)}"` +
        (input.isDemoFallback ? " (demo fallback image, simulated match)" : ""),
      reasoning: `The image is consistent with "${truncate(input.milestone.title, 60)}" based on the deterministic demo assessment.`,
    };
  }
}

// ------------------------------------------------------------------ live

const LIVE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const SYSTEM_INSTRUCTION =
  "You are a visual evidence analyst for infrastructure milestone verification. " +
  "Assess ONLY whether the image is visually consistent with the stated milestone requirement. " +
  "Do not assess GPS validity, timestamp validity, financial eligibility, or human approval — " +
  "those are handled elsewhere and are not your task. " +
  'Respond with ONLY a JSON object, no markdown fences, exactly: ' +
  '{"passed": boolean, "confidence": number 0..1, "detail": "<= 200 chars, what is visible and how it relates to the requirement", ' +
  '"reasoning": "<= 300 chars, brief justification"}';

export class LiveVisualError extends Error {
  constructor(message: string, public transient: boolean) {
    super(message);
  }
}

/**
 * Live multimodal assessment via the Anthropic Messages API.
 * Provider is replaceable: endpoint/model come from config, the app only
 * depends on the AiVisualVerificationService interface, and the response
 * is treated as untrusted input (strict schema validation below).
 *
 * Security: called server-side only; the key is read from the environment
 * at call time and never logged; image payloads are never logged.
 */
export class LiveAiVisualVerificationService implements AiVisualVerificationService {
  async assess(input: VisualInput): Promise<VisualAssessment> {
    if (!input.photoBytes || !input.photoMediaType || !LIVE_MEDIA_TYPES.has(input.photoMediaType)) {
      throw new LiveVisualError("image format not supported for live analysis", false);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_PROVIDER.timeoutMs());
    let res: Response;
    try {
      res = await fetch(`${AI_PROVIDER.baseUrl()}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": AI_PROVIDER.apiKey(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: AI_PROVIDER.model(),
          max_tokens: 400,
          system: SYSTEM_INSTRUCTION,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: input.photoMediaType,
                    data: input.photoBytes.toString("base64"),
                  },
                },
                {
                  type: "text",
                  text:
                    `Milestone: ${input.milestone.title}\n` +
                    `Requirement: ${input.milestone.requirement}\n` +
                    `Project context: ${input.project.name}, ${input.project.location}.\n\n` +
                    "Assess whether this image is visually consistent with the milestone requirement. " +
                    "Do not assess GPS validity, timestamp validity, financial eligibility, or human approval.",
                },
              ],
            },
          ],
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = (err as Error).name === "AbortError";
      throw new LiveVisualError(aborted ? "provider timeout" : "provider unreachable", !aborted);
    }
    clearTimeout(timer);

    if (!res.ok) {
      // Sanitized: status class only — never provider response bodies.
      throw new LiveVisualError(`provider error (HTTP ${res.status})`, res.status >= 500);
    }
    let text: string;
    try {
      const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
      text = (body.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
    } catch {
      throw new LiveVisualError("unreadable provider response", false);
    }
    return parseVisualAssessment(text);
  }
}

/**
 * Strict, defensive parsing of untrusted model output. Tolerates markdown
 * fences and surrounding prose; rejects anything that does not validate.
 */
export function parseVisualAssessment(raw: string): VisualAssessment {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new LiveVisualError("empty model response", false);
  }
  if (raw.length > AI_PROVIDER.maxResponseChars) {
    throw new LiveVisualError("model response too long", false);
  }
  // Strip markdown fences, then take the first {...} block.
  const cleaned = raw.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new LiveVisualError("no JSON object in model response", false);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new LiveVisualError("malformed JSON in model response", false);
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.passed !== "boolean") throw new LiveVisualError("invalid 'passed' field", false);
  const confidence = typeof o.confidence === "number" ? o.confidence : NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new LiveVisualError("invalid 'confidence' field", false);
  }
  if (typeof o.detail !== "string" || o.detail.length === 0) {
    throw new LiveVisualError("invalid 'detail' field", false);
  }
  if (typeof o.reasoning !== "string" || o.reasoning.length === 0) {
    throw new LiveVisualError("invalid 'reasoning' field", false);
  }
  return {
    passed: o.passed,
    confidence: round2(confidence),
    detail: truncate(o.detail.trim(), 240),
    reasoning: truncate(o.reasoning.trim(), 340),
  };
}

// -------------------------------------------------------------- resilient

export interface ResilientVisualResult {
  assessment: VisualAssessment;
  source: VerificationSource;
  /** Sanitized operational note (e.g. fallback reason). Never secrets. */
  note: string | null;
}

/**
 * ResilientAiVerificationService — live first, deterministic mock always
 * available. The hero loop can never break on provider behavior:
 *   1. no key configured            -> mock (MOCK_DEFAULT)
 *   2. live attempt with timeout    -> LIVE_AI on success
 *   3. transient failure            -> one retry
 *   4. any error / malformed output -> mock (MOCK_FALLBACK)
 */
export class ResilientAiVerificationService {
  constructor(
    private live: AiVisualVerificationService = new LiveAiVisualVerificationService(),
    private mock: AiVisualVerificationService = new MockAiVisualVerificationService()
  ) {}

  async assess(input: VisualInput, opts?: { forceMock?: boolean }): Promise<ResilientVisualResult> {
    if (opts?.forceMock || !AI_PROVIDER.apiKey()) {
      return { assessment: await this.mock.assess(input), source: "MOCK_DEFAULT", note: null };
    }
    let lastReason = "unknown";
    const attempts = 1 + AI_PROVIDER.maxTransientRetries;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const assessment = await this.live.assess(input);
        return { assessment, source: "LIVE_AI", note: null };
      } catch (err) {
        const e = err as LiveVisualError;
        lastReason = e.message || "provider failure";
        console.log(`[verification] live visual attempt ${attempt} failed: ${lastReason}`);
        if (!(e instanceof LiveVisualError) || !e.transient) break; // retry only transient
      }
    }
    return {
      assessment: await this.mock.assess(input),
      source: "MOCK_FALLBACK",
      note: lastReason,
    };
  }
}

export const resilientVisualService = new ResilientAiVerificationService();

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Stable per-evidence seed used by the deterministic mock. */
export function visualSeed(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
