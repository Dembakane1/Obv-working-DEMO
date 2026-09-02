/**
 * Portfolio DRAW CONTROL read model — the governed half of the Executive
 * Command Center.
 *
 * This module answers a construction lender's capital-control questions
 * over the whole accessible portfolio: how much is requested, how much of
 * it the governed record currently supports, which draws stand in which
 * readiness state, where the portfolio is getting stuck, and what needs
 * attention now.
 *
 * THREE RULES GOVERN EVERY FIGURE HERE.
 *
 * 1. It aggregates; it never reinterprets. Per-draw readiness, control
 *    domains, cross-cutting controls, support coverage and the primary
 *    blocker all come from the authoritative Draw Readiness Engine
 *    (`drawReadiness`, `controlDomains`, `crossCuttingControls`,
 *    `supportCoverage`, `formatSupportCoverage`) and the deterministic
 *    Next Action engine (`drawNextAction`). There is no second engine, no
 *    re-derivation, and no portfolio-level score of any kind.
 *
 * 2. It is read-only. Nothing here writes a row, records a transition,
 *    captures a snapshot, or evaluates an exception. Rendering the
 *    Executive Command Center must leave the database byte-identical.
 *
 * 3. Tenancy is inherited, never re-implemented. Every figure derives
 *    from a `PortfolioContext`, which is built from
 *    `authz.accessibleProjects(viewer)` BEFORE any row is grouped. A
 *    project outside the viewer's scope cannot reach an aggregate.
 */
import type { User } from "../../../shared/types";
import { PortfolioContext, buildPortfolioContext } from "./context";
import * as readiness from "../drawReadiness";
import * as lenderPilot from "../pilot/lenderPilot";
import * as draws from "../draws";
import * as prepo from "../../db/portfolioRepo";

// ----------------------------------------------------------- inclusion rule

/**
 * THE CAPITAL INCLUSION RULE.
 *
 * "Open draws" are the draws whose requested capital is still moving
 * through review — the exact set the lender pilot command centre has
 * always used (`lenderPilot.OPEN_STATUSES`), reused here rather than
 * redefined so the two surfaces can never disagree:
 *
 *   SUBMITTED · UNDER_REVIEW · CLARIFICATION_REQUIRED ·
 *   READY_FOR_GOVERNANCE · RETURNED
 *
 * DRAFT is excluded: an unsubmitted draft is not a request against the
 * lender. CANCELLED is excluded. A governance-RELEASED draw is excluded
 * ONLY once the lender has recorded their decision: formal governance
 * (the approval matrix, release eligibility on the virtual account) is
 * NOT the lender decision — the decision can only follow governance, so a
 * released draw still awaiting it is capital still under the lender's
 * control (`lenderPilot.isOpenForLenderControl`, the one shared predicate).
 * Every capital figure, the readiness distribution, domain pressure and
 * the attention queue all run over this one set, so the totals reconcile
 * with each other by construction.
 */
export const OPEN_DRAW_STATUSES: readonly string[] = lenderPilot.OPEN_STATUSES;
/** The open set: `OPEN_DRAW_STATUSES`, plus governance-released draws
 *  whose lender decision has not been recorded. */
export const isOpenDraw = lenderPilot.isOpenForLenderControl;

export const CAPITAL_INCLUSION_RULE =
  "Open draws only — submitted, under review, awaiting clarification, ready for governance, returned, or governance-released and awaiting the lender decision. " +
  "Drafts are not yet requests; draws with a recorded lender decision have left review.";

// ------------------------------------------------------------------- types

export interface PortfolioCapital {
  /** Sum of requestedAmount over the included draws. */
  requested: number;
  /**
   * Sum of the readiness engine's own supportableAmount over the SAME
   * draws. Supported dollars — never approved, authorized, payable or
   * funded, and never a measure of readiness.
   */
  supportable: number;
  /**
   * The REAL shortfall: the sum of the engine's own per-draw
   * `unsupportedAmount`, which is floored per draw.
   *
   * It is deliberately NOT `requested − supportable`. If one draw's lines
   * over-support its request (an inconsistency the engine already flags
   * with RECONCILIATION_FAILED), that overage would net against another
   * draw's genuine gap and the portfolio would report full support while a
   * draw is under-covered.
   */
  unsupported: number;
  /**
   * Dollars actually covered — `Σ min(requested, supportable)` per draw.
   * Equal to `requested − unsupported`, and the numerator of coverage, so
   * an over-supported draw can never mask another's shortfall.
   */
  covered: number;
  /** `Σ max(0, supportable − requested)`. Non-zero means at least one draw
   *  reports more support than it requested — an inconsistency, surfaced
   *  rather than netted away. */
  overSupported: number;
  /** covered / requested. Reaches 1 only when EVERY included draw is fully
   *  supported. Null when nothing is requested. */
  coverage: number | null;
  /** The shared non-overstating label — "100%" only for exact full
   *  support. Never re-implemented here. */
  coverageLabel: string | null;
}

