/**
 * Digital Twin scene builder.
 *
 * DERIVED ON READ, VISUALIZATION ONLY. The scene is assembled from
 * records the governed subsystems already authored: the project's
 * recorded site boundary, the spatial ROUTE/SEGMENT features, evidence
 * items with a REAL GPS fix, jurisdictional inspections, permits, and
 * the caller's own (already role-gated) project timeline. The twin
 * never writes, never approves, never changes progress, and never
 * places a record at a coordinate the records do not contain — a record
 * with no coordinates goes to the anchored dock, labeled as such.
 *
 * Authorization is inherited, never widened: everything derived from
 * the timeline carries the timeline's subsystem gates, and the three
 * narrower predicates (Evidence Intelligence, Official Sources,
 * banking) are consulted directly for the twin's own panels — imported
 * from their owning modules so there is one source of truth per gate.
 */
import * as repo from "../../db/repo";
import { canViewEvidenceIntel } from "../evidenceIntel/core";
import { canViewSources } from "../officialSources/core";
import { hasBankingCapability } from "../banking/bankingAccess";
import * as evidenceIntel from "../evidenceIntel";
import { requireVisibleProject, TIMELINE_NOTICE } from "../timeline/core";
import { projectTimeline } from "../timeline/aggregate";
import type {
  EvidenceItem,
  EvidenceSignal,
  Milestone,
  MilestoneStatus,
  Project,
  TimelineEvent,
  TwinAnchoredRecord,
  TwinElement,
  TwinLayer,
  TwinPoint,
  TwinScene,
  TwinStage,
  TwinSyncEntry,
  User,
} from "../../../shared/types";
import {
  boundsOf,
  distanceToPolylineM,
  makeFrame,
  projectRing,
  ringCentroid,
  toLocal,
  type LocalFrame,
} from "./geometry";

/** Stamped onto every twin surface, alongside the timeline notice. */
export const TWIN_NOTICE =
  "Timeline & Site Evidence is a spatial project record built from records OBV already holds — the current " +
  "stage of the Digital Twin maturity path, not a 3D model. It owns no data, performs no writes, " +
  "and never becomes the system of record — the Timeline remains the authoritative interface. Positions are " +
  "drawn only from recorded coordinates; records without coordinates are listed, never placed. Stage fills " +
  "show the recorded governance lifecycle, not a physical measurement.";

/** The governance lifecycle, in order. A stage's fill level is its
 *  recorded position here — a fact, not an estimate. */
export const LIFECYCLE: MilestoneStatus[] = [
  "NOT_STARTED", "PENDING_EVIDENCE", "UNDER_REVIEW", "VERIFIED", "APPROVED", "RELEASED",
];

export function lifecycleStep(status: MilestoneStatus): number {
  const i = LIFECYCLE.indexOf(status);
  return i < 0 ? 0 : i;
}

/** Evidence pins are capped (and the cap reported) so one enormous
 *  project cannot make the scene unrenderable. */
export const PIN_CAP = 1_500;

const safe = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

interface SceneBasis {
  project: Project;
  frame: LocalFrame | null;
  degraded: boolean;
  boundaryLocal: TwinPoint[];
  /** A basis-level caveat to surface in the scene's caps, if any. */
  note: string | null;
}

/** True when recorded longitudes straddle the antimeridian. The simple
 *  equirectangular frame cannot represent that honestly (a ~2 km site
 *  would project as a world-spanning sliver with a confidently wrong
 *  scale bar), so such a scene is refused and the reason stated rather
 *  than drawn wrong. */
function straddlesAntimeridian(lngs: number[]): boolean {
  if (lngs.length === 0) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const l of lngs) {
    min = Math.min(min, l);
    max = Math.max(max, l);
  }
  return max - min > 180;
}

/** Choose the local origin from REAL recorded geometry: the boundary
 *  centroid, else the first segment vertex, else the first GPS fix.
 *  When nothing recorded carries a coordinate the scene is degraded —
 *  it says so and renders the dock only, inventing nothing. */
