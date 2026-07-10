/**
 * Budget vs Verified Physical Progress — transparent side-by-side
 * comparison of money claimed/paid against physical progress supported by
 * verified evidence.
 *
 * CORE PRINCIPLE — financial progress and physical progress are DIFFERENT
 * MEASUREMENTS. This module compares them; it never merges them, never
 * forecasts, and never scores. It is not accounting software and not a
 * prediction engine.
 *
 * LANGUAGE RULE — a variance means "financial progress is ahead of
 * currently verified physical progress" and nothing more. This module
 * (and every surface built on it) makes no claim about misconduct.
 *
 * PHYSICAL PROGRESS METHODOLOGY (deterministic, documented, traceable):
 *   1. Every non-archived milestone gets a normalized weight:
 *      - CONFIGURED_WEIGHTS when every milestone has a configured weight
 *        and they sum > 0 (pilot milestone planning),
 *      - else TRANCHE_PROPORTIONS (tranche amount / total tranches),
 *      - else EQUAL_WEIGHTS when tranche amounts are all zero.
 *   2. A milestone contributes completion × weight:
 *      - VERIFIED / APPROVED / RELEASED milestone  → completion = 1
 *        (its evidence passed the verification pipeline),
 *      - otherwise, an ACTIVE VerifiedQuantity record → completion =
 *        percent/100 (explicit measured quantity, entered by an
 *        authorized reviewer with a reason, referencing VERIFIED evidence
 *        of the same milestone — never inferred from a photo),
 *      - otherwise → completion = 0. UNVERIFIED EVIDENCE CONTRIBUTES
 *        NOTHING.
 *   3. Every non-zero contribution carries its basis: evidence item,
 *      verification (verdict/confidence/policy version) and ledger entry.
 *
 * FINANCIAL PROGRESS METHODOLOGY (real records only):
 *   - budget basis = Σ currentBudget of active budget lines when budget
 *     lines exist, else the project total budget,
 *   - paid to date = Σ budget-line paidToDate when budget lines exist,
 *     else Σ released milestone tranches on the virtual account,
 *   - claimed = paid + Σ requested amounts of draws currently open
 *     (SUBMITTED → READY_FOR_GOVERNANCE),
 *   - paidPct / claimedPct are those figures over the budget basis.
 *
 * VARIANCE = claimedPct − verifiedPhysicalPct (percentage points).
 * Thresholds are configurable (OBV_VARIANCE_WITHIN_PTS /
 * OBV_VARIANCE_WATCH_PTS; defaults 5 / 10).
 */
import * as repo from "../db/repo";
import { audit, snapshotProject } from "./pilot/onboarding";
import type {
  BudgetLine,
  BudgetLineMap,
  BudgetLineProgressRow,
  DrawLineItem,
  FinancialProgress,
  Milestone,
  PhysicalProgressAssessment,
  ProgressContribution,
  Project,
  User,
  VarianceState,
  VarianceThresholds,
  VerifiedQuantity,
  WeightSource,
} from "../../shared/types";

export class BudgetError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

const VERIFIED_STATES = new Set(["VERIFIED", "APPROVED", "RELEASED"]);
const OPEN_DRAW_STATES = new Set([
  "SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED", "READY_FOR_GOVERNANCE",
]);

export const METHODOLOGY =
  "Physical progress = Σ (milestone weight × verified completion). Weights come from " +
  "configured milestone weights, else tranche proportions. Completion is 1 for milestones " +
  "verified through the OBV evidence pipeline, an explicit reviewed quantity (never inferred " +
  "from a photo) for measurably partial milestones, and 0 otherwise — unverified evidence " +
  "contributes nothing. Financial progress = paid and currently-claimed amounts over the " +
  "current budget, from stored budget lines, released tranches and open draw requests. The " +
  "two measurements are compared, never merged; a variance means financial progress is ahead " +
  "of currently verified physical progress — it is not a finding of misconduct.";

// ------------------------------------------------------------ thresholds

export function varianceThresholds(): VarianceThresholds {
  const withinPts = Number(process.env.OBV_VARIANCE_WITHIN_PTS ?? 5);
  const watchPts = Number(process.env.OBV_VARIANCE_WATCH_PTS ?? 10);
  return {
    withinPts: Number.isFinite(withinPts) && withinPts > 0 ? withinPts : 5,
    watchPts: Number.isFinite(watchPts) && watchPts > withinPts ? watchPts : Math.max(10, withinPts * 2),
  };
}

