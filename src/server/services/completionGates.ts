/**
 * Milestone Completion Gates — six separate authoritative dimensions.
 *
 * PHOTOGRAPHIC COMPLETION IS NOT LEGAL OR CONTRACTUAL COMPLETION.
 *
 *   1. Contractor completion   — the contractor's own representation.
 *   2. OBV evidence review     — DERIVED from the governed evidence
 *                                pipeline; never a second truth.
 *   3. Inspection requirement  — configured / determined; UNKNOWN never
 *                                behaves as NOT_REQUIRED.
 *   4. Inspection scheduling   — first-class inspection records.
 *   5. Inspection outcome      — recorded by an attributable internal
 *                                reviewer; an uploaded document never
 *                                becomes PASSED automatically.
 *   6. Draw eligibility        — a DERIVED governance state with
 *                                structured reason codes. It can never
 *                                release funds: release stays with the
 *                                existing formal ApprovalRequest path and
 *                                the exactly-once VirtualAccountService.
 */
import * as repo from "../db/repo";
import { audit, snapshotProject } from "./pilot/onboarding";
import { canAccessProjectFinance } from "./budgetProgress";
import type {
  ContractorCompletionStatus, EvidenceReviewStatus, GateReason,
  InspectionGateState, InspectionRequirement, InspectionRequirementValue,
  JurisdictionalInspection, Milestone, MilestoneDrawEligibility,
  MilestoneGates, Project, User,
} from "../../shared/types";

export class GateError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

// =============================================================== access

function projectFor(milestoneId: string): { milestone: Milestone; project: Project } {
  const milestone = repo.getMilestone(milestoneId);
  const project = milestone ? repo.getProject(milestone.projectId) : null;
  if (!milestone || !project) throw new GateError("Milestone not found", 404);
  return { milestone, project };
}

function assertAccess(user: User, milestoneId: string): { milestone: Milestone; project: Project } {
  const ctx = projectFor(milestoneId);
  // Tenant boundary: unrelated organizations get 404.
  if (!canAccessProjectFinance(user, ctx.project)) throw new GateError("Milestone not found", 404);
  return ctx;
}

/** Determinations and inspection results are lender-side reviewed acts. */
const DETERMINATION_ROLES = new Set(["FUNDER_REP", "COMPLIANCE_REVIEWER"]);
/** The contractor's representation comes from the delivery side. */
const CONTRACTOR_ROLES = new Set(["PROJECT_MANAGER", "FIELD"]);

// ================================================= gate 1: contractor

export function reportContractorCompletion(
  user: User,
  milestoneId: string,
  input: { status: ContractorCompletionStatus; notes?: string | null; linkedEvidenceIds?: string[] }
): Milestone {
  const { milestone, project } = assertAccess(user, milestoneId);
  if (!CONTRACTOR_ROLES.has(user.role)) {
    throw new GateError("Contractor completion is reported by the delivery side (project manager / field)", 403);
  }
  if (!["IN_PROGRESS", "REPORTED_COMPLETE", "WITHDRAWN"].includes(input.status)) {
    throw new GateError("status must be IN_PROGRESS, REPORTED_COMPLETE or WITHDRAWN");
  }
  const linked = (input.linkedEvidenceIds ?? []).filter((id) => {
    const ev = repo.getEvidence(id);
    return ev && ev.milestoneId === milestoneId;
  });
  const now = new Date().toISOString();
  repo.updateContractorCompletion(milestoneId, {
    status: input.status,
    reportedByUserId: user.id,
    reportedAt: now,
    notes: input.notes?.trim() || null,
    linkedEvidenceIds: linked,
  });
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "CONTRACTOR_COMPLETION_" + input.status,
    entityType: "MILESTONE",
    entityId: milestoneId,
    reason: input.notes?.trim() || null,
    beforeSummary: milestone.contractorCompletionStatus ?? "NOT_REPORTED",
    afterSummary:
      input.status === "REPORTED_COMPLETE"
        ? "REPORTED_COMPLETE — contractor representation only; not verification, inspection, approval or release"
        : input.status,
  });
  return repo.getMilestone(milestoneId)!;
}

// ============================================ gate 2: evidence review

/** DERIVED from the governed evidence + VerificationAggregator records.
 *  VERIFIED means only that the configured OBV evidence policy is
 *  satisfied — never that a jurisdictional inspection passed. */
