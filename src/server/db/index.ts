/**
 * Database access — node:sqlite (built into Node >= 22.5).
 *
 * The npm registry is not reachable in this build environment, so Prisma
 * could not be installed. All SQL lives in this directory behind typed
 * repository functions (repo.ts), so the app layer never touches SQL.
 *
 * TODO: migrate to Prisma + Azure Database for PostgreSQL Flexible Server.
 *       The schema below maps one-to-one onto the entities in
 *       src/shared/types.ts, which the future Prisma schema should mirror.
 */
import "../env";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

// Storage roots. Everything the app writes lives under DATA_DIR:
//   obv.db (+ WAL/SHM), uploads/, worm/ (immutable evidence), reports/.
// On a hosted deployment, point OBV_DATA_DIR at a persistent volume mount
// (e.g. /var/data) to survive restarts; without it, data is relative to the
// working directory and the start command reseeds when the db is missing.
// OBV_REPORT_STORAGE_PATH optionally relocates generated report PDFs only.
export const DATA_DIR = process.env.OBV_DATA_DIR
  ? path.resolve(process.env.OBV_DATA_DIR)
  : path.join(process.cwd(), "data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const WORM_DIR = path.join(DATA_DIR, "worm");
export const REPORTS_DIR = process.env.OBV_REPORT_STORAGE_PATH
  ? path.resolve(process.env.OBV_REPORT_STORAGE_PATH)
  : path.join(DATA_DIR, "reports");
// Generated audit-package ZIPs (immutable once READY; write-once files).
export const AUDIT_PACKAGES_DIR = path.join(DATA_DIR, "audit-packages");
const DB_PATH = path.join(DATA_DIR, "obv.db");

let db: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('FUNDER_REP','PROJECT_MANAGER','COMPLIANCE_REVIEWER','FIELD')),
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  location TEXT NOT NULL,
  site_boundary TEXT NOT NULL, -- JSON: [[lng,lat], ...] closed ring geofence
  total_budget INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  project_type TEXT NOT NULL DEFAULT 'INFRASTRUCTURE'
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  requirement TEXT NOT NULL,
  tranche_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  account_status TEXT NOT NULL DEFAULT 'HELD'
);

CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  photo_path TEXT NOT NULL,
  latitude REAL,   -- null = no usable GPS fix (geofence check goes to REVIEW)
  longitude REAL,
  captured_at TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  device_metadata TEXT NOT NULL, -- JSON DeviceMetadata
  hash TEXT NOT NULL,
  previous_hash TEXT,
  is_demo_fallback INTEGER NOT NULL DEFAULT 0,
  submission_key TEXT -- content-derived retry-dedupe key (null on seeded rows)
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  evidence_item_id TEXT NOT NULL REFERENCES evidence_items(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('VERIFIED','NEEDS_REVIEW','REJECTED')),
  confidence REAL NOT NULL,
  checks TEXT NOT NULL,   -- JSON VerificationCheck[]
  reasoning TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'MOCK_DEFAULT' -- LIVE_AI | MOCK_FALLBACK | MOCK_DEFAULT
);

-- Append-only, hash-chained evidence ledger. Never UPDATE or DELETE rows.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  evidence_item_id TEXT NOT NULL REFERENCES evidence_items(id),
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  verification_id TEXT NOT NULL REFERENCES verifications(id),
  timestamp TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  current_hash TEXT NOT NULL
);

-- Approval requests govern MILESTONE tranches (original workflow) or
-- lender DRAW requests (additive). Exactly one subject pointer is set.
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  milestone_id TEXT REFERENCES milestones(id),
  draw_request_id TEXT REFERENCES draw_requests(id),
  change_order_id TEXT REFERENCES change_orders(id),
  retainage_release_id TEXT REFERENCES retainage_release_requests(id),
  subject_type TEXT NOT NULL DEFAULT 'MILESTONE' CHECK (subject_type IN ('MILESTONE','DRAW','CHANGE_ORDER','RETAINAGE')),
  status TEXT NOT NULL DEFAULT 'PENDING',
  required_roles TEXT NOT NULL, -- JSON UserRole[]
  created_at TEXT NOT NULL,
  CHECK (
    (subject_type = 'MILESTONE' AND milestone_id IS NOT NULL) OR
    (subject_type = 'DRAW' AND draw_request_id IS NOT NULL) OR
    (subject_type = 'CHANGE_ORDER' AND change_order_id IS NOT NULL) OR
    (subject_type = 'RETAINAGE' AND retainage_release_id IS NOT NULL)
  )
);

-- Placeholder relationship for the full multi-role approval workflow
-- (populated in a later prompt).
CREATE TABLE IF NOT EXISTS approval_records (
  id TEXT PRIMARY KEY,
  approval_request_id TEXT NOT NULL REFERENCES approval_requests(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  decision TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS virtual_account_events (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  type TEXT NOT NULL CHECK (type IN ('HELD','RELEASED')),
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  project_id TEXT,
  milestone_id TEXT,
  delivery_mode TEXT NOT NULL DEFAULT 'MOCK',      -- TEAMS_WEBHOOK | MOCK
  delivery_status TEXT NOT NULL DEFAULT 'SKIPPED', -- SENT | FAILED | SKIPPED
  sent_at TEXT,
  failure_category TEXT                            -- sanitized, never secrets
);

CREATE TABLE IF NOT EXISTS demo_fallback_photos (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  path TEXT NOT NULL,
  label TEXT NOT NULL
);

-- Demonstration spatial geometry (route centerline + milestone segments).
-- Presentation-layer only: the map reads verification/governance state
-- from the primary tables; geometry never drives any decision.
CREATE TABLE IF NOT EXISTS spatial_features (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  milestone_id TEXT REFERENCES milestones(id),
  kind TEXT NOT NULL CHECK (kind IN ('ROUTE','SEGMENT')),
  label TEXT NOT NULL,
  geometry TEXT NOT NULL -- JSON [lng,lat][] polyline
);

-- Contextual project communications. Chat coordinates; it can NEVER
-- create approvals or move funds — no code path from these tables
-- reaches the approval workflow or VirtualAccountService.
CREATE TABLE IF NOT EXISTS conversation_threads (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  milestone_id TEXT REFERENCES milestones(id),
  evidence_item_id TEXT REFERENCES evidence_items(id),
  approval_request_id TEXT REFERENCES approval_requests(id),
  draw_request_id TEXT REFERENCES draw_requests(id),
  title TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('ORGANIZATION','PROJECT','MILESTONE','EVIDENCE','APPROVAL','DRAW')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id)
);

-- No UPDATE/DELETE is exposed for messages (no editing in the demo);
-- this is an auditable communications timeline, NOT the evidence ledger.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES conversation_threads(id),
  sender_user_id TEXT REFERENCES users(id),
  sender_display_name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'OBV' CHECK (provider IN ('OBV','TEAMS','WHATSAPP')),
  external_thread_id TEXT,
  external_message_id TEXT,
  body TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'TEXT',
  ref_id TEXT,
  created_at TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'SENT',
  origin TEXT NOT NULL DEFAULT 'OBV_LOCAL',    -- loop-prevention anchor
  edited_at TEXT,                              -- external edit audit
  original_body TEXT,                          -- preserved on first edit
  external_deleted INTEGER NOT NULL DEFAULT 0, -- deleted in provider (audit kept)
  attachments TEXT,                            -- JSON MessageAttachment[] (communication only)
  location TEXT                                -- JSON MessageLocation (communication context only)
);

-- Teams conversation-sync thread bindings. Identifiers only — NEVER
-- credentials, tokens or webhook secrets. One binding per OBV thread.
CREATE TABLE IF NOT EXISTS external_thread_bindings (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL UNIQUE REFERENCES conversation_threads(id),
  provider TEXT NOT NULL DEFAULT 'TEAMS',
  tenant_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_message_id TEXT,
  team_name TEXT,    -- display names captured after successful validation
  channel_name TEXT,
  subscription_id TEXT,
  subscription_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'CONNECTING' CHECK (status IN ('CONNECTING','ACTIVE','DEGRADED','DISCONNECTED','PERMISSION_REQUIRED')),
  last_sync_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Explicit external identity mapping (never inferred from display names).
CREATE TABLE IF NOT EXISTS external_identity_mappings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'TEAMS',
  tenant_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  obv_user_id TEXT REFERENCES users(id),
  external_display_name TEXT NOT NULL,
  external_email TEXT,
  status TEXT NOT NULL DEFAULT 'UNMAPPED' CHECK (status IN ('MAPPED','UNMAPPED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, tenant_id, external_user_id)
);

-- WhatsApp/Teams participant context: which project/thread an external
-- participant's inbound messages belong to. EXPLICIT assignment only.
CREATE TABLE IF NOT EXISTS external_participant_contexts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'WHATSAPP',
  external_user_id TEXT NOT NULL,
  active_project_id TEXT REFERENCES projects(id),
  active_thread_id TEXT REFERENCES conversation_threads(id),
  active_milestone_id TEXT REFERENCES milestones(id),
  last_inbound_at TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, external_user_id)
);

