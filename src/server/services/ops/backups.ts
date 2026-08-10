/**
 * Production backups for the SQLite storage model.
 *
 * MECHANISM: `VACUUM INTO` — a consistent, compacted snapshot taken from
 * a live connection without stopping the server (safe under WAL). The
 * snapshot file plus its backup_records row (timestamp, environment,
 * size, SHA-256, source schema version, deploy commit, verification
 * state, retention metadata) is the whole model.
 *
 * SAFETY DOCTRINE
 *  - File names are minted internally (obv-backup-<id>.db) and rows
 *    store the BASENAME only — no caller-supplied path ever reaches the
 *    filesystem, so backup paths cannot escape the backup root.
 *  - Verification re-hashes the file, opens it READ-ONLY and runs
 *    PRAGMA quick_check plus core-table counts. It never writes.
 *  - There is NO restore code path here or anywhere else in the
 *    application. Restore is a documented human operation
 *    (docs/FIRST_LENDER_RUNBOOK.md); an in-app restore button would be
 *    a data-destruction primitive behind a web route.
 *  - Retention is METADATA. OBV never deletes a backup file; pruning is
 *    an operator task, so an automation bug can never destroy the last
 *    good backup.
 *  - Backups contain the full database and are themselves sensitive
 *    production artifacts: the backup root lives on the protected data
 *    volume and file contents never leave through any route.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { appCommit as runtimeAppCommit } from "../platform/runtime";
import { getDb } from "../../db/index";
import * as repo from "../../db/repo";
import { environmentName } from "../posture";
import { BACKUPS_DIR, inspectDatabaseFile } from "./storage";

export class BackupError extends Error {
  constructor(
    message: string,
    public statusCode = 500
  ) {
    super(message);
  }
}

export interface BackupRecord {
  id: string;
  createdAt: string;
  sourceEnvironment: string;
  fileName: string;
  sizeBytes: number | null;
  sha256: string | null;
  schemaVersion: number | null;
  appCommit: string | null;
  status: "COMPLETED" | "FAILED";
  error: string | null;
  verificationStatus: "UNVERIFIED" | "VERIFIED" | "MISMATCH";
  verifiedAt: string | null;
  retentionUntil: string | null;
  createdByUserId: string | null;
}

const nowIso = (): string => new Date().toISOString();

function retentionDays(): number {
  const n = Number(process.env.OBV_BACKUP_RETENTION_DAYS ?? 30);
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? Math.floor(n) : 30;
}

/** Recorded on each backup so a restored file can be tied to a build.
 *  Resolved by the runtime platform boundary, not read from a
 *  platform-specific variable here. */
function appCommit(): string | null {
  const v = runtimeAppCommit();
  return v ? v.slice(0, 40) : null;
}

function sha256File(filePath: string): string {
  const h = createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

// ------------------------------------------------------------ repo (local)

type Row = Record<string, unknown>;

function toRecord(r: Row): BackupRecord {
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    sourceEnvironment: r.source_environment as string,
    fileName: r.file_name as string,
    sizeBytes: (r.size_bytes as number) ?? null,
    sha256: (r.sha256 as string) ?? null,
    schemaVersion: (r.schema_version as number) ?? null,
    appCommit: (r.app_commit as string) ?? null,
    status: r.status as BackupRecord["status"],
    error: (r.error as string) ?? null,
    verificationStatus: r.verification_status as BackupRecord["verificationStatus"],
    verifiedAt: (r.verified_at as string) ?? null,
    retentionUntil: (r.retention_until as string) ?? null,
    createdByUserId: (r.created_by_user_id as string) ?? null,
  };
}

