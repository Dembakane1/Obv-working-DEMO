# VAM foundation — completion report

> **Post-merge addendum (2026-07-22):** the merged implementation was
> independently audited and hardened — see
> `docs/vam/POST_MERGE_AUDIT.md` for the confirmed baseline, state
> machines, accounting identities, three fixed defects (event-path
> lockstep transitions, conflicting provider-event rejection,
> in-lock idempotency), the 50-checkpoint adversarial suite, the
> unified `npm test` runner and the `ci` GitHub Actions workflow.

Branch `claude/obv-vam-foundation` from main `7303d03`. This phase adds
the production-safe Virtual Account Management foundation with **no real
money movement**: a provider-neutral banking boundary, a deterministic
mock provider, governed dual-controlled payment instructions, holds,
event-driven settlement, deterministic reconciliation with critical
blocking exceptions, a Project Account workspace, package registers, a
demo seed and an 87-checkpoint suite.

## Commits

1. Schema, types and banking repository layer
2. Provider interface and deterministic mock provider
3. Project accounts, holds and reconciliation services
4. Payment instructions with release-eligibility and dual control
5. Banking routes with governed form handling
6. Project Account workspace and lender-tab summary
7. Banking registers in draw and audit packages
8. Demo seed and dedicated test suite
9. Adversarial-review fixes (capability boundary on the lender-tab
   summary; satisfiable inspection gate; strict idempotency equivalence)
10. Documentation and final regression

## What was NOT added (non-negotiable boundary)

No real banking connections, payment initiation, ACH, wires, cards,
bank-account creation, custody, escrow or real-money movement. No
credentials or SDKs. No direct call from lender UI or lender-domain
services into `VirtualAccountService` — and none from banking modules
either (statically asserted). No automatic approval; no automatic
release. The pre-existing virtual-account and release mechanisms remain
demo simulations and remain the only release state machine; the VAM
suite proves the entire banking flow leaves virtual-account events,
draw-account events, approval records, released milestones and
retainage records byte-for-byte unchanged. Evidence verification, the
Evidence Ledger, permits, inspections (jurisdictional AND independent),
completion gates, approval matrices, separation of duties, change
orders, retainage, exceptions, report integrity, tenant isolation,
exactly-once release and existing audit trails are all untouched — the
full existing battery passes unmodified except two seed-count updates
(the fifth demo role on /demo; a legacy-scope adjustment in the lender
UI suite).

## Test results (all green)

| Suite | Checkpoints |
|---|---|
| **vam-test (new)** | **87** |
| lender-test | 181 |
| permits-test | 82 |
| pilot-test | 70 |
| teams-sync-test | 52 |
| whatsapp-sync-test | 48 |
| draws-test | 45 |
| auditpackage-test | 43 |
| changeorders-test / fieldops-test | 40 each |
| budget-test | 39 |
| gates-test | 35 |
| exceptions-test | 34 |
| drawpackage-test | 27 |
| map-test / lender-ui-test | 26 each |
| chat-test / idempotency-test / acceptance (19-step) | 17 each |
| home-test | 14 |
| verification-test | 11 |
| intelligence-test / report-test | 10 each |
| teams-test | 8 |
| frontend-test | 6 |
| deploy-check | 22 PASS / 0 FAIL |

The VAM suite covers the entire required checklist: program/account
creation, tenancy (same-404), capability enforcement (JSON + crafted
form posts), masked display, balances vs SQLite truth, hold placement/
release with guarded arithmetic, the full release-eligibility boundary
(governance, current fundable decision referencing the approval,
conditions, waivers, independent-inspection policy, jurisdictional
gates, critical integrity exceptions, reconciliation blocking,
approved-amount cap, sufficient balance), duplicates and idempotency,
creator-cannot-approve, submitter-cannot-approve, provider submission,
pending/posted/settled/failed/returned/reversed lifecycles with
settlement ONLY from provider events, replay idempotency, immutable
append-only events, reconciliation match/mismatch/blocking/resolution
with preserved history, package registers with manifest hashing, legacy
Not recorded, no cross-tenant disclosure, static no-network/no-
credential/no-VirtualAccountService assertions, provider-refusal at
startup, financial-state invariance, one H1, 44px touch targets, 16px
mobile inputs and zero horizontal overflow at 375–1440.

## Adversarial review outcome

A three-dimension adversarial review (money integrity / authorization
boundaries / eligibility & runtime) with per-finding refutation passes
confirmed three defects before the PR, all fixed with regression
checkpoints:

1. **Lender-tab capability bypass** (major) — the read-only banking
   summary rendered account balances, holds and payee details to draw
   participants without `VIEW_PROJECT_ACCOUNT`. Now the assembly returns
   no banking data without the capability.
2. **Unsatisfiable inspection gate** (major) — eligibility demanded
   `FINALIZED` + lender-accepted simultaneously, a state the atomic
   acceptance transition can never produce, permanently blocking any
   lender whose policy requires independent inspections. Now the
   terminal `ACCEPTED`/accepted state satisfies the gate.
3. **Loose idempotency equivalence** (minor) — a replayed key with a
   different payment method or recipient reference was silently
   coalesced; it is now refused (409).

## Known limitations

- Mock provider only; the Unit/Treasury Prime/Qolo adapters are
  deliberately disabled boundaries. Enabling any of them requires
  provider configuration, `OBV_BANKING_MODE=production`,
  `OBV_BANKING_PRODUCTION_ENABLE=true`, and a real adapter
  implementation that does not exist in this build.
- The suspense balance is a documented constant zero; a future phase
  models a real suspense account.
- `PaymentInstructionStatus` has no distinct REVERSED value; a provider
  reversal marks the bank transaction `REVERSED` and the instruction
  `RETURNED` (documented in the lifecycle).
- Demo simulations stand in for provider webhooks; a real adapter would
  receive signed webhooks on a dedicated endpoint (the processing path —
  `processProviderEvent` → `processWebhook` → guarded transitions — is
  the one a real adapter would reuse).

## Deployment configuration

`OBV_BANKING_PROVIDER=mock` and `OBV_BANKING_MODE=demo` are the defaults
and require no configuration. The server fails fast at startup on any
non-mock provider without the explicit production flags.
