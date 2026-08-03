/**
 * Provider-neutral connector contract.
 *
 * A connector adapts ONE official source to the shared lifecycle. All
 * agency- and vendor-specific knowledge (endpoints, field names, auth
 * shape) lives inside the adapter; business services see only this
 * interface. An adapter that cannot safely or legally automate
 * retrieval MUST return MANUAL_VERIFICATION_REQUIRED — it never
 * fabricates live API behavior.
 */
import type {
  CandidateField,
  OfficialSource,
  SourceRecordType,
} from "../../../../shared/types";

/** Search parameters a reviewer can supply. Connectors use what their
 *  source supports and ignore the rest (recording a warning). */
export interface SourceSearchQuery {
  recordType?: SourceRecordType;
  permitNumber?: string;
  licenseNumber?: string;
  address?: string;
  party?: string;
  limit?: number;
}

/** One raw external record exactly as the source returned it. */
export interface RawSourceRecord {
  externalId: string;
  /** The source's own object for this record, unmodified. */
  payload: Record<string, unknown>;
  sourceUpdatedAt: string | null;
  sourceUrl: string | null;
}

/** The transport-level evidence of one retrieval (for the snapshot). */
export interface RetrievalEvidence {
  httpStatus: number | null;
  contentType: string | null;
  /** Raw response body (bounded by the egress cap). */
  rawPayload: string;
  /** Allowlisted provenance headers only. */
  headers: Record<string, string>;
  /** The exact URL retrieved (credentials never appear in URLs). */
  url: string | null;
}

export type ConnectorOutcomeKind =
  | "OK"
  | "MANUAL_VERIFICATION_REQUIRED"
  | "NOT_CONFIGURED"
  | "SOURCE_UNAVAILABLE";

export interface ConnectorResult {
  kind: ConnectorOutcomeKind;
  records: RawSourceRecord[];
  /** Next incremental cursor (fetchChanges), when supported. */
  cursor?: string | null;
  evidence?: RetrievalEvidence | null;
  /** For MANUAL_VERIFICATION_REQUIRED / NOT_CONFIGURED: plain-language
   *  instructions for performing or enabling the lookup. */
  manualInstructions?: string;
  /** Sanitized error label for SOURCE_UNAVAILABLE. */
  errorLabel?: string;
}

export interface NormalizedSourceRecord {
  externalId: string;
  recordType: SourceRecordType;
  normalizedStatus: string | null;
  verbatimStatus: string | null;
  address: string | null;
  permitNumber: string | null;
  applicationDate: string | null;
  issuanceDate: string | null;
  expirationDate: string | null;
  inspectionDate: string | null;
  inspectionResult: string | null;
  enforcementDate: string | null;
  partyName: string | null;
  sourceUrl: string | null;
  sourceConfidence: number | null;
  /** Full field map with verbatim values preserved. */
  fields: Record<string, CandidateField>;
  warnings: string[];
}

export interface ConnectorHealth {
  status: "HEALTHY" | "DEGRADED" | "DOWN" | "MANUAL" | "NOT_CONFIGURED";
  detail: string;   // sanitized, plain language
}

export interface SourceProvenance {
  sourceId: string;
  connectorVersion: string;
  retrievedVia: string;   // e.g. "ArcGIS FeatureServer query", "TOPS Web API", "manual portal lookup"
  officialUrl: string | null;
}

/** The provider-neutral connector interface. */
export interface OfficialSourceConnector {
  /** Static registry definition for this source (no I/O). */
  sourceMetadata(): OfficialSource;
  /** Cheap reachability/configuration probe. */
  healthCheck(): Promise<ConnectorHealth>;
  /** Query the source. */
  search(query: SourceSearchQuery): Promise<ConnectorResult>;
  /** Fetch one record by its external id. */
  fetchRecord(externalId: string): Promise<ConnectorResult>;
  /** Incremental changes since a cursor (null = from a safe default). */
  fetchChanges(cursor: string | null): Promise<ConnectorResult>;
  /** Pure: normalize one raw record (verbatim values preserved). */
  normalize(raw: RawSourceRecord): NormalizedSourceRecord;
  /** Pure: structural validation warnings for one raw record. */
  validate(raw: RawSourceRecord): string[];
  /** Pure: provenance descriptor for one raw record. */
  buildProvenance(raw: RawSourceRecord): SourceProvenance;
}
