/**
 * AI Executive Intelligence — advisory narrative summaries.
 *
 * Summaries are generated DETERMINISTICALLY from the computed analytics
 * (aggregation, risk, forecasting, fraud) with template composition — the
 * same honest "assistive narrative, verifiable inputs" posture the rest
 * of OBV takes. Every summary carries the advisory statement below, is
 * stored nowhere, changes nothing, and NEVER approves a draw, makes a
 * lender decision, or replaces human judgment.
 */
import { PortfolioContext, daysBetween, ts } from "./context";
import { PortfolioOverview, portfolioOverview } from "./aggregate";
import { PortfolioRiskSummary, portfolioRisk } from "./riskEngine";
import { PortfolioForecast, portfolioForecast } from "./forecast";
import { FraudSignal, fraudSignals } from "./fraud";

export const SUMMARY_ADVISORY =
  "Advisory analysis derived from verified records. OBV does not approve draws, authorize payments, " +
  "issue lender decisions, or replace human review — every figure traces to stored records a reviewer can open.";

export type SummaryPeriod = "WEEKLY" | "MONTHLY" | "BRIEFING";

export interface SummarySection {
  key: string;
  title: string;
  lines: string[];
}

export interface ExecutiveSummary {
  generatedAt: string;
  period: SummaryPeriod;
  advisory: string;
  headline: string;
  sections: SummarySection[];
}

const money = (value: number): string => `$${Math.round(value).toLocaleString("en-US")}`;

function section(key: string, title: string, lines: string[]): SummarySection {
  return { key, title, lines: lines.length > 0 ? lines : ["Nothing notable in the current records."] };
}

