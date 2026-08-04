/**
 * Project Timeline & Site Intelligence views.
 *
 * Clarity over density: a reader should be able to follow a project's
 * history without knowing OBV's table names. Every surface repeats the
 * read-only notice, and every event shows whether it came from an
 * AUTHORITATIVE record or an ADVISORY observation — the two are never
 * styled alike.
 */
import { h, Fragment, renderDocument, VNode } from "./jsx";
import { AppShell, NavContext, PageHeader, enumLabel } from "./components";
import { TIMELINE_NOTICE } from "../services/timeline";
import type {
  DrawPlaybackStage,
  PlaybackFrame,
  Project,
  RelationshipGraph,
  StoryStep,
  TimelineEvent,
  TimelineGroup,
  TimelineInsight,
} from "../../shared/types";
import type {
  DrawPlayback,
  PortfolioTimeline,
  ProjectMapData,
  ProjectStory,
  ProjectTimeline,
  SiteIntelligence,
} from "../services/timeline";

const CATEGORY_TONE: Record<string, string> = {
  PROJECT: "neutral", BUDGET: "neutral", MILESTONE: "info", PERMIT: "info",
  INSPECTION: "warn", EVIDENCE: "ok", EVIDENCE_INTEL: "warn", OFFICIAL_SOURCE: "info",
  DISPUTE: "bad", EXCEPTION: "bad", DRAW: "info", DECISION: "ok",
  PAYMENT: "ok", REPORT: "neutral", GOVERNANCE: "neutral",
};

function chip(value: string, tone?: string) {
  return <span className={`chip ${tone ?? "neutral"}`}>{enumLabel(value)}</span>;
}
function when(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(0, 16) : "—";
}
function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

function Notice() {
  return <div className="evi-advisory">{TIMELINE_NOTICE}</div>;
}

/** One event row — the atom of every timeline surface. */
function EventRow(props: { event: TimelineEvent; projectId: string; asOf: string }): VNode {
  const e = props.event;
  const upcoming = e.at > props.asOf;
  return (
    <li className={`tl-item ${upcoming ? "tl-upcoming" : ""}`}>
      <span className="tl-time">
        <b>{day(e.at)}</b>
        <span className="tl-clock">{e.at.slice(11, 16)}</span>
      </span>
      <span className={`tl-dot tl-${CATEGORY_TONE[e.category] ?? "neutral"}`} aria-hidden="true" />
      <span className="tl-body">
        <span className="tl-head">
          <a href={`/timeline/event/${props.projectId}/${encodeURIComponent(e.id)}`}>{e.title}</a>
          {chip(e.category, CATEGORY_TONE[e.category])}
          {e.recordStatus === "ADVISORY" ? <span className="chip warn">Advisory</span> : null}
          {upcoming ? <span className="chip neutral">Upcoming — not yet happened</span> : null}
          {e.severity && e.severity !== "INFO" ? <span className={`chip ${e.severity === "HIGH" ? "bad" : "warn"}`}>{e.severity}</span> : null}
        </span>
        <span className="tl-exp">{e.explanation}</span>
        <span className="tl-meta">
          {e.actorName ? `${e.actorName} · ` : ""}{e.sourceTable}
          {e.change ? ` · ${e.change.field}: ${e.change.previous ?? "—"} → ${e.change.current ?? "—"}` : ""}
          {e.href ? <> · <a href={e.href}>open record</a></> : null}
        </span>
      </span>
    </li>
  );
}

// ==================================================== project timeline

const VIEWS: Array<{ key: string; label: string }> = [
  { key: "all", label: "Everything" },
  { key: "milestones", label: "Milestones" },
  { key: "evidence", label: "Evidence" },
  { key: "inspections", label: "Inspections" },
  { key: "permits", label: "Permits & sources" },
  { key: "financial", label: "Financial" },
  { key: "disputes", label: "Disputes & exceptions" },
  { key: "reviewer", label: "Reviewer activity" },
];

/** The export must be of what the reader is actually looking at. Sending
 *  a bare project id would silently hand back the UNFILTERED history
 *  under a button placed next to an active filter — the reader would
 *  reasonably believe the file matched the screen. */
function exportHref(
  projectId: string,
  format: string,
  view: string,
  query: { q: string; from: string; to: string }
): string {
  const params = new URLSearchParams();
  params.set("format", format);
  if (view && view !== "all") params.set("view", view);
  if (query.q) params.set("q", query.q);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  return `/api/timeline/export/${projectId}?${params.toString()}`;
}

