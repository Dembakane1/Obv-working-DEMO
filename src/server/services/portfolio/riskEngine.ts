/**
 * Portfolio Risk Engine.
 *
 * Deterministic, explainable scoring derived exclusively from verified
 * records in the viewer's accessible portfolio. Higher score = higher
 * risk (0–100 per dimension). Overall project risk is a documented
 * weighted blend; Project Health = 100 − overall risk. Nothing here is
 * predictive ML and nothing here decides anything: scores are advisory
 * reading aids for human reviewers.
 */
import { PortfolioContext, ProjectFacets, projectFacets, average, clampScore, daysBetween, pct, ts } from "./context";
import { fraudSignalsForProject } from "./fraud";

export type RiskBand = "STABLE" | "WATCH" | "ELEVATED" | "CRITICAL";

export interface RiskReason {
  code: string;
  label: string;
  points: number;
}

export interface DimensionScore {
  dimension: string;
  score: number;
  band: RiskBand;
  reasons: RiskReason[];
}

export interface ProjectRiskProfile {
  projectId: string;
  projectName: string;
  status: string;
  stage: string;
  state: string;
  totalBudget: number;
  dimensions: {
    financial: DimensionScore;
    compliance: DimensionScore;
    schedule: DimensionScore;
    documentation: DimensionScore;
    inspection: DimensionScore;
    contractor: DimensionScore;
    fraud: DimensionScore;
    operational: DimensionScore;
  };
  overallRisk: number;
  health: number;
  band: RiskBand;
  topReasons: RiskReason[];
}

export interface PortfolioRiskSummary {
  generatedAt: string;
  projectCount: number;
  averageHealth: number | null;
  budgetWeightedHealth: number | null;
  bands: Record<RiskBand, number>;
  attention: ProjectRiskProfile[];
  projects: ProjectRiskProfile[];
  methodology: {
    weights: Record<string, number>;
    bands: string;
    note: string;
  };
}

export const RISK_WEIGHTS: Record<string, number> = {
  financial: 0.2,
  compliance: 0.15,
  schedule: 0.15,
  documentation: 0.1,
  inspection: 0.1,
  contractor: 0.1,
  fraud: 0.1,
  operational: 0.1,
};

export function band(score: number): RiskBand {
  if (score >= 75) return "CRITICAL";
  if (score >= 50) return "ELEVATED";
  if (score >= 25) return "WATCH";
  return "STABLE";
}

function dimension(name: string, reasons: RiskReason[]): DimensionScore {
  const score = clampScore(reasons.reduce((a, r) => a + r.points, 0));
  return { dimension: name, score, band: band(score), reasons: reasons.filter((r) => r.points > 0) };
}

const reason = (code: string, label: string, points: number): RiskReason => ({
  code,
  label,
  points: Math.max(0, Math.round(points)),
});

// ------------------------------------------------------------- dimensions

