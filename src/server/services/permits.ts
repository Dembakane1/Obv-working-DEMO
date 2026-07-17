/**
 * Permit register, structured code basis, and official-source provenance.
 *
 * OBV records permit, code-basis, and official inspection information
 * from attributable project and official-source records. OBV does not
 * independently provide legal code certification. Physical evidence
 * review, jurisdictional inspection status, lender draw eligibility,
 * formal approval, and funds release remain separate decisions — nothing
 * in this module can verify work, pass an inspection, approve anything,
 * resolve an authoritative exception, or reach VirtualAccountService.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as repo from "../db/repo";
import { UPLOADS_DIR } from "../db/index";
import { audit, snapshotProject } from "./pilot/onboarding";
import { canAccessProjectFinance } from "./budgetProgress";
import type {
  OfficialSourceRecord,
  OfficialSourceType,
  Permit,
  PermitMilestoneLink,
  PermitStatus,
  Project,
  User,
} from "../../shared/types";

export class PermitError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

export const METHODOLOGY_NOTE =
  "OBV records permit, code-basis, and official inspection information from attributable project and " +
  "official-source records. OBV does not independently provide legal code certification. Physical evidence " +
  "review, jurisdictional inspection status, lender draw eligibility, formal approval, and funds release " +
  "remain separate decisions.";

/** Magic-byte content sniffing for the pilot artifact allow-list. */
export function sniffArtifactType(bytes: Buffer): { ext: string; mime: string } | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { ext: ".pdf", mime: "application/pdf" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: ".jpg", mime: "image/jpeg" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { ext: ".png", mime: "image/png" };
  }
  return null;
}

const PERMIT_STATUSES: PermitStatus[] = [
  "DRAFT", "APPLIED", "ISSUED", "ACTIVE", "SUSPENDED", "EXPIRED", "CLOSED", "REVOKED", "UNKNOWN",
];
const SOURCE_TYPES: OfficialSourceType[] = [
  "OFFICIAL_PORTAL_LOOKUP", "OFFICIAL_DOCUMENT", "INSPECTION_REPORT",
  "EMAIL_FROM_AUTHORITY", "MANUAL_OFFICIAL_REFERENCE", "API_LOOKUP", "OTHER",
];

/** Lender-side roles hold formal permit/code-basis determination; the
 *  project manager may record operational permit references. Field users
 *  never determine legal requirements. */
const DETERMINATION_ROLES = new Set(["FUNDER_REP", "COMPLIANCE_REVIEWER"]);
const RECORDING_ROLES = new Set(["FUNDER_REP", "COMPLIANCE_REVIEWER", "PROJECT_MANAGER"]);

function assertProjectAccess(user: User, projectId: string): Project {
  const project = repo.getProject(projectId);
  // Tenant boundary: unrelated organizations get the same 404 as a
  // nonexistent record (never 403).
  if (!project || !canAccessProjectFinance(user, project)) {
    throw new PermitError("Project not found", 404);
  }
  return project;
}

export function getPermitFor(user: User, permitId: string): { permit: Permit; project: Project } {
  const permit = repo.getPermit(permitId);
  const project = permit ? repo.getProject(permit.projectId) : null;
  if (!permit || !project || !canAccessProjectFinance(user, project)) {
    throw new PermitError("Permit not found", 404);
  }
  return { permit, project };
}

/** Parse-and-validate a date input. Real ISO parsing (never lexical
 *  comparison); throws a 400 PermitError for invalid values. */
export function parseIsoDate(value: string | null | undefined, field: string): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (!Number.isFinite(Date.parse(v))) {
    throw new PermitError(`${field} must be a valid ISO date or timestamp (got "${v}")`);
  }
  return v;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch millisecond at which a stored expiry value stops being valid.
 *  EXPIRATION BOUNDARY (documented + tested): a date-only expiresAt
 *  (YYYY-MM-DD) remains valid THROUGH THE END of that calendar date in
 *  UTC — the pilot models jurisdiction/project timezones as UTC — so the
 *  permit expires at the first instant of the following day. A full
 *  timestamp expires exactly at that instant. */
export function expiryEpoch(expiresAt: string): number {
  return DATE_ONLY.test(expiresAt)
    ? Date.parse(expiresAt + "T23:59:59.999Z") + 1
    : Date.parse(expiresAt);
}

/** Derived control status at a point in time: recorded EXPIRED/REVOKED/
 *  SUSPENDED/CLOSED stand; an ISSUED/ACTIVE permit past its expiration is
 *  EXPIRED for control purposes (the stored status is never rewritten).
 *  UNKNOWN never behaves as ACTIVE. Epoch-based, never lexical. */