/** Source-level caps, stated on the page whenever one actually applied. */
function SourceCaps({ caps }: { caps: string[] }) {
  if (!caps || caps.length === 0) return null;
  return (
    <p className="sub tl-caps">
      <strong>Not the complete record:</strong>{" "}
      {caps.join(" · ")}. Everything else on this page is complete.
    </p>
  );
}

export function renderProjectTimeline(input: {
  nav: NavContext;
  timeline: ProjectTimeline;
  view: string;
  group: string | null;
  groups: TimelineGroup[] | null;
  query: { q: string; from: string; to: string };
}): string {
  const t = input.timeline;
  const pid = t.project.id;
  const link = (extra: Record<string, string>) => {
    const params = new URLSearchParams();
    if (input.view && input.view !== "all") params.set("view", input.view);
    if (input.query.q) params.set("q", input.query.q);
    if (input.query.from) params.set("from", input.query.from);
    if (input.query.to) params.set("to", input.query.to);
    if (input.group) params.set("group", input.group);
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    const q = params.toString();
    return `/timeline/project/${pid}${q ? `?${q}` : ""}`;
  };

  return renderDocument(
    <AppShell title="Project timeline" nav={input.nav} context="Project history">
      <PageHeader
        title={t.project.name}
        sub="Every governed event for this project, in the order it happened."
        asOf={`${t.totalEvents} recorded events · computed ${when(t.asOf)} UTC${t.sourceCaps.length > 0 ? " · capped" : ""}`}
      >
        <a className="btn ghost sm" href={`/timeline/story/${pid}`}>Story →</a>
        <a className="btn ghost sm" href={`/timeline/site/${pid}`}>Site intelligence →</a>
        <a className="btn ghost sm" href={`/timeline/playback/${pid}`}>Playback →</a>
        <a className="btn ghost sm" href={`/timeline/map/${pid}`}>Map →</a>
        <a className="btn ghost sm" href={exportHref(pid, "csv", input.view, input.query)}>Export CSV</a>
      </PageHeader>
      <Notice />
      <SourceCaps caps={t.sourceCaps} />

      <div className="evi-tabs">
        {VIEWS.map((v) => (
          <a className={`btn ghost sm ${input.view === v.key ? "exec-tab-active" : ""}`} href={link({ view: v.key === "all" ? "" : v.key })}>
            {v.label}
          </a>
        ))}
      </div>

      <section className="evi-card">
        <form method="GET" action={`/timeline/project/${pid}`} className="tl-filters">
          {input.view && input.view !== "all" ? <input type="hidden" name="view" value={input.view} /> : null}
          {input.group ? <input type="hidden" name="group" value={input.group} /> : null}
          <input name="q" placeholder="search events, people, records" value={input.query.q} />
          <input name="from" type="date" value={input.query.from} aria-label="From date" />
          <input name="to" type="date" value={input.query.to} aria-label="To date" />
          <button className="btn secondary sm" type="submit">Filter</button>
          <a className="btn ghost sm" href={`/timeline/project/${pid}`}>Reset</a>
        </form>
        <p className="sub">
          Showing {String(t.events.length)} of {String(t.totalEvents)} events
          {t.truncated ? " (filtered)" : ""}
          {t.upcomingCount > 0 ? ` · ${t.upcomingCount} dated ahead of today and marked upcoming` : ""}
          {" · group by "}
          <a href={link({ group: "" })}>none</a>{" · "}
          <a href={link({ group: "week" })}>week</a>{" · "}
          <a href={link({ group: "month" })}>month</a>{" · "}
          <a href={link({ group: "category" })}>category</a>{" · "}
          <a href={link({ group: "milestone" })}>milestone</a>
        </p>
      </section>

      {input.groups ? (
        input.groups.map((g) => (
          <section className="evi-card">
            <details open>
              <summary className="tl-group-head">
                <b>{g.label}</b>
                <span className="sub"> · {String(g.events.length)} event{g.events.length === 1 ? "" : "s"} · {day(g.from)} → {day(g.to)}</span>
              </summary>
              <ol className="tl-list">
                {g.events.map((e) => <EventRow event={e} projectId={pid} asOf={t.asOf} />)}
              </ol>
            </details>
          </section>
        ))
      ) : (
        <section className="evi-card">
          {t.events.length === 0 ? (
            <p className="sub">No events match these filters.</p>
          ) : (
            <ol className="tl-list">
              {t.events.map((e) => <EventRow event={e} projectId={pid} asOf={t.asOf} />)}
            </ol>
          )}
        </section>
      )}
    </AppShell>
  );
}

