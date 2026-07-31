/**
 * Pilot Readiness repository — organization settings, user administration,
 * notifications, email outbox, integration frameworks, backups, feedback,
 * and pilot analytics.
 *
 * Doctrine: this module reads/writes ONLY the pilot-readiness side tables
 * declared in the "Pilot Readiness operations" schema section (plus reads
 * of users/organizations for joins). It never touches verification,
 * approval, banking, package, ledger, or evidence tables, and it never
 * alters the users or organizations tables themselves. Append-only tables
 * (user_access_events, esign_events, accounting_runs, recovery_tests,
 * feedback_events) have no update/delete functions.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./index";

type Row = Record<string, unknown>;

export const newId = (): string => randomUUID();
const now = (): string => new Date().toISOString();
const s = (v: unknown): string => String(v);
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number => Number(v ?? 0);
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const b = (v: unknown): boolean => Boolean(v);

// ------------------------------------------------- organization settings

export interface OrganizationSettings {
  organizationId: string;
  displayName: string | null;
  legalName: string | null;
  website: string | null;
  phone: string | null;
  logoPath: string | null;
  brandColor: string | null;
  timezone: string | null;
  locale: string | null;
  defaultNotificationChannel: string;
  onboardingStartedAt: string | null;
  onboardingCompletedAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

function toSettings(x: Row): OrganizationSettings {
  return {
    organizationId: s(x.organization_id),
    displayName: sn(x.display_name),
    legalName: sn(x.legal_name),
    website: sn(x.website),
    phone: sn(x.phone),
    logoPath: sn(x.logo_path),
    brandColor: sn(x.brand_color),
    timezone: sn(x.timezone),
    locale: sn(x.locale),
    defaultNotificationChannel: s(x.default_notification_channel),
    onboardingStartedAt: sn(x.onboarding_started_at),
    onboardingCompletedAt: sn(x.onboarding_completed_at),
    updatedAt: s(x.updated_at),
    updatedBy: sn(x.updated_by),
  };
}

export function getOrganizationSettings(organizationId: string): OrganizationSettings | null {
  const row = getDb()
    .prepare("SELECT * FROM organization_settings WHERE organization_id = ?")
    .get(organizationId);
  return row ? toSettings(row as Row) : null;
}

export function upsertOrganizationSettings(
  organizationId: string,
  patch: Partial<Omit<OrganizationSettings, "organizationId" | "updatedAt">>,
  updatedBy: string
): OrganizationSettings {
  const existing = getOrganizationSettings(organizationId);
  const merged = {
    displayName: patch.displayName ?? existing?.displayName ?? null,
    legalName: patch.legalName ?? existing?.legalName ?? null,
    website: patch.website ?? existing?.website ?? null,
    phone: patch.phone ?? existing?.phone ?? null,
    logoPath: patch.logoPath ?? existing?.logoPath ?? null,
    brandColor: patch.brandColor ?? existing?.brandColor ?? null,
    timezone: patch.timezone ?? existing?.timezone ?? null,
    locale: patch.locale ?? existing?.locale ?? null,
    defaultNotificationChannel:
      patch.defaultNotificationChannel ?? existing?.defaultNotificationChannel ?? "IN_APP",
    onboardingStartedAt: patch.onboardingStartedAt ?? existing?.onboardingStartedAt ?? null,
    onboardingCompletedAt: patch.onboardingCompletedAt ?? existing?.onboardingCompletedAt ?? null,
  };
  getDb()
    .prepare(
      `INSERT INTO organization_settings (
         organization_id, display_name, legal_name, website, phone, logo_path, brand_color,
         timezone, locale, default_notification_channel, onboarding_started_at,
         onboarding_completed_at, updated_at, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET
         display_name = excluded.display_name,
         legal_name = excluded.legal_name,
         website = excluded.website,
         phone = excluded.phone,
         logo_path = excluded.logo_path,
         brand_color = excluded.brand_color,
         timezone = excluded.timezone,
         locale = excluded.locale,
         default_notification_channel = excluded.default_notification_channel,
         onboarding_started_at = excluded.onboarding_started_at,
         onboarding_completed_at = excluded.onboarding_completed_at,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    )
    .run(
      organizationId,
      merged.displayName,
      merged.legalName,
      merged.website,
      merged.phone,
      merged.logoPath,
      merged.brandColor,
      merged.timezone,
      merged.locale,
      merged.defaultNotificationChannel,
      merged.onboardingStartedAt,
      merged.onboardingCompletedAt,
      now(),
      updatedBy
    );
  return getOrganizationSettings(organizationId)!;
}

export interface OnboardingStep {
  organizationId: string;
  stepKey: string;
  completedAt: string;
  completedBy: string;
}

export function completeOnboardingStep(organizationId: string, stepKey: string, userId: string): void {
  getDb()
    .prepare(
      `INSERT INTO onboarding_steps (id, organization_id, step_key, completed_at, completed_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, step_key) DO NOTHING`
    )
    .run(newId(), organizationId, stepKey, now(), userId);
}

export function listOnboardingSteps(organizationId: string): OnboardingStep[] {
  return getDb()
    .prepare("SELECT * FROM onboarding_steps WHERE organization_id = ? ORDER BY completed_at")
    .all(organizationId)
    .map((r) => {
      const x = r as Row;
      return {
        organizationId: s(x.organization_id),
        stepKey: s(x.step_key),
        completedAt: s(x.completed_at),
        completedBy: s(x.completed_by),
      };
    });
}

// ------------------------------------------------------ user admin state

export interface UserAdminState {
  userId: string;
  status: "ACTIVE" | "SUSPENDED";
  suspendedAt: string | null;
  suspendedBy: string | null;
  suspensionReason: string | null;
  restoredAt: string | null;
  restoredBy: string | null;
  mfaReady: boolean;
  updatedAt: string;
}

function toAdminState(x: Row): UserAdminState {
  return {
    userId: s(x.user_id),
    status: s(x.status) as "ACTIVE" | "SUSPENDED",
    suspendedAt: sn(x.suspended_at),
    suspendedBy: sn(x.suspended_by),
    suspensionReason: sn(x.suspension_reason),
    restoredAt: sn(x.restored_at),
    restoredBy: sn(x.restored_by),
    mfaReady: b(x.mfa_ready),
    updatedAt: s(x.updated_at),
  };
}

export function getUserAdminState(userId: string): UserAdminState | null {
  const row = getDb().prepare("SELECT * FROM user_admin_state WHERE user_id = ?").get(userId);
  return row ? toAdminState(row as Row) : null;
}

/** Hot-path check used by session resolution: absent row = ACTIVE. */
export function isUserSuspended(userId: string): boolean {
  const row = getDb()
    .prepare("SELECT status FROM user_admin_state WHERE user_id = ?")
    .get(userId) as Row | undefined;
  return row ? s(row.status) === "SUSPENDED" : false;
}

