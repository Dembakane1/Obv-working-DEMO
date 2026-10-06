/**
 * Infrastructure Interoperability repository — all SQL for the additive
 * interoperability tables: OC4IDS export provenance, external field-data
 * import snapshots, normalized observation candidates, their photos and
 * append-only event log, and evidence provenance links.
 *
 * INVARIANTS ENFORCED HERE
 *  - interop_exports, field_observation_imports, field_observation_events
 *    and evidence_provenance are APPEND-ONLY: insert and SELECT only; no
 *    update or delete statement exists for any of them.
 *  - field_observations is updated ONLY by the two guarded transitions
 *    below (project match; a single reviewer resolution out of
 *    UNVERIFIED/DEFERRED). A resolution therefore happens exactly once.
 *  - This module never writes to evidence_items, verifications,
 *    milestones, approvals, draws, ledger, exceptions, inspections or any
 *    banking table. Evidence is created ONLY through the governed
 *    submission pipeline in the service layer, which then records the
 *    provenance link here.
 *  - Observation insertion is idempotent on dedupe_key.
 *  - Nothing in this module reads process.env or stores a secret.
 */
import { getDb } from "./index";
import type {
  EvidenceProvenance,
  FieldObservation,
  FieldObservationEvent,
  FieldObservationImport,
  FieldObservationPhoto,
  FieldObservationStatus,
  InteropExportRecord,
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
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

// ============================================================ exports

function toExport(r: Row): InteropExportRecord {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    projectId: r.project_id as string,
    standard: r.standard as InteropExportRecord["standard"],
    schemaVersion: r.schema_version as string,
    mappingVersion: r.mapping_version as string,
    exportedAt: r.exported_at as string,
    exportedByUserId: r.exported_by_user_id as string,
    projectConfigVersion: Number(r.project_config_version ?? 1),
    projectSha256: r.project_sha256 as string,
    payloadSha256: r.payload_sha256 as string,
    payloadBytes: Number(r.payload_bytes ?? 0),
    payloadPath: r.payload_path as string,
    sourceRecords: fromJson(r.source_records, []),
    populatedFields: Number(r.populated_fields ?? 0),
    omittedFields: Number(r.omitted_fields ?? 0),
    validationErrors: Number(r.validation_errors ?? 0),
    validationWarnings: Number(r.validation_warnings ?? 0),
    status: r.status as InteropExportRecord["status"],
  };
}

