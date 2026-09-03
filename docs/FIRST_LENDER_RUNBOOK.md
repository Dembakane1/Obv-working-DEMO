# First Lender Runbook — zero to first draw

Written for the OBV operator provisioning and supporting the FIRST real
external lender. Every step uses surfaces that exist on this branch; no
step requires editing the database by hand. Where this runbook and the
code disagree, the code wins: re-read `scripts/pilot-check.js`,
`render.yaml` and the startup checks in `src/server/http/server.ts`, then
fix the runbook.

## What you are provisioning

- ONE Node 22 process in ONE Docker container (the repository
  `Dockerfile`), started by Render from the `obv-pilot` service in
  `render.yaml`.
- SQLite (`node:sqlite`, WAL) on ONE persistent Render disk mounted at
  `/var/data`, which is `OBV_DATA_DIR`. Database, uploads, WORM evidence,
  reports, audit packages and backups all live under it.
- ONE writer: `numInstances: 1`. Never scale the service — two replicas on
  one SQLite file corrupt it silently. `/api/ready` and `pilot:check` both
  disclose the one-writer limit.
- `OBV_ENVIRONMENT=pilot`: the demo role switcher, demo reset and golden
  seed are disabled at startup (the switcher and reset routes answer 404),
  and every banking simulation route is refused by the service wall (403).
- Real passwordless identity: magic links delivered by Postmark
  (`OBV_AUTH_LINK_DELIVERY=email`, `OBV_EMAIL_PROVIDER=postmark`). There is
  no outbox fallback in this posture — a misconfigured provider refuses to
  start rather than silently swallowing sign-in links.
- Banking: `OBV_BANKING_PROVIDER=mock` only. No real money moves through
  OBV during the pilot.
- No demo data, ever: the container never runs the demo seed in pilot
  posture, and `seedDemo()` refuses at the service level as well.
- Deploys restart the process. A Render service with an attached disk is
  single-instance and deploys with a brief interruption; data and
  sessions survive because both live on the disk and sessions are signed
  with a stable `OBV_SESSION_SECRET`.

The public demo (`obv-demo`) stays exactly as it is. The pilot is a
SEPARATE service, disk, database and URL; nothing is shared.

## 1. Provision the pilot deployment

### 1.1 Postmark (manual, one-time)

1. Create the Postmark server that will send for the pilot.
2. Add a **Sender Signature** for the address you will use as
   `OBV_EMAIL_FROM` (or verify the whole domain with DKIM and Return-Path
   records). Postmark refuses to send from an unverified address: with an
   unverified sender every magic link and invitation is recorded FAILED
   and nobody can sign in.
3. Servers → API Tokens → copy a **Server API token**. This is
   `OBV_POSTMARK_SERVER_TOKEN`. It is a secret: enter it only in the Render
   dashboard — never in the repository, `.env.example`, a ticket or a chat.
4. Message Streams: OBV sends on the `outbound` transactional stream by
   default. Only set `OBV_POSTMARK_MESSAGE_STREAM` if you created a
   different transactional stream; never point it at a broadcast stream.
5. New Postmark accounts start restricted to recipients on your own
   verified domains. Request account approval before inviting anyone
   outside your domain, or the lender's invitation will be refused. Use
   a **live** server token, never Postmark's test token or a sandbox
   server: those report success without delivering anything, and
   `pilot:check` cannot tell them apart from a live token.

### 1.2 Render (manual, one-time)

1. Render → New → Blueprint → connect this repository. Before applying,
   uncomment the `obv-pilot` service in `render.yaml` (leave `obv-demo`
   untouched) on the branch Render deploys from (`branch: main`).
2. Pick a **paid instance type** (`plan: starter` or larger). Persistent
   disks are not available on the free plan; the pilot cannot run on
   ephemeral storage.
3. Keep the disk block: `obv-pilot-data`, `mountPath: /var/data`, 5 GB.
   `OBV_DATA_DIR` must equal the mount path.
4. Keep `numInstances: 1`. Never enable autoscaling or manual scaling on
   this service. Keep `autoDeploy: false`: the pilot deploys only when you
   press Manual Deploy, never on every push to `main`; re-run
   `npm run pilot:check` after each deploy.
5. Health check path `/api/ready`: deploys are gated on readiness
   (database, storage, identity and email configuration all valid), not
   mere liveness.
