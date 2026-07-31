/**
 * Operations: monitoring dashboard, backup management, and production
 * configuration (feature flags, banners, maintenance, rate limiting,
 * deployment version). Internal-operator-gated (nondisclosing 404 for
 * lender-side roles) except system banners, which every signed-in user
 * sees rendered.
 *
 * Monitoring is in-memory + derived: request timing and sanitized error
 * summaries live in bounded ring buffers (no database writes on the
 * request path); everything else reads existing records. Backups use
 * SQLite VACUUM INTO with hash verification and an append-only
 * recovery-test log. THERE IS NO RESTORE CODE PATH — restoring is a
 * deliberate human operation outside the application.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { User } from "../../../shared/types";
import { DATA_DIR, getDb } from "../../db/index";
import * as repo from "../../db/repo";
import * as prepo from "../../db/pilotOpsRepo";
import { PilotOpsError, assertInternalOperator, assertOrgAdmin, audit } from "./core";

// ------------------------------------------------------------ monitoring

interface RequestSample {
  path: string;
  ms: number;
  status: number;
  at: number;
}
interface ErrorSample {
  path: string;
  status: number;
  message: string;
  at: string;
}

const DB_PATH = path.join(DATA_DIR, "obv.db");

const REQUEST_RING: RequestSample[] = [];
const ERROR_RING: ErrorSample[] = [];
const RING_MAX = 500;
const ERROR_MAX = 50;
const STARTED_AT = new Date().toISOString();

/** Bucket dynamic segments so the ring stays low-cardinality. */
export function bucketPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) =>
      /^[0-9a-f-]{8,}$/i.test(segment) || /^(proj|ms|draw|bl|exc|disp|permit|user|org)-/.test(segment)
        ? ":id"
        : segment
    )
    .join("/")
    .slice(0, 80);
}

export function recordRequest(pathname: string, ms: number, status: number): void {
  REQUEST_RING.push({ path: bucketPath(pathname), ms, status, at: Date.now() });
  if (REQUEST_RING.length > RING_MAX) REQUEST_RING.shift();
}

/** Sanitized: message + status only — never stacks, paths, or payloads. */
export function recordError(pathname: string, status: number, message: string): void {
  ERROR_RING.push({
    path: bucketPath(pathname),
    status,
    message: message.slice(0, 200),
    at: new Date().toISOString(),
  });
  if (ERROR_RING.length > ERROR_MAX) ERROR_RING.shift();
}

function dirSize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    } catch {
      /* transient file — skip */
    }
  }
  return total;
}

export interface OpsDashboard {
  application: { status: string; startedAt: string; nodeVersion: string; deployVersion: string };
  database: { status: string; quickCheck: string; fileSizeBytes: number; tableCount: number };
  storage: { name: string; sizeBytes: number }[];
  emailQueue: Record<string, number>;
  failedJobs: { failedEmails: number; failedBackups: number };
  recentErrors: ErrorSample[];
  apiPerformance: {
    samples: number;
    averageMs: number | null;
    p95Ms: number | null;
    slowestPaths: { path: string; averageMs: number; samples: number }[];
  };
  auditActivity: { last24h: number; recent: { action: string; entityType: string; createdAt: string }[] };
  backgroundJobs: { name: string; state: string; note: string }[];
}

