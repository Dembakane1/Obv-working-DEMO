# Integration Frameworks

OBV ships three provider-neutral integration frameworks: transactional
email, e-signature, and accounting. All three follow the same doctrine
as the banking registry: **adapters are looked up by name from small
registries, and nothing anywhere in OBV contains a provider's API
logic, SDK, or credentials.** A future real adapter implements the
same small interface without touching the surrounding layer.

Implementation: `src/server/services/pilotOps/email.ts` and
`src/server/services/pilotOps/integrations.ts`; schema in the Pilot
Readiness section of `src/server/db/index.ts`.

## Transactional email

The `EmailProvider` interface is three lines: a `name` and a
`send(message)` returning `{ ok, failureCategory? }`.
`OBV_EMAIL_PROVIDER` selects a registered adapter by name.

- **Default: the `log` adapter.** It records the send and delivers
  nothing off the machine — exactly right for pilots and tests. An
  `always-fail` adapter exists so failure handling is testable.
- **Outbox as audit record.** Every send attempt inserts an
  `email_outbox` row (`QUEUED` → `SENT`/`FAILED`) with template,
  subject, body, provider, and an optional reference to the triggering
  record. Failure categories are sanitized — never provider payloads
  or secrets.
- **Production posture.** A non-log provider is refused unless
  `OBV_EMAIL_MODE=production` **and** `OBV_EMAIL_PRODUCTION_ENABLE=true`
  are both set, so a demo deployment can never accidentally email real
  people. Demo recipients resolve to
  `<user-id>@demo.openbuildverify.example` — no real inboxes.

Templates are provider-neutral plain text — no tracking, no links to
anything the recipient cannot already access: `INVITATION`,
`ORG_INVITE`, `PASSWORD_RESET`, `DRAW_STATUS`, `APPROVAL_REQUEST`,
`WEEKLY_PORTFOLIO_SUMMARY`, `DAILY_DIGEST`, `EXECUTIVE_REPORT`,
`COMPLIANCE_REMINDER`.

## E-signature

The `EsignProviderAdapter` interface: a `name` and a `send(request)`
returning the provider's reference. Only the **MOCK** adapter is
installed — it simulates the signature lifecycle for pilots with no
network. `DOCUSIGN`, `DROPBOX_SIGN`, and `ADOBE_SIGN` are surfaced as
known future providers; each would implement the same interface and
register by name — nothing else changes.

### Request lifecycle

`DRAFT` → `SENT` → `VIEWED` → `SIGNED` / `DECLINED`; `VOIDED` is
reachable from `DRAFT`, `SENT`, or `VIEWED`. Transitions are enforced
from an explicit allowed-predecessor table; an out-of-order provider
event is recorded (`IGNORED_<event>`) but never changes state.

Requests are org-scoped (org-admin surface). An optional `projectId`
passes through the central authorization predicate (same-404), and an
optional `documentPath` must resolve under the data directory and is
fingerprinted with SHA-256 at creation.

### Webhook intake

`POST /api/esign/webhook/:provider?token=…` — sessionless, guarded by
a shared secret compared against `OBV_ESIGN_WEBHOOK_TOKEN`. With no
token configured, webhooks are refused entirely; wrong token, unknown
provider, and unknown reference all answer a nondisclosing 404.
Accepted events are `VIEWED`, `SIGNED`, and `DECLINED`, matched to the
request by provider reference.

### Audit

`esign_events` is an append-only trail of every action, tagged by
source (`OBV` for in-app actions, `WEBHOOK` for provider deliveries).

## Accounting

A connection registry per organization covers `QUICKBOOKS`, `XERO`,
`SAGE`, and `CSV` (status `AVAILABLE`/`CONNECTED`/`DISABLED`). The CSV
adapter is fully functional today; the named providers are registry
placeholders with no API logic anywhere.

### Exports

Normalized CSV per dataset — `PROJECTS`, `BUDGETS`, `INVOICES`,
`PAYMENTS`, `CONTRACTORS` — computed from the caller's accessible
projects (the same tenant predicate as every other surface) and
written under the data directory's `accounting/` folder. Every export
appends an `accounting_runs` row with dataset, row count, and file
path, and is audited.

### Imports STAGE ONLY

CSV imports (≤512 KB) are parsed and landed row-by-row in
`accounting_import_rows` with state `STAGED` (or `DISMISSED`) —
**never applied to any governed table**. Review and apply is a human
workflow through the existing governed mutation paths. No accounting
adapter, present or future, can create or modify verified records,
evidence, budgets, or banking state; the schema comment and the
staging-only write path make this structural, not conventional.

## What the integration layer never does

Store provider credentials or secrets · email real people outside
explicit production posture · advance an e-sign request out of order ·
apply imported rows to governed tables · touch verification,
approvals, banking, packages, or the evidence ledger.
