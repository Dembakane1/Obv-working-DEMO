/**
 * OBV Control Intelligence — institutional construction-control views.
 *
 * READ-ONLY presentation of deterministic control aggregation
 * (services/controlIntelligence). No form on these pages mutates state:
 * the only POST-free navigation targets are the existing governed screens
 * where authorized workflows live. Restrained enterprise hierarchy —
 * compact metrics, status chips, high-information tables, expandable
 * reasons — no marketing cards, no prediction visuals.
 */
import { h, Fragment, renderDocument, VNode } from "./jsx";
import { AppShell, NavContext, PageHeader, fmtDate, money, roleLabel } from "./components";
import type {
  ActionFilters,
  AttentionRow,
  ControlAction,
  ControlIntelligenceData,
  ControlMetric,
  ControlHealthStatus,
  DrawExposure,
  MilestoneGateRow,
  ProjectControlHealth,
  SurveillanceRow,
} from "../services/controlIntelligence";
import type { UserRole } from "../../shared/types";

// ------------------------------------------------------------ chips

const STATUS_META: Record<ControlHealthStatus, { label: string; cls: string }> = {
  BLOCKED: { label: "BLOCKED", cls: "bad" },
  AT_RISK: { label: "AT RISK", cls: "bad soft" },
  WATCH: { label: "WATCH", cls: "warn" },
  DATA_INCOMPLETE: { label: "DATA INCOMPLETE", cls: "info" },
  HEALTHY: { label: "HEALTHY", cls: "ok" },
};

function HealthChip(props: { status: ControlHealthStatus }): VNode {
  const m = STATUS_META[props.status];
  return <span className={`ci-chip ${m.cls}`}>{m.label}</span>;
}

function PriorityChip(props: { p: string }): VNode {
  const cls =
    props.p === "IMMEDIATE" ? "bad" : props.p === "HIGH" ? "warn" : props.p === "NORMAL" ? "info" : "";
  return <span className={`ci-chip ${cls}`}>{props.p}</span>;
}

function SevChip(props: { s: string }): VNode {
  const cls = props.s === "CRITICAL" || props.s === "HIGH" ? "bad" : props.s === "MEDIUM" ? "warn" : "";
  return <span className={`ci-chip ${cls}`}>{props.s}</span>;
}

const gateLabel = (v: string): string => v.replace(/_/g, " ");

function moneyOrNA(v: number | null): string {
  return v === null ? "NOT AVAILABLE" : money(v);
}

// ------------------------------------------------------------ sections

function SummaryStrip(props: { metrics: ControlMetric[] }): VNode {
  return (
    <div className="ci-strip" id="summary">
      {props.metrics.map((m) => (
        <a className="ci-cell" href={m.href ?? "#"} title={m.definition}>
          <span className="ci-v">
            {m.state !== "OK" && m.value === null
              ? m.state.replace(/_/g, " ")
              : m.kind === "money"
                ? money(m.value ?? 0)
                : m.kind === "pct"
                  ? `${m.value}%`
                  : String(m.value)}
          </span>
          <span className="ci-l">{m.label}</span>
          {m.state === "DATA_INCOMPLETE" && m.value !== null ? (
            <span className="ci-flag">DATA INCOMPLETE</span>
          ) : null}
        </a>
      ))}
    </div>
  );
}