export function effectiveStatus(permit: Permit, atIso = new Date().toISOString()): PermitStatus {
  if (
    (permit.status === "ISSUED" || permit.status === "ACTIVE") &&
    permit.expiresAt !== null &&
    Number.isFinite(Date.parse(permit.expiresAt)) &&
    Date.parse(atIso) >= expiryEpoch(permit.expiresAt)
  ) {
    return "EXPIRED";
  }
  return permit.status;
}

// ---- official-source completeness (Part 5) ----

export type SourceCompleteness = "COMPLETE" | "INCOMPLETE" | "INVALID";

/** A source must carry a meaningful provenance basis. Only COMPLETE
 *  records linked to the relevant inspection satisfy officialSourceRequired.
 *  A URL alone never passes an inspection — a valid source plus a separate
 *  attributable reviewed result satisfies the configured gate. */
export function sourceCompleteness(r: {
  officialRecordNumber: string | null;
  officialStatusText: string | null;
  sourceArtifactHash: string | null;
  sourceDocumentPath: string | null;
  officialSystemName: string | null;
  officialRecordUrl: string | null;
  sourceType: string;
  notes: string | null;
}): SourceCompleteness {
  if (r.officialRecordUrl && !/^https?:\/\//i.test(r.officialRecordUrl)) return "INVALID";
  if ((r.sourceArtifactHash && !r.sourceDocumentPath) || (!r.sourceArtifactHash && r.sourceDocumentPath)) return "INVALID";
  const complete =
    Boolean(r.officialRecordNumber) ||
    Boolean(r.officialStatusText) ||
    Boolean(r.sourceArtifactHash && r.sourceDocumentPath) ||
    Boolean(r.officialSystemName && r.officialRecordUrl) ||
    (r.sourceType === "MANUAL_OFFICIAL_REFERENCE" && (r.notes ?? "").trim().length >= 10);
  return complete ? "COMPLETE" : "INCOMPLETE";
}

/** COMPLETE official-source records for an inspection (the only records
 *  that can satisfy an officialSourceRequired configuration). */
export function completeSourcesForInspection(inspectionId: string): OfficialSourceRecord[] {
  return repo.listOfficialSourcesForInspection(inspectionId).filter((r) => sourceCompleteness(r) === "COMPLETE");
}

export function createPermit(
  user: User,
  projectId: string,
  input: {
    permitNumber: string;
    permitType: string;
    issuingAuthority?: string | null;
    jurisdiction?: string | null;
    status?: string | null;
    issuedAt?: string | null;
    effectiveAt?: string | null;
    expiresAt?: string | null;
    scopeDescription?: string | null;
    applicableCodeEdition?: string | null;
    codeEffectiveDate?: string | null;
    codeBasis?: string | null;
    officialRecordUrl?: string | null;
    officialRecordNumber?: string | null;
    notes?: string | null;
    legacyReference?: string | null;
    /** Explicit import override for legacy data with imperfect dates. */
    legacyImport?: boolean;
  }
): Permit {
  const project = assertProjectAccess(user, projectId);
  if (!RECORDING_ROLES.has(user.role)) {
    throw new PermitError("Recording permits requires a lender-side reviewer or project manager", 403);
  }
  const permitNumber = (input.permitNumber ?? "").trim();
  const permitType = (input.permitType ?? "").trim();
  if (!permitNumber) throw new PermitError("permitNumber is required");
  if (!permitType) throw new PermitError("permitType is required");
  const status = (input.status?.trim() || (user.role === "PROJECT_MANAGER" ? "DRAFT" : "UNKNOWN")) as PermitStatus;
  if (!PERMIT_STATUSES.includes(status)) throw new PermitError(`Unknown permit status ${status}`);
  // Project managers record OPERATIONAL permit information (DRAFT/APPLIED
  // and request lender review). Formal official-status determination —
  // ISSUED/ACTIVE/SUSPENDED/EXPIRED/CLOSED/REVOKED, and UNKNOWN as a
  // reviewed determination — belongs to funder/compliance only.
  if (user.role === "PROJECT_MANAGER" && !["DRAFT", "APPLIED"].includes(status)) {
    throw new PermitError(
      "Project managers may record DRAFT or APPLIED operational permit records — formal permit status determination requires a funder representative or compliance reviewer",
      403
    );
  }
  const issuedAt = parseIsoDate(input.issuedAt, "issuedAt");
  const effectiveAt = parseIsoDate(input.effectiveAt, "effectiveAt");
  const expiresAt = parseIsoDate(input.expiresAt, "expiresAt");
  if (
    expiresAt && issuedAt && Date.parse(expiresAt) < Date.parse(issuedAt) && !input.legacyImport
  ) {
    throw new PermitError("expiresAt cannot precede issuedAt (set legacyImport for explicit legacy data)");
  }
  // Structured code basis is a reviewed determination — lender-side only.
  const recordsCode = Boolean(input.applicableCodeEdition?.trim() || input.codeBasis?.trim());
  if (recordsCode && !DETERMINATION_ROLES.has(user.role)) {
    throw new PermitError("Recording the applicable code basis requires a funder representative or compliance reviewer", 403);
  }
  const now = new Date().toISOString();
  const permit: Permit = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    permitNumber,
    permitType,
    issuingAuthority: input.issuingAuthority?.trim() || null,
    jurisdiction: input.jurisdiction?.trim() || null,
    status,
    issuedAt,
    effectiveAt,
    expiresAt,
    closedAt: null,
    scopeDescription: input.scopeDescription?.trim() || null,
    applicableCodeEdition: input.applicableCodeEdition?.trim() || null,
    codeEffectiveDate: input.codeEffectiveDate?.trim() || null,
    codeBasis: input.codeBasis?.trim() || null,
    codeDeterminedBy: recordsCode ? user.id : null,
    codeDeterminedAt: recordsCode ? now : null,
    officialRecordUrl: input.officialRecordUrl?.trim() || null,
    officialRecordNumber: input.officialRecordNumber?.trim() || null,
    notes: input.notes?.trim() || null,
    legacyReference: input.legacyReference?.trim() || null,
    configurationVersion: project.pilot?.configVersion ?? 1,
    createdByUserId: user.id,
    createdAt: now,
    updatedAt: now,
  };
  try {
    repo.insertPermit(permit);
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      throw new PermitError(`Permit number ${permitNumber} already exists for this project`, 409);
    }
    throw e;
  }
  audit({
    projectId: project.id, actorUserId: user.id, action: "PERMIT_RECORDED",
    entityType: "PERMIT", entityId: permit.id, reason: null,
    beforeSummary: null,
    afterSummary: `${permitNumber} (${permitType}) — ${status}`,
  });
  return permit;
}

