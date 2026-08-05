/**
 * Digital Twin geometry — projection and measurement over REAL recorded
 * coordinates.
 *
 * The twin renders in a local frame: metres east/north of the site
 * origin, projected equirectangularly around the site's own latitude.
 * That keeps every drawn distance honest (a scale bar on the scene is a
 * real scale bar) without any GIS dependency. Nothing in this module
 * invents a coordinate: every function maps or measures values that came
 * from a stored record, and returns null when the record has none.
 */
import type { GeoPolygon, TwinPoint } from "../../../shared/types";

const EARTH_RADIUS_M = 6_371_000;
const DEG = Math.PI / 180;

export interface LocalFrame {
  originLat: number;
  originLng: number;
  /** Precomputed metres-per-degree at the origin latitude. */
  mPerDegLat: number;
  mPerDegLng: number;
}

/** Centroid of a [lng, lat] ring (area-weighted; falls back to the
 *  vertex mean for degenerate rings). Null for an empty ring. */
export function ringCentroid(ring: GeoPolygon): { lat: number; lng: number } | null {
  if (!ring || ring.length === 0) return null;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(area) < 1e-12) {
    // Vertex mean over DISTINCT vertices: GeoJSON-style rings repeat the
    // first vertex last, and counting it twice would bias the fallback
    // centroid toward that vertex.
    const closed =
      ring.length > 1 &&
      ring[0][0] === ring[ring.length - 1][0] &&
      ring[0][1] === ring[ring.length - 1][1];
    const verts = closed ? ring.slice(0, -1) : ring;
    const mx = verts.reduce((s, [x]) => s + x, 0) / verts.length;
    const my = verts.reduce((s, [, y]) => s + y, 0) / verts.length;
    return { lat: my, lng: mx };
  }
  area *= 0.5;
  return { lng: cx / (6 * area), lat: cy / (6 * area) };
}

/** Build the local frame around an origin (usually the site centroid). */
export function makeFrame(originLat: number, originLng: number): LocalFrame {
  return {
    originLat,
    originLng,
    mPerDegLat: (Math.PI * EARTH_RADIUS_M) / 180,
    mPerDegLng: ((Math.PI * EARTH_RADIUS_M) / 180) * Math.cos(originLat * DEG),
  };
}

/** Project one recorded [lng, lat] into local metres east/north. */
export function toLocal(frame: LocalFrame, lng: number, lat: number): TwinPoint {
  return {
    x: (lng - frame.originLng) * frame.mPerDegLng,
    y: (lat - frame.originLat) * frame.mPerDegLat,
  };
}

/** Project a recorded ring/polyline. Empty input stays empty. */
export function projectRing(frame: LocalFrame, ring: GeoPolygon): TwinPoint[] {
  return (ring ?? []).map(([lng, lat]) => toLocal(frame, lng, lat));
}

/** Great-circle distance in metres between two recorded fixes. */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLng = (lng2 - lng1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Distance from a local point to the nearest point of a local
 *  polyline. Null when the polyline is empty. */
export function distanceToPolylineM(p: TwinPoint, line: TwinPoint[]): number | null {
  if (!line || line.length === 0) return null;
  if (line.length === 1) return Math.hypot(p.x - line[0].x, p.y - line[0].y);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
    const dx = p.x - (a.x + t * abx);
    const dy = p.y - (a.y + t * aby);
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best;
}

/** Ray-cast point-in-polygon over local points. Null for a degenerate
 *  boundary (fewer than 3 vertices) — unknown, not assumed. */
export function insidePolygon(p: TwinPoint, ring: TwinPoint[]): boolean | null {
  if (!ring || ring.length < 3) return null;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Bounding box of a set of local points (with a padding margin). */
export function boundsOf(
  points: TwinPoint[],
  padM = 20
): { minX: number; minY: number; maxX: number; maxY: number; widthM: number; heightM: number } {
  if (!points || points.length === 0) {
    return { minX: -padM, minY: -padM, maxX: padM, maxY: padM, widthM: padM * 2, heightM: padM * 2 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  minX -= padM;
  minY -= padM;
  maxX += padM;
  maxY += padM;
  return { minX, minY, maxX, maxY, widthM: maxX - minX, heightM: maxY - minY };
}
