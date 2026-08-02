/**
 * Retrieval pipeline — official-source retrieval -> IMMUTABLE RAW
 * SNAPSHOT -> normalized candidates. Every retrieval writes a snapshot
 * BEFORE normalization, whatever the outcome (success, empty, error,
 * refused, manual). Snapshots are append-only and hashed; candidates
 * are idempotent on content so re-retrieval of unchanged data creates
 * no duplicates. Nothing here writes an authoritative OBV record.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as repo from "../../db/repo";
import * as osRepo from "../../db/officialSourcesRepo";
import { UPLOADS_DIR } from "../../db/index";
import type {
  OfficialSource,
  SourceCandidate,
  SourceSnapshot,
  SnapshotRequestType,
  User,
} from "../../../shared/types";
import type {
  ConnectorResult,
  NormalizedSourceRecord,
  OfficialSourceConnector,
  SourceSearchQuery,
} from "./connectors";
import { connectorFor } from "./connectors";
import {
  OfficialSourceError,
  nowIso,
  redactSecrets,
  sha256Hex,
  normalizeAddress,
} from "./core";

/** Payloads beyond this length are stored under uploads/ with only the
 *  reference (and hash) in the row. */
const INLINE_PAYLOAD_LIMIT = 256 * 1024;

export interface RetrievalScope {
  actorUserId: string | null;
  organizationId: string | null;
  projectId: string | null;
}

export interface RetrievalOutput {
  snapshot: SourceSnapshot;
  candidates: SourceCandidate[];
  kind: ConnectorResult["kind"];
  cursor: string | null;
  manualInstructions: string | null;
  errorLabel: string | null;
}

function storePayload(snapshotId: string, payload: string): { inline: string | null; filePath: string | null } {
  if (payload.length <= INLINE_PAYLOAD_LIMIT) return { inline: payload, filePath: null };
  const dir = path.join(UPLOADS_DIR, "source-snapshots");
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join("source-snapshots", `${snapshotId}.json`);
  fs.writeFileSync(path.join(UPLOADS_DIR, rel), payload);
  return { inline: null, filePath: rel };
}

function outcomeFor(result: ConnectorResult): SourceSnapshot["outcome"] {
  switch (result.kind) {
    case "OK":
      return result.records.length > 0 ? "SUCCESS" : "EMPTY";
    case "MANUAL_VERIFICATION_REQUIRED":
      return "MANUAL_VERIFICATION_REQUIRED";
    case "NOT_CONFIGURED":
      return "REFUSED";
    case "SOURCE_UNAVAILABLE":
      return "ERROR";
  }
}

/** Map one normalized record to a candidate row (verbatim preserved). */
export function mapToCandidate(
  source: OfficialSource,
  normalized: NormalizedSourceRecord,
  snapshotId: string,
  scope: RetrievalScope,
  extraWarnings: string[]
): SourceCandidate {
  const warnings = [...extraWarnings, ...normalized.warnings];
  const contentKey = sha256Hex(
    JSON.stringify({
      s: source.id,
      e: normalized.externalId,
      f: normalized.fields,
      st: normalized.verbatimStatus,
      d: [normalized.issuanceDate, normalized.expirationDate, normalized.inspectionDate, normalized.inspectionResult],
      p: [scope.organizationId, scope.projectId],
    })
  );
  return {
    id: repo.newId(),
    snapshotId,
    sourceId: source.id,
    externalId: normalized.externalId,
    jurisdiction: source.jurisdiction,
    agency: source.agency,
    recordType: normalized.recordType,
    normalizedStatus: normalized.normalizedStatus,
    verbatimStatus: normalized.verbatimStatus,
    address: normalized.address,
    normalizedAddress: normalized.address ? normalizeAddress(normalized.address) : null,
    permitNumber: normalized.permitNumber,
    applicationDate: normalized.applicationDate,
    issuanceDate: normalized.issuanceDate,
    expirationDate: normalized.expirationDate,
    inspectionDate: normalized.inspectionDate,
    inspectionResult: normalized.inspectionResult,
    enforcementDate: normalized.enforcementDate,
    partyName: normalized.partyName,
    sourceUrl: normalized.sourceUrl,
    sourceConfidence: normalized.sourceConfidence,
    normalizationWarnings: warnings,
    fields: normalized.fields,
    schemaVersion: source.schemaVersion,
    connectorVersion: source.connectorVersion,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    createdAt: nowIso(),
    candidateKey: contentKey,
  };
}

/** Execute one connector request and persist the full lifecycle:
 *  snapshot (always) -> candidates (on success). Never throws for
 *  source-side failures — the failure IS the snapshot. */