/** Material permit changes on launched projects require a reason and are
 *  audited + configuration-snapshotted. Historical inspection records are
 *  never rewritten by permit edits (they store their own values). */
export function updatePermit(
  user: User,
  permitId: string,
  input: Partial<{
    permitNumber: string;
    permitType: string;
    issuingAuthority: string | null;
    jurisdiction: string | null;
    status: string;
    issuedAt: string | null;
    effectiveAt: string | null;
    expiresAt: string | null;
    closedAt: string | null;
    scopeDescription: string | null;
    officialRecordUrl: string | null;
    officialRecordNumber: string | null;
    notes: string | null;
  }> & { reason?: string | null }
): Permit {
  const { permit, project } = getPermitFor(user, permitId);
  if (!RECORDING_ROLES.has(user.role)) {
    throw new PermitError("Updating permits requires a lender-side reviewer or project manager", 403);
  }
  if (input.status && !PERMIT_STATUSES.includes(input.status as PermitStatus)) {
    throw new PermitError(`Unknown permit status ${input.status}`);
  }
  if (
    user.role === "PROJECT_MANAGER" &&
    input.status !== undefined &&
    (!["DRAFT", "APPLIED"].includes(input.status) || !["DRAFT", "APPLIED"].includes(permit.status))
  ) {
    throw new PermitError(
      "Formal permit status determination requires a funder representative or compliance reviewer",
      403
    );
  }
  parseIsoDate(input.issuedAt ?? null, "issuedAt");
  parseIsoDate(input.effectiveAt ?? null, "effectiveAt");
  parseIsoDate(input.expiresAt ?? null, "expiresAt");
  parseIsoDate(input.closedAt ?? null, "closedAt");
  const material =
    input.status !== undefined || input.permitNumber !== undefined ||
    input.expiresAt !== undefined || input.issuedAt !== undefined ||
    input.permitType !== undefined;
  const reason = (input.reason ?? "").trim();
  if (material && project.status !== "DRAFT" && !reason) {
    throw new PermitError("A reason is required for material permit changes after launch");
  }
  const nextExpires = input.expiresAt !== undefined ? input.expiresAt : permit.expiresAt;
  const nextIssued = input.issuedAt !== undefined ? input.issuedAt : permit.issuedAt;
  if (nextExpires && nextIssued && Date.parse(nextExpires) < Date.parse(nextIssued)) {
    throw new PermitError("expiresAt cannot precede issuedAt");
  }
  const before = `${permit.permitNumber} (${permit.permitType}) — ${permit.status}, expires ${permit.expiresAt ?? "—"}`;
  repo.updatePermit(permitId, {
    permitNumber: input.permitNumber?.trim() || permit.permitNumber,
    permitType: input.permitType?.trim() || permit.permitType,
    issuingAuthority: input.issuingAuthority !== undefined ? input.issuingAuthority?.trim() || null : permit.issuingAuthority,
    jurisdiction: input.jurisdiction !== undefined ? input.jurisdiction?.trim() || null : permit.jurisdiction,
    status: (input.status as PermitStatus) ?? permit.status,
    issuedAt: input.issuedAt !== undefined ? input.issuedAt?.trim() || null : permit.issuedAt,
    effectiveAt: input.effectiveAt !== undefined ? input.effectiveAt?.trim() || null : permit.effectiveAt,
    expiresAt: input.expiresAt !== undefined ? input.expiresAt?.trim() || null : permit.expiresAt,
    closedAt: input.closedAt !== undefined ? input.closedAt?.trim() || null : permit.closedAt,
    scopeDescription: input.scopeDescription !== undefined ? input.scopeDescription?.trim() || null : permit.scopeDescription,
    officialRecordUrl: input.officialRecordUrl !== undefined ? input.officialRecordUrl?.trim() || null : permit.officialRecordUrl,
    officialRecordNumber: input.officialRecordNumber !== undefined ? input.officialRecordNumber?.trim() || null : permit.officialRecordNumber,
    notes: input.notes !== undefined ? input.notes?.trim() || null : permit.notes,
    configurationVersion: project.pilot?.configVersion ?? permit.configurationVersion,
  });
  const after = repo.getPermit(permitId)!;
  if (material) {
    audit({
      projectId: project.id, actorUserId: user.id, action: "PERMIT_UPDATED",
      entityType: "PERMIT", entityId: permitId, reason: reason || null,
      beforeSummary: before,
      afterSummary: `${after.permitNumber} (${after.permitType}) — ${after.status}, expires ${after.expiresAt ?? "—"}`,
    });
    if (project.status !== "DRAFT") {
      snapshotProject(project.id, `Permit ${after.permitNumber} updated: ${reason}`, user);
    }
  }
  return after;
}