export function evidenceReviewStatus(milestoneId: string): {
  status: EvidenceReviewStatus;
  evidenceCount: number;
  latestVerdict: string | null;
  policyVersion: number | null;
} {
  const evidence = repo.listEvidenceForMilestone(milestoneId);
  if (evidence.length === 0) {
    return { status: "NOT_SUBMITTED", evidenceCount: 0, latestVerdict: null, policyVersion: null };
  }
  const latest = evidence[evidence.length - 1];
  const v = repo.getVerificationForEvidence(latest.id);
  if (!v) {
    return { status: "SUBMITTED", evidenceCount: evidence.length, latestVerdict: null, policyVersion: null };
  }
  const status: EvidenceReviewStatus =
    v.verdict === "VERIFIED" ? "VERIFIED" : v.verdict === "REJECTED" ? "REJECTED" : "NEEDS_REVIEW";
  return {
    status,
    evidenceCount: evidence.length,
    latestVerdict: v.verdict,
    policyVersion: v.policyVersion ?? null,
  };
}

// ===================================== gate 3: inspection requirement

export function requirementValue(milestoneId: string): InspectionRequirementValue {
  // Absence of a determination is UNKNOWN — never inferred NOT_REQUIRED.
  return repo.getInspectionRequirement(milestoneId)?.requirement ?? "UNKNOWN";
}

export function determineInspectionRequirement(
  user: User,
  milestoneId: string,
  input: {
    requirement: "REQUIRED" | "NOT_REQUIRED";
    requirementBasis: string;
    jurisdiction?: string | null;
    inspectionType?: string | null;
    issuingAuthority?: string | null;
    mustPassBeforeDrawReview?: boolean;
    mustPassBeforeGovernance?: boolean;
    finalCompletionOnly?: boolean;
    resultDocumentRequired?: boolean;
  }
): InspectionRequirement {
  const { milestone, project } = assertAccess(user, milestoneId);
  if (!DETERMINATION_ROLES.has(user.role)) {
    throw new GateError("Inspection requirement determinations require a funder representative or compliance reviewer", 403);
  }
  if (!["REQUIRED", "NOT_REQUIRED"].includes(input.requirement)) {
    throw new GateError("requirement must be REQUIRED or NOT_REQUIRED");
  }
  const basis = (input.requirementBasis ?? "").trim();
  if (!basis) {
    throw new GateError(
      "requirementBasis is required — NOT_REQUIRED and REQUIRED are attributable determinations, never inferred"
    );
  }
  if (input.requirement === "REQUIRED" && !(input.inspectionType ?? "").trim()) {
    throw new GateError("inspectionType is required for a REQUIRED determination");
  }
  const existing = repo.getInspectionRequirement(milestoneId);
  const now = new Date().toISOString();
  const req: InspectionRequirement = {
    id: existing?.id ?? repo.newId(),
    projectId: project.id,
    milestoneId,
    requirement: input.requirement,
    requirementBasis: basis,
    determinedBy: user.id,
    determinedAt: now,
    jurisdiction: input.jurisdiction?.trim() || null,
    inspectionType: input.inspectionType?.trim() || null,
    issuingAuthority: input.issuingAuthority?.trim() || null,
    mustPassBeforeDrawReview: input.mustPassBeforeDrawReview ?? false,
    mustPassBeforeGovernance: input.mustPassBeforeGovernance ?? true,
    finalCompletionOnly: input.finalCompletionOnly ?? false,
    resultDocumentRequired: input.resultDocumentRequired ?? false,
    configurationVersion: project.pilot?.configVersion ?? 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  repo.upsertInspectionRequirement(req);
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "INSPECTION_REQUIREMENT_DETERMINED",
    entityType: "MILESTONE",
    entityId: milestoneId,
    reason: basis,
    beforeSummary: existing?.requirement ?? "UNKNOWN",
    afterSummary: `${input.requirement}${req.inspectionType ? ` (${req.inspectionType})` : ""}${req.jurisdiction ? ` — ${req.jurisdiction}` : ""}`,
  });
  // Configuration act: snapshot the project like other post-launch
  // change-control operations (versioned; historic states untouched).
  if (project.status !== "DRAFT") {
    snapshotProject(
      project.id,
      `Inspection requirement determined for M${milestone.seq}: ${input.requirement} — ${basis}`,
      user
    );
  }
  return req;
}

// ============================= gates 4–5: inspection schedule + result

function activeInspection(milestoneId: string): JurisdictionalInspection | null {
  const all = repo.listInspectionsForMilestone(milestoneId);
  const active = all.filter((i) => i.status !== "CANCELLED");
  return active.length ? active[active.length - 1] : null;
}

