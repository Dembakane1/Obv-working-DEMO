/**
 * Loan & asset profile, project parties, jurisdiction profile and lender
 * draw policy — administrative lender records.
 *
 * The governed OBV records stay authoritative everywhere they overlap:
 * project.totalBudget / budget_lines for construction budget, the
 * retainage service for retainage, approval_policies for formal
 * governance. Loan-profile figures are external references; differences
 * are labelled by reconcileLoanBudget(), never silently synchronized.
 * Ownership and servicing history are append-only.
 */
import * as repo from "../db/repo";
import * as lrepo from "../db/lenderRepo";
import { audit } from "./pilot/onboarding";
import {
  LenderError,
  assertCapability,
  assertProjectAccess,
} from "./lenderAccess";
import type {
  JurisdictionProfile,
  JurisdictionTemplateKey,
  LenderDrawPolicy,
  LoanAsset,
  LoanOwnershipEvent,
  LoanServicingEvent,
  Project,
  ProjectPartyAssignment,
  ProjectPartyType,
  User,
} from "../../shared/types";

const NOT_RECORDED = "NOT RECORDED";

// Roles allowed to maintain administrative lender records without an
// explicit membership (conservative: the two review roles only).
const ADMIN_RECORD_ROLES: User["role"][] = ["FUNDER_REP", "COMPLIANCE_REVIEWER"];

function assertRecorder(user: User, projectId: string): void {
  if (ADMIN_RECORD_ROLES.includes(user.role)) return;
  assertCapability(user, projectId, "MANAGE_PROJECT_CONFIGURATION");
}

function assertOrgRef(id: string | null | undefined, label: string): string | null {
  const v = (id ?? "").trim();
  if (!v) return null;
  if (!repo.getOrganization(v)) throw new LenderError(`${label} references an unknown organization`, 422);
  return v;
}

function assertUserRef(id: string | null | undefined, label: string): string | null {
  const v = (id ?? "").trim();
  if (!v) return null;
  if (!repo.getUser(v)) throw new LenderError(`${label} references an unknown user`, 422);
  return v;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new LenderError("Amounts must be non-negative numbers", 400);
  return Math.round(n);
};

// ------------------------------------------------------------ loan asset

export function createLoanAsset(
  user: User,
  input: Partial<LoanAsset> & { projectId: string; loanNumber: string }
): LoanAsset {
  const project = assertProjectAccess(user, input.projectId);
  assertRecorder(user, project.id);
  const loanNumber = (input.loanNumber ?? "").trim();
  if (!loanNumber) throw new LenderError("loanNumber is required", 400);
  if (lrepo.getLoanAssetForProject(project.id)) {
    throw new LenderError("A loan profile already exists for this project", 409);
  }
  const now = new Date().toISOString();
  const asset: LoanAsset = {
    id: lrepo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    loanNumber,
    propertyAddress: input.propertyAddress?.trim() || null,
    propertyType: input.propertyType?.trim() || null,
    borrowerOrganizationId: assertOrgRef(input.borrowerOrganizationId, "borrowerOrganizationId"),
    primaryContractorOrganizationId: assertOrgRef(input.primaryContractorOrganizationId, "primaryContractorOrganizationId"),
    lenderOrganizationId: assertOrgRef(input.lenderOrganizationId, "lenderOrganizationId"),
    originalLoanAmount: num(input.originalLoanAmount),
    currentLoanAmount: num(input.currentLoanAmount),
    originalConstructionBudget: num(input.originalConstructionBudget),
    currentApprovedConstructionBudget: num(input.currentApprovedConstructionBudget),
    originalConstructionReserve: num(input.originalConstructionReserve),
    currentConstructionReserve: num(input.currentConstructionReserve),
    closingDate: input.closingDate?.trim() || null,
    estimatedConstructionCompletionDate: input.estimatedConstructionCompletionDate?.trim() || null,
    originalMaturityDate: input.originalMaturityDate?.trim() || null,
    currentMaturityDate: input.currentMaturityDate?.trim() || null,
    servicingSystemName: input.servicingSystemName?.trim() || null,
    servicingSystemReference: input.servicingSystemReference?.trim() || null,
    currentServicerOrganizationId: assertOrgRef(input.currentServicerOrganizationId, "currentServicerOrganizationId"),
    currentLoanOwnerOrganizationId: assertOrgRef(input.currentLoanOwnerOrganizationId, "currentLoanOwnerOrganizationId"),
    warehouseLenderOrganizationId: assertOrgRef(input.warehouseLenderOrganizationId, "warehouseLenderOrganizationId"),
    secondaryMarketPurchaserOrganizationId: assertOrgRef(input.secondaryMarketPurchaserOrganizationId, "secondaryMarketPurchaserOrganizationId"),
    occupancyType: input.occupancyType?.trim() || null,
    loanPurpose: input.loanPurpose?.trim() || null,
    riskLevel: (["LOW", "MEDIUM", "HIGH", "UNRATED"] as const).includes(input.riskLevel as never)
      ? (input.riskLevel as LoanAsset["riskLevel"])
      : "UNRATED",
    status: (["ACTIVE", "PAID_OFF", "DEFAULTED", "TRANSFERRED", "CLOSED", "UNKNOWN"] as const).includes(input.status as never)
      ? (input.status as LoanAsset["status"])
      : "ACTIVE",
    inspectorAssignedUserId: assertUserRef(input.inspectorAssignedUserId, "inspectorAssignedUserId"),
    lenderReviewerAssignedUserId: assertUserRef(input.lenderReviewerAssignedUserId, "lenderReviewerAssignedUserId"),
    createdAt: now,
    updatedAt: now,
  };
  lrepo.insertLoanAsset(asset);
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "LOAN_ASSET_CREATED",
    entityType: "loan_asset",
    entityId: asset.id,
    reason: null,
    beforeSummary: null,
    afterSummary: `Loan ${asset.loanNumber} recorded (administrative profile)`,
  });
  return asset;
}