/** Reviewed code-basis determination. Lender-side only; post-launch
 *  changes require a reason and preserve prior values in the audit trail
 *  and configuration snapshots — never a silent rewrite. */
export function recordCodeBasis(
  user: User,
  permitId: string,
  input: {
    applicableCodeEdition: string;
    codeEffectiveDate?: string | null;
    codeBasis: string;
    reason?: string | null;
  }
): Permit {
  const { permit, project } = getPermitFor(user, permitId);
  if (!DETERMINATION_ROLES.has(user.role)) {
    throw new PermitError("Recording the applicable code basis requires a funder representative or compliance reviewer", 403);
  }
  const edition = (input.applicableCodeEdition ?? "").trim();
  const basis = (input.codeBasis ?? "").trim();
  if (!edition || !basis) {
    throw new PermitError("applicableCodeEdition and codeBasis are both required — the recorded basis must be attributable");
  }
  const isChange = permit.applicableCodeEdition !== null;
  const reason = (input.reason ?? "").trim();
  if (isChange && project.status !== "DRAFT" && !reason) {
    throw new PermitError("A reason is required to change a recorded code basis after launch");
  }
  const now = new Date().toISOString();
  const before = permit.applicableCodeEdition
    ? `${permit.applicableCodeEdition} (${permit.codeBasis ?? "—"}, effective ${permit.codeEffectiveDate ?? "—"})`
    : "NOT RECORDED";
  repo.updatePermit(permitId, {
    applicableCodeEdition: edition,
    codeEffectiveDate: input.codeEffectiveDate?.trim() || null,
    codeBasis: basis,
    codeDeterminedBy: user.id,
    codeDeterminedAt: now,
    configurationVersion: project.pilot?.configVersion ?? permit.configurationVersion,
  });
  audit({
    projectId: project.id, actorUserId: user.id, action: "CODE_BASIS_RECORDED",
    entityType: "PERMIT", entityId: permitId, reason: reason || null,
    beforeSummary: before,
    afterSummary: `${edition} (${basis}${input.codeEffectiveDate ? `, effective ${input.codeEffectiveDate}` : ""}) — recorded by ${user.name}`,
  });
  if (project.status !== "DRAFT") {
    snapshotProject(project.id, `Applicable code basis recorded for permit ${permit.permitNumber}: ${edition}`, user);
  }
  return repo.getPermit(permitId)!;
}

