/**
 * OBV Control Intelligence — lender-grade, evidence-grounded control
 * oversight derived ENTIRELY from governed OBV records and deterministic
 * rules.
 *
 * READ-ONLY. This module never writes, never approves, never verifies
 * location, never changes a gate, never resolves an authoritative
 * exception, and has no path to VirtualAccountService mutations. It
 * aggregates existing services (completion gates, exceptions, draws,
 * budget-vs-physical progress, retainage, governance records, the
 * Evidence Ledger chain result) into portfolio- and project-level control
 * views. AI never creates the underlying status; explanatory wording here
 * is deterministic text.
 *
 * RULE PRECEDENCE (documented, exact order — first level with at least
 * one active condition determines the project status):
 *   1. BLOCKED          — an active hard blocker (a blocking completion-gate
 *                         reason on a non-released milestone, or an Evidence
 *                         Ledger integrity failure).
 *   2. AT_RISK          — severe unresolved exposure: open HIGH/CRITICAL
 *                         exception, financial progress materially ahead of
 *                         verified physical progress, outstanding REJECTED
 *                         evidence, or unapproved change-order cost inside a
 *                         submitted draw.
 *   3. WATCH            — non-blocking deterioration or overdue activity:
 *                         overdue approvals, overdue clarifications, evidence
 *                         awaiting review, open MEDIUM field issues, draw
 *                         documentation incomplete, required inspection not
 *                         scheduled or overdue.
 *   4. DATA_INCOMPLETE  — required control information unavailable:
 *                         inspection requirement UNKNOWN on evidence-verified
 *                         work, or progress computations flagged incomplete.
 *                         UNKNOWN never behaves as NOT_REQUIRED.
 *   5. HEALTHY          — only when no higher-priority condition applies.
 *
 * No success probabilities, no completion-date forecasts, no invented
 * scores. Every figure and reason cites its source records.
 */
import * as repo from "../db/repo";
import * as gates from "./completionGates";
import * as exceptionsService from "./exceptions";
import * as budgetService from "./budgetProgress";
import * as drawsService from "./draws";
import * as retainageService from "./retainage";
import type {
  DrawRequest,
  GateReason,
  Milestone,
  MilestoneGates,
  ObvException,
  Project,
  User,
  UserRole,
} from "../../shared/types";

// ------------------------------------------------------------------ types

export type ControlHealthStatus =
  | "BLOCKED"
  | "AT_RISK"
  | "WATCH"
  | "DATA_INCOMPLETE"
  | "HEALTHY";

export const STATUS_ORDER: ControlHealthStatus[] = [
  "BLOCKED",
  "AT_RISK",
  "WATCH",
  "DATA_INCOMPLETE",
  "HEALTHY",
];

export interface ControlReason {
  /** Machine-readable rule code, e.g. INSPECTION_FAILED. */
  code: string;
  /** Plain-language deterministic explanation. */
  detail: string;
  /** Which status level this condition maps to. */
  level: Exclude<ControlHealthStatus, "HEALTHY">;
  /** Human-readable source record references. Never empty. */
  sources: string[];
  /** Navigation target into the governed screen. */
  href: string;
  /** Affected amount where derivable from records; null otherwise. */
  amount: number | null;
  /** Recommended responsible role. */
  role: UserRole | null;
  /** Whether the condition blocks governance or release. */
  blocking: boolean;
  /** ISO date the underlying condition was recorded, where available. */
  detectedAt: string | null;
}

export interface ProjectControlHealth {
  projectId: string;
  projectName: string;
  status: ControlHealthStatus;
  generatedAt: string;
  /** Verification policy version in force, where configured. */
  policyVersion: number | null;
  primaryReason: ControlReason | null;
  reasons: ControlReason[];
}

export type MetricState = "OK" | "DATA_INCOMPLETE" | "NOT_AVAILABLE";

export interface ControlMetric {
  key: string;
  label: string;
  kind: "count" | "money" | "pct";
  value: number | null;
  state: MetricState;
  /** Exact calculation definition (shown in methodology). */
  definition: string;
  href: string | null;
}

export interface SurveillanceRow {
  exceptionId: string;
  severity: string;
  category: string;
  status: string;
  sourceType: string;
  sourceLabel: string;
  projectId: string;
  projectName: string;
  milestoneLabel: string | null;
  drawLabel: string | null;
  detectedAt: string;
  ageDays: number;
  sla: string;
  owner: string;
  blocking: boolean;
  amount: number | null;
  nextAction: string;
  /** Source reconciliation state (source-cleared auto-resolve semantics). */
  reconciliation: string;
  href: string;
}

export type ActionPriority = "IMMEDIATE" | "HIGH" | "NORMAL" | "INFORMATIONAL";

export interface ControlAction {
  id: string;
  priority: ActionPriority;
  /** Machine-readable action type for filtering. */
  type: string;
  title: string;
  explanation: string;
  role: UserRole;
  projectId: string;
  projectName: string;
  /** Milestone / draw / exception reference label. */
  ref: string;
  amount: number | null;
  detectedAt: string | null;
  slaState: string | null;
  blocking: boolean;
  mandatory: boolean;
  /** Source record references. NEVER empty — an action without a source
   *  record must not exist. */
  sources: string[];
  href: string;
  overdue: boolean;
}

export interface ExposureCategory {
  key: string;
  label: string;
  amount: number;
  drawIds: string[];
}

export interface DrawExposure {
  projectId: string | null; // null = portfolio
  submittedTotal: number;
  /** Σ reviewer-supported amounts on reviewed lines of open draws. */
  supportableTotal: number | null;
  /** Σ finalized advisory recommendations — NOT approvals. */
  advisoryTotal: number | null;
  /** Σ formally approved gross amounts (completed governance only). */
  approvedGrossTotal: number | null;
  /** Σ net released draw amounts (governed release events only). */
  releasedNetTotal: number;
  retainageWithheld: number;
  retainageReleased: number;
  /** Milestone tranches currently HELD (distinct from draw amounts). */
  tranchesHeld: number;
  /** Unique blocked amount — each draw counted once even with several
   *  blockers. Category views below may overlap. */
  blockedUnique: number;
  categories: ExposureCategory[];
  overlapNote: string;
}

export interface MilestoneGateRow {
  milestoneId: string;
  projectId: string;
  label: string;
  trancheAmount: number;
  contractor: string;
  evidence: string;
  requirement: string; // UNKNOWN | NOT_REQUIRED | REQUIRED — never inferred
  inspection: string;
  governance: string; // eligibility result — never a release
  funds: string; // HELD | RELEASED (historical financial state)
  legacyReleased: boolean;
  blockingReasons: GateReason[];
}

