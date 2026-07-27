/**
 * DMV Draw Control Record + Governing Code and Permit Basis service.
 *
 * OBV records construction compliance evidence, source lookups, inspection
 * status, verification results, and lender-review eligibility. OBV does not
 * issue permits, perform government inspections, provide legal
 * interpretations, approve loans, or automatically authorize payment.
 *
 * Control doctrine for this module:
 *  - A permit's Governing Code and Permit Basis is an immutable, versioned
 *    record. Once AUTHORITATIVE its content never changes; corrections
 *    insert a NEW version that supersedes it. Changing a project's current
 *    compliance settings (jurisdiction profile, permit-row code basis)
 *    never rewrites a prior authoritative basis version.
 *  - Transition-rule applicability is a HUMAN determination — never
 *    inferred from the current date alone.
 *  - An OBV field/reviewer finding and an official jurisdiction inspection
 *    result are separate records; neither substitutes for the other.
 *  - Line eligibility means "eligible for LENDER REVIEW". It is never a
 *    lender approval, a payment authorization, or a release. Nothing in
 *    this module reaches the VirtualAccountService or any banking table.
 */
import * as repo from "../db/repo";
import * as dmv from "../db/dmvRepo";
import * as lrepo from "../db/lenderRepo";
import { audit } from "./pilot/onboarding";
import { canAccessProjectFinance } from "./budgetProgress";
import { parseIsoDate as permitParseIsoDate, effectiveStatus, getPermitFor, PermitError } from "./permits";
import { drawDisputeHold } from "./disputes";
import { makeWholeCurrency } from "./money";
import type {
  BasisVerificationMethod,
  BudgetLine,
  CostToCompleteEstimate,
  DrawLineItem,
  DrawPermitBasisPin,
  DrawRequest,
  GoverningBasisKind,
  LineEligibilityStatus,
  LineInspectionRequirement,
  LineInspectionStatus,
  ObvException,
  PermitBasisVersion,
  Project,
  SourceVerification,
  SourceVerificationResult,
  TransitionRuleRecord,
  User,
} from "../../shared/types";

export class ComplianceError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

/** Required scope statement — rendered verbatim in packages and docs. */
export const DMV_SCOPE_NOTE =
  "OBV records construction compliance evidence, source lookups, inspection status, verification " +
  "results, and lender-review eligibility. OBV does not issue permits, perform government inspections, " +
  "provide legal interpretations, approve loans, or automatically authorize payment.";

/** Displayed wherever a line reaches ELIGIBLE_FOR_LENDER_REVIEW. */
export const ELIGIBLE_WORDING = "Eligible for lender review — not automatically approved.";

export const NOT_LEGAL_ADVICE_NOTE =
  "Code, permit, and transition information is recorded from attributable lookups and official sources " +
  "for lender-review context. It is not a legal interpretation and OBV does not provide legal advice.";

/** Suggested permit/trade vocabulary for the DMV pilot. NOT a closed list —
 *  free-form values are accepted so other jurisdictions extend naturally. */
export const DMV_TRADE_TYPES = [
  "BUILDING", "ELECTRICAL", "PLUMBING", "MECHANICAL", "FIRE_PROTECTION",
  "DEMOLITION", "STRUCTURAL", "ROOFING", "OCCUPANCY", "ZONING",
  "HISTORIC_PRESERVATION", "ENVIRONMENTAL", "PUBLIC_SPACE", "UTILITY", "OTHER",
] as const;

const VERIFICATION_METHODS: BasisVerificationMethod[] = [
  "MANUAL_PORTAL_LOOKUP", "OFFICIAL_DOCUMENT", "EMAIL_FROM_AUTHORITY",
  "SITE_POSTING_PHOTO", "API_LOOKUP", "OTHER",
];
const GOVERNING_BASIS_KINDS: GoverningBasisKind[] = [
  "CURRENT_CODE", "PRIOR_CODE_TRANSITION", "PERMIT_GRANDFATHERED", "LOCAL_AMENDMENT", "UNRESOLVED",
];
const VERIFICATION_RESULTS: SourceVerificationResult[] = [
  "VERIFIED_MATCH", "PARTIAL_MATCH", "NO_MATCH_FOUND",
  "RECORD_UNAVAILABLE", "SOURCE_UNAVAILABLE", "MANUAL_REVIEW_REQUIRED",
];
const LINE_INSPECTION_STATUSES: LineInspectionStatus[] = [
  "NOT_REQUIRED", "REQUIRED_NOT_SCHEDULED", "SCHEDULED", "PASSED", "FAILED", "PARTIAL",
  "CORRECTION_REQUIRED", "REINSPECTION_REQUIRED", "PENDING_OFFICIAL_CONFIRMATION",
  "NOT_FOUND", "WAIVED_BY_AUTHORITY", "UNKNOWN",
];

/** Same authority split as the permit register: lender-side roles hold
 *  formal basis/official-status determination; the project manager may
 *  record operational drafts and estimates. Field users hold neither. */
const DETERMINATION_ROLES = new Set(["FUNDER_REP", "COMPLIANCE_REVIEWER"]);
const RECORDING_ROLES = new Set(["FUNDER_REP", "COMPLIANCE_REVIEWER", "PROJECT_MANAGER"]);

const wholeCurrency = makeWholeCurrency((m) => new ComplianceError(m, 400));

function nowIso(): string {
  return new Date().toISOString();
}

function assertProjectAccess(user: User, projectId: string): Project {
  const project = repo.getProject(projectId);
  // Tenant boundary: unrelated organizations get the same 404 as a
  // nonexistent record (never 403).
  if (!project || !canAccessProjectFinance(user, project)) {
    throw new ComplianceError("Project not found", 404);
  }
  return project;
}

function requireRole(user: User, roles: Set<string>, what: string): void {
  if (!roles.has(user.role)) {
    throw new ComplianceError(`Your role (${user.role}) is not authorized to ${what}`, 403);
  }
}

/** parseIsoDate from the permit module, rethrown as a ComplianceError so
 *  callers get one consistent error type from this service. */
function parseDate(value: string | null | undefined, field: string): string | null {
  try {
    return permitParseIsoDate(value, field);
  } catch (e) {
    if (e instanceof PermitError) throw new ComplianceError(e.message, e.statusCode);
    throw e;
  }
}

function requireText(value: unknown, field: string, max = 200): string {
  const v = String(value ?? "").trim();
  if (!v) throw new ComplianceError(`${field} is required`);
  if (v.length > max) throw new ComplianceError(`${field} must be at most ${max} characters`);
  return v;
}

function optText(value: unknown, field: string, max = 4000): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (v.length > max) throw new ComplianceError(`${field} must be at most ${max} characters`);
  return v;
}

function optHttpUrl(value: unknown, field: string): string | null {
  const v = optText(value, field, 1000);
  if (v && !/^https?:\/\//i.test(v)) {
    throw new ComplianceError(`${field} must be an http(s) URL`);
  }
  return v;
}

/** Project-scoped official-source reference (same-404 on any mismatch). */
function requireProjectSource(projectId: string, sourceId: string, field: string): void {
  const src = repo.getOfficialSource(sourceId);
  if (!src || src.projectId !== projectId) {
    throw new ComplianceError(`${field}: official-source record not found`, 404);
  }
}

// ===================================================================
// Governing Code and Permit Basis versions
// ===================================================================

/** Canonical content hash: the immutable content fields in a fixed order.
 *  Status/effective/finalization metadata are excluded — they are lifecycle
 *  metadata, not content. Exported so the seed and integrity checks use
 *  the identical canonical form. */
export function basisContentHash(b: PermitBasisVersion): string {
  return dmv.sha256Hex(
    JSON.stringify([
      b.permitId, b.version, b.supersedesVersionId, b.jurisdiction, b.permittingAuthority,
      b.propertyAddress, b.parcelIdentifier, b.permitNumber, b.permitType, b.tradeType,
      b.workCategory, b.applicationDate, b.issuanceDate, b.expirationDate, b.permitStatus,
      b.governingCodeEdition, b.localAmendments, b.transitionRuleId, b.governingBasis,
      b.applicabilityExplanation, b.sourceSystem, b.sourceUrl, b.sourceRecordId, b.lookupAt,
      b.lookupByUserId, b.verificationMethod, b.sourceEvidenceId, b.notes, b.correctionReason,
      b.correctedByUserId,
    ])
  );
}

export interface PermitBasisInput {
  permitId: string;
  jurisdiction: string;
  permittingAuthority: string;
  propertyAddress?: string | null;
  parcelIdentifier?: string | null;
  permitNumber: string;
  permitType: string;
  tradeType?: string | null;
  workCategory?: string | null;
  applicationDate?: string | null;
  issuanceDate?: string | null;
  expirationDate?: string | null;
  permitStatus: string;
  governingCodeEdition?: string | null;
  localAmendments?: string | null;
  transitionRuleId?: string | null;
  governingBasis: string;
  applicabilityExplanation?: string | null;
  sourceSystem?: string | null;
  sourceUrl?: string | null;
  sourceRecordId?: string | null;
  lookupAt?: string | null;
  verificationMethod: string;
  sourceEvidenceId?: string | null;
  notes?: string | null;
}

const BASIS_PERMIT_STATUSES = new Set([
  "DRAFT", "APPLIED", "ISSUED", "ACTIVE", "SUSPENDED", "EXPIRED", "CLOSED", "REVOKED", "UNKNOWN",
]);

