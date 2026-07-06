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
    latitude: r.latitude as number,
    longitude: r.longitude as number,
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

export function insertEvidence(e: EvidenceItem): void {
  getDb()
    .prepare(
      `INSERT INTO evidence_items (id, milestone_id, user_id, photo_path,
         latitude, longitude, captured_at, uploaded_at, device_metadata,
         hash, previous_hash, is_demo_fallback)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.milestoneId, e.userId, e.photoPath,
      e.latitude, e.longitude, e.capturedAt, e.uploadedAt,
      JSON.stringify(e.deviceMetadata), e.hash, e.previousHash,
      e.isDemoFallback ? 1 : 0
    );
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
         checks, reasoning, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      v.id, v.evidenceItemId, v.verdict, v.confidence,
      JSON.stringify(v.checks), v.reasoning, v.createdAt
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
    .prepare("INSERT INTO notifications (id, type, message, created_at) VALUES (?, ?, ?, ?)")
    .run(n.id, n.type, n.message, n.createdAt);
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

import type { Report } from "../../shared/types";

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
