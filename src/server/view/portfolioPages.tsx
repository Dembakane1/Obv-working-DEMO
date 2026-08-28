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
  PortfolioControl,
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

// ------------------------------------------- governed control vocabulary

/** The four readiness states, in words, with a grayscale-safe glyph. The
 *  state word is never abbreviated to a colour and never to a number. */
function readinessChip(status: string): VNode {
  const cls =
    status === "READY" ? "ok" : status === "HOLD" ? "bad" : status === "EXCEPTION_REVIEW" ? "warn" : "unknown";
  const glyph =
    status === "READY" ? "✓" : status === "HOLD" ? "!" : status === "EXCEPTION_REVIEW" ? "▲" : "?";
  return (
    <span className={`ec-state ${cls}`}>
      <span className="g">{glyph}</span>
      {status.replace(/_/g, " ")}
    </span>
  );
}

/** A control-domain state word. UNKNOWN is deliberately as loud as HOLD:
 *  missing information must never read healthier than a failed
 *  requirement. */
function domainStateChip(state: string): VNode {
  const cls =
    state === "HOLD" ? "bad" : state === "UNKNOWN" ? "unknown" : state === "WARNING" ? "warn" : state === "PASS" ? "ok" : "na";
  return <span className={`ec-dstate ${cls}`}>{state.replace(/_/g, " ")}</span>;
}

/**
 * The worst state a control domain is in, over the portfolio's open draws.
 *
 * This is the ENGINE's precedence — HOLD > UNKNOWN > WARNING > PASS > N/A —
 * applied to per-domain draw counts. NOT_APPLICABLE is the floor, never
 * PASS: a domain with no configured requirement has not passed anything,
 * and a portfolio with no open draws must not render four green domains.
 * Exported so the rule is testable on its own.
 */
export function domainWorstState(d: {
  holdDraws: number;
  unknownDraws: number;
  warningDraws: number;
  passDraws: number;
}): "HOLD" | "UNKNOWN" | "WARNING" | "PASS" | "NOT_APPLICABLE" {
  if (d.holdDraws > 0) return "HOLD";
  if (d.unknownDraws > 0) return "UNKNOWN";
  if (d.warningDraws > 0) return "WARNING";
  if (d.passDraws > 0) return "PASS";
  return "NOT_APPLICABLE";
}

const DOMAIN_LABEL: Record<string, string> = {
  PHYSICAL: "Physical",
  FINANCIAL: "Financial",
  COMPLIANCE: "Compliance",
  DOCUMENTS: "Documents",
};

const CATEGORY_LABEL: Record<string, string> = {
  EVIDENCE: "Field evidence",
  DRAW_INSPECTION: "Independent draw inspection",
  GOVERNMENT_INSPECTION: "Government inspection",
  PERMIT: "Permit",
  BUDGET: "Budget",
  CHANGE_ORDER: "Change order",
  RETAINAGE: "Retainage",
  DOCUMENT: "Required documents",
  LIEN: "Lien waivers",
  EXCEPTION: "Formal exceptions",
  PROJECT_CONTROL: "Project control",
  INTEGRITY: "Integrity",
};

/** A horizontal proportion bar built from counts. It carries no score:
 *  each segment is a labelled bucket of the SAME denominator, stated. */