/** Deterministic variance state. `variancePts` is financial − physical. */
export function varianceState(
  variancePts: number | null,
  dataComplete: boolean,
  t: VarianceThresholds = varianceThresholds()
): VarianceState {
  if (!dataComplete || variancePts === null) return "DATA_INCOMPLETE";
  if (variancePts > t.watchPts) return "FINANCIAL_AHEAD";
  if (variancePts > t.withinPts) return "WATCH";
  if (variancePts < -t.withinPts) return "PHYSICAL_AHEAD";
  return "WITHIN_RANGE";
}

/** The only permitted characterization of each state — no fraud claims. */
export const VARIANCE_LANGUAGE: Record<VarianceState, string> = {
  WITHIN_RANGE: "Financial and verified physical progress are within the configured range.",
  WATCH: "Financial progress is moderately ahead of currently verified physical progress.",
  FINANCIAL_AHEAD: "Financial progress is ahead of currently verified physical progress.",
  PHYSICAL_AHEAD: "Verified physical progress is ahead of billing.",
  DATA_INCOMPLETE: "Not enough recorded data to compare financial and physical progress.",
};

// ------------------------------------------------------ physical progress

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Normalized milestone weights with a documented source. */
export function milestoneWeights(milestones: Milestone[]): {
  weights: Map<string, number>;
  source: WeightSource;
} {
  const weights = new Map<string, number>();
  const configured = milestones.map((m) => m.weight ?? null);
  if (milestones.length > 0 && configured.every((w) => w !== null && w > 0)) {
    const total = configured.reduce((s: number, w) => s + (w as number), 0);
    milestones.forEach((m, i) => weights.set(m.id, (configured[i] as number) / total));
    return { weights, source: "CONFIGURED_WEIGHTS" };
  }
  const trancheTotal = milestones.reduce((s, m) => s + m.trancheAmount, 0);
  if (trancheTotal > 0) {
    milestones.forEach((m) => weights.set(m.id, m.trancheAmount / trancheTotal));
    return { weights, source: "TRANCHE_PROPORTIONS" };
  }
  milestones.forEach((m) => weights.set(m.id, milestones.length ? 1 / milestones.length : 0));
  return { weights, source: "EQUAL_WEIGHTS" };
}

/** Traceable basis for a milestone's contribution: its latest VERIFIED
 *  evidence + verification + ledger entry (or the quantity record). */
function basisFor(milestone: Milestone, quantity: VerifiedQuantity | null) {
  // Prefer the evidence the quantity record cites; else the latest
  // evidence whose verification verdict is VERIFIED.
  const candidates = quantity
    ? [repo.getEvidence(quantity.evidenceItemId)].filter(Boolean)
    : repo.listEvidenceForMilestone(milestone.id);
  for (const ev of candidates) {
    const v = repo.getVerificationForEvidence(ev!.id);
    if (v?.verdict === "VERIFIED") {
      const ledger = repo.getLedgerEntryForEvidence(ev!.id);
      return {
        evidenceItemId: ev!.id,
        verificationId: v.id,
        verdict: v.verdict,
        confidence: v.confidence,
        policyVersion: v.policyVersion ?? null,
        ledgerSeq: ledger?.seq ?? null,
        quantityRecordId: quantity?.id ?? null,
        quantityLabel: quantity?.quantityLabel ?? null,
      };
    }
  }
  return {
    evidenceItemId: null, verificationId: null, verdict: null, confidence: null,
    policyVersion: null, ledgerSeq: null,
    quantityRecordId: quantity?.id ?? null,
    quantityLabel: quantity?.quantityLabel ?? null,
  };
}

