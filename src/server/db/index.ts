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
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const WORM_DIR = path.join(DATA_DIR, "worm");
export const REPORTS_DIR = path.join(DATA_DIR, "reports");
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
  is_demo_fallback INTEGER NOT NULL DEFAULT 0
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
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_fallback_photos (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  path TEXT NOT NULL,
  label TEXT NOT NULL
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
