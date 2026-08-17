/**
 * Lender Pilot RC1 — the composition layer that turns OBV's existing
 * capabilities into one focused lender workflow.
 *
 * EVERYTHING HERE IS DERIVED ON READ from records the governed
 * subsystems already hold: draw state, completeness, the approval
 * matrix, lender decisions, exceptions, inspections, and recorded
 * timestamps. This module owns no tables, performs no writes, and never
 * decides anything — the Next Action is a deterministic restatement of
 * authoritative workflow state for a human, never a probabilistic or
 * advisory override of it.
 */
import * as repo from "../../db/repo";
import * as authz from "../authz";
import * as draws from "../draws";
import * as lenderDecisions from "../lenderDecisions";
import type { DrawRequest, Project, User } from "../../../shared/types";

// ------------------------------------------------------------ next action

export interface NextAction {
  code:
    | "COMPLETE_DRAFT" | "UPLOAD_MISSING_DOCUMENTS" | "BEGIN_REVIEW"
    | "CONTINUE_LINE_REVIEW" | "AWAITING_REQUESTER" | "RESOLVE_EXCEPTIONS"
    | "INSPECTION_RESULT_REQUIRED" | "LENDER_REVIEW_READY"
    | "AWAITING_APPROVALS" | "RESOLVE_DECISION_CONDITIONS"
    | "RELEASE_TRANSITION_PENDING" | "REVISE_AND_RESUBMIT"
    | "NO_ACTION_REQUIRED";
  /** Human-readable, specific, and honest about who acts. */
  label: string;
  /** Which side of the workflow acts next. */
  actor: "CONTRACTOR" | "REVIEWER" | "INSPECTOR" | "LENDER" | "APPROVER" | "NONE";
  detail: string;
}

/**
 * The deterministic next action for one draw, computed from
 * AUTHORITATIVE records only, checked in workflow order. Two calls on
 * the same records always return the same answer.
 */