function basisFor(project: Project, milestones: Milestone[], evidence: EvidenceItem[]): SceneBasis {
  const features = safe(() => repo.listSpatialFeatures(project.id), []);
  const lngs = [
    ...project.siteBoundary.map(([lng]) => lng),
    ...features.flatMap((f) => f.geometry.map(([lng]) => lng)),
    ...evidence.filter((e) => e.longitude !== null).map((e) => e.longitude as number),
  ];
  if (straddlesAntimeridian(lngs)) {
    return {
      project,
      frame: null,
      degraded: true,
      boundaryLocal: [],
      note:
        "Recorded coordinates straddle the antimeridian, which this scene projection cannot draw " +
        "honestly — the scene is disabled rather than rendered wrong. Records remain listed below.",
    };
  }
  const centroid = ringCentroid(project.siteBoundary);
  if (centroid) {
    const frame = makeFrame(centroid.lat, centroid.lng);
    return { project, frame, degraded: false, boundaryLocal: projectRing(frame, project.siteBoundary), note: null };
  }
  const firstVertex = features.find((f) => f.geometry.length > 0)?.geometry[0];
  if (firstVertex) {
    const frame = makeFrame(firstVertex[1], firstVertex[0]);
    return { project, frame, degraded: false, boundaryLocal: [], note: null };
  }
  const fix = evidence.find((e) => e.latitude !== null && e.longitude !== null);
  if (fix) {
    const frame = makeFrame(fix.latitude as number, fix.longitude as number);
    return { project, frame, degraded: false, boundaryLocal: [], note: null };
  }
  return { project, frame: null, degraded: true, boundaryLocal: [], note: null };
}

/** Build the full scene for one project. Same-404 and the timeline role
 *  gate apply before any work is done. */
