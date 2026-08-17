/**
 * Draw Readiness Engine — deterministic, explainable readiness for lender
 * review. See docs/DRAW_READINESS_ENGINE.md.
 *
 * ONE SYNTHESIS, NO NEW TRUTH. Every fact consumed here already exists in
 * a governed register: completeness checks, reviewer line decisions,
 * document checklist, milestone gates (permits, code basis, official
 * sources, jurisdictional inspections), the exception register and the
 * lender decision record. The engine normalizes them into one answer —
 * what is preventing this draw from being ready for lender review — and
 * never creates, mutates or overrides any of them.
 *
 * WHAT READINESS IS NOT. Readiness is not approval, not funding, not
 * legal compliance, not payment authorization and not settlement.
 * READY means READY FOR LENDER REVIEW; the lender's decision, dual-control
 * governance, release eligibility and settlement remain their own
 * governed workflows, untouched by this module.
 *
 * SHAPE. `assembleReadinessInput` (I/O, batched) is separate from
 * `evaluateDrawReadiness` (pure — no database, no clock, no HTTP), which
 * is separate from rendering. Identical inputs produce identical results.
 */
import * as repo from "../db/repo";
import * as draws from "./draws";
import * as completionGates from "./completionGates";
import * as lenderDecisions from "./lenderDecisions";
import { LenderError } from "./lenderAccess";
import { notifyGovernedEvent } from "./pilot/notify";
import type {
  DrawLineItem,
  DrawRequest,
  LenderDrawDecision,
  MilestoneGates,
  ObvException,
  User,
} from "../../shared/types";

// ------------------------------------------------------------ model

export type ReadinessStatus = "READY" | "HOLD" | "EXCEPTION_REVIEW" | "INCOMPLETE";

export type ReadinessCategory =
  | "INTEGRITY"
  | "EVIDENCE"
  | "GOVERNMENT_INSPECTION"
  | "PERMIT"
  | "DRAW_INSPECTION"
  | "DOCUMENT"
  | "LIEN"
  | "BUDGET"
  | "CHANGE_ORDER"
  | "EXCEPTION"
  | "PROJECT_CONTROL"
  | "RETAINAGE";

export type CategoryState = "PASS" | "HOLD" | "WARNING" | "NOT_APPLICABLE" | "UNKNOWN";

export interface ReadinessReason {
  code: string;
  category: ReadinessCategory;
  message: string;
  /** The governed record this reason derives from — never invented. */
  sourceRecordId: string | null;
  lineItemId: string | null;
  nextAction: string;
  /** Whether the configured policy permits proceeding past this reason
   *  by documented lender exception. Never true for integrity or for
   *  reviewer work that has simply not finished. */
  exceptionAllowed: boolean;
}

export interface LineReadiness {
  lineItemId: string;
  description: string;
  requested: number;
  /** Reviewer-recorded support. Null while the line is unreviewed —
   *  an unreviewed value is never presumed. */
  supported: number | null;
  variance: number | null;
  status: "READY" | "HOLD" | "PENDING";
  reason: string | null;
}

export interface ReadinessCategoryView {
  category: ReadinessCategory;
  state: CategoryState;
  detail: string;
}

export interface DrawReadinessResult {
  drawRequestId: string;
  status: ReadinessStatus;
  requestedAmount: number;
  /** The recorded support formula (identical to the lender-decision
   *  verified amount): SUPPORTED→current, PARTIALLY→recorded amount,
   *  EXCEPTION/REJECTED/PENDING→0. Never derived from percentages. */
  supportableAmount: number;
  supportBasis: "FULL_REVIEW" | "PARTIAL_REVIEW" | "NO_REVIEW";
  blockingReasons: ReadinessReason[];
  /** Advisory findings and non-blocking conditions. Never change status. */
  warnings: ReadinessReason[];
  satisfiedRequirements: Array<{ code: string; category: ReadinessCategory; message: string }>;
  primaryBlocker: ReadinessReason | null;
  nextActions: string[];
  lineReadiness: LineReadiness[];
  categories: ReadinessCategoryView[];
  /** A recorded approving lender decision exists while requirements
   *  remain outstanding. The blocker list is UNCHANGED by this — the
   *  requirement stays OUTSTANDING with this lender disposition shown
   *  alongside it, permanently (also persisted in the decision
   *  snapshot). */
  proceededByException: {
    decisionId: string;
    decision: string;
    justification: string | null;
  } | null;
  evaluatedAt: string;
  policyVersion: number;
  inputRefs: {
    lineCount: number;
    documentRequirementCount: number;
    evidenceLinkCount: number;
    openExceptionCount: number;
    milestoneGateCount: number;
    decisionId: string | null;
  };
}

export interface ReadinessPolicy {
  version: number;
  /** Per-category: may an authorized lender proceed by documented
   *  exception past a blocker of this category? */
  exceptionEligible: Record<ReadinessCategory, boolean>;
}

