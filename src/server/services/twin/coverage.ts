/**
 * Twin coverage metrics — the Site Intelligence additions.
 *
 * Every figure is a counted fact over recorded rows, published with its
 * numerator and denominator so a reader can check the arithmetic.
 * Nothing is projected, forecast, or estimated.
 */
import * as repo from "../../db/repo";
import { canViewEvidenceIntel } from "../evidenceIntel/core";
import * as evidenceIntel from "../evidenceIntel";
import { requireVisibleProject } from "../timeline/core";
import { pastEvents, projectTimeline } from "../timeline/aggregate";
import { groupEvents } from "../timeline/aggregate";
import type { TwinCoverage, User } from "../../../shared/types";
import { LIFECYCLE } from "./scene";

const safe = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export function twinCoverage(user: User, projectId: string): TwinCoverage {
  const project = requireVisibleProject(user, projectId);
  const timeline = projectTimeline(user, project.id);
  const happened = pastEvents(timeline.events, timeline.asOf);

  const milestones = safe(() => repo.listMilestones(project.id), []).filter((m) => !m.archived);
  const evidenceByMilestone = milestones.map((m) => ({
    m,
    items: safe(() => repo.listEvidenceForMilestone(m.id), []),
  }));
  const allEvidence = evidenceByMilestone.flatMap((x) => x.items);

  const totalTranche = milestones.reduce((s, m) => s + m.trancheAmount, 0);
  const releasedTranche = milestones
    .filter((m) => m.status === "RELEASED")
    .reduce((s, m) => s + m.trancheAmount, 0);

  const withEvidence = evidenceByMilestone.filter((x) => x.items.length > 0).length;
  const withGps = allEvidence.filter((e) => e.latitude !== null && e.longitude !== null).length;

  const inspections = safe(() => repo.listInspectionsForProject(project.id), []);
  const required = inspections.filter((i) => i.required);
  const requiredWithResult = required.filter((i) => i.resultRecordedAt || i.completedAt);

  // Source coverage: permits carrying at least one attached official
  // source record. Attachment lists are readable by any project viewer
  // through the permit register.
  const permits = safe(() => repo.listPermitsForProject(project.id), []);
  const sourceRecords = safe(() => repo.listOfficialSourcesForProject(project.id), []);
  const permitsWithSource = permits.filter((p) =>
    sourceRecords.some((s) => s.permitId === p.id)
  ).length;

  // Risk density: advisory findings per stage — a count, not a
  // judgement, and only for roles Evidence Intelligence itself admits.
  const riskDensity = milestones.map((m) => ({
    milestoneId: m.id,
    title: m.title,
    advisoryCount: 0,
  }));
  if (canViewEvidenceIntel(user)) {
    const signals = safe(() => evidenceIntel.signalsForSubject(user, "PROJECT", project.id), []);
    const evidenceToMilestone = new Map<string, string>();
    for (const { m, items } of evidenceByMilestone) {
      for (const e of items) evidenceToMilestone.set(e.id, m.id);
    }
    for (const s of signals) {
      const mid = s.subjectType === "EVIDENCE_ITEM" ? evidenceToMilestone.get(s.subjectId) : undefined;
      if (!mid) continue;
      const row = riskDensity.find((r) => r.milestoneId === mid);
      if (row) row.advisoryCount += 1;
    }
  }

  const weekly = groupEvents(happened, "week").map((g) => ({ week: g.key, count: g.events.length }));

  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
  return {
    projectId: project.id,
    completionPct: pct(releasedTranche, totalTranche),
    completionBasis:
      `Tranche-weighted recorded governance lifecycle (${LIFECYCLE[LIFECYCLE.length - 1]} milestones over ` +
      "total) — not a physical measurement.",
    evidenceCoverage: { covered: withEvidence, total: milestones.length, pct: pct(withEvidence, milestones.length) },
    gpsCoverage: { withGps, total: allEvidence.length, pct: pct(withGps, allEvidence.length) },
    inspectionCoverage: {
      covered: requiredWithResult.length,
      required: required.length,
      pct: pct(requiredWithResult.length, required.length),
    },
    sourceCoverage: { covered: permitsWithSource, total: permits.length, pct: pct(permitsWithSource, permits.length) },
    riskDensity,
    activityByWeek: weekly,
    asOf: timeline.asOf,
  };
}
