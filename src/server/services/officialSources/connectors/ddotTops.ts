/**
 * DDOT TOPS adapter — District Department of Transportation,
 * Transportation Online Permitting System (public-space construction and
 * occupancy permits).
 *
 * TOPS publishes a documented public Web API (https://topsapi.ddot.dc.gov/Help)
 * that requires a registered license key sent as a Bearer token. This
 * adapter implements that documented authentication shape — and refuses
 * to operate until BOTH are configured:
 *
 *   1. the license key (env named by credential_env), and
 *   2. the exact API endpoint URL copied from the official API guide
 *      (OBV_SOURCE_DC_DDOT_TOPS_PERMITS_URL),
 *
 * because route paths belong to DDOT's documentation, not to guesses in
 * this codebase. Unconfigured, every call returns NOT_CONFIGURED with
 * manual instructions pointing at the official TOPS portal — automated
 * behavior is never fabricated.
 */
import type { CandidateField, OfficialSource } from "../../../../shared/types";
import { credentialFor, endpointOverrideFor, normalizeText, safeErrorLabel } from "../core";
import { fetchOfficial, parseJsonSafely } from "../egress";
import type {
  ConnectorHealth,
  ConnectorResult,
  NormalizedSourceRecord,
  OfficialSourceConnector,
  RawSourceRecord,
  SourceProvenance,
  SourceSearchQuery,
} from "./types";

export const TOPS_SOURCE_ID = "dc-ddot-tops-permits";
const CONNECTOR_VERSION = "1.0.0";
const SCHEMA_VERSION = "tops-v1";

const definition: OfficialSource = {
  id: TOPS_SOURCE_ID,
  jurisdiction: "US-DC",
  agency: "DDOT",
  name: "DDOT TOPS — public-space construction & occupancy permits",
  category: "OFFICIAL_API",
  baseUrl: "https://topsapi.ddot.dc.gov",
  docsUrl: "https://topsapi.ddot.dc.gov/Help",
  recordTypes: ["PERMIT"],
  authType: "BEARER",
  credentialEnv: "OBV_SOURCE_DC_DDOT_TOPS_PERMITS_KEY",
  pollingSupported: true,
  rateLimitPerMinute: 20,
  retentionNotes: "Store only what review requires; TOPS data syncs from the transactional system roughly every 10 minutes.",
  termsNotes:
    "Documented public Web API; requires a license key registered with DDOT. Requests carry the key as a " +
    "Bearer token per the official API guide. Respect DDOT rate guidance; no scraping of the TOPS portal.",
  expectedUpdateFrequency: "~10 minutes (per DDOT documentation)",
  sourceTimezone: "America/New_York",
  operationalStatus: "ENABLED",
  schemaVersion: SCHEMA_VERSION,
  connectorVersion: CONNECTOR_VERSION,
  allowedHosts: ["topsapi.ddot.dc.gov"],
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  health: "UNKNOWN",
  maintenanceNotes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Candidate field names seen across TOPS permit payload variants —
 *  mapped tolerantly; absences record schema-drift warnings. */
const FIELD_CANDIDATES = {
  externalId: ["TrackingNumber", "trackingNumber", "PermitNumber", "permitNumber", "Id", "id"],
  permitNumber: ["PermitNumber", "permitNumber", "TrackingNumber", "trackingNumber"],
  status: ["Status", "status", "PermitStatus", "permitStatus"],
  address: ["Address", "address", "Location", "location", "SiteAddress"],
  party: ["ApplicantName", "applicantName", "Applicant", "CompanyName", "companyName"],
  applicationDate: ["ApplicationDate", "applicationDate", "AppliedDate"],
  issuanceDate: ["IssuedDate", "issuedDate", "EffectiveDate", "effectiveDate"],
  expirationDate: ["ExpirationDate", "expirationDate", "ExpireDate"],
  lastModified: ["LastModifiedDate", "lastModifiedDate", "ModifiedDate"],
};

function firstPresent(obj: Record<string, unknown>, names: string[]): { field: string; value: unknown } | null {
  for (const n of names) {
    if (n in obj && obj[n] !== null && obj[n] !== undefined && obj[n] !== "") return { field: n, value: obj[n] };
  }
  return null;
}

function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

function configState(): { endpoint: string | null; key: string | null } {
  return { endpoint: endpointOverrideFor(TOPS_SOURCE_ID), key: credentialFor(definition) };
}

function notConfigured(missing: string): ConnectorResult {
  return {
    kind: "NOT_CONFIGURED",
    records: [],
    manualInstructions:
      `Automated TOPS retrieval is disabled until ${missing}. Register for an API license key with DDOT and ` +
      `copy the permit query endpoint from the official API guide (https://topsapi.ddot.dc.gov/Help) into ` +
      `OBV_SOURCE_DC_DDOT_TOPS_PERMITS_URL, with the key in OBV_SOURCE_DC_DDOT_TOPS_PERMITS_KEY. Until then, ` +
      `look permits up in TOPS directly and record a manual source verification.`,
  };
}

async function runQuery(params: Record<string, string>): Promise<ConnectorResult> {
  const { endpoint, key } = configState();
  if (!endpoint) return notConfigured("the API endpoint is configured");
  if (!key) return notConfigured("the DDOT license key is configured");
  const url = new URL(endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let response;
  try {
    response = await fetchOfficial(definition, url.toString(), {
      headers: { authorization: `Bearer ${key}` },
      acceptContentTypes: ["application/json", "text/plain", "text/json"],
    });
  } catch (err) {
    return { kind: "SOURCE_UNAVAILABLE", records: [], errorLabel: safeErrorLabel(err) };
  }
  const evidence = {
    httpStatus: response.httpStatus,
    contentType: response.contentType,
    rawPayload: response.bodyText,
    headers: response.headers,
    url: url.toString(),
  };
  if (response.httpStatus === 401 || response.httpStatus === 403) {
    return { kind: "SOURCE_UNAVAILABLE", records: [], errorLabel: "source rejected the configured credential", evidence };
  }
  const parsed = parseJsonSafely(response.bodyText);
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "SOURCE_UNAVAILABLE", records: [], errorLabel: "malformed source response", evidence };
  }
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>).Permits)
    ? ((parsed as Record<string, unknown>).Permits as unknown[])
    : Array.isArray((parsed as Record<string, unknown>).data)
    ? ((parsed as Record<string, unknown>).data as unknown[])
    : [parsed];
  const records: RawSourceRecord[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const ext = firstPresent(obj, FIELD_CANDIDATES.externalId);
    if (!ext) continue;
    const lm = firstPresent(obj, FIELD_CANDIDATES.lastModified);
    records.push({
      externalId: String(ext.value),
      payload: obj,
      sourceUpdatedAt: lm ? toIsoDate(lm.value) : null,
      sourceUrl: definition.baseUrl,
    });
  }
  return { kind: "OK", records, evidence };
}