export function drawNextAction(drawRequestId: string, precomputed?: draws.DrawHeaderSummary): NextAction {
  const summary = precomputed ?? draws.drawHeaderSummary(drawRequestId);
  const draw = summary.draw;
  const done = (code: NextAction["code"], label: string, actor: NextAction["actor"], detail: string): NextAction =>
    ({ code, label, actor, detail });

  if (draw.status === "CANCELLED") {
    return done("NO_ACTION_REQUIRED", "Cancelled — no action required", "NONE", "The draw was cancelled.");
  }
  if (draw.status === "DRAFT") {
    return done("COMPLETE_DRAFT", "Contractor must complete and submit the draft", "CONTRACTOR",
      "The draw has not been submitted for review.");
  }
  if (draw.status === "RETURNED") {
    return done("REVISE_AND_RESUBMIT", "Draw returned — contractor must revise and resubmit", "CONTRACTOR",
      "The reviewer returned this draw with a recorded reason; resubmission restarts review.");
  }
  if (draw.status === "CLARIFICATION_REQUIRED") {
    return done("AWAITING_REQUESTER", "Awaiting contractor response to a clarification request", "CONTRACTOR",
      "A reviewer question is open; review resumes when the requester responds.");
  }

  const missing = draws.missingRequiredDocuments(draw.id);
  if ((draw.status === "SUBMITTED" || draw.status === "UNDER_REVIEW") && missing.length > 0) {
    const names = missing.slice(0, 3).map((m) => m.title).join(", ");
    return done(
      "UPLOAD_MISSING_DOCUMENTS",
      `Contractor must upload ${missing.length} missing document${missing.length === 1 ? "" : "s"}`,
      "CONTRACTOR",
      `Required documents outstanding: ${names}${missing.length > 3 ? ", …" : ""}. Missing documents block governance readiness, not submission.`
    );
  }

  // Open exceptions on this draw block or reduce eligibility — they are
  // the most consequential blocker after documents.
  const openExceptions = repo
    .listExceptionsForProject(draw.projectId)
    .filter((x) => (x as { drawRequestId?: string | null }).drawRequestId === draw.id)
    .filter((x) => !["RESOLVED", "CLOSED", "WAIVED"].includes(x.status));
  if ((draw.status === "SUBMITTED" || draw.status === "UNDER_REVIEW") && openExceptions.length > 0) {
    return done(
      "RESOLVE_EXCEPTIONS",
      `Reviewer must resolve ${openExceptions.length} open exception${openExceptions.length === 1 ? "" : "s"}`,
      "REVIEWER",
      "Open exceptions on this draw reduce or block release eligibility until resolved through the governed exception workflow."
    );
  }

  // Required inspections without a recorded result, on milestones this
  // draw's lines rest on.
  const lineMilestones = new Set(
    repo.listDrawLines(draw.id).map((l) => l.milestoneId).filter((m): m is string => Boolean(m))
  );
  const pendingInspections = repo
    .listInspectionsForProject(draw.projectId)
    .filter((i) => i.required && lineMilestones.has(i.milestoneId))
    .filter((i) => !i.resultRecordedAt && !["PASSED", "CANCELLED"].includes(i.status));
  if ((draw.status === "SUBMITTED" || draw.status === "UNDER_REVIEW") && pendingInspections.length > 0) {
    return done(
      "INSPECTION_RESULT_REQUIRED",
      `${pendingInspections.length} required inspection${pendingInspections.length === 1 ? "" : "s"} awaiting a recorded result`,
      "INSPECTOR",
      "An official inspection outcome must be recorded by an authorized reviewer before the affected lines can support release."
    );
  }

  if (draw.status === "SUBMITTED") {
    return done("BEGIN_REVIEW", "Lender review ready — begin line-item review", "REVIEWER",
      "The draw is submitted with its required documents on file.");
  }
  if (draw.status === "UNDER_REVIEW") {
    if (summary.pendingLines > 0) {
      return done("CONTINUE_LINE_REVIEW",
        `Reviewer must complete ${summary.pendingLines} remaining line review${summary.pendingLines === 1 ? "" : "s"}`,
        "REVIEWER", "Each line needs a recorded supported/exception decision before governance.");
    }
    return done("LENDER_REVIEW_READY", "All lines reviewed — finalize the recommendation for governance", "REVIEWER",
      "Line review is complete; the recommendation moves the draw to formal governance.");
  }

  if (draw.status === "READY_FOR_GOVERNANCE") {
    const total = summary.approval ? summary.approval.requiredRoles.length : 0;
    const recorded = summary.approvalRecords.length;
    return done(
      "AWAITING_APPROVALS",
      total > 0
        ? `Awaiting formal approvals (${recorded} of ${total} recorded)`
        : "Awaiting formal approvals",
      "APPROVER",
      "Release eligibility exists only when every required role has approved through the governed matrix."
    );
  }

  if (draw.status === "PARTIALLY_APPROVED" || draw.status === "APPROVED") {
    const decision = lenderDecisions.currentDecision(draw.id);
    if (decision) {
      const open = lenderDecisions.openConditions(decision.id);
      if (open.length > 0) {
        return done(
          "RESOLVE_DECISION_CONDITIONS",
          `${open.length} lender decision condition${open.length === 1 ? "" : "s"} still open`,
          "REVIEWER",
          "The recorded lender decision carries conditions that must be cleared before funding transitions."
        );
      }
    }
    return done("RELEASE_TRANSITION_PENDING", "Approved — release transition pending", "LENDER",
      "Governance approved the draw; the release/funding transition is the next recorded step.");
  }

  return done("NO_ACTION_REQUIRED", "Complete — no action required", "NONE",
    "The draw has reached a terminal recorded state.");
}

// ------------------------------------------------------ command center

export interface PilotDrawRow {
  drawRequestId: string;
  projectId: string;
  projectName: string;
  drawNumber: number;
  status: DrawRequest["status"];
  requested: number;
  supported: number;
  missingDocuments: number;
  ageDays: number;
  submittedAt: string | null;
  nextAction: NextAction;
}