export function setUserSuspended(
  userId: string,
  suspended: boolean,
  actorUserId: string,
  reason: string | null
): UserAdminState {
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO user_admin_state (
         user_id, status, suspended_at, suspended_by, suspension_reason,
         restored_at, restored_by, mfa_ready, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         status = excluded.status,
         suspended_at = CASE WHEN excluded.status = 'SUSPENDED' THEN excluded.suspended_at ELSE user_admin_state.suspended_at END,
         suspended_by = CASE WHEN excluded.status = 'SUSPENDED' THEN excluded.suspended_by ELSE user_admin_state.suspended_by END,
         suspension_reason = CASE WHEN excluded.status = 'SUSPENDED' THEN excluded.suspension_reason ELSE user_admin_state.suspension_reason END,
         restored_at = CASE WHEN excluded.status = 'ACTIVE' THEN excluded.updated_at ELSE user_admin_state.restored_at END,
         restored_by = CASE WHEN excluded.status = 'ACTIVE' THEN excluded.suspended_by ELSE user_admin_state.restored_by END,
         updated_at = excluded.updated_at`
    )
    .run(
      userId,
      suspended ? "SUSPENDED" : "ACTIVE",
      suspended ? ts : null,
      actorUserId,
      suspended ? reason : null,
      suspended ? null : ts,
      suspended ? null : actorUserId,
      ts
    );
  return getUserAdminState(userId)!;
}

export function setMfaReady(userId: string, ready: boolean): void {
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO user_admin_state (user_id, status, mfa_ready, updated_at)
       VALUES (?, 'ACTIVE', ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET mfa_ready = excluded.mfa_ready, updated_at = excluded.updated_at`
    )
    .run(userId, ready ? 1 : 0, ts);
}

export interface AccessEvent {
  id: string;
  userId: string;
  event: string;
  userAgent: string | null;
  createdAt: string;
}

export function insertAccessEvent(userId: string, event: "SIGN_IN" | "SIGN_IN_REFUSED", userAgent: string | null): void {
  getDb()
    .prepare(
      "INSERT INTO user_access_events (id, user_id, event, user_agent, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(newId(), userId, event, userAgent, now());
}

export function listAccessEvents(userId: string, limit = 50): AccessEvent[] {
  return getDb()
    .prepare("SELECT * FROM user_access_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit)
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        userId: s(x.user_id),
        event: s(x.event),
        userAgent: sn(x.user_agent),
        createdAt: s(x.created_at),
      };
    });
}

export function lastSignInByUser(): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of getDb()
    .prepare(
      "SELECT user_id, MAX(created_at) AS last FROM user_access_events WHERE event = 'SIGN_IN' GROUP BY user_id"
    )
    .all()) {
    const x = r as Row;
    map.set(s(x.user_id), s(x.last));
  }
  return map;
}

