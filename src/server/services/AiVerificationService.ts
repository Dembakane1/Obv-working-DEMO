/**
 * AiVerificationService — evaluates submitted evidence against the
 * milestone requirement, the project geofence, and metadata integrity.
 *
 * TODO: real implementation using server-side multimodal model
 *       (e.g. Claude vision via the Anthropic API, or Azure OpenAI GPT-4o),
 *       called from an Azure Function with the photo fetched from Blob
 *       Storage. The interface below must not change when that lands.
 */
import type {
  EvidenceItem,
  Milestone,
  Project,
  Verdict,
  VerificationCheck,
} from "../../shared/types";
import { pointInPolygon } from "./geo";

export interface VerificationResult {
  verdict: Verdict;
  confidence: number; // 0..1
  checks: VerificationCheck[];
  reasoning: string;
}

export interface AiVerificationInput {
  evidence: EvidenceItem;
  milestone: Milestone;
  project: Project;
  /** Raw photo bytes, when available, for content checks. */
  photoBytes?: Buffer;
}

export interface AiVerificationService {
  verify(input: AiVerificationInput): Promise<VerificationResult>;
}

/**
 * Mocked implementation. Deterministic for a given evidence item (results
 * are derived from the evidence hash, never from randomness) so seeded demo
 * evidence always verifies the same way and the demo is reliable.
 *
 * Check B (geofence) and check C (timestamp/metadata integrity) are real
 * computations; only check A (photo content) is simulated.
 */
export class MockAiVerificationService implements AiVerificationService {
  async verify(input: AiVerificationInput): Promise<VerificationResult> {
    const { evidence, milestone, project } = input;
    const checks: VerificationCheck[] = [];

    // --- Check A: photo matches milestone requirement (simulated) ---
    // A real model would compare photo content against the requirement
    // text. The mock accepts any non-empty photo and reports what the
    // "model" saw, phrased against the milestone requirement.
    const hasPhoto = evidence.photoPath.length > 0 &&
      (input.photoBytes ? input.photoBytes.length > 256 : true);
    checks.push({
      name: "Photo matches milestone requirement",
      passed: hasPhoto,
      detail: hasPhoto
        ? `Image content is consistent with the requirement: "${truncate(milestone.requirement, 90)}"` +
          (evidence.isDemoFallback ? " (demo fallback image, simulated match)" : "")
        : "No usable image content was found in the submission.",
    });

    // --- Check B: GPS inside the project geofence (real computation) ---
    const insideFence = pointInPolygon(
      evidence.longitude,
      evidence.latitude,
      project.siteBoundary
    );
    checks.push({
      name: "GPS inside project geofence",
      passed: insideFence,
      detail: insideFence
        ? `Coordinates (${evidence.latitude.toFixed(5)}, ${evidence.longitude.toFixed(5)}) are inside the ${project.name} site boundary.`
        : `Coordinates (${evidence.latitude.toFixed(5)}, ${evidence.longitude.toFixed(5)}) fall outside the registered site boundary.`,
    });

    // --- Check C: timestamp & metadata integrity (real computation) ---
    const captured = Date.parse(evidence.capturedAt);
    const uploaded = Date.parse(evidence.uploadedAt);
    const skewMs = uploaded - captured;
    const timestampsSane =
      Number.isFinite(captured) &&
      Number.isFinite(uploaded) &&
      skewMs >= -5 * 60_000 && // allow small clock skew
      skewMs <= 7 * 24 * 3_600_000; // uploaded within 7 days of capture
    const hasDeviceMeta = Boolean(evidence.deviceMetadata?.userAgent);
    const integrityOk = timestampsSane && hasDeviceMeta;
    checks.push({
      name: "Timestamp & metadata integrity",
      passed: integrityOk,
      detail: integrityOk
        ? `Captured ${evidence.capturedAt}, uploaded ${evidence.uploadedAt}; device metadata present and consistent.`
        : "Capture/upload timestamps or device metadata are inconsistent.",
    });

    // --- Verdict & deterministic confidence ---
    const failed = checks.filter((c) => !c.passed);
    let verdict: Verdict;
    if (!hasPhoto) {
      verdict = "REJECTED";
    } else if (failed.length === 0) {
      verdict = "VERIFIED";
    } else {
      verdict = "NEEDS_REVIEW";
    }

    // Deterministic confidence seeded from the evidence hash: same
    // evidence -> same score, always in a realistic band.
    const seed = parseInt(evidence.hash.slice(0, 8), 16) / 0xffffffff;
    let confidence: number;
    if (verdict === "VERIFIED") {
      confidence = round2(0.9 + seed * 0.08); // 0.90–0.98
    } else if (verdict === "NEEDS_REVIEW") {
      confidence = round2(0.45 + seed * 0.2); // 0.45–0.65
    } else {
      confidence = round2(0.05 + seed * 0.15);
    }

    const reasoning =
      verdict === "VERIFIED"
        ? `All three checks passed. The submitted photo is consistent with "${truncate(milestone.title, 60)}", was taken inside the project geofence, and carries coherent capture metadata.`
        : verdict === "NEEDS_REVIEW"
          ? `Flagged for human review: ${failed.map((c) => c.name.toLowerCase()).join("; ")} did not pass automated checks.`
          : "Rejected: the submission does not contain usable photographic evidence.";

    return { verdict, confidence, checks, reasoning };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export const aiVerificationService: AiVerificationService = new MockAiVerificationService();