export function insertExport(e: InteropExportRecord): void {
  getDb()
    .prepare(
      `INSERT INTO interop_exports (
         id, organization_id, project_id, standard, schema_version, mapping_version,
         exported_at, exported_by_user_id, project_config_version, project_sha256,
         payload_sha256, payload_bytes, payload_path, source_records,
         populated_fields, omitted_fields, validation_errors, validation_warnings, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.organizationId, e.projectId, e.standard, e.schemaVersion, e.mappingVersion,
      e.exportedAt, e.exportedByUserId, e.projectConfigVersion, e.projectSha256,
      e.payloadSha256, e.payloadBytes, e.payloadPath, asJson(e.sourceRecords),
      e.populatedFields, e.omittedFields, e.validationErrors, e.validationWarnings, e.status
    );
}

export function getExport(id: string): InteropExportRecord | null {
  const r = getDb().prepare("SELECT * FROM interop_exports WHERE id = ?").get(id);
  return r ? toExport(r as Row) : null;
}

export function listExportsForProject(projectId: string, limit = 50): InteropExportRecord[] {
  return getDb()
    .prepare("SELECT * FROM interop_exports WHERE project_id = ? ORDER BY exported_at DESC, rowid DESC LIMIT ?")
    .all(projectId, Math.min(500, Math.max(1, limit)))
    .map((r) => toExport(r as Row));
}

export function latestExportForProject(projectId: string): InteropExportRecord | null {
  const r = getDb()
    .prepare("SELECT * FROM interop_exports WHERE project_id = ? ORDER BY exported_at DESC, rowid DESC LIMIT 1")
    .get(projectId);
  return r ? toExport(r as Row) : null;
}

// ============================================================ imports

function toImport(r: Row): FieldObservationImport {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    declaredProjectId: strOrNull(r.declared_project_id),
    sourceSystem: r.source_system as FieldObservationImport["sourceSystem"],
    providerLabel: strOrNull(r.provider_label),
    adapterId: r.adapter_id as string,
    formatVersion: r.format_version as string,
    importedAt: r.imported_at as string,
    importedByUserId: r.imported_by_user_id as string,
    payloadPath: r.payload_path as string,
    payloadSha256: r.payload_sha256 as string,
    payloadBytes: Number(r.payload_bytes ?? 0),
    observationCount: Number(r.observation_count ?? 0),
    duplicateCount: Number(r.duplicate_count ?? 0),
    sourceMetadata: fromJson<Record<string, unknown> | null>(r.source_metadata, null),
    notes: strOrNull(r.notes),
  };
}

export function insertImport(i: FieldObservationImport): void {
  getDb()
    .prepare(
      `INSERT INTO field_observation_imports (
         id, organization_id, declared_project_id, source_system, provider_label,
         adapter_id, format_version, imported_at, imported_by_user_id, payload_path,
         payload_sha256, payload_bytes, observation_count, duplicate_count,
         source_metadata, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      i.id, i.organizationId, i.declaredProjectId, i.sourceSystem, i.providerLabel,
      i.adapterId, i.formatVersion, i.importedAt, i.importedByUserId, i.payloadPath,
      i.payloadSha256, i.payloadBytes, i.observationCount, i.duplicateCount,
      asJson(i.sourceMetadata), i.notes
    );
}

export function getImport(id: string): FieldObservationImport | null {
  const r = getDb().prepare("SELECT * FROM field_observation_imports WHERE id = ?").get(id);
  return r ? toImport(r as Row) : null;
}

export function listImportsForOrganization(organizationId: string, limit = 50): FieldObservationImport[] {
  return getDb()
    .prepare("SELECT * FROM field_observation_imports WHERE organization_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT ?")
    .all(organizationId, Math.min(500, Math.max(1, limit)))
    .map((r) => toImport(r as Row));
}

// ============================================================ observations

function toObservation(r: Row): FieldObservation {
  return {
    id: r.id as string,
    importId: r.import_id as string,
    organizationId: r.organization_id as string,
    sourceSystem: r.source_system as FieldObservation["sourceSystem"],
    providerLabel: strOrNull(r.provider_label),
    externalObservationId: r.external_observation_id as string,
    projectReference: strOrNull(r.project_reference),
    matchedProjectId: strOrNull(r.matched_project_id),
    matchVerdict: r.match_verdict as FieldObservation["matchVerdict"],
    matchReasons: fromJson<string[]>(r.match_reasons, []),
    milestoneReference: strOrNull(r.milestone_reference),
    suggestedMilestoneId: strOrNull(r.suggested_milestone_id),
    collector: strOrNull(r.collector),
    observedAt: strOrNull(r.observed_at),
    observedAtVerbatim: strOrNull(r.observed_at_verbatim),
    latitude: numOrNull(r.latitude),
    longitude: numOrNull(r.longitude),
    accuracyMeters: numOrNull(r.accuracy_m),
    formFields: fromJson<Record<string, unknown>>(r.form_fields, {}),
    comments: strOrNull(r.comments),
    photoCount: Number(r.photo_count ?? 0),
    sourceMetadata: fromJson<Record<string, unknown> | null>(r.source_metadata, null),
    sourceRecordSha256: r.source_record_sha256 as string,
    ingestedAt: r.ingested_at as string,
    status: r.status as FieldObservationStatus,
    milestoneId: strOrNull(r.milestone_id),
    acceptedEvidenceId: strOrNull(r.accepted_evidence_id),
    reviewedByUserId: strOrNull(r.reviewed_by_user_id),
    reviewedAt: strOrNull(r.reviewed_at),
    reviewNote: strOrNull(r.review_note),
    dedupeKey: r.dedupe_key as string,
  };
}

/** Idempotent on dedupe_key: returns false when the identical observation
 *  (same tenant, source, external id and verbatim content) exists. */
export function insertObservation(o: FieldObservation): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO field_observations (
           id, import_id, organization_id, source_system, provider_label,
           external_observation_id, project_reference, matched_project_id,
           match_verdict, match_reasons, milestone_reference, suggested_milestone_id,
           collector, observed_at, observed_at_verbatim,
           latitude, longitude, accuracy_m, form_fields, comments, photo_count,
           source_metadata, source_record_sha256, ingested_at, status, milestone_id,
           accepted_evidence_id, reviewed_by_user_id, reviewed_at, review_note, dedupe_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        o.id, o.importId, o.organizationId, o.sourceSystem, o.providerLabel,
        o.externalObservationId, o.projectReference, o.matchedProjectId,
        o.matchVerdict, asJson(o.matchReasons), o.milestoneReference, o.suggestedMilestoneId,
        o.collector, o.observedAt, o.observedAtVerbatim,
        o.latitude, o.longitude, o.accuracyMeters, asJson(o.formFields), o.comments, o.photoCount,
        asJson(o.sourceMetadata), o.sourceRecordSha256, o.ingestedAt, o.status, o.milestoneId,
        o.acceptedEvidenceId, o.reviewedByUserId, o.reviewedAt, o.reviewNote, o.dedupeKey
      );
    return true;
  } catch (err) {
    if (/UNIQUE constraint failed/.test(String((err as Error).message ?? err))) return false;
    throw err;
  }
}

