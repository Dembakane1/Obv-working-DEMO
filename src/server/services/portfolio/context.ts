/**
 * Portfolio Intelligence context.
 *
 * One PortfolioContext is built per request, scoped STRICTLY to the
 * viewer's accessible projects via the central authz predicate (the same
 * source of truth every other tenant boundary uses). Every analytics
 * engine receives this context and can therefore never observe a record
 * from a project the viewer could not open directly — cross-tenant
 * aggregates are impossible by construction, not by discipline.
 *
 * The context is read-only: engines derive figures and never write.
 */
import type { Project, User } from "../../../shared/types";
import * as authz from "../authz";
import * as prepo from "../../db/portfolioRepo";

export class PortfolioError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = "PortfolioError";
  }
}

/** Roles allowed to use portfolio intelligence (in-tenant capability gate;
 *  FIELD users have no review authority anywhere else in the app either). */
const VIEWER_ROLES = new Set(["FUNDER_REP", "PROJECT_MANAGER", "COMPLIANCE_REVIEWER"]);

export function assertPortfolioViewer(user: User): void {
  if (!VIEWER_ROLES.has(user.role)) {
    throw new PortfolioError(
      `Your role (${user.role}) is not authorized to view portfolio intelligence`,
      403
    );
  }
}

export interface PortfolioFilters {
  status?: string;
  state?: string;
  lenderOrgId?: string;
  contractorOrgId?: string;
  stage?: string;
  riskBand?: string;
}

// ------------------------------------------------------------ time helpers

/** Parse either full ISO timestamps or date-only YYYY-MM-DD values. */
export function ts(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function daysBetween(fromValue: string | null | undefined, toValue: string | null | undefined): number | null {
  const from = ts(fromValue);
  const to = ts(toValue);
  if (from === null || to === null) return null;
  return (to - from) / 86_400_000;
}

/** YYYY-MM bucket key for trend series. */
export function monthKey(value: string | null | undefined): string | null {
  if (!value || value.length < 7) return null;
  return value.slice(0, 7);
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return (numerator / denominator) * 100;
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, v) => a + v, 0) / values.length;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

function lazy<T>(load: () => T): () => T {
  let loaded = false;
  let value: T;
  return () => {
    if (!loaded) {
      value = load();
      loaded = true;
    }
    return value;
  };
}

// ---------------------------------------------------------------- context

export interface PortfolioContext {
  viewer: User;
  generatedAt: string;
  projects: Project[];
  projectIds: Set<string>;
  projectById: Map<string, Project>;
  orgs: () => Map<string, prepo.OrgRow>;
  users: () => Map<string, prepo.UserRow>;
  milestonesByProject: () => Map<string, prepo.MilestoneRow[]>;
  drawsByProject: () => Map<string, prepo.DrawRow[]>;
  drawById: () => Map<string, prepo.DrawRow>;
  linesByDraw: () => Map<string, prepo.DrawLineRow[]>;
  docsByDraw: () => Map<string, prepo.DrawDocumentRow[]>;
  decisionsByDraw: () => Map<string, prepo.LenderDecisionRow[]>;
  approvals: () => prepo.ApprovalRow[];
  exceptionsByProject: () => Map<string, prepo.ExceptionRow[]>;
  disputesByProject: () => Map<string, prepo.DisputeRow[]>;
  permitsByProject: () => Map<string, prepo.PermitRow[]>;
  jurisdictionByProject: () => Map<string, prepo.JurisdictionProfileRow>;
  drawInspectionsByProject: () => Map<string, prepo.DrawInspectionRow[]>;
  jurisdictionalInspectionsByProject: () => Map<string, prepo.JurisdictionalInspectionRow[]>;
  lineRequirementsByProject: () => Map<string, prepo.LineRequirementRow[]>;
  waiversByProject: () => Map<string, prepo.LienWaiverRow[]>;
  fundingByProject: () => Map<string, prepo.FundingRow[]>;
  loansByProject: () => Map<string, prepo.LoanAssetRow[]>;
  partiesByProject: () => Map<string, prepo.PartyAssignmentRow[]>;
  membershipsByProject: () => Map<string, prepo.MembershipRow[]>;
  budgetLinesByProject: () => Map<string, prepo.BudgetLineRow[]>;
  changeOrdersByProject: () => Map<string, prepo.ChangeOrderRow[]>;
  ctcByProject: () => Map<string, prepo.CtcRow[]>;
  evidenceStatsByMilestone: () => Map<string, prepo.EvidenceStatRow>;
  verificationStatsByMilestone: () => Map<string, prepo.VerificationStatRow>;
  duplicateEvidence: () => prepo.DuplicateEvidenceRow[];
  accountEventsByProject: () => Map<string, prepo.AccountEventRow[]>;
  drawAccountEventsByProject: () => Map<string, prepo.DrawAccountEventRow[]>;
  fieldIssuesByProject: () => Map<string, prepo.FieldIssueRow[]>;
  permitBasesByProject: () => Map<string, prepo.PermitBasisRow[]>;
  sourceVerificationsByProject: () => Map<string, prepo.SourceVerificationRow[]>;
  instructionsByDraw: () => Map<string, prepo.PaymentInstructionRow[]>;
  eventsByDraw: () => Map<string, prepo.DrawEventRow[]>;
}

