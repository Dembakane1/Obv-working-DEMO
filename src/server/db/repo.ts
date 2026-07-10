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
    pilot: {
      code: (r.code as string) ?? null,
      category: (r.category as never) ?? null,
      country: (r.country as string) ?? null,
      region: (r.region as string) ?? null,
      locality: (r.locality as string) ?? null,
      implementingOrgId: (r.implementing_org_id as string) ?? null,
      contractorOrgId: (r.contractor_org_id as string) ?? null,
      funderOrgId: (r.funder_org_id as string) ?? null,
      engineerOrgId: (r.engineer_org_id as string) ?? null,
      obvControlledAmount: (r.obv_controlled_amount as number) ?? null,
      currency: (r.currency as string) ?? null,
      plannedStart: (r.planned_start as string) ?? null,
      plannedEnd: (r.planned_end as string) ?? null,
      timezone: (r.timezone as string) ?? null,
      geometryKind: (r.geometry_kind as never) ?? null,
      createdBy: (r.created_by as string) ?? null,
      launchedAt: (r.launched_at as string) ?? null,
      launchedBy: (r.launched_by as string) ?? null,
      configVersion: (r.config_version as number) ?? 1,
    },
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
    plannedStart: (r.planned_start as string) ?? null,
    plannedEnd: (r.planned_end as string) ?? null,
    weight: (r.weight as number) ?? null,
    spatialLabel: (r.spatial_label as string) ?? null,
    archived: Boolean(r.archived),
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
    policyVersion: (r.policy_version as number) ?? null,
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
    milestoneId: (r.milestone_id as string) ?? null,
    drawRequestId: (r.draw_request_id as string) ?? null,
    subjectType: ((r.subject_type as string) ?? "MILESTONE") as ApprovalRequest["subjectType"],
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

function toOrganization(r: Row): Organization {
  return {
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as string,
    profile: {
      country: (r.country as string) ?? null,
      region: (r.region as string) ?? null,
      website: (r.website as string) ?? null,
      primaryContact: (r.primary_contact as string) ?? null,
      billingContact: (r.billing_contact as string) ?? null,
      timezone: (r.timezone as string) ?? null,
      currency: (r.currency as string) ?? null,
      language: (r.language as string) ?? null,
      pilotStart: (r.pilot_start as string) ?? null,
      pilotEnd: (r.pilot_end as string) ?? null,
      pilotReference: (r.pilot_reference as string) ?? null,
      notes: (r.notes as string) ?? null,
    },
  };
}

export function getOrganization(id: string): Organization | null {
  const r = getDb().prepare("SELECT * FROM organizations WHERE id = ?").get(id);
  return r ? toOrganization(r as Row) : null;
}

export function listOrganizations(): Organization[] {
  return getDb()
    .prepare("SELECT * FROM organizations ORDER BY name")
    .all()
    .map((r) => toOrganization(r as Row));
}

export function updateOrganization(
  id: string,
  fields: { name?: string; kind?: string } & Partial<NonNullable<Organization["profile"]>>
): void {
  const cur = getOrganization(id);
  if (!cur) return;
  const prof = { ...cur.profile!, ...fields };
  getDb()
    .prepare(
      `UPDATE organizations SET name = ?, kind = ?, country = ?, region = ?,
         website = ?, primary_contact = ?, billing_contact = ?, timezone = ?,
         currency = ?, language = ?, pilot_start = ?, pilot_end = ?,
         pilot_reference = ?, notes = ?
       WHERE id = ?`
    )
    .run(
      fields.name ?? cur.name, fields.kind ?? cur.kind, prof.country, prof.region,
      prof.website, prof.primaryContact, prof.billingContact, prof.timezone,
      prof.currency, prof.language, prof.pilotStart, prof.pilotEnd,
      prof.pilotReference, prof.notes, id
    );
}

// ---------- projects & milestones ----------

