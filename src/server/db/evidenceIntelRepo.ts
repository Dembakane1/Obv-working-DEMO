/**
 * Evidence Intelligence repository — all SQL for the analysis outputs:
 * analysis runs, the append-only advisory signal log, derived metadata
 * facts, provider-neutral OCR results, the reviewer queue + its
 * append-only event log, and the DISABLED future-AI readiness registry.
 *
 * INVARIANTS ENFORCED HERE
 *  - evidence_signals and evidence_review_events are APPEND-ONLY: insert
 *    and SELECT only; no update or delete statement exists for either.
 *  - This module never writes to evidence_items, verifications,
 *    draw_documents, permits, ledger, approval, or banking tables — it
 *    reads the authoritative records and writes only analysis outputs.
 *  - evidence_ai_engines is a READ-ONLY readiness registry: no insert
 *    function exists (government-foundation pattern).
 *  - Signal insertion is idempotent on signal_key; review-item status
 *    transitions are guarded so a promotion/resolution happens once.
 */
import { getDb } from "./index";
import type {
  EvidenceAiEngine,
  EvidenceAnalysisRun,
  EvidenceMetadataFacts,
  EvidenceReviewEvent,
  EvidenceReviewItem,
  EvidenceReviewQueueStatus,
  EvidenceSignal,
  OcrExtraction,
  OcrField,
} from "../../shared/types";

type Row = Record<string, unknown>;

// ---------- analysis runs ----------

function toRun(r: Row): EvidenceAnalysisRun {
  return {
    id: r.id as string,
    subjectType: r.subject_type as EvidenceAnalysisRun["subjectType"],
    subjectId: r.subject_id as string,
    organizationId: (r.organization_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    trigger: r.trigger as string,
    status: r.status as EvidenceAnalysisRun["status"],
    signalCount: r.signal_count as number,
    startedByUserId: (r.started_by_user_id as string) ?? null,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
    detail: (r.detail as string) ?? null,
  };
}

export function insertAnalysisRun(run: EvidenceAnalysisRun): void {
  getDb()
    .prepare(
      `INSERT INTO evidence_analysis_runs (
         id, subject_type, subject_id, organization_id, project_id, trigger,
         status, signal_count, started_by_user_id, started_at, finished_at, detail
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      run.id, run.subjectType, run.subjectId, run.organizationId, run.projectId, run.trigger,
      run.status, run.signalCount, run.startedByUserId, run.startedAt, run.finishedAt, run.detail
    );
}

export function finishAnalysisRun(
  id: string,
  status: "COMPLETED" | "FAILED",
  signalCount: number,
  detail: string | null
): void {
  getDb()
    .prepare(
      "UPDATE evidence_analysis_runs SET status = ?, signal_count = ?, finished_at = ?, detail = ? WHERE id = ?"
    )
    .run(status, signalCount, new Date().toISOString(), detail, id);
}

export function getAnalysisRun(id: string): EvidenceAnalysisRun | null {
  const r = getDb().prepare("SELECT * FROM evidence_analysis_runs WHERE id = ?").get(id);
  return r ? toRun(r as Row) : null;
}

export function listAnalysisRunsForOrgs(orgIds: string[], limit = 50): EvidenceAnalysisRun[] {
  if (orgIds.length === 0) return [];
  const marks = orgIds.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT * FROM evidence_analysis_runs WHERE organization_id IN (${marks})
       ORDER BY started_at DESC, rowid DESC LIMIT ?`
    )
    .all(...orgIds, Math.min(200, limit))
    .map((r) => toRun(r as Row));
}

// ---------- signals (append-only) ----------

function toSignal(r: Row): EvidenceSignal {
  return {
    id: r.id as string,
    runId: (r.run_id as string) ?? null,
    occurredAt: r.occurred_at as string,
    category: r.category as EvidenceSignal["category"],
    severity: r.severity as EvidenceSignal["severity"],
    confidence: r.confidence as number,
    subjectType: r.subject_type as EvidenceSignal["subjectType"],
    subjectId: r.subject_id as string,
    organizationId: (r.organization_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    title: r.title as string,
    explanation: r.explanation as string,
    comparison: r.comparison ? JSON.parse(r.comparison as string) : null,
    recommendation: r.recommendation as string,
    relatedRecords: r.related_records ? JSON.parse(r.related_records as string) : null,
    signalKey: (r.signal_key as string) ?? null,
  };
}

/** Idempotent append: a duplicate signal_key inserts nothing and returns
 *  false, so re-analysis never multiplies findings. */
export function insertSignal(s: EvidenceSignal): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO evidence_signals (
           id, run_id, occurred_at, category, severity, confidence, subject_type,
           subject_id, organization_id, project_id, title, explanation, comparison,
           recommendation, related_records, signal_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        s.id, s.runId, s.occurredAt, s.category, s.severity, s.confidence, s.subjectType,
        s.subjectId, s.organizationId, s.projectId, s.title, s.explanation,
        s.comparison ? JSON.stringify(s.comparison) : null,
        s.recommendation, s.relatedRecords ? JSON.stringify(s.relatedRecords) : null,
        s.signalKey
      );
    return true;
  } catch (err) {
    if (String(err).includes("UNIQUE")) return false;
    throw err;
  }
}