function validateBasisContent(project: Project, user: User, input: PermitBasisInput) {
  const jurisdiction = requireText(input.jurisdiction, "jurisdiction", 120);
  const permittingAuthority = requireText(input.permittingAuthority, "permittingAuthority", 200);
  const permitNumber = requireText(input.permitNumber, "permitNumber", 120);
  const permitType = requireText(input.permitType, "permitType", 120);
  const permitStatus = requireText(input.permitStatus, "permitStatus", 40).toUpperCase();
  if (!BASIS_PERMIT_STATUSES.has(permitStatus)) {
    throw new ComplianceError(
      `permitStatus must be one of ${[...BASIS_PERMIT_STATUSES].join(", ")}`
    );
  }
  const governingBasis = requireText(input.governingBasis, "governingBasis", 40) as GoverningBasisKind;
  if (!GOVERNING_BASIS_KINDS.includes(governingBasis)) {
    throw new ComplianceError(`governingBasis must be one of ${GOVERNING_BASIS_KINDS.join(", ")}`);
  }
  const verificationMethod = requireText(input.verificationMethod, "verificationMethod", 40) as BasisVerificationMethod;
  if (!VERIFICATION_METHODS.includes(verificationMethod)) {
    throw new ComplianceError(`verificationMethod must be one of ${VERIFICATION_METHODS.join(", ")}`);
  }
  const transitionRuleId = optText(input.transitionRuleId, "transitionRuleId", 64);
  if (governingBasis === "PRIOR_CODE_TRANSITION" && !transitionRuleId) {
    throw new ComplianceError(
      "A PRIOR_CODE_TRANSITION basis must reference a recorded transition-rule determination"
    );
  }
  let transitionRule: TransitionRuleRecord | null = null;
  if (transitionRuleId) {
    transitionRule = dmv.getTransitionRule(transitionRuleId);
    if (!transitionRule || transitionRule.projectId !== project.id) {
      throw new ComplianceError("transitionRuleId: transition rule not found", 404);
    }
  }
  const sourceEvidenceId = optText(input.sourceEvidenceId, "sourceEvidenceId", 64);
  if (sourceEvidenceId) requireProjectSource(project.id, sourceEvidenceId, "sourceEvidenceId");
  const lookupAt = parseDate(input.lookupAt, "lookupAt");
  const applicabilityExplanation = optText(input.applicabilityExplanation, "applicabilityExplanation");
  if (governingBasis === "PERMIT_GRANDFATHERED" && !applicabilityExplanation) {
    throw new ComplianceError(
      "A PERMIT_GRANDFATHERED basis requires a plain-language applicabilityExplanation"
    );
  }
  return {
    jurisdiction,
    permittingAuthority,
    propertyAddress: optText(input.propertyAddress, "propertyAddress", 400),
    parcelIdentifier: optText(input.parcelIdentifier, "parcelIdentifier", 120),
    permitNumber,
    permitType,
    tradeType: optText(input.tradeType, "tradeType", 120),
    workCategory: optText(input.workCategory, "workCategory", 200),
    applicationDate: parseDate(input.applicationDate, "applicationDate"),
    issuanceDate: parseDate(input.issuanceDate, "issuanceDate"),
    expirationDate: parseDate(input.expirationDate, "expirationDate"),
    permitStatus,
    governingCodeEdition: optText(input.governingCodeEdition, "governingCodeEdition", 200),
    localAmendments: optText(input.localAmendments, "localAmendments"),
    transitionRuleId,
    transitionRule,
    governingBasis,
    applicabilityExplanation,
    sourceSystem: optText(input.sourceSystem, "sourceSystem", 200),
    sourceUrl: optHttpUrl(input.sourceUrl, "sourceUrl"),
    sourceRecordId: optText(input.sourceRecordId, "sourceRecordId", 200),
    lookupAt,
    // Attribution is always the acting user — never a caller-supplied id.
    lookupByUserId: lookupAt ? user.id : null,
    verificationMethod,
    sourceEvidenceId,
    notes: optText(input.notes, "notes"),
  };
}

/** Record a new DRAFT Governing Code and Permit Basis version. Drafts are
 *  editable only by replacement (create another draft); they carry no
 *  control weight until finalized by a determination role. */
export function createPermitBasis(user: User, input: PermitBasisInput): PermitBasisVersion {
  requireRole(user, RECORDING_ROLES, "record a permit basis");
  const permitId = requireText(input.permitId, "permitId", 64);
  const { permit, project } = lookupPermit(user, permitId);
  const content = validateBasisContent(project, user, input);
  const at = nowIso();
  const basis: PermitBasisVersion = {
    id: dmv.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    permitId: permit.id,
    version: 0, // assigned inside the transaction
    supersedesVersionId: null,
    status: "DRAFT",
    jurisdiction: content.jurisdiction,
    permittingAuthority: content.permittingAuthority,
    propertyAddress: content.propertyAddress,
    parcelIdentifier: content.parcelIdentifier,
    permitNumber: content.permitNumber,
    permitType: content.permitType,
    tradeType: content.tradeType,
    workCategory: content.workCategory,
    applicationDate: content.applicationDate,
    issuanceDate: content.issuanceDate,
    expirationDate: content.expirationDate,
    permitStatus: content.permitStatus,
    governingCodeEdition: content.governingCodeEdition,
    localAmendments: content.localAmendments,
    transitionRuleId: content.transitionRuleId,
    governingBasis: content.governingBasis,
    applicabilityExplanation: content.applicabilityExplanation,
    sourceSystem: content.sourceSystem,
    sourceUrl: content.sourceUrl,
    sourceRecordId: content.sourceRecordId,
    lookupAt: content.lookupAt,
    lookupByUserId: content.lookupByUserId,
    verificationMethod: content.verificationMethod,
    sourceEvidenceId: content.sourceEvidenceId,
    notes: content.notes,
    correctionReason: null,
    correctedByUserId: null,
    recordHash: "",
    effectiveFrom: null,
    supersededAt: null,
    finalizedAt: null,
    finalizedByUserId: null,
    createdByUserId: user.id,
    createdAt: at,
  };
  dmv.withComplianceTx(() => {
    basis.version = dmv.nextBasisVersion(permit.id);
    basis.recordHash = basisContentHash(basis);
    dmv.insertPermitBasis(basis);
  });
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "PERMIT_BASIS_DRAFTED",
    entityType: "permit_basis_version",
    entityId: basis.id,
    reason: null,
    beforeSummary: null,
    afterSummary: `Draft basis v${basis.version} for permit ${basis.permitNumber} (${basis.governingBasis})`,
  });
  return basis;
}

function lookupPermit(user: User, permitId: string) {
  try {
    return getPermitFor(user, permitId);
  } catch (e) {
    if (e instanceof PermitError) throw new ComplianceError(e.message, e.statusCode);
    throw e;
  }
}

export function getBasisFor(user: User, basisId: string): { basis: PermitBasisVersion; project: Project } {
  const basis = dmv.getPermitBasis(basisId);
  const project = basis ? repo.getProject(basis.projectId) : null;
  if (!basis || !project || !canAccessProjectFinance(user, project)) {
    throw new ComplianceError("Permit basis record not found", 404);
  }
  return { basis, project };
}

/** Finalize a DRAFT basis version as the permit's AUTHORITATIVE governing
 *  basis. A determination-role human act: exactly-once (guarded), it
 *  supersedes any previously authoritative version in the same
 *  transaction so the permit has at most one authoritative basis. */
export function finalizePermitBasis(user: User, basisId: string): PermitBasisVersion {
  requireRole(user, DETERMINATION_ROLES, "finalize a permit basis");
  const { basis, project } = getBasisFor(user, basisId);
  if (basis.status !== "DRAFT") {
    throw new ComplianceError(`Only a DRAFT basis can be finalized (this one is ${basis.status})`, 409);
  }
  if (basis.governingBasis === "PRIOR_CODE_TRANSITION") {
    const rule = basis.transitionRuleId ? dmv.getTransitionRule(basis.transitionRuleId) : null;
    if (!rule || rule.eligibility !== "ELIGIBLE_PRIOR_CODE") {
      throw new ComplianceError(
        "A PRIOR_CODE_TRANSITION basis can only be finalized after an authorized reviewer has " +
          "determined the transition rule ELIGIBLE_PRIOR_CODE",
        409
      );
    }
  }
  const at = nowIso();
  const prior = dmv.authoritativeBasisForPermit(basis.permitId);
  dmv.withComplianceTx(() => {
    if (prior && prior.id !== basis.id) {
      if (!dmv.supersedeBasisGuarded(prior.id, at)) {
        throw new ComplianceError("The permit's authoritative basis changed concurrently — retry", 409);
      }
    }
    if (!dmv.finalizeBasisGuarded(basis.id, user.id, at)) {
      throw new ComplianceError("This basis version was already finalized or superseded", 409);
    }
  });
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "PERMIT_BASIS_FINALIZED",
    entityType: "permit_basis_version",
    entityId: basis.id,
    reason: null,
    beforeSummary: prior && prior.id !== basis.id ? `Superseded v${prior.version} (${prior.id})` : null,
    afterSummary: `Basis v${basis.version} for permit ${basis.permitNumber} is AUTHORITATIVE`,
  });
  const out = dmv.getPermitBasis(basis.id);
  if (!out) throw new ComplianceError("Permit basis record not found", 404);
  return out;
}

