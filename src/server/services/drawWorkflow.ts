/**
 * Derived draw workflow stage.
 *
 * The stage is COMPUTED from authoritative records on every read — there
 * is no second mutable stage column that could contradict the sources.
 * draw_stage_events is an append-only OBSERVATION log written only by
 * mutating actions; GET requests never write.
 *
 * EXACT PRECEDENCE (top wins; each stage is grounded in the record it
 * names):
 *   1. DRAW_CLOSED                — draw CANCELLED, or a non-reversed
 *                                   external funding record CLOSED
 *   2. FUNDS_DISBURSED            — a NON-REVERSED DISBURSED funding
 *                                   record exists (a reversed or failed
 *                                   record NEVER presents as an
 *                                   uncomplicated disbursement; it falls
 *                                   through to the decision layer with the
 *                                   deterministic reversal/failure
 *                                   exception active)
 *   3. FUNDS_SCHEDULED            — an active SCHEDULED/PROCESSING record
 *   4. LIEN_RELEASE_COMPLETED     — favorable current decision + waivers
 *                                   exist + none outstanding
 *   5. LIEN_RELEASE_REQUESTED     — favorable current decision + a waiver
 *                                   REQUESTED/RECEIVED/UNDER_REVIEW
 *   6. REJECTED / REDUCED / CONDITIONALLY_APPROVED / APPROVED
 *                                 — the current (non-superseded) lender
 *                                   decision record
 *   7. LENDER_REVIEW_IN_PROGRESS  — formal governance finished (draw
 *                                   APPROVED/PARTIALLY_APPROVED/RELEASED)
 *                                   with no lender decision yet, or a
 *                                   READY_FOR_GOVERNANCE approval with ≥1
 *                                   recorded role decision
 *   8. ELIGIBLE_FOR_LENDER_REVIEW — READY_FOR_GOVERNANCE with no approval
 *                                   records yet (never automatic approval)
 *   9. CORRECTIONS_REQUESTED      — draw RETURNED, or the latest
 *                                   independent inspection is
 *                                   CORRECTION_REQUIRED/REINSPECTION_REQUIRED
 *  10. MISSING_INFORMATION_REQUESTED — draw CLARIFICATION_REQUIRED
 *  11. INSPECTION_REQUESTED       — latest independent inspection
 *                                   REQUESTED/SCHEDULING/ACCESS_FAILED
 *  12. INSPECTION_SCHEDULED       — latest independent inspection SCHEDULED
 *  13. PHYSICAL_INSPECTION_COMPLETED — latest independent inspection
 *                                   COMPLETED, REPORT_PENDING,
 *                                   REPORT_RECEIVED or UNDER_OBV_REVIEW
 *  14. EXCEPTIONS_IDENTIFIED      — open draw-linked exceptions
 *  15-17. The UNDER_REVIEW pipeline is SEQUENTIAL-CUMULATIVE: documents →
 *      government inspections → evidence. The derived stage is the
 *      furthest COMPLETED step, and each step also requires every earlier
 *      step, so a vacuously-true later check can never mask an unfinished
 *      earlier one:
 *      15. EVIDENCE_REVIEW_COMPLETED  — steps 17+16 hold AND every draw
 *                                   line has ≥1 RELEVANT VERIFIED link
 *                                   (line-scoped, or draw-level evidence
 *                                   belonging to the line's mapped
 *                                   milestone) and every relevant link
 *                                   has a final verdict; a draw-level
 *                                   link never blanket-covers all lines,
 *                                   unrelated-milestone evidence never
 *                                   covers a line, NEEDS_REVIEW and
 *                                   REJECTED block, and nothing is
 *                                   inferred from an independent
 *                                   inspection report
 *      16. GOVERNMENT_INSPECTION_CHECKED — step 17 holds AND every draw
 *                                   line MAPS TO A MILESTONE (an
 *                                   unmapped line is incomplete data and
 *                                   blocks — never filtered into a
 *                                   vacuous pass) AND every mapped
 *                                   milestone clears the FULL
 *                                   completion-gate inspection surface
 *                                   (inspectionSurfaceClean): no
 *                                   inspection, reinspection, permit or
 *                                   code-basis condition is outstanding,
 *                                   an UNDETERMINED requirement never
 *                                   behaves as NOT_REQUIRED, and a
 *                                   RELEASED milestone keeps its
 *                                   inspection truth; NEVER inferred from
 *                                   draw-line review alone
 *      17. FINANCIAL_DOCUMENTS_REVIEWED — the required document checklist
 *                                   is complete AND every received
 *                                   document has a recorded review outcome
 *  18. INITIAL_COMPLETENESS_REVIEW — draw UNDER_REVIEW before the above
 *  19. DRAW_REQUEST_SUBMITTED     — draw SUBMITTED
 *  (DRAFT draws have no stage.)
 */
