/**
 * Digital Twin views — a premium isometric site scene rendered entirely
 * server-side from RECORDED geometry, enhanced (never replaced) by
 * /js/twin.js for layer toggles, selection, synchronization, and
 * construction playback.
 *
 * HONESTY RULES OF THIS FILE:
 *  - Every drawn coordinate comes from a recorded coordinate. The scale
 *    bar is a real scale bar; the compass is a real compass.
 *  - Stage fills show the recorded governance lifecycle and say so.
 *  - Records without coordinates appear in the anchored dock, labeled,
 *    never placed at an invented position.
 *  - Advisory content is chipped ADVISORY and never styled as governed.
 */
import { h, Fragment, renderDocument, VNode } from "./jsx";
import {
  AboutView,
  AppShell,
  DensePanel,
  NavContext,
  PageHeader,
  SignalList,
  SplitWorkspace,
  WorkHeader,
  enumLabel,
} from "./components";
import { raw } from "./jsx";
import type {
  TimelineEvent,
  TwinAnchoredRecord,
  TwinElement,
  TwinPinDetail,
  TwinPoint,
  TwinScene,
  TwinSnapshot,
  TwinProviderSpec,
} from "../../shared/types";
import type { CurrentDrawState } from "../services/twin/workspace";

const C30 = 0.8660254;
const S30 = 0.5;

/** Isometric projection of a local-frame point (metres east/north). */
function isoRaw(p: TwinPoint): { x: number; y: number } {
  return { x: (p.x + p.y) * C30, y: (p.x - p.y) * S30 };
}

interface Fit {
  scale: number;
  toX: (p: TwinPoint) => number;
  toY: (p: TwinPoint) => number;
}

/** Fit every drawable point into the scene viewBox. */
function fitScene(points: TwinPoint[], width: number, height: number, pad: { l: number; r: number; t: number; b: number }): Fit {
  const iso = points.map(isoRaw);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const q of iso) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
  }
  if (!Number.isFinite(minX)) { minX = -50; maxX = 50; minY = -50; maxY = 50; }
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const scale = Math.min((width - pad.l - pad.r) / bw, (height - pad.t - pad.b) / bh);
  const ox = pad.l + (width - pad.l - pad.r - bw * scale) / 2;
  const oy = pad.t + (height - pad.t - pad.b - bh * scale) / 2;
  return {
    scale,
    toX: (p) => ox + (isoRaw(p).x - minX) * scale,
    toY: (p) => oy + (isoRaw(p).y - minY) * scale,
  };
}

function pathOf(points: TwinPoint[], fit: Fit, close: boolean): string {
  if (points.length === 0) return "";
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${fit.toX(p).toFixed(1)},${fit.toY(p).toFixed(1)}`)
    .join(" ");
  return close ? `${d} Z` : d;
}

function shiftedPathOf(points: TwinPoint[], fit: Fit, close: boolean, dy: number): string {
  if (points.length === 0) return "";
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${fit.toX(p).toFixed(1)},${(fit.toY(p) + dy).toFixed(1)}`)
    .join(" ");
  return close ? `${d} Z` : d;
}

function midpointOf(points: TwinPoint[]): TwinPoint {
  return points[Math.floor(points.length / 2)] ?? { x: 0, y: 0 };
}

const VERDICT_CLASS: Record<string, string> = {
  VERIFIED: "twin-pin-ok",
  NEEDS_REVIEW: "twin-pin-warn",
  REJECTED: "twin-pin-bad",
};