export function listBackups(limit = 50): BackupRecord[] {
  return (
    getDb()
      .prepare("SELECT * FROM backup_records ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(Math.min(500, Math.max(1, limit))) as Row[]
  ).map(toRecord);
}

export function getBackup(id: string): BackupRecord | null {
  const r = getDb().prepare("SELECT * FROM backup_records WHERE id = ?").get(id) as Row | undefined;
  return r ? toRecord(r) : null;
}

export function latestVerifiedBackup(): BackupRecord | null {
  const r = getDb()
    .prepare(
      `SELECT * FROM backup_records WHERE status = 'COMPLETED' AND verification_status = 'VERIFIED'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get() as Row | undefined;
  return r ? toRecord(r) : null;
}

/** Absolute path of a backup's file — derived from the stored BASENAME
 *  under the backup root, never from caller input. */
export function backupFilePath(record: BackupRecord): string {
  return path.join(BACKUPS_DIR, path.basename(record.fileName));
}

// ------------------------------------------------------------- create

/**
 * Take one backup. Returns the record either way — a failed snapshot is
 * an honest FAILED row, never a silent absence.
 */
export function createBackup(createdByUserId: string | null): BackupRecord {
  const db = getDb();
  const id = repo.newId();
  const fileName = `obv-backup-${id}.db`;
  const target = path.join(BACKUPS_DIR, fileName);
  const createdAt = nowIso();
  const schemaVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
  const base: Omit<BackupRecord, "sizeBytes" | "sha256" | "status" | "error"> = {
    id,
    createdAt,
    sourceEnvironment: environmentName(),
    fileName,
    schemaVersion,
    appCommit: appCommit(),
    verificationStatus: "UNVERIFIED",
    verifiedAt: null,
    retentionUntil: new Date(Date.now() + retentionDays() * 86_400_000).toISOString(),
    createdByUserId,
  };
  let record: BackupRecord;
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    // VACUUM INTO refuses to overwrite; the id-derived name is unique.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    record = {
      ...base,
      sizeBytes: fs.statSync(target).size,
      sha256: sha256File(target),
      status: "COMPLETED",
      error: null,
    };
  } catch (err) {
    record = {
      ...base,
      sizeBytes: null,
      sha256: null,
      status: "FAILED",
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  }
  getDb()
    .prepare(
      `INSERT INTO backup_records (
         id, created_at, source_environment, file_name, size_bytes, sha256,
         schema_version, app_commit, status, error, verification_status,
         verified_at, retention_until, created_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id, record.createdAt, record.sourceEnvironment, record.fileName,
      record.sizeBytes, record.sha256, record.schemaVersion, record.appCommit,
      record.status, record.error, record.verificationStatus, record.verifiedAt,
      record.retentionUntil, record.createdByUserId
    );
  return record;
}

// ------------------------------------------------------------- verify

/**
 * Verify one backup: stored SHA-256 still matches the file (no
 * corruption or tampering since creation), the file opens READ-ONLY as
 * SQLite, quick_check passes, and the core tables are countable.
 * Records VERIFIED or MISMATCH; never writes to the backup file.
 */
export function verifyBackup(id: string): BackupRecord {
  const record = getBackup(id);
  if (!record) throw new BackupError("Backup not found", 404);
  if (record.status !== "COMPLETED") throw new BackupError("Only a completed backup can be verified", 409);
  const filePath = backupFilePath(record);
  let status: BackupRecord["verificationStatus"] = "MISMATCH";
  try {
    const hashNow = sha256File(filePath);
    if (hashNow === record.sha256) {
      const inspection = inspectDatabaseFile(filePath);
      if (inspection.ok) status = "VERIFIED";
    }
  } catch {
    status = "MISMATCH";
  }
  getDb()
    .prepare("UPDATE backup_records SET verification_status = ?, verified_at = ? WHERE id = ?")
    .run(status, nowIso(), id);
  return getBackup(id)!;
}

/** Freshness for readiness checks: hours since the last COMPLETED backup
 *  (Infinity when none exists). */
export function hoursSinceLastBackup(): number {
  const r = getDb()
    .prepare("SELECT created_at FROM backup_records WHERE status = 'COMPLETED' ORDER BY created_at DESC LIMIT 1")
    .get() as Row | undefined;
  if (!r) return Number.POSITIVE_INFINITY;
  return (Date.now() - Date.parse(r.created_at as string)) / 3_600_000;
}
