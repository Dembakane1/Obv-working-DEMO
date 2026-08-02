/**
 * Official Source Connectors views — workspace, review queue, item
 * detail with side-by-side comparison, source detail, lookup, project
 * records, change overview, and raw snapshot preview. Every surface
 * repeats the doctrine notice so no reader mistakes retrieved source
 * data for an OBV determination, and freshness labels never call cached
 * or manual data "live". No secret value ever reaches a view model.
 */
import { h, Fragment, renderDocument } from "./jsx";
import { AppShell, NavContext, PageHeader, enumLabel } from "./components";
import {
  SOURCE_DOCTRINE_NOTICE,
  freshnessLabel,
  ageLabel,
  type OfficialSourceAnalytics,
  type QueueItemDetail,
  type RefreshSummary,
  type SourceRegistryView,
} from "../services/officialSources";
import type { RetrievalOutput } from "../services/officialSources/retrieval";
import type {
  OfficialSource,
  OfficialSourceRecord,
  Project,
  SourceCandidate,
  SourceChangeEvent,
  SourceReviewItem,
  SourceSnapshot,
} from "../../shared/types";

const SEV_TONE: Record<string, string> = { INFO: "neutral", LOW: "warn", MEDIUM: "warn", HIGH: "bad" };
const STATUS_TONE: Record<string, string> = {
  OPEN: "warn", CONFIRMED: "ok", REJECTED: "neutral", DEFERRED: "neutral",
  MANUAL_VERIFICATION: "warn", DISCREPANCY_RECORDED: "warn", PROMOTED: "ok",
  HEALTHY: "ok", MANUAL: "neutral", DOWN: "bad", DEGRADED: "warn", UNKNOWN: "neutral",
  ENABLED: "ok", PAUSED: "neutral", MAINTENANCE: "warn", RETIRED: "neutral",
  EXACT_MATCH: "ok", HIGH_CONFIDENCE_MATCH: "ok", POSSIBLE_MATCH: "warn",
  AMBIGUOUS: "warn", NO_MATCH: "neutral", CONFLICT: "bad",
};

function chip(value: string, toneMap: Record<string, string> = STATUS_TONE) {
  return <span className={`chip ${toneMap[value] ?? "neutral"}`}>{enumLabel(value)}</span>;
}
function sevChip(value: string) {
  return <span className={`chip ${SEV_TONE[value] ?? "neutral"}`}>{value}</span>;
}
function when(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(0, 16) : "—";
}

function DoctrineBanner() {
  return <div className="evi-advisory">{SOURCE_DOCTRINE_NOTICE}</div>;
}

function freshnessFor(view: SourceRegistryView): string {
  return freshnessLabel({
    category: view.source.category,
    health: view.source.health,
    retrievedAt: view.source.lastSuccessAt,
    reviewerConfirmed: false,
  });
}

// ==================================================== workspace

