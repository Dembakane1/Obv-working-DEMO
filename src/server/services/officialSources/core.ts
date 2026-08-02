/**
 * Official Source Connectors — core: error type, doctrine notice, role
 * gates, configuration, normalization + redaction helpers, and freshness
 * labeling.
 *
 * DOCTRINE. External government and licensing systems are information
 * sources, not OBV's source of truth. The lifecycle is retrieval ->
 * immutable raw snapshot -> normalized candidate -> match evaluation ->
 * reviewer confirmation -> authoritative OBV record, and the last step
 * happens ONLY through the existing governed DMV/permits commands. This
 * layer never approves or rejects a draw, marks an official inspection
 * passed, alters a governing permit basis, clears an exception, releases
 * a dispute hold, creates a lender decision or payment instruction,
 * moves funds, or overwrites a historical record.
 */
import { createHash } from "node:crypto";
import * as repo from "../../db/repo";
import * as authz from "../authz";
import type { OfficialSource, User } from "../../../shared/types";

export class OfficialSourceError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "OfficialSourceError";
    this.statusCode = statusCode;
  }
}

/** Stamped onto every official-sources surface. */
export const SOURCE_DOCTRINE_NOTICE =
  "OBV retrieves and records official-source information as evidence for authorized human review. " +
  "External records may be incomplete, delayed, changed, or incorrectly matched. OBV does not issue " +
  "permits, perform government inspections, grant licenses, provide legal interpretations, approve " +
  "draws, or automatically authorize payment.";

// ------------------------------------------------------------ role gates

/** Mirrors the permits/DMV domain: PMs may view; determinations (queue
 *  resolutions, promotions, attachments) need a funder representative or
 *  compliance reviewer. */
const VIEW_ROLES = new Set(["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"]);
const REVIEW_ROLES = new Set(["FUNDER_REP", "COMPLIANCE_REVIEWER"]);

export function canViewSources(user: User): boolean {
  return VIEW_ROLES.has(user.role);
}

export function canReviewSources(user: User): boolean {
  return REVIEW_ROLES.has(user.role);
}

export function assertSourceViewer(user: User): void {
  if (!canViewSources(user)) {
    throw new OfficialSourceError("Official Sources is not available for this role", 403);
  }
}

export function assertSourceReviewer(user: User): void {
  assertSourceViewer(user);
  if (!canReviewSources(user)) {
    throw new OfficialSourceError("Official-source review actions require a funder representative or compliance reviewer", 403);
  }
}

/** Same-404: a project the caller cannot see is indistinguishable from
 *  one that does not exist. */
export function requireVisibleProject(user: User, projectId: string) {
  const project = repo.getProject(String(projectId ?? ""));
  if (!project || !authz.accessibleProjectIds(user).has(project.id)) {
    throw new OfficialSourceError("Not found", 404);
  }
  return project;
}

// ------------------------------------------------------------ config

/** Automated polling is DISABLED until explicitly configured. */
export function pollingEnabled(): boolean {
  return /^(1|true)$/i.test(process.env.OBV_SOURCES_POLLING_ENABLE ?? "");
}

/** Test/dev escape hatch mirroring the webhook guard: allows loopback
 *  endpoints so deterministic mock servers can stand in for sources.
 *  Production leaves this unset. */
export function privateSourceHostsAllowed(): boolean {
  return /^(1|true)$/i.test(process.env.OBV_SOURCES_ALLOW_PRIVATE_HOSTS ?? "");
}

/** HTTPS-only in production; HTTP is allowed only alongside the private-
 *  host escape hatch (loopback mock servers speak plain HTTP). */
export function plainHttpAllowed(): boolean {
  return privateSourceHostsAllowed();
}

/** Per-source endpoint override: OBV_SOURCE_<ID>_URL with the source id
 *  uppercased and dashes replaced by underscores. This is how a
 *  deployment pins the exact official dataset/API endpoint. */
export function endpointOverrideFor(sourceId: string): string | null {
  const key = `OBV_SOURCE_${sourceId.toUpperCase().replace(/-/g, "_")}_URL`;
  const value = (process.env[key] ?? "").trim();
  return value.length > 0 ? value : null;
}

/** Resolve a source's credential from its env REFERENCE. The secret is
 *  read at call time, never stored, never logged, never echoed. */
export function credentialFor(source: OfficialSource): string | null {
  if (source.authType === "NONE") return null;
  if (!source.credentialEnv) return null;
  const value = (process.env[source.credentialEnv] ?? "").trim();
  return value.length > 0 ? value : null;
}

