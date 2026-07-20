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
import { capabilityGate } from "./lenderAccess";
import { effectiveStatus as permitEffectiveStatus, completeSourcesForInspection } from "./permits";
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
  // Legacy-compatibility rule: with no active memberships the role check
  // above is authoritative; once memberships exist on the project,
  // REPORT_CONTRACTOR_COMPLETION is required in addition.
  try {
    capabilityGate(user, project.id, "REPORT_CONTRACTOR_COMPLETION");
  } catch (err) {
    throw new GateError((err as Error).message, 403);
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
    permitRequired?: boolean;
    requiredPermitType?: string | null;
    officialSourceRequired?: boolean;
    codeBasisRequired?: boolean;
    permitMustBeActiveBeforeDrawReview?: boolean;
    permitMustBeActiveBeforeGovernance?: boolean;
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
    // Conservative defaults: new permit/code-basis/official-source gates
    // are off unless explicitly configured; legacy behavior is unchanged.
    permitRequired: input.permitRequired ?? existing?.permitRequired ?? false,
    requiredPermitType: input.requiredPermitType?.trim() || existing?.requiredPermitType || null,
    officialSourceRequired: input.officialSourceRequired ?? existing?.officialSourceRequired ?? false,
    codeBasisRequired: input.codeBasisRequired ?? existing?.codeBasisRequired ?? false,
    permitMustBeActiveBeforeDrawReview:
      input.permitMustBeActiveBeforeDrawReview ?? existing?.permitMustBeActiveBeforeDrawReview ?? false,
    permitMustBeActiveBeforeGovernance:
      input.permitMustBeActiveBeforeGovernance ?? existing?.permitMustBeActiveBeforeGovernance ?? false,
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

/** Head of the inspection chain: latest record that is neither cancelled
 *  nor superseded by a reinspection. Prior FAILED / CORRECTIONS_REQUIRED
 *  records stay immutable in history — the chain only moves forward. */
function activeInspection(milestoneId: string): JurisdictionalInspection | null {
  const all = repo.listInspectionsForMilestone(milestoneId);
  const active = all.filter((i) => i.status !== "CANCELLED" && i.supersededByInspectionId === null);
  return active.length ? active[active.length - 1] : null;
}

export { activeInspection as activeInspectionForMilestone };

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
    permitRefId?: string | null;
    notes?: string | null;
  }
): JurisdictionalInspection {
  const { project } = assertAccess(user, milestoneId);
  if (user.role === "FIELD") {
    throw new GateError("Scheduling inspections requires a project manager or lender-side reviewer", 403);
  }
  // First-class permit link: must belong to the same project. Defaults for
  // jurisdiction/authority may be taken from the permit for convenience,
  // but the stored inspection values stay historically stable afterwards.
  let permitRef = null as ReturnType<typeof repo.getPermit>;
  if (input.permitRefId?.trim()) {
    permitRef = repo.getPermit(input.permitRefId.trim());
    if (!permitRef || permitRef.projectId !== project.id) {
      throw new GateError("Permit not found", 404);
    }
  }
  const req = repo.getInspectionRequirement(milestoneId);
  const now = new Date().toISOString();
  const inspection: JurisdictionalInspection = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    milestoneId,
    permitId: input.permitId?.trim() || null,
    permitRefId: permitRef?.id ?? null,
    inspectionType: input.inspectionType?.trim() || req?.inspectionType || null,
    jurisdiction: input.jurisdiction?.trim() || permitRef?.jurisdiction || req?.jurisdiction || null,
    issuingAuthority: input.issuingAuthority?.trim() || permitRef?.issuingAuthority || req?.issuingAuthority || null,
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
    reinspectionOfInspectionId: null,
    supersededByInspectionId: null,
    correctionNoticeReference: null,
    correctionSummary: null,
    correctionDueAt: null,
    correctionClearedAt: null,
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
  if (inspection.result !== null) {
    throw new GateError(
      `Inspection already has a recorded result (${inspection.result}) — the record is historically terminal; create a reinspection instead`,
      409
    );
  }
  if (inspection.status === "CANCELLED" || inspection.supersededByInspectionId) {
    throw new GateError(`Inspection is ${inspection.status === "CANCELLED" ? "CANCELLED" : "superseded"} — scheduling is closed`, 409);
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
  if (inspection.result !== null) {
    throw new GateError(
      `Inspection already has a recorded result (${inspection.result}) — the record is historically terminal`,
      409
    );
  }
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
    result: "PASSED" | "FAILED" | "CORRECTIONS_REQUIRED";
    governmentInspectorName?: string | null;
    inspectionReference?: string | null;
    supportingDocumentId?: string | null;
    correctionNoticeReference?: string | null;
    correctionSummary?: string | null;
    correctionDueAt?: string | null;
    notes?: string | null;
  }
): JurisdictionalInspection {
  const inspection = getInspectionFor(user, id);
  if (!DETERMINATION_ROLES.has(user.role)) {
    throw new GateError("Recording an inspection result requires a funder representative or compliance reviewer", 403);
  }
  if (!["PASSED", "FAILED", "CORRECTIONS_REQUIRED"].includes(input.result)) {
    throw new GateError("result must be PASSED, FAILED or CORRECTIONS_REQUIRED");
  }
  if (["CANCELLED"].includes(inspection.status)) {
    throw new GateError("Inspection is CANCELLED — record a new inspection instead", 409);
  }
  // Historical results are immutable: a recorded result is never silently
  // overwritten, and a superseded record belongs to history.
  if (inspection.result !== null) {
    throw new GateError(
      `This inspection already has a recorded result (${inspection.result}) — record a reinspection instead of overwriting history`,
      409
    );
  }
  if (inspection.supersededByInspectionId) {
    throw new GateError("This inspection was superseded by a reinspection — its record is historical", 409);
  }
  const req = repo.getInspectionRequirement(inspection.milestoneId);
  if (input.result === "PASSED" && req?.resultDocumentRequired && !input.supportingDocumentId?.trim()) {
    throw new GateError(
      "This milestone's configuration requires a result document reference to record a PASSED inspection"
    );
  }
  // Official-source requirement is distinct from the result-document
  // requirement: a PASSED result needs an existing OfficialSourceRecord
  // for this inspection when configured. A URL or upload alone never
  // becomes PASSED — this is the reviewed recording act.
  if (
    input.result === "PASSED" &&
    req?.officialSourceRequired &&
    completeSourcesForInspection(id).length === 0
  ) {
    throw new GateError(
      "This milestone's configuration requires a COMPLETE official source record (meaningful provenance basis) before a PASSED result can be recorded"
    );
  }
  if (input.result === "CORRECTIONS_REQUIRED" && !(input.correctionSummary ?? "").trim()) {
    throw new GateError("correctionSummary is required when recording CORRECTIONS_REQUIRED");
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
    correctionNoticeReference: input.correctionNoticeReference?.trim() || null,
    correctionSummary: input.correctionSummary?.trim() || null,
    correctionDueAt: input.correctionDueAt?.trim() || null,
    notes: input.notes?.trim() || inspection.notes,
  });
  // A PASSED reinspection is the event that clears the prior record's
  // corrections state (correctionClearedAt) — an audited derivation,
  // never a rewrite of the prior's recorded result.
  if (input.result === "PASSED" && inspection.reinspectionOfInspectionId) {
    // Walk the whole chain backwards: a PASSED reinspection clears the
    // corrections state of every CORRECTIONS_REQUIRED ancestor (a failed
    // intermediate reinspection cleared nothing). Bounded walk — the
    // partial unique index makes chains linear and acyclic.
    let ancestorId: string | null = inspection.reinspectionOfInspectionId;
    const walked = new Set<string>();
    while (ancestorId && !walked.has(ancestorId)) {
      walked.add(ancestorId);
      const ancestor = repo.getInspection(ancestorId);
      if (!ancestor) break;
      if (ancestor.status === "CORRECTIONS_REQUIRED" && ancestor.correctionClearedAt === null) {
        repo.updateInspection(ancestor.id, { correctionClearedAt: now });
        audit({
          projectId: inspection.projectId, actorUserId: user.id,
          action: "CORRECTIONS_CLEARED", entityType: "INSPECTION", entityId: ancestor.id,
          reason: null,
          beforeSummary: "correctionClearedAt=null",
          afterSummary: `cleared by PASSED reinspection ${id} (recorded result ${ancestor.result} preserved)`,
        });
      }
      ancestorId = ancestor.reinspectionOfInspectionId;
    }
  }
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
  if (inspection.result !== null) {
    throw new GateError(
      `Inspection already has a recorded result (${inspection.result}) — recorded results are historically terminal and cannot be cancelled`,
      409
    );
  }
  repo.updateInspection(id, { status: "CANCELLED", notes: reason?.trim() || inspection.notes });
  audit({
    projectId: inspection.projectId, actorUserId: user.id, action: "INSPECTION_CANCELLED",
    entityType: "INSPECTION", entityId: id, reason: reason?.trim() || null,
    beforeSummary: inspection.status, afterSummary: "CANCELLED",
  });
  return repo.getInspection(id)!;
}

