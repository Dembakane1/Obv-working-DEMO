/**
 * MetadataIntegrityService — deterministic timestamp/device checks only.
 * Offline delayed sync is explicitly legitimate: a photo captured offline
 * and uploaded hours later must not automatically fail.
 */
import { VERIFICATION_POLICY } from "./config";
import type { DeviceMetadata } from "../../../shared/types";
import type { StructuredCheck } from "./geofence";

export const METADATA_CHECK_NAME = "Timestamp & metadata integrity";

export class MetadataIntegrityService {
  check(input: {
    capturedAt: string | null | undefined;
    uploadedAt: string | null | undefined;
    deviceMetadata: DeviceMetadata | null | undefined;
    /** "now" injectable for tests. */
    now?: number;
    /** Bounded per-project offline-window override (pilot policy). Hard
     *  rules — missing/malformed/future timestamps FAIL — are not
     *  configurable. */
    maxOfflineDelayDays?: number;
  }): StructuredCheck {
    const name = METADATA_CHECK_NAME;
    const now = input.now ?? Date.now();
    const P = VERIFICATION_POLICY;

    if (!input.capturedAt || !input.uploadedAt) {
      return { name, status: "FAIL", detail: "Capture or upload timestamp is missing from the submission." };
    }
    const captured = Date.parse(input.capturedAt);
    const uploaded = Date.parse(input.uploadedAt);
    if (!Number.isFinite(captured) || !Number.isFinite(uploaded)) {
      return { name, status: "FAIL", detail: "Capture or upload timestamp is malformed and cannot be parsed." };
    }
    if (captured - now > P.FUTURE_CAPTURE_TOLERANCE_MS) {
      return { name, status: "FAIL", detail: "Capture timestamp is implausibly in the future." };
    }
    if (captured - uploaded > P.CLOCK_SKEW_TOLERANCE_MS) {
      return { name, status: "FAIL", detail: "Capture timestamp is after the upload timestamp beyond clock-skew tolerance." };
    }
    const delayMs = uploaded - captured;
    const offlineWindowDays = input.maxOfflineDelayDays ?? P.MAX_OFFLINE_UPLOAD_DELAY_DAYS;
    if (delayMs > offlineWindowDays * 24 * 3_600_000) {
      return {
        name,
        status: "REVIEW",
        detail: `Upload occurred ${Math.round(delayMs / 86_400_000)} days after capture — beyond the ${offlineWindowDays}-day offline window; review recommended.`,
      };
    }
    if (!input.deviceMetadata?.userAgent) {
      return { name, status: "REVIEW", detail: "Required device metadata is missing from the submission." };
    }
    const delayNote =
      delayMs > 3_600_000
        ? ` Upload followed capture by ${Math.round(delayMs / 3_600_000)}h (offline queue — permitted).`
        : "";
    return {
      name,
      status: "PASS",
      detail: `Captured ${input.capturedAt}, uploaded ${input.uploadedAt}; device metadata present and consistent.${delayNote}`,
    };
  }
}

export const metadataService = new MetadataIntegrityService();