// ------------------------------------------------------------ helpers

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Casefold + collapse whitespace. */
export function normalizeText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Alphanumeric-only key for permit/license numbers. */
export function normalizeIdentifier(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Conservative street-address normalization: casefold, strip
 *  punctuation, expand a few USPS-style suffixes/directionals. Advisory
 *  only — never the sole basis for a match confirmation. */
const ADDRESS_SUBS: Array<[RegExp, string]> = [
  [/\bstreet\b/g, "st"], [/\bavenue\b/g, "ave"], [/\bboulevard\b/g, "blvd"],
  [/\bdrive\b/g, "dr"], [/\bplace\b/g, "pl"], [/\bcourt\b/g, "ct"],
  [/\broad\b/g, "rd"], [/\blane\b/g, "ln"], [/\bterrace\b/g, "ter"],
  [/\bnorthwest\b/g, "nw"], [/\bnortheast\b/g, "ne"],
  [/\bsouthwest\b/g, "sw"], [/\bsoutheast\b/g, "se"],
  [/\bwashington,?\s+dc\b/g, ""], [/\bdc\b/g, ""],
];
export function normalizeAddress(value: unknown): string {
  let out = String(value ?? "").toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  for (const [pattern, sub] of ADDRESS_SUBS) out = out.replace(pattern, sub);
  return out.replace(/\s+/g, " ").trim();
}

/** Redact anything that looks like a credential from text destined for
 *  logs, errors, or stored records. Defense in depth — credentials are
 *  never intentionally placed in these strings to begin with. */
export function redactSecrets(text: string): string {
  return String(text ?? "")
    .replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]")
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/([?&](?:api[_-]?key|key|token|apikey|access[_-]?token|secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(x-api-key\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]");
}

/** Coarse, sanitized error class for storage/display — enough to
 *  diagnose, never a probe read-out and never a secret. */
export function safeErrorLabel(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return "source unreachable";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "source host could not be resolved";
  if (code === "CERT_HAS_EXPIRED" || String(code ?? "").startsWith("ERR_TLS")) return "TLS handshake failed";
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out|timeout/i.test(message)) return "source request timed out";
  if (/too large|size limit/i.test(message)) return "source response exceeded the size limit";
  if (/refused/i.test(message)) return "source refused the request";
  if (err instanceof OfficialSourceError) return redactSecrets(message).slice(0, 200);
  return "source retrieval failed";
}

// ------------------------------------------------------------ freshness

export type FreshnessLabel =
  | "Live official API"
  | "Official open-data snapshot"
  | "Official portal lookup"
  | "Manually verified official record"
  | "Cached official record"
  | "Source temporarily unavailable"
  | "Human confirmation required";

/** Plain-language freshness for a retrieved record. Cached or manual
 *  data is never called "live". */
export function freshnessLabel(input: {
  category: OfficialSource["category"];
  health: OfficialSource["health"];
  retrievedAt: string | null;
  reviewerConfirmed: boolean;
  maxFreshMinutes?: number;
}): FreshnessLabel {
  if (input.health === "DOWN") return "Source temporarily unavailable";
  if (input.category === "OFFICIAL_PORTAL_MANUAL" || input.category === "UNAVAILABLE") {
    return input.reviewerConfirmed ? "Manually verified official record" : "Human confirmation required";
  }
  if (!input.retrievedAt) return "Human confirmation required";
  const ageMinutes = (Date.now() - Date.parse(input.retrievedAt)) / 60_000;
  const maxFresh = input.maxFreshMinutes ?? 24 * 60;
  if (Number.isNaN(ageMinutes) || ageMinutes > maxFresh) return "Cached official record";
  if (input.category === "OFFICIAL_API") return "Live official API";
  if (input.category === "OFFICIAL_OPEN_DATA" || input.category === "OFFICIAL_DOWNLOAD") {
    return "Official open-data snapshot";
  }
  return "Official portal lookup";
}

/** Human age string ("3h ago", "12d ago"). */
export function ageLabel(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ------------------------------------------------------------ startup

export function assertOfficialSourcesConfig(): void {
  // Polling must be an explicit choice; a configured-but-unparseable
  // interval is a refused startup, not a silent default.
  const interval = (process.env.OBV_SOURCES_POLL_INTERVAL_MINUTES ?? "").trim();
  if (interval && (!/^\d+$/.test(interval) || Number(interval) < 5)) {
    throw new OfficialSourceError(
      "OBV_SOURCES_POLL_INTERVAL_MINUTES must be a whole number of minutes (minimum 5)"
    );
  }
}

export function officialSourcesStartupNotice(): string {
  return `official sources: connectors registered (automated polling ${pollingEnabled() ? "ENABLED" : "disabled"}; retrieval on explicit request)`;
}