export function updateLoanAsset(user: User, loanAssetId: string, patch: Partial<LoanAsset>): LoanAsset {
  const cur = lrepo.getLoanAsset(loanAssetId);
  if (!cur) throw new LenderError("Loan profile not found", 404);
  const project = assertProjectAccess(user, cur.projectId);
  assertRecorder(user, project.id);
  // Owner/servicer changes must go through the append-only history events.
  const forbidden: Array<keyof LoanAsset> = [
    "id", "organizationId", "projectId", "createdAt",
    "currentLoanOwnerOrganizationId", "currentServicerOrganizationId",
  ];
  for (const k of forbidden) {
    if (k in patch && (patch as unknown as Record<string, unknown>)[k] !== (cur as unknown as Record<string, unknown>)[k]) {
      throw new LenderError(
        k === "currentLoanOwnerOrganizationId" || k === "currentServicerOrganizationId"
          ? "Ownership and servicing change only through their history events"
          : `${k} is immutable`,
        409
      );
    }
  }
  for (const key of [
    "borrowerOrganizationId", "primaryContractorOrganizationId", "lenderOrganizationId",
    "warehouseLenderOrganizationId", "secondaryMarketPurchaserOrganizationId",
  ] as const) {
    if (key in patch) (patch as unknown as Record<string, unknown>)[key] = assertOrgRef(patch[key], key);
  }
  for (const key of [
    "originalLoanAmount", "currentLoanAmount", "originalConstructionBudget",
    "currentApprovedConstructionBudget", "originalConstructionReserve", "currentConstructionReserve",
  ] as const) {
    if (key in patch) (patch as unknown as Record<string, unknown>)[key] = num(patch[key]);
  }
  lrepo.updateLoanAsset(loanAssetId, patch);
  audit({
    projectId: project.id,
    actorUserId: user.id,
    action: "LOAN_ASSET_UPDATED",
    entityType: "loan_asset",
    entityId: loanAssetId,
    reason: null,
    beforeSummary: null,
    afterSummary: `Loan ${cur.loanNumber} administrative profile updated`,
  });
  return lrepo.getLoanAsset(loanAssetId)!;
}

export function recordOwnershipTransfer(
  user: User,
  loanAssetId: string,
  input: { newOwnerOrganizationId: string; effectiveAt: string; transferType?: string | null; reference?: string | null }
): LoanOwnershipEvent {
  const asset = lrepo.getLoanAsset(loanAssetId);
  if (!asset) throw new LenderError("Loan profile not found", 404);
  const project = assertProjectAccess(user, asset.projectId);
  assertRecorder(user, project.id);
  const newOwner = assertOrgRef(input.newOwnerOrganizationId, "newOwnerOrganizationId");
  if (!newOwner) throw new LenderError("newOwnerOrganizationId is required", 400);
  const effectiveAt = (input.effectiveAt ?? "").trim();
  if (!effectiveAt) throw new LenderError("effectiveAt is required", 400);
  const event: LoanOwnershipEvent = {
    id: lrepo.newId(),
    loanAssetId,
    priorOwnerOrganizationId: asset.currentLoanOwnerOrganizationId,
    newOwnerOrganizationId: newOwner,
    effectiveAt,
    transferType: input.transferType?.trim() || null,
    reference: input.reference?.trim() || null,
    recordedByUserId: user.id,
    createdAt: new Date().toISOString(),
  };
  lrepo.insertLoanOwnershipEvent(event);
  // Update the derived pointer WITHOUT rewriting history.
  lrepo.updateLoanAsset(loanAssetId, { currentLoanOwnerOrganizationId: newOwner } as Partial<LoanAsset>);
  return event;
}