function ProportionBar(props: { segments: Array<{ key: string; count: number; cls: string; title: string }> }): VNode {
  const total = props.segments.reduce((s, x) => s + x.count, 0);
  if (total <= 0) return <div className="ec-bar empty" aria-hidden="true"></div>;
  return (
    <div className="ec-bar" role="img" aria-label={props.segments.map((s) => s.title).join(", ")}>
      {props.segments
        .filter((s) => s.count > 0)
        .map((s) => (
          <span className={`seg ${s.cls}`} style={`width:${(s.count / total) * 100}%`} title={s.title}></span>
        ))}
    </div>
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
  /** The governed draw-control read model — capital, readiness, domain
   *  pressure, attention and history. Aggregated from the Draw Readiness
   *  Engine; never re-derived here. */
  control: PortfolioControl;
}): string {
  const { overview, risk, control } = input;
  const t = overview.totals;
  const cap = control.capital;
  const bucket = (status: string) =>
    control.readinessDistribution.find((b) => b.status === status) ?? {
      status,
      drawCount: 0,
      requested: 0,
      supportable: 0,
      shareOfDrawsPct: 0,
    };
  const ready = bucket("READY");
  const governedAttention = control.attention.filter((g) => g.count > 0);
  // The chip takes the worst tone actually present: a portfolio whose only
  // open condition is a draw awaiting a lender decision is not an alert.
  const attentionTone = governedAttention.some((g) => g.tone === "critical" || g.tone === "blocked")
    ? "bad"
    : governedAttention.some((g) => g.tone === "attention")
      ? "warn"
      : governedAttention.length > 0
        ? "ok"
        : "";
  const filtersActive = Object.values(input.filters).some((v) => v.length > 0);
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
          sub={`Portfolio capital control · construction lending · computed ${fmtDate(overview.generatedAt).slice(0, 16)} UTC`}
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

        {/* ---------- ROW 1: capital-control KPI rail ----------
             Six governed figures over ONE stated draw set. Nothing here is
             a score, and "supportable" is never called approved or funded. */}
        <KpiRail
          items={[
            {
              label: "Active projects",
              value: String(control.scope.activeProjectCount),
              detail: `of ${control.scope.projectCount} in your portfolio`,
              href: "/projects",
            },
            {
              label: "Open draws",
              value: String(control.scope.openDrawCount),
              detail: "submitted through governance",
              href: "/draws",
            },
            {
              label: "Requested — open draws",
              value: money(cap.requested),
              detail: "total requested",
            },
            {
              label: "Currently supportable",
              value: money(cap.supportable),
              detail: cap.coverageLabel
                ? `${cap.coverageLabel} of requested dollars`
                : "no requested dollars in scope",
              tone: "ok",
            },
            {
              label: "Currently unsupported",
              value: money(cap.unsupported),
              detail: "not yet supported by recorded review",
              tone: cap.unsupported > 0 ? "bad" : undefined,
            },
            {
              label: "Ready for lender review",
              value: String(ready.drawCount),
              detail: `${money(ready.requested)} requested`,
              tone: ready.drawCount > 0 ? "ok" : undefined,
            },
          ]}
        />

        {/* ---------- ROW 2: readiness · domain pressure · attention ---------- */}
        <div className="ws-row ws-row-3 ec-row-state">
          <DensePanel
            title="Readiness distribution"
            right={<span>{control.scope.openDrawCount} open draws</span>}
            foot={<a href="/draws">View all draws →</a>}
          >
            <ProportionBar
              segments={control.readinessDistribution.map((b) => ({
                key: b.status,
                count: b.drawCount,
                cls:
                  b.status === "READY" ? "ok" : b.status === "HOLD" ? "bad" : b.status === "EXCEPTION_REVIEW" ? "warn" : "unknown",
                title: `${b.status.replace(/_/g, " ")}: ${b.drawCount}`,
              }))}
            />
            <ul className="ec-dist">
              {control.readinessDistribution.map((b) => (
                <li className={b.drawCount === 0 ? "zero" : ""}>
                  {readinessChip(b.status)}
                  <span className="d-n num">{b.drawCount}</span>
                  <span className="d-s">
                    {b.drawCount === 1 ? "draw" : "draws"} · {b.shareOfDrawsPct}% of open draws
                  </span>
                  <span className="d-m num">{money(b.requested)}</span>
                  <span className="d-sup">
                    {money(b.supportable)} currently supportable
                    {b.drawCount > 0 && b.supportable < b.requested
                      ? ` · ${money(b.requested - b.supportable)} not yet supported`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
            <p className="ec-note">
              Four governed states, counted — never averaged into a single readiness figure.
              INCOMPLETE means OBV cannot reach a readiness conclusion at all.
            </p>
          </DensePanel>

          <DensePanel
            title="Control-domain pressure"
            right={<span>where draws are stuck</span>}
            foot={<span className="t-quiet">A draw blocked in two domains appears in both.</span>}
          >
            <ul className="ec-domains">
              {control.domains.map((d) => {
                const worst = domainWorstState(d);
                return (
                  <li>
                    <span className="dm-n">{DOMAIN_LABEL[d.domain] ?? d.domain}</span>
                    {domainStateChip(worst)}
                    <span className="dm-c">
                      {d.holdDraws > 0 ? <b className="bad">{d.holdDraws} HOLD</b> : null}
                      {d.unknownDraws > 0 ? <b className="unknown">{d.unknownDraws} unknown</b> : null}
                      {d.warningDraws > 0 ? <b className="warn">{d.warningDraws} warning</b> : null}
                      {worst === "PASS" ? <b className="ok">{d.passDraws} clear</b> : null}
                      {worst === "NOT_APPLICABLE" ? (
                        <b className="na">no requirement configured</b>
                      ) : null}
                    </span>
                    <span className="dm-cats">{d.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(" · ")}</span>
                  </li>
                );
              })}
            </ul>
            {control.crossCutting.blockedDraws > 0 || control.crossCutting.unknownDraws > 0 ? (
              <div className="ec-cross bad">
                <span className="x-k">Cross-cutting governed controls</span>
                <span className="x-v">
                  {control.crossCutting.blockerInstances} open on {control.crossCutting.blockedDraws}{" "}
                  {control.crossCutting.blockedDraws === 1 ? "draw" : "draws"}
                </span>
                <span className="x-d">
                  {control.crossCutting.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(" · ")} — outside the four
                  domains. All four domains can read clear while a draw is still blocked here.
                </span>
              </div>
            ) : (
              <div className="ec-cross">
                <span className="x-k">Cross-cutting governed controls</span>
                <span className="x-v">none open</span>
                <span className="x-d">
                  {control.crossCutting.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(" · ")} — outside the four
                  domains.
                </span>
              </div>
            )}
          </DensePanel>

          <DensePanel
            title="Governed attention"
            right={
              <span className={`chip ${attentionTone}`}>
                {String(governedAttention.length)} condition{governedAttention.length === 1 ? "" : "s"}
              </span>
            }
            flush
            foot={<a href="/draws">Open the draw queue →</a>}
          >
            <SignalList
              empty="No governed condition needs attention in your portfolio."
              items={governedAttention.map((g) => ({
                title: g.label,
                sub: g.unit,
                severity: g.tone === "critical" ? "high" : g.tone === "blocked" ? "high" : g.tone === "attention" ? "med" : "low",
                meta: <b className={g.tone === "ready" ? "ok" : g.tone === "attention" ? "warn" : "bad"}>{String(g.count)}</b>,
              }))}
            />
          </DensePanel>
        </div>

        {/* ---------- ROW 3: pipeline · capital position · history ---------- */}
        <div className="ws-row ws-row-3 ec-row-capital">
          <DensePanel title="Draw pipeline" right={<span>by workflow state</span>}>
            {control.pipeline.length === 0 ? (
              <p className="empty-mini">No open draws in scope.</p>
            ) : (
              <ul className="ec-pipe">
                {control.pipeline.map((p) => (
                  <li>
                    <span className="p-l">{p.label}</span>
                    <span className="p-bar">
                      <span className="fl" style={`width:${p.shareOfDrawsPct}%`}></span>
                    </span>
                    <span className="p-n num">
                      {p.drawCount} · {p.shareOfDrawsPct}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="ec-note">
              Recorded workflow position, from the deterministic next action. Percentages are shares of{" "}
              {control.scope.openDrawCount} open draws.
            </p>
          </DensePanel>

          <DensePanel title="Portfolio capital position" right={<span>open draws only</span>}>
            <ProportionBar
              segments={[
                { key: "cov", count: cap.covered, cls: "ok", title: `Covered: ${money(cap.covered)}` },
                { key: "uns", count: cap.unsupported, cls: "bad", title: `Unsupported: ${money(cap.unsupported)}` },
              ]}
            />
            <ul className="ec-cap">
              <li>
                <span className="c-l">Requested</span>
                <span className="c-v num">{money(cap.requested)}</span>
              </li>
              <li className="ok">
                <span className="c-l">Currently supportable</span>
                <span className="c-v num">{money(cap.supportable)}</span>
              </li>
              <li className="bad">
                <span className="c-l">Currently unsupported</span>
                <span className="c-v num">{money(cap.unsupported)}</span>
              </li>
              {cap.overSupported > 0 ? (
                <li className="warn">
                  <span className="c-l">Recorded support above the request</span>
                  <span className="c-v num">{money(cap.overSupported)}</span>
                </li>
              ) : null}
            </ul>
            <div className="ec-cov">
              <span className="cv">{cap.coverageLabel ?? "—"}</span>
              <span className="ck">
                {cap.coverageLabel
                  ? "of requested dollars currently supported"
                  : "no requested dollars in scope"}
              </span>
            </div>
            <p className="ec-note">
              Support coverage measures supported <b>dollars</b> only — never readiness, and never approval,
              authorization or settlement. Shortfalls are summed per draw, so a draw recording more support
              than it requested can never offset another draw's gap. {control.scope.inclusionRule}
            </p>
            {cap.overSupported > 0 ? (
              <p className="ec-note bad">
                At least one draw records more support than it requested. That is an inconsistency in the
                underlying records, shown here rather than netted away — open the affected draw to reconcile it.
              </p>
            ) : null}
          </DensePanel>

          <DensePanel
            title="Recent control changes"
            right={<span>governed records</span>}
            flush
            foot={<a href="/timeline">Open timeline →</a>}
          >
            <SignalList
              empty="No governed changes recorded in scope."
              items={control.recentChanges.map((c) => ({
                title:
                  c.kind === "READINESS_TRANSITION"
                    ? `Draw #${c.drawNumber} — ${c.label}`
                    : `Draw #${c.drawNumber} — ${c.label}`,
                sub: `${c.projectName.split("(")[0].trim().slice(0, 32)} · ${fmtDate(c.at).slice(0, 16)}`,
                severity:
                  c.kind === "READINESS_TRANSITION"
                    ? c.to === "READY"
                      ? "low"
                      : c.to === "INCOMPLETE"
                        ? "high"
                        : "med"
                    : "low",
                href: `/draw/${c.drawRequestId}`,
                meta:
                  c.kind === "READINESS_TRANSITION" ? (
                    <span className={`chip ${c.to === "READY" ? "ok" : c.to === "INCOMPLETE" ? "unknown" : "warn"}`}>
                      {c.to.replace(/_/g, " ")}
                    </span>
                  ) : null,
              }))}
            />
          </DensePanel>
        </div>

        {/* ---------- ROW 4: project attention register ---------- */}
        <DensePanel
          title="Project attention register"
          className="ec-register"
          right={<span>{control.register.length} open draws · worst readiness first</span>}
          flush
          foot={<span className="t-quiet">Readiness, blocker and next action come from the governed engine for each draw.</span>}
        >
          <DenseTable
            empty="No open draws in your portfolio."
            columns={[
              { key: "proj", label: "Project" },
              { key: "draw", label: "Draw" },
              { key: "req", label: "Requested", num: true },
              { key: "sup", label: "Supportable", num: true },
              { key: "state", label: "Readiness" },
              { key: "blk", label: "Primary blocker" },
              { key: "exc", label: "Exceptions", num: true },
              { key: "age", label: "Age", num: true },
              { key: "next", label: "Next action" },
            ]}
            rows={control.register.map((r) => ({
              proj: (
                <span className="t-name">
                  <a href={`/project/${r.projectId}`}>{r.projectName.split("(")[0].trim()}</a>
                  {r.jurisdiction ? <span className="sub">{r.jurisdiction}</span> : null}
                </span>
              ),
              draw: <a href={`/draw/${r.drawRequestId}`}>Draw #{r.drawNumber}</a>,
              req: money(r.requested),
              sup: money(r.supportable),
              state: readinessChip(r.status),
              blk: r.primaryBlocker ? (
                <span className="t-name">
                  <span>{r.primaryBlocker}</span>
                  {r.primaryBlockerCategory ? (
                    <span className="sub">{CATEGORY_LABEL[r.primaryBlockerCategory] ?? r.primaryBlockerCategory}</span>
                  ) : null}
                </span>
              ) : (
                <span className="t-quiet">—</span>
              ),
              exc: String(r.openExceptions),
              age: `${Math.round(r.ageDays)}d`,
              next: <span className="t-quiet">{r.nextAction}</span>,
            }))}
          />
        </DensePanel>

        {/* ---------- ROW 5: overrides · source freshness · turnaround ---------- */}
        <div className="ws-row ws-row-3 ec-row-record">
          <DensePanel
            title="Proceeded by exception"
            right={<span>{String(control.proceededByException.length)}</span>}
            flush
            foot={<span className="t-quiet">Decision-time snapshots — never recomputed from today's state.</span>}
          >
            <SignalList
              empty="No lender decision in scope overrode an outstanding requirement."
              items={control.proceededByException.map((p) => ({
                title: `Draw #${p.drawNumber} — ${p.decision.replace(/_/g, " ")}`,
                sub: `Readiness was ${p.statusAtDecision.replace(/_/g, " ")} · ${p.overriddenBlockerCount} requirement${p.overriddenBlockerCount === 1 ? "" : "s"} outstanding · ${p.decidedAt ? fmtDate(p.decidedAt).slice(0, 16) : "date not recorded"}`,
                severity: "high",
                href: `/draw/${p.drawRequestId}`,
                meta: <span className="chip warn">override</span>,
              }))}
            />
          </DensePanel>

          <DensePanel
            title="Official source freshness"
            right={<span>recorded lookups</span>}
            flush
            foot={<a href="/official-sources">Source workspace →</a>}
          >
            <SignalList
              empty="No projects in scope."
              items={control.freshness.map((f) => ({
                title: f.projectName.split("(")[0].trim(),
                sub: f.lastVerifiedAt
                  ? `${enumLabel(f.lastResultStatus ?? "")} · ${fmtDate(f.lastVerifiedAt).slice(0, 10)}${f.nextReviewDate ? ` · review due ${f.nextReviewDate}` : ""}`
                  : "No official-source lookup recorded",
                severity: f.reviewOverdue ? "med" : "low",
                meta: f.lastVerifiedAt ? (
                  f.reviewOverdue ? (
                    <span className="chip warn">review due</span>
                  ) : (
                    <span className="chip">recorded</span>
                  )
                ) : (
                  <span className="chip">not recorded</span>
                ),
              }))}
            />
            <p className="ec-note">
              Timestamps come from recorded official-source lookups. OBV sets no staleness threshold of its own —
              &ldquo;review due&rdquo; appears only where the record itself carries a review date that has passed, and it
              never changes readiness.
            </p>
          </DensePanel>

          <DensePanel title="Draw turnaround" right={<span>recorded timestamps</span>}>
            <Readout
              value={
                control.turnaround.medianSubmissionToDecisionDays === null
                  ? "—"
                  : `${control.turnaround.medianSubmissionToDecisionDays}d`
              }
              caption={
                control.turnaround.medianSubmissionToDecisionDays === null
                  ? "Insufficient recorded decisions"
                  : `median submission → decision (${control.turnaround.sampleSize} recorded)`
              }
              scores={[
                { label: "Recorded decision journeys", value: String(control.turnaround.sampleSize) },
                {
                  label: `Open draws aging beyond ${control.turnaround.agingThresholdDays} days`,
                  value: String(control.turnaround.agingDrawCount),
                  tone: control.turnaround.agingDrawCount > 0 ? "warn" : "ok",
                },
                { label: "Ready, awaiting lender decision", value: String(ready.drawCount) },
              ]}
            />
            <p className="ec-note">
              Measured from recorded submitted and decision timestamps only. Missing durations are never estimated.
            </p>
          </DensePanel>
        </div>

        {control.unevaluated.length > 0 ? (
          <div className="banner warn">
            {control.unevaluated.length} open draw{control.unevaluated.length === 1 ? "" : "s"} could not be evaluated
            and {control.unevaluated.length === 1 ? "is" : "are"} therefore excluded from every figure above:{" "}
            {control.unevaluated.map((u) => u.drawRequestId).join(", ")}.
          </div>
        ) : null}

        {/* ===== ADVISORY BAND — subordinate to governed control ===== */}
        <div className="ec-advisory">
        <SectionHead
          title="Advisory portfolio intelligence"
          hint="Analytics and pattern detection — never a governed control, never a lender approval signal"
        />

        {/* ---------- ROW 2: intelligence modules, side by side ---------- */}
        <div className="ws-row ws-row-3">
          <DensePanel
            title="Advisory signals"
            right={<span className="chip warn">{String(input.fraud.signalCount)} open</span>}
            flush
            foot={<a href="#advisory-register">Advisory risk register →</a>}
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
            foot={<a href="#advisory-register">Advisory risk register →</a>}
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
            foot={<a href="#advisory-register">Advisory risk register →</a>}
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
            right={<span id="advisory-register">{String(risk.projects.length)} projects · advisory · deterministic weights</span>}
            flush
            foot={<a href="/executive/entities">Contractor &amp; inspector detail →</a>}
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