-- Operational field issues. Informational for humans — no code path
-- from these tables reaches approvals or the virtual account.
CREATE TABLE IF NOT EXISTS field_issues (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  milestone_id TEXT REFERENCES milestones(id),
  evidence_item_id TEXT REFERENCES evidence_items(id),
  source_thread_id TEXT REFERENCES conversation_threads(id),
  source_message_id TEXT REFERENCES messages(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('QUALITY','SAFETY','MATERIAL','SCHEDULE','ACCESS','ENVIRONMENTAL','DOCUMENTATION','EQUIPMENT','OTHER')),
  severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','AWAITING_FIELD_RESPONSE','RESOLVED','CLOSED')),
  reported_by_user_id TEXT REFERENCES users(id),
  reported_by_external_identity_id TEXT,
  assigned_to_user_id TEXT REFERENCES users(id),
  latitude REAL,
  longitude REAL,
  due_at TEXT,
  resolved_at TEXT,
  resolution_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Field-issue operational timeline (NOT the Evidence Ledger).
CREATE TABLE IF NOT EXISTS field_issue_events (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES field_issues(id),
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Formal reviewer clarification requests. A response NEVER auto-accepts.
CREATE TABLE IF NOT EXISTS clarification_requests (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  evidence_item_id TEXT REFERENCES evidence_items(id),
  question TEXT NOT NULL,
  response_type TEXT NOT NULL CHECK (response_type IN ('TEXT','PHOTO','DOCUMENT','LOCATION','SITE_REVISIT')),
  due_at TEXT,
  assigned_to_user_id TEXT REFERENCES users(id),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESPONDED','ACCEPTED','REOPENED','CLOSED')),
  response_message_id TEXT REFERENCES messages(id),
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Governed evidence drafts promoted from communication media. A draft
-- is not evidence; explicit submission runs the NORMAL pipeline.
CREATE TABLE IF NOT EXISTS evidence_drafts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  source_message_id TEXT NOT NULL REFERENCES messages(id),
  source_attachment_index INTEGER NOT NULL DEFAULT 0,
  media_path TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  source_timestamp TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  location_source_message_id TEXT REFERENCES messages(id),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','DISCARDED')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  evidence_item_id TEXT REFERENCES evidence_items(id)
);

-- Generated funder-report artifacts (PDFs stored under data/reports/).
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  report_type TEXT NOT NULL DEFAULT 'VERIFICATION_FUND_RELEASE',
  filename TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  generated_by TEXT NOT NULL REFERENCES users(id),
  integrity_status TEXT NOT NULL, -- 'INTACT' or 'TAMPERED_AT:<seq>'
  ledger_entries INTEGER NOT NULL
);

-- ====================== pilot onboarding (additive) ======================
-- Configuration entities only. Nothing below creates evidence, approvals,
-- ledger entries, or release state.

-- Pilot-grade invitations: raw token shown once, only sha256 stored.
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL,
  project_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | ACCEPTED | REVOKED | EXPIRED
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_user_id TEXT,
  revoked_at TEXT
);

-- Configured evidence expectations per milestone (drives the field
-- checklist and readiness display; never verifies anything itself).
CREATE TABLE IF NOT EXISTS evidence_requirements (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  sort INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 1,
  min_count INTEGER NOT NULL DEFAULT 1,
  media_types TEXT NOT NULL DEFAULT '[]', -- JSON string[]
  geolocation_required INTEGER NOT NULL DEFAULT 0,
  recency_days INTEGER,
  notes TEXT
);

-- CUSTOMER POLICY (bounded overrides). Hard integrity rules are not here.
CREATE TABLE IF NOT EXISTS verification_policies (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  ai_confidence_threshold REAL,
  geofence_policy TEXT, -- STRICT | STANDARD | EXTENDED_REVIEW
  recency_days INTEGER,
  offline_allowance_days INTEGER,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- Approval matrix: required roles per milestone (milestone_id NULL =
-- project default). Feeds ApprovalRequest.required_roles at creation.
CREATE TABLE IF NOT EXISTS approval_policies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  milestone_id TEXT,
  required_roles TEXT NOT NULL, -- JSON UserRole[]
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  UNIQUE (project_id, milestone_id)
);

CREATE TABLE IF NOT EXISTS field_assignments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  milestone_ids TEXT NOT NULL DEFAULT '[]', -- JSON; empty = all milestones
  effective_from TEXT,
  effective_to TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Immutable configuration snapshots (launch + audited changes).
-- Separate from the Evidence Ledger.
CREATE TABLE IF NOT EXISTS config_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  data TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, version)
);

-- Configuration audit trail (administrative record, NOT the Evidence
-- Ledger).
CREATE TABLE IF NOT EXISTS config_audit (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  reason TEXT,
  before_summary TEXT,
  after_summary TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pilot_metric_targets (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  metric TEXT NOT NULL,
  target REAL NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ====================== construction draw requests (additive) ==========
-- A DRAW REQUEST IS A REQUEST FOR REVIEW — nothing in these tables can
-- move money. Release eligibility exists only through approval_requests
-- (subject_type DRAW) + approval_records, and the release transition is
-- recorded exactly once in draw_account_events by the
-- VirtualAccountService from the completed-governance orchestrator path.

CREATE TABLE IF NOT EXISTS draw_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  draw_number INTEGER NOT NULL,
  requested_by_user_id TEXT REFERENCES users(id),
  requested_by_organization_id TEXT REFERENCES organizations(id),
  submitted_at TEXT,
  requested_amount INTEGER NOT NULL DEFAULT 0,
  approved_amount INTEGER,
  recommended_amount INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  period_start TEXT,
  period_end TEXT,
  retainage_rate REAL,
  retainage_withheld INTEGER,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN
    ('DRAFT','SUBMITTED','UNDER_REVIEW','CLARIFICATION_REQUIRED',
     'READY_FOR_GOVERNANCE','PARTIALLY_APPROVED','APPROVED','RELEASED',
     'RETURNED','CANCELLED')),
  review_recommendation TEXT,
  review_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, draw_number)
);

CREATE TABLE IF NOT EXISTS draw_line_items (
  id TEXT PRIMARY KEY,
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  sort INTEGER NOT NULL DEFAULT 0,
  budget_line_id TEXT,
  milestone_id TEXT REFERENCES milestones(id),
  description TEXT NOT NULL,
  scheduled_value INTEGER NOT NULL DEFAULT 0,
  previously_paid INTEGER NOT NULL DEFAULT 0,
  current_requested INTEGER NOT NULL DEFAULT 0,
  materials_stored INTEGER,
  retainage_amount INTEGER,
  change_order_id TEXT,
  percent_complete_claimed REAL,
  percent_complete_verified REAL,
  supported_amount INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN
    ('PENDING','SUPPORTED','PARTIALLY_SUPPORTED','EXCEPTION','REJECTED')),
  review_notes TEXT,
  reviewed_by_user_id TEXT REFERENCES users(id),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS draw_document_requirements (
  id TEXT PRIMARY KEY,
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  sort INTEGER NOT NULL DEFAULT 0,
  doc_type TEXT NOT NULL,
  title TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);

-- A document on file is an administrative record, never verified
-- physical progress.
CREATE TABLE IF NOT EXISTS draw_documents (
  id TEXT PRIMARY KEY,
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  requirement_id TEXT REFERENCES draw_document_requirements(id),
  line_item_id TEXT REFERENCES draw_line_items(id),
  doc_type TEXT NOT NULL,
  title TEXT NOT NULL,
  file_path TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN
    ('RECEIVED','ACCEPTED','REJECTED','EXPIRED')),
  expires_at TEXT,
  uploaded_by_user_id TEXT REFERENCES users(id),
  received_at TEXT NOT NULL,
  reviewed_by_user_id TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT
);

-- Links to EXISTING governed evidence records only. Linking never copies,
-- re-verifies, or alters an EvidenceItem or its ledger entry.
CREATE TABLE IF NOT EXISTS draw_evidence_links (
  id TEXT PRIMARY KEY,
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  line_item_id TEXT REFERENCES draw_line_items(id),
  evidence_item_id TEXT NOT NULL REFERENCES evidence_items(id),
  note TEXT,
  linked_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Draw operational timeline (administrative record, NOT the Evidence
-- Ledger).
CREATE TABLE IF NOT EXISTS draw_events (
  id TEXT PRIMARY KEY,
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Draw-scoped virtual account events, written ONLY by the
-- VirtualAccountService. UNIQUE(draw_request_id, type) makes the
-- governed release transition exactly-once at the database level.
CREATE TABLE IF NOT EXISTS draw_account_events (
  id TEXT PRIMARY KEY,
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  type TEXT NOT NULL CHECK (type IN ('HELD','RELEASED')),
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (draw_request_id, type)
);

-- ============== budget vs verified physical progress (additive) ========
-- Financial-control records only. Nothing here can create evidence,
-- verifications, approvals, ledger entries, or account events. current
-- budget is DERIVED (original + approved changes) and post-launch changes
-- go through the audited change-control path (reason + audit + snapshot).

CREATE TABLE IF NOT EXISTS budget_lines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  code TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  original_budget INTEGER NOT NULL DEFAULT 0,
  approved_changes INTEGER NOT NULL DEFAULT 0,
  committed_amount INTEGER,
  paid_to_date INTEGER NOT NULL DEFAULT 0,
  retainage_held INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  sequence INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, code)
);

