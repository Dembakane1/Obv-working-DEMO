/**
 * Typed repository layer. All SQL for the application lives here so the
 * app/services layer can later be pointed at Prisma without changes.
 */
import { randomUUID } from "node:crypto";
import { getDb } from "./index";
import type {
  ApprovalRecord,
  ApprovalRequest,
  DemoFallbackPhoto,
  EvidenceItem,
  LedgerEntry,
  Milestone,
  Notification,
  Organization,
  Project,
  User,
  Verification,
  VirtualAccountEvent,
} from "../../shared/types";

type Row = Record<string, unknown>;

// ---------- mappers ----------

function toProject(r: Row): Project {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    name: r.name as string,
    description: r.description as string,
    location: r.location as string,
    siteBoundary: JSON.parse(r.site_boundary as string),
    totalBudget: r.total_budget as number,
    status: r.status as Project["status"],
    projectType: r.project_type as Project["projectType"],
  };
}

function toMilestone(r: Row): Milestone {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    seq: r.seq as number,
    title: r.title as string,
    requirement: r.requirement as string,
    trancheAmount: r.tranche_amount as number,
    status: r.status as Milestone["status"],
    accountStatus: r.account_status as Milestone["accountStatus"],
  };
}

function toEvidence(r: Row): EvidenceItem {
  return {
    id: r.id as string,
    milestoneId: r.milestone_id as string,
    userId: r.user_id as string,
    photoPath: r.photo_path as string,
    latitude: (r.latitude as number) ?? null,
    longitude: (r.longitude as number) ?? null,
    capturedAt: r.captured_at as string,
    uploadedAt: r.uploaded_at as string,
    deviceMetadata: JSON.parse(r.device_metadata as string),
    hash: r.hash as string,
    previousHash: (r.previous_hash as string) ?? null,
    isDemoFallback: Boolean(r.is_demo_fallback),
  };
}

function toVerification(r: Row): Verification {
  return {
    id: r.id as string,
    evidenceItemId: r.evidence_item_id as string,
    verdict: r.verdict as Verification["verdict"],
    confidence: r.confidence as number,
    checks: JSON.parse(r.checks as string),
    reasoning: r.reasoning as string,
    createdAt: r.created_at as string,
    source: ((r.source as string) ?? "MOCK_DEFAULT") as Verification["source"],
  };
}

function toLedgerEntry(r: Row): LedgerEntry {
  return {
    id: r.id as string,
    seq: r.seq as number,
    evidenceItemId: r.evidence_item_id as string,
    milestoneId: r.milestone_id as string,
    verificationId: r.verification_id as string,
    timestamp: r.timestamp as string,
    payloadHash: r.payload_hash as string,
    previousHash: r.previous_hash as string,
    currentHash: r.current_hash as string,
  };
}

function toApprovalRequest(r: Row): ApprovalRequest {
  return {
    id: r.id as string,
    milestoneId: r.milestone_id as string,
    status: r.status as ApprovalRequest["status"],
    requiredRoles: JSON.parse(r.required_roles as string),
    createdAt: r.created_at as string,
  };
}

function toAccountEvent(r: Row): VirtualAccountEvent {
  return {
    id: r.id as string,
    milestoneId: r.milestone_id as string,
    type: r.type as VirtualAccountEvent["type"],
    amount: r.amount as number,
    createdAt: r.created_at as string,
  };
}

function toUser(r: Row): User {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    name: r.name as string,
    role: r.role as User["role"],
    title: r.title as string,
  };
}

// ---------- organizations & users ----------

export function insertOrganization(org: Organization): void {
  getDb()
    .prepare("INSERT INTO organizations (id, name, kind) VALUES (?, ?, ?)")
    .run(org.id, org.name, org.kind);
}

export function insertUser(u: User): void {
  getDb()
    .prepare(
      "INSERT INTO users (id, organization_id, name, role, title) VALUES (?, ?, ?, ?, ?)"
    )
    .run(u.id, u.organizationId, u.name, u.role, u.title);
}

export function listUsers(): User[] {
  return getDb()
    .prepare("SELECT * FROM users ORDER BY role")
    .all()
    .map((r) => toUser(r as Row));
}

export function getUser(id: string): User | null {
  const r = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id);
  return r ? toUser(r as Row) : null;
}

export function getOrganization(id: string): Organization | null {
  const r = getDb().prepare("SELECT * FROM organizations WHERE id = ?").get(id);
  return r ? (r as unknown as Organization) : null;
}

// ---------- projects & milestones ----------

