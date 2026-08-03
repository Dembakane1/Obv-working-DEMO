/**
 * Deterministic mock connector — the offline stand-in used by tests and
 * the demo. Fully in-process: no network, no timers, no randomness. It
 * is registered under an unmistakable name ("Deterministic Mock Source —
 * not a government system") so no surface can present it as live
 * government data.
 *
 * Tests drive change-detection scenarios through the exported fixture
 * controls (set / mutate / remove), which bump a monotonic revision the
 * cursor tracks.
 */
import type { CandidateField, OfficialSource } from "../../../../shared/types";
import { normalizeAddress, normalizeText, nowIso } from "../core";
import type {
  ConnectorHealth,
  ConnectorResult,
  NormalizedSourceRecord,
  OfficialSourceConnector,
  RawSourceRecord,
  SourceProvenance,
  SourceSearchQuery,
} from "./types";

export const MOCK_SOURCE_ID = "obv-mock-dc-source";
const CONNECTOR_VERSION = "1.0.0";
const SCHEMA_VERSION = "mock-v1";

export interface MockFixture {
  externalId: string;
  recordType: "PERMIT" | "INSPECTION" | "LICENSE" | "OCCUPANCY_CERTIFICATE" | "ENFORCEMENT" | "STOP_WORK";
  status: string;
  address: string | null;
  permitNumber: string | null;
  applicationDate: string | null;
  issuanceDate: string | null;
  expirationDate: string | null;
  inspectionDate: string | null;
  inspectionResult: string | null;
  partyName: string | null;
  updatedAt: string;
}

/** Deterministic defaults aligned with the demo DC project. */
const DEFAULT_FIXTURES: MockFixture[] = [
  {
    externalId: "MOCK-B2401001",
    recordType: "PERMIT",
    status: "PERMIT ISSUED",
    address: "1427 Verity Place SE, Washington, DC",
    permitNumber: "B2401001",
    applicationDate: "2026-01-06",
    issuanceDate: "2026-01-21",
    expirationDate: "2027-01-21",
    inspectionDate: null,
    inspectionResult: null,
    partyName: "Meridian Row Ventures LLC",
    updatedAt: "2026-01-21T14:00:00.000Z",
  },
  {
    externalId: "MOCK-E2401002",
    recordType: "PERMIT",
    status: "PERMIT ISSUED",
    address: "1427 Verity Place SE, Washington, DC",
    permitNumber: "E2401002",
    applicationDate: "2026-01-10",
    issuanceDate: "2026-01-24",
    expirationDate: "2027-01-24",
    inspectionDate: null,
    inspectionResult: null,
    partyName: "Meridian Row Ventures LLC",
    updatedAt: "2026-01-24T10:00:00.000Z",
  },
  {
    externalId: "MOCK-INSP-7001",
    recordType: "INSPECTION",
    status: "COMPLETED",
    address: "1427 Verity Place SE, Washington, DC",
    permitNumber: "B2401001",
    applicationDate: null,
    issuanceDate: null,
    expirationDate: null,
    inspectionDate: "2026-03-04",
    inspectionResult: "PASSED",
    partyName: null,
    updatedAt: "2026-03-04T16:30:00.000Z",
  },
  {
    externalId: "MOCK-LIC-410552",
    recordType: "LICENSE",
    status: "ACTIVE",
    address: "1100 4th St SW, Washington, DC",
    permitNumber: "410552",
    applicationDate: null,
    issuanceDate: "2024-07-01",
    expirationDate: "2026-06-30",
    inspectionDate: null,
    inspectionResult: null,
    partyName: "Meridian Row Ventures LLC",
    updatedAt: "2024-07-01T12:00:00.000Z",
  },
];

let fixtures: MockFixture[] = DEFAULT_FIXTURES.map((f) => ({ ...f }));
let revision = 1;
/** revision -> externalIds changed at that revision */
const changeLog = new Map<number, string[]>();

export function resetMockFixtures(): void {
  fixtures = DEFAULT_FIXTURES.map((f) => ({ ...f }));
  revision = 1;
  changeLog.clear();
}

export function setMockFixtures(records: MockFixture[]): void {
  fixtures = records.map((f) => ({ ...f }));
  revision += 1;
  changeLog.set(revision, records.map((r) => r.externalId));
}

export function mutateMockRecord(externalId: string, patch: Partial<MockFixture>): void {
  const target = fixtures.find((f) => f.externalId === externalId);
  if (!target) throw new Error(`mock fixture ${externalId} does not exist`);
  Object.assign(target, patch, { updatedAt: patch.updatedAt ?? nowIso() });
  revision += 1;
  changeLog.set(revision, [externalId]);
}

export function removeMockRecord(externalId: string): void {
  fixtures = fixtures.filter((f) => f.externalId !== externalId);
  revision += 1;
  changeLog.set(revision, [externalId]);
}

export function currentMockRevision(): number {
  return revision;
}

// ------------------------------------------------------------ connector

function toRaw(f: MockFixture): RawSourceRecord {
  return {
    externalId: f.externalId,
    payload: { ...f },
    sourceUpdatedAt: f.updatedAt,
    sourceUrl: `https://demo.invalid/mock/${encodeURIComponent(f.externalId)}`,
  };
}