/**
 * One readiness state's slice of the portfolio. The capital fields are the
 * SAME non-netted aggregate the portfolio headline uses — produced by
 * `aggregateCapital` over the bucket's member results, never by a second
 * arithmetic rule — so an over-supported member draw can never cancel
 * another member's genuine shortfall inside a bucket either.
 */
export interface ReadinessBucket extends PortfolioCapital {
  status: readiness.ReadinessStatus;
  drawCount: number;
  /** Share of EVALUATED open draws by COUNT — a share of this
   *  distribution, never a readiness percentage. Always rendered with its
   *  denominator named. */
  shareOfDrawsPct: number;
}

export interface DomainPressure {
  domain: readiness.ControlDomain;
  categories: readiness.ReadinessCategory[];
  /** Unique open draws whose worst state in this domain is HOLD. A draw
   *  blocked in two domains appears in both — that is the point of the
   *  module — so these NEVER sum to a unique blocked-draw count. */
  holdDraws: number;
  warningDraws: number;
  unknownDraws: number;
  passDraws: number;
  notApplicableDraws: number;
  /** Blocking-reason instances attributed to this domain's categories. */
  blockerInstances: number;
}

export interface CrossCuttingPressure {
  categories: readiness.ReadinessCategory[];
  /** Unique open draws carrying a cross-cutting governed blocker. */
  blockedDraws: number;
  unknownDraws: number;
  blockerInstances: number;
}

export interface AttentionItem {
  drawRequestId: string;
  drawNumber: number;
  projectId: string;
  projectName: string;
  status: readiness.ReadinessStatus;
  workflowStatus: string;
  requested: number;
  supportable: number;
  /** The engine's own ordered primary blocker; never re-chosen here. */
  reason: string;
  reasonCode: string | null;
  ageDays: number;
  nextAction: string;
  nextActionActor: string;
}

export interface AttentionGroup {
  key:
    | "INCOMPLETE"
    | "UNKNOWN_INFORMATION"
    | "GOVERNED_BLOCKERS"
    | "HIGH_EXCEPTIONS"
    | "INSPECTIONS_OUTSTANDING"
    | "DOCUMENT_GAPS"
    | "DISPUTE_LEGAL_HOLDS"
    | "AGING"
    | "READY_PENDING_DECISION";
  label: string;
  /** What the count counts — stated so no denominator is ambiguous. */
  unit: string;
  count: number;
  /** Severity for presentation only; never a governed state. */
  tone: "critical" | "blocked" | "attention" | "ready";
  items: AttentionItem[];
}

export interface PipelineBucket {
  key: string;
  label: string;
  drawCount: number;
  requested: number;
  shareOfDrawsPct: number;
}

export interface RegisterRow {
  projectId: string;
  projectName: string;
  drawRequestId: string;
  drawNumber: number;
  requested: number;
  supportable: number;
  status: readiness.ReadinessStatus;
  primaryBlocker: string | null;
  primaryBlockerCategory: string | null;
  openExceptions: number;
  ageDays: number;
  nextAction: string;
  jurisdiction: string | null;
}

export interface ControlChange {
  drawRequestId: string;
  drawNumber: number;
  projectId: string;
  projectName: string;
  /** What kind of governed record changed. A LENDER_DECISION entry comes
   *  from the lender-decision register itself — never inferred from
   *  governance/approval events, which are a different governed concept. */
  kind: "READINESS_TRANSITION" | "GOVERNED_EVENT" | "LENDER_DECISION";
  /** For a readiness transition: the status recorded AT THAT TIME. */
  from: string | null;
  to: string;
  label: string;
  at: string;
  actorUserId: string | null;
}

export interface ProceededByException {
  drawRequestId: string;
  drawNumber: number;
  projectId: string;
  projectName: string;
  decision: string;
  decisionId: string;
  /** Readiness AT DECISION TIME, from the immutable snapshot. */
  statusAtDecision: string;
  overriddenBlockerCount: number;
  actorUserId: string;
  decidedAt: string | null;
  justification: string | null;
}

export interface SourceFreshness {
  projectId: string;
  projectName: string;
  /** Most recent recorded official-source lookup, or null when none has
   *  ever been recorded. Never inferred. */
  lastVerifiedAt: string | null;
  /** The recorded result status of that lookup — an unreviewed candidate
   *  is never presented as verified. */
  lastResultStatus: string | null;
  /** The re-review date the record itself carries. OBV invents no
   *  staleness threshold: when this is null there is simply no recorded
   *  due date and no staleness claim is made. */
  nextReviewDate: string | null;
  /** True only when a recorded nextReviewDate has passed. Advisory. */
  reviewOverdue: boolean;
}

export interface TurnaroundMetrics {
  /** Median submitted → decision, over draws that actually reached a
   *  decision. Null when no draw has, and never estimated. */
  medianSubmissionToDecisionDays: number | null;
  /** How many recorded journeys the median rests on. */
  sampleSize: number;
  agingThresholdDays: number;
  /** Aging count over EVALUATED open draws — age needs the same per-draw
   *  read as readiness, so an unevaluated draw is not in this figure and
   *  the view marks the subset whenever one exists. */
  agingDrawCount: number;
}