-- Optional mapping of budget lines to milestones / evidence requirements
-- (draw line items map via DrawLineItem.budget_line_id = code or id).
CREATE TABLE IF NOT EXISTS budget_line_maps (
  id TEXT PRIMARY KEY,
  budget_line_id TEXT NOT NULL REFERENCES budget_lines(id),
  milestone_id TEXT REFERENCES milestones(id),
  evidence_requirement_id TEXT REFERENCES evidence_requirements(id),
  created_at TEXT NOT NULL,
  CHECK (milestone_id IS NOT NULL OR evidence_requirement_id IS NOT NULL)
);

-- Explicit reviewed partial-progress records. NEVER inferred: entered by
-- an authorized reviewer, with a reason, referencing VERIFIED evidence of
-- the same milestone. New rows supersede old ones (history kept).
CREATE TABLE IF NOT EXISTS verified_quantities (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  percent REAL NOT NULL CHECK (percent > 0 AND percent < 100),
  quantity_label TEXT NOT NULL,
  evidence_item_id TEXT NOT NULL REFERENCES evidence_items(id),
  reason TEXT NOT NULL,
  entered_by_user_id TEXT NOT NULL REFERENCES users(id),
  superseded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);


-- ================= unified exception management (additive) =============
-- Control records referencing authoritative source records. Nothing here
-- can create evidence, verifications, approvals, ledger entries, or
-- account events. UNIQUE(source_key) makes deterministic auto-creation
-- idempotent at the database level.
CREATE TABLE IF NOT EXISTS exceptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  milestone_id TEXT REFERENCES milestones(id),
  draw_request_id TEXT REFERENCES draw_requests(id),
  budget_line_id TEXT REFERENCES budget_lines(id),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN
    ('EVIDENCE','DOCUMENT','LOCATION','METADATA','QUALITY','MATERIAL',
     'COST','SCHEDULE','APPROVAL','CLARIFICATION','INTEGRITY','INTEGRATION','OTHER')),
  severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN
    ('OPEN','ACKNOWLEDGED','IN_PROGRESS','AWAITING_RESPONSE','RESOLVED','CLOSED','WAIVED')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT REFERENCES users(id),
  due_at TEXT,
  opened_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT,
  resolution_summary TEXT,
  resolution_type TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Exception operational timeline (administrative record, NOT the
-- Evidence Ledger — never merged with it).
CREATE TABLE IF NOT EXISTS exception_events (
  id TEXT PRIMARY KEY,
  exception_id TEXT NOT NULL REFERENCES exceptions(id),
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);


-- ============== change orders + retainage (additive) ===================
-- A submitted change order NEVER changes configuration; only formal
-- approval applies it (transactionally, audited, snapshotted). Retainage
-- state changes only inside governed transitions via VirtualAccountService.

CREATE TABLE IF NOT EXISTS change_orders (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  change_order_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reason_category TEXT NOT NULL CHECK (reason_category IN
    ('OWNER_REQUEST','DESIGN_CHANGE','SITE_CONDITION','MATERIAL_CHANGE',
     'SCOPE_CHANGE','REGULATORY','SCHEDULE','CORRECTION','OTHER')),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  requested_at TEXT,
  requested_amount INTEGER NOT NULL DEFAULT 0,
  approved_amount INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  schedule_impact_days INTEGER,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN
    ('DRAFT','SUBMITTED','UNDER_REVIEW','CLARIFICATION_REQUIRED','APPROVED',
     'PARTIALLY_APPROVED','REJECTED','CANCELLED','IMPLEMENTED')),
  affected_milestone_ids TEXT NOT NULL DEFAULT '[]',
  affected_budget_line_ids TEXT NOT NULL DEFAULT '[]',
  applied_at TEXT,
  applied_snapshot_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, change_order_number)
);

CREATE TABLE IF NOT EXISTS change_order_allocations (
  id TEXT PRIMARY KEY,
  change_order_id TEXT NOT NULL REFERENCES change_orders(id),
  budget_line_id TEXT NOT NULL REFERENCES budget_lines(id),
  amount INTEGER NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS change_order_documents (
  id TEXT PRIMARY KEY,
  change_order_id TEXT NOT NULL REFERENCES change_orders(id),
  title TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'OTHER',
  note TEXT,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS change_order_events (
  id TEXT PRIMARY KEY,
  change_order_id TEXT NOT NULL REFERENCES change_orders(id),
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Retainage policy: clamped percent; no row = 0% (never silent).
CREATE TABLE IF NOT EXISTS retainage_policies (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  retainage_percent REAL NOT NULL DEFAULT 0,
  required_conditions TEXT NOT NULL DEFAULT '[]', -- JSON RetainageConditionType[]
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS retainage_release_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_CONDITIONS' CHECK (status IN
    ('PENDING_CONDITIONS','READY_FOR_GOVERNANCE','APPROVED','RELEASED','RETURNED','CANCELLED')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retainage_conditions (
  id TEXT PRIMARY KEY,
  release_request_id TEXT NOT NULL REFERENCES retainage_release_requests(id),
  condition TEXT NOT NULL,
  satisfied INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  satisfied_by_user_id TEXT REFERENCES users(id),
  satisfied_at TEXT,
  UNIQUE (release_request_id, condition)
);

-- Retainage financial-control events, written ONLY by the
-- VirtualAccountService from governed transitions. Uniqueness makes both
-- the per-draw withhold and the per-request release exactly-once.
CREATE TABLE IF NOT EXISTS retainage_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  draw_request_id TEXT REFERENCES draw_requests(id),
  retainage_release_id TEXT REFERENCES retainage_release_requests(id),
  type TEXT NOT NULL CHECK (type IN ('WITHHELD','RELEASED')),
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (draw_request_id, type),
  UNIQUE (retainage_release_id)
);

-- ==================== project audit packages (additive) =================
-- Generated auditor-ready export packages. Rows are control records; the
-- ZIP file is written once (immutable) under DATA_DIR/audit-packages/.
-- Nothing here can create evidence, approvals, ledger entries, or release
-- state — a package only ASSEMBLES and REFERENCES governed sources.
CREATE TABLE IF NOT EXISTS audit_packages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_version INTEGER NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN
    ('QUEUED','GENERATING','READY','FAILED','SUPERSEDED')),
  as_of_timestamp TEXT NOT NULL,
  configuration_version INTEGER NOT NULL,
  ledger_integrity_state TEXT NOT NULL DEFAULT 'NOT_EVALUATED',
  integrity_state TEXT NOT NULL DEFAULT 'NOT_EVALUATED' CHECK (integrity_state IN
    ('CLEAN','WARNINGS','NOT_EVALUATED')),
  integrity_critical INTEGER NOT NULL DEFAULT 0,
  manifest_hash TEXT,
  storage_object_key TEXT,
  completed_at TEXT,
  failure_category TEXT,
  include_reports INTEGER NOT NULL DEFAULT 1,
  include_comm_metadata INTEGER NOT NULL DEFAULT 0,
  include_evidence_media INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, package_version)
);

