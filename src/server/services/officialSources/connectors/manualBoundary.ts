/**
 * Manual verification boundaries — sources whose official access method
 * is a public PORTAL, with no documented API or published dataset
 * suitable for automated retrieval:
 *
 *   - DOB inspection records (Scout portal);
 *   - DOB enforcement / stop-work records (Scout portal);
 *   - DLCP occupational & professional / contractor licenses
 *     (Scout / Access DC portals).
 *
 * DOCTRINE: we do not scrape official portals. Automated access is not
 * clearly permitted for these systems, so every connector method returns
 * MANUAL_VERIFICATION_REQUIRED with plain-language instructions and the
 * official portal URL. The existing manual workflow (a reviewer performs
 * the lookup and records a source verification through the governed DMV
 * command) is preserved and is the ONLY path for these sources. Nothing
 * here fabricates live API behavior.
 */
import type { OfficialSource, SourceRecordType } from "../../../../shared/types";
import type {
  ConnectorHealth,
  ConnectorResult,
  NormalizedSourceRecord,
  OfficialSourceConnector,
  RawSourceRecord,
  SourceProvenance,
  SourceSearchQuery,
} from "./types";

export interface ManualBoundaryConfig {
  sourceId: string;
  name: string;
  agency: string;
  portalUrl: string;
  docsUrl: string;
  recordTypes: SourceRecordType[];
  instructions: string;
  termsNotes: string;
}

const CONNECTOR_VERSION = "1.0.0";

export function makeManualBoundary(cfg: ManualBoundaryConfig): OfficialSourceConnector {
  const definition: OfficialSource = {
    id: cfg.sourceId,
    jurisdiction: "US-DC",
    agency: cfg.agency,
    name: cfg.name,
    category: "OFFICIAL_PORTAL_MANUAL",
    baseUrl: cfg.portalUrl,
    docsUrl: cfg.docsUrl,
    recordTypes: cfg.recordTypes,
    authType: "NONE",
    credentialEnv: null,
    pollingSupported: false,
    rateLimitPerMinute: null,
    retentionNotes: "Manual lookups store only what the reviewer records.",
    termsNotes: cfg.termsNotes,
    expectedUpdateFrequency: "on manual lookup",
    sourceTimezone: "America/New_York",
    operationalStatus: "ENABLED",
    schemaVersion: "manual-v1",
    connectorVersion: CONNECTOR_VERSION,
    allowedHosts: [],   // no automated egress, ever
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    health: "MANUAL",
    maintenanceNotes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const manual = (): ConnectorResult => ({
    kind: "MANUAL_VERIFICATION_REQUIRED",
    records: [],
    manualInstructions: `${cfg.instructions} Official portal: ${cfg.portalUrl}. After the lookup, record what ` +
      "you found as a source verification (verbatim official wording, lookup time, and the record identifier).",
  });

  return {
    sourceMetadata: () => ({ ...definition }),
    healthCheck: async (): Promise<ConnectorHealth> => ({
      status: "MANUAL",
      detail: "Official portal lookup only — no supported automated access method. Reviewers verify manually.",
    }),
    search: async (_query: SourceSearchQuery): Promise<ConnectorResult> => manual(),
    fetchRecord: async (_externalId: string): Promise<ConnectorResult> => manual(),
    fetchChanges: async (_cursor: string | null): Promise<ConnectorResult> => manual(),
    normalize: (raw: RawSourceRecord): NormalizedSourceRecord => {
      // Manual sources produce no automated records; normalize only ever
      // sees a record if a future officially-supported feed appears.
      return {
        externalId: raw.externalId,
        recordType: cfg.recordTypes[0] ?? "OFFICIAL_DOCUMENT",
        normalizedStatus: null,
        verbatimStatus: null,
        address: null,
        permitNumber: null,
        applicationDate: null,
        issuanceDate: null,
        expirationDate: null,
        inspectionDate: null,
        inspectionResult: null,
        enforcementDate: null,
        partyName: null,
        sourceUrl: cfg.portalUrl,
        sourceConfidence: null,
        fields: {},
        warnings: ["manual-boundary source produced a record unexpectedly — verify by hand"],
      };
    },
    validate: () => ["manual-boundary sources have no automated records to validate"],
    buildProvenance: (raw: RawSourceRecord): SourceProvenance => ({
      sourceId: cfg.sourceId,
      connectorVersion: CONNECTOR_VERSION,
      retrievedVia: "manual portal lookup by an authorized reviewer",
      officialUrl: raw.sourceUrl ?? cfg.portalUrl,
    }),
  };
}
