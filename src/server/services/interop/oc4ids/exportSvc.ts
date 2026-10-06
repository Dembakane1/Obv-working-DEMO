/**
 * OC4IDS export service — preview, immutable export, retrieval and the
 * validation report. Every function is role-gated and tenant-scoped.
 *
 *  - Preview computes the mapping and validates it without persisting.
 *  - Export writes the package ONCE (write-once file + append-only
 *    provenance row with hashes, schema/mapping versions, source record
 *    versions and the exporting user) and never mutates the project.
 *  - Retrieval re-verifies the stored bytes against the recorded hash, so
 *    a historical export is reproducible byte for byte or reported as
 *    tampered — never silently served.
 *  - "READY" is claimed ONLY when the package validates against the
 *    implemented schema subset; the report says exactly what that means.
 */
import * as fs from "node:fs";
import * as repo from "../../../db/repo";
import * as interopRepo from "../../../db/interopRepo";
import type { InteropExportRecord, Project, User } from "../../../../shared/types";
import {
  InteropError,
  OC4IDS_NOTICE,
  assertExporter,
  interopKey,
  resolveInteropKey,
  nowIso,
  oc4idsPublisherConfig,
  requireVisibleProject,
  sha256Hex,
} from "../core";
import { OC4IDS_MAPPING_VERSION, mapProjectToOc4ids, type MappedField, type MappingResult, type OmittedField } from "./mapping";
import {
  OC4IDS_PACKAGE_SCHEMA,
  OC4IDS_PACKAGE_VERSION,
  OC4IDS_PROJECT_SCHEMA,
  OC4IDS_SCHEMA_COVERAGE,
  OC4IDS_VERSION,
} from "./schema";
import { canonicalJson, validateAgainst, type ValidationReport } from "./validate";

export type Oc4idsStatus = "READY" | "INCOMPLETE" | "NOT_CONFIGURED" | "INVALID";

/** Fields whose absence makes a disclosure thin enough to call INCOMPLETE
 *  even when the package validates. */
export const CORE_DISCLOSURE_FIELDS = [
  "title", "description", "status", "period", "sector", "locations", "budget", "parties", "publicAuthority", "milestones",
] as const;

export interface Oc4idsPublisherView {
  name: string;
  uri: string | null;
  projectIdPrefix: string | null;
  prefixWellFormed: boolean;
  licenseUrl: string | null;
  publicationPolicyUrl: string | null;
}

export interface Oc4idsCoverage {
  populatedFields: number;
  omittedFields: number;
  implementedTopLevelFields: string[];
  populatedTopLevelFields: string[];
  omittedTopLevelFields: string[];
  coreFieldsPopulated: string[];
  coreFieldsMissing: string[];
}

export interface Oc4idsPreview {
  projectId: string;
  projectName: string;
  status: Oc4idsStatus;
  statusReasons: string[];
  standard: "OC4IDS";
  schemaVersion: string;
  packageVersion: string;
  mappingVersion: string;
  notice: string;
  publisher: Oc4idsPublisherView;
  project: Record<string, unknown>;
  package: Record<string, unknown>;
  fields: MappedField[];
  omitted: OmittedField[];
  sourceRecords: MappingResult["sourceRecords"];
  excludedObvIntelligence: string[];
  validation: ValidationReport;
  packageValidation: ValidationReport;
  coverage: Oc4idsCoverage;
  schemaCoverage: typeof OC4IDS_SCHEMA_COVERAGE;
  lastExport: InteropExportRecord | null;
  exportCount: number;
  canExport: boolean;
}

function publisherFor(user: User): Oc4idsPublisherView {
  const org = repo.getOrganization(user.organizationId);
  const cfg = oc4idsPublisherConfig();
  const website = (org?.profile?.website ?? "").trim();
  return {
    name: org?.name ?? "Unknown organization",
    uri: /^https?:\/\//i.test(website) ? website : null,
    projectIdPrefix: cfg.projectIdPrefix,
    prefixWellFormed: cfg.prefixWellFormed,
    licenseUrl: cfg.licenseUrl,
    publicationPolicyUrl: cfg.publicationPolicyUrl,
  };
}