function financialRisk(ctx: PortfolioContext, projectId: string): DimensionScore {
  const reasons: RiskReason[] = [];
  const lines = (ctx.budgetLinesByProject().get(projectId) ?? []).filter((l) => l.active);
  const original = lines.reduce((a, l) => a + l.originalBudget, 0);
  const revised = lines.reduce((a, l) => a + l.originalBudget + l.approvedChanges, 0);
  const paid = lines.reduce((a, l) => a + l.paidToDate, 0);
  const committed = lines.reduce((a, l) => a + (l.committedAmount ?? 0), 0);

  if (revised > 0 && paid + committed > revised) {
    reasons.push(
      reason(
        "BUDGET_OVERCOMMIT",
        "Paid plus committed exceeds the revised budget",
        Math.min(40, pct(paid + committed - revised, revised) * 2)
      )
    );
  }
  if (original > 0 && revised > original * 1.15) {
    reasons.push(
      reason("CO_INFLATION", "Approved changes exceed 15% of the original budget", 20)
    );
  }
  const ctcRows = ctx.ctcByProject().get(projectId) ?? [];
  if (ctcRows.length > 0) {
    const ctcTotal = ctcRows.reduce((a, c) => a + c.estimatedCostToComplete, 0);
    const remaining = Math.max(0, revised - paid);
    if (ctcTotal > remaining && revised > 0) {
      reasons.push(
        reason(
          "CTC_SHORTFALL",
          "Estimated cost to complete exceeds remaining budget",
          Math.min(35, pct(ctcTotal - remaining, revised) * 1.5)
        )
      );
    }
  }
  const openCoExposure = (ctx.changeOrdersByProject().get(projectId) ?? [])
    .filter((c) => ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED"].includes(c.status))
    .reduce((a, c) => a + c.requestedAmount, 0);
  if (revised > 0 && openCoExposure > revised * 0.1) {
    reasons.push(reason("OPEN_CO_EXPOSURE", "Open change-order exposure above 10% of budget", 15));
  }
  const costExceptions = (ctx.exceptionsByProject().get(projectId) ?? []).filter(
    (e) => e.category === "COST" && !["RESOLVED", "CLOSED", "WAIVED"].includes(e.status)
  );
  if (costExceptions.length > 0) {
    reasons.push(reason("OPEN_COST_EXCEPTIONS", `${costExceptions.length} open cost exception(s)`, 10 + 5 * costExceptions.length));
  }
  return dimension("financial", reasons);
}

function complianceRisk(ctx: PortfolioContext, projectId: string): DimensionScore {
  const reasons: RiskReason[] = [];
  const now = ctx.generatedAt;
  const permits = ctx.permitsByProject().get(projectId) ?? [];
  const expired = permits.filter((p) => ["EXPIRED", "REVOKED", "SUSPENDED"].includes(p.status));
  if (expired.length > 0)
    reasons.push(reason("PERMIT_INVALID", `${expired.length} expired/revoked/suspended permit(s)`, 25 * expired.length));
  const unknown = permits.filter((p) => p.status === "UNKNOWN");
  if (unknown.length > 0)
    reasons.push(reason("PERMIT_UNKNOWN", `${unknown.length} permit(s) with unknown status`, 10 * unknown.length));
  const bases = ctx.permitBasesByProject().get(projectId) ?? [];
  const unresolved = bases.filter(
    (b) => b.status !== "SUPERSEDED" && b.governingBasis === "UNRESOLVED"
  );
  if (unresolved.length > 0)
    reasons.push(
      reason("BASIS_UNRESOLVED", `${unresolved.length} permit basis record(s) with unresolved governing code`, 15 * unresolved.length)
    );
  const sourceRows = ctx.sourceVerificationsByProject().get(projectId) ?? [];
  const overdueReviews = sourceRows.filter((v) => {
    const due = ts(v.nextReviewDate);
    return due !== null && due < ts(now)!;
  });
  if (overdueReviews.length > 0)
    reasons.push(reason("SOURCE_REVIEW_OVERDUE", `${overdueReviews.length} government-record verification(s) past next review date`, 8 * overdueReviews.length));
  const needsReview = sourceRows.filter((v) => v.resultStatus === "MANUAL_REVIEW_REQUIRED" || v.resultStatus === "NO_MATCH_FOUND");
  if (needsReview.length > 0)
    reasons.push(reason("SOURCE_NEEDS_REVIEW", `${needsReview.length} verification(s) needing manual review or with no matching record`, 8 * needsReview.length));
  const openCompliance = (ctx.exceptionsByProject().get(projectId) ?? []).filter(
    (e) => !["RESOLVED", "CLOSED", "WAIVED"].includes(e.status) && e.category !== "COST"
  );
  const weight = (sev: string): number => (sev === "CRITICAL" ? 12 : sev === "HIGH" ? 8 : sev === "MEDIUM" ? 4 : 2);
  const exceptionPoints = openCompliance.reduce((a, e) => a + weight(e.severity), 0);
  if (exceptionPoints > 0)
    reasons.push(reason("OPEN_EXCEPTIONS", `${openCompliance.length} open exception(s) weighted by severity`, exceptionPoints));
  return dimension("compliance", reasons);
}

function scheduleRisk(ctx: PortfolioContext, projectId: string): DimensionScore {
  const reasons: RiskReason[] = [];
  const now = ctx.generatedAt;
  const project = ctx.projectById.get(projectId);
  const milestones = (ctx.milestonesByProject().get(projectId) ?? []).filter((m) => !m.archived);
  const overdue = milestones.filter((m) => {
    const end = ts(m.plannedEnd);
    return end !== null && end < ts(now)! && m.accountStatus !== "RELEASED";
  });
  if (overdue.length > 0)
    reasons.push(reason("MILESTONES_OVERDUE", `${overdue.length} milestone(s) past planned end without release`, 12 * overdue.length));
  const projectEnd = ts(project?.pilot?.plannedEnd ?? null);
  if (projectEnd !== null && projectEnd < ts(now)! && project?.status === "ACTIVE") {
    reasons.push(reason("PROJECT_PAST_PLANNED_END", "Project is past its planned end date and still active", 20));
  }
  const draws = ctx.drawsByProject().get(projectId) ?? [];
  const staleDraws = draws.filter((d) => {
    if (!["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED"].includes(d.status)) return false;
    const age = daysBetween(d.submittedAt ?? d.createdAt, now);
    return age !== null && age > 21;
  });
  if (staleDraws.length > 0)
    reasons.push(reason("STALE_DRAWS", `${staleDraws.length} draw(s) in review longer than 21 days`, 10 * staleDraws.length));
  const scheduleExceptions = (ctx.exceptionsByProject().get(projectId) ?? []).filter(
    (e) => e.category === "SCHEDULE" && !["RESOLVED", "CLOSED", "WAIVED"].includes(e.status)
  );
  if (scheduleExceptions.length > 0)
    reasons.push(reason("SCHEDULE_EXCEPTIONS", `${scheduleExceptions.length} open schedule exception(s)`, 8 * scheduleExceptions.length));
  const coDelay = (ctx.changeOrdersByProject().get(projectId) ?? [])
    .filter((c) => ["APPROVED", "IMPLEMENTED"].includes(c.status))
    .reduce((a, c) => a + Math.max(0, c.scheduleImpactDays ?? 0), 0);
  if (coDelay > 30) reasons.push(reason("CO_SCHEDULE_IMPACT", `Approved change orders add ${coDelay} schedule days`, 12));
  return dimension("schedule", reasons);
}

function documentationRisk(ctx: PortfolioContext, projectId: string): DimensionScore {
  const reasons: RiskReason[] = [];
  const draws = ctx.drawsByProject().get(projectId) ?? [];
  let rejectedDocs = 0;
  let expiredDocs = 0;
  for (const draw of draws) {
    for (const doc of ctx.docsByDraw().get(draw.id) ?? []) {
      if (doc.status === "REJECTED") rejectedDocs += 1;
      if (doc.status === "EXPIRED") expiredDocs += 1;
    }
  }
  if (rejectedDocs > 0) reasons.push(reason("DOCS_REJECTED", `${rejectedDocs} rejected draw document(s)`, 8 * rejectedDocs));
  if (expiredDocs > 0) reasons.push(reason("DOCS_EXPIRED", `${expiredDocs} expired draw document(s)`, 6 * expiredDocs));
  const waivers = ctx.waiversByProject().get(projectId) ?? [];
  const missingWaivers = waivers.filter((w) => ["REQUIRED", "REQUESTED"].includes(w.status));
  if (missingWaivers.length > 0)
    reasons.push(reason("WAIVERS_OUTSTANDING", `${missingWaivers.length} lien waiver(s) required but not received`, 8 * missingWaivers.length));
  const rejectedWaivers = waivers.filter((w) => w.status === "REJECTED");
  if (rejectedWaivers.length > 0)
    reasons.push(reason("WAIVERS_REJECTED", `${rejectedWaivers.length} rejected lien waiver(s)`, 10 * rejectedWaivers.length));
  const milestones = (ctx.milestonesByProject().get(projectId) ?? []).filter((m) => !m.archived);
  const evidenceStats = ctx.evidenceStatsByMilestone();
  const inProgress = milestones.filter((m) => !["NOT_STARTED"].includes(m.status));
  const withoutEvidence = inProgress.filter((m) => (evidenceStats.get(m.id)?.total ?? 0) === 0);
  if (inProgress.length > 0 && withoutEvidence.length > 0) {
    reasons.push(
      reason(
        "EVIDENCE_SPARSE",
        `${withoutEvidence.length} started milestone(s) without any evidence on file`,
        Math.min(30, 10 * withoutEvidence.length)
      )
    );
  }
  const docExceptions = (ctx.exceptionsByProject().get(projectId) ?? []).filter(
    (e) => e.category === "DOCUMENT" && !["RESOLVED", "CLOSED", "WAIVED"].includes(e.status)
  );
  if (docExceptions.length > 0)
    reasons.push(reason("DOC_EXCEPTIONS", `${docExceptions.length} open document exception(s)`, 8 * docExceptions.length));
  return dimension("documentation", reasons);
}

function inspectionRisk(ctx: PortfolioContext, projectId: string): DimensionScore {
  const reasons: RiskReason[] = [];
  const now = ctx.generatedAt;
  const jurisdictional = ctx.jurisdictionalInspectionsByProject().get(projectId) ?? [];
  const failed = jurisdictional.filter((i) => ["FAILED", "CORRECTIONS_REQUIRED"].includes(i.status));
  if (failed.length > 0)
    reasons.push(reason("GOV_INSPECTION_FAILED", `${failed.length} government inspection(s) failed or requiring corrections`, 15 * failed.length));
  const overdueCorrections = jurisdictional.filter((i) => {
    const due = ts(i.correctionDueAt);
    return due !== null && due < ts(now)! && !i.correctionClearedAt;
  });
  if (overdueCorrections.length > 0)
    reasons.push(reason("CORRECTIONS_OVERDUE", `${overdueCorrections.length} correction notice(s) past due`, 12 * overdueCorrections.length));
  const lineReqs = ctx.lineRequirementsByProject().get(projectId) ?? [];
  const lineTrouble = lineReqs.filter((r) =>
    ["FAILED", "CORRECTION_REQUIRED", "REINSPECTION_REQUIRED", "NOT_FOUND"].includes(r.status)
  );
  if (lineTrouble.length > 0)
    reasons.push(reason("LINE_INSPECTION_ISSUES", `${lineTrouble.length} required inspection(s) failed, needing correction, or not found`, 10 * lineTrouble.length));
  const partial = lineReqs.filter((r) => r.status === "PARTIAL");
  if (partial.length > 0)
    reasons.push(reason("PARTIAL_PASSES", `${partial.length} partial inspection pass(es) — payment-blocking`, 8 * partial.length));
  const independent = ctx.drawInspectionsByProject().get(projectId) ?? [];
  const independentTrouble = independent.filter((i) =>
    ["FAILED", "CORRECTION_REQUIRED", "REINSPECTION_REQUIRED", "ACCESS_FAILED"].includes(i.status)
  );
  if (independentTrouble.length > 0)
    reasons.push(reason("DRAW_INSPECTION_ISSUES", `${independentTrouble.length} independent draw inspection(s) with adverse status`, 10 * independentTrouble.length));
  return dimension("inspection", reasons);
}

function contractorRiskDim(ctx: PortfolioContext, projectId: string, facets: ProjectFacets): DimensionScore {
  const reasons: RiskReason[] = [];
  // Cross-project signal: exceptions and disputes on OTHER projects that
  // share this project's contractor(s). Derived from verified records only.
  for (const contractorOrgId of facets.contractorOrgIds) {
    let otherProjectsWithIssues = 0;
    for (const other of ctx.projects) {
      if (other.id === projectId) continue;
      const otherFacets = projectFacets(ctx, other.id);
      if (!otherFacets.contractorOrgIds.includes(contractorOrgId)) continue;
      const open = (ctx.exceptionsByProject().get(other.id) ?? []).filter(
        (e) => !["RESOLVED", "CLOSED", "WAIVED"].includes(e.status)
      );
      const disputes = (ctx.disputesByProject().get(other.id) ?? []).filter(
        (d) => !d.closedAt && !d.resolvedAt
      );
      if (open.length > 0 || disputes.length > 0) otherProjectsWithIssues += 1;
    }
    if (otherProjectsWithIssues > 0) {
      const org = ctx.orgs().get(contractorOrgId);
      reasons.push(
        reason(
          "CONTRACTOR_CROSS_PROJECT",
          `Contractor ${org?.name ?? contractorOrgId} has open issues on ${otherProjectsWithIssues} other project(s)`,
          15 * otherProjectsWithIssues
        )
      );
    }
  }
  if (facets.contractorOrgIds.length === 0) {
    const hasLenderRecords = (ctx.loansByProject().get(projectId) ?? []).length > 0;
    if (hasLenderRecords)
      reasons.push(reason("CONTRACTOR_UNASSIGNED", "Loan is active but no contractor of record is assigned", 10));
  }
  const claimGaps: number[] = [];
  for (const draw of ctx.drawsByProject().get(projectId) ?? []) {
    for (const line of ctx.linesByDraw().get(draw.id) ?? []) {
      if (line.percentClaimed !== null && line.percentVerified !== null && line.percentClaimed > line.percentVerified) {
        claimGaps.push(line.percentClaimed - line.percentVerified);
      }
    }
  }
  const gap = average(claimGaps);
  if (gap !== null && gap > 10)
    reasons.push(reason("CLAIMS_EXCEED_VERIFIED", `Contractor claims average ${Math.round(gap)} points above verified completion`, Math.min(30, gap)));
  return dimension("contractor", reasons);
}

function fraudRiskDim(ctx: PortfolioContext, projectId: string): DimensionScore {
  const reasons: RiskReason[] = [];
  const signals = fraudSignalsForProject(ctx, projectId);
  for (const signal of signals) {
    const points = signal.severity === "HIGH" ? 20 : signal.severity === "MEDIUM" ? 10 : 5;
    reasons.push(reason(signal.code, signal.label, points));
  }
  return dimension("fraud", reasons);
}

function operationalRisk(ctx: PortfolioContext, projectId: string): DimensionScore {
  const reasons: RiskReason[] = [];
  const disputes = (ctx.disputesByProject().get(projectId) ?? []).filter((d) => !d.closedAt && !d.resolvedAt);
  if (disputes.length > 0)
    reasons.push(reason("OPEN_DISPUTES", `${disputes.length} open dispute(s)`, 15 * disputes.length));
  const legalHolds = (ctx.disputesByProject().get(projectId) ?? []).filter((d) => d.legalHold && !d.closedAt);
  if (legalHolds.length > 0)
    reasons.push(reason("LEGAL_HOLDS", `${legalHolds.length} active legal hold(s)`, 20 * legalHolds.length));
  const issues = (ctx.fieldIssuesByProject().get(projectId) ?? []).filter(
    (i) => !["RESOLVED", "CLOSED"].includes(i.status)
  );
  const critical = issues.filter((i) => i.severity === "CRITICAL").length;
  const high = issues.filter((i) => i.severity === "HIGH").length;
  if (critical + high > 0)
    reasons.push(reason("FIELD_ISSUES", `${critical} critical and ${high} high open field issue(s)`, 12 * critical + 8 * high));
  const now = ctx.generatedAt;
  const agedApprovals = ctx
    .approvals()
    .filter((a) => a.status === "PENDING" && a.projectId === projectId)
    .filter((a) => {
      const age = daysBetween(a.createdAt, now);
      return age !== null && age > 14;
    });
  if (agedApprovals.length > 0)
    reasons.push(reason("APPROVAL_BACKLOG", `${agedApprovals.length} approval(s) pending longer than 14 days`, 8 * agedApprovals.length));
  return dimension("operational", reasons);
}

// ----------------------------------------------------------------- public

export function projectRiskProfile(ctx: PortfolioContext, projectId: string): ProjectRiskProfile {
  const project = ctx.projectById.get(projectId);
  const facets = projectFacets(ctx, projectId);
  const dimensions = {
    financial: financialRisk(ctx, projectId),
    compliance: complianceRisk(ctx, projectId),
    schedule: scheduleRisk(ctx, projectId),
    documentation: documentationRisk(ctx, projectId),
    inspection: inspectionRisk(ctx, projectId),
    contractor: contractorRiskDim(ctx, projectId, facets),
    fraud: fraudRiskDim(ctx, projectId),
    operational: operationalRisk(ctx, projectId),
  };
  const overallRisk = clampScore(
    Object.entries(RISK_WEIGHTS).reduce(
      (a, [key, weight]) => a + dimensions[key as keyof typeof dimensions].score * weight,
      0
    )
  );
  const topReasons = Object.values(dimensions)
    .flatMap((d) => d.reasons)
    .sort((a, b) => b.points - a.points)
    .slice(0, 5);
  return {
    projectId,
    projectName: project?.name ?? projectId,
    status: project?.status ?? "UNKNOWN",
    stage: facets.stage,
    state: facets.state,
    totalBudget: project?.totalBudget ?? 0,
    dimensions,
    overallRisk,
    health: 100 - overallRisk,
    band: band(overallRisk),
    topReasons,
  };
}

export function portfolioRisk(ctx: PortfolioContext, projects = ctx.projects): PortfolioRiskSummary {
  const profiles = projects.map((p) => projectRiskProfile(ctx, p.id));
  const bands: Record<RiskBand, number> = { STABLE: 0, WATCH: 0, ELEVATED: 0, CRITICAL: 0 };
  for (const profile of profiles) bands[profile.band] += 1;
  const totalBudget = profiles.reduce((a, p) => a + p.totalBudget, 0);
  const budgetWeightedHealth =
    totalBudget > 0
      ? profiles.reduce((a, p) => a + p.health * p.totalBudget, 0) / totalBudget
      : average(profiles.map((p) => p.health));
  return {
    generatedAt: ctx.generatedAt,
    projectCount: profiles.length,
    averageHealth: average(profiles.map((p) => p.health)),
    budgetWeightedHealth,
    bands,
    attention: profiles
      .filter((p) => p.band === "ELEVATED" || p.band === "CRITICAL")
      .sort((a, b) => b.overallRisk - a.overallRisk),
    projects: profiles.sort((a, b) => b.overallRisk - a.overallRisk),
    methodology: {
      weights: RISK_WEIGHTS,
      bands: "STABLE <25, WATCH 25–49, ELEVATED 50–74, CRITICAL ≥75 (risk points)",
      note:
        "Deterministic scoring over verified records only. Scores are advisory reading aids; " +
        "they never approve draws, change eligibility, or replace human review.",
    },
  };
}