// ------------------------------------------------------ customer success

export interface CsAccount {
  organizationId: string;
  pilotStatus: string;
  goLiveDate: string | null;
  successManager: string | null;
  healthScore: number | null;
  renewalProbability: number | null;
  createdAt: string;
  updatedAt: string;
}

function toCsAccount(x: Row): CsAccount {
  return {
    organizationId: s(x.organization_id),
    pilotStatus: s(x.pilot_status),
    goLiveDate: sn(x.go_live_date),
    successManager: sn(x.success_manager),
    healthScore: nn(x.health_score),
    renewalProbability: nn(x.renewal_probability),
    createdAt: s(x.created_at),
    updatedAt: s(x.updated_at),
  };
}

export function upsertCsAccount(
  organizationId: string,
  patch: Partial<Omit<CsAccount, "organizationId" | "createdAt" | "updatedAt">>
): CsAccount {
  const existing = getDb()
    .prepare("SELECT * FROM cs_accounts WHERE organization_id = ?")
    .get(organizationId) as Row | undefined;
  const ts = now();
  const merged = {
    pilotStatus: patch.pilotStatus ?? (existing ? s(existing.pilot_status) : "PROSPECT"),
    goLiveDate: patch.goLiveDate ?? (existing ? sn(existing.go_live_date) : null),
    successManager: patch.successManager ?? (existing ? sn(existing.success_manager) : null),
    healthScore: patch.healthScore ?? (existing ? nn(existing.health_score) : null),
    renewalProbability: patch.renewalProbability ?? (existing ? nn(existing.renewal_probability) : null),
  };
  getDb()
    .prepare(
      `INSERT INTO cs_accounts (organization_id, pilot_status, go_live_date, success_manager,
         health_score, renewal_probability, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET
         pilot_status = excluded.pilot_status,
         go_live_date = excluded.go_live_date,
         success_manager = excluded.success_manager,
         health_score = excluded.health_score,
         renewal_probability = excluded.renewal_probability,
         updated_at = excluded.updated_at`
    )
    .run(
      organizationId,
      merged.pilotStatus,
      merged.goLiveDate,
      merged.successManager,
      merged.healthScore,
      merged.renewalProbability,
      existing ? s(existing.created_at) : ts,
      ts
    );
  return toCsAccount(
    getDb().prepare("SELECT * FROM cs_accounts WHERE organization_id = ?").get(organizationId) as Row
  );
}

export function listCsAccounts(): CsAccount[] {
  return getDb()
    .prepare("SELECT * FROM cs_accounts ORDER BY organization_id")
    .all()
    .map((r) => toCsAccount(r as Row));
}

export interface CsChecklistItem {
  id: string;
  organizationId: string;
  title: string;
  sort: number;
  done: boolean;
  doneAt: string | null;
  doneBy: string | null;
  createdAt: string;
}

export function insertCsChecklistItem(organizationId: string, title: string, sort: number): CsChecklistItem {
  const id = newId();
  getDb()
    .prepare(
      "INSERT INTO cs_checklist_items (id, organization_id, title, sort, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, organizationId, title, sort, now());
  return listCsChecklist(organizationId).find((i) => i.id === id)!;
}

export function setCsChecklistDone(id: string, done: boolean, userId: string): boolean {
  const res = getDb()
    .prepare("UPDATE cs_checklist_items SET done = ?, done_at = ?, done_by = ? WHERE id = ?")
    .run(done ? 1 : 0, done ? now() : null, done ? userId : null, id);
  return Number(res.changes) === 1;
}

export function listCsChecklist(organizationId: string): CsChecklistItem[] {
  return getDb()
    .prepare("SELECT * FROM cs_checklist_items WHERE organization_id = ? ORDER BY sort, created_at")
    .all(organizationId)
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        organizationId: s(x.organization_id),
        title: s(x.title),
        sort: n(x.sort),
        done: b(x.done),
        doneAt: sn(x.done_at),
        doneBy: sn(x.done_by),
        createdAt: s(x.created_at),
      };
    });
}

export interface CsNote {
  id: string;
  organizationId: string;
  kind: string;
  body: string;
  status: string;
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
}

export function insertCsNote(organizationId: string, kind: string, body: string, createdBy: string): CsNote {
  const id = newId();
  getDb()
    .prepare(
      "INSERT INTO cs_notes (id, organization_id, kind, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, organizationId, kind, body, createdBy, now());
  return listCsNotes(organizationId).find((note) => note.id === id)!;
}

export function resolveCsNote(id: string): boolean {
  const res = getDb()
    .prepare("UPDATE cs_notes SET status = 'RESOLVED', resolved_at = ? WHERE id = ? AND status = 'OPEN'")
    .run(now(), id);
  return Number(res.changes) === 1;
}

export function listCsNotes(organizationId: string): CsNote[] {
  return getDb()
    .prepare("SELECT * FROM cs_notes WHERE organization_id = ? ORDER BY created_at DESC")
    .all(organizationId)
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        organizationId: s(x.organization_id),
        kind: s(x.kind),
        body: s(x.body),
        status: s(x.status),
        createdBy: s(x.created_by),
        createdAt: s(x.created_at),
        resolvedAt: sn(x.resolved_at),
      };
    });
}