export async function performRetrieval(
  sourceId: string,
  requestType: SnapshotRequestType,
  request: { query?: SourceSearchQuery; externalId?: string; cursor?: string | null },
  scope: RetrievalScope
): Promise<RetrievalOutput> {
  const source = osRepo.getSource(sourceId);
  const connector = connectorFor(sourceId);
  if (!source || !connector) throw new OfficialSourceError("Not found", 404);
  if (source.operationalStatus !== "ENABLED") {
    throw new OfficialSourceError(
      `Source is ${source.operationalStatus.toLowerCase()} — retrieval is refused until it is re-enabled`,
      409
    );
  }

  let result: ConnectorResult;
  if (requestType === "SEARCH") result = await connector.search(request.query ?? {});
  else if (requestType === "FETCH_RECORD") result = await connector.fetchRecord(String(request.externalId ?? ""));
  else if (requestType === "FETCH_CHANGES") result = await connector.fetchChanges(request.cursor ?? null);
  else throw new OfficialSourceError(`Unsupported request type ${requestType}`);

  const at = nowIso();
  const snapshotId = repo.newId();
  const rawPayload =
    result.evidence?.rawPayload ??
    JSON.stringify({ kind: result.kind, records: result.records.map((r) => r.payload) });
  const { inline, filePath } = storePayload(snapshotId, rawPayload);
  const sanitizedParams = JSON.parse(
    redactSecrets(JSON.stringify({ ...(request.query ?? {}), externalId: request.externalId, cursor: request.cursor }))
  );

  const snapshot: SourceSnapshot = {
    id: snapshotId,
    sourceId: source.id,
    connectorVersion: source.connectorVersion,
    externalId: request.externalId ?? (result.records.length === 1 ? result.records[0].externalId : null),
    requestType,
    lookupParams: sanitizedParams,
    retrievedAt: at,
    sourceUpdatedAt: result.records[0]?.sourceUpdatedAt ?? null,
    httpStatus: result.evidence?.httpStatus ?? null,
    contentType: result.evidence?.contentType ?? null,
    payload: inline,
    payloadPath: filePath,
    payloadSha256: sha256Hex(rawPayload),
    responseHeaders: result.evidence?.headers ?? null,
    cursorInfo: result.cursor !== undefined ? { cursor: result.cursor } : null,
    actorUserId: scope.actorUserId,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    retentionClass: "STANDARD",
    outcome: outcomeFor(result),
  };
  osRepo.insertSnapshot(snapshot);

  // Health bookkeeping (operational metadata only).
  if (result.kind === "OK") {
    osRepo.recordSourceOutcome(source.id, { ok: true, at, health: "HEALTHY" });
  } else if (result.kind === "SOURCE_UNAVAILABLE") {
    osRepo.recordSourceOutcome(source.id, {
      ok: false, at,
      failureReason: redactSecrets(result.errorLabel ?? "source unavailable").slice(0, 200),
      health: "DOWN",
    });
  }

  const candidates: SourceCandidate[] = [];
  if (result.kind === "OK") {
    for (const raw of result.records) {
      const warnings = connector.validate(raw);
      const normalized = connector.normalize(raw);
      const draft = mapToCandidate(source, normalized, snapshotId, scope, warnings);
      const inserted = osRepo.insertCandidate(draft);
      candidates.push(inserted ? draft : osRepo.findCandidateByKey(draft.candidateKey!) ?? draft);
    }
  }

  return {
    snapshot,
    candidates,
    kind: result.kind,
    cursor: result.cursor ?? null,
    manualInstructions: result.manualInstructions ?? null,
    errorLabel: result.errorLabel ?? null,
  };
}

/** Read one snapshot's payload (inline or from its stored file). */
export function snapshotPayload(snapshot: SourceSnapshot): string | null {
  if (snapshot.payload !== null) return snapshot.payload;
  if (!snapshot.payloadPath) return null;
  try {
    return fs.readFileSync(path.join(UPLOADS_DIR, snapshot.payloadPath), "utf8");
  } catch {
    return null;
  }
}

/** Convenience typed wrappers used by services/routes. */
export async function searchSource(
  sourceId: string,
  query: SourceSearchQuery,
  scope: RetrievalScope
): Promise<RetrievalOutput> {
  return performRetrieval(sourceId, "SEARCH", { query }, scope);
}

export async function fetchSourceRecord(
  sourceId: string,
  externalId: string,
  scope: RetrievalScope
): Promise<RetrievalOutput> {
  return performRetrieval(sourceId, "FETCH_RECORD", { externalId }, scope);
}

export async function fetchSourceChanges(
  sourceId: string,
  cursor: string | null,
  scope: RetrievalScope
): Promise<RetrievalOutput> {
  return performRetrieval(sourceId, "FETCH_CHANGES", { cursor }, scope);
}

export type { SourceSearchQuery };
export type { User };