export function twinScene(user: User, projectId: string): TwinScene {
  const project = requireVisibleProject(user, projectId);
  const timeline = projectTimeline(user, project.id);
  const asOf = timeline.asOf;
  const caps: string[] = [...timeline.sourceCaps];

  const milestones = safe(() => repo.listMilestones(project.id), []).filter((m) => !m.archived);
  const evidenceByMilestone = new Map<string, EvidenceItem[]>();
  for (const m of milestones) {
    evidenceByMilestone.set(m.id, safe(() => repo.listEvidenceForMilestone(m.id), []));
  }
  const allEvidence = [...evidenceByMilestone.values()].flat();
  const basis = basisFor(project, milestones, allEvidence);
  const frame = basis.frame;
  if (basis.note) caps.push(basis.note);

  const features = safe(() => repo.listSpatialFeatures(project.id), []);
  const inspections = safe(() => repo.listInspectionsForProject(project.id), []);
  const permits = safe(() => repo.listPermitsForProject(project.id), []);
  const exceptions = safe(() => repo.listExceptionsForProject(project.id), []);
  const openExceptionsByMilestone = new Map<string, number>();
  for (const x of exceptions) {
    if (x.status === "RESOLVED" || x.status === "CLOSED" || x.status === "WAIVED") continue;
    const mid = (x as { milestoneId?: string | null }).milestoneId ?? null;
    if (mid) openExceptionsByMilestone.set(mid, (openExceptionsByMilestone.get(mid) ?? 0) + 1);
  }

  // ---- stages (milestones read as construction stages) ----
  const stages: TwinStage[] = milestones
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((m) => {
      const items = evidenceByMilestone.get(m.id) ?? [];
      const verified = items.filter(
        (e) => safe(() => repo.getVerificationForEvidence(e.id), null)?.verdict === "VERIFIED"
      ).length;
      return {
        milestoneId: m.id,
        seq: m.seq,
        title: m.title,
        spatialLabel: m.spatialLabel ?? null,
        status: m.status,
        accountStatus: m.accountStatus,
        lifecycleStep: lifecycleStep(m.status),
        lifecycleTotal: LIFECYCLE.length - 1,
        trancheAmount: m.trancheAmount,
        evidenceCount: items.length,
        gpsEvidenceCount: items.filter((e) => e.latitude !== null && e.longitude !== null).length,
        verifiedEvidenceCount: verified,
        inspectionCount: inspections.filter((i) => i.milestoneId === m.id).length,
        openExceptionCount: openExceptionsByMilestone.get(m.id) ?? 0,
        hasGeometry: features.some((f) => f.kind === "SEGMENT" && f.milestoneId === m.id && f.geometry.length > 0),
        plannedStart: m.plannedStart ?? null,
        plannedEnd: m.plannedEnd ?? null,
      };
    });

  // ---- drawable elements ----
  const elements: TwinElement[] = [];
  if (basis.boundaryLocal.length >= 3) {
    elements.push({
      id: `BOUNDARY:${project.id}`,
      kind: "BOUNDARY",
      label: "Recorded site boundary",
      sourceTable: "projects",
      sourceRecordId: project.id,
      milestoneId: null,
      points: basis.boundaryLocal,
      status: project.status,
      severity: null,
      recordStatus: "AUTHORITATIVE",
      href: `/projects/${project.id}`,
      detail: `${project.siteBoundary.length}-vertex recorded geofence`,
    });
  }
  if (frame) {
    for (const f of features) {
      if (f.geometry.length === 0) continue;
      const stage = f.milestoneId ? stages.find((s) => s.milestoneId === f.milestoneId) : undefined;
      elements.push({
        // Keyed by the FEATURE's own id: a milestone may legally carry
        // more than one SEGMENT row, and sharing an id would make two
        // drawn paths claim one record.
        id: f.kind === "ROUTE" ? `ROUTE:${f.id}` : `SEGMENT:${f.id}`,
        kind: f.kind === "ROUTE" ? "ROUTE" : "SEGMENT",
        label: stage ? `${stage.title}` : f.label,
        sourceTable: "spatial_features",
        sourceRecordId: f.id,
        milestoneId: f.milestoneId,
        points: projectRing(frame, f.geometry),
        status: stage ? stage.status : null,
        severity: null,
        recordStatus: "AUTHORITATIVE",
        href: `/projects/${project.id}`,
        detail: stage
          ? `Stage ${stage.seq} · recorded status ${stage.status}`
          : "Recorded project route",
      });
    }
  }

  // Evidence pins — ONLY items with a real GPS fix; capped and reported.
  let pinCount = 0;
  let skippedNoGps = 0;
  if (frame) {
    for (const m of milestones) {
      for (const e of evidenceByMilestone.get(m.id) ?? []) {
        if (e.latitude === null || e.longitude === null) {
          skippedNoGps += 1;
          continue;
        }
        if (pinCount >= PIN_CAP) continue;
        pinCount += 1;
        const verdict = safe(() => repo.getVerificationForEvidence(e.id), null)?.verdict ?? null;
        elements.push({
          id: `EVIDENCE_PIN:${e.id}`,
          kind: "EVIDENCE_PIN",
          label: `Evidence — ${m.title}`,
          sourceTable: "evidence_items",
          sourceRecordId: e.id,
          milestoneId: m.id,
          points: [toLocal(frame, e.longitude, e.latitude)],
          status: verdict,
          severity: null,
          recordStatus: "AUTHORITATIVE",
          href: `/timeline/twin/${project.id}?pin=${encodeURIComponent(e.id)}`,
          detail: `Captured ${e.capturedAt.slice(0, 16).replace("T", " ")} UTC`,
        });
      }
    }
  } else {
    skippedNoGps = allEvidence.length;
  }
  if (pinCount >= PIN_CAP) {
    caps.push(`evidence pins: showing the first ${PIN_CAP} GPS-located items`);
  }
  if (skippedNoGps > 0) {
    caps.push(
      `${skippedNoGps} evidence item${skippedNoGps === 1 ? "" : "s"} carry no GPS fix and are listed per stage instead of being placed`
    );
  }

  // Inspection markers — anchored to the milestone's recorded segment
  // geometry (its midpoint), never to an invented site position; an
  // inspection whose milestone has no geometry goes to the dock.
  const anchored: TwinAnchoredRecord[] = [];
  for (const i of inspections) {
    const seg = frame
      ? elements.find((el) => el.kind === "SEGMENT" && el.milestoneId === i.milestoneId)
      : undefined;
    const label = `${i.inspectionType ?? "Inspection"}${i.inspectionReference ? ` ${i.inspectionReference}` : ""}`;
    if (seg && seg.points.length > 0) {
      const mid = seg.points[Math.floor(seg.points.length / 2)];
      elements.push({
        id: `INSPECTION_MARKER:${i.id}`,
        kind: "INSPECTION_MARKER",
        label,
        sourceTable: "jurisdictional_inspections",
        sourceRecordId: i.id,
        milestoneId: i.milestoneId,
        points: [mid],
        status: i.status,
        severity: null,
        recordStatus: "AUTHORITATIVE",
        href: `/permits`,
        detail: "Placed on its milestone's recorded geometry",
      });
    } else {
      anchored.push({
        id: `INSPECTION_MARKER:${i.id}`,
        group: "INSPECTION",
        label,
        status: i.status,
        detail: "No recorded coordinates — listed, not placed",
        sourceTable: "jurisdictional_inspections",
        sourceRecordId: i.id,
        href: `/permits`,
        recordStatus: "AUTHORITATIVE",
      });
    }
  }

  // Permits and official-source records carry no coordinates in the data
  // model: dock, never map. Official Sources rows appear only for roles
  // that subsystem itself admits.
  for (const p of permits) {
    anchored.push({
      id: `PERMIT:${p.id}`,
      group: "PERMIT",
      label: `Permit ${p.permitNumber} — ${p.permitType}`,
      status: p.status,
      detail:
        `${p.issuingAuthority ?? p.jurisdiction ?? "authority not recorded"}` +
        `${p.expiresAt ? ` · expires ${p.expiresAt.slice(0, 10)}` : ""}`,
      sourceTable: "permits",
      sourceRecordId: p.id,
      href: `/permits`,
      recordStatus: "AUTHORITATIVE",
    });
  }
  const sourcesVisible = canViewSources(user);
  if (sourcesVisible) {
    for (const rec of safe(() => repo.listOfficialSourcesForProject(project.id), [])) {
      anchored.push({
        id: `OFFICIAL_SOURCE:${rec.id}`,
        group: "OFFICIAL_SOURCE",
        label: `Official record${rec.officialRecordNumber ? ` ${rec.officialRecordNumber}` : ""}`,
        status: rec.officialStatusText,
        detail: `${rec.officialSystemName ?? "official system"} · attached by an authorized reviewer`,
        sourceTable: "official_source_records",
        sourceRecordId: rec.id,
        href: `/permits`,
        recordStatus: "AUTHORITATIVE",
      });
    }
  }
  // Advisory markers — Evidence Intelligence findings, ONLY for roles
  // that subsystem admits. A finding whose subject evidence has a real
  // GPS fix is drawn at that recorded fix; the rest go to the panel.
  const advisoryVisible = canViewEvidenceIntel(user);
  let advisoryCount = 0;
  if (advisoryVisible) {
    const signals: EvidenceSignal[] = safe(
      () => evidenceIntel.signalsForSubject(user, "PROJECT", project.id),
      []
    );
    for (const s of signals) {
      advisoryCount += 1;
      let points: TwinPoint[] = [];
      if (frame && s.subjectType === "EVIDENCE_ITEM") {
        const item = safe(() => repo.getEvidence(s.subjectId), null);
        if (item && item.latitude !== null && item.longitude !== null) {
          points = [toLocal(frame, item.longitude, item.latitude)];
        }
      }
      elements.push({
        id: `ADVISORY_MARKER:${s.id}`,
        kind: "ADVISORY_MARKER",
        label: s.title,
        sourceTable: "evidence_signals",
        sourceRecordId: s.id,
        milestoneId: null,
        points,
        status: s.category,
        severity: s.severity,
        recordStatus: "ADVISORY",
        href: `/evidence-intelligence`,
        detail:
          `${(s.confidence * 100).toFixed(0)}% confidence — ${s.explanation} ` +
          `Recommended: ${s.recommendation}`,
      });
    }
  }

  // Plain-fact advisories from records any project viewer can read:
  // permits nearing recorded expiry, required inspections with no
  // recorded result. Facts about stored fields, clearly labeled.
  const soonMs = 30 * 86_400_000;
  const nowMs = Date.parse(asOf);
  for (const p of permits) {
    if (!p.expiresAt || p.status === "CLOSED") continue;
    const expMs = Date.parse(p.expiresAt);
    if (Number.isNaN(expMs) || expMs < nowMs || expMs - nowMs > soonMs) continue;
    const days = Math.ceil((expMs - nowMs) / 86_400_000);
    advisoryCount += 1;
    elements.push({
      id: `ADVISORY_MARKER:permit-expiry:${p.id}`,
      kind: "ADVISORY_MARKER",
      label: `Permit ${p.permitNumber} expires in ${days} day${days === 1 ? "" : "s"}`,
      sourceTable: "permits",
      sourceRecordId: p.id,
      milestoneId: null,
      points: [],
      status: "PERMIT_EXPIRING",
      severity: days <= 7 ? "HIGH" : "MEDIUM",
      recordStatus: "ADVISORY",
      href: `/permits`,
      detail:
        `The permit record carries expiry ${p.expiresAt.slice(0, 10)}. Derived from the recorded field — ` +
        "confirm renewal with the issuing authority.",
    });
  }
  for (const i of inspections) {
    if (!i.required || i.resultRecordedAt || i.completedAt) continue;
    advisoryCount += 1;
    elements.push({
      id: `ADVISORY_MARKER:inspection-missing:${i.id}`,
      kind: "ADVISORY_MARKER",
      label: `Required inspection has no recorded result`,
      sourceTable: "jurisdictional_inspections",
      sourceRecordId: i.id,
      milestoneId: i.milestoneId,
      points: [],
      status: "MISSING_INSPECTION_RESULT",
      severity: "MEDIUM",
      recordStatus: "ADVISORY",
      href: `/permits`,
      detail:
        "This inspection is marked required and carries no completion or result date. Derived from the " +
        "recorded fields — record the official outcome when available.",
    });
  }

  // ---- timeline ↔ scene synchronization ----
  const sync = buildSync(timeline.events, elements, anchored);

  // ---- layers ----
  const bankingVisible = hasBankingCapability(user, project.id, "VIEW_PROJECT_ACCOUNT");
  const count = (k: TwinElement["kind"]) => elements.filter((e) => e.kind === k).length;
  const cat = (c: string) => timeline.categoryCounts[c] ?? 0;
  // The boundary layer group also carries the recorded ROUTE, so its
  // availability must reflect BOTH — otherwise a project with a route
  // but no geofence would have its recorded route hidden by the layer
  // toggle, which would suppress recorded coordinates.
  const routeCount = count("ROUTE");
  const boundaryAvailable = basis.boundaryLocal.length >= 3 || routeCount > 0;
  const layers: TwinLayer[] = [
    { key: "boundary", label: "Site boundary & route", available: boundaryAvailable, defaultOn: boundaryAvailable, count: (basis.boundaryLocal.length >= 3 ? 1 : 0) + routeCount, note: boundaryAvailable ? null : "No recorded site boundary or route" },
    { key: "progress", label: "Construction progress", available: stages.length > 0, defaultOn: stages.length > 0, count: stages.length, note: "Recorded governance lifecycle, not a physical measurement" },
    { key: "evidence", label: "Evidence", available: true, defaultOn: true, count: pinCount, note: skippedNoGps > 0 ? `${skippedNoGps} without GPS listed per stage` : null },
    { key: "gps", label: "GPS pins", available: true, defaultOn: true, count: pinCount, note: "Only real recorded fixes are placed" },
    { key: "inspections", label: "Inspections", available: true, defaultOn: true, count: inspections.length, note: null },
    // Permits are readable by any project viewer; only the Official
    // Sources subsystem's own records are role-gated (and were already
    // excluded from `anchored` above for denied roles) — so the layer
    // itself stays available and its count reflects exactly what this
    // caller's dock holds.
    { key: "sources", label: "Permits & official sources", available: true, defaultOn: true, count: anchored.filter((a) => a.group === "OFFICIAL_SOURCE" || a.group === "PERMIT").length, note: sourcesVisible ? "No recorded coordinates — shown in the dock" : "Official Sources records require a reviewer role; permits are shown" },
    { key: "advisory", label: "Advisory signals", available: true, defaultOn: true, count: advisoryCount, note: advisoryVisible ? "Advisory only — never decisions" : "Evidence Intelligence findings are not available for this role; plain-record facts only" },
    { key: "draws", label: "Draws", available: true, defaultOn: false, count: cat("DRAW") + cat("DECISION"), note: "Highlights linked stages via the timeline" },
    { key: "payments", label: "Payments", available: bankingVisible, defaultOn: false, count: bankingVisible ? cat("PAYMENT") : 0, note: bankingVisible ? null : "Requires the VIEW_PROJECT_ACCOUNT capability" },
    { key: "disputes", label: "Disputes", available: true, defaultOn: false, count: cat("DISPUTE"), note: null },
    { key: "exceptions", label: "Exceptions", available: true, defaultOn: false, count: cat("EXCEPTION"), note: null },
    { key: "timeline", label: "Timeline sync", available: true, defaultOn: true, count: sync.length, note: "Selecting a timeline event highlights its record here" },
    { key: "drone", label: "Drone imagery (future)", available: false, defaultOn: false, count: 0, note: "Disabled boundary — no provider connected, no imagery retrieved" },
    { key: "lidar", label: "LiDAR (future)", available: false, defaultOn: false, count: 0, note: "Disabled boundary — no provider connected" },
    { key: "satellite", label: "Satellite (future)", available: false, defaultOn: false, count: 0, note: "Disabled boundary — no provider connected" },
  ];

  // ---- completion (governance lifecycle, tranche-weighted) ----
  const totalTranche = stages.reduce((s, m) => s + m.trancheAmount, 0);
  const releasedTranche = stages
    .filter((m) => m.status === "RELEASED")
    .reduce((s, m) => s + m.trancheAmount, 0);
  const pct = totalTranche > 0 ? Math.round((releasedTranche / totalTranche) * 100) : 0;

  // Frame metadata reports the UNPADDED extent of the recorded points —
  // a stated size must be a measurement, so an empty scene reports 0×0
  // rather than the renderer's padding box.
  const allPoints = elements.flatMap((e) => e.points);
  const bb = allPoints.length > 0 ? boundsOf(allPoints, 0) : { widthM: 0, heightM: 0 };
  return {
    projectId: project.id,
    projectName: project.name,
    notice: `${TWIN_NOTICE} ${TIMELINE_NOTICE}`,
    frame: {
      originLat: frame?.originLat ?? 0,
      originLng: frame?.originLng ?? 0,
      widthM: Math.round(bb.widthM),
      heightM: Math.round(bb.heightM),
      degraded: basis.degraded,
    },
    boundary: basis.boundaryLocal,
    route: elements.find((e) => e.kind === "ROUTE")?.points ?? null,
    stages,
    elements,
    anchored,
    layers,
    sync,
    completion: {
      released: releasedTranche,
      total: totalTranche,
      pct,
      basis:
        "Tranche-weighted share of milestones whose recorded status is RELEASED — governance lifecycle, " +
        "not a physical measurement.",
    },
    caps,
    asOf,
  };
}