// -------------------------------------------------- notification center

export interface NotificationPrefs {
  userId: string;
  inApp: boolean;
  email: boolean;
  dailyDigest: boolean;
  weeklyDigest: boolean;
  mutedTypes: string[];
  updatedAt: string;
}

export function getNotificationPrefs(userId: string): NotificationPrefs {
  const row = getDb()
    .prepare("SELECT * FROM user_notification_prefs WHERE user_id = ?")
    .get(userId) as Row | undefined;
  if (!row) {
    return {
      userId,
      inApp: true,
      email: true,
      dailyDigest: false,
      weeklyDigest: true,
      mutedTypes: [],
      updatedAt: "",
    };
  }
  return {
    userId,
    inApp: b(row.in_app),
    email: b(row.email),
    dailyDigest: b(row.daily_digest),
    weeklyDigest: b(row.weekly_digest),
    mutedTypes: JSON.parse(s(row.muted_types)) as string[],
    updatedAt: s(row.updated_at),
  };
}

export function upsertNotificationPrefs(
  userId: string,
  patch: Partial<Omit<NotificationPrefs, "userId" | "updatedAt">>
): NotificationPrefs {
  const current = getNotificationPrefs(userId);
  const merged = {
    inApp: patch.inApp ?? current.inApp,
    email: patch.email ?? current.email,
    dailyDigest: patch.dailyDigest ?? current.dailyDigest,
    weeklyDigest: patch.weeklyDigest ?? current.weeklyDigest,
    mutedTypes: patch.mutedTypes ?? current.mutedTypes,
  };
  getDb()
    .prepare(
      `INSERT INTO user_notification_prefs (user_id, in_app, email, daily_digest, weekly_digest, muted_types, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         in_app = excluded.in_app, email = excluded.email,
         daily_digest = excluded.daily_digest, weekly_digest = excluded.weekly_digest,
         muted_types = excluded.muted_types, updated_at = excluded.updated_at`
    )
    .run(
      userId,
      merged.inApp ? 1 : 0,
      merged.email ? 1 : 0,
      merged.dailyDigest ? 1 : 0,
      merged.weeklyDigest ? 1 : 0,
      JSON.stringify(merged.mutedTypes),
      now()
    );
  return getNotificationPrefs(userId);
}

export function markNotificationRead(userId: string, notificationKey: string): void {
  getDb()
    .prepare(
      `INSERT INTO user_notification_reads (user_id, notification_key, read_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, notification_key) DO NOTHING`
    )
    .run(userId, notificationKey, now());
}

export function readKeysForUser(userId: string): Set<string> {
  return new Set(
    getDb()
      .prepare("SELECT notification_key FROM user_notification_reads WHERE user_id = ?")
      .all(userId)
      .map((r) => s((r as Row).notification_key))
  );
}

// ------------------------------------------------------------ email outbox

export interface OutboxEmail {
  id: string;
  toUserId: string | null;
  toAddress: string;
  template: string;
  subject: string;
  body: string;
  refType: string | null;
  refId: string | null;
  provider: string;
  status: string;
  createdAt: string;
  sentAt: string | null;
  failureCategory: string | null;
}

function toEmail(x: Row): OutboxEmail {
  return {
    id: s(x.id),
    toUserId: sn(x.to_user_id),
    toAddress: s(x.to_address),
    template: s(x.template),
    subject: s(x.subject),
    body: s(x.body),
    refType: sn(x.ref_type),
    refId: sn(x.ref_id),
    provider: s(x.provider),
    status: s(x.status),
    createdAt: s(x.created_at),
    sentAt: sn(x.sent_at),
    failureCategory: sn(x.failure_category),
  };
}