/**
 * Build the per-request analytics context for a viewer. Tenancy is applied
 * here, once: only rows belonging to authz-accessible projects survive.
 */
export function buildPortfolioContext(viewer: User): PortfolioContext {
  assertPortfolioViewer(viewer);
  const projects = authz.accessibleProjects(viewer);
  const projectIds = new Set(projects.map((p) => p.id));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const inScope = <T extends { projectId: string }>(rows: T[]): T[] =>
    rows.filter((r) => projectIds.has(r.projectId));

  const milestonesByProject = lazy(() => groupBy(inScope(prepo.milestoneRows()), (m) => m.projectId));
  const drawsByProject = lazy(() => groupBy(inScope(prepo.drawRows()), (d) => d.projectId));
  const drawById = lazy(() => {
    const map = new Map<string, prepo.DrawRow>();
    for (const list of drawsByProject().values()) for (const d of list) map.set(d.id, d);
    return map;
  });
  const scopedMilestoneIds = lazy(() => {
    const ids = new Set<string>();
    for (const list of milestonesByProject().values()) for (const m of list) ids.add(m.id);
    return ids;
  });
  const byDraw = <T extends { drawRequestId: string }>(rows: T[]): Map<string, T[]> => {
    const draws = drawById();
    return groupBy(rows.filter((r) => draws.has(r.drawRequestId)), (r) => r.drawRequestId);
  };

  return {
    viewer,
    generatedAt: new Date().toISOString(),
    projects,
    projectIds,
    projectById,
    orgs: lazy(() => new Map(prepo.organizationRows().map((o) => [o.id, o]))),
    users: lazy(() => new Map(prepo.userRows().map((u) => [u.id, u]))),
    milestonesByProject,
    drawsByProject,
    drawById,
    linesByDraw: lazy(() => byDraw(prepo.drawLineRows())),
    docsByDraw: lazy(() => byDraw(prepo.drawDocumentRows())),
    decisionsByDraw: lazy(() => byDraw(inScope(prepo.lenderDecisionRows()))),
    approvals: lazy(() =>
      // Project ownership is resolved in SQL through whichever subject
      // pointer is set (milestone, draw, change order, retainage), so
      // every approval subject type is tenancy-filtered identically.
      prepo.approvalRows().filter((a) => a.projectId !== null && projectIds.has(a.projectId))
    ),
    exceptionsByProject: lazy(() => groupBy(inScope(prepo.exceptionRows()), (e) => e.projectId)),
    disputesByProject: lazy(() => groupBy(inScope(prepo.disputeRows()), (d) => d.projectId)),
    permitsByProject: lazy(() => groupBy(inScope(prepo.permitRows()), (p) => p.projectId)),
    jurisdictionByProject: lazy(
      () => new Map(inScope(prepo.jurisdictionProfileRows()).map((j) => [j.projectId, j]))
    ),
    drawInspectionsByProject: lazy(() => groupBy(inScope(prepo.drawInspectionRows()), (i) => i.projectId)),
    jurisdictionalInspectionsByProject: lazy(() =>
      groupBy(inScope(prepo.jurisdictionalInspectionRows()), (i) => i.projectId)
    ),
    lineRequirementsByProject: lazy(() => groupBy(inScope(prepo.lineRequirementRows()), (r) => r.projectId)),
    waiversByProject: lazy(() => groupBy(inScope(prepo.lienWaiverRows()), (w) => w.projectId)),
    fundingByProject: lazy(() => groupBy(inScope(prepo.fundingRows()), (f) => f.projectId)),
    loansByProject: lazy(() => groupBy(inScope(prepo.loanAssetRows()), (l) => l.projectId)),
    partiesByProject: lazy(() => groupBy(inScope(prepo.partyAssignmentRows()), (p) => p.projectId)),
    membershipsByProject: lazy(() => groupBy(inScope(prepo.membershipRows()), (m) => m.projectId)),
    budgetLinesByProject: lazy(() => groupBy(inScope(prepo.budgetLineRows()), (l) => l.projectId)),
    changeOrdersByProject: lazy(() => groupBy(inScope(prepo.changeOrderRows()), (c) => c.projectId)),
    ctcByProject: lazy(() => groupBy(inScope(prepo.latestCtcRows()), (c) => c.projectId)),
    evidenceStatsByMilestone: lazy(() => {
      const ids = scopedMilestoneIds();
      return new Map(
        prepo
          .evidenceStatRows()
          .filter((e) => ids.has(e.milestoneId))
          .map((e) => [e.milestoneId, e])
      );
    }),
    verificationStatsByMilestone: lazy(() => {
      const ids = scopedMilestoneIds();
      return new Map(
        prepo
          .verificationStatRows()
          .filter((v) => ids.has(v.milestoneId))
          .map((v) => [v.milestoneId, v])
      );
    }),
    duplicateEvidence: lazy(() => {
      const ids = scopedMilestoneIds();
      // A duplicate group is in scope when every referenced milestone is —
      // partially-visible groups are dropped rather than leak counts from
      // projects outside the viewer's tenancy.
      return prepo
        .duplicateEvidenceRows()
        .filter((d) => d.milestoneIds.split(",").every((id) => ids.has(id)));
    }),
    accountEventsByProject: lazy(() => groupBy(inScope(prepo.accountEventRows()), (e) => e.projectId)),
    drawAccountEventsByProject: lazy(() =>
      groupBy(inScope(prepo.drawAccountEventRows()), (e) => e.projectId)
    ),
    fieldIssuesByProject: lazy(() => groupBy(inScope(prepo.fieldIssueRows()), (f) => f.projectId)),
    permitBasesByProject: lazy(() => groupBy(inScope(prepo.permitBasisRows()), (b) => b.projectId)),
    sourceVerificationsByProject: lazy(() =>
      groupBy(inScope(prepo.sourceVerificationRows()), (v) => v.projectId)
    ),
    instructionsByDraw: lazy(() => byDraw(prepo.paymentInstructionRows())),
    eventsByDraw: lazy(() => byDraw(prepo.drawEventRows())),
  };
}