-- ==================== milestone completion gates (additive) =============
-- PHOTOGRAPHIC COMPLETION IS NOT LEGAL OR CONTRACTUAL COMPLETION.
-- Jurisdictional inspection requirement: one determined row per milestone;
-- ABSENCE of a row means UNKNOWN — never inferred as NOT_REQUIRED.
CREATE TABLE IF NOT EXISTS inspection_requirements (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  milestone_id TEXT NOT NULL UNIQUE REFERENCES milestones(id),
  requirement TEXT NOT NULL CHECK (requirement IN ('REQUIRED','NOT_REQUIRED')),
  requirement_basis TEXT NOT NULL,
  determined_by TEXT NOT NULL REFERENCES users(id),
  determined_at TEXT NOT NULL,
  jurisdiction TEXT,
  inspection_type TEXT,
  issuing_authority TEXT,
  must_pass_before_draw_review INTEGER NOT NULL DEFAULT 0,
  must_pass_before_governance INTEGER NOT NULL DEFAULT 1,
  final_completion_only INTEGER NOT NULL DEFAULT 0,
  result_document_required INTEGER NOT NULL DEFAULT 0,
  configuration_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Jurisdictional inspection records. A recorded document NEVER becomes
-- PASSED automatically: results are recorded by an attributable internal
-- reviewer; the government inspector is text, not an OBV identity.
CREATE TABLE IF NOT EXISTS jurisdictional_inspections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  permit_id TEXT,
  permit_ref_id TEXT REFERENCES permits(id),
  inspection_type TEXT,
  jurisdiction TEXT,
  issuing_authority TEXT,
  inspection_reference TEXT,
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'REQUIRED_UNSCHEDULED' CHECK (status IN
    ('REQUIRED_UNSCHEDULED','SCHEDULED','COMPLETED_PENDING_RESULT',
     'PASSED','FAILED','CORRECTIONS_REQUIRED','CANCELLED','EXPIRED')),
  scheduled_at TEXT,
  completed_at TEXT,
  result_recorded_at TEXT,
  result TEXT CHECK (result IN ('PASSED','FAILED','CORRECTIONS_REQUIRED')),
  government_inspector_name TEXT,
  reviewed_by_user_id TEXT REFERENCES users(id),
  supporting_document_id TEXT,
  reinspection_of_inspection_id TEXT REFERENCES jurisdictional_inspections(id),
  superseded_by_inspection_id TEXT REFERENCES jurisdictional_inspections(id),
  correction_notice_reference TEXT,
  correction_summary TEXT,
  correction_due_at TEXT,
  correction_cleared_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- First-class permit register. UNKNOWN status is never treated as ACTIVE.
-- Permit numbers are unique within a project (the tenancy scope of every
-- other project-child record in this model).
CREATE TABLE IF NOT EXISTS permits (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  permit_number TEXT NOT NULL,
  permit_type TEXT NOT NULL,
  issuing_authority TEXT,
  jurisdiction TEXT,
  status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN
    ('DRAFT','APPLIED','ISSUED','ACTIVE','SUSPENDED','EXPIRED','CLOSED','REVOKED','UNKNOWN')),
  issued_at TEXT,
  effective_at TEXT,
  expires_at TEXT,
  closed_at TEXT,
  scope_description TEXT,
  applicable_code_edition TEXT,
  code_effective_date TEXT,
  code_basis TEXT,
  code_determined_by TEXT REFERENCES users(id),
  code_determined_at TEXT,
  official_record_url TEXT,
  official_record_number TEXT,
  notes TEXT,
  legacy_reference TEXT,
  configuration_version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, permit_number)
);

-- Normalized permit <-> milestone relationship (never comma-separated ids;
-- never a duplicate active link).
CREATE TABLE IF NOT EXISTS permit_milestone_links (
  id TEXT PRIMARY KEY,
  permit_id TEXT NOT NULL REFERENCES permits(id),
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  scope_note TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (permit_id, milestone_id)
);

-- Official-source provenance. Supports reviewed results; never creates
-- them. The official system's status text is preserved verbatim,
-- separate from OBV's normalized statuses.
CREATE TABLE IF NOT EXISTS official_source_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  milestone_id TEXT REFERENCES milestones(id),
  permit_id TEXT REFERENCES permits(id),
  inspection_id TEXT REFERENCES jurisdictional_inspections(id),
  source_type TEXT NOT NULL CHECK (source_type IN
    ('OFFICIAL_PORTAL_LOOKUP','OFFICIAL_DOCUMENT','INSPECTION_REPORT',
     'EMAIL_FROM_AUTHORITY','MANUAL_OFFICIAL_REFERENCE','API_LOOKUP','OTHER')),
  official_system_name TEXT,
  official_record_number TEXT,
  official_record_url TEXT,
  lookup_performed_at TEXT,
  lookup_performed_by_user_id TEXT NOT NULL REFERENCES users(id),
  captured_at TEXT,
  official_status_text TEXT,
  source_document_path TEXT,
  source_artifact_hash TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- ================= lender-pilot operating layer (additive) ==============
-- Administrative lender records. Nothing here replaces the governed
-- verification/approval/release truth, and none of these tables is
-- reachable from VirtualAccountService.

CREATE TABLE IF NOT EXISTS loan_assets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  loan_number TEXT NOT NULL,
  property_address TEXT,
  property_type TEXT,
  borrower_organization_id TEXT REFERENCES organizations(id),
  primary_contractor_organization_id TEXT REFERENCES organizations(id),
  lender_organization_id TEXT REFERENCES organizations(id),
  original_loan_amount INTEGER,
  current_loan_amount INTEGER,
  original_construction_budget INTEGER,
  current_approved_construction_budget INTEGER,
  original_construction_reserve INTEGER,
  current_construction_reserve INTEGER,
  closing_date TEXT,
  estimated_construction_completion_date TEXT,
  original_maturity_date TEXT,
  current_maturity_date TEXT,
  servicing_system_name TEXT,
  servicing_system_reference TEXT,
  current_servicer_organization_id TEXT REFERENCES organizations(id),
  current_loan_owner_organization_id TEXT REFERENCES organizations(id),
  warehouse_lender_organization_id TEXT REFERENCES organizations(id),
  secondary_market_purchaser_organization_id TEXT REFERENCES organizations(id),
  occupancy_type TEXT,
  loan_purpose TEXT,
  risk_level TEXT NOT NULL DEFAULT 'UNRATED' CHECK (risk_level IN ('LOW','MEDIUM','HIGH','UNRATED')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAID_OFF','DEFAULTED','TRANSFERRED','CLOSED','UNKNOWN')),
  inspector_assigned_user_id TEXT REFERENCES users(id),
  lender_reviewer_assigned_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, loan_number)
);