export function insertOutboxEmail(email: Omit<OutboxEmail, "createdAt">): OutboxEmail {
  getDb()
    .prepare(
      `INSERT INTO email_outbox (id, to_user_id, to_address, template, subject, body, ref_type, ref_id,
         provider, status, created_at, sent_at, failure_category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      email.id,
      email.toUserId,
      email.toAddress,
      email.template,
      email.subject,
      email.body,
      email.refType,
      email.refId,
      email.provider,
      email.status,
      now(),
      email.sentAt,
      email.failureCategory
    );
  return getDb().prepare("SELECT * FROM email_outbox WHERE id = ?").get(email.id) ? toEmail(
    getDb().prepare("SELECT * FROM email_outbox WHERE id = ?").get(email.id) as Row
  ) : (email as OutboxEmail);
}

export function markOutboxEmail(id: string, status: "SENT" | "FAILED" | "SKIPPED", failureCategory: string | null): boolean {
  const res = getDb()
    .prepare("UPDATE email_outbox SET status = ?, sent_at = ?, failure_category = ? WHERE id = ? AND status = 'QUEUED'")
    .run(status, status === "SENT" ? now() : null, failureCategory, id);
  return Number(res.changes) === 1;
}

export function listOutbox(limit = 100): OutboxEmail[] {
  return getDb()
    .prepare("SELECT * FROM email_outbox ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((r) => toEmail(r as Row));
}

export function outboxCounts(): Record<string, number> {
  const counts: Record<string, number> = { QUEUED: 0, SENT: 0, FAILED: 0, SKIPPED: 0 };
  for (const r of getDb().prepare("SELECT status, COUNT(*) AS c FROM email_outbox GROUP BY status").all()) {
    const x = r as Row;
    counts[s(x.status)] = n(x.c);
  }
  return counts;
}

// ---------------------------------------------------------------- e-sign

export interface EsignRequest {
  id: string;
  organizationId: string;
  projectId: string | null;
  provider: string;
  providerReference: string | null;
  title: string;
  documentPath: string | null;
  documentHash: string | null;
  signerName: string;
  signerEmail: string;
  status: string;
  requestedByUserId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  completedDocumentPath: string | null;
  completedDocumentHash: string | null;
}

function toEsign(x: Row): EsignRequest {
  return {
    id: s(x.id),
    organizationId: s(x.organization_id),
    projectId: sn(x.project_id),
    provider: s(x.provider),
    providerReference: sn(x.provider_reference),
    title: s(x.title),
    documentPath: sn(x.document_path),
    documentHash: sn(x.document_hash),
    signerName: s(x.signer_name),
    signerEmail: s(x.signer_email),
    status: s(x.status),
    requestedByUserId: s(x.requested_by_user_id),
    createdAt: s(x.created_at),
    updatedAt: s(x.updated_at),
    completedAt: sn(x.completed_at),
    completedDocumentPath: sn(x.completed_document_path),
    completedDocumentHash: sn(x.completed_document_hash),
  };
}

export function insertEsignRequest(req: {
  id: string;
  organizationId: string;
  projectId: string | null;
  provider: string;
  title: string;
  documentPath: string | null;
  documentHash: string | null;
  signerName: string;
  signerEmail: string;
  requestedByUserId: string;
}): EsignRequest {
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO esign_requests (id, organization_id, project_id, provider, title, document_path,
         document_hash, signer_name, signer_email, status, requested_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`
    )
    .run(
      req.id,
      req.organizationId,
      req.projectId,
      req.provider,
      req.title,
      req.documentPath,
      req.documentHash,
      req.signerName,
      req.signerEmail,
      req.requestedByUserId,
      ts,
      ts
    );
  return getEsignRequest(req.id)!;
}

export function getEsignRequest(id: string): EsignRequest | null {
  const row = getDb().prepare("SELECT * FROM esign_requests WHERE id = ?").get(id);
  return row ? toEsign(row as Row) : null;
}

export function listEsignRequests(organizationId: string): EsignRequest[] {
  return getDb()
    .prepare("SELECT * FROM esign_requests WHERE organization_id = ? ORDER BY created_at DESC")
    .all(organizationId)
    .map((r) => toEsign(r as Row));
}

/** Guarded status transition — the service validates legality first. */
export function transitionEsignStatus(
  id: string,
  from: string[],
  to: string,
  patch: { providerReference?: string | null; completedDocumentPath?: string | null; completedDocumentHash?: string | null }
): boolean {
  const placeholders = from.map(() => "?").join(",");
  const res = getDb()
    .prepare(
      `UPDATE esign_requests SET status = ?, updated_at = ?,
         provider_reference = COALESCE(?, provider_reference),
         completed_at = CASE WHEN ? IN ('SIGNED','DECLINED','VOIDED') THEN ? ELSE completed_at END,
         completed_document_path = COALESCE(?, completed_document_path),
         completed_document_hash = COALESCE(?, completed_document_hash)
       WHERE id = ? AND status IN (${placeholders})`
    )
    .run(
      to,
      now(),
      patch.providerReference ?? null,
      to,
      now(),
      patch.completedDocumentPath ?? null,
      patch.completedDocumentHash ?? null,
      id,
      ...from
    );
  return Number(res.changes) === 1;
}

