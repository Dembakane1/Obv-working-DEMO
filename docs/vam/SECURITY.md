# VAM Security — authorization, dual control, tenancy, data protection

## Capability model

Banking capabilities are `ProjectCapability` values that ride the
existing membership machinery (`lenderAccess`) — the authorization
framework is extended, never replaced:

`VIEW_PROJECT_ACCOUNT`, `MANAGE_PROJECT_ACCOUNT`,
`CREATE_PAYMENT_INSTRUCTION`, `APPROVE_PAYMENT_INSTRUCTION`,
`CANCEL_PAYMENT_INSTRUCTION`, `VIEW_RECONCILIATION`,
`RUN_RECONCILIATION`, `MANAGE_BANKING_PROGRAM`.

They are **not** part of any participant-type default set: they arrive
only through an explicit membership `capabilitySet` grant, or the
conservative legacy role fallback (`bankingAccess.ts`):

| Legacy role | Banking capabilities |
|---|---|
| FUNDER_REP | all eight |
| COMPLIANCE_REVIEWER | view + reconciliation (oversight) |
| everyone else | none without an explicit grant |

### Capability / action matrix

| Action | Required capability | Extra rules |
|---|---|---|
| View workspace / banking API | VIEW_PROJECT_ACCOUNT | access is audit-logged |
| Create banking program | MANAGE_BANKING_PROGRAM | one active program per org |
| Create project account | MANAGE_PROJECT_ACCOUNT | one open account per project |
| Demo credit | MANAGE_PROJECT_ACCOUNT | demo mode only |
| Place / release hold | MANAGE_PROJECT_ACCOUNT | guarded balances, exactly-once release |
| Create payment instruction | CREATE_PAYMENT_INSTRUCTION | full eligibility boundary |
| Approve payment instruction | APPROVE_PAYMENT_INSTRUCTION | creator ≠ approver; draw submitter ≠ approver; re-validated boundary |
| Cancel payment instruction | CANCEL_PAYMENT_INSTRUCTION | pre-submission states only |
| Simulate submission | CREATE_PAYMENT_INSTRUCTION | demo mode only |
| Simulate provider events | MANAGE_PROJECT_ACCOUNT | demo mode only; idempotent |
| View reconciliation | VIEW_RECONCILIATION | — |
| Run reconciliation | RUN_RECONCILIATION | forced mismatch is demo-only |

Browser controls are convenience only: every POST re-runs these checks
in the service layer, so manually crafted JSON or form requests are
rejected (403) or bounced with the error, and out-of-tenant requests
receive the same 404 as a nonexistent record.

## Dual control

- One authorized user creates the instruction (`PENDING_APPROVAL`).
- A **different** authorized user approves it. Server-enforced:
  `requestedByUserId === approver` → 403; the draw's
  `requestedByUserId === approver` → 403 (submitter-cannot-approve).
- The approval is a guarded exactly-once transition
  (`PENDING_APPROVAL → APPROVED_FOR_SUBMISSION`); who/when are set once
  and never rewritten, and the append-only `banking_events` row
  (`INSTRUCTION_APPROVED`) is the immutable approval record.
- Approval never settles: settlement exists only as a provider event.

## Tenant isolation

Every banking record resolves to a project; access flows through
`lenderAccess.assertProjectAccess`, so unrelated organizations get the
identical 404 a nonexistent record gets (no existence disclosure).
Holds/instructions/transactions are reached only through their account →
project. Reports and package downloads use the existing protected
routes.

## Data protection

- Only **masked** account identifiers are stored or displayed
  (`••••1234`); full account and routing numbers never enter OBV.
- No API secrets in SQLite, code or env defaults — the mock provider has
  none, and the disabled adapters contain no credential fields at all.
- Raw provider webhook payloads are hashed (SHA-256, `raw_event_hash`)
  and never retained; provider failure text is sanitized and truncated
  before storage.
- Banking modules make no network calls (statically asserted in the test
  suite) and never log credentials or full account numbers.
- Audit events (`banking_events`, append-only, attributable,
  timestamped): account access, program/account creation, credits,
  holds, instruction creation/approval/cancellation, provider
  submission, every processed provider event, settlement, failure,
  return, reversal, reconciliation outcomes.
- Downloads and packages carry the same masked identifiers and hashed
  event references only.

## What this phase can never do

No real banking connections, payment initiation, ACH, wires, cards,
bank-account creation, custody, escrow or real-money movement. No new
call path into `VirtualAccountService` from banking or lender modules.
No automatic approval or release. No weakening of evidence verification,
the Evidence Ledger, permits, inspections, completion gates, approval
matrices, separation of duties, change orders, retainage, exceptions,
report integrity, tenant isolation, exactly-once release or existing
audit trails — the full existing suite plus the 83-checkpoint VAM suite
prove these invariants on every run.