// ==================================================== event detail

export function renderEventDetail(input: {
  nav: NavContext;
  projectId: string;
  detail: { event: TimelineEvent; previous: TimelineEvent | null; next: TimelineEvent | null; related: TimelineEvent[] };
}): string {
  const { event, previous, next, related } = input.detail;
  return renderDocument(
    <AppShell title="Event detail" nav={input.nav} context="Project history">
      <PageHeader title={event.title} sub={enumLabel(event.type)}>
        <a className="btn ghost sm" href={`/timeline/project/${input.projectId}`}>← Timeline</a>
      </PageHeader>
      <Notice />
      <div className="evi-detail-head">
        {chip(event.category, CATEGORY_TONE[event.category])}
        {chip(event.recordStatus, event.recordStatus === "ADVISORY" ? "warn" : "ok")}
        {event.severity ? chip(event.severity, event.severity === "HIGH" ? "bad" : "warn") : null}
      </div>

      <section className="evi-card">
        <h2>What happened</h2>
        <p>{event.explanation}</p>
        <table className="evi-table"><tbody>
          <tr><td>When</td><td>{when(event.at)} UTC</td></tr>
          <tr><td>Who</td><td>{event.actorName ?? "System / not attributed to a user"}</td></tr>
          <tr><td>Record</td><td>{event.sourceTable} · {event.sourceRecordId}</td></tr>
          <tr><td>Status</td><td>{event.recordStatus === "ADVISORY" ? "Advisory observation — not a governed decision" : "Authoritative governed record"}</td></tr>
          {event.change ? (
            <tr><td>What changed</td><td>{event.change.field}: {event.change.previous ?? "—"} → {event.change.current ?? "—"}</td></tr>
          ) : null}
          {event.href ? <tr><td>Source</td><td><a href={event.href}>Open the underlying record</a></td></tr> : null}
        </tbody></table>
      </section>

      <section className="evi-card">
        <h2>What happens around it</h2>
        <p className="sub">
          {previous ? <>Before: <a href={`/timeline/event/${input.projectId}/${encodeURIComponent(previous.id)}`}>{previous.title}</a> ({day(previous.at)})</> : "This is the earliest recorded event."}
        </p>
        <p className="sub">
          {next ? <>Next: <a href={`/timeline/event/${input.projectId}/${encodeURIComponent(next.id)}`}>{next.title}</a> ({day(next.at)})</> : "This is the most recent recorded event."}
        </p>
        {related.length > 0 ? (
          <>
            <h2>Related records</h2>
            <ol className="tl-list">
              {related.map((e) => <EventRow event={e} projectId={input.projectId} asOf={event.at} />)}
            </ol>
          </>
        ) : null}
      </section>
    </AppShell>
  );
}

// ==================================================== story mode

