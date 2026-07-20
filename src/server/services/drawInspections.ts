/**
 * Independent lender-ordered draw inspections.
 *
 * A completely separate domain from government JurisdictionalInspection —
 * different entity, different status set, no shared record. An inspector's
 * reported percentage is the inspector's report only: it never overwrites
 * contractor-reported completion, OBV verified physical progress, or any
 * lender-approved amount. Finalized report versions are immutable;
 * corrections create a new version. Nothing here can verify evidence,
 * pass a government inspection, approve a draw, or move money.
 */
import { createHash } from "node:crypto";
import * as repo from "../db/repo";
import * as lrepo from "../db/lenderRepo";
import { teamsNotifier } from "./TeamsNotifier";
import { LenderError, assertCapability, assertProjectAccess, hasCapability } from "./lenderAccess";
import { parseIsoDate } from "./permits";
import type {
  DrawInspection,
  DrawInspectionLine,
  DrawInspectionReportVersion,
  DrawInspectionStatus,
  User,
} from "../../shared/types";

const ACTIVE_STATES: DrawInspectionStatus[] = [
  "REQUESTED", "SCHEDULING", "SCHEDULED", "ACCESS_FAILED", "COMPLETED",
  "REPORT_PENDING", "REPORT_RECEIVED", "UNDER_OBV_REVIEW", "CORRECTION_REQUIRED",
];

/** Legal transitions. Terminal states have no exits except REINSPECTION_
 *  REQUIRED → (a new inspection record via requestReinspection). */
const TRANSITIONS: Record<DrawInspectionStatus, DrawInspectionStatus[]> = {
  NOT_REQUIRED: [],
  REQUESTED: ["SCHEDULING", "SCHEDULED", "CANCELLED"],
  SCHEDULING: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["ACCESS_FAILED", "COMPLETED", "SCHEDULING", "CANCELLED"],
  ACCESS_FAILED: ["SCHEDULING", "SCHEDULED", "FAILED", "CANCELLED"],
  COMPLETED: ["REPORT_PENDING", "REPORT_RECEIVED"],
  REPORT_PENDING: ["REPORT_RECEIVED"],
  REPORT_RECEIVED: ["UNDER_OBV_REVIEW"],
  UNDER_OBV_REVIEW: ["CORRECTION_REQUIRED", "FINALIZED"],
  CORRECTION_REQUIRED: ["UNDER_OBV_REVIEW", "REINSPECTION_REQUIRED"],
  FINALIZED: ["ACCEPTED", "REINSPECTION_REQUIRED"],
  ACCEPTED: [],
  FAILED: ["REINSPECTION_REQUIRED"],
  REINSPECTION_REQUIRED: [],
  CANCELLED: [],
};

function event(inspection: DrawInspection, type: string, detail: string, actor: User | null): void {
  lrepo.insertInspectionEvent({
    id: lrepo.newId(),
    drawInspectionId: inspection.id,
    type,
    detail,
    actorUserId: actor?.id ?? null,
    createdAt: new Date().toISOString(),
  });
}

function getInspectionFor(user: User, inspectionId: string): DrawInspection {
  const inspection = lrepo.getDrawInspection(inspectionId);
  if (!inspection) throw new LenderError("Draw inspection not found", 404);
  assertProjectAccess(user, inspection.projectId); // 404 out-of-tenant
  return inspection;
}

function transition(
  user: User,
  inspection: DrawInspection,
  next: DrawInspectionStatus,
  patch: Partial<DrawInspection>,
  detail: string
): DrawInspection {
  if (!TRANSITIONS[inspection.status].includes(next)) {
    throw new LenderError(
      `A ${inspection.status} draw inspection cannot become ${next}`,
      409
    );
  }
  lrepo.updateDrawInspection(inspection.id, { ...patch, status: next });
  const updated = lrepo.getDrawInspection(inspection.id)!;
  event(updated, next, detail, user);
  return updated;
}

// ------------------------------------------------------------ lifecycle

