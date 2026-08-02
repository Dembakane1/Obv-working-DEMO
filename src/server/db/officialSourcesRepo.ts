/**
 * Official Source Connectors repository — all SQL for the connectors
 * layer: the source registry, immutable raw snapshots, normalized
 * candidates, match evaluations, change events, the reviewer queue + its
 * append-only event log, polling state, and the dead-letter queue.
 *
 * INVARIANTS ENFORCED HERE
 *  - source_snapshots and source_review_events are APPEND-ONLY: insert
 *    and SELECT only; no update or delete statement exists for either.
 *  - This module never writes to permits, inspections, permit basis,
 *    source_verifications, official_source_records, exceptions, draws,
 *    ledger, approval, or banking tables — authoritative writes go
 *    through the existing governed domain services, never through here.
 *  - Candidate / match / change insertion is idempotent on their UNIQUE
 *    keys; review-item status transitions are guarded so a resolution
 *    happens exactly once.
 *  - No secret is ever stored: the registry holds credential_env NAMES,
 *    snapshots hold allowlisted headers only. Nothing in this module
 *    reads process.env.
 */
import { getDb } from "./index";
import type {
  OfficialSource,
  SourceCandidate,
  SourceChangeEvent,
  SourceDeadLetter,
  SourceMatch,
  SourcePollState,
  SourceReviewEvent,
  SourceReviewItem,
  SourceReviewStatus,
  SourceSnapshot,
} from "../../shared/types";

type Row = Record<string, unknown>;

const asJson = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const fromJson = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string" || v.length === 0) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

// ============================================================ registry

