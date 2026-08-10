#!/usr/bin/env node
/**
 * Operator/scheduler backup command.
 *
 *   npm run backup            create a backup and verify it
 *   npm run backup -- --list  list recorded backups (newest first)
 *
 * Designed for an EXTERNAL scheduler (cron, Render cron job, systemd
 * timer): exit code 0 only when the backup completed AND verified, so a
 * scheduler alert fires on anything less. Runs against the SAME data
 * directory as the server (OBV_DATA_DIR); VACUUM INTO from a second
 * connection is safe under WAL while the server stays up.
 *
 * Prints ids, sizes, hashes and timestamps — never secrets.
 */
const path = require("node:path");

async function main() {
  const { createBackup, verifyBackup, listBackups } = require(path.join(
    __dirname, "..", "dist", "server", "services", "ops", "backups.js"
  ));
  if (process.argv.includes("--list")) {
    for (const b of listBackups(50)) {
      console.log(
        `${b.createdAt}  ${b.id}  ${b.status}/${b.verificationStatus}  ` +
          `${b.sizeBytes ?? "?"} bytes  schema v${b.schemaVersion ?? "?"}  retain until ${b.retentionUntil ?? "—"}`
      );
    }
    return;
  }
  const record = createBackup(null);
  if (record.status !== "COMPLETED") {
    console.error(`BACKUP FAILED: ${record.error ?? "unknown"}`);
    process.exit(1);
  }
  const verified = verifyBackup(record.id);
  console.log(
    `backup ${verified.id}: ${verified.status}, verification ${verified.verificationStatus}, ` +
      `${verified.sizeBytes} bytes, sha256 ${verified.sha256.slice(0, 16)}…, schema v${verified.schemaVersion}`
  );
  if (verified.verificationStatus !== "VERIFIED") {
    console.error("BACKUP VERIFICATION FAILED — do not rely on this backup.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`BACKUP FAILED: ${err.message ?? err}`);
  process.exit(1);
});