6. On Apply, Render prompts for every `sync: false` key. Enter
   `OBV_POSTMARK_SERVER_TOKEN`, `OBV_EMAIL_FROM`,
   `OBV_BOOTSTRAP_ADMIN_EMAIL` and `OBV_PUBLIC_BASE_URL` (the service URL,
   e.g. `https://obv-pilot.onrender.com`, or the custom domain once it is
   attached). Leave `OBV_BOOTSTRAP_ORG_NAME` and `OBV_ACCESS_CODE` empty
   unless you deliberately want them.
7. `OBV_SESSION_SECRET` is `generateValue: true`: Render mints it once and
   keeps it. The server refuses to start without it; rotate it only
   deliberately.
8. After the first deploy, open the service Shell in the dashboard (or
   the SSH command shown on the service page). Every `npm run …` operator
   command below runs there, in `/app`, against the live disk.

### 1.3 Environment matrix

The one source of truth for the pilot's configuration. The last column
describes what the CODE does (`src/server/services/posture.ts`,
`ops/storage.ts`, `http/session.ts`, `identity/core.ts`,
`integrations/core.ts`, `integrations/email.ts`, `banking/registry.ts`,
`scripts/pilot-check.js`), not what anyone hopes it does.

| VARIABLE | REQUIRED? | SECRET? | WHO PROVIDES | EXAMPLE SHAPE | WHAT FAILS IF MISSING / WRONG |
|---|---|---|---|---|---|
| `OBV_ENVIRONMENT` | REQUIRED, exactly `pilot` | no | blueprint | `pilot` | Unset = demo posture: switcher, seed and simulation are live and none of the production refusals apply; `pilot:check` WARNs "environment". Any value other than `demo`/`pilot`/`production` refuses startup. |
| `OBV_DATA_DIR` | REQUIRED | no | blueprint (= `disk.mountPath`) | `/var/data` | Startup refusal "OBV_DATA_DIR must be set in the pilot environment"; `pilot:check` FAIL "persistent data root". |
| `OBV_SESSION_SECRET` | REQUIRED, ≥ 32 characters | YES | Render `generateValue: true` | 64 hex characters | Startup refusal "OBV_SESSION_SECRET is required in production" (a short value refuses too). It signs cookies; identity sessions themselves are server-side rows on the disk. |
| `OBV_AUTH_LINK_DELIVERY` | REQUIRED, exactly `email` | no | blueprint | `email` | Unset in pilot: startup refusal "must be set explicitly in production". `file` or `off`: the server starts but `pilot:check` FAILs "auth link delivery" — external users cannot sign in. |
| `OBV_EMAIL_PROVIDER` | REQUIRED, `postmark` | no | blueprint | `postmark` | Unset or `outbox` with `email` delivery: startup refusal "requires a real email provider" (no silent fallback). |
| `OBV_INTEGRATIONS_PRODUCTION_ENABLE` | REQUIRED, `true` | no | blueprint | `true` | Startup refusal "An external integration provider is configured but OBV_INTEGRATIONS_PRODUCTION_ENABLE is not 'true'". |
| `OBV_POSTMARK_SERVER_TOKEN` | REQUIRED | YES | Postmark → Servers → API Tokens, entered in the Render dashboard | opaque token | Startup refusal naming `OBV_POSTMARK_SERVER_TOKEN` (validated at boot, never at first send); `pilot:check` FAIL "email provider". A wrong token: every send recorded FAILED with a sanitized error — the token is never logged. |
| `OBV_EMAIL_FROM` | REQUIRED | no (tenant-specific) | operator — a Postmark verified Sender Signature or verified domain | `obv@yourlender.com` | Startup refusal at boot. Unverified in Postmark: sends recorded FAILED, nobody can sign in. |
| `OBV_POSTMARK_MESSAGE_STREAM` | optional | no | Postmark → Message Streams | `outbound` (default) | Default used. A stream id that does not exist makes Postmark refuse every send. |
| `OBV_EMAIL_TIMEOUT_MS` | optional | no | — | `10000` (default) | Default used. |
| `OBV_BOOTSTRAP_ADMIN_EMAIL` | REQUIRED for the first boot | no | the OBV operator's real mailbox | `ops@yourcompany.com` | First boot creates no identity, so nobody can ever sign in; `pilot:check` FAIL "admin identity". A malformed address refuses startup. Ignored once any identity exists. |
| `OBV_BOOTSTRAP_ORG_NAME` | optional | no | operator | `OBV Operations` (default) | Default name used for the founding organization. |
| `OBV_PUBLIC_BASE_URL` | REQUIRED (falls back to Render's `RENDER_EXTERNAL_URL`) | no | operator — the service URL or custom domain | `https://obv-pilot.onrender.com` | If neither is set: `pilot:check` FAIL "public base URL" and emailed links would use the request host. Set it explicitly once a custom domain is attached. |
| `OBV_BANKING_PROVIDER` | optional, must stay `mock` | no | blueprint | `mock` (default) | Any non-mock value: startup refusal without the banking production switches, and `pilot:check` FAIL "banking provider" regardless. |
| `OBV_ACCESS_CODE` | OPTIONAL (defense-in-depth) | YES, if set | operator | a 12+ character phrase | Nothing fails. Identity is the access boundary; `/api/health`, `/api/ready`, `/signin`, the magic-link and invitation routes stay reachable either way. If set, share it out of band. |
| `OBV_BACKUP_DIR` | optional | no | — | `/var/data/backups` (default) | Default under the data root. If set, it MUST be on the persistent disk. |
| `OBV_BACKUP_RETENTION_DAYS` | optional | no | — | `30` (default) | Default retention metadata. |
| `PORT` | platform | no | Render injects it; the image defaults to `10000` | `10000` | Nothing to set. |
| `OBV_PILOT_CHECK_SKIP_NET` | only on the `pilot:check` command line | no | operator | `1` | Skips the Postmark reachability probe (reported WARN, never silently). |

| `OBV_PILOT_NOTIFY_EMAIL` | optional — normally UNSET | no | operator | `ops@yourcompany.com` | Unset: no ops alias in pilot posture. If set, that mailbox receives a copy of every governed-event notification across all tenants — a data-visibility decision, not a convenience. |

Never set in the pilot: `OBV_DEMO_AUTH`, `OBV_SEED_GOLDEN` and
`OBV_BANKING_MODE=demo` are refused contradictions (startup stops);
`OBV_BANKING_PRODUCTION_ENABLE` is inert with the mock provider and out of
the pilot's scope (`pilot:check` WARNs if it is set). Optional integrations
(`ANTHROPIC_API_KEY`, `TEAMS_*`, `WHATSAPP_*`, `OBV_ESIGN_PROVIDER`,
`OBV_ACCOUNTING_PROVIDER`, official sources) are not pilot controls: leave
them unset; `pilot:check` never blocks on them.

### 1.4 First boot — exactly what happens

Precondition: an empty disk at `/var/data` and the matrix above complete.

1. Render builds the image: TypeScript compiles in the build stage; the
   runtime stage carries `dist/`, `public/`, Chromium for PDF rendering
   and the operator scripts (`pilot-check.js`, `backup.js`,
   `backup-restore-test.js`).
2. The container start command sees `OBV_ENVIRONMENT=pilot` and skips the
   demo seed entirely. Only a demo container self-seeds when its database
   is missing.
3. `node dist/server/http/server.js` runs its startup checks in order and
   refuses to start with a one-line instruction on the first failure:
   environment posture → storage (creates `uploads/`, `worm/`, `reports/`,
   `audit-packages/`, `backups/` under `/var/data`; refuses non-writable
   roots) → database (creates `/var/data/obv.db` with the current schema)
   → database safety (`quick_check` + foreign keys) → banking provider
   (mock) → session configuration → identity configuration → **identity
   bootstrap** → integrations configuration → email provider (token and
   sender validated now, not at first send).
4. Identity bootstrap: the identities table is empty and
   `OBV_BOOTSTRAP_ADMIN_EMAIL` is set, so the server creates ONE
   organization (`OBV_BOOTSTRAP_ORG_NAME`, kind LENDER), ONE
   `PROJECT_MANAGER` user titled "Administrator", ONE identity for that
   email with an owner membership, and records an `IDENTITY_BOOTSTRAPPED`
   auth event. No project, no draw, no demo fixture. On every later boot
   the table is non-empty and the step is a no-op — it can never
   duplicate or resurrect anything.
5. The boot log shows `OBV running at …`, then
   `environment: PILOT — demo switcher/reset/seed and banking simulation are DISABLED`,
   the runtime platform line,
   `storage: explicit data root /var/data; database present (N bytes)`
   (the schema was created by the startup checks, so even the first boot
   reports the file as present),
   `Data store: engine=sqlite · max writer instances=1 · horizontal scale=NOT SUPPORTED …`,
   `sessions: signed with the configured OBV_SESSION_SECRET`,
   `identity: magic-link sign-in active (link delivery: EMAIL through the configured provider)`
   and the integrations line naming `postmark`. A line saying EPHEMERAL,
   DEMO or "file outbox" means the matrix is wrong: stop and fix it.
6. `/api/ready` answers 200 with
   `{ ready: true, checks: { database, storage, identity, email, accepting }, backupWithin24h: false, … }`.
   `backupWithin24h` is reported, not gating: a fresh deployment's first
   backup necessarily comes after its first boot.
7. Sign in: open `<OBV_PUBLIC_BASE_URL>/signin`, enter the bootstrap
   address; Postmark delivers the magic link (single-use, 15 minutes by
   default). The confirmation page completes the sign-in and mints a
   server-side session.
8. Persistence proof: Render → Manual Deploy (or Restart). After the
   restart the same browser is still signed in, and `/api/ops/status`
   still shows the one bootstrap identity's organization (no second
   bootstrap ran). If you were signed out, the data directory is not the
   mounted disk (identity sessions are database rows): check
   `OBV_DATA_DIR` against the disk mount.