/** Correct an AUTHORITATIVE basis by inserting a NEW version. The original
 *  version's content is preserved untouched (only its status flips to
 *  SUPERSEDED with a supersededAt bound); the correction records its
 *  reason, the correcting user, and the prior-version relationship. */
export function correctPermitBasis(
  user: User,
  basisId: string,
  patch: Partial<PermitBasisInput>,
  correctionReason: string
): PermitBasisVersion {
  requireRole(user, DETERMINATION_ROLES, "correct a permit basis");
  const { basis: prior, project } = getBasisFor(user, basisId);
  if (prior.status !== "AUTHORITATIVE") {
    throw new ComplianceError(
      `Only the AUTHORITATIVE basis version can be corrected (this one is ${prior.status})`,
      409
    );
  }
  const reason = requireText(correctionReason, "correctionReason", 2000);
  if (reason.length < 10) {
    throw new ComplianceError("correctionReason must explain the correction (at least 10 characters)");
  }
  const merged: PermitBasisInput = {
    permitId: prior.permitId,
    jurisdiction: patch.jurisdiction ?? prior.jurisdiction,
    permittingAuthority: patch.permittingAuthority ?? prior.permittingAuthority,
    propertyAddress: patch.propertyAddress !== undefined ? patch.propertyAddress : prior.propertyAddress,
    parcelIdentifier: patch.parcelIdentifier !== undefined ? patch.parcelIdentifier : prior.parcelIdentifier,
    permitNumber: patch.permitNumber ?? prior.permitNumber,
    permitType: patch.permitType ?? prior.permitType,
    tradeType: patch.tradeType !== undefined ? patch.tradeType : prior.tradeType,
    workCategory: patch.workCategory !== undefined ? patch.workCategory : prior.workCategory,
    applicationDate: patch.applicationDate !== undefined ? patch.applicationDate : prior.applicationDate,
    issuanceDate: patch.issuanceDate !== undefined ? patch.issuanceDate : prior.issuanceDate,
    expirationDate: patch.expirationDate !== undefined ? patch.expirationDate : prior.expirationDate,
    permitStatus: patch.permitStatus ?? prior.permitStatus,
    governingCodeEdition:
      patch.governingCodeEdition !== undefined ? patch.governingCodeEdition : prior.governingCodeEdition,
    localAmendments: patch.localAmendments !== undefined ? patch.localAmendments : prior.localAmendments,
    transitionRuleId: patch.transitionRuleId !== undefined ? patch.transitionRuleId : prior.transitionRuleId,
    governingBasis: patch.governingBasis ?? prior.governingBasis,
    applicabilityExplanation:
      patch.applicabilityExplanation !== undefined
        ? patch.applicabilityExplanation
        : prior.applicabilityExplanation,
    sourceSystem: patch.sourceSystem !== undefined ? patch.sourceSystem : prior.sourceSystem,
    sourceUrl: patch.sourceUrl !== undefined ? patch.sourceUrl : prior.sourceUrl,
    sourceRecordId: patch.sourceRecordId !== undefined ? patch.sourceRecordId : prior.sourceRecordId,
    lookupAt: patch.lookupAt !== undefined ? patch.lookupAt : prior.lookupAt,
    verificationMethod: patch.verificationMethod ?? prior.verificationMethod,
    sourceEvidenceId: patch.sourceEvidenceId !== undefined ? patch.sourceEvidenceId : prior.sourceEvidenceId,
    notes: patch.notes !== undefined ? patch.notes : prior.notes,
  };
  const content = validateBasisContent(project, user, merged);
  if (merged.governingBasis === "PRIOR_CODE_TRANSITION") {
    if (!content.transitionRule || content.transitionRule.eligibility !== "ELIGIBLE_PRIOR_CODE") {
      throw new ComplianceError(
        "A PRIOR_CODE_TRANSITION basis requires a transition rule determined ELIGIBLE_PRIOR_CODE",
        409
      );
    }
  }
  const at = nowIso();
  const next: PermitBasisVersion = {
    id: dmv.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    permitId: prior.permitId,
    version: 0,
    supersedesVersionId: prior.id,
    status: "AUTHORITATIVE",
    jurisdiction: content.jurisdiction,
    permittingAuthority: content.permittingAuthority,
    propertyAddress: content.propertyAddress,
    parcelIdentifier: content.parcelIdentifier,
    permitNumber: content.permitNumber,
    permitType: content.permitType,
    tradeType: content.tradeType,
    workCategory: content.workCategory,
    applicationDate: content.applicationDate,
    issuanceDate: content.issuanceDate,
    expirationDate: content.expirationDate,
    permitStatus: content.permitStatus,
    governingCodeEdition: content.governingCodeEdition,
    localAmendments: content.localAmendments,
    transitionRuleId: content.transitionRuleId,
    governingBasis: content.governingBasis,
    applicabilityExplanation: content.applicabilityExplanation,
    sourceSystem: content.sourceSystem,
    sourceUrl: content.sourceUrl,
    sourceRecordId: content.sourceRecordId,
    lookupAt: content.lookupAt,
    // Preserve the ORIGINAL lookup attribution unless the correction
    // supplies a new lookup timestamp performed by the correcting user.
    lookupByUserId: patch.lookupAt !== undefined ? content.lookupByUserId : prior.lookupByUserId,
    verificationMethod: content.verificationMethod,
    sourceEvidenceId: content.sourceEvidenceId,
    notes: content.notes,
    correctionReason: reason,
    correctedByUserId: user.id,
    recordHash: "",
    effectiveFrom: at,
    supersededAt: null,
    finalizedAt: at,
    finalizedByUserId: user.id,
    createdByUserId: user.id,
    createdAt: at,
  };
  dmv.withComplianceTx(() => {
    if (!dmv.supersedeBasisGuarded(prior.id, at)) {
      throw new ComplianceError("This basis version was corrected concurrently — retry", 409);
    }
    next.version = dmv.nextBasisVersion(prior.permitId);
    next.recordHash = basisContentHash(next);
    dmv.insertPermitBasis(next);
  });
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "PERMIT_BASIS_CORRECTED",
    entityType: "permit_basis_version",
    entityId: next.id,
    reason,
    beforeSummary: `v${prior.version} (${prior.id}) superseded at ${at}`,
    afterSummary: `Corrected basis v${next.version} for permit ${next.permitNumber} is AUTHORITATIVE`,
  });
  return next;
}

// ===================================================================
// Transition rules
// ===================================================================

export interface TransitionRuleInput {
  projectId: string;
  jurisdiction: string;
  priorCodeEdition: string;
  replacementCodeEdition: string;
  transitionPeriodStart?: string | null;
  transitionPeriodEnd?: string | null;
  applicationDateCutoff?: string | null;
  permitIssuanceCutoff?: string | null;
  governingInterpretation?: string | null;
  officialSourceId?: string | null;
  lookupAt?: string | null;
  notes?: string | null;
}

/** Record a transition rule. It starts PENDING_DETERMINATION — OBV never
 *  infers legal applicability from the current date alone; an authorized
 *  human confirms via determineTransition(). */
export function recordTransitionRule(user: User, input: TransitionRuleInput): TransitionRuleRecord {
  requireRole(user, RECORDING_ROLES, "record a transition rule");
  const project = assertProjectAccess(user, requireText(input.projectId, "projectId", 64));
  const officialSourceId = optText(input.officialSourceId, "officialSourceId", 64);
  if (officialSourceId) requireProjectSource(project.id, officialSourceId, "officialSourceId");
  const rule: TransitionRuleRecord = {
    id: dmv.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    jurisdiction: requireText(input.jurisdiction, "jurisdiction", 120),
    priorCodeEdition: requireText(input.priorCodeEdition, "priorCodeEdition", 200),
    replacementCodeEdition: requireText(input.replacementCodeEdition, "replacementCodeEdition", 200),
    transitionPeriodStart: parseDate(input.transitionPeriodStart, "transitionPeriodStart"),
    transitionPeriodEnd: parseDate(input.transitionPeriodEnd, "transitionPeriodEnd"),
    applicationDateCutoff: parseDate(input.applicationDateCutoff, "applicationDateCutoff"),
    permitIssuanceCutoff: parseDate(input.permitIssuanceCutoff, "permitIssuanceCutoff"),
    eligibility: "PENDING_DETERMINATION",
    governingInterpretation: optText(input.governingInterpretation, "governingInterpretation"),
    officialSourceId,
    lookupAt: parseDate(input.lookupAt, "lookupAt"),
    reviewerUserId: user.id,
    notes: optText(input.notes, "notes"),
    determinedAt: null,
    createdAt: nowIso(),
  };
  dmv.insertTransitionRule(rule);
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "TRANSITION_RULE_RECORDED",
    entityType: "transition_rule_record",
    entityId: rule.id,
    reason: null,
    beforeSummary: null,
    afterSummary: `${rule.priorCodeEdition} → ${rule.replacementCodeEdition} (${rule.jurisdiction}), pending determination`,
  });
  return rule;
}

export function getTransitionRuleFor(user: User, ruleId: string): { rule: TransitionRuleRecord; project: Project } {
  const rule = dmv.getTransitionRule(ruleId);
  const project = rule ? repo.getProject(rule.projectId) : null;
  if (!rule || !project || !canAccessProjectFinance(user, project)) {
    throw new ComplianceError("Transition rule not found", 404);
  }
  return { rule, project };
}