/** Explainable physical-progress assessment (see METHODOLOGY). */
export function assessPhysicalProgress(projectId: string): PhysicalProgressAssessment {
  const milestones = repo.listMilestones(projectId).filter((m) => !m.archived);
  const { weights, source } = milestoneWeights(milestones);
  const contributions: ProgressContribution[] = milestones.map((m) => {
    const weight = weights.get(m.id) ?? 0;
    const verified = VERIFIED_STATES.has(m.status);
    const quantity = verified ? null : repo.activeQuantityForMilestone(m.id);
    const completion = verified ? 1 : quantity ? quantity.percent / 100 : 0;
    return {
      milestoneId: m.id,
      milestoneLabel: `M${m.seq} · ${m.title}`,
      milestoneStatus: m.status,
      weight,
      completion,
      contributionPct: round1(weight * completion * 100),
      state: verified ? "VERIFIED" : quantity ? "PARTIAL_MEASURED" : "NO_VERIFIED_PROGRESS",
      basis: completion > 0 ? basisFor(m, quantity) : {
        evidenceItemId: null, verificationId: null, verdict: null, confidence: null,
        policyVersion: null, ledgerSeq: null, quantityRecordId: null, quantityLabel: null,
      },
    };
  });
  return {
    projectId,
    verifiedPct: round1(contributions.reduce((s, c) => s + c.weight * c.completion, 0) * 100),
    weightSource: source,
    contributions,
    dataComplete: milestones.length > 0,
    methodology: METHODOLOGY,
    computedAt: new Date().toISOString(),
  };
}

// ----------------------------------------------------- financial progress

function openDrawRequestedForProject(projectId: string): number {
  return repo
    .listDrawRequestsForProject(projectId)
    .filter((d) => OPEN_DRAW_STATES.has(d.status))
    .reduce((s, d) => s + d.requestedAmount, 0);
}

/** Side-by-side comparison from stored records only. */
export function assessFinancialProgress(projectId: string): FinancialProgress {
  const project = repo.getProject(projectId);
  if (!project) throw new BudgetError("Unknown project", 404);
  const lines = repo.listBudgetLines(projectId).filter((l) => l.active);
  const hasLines = lines.length > 0;

  const budgetBasis = hasLines
    ? lines.reduce((s, l) => s + l.currentBudget, 0)
    : project.totalBudget;
  const paidToDate = hasLines
    ? lines.reduce((s, l) => s + l.paidToDate, 0)
    : repo
        .listMilestones(projectId)
        .filter((m) => m.accountStatus === "RELEASED")
        .reduce((s, m) => s + m.trancheAmount, 0);
  const openDrawRequested = openDrawRequestedForProject(projectId);
  const physical = assessPhysicalProgress(projectId);

  const dataComplete = budgetBasis > 0 && physical.dataComplete;
  const paidPct = budgetBasis > 0 ? round1((paidToDate / budgetBasis) * 100) : 0;
  const claimedPct = budgetBasis > 0 ? round1(((paidToDate + openDrawRequested) / budgetBasis) * 100) : 0;
  const variancePts = dataComplete ? round1(claimedPct - physical.verifiedPct) : null;
  const thresholds = varianceThresholds();
  return {
    projectId,
    budgetBasis,
    budgetBasisSource: hasLines ? "BUDGET_LINES" : "PROJECT_TOTAL",
    originalBudget: hasLines ? lines.reduce((s, l) => s + l.originalBudget, 0) : project.totalBudget,
    approvedChanges: hasLines ? lines.reduce((s, l) => s + l.approvedChanges, 0) : 0,
    paidToDate,
    openDrawRequested,
    retainageHeld: lines.reduce((s, l) => s + (l.retainageHeld ?? 0), 0),
    paidPct,
    claimedPct,
    verifiedPhysicalPct: physical.verifiedPct,
    variancePts: variancePts ?? 0,
    varianceState: varianceState(variancePts, dataComplete, thresholds),
    thresholds,
    dataComplete,
    computedAt: new Date().toISOString(),
  };
}

// ------------------------------------------------- budget line register

/** Physical progress restricted to a set of milestones (weights
 *  re-normalized within the subset). Null when the subset is empty. */
function verifiedPctForMilestones(projectId: string, milestoneIds: string[]): number | null {
  if (milestoneIds.length === 0) return null;
  const assessment = assessPhysicalProgress(projectId);
  const subset = assessment.contributions.filter((c) => milestoneIds.includes(c.milestoneId));
  const totalWeight = subset.reduce((s, c) => s + c.weight, 0);
  if (totalWeight <= 0) return null;
  return round1((subset.reduce((s, c) => s + c.weight * c.completion, 0) / totalWeight) * 100);
}

/** Open-draw requested amounts attributed to a budget line (draw line
 *  items whose budgetLineId matches the line's code or id). */