export function getObservation(id: string): FieldObservation | null {
  const r = getDb().prepare("SELECT * FROM field_observations WHERE id = ?").get(id);
  return r ? toObservation(r as Row) : null;
}

export function findObservationByDedupeKey(dedupeKey: string): FieldObservation | null {
  const r = getDb().prepare("SELECT * FROM field_observations WHERE dedupe_key = ?").get(dedupeKey);
  return r ? toObservation(r as Row) : null;
}

export function listObservationsForImport(importId: string): FieldObservation[] {
  return getDb()
    .prepare("SELECT * FROM field_observations WHERE import_id = ? ORDER BY ingested_at, rowid")
    .all(importId)
    .map((r) => toObservation(r as Row));
}

export function listObservationsForProject(projectId: string, status?: FieldObservationStatus): FieldObservation[] {
  const rows = status
    ? getDb()
        .prepare("SELECT * FROM field_observations WHERE matched_project_id = ? AND status = ? ORDER BY ingested_at DESC, rowid DESC")
        .all(projectId, status)
    : getDb()
        .prepare("SELECT * FROM field_observations WHERE matched_project_id = ? ORDER BY ingested_at DESC, rowid DESC")
        .all(projectId);
  return rows.map((r) => toObservation(r as Row));
}

/** Observations the tenant imported that matched no project (or
 *  ambiguously) — surfaced for manual assignment, never auto-assigned. */
export function listUnmatchedObservationsForOrganization(organizationId: string): FieldObservation[] {
  return getDb()
    .prepare(
      `SELECT * FROM field_observations
        WHERE organization_id = ? AND matched_project_id IS NULL
        ORDER BY ingested_at DESC, rowid DESC`
    )
    .all(organizationId)
    .map((r) => toObservation(r as Row));
}

export function listObservationsForOrganization(organizationId: string, limit = 200): FieldObservation[] {
  return getDb()
    .prepare("SELECT * FROM field_observations WHERE organization_id = ? ORDER BY ingested_at DESC, rowid DESC LIMIT ?")
    .all(organizationId, Math.min(1000, Math.max(1, limit)))
    .map((r) => toObservation(r as Row));
}

/** Guarded: a project match may be set only while the observation is
 *  still UNVERIFIED or DEFERRED (a decided observation is history). */