function evidenceFor(records: MockFixture[]): ConnectorResult["evidence"] {
  return {
    httpStatus: 200,
    contentType: "application/json",
    rawPayload: JSON.stringify({ records }, null, 0),
    headers: { "content-type": "application/json" },
    url: null,
  };
}

const definition: OfficialSource = {
  id: MOCK_SOURCE_ID,
  jurisdiction: "US-DC",
  agency: "OBV DEMO",
  name: "Deterministic Mock Source — not a government system",
  category: "OFFICIAL_API",
  baseUrl: null,
  docsUrl: null,
  recordTypes: ["PERMIT", "INSPECTION", "LICENSE", "OCCUPANCY_CERTIFICATE", "ENFORCEMENT", "STOP_WORK"],
  authType: "NONE",
  credentialEnv: null,
  pollingSupported: true,
  rateLimitPerMinute: null,
  retentionNotes: "Demo data only; no external retention constraints.",
  termsNotes:
    "Deterministic in-process stand-in for tests and demos. Records are fixtures, not government data, " +
    "and are labeled as such on every surface.",
  expectedUpdateFrequency: "on demand",
  sourceTimezone: "America/New_York",
  operationalStatus: "ENABLED",
  schemaVersion: SCHEMA_VERSION,
  connectorVersion: CONNECTOR_VERSION,
  allowedHosts: [],
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  health: "UNKNOWN",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  maintenanceNotes: null,
};

export const mockConnector: OfficialSourceConnector = {
  sourceMetadata: () => ({ ...definition }),

  healthCheck: async (): Promise<ConnectorHealth> => ({
    status: "HEALTHY",
    detail: "Deterministic mock fixtures loaded in-process.",
  }),

  search: async (query: SourceSearchQuery): Promise<ConnectorResult> => {
    const n = (v: unknown) => normalizeText(v);
    const wantNumber = query.permitNumber ?? query.licenseNumber ?? null;
    const matches = fixtures.filter((f) => {
      if (query.recordType && f.recordType !== query.recordType) return false;
      if (wantNumber && n(f.permitNumber) !== n(wantNumber)) return false;
      if (query.address && !normalizeAddress(f.address).includes(normalizeAddress(query.address))) return false;
      if (query.party && !n(f.partyName).includes(n(query.party))) return false;
      return true;
    });
    const limited = matches.slice(0, Math.min(query.limit ?? 50, 200));
    return { kind: "OK", records: limited.map(toRaw), evidence: evidenceFor(limited) };
  },

  fetchRecord: async (externalId: string): Promise<ConnectorResult> => {
    const f = fixtures.find((x) => x.externalId === externalId);
    if (!f) return { kind: "OK", records: [], evidence: evidenceFor([]) };
    return { kind: "OK", records: [toRaw(f)], evidence: evidenceFor([f]) };
  },

  fetchChanges: async (cursor: string | null): Promise<ConnectorResult> => {
    const since = cursor ? Number(cursor) : 0;
    const changedIds = new Set<string>();
    for (const [rev, ids] of changeLog) {
      if (rev > since) ids.forEach((id) => changedIds.add(id));
    }
    // First run (no cursor): everything currently present.
    if (!cursor) fixtures.forEach((f) => changedIds.add(f.externalId));
    const present = fixtures.filter((f) => changedIds.has(f.externalId));
    return {
      kind: "OK",
      records: present.map(toRaw),
      cursor: String(revision),
      evidence: evidenceFor(present),
    };
  },

  normalize: (raw: RawSourceRecord): NormalizedSourceRecord => {
    const f = raw.payload as unknown as MockFixture;
    const fields: Record<string, CandidateField> = {};
    const put = (key: string, value: string | null) => {
      fields[key] = { value: value === null ? null : normalizeText(value), verbatim: value };
    };
    put("status", f.status ?? null);
    put("address", f.address ?? null);
    put("permitNumber", f.permitNumber ?? null);
    put("partyName", f.partyName ?? null);
    put("inspectionResult", f.inspectionResult ?? null);
    return {
      externalId: f.externalId,
      recordType: f.recordType,
      normalizedStatus: normalizeText(f.status) || null,
      verbatimStatus: f.status ?? null,
      address: f.address ?? null,
      permitNumber: f.permitNumber ?? null,
      applicationDate: f.applicationDate,
      issuanceDate: f.issuanceDate,
      expirationDate: f.expirationDate,
      inspectionDate: f.inspectionDate,
      inspectionResult: f.inspectionResult,
      enforcementDate: null,
      partyName: f.partyName,
      sourceUrl: raw.sourceUrl,
      sourceConfidence: 1,
      fields,
      warnings: [],
    };
  },

  validate: (raw: RawSourceRecord): string[] => {
    const f = raw.payload as unknown as MockFixture;
    const warnings: string[] = [];
    if (!f.externalId) warnings.push("record is missing an external id");
    if (!f.status) warnings.push("record is missing a status");
    return warnings;
  },

  buildProvenance: (raw: RawSourceRecord): SourceProvenance => ({
    sourceId: MOCK_SOURCE_ID,
    connectorVersion: CONNECTOR_VERSION,
    retrievedVia: "deterministic in-process mock (demo fixture, not a government system)",
    officialUrl: raw.sourceUrl,
  }),
};