/** The single human eligibility determination for a transition rule —
 *  a determination-role act, exactly-once (guarded). */
export function determineTransition(
  user: User,
  ruleId: string,
  eligibility: string,
  governingInterpretation?: string | null
): TransitionRuleRecord {
  requireRole(user, DETERMINATION_ROLES, "determine transition eligibility");
  const { rule, project } = getTransitionRuleFor(user, ruleId);
  if (eligibility !== "ELIGIBLE_PRIOR_CODE" && eligibility !== "NOT_ELIGIBLE") {
    throw new ComplianceError("eligibility must be ELIGIBLE_PRIOR_CODE or NOT_ELIGIBLE");
  }
  const interpretation = optText(governingInterpretation, "governingInterpretation");
  if (eligibility === "ELIGIBLE_PRIOR_CODE" && !interpretation && !rule.governingInterpretation) {
    throw new ComplianceError(
      "An ELIGIBLE_PRIOR_CODE determination must record the governing interpretation it relies on"
    );
  }
  if (!dmv.determineTransitionGuarded(rule.id, eligibility, interpretation, user.id, nowIso())) {
    throw new ComplianceError("This transition rule has already been determined", 409);
  }
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "TRANSITION_RULE_DETERMINED",
    entityType: "transition_rule_record",
    entityId: rule.id,
    reason: null,
    beforeSummary: "PENDING_DETERMINATION",
    afterSummary: eligibility,
  });
  const out = dmv.getTransitionRule(rule.id);
  if (!out) throw new ComplianceError("Transition rule not found", 404);
  return out;
}

// ===================================================================
// Line-level required official inspections
// ===================================================================

export interface LineRequirementInput {
  projectId: string;
  budgetLineId?: string | null;
  milestoneId?: string | null;
  jurisdiction?: string | null;
  inspectionAuthority?: string | null;
  inspectionType: string;
  description?: string | null;
  permitId?: string | null;
  permitBasisVersionId?: string | null;
  prerequisiteRequirementId?: string | null;
  sequence?: number;
  requiredBeforeConcealment?: boolean;
  requiredBeforePayment?: boolean;
  requiredBeforeFinal?: boolean;
  notes?: string | null;
}

/** Statuses that assert something about the OFFICIAL jurisdiction record.
 *  Recording one requires a determination role plus official backing —
 *  an OBV field finding can never produce them. */
const OFFICIAL_RESULT_STATUSES = new Set<LineInspectionStatus>([
  "PASSED", "FAILED", "PARTIAL", "CORRECTION_REQUIRED", "REINSPECTION_REQUIRED",
  "NOT_FOUND", "WAIVED_BY_AUTHORITY",
]);

/** Allowed status transitions. PASSED is terminal: an official passed
 *  result is never rewritten — a later dispute about it is handled by a
 *  NEW requirement record, mirroring the jurisdictional-inspection chain. */
const REQ_TRANSITIONS: Record<LineInspectionStatus, LineInspectionStatus[]> = {
  NOT_REQUIRED: ["REQUIRED_NOT_SCHEDULED", "UNKNOWN"],
  REQUIRED_NOT_SCHEDULED: [
    "SCHEDULED", "PENDING_OFFICIAL_CONFIRMATION", "NOT_FOUND", "WAIVED_BY_AUTHORITY",
    "NOT_REQUIRED", "UNKNOWN",
  ],
  SCHEDULED: [
    "PASSED", "FAILED", "PARTIAL", "CORRECTION_REQUIRED", "PENDING_OFFICIAL_CONFIRMATION",
    "REQUIRED_NOT_SCHEDULED", "UNKNOWN",
  ],
  PENDING_OFFICIAL_CONFIRMATION: [
    "PASSED", "FAILED", "PARTIAL", "CORRECTION_REQUIRED", "NOT_FOUND", "SCHEDULED", "UNKNOWN",
  ],
  PASSED: [],
  FAILED: ["REINSPECTION_REQUIRED", "CORRECTION_REQUIRED", "UNKNOWN"],
  PARTIAL: [
    "SCHEDULED", "PASSED", "FAILED", "CORRECTION_REQUIRED", "PENDING_OFFICIAL_CONFIRMATION", "UNKNOWN",
  ],
  CORRECTION_REQUIRED: ["REINSPECTION_REQUIRED", "SCHEDULED", "PENDING_OFFICIAL_CONFIRMATION", "UNKNOWN"],
  REINSPECTION_REQUIRED: [
    "SCHEDULED", "PASSED", "FAILED", "PARTIAL", "CORRECTION_REQUIRED",
    "PENDING_OFFICIAL_CONFIRMATION", "UNKNOWN",
  ],
  NOT_FOUND: [
    "REQUIRED_NOT_SCHEDULED", "SCHEDULED", "PENDING_OFFICIAL_CONFIRMATION", "PASSED", "FAILED", "UNKNOWN",
  ],
  WAIVED_BY_AUTHORITY: ["REQUIRED_NOT_SCHEDULED", "UNKNOWN"],
  UNKNOWN: [
    "NOT_REQUIRED", "REQUIRED_NOT_SCHEDULED", "SCHEDULED", "PASSED", "FAILED", "PARTIAL",
    "CORRECTION_REQUIRED", "REINSPECTION_REQUIRED", "PENDING_OFFICIAL_CONFIRMATION",
    "NOT_FOUND", "WAIVED_BY_AUTHORITY",
  ],
};

export function createLineRequirement(user: User, input: LineRequirementInput): LineInspectionRequirement {
  requireRole(user, RECORDING_ROLES, "record an inspection requirement");
  const project = assertProjectAccess(user, requireText(input.projectId, "projectId", 64));
  const budgetLineId = optText(input.budgetLineId, "budgetLineId", 64);
  const milestoneId = optText(input.milestoneId, "milestoneId", 64);
  if (!budgetLineId && !milestoneId) {
    throw new ComplianceError("An inspection requirement must reference a budget line or a milestone");
  }
  if (budgetLineId) {
    const bl = repo.getBudgetLine(budgetLineId);
    if (!bl || bl.projectId !== project.id) {
      throw new ComplianceError("budgetLineId: budget line not found", 404);
    }
  }
  if (milestoneId) {
    const ms = repo.getMilestone(milestoneId);
    if (!ms || ms.projectId !== project.id) {
      throw new ComplianceError("milestoneId: milestone not found", 404);
    }
  }
  const permitId = optText(input.permitId, "permitId", 64);
  if (permitId) {
    const p = repo.getPermit(permitId);
    if (!p || p.projectId !== project.id) throw new ComplianceError("permitId: permit not found", 404);
  }
  const permitBasisVersionId = optText(input.permitBasisVersionId, "permitBasisVersionId", 64);
  if (permitBasisVersionId) {
    const b = dmv.getPermitBasis(permitBasisVersionId);
    if (!b || b.projectId !== project.id) {
      throw new ComplianceError("permitBasisVersionId: permit basis record not found", 404);
    }
  }
  const prerequisiteRequirementId = optText(input.prerequisiteRequirementId, "prerequisiteRequirementId", 64);
  if (prerequisiteRequirementId) {
    const pre = dmv.getLineRequirement(prerequisiteRequirementId);
    if (!pre || pre.projectId !== project.id) {
      throw new ComplianceError("prerequisiteRequirementId: requirement not found", 404);
    }
  }
  const sequence = Number(input.sequence ?? 0);
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 1000) {
    throw new ComplianceError("sequence must be an integer between 0 and 1000");
  }
  const at = nowIso();
  const req: LineInspectionRequirement = {
    id: dmv.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    budgetLineId,
    milestoneId,
    jurisdiction: optText(input.jurisdiction, "jurisdiction", 120),
    inspectionAuthority: optText(input.inspectionAuthority, "inspectionAuthority", 200),
    inspectionType: requireText(input.inspectionType, "inspectionType", 200),
    description: optText(input.description, "description"),
    permitId,
    permitBasisVersionId,
    prerequisiteRequirementId,
    sequence,
    requiredBeforeConcealment: Boolean(input.requiredBeforeConcealment),
    requiredBeforePayment: input.requiredBeforePayment === undefined ? true : Boolean(input.requiredBeforePayment),
    requiredBeforeFinal: Boolean(input.requiredBeforeFinal),
    status: "REQUIRED_NOT_SCHEDULED",
    scheduledDate: null,
    completedDate: null,
    officialResultText: null,
    correctionNotice: null,
    reinspectionRequired: false,
    reinspectionResult: null,
    jurisdictionalInspectionId: null,
    officialSourceId: null,
    lookupAt: null,
    externalIdentifier: null,
    reviewerUserId: null,
    notes: optText(input.notes, "notes"),
    createdByUserId: user.id,
    createdAt: at,
    updatedAt: at,
  };
  dmv.insertLineRequirement(req);
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "LINE_INSPECTION_REQUIREMENT_CREATED",
    entityType: "line_inspection_requirement",
    entityId: req.id,
    reason: null,
    beforeSummary: null,
    afterSummary: `${req.inspectionType} required (${budgetLineId ? `line ${budgetLineId}` : `milestone ${milestoneId}`})`,
  });
  return req;
}