export function insertEsignEvent(requestId: string, source: "OBV" | "WEBHOOK", type: string, detail: string): void {
  getDb()
    .prepare(
      "INSERT INTO esign_events (id, request_id, source, type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(newId(), requestId, source, type, detail, now());
}

export interface EsignEvent {
  id: string;
  requestId: string;
  source: string;
  type: string;
  detail: string;
  createdAt: string;
}

export function listEsignEvents(requestId: string): EsignEvent[] {
  return getDb()
    .prepare("SELECT * FROM esign_events WHERE request_id = ? ORDER BY created_at")
    .all(requestId)
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        requestId: s(x.request_id),
        source: s(x.source),
        type: s(x.type),
        detail: s(x.detail),
        createdAt: s(x.created_at),
      };
    });
}

// ------------------------------------------------------------- accounting

export interface AccountingConnection {
  id: string;
  organizationId: string;
  provider: string;
  status: string;
  externalReference: string | null;
  createdAt: string;
  updatedAt: string;
}

export function upsertAccountingConnection(organizationId: string, provider: string): AccountingConnection {
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO accounting_connections (id, organization_id, provider, status, created_at, updated_at)
       VALUES (?, ?, ?, 'AVAILABLE', ?, ?)
       ON CONFLICT(organization_id, provider) DO NOTHING`
    )
    .run(newId(), organizationId, provider, ts, ts);
  const row = getDb()
    .prepare("SELECT * FROM accounting_connections WHERE organization_id = ? AND provider = ?")
    .get(organizationId, provider) as Row;
  return {
    id: s(row.id),
    organizationId: s(row.organization_id),
    provider: s(row.provider),
    status: s(row.status),
    externalReference: sn(row.external_reference),
    createdAt: s(row.created_at),
    updatedAt: s(row.updated_at),
  };
}

export function listAccountingConnections(organizationId: string): AccountingConnection[] {
  return getDb()
    .prepare("SELECT * FROM accounting_connections WHERE organization_id = ? ORDER BY provider")
    .all(organizationId)
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        organizationId: s(x.organization_id),
        provider: s(x.provider),
        status: s(x.status),
        externalReference: sn(x.external_reference),
        createdAt: s(x.created_at),
        updatedAt: s(x.updated_at),
      };
    });
}

export interface AccountingRun {
  id: string;
  connectionId: string;
  direction: string;
  dataset: string;
  rowCount: number;
  filePath: string | null;
  status: string;
  detail: string | null;
  createdBy: string;
  createdAt: string;
}

export function insertAccountingRun(run: Omit<AccountingRun, "createdAt">): AccountingRun {
  getDb()
    .prepare(
      `INSERT INTO accounting_runs (id, connection_id, direction, dataset, row_count, file_path, status, detail, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      run.id,
      run.connectionId,
      run.direction,
      run.dataset,
      run.rowCount,
      run.filePath,
      run.status,
      run.detail,
      run.createdBy,
      now()
    );
  const x = getDb().prepare("SELECT * FROM accounting_runs WHERE id = ?").get(run.id) as Row;
  return {
    id: s(x.id),
    connectionId: s(x.connection_id),
    direction: s(x.direction),
    dataset: s(x.dataset),
    rowCount: n(x.row_count),
    filePath: sn(x.file_path),
    status: s(x.status),
    detail: sn(x.detail),
    createdBy: s(x.created_by),
    createdAt: s(x.created_at),
  };
}

export function listAccountingRuns(connectionIds: string[]): AccountingRun[] {
  if (connectionIds.length === 0) return [];
  const placeholders = connectionIds.map(() => "?").join(",");
  return getDb()
    .prepare(`SELECT * FROM accounting_runs WHERE connection_id IN (${placeholders}) ORDER BY created_at DESC`)
    .all(...connectionIds)
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        connectionId: s(x.connection_id),
        direction: s(x.direction),
        dataset: s(x.dataset),
        rowCount: n(x.row_count),
        filePath: sn(x.file_path),
        status: s(x.status),
        detail: sn(x.detail),
        createdBy: s(x.created_by),
        createdAt: s(x.created_at),
      };
    });
}

export function insertImportRow(runId: string, dataset: string, payload: Record<string, unknown>): void {
  getDb()
    .prepare(
      "INSERT INTO accounting_import_rows (id, run_id, dataset, payload, state, created_at) VALUES (?, ?, ?, ?, 'STAGED', ?)"
    )
    .run(newId(), runId, dataset, JSON.stringify(payload), now());
}

export function countImportRows(runId: string): number {
  return n((getDb().prepare("SELECT COUNT(*) AS c FROM accounting_import_rows WHERE run_id = ?").get(runId) as Row).c);
}

// ---------------------------------------------------------------- backups

export interface BackupRecord {
  id: string;
  kind: string;
  filePath: string;
  sizeBytes: number;
  sha256: string | null;
  status: string;
  takenBy: string;
  takenAt: string;
  retentionUntil: string | null;
  verifiedAt: string | null;
  verifyStatus: string | null;
  notes: string | null;
}