import * as repo from "../db/repo";
import * as lrepo from "../db/lenderRepo";
import * as completionGates from "./completionGates";
import { missingRequiredDocuments } from "./draws";
import { currentDecision } from "./lenderDecisions";
import type { DrawRequest } from "../../shared/types";
import type { DrawStageEvent, DrawWorkflowStage, User } from "../../shared/types";

const OPEN_EXCEPTION_STATES = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"];

/** Deterministic derivation ladder — furthest supported stage wins. */
export function deriveDrawStage(drawRequestId: string): DrawWorkflowStage | null {
  const draw = repo.getDrawRequest(drawRequestId);
  if (!draw || draw.status === "DRAFT") return null;

  // ---- terminal / funding layer (external administrative records) ----
  const funding = lrepo.listFundingRecords(draw.id);
  if (draw.status === "CANCELLED" || funding.some((f) => f.status === "CLOSED" && !f.reversedAt)) return "DRAW_CLOSED";
  // Only a NON-REVERSED disbursement presents as FUNDS_DISBURSED; a
  // reversed or failed record falls through so the decision layer plus the
  // deterministic reversal/failure exception represent the state honestly.
  if (funding.some((f) => f.status === "DISBURSED" && !f.reversedAt)) return "FUNDS_DISBURSED";
  if (funding.some((f) => ["SCHEDULED", "PROCESSING"].includes(f.status))) return "FUNDS_SCHEDULED";

  // ---- lien release layer (after a favorable lender decision) ----
  const decision = currentDecision(draw.id);
  const waivers = lrepo.listLienWaivers(draw.id);
  const favorable = decision && ["APPROVED", "CONDITIONALLY_APPROVED", "REDUCED", "FUNDED"].includes(decision.decision);
  if (favorable && waivers.length > 0) {
    const outstanding = waivers.filter((w) =>
      ["REQUIRED", "REQUESTED", "RECEIVED", "UNDER_REVIEW", "REJECTED", "EXPIRED"].includes(w.status)
    );
    if (outstanding.length === 0) return "LIEN_RELEASE_COMPLETED";
    if (outstanding.some((w) => ["REQUESTED", "RECEIVED", "UNDER_REVIEW"].includes(w.status))) {
      return "LIEN_RELEASE_REQUESTED";
    }
  }

  // ---- lender decision layer ----
  if (decision) {
    switch (decision.decision) {
      case "REJECTED": return "REJECTED";
      case "REDUCED": return "REDUCED";
      case "CONDITIONALLY_APPROVED": return "CONDITIONALLY_APPROVED";
      case "APPROVED":
      case "FUNDED": return "APPROVED";
      default: break; // PENDING/WITHDRAWN fall through to governance state
    }
  }

  // ---- formal governance layer (authoritative ApprovalRequest) ----
  if (["APPROVED", "PARTIALLY_APPROVED", "RELEASED"].includes(draw.status)) {
    // Governance finished (or historical release) but the lender business
    // decision is not recorded yet → the lender is reviewing.
    return draw.status === "PARTIALLY_APPROVED" ? "LENDER_REVIEW_IN_PROGRESS" : decision ? "APPROVED" : "LENDER_REVIEW_IN_PROGRESS";
  }
  if (draw.status === "READY_FOR_GOVERNANCE") {
    const approval = repo.getApprovalRequestForDraw(draw.id);
    const records = approval ? repo.listApprovalRecordsForRequest(approval.id) : [];
    return records.length > 0 ? "LENDER_REVIEW_IN_PROGRESS" : "ELIGIBLE_FOR_LENDER_REVIEW";
  }

  // ---- corrections / clarification layer ----
  const inspections = lrepo.listDrawInspections(draw.id);
  const latestInspection = inspections.length > 0 ? inspections[inspections.length - 1] : null;
  if (latestInspection && ["CORRECTION_REQUIRED", "REINSPECTION_REQUIRED"].includes(latestInspection.status)) {
    return "CORRECTIONS_REQUESTED";
  }
  if (draw.status === "RETURNED") return "CORRECTIONS_REQUESTED";
  if (draw.status === "CLARIFICATION_REQUIRED") return "MISSING_INFORMATION_REQUESTED";

  // ---- OBV review pipeline (documents, inspection, evidence, exceptions) ----
  const missingDocs = missingRequiredDocuments(draw.id);
  const openExceptions = repo
    .listExceptions()
    .filter((e) => e.drawRequestId === draw.id && OPEN_EXCEPTION_STATES.includes(e.status));

  if (latestInspection) {
    if (["REQUESTED", "SCHEDULING", "ACCESS_FAILED"].includes(latestInspection.status)) return "INSPECTION_REQUESTED";
    if (latestInspection.status === "SCHEDULED") return "INSPECTION_SCHEDULED";
    if (["COMPLETED", "REPORT_PENDING", "REPORT_RECEIVED", "UNDER_OBV_REVIEW"].includes(latestInspection.status)) {
      return "PHYSICAL_INSPECTION_COMPLETED";
    }
  }

  if (openExceptions.length > 0) return "EXCEPTIONS_IDENTIFIED";
  if (missingDocs.length > 0) return draw.status === "SUBMITTED" ? "DRAW_REQUEST_SUBMITTED" : "INITIAL_COMPLETENESS_REVIEW";

  if (draw.status === "UNDER_REVIEW") {
    // Sequential-cumulative pipeline: each step is grounded in the record
    // family its stage names AND requires every earlier step, so a
    // vacuously-true later check never masks an unfinished earlier one.
    const docsDone = financialDocumentsReviewed(draw);
    const govDone = docsDone && governmentInspectionsChecked(draw);
    const evidenceDone = govDone && evidenceReviewCompleted(draw);
    if (evidenceDone) return "EVIDENCE_REVIEW_COMPLETED";
    if (govDone) return "GOVERNMENT_INSPECTION_CHECKED";
    if (docsDone) return "FINANCIAL_DOCUMENTS_REVIEWED";
    return "INITIAL_COMPLETENESS_REVIEW";
  }

  return "DRAW_REQUEST_SUBMITTED";
}