export function createInspection(
  user: User,
  milestoneId: string,
  input: {
    scheduledAt?: string | null;
    inspectionType?: string | null;
    jurisdiction?: string | null;
    issuingAuthority?: string | null;
    inspectionReference?: string | null;
    permitId?: string | null;
    notes?: string | null;
  }
): JurisdictionalInspection {
  const { project } = assertAccess(user, milestoneId);
  if (user.role === "FIELD") {
    throw new GateError("Scheduling inspections requires a project manager or lender-side reviewer", 403);
  }
  const req = repo.getInspectionRequirement(milestoneId);
  const now = new Date().toISOString();
  const inspection: JurisdictionalInspection = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    milestoneId,
    permitId: input.permitId?.trim() || null,
    inspectionType: input.inspectionType?.trim() || req?.inspectionType || null,
    jurisdiction: input.jurisdiction?.trim() || req?.jurisdiction || null,
    issuingAuthority: input.issuingAuthority?.trim() || req?.issuingAuthority || null,
    inspectionReference: input.inspectionReference?.trim() || null,
    required: (req?.requirement ?? "UNKNOWN") === "REQUIRED",
    status: input.scheduledAt ? "SCHEDULED" : "REQUIRED_UNSCHEDULED",
    scheduledAt: input.scheduledAt ?? null,
    completedAt: null,
    resultRecordedAt: null,
    result: null,
    governmentInspectorName: null,
    reviewedByUserId: null,
    supportingDocumentId: null,
    notes: input.notes?.trim() || null,
    createdAt: now,
    updatedAt: now,
  };
  repo.insertInspection(inspection);
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: input.scheduledAt ? "INSPECTION_SCHEDULED" : "INSPECTION_CREATED",
    entityType: "INSPECTION",
    entityId: inspection.id,
    reason: null,
    beforeSummary: null,
    afterSummary: `${inspection.inspectionType ?? "inspection"}${input.scheduledAt ? ` scheduled ${input.scheduledAt}` : " (unscheduled)"}`,
  });
  return inspection;
}

function getInspectionFor(user: User, inspectionId: string): JurisdictionalInspection {
  const inspection = repo.getInspection(inspectionId);
  if (!inspection) throw new GateError("Inspection not found", 404);
  assertAccess(user, inspection.milestoneId);
  return inspection;
}

export function scheduleInspection(user: User, id: string, scheduledAt: string): JurisdictionalInspection {
  const inspection = getInspectionFor(user, id);
  if (user.role === "FIELD") throw new GateError("Not authorized to schedule inspections", 403);
  if (["PASSED", "FAILED", "CANCELLED"].includes(inspection.status)) {
    throw new GateError(`Inspection is ${inspection.status} — scheduling is closed`, 409);
  }
  if (!scheduledAt || !Number.isFinite(Date.parse(scheduledAt))) {
    throw new GateError("scheduledAt must be a valid timestamp");
  }
  repo.updateInspection(id, { status: "SCHEDULED", scheduledAt });
  audit({
    projectId: inspection.projectId, actorUserId: user.id, action: "INSPECTION_SCHEDULED",
    entityType: "INSPECTION", entityId: id, reason: null,
    beforeSummary: inspection.status, afterSummary: `SCHEDULED ${scheduledAt}`,
  });
  return repo.getInspection(id)!;
}

export function markInspectionCompleted(user: User, id: string, completedAt?: string | null): JurisdictionalInspection {
  const inspection = getInspectionFor(user, id);
  if (user.role === "FIELD") throw new GateError("Not authorized to update inspections", 403);
  if (!["SCHEDULED", "REQUIRED_UNSCHEDULED"].includes(inspection.status)) {
    throw new GateError(`Inspection is ${inspection.status} — cannot mark completed`, 409);
  }
  const at = completedAt ?? new Date().toISOString();
  repo.updateInspection(id, { status: "COMPLETED_PENDING_RESULT", completedAt: at });
  audit({
    projectId: inspection.projectId, actorUserId: user.id, action: "INSPECTION_COMPLETED",
    entityType: "INSPECTION", entityId: id, reason: null,
    beforeSummary: inspection.status,
    afterSummary: "COMPLETED_PENDING_RESULT — no result until formally recorded",
  });
  return repo.getInspection(id)!;
}

/** Formal reviewed result. The government inspector is recorded as text
 *  identity (never an OBV user account); the attributable OBV reviewer
 *  is the authenticated caller. Uploading a document NEVER reaches here
 *  on its own. */