export function requestInspection(
  user: User,
  input: {
    drawRequestId: string;
    inspectionType?: string;
    inspectionCompanyOrganizationId?: string | null;
    inspectorUserId?: string | null;
    inspectorDisplayName?: string | null;
    inspectorCredential?: string | null;
    inspectorContact?: string | null;
    propertyAccessContact?: string | null;
    preferredInspectionStart?: string | null;
    preferredInspectionEnd?: string | null;
  }
): DrawInspection {
  const draw = repo.getDrawRequest(input.drawRequestId);
  if (!draw) throw new LenderError("Draw request not found", 404);
  const project = assertProjectAccess(user, draw.projectId);
  assertCapability(user, project.id, "SCHEDULE_DRAW_INSPECTION");
  if (["CANCELLED", "RETURNED"].includes(draw.status)) {
    throw new LenderError("Cannot order an inspection for a cancelled or returned draw", 409);
  }
  const open = lrepo.listDrawInspections(draw.id).filter((i) => ACTIVE_STATES.includes(i.status));
  if (open.length > 0) {
    throw new LenderError("An independent inspection is already in progress for this draw", 409);
  }
  if (input.inspectorUserId && !repo.getUser(input.inspectorUserId)) {
    throw new LenderError("inspectorUserId references an unknown user", 422);
  }
  if (input.inspectionCompanyOrganizationId && !repo.getOrganization(input.inspectionCompanyOrganizationId)) {
    throw new LenderError("inspectionCompanyOrganizationId references an unknown organization", 422);
  }
  const preferredStart = parseIsoDate(input.preferredInspectionStart, "preferredInspectionStart");
  const preferredEnd = parseIsoDate(input.preferredInspectionEnd, "preferredInspectionEnd");
  if (preferredStart && preferredEnd && preferredEnd < preferredStart) {
    throw new LenderError("preferredInspectionEnd cannot be before preferredInspectionStart", 422);
  }
  const now = new Date().toISOString();
  const inspection: DrawInspection = {
    id: lrepo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    drawRequestId: draw.id,
    inspectionType: input.inspectionType?.trim() || "DRAW_PROGRESS",
    inspectionCompanyOrganizationId: input.inspectionCompanyOrganizationId ?? null,
    inspectorUserId: input.inspectorUserId ?? null,
    inspectorDisplayName: input.inspectorDisplayName?.trim() || null,
    inspectorCredential: input.inspectorCredential?.trim() || null,
    inspectorContact: input.inspectorContact?.trim() || null,
    requestedAt: now,
    requestedByUserId: user.id,
    scheduledAt: null,
    propertyAccessContact: input.propertyAccessContact?.trim() || null,
    preferredInspectionStart: preferredStart,
    preferredInspectionEnd: preferredEnd,
    completedAt: null,
    reportReceivedAt: null,
    finalizedAt: null,
    status: "REQUESTED",
    reinspectionOfInspectionId: null,
    borrowerResponseStatus: null,
    borrowerResponseNote: null,
    obvReviewStatus: "PENDING",
    obvReviewedByUserId: null,
    lenderAcceptanceStatus: "PENDING",
    lenderAcceptedByUserId: null,
    createdAt: now,
    updatedAt: now,
  };
  lrepo.insertDrawInspection(inspection);
  event(inspection, "REQUESTED", `Independent draw inspection requested for Draw #${draw.drawNumber}`, user);
  void teamsNotifier.notify(
    "DRAW_INSPECTION_REQUESTED",
    `Independent inspection requested for Draw #${draw.drawNumber}`,
    { projectId: project.id }
  );
  return inspection;
}

export function scheduleInspection(
  user: User,
  inspectionId: string,
  input: { scheduledAt: string; inspectorDisplayName?: string | null; inspectorContact?: string | null }
): DrawInspection {
  const inspection = getInspectionFor(user, inspectionId);
  assertCapability(user, inspection.projectId, "SCHEDULE_DRAW_INSPECTION");
  const scheduledAt = parseIsoDate(input.scheduledAt, "scheduledAt");
  if (!scheduledAt) throw new LenderError("scheduledAt is required", 400);
  const updated = transition(user, inspection, "SCHEDULED", {
    scheduledAt,
    inspectorDisplayName: input.inspectorDisplayName?.trim() || inspection.inspectorDisplayName,
    inspectorContact: input.inspectorContact?.trim() || inspection.inspectorContact,
  }, `Scheduled for ${scheduledAt}`);
  void teamsNotifier.notify("DRAW_INSPECTION_SCHEDULED", `Draw inspection scheduled for ${scheduledAt}`, {
    projectId: inspection.projectId,
  });
  return updated;
}

