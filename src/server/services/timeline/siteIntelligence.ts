/**
 * Site Intelligence — one page that answers "where does this project
 * stand?" by composing what the governed subsystems already know.
 *
 * Every figure here is READ from an existing authoritative record or an
 * explicitly advisory service. This module computes no new truth: it
 * never scores a contractor's integrity, never decides eligibility, and
 * never writes anything. Where a subsystem is not configured for a
 * project, its panel degrades to "not configured" rather than guessing.
 */
import * as repo from "../../db/repo";
import * as evidenceIntelRepo from "../../db/evidenceIntelRepo";
import * as officialSourcesRepo from "../../db/officialSourcesRepo";
import * as disputeRepo from "../../db/disputeRepo";
import * as portfolio from "../portfolio";
import { scoreProject } from "../evidenceIntel/scoring";
import { effectiveStatus } from "../permits";
import type { Project, TimelineInsight, User } from "../../../shared/types";
import { pastEvents, projectTimeline } from "./aggregate";
import { requireVisibleProject } from "./core";
import { timelineInsights } from "./insights";

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export interface SitePanel {
  key: string;
  label: string;
  value: string;
  detail: string;
  tone: "ok" | "warn" | "bad" | "neutral";
  href: string | null;
}

export interface SiteIntelligence {
  project: Project;
  panels: SitePanel[];
  /** Advisory observations from the timeline (never decisions). */
  insights: TimelineInsight[];
  executiveSummary: string;
  totalEvents: number;
  lastActivityAt: string | null;
  asOf: string;
}

