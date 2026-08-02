/** Executive Command Center — portfolio intelligence pages.
 *
 * Server-rendered like every other OBV surface: figures come from the
 * portfolio service (viewer-scoped, derived-only) and every number on
 * screen traces to stored records. Provenance and advisory captions are
 * part of the design, not an afterthought.
 */
import { h, Fragment, renderDocument, VNode } from "./jsx";
import {
  AppShell,
  EmptyStateV2,
  FilterBar,
  Metric,
  MetricStrip,
  NavContext,
  PageHeader,
  SectionHead,
  enumLabel,
  fmtDate,
  money,
} from "./components";
import { icons } from "./icons";
import type {
  ContractorScorecard,
  ExecutiveSummary,
  FraudIntelligence,
  GovernmentFoundationStatus,
  InspectorScorecard,
  PortfolioForecast,
  PortfolioOverview,
  PortfolioRiskSummary,
  ProjectRiskProfile,
  SnapshotView,
  VendorScorecard,
} from "../services/portfolio";

// --------------------------------------------------------------- shared

function bandChip(band: string): VNode {
  const cls = band === "CRITICAL" ? "bad" : band === "ELEVATED" ? "warn" : band === "WATCH" ? "info" : "ok";
  const glyph = band === "CRITICAL" ? "!" : band === "ELEVATED" ? "▲" : band === "WATCH" ? "◔" : "✓";
  return (
    <span className={`status ${cls}`}>
      <span className="g">{glyph}</span>
      {enumLabel(band)}
    </span>
  );
}

function ExecTabs(props: { active: string }): VNode {
  const tabs = [
    { key: "overview", href: "/executive", label: "Command center" },
    { key: "entities", href: "/executive/entities", label: "Contractors & inspectors" },
    { key: "forecast", href: "/executive/forecast", label: "Forecasts" },
    { key: "summary", href: "/executive/summary", label: "Executive summary" },
  ];
  return (
    <div className="exec-tabs" role="navigation" aria-label="Executive sections">
      {tabs.map((t) => (
        <a className={`btn ghost sm ${props.active === t.key ? "exec-tab-active" : ""}`} href={t.href}>
          {t.label}
        </a>
      ))}
    </div>
  );
}

interface Dist {
  key: string;
  label: string;
  count: number;
  totalBudget: number;
}