export function recordAccessFailure(user: User, inspectionId: string, note: string): DrawInspection {
  const inspection = getInspectionFor(user, inspectionId);
  if (!canRecordFindings(user, inspection)) {
    throw new LenderError("Recording an access failure requires the assigned inspector or an inspection capability", 403);
  }
  return transition(user, inspection, "ACCESS_FAILED", {}, note.trim() || "Property access failed");
}

/** The inspector (assigned user or holder of RECORD_INSPECTION_FINDINGS). */
function canRecordFindings(user: User, inspection: DrawInspection): boolean {
  if (inspection.inspectorUserId === user.id) return true;
  return hasCapability(user, inspection.projectId, "RECORD_INSPECTION_FINDINGS");
}

export function completeInspection(user: User, inspectionId: string, completedAt?: string | null): DrawInspection {
  const inspection = getInspectionFor(user, inspectionId);
  if (!canRecordFindings(user, inspection)) {
    throw new LenderError("Completing the site visit requires the assigned inspector", 403);
  }
  const updated = transition(user, inspection, "COMPLETED", {
    completedAt: parseIsoDate(completedAt, "completedAt") || new Date().toISOString(),
  }, "Site visit completed");
  // Immediately note that the written report is outstanding.
  const pending = transition(user, updated, "REPORT_PENDING", {}, "Awaiting written inspection report");
  void teamsNotifier.notify("DRAW_INSPECTION_COMPLETED", "Independent draw inspection site visit completed", {
    projectId: inspection.projectId,
  });
  return pending;
}

// ------------------------------------------------------------ line findings

export function recordLineFinding(
  user: User,
  inspectionId: string,
  input: Partial<DrawInspectionLine> & { drawLineItemId?: string | null }
): DrawInspectionLine {
  const inspection = getInspectionFor(user, inspectionId);
  if (!canRecordFindings(user, inspection)) {
    throw new LenderError("Recording findings requires the assigned inspector", 403);
  }
  if (["FINALIZED", "ACCEPTED", "CANCELLED", "FAILED"].includes(inspection.status)) {
    throw new LenderError("Findings cannot be added after the inspection is finalized", 409);
  }
  // Relational integrity: every referenced record must belong to this
  // inspection's own project/draw. Errors are 422 with generic wording so
  // cross-tenant existence is never disclosed.
  let drawLine = null;
  if (input.drawLineItemId) {
    drawLine = repo.getDrawLine(input.drawLineItemId);
    if (!drawLine || drawLine.drawRequestId !== inspection.drawRequestId) {
      throw new LenderError("drawLineItemId does not belong to this draw", 422);
    }
  }
  if (input.budgetLineId) {
    const budgetLine = repo.getBudgetLine(input.budgetLineId);
    if (!budgetLine || budgetLine.projectId !== inspection.projectId) {
      throw new LenderError("budgetLineId does not belong to this project", 422);
    }
    if (drawLine && drawLine.budgetLineId && drawLine.budgetLineId !== input.budgetLineId) {
      throw new LenderError("budgetLineId is inconsistent with the referenced draw line", 422);
    }
  }
  if (input.milestoneId) {
    const milestone = repo.getMilestone(input.milestoneId);
    if (!milestone || milestone.projectId !== inspection.projectId) {
      throw new LenderError("milestoneId does not belong to this project", 422);
    }
    if (drawLine && drawLine.milestoneId && drawLine.milestoneId !== input.milestoneId) {
      throw new LenderError("milestoneId is inconsistent with the referenced draw line", 422);
    }
  }
  const pct = input.percentCompleteReported === null || input.percentCompleteReported === undefined
    ? null
    : Number(input.percentCompleteReported);
  if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
    throw new LenderError("percentCompleteReported must be between 0 and 100", 400);
  }
  const now = new Date().toISOString();
  const finding: DrawInspectionLine = {
    id: lrepo.newId(),
    drawInspectionId: inspection.id,
    drawLineItemId: input.drawLineItemId ?? null,
    budgetLineId: input.budgetLineId ?? null,
    milestoneId: input.milestoneId ?? null,
    percentCompleteReported: pct,
    materialsPresent: input.materialsPresent ?? null,
    materialsStoredOnSite: input.materialsStoredOnSite ?? null,
    materialsStoredOffSite: input.materialsStoredOffSite ?? null,
    workConsistentWithPlans: input.workConsistentWithPlans ?? null,
    workmanshipObservation: input.workmanshipObservation?.trim() || null,
    visibleDefects: input.visibleDefects?.trim() || null,
    safetyConcerns: input.safetyConcerns?.trim() || null,
    inaccessibleAreas: input.inaccessibleAreas?.trim() || null,
    inspectorNote: input.inspectorNote?.trim() || null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    lrepo.insertInspectionLine(finding);
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE")) {
      throw new LenderError("A finding for this draw line already exists on this inspection", 409);
    }
    throw err;
  }
  event(inspection, "LINE_FINDING", `Inspector line finding recorded${pct !== null ? ` (${pct}% reported)` : ""}`, user);
  return finding;
}