export interface PortfolioControl {
  generatedAt: string;
  scope: {
    projectCount: number;
    activeProjectCount: number;
    /** The REAL accessible open-draw count — resolved from the governed
     *  draw records BEFORE readiness evaluation, so a draw whose
     *  evaluation fails can never vanish from the console's scope. */
    openDrawCount: number;
    /** How many of those draws have a readiness result. Readiness-derived
     *  figures cover exactly this subset; when it is smaller than
     *  openDrawCount the presentation fails closed. */
    evaluatedOpenDrawCount: number;
    inclusionRule: string;
    includedStatuses: readonly string[];
  };
  /**
   * Σ requestedAmount over the FULL open set, taken directly from the
   * governed draw records. Needs no readiness evaluation, so it stays a
   * complete portfolio fact even when some draws could not be evaluated.
   */
  openRequested: number;
  /** Σ requestedAmount over the unevaluated draws — the capital the
   *  readiness-derived figures below do NOT cover. */
  unevaluatedRequested: number;
  /** Readiness-derived capital over the EVALUATED draws. When
   *  evaluatedOpenDrawCount < openDrawCount this is a partial view and the
   *  page must not present it as a complete portfolio total. */
  capital: PortfolioCapital;
  readinessDistribution: ReadinessBucket[];
  domains: DomainPressure[];
  crossCutting: CrossCuttingPressure;
  attention: AttentionGroup[];
  pipeline: PipelineBucket[];
  register: RegisterRow[];
  recentChanges: ControlChange[];
  proceededByException: ProceededByException[];
  freshness: SourceFreshness[];
  turnaround: TurnaroundMetrics;
  /**
   * Open draws whose readiness could not be evaluated at all — an
   * operational EVALUATION UNAVAILABLE condition, NOT a readiness state
   * and NOT the same thing as INCOMPLETE (which is a valid governed result
   * saying required information is missing). Each entry keeps the draw
   * visible with its raw governed facts and a failure-safe reason.
   */
  unevaluated: Array<{
    drawRequestId: string;
    drawNumber: number;
    projectId: string;
    projectName: string;
    requested: number;
    reason: string;
  }>;
}

// --------------------------------------------------------------- internals

const READINESS_ORDER: readiness.ReadinessStatus[] = [
  "READY",
  "HOLD",
  "EXCEPTION_REVIEW",
  "INCOMPLETE",
];

/** Workflow buckets for the operational pipeline. These describe recorded
 *  WORKFLOW state, not readiness, and are derived from the existing
 *  deterministic Next Action codes — no new workflow engine. */
const PIPELINE_BUCKETS: Array<{ key: string; label: string; codes: string[] }> = [
  { key: "READY_FOR_LENDER_REVIEW", label: "Awaiting lender review / decision", codes: ["LENDER_REVIEW_READY", "BEGIN_REVIEW", "LENDER_DECISION_REQUIRED"] },
  {
    key: "WAITING_ON_CONTRACTOR",
    label: "Waiting on contractor / documents",
    codes: ["UPLOAD_MISSING_DOCUMENTS", "AWAITING_REQUESTER", "REVISE_AND_RESUBMIT", "COMPLETE_DRAFT"],
  },
  { key: "WAITING_ON_INSPECTION", label: "Waiting on inspection", codes: ["INSPECTION_RESULT_REQUIRED"] },
  { key: "IN_LINE_REVIEW", label: "In line review", codes: ["CONTINUE_LINE_REVIEW"] },
  { key: "EXCEPTION_REVIEW", label: "Exception review", codes: ["RESOLVE_EXCEPTIONS"] },
  { key: "AWAITING_APPROVALS", label: "Awaiting formal approvals", codes: ["AWAITING_APPROVALS"] },
  {
    key: "DECISION_RECORDED",
    label: "Decision recorded",
    codes: ["RESOLVE_DECISION_CONDITIONS", "RELEASE_TRANSITION_PENDING", "NO_ACTION_REQUIRED"],
  },
];

/** Governed event types worth an executive's attention, with the words a
 *  lender uses. Anything not listed is operational noise and stays out.
 *
 *  GOVERNANCE_DECISION is FORMAL GOVERNANCE / approval-matrix activity
 *  (an approval-role decision, a governance rejection, completion of the
 *  required approvals) — it is NOT the lender's business decision, which
 *  is a separate governed record owned by lenderDecisions and recorded
 *  AFTER formal governance. History entries for real lender decisions are
 *  read from the lender-decision register itself, never inferred from
 *  governance events. */
const NOTABLE_EVENTS: Record<string, string> = {
  GOVERNANCE_DECISION: "Formal governance decision recorded",
  SENT_TO_GOVERNANCE: "Sent to governance",
  RETURNED: "Draw returned to requester",
  RELEASE_TRANSITION: "Release transition recorded",
  DOCUMENT_RECORDED: "Draw document checklist activity",
  RECOMMENDATION_FINALIZED: "Recommendation finalized",
};

