# VAM Architecture — Virtual Account Management foundation

OBV is a construction verification, workflow, authorization and
financial-ledger technology provider. It is **not** a bank, escrow
company, money transmitter, fiduciary, insurer or licensed financial
institution. This phase ships the production-safe *foundation* for
virtual account management with **no real money movement**: the only
provider is a deterministic, network-free mock.

## Bank versus OBV responsibilities

| Concern | Owner |
|---|---|
| Holding real funds | FDIC-insured partner bank |
| Creating virtual accounts / subledger balances | Banking-as-a-Service / VAM provider |
| Enforcing account holds | Bank / provider |
| Executing authorized payments | Bank / licensed payment provider |
| Settlement truth | Provider-confirmed bank transaction events, and nothing else |
| Verified construction progress | OBV (evidence, inspections, permits, gates) |
| Governed release eligibility | OBV (approval matrix, lender decisions, conditions, waivers) |
| Payment authorization records (dual control) | OBV |
| Reconciliation bookkeeping | OBV computes; the bank's report is the external truth |

OBV never treats verification, lender review, or a virtual ledger update
as proof that real money moved. A payment instruction is not a payment;
a submitted payment is not a settled transaction.

## Deposit insurance wording

Funds may be held at an FDIC-insured partner bank. Eligibility for
pass-through deposit insurance depends on the final account structure,
ownership, titling, recordkeeping and aggregation rules. Virtual
accounts may represent subledger balances rather than separate bank
deposit accounts. OBV does not claim that every virtual account
automatically receives separate FDIC insurance, and OBV is not itself a
licensed escrow agent — the `ESCROW_PARTNER` structure means a licensed
third party participates.

## Account structures

`banking_programs.account_structure` ∈ `LENDER_CONTROLLED`, `FBO`,
`CUSTODIAL`, `ESCROW_PARTNER`, `SEPARATE_PROJECT_ACCOUNTS`. The demo
seed uses `LENDER_CONTROLLED`. A project's virtual account
(`project_virtual_accounts`) is a **subledger identity** under the
program — masked identifiers only (`••••1234`); full account or routing
numbers are never seen, stored or displayed by OBV.

## Provider adapter design

```
src/server/services/banking/
  provider.ts        BankingProvider interface + IO types (the ONLY doorway)
  mockProvider.ts    MockBankingProvider — deterministic, network-free
  adapters.ts        Unit / Treasury Prime / Qolo DISABLED boundaries (501)
  registry.ts        env-driven resolution + production refusal
  bankingAccess.ts   capabilities riding the existing membership system
  projectAccounts.ts programs, accounts, demo credits, holds
  paymentInstructions.ts  eligibility boundary, dual control, provider events
  reconciliation.ts  documented invariant, mismatch → critical exception
  packageRegisters.ts     draw/audit package registers
src/server/db/bankingRepo.ts   all banking SQL, guarded arithmetic
src/server/http/bankingRoutes.ts  routes (no direct SQLite writes)
src/server/view/bankingPages.tsx  Project Account workspace
```

A future Unit, Treasury Prime, Qolo or direct-bank adapter implements
`BankingProvider` behind the same boundary. **OBV's verification,
governance and authorization rules never change per provider** — the
adapter only relays account creation, holds, submissions, webhooks and
balance reports. Enabling one requires provider configuration plus
`OBV_BANKING_MODE=production` and `OBV_BANKING_PRODUCTION_ENABLE=true`;
without them the application refuses to start (`registry.ts`), and the
shipped adapters refuse every call regardless (no SDKs, credentials or
network code exist in this build).

## Configuration

```
OBV_BANKING_PROVIDER=mock   # mock | unit | treasury_prime | qolo
OBV_BANKING_MODE=demo       # demo | production
```

Demo-only surfaces (seeded credits, simulated submission/settlement/
failure/return/reversal, forced reconciliation mismatch) are refused in
production mode even with the mock provider, and are labelled
"Demo simulation only" in the UI.

## Balance semantics (whole-currency integers)

| Column | Meaning |
|---|---|
| `available_balance` | unheld, unspent funds at the bank |
| `held_balance` | funds under an ACTIVE hold |
| `release_eligible_balance` | available funds not yet earmarked by a payment instruction |
| `pending_outbound_amount` | submitted to the provider, not yet settled |
| `settled_outbound_amount` | provider-confirmed settled outbound |
| `returned_amount` | cumulative provider-confirmed returns |

Every mutation is a guarded single-statement UPDATE
(`bankingRepo.adjustAccountBalances`): the precondition (non-negativity
of every adjusted column, account ACTIVE) travels in the same statement,
so stale reads can never drive a balance negative or double-apply.

## Payment instruction lifecycle

```
PENDING_APPROVAL → APPROVED_FOR_SUBMISSION → SUBMITTED_TO_PROVIDER
       ↓ cancel            ↓ cancel                 ↓ provider events only
   CANCELLED            CANCELLED         PROCESSING → SETTLED → RETURNED
                                                    ↘ FAILED
```

- Creation runs the full release-eligibility boundary (see
  `docs/vam/RECONCILIATION.md` and the service header) inside the write
  lock and earmarks `release_eligible_balance`.
- Approval requires a different authorized user (dual control) and
  re-validates the boundary. Approval **never** settles anything.
- Submission (demo simulation) moves funds available → pending outbound
  and opens a PENDING bank transaction.
- Settlement, failure, return and reversal apply **only** through
  idempotent provider events (`processProviderEvent` →
  `provider.processWebhook`), each a guarded exactly-once transition.

## Relationship to the existing demo release machinery

The pre-existing `VirtualAccountService`, `virtual_account_events` and
`draw_account_events` demo simulations are untouched and remain the only
release state machine for milestone tranches. **No banking module
references VirtualAccountService** (statically asserted in
`scripts/vam-test.js`), and the entire VAM flow leaves virtual-account
events, draw-account events, approval records, released milestones and
retainage records byte-for-byte unchanged (also asserted).