// ------------------------------------------------------------ report versions

export function createReportDraft(
  user: User,
  inspectionId: string,
  input: { reportDate?: string | null; summary?: string | null; conclusion?: string | null; documentBase64?: string | null; correctionReason?: string | null }
): DrawInspectionReportVersion {
  const inspection = getInspectionFor(user, inspectionId);
  if (!canRecordFindings(user, inspection)) {
    throw new LenderError("Preparing the report requires the assigned inspector", 403);
  }
  const versions = lrepo.listReportVersions(inspection.id);
  if (versions.some((v) => v.status === "DRAFT")) {
    throw new LenderError("A draft report version already exists — edit or finalize it first", 409);
  }
  const priorFinal = [...versions].reverse().find((v) => v.status !== "DRAFT") ?? null;
  if (priorFinal && !(input.correctionReason ?? "").trim()) {
    throw new LenderError("A corrected report version requires a correctionReason", 400);
  }
  let documentHash: string | null = null;
  if (input.documentBase64) {
    const bytes = Buffer.from(input.documentBase64, "base64");
    if (bytes.length > 5 * 1024 * 1024) throw new LenderError("Report document exceeds 5MB", 413);
    documentHash = createHash("sha256").update(bytes).digest("hex");
  }
  const version: DrawInspectionReportVersion = {
    id: lrepo.newId(),
    drawInspectionId: inspection.id,
    version: versions.length > 0 ? Math.max(...versions.map((v) => v.version)) + 1 : 1,
    status: "DRAFT",
    reportDate: parseIsoDate(input.reportDate, "reportDate"),
    summary: input.summary?.trim() || null,
    conclusion: input.conclusion?.trim() || null,
    preparedByUserId: user.id,
    finalizedByUserId: null,
    createdAt: new Date().toISOString(),
    finalizedAt: null,
    priorVersionId: priorFinal?.id ?? null,
    correctionReason: input.correctionReason?.trim() || null,
    documentPath: null,
    documentHash,
  };
  lrepo.insertReportVersion(version);
  // Receiving the first written report advances the inspection.
  if (["COMPLETED", "REPORT_PENDING"].includes(inspection.status)) {
    const received = transition(user, inspection, "REPORT_RECEIVED", {
      reportReceivedAt: new Date().toISOString(),
    }, `Report v${version.version} received (draft)`);
    transition(user, received, "UNDER_OBV_REVIEW", {}, "Report under OBV completeness review");
    void teamsNotifier.notify("DRAW_INSPECTION_REPORT_RECEIVED", `Inspection report v${version.version} received`, {
      projectId: inspection.projectId,
    });
  } else {
    event(inspection, "REPORT_DRAFTED", `Correction draft v${version.version} created`, user);
  }
  return version;
}

export function updateReportDraft(
  user: User,
  versionId: string,
  patch: { reportDate?: string | null; summary?: string | null; conclusion?: string | null }
): DrawInspectionReportVersion {
  const version = lrepo.getReportVersion(versionId);
  if (!version) throw new LenderError("Report version not found", 404);
  const inspection = getInspectionFor(user, version.drawInspectionId);
  if (!canRecordFindings(user, inspection)) throw new LenderError("Editing the draft requires the assigned inspector", 403);
  const ok = lrepo.updateDraftReportVersion(versionId, patch);
  if (!ok) {
    throw new LenderError("Finalized report versions are immutable — create a correction version instead", 409);
  }
  return lrepo.getReportVersion(versionId)!;
}

