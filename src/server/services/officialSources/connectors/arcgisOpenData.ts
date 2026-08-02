/**
 * ArcGIS open-data adapter — one adapter class for every DC source
 * published as an Open Data DC / ArcGIS FeatureServer dataset (DOB
 * building permits, Certificates of Occupancy, DLCP Basic Business
 * Licenses, property/parcel references).
 *
 * HONESTY RULES
 *  - Live retrieval requires the operator to configure the exact
 *    official dataset query endpoint (OBV_SOURCE_<ID>_URL) from the
 *    dataset's documented API page. Without it the adapter returns
 *    NOT_CONFIGURED with manual portal instructions — it never guesses
 *    an endpoint and never fabricates a response.
 *  - The endpoint's host must sit on the source's registered allowlist
 *    of official DC hosts; everything else is refused by the egress
 *    client.
 *  - Dataset schemas drift. Field mapping works from candidate column
 *    lists; a missing logical field records a normalization warning
 *    instead of inventing a value.
 */
import type { CandidateField, OfficialSource, SourceRecordType } from "../../../../shared/types";
import {
  endpointOverrideFor,
  normalizeText,
  safeErrorLabel,
} from "../core";
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

export interface ArcgisFieldCandidates {
  externalId: string[];
  permitNumber: string[];
  status: string[];
  address: string[];
  party: string[];
  applicationDate: string[];
  issuanceDate: string[];
  expirationDate: string[];
  inspectionDate: string[];
  inspectionResult: string[];
  lastModified: string[];
}

export interface ArcgisDatasetConfig {
  sourceId: string;
  name: string;
  agency: string;
  recordType: SourceRecordType;
  recordTypes: SourceRecordType[];
  portalUrl: string;            // official dataset landing page (reference)
  docsUrl: string;              // official API documentation page
  allowedHosts: string[];       // official DC hosts this dataset may live on
  fieldCandidates: ArcgisFieldCandidates;
  expectedUpdateFrequency: string;
  termsNotes: string;
  retentionNotes: string;
}

const CONNECTOR_VERSION = "1.0.0";
const SCHEMA_VERSION = "arcgis-v1";

/** Escape a literal for an ArcGIS WHERE clause (single-quote doubling).
 *  Field names are never user input — they come from the trusted config. */
function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** ArcGIS date attributes are epoch milliseconds; tolerate ISO strings. */
function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

function firstPresent(attrs: Record<string, unknown>, candidates: string[]): { field: string; value: unknown } | null {
  for (const name of candidates) {
    if (name in attrs && attrs[name] !== null && attrs[name] !== undefined && attrs[name] !== "") {
      return { field: name, value: attrs[name] };
    }
  }
  return null;
}