export function siteIntelligence(user: User, projectId: string): SiteIntelligence {
  const project = requireVisibleProject(user, projectId);
  const timeline = projectTimeline(user, project.id);
  const happened = pastEvents(timeline.events, timeline.asOf);
  const panels: SitePanel[] = [];

  // ---- schedule / milestones ----
  const milestones = safe(() => repo.listMilestones(project.id), []);
  const released = milestones.filter((m) => m.status === "RELEASED").length;
  const pct = milestones.length > 0 ? Math.round((released / milestones.length) * 100) : 0;
  panels.push({
    key: "schedule",
    label: "Schedule",
    value: `${released}/${milestones.length} milestones released`,
    detail: `${pct}% of milestones have reached release.`,
    tone: milestones.length === 0 ? "neutral" : pct >= 75 ? "ok" : pct >= 25 ? "warn" : "neutral",
    href: `/projects/${project.id}`,
  });

  // ---- budget (governed figures only) ----
  const budgetLines = safe(() => repo.listBudgetLines(project.id), []);
  panels.push({
    key: "budget",
    label: "Budget",
    value: `$${project.totalBudget.toLocaleString("en-US")}`,
    detail: `${budgetLines.length} budget line${budgetLines.length === 1 ? "" : "s"} recorded.`,
    tone: "neutral",
    href: `/projects/${project.id}`,
  });

  // ---- evidence quality (advisory, from Evidence Intelligence) ----
  const score = safe(() => scoreProject(project), null);
  panels.push({
    key: "evidence",
    label: "Evidence quality",
    value: score ? `${score.quality}/100` : "—",
    detail: score
      ? `Completeness ${score.completeness}, confidence ${score.confidence}. Advisory only.`
      : "Evidence scoring unavailable for this project.",
    tone: !score ? "neutral" : score.quality >= 75 ? "ok" : score.quality >= 50 ? "warn" : "bad",
    href: `/evidence-intelligence`,
  });

  // ---- permits ----
  const permits = safe(() => repo.listPermitsForProject(project.id), []);
  const permitStates = permits.map((p) => safe(() => effectiveStatus(p), p.status));
  const expired = permitStates.filter((s) => String(s) === "EXPIRED").length;
  panels.push({
    key: "permits",
    label: "Permit status",
    value: permits.length === 0 ? "None recorded" : `${permits.length} recorded`,
    detail: permits.length === 0
      ? "No permits are recorded for this project."
      : `${expired} expired by recorded date. OBV records permits; it never issues them.`,
    tone: permits.length === 0 ? "neutral" : expired > 0 ? "warn" : "ok",
    href: `/permits`,
  });

  // ---- inspections ----
  const inspections = safe(() => repo.listInspectionsForProject(project.id), []);
  const failedInspections = happened.filter((e) => e.type === "INSPECTION_RESULT" && e.severity === "HIGH").length;
  panels.push({
    key: "inspections",
    label: "Inspection status",
    value: inspections.length === 0 ? "None recorded" : `${inspections.length} recorded`,
    detail: failedInspections > 0
      ? `${failedInspections} recorded outcome${failedInspections === 1 ? "" : "s"} indicating failure or correction.`
      : "No failed or corrective outcomes recorded.",
    tone: inspections.length === 0 ? "neutral" : failedInspections > 0 ? "bad" : "ok",
    href: `/compliance`,
  });

  // ---- official sources ----
  const sourceItems = safe(() => officialSourcesRepo.listReviewForProjects([project.id], { limit: 500 }), []);
  const openSourceItems = sourceItems.filter((i) => i.status === "OPEN" || i.status === "DEFERRED").length;
  const attached = safe(() => repo.listOfficialSourcesForProject(project.id), []).length;
  panels.push({
    key: "official_sources",
    label: "Official source status",
    value: `${attached} attached`,
    detail: openSourceItems > 0
      ? `${openSourceItems} official-source item${openSourceItems === 1 ? "" : "s"} awaiting reviewer action.`
      : "No official-source items awaiting review.",
    tone: openSourceItems > 0 ? "warn" : attached > 0 ? "ok" : "neutral",
    href: `/official-sources/project/${project.id}`,
  });

  // ---- contractor (identity only — never a quality judgement) ----
  const contractorOrgId = project.pilot?.contractorOrgId ?? null;
  const contractorOrg = contractorOrgId ? safe(() => repo.getOrganization(contractorOrgId), null) : null;
  panels.push({
    key: "contractor",
    label: "Contractor",
    value: contractorOrg ? contractorOrg.name : "Not assigned",
    // The disclaimer is a statement about OBV, not about any particular
    // contractor, so it appears whether or not one is assigned.
    detail: contractorOrg
      ? "The contractor of record for this project. OBV records participation; it never rates integrity."
      : "No contractor organization is configured. OBV records participation; it never rates integrity.",
    tone: "neutral",
    href: `/executive/entities`,
  });

  // ---- exceptions ----
  const exceptions = safe(() => repo.listExceptionsForProject(project.id), []);
  const openExceptions = exceptions.filter(
    (x) => x.status !== "RESOLVED" && x.status !== "CLOSED" && x.status !== "WAIVED"
  );
  const criticalOpen = openExceptions.filter((x) => x.severity === "CRITICAL" || x.severity === "HIGH").length;
  panels.push({
    key: "exceptions",
    label: "Open exceptions",
    value: String(openExceptions.length),
    detail: criticalOpen > 0
      ? `${criticalOpen} at high or critical severity.`
      : openExceptions.length > 0 ? "None at high or critical severity." : "No open exceptions.",
    tone: criticalOpen > 0 ? "bad" : openExceptions.length > 0 ? "warn" : "ok",
    href: `/exceptions`,
  });

  // ---- disputes ----
  const disputes = safe(() => disputeRepo.listDisputesForProject(project.id), []);
  const openDisputes = disputes.filter((d) => d.status === "OPEN" || d.status === "UNDER_REVIEW").length;
  panels.push({
    key: "disputes",
    label: "Disputes",
    value: String(openDisputes),
    detail: openDisputes > 0
      ? `${openDisputes} open of ${disputes.length} recorded. Disputes can hold releases.`
      : `${disputes.length} recorded, none open.`,
    tone: openDisputes > 0 ? "warn" : "ok",
    href: `/disputes`,
  });

  // ---- draws + payment ----
  const draws = safe(() => repo.listDrawRequestsForProject(project.id), []);
  const submitted = draws.filter((d) => d.submittedAt).length;
  panels.push({
    key: "draws",
    label: "Draw status",
    value: `${draws.length} draw${draws.length === 1 ? "" : "s"}`,
    detail: `${submitted} submitted for lender review.`,
    tone: "neutral",
    href: `/draws`,
  });
  const paymentEvents = happened.filter((e) => e.category === "PAYMENT");
  const confirmed = paymentEvents.filter((e) => e.type === "PAYMENT_CONFIRMED").length;
  panels.push({
    key: "payment",
    label: "Payment status",
    value: `${confirmed} settled`,
    detail: `${paymentEvents.length} banking/payment event${paymentEvents.length === 1 ? "" : "s"} recorded.`,
    tone: "neutral",
    href: `/banking`,
  });

  // ---- risk + portfolio position (advisory, from Portfolio Intelligence) ----
  const risk = safe(() => portfolio.projectRisk(user, project.id), null);
  panels.push({
    key: "risk",
    label: "Risk level",
    value: risk ? String((risk as { band?: string }).band ?? "—") : "—",
    detail: risk
      ? "Advisory risk band from Portfolio Intelligence — a reading aid, never a decision."
      : "Risk profile unavailable for this project.",
    tone: !risk ? "neutral"
      : String((risk as { band?: string }).band) === "CRITICAL" ? "bad"
      : String((risk as { band?: string }).band) === "ELEVATED" ? "warn" : "ok",
    href: `/executive`,
  });
  panels.push({
    key: "portfolio",
    label: "Portfolio position",
    value: project.status,
    detail: `${project.projectType.replace(/_/g, " ").toLowerCase()} · ${project.location}`,
    tone: "neutral",
    href: `/executive`,
  });

  // ---- health: composed from the panels above, explained openly ----
  const badPanels = panels.filter((p) => p.tone === "bad").length;
  const warnPanels = panels.filter((p) => p.tone === "warn").length;
  const health = badPanels > 0 ? "Needs attention" : warnPanels > 1 ? "Watch" : "Steady";
  panels.unshift({
    key: "health",
    label: "Project health",
    value: health,
    detail:
      `Composed from the panels on this page: ${badPanels} needing attention, ${warnPanels} to watch. ` +
      "A reading aid — not a compliance certification and not a lending decision.",
    tone: badPanels > 0 ? "bad" : warnPanels > 1 ? "warn" : "ok",
    href: null,
  });

  // Reuse the timeline already computed above rather than rebuilding it.
  const insights = safe(() => timelineInsights(user, project.id, timeline).insights, []);
  const executiveSummary =
    `${project.name} is ${project.status.toLowerCase()} with ${released} of ${milestones.length} milestones ` +
    `released and ${openExceptions.length} open exception${openExceptions.length === 1 ? "" : "s"}. ` +
    `OBV holds ${timeline.totalEvents} recorded events` +
    `${timeline.lastEventAt ? `, most recently ${timeline.lastEventAt.slice(0, 10)}` : ""}` +
    `${insights.length > 0 ? `, and the timeline raised ${insights.length} advisory observation${insights.length === 1 ? "" : "s"}` : ""}.`;

  return {
    project,
    panels,
    insights,
    executiveSummary,
    totalEvents: timeline.totalEvents,
    lastActivityAt: happened.length > 0 ? happened[happened.length - 1].at : null,
    asOf: timeline.asOf,
  };
}