/** Normalized permit ↔ milestone link. Same project only; duplicates are
 *  rejected by the database as well as here. */
export function linkMilestone(
  user: User,
  permitId: string,
  milestoneId: string,
  scopeNote?: string | null
): PermitMilestoneLink {
  const { permit, project } = getPermitFor(user, permitId);
  if (!RECORDING_ROLES.has(user.role)) {
    throw new PermitError("Linking permits requires a lender-side reviewer or project manager", 403);
  }
  const milestone = repo.getMilestone(milestoneId);
  if (!milestone || milestone.projectId !== permit.projectId) {
    // Cross-project links are structurally invalid; unrelated milestones
    // are indistinguishable from nonexistent ones.
    throw new PermitError("Milestone not found in this permit's project", 404);
  }
  const link: PermitMilestoneLink = {
    id: repo.newId(),
    permitId,
    milestoneId,
    scopeNote: scopeNote?.trim() || null,
    createdByUserId: user.id,
    createdAt: new Date().toISOString(),
  };
  try {
    repo.insertPermitLink(link);
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      throw new PermitError("This permit is already linked to that milestone", 409);
    }
    throw e;
  }
  audit({
    projectId: project.id, actorUserId: user.id, action: "PERMIT_MILESTONE_LINKED",
    entityType: "PERMIT", entityId: permitId, reason: scopeNote?.trim() || null,
    beforeSummary: null,
    afterSummary: `Permit ${permit.permitNumber} linked to milestone M${milestone.seq}`,
  });
  return link;
}

/** Official-source provenance. Identifies who performed the lookup, keeps
 *  the official system's status text verbatim, hashes captured artifact
 *  bytes, and NEVER creates a reviewed inspection result by itself. */
