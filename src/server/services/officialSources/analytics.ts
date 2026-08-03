/**
 * Official-source analytics extending Portfolio Intelligence. Derived
 * on read, viewer-gated, tenant-scoped, and advisory: none of these
 * figures is a control decision, a compliance certification, or a
 * statement about any contractor's integrity.
 */
import * as repo from "../../db/repo";
import * as osRepo from "../../db/officialSourcesRepo";
import * as authz from "../authz";
import type { User } from "../../../shared/types";
import { SOURCE_DOCTRINE_NOTICE, ageLabel, assertSourceViewer } from "./core";

export interface OfficialSourceAnalytics {
  doctrineNotice: string;
  /** Permit official-record coverage across accessible projects. */
  coverage: { permits: number; permitsWithOfficialRecord: number; coveragePct: number };
  /** Freshness: age of the newest successful snapshot per source. */
  sourceFreshness: Array<{ sourceId: string; name: string; category: string; health: string; lastSuccessAt: string | null; age: string }>;
  /** Open enforcement-type review items. */
  enforcementAlerts: number;
  /** License problems surfaced and not yet resolved. */
  licenseAlerts: number;
  /** Projects with at least one unresolved conflict/ambiguity item. */
  projectsWithUnresolvedConflicts: Array<{ projectId: string; projectName: string; open: number }>;
  /** Review queue backlog by status. */
  reviewBacklog: Record<string, number>;
  /** Average hours from change detection to reviewer resolution. */
  averageResolutionHours: number | null;
  /** Connector health rollup by jurisdiction. */
  connectorHealth: Array<{ jurisdiction: string; healthy: number; manual: number; down: number; unknown: number }>;
}

export function officialSourceAnalytics(user: User): OfficialSourceAnalytics {
  assertSourceViewer(user);
  const projects = authz.accessibleProjects(user);
  const projectIds = projects.map((p) => p.id);

  // Coverage: permits carrying at least one attached official source record.
  let permits = 0;
  let covered = 0;
  for (const project of projects) {
    for (const permit of repo.listPermitsForProject(project.id)) {
      permits += 1;
      if (repo.listOfficialSourcesForPermit(permit.id).length > 0) covered += 1;
    }
  }

  const sources = osRepo.listSources();
  const sourceFreshness = sources.map((s) => ({
    sourceId: s.id,
    name: s.name,
    category: s.category,
    health: s.health,
    lastSuccessAt: s.lastSuccessAt,
    age: ageLabel(s.lastSuccessAt),
  }));

  const items = osRepo.listReviewForProjects(projectIds, { limit: 1000 });
  const open = items.filter((i) => i.status === "OPEN" || i.status === "DEFERRED" || i.status === "MANUAL_VERIFICATION");
  const enforcementAlerts = open.filter(
    (i) => i.eventKind === "STOP_WORK_DETECTED" || i.eventKind === "ENFORCEMENT_DETECTED" || i.eventKind === "FAILED_INSPECTION"
  ).length;
  const licenseAlerts = open.filter(
    (i) => i.eventKind === "LICENSE_EXPIRED" || i.eventKind === "LICENSE_SUSPENDED" || i.eventKind === "LICENSE_NOT_FOUND"
  ).length;

  const conflictByProject = new Map<string, number>();
  for (const i of open) {
    if ((i.eventKind === "SOURCE_CONFLICT" || i.eventKind === "AMBIGUOUS_MATCH") && i.projectId) {
      conflictByProject.set(i.projectId, (conflictByProject.get(i.projectId) ?? 0) + 1);
    }
  }
  const nameFor = new Map(projects.map((p) => [p.id, p.name]));
  const projectsWithUnresolvedConflicts = [...conflictByProject.entries()]
    .map(([projectId, count]) => ({ projectId, projectName: nameFor.get(projectId) ?? projectId, open: count }))
    .sort((a, b) => b.open - a.open);

  // Resolution latency: created -> resolved for resolved items.
  const resolved = items.filter((i) => i.resolvedAt);
  const hours = resolved
    .map((i) => (Date.parse(i.resolvedAt!) - Date.parse(i.createdAt)) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0);
  const averageResolutionHours = hours.length
    ? Math.round((hours.reduce((s, h) => s + h, 0) / hours.length) * 10) / 10
    : null;

  const byJurisdiction = new Map<string, { healthy: number; manual: number; down: number; unknown: number }>();
  for (const s of sources) {
    const agg = byJurisdiction.get(s.jurisdiction) ?? { healthy: 0, manual: 0, down: 0, unknown: 0 };
    if (s.health === "HEALTHY") agg.healthy += 1;
    else if (s.health === "MANUAL") agg.manual += 1;
    else if (s.health === "DOWN" || s.health === "DEGRADED") agg.down += 1;
    else agg.unknown += 1;
    byJurisdiction.set(s.jurisdiction, agg);
  }

  return {
    doctrineNotice: SOURCE_DOCTRINE_NOTICE,
    coverage: {
      permits,
      permitsWithOfficialRecord: covered,
      coveragePct: permits > 0 ? Math.round((covered / permits) * 100) : 0,
    },
    sourceFreshness,
    enforcementAlerts,
    licenseAlerts,
    projectsWithUnresolvedConflicts,
    reviewBacklog: osRepo.reviewStatsForProjects(projectIds),
    averageResolutionHours,
    connectorHealth: [...byJurisdiction.entries()].map(([jurisdiction, agg]) => ({ jurisdiction, ...agg })),
  };
}
