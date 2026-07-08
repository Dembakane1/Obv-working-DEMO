/**
 * VerificationAggregator — the ONLY place an OBV verdict is computed.
 *
 * Inputs: AI visual result + deterministic geofence result + deterministic
 * metadata result + provenance. Output preserves the existing Verification
 * structure (verdict / confidence / checks / reasoning) plus source.
 *
 * This module never makes release decisions: a VERIFIED result still
 * creates the existing ApprovalRequest and remains subject to human
 * governance (orchestrator).
 */
import { VERIFICATION_POLICY } from "./config";
import type { VisualAssessment, VerificationSource } from "./visual";
import type { StructuredCheck } from "./geofence";
import type { Verdict, VerificationCheck } from "../../../shared/types";

export interface AggregatedVerification {
  verdict: Verdict;
  confidence: number;
  checks: VerificationCheck[];
  reasoning: string;
  source: VerificationSource;
}

const VISUAL_CHECK_NAME = "Photo matches milestone requirement";

export class VerificationAggregator {
  aggregate(input: {
    visual: VisualAssessment;
    geofence: StructuredCheck;
    metadata: StructuredCheck;
    source: VerificationSource;
    /** Bounded per-project minimum-confidence override (pilot policy).
     *  Hard-fail conditions (visual mismatch, metadata FAIL, clear
     *  geofence FAIL) reject regardless of this value. */
    verifiedMinConfidence?: number;
  }): AggregatedVerification {
    const P = VERIFICATION_POLICY;
    const { visual, geofence, metadata, source } = input;

    // Preserve the existing VerificationCheck shape consumed by the UI,
    // ledger payloads, report, and tests: { name, passed, detail }.
    const checks: VerificationCheck[] = [
      { name: VISUAL_CHECK_NAME, passed: visual.passed, detail: visual.detail },
      { name: geofence.name, passed: geofence.status === "PASS", detail: geofence.detail },
      { name: metadata.name, passed: metadata.status === "PASS", detail: metadata.detail },
    ];

    // ---- hard-fail conditions -> REJECTED ----
    const visualHardFail =
      !visual.passed && visual.confidence >= P.VISUAL_HARD_FAIL_MIN_CONFIDENCE;
    const geofenceHardFail =
      geofence.status === "FAIL" && P.GEOFENCE_OUTSIDE_VERDICT === "REJECTED";
    const metadataHardFail = metadata.status === "FAIL";

    // ---- aggregate confidence (deterministic damping for ambiguity) ----
    let confidence = visual.confidence;
    for (const c of [geofence, metadata]) {
      if (c.status === "REVIEW") confidence *= P.REVIEW_CONFIDENCE_FACTOR;
      if (c.status === "FAIL") confidence *= 0.4;
    }
    confidence = Math.round(Math.max(0.02, Math.min(1, confidence)) * 100) / 100;

    let verdict: Verdict;
    if (visualHardFail || geofenceHardFail || metadataHardFail) {
      verdict = "REJECTED";
    } else if (
      visual.passed &&
      geofence.status === "PASS" &&
      metadata.status === "PASS" &&
      confidence >= (input.verifiedMinConfidence ?? P.VERIFIED_MIN_CONFIDENCE)
    ) {
      verdict = "VERIFIED";
    } else {
      verdict = "NEEDS_REVIEW";
    }

    const failed = checks.filter((c) => !c.passed);
    const reasoning =
      verdict === "VERIFIED"
        ? `All three checks passed. ${visual.reasoning} Location and capture metadata were validated deterministically.`
        : verdict === "REJECTED"
          ? `Rejected: ${
              visualHardFail
                ? "the image is not visually consistent with the milestone requirement"
                : geofenceHardFail
                  ? "coordinates are clearly outside the authorized project boundary"
                  : "capture metadata is impossible or corrupted"
            }. ${failed.map((c) => c.detail).join(" ")}`.slice(0, 600)
          : `Flagged for human review: ${failed.length > 0 ? failed.map((c) => c.name.toLowerCase()).join("; ") : "aggregate confidence below threshold"}. Funds remain held pending review.`;

    return { verdict, confidence, checks, reasoning, source };
  }
}

export const verificationAggregator = new VerificationAggregator();