// ------------------------------------------------------- project map data

export interface MapLayerFeature {
  kind: string;
  id: string;
  label: string;
  detail: string;
  latitude: number | null;
  longitude: number | null;
  href: string | null;
}

export interface ProjectMapData {
  projectId: string;
  projectName: string;
  location: string;
  boundary: Project["siteBoundary"];
  /** Route/segment geometry already modeled by the spatial engine. */
  features: ReturnType<typeof repo.listSpatialFeatures>;
  layers: Record<string, MapLayerFeature[]>;
  /** Jurisdiction context recorded on permits (textual, not geometry). */
  jurisdictions: string[];
  asOf: string;
}

/** Map layers for one project, reusing the existing spatial engine's
 *  geometry and adding the record layers the timeline knows about.
 *  Only evidence with a real GPS fix contributes a point — a missing fix
 *  is never placed at a guessed location. */
export function projectMapData(user: User, projectId: string): ProjectMapData {
  const project = requireVisibleProject(user, projectId);
  const layers: Record<string, MapLayerFeature[]> = {
    evidence: [],
    permits: [],
    inspections: [],
    officialSources: [],
  };

  for (const m of safe(() => repo.listMilestones(project.id), [])) {
    for (const e of safe(() => repo.listEvidenceForMilestone(m.id), [])) {
      if (e.latitude === null || e.longitude === null) continue; // never guessed
      layers.evidence.push({
        kind: "EVIDENCE",
        id: e.id,
        label: m.title,
        detail: `Captured ${e.capturedAt.slice(0, 10)}`,
        latitude: e.latitude,
        longitude: e.longitude,
        href: `/evidence/${e.id}`,
      });
    }
  }

  // Permits and inspections have no coordinates of their own; they are
  // shown as project-anchored records rather than placed at invented
  // points. The centroid of the site boundary is the honest anchor.
  for (const p of safe(() => repo.listPermitsForProject(project.id), [])) {
    layers.permits.push({
      kind: "PERMIT",
      id: p.id,
      label: p.permitNumber,
      detail: `${p.permitType} · ${p.status}`,
      latitude: null,
      longitude: null,
      href: `/permits`,
    });
  }
  for (const i of safe(() => repo.listInspectionsForProject(project.id), [])) {
    layers.inspections.push({
      kind: "INSPECTION",
      id: i.id,
      label: i.inspectionType ?? "Inspection",
      detail: String(i.status),
      latitude: null,
      longitude: null,
      href: `/compliance`,
    });
  }
  for (const c of safe(() => officialSourcesRepo.listCandidatesForProjects([project.id], 100), [])) {
    layers.officialSources.push({
      kind: "OFFICIAL_SOURCE",
      id: c.id,
      label: c.externalId,
      detail: `${c.agency}${c.address ? ` · ${c.address}` : ""}`,
      latitude: null,
      longitude: null,
      href: `/official-sources/project/${project.id}`,
    });
  }

  const jurisdictions = [
    ...new Set(
      safe(() => repo.listPermitsForProject(project.id), [])
        .map((p) => p.jurisdiction)
        .filter((j): j is string => Boolean(j))
    ),
  ];

  return {
    projectId: project.id,
    projectName: project.name,
    location: project.location,
    boundary: project.siteBoundary,
    features: safe(() => repo.listSpatialFeatures(project.id), []),
    layers,
    jurisdictions,
    asOf: new Date().toISOString(),
  };
}