/** Required checklist complete AND every received document carries a
 *  recorded review outcome (ACCEPTED/REJECTED/EXPIRED — not merely
 *  RECEIVED). From the actual draw-document records. */
function financialDocumentsReviewed(draw: DrawRequest): boolean {
  if (missingRequiredDocuments(draw.id).length > 0) return false;
  const docs = repo.listDrawDocuments(draw.id);
  if (docs.length === 0) return false;
  return docs.every((d) => d.status !== "RECEIVED");
}

/** FULL completion-gate-based government inspection check: every draw-line
 *  milestone is evaluated through completionGates.inspectionSurfaceClean —
 *  the same gate primitives the six-gate machinery uses (jurisdictional
 *  inspections, reinspections, permit activity and code-basis controls),
 *  evaluated INDEPENDENTLY of tranche accountStatus so a RELEASED
 *  milestone keeps its inspection truth (a FAILED inspection or an
 *  UNDETERMINED requirement on a released milestone still blocks). An
 *  UNDETERMINED requirement never behaves as NOT_REQUIRED, and every draw
 *  line MUST map to a milestone — an unmapped line is incomplete data and
 *  blocks the stage (never filtered into a vacuous pass). */
export function governmentInspectionsChecked(draw: DrawRequest): boolean {
  const lines = repo.listDrawLines(draw.id);
  if (lines.length === 0 || lines.some((l) => l.status === "PENDING")) return false;
  // DATA COMPLETENESS: every draw line must map to a milestone — an
  // unmapped line means the government-inspection surface CANNOT be
  // evaluated for that work, so the stage is incomplete. Unmapped lines
  // are never filtered away into a vacuous pass.
  if (lines.some((l) => !l.milestoneId)) return false;
  const milestoneIds = [...new Set(lines.map((l) => l.milestoneId as string))];
  // Explicit guard: an empty milestone set must never satisfy the stage
  // through empty-array .every() (unreachable given the check above, but
  // the invariant is stated in code, not implied).
  if (milestoneIds.length === 0) return false;
  return milestoneIds.every((milestoneId) => completionGates.inspectionSurfaceClean(milestoneId));
}