// ---------------------------------------------------------------- facets

export interface ProjectFacets {
  projectId: string;
  state: string;
  jurisdictions: string[];
  lenderOrgIds: string[];
  contractorOrgIds: string[];
  inspectorKeys: string[];
  stage: string;
}

/** Derived project lifecycle stage from released milestone weight. */
export function projectStage(ctx: PortfolioContext, projectId: string): string {
  const project = ctx.projectById.get(projectId);
  if (project && (project.status === "COMPLETED" || project.status === "SUSPENDED")) {
    return project.status === "COMPLETED" ? "CLOSEOUT" : "SUSPENDED";
  }
  const milestones = ctx.milestonesByProject().get(projectId) ?? [];
  const active = milestones.filter((m) => !m.archived);
  if (active.length === 0) return "SETUP";
  const totalWeight = active.reduce((a, m) => a + (m.weight ?? 1), 0);
  const releasedWeight = active
    .filter((m) => m.accountStatus === "RELEASED")
    .reduce((a, m) => a + (m.weight ?? 1), 0);
  const started = active.some((m) => m.status !== "NOT_STARTED");
  if (releasedWeight <= 0) return started ? "EARLY_CONSTRUCTION" : "SETUP";
  const share = pct(releasedWeight, totalWeight);
  if (share >= 100) return "CLOSEOUT";
  if (share >= 60) return "LATE_CONSTRUCTION";
  if (share >= 25) return "MID_CONSTRUCTION";
  return "EARLY_CONSTRUCTION";
}