/** The scene SVG. Pure presentation over the recorded scene model. */
function SceneSvg(props: { scene: TwinScene }): VNode {
  const scene = props.scene;
  const W = 1000;
  const H = 640;
  const drawables = scene.elements.filter((e) => e.points.length > 0);
  const allPoints = drawables.flatMap((e) => e.points);
  if (scene.frame.degraded || allPoints.length === 0) {
    return (
      <div className="twin-degraded evi-card">
        <h2>No recorded geometry</h2>
        <p className="sub">
          This project has no recorded site boundary, no recorded stage geometry, and no GPS-located
          evidence, so there is nothing the twin can honestly draw. Records are listed below; the
          scene will appear as soon as recorded coordinates exist.
        </p>
      </div>
    );
  }
  const fit = fitScene(allPoints, W, H, { l: 80, r: 80, t: 70, b: 96 });

  const boundaryEl = drawables.find((e) => e.kind === "BOUNDARY");
  const routeEls = drawables.filter((e) => e.kind === "ROUTE");
  const segments = drawables.filter((e) => e.kind === "SEGMENT");
  const markers = drawables
    .filter((e) => e.kind === "EVIDENCE_PIN" || e.kind === "INSPECTION_MARKER" || (e.kind === "ADVISORY_MARKER" && e.points.length > 0))
    .slice()
    .sort((a, b) => fit.toY(midpointOf(a.points)) - fit.toY(midpointOf(b.points)));

  // Real scale bar: the iso transform is length-preserving along the
  // ground axes, so L metres along east = L·scale px along (cos30, sin30).
  // When even the smallest candidate would overflow (a scene fitted
  // around a single recorded point), the bar is omitted rather than
  // drawn wrong — a scale bar is a measurement or it is nothing.
  const candidates = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  let barM = 0;
  for (const c of candidates) if (c * fit.scale <= 180) barM = c;
  const barPx = barM * fit.scale;
  const barX = 26;
  const barY = H - 30;

  return (
    <svg
      id="twin-scene"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Site evidence scene for ${scene.projectName}`}
      data-project={scene.projectId}
    >
      <defs>
        <linearGradient id="twin-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--twin-bg-hi, #eef3f8)" />
          <stop offset="1" stop-color="var(--twin-bg-lo, #dfe7ef)" />
        </linearGradient>
        <linearGradient id="twin-slab" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--twin-slab-hi, #f7faf7)" />
          <stop offset="1" stop-color="var(--twin-slab-lo, #e7efe8)" />
        </linearGradient>
        <filter id="twin-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        <pattern id="twin-grid" width="46" height="26.5" patternUnits="userSpaceOnUse">
          <path d="M23 0 L46 13.25 L23 26.5 L0 13.25 Z" fill="none" stroke="var(--twin-grid, #c9d4de)" stroke-width="0.6" />
        </pattern>
      </defs>

      <rect x="0" y="0" width={W} height={H} fill="url(#twin-sky)" rx="10" />
      <rect x="0" y="0" width={W} height={H} fill="url(#twin-grid)" opacity="0.55" rx="10" />

      {boundaryEl ? (
        <g data-layer-group="boundary">
          <path d={shiftedPathOf(boundaryEl.points, fit, true, 8)} className="twin-slab-side" />
          <path
            d={pathOf(boundaryEl.points, fit, true)}
            className="twin-el twin-boundary"
            data-el={boundaryEl.id}
            tabindex="0"
            role="button"
            aria-label={boundaryEl.label}
          />
        </g>
      ) : null}

      {routeEls.map((routeEl) => (
        <g data-layer-group="boundary">
          <path d={pathOf(routeEl.points, fit, false)} className="twin-route-casing" />
          <path
            d={pathOf(routeEl.points, fit, false)}
            className="twin-el twin-route"
            data-el={routeEl.id}
            tabindex="0"
            role="button"
            aria-label={routeEl.label}
          />
        </g>
      ))}

      <g data-layer-group="progress">
        {segments.map((s) => {
          const mid = midpointOf(s.points);
          const stage = scene.stages.find((st) => st.milestoneId === s.milestoneId);
          return (
            <g>
              <path d={shiftedPathOf(s.points, fit, false, 5)} className="twin-seg-shadow" filter="url(#twin-soft)" />
              <path
                d={pathOf(s.points, fit, false)}
                className={`twin-el twin-seg twin-seg-${s.status ?? "NONE"}`}
                data-el={s.id}
                data-milestone={s.milestoneId ?? ""}
                tabindex="0"
                role="button"
                aria-label={`${s.label} — recorded status ${s.status ?? "unknown"}`}
              />
              {stage ? (
                <g className="twin-seq" transform={`translate(${fit.toX(mid).toFixed(1)},${(fit.toY(mid) - 16).toFixed(1)})`}>
                  <circle r="9" className={`twin-seq-dot twin-seg-${s.status ?? "NONE"}`} />
                  <text y="3.4" text-anchor="middle">{String(stage.seq)}</text>
                </g>
              ) : null}
            </g>
          );
        })}
      </g>

      <g data-layer-group="evidence">
        {markers.filter((m) => m.kind === "EVIDENCE_PIN").map((m) => {
          const p = m.points[0];
          const x = fit.toX(p);
          const y = fit.toY(p);
          return (
            <g
              className={`twin-el twin-pin ${VERDICT_CLASS[m.status ?? ""] ?? "twin-pin-neutral"}`}
              data-el={m.id}
              data-milestone={m.milestoneId ?? ""}
              transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}
              tabindex="0"
              role="button"
              aria-label={m.label}
            >
              <ellipse cx="0" cy="0" rx="7" ry="3.2" className="twin-pin-shadow" />
              <path d="M0,0 C-6,-8 -7,-12 -7,-15 a7,7 0 1 1 14,0 c0,3 -1,7 -7,15 Z" className="twin-pin-body" />
              <circle cx="0" cy="-15" r="3" className="twin-pin-dot" />
            </g>
          );
        })}
      </g>

      <g data-layer-group="inspections">
        {markers.filter((m) => m.kind === "INSPECTION_MARKER").map((m) => {
          const p = m.points[0];
          return (
            <g
              className={`twin-el twin-inspection twin-insp-${m.status ?? "NONE"}`}
              data-el={m.id}
              data-milestone={m.milestoneId ?? ""}
              transform={`translate(${fit.toX(p).toFixed(1)},${(fit.toY(p) - 8).toFixed(1)})`}
              tabindex="0"
              role="button"
              aria-label={m.label}
            >
              <rect x="-6.5" y="-6.5" width="13" height="13" rx="2.5" transform="rotate(45)" className="twin-insp-body" />
              <text y="3.6" text-anchor="middle" className="twin-insp-glyph">i</text>
            </g>
          );
        })}
      </g>

      <g data-layer-group="advisory">
        {markers.filter((m) => m.kind === "ADVISORY_MARKER").map((m) => {
          const p = m.points[0];
          return (
            <g
              className={`twin-el twin-advisory ${m.severity === "HIGH" ? "twin-adv-high" : "twin-adv-med"}`}
              data-el={m.id}
              transform={`translate(${fit.toX(p).toFixed(1)},${(fit.toY(p) - 26).toFixed(1)})`}
              tabindex="0"
              role="button"
              aria-label={`Advisory: ${m.label}`}
            >
              <path d="M0,-9 L8,0 L0,9 L-8,0 Z" className="twin-adv-body" />
              <text y="3.6" text-anchor="middle" className="twin-adv-glyph">!</text>
            </g>
          );
        })}
      </g>

      {/* Real scale bar along the east axis (omitted when no honest
          length fits the frame). */}
      {barM > 0 ? (
        <g className="twin-scalebar" transform={`translate(${barX},${barY})`}>
          <line x1="0" y1="0" x2={(barPx * C30).toFixed(1)} y2={(barPx * S30).toFixed(1)} />
          <line x1="0" y1="-4" x2="0" y2="4" />
          <line x1={(barPx * C30).toFixed(1)} y1={(barPx * S30 - 4).toFixed(1)} x2={(barPx * C30).toFixed(1)} y2={(barPx * S30 + 4).toFixed(1)} />
          <text x={((barPx * C30) / 2).toFixed(1)} y={((barPx * S30) / 2 - 8).toFixed(1)} text-anchor="middle">
            {barM >= 1000 ? `${barM / 1000} km` : `${barM} m`}
          </text>
        </g>
      ) : null}

      {/* Real compass: north in this projection points up-right. */}
      <g className="twin-compass" transform={`translate(${W - 46},44)`}>
        <circle r="16" className="twin-compass-face" />
        <path d={`M0,0 L${(20 * C30).toFixed(1)},${(-20 * S30).toFixed(1)}`} className="twin-compass-needle" />
        <text x={(26 * C30).toFixed(1)} y={(-26 * S30 + 4).toFixed(1)} text-anchor="middle">N</text>
      </g>
    </svg>
  );
}

/** Governance-lifecycle bar: filled cells = recorded lifecycle step. */
function LifecycleBar(props: { step: number; total: number }): VNode {
  const cells: VNode[] = [];
  for (let i = 0; i < props.total; i += 1) {
    cells.push(<span className={`twin-cell ${i < props.step ? "twin-cell-on" : ""}`} />);
  }
  return <span className="twin-lifecycle" title={`Recorded lifecycle step ${props.step} of ${props.total}`}>{cells}</span>;
}

function statusTone(status: string): string {
  if (status === "RELEASED" || status === "APPROVED" || status === "PASSED") return "ok";
  if (status === "REJECTED" || status === "FAILED" || status === "CORRECTIONS_REQUIRED") return "bad";
  if (status === "NOT_STARTED" || status === "CANCELLED") return "neutral";
  return "warn";
}

function chip(value: string, tone?: string) {
  return <span className={`chip ${tone ?? "neutral"}`}>{enumLabel(value)}</span>;
}

function AnchoredDock(props: { anchored: TwinAnchoredRecord[] }): VNode | null {
  if (props.anchored.length === 0) return null;
  const groups = new Map<string, TwinAnchoredRecord[]>();
  for (const a of props.anchored) {
    const list = groups.get(a.group) ?? [];
    list.push(a);
    groups.set(a.group, list);
  }
  return (
    <section className="evi-card" data-twin-dock>
      <h2>Site records without recorded coordinates</h2>
      <p className="sub">
        These records belong to the site but carry no coordinates in the data model, so they are
        listed here rather than placed at an invented position.
      </p>
      {[...groups.entries()].map(([group, list]) => (
        <div className="twin-dock-group">
          <h3 className="tl-section-title">{enumLabel(group)}</h3>
          <ul className="twin-dock-list">
            {list.map((a) => (
              <li className="twin-dock-item" data-el={a.id} tabindex="0">
                <span className="twin-dock-label">
                  {a.href ? <a href={a.href}>{a.label}</a> : a.label}
                  {a.status ? chip(a.status, statusTone(a.status)) : null}
                  {a.recordStatus === "ADVISORY" ? <span className="chip warn">Advisory</span> : null}
                </span>
                <span className="sub">{a.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function PinDrawer(props: { detail: TwinPinDetail; projectId: string }): VNode {
  const d = props.detail;
  const dist = d.distances;
  return (
    <div className="twin-drawer-body">
      <img className="twin-photo" src={d.evidence.photoPath} alt={`Evidence photo for ${d.evidence.milestoneTitle}`} />
      <p className="sub">
        Captured {d.evidence.capturedAt.replace("T", " ").slice(0, 16)} UTC
        {d.evidence.capturedBy ? ` by ${d.evidence.capturedBy}` : ""} · uploaded{" "}
        {d.evidence.uploadedAt.replace("T", " ").slice(0, 16)} UTC
      </p>
      {d.stage ? (
        <p className="sub">
          Stage: <b>{d.stage.title}</b> {chip(d.stage.status, statusTone(d.stage.status))}
        </p>
      ) : null}
      {d.verification ? (
        <div className="twin-drawer-block">
          <h3 className="tl-section-title">Verification</h3>
          <p className="sub">
            {chip(d.verification.verdict, statusTone(d.verification.verdict === "VERIFIED" ? "PASSED" : d.verification.verdict === "REJECTED" ? "FAILED" : "PENDING"))}{" "}
            {(d.verification.confidence * 100).toFixed(0)}% confidence · source {enumLabel(d.verification.source)}
          </p>
          <ul className="twin-checks">
            {d.verification.checks.map((c) => (
              <li className={c.passed ? "twin-check-ok" : "twin-check-warn"}>
                <b>{c.name}</b> — {c.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="sub">No verification recorded for this item.</p>
      )}
      <div className="twin-drawer-block">
        <h3 className="tl-section-title">Position (recorded GPS)</h3>
        {d.evidence.hasGps ? (
          <ul className="twin-facts">
            <li>Distance to planned stage geometry: <b>{dist.toPlannedGeometryM !== null ? `${dist.toPlannedGeometryM} m` : "not computable — no recorded stage geometry"}</b></li>
            <li>Distance to site centroid: <b>{dist.toSiteCentroidM !== null ? `${dist.toSiteCentroidM} m` : "not computable"}</b></li>
            <li>Inside recorded boundary: <b>{dist.insideBoundary === null ? "unknown" : dist.insideBoundary ? "yes" : "no"}</b></li>
          </ul>
        ) : (
          <p className="sub">This item carries no GPS fix, so no distance is computed — never guessed.</p>
        )}
      </div>
      {d.advisorySignals !== null ? (
        <div className="twin-drawer-block">
          <h3 className="tl-section-title">Advisory findings</h3>
          {d.advisorySignals.length === 0 ? (
            <p className="sub">No advisory findings recorded for this item.</p>
          ) : (
            <ul className="twin-facts">
              {d.advisorySignals.map((s) => (
                <li>
                  <span className="chip warn">Advisory</span> <b>{s.title}</b> ({(s.confidence * 100).toFixed(0)}%)
                  <br />
                  {s.explanation} <i>{s.recommendation}</i>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="sub">Advisory findings are shown to reviewer roles on the governed pages.</p>
      )}
      {d.ocr !== null && d.ocr.length > 0 ? (
        <div className="twin-drawer-block">
          <h3 className="tl-section-title">OCR runs</h3>
          <ul className="twin-facts">
            {d.ocr.map((o) => (
              <li>
                {enumLabel(o.docKind)} · {o.status}
                {o.overallConfidence !== null ? ` · provider confidence ${(o.overallConfidence * 100).toFixed(0)}%` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.metadataFacts ? (
        <div className="twin-drawer-block">
          <h3 className="tl-section-title">Recorded metadata</h3>
          <ul className="twin-facts">
            <li>Upload delay: {d.metadataFacts.uploadDelaySeconds !== null ? `${d.metadataFacts.uploadDelaySeconds}s` : "—"}</li>
            <li>Type/size: {d.metadataFacts.mimeType ?? "—"} · {d.metadataFacts.fileSize !== null ? `${Math.round(d.metadataFacts.fileSize / 1024)} KB` : "—"}</li>
            <li>Dimensions: {d.metadataFacts.width !== null && d.metadataFacts.height !== null ? `${d.metadataFacts.width}×${d.metadataFacts.height}` : "—"}</li>
          </ul>
        </div>
      ) : null}
      {d.nearby.inspections.length > 0 || d.nearby.evidence.length > 0 ? (
        <div className="twin-drawer-block">
          <h3 className="tl-section-title">Nearby (same stage)</h3>
          <ul className="twin-facts">
            {d.nearby.inspections.map((i) => (
              <li>Inspection: {i.label} {chip(i.status, statusTone(i.status))}</li>
            ))}
            {d.nearby.evidence.map((e) => (
              <li>
                <a href={`/timeline/twin/${props.projectId}?pin=${encodeURIComponent(e.id)}`}>{e.label}</a>
                {e.distanceM !== null ? ` · ${e.distanceM} m away` : " · no GPS on one side"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {d.timelineEventId ? (
        <p className="sub">
          <a href={`/timeline/event/${props.projectId}/${encodeURIComponent(d.timelineEventId)}`}>
            Open this event on the Timeline →
          </a>
        </p>
      ) : null}
    </div>
  );
}

/** Mode tabs shown on both pages: Timeline | Site evidence. */
export function TwinModeTabs(props: { projectId: string; active: "timeline" | "twin" }): VNode {
  return (
    <div className="exec-tabs twin-mode-tabs" role="navigation" aria-label="Timeline mode">
      <a className={`btn ghost sm ${props.active === "timeline" ? "exec-tab-active" : ""}`} href={`/timeline/project/${props.projectId}`}>
        Timeline
      </a>
      <a className={`btn ghost sm ${props.active === "twin" ? "exec-tab-active" : ""}`} href={`/timeline/twin/${props.projectId}`}>
        Site evidence
      </a>
    </div>
  );
}

/** Truth-class presentation: label + chip tone, one mapping for every
 *  surface on this page. */
function truthChipOf(e: TimelineEvent): { label: string; tone: string } {
  if (e.truthClass === "ADVISORY_SIGNAL") return { label: "Advisory", tone: "warn" };
  if (e.truthClass === "GOVERNED_FACT") return { label: "Governed fact", tone: "ok" };
  return { label: "Historical event", tone: "neutral" };
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * Server-rendered inspector for one selected timeline event.
 *
 * HISTORICAL TRUTH IS ABSOLUTE here: the "At the time" block renders only
 * what the stored record itself carries, and the "Current linked state"
 * block renders only live values labeled CURRENT — the two are never
 * merged, and a historical transition is never explained with today's
 * blockers. A readiness transition row stores no cause, so the inspector
 * says exactly that instead of inventing one.
 */
function EventInspector(props: {
  event: TimelineEvent;
  now: CurrentDrawState | null;
  projectId: string;
}): VNode {
  const e = props.event;
  const truth = truthChipOf(e);
  const isTransition = e.type === "READINESS_TRANSITION";
  return (
    <div className="tse-event">
      <p className="twin-chip-row">
        <span className={`chip ${truth.tone}`}>{truth.label}</span>
        {e.recordStatus === "ADVISORY" ? <span className="chip warn">Advisory — never a decision</span> : null}
        {e.severity && e.severity !== "INFO" ? (
          <span className={`chip ${e.severity === "HIGH" ? "bad" : "warn"}`}>{e.severity}</span>
        ) : null}
      </p>
      <h3 className="tse-event-title">{e.title}</h3>
      <p className="sub">
        Recorded {e.at.replace("T", " ").slice(0, 16)} UTC
        {/* Actor only when the record names one — never inferred. */}
        {e.actorName ? ` · recorded actor ${e.actorName}` : ""}
      </p>
      <p className="sub">{e.explanation}</p>
      {e.spatial ? (
        <p className="sub">
          Recorded location: {e.spatial.latitude.toFixed(5)}, {e.spatial.longitude.toFixed(5)} · location
          accuracy not recorded
        </p>
      ) : null}
      {isTransition ? (
        <div className="tse-block tse-then">
          <h4>At the time (recorded)</h4>
          <p>
            Readiness {e.change?.previous ?? "(no prior recorded state)"} → <b>{e.change?.current ?? "—"}</b>
          </p>
          <p className="sub">
            Cause not recorded in this historical event — the stored transition carries only the state
            change, never today's blockers.
          </p>
        </div>
      ) : e.change ? (
        <div className="tse-block tse-then">
          <h4>At the time (recorded)</h4>
          <p>
            {enumLabel(e.change.field)}: {e.change.previous ?? "—"} → <b>{e.change.current ?? "—"}</b>
          </p>
        </div>
      ) : null}
      {props.now ? (
        <div className="tse-block tse-now">
          <h4>Current linked state</h4>
          <p>
            Draw {String(props.now.drawNumber)} · status {enumLabel(props.now.status)} · readiness{" "}
            <b>{props.now.readiness ?? "evaluation unavailable"}</b> · {money(props.now.requestedAmount)} requested
          </p>
          <p>
            <span className="tse-current-label">Current next action</span>{" "}
            {props.now.nextActionLabel ?? "not computable"}
            {props.now.nextActionActor && props.now.nextActionActor !== "NONE"
              ? ` (${props.now.nextActionActor.toLowerCase()})`
              : ""}
          </p>
          <p className="sub">
            Live governed state as of this page render — separate from the historical record above.
            Readiness is not approval and never releases funds.
          </p>
        </div>
      ) : e.drawRequestId ? (
        <p className="sub">The current state of the linked draw is unavailable to this view.</p>
      ) : null}
      <p className="sub">Source: {enumLabel(e.sourceTable)} record {e.sourceRecordId}</p>
      <p className="sub tse-event-links">
        {e.href ? <a href={e.href}>Open the governed record →</a> : null}{" "}
        <a href={`/timeline/event/${props.projectId}/${encodeURIComponent(e.id)}`}>
          Open this event on the Timeline →
        </a>
      </p>
    </div>
  );
}

export function renderDigitalTwin(input: {
  nav: NavContext;
  scene: TwinScene;
  focusEventId: string | null;
  /** The selected event's stored record, server-resolved — the inspector
   *  renders it without any client fetch. */
  focusedEvent?: TimelineEvent | null;
  /** CURRENT state of the selected event's linked draw (live, labeled). */
  focusedDrawNow?: CurrentDrawState | null;
  /** CURRENT state of every open draw, for the context header. */
  currentDraws?: CurrentDrawState[];
  /** The project's recorded location field (a stored string, not a
   *  coordinate claim). */
  projectLocation?: string;
  pinDetail: TwinPinDetail | null;
  providers: { providers: TwinProviderSpec[]; implemented: number; notice: string };
  /** The project's governed timeline events — the workspace's left pane.
   *  Same records the Timeline page shows; the Timeline stays authoritative. */
  events?: TimelineEvent[];
  /** Mobile segmented mode. Desktop always shows all three panes. */
  mode?: string | null;
}): string {
  const s = input.scene;
  const elementIndex: Record<string, unknown> = {};
  for (const e of s.elements) {
    elementIndex[e.id] = {
      kind: e.kind, label: e.label, status: e.status, severity: e.severity,
      detail: e.detail, href: e.href, recordStatus: e.recordStatus,
      milestoneId: e.milestoneId, sourceRecordId: e.sourceRecordId, placed: e.points.length > 0,
    };
  }
  for (const a of s.anchored) {
    if (!elementIndex[a.id]) {
      elementIndex[a.id] = {
        kind: a.group, label: a.label, status: a.status, severity: null,
        detail: a.detail, href: a.href, recordStatus: a.recordStatus,
        milestoneId: null, sourceRecordId: a.sourceRecordId, placed: false,
      };
    }
  }

  const advisories = s.elements.filter((e) => e.kind === "ADVISORY_MARKER");
  const events = input.events ?? [];
  const syncedEventIds = new Set(s.sync.map((x) => x.eventId));
  const evTime = (iso: string) => iso.replace("T", " ").slice(5, 16);

  // Project Replay: each element's OWN moment is the earliest recorded
  // event derived from its source record — never an invented time. Only
  // record markers replay; structural geometry (boundary, route, stage
  // segments) is configuration, not an event, and stays visible.
  const eventAtById = new Map(events.map((e) => [e.id, e.at]));
  const elementAt: Record<string, string> = {};
  for (const x of s.sync) {
    const at = eventAtById.get(x.eventId);
    if (!at) continue;
    if (!elementAt[x.elementId] || at < elementAt[x.elementId]) elementAt[x.elementId] = at;
  }
  const replayMin = events.length > 0 ? events[0].at : null;
  const replayMax = events.length > 0 ? events[events.length - 1].at : null;
  // Some records carry dates that have not arrived yet (a recorded permit
  // expiry). They are schedule, not history: the "latest recorded
  // activity" and the replay quick-range anchor use the latest event
  // that has actually happened, never a future-dated row.
  const pastEvents = events.filter((e) => e.at <= s.asOf);
  const lastPastAt = pastEvents.length > 0 ? pastEvents[pastEvents.length - 1].at : null;

  const clientData = {
    projectId: s.projectId,
    focus: input.focusEventId,
    // True when the inspector already carries a server-rendered record
    // (event or pin) that client-side selection must not overwrite.
    eventRendered: Boolean(input.focusedEvent),
    pin: input.pinDetail?.evidence.id ?? null,
    elements: elementIndex,
    sync: Object.fromEntries(s.sync.map((x) => [x.eventId, x.elementId])),
    layers: s.layers.map((l) => ({ key: l.key, available: l.available, defaultOn: l.defaultOn })),
    elementAt,
    replay:
      replayMin && replayMax
        ? { min: replayMin, max: replayMax, anchor: lastPastAt ?? replayMax }
        : null,
  };

  const pinCount = s.elements.filter((e) => e.kind === "EVIDENCE_PIN").length;
  const currentDraws = input.currentDraws ?? [];
  // Newest first: an operator reads the latest recorded activity at the
  // top. The cap is stated in the panel foot, never silent.
  const STREAM_CAP = 80;
  const shown = events.slice().reverse().slice(0, STREAM_CAP);

  return renderDocument(
    <AppShell title="Timeline & Site Evidence" nav={input.nav} context={`${s.projectName} · Timeline & Site Evidence`}>
      <div className="page-wrap ws">
        <WorkHeader
          title="Timeline & Site Evidence"
          sub={`${s.projectName} · ${String(events.length)} recorded events · ${
            s.frame.widthM > 0 && s.frame.heightM > 0 ? `extent ${s.frame.widthM}×${s.frame.heightM} m · ` : ""
          }computed ${s.asOf.replace("T", " ").slice(0, 16)} UTC`}
          crumb={{ href: `/project/${s.projectId}`, label: s.projectName }}
        >
          <a className="btn ghost sm" href={`/timeline/project/${s.projectId}`}>Full timeline</a>
          <a className="btn ghost sm hide-mobile" href={`/timeline/story/${s.projectId}`}>Story</a>
          <a className="btn ghost sm hide-mobile" href={`/timeline/site/${s.projectId}`}>Site intelligence</a>
          <a className="btn ghost sm hide-mobile" href={`/timeline/map/${s.projectId}`}>Map data</a>
        </WorkHeader>

        {/* Current governed context — every value here is LIVE and says
            so; the historical record lives in the stream and inspector. */}
        <section className="tse-context" aria-label="Current project state">
          <div className="tse-ctx-item">
            <span className="tse-k">Recorded location</span>
            <span className="tse-v">{input.projectLocation ?? "Not recorded"}</span>
          </div>
          <div className="tse-ctx-item">
            <span className="tse-k">Latest recorded activity</span>
            <span className="tse-v">
              {lastPastAt ? `${lastPastAt.replace("T", " ").slice(0, 16)} UTC` : "No recorded events"}
            </span>
          </div>
          <div className="tse-ctx-item">
            <span className="tse-k">Spatial evidence</span>
            <span className="tse-v">
              {pinCount > 0
                ? `${pinCount} GPS-located record${pinCount === 1 ? "" : "s"}`
                : "No spatial evidence recorded"}
            </span>
          </div>
          {currentDraws.slice(0, 2).map((d) => (
            <div className="tse-ctx-item tse-ctx-draw">
              <span className="tse-k">Current draw state</span>
              <span className="tse-v">
                Draw {String(d.drawNumber)} · {enumLabel(d.status)} · readiness{" "}
                <b>{d.readiness ?? "evaluation unavailable"}</b> · {money(d.requestedAmount)}
              </span>
              <span className="sub">Current next action: {d.nextActionLabel ?? "not computable"}</span>
            </div>
          ))}
          {currentDraws.length > 2 ? (
            <div className="tse-ctx-item">
              <span className="tse-k">More open draws</span>
              <span className="tse-v">
                <a href={`/draws?project=${encodeURIComponent(s.projectId)}`}>
                  {String(currentDraws.length - 2)} more open →
                </a>
              </span>
            </div>
          ) : null}
        </section>

        {/* Mobile: one mode owns the viewport — never a stacked twin card. */}
        <nav className="segmented" aria-label="Workspace mode">
          <a href={`/timeline/twin/${s.projectId}?mode=timeline`} className={input.mode === "twin" ? "" : "active"}>Timeline</a>
          <a href={`/timeline/twin/${s.projectId}?mode=twin`} className={input.mode === "twin" ? "active" : ""}>Site</a>
        </nav>

        <SplitWorkspace
          mode={input.mode === "twin" ? "twin" : "timeline"}
          inspectorAsSheet={Boolean(input.pinDetail || input.focusEventId)}
          stream={
            <DensePanel
              title="Governed timeline"
              right={<span id="tse-stream-count">{String(shown.length)}</span>}
              flush
              foot={
                <span>
                  {events.length > STREAM_CAP
                    ? `Showing the most recent ${STREAM_CAP} of ${events.length} recorded events. `
                    : ""}
                  <a href={`/timeline/project/${s.projectId}`}>Filter the full timeline →</a>
                </span>
              }
            >
              <div className="tse-filterbar" role="group" aria-label="Timeline truth-class filter">
                <button type="button" className="tse-chipbtn active" data-tse-truth="ALL">All</button>
                <button type="button" className="tse-chipbtn" data-tse-truth="GOVERNED_FACT">Governed</button>
                <button type="button" className="tse-chipbtn" data-tse-truth="HISTORICAL_EVENT">Historical</button>
                <button type="button" className="tse-chipbtn" data-tse-truth="ADVISORY_SIGNAL">Advisory</button>
                <button type="button" className="tse-chipbtn" data-tse-located>Located only</button>
              </div>
              {clientData.replay ? (
                <div className="tse-replay" id="tse-replay">
                  <div className="tse-replay-head">
                    <b>Project Replay</b>
                    <span className="tse-replay-quick">
                      <button type="button" className="tse-chipbtn active" data-tse-range="all">All</button>
                      <button type="button" className="tse-chipbtn" data-tse-range="30">30d</button>
                      <button type="button" className="tse-chipbtn" data-tse-range="7">7d</button>
                    </span>
                  </div>
                  <input
                    type="range"
                    id="tse-replay-scrub"
                    min="0"
                    max="1000"
                    value="1000"
                    aria-label="Recorded events through"
                  />
                  <span className="sub" id="tse-replay-through">
                    Recorded events through: {clientData.replay.max.replace("T", " ").slice(0, 16)} UTC (full record)
                  </span>
                </div>
              ) : null}
              {shown.length === 0 ? (
                <p className="empty-mini">No governed events recorded for this project yet.</p>
              ) : (
                <ul className="slist tse-stream" id="tse-stream">
                  {shown.map((e) => {
                    const truth = truthChipOf(e);
                    const sev = e.severity === "HIGH" ? "high" : e.severity === "MEDIUM" ? "med" : "low";
                    return (
                      <li
                        data-at={e.at}
                        data-truth={e.truthClass}
                        data-eid={e.id}
                        data-located={e.spatial ? "1" : undefined}
                        className={e.id === input.focusEventId ? "tse-active" : undefined}
                      >
                        <a
                          href={`/timeline/twin/${s.projectId}?event=${encodeURIComponent(e.id)}${input.mode === "twin" ? "&mode=twin" : ""}`}
                          aria-current={e.id === input.focusEventId ? "true" : undefined}
                        >
                          <span className={`tse-dot ${sev} tse-tc-${e.truthClass}`} aria-hidden="true"></span>
                          <span className="s-body">
                            <span className="s-t">{e.title}</span>
                            <span className="s-s">
                              {evTime(e.at)} · {enumLabel(e.type)}
                              {e.actorName ? ` · ${e.actorName}` : ""}
                            </span>
                          </span>
                          <span className="s-r">
                            {e.at > s.asOf ? (
                              <span className="chip neutral tse-chip-xs">Upcoming — not yet happened</span>
                            ) : (
                              <span className={`chip ${truth.tone} tse-chip-xs`}>{truth.label}</span>
                            )}
                            {e.spatial ? <span className="chip dim tse-chip-xs">Located</span> : null}
                            {syncedEventIds.has(e.id) ? <span className="chip dim tse-chip-xs">on scene</span> : null}
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </DensePanel>
          }
          canvas={
            <DensePanel
              title="Site evidence"
              right={
                <>
                  <span>{String(s.completion.pct)}% released</span>
                  <a href={`/timeline/twin/${s.projectId}/providers`}>layers</a>
                </>
              }
              className="twin-canvas-panel"
            >
              <div className="ws-canvas-body">
                <SceneSvg scene={s} />
                <div className="twin-playbar" id="twin-playbar">
                  <button className="btn secondary sm" id="twin-play" type="button">▶ Play history</button>
                  <select id="twin-speed" aria-label="Playback speed">
                    <option value="900">1×</option>
                    <option value="450">2×</option>
                    <option value="150">4×</option>
                  </select>
                  <input id="twin-scrub" type="range" min="0" max="0" value="0" aria-label="Playback position" />
                  <span className="sub" id="twin-play-caption">
                    Playback replays the recorded timeline — it never simulates.
                  </span>
                  <span className="sub tl-caps" id="twin-play-note" style="display:none"></span>
                </div>
                <ul className="twin-layer-list twin-layer-row" id="twin-layers">
                  {s.layers.map((l) => (
                    <li className={`twin-layer ${l.available ? "" : "twin-layer-off"}`}>
                      <label>
                        <input
                          type="checkbox"
                          data-layer-toggle={l.key}
                          checked={l.defaultOn ? "checked" : undefined}
                          disabled={l.available ? undefined : "disabled"}
                        />{" "}
                        {l.label} <span className="twin-layer-count">{l.available ? String(l.count) : "—"}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            </DensePanel>
          }
          inspector={
            <DensePanel
              title={input.pinDetail ? "Evidence detail" : input.focusedEvent ? "Event record" : "Context inspector"}
              right={
                <span id="twin-detail-title">
                  {input.pinDetail ? "evidence" : input.focusedEvent ? "event" : "selection"}
                </span>
              }
              className="twin-detail"
              foot={<a href={`/timeline/project/${s.projectId}`}>Open the authoritative timeline →</a>}
            >
              <div id="twin-detail-body">
                {input.pinDetail ? (
                  <PinDrawer detail={input.pinDetail} projectId={s.projectId} />
                ) : input.focusedEvent ? (
                  <EventInspector
                    event={input.focusedEvent}
                    now={input.focusedDrawNow ?? null}
                    projectId={s.projectId}
                  />
                ) : (
                  <p className="sub" style="margin:0 0 10px">
                    Select an event, stage, pin or marker — its record appears here. Read-only, always.
                  </p>
                )}
              </div>
              {advisories.length > 0 ? (
                <div data-twin-advisory-list style="margin-top:10px">
                  <h3 style="margin:0 0 6px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3)">
                    Advisory signals
                  </h3>
                  <SignalList
                    items={advisories.slice(0, 6).map((a) => ({
                      title: a.label,
                      sub: a.detail ?? undefined,
                      severity: a.severity === "HIGH" ? "high" : "med",
                      href: a.href ?? undefined,
                      meta: a.points.length > 0 ? <span className="chip dim">on scene</span> : undefined,
                    }))}
                  />
                </div>
              ) : null}
              <div style="margin-top:10px">
                <h3 style="margin:0 0 6px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3)">
                  Construction progress
                </h3>
                <ul className="twin-stage-list">
                  {s.stages.map((st) => (
                    <li className="twin-stage" data-stage={st.milestoneId} tabindex="0">
                      <span className="twin-stage-head">
                        <b>{String(st.seq)}. {st.title}</b>
                        {chip(st.status, statusTone(st.status))}
                      </span>
                      <LifecycleBar step={st.lifecycleStep} total={st.lifecycleTotal} />
                      <span className="sub">
                        {String(st.evidenceCount)} evidence · {String(st.inspectionCount)} inspection
                        {st.inspectionCount === 1 ? "" : "s"}
                        {st.openExceptionCount > 0 ? ` · ${st.openExceptionCount} open exception${st.openExceptionCount === 1 ? "" : "s"}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </DensePanel>
          }
        />

        <AboutView label="About this workspace — site evidence never changes governed state">
          <p>{s.notice}</p>
          <p>
            Construction progress is the recorded governance lifecycle per stage — <b>not a physical
            measurement</b>. Overall {String(s.completion.pct)}% tranche-weighted released.
          </p>
          {s.caps.length > 0 ? (
            <p><strong>Not the complete record:</strong> {s.caps.join(" · ")}.</p>
          ) : null}
          <p>{input.providers.notice}</p>
          <div className="twin-providers">
            {input.providers.providers.map((pr) => (
              <span className="chip dim" title={pr.description}>{pr.displayName} — disabled</span>
            ))}
          </div>
        </AboutView>

        <AnchoredDock anchored={s.anchored} />
      </div>

      <script type="application/json" id="twin-data">{raw(JSON.stringify(clientData).replace(/</g, "\\u003c"))}</script>
      <script src="/js/twin.js" defer></script>
    </AppShell>
  );
}