export interface PilotCommandCenter {
  /** Buckets, each a real state grouping with real timestamps. */
  readyForDecision: PilotDrawRow[];
  waitingOnContractor: PilotDrawRow[];
  waitingOnInspection: PilotDrawRow[];
  complianceExceptions: PilotDrawRow[];
  aging: PilotDrawRow[];
  recentlyApproved: PilotDrawRow[];
  metrics: {
    activeProjects: number;
    openDraws: number;
    totalRequestedOpen: number;
    currentlyEligible: number;
    currentlyHeld: number;
    medianReviewDays: number | null;
    missingDocumentCount: number;
    unresolvedExceptions: number;
    approvalsAwaiting: number;
  };
  /** Draws aging beyond this many days land in the aging bucket. */
  agingThresholdDays: number;
  asOf: string;
}

export const AGING_THRESHOLD_DAYS = 10;
const OPEN_STATUSES: DrawRequest["status"][] = [
  "SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED", "READY_FOR_GOVERNANCE", "RETURNED",
];

/** The lender landing view: what needs attention today, from real state. */
export function pilotCommandCenter(user: User): PilotCommandCenter {
  const projects = authz.accessibleProjects(user);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const allDraws = draws.listDrawsForUser(user).filter((d) => projectById.has(d.projectId));

  const rows: PilotDrawRow[] = allDraws.map((d) => {
    const summary = draws.drawHeaderSummary(d.id);
    return {
      drawRequestId: d.id,
      projectId: d.projectId,
      projectName: projectById.get(d.projectId)?.name ?? d.projectId,
      drawNumber: d.drawNumber,
      status: d.status,
      requested: d.requestedAmount,
      supported: summary.supported,
      missingDocuments: summary.missingDocuments,
      ageDays: summary.ageDays,
      submittedAt: d.submittedAt ?? null,
      nextAction: drawNextAction(d.id),
    };
  });

  const open = rows.filter((r) => OPEN_STATUSES.includes(r.status));
  const byCode = (...codes: NextAction["code"][]) => open.filter((r) => codes.includes(r.nextAction.code));

  const readyForDecision = byCode("BEGIN_REVIEW", "CONTINUE_LINE_REVIEW", "LENDER_REVIEW_READY", "AWAITING_APPROVALS");
  const waitingOnContractor = byCode("UPLOAD_MISSING_DOCUMENTS", "AWAITING_REQUESTER", "REVISE_AND_RESUBMIT");
  const waitingOnInspection = byCode("INSPECTION_RESULT_REQUIRED");
  const complianceExceptions = byCode("RESOLVE_EXCEPTIONS");
  const aging = open.filter((r) => r.ageDays >= AGING_THRESHOLD_DAYS);
  const recentlyApproved = rows
    .filter((r) => ["APPROVED", "PARTIALLY_APPROVED", "RELEASED"].includes(r.status))
    .sort((a, b) => (a.submittedAt ?? "") < (b.submittedAt ?? "") ? 1 : -1)
    .slice(0, 6);

  // Median submission→decision time over draws that HAVE a decision —
  // a real measurement over recorded timestamps, or null when no draw
  // has completed the journey yet. Never estimated.
  const reviewDurations = allDraws
    .map((d) => {
      if (!d.submittedAt) return null;
      const decision = lenderDecisions.currentDecision(d.id);
      if (!decision?.decisionAt) return null;
      const days = (Date.parse(decision.decisionAt) - Date.parse(d.submittedAt)) / 86_400_000;
      return days >= 0 ? days : null;
    })
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const medianReviewDays =
    reviewDurations.length === 0
      ? null
      : Math.round(reviewDurations[Math.floor((reviewDurations.length - 1) / 2)] * 10) / 10;

  const unresolvedExceptions = projects
    .flatMap((p) => repo.listExceptionsForProject(p.id))
    .filter((x) => !["RESOLVED", "CLOSED", "WAIVED"].includes(x.status)).length;

  return {
    readyForDecision,
    waitingOnContractor,
    waitingOnInspection,
    complianceExceptions,
    aging,
    recentlyApproved,
    metrics: {
      activeProjects: projects.filter((p) => p.status === "ACTIVE").length,
      openDraws: open.length,
      totalRequestedOpen: open.reduce((s, r) => s + r.requested, 0),
      currentlyEligible: rows
        .filter((r) => ["APPROVED", "PARTIALLY_APPROVED"].includes(r.status))
        .reduce((s, r) => s + (allDraws.find((d) => d.id === r.drawRequestId)?.recommendedAmount ?? r.supported), 0),
      currentlyHeld: open.reduce((s, r) => s + Math.max(0, r.requested - r.supported), 0),
      medianReviewDays,
      missingDocumentCount: open.reduce((s, r) => s + r.missingDocuments, 0),
      unresolvedExceptions,
      approvalsAwaiting: rows.filter((r) => r.nextAction.code === "AWAITING_APPROVALS").length,
    },
    agingThresholdDays: AGING_THRESHOLD_DAYS,
    asOf: new Date().toISOString(),
  };
}

