/** Executive Command Center — portfolio intelligence pages.
 *
 * Server-rendered like every other OBV surface: figures come from the
 * portfolio service (viewer-scoped, derived-only) and every number on
 * screen traces to stored records. Provenance and advisory captions are
 * part of the design, not an afterthought.
 */
import { h, Fragment, renderDocument, VNode } from "./jsx";
import {
  AboutView,
  AppShell,
  DensePanel,
  DenseTable,
  EmptyStateV2,
  FilterBar,
  KpiRail,
  Metric,
  MetricStrip,
  NavContext,
  PageHeader,
  Readout,
  SectionHead,
  SignalList,
  WorkHeader,
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
  /** Advisory Official Sources summary (derived, viewer-scoped).
   *  Absent when the caller cannot view Official Sources. */
  officialSources?: {
    coveragePct: number;
    openReviews: number;
    enforcementAlerts: number;
    licenseAlerts: number;
    conflictedProjects: number;
  } | null;
  /** Read-only project-history summary (derived, viewer-scoped). */
  projectHistory?: {
    totalEvents: number;
    projects: number;
    activeWeeks: number;
    busiestProject: { projectId: string; projectName: string; totalEvents: number } | null;
    lastActivityAt: string | null;
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

  const bandCount = (b: string) => risk.bands[b as keyof typeof risk.bands] ?? 0;
  const highRisk = risk.projects.filter((p) => p.band === "CRITICAL" || p.band === "ELEVATED");
  const sevIcon = (sev: string) => (sev === "HIGH" ? "high" : sev === "MEDIUM" ? "med" : "low");

  return renderDocument(
    <AppShell title="Executive" nav={input.nav} context="Portfolio command center">
      <div className="page-wrap ws">
        <WorkHeader
          title="Executive Command Center"
          sub={`Real-time overview of portfolio health, risk, and intelligence · computed ${fmtDate(overview.generatedAt).slice(0, 16)} UTC`}
        >
          <form method="POST" action="/api/portfolio/snapshots" className="hide-mobile">
            <button className="btn ghost sm" type="submit" data-busy-label="Recording…">Record snapshot</button>
          </form>
          {input.pdfAvailable ? (
            <form method="POST" action="/api/reports/executive">
              <button className="btn sm" type="submit" data-busy-label="Generating…">Export PDF</button>
            </form>
          ) : (
            <a className="btn sm" href="/executive/report/preview" target="_blank">Printable report</a>
          )}
        </WorkHeader>

        {input.notice ? (
          <div className={`banner ${input.notice.kind === "ok" ? "ok" : "warn"}`}>{input.notice.text}</div>
        ) : null}

        <ExecTabs active="overview" />

        {/* ---------- ROW 1: headline KPI rail ---------- */}
        <KpiRail
          items={[
            { label: "Total portfolio value", value: money(t.totalBudget), detail: `${t.activeProjects} active of ${t.totalProjects}` },
            {
              label: "Projects at risk",
              value: String(risk.attention.length),
              detail: `${bandCount("CRITICAL")} critical · ${bandCount("ELEVATED")} elevated`,
              tone: risk.attention.length > 0 ? "bad" : "ok",
              href: "/executive/risk",
            },
            { label: "Active draws", value: String(t.drawsInReview), detail: "in review", href: "/draws" },
            {
              label: "Pending approvals",
              value: String(t.pendingApprovals),
              detail: t.pendingApprovals > 0 ? "awaiting decision" : "queue clear",
              tone: t.pendingApprovals > 0 ? "warn" : undefined,
              href: "/approvals",
            },
            {
              label: "Open exceptions",
              value: String(t.openExceptions),
              detail: `${t.openDisputes} open dispute${t.openDisputes === 1 ? "" : "s"}`,
              tone: t.openExceptions > 0 ? "warn" : undefined,
              href: "/exceptions",
            },
            {
              label: "Released to date",
              value: money(t.releasedAmount),
              detail: `${t.fundingUtilizationPct}% of governed capital`,
            },
          ]}
        />

        {/* ---------- ROW 2: intelligence modules, side by side ---------- */}
        <div className="ws-row ws-row-3">
          <DensePanel
            title="Advisory signals"
            right={<span className="chip warn">{String(input.fraud.signalCount)} open</span>}
            flush
            foot={<a href="/executive/risk">View all signals →</a>}
          >
            <SignalList
              empty="No advisory anomaly signals in scope."
              items={input.fraud.signals.slice(0, 6).map((sg) => ({
                title: sg.label,
                sub: sg.entity ?? sg.detail.slice(0, 70),
                severity: sevIcon(sg.severity) as "high" | "med" | "low",
                href: sg.projectId ? `/project/${sg.projectId}` : undefined,
                meta: <span className={`chip ${sg.severity === "HIGH" ? "bad" : sg.severity === "MEDIUM" ? "warn" : ""}`}>{enumLabel(sg.severity)}</span>,
              }))}
            />
          </DensePanel>

          {input.evidenceQuality ? (
            <DensePanel
              title="Evidence intelligence overview"
              right={<span>advisory</span>}
              foot={<a href="/evidence-intelligence/analytics">Full intelligence →</a>}
            >
              <Readout
                value={`${input.evidenceQuality.averageQuality}`}
                caption="/100 average evidence quality"
                scores={[
                  { label: "Documentation completeness", value: `${input.evidenceQuality.averageCompleteness}/100`, pct: input.evidenceQuality.averageCompleteness, tone: input.evidenceQuality.averageCompleteness >= 70 ? "ok" : "warn" },
                  { label: "Verification confidence", value: `${input.evidenceQuality.averageConfidence}/100`, pct: input.evidenceQuality.averageConfidence, tone: input.evidenceQuality.averageConfidence >= 70 ? "ok" : "warn" },
                  { label: "Open advisory reviews", value: String(input.evidenceQuality.openReviews) },
                  { label: "Duplicate findings", value: String(input.evidenceQuality.duplicateFindings) },
                  input.evidenceQuality.topRepeated
                    ? { label: `Most repeated: ${enumLabel(input.evidenceQuality.topRepeated.category)}`, value: String(input.evidenceQuality.topRepeated.count) }
                    : { label: "Most repeated advisory", value: "—" },
                ]}
              />
            </DensePanel>
          ) : (
            <DensePanel title="Evidence intelligence overview">
              <p className="empty-mini">Not available for your role.</p>
            </DensePanel>
          )}

          <DensePanel
            title="Portfolio risk distribution"
            right={<span>{risk.averageHealth === null ? "—" : `${Math.round(risk.averageHealth)}/100 health`}</span>}
            flush
            foot={<a href="/executive/risk">Risk register →</a>}
          >
            <SignalList
              empty="No projects in scope."
              items={(["CRITICAL", "ELEVATED", "WATCH", "STABLE"] as const).map((band) => ({
                title: enumLabel(band),
                sub: `${bandCount(band)} project${bandCount(band) === 1 ? "" : "s"}`,
                severity: band === "CRITICAL" ? "high" : band === "ELEVATED" ? "med" : "low",
                meta: (
                  <span className="mini-bar" style="width:74px">
                    <span
                      className=""
                      style={`width:${risk.projectCount ? Math.round((bandCount(band) / risk.projectCount) * 100) : 0}%;background:${band === "CRITICAL" ? "var(--bad)" : band === "ELEVATED" ? "var(--warn)" : band === "WATCH" ? "var(--action)" : "var(--ok)"}`}
                    ></span>
                  </span>
                ),
              }))}
            />
          </DensePanel>
        </div>

        {/* ---------- ROW 3: compact operational modules ---------- */}
        <div className="ws-row ws-row-5">
          <DensePanel
            title="Projects needing attention"
            right={<span>{String(risk.attention.length)}</span>}
            flush
            foot={<a href="/projects">All projects →</a>}
          >
            <SignalList
              empty="No projects need executive attention."
              items={risk.attention.slice(0, 5).map((p) => ({
                title: p.projectName,
                sub: p.topReasons[0]?.label ?? `${enumLabel(p.stage)} · ${p.state}`,
                severity: p.band === "CRITICAL" ? "high" : "med",
                href: `/project/${p.projectId}`,
                meta: bandChip(p.band),
              }))}
            />
          </DensePanel>

          <DensePanel
            title="Draws needing review"
            right={<span>{String(t.drawsInReview)}</span>}
            foot={<a href="/draws">Draw queue →</a>}
          >
            <Readout
              value={String(t.drawsInReview)}
              caption="submitted or under review"
              scores={[
                { label: "Pending approvals", value: String(t.pendingApprovals) },
                { label: "Held capital", value: money(t.heldAmount) },
                { label: "Paid to date", value: money(t.paidToDate) },
              ]}
            />
          </DensePanel>

          {input.evidenceQuality ? (
            <DensePanel title="Evidence integrity" foot={<a href="/ledger">Evidence ledger →</a>}>
              <Readout
                value={`${input.evidenceQuality.averageCompleteness}%`}
                caption="documentation completeness"
                scores={[
                  { label: "Average quality", value: `${input.evidenceQuality.averageQuality}/100`, pct: input.evidenceQuality.averageQuality },
                  { label: "Open reviews", value: String(input.evidenceQuality.openReviews) },
                ]}
              />
            </DensePanel>
          ) : (
            <DensePanel title="Evidence integrity">
              <p className="empty-mini">Not available for your role.</p>
            </DensePanel>
          )}

          {input.officialSources ? (
            <DensePanel title="Official sources current" foot={<a href="/official-sources">Source workspace →</a>}>
              <Readout
                value={`${input.officialSources.coveragePct}%`}
                caption="permit official-record coverage"
                scores={[
                  { label: "Open source reviews", value: String(input.officialSources.openReviews) },
                  { label: "Enforcement alerts", value: String(input.officialSources.enforcementAlerts) },
                  { label: "Projects with conflicts", value: String(input.officialSources.conflictedProjects) },
                ]}
              />
            </DensePanel>
          ) : (
            <DensePanel title="Official sources current">
              <p className="empty-mini">Not available for your role.</p>
            </DensePanel>
          )}

          {input.projectHistory ? (
            <DensePanel title="Project history" foot={<a href="/timeline">Open timeline →</a>}>
              <Readout
                value={String(input.projectHistory.totalEvents)}
                caption="Recorded events"
                scores={[
                  { label: "Projects with history", value: String(input.projectHistory.projects) },
                  { label: "Active weeks", value: String(input.projectHistory.activeWeeks) },
                  input.projectHistory.busiestProject
                    ? { label: `Busiest: ${input.projectHistory.busiestProject.projectName}`, value: String(input.projectHistory.busiestProject.totalEvents) }
                    : { label: "Busiest project", value: "—" },
                  {
                    label: "Last activity",
                    value: input.projectHistory.lastActivityAt ? fmtDate(input.projectHistory.lastActivityAt).slice(0, 10) : "—",
                  },
                ]}
              />
            </DensePanel>
          ) : null}

          <DensePanel
            title="High-risk projects"
            right={<span>{String(highRisk.length)}</span>}
            flush
            foot={<a href="/executive/risk">Risk register →</a>}
          >
            <SignalList
              empty="No elevated or critical projects."
              items={highRisk.slice(0, 5).map((p) => ({
                title: p.projectName,
                sub: `${enumLabel(p.stage)} · health ${Math.round(p.health)}/100`,
                severity: p.band === "CRITICAL" ? "high" : "med",
                href: `/project/${p.projectId}`,
                meta: <b>{String(Math.round(p.overallRisk))}</b>,
              }))}
            />
          </DensePanel>
        </div>

        {/* ---------- filters + register (dense work surface) ---------- */}
        <FilterBar action="/executive" count={filtersActive ? "filtered" : undefined}>
          {select("state", input.filters.state, "All states", input.filterOptions.states.map((st) => ({ value: st, label: st })))}
          {select("stage", input.filters.stage, "All stages", input.filterOptions.stages.map((st) => ({ value: st, label: enumLabel(st) })))}
          {select("lender", input.filters.lender, "All lenders", input.filterOptions.lenders.map((l) => ({ value: l.id, label: l.name })))}
          {select("contractor", input.filters.contractor, "All contractors", input.filterOptions.contractors.map((c) => ({ value: c.id, label: c.name })))}
        </FilterBar>

        <div className="ws-row ws-row-2">
          <DensePanel
            title="Project risk register"
            right={<span>{String(risk.projects.length)} projects · deterministic weights</span>}
            flush
            foot={<a href="/executive/risk">Full register with dimension detail →</a>}
          >
            <DenseTable
              empty="No projects in scope."
              columns={[
                { key: "p", label: "Project" },
                { key: "band", label: "Band" },
                { key: "health", label: "Health", num: true },
                { key: "risk", label: "Risk", num: true },
                { key: "fin", label: "Financial", num: true },
                { key: "comp", label: "Compliance", num: true },
                { key: "doc", label: "Docs", num: true },
                { key: "fraud", label: "Fraud", num: true },
              ]}
              rows={risk.projects.slice(0, 12).map((p) => ({
                p: (
                  <span className="t-name">
                    <a href={`/project/${p.projectId}`}>{p.projectName}</a>
                    <span className="sub">{enumLabel(p.stage)} · {p.state}</span>
                  </span>
                ),
                band: bandChip(p.band),
                health: String(Math.round(p.health)),
                risk: String(Math.round(p.overallRisk)),
                fin: String(p.dimensions.financial.score),
                comp: String(p.dimensions.compliance.score),
                doc: String(p.dimensions.documentation.score),
                fraud: String(p.dimensions.fraud.score),
              }))}
            />
          </DensePanel>

          <div style="display:flex;flex-direction:column;gap:var(--ws-gap);min-width:0">
            <DensePanel
              title="Portfolio distribution"
              right={<span>by state · by lender</span>}
              flush
              foot={<a href="/executive/entities">Contractors, inspectors &amp; vendors →</a>}
            >
              <SignalList
                empty="No distribution data."
                items={[
                  ...overview.distributions.byState.slice(0, 4).map((dist) => ({
                    title: dist.label,
                    sub: `${dist.count} project${dist.count === 1 ? "" : "s"} · by state`,
                    severity: "low" as const,
                    meta: money(dist.totalBudget),
                  })),
                  ...overview.distributions.byLender.slice(0, 4).map((dist) => ({
                    title: dist.label,
                    sub: `${dist.count} project${dist.count === 1 ? "" : "s"} · Projects by lender`,
                    severity: "low" as const,
                    meta: money(dist.totalBudget),
                  })),
                ]}
              />
            </DensePanel>

            <DensePanel
              title="Operational trends"
              right={<span>opened vs resolved</span>}
              flush
            >
              <SignalList
                empty="No trend data in scope."
                items={[
                  ...overview.trends.exceptions.slice(-2).map((tr) => ({
                    title: `Exceptions · ${tr.month}`,
                    sub: `${tr.opened} opened · ${tr.resolved} resolved`,
                    severity: "low" as const,
                  })),
                  ...overview.trends.disputes.slice(-1).map((tr) => ({
                    title: `Disputes · ${tr.month}`,
                    sub: `${tr.opened} opened · ${tr.resolved} resolved`,
                    severity: "low" as const,
                  })),
                  ...overview.trends.draws.slice(-2).map((tr) => ({
                    title: `Draws · ${tr.month}`,
                    sub: `${tr.opened} submitted · ${tr.resolved} approved`,
                    severity: "low" as const,
                  })),
                  ...overview.trends.permits.slice(-1).map((tr) => ({
                    title: `Permits · ${tr.month}`,
                    sub: `${tr.opened} issued · ${tr.resolved} closed`,
                    severity: "low" as const,
                  })),
                ]}
              />
            </DensePanel>
            <DensePanel
              title="Recorded snapshots"
              right={<span>{String(input.snapshots.length)}</span>}
              flush
              foot={<span className="t-quiet">Point-in-time records; never recomputed.</span>}
            >
              <SignalList
                empty="No snapshots recorded yet."
                items={input.snapshots.slice(-5).reverse().map((sn) => ({
                  title: fmtDate(sn.takenAt).slice(0, 16),
                  sub: `${sn.activeProjectCount}/${sn.projectCount} active · health ${Math.round(sn.averageHealth)}`,
                  severity: "low",
                  meta: money(sn.totalReleased),
                }))}
              />
            </DensePanel>
          </div>
        </div>

        <AboutView label="About this view — provenance, advisory limits and methodology">
          <p>
            Every figure is computed on demand from verified project records within your accessible
            portfolio. Risk scores, forecasts and summaries are deterministic advisory reading aids —
            they never approve draws, never alter records, and never replace human review.
          </p>
          <p>{input.fraud.advisory}</p>
          <p>
            Government / infrastructure / donor / grant portfolio architecture: present, version{" "}
            {input.government.architectureVersion},{" "}
            {input.government.activationState.replaceAll("_", " ").toLowerCase()} — no government
            workflow is active.
          </p>
        </AboutView>
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