export function recordInspectionResult(
  user: User,
  id: string,
  input: {
    result: "PASSED" | "FAILED";
    governmentInspectorName?: string | null;
    inspectionReference?: string | null;
    supportingDocumentId?: string | null;
    notes?: string | null;
  }
): JurisdictionalInspection {
  const inspection = getInspectionFor(user, id);
  if (!DETERMINATION_ROLES.has(user.role)) {
    throw new GateError("Recording an inspection result requires a funder representative or compliance reviewer", 403);
  }
  if (!["PASSED", "FAILED"].includes(input.result)) {
    throw new GateError("result must be PASSED or FAILED");
  }
  if (["CANCELLED"].includes(inspection.status)) {
    throw new GateError("Inspection is CANCELLED — record a new inspection instead", 409);
  }
  const req = repo.getInspectionRequirement(inspection.milestoneId);
  if (input.result === "PASSED" && req?.resultDocumentRequired && !input.supportingDocumentId?.trim()) {
    throw new GateError(
      "This milestone's configuration requires a result document reference to record a PASSED inspection"
    );
  }
  const now = new Date().toISOString();
  repo.updateInspection(id, {
    status: input.result,
    result: input.result,
    resultRecordedAt: now,
    completedAt: inspection.completedAt ?? now,
    governmentInspectorName: input.governmentInspectorName?.trim() || null,
    inspectionReference: input.inspectionReference?.trim() || inspection.inspectionReference,
    reviewedByUserId: user.id,
    supportingDocumentId: input.supportingDocumentId?.trim() || null,
    notes: input.notes?.trim() || inspection.notes,
  });
  audit({
    projectId: inspection.projectId, actorUserId: user.id,
    action: "INSPECTION_RESULT_RECORDED", entityType: "INSPECTION", entityId: id,
    reason: input.notes?.trim() || null,
    beforeSummary: inspection.status,
    afterSummary: `${input.result}${input.governmentInspectorName ? ` — government inspector: ${input.governmentInspectorName}` : ""} (recorded by ${user.name})`,
  });
  return repo.getInspection(id)!;
}

export function cancelInspection(user: User, id: string, reason?: string | null): JurisdictionalInspection {
  const inspection = getInspectionFor(user, id);
  if (user.role === "FIELD") throw new GateError("Not authorized to cancel inspections", 403);
  if (["PASSED", "FAILED"].includes(inspection.status)) {
    throw new GateError(`Inspection already has a recorded result (${inspection.status})`, 409);
  }
  repo.updateInspection(id, { status: "CANCELLED", notes: reason?.trim() || inspection.notes });
  audit({
    projectId: inspection.projectId, actorUserId: user.id, action: "INSPECTION_CANCELLED",
    entityType: "INSPECTION", entityId: id, reason: reason?.trim() || null,
    beforeSummary: inspection.status, afterSummary: "CANCELLED",
  });
  return repo.getInspection(id)!;
}

// ============================== derived milestone-level inspection gate

export function inspectionGateState(milestoneId: string): InspectionGateState {
  const value = requirementValue(milestoneId);
  if (value === "UNKNOWN") return "REQUIREMENT_UNKNOWN";
  if (value === "NOT_REQUIRED") return "NOT_APPLICABLE";
  const inspection = activeInspection(milestoneId);
  if (!inspection) return "REQUIRED_UNSCHEDULED";
  switch (inspection.status) {
    case "SCHEDULED":
      return "SCHEDULED";
    case "COMPLETED_PENDING_RESULT":
      return "COMPLETED_PENDING_RESULT";
    case "PASSED":
      return "PASSED";
    case "FAILED":
      return "FAILED";
    case "EXPIRED":
      return "EXPIRED";
    default:
      return "REQUIRED_UNSCHEDULED";
  }
}

// ================================== gate 6: draw eligibility (derived)

function isFinalMilestone(m: Milestone): boolean {
  const all = repo.listMilestones(m.projectId).filter((x) => !x.archived);
  return all.length > 0 && all[all.length - 1].id === m.id;
}

/** Whether the REQUIRED inspection gates this milestone at the given
 *  stage, honouring finalCompletionOnly. */
function inspectionGates(m: Milestone, req: InspectionRequirement | null, stage: "DRAW_REVIEW" | "GOVERNANCE"): boolean {
  if (!req || req.requirement !== "REQUIRED") return false;
  if (req.finalCompletionOnly && !isFinalMilestone(m)) return false;
  return stage === "DRAW_REVIEW" ? req.mustPassBeforeDrawReview : req.mustPassBeforeGovernance;
}