// ------------------------------------------------- future spatial boundaries

/** Provider-neutral spatial capabilities. DECLARED INTERFACES ONLY: no
 *  provider is implemented, no imagery is fetched, and no computer
 *  vision, volumetric, or photogrammetric analysis is performed. These
 *  exist so a future integration has one place to plug in — nothing
 *  here fabricates such analysis. */
export const SPATIAL_CAPABILITIES: import("../../../shared/types").SpatialProviderSpec[] = [
  {
    capability: "DRONE_IMAGERY",
    displayName: "Drone imagery",
    description: "Site overflight imagery captured on a schedule and aligned to the project boundary.",
    status: "DISABLED",
    requires: ["flight authorization", "operator provider", "imagery storage + retention policy"],
  },
  {
    capability: "SATELLITE_IMAGERY",
    displayName: "Satellite imagery",
    description: "Periodic overhead imagery for coarse progress context.",
    status: "DISABLED",
    requires: ["imagery provider contract", "resolution + revisit policy", "licensing terms"],
  },
  {
    capability: "LIDAR",
    displayName: "LiDAR",
    description: "Point-cloud capture for surface and structure measurement.",
    status: "DISABLED",
    requires: ["capture hardware/provider", "point-cloud storage", "registration workflow"],
  },
  {
    capability: "PHOTOGRAMMETRY",
    displayName: "Photogrammetry",
    description: "Reconstruction of site geometry from overlapping imagery.",
    status: "DISABLED",
    requires: ["processing provider", "control points", "accuracy statement"],
  },
  {
    capability: "VOLUMETRIC_MEASUREMENT",
    displayName: "Volumetric measurement",
    description: "Earthwork and stockpile volume estimates derived from captured surfaces.",
    status: "DISABLED",
    requires: ["surface source (LiDAR/photogrammetry)", "datum + tolerance policy", "surveyor sign-off"],
  },
  {
    capability: "BIM_MODEL",
    displayName: "BIM model",
    description: "Design model reference for comparing planned against recorded progress.",
    status: "DISABLED",
    requires: ["model format support (IFC)", "version governance", "model-to-milestone mapping"],
  },
  {
    capability: "GIS_LAYER",
    displayName: "GIS layers",
    description: "Jurisdictional and utility layers overlaid on the project map.",
    status: "DISABLED",
    requires: ["authoritative layer source", "licensing terms", "coordinate system handling"],
  },
];

export function spatialReadiness(): {
  enabled: false;
  notice: string;
  capabilities: typeof SPATIAL_CAPABILITIES;
} {
  return {
    enabled: false,
    notice:
      "Future spatial capabilities are declared interfaces only. No provider is connected, no imagery is " +
      "retrieved, and no computer-vision, photogrammetric, or volumetric analysis is performed in this build.",
    capabilities: SPATIAL_CAPABILITIES,
  };
}
