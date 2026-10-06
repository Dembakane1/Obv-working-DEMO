/**
 * Infrastructure Interoperability — core: error type, doctrine notices,
 * role gates, tenant scoping, publisher configuration and helpers.
 *
 * DOCTRINE. Interoperability makes OBV speak the infrastructure-data
 * ecosystem's language without weakening OBV's verification model:
 *
 *   OC4IDS  = standardized infrastructure DISCLOSURE, exported ONLY from
 *             authoritative OBV records, field by field, with the source
 *             of every value stated and everything else omitted.
 *   OBV     = verification, provenance, review and financial control —
 *             NEVER placed inside OC4IDS fields that do not represent it.
 *
 * External field observations enter as UNVERIFIED candidates and reach
 * evidence ONLY through a reviewer's decision and the existing governed
 * evidence pipeline. This layer never approves evidence, a milestone, a
 * draw, an exception or an inspection, never marks progress complete,
 * never authorizes payment and never releases funds.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { INTEROP_DIR } from "../../db/index";
import * as repo from "../../db/repo";
import * as authz from "../authz";
import type { Project, User } from "../../../shared/types";

export class InteropError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "InteropError";
    this.statusCode = statusCode;
  }
}

/** Stamped onto every OC4IDS surface. */
export const OC4IDS_NOTICE =
  "An OC4IDS export contains standardized infrastructure disclosure data drawn only from authoritative OBV " +
  "project records. Fields OBV cannot support from authoritative data are omitted, never inferred. OBV's " +
  "verification findings, evidence integrity, review history, draw readiness, lender decisions and release " +
  "controls are not part of the standard and are never exported as disclosure data.";

/** Stamped onto every external field observation surface. */
export const FIELD_OBSERVATION_NOTICE =
  "External field observations are imported as unverified candidates with their original source, record " +
  "identifier, timestamp and coordinates preserved. They become OBV evidence only when a reviewer accepts " +
  "them, through the same governed evidence pipeline as direct capture. An import never approves evidence, " +
  "a milestone, a draw, an exception or an inspection, never marks progress complete and never authorizes " +
  "or releases payment.";

// ------------------------------------------------------------ role gates

/** Mirrors the permits / official-sources domains: PMs (administrators),
 *  funder representatives and compliance reviewers may view. */
const VIEW_ROLES = new Set(["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"]);
/** Producing a disclosure export is an administrative act. */
const EXPORT_ROLES = new Set(["PROJECT_MANAGER", "FUNDER_REP"]);
/** Importing an external dataset is an administrative act. */
const IMPORT_ROLES = new Set(["PROJECT_MANAGER", "FUNDER_REP"]);
/** Deciding whether an observation becomes evidence is a review act. */
const REVIEW_ROLES = new Set(["FUNDER_REP", "COMPLIANCE_REVIEWER"]);

export function canViewInterop(user: User): boolean {
  return VIEW_ROLES.has(user.role);
}
export function canExportOc4ids(user: User): boolean {
  return EXPORT_ROLES.has(user.role);
}
export function canImportObservations(user: User): boolean {
  return IMPORT_ROLES.has(user.role);
}
export function canReviewObservations(user: User): boolean {
  return REVIEW_ROLES.has(user.role);
}

export function assertInteropViewer(user: User): void {
  if (!canViewInterop(user)) throw new InteropError("Infrastructure data is not available for this role", 403);
}
export function assertExporter(user: User): void {
  assertInteropViewer(user);
  if (!canExportOc4ids(user)) {
    throw new InteropError("Producing an OC4IDS export requires an administrator or funder representative", 403);
  }
}
export function assertImporter(user: User): void {
  assertInteropViewer(user);
  if (!canImportObservations(user)) {
    throw new InteropError("Importing external field observations requires an administrator or funder representative", 403);
  }
}
export function assertObservationReviewer(user: User): void {
  assertInteropViewer(user);
  if (!canReviewObservations(user)) {
    throw new InteropError("Reviewing external field observations requires a funder representative or compliance reviewer", 403);
  }
}

/** Same-404: a project the caller cannot see is indistinguishable from
 *  one that does not exist. The viewer gate runs first so a role that
 *  cannot use this area never learns which ids resolve. */
export function requireVisibleProject(user: User, projectId: string): Project {
  assertInteropViewer(user);
  const project = repo.getProject(String(projectId ?? ""));
  if (!project || !authz.accessibleProjectIds(user).has(project.id)) {
    throw new InteropError("Not found", 404);
  }
  return project;
}

// ------------------------------------------------------------ config

export interface Oc4idsPublisherConfig {
  /** The registered OC4IDS project-id prefix (e.g. "oc4ids-a1b2c3"). */
  projectIdPrefix: string | null;
  /** Whether the prefix has the registered "oc4ids-xxxxxx" shape. */
  prefixWellFormed: boolean;
  licenseUrl: string | null;
  publicationPolicyUrl: string | null;
}

/** Publisher configuration is deployment-level (the prefix is registered
 *  once by the operator); publisher identity itself comes from the
 *  exporting user's organization record. No value here is a secret. */
export function oc4idsPublisherConfig(): Oc4idsPublisherConfig {
  const prefix = (process.env.OBV_OC4IDS_PROJECT_ID_PREFIX ?? "").trim();
  const url = (name: string): string | null => {
    const v = (process.env[name] ?? "").trim();
    return /^https?:\/\//i.test(v) ? v : null;
  };
  return {
    projectIdPrefix: prefix.length > 0 ? prefix : null,
    prefixWellFormed: /^oc4ids-[a-z0-9]{6}$/i.test(prefix),
    licenseUrl: url("OBV_OC4IDS_LICENSE_URL"),
    publicationPolicyUrl: url("OBV_OC4IDS_PUBLICATION_POLICY_URL"),
  };
}

// ------------------------------------------------------------ helpers

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Bounded, trimmed string or null. Never throws. */
export function strOrNull(value: unknown, max = 400): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length === 0 ? null : s.slice(0, max);
}

/** Finite number or null. Strings that parse as numbers are accepted
 *  (field-collection exports frequently stringify numerics). */
export function numOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** ISO 8601 normalization: returns null for absent/unparseable values —
 *  a timestamp is never invented. Date-only values are kept as calendar
 *  days (rendered at 00:00:00Z) and the verbatim string is retained by
 *  the caller. */
export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function interopStartupNotice(): string {
  const cfg = oc4idsPublisherConfig();
  return `interoperability: OC4IDS export ${cfg.projectIdPrefix ? "configured (publisher prefix set)" : "NOT CONFIGURED (set OBV_OC4IDS_PROJECT_ID_PREFIX)"}; external field-data providers: none connected (deterministic import only)`;
}

/**
 * Interop artifacts are referenced by LOGICAL keys relative to the
 * interoperability data root (e.g. `exports/oc4ids-<id>.json`), never by
 * absolute host paths — the storage doctrine every OBV record follows.
 * The key is resolved at read/write time and refused if it would escape
 * the root.
 */
export function interopKey(...segments: string[]): string {
  return path.posix.join(...segments);
}
export function resolveInteropKey(key: string): string {
  const normalized = path.posix.normalize(String(key ?? "").replace(/\\/g, "/"));
  if (!normalized || normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
    throw new InteropError("Not found", 404);
  }
  const full = path.resolve(INTEROP_DIR, normalized);
  const root = path.resolve(INTEROP_DIR) + path.sep;
  if (!full.startsWith(root)) throw new InteropError("Not found", 404);
  return full;
}