export function recordServicingTransfer(
  user: User,
  loanAssetId: string,
  input: { newServicerOrganizationId: string; effectiveAt: string; reference?: string | null }
): LoanServicingEvent {
  const asset = lrepo.getLoanAsset(loanAssetId);
  if (!asset) throw new LenderError("Loan profile not found", 404);
  const project = assertProjectAccess(user, asset.projectId);
  assertRecorder(user, project.id);
  const newServicer = assertOrgRef(input.newServicerOrganizationId, "newServicerOrganizationId");
  if (!newServicer) throw new LenderError("newServicerOrganizationId is required", 400);
  const effectiveAt = (input.effectiveAt ?? "").trim();
  if (!effectiveAt) throw new LenderError("effectiveAt is required", 400);
  const event: LoanServicingEvent = {
    id: lrepo.newId(),
    loanAssetId,
    priorServicerOrganizationId: asset.currentServicerOrganizationId,
    newServicerOrganizationId: newServicer,
    effectiveAt,
    reference: input.reference?.trim() || null,
    recordedByUserId: user.id,
    createdAt: new Date().toISOString(),
  };
  lrepo.insertLoanServicingEvent(event);
  lrepo.updateLoanAsset(loanAssetId, { currentServicerOrganizationId: newServicer } as Partial<LoanAsset>);
  return event;
}

/** Labelled reconciliation between the loan profile's EXTERNAL figures and
 *  the governed OBV budget. Differences are surfaced, never synchronized. */
export function reconcileLoanBudget(asset: LoanAsset, project: Project): Array<{
  field: string;
  loanProfileValue: number | string;
  obvValue: number;
  note: string;
}> {
  const findings: Array<{ field: string; loanProfileValue: number | string; obvValue: number; note: string }> = [];
  const obvBudget = project.totalBudget;
  if (asset.currentApprovedConstructionBudget !== null && asset.currentApprovedConstructionBudget !== obvBudget) {
    findings.push({
      field: "currentApprovedConstructionBudget",
      loanProfileValue: asset.currentApprovedConstructionBudget,
      obvValue: obvBudget,
      note: "Loan-profile figure is an external servicing reference; the governed OBV project budget remains authoritative for verification.",
    });
  }
  if (asset.currentApprovedConstructionBudget === null) {
    findings.push({
      field: "currentApprovedConstructionBudget",
      loanProfileValue: NOT_RECORDED,
      obvValue: obvBudget,
      note: "External approved budget not recorded.",
    });
  }
  return findings;
}

// ------------------------------------------------------------ parties

const PARTY_TYPES: ProjectPartyType[] = [
  "BORROWER", "CONTRACTOR", "LENDER", "SERVICER", "WAREHOUSE_LENDER",
  "SECONDARY_MARKET_PURCHASER", "TITLE_COMPANY", "INSPECTION_COMPANY",
  "GOVERNMENT_AUTHORITY", "CONSULTANT", "OTHER",
];

export function assignParty(
  user: User,
  input: {
    projectId: string;
    partyOrganizationId: string;
    partyType: ProjectPartyType;
    effectiveFrom?: string | null;
    reference?: string | null;
    notes?: string | null;
  }
): ProjectPartyAssignment {
  const project = assertProjectAccess(user, input.projectId);
  assertRecorder(user, project.id);
  if (!PARTY_TYPES.includes(input.partyType)) {
    throw new LenderError(`partyType must be one of ${PARTY_TYPES.join(", ")}`, 400);
  }
  const partyOrg = assertOrgRef(input.partyOrganizationId, "partyOrganizationId");
  if (!partyOrg) throw new LenderError("partyOrganizationId is required", 400);
  // History preserved: an existing active assignment of the same type for a
  // DIFFERENT organization is ended (not deleted); duplicates are rejected.
  const now = new Date().toISOString();
  for (const existing of lrepo.listPartyAssignments(project.id)) {
    if (!existing.active || existing.partyType !== input.partyType) continue;
    if (existing.partyOrganizationId === partyOrg) {
      throw new LenderError("This organization already holds this party role", 409);
    }
    lrepo.endPartyAssignment(existing.id, now);
  }
  const assignment: ProjectPartyAssignment = {
    id: lrepo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    partyOrganizationId: partyOrg,
    partyType: input.partyType,
    effectiveFrom: input.effectiveFrom?.trim() || now,
    effectiveTo: null,
    active: true,
    reference: input.reference?.trim() || null,
    notes: input.notes?.trim() || null,
    createdByUserId: user.id,
    createdAt: now,
  };
  lrepo.insertPartyAssignment(assignment);
  return assignment;
}