export function renderProjectStory(input: { nav: NavContext; story: ProjectStory }): string {
  const s = input.story;
  return renderDocument(
    <AppShell title="Project story" nav={input.nav} context="Project history">
      <PageHeader title={`How ${s.projectName} got here`} sub="The project explained in plain language, from the records OBV holds.">
        <a className="btn ghost sm" href={`/timeline/project/${s.projectId}`}>Full timeline →</a>
        <a className="btn ghost sm" href={`/timeline/site/${s.projectId}`}>Site intelligence →</a>
      </PageHeader>
      <Notice />
      <section className="evi-card">
        <p>{s.opening}</p>
        <p className="sub"><b>Where it stands:</b> {s.currentState}</p>
      </section>
      <section className="evi-card">
        {s.steps.length === 0 ? (
          <p className="sub">There is not yet enough recorded activity to tell this project's story.</p>
        ) : (
          <ol className="tl-story">
            {s.steps.map((step: StoryStep) => (
              <li className="tl-story-step">
                <span className="tl-story-when">{day(step.at)}</span>
                <span className="tl-story-body">
                  <b>
                    <a href={`/timeline/event/${s.projectId}/${encodeURIComponent(step.eventId)}`}>{step.headline}</a>
                  </b>
                  {step.recordStatus === "ADVISORY" ? <span className="chip warn">Advisory</span> : null}
                  <span className="sub">{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
        {s.omitted > 0 ? (
          <p className="sub">
            {String(s.omitted)} further routine record{s.omitted === 1 ? "" : "s"} (configuration changes, individual
            budget lines, banking bookkeeping) are omitted from the narrative. They remain on the{" "}
            <a href={`/timeline/project/${s.projectId}`}>full timeline</a>.
          </p>
        ) : null}
      </section>
    </AppShell>
  );
}

// ==================================================== site intelligence

function InsightCard(props: { insight: TimelineInsight }): VNode {
  const i = props.insight;
  return (
    <div className="evi-card">
      <h2>
        {i.title} <span className={`chip ${i.severity === "HIGH" ? "bad" : i.severity === "MEDIUM" ? "warn" : "neutral"}`}>{i.severity}</span>
      </h2>
      <p>{i.explanation}</p>
      <p className="sub"><b>Suggested next step:</b> {i.recommendation}</p>
      <p className="sub">Measurement: {Object.entries(i.evidence).map(([k, v]) => `${k}=${String(v)}`).join(" · ")}</p>
    </div>
  );
}

export function renderSiteIntelligence(input: { nav: NavContext; site: SiteIntelligence }): string {
  const s = input.site;
  return renderDocument(
    <AppShell title="Site intelligence" nav={input.nav} context="Project intelligence">
      <PageHeader
        title={s.project.name}
        sub="Where this project stands right now, composed from the records each governed subsystem already holds."
        asOf={`${s.totalEvents} recorded events · last activity ${day(s.lastActivityAt)}`}
      >
        <a className="btn ghost sm" href={`/timeline/project/${s.project.id}`}>Timeline →</a>
        <a className="btn ghost sm" href={`/timeline/story/${s.project.id}`}>Story →</a>
        <a className="btn ghost sm" href={`/timeline/map/${s.project.id}`}>Map →</a>
        <a className="btn ghost sm" href={`/timeline/graph/${s.project.id}`}>Relationships →</a>
      </PageHeader>
      <Notice />

      <section className="evi-card">
        <h2>Executive summary</h2>
        <p>{s.executiveSummary}</p>
      </section>

      <section className="si-grid">
        {s.panels.map((p) => (
          <div className={`si-panel si-${p.tone}`}>
            <span className="si-label">{p.label}</span>
            <b className="si-value">{p.href ? <a href={p.href}>{p.value}</a> : p.value}</b>
            <span className="si-detail">{p.detail}</span>
          </div>
        ))}
      </section>

      <section>
        <h2 className="tl-section-title">Advisory observations ({String(s.insights.length)})</h2>
        {s.insights.length === 0 ? (
          <div className="evi-card"><p className="sub">The timeline raised no advisory observations for this project.</p></div>
        ) : (
          s.insights.map((i) => <InsightCard insight={i} />)
        )}
      </section>
    </AppShell>
  );
}

// ==================================================== playback

export function renderExecutivePlayback(input: {
  nav: NavContext;
  playback: { projectId: string; projectName: string; frames: PlaybackFrame[]; asOf: string };
}): string {
  const p = input.playback;
  return renderDocument(
    <AppShell title="Executive playback" nav={input.nav} context="Project history">
      <PageHeader title={`Replay — ${p.projectName}`} sub="How the project accumulated state, period by period.">
        <a className="btn ghost sm" href={`/timeline/project/${p.projectId}`}>← Timeline</a>
      </PageHeader>
      <Notice />
      {p.frames.length === 0 ? (
        <div className="evi-card"><p className="sub">There is no recorded activity to replay yet.</p></div>
      ) : (
        <ol className="tl-frames">
          {p.frames.map((f, idx) => (
            <li className="tl-frame">
              <span className="tl-frame-n">{String(idx + 1)}</span>
              <div className="tl-frame-body">
                <b>{f.label}</b>
                <span className="sub">{f.narrative}</span>
                <span className="tl-frame-stats">
                  {String(f.newEvents)} new · {String(f.cumulativeEvents)} cumulative ·{" "}
                  {String(f.drawsApproved)} draw{f.drawsApproved === 1 ? "" : "s"} approved ·{" "}
                  {String(f.openExceptions)} open exception{f.openExceptions === 1 ? "" : "s"} ·{" "}
                  {String(f.openDisputes)} open dispute{f.openDisputes === 1 ? "" : "s"}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </AppShell>
  );
}

export function renderDrawPlayback(input: { nav: NavContext; playback: DrawPlayback }): string {
  const p = input.playback;
  const stateTone = (s: DrawPlaybackStage["state"]) =>
    s === "COMPLETE" ? "ok" : s === "IN_PROGRESS" ? "warn" : s === "BLOCKED" ? "bad" : "neutral";
  return renderDocument(
    <AppShell title="Draw playback" nav={input.nav} context="Project history">
      <PageHeader title={`Draw ${String(p.drawNumber)} — how it progressed`} sub="Each stage of the governed draw lifecycle, and what the records show.">
        <a className="btn ghost sm" href={`/timeline/project/${p.projectId}`}>← Timeline</a>
        <a className="btn ghost sm" href={`/draws/${p.drawRequestId}`}>Open draw →</a>
      </PageHeader>
      <Notice />
      <ol className="tl-stages">
        {p.stages.map((s) => (
          <li className={`tl-stage tl-stage-${stateTone(s.state)}`}>
            <span className="tl-stage-label">
              <b>{s.label}</b>
              {chip(s.state, stateTone(s.state))}
            </span>
            <span className="sub">{s.detail}{s.at ? ` · first recorded ${day(s.at)}` : ""}</span>
            {s.events.length > 0 ? (
              <ol className="tl-list tl-stage-events">
                {s.events.slice(0, 5).map((e) => <EventRow event={e} projectId={p.projectId} asOf={p.asOf} />)}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
    </AppShell>
  );
}

// ==================================================== relationship graph

export function renderRelationshipGraph(input: {
  nav: NavContext;
  project: Project;
  graph: RelationshipGraph;
}): string {
  const g = input.graph;
  const byKind = new Map<string, typeof g.nodes>();
  for (const n of g.nodes) {
    const list = byKind.get(n.kind) ?? [];
    list.push(n);
    byKind.set(n.kind, list);
  }
  return renderDocument(
    <AppShell title="Relationships" nav={input.nav} context="Project intelligence">
      <PageHeader
        title={`How ${input.project.name} connects`}
        sub="Which records support which — derived from the same events as the timeline, so the two can never disagree."
      >
        <a className="btn ghost sm" href={`/timeline/project/${input.project.id}`}>← Timeline</a>
      </PageHeader>
      <Notice />
      <section className="evi-card">
        <p className="sub">{String(g.nodes.length)} records · {String(g.edges.length)} relationships</p>
      </section>
      {[...byKind.entries()].map(([kind, nodes]) => (
        <section className="evi-card">
          <h2>{enumLabel(kind)} ({String(nodes.length)})</h2>
          <ul className="tl-graph-list">
            {nodes.slice(0, 40).map((n) => {
              const out = g.edges.filter((e) => e.from === n.id);
              return (
                <li>
                  {n.href ? <a href={n.href}>{n.label}</a> : n.label}
                  {out.length > 0 ? <span className="sub"> → {out.slice(0, 4).map((e) => e.label).join(", ")}{out.length > 4 ? ` +${out.length - 4} more` : ""}</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </AppShell>
  );
}

// ==================================================== project map

export function renderProjectMap(input: {
  nav: NavContext;
  map: ProjectMapData;
  spatial: { enabled: false; notice: string; capabilities: Array<{ capability: string; displayName: string; description: string; status: string; requires: string[] }> };
}): string {
  const m = input.map;
  const layerEntries = Object.entries(m.layers);
  return renderDocument(
    <AppShell title="Project map" nav={input.nav} context="Spatial intelligence">
      <PageHeader
        title={`${m.projectName} — site map`}
        sub={`${m.location}${m.jurisdictions.length > 0 ? ` · ${m.jurisdictions.join(", ")}` : ""}`}
      >
        <a className="btn ghost sm" href={`/timeline/site/${m.projectId}`}>← Site intelligence</a>
        <a className="btn ghost sm" href="/map">Full map console →</a>
      </PageHeader>
      <Notice />

      <section className="evi-card">
        <h2>Recorded locations</h2>
        <p className="sub">
          Evidence appears on the map only where the capturing device recorded a real GPS fix. Permits,
          inspections, and official-source records have no coordinates of their own and are listed as
          project-anchored records rather than placed at an invented point.
        </p>
        <div className="si-grid">
          {layerEntries.map(([key, features]) => (
            <div className="si-panel si-neutral">
              <span className="si-label">{enumLabel(key)}</span>
              <b className="si-value">{String(features.length)}</b>
              <span className="si-detail">
                {key === "evidence"
                  ? `${features.length} with a GPS fix`
                  : `${features.length} recorded (no coordinates)`}
              </span>
            </div>
          ))}
          <div className="si-panel si-neutral">
            <span className="si-label">Site geometry</span>
            <b className="si-value">{String(m.features.length)}</b>
            <span className="si-detail">route/segment features from the spatial engine</span>
          </div>
        </div>
      </section>

      {layerEntries.map(([key, features]) =>
        features.length === 0 ? null : (
          <section className="evi-card">
            <h2>{enumLabel(key)}</h2>
            <table className="evi-table">
              <thead><tr><th>Record</th><th>Detail</th><th>Coordinates</th></tr></thead>
              <tbody>
                {features.slice(0, 50).map((f) => (
                  <tr>
                    <td>{f.href ? <a href={f.href}>{f.label}</a> : f.label}</td>
                    <td>{f.detail}</td>
                    <td>
                      {f.latitude !== null && f.longitude !== null
                        ? `${f.latitude.toFixed(5)}, ${f.longitude.toFixed(5)}`
                        : "— (no coordinates recorded)"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )
      )}

      <section className="evi-card">
        <h2>Future spatial layers</h2>
        <p className="sub">{input.spatial.notice}</p>
        <table className="evi-table">
          <thead><tr><th>Capability</th><th>What it would add</th><th>Status</th><th>Would require</th></tr></thead>
          <tbody>
            {input.spatial.capabilities.map((c) => (
              <tr>
                <td>{c.displayName}</td>
                <td>{c.description}</td>
                <td>{chip(c.status)}</td>
                <td className="sub">{c.requires.join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}

// ==================================================== portfolio timeline

export function renderPortfolioTimeline(input: { nav: NavContext; portfolio: PortfolioTimeline }): string {
  const p = input.portfolio;
  const peak = p.activityByWeek.reduce((max, w) => Math.max(max, w.count), 0);
  return renderDocument(
    <AppShell title="Portfolio timeline" nav={input.nav} context="Portfolio history">
      <PageHeader
        title="Portfolio timeline"
        sub="Activity across every project you can see, newest first."
        asOf={
          `${p.totalEvents}${p.filtered ? " filtered" : ""} events across ` +
          `${p.projects} of ${p.projectsAvailable} project${p.projectsAvailable === 1 ? "" : "s"}`
        }
      >
        <a className="btn ghost sm" href="/executive">Executive command center →</a>
      </PageHeader>
      <Notice />
      <SourceCaps caps={p.notes} />

      {p.activityByWeek.length > 0 ? (
        <section className="evi-card">
          <h2>Activity by week</h2>
          <div className="tl-spark">
            {p.activityByWeek.map((w) => (
              <span
                className="tl-spark-bar"
                style={`height:${Math.max(6, Math.round((w.count / Math.max(peak, 1)) * 56))}px`}
                title={`${w.week}: ${w.count} events`}
              />
            ))}
          </div>
          <p className="sub">{p.activityByWeek.length} weeks with recorded activity · peak {String(peak)} events in a week</p>
        </section>
      ) : null}

      {p.entries.map((entry) => (
        <section className="evi-card">
          <h2>
            <a href={`/timeline/project/${entry.projectId}`}>{entry.projectName}</a>{" "}
            {chip(entry.status, entry.status === "ACTIVE" ? "ok" : "neutral")}
          </h2>
          <p className="sub">
            {String(entry.totalEvents)} events · last activity {day(entry.lastEventAt)} ·{" "}
            <a href={`/timeline/site/${entry.projectId}`}>site intelligence</a> ·{" "}
            <a href={`/timeline/story/${entry.projectId}`}>story</a> ·{" "}
            <a href={`/timeline/playback/${entry.projectId}`}>playback</a>
          </p>
          {entry.recent.length > 0 ? (
            <ol className="tl-list">
              {entry.recent.map((e) => <EventRow event={e} projectId={entry.projectId} asOf={e.at} />)}
            </ol>
          ) : (
            <p className="sub">No events match the current filters for this project.</p>
          )}
        </section>
      ))}
    </AppShell>
  );
}