export function finalizeReport(user: User, versionId: string): DrawInspectionReportVersion {
  const version = lrepo.getReportVersion(versionId);
  if (!version) throw new LenderError("Report version not found", 404);
  const inspection = getInspectionFor(user, version.drawInspectionId);
  if (!hasCapability(user, inspection.projectId, "FINALIZE_INSPECTION_REPORT") && inspection.inspectorUserId !== user.id) {
    throw new LenderError("Finalizing the report requires the FINALIZE_INSPECTION_REPORT capability", 403);
  }
  const ok = lrepo.finalizeReportVersionTx(versionId, user.id, new Date().toISOString());
  if (!ok) throw new LenderError("Only a draft version can be finalized", 409);
  if (inspection.status === "UNDER_OBV_REVIEW" || inspection.status === "CORRECTION_REQUIRED") {
    const path = inspection.status === "CORRECTION_REQUIRED"
      ? transition(user, inspection, "UNDER_OBV_REVIEW", {}, "Corrected report back under review")
      : inspection;
    transition(user, path, "FINALIZED", { finalizedAt: new Date().toISOString() }, `Report v${version.version} finalized`);
  }
  return lrepo.getReportVersion(versionId)!;
}

/** OBV completeness review — separate from lender acceptance. */
export function recordObvReview(
  user: User,
  inspectionId: string,
  input: { outcome: "REVIEWED" | "CORRECTION_REQUIRED"; note?: string | null }
): DrawInspection {
  const inspection = getInspectionFor(user, inspectionId);
  assertCapability(user, inspection.projectId, "REVIEW_DRAW");
  if (inspection.status !== "UNDER_OBV_REVIEW" && inspection.status !== "FINALIZED") {
    throw new LenderError("No report is under OBV review", 409);
  }
  if (input.outcome === "CORRECTION_REQUIRED") {
    if (inspection.status === "FINALIZED") {
      throw new LenderError("A finalized report needs a correction version, not a review flag", 409);
    }
    const updated = transition(user, inspection, "CORRECTION_REQUIRED", {
      obvReviewStatus: "CORRECTION_REQUIRED",
      obvReviewedByUserId: user.id,
    }, input.note?.trim() || "Report correction required");
    void teamsNotifier.notify("DRAW_INSPECTION_CORRECTION_REQUIRED", "Inspection report correction required", {
      projectId: inspection.projectId,
    });
    return updated;
  }
  lrepo.updateDrawInspection(inspection.id, { obvReviewStatus: "REVIEWED", obvReviewedByUserId: user.id });
  const updated = lrepo.getDrawInspection(inspection.id)!;
  event(updated, "OBV_REVIEWED", input.note?.trim() || "OBV completeness review recorded", user);
  return updated;
}

/** Lender acceptance — the lender's own act; an uploaded report or an OBV
 *  review never makes an inspection ACCEPTED by itself. The inspector may
 *  not accept their own report for lender purposes. */
export function recordLenderAcceptance(user: User, inspectionId: string, accepted: boolean, note?: string | null): DrawInspection {
  const inspection = getInspectionFor(user, inspectionId);
  assertCapability(user, inspection.projectId, "RECORD_LENDER_DECISION");
  if (inspection.inspectorUserId === user.id || (inspection.requestedByUserId === user.id && inspection.inspectorUserId === user.id)) {
    throw new LenderError("The inspector cannot accept their own report for lender purposes", 403);
  }
  if (inspection.status !== "FINALIZED") {
    throw new LenderError("Only a finalized inspection report can be accepted", 409);
  }
  if (!accepted) {
    lrepo.updateDrawInspection(inspection.id, {
      lenderAcceptanceStatus: "NOT_ACCEPTED",
      lenderAcceptedByUserId: user.id,
    });
    const updated = lrepo.getDrawInspection(inspection.id)!;
    event(updated, "LENDER_NOT_ACCEPTED", note?.trim() || "Lender declined the inspection report", user);
    return updated;
  }
  const updated = transition(user, inspection, "ACCEPTED", {
    lenderAcceptanceStatus: "ACCEPTED",
    lenderAcceptedByUserId: user.id,
  }, note?.trim() || "Inspection accepted by lender");
  return updated;
}