const UNRESOLVED_EXC = new Set(["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"]);

/** Deterministic MilestoneDrawEligibility. NEVER releases funds — it is
 *  a derived reading of authoritative gates with structured reasons. */
export function evaluateDrawEligibility(milestoneId: string): MilestoneDrawEligibility {
  const milestone = repo.getMilestone(milestoneId);
  if (!milestone) throw new GateError("Milestone not found", 404);
  const computedAt = new Date().toISOString();
  if (milestone.accountStatus === "RELEASED") {
    return {
      milestoneId,
      result: "RELEASED",
      reasons: [
        {
          code: "TRANCHE_RELEASED",
          detail: "The tranche was released by completed formal governance (exactly once).",
          blocking: false,
        },
      ],
      computedAt,
    };
  }
  const reasons: GateReason[] = [];
  const add = (code: string, detail: string, blocking: boolean) => reasons.push({ code, detail, blocking });

  // Gate 1 — contractor representation.
  const contractor = milestone.contractorCompletionStatus ?? "NOT_REPORTED";
  if (contractor !== "REPORTED_COMPLETE") {
    add(
      "CONTRACTOR_COMPLETION_NOT_REPORTED",
      "The contractor has not reported this milestone's work complete.",
      false
    );
  }

  // Gate 2 — OBV evidence review (derived from the governed pipeline).
  const evidence = evidenceReviewStatus(milestoneId);
  if (evidence.status === "NOT_SUBMITTED") {
    add("EVIDENCE_NOT_SUBMITTED", "No evidence has been submitted through the governed capture pipeline.", false);
  } else if (evidence.status === "SUBMITTED" || evidence.status === "UNDER_REVIEW") {
    add("EVIDENCE_UNDER_REVIEW", "Submitted evidence has not completed OBV verification.", false);
  } else if (evidence.status === "NEEDS_REVIEW") {
    add("EVIDENCE_NEEDS_REVIEW", "The latest evidence is flagged NEEDS REVIEW — a human reviewer decision is required.", false);
  } else if (evidence.status === "REJECTED") {
    add("EVIDENCE_REJECTED", "The latest evidence was REJECTED by verification — acceptable evidence must be recorded.", true);
  }

  // Gates 3–5 — jurisdictional inspection.
  const req = repo.getInspectionRequirement(milestoneId);
  const gate = inspectionGateState(milestoneId);
  const governanceGated = inspectionGates(milestone, req, "GOVERNANCE");
  const drawReviewGated = inspectionGates(milestone, req, "DRAW_REVIEW");
  if (gate === "REQUIREMENT_UNKNOWN") {
    add(
      "INSPECTION_REQUIREMENT_UNKNOWN",
      "Whether a jurisdictional inspection is required has not been determined — UNKNOWN never behaves as NOT REQUIRED.",
      false
    );
  } else if (req?.requirement === "REQUIRED" && (governanceGated || drawReviewGated)) {
    if (gate === "REQUIRED_UNSCHEDULED") {
      add("INSPECTION_NOT_SCHEDULED", `Required ${req.inspectionType ?? "jurisdictional"} inspection has not been scheduled.`, governanceGated);
      add("JURISDICTIONAL_INSPECTION_NOT_PASSED", "Required jurisdictional inspection has not passed.", governanceGated);
    } else if (gate === "SCHEDULED" || gate === "COMPLETED_PENDING_RESULT") {
      add("INSPECTION_PENDING", `Required ${req.inspectionType ?? "jurisdictional"} inspection has no recorded result yet.`, governanceGated);
      add("JURISDICTIONAL_INSPECTION_NOT_PASSED", "Required jurisdictional inspection has not passed.", governanceGated);
    } else if (gate === "FAILED") {
      add("INSPECTION_FAILED", `Required ${req.inspectionType ?? "jurisdictional"} inspection FAILED — reinspection required.`, true);
    } else if (gate === "EXPIRED") {
      add("INSPECTION_EXPIRED", "The inspection or its permit has expired.", true);
    } else if (gate === "PASSED") {
      const inspection = activeInspection(milestoneId);
      if (req.resultDocumentRequired && !inspection?.supportingDocumentId) {
        add("REQUIRED_DOCUMENT_MISSING", "The configured inspection result document reference is missing.", true);
      }
    }
  }

  // Blocking exceptions linked to this milestone.
  const highExc = repo
    .listExceptionsForProject(milestone.projectId)
    .filter(
      (e) =>
        e.milestoneId === milestoneId &&
        UNRESOLVED_EXC.has(e.status) &&
        ["HIGH", "CRITICAL"].includes(e.severity)
    );
  for (const e of highExc) {
    add("HIGH_SEVERITY_EXCEPTION_OPEN", `${e.severity} exception open: "${e.title}".`, true);
  }

  // Applicable change orders must be approved.
  for (const co of repo.listChangeOrdersForProject(milestone.projectId)) {
    if (
      co.affectedMilestoneIds.includes(milestoneId) &&
      ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED"].includes(co.status)
    ) {
      add("CHANGE_ORDER_NOT_APPROVED", `Change order CO-${co.changeOrderNumber} affecting this milestone is ${co.status.replace(/_/g, " ")}.`, false);
    }
  }

  // Formal governance state (never skipped, never implied).
  const approval = repo.getApprovalRequestForMilestone(milestoneId);
  if (approval?.status === "PENDING") {
    add(
      "FORMAL_APPROVAL_PENDING",
      "All decisions of the formal approval matrix have not been recorded — eligibility never releases funds.",
      false
    );
  }

  // ---- deterministic result ladder ----
  let result: MilestoneDrawEligibility["result"];
  if (reasons.some((r) => r.blocking)) {
    result = "BLOCKED";
  } else if (
    contractor === "REPORTED_COMPLETE" &&
    evidence.status === "VERIFIED" &&
    (gate === "NOT_APPLICABLE" || gate === "PASSED" || !governanceGated) &&
    gate !== "REQUIREMENT_UNKNOWN" &&
    !reasons.some((r) => r.code === "CHANGE_ORDER_NOT_APPROVED")
  ) {
    result = "READY_FOR_GOVERNANCE";
    if (!reasons.some((r) => r.code === "FORMAL_APPROVAL_PENDING")) {
      add(
        "PRE_GOVERNANCE_GATES_SATISFIED",
        "All configured pre-governance gates are satisfied. This is NOT an approval and NOT a release.",
        false
      );
    }
  } else if (
    evidence.status === "VERIFIED" &&
    gate !== "REQUIREMENT_UNKNOWN" &&
    (gate === "NOT_APPLICABLE" || gate === "PASSED" || !drawReviewGated)
  ) {
    result = "ELIGIBLE_FOR_DRAW_REVIEW";
  } else {
    result = "NOT_ELIGIBLE";
  }
  return { milestoneId, result, reasons, computedAt };
}