export function setObservationMatch(
  id: string,
  match: {
    matchedProjectId: string | null;
    matchVerdict: FieldObservation["matchVerdict"];
    matchReasons: string[];
    suggestedMilestoneId: string | null;
  }
): boolean {
  const res = getDb()
    .prepare(
      `UPDATE field_observations
          SET matched_project_id = ?, match_verdict = ?, match_reasons = ?, suggested_milestone_id = ?
        WHERE id = ? AND status IN ('UNVERIFIED','DEFERRED')`
    )
    .run(match.matchedProjectId, match.matchVerdict, asJson(match.matchReasons), match.suggestedMilestoneId, id);
  return Number(res.changes) === 1;
}

/** Guarded single resolution: UNVERIFIED/DEFERRED -> ACCEPTED | REJECTED |
 *  DEFERRED. Returns false when the row was already decided. */
export function resolveObservation(
  id: string,
  resolution: {
    status: Exclude<FieldObservationStatus, "UNVERIFIED">;
    milestoneId: string | null;
    acceptedEvidenceId: string | null;
    reviewedByUserId: string;
    reviewedAt: string;
    reviewNote: string | null;
  }
): boolean {
  const res = getDb()
    .prepare(
      `UPDATE field_observations
          SET status = ?, milestone_id = ?, accepted_evidence_id = ?,
              reviewed_by_user_id = ?, reviewed_at = ?, review_note = ?
        WHERE id = ? AND status IN ('UNVERIFIED','DEFERRED')`
    )
    .run(
      resolution.status, resolution.milestoneId, resolution.acceptedEvidenceId,
      resolution.reviewedByUserId, resolution.reviewedAt, resolution.reviewNote, id
    );
  return Number(res.changes) === 1;
}