function HealthPanel(props: { health: ProjectControlHealth[]; detail?: boolean }): VNode {
  return (
    <div className="panel" id="health">
      <div className="panel-head">
        <h3>Project Health &amp; Delivery Readiness</h3>
        <span className="right">Deterministic — documented rule order below</span>
      </div>
      {props.health.map((ph) => (
        <div className="ci-health">
          <div className="ci-health-head">
            <HealthChip status={ph.status} />
            <a className="ci-proj" href={`/control/project/${ph.projectId}`}>{ph.projectName}</a>
            <span className="ci-meta">
              computed {fmtDate(ph.generatedAt).slice(0, 16)}
              {ph.policyVersion !== null ? ` · verification policy v${ph.policyVersion}` : ""}
            </span>
          </div>
          {ph.primaryReason ? (
            <p className="ci-primary">
              <b>Primary condition ({ph.primaryReason.code}):</b> {ph.primaryReason.detail}
            </p>
          ) : (
            <p className="ci-primary ok-text">No adverse control condition applies.</p>
          )}
          {ph.reasons.length > 0 ? (
            <details className="ci-reasons">
              <summary>{ph.reasons.length} condition(s) — codes, sources, amounts</summary>
              <div className="table-scroll">
              <table className="ci-table">
                <thead>
                  <tr><th>Level</th><th>Code</th><th>Explanation</th><th>Amount</th><th>Role</th><th>Blocking</th><th>Sources</th></tr>
                </thead>
                <tbody>
                  {ph.reasons.map((r) => (
                    <tr>
                      <td><HealthChip status={r.level} /></td>
                      <td className="mono">{r.code}</td>
                      <td><a href={r.href}>{r.detail}</a></td>
                      <td className="num">{r.amount !== null ? money(r.amount) : "—"}</td>
                      <td>{r.role ? roleLabel(r.role) : "—"}</td>
                      <td>{r.blocking ? "BLOCKS GOVERNANCE" : "Non-blocking"}</td>
                      <td className="ci-src">{r.sources.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </details>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SurveillancePanel(props: { rows: SurveillanceRow[] }): VNode {
  return (
    <div className="panel" id="surveillance">
      <div className="panel-head">
        <h3>Exception &amp; Control-Risk Surveillance</h3>
        <span className="right"><a href="/exceptions">Exception register →</a></span>
      </div>
      <p className="ci-note">
        The governed exception register is the single exception truth — rows below link to it and are
        never duplicated here. Waivers do not change source truth; cleared sources auto-resolve and
        recurring sources reopen their exception.
      </p>
      {props.rows.length === 0 ? (
        <p className="ci-empty">No open or waived exceptions in scope.</p>
      ) : (
        <div className="table-scroll">
          <table className="ci-table">
            <thead>
              <tr>
                <th>Severity</th><th>Category</th><th>Status</th><th>Source</th><th>Scope</th>
                <th>Age</th><th>SLA</th><th>Owner</th><th>Blocking</th><th>Amount</th><th>Next action</th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => (
                <tr>
                  <td><SevChip s={r.severity} /></td>
                  <td>{r.category}</td>
                  <td>{r.status}</td>
                  <td><a href={r.href}>{r.sourceLabel}</a></td>
                  <td>{r.milestoneLabel ?? r.drawLabel ?? r.projectName}</td>
                  <td className="num">{r.ageDays}d</td>
                  <td className={r.sla === "OVERDUE" ? "ci-overdue" : ""}>{r.sla.replace(/_/g, " ")}</td>
                  <td>{r.owner}</td>
                  <td>{r.blocking ? "BLOCKING" : "Non-blocking"}</td>
                  <td className="num">{r.amount !== null ? money(r.amount) : "—"}</td>
                  <td>{r.nextAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function actionFilterForm(filters: ActionFilters, data: ControlIntelligenceData, basePath: string): VNode {
  const sel = (name: string, current: string | undefined, options: Array<[string, string]>): VNode => (
    <label className="ci-filter">
      {name}
      <select name={name.toLowerCase().replace(/ /g, "")}>
        <option value="">All</option>
        {options.map(([v, l]) => (
          <option value={v} selected={current === v ? true : undefined}>{l}</option>
        ))}
      </select>
    </label>
  );
  return (
    <form method="GET" action={basePath} className="ci-filters">
      {sel("Role", filters.role, (["FUNDER_REP", "PROJECT_MANAGER", "COMPLIANCE_REVIEWER", "FIELD"] as UserRole[]).map((r) => [r, roleLabel(r)]))}
      {sel("Priority", filters.priority, [["IMMEDIATE", "Immediate"], ["HIGH", "High"], ["NORMAL", "Normal"], ["INFORMATIONAL", "Informational"]])}
      {sel("Type", filters.type, data.actionTypes.map((t) => [t, t.replace(/-/g, " ")]))}
      {sel("Blocking", filters.blocking, [["true", "Blocking only"], ["false", "Non-blocking only"]])}
      {sel("Overdue", filters.overdue, [["true", "Overdue only"], ["false", "Not overdue"]])}
      <button className="btn secondary sm" type="submit">Apply filters</button>
    </form>
  );
}

function ActionQueuePanel(props: {
  actions: ControlAction[];
  filters: ActionFilters;
  data: ControlIntelligenceData;
  basePath: string;
}): VNode {
  return (
    <div className="panel" id="actions">
      <div className="panel-head">
        <h3>Governed Action Queue</h3>
        <span className="right">{props.actions.length} action(s) — every action cites source records</span>
      </div>
      {actionFilterForm(props.filters, props.data, props.basePath)}
      {props.actions.length === 0 ? (
        <p className="ci-empty">No actions match the current filters. Actions are only generated from source records — an empty queue means no matching governed condition is open.</p>
      ) : (
        <div className="table-scroll">
          <table className="ci-table">
            <thead>
              <tr>
                <th>Priority</th><th>Action</th><th>Role</th><th>Reference</th><th>Amount</th>
                <th>Detected</th><th>SLA</th><th>Blocking</th><th>Class</th><th>Open</th>
              </tr>
            </thead>
            <tbody>
              {props.actions.map((a) => (
                <tr>
                  <td><PriorityChip p={a.priority} /></td>
                  <td>
                    <b>{a.title}</b>
                    <span className="ci-sub">{a.explanation}</span>
                    <span className="ci-src">Sources: {a.sources.join("; ")}</span>
                  </td>
                  <td>{roleLabel(a.role)}</td>
                  <td>{a.ref}</td>
                  <td className="num">{a.amount !== null ? money(a.amount) : "—"}</td>
                  <td className="mono">{a.detectedAt ? fmtDate(a.detectedAt).slice(0, 10) : "—"}</td>
                  <td className={a.slaState === "OVERDUE" ? "ci-overdue" : ""}>{a.slaState ?? "—"}</td>
                  <td>{a.blocking ? "BLOCKS GOVERNANCE" : "Non-blocking"}</td>
                  <td>{a.mandatory ? "Mandatory" : "Advisory"}</td>
                  <td><a className="btn ghost sm" href={a.href}>Open</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExposurePanel(props: { e: DrawExposure }): VNode {
  const e = props.e;
  const rows: Array<[string, string, string]> = [
    ["Requested (submitted draws)", money(e.submittedTotal), "Σ requested amounts of submitted, non-cancelled draws."],
    ["Supportable (reviewer-recorded)", moneyOrNA(e.supportableTotal), "Σ reviewer-supported line amounts. Never inferred."],
    ["Advisory recommendation", moneyOrNA(e.advisoryTotal), "Finalized advisory amounts — NOT approvals."],
    ["Formally approved (gross)", moneyOrNA(e.approvedGrossTotal), "Completed-governance approved amounts — NOT releases."],
    ["Released (net)", money(e.releasedNetTotal), "Governed draw release events only."],
    ["Retainage withheld", money(e.retainageWithheld), "Withheld by governed draw releases."],
    ["Retainage released", money(e.retainageReleased), "Released only through formal retainage governance."],
    ["Milestone tranches held", money(e.tranchesHeld), "Milestone HELD amounts on the virtual account (separate from draws)."],
    ["Blocked (unique)", money(e.blockedUnique), "Each affected amount counted once across all blocker categories."],
  ];
  return (
    <div className="panel" id="exposure">
      <div className="panel-head">
        <h3>Draw &amp; Funds Exposure</h3>
        <span className="right"><a href="/draws">Draw register →</a></span>
      </div>
      <div className="ci-exp">
        {rows.map(([l, v, d]) => (
          <span className="ci-exp-cell" title={d}>
            <span className="v num">{v}</span>
            <span className="l">{l}</span>
          </span>
        ))}
      </div>
      <div className="ci-exp-cats">
        <span className="ci-h">Blocked amount by category (categories can overlap)</span>
        {e.categories.length === 0 ? (
          <p className="ci-empty">No open draw carries a blocker.</p>
        ) : (
          e.categories.map((c) => (
            <span className="ci-cat-row">
              <span className="m">{c.label}</span>
              <span className="num">{money(c.amount)}</span>
              <span className="s">{c.drawIds.length} draw(s)</span>
            </span>
          ))
        )}
        <p className="ci-note">{e.overlapNote}</p>
        <p className="ci-note">
          Requested, supportable, advisory, approved, released, retained, blocked and held are distinct
          figures and are never merged. An advisory recommendation is not an approval; an approval is not
          a release. Line-level approved/released allocation remains NOT ALLOCATED PER LINE unless a
          controlled allocation record exists.
        </p>
      </div>
    </div>
  );
}

function GatesPanel(props: { rows: MilestoneGateRow[] }): VNode {
  return (
    <div className="panel" id="gates">
      <div className="panel-head">
        <h3>Completion &amp; Inspection Gates</h3>
        <span className="right">Six dimensions — never a single COMPLETE badge</span>
      </div>
      <div className="table-scroll">
        <table className="ci-table">
          <thead>
            <tr>
              <th>Milestone</th><th>Contractor</th><th>OBV evidence</th><th>Inspection req.</th>
              <th>Inspection</th><th>Governance</th><th>Funds</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr>
                <td>
                  <a href={`/milestone/${r.milestoneId}`}><b>{r.label}</b></a>
                  <span className="ci-sub num">{money(r.trancheAmount)}</span>
                  {r.legacyReleased ? (
                    <span className="ci-legacy">Legacy released record — current completion-gate facts were not recorded at the time of release.</span>
                  ) : null}
                  {r.blockingReasons.length > 0 ? (
                    <span className="ci-src">Blocking: {r.blockingReasons.map((b) => b.code).join(", ")}</span>
                  ) : null}
                </td>
                <td>{gateLabel(r.contractor)}</td>
                <td>{gateLabel(r.evidence)}</td>
                <td className={r.requirement === "UNKNOWN" ? "ci-unknown" : ""}>{gateLabel(r.requirement)}</td>
                <td>{gateLabel(r.inspection)}</td>
                <td>{gateLabel(r.governance)}</td>
                <td>{gateLabel(r.funds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ci-note">
        RELEASED is a historical financial state and does not imply that all current completion gates
        were satisfied. Inspection requirement UNKNOWN never behaves as NOT REQUIRED. Contractor
        completion is a representation, not evidence verification; evidence verification is not
        inspection passage.
      </p>
    </div>
  );
}

function CapacityPanel(props: { data: ControlIntelligenceData }): VNode {
  return (
    <div className="panel" id="capacity">
      <div className="panel-head">
        <h3>Operational Capacity &amp; Schedule Exposure</h3>
        <span className="right">Grounded workload and backlog indicators — not workforce forecasts</span>
      </div>
      <div className="ci-cap">
        {props.data.capacity.map((c) => (
          <a className="ci-cap-cell" href={c.href} title={c.detail}>
            <span className="v num">{c.count}</span>
            <span className="l">{c.label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function AttentionPanel(props: { rows: AttentionRow[]; sort: string; basePath: string }): VNode {
  const th = (label: string, key: string): VNode => (
    <th>
      <a href={`${props.basePath}?sort=${key}#attention`} className={props.sort === key ? "ci-sort-on" : ""}>
        {label}
      </a>
    </th>
  );
  return (
    <div className="panel" id="attention">
      <div className="panel-head">
        <h3>Portfolio attention</h3>
        <span className="right">Sort: attention · blocked · exceptions · variance · blockers</span>
      </div>
      <div className="table-scroll">
        <table className="ci-table">
          <thead>
            <tr>
              <th>Project</th>
              {th("Health", "attention")}
              <th>Verified physical</th>
              <th>Governed financial</th>
              {th("Variance", "variance")}
              {th("Open blockers", "blockers")}
              {th("HIGH/CRIT exceptions", "exceptions")}
              {th("Draw value blocked", "blocked")}
              <th>Funds held</th>
              <th>Pending inspections</th>
              <th>Next required action</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr>
                <td><a href={`/control/project/${r.projectId}`}><b>{r.name}</b></a></td>
                <td><HealthChip status={r.status} /></td>
                <td className="num">{r.verifiedPhysicalPct !== null ? `${r.verifiedPhysicalPct}%` : "DATA INCOMPLETE"}</td>
                <td className="num">{r.governedFinancialPct !== null ? `${r.governedFinancialPct}%` : "DATA INCOMPLETE"}</td>
                <td className="num">{r.variancePts !== null ? `${r.variancePts > 0 ? "+" : ""}${r.variancePts} pts` : "—"}</td>
                <td className="num">{r.openBlockers}</td>
                <td className="num">{r.highCriticalExceptions}</td>
                <td className="num">{money(r.drawBlocked)}</td>
                <td className="num">{money(r.fundsHeld)}</td>
                <td className="num">{r.pendingInspections}</td>
                <td>{r.nextAction ? <a href={r.nextActionHref ?? "#actions"}>{r.nextAction}</a> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MethodologyPanel(props: { data: ControlIntelligenceData }): VNode {
  const m = props.data.methodology;
  return (
    <div className="panel" id="methodology">
      <div className="panel-head"><h3>Intelligence Methodology</h3></div>
      <p className="ci-note ci-statement">{m.statement}</p>
      <div className="ci-method">
        <div>
          <span className="ci-h">Rule precedence (exact order)</span>
          <ol className="ci-rules">
            {m.ruleOrder.map((r) => (
              <li><HealthChip status={r.status} /> {r.rule}</li>
            ))}
          </ol>
          <span className="ci-h">Metric definitions</span>
          <ul className="ci-defs">
            {props.data.summary.map((s) => (
              <li><b>{s.label}:</b> {s.definition}</li>
            ))}
          </ul>
        </div>
        <div>
          <span className="ci-h">Source models</span>
          <ul className="ci-defs">{m.sourceModels.map((s) => <li>{s}</li>)}</ul>
          <span className="ci-h">Known limitations &amp; DATA INCOMPLETE behavior</span>
          <ul className="ci-defs">{m.limitations.map((s) => <li>{s}</li>)}</ul>
          <p className="ci-note">
            Deterministic results are authoritative. Where an AI-written explanation is unavailable or
            fails, the deterministic text shown here is used unchanged. Generated {fmtDate(m.generatedAt)}.
          </p>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ pages

export function renderControlIntelligence(input: {
  nav: NavContext;
  data: ControlIntelligenceData;
  filteredActions: ControlAction[];
  filters: ActionFilters;
  sort: string;
  sortedAttention: AttentionRow[];
}): string {
  const d = input.data;
  return renderDocument(
    <AppShell title="OBV Control Intelligence" nav={input.nav} context="Control intelligence">
      <div className="page-wrap">
        <PageHeader
          title="OBV Control Intelligence"
          sub="Evidence-grounded oversight of project progress, draw readiness, exceptions, inspections, governance, and funds exposure."
        >
          <span className="int-mode" title="Derived from governed records and deterministic control rules">
            DETERMINISTIC
          </span>
        </PageHeader>

        <SummaryStrip metrics={d.summary} />
        <HealthPanel health={d.health} />
        <div className="ci-duo">
          <SurveillancePanel rows={d.surveillance} />
          <CapacityPanel data={d} />
        </div>
        <ActionQueuePanel actions={input.filteredActions} filters={input.filters} data={d} basePath="/control" />
        <ExposurePanel e={d.exposure} />
        <GatesPanel rows={d.gateRows} />
        <AttentionPanel rows={input.sortedAttention} sort={input.sort} basePath="/control" />
        <MethodologyPanel data={d} />
        <p className="footer-note">
          Read-only control view generated {fmtDate(d.generatedAt)} from governed records. Ledger chain:{" "}
          {d.chainValid ? "INTACT" : "INTEGRITY FAILURE"}. Navigation targets lead to the existing
          authorized workflows — no approval, release, verification, inspection or exception state can be
          changed from this page.
        </p>
      </div>
    </AppShell>
  );
}

export function renderControlProject(input: {
  nav: NavContext;
  data: ControlIntelligenceData; // scoped to one project
  filteredActions: ControlAction[];
  filters: ActionFilters;
  projectName: string;
  projectId: string;
}): string {
  const d = input.data;
  const basePath = `/control/project/${input.projectId}`;
  return renderDocument(
    <AppShell title="Project Control Intelligence" nav={input.nav} context={input.projectName}>
      <div className="page-wrap">
        <PageHeader
          title={`Control Intelligence — ${input.projectName}`}
          sub="Project-level health, blockers, exposure, gates, exceptions and governed actions."
          crumb={{ href: "/control", label: "Portfolio control intelligence" }}
        >
          <a className="btn secondary sm" href={`/project/${input.projectId}`}>Open project record</a>
        </PageHeader>

        <SummaryStrip metrics={d.summary} />
        <HealthPanel health={d.health} detail />
        <ExposurePanel e={d.exposure} />
        <GatesPanel rows={d.gateRows} />
        <div className="ci-duo">
          <SurveillancePanel rows={d.surveillance} />
          <CapacityPanel data={d} />
        </div>
        <ActionQueuePanel actions={input.filteredActions} filters={input.filters} data={d} basePath={basePath} />
        <MethodologyPanel data={d} />
        <p className="footer-note">
          Read-only control view generated {fmtDate(d.generatedAt)}. Ledger chain:{" "}
          {d.chainValid ? "INTACT" : "INTEGRITY FAILURE"}.
        </p>
      </div>
    </AppShell>
  );
}