export function renderSourceWorkspace(input: {
  nav: NavContext;
  registry: SourceRegistryView[];
  stats: Record<string, number>;
  analytics: OfficialSourceAnalytics;
  canReview: boolean;
}): string {
  const a = input.analytics;
  return renderDocument(
    <AppShell title="Official Sources" nav={input.nav} context="Official Sources">
      <PageHeader
        title="Official Sources"
        sub="Government and licensing records retrieved as evidence for human review — never as an automatic OBV determination."
      >
        <a className="btn ghost sm" href="/official-sources/queue">Review Queue →</a>
        <a className="btn ghost sm" href="/official-sources/lookup">Lookup →</a>
        <form method="POST" action="/api/official-sources/refresh-portfolio" style="display:inline">
          <button className="btn secondary sm" type="submit" data-busy-label="Refreshing…">Refresh My Portfolio</button>
        </form>
      </PageHeader>
      <DoctrineBanner />

      <section className="evi-stats">
        <div className="evi-stat"><b>{String(input.stats.open ?? 0)}</b><span>Open review items</span>
          <span className="sub">{input.stats.manualVerification ?? 0} awaiting manual verification · {input.stats.deferred ?? 0} deferred</span></div>
        <div className="evi-stat"><b>{`${a.coverage.coveragePct}%`}</b><span>Permit official-record coverage</span>
          <span className="sub">{a.coverage.permitsWithOfficialRecord} of {a.coverage.permits} permits</span></div>
        <div className="evi-stat"><b>{String(a.enforcementAlerts)}</b><span>Enforcement-type alerts</span>
          <span className="sub">stop-work, enforcement, failed inspections</span></div>
        <div className="evi-stat"><b>{String(a.licenseAlerts)}</b><span>License alerts</span>
          <span className="sub">expired / suspended / not found</span></div>
      </section>

      <section className="evi-card">
        <h2>Source registry</h2>
        <p className="sub">Each source is classified by its officially supported access method. Automated retrieval stays off until an official endpoint (and credential, where required) is configured — unconfigured sources fall back to the documented manual portal lookup.</p>
        <table className="evi-table">
          <thead><tr><th>Source</th><th>Agency</th><th>Access method</th><th>Status</th><th>Health</th><th>Freshness</th><th>Configured</th></tr></thead>
          <tbody>
            {input.registry.map((v) => (
              <tr>
                <td><a href={`/official-sources/source/${v.source.id}`}>{v.source.name}</a></td>
                <td>{v.source.agency}</td>
                <td>{chip(v.source.category)}</td>
                <td>{chip(v.source.operationalStatus)}</td>
                <td>{chip(v.source.health)}</td>
                <td>{freshnessFor(v)} · {ageLabel(v.source.lastSuccessAt)}</td>
                <td>
                  {v.source.category === "OFFICIAL_PORTAL_MANUAL"
                    ? "manual workflow"
                    : v.automatedRetrievalAvailable
                    ? "ready"
                    : `needs ${!v.configured.endpoint ? "endpoint" : ""}${!v.configured.endpoint && !v.configured.credential ? " + " : ""}${!v.configured.credential ? "credential" : ""}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="evi-card">
        <h2>Connector health by jurisdiction</h2>
        <div className="evi-catgrid">
          {a.connectorHealth.map((j) => (
            <div className="evi-catpill">
              <b>{j.jurisdiction}</b>
              <span>{j.healthy} healthy · {j.manual} manual · {j.down} down · {j.unknown} unprobed</span>
            </div>
          ))}
        </div>
        {a.projectsWithUnresolvedConflicts.length > 0 ? (
          <div className="evi-dupblock">
            <h2>Projects with unresolved source conflicts</h2>
            <table className="evi-table">
              <thead><tr><th>Project</th><th>Open conflicts / ambiguities</th></tr></thead>
              <tbody>
                {a.projectsWithUnresolvedConflicts.map((p) => (
                  <tr><td><a href={`/official-sources/project/${p.projectId}`}>{p.projectName}</a></td><td>{String(p.open)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

// ==================================================== queue

export function renderSourceQueue(input: {
  nav: NavContext;
  items: SourceReviewItem[];
  activeStatus: string;
  canReview: boolean;
}): string {
  const tab = (status: string, label: string) => (
    <a
      className={`btn ghost sm ${input.activeStatus === status ? "exec-tab-active" : ""}`}
      href={`/official-sources/queue?status=${status}`}
    >{label}</a>
  );
  return renderDocument(
    <AppShell title="Official Source Review Queue" nav={input.nav} context="Official Sources">
      <PageHeader
        title="Official Source Review Queue"
        sub="Retrieved official records waiting for a human decision. Confirming, rejecting, or promoting an item is a reviewer action — the platform never acts on its own."
      >
        <a className="btn ghost sm" href="/official-sources">← Workspace</a>
      </PageHeader>
      <DoctrineBanner />
      <div className="evi-tabs">
        {tab("OPEN", "Open")}{tab("DEFERRED", "Deferred")}{tab("MANUAL_VERIFICATION", "Manual verification")}
        {tab("CONFIRMED", "Confirmed")}{tab("DISCREPANCY_RECORDED", "Discrepancies")}{tab("PROMOTED", "Promoted")}{tab("REJECTED", "Rejected")}
      </div>
      <section className="evi-card">
        {input.items.length === 0 ? (
          <p className="sub">Nothing here — no {enumLabel(input.activeStatus).toLowerCase()} items.</p>
        ) : (
          <table className="evi-table">
            <thead><tr><th>Severity</th><th>Event</th><th>Title</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {input.items.map((i) => (
                <tr>
                  <td>{sevChip(i.severity)}</td>
                  <td>{enumLabel(i.eventKind)}</td>
                  <td><a href={`/official-sources/queue/${i.id}`}>{i.title}</a></td>
                  <td>{chip(i.status)}</td>
                  <td>{when(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AppShell>
  );
}

// ==================================================== queue item detail

function FieldsTable(props: { candidate: SourceCandidate }) {
  const entries = Object.entries(props.candidate.fields);
  return (
    <table className="evi-table">
      <thead><tr><th>Field</th><th>Official (verbatim)</th><th>Normalized</th></tr></thead>
      <tbody>
        {entries.map(([key, f]) => (
          <tr><td>{enumLabel(key)}</td><td>{f.verbatim ?? "—"}</td><td>{f.value ?? "—"}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export function renderSourceQueueItem(input: {
  nav: NavContext;
  detail: QueueItemDetail;
  canReview: boolean;
}): string {
  const { item, candidate, match, change, snapshot, source, obvPermit } = input.detail;
  const actionable = item.status === "OPEN" || item.status === "DEFERRED";
  const act = (action: string, label: string, cls = "btn secondary sm", extra: unknown = null) => (
    <form method="POST" action={`/api/official-sources/queue/${item.id}/${action}`}>
      {extra}
      <input name="note" placeholder="note (optional)" />
      <button className={cls} type="submit">{label}</button>
    </form>
  );
  return renderDocument(
    <AppShell title="Source review item" nav={input.nav} context="Official Sources">
      <PageHeader title={item.title} sub={enumLabel(item.eventKind)}>
        <a className="btn ghost sm" href="/official-sources/queue">← Queue</a>
      </PageHeader>
      <DoctrineBanner />
      <div className="evi-detail-head">
        {sevChip(item.severity)}{chip(item.status)}
        {match ? chip(match.verdict) : null}
        {source ? <span className="chip neutral">{source.agency}</span> : null}
      </div>

      <section className="evi-card">
        <h2>Why this needs review</h2>
        <p>{item.explanation}</p>
        <p className="sub"><b>Suggested action:</b> {item.suggestedAction}</p>
        {item.blockingImplications ? (
          <p className="sub"><b>If promoted:</b> {item.blockingImplications}</p>
        ) : null}
      </section>

      {candidate && obvPermit ? (
        <div className="evi-split">
          <section className="evi-card">
            <h2>OBV record (authoritative)</h2>
            <table className="evi-table"><tbody>
              <tr><td>Permit number</td><td>{obvPermit.permitNumber}</td></tr>
              <tr><td>Type</td><td>{obvPermit.permitType}</td></tr>
              <tr><td>Status</td><td>{obvPermit.status}</td></tr>
              <tr><td>Issued</td><td>{obvPermit.issuedAt ?? "—"}</td></tr>
              <tr><td>Expires</td><td>{obvPermit.expiresAt ?? "—"}</td></tr>
              <tr><td>Authority</td><td>{obvPermit.issuingAuthority ?? "—"}</td></tr>
            </tbody></table>
          </section>
          <section className="evi-card">
            <h2>Official source record (retrieved)</h2>
            <FieldsTable candidate={candidate} />
            <p className="sub">Retrieved {when(candidate.createdAt)} · external id {candidate.externalId}
              {snapshot ? <> · <a href={`/official-sources/snapshot/${snapshot.id}`}>raw snapshot</a></> : null}</p>
          </section>
        </div>
      ) : candidate ? (
        <section className="evi-card">
          <h2>Official source record (retrieved)</h2>
          <FieldsTable candidate={candidate} />
          <p className="sub">Retrieved {when(candidate.createdAt)} · external id {candidate.externalId}
            {snapshot ? <> · <a href={`/official-sources/snapshot/${snapshot.id}`}>raw snapshot</a></> : null}</p>
        </section>
      ) : null}

      {match ? (
        <section className="evi-card">
          <h2>Match explanation</h2>
          <p className="sub">Verdict {enumLabel(match.verdict)} · confidence {(match.confidence * 100).toFixed(0)}% · reasons: {match.reasonCodes.join(", ") || "—"}</p>
          <table className="evi-table">
            <thead><tr><th>Field compared</th><th>Official</th><th>OBV</th><th>Result</th></tr></thead>
            <tbody>
              {(match.fieldsCompared as Array<{ field: string; candidate: string | null; obv: string | null; matched: boolean | null }>).map((c) => (
                <tr>
                  <td>{enumLabel(c.field)}</td><td>{c.candidate ?? "—"}</td><td>{c.obv ?? "—"}</td>
                  <td>{c.matched === true ? "match" : c.matched === false ? "DIFFERS" : "not comparable"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sub">{match.recommendation}</p>
        </section>
      ) : null}

      {change ? (
        <section className="evi-card">
          <h2>What changed at the source</h2>
          <p>{change.explanation}</p>
          <table className="evi-table">
            <thead><tr><th>Field</th><th>Previous</th><th>Current</th></tr></thead>
            <tbody>
              {change.changedFields.map((f) => (
                <tr><td>{f.field}</td><td>{f.previous ?? "—"}</td><td>{f.current ?? "—"}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {input.canReview && actionable ? (
        <section className="evi-card">
          <h2>Reviewer decision</h2>
          <p className="sub">Confirming attaches the record through the governed permits command; a discrepancy records a source verification through the governed DMV command; promotion opens a governed exception. Basis corrections and inspection results stay in the existing DMV compliance screens.</p>
          <div className="evi-actions">
            {act("confirm", "Confirm & attach")}
            {act("reject", "Reject match", "btn ghost sm")}
            {act("defer", "Defer", "btn ghost sm")}
            {act("manual", "Needs manual verification", "btn ghost sm")}
            {act("discrepancy", "Record discrepancy", "btn ghost sm",
              <input name="summary" placeholder="what disagrees (required)" />)}
            {act("promote", "Promote to exception", "btn sm")}
          </div>
        </section>
      ) : !actionable ? (
        <section className="evi-card">
          <h2>Resolution</h2>
          <p className="sub">{enumLabel(item.status)} {item.resolvedAt ? `at ${when(item.resolvedAt)}` : ""}{item.resolutionNote ? ` — ${item.resolutionNote}` : ""}</p>
        </section>
      ) : null}

      <section className="evi-card">
        <h2>History</h2>
        <ol className="evi-timeline">
          {input.detail.events.map((e) => (
            <li className="evi-tl-item"><div className="evi-tl-body">
              <b>{enumLabel(e.kind)}</b>
              <span className="sub">{when(e.occurredAt)}{e.detail ? ` — ${e.detail}` : ""}</span>
            </div></li>
          ))}
        </ol>
      </section>
    </AppShell>
  );
}

// ==================================================== source detail

export function renderSourceDetail(input: {
  nav: NavContext;
  view: SourceRegistryView;
  canReview: boolean;
}): string {
  const { source, pollState, configured } = input.view;
  return renderDocument(
    <AppShell title={source.name} nav={input.nav} context="Official Sources">
      <PageHeader title={source.name} sub={`${source.jurisdiction} · ${source.agency}`}>
        <a className="btn ghost sm" href="/official-sources">← Workspace</a>
        <form method="POST" action={`/api/official-sources/source/${source.id}/health`} style="display:inline">
          <button className="btn ghost sm" type="submit">Run health check</button>
        </form>
        <form method="POST" action={`/api/official-sources/source/${source.id}/refresh`} style="display:inline">
          <button className="btn secondary sm" type="submit" data-busy-label="Refreshing…">Refresh now</button>
        </form>
      </PageHeader>
      <DoctrineBanner />
      <div className="evi-detail-head">
        {chip(source.category)}{chip(source.operationalStatus)}{chip(source.health)}
        <span className="chip neutral">{freshnessFor(input.view)}</span>
      </div>

      <div className="evi-split">
        <section className="evi-card">
          <h2>Definition</h2>
          <table className="evi-table"><tbody>
            <tr><td>Record types</td><td>{source.recordTypes.map(enumLabel).join(", ")}</td></tr>
            <tr><td>Official base URL</td><td>{source.baseUrl ?? "—"}</td></tr>
            <tr><td>Documentation</td><td>{source.docsUrl ?? "—"}</td></tr>
            <tr><td>Update frequency</td><td>{source.expectedUpdateFrequency ?? "—"}</td></tr>
            <tr><td>Timezone</td><td>{source.sourceTimezone}</td></tr>
            <tr><td>Schema / connector</td><td>{source.schemaVersion} / {source.connectorVersion}</td></tr>
            <tr><td>Rate limit</td><td>{source.rateLimitPerMinute ? `${source.rateLimitPerMinute}/min (client-side cap)` : "—"}</td></tr>
            <tr><td>Allowed hosts</td><td>{source.allowedHosts.join(", ") || "none (no automated egress)"}</td></tr>
          </tbody></table>
          {source.termsNotes ? <p className="sub">{source.termsNotes}</p> : null}
        </section>
        <section className="evi-card">
          <h2>Configuration & operations</h2>
          <table className="evi-table"><tbody>
            <tr><td>Endpoint configured</td><td>{configured.endpoint ? "yes" : "no — set the documented dataset/API URL"}</td></tr>
            <tr><td>Credential</td><td>
              {source.authType === "NONE" ? "not required" : configured.credential
                ? `set (${source.credentialEnv})`
                : `missing — set ${source.credentialEnv ?? "the credential env"}`}
            </td></tr>
            <tr><td>Last success</td><td>{when(source.lastSuccessAt)} ({ageLabel(source.lastSuccessAt)})</td></tr>
            <tr><td>Last failure</td><td>{when(source.lastFailureAt)}{source.lastFailureReason ? ` — ${source.lastFailureReason}` : ""}</td></tr>
            <tr><td>Cursor</td><td>{pollState?.cursor ?? "—"}</td></tr>
            <tr><td>Consecutive failures</td><td>{String(pollState?.consecutiveFailures ?? 0)}</td></tr>
            <tr><td>Circuit</td><td>{pollState?.circuitOpenUntil ? `open until ${when(pollState.circuitOpenUntil)}` : "closed"}</td></tr>
            <tr><td>Polling paused</td><td>{pollState?.paused ? "yes" : "no"}</td></tr>
          </tbody></table>
          {input.canReview ? (
            <div className="evi-actions">
              <form method="POST" action={`/api/official-sources/source/${source.id}/${pollState?.paused ? "resume" : "pause"}`}>
                <button className="btn ghost sm" type="submit">{pollState?.paused ? "Resume polling" : "Pause polling"}</button>
              </form>
            </div>
          ) : null}
          <p className="sub">Credential values are never stored or displayed — only the environment variable name and whether it is set.</p>
        </section>
      </div>
    </AppShell>
  );
}

// ==================================================== lookup

export function renderSourceLookup(input: {
  nav: NavContext;
  registry: SourceRegistryView[];
  query: Record<string, string>;
  results: RetrievalOutput | null;
}): string {
  return renderDocument(
    <AppShell title="Official source lookup" nav={input.nav} context="Official Sources">
      <PageHeader
        title="Permit, license & record lookup"
        sub="Search an official source directly. Every search stores an immutable raw snapshot; results feed the review queue when they match your records."
      >
        <a className="btn ghost sm" href="/official-sources">← Workspace</a>
      </PageHeader>
      <DoctrineBanner />

      <section className="evi-card">
        <form method="POST" action="/official-sources/lookup" className="osrc-lookup">
          <select name="sourceId">
            {input.registry.map((v) => (
              <option value={v.source.id} selected={input.query.sourceId === v.source.id}>
                {v.source.name}
              </option>
            ))}
          </select>
          <input name="permitNumber" placeholder="permit / license number" value={input.query.permitNumber ?? ""} />
          <input name="address" placeholder="address" value={input.query.address ?? ""} />
          <input name="party" placeholder="contractor / business name" value={input.query.party ?? ""} />
          <input name="projectId" placeholder="project id (optional scope)" value={input.query.projectId ?? ""} />
          <button className="btn secondary sm" type="submit" data-busy-label="Searching…">Search official source</button>
        </form>
      </section>

      {input.results ? (
        <section className="evi-card">
          <h2>Result — {enumLabel(input.results.kind)}</h2>
          {input.results.kind === "MANUAL_VERIFICATION_REQUIRED" || input.results.kind === "NOT_CONFIGURED" ? (
            <p>{input.results.manualInstructions}</p>
          ) : input.results.kind === "SOURCE_UNAVAILABLE" ? (
            <p>Source temporarily unavailable — {input.results.errorLabel}. The attempt was recorded as a snapshot; try again later or use the official portal.</p>
          ) : input.results.candidates.length === 0 ? (
            <p className="sub">The source returned no records for this search. The empty result was recorded as a snapshot.</p>
          ) : (
            <table className="evi-table">
              <thead><tr><th>External id</th><th>Type</th><th>Status (verbatim)</th><th>Number</th><th>Address</th><th>Party</th><th>Snapshot</th></tr></thead>
              <tbody>
                {input.results.candidates.map((c) => (
                  <tr>
                    <td>{c.externalId}</td>
                    <td>{enumLabel(c.recordType)}</td>
                    <td>{c.verbatimStatus ?? "—"}</td>
                    <td>{c.permitNumber ?? "—"}</td>
                    <td>{c.address ?? "—"}</td>
                    <td>{c.partyName ?? "—"}</td>
                    <td><a href={`/official-sources/snapshot/${c.snapshotId}`}>raw</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}
    </AppShell>
  );
}

// ==================================================== project records

export function renderProjectSources(input: {
  nav: NavContext;
  records: {
    project: Project;
    candidates: SourceCandidate[];
    changes: SourceChangeEvent[];
    attachedRecords: OfficialSourceRecord[];
  };
  registry: SourceRegistryView[];
}): string {
  const r = input.records;
  return renderDocument(
    <AppShell title="Project official sources" nav={input.nav} context="Official Sources">
      <PageHeader title={r.project.name} sub="Official-source records retrieved for this project, and the source references reviewers have attached.">
        <a className="btn ghost sm" href="/official-sources">← Workspace</a>
        <form method="POST" action="/api/official-sources/refresh-project" style="display:inline">
          <input type="hidden" name="projectId" value={r.project.id} />
          <button className="btn secondary sm" type="submit" data-busy-label="Refreshing…">Refresh this project</button>
        </form>
      </PageHeader>
      <DoctrineBanner />

      <section className="evi-card">
        <h2>Attached official source references ({String(r.attachedRecords.length)})</h2>
        {r.attachedRecords.length === 0 ? (
          <p className="sub">No confirmed source references yet — confirm queue items to attach them through the governed permits command.</p>
        ) : (
          <table className="evi-table">
            <thead><tr><th>System</th><th>Record #</th><th>Official status</th><th>Lookup</th><th>Provenance</th></tr></thead>
            <tbody>
              {r.attachedRecords.map((rec) => (
                <tr>
                  <td>{rec.officialSystemName ?? "—"}</td>
                  <td>{rec.officialRecordNumber ?? "—"}</td>
                  <td>{rec.officialStatusText ?? "—"}</td>
                  <td>{when(rec.lookupPerformedAt)}</td>
                  <td>{enumLabel(rec.sourceType)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="evi-card">
        <h2>Retrieved candidates ({String(r.candidates.length)})</h2>
        {r.candidates.length === 0 ? <p className="sub">No retrieved records yet — run a refresh.</p> : (
          <table className="evi-table">
            <thead><tr><th>External id</th><th>Type</th><th>Status (verbatim)</th><th>Number</th><th>Retrieved</th><th>Snapshot</th></tr></thead>
            <tbody>
              {r.candidates.map((c) => (
                <tr>
                  <td>{c.externalId}</td><td>{enumLabel(c.recordType)}</td>
                  <td>{c.verbatimStatus ?? "—"}</td><td>{c.permitNumber ?? "—"}</td>
                  <td>{when(c.createdAt)}</td>
                  <td><a href={`/official-sources/snapshot/${c.snapshotId}`}>raw</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="evi-card">
        <h2>Detected changes ({String(r.changes.length)})</h2>
        {r.changes.length === 0 ? <p className="sub">No source changes detected.</p> : (
          <table className="evi-table">
            <thead><tr><th>Severity</th><th>Record</th><th>Change</th><th>Detected</th></tr></thead>
            <tbody>
              {r.changes.map((c) => (
                <tr>
                  <td>{sevChip(c.severity)}</td>
                  <td>{c.externalId}</td>
                  <td>{c.explanation}</td>
                  <td>{when(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AppShell>
  );
}

// ==================================================== changes overview

export function renderSourceChanges(input: {
  nav: NavContext;
  analytics: OfficialSourceAnalytics;
  items: SourceReviewItem[];
}): string {
  return renderDocument(
    <AppShell title="Source change history" nav={input.nav} context="Official Sources">
      <PageHeader title="Change history & alerts" sub="Deterministic diffs between successive official-source snapshots across your accessible projects.">
        <a className="btn ghost sm" href="/official-sources">← Workspace</a>
      </PageHeader>
      <DoctrineBanner />
      <section className="evi-stats">
        <div className="evi-stat"><b>{String(input.analytics.enforcementAlerts)}</b><span>Enforcement-type alerts</span></div>
        <div className="evi-stat"><b>{String(input.analytics.licenseAlerts)}</b><span>License alerts</span></div>
        <div className="evi-stat"><b>{input.analytics.averageResolutionHours === null ? "—" : `${input.analytics.averageResolutionHours}h`}</b><span>Avg. time to reviewer resolution</span></div>
      </section>
      <section className="evi-card">
        <h2>Recent review items</h2>
        <table className="evi-table">
          <thead><tr><th>Severity</th><th>Event</th><th>Title</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {input.items.slice(0, 50).map((i) => (
              <tr>
                <td>{sevChip(i.severity)}</td>
                <td>{enumLabel(i.eventKind)}</td>
                <td><a href={`/official-sources/queue/${i.id}`}>{i.title}</a></td>
                <td>{chip(i.status)}</td>
                <td>{when(i.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}

// ==================================================== snapshot preview

export function renderSnapshotPreview(input: {
  nav: NavContext;
  snapshot: SourceSnapshot;
  source: OfficialSource | null;
  candidates: SourceCandidate[];
}): string {
  const s = input.snapshot;
  const payload = s.payload ?? "(payload stored on disk — see payload path)";
  const pretty = (() => {
    try { return JSON.stringify(JSON.parse(payload), null, 2); } catch { return payload; }
  })();
  return renderDocument(
    <AppShell title="Raw source snapshot" nav={input.nav} context="Official Sources">
      <PageHeader title={`Snapshot ${s.id.slice(0, 8)}`} sub="The immutable raw retrieval record — exactly what the source returned, hashed for provenance.">
        <a className="btn ghost sm" href="/official-sources">← Workspace</a>
      </PageHeader>
      <DoctrineBanner />
      <section className="evi-card">
        <table className="evi-table"><tbody>
          <tr><td>Source</td><td>{input.source ? input.source.name : s.sourceId}</td></tr>
          <tr><td>Request</td><td>{s.requestType} · outcome {s.outcome}</td></tr>
          <tr><td>Retrieved</td><td>{when(s.retrievedAt)}</td></tr>
          <tr><td>Source-reported update</td><td>{when(s.sourceUpdatedAt)}</td></tr>
          <tr><td>HTTP</td><td>{s.httpStatus === null ? "—" : String(s.httpStatus)} · {s.contentType ?? "—"}</td></tr>
          <tr><td>SHA-256</td><td>{s.payloadSha256}</td></tr>
          <tr><td>Connector</td><td>{s.connectorVersion}</td></tr>
          <tr><td>Derived candidates</td><td>{String(input.candidates.length)}</td></tr>
        </tbody></table>
      </section>
      <section className="evi-card">
        <h2>Raw payload</h2>
        <pre className="evi-pre">{pretty.slice(0, 20000)}</pre>
        {pretty.length > 20000 ? <p className="sub">Truncated for display — the stored snapshot is complete.</p> : null}
      </section>
    </AppShell>
  );
}