export function countObservationsByStatus(organizationId: string): Record<string, number> {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM field_observations WHERE organization_id = ? GROUP BY status")
    .all(organizationId) as Array<{ status: string; n: number }>;
  const out: Record<string, number> = { UNVERIFIED: 0, ACCEPTED: 0, REJECTED: 0, DEFERRED: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

// ============================================================ photos

function toPhoto(r: Row): FieldObservationPhoto {
  return {
    id: r.id as string,
    observationId: r.observation_id as string,
    seq: Number(r.seq ?? 0),
    fileName: strOrNull(r.file_name),
    contentType: strOrNull(r.content_type),
    sha256: strOrNull(r.sha256),
    bytes: numOrNull(r.bytes),
    storedPath: strOrNull(r.stored_path),
    sourceUrl: strOrNull(r.source_url),
    caption: strOrNull(r.caption),
    transferred: Boolean(r.transferred),
  };
}

export function insertPhoto(p: FieldObservationPhoto): void {
  getDb()
    .prepare(
      `INSERT INTO field_observation_photos (
         id, observation_id, seq, file_name, content_type, sha256, bytes,
         stored_path, source_url, caption, transferred
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.id, p.observationId, p.seq, p.fileName, p.contentType, p.sha256, p.bytes,
      p.storedPath, p.sourceUrl, p.caption, p.transferred ? 1 : 0
    );
}

export function listPhotos(observationId: string): FieldObservationPhoto[] {
  return getDb()
    .prepare("SELECT * FROM field_observation_photos WHERE observation_id = ? ORDER BY seq, rowid")
    .all(observationId)
    .map((r) => toPhoto(r as Row));
}

export function getPhoto(id: string): FieldObservationPhoto | null {
  const r = getDb().prepare("SELECT * FROM field_observation_photos WHERE id = ?").get(id);
  return r ? toPhoto(r as Row) : null;
}

// ============================================================ events

function toEvent(r: Row): FieldObservationEvent {
  return {
    id: r.id as string,
    observationId: r.observation_id as string,
    occurredAt: r.occurred_at as string,
    actorUserId: strOrNull(r.actor_user_id),
    kind: r.kind as FieldObservationEvent["kind"],
    detail: strOrNull(r.detail),
  };
}

export function insertObservationEvent(e: FieldObservationEvent): void {
  getDb()
    .prepare(
      `INSERT INTO field_observation_events (id, observation_id, occurred_at, actor_user_id, kind, detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.observationId, e.occurredAt, e.actorUserId, e.kind, e.detail);
}

export function listObservationEvents(observationId: string): FieldObservationEvent[] {
  return getDb()
    .prepare("SELECT * FROM field_observation_events WHERE observation_id = ? ORDER BY occurred_at, rowid")
    .all(observationId)
    .map((r) => toEvent(r as Row));
}

/** Every observation event for one project's matched observations —
 *  the timeline collector's read. Bounded. */
export function listObservationEventsForProject(projectId: string, limit = 2000): Array<{ event: FieldObservationEvent; observation: FieldObservation }> {
  const rows = getDb()
    .prepare(
      `SELECT e.id AS e_id, e.observation_id AS e_obs, e.occurred_at AS e_at, e.actor_user_id AS e_actor,
              e.kind AS e_kind, e.detail AS e_detail, o.*
         FROM field_observation_events e
         JOIN field_observations o ON o.id = e.observation_id
        WHERE o.matched_project_id = ?
        ORDER BY e.occurred_at, e.rowid
        LIMIT ?`
    )
    .all(projectId, Math.min(10_000, Math.max(1, limit))) as Row[];
  return rows.map((r) => ({
    event: {
      id: r.e_id as string,
      observationId: r.e_obs as string,
      occurredAt: r.e_at as string,
      actorUserId: strOrNull(r.e_actor),
      kind: r.e_kind as FieldObservationEvent["kind"],
      detail: strOrNull(r.e_detail),
    },
    observation: toObservation(r),
  }));
}

// ============================================================ provenance

function toProvenance(r: Row): EvidenceProvenance {
  return {
    evidenceItemId: r.evidence_item_id as string,
    origin: "EXTERNAL_FIELD_OBSERVATION",
    observationId: r.observation_id as string,
    importId: r.import_id as string,
    sourceSystem: r.source_system as EvidenceProvenance["sourceSystem"],
    providerLabel: strOrNull(r.provider_label),
    externalObservationId: r.external_observation_id as string,
    collector: strOrNull(r.collector),
    sourceObservedAt: strOrNull(r.source_observed_at),
    sourceLatitude: numOrNull(r.source_latitude),
    sourceLongitude: numOrNull(r.source_longitude),
    sourceAccuracyMeters: numOrNull(r.source_accuracy_m),
    sourceRecordSha256: r.source_record_sha256 as string,
    acceptedByUserId: r.accepted_by_user_id as string,
    acceptedAt: r.accepted_at as string,
  };
}

export function insertEvidenceProvenance(p: EvidenceProvenance): void {
  getDb()
    .prepare(
      `INSERT INTO evidence_provenance (
         evidence_item_id, origin, observation_id, import_id, source_system, provider_label,
         external_observation_id, collector, source_observed_at, source_latitude,
         source_longitude, source_accuracy_m, source_record_sha256, accepted_by_user_id, accepted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.evidenceItemId, p.origin, p.observationId, p.importId, p.sourceSystem, p.providerLabel,
      p.externalObservationId, p.collector, p.sourceObservedAt, p.sourceLatitude,
      p.sourceLongitude, p.sourceAccuracyMeters, p.sourceRecordSha256, p.acceptedByUserId, p.acceptedAt
    );
}

export function getEvidenceProvenance(evidenceItemId: string): EvidenceProvenance | null {
  const r = getDb().prepare("SELECT * FROM evidence_provenance WHERE evidence_item_id = ?").get(evidenceItemId);
  return r ? toProvenance(r as Row) : null;
}

export function listEvidenceProvenanceForProject(projectId: string): EvidenceProvenance[] {
  return getDb()
    .prepare(
      `SELECT p.* FROM evidence_provenance p
         JOIN evidence_items e ON e.id = p.evidence_item_id
         JOIN milestones m ON m.id = e.milestone_id
        WHERE m.project_id = ?
        ORDER BY p.accepted_at, p.rowid`
    )
    .all(projectId)
    .map((r) => toProvenance(r as Row));
}