export function openRequestedForBudgetLine(line: BudgetLine): number {
  return repo
    .listDrawRequestsForProject(line.projectId)
    .filter((d) => OPEN_DRAW_STATES.has(d.status))
    .flatMap((d) => repo.listDrawLines(d.id))
    .filter((l) => l.budgetLineId === line.code || l.budgetLineId === line.id)
    .reduce((s, l) => s + l.currentRequested, 0);
}

export function budgetLineRegister(projectId: string): BudgetLineProgressRow[] {
  const thresholds = varianceThresholds();
  return repo.listBudgetLines(projectId).map((line) => {
    const mappedMilestoneIds = repo
      .listBudgetLineMaps(line.id)
      .map((m) => m.milestoneId)
      .filter((id): id is string => Boolean(id));
    const openRequested = openRequestedForBudgetLine(line);
    const financialPct =
      line.currentBudget > 0 ? round1(((line.paidToDate + openRequested) / line.currentBudget) * 100) : null;
    const verifiedPct = verifiedPctForMilestones(projectId, mappedMilestoneIds);
    const complete = financialPct !== null && verifiedPct !== null && line.active;
    const variancePts = complete ? round1(financialPct! - verifiedPct!) : null;
    const state = varianceState(variancePts, complete, thresholds);
    return {
      line,
      mappedMilestoneIds,
      paid: line.paidToDate,
      openRequested,
      financialPct,
      verifiedPct,
      variancePts,
      varianceState: state,
      nextAction: lineNextAction(state, verifiedPct, mappedMilestoneIds.length),
    };
  });
}

function lineNextAction(state: VarianceState, verifiedPct: number | null, mappedCount: number): string {
  switch (state) {
    case "DATA_INCOMPLETE":
      return mappedCount === 0
        ? "Map milestones to enable comparison"
        : "Record budget figures to enable comparison";
    case "FINANCIAL_AHEAD":
      return "Review evidence basis before further payment";
    case "WATCH":
      return "Monitor — request supporting evidence";
    case "PHYSICAL_AHEAD":
      return "Verified work ahead of billing — review draw cadence";
    case "WITHIN_RANGE":
      return verifiedPct === 100 ? "Complete — no action" : "No action";
  }
}

/** Rollup by budget category for the comparison visualization. */
export interface CategoryComparison {
  category: string;
  budget: number;
  financialPct: number | null;
  verifiedPct: number | null;
  variancePts: number | null;
  varianceState: VarianceState;
}

export function categoryComparisons(projectId: string): CategoryComparison[] {
  const rows = budgetLineRegister(projectId).filter((r) => r.line.active);
  const byCategory = new Map<string, BudgetLineProgressRow[]>();
  for (const row of rows) {
    const list = byCategory.get(row.line.category) ?? [];
    list.push(row);
    byCategory.set(row.line.category, list);
  }
  const thresholds = varianceThresholds();
  return [...byCategory.entries()].map(([category, catRows]) => {
    const budget = catRows.reduce((s, r) => s + r.line.currentBudget, 0);
    const paidPlus = catRows.reduce((s, r) => s + r.paid + r.openRequested, 0);
    const financialPct = budget > 0 ? round1((paidPlus / budget) * 100) : null;
    const milestoneIds = [...new Set(catRows.flatMap((r) => r.mappedMilestoneIds))];
    const verifiedPct = verifiedPctForMilestones(projectId, milestoneIds);
    const complete = financialPct !== null && verifiedPct !== null;
    const variancePts = complete ? round1(financialPct! - verifiedPct!) : null;
    return {
      category, budget, financialPct, verifiedPct, variancePts,
      varianceState: varianceState(variancePts, complete, thresholds),
    };
  });
}

// --------------------------------------------------- draw line comparison

export interface DrawLineComparison {
  lineId: string;
  financialPct: number | null;
  verifiedPct: number | null;
  variancePts: number | null;
  varianceState: VarianceState;
  /** Advisory flag: material variance suggests reviewing as an exception.
   *  It never rejects the draw — the reviewer decides. */
  exceptionCandidate: boolean;
}

/** Financial vs verified comparison for one draw line item. Financial
 *  progress = (previously paid + this draw + stored) / scheduled value;
 *  verified physical = the anchored milestone's completion (or the
 *  mapped budget line's milestones when only a budget line is set). */
