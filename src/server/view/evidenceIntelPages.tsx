/**
 * Evidence Intelligence views — dashboard, review queue, finding detail,
 * duplicate / side-by-side viewer, metadata + OCR panels, analytics, and
 * the unified evidence timeline. Every advisory is explained in plain
 * language, and every surface repeats the advisory-only notice so no
 * reader mistakes a finding for a control decision.
 */
import { h, Fragment, renderDocument } from "./jsx";
import { AppShell, NavContext, PageHeader, enumLabel } from "./components";
import { ADVISORY_NOTICE } from "../services/evidenceIntel";
import type {
  EvidenceItem,
  EvidenceMetadataFacts,
  EvidenceReviewItem,
  EvidenceSignal,
} from "../../shared/types";
import type { EvidenceIntelDashboard } from "../services/evidenceIntel/dashboard";
import type { EvidenceAnalytics } from "../services/evidenceIntel/analytics";
import type { TimelineEntry } from "../services/evidenceIntel/review";
import type { EvidenceScore } from "../services/evidenceIntel/scoring";

const SEV_TONE: Record<string, string> = { INFO: "neutral", LOW: "warn", MEDIUM: "warn", HIGH: "bad" };
const STATUS_TONE: Record<string, string> = {
  OPEN: "warn", ACKNOWLEDGED: "neutral", DISMISSED: "neutral", PROMOTED: "ok",
  ACTIVE: "ok", DISABLED_BOUNDARY: "neutral", RUNNING: "warn", COMPLETED: "ok", FAILED: "bad",
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

function AdvisoryBanner(props: { note: string }) {
  return <div className="evi-advisory">{props.note}</div>;
}

// ==================================================== dashboard

export function renderEvidenceIntelDashboard(input: {
  nav: NavContext;
  dashboard: EvidenceIntelDashboard;
  canReview: boolean;
}): string {
  const d = input.dashboard;
  return renderDocument(
    <AppShell title="Evidence Intelligence" nav={input.nav} context="Evidence Intelligence">
      <PageHeader
        title="Evidence Intelligence"
        sub="Explainable, advisory analysis of the evidence you already hold — completeness, consistency, duplicates, and what deserves a closer human look."
      >
        <a className="btn ghost sm" href="/evidence-intelligence/queue">Review Queue →</a>
        <a className="btn ghost sm" href="/evidence-intelligence/analytics">Analytics →</a>
        <form method="POST" action="/api/evidence-intel/analyze" style="display:inline">
          <button className="btn secondary sm" type="submit">Analyze My Evidence</button>
        </form>
      </PageHeader>
      <AdvisoryBanner note={d.advisoryNotice} />

      <section className="evi-stats">
        <div className="evi-stat"><b>{String(d.signals.total)}</b><span>Advisory findings</span>
          <span className="sub">{d.signals.bySeverity.HIGH} high · {d.signals.bySeverity.MEDIUM} medium · {d.signals.bySeverity.LOW} low · {d.signals.bySeverity.INFO} info</span></div>
        <div className="evi-stat"><b>{String(d.queue.open)}</b><span>Open in review queue</span>
          <span className="sub">{d.queue.acknowledged} acknowledged · {d.queue.promoted} promoted · {d.queue.dismissed} dismissed</span></div>
        <div className="evi-stat"><b>{String(d.recentRuns.length)}</b><span>Recent analysis runs</span>
          <span className="sub">{d.recentRuns[0] ? `last ${when(d.recentRuns[0].startedAt)}` : "not yet run"}</span></div>
        <div className="evi-stat"><b>{d.futureAi.enabled ? "On" : "Off"}</b><span>Future AI engines</span>
          <span className="sub">{d.futureAi.catalog.length} capabilities, all disabled</span></div>
      </section>

      <section className="evi-card">
        <h2>Analysis providers</h2>
        <table className="evi-table">
          <thead><tr><th>Capability</th><th>Provider</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>
            {d.providers.map((p) => (
              <tr><td>{enumLabel(p.category)}</td><td><b>{p.name}</b></td><td>{chip(p.status)}</td><td className="sub">{p.detail}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="evi-card">
        <h2>Finding categories</h2>
        {d.signals.byCategory.length === 0 ? (
          <p className="sub">No findings yet. Run analysis to derive advisory findings from your evidence and documents.</p>
        ) : (
          <div className="evi-catgrid">
            {d.signals.byCategory.map((c) => (
              <div className="evi-catpill"><b>{String(c.count)}</b><span>{enumLabel(c.category)}</span></div>
            ))}
          </div>
        )}
      </section>

      <section className="evi-card">
        <h2>Recent advisory findings</h2>
        <table className="evi-table">
          <thead><tr><th>When</th><th>Finding</th><th>Severity</th><th>Confidence</th><th>Subject</th></tr></thead>
          <tbody>
            {d.recentSignals.length === 0 ? (
              <tr><td colspan="5" className="sub">Nothing yet.</td></tr>
            ) : d.recentSignals.map((s) => (
              <tr>
                <td>{when(s.occurredAt)}</td>
                <td><b>{s.title}</b></td>
                <td>{sevChip(s.severity)}</td>
                <td>{Math.round(s.confidence * 100)}%</td>
                <td className="sub">
                  {s.subjectType === "EVIDENCE_ITEM"
                    ? <a href={`/evidence-intelligence/evidence/${s.subjectId}`}>evidence</a>
                    : enumLabel(s.subjectType)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}

// ==================================================== review queue

export function renderEvidenceReviewQueue(input: {
  nav: NavContext;
  items: EvidenceReviewItem[];
  activeStatus: string;
  canReview: boolean;
}): string {
  const tab = (status: string, label: string) => (
    <a className={`btn ${input.activeStatus === status ? "secondary" : "ghost"} sm`} href={`/evidence-intelligence/queue?status=${status}`}>{label}</a>
  );
  return renderDocument(
    <AppShell title="Evidence Review Queue" nav={input.nav} context="Evidence Intelligence">
      <PageHeader title="Evidence Review Queue" sub="Advisory findings a reviewer should look at. Acknowledging, dismissing, or promoting a finding is a reviewer decision — the platform never acts on your behalf.">
        <a className="btn ghost sm" href="/evidence-intelligence">← Dashboard</a>
      </PageHeader>
      <AdvisoryBanner note={ADVISORY_NOTICE} />
      <div className="evi-tabs">{tab("OPEN", "Open")}{tab("ACKNOWLEDGED", "Acknowledged")}{tab("PROMOTED", "Promoted")}{tab("DISMISSED", "Dismissed")}</div>
      <section className="evi-card">
        <table className="evi-table">
          <thead><tr><th>Created</th><th>Severity</th><th>Confidence</th><th>Recommendation</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {input.items.length === 0 ? (
              <tr><td colspan="6" className="sub">No {input.activeStatus.toLowerCase()} findings.</td></tr>
            ) : input.items.map((i) => (
              <tr>
                <td>{when(i.createdAt)}</td>
                <td>{sevChip(i.severity)}</td>
                <td>{Math.round(i.confidence * 100)}%</td>
                <td className="sub">{i.recommendation}</td>
                <td>{chip(i.status)}</td>
                <td><a className="btn ghost sm" href={`/evidence-intelligence/queue/${i.id}`}>Open</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}

// ==================================================== finding detail

export function renderReviewItemDetail(input: {
  nav: NavContext;
  item: EvidenceReviewItem;
  signal: EvidenceSignal | null;
  events: Array<{ occurredAt: string; kind: string; detail: string | null }>;
  canReview: boolean;
}): string {
  const { item, signal } = input;
  const acting = item.status === "OPEN" || item.status === "ACKNOWLEDGED";
  const comparison = signal?.comparison ? JSON.stringify(signal.comparison, null, 2) : null;
  return renderDocument(
    <AppShell title="Advisory finding" nav={input.nav} context="Evidence Intelligence">
      <PageHeader title={signal?.title ?? "Advisory finding"} sub={signal ? enumLabel(signal.category) : ""}>
        <a className="btn ghost sm" href="/evidence-intelligence/queue">← Queue</a>
      </PageHeader>
      <AdvisoryBanner note={ADVISORY_NOTICE} />
      <div className="evi-detail-head">
        {signal ? sevChip(signal.severity) : null}
        {chip(item.status)}
        {signal ? <span className="chip neutral">{Math.round(signal.confidence * 100)}% confidence</span> : null}
        {item.promotedExceptionId ? <span className="chip ok">Promoted → exception</span> : null}
      </div>

      {signal ? (
        <Fragment>
          <section className="evi-card">
            <h2>Why this was generated</h2>
            <p>{signal.explanation}</p>
          </section>
          <section className="evi-card">
            <h2>Recommended reviewer action</h2>
            <p>{signal.recommendation}</p>
            <p className="sub">This is a recommendation, not an instruction the system will carry out.</p>
          </section>
          {comparison ? (
            <section className="evi-card">
              <h2>What was compared</h2>
              <pre className="evi-pre">{comparison}</pre>
            </section>
          ) : null}
        </Fragment>
      ) : (
        <section className="evi-card"><p className="sub">The underlying finding could not be loaded.</p></section>
      )}

      {input.canReview && acting ? (
        <section className="evi-card">
          <h2>Reviewer decision</h2>
          <p className="sub">Promoting creates a governed exception through the normal exceptions workflow, subject to your existing authorization. Nothing else changes.</p>
          <div className="evi-actions">
            {item.status === "OPEN" ? (
              <form method="POST" action={`/api/evidence-intel/queue/${item.id}/acknowledge`}>
                <input name="note" placeholder="Optional note" />
                <button className="btn ghost sm" type="submit">Acknowledge</button>
              </form>
            ) : null}
            <form method="POST" action={`/api/evidence-intel/queue/${item.id}/promote`}>
              <input name="note" placeholder="Optional note" />
              <button className="btn secondary sm" type="submit">Promote to Exception</button>
            </form>
            <form method="POST" action={`/api/evidence-intel/queue/${item.id}/dismiss`}>
              <input name="note" placeholder="Optional note" />
              <button className="btn ghost sm" type="submit">Dismiss</button>
            </form>
          </div>
        </section>
      ) : null}

      <section className="evi-card">
        <h2>Review history</h2>
        <table className="evi-table">
          <thead><tr><th>When</th><th>Action</th><th>Note</th></tr></thead>
          <tbody>
            {input.events.map((e) => (
              <tr><td>{when(e.occurredAt)}</td><td>{enumLabel(e.kind)}</td><td className="sub">{e.detail ?? "—"}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}

// ==================================================== duplicate / evidence viewer

export function renderDuplicateViewer(input: {
  nav: NavContext;
  evidence: EvidenceItem;
  signals: EvidenceSignal[];
  metadata: EvidenceMetadataFacts | null;
  score: { quality: number; confidence: number; hasGps: boolean };
  twinHref?: string | null;
}): string {
  const { evidence, metadata, score } = input;
  const dupSignals = input.signals.filter((s) => s.category.includes("DUPLICATE") || s.category.includes("CROSS"));
  return renderDocument(
    <AppShell title="Evidence viewer" nav={input.nav} context="Evidence Intelligence">
      <PageHeader title="Evidence viewer" sub="Metadata, quality, and any advisory findings for one evidence item. Everything shown is derived — the evidence record itself is unchanged.">
        <a className="btn ghost sm" href={`/evidence-intelligence/timeline/${evidence.id}`}>Timeline →</a>
        {input.twinHref ? <a className="btn ghost sm" href={input.twinHref}>View in Digital Twin →</a> : null}
        <a className="btn ghost sm" href="/evidence-intelligence">← Dashboard</a>
      </PageHeader>
      <AdvisoryBanner note={ADVISORY_NOTICE} />

      <section className="evi-summary">
        <div className="evi-stat evi-stat-ring">
          <span
            className={`ring ring-sm`}
            data-value={String(score.quality)}
            style={`--ring-pct:${Math.max(0, Math.min(100, score.quality))};--ring-color:${score.quality >= 70 ? "var(--ok)" : score.quality >= 40 ? "var(--warn)" : "var(--bad)"}`}
            role="img"
            aria-label={`Evidence quality ${score.quality} of 100`}
          ></span>
          <span>Quality</span>
        </div>
        <div className="evi-stat evi-stat-ring">
          <span
            className={`ring ring-sm`}
            data-value={`${score.confidence}%`}
            style={`--ring-pct:${Math.max(0, Math.min(100, score.confidence))};--ring-color:${score.confidence >= 70 ? "var(--ok)" : score.confidence >= 40 ? "var(--warn)" : "var(--bad)"}`}
            role="img"
            aria-label={`Verification confidence ${score.confidence} percent`}
          ></span>
          <span>Verification confidence</span>
        </div>
        <div className="evi-stat"><b>{score.hasGps ? "Yes" : "No"}</b><span>GPS present</span></div>
        <div className="evi-stat"><b>{String(input.signals.length)}</b><span>Advisory findings</span></div>
      </section>

      <div className="evi-split">
        <section className="evi-card">
          <h2>Evidence</h2>
          <img className="evi-photo" src={evidence.photoPath} alt="evidence" />
          <p className="sub">Content hash: <code>{evidence.hash.slice(0, 24)}…</code></p>
        </section>
        <section className="evi-card">
          <h2>Metadata panel</h2>
          <table className="evi-table">
            <tbody>
              <tr><td>Captured</td><td>{when(metadata?.capturedAt ?? evidence.capturedAt)}</td></tr>
              <tr><td>Uploaded</td><td>{when(metadata?.uploadedAt ?? evidence.uploadedAt)}</td></tr>
              <tr><td>Upload delay</td><td>{metadata?.uploadDelaySeconds != null ? `${metadata.uploadDelaySeconds}s` : "—"}</td></tr>
              <tr><td>GPS</td><td>{metadata?.hasGps ? `${metadata.latitude?.toFixed(5)}, ${metadata.longitude?.toFixed(5)}` : "not available"}</td></tr>
              <tr><td>MIME type</td><td>{metadata?.mimeType ?? "not available"}</td></tr>
              <tr><td>Dimensions</td><td>{metadata?.width && metadata?.height ? `${metadata.width}×${metadata.height}` : "not available"}</td></tr>
              <tr><td>Device fingerprint</td><td className="sub">{metadata?.deviceFingerprint ? metadata.deviceFingerprint.slice(0, 16) + "…" : "—"}</td></tr>
            </tbody>
          </table>
          <p className="sub">"Not available" is a completeness note, not a problem — missing metadata is never treated as fraud.</p>
        </section>
      </div>

      {dupSignals.length > 0 ? (
        <section className="evi-card">
          <h2>Duplicate comparison</h2>
          <p className="sub">Records with the same content that a reviewer should compare side by side.</p>
          {dupSignals.map((s) => (
            <div className="evi-dupblock">
              <div className="evi-detail-head">{sevChip(s.severity)}<b>{s.title}</b></div>
              <p className="sub">{s.explanation}</p>
              <p className="sub">Recommended: {s.recommendation}</p>
            </div>
          ))}
        </section>
      ) : null}

      <section className="evi-card">
        <h2>All advisory findings</h2>
        {input.signals.length === 0 ? <p className="sub">No findings for this item.</p> : (
          <table className="evi-table">
            <thead><tr><th>Finding</th><th>Severity</th><th>Confidence</th><th>Recommendation</th></tr></thead>
            <tbody>
              {input.signals.map((s) => (
                <tr><td><b>{s.title}</b><span className="sub" style="display:block">{enumLabel(s.category)}</span></td><td>{sevChip(s.severity)}</td><td>{Math.round(s.confidence * 100)}%</td><td className="sub">{s.recommendation}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AppShell>
  );
}

// ==================================================== timeline

export function renderEvidenceTimeline(input: {
  nav: NavContext;
  evidence: EvidenceItem;
  entries: TimelineEntry[];
}): string {
  const KIND_TONE: Record<string, string> = { UPLOAD: "neutral", REVIEW: "warn", LEDGER: "ok", DRAW: "neutral", ADVISORY: "warn" };
  return renderDocument(
    <AppShell title="Evidence timeline" nav={input.nav} context="Evidence Intelligence">
      <PageHeader title="Evidence timeline" sub="Every recorded moment for this evidence item, in order — capture, verification, ledger, draw references, and advisory review activity.">
        <a className="btn ghost sm" href={`/evidence-intelligence/evidence/${input.evidence.id}`}>← Evidence viewer</a>
      </PageHeader>
      <AdvisoryBanner note={ADVISORY_NOTICE} />
      <section className="evi-card">
        <ol className="evi-timeline">
          {input.entries.length === 0 ? <li className="sub">No timeline entries.</li> : input.entries.map((e) => (
            <li className="evi-tl-item">
              <span className={`chip ${KIND_TONE[e.kind] ?? "neutral"}`}>{e.kind}</span>
              <div className="evi-tl-body">
                <b>{e.label}</b>
                <span className="sub">{when(e.at)}{e.detail ? ` · ${e.detail}` : ""}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </AppShell>
  );
}

// ==================================================== analytics

export function renderEvidenceAnalytics(input: { nav: NavContext; analytics: EvidenceAnalytics }): string {
  const a = input.analytics;
  return renderDocument(
    <AppShell title="Evidence analytics" nav={input.nav} context="Evidence Intelligence">
      <PageHeader title="Evidence analytics" sub="Portfolio-wide evidence quality, completeness, duplicate trends, and reviewer workload — derived on read, advisory only.">
        <a className="btn ghost sm" href="/evidence-intelligence">← Dashboard</a>
      </PageHeader>
      <AdvisoryBanner note={a.advisoryNotice} />
      <section className="evi-stats">
        <div className="evi-stat"><b>{String(a.averageCompleteness)}%</b><span>Avg documentation completeness</span></div>
        <div className="evi-stat"><b>{String(a.averageQuality)}</b><span>Avg evidence quality</span></div>
        <div className="evi-stat"><b>{String(a.averageConfidence)}%</b><span>Avg confidence</span></div>
        <div className="evi-stat"><b>{String(a.reviewerWorkload.total)}</b><span>Review queue items</span>
          <span className="sub">{a.reviewerWorkload.open} open · {a.reviewerWorkload.promoted} promoted</span></div>
      </section>

      <section className="evi-card">
        <h2>Documentation completeness by project</h2>
        <table className="evi-table">
          <thead><tr><th>Project</th><th>Completeness</th><th>Quality</th><th>Confidence</th></tr></thead>
          <tbody>
            {a.documentationCompleteness.map((p) => (
              <tr><td><b>{p.projectName}</b></td><td>{p.completeness}%</td><td>{p.quality}</td><td>{p.confidence}%</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="evi-card">
        <h2>Contractor evidence quality</h2>
        <p className="sub">Evidence quality and advisory-finding volume by contractor. This is a documentation-quality aid — never a judgement about a contractor's integrity.</p>
        <table className="evi-table">
          <thead><tr><th>Contractor</th><th>Projects</th><th>Avg quality</th><th>Advisory findings</th></tr></thead>
          <tbody>
            {a.contractorQuality.map((c) => (
              <tr><td><b>{c.contractor}</b></td><td>{c.projects}</td><td>{c.averageQuality}</td><td>{c.advisoryFindings}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="evi-split">
        <section className="evi-card">
          <h2>Duplicate evidence trend</h2>
          {a.duplicateTrend.length === 0 ? <p className="sub">No duplicate findings.</p> : (
            <table className="evi-table"><thead><tr><th>Week</th><th>Duplicate findings</th></tr></thead>
              <tbody>{a.duplicateTrend.map((t) => <tr><td>{t.week}</td><td>{t.count}</td></tr>)}</tbody></table>
          )}
        </section>
        <section className="evi-card">
          <h2>Repeated advisory findings</h2>
          {a.repeatedFindings.length === 0 ? <p className="sub">No category repeats yet.</p> : (
            <table className="evi-table"><thead><tr><th>Category</th><th>Count</th></tr></thead>
              <tbody>{a.repeatedFindings.map((r) => <tr><td>{enumLabel(r.category)}</td><td>{r.count}</td></tr>)}</tbody></table>
          )}
        </section>
      </section>
    </AppShell>
  );
}
