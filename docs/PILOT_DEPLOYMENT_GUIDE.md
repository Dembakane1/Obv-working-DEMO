# Pilot Deployment Guide

How to stand up an OBV instance for a pilot. OBV is a single Node
process with zero runtime dependencies (SQLite via `node:sqlite`,
sessions via `node:crypto`), so a deployment is: build, seed, start,
and set a handful of environment variables. Every claim below matches
the implementation in `src/server/http/server.ts`,
`src/server/http/session.ts`, and `src/server/services/pilotOps/`.

## Prerequisites

- Node **>= 22.5** (enforced via `package.json` engines; `node:sqlite`
  requires it).
- `npm ci` — installs build-time dev dependencies only; the runtime has
  none.
- `npm run build` — compiles server + client TypeScript and generates
  icons.
- `npm run seed` — creates and seeds the SQLite database
  (`node dist/server/db/seed.js`). `npm run setup` does build + seed.
- `npm start` — runs `dist/server/http/server.js`. Startup performs
  three checks (database, banking provider, session configuration) and
  refuses to start with a one-line instruction if any fails.

## Environment variables

Values are never displayed anywhere in the application — the internal
console shows only variable names and set/unset state. Never commit or
paste a real secret.

| Variable | Meaning |
| --- | --- |
| `OBV_SESSION_SECRET` | HMAC key for signed session cookies. **Minimum 32 characters**; shorter values refuse startup. Unset in demo mode, an ephemeral per-boot secret is minted (sessions do not survive restarts — disclosed at boot). Generate with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. |
| `OBV_SESSION_REQUIRE_SECRET` | `1`/`true` declares production posture: startup fails without a real secret, and the passwordless demo role switcher is disabled. `OBV_BANKING_MODE=production` implies the same posture. |
| `OBV_DATA_DIR` | Data root (SQLite db, uploads, WORM evidence, reports, backups, accounting exports). Point at a persistent volume on hosted deployments. |
| `OBV_ACCESS_CODE` | Optional deployment-wide access gate: every page/API requires the code once per browser (7-day cookie derived from the code, never the code itself). `/api/health`, invitation activation links, and integration webhooks stay reachable. |
| `OBV_BANKING_PROVIDER` / `OBV_BANKING_MODE` / `OBV_BANKING_PRODUCTION_ENABLE` | Banking stays `mock` / `demo` for pilots. A non-mock provider is refused at startup unless mode is `production` AND the enable flag is `true` — a pilot cannot accidentally touch real money movement. |
| `OBV_EMAIL_PROVIDER` / `OBV_EMAIL_MODE` / `OBV_EMAIL_PRODUCTION_ENABLE` | Transactional email. Default provider `log` records every send in the `email_outbox` and delivers nothing off the machine. A live provider is refused unless `OBV_EMAIL_MODE=production` AND `OBV_EMAIL_PRODUCTION_ENABLE=true`. |
| `OBV_ESIGN_WEBHOOK_TOKEN` | Shared secret for `/api/esign/webhook/:provider`. With no token configured, webhook intake is refused entirely (nondisclosing 404). |
| `OBV_BACKUP_DIR` / `OBV_BACKUP_RETENTION_DAYS` | Backup destination (default `<data>/backups`) and retention marker (default 30 days). Backups are `VACUUM INTO` snapshots with SHA-256 verification; there is deliberately no restore code path in the application. |
| `OBV_USAGE_ANALYTICS` | `1` enables opt-in page-view usage rows for pilot adoption analytics. Off by default so GET requests never write. |
| `OBV_MAINTENANCE` | `1` enables maintenance mode (also available via the `maintenance_mode` feature flag, no restart needed). |
| `OBV_RATE_LIMIT_PER_MINUTE` | Sign-in rate limit, fixed one-minute window keyed per source address. Disabled when unset. Exceeded attempts get 429. |
| `OBV_DEPLOY_VERSION` | Reported by `/api/health` and the internal console; falls back to `package.json` version. |

## Health endpoint

`GET /api/health` is always open — before the access gate and
maintenance check — and returns no secrets or paths:

- `status` — `ok` or `degraded` (degraded returns HTTP 503)
- `database` — `connected` / `unavailable`
- `reportRenderer` — `pdf` or `html-fallback`
- `aiMode` — `live-capable` / `fallback-only`
- `teamsMode` — `configured` / `demo`
- `version` — short deployed git commit (from `RENDER_GIT_COMMIT` /
  `OBV_GIT_COMMIT`), so the live build is verifiable from outside
- `deployVersion` — `OBV_DEPLOY_VERSION` or package version
- `timestamp`

## Maintenance mode

When enabled, everything except `/api/health`, public static assets,
and `/report-cache/` (so an in-flight PDF render finishes) answers
**503** — a styled maintenance page for browsers, JSON for API callers.
Internal operators (`COMPLIANCE_REVIEWER`) pass through so they can
manage the system. No governed state changes during maintenance.

## Rate limiting and banners

- Sign-in rate limiting applies only when `OBV_RATE_LIMIT_PER_MINUTE`
  is set; the test battery signs in freely without it.
- System banners (INFO / WARN / CRITICAL) are published from the
  internal console and rendered for every signed-in user; they support
  optional start/end windows and are also served at
  `GET /api/pilot-ops/banners`.

## Monitoring dashboard (`/internal`)

Internal-operator only — every other role receives a nondisclosing
404. Monitoring is in-memory plus derived: request timings and
sanitized error summaries live in bounded ring buffers (no database
writes on the request path). The dashboard shows application status and
deploy version, database `PRAGMA quick_check` and file size, per-store
storage sizes, the email outbox queue, failed jobs, recent errors
(message + status only — never stacks or payloads), API performance
(average, p95, slowest paths), audit activity over 24 hours, and
background-job posture. Digests have no daemon: schedule an external
cron against the digest endpoint if wanted.

## Deployment checklist

1. Node >= 22.5; `npm ci && npm run build && npm run seed`.
2. Set `OBV_DATA_DIR` to a persistent volume.
3. Generate and set `OBV_SESSION_SECRET` (>= 32 chars); set
   `OBV_SESSION_REQUIRE_SECRET=1` for a real pilot.
4. Set `OBV_ACCESS_CODE` if the deployment URL is guessable.
5. Leave banking mock/demo; leave email on the `log` provider.
6. Set `OBV_ESIGN_WEBHOOK_TOKEN` only if a provider will call back.
7. Optionally set `OBV_USAGE_ANALYTICS=1`, `OBV_RATE_LIMIT_PER_MINUTE`,
   `OBV_BACKUP_DIR`, `OBV_BACKUP_RETENTION_DAYS`, `OBV_DEPLOY_VERSION`.
8. `npm start`; confirm the boot lines (session posture is disclosed).
9. Probe `/api/health` from your uptime monitor.
10. Sign in as the internal operator, open `/internal`, verify the
    environment checklist, take a backup, verify it, run a recovery
    test.