function toBackup(x: Row): BackupRecord {
  return {
    id: s(x.id),
    kind: s(x.kind),
    filePath: s(x.file_path),
    sizeBytes: n(x.size_bytes),
    sha256: sn(x.sha256),
    status: s(x.status),
    takenBy: s(x.taken_by),
    takenAt: s(x.taken_at),
    retentionUntil: sn(x.retention_until),
    verifiedAt: sn(x.verified_at),
    verifyStatus: sn(x.verify_status),
    notes: sn(x.notes),
  };
}

export function insertBackupRecord(record: Omit<BackupRecord, "takenAt">): BackupRecord {
  getDb()
    .prepare(
      `INSERT INTO backup_records (id, kind, file_path, size_bytes, sha256, status, taken_by, taken_at,
         retention_until, verified_at, verify_status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.kind,
      record.filePath,
      record.sizeBytes,
      record.sha256,
      record.status,
      record.takenBy,
      now(),
      record.retentionUntil,
      record.verifiedAt,
      record.verifyStatus,
      record.notes
    );
  return getBackupRecord(record.id)!;
}

export function getBackupRecord(id: string): BackupRecord | null {
  const row = getDb().prepare("SELECT * FROM backup_records WHERE id = ?").get(id);
  return row ? toBackup(row as Row) : null;
}

export function markBackupVerified(id: string, verifyStatus: "VERIFIED" | "MISMATCH"): boolean {
  const res = getDb()
    .prepare("UPDATE backup_records SET verified_at = ?, verify_status = ? WHERE id = ?")
    .run(now(), verifyStatus, id);
  return Number(res.changes) === 1;
}

export function listBackupRecords(): BackupRecord[] {
  return getDb()
    .prepare("SELECT * FROM backup_records ORDER BY taken_at DESC")
    .all()
    .map((r) => toBackup(r as Row));
}

export function insertRecoveryTest(backupId: string, outcome: "PASSED" | "FAILED", detail: string, testedBy: string): void {
  getDb()
    .prepare(
      "INSERT INTO recovery_tests (id, backup_id, outcome, detail, tested_by, tested_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(newId(), backupId, outcome, detail, testedBy, now());
}

export interface RecoveryTest {
  id: string;
  backupId: string;
  outcome: string;
  detail: string;
  testedBy: string;
  testedAt: string;
}

export function listRecoveryTests(): RecoveryTest[] {
  return getDb()
    .prepare("SELECT * FROM recovery_tests ORDER BY tested_at DESC")
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        id: s(x.id),
        backupId: s(x.backup_id),
        outcome: s(x.outcome),
        detail: s(x.detail),
        testedBy: s(x.tested_by),
        testedAt: s(x.tested_at),
      };
    });
}

// --------------------------------------------------------------- feedback

export interface FeedbackItem {
  id: string;
  organizationId: string;
  userId: string;
  kind: string;
  title: string;
  body: string;
  severity: string;
  status: string;
  pagePath: string | null;
  screenshotPath: string | null;
  createdAt: string;
  updatedAt: string;
}

function toFeedback(x: Row): FeedbackItem {
  return {
    id: s(x.id),
    organizationId: s(x.organization_id),
    userId: s(x.user_id),
    kind: s(x.kind),
    title: s(x.title),
    body: s(x.body),
    severity: s(x.severity),
    status: s(x.status),
    pagePath: sn(x.page_path),
    screenshotPath: sn(x.screenshot_path),
    createdAt: s(x.created_at),
    updatedAt: s(x.updated_at),
  };
}

export function insertFeedback(item: {
  id: string;
  organizationId: string;
  userId: string;
  kind: string;
  title: string;
  body: string;
  severity: string;
  pagePath: string | null;
  screenshotPath: string | null;
}): FeedbackItem {
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO feedback_items (id, organization_id, user_id, kind, title, body, severity, status,
         page_path, screenshot_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`
    )
    .run(
      item.id,
      item.organizationId,
      item.userId,
      item.kind,
      item.title,
      item.body,
      item.severity,
      item.pagePath,
      item.screenshotPath,
      ts,
      ts
    );
  return getFeedback(item.id)!;
}

export function getFeedback(id: string): FeedbackItem | null {
  const row = getDb().prepare("SELECT * FROM feedback_items WHERE id = ?").get(id);
  return row ? toFeedback(row as Row) : null;
}