export function getLineRequirementFor(
  user: User,
  requirementId: string
): { requirement: LineInspectionRequirement; project: Project } {
  const requirement = dmv.getLineRequirement(requirementId);
  const project = requirement ? repo.getProject(requirement.projectId) : null;
  if (!requirement || !project || !canAccessProjectFinance(user, project)) {
    throw new ComplianceError("Inspection requirement not found", 404);
  }
  return { requirement, project };
}

export interface LineRequirementStatusInput {
  toStatus: string;
  scheduledDate?: string | null;
  completedDate?: string | null;
  officialResultText?: string | null;
  correctionNotice?: string | null;
  reinspectionRequired?: boolean;
  jurisdictionalInspectionId?: string | null;
  officialSourceId?: string | null;
  lookupAt?: string | null;
  externalIdentifier?: string | null;
  notes?: string | null;
}

/** Move a requirement through its status machine. Official-result statuses
 *  demand a determination role plus recorded official backing (verbatim
 *  official result text, an official-source record, or a jurisdictional
 *  inspection record) and the lookup timestamp — an OBV field finding,
 *  contractor claim, or photo can never set them. */
export function updateLineRequirementStatus(
  user: User,
  requirementId: string,
  input: LineRequirementStatusInput
): LineInspectionRequirement {
  requireRole(user, RECORDING_ROLES, "update an inspection requirement");
  const { requirement, project } = getLineRequirementFor(user, requirementId);
  const toStatus = requireText(input.toStatus, "toStatus", 40) as LineInspectionStatus;
  if (!LINE_INSPECTION_STATUSES.includes(toStatus)) {
    throw new ComplianceError(`toStatus must be one of ${LINE_INSPECTION_STATUSES.join(", ")}`);
  }
  const allowed = REQ_TRANSITIONS[requirement.status] ?? [];
  if (!allowed.includes(toStatus)) {
    throw new ComplianceError(
      `Cannot move a ${requirement.status} requirement to ${toStatus}` +
        (requirement.status === "PASSED"
          ? " — an official PASSED result is immutable; record a new requirement instead"
          : ""),
      409
    );
  }
  const jurisdictionalInspectionId = optText(input.jurisdictionalInspectionId, "jurisdictionalInspectionId", 64);
  if (jurisdictionalInspectionId) {
    const insp = repo.getInspection(jurisdictionalInspectionId);
    if (!insp || insp.projectId !== project.id) {
      throw new ComplianceError("jurisdictionalInspectionId: inspection record not found", 404);
    }
  }
  const officialSourceId = optText(input.officialSourceId, "officialSourceId", 64);
  if (officialSourceId) requireProjectSource(project.id, officialSourceId, "officialSourceId");
  const officialResultText = optText(input.officialResultText, "officialResultText");
  const lookupAt = parseDate(input.lookupAt, "lookupAt");
  if (OFFICIAL_RESULT_STATUSES.has(toStatus)) {
    requireRole(user, DETERMINATION_ROLES, `record the official inspection status ${toStatus}`);
    const effectiveLookup = lookupAt ?? requirement.lookupAt;
    if (!effectiveLookup) {
      throw new ComplianceError(
        `Recording ${toStatus} requires the official-record lookup timestamp (lookupAt)`
      );
    }
    const hasBacking =
      Boolean(officialResultText) || Boolean(officialSourceId) || Boolean(jurisdictionalInspectionId) ||
      Boolean(requirement.officialResultText) || Boolean(requirement.officialSourceId) ||
      Boolean(requirement.jurisdictionalInspectionId);
    if (!hasBacking) {
      throw new ComplianceError(
        `Recording ${toStatus} requires official backing: the official result text, an ` +
          "official-source record, or a jurisdictional inspection record. A contractor claim, " +
          "photo, or OBV field finding is not an official inspection result."
      );
    }
  }
  const ok = dmv.updateLineRequirementStatusGuarded(requirement.id, [requirement.status], toStatus, {
    scheduledDate: parseDate(input.scheduledDate, "scheduledDate") ?? undefined,
    completedDate: parseDate(input.completedDate, "completedDate") ?? undefined,
    officialResultText: officialResultText ?? undefined,
    correctionNotice: optText(input.correctionNotice, "correctionNotice") ?? undefined,
    reinspectionRequired:
      input.reinspectionRequired === undefined ? undefined : Boolean(input.reinspectionRequired),
    jurisdictionalInspectionId: jurisdictionalInspectionId ?? undefined,
    officialSourceId: officialSourceId ?? undefined,
    lookupAt: lookupAt ?? undefined,
    externalIdentifier: optText(input.externalIdentifier, "externalIdentifier", 200) ?? undefined,
    reviewerUserId: user.id,
    notes: optText(input.notes, "notes") ?? undefined,
  });
  if (!ok) {
    throw new ComplianceError("The requirement status changed concurrently — reload and retry", 409);
  }
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "LINE_INSPECTION_STATUS_RECORDED",
    entityType: "line_inspection_requirement",
    entityId: requirement.id,
    reason: null,
    beforeSummary: requirement.status,
    afterSummary: toStatus,
  });
  const out = dmv.getLineRequirement(requirement.id);
  if (!out) throw new ComplianceError("Inspection requirement not found", 404);
  return out;
}

// ===================================================================
// Manual government-record source verifications (append-only)
// ===================================================================

export interface SourceVerificationInput {
  projectId: string;
  officialService: string;
  searchCriteria: string;
  sourceRecordIdentifier?: string | null;
  lookupAt: string;
  resultStatus: string;
  resultSummary?: string | null;
  evidenceSourceId?: string | null;
  verificationMethod: string;
  confidence?: string | null;
  nextReviewDate?: string | null;
  notes?: string | null;
  permitId?: string | null;
  permitBasisVersionId?: string | null;
  lineRequirementId?: string | null;
}

/** Record one manual verification run against an official service. This is
 *  a documented MANUAL lookup by an authorized reviewer — it is presented
 *  as such, never as a live government integration. Append-only. */
export function recordSourceVerification(user: User, input: SourceVerificationInput): SourceVerification {
  requireRole(user, DETERMINATION_ROLES, "record a source verification");
  const project = assertProjectAccess(user, requireText(input.projectId, "projectId", 64));
  const resultStatus = requireText(input.resultStatus, "resultStatus", 40) as SourceVerificationResult;
  if (!VERIFICATION_RESULTS.includes(resultStatus)) {
    throw new ComplianceError(`resultStatus must be one of ${VERIFICATION_RESULTS.join(", ")}`);
  }
  const verificationMethod = requireText(input.verificationMethod, "verificationMethod", 40) as BasisVerificationMethod;
  if (!VERIFICATION_METHODS.includes(verificationMethod)) {
    throw new ComplianceError(`verificationMethod must be one of ${VERIFICATION_METHODS.join(", ")}`);
  }
  const confidence = optText(input.confidence, "confidence", 10);
  if (confidence && !["LOW", "MEDIUM", "HIGH"].includes(confidence)) {
    throw new ComplianceError("confidence must be LOW, MEDIUM, or HIGH");
  }
  const lookupAt = parseDate(input.lookupAt, "lookupAt");
  if (!lookupAt) throw new ComplianceError("lookupAt is required");
  const evidenceSourceId = optText(input.evidenceSourceId, "evidenceSourceId", 64);
  if (evidenceSourceId) requireProjectSource(project.id, evidenceSourceId, "evidenceSourceId");
  const permitId = optText(input.permitId, "permitId", 64);
  if (permitId) {
    const p = repo.getPermit(permitId);
    if (!p || p.projectId !== project.id) throw new ComplianceError("permitId: permit not found", 404);
  }
  const permitBasisVersionId = optText(input.permitBasisVersionId, "permitBasisVersionId", 64);
  if (permitBasisVersionId) {
    const b = dmv.getPermitBasis(permitBasisVersionId);
    if (!b || b.projectId !== project.id) {
      throw new ComplianceError("permitBasisVersionId: permit basis record not found", 404);
    }
  }
  const lineRequirementId = optText(input.lineRequirementId, "lineRequirementId", 64);
  if (lineRequirementId) {
    const r = dmv.getLineRequirement(lineRequirementId);
    if (!r || r.projectId !== project.id) {
      throw new ComplianceError("lineRequirementId: requirement not found", 404);
    }
  }
  const v: SourceVerification = {
    id: dmv.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    officialService: requireText(input.officialService, "officialService", 200),
    searchCriteria: requireText(input.searchCriteria, "searchCriteria", 1000),
    sourceRecordIdentifier: optText(input.sourceRecordIdentifier, "sourceRecordIdentifier", 200),
    lookupAt,
    performedByUserId: user.id,
    resultStatus,
    resultSummary: optText(input.resultSummary, "resultSummary"),
    evidenceSourceId,
    verificationMethod,
    confidence: (confidence as SourceVerification["confidence"]) ?? null,
    nextReviewDate: parseDate(input.nextReviewDate, "nextReviewDate"),
    notes: optText(input.notes, "notes"),
    permitId,
    permitBasisVersionId,
    lineRequirementId,
    createdAt: nowIso(),
  };
  dmv.insertSourceVerification(v);
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "SOURCE_VERIFICATION_RECORDED",
    entityType: "source_verification",
    entityId: v.id,
    reason: null,
    beforeSummary: null,
    afterSummary: `${v.officialService}: ${v.resultStatus}`,
  });
  return v;
}