export function projectFacets(ctx: PortfolioContext, projectId: string): ProjectFacets {
  const project = ctx.projectById.get(projectId);
  const jurisdiction = ctx.jurisdictionByProject().get(projectId);
  const permits = ctx.permitsByProject().get(projectId) ?? [];
  const loans = ctx.loansByProject().get(projectId) ?? [];
  const parties = ctx.partiesByProject().get(projectId) ?? [];
  const inspections = ctx.drawInspectionsByProject().get(projectId) ?? [];

  const state =
    jurisdiction?.state ??
    project?.pilot?.region ??
    project?.pilot?.country ??
    "UNSPECIFIED";

  const jurisdictions = new Set<string>();
  if (jurisdiction?.jurisdictionName) jurisdictions.add(jurisdiction.jurisdictionName);
  if (jurisdiction?.permitAuthority) jurisdictions.add(jurisdiction.permitAuthority);
  for (const permit of permits) if (permit.jurisdiction) jurisdictions.add(permit.jurisdiction);

  const lenderOrgIds = new Set<string>();
  for (const loan of loans) if (loan.lenderOrganizationId) lenderOrgIds.add(loan.lenderOrganizationId);
  for (const party of parties)
    if (party.active && party.partyType === "LENDER") lenderOrgIds.add(party.partyOrganizationId);
  if (project?.pilot?.funderOrgId) lenderOrgIds.add(project.pilot.funderOrgId);
  if (lenderOrgIds.size === 0 && project) lenderOrgIds.add(project.organizationId);

  const contractorOrgIds = new Set<string>();
  for (const loan of loans)
    if (loan.primaryContractorOrganizationId) contractorOrgIds.add(loan.primaryContractorOrganizationId);
  for (const party of parties)
    if (party.active && party.partyType === "CONTRACTOR") contractorOrgIds.add(party.partyOrganizationId);
  if (project?.pilot?.contractorOrgId) contractorOrgIds.add(project.pilot.contractorOrgId);

  const inspectorKeys = new Set<string>();
  for (const inspection of inspections) {
    if (inspection.inspectorUserId) inspectorKeys.add(`user:${inspection.inspectorUserId}`);
    else if (inspection.inspectorDisplayName) inspectorKeys.add(`name:${inspection.inspectorDisplayName}`);
  }
  for (const membership of ctx.membershipsByProject().get(projectId) ?? []) {
    if (membership.active && membership.participantType === "INSPECTOR")
      inspectorKeys.add(`user:${membership.userId}`);
  }

  return {
    projectId,
    state,
    jurisdictions: [...jurisdictions],
    lenderOrgIds: [...lenderOrgIds],
    contractorOrgIds: [...contractorOrgIds],
    inspectorKeys: [...inspectorKeys],
    stage: projectStage(ctx, projectId),
  };
}

/** Apply structural filters (risk-band filtering happens in the risk engine). */
export function filterProjects(
  ctx: PortfolioContext,
  filters: PortfolioFilters
): { projects: Project[]; facets: Map<string, ProjectFacets> } {
  const facets = new Map<string, ProjectFacets>();
  for (const project of ctx.projects) facets.set(project.id, projectFacets(ctx, project.id));
  const projects = ctx.projects.filter((project) => {
    const facet = facets.get(project.id)!;
    if (filters.status && project.status !== filters.status) return false;
    if (filters.state && facet.state !== filters.state) return false;
    if (filters.lenderOrgId && !facet.lenderOrgIds.includes(filters.lenderOrgId)) return false;
    if (filters.contractorOrgId && !facet.contractorOrgIds.includes(filters.contractorOrgId)) return false;
    if (filters.stage && facet.stage !== filters.stage) return false;
    return true;
  });
  return { projects, facets };
}
