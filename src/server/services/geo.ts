import type { GeoPolygon } from "../../shared/types";

/**
 * Ray-casting point-in-polygon test. Points are [lng, lat] pairs.
 * Good enough for demo-scale geofences; production would use PostGIS.
 */
export function pointInPolygon(lng: number, lat: number, polygon: GeoPolygon): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Centroid of a polygon ring — used for simulated GPS in demo fallback. */
export function polygonCentroid(polygon: GeoPolygon): { lng: number; lat: number } {
  let lng = 0;
  let lat = 0;
  for (const [x, y] of polygon) {
    lng += x;
    lat += y;
  }
  return { lng: lng / polygon.length, lat: lat / polygon.length };
}