export function executiveSummary(ctx: PortfolioContext, period: SummaryPeriod): ExecutiveSummary {
  const overview: PortfolioOverview = portfolioOverview(ctx);
  const risk: PortfolioRiskSummary = portfolioRisk(ctx);
  const forecast: PortfolioForecast = portfolioForecast(ctx);
  const signals: FraudSignal[] = fraudSignals(ctx);
  const now = ctx.generatedAt;

  const headline =
    `${overview.totals.activeProjects} active project(s), ${money(overview.totals.totalBudget)} under management, ` +
    `${money(overview.totals.releasedAmount)} released to date. Portfolio health ` +
    `${risk.averageHealth === null ? "n/a" : Math.round(risk.averageHealth)}/100 with ` +
    `${risk.attention.length} project(s) needing executive attention.`;

  // ---- highest risks ----------------------------------------------------
  const highestRisks = risk.attention.slice(0, 5).map((p) => {
    const top = p.topReasons[0];
    return `${p.projectName}: ${p.band} (risk ${p.overallRisk}/100)${top ? ` — ${top.label}` : ""}`;
  });

  // ---- fastest improving / worst performing -----------------------------
  const byHealth = [...risk.projects].sort((a, b) => b.health - a.health);
  const improving = byHealth
    .filter((p) => p.band === "STABLE")
    .slice(0, 3)
    .map((p) => `${p.projectName}: health ${p.health}/100 (${p.stage})`);
  const worst = [...risk.projects]
    .sort((a, b) => a.health - b.health)
    .slice(0, 3)
    .map((p) => {
      const top = p.topReasons[0];
      return `${p.projectName}: health ${p.health}/100${top ? ` — ${top.label}` : ""}`;
    });

  // ---- budget concerns --------------------------------------------------
  const budgetConcerns: string[] = [];
  for (const f of forecast.projects) {
    const project = ctx.projectById.get(f.projectId);
    const base = project?.totalBudget ?? 0;
    if (base > 0 && f.finalCostForecast > base) {
      budgetConcerns.push(
        `${f.projectName}: final cost forecast ${money(f.finalCostForecast)} vs ${money(base)} budget (${f.budgetConfidence} confidence)`
      );
    }
  }
  if (overview.totals.budgetUtilizationPct > 85) {
    budgetConcerns.push(`Portfolio budget utilization at ${overview.totals.budgetUtilizationPct}%`);
  }

  // ---- compliance concerns ---------------------------------------------
  const complianceConcerns: string[] = [];
  for (const p of risk.projects) {
    if (p.dimensions.compliance.score >= 25) {
      const top = p.dimensions.compliance.reasons[0];
      complianceConcerns.push(`${p.projectName}: ${top ? top.label : "elevated compliance risk"}`);
    }
  }

  // ---- funding bottlenecks ---------------------------------------------
  const bottlenecks: string[] = [];
  if (overview.totals.pendingApprovals > 0)
    bottlenecks.push(`${overview.totals.pendingApprovals} approval request(s) pending`);
  if (overview.totals.drawsInReview > 0)
    bottlenecks.push(`${overview.totals.drawsInReview} draw(s) in review`);
  for (const [drawId, decisions] of ctx.decisionsByDraw()) {
    const draw = ctx.drawById().get(drawId);
    if (!draw) continue;
    for (const d of decisions) {
      if (["APPROVED", "CONDITIONALLY_APPROVED", "REDUCED"].includes(d.decision)) {
        const funded = (ctx.fundingByProject().get(draw.projectId) ?? []).some(
          (f) => f.drawRequestId === drawId && f.status === "DISBURSED"
        );
        const released = (ctx.drawAccountEventsByProject().get(draw.projectId) ?? []).some(
          (e) => e.drawRequestId === drawId && e.type === "RELEASED"
        );
        if (!funded && !released) {
          const age = daysBetween(d.decisionAt, now);
          bottlenecks.push(
            `Draw #${draw.drawNumber} on ${ctx.projectById.get(draw.projectId)?.name ?? draw.projectId}: approved${
              age !== null ? ` ${Math.round(age)} day(s) ago` : ""
            } but no recorded funding or release`
          );
        }
      }
    }
  }

  // ---- emerging trends --------------------------------------------------
  const trends: string[] = [];
  const lastTwo = <T extends { month: string; opened: number }>(rows: T[]): [T, T] | null =>
    rows.length >= 2 ? [rows[rows.length - 2], rows[rows.length - 1]] : null;
  const exceptionPair = lastTwo(overview.trends.exceptions);
  if (exceptionPair && exceptionPair[1].opened > exceptionPair[0].opened)
    trends.push(
      `Exception volume rising: ${exceptionPair[0].opened} → ${exceptionPair[1].opened} month-over-month`
    );
  const disputePair = lastTwo(overview.trends.disputes);
  if (disputePair && disputePair[1].opened > disputePair[0].opened)
    trends.push(`Dispute volume rising: ${disputePair[0].opened} → ${disputePair[1].opened} month-over-month`);
  if (overview.trends.growth.length >= 2) {
    const [prev, last] = overview.trends.growth.slice(-2);
    trends.push(
      last.releasedInMonth >= prev.releasedInMonth
        ? `Release pace steady or rising (${money(last.releasedInMonth)} in ${last.month})`
        : `Release pace slowed (${money(prev.releasedInMonth)} → ${money(last.releasedInMonth)})`
    );
  }

  // ---- upcoming deadlines ----------------------------------------------
  const deadlines: string[] = [];
  const horizonDays = period === "WEEKLY" ? 14 : 45;
  const horizon = ts(now)! + horizonDays * 86_400_000;
  for (const [projectId, permits] of ctx.permitsByProject()) {
    const projectName = ctx.projectById.get(projectId)?.name ?? projectId;
    for (const p of permits) {
      const expiry = ts(p.expiresAt);
      if (expiry !== null && expiry <= horizon && expiry >= ts(now)! && !["CLOSED", "EXPIRED", "REVOKED"].includes(p.status)) {
        deadlines.push(`Permit ${p.permitType} on ${projectName} expires ${p.expiresAt}`);
      }
    }
  }
  for (const [projectId, inspections] of ctx.jurisdictionalInspectionsByProject()) {
    const projectName = ctx.projectById.get(projectId)?.name ?? projectId;
    for (const i of inspections) {
      const due = ts(i.correctionDueAt);
      if (due !== null && due <= horizon && !i.correctionClearedAt)
        deadlines.push(`Correction due ${i.correctionDueAt} on ${projectName}`);
    }
  }
  for (const [projectId, milestones] of ctx.milestonesByProject()) {
    const projectName = ctx.projectById.get(projectId)?.name ?? projectId;
    for (const m of milestones) {
      const end = ts(m.plannedEnd);
      if (end !== null && end >= ts(now)! && end <= horizon && m.accountStatus !== "RELEASED")
        deadlines.push(`Milestone "${m.title}" on ${projectName} planned to finish ${m.plannedEnd}`);
    }
  }

  // ---- fraud indicators -------------------------------------------------
  const fraudLines = signals
    .filter((s) => s.severity !== "LOW" || period === "BRIEFING")
    .slice(0, 8)
    .map((s) => `${s.severity}: ${s.label}${s.projectId ? ` (${ctx.projectById.get(s.projectId)?.name ?? s.projectId})` : ""}`);

  const sections: SummarySection[] = [
    section("risks", "Highest portfolio risks", highestRisks),
    section("improving", "Healthiest / fastest improving projects", improving),
    section("worst", "Weakest performing projects", worst),
    section("budget", "Budget concerns", budgetConcerns),
    section("compliance", "Compliance concerns", complianceConcerns),
    section("funding", "Funding bottlenecks", bottlenecks),
    section("trends", "Emerging trends", trends),
    section("deadlines", `Upcoming deadlines (next ${horizonDays} days)`, deadlines.slice(0, 10)),
    section("fraud", "Potential fraud indicators (advisory only)", fraudLines),
  ];

  return {
    generatedAt: ctx.generatedAt,
    period,
    advisory: SUMMARY_ADVISORY,
    headline,
    sections,
  };
}