export function endParty(user: User, projectId: string, assignmentId: string): void {
  const project = assertProjectAccess(user, projectId);
  assertRecorder(user, project.id);
  const assignment = lrepo.getPartyAssignment(assignmentId);
  if (!assignment || assignment.projectId !== project.id) {
    throw new LenderError("Party assignment not found", 404);
  }
  lrepo.endPartyAssignment(assignmentId, new Date().toISOString());
}

// ------------------------------------------------------------ jurisdiction

/** Pilot jurisdiction templates: labels + default workflow configuration
 *  only. Templates never claim legal requirements automatically. */
export const JURISDICTION_TEMPLATES: Record<JurisdictionTemplateKey, {
  label: string;
  state: string | null;
  countyOrCity: string | null;
  permitAuthority: string | null;
  timezone: string;
}> = {
  DISTRICT_OF_COLUMBIA: { label: "District of Columbia", state: "DC", countyOrCity: "Washington", permitAuthority: "DC Department of Buildings", timezone: "America/New_York" },
  MONTGOMERY_COUNTY_MD: { label: "Montgomery County, MD", state: "MD", countyOrCity: "Montgomery County", permitAuthority: "Montgomery County DPS", timezone: "America/New_York" },
  PRINCE_GEORGES_COUNTY_MD: { label: "Prince George's County, MD", state: "MD", countyOrCity: "Prince George's County", permitAuthority: "Prince George's County DPIE", timezone: "America/New_York" },
  FAIRFAX_COUNTY_VA: { label: "Fairfax County, VA", state: "VA", countyOrCity: "Fairfax County", permitAuthority: "Fairfax County LDS", timezone: "America/New_York" },
  ARLINGTON_COUNTY_VA: { label: "Arlington County, VA", state: "VA", countyOrCity: "Arlington County", permitAuthority: "Arlington County CPHD", timezone: "America/New_York" },
  ALEXANDRIA_VA: { label: "City of Alexandria, VA", state: "VA", countyOrCity: "Alexandria", permitAuthority: "Alexandria Department of Code Administration", timezone: "America/New_York" },
  LOUDOUN_COUNTY_VA: { label: "Loudoun County, VA", state: "VA", countyOrCity: "Loudoun County", permitAuthority: "Loudoun County Building & Development", timezone: "America/New_York" },
  PRINCE_WILLIAM_COUNTY_VA: { label: "Prince William County, VA", state: "VA", countyOrCity: "Prince William County", permitAuthority: "Prince William County Development Services", timezone: "America/New_York" },
  FALLS_CHURCH_VA: { label: "City of Falls Church, VA", state: "VA", countyOrCity: "Falls Church", permitAuthority: "Falls Church Development Services", timezone: "America/New_York" },
  OTHER: { label: "Other jurisdiction", state: null, countyOrCity: null, permitAuthority: null, timezone: "UTC" },
};

