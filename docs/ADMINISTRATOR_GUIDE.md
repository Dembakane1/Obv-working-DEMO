# Administrator Guide

Organization administration for pilot lenders. Administration is
org-scoped and service-enforced: the roles `FUNDER_REP`,
`PROJECT_MANAGER`, and `COMPLIANCE_REVIEWER` administer **their own
organization only**; `FIELD` users hold no administrative authority.
Cross-organization records follow the same-404 doctrine — a user or
record outside your organization is indistinguishable from one that
does not exist. Implementation: `src/server/services/pilotOps/` and
`src/server/http/pilotOpsRoutes.ts` (`/api/pilot-ops/*`).

## The `/admin` surface

### User directory

Every user in your organization with role, status (Active/Suspended),
MFA readiness, and last sign-in. A missing administrative state row
means Active.

### Suspend / restore

Suspension is enforced at session resolution: a suspended user's
otherwise-valid session **stops resolving on their next request**, and
new sign-ins are refused — each refusal recorded as a `SIGN_IN_REFUSED`
event in their access history. The suspension records who, when, and
the reason; restore clears it the same way. You cannot suspend your own
account. Both actions are audited (`USER_SUSPENDED` / `USER_RESTORED`).

### MFA-readiness flag

**Readiness tracking, not enforcement.** The demo sign-in flow carries
no credentials yet, so there is nothing for MFA to gate; the flag lets
an organization track which users have completed MFA setup ahead of a
credentialed rollout, honestly labeled as such. Toggling it is audited.

### Sign-in and device history

Per user, from the append-only `user_access_events` table: sign-ins and
refusals with timestamps and user agents — never secrets, tokens, or
addresses. The device view groups distinct user agents with first-seen,
last-seen, and sign-in counts.

### Permission matrix

A descriptive table of what each role can do per area (evidence
capture, review, approvals, lender decisions, banking dual-control,
portfolio intelligence, administration). It is **documentation of
service-enforced rules** — enforcement lives in the services, and the
matrix changes nothing by itself.

## Invitation management

Invitations are created, resent, and revoked in Pilot Setup (`/setup`);
`/admin` shows the register (email, role, status, expiry). Activation
links are one-time and expire after 14 days; only the token's hash is
stored. Resending an invitation email is audited
(`INVITATION_EMAIL_RESENT`).

## Pilot adoption analytics

Always available from sign-in history and governed records: daily /
weekly / monthly active users, time to first draw, average approval
time, feature adoption, and abandoned-workflow counts (draft draws
older than 14 days, unfinished onboarding).

Setting `OBV_USAGE_ANALYTICS=1` additionally records page views for
signed-in users, which adds most-used pages and page-based adoption
signals (e.g. whether `/executive` has been visited). It is off by
default so GET requests never write anything.

## Accounting exports and imports

Provider-neutral connections for QuickBooks, Xero, Sage, and CSV — no
provider API logic exists anywhere in OBV; the CSV path is the fully
functional one. Datasets: `PROJECTS`, `BUDGETS`, `INVOICES`,
`PAYMENTS`, `CONTRACTORS`.

- **Exports** produce normalized CSV files from your accessible
  projects, saved under the data directory and logged as runs.
- **Imports stage only.** An uploaded CSV (<= 512 KB) is parsed into a
  staging register — nothing an accounting import does can create or
  modify verified records, evidence, budgets, or banking state.
  Applying staged rows is a human workflow through the existing
  governed mutation paths.

Both directions are audited (`ACCOUNTING_EXPORT`,
`ACCOUNTING_IMPORT_STAGED`) with dataset and row counts.

## E-signature requests

Provider-neutral: adapters are registered by name, and only the
**MOCK** adapter is installed — it simulates the signature lifecycle
for pilots with no network calls. DocuSign, Dropbox Sign, and Adobe
Sign are listed as known provider names with no adapters; a future
adapter implements the same interface without touching this layer.

Lifecycle: `DRAFT → SENT → VIEWED → SIGNED / DECLINED` (`VOIDED` from
any pre-terminal state), with invalid transitions refused. Attached
documents are hashed (SHA-256) at creation. Provider callbacks arrive
via a token-gated webhook (`OBV_ESIGN_WEBHOOK_TOKEN`; refused entirely
when unconfigured), and every OBV action and webhook delivery lands in
the append-only `esign_events` trail. Out-of-order webhook events are
recorded but change no state.

## The audit trail

Every administrative action described in this guide is appended to the
platform-wide `config_audit` table — the same trail the rest of OBV
uses — recording the actor, action, entity, and a summary (field names,
never secret values). Examples: `ORG_SETTINGS_UPDATED`,
`ONBOARDING_STEP_COMPLETED`, `USER_SUSPENDED`, `USER_MFA_READY`,
`ESIGN_REQUEST_SENT`, `ACCOUNTING_EXPORT`, `FEEDBACK_TRIAGED`. There is
no separate, second audit surface for administration.

## What administration never touches

The Pilot Readiness layer stores per-user and per-org operational state
in side tables; the `users` and `organizations` tables are not altered,
and nothing here touches verification, approvals, banking, packages, or
the evidence ledger.
