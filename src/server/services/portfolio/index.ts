/**
 * Portfolio Intelligence facade — the single entry point for routes and
 * pages. All authorization happens here or deeper (service-level
 * enforcement): the viewer-role gate and tenancy scoping live in
 * buildPortfolioContext, and every entity/project detail lookup applies
 * the same-404 doctrine — an entity outside the viewer's accessible
 * portfolio is indistinguishable from one that does not exist.
 */
import type { User } from "../../../shared/types";
import {
  PortfolioContext,
  PortfolioError,
  PortfolioFilters,
  buildPortfolioContext,
} from "./context";
import { PortfolioOverview, portfolioOverview } from "./aggregate";
import {
  PortfolioRiskSummary,
  ProjectRiskProfile,
  portfolioRisk,
  projectRiskProfile,
} from "./riskEngine";
import {
  ContractorScorecard,
  InspectorScorecard,
  VendorScorecard,
  contractorIntelligence,
  inspectorIntelligence,
  vendorIntelligence,
} from "./entities";
import { PortfolioForecast, ProjectForecast, portfolioForecast, projectForecast } from "./forecast";
import { FraudIntelligence, fraudIntelligence } from "./fraud";
import { ExecutiveSummary, SummaryPeriod, executiveSummary } from "./summary";
import { GovernmentFoundationStatus, governmentFoundationStatus } from "./government";
import { SnapshotView, listSnapshots, recordSnapshot } from "./snapshots";
import { PortfolioControl, portfolioControl } from "./control";

export { PortfolioError } from "./context";
export type { PortfolioFilters } from "./context";
export type { PortfolioOverview } from "./aggregate";
export type { PortfolioRiskSummary, ProjectRiskProfile } from "./riskEngine";
export type { ContractorScorecard, InspectorScorecard, VendorScorecard } from "./entities";
export type { PortfolioForecast, ProjectForecast } from "./forecast";
export type { FraudIntelligence } from "./fraud";
export type { ExecutiveSummary, SummaryPeriod } from "./summary";
export type { GovernmentFoundationStatus } from "./government";
export type { SnapshotView } from "./snapshots";
export type {
  PortfolioControl,
  PortfolioCapital,
  ReadinessBucket,
  DomainPressure,
  CrossCuttingPressure,
  AttentionGroup,
  AttentionItem,
  PipelineBucket,
  RegisterRow,
  ControlChange,
  ProceededByException,
  SourceFreshness,
  TurnaroundMetrics,
} from "./control";
export { OPEN_DRAW_STATUSES, CAPITAL_INCLUSION_RULE, aggregateCapital } from "./control";
export { governmentFoundationStatus, governmentModuleEnabled, assertGovernmentEnabled } from "./government";
export { recordSnapshot, listSnapshots } from "./snapshots";

function requireScopedProject(ctx: PortfolioContext, projectId: string): void {
  // Same-404: an out-of-tenant project and a nonexistent one answer alike.
  if (!ctx.projectIds.has(projectId)) throw new PortfolioError("Project not found", 404);
}

export function overview(user: User, filters: PortfolioFilters = {}): PortfolioOverview {
  return portfolioOverview(buildPortfolioContext(user), filters);
}

/**
 * The governed draw-control read model for the Executive Command Center.
 * Aggregation only — every readiness figure comes from the Draw Readiness
 * Engine itself, and tenancy is applied by buildPortfolioContext before a
 * single row is grouped.
 */
export function control(user: User): PortfolioControl {
  return portfolioControl(buildPortfolioContext(user));
}

export function risk(user: User): PortfolioRiskSummary {
  return portfolioRisk(buildPortfolioContext(user));
}

export function projectRisk(user: User, projectId: string): ProjectRiskProfile {
  const ctx = buildPortfolioContext(user);
  requireScopedProject(ctx, projectId);
  return projectRiskProfile(ctx, projectId);
}

export function contractors(user: User): ContractorScorecard[] {
  return contractorIntelligence(buildPortfolioContext(user));
}

export function contractorDetail(user: User, organizationId: string): ContractorScorecard {
  const cards = contractorIntelligence(buildPortfolioContext(user));
  const card = cards.find((c) => c.organizationId === organizationId);
  if (!card) throw new PortfolioError("Contractor not found", 404);
  return card;
}

export function inspectors(user: User): InspectorScorecard[] {
  return inspectorIntelligence(buildPortfolioContext(user));
}