export function recordOfficialSource(
  user: User,
  input: {
    projectId: string;
    milestoneId?: string | null;
    permitId?: string | null;
    inspectionId?: string | null;
    sourceType: string;
    officialSystemName?: string | null;
    officialRecordNumber?: string | null;
    officialRecordUrl?: string | null;
    lookupPerformedAt?: string | null;
    capturedAt?: string | null;
    officialStatusText?: string | null;
    /** Optional captured artifact as a data: URL — stored with a sha256
     *  administrative hash (never entering the Evidence Ledger). */
    artifactDataUrl?: string | null;
    artifactFilename?: string | null;
    notes?: string | null;
  }
): OfficialSourceRecord {
  const project = assertProjectAccess(user, input.projectId);
  if (!DETERMINATION_ROLES.has(user.role)) {
    throw new PermitError("Recording official source references requires a funder representative or compliance reviewer", 403);
  }
  const sourceType = (input.sourceType ?? "").trim() as OfficialSourceType;
  if (!SOURCE_TYPES.includes(sourceType)) {
    throw new PermitError(`sourceType must be one of ${SOURCE_TYPES.join(", ")}`);
  }
  // Referential consistency: every referenced record must belong to the
  // same project (and the inspection to the referenced permit's project).
  let milestoneId: string | null = null;
  if (input.milestoneId?.trim()) {
    const m = repo.getMilestone(input.milestoneId.trim());
    if (!m || m.projectId !== project.id) throw new PermitError("Milestone not found in this project", 404);
    milestoneId = m.id;
  }
  let permitId: string | null = null;
  if (input.permitId?.trim()) {
    const permit = repo.getPermit(input.permitId.trim());
    if (!permit || permit.projectId !== project.id) throw new PermitError("Permit not found in this project", 404);
    permitId = permit.id;
  }
  let inspectionId: string | null = null;
  if (input.inspectionId?.trim()) {
    const insp = repo.getInspection(input.inspectionId.trim());
    if (!insp || insp.projectId !== project.id || insp.organizationId !== project.organizationId) {
      throw new PermitError("Inspection not found in this project", 404);
    }
    inspectionId = insp.id;
    // Relational consistency (422 for conflicting same-project refs —
    // nothing about unrelated records is revealed):
    if (milestoneId && milestoneId !== insp.milestoneId) {
      throw new PermitError("milestoneId conflicts with the referenced inspection's milestone", 422);
    }
    if (permitId && insp.permitRefId && permitId !== insp.permitRefId) {
      throw new PermitError("permitId conflicts with the referenced inspection's permit", 422);
    }
    milestoneId = milestoneId ?? insp.milestoneId;
  }
  if (permitId && milestoneId) {
    const linked = repo.listPermitLinksForMilestone(milestoneId).some((l) => l.permitId === permitId);
    if (!linked) {
      throw new PermitError("permitId is not linked to the referenced milestone", 422);
    }
  }
  if (!permitId && !inspectionId && !milestoneId) {
    throw new PermitError("An official source record must reference a permit, inspection, or milestone");
  }
  parseIsoDate(input.lookupPerformedAt, "lookupPerformedAt");
  parseIsoDate(input.capturedAt, "capturedAt");

  // Optional captured artifact: hashed administrative copy under uploads/.
  let sourceDocumentPath: string | null = null;
  let sourceArtifactHash: string | null = null;
  if (input.artifactDataUrl?.trim()) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(input.artifactDataUrl.trim());
    if (!match) throw new PermitError("artifactDataUrl must be a data: URL");
    const bytes = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    if (bytes.length === 0) throw new PermitError("Captured artifact is empty");
    if (bytes.length > 5 * 1024 * 1024) throw new PermitError("Captured artifact exceeds the 5 MB limit");
    // Content sniffing — the filename extension and supplied MIME type are
    // never trusted. Pilot allow-list: PDF, JPEG, PNG. HTML/SVG/scripts
    // and executables are rejected by magic-byte inspection.
    const sniffed = sniffArtifactType(bytes);
    if (!sniffed) {
      throw new PermitError(
        "Unsupported artifact content — the pilot accepts PDF, JPEG, or PNG source documents only"
      );
    }
    sourceArtifactHash = createHash("sha256").update(bytes).digest("hex");
    const safeBase = (input.artifactFilename ?? "artifact")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/\.[a-zA-Z0-9]+$/, "")
      .slice(0, 80);
    const dir = path.join(UPLOADS_DIR, "official-sources");
    fs.mkdirSync(dir, { recursive: true });
    sourceDocumentPath = path.join("official-sources", `${sourceArtifactHash.slice(0, 16)}-${safeBase}${sniffed.ext}`);
    fs.writeFileSync(path.join(UPLOADS_DIR, sourceDocumentPath), bytes);
  }

  const draft = {
    officialRecordNumber: input.officialRecordNumber?.trim() || null,
    officialStatusText: input.officialStatusText?.trim() || null,
    sourceArtifactHash,
    sourceDocumentPath,
    officialSystemName: input.officialSystemName?.trim() || null,
    officialRecordUrl: input.officialRecordUrl?.trim() || null,
    sourceType,
    notes: input.notes?.trim() || null,
  };
  const completeness = sourceCompleteness(draft);
  if (completeness !== "COMPLETE") {
    throw new PermitError(
      completeness === "INVALID"
        ? "Official source record is invalid (malformed URL or inconsistent artifact fields)"
        : "Official source record must contain a meaningful provenance basis — an association and source type alone are not provenance",
      422
    );
  }
  const record: OfficialSourceRecord = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    milestoneId,
    permitId,
    inspectionId,
    sourceType,
    officialSystemName: input.officialSystemName?.trim() || null,
    officialRecordNumber: input.officialRecordNumber?.trim() || null,
    officialRecordUrl: input.officialRecordUrl?.trim() || null,
    lookupPerformedAt: input.lookupPerformedAt?.trim() || new Date().toISOString(),
    lookupPerformedByUserId: user.id,
    capturedAt: input.capturedAt?.trim() || (sourceDocumentPath ? new Date().toISOString() : null),
    officialStatusText: input.officialStatusText?.trim() || null,
    sourceDocumentPath,
    sourceArtifactHash,
    notes: input.notes?.trim() || null,
    createdAt: new Date().toISOString(),
  };
  repo.insertOfficialSource(record);
  audit({
    projectId: project.id, actorUserId: user.id, action: "OFFICIAL_SOURCE_RECORDED",
    entityType: "PERMIT", entityId: permitId ?? inspectionId ?? milestoneId ?? record.id,
    reason: null,
    beforeSummary: null,
    afterSummary: `${sourceType}${record.officialRecordNumber ? ` ${record.officialRecordNumber}` : ""}${record.officialStatusText ? ` — "${record.officialStatusText}"` : ""} (lookup by ${user.name})`,
  });
  return record;
}

// ------------------------------------------------------------- register

export interface PermitRegisterRow {
  permit: Permit;
  effectiveStatus: PermitStatus;
  linkedMilestones: Array<{ milestoneId: string; label: string }>;
  openInspectionCondition: string | null;
  nextAction: string;
  sourceCount: number;
}

