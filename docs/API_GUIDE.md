# API Guide

Conventions for the OBV HTTP surface plus an inventory of the Pilot
Readiness endpoints (`/api/pilot-ops/*`, `/api/internal/*`). Routing is
thin dispatch — every authorization decision lives in the services.

## Conventions

- **Sessions.** Authentication is an HMAC-signed session cookie. In
  demo mode, `POST /api/session` with a seeded `userId` (form or JSON)
  sets the cookie — the passwordless role switcher. Only seeded demo
  identities (`user-<name>`) may be assumed; unknown, non-seeded, and
  suspended ids all produce the identical 404, so the switcher is not
  an existence oracle. Under production posture the endpoint is
  disabled entirely (`OBV_DEMO_AUTH=1|0` overrides either way).
- **Errors are JSON.** Failures return `{ "error": "…" }` with the
  status code. Intentional errors carry user-safe messages; anything
  unexpected is logged server-side and surfaced as a generic 500 —
  never stacks, internal paths, or provider details. Requests without
  a session get 401 `{ "error": "Select a demo user first" }`.
- **Same-404 doctrine.** Records outside your tenant are
  indistinguishable from records that do not exist. The internal
  console applies the same rule to whole surfaces: every
  `/api/internal/*` path answers 404 for non-operator roles.
- **Form vs JSON POSTs.** A form-encoded POST redirects back to its
  page with `?ok=1` (server-rendered flow); a JSON POST returns JSON.
  Both hit identical service code.

### Caller roles

- **Member** — any signed-in user.
- **Org admin** — `FUNDER_REP`, `PROJECT_MANAGER`, or
  `COMPLIANCE_REVIEWER`, always scoped to their own organization.
- **Internal** — `COMPLIANCE_REVIEWER` only; all others get 404.
- **Token** — sessionless, shared-secret guarded.

## Pilot Readiness endpoints

| Method | Path | Purpose | Who |
| --- | --- | --- | --- |
| POST | `/api/esign/webhook/:provider?token=…` | E-sign provider event intake | Token |
| GET | `/api/pilot-ops/onboarding` | Onboarding status + settings | Org admin |
| POST | `/api/pilot-ops/onboarding/step` | Mark an onboarding step complete | Org admin |
| POST | `/api/pilot-ops/org-settings` | Update organization settings | Org admin |
| GET/POST | `/api/pilot-ops/org-logo` | Fetch / upload logo (PNG/JPEG data URL, ≤512 KB) | Org admin |
| GET | `/api/pilot-ops/users` | User directory with admin state | Org admin |
| POST | `/api/pilot-ops/users/:id/suspend` | Suspend a user (with reason) | Org admin |
| POST | `/api/pilot-ops/users/:id/restore` | Restore a suspended user | Org admin |
| POST | `/api/pilot-ops/users/:id/mfa` | Set MFA readiness flag | Org admin |
| GET | `/api/pilot-ops/users/:id/access` | Sign-in and device history | Org admin |
| GET | `/api/pilot-ops/permission-matrix` | Descriptive role/permission matrix | Org admin |
| GET | `/api/pilot-ops/notifications` | Derived notification feed + unread count | Member |
| POST | `/api/pilot-ops/notifications/read` | Mark one notification read | Member |
| POST | `/api/pilot-ops/notifications/read-all` | Mark all read | Member |
| GET/POST | `/api/pilot-ops/notification-prefs` | Read / update notification preferences | Member |
| POST | `/api/pilot-ops/digest` | Compose + send own DAILY/WEEKLY digest email | Member |
| GET | `/api/pilot-ops/emails` | Org-scoped email outbox | Org admin |
| GET/POST | `/api/pilot-ops/esign` | List / create signature requests | Org admin |
| POST | `/api/pilot-ops/esign/:id/send` | Send a request via its provider adapter | Org admin |
| GET | `/api/pilot-ops/esign/:id` | Request detail + event trail | Org admin |
| GET | `/api/pilot-ops/accounting` | Connections, runs, datasets | Org admin |
| POST | `/api/pilot-ops/accounting/export` | Normalized CSV export of a dataset | Org admin |
| POST | `/api/pilot-ops/accounting/import` | Stage CSV rows (never applied) | Org admin |
| GET/POST | `/api/pilot-ops/feedback` | List own-org / submit feedback | Member |
| GET | `/api/pilot-ops/feedback/:id` | Feedback detail (internal notes excluded for customers) | Member |
| GET | `/api/pilot-ops/analytics` | Pilot adoption analytics | Org admin |
| GET | `/api/pilot-ops/banners` | Active system banners | Member |

## Internal operator console

All routes below are Internal-only; any other role — and any unknown
`/api/internal/*` path — receives the identical nondisclosing 404.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/internal/success` | Customer-success workspace (all orgs) |
| GET/POST | `/api/internal/success/:orgId` | Account detail / update (status, go-live, manager, scores) |
| POST | `/api/internal/success/:orgId/checklist` | Add implementation checklist item |
| POST | `/api/internal/checklist/:itemId/done` | Mark checklist item done/undone |
| POST | `/api/internal/success/:orgId/note` | Add NOTE / ISSUE / FEATURE_REQUEST |
| POST | `/api/internal/feedback/:id/respond` | Internal note / customer response / status change |
| GET | `/api/internal/ops` | Operations dashboard |
| GET/POST | `/api/internal/backups` | List backups / create backup (VACUUM INTO) |
| POST | `/api/internal/backups/:id/verify` | Hash + read-only + quick_check verification |
| POST | `/api/internal/backups/:id/recovery-test` | Read-only recovery test (never restores) |
| GET | `/api/internal/config` | Env inventory (names + set/unset), flags, banners |
| POST | `/api/internal/flags` | Set a feature flag |
| POST | `/api/internal/banners` | Create system banner (INFO/WARN/CRITICAL) |
| POST | `/api/internal/banners/:id/remove` | Deactivate a banner |
| POST | `/api/internal/demo-data` | Generate DEMO-prefixed walkthrough data |

## Other major API families

- `/api/portfolio/*` — read-only portfolio intelligence (aggregates,
  risk, entities, forecast, fraud, summaries, snapshots). See
  `docs/PORTFOLIO_INTELLIGENCE.md`.
- `GET /api/health` — always-open deployment health: status, database
  reachability, renderer/AI/Teams modes, deploy version. No secrets,
  no session required.
- `GET /api/state` — session-required state fingerprint used by the UI
  to detect changes (anonymous access would be a cross-tenant activity
  oracle, so it requires a session).