export function compareDrawLine(projectId: string, line: DrawLineItem): DrawLineComparison {
  const thresholds = varianceThresholds();
  const financialPct =
    line.scheduledValue > 0 ? round1((line.totalCompletedAndStored / line.scheduledValue) * 100) : null;
  let milestoneIds: string[] = line.milestoneId ? [line.milestoneId] : [];
  if (milestoneIds.length === 0 && line.budgetLineId) {
    const budgetLine =
      repo.findBudgetLineByCode(projectId, line.budgetLineId) ?? repo.getBudgetLine(line.budgetLineId);
    if (budgetLine && budgetLine.projectId === projectId) {
      milestoneIds = repo
        .listBudgetLineMaps(budgetLine.id)
        .map((m) => m.milestoneId)
        .filter((id): id is string => Boolean(id));
    }
  }
  const verifiedPct = verifiedPctForMilestones(projectId, milestoneIds);
  const complete = financialPct !== null && verifiedPct !== null;
  const variancePts = complete ? round1(financialPct! - verifiedPct!) : null;
  const state = varianceState(variancePts, complete, thresholds);
  return {
    lineId: line.id,
    financialPct,
    verifiedPct,
    variancePts,
    varianceState: state,
    exceptionCandidate: state === "FINANCIAL_AHEAD",
  };
}

// -------------------------------------------------------- access control

/** Tenant boundary for budget/progress surfaces: the project's governing
 *  organization, any organization wired into the pilot configuration, or
 *  an organization with a draw on the project (the borrower). Unrelated
 *  tenants get 404 — existence is not disclosed. */
export function canAccessProjectFinance(user: User, project: Project): boolean {
  if (user.organizationId === project.organizationId) return true;
  const pilot = project.pilot;
  if (
    [pilot?.implementingOrgId, pilot?.contractorOrgId, pilot?.funderOrgId, pilot?.engineerOrgId].some(
      (orgId) => orgId && orgId === user.organizationId
    )
  ) {
    return true;
  }
  return repo
    .listDrawRequestsForProject(project.id)
    .some((d) => d.requestedByOrganizationId === user.organizationId);
}

/** Budget lines and quantities are lender-control records. */
export function canManageBudget(user: User): boolean {
  return user.role === "FUNDER_REP" || user.role === "COMPLIANCE_REVIEWER";
}

function assertFinanceAccess(user: User, project: Project): void {
  if (!canAccessProjectFinance(user, project)) throw new BudgetError("Project not found", 404);
}

function assertBudgetManager(user: User, project: Project): void {
  assertFinanceAccess(user, project);
  if (!canManageBudget(user)) {
    throw new BudgetError("Not authorized to manage budget records", 403);
  }
}

// ------------------------------------------------------------ budget CRUD

const num = (v: unknown, label: string, min = 0): number => {
  const n = Math.round(Number(v ?? 0));
  if (!Number.isFinite(n) || n < min) throw new BudgetError(`${label} must be a number >= ${min}`);
  return n;
};

export function createBudgetLine(
  user: User,
  input: {
    projectId: string;
    code: string;
    category: string;
    description?: string | null;
    originalBudget?: number;
    committedAmount?: number | null;
    paidToDate?: number;
    retainageHeld?: number | null;
    milestoneIds?: string[];
  }
): BudgetLine {
  const project = repo.getProject(input.projectId);
  if (!project) throw new BudgetError("Unknown project", 404);
  assertBudgetManager(user, project);
  const code = (input.code ?? "").trim();
  const category = (input.category ?? "").trim();
  if (!code) throw new BudgetError("Budget line code is required");
  if (!category) throw new BudgetError("Budget line category is required");
  if (repo.findBudgetLineByCode(project.id, code)) {
    throw new BudgetError(`Budget line code "${code}" already exists on this project`, 409);
  }
  const now = new Date().toISOString();
  const line: BudgetLine = {
    id: repo.newId(),
    projectId: project.id,
    code,
    category,
    description: input.description?.trim() ?? "",
    originalBudget: num(input.originalBudget, "originalBudget"),
    approvedChanges: 0,
    committedAmount: input.committedAmount != null ? num(input.committedAmount, "committedAmount") : null,
    paidToDate: num(input.paidToDate, "paidToDate"),
    retainageHeld: input.retainageHeld != null ? num(input.retainageHeld, "retainageHeld") : null,
    currency: project.pilot?.currency ?? "USD",
    sequence: repo.listBudgetLines(project.id).length,
    active: true,
    createdAt: now,
    updatedAt: now,
    currentBudget: 0, // derived on read
  };
  repo.insertBudgetLine(line);
  for (const milestoneId of input.milestoneIds ?? []) {
    mapBudgetLine(user, line.id, { milestoneId });
  }
  audit({
    projectId: project.id, actorUserId: user.id, action: "BUDGET_LINE_CREATED",
    entityType: "budget_line", entityId: line.id, reason: null,
    beforeSummary: null,
    afterSummary: `${code} ${category} · $${line.originalBudget.toLocaleString("en-US")}`,
  });
  return repo.getBudgetLine(line.id)!;
}