const OPEN_EXCEPTION_STATUSES = (status: string): boolean =>
  !["RESOLVED", "CLOSED", "WAIVED"].includes(status);

interface EvaluatedDraw {
  row: prepo.DrawRow;
  projectName: string;
  result: readiness.DrawReadinessResult;
  domains: readiness.ControlDomainView[];
  crossCutting: readiness.CrossCuttingView;
  summary: draws.DrawHeaderSummary;
  nextAction: lenderPilot.NextAction;
}

/**
 * TEST SEAM — failure injection only. OBV_TEST_FAIL_READINESS names draw
 * ids whose readiness evaluation is treated as unavailable, so the
 * fail-closed presentation is exercisable end to end without corrupting
 * any record. The seam can only force the error path — it can never
 * fabricate a readiness result — so even a stray value in a real
 * deployment makes the console MORE conservative, never healthier.
 */
function readinessFailureSeam(): Set<string> {
  return new Set(
    (process.env.OBV_TEST_FAIL_READINESS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

/** One line, no stack, bounded — suitable for an authorized operator. */
function failureSafeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const firstLine = String(message).split("\n")[0].trim();
  return firstLine.length > 0 ? firstLine.slice(0, 200) : "Readiness could not be evaluated";
}

function evaluateOpenDraws(ctx: PortfolioContext): {
  /** The FULL accessible open set, resolved from governed draw records
   *  before any readiness evaluation — the authoritative denominator. */
  open: Array<{ row: prepo.DrawRow; projectName: string }>;
  evaluated: EvaluatedDraw[];
  unevaluated: PortfolioControl["unevaluated"];
} {
  const open: Array<{ row: prepo.DrawRow; projectName: string }> = [];
  for (const project of ctx.projects) {
    for (const row of ctx.drawsByProject().get(project.id) ?? []) {
      if (isOpenDraw({ id: row.id, status: row.status })) open.push({ row, projectName: project.name });
    }
  }

  const forcedFailures = readinessFailureSeam();
  const evaluated: EvaluatedDraw[] = [];
  const unevaluated: PortfolioControl["unevaluated"] = [];
  for (const { row, projectName } of open) {
    try {
      if (forcedFailures.has(row.id)) {
        throw new Error("Readiness evaluation unavailable (injected by the test seam)");
      }
      const result = readiness.drawReadiness(row.id);
      // drawHeaderSummary is computed ONCE and handed to drawNextAction,
      // which would otherwise recompute the same summary internally.
      const summary = draws.drawHeaderSummary(row.id);
      evaluated.push({
        row,
        projectName,
        result,
        domains: readiness.controlDomains(result),
        crossCutting: readiness.crossCuttingControls(result),
        summary,
        nextAction: lenderPilot.drawNextAction(row.id, summary),
      });
    } catch (error) {
      // The draw does NOT disappear: it keeps its raw governed facts and
      // is surfaced as an EVALUATION UNAVAILABLE condition. It is never
      // relabelled INCOMPLETE — that is a valid readiness result, and this
      // is the absence of one.
      unevaluated.push({
        drawRequestId: row.id,
        drawNumber: row.drawNumber,
        projectId: row.projectId,
        projectName,
        requested: row.requestedAmount,
        reason: failureSafeReason(error),
      });
    }
  }
  return { open, evaluated, unevaluated };
}

/**
 * The immutable decision-time readiness snapshot for ONE lender decision,
 * read from the portfolio context's already-loaded draw events.
 *
 * Semantically identical to `readiness.decisionReadinessSnapshot` — the
 * same READINESS_SNAPSHOT event, matched by decision id, latest wins — but
 * without a per-draw query. History only: nothing here is recomputed.
 */
function snapshotForDecision(
  ctx: PortfolioContext,
  drawRequestId: string,
  decisionId: string
): { statusAtDecision: string; overriddenBlockers: string[] } | null {
  const events = (ctx.eventsByDraw().get(drawRequestId) ?? []).filter(
    (e) => e.type === "READINESS_SNAPSHOT"
  );
  let match: { statusAtDecision: string; overriddenBlockers: string[] } | null = null;
  for (const event of events) {
    let detail: Record<string, unknown>;
    try {
      detail = JSON.parse(event.detail) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (detail.decisionId !== decisionId) continue;
    const overridden = Array.isArray(detail.overriddenBlockers) ? detail.overriddenBlockers : [];
    // Events arrive oldest first, so a later match supersedes an earlier one.
    match = {
      statusAtDecision: typeof detail.status === "string" ? detail.status : "UNKNOWN",
      overriddenBlockers: overridden.map((c) => String(c)),
    };
  }
  return match;
}

/**
 * Portfolio capital from a set of per-draw readiness results.
 *
 * Shortfalls and overages are summed SEPARATELY and never netted: if one
 * draw's lines record more support than that draw requested — an
 * inconsistency the engine itself flags — that overage must not cancel a
 * different draw's genuine gap, or the portfolio would report full
 * coverage while a draw is under-covered.
 *
 * Exported pure so the rule is testable against cases the seeded portfolio
 * cannot currently produce.
 */
export function aggregateCapital(
  results: Array<Pick<readiness.DrawReadinessResult, "requestedAmount" | "supportableAmount" | "unsupportedAmount">>
): PortfolioCapital {
  const requested = results.reduce((sum, r) => sum + r.requestedAmount, 0);
  const supportable = results.reduce((sum, r) => sum + r.supportableAmount, 0);
  // The engine already floors each draw's shortfall.
  const unsupported = results.reduce((sum, r) => sum + r.unsupportedAmount, 0);
  const overSupported = results.reduce(
    (sum, r) => sum + Math.max(0, r.supportableAmount - r.requestedAmount),
    0
  );
  const covered = requested - unsupported;
  const coverage = requested > 0 ? covered / requested : null;
  return {
    requested,
    supportable,
    unsupported,
    covered,
    overSupported,
    coverage,
    coverageLabel: readiness.formatSupportCoverage(coverage),
  };
}

function share(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

// ------------------------------------------------------------------ engine

export function portfolioControl(ctx: PortfolioContext): PortfolioControl {
  const { open, evaluated, unevaluated } = evaluateOpenDraws(ctx);
  // The console's scope is the REAL open set; readiness-derived figures
  // cover the evaluated subset and the presentation fails closed when the
  // two differ. Shares are of evaluated draws — the only set a readiness
  // distribution can honestly describe.
  const evaluatedCount = evaluated.length;
  const openRequested = open.reduce((sum, d) => sum + d.row.requestedAmount, 0);
  const unevaluatedRequested = unevaluated.reduce((sum, u) => sum + u.requested, 0);

  // ---------------------------------------------------------- capital
  const capital = aggregateCapital(evaluated.map((d) => d.result));

  // ------------------------------------------- readiness distribution
  //
  // Each bucket's capital comes from the SAME aggregation rule as the
  // portfolio headline — per-draw shortfalls, never a netted difference —
  // so a bucket can never report "fully supported" while a member draw is
  // under-covered just because another member records an overage.
  const readinessDistribution: ReadinessBucket[] = READINESS_ORDER.map((status) => {
    const members = evaluated.filter((d) => d.result.status === status);
    return {
      status,
      drawCount: members.length,
      ...aggregateCapital(members.map((d) => d.result)),
      shareOfDrawsPct: share(members.length, evaluatedCount),
    };
  });

  // ------------------------------------------------- domain pressure
  //
  // Counts are per DRAW for state (a draw is counted once per domain, by
  // its worst state in that domain) and per INSTANCE for blockers. The
  // same draw legitimately appears under several domains; unique blocked
  // draws come from the readiness distribution, never from summing these.
  const domains: DomainPressure[] = (
    Object.keys(readiness.CONTROL_DOMAIN_CATEGORIES) as readiness.ControlDomain[]
  ).map((domain) => {
    const views = evaluated.map((d) => d.domains.find((v) => v.domain === domain));
    const count = (state: readiness.CategoryState): number =>
      views.filter((v) => v && v.state === state).length;
    return {
      domain,
      categories: readiness.CONTROL_DOMAIN_CATEGORIES[domain],
      holdDraws: count("HOLD"),
      warningDraws: count("WARNING"),
      unknownDraws: count("UNKNOWN"),
      passDraws: count("PASS"),
      notApplicableDraws: count("NOT_APPLICABLE"),
      blockerInstances: views.reduce((sum, v) => sum + (v ? v.blockerCount : 0), 0),
    };
  });

  const crossCutting: CrossCuttingPressure = {
    categories: readiness.CROSS_CUTTING_CATEGORIES,
    blockedDraws: evaluated.filter((d) => d.crossCutting.blockerCount > 0).length,
    unknownDraws: evaluated.filter((d) => d.crossCutting.hasUnknown).length,
    blockerInstances: evaluated.reduce((sum, d) => sum + d.crossCutting.blockerCount, 0),
  };

  // ------------------------------------------------------- attention
  const item = (d: EvaluatedDraw): AttentionItem => ({
    drawRequestId: d.row.id,
    drawNumber: d.row.drawNumber,
    projectId: d.row.projectId,
    projectName: d.projectName,
    status: d.result.status,
    workflowStatus: d.row.status,
    requested: d.result.requestedAmount,
    supportable: d.result.supportableAmount,
    reason: d.result.primaryBlocker?.message ?? d.nextAction.label,
    reasonCode: d.result.primaryBlocker?.code ?? null,
    ageDays: d.summary.ageDays,
    nextAction: d.nextAction.label,
    nextActionActor: d.nextAction.actor,
  });

  const openExceptionsFor = (projectId: string, drawRequestId: string): prepo.ExceptionRow[] =>
    (ctx.exceptionsByProject().get(projectId) ?? []).filter(
      (x) => OPEN_EXCEPTION_STATUSES(x.status) && x.drawRequestId === drawRequestId
    );

  const incomplete = evaluated.filter((d) => d.result.status === "INCOMPLETE");
  const blocked = evaluated.filter((d) => d.result.blockingReasons.length > 0);
  // Missing INFORMATION, wherever it appears. A draw can be HOLD on a
  // substantive blocker AND still carry an unknown — which is worse than a
  // plain HOLD, because the lender does not yet know what requirement
  // applies. Classified by the engine's own predicate, never re-derived.
  const unknownInfo = evaluated.filter(
    (d) =>
      d.result.status !== "INCOMPLETE" &&
      d.result.blockingReasons.some((b) => readiness.isUnknownInformation(b.code))
  );
  const highExceptionDraws = evaluated.filter((d) =>
    openExceptionsFor(d.row.projectId, d.row.id).some((x) => ["HIGH", "CRITICAL"].includes(x.severity))
  );
  const inspectionDraws = evaluated.filter((d) =>
    d.result.blockingReasons.some(
      (b) => b.category === "GOVERNMENT_INSPECTION" || b.category === "DRAW_INSPECTION"
    )
  );
  const documentDraws = evaluated.filter((d) =>
    d.result.blockingReasons.some((b) => b.category === "DOCUMENT" || b.category === "LIEN")
  );
  // Disputes and legal holds come from the DISPUTES REGISTER, not from a
  // readiness category. The PROJECT_CONTROL category is cross-cutting and
  // also carries reviewer-progress states such as LINE_REVIEW_INCOMPLETE;
  // counting it as "dispute / legal hold" would report ordinary unfinished
  // line review as a legal event.
  const disputeDraws = evaluated.filter((d) =>
    (ctx.disputesByProject().get(d.row.projectId) ?? []).some(
      (x) =>
        x.drawRequestId === d.row.id &&
        x.resolvedAt === null &&
        x.closedAt === null
    )
  );
  const legalHoldDraws = evaluated.filter((d) =>
    (ctx.disputesByProject().get(d.row.projectId) ?? []).some(
      (x) =>
        x.drawRequestId === d.row.id &&
        x.legalHold &&
        x.resolvedAt === null &&
        x.closedAt === null
    )
  );
  const aging = evaluated.filter((d) => d.summary.ageDays >= lenderPilot.AGING_THRESHOLD_DAYS);
  const readyPending = evaluated.filter((d) => d.result.status === "READY");

  /**
   * ATTENTION ORDERING — deterministic and explainable, and deliberately
   * NOT a score. Missing governed information first (OBV cannot even
   * reach a conclusion), then substantive blockers, then formal
   * escalations, then time pressure, then work that is merely waiting on
   * a human decision. Advisory analytics never enter this queue.
   */
  const attention: AttentionGroup[] = [
    {
      key: "INCOMPLETE",
      label: "Incomplete — governed information missing",
      unit: "draws",
      count: incomplete.length,
      tone: "critical",
      items: incomplete.map(item),
    },
    {
      key: "UNKNOWN_INFORMATION",
      label: "Unknown information on a blocked draw",
      unit: "draws",
      count: unknownInfo.length,
      tone: "critical",
      items: unknownInfo.map(item),
    },
    {
      key: "GOVERNED_BLOCKERS",
      label: "Governed blockers",
      unit: "blocker instances across draws",
      count: blocked.reduce((sum, d) => sum + d.result.blockingReasons.length, 0),
      tone: "blocked",
      items: blocked.map(item),
    },
    {
      key: "HIGH_EXCEPTIONS",
      label: "High / critical exceptions",
      unit: "draws",
      count: highExceptionDraws.length,
      tone: "blocked",
      items: highExceptionDraws.map(item),
    },
    {
      key: "INSPECTIONS_OUTSTANDING",
      // Deliberately not "required inspections outstanding": one of these
      // blockers means the inspection SURFACE itself is unknown, which is
      // not the same claim as an inspection being known to be required.
      label: "Inspection controls outstanding",
      unit: "draws blocked by an inspection requirement or an unknown inspection surface",
      count: inspectionDraws.length,
      tone: "attention",
      items: inspectionDraws.map(item),
    },
    {
      key: "DOCUMENT_GAPS",
      label: "Document gaps",
      unit: "draws",
      count: documentDraws.length,
      tone: "attention",
      items: documentDraws.map(item),
    },
    {
      key: "DISPUTE_LEGAL_HOLDS",
      label: "Dispute / legal holds",
      unit: `open draws carrying an open dispute${legalHoldDraws.length > 0 ? ` · ${legalHoldDraws.length} of them under legal hold` : ""}`,
      count: disputeDraws.length,
      tone: "blocked",
      items: disputeDraws.map(item),
    },
    {
      key: "AGING",
      label: `Draws aging beyond ${lenderPilot.AGING_THRESHOLD_DAYS} days`,
      unit: "draws",
      count: aging.length,
      tone: "attention",
      items: aging.map(item),
    },
    {
      key: "READY_PENDING_DECISION",
      label: "Ready — lender decision pending",
      unit: "draws",
      count: readyPending.length,
      tone: "ready",
      items: readyPending.map(item),
    },
  ];

  // -------------------------------------------------------- pipeline
  const pipeline: PipelineBucket[] = PIPELINE_BUCKETS.map((bucket) => {
    const members = evaluated.filter((d) => bucket.codes.includes(d.nextAction.code));
    return {
      key: bucket.key,
      label: bucket.label,
      drawCount: members.length,
      requested: members.reduce((s, d) => s + d.result.requestedAmount, 0),
      shareOfDrawsPct: share(members.length, evaluatedCount),
    };
  }).filter((b) => b.drawCount > 0);

  // -------------------------------------------------------- register
  const statusRank = (status: readiness.ReadinessStatus): number => {
    if (status === "INCOMPLETE") return 0;
    if (status === "HOLD") return 1;
    if (status === "EXCEPTION_REVIEW") return 2;
    return 3;
  };
  const register: RegisterRow[] = evaluated
    .map((d) => ({
      projectId: d.row.projectId,
      projectName: d.projectName,
      drawRequestId: d.row.id,
      drawNumber: d.row.drawNumber,
      requested: d.result.requestedAmount,
      supportable: d.result.supportableAmount,
      status: d.result.status,
      primaryBlocker: d.result.primaryBlocker?.message ?? null,
      primaryBlockerCategory: d.result.primaryBlocker?.category ?? null,
      openExceptions: openExceptionsFor(d.row.projectId, d.row.id).length,
      ageDays: d.summary.ageDays,
      nextAction: d.nextAction.label,
      jurisdiction: ctx.jurisdictionByProject().get(d.row.projectId)?.jurisdictionName ?? null,
    }))
    .sort(
      (a, b) =>
        statusRank(a.status) - statusRank(b.status) ||
        b.ageDays - a.ageDays ||
        b.requested - a.requested
    );

  // ------------------------------------------------- recent changes
  //
  // HISTORY IS READ FROM HISTORY. A readiness transition event carries
  // the status it moved FROM and TO at the moment it was recorded; today's
  // live blockers are never consulted to describe a past change, and the
  // transition record carries no reason text, so none is invented.
  const drawMeta = new Map(
    evaluated.map((d) => [d.row.id, { number: d.row.drawNumber, projectId: d.row.projectId, projectName: d.projectName }])
  );
  for (const project of ctx.projects) {
    for (const row of ctx.drawsByProject().get(project.id) ?? []) {
      if (!drawMeta.has(row.id)) {
        drawMeta.set(row.id, { number: row.drawNumber, projectId: row.projectId, projectName: project.name });
      }
    }
  }
  const changes: ControlChange[] = [];
  for (const [drawRequestId, events] of ctx.eventsByDraw()) {
    const meta = drawMeta.get(drawRequestId);
    if (!meta) continue;
    for (const event of events) {
      if (event.type === "READINESS_TRANSITION") {
        let from: string | null = null;
        let to = "";
        try {
          const detail = JSON.parse(event.detail) as { status?: string; from?: string | null };
          to = typeof detail.status === "string" ? detail.status : "";
          from = typeof detail.from === "string" ? detail.from : null;
        } catch {
          continue;
        }
        if (!to) continue;
        changes.push({
          drawRequestId,
          drawNumber: meta.number,
          projectId: meta.projectId,
          projectName: meta.projectName,
          kind: "READINESS_TRANSITION",
          from,
          to,
          label: from ? `${from} → ${to}` : `Readiness ${to}`,
          at: event.createdAt,
          actorUserId: event.actorUserId,
        });
      } else if (NOTABLE_EVENTS[event.type]) {
        changes.push({
          drawRequestId,
          drawNumber: meta.number,
          projectId: meta.projectId,
          projectName: meta.projectName,
          kind: "GOVERNED_EVENT",
          from: null,
          to: event.type,
          label: NOTABLE_EVENTS[event.type],
          at: event.createdAt,
          actorUserId: event.actorUserId,
        });
      }
    }
  }
  // The REAL lender business decisions, from the lender-decision register
  // itself — recorded AFTER formal governance and never inferred from
  // GOVERNANCE_DECISION events, which are approval-matrix activity.
  // History includes superseded decisions: a superseded decision remains a
  // historical fact at its own recorded timestamp, while every
  // standing-decision surface keeps reading the non-superseded rows.
  for (const [drawRequestId, decisionHistory] of ctx.decisionHistoryByDraw()) {
    const meta = drawMeta.get(drawRequestId);
    if (!meta) continue;
    for (const decision of decisionHistory) {
      // A PENDING placeholder has no decisionAt — nothing was decided yet.
      if (!decision.decisionAt) continue;
      changes.push({
        drawRequestId,
        drawNumber: meta.number,
        projectId: meta.projectId,
        projectName: meta.projectName,
        kind: "LENDER_DECISION",
        from: null,
        to: decision.decision,
        label: `Lender decision recorded — ${decision.decision.replace(/_/g, " ")}`,
        at: decision.decisionAt,
        actorUserId: decision.reviewerUserId,
      });
    }
  }

  // Strictly newest first; within the same instant, readiness transitions
  // lead, then the lender decision, then generic governed events — a total
  // order, so the comparator is consistent for every pair of the three
  // kinds and same-instant ordering is deterministic.
  const KIND_RANK: Record<ControlChange["kind"], number> = {
    READINESS_TRANSITION: 0,
    LENDER_DECISION: 1,
    GOVERNED_EVENT: 2,
  };
  const recentChanges = changes
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : KIND_RANK[a.kind] - KIND_RANK[b.kind]))
    .slice(0, 12);

  // --------------------------------------------- proceeded by exception
  //
  // Reconstructed from NOTHING. Each entry is the immutable
  // READINESS_SNAPSHOT persisted with that specific lender decision.
  const proceededByException: ProceededByException[] = [];
  for (const project of ctx.projects) {
    for (const row of ctx.drawsByProject().get(project.id) ?? []) {
      // The context's decision rows are already the non-superseded ones —
      // the standing decision, exactly what lenderDecisions.currentDecision
      // resolves to.
      const decisions = ctx.decisionsByDraw().get(row.id) ?? [];
      const current = decisions[decisions.length - 1];
      if (!current) continue;
      // The decision-time snapshot is already in memory: draw events are
      // loaded once for the whole portfolio. Going through
      // decisionReadinessSnapshot here would issue one listDrawEvents query
      // per decided draw.
      const snapshot = snapshotForDecision(ctx, row.id, current.id);
      if (!snapshot || snapshot.overriddenBlockers.length === 0) continue;
      proceededByException.push({
        drawRequestId: row.id,
        drawNumber: row.drawNumber,
        projectId: row.projectId,
        projectName: project.name,
        decision: current.decision,
        decisionId: current.id,
        statusAtDecision: snapshot.statusAtDecision,
        overriddenBlockerCount: snapshot.overriddenBlockers.length,
        actorUserId: current.reviewerUserId,
        decidedAt: current.decisionAt,
        justification: current.exceptionsAccepted ?? current.decisionReason,
      });
    }
  }
  proceededByException.sort((a, b) => ((a.decidedAt ?? "") < (b.decidedAt ?? "") ? 1 : -1));

  // ------------------------------------------------------- freshness
  //
  // Timestamps come from source_verifications rows. OBV defines no
  // staleness threshold of its own: "review overdue" exists only when the
  // record itself carries a next_review_date that has passed.
  const today = new Date().toISOString().slice(0, 10);
  const freshness: SourceFreshness[] = ctx.projects.map((project) => {
    const rows = [...(ctx.sourceVerificationsByProject().get(project.id) ?? [])].sort((a, b) =>
      a.lookupAt < b.lookupAt ? -1 : 1
    );
    const latest = rows[rows.length - 1] ?? null;
    // The review date must belong to the SAME lookup whose status and
    // timestamp are shown beside it — taking the max across all of a
    // project's verifications would attribute an older record's due date
    // to the latest one.
    const due = latest?.nextReviewDate ?? null;
    return {
      projectId: project.id,
      projectName: project.name,
      lastVerifiedAt: latest ? latest.lookupAt : null,
      lastResultStatus: latest ? latest.resultStatus : null,
      nextReviewDate: due,
      reviewOverdue: due !== null && due < today,
    };
  });

  // ------------------------------------------------------ turnaround
  //
  // Real recorded journeys only: submitted → decision, never estimated,
  // and null with the sample size shown when nothing has completed.
  const durations: number[] = [];
  for (const project of ctx.projects) {
    for (const row of ctx.drawsByProject().get(project.id) ?? []) {
      if (!row.submittedAt) continue;
      const decisions = ctx.decisionsByDraw().get(row.id) ?? [];
      const current = decisions[decisions.length - 1];
      if (!current?.decisionAt) continue;
      const days = (Date.parse(current.decisionAt) - Date.parse(row.submittedAt)) / 86_400_000;
      if (Number.isFinite(days) && days >= 0) durations.push(days);
    }
  }
  durations.sort((a, b) => a - b);
  const turnaround: TurnaroundMetrics = {
    // The lender pilot's own median helper — one definition, so the two
    // surfaces cannot report different turnarounds for the same records.
    medianSubmissionToDecisionDays: lenderPilot.median(durations),
    sampleSize: durations.length,
    agingThresholdDays: lenderPilot.AGING_THRESHOLD_DAYS,
    agingDrawCount: aging.length,
  };

  return {
    generatedAt: ctx.generatedAt,
    scope: {
      projectCount: ctx.projects.length,
      activeProjectCount: ctx.projects.filter((p) => p.status === "ACTIVE").length,
      openDrawCount: open.length,
      evaluatedOpenDrawCount: evaluatedCount,
      inclusionRule: CAPITAL_INCLUSION_RULE,
      includedStatuses: OPEN_DRAW_STATUSES,
    },
    openRequested,
    unevaluatedRequested,
    capital,
    readinessDistribution,
    domains,
    crossCutting,
    attention,
    pipeline,
    register,
    recentChanges,
    proceededByException,
    freshness,
    turnaround,
    unevaluated,
  };
}

/** Facade entry point — builds the tenancy-scoped context, then aggregates. */
export function control(user: User): PortfolioControl {
  return portfolioControl(buildPortfolioContext(user));
}