## 2. Verify pilot readiness — the READY sequence

The order is fixed: **deploy → initialize → `npm run backup` →
`npm run pilot:check` → READY**. A FAIL from `pilot:check` means external
traffic must not begin.

1. Deploy (section 1) and confirm `/api/ready` is 200.
2. Initialize: complete the first sign-in (1.4 step 7) so the bootstrap
   identity has been exercised end to end, and confirm the boot log lines
   (`environment: PILOT`, the storage disclosure, `link delivery: EMAIL`).
3. `npm run backup` in the service shell. Exit 0 means a `VACUUM INTO`
   snapshot was created under `/var/data/backups` AND its sha256
   verified; anything else is a failure. This is why `pilot:check` cannot
   be READY on a fresh host before this step: the "latest backup verified"
   control FAILs whenever a database exists without a verified backup
   younger than 26 hours.
4. `npm run pilot:check`. Read every line. Expected on a correctly
   provisioned pilot: PASS on every control except two WARNs that are by
   design — `instance constraint` (SQLite, one writer) and
   `email reachability` only when you ran with
   `OBV_PILOT_CHECK_SKIP_NET=1`. The command never prints secret values.
5. READY — the last line reads `READY — N controls: … 0 fail`. Only now
   continue to section 3.

READY is a **configuration** verdict: `pilot:check` proves the token and
sender are present and the API endpoint answers, not that Postmark will
accept mail from this server. The **delivery** verdict is section 5 — a
real message SENT to a mailbox outside your own domain and received —
and both are required before a lender is invited. Running `pilot:check`
before the first boot FAILs the `database` control by design: initialize
first. `/api/ready` gates the platform's rollout on valid configuration;
it does not replace either verdict.

