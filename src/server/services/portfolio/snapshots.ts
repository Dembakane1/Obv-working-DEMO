/**
 * Portfolio snapshots — append-only dated observations of the derived
 * portfolio state, scoped to the RECORDING VIEWER's organization. They
 * feed the historical growth/health series and are never an input to any
 * decision, eligibility evaluation, or package.
 */
import type { User } from "../../../shared/types";
import * as prepo from "../../db/portfolioRepo";
import { PortfolioContext, assertPortfolioViewer, buildPortfolioContext } from "./context";
import { portfolioOverview } from "./aggregate";
import { portfolioRisk } from "./riskEngine";

export interface SnapshotView {
  id: string;
  takenAt: string;
  takenByUserId: string;
  projectCount: number;
  activeProjectCount: number;
  totalBudget: number;
  totalReleased: number;
  totalPaidToDate: number;
  openExceptionCount: number;
  openDisputeCount: number;
  averageHealth: number;
  attentionCount: number;
}

export function recordSnapshot(user: User): SnapshotView {
  const ctx: PortfolioContext = buildPortfolioContext(user);
  const overview = portfolioOverview(ctx);
  const risk = portfolioRisk(ctx);
  const row: prepo.PortfolioSnapshotRow = {
    id: prepo.newId(),
    scopeOrganizationId: user.organizationId,
    takenByUserId: user.id,
    takenAt: ctx.generatedAt,
    projectCount: overview.totals.totalProjects,
    activeProjectCount: overview.totals.activeProjects,
    totalBudget: overview.totals.totalBudget,
    totalReleased: overview.totals.releasedAmount,
    totalPaidToDate: overview.totals.paidToDate,
    openExceptionCount: overview.totals.openExceptions,
    openDisputeCount: overview.totals.openDisputes,
    averageHealth: risk.averageHealth ?? 0,
    attentionCount: risk.attention.length,
    detail: {
      bands: risk.bands,
      budgetUtilizationPct: overview.totals.budgetUtilizationPct,
      fundingUtilizationPct: overview.totals.fundingUtilizationPct,
    },
  };
  prepo.insertPortfolioSnapshot(row);
  return toView(row);
}

export function listSnapshots(user: User): SnapshotView[] {
  // Same viewer-role gate as every other portfolio surface. The series
  // is additionally scoped to snapshots THIS USER recorded within their
  // organization: a snapshot aggregates the recorder's accessible
  // portfolio, and two users in one organization do not necessarily
  // share an accessible set (memberships are per-user), so an org-wide
  // listing could leak aggregate figures across access boundaries.
  assertPortfolioViewer(user);
  return prepo
    .listPortfolioSnapshots(user.organizationId)
    .filter((row) => row.takenByUserId === user.id)
    .map(toView);
}

function toView(row: prepo.PortfolioSnapshotRow): SnapshotView {
  return {
    id: row.id,
    takenAt: row.takenAt,
    takenByUserId: row.takenByUserId,
    projectCount: row.projectCount,
    activeProjectCount: row.activeProjectCount,
    totalBudget: row.totalBudget,
    totalReleased: row.totalReleased,
    totalPaidToDate: row.totalPaidToDate,
    openExceptionCount: row.openExceptionCount,
    openDisputeCount: row.openDisputeCount,
    averageHealth: row.averageHealth,
    attentionCount: row.attentionCount,
  };
}