export function setFeedbackStatus(id: string, status: string): boolean {
  const res = getDb()
    .prepare("UPDATE feedback_items SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, now(), id);
  return Number(res.changes) === 1;
}

export function listFeedbackForOrganization(organizationId: string): FeedbackItem[] {
  return getDb()
    .prepare("SELECT * FROM feedback_items WHERE organization_id = ? ORDER BY created_at DESC")
    .all(organizationId)
    .map((r) => toFeedback(r as Row));
}

export function listAllFeedback(): FeedbackItem[] {
  return getDb()
    .prepare("SELECT * FROM feedback_items ORDER BY created_at DESC")
    .all()
    .map((r) => toFeedback(r as Row));
}

export function insertFeedbackEvent(feedbackId: string, kind: string, body: string, actorUserId: string): void {
  getDb()
    .prepare(
      "INSERT INTO feedback_events (id, feedback_id, kind, body, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(newId(), feedbackId, kind, body, actorUserId, now());
}

export interface FeedbackEvent {
  id: string;
  feedbackId: string;
  kind: string;
  body: string;
  actorUserId: string;
  createdAt: string;
}

export function listFeedbackEvents(feedbackId: string, includeInternal: boolean): FeedbackEvent[] {
  const rows = includeInternal
    ? getDb().prepare("SELECT * FROM feedback_events WHERE feedback_id = ? ORDER BY created_at").all(feedbackId)
    : getDb()
        .prepare(
          "SELECT * FROM feedback_events WHERE feedback_id = ? AND kind != 'INTERNAL_NOTE' ORDER BY created_at"
        )
        .all(feedbackId);
  return rows.map((r) => {
    const x = r as Row;
    return {
      id: s(x.id),
      feedbackId: s(x.feedback_id),
      kind: s(x.kind),
      body: s(x.body),
      actorUserId: s(x.actor_user_id),
      createdAt: s(x.created_at),
    };
  });
}

// ---------------------------------------------------------- usage events

export function insertUsageEvent(
  userId: string | null,
  organizationId: string | null,
  kind: "PAGE_VIEW" | "API_CALL" | "ACTION",
  pathValue: string
): void {
  getDb()
    .prepare(
      "INSERT INTO usage_events (id, user_id, organization_id, kind, path, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(newId(), userId, organizationId, kind, pathValue, now());
}

export interface UsageEventRow {
  userId: string | null;
  organizationId: string | null;
  kind: string;
  path: string;
  createdAt: string;
}

export function listUsageEvents(): UsageEventRow[] {
  return getDb()
    .prepare("SELECT user_id, organization_id, kind, path, created_at FROM usage_events")
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        userId: sn(x.user_id),
        organizationId: sn(x.organization_id),
        kind: s(x.kind),
        path: s(x.path),
        createdAt: s(x.created_at),
      };
    });
}

// -------------------------------------------------- banners + feature flags

export interface SystemBanner {
  id: string;
  message: string;
  level: string;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdBy: string;
  createdAt: string;
}

export function insertBanner(message: string, level: string, createdBy: string, startsAt: string | null, endsAt: string | null): SystemBanner {
  const id = newId();
  getDb()
    .prepare(
      "INSERT INTO system_banners (id, message, level, active, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)"
    )
    .run(id, message, level, startsAt, endsAt, createdBy, now());
  return listBanners(true).find((banner) => banner.id === id)!;
}

export function deactivateBanner(id: string): boolean {
  const res = getDb().prepare("UPDATE system_banners SET active = 0 WHERE id = ? AND active = 1").run(id);
  return Number(res.changes) === 1;
}

export function listBanners(includeInactive = false): SystemBanner[] {
  const rows = includeInactive
    ? getDb().prepare("SELECT * FROM system_banners ORDER BY created_at DESC").all()
    : getDb().prepare("SELECT * FROM system_banners WHERE active = 1 ORDER BY created_at DESC").all();
  return rows.map((r) => {
    const x = r as Row;
    return {
      id: s(x.id),
      message: s(x.message),
      level: s(x.level),
      active: b(x.active),
      startsAt: sn(x.starts_at),
      endsAt: sn(x.ends_at),
      createdBy: s(x.created_by),
      createdAt: s(x.created_at),
    };
  });
}

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string;
  updatedAt: string;
  updatedBy: string | null;
}

export function setFeatureFlag(key: string, enabled: boolean, description: string, updatedBy: string): FeatureFlag {
  getDb()
    .prepare(
      `INSERT INTO feature_flags (key, enabled, description, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled,
         description = CASE WHEN excluded.description != '' THEN excluded.description ELSE feature_flags.description END,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    )
    .run(key, enabled ? 1 : 0, description, now(), updatedBy);
  return listFeatureFlags().find((flag) => flag.key === key)!;
}

export function listFeatureFlags(): FeatureFlag[] {
  return getDb()
    .prepare("SELECT * FROM feature_flags ORDER BY key")
    .all()
    .map((r) => {
      const x = r as Row;
      return {
        key: s(x.key),
        enabled: b(x.enabled),
        description: s(x.description),
        updatedAt: s(x.updated_at),
        updatedBy: sn(x.updated_by),
      };
    });
}

export function isFlagEnabled(key: string): boolean {
  const row = getDb().prepare("SELECT enabled FROM feature_flags WHERE key = ?").get(key) as Row | undefined;
  return row ? b(row.enabled) : false;
}