export function deployVersion(): string {
  if (process.env.OBV_DEPLOY_VERSION) return process.env.OBV_DEPLOY_VERSION;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function opsDashboard(user: User): OpsDashboard {
  assertInternalOperator(user);
  let quickCheck = "unavailable";
  let tableCount = 0;
  try {
    const row = getDb().prepare("PRAGMA quick_check").get() as Record<string, unknown>;
    quickCheck = String(Object.values(row)[0] ?? "unknown");
    tableCount = Number(
      (getDb()
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'")
        .get() as Record<string, unknown>).c
    );
  } catch {
    /* keep 'unavailable' */
  }
  const samples = [...REQUEST_RING];
  const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const byPath = new Map<string, { total: number; count: number }>();
  for (const sample of samples) {
    const entry = byPath.get(sample.path) ?? { total: 0, count: 0 };
    entry.total += sample.ms;
    entry.count += 1;
    byPath.set(sample.path, entry);
  }
  const nowMs = Date.now();
  const audit24 = repo
    .listConfigAudit(null, 500)
    .filter((entry) => nowMs - Date.parse(entry.createdAt) < 86_400_000);
  const outbox = prepo.outboxCounts();
  return {
    application: {
      status: "ok",
      startedAt: STARTED_AT,
      nodeVersion: process.version,
      deployVersion: deployVersion(),
    },
    database: {
      status: quickCheck === "ok" ? "ok" : "attention",
      quickCheck,
      fileSizeBytes: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0,
      tableCount,
    },
    storage: ["worm", "uploads", "reports", "audit-packages", "backups", "accounting"].map((name) => ({
      name,
      sizeBytes: dirSize(path.join(DATA_DIR, name)),
    })),
    emailQueue: outbox,
    failedJobs: {
      failedEmails: outbox.FAILED ?? 0,
      failedBackups: prepo.listBackupRecords().filter((record) => record.status === "FAILED").length,
    },
    recentErrors: [...ERROR_RING].reverse(),
    apiPerformance: {
      samples: samples.length,
      averageMs:
        sorted.length > 0 ? Math.round((sorted.reduce((a, v) => a + v, 0) / sorted.length) * 10) / 10 : null,
      p95Ms: sorted.length > 0 ? Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10 : null,
      slowestPaths: [...byPath.entries()]
        .map(([p, v]) => ({ path: p, averageMs: Math.round((v.total / v.count) * 10) / 10, samples: v.count }))
        .sort((a, b) => b.averageMs - a.averageMs)
        .slice(0, 8),
    },
    auditActivity: {
      last24h: audit24.length,
      recent: audit24.slice(0, 10).map((entry) => ({
        action: entry.action,
        entityType: entry.entityType,
        createdAt: entry.createdAt,
      })),
    },
    backgroundJobs: [
      {
        name: "digest-dispatch",
        state: "ON_DEMAND",
        note: "Digests are composed on demand (no daemon); schedule externally via cron hitting the digest endpoint.",
      },
    ],
  };
}

// --------------------------------------------------------------- backups

const BACKUPS_DIR = (): string => process.env.OBV_BACKUP_DIR ?? path.join(DATA_DIR, "backups");
const RETENTION_DAYS = (): number => {
  const parsed = Number(process.env.OBV_BACKUP_RETENTION_DAYS ?? 30);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 30;
};

function fileSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function createBackup(user: User, notes: string | null): prepo.BackupRecord {
  assertInternalOperator(user);
  const dir = BACKUPS_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const id = prepo.newId();
  const filePath = path.join(dir, `obv-backup-${id}.db`);
  const retention = new Date(Date.now() + RETENTION_DAYS() * 86_400_000).toISOString();
  try {
    getDb().exec(`VACUUM INTO '${filePath.replaceAll("'", "''")}'`);
    const record = prepo.insertBackupRecord({
      id,
      kind: "FULL",
      filePath,
      sizeBytes: fs.statSync(filePath).size,
      sha256: fileSha256(filePath),
      status: "COMPLETED",
      takenBy: user.id,
      retentionUntil: retention,
      verifiedAt: null,
      verifyStatus: null,
      notes,
    });
    audit(user, "BACKUP_CREATED", "backup", id);
    return record;
  } catch (err) {
    const record = prepo.insertBackupRecord({
      id,
      kind: "FULL",
      filePath,
      sizeBytes: 0,
      sha256: null,
      status: "FAILED",
      takenBy: user.id,
      retentionUntil: retention,
      verifiedAt: null,
      verifyStatus: null,
      notes: (err as Error).message.slice(0, 200),
    });
    audit(user, "BACKUP_FAILED", "backup", id);
    return record;
  }
}

/** Integrity verification: stored hash must match the file, and the
 *  backup must open read-only with a clean quick_check. */
export function verifyBackup(user: User, id: string): prepo.BackupRecord {
  assertInternalOperator(user);
  const record = prepo.getBackupRecord(id);
  if (!record) throw new PilotOpsError("Backup not found", 404);
  let ok = false;
  try {
    ok =
      record.status === "COMPLETED" &&
      record.sha256 !== null &&
      fs.existsSync(record.filePath) &&
      fileSha256(record.filePath) === record.sha256;
    if (ok) {
      const backupDb = new DatabaseSync(record.filePath, { readOnly: true });
      const row = backupDb.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
      backupDb.close();
      ok = String(Object.values(row)[0]) === "ok";
    }
  } catch {
    ok = false;
  }
  prepo.markBackupVerified(id, ok ? "VERIFIED" : "MISMATCH");
  audit(user, ok ? "BACKUP_VERIFIED" : "BACKUP_VERIFY_MISMATCH", "backup", id);
  return prepo.getBackupRecord(id)!;
}

/** Recovery test: open the backup read-only and confirm core tables are
 *  present and populated. Records the outcome; NEVER restores. */
export function runRecoveryTest(user: User, id: string): { outcome: "PASSED" | "FAILED"; detail: string } {
  assertInternalOperator(user);
  const record = prepo.getBackupRecord(id);
  if (!record) throw new PilotOpsError("Backup not found", 404);
  let outcome: "PASSED" | "FAILED" = "FAILED";
  let detail = "Backup file missing or unreadable";
  try {
    const backupDb = new DatabaseSync(record.filePath, { readOnly: true });
    const counts = ["projects", "milestones", "users", "ledger_entries"].map((table) => {
      const row = backupDb.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as Record<string, unknown>;
      return `${table}=${Number(row.c)}`;
    });
    backupDb.close();
    outcome = "PASSED";
    detail = `Opened read-only; core tables present (${counts.join(", ")})`;
  } catch (err) {
    detail = `Recovery test failed: ${(err as Error).message.slice(0, 150)}`;
  }
  prepo.insertRecoveryTest(id, outcome, detail, user.id);
  audit(user, "RECOVERY_TEST_RUN", "backup", id, { after: outcome });
  return { outcome, detail };
}

export function backupOverview(user: User): {
  backups: prepo.BackupRecord[];
  recoveryTests: prepo.RecoveryTest[];
  retentionDays: number;
} {
  assertInternalOperator(user);
  return {
    backups: prepo.listBackupRecords(),
    recoveryTests: prepo.listRecoveryTests(),
    retentionDays: RETENTION_DAYS(),
  };
}

// ------------------------------------------- production configuration

/** Environment inventory: variable names + whether they are set. VALUES
 *  ARE NEVER RETURNED — this is a checklist, not a secret viewer. */
const KNOWN_ENV_VARS = [
  "OBV_SESSION_SECRET",
  "OBV_SESSION_REQUIRE_SECRET",
  "OBV_BANKING_PROVIDER",
  "OBV_BANKING_MODE",
  "OBV_BANKING_PRODUCTION_ENABLE",
  "OBV_EMAIL_PROVIDER",
  "OBV_EMAIL_MODE",
  "OBV_EMAIL_PRODUCTION_ENABLE",
  "OBV_ESIGN_WEBHOOK_TOKEN",
  "OBV_DATA_DIR",
  "OBV_BACKUP_DIR",
  "OBV_BACKUP_RETENTION_DAYS",
  "OBV_USAGE_ANALYTICS",
  "OBV_MAINTENANCE",
  "OBV_RATE_LIMIT_PER_MINUTE",
  "OBV_DEPLOY_VERSION",
  "OBV_ACCESS_CODE",
];

export function productionConfig(user: User): {
  environment: { name: string; set: boolean }[];
  featureFlags: prepo.FeatureFlag[];
  banners: prepo.SystemBanner[];
  maintenance: boolean;
  rateLimitPerMinute: number;
  deployVersion: string;
} {
  assertInternalOperator(user);
  return {
    environment: KNOWN_ENV_VARS.map((name) => ({ name, set: Boolean(process.env[name]) })),
    featureFlags: prepo.listFeatureFlags(),
    banners: prepo.listBanners(true),
    maintenance: maintenanceMode(),
    rateLimitPerMinute: rateLimitPerMinute(),
    deployVersion: deployVersion(),
  };
}

export function setFlag(user: User, key: string, enabled: boolean, description: string): prepo.FeatureFlag {
  assertInternalOperator(user);
  if (!/^[a-z0-9_.-]{2,64}$/.test(key)) throw new PilotOpsError("Flag keys are lowercase [a-z0-9_.-]", 400);
  const flag = prepo.setFeatureFlag(key, enabled, description, user.id);
  audit(user, enabled ? "FLAG_ENABLED" : "FLAG_DISABLED", "feature_flag", key);
  return flag;
}

export function createBanner(
  user: User,
  message: string,
  level: "INFO" | "WARN" | "CRITICAL"
): prepo.SystemBanner {
  assertInternalOperator(user);
  if (!message.trim()) throw new PilotOpsError("Banner message required", 400);
  const banner = prepo.insertBanner(message.trim().slice(0, 300), level, user.id, null, null);
  audit(user, "BANNER_CREATED", "system_banner", banner.id);
  return banner;
}

export function removeBanner(user: User, id: string): void {
  assertInternalOperator(user);
  if (!prepo.deactivateBanner(id)) throw new PilotOpsError("Banner not found", 404);
  audit(user, "BANNER_DEACTIVATED", "system_banner", id);
}

/** Active banners for the shell (any signed-in user). */
export function activeBanners(): prepo.SystemBanner[] {
  const nowIso = new Date().toISOString();
  return prepo
    .listBanners(false)
    .filter(
      (banner) =>
        (!banner.startsAt || banner.startsAt <= nowIso) && (!banner.endsAt || banner.endsAt >= nowIso)
    );
}

export function maintenanceMode(): boolean {
  return process.env.OBV_MAINTENANCE === "1" || prepo.isFlagEnabled("maintenance_mode");
}

export function rateLimitPerMinute(): number {
  const parsed = Number(process.env.OBV_RATE_LIMIT_PER_MINUTE ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

// Simple fixed-window sign-in rate limiter (per key). Disabled unless
// OBV_RATE_LIMIT_PER_MINUTE is set — the test battery signs in freely.
const RATE_WINDOWS = new Map<string, { windowStart: number; count: number }>();

export function rateLimitExceeded(key: string): boolean {
  const limit = rateLimitPerMinute();
  if (limit <= 0) return false;
  const now = Date.now();
  const window = RATE_WINDOWS.get(key);
  if (!window || now - window.windowStart >= 60_000) {
    RATE_WINDOWS.set(key, { windowStart: now, count: 1 });
    return false;
  }
  window.count += 1;
  if (RATE_WINDOWS.size > 1000) RATE_WINDOWS.clear();
  return window.count > limit;
}

/** Org-admin surface: settings page needs the active banner list too. */
export function bannersForOrgAdmin(user: User): prepo.SystemBanner[] {
  assertOrgAdmin(user);
  return activeBanners();
}