// ============================================ the six-gate assembly

export function milestoneGates(milestoneId: string): MilestoneGates {
  const milestone = repo.getMilestone(milestoneId);
  if (!milestone) throw new GateError("Milestone not found", 404);
  return {
    milestoneId,
    contractor: {
      status: milestone.contractorCompletionStatus ?? "NOT_REPORTED",
      reportedByUserId: milestone.contractorReportedByUserId ?? null,
      reportedAt: milestone.contractorReportedAt ?? null,
      notes: milestone.contractorCompletionNotes ?? null,
      linkedEvidenceIds: milestone.contractorLinkedEvidenceIds ?? [],
    },
    evidenceReview: evidenceReviewStatus(milestoneId),
    requirement: repo.getInspectionRequirement(milestoneId),
    requirementValue: requirementValue(milestoneId),
    inspection: activeInspection(milestoneId),
    inspectionGate: inspectionGateState(milestoneId),
    eligibility: evaluateDrawEligibility(milestoneId),
  };
}

export function gatesForUser(user: User, milestoneId: string): MilestoneGates {
  assertAccess(user, milestoneId);
  return milestoneGates(milestoneId);
}

/** Compact one-line gate summary with PRECISE language — never the bare
 *  word COMPLETE. Used by reports and registers. */
export function gateSummaryLabel(gates: MilestoneGates): string {
  const parts = [
    `contractor: ${gates.contractor.status.replace(/_/g, " ")}`,
    `evidence: ${gates.evidenceReview.status.replace(/_/g, " ")}`,
    `inspection requirement: ${gates.requirementValue.replace(/_/g, " ")}`,
    `inspection: ${gates.inspectionGate.replace(/_/g, " ")}`,
    `draw eligibility: ${gates.eligibility.result.replace(/_/g, " ")}`,
  ];
  return parts.join(" · ");
}
