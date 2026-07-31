# Disaster Recovery Guide

Backup creation, verification, and recovery testing are built into the
internal operator console. Restoring is not: **OBV deliberately has no
restore code path anywhere in the application.** A restore endpoint
would be a data-destruction primitive behind a web route; restoring is
a human operation performed outside the application, documented below.

Implementation: `src/server/services/pilotOps/operations.ts`; records
in `backup_records` and the append-only `recovery_tests` table. All
backup actions are internal-operator-only and audited in
`config_audit`.

## Creating backups

`POST /api/internal/backups` snapshots the live SQLite database with
`VACUUM INTO` — a consistent, compacted copy taken without stopping
the server — into `OBV_BACKUP_DIR` (default: `backups/` under the data
directory) as `obv-backup-<id>.db`. Each backup records:

- file path and size,
- **SHA-256 of the backup file**, computed at creation,
- status `COMPLETED` or `FAILED` (failures keep a sanitized message),
- who took it, when, and its retention-until date.

## Integrity verification

`POST /api/internal/backups/:id/verify` marks a backup `VERIFIED` only
if all three hold:

1. the stored SHA-256 still matches the file on disk (no corruption
   or tampering since creation),
2. the file opens as a SQLite database **read-only**,
3. `PRAGMA quick_check` returns `ok`.

Anything else marks `MISMATCH`. Verification never writes to the
backup file.

## Recovery testing

`POST /api/internal/backups/:id/recovery-test` opens the backup
read-only and confirms the core tables (`projects`, `milestones`,
`users`, `ledger_entries`) are present and countable. The outcome
(`PASSED`/`FAILED`, with detail) is appended to the `recovery_tests`
log. **A recovery test never restores anything** — it proves the
backup would be usable, on a schedule you choose, without touching the
live database.

## Retention

`OBV_BACKUP_RETENTION_DAYS` (default **30**) sets the retention-until
date stamped on each backup record. OBV records the date but never
deletes backup files itself — pruning expired files from the backup
directory is an operator task, so an automated bug can never destroy
the last good backup.

## Manual restore procedure

There is no restore button. When a restore is genuinely required:

1. **Choose and verify the backup.** Prefer one already `VERIFIED`
   with a `PASSED` recovery test. If the server is still up, run
   verify + recovery-test from `/internal` now.
2. **Preserve the current state.** If the live database is readable,
   take one final backup (or copy `obv.db` aside) so the pre-restore
   state is never lost.
3. **Stop the server.** No writes may occur during the copy.
4. **Copy the verified backup over the live database:**
   `cp <backup-file> $OBV_DATA_DIR/obv.db`
   Remove any stale `obv.db-wal` / `obv.db-shm` files alongside it.
5. **Restart the server.**
6. **Verify.** `GET /api/health` must report `status: ok` and
   `database: connected`. Sign in and spot-check records: projects,
   a recent draw, the audit trail, and the operations dashboard's
   database panel (`quick_check: ok`).
7. **Record the action** (when, which backup, why, verified by whom).

## What VACUUM INTO does not cover

`VACUUM INTO` copies **only the SQLite database**. On-disk artifact
directories under the data directory are referenced by the database
but live outside it:

- `worm/` — WORM evidence media (the primary evidence artifacts;
  object names are the published evidence hashes),
- `uploads/` — branding and uploaded files,
- `reports/` and `audit-packages/` — generated documents,
- `accounting/` — exported CSVs.

These need separate **file-level backup** (rsync, snapshots, or your
platform's volume backups) on the same schedule. After a restore,
evidence content hashes recorded in the database let you confirm the
WORM store matches the restored records.

## What this layer never does

Restore automatically · modify or delete a backup file after creation
· delete expired backups · expose backup contents through the API ·
substitute for file-level backup of the WORM/uploads/reports
directories.
