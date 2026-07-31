/** Executive Portfolio Report — print document (HTML → PDF via the
 *  existing Chromium pipeline). Grayscale-safe: state is always text,
 *  never color alone. Every figure derives from verified records in the
 *  generating viewer's accessible portfolio at generation time.
 */
import { h, Fragment, renderDocument, raw, VNode } from "./jsx";
import type { ExecutiveReportData } from "../services/portfolio";

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: "Inter", "Helvetica Neue", Arial, sans-serif; color: #151b26;
         font-size: 9.5pt; line-height: 1.45; margin: 0; }
  h1 { font-size: 19pt; margin: 0 0 2pt; letter-spacing: -0.02em; }
  h2 { font-size: 12.5pt; margin: 18pt 0 6pt; border-bottom: 1.2pt solid #151b26; padding-bottom: 3pt; }
  h3 { font-size: 10.5pt; margin: 10pt 0 4pt; }
  p { margin: 4pt 0; }
  .muted { color: #556070; }
  .small { font-size: 8pt; }
  table { width: 100%; border-collapse: collapse; margin: 6pt 0; }
  th { text-align: left; font-size: 7.6pt; text-transform: uppercase; letter-spacing: 0.06em;
       color: #556070; border-bottom: 1pt solid #cbd2dc; padding: 3pt 4pt; }
  td { border-bottom: 0.5pt solid #e2e6ec; padding: 3.5pt 4pt; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .tag { display: inline-block; border: 0.8pt solid #151b26; border-radius: 2pt;
         font-size: 7.4pt; padding: 0.5pt 3.5pt; text-transform: uppercase; letter-spacing: 0.05em; }
  .cover { padding: 40pt 0 0; }
  .cover-rule { border-top: 2.2pt solid #151b26; margin: 10pt 0 14pt; }
  .kpis { display: flex; gap: 14pt; flex-wrap: wrap; margin: 12pt 0; }
  .kpi { min-width: 110pt; }
  .kpi .v { font-size: 14pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  .kpi .l { font-size: 7.6pt; text-transform: uppercase; letter-spacing: 0.06em; color: #556070; }
  .statement { border: 0.8pt solid #cbd2dc; padding: 8pt 10pt; margin: 10pt 0; font-size: 8.4pt; }
  .page-break { break-after: page; }
  .avoid-break { break-inside: avoid; }
  ul { margin: 4pt 0 4pt 14pt; padding: 0; }
  li { margin: 2pt 0; }
`;

const money = (v: number): string => "$" + Math.round(v).toLocaleString("en-US");

export function renderExecutiveReportDoc(d: ExecutiveReportData): string {
  const t = d.overview.totals;
  const generated = d.generatedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return renderDocument(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Executive Portfolio Report</title>
        <style>{raw(CSS)}</style>
      </head>
      <body>
        {/* ---- cover ---- */}
        <section className="cover">
          <p className="small muted">OpenBuild Verify — Portfolio Intelligence</p>
          <h1>Executive Portfolio Report</h1>
          <p className="muted">
            Generated {generated} by {d.generatedBy.name} ({d.generatedBy.title})
          </p>
          <div className="cover-rule"></div>
          <div className="kpis">
            <div className="kpi"><div className="v">{t.activeProjects}</div><div className="l">Active projects</div></div>
            <div className="kpi"><div className="v">{money(t.totalBudget)}</div><div className="l">Portfolio budget</div></div>
            <div className="kpi"><div className="v">{money(t.releasedAmount)}</div><div className="l">Released to date</div></div>
            <div className="kpi"><div className="v">{t.budgetUtilizationPct}%</div><div className="l">Budget utilization</div></div>
            <div className="kpi">
              <div className="v">{d.risk.averageHealth === null ? "—" : Math.round(d.risk.averageHealth)}</div>
              <div className="l">Avg project health /100</div>
            </div>
            <div className="kpi"><div className="v">{d.risk.attention.length}</div><div className="l">Needs attention</div></div>
          </div>
          <div className="statement">
            Advisory portfolio analysis derived exclusively from verified project records within the
            generating user's accessible portfolio. Risk scores, forecasts, rankings and narrative
            summaries are deterministic reading aids: they never approve draws, never authorize
            payment, never alter records, and never replace human review.
          </div>
        </section>

        {/* ---- 1. portfolio summary ---- */}
        <section className="avoid-break">
          <h2>1 · Portfolio summary</h2>
          <table>
            <thead>
              <tr><th>Measure</th><th className="num">Value</th><th>Measure</th><th className="num">Value</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>Projects in scope</td><td className="num">{t.totalProjects}</td>
                <td>Open exceptions</td><td className="num">{t.openExceptions}</td>
              </tr>
              <tr>
                <td>Held (governed capital)</td><td className="num">{money(t.heldAmount)}</td>
                <td>Open disputes</td><td className="num">{t.openDisputes}</td>
              </tr>
              <tr>
                <td>Released</td><td className="num">{money(t.releasedAmount)}</td>
                <td>Pending approvals</td><td className="num">{t.pendingApprovals}</td>
              </tr>
              <tr>
                <td>Paid to date (budget lines)</td><td className="num">{money(t.paidToDate)}</td>
                <td>Draws in review</td><td className="num">{t.drawsInReview}</td>
              </tr>
              <tr>
                <td>Avg draw approval (days)</td>
                <td className="num">{d.overview.timing.averageDrawApprovalDays ?? "—"}</td>
                <td>Avg inspection turnaround (days)</td>
                <td className="num">
                  {d.overview.timing.averageIndependentInspectionTurnaroundDays ??
                    d.overview.timing.averageGovernmentInspectionTurnaroundDays ??
                    "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* ---- 2. risk register + heatmap ---- */}
        <section>
          <h2>2 · Risk register &amp; project heatmap</h2>
          <p className="small muted">
            Eight deterministic dimensions per project (0–100 risk points; higher is riskier).
            Bands: STABLE &lt;25 · WATCH 25–49 · ELEVATED 50–74 · CRITICAL ≥75.
          </p>
          <table>
            <thead>
              <tr>
                <th>Project</th><th>Band</th><th className="num">Health</th>
                <th className="num">Fin</th><th className="num">Comp</th><th className="num">Sched</th>
                <th className="num">Docs</th><th className="num">Insp</th><th className="num">Contr</th>
                <th className="num">Fraud</th><th className="num">Ops</th><th>Top signal</th>
              </tr>
            </thead>
            <tbody>
              {d.risk.projects.map((p) => (
                <tr>
                  <td>{p.projectName}</td>
                  <td><span className="tag">{p.band}</span></td>
                  <td className="num">{p.health}</td>
                  <td className="num">{p.dimensions.financial.score}</td>
                  <td className="num">{p.dimensions.compliance.score}</td>
                  <td className="num">{p.dimensions.schedule.score}</td>
                  <td className="num">{p.dimensions.documentation.score}</td>
                  <td className="num">{p.dimensions.inspection.score}</td>
                  <td className="num">{p.dimensions.contractor.score}</td>
                  <td className="num">{p.dimensions.fraud.score}</td>
                  <td className="num">{p.dimensions.operational.score}</td>
                  <td className="small">{p.topReasons[0]?.label ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* ---- 3. contractor rankings ---- */}
        <section className="avoid-break">
          <h2>3 · Contractor rankings</h2>
          {d.contractors.length === 0 ? (
            <p className="muted">No contractors of record in scope.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Contractor</th><th className="num">Overall</th><th className="num">Quality</th>
                  <th className="num">Docs</th><th className="num">Schedule</th><th className="num">Budget</th>
                  <th className="num">Inspection %</th><th className="num">Projects</th>
                </tr>
              </thead>
              <tbody>
                {d.contractors.map((c) => (
                  <tr>
                    <td>{c.name}</td>
                    <td className="num">{c.overallScore}</td>
                    <td className="num">{c.qualityScore}</td>
                    <td className="num">{c.documentationScore}</td>
                    <td className="num">{c.schedulePerformance}</td>
                    <td className="num">{c.budgetPerformance}</td>
                    <td className="num">{c.inspectionSuccessRatePct ?? "—"}</td>
                    <td className="num">{c.projects.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* ---- 4. inspector rankings ---- */}
        <section className="avoid-break">
          <h2>4 · Inspector rankings</h2>
          {d.inspectors.length === 0 ? (
            <p className="muted">No inspection records in scope.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Inspector</th><th>Source</th><th className="num">Inspections</th>
                  <th className="num">Pass %</th><th className="num">Correction %</th>
                  <th className="num">Turnaround (d)</th><th className="num">Open</th>
                </tr>
              </thead>
              <tbody>
                {d.inspectors.map((i) => (
                  <tr>
                    <td>{i.name}</td>
                    <td className="small">{i.source.replaceAll("_", " ")}</td>
                    <td className="num">{i.inspections}</td>
                    <td className="num">{i.passRatePct ?? "—"}</td>
                    <td className="num">{i.correctionRatePct ?? "—"}</td>
                    <td className="num">{i.averageTurnaroundDays ?? "—"}</td>
                    <td className="num">{i.openWorkload}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <div className="page-break"></div>

        {/* ---- 5. funding & compliance overview ---- */}
        <section className="avoid-break">
          <h2>5 · Funding overview</h2>
          <table>
            <thead><tr><th>Month</th><th className="num">Released in month</th><th className="num">Cumulative released</th></tr></thead>
            <tbody>
              {d.overview.trends.growth.length === 0 ? (
                <tr><td colspan="3" className="muted">No release history in scope.</td></tr>
              ) : (
                d.overview.trends.growth.map((g) => (
                  <tr>
                    <td>{g.month}</td>
                    <td className="num">{money(g.releasedInMonth)}</td>
                    <td className="num">{money(g.cumulativeReleased)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <section className="avoid-break">
          <h2>6 · Compliance &amp; trend overview</h2>
          <table>
            <thead>
              <tr><th>Series</th><th>Month</th><th className="num">Opened</th><th className="num">Resolved</th></tr>
            </thead>
            <tbody>
              {(
                [
                  ["Exceptions", d.overview.trends.exceptions],
                  ["Disputes", d.overview.trends.disputes],
                  ["Permits (issued/closed)", d.overview.trends.permits],
                  ["Compliance lookups (verified)", d.overview.trends.compliance],
                ] as const
              ).flatMap(([label, series]) =>
                series.length === 0
                  ? [
                      <tr>
                        <td>{label}</td>
                        <td className="muted" colspan="3">No dated records.</td>
                      </tr>,
                    ]
                  : series.slice(-4).map((point, index) => (
                      <tr>
                        <td>{index === 0 ? label : ""}</td>
                        <td>{point.month}</td>
                        <td className="num">{point.opened}</td>
                        <td className="num">{point.resolved}</td>
                      </tr>
                    ))
              )}
            </tbody>
          </table>
        </section>

        {/* ---- 7. forecast ---- */}
        <section className="avoid-break">
          <h2>7 · Forecast report</h2>
          <table>
            <thead>
              <tr>
                <th>Project</th><th className="num">Final cost forecast</th><th className="num">Remaining budget</th>
                <th>Projected completion</th><th className="num">Slip (d)</th><th>Sched conf.</th><th>Budget conf.</th>
              </tr>
            </thead>
            <tbody>
              {d.forecast.projects.map((p) => (
                <tr>
                  <td>{p.projectName}</td>
                  <td className="num">{money(p.finalCostForecast)}</td>
                  <td className="num">{money(p.remainingBudget)}</td>
                  <td>{p.projectedCompletionDate ?? "—"}</td>
                  <td className="num">{p.projectedSlipDays ?? "—"}</td>
                  <td><span className="tag">{p.scheduleConfidence}</span></td>
                  <td><span className="tag">{p.budgetConfidence}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">{d.forecast.advisory}</p>
        </section>

        {/* ---- 8. historical comparison ---- */}
        <section className="avoid-break">
          <h2>8 · Historical comparison (recorded snapshots)</h2>
          {d.snapshots.length === 0 ? (
            <p className="muted">No portfolio snapshots recorded yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Taken</th><th className="num">Projects</th><th className="num">Budget</th>
                  <th className="num">Released</th><th className="num">Open exceptions</th>
                  <th className="num">Avg health</th><th className="num">Attention</th>
                </tr>
              </thead>
              <tbody>
                {d.snapshots.map((s) => (
                  <tr>
                    <td>{s.takenAt.replace("T", " ").slice(0, 16)}</td>
                    <td className="num">{s.activeProjectCount}/{s.projectCount}</td>
                    <td className="num">{money(s.totalBudget)}</td>
                    <td className="num">{money(s.totalReleased)}</td>
                    <td className="num">{s.openExceptionCount}</td>
                    <td className="num">{Math.round(s.averageHealth)}</td>
                    <td className="num">{s.attentionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* ---- 9. executive narrative ---- */}
        <section>
          <h2>9 · Executive narrative ({d.summary.period.toLowerCase()} briefing)</h2>
          <p>{d.summary.headline}</p>
          {d.summary.sections.map((s) => (
            <div className="avoid-break">
              <h3>{s.title}</h3>
              <ul>
                {s.lines.map((line) => (
                  <li>{line}</li>
                ))}
              </ul>
            </div>
          ))}
          <div className="statement">{d.summary.advisory}</div>
        </section>
      </body>
    </html>
  );
}