export interface CapacityIndicator {
  key: string;
  label: string;
  count: number;
  detail: string;
  href: string;
}

export interface AttentionRow {
  projectId: string;
  name: string;
  status: ControlHealthStatus;
  verifiedPhysicalPct: number | null;
  governedFinancialPct: number | null;
  variancePts: number | null;
  varianceState: string;
  openBlockers: number;
  highCriticalExceptions: number;
  drawBlocked: number;
  fundsHeld: number;
  pendingInspections: number;
  nextAction: string | null;
  nextActionHref: string | null;
}

export interface ActionFilters {
  role?: string;
  priority?: string;
  projectId?: string;
  type?: string;
  blocking?: string; // "true" | "false"
  overdue?: string; // "true" | "false"
}

export interface ControlIntelligenceData {
  generatedAt: string;
  chainValid: boolean;
  summary: ControlMetric[];
  health: ProjectControlHealth[];
  surveillance: SurveillanceRow[];
  actions: ControlAction[];
  actionTypes: string[];
  exposure: DrawExposure;
  exposureByProject: DrawExposure[];
  gateRows: MilestoneGateRow[];
  capacity: CapacityIndicator[];
  attention: AttentionRow[];
  methodology: MethodologyDoc;
}

export interface MethodologyDoc {
  statement: string;
  ruleOrder: Array<{ status: ControlHealthStatus; rule: string }>;
  sourceModels: string[];
  limitations: string[];
  generatedAt: string;
}

// ---------------------------------------------------------------- helpers

const DAY = 86_400_000;
const APPROVAL_SLA_MS = 48 * 3_600_000;
const CLARIFICATION_SLA_MS = 3 * DAY;
const OPEN_ISSUE_STATES = new Set(["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_FIELD_RESPONSE"]);
const OPEN_CLAR_STATES = new Set(["OPEN", "REOPENED"]);
const OPEN_DRAW_STATES = new Set([
  "SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED",
  "READY_FOR_GOVERNANCE", "PARTIALLY_APPROVED",
]);
const CO_APPROVED = new Set(["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"]);

const msLabel = (m: Milestone): string => `M${m.seq} · ${m.title.split(",")[0]}`;

const roleName: Record<UserRole, string> = {
  FUNDER_REP: "Funder Representative",
  PROJECT_MANAGER: "Project Manager",
  COMPLIANCE_REVIEWER: "Compliance Reviewer",
  FIELD: "Field Engineer",
};

export const METHODOLOGY_STATEMENT =
  "OBV Control Intelligence is derived from governed project records and deterministic control rules. " +
  "AI may summarize and explain results but does not independently approve work, verify location, modify " +
  "evidence status, resolve authoritative exceptions, change financial state, or authorize funds release.";

const RULE_ORDER_DOC: Array<{ status: ControlHealthStatus; rule: string }> = [
  { status: "BLOCKED", rule: "Active hard blocker: a blocking completion-gate reason on a non-released milestone (failed/expired inspection, rejected latest evidence, missing required inspection document, open HIGH/CRITICAL exception bound to the milestone) or an Evidence Ledger integrity failure." },
  { status: "AT_RISK", rule: "Severe unresolved exposure: open HIGH or CRITICAL exception, financial progress materially ahead of verified physical progress (FINANCIAL_AHEAD), outstanding REJECTED evidence, or unapproved change-order cost inside a submitted draw." },
  { status: "WATCH", rule: "Non-blocking deterioration or overdue activity: approval pending beyond 48 hours, clarification open beyond 3 days or past due, evidence flagged NEEDS_REVIEW, open MEDIUM field issue, incomplete draw documentation, required inspection unscheduled or overdue." },
  { status: "DATA_INCOMPLETE", rule: "Required control information unavailable: inspection requirement UNKNOWN on evidence-verified work (UNKNOWN never behaves as NOT_REQUIRED) or a progress computation flagged data-incomplete." },
  { status: "HEALTHY", rule: "No higher-priority condition applies." },
];

// ------------------------------------------------- per-project evaluation

interface ProjectBundle {
  project: Project;
  milestones: Milestone[];
  gatesById: Map<string, MilestoneGates>;
  draws: DrawRequest[];
  exceptions: ObvException[];
  openExceptions: ObvException[];
}

function collectBundle(project: Project): ProjectBundle {
  const milestones = repo.listMilestones(project.id).filter((m) => !m.archived);
  const gatesById = new Map<string, MilestoneGates>();
  for (const m of milestones) gatesById.set(m.id, gates.milestoneGates(m.id));
  const exceptions = repo.listExceptionsForProject(project.id);
  return {
    project,
    milestones,
    gatesById,
    draws: repo.listDrawRequestsForProject(project.id),
    exceptions,
    openExceptions: exceptions.filter(exceptionsService.isOpen),
  };
}

