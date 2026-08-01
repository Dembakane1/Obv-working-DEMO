/**
 * Integrations repository — all SQL for the Production Integrations
 * Platform: append-only integration audit, email outbox, e-signature
 * requests + trail, calendar events, webhook endpoints/deliveries, and
 * accounting export runs/links.
 *
 * INVARIANTS ENFORCED HERE
 *  - integration_events and esign_events are APPEND-ONLY: insert and
 *    SELECT only; no update or delete statement exists for either.
 *  - This module never touches evidence, verification, ledger, approval,
 *    banking, or package tables — integrations observe the system of
 *    record, they never author it.
 *  - Webhook delivery claiming is a guarded update so two dispatchers
 *    cannot double-send the same delivery.
 */
import { getDb } from "./index";
import type {
  AccountingLink,
  AccountingSyncRun,
  CalendarEvent,
  EmailOutboxEntry,
  EsignEvent,
  EsignRequest,
  IntegrationEvent,
  WebhookDelivery,
  WebhookEndpoint,
} from "../../shared/types";

type Row = Record<string, unknown>;

// ---------- integration audit (append-only) ----------

function toIntegrationEvent(r: Row): IntegrationEvent {
  return {
    id: r.id as string,
    occurredAt: r.occurred_at as string,
    category: r.category as IntegrationEvent["category"],
    provider: r.provider as string,
    operation: r.operation as string,
    actorUserId: (r.actor_user_id as string) ?? null,
    organizationId: (r.organization_id as string) ?? null,
    requestId: r.request_id as string,
    outcome: r.outcome as IntegrationEvent["outcome"],
    subjectType: (r.subject_type as string) ?? null,
    subjectId: (r.subject_id as string) ?? null,
    detail: (r.detail as string) ?? null,
  };
}