export function permitRegister(
  user: User,
  projectId: string,
  filters: { status?: string; permitType?: string; authority?: string; milestoneId?: string; expiration?: string } = {}
): PermitRegisterRow[] {
  const project = assertProjectAccess(user, projectId);
  const milestones = new Map(repo.listMilestones(project.id).map((m) => [m.id, m]));
  const now = new Date().toISOString();
  return repo
    .listPermitsForProject(project.id)
    .map((permit) => {
      const links = repo.listPermitLinksForPermit(permit.id);
      const eff = effectiveStatus(permit, now);
      const linkedInspections = repo
        .listInspectionsForProject(project.id)
        .filter((i) => i.permitRefId === permit.id && i.status !== "CANCELLED" && i.supersededByInspectionId === null);
      const openCondition =
        linkedInspections.find((i) => ["FAILED", "CORRECTIONS_REQUIRED"].includes(i.status))?.status ??
        linkedInspections.find((i) => ["REQUIRED_UNSCHEDULED", "SCHEDULED", "COMPLETED_PENDING_RESULT"].includes(i.status))?.status ??
        null;
      const nextAction =
        eff === "EXPIRED" ? "Renew or update expired permit" :
        eff === "REVOKED" ? "Resolve revoked permit with the issuing authority" :
        eff === "SUSPENDED" ? "Resolve permit suspension" :
        eff === "UNKNOWN" ? "Record the reviewed permit status" :
        !permit.applicableCodeEdition ? "Record the applicable code basis" :
        openCondition === "CORRECTIONS_REQUIRED" ? "Respond to corrections and schedule reinspection" :
        openCondition === "FAILED" ? "Schedule reinspection" :
        openCondition ? "Complete the open inspection" : "No open permit action";
      return {
        permit,
        effectiveStatus: eff,
        linkedMilestones: links
          .map((l) => milestones.get(l.milestoneId))
          .filter((m): m is NonNullable<typeof m> => Boolean(m))
          .map((m) => ({ milestoneId: m.id, label: `M${m.seq}` })),
        openInspectionCondition: openCondition,
        nextAction,
        sourceCount: repo.listOfficialSourcesForPermit(permit.id).length,
      };
    })
    .filter((row) => {
      if (filters.status && row.permit.status !== filters.status) return false;
      if (filters.permitType && row.permit.permitType !== filters.permitType) return false;
      if (filters.authority && (row.permit.issuingAuthority ?? "") !== filters.authority) return false;
      if (filters.milestoneId && !row.linkedMilestones.some((m) => m.milestoneId === filters.milestoneId)) return false;
      if (filters.expiration === "expired" && row.effectiveStatus !== "EXPIRED") return false;
      if (filters.expiration === "active" && row.effectiveStatus === "EXPIRED") return false;
      return true;
    });
}

// ------------------------------------------------------- data integrity

export interface PermitIntegrityFinding {
  severity: "WARNING" | "CRITICAL";
  code: string;
  detail: string;
}

/** Deterministic structural validation used by the audit package:
 *  broken references, impossible reinspection chains, missing mandatory
 *  source records, conflicting final results, artifact hash drift. */
