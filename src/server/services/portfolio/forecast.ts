/**
 * Project forecasting — deterministic projections from verified records.
 *
 * FORECASTS ARE SEPARATE FROM ACTUALS. Every function here returns a new
 * derived object; no stored project value, budget figure, schedule date,
 * or package is ever modified. Each forecast states its basis so a human
 * can audit the arithmetic. These are planning aids, not commitments.
 */
import { PortfolioContext, average, daysBetween, pct } from "./context";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export const FORECAST_ADVISORY =
  "Deterministic projections derived from verified records. Forecasts are stored nowhere, " +
  "never modify actual project values, and never authorize any decision.";

export interface ProjectForecast {
  projectId: string;
  projectName: string;
  basis: string[];
  finalCostForecast: number;
  projectedCompletionDate: string | null;
  plannedEnd: string | null;
  projectedSlipDays: number | null;
  remainingBudget: number;
  remainingFunding: number;
  scheduleConfidence: Confidence;
  budgetConfidence: Confidence;
  inspectionCompletionForecastDays: number | null;
  permitCompletionForecastDays: number | null;
  cashFlow: { month: string; expectedRelease: number }[];
}

export interface PortfolioForecast {
  generatedAt: string;
  advisory: string;
  totals: {
    finalCostForecast: number;
    remainingBudget: number;
    remainingFunding: number;
  };
  projects: ProjectForecast[];
}

function addDays(iso: string, days: number): string {
  const base = new Date(iso);
  base.setUTCDate(base.getUTCDate() + Math.round(days));
  return base.toISOString().slice(0, 10);
}