export function insertProject(p: Project): void {
  getDb()
    .prepare(
      `INSERT INTO projects (id, organization_id, name, description, location,
         site_boundary, total_budget, status, project_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.id, p.organizationId, p.name, p.description, p.location,
      JSON.stringify(p.siteBoundary), p.totalBudget, p.status, p.projectType
    );
}

export function listProjects(): Project[] {
  return getDb()
    .prepare("SELECT * FROM projects ORDER BY name")
    .all()
    .map((r) => toProject(r as Row));
}

export function getProject(id: string): Project | null {
  const r = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id);
  return r ? toProject(r as Row) : null;
}

export function insertMilestone(m: Milestone): void {
  getDb()
    .prepare(
      `INSERT INTO milestones (id, project_id, seq, title, requirement,
         tranche_amount, status, account_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.id, m.projectId, m.seq, m.title, m.requirement,
      m.trancheAmount, m.status, m.accountStatus
    );
}

export function listMilestones(projectId: string): Milestone[] {
  return getDb()
    .prepare("SELECT * FROM milestones WHERE project_id = ? ORDER BY seq")
    .all(projectId)
    .map((r) => toMilestone(r as Row));
}

export function getMilestone(id: string): Milestone | null {
  const r = getDb().prepare("SELECT * FROM milestones WHERE id = ?").get(id);
  return r ? toMilestone(r as Row) : null;
}

export function updateMilestoneStatus(id: string, status: Milestone["status"]): void {
  getDb().prepare("UPDATE milestones SET status = ? WHERE id = ?").run(status, id);
}

export function updateMilestoneAccountStatus(
  id: string,
  accountStatus: Milestone["accountStatus"]
): void {
  getDb()
    .prepare("UPDATE milestones SET account_status = ? WHERE id = ?")
    .run(accountStatus, id);
}

// ---------- evidence ----------

export function insertEvidence(e: EvidenceItem, submissionKey?: string): void {
  getDb()
    .prepare(
      `INSERT INTO evidence_items (id, milestone_id, user_id, photo_path,
         latitude, longitude, captured_at, uploaded_at, device_metadata,
         hash, previous_hash, is_demo_fallback, submission_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.milestoneId, e.userId, e.photoPath,
      e.latitude, e.longitude, e.capturedAt, e.uploadedAt,
      JSON.stringify(e.deviceMetadata), e.hash, e.previousHash,
      e.isDemoFallback ? 1 : 0, submissionKey ?? null
    );
}

/**
 * Offline-retry idempotency lookup: an identical replayed submission
 * (same milestone, photo, GPS and capture timestamp) maps to the same
 * key. Seeded rows have no key and never match.
 */
export function findEvidenceBySubmissionKey(submissionKey: string): EvidenceItem | null {
  const r = getDb()
    .prepare("SELECT * FROM evidence_items WHERE submission_key = ? LIMIT 1")
    .get(submissionKey);
  return r ? toEvidence(r as Row) : null;
}

export function listEvidenceForMilestone(milestoneId: string): EvidenceItem[] {
  return getDb()
    .prepare("SELECT * FROM evidence_items WHERE milestone_id = ? ORDER BY uploaded_at DESC")
    .all(milestoneId)
    .map((r) => toEvidence(r as Row));
}

export function latestEvidenceForMilestone(milestoneId: string): EvidenceItem | null {
  const r = getDb()
    .prepare("SELECT * FROM evidence_items WHERE milestone_id = ? ORDER BY uploaded_at DESC LIMIT 1")
    .get(milestoneId);
  return r ? toEvidence(r as Row) : null;
}

export function getEvidence(id: string): EvidenceItem | null {
  const r = getDb().prepare("SELECT * FROM evidence_items WHERE id = ?").get(id);
  return r ? toEvidence(r as Row) : null;
}

// ---------- verifications ----------

export function insertVerification(v: Verification): void {
  getDb()
    .prepare(
      `INSERT INTO verifications (id, evidence_item_id, verdict, confidence,
         checks, reasoning, created_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      v.id, v.evidenceItemId, v.verdict, v.confidence,
      JSON.stringify(v.checks), v.reasoning, v.createdAt, v.source
    );
}

export function getVerificationForEvidence(evidenceItemId: string): Verification | null {
  const r = getDb()
    .prepare("SELECT * FROM verifications WHERE evidence_item_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(evidenceItemId);
  return r ? toVerification(r as Row) : null;
}

// ---------- ledger (append-only) ----------

export function insertLedgerEntry(entry: LedgerEntry): void {
  getDb()
    .prepare(
      `INSERT INTO ledger_entries (id, seq, evidence_item_id, milestone_id,
         verification_id, timestamp, payload_hash, previous_hash, current_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.id, entry.seq, entry.evidenceItemId, entry.milestoneId,
      entry.verificationId, entry.timestamp, entry.payloadHash,
      entry.previousHash, entry.currentHash
    );
}

export function lastLedgerEntry(): LedgerEntry | null {
  const r = getDb()
    .prepare("SELECT * FROM ledger_entries ORDER BY seq DESC LIMIT 1")
    .get();
  return r ? toLedgerEntry(r as Row) : null;
}

export function listLedgerEntries(): LedgerEntry[] {
  return getDb()
    .prepare("SELECT * FROM ledger_entries ORDER BY seq")
    .all()
    .map((r) => toLedgerEntry(r as Row));
}

export function getLedgerEntryForEvidence(evidenceItemId: string): LedgerEntry | null {
  const r = getDb()
    .prepare("SELECT * FROM ledger_entries WHERE evidence_item_id = ? LIMIT 1")
    .get(evidenceItemId);
  return r ? toLedgerEntry(r as Row) : null;
}

// ---------- approvals ----------

export function insertApprovalRequest(a: ApprovalRequest): void {
  getDb()
    .prepare(
      `INSERT INTO approval_requests (id, milestone_id, status, required_roles, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(a.id, a.milestoneId, a.status, JSON.stringify(a.requiredRoles), a.createdAt);
}

export function listApprovalRequestsForProject(projectId: string): ApprovalRequest[] {
  return getDb()
    .prepare(
      `SELECT ar.* FROM approval_requests ar
       JOIN milestones m ON m.id = ar.milestone_id
       WHERE m.project_id = ? ORDER BY ar.created_at DESC`
    )
    .all(projectId)
    .map((r) => toApprovalRequest(r as Row));
}

export function getApprovalRequestForMilestone(milestoneId: string): ApprovalRequest | null {
  const r = getDb()
    .prepare("SELECT * FROM approval_requests WHERE milestone_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(milestoneId);
  return r ? toApprovalRequest(r as Row) : null;
}

export function getApprovalRequest(id: string): ApprovalRequest | null {
  const r = getDb().prepare("SELECT * FROM approval_requests WHERE id = ?").get(id);
  return r ? toApprovalRequest(r as Row) : null;
}

export function listPendingApprovalRequests(): ApprovalRequest[] {
  return getDb()
    .prepare("SELECT * FROM approval_requests WHERE status = 'PENDING' ORDER BY created_at")
    .all()
    .map((r) => toApprovalRequest(r as Row));
}

export function updateApprovalRequestStatus(
  id: string,
  status: ApprovalRequest["status"]
): void {
  getDb().prepare("UPDATE approval_requests SET status = ? WHERE id = ?").run(status, id);
}

function toApprovalRecord(r: Row): ApprovalRecord {
  return {
    id: r.id as string,
    approvalRequestId: r.approval_request_id as string,
    userId: r.user_id as string,
    role: r.role as ApprovalRecord["role"],
    decision: r.decision as ApprovalRecord["decision"],
    createdAt: r.created_at as string,
  };
}

export function insertApprovalRecord(rec: ApprovalRecord): void {
  getDb()
    .prepare(
      `INSERT INTO approval_records (id, approval_request_id, user_id, role, decision, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(rec.id, rec.approvalRequestId, rec.userId, rec.role, rec.decision, rec.createdAt);
}

export function listApprovalRecordsForRequest(approvalRequestId: string): ApprovalRecord[] {
  return getDb()
    .prepare("SELECT * FROM approval_records WHERE approval_request_id = ? ORDER BY created_at")
    .all(approvalRequestId)
    .map((r) => toApprovalRecord(r as Row));
}

// ---------- virtual account ----------

export function insertAccountEvent(e: VirtualAccountEvent): void {
  getDb()
    .prepare(
      `INSERT INTO virtual_account_events (id, milestone_id, type, amount, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(e.id, e.milestoneId, e.type, e.amount, e.createdAt);
}

export function listAccountEventsForProject(projectId: string): VirtualAccountEvent[] {
  return getDb()
    .prepare(
      `SELECT v.* FROM virtual_account_events v
       JOIN milestones m ON m.id = v.milestone_id
       WHERE m.project_id = ? ORDER BY v.created_at`
    )
    .all(projectId)
    .map((r) => toAccountEvent(r as Row));
}

export function listAllVerifications(): Verification[] {
  return getDb()
    .prepare("SELECT * FROM verifications ORDER BY created_at DESC")
    .all()
    .map((r) => toVerification(r as Row));
}

export function listAllEvidence(): EvidenceItem[] {
  return getDb()
    .prepare("SELECT * FROM evidence_items ORDER BY uploaded_at DESC")
    .all()
    .map((r) => toEvidence(r as Row));
}

// ---------- notifications ----------

export function insertNotification(n: Notification): void {
  getDb()
    .prepare(
      `INSERT INTO notifications (id, type, message, created_at, project_id,
         milestone_id, delivery_mode, delivery_status, sent_at, failure_category)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      n.id, n.type, n.message, n.createdAt, n.projectId ?? null,
      n.milestoneId ?? null, n.deliveryMode, n.deliveryStatus,
      n.sentAt ?? null, n.failureCategory ?? null
    );
}

export function listNotifications(limit = 20): Notification[] {
  return getDb()
    .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map((r) => {
      const row = r as Row;
      return {
        id: row.id as string,
        type: row.type as string,
        message: row.message as string,
        createdAt: row.created_at as string,
        projectId: (row.project_id as string) ?? null,
        milestoneId: (row.milestone_id as string) ?? null,
        deliveryMode: ((row.delivery_mode as string) ?? "MOCK") as Notification["deliveryMode"],
        deliveryStatus: ((row.delivery_status as string) ?? "SKIPPED") as Notification["deliveryStatus"],
        sentAt: (row.sent_at as string) ?? null,
        failureCategory: (row.failure_category as string) ?? null,
      };
    });
}

// ---------- demo fallback photos ----------

export function insertDemoFallbackPhoto(p: DemoFallbackPhoto): void {
  getDb()
    .prepare("INSERT INTO demo_fallback_photos (id, milestone_id, path, label) VALUES (?, ?, ?, ?)")
    .run(p.id, p.milestoneId, p.path, p.label);
}

function toDemoPhoto(r: Row): DemoFallbackPhoto {
  return {
    id: r.id as string,
    milestoneId: r.milestone_id as string,
    path: r.path as string,
    label: r.label as string,
  };
}

export function listDemoFallbackPhotos(milestoneId: string): DemoFallbackPhoto[] {
  return getDb()
    .prepare("SELECT * FROM demo_fallback_photos WHERE milestone_id = ?")
    .all(milestoneId)
    .map((r) => toDemoPhoto(r as Row));
}

export function getDemoFallbackPhoto(id: string): DemoFallbackPhoto | null {
  const r = getDb().prepare("SELECT * FROM demo_fallback_photos WHERE id = ?").get(id);
  return r ? toDemoPhoto(r as Row) : null;
}

export function newId(): string {
  return randomUUID();
}

// ---------- generated reports ----------

import type {
  Report, SpatialFeature, ConversationThread, ChatMessage,
  ExternalThreadBinding, ExternalIdentityMapping, ExternalParticipantContext,
  FieldIssue, FieldIssueEvent, ClarificationRequest, EvidenceDraft,
} from "../../shared/types";

function toReport(r: Row): Report {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    reportType: r.report_type as string,
    filename: r.filename as string,
    generatedAt: r.generated_at as string,
    generatedBy: r.generated_by as string,
    integrityStatus: r.integrity_status as string,
    ledgerEntries: r.ledger_entries as number,
  };
}

export function insertReport(report: Report): void {
  getDb()
    .prepare(
      `INSERT INTO reports (id, project_id, report_type, filename, generated_at,
         generated_by, integrity_status, ledger_entries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      report.id, report.projectId, report.reportType, report.filename,
      report.generatedAt, report.generatedBy, report.integrityStatus,
      report.ledgerEntries
    );
}

export function listReports(): Report[] {
  return getDb()
    .prepare("SELECT * FROM reports ORDER BY generated_at DESC")
    .all()
    .map((r) => toReport(r as Row));
}

export function getReport(id: string): Report | null {
  const r = getDb().prepare("SELECT * FROM reports WHERE id = ?").get(id);
  return r ? toReport(r as Row) : null;
}

// ---------- spatial features (demo geometry; presentation only) ----------

function toSpatialFeature(r: Row): SpatialFeature {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    milestoneId: (r.milestone_id as string) ?? null,
    kind: r.kind as SpatialFeature["kind"],
    label: r.label as string,
    geometry: JSON.parse(r.geometry as string),
  };
}

export function insertSpatialFeature(f: SpatialFeature): void {
  getDb()
    .prepare(
      `INSERT INTO spatial_features (id, project_id, milestone_id, kind, label, geometry)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(f.id, f.projectId, f.milestoneId, f.kind, f.label, JSON.stringify(f.geometry));
}

export function listSpatialFeatures(projectId: string): SpatialFeature[] {
  return getDb()
    .prepare("SELECT * FROM spatial_features WHERE project_id = ? ORDER BY kind, id")
    .all(projectId)
    .map((r) => toSpatialFeature(r as Row));
}

// ---------- conversation threads & messages ----------
// Chat coordinates; nothing here can reach the approval workflow or the
// virtual account. No UPDATE/DELETE is exposed for messages.

function toThread(r: Row): ConversationThread {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    projectId: (r.project_id as string) ?? null,
    milestoneId: (r.milestone_id as string) ?? null,
    evidenceItemId: (r.evidence_item_id as string) ?? null,
    approvalRequestId: (r.approval_request_id as string) ?? null,
    title: r.title as string,
    scope: r.scope as ConversationThread["scope"],
    createdAt: r.created_at as string,
    createdBy: r.created_by as string,
  };
}

export function insertThread(t: ConversationThread): void {
  getDb()
    .prepare(
      `INSERT INTO conversation_threads (id, organization_id, project_id, milestone_id,
         evidence_item_id, approval_request_id, title, scope, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      t.id, t.organizationId, t.projectId, t.milestoneId, t.evidenceItemId,
      t.approvalRequestId, t.title, t.scope, t.createdAt, t.createdBy
    );
}

export function getThread(id: string): ConversationThread | null {
  const r = getDb().prepare("SELECT * FROM conversation_threads WHERE id = ?").get(id);
  return r ? toThread(r as Row) : null;
}

export function listThreads(): ConversationThread[] {
  return getDb()
    .prepare("SELECT * FROM conversation_threads ORDER BY created_at")
    .all()
    .map((r) => toThread(r as Row));
}

export function findThreadForMilestone(milestoneId: string): ConversationThread | null {
  const r = getDb()
    .prepare(
      "SELECT * FROM conversation_threads WHERE milestone_id = ? AND scope = 'MILESTONE' LIMIT 1"
    )
    .get(milestoneId);
  return r ? toThread(r as Row) : null;
}

export function findProjectThread(projectId: string): ConversationThread | null {
  const r = getDb()
    .prepare(
      "SELECT * FROM conversation_threads WHERE project_id = ? AND scope = 'PROJECT' LIMIT 1"
    )
    .get(projectId);
  return r ? toThread(r as Row) : null;
}

function toChatMessage(r: Row): ChatMessage {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    senderUserId: (r.sender_user_id as string) ?? null,
    senderDisplayName: r.sender_display_name as string,
    provider: r.provider as ChatMessage["provider"],
    externalThreadId: (r.external_thread_id as string) ?? null,
    externalMessageId: (r.external_message_id as string) ?? null,
    body: r.body as string,
    messageType: r.message_type as ChatMessage["messageType"],
    refId: (r.ref_id as string) ?? null,
    createdAt: r.created_at as string,
    deliveryStatus: r.delivery_status as ChatMessage["deliveryStatus"],
    origin: ((r.origin as string) ?? "OBV_LOCAL") as ChatMessage["origin"],
    editedAt: (r.edited_at as string) ?? null,
    originalBody: (r.original_body as string) ?? null,
    externalDeleted: Boolean(r.external_deleted),
    attachments: r.attachments ? JSON.parse(r.attachments as string) : [],
    location: r.location ? JSON.parse(r.location as string) : null,
  };
}

export function insertChatMessage(m: ChatMessage): void {
  getDb()
    .prepare(
      `INSERT INTO messages (id, thread_id, sender_user_id, sender_display_name,
         provider, external_thread_id, external_message_id, body, message_type,
         ref_id, created_at, delivery_status, origin, edited_at, original_body,
         external_deleted, attachments, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.id, m.threadId, m.senderUserId, m.senderDisplayName, m.provider,
      m.externalThreadId, m.externalMessageId, m.body, m.messageType,
      m.refId, m.createdAt, m.deliveryStatus, m.origin, m.editedAt,
      m.originalBody, m.externalDeleted ? 1 : 0,
      m.attachments.length ? JSON.stringify(m.attachments) : null,
      m.location ? JSON.stringify(m.location) : null
    );
}

export function getChatMessage(id: string): ChatMessage | null {
  const r = getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id);
  return r ? toChatMessage(r as Row) : null;
}

/** Inbound dedupe + outbound echo detection: find any message already
 *  carrying this provider message id in this thread. */
export function findMessageByExternalId(
  threadId: string,
  externalMessageId: string
): ChatMessage | null {
  const r = getDb()
    .prepare("SELECT * FROM messages WHERE thread_id = ? AND external_message_id = ? LIMIT 1")
    .get(threadId, externalMessageId);
  return r ? toChatMessage(r as Row) : null;
}

/** Sync-plumbing update ONLY (delivery state + external id). Message
 *  content is never mutated through this path. */
export function updateMessageExternalDelivery(
  id: string,
  externalMessageId: string | null,
  deliveryStatus: ChatMessage["deliveryStatus"]
): void {
  getDb()
    .prepare("UPDATE messages SET external_message_id = ?, delivery_status = ? WHERE id = ?")
    .run(externalMessageId, deliveryStatus, id);
}

/** External EDIT audit: keep the original body on first edit, update the
 *  display body, and record when. Only inbound provider edits use this. */
export function applyExternalEdit(id: string, newBody: string, editedAt: string): void {
  getDb()
    .prepare(
      `UPDATE messages
         SET original_body = COALESCE(original_body, body), body = ?, edited_at = ?
       WHERE id = ?`
    )
    .run(newBody, editedAt, id);
}

/** External DELETE audit: mark deleted, preserve content for audit. */
export function applyExternalDelete(id: string): void {
  getDb()
    .prepare(
      `UPDATE messages
         SET external_deleted = 1, original_body = COALESCE(original_body, body)
       WHERE id = ?`
    )
    .run(id);
}

// ---------- Teams thread bindings & identity mappings ----------

function toBinding(r: Row): ExternalThreadBinding {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    provider: "TEAMS",
    tenantId: r.tenant_id as string,
    teamId: r.team_id as string,
    channelId: r.channel_id as string,
    rootMessageId: (r.root_message_id as string) ?? null,
    teamName: (r.team_name as string) ?? null,
    channelName: (r.channel_name as string) ?? null,
    subscriptionId: (r.subscription_id as string) ?? null,
    subscriptionExpiresAt: (r.subscription_expires_at as string) ?? null,
    status: r.status as ExternalThreadBinding["status"],
    lastSyncAt: (r.last_sync_at as string) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertBinding(b: ExternalThreadBinding): void {
  getDb()
    .prepare(
      `INSERT INTO external_thread_bindings (id, thread_id, provider, tenant_id,
         team_id, channel_id, root_message_id, team_name, channel_name,
         subscription_id, subscription_expires_at, status, last_sync_at,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      b.id, b.threadId, b.provider, b.tenantId, b.teamId, b.channelId,
      b.rootMessageId, b.teamName, b.channelName, b.subscriptionId,
      b.subscriptionExpiresAt, b.status, b.lastSyncAt, b.createdBy,
      b.createdAt, b.updatedAt
    );
}

export function getBindingForThread(threadId: string): ExternalThreadBinding | null {
  const r = getDb()
    .prepare("SELECT * FROM external_thread_bindings WHERE thread_id = ?")
    .get(threadId);
  return r ? toBinding(r as Row) : null;
}

export function getBindingBySubscription(subscriptionId: string): ExternalThreadBinding | null {
  const r = getDb()
    .prepare("SELECT * FROM external_thread_bindings WHERE subscription_id = ?")
    .get(subscriptionId);
  return r ? toBinding(r as Row) : null;
}

export function listBindings(status?: ExternalThreadBinding["status"]): ExternalThreadBinding[] {
  const rows = status
    ? getDb().prepare("SELECT * FROM external_thread_bindings WHERE status = ?").all(status)
    : getDb().prepare("SELECT * FROM external_thread_bindings").all();
  return rows.map((r) => toBinding(r as Row));
}

export function updateBinding(
  id: string,
  patch: Partial<
    Pick<
      ExternalThreadBinding,
      | "subscriptionId" | "subscriptionExpiresAt" | "status" | "lastSyncAt"
      | "rootMessageId" | "teamName" | "channelName"
    >
  >
): void {
  const b = getDb().prepare("SELECT * FROM external_thread_bindings WHERE id = ?").get(id);
  if (!b) return;
  const cur = toBinding(b as Row);
  getDb()
    .prepare(
      `UPDATE external_thread_bindings
         SET subscription_id = ?, subscription_expires_at = ?, status = ?,
             last_sync_at = ?, root_message_id = ?, team_name = ?,
             channel_name = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      patch.subscriptionId !== undefined ? patch.subscriptionId : cur.subscriptionId,
      patch.subscriptionExpiresAt !== undefined ? patch.subscriptionExpiresAt : cur.subscriptionExpiresAt,
      patch.status ?? cur.status,
      patch.lastSyncAt !== undefined ? patch.lastSyncAt : cur.lastSyncAt,
      patch.rootMessageId !== undefined ? patch.rootMessageId : cur.rootMessageId,
      patch.teamName !== undefined ? patch.teamName : cur.teamName,
      patch.channelName !== undefined ? patch.channelName : cur.channelName,
      new Date().toISOString(),
      id
    );
}

function toIdentityMapping(r: Row): ExternalIdentityMapping {
  return {
    id: r.id as string,
    provider: (r.provider as ExternalIdentityMapping["provider"]) ?? "TEAMS",
    tenantId: r.tenant_id as string,
    organizationId: (r.organization_id as string) ?? null,
    externalUserId: r.external_user_id as string,
    obvUserId: (r.obv_user_id as string) ?? null,
    externalDisplayName: r.external_display_name as string,
    externalEmail: (r.external_email as string) ?? null,
    status: r.status as ExternalIdentityMapping["status"],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function upsertIdentityMapping(m: ExternalIdentityMapping): void {
  getDb()
    .prepare(
      `INSERT INTO external_identity_mappings (id, provider, tenant_id,
         external_user_id, obv_user_id, external_display_name, external_email,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, tenant_id, external_user_id) DO UPDATE SET
         external_display_name = excluded.external_display_name,
         updated_at = excluded.updated_at`
    )
    .run(
      m.id, m.provider, m.tenantId, m.externalUserId, m.obvUserId,
      m.externalDisplayName, m.externalEmail, m.status, m.createdAt, m.updatedAt
    );
}

export function listIdentityMappings(): ExternalIdentityMapping[] {
  return getDb()
    .prepare("SELECT * FROM external_identity_mappings ORDER BY updated_at DESC")
    .all()
    .map((r) => toIdentityMapping(r as Row));
}

export function setIdentityMapping(
  tenantId: string,
  externalUserId: string,
  obvUserId: string | null
): void {
  getDb()
    .prepare(
      `UPDATE external_identity_mappings
         SET obv_user_id = ?, status = ?, updated_at = ?
       WHERE provider = 'TEAMS' AND tenant_id = ? AND external_user_id = ?`
    )
    .run(
      obvUserId,
      obvUserId ? "MAPPED" : "UNMAPPED",
      new Date().toISOString(),
      tenantId,
      externalUserId
    );
}

export function findIdentityMapping(
  tenantId: string,
  externalUserId: string,
  provider: ExternalIdentityMapping["provider"] = "TEAMS"
): ExternalIdentityMapping | null {
  const r = getDb()
    .prepare(
      `SELECT * FROM external_identity_mappings
        WHERE provider = ? AND tenant_id = ? AND external_user_id = ?`
    )
    .get(provider, tenantId, externalUserId);
  return r ? toIdentityMapping(r as Row) : null;
}

export function setIdentityMappingByProvider(
  provider: ExternalIdentityMapping["provider"],
  tenantId: string,
  externalUserId: string,
  obvUserId: string | null
): void {
  getDb()
    .prepare(
      `UPDATE external_identity_mappings
         SET obv_user_id = ?, status = ?, updated_at = ?
       WHERE provider = ? AND tenant_id = ? AND external_user_id = ?`
    )
    .run(
      obvUserId, obvUserId ? "MAPPED" : "UNMAPPED", new Date().toISOString(),
      provider, tenantId, externalUserId
    );
}

export function listMessagesForThread(threadId: string): ChatMessage[] {
  return getDb()
    .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at")
    .all(threadId)
    .map((r) => toChatMessage(r as Row));
}

export function latestMessageForThread(threadId: string): ChatMessage | null {
  const r = getDb()
    .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(threadId);
  return r ? toChatMessage(r as Row) : null;
}

export function countChatRows(): { threads: number; messages: number } {
  const r = getDb()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM conversation_threads) AS threads,
              (SELECT COUNT(*) FROM messages) AS messages`
    )
    .get() as Row;
  return { threads: r.threads as number, messages: r.messages as number };
}

// ---------- external participant contexts (WhatsApp routing) ----------

function toParticipantContext(r: Row): ExternalParticipantContext {
  return {
    id: r.id as string,
    provider: r.provider as ExternalParticipantContext["provider"],
    externalUserId: r.external_user_id as string,
    activeProjectId: (r.active_project_id as string) ?? null,
    activeThreadId: (r.active_thread_id as string) ?? null,
    activeMilestoneId: (r.active_milestone_id as string) ?? null,
    lastInboundAt: (r.last_inbound_at as string) ?? null,
    expiresAt: (r.expires_at as string) ?? null,
    updatedAt: r.updated_at as string,
  };
}

export function upsertParticipantContext(c: ExternalParticipantContext): void {
  getDb()
    .prepare(
      `INSERT INTO external_participant_contexts (id, provider, external_user_id,
         active_project_id, active_thread_id, active_milestone_id,
         last_inbound_at, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, external_user_id) DO UPDATE SET
         active_project_id = excluded.active_project_id,
         active_thread_id = excluded.active_thread_id,
         active_milestone_id = excluded.active_milestone_id,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`
    )
    .run(
      c.id, c.provider, c.externalUserId, c.activeProjectId, c.activeThreadId,
      c.activeMilestoneId, c.lastInboundAt, c.expiresAt, c.updatedAt
    );
}

export function getParticipantContext(
  provider: string,
  externalUserId: string
): ExternalParticipantContext | null {
  const r = getDb()
    .prepare(
      "SELECT * FROM external_participant_contexts WHERE provider = ? AND external_user_id = ?"
    )
    .get(provider, externalUserId);
  return r ? toParticipantContext(r as Row) : null;
}

export function listParticipantContextsForThread(threadId: string): ExternalParticipantContext[] {
  return getDb()
    .prepare("SELECT * FROM external_participant_contexts WHERE active_thread_id = ?")
    .all(threadId)
    .map((r) => toParticipantContext(r as Row));
}

export function touchParticipantInbound(provider: string, externalUserId: string): void {
  getDb()
    .prepare(
      `UPDATE external_participant_contexts
         SET last_inbound_at = ?, updated_at = ?
       WHERE provider = ? AND external_user_id = ?`
    )
    .run(new Date().toISOString(), new Date().toISOString(), provider, externalUserId);
}

// ---------- field issues (operational; never touches money) ----------

function toFieldIssue(r: Row): FieldIssue {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    projectId: r.project_id as string,
    milestoneId: (r.milestone_id as string) ?? null,
    evidenceItemId: (r.evidence_item_id as string) ?? null,
    sourceThreadId: (r.source_thread_id as string) ?? null,
    sourceMessageId: (r.source_message_id as string) ?? null,
    title: r.title as string,
    description: r.description as string,
    category: r.category as FieldIssue["category"],
    severity: r.severity as FieldIssue["severity"],
    status: r.status as FieldIssue["status"],
    reportedByUserId: (r.reported_by_user_id as string) ?? null,
    reportedByExternalIdentityId: (r.reported_by_external_identity_id as string) ?? null,
    assignedToUserId: (r.assigned_to_user_id as string) ?? null,
    latitude: (r.latitude as number) ?? null,
    longitude: (r.longitude as number) ?? null,
    dueAt: (r.due_at as string) ?? null,
    resolvedAt: (r.resolved_at as string) ?? null,
    resolutionSummary: (r.resolution_summary as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertFieldIssue(i: FieldIssue): void {
  getDb()
    .prepare(
      `INSERT INTO field_issues (id, organization_id, project_id, milestone_id,
         evidence_item_id, source_thread_id, source_message_id, title, description,
         category, severity, status, reported_by_user_id,
         reported_by_external_identity_id, assigned_to_user_id, latitude, longitude,
         due_at, resolved_at, resolution_summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      i.id, i.organizationId, i.projectId, i.milestoneId, i.evidenceItemId,
      i.sourceThreadId, i.sourceMessageId, i.title, i.description, i.category,
      i.severity, i.status, i.reportedByUserId, i.reportedByExternalIdentityId,
      i.assignedToUserId, i.latitude, i.longitude, i.dueAt, i.resolvedAt,
      i.resolutionSummary, i.createdAt, i.updatedAt
    );
}

export function getFieldIssue(id: string): FieldIssue | null {
  const r = getDb().prepare("SELECT * FROM field_issues WHERE id = ?").get(id);
  return r ? toFieldIssue(r as Row) : null;
}

export function listFieldIssues(): FieldIssue[] {
  return getDb()
    .prepare("SELECT * FROM field_issues ORDER BY created_at DESC")
    .all()
    .map((r) => toFieldIssue(r as Row));
}

export function updateFieldIssue(
  id: string,
  patch: Partial<
    Pick<
      FieldIssue,
      "status" | "assignedToUserId" | "severity" | "dueAt" | "resolvedAt" | "resolutionSummary"
    >
  >
): void {
  const cur = getFieldIssue(id);
  if (!cur) return;
  getDb()
    .prepare(
      `UPDATE field_issues SET status = ?, assigned_to_user_id = ?, severity = ?,
         due_at = ?, resolved_at = ?, resolution_summary = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      patch.status ?? cur.status,
      patch.assignedToUserId !== undefined ? patch.assignedToUserId : cur.assignedToUserId,
      patch.severity ?? cur.severity,
      patch.dueAt !== undefined ? patch.dueAt : cur.dueAt,
      patch.resolvedAt !== undefined ? patch.resolvedAt : cur.resolvedAt,
      patch.resolutionSummary !== undefined ? patch.resolutionSummary : cur.resolutionSummary,
      new Date().toISOString(),
      id
    );
}

export function insertIssueEvent(e: FieldIssueEvent): void {
  getDb()
    .prepare(
      `INSERT INTO field_issue_events (id, issue_id, type, detail, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.issueId, e.type, e.detail, e.actorUserId, e.createdAt);
}

export function listIssueEvents(issueId: string): FieldIssueEvent[] {
  return getDb()
    .prepare("SELECT * FROM field_issue_events WHERE issue_id = ? ORDER BY created_at")
    .all(issueId)
    .map((r) => ({
      id: r.id as string,
      issueId: r.issue_id as string,
      type: r.type as FieldIssueEvent["type"],
      detail: r.detail as string,
      actorUserId: (r.actor_user_id as string) ?? null,
      createdAt: r.created_at as string,
    }));
}

// ---------- clarification requests ----------

function toClarification(r: Row): ClarificationRequest {
  return {
    id: r.id as string,
    milestoneId: r.milestone_id as string,
    evidenceItemId: (r.evidence_item_id as string) ?? null,
    question: r.question as string,
    responseType: r.response_type as ClarificationRequest["responseType"],
    dueAt: (r.due_at as string) ?? null,
    assignedToUserId: (r.assigned_to_user_id as string) ?? null,
    requestedByUserId: r.requested_by_user_id as string,
    status: r.status as ClarificationRequest["status"],
    responseMessageId: (r.response_message_id as string) ?? null,
    resolutionNote: (r.resolution_note as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertClarification(c: ClarificationRequest): void {
  getDb()
    .prepare(
      `INSERT INTO clarification_requests (id, milestone_id, evidence_item_id,
         question, response_type, due_at, assigned_to_user_id, requested_by_user_id,
         status, response_message_id, resolution_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      c.id, c.milestoneId, c.evidenceItemId, c.question, c.responseType, c.dueAt,
      c.assignedToUserId, c.requestedByUserId, c.status, c.responseMessageId,
      c.resolutionNote, c.createdAt, c.updatedAt
    );
}

export function getClarification(id: string): ClarificationRequest | null {
  const r = getDb().prepare("SELECT * FROM clarification_requests WHERE id = ?").get(id);
  return r ? toClarification(r as Row) : null;
}

export function listClarificationsForMilestone(milestoneId: string): ClarificationRequest[] {
  return getDb()
    .prepare("SELECT * FROM clarification_requests WHERE milestone_id = ? ORDER BY created_at DESC")
    .all(milestoneId)
    .map((r) => toClarification(r as Row));
}

export function listOpenClarificationsForMilestone(milestoneId: string): ClarificationRequest[] {
  return getDb()
    .prepare(
      "SELECT * FROM clarification_requests WHERE milestone_id = ? AND status IN ('OPEN','REOPENED') ORDER BY created_at"
    )
    .all(milestoneId)
    .map((r) => toClarification(r as Row));
}

export function listClarifications(): ClarificationRequest[] {
  return getDb()
    .prepare("SELECT * FROM clarification_requests ORDER BY created_at DESC")
    .all()
    .map((r) => toClarification(r as Row));
}

export function updateClarification(
  id: string,
  patch: Partial<Pick<ClarificationRequest, "status" | "responseMessageId" | "resolutionNote">>
): void {
  const cur = getClarification(id);
  if (!cur) return;
  getDb()
    .prepare(
      `UPDATE clarification_requests
         SET status = ?, response_message_id = ?, resolution_note = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      patch.status ?? cur.status,
      patch.responseMessageId !== undefined ? patch.responseMessageId : cur.responseMessageId,
      patch.resolutionNote !== undefined ? patch.resolutionNote : cur.resolutionNote,
      new Date().toISOString(),
      id
    );
}

// ---------- evidence drafts (governed promotion; NOT evidence) ----------

function toDraft(r: Row): EvidenceDraft {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    milestoneId: r.milestone_id as string,
    sourceMessageId: r.source_message_id as string,
    sourceAttachmentIndex: r.source_attachment_index as number,
    mediaPath: r.media_path as string,
    sourceProvider: r.source_provider as EvidenceDraft["sourceProvider"],
    sourceIdentity: r.source_identity as string,
    sourceTimestamp: r.source_timestamp as string,
    latitude: (r.latitude as number) ?? null,
    longitude: (r.longitude as number) ?? null,
    locationSourceMessageId: (r.location_source_message_id as string) ?? null,
    status: r.status as EvidenceDraft["status"],
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
    submittedAt: (r.submitted_at as string) ?? null,
    evidenceItemId: (r.evidence_item_id as string) ?? null,
  };
}

export function insertDraft(d: EvidenceDraft): void {
  getDb()
    .prepare(
      `INSERT INTO evidence_drafts (id, project_id, milestone_id, source_message_id,
         source_attachment_index, media_path, source_provider, source_identity,
         source_timestamp, latitude, longitude, location_source_message_id, status,
         created_by, created_at, submitted_at, evidence_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.id, d.projectId, d.milestoneId, d.sourceMessageId, d.sourceAttachmentIndex,
      d.mediaPath, d.sourceProvider, d.sourceIdentity, d.sourceTimestamp,
      d.latitude, d.longitude, d.locationSourceMessageId, d.status, d.createdBy,
      d.createdAt, d.submittedAt, d.evidenceItemId
    );
}

export function getDraft(id: string): EvidenceDraft | null {
  const r = getDb().prepare("SELECT * FROM evidence_drafts WHERE id = ?").get(id);
  return r ? toDraft(r as Row) : null;
}

export function listDraftsForMilestone(milestoneId: string): EvidenceDraft[] {
  return getDb()
    .prepare("SELECT * FROM evidence_drafts WHERE milestone_id = ? ORDER BY created_at DESC")
    .all(milestoneId)
    .map((r) => toDraft(r as Row));
}

export function updateDraft(
  id: string,
  patch: Partial<Pick<EvidenceDraft, "status" | "submittedAt" | "evidenceItemId" | "latitude" | "longitude" | "locationSourceMessageId">>
): void {
  const cur = getDraft(id);
  if (!cur) return;
  getDb()
    .prepare(
      `UPDATE evidence_drafts SET status = ?, submitted_at = ?, evidence_item_id = ?,
         latitude = ?, longitude = ?, location_source_message_id = ?
       WHERE id = ?`
    )
    .run(
      patch.status ?? cur.status,
      patch.submittedAt !== undefined ? patch.submittedAt : cur.submittedAt,
      patch.evidenceItemId !== undefined ? patch.evidenceItemId : cur.evidenceItemId,
      patch.latitude !== undefined ? patch.latitude : cur.latitude,
      patch.longitude !== undefined ? patch.longitude : cur.longitude,
      patch.locationSourceMessageId !== undefined ? patch.locationSourceMessageId : cur.locationSourceMessageId,
      id
    );
}

/** Update delivery state for an outbound message by its external id
 *  (WhatsApp status webhooks: sent -> delivered -> read / failed). */
export function updateMessageDeliveryByExternalId(
  externalMessageId: string,
  deliveryStatus: ChatMessage["deliveryStatus"]
): boolean {
  const result = getDb()
    .prepare("UPDATE messages SET delivery_status = ? WHERE external_message_id = ? AND origin = 'OBV_LOCAL'")
    .run(deliveryStatus, externalMessageId);
  return Number(result.changes) > 0;
}