export function mapBudgetLine(
  user: User,
  budgetLineId: string,
  input: { milestoneId?: string | null; evidenceRequirementId?: string | null }
): BudgetLineMap {
  const line = repo.getBudgetLine(budgetLineId);
  if (!line) throw new BudgetError("Budget line not found", 404);
  const project = repo.getProject(line.projectId)!;
  assertBudgetManager(user, project);
  if (input.milestoneId) {
    const m = repo.getMilestone(input.milestoneId);
    if (!m || m.projectId !== line.projectId) {
      throw new BudgetError("milestoneId must reference a milestone of the same project");
    }
  }
  if (input.evidenceRequirementId) {
    const r = repo.getRequirement(input.evidenceRequirementId);
    if (!r || repo.getMilestone(r.milestoneId)?.projectId !== line.projectId) {
      throw new BudgetError("evidenceRequirementId must reference a requirement of the same project");
    }
  }
  if (!input.milestoneId && !input.evidenceRequirementId) {
    throw new BudgetError("A milestone or evidence requirement is required");
  }
  const existing = repo
    .listBudgetLineMaps(line.id)
    .find(
      (m) =>
        m.milestoneId === (input.milestoneId ?? null) &&
        m.evidenceRequirementId === (input.evidenceRequirementId ?? null)
    );
  if (existing) return existing;
  const map: BudgetLineMap = {
    id: repo.newId(),
    budgetLineId: line.id,
    milestoneId: input.milestoneId ?? null,
    evidenceRequirementId: input.evidenceRequirementId ?? null,
    createdAt: new Date().toISOString(),
  };
  repo.insertBudgetLineMap(map);
  return map;
}

export function unmapBudgetLine(user: User, budgetLineId: string, mapId: string): void {
  const line = repo.getBudgetLine(budgetLineId);
  if (!line) throw new BudgetError("Budget line not found", 404);
  assertBudgetManager(user, repo.getProject(line.projectId)!);
  if (!repo.listBudgetLineMaps(line.id).some((m) => m.id === mapId)) {
    throw new BudgetError("Mapping not found", 404);
  }
  repo.deleteBudgetLineMap(mapId);
}

/**
 * CHANGE CONTROL — budget amounts on a launched (non-DRAFT) project can
 * never change silently: an explicit reason is required, the change is
 * written to the configuration audit trail, and a new configuration
 * snapshot/version is recorded. approvedChanges is the integration seam
 * for a future Change Orders module: when that exists it must be derived
 * from approved change records, not edited here.
 */
