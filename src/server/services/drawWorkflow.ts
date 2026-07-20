/**
 * Derived draw workflow stage.
 *
 * The stage is COMPUTED from authoritative records (DrawRequest status,
 * approval records, independent inspections, lien waivers, lender
 * decisions, external funding) on every read — there is no second mutable
 * stage column that could contradict the sources. draw_stage_events is an
 * append-only OBSERVATION log: mutating actions call syncDrawStage() and a
 * row is appended only when the derived stage differs from the last
 * observation. GET requests never write.
 *
 * Default outcome doctrine: the ladder maps READY_FOR_GOVERNANCE to
 * ELIGIBLE_FOR_LENDER_REVIEW — eligibility for review, never automatic
 * approval.
 */
import * as repo from "../db/repo";
import * as lrepo from "../db/lenderRepo";
import { missingRequiredDocuments } from "./draws";
import { currentDecision } from "./lenderDecisions";
import type { DrawStageEvent, DrawWorkflowStage, User } from "../../shared/types";

const OPEN_EXCEPTION_STATES = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"];

/** Deterministic derivation ladder — furthest supported stage wins. */
export function deriveDrawStage(drawRequestId: string): DrawWorkflowStage | null {
  const draw = repo.getDrawRequest(drawRequestId);
  if (!draw || draw.status === "DRAFT") return null;

  // ---- terminal / funding layer (external administrative records) ----
  const funding = lrepo.listFundingRecords(draw.id);
  if (draw.status === "CANCELLED" || funding.some((f) => f.status === "CLOSED")) return "DRAW_CLOSED";
  if (funding.some((f) => f.status === "DISBURSED" || f.status === "REVERSED")) return "FUNDS_DISBURSED";
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
    const lines = repo.listDrawLines(draw.id);
    const allLinesReviewed = lines.length > 0 && lines.every((l) => l.status !== "PENDING");
    if (draw.reviewRecommendation) return "FINANCIAL_DOCUMENTS_REVIEWED";
    if (allLinesReviewed) return "GOVERNMENT_INSPECTION_CHECKED";
    if (latestInspection && ["FINALIZED", "ACCEPTED"].includes(latestInspection.status)) {
      return "EVIDENCE_REVIEW_COMPLETED";
    }
    return "INITIAL_COMPLETENESS_REVIEW";
  }

  return "DRAW_REQUEST_SUBMITTED";
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