// ===================================================================
// Cost to complete
// ===================================================================

export interface CostToCompleteInput {
  projectId: string;
  budgetLineId: string;
  drawRequestId?: string | null;
  verifiedCompletedValue?: unknown;
  remainingCommittedCost?: unknown;
  estimatedCostToComplete: unknown;
  sourceOfEstimate: string;
  estimateDate: string;
  confidence: string;
  notes?: string | null;
}

/** Record a cost-to-complete estimate (append-only history; whole-currency
 *  integers). Recording an estimate never touches budget rows, banking
 *  balances, or payments — it is an analytical record only. */
export function recordCostToComplete(user: User, input: CostToCompleteInput): CostToCompleteEstimate {
  requireRole(user, RECORDING_ROLES, "record a cost-to-complete estimate");
  const project = assertProjectAccess(user, requireText(input.projectId, "projectId", 64));
  const budgetLineId = requireText(input.budgetLineId, "budgetLineId", 64);
  const line = repo.getBudgetLine(budgetLineId);
  if (!line || line.projectId !== project.id) {
    throw new ComplianceError("budgetLineId: budget line not found", 404);
  }
  const drawRequestId = optText(input.drawRequestId, "drawRequestId", 64);
  if (drawRequestId) {
    const d = repo.getDrawRequest(drawRequestId);
    if (!d || d.projectId !== project.id) {
      throw new ComplianceError("drawRequestId: draw request not found", 404);
    }
  }
  const confidence = requireText(input.confidence, "confidence", 10);
  if (!["LOW", "MEDIUM", "HIGH"].includes(confidence)) {
    throw new ComplianceError("confidence must be LOW, MEDIUM, or HIGH");
  }
  const est = wholeCurrency(input.estimatedCostToComplete, "estimatedCostToComplete");
  if (est === null) throw new ComplianceError("estimatedCostToComplete is required");
  const estimateDate = parseDate(input.estimateDate, "estimateDate");
  if (!estimateDate) throw new ComplianceError("estimateDate is required");
  const e: CostToCompleteEstimate = {
    id: dmv.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    budgetLineId: line.id,
    drawRequestId,
    verifiedCompletedValue: wholeCurrency(input.verifiedCompletedValue, "verifiedCompletedValue"),
    remainingCommittedCost: wholeCurrency(input.remainingCommittedCost, "remainingCommittedCost"),
    estimatedCostToComplete: est,
    sourceOfEstimate: requireText(input.sourceOfEstimate, "sourceOfEstimate", 200),
    estimatorUserId: user.id,
    estimateDate,
    confidence: confidence as CostToCompleteEstimate["confidence"],
    notes: optText(input.notes, "notes"),
    createdAt: nowIso(),
  };
  dmv.insertEstimate(e);
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "COST_TO_COMPLETE_RECORDED",
    entityType: "cost_to_complete_estimate",
    entityId: e.id,
    reason: null,
    beforeSummary: null,
    afterSummary: `Line ${line.code}: estimated ${est} to complete (${confidence})`,
  });
  return e;
}

/** Per-line cost summary. All figures preserved separately — original
 *  budget, approved changes, revised budget, prior funded, current
 *  requested, estimate — never blended or overwritten. */
export interface LineCostSummary {
  budgetLineId: string;
  budgetLineCode: string;
  originalBudget: number;
  approvedChanges: number;
  revisedBudget: number;
  priorFunded: number;
  currentRequested: number;
  cumulativeRequested: number;
  remainingBudget: number;
  verifiedCompletedValue: number | null;
  remainingCommittedCost: number | null;
  estimatedCostToComplete: number;
  /** Recorded estimate vs derived-from-budget fallback (labeled). */
  estimateSource: string;
  estimateConfidence: "LOW" | "MEDIUM" | "HIGH" | null;
  estimateDate: string | null;
  estimatorUserId: string | null;
  projectedFinalCost: number;
  /** revisedBudget − projectedFinalCost; negative = projected overrun. */
  projectedVariance: number;
}

export function lineCostSummary(
  budgetLine: BudgetLine,
  priorFunded: number,
  currentRequested: number,
  estimate: CostToCompleteEstimate | null
): LineCostSummary {
  const revisedBudget = budgetLine.originalBudget + budgetLine.approvedChanges;
  const cumulativeRequested = priorFunded + currentRequested;
  const remainingBudget = revisedBudget - cumulativeRequested;
  const estimatedCostToComplete = estimate
    ? estimate.estimatedCostToComplete
    : Math.max(remainingBudget, 0);
  const projectedFinalCost = cumulativeRequested + estimatedCostToComplete;
  return {
    budgetLineId: budgetLine.id,
    budgetLineCode: budgetLine.code,
    originalBudget: budgetLine.originalBudget,
    approvedChanges: budgetLine.approvedChanges,
    revisedBudget,
    priorFunded,
    currentRequested,
    cumulativeRequested,
    remainingBudget,
    verifiedCompletedValue: estimate?.verifiedCompletedValue ?? null,
    remainingCommittedCost: estimate?.remainingCommittedCost ?? null,
    estimatedCostToComplete,
    estimateSource: estimate ? estimate.sourceOfEstimate : "DERIVED_FROM_BUDGET",
    estimateConfidence: estimate?.confidence ?? null,
    estimateDate: estimate?.estimateDate ?? null,
    estimatorUserId: estimate?.estimatorUserId ?? null,
    projectedFinalCost,
    projectedVariance: revisedBudget - projectedFinalCost,
  };
}

// ===================================================================
// DMV Draw Control Record
// ===================================================================

export interface EligibilityReason {
  code: string;
  status: LineEligibilityStatus;
  message: string;
}

export interface RequirementSnapshot {
  id: string;
  inspectionType: string;
  inspectionAuthority: string | null;
  status: LineInspectionStatus;
  requiredBeforePayment: boolean;
  officialResultText: string | null;
  officialSourceId: string | null;
  jurisdictionalInspectionId: string | null;
  lookupAt: string | null;
  externalIdentifier: string | null;
}

export interface BasisSnapshot {
  permitId: string;
  permitNumber: string;
  permitType: string;
  basisVersionId: string;
  version: number;
  governingBasis: GoverningBasisKind;
  governingCodeEdition: string | null;
  jurisdiction: string;
  permittingAuthority: string;
  /** Live permit control status (derived; the basis record is unchanged). */
  permitControlStatus: string;
}

/** One line of the DMV Draw Control Record — the per-draw, per-budget-line
 *  verification-control read model. Contractor-reported, inspector-observed,
 *  government-record, and lender-decision figures are kept as SEPARATE
 *  fields; the final status is verification eligibility for lender review,
 *  never a lender approval. */
export interface DrawControlLine {
  drawLineItemId: string;
  budgetLineRef: string | null;
  budgetLineId: string | null;
  budgetLineCode: string | null;
  scopeDescription: string;
  jurisdiction: string | null;
  governingBases: BasisSnapshot[];
  // -- contractor-reported --
  borrowerRequestedAmount: number;
  contractorPercentComplete: number | null;
  contractorCompletedAmount: number | null;
  // -- evidence --
  photoEvidenceCount: number;
  verifiedPhotoEvidenceCount: number;
  invoiceDocumentCount: number;
  lienWaiverStatus: string;
  // -- OBV inspector-observed (never an official government result) --
  drawInspectorFinding: string;
  inspectorObservedPercent: number | null;
  inspectorSupportedAmount: number | null;
  // -- official jurisdiction inspections (separate from field findings) --
  requiredInspections: RequirementSnapshot[];
  // -- financial control --
  priorFunded: number;
  currentRequested: number;
  cumulativeRequested: number;
  remainingBudget: number | null;
  estimatedCostToComplete: number | null;
  projectedVariance: number | null;
  costSummary: LineCostSummary | null;
  retainageAmount: number | null;
  // -- exceptions / holds --
  openExceptions: { id: string; severity: string; category: string; title: string; blocking: boolean }[];
  reviewerNotes: string | null;
  // -- outcome --
  finalEligibilityStatus: LineEligibilityStatus;
  eligibilityReasons: EligibilityReason[];
}

export interface DrawControlRecord {
  drawRequestId: string;
  drawNumber: number;
  projectId: string;
  projectName: string;
  jurisdictionSummary: string[];
  generatedAt: string;
  scopeNote: string;
  legalNote: string;
  eligibleWording: string;
  disputeHold: { blocked: boolean; legalHold: boolean; reasons: string[] };
  pinnedBases: DrawPermitBasisPin[];
  lines: DrawControlLine[];
}

function getDrawFor(user: User, drawRequestId: string): { draw: DrawRequest; project: Project } {
  const draw = repo.getDrawRequest(drawRequestId);
  const project = draw ? repo.getProject(draw.projectId) : null;
  if (!draw || !project || !canAccessProjectFinance(user, project)) {
    throw new ComplianceError("Draw request not found", 404);
  }
  return { draw, project };
}

/** Resolve a draw line's free-form budgetLineId to a configured budget
 *  line — it may hold either the budget line's id or its cost code. */
function resolveBudgetLine(projectLines: BudgetLine[], ref: string | null): BudgetLine | null {
  if (!ref) return null;
  return projectLines.find((b) => b.id === ref) ?? projectLines.find((b) => b.code === ref) ?? null;
}