Controls `pilot:check` evaluates, all from the live environment and none
from documentation: environment, posture flags, session secret, demo
switcher, auth link delivery, email provider, email reachability, public
base URL, instance constraint, runtime platform, persistent data root,
storage writable, database integrity, no demo data (`proj-r47`,
`proj-dmv`, `proj-golden` must be absent), golden seed, backup directory,
latest backup verified, banking simulation, banking provider, admin
identity. Optional integrations (Teams, WhatsApp, AI, e-sign, accounting)
are not controls and never block.

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

## 6. Backups — requirement, schedule, drill

Requirement: a verified backup younger than 26 hours must exist for the
whole life of the pilot. `pilot:check` FAILs without one,
`/api/ops/status` reports `backups.hoursSinceLast`, and the setup
checklist (`/api/ops/checklist`) shows "backup fresh".

1. Create: `npm run backup` (exit 0 = created AND verified), or POST
   `/api/ops/backups` as a signed-in administrator (audited as
   `BACKUP_CREATED`). `npm run backup -- --list` lists recorded backups.
2. Schedule it daily. A Render **Cron Job is a separate service with its
   own filesystem**: it cannot mount the pilot's disk, so `npm run backup`
   inside a cron job would back up nothing. Run the command INSIDE the
   pilot service — either from an external scheduler over Render SSH (a
   GitHub Actions schedule or any cron host holding an SSH key registered
   with Render, running the service's SSH command followed by
   `cd /app && npm run backup` and alerting on a non-zero exit), or
   manually from the dashboard Shell every working day during the pilot.
   Whichever you choose, the 26-hour freshness control is the watchdog:
   check `/api/ops/status` daily.