export function configureJurisdiction(
  user: User,
  input: Partial<JurisdictionProfile> & { projectId: string; templateKey?: JurisdictionTemplateKey }
): JurisdictionProfile {
  const project = assertProjectAccess(user, input.projectId);
  assertRecorder(user, project.id);
  const key: JurisdictionTemplateKey =
    input.templateKey && input.templateKey in JURISDICTION_TEMPLATES ? input.templateKey : "OTHER";
  const template = JURISDICTION_TEMPLATES[key];
  const existing = lrepo.getJurisdictionProfile(project.id);
  const now = new Date().toISOString();
  const url = (input.officialSystemUrl ?? "").trim();
  if (url && !/^https?:\/\//.test(url)) {
    throw new LenderError("officialSystemUrl must be an http(s) URL", 400);
  }
  const profile: JurisdictionProfile = {
    id: existing?.id ?? lrepo.newId(),
    projectId: project.id,
    templateKey: key,
    state: input.state?.trim() || template.state,
    countyOrCity: input.countyOrCity?.trim() || template.countyOrCity,
    jurisdictionName: input.jurisdictionName?.trim() || template.label,
    permitAuthority: input.permitAuthority?.trim() || template.permitAuthority,
    permitSystemName: input.permitSystemName?.trim() || null,
    officialSystemUrl: url || null,
    timezone: input.timezone?.trim() || template.timezone,
    jurisdictionCode: input.jurisdictionCode?.trim() || null,
    notes: input.notes?.trim() || null,
    configuredByUserId: user.id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  lrepo.upsertJurisdictionProfile(profile);
  return profile;
}

// ------------------------------------------------------------ lender policy

export function configureLenderPolicy(
  user: User,
  input: Partial<LenderDrawPolicy> & { projectId?: string | null; reason?: string | null }
): LenderDrawPolicy {
  const projectId = input.projectId ?? null;
  let organizationId = user.organizationId;
  if (projectId) {
    const project = assertProjectAccess(user, projectId);
    assertRecorder(user, project.id);
    organizationId = project.organizationId;
  } else if (!ADMIN_RECORD_ROLES.includes(user.role)) {
    throw new LenderError("Organization policy defaults require a lender review role", 403);
  }
  const prior = lrepo.getEffectivePolicy(organizationId, projectId ?? "__none__");
  if (prior && !(input.reason ?? "").trim()) {
    throw new LenderError("Policy changes require a reason", 400);
  }
  const version = lrepo.nextPolicyVersion(organizationId, projectId);
  const now = new Date().toISOString();
  const pct = input.retainagePct === null || input.retainagePct === undefined ? null : Number(input.retainagePct);
  if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 50)) {
    throw new LenderError("retainagePct must be between 0 and 50", 400);
  }
  const policy: LenderDrawPolicy = {
    id: lrepo.newId(),
    organizationId,
    projectId,
    version,
    requiredDocumentTypes: Array.isArray(input.requiredDocumentTypes) ? input.requiredDocumentTypes.map(String) : [],
    requiredEvidence: input.requiredEvidence?.trim() || null,
    independentInspectionRequired: Boolean(input.independentInspectionRequired),
    governmentInspectionRequired: Boolean(input.governmentInspectionRequired),
    maxDrawFrequencyDays: num(input.maxDrawFrequencyDays),
    minDrawAmount: num(input.minDrawAmount),
    retainagePct: pct,
    storedMaterialRule: input.storedMaterialRule?.trim() || null,
    offsiteMaterialRule: input.offsiteMaterialRule?.trim() || null,
    changeOrderRule: input.changeOrderRule?.trim() || null,
    budgetTransferRule: input.budgetTransferRule?.trim() || null,
    lienWaiverRule: input.lienWaiverRule?.trim() || null,
    approvalLimit: num(input.approvalLimit),
    reviewerHierarchy: input.reviewerHierarchy?.trim() || null,
    exceptionSeverityMap: input.exceptionSeverityMap?.trim() || null,
    mandatoryFundingConditions: Array.isArray(input.mandatoryFundingConditions)
      ? input.mandatoryFundingConditions.map(String)
      : [],
    turnaroundTargetDays: num(input.turnaroundTargetDays),
    borrowerCertification: input.borrowerCertification?.trim() || null,
    contractorCertification: input.contractorCertification?.trim() || null,
    active: true,
    configuredByUserId: user.id,
    reason: input.reason?.trim() || null,
    createdAt: now,
  };
  lrepo.deactivatePolicies(organizationId, projectId);
  lrepo.insertLenderPolicy(policy);
  audit({
    projectId,
    actorUserId: user.id,
    action: "LENDER_POLICY_CONFIGURED",
    entityType: "lender_draw_policy",
    entityId: policy.id,
    reason: policy.reason,
    beforeSummary: prior ? `v${prior.version}` : null,
    afterSummary: `Lender draw policy v${version} (${projectId ? "project override" : "organization default"})`,
  });
  return policy;
}

/** The policy version a draw operates under (project override else org
 *  default), resolved at read time and included in reports. */
export function policyForDraw(projectId: string): LenderDrawPolicy | null {
  const project = repo.getProject(projectId);
  if (!project) return null;
  return lrepo.getEffectivePolicy(project.organizationId, projectId);
}