function nextMonths(fromIso: string, count: number): string[] {
  const months: string[] = [];
  const d = new Date(fromIso);
  d.setUTCDate(1);
  for (let i = 0; i < count; i += 1) {
    d.setUTCMonth(d.getUTCMonth() + 1);
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

export function projectForecast(ctx: PortfolioContext, projectId: string): ProjectForecast {
  const project = ctx.projectById.get(projectId);
  const now = ctx.generatedAt;
  const basis: string[] = [];

  const lines = (ctx.budgetLinesByProject().get(projectId) ?? []).filter((l) => l.active);
  const revised = lines.reduce((a, l) => a + l.originalBudget + l.approvedChanges, 0);
  const paid = lines.reduce((a, l) => a + l.paidToDate, 0);
  basis.push(`Revised budget = original + approved changes across ${lines.length} active budget lines`);

  // Final cost: revised budget + open CO exposure + any CTC shortfall.
  const openCoExposure = (ctx.changeOrdersByProject().get(projectId) ?? [])
    .filter((c) => ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED"].includes(c.status))
    .reduce((a, c) => a + c.requestedAmount, 0);
  if (openCoExposure > 0) basis.push(`Open change-order exposure of ${openCoExposure} included`);
  const ctcRows = ctx.ctcByProject().get(projectId) ?? [];
  const ctcTotal = ctcRows.reduce((a, c) => a + c.estimatedCostToComplete, 0);
  const remainingBudget = Math.max(0, revised - paid);
  const ctcShortfall = ctcRows.length > 0 ? Math.max(0, ctcTotal - remainingBudget) : 0;
  if (ctcShortfall > 0) basis.push(`Latest cost-to-complete estimates exceed remaining budget by ${ctcShortfall}`);
  const baseBudget = revised > 0 ? revised : project?.totalBudget ?? 0;
  const finalCostForecast = baseBudget + openCoExposure + ctcShortfall;

  // Remaining funding: tranche capital not yet released.
  let held = 0;
  let released = 0;
  for (const e of ctx.accountEventsByProject().get(projectId) ?? []) {
    if (e.type === "HELD") held += e.amount;
    if (e.type === "RELEASED") released += e.amount;
  }
  const remainingFunding = Math.max(0, (held > 0 ? held : project?.totalBudget ?? 0) - released);

  // Schedule: observed release pace vs planned span.
  const milestones = (ctx.milestonesByProject().get(projectId) ?? []).filter((m) => !m.archived);
  const totalWeight = milestones.reduce((a, m) => a + (m.weight ?? 1), 0);
  const releasedWeight = milestones
    .filter((m) => m.accountStatus === "RELEASED")
    .reduce((a, m) => a + (m.weight ?? 1), 0);
  const progressShare = totalWeight > 0 ? releasedWeight / totalWeight : 0;
  const plannedStart = project?.pilot?.plannedStart ?? null;
  const plannedEnd =
    project?.pilot?.plannedEnd ??
    milestones.map((m) => m.plannedEnd).filter((d): d is string => Boolean(d)).sort().at(-1) ??
    null;

  let projectedCompletionDate: string | null = null;
  let projectedSlipDays: number | null = null;
  if (plannedStart && plannedEnd) {
    const plannedSpan = daysBetween(plannedStart, plannedEnd);
    const elapsed = daysBetween(plannedStart, now);
    if (plannedSpan !== null && plannedSpan > 0 && elapsed !== null && elapsed > 0) {
      if (progressShare >= 1) {
        projectedCompletionDate = plannedEnd;
        projectedSlipDays = 0;
        basis.push("All milestone weight released — planned end retained");
      } else if (progressShare > 0) {
        const paceDays = elapsed / progressShare; // days per full completion at observed pace
        projectedCompletionDate = addDays(plannedStart, paceDays);
        projectedSlipDays = Math.round(paceDays - plannedSpan);
        basis.push(
          `Observed pace: ${Math.round(progressShare * 100)}% of milestone weight released after ${Math.round(elapsed)} days`
        );
      } else {
        // No releases yet: assume remaining span from today.
        projectedCompletionDate = addDays(now, plannedSpan);
        projectedSlipDays = Math.round(daysBetween(plannedEnd, projectedCompletionDate) ?? 0);
        basis.push("No releases yet — full planned span assumed from today");
      }
    }
  }

  const scheduleConfidence: Confidence =
    projectedSlipDays === null
      ? "LOW"
      : projectedSlipDays <= 14
        ? "HIGH"
        : projectedSlipDays <= 60
          ? "MEDIUM"
          : "LOW";
  const overrunShare = baseBudget > 0 ? pct(finalCostForecast - baseBudget, baseBudget) : 0;
  const ctcConfidences = ctcRows.map((c) => c.confidence);
  const budgetConfidence: Confidence =
    overrunShare <= 2 && !ctcConfidences.includes("LOW")
      ? "HIGH"
      : overrunShare <= 10
        ? "MEDIUM"
        : "LOW";

  // Inspection completion: open required inspections × average turnaround.
  const lineReqs = ctx.lineRequirementsByProject().get(projectId) ?? [];
  const openInspections = lineReqs.filter((r) =>
    ["REQUIRED_NOT_SCHEDULED", "SCHEDULED", "REINSPECTION_REQUIRED", "CORRECTION_REQUIRED", "PENDING_OFFICIAL_CONFIRMATION"].includes(
      r.status
    )
  );
  const observedTurnarounds = lineReqs
    .map((r) => daysBetween(r.scheduledDate, r.completedDate))
    .filter((d): d is number => d !== null && d >= 0);
  const govTurnarounds = (ctx.jurisdictionalInspectionsByProject().get(projectId) ?? [])
    .map((i) => daysBetween(i.scheduledAt, i.completedAt))
    .filter((d): d is number => d !== null && d >= 0);
  const inspectionPace = average([...observedTurnarounds, ...govTurnarounds]) ?? 14;
  const inspectionCompletionForecastDays =
    openInspections.length > 0 ? Math.round(openInspections.length * Math.max(3, inspectionPace)) : 0;

  // Permit completion: permits not yet issued × observed issuance lag.
  const permits = ctx.permitsByProject().get(projectId) ?? [];
  const pendingPermits = permits.filter((p) => ["DRAFT", "APPLIED", "UNKNOWN"].includes(p.status));
  const issuanceLags = permits
    .map((p) => daysBetween(p.createdAt, p.issuedAt))
    .filter((d): d is number => d !== null && d >= 0);
  const permitPace = average(issuanceLags) ?? 30;
  const permitCompletionForecastDays =
    pendingPermits.length > 0 ? Math.round(pendingPermits.length * Math.max(7, permitPace)) : 0;

  // Cash flow: unreleased milestone tranches spread over the projected
  // remaining span, ordered by milestone sequence.
  const unreleased = milestones
    .filter((m) => m.accountStatus !== "RELEASED")
    .sort((a, b) => a.seq - b.seq);
  const horizonMonths = 6;
  const months = nextMonths(now, horizonMonths);
  const cashFlow = months.map((month) => ({ month, expectedRelease: 0 }));
  if (unreleased.length > 0) {
    const remainingDays =
      projectedCompletionDate !== null ? Math.max(30, daysBetween(now, projectedCompletionDate) ?? 180) : 180;
    const monthsToFinish = Math.max(1, Math.min(horizonMonths, Math.ceil(remainingDays / 30)));
    const perBucket = Math.ceil(unreleased.length / monthsToFinish);
    unreleased.forEach((m, index) => {
      const bucket = Math.min(monthsToFinish - 1, Math.floor(index / perBucket));
      cashFlow[bucket].expectedRelease += m.trancheAmount;
    });
    basis.push(
      `Cash flow spreads ${unreleased.length} unreleased tranche(s) across ~${monthsToFinish} projected month(s)`
    );
  }

  return {
    projectId,
    projectName: project?.name ?? projectId,
    basis,
    finalCostForecast,
    projectedCompletionDate,
    plannedEnd,
    projectedSlipDays,
    remainingBudget,
    remainingFunding,
    scheduleConfidence,
    budgetConfidence,
    inspectionCompletionForecastDays,
    permitCompletionForecastDays,
    cashFlow,
  };
}

export function portfolioForecast(ctx: PortfolioContext): PortfolioForecast {
  const projects = ctx.projects.map((p) => projectForecast(ctx, p.id));
  return {
    generatedAt: ctx.generatedAt,
    advisory: FORECAST_ADVISORY,
    totals: {
      finalCostForecast: projects.reduce((a, p) => a + p.finalCostForecast, 0),
      remainingBudget: projects.reduce((a, p) => a + p.remainingBudget, 0),
      remainingFunding: projects.reduce((a, p) => a + p.remainingFunding, 0),
    },
    projects,
  };
}