export function insertIntegrationEvent(e: IntegrationEvent): void {
  getDb()
    .prepare(
      `INSERT INTO integration_events (
         id, occurred_at, category, provider, operation, actor_user_id,
         organization_id, request_id, outcome, subject_type, subject_id, detail
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.occurredAt, e.category, e.provider, e.operation, e.actorUserId,
      e.organizationId, e.requestId, e.outcome, e.subjectType, e.subjectId, e.detail
    );
}

export function listIntegrationEvents(
  filter: { category?: string; organizationId?: string | null; limit?: number } = {}
): IntegrationEvent[] {
  const limit = Math.min(500, Math.max(1, filter.limit ?? 50));
  if (filter.category && filter.organizationId) {
    return getDb()
      .prepare(
        "SELECT * FROM integration_events WHERE category = ? AND organization_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?"
      )
      .all(filter.category, filter.organizationId, limit)
      .map((r) => toIntegrationEvent(r as Row));
  }
  if (filter.organizationId) {
    return getDb()
      .prepare("SELECT * FROM integration_events WHERE organization_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?")
      .all(filter.organizationId, limit)
      .map((r) => toIntegrationEvent(r as Row));
  }
  if (filter.category) {
    return getDb()
      .prepare("SELECT * FROM integration_events WHERE category = ? ORDER BY occurred_at DESC, id DESC LIMIT ?")
      .all(filter.category, limit)
      .map((r) => toIntegrationEvent(r as Row));
  }
  return getDb()
    .prepare("SELECT * FROM integration_events ORDER BY occurred_at DESC, id DESC LIMIT ?")
    .all(limit)
    .map((r) => toIntegrationEvent(r as Row));
}

export function countIntegrationEvents(category: string, outcome: string): number {
  const r = getDb()
    .prepare("SELECT COUNT(*) AS n FROM integration_events WHERE category = ? AND outcome = ?")
    .get(category, outcome) as Row;
  return r.n as number;
}

// ---------- email outbox ----------

function toEmail(r: Row): EmailOutboxEntry {
  return {
    id: r.id as string,
    kind: r.kind as EmailOutboxEntry["kind"],
    provider: r.provider as string,
    toEmail: r.to_email as string,
    subject: r.subject as string,
    bodyText: r.body_text as string,
    organizationId: (r.organization_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    status: r.status as EmailOutboxEntry["status"],
    error: (r.error as string) ?? null,
    createdAt: r.created_at as string,
    sentAt: (r.sent_at as string) ?? null,
  };
}

export function insertEmail(e: EmailOutboxEntry): void {
  getDb()
    .prepare(
      `INSERT INTO email_outbox (
         id, kind, provider, to_email, subject, body_text, organization_id,
         project_id, status, error, created_at, sent_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.kind, e.provider, e.toEmail, e.subject, e.bodyText, e.organizationId,
      e.projectId, e.status, e.error, e.createdAt, e.sentAt
    );
}

export function getEmail(id: string): EmailOutboxEntry | null {
  const r = getDb().prepare("SELECT * FROM email_outbox WHERE id = ?").get(id);
  return r ? toEmail(r as Row) : null;
}

export function markEmail(id: string, status: EmailOutboxEntry["status"], error: string | null, sentAt: string | null): void {
  getDb()
    .prepare("UPDATE email_outbox SET status = ?, error = ?, sent_at = ? WHERE id = ?")
    .run(status, error, sentAt, id);
}

export function listEmails(filter: { status?: string; kind?: string; limit?: number } = {}): EmailOutboxEntry[] {
  const limit = Math.min(500, Math.max(1, filter.limit ?? 50));
  if (filter.status) {
    return getDb()
      .prepare("SELECT * FROM email_outbox WHERE status = ? ORDER BY created_at DESC LIMIT ?")
      .all(filter.status, limit)
      .map((r) => toEmail(r as Row));
  }
  if (filter.kind) {
    return getDb()
      .prepare("SELECT * FROM email_outbox WHERE kind = ? ORDER BY created_at DESC LIMIT ?")
      .all(filter.kind, limit)
      .map((r) => toEmail(r as Row));
  }
  return getDb()
    .prepare("SELECT * FROM email_outbox ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((r) => toEmail(r as Row));
}

export function emailStats(): { queued: number; sent: number; failed: number } {
  const row = (status: string) =>
    (getDb().prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status = ?").get(status) as Row).n as number;
  return { queued: row("QUEUED"), sent: row("SENT"), failed: row("FAILED") };
}

/** Tenant-scoped counters for the dashboard. Mail with no organization
 *  (e.g. the redacted magic-link record, which precedes any org context)
 *  belongs to no tenant and is counted for none. */
export function emailStatsForOrg(organizationId: string): { queued: number; sent: number; failed: number } {
  const row = (status: string) =>
    (getDb()
      .prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status = ? AND organization_id = ?")
      .get(status, organizationId) as Row).n as number;
  return { queued: row("QUEUED"), sent: row("SENT"), failed: row("FAILED") };
}

export function listEmailsForOrg(
  organizationId: string,
  filter: { status?: string; limit?: number } = {}
): EmailOutboxEntry[] {
  const limit = Math.min(500, Math.max(1, filter.limit ?? 50));
  if (filter.status) {
    return getDb()
      .prepare(
        "SELECT * FROM email_outbox WHERE organization_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(organizationId, filter.status, limit)
      .map((r) => toEmail(r as Row));
  }
  return getDb()
    .prepare("SELECT * FROM email_outbox WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(organizationId, limit)
    .map((r) => toEmail(r as Row));
}

// ---------- e-signature ----------

function toEsign(r: Row): EsignRequest {
  return {
    id: r.id as string,
    provider: r.provider as string,
    kind: r.kind as EsignRequest["kind"],
    title: r.title as string,
    organizationId: r.organization_id as string,
    projectId: (r.project_id as string) ?? null,
    signerName: r.signer_name as string,
    signerEmail: r.signer_email as string,
    documentRef: (r.document_ref as string) ?? null,
    status: r.status as EsignRequest["status"],
    requestedBy: r.requested_by as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    expiresAt: (r.expires_at as string) ?? null,
    completedAt: (r.completed_at as string) ?? null,
  };
}

export function insertEsignRequest(e: EsignRequest): void {
  getDb()
    .prepare(
      `INSERT INTO esign_requests (
         id, provider, kind, title, organization_id, project_id, signer_name,
         signer_email, document_ref, status, requested_by, created_at,
         updated_at, expires_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.provider, e.kind, e.title, e.organizationId, e.projectId, e.signerName,
      e.signerEmail, e.documentRef, e.status, e.requestedBy, e.createdAt,
      e.updatedAt, e.expiresAt, e.completedAt
    );
}

export function getEsignRequest(id: string): EsignRequest | null {
  const r = getDb().prepare("SELECT * FROM esign_requests WHERE id = ?").get(id);
  return r ? toEsign(r as Row) : null;
}

export function listEsignRequestsForOrgs(orgIds: string[], limit = 100): EsignRequest[] {
  if (orgIds.length === 0) return [];
  const marks = orgIds.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM esign_requests WHERE organization_id IN (${marks}) ORDER BY created_at DESC LIMIT ?`)
    .all(...orgIds, Math.min(500, limit))
    .map((r) => toEsign(r as Row));
}

export function updateEsignStatus(
  id: string,
  status: EsignRequest["status"],
  completedAt: string | null
): boolean {
  // Guarded: only a PENDING request can transition, so a request settles
  // exactly once and the trail cannot double-report.
  const result = getDb()
    .prepare("UPDATE esign_requests SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'")
    .run(status, completedAt, new Date().toISOString(), id);
  return result.changes === 1;
}

export function insertEsignEvent(e: EsignEvent): void {
  getDb()
    .prepare(
      `INSERT INTO esign_events (id, request_id, occurred_at, actor_user_id, kind, detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.requestId, e.occurredAt, e.actorUserId, e.kind, e.detail);
}

export function listEsignEvents(requestId: string): EsignEvent[] {
  return getDb()
    .prepare("SELECT * FROM esign_events WHERE request_id = ? ORDER BY occurred_at ASC, id ASC")
    .all(requestId)
    .map((r) => {
      const row = r as Row;
      return {
        id: row.id as string,
        requestId: row.request_id as string,
        occurredAt: row.occurred_at as string,
        actorUserId: (row.actor_user_id as string) ?? null,
        kind: row.kind as EsignEvent["kind"],
        detail: (row.detail as string) ?? null,
      };
    });
}

// ---------- calendar ----------

function toCalendar(r: Row): CalendarEvent {
  return {
    id: r.id as string,
    kind: r.kind as CalendarEvent["kind"],
    title: r.title as string,
    organizationId: r.organization_id as string,
    projectId: (r.project_id as string) ?? null,
    subjectType: (r.subject_type as string) ?? null,
    subjectId: (r.subject_id as string) ?? null,
    startsAt: r.starts_at as string,
    endsAt: (r.ends_at as string) ?? null,
    location: (r.location as string) ?? null,
    notes: (r.notes as string) ?? null,
    status: r.status as CalendarEvent["status"],
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertCalendarEvent(e: CalendarEvent): void {
  getDb()
    .prepare(
      `INSERT INTO calendar_events (
         id, kind, title, organization_id, project_id, subject_type, subject_id,
         starts_at, ends_at, location, notes, status, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.kind, e.title, e.organizationId, e.projectId, e.subjectType, e.subjectId,
      e.startsAt, e.endsAt, e.location, e.notes, e.status, e.createdBy, e.createdAt, e.updatedAt
    );
}

export function getCalendarEvent(id: string): CalendarEvent | null {
  const r = getDb().prepare("SELECT * FROM calendar_events WHERE id = ?").get(id);
  return r ? toCalendar(r as Row) : null;
}

export function listCalendarEventsForOrgs(orgIds: string[], limit = 200): CalendarEvent[] {
  if (orgIds.length === 0) return [];
  const marks = orgIds.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM calendar_events WHERE organization_id IN (${marks}) ORDER BY starts_at ASC LIMIT ?`)
    .all(...orgIds, Math.min(500, limit))
    .map((r) => toCalendar(r as Row));
}

export function updateCalendarStatus(id: string, status: CalendarEvent["status"]): void {
  getDb()
    .prepare("UPDATE calendar_events SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), id);
}

// ---------- webhooks ----------

function toEndpoint(r: Row): WebhookEndpoint {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    url: r.url as string,
    description: (r.description as string) ?? null,
    secret: r.secret as string,
    events: JSON.parse((r.events as string) || "[]"),
    active: Boolean(r.active),
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
  };
}

export function insertWebhookEndpoint(e: WebhookEndpoint): void {
  getDb()
    .prepare(
      `INSERT INTO webhook_endpoints (id, organization_id, url, description, secret, events, active, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.organizationId, e.url, e.description, e.secret, JSON.stringify(e.events), e.active ? 1 : 0, e.createdBy, e.createdAt);
}

export function getWebhookEndpoint(id: string): WebhookEndpoint | null {
  const r = getDb().prepare("SELECT * FROM webhook_endpoints WHERE id = ?").get(id);
  return r ? toEndpoint(r as Row) : null;
}

export function listWebhookEndpointsForOrgs(orgIds: string[]): WebhookEndpoint[] {
  if (orgIds.length === 0) return [];
  const marks = orgIds.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM webhook_endpoints WHERE organization_id IN (${marks}) ORDER BY created_at ASC`)
    .all(...orgIds)
    .map((r) => toEndpoint(r as Row));
}

export function listActiveEndpointsForEvent(organizationId: string, eventKind: string): WebhookEndpoint[] {
  return getDb()
    .prepare("SELECT * FROM webhook_endpoints WHERE organization_id = ? AND active = 1")
    .all(organizationId)
    .map((r) => toEndpoint(r as Row))
    .filter((e) => e.events.includes(eventKind) || e.events.includes("*"));
}

export function setWebhookEndpointActive(id: string, active: boolean): void {
  getDb().prepare("UPDATE webhook_endpoints SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

function toDelivery(r: Row): WebhookDelivery {
  return {
    id: r.id as string,
    endpointId: r.endpoint_id as string,
    eventKind: r.event_kind as string,
    eventId: r.event_id as string,
    payload: r.payload as string,
    status: r.status as WebhookDelivery["status"],
    attemptCount: r.attempt_count as number,
    nextAttemptAt: (r.next_attempt_at as string) ?? null,
    lastAttemptAt: (r.last_attempt_at as string) ?? null,
    lastStatusCode: (r.last_status_code as number) ?? null,
    lastError: (r.last_error as string) ?? null,
    deliveredAt: (r.delivered_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}

/** Idempotent enqueue: one delivery per endpoint+event. Returns false when
 *  the event was already enqueued for this endpoint. */
export function insertWebhookDelivery(d: WebhookDelivery): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO webhook_deliveries (
           id, endpoint_id, event_kind, event_id, payload, status, attempt_count,
           next_attempt_at, last_attempt_at, last_status_code, last_error, delivered_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        d.id, d.endpointId, d.eventKind, d.eventId, d.payload, d.status, d.attemptCount,
        d.nextAttemptAt, d.lastAttemptAt, d.lastStatusCode, d.lastError, d.deliveredAt, d.createdAt
      );
    return true;
  } catch (err) {
    if (String(err).includes("UNIQUE")) return false;
    throw err;
  }
}

export function getWebhookDelivery(id: string): WebhookDelivery | null {
  const r = getDb().prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id);
  return r ? toDelivery(r as Row) : null;
}

export function listDueDeliveries(nowIso: string, limit = 20): WebhookDelivery[] {
  return getDb()
    .prepare(
      `SELECT * FROM webhook_deliveries
       WHERE status IN ('QUEUED','RETRY') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`
    )
    .all(nowIso, limit)
    .map((r) => toDelivery(r as Row));
}

export function listDeliveriesForEndpoints(endpointIds: string[], limit = 100): WebhookDelivery[] {
  if (endpointIds.length === 0) return [];
  const marks = endpointIds.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM webhook_deliveries WHERE endpoint_id IN (${marks}) ORDER BY created_at DESC LIMIT ?`)
    .all(...endpointIds, Math.min(500, limit))
    .map((r) => toDelivery(r as Row));
}

export function webhookQueueStats(): { queued: number; retry: number; delivered: number; deadLetter: number } {
  const n = (status: string) =>
    (getDb().prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = ?").get(status) as Row).n as number;
  return { queued: n("QUEUED"), retry: n("RETRY"), delivered: n("DELIVERED"), deadLetter: n("DEAD_LETTER") };
}

/** Tenant-scoped queue depth: deliveries belonging to the given
 *  organization's endpoints only. */
export function webhookQueueStatsForOrg(
  organizationId: string
): { queued: number; retry: number; delivered: number; deadLetter: number } {
  const n = (status: string) =>
    (getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id = d.endpoint_id
         WHERE d.status = ? AND e.organization_id = ?`
      )
      .get(status, organizationId) as Row).n as number;
  return { queued: n("QUEUED"), retry: n("RETRY"), delivered: n("DELIVERED"), deadLetter: n("DEAD_LETTER") };
}

/** Due deliveries for ONE organization's endpoints — the dispatch route
 *  works only on the caller's own queue. */
export function listDueDeliveriesForOrg(organizationId: string, nowIso: string, limit = 20): WebhookDelivery[] {
  return getDb()
    .prepare(
      `SELECT d.* FROM webhook_deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE e.organization_id = ? AND d.status IN ('QUEUED','RETRY')
         AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
       ORDER BY d.created_at ASC LIMIT ?`
    )
    .all(organizationId, nowIso, limit)
    .map((r) => toDelivery(r as Row));
}

/** Claim a due delivery for one attempt: atomically bumps the attempt
 *  counter and pushes next_attempt_at forward, so a concurrent dispatch
 *  pass sees the delivery as no longer due — exactly one claimer wins. */
export function claimWebhookDelivery(id: string, attemptAt: string, provisionalNextAttemptAt: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE webhook_deliveries
       SET attempt_count = attempt_count + 1, last_attempt_at = ?, next_attempt_at = ?
       WHERE id = ? AND status IN ('QUEUED','RETRY')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`
    )
    .run(attemptAt, provisionalNextAttemptAt, id, attemptAt);
  return result.changes === 1;
}

/** Administrative requeue of a dead-lettered delivery. Resets the attempt
 *  counter: a requeue grants a FRESH attempt budget, otherwise the
 *  delivery would dead-letter again after a single failure. Guarded so
 *  only a dead-lettered row can be revived. */
export function requeueWebhookDelivery(id: string, nextAttemptAt: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE webhook_deliveries
       SET status = 'RETRY', attempt_count = 0, next_attempt_at = ?, last_error = NULL, last_status_code = NULL
       WHERE id = ? AND status = 'DEAD_LETTER'`
    )
    .run(nextAttemptAt, id);
  return result.changes === 1;
}

export function settleWebhookDelivery(
  id: string,
  patch: {
    status: WebhookDelivery["status"];
    nextAttemptAt: string | null;
    lastStatusCode: number | null;
    lastError: string | null;
    deliveredAt: string | null;
  }
): void {
  getDb()
    .prepare(
      `UPDATE webhook_deliveries SET status = ?, next_attempt_at = ?, last_status_code = ?,
         last_error = ?, delivered_at = ? WHERE id = ?`
    )
    .run(patch.status, patch.nextAttemptAt, patch.lastStatusCode, patch.lastError, patch.deliveredAt, id);
}

// ---------- accounting (export-only) ----------

function toSyncRun(r: Row): AccountingSyncRun {
  return {
    id: r.id as string,
    provider: r.provider as string,
    organizationId: r.organization_id as string,
    direction: "EXPORT",
    status: r.status as AccountingSyncRun["status"],
    entityCounts: r.entity_counts ? JSON.parse(r.entity_counts as string) : null,
    error: (r.error as string) ?? null,
    startedBy: r.started_by as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

export function insertSyncRun(run: AccountingSyncRun): void {
  getDb()
    .prepare(
      `INSERT INTO accounting_sync_runs (
         id, provider, organization_id, direction, status, entity_counts, error,
         started_by, started_at, finished_at
       ) VALUES (?, ?, ?, 'EXPORT', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      run.id, run.provider, run.organizationId, run.status,
      run.entityCounts ? JSON.stringify(run.entityCounts) : null,
      run.error, run.startedBy, run.startedAt, run.finishedAt
    );
}

export function finishSyncRun(
  id: string,
  status: "SUCCEEDED" | "FAILED",
  entityCounts: Record<string, number> | null,
  error: string | null
): void {
  getDb()
    .prepare(
      "UPDATE accounting_sync_runs SET status = ?, entity_counts = ?, error = ?, finished_at = ? WHERE id = ?"
    )
    .run(status, entityCounts ? JSON.stringify(entityCounts) : null, error, new Date().toISOString(), id);
}

export function listSyncRunsForOrgs(orgIds: string[], limit = 20): AccountingSyncRun[] {
  if (orgIds.length === 0) return [];
  const marks = orgIds.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM accounting_sync_runs WHERE organization_id IN (${marks}) ORDER BY started_at DESC LIMIT ?`)
    .all(...orgIds, Math.min(100, limit))
    .map((r) => toSyncRun(r as Row));
}

export function upsertAccountingLink(link: AccountingLink): void {
  getDb()
    .prepare(
      `INSERT INTO accounting_links (id, provider, entity_type, entity_id, external_ref, organization_id, sync_run_id, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, entity_type, entity_id) DO UPDATE SET
         external_ref = excluded.external_ref,
         sync_run_id = excluded.sync_run_id,
         synced_at = excluded.synced_at`
    )
    .run(
      link.id, link.provider, link.entityType, link.entityId, link.externalRef,
      link.organizationId, link.syncRunId, link.syncedAt
    );
}

export function listAccountingLinksForOrgs(orgIds: string[], limit = 200): AccountingLink[] {
  if (orgIds.length === 0) return [];
  const marks = orgIds.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM accounting_links WHERE organization_id IN (${marks}) ORDER BY synced_at DESC LIMIT ?`)
    .all(...orgIds, Math.min(1000, limit))
    .map((r) => {
      const row = r as Row;
      return {
        id: row.id as string,
        provider: row.provider as string,
        entityType: row.entity_type as AccountingLink["entityType"],
        entityId: row.entity_id as string,
        externalRef: row.external_ref as string,
        organizationId: row.organization_id as string,
        syncRunId: row.sync_run_id as string,
        syncedAt: row.synced_at as string,
      };
    });
}
