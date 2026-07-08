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

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  status TEXT NOT NULL DEFAULT 'PENDING',
  required_roles TEXT NOT NULL, -- JSON UserRole[]
  created_at TEXT NOT NULL
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
  title TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('ORGANIZATION','PROJECT','MILESTONE','EVIDENCE','APPROVAL')),
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
    ]) {
      try {
        db.exec(ddl);
      } catch {
        /* column already present */
      }
    }
    // Database-level inbound dedupe: one Message per external message id
    // per thread (notification replays hit this even if app checks race).
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external
         ON messages(thread_id, external_message_id)
         WHERE external_message_id IS NOT NULL`
    );
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
  getDb();
}
