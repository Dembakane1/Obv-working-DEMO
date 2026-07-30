/**
 * Portfolio aggregation — the Executive Command Center read model.
 *
 * Every figure is summed or bucketed from verified primary records within
 * the viewer's accessible scope; nothing is stored, nothing is mutated,
 * and historical project records are never altered. Filters narrow the
 * project set BEFORE aggregation so a filtered view is exactly the
 * unfiltered computation over the smaller set.
 */
import {
  PortfolioContext,
  PortfolioFilters,
  ProjectFacets,
  average,
  daysBetween,
  filterProjects,
  monthKey,
  pct,
} from "./context";
import { RiskBand, portfolioRisk } from "./riskEngine";

export interface DistributionEntry {
  key: string;
  label: string;
  count: number;
  totalBudget: number;
}

export interface TrendPoint {
  month: string;
  opened: number;
  resolved: number;
}

export interface PortfolioOverview {
  generatedAt: string;
  scope: {
    viewerOrganizationId: string;
    filters: PortfolioFilters;
    projectCount: number;
    unfilteredProjectCount: number;
  };
  totals: {
    totalProjects: number;
    activeProjects: number;
    totalBudget: number;
    totalObvControlled: number;
    heldAmount: number;
    releasedAmount: number;
    paidToDate: number;
    revisedBudget: number;
    fundingUtilizationPct: number;
    budgetUtilizationPct: number;
    openExceptions: number;
    openDisputes: number;
    pendingApprovals: number;
    drawsInReview: number;
  };
  distributions: {
    byStatus: DistributionEntry[];
    byState: DistributionEntry[];
    byJurisdiction: DistributionEntry[];
    byLender: DistributionEntry[];
    byContractor: DistributionEntry[];
    byInspector: DistributionEntry[];
    byStage: DistributionEntry[];
    byRisk: DistributionEntry[];
    byType: DistributionEntry[];
  };
  timing: {
    averageDrawApprovalDays: number | null;
    averageLenderDecisionDays: number | null;
    averageIndependentInspectionTurnaroundDays: number | null;
    averageGovernmentInspectionTurnaroundDays: number | null;
  };
  trends: {
    exceptions: TrendPoint[];
    disputes: TrendPoint[];
    permits: TrendPoint[];
    compliance: TrendPoint[];
    draws: TrendPoint[];
    growth: { month: string; cumulativeReleased: number; releasedInMonth: number }[];
  };
}

function distribution(
  entries: Map<string, { label: string; count: number; totalBudget: number }>
): DistributionEntry[] {
  return [...entries.entries()]
    .map(([key, v]) => ({ key, label: v.label, count: v.count, totalBudget: v.totalBudget }))
    .sort((a, b) => b.count - a.count || b.totalBudget - a.totalBudget);
}

function add(
  map: Map<string, { label: string; count: number; totalBudget: number }>,
  key: string,
  label: string,
  budget: number
): void {
  const entry = map.get(key) ?? { label, count: 0, totalBudget: 0 };
  entry.count += 1;
  entry.totalBudget += budget;
  map.set(key, entry);
}

function trendSeries(
  rows: { openedAt: string; resolvedAt: string | null }[],
  months = 12
): TrendPoint[] {
  const buckets = new Map<string, TrendPoint>();
  for (const row of rows) {
    const opened = monthKey(row.openedAt);
    if (opened) {
      const b = buckets.get(opened) ?? { month: opened, opened: 0, resolved: 0 };
      b.opened += 1;
      buckets.set(opened, b);
    }
    const resolved = monthKey(row.resolvedAt);
    if (resolved) {
      const b = buckets.get(resolved) ?? { month: resolved, opened: 0, resolved: 0 };
      b.resolved += 1;
      buckets.set(resolved, b);
    }
  }
  return [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-months);
}