/**
 * Create a reinspection following a FAILED or CORRECTIONS_REQUIRED
 * inspection. The prior record is preserved verbatim — its result is
 * immutable; only the forward link (supersededByInspectionId) is set,
 * as an audited administrative chain link. One failed inspection may be
 * followed by one or more reinspections over time (each following the
 * then-current head); circular or cross-milestone chains are rejected.
 */
export function createReinspection(
  user: User,
  priorInspectionId: string,
  input: { scheduledAt?: string | null; notes?: string | null } = {}
): JurisdictionalInspection {
  const prior = getInspectionFor(user, priorInspectionId);
  if (user.role === "FIELD") {
    throw new GateError("Scheduling reinspections requires a project manager or lender-side reviewer", 403);
  }
  if (!["FAILED", "CORRECTIONS_REQUIRED"].includes(prior.status)) {
    throw new GateError(
      `A reinspection follows a FAILED or CORRECTIONS_REQUIRED inspection — this record is ${prior.status}`,
      409
    );
  }
  if (prior.supersededByInspectionId) {
    throw new GateError("This inspection already has a reinspection — follow the active chain head", 409);
  }
  const { project } = assertAccess(user, prior.milestoneId);
  const now = new Date().toISOString();
  const reinspection: JurisdictionalInspection = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    milestoneId: prior.milestoneId,
    permitId: prior.permitId,
    permitRefId: prior.permitRefId,
    inspectionType: prior.inspectionType,
    jurisdiction: prior.jurisdiction,
    issuingAuthority: prior.issuingAuthority,
    inspectionReference: null,
    required: prior.required,
    status: input.scheduledAt ? "SCHEDULED" : "REQUIRED_UNSCHEDULED",
    scheduledAt: input.scheduledAt ?? null,
    completedAt: null,
    resultRecordedAt: null,
    result: null,
    governmentInspectorName: null,
    reviewedByUserId: null,
    supportingDocumentId: null,
    reinspectionOfInspectionId: prior.id,
    supersededByInspectionId: null,
    correctionNoticeReference: null,
    correctionSummary: null,
    correctionDueAt: null,
    correctionClearedAt: null,
    notes: input.notes?.trim() || null,
    createdAt: now,
    updatedAt: now,
  };
  // Transactional: insert the reinspection and set the prior's forward
  // link atomically (one direct child per prior enforced by a partial
  // unique index — concurrent duplicates get one success, one conflict).
  // correctionClearedAt stays null until a linked reinspection actually
  // records PASSED — creating or scheduling a reinspection clears nothing.
  try {
    repo.createReinspectionTx(reinspection, prior.id);
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      throw new GateError("This inspection already has a reinspection — follow the active chain head", 409);
    }
    throw e;
  }
  audit({
    projectId: project.id, actorUserId: user.id, action: "REINSPECTION_CREATED",
    entityType: "INSPECTION", entityId: reinspection.id, reason: input.notes?.trim() || null,
    beforeSummary: `${prior.id} ${prior.status}`,
    afterSummary: `reinspection of ${prior.id}${input.scheduledAt ? ` scheduled ${input.scheduledAt}` : " (unscheduled)"} — prior result preserved`,
  });
  return reinspection;
}