export function inspectorDetail(user: User, key: string): InspectorScorecard {
  const cards = inspectorIntelligence(buildPortfolioContext(user));
  const card = cards.find((c) => c.key === key);
  if (!card) throw new PortfolioError("Inspector not found", 404);
  return card;
}

export function vendors(user: User): VendorScorecard[] {
  return vendorIntelligence(buildPortfolioContext(user));
}

export function vendorDetail(user: User, key: string): VendorScorecard {
  const cards = vendorIntelligence(buildPortfolioContext(user));
  const card = cards.find((c) => c.key === key.toLowerCase());
  if (!card) throw new PortfolioError("Vendor not found", 404);
  return card;
}

export function forecast(user: User): PortfolioForecast {
  return portfolioForecast(buildPortfolioContext(user));
}

export function forecastForProject(user: User, projectId: string): ProjectForecast {
  const ctx = buildPortfolioContext(user);
  requireScopedProject(ctx, projectId);
  return projectForecast(ctx, projectId);
}

export function fraud(user: User): FraudIntelligence {
  return fraudView(buildPortfolioContext(user));
}

/** The fraud panel over an ALREADY-BUILT context, so a page assembling
 *  several engines pays for its scope resolution once. */
function fraudView(ctx: PortfolioContext): FraudIntelligence {
  const base = fraudIntelligence(ctx);
  // Risk clustering: projects where three or more dimensions sit at
  // ELEVATED or worse are themselves an anomaly pattern.
  const summary = portfolioRisk(ctx);
  const riskClusters = summary.projects
    .map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      elevatedDimensions: Object.values(p.dimensions)
        .filter((d) => d.score >= 50)
        .map((d) => d.dimension),
    }))
    .filter((c) => c.elevatedDimensions.length >= 3);
  return { ...base, riskClusters };
}

export function summary(user: User, period: SummaryPeriod): ExecutiveSummary {
  return executiveSummary(buildPortfolioContext(user), period);
}

export function government(user: User): GovernmentFoundationStatus {
  return governmentFoundationStatus(user);
}

// -------------------------------------------------------------- console

export interface ExecutiveConsoleData {
  overview: PortfolioOverview;
  control: PortfolioControl;
  risk: PortfolioRiskSummary;
  fraud: FraudIntelligence;
  government: GovernmentFoundationStatus;
  snapshots: SnapshotView[];
}

/**
 * ONE assembly for the Executive Command Center.
 *
 * Every panel on that page used to call its own `overview(user)` /
 * `risk(user)` / `fraud(user)` entry point, and each of those built its
 * own PortfolioContext — meaning the authz scope resolution and every
 * lazily-grouped table were rebuilt once per panel. This shares a single
 * context across all of them, the same way `executiveReportData` already
 * does, so the page pays for its rows once.
 *
 * Filters narrow the overview only, exactly as before: the risk register,
 * fraud panel and governed control model are portfolio-wide by design.
 */
export function executiveConsole(user: User, filters: PortfolioFilters = {}): ExecutiveConsoleData {
  const ctx = buildPortfolioContext(user);
  return {
    overview: portfolioOverview(ctx, filters),
    control: portfolioControl(ctx),
    risk: portfolioRisk(ctx),
    fraud: fraudView(ctx),
    government: governmentFoundationStatus(user),
    snapshots: listSnapshots(user),
  };
}

// ---------------------------------------------------------------- report

export interface ExecutiveReportData {
  generatedAt: string;
  generatedBy: User;
  overview: PortfolioOverview;
  risk: PortfolioRiskSummary;
  contractors: ContractorScorecard[];
  inspectors: InspectorScorecard[];
  forecast: PortfolioForecast;
  summary: ExecutiveSummary;
  snapshots: SnapshotView[];
}

/** One assembly for the exportable executive report (print HTML → PDF). */
export function executiveReportData(user: User): ExecutiveReportData {
  const ctx = buildPortfolioContext(user);
  return {
    generatedAt: ctx.generatedAt,
    generatedBy: user,
    overview: portfolioOverview(ctx),
    risk: portfolioRisk(ctx),
    contractors: contractorIntelligence(ctx),
    inspectors: inspectorIntelligence(ctx),
    forecast: portfolioForecast(ctx),
    summary: executiveSummary(ctx, "BRIEFING"),
    snapshots: listSnapshots(user),
  };
}