export function requestReinspection(user: User, inspectionId: string, reason: string): DrawInspection {
  const prior = getInspectionFor(user, inspectionId);
  assertCapability(user, prior.projectId, "SCHEDULE_DRAW_INSPECTION");
  if (!reason.trim()) throw new LenderError("A reinspection reason is required", 400);
  if (!["FINALIZED", "FAILED", "CORRECTION_REQUIRED"].includes(prior.status)) {
    throw new LenderError("Reinspection is only available after a finalized, failed or correction-flagged inspection", 409);
  }
  // Chain integrity: walk the reinspection ancestry. Every ancestor must
  // exist, belong to the SAME draw, and never repeat (no self-reference or
  // circular chain) — a corrupted chain is refused rather than extended.
  const seen = new Set<string>([prior.id]);
  let cursorId = prior.reinspectionOfInspectionId;
  while (cursorId) {
    if (seen.has(cursorId)) {
      throw new LenderError("Reinspection chain is circular — refusing to extend it", 409);
    }
    seen.add(cursorId);
    const ancestor = lrepo.getDrawInspection(cursorId);
    if (!ancestor) throw new LenderError("Reinspection chain references a missing inspection", 409);
    if (ancestor.drawRequestId !== prior.drawRequestId) {
      throw new LenderError("Reinspection chain crosses draw requests — refusing to extend it", 409);
    }
    cursorId = ancestor.reinspectionOfInspectionId;
  }
  const now = new Date().toISOString();
  const next: DrawInspection = {
    ...prior,
    id: lrepo.newId(),
    status: "REQUESTED",
    requestedAt: now,
    requestedByUserId: user.id,
    scheduledAt: null,
    completedAt: null,
    reportReceivedAt: null,
    finalizedAt: null,
    reinspectionOfInspectionId: prior.id,
    obvReviewStatus: "PENDING",
    obvReviewedByUserId: null,
    lenderAcceptanceStatus: "PENDING",
    lenderAcceptedByUserId: null,
    createdAt: now,
    updatedAt: now,
  };
  // Atomic: flag the prior REINSPECTION_REQUIRED and insert the child in
  // one transaction. The conditional UPDATE (status must still be
  // reinspectable) plus idx_draw_reinspection_single_child guarantee that
  // concurrent requests produce one success and one 409.
  try {
    lrepo.createDrawReinspectionTx(next, prior.id);
  } catch (err) {
    if ((err as Error).message.includes("UNIQUE")) {
      throw new LenderError("A reinspection has already been opened for this inspection", 409);
    }
    throw err;
  }
  const flagged = lrepo.getDrawInspection(prior.id)!;
  event(flagged, "REINSPECTION_REQUIRED", reason.trim(), user);
  event(next, "REQUESTED", `Reinspection of ${prior.id} requested: ${reason.trim()}`, user);
  void teamsNotifier.notify("DRAW_REINSPECTION_REQUIRED", "Draw reinspection required", { projectId: prior.projectId });
  return next;
}

export function cancelInspection(user: User, inspectionId: string, reason?: string | null): DrawInspection {
  const inspection = getInspectionFor(user, inspectionId);
  assertCapability(user, inspection.projectId, "SCHEDULE_DRAW_INSPECTION");
  return transition(user, inspection, "CANCELLED", {}, reason?.trim() || "Inspection cancelled");
}

// ------------------------------------------------------------ reads

export function inspectionDetail(user: User, inspectionId: string): {
  inspection: DrawInspection;
  lines: DrawInspectionLine[];
  reportVersions: DrawInspectionReportVersion[];
  events: ReturnType<typeof lrepo.listInspectionEvents>;
  latestReport: DrawInspectionReportVersion | null;
} {
  const inspection = getInspectionFor(user, inspectionId);
  const reportVersions = lrepo.listReportVersions(inspection.id);
  const finalized = reportVersions.filter((v) => v.status === "FINALIZED");
  return {
    inspection,
    lines: lrepo.listInspectionLines(inspection.id),
    reportVersions,
    events: lrepo.listInspectionEvents(inspection.id),
    latestReport: finalized.length > 0 ? finalized[finalized.length - 1] : null,
  };
}

export function listForDraw(user: User, drawRequestId: string): DrawInspection[] {
  const draw = repo.getDrawRequest(drawRequestId);
  if (!draw) throw new LenderError("Draw request not found", 404);
  assertProjectAccess(user, draw.projectId);
  return lrepo.listDrawInspections(drawRequestId);
}