/**
 * Narrow administrative correction of an inspection record's metadata
 * (inspector name, reference, notes). NEVER the result, never the chain,
 * never financial state. Requires an authorized role and a reason;
 * preserves before/after in the audit trail.
 */
export function correctInspectionRecord(
  user: User,
  id: string,
  input: {
    reason: string;
    governmentInspectorName?: string | null;
    inspectionReference?: string | null;
    notes?: string | null;
  }
): JurisdictionalInspection {
  const inspection = getInspectionFor(user, id);
  if (!DETERMINATION_ROLES.has(user.role)) {
    throw new GateError("Administrative corrections require a funder representative or compliance reviewer", 403);
  }
  const reason = (input.reason ?? "").trim();
  if (!reason) throw new GateError("A reason is required for an administrative correction");
  const before = `inspector=${inspection.governmentInspectorName ?? "—"} ref=${inspection.inspectionReference ?? "—"}`;
  repo.updateInspection(id, {
    governmentInspectorName:
      input.governmentInspectorName !== undefined
        ? input.governmentInspectorName?.trim() || null
        : inspection.governmentInspectorName,
    inspectionReference:
      input.inspectionReference !== undefined
        ? input.inspectionReference?.trim() || null
        : inspection.inspectionReference,
    notes: input.notes !== undefined ? input.notes?.trim() || null : inspection.notes,
  });
  const after = repo.getInspection(id)!;
  audit({
    projectId: inspection.projectId, actorUserId: user.id,
    action: "INSPECTION_ADMIN_CORRECTION", entityType: "INSPECTION", entityId: id,
    reason,
    beforeSummary: before,
    afterSummary: `inspector=${after.governmentInspectorName ?? "—"} ref=${after.inspectionReference ?? "—"} (result untouched: ${after.result ?? "none"})`,
  });
  return after;
}