function evaluateProjectHealth(
  b: ProjectBundle,
  chainValid: boolean,
  now: number
): ProjectControlHealth {
  const reasons: ControlReason[] = [];
  const p = b.project;
  const add = (r: Omit<ControlReason, "sources"> & { sources: string[] }) => {
    if (r.sources.length === 0) return; // no source record → no reason
    reasons.push(r);
  };

  // ---- BLOCKED conditions -------------------------------------------
  if (!chainValid) {
    add({
      code: "LEDGER_INTEGRITY_FAILURE",
      detail: "The Evidence Ledger hash chain failed verification — records may have been altered.",
      level: "BLOCKED",
      sources: ["Evidence Ledger chain verification"],
      href: "/ledger",
      amount: null,
      role: "COMPLIANCE_REVIEWER",
      blocking: true,
      detectedAt: null,
    });
  }
  for (const m of b.milestones) {
    const g = b.gatesById.get(m.id)!;
    if (g.eligibility.result === "RELEASED") continue; // historical financial state
    for (const reason of g.eligibility.reasons.filter((r) => r.blocking)) {
      add({
        code: reason.code,
        detail: reason.detail,
        level: "BLOCKED",
        sources: [`Milestone ${msLabel(m)} completion-gate evaluation`],
        href: `/milestone/${m.id}`,
        amount: m.trancheAmount,
        role: reason.code.startsWith("INSPECTION") ? "PROJECT_MANAGER" : "COMPLIANCE_REVIEWER",
        blocking: true,
        detectedAt: g.eligibility.computedAt,
      });
    }
  }

  // ---- AT_RISK conditions -------------------------------------------
  for (const e of b.openExceptions) {
    if (e.severity === "HIGH" || e.severity === "CRITICAL") {
      add({
        code: "HIGH_SEVERITY_EXCEPTION_OPEN",
        detail: `${e.severity} ${e.category} exception open: "${e.title}".`,
        level: "AT_RISK",
        sources: [`Exception ${e.id}`],
        href: `/exception/${e.id}`,
        amount: exceptionAmount(e, b),
        role: "PROJECT_MANAGER",
        blocking: false,
        detectedAt: e.openedAt,
      });
    }
  }
  const fin = budgetService.assessFinancialProgress(p.id);
  if (fin.varianceState === "FINANCIAL_AHEAD") {
    add({
      code: "FINANCIAL_AHEAD_OF_PHYSICAL",
      detail: `Financial progress (${fin.claimedPct}%) is ${fin.variancePts} points ahead of verified physical progress (${fin.verifiedPhysicalPct}%).`,
      level: "AT_RISK",
      sources: [`Financial progress computation for project ${p.id}`],
      href: "/budget",
      amount: null,
      role: "FUNDER_REP",
      blocking: false,
      detectedAt: fin.computedAt,
    });
  }
  for (const m of b.milestones) {
    const g = b.gatesById.get(m.id)!;
    if (g.eligibility.result !== "RELEASED" && g.evidenceReview.status === "REJECTED") {
      add({
        code: "EVIDENCE_REJECTED_OUTSTANDING",
        detail: `Latest evidence for ${msLabel(m)} was REJECTED and has not been superseded.`,
        level: "AT_RISK",
        sources: [`Evidence review state for milestone ${m.id}`],
        href: `/milestone/${m.id}`,
        amount: m.trancheAmount,
        role: "PROJECT_MANAGER",
        blocking: false,
        detectedAt: null,
      });
    }
  }
  for (const d of b.draws) {
    if (!OPEN_DRAW_STATES.has(d.status)) continue;
    for (const line of repo.listDrawLines(d.id)) {
      if (!line.changeOrderId) continue;
      const co = repo.getChangeOrder(line.changeOrderId);
      if (co && !CO_APPROVED.has(co.status)) {
        add({
          code: "UNAPPROVED_CHANGE_ORDER_IN_DRAW",
          detail: `Draw #${d.drawNumber} bills against change order CO-${co.changeOrderNumber} (${co.status.replace(/_/g, " ")}) — cost is not approved.`,
          level: "AT_RISK",
          sources: [`Draw line ${line.id}`, `Change order CO-${co.changeOrderNumber}`],
          href: `/draw/${d.id}`,
          amount: line.currentRequested,
          role: "FUNDER_REP",
          blocking: false,
          detectedAt: d.submittedAt,
        });
      }
    }
  }

  // ---- WATCH conditions ---------------------------------------------
  for (const a of repo.listPendingApprovalRequests()) {
    const m = a.milestoneId ? repo.getMilestone(a.milestoneId) : null;
    if (!m || m.projectId !== p.id) continue;
    if (now - Date.parse(a.createdAt) > APPROVAL_SLA_MS) {
      add({
        code: "APPROVAL_OVERDUE",
        detail: `Approval for ${msLabel(m)} has been pending longer than 48 hours.`,
        level: "WATCH",
        sources: [`Approval request ${a.id}`],
        href: "/approvals",
        amount: m.trancheAmount,
        role: (a.requiredRoles[0] as UserRole) ?? "FUNDER_REP",
        blocking: false,
        detectedAt: a.createdAt,
      });
    }
  }
  for (const c of repo.listClarifications()) {
    const m = repo.getMilestone(c.milestoneId);
    if (!m || m.projectId !== p.id || !OPEN_CLAR_STATES.has(c.status)) continue;
    const overdue =
      now - Date.parse(c.createdAt) > CLARIFICATION_SLA_MS ||
      (c.dueAt !== null && now > Date.parse(c.dueAt));
    if (overdue) {
      add({
        code: "CLARIFICATION_OVERDUE",
        detail: `Clarification on ${msLabel(m)} is overdue.`,
        level: "WATCH",
        sources: [`Clarification ${c.id}`],
        href: `/milestone/${m.id}`,
        amount: null,
        role: "FIELD",
        blocking: false,
        detectedAt: c.createdAt,
      });
    }
  }
  for (const m of b.milestones) {
    const g = b.gatesById.get(m.id)!;
    if (g.eligibility.result === "RELEASED") continue;
    if (g.evidenceReview.status === "NEEDS_REVIEW") {
      add({
        code: "EVIDENCE_NEEDS_REVIEW",
        detail: `Evidence for ${msLabel(m)} is flagged NEEDS REVIEW.`,
        level: "WATCH",
        sources: [`Evidence review state for milestone ${m.id}`],
        href: "/compliance",
        amount: m.trancheAmount,
        role: "COMPLIANCE_REVIEWER",
        blocking: false,
        detectedAt: null,
      });
    }
    if (g.inspectionGate === "REQUIRED_UNSCHEDULED") {
      add({
        code: "REQUIRED_INSPECTION_UNSCHEDULED",
        detail: `Required jurisdictional inspection for ${msLabel(m)} has not been scheduled.`,
        level: "WATCH",
        sources: [`Inspection requirement for milestone ${m.id}`],
        href: `/milestone/${m.id}`,
        amount: m.trancheAmount,
        role: "PROJECT_MANAGER",
        blocking: false,
        detectedAt: null,
      });
    }
    if (g.inspection && g.inspectionGate === "SCHEDULED" && g.inspection.scheduledAt && now > Date.parse(g.inspection.scheduledAt) + DAY) {
      add({
        code: "SCHEDULED_INSPECTION_OVERDUE",
        detail: `Scheduled inspection for ${msLabel(m)} is past its scheduled date without a completion record.`,
        level: "WATCH",
        sources: [`Inspection ${g.inspection.id}`],
        href: `/milestone/${m.id}`,
        amount: null,
        role: "PROJECT_MANAGER",
        blocking: false,
        detectedAt: g.inspection.scheduledAt,
      });
    }
  }
  for (const i of repo.listFieldIssues()) {
    if (i.projectId !== p.id || !OPEN_ISSUE_STATES.has(i.status)) continue;
    if (i.severity === "MEDIUM") {
      add({
        code: "OPEN_MEDIUM_FIELD_ISSUE",
        detail: `MEDIUM field issue open: "${i.title}".`,
        level: "WATCH",
        sources: [`Field issue ${i.id}`],
        href: `/issue/${i.id}`,
        amount: null,
        role: "PROJECT_MANAGER",
        blocking: false,
        detectedAt: i.createdAt,
      });
    }
  }
  for (const d of b.draws) {
    if (!OPEN_DRAW_STATES.has(d.status)) continue;
    const missing = drawsService.missingRequiredDocuments(d.id);
    if (missing.length > 0) {
      add({
        code: "DRAW_DOCUMENTATION_INCOMPLETE",
        detail: `Draw #${d.drawNumber} is missing ${missing.length} required document(s): ${missing.map((r) => r.docType.replace(/_/g, " ")).join(", ")}.`,
        level: "WATCH",
        sources: missing.map((r) => `Draw document requirement ${r.id}`),
        href: `/draw/${d.id}?tab=documents`,
        amount: d.requestedAmount,
        role: "PROJECT_MANAGER",
        blocking: false,
        detectedAt: d.submittedAt,
      });
    }
  }

  // ---- DATA_INCOMPLETE conditions ------------------------------------
  for (const m of b.milestones) {
    const g = b.gatesById.get(m.id)!;
    if (g.eligibility.result === "RELEASED") continue;
    if (g.evidenceReview.status === "VERIFIED" && g.requirementValue === "UNKNOWN") {
      add({
        code: "INSPECTION_REQUIREMENT_UNKNOWN",
        detail: `Evidence for ${msLabel(m)} is verified but whether a jurisdictional inspection is required has not been determined. UNKNOWN never behaves as NOT REQUIRED.`,
        level: "DATA_INCOMPLETE",
        sources: [`Completion gates for milestone ${m.id}`],
        href: `/milestone/${m.id}`,
        amount: m.trancheAmount,
        role: "FUNDER_REP",
        blocking: false,
        detectedAt: null,
      });
    }
  }
  const phys = budgetService.assessPhysicalProgress(p.id);
  if (!phys.dataComplete) {
    add({
      code: "PHYSICAL_PROGRESS_DATA_INCOMPLETE",
      detail: "The verified physical progress computation is flagged data-incomplete.",
      level: "DATA_INCOMPLETE",
      sources: [`Physical progress assessment for project ${p.id}`],
      href: "/budget",
      amount: null,
      role: "PROJECT_MANAGER",
      blocking: false,
      detectedAt: phys.computedAt,
    });
  }
  if (!fin.dataComplete) {
    add({
      code: "FINANCIAL_PROGRESS_DATA_INCOMPLETE",
      detail: "The financial progress computation is flagged data-incomplete.",
      level: "DATA_INCOMPLETE",
      sources: [`Financial progress computation for project ${p.id}`],
      href: "/budget",
      amount: null,
      role: "PROJECT_MANAGER",
      blocking: false,
      detectedAt: fin.computedAt,
    });
  }

  // ---- deterministic precedence ----
  let status: ControlHealthStatus = "HEALTHY";
  for (const level of STATUS_ORDER) {
    if (level === "HEALTHY") break;
    if (reasons.some((r) => r.level === level)) {
      status = level;
      break;
    }
  }
  const levelRank = new Map(STATUS_ORDER.map((s, i) => [s, i]));
  const sorted = [...reasons].sort(
    (a, b2) => (levelRank.get(a.level)! - levelRank.get(b2.level)!) || a.code.localeCompare(b2.code)
  );
  // Verification policy version actually applied to this project's evidence
  // (from stored verification records — never invented).
  const policyVersions = [...b.gatesById.values()]
    .map((g) => g.evidenceReview.policyVersion)
    .filter((v): v is number => v !== null);
  return {
    projectId: p.id,
    projectName: p.name,
    status,
    generatedAt: new Date(now).toISOString(),
    policyVersion: policyVersions.length ? Math.max(...policyVersions) : null,
    primaryReason: sorted[0] ?? null,
    reasons: sorted,
  };
}