export function insertProject(p: Project): void {
  getDb()
    .prepare(
      `INSERT INTO projects (id, organization_id, name, description, location,
         site_boundary, total_budget, status, project_type, code, category,
         country, region, locality, implementing_org_id, contractor_org_id,
         funder_org_id, engineer_org_id, obv_controlled_amount, currency,
         planned_start, planned_end, timezone, geometry_kind, created_by,
         launched_at, launched_by, config_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.id, p.organizationId, p.name, p.description, p.location,
      JSON.stringify(p.siteBoundary), p.totalBudget, p.status, p.projectType,
      p.pilot?.code ?? null, p.pilot?.category ?? null, p.pilot?.country ?? null,
      p.pilot?.region ?? null, p.pilot?.locality ?? null,
      p.pilot?.implementingOrgId ?? null, p.pilot?.contractorOrgId ?? null,
      p.pilot?.funderOrgId ?? null, p.pilot?.engineerOrgId ?? null,
      p.pilot?.obvControlledAmount ?? null, p.pilot?.currency ?? null,
      p.pilot?.plannedStart ?? null, p.pilot?.plannedEnd ?? null,
      p.pilot?.timezone ?? null, p.pilot?.geometryKind ?? null,
      p.pilot?.createdBy ?? null, p.pilot?.launchedAt ?? null,
      p.pilot?.launchedBy ?? null, p.pilot?.configVersion ?? 1
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
         tranche_amount, status, account_status, planned_start, planned_end,
         weight, spatial_label, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.id, m.projectId, m.seq, m.title, m.requirement,
      m.trancheAmount, m.status, m.accountStatus,
      m.plannedStart ?? null, m.plannedEnd ?? null, m.weight ?? null,
      m.spatialLabel ?? null, m.archived ? 1 : 0
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
         checks, reasoning, created_at, source, policy_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      v.id, v.evidenceItemId, v.verdict, v.confidence,
      JSON.stringify(v.checks), v.reasoning, v.createdAt, v.source,
      v.policyVersion ?? null
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
      `INSERT INTO approval_requests (id, milestone_id, draw_request_id,
         subject_type, status, required_roles, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      a.id, a.milestoneId, a.drawRequestId ?? null,
      a.subjectType ?? "MILESTONE", a.status,
      JSON.stringify(a.requiredRoles), a.createdAt
    );
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

/** Pending MILESTONE-subject requests only (every legacy call site
 *  dereferences milestoneId). Draw approvals have their own listing. */
export function listPendingApprovalRequests(): ApprovalRequest[] {
  return getDb()
    .prepare(
      "SELECT * FROM approval_requests WHERE status = 'PENDING' AND milestone_id IS NOT NULL ORDER BY created_at"
    )
    .all()
    .map((r) => toApprovalRequest(r as Row));
}

export function listPendingDrawApprovalRequests(): ApprovalRequest[] {
  return getDb()
    .prepare(
      "SELECT * FROM approval_requests WHERE status = 'PENDING' AND draw_request_id IS NOT NULL ORDER BY created_at"
    )
    .all()
    .map((r) => toApprovalRequest(r as Row));
}

export function getApprovalRequestForDraw(drawRequestId: string): ApprovalRequest | null {
  const r = getDb()
    .prepare(
      "SELECT * FROM approval_requests WHERE draw_request_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(drawRequestId);
  return r ? toApprovalRequest(r as Row) : null;
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
  Invitation, EvidenceRequirement, VerificationPolicyConfig, ApprovalPolicy,
  FieldAssignment, ConfigSnapshot, ConfigAuditEntry, PilotMetricTarget,
  UserRole,
  DrawRequest, DrawLineItem, DrawDocumentRequirement, DrawDocument,
  DrawEvidenceLink, DrawEvent, DrawAccountEvent,
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

export function deleteSpatialFeatures(projectId: string): void {
  getDb().prepare("DELETE FROM spatial_features WHERE project_id = ?").run(projectId);
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
    drawRequestId: (r.draw_request_id as string) ?? null,
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
         evidence_item_id, approval_request_id, draw_request_id, title, scope, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      t.id, t.organizationId, t.projectId, t.milestoneId, t.evidenceItemId,
      t.approvalRequestId, t.drawRequestId ?? null, t.title, t.scope, t.createdAt, t.createdBy
    );
}

export function findThreadForDraw(drawRequestId: string): ConversationThread | null {
  const r = getDb()
    .prepare(
      "SELECT * FROM conversation_threads WHERE draw_request_id = ? AND scope = 'DRAW' LIMIT 1"
    )
    .get(drawRequestId);
  return r ? toThread(r as Row) : null;
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

// ====================== pilot onboarding (additive) ======================
// Configuration CRUD only — no function below can create evidence,
// verifications, ledger entries, approval records, or account events.

// ---------- project/milestone configuration updates ----------

export function updateProjectFields(
  id: string,
  fields: Partial<{
    name: string; description: string; location: string; status: Project["status"];
    siteBoundary: Project["siteBoundary"]; totalBudget: number;
  }> &
    Partial<NonNullable<Project["pilot"]>>
): void {
  const cur = getProject(id);
  if (!cur) return;
  const pilot = { ...cur.pilot!, ...fields };
  getDb()
    .prepare(
      `UPDATE projects SET name = ?, description = ?, location = ?, status = ?,
         site_boundary = ?, total_budget = ?, code = ?, category = ?, country = ?,
         region = ?, locality = ?, implementing_org_id = ?, contractor_org_id = ?,
         funder_org_id = ?, engineer_org_id = ?, obv_controlled_amount = ?,
         currency = ?, planned_start = ?, planned_end = ?, timezone = ?,
         geometry_kind = ?, created_by = ?, launched_at = ?, launched_by = ?,
         config_version = ?
       WHERE id = ?`
    )
    .run(
      fields.name ?? cur.name, fields.description ?? cur.description,
      fields.location ?? cur.location, fields.status ?? cur.status,
      JSON.stringify(fields.siteBoundary ?? cur.siteBoundary),
      fields.totalBudget ?? cur.totalBudget,
      pilot.code, pilot.category, pilot.country, pilot.region, pilot.locality,
      pilot.implementingOrgId, pilot.contractorOrgId, pilot.funderOrgId,
      pilot.engineerOrgId, pilot.obvControlledAmount, pilot.currency,
      pilot.plannedStart, pilot.plannedEnd, pilot.timezone, pilot.geometryKind,
      pilot.createdBy, pilot.launchedAt, pilot.launchedBy, pilot.configVersion,
      id
    );
}

export function updateMilestoneFields(
  id: string,
  fields: Partial<
    Pick<
      Milestone,
      "title" | "requirement" | "seq" | "trancheAmount" | "plannedStart" |
      "plannedEnd" | "weight" | "spatialLabel" | "archived"
    >
  >
): void {
  const cur = getMilestone(id);
  if (!cur) return;
  getDb()
    .prepare(
      `UPDATE milestones SET title = ?, requirement = ?, seq = ?,
         tranche_amount = ?, planned_start = ?, planned_end = ?, weight = ?,
         spatial_label = ?, archived = ?
       WHERE id = ?`
    )
    .run(
      fields.title ?? cur.title, fields.requirement ?? cur.requirement,
      fields.seq ?? cur.seq, fields.trancheAmount ?? cur.trancheAmount,
      fields.plannedStart !== undefined ? fields.plannedStart : cur.plannedStart ?? null,
      fields.plannedEnd !== undefined ? fields.plannedEnd : cur.plannedEnd ?? null,
      fields.weight !== undefined ? fields.weight : cur.weight ?? null,
      fields.spatialLabel !== undefined ? fields.spatialLabel : cur.spatialLabel ?? null,
      (fields.archived !== undefined ? fields.archived : cur.archived) ? 1 : 0,
      id
    );
}

/** Hard delete — pre-launch draft milestones only (guarded in the service). */
export function deleteMilestone(id: string): void {
  getDb().prepare("DELETE FROM evidence_requirements WHERE milestone_id = ?").run(id);
  getDb().prepare("DELETE FROM approval_policies WHERE milestone_id = ?").run(id);
  getDb().prepare("DELETE FROM milestones WHERE id = ?").run(id);
}

// ---------- invitations ----------

function toInvitation(r: Row): Invitation {
  return {
    id: r.id as string,
    email: r.email as string,
    organizationId: r.organization_id as string,
    role: r.role as UserRole,
    projectId: (r.project_id as string) ?? null,
    tokenHash: r.token_hash as string,
    status: r.status as Invitation["status"],
    expiresAt: r.expires_at as string,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
    acceptedAt: (r.accepted_at as string) ?? null,
    acceptedUserId: (r.accepted_user_id as string) ?? null,
    revokedAt: (r.revoked_at as string) ?? null,
  };
}

export function insertInvitation(i: Invitation): void {
  getDb()
    .prepare(
      `INSERT INTO invitations (id, email, organization_id, role, project_id,
         token_hash, status, expires_at, created_by, created_at, accepted_at,
         accepted_user_id, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      i.id, i.email, i.organizationId, i.role, i.projectId, i.tokenHash,
      i.status, i.expiresAt, i.createdBy, i.createdAt, i.acceptedAt,
      i.acceptedUserId, i.revokedAt
    );
}

export function getInvitation(id: string): Invitation | null {
  const r = getDb().prepare("SELECT * FROM invitations WHERE id = ?").get(id);
  return r ? toInvitation(r as Row) : null;
}

export function findInvitationByTokenHash(tokenHash: string): Invitation | null {
  const r = getDb().prepare("SELECT * FROM invitations WHERE token_hash = ?").get(tokenHash);
  return r ? toInvitation(r as Row) : null;
}

export function listInvitations(): Invitation[] {
  return getDb()
    .prepare("SELECT * FROM invitations ORDER BY created_at DESC")
    .all()
    .map((r) => toInvitation(r as Row));
}

export function updateInvitation(
  id: string,
  patch: Partial<Pick<Invitation, "status" | "tokenHash" | "expiresAt" | "acceptedAt" | "acceptedUserId" | "revokedAt">>
): void {
  const cur = getInvitation(id);
  if (!cur) return;
  getDb()
    .prepare(
      `UPDATE invitations SET status = ?, token_hash = ?, expires_at = ?,
         accepted_at = ?, accepted_user_id = ?, revoked_at = ?
       WHERE id = ?`
    )
    .run(
      patch.status ?? cur.status,
      patch.tokenHash ?? cur.tokenHash,
      patch.expiresAt ?? cur.expiresAt,
      patch.acceptedAt !== undefined ? patch.acceptedAt : cur.acceptedAt,
      patch.acceptedUserId !== undefined ? patch.acceptedUserId : cur.acceptedUserId,
      patch.revokedAt !== undefined ? patch.revokedAt : cur.revokedAt,
      id
    );
}

// ---------- evidence requirements ----------

function toRequirement(r: Row): EvidenceRequirement {
  return {
    id: r.id as string,
    milestoneId: r.milestone_id as string,
    sort: r.sort as number,
    type: r.type as EvidenceRequirement["type"],
    title: r.title as string,
    description: r.description as string,
    required: Boolean(r.required),
    minCount: r.min_count as number,
    mediaTypes: JSON.parse((r.media_types as string) || "[]"),
    geolocationRequired: Boolean(r.geolocation_required),
    recencyDays: (r.recency_days as number) ?? null,
    notes: (r.notes as string) ?? null,
  };
}

export function insertRequirement(req: EvidenceRequirement): void {
  getDb()
    .prepare(
      `INSERT INTO evidence_requirements (id, milestone_id, sort, type, title,
         description, required, min_count, media_types, geolocation_required,
         recency_days, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.id, req.milestoneId, req.sort, req.type, req.title, req.description,
      req.required ? 1 : 0, req.minCount, JSON.stringify(req.mediaTypes),
      req.geolocationRequired ? 1 : 0, req.recencyDays, req.notes
    );
}

export function getRequirement(id: string): EvidenceRequirement | null {
  const r = getDb().prepare("SELECT * FROM evidence_requirements WHERE id = ?").get(id);
  return r ? toRequirement(r as Row) : null;
}

export function listRequirementsForMilestone(milestoneId: string): EvidenceRequirement[] {
  return getDb()
    .prepare("SELECT * FROM evidence_requirements WHERE milestone_id = ? ORDER BY sort, title")
    .all(milestoneId)
    .map((r) => toRequirement(r as Row));
}

export function updateRequirement(id: string, patch: Partial<EvidenceRequirement>): void {
  const cur = getRequirement(id);
  if (!cur) return;
  const next = { ...cur, ...patch };
  getDb()
    .prepare(
      `UPDATE evidence_requirements SET sort = ?, type = ?, title = ?,
         description = ?, required = ?, min_count = ?, media_types = ?,
         geolocation_required = ?, recency_days = ?, notes = ?
       WHERE id = ?`
    )
    .run(
      next.sort, next.type, next.title, next.description, next.required ? 1 : 0,
      next.minCount, JSON.stringify(next.mediaTypes),
      next.geolocationRequired ? 1 : 0, next.recencyDays, next.notes, id
    );
}

export function deleteRequirement(id: string): void {
  getDb().prepare("DELETE FROM evidence_requirements WHERE id = ?").run(id);
}

// ---------- verification policy (bounded customer policy) ----------

export function getVerificationPolicy(projectId: string): VerificationPolicyConfig | null {
  const r = getDb()
    .prepare("SELECT * FROM verification_policies WHERE project_id = ?")
    .get(projectId);
  if (!r) return null;
  const row = r as Row;
  return {
    projectId: row.project_id as string,
    aiConfidenceThreshold: (row.ai_confidence_threshold as number) ?? null,
    geofencePolicy: (row.geofence_policy as never) ?? null,
    recencyDays: (row.recency_days as number) ?? null,
    offlineAllowanceDays: (row.offline_allowance_days as number) ?? null,
    updatedAt: row.updated_at as string,
    updatedBy: (row.updated_by as string) ?? null,
  };
}

export function upsertVerificationPolicy(p: VerificationPolicyConfig): void {
  getDb()
    .prepare(
      `INSERT INTO verification_policies (project_id, ai_confidence_threshold,
         geofence_policy, recency_days, offline_allowance_days, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         ai_confidence_threshold = excluded.ai_confidence_threshold,
         geofence_policy = excluded.geofence_policy,
         recency_days = excluded.recency_days,
         offline_allowance_days = excluded.offline_allowance_days,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    )
    .run(
      p.projectId, p.aiConfidenceThreshold, p.geofencePolicy, p.recencyDays,
      p.offlineAllowanceDays, p.updatedAt, p.updatedBy
    );
}

// ---------- approval matrix ----------

function toApprovalPolicy(r: Row): ApprovalPolicy {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    milestoneId: (r.milestone_id as string) ?? null,
    requiredRoles: JSON.parse(r.required_roles as string),
    updatedAt: r.updated_at as string,
    updatedBy: (r.updated_by as string) ?? null,
  };
}

export function upsertApprovalPolicy(p: ApprovalPolicy): void {
  // SQLite treats NULLs as distinct in UNIQUE constraints, so the
  // project-default row (milestone_id NULL) is replaced explicitly.
  if (p.milestoneId === null) {
    getDb()
      .prepare("DELETE FROM approval_policies WHERE project_id = ? AND milestone_id IS NULL")
      .run(p.projectId);
    getDb()
      .prepare(
        `INSERT INTO approval_policies (id, project_id, milestone_id, required_roles,
           updated_at, updated_by)
         VALUES (?, ?, NULL, ?, ?, ?)`
      )
      .run(p.id, p.projectId, JSON.stringify(p.requiredRoles), p.updatedAt, p.updatedBy);
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO approval_policies (id, project_id, milestone_id, required_roles,
         updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, milestone_id) DO UPDATE SET
         required_roles = excluded.required_roles,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    )
    .run(p.id, p.projectId, p.milestoneId, JSON.stringify(p.requiredRoles), p.updatedAt, p.updatedBy);
}

export function listApprovalPolicies(projectId: string): ApprovalPolicy[] {
  return getDb()
    .prepare("SELECT * FROM approval_policies WHERE project_id = ?")
    .all(projectId)
    .map((r) => toApprovalPolicy(r as Row));
}

/** Effective required roles for a milestone: milestone row, else project
 *  default row, else the standing OBV default. */
export function resolveApprovalRoles(projectId: string, milestoneId: string): UserRole[] {
  const rows = listApprovalPolicies(projectId);
  const forMilestone = rows.find((p) => p.milestoneId === milestoneId);
  if (forMilestone && forMilestone.requiredRoles.length > 0) return forMilestone.requiredRoles;
  const projectDefault = rows.find((p) => p.milestoneId === null);
  if (projectDefault && projectDefault.requiredRoles.length > 0) return projectDefault.requiredRoles;
  return ["FUNDER_REP", "COMPLIANCE_REVIEWER"];
}

// ---------- field assignments ----------

function toAssignment(r: Row): FieldAssignment {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    userId: r.user_id as string,
    milestoneIds: JSON.parse((r.milestone_ids as string) || "[]"),
    effectiveFrom: (r.effective_from as string) ?? null,
    effectiveTo: (r.effective_to as string) ?? null,
    active: Boolean(r.active),
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
  };
}

export function insertAssignment(a: FieldAssignment): void {
  getDb()
    .prepare(
      `INSERT INTO field_assignments (id, project_id, user_id, milestone_ids,
         effective_from, effective_to, active, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      a.id, a.projectId, a.userId, JSON.stringify(a.milestoneIds),
      a.effectiveFrom, a.effectiveTo, a.active ? 1 : 0, a.createdBy, a.createdAt
    );
}

export function listAssignmentsForProject(projectId: string): FieldAssignment[] {
  return getDb()
    .prepare("SELECT * FROM field_assignments WHERE project_id = ? ORDER BY created_at")
    .all(projectId)
    .map((r) => toAssignment(r as Row));
}

export function listAssignmentsForUser(userId: string): FieldAssignment[] {
  return getDb()
    .prepare("SELECT * FROM field_assignments WHERE user_id = ? AND active = 1")
    .all(userId)
    .map((r) => toAssignment(r as Row));
}

export function deactivateAssignment(id: string): void {
  getDb().prepare("UPDATE field_assignments SET active = 0 WHERE id = ?").run(id);
}

// ---------- config snapshots & audit ----------

export function insertConfigSnapshot(c: ConfigSnapshot): void {
  getDb()
    .prepare(
      `INSERT INTO config_snapshots (id, project_id, version, hash, data,
         reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(c.id, c.projectId, c.version, c.hash, c.data, c.reason, c.createdBy, c.createdAt);
}

export function listConfigSnapshots(projectId: string): ConfigSnapshot[] {
  return getDb()
    .prepare("SELECT * FROM config_snapshots WHERE project_id = ? ORDER BY version")
    .all(projectId)
    .map((r) => {
      const row = r as Row;
      return {
        id: row.id as string,
        projectId: row.project_id as string,
        version: row.version as number,
        hash: row.hash as string,
        data: row.data as string,
        reason: row.reason as string,
        createdBy: row.created_by as string,
        createdAt: row.created_at as string,
      };
    });
}

export function insertConfigAudit(e: ConfigAuditEntry): void {
  getDb()
    .prepare(
      `INSERT INTO config_audit (id, project_id, actor_user_id, action,
         entity_type, entity_id, reason, before_summary, after_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.projectId, e.actorUserId, e.action, e.entityType, e.entityId,
      e.reason, e.beforeSummary, e.afterSummary, e.createdAt
    );
}

export function listConfigAudit(projectId: string | null, limit = 100): ConfigAuditEntry[] {
  const rows = projectId
    ? getDb()
        .prepare("SELECT * FROM config_audit WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(projectId, limit)
    : getDb().prepare("SELECT * FROM config_audit ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map((r) => {
    const row = r as Row;
    return {
      id: row.id as string,
      projectId: (row.project_id as string) ?? null,
      actorUserId: row.actor_user_id as string,
      action: row.action as string,
      entityType: row.entity_type as string,
      entityId: row.entity_id as string,
      reason: (row.reason as string) ?? null,
      beforeSummary: (row.before_summary as string) ?? null,
      afterSummary: (row.after_summary as string) ?? null,
      createdAt: row.created_at as string,
    };
  });
}

// ---------- pilot metric targets ----------

export function upsertMetricTarget(t: PilotMetricTarget): void {
  getDb()
    .prepare(
      `INSERT INTO pilot_metric_targets (id, project_id, metric, target, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(t.id, t.projectId, t.metric, t.target, t.createdBy, t.createdAt);
}

// ====================== construction draw requests (additive) ==========
// A Draw Request is a REQUEST FOR REVIEW. No function in this section can
// create approval records, ledger entries, or account events — the
// governed release path stays exclusively with the workflow orchestrator
// and the VirtualAccountService.

function toDrawRequest(r: Row): DrawRequest {
  return {
    id: r.id as string,
    organizationId: r.organization_id as string,
    projectId: r.project_id as string,
    drawNumber: r.draw_number as number,
    requestedByUserId: (r.requested_by_user_id as string) ?? null,
    requestedByOrganizationId: (r.requested_by_organization_id as string) ?? null,
    submittedAt: (r.submitted_at as string) ?? null,
    requestedAmount: r.requested_amount as number,
    approvedAmount: (r.approved_amount as number) ?? null,
    recommendedAmount: (r.recommended_amount as number) ?? null,
    currency: (r.currency as string) ?? "USD",
    periodStart: (r.period_start as string) ?? null,
    periodEnd: (r.period_end as string) ?? null,
    status: r.status as DrawRequest["status"],
    reviewRecommendation: (r.review_recommendation as DrawRequest["reviewRecommendation"]) ?? null,
    reviewSummary: (r.review_summary as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertDrawRequest(d: DrawRequest): void {
  getDb()
    .prepare(
      `INSERT INTO draw_requests (id, organization_id, project_id, draw_number,
         requested_by_user_id, requested_by_organization_id, submitted_at,
         requested_amount, approved_amount, recommended_amount, currency,
         period_start, period_end, status, review_recommendation,
         review_summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.id, d.organizationId, d.projectId, d.drawNumber,
      d.requestedByUserId, d.requestedByOrganizationId, d.submittedAt,
      d.requestedAmount, d.approvedAmount, d.recommendedAmount, d.currency,
      d.periodStart, d.periodEnd, d.status, d.reviewRecommendation,
      d.reviewSummary, d.createdAt, d.updatedAt
    );
}

export function getDrawRequest(id: string): DrawRequest | null {
  const r = getDb().prepare("SELECT * FROM draw_requests WHERE id = ?").get(id);
  return r ? toDrawRequest(r as Row) : null;
}

export function listDrawRequests(): DrawRequest[] {
  return getDb()
    .prepare("SELECT * FROM draw_requests ORDER BY created_at DESC")
    .all()
    .map((r) => toDrawRequest(r as Row));
}

export function listDrawRequestsForProject(projectId: string): DrawRequest[] {
  return getDb()
    .prepare("SELECT * FROM draw_requests WHERE project_id = ? ORDER BY draw_number")
    .all(projectId)
    .map((r) => toDrawRequest(r as Row));
}

export function nextDrawNumber(projectId: string): number {
  const r = getDb()
    .prepare("SELECT COALESCE(MAX(draw_number), 0) AS m FROM draw_requests WHERE project_id = ?")
    .get(projectId) as Row;
  return (r.m as number) + 1;
}

/**
 * Persistence-level field update. Status transitions are validated in the
 * draw service / orchestrator — routes never call this directly with a
 * status, so direct mutation cannot bypass workflow rules.
 */
export function updateDrawRequest(
  id: string,
  patch: Partial<
    Pick<
      DrawRequest,
      | "requestedAmount" | "approvedAmount" | "recommendedAmount" | "currency"
      | "periodStart" | "periodEnd" | "status" | "reviewRecommendation"
      | "reviewSummary" | "submittedAt" | "requestedByUserId"
      | "requestedByOrganizationId" | "drawNumber"
    >
  >
): void {
  const cur = getDrawRequest(id);
  if (!cur) return;
  getDb()
    .prepare(
      `UPDATE draw_requests SET draw_number = ?, requested_by_user_id = ?,
         requested_by_organization_id = ?, submitted_at = ?, requested_amount = ?,
         approved_amount = ?, recommended_amount = ?, currency = ?,
         period_start = ?, period_end = ?, status = ?, review_recommendation = ?,
         review_summary = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      patch.drawNumber ?? cur.drawNumber,
      patch.requestedByUserId !== undefined ? patch.requestedByUserId : cur.requestedByUserId,
      patch.requestedByOrganizationId !== undefined
        ? patch.requestedByOrganizationId
        : cur.requestedByOrganizationId,
      patch.submittedAt !== undefined ? patch.submittedAt : cur.submittedAt,
      patch.requestedAmount ?? cur.requestedAmount,
      patch.approvedAmount !== undefined ? patch.approvedAmount : cur.approvedAmount,
      patch.recommendedAmount !== undefined ? patch.recommendedAmount : cur.recommendedAmount,
      patch.currency ?? cur.currency,
      patch.periodStart !== undefined ? patch.periodStart : cur.periodStart,
      patch.periodEnd !== undefined ? patch.periodEnd : cur.periodEnd,
      patch.status ?? cur.status,
      patch.reviewRecommendation !== undefined ? patch.reviewRecommendation : cur.reviewRecommendation,
      patch.reviewSummary !== undefined ? patch.reviewSummary : cur.reviewSummary,
      new Date().toISOString(),
      id
    );
}

// ---------- draw line items ----------

function toDrawLine(r: Row): DrawLineItem {
  const previouslyPaid = r.previously_paid as number;
  const currentRequested = r.current_requested as number;
  const materialsStored = (r.materials_stored as number) ?? null;
  const scheduledValue = r.scheduled_value as number;
  const status = r.status as DrawLineItem["status"];
  const supportedAmount = (r.supported_amount as number) ?? null;
  // Derived pay-application arithmetic (computed, never stored):
  const totalCompletedAndStored = previouslyPaid + currentRequested + (materialsStored ?? 0);
  const supportedFor =
    status === "SUPPORTED"
      ? currentRequested
      : status === "PARTIALLY_SUPPORTED"
        ? supportedAmount ?? 0
        : status === "PENDING"
          ? null
          : 0; // EXCEPTION / REJECTED
  const varianceAmount = supportedFor === null ? null : currentRequested - supportedFor;
  return {
    id: r.id as string,
    drawRequestId: r.draw_request_id as string,
    sort: r.sort as number,
    budgetLineId: (r.budget_line_id as string) ?? null,
    milestoneId: (r.milestone_id as string) ?? null,
    description: r.description as string,
    scheduledValue,
    previouslyPaid,
    currentRequested,
    materialsStored,
    retainageAmount: (r.retainage_amount as number) ?? null,
    percentCompleteClaimed: (r.percent_complete_claimed as number) ?? null,
    percentCompleteVerified: (r.percent_complete_verified as number) ?? null,
    supportedAmount,
    status,
    reviewNotes: (r.review_notes as string) ?? null,
    reviewedByUserId: (r.reviewed_by_user_id as string) ?? null,
    reviewedAt: (r.reviewed_at as string) ?? null,
    totalCompletedAndStored,
    balanceToFinish: scheduledValue - totalCompletedAndStored,
    varianceAmount,
    variancePercent:
      varianceAmount !== null && currentRequested > 0
        ? Math.round((varianceAmount / currentRequested) * 1000) / 10
        : null,
  };
}

export function insertDrawLine(l: DrawLineItem): void {
  getDb()
    .prepare(
      `INSERT INTO draw_line_items (id, draw_request_id, sort, budget_line_id,
         milestone_id, description, scheduled_value, previously_paid,
         current_requested, materials_stored, retainage_amount,
         percent_complete_claimed, percent_complete_verified, supported_amount,
         status, review_notes, reviewed_by_user_id, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      l.id, l.drawRequestId, l.sort, l.budgetLineId, l.milestoneId,
      l.description, l.scheduledValue, l.previouslyPaid, l.currentRequested,
      l.materialsStored, l.retainageAmount, l.percentCompleteClaimed,
      l.percentCompleteVerified, l.supportedAmount, l.status, l.reviewNotes,
      l.reviewedByUserId, l.reviewedAt
    );
}

export function getDrawLine(id: string): DrawLineItem | null {
  const r = getDb().prepare("SELECT * FROM draw_line_items WHERE id = ?").get(id);
  return r ? toDrawLine(r as Row) : null;
}

export function listDrawLines(drawRequestId: string): DrawLineItem[] {
  return getDb()
    .prepare("SELECT * FROM draw_line_items WHERE draw_request_id = ? ORDER BY sort, rowid")
    .all(drawRequestId)
    .map((r) => toDrawLine(r as Row));
}

export function updateDrawLine(
  id: string,
  patch: Partial<
    Pick<
      DrawLineItem,
      | "sort" | "budgetLineId" | "milestoneId" | "description" | "scheduledValue"
      | "previouslyPaid" | "currentRequested" | "materialsStored"
      | "retainageAmount" | "percentCompleteClaimed" | "percentCompleteVerified"
      | "supportedAmount" | "status" | "reviewNotes" | "reviewedByUserId" | "reviewedAt"
    >
  >
): void {
  const cur = getDrawLine(id);
  if (!cur) return;
  const v = <K extends keyof typeof patch>(k: K) =>
    patch[k] !== undefined ? patch[k] : (cur as never as typeof patch)[k];
  getDb()
    .prepare(
      `UPDATE draw_line_items SET sort = ?, budget_line_id = ?, milestone_id = ?,
         description = ?, scheduled_value = ?, previously_paid = ?,
         current_requested = ?, materials_stored = ?, retainage_amount = ?,
         percent_complete_claimed = ?, percent_complete_verified = ?,
         supported_amount = ?, status = ?, review_notes = ?,
         reviewed_by_user_id = ?, reviewed_at = ?
       WHERE id = ?`
    )
    .run(
      v("sort") ?? 0, v("budgetLineId") ?? null, v("milestoneId") ?? null,
      v("description") ?? "", v("scheduledValue") ?? 0, v("previouslyPaid") ?? 0,
      v("currentRequested") ?? 0, v("materialsStored") ?? null,
      v("retainageAmount") ?? null, v("percentCompleteClaimed") ?? null,
      v("percentCompleteVerified") ?? null, v("supportedAmount") ?? null,
      v("status") ?? "PENDING", v("reviewNotes") ?? null,
      v("reviewedByUserId") ?? null, v("reviewedAt") ?? null, id
    );
}

export function deleteDrawLine(id: string): void {
  getDb().prepare("DELETE FROM draw_evidence_links WHERE line_item_id = ?").run(id);
  getDb().prepare("UPDATE draw_documents SET line_item_id = NULL WHERE line_item_id = ?").run(id);
  getDb().prepare("DELETE FROM draw_line_items WHERE id = ?").run(id);
}

// ---------- draw document requirements & documents ----------

function toDrawRequirement(r: Row): DrawDocumentRequirement {
  return {
    id: r.id as string,
    drawRequestId: r.draw_request_id as string,
    sort: r.sort as number,
    docType: r.doc_type as DrawDocumentRequirement["docType"],
    title: r.title as string,
    required: Boolean(r.required),
    notes: (r.notes as string) ?? null,
  };
}

export function insertDrawRequirement(req: DrawDocumentRequirement): void {
  getDb()
    .prepare(
      `INSERT INTO draw_document_requirements (id, draw_request_id, sort, doc_type, title, required, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.id, req.drawRequestId, req.sort, req.docType, req.title, req.required ? 1 : 0, req.notes);
}

export function getDrawRequirement(id: string): DrawDocumentRequirement | null {
  const r = getDb().prepare("SELECT * FROM draw_document_requirements WHERE id = ?").get(id);
  return r ? toDrawRequirement(r as Row) : null;
}

export function listDrawRequirements(drawRequestId: string): DrawDocumentRequirement[] {
  return getDb()
    .prepare("SELECT * FROM draw_document_requirements WHERE draw_request_id = ? ORDER BY sort, rowid")
    .all(drawRequestId)
    .map((r) => toDrawRequirement(r as Row));
}

export function deleteDrawRequirement(id: string): void {
  getDb().prepare("UPDATE draw_documents SET requirement_id = NULL WHERE requirement_id = ?").run(id);
  getDb().prepare("DELETE FROM draw_document_requirements WHERE id = ?").run(id);
}

function toDrawDocument(r: Row): DrawDocument {
  return {
    id: r.id as string,
    drawRequestId: r.draw_request_id as string,
    requirementId: (r.requirement_id as string) ?? null,
    lineItemId: (r.line_item_id as string) ?? null,
    docType: r.doc_type as DrawDocument["docType"],
    title: r.title as string,
    filePath: (r.file_path as string) ?? null,
    note: (r.note as string) ?? null,
    status: r.status as DrawDocument["status"],
    expiresAt: (r.expires_at as string) ?? null,
    uploadedByUserId: (r.uploaded_by_user_id as string) ?? null,
    receivedAt: r.received_at as string,
    reviewedByUserId: (r.reviewed_by_user_id as string) ?? null,
    reviewedAt: (r.reviewed_at as string) ?? null,
    reviewNote: (r.review_note as string) ?? null,
  };
}

export function insertDrawDocument(d: DrawDocument): void {
  getDb()
    .prepare(
      `INSERT INTO draw_documents (id, draw_request_id, requirement_id,
         line_item_id, doc_type, title, file_path, note, status, expires_at,
         uploaded_by_user_id, received_at, reviewed_by_user_id, reviewed_at, review_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.id, d.drawRequestId, d.requirementId, d.lineItemId, d.docType,
      d.title, d.filePath, d.note, d.status, d.expiresAt, d.uploadedByUserId,
      d.receivedAt, d.reviewedByUserId, d.reviewedAt, d.reviewNote
    );
}

export function getDrawDocument(id: string): DrawDocument | null {
  const r = getDb().prepare("SELECT * FROM draw_documents WHERE id = ?").get(id);
  return r ? toDrawDocument(r as Row) : null;
}

export function listDrawDocuments(drawRequestId: string): DrawDocument[] {
  return getDb()
    .prepare("SELECT * FROM draw_documents WHERE draw_request_id = ? ORDER BY received_at, rowid")
    .all(drawRequestId)
    .map((r) => toDrawDocument(r as Row));
}

export function updateDrawDocument(
  id: string,
  patch: Partial<Pick<DrawDocument, "status" | "reviewedByUserId" | "reviewedAt" | "reviewNote" | "requirementId" | "lineItemId">>
): void {
  const cur = getDrawDocument(id);
  if (!cur) return;
  getDb()
    .prepare(
      `UPDATE draw_documents SET status = ?, reviewed_by_user_id = ?,
         reviewed_at = ?, review_note = ?, requirement_id = ?, line_item_id = ?
       WHERE id = ?`
    )
    .run(
      patch.status ?? cur.status,
      patch.reviewedByUserId !== undefined ? patch.reviewedByUserId : cur.reviewedByUserId,
      patch.reviewedAt !== undefined ? patch.reviewedAt : cur.reviewedAt,
      patch.reviewNote !== undefined ? patch.reviewNote : cur.reviewNote,
      patch.requirementId !== undefined ? patch.requirementId : cur.requirementId,
      patch.lineItemId !== undefined ? patch.lineItemId : cur.lineItemId,
      id
    );
}

// ---------- draw evidence links ----------

function toDrawEvidenceLink(r: Row): DrawEvidenceLink {
  return {
    id: r.id as string,
    drawRequestId: r.draw_request_id as string,
    lineItemId: (r.line_item_id as string) ?? null,
    evidenceItemId: r.evidence_item_id as string,
    note: (r.note as string) ?? null,
    linkedByUserId: r.linked_by_user_id as string,
    createdAt: r.created_at as string,
  };
}

export function insertDrawEvidenceLink(l: DrawEvidenceLink): void {
  getDb()
    .prepare(
      `INSERT INTO draw_evidence_links (id, draw_request_id, line_item_id,
         evidence_item_id, note, linked_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(l.id, l.drawRequestId, l.lineItemId, l.evidenceItemId, l.note, l.linkedByUserId, l.createdAt);
}

export function getDrawEvidenceLink(id: string): DrawEvidenceLink | null {
  const r = getDb().prepare("SELECT * FROM draw_evidence_links WHERE id = ?").get(id);
  return r ? toDrawEvidenceLink(r as Row) : null;
}

export function listDrawEvidenceLinks(drawRequestId: string): DrawEvidenceLink[] {
  return getDb()
    .prepare("SELECT * FROM draw_evidence_links WHERE draw_request_id = ? ORDER BY created_at, rowid")
    .all(drawRequestId)
    .map((r) => toDrawEvidenceLink(r as Row));
}

export function deleteDrawEvidenceLink(id: string): void {
  getDb().prepare("DELETE FROM draw_evidence_links WHERE id = ?").run(id);
}

// ---------- draw events (operational timeline) ----------

export function insertDrawEvent(e: DrawEvent): void {
  getDb()
    .prepare(
      `INSERT INTO draw_events (id, draw_request_id, type, detail, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.drawRequestId, e.type, e.detail, e.actorUserId, e.createdAt);
}

export function listDrawEvents(drawRequestId: string): DrawEvent[] {
  return getDb()
    .prepare("SELECT * FROM draw_events WHERE draw_request_id = ? ORDER BY created_at, rowid")
    .all(drawRequestId)
    .map((r) => ({
      id: r.id as string,
      drawRequestId: r.draw_request_id as string,
      type: r.type as DrawEvent["type"],
      detail: r.detail as string,
      actorUserId: (r.actor_user_id as string) ?? null,
      createdAt: r.created_at as string,
    }));
}

// ---------- draw account events (written ONLY by VirtualAccountService) --

export function insertDrawAccountEvent(e: DrawAccountEvent): void {
  getDb()
    .prepare(
      `INSERT INTO draw_account_events (id, draw_request_id, type, amount, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(e.id, e.drawRequestId, e.type, e.amount, e.createdAt);
}

export function listDrawAccountEvents(drawRequestId: string): DrawAccountEvent[] {
  return getDb()
    .prepare("SELECT * FROM draw_account_events WHERE draw_request_id = ? ORDER BY created_at")
    .all(drawRequestId)
    .map((r) => ({
      id: r.id as string,
      drawRequestId: r.draw_request_id as string,
      type: r.type as DrawAccountEvent["type"],
      amount: r.amount as number,
      createdAt: r.created_at as string,
    }));
}

export function listMetricTargets(projectId: string | null): PilotMetricTarget[] {
  const rows = projectId
    ? getDb().prepare("SELECT * FROM pilot_metric_targets WHERE project_id = ?").all(projectId)
    : getDb().prepare("SELECT * FROM pilot_metric_targets").all();
  return rows.map((r) => {
    const row = r as Row;
    return {
      id: row.id as string,
      projectId: (row.project_id as string) ?? null,
      metric: row.metric as string,
      target: row.target as number,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
    };
  });
}