const BLOCKING_EXCEPTION_SEVERITIES = new Set(["HIGH", "CRITICAL"]);
const OPEN_EXCEPTION_STATUSES = new Set(["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"]);

/** Requirement statuses that keep an official inspection outstanding. */
const INSPECTION_BLOCKING: Set<LineInspectionStatus> = new Set([
  "REQUIRED_NOT_SCHEDULED", "SCHEDULED", "FAILED", "CORRECTION_REQUIRED",
  "REINSPECTION_REQUIRED", "NOT_FOUND", "UNKNOWN",
]);

/** Precedence for the final status: the first status in this order with at
 *  least one reason wins. Explicit and documented — no hidden scoring. */
const ELIGIBILITY_PRECEDENCE: LineEligibilityStatus[] = [
  "HELD_BY_LEGAL_HOLD", "HELD_BY_DISPUTE", "INELIGIBLE", "EXCEPTION_OPEN",
  "INSPECTION_REQUIRED", "OFFICIAL_STATUS_PENDING", "EVIDENCE_INCOMPLETE",
  "OVER_BUDGET_REVIEW_REQUIRED", "NOT_READY",
];

/** Generate the DMV Draw Control Record for a draw. Read-model generation
 *  with ONE deliberate write: pinning the currently authoritative basis
 *  version per permit to the draw (first pin wins permanently), so the
 *  draw keeps referencing the version that applied when it was reviewed.
 *  Never sets any "approved" state and never reaches banking tables. */
export function drawControlRecord(user: User, drawRequestId: string): DrawControlRecord {
  const { draw, project } = getDrawFor(user, drawRequestId);
  const generatedAt = nowIso();

  // Pin the authoritative basis of every project permit that has one.
  // INSERT OR IGNORE: an existing pin for (draw, permit) always wins.
  const permits = repo.listPermitsForProject(project.id);
  for (const p of permits) {
    const auth = dmv.authoritativeBasisForPermit(p.id);
    if (auth) {
      dmv.pinDrawBasis({
        id: dmv.newId(),
        drawRequestId: draw.id,
        permitId: p.id,
        permitBasisVersionId: auth.id,
        pinnedAt: generatedAt,
        pinnedByUserId: user.id,
      });
    }
  }
  const pins = dmv.listPinsForDraw(draw.id);
  const basisByPermit = new Map<string, PermitBasisVersion>();
  for (const pin of pins) {
    const b = dmv.getPermitBasis(pin.permitBasisVersionId);
    if (b) basisByPermit.set(pin.permitId, b);
  }
  const permitById = new Map(permits.map((p) => [p.id, p]));

  const budgetLines = repo.listBudgetLines(project.id);
  const requirements = dmv.listLineRequirementsForProject(project.id);
  const exceptions = repo
    .listExceptionsForProject(project.id)
    .filter((x) => OPEN_EXCEPTION_STATUSES.has(x.status));
  const waivers = lrepo.listLienWaivers(draw.id);
  const docs = repo.listDrawDocuments(draw.id);
  const evidenceLinks = repo.listDrawEvidenceLinks(draw.id);
  const hold = drawDisputeHold(draw.id);
  const lines = repo.listDrawLines(draw.id);
  const hasAnyAuthoritativeBasis = [...basisByPermit.values()].length > 0;

  const controlLines = lines.map((line) =>
    buildControlLine({
      line,
      draw,
      budgetLines,
      requirements,
      exceptions,
      waivers,
      docs,
      evidenceLinks,
      hold,
      basisByPermit,
      permitById,
      hasAnyAuthoritativeBasis,
      generatedAt,
    })
  );

  const jurisdictions = [
    ...new Set([...basisByPermit.values()].map((b) => b.jurisdiction)),
  ].sort();

  return {
    drawRequestId: draw.id,
    drawNumber: draw.drawNumber,
    projectId: project.id,
    projectName: project.name,
    jurisdictionSummary: jurisdictions,
    generatedAt,
    scopeNote: DMV_SCOPE_NOTE,
    legalNote: NOT_LEGAL_ADVICE_NOTE,
    eligibleWording: ELIGIBLE_WORDING,
    disputeHold: { blocked: hold.blocked, legalHold: hold.legalHold, reasons: hold.blockedReasons },
    pinnedBases: pins,
    lines: controlLines,
  };
}

interface BuildLineCtx {
  line: DrawLineItem;
  draw: DrawRequest;
  budgetLines: BudgetLine[];
  requirements: LineInspectionRequirement[];
  exceptions: ObvException[];
  waivers: ReturnType<typeof lrepo.listLienWaivers>;
  docs: ReturnType<typeof repo.listDrawDocuments>;
  evidenceLinks: ReturnType<typeof repo.listDrawEvidenceLinks>;
  hold: ReturnType<typeof drawDisputeHold>;
  basisByPermit: Map<string, PermitBasisVersion>;
  permitById: Map<string, import("../../shared/types").Permit>;
  hasAnyAuthoritativeBasis: boolean;
  generatedAt: string;
}

const INVOICE_DOC_TYPES = new Set(["CONTRACTOR_INVOICE", "PAY_APPLICATION", "MATERIAL_INVOICE"]);