function exceptionAmount(e: ObvException, b: ProjectBundle): number | null {
  if (e.drawRequestId) {
    const d = b.draws.find((x) => x.id === e.drawRequestId);
    return d ? d.requestedAmount : null;
  }
  if (e.milestoneId) {
    const m = b.milestones.find((x) => x.id === e.milestoneId);
    return m ? m.trancheAmount : null;
  }
  return null;
}

// ------------------------------------------------------- draw exposure

function exposureForProject(b: ProjectBundle): DrawExposure {
  const p = b.project;
  const nonCancelled = b.draws.filter((d) => d.submittedAt !== null && d.status !== "CANCELLED");
  const submittedTotal = nonCancelled.reduce((s, d) => s + d.requestedAmount, 0);

  let supportable = 0;
  let anyReviewedLine = false;
  let advisory = 0;
  let anyAdvisory = false;
  let approvedGross = 0;
  let anyApproved = false;
  let releasedNet = 0;
  const categories = new Map<string, ExposureCategory>();
  const cat = (key: string, label: string) => {
    if (!categories.has(key)) categories.set(key, { key, label, amount: 0, drawIds: [] });
    return categories.get(key)!;
  };
  let blockedUnique = 0;

  for (const d of nonCancelled) {
    const lines = repo.listDrawLines(d.id);
    for (const line of lines) {
      if (line.supportedAmount !== null) {
        supportable += line.supportedAmount;
        anyReviewedLine = true;
      } else if (line.status === "SUPPORTED") {
        supportable += line.currentRequested;
        anyReviewedLine = true;
      }
    }
    if (d.recommendedAmount !== null) {
      advisory += d.recommendedAmount;
      anyAdvisory = true;
    }
    if (d.approvedAmount !== null) {
      approvedGross += d.approvedAmount;
      anyApproved = true;
    }
    for (const ev of repo.listDrawAccountEvents(d.id)) {
      if (ev.type === "RELEASED") releasedNet += ev.amount;
    }

    if (!OPEN_DRAW_STATES.has(d.status)) continue;

    // Blocker categories for this open draw. Amounts within one category
    // never exceed the draw request; categories may overlap by design.
    let drawWideBlock = 0;
    let lineBlock = 0;
    const missing = drawsService.missingRequiredDocuments(d.id);
    if (missing.length > 0) {
      const c = cat("MISSING_DOCUMENTS", "Missing required documents");
      c.amount += d.requestedAmount;
      c.drawIds.push(d.id);
      drawWideBlock = d.requestedAmount;
    }
    const openExcForDraw = b.openExceptions.filter((e) => e.drawRequestId === d.id);
    if (openExcForDraw.length > 0) {
      const c = cat("OPEN_EXCEPTIONS", "Unresolved exceptions");
      c.amount += d.requestedAmount;
      c.drawIds.push(d.id);
      drawWideBlock = d.requestedAmount;
    }
    const gateBlockedLines = repo
      .listDrawLines(d.id)
      .filter((l) => {
        if (!l.milestoneId) return false;
        const g = b.gatesById.get(l.milestoneId);
        return !!g && g.eligibility.result === "BLOCKED";
      });
    if (gateBlockedLines.length > 0) {
      const amount = gateBlockedLines.reduce((s, l) => s + l.currentRequested, 0);
      const c = cat("INSPECTION_OR_GATE_BLOCKERS", "Completion-gate / inspection blockers");
      c.amount += amount;
      c.drawIds.push(d.id);
      lineBlock = Math.max(lineBlock, amount);
    }
    const coLines = repo.listDrawLines(d.id).filter((l) => {
      if (!l.changeOrderId) return false;
      const co = repo.getChangeOrder(l.changeOrderId);
      return !!co && !CO_APPROVED.has(co.status);
    });
    if (coLines.length > 0) {
      const amount = coLines.reduce((s, l) => s + l.currentRequested, 0);
      const c = cat("UNAPPROVED_CHANGE_ORDERS", "Unapproved change-order cost");
      c.amount += amount;
      c.drawIds.push(d.id);
      lineBlock = Math.max(lineBlock, amount);
    }
    // Unique per draw: a draw-wide blocker affects the full request;
    // otherwise the largest affected line set — never double counted.
    blockedUnique += Math.min(d.requestedAmount, Math.max(drawWideBlock, lineBlock));
  }

  const retainage = retainageService.retainageSummary(p.id);
  const held = repo
    .listAccountEventsForProject(p.id)
    .reduce((s, e) => s + (e.type === "HELD" ? e.amount : e.type === "RELEASED" ? -e.amount : 0), 0);

  return {
    projectId: p.id,
    submittedTotal,
    supportableTotal: anyReviewedLine ? supportable : null,
    advisoryTotal: anyAdvisory ? advisory : null,
    approvedGrossTotal: anyApproved ? approvedGross : null,
    releasedNetTotal: releasedNet,
    retainageWithheld: retainage.withheldToDate,
    retainageReleased: retainage.releasedToDate,
    tranchesHeld: Math.max(0, held),
    blockedUnique,
    categories: [...categories.values()],
    overlapNote:
      "Category totals can overlap: one draw amount may carry several blockers at once. " +
      "The unique blocked figure counts each affected amount exactly once.",
  };
}