export function renderTwinProviders(input: {
  nav: NavContext;
  providers: { providers: TwinProviderSpec[]; implemented: number; notice: string };
}): string {
  return renderDocument(
    <AppShell title="Twin providers" nav={input.nav} context="Digital Twin providers">
      <PageHeader title="Future twin providers" sub={input.providers.notice} />
      <section className="si-grid">
        {input.providers.providers.map((p) => (
          <div className="si-panel si-neutral">
            <span className="si-label">{p.category}</span>
            <b className="si-value">{p.displayName}</b>
            <span className="si-detail">
              {p.description} <b>Status: {p.status}.</b> Requires: {p.requires.join("; ")}.
            </span>
          </div>
        ))}
      </section>
    </AppShell>
  );
}

/** Miniature top-down twin for the portfolio band. Recorded boundary +
 *  recorded stage geometry only; no invented shapes. */
export function TwinSnapshotSvg(props: { snap: TwinSnapshot }): VNode {
  const W = 190;
  const H = 116;
  const pts = [...props.snap.boundary, ...props.snap.stages.flatMap((s) => s.points)];
  if (props.snap.frame.degraded || pts.length === 0) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="twin-snap" role="img" aria-label={`No recorded geometry for ${props.snap.projectName}`}>
        <rect x="0" y="0" width={W} height={H} rx="8" className="twin-snap-bg" />
        <text x={W / 2} y={H / 2 + 4} text-anchor="middle" className="twin-snap-note">no recorded geometry</text>
      </svg>
    );
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const sc = Math.min((W - 16) / bw, (H - 16) / bh);
  const X = (p: TwinPoint) => 8 + (p.x - minX) * sc + (W - 16 - bw * sc) / 2;
  // Screen y grows downward; recorded north is +y, so flip.
  const Y = (p: TwinPoint) => H - 8 - (p.y - minY) * sc - (H - 16 - bh * sc) / 2;
  const d = (points: TwinPoint[], close: boolean) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join(" ") + (close ? " Z" : "");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="twin-snap" role="img" aria-label={`Site sketch for ${props.snap.projectName}`}>
      <rect x="0" y="0" width={W} height={H} rx="8" className="twin-snap-bg" />
      {props.snap.boundary.length >= 3 ? <path d={d(props.snap.boundary, true)} className="twin-snap-boundary" /> : null}
      {props.snap.stages.filter((s) => s.points.length > 0).map((s) => (
        <path d={d(s.points, false)} className={`twin-snap-seg twin-seg-${s.status}`} />
      ))}
    </svg>
  );
}