function toSource(r: Row): OfficialSource {
  return {
    id: r.id as string,
    jurisdiction: r.jurisdiction as string,
    agency: r.agency as string,
    name: r.name as string,
    category: r.category as OfficialSource["category"],
    baseUrl: (r.base_url as string) ?? null,
    docsUrl: (r.docs_url as string) ?? null,
    recordTypes: fromJson(r.record_types, []),
    authType: r.auth_type as OfficialSource["authType"],
    credentialEnv: (r.credential_env as string) ?? null,
    pollingSupported: Boolean(r.polling_supported),
    rateLimitPerMinute: (r.rate_limit_per_minute as number) ?? null,
    retentionNotes: (r.retention_notes as string) ?? null,
    termsNotes: (r.terms_notes as string) ?? null,
    expectedUpdateFrequency: (r.expected_update_frequency as string) ?? null,
    sourceTimezone: r.source_timezone as string,
    operationalStatus: r.operational_status as OfficialSource["operationalStatus"],
    schemaVersion: r.schema_version as string,
    connectorVersion: r.connector_version as string,
    allowedHosts: fromJson(r.allowed_hosts, []),
    lastSuccessAt: (r.last_success_at as string) ?? null,
    lastFailureAt: (r.last_failure_at as string) ?? null,
    lastFailureReason: (r.last_failure_reason as string) ?? null,
    health: r.health as OfficialSource["health"],
    maintenanceNotes: (r.maintenance_notes as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function upsertSource(s: OfficialSource): void {
  getDb()
    .prepare(
      `INSERT INTO official_sources (
         id, jurisdiction, agency, name, category, base_url, docs_url,
         record_types, auth_type, credential_env, polling_supported,
         rate_limit_per_minute, retention_notes, terms_notes,
         expected_update_frequency, source_timezone, operational_status,
         schema_version, connector_version, allowed_hosts,
         last_success_at, last_failure_at, last_failure_reason, health,
         maintenance_notes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         jurisdiction = excluded.jurisdiction,
         agency = excluded.agency,
         name = excluded.name,
         category = excluded.category,
         base_url = excluded.base_url,
         docs_url = excluded.docs_url,
         record_types = excluded.record_types,
         auth_type = excluded.auth_type,
         credential_env = excluded.credential_env,
         polling_supported = excluded.polling_supported,
         rate_limit_per_minute = excluded.rate_limit_per_minute,
         retention_notes = excluded.retention_notes,
         terms_notes = excluded.terms_notes,
         expected_update_frequency = excluded.expected_update_frequency,
         source_timezone = excluded.source_timezone,
         schema_version = excluded.schema_version,
         connector_version = excluded.connector_version,
         allowed_hosts = excluded.allowed_hosts,
         updated_at = excluded.updated_at`
    )
    .run(
      s.id, s.jurisdiction, s.agency, s.name, s.category, s.baseUrl, s.docsUrl,
      asJson(s.recordTypes), s.authType, s.credentialEnv, s.pollingSupported ? 1 : 0,
      s.rateLimitPerMinute, s.retentionNotes, s.termsNotes,
      s.expectedUpdateFrequency, s.sourceTimezone, s.operationalStatus,
      s.schemaVersion, s.connectorVersion, asJson(s.allowedHosts),
      s.lastSuccessAt, s.lastFailureAt, s.lastFailureReason, s.health,
      s.maintenanceNotes, s.createdAt, s.updatedAt
    );
}

export function getSource(id: string): OfficialSource | null {
  const r = getDb().prepare("SELECT * FROM official_sources WHERE id = ?").get(id);
  return r ? toSource(r as Row) : null;
}

export function listSources(): OfficialSource[] {
  return getDb()
    .prepare("SELECT * FROM official_sources ORDER BY jurisdiction, agency, name, rowid")
    .all()
    .map((r) => toSource(r as Row));
}

/** Health/outcome bookkeeping — operational metadata, not source truth. */
export function recordSourceOutcome(
  id: string,
  outcome: { ok: boolean; at: string; failureReason?: string | null; health: OfficialSource["health"] }
): void {
  if (outcome.ok) {
    getDb()
      .prepare("UPDATE official_sources SET last_success_at = ?, health = ?, updated_at = ? WHERE id = ?")
      .run(outcome.at, outcome.health, outcome.at, id);
  } else {
    getDb()
      .prepare(
        "UPDATE official_sources SET last_failure_at = ?, last_failure_reason = ?, health = ?, updated_at = ? WHERE id = ?"
      )
      .run(outcome.at, outcome.failureReason ?? null, outcome.health, outcome.at, id);
  }
}

export function setSourceOperationalStatus(id: string, status: OfficialSource["operationalStatus"], at: string): void {
  getDb()
    .prepare("UPDATE official_sources SET operational_status = ?, updated_at = ? WHERE id = ?")
    .run(status, at, id);
}

// ============================================================ snapshots

function toSnapshot(r: Row): SourceSnapshot {
  return {
    id: r.id as string,
    sourceId: r.source_id as string,
    connectorVersion: r.connector_version as string,
    externalId: (r.external_id as string) ?? null,
    requestType: r.request_type as SourceSnapshot["requestType"],
    lookupParams: fromJson(r.lookup_params, null),
    retrievedAt: r.retrieved_at as string,
    sourceUpdatedAt: (r.source_updated_at as string) ?? null,
    httpStatus: (r.http_status as number) ?? null,
    contentType: (r.content_type as string) ?? null,
    payload: (r.payload as string) ?? null,
    payloadPath: (r.payload_path as string) ?? null,
    payloadSha256: r.payload_sha256 as string,
    responseHeaders: fromJson(r.response_headers, null),
    cursorInfo: fromJson(r.cursor_info, null),
    actorUserId: (r.actor_user_id as string) ?? null,
    organizationId: (r.organization_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    retentionClass: r.retention_class as SourceSnapshot["retentionClass"],
    outcome: r.outcome as SourceSnapshot["outcome"],
  };
}

/** APPEND-ONLY: snapshots are immutable once written. */
export function insertSnapshot(s: SourceSnapshot): void {
  getDb()
    .prepare(
      `INSERT INTO source_snapshots (
         id, source_id, connector_version, external_id, request_type,
         lookup_params, retrieved_at, source_updated_at, http_status,
         content_type, payload, payload_path, payload_sha256,
         response_headers, cursor_info, actor_user_id, organization_id,
         project_id, retention_class, outcome
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      s.id, s.sourceId, s.connectorVersion, s.externalId, s.requestType,
      asJson(s.lookupParams), s.retrievedAt, s.sourceUpdatedAt, s.httpStatus,
      s.contentType, s.payload, s.payloadPath, s.payloadSha256,
      asJson(s.responseHeaders), asJson(s.cursorInfo), s.actorUserId, s.organizationId,
      s.projectId, s.retentionClass, s.outcome
    );
}

export function getSnapshot(id: string): SourceSnapshot | null {
  const r = getDb().prepare("SELECT * FROM source_snapshots WHERE id = ?").get(id);
  return r ? toSnapshot(r as Row) : null;
}

export function listSnapshotsForSource(sourceId: string, limit = 100): SourceSnapshot[] {
  return getDb()
    .prepare("SELECT * FROM source_snapshots WHERE source_id = ? ORDER BY retrieved_at DESC, rowid DESC LIMIT ?")
    .all(sourceId, Math.min(500, limit))
    .map((r) => toSnapshot(r as Row));
}

/** The two most recent snapshots of one external record (for diffing). */
export function latestSnapshotsForRecord(sourceId: string, externalId: string, limit = 2): SourceSnapshot[] {
  return getDb()
    .prepare(
      `SELECT * FROM source_snapshots
       WHERE source_id = ? AND external_id = ? AND outcome IN ('SUCCESS','EMPTY')
       ORDER BY retrieved_at DESC, rowid DESC LIMIT ?`
    )
    .all(sourceId, externalId, Math.min(10, limit))
    .map((r) => toSnapshot(r as Row));
}

export function snapshotCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS c FROM source_snapshots").get() as Row).c as number;
}

// ============================================================ candidates

function toCandidate(r: Row): SourceCandidate {
  return {
    id: r.id as string,
    snapshotId: r.snapshot_id as string,
    sourceId: r.source_id as string,
    externalId: r.external_id as string,
    jurisdiction: r.jurisdiction as string,
    agency: r.agency as string,
    recordType: r.record_type as SourceCandidate["recordType"],
    normalizedStatus: (r.normalized_status as string) ?? null,
    verbatimStatus: (r.verbatim_status as string) ?? null,
    address: (r.address as string) ?? null,
    normalizedAddress: (r.normalized_address as string) ?? null,
    permitNumber: (r.permit_number as string) ?? null,
    applicationDate: (r.application_date as string) ?? null,
    issuanceDate: (r.issuance_date as string) ?? null,
    expirationDate: (r.expiration_date as string) ?? null,
    inspectionDate: (r.inspection_date as string) ?? null,
    inspectionResult: (r.inspection_result as string) ?? null,
    enforcementDate: (r.enforcement_date as string) ?? null,
    partyName: (r.party_name as string) ?? null,
    sourceUrl: (r.source_url as string) ?? null,
    sourceConfidence: (r.source_confidence as number) ?? null,
    normalizationWarnings: fromJson(r.normalization_warnings, []),
    fields: fromJson(r.fields, {}),
    schemaVersion: r.schema_version as string,
    connectorVersion: r.connector_version as string,
    organizationId: (r.organization_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    createdAt: r.created_at as string,
    candidateKey: (r.candidate_key as string) ?? null,
  };
}

/** Idempotent on candidate_key — returns false when this exact candidate
 *  content was already recorded. */
export function insertCandidate(c: SourceCandidate): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO source_candidates (
           id, snapshot_id, source_id, external_id, jurisdiction, agency,
           record_type, normalized_status, verbatim_status, address,
           normalized_address, permit_number, application_date,
           issuance_date, expiration_date, inspection_date,
           inspection_result, enforcement_date, party_name, source_url,
           source_confidence, normalization_warnings, fields,
           schema_version, connector_version, organization_id, project_id,
           created_at, candidate_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        c.id, c.snapshotId, c.sourceId, c.externalId, c.jurisdiction, c.agency,
        c.recordType, c.normalizedStatus, c.verbatimStatus, c.address,
        c.normalizedAddress, c.permitNumber, c.applicationDate,
        c.issuanceDate, c.expirationDate, c.inspectionDate,
        c.inspectionResult, c.enforcementDate, c.partyName, c.sourceUrl,
        c.sourceConfidence, asJson(c.normalizationWarnings), asJson(c.fields),
        c.schemaVersion, c.connectorVersion, c.organizationId, c.projectId,
        c.createdAt, c.candidateKey
      );
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return false;
    throw err;
  }
}

export function getCandidate(id: string): SourceCandidate | null {
  const r = getDb().prepare("SELECT * FROM source_candidates WHERE id = ?").get(id);
  return r ? toCandidate(r as Row) : null;
}

export function findCandidateByKey(candidateKey: string): SourceCandidate | null {
  const r = getDb().prepare("SELECT * FROM source_candidates WHERE candidate_key = ?").get(candidateKey);
  return r ? toCandidate(r as Row) : null;
}

/** Latest candidate per retrieval order for one external record. */
export function latestCandidatesForRecord(sourceId: string, externalId: string, limit = 2): SourceCandidate[] {
  return getDb()
    .prepare(
      `SELECT * FROM source_candidates WHERE source_id = ? AND external_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(sourceId, externalId, Math.min(10, limit))
    .map((r) => toCandidate(r as Row));
}

export function listCandidatesForSnapshot(snapshotId: string): SourceCandidate[] {
  return getDb()
    .prepare("SELECT * FROM source_candidates WHERE snapshot_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(snapshotId)
    .map((r) => toCandidate(r as Row));
}

export function listCandidatesForProjects(projectIds: string[], limit = 200): SourceCandidate[] {
  if (projectIds.length === 0) return [];
  const marks = projectIds.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT * FROM source_candidates WHERE project_id IN (${marks})
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(...projectIds, Math.min(1000, limit))
    .map((r) => toCandidate(r as Row));
}

// ============================================================ matches

function toMatch(r: Row): SourceMatch {
  return {
    id: r.id as string,
    candidateId: r.candidate_id as string,
    organizationId: (r.organization_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    obvEntityType: r.obv_entity_type as SourceMatch["obvEntityType"],
    obvEntityId: (r.obv_entity_id as string) ?? null,
    verdict: r.verdict as SourceMatch["verdict"],
    confidence: r.confidence as number,
    reasonCodes: fromJson(r.reason_codes, []),
    fieldsCompared: fromJson(r.fields_compared, {}),
    differences: fromJson(r.differences, null),
    recommendation: r.recommendation as string,
    evaluatedAt: r.evaluated_at as string,
    matchKey: (r.match_key as string) ?? null,
  };
}

/** Idempotent on match_key. */
export function insertMatch(m: SourceMatch): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO source_matches (
           id, candidate_id, organization_id, project_id, obv_entity_type,
           obv_entity_id, verdict, confidence, reason_codes,
           fields_compared, differences, recommendation, evaluated_at, match_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        m.id, m.candidateId, m.organizationId, m.projectId, m.obvEntityType,
        m.obvEntityId, m.verdict, m.confidence, asJson(m.reasonCodes),
        asJson(m.fieldsCompared), asJson(m.differences), m.recommendation, m.evaluatedAt, m.matchKey
      );
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return false;
    throw err;
  }
}

export function getMatch(id: string): SourceMatch | null {
  const r = getDb().prepare("SELECT * FROM source_matches WHERE id = ?").get(id);
  return r ? toMatch(r as Row) : null;
}

export function listMatchesForCandidate(candidateId: string): SourceMatch[] {
  return getDb()
    .prepare("SELECT * FROM source_matches WHERE candidate_id = ? ORDER BY evaluated_at DESC, rowid DESC")
    .all(candidateId)
    .map((r) => toMatch(r as Row));
}

export function listMatchesForEntity(entityType: string, entityId: string): SourceMatch[] {
  return getDb()
    .prepare(
      "SELECT * FROM source_matches WHERE obv_entity_type = ? AND obv_entity_id = ? ORDER BY evaluated_at DESC, rowid DESC"
    )
    .all(entityType, entityId)
    .map((r) => toMatch(r as Row));
}

// ============================================================ change events

function toChange(r: Row): SourceChangeEvent {
  return {
    id: r.id as string,
    sourceId: r.source_id as string,
    externalId: r.external_id as string,
    previousSnapshotId: (r.previous_snapshot_id as string) ?? null,
    currentSnapshotId: r.current_snapshot_id as string,
    previousCandidateId: (r.previous_candidate_id as string) ?? null,
    currentCandidateId: (r.current_candidate_id as string) ?? null,
    changeKind: r.change_kind as SourceChangeEvent["changeKind"],
    changedFields: fromJson(r.changed_fields, []),
    sourceUpdatedAt: (r.source_updated_at as string) ?? null,
    retrievedAt: r.retrieved_at as string,
    connectorVersion: r.connector_version as string,
    severity: r.severity as SourceChangeEvent["severity"],
    explanation: r.explanation as string,
    organizationId: (r.organization_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    createdAt: r.created_at as string,
    changeKey: (r.change_key as string) ?? null,
  };
}

/** Idempotent on change_key. */
export function insertChangeEvent(c: SourceChangeEvent): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO source_change_events (
           id, source_id, external_id, previous_snapshot_id,
           current_snapshot_id, previous_candidate_id, current_candidate_id,
           change_kind, changed_fields, source_updated_at, retrieved_at,
           connector_version, severity, explanation, organization_id,
           project_id, created_at, change_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        c.id, c.sourceId, c.externalId, c.previousSnapshotId,
        c.currentSnapshotId, c.previousCandidateId, c.currentCandidateId,
        c.changeKind, asJson(c.changedFields), c.sourceUpdatedAt, c.retrievedAt,
        c.connectorVersion, c.severity, c.explanation, c.organizationId,
        c.projectId, c.createdAt, c.changeKey
      );
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return false;
    throw err;
  }
}

export function getChangeEvent(id: string): SourceChangeEvent | null {
  const r = getDb().prepare("SELECT * FROM source_change_events WHERE id = ?").get(id);
  return r ? toChange(r as Row) : null;
}

export function listChangesForRecord(sourceId: string, externalId: string, limit = 50): SourceChangeEvent[] {
  return getDb()
    .prepare(
      `SELECT * FROM source_change_events WHERE source_id = ? AND external_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(sourceId, externalId, Math.min(200, limit))
    .map((r) => toChange(r as Row));
}

export function listChangesForProjects(projectIds: string[], limit = 200): SourceChangeEvent[] {
  if (projectIds.length === 0) return [];
  const marks = projectIds.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT * FROM source_change_events WHERE project_id IN (${marks})
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(...projectIds, Math.min(1000, limit))
    .map((r) => toChange(r as Row));
}

// ============================================================ review queue

function toReviewItem(r: Row): SourceReviewItem {
  return {
    id: r.id as string,
    organizationId: (r.organization_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    eventKind: r.event_kind as SourceReviewItem["eventKind"],
    candidateId: (r.candidate_id as string) ?? null,
    matchId: (r.match_id as string) ?? null,
    changeEventId: (r.change_event_id as string) ?? null,
    affectedEntityType: (r.affected_entity_type as string) ?? null,
    affectedEntityId: (r.affected_entity_id as string) ?? null,
    severity: r.severity as SourceReviewItem["severity"],
    title: r.title as string,
    explanation: r.explanation as string,
    suggestedAction: r.suggested_action as string,
    blockingImplications: (r.blocking_implications as string) ?? null,
    status: r.status as SourceReviewItem["status"],
    resolvedByUserId: (r.resolved_by_user_id as string) ?? null,
    resolvedAt: (r.resolved_at as string) ?? null,
    resolutionNote: (r.resolution_note as string) ?? null,
    linkedOfficialSourceRecordId: (r.linked_official_source_record_id as string) ?? null,
    linkedSourceVerificationId: (r.linked_source_verification_id as string) ?? null,
    promotedExceptionId: (r.promoted_exception_id as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    itemKey: (r.item_key as string) ?? null,
  };
}

/** Idempotent on item_key. */
export function insertReviewItem(i: SourceReviewItem): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO source_review_items (
           id, organization_id, project_id, event_kind, candidate_id,
           match_id, change_event_id, affected_entity_type,
           affected_entity_id, severity, title, explanation,
           suggested_action, blocking_implications, status,
           resolved_by_user_id, resolved_at, resolution_note,
           linked_official_source_record_id, linked_source_verification_id,
           promoted_exception_id, created_at, updated_at, item_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        i.id, i.organizationId, i.projectId, i.eventKind, i.candidateId,
        i.matchId, i.changeEventId, i.affectedEntityType,
        i.affectedEntityId, i.severity, i.title, i.explanation,
        i.suggestedAction, i.blockingImplications, i.status,
        i.resolvedByUserId, i.resolvedAt, i.resolutionNote,
        i.linkedOfficialSourceRecordId, i.linkedSourceVerificationId,
        i.promotedExceptionId, i.createdAt, i.updatedAt, i.itemKey
      );
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint/.test(err.message)) return false;
    throw err;
  }
}

export function getReviewItem(id: string): SourceReviewItem | null {
  const r = getDb().prepare("SELECT * FROM source_review_items WHERE id = ?").get(id);
  return r ? toReviewItem(r as Row) : null;
}

export function listReviewForProjects(
  projectIds: string[],
  filter: { status?: string; limit?: number } = {}
): SourceReviewItem[] {
  if (projectIds.length === 0) return [];
  const marks = projectIds.map(() => "?").join(",");
  const limit = Math.min(1000, filter.limit ?? 200);
  if (filter.status) {
    return getDb()
      .prepare(
        `SELECT * FROM source_review_items WHERE project_id IN (${marks}) AND status = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`
      )
      .all(...projectIds, filter.status, limit)
      .map((r) => toReviewItem(r as Row));
  }
  return getDb()
    .prepare(
      `SELECT * FROM source_review_items WHERE project_id IN (${marks})
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(...projectIds, limit)
    .map((r) => toReviewItem(r as Row));
}

export function reviewStatsForProjects(projectIds: string[]): Record<string, number> {
  const stats: Record<string, number> = {
    open: 0, confirmed: 0, rejected: 0, deferred: 0,
    manualVerification: 0, discrepancyRecorded: 0, promoted: 0,
  };
  if (projectIds.length === 0) return stats;
  const marks = projectIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT status, COUNT(*) AS c FROM source_review_items WHERE project_id IN (${marks}) GROUP BY status`)
    .all(...projectIds) as Row[];
  const keyFor: Record<string, string> = {
    OPEN: "open", CONFIRMED: "confirmed", REJECTED: "rejected", DEFERRED: "deferred",
    MANUAL_VERIFICATION: "manualVerification", DISCREPANCY_RECORDED: "discrepancyRecorded", PROMOTED: "promoted",
  };
  for (const r of rows) {
    const key = keyFor[r.status as string];
    if (key) stats[key] = r.c as number;
  }
  return stats;
}

/** Guarded transition: only OPEN or DEFERRED items may be resolved, and
 *  exactly once. Returns false when the transition did not apply. */
export function updateReviewStatus(
  id: string,
  next: SourceReviewStatus,
  patch: {
    resolvedByUserId: string;
    resolvedAt: string;
    resolutionNote?: string | null;
    linkedOfficialSourceRecordId?: string | null;
    linkedSourceVerificationId?: string | null;
    promotedExceptionId?: string | null;
  }
): boolean {
  const res = getDb()
    .prepare(
      `UPDATE source_review_items SET
         status = ?, resolved_by_user_id = ?, resolved_at = ?,
         resolution_note = COALESCE(?, resolution_note),
         linked_official_source_record_id = COALESCE(?, linked_official_source_record_id),
         linked_source_verification_id = COALESCE(?, linked_source_verification_id),
         promoted_exception_id = COALESCE(?, promoted_exception_id),
         updated_at = ?
       WHERE id = ? AND status IN ('OPEN','DEFERRED')`
    )
    .run(
      next, patch.resolvedByUserId, patch.resolvedAt,
      patch.resolutionNote ?? null,
      patch.linkedOfficialSourceRecordId ?? null,
      patch.linkedSourceVerificationId ?? null,
      patch.promotedExceptionId ?? null,
      patch.resolvedAt, id
    );
  return res.changes > 0;
}

/** APPEND-ONLY reviewer trail. */
export function insertReviewEvent(e: SourceReviewEvent): void {
  getDb()
    .prepare(
      `INSERT INTO source_review_events (id, item_id, occurred_at, actor_user_id, kind, detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.itemId, e.occurredAt, e.actorUserId, e.kind, e.detail);
}

export function listReviewEvents(itemId: string): SourceReviewEvent[] {
  return getDb()
    .prepare("SELECT * FROM source_review_events WHERE item_id = ? ORDER BY occurred_at ASC, rowid ASC")
    .all(itemId)
    .map((r) => ({
      id: r.id as string,
      itemId: r.item_id as string,
      occurredAt: r.occurred_at as string,
      actorUserId: (r.actor_user_id as string) ?? null,
      kind: r.kind as SourceReviewEvent["kind"],
      detail: (r.detail as string) ?? null,
    }));
}

// ============================================================ poll state

function toPollState(r: Row): SourcePollState {
  return {
    sourceId: r.source_id as string,
    cursor: (r.cursor as string) ?? null,
    lastPollAt: (r.last_poll_at as string) ?? null,
    lastPollOutcome: (r.last_poll_outcome as string) ?? null,
    consecutiveFailures: r.consecutive_failures as number,
    circuitOpenUntil: (r.circuit_open_until as string) ?? null,
    paused: Boolean(r.paused),
    updatedAt: r.updated_at as string,
  };
}

export function getPollState(sourceId: string): SourcePollState | null {
  const r = getDb().prepare("SELECT * FROM source_poll_state WHERE source_id = ?").get(sourceId);
  return r ? toPollState(r as Row) : null;
}

export function upsertPollState(s: SourcePollState): void {
  getDb()
    .prepare(
      `INSERT INTO source_poll_state (
         source_id, cursor, last_poll_at, last_poll_outcome,
         consecutive_failures, circuit_open_until, paused, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         cursor = excluded.cursor,
         last_poll_at = excluded.last_poll_at,
         last_poll_outcome = excluded.last_poll_outcome,
         consecutive_failures = excluded.consecutive_failures,
         circuit_open_until = excluded.circuit_open_until,
         paused = excluded.paused,
         updated_at = excluded.updated_at`
    )
    .run(
      s.sourceId, s.cursor, s.lastPollAt, s.lastPollOutcome,
      s.consecutiveFailures, s.circuitOpenUntil, s.paused ? 1 : 0, s.updatedAt
    );
}

// ============================================================ dead letters

function toDeadLetter(r: Row): SourceDeadLetter {
  return {
    id: r.id as string,
    sourceId: r.source_id as string,
    requestType: r.request_type as string,
    lookupParams: fromJson(r.lookup_params, null),
    firstFailedAt: r.first_failed_at as string,
    lastFailedAt: r.last_failed_at as string,
    attempts: r.attempts as number,
    errorLabel: r.error_label as string,
    status: r.status as SourceDeadLetter["status"],
    resolvedByUserId: (r.resolved_by_user_id as string) ?? null,
    resolvedAt: (r.resolved_at as string) ?? null,
  };
}

export function insertDeadLetter(d: SourceDeadLetter): void {
  getDb()
    .prepare(
      `INSERT INTO source_dead_letters (
         id, source_id, request_type, lookup_params, first_failed_at,
         last_failed_at, attempts, error_label, status,
         resolved_by_user_id, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.id, d.sourceId, d.requestType, asJson(d.lookupParams), d.firstFailedAt,
      d.lastFailedAt, d.attempts, d.errorLabel, d.status,
      d.resolvedByUserId, d.resolvedAt
    );
}

export function listDeadLetters(status?: string, limit = 100): SourceDeadLetter[] {
  if (status) {
    return getDb()
      .prepare("SELECT * FROM source_dead_letters WHERE status = ? ORDER BY last_failed_at DESC, rowid DESC LIMIT ?")
      .all(status, Math.min(500, limit))
      .map((r) => toDeadLetter(r as Row));
  }
  return getDb()
    .prepare("SELECT * FROM source_dead_letters ORDER BY last_failed_at DESC, rowid DESC LIMIT ?")
    .all(Math.min(500, limit))
    .map((r) => toDeadLetter(r as Row));
}

export function getDeadLetter(id: string): SourceDeadLetter | null {
  const r = getDb().prepare("SELECT * FROM source_dead_letters WHERE id = ?").get(id);
  return r ? toDeadLetter(r as Row) : null;
}

/** Guarded: only an OPEN dead letter can be requeued or discarded. */
export function resolveDeadLetter(
  id: string,
  next: "REQUEUED" | "DISCARDED",
  userId: string,
  at: string
): boolean {
  const res = getDb()
    .prepare(
      `UPDATE source_dead_letters SET status = ?, resolved_by_user_id = ?, resolved_at = ?
       WHERE id = ? AND status = 'OPEN'`
    )
    .run(next, userId, at, id);
  return res.changes > 0;
}