function sumExposure(list: DrawExposure[]): DrawExposure {
  const catMap = new Map<string, ExposureCategory>();
  for (const e of list) {
    for (const c of e.categories) {
      const t = catMap.get(c.key) ?? { key: c.key, label: c.label, amount: 0, drawIds: [] };
      t.amount += c.amount;
      t.drawIds.push(...c.drawIds);
      catMap.set(c.key, t);
    }
  }
  const opt = (sel: (e: DrawExposure) => number | null): number | null => {
    const vals = list.map(sel).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return {
    projectId: null,
    submittedTotal: list.reduce((s, e) => s + e.submittedTotal, 0),
    supportableTotal: opt((e) => e.supportableTotal),
    advisoryTotal: opt((e) => e.advisoryTotal),
    approvedGrossTotal: opt((e) => e.approvedGrossTotal),
    releasedNetTotal: list.reduce((s, e) => s + e.releasedNetTotal, 0),
    retainageWithheld: list.reduce((s, e) => s + e.retainageWithheld, 0),
    retainageReleased: list.reduce((s, e) => s + e.retainageReleased, 0),
    tranchesHeld: list.reduce((s, e) => s + e.tranchesHeld, 0),
    blockedUnique: list.reduce((s, e) => s + e.blockedUnique, 0),
    categories: [...catMap.values()],
    overlapNote:
      "Category totals can overlap: one draw amount may carry several blockers at once. " +
      "The unique blocked figure counts each affected amount exactly once.",
  };
}

// ------------------------------------------------------- action queue

function deriveActions(
  healthByProject: ProjectControlHealth[],
  bundles: ProjectBundle[],
  now: number
): ControlAction[] {
  const actions: ControlAction[] = [];
  let seq = 0;
  const push = (a: Omit<ControlAction, "id">) => {
    if (a.sources.length === 0) return; // an action without a source record must not exist
    actions.push({ ...a, id: `act-${++seq}` });
  };

  const ACTION_META: Record<string, { title: (r: ControlReason) => string; priority: (r: ControlReason) => ActionPriority; mandatory: boolean; type: string }> = {
    LEDGER_INTEGRITY_FAILURE: { title: () => "Investigate ledger-integrity failure", priority: () => "IMMEDIATE", mandatory: true, type: "ledger-integrity" },
    INSPECTION_FAILED: { title: () => "Resolve failed inspection before governance", priority: () => "IMMEDIATE", mandatory: true, type: "inspection" },
    INSPECTION_EXPIRED: { title: () => "Address expired inspection or permit", priority: () => "IMMEDIATE", mandatory: true, type: "inspection" },
    EVIDENCE_REJECTED: { title: () => "Review rejected evidence", priority: () => "HIGH", mandatory: true, type: "evidence" },
    EVIDENCE_REJECTED_OUTSTANDING: { title: () => "Review rejected evidence", priority: () => "HIGH", mandatory: true, type: "evidence" },
    REQUIRED_DOCUMENT_MISSING: { title: () => "Record required inspection result document", priority: () => "HIGH", mandatory: true, type: "inspection" },
    HIGH_SEVERITY_EXCEPTION_OPEN: { title: (r) => r.detail.includes("CRITICAL") ? "Resolve critical exception" : "Resolve high-severity exception", priority: (r) => (r.detail.includes("CRITICAL") ? "IMMEDIATE" : "HIGH"), mandatory: true, type: "exception" },
    FINANCIAL_AHEAD_OF_PHYSICAL: { title: () => "Review financial progress ahead of verified physical progress", priority: () => "HIGH", mandatory: false, type: "variance" },
    UNAPPROVED_CHANGE_ORDER_IN_DRAW: { title: () => "Review unapproved change-order exposure", priority: () => "HIGH", mandatory: true, type: "change-order" },
    APPROVAL_OVERDUE: { title: () => "Complete overdue approval", priority: () => "HIGH", mandatory: true, type: "approval" },
    DRAW_DOCUMENTATION_INCOMPLETE: { title: () => "Review draw blocked by missing documents", priority: () => "HIGH", mandatory: true, type: "draw-documents" },
    REQUIRED_INSPECTION_UNSCHEDULED: { title: () => "Schedule required jurisdictional inspection", priority: () => "HIGH", mandatory: true, type: "inspection" },
    SCHEDULED_INSPECTION_OVERDUE: { title: () => "Follow up overdue scheduled inspection", priority: () => "NORMAL", mandatory: false, type: "inspection" },
    INSPECTION_REQUIREMENT_UNKNOWN: { title: () => "Determine jurisdictional inspection requirement", priority: () => "HIGH", mandatory: true, type: "inspection" },
    EVIDENCE_NEEDS_REVIEW: { title: () => "Review evidence flagged NEEDS REVIEW", priority: () => "NORMAL", mandatory: true, type: "evidence" },
    CLARIFICATION_OVERDUE: { title: () => "Answer overdue clarification", priority: () => "NORMAL", mandatory: false, type: "clarification" },
    OPEN_MEDIUM_FIELD_ISSUE: { title: () => "Resolve open field issue", priority: () => "NORMAL", mandatory: false, type: "field-issue" },
    PHYSICAL_PROGRESS_DATA_INCOMPLETE: { title: () => "Complete physical progress configuration", priority: () => "INFORMATIONAL", mandatory: false, type: "configuration" },
    FINANCIAL_PROGRESS_DATA_INCOMPLETE: { title: () => "Complete financial progress configuration", priority: () => "INFORMATIONAL", mandatory: false, type: "configuration" },
  };
  // Gate blocking codes not explicitly listed above fall back to a generic
  // milestone-gate action so no blocking reason is silently dropped.
  const fallbackMeta = { title: (r: ControlReason) => `Resolve completion-gate blocker (${r.code.replace(/_/g, " ").toLowerCase()})`, priority: () => "HIGH" as ActionPriority, mandatory: true, type: "gate" };

  for (const h of healthByProject) {
    const seen = new Set<string>();
    for (const r of h.reasons) {
      const key = `${r.code}|${r.sources.join("|")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const meta = ACTION_META[r.code] ?? (r.blocking ? fallbackMeta : null);
      if (!meta) continue;
      push({
        priority: meta.priority(r),
        type: meta.type,
        title: meta.title(r),
        explanation: r.detail,
        role: r.role ?? "PROJECT_MANAGER",
        projectId: h.projectId,
        projectName: h.projectName,
        ref: r.sources[0],
        amount: r.amount,
        detectedAt: r.detectedAt,
        slaState: r.code === "APPROVAL_OVERDUE" || r.code.includes("OVERDUE") ? "OVERDUE" : null,
        blocking: r.blocking,
        mandatory: meta.mandatory,
        sources: r.sources,
        href: r.href,
        overdue: r.code.includes("OVERDUE") || (r.detectedAt !== null && now - Date.parse(r.detectedAt) > 7 * DAY && r.blocking),
      });
    }
  }

  const prioRank: Record<ActionPriority, number> = { IMMEDIATE: 0, HIGH: 1, NORMAL: 2, INFORMATIONAL: 3 };
  return actions.sort(
    (a, b) => prioRank[a.priority] - prioRank[b.priority] || (b.amount ?? 0) - (a.amount ?? 0)
  );
}

export function filterActions(actions: ControlAction[], f: ActionFilters): ControlAction[] {
  return actions.filter((a) => {
    if (f.role && a.role !== f.role) return false;
    if (f.priority && a.priority !== f.priority) return false;
    if (f.projectId && a.projectId !== f.projectId) return false;
    if (f.type && a.type !== f.type) return false;
    if (f.blocking === "true" && !a.blocking) return false;
    if (f.blocking === "false" && a.blocking) return false;
    if (f.overdue === "true" && !a.overdue) return false;
    if (f.overdue === "false" && a.overdue) return false;
    return true;
  });
}

// -------------------------------------------------- exception surveillance

function surveillanceRows(bundles: ProjectBundle[], user: User): SurveillanceRow[] {
  const rows: SurveillanceRow[] = [];
  const now = Date.now();
  for (const b of bundles) {
    for (const e of b.exceptions) {
      if (!exceptionsService.canAccessException(user, e)) continue;
      if (!exceptionsService.isOpen(e) && e.status !== "WAIVED") continue;
      const src = exceptionsService.sourceContext(e);
      const m = e.milestoneId ? b.milestones.find((x) => x.id === e.milestoneId) : null;
      const d = e.drawRequestId ? b.draws.find((x) => x.id === e.drawRequestId) : null;
      const owner = e.ownerUserId ? repo.getUser(e.ownerUserId)?.name ?? e.ownerUserId : "Unassigned";
      const blocking =
        (e.milestoneId !== null &&
          ["HIGH", "CRITICAL"].includes(e.severity) &&
          exceptionsService.isOpen(e)) ||
        e.sourceType === "LEDGER_INTEGRITY";
      rows.push({
        exceptionId: e.id,
        severity: e.severity,
        category: e.category,
        status: e.status,
        sourceType: e.sourceType,
        sourceLabel: src.label,
        projectId: b.project.id,
        projectName: b.project.name,
        milestoneLabel: m ? msLabel(m) : null,
        drawLabel: d ? `Draw #${d.drawNumber}` : null,
        detectedAt: e.openedAt,
        ageDays: exceptionsService.ageDays(e, now),
        sla: exceptionsService.slaState(e, now),
        owner,
        blocking,
        amount: exceptionAmount(e, b),
        nextAction:
          e.status === "WAIVED"
            ? "Waived — source truth unchanged"
            : blocking
              ? "Resolve before governance"
              : "Review and resolve at source",
        reconciliation:
          e.status === "WAIVED"
            ? "WAIVED (source condition unchanged)"
            : "Auto-resolves when the source condition clears; reopens if it recurs",
        href: `/exception/${e.id}`,
      });
    }
  }
  const sevRank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return rows.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9) || b.ageDays - a.ageDays);
}

