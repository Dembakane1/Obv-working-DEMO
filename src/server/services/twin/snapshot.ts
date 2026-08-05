/**
 * Miniature twins for the portfolio band: recorded boundary + recorded
 * stage geometry + governance-lifecycle completion, per project the
 * caller can already see. Bounded and reported, like the portfolio
 * timeline itself.
 */
import * as repo from "../../db/repo";
import * as authz from "../authz";
import { assertTimelineViewer } from "../timeline/core";
import type { TwinSnapshot, User } from "../../../shared/types";
import { makeFrame, projectRing, ringCentroid, boundsOf } from "./geometry";

export const SNAPSHOT_CAP = 8;

const safe = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export function twinSnapshots(user: User): { snapshots: TwinSnapshot[]; available: number; note: string | null } {
  assertTimelineViewer(user);
  const projects = authz
    .accessibleProjects(user)
    .filter((p) => p.status !== "DRAFT")
    .sort((a, b) => b.totalBudget - a.totalBudget);
  const chosen = projects.slice(0, SNAPSHOT_CAP);
  const snapshots = chosen.map((project) => {
    const centroid = ringCentroid(project.siteBoundary);
    const frame = centroid ? makeFrame(centroid.lat, centroid.lng) : null;
    const boundary = frame ? projectRing(frame, project.siteBoundary) : [];
    const milestones = safe(() => repo.listMilestones(project.id), []).filter((m) => !m.archived);
    const features = frame ? safe(() => repo.listSpatialFeatures(project.id), []) : [];
    const stages = milestones
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((m) => {
        const seg = features.find((f) => f.kind === "SEGMENT" && f.milestoneId === m.id);
        return {
          seq: m.seq,
          status: m.status,
          points: seg && frame ? projectRing(frame, seg.geometry) : [],
        };
      });
    const totalTranche = milestones.reduce((s, m) => s + m.trancheAmount, 0);
    const releasedTranche = milestones
      .filter((m) => m.status === "RELEASED")
      .reduce((s, m) => s + m.trancheAmount, 0);
    let pinCount = 0;
    for (const m of milestones) {
      pinCount += safe(() => repo.listEvidenceForMilestone(m.id), []).filter(
        (e) => e.latitude !== null && e.longitude !== null
      ).length;
    }
    const bb = boundsOf([...boundary, ...stages.flatMap((s) => s.points)]);
    return {
      projectId: project.id,
      projectName: project.name,
      status: project.status,
      boundary,
      frame: {
        originLat: frame?.originLat ?? 0,
        originLng: frame?.originLng ?? 0,
        widthM: Math.round(bb.widthM),
        heightM: Math.round(bb.heightM),
        degraded: !frame,
      },
      stages,
      completionPct: totalTranche > 0 ? Math.round((releasedTranche / totalTranche) * 100) : 0,
      evidencePinCount: pinCount,
    };
  });
  return {
    snapshots,
    available: projects.length,
    note:
      projects.length > chosen.length
        ? `Showing the ${chosen.length} largest of ${projects.length} accessible projects.`
        : null,
  };
}