/** Map each timeline event to the scene element (or dock record) that
 *  represents its source record. Only real correspondences are emitted:
 *  an event about a specific record maps to that record's own
 *  representation (an ADVISORY marker derived FROM a record never
 *  outranks the record itself), an event on a milestone with recorded
 *  geometry maps to that geometry, and an event with neither simply has
 *  no sync entry — the twin never pretends the site boundary "is" a
 *  lender decision. */
function buildSync(
  events: TimelineEvent[],
  elements: TwinElement[],
  anchored: TwinAnchoredRecord[]
): TwinSyncEntry[] {
  const byRecord = new Map<string, string>();
  const claim = (table: string, recordId: string, elementId: string) => {
    const key = `${table}:${recordId}`;
    if (!byRecord.has(key)) byRecord.set(key, elementId);
  };
  // Authoritative representations claim their record key FIRST; derived
  // advisory markers only represent a record no one else does.
  for (const el of elements) {
    if (el.kind !== "ADVISORY_MARKER") claim(el.sourceTable, el.sourceRecordId, el.id);
  }
  for (const a of anchored) claim(a.sourceTable, a.sourceRecordId, a.id);
  for (const el of elements) {
    if (el.kind === "ADVISORY_MARKER") claim(el.sourceTable, el.sourceRecordId, el.id);
  }
  const segmentByMilestone = new Map<string, string>();
  for (const el of elements) {
    if (el.kind === "SEGMENT" && el.milestoneId && !segmentByMilestone.has(el.milestoneId)) {
      segmentByMilestone.set(el.milestoneId, el.id);
    }
  }

  const sync: TwinSyncEntry[] = [];
  for (const e of events) {
    const direct = byRecord.get(`${e.sourceTable}:${e.sourceRecordId}`);
    if (direct) {
      sync.push({ eventId: e.id, elementId: direct });
      continue;
    }
    if (e.milestoneId && segmentByMilestone.has(e.milestoneId)) {
      sync.push({ eventId: e.id, elementId: segmentByMilestone.get(e.milestoneId)! });
    }
  }
  return sync;
}