// ============================== derived milestone-level inspection gate

export function inspectionGateState(milestoneId: string): InspectionGateState {
  const value = requirementValue(milestoneId);
  if (value === "UNKNOWN") return "REQUIREMENT_UNKNOWN";
  if (value === "NOT_REQUIRED") return "NOT_APPLICABLE";
  const inspection = activeInspection(milestoneId);
  if (!inspection) return "REQUIRED_UNSCHEDULED";
  const isReinspection = inspection.reinspectionOfInspectionId !== null;
  switch (inspection.status) {
    case "SCHEDULED":
      return "SCHEDULED";
    case "COMPLETED_PENDING_RESULT":
      return "COMPLETED_PENDING_RESULT";
    case "PASSED":
      return "PASSED";
    case "FAILED":
      return "FAILED";
    case "CORRECTIONS_REQUIRED":
      return "CORRECTIONS_REQUIRED";
    case "EXPIRED":
      return "EXPIRED";
    default:
      // An unscheduled reinspection means the milestone is explicitly
      // awaiting reinspection after a failed/corrections-required result.
      return isReinspection ? "AWAITING_REINSPECTION" : "REQUIRED_UNSCHEDULED";
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
      permitBlocksDrawReview: false,
      permitBlocksGovernance: false,
      codeBasisBlocksDrawReview: false,
      codeBasisBlocksGovernance: false,
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

  // ---- permit and code-basis readiness (only permits LINKED to this
  // milestone are relevant — an unrelated project permit never blocks).
  // Conservative: gates apply only where the requirement configuration
  // turned them on, so legacy behavior is bit-for-bit unchanged. ----
  const linkedPermits = repo
    .listPermitLinksForMilestone(milestoneId)
    .map((l) => repo.getPermit(l.permitId))
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .filter((x) => !req?.requiredPermitType || x.permitType === req.requiredPermitType);
  // Permit issues are collected once; each configured stage then gates
  // explicitly. A draw-review-only rule blocks ELIGIBLE_FOR_DRAW_REVIEW;
  // a governance rule is a hard blocker. Neither flag set → the issue is
  // recorded as a non-gating condition. Legacy defaults (all flags off)
  // are bit-for-bit unchanged.
  const permitIssues: Array<{ code: string; detail: string }> = [];
  if (req?.permitRequired) {
    if (linkedPermits.length === 0) {
      permitIssues.push({
        code: "REQUIRED_PERMIT_MISSING",
        detail: `A ${req.requiredPermitType ? `${req.requiredPermitType} ` : ""}permit is required for this milestone but no permit record is linked.`,
      });
    } else {
      for (const permit of linkedPermits) {
        const effective = permitEffectiveStatus(permit);
        if (effective === "EXPIRED") {
          permitIssues.push({ code: "PERMIT_EXPIRED", detail: `Linked permit ${permit.permitNumber} is expired.` });
        } else if (effective === "REVOKED") {
          permitIssues.push({ code: "PERMIT_REVOKED", detail: `Linked permit ${permit.permitNumber} has been revoked.` });
        } else if (effective === "SUSPENDED") {
          permitIssues.push({ code: "PERMIT_SUSPENDED", detail: `Linked permit ${permit.permitNumber} is suspended.` });
        } else if (effective !== "ISSUED" && effective !== "ACTIVE") {
          // UNKNOWN / DRAFT / APPLIED / CLOSED never behave as ACTIVE.
          permitIssues.push({
            code: "PERMIT_NOT_ACTIVE",
            detail: `Linked permit ${permit.permitNumber} is ${effective} — not an active permit.`,
          });
        }
      }
    }
  }
  const permitBlocksDrawReview = permitIssues.length > 0 && Boolean(req?.permitMustBeActiveBeforeDrawReview);
  const permitBlocksGovernance = permitIssues.length > 0 && Boolean(req?.permitMustBeActiveBeforeGovernance);
  const permitStage =
    permitBlocksDrawReview && permitBlocksGovernance
      ? " Blocks: draw review and governance."
      : permitBlocksGovernance
        ? " Blocks: governance."
        : permitBlocksDrawReview
          ? " Blocks: draw review."
          : " Recorded as a non-gating permit condition.";
  for (const issue of permitIssues) {
    add(issue.code, issue.detail + permitStage, permitBlocksGovernance);
  }

  // Code basis gates governance where configured (codeBasisRequired is a
  // before-governance control; no draw-review flag exists for it in this
  // build, so codeBasisBlocksDrawReview is always false — documented).
  const codeBasisProblem = Boolean(
    req?.codeBasisRequired &&
      (linkedPermits.length === 0 || !linkedPermits.some((x) => x.applicableCodeEdition && x.codeBasis))
  );
  const codeBasisBlocksDrawReview = false;
  const codeBasisBlocksGovernance = codeBasisProblem;
  if (codeBasisProblem) {
    add(
      "CODE_BASIS_MISSING",
      "The applicable code basis has not been recorded for this milestone's linked permit(s). OBV records the reviewed governing basis — it does not independently determine legal compliance. Blocks: governance.",
      true
    );
  }
  if (
    req?.officialSourceRequired &&
    gate === "PASSED"
  ) {
    const head = activeInspection(milestoneId);
    if (head && completeSourcesForInspection(head.id).length === 0) {
      add(
        "OFFICIAL_SOURCE_MISSING",
        "A PASSED result is recorded but no COMPLETE official source record supports it.",
        true
      );
    }
  }

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
      const head = activeInspection(milestoneId);
      if (head?.reinspectionOfInspectionId) {
        add("REINSPECTION_PENDING", "The reinspection has no recorded result yet.", governanceGated);
      }
      add("INSPECTION_PENDING", `Required ${req.inspectionType ?? "jurisdictional"} inspection has no recorded result yet.`, governanceGated);
      add("JURISDICTIONAL_INSPECTION_NOT_PASSED", "Required jurisdictional inspection has not passed.", governanceGated);
    } else if (gate === "FAILED") {
      const head = activeInspection(milestoneId);
      if (head?.reinspectionOfInspectionId) {
        add("REINSPECTION_FAILED", `The reinspection FAILED — the milestone remains blocked until a passing reviewed result is recorded.`, true);
      } else {
        add("INSPECTION_FAILED", `Required ${req.inspectionType ?? "jurisdictional"} inspection FAILED — reinspection required.`, true);
        add("REINSPECTION_REQUIRED", "A reinspection must be scheduled and pass before this gate clears.", true);
      }
    } else if (gate === "CORRECTIONS_REQUIRED") {
      add("INSPECTION_CORRECTIONS_REQUIRED", "The jurisdictional inspection recorded CORRECTIONS REQUIRED — corrections and a reinspection are needed. An uploaded correction notice does not itself clear corrections.", true);
      add("REINSPECTION_REQUIRED", "A reinspection must be scheduled and pass before this gate clears.", true);
    } else if (gate === "AWAITING_REINSPECTION") {
      add("REINSPECTION_NOT_SCHEDULED", "The reinspection following the prior result has not been scheduled.", true);
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
    !permitBlocksGovernance &&
    !codeBasisBlocksGovernance &&
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
    (gate === "NOT_APPLICABLE" || gate === "PASSED" || !drawReviewGated) &&
    !permitBlocksDrawReview &&
    !codeBasisBlocksDrawReview
  ) {
    result = "ELIGIBLE_FOR_DRAW_REVIEW";
  } else {
    result = "NOT_ELIGIBLE";
  }
  return {
    milestoneId,
    result,
    reasons,
    permitBlocksDrawReview,
    permitBlocksGovernance,
    codeBasisBlocksDrawReview,
    codeBasisBlocksGovernance,
    computedAt,
  };
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
