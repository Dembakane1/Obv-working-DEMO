/**
 * Storage posture + database safety — the persistence half of pilot
 * operations.
 *
 * WHAT THIS GUARDS
 *  - A pilot must never run on an ephemeral data root by accident:
 *    production posture REQUIRES an explicit OBV_DATA_DIR.
 *  - Every persistent artifact root (database, uploads, WORM evidence,
 *    reports, audit packages, backups) must exist and be writable, and
 *    the startup disclosure says so WITHOUT printing secrets.
 *  - The server fails safely against an unreadable, corrupted, or
 *    newer-schema database instead of running against it (§ database
 *    safety). It never "repairs" governed data.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AUDIT_PACKAGES_DIR,
  DATA_DIR,
  REPORTS_DIR,
  UPLOADS_DIR,
  WORM_DIR,
  getDb,
} from "../../db/index";
import { environmentName, productionPosture } from "../posture";

export class StorageConfigError extends Error {}

/** Backups live under the data root by default so one persistent volume
 *  covers everything; OBV_BACKUP_DIR relocates them (e.g. a second disk). */
export const BACKUPS_DIR = process.env.OBV_BACKUP_DIR
  ? path.resolve(process.env.OBV_BACKUP_DIR)
  : path.join(DATA_DIR, "backups");

export interface StorageRootStatus {
  name: string;
  dir: string;
  exists: boolean;
  writable: boolean;
}

export interface StoragePosture {
  environment: string;
  dataDir: string;
  dataDirExplicit: boolean;
  databasePath: string;
  databaseExists: boolean;
  databaseSizeBytes: number | null;
  roots: StorageRootStatus[];
}

function probeWritable(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.obv-write-probe-${process.pid}`);
    fs.writeFileSync(probe, "probe", { flag: "w" });
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function storagePosture(): StoragePosture {
  const databasePath = path.join(DATA_DIR, "obv.db");
  let databaseSizeBytes: number | null = null;
  try {
    databaseSizeBytes = fs.statSync(databasePath).size;
  } catch {
    databaseSizeBytes = null;
  }
  const roots: StorageRootStatus[] = [
    ["data root", DATA_DIR],
    ["uploads", UPLOADS_DIR],
    ["worm evidence", WORM_DIR],
    ["reports", REPORTS_DIR],
    ["audit packages", AUDIT_PACKAGES_DIR],
    ["backups", BACKUPS_DIR],
  ].map(([name, dir]) => ({
    name,
    dir,
    exists: fs.existsSync(dir),
    writable: probeWritable(dir),
  }));
  return {
    environment: environmentName(),
    dataDir: DATA_DIR,
    dataDirExplicit: Boolean(process.env.OBV_DATA_DIR),
    databasePath,
    databaseExists: databaseSizeBytes !== null,
    databaseSizeBytes,
    roots,
  };
}

/**
 * Startup guard. In pilot/production posture: an explicit persistent
 * data root is mandatory (cwd-relative `data/` disappears with the
 * container) and every storage root must be writable. Demo keeps the
 * zero-config default.
 */
export function assertStorageConfig(): void {
  const posture = storagePosture();
  if (productionPosture() && !posture.dataDirExplicit) {
    throw new StorageConfigError(
      `OBV_DATA_DIR must be set in the ${posture.environment} environment — without it the ` +
        "database, uploads, evidence and reports live on the container's ephemeral filesystem " +
        "and vanish on redeploy. Point it at a persistent volume mount (e.g. /var/data)."
    );
  }
  const broken = posture.roots.filter((r) => !r.writable);
  if (broken.length) {
    throw new StorageConfigError(
      `Storage root(s) not writable: ${broken.map((r) => `${r.name} (${r.dir})`).join(", ")}. ` +
        "Check the volume mount and filesystem permissions."
    );
  }
}

/** One-line boot disclosure — paths only, never secrets. */
export function storageStartupNotice(): string {
  const posture = storagePosture();
  const durability = posture.dataDirExplicit
    ? `explicit data root ${posture.dataDir}`
    : `cwd-relative data root ${posture.dataDir} (EPHEMERAL on hosted deploys — set OBV_DATA_DIR)`;
  return `storage: ${durability}; database ${posture.databaseExists ? `present (${posture.databaseSizeBytes} bytes)` : "will be created"}`;
}

// -------------------------------------------------- database safety

export interface DatabaseSafetyReport {
  integrity: "ok" | string;
  foreignKeyViolations: number;
  schemaVersion: number;
}

/**
 * Post-open safety checks on the LIVE database connection. quick_check
 * failure or a future-schema database is fatal in every posture; foreign
 * key violations are fatal under production posture and a loud warning in
 * demo (a demo database mid-upgrade should still boot for inspection).
 * Nothing here ever mutates data.
 */
export function databaseSafetyCheck(): DatabaseSafetyReport {
  const db = getDb();
  const integrityRow = db.prepare("PRAGMA quick_check(1)").get() as { quick_check?: string } | undefined;
  const integrity = String(integrityRow?.quick_check ?? "unknown");
  if (integrity !== "ok") {
    throw new StorageConfigError(
      `SQLite integrity check failed ("${integrity.slice(0, 120)}"). The server refuses to run against ` +
        "a corrupted database. Restore from the most recent verified backup (see docs/FIRST_LENDER_RUNBOOK.md) — " +
        "do not attempt in-place repair of governed records."
    );
  }
  const fkRows = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
  if (fkRows.length > 0 && productionPosture()) {
    throw new StorageConfigError(
      `${fkRows.length} foreign-key violation(s) found. A ${environmentName()} deployment refuses to run ` +
        "against referentially broken data; restore from a verified backup and investigate."
    );
  }
  if (fkRows.length > 0) {
    console.warn(`storage: WARNING — ${fkRows.length} foreign-key violation(s) in the demo database`);
  }
  const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return { integrity: "ok", foreignKeyViolations: fkRows.length, schemaVersion: Number(versionRow?.user_version ?? 0) };
}

/** Open an arbitrary SQLite file read-only and report its integrity —
 *  used by backup verification and the restore drill; never touches the
 *  live database. */
export function inspectDatabaseFile(filePath: string): {
  ok: boolean;
  integrity: string;
  tables: Record<string, number>;
} {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    const integrityRow = db.prepare("PRAGMA quick_check(1)").get() as { quick_check?: string } | undefined;
    const integrity = String(integrityRow?.quick_check ?? "unknown");
    const tables: Record<string, number> = {};
    for (const t of ["projects", "users", "organizations", "ledger_entries", "draw_requests"]) {
      try {
        tables[t] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      } catch {
        tables[t] = -1; // table missing — reported, judged by the caller
      }
    }
    return { ok: integrity === "ok" && Object.values(tables).every((n) => n >= 0), integrity, tables };
  } catch (err) {
    return { ok: false, integrity: err instanceof Error ? err.message.slice(0, 160) : "unreadable", tables: {} };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