3. Copy off-box at least weekly: copy the newest
   `/var/data/backups/obv-backup-<id>.db` out of the service together with
   its recorded sha256 (`npm run backup -- --list` or `/api/ops/status`).
   A disk failure takes the on-disk backups with the database. Platform
   disk snapshots, if your plan provides them, are a second layer — never
   the verified backup.
4. Restore DRILL (never against production): run
   `node scripts/backup-restore-test.js` in a shell — it proves the whole
   cycle in isolated temp directories. Run it once before the pilot and
   after every deploy that changes the schema.
5. There is no automatic restore and no restore button, by design. A
   real restore follows the procedure at the end of this document, by
   hand, with the application stopped.

## 7. Hosted controlled test — BEFORE inviting the lender

Run this on the hosted pilot itself (not on a laptop), signed in as the
bootstrap administrator, with fictional-but-realistic content in a
clearly named test organization (e.g. "TEST — not a client"). The
content stays in the pilot database as history; keep it labelled. Every
item must pass; record the date and, for any failure, the `X-Request-Id`.

1. Sign-in by magic link on the hosted URL: request, receive by real
   email, complete, land on the application. Repeat once from a phone on
   mobile data.
2. Organizations and people: create the test lender organization and its
   counterparties; invite a second real mailbox you control as the lender
   administrator; accept from that mailbox; confirm the audit rows.
3. Project: template, geography, a draw structure that reconciles,
   dual-control approval matrix, evidence requirements, lender policy;
   grant `ADMINISTRATOR`, `LENDER_REVIEWER` and `BORROWER` memberships;
   launch. `/api/ops/checklist` reaches ready-for-first-draw.
4. Draw: submit a draw with period + reconciling lines and the required
   documents (pay application, invoice, lien waiver).
5. Review and governance: line review, send to governance, dual-control
   approvals (the submitter can never approve).
6. Readiness: the draw reaches READY only once its readiness conditions
   are satisfied; the pilot command centre lists it in the lender control
   queue as LENDER_DECISION_REQUIRED.
7. Lender decision: record it. The draw leaves the queue and appears
   under recent lender decisions; no wire and no banking movement
   (`mock`).
8. Package: generate the lender package
   (`/api/draws/:id/verification-package`) — a real PDF renders on the
   host (Chromium inside the image).
9. Timeline & Site Evidence: the historical record shows the submission,
   approvals and decision with their recorded times; the CURRENT strip
   matches the live state.
10. Executive: the test project appears with the decided draw counted
    correctly.
11. Restart: Render → Manual Deploy or Restart; wait for `/api/ready` 200.
12. Persistence: the same session is still signed in; project, draw,
    decision, uploaded documents and the generated package are all still
    there; `/api/ops/status` still lists the backups taken before the
    restart.
13. Backup: `npm run backup` exits 0 after the restart.
14. Verify backup: `npm run backup -- --list` shows the new record as
    `COMPLETED/VERIFIED`; `/api/ops/status` shows it as `latestVerified`
    with `hoursSinceLast` near zero.
15. Notifications: `/api/ops/status` email stats show SENT for the
    invitation and the governed events, with no recent failures.
16. `npm run pilot:check` → READY.
17. ROI: `/api/pilot/roi` and `/api/pilot/roi/export.csv` respond.

## 8. Begin the live pilot

Re-run `npm run pilot:check` (expect READY), confirm backup freshness,
then hand the lender their sign-in instructions: their email at
`/signin` — nothing else. If you chose to set `OBV_ACCESS_CODE`, share it
out of band; identity remains the access boundary either way.

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