// ---------------------------------------------------------- gate rows

function gateRowsFor(b: ProjectBundle): MilestoneGateRow[] {
  return b.milestones.map((m) => {
    const g = b.gatesById.get(m.id)!;
    const legacyReleased =
      m.accountStatus === "RELEASED" &&
      g.contractor.status === "NOT_REPORTED" &&
      g.requirement === null;
    return {
      milestoneId: m.id,
      projectId: b.project.id,
      label: msLabel(m),
      trancheAmount: m.trancheAmount,
      contractor: g.contractor.status,
      evidence: g.evidenceReview.status,
      requirement: g.requirementValue,
      inspection: g.inspectionGate,
      governance: g.eligibility.result,
      funds: m.accountStatus,
      legacyReleased,
      blockingReasons: g.eligibility.reasons.filter((r) => r.blocking),
    };
  });
}

// ---------------------------------------------------------- main assembly

export function computeControlIntelligence(opts: {
  user: User;
  chainValid: boolean;
  projectId?: string | null;
}): ControlIntelligenceData {
  const now = Date.now();
  const generatedAt = new Date(now).toISOString();
  let projects = repo.listProjects().filter((p) => p.status === "ACTIVE");
  if (opts.projectId) projects = projects.filter((p) => p.id === opts.projectId);

  const bundles = projects.map(collectBundle);
  const health = bundles.map((b) => evaluateProjectHealth(b, opts.chainValid, now));
  const exposureByProject = bundles.map(exposureForProject);
  const exposure = sumExposure(exposureByProject);
  const actions = deriveActions(health, bundles, now);
  const surveillance = surveillanceRows(bundles, opts.user);
  const gateRows = bundles.flatMap(gateRowsFor);

  // ---- portfolio summary metrics (definitions shown in methodology) ----
  const allGates = bundles.flatMap((b) => [...b.gatesById.values()]);
  const evidenceAwaitingReview = allGates.filter(
    (g) => g.evidenceReview.status === "NEEDS_REVIEW" || g.evidenceReview.status === "UNDER_REVIEW"
  ).length;
  const inspectionsPending = allGates.filter((g) =>
    ["REQUIRED_UNSCHEDULED", "SCHEDULED", "COMPLETED_PENDING_RESULT"].includes(g.inspectionGate)
  ).length;
  const overdueApprovals = repo.listPendingApprovalRequests().filter((a) => {
    const m = a.milestoneId ? repo.getMilestone(a.milestoneId) : null;
    return !!m && projects.some((p) => p.id === m.projectId) && now - Date.parse(a.createdAt) > APPROVAL_SLA_MS;
  }).length;
  const openHighCritical = bundles.reduce(
    (s, b) => s + b.openExceptions.filter((e) => e.severity === "HIGH" || e.severity === "CRITICAL").length,
    0
  );
  const physList = projects.map((p) => budgetService.assessPhysicalProgress(p.id));
  const finList = projects.map((p) => budgetService.assessFinancialProgress(p.id));
  const physComplete = physList.every((x) => x.dataComplete);
  const finComplete = finList.every((x) => x.dataComplete);
  // Budget-weighted portfolio percentages (single-project portfolios reduce
  // to that project's figure). Marked DATA_INCOMPLETE if any input is.
  const weightBy = (vals: Array<{ pct: number; weight: number }>): number | null => {
    const totalW = vals.reduce((s, v) => s + v.weight, 0);
    if (totalW <= 0) return null;
    return Math.round(vals.reduce((s, v) => s + v.pct * v.weight, 0) / totalW);
  };
  const portfolioPhysical = weightBy(
    physList.map((x, i) => ({ pct: x.verifiedPct, weight: finList[i].budgetBasis }))
  );
  const portfolioFinancial = weightBy(
    finList.map((x) => ({ pct: x.paidPct, weight: x.budgetBasis }))
  );

  const metric = (
    key: string, label: string, kind: ControlMetric["kind"], value: number | null,
    state: MetricState, definition: string, href: string | null
  ): ControlMetric => ({ key, label, kind, value, state, definition, href });

  const summary: ControlMetric[] = [
    metric("attention", "Projects requiring attention", "count",
      health.filter((h) => h.status !== "HEALTHY").length, "OK",
      "Count of active projects whose control status is not HEALTHY under the documented rule order.", "#attention"),
    metric("exceptions", "Open HIGH / CRITICAL exceptions", "count", openHighCritical, "OK",
      "Open (not resolved, closed, or waived) exceptions with severity HIGH or CRITICAL in the governed exception register.", "/exceptions"),
    metric("drawBlocked", "Draw value currently blocked", "money", exposure.blockedUnique, "OK",
      "Unique blocked amount across open draws: each draw's affected amount counted once even when several blocker categories apply.", "#exposure"),
    metric("evidenceReview", "Evidence awaiting review", "count", evidenceAwaitingReview, "OK",
      "Milestones whose latest governed evidence state is NEEDS_REVIEW or UNDER_REVIEW.", "/compliance"),
    metric("inspections", "Inspections pending", "count", inspectionsPending, "OK",
      "Milestones whose inspection gate is REQUIRED_UNSCHEDULED, SCHEDULED, or COMPLETED_PENDING_RESULT.", "#gates"),
    metric("overdueApprovals", "Overdue approvals", "count", overdueApprovals, "OK",
      "Formal approval requests pending longer than 48 hours.", "/approvals"),
    metric("fundsHeld", "Funds currently held", "money", exposure.tranchesHeld, "OK",
      "Milestone tranche amounts recorded HELD on the virtual account, net of released tranches.", "/ledger"),
    metric("retainage", "Retainage currently withheld", "money", exposure.retainageWithheld, "OK",
      "Retainage withheld to date by governed draw releases, minus governed retainage releases is shown separately.", "#exposure"),
    metric("physical", "Portfolio verified physical progress", "pct", portfolioPhysical,
      physComplete && portfolioPhysical !== null ? "OK" : "DATA_INCOMPLETE",
      "Budget-basis-weighted verified physical progress across active projects (milestone-verification-grounded).", "/budget"),
    metric("financial", "Portfolio governed financial progress", "pct", portfolioFinancial,
      finComplete && portfolioFinancial !== null ? "OK" : "DATA_INCOMPLETE",
      "Budget-basis-weighted paid-to-date percentage across active projects (governed releases only).", "/budget"),
  ];

  // ---- operational capacity & schedule exposure ----
  const clarOpen = repo.listClarifications().filter((c) => OPEN_CLAR_STATES.has(c.status));
  const openIssues = repo.listFieldIssues().filter(
    (i) => OPEN_ISSUE_STATES.has(i.status) && projects.some((p) => p.id === i.projectId)
  );
  const docDeficiencies = new Map<string, number>();
  for (const b of bundles) {
    for (const d of b.draws) {
      if (!OPEN_DRAW_STATES.has(d.status)) continue;
      for (const r of drawsService.missingRequiredDocuments(d.id)) {
        docDeficiencies.set(r.docType, (docDeficiencies.get(r.docType) ?? 0) + 1);
      }
    }
  }
  const repeatedDocs = [...docDeficiencies.entries()].filter(([, n]) => n > 1);
  const capacity: CapacityIndicator[] = [
    { key: "evidence-backlog", label: "Evidence items awaiting review", count: evidenceAwaitingReview, detail: "Milestones with evidence in NEEDS_REVIEW or UNDER_REVIEW.", href: "/compliance" },
    { key: "approvals-waiting", label: "Approvals awaiting action", count: repo.listPendingApprovalRequests().filter((a) => { const m = a.milestoneId ? repo.getMilestone(a.milestoneId) : null; return !!m && projects.some((p) => p.id === m.projectId); }).length, detail: "Formal approval requests with outstanding required roles.", href: "/approvals" },
    { key: "approvals-overdue", label: "Approvals beyond the 48-hour SLA", count: overdueApprovals, detail: "Pending approval requests older than 48 hours.", href: "/approvals" },
    { key: "inspections-unscheduled", label: "Required inspections not scheduled", count: allGates.filter((g) => g.inspectionGate === "REQUIRED_UNSCHEDULED").length, detail: "Milestones with a REQUIRED determination and no scheduled inspection.", href: "#gates" },
    { key: "inspections-overdue", label: "Scheduled inspections overdue", count: allGates.filter((g) => g.inspection && g.inspectionGate === "SCHEDULED" && g.inspection.scheduledAt !== null && now > Date.parse(g.inspection.scheduledAt) + DAY).length, detail: "Scheduled inspections past their date without a completion record.", href: "#gates" },
    { key: "clarifications", label: "Unresolved clarifications", count: clarOpen.length, detail: "Clarification requests in OPEN or REOPENED state.", href: "/compliance" },
    { key: "field-issues", label: "Open field issues", count: openIssues.length, detail: "Field issues not yet resolved or closed.", href: "/issues" },
    { key: "repeat-docs", label: "Repeat document deficiencies", count: repeatedDocs.length, detail: repeatedDocs.length ? repeatedDocs.map(([t, n]) => `${t.replace(/_/g, " ")} ×${n}`).join(", ") : "No document type is missing on more than one draw.", href: "/draws" },
    { key: "variance-ahead", label: "Projects with financial progress ahead of verified physical", count: finList.filter((f) => f.varianceState === "FINANCIAL_AHEAD").length, detail: "FINANCIAL_AHEAD variance state under the configured thresholds.", href: "/budget" },
  ];

  // ---- attention table ----
  const attention: AttentionRow[] = bundles.map((b, i) => {
    const h = health[i];
    const e = exposureByProject[i];
    const fin = finList[i];
    const phys = physList[i];
    const firstAction = actions.find((a) => a.projectId === b.project.id) ?? null;
    return {
      projectId: b.project.id,
      name: b.project.name,
      status: h.status,
      verifiedPhysicalPct: phys.dataComplete ? phys.verifiedPct : null,
      governedFinancialPct: fin.dataComplete ? fin.paidPct : null,
      variancePts: fin.dataComplete ? fin.variancePts : null,
      varianceState: fin.varianceState,
      openBlockers: h.reasons.filter((r) => r.blocking).length,
      highCriticalExceptions: b.openExceptions.filter((x) => x.severity === "HIGH" || x.severity === "CRITICAL").length,
      drawBlocked: e.blockedUnique,
      fundsHeld: e.tranchesHeld,
      pendingInspections: [...b.gatesById.values()].filter((g) =>
        ["REQUIRED_UNSCHEDULED", "SCHEDULED", "COMPLETED_PENDING_RESULT"].includes(g.inspectionGate)
      ).length,
      nextAction: firstAction?.title ?? null,
      nextActionHref: firstAction?.href ?? null,
    };
  });

  return {
    generatedAt,
    chainValid: opts.chainValid,
    summary,
    health,
    surveillance,
    actions,
    actionTypes: [...new Set(actions.map((a) => a.type))].sort(),
    exposure,
    exposureByProject,
    gateRows,
    capacity,
    attention,
    methodology: {
      statement: METHODOLOGY_STATEMENT,
      ruleOrder: RULE_ORDER_DOC,
      sourceModels: [
        "EvidenceItem + Verification (governed evidence pipeline — read only)",
        "Milestone completion gates (completionGates.milestoneGates / evaluateDrawEligibility)",
        "JurisdictionalInspection + InspectionRequirement (reviewed records only)",
        "ObvException register (authoritative exception truth — linked, never duplicated)",
        "DrawRequest / DrawLineItem / DrawDocumentRequirement",
        "Budget lines + physical/financial progress computations",
        "ApprovalRequest / ApprovalRecord (formal governance)",
        "ChangeOrder register",
        "Retainage policy, releases and events",
        "Virtual account events (HELD / RELEASED — read only)",
        "Evidence Ledger chain verification result",
      ],
      limitations: [
        "A ledger integrity failure is evaluated portfolio-wide and marks every active project BLOCKED until investigated.",
        "Draw supportable/advisory/approved totals are shown NOT AVAILABLE until a reviewer, advisory recommendation, or completed governance records them — they are never inferred.",
        "Blocked-amount categories intentionally overlap; only the unique figure is additive.",
        "Approval SLA (48h) and clarification SLA (3d) are fixed demo configuration values.",
        "DATA_INCOMPLETE reflects missing control information; it is never displayed as zero.",
      ],
      generatedAt,
    },
  };
}

export function sortAttention(rows: AttentionRow[], key: string): AttentionRow[] {
  const statusRank = new Map(STATUS_ORDER.map((s, i) => [s, i]));
  const sorted = [...rows];
  switch (key) {
    case "blocked":
      return sorted.sort((a, b) => b.drawBlocked - a.drawBlocked);
    case "exceptions":
      return sorted.sort((a, b) => b.highCriticalExceptions - a.highCriticalExceptions);
    case "variance":
      return sorted.sort((a, b) => (b.variancePts ?? -999) - (a.variancePts ?? -999));
    case "blockers":
      return sorted.sort((a, b) => b.openBlockers - a.openBlockers);
    default: // attention priority
      return sorted.sort(
        (a, b) =>
          statusRank.get(a.status)! - statusRank.get(b.status)! || b.drawBlocked - a.drawBlocked
      );
  }
}