export function getSignal(id: string): EvidenceSignal | null {
  const r = getDb().prepare("SELECT * FROM evidence_signals WHERE id = ?").get(id);
  return r ? toSignal(r as Row) : null;
}

export function findSignalByKey(signalKey: string): EvidenceSignal | null {
  const r = getDb().prepare("SELECT * FROM evidence_signals WHERE signal_key = ?").get(signalKey);
  return r ? toSignal(r as Row) : null;
}

export function listSignalsForSubject(subjectType: string, subjectId: string): EvidenceSignal[] {
  return getDb()
    .prepare(
      "SELECT * FROM evidence_signals WHERE subject_type = ? AND subject_id = ? ORDER BY occurred_at DESC, rowid DESC"
    )
    .all(subjectType, subjectId)
    .map((r) => toSignal(r as Row));
}

export function listSignalsForOrgs(
  orgIds: string[],
  filter: { category?: string; limit?: number } = {}
): EvidenceSignal[] {
  if (orgIds.length === 0) return [];
  const marks = orgIds.map(() => "?").join(",");
  const limit = Math.min(1000, Math.max(1, filter.limit ?? 200));
  if (filter.category) {
    return getDb()
      .prepare(
        `SELECT * FROM evidence_signals WHERE organization_id IN (${marks}) AND category = ?
         ORDER BY occurred_at DESC, rowid DESC LIMIT ?`
      )
      .all(...orgIds, filter.category, limit)
      .map((r) => toSignal(r as Row));
  }
  return getDb()
    .prepare(
      `SELECT * FROM evidence_signals WHERE organization_id IN (${marks})
       ORDER BY occurred_at DESC, rowid DESC LIMIT ?`
    )
    .all(...orgIds, limit)
    .map((r) => toSignal(r as Row));
}

/** Project-scoped signal feed — the correct tenancy boundary for OBV's
 *  multi-participant projects (a user sees projects they participate in,
 *  which may belong to other organizations). */
export function listSignalsForProjects(
  projectIds: string[],
  filter: { category?: string; limit?: number } = {}
): EvidenceSignal[] {
  if (projectIds.length === 0) return [];
  const marks = projectIds.map(() => "?").join(",");
  const limit = Math.min(2000, Math.max(1, filter.limit ?? 500));
  if (filter.category) {
    return getDb()
      .prepare(
        `SELECT * FROM evidence_signals WHERE project_id IN (${marks}) AND category = ?
         ORDER BY occurred_at DESC, rowid DESC LIMIT ?`
      )
      .all(...projectIds, filter.category, limit)
      .map((r) => toSignal(r as Row));
  }
  return getDb()
    .prepare(
      `SELECT * FROM evidence_signals WHERE project_id IN (${marks})
       ORDER BY occurred_at DESC, rowid DESC LIMIT ?`
    )
    .all(...projectIds, limit)
    .map((r) => toSignal(r as Row));
}

/** All signals for one org since a cutoff — the analytics trend feed. */
export function listSignalsSince(organizationId: string, sinceIso: string): EvidenceSignal[] {
  return getDb()
    .prepare(
      "SELECT * FROM evidence_signals WHERE organization_id = ? AND occurred_at >= ? ORDER BY occurred_at ASC, rowid ASC"
    )
    .all(organizationId, sinceIso)
    .map((r) => toSignal(r as Row));
}