export function validatePermitIntegrity(projectId: string): PermitIntegrityFinding[] {
  const findings: PermitIntegrityFinding[] = [];
  const permits = repo.listPermitsForProject(projectId);
  const permitIds = new Set(permits.map((p) => p.id));
  const milestones = new Map(repo.listMilestones(projectId).map((m) => [m.id, m]));

  for (const link of repo.listPermitLinksForProject(projectId)) {
    if (!permitIds.has(link.permitId)) {
      findings.push({ severity: "CRITICAL", code: "BROKEN_PERMIT_LINK", detail: `Link ${link.id} references missing permit ${link.permitId}` });
    }
    if (!milestones.has(link.milestoneId)) {
      findings.push({ severity: "CRITICAL", code: "BROKEN_MILESTONE_LINK", detail: `Link ${link.id} references milestone ${link.milestoneId} outside this project` });
    }
  }

  const inspections = repo.listInspectionsForProject(projectId);
  const byId = new Map(inspections.map((i) => [i.id, i]));
  for (const i of inspections) {
    if (i.permitRefId && !permitIds.has(i.permitRefId)) {
      findings.push({ severity: "CRITICAL", code: "BROKEN_INSPECTION_PERMIT_REF", detail: `Inspection ${i.id} references missing permit ${i.permitRefId}` });
    }
    if (i.reinspectionOfInspectionId) {
      if (i.reinspectionOfInspectionId === i.id) {
        findings.push({ severity: "CRITICAL", code: "SELF_REFERENTIAL_REINSPECTION", detail: `Inspection ${i.id} is a reinspection of itself` });
      }
      const prior = byId.get(i.reinspectionOfInspectionId);
      if (!prior) {
        findings.push({ severity: "CRITICAL", code: "BROKEN_REINSPECTION_LINK", detail: `Inspection ${i.id} follows missing inspection ${i.reinspectionOfInspectionId}` });
      } else if (prior.milestoneId !== i.milestoneId) {
        findings.push({ severity: "CRITICAL", code: "CROSS_MILESTONE_REINSPECTION", detail: `Inspection ${i.id} reinspects a different milestone's inspection` });
      } else if (prior.result === "PASSED") {
        findings.push({ severity: "CRITICAL", code: "CONFLICTING_FINAL_RESULTS", detail: `Inspection ${prior.id} PASSED but has reinspection ${i.id}` });
      }
    }
    // Circular chain walk.
    const seen = new Set<string>();
    let cursor: string | null = i.reinspectionOfInspectionId;
    while (cursor) {
      if (seen.has(cursor) || cursor === i.id) {
        findings.push({ severity: "CRITICAL", code: "CIRCULAR_REINSPECTION_CHAIN", detail: `Inspection ${i.id} participates in a circular reinspection chain` });
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.reinspectionOfInspectionId ?? null;
    }
    // Mandatory official source for recorded PASSED results — only a
    // COMPLETE source (meaningful provenance basis) satisfies the gate.
    const req = repo.getInspectionRequirement(i.milestoneId);
    if (i.result === "PASSED" && req?.officialSourceRequired && completeSourcesForInspection(i.id).length === 0) {
      findings.push({ severity: "CRITICAL", code: "MANDATORY_OFFICIAL_SOURCE_MISSING", detail: `Inspection ${i.id} is PASSED but no COMPLETE official source record supports it` });
    }
  }

  for (const src of repo.listOfficialSourcesForProject(projectId)) {
    if (src.permitId && !permitIds.has(src.permitId)) {
      findings.push({ severity: "CRITICAL", code: "BROKEN_SOURCE_PERMIT_REF", detail: `Official source ${src.id} references missing permit ${src.permitId}` });
    }
    if (src.inspectionId && !byId.has(src.inspectionId)) {
      findings.push({ severity: "CRITICAL", code: "BROKEN_SOURCE_INSPECTION_REF", detail: `Official source ${src.id} references missing inspection ${src.inspectionId}` });
    }
    // Inconsistent historical combinations (imported/legacy data).
    const srcInsp = src.inspectionId ? byId.get(src.inspectionId) : null;
    if (srcInsp && src.milestoneId && src.milestoneId !== srcInsp.milestoneId) {
      findings.push({ severity: "CRITICAL", code: "SOURCE_MILESTONE_MISMATCH", detail: `Official source ${src.id} milestone does not match its inspection's milestone` });
    }
    if (srcInsp && src.permitId && srcInsp.permitRefId && src.permitId !== srcInsp.permitRefId) {
      findings.push({ severity: "CRITICAL", code: "SOURCE_PERMIT_MISMATCH", detail: `Official source ${src.id} permit does not match its inspection's permit` });
    }
    if (
      src.permitId && src.milestoneId && permitIds.has(src.permitId) &&
      !repo.listPermitLinksForMilestone(src.milestoneId).some((l) => l.permitId === src.permitId)
    ) {
      findings.push({ severity: "WARNING", code: "SOURCE_PERMIT_UNLINKED", detail: `Official source ${src.id} references a permit not linked to its milestone` });
    }
    if (sourceCompleteness(src) !== "COMPLETE") {
      findings.push({ severity: "WARNING", code: "SOURCE_INCOMPLETE", detail: `Official source ${src.id} lacks a meaningful provenance basis (${sourceCompleteness(src)})` });
    }
    if (src.sourceDocumentPath) {
      const full = path.join(UPLOADS_DIR, src.sourceDocumentPath);
      if (!fs.existsSync(full)) {
        findings.push({ severity: "WARNING", code: "SOURCE_ARTIFACT_UNAVAILABLE", detail: `Official source ${src.id} artifact file is unavailable (optional artifact)` });
      } else if (src.sourceArtifactHash) {
        const actual = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        if (actual !== src.sourceArtifactHash) {
          findings.push({ severity: "CRITICAL", code: "SOURCE_ARTIFACT_HASH_MISMATCH", detail: `Official source ${src.id} artifact bytes do not match the recorded hash` });
        }
      }
    }
  }
  return findings;
}
