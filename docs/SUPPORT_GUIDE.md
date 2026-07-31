# Internal Operator & Support Guide

The `/internal` console is OBV's operator workspace: customer success,
feedback triage, the operations dashboard, backups, production
configuration, and the demo-data generator. It exists only for the OBV
reviewer identity (`COMPLIANCE_REVIEWER`). For every other role, the
page and every `/api/internal/*` route answer a **nondisclosing 404** —
lender-side users cannot learn that these surfaces exist
(`assertInternalOperator` in `src/server/services/pilotOps/core.ts`).

Every administrative action is appended to the platform-wide
`config_audit` trail — one audit surface for the whole platform.

## Customer-success workspace

One row per organization (`/api/internal/success`), combining the
stored `cs_accounts` record with live derived counts: onboarding
complete, users, projects, open feedback, open notes, and a suggested
health score.

- **Pilot status** — one of `PROSPECT`, `ONBOARDING`, `LIVE`,
  `PAUSED`, `COMPLETED`, `CHURNED` (enforced by a schema CHECK).
- **Go-live date** and **success manager** — free operator fields.
- **Health score** (0–100) — operator-set. The console shows a
  deterministic *suggested* score the operator can override:
  onboarding complete +30, any project +20, more than one user +20,
  any sign-in within 7 days +20, no open CRITICAL feedback +10.
- **Renewal probability** (0–100) — operator judgment, bounds enforced.
- **Implementation checklist** — free-form ordered items per
  organization; done/reopen is tracked with actor and timestamp.
- **Notes** — kinds `NOTE`, `ISSUE`, `FEATURE_REQUEST`; status
  `OPEN`/`RESOLVED`. These are internal working records, never shown
  to customers.

## Feedback triage

Customers submit feedback from the `/feedback` portal (kinds `BUG`,
`FEATURE`, `IMPROVEMENT`, `PAIN_POINT`; severities `LOW`–`CRITICAL`).
Feedback is org-scoped for customers — they see only their own
organization's items, and another organization's feedback 404s
identically to nonexistent feedback.

Operators respond through `/api/internal/feedback/:id/respond` with
two distinct event kinds:

- **`INTERNAL_NOTE`** — visible only to the internal operator.
  Customer reads of the feedback timeline exclude internal notes at
  the query layer (`listFeedbackEvents(id, internal)`).
- **`CUSTOMER_RESPONSE`** — visible to the submitting organization.

Status moves through `OPEN` → `TRIAGED` → `IN_PROGRESS` →
`RESOLVED`/`CLOSED`; every status change appends a `STATUS_CHANGE`
event to the feedback timeline, and each triage action is audited.

## Operations dashboard

`GET /api/internal/ops` (rendered on `/internal`). Monitoring is
in-memory and derived — no database writes on the request path.

| Panel | Shows |
| --- | --- |
| Application | status, start time, Node version, deploy version |
| Database | `PRAGMA quick_check` result, file size, table count |
| Storage | on-disk sizes of `worm`, `uploads`, `reports`, `audit-packages`, `backups`, `accounting` |
| Email queue | outbox counts by status; failed-email and failed-backup counts |
| Recent errors | last 50 sanitized samples — message + status only, never stacks, payloads, or provider details |
| API performance | last 500 request timings: average, p95, slowest paths (dynamic segments bucketed to `:id`) |
| Audit activity | count and latest entries from `config_audit` over 24h |
| Background jobs | digest dispatch is on-demand — no daemon; schedule externally |

**No sensitive data is exposed.** The production-configuration panel
lists known environment variable *names* with a set/unset flag only —
values are never returned. Error samples are truncated messages;
request samples carry bucketed low-cardinality paths.

## Production configuration

- **Feature flags** — named lowercase keys, toggled and audited.
- **System banners** — `INFO`/`WARN`/`CRITICAL`; active banners render
  for *every* signed-in user; creation/removal is operator-only.
- **Maintenance mode** — `OBV_MAINTENANCE=1` or the `maintenance_mode`
  flag. Everything except `/api/health` and the report cache answers
  503 for non-operators; internal operators pass through to manage
  the system.
- **Sign-in rate limiting** — disabled unless
  `OBV_RATE_LIMIT_PER_MINUTE` is set (fixed one-minute window per
  source address).

## Demo-data generator

`POST /api/internal/demo-data` creates realistic, clearly-marked
demonstration records for pilot walkthroughs. It is double-gated:
internal operator **and** demo banking mode — in production banking
posture it refuses with 403. It runs at most once per database (409 if
demo data already exists).

Every generated name carries the `DEMO — ` prefix and every generated
id the `demo-gen-` prefix, so demo records are unmistakable in every
register and trivially queryable. It generates two projects under the
invoker's organization plus one demo contractor organization, with
milestones, budget lines, permits (one expired), a draw under review
with line items and vendor invoices (including a deliberate duplicate
invoice number as a fraud-signal example), government inspection
records, an open exception, a dispute with a legal hold, and
cost-to-complete estimates. Portfolio trends, risk, forecasts, fraud
signals, and executive reports then derive automatically.

**What it never creates:** evidence items, ledger entries,
verifications, approvals, banking rows, or packages — those exist only
through the governed pipelines.

## What the internal console never does

Expose secret values · disclose its existence to lender-side roles ·
modify verified records, evidence, or banking state · restore backups
(see `docs/DISASTER_RECOVERY_GUIDE.md`) · act without an audit entry.