/**
 * LINE-SPECIFIC evidence coverage. A single draw-level link never
 * blanket-covers all lines. For every draw line, the RELEVANT links are:
 *   - links scoped to that line whose evidence belongs to the line's
 *     mapped milestone (or the line has no milestone) — evidence from an
 *     unrelated milestone can never cover the line's work scope; and
 *   - draw-level links (no lineItemId) whose evidence belongs to the
 *     line's mapped milestone — the existing evidence→milestone
 *     relationship model is the explicit work-scope association.
 * Any other link is SUPPLEMENTAL: it neither covers nor completes.
 * The stage completes only when every line has ≥1 relevant VERIFIED link
 * and EVERY relevant link carries a final verdict — a missing verdict or
 * NEEDS_REVIEW blocks completion, and REJECTED blocks completion until
 * the applicable exception/correction path replaces or removes it. */
function evidenceReviewCompleted(draw: DrawRequest): boolean {
  const lines = repo.listDrawLines(draw.id);
  const links = repo.listDrawEvidenceLinks(draw.id);
  if (links.length === 0 || lines.length === 0) return false;
  const evidenceMilestone = (evidenceItemId: string): string | null =>
    repo.getEvidence(evidenceItemId)?.milestoneId ?? null;
  return lines.every((line) => {
    const relevant = links.filter((l) => {
      const scope = evidenceMilestone(l.evidenceItemId);
      if (l.lineItemId === line.id) {
        return line.milestoneId === null || scope === line.milestoneId;
      }
      if (l.lineItemId) return false; // scoped to a different line
      return line.milestoneId !== null && scope === line.milestoneId;
    });
    if (relevant.length === 0) return false;
    let covered = false;
    for (const l of relevant) {
      const verification = repo.getVerificationForEvidence(l.evidenceItemId);
      if (!verification) return false; // no final verdict yet
      if (verification.verdict === "NEEDS_REVIEW") return false;
      if (verification.verdict === "REJECTED") return false;
      if (verification.verdict === "VERIFIED") covered = true;
    }
    return covered;
  });
}

/** Append an observation when the derived stage changed. Mutating actions
 *  only — never called from GET handlers. */
export function syncDrawStage(
  drawRequestId: string,
  actor: User | null,
  reason?: string | null,
  sourceRecordId?: string | null
): DrawStageEvent | null {
  const stage = deriveDrawStage(drawRequestId);
  if (!stage) return null;
  const last = lrepo.lastStageEvent(drawRequestId);
  if (last && last.newStage === stage) return null;
  const event: DrawStageEvent = {
    id: lrepo.newId(),
    drawRequestId,
    priorStage: last?.newStage ?? null,
    newStage: stage,
    actorUserId: actor?.id ?? null,
    reason: reason?.trim() || null,
    sourceRecordId: sourceRecordId ?? null,
    createdAt: new Date().toISOString(),
  };
  lrepo.insertStageEvent(event);
  return event;
}

export function stageHistory(drawRequestId: string): DrawStageEvent[] {
  return lrepo.listStageEvents(drawRequestId);
}