export const ddotTopsConnector: OfficialSourceConnector = {
  sourceMetadata: () => ({ ...definition }),

  healthCheck: async (): Promise<ConnectorHealth> => {
    const { endpoint, key } = configState();
    if (!endpoint || !key) {
      return {
        status: "NOT_CONFIGURED",
        detail:
          "TOPS API endpoint and license key are not configured; permit lookups fall back to the official TOPS portal.",
      };
    }
    const probe = await runQuery({ pageSize: "1" });
    if (probe.kind === "OK") return { status: "HEALTHY", detail: "TOPS Web API reachable." };
    return { status: "DOWN", detail: probe.errorLabel ?? "TOPS Web API unreachable." };
  },

  search: async (query: SourceSearchQuery): Promise<ConnectorResult> => {
    const params: Record<string, string> = { pageSize: String(Math.min(query.limit ?? 50, 200)) };
    if (query.permitNumber) params.permitNumber = query.permitNumber;
    if (query.address) params.address = query.address;
    if (query.party) params.applicant = query.party;
    return runQuery(params);
  },

  fetchRecord: async (externalId: string): Promise<ConnectorResult> => {
    return runQuery({ permitNumber: externalId, pageSize: "5" });
  },

  fetchChanges: async (cursor: string | null): Promise<ConnectorResult> => {
    const params: Record<string, string> = { pageSize: "200" };
    if (cursor) params.modifiedSince = cursor;
    const result = await runQuery(params);
    if (result.kind === "OK") {
      let max = cursor ?? "";
      for (const r of result.records) {
        if (r.sourceUpdatedAt && r.sourceUpdatedAt > max) max = r.sourceUpdatedAt;
      }
      result.cursor = max || cursor || null;
    }
    return result;
  },

  normalize: (raw: RawSourceRecord): NormalizedSourceRecord => {
    const obj = raw.payload;
    const warnings: string[] = [];
    const fields: Record<string, CandidateField> = {};
    const pick = (logical: keyof typeof FIELD_CANDIDATES, normalizer: (v: unknown) => string | null): string | null => {
      const hit = firstPresent(obj, FIELD_CANDIDATES[logical]);
      if (!hit) {
        warnings.push(`source did not provide a value for ${String(logical)}`);
        return null;
      }
      const verbatim = String(hit.value);
      const value = normalizer(hit.value);
      fields[String(logical)] = { value, verbatim };
      return value;
    };
    const statusHit = firstPresent(obj, FIELD_CANDIDATES.status);
    return {
      externalId: raw.externalId,
      recordType: "PERMIT",
      normalizedStatus: pick("status", (v) => normalizeText(v) || null),
      verbatimStatus: statusHit ? String(statusHit.value) : null,
      address: (() => { const h = firstPresent(obj, FIELD_CANDIDATES.address); return h ? String(h.value) : null; })(),
      permitNumber: pick("permitNumber", (v) => String(v).trim() || null),
      applicationDate: pick("applicationDate", toIsoDate),
      issuanceDate: pick("issuanceDate", toIsoDate),
      expirationDate: pick("expirationDate", toIsoDate),
      inspectionDate: null,
      inspectionResult: null,
      enforcementDate: null,
      partyName: (() => { const h = firstPresent(obj, FIELD_CANDIDATES.party); return h ? String(h.value) : null; })(),
      sourceUrl: raw.sourceUrl,
      sourceConfidence: 0.9,
      fields,
      warnings,
    };
  },

  validate: (raw: RawSourceRecord): string[] => {
    const warnings: string[] = [];
    if (!raw.externalId) warnings.push("record has no tracking or permit number");
    if (!firstPresent(raw.payload, FIELD_CANDIDATES.status)) {
      warnings.push("record has no status field (possible API schema drift)");
    }
    return warnings;
  },

  buildProvenance: (raw: RawSourceRecord): SourceProvenance => ({
    sourceId: TOPS_SOURCE_ID,
    connectorVersion: CONNECTOR_VERSION,
    retrievedVia: "DDOT TOPS Web API (documented public API, licensed key)",
    officialUrl: raw.sourceUrl ?? definition.baseUrl,
  }),
};
