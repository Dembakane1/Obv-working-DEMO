/**
 * Future AI engines — provider-neutral READINESS interfaces only.
 *
 * Perceptual image hashing, computer vision, drone imagery, satellite
 * imagery, photogrammetry, volumetric analysis, and LiDAR each have a
 * stable capability shape here and NOTHING else. No algorithm pretends to
 * perform any of these tasks: `engineEnabled()` is hard false, the
 * analysis entry points throw a non-disclosing 404, and the readiness
 * registry has no write path (government-foundation pattern). When a real
 * engine ships it plugs into these shapes without redesigning Evidence
 * Intelligence.
 */
import * as evidenceIntelRepo from "../../db/evidenceIntelRepo";
import type { EvidenceAiCapability } from "../../../shared/types";
import { EvidenceIntelError } from "./core";

export interface FutureAiEngineSpec {
  capability: EvidenceAiCapability;
  displayName: string;
  /** What this engine WILL do once implemented — documentation, not a claim. */
  purpose: string;
}

export const FUTURE_AI_CATALOG: FutureAiEngineSpec[] = [
  { capability: "PERCEPTUAL_HASH", displayName: "Perceptual Image Hashing", purpose: "Detect near-duplicate and visually altered photos beyond exact content hashing." },
  { capability: "COMPUTER_VISION", displayName: "Computer Vision", purpose: "Classify construction scenes, detect objects, and read progress from imagery." },
  { capability: "DRONE_IMAGERY", displayName: "Drone Imagery Analysis", purpose: "Analyze aerial capture flights over a site." },
  { capability: "SATELLITE_IMAGERY", displayName: "Satellite Imagery", purpose: "Corroborate site change against dated satellite passes." },
  { capability: "PHOTOGRAMMETRY", displayName: "Photogrammetry", purpose: "Reconstruct 3D structure from overlapping photographs." },
  { capability: "VOLUMETRIC_ANALYSIS", displayName: "Volumetric Analysis", purpose: "Estimate excavated / placed material volumes." },
  { capability: "LIDAR", displayName: "LiDAR", purpose: "Analyze laser-scan point clouds of a structure." },
];

/** Hard false — enabling a future engine is a code change, not a flag. */
export function engineEnabled(_capability: EvidenceAiCapability): boolean {
  return false;
}

/** The analysis entry point every future engine will expose. Today it
 *  refuses with a non-disclosing 404 — no engine can be activated. */
export function runFutureEngine(_capability: EvidenceAiCapability, _subjectId: string): never {
  throw new EvidenceIntelError("Not found", 404);
}

export function futureAiReadiness(): {
  enabled: false;
  catalog: FutureAiEngineSpec[];
  configuredEngines: number;
  note: string;
} {
  return {
    enabled: false,
    catalog: FUTURE_AI_CATALOG,
    // Always 0 today (no write path); reported honestly rather than hardcoded.
    configuredEngines: evidenceIntelRepo.listAiEngines().length,
    note:
      "Perceptual hashing, computer vision, drone/satellite imagery, photogrammetry, volumetric analysis, and LiDAR " +
      "are architectural readiness only. No such engine is implemented or can be activated, and nothing fabricates their output.",
  };
}
