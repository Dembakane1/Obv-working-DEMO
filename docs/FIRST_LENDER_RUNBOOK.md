# First Lender Runbook — zero to first draw

Written for the OBV operator provisioning and supporting the FIRST real
external lender. Every step uses surfaces that exist on this branch; no
step requires editing the database by hand.

## 1. Provision the pilot deployment

1. Render → New → Blueprint → uncomment the `obv-pilot` service in
   `render.yaml`. A **paid instance** is required (persistent disks are
   not available on the free plan; the pilot cannot run on ephemeral
   storage).
2. In the dashboard, set the `sync: false` values:
   - `OBV_POSTMARK_SERVER_TOKEN` — Postmark → Servers → API Tokens.
   - `OBV_EMAIL_FROM` — a **verified sender signature** in Postmark.
   - `OBV_BOOTSTRAP_ADMIN_EMAIL` — YOUR real operator address.
   - `OBV_PUBLIC_BASE_URL` — the service URL (emailed links use it).
3. Deploy. First boot: empty schema + the bootstrap identity/org
   (`OBV_BOOTSTRAP_ORG_NAME`, default "OBV Operations") — never demo
   data (`seedDemo` refuses in pilot posture).

## 2. Verify pilot readiness

In a service shell: `npm run pilot:check`. Fix every FAIL — a FAIL means
external traffic must not begin. Expect on a fresh host: `latest backup
verified` FAILs until step 6. Confirm the boot log shows
`environment: PILOT`, the storage disclosure, and
`link delivery: EMAIL`.

## 3. Create the lender organization + administrator

1. Sign in at `/signin` with the bootstrap email (magic link arrives by
   real email).
2. Setup → create the lender organization (or use the bootstrap org),
   plus counterparty organizations (borrower/contractor).
3. Invite the lender's administrator by email
   (`POST /api/pilot/invitations` / the Setup page). The activation link
   is emailed to the invitee (redacted at rest) and shown once to you.
   Acceptance creates their identity, verifies their email, and — for a
   brand-new identity — signs them in; existing identities sign in with
   their own email (activation links never bridge accounts).

## 4. Configure users, policy, project

1. Invite reviewers (`COMPLIANCE_REVIEWER`), the head of lending
   (`FUNDER_REP`), the borrower's ops manager (`PROJECT_MANAGER` in the
   borrower org), and field staff (`FIELD`, project-scoped so the field
   assignment is automatic).
2. Create the project in Setup: template, geography, draw structure
   (tranches must reconcile), dual-control approval matrix, evidence
   requirements, lender policy (`/api/projects/:id/lender-policy`).
3. Grant project memberships (capability truth):
   the FUNDER_REP bootstraps the first membership — make it the ops
   administrator as `ADMINISTRATOR` (MANAGE_USERS) — then grant
   `LENDER_REVIEWER` (decision capability) and `BORROWER`
   (document upload) memberships explicitly. Every grant is audited.
4. Launch the project. Launch snapshots configuration and releases
   NOTHING.
5. Check `/api/ops/checklist` — the deterministic "ready for the first
   draw" derivation (organization, reviewers, project readiness, email
   operational, notification delivered, backup fresh, storage healthy).

## 5. Test notification delivery

Integrations → send the test email to yourself, or rely on the first
governed event. Verify on `/api/ops/status`: email stats SENT > 0, no
recent failures. Recipient routing records ("why did this user receive
this?") appear under `recentAddressedNotifications`.

## 6. Test backup + restore

1. `npm run backup` (or POST `/api/ops/backups`) — exit 0 = created AND
   verified. Schedule it (Render cron job) at least daily.
2. Restore DRILL (never against production): run
   `node scripts/backup-restore-test.js` in a shell — it proves the
   whole cycle in isolated temp directories.

## 7. Controlled test draw

Run the full loop with fictional-but-realistic content BEFORE the
lender's real draw: borrower submits the draw (period + reconciling
lines), supplies required documents (pay application, invoice, lien
waiver), reviewer reviews lines, head of lending sends to governance,
dual-control approvals (the submitter can never approve), reviewer
records the lender decision, generate the lender package
(`/api/draws/:id/verification-package`), verify the timeline and the
audit trail, and confirm ROI measurements at `/api/pilot/roi` (export:
`/api/pilot/roi/export.csv`).

## 8. Begin the live pilot

Re-run `npm run pilot:check` (expect READY), confirm backup freshness,
then hand the lender their sign-in instructions (their email at
`/signin` — nothing else).

---

## Real-world RESTORE procedure (there is deliberately no restore button)

1. **Stop the application** (scale to zero / suspend).
2. **Preserve the damaged state**: copy the entire current data root
   (obv.db + -wal/-shm, uploads/, worm/, reports/, audit-packages/) to a
   quarantine location. Never investigate in place.
3. **Validate the backup checksum**: compare `sha256sum` of the chosen
   `backups/obv-backup-<id>.db` against its `backup_records.sha256`
   (visible in `/api/ops/status` before the outage, or from the
   quarantined database read-only).
4. **Restore to a NEW location**: copy the backup file to
   `<new-root>/obv.db`; copy `worm/`, `uploads/`, `reports/`,
   `audit-packages/` beside it (file artifacts are not inside the
   SQLite backup).
5. **Integrity-check the restored copy**:
   `PRAGMA quick_check` + core-table counts (the drill script's checks).
6. **Start an isolated verification instance** against the new root
   (different port, `OBV_ENVIRONMENT=pilot`) and validate key
   organization/project/draw records with the lender's administrator.
7. **Promote**: point the production service's `OBV_DATA_DIR` volume at
   the restored root (or copy it onto the volume), start, run
   `npm run pilot:check`.
8. **Retain the quarantined original** for investigation; record the
   incident (below).

## Rollback (bad deploy, data intact)

Render → the service → Rollback to the previous image. Data is on the
persistent disk and unaffected. If a deploy also migrated the schema
forward, note that OLDER builds refuse NEWER databases (schema-version
wall) — roll forward with a fix, or restore the pre-deploy backup per
the procedure above.

## Support severity levels (no fabricated SLAs)

- **SEV-1** — security breach, tenant-isolation failure, data loss, or
  corrupted governance records. Stop external traffic; preserve state;
  investigate before any restart.
- **SEV-2** — the pilot cannot process draws (sign-in down, submissions
  or approvals failing). Work continuously until restored.
- **SEV-3** — a major feature degraded with a workaround (e.g. email
  delivery failing while in-app notifications work).
- **SEV-4** — cosmetic/minor. Batch into normal work.

Every support request should carry the **X-Request-Id** from the
affected response (generic errors quote it as "reference <id>"); find
the matching `[error] [rid=...]` log line and the surrounding
`/api/ops/status` state. The operator view exposes organization,
project, draw, event type, provider outcome and sanitized error class —
never another tenant's data, never secrets.