export const READINESS_POLICY_VERSION = 1;

export const DEFAULT_READINESS_POLICY: ReadinessPolicy = {
  version: READINESS_POLICY_VERSION,
  exceptionEligible: {
    INTEGRITY: false,
    // Evidence blockers (missing links, review outstanding, rejected
    // verification) are exception-eligible: an authorized lender may
    // proceed by DOCUMENTED exception — the blocker is snapshotted as
    // PROCEEDED BY EXCEPTION, never erased. Only INTEGRITY findings and
    // the pinned codes below are beyond a business-risk decision.
    EVIDENCE: true,
    GOVERNMENT_INSPECTION: true,
    PERMIT: true,
    DRAW_INSPECTION: true,
    DOCUMENT: true,
    LIEN: true,
    BUDGET: false,
    CHANGE_ORDER: true,
    EXCEPTION: true,
    PROJECT_CONTROL: true,
    RETAINAGE: true,
  },
};

/** Deterministic primary-blocker ordering (concise UI only — every
 *  blocker is always returned). */
const CATEGORY_PRIORITY: ReadinessCategory[] = [
  "INTEGRITY",
  "EVIDENCE",
  "GOVERNMENT_INSPECTION",
  "PERMIT",
  "DRAW_INSPECTION",
  "DOCUMENT",
  "LIEN",
  "BUDGET",
  "CHANGE_ORDER",
  "EXCEPTION",
  "PROJECT_CONTROL",
  "RETAINAGE",
];

/** Codes that describe MISSING INFORMATION rather than a failed
 *  requirement. Alone they yield INCOMPLETE, never READY and never a
 *  silent pass. */
const UNKNOWN_INFO_CODES = new Set([
  "DRAW_IN_DRAFT",
  "DRAW_CANCELLED",
  "NO_LINE_ITEMS",
  "DRAW_STRUCTURE_INCOMPLETE",
  "INSPECTION_REQUIREMENT_UNKNOWN",
  "PERMIT_STATUS_UNKNOWN",
]);

/** Reasons a lender exception can never bypass, regardless of category
 *  policy: incomplete reviewer work and integrity failures are not
 *  waivable business requirements. */
const NEVER_EXCEPTIONABLE_CODES = new Set([
  // Incomplete reviewer work: the review must be finished, not waived —
  // the same rule that keeps verifiedAmount null on a partial review.
  "LINE_REVIEW_INCOMPLETE",
  // Structural math failure: lines not reconciling to the requested
  // amount is a defect in the draw itself, not a waivable business risk.
  "RECONCILIATION_FAILED",
  // Missing information can never be waived into existence.
  ...UNKNOWN_INFO_CODES,
]);

// ------------------------------------------------------------ input

export interface ReadinessGateRef {
  milestoneId: string;
  label: string;
  gates: MilestoneGates;
  /** True when the milestone has CONFIGURED required evidence
   *  (EvidenceRequirement rows with required = true). Only a configured
   *  requirement can make absent evidence a blocker — the engine never
   *  invents a stricter rule than project configuration. */
  requiredEvidenceConfigured: boolean;
}

export interface DrawReadinessInput {
  draw: DrawRequest;
  lines: DrawLineItem[];
  completeness: draws.DrawCompleteness;
  checklist: Array<{
    requirementId: string;
    title: string;
    docType: string;
    required: boolean;
    state: string;
  }>;
  evidenceLinkCount: number;
  gates: ReadinessGateRef[];
  openExceptions: ObvException[];
  decision: { record: LenderDrawDecision; blockingConditions: number } | null;
  /** Advisory INFO reasons from the recommendation engine — warnings only. */
  advisoryNotes: string[];
  evaluatedAt: string;
}

/**
 * Assemble everything the evaluator needs in one pass. Each register is
 * read once; the pure evaluator then never touches the database. Reuses
 * the existing service reads (same query pattern the Draw Review page
 * already performs) rather than adding new query shapes.
 */
