/**
 * Hybrid verification pipeline — single entry point used by the workflow
 * orchestrator (live submissions) and the seed script (forceMock).
 *
 *   PHYSICAL EVIDENCE
 *     -> AI VISUAL ASSESSMENT        (resilient: live -> mock fallback)
 *     -> DETERMINISTIC LOCATION CHECK
 *     -> DETERMINISTIC METADATA CHECK
 *     -> OBV VERDICT AGGREGATOR
 *
 * Everything downstream (ledger, approval request, HELD/RELEASED) stays in
 * the orchestrator and human governance — never here, never in the model.
 */
import * as repo from "../../db/repo";
import { resilientVisualService } from "./visual";
import { geofenceService } from "./geofence";
import { metadataService } from "./metadata";
import { verificationAggregator, AggregatedVerification } from "./aggregator";
import type { DeviceMetadata, Milestone, Project } from "../../../shared/types";

export interface PipelineInput {
  milestone: Milestone;
  project: Project;
  photoPath: string;
  photoBytes?: Buffer;
  photoMediaType?: string;
  latitude: number | null;
  longitude: number | null;
  capturedAt: string;
  uploadedAt: string;
  deviceMetadata: DeviceMetadata;
  /** Stable seed (evidence hash) for deterministic mock behavior. */
  seedHash: string;
  isDemoFallback: boolean;
  /** Seed script / tests: skip the live provider entirely. */
  forceMock?: boolean;
}

export interface PipelineResult extends AggregatedVerification {
  /** Sanitized fallback reason when the live path was attempted and failed. */
  fallbackNote: string | null;
}

export async function runVerificationPipeline(input: PipelineInput): Promise<PipelineResult> {
  const visual = await resilientVisualService.assess(
    {
      milestone: input.milestone,
      project: input.project,
      photoBytes: input.photoBytes,
      photoMediaType: input.photoMediaType,
      photoPath: input.photoPath,
      seedHash: input.seedHash,
      isDemoFallback: input.isDemoFallback,
    },
    { forceMock: input.forceMock }
  );

  const policy = resolveProjectPolicy(input.project.id);

  const geofence = geofenceService.check(
    input.latitude,
    input.longitude,
    input.project.siteBoundary,
    input.project.name,
    { marginDeg: policy.geofenceMarginDeg }
  );

  const metadata = metadataService.check({
    capturedAt: input.capturedAt,
    uploadedAt: input.uploadedAt,
    deviceMetadata: input.deviceMetadata,
    maxOfflineDelayDays: policy.maxOfflineDelayDays,
  });

  const aggregated = verificationAggregator.aggregate({
    visual: visual.assessment,
    geofence,
    metadata,
    source: visual.source,
    verifiedMinConfidence: policy.verifiedMinConfidence,
  });

  return { ...aggregated, fallbackNote: visual.note };
}

/**
 * CUSTOMER POLICY resolution — bounded per-project overrides configured
 * through pilot onboarding. Every value is clamped to OBV-validated
 * bounds at read time; with no configured policy the standing defaults
 * apply unchanged. OBV NON-OVERRIDABLE INTEGRITY RULES (missing GPS ->
 * REVIEW, malformed/future timestamps -> FAIL, strong visual mismatch ->
 * REJECTED, corrupted media rejected) are not expressed here and cannot
 * be configured away.
 */
export function resolveProjectPolicy(projectId: string): {
  verifiedMinConfidence: number | undefined;
  geofenceMarginDeg: number | undefined;
  maxOfflineDelayDays: number | undefined;
} {
  const config = repo.getVerificationPolicy(projectId);
  if (!config) {
    return { verifiedMinConfidence: undefined, geofenceMarginDeg: undefined, maxOfflineDelayDays: undefined };
  }
  const clamp = (v: number | null, min: number, max: number) =>
    v === null ? undefined : Math.min(max, Math.max(min, v));
  const geofenceMarginDeg =
    config.geofencePolicy === "STRICT" ? 0.003
    : config.geofencePolicy === "EXTENDED_REVIEW" ? 0.02
    : undefined; // STANDARD / unset -> default margin
  return {
    verifiedMinConfidence: clamp(config.aiConfidenceThreshold, 0.5, 0.95),
    geofenceMarginDeg,
    maxOfflineDelayDays: clamp(config.offlineAllowanceDays ?? config.recencyDays, 0, 14),
  };
}