export function portfolioOverview(ctx: PortfolioContext, filters: PortfolioFilters = {}): PortfolioOverview {
  const { projects, facets } = filterProjects(ctx, filters);
  let scoped = projects;

  // Risk-band filter needs the risk engine; resolve bands once if asked.
  if (filters.riskBand) {
    const summary = portfolioRisk(ctx, projects);
    const matching = new Set(
      summary.projects.filter((p) => p.band === (filters.riskBand as RiskBand)).map((p) => p.projectId)
    );
    scoped = projects.filter((p) => matching.has(p.id));
  }
  const scopedIds = new Set(scoped.map((p) => p.id));

  // ------------------------------------------------------------- totals
  let heldAmount = 0;
  let releasedAmount = 0;
  for (const [projectId, events] of ctx.accountEventsByProject()) {
    if (!scopedIds.has(projectId)) continue;
    for (const e of events) {
      if (e.type === "HELD") heldAmount += e.amount;
      if (e.type === "RELEASED") releasedAmount += e.amount;
    }
  }
  let paidToDate = 0;
  let revisedBudget = 0;
  for (const [projectId, lines] of ctx.budgetLinesByProject()) {
    if (!scopedIds.has(projectId)) continue;
    for (const line of lines.filter((l) => l.active)) {
      paidToDate += line.paidToDate;
      revisedBudget += line.originalBudget + line.approvedChanges;
    }
  }
  const openExceptions = [...ctx.exceptionsByProject().entries()]
    .filter(([projectId]) => scopedIds.has(projectId))
    .flatMap(([, rows]) => rows)
    .filter((e) => !["RESOLVED", "CLOSED", "WAIVED"].includes(e.status)).length;
  const openDisputes = [...ctx.disputesByProject().entries()]
    .filter(([projectId]) => scopedIds.has(projectId))
    .flatMap(([, rows]) => rows)
    .filter((d) => !d.closedAt && !d.resolvedAt).length;
  const drawsInScope = [...ctx.drawsByProject().entries()]
    .filter(([projectId]) => scopedIds.has(projectId))
    .flatMap(([, rows]) => rows);
  const drawsInReview = drawsInScope.filter((d) =>
    ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED", "READY_FOR_GOVERNANCE"].includes(d.status)
  ).length;
  const pendingApprovals = ctx.approvals().filter((a) => {
    if (a.status !== "PENDING") return false;
    if (a.drawRequestId) return scopedIds.has(ctx.drawById().get(a.drawRequestId)?.projectId ?? "");
    if (a.milestoneId) {
      for (const [projectId, milestones] of ctx.milestonesByProject()) {
        if (!scopedIds.has(projectId)) continue;
        if (milestones.some((m) => m.id === a.milestoneId)) return true;
      }
    }
    return false;
  }).length;

  // ------------------------------------------------------ distributions
  const byStatus = new Map<string, { label: string; count: number; totalBudget: number }>();
  const byState = new Map<string, { label: string; count: number; totalBudget: number }>();
  const byJurisdiction = new Map<string, { label: string; count: number; totalBudget: number }>();
  const byLender = new Map<string, { label: string; count: number; totalBudget: number }>();
  const byContractor = new Map<string, { label: string; count: number; totalBudget: number }>();
  const byInspector = new Map<string, { label: string; count: number; totalBudget: number }>();
  const byStage = new Map<string, { label: string; count: number; totalBudget: number }>();
  const byType = new Map<string, { label: string; count: number; totalBudget: number }>();

  const orgName = (id: string): string => ctx.orgs().get(id)?.name ?? id;
  const userName = (id: string): string => ctx.users().get(id)?.name ?? id;

  for (const project of scoped) {
    const facet: ProjectFacets = facets.get(project.id)!;
    add(byStatus, project.status, project.status, project.totalBudget);
    add(byState, facet.state, facet.state, project.totalBudget);
    for (const j of facet.jurisdictions.length > 0 ? facet.jurisdictions : ["UNSPECIFIED"])
      add(byJurisdiction, j, j, project.totalBudget);
    for (const lender of facet.lenderOrgIds) add(byLender, lender, orgName(lender), project.totalBudget);
    for (const contractor of facet.contractorOrgIds.length > 0 ? facet.contractorOrgIds : ["(unassigned)"])
      add(
        byContractor,
        contractor,
        contractor === "(unassigned)" ? "No contractor of record" : orgName(contractor),
        project.totalBudget
      );
    for (const key of facet.inspectorKeys.length > 0 ? facet.inspectorKeys : ["(none)"]) {
      const label =
        key === "(none)"
          ? "No inspector on record"
          : key.startsWith("user:")
            ? userName(key.slice(5))
            : key.slice(5);
      add(byInspector, key, label, project.totalBudget);
    }
    add(byStage, facet.stage, facet.stage, project.totalBudget);
    add(byType, project.projectType, project.projectType, project.totalBudget);
  }

  const byRisk = new Map<string, { label: string; count: number; totalBudget: number }>();
  const riskSummary = portfolioRisk(ctx, scoped);
  for (const profile of riskSummary.projects)
    add(byRisk, profile.band, profile.band, profile.totalBudget);

  // ------------------------------------------------------------- timing
  const approvalDays: number[] = [];
  for (const draw of drawsInScope) {
    if (!draw.submittedAt) continue;
    const approvals = ctx
      .approvals()
      .filter((a) => a.drawRequestId === draw.id && a.status === "APPROVED" && a.decidedAt);
    for (const a of approvals) {
      const days = daysBetween(draw.submittedAt, a.decidedAt);
      if (days !== null && days >= 0) approvalDays.push(days);
    }
  }
  const decisionDays: number[] = [];
  for (const [drawId, decisions] of ctx.decisionsByDraw()) {
    const draw = ctx.drawById().get(drawId);
    if (!draw || !scopedIds.has(draw.projectId) || !draw.submittedAt) continue;
    for (const d of decisions) {
      if (!d.decisionAt || d.decision === "PENDING") continue;
      const days = daysBetween(draw.submittedAt, d.decisionAt);
      if (days !== null && days >= 0) decisionDays.push(days);
    }
  }
  const independentTurnaround: number[] = [];
  for (const [projectId, inspections] of ctx.drawInspectionsByProject()) {
    if (!scopedIds.has(projectId)) continue;
    for (const i of inspections) {
      const days = daysBetween(i.requestedAt, i.completedAt);
      if (days !== null && days >= 0) independentTurnaround.push(days);
    }
  }
  const governmentTurnaround: number[] = [];
  for (const [projectId, inspections] of ctx.jurisdictionalInspectionsByProject()) {
    if (!scopedIds.has(projectId)) continue;
    for (const i of inspections) {
      const days = daysBetween(i.scheduledAt, i.completedAt);
      if (days !== null && days >= 0) governmentTurnaround.push(days);
    }
  }

  // ------------------------------------------------------------- trends
  const scopedExceptions = [...ctx.exceptionsByProject().entries()]
    .filter(([projectId]) => scopedIds.has(projectId))
    .flatMap(([, rows]) => rows);
  const scopedDisputes = [...ctx.disputesByProject().entries()]
    .filter(([projectId]) => scopedIds.has(projectId))
    .flatMap(([, rows]) => rows);
  const scopedPermits = [...ctx.permitsByProject().entries()]
    .filter(([projectId]) => scopedIds.has(projectId))
    .flatMap(([, rows]) => rows);
  const scopedSourceVerifications = [...ctx.sourceVerificationsByProject().entries()]
    .filter(([projectId]) => scopedIds.has(projectId))
    .flatMap(([, rows]) => rows);

  const growthBuckets = new Map<string, number>();
  for (const [projectId, events] of ctx.accountEventsByProject()) {
    if (!scopedIds.has(projectId)) continue;
    for (const e of events) {
      if (e.type !== "RELEASED") continue;
      const month = monthKey(e.createdAt);
      if (month) growthBuckets.set(month, (growthBuckets.get(month) ?? 0) + e.amount);
    }
  }
  for (const [projectId, events] of ctx.drawAccountEventsByProject()) {
    if (!scopedIds.has(projectId)) continue;
    for (const e of events) {
      if (e.type !== "RELEASED") continue;
      const month = monthKey(e.createdAt);
      if (month) growthBuckets.set(month, (growthBuckets.get(month) ?? 0) + e.amount);
    }
  }
  let cumulative = 0;
  const growth = [...growthBuckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, releasedInMonth]) => {
      cumulative += releasedInMonth;
      return { month, cumulativeReleased: cumulative, releasedInMonth };
    });

  return {
    generatedAt: ctx.generatedAt,
    scope: {
      viewerOrganizationId: ctx.viewer.organizationId,
      filters,
      projectCount: scoped.length,
      unfilteredProjectCount: ctx.projects.length,
    },
    totals: {
      totalProjects: scoped.length,
      activeProjects: scoped.filter((p) => p.status === "ACTIVE").length,
      totalBudget: scoped.reduce((a, p) => a + p.totalBudget, 0),
      totalObvControlled: scoped.reduce((a, p) => a + (p.pilot?.obvControlledAmount ?? 0), 0),
      heldAmount,
      releasedAmount,
      paidToDate,
      revisedBudget,
      fundingUtilizationPct: Math.round(pct(releasedAmount, heldAmount + releasedAmount) * 10) / 10,
      budgetUtilizationPct: Math.round(pct(paidToDate, revisedBudget) * 10) / 10,
      openExceptions,
      openDisputes,
      pendingApprovals,
      drawsInReview,
    },
    distributions: {
      byStatus: distribution(byStatus),
      byState: distribution(byState),
      byJurisdiction: distribution(byJurisdiction),
      byLender: distribution(byLender),
      byContractor: distribution(byContractor),
      byInspector: distribution(byInspector),
      byStage: distribution(byStage),
      byRisk: distribution(byRisk),
      byType: distribution(byType),
    },
    timing: {
      averageDrawApprovalDays: round1(average(approvalDays)),
      averageLenderDecisionDays: round1(average(decisionDays)),
      averageIndependentInspectionTurnaroundDays: round1(average(independentTurnaround)),
      averageGovernmentInspectionTurnaroundDays: round1(average(governmentTurnaround)),
    },
    trends: {
      exceptions: trendSeries(scopedExceptions),
      disputes: trendSeries(scopedDisputes),
      permits: trendSeries(
        scopedPermits.map((p) => ({ openedAt: p.issuedAt ?? p.createdAt, resolvedAt: p.closedAt }))
      ),
      compliance: trendSeries(
        scopedSourceVerifications.map((v) => ({
          openedAt: v.lookupAt,
          resolvedAt: v.resultStatus === "VERIFIED_MATCH" ? v.lookupAt : null,
        }))
      ),
      draws: trendSeries(
        drawsInScope
          .filter((d) => d.submittedAt)
          .map((d) => ({
            openedAt: d.submittedAt!,
            resolvedAt: ["APPROVED", "RELEASED", "PARTIALLY_APPROVED"].includes(d.status) ? d.updatedAt : null,
          }))
      ),
      growth,
    },
  };
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}