CREATE TABLE IF NOT EXISTS loan_ownership_events (
  id TEXT PRIMARY KEY,
  loan_asset_id TEXT NOT NULL REFERENCES loan_assets(id),
  prior_owner_organization_id TEXT REFERENCES organizations(id),
  new_owner_organization_id TEXT NOT NULL REFERENCES organizations(id),
  effective_at TEXT NOT NULL,
  transfer_type TEXT,
  reference TEXT,
  recorded_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loan_servicing_events (
  id TEXT PRIMARY KEY,
  loan_asset_id TEXT NOT NULL REFERENCES loan_assets(id),
  prior_servicer_organization_id TEXT REFERENCES organizations(id),
  new_servicer_organization_id TEXT NOT NULL REFERENCES organizations(id),
  effective_at TEXT NOT NULL,
  reference TEXT,
  recorded_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_party_assignments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  party_organization_id TEXT NOT NULL REFERENCES organizations(id),
  party_type TEXT NOT NULL CHECK (party_type IN
    ('BORROWER','CONTRACTOR','LENDER','SERVICER','WAREHOUSE_LENDER',
     'SECONDARY_MARKET_PURCHASER','TITLE_COMPANY','INSPECTION_COMPANY',
     'GOVERNMENT_AUTHORITY','CONSULTANT','OTHER')),
  effective_from TEXT,
  effective_to TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  reference TEXT,
  notes TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jurisdiction_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  template_key TEXT NOT NULL DEFAULT 'OTHER',
  state TEXT,
  county_or_city TEXT,
  jurisdiction_name TEXT,
  permit_authority TEXT,
  permit_system_name TEXT,
  official_system_url TEXT,
  timezone TEXT,
  jurisdiction_code TEXT,
  notes TEXT,
  configured_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Independent lender-ordered draw inspections. NEVER the same record or
-- status set as government jurisdictional_inspections.
CREATE TABLE IF NOT EXISTS draw_inspections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  inspection_type TEXT NOT NULL DEFAULT 'DRAW_PROGRESS',
  inspection_company_organization_id TEXT REFERENCES organizations(id),
  inspector_user_id TEXT REFERENCES users(id),
  inspector_display_name TEXT,
  inspector_credential TEXT,
  inspector_contact TEXT,
  requested_at TEXT,
  requested_by_user_id TEXT REFERENCES users(id),
  scheduled_at TEXT,
  property_access_contact TEXT,
  preferred_inspection_start TEXT,
  preferred_inspection_end TEXT,
  completed_at TEXT,
  report_received_at TEXT,
  finalized_at TEXT,
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN
    ('NOT_REQUIRED','REQUESTED','SCHEDULING','SCHEDULED','ACCESS_FAILED',
     'COMPLETED','REPORT_PENDING','REPORT_RECEIVED','UNDER_OBV_REVIEW',
     'CORRECTION_REQUIRED','FINALIZED','ACCEPTED','FAILED',
     'REINSPECTION_REQUIRED','CANCELLED')),
  reinspection_of_inspection_id TEXT REFERENCES draw_inspections(id),
  borrower_response_status TEXT,
  borrower_response_note TEXT,
  obv_review_status TEXT,
  obv_reviewed_by_user_id TEXT REFERENCES users(id),
  lender_acceptance_status TEXT,
  lender_accepted_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS draw_inspection_lines (
  id TEXT PRIMARY KEY,
  draw_inspection_id TEXT NOT NULL REFERENCES draw_inspections(id),
  draw_line_item_id TEXT REFERENCES draw_line_items(id),
  budget_line_id TEXT REFERENCES budget_lines(id),
  milestone_id TEXT REFERENCES milestones(id),
  percent_complete_reported REAL,
  materials_present INTEGER,
  materials_stored_on_site INTEGER,
  materials_stored_off_site INTEGER,
  work_consistent_with_plans INTEGER,
  workmanship_observation TEXT,
  visible_defects TEXT,
  safety_concerns TEXT,
  inaccessible_areas TEXT,
  inspector_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Immutable once finalized; corrections create a new version.
CREATE TABLE IF NOT EXISTS draw_inspection_report_versions (
  id TEXT PRIMARY KEY,
  draw_inspection_id TEXT NOT NULL REFERENCES draw_inspections(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','FINALIZED','SUPERSEDED')),
  report_date TEXT,
  summary TEXT,
  conclusion TEXT,
  prepared_by_user_id TEXT NOT NULL REFERENCES users(id),
  finalized_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  prior_version_id TEXT REFERENCES draw_inspection_report_versions(id),
  correction_reason TEXT,
  document_path TEXT,
  document_hash TEXT,
  UNIQUE (draw_inspection_id, version)
);

CREATE TABLE IF NOT EXISTS draw_inspection_attachments (
  id TEXT PRIMARY KEY,
  draw_inspection_id TEXT NOT NULL REFERENCES draw_inspections(id),
  report_version_id TEXT REFERENCES draw_inspection_report_versions(id),
  title TEXT NOT NULL,
  file_path TEXT,
  file_hash TEXT,
  uploaded_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS draw_inspection_events (
  id TEXT PRIMARY KEY,
  draw_inspection_id TEXT NOT NULL REFERENCES draw_inspections(id),
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- The lender's business decision AFTER formal governance. Never a release
-- mechanism: no code path from here to VirtualAccountService.
CREATE TABLE IF NOT EXISTS lender_draw_decisions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  requested_amount INTEGER NOT NULL,
  verified_amount INTEGER,
  recommended_amount INTEGER,
  approved_amount INTEGER,
  reduced_amount INTEGER,
  rejected_amount INTEGER,
  decision TEXT NOT NULL DEFAULT 'PENDING' CHECK (decision IN
    ('PENDING','APPROVED','CONDITIONALLY_APPROVED','REDUCED','REJECTED','WITHDRAWN','FUNDED')),
  reviewer_user_id TEXT NOT NULL REFERENCES users(id),
  decision_at TEXT,
  decision_reason TEXT,
  holdback_amount INTEGER,
  retainage_amount INTEGER,
  exceptions_accepted TEXT,
  government_inspection_requirement TEXT,
  lien_release_requirement TEXT,
  funding_instructions TEXT,
  notes TEXT,
  approval_request_id TEXT REFERENCES approval_requests(id),
  supersedes_decision_id TEXT REFERENCES lender_draw_decisions(id),
  superseded_by_decision_id TEXT REFERENCES lender_draw_decisions(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lender_decision_conditions (
  id TEXT PRIMARY KEY,
  lender_decision_id TEXT NOT NULL REFERENCES lender_draw_decisions(id),
  condition_type TEXT NOT NULL,
  description TEXT NOT NULL,
  responsible_party_organization_id TEXT REFERENCES organizations(id),
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN
    ('OPEN','IN_PROGRESS','SATISFIED','WAIVED','FAILED','CANCELLED')),
  supporting_document_id TEXT REFERENCES draw_documents(id),
  satisfied_by_user_id TEXT REFERENCES users(id),
  satisfied_at TEXT,
  waiver_reason TEXT,
  waived_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Governed lien-waiver lifecycle; DrawDocument metadata stays valid and an
-- uploaded document alone never makes a waiver ACCEPTED.
CREATE TABLE IF NOT EXISTS lien_waiver_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  draw_line_item_id TEXT REFERENCES draw_line_items(id),
  draw_document_id TEXT REFERENCES draw_documents(id),
  contractor_or_supplier_organization_id TEXT REFERENCES organizations(id),
  signing_party TEXT,
  waiver_type TEXT,
  waiver_scope TEXT,
  related_amount INTEGER,
  covered_through TEXT,
  requested_at TEXT,
  received_at TEXT,
  reviewed_at TEXT,
  accepted_at TEXT,
  rejected_at TEXT,
  signature_date TEXT,
  status TEXT NOT NULL DEFAULT 'REQUIRED' CHECK (status IN
    ('NOT_REQUIRED','REQUIRED','REQUESTED','RECEIVED','UNDER_REVIEW',
     'ACCEPTED','REJECTED','EXPIRED','SUPERSEDED')),
  reviewed_by_user_id TEXT REFERENCES users(id),
  rejection_reason TEXT,
  document_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Administrative mirror of the lender's EXTERNAL funding action. Sends no
-- money; never touches VirtualAccountService or the account event ledgers.
CREATE TABLE IF NOT EXISTS external_funding_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  lender_decision_id TEXT REFERENCES lender_draw_decisions(id),
  funding_method TEXT,
  scheduled_at TEXT,
  funded_at TEXT,
  amount_scheduled INTEGER,
  amount_disbursed INTEGER,
  wire_fee INTEGER,
  transaction_reference TEXT,
  confirmation_document_id TEXT REFERENCES draw_documents(id),
  status TEXT NOT NULL DEFAULT 'NOT_SCHEDULED' CHECK (status IN
    ('NOT_SCHEDULED','SCHEDULED','PROCESSING','DISBURSED','FAILED',
     'REVERSED','CANCELLED','CLOSED')),
  failure_reason TEXT,
  reversal_reference TEXT,
  reversed_at TEXT,
  closed_at TEXT,
  recorded_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_memberships (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  participant_type TEXT NOT NULL CHECK (participant_type IN
    ('BORROWER','CONTRACTOR','INSPECTOR','OBV_REVIEWER','LENDER_REVIEWER','ADMINISTRATOR')),
  capability_set TEXT NOT NULL DEFAULT '[]',
  effective_from TEXT,
  effective_to TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  assigned_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Versioned lender draw policy (structured configuration, no executable
-- rules). Each version is a new row; the active flag marks the current
-- version and history is never rewritten.
CREATE TABLE IF NOT EXISTS lender_draw_policies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  version INTEGER NOT NULL,
  required_document_types TEXT NOT NULL DEFAULT '[]',
  required_evidence TEXT,
  independent_inspection_required INTEGER NOT NULL DEFAULT 0,
  government_inspection_required INTEGER NOT NULL DEFAULT 0,
  max_draw_frequency_days INTEGER,
  min_draw_amount INTEGER,
  retainage_pct REAL,
  stored_material_rule TEXT,
  offsite_material_rule TEXT,
  change_order_rule TEXT,
  budget_transfer_rule TEXT,
  lien_waiver_rule TEXT,
  approval_limit INTEGER,
  reviewer_hierarchy TEXT,
  exception_severity_map TEXT,
  mandatory_funding_conditions TEXT NOT NULL DEFAULT '[]',
  turnaround_target_days INTEGER,
  borrower_certification TEXT,
  contractor_certification TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  configured_by_user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT,
  created_at TEXT NOT NULL
);

-- Append-only history of the DERIVED draw workflow stage. The stage itself
-- is computed from authoritative records on read; this log only records
-- observed transitions (written by mutating actions, never by GETs).
-- Append-only lender decision condition status history.
CREATE TABLE IF NOT EXISTS lender_condition_events (
  id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL REFERENCES lender_decision_conditions(id),
  prior_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Frozen lender-policy application per draw (set at first formal
-- submission; later policy versions never rewrite prior draws).
CREATE TABLE IF NOT EXISTS draw_policy_applications (
  id TEXT PRIMARY KEY,
  draw_request_id TEXT NOT NULL UNIQUE REFERENCES draw_requests(id),
  policy_id TEXT NOT NULL REFERENCES lender_draw_policies(id),
  policy_version INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS draw_stage_events (
  id TEXT PRIMARY KEY,
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  prior_stage TEXT,
  new_stage TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  reason TEXT,
  source_record_id TEXT,
  created_at TEXT NOT NULL
);

-- ==================== VAM foundation (banking layer) ====================
-- Provider-neutral bookkeeping about an external partner bank. Amounts are
-- whole-currency INTEGER. Only MASKED account identifiers are stored; no
-- credentials, full account numbers or raw provider payloads ever land in
-- these tables. banking_events is append-only (no UPDATE/DELETE path).

CREATE TABLE IF NOT EXISTS banking_programs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL,
  provider_program_reference TEXT,
  partner_bank_name TEXT NOT NULL,
  account_structure TEXT NOT NULL,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activated_at TEXT,
  suspended_at TEXT,
  metadata TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS project_virtual_accounts (
  id TEXT PRIMARY KEY,
  banking_program_id TEXT NOT NULL REFERENCES banking_programs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider_account_reference TEXT,
  virtual_account_number_masked TEXT NOT NULL,
  routing_number_masked TEXT,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  available_balance INTEGER NOT NULL DEFAULT 0,
  held_balance INTEGER NOT NULL DEFAULT 0,
  release_eligible_balance INTEGER NOT NULL DEFAULT 0,
  pending_outbound_amount INTEGER NOT NULL DEFAULT 0,
  settled_outbound_amount INTEGER NOT NULL DEFAULT 0,
  returned_amount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  suspended_at TEXT,
  closed_at TEXT,
  last_reconciled_at TEXT
);
-- One non-closed account per project (a closed account may be replaced).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pva_open_project
  ON project_virtual_accounts(project_id) WHERE status != 'CLOSED';

CREATE TABLE IF NOT EXISTS project_account_holds (
  id TEXT PRIMARY KEY,
  project_virtual_account_id TEXT NOT NULL REFERENCES project_virtual_accounts(id),
  draw_request_id TEXT REFERENCES draw_requests(id),
  amount INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  placed_at TEXT NOT NULL,
  released_at TEXT,
  placed_by_user_id TEXT NOT NULL REFERENCES users(id),
  released_by_user_id TEXT REFERENCES users(id),
  provider_reference TEXT
);

CREATE TABLE IF NOT EXISTS payment_instructions (
  id TEXT PRIMARY KEY,
  project_virtual_account_id TEXT NOT NULL REFERENCES project_virtual_accounts(id),
  draw_request_id TEXT NOT NULL REFERENCES draw_requests(id),
  lender_decision_id TEXT NOT NULL REFERENCES lender_draw_decisions(id),
  approval_request_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_reference TEXT,
  payment_method TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  approved_by_user_id TEXT REFERENCES users(id),
  requested_at TEXT NOT NULL,
  approved_at TEXT,
  submitted_at TEXT,
  settled_at TEXT,
  failed_at TEXT,
  cancelled_at TEXT,
  provider_reference TEXT,
  failure_code TEXT,
  failure_reason TEXT,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  project_virtual_account_id TEXT NOT NULL REFERENCES project_virtual_accounts(id),
  payment_instruction_id TEXT REFERENCES payment_instructions(id),
  provider_transaction_reference TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  transaction_type TEXT NOT NULL,
  initiated_at TEXT NOT NULL,
  posted_at TEXT,
  settled_at TEXT,
  returned_at TEXT,
  description TEXT,
  raw_event_hash TEXT
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id TEXT PRIMARY KEY,
  banking_program_id TEXT NOT NULL REFERENCES banking_programs(id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  bank_reported_balance INTEGER,
  ledger_calculated_balance INTEGER,
  difference_amount INTEGER,
  project_account_count INTEGER,
  transaction_count INTEGER,
  findings TEXT,
  initiated_by TEXT NOT NULL,
  previous_successful_run_id TEXT REFERENCES reconciliation_runs(id)
);

CREATE TABLE IF NOT EXISTS banking_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT REFERENCES projects(id),
  banking_program_id TEXT REFERENCES banking_programs(id),
  project_virtual_account_id TEXT REFERENCES project_virtual_accounts(id),
  draw_request_id TEXT REFERENCES draw_requests(id),
  payment_instruction_id TEXT REFERENCES payment_instructions(id),
  bank_transaction_id TEXT REFERENCES bank_transactions(id),
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Provider-side simulation ledger for the deterministic mock provider.
-- This table plays the BANK's book of record in demo mode; reconciliation
-- compares it against OBV's project_virtual_accounts ledger. A real
-- provider adapter would replace reads of this table with provider API
-- reports — OBV's own ledger tables above stay identical.
CREATE TABLE IF NOT EXISTS mock_provider_ledger (
  id TEXT PRIMARY KEY,
  banking_program_id TEXT NOT NULL REFERENCES banking_programs(id),
  entry_type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL
);

-- ==================== Dispute + release-hold management ====================
-- Workflow, evidence, authorization and audit records ONLY. A dispute
-- hold pauses release ELIGIBILITY; it never moves funds or touches any
-- balance column. dispute_events and dispute_cure_extensions are
-- append-only (no UPDATE/DELETE path exists in the repository).

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  draw_request_id TEXT REFERENCES draw_requests(id),
  milestone_id TEXT REFERENCES milestones(id),
  payment_instruction_id TEXT REFERENCES payment_instructions(id),
  disputed_amount INTEGER NOT NULL,
  undisputed_amount INTEGER,
  affected_scope TEXT NOT NULL,
  affected_line_ids TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  opened_by_user_id TEXT NOT NULL REFERENCES users(id),
  opened_by_organization_id TEXT NOT NULL REFERENCES organizations(id),
  opened_at TEXT NOT NULL,
  responsible_reviewer_user_id TEXT REFERENCES users(id),
  legal_hold INTEGER NOT NULL DEFAULT 0,
  legal_hold_by_user_id TEXT REFERENCES users(id),
  legal_hold_reason TEXT,
  legal_hold_at TEXT,
  resolution_type TEXT,
  resolution_amount INTEGER,
  resolution_reasoning TEXT,
  resolution_conditions TEXT,
  resolution_evidence_ids TEXT,
  resolution_external_reference TEXT,
  resolved_by_user_id TEXT REFERENCES users(id),
  resolved_by_role TEXT,
  resolved_by_organization_id TEXT REFERENCES organizations(id),
  resolved_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispute_events (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id),
  type TEXT NOT NULL,
  detail TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id),
  ref_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispute_responses (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id),
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  submitted_by_user_id TEXT NOT NULL REFERENCES users(id),
  submitted_by_organization_id TEXT NOT NULL REFERENCES organizations(id),
  supersedes_response_id TEXT REFERENCES dispute_responses(id),
  created_at TEXT NOT NULL,
  UNIQUE(dispute_id, version)
);

CREATE TABLE IF NOT EXISTS dispute_evidence_records (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id),
  evidence_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  linked_type TEXT NOT NULL DEFAULT 'NONE',
  linked_id TEXT,
  external_reference TEXT,
  document_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  supersedes_evidence_id TEXT REFERENCES dispute_evidence_records(id),
  submitted_by_user_id TEXT NOT NULL REFERENCES users(id),
  submitted_by_organization_id TEXT NOT NULL REFERENCES organizations(id),
  review_status TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_by_user_id TEXT REFERENCES users(id),
  reviewed_at TEXT,
  reviewer_notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispute_cure_items (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  responsible_party_user_id TEXT REFERENCES users(id),
  responsible_organization_id TEXT REFERENCES organizations(id),
  due_at TEXT,
  evidence_required TEXT,
  affected_scope TEXT,
  affected_amount INTEGER,
  priority TEXT NOT NULL DEFAULT 'MEDIUM',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN
    ('OPEN','SUBMITTED','ACCEPTED','REJECTED','WAIVED','CANCELLED')),
  completion_note TEXT,
  completion_evidence_id TEXT REFERENCES dispute_evidence_records(id),
  submitted_at TEXT,
  reviewed_by_user_id TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_decision_note TEXT,
  waiver_reason TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispute_cure_extensions (
  id TEXT PRIMARY KEY,
  cure_item_id TEXT NOT NULL REFERENCES dispute_cure_items(id),
  prior_due_at TEXT,
  new_due_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispute_inspection_requests (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id),
  inspection_type TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  assigned_inspector_user_id TEXT REFERENCES users(id),
  scheduled_at TEXT,
  completed_at TEXT,
  location_scope TEXT,
  result TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN
    ('REQUESTED','SCHEDULED','COMPLETED','ACCESS_FAILED','CANCELLED')),
  follow_up TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispute_recommendations (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  basis TEXT,
  ai_generated INTEGER NOT NULL DEFAULT 0,
  official INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  approved_by_user_id TEXT REFERENCES users(id),
  supersedes_recommendation_id TEXT REFERENCES dispute_recommendations(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispute_escalations (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id),
  escalation_type TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_organization TEXT,
  reason TEXT NOT NULL,
  transmitted_materials TEXT,
  status TEXT NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','RESPONDED','CLOSED')),
  response TEXT,
  submitted_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  responded_at TEXT,
  closed_at TEXT
);

`;

export function getDb(): DatabaseSync {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(WORM_DIR, { recursive: true });
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    // Additive migration for databases created before verification
    // provenance existed (fresh seeds already include the column).
    try {
      db.exec("ALTER TABLE verifications ADD COLUMN source TEXT NOT NULL DEFAULT 'MOCK_DEFAULT'");
    } catch {
      /* column already present */
    }
    // Additive migration for offline-retry idempotency (see orchestrator).
    try {
      db.exec("ALTER TABLE evidence_items ADD COLUMN submission_key TEXT");
    } catch {
      /* column already present */
    }
    // Additive migration for validated binding display names.
    for (const ddl of [
      "ALTER TABLE external_thread_bindings ADD COLUMN team_name TEXT",
      "ALTER TABLE external_thread_bindings ADD COLUMN channel_name TEXT",
    ]) {
      try {
        db.exec(ddl);
      } catch {
        /* column already present */
      }
    }
    // Additive migrations for Teams conversation sync on the messages
    // table (origin/edit/delete audit + attachments).
    for (const ddl of [
      "ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'OBV_LOCAL'",
      // ---- audit package hardening (additive) ----
      "ALTER TABLE audit_packages ADD COLUMN integrity_critical INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE audit_packages ADD COLUMN include_evidence_media INTEGER NOT NULL DEFAULT 0",
      // ---- lender draw verification package (additive doc metadata) ----
      "ALTER TABLE draw_documents ADD COLUMN vendor TEXT",
      "ALTER TABLE draw_documents ADD COLUMN invoice_number TEXT",
      "ALTER TABLE draw_documents ADD COLUMN amount INTEGER",
      "ALTER TABLE draw_documents ADD COLUMN waiver_kind TEXT",
      "ALTER TABLE draw_documents ADD COLUMN waiver_scope TEXT",
      "ALTER TABLE draw_documents ADD COLUMN covered_through TEXT",
      "ALTER TABLE draw_documents ADD COLUMN issuing_authority TEXT",
      "ALTER TABLE draw_documents ADD COLUMN reference_number TEXT",
      "ALTER TABLE draw_documents ADD COLUMN inspection_date TEXT",
      "ALTER TABLE draw_documents ADD COLUMN inspection_result TEXT",
      // ---- milestone completion gates (additive; conservative defaults:
      // contractor NOT_REPORTED, inspection requirement UNKNOWN-by-absence) ----
      "ALTER TABLE milestones ADD COLUMN contractor_completion_status TEXT NOT NULL DEFAULT 'NOT_REPORTED'",
      "ALTER TABLE milestones ADD COLUMN contractor_reported_by TEXT",
      "ALTER TABLE milestones ADD COLUMN contractor_reported_at TEXT",
      "ALTER TABLE milestones ADD COLUMN contractor_completion_notes TEXT",
      "ALTER TABLE milestones ADD COLUMN contractor_linked_evidence TEXT",
      "ALTER TABLE messages ADD COLUMN edited_at TEXT",
      "ALTER TABLE messages ADD COLUMN original_body TEXT",
      "ALTER TABLE messages ADD COLUMN external_deleted INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE messages ADD COLUMN attachments TEXT",
      "ALTER TABLE messages ADD COLUMN location TEXT",
      "ALTER TABLE external_identity_mappings ADD COLUMN organization_id TEXT",
      // ---- pilot onboarding (additive; legacy rows keep defaults) ----
      "ALTER TABLE organizations ADD COLUMN country TEXT",
      "ALTER TABLE organizations ADD COLUMN region TEXT",
      "ALTER TABLE organizations ADD COLUMN website TEXT",
      "ALTER TABLE organizations ADD COLUMN primary_contact TEXT",
      "ALTER TABLE organizations ADD COLUMN billing_contact TEXT",
      "ALTER TABLE organizations ADD COLUMN timezone TEXT",
      "ALTER TABLE organizations ADD COLUMN currency TEXT",
      "ALTER TABLE organizations ADD COLUMN language TEXT",
      "ALTER TABLE organizations ADD COLUMN pilot_start TEXT",
      "ALTER TABLE organizations ADD COLUMN pilot_end TEXT",
      "ALTER TABLE organizations ADD COLUMN pilot_reference TEXT",
      "ALTER TABLE organizations ADD COLUMN notes TEXT",
      "ALTER TABLE projects ADD COLUMN code TEXT",
      "ALTER TABLE projects ADD COLUMN category TEXT",
      "ALTER TABLE projects ADD COLUMN country TEXT",
      "ALTER TABLE projects ADD COLUMN region TEXT",
      "ALTER TABLE projects ADD COLUMN locality TEXT",
      "ALTER TABLE projects ADD COLUMN implementing_org_id TEXT",
      "ALTER TABLE projects ADD COLUMN contractor_org_id TEXT",
      "ALTER TABLE projects ADD COLUMN funder_org_id TEXT",
      "ALTER TABLE projects ADD COLUMN engineer_org_id TEXT",
      "ALTER TABLE projects ADD COLUMN obv_controlled_amount INTEGER",
      "ALTER TABLE projects ADD COLUMN currency TEXT",
      "ALTER TABLE projects ADD COLUMN planned_start TEXT",
      "ALTER TABLE projects ADD COLUMN planned_end TEXT",
      "ALTER TABLE projects ADD COLUMN timezone TEXT",
      "ALTER TABLE projects ADD COLUMN geometry_kind TEXT",
      "ALTER TABLE projects ADD COLUMN created_by TEXT",
      "ALTER TABLE projects ADD COLUMN launched_at TEXT",
      "ALTER TABLE projects ADD COLUMN launched_by TEXT",
      "ALTER TABLE projects ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE milestones ADD COLUMN planned_start TEXT",
      "ALTER TABLE milestones ADD COLUMN planned_end TEXT",
      "ALTER TABLE milestones ADD COLUMN weight REAL",
      "ALTER TABLE milestones ADD COLUMN spatial_label TEXT",
      "ALTER TABLE milestones ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
      // Which configuration version a verification was evaluated under
      // (historic evidence keeps its policy reference — Part 19).
      "ALTER TABLE verifications ADD COLUMN policy_version INTEGER",
      // ---- permit / code-basis / official-source gating (additive;
      // conservative defaults preserve exact legacy behavior) ----
      "ALTER TABLE inspection_requirements ADD COLUMN permit_required INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE inspection_requirements ADD COLUMN required_permit_type TEXT",
      "ALTER TABLE inspection_requirements ADD COLUMN official_source_required INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE inspection_requirements ADD COLUMN code_basis_required INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE inspection_requirements ADD COLUMN permit_must_be_active_before_draw_review INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE inspection_requirements ADD COLUMN permit_must_be_active_before_governance INTEGER NOT NULL DEFAULT 0",
    ]) {
      try {
        db.exec(ddl);
      } catch {
        /* column already present */
      }
    }
    // ---- change-order / retainage additive columns (legacy databases) ----
    for (const ddl of [
      "ALTER TABLE draw_line_items ADD COLUMN change_order_id TEXT",
      "ALTER TABLE draw_requests ADD COLUMN retainage_rate REAL",
      "ALTER TABLE draw_requests ADD COLUMN retainage_withheld INTEGER",
    ]) {
      try {
        db.exec(ddl);
      } catch {
        /* column already present */
      }
    }
    // ---- draw-workflow structural migrations (legacy databases) ----
    // approval_requests gains a DRAW subject (nullable milestone_id +
    // draw_request_id + subject_type) and conversation_threads gains the
    // DRAW scope. SQLite cannot ALTER constraints, so pre-draw databases
    // are rebuilt in place: identical data, new column/constraint set.
    // Fresh databases already match the SCHEMA above and are untouched.
    migrateApprovalRequestsForDraws(db);
    migrateApprovalRequestsForChangeOrders(db);
    migrateThreadsForDraws(db);
    migrateInspectionsForReinspection(db);
    // One direct reinspection child per prior inspection — the database
    // guarantees no parallel chain heads even under concurrent creation.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_reinspection_single_child
         ON jurisdictional_inspections(reinspection_of_inspection_id)
         WHERE reinspection_of_inspection_id IS NOT NULL`
    );
    // Database-level inbound dedupe: one Message per external message id
    // per thread (notification replays hit this even if app checks race).
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external
         ON messages(thread_id, external_message_id)
         WHERE external_message_id IS NOT NULL`
    );
    // ---- lender-domain integrity constraints (additive) ----
    // Exactly one current (non-superseded) lender decision per draw.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_lender_decision
         ON lender_draw_decisions(draw_request_id)
         WHERE superseded_by_decision_id IS NULL`
    );
    // One direct reinspection child per prior independent inspection.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_draw_reinspection_single_child
         ON draw_inspections(reinspection_of_inspection_id)
         WHERE reinspection_of_inspection_id IS NOT NULL`
    );
    // At most one DRAFT report version per inspection (DB-enforced; the
    // service check alone cannot exclude a concurrent duplicate draft).
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_one_draft_report_version
         ON draw_inspection_report_versions(draw_inspection_id)
         WHERE status = 'DRAFT'`
    );
    // At most one ACTIVE holder of a party role per project (DB-enforced;
    // with a vacant role two concurrent assignments would otherwise both
    // insert — the guarded-update replacement path alone cannot stop that).
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_party
         ON project_party_assignments(project_id, party_type)
         WHERE active = 1`
    );
    // At most one in-flight external funding record per draw.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_funding
         ON external_funding_records(draw_request_id)
         WHERE status IN ('SCHEDULED','PROCESSING')`
    );
    // One inspector finding per draw line per inspection (findings are not
    // versioned; corrections go through report versions).
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_inspection_line_unique
         ON draw_inspection_lines(draw_inspection_id, draw_line_item_id)
         WHERE draw_line_item_id IS NOT NULL`
    );
    // Amount provenance on lender decisions (additive).
    for (const ddl of [
      "ALTER TABLE lender_draw_decisions ADD COLUMN verified_amount_source TEXT",
      "ALTER TABLE lender_draw_decisions ADD COLUMN recommended_amount_source TEXT",
    ]) {
      try { db.exec(ddl); } catch { /* column already present */ }
    }

    // Additive migration for notification delivery provenance.
    for (const ddl of [
      "ALTER TABLE notifications ADD COLUMN project_id TEXT",
      "ALTER TABLE notifications ADD COLUMN milestone_id TEXT",
      "ALTER TABLE notifications ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'MOCK'",
      "ALTER TABLE notifications ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'SKIPPED'",
      "ALTER TABLE notifications ADD COLUMN sent_at TEXT",
      "ALTER TABLE notifications ADD COLUMN failure_category TEXT",
    ]) {
      try {
        db.exec(ddl);
      } catch {
        /* column already present */
      }
    }
  }
  return db;
}

/** Whether a table already has a column (PRAGMA table_info). */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (c) => c.name === column
  );
}

/**
 * Rebuild approval_requests for pre-draw databases: milestone_id becomes
 * nullable and draw_request_id / subject_type are added. Data is copied
 * verbatim (all legacy rows are MILESTONE-subject). FK enforcement is
 * suspended only for the rename swap; approval_records and
 * conversation_threads reference approval_requests(id), which is
 * preserved exactly.
 */
/**
 * Rebuild jurisdictional_inspections for pre-reinspection databases:
 * extends the status/result CHECK constraints (CORRECTIONS_REQUIRED) and
 * adds the permit-register FK plus corrections/reinspection chain columns.
 * All existing rows are copied verbatim — historical results untouched.
 * Fresh databases already match the SCHEMA above and are skipped.
 */
function migrateInspectionsForReinspection(db: DatabaseSync): void {
  if (hasColumn(db, "jurisdictional_inspections", "reinspection_of_inspection_id")) return;
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("BEGIN;");
  db.exec(`CREATE TABLE jurisdictional_inspections_new (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    milestone_id TEXT NOT NULL REFERENCES milestones(id),
    permit_id TEXT,
    permit_ref_id TEXT REFERENCES permits(id),
    inspection_type TEXT,
    jurisdiction TEXT,
    issuing_authority TEXT,
    inspection_reference TEXT,
    required INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'REQUIRED_UNSCHEDULED' CHECK (status IN
      ('REQUIRED_UNSCHEDULED','SCHEDULED','COMPLETED_PENDING_RESULT',
       'PASSED','FAILED','CORRECTIONS_REQUIRED','CANCELLED','EXPIRED')),
    scheduled_at TEXT,
    completed_at TEXT,
    result_recorded_at TEXT,
    result TEXT CHECK (result IN ('PASSED','FAILED','CORRECTIONS_REQUIRED')),
    government_inspector_name TEXT,
    reviewed_by_user_id TEXT REFERENCES users(id),
    supporting_document_id TEXT,
    reinspection_of_inspection_id TEXT REFERENCES jurisdictional_inspections(id),
    superseded_by_inspection_id TEXT REFERENCES jurisdictional_inspections(id),
    correction_notice_reference TEXT,
    correction_summary TEXT,
    correction_due_at TEXT,
    correction_cleared_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
  db.exec(`INSERT INTO jurisdictional_inspections_new
    (id, organization_id, project_id, milestone_id, permit_id, permit_ref_id,
     inspection_type, jurisdiction, issuing_authority, inspection_reference,
     required, status, scheduled_at, completed_at, result_recorded_at, result,
     government_inspector_name, reviewed_by_user_id, supporting_document_id,
     reinspection_of_inspection_id, superseded_by_inspection_id,
     correction_notice_reference, correction_summary, correction_due_at,
     correction_cleared_at, notes, created_at, updated_at)
    SELECT id, organization_id, project_id, milestone_id, permit_id, NULL,
     inspection_type, jurisdiction, issuing_authority, inspection_reference,
     required, status, scheduled_at, completed_at, result_recorded_at, result,
     government_inspector_name, reviewed_by_user_id, supporting_document_id,
     NULL, NULL, NULL, NULL, NULL, NULL, notes, created_at, updated_at
    FROM jurisdictional_inspections;`);
  db.exec("DROP TABLE jurisdictional_inspections;");
  db.exec("ALTER TABLE jurisdictional_inspections_new RENAME TO jurisdictional_inspections;");
  db.exec("COMMIT;");
  db.exec("PRAGMA foreign_keys = ON;");
}

function migrateApprovalRequestsForDraws(db: DatabaseSync): void {
  if (hasColumn(db, "approval_requests", "draw_request_id")) return;
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("BEGIN;");
  db.exec(`CREATE TABLE approval_requests_new (
    id TEXT PRIMARY KEY,
    milestone_id TEXT REFERENCES milestones(id),
    draw_request_id TEXT REFERENCES draw_requests(id),
    subject_type TEXT NOT NULL DEFAULT 'MILESTONE' CHECK (subject_type IN ('MILESTONE','DRAW')),
    status TEXT NOT NULL DEFAULT 'PENDING',
    required_roles TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (
      (subject_type = 'MILESTONE' AND milestone_id IS NOT NULL) OR
      (subject_type = 'DRAW' AND draw_request_id IS NOT NULL)
    )
  );`);
  db.exec(`INSERT INTO approval_requests_new
    (id, milestone_id, draw_request_id, subject_type, status, required_roles, created_at)
    SELECT id, milestone_id, NULL, 'MILESTONE', status, required_roles, created_at
    FROM approval_requests;`);
  db.exec("DROP TABLE approval_requests;");
  db.exec("ALTER TABLE approval_requests_new RENAME TO approval_requests;");
  db.exec("COMMIT;");
  db.exec("PRAGMA foreign_keys = ON;");
}

/**
 * Rebuild approval_requests for pre-change-order databases: adds
 * change_order_id / retainage_release_id and the extended subject CHECK.
 * Data is copied verbatim; ids referenced by approval_records and
 * conversation_threads are preserved exactly.
 */
function migrateApprovalRequestsForChangeOrders(db: DatabaseSync): void {
  if (hasColumn(db, "approval_requests", "change_order_id")) return;
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("BEGIN;");
  db.exec(`CREATE TABLE approval_requests_new (
    id TEXT PRIMARY KEY,
    milestone_id TEXT REFERENCES milestones(id),
    draw_request_id TEXT REFERENCES draw_requests(id),
    change_order_id TEXT REFERENCES change_orders(id),
    retainage_release_id TEXT REFERENCES retainage_release_requests(id),
    subject_type TEXT NOT NULL DEFAULT 'MILESTONE' CHECK (subject_type IN ('MILESTONE','DRAW','CHANGE_ORDER','RETAINAGE')),
    status TEXT NOT NULL DEFAULT 'PENDING',
    required_roles TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (
      (subject_type = 'MILESTONE' AND milestone_id IS NOT NULL) OR
      (subject_type = 'DRAW' AND draw_request_id IS NOT NULL) OR
      (subject_type = 'CHANGE_ORDER' AND change_order_id IS NOT NULL) OR
      (subject_type = 'RETAINAGE' AND retainage_release_id IS NOT NULL)
    )
  );`);
  db.exec(`INSERT INTO approval_requests_new
    (id, milestone_id, draw_request_id, change_order_id, retainage_release_id,
     subject_type, status, required_roles, created_at)
    SELECT id, milestone_id, draw_request_id, NULL, NULL, subject_type,
           status, required_roles, created_at
    FROM approval_requests;`);
  db.exec("DROP TABLE approval_requests;");
  db.exec("ALTER TABLE approval_requests_new RENAME TO approval_requests;");
  db.exec("COMMIT;");
  db.exec("PRAGMA foreign_keys = ON;");
}

/**
 * Rebuild conversation_threads for pre-draw databases: adds the DRAW
 * scope to the CHECK constraint and the draw_request_id column. Messages
 * reference threads by id, which is preserved exactly.
 */
function migrateThreadsForDraws(db: DatabaseSync): void {
  if (hasColumn(db, "conversation_threads", "draw_request_id")) return;
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("BEGIN;");
  db.exec(`CREATE TABLE conversation_threads_new (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    project_id TEXT REFERENCES projects(id),
    milestone_id TEXT REFERENCES milestones(id),
    evidence_item_id TEXT REFERENCES evidence_items(id),
    approval_request_id TEXT REFERENCES approval_requests(id),
    draw_request_id TEXT REFERENCES draw_requests(id),
    title TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('ORGANIZATION','PROJECT','MILESTONE','EVIDENCE','APPROVAL','DRAW')),
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id)
  );`);
  db.exec(`INSERT INTO conversation_threads_new
    (id, organization_id, project_id, milestone_id, evidence_item_id,
     approval_request_id, draw_request_id, title, scope, created_at, created_by)
    SELECT id, organization_id, project_id, milestone_id, evidence_item_id,
           approval_request_id, NULL, title, scope, created_at, created_by
    FROM conversation_threads;`);
  db.exec("DROP TABLE conversation_threads;");
  db.exec("ALTER TABLE conversation_threads_new RENAME TO conversation_threads;");
  db.exec("COMMIT;");
  db.exec("PRAGMA foreign_keys = ON;");
}

export function resetDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  fs.rmSync(DB_PATH, { force: true });
  fs.rmSync(DB_PATH + "-wal", { force: true });
  fs.rmSync(DB_PATH + "-shm", { force: true });
  fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
  fs.rmSync(WORM_DIR, { recursive: true, force: true });
  fs.rmSync(REPORTS_DIR, { recursive: true, force: true });
  fs.rmSync(AUDIT_PACKAGES_DIR, { recursive: true, force: true });
  getDb();
}