// ------------------------------------------------------------ pilot ROI

export interface DrawRoiMeasurement {
  drawRequestId: string;
  projectId: string;
  drawNumber: number;
  submittedAt: string | null;
  firstReviewAt: string | null;
  decisionAt: string | null;
  daysSubmissionToFirstReview: number | null;
  daysSubmissionToDecision: number | null;
  resubmissions: number;
  clarificationRequests: number;
  returnedCount: number;
  missingDocumentEvents: number;
  exceptionsRaised: number;
}

/**
 * Raw operational measurements for the pilot ROI case. These are the
 * numbers a lender needs to CALCULATE savings after the pilot — OBV
 * records the measurements and fabricates no dollar figures.
 */
export function pilotRoiMeasurements(user: User): { draws: DrawRoiMeasurement[]; asOf: string } {
  const projects = new Set(authz.accessibleProjectIds(user));
  const rows: DrawRoiMeasurement[] = [];
  for (const d of draws.listDrawsForUser(user)) {
    if (!projects.has(d.projectId)) continue;
    const events = repo.listDrawEvents(d.id);
    const firstSubmit = events.find((e) => e.type === "SUBMITTED");
    const firstReview = events.find((e) => ["LINE_REVIEWED", "DOCUMENT_REVIEWED", "CLARIFICATION_REQUESTED"].includes(e.type));
    const decision = lenderDecisions.currentDecision(d.id);
    const submittedAt = d.submittedAt ?? firstSubmit?.createdAt ?? null;
    const firstReviewAt = firstReview?.createdAt ?? null;
    const decisionAt = decision?.decisionAt ?? null;
    const between = (a: string | null, b: string | null) =>
      a && b && Date.parse(b) >= Date.parse(a)
        ? Math.round(((Date.parse(b) - Date.parse(a)) / 86_400_000) * 10) / 10
        : null;
    rows.push({
      drawRequestId: d.id,
      projectId: d.projectId,
      drawNumber: d.drawNumber,
      submittedAt,
      firstReviewAt,
      decisionAt,
      daysSubmissionToFirstReview: between(submittedAt, firstReviewAt),
      daysSubmissionToDecision: between(submittedAt, decisionAt),
      resubmissions: Math.max(0, events.filter((e) => e.type === "SUBMITTED").length - 1),
      clarificationRequests: events.filter((e) => e.type === "CLARIFICATION_REQUESTED").length,
      returnedCount: events.filter((e) => e.type === "RETURNED").length,
      missingDocumentEvents: events.filter((e) => e.type === "DOCUMENT_REVIEWED" && /reject/i.test(e.detail ?? "")).length,
      exceptionsRaised: repo
        .listExceptionsForProject(d.projectId)
        .filter((x) => (x as { drawRequestId?: string | null }).drawRequestId === d.id).length,
    });
  }
  return { draws: rows, asOf: new Date().toISOString() };
}