function buildControlLine(ctx: BuildLineCtx): DrawControlLine {
  const { line, generatedAt } = ctx;
  const reasons: EligibilityReason[] = [];
  const add = (status: LineEligibilityStatus, code: string, message: string) =>
    reasons.push({ code, status, message });

  const budgetLine = resolveBudgetLine(ctx.budgetLines, line.budgetLineId);

  // Requirements scoped to this line: by budget line (id or raw ref) or by
  // the line's anchored milestone.
  const lineReqs = ctx.requirements.filter(
    (r) =>
      (r.budgetLineId &&
        (r.budgetLineId === budgetLine?.id || r.budgetLineId === line.budgetLineId)) ||
      (r.milestoneId && line.milestoneId && r.milestoneId === line.milestoneId)
  );

  // Governing bases relevant to this line: pinned basis versions for the
  // permits its requirements reference; all pinned bases if unmapped.
  const linePermitIds = [...new Set(lineReqs.map((r) => r.permitId).filter((x): x is string => Boolean(x)))];
  const relevantBases =
    linePermitIds.length > 0
      ? linePermitIds
          .map((pid) => ctx.basisByPermit.get(pid))
          .filter((b): b is PermitBasisVersion => Boolean(b))
      : [...ctx.basisByPermit.values()];

  const governingBases: BasisSnapshot[] = relevantBases.map((b) => {
    const permit = ctx.permitById.get(b.permitId);
    return {
      permitId: b.permitId,
      permitNumber: b.permitNumber,
      permitType: b.permitType,
      basisVersionId: b.id,
      version: b.version,
      governingBasis: b.governingBasis,
      governingCodeEdition: b.governingCodeEdition,
      jurisdiction: b.jurisdiction,
      permittingAuthority: b.permittingAuthority,
      permitControlStatus: permit ? effectiveStatus(permit, generatedAt) : "UNKNOWN",
    };
  });

  // 1-2. Dispute / legal holds (draw-wide; a hold on the draw holds every line).
  if (ctx.hold.legalHold) {
    add("HELD_BY_LEGAL_HOLD", "LEGAL_HOLD", "A legal hold on an attached dispute holds this draw.");
  }
  if (ctx.hold.blocked && !ctx.hold.legalHold) {
    add("HELD_BY_DISPUTE", "DISPUTE_HOLD", ctx.hold.blockedReasons[0] ?? "An active dispute holds this draw.");
  }

  // 3. Ineligible: rejected by the reviewer, or governed by a permit whose
  //    live control status is expired/revoked/suspended.
  if (line.status === "REJECTED") {
    add("INELIGIBLE", "LINE_REJECTED", "The draw reviewer rejected this line.");
  }
  for (const b of governingBases) {
    if (b.permitControlStatus === "EXPIRED" || b.permitControlStatus === "REVOKED" || b.permitControlStatus === "SUSPENDED") {
      add(
        "INELIGIBLE",
        `PERMIT_${b.permitControlStatus}`,
        `Permit ${b.permitNumber} is ${b.permitControlStatus} for control purposes.`
      );
    }
  }

  // 4. Open exceptions scoped to this line (or its budget line) at HIGH /
  //    CRITICAL severity, or a reviewer EXCEPTION finding on the line.
  const lineExceptions = ctx.exceptions.filter(
    (x) =>
      (x.budgetLineId && (x.budgetLineId === budgetLine?.id || x.budgetLineId === line.budgetLineId)) ||
      (x.drawRequestId === ctx.draw.id && !x.budgetLineId) ||
      (x.milestoneId && line.milestoneId && x.milestoneId === line.milestoneId)
  );
  const openExceptions = lineExceptions.map((x) => ({
    id: x.id,
    severity: x.severity,
    category: x.category,
    title: x.title,
    blocking: BLOCKING_EXCEPTION_SEVERITIES.has(x.severity),
  }));
  for (const x of openExceptions) {
    if (x.blocking) {
      add("EXCEPTION_OPEN", "OPEN_EXCEPTION", `Open ${x.severity} exception: ${x.title}`);
    }
  }
  if (line.status === "EXCEPTION") {
    add("EXCEPTION_OPEN", "LINE_EXCEPTION_FINDING", "The draw reviewer recorded an exception finding on this line.");
  }

  // 5-6. Required official inspections. FAILED and CORRECTION_REQUIRED
  //      also block — a failed official inspection is outstanding work.
  for (const r of lineReqs) {
    if (!r.requiredBeforePayment) continue;
    if (INSPECTION_BLOCKING.has(r.status)) {
      add(
        "INSPECTION_REQUIRED",
        `INSPECTION_${r.status}`,
        `Official ${r.inspectionType} inspection is ${r.status.replaceAll("_", " ").toLowerCase()}.`
      );
    } else if (r.status === "PENDING_OFFICIAL_CONFIRMATION") {
      add(
        "OFFICIAL_STATUS_PENDING",
        "OFFICIAL_CONFIRMATION_PENDING",
        `Official ${r.inspectionType} result is pending confirmation from the jurisdiction record.`
      );
    }
  }

  // 7. Evidence completeness. Photo evidence must be line-scoped links to
  //    VERIFIED evidence items; invoices are line-scoped draw documents;
  //    lien waivers must be ACCEPTED or NOT_REQUIRED.
  const lineLinks = ctx.evidenceLinks.filter((l) => l.lineItemId === line.id);
  let verifiedPhotoCount = 0;
  for (const l of lineLinks) {
    const v = repo.getVerificationForEvidence(l.evidenceItemId);
    if (v && v.verdict === "VERIFIED") verifiedPhotoCount++;
  }
  if (verifiedPhotoCount === 0) {
    add("EVIDENCE_INCOMPLETE", "PHOTO_EVIDENCE_MISSING", "No verified photo evidence is linked to this line.");
  }
  const invoiceDocs = ctx.docs.filter(
    (d) => d.lineItemId === line.id && INVOICE_DOC_TYPES.has(d.docType) && (d.status === "RECEIVED" || d.status === "ACCEPTED")
  );
  if (invoiceDocs.length === 0) {
    add("EVIDENCE_INCOMPLETE", "INVOICE_MISSING", "No contractor invoice or pay application is on file for this line.");
  }
  const lineWaivers = ctx.waivers.filter((w) => w.drawLineItemId === line.id || w.drawLineItemId === null);
  let lienWaiverStatus = "NOT_RECORDED";
  if (lineWaivers.length > 0) {
    const best =
      lineWaivers.find((w) => w.status === "ACCEPTED") ??
      lineWaivers.find((w) => w.status === "NOT_REQUIRED") ??
      lineWaivers[lineWaivers.length - 1];
    lienWaiverStatus = best.status;
  }
  if (lienWaiverStatus === "NOT_RECORDED") {
    add("EVIDENCE_INCOMPLETE", "LIEN_WAIVER_MISSING", "No lien waiver record exists for this line.");
  } else if (lienWaiverStatus !== "ACCEPTED" && lienWaiverStatus !== "NOT_REQUIRED") {
    add(
      "EVIDENCE_INCOMPLETE",
      "LIEN_WAIVER_NOT_ACCEPTED",
      `The lien waiver for this line is ${lienWaiverStatus}, not ACCEPTED.`
    );
  }
  if (
    line.percentCompleteClaimed !== null &&
    line.percentCompleteVerified !== null &&
    line.percentCompleteClaimed > line.percentCompleteVerified
  ) {
    add(
      "EVIDENCE_INCOMPLETE",
      "CLAIM_EXCEEDS_INSPECTOR",
      `Contractor claims ${line.percentCompleteClaimed}% complete but the OBV inspector observed ${line.percentCompleteVerified}%.`
    );
  }

  // 8. Budget / cost-to-complete review.
  const priorFunded = line.previouslyPaid;
  const currentRequested = line.currentRequested;
  let costSummary: LineCostSummary | null = null;
  if (budgetLine) {
    const estimate = dmv.latestEstimateForLine(budgetLine.id);
    costSummary = lineCostSummary(budgetLine, priorFunded, currentRequested, estimate);
    if (costSummary.cumulativeRequested > costSummary.revisedBudget) {
      add(
        "OVER_BUDGET_REVIEW_REQUIRED",
        "CUMULATIVE_OVER_BUDGET",
        `Cumulative requested ${costSummary.cumulativeRequested} exceeds the revised budget ${costSummary.revisedBudget}.`
      );
    }
    if (costSummary.projectedVariance < 0) {
      add(
        "OVER_BUDGET_REVIEW_REQUIRED",
        "PROJECTED_OVERRUN",
        `Projected final cost ${costSummary.projectedFinalCost} exceeds the revised budget by ${-costSummary.projectedVariance}.`
      );
    }
  }

  // 9. Not ready: no reviewer finding yet, or no governing basis.
  if (line.status === "PENDING") {
    add("NOT_READY", "REVIEW_PENDING", "The draw reviewer has not recorded a finding for this line.");
  }
  if (!ctx.hasAnyAuthoritativeBasis) {
    add("NOT_READY", "NO_AUTHORITATIVE_BASIS", "No authoritative Governing Code and Permit Basis exists for this project.");
  } else if (governingBases.length === 0) {
    add("NOT_READY", "NO_BASIS_FOR_LINE", "No governing permit basis is mapped to this line.");
  }
  for (const b of relevantBases) {
    if (b.governingBasis === "UNRESOLVED") {
      add(
        "NOT_READY",
        "BASIS_UNRESOLVED",
        `The governing basis for permit ${b.permitNumber} is UNRESOLVED — an authorized reviewer must confirm it.`
      );
    }
  }

  // Final status: first precedence bucket with a reason; otherwise eligible
  // for lender review (never "approved" — the lender decision workflow is
  // a separate human act).
  let finalStatus: LineEligibilityStatus = "ELIGIBLE_FOR_LENDER_REVIEW";
  for (const status of ELIGIBILITY_PRECEDENCE) {
    if (reasons.some((r) => r.status === status)) {
      finalStatus = status;
      break;
    }
  }
  if (finalStatus === "ELIGIBLE_FOR_LENDER_REVIEW") {
    add("ELIGIBLE_FOR_LENDER_REVIEW", "ELIGIBLE", ELIGIBLE_WORDING);
  }

  const claimedAmount =
    line.percentCompleteClaimed === null
      ? null
      : Math.round((line.scheduledValue * line.percentCompleteClaimed) / 100);

  return {
    drawLineItemId: line.id,
    budgetLineRef: line.budgetLineId,
    budgetLineId: budgetLine?.id ?? null,
    budgetLineCode: budgetLine?.code ?? null,
    scopeDescription: line.description,
    jurisdiction: governingBases[0]?.jurisdiction ?? null,
    governingBases,
    borrowerRequestedAmount: currentRequested,
    contractorPercentComplete: line.percentCompleteClaimed,
    contractorCompletedAmount: claimedAmount,
    photoEvidenceCount: lineLinks.length,
    verifiedPhotoEvidenceCount: verifiedPhotoCount,
    invoiceDocumentCount: invoiceDocs.length,
    lienWaiverStatus,
    drawInspectorFinding: line.status,
    inspectorObservedPercent: line.percentCompleteVerified,
    inspectorSupportedAmount: line.supportedAmount,
    requiredInspections: lineReqs.map((r) => ({
      id: r.id,
      inspectionType: r.inspectionType,
      inspectionAuthority: r.inspectionAuthority,
      status: r.status,
      requiredBeforePayment: r.requiredBeforePayment,
      officialResultText: r.officialResultText,
      officialSourceId: r.officialSourceId,
      jurisdictionalInspectionId: r.jurisdictionalInspectionId,
      lookupAt: r.lookupAt,
      externalIdentifier: r.externalIdentifier,
    })),
    priorFunded,
    currentRequested,
    cumulativeRequested: priorFunded + currentRequested,
    remainingBudget: costSummary?.remainingBudget ?? null,
    estimatedCostToComplete: costSummary?.estimatedCostToComplete ?? null,
    projectedVariance: costSummary?.projectedVariance ?? null,
    costSummary,
    retainageAmount: line.retainageAmount,
    openExceptions,
    reviewerNotes: line.reviewNotes,
    finalEligibilityStatus: finalStatus,
    eligibilityReasons: reasons,
  };
}

// ===================================================================
// Project compliance read model (for UI + registers)
// ===================================================================

export interface ProjectComplianceView {
  project: Project;
  bases: PermitBasisVersion[];
  transitionRules: TransitionRuleRecord[];
  requirements: LineInspectionRequirement[];
  verifications: SourceVerification[];
  estimates: CostToCompleteEstimate[];
  scopeNote: string;
  legalNote: string;
}

export function projectCompliance(user: User, projectId: string): ProjectComplianceView {
  const project = assertProjectAccess(user, projectId);
  return {
    project,
    bases: dmv.listPermitBasisForProject(project.id),
    transitionRules: dmv.listTransitionRulesForProject(project.id),
    requirements: dmv.listLineRequirementsForProject(project.id),
    verifications: dmv.listSourceVerificationsForProject(project.id),
    estimates: dmv.listEstimatesForProject(project.id),
    scopeNote: DMV_SCOPE_NOTE,
    legalNote: NOT_LEGAL_ADVICE_NOTE,
  };
}

/** True when a project uses the DMV compliance layer at all — the guard
 *  that keeps DMV exception rules and package sections away from projects
 *  that never adopted it. */
export function projectUsesDmvCompliance(projectId: string): boolean {
  return (
    dmv.listPermitBasisForProject(projectId).length > 0 ||
    dmv.listLineRequirementsForProject(projectId).length > 0
  );
}