export function updateBudgetLine(
  user: User,
  budgetLineId: string,
  patch: {
    description?: string;
    category?: string;
    originalBudget?: number;
    approvedChanges?: number;
    committedAmount?: number | null;
    paidToDate?: number;
    retainageHeld?: number | null;
    active?: boolean;
    reason?: string | null;
  }
): BudgetLine {
  const line = repo.getBudgetLine(budgetLineId);
  if (!line) throw new BudgetError("Budget line not found", 404);
  const project = repo.getProject(line.projectId)!;
  assertBudgetManager(user, project);
  const reason = patch.reason?.trim() || null;
  const budgetChanging =
    (patch.originalBudget !== undefined && num(patch.originalBudget, "originalBudget") !== line.originalBudget) ||
    (patch.approvedChanges !== undefined && Math.round(Number(patch.approvedChanges)) !== line.approvedChanges) ||
    (patch.active !== undefined && patch.active !== line.active);
  if (budgetChanging && project.status !== "DRAFT" && !reason) {
    throw new BudgetError(
      "This project is launched — changing the budget requires an explicit change reason",
      422
    );
  }
  const approvedChanges =
    patch.approvedChanges !== undefined ? Math.round(Number(patch.approvedChanges)) : undefined;
  if (approvedChanges !== undefined && !Number.isFinite(approvedChanges)) {
    throw new BudgetError("approvedChanges must be a number");
  }
  repo.updateBudgetLine(line.id, {
    description: patch.description?.trim(),
    category: patch.category?.trim() || undefined,
    originalBudget: patch.originalBudget !== undefined ? num(patch.originalBudget, "originalBudget") : undefined,
    approvedChanges,
    committedAmount:
      patch.committedAmount !== undefined
        ? patch.committedAmount != null
          ? num(patch.committedAmount, "committedAmount")
          : null
        : undefined,
    paidToDate: patch.paidToDate !== undefined ? num(patch.paidToDate, "paidToDate") : undefined,
    retainageHeld:
      patch.retainageHeld !== undefined
        ? patch.retainageHeld != null
          ? num(patch.retainageHeld, "retainageHeld")
          : null
        : undefined,
    active: patch.active,
  });
  const after = repo.getBudgetLine(line.id)!;
  if (budgetChanging && project.status !== "DRAFT") {
    const nextVersion = (project.pilot?.configVersion ?? 1) + 1;
    repo.updateProjectFields(project.id, { configVersion: nextVersion });
    snapshotProject(project.id, `Post-launch budget change (${line.code}): ${reason}`, user);
  }
  audit({
    projectId: project.id, actorUserId: user.id, action: "BUDGET_LINE_UPDATED",
    entityType: "budget_line", entityId: line.id, reason,
    beforeSummary: `${line.code} · budget $${line.currentBudget.toLocaleString("en-US")} · paid $${line.paidToDate.toLocaleString("en-US")}`,
    afterSummary: `${after.code} · budget $${after.currentBudget.toLocaleString("en-US")} · paid $${after.paidToDate.toLocaleString("en-US")}`,
  });
  return after;
}

// -------------------------------------------------- verified quantities

/**
 * Record an explicit, measured partial-progress quantity for a milestone.
 * Authorized reviewers only; must reference a VERIFIED evidence item of
 * the same milestone; requires a reason. Never inferred, never automatic.
 */
export function recordVerifiedQuantity(
  user: User,
  input: {
    milestoneId: string;
    percent: number;
    quantityLabel: string;
    evidenceItemId: string;
    reason: string;
  }
): VerifiedQuantity {
  const milestone = repo.getMilestone(input.milestoneId);
  if (!milestone) throw new BudgetError("Unknown milestone", 404);
  const project = repo.getProject(milestone.projectId)!;
  assertBudgetManager(user, project);
  if (VERIFIED_STATES.has(milestone.status)) {
    throw new BudgetError("This milestone is already verified — it contributes its full weight", 409);
  }
  const percent = Number(input.percent);
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
    throw new BudgetError("percent must be between 0 and 100 (exclusive) — full completion comes only from verification");
  }
  const label = (input.quantityLabel ?? "").trim();
  if (!label) throw new BudgetError("A measured quantity description is required (e.g. \"9.8 of 14 km base laid\")");
  const reason = (input.reason ?? "").trim();
  if (!reason) throw new BudgetError("A reason is required");
  const evidence = repo.getEvidence(input.evidenceItemId);
  if (!evidence || evidence.milestoneId !== milestone.id) {
    throw new BudgetError("evidenceItemId must reference evidence of this milestone");
  }
  const verification = repo.getVerificationForEvidence(evidence.id);
  if (verification?.verdict !== "VERIFIED") {
    throw new BudgetError(
      "Only VERIFIED evidence can support a measured quantity — unverified evidence contributes no progress",
      422
    );
  }
  repo.supersedeQuantities(milestone.id);
  const record: VerifiedQuantity = {
    id: repo.newId(),
    milestoneId: milestone.id,
    percent: Math.round(percent * 10) / 10,
    quantityLabel: label,
    evidenceItemId: evidence.id,
    reason,
    enteredByUserId: user.id,
    superseded: false,
    createdAt: new Date().toISOString(),
  };
  repo.insertVerifiedQuantity(record);
  audit({
    projectId: project.id, actorUserId: user.id, action: "VERIFIED_QUANTITY_RECORDED",
    entityType: "verified_quantity", entityId: record.id, reason,
    beforeSummary: null,
    afterSummary: `M${milestone.seq} · ${record.percent}% (${label}) based on verified evidence ${evidence.id.slice(0, 8)}…`,
  });
  return record;
}
