/**
 * Digital Twin facade — everything routes and pages may import.
 *
 * READ-ONLY BY CONSTRUCTION: no function reachable from this facade
 * writes anything. The twin visualizes records; the Timeline remains the
 * authoritative interface over them.
 */
export { TWIN_NOTICE, LIFECYCLE, PIN_CAP, lifecycleStep, twinScene } from "./scene";
export { twinPlayback, PLAYBACK_STEP_CAP } from "./playback";
export { twinPinDetail } from "./detail";
export { twinCoverage } from "./coverage";
export { twinSnapshots, SNAPSHOT_CAP } from "./snapshot";
export { TWIN_PROVIDER_SPECS, twinProviderReadiness } from "./providers";