// ---------- metadata facts (derived cache) ----------

function toFacts(r: Row): EvidenceMetadataFacts {
  return {
    evidenceItemId: r.evidence_item_id as string,
    organizationId: (r.organization_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    capturedAt: (r.captured_at as string) ?? null,
    uploadedAt: (r.uploaded_at as string) ?? null,
    uploadDelaySeconds: (r.upload_delay_seconds as number) ?? null,
    hasGps: Boolean(r.has_gps),
    latitude: (r.latitude as number) ?? null,
    longitude: (r.longitude as number) ?? null,
    mimeType: (r.mime_type as string) ?? null,
    fileSize: (r.file_size as number) ?? null,
    width: (r.width as number) ?? null,
    height: (r.height as number) ?? null,
    deviceFingerprint: (r.device_fingerprint as string) ?? null,
    documentCreationDate: (r.document_creation_date as string) ?? null,
    contentHash: (r.content_hash as string) ?? null,
    computedAt: r.computed_at as string,
  };
}

export function upsertMetadataFacts(f: EvidenceMetadataFacts): void {
  getDb()
    .prepare(
      `INSERT INTO evidence_metadata_facts (
         evidence_item_id, organization_id, project_id, captured_at, uploaded_at,
         upload_delay_seconds, has_gps, latitude, longitude, mime_type, file_size,
         width, height, device_fingerprint, document_creation_date, content_hash, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(evidence_item_id) DO UPDATE SET
         organization_id = excluded.organization_id,
         project_id = excluded.project_id,
         captured_at = excluded.captured_at,
         uploaded_at = excluded.uploaded_at,
         upload_delay_seconds = excluded.upload_delay_seconds,
         has_gps = excluded.has_gps,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         mime_type = excluded.mime_type,
         file_size = excluded.file_size,
         width = excluded.width,
         height = excluded.height,
         device_fingerprint = excluded.device_fingerprint,
         document_creation_date = excluded.document_creation_date,
         content_hash = excluded.content_hash,
         computed_at = excluded.computed_at`
    )
    .run(
      f.evidenceItemId, f.organizationId, f.projectId, f.capturedAt, f.uploadedAt,
      f.uploadDelaySeconds, f.hasGps ? 1 : 0, f.latitude, f.longitude, f.mimeType, f.fileSize,
      f.width, f.height, f.deviceFingerprint, f.documentCreationDate, f.contentHash, f.computedAt
    );
}

export function getMetadataFacts(evidenceItemId: string): EvidenceMetadataFacts | null {
  const r = getDb().prepare("SELECT * FROM evidence_metadata_facts WHERE evidence_item_id = ?").get(evidenceItemId);
  return r ? toFacts(r as Row) : null;
}

export function listMetadataByHash(contentHash: string): EvidenceMetadataFacts[] {
  return getDb()
    .prepare("SELECT * FROM evidence_metadata_facts WHERE content_hash = ? ORDER BY computed_at ASC")
    .all(contentHash)
    .map((r) => toFacts(r as Row));
}

export function listMetadataByFingerprint(fingerprint: string): EvidenceMetadataFacts[] {
  return getDb()
    .prepare("SELECT * FROM evidence_metadata_facts WHERE device_fingerprint = ? ORDER BY computed_at ASC")
    .all(fingerprint)
    .map((r) => toFacts(r as Row));
}

// ---------- OCR ----------

function toExtraction(r: Row): OcrExtraction {
  return {
    id: r.id as string,
    subjectType: r.subject_type as OcrExtraction["subjectType"],
    subjectId: r.subject_id as string,
    organizationId: (r.organization_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    docKind: r.doc_kind as OcrExtraction["docKind"],
    provider: r.provider as string,
    status: r.status as OcrExtraction["status"],
    rawText: (r.raw_text as string) ?? null,
    overallConfidence: (r.overall_confidence as number) ?? null,
    fingerprint: (r.fingerprint as string) ?? null,
    extractedAt: r.extracted_at as string,
  };
}

/** Upsert an extraction (one per subject+provider) and REPLACE its fields
 *  atomically, so a re-extraction never leaves stale fields behind. */
export function saveExtraction(extraction: OcrExtraction, fields: OcrField[]): void {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM ocr_extractions WHERE subject_type = ? AND subject_id = ? AND provider = ?")
    .get(extraction.subjectType, extraction.subjectId, extraction.provider) as Row | undefined;
  const id = existing ? (existing.id as string) : extraction.id;
  if (existing) {
    db.prepare(
      `UPDATE ocr_extractions SET doc_kind = ?, status = ?, raw_text = ?, overall_confidence = ?,
         fingerprint = ?, extracted_at = ? WHERE id = ?`
    ).run(
      extraction.docKind, extraction.status, extraction.rawText, extraction.overallConfidence,
      extraction.fingerprint, extraction.extractedAt, id
    );
    db.prepare("DELETE FROM ocr_fields WHERE extraction_id = ?").run(id);
  } else {
    db.prepare(
      `INSERT INTO ocr_extractions (
         id, subject_type, subject_id, organization_id, project_id, doc_kind,
         provider, status, raw_text, overall_confidence, fingerprint, extracted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, extraction.subjectType, extraction.subjectId, extraction.organizationId,
      extraction.projectId, extraction.docKind, extraction.provider, extraction.status,
      extraction.rawText, extraction.overallConfidence, extraction.fingerprint, extraction.extractedAt
    );
  }
  const insertField = db.prepare(
    `INSERT INTO ocr_fields (id, extraction_id, field_key, field_value, normalized_value, confidence, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  fields.forEach((f, i) =>
    insertField.run(f.id, id, f.fieldKey, f.fieldValue, f.normalizedValue, f.confidence, i)
  );
}

export function getExtraction(id: string): OcrExtraction | null {
  const r = getDb().prepare("SELECT * FROM ocr_extractions WHERE id = ?").get(id);
  return r ? toExtraction(r as Row) : null;
}

export function listExtractionsForSubject(subjectType: string, subjectId: string): OcrExtraction[] {
  return getDb()
    .prepare("SELECT * FROM ocr_extractions WHERE subject_type = ? AND subject_id = ? ORDER BY extracted_at DESC")
    .all(subjectType, subjectId)
    .map((r) => toExtraction(r as Row));
}

export function listExtractionsByFingerprint(fingerprint: string): OcrExtraction[] {
  return getDb()
    .prepare("SELECT * FROM ocr_extractions WHERE fingerprint = ? ORDER BY extracted_at ASC")
    .all(fingerprint)
    .map((r) => toExtraction(r as Row));
}

export function listExtractionsForOrgs(orgIds: string[], limit = 500): OcrExtraction[] {
  if (orgIds.length === 0) return [];
  const marks = orgIds.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM ocr_extractions WHERE organization_id IN (${marks}) ORDER BY extracted_at DESC LIMIT ?`)
    .all(...orgIds, Math.min(2000, limit))
    .map((r) => toExtraction(r as Row));
}

function toField(r: Row): OcrField {
  return {
    id: r.id as string,
    extractionId: r.extraction_id as string,
    fieldKey: r.field_key as OcrField["fieldKey"],
    fieldValue: (r.field_value as string) ?? null,
    normalizedValue: (r.normalized_value as string) ?? null,
    confidence: (r.confidence as number) ?? null,
    sort: r.sort as number,
  };
}

export function listFields(extractionId: string): OcrField[] {
  return getDb()
    .prepare("SELECT * FROM ocr_fields WHERE extraction_id = ? ORDER BY sort ASC")
    .all(extractionId)
    .map((r) => toField(r as Row));
}

/** Every extraction (within a set of orgs) that carries a given field
 *  value — the duplicate-invoice-number / duplicate-permit-number lookup. */
export function findFieldMatches(
  orgIds: string[],
  fieldKey: string,
  normalizedValue: string
): Array<{ extraction: OcrExtraction; field: OcrField }> {
  if (orgIds.length === 0 || !normalizedValue) return [];
  const marks = orgIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT f.*, e.subject_type AS e_subject_type, e.subject_id AS e_subject_id,
              e.organization_id AS e_org, e.project_id AS e_project, e.doc_kind AS e_doc_kind,
              e.provider AS e_provider, e.status AS e_status, e.raw_text AS e_raw,
              e.overall_confidence AS e_conf, e.fingerprint AS e_fp, e.extracted_at AS e_at
       FROM ocr_fields f JOIN ocr_extractions e ON e.id = f.extraction_id
       WHERE e.organization_id IN (${marks}) AND f.field_key = ? AND f.normalized_value = ?
       ORDER BY e.extracted_at ASC`
    )
    .all(...orgIds, fieldKey, normalizedValue) as Row[];
  return rows.map((r) => ({
    field: toField(r),
    extraction: {
      id: r.extraction_id as string,
      subjectType: r.e_subject_type as OcrExtraction["subjectType"],
      subjectId: r.e_subject_id as string,
      organizationId: (r.e_org as string) ?? null,
      projectId: (r.e_project as string) ?? null,
      docKind: r.e_doc_kind as OcrExtraction["docKind"],
      provider: r.e_provider as string,
      status: r.e_status as OcrExtraction["status"],
      rawText: (r.e_raw as string) ?? null,
      overallConfidence: (r.e_conf as number) ?? null,
      fingerprint: (r.e_fp as string) ?? null,
      extractedAt: r.e_at as string,
    },
  }));
}

// ---------- review queue ----------

function toReviewItem(r: Row): EvidenceReviewItem {
  return {
    id: r.id as string,
    signalId: r.signal_id as string,
    organizationId: (r.organization_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    subjectType: r.subject_type as EvidenceReviewItem["subjectType"],
    subjectId: r.subject_id as string,
    severity: r.severity as EvidenceReviewItem["severity"],
    confidence: r.confidence as number,
    status: r.status as EvidenceReviewQueueStatus,
    recommendation: r.recommendation as string,
    resolutionNote: (r.resolution_note as string) ?? null,
    promotedExceptionId: (r.promoted_exception_id as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    resolvedByUserId: (r.resolved_by_user_id as string) ?? null,
    resolvedAt: (r.resolved_at as string) ?? null,
  };
}

/** Enqueue a review item for a signal, once (unique on signal_id). */
export function insertReviewItem(item: EvidenceReviewItem): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO evidence_review_queue (
           id, signal_id, organization_id, project_id, subject_type, subject_id,
           severity, confidence, status, recommendation, resolution_note,
           promoted_exception_id, created_at, updated_at, resolved_by_user_id, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id, item.signalId, item.organizationId, item.projectId, item.subjectType, item.subjectId,
        item.severity, item.confidence, item.status, item.recommendation, item.resolutionNote,
        item.promotedExceptionId, item.createdAt, item.updatedAt, item.resolvedByUserId, item.resolvedAt
      );
    return true;
  } catch (err) {
    if (String(err).includes("UNIQUE")) return false;
    throw err;
  }
}

export function getReviewItem(id: string): EvidenceReviewItem | null {
  const r = getDb().prepare("SELECT * FROM evidence_review_queue WHERE id = ?").get(id);
  return r ? toReviewItem(r as Row) : null;
}

export function findReviewItemBySignal(signalId: string): EvidenceReviewItem | null {
  const r = getDb().prepare("SELECT * FROM evidence_review_queue WHERE signal_id = ?").get(signalId);
  return r ? toReviewItem(r as Row) : null;
}

export function listReviewForOrgs(
  orgIds: string[],
  filter: { status?: string; limit?: number } = {}
): EvidenceReviewItem[] {
  if (orgIds.length === 0) return [];
  const marks = orgIds.map(() => "?").join(",");
  const limit = Math.min(1000, Math.max(1, filter.limit ?? 200));
  if (filter.status) {
    return getDb()
      .prepare(
        `SELECT * FROM evidence_review_queue WHERE organization_id IN (${marks}) AND status = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`
      )
      .all(...orgIds, filter.status, limit)
      .map((r) => toReviewItem(r as Row));
  }
  return getDb()
    .prepare(
      `SELECT * FROM evidence_review_queue WHERE organization_id IN (${marks})
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(...orgIds, limit)
    .map((r) => toReviewItem(r as Row));
}

/** Guarded status transition: only an OPEN or ACKNOWLEDGED item may be
 *  resolved, so a promotion/dismissal settles exactly once. */
export function updateReviewStatus(
  id: string,
  status: EvidenceReviewQueueStatus,
  patch: { resolutionNote?: string | null; promotedExceptionId?: string | null; resolvedByUserId?: string | null }
): boolean {
  const cur = getReviewItem(id);
  if (!cur) return false;
  const terminal = status === "DISMISSED" || status === "PROMOTED";
  const result = getDb()
    .prepare(
      `UPDATE evidence_review_queue SET status = ?, resolution_note = ?, promoted_exception_id = ?,
         resolved_by_user_id = ?, resolved_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('OPEN','ACKNOWLEDGED')`
    )
    .run(
      status,
      patch.resolutionNote !== undefined ? patch.resolutionNote : cur.resolutionNote,
      patch.promotedExceptionId !== undefined ? patch.promotedExceptionId : cur.promotedExceptionId,
      patch.resolvedByUserId ?? cur.resolvedByUserId,
      terminal ? new Date().toISOString() : cur.resolvedAt,
      new Date().toISOString(),
      id
    );
  return result.changes === 1;
}

/** Project-scoped review queue — the correct tenancy boundary. */
export function listReviewForProjects(
  projectIds: string[],
  filter: { status?: string; limit?: number } = {}
): EvidenceReviewItem[] {
  if (projectIds.length === 0) return [];
  const marks = projectIds.map(() => "?").join(",");
  const limit = Math.min(2000, Math.max(1, filter.limit ?? 500));
  if (filter.status) {
    return getDb()
      .prepare(
        `SELECT * FROM evidence_review_queue WHERE project_id IN (${marks}) AND status = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`
      )
      .all(...projectIds, filter.status, limit)
      .map((r) => toReviewItem(r as Row));
  }
  return getDb()
    .prepare(
      `SELECT * FROM evidence_review_queue WHERE project_id IN (${marks})
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .all(...projectIds, limit)
    .map((r) => toReviewItem(r as Row));
}

export function reviewStatsForProjects(projectIds: string[]): { open: number; acknowledged: number; dismissed: number; promoted: number } {
  if (projectIds.length === 0) return { open: 0, acknowledged: 0, dismissed: 0, promoted: 0 };
  const marks = projectIds.map(() => "?").join(",");
  const n = (status: string) =>
    (getDb()
      .prepare(`SELECT COUNT(*) AS n FROM evidence_review_queue WHERE project_id IN (${marks}) AND status = ?`)
      .get(...projectIds, status) as Row).n as number;
  return { open: n("OPEN"), acknowledged: n("ACKNOWLEDGED"), dismissed: n("DISMISSED"), promoted: n("PROMOTED") };
}

// ---------- review events (append-only) ----------

export function insertReviewEvent(e: EvidenceReviewEvent): void {
  getDb()
    .prepare(
      `INSERT INTO evidence_review_events (id, queue_item_id, occurred_at, actor_user_id, kind, detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.queueItemId, e.occurredAt, e.actorUserId, e.kind, e.detail);
}

export function listReviewEvents(queueItemId: string): EvidenceReviewEvent[] {
  return getDb()
    .prepare("SELECT * FROM evidence_review_events WHERE queue_item_id = ? ORDER BY occurred_at ASC, rowid ASC")
    .all(queueItemId)
    .map((r) => {
      const row = r as Row;
      return {
        id: row.id as string,
        queueItemId: row.queue_item_id as string,
        occurredAt: row.occurred_at as string,
        actorUserId: (row.actor_user_id as string) ?? null,
        kind: row.kind as EvidenceReviewEvent["kind"],
        detail: (row.detail as string) ?? null,
      };
    });
}

// ---------- future-AI readiness registry (SELECT only, no write path) ----------

export function listAiEngines(): EvidenceAiEngine[] {
  return getDb()
    .prepare("SELECT * FROM evidence_ai_engines ORDER BY created_at ASC")
    .all()
    .map((r) => {
      const row = r as Row;
      return {
        id: row.id as string,
        capability: row.capability as EvidenceAiEngine["capability"],
        displayName: row.display_name as string,
        status: "DISABLED",
        createdAt: row.created_at as string,
      };
    });
}