function DistPanel(props: { title: string; hint?: string; entries: Dist[]; limit?: number }): VNode {
  const entries = props.entries.slice(0, props.limit ?? 6);
  const max = Math.max(1, ...entries.map((e) => e.count));
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>{props.title}</h3>
        {props.hint ? <span className="hint">{props.hint}</span> : null}
      </div>
      <div className="panel-pad">
        {entries.length === 0 ? (
          <p className="t-quiet">No records in scope.</p>
        ) : (
          entries.map((e) => (
            <div className="tr-row">
              <span className="m" title={e.label}>{e.label}</span>
              <span className="bar"><span className="fl" style={`width:${Math.round((e.count / max) * 100)}%`}></span></span>
              <span className="c num">{e.count} · {money(e.totalBudget)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function TrendPanel(props: {
  title: string;
  entries: { month: string; opened: number; resolved: number }[];
  openedLabel?: string;
  resolvedLabel?: string;
}): VNode {
  const entries = props.entries.slice(-6);
  const max = Math.max(1, ...entries.map((e) => Math.max(e.opened, e.resolved)));
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>{props.title}</h3>
        <span className="hint">
          {(props.openedLabel ?? "opened") + " vs " + (props.resolvedLabel ?? "resolved")} · last {entries.length} mo
        </span>
      </div>
      <div className="panel-pad">
        {entries.length === 0 ? (
          <p className="t-quiet">No dated records in scope.</p>
        ) : (
          entries.map((e) => (
            <div className="tr-row">
              <span className="m">{e.month}</span>
              <span className="bar"><span className="fl" style={`width:${Math.round((e.opened / max) * 100)}%`}></span></span>
              <span className="bar"><span className="fl exec-fl-2" style={`width:${Math.round((e.resolved / max) * 100)}%`}></span></span>
              <span className="c num">{e.opened} / {e.resolved}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------- command center

export interface ExecutiveFilterState {
  status: string;
  state: string;
  stage: string;
  risk: string;
  lender: string;
  contractor: string;
}

export function renderExecutive(input: {
  nav: NavContext;
  overview: PortfolioOverview;
  risk: PortfolioRiskSummary;
  fraud: FraudIntelligence;
  government: GovernmentFoundationStatus;
  snapshots: SnapshotView[];
  filters: ExecutiveFilterState;
  filterOptions: {
    states: string[];
    stages: string[];
    lenders: { id: string; name: string }[];
    contractors: { id: string; name: string }[];
  };
  pdfAvailable: boolean;
  notice: { kind: "ok" | "err"; text: string } | null;
  /** Advisory Evidence Intelligence summary (derived, viewer-scoped).
   *  Absent when the caller cannot view Evidence Intelligence. */
  evidenceQuality?: {
    averageCompleteness: number;
    averageQuality: number;
    averageConfidence: number;
    openReviews: number;
    duplicateFindings: number;
    topRepeated: { category: string; count: number } | null;
  } | null;
}): string {
  const { overview, risk } = input;
  const t = overview.totals;
  const filtersActive = Object.values(input.filters).some((v) => v.length > 0);
  const healthValue = risk.averageHealth === null ? "—" : `${Math.round(risk.averageHealth)}/100`;
  const select = (name: string, current: string, label: string, options: { value: string; label: string }[]): VNode => (
    <select name={name} aria-label={label}>
      <option value="">{label}</option>
      {options.map((o) => (
        <option value={o.value} selected={o.value === current}>{o.label}</option>
      ))}
    </select>
  );

  return renderDocument(
    <AppShell title="Executive" nav={input.nav} context="Portfolio command center">
      <div className="page-wrap">
        <PageHeader
          title="Executive command center"
          sub="Continuous portfolio intelligence derived from verified project records."
          asOf={`Portfolio · computed ${fmtDate(overview.generatedAt).slice(0, 16)} UTC`}
        >
          <form method="POST" action="/api/portfolio/snapshots" style="display:inline">
            <button className="btn secondary" type="submit" data-busy-label="Recording…">Record snapshot</button>
          </form>
          {input.pdfAvailable ? (
            <form method="POST" action="/api/reports/executive" style="display:inline">
              <button className="btn" type="submit" data-busy-label="Generating…">Export executive PDF</button>
            </form>
          ) : (
            <a className="btn" href="/executive/report/preview" target="_blank">Printable report</a>
          )}
          <a className="btn ghost" href="/executive/report/preview" target="_blank">Preview HTML</a>
        </PageHeader>

        {input.notice ? (
          <div className={`banner ${input.notice.kind === "ok" ? "ok" : "warn"}`}>{input.notice.text}</div>
        ) : null}

        <ExecTabs active="overview" />

        <MetricStrip
          metrics={[
            { value: String(t.activeProjects), label: "Active projects", sub: `${t.totalProjects} in scope` },
            { value: money(t.totalBudget), label: "Portfolio budget" },
            { value: money(t.releasedAmount), label: "Released to date", sub: `${t.fundingUtilizationPct}% of governed capital` },
            { value: `${t.budgetUtilizationPct}%`, label: "Budget utilization", sub: `${money(t.paidToDate)} paid` },
            { value: healthValue, label: "Portfolio health", tone: risk.attention.length > 0 ? "warn" : "ok" },
            {
              value: String(risk.attention.length),
              label: "Needs attention",
              tone: risk.attention.length > 0 ? "bad" : undefined,
              dim: risk.attention.length === 0,
            },
          ]}
        />

        {input.evidenceQuality ? (
          <section className="exec-section" aria-label="Evidence quality">
            <SectionHead
              title="Evidence quality"
              hint="Advisory Evidence Intelligence — signals for reviewers; never a control decision."
              right={<a className="btn ghost sm" href="/evidence-intelligence/analytics">Open analytics</a>}
            />
            <MetricStrip
              metrics={[
                { value: `${input.evidenceQuality.averageCompleteness}%`, label: "Documentation completeness", href: "/evidence-intelligence/analytics" },
                { value: `${input.evidenceQuality.averageQuality}%`, label: "Average evidence quality" },
                { value: `${input.evidenceQuality.averageConfidence}%`, label: "Average confidence" },
                {
                  value: String(input.evidenceQuality.openReviews),
                  label: "Open advisory reviews",
                  href: "/evidence-intelligence/queue",
                  tone: input.evidenceQuality.openReviews > 0 ? "warn" : undefined,
                  dim: input.evidenceQuality.openReviews === 0,
                },
                {
                  value: String(input.evidenceQuality.duplicateFindings),
                  label: "Duplicate-evidence findings",
                  dim: input.evidenceQuality.duplicateFindings === 0,
                },
                input.evidenceQuality.topRepeated
                  ? { value: String(input.evidenceQuality.topRepeated.count), label: `Most repeated: ${enumLabel(input.evidenceQuality.topRepeated.category)}` }
                  : { value: "—", label: "Most repeated advisory", dim: true },
              ]}
            />
          </section>
        ) : null}

        <FilterBar
          action="/executive"
          count={`${overview.scope.projectCount} of ${overview.scope.unfilteredProjectCount} project(s)${filtersActive ? " (filtered)" : ""}`}
        >
          {select("status", input.filters.status, "All statuses", [
            { value: "ACTIVE", label: "Active" },
            { value: "DRAFT", label: "Draft" },
            { value: "COMPLETED", label: "Completed" },
            { value: "SUSPENDED", label: "Suspended" },
          ])}
          {select("state", input.filters.state, "All states", input.filterOptions.states.map((s) => ({ value: s, label: s })))}
          {select("stage", input.filters.stage, "All stages", input.filterOptions.stages.map((s) => ({ value: s, label: enumLabel(s) })))}
          {select("risk", input.filters.risk, "All risk bands", [
            { value: "STABLE", label: "Stable" },
            { value: "WATCH", label: "Watch" },
            { value: "ELEVATED", label: "Elevated" },
            { value: "CRITICAL", label: "Critical" },
          ])}
          {select("lender", input.filters.lender, "All lenders", input.filterOptions.lenders.map((l) => ({ value: l.id, label: l.name })))}
          {select("contractor", input.filters.contractor, "All contractors", input.filterOptions.contractors.map((c) => ({ value: c.id, label: c.name })))}
        </FilterBar>

        {risk.attention.length > 0 ? (
          <section className="panel exec-attention">
            <div className="panel-head">
              <h3>Projects requiring executive attention</h3>
              <span className="hint">risk ≥ ELEVATED, most severe first</span>
            </div>
            <div className="queue">
              {risk.attention.slice(0, 6).map((p) => (
                <a className="queue-row" href={`/project/${p.projectId}`}>
                  <span className={`q-ico ${p.band === "CRITICAL" ? "bad" : "warn"}`} aria-hidden="true">{icons.alert()}</span>
                  <span className="q-body">
                    <span className="q-t">{p.projectName}</span>
                    <span className="q-s">{p.topReasons[0]?.label ?? "Multiple elevated risk dimensions"}</span>
                  </span>
                  <span className="q-meta">{bandChip(p.band)}<span className="num t-meta">risk {p.overallRisk}/100</span></span>
                </a>
              ))}
            </div>
          </section>
        ) : (
          <EmptyStateV2
            icon={icons.shield()}
            title="No projects need executive attention"
            what="Every project in scope currently scores below the ELEVATED risk band."
            condition="healthy"
          />
        )}

        <div className="intel-tri">
          <DistPanel title="Projects by state" entries={overview.distributions.byState} />
          <DistPanel title="Projects by stage" entries={overview.distributions.byStage.map((d) => ({ ...d, label: enumLabel(d.label) }))} />
          <DistPanel title="Projects by risk band" entries={overview.distributions.byRisk.map((d) => ({ ...d, label: enumLabel(d.label) }))} />
        </div>
        <div className="intel-tri">
          <DistPanel title="Projects by lender" entries={overview.distributions.byLender} />
          <DistPanel title="Projects by contractor" entries={overview.distributions.byContractor} />
          <DistPanel title="Projects by inspector" entries={overview.distributions.byInspector} />
        </div>
        <div className="intel-tri">
          <DistPanel title="Projects by jurisdiction" entries={overview.distributions.byJurisdiction} />
          <TrendPanel title="Exception trend" entries={overview.trends.exceptions} />
          <TrendPanel title="Dispute trend" entries={overview.trends.disputes} />
        </div>
        <div className="intel-tri">
          <TrendPanel title="Draw pipeline" entries={overview.trends.draws} openedLabel="submitted" resolvedLabel="approved" />
          <TrendPanel title="Permit activity" entries={overview.trends.permits} openedLabel="issued" resolvedLabel="closed" />
          <section className="panel">
            <div className="panel-head"><h3>Portfolio growth</h3><span className="hint">cumulative released capital</span></div>
            <div className="panel-pad">
              {overview.trends.growth.length === 0 ? (
                <p className="t-quiet">No release history in scope.</p>
              ) : (
                overview.trends.growth.slice(-6).map((g) => (
                  <div className="tr-row">
                    <span className="m">{g.month}</span>
                    <span className="bar">
                      <span
                        className="fl"
                        style={`width:${Math.round((g.cumulativeReleased / Math.max(1, overview.trends.growth.at(-1)!.cumulativeReleased)) * 100)}%`}
                      ></span>
                    </span>
                    <span className="c num">{money(g.cumulativeReleased)}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <SectionHead
          title="Project risk register"
          hint="eight deterministic dimensions per project"
          right={<span className="t-meta num">avg draw approval {overview.timing.averageDrawApprovalDays ?? "—"} d · inspection turnaround {overview.timing.averageIndependentInspectionTurnaroundDays ?? overview.timing.averageGovernmentInspectionTurnaroundDays ?? "—"} d</span>}
        />
        <div className="register desktop-only">
          <div className="reg-scroll">
            <table className="reg">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Band</th>
                  <th className="r">Health</th>
                  <th className="r">Fin</th>
                  <th className="r">Comp</th>
                  <th className="r">Sched</th>
                  <th className="r">Docs</th>
                  <th className="r">Insp</th>
                  <th className="r">Contr</th>
                  <th className="r">Fraud</th>
                  <th className="r">Ops</th>
                  <th>Top signal</th>
                </tr>
              </thead>
              <tbody>
                {risk.projects.map((p) => (
                  <tr>
                    <td className="p"><a href={`/project/${p.projectId}`}>{p.projectName}</a><span className="s">{enumLabel(p.stage)} · {p.state}</span></td>
                    <td>{bandChip(p.band)}</td>
                    <td className="r num">{p.health}</td>
                    <td className="r num">{p.dimensions.financial.score}</td>
                    <td className="r num">{p.dimensions.compliance.score}</td>
                    <td className="r num">{p.dimensions.schedule.score}</td>
                    <td className="r num">{p.dimensions.documentation.score}</td>
                    <td className="r num">{p.dimensions.inspection.score}</td>
                    <td className="r num">{p.dimensions.contractor.score}</td>
                    <td className="r num">{p.dimensions.fraud.score}</td>
                    <td className="r num">{p.dimensions.operational.score}</td>
                    <td className="s">{p.topReasons[0]?.label ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="mobile-only">
          {risk.projects.map((p) => (
            <a className="rec-card" href={`/project/${p.projectId}`}>
              <div className="rc-top">
                <span className="rc-title">{p.projectName}</span>
                <span className="rc-side">{bandChip(p.band)}</span>
              </div>
              <div className="rc-kv">
                <span>Health <b className="num">{p.health}/100</b></span>
                <span>{enumLabel(p.stage)}</span>
              </div>
              <div className="rc-next">{p.topReasons[0]?.label ?? "No elevated signals"}</div>
            </a>
          ))}
        </div>

        <div className="intel-duo">
          <section className="panel">
            <div className="panel-head">
              <h3>Fraud &amp; anomaly signals</h3>
              <span className="hint">advisory only — {input.fraud.signalCount} signal(s)</span>
            </div>
            <div className="panel-pad">
              {input.fraud.signals.length === 0 ? (
                <p className="t-quiet">No anomaly patterns detected in the current records.</p>
              ) : (
                <ul className="tl">
                  {input.fraud.signals.slice(0, 8).map((s) => (
                    <li className={s.severity === "HIGH" ? "bad" : s.severity === "MEDIUM" ? "warn" : ""}>
                      <span className="tl-t">{s.label}</span>
                      <span className="tl-m">{s.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="t-quiet exec-advisory">{input.fraud.advisory}</p>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h3>Snapshot history</h3>
              <span className="hint">append-only observations · {input.snapshots.length} recorded</span>
            </div>
            <div className="panel-pad">
              {input.snapshots.length === 0 ? (
                <p className="t-quiet">
                  No snapshots recorded yet. Record one to start the historical portfolio series.
                </p>
              ) : (
                <div className="table-scroll">
                  <table className="data">
                    <thead>
                      <tr><th>Taken</th><th className="r">Projects</th><th className="r">Released</th><th className="r">Health</th><th className="r">Attention</th></tr>
                    </thead>
                    <tbody>
                      {input.snapshots.slice(-8).map((s) => (
                        <tr>
                          <td>{fmtDate(s.takenAt).slice(0, 16)}</td>
                          <td className="r num">{s.activeProjectCount}/{s.projectCount}</td>
                          <td className="r num">{money(s.totalReleased)}</td>
                          <td className="r num">{Math.round(s.averageHealth)}</td>
                          <td className="r num">{s.attentionCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="t-quiet exec-advisory">
                Government / infrastructure / donor / grant portfolio architecture: present, version {input.government.architectureVersion},{" "}
                {input.government.activationState.replaceAll("_", " ").toLowerCase()} — no government workflow is active.
              </p>
            </div>
          </section>
        </div>

        <p className="footer-note">
          Every figure on this page is computed on demand from verified project records within your
          accessible portfolio. Risk scores, forecasts and summaries are deterministic advisory reading
          aids — they never approve draws, never alter records, and never replace human review.
        </p>
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------------------- entities

export function renderExecutiveEntities(input: {
  nav: NavContext;
  contractors: ContractorScorecard[];
  inspectors: InspectorScorecard[];
  vendors: VendorScorecard[];
}): string {
  return renderDocument(
    <AppShell title="Executive — Entities" nav={input.nav} context="Contractor, inspector and vendor intelligence">
      <div className="page-wrap">
        <PageHeader
          title="Contractor, inspector &amp; vendor intelligence"
          sub="Cross-project performance derived from verified records. Scores are read models — no entity record is ever replaced."
        />
        <ExecTabs active="entities" />

        <MetricStrip
          metrics={[
            { value: String(input.contractors.length), label: "Contractors of record", dim: input.contractors.length === 0 },
            { value: String(input.inspectors.length), label: "Inspector identities", dim: input.inspectors.length === 0 },
            { value: String(input.vendors.length), label: "Vendors on invoices", dim: input.vendors.length === 0 },
          ]}
        />

        <SectionHead title="Contractors" hint="overall score blends quality, documentation, schedule, budget and inspections" />
        {input.contractors.length === 0 ? (
          <EmptyStateV2
            icon={icons.building()}
            title="No contractors of record"
            what="Contractor intelligence appears once projects carry a contractor of record (loan asset, party assignment, or pilot configuration)."
            condition="incomplete"
          />
        ) : (
          <div className="register">
            <div className="reg-scroll">
              <table className="reg">
                <thead>
                  <tr>
                    <th>Contractor</th>
                    <th className="r">Overall</th>
                    <th className="r">Quality</th>
                    <th className="r">Docs</th>
                    <th className="r">Schedule</th>
                    <th className="r">Budget</th>
                    <th className="r">Inspection %</th>
                    <th className="r">Exc/draw</th>
                    <th className="r">Cost var %</th>
                    <th className="r">Projects</th>
                    <th>Signals</th>
                  </tr>
                </thead>
                <tbody>
                  {input.contractors.map((c) => (
                    <tr>
                      <td className="p">{c.name}<span className="s">{c.completedProjects} completed · {c.projectsInProgress} in progress</span></td>
                      <td className="r num"><b>{c.overallScore}</b></td>
                      <td className="r num">{c.qualityScore}</td>
                      <td className="r num">{c.documentationScore}</td>
                      <td className="r num">{c.schedulePerformance}</td>
                      <td className="r num">{c.budgetPerformance}</td>
                      <td className="r num">{c.inspectionSuccessRatePct ?? "—"}</td>
                      <td className="r num">{c.exceptionRatePerDraw ?? "—"}</td>
                      <td className="r num">{c.averageCostVariancePct ?? "—"}</td>
                      <td className="r num">{c.projects.length}</td>
                      <td className="s">{c.topRisks[0] ?? c.topStrengths[0] ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <SectionHead title="Inspectors" hint="independent draw inspectors, government inspection records and dispute re-inspections stay separate" />
        {input.inspectors.length === 0 ? (
          <EmptyStateV2
            icon={icons.check()}
            title="No inspection records yet"
            what="Inspector analytics appear once draw inspections or government inspection records exist in scope."
            condition="incomplete"
          />
        ) : (
          <div className="register">
            <div className="reg-scroll">
              <table className="reg">
                <thead>
                  <tr>
                    <th>Inspector</th>
                    <th>Source</th>
                    <th className="r">Inspections</th>
                    <th className="r">Pass %</th>
                    <th className="r">Correction %</th>
                    <th className="r">Reinspections</th>
                    <th className="r">Turnaround (d)</th>
                    <th className="r">Response (d)</th>
                    <th className="r">Consistency ±d</th>
                    <th className="r">Open</th>
                    <th>Jurisdictions</th>
                  </tr>
                </thead>
                <tbody>
                  {input.inspectors.map((i) => (
                    <tr>
                      <td className="p">{i.name}</td>
                      <td className="s">{enumLabel(i.source)}</td>
                      <td className="r num">{i.inspections}</td>
                      <td className="r num">{i.passRatePct ?? "—"}</td>
                      <td className="r num">{i.correctionRatePct ?? "—"}</td>
                      <td className="r num">{i.reinspectionCount}</td>
                      <td className="r num">{i.averageTurnaroundDays ?? "—"}</td>
                      <td className="r num">{i.averageResponseDays ?? "—"}</td>
                      <td className="r num">{i.turnaroundConsistencyDays ?? "—"}</td>
                      <td className="r num">{i.openWorkload}</td>
                      <td className="s">{i.jurisdictions.join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <SectionHead title="Vendors" hint="resolved from draw-document invoice metadata; lien-waiver matching is best-effort by name" />
        {input.vendors.length === 0 ? (
          <EmptyStateV2
            icon={icons.file()}
            title="No vendor invoices in scope"
            what="Vendor analytics appear once draw documents carry vendor and invoice metadata."
            condition="incomplete"
          />
        ) : (
          <div className="register">
            <div className="reg-scroll">
              <table className="reg">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th className="r">Reliability</th>
                    <th className="r">Invoices</th>
                    <th className="r">Invoice value</th>
                    <th className="r">Accepted %</th>
                    <th className="r">Rejected</th>
                    <th className="r">Waivers ✓/⏳/✗</th>
                    <th className="r">Avg payment (d)</th>
                    <th className="r">Disputes</th>
                    <th className="r">Projects</th>
                  </tr>
                </thead>
                <tbody>
                  {input.vendors.map((v) => (
                    <tr>
                      <td className="p">{v.name}</td>
                      <td className="r num"><b>{v.reliabilityScore}</b></td>
                      <td className="r num">{v.invoiceCount}</td>
                      <td className="r num">{money(v.invoiceTotal)}</td>
                      <td className="r num">{v.invoiceAcceptedPct ?? "—"}</td>
                      <td className="r num">{v.invoiceRejectedCount}</td>
                      <td className="r num">{v.lienWaivers.accepted}/{v.lienWaivers.outstanding}/{v.lienWaivers.rejected}</td>
                      <td className="r num">{v.averagePaymentDays ?? "—"}</td>
                      <td className="r num">{v.disputeTouchCount}</td>
                      <td className="r num">{v.projects.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="footer-note">
          Entity intelligence is recomputed on demand from verified records; existing contractor, inspector
          and vendor records are never replaced or rewritten. Government inspector names are records about
          government inspections — never OBV identities.
        </p>
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------------------- forecast

export function renderExecutiveForecast(input: { nav: NavContext; forecast: PortfolioForecast }): string {
  const f = input.forecast;
  return renderDocument(
    <AppShell title="Executive — Forecasts" nav={input.nav} context="Project and portfolio forecasting">
      <div className="page-wrap">
        <PageHeader
          title="Project forecasting"
          sub="Deterministic projections from verified records. Forecasts stay separate from actuals and are stored nowhere."
        />
        <ExecTabs active="forecast" />

        <MetricStrip
          metrics={[
            { value: money(f.totals.finalCostForecast), label: "Final cost forecast" },
            { value: money(f.totals.remainingBudget), label: "Remaining budget" },
            { value: money(f.totals.remainingFunding), label: "Remaining governed funding" },
          ]}
        />

        {f.projects.length === 0 ? (
          <EmptyStateV2 icon={icons.insights()} title="No projects in scope" what="Forecasts appear once projects exist in your accessible portfolio." condition="incomplete" />
        ) : (
          <div className="register">
            <div className="reg-scroll">
              <table className="reg">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th className="r">Final cost forecast</th>
                    <th className="r">Remaining budget</th>
                    <th className="r">Remaining funding</th>
                    <th>Projected completion</th>
                    <th className="r">Slip (d)</th>
                    <th>Schedule conf.</th>
                    <th>Budget conf.</th>
                    <th className="r">Inspections left (d)</th>
                    <th className="r">Permits left (d)</th>
                  </tr>
                </thead>
                <tbody>
                  {f.projects.map((p) => (
                    <tr>
                      <td className="p"><a href={`/project/${p.projectId}`}>{p.projectName}</a></td>
                      <td className="r num">{money(p.finalCostForecast)}</td>
                      <td className="r num">{money(p.remainingBudget)}</td>
                      <td className="r num">{money(p.remainingFunding)}</td>
                      <td>{p.projectedCompletionDate ?? "—"}{p.plannedEnd ? <span className="s"> (planned {p.plannedEnd})</span> : null}</td>
                      <td className="r num">{p.projectedSlipDays ?? "—"}</td>
                      <td>{confChip(p.scheduleConfidence)}</td>
                      <td>{confChip(p.budgetConfidence)}</td>
                      <td className="r num">{p.inspectionCompletionForecastDays ?? "—"}</td>
                      <td className="r num">{p.permitCompletionForecastDays ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <SectionHead title="Cash flow forecast" hint="unreleased tranches spread across projected months" />
        <div className="intel-tri">
          {f.projects.slice(0, 6).map((p) => (
            <section className="panel">
              <div className="panel-head"><h3>{p.projectName}</h3><span className="hint">expected releases</span></div>
              <div className="panel-pad">
                {p.cashFlow.every((c) => c.expectedRelease === 0) ? (
                  <p className="t-quiet">No unreleased tranches.</p>
                ) : (
                  p.cashFlow.map((c) => (
                    <div className="tr-row">
                      <span className="m">{c.month}</span>
                      <span className="bar">
                        <span
                          className="fl"
                          style={`width:${Math.round((c.expectedRelease / Math.max(1, ...p.cashFlow.map((x) => x.expectedRelease))) * 100)}%`}
                        ></span>
                      </span>
                      <span className="c num">{money(c.expectedRelease)}</span>
                    </div>
                  ))
                )}
              </div>
            </section>
          ))}
        </div>

        <p className="footer-note">{f.advisory}</p>
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

function confChip(confidence: string): VNode {
  const cls = confidence === "HIGH" ? "ok" : confidence === "MEDIUM" ? "info" : "warn";
  return <span className={`status ${cls}`}><span className="g">{confidence === "HIGH" ? "✓" : confidence === "MEDIUM" ? "◔" : "▲"}</span>{enumLabel(confidence)}</span>;
}

// -------------------------------------------------------------- summary

export function renderExecutiveSummaryPage(input: {
  nav: NavContext;
  summary: ExecutiveSummary;
}): string {
  const s = input.summary;
  const periods: { key: string; label: string }[] = [
    { key: "WEEKLY", label: "Weekly" },
    { key: "MONTHLY", label: "Monthly" },
    { key: "BRIEFING", label: "Lender briefing" },
  ];
  return renderDocument(
    <AppShell title="Executive — Summary" nav={input.nav} context="AI executive intelligence (advisory)">
      <div className="page-wrap">
        <PageHeader
          title="Executive summary"
          sub="Assistive narrative composed deterministically from portfolio analytics — advisory, never a decision."
          asOf={`Generated ${fmtDate(s.generatedAt).slice(0, 16)} UTC · ${enumLabel(s.period)} view`}
        >
          {periods.map((p) => (
            <a
              className={`btn ${s.period === p.key ? "secondary" : "ghost"} sm`}
              href={`/executive/summary?period=${p.key.toLowerCase()}`}
            >
              {p.label}
            </a>
          ))}
        </PageHeader>
        <ExecTabs active="summary" />

        <section className="panel">
          <div className="panel-pad">
            <p className="exec-headline">{s.headline}</p>
          </div>
        </section>

        <div className="intel-duo">
          {s.sections.map((section) => (
            <section className="panel">
              <div className="panel-head"><h3>{section.title}</h3></div>
              <div className="panel-pad">
                <ul className="tl">
                  {section.lines.map((line) => (
                    <li><span className="tl-t">{line}</span></li>
                  ))}
                </ul>
              </div>
            </section>
          ))}
        </div>

        <p className="footer-note">{s.advisory}</p>
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}
