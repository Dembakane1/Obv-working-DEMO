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

  const geofence = geofenceService.check(
    input.latitude,
    input.longitude,
    input.project.siteBoundary,
    input.project.name
  );

  const metadata = metadataService.check({
    capturedAt: input.capturedAt,
    uploadedAt: input.uploadedAt,
    deviceMetadata: input.deviceMetadata,
  });

  const aggregated = verificationAggregator.aggregate({
    visual: visual.assessment,
    geofence,
    metadata,
    source: visual.source,
  });

  return { ...aggregated, fallbackNote: visual.note };
}
