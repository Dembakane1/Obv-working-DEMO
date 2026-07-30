/**
 * Portfolio snapshots — append-only dated observations of the derived
 * portfolio state, scoped to the RECORDING VIEWER's organization. They
 * feed the historical growth/health series and are never an input to any
 * decision, eligibility evaluation, or package.
 */
import type { User } from "../../../shared/types";
import * as prepo from "../../db/portfolioRepo";
import { PortfolioContext, buildPortfolioContext } from "./context";
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
  // Snapshots are scoped to the viewer's own organization — one tenant's
  // series is invisible to another's, matching the same-404 posture of
  // everything else in the portfolio layer.
  return prepo.listPortfolioSnapshots(user.organizationId).map(toView);
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