function buildPackage(
  publisher: Oc4idsPublisherView,
  uri: string,
  publishedDate: string,
  project: Record<string, unknown>
): Record<string, unknown> {
  const pkg: Record<string, unknown> = {
    uri,
    publishedDate,
    publisher: publisher.uri ? { name: publisher.name, uri: publisher.uri } : { name: publisher.name },
    version: OC4IDS_PACKAGE_VERSION,
    projects: [project],
  };
  if (publisher.licenseUrl) pkg.license = publisher.licenseUrl;
  if (publisher.publicationPolicyUrl) pkg.publicationPolicy = publisher.publicationPolicyUrl;
  return pkg;
}

function coverageOf(mapping: MappingResult): Oc4idsCoverage {
  const top = OC4IDS_SCHEMA_COVERAGE.implementedProjectFields as readonly string[];
  const populatedTop = top.filter((f) => mapping.project[f] !== undefined);
  const omittedTop = top.filter((f) => mapping.project[f] === undefined);
  return {
    populatedFields: mapping.fields.length,
    omittedFields: mapping.omitted.length,
    implementedTopLevelFields: [...top],
    populatedTopLevelFields: populatedTop,
    omittedTopLevelFields: omittedTop,
    coreFieldsPopulated: CORE_DISCLOSURE_FIELDS.filter((f) => mapping.project[f] !== undefined),
    coreFieldsMissing: CORE_DISCLOSURE_FIELDS.filter((f) => mapping.project[f] === undefined),
  };
}

function statusOf(input: {
  publisher: Oc4idsPublisherView;
  baseUrl: string | null;
  validation: ValidationReport;
  packageValidation: ValidationReport;
  coverage: Oc4idsCoverage;
}): { status: Oc4idsStatus; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.publisher.projectIdPrefix) {
    reasons.push("Set OBV_OC4IDS_PROJECT_ID_PREFIX to the publisher's registered OC4IDS prefix (shape oc4ids-xxxxxx).");
  } else if (!input.publisher.prefixWellFormed) {
    reasons.push(`OBV_OC4IDS_PROJECT_ID_PREFIX "${input.publisher.projectIdPrefix}" is not shaped like a registered prefix (oc4ids-xxxxxx); confirm it with the registry.`);
  }
  if (!input.baseUrl) reasons.push("No public base URL is configured, so the package cannot carry a package URI (set OBV_PUBLIC_BASE_URL).");
  if (!input.publisher.projectIdPrefix || !input.baseUrl) return { status: "NOT_CONFIGURED", reasons };
  if (!input.validation.valid || !input.packageValidation.valid) {
    reasons.push(`${input.validation.errors.length + input.packageValidation.errors.length} schema validation error(s) — the export cannot be produced until the underlying records are corrected.`);
    return { status: "INVALID", reasons };
  }
  if (input.coverage.coreFieldsMissing.length > 0) {
    reasons.push(`Core disclosure fields without authoritative OBV data: ${input.coverage.coreFieldsMissing.join(", ")}. The export is valid; these fields are omitted, not inferred.`);
    return { status: "INCOMPLETE", reasons };
  }
  return { status: "READY", reasons };
}