export function assembleReadinessInput(drawRequestId: string, evaluatedAt?: string): DrawReadinessInput {
  const draw = repo.getDrawRequest(drawRequestId);
  if (!draw) throw new LenderError("Unknown draw request", 404);
  const lines = repo.listDrawLines(drawRequestId);
  const completeness = draws.completeness(drawRequestId);
  const checklist = draws
    .documentChecklist(drawRequestId)
    .filter((row) => row.requirement !== null)
    .map((row) => ({
      requirementId: row.requirement!.id,
      title: row.requirement!.title,
      docType: row.requirement!.docType,
      required: row.requirement!.required,
      state: row.state,
    }));
  const evidenceLinkCount = repo.listDrawEvidenceLinks(drawRequestId).length;
  const milestoneIds = [...new Set(lines.map((l) => l.milestoneId).filter((m): m is string => Boolean(m)))];
  const gates: ReadinessGateRef[] = milestoneIds.map((milestoneId) => {
    const ms = repo.getMilestone(milestoneId);
    return {
      milestoneId,
      label: ms ? `M${ms.seq} · ${ms.title}` : milestoneId,
      gates: completionGates.milestoneGates(milestoneId),
      requiredEvidenceConfigured: repo.listRequirementsForMilestone(milestoneId).some((r) => r.required),
    };
  });
  const openExceptions = repo
    .listExceptionsForProject(draw.projectId)
    .filter((e) => e.drawRequestId === drawRequestId)
    .filter((e) => ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"].includes(e.status));
  const decisionRecord = lenderDecisions.currentDecision(drawRequestId);
  const decision = decisionRecord
    ? { record: decisionRecord, blockingConditions: lenderDecisions.blockingConditions(decisionRecord.id).length }
    : null;
  // Advisory INFO reasons (grounded-progress cross-checks) come from the
  // existing recommendation engine — consumed as prose warnings only.
  const advisoryNotes = draws
    .computeRecommendation(drawRequestId)
    .reasons.filter((r) => r.kind === "INFO")
    .map((r) => r.detail);
  return {
    draw,
    lines,
    completeness,
    checklist,
    evidenceLinkCount,
    gates,
    openExceptions,
    decision,
    advisoryNotes,
    evaluatedAt: evaluatedAt ?? new Date().toISOString(),
  };
}

// ------------------------------------------------------------ evaluator

const money = (n: number): string => "$" + n.toLocaleString("en-US");

/** The single recorded support formula — identical to the one the lender
 *  decision workflow and recommendation engine already apply. */
function lineSupport(line: DrawLineItem): number {
  if (line.status === "SUPPORTED") return line.currentRequested;
  if (line.status === "PARTIALLY_SUPPORTED") return line.supportedAmount ?? 0;
  return 0;
}

function gateReasonCategory(code: string): ReadinessCategory {
  if (code.startsWith("PERMIT") || code === "REQUIRED_PERMIT_MISSING") return "PERMIT";
  if (code === "CODE_BASIS_MISSING" || code === "OFFICIAL_SOURCE_MISSING") return "PERMIT";
  if (code.startsWith("INSPECTION") || code.startsWith("REINSPECTION") || code === "JURISDICTIONAL_INSPECTION_NOT_PASSED")
    return "GOVERNMENT_INSPECTION";
  if (code.startsWith("EVIDENCE")) return "EVIDENCE";
  if (code === "REQUIRED_DOCUMENT_MISSING") return "DOCUMENT";
  if (code === "HIGH_SEVERITY_EXCEPTION_OPEN") return "EXCEPTION";
  if (code === "CHANGE_ORDER_NOT_APPROVED") return "CHANGE_ORDER";
  return "PROJECT_CONTROL";
}

const GATE_NEXT_ACTION: Record<ReadinessCategory, string> = {
  INTEGRITY: "Investigate the integrity finding before any further review.",
  EVIDENCE: "Resolve the evidence review state for the referenced milestone.",
  GOVERNMENT_INSPECTION: "Complete the requirement and record the required inspection outcome.",
  PERMIT: "Bring the permit record to an active, reviewed state.",
  DRAW_INSPECTION: "Complete the lender draw inspection workflow.",
  DOCUMENT: "Collect and review the required document.",
  LIEN: "Collect and review the required lien waiver.",
  BUDGET: "Correct the draw so line items reconcile to the requested amount.",
  CHANGE_ORDER: "Route the change order through formal approval.",
  EXCEPTION: "Resolve or formally disposition the open exception.",
  PROJECT_CONTROL: "Complete the outstanding project-control step.",
  RETAINAGE: "Resolve the retainage condition.",
};

/**
 * Pure, deterministic evaluation. No I/O: everything arrives assembled,
 * `evaluatedAt` is injected, and identical inputs produce identical
 * results (asserted by test).
 */
export function evaluateDrawReadiness(
  input: DrawReadinessInput,
  policy: ReadinessPolicy = DEFAULT_READINESS_POLICY
): DrawReadinessResult {
  const blocking: ReadinessReason[] = [];
  const warnings: ReadinessReason[] = [];
  const satisfied: Array<{ code: string; category: ReadinessCategory; message: string }> = [];

  const allowed = (category: ReadinessCategory, code: string): boolean =>
    policy.exceptionEligible[category] && !NEVER_EXCEPTIONABLE_CODES.has(code);

  const block = (
    code: string,
    category: ReadinessCategory,
    message: string,
    sourceRecordId: string | null,
    lineItemId: string | null = null,
    nextAction?: string
  ): void => {
    blocking.push({
      code,
      category,
      message,
      sourceRecordId,
      lineItemId,
      nextAction: nextAction ?? GATE_NEXT_ACTION[category],
      exceptionAllowed: allowed(category, code),
    });
  };
  const warn = (
    code: string,
    category: ReadinessCategory,
    message: string,
    sourceRecordId: string | null,
    lineItemId: string | null = null
  ): void => {
    warnings.push({
      code,
      category,
      message,
      sourceRecordId,
      lineItemId,
      nextAction: GATE_NEXT_ACTION[category],
      exceptionAllowed: false,
    });
  };

  // ---- 0. draw structure -------------------------------------------
  if (input.draw.status === "DRAFT") {
    block("DRAW_IN_DRAFT", "PROJECT_CONTROL", "The draw has not been submitted for review.", input.draw.id, null,
      "Complete and submit the draw request.");
  }
  if (input.draw.status === "CANCELLED") {
    block("DRAW_CANCELLED", "PROJECT_CONTROL", "The draw request was cancelled.", input.draw.id, null,
      "No action — the draw is closed.");
  }
  if (input.lines.length === 0) {
    block("NO_LINE_ITEMS", "PROJECT_CONTROL", "The draw carries no line items.", input.draw.id, null,
      "Add the draw's line items.");
  }

  // ---- 1. completeness (amount / period / lines / reconcile / evidence)
  for (const check of input.completeness.checks) {
    if (check.key === "documents") continue; // per-requirement reasons below carry the detail
    if (check.ok) {
      satisfied.push({ code: `COMPLETENESS_${check.key.toUpperCase()}`, category: check.key === "evidence" ? "EVIDENCE" : "BUDGET", message: check.label });
      continue;
    }
    if (check.key === "reconcile") {
      block("RECONCILIATION_FAILED", "BUDGET", `Line items do not reconcile to the requested amount — ${check.detail}`, input.draw.id);
    } else if (check.key === "evidence") {
      // Draw-level evidence links are RECOMMENDED in the governed model
      // (the completeness check says so verbatim) — a missing link is a
      // warning, never a blocker the model itself does not impose. The
      // configured-and-required evidence state per milestone blocks
      // below, from the governed evidence pipeline.
      warn("EVIDENCE_LINKS_MISSING", "EVIDENCE",
        "No field evidence is linked to this draw (recommended). Milestone evidence state is evaluated separately.",
        input.draw.id);
    } else if (check.key === "lines") {
      // Covered by NO_LINE_ITEMS above; avoid a duplicate reason.
    } else {
      block("DRAW_STRUCTURE_INCOMPLETE", "PROJECT_CONTROL", `${check.label}: ${check.detail}`, input.draw.id, null,
        "Complete the draw request fields.");
    }
  }

  // ---- 2. reviewer line decisions ----------------------------------
  const pendingLines = input.lines.filter((l) => l.status === "PENDING");
  if (input.lines.length > 0 && pendingLines.length > 0 && input.draw.status !== "DRAFT") {
    block(
      "LINE_REVIEW_INCOMPLETE",
      "PROJECT_CONTROL",
      `${pendingLines.length} of ${input.lines.length} line items have no recorded reviewer decision.`,
      input.draw.id,
      null,
      "Record a reviewer decision on every line item."
    );
  }
  for (const l of input.lines) {
    if (l.status === "EXCEPTION" || l.status === "REJECTED") {
      warn("LINE_NOT_SUPPORTED", "BUDGET",
        `Line "${l.description}": ${money(l.currentRequested)} requested, ${money(lineSupport(l))} supported — ${l.reviewNotes ?? "recorded reviewer decision"}.`,
        l.id, l.id);
    } else if (l.status === "PARTIALLY_SUPPORTED") {
      warn("LINE_PARTIALLY_SUPPORTED", "BUDGET",
        `Line "${l.description}": ${money(l.currentRequested)} requested, ${money(lineSupport(l))} supported — ${l.reviewNotes ?? "recorded reviewer decision"}.`,
        l.id, l.id);
    }
  }

  // ---- 3. documents & lien waivers ---------------------------------
  const lienTypes = new Set(["LIEN_WAIVER", "CONDITIONAL_LIEN_WAIVER"]);
  for (const row of input.checklist) {
    if (!row.required) continue;
    const category: ReadinessCategory = lienTypes.has(row.docType) ? "LIEN" : "DOCUMENT";
    if (row.state === "ACCEPTED" || row.state === "RECEIVED") {
      satisfied.push({ code: "REQUIRED_DOCUMENT_ON_FILE", category, message: `${row.title} — ${row.state.toLowerCase()}` });
    } else if (row.state === "REJECTED") {
      block("REQUIRED_DOCUMENT_REJECTED", category, `Required document rejected: ${row.title}.`, row.requirementId);
    } else if (row.state === "EXPIRED") {
      block("REQUIRED_DOCUMENT_EXPIRED", category, `Required document expired: ${row.title}.`, row.requirementId);
    } else {
      block("REQUIRED_DOCUMENT_MISSING", category, `Required document missing: ${row.title}.`, row.requirementId);
    }
  }

  // ---- 4. milestone gates: permits, code basis, official sources,
  //         jurisdictional inspections, evidence review ---------------
  let anyUnknownRequirement = false;
  for (const ref of input.gates) {
    const elig = ref.gates.eligibility;
    let inspectionChainBlocked = false;
    for (const reason of elig.reasons) {
      // Milestone-lifecycle codes that do not describe a lender-review
      // requirement for the draw itself.
      if (["TRANCHE_RELEASED", "FORMAL_APPROVAL_PENDING", "CONTRACTOR_COMPLETION_NOT_REPORTED"].includes(reason.code)) continue;
      // Evidence pipeline states get readiness-specific handling: the
      // governed verdict decides, and only CONFIGURED required evidence
      // can make absence a blocker. (The gate marks most evidence states
      // non-blocking because tranche eligibility is a different gate.)
      if (reason.code === "EVIDENCE_NOT_SUBMITTED") {
        if (ref.requiredEvidenceConfigured) {
          block("REQUIRED_EVIDENCE_MISSING", "EVIDENCE",
            `${ref.label}: configured required evidence has not been submitted.`, ref.milestoneId, null,
            "Capture and submit the configured required evidence.");
        } else {
          warn("EVIDENCE_NOT_SUBMITTED", "EVIDENCE", `${ref.label}: ${reason.detail}`, ref.milestoneId);
        }
        continue;
      }
      if (reason.code === "EVIDENCE_NEEDS_REVIEW") {
        // Governed verdict NEEDS_REVIEW — a human reviewer decision is
        // required. The engine reacts to the verdict, never to the raw
        // advisory score behind it.
        block("EVIDENCE_NEEDS_REVIEW", "EVIDENCE", `${ref.label}: ${reason.detail}`, ref.milestoneId, null,
          "A human reviewer must resolve the flagged verification.");
        continue;
      }
      if (reason.code === "EVIDENCE_UNDER_REVIEW") {
        warn("EVIDENCE_UNDER_REVIEW", "EVIDENCE", `${ref.label}: ${reason.detail}`, ref.milestoneId);
        continue;
      }
      // An unapproved change order is surfaced even where the gate does
      // not block: supportable dollars come only from reviewer line
      // decisions, so the CO can never silently expand support — but the
      // lender must SEE it.
      if (reason.code === "CHANGE_ORDER_NOT_APPROVED" && !reason.blocking) {
        warn("CHANGE_ORDER_NOT_APPROVED", "CHANGE_ORDER", `${ref.label}: ${reason.detail}`, ref.milestoneId);
        continue;
      }
      // An undetermined inspection requirement is never a silent pass:
      // where the jurisdiction model does not gate it (legacy projects,
      // no configured profile) it surfaces as a warning — the category
      // shows WARNING, never PASS. Where configuration makes it gating
      // it blocks below and resolves to INCOMPLETE.
      if (reason.code === "INSPECTION_REQUIREMENT_UNKNOWN" && !reason.blocking) {
        warn("INSPECTION_REQUIREMENT_UNKNOWN", "GOVERNMENT_INSPECTION", `${ref.label}: ${reason.detail}`, ref.milestoneId);
        continue;
      }
      if (!reason.blocking) continue;
      const category = gateReasonCategory(reason.code);
      const code = reason.code === "INSPECTION_REQUIREMENT_UNKNOWN" ? "INSPECTION_REQUIREMENT_UNKNOWN" : reason.code;
      if (code === "INSPECTION_REQUIREMENT_UNKNOWN") anyUnknownRequirement = true;
      if (category === "GOVERNMENT_INSPECTION" || category === "PERMIT") inspectionChainBlocked = true;
      block(code, category, `${ref.label}: ${reason.detail}`, ref.milestoneId);
    }
    // The satisfied claim is suppressed while ANY part of the inspection
    // chain (result, permit, code basis, official source) is blocked — a
    // PASSED result without its reviewed official source is not a
    // satisfied requirement.
    if (ref.gates.requirementValue === "REQUIRED" && ref.gates.inspectionGate === "PASSED" && !inspectionChainBlocked) {
      satisfied.push({
        code: "REQUIRED_INSPECTION_PASSED",
        category: "GOVERNMENT_INSPECTION",
        message: `${ref.label}: required jurisdictional inspection passed.`,
      });
    }
    if (ref.gates.requirementValue === "NOT_REQUIRED") {
      satisfied.push({
        code: "INSPECTION_NOT_REQUIRED",
        category: "GOVERNMENT_INSPECTION",
        message: `${ref.label}: reviewed determination — no jurisdictional inspection required.`,
      });
    }
  }

  // ---- 5. exception register ----------------------------------------
  for (const e of input.openExceptions) {
    if (e.severity === "HIGH" || e.severity === "CRITICAL") {
      block("OPEN_BLOCKING_EXCEPTION", "EXCEPTION",
        `${e.severity} exception open: ${e.title}.`, e.id, null,
        "Resolve the exception or disposition it through the exception workflow.");
    } else {
      warn("OPEN_EXCEPTION", "EXCEPTION", `${e.severity} exception open: ${e.title}.`, e.id);
    }
  }

  // ---- 6. post-decision conditions (funding blockers, not review
  //         blockers — reported, never conflated) ---------------------
  if (input.decision && input.decision.blockingConditions > 0) {
    warn("DECISION_CONDITIONS_OPEN", "PROJECT_CONTROL",
      `${input.decision.blockingConditions} lender decision condition(s) remain unresolved — they block funding, not review.`,
      input.decision.record.id);
  }

  // ---- 7. advisory intelligence — warnings only ---------------------
  for (const note of input.advisoryNotes) {
    warn("ADVISORY_SIGNAL", "EVIDENCE", note, null);
  }

  // ---- amounts -------------------------------------------------------
  const supportable = input.lines.reduce((s, l) => s + lineSupport(l), 0);
  const reviewedCount = input.lines.filter((l) => l.status !== "PENDING").length;
  const supportBasis: DrawReadinessResult["supportBasis"] =
    input.lines.length === 0 || reviewedCount === 0
      ? "NO_REVIEW"
      : reviewedCount === input.lines.length
        ? "FULL_REVIEW"
        : "PARTIAL_REVIEW";

  // ---- per-line readiness -------------------------------------------
  const gateBlockedMilestones = new Set(
    blocking
      .filter((b) => ["GOVERNMENT_INSPECTION", "PERMIT"].includes(b.category))
      .map((b) => b.sourceRecordId)
      .filter(Boolean)
  );
  const lineReadiness: LineReadiness[] = input.lines.map((l) => {
    const supported = l.status === "PENDING" ? null : lineSupport(l);
    const variance = supported === null ? null : l.currentRequested - supported;
    let status: LineReadiness["status"] = "READY";
    let reason: string | null = null;
    if (l.status === "PENDING") {
      status = "PENDING";
      reason = "Awaiting reviewer decision.";
    } else if (l.milestoneId && gateBlockedMilestones.has(l.milestoneId)) {
      status = "HOLD";
      reason = "Required inspection or permit condition outstanding on the referenced milestone.";
    } else if (l.status === "EXCEPTION" || l.status === "REJECTED") {
      status = "HOLD";
      reason = l.reviewNotes ?? "Reviewer recorded the line as not supported.";
    } else if (variance !== null && variance > 0) {
      reason = l.reviewNotes ?? "Evidence supports the recorded amount only.";
    }
    return {
      lineItemId: l.id,
      description: l.description,
      requested: l.currentRequested,
      supported,
      variance,
      status,
      reason,
    };
  });

  // ---- status resolution --------------------------------------------
  // EXCEPTION_REVIEW is deliberately narrow: every configured requirement
  // is satisfied EXCEPT formally recorded exceptions that await the
  // lender's disposition (and policy permits proceeding past them). Any
  // other outstanding requirement — missing evidence, failed inspection,
  // missing document — is a HOLD, even when policy would allow a
  // documented override at decision time. Status describes what is
  // outstanding; override-eligibility is a separate axis enforced by the
  // decision gate.
  const unknownInfo = blocking.filter((b) => UNKNOWN_INFO_CODES.has(b.code));
  const substantive = blocking.filter((b) => !UNKNOWN_INFO_CODES.has(b.code));
  let status: ReadinessStatus;
  if (substantive.length > 0) {
    status = substantive.every((b) => b.category === "EXCEPTION" && b.exceptionAllowed)
      ? "EXCEPTION_REVIEW"
      : "HOLD";
  } else if (unknownInfo.length > 0 || anyUnknownRequirement) {
    status = "INCOMPLETE";
  } else {
    status = "READY";
  }

  // A recorded approving decision alongside outstanding requirements is
  // the permanent PROCEEDED BY EXCEPTION disposition — shown with the
  // blockers, never instead of them.
  const approvingDecision =
    input.decision && ["APPROVED", "CONDITIONALLY_APPROVED", "REDUCED"].includes(input.decision.record.decision)
      ? input.decision.record
      : null;
  const proceededByException =
    approvingDecision && substantive.length > 0
      ? {
          decisionId: approvingDecision.id,
          decision: approvingDecision.decision,
          justification: approvingDecision.exceptionsAccepted ?? approvingDecision.decisionReason ?? null,
        }
      : null;

  // ---- deterministic ordering ---------------------------------------
  const rank = (r: ReadinessReason): number => CATEGORY_PRIORITY.indexOf(r.category);
  const ordered = [...blocking].sort((a, b) => rank(a) - rank(b) || blocking.indexOf(a) - blocking.indexOf(b));
  const primaryBlocker = ordered[0] ?? null;
  const nextActions = [...new Set(ordered.map((b) => b.nextAction))].slice(0, 5);

  // ---- category rollup ----------------------------------------------
  const categories: ReadinessCategoryView[] = CATEGORY_PRIORITY.map((category) => {
    const catBlockers = ordered.filter((b) => b.category === category);
    const catWarnings = warnings.filter((w) => w.category === category);
    const catSatisfied = satisfied.filter((s) => s.category === category);
    let state: CategoryState;
    let detail: string;
    if (catBlockers.length > 0) {
      state = catBlockers.some((b) => UNKNOWN_INFO_CODES.has(b.code)) && catBlockers.every((b) => UNKNOWN_INFO_CODES.has(b.code))
        ? "UNKNOWN"
        : "HOLD";
      detail = catBlockers[0].message;
    } else if (catWarnings.length > 0) {
      state = "WARNING";
      detail = catWarnings[0].message;
    } else if (catSatisfied.length > 0) {
      state = "PASS";
      detail = `${catSatisfied.length} requirement(s) satisfied`;
    } else {
      state = "NOT_APPLICABLE";
      detail = "No configured requirement applies.";
    }
    return { category, state, detail };
  });

  return {
    drawRequestId: input.draw.id,
    status,
    requestedAmount: input.draw.requestedAmount,
    supportableAmount: supportable,
    supportBasis,
    blockingReasons: ordered,
    warnings,
    satisfiedRequirements: satisfied,
    primaryBlocker,
    nextActions,
    lineReadiness,
    categories,
    proceededByException,
    evaluatedAt: input.evaluatedAt,
    policyVersion: policy.version,
    inputRefs: {
      lineCount: input.lines.length,
      documentRequirementCount: input.checklist.length,
      evidenceLinkCount: input.evidenceLinkCount,
      openExceptionCount: input.openExceptions.length,
      milestoneGateCount: input.gates.length,
      decisionId: input.decision?.record.id ?? null,
    },
  };
}

/** Convenience: assemble + evaluate the current live readiness. */
export function drawReadiness(drawRequestId: string, evaluatedAt?: string): DrawReadinessResult {
  return evaluateDrawReadiness(assembleReadinessInput(drawRequestId, evaluatedAt));
}

// -------------------------------------------------- snapshots & audit

/**
 * Persist a readiness snapshot on a CONSEQUENTIAL event (a lender
 * decision, including proceed-by-exception). Live readiness is
 * recomputed on read and never audited — page refreshes must not create
 * audit noise. Snapshots use the existing draw_events infrastructure and
 * are never rewritten: later readiness changes cannot alter what OBV
 * showed at decision time.
 */
export function captureReadinessSnapshot(
  result: DrawReadinessResult,
  context: { decisionId: string | null; actorUserId: string; overriddenBlockers: string[] }
): void {
  repo.insertDrawEvent({
    id: "dre-" + Math.random().toString(36).slice(2, 12),
    drawRequestId: result.drawRequestId,
    type: "READINESS_SNAPSHOT",
    detail: JSON.stringify({
      status: result.status,
      requestedAmount: result.requestedAmount,
      supportableAmount: result.supportableAmount,
      supportBasis: result.supportBasis,
      blockingReasons: result.blockingReasons,
      warnings: result.warnings.map((w) => ({ code: w.code, category: w.category, message: w.message })),
      policyVersion: result.policyVersion,
      evaluatedAt: result.evaluatedAt,
      decisionId: context.decisionId,
      overriddenBlockers: context.overriddenBlockers,
    }),
    actorUserId: context.actorUserId,
    createdAt: new Date().toISOString(),
  });
}

/** The persisted snapshots for a draw, newest last. Parsed defensively —
 *  a snapshot is historical record, never re-evaluated. */
export function readinessSnapshots(drawRequestId: string): Array<{
  eventId: string;
  createdAt: string;
  actorUserId: string | null;
  snapshot: Record<string, unknown>;
}> {
  return repo
    .listDrawEvents(drawRequestId)
    .filter((e) => e.type === "READINESS_SNAPSHOT")
    .map((e) => {
      let snapshot: Record<string, unknown> = {};
      try {
        snapshot = JSON.parse(e.detail) as Record<string, unknown>;
      } catch {
        snapshot = { unparseable: true };
      }
      return { eventId: e.id, createdAt: e.createdAt, actorUserId: e.actorUserId, snapshot };
    });
}

// ------------------------------------------- governed decision wrapper

/**
 * Record a lender decision WITH readiness governance:
 *
 *  - computes readiness at decision time (what OBV showed);
 *  - an approving-type decision over a HOLD / EXCEPTION_REVIEW readiness
 *    requires explicit justification — either accepted exceptions or a
 *    decision reason. There is no unlabeled one-click bypass;
 *  - the decision itself still goes through the untouched lender-decision
 *    workflow (capability check, submitter exclusion, amount
 *    reconciliation, governance truth table, dual control);
 *  - a readiness snapshot is persisted with the overridden blockers, so
 *    the override never erases a blocker — the requirement stays
 *    OUTSTANDING with a lender disposition of PROCEEDED BY EXCEPTION.
 */
export function recordDecisionWithReadiness(
  user: User,
  drawRequestId: string,
  decisionInput: Omit<Parameters<typeof lenderDecisions.recordLenderDecision>[1], "drawRequestId">
): { decision: LenderDrawDecision; readinessAtDecision: DrawReadinessResult; proceededByException: boolean } {
  const readiness = drawReadiness(drawRequestId);
  const approvingType = ["APPROVED", "CONDITIONALLY_APPROVED", "REDUCED"].includes(decisionInput.decision);
  const overriding = approvingType && (readiness.status === "HOLD" || readiness.status === "EXCEPTION_REVIEW");
  // The readiness exception gate runs via beforePersist — AFTER the
  // decision service's entire refusal ladder (capability 403, submitter
  // separation 403, amount-shape 400, governance truth table 409,
  // supersede rules 409) so it never masks those pinned refusals, and
  // immediately before persistence so an unjustified override is refused
  // exactly when it would otherwise be recorded.
  const decision = lenderDecisions.recordLenderDecision(user, { ...decisionInput, drawRequestId }, {
    beforePersist: () => {
      if (!overriding) return;
      const justification =
        (decisionInput.exceptionsAccepted ?? "").trim() || (decisionInput.decisionReason ?? "").trim();
      if (!justification) {
        throw new LenderError(
          `OBV readiness is ${readiness.status} — recording ${decisionInput.decision} requires explicit ` +
            "justification (accepted exceptions or a decision reason). The outstanding requirements are " +
            "preserved and are never marked satisfied by this decision.",
          422
        );
      }
      const nonExceptionable = readiness.blockingReasons.filter((b) => !b.exceptionAllowed);
      if (nonExceptionable.length > 0) {
        throw new LenderError(
          "The configured readiness policy does not permit proceeding by exception past: " +
            nonExceptionable.map((b) => b.code).join(", ") +
            ". Resolve these requirements first.",
          422
        );
      }
    },
  });
  captureReadinessSnapshot(readiness, {
    decisionId: decision.id,
    actorUserId: user.id,
    overriddenBlockers: overriding ? readiness.blockingReasons.map((b) => b.code) : [],
  });
  return { decision, readinessAtDecision: readiness, proceededByException: overriding };
}

// ------------------------------------------------ transition detection

/**
 * Record a readiness transition and notify — called from governed
 * mutation points (line review completion, decision recording), NEVER
 * from page rendering. Notifies only on an actual state change, using
 * the existing tenant-scoped notification seam.
 */
export function recordReadinessTransition(drawRequestId: string, actorUserId: string | null): void {
  const result = drawReadiness(drawRequestId);
  const events = repo.listDrawEvents(drawRequestId).filter((e) => e.type === "READINESS_TRANSITION");
  const last = events[events.length - 1];
  let lastStatus: string | null = null;
  if (last) {
    try {
      lastStatus = (JSON.parse(last.detail) as { status?: string }).status ?? null;
    } catch {
      lastStatus = null;
    }
  }
  if (lastStatus === result.status) return;
  repo.insertDrawEvent({
    id: "drt-" + Math.random().toString(36).slice(2, 12),
    drawRequestId,
    type: "READINESS_TRANSITION",
    detail: JSON.stringify({ status: result.status, from: lastStatus, policyVersion: result.policyVersion }),
    actorUserId,
    createdAt: new Date().toISOString(),
  });
  const draw = repo.getDrawRequest(drawRequestId);
  if (!draw) return;
  if (result.status === "READY") {
    notifyGovernedEvent("DRAW_READY_FOR_REVIEW", {
      projectId: draw.projectId,
      drawRequestId,
      subject: `Draw #${draw.drawNumber} — ready for lender review`,
      body:
        `OBV readiness for draw #${draw.drawNumber} is READY: every configured requirement is satisfied. ` +
        `Requested ${money(result.requestedAmount)}, currently supported ${money(result.supportableAmount)}. ` +
        "Readiness is not approval — the lender decision remains a separate governed action.",
    });
  } else if ((result.status === "HOLD" || result.status === "EXCEPTION_REVIEW") && lastStatus === "READY") {
    notifyGovernedEvent("DRAW_READINESS_HOLD", {
      projectId: draw.projectId,
      drawRequestId,
      subject: `Draw #${draw.drawNumber} — moved to ${result.status}`,
      body:
        `OBV readiness for draw #${draw.drawNumber} moved to ${result.status}. ` +
        (result.primaryBlocker ? `Primary reason: ${result.primaryBlocker.message}` : "See the readiness detail."),
    });
  }
}
