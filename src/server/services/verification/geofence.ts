/**
 * GeofenceVerificationService — deterministic geometric logic only.
 * The AI model is never consulted about geofence inclusion.
 */
import { pointInPolygon } from "../geo";
import { VERIFICATION_POLICY } from "./config";
import type { GeoPolygon } from "../../../shared/types";

export type CheckStatus = "PASS" | "REVIEW" | "FAIL";

export interface StructuredCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export const GEOFENCE_CHECK_NAME = "GPS inside project geofence";

export class GeofenceVerificationService {
  check(
    latitude: number | null | undefined,
    longitude: number | null | undefined,
    boundary: GeoPolygon | null | undefined,
    projectName: string
  ): StructuredCheck {
    const name = GEOFENCE_CHECK_NAME;

    if (!boundary || boundary.length < 4) {
      return {
        name,
        status: "REVIEW",
        detail: "No site boundary is configured for this project; location cannot be confirmed.",
      };
    }
    const lat = typeof latitude === "number" && Number.isFinite(latitude) ? latitude : null;
    const lng = typeof longitude === "number" && Number.isFinite(longitude) ? longitude : null;
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      // Missing GPS is never silently passed.
      return {
        name,
        status: "REVIEW",
        detail: "GPS coordinates are missing or malformed; location could not be verified.",
      };
    }
    if (pointInPolygon(lng, lat, boundary)) {
      return {
        name,
        status: "PASS",
        detail: `Coordinates (${lat.toFixed(5)}, ${lng.toFixed(5)}) are inside the ${projectName} site boundary.`,
      };
    }
    // Outside the polygon: indeterminate if within the margin of the
    // boundary bounding box, clearly outside beyond it.
    const margin = VERIFICATION_POLICY.GEOFENCE_REVIEW_MARGIN_DEG;
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [x, y] of boundary) {
      minLng = Math.min(minLng, x); maxLng = Math.max(maxLng, x);
      minLat = Math.min(minLat, y); maxLat = Math.max(maxLat, y);
    }
    const nearBoundary =
      lng >= minLng - margin && lng <= maxLng + margin &&
      lat >= minLat - margin && lat <= maxLat + margin;
    if (nearBoundary) {
      return {
        name,
        status: "REVIEW",
        detail: `Coordinates (${lat.toFixed(5)}, ${lng.toFixed(5)}) fall just outside the registered boundary (within the review margin).`,
      };
    }
    return {
      name,
      status: "FAIL",
      detail: `Coordinates (${lat.toFixed(5)}, ${lng.toFixed(5)}) are clearly outside the registered site boundary.`,
    };
  }
}

export const geofenceService = new GeofenceVerificationService();