/** The exact URL a stored export is served from (also its package uri). */
export function exportUrl(baseUrl: string, exportId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/interop/oc4ids/exports/${encodeURIComponent(exportId)}`;
}

/** Compute the mapping and validate it. Nothing is persisted. */
export function previewOc4ids(user: User, projectId: string, baseUrl: string | null): Oc4idsPreview {
  const project = requireVisibleProject(user, projectId);
  return previewFor(user, project, baseUrl);
}

function previewFor(user: User, project: Project, baseUrl: string | null): Oc4idsPreview {
  const mapping = mapProjectToOc4ids(project);
  const publisher = publisherFor(user);
  const previewUri = baseUrl ? `${baseUrl.replace(/\/$/, "")}/api/interop/oc4ids/${encodeURIComponent(project.id)}/preview` : "";
  // The preview package carries a fixed, obviously-synthetic date so two
  // previews of unchanged records produce identical bytes; a real export
  // stamps its actual publication time.
  const pkg = buildPackage(publisher, previewUri || "about:blank", "1970-01-01T00:00:00Z", mapping.project);
  const validation = validateAgainst(OC4IDS_PROJECT_SCHEMA, mapping.project);
  const packageValidation = baseUrl
    ? validateAgainst(OC4IDS_PACKAGE_SCHEMA, pkg)
    : { valid: false, errors: [{ path: "/uri", keyword: "format", message: "no public base URL is configured" }], warnings: [] };
  const coverage = coverageOf(mapping);
  const { status, reasons } = statusOf({ publisher, baseUrl, validation, packageValidation, coverage });
  const exports = interopRepo.listExportsForProject(project.id, 500);
  return {
    projectId: project.id,
    projectName: project.name,
    status,
    statusReasons: reasons,
    standard: "OC4IDS",
    schemaVersion: OC4IDS_VERSION,
    packageVersion: OC4IDS_PACKAGE_VERSION,
    mappingVersion: OC4IDS_MAPPING_VERSION,
    notice: OC4IDS_NOTICE,
    publisher,
    project: mapping.project,
    package: pkg,
    fields: mapping.fields,
    omitted: mapping.omitted,
    sourceRecords: mapping.sourceRecords,
    excludedObvIntelligence: mapping.excludedObvIntelligence,
    validation,
    packageValidation,
    coverage,
    schemaCoverage: OC4IDS_SCHEMA_COVERAGE,
    lastExport: exports[0] ?? null,
    exportCount: exports.length,
    canExport: (status === "READY" || status === "INCOMPLETE") && ["PROJECT_MANAGER", "FUNDER_REP"].includes(user.role),
  };
}

export interface Oc4idsExportResult {
  record: InteropExportRecord;
  package: Record<string, unknown>;
  bytes: Buffer;
  url: string;
}

/** Produce an immutable export. Refuses when the publisher is not
 *  configured or the package does not validate. The project is read,
 *  never written. */
export function exportOc4ids(user: User, projectId: string, baseUrl: string | null): Oc4idsExportResult {
  assertExporter(user);
  const project = requireVisibleProject(user, projectId);
  const preview = previewFor(user, project, baseUrl);
  if (preview.status === "NOT_CONFIGURED") {
    throw new InteropError(`OC4IDS export is not configured: ${preview.statusReasons.join(" ")}`, 409);
  }
  if (preview.status === "INVALID") {
    throw new InteropError(`The OC4IDS package does not validate against the implemented schema subset: ${preview.statusReasons.join(" ")}`, 409);
  }
  const id = repo.newId();
  const exportedAt = nowIso();
  const url = exportUrl(baseUrl!, id);
  const pkg = buildPackage(preview.publisher, url, exportedAt, preview.project);
  const packageValidation = validateAgainst(OC4IDS_PACKAGE_SCHEMA, pkg);
  if (!packageValidation.valid) {
    throw new InteropError("The export package failed validation at publication time", 409);
  }
  const bytes = Buffer.from(JSON.stringify(pkg, null, 2), "utf8");
  fs.mkdirSync(resolveInteropKey("exports"), { recursive: true });
  const filePath = interopKey("exports", `oc4ids-${id}.json`);
  // Write-once: an existing file is never truncated.
  fs.writeFileSync(resolveInteropKey(filePath), bytes, { flag: "wx" });
  const record: InteropExportRecord = {
    id,
    organizationId: user.organizationId,
    projectId: project.id,
    standard: "OC4IDS",
    schemaVersion: OC4IDS_VERSION,
    mappingVersion: OC4IDS_MAPPING_VERSION,
    exportedAt,
    exportedByUserId: user.id,
    projectConfigVersion: project.pilot?.configVersion ?? 1,
    projectSha256: sha256Hex(canonicalJson(preview.project)),
    payloadSha256: sha256Hex(bytes),
    payloadBytes: bytes.length,
    payloadPath: filePath,
    sourceRecords: preview.sourceRecords,
    populatedFields: preview.fields.length,
    omittedFields: preview.omitted.length,
    validationErrors: preview.validation.errors.length + packageValidation.errors.length,
    validationWarnings: preview.validation.warnings.length + packageValidation.warnings.length,
    status: "VALID",
  };
  interopRepo.insertExport(record);
  repo.insertConfigAudit({
    id: repo.newId(),
    projectId: project.id,
    actorUserId: user.id,
    action: "OC4IDS_EXPORT_CREATED",
    entityType: "interop_export",
    entityId: id,
    reason: null,
    beforeSummary: null,
    afterSummary: `OC4IDS ${OC4IDS_VERSION} · mapping ${OC4IDS_MAPPING_VERSION} · ${record.populatedFields} fields · sha256 ${record.payloadSha256.slice(0, 16)}…`,
    createdAt: exportedAt,
  });
  return { record, package: pkg, bytes, url };
}

export function listOc4idsExports(user: User, projectId: string): InteropExportRecord[] {
  const project = requireVisibleProject(user, projectId);
  return interopRepo.listExportsForProject(project.id, 200);
}

export interface StoredExport {
  record: InteropExportRecord;
  bytes: Buffer;
  /** True when the stored bytes still hash to the recorded value. */
  integrityIntact: boolean;
}

/** Fetch a historical export. Same-404 across tenants; the bytes are
 *  re-hashed against the provenance record on every read. */
export function getOc4idsExport(user: User, exportId: string): StoredExport {
  const record = interopRepo.getExport(String(exportId ?? ""));
  if (!record) throw new InteropError("Not found", 404);
  // Resolves the project through the caller's own visibility: a record
  // from a project the caller cannot see is "not found", nothing more.
  requireVisibleProject(user, record.projectId);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(resolveInteropKey(record.payloadPath));
  } catch {
    throw new InteropError("The stored export file is missing; the provenance record remains", 409);
  }
  return { record, bytes, integrityIntact: sha256Hex(bytes) === record.payloadSha256 };
}

export interface Oc4idsValidationDocument {
  generatedAt: string;
  standard: "OC4IDS";
  schemaVersion: string;
  mappingVersion: string;
  projectId: string;
  projectName: string;
  status: Oc4idsStatus;
  statusReasons: string[];
  statement: string;
  validation: ValidationReport;
  packageValidation: ValidationReport;
  coverage: Oc4idsCoverage;
  populated: Array<{ path: string; source: string }>;
  omitted: OmittedField[];
  excludedObvIntelligence: string[];
  validatorKeywords: readonly string[];
  notImplemented: readonly string[];
}

/** The downloadable validation report (JSON). */
export function oc4idsValidationReport(user: User, projectId: string, baseUrl: string | null): Oc4idsValidationDocument {
  const p = previewOc4ids(user, projectId, baseUrl);
  return {
    generatedAt: nowIso(),
    standard: "OC4IDS",
    schemaVersion: p.schemaVersion,
    mappingVersion: p.mappingVersion,
    projectId: p.projectId,
    projectName: p.projectName,
    status: p.status,
    statusReasons: p.statusReasons,
    statement: OC4IDS_SCHEMA_COVERAGE.statement,
    validation: p.validation,
    packageValidation: p.packageValidation,
    coverage: p.coverage,
    populated: p.fields.map((f) => ({ path: f.path, source: `${f.source.table}.${f.source.field} (${f.source.recordId})${f.source.note ? ` — ${f.source.note}` : ""}` })),
    omitted: p.omitted,
    excludedObvIntelligence: p.excludedObvIntelligence,
    validatorKeywords: OC4IDS_SCHEMA_COVERAGE.validatorKeywords,
    notImplemented: OC4IDS_SCHEMA_COVERAGE.notImplemented,
  };
}
