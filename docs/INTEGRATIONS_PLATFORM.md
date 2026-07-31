# OBV Production Integrations Platform

Connects the verified platform to the systems a lender already runs —
email, Outlook, Teams, e-signature, accounting, banking, calendars, and
outbound webhooks — behind **provider-neutral interfaces**. Two rules
govern everything here:

1. **Integrations observe the system of record; they never author it.**
   No integration writes to evidence, verification, ledger, approval,
   banking, or package tables (statically asserted by the test battery).
2. **External vendor adapters are disabled boundaries.** They exist so a
   production deployment configures credentials in exactly one place, but
   in this build every vendor call refuses. Selecting a vendor requires
   both the provider env var and `OBV_INTEGRATIONS_PRODUCTION_ENABLE=true`
   (the banking registry's double-consent pattern) — and startup refuses
   otherwise.

## Architecture

```
services/integrations/
  core.ts        IntegrationError, config, role gates, audit recorder
  email.ts       8 message kinds; outbox provider + 5 vendor boundaries
  outlook.ts     RFC 5545 ICS generation (active) + Graph boundary
  teamsIntegration.ts  Adaptive Card 1.5 builders for 7 event kinds
  esign.ts       request lifecycle + trail; internal + 3 vendor boundaries
  accounting.ts  EXPORT-only projection; CSV + 3 vendor boundaries
  calendarSvc.ts org-scoped scheduling + derived permit deadlines
  webhooks.ts    signed outbound deliveries: retries, idempotency,
                 replay-bounded signatures, dead-letter queue
  dashboard.ts   secret-free provider health aggregation
db/integrationsRepo.ts   all SQL; append-only audit enforced here
http/integrationRoutes.ts + view/integrationPages.tsx   /integrations
```

Tables: `integration_events` (append-only audit), `email_outbox`,
`esign_requests` + `esign_events` (append-only), `calendar_events`,
`webhook_endpoints` + `webhook_deliveries`, `accounting_sync_runs`
(direction constrained `EXPORT` at the database level) +
`accounting_links`.

## Supported providers

| Category | Active today | Adapter-ready (disabled boundaries) |
|---|---|---|
| Email | Development outbox | Microsoft 365, SendGrid, Mailgun, Amazon SES, Postmark |
| Outlook / calendar | ICS export (vendor-neutral) | Microsoft Graph |
| Teams | Adaptive-card payload builders (+ existing webhook notifier) | — |
| E-signature | Internal tracking with full trail | DocuSign, Dropbox Sign, Adobe Acrobat Sign |
| Accounting | CSV export | QuickBooks Online, Xero, Sage |
| Banking | Mock (demo default, unchanged) | Unit, Treasury Prime, Qolo (pre-existing disabled boundaries) |
| Webhooks | Signed outbound framework | any http(s) receiver |

## Email

`sendEmail()` is the single sending seam. Message kinds: invitation,
magic-link, password-reset (reserved — passwordless is the active
method), draw notification, approval request, dispute notification,
executive summary, weekly portfolio report. Deterministic templates
compose from verified records. **Credential-bearing bodies are
redacted** in `email_outbox`; raw sign-in links travel only through the
identity delivery seam. Provider refusal marks the entry FAILED and is
audited — a notification can never break the domain action it follows.

## Outlook & calendar

Inspections, draw reviews, lender/contractor meetings, permit deadlines,
and reminders are first-class org-scoped records. Every event exports as
RFC 5545 ICS (`/api/integrations/calendar/:id.ics`) — Outlook imports it
natively with zero credentials. Permit expirations surface as **derived**
suggestions from the permit register; scheduling one stores a record,
nothing is auto-written. The Microsoft Graph adapter is a disabled
boundary; no Microsoft credentials are required or accepted.

## Teams

`buildTeamsCard()` produces Adaptive Card 1.5 payloads for: draw
submitted, draw approved, dispute opened, inspection completed, fraud
alert, portfolio alert, executive summary. Fraud/portfolio/summary cards
carry the advisory-only statement **inside the payload**. No live Teams
dependency; delivery remains the existing notifier (when configured) or
the webhook framework.

## E-signature

Requests (contractor agreement, lien waiver, approval acknowledgement,
completion certificate, other) track pending → signed / declined /
expired / cancelled with a guarded one-shot settlement, an append-only
per-request trail, lazy audited expiry, and same-404 tenancy.
`document_ref` points at existing artifacts — e-sign never creates or
alters evidence.

## Accounting

**Export-only.** OBV is the system of record; accounting mirrors it. One
run projects the caller's visible records into `projects.csv`,
`budgets.csv`, `contractors.csv`, `invoices.csv` (draw requests), and
`payments.csv` (governed RELEASED events), records per-entity links, and
audits the run. There is no import path anywhere, so accounting can never
modify verified evidence.

## Webhook framework

- **Signatures**: `x-obv-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`;
  receivers verify with `verifyWebhookSignature` (constant-time, and the
  signed timestamp bounds validity — a captured request replayed outside
  the tolerance window fails: **replay protection**).
- **Idempotency**: one delivery per endpoint+event (database constraint)
  plus an `x-obv-delivery` id receivers can dedupe on.
- **Retries**: exponential backoff (30s base, 30m cap); after
  `OBV_WEBHOOK_MAX_ATTEMPTS` (default 5) the delivery parks in a
  **dead-letter** state, audited and visible on the dashboard, with an
  administrative audited requeue.
- **Atomic claim**: overlapping dispatch passes can never double-send.
- The signing secret is generated server-side, returned exactly once at
  registration, and never serialized again.
- Event kinds: draw.submitted, draw.approved, dispute.opened,
  inspection.completed, fraud.alert, portfolio.alert, executive.summary,
  esign.completed, calendar.scheduled. E-sign settlement and calendar
  scheduling emit real events today; draw/dispute emission points are a
  deliberate later wiring step (kept out of this milestone to avoid
  touching governed flows).
- Dispatch runs on explicit request (`POST
  /api/integrations/webhooks/dispatch`) or an optional interval
  (`OBV_WEBHOOK_DISPATCH_INTERVAL_MS`), so tests and demos stay
  deterministic.

## Dashboard & audit

`/integrations` shows configured providers, connection status, last
sync, failures, the retry queue, and provider health — **no secrets
anywhere in its view models**. Every integration action appends
`integration_events` (provider, operation, actor, organization, request
id, outcome, subject); no update or delete path exists. Administrative
membership of the page: viewer roles read, PROJECT_MANAGER mutates,
FIELD is refused, tenants are isolated with same-404.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OBV_EMAIL_PROVIDER` | `outbox` | outbox · m365 · sendgrid · mailgun · ses · postmark |
| `OBV_ESIGN_PROVIDER` | `internal` | internal · docusign · dropbox_sign · adobe_sign |
| `OBV_ACCOUNTING_PROVIDER` | `csv` | csv · quickbooks · xero · sage |
| `OBV_INTEGRATIONS_PRODUCTION_ENABLE` | unset | Required `true` before any vendor provider may even be selected |
| `OBV_WEBHOOK_MAX_ATTEMPTS` | 5 | Attempts before dead-letter |
| `OBV_WEBHOOK_DISPATCH_INTERVAL_MS` | 0 (off) | Optional periodic dispatch |

No credentials exist in this build; `.env.example` documents names only.

## Known limitations

- Vendor adapters are deliberate refusal boundaries — production use
  requires implementing each adapter body against real credentials.
- Draw/dispute/inspection webhook + email emission points are not yet
  wired into the governed workflows (kept untouched this milestone);
  e-sign and calendar events emit today, and the payload builders for
  everything else are ready and tested.
- Accounting synchronization is one-way by design; an import path is a
  policy decision deliberately not taken.
- Webhook dispatch is single-process; a multi-instance deployment would
  move the dispatcher to a single elected worker.