export function makeArcgisConnector(cfg: ArcgisDatasetConfig): OfficialSourceConnector {
  const definition: OfficialSource = {
    id: cfg.sourceId,
    jurisdiction: "US-DC",
    agency: cfg.agency,
    name: cfg.name,
    category: "OFFICIAL_OPEN_DATA",
    baseUrl: cfg.portalUrl,
    docsUrl: cfg.docsUrl,
    recordTypes: cfg.recordTypes,
    authType: "NONE",
    credentialEnv: null,
    pollingSupported: true,
    rateLimitPerMinute: 30,
    retentionNotes: cfg.retentionNotes,
    termsNotes: cfg.termsNotes,
    expectedUpdateFrequency: cfg.expectedUpdateFrequency,
    sourceTimezone: "America/New_York",
    operationalStatus: "ENABLED",
    schemaVersion: SCHEMA_VERSION,
    connectorVersion: CONNECTOR_VERSION,
    allowedHosts: cfg.allowedHosts,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    health: "UNKNOWN",
    maintenanceNotes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const notConfigured = (): ConnectorResult => ({
    kind: "NOT_CONFIGURED",
    records: [],
    manualInstructions:
      `Automated retrieval for "${cfg.name}" is disabled until the official dataset query endpoint is ` +
      `configured (${envNameFor(cfg.sourceId)}). Copy the query URL from the dataset's official API page ` +
      `(${cfg.docsUrl}). Until then, perform the lookup on the official portal (${cfg.portalUrl}) and record ` +
      `it as a manual source verification.`,
  });

  function endpoint(): string | null {
    return endpointOverrideFor(cfg.sourceId);
  }

  function queryUrl(base: string, params: Record<string, string>): string {
    const url = new URL(base.endsWith("/query") ? base : `${base.replace(/\/$/, "")}/query`);
    url.searchParams.set("f", "json");
    url.searchParams.set("outFields", "*");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  async function runQuery(where: string, extra: Record<string, string> = {}): Promise<ConnectorResult> {
    const base = endpoint();
    if (!base) return notConfigured();
    const url = queryUrl(base, { where, ...extra });
    let response;
    try {
      response = await fetchOfficial(definitionWithConfiguredHost(base), url, {
        acceptContentTypes: ["application/json", "application/geo+json", "text/plain", "text/javascript"],
      });
    } catch (err) {
      return { kind: "SOURCE_UNAVAILABLE", records: [], errorLabel: safeErrorLabel(err) };
    }
    const parsed = parseJsonSafely(response.bodyText) as
      | { features?: Array<{ attributes?: Record<string, unknown> }>; error?: { message?: string } }
      | null;
    const evidence = {
      httpStatus: response.httpStatus,
      contentType: response.contentType,
      rawPayload: response.bodyText,
      headers: response.headers,
      url,
    };
    if (!parsed || typeof parsed !== "object") {
      return { kind: "SOURCE_UNAVAILABLE", records: [], errorLabel: "malformed source response", evidence };
    }
    if (parsed.error) {
      return { kind: "SOURCE_UNAVAILABLE", records: [], errorLabel: "source reported a query error", evidence };
    }
    const features = Array.isArray(parsed.features) ? parsed.features : [];
    const records: RawSourceRecord[] = [];
    for (const f of features) {
      const attrs = (f && typeof f === "object" && f.attributes && typeof f.attributes === "object")
        ? (f.attributes as Record<string, unknown>)
        : null;
      if (!attrs) continue;
      const ext = firstPresent(attrs, cfg.fieldCandidates.externalId);
      if (!ext) continue; // no identifier — cannot track; validation warning surfaces via normalize
      const lm = firstPresent(attrs, cfg.fieldCandidates.lastModified);
      records.push({
        externalId: String(ext.value),
        payload: attrs,
        sourceUpdatedAt: lm ? toIsoDate(lm.value) : null,
        sourceUrl: cfg.portalUrl,
      });
    }
    return { kind: "OK", records, evidence };
  }

  /** The registry row is the source of truth for allowed hosts; when the
   *  operator configures the endpoint we still validate its host against
   *  the registered official-host allowlist. */
  function definitionWithConfiguredHost(_base: string): OfficialSource {
    return { ...definition };
  }

  return {
    sourceMetadata: () => ({ ...definition }),

    healthCheck: async (): Promise<ConnectorHealth> => {
      const base = endpoint();
      if (!base) {
        return {
          status: "NOT_CONFIGURED",
          detail: `Endpoint not configured (${envNameFor(cfg.sourceId)}); lookups fall back to the official portal.`,
        };
      }
      const probe = await runQuery("1=0", { resultRecordCount: "1" });
      if (probe.kind === "OK") return { status: "HEALTHY", detail: "Official dataset endpoint reachable." };
      return { status: "DOWN", detail: probe.errorLabel ?? "Official dataset endpoint unreachable." };
    },

    search: async (query: SourceSearchQuery): Promise<ConnectorResult> => {
      const clauses: string[] = [];
      const number = query.permitNumber ?? query.licenseNumber ?? null;
      if (number) {
        const cands = cfg.fieldCandidates.permitNumber;
        if (cands.length > 0) {
          clauses.push(
            "(" + cands.map((f) => `UPPER(${f}) = ${q(String(number).toUpperCase())}`).join(" OR ") + ")"
          );
        }
      }
      if (query.address) {
        const cands = cfg.fieldCandidates.address;
        if (cands.length > 0) {
          clauses.push(
            "(" + cands.map((f) => `UPPER(${f}) LIKE ${q("%" + String(query.address).toUpperCase() + "%")}`).join(" OR ") + ")"
          );
        }
      }
      if (query.party) {
        const cands = cfg.fieldCandidates.party;
        if (cands.length > 0) {
          clauses.push(
            "(" + cands.map((f) => `UPPER(${f}) LIKE ${q("%" + String(query.party).toUpperCase() + "%")}`).join(" OR ") + ")"
          );
        }
      }
      const where = clauses.length > 0 ? clauses.join(" AND ") : "1=1";
      return runQuery(where, { resultRecordCount: String(Math.min(query.limit ?? 50, 200)) });
    },

    fetchRecord: async (externalId: string): Promise<ConnectorResult> => {
      const cands = cfg.fieldCandidates.externalId;
      const where =
        "(" + cands.map((f) => `UPPER(${f}) = ${q(String(externalId).toUpperCase())}`).join(" OR ") + ")";
      return runQuery(where, { resultRecordCount: "5" });
    },

    fetchChanges: async (cursor: string | null): Promise<ConnectorResult> => {
      const lmFields = cfg.fieldCandidates.lastModified;
      if (lmFields.length === 0) {
        const result = await runQuery("1=1", { resultRecordCount: "200" });
        if (result.kind === "OK") result.cursor = null;
        return result;
      }
      const lm = lmFields[0];
      const sinceMs = cursor ? Number(cursor) : 0;
      const result = await runQuery(
        Number.isFinite(sinceMs) && sinceMs > 0 ? `${lm} > ${Math.floor(sinceMs)}` : "1=1",
        { resultRecordCount: "200", orderByFields: `${lm} ASC` }
      );
      if (result.kind === "OK") {
        let maxSeen = sinceMs;
        for (const r of result.records) {
          const value = (r.payload as Record<string, unknown>)[lm];
          if (typeof value === "number" && value > maxSeen) maxSeen = value;
        }
        result.cursor = maxSeen > 0 ? String(maxSeen) : cursor;
      }
      return result;
    },

    normalize: (raw: RawSourceRecord): NormalizedSourceRecord => {
      const attrs = raw.payload;
      const warnings: string[] = [];
      const fields: Record<string, CandidateField> = {};
      const pick = (logical: keyof ArcgisFieldCandidates, normalizer: (v: unknown) => string | null): string | null => {
        const hit = firstPresent(attrs, cfg.fieldCandidates[logical]);
        if (!hit) {
          if (cfg.fieldCandidates[logical].length > 0) {
            warnings.push(`source did not provide a value for ${String(logical)}`);
          }
          return null;
        }
        const verbatim = String(hit.value);
        const normalized = normalizer(hit.value);
        fields[String(logical)] = { value: normalized, verbatim };
        return normalized;
      };
      const status = pick("status", (v) => normalizeText(v) || null);
      const statusHit = firstPresent(attrs, cfg.fieldCandidates.status);
      return {
        externalId: raw.externalId,
        recordType: cfg.recordType,
        normalizedStatus: status,
        verbatimStatus: statusHit ? String(statusHit.value) : null,
        address: (() => { const h = firstPresent(attrs, cfg.fieldCandidates.address); return h ? String(h.value) : null; })(),
        permitNumber: pick("permitNumber", (v) => String(v).trim() || null),
        applicationDate: pick("applicationDate", toIsoDate),
        issuanceDate: pick("issuanceDate", toIsoDate),
        expirationDate: pick("expirationDate", toIsoDate),
        inspectionDate: pick("inspectionDate", toIsoDate),
        inspectionResult: pick("inspectionResult", (v) => normalizeText(v) || null),
        enforcementDate: null,
        partyName: (() => { const h = firstPresent(attrs, cfg.fieldCandidates.party); return h ? String(h.value) : null; })(),
        sourceUrl: raw.sourceUrl,
        sourceConfidence: 0.9,
        fields,
        warnings,
      };
    },

    validate: (raw: RawSourceRecord): string[] => {
      const warnings: string[] = [];
      if (!raw.externalId) warnings.push("record has no external identifier");
      const status = firstPresent(raw.payload, cfg.fieldCandidates.status);
      if (!status) warnings.push("record has no status field (possible dataset schema drift)");
      return warnings;
    },

    buildProvenance: (raw: RawSourceRecord): SourceProvenance => ({
      sourceId: cfg.sourceId,
      connectorVersion: CONNECTOR_VERSION,
      retrievedVia: "official Open Data DC dataset (ArcGIS FeatureServer query)",
      officialUrl: raw.sourceUrl ?? cfg.portalUrl,
    }),
  };
}

export function envNameFor(sourceId: string): string {
  return `OBV_SOURCE_${sourceId.toUpperCase().replace(/-/g, "_")}_URL`;
}
