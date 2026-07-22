# VAM post-merge audit — repository baseline, methodology, findings

Audit of the MERGED VAM implementation on `main`, performed by
inspecting and executing the actual merged code (not the PR description
or any prior completion report).

## Confirmed repository baseline (2026-07-22)

| Item | Confirmed state |
|---|---|
| Merge commit | `50d294374f083ffa725d5b176527612970620bbf` ("Merge pull request #1") present and an ancestor of `main` |
| PR #1 VAM files | all present: `src/server/db/bankingRepo.ts`, `src/server/services/banking/{provider,mockProvider,adapters,registry,bankingAccess,projectAccounts,paymentInstructions,reconciliation,packageRegisters}.ts`, `src/server/http/bankingRoutes.ts`, `src/server/view/bankingPages.tsx`, `scripts/vam-test.js`, `docs/vam/*` |
| render.yaml production service (`obv-demo`) | `branch: main`; preview service separate and unchanged |
| GitHub default branch | **`claude/obv-demo-repo-structure-t0hjsc`** (NOT main) at audit start |
| GitHub Actions workflows | none existed (`.github/` absent) |
| Branch protection | none existed |
| Baseline build on latest main | `npm run build` passes |
| Baseline suites on latest main | full battery green (942 checkpoints through the unified runner, before audit fixes) |

## Default branch and branch protection — honest result

Both administrative writes are **blocked by the environment's GitHub
proxy** and were NOT performed. Exact attempts:

```
PATCH https://api.github.com/repos/Dembakane1/Obv-working-DEMO
  body: {"default_branch":"main"}
→ HTTP 403 {"message":"Repository settings writes are not permitted through this proxy."}

PUT https://api.github.com/repos/Dembakane1/Obv-working-DEMO/branches/main/protection
  body: required_status_checks {strict, contexts:["ci"]}, enforce_admins:false, …
→ HTTP 403 {"message":"Write access to this GitHub API path is not permitted through this proxy."}
```

The one-step manual actions (repo owner, ~1 minute each) are documented
in `docs/REPOSITORY_PROTECTION.md`. The CI workflow's required status
check name is **`ci`**.

## Audit methodology

1. Line-level review of every merged banking module plus the routes,
   view, seed and existing suite.
2. Executable hostile probes against a freshly seeded server (now
   codified as `scripts/vam-adversarial-test.js`, 50 checkpoints), every
   rejection verified against a full banking fingerprint (balances,
   row counts, append-only events, mock bank book) to prove zero
   mutation.
3. Accounting walk-through of every balance-moving operation against
   the documented invariant.
4. Live reproduction of each suspected defect before fixing it.

## Payment-instruction state machine (verified)

| From | Allowed | Forbidden (verified rejected) |
|---|---|---|
| PENDING_APPROVAL | approve → APPROVED_FOR_SUBMISSION (different authorized user); cancel → CANCELLED | submit, settle (no transaction), approve by creator, approve by draw submitter, second approval |
| APPROVED_FOR_SUBMISSION | submit → SUBMITTED_TO_PROVIDER (demo); cancel → CANCELLED | approve again, settle without submission |
| SUBMITTED_TO_PROVIDER | posted → PROCESSING; settled → SETTLED; failed → FAILED | cancel, return, reversal (pre-settlement), second posted |
| PROCESSING | settled → SETTLED; failed → FAILED | cancel, return/reversal pre-settlement |
| SETTLED | returned → RETURNED; reversed → RETURNED (txn REVERSED) | approve, cancel, settle again, fail |
| FAILED / RETURNED / CANCELLED | (terminal) | everything |

Approval NEVER settles: it is a guarded `PENDING_APPROVAL →
APPROVED_FOR_SUBMISSION` transition that moves no funds and sets no
settlement fields (adversarially asserted). Settlement truth exists
only as a provider event.

## Bank-transaction state machine (verified)

| From | Allowed | Forbidden (verified rejected) |
|---|---|---|
| PENDING | POSTED, SETTLED, FAILED | RETURNED, REVERSED (pre-settlement) |
| POSTED | SETTLED, FAILED | second posted |
| SETTLED | RETURNED, REVERSED | second settlement, FAILED |
| FAILED / RETURNED / REVERSED | (terminal) | everything |

Holds: ACTIVE → RELEASED/CANCELLED/EXPIRED exactly once (guarded;
double release = 409). Reconciliation runs: RUNNING → MATCHED/MISMATCH/
FAILED, immutable afterwards. Provider transaction references are
UNIQUE at the database level; instruction idempotency keys are UNIQUE
at the database level.

## Balance accounting identities (verified per operation)

Whole-currency integers only; every mutation is one guarded UPDATE with
non-negativity of every adjusted column in its WHERE clause.

| Operation | available | held | releaseEligible | pendingOutbound | settledOutbound | returned | mock bank book |
|---|---|---|---|---|---|---|---|
| Demo credit +C | +C | | +C | | | | +C |
| Place hold H | −H | +H | −H | | | | |
| Release hold H | +H | −H | +H | | | | |
| Create instruction A (earmark) | | | −A | | | | |
| Cancel (pre-submission) | | | +A | | | | |
| Submit A | −A | | | +A | | | |
| Settle A | | | | −A | +A | | −A |
| Fail A (in flight) | +A | | +A | −A | | | |
| Return A (post-settle) | +A | | +A | | | +A | +A |
| Reverse A (post-settle) | +A | | +A | | −A | | +A |

## Reconciliation analysis

Invariant re-derived independently (not just accepted from the docs):

```
bankReported(program) = Σ accounts (available + held + pendingOutbound) + suspense(0)
```

Walking every row of the table above, both sides change by identical
amounts on credit/settle/return/reverse and by zero on every other
operation, so the invariant is **correct** through reservation,
submission, settlement, failure, return, reversal, active holds and any
number of pending/settled transactions; it is a sum over ALL program
accounts, so multiple project accounts are covered by construction. The
adversarial suite reconciles to MATCHED after the complete hostile
sequence. `releaseEligible` is deliberately NOT in the invariant — it
is OBV's forward-commitment subledger (available minus instruction
earmarks) used for the creation-time sufficiency rule.

Mismatch behavior (verified): immutable run history; deterministic
CRITICAL `BANKING_RECONCILIATION` exception created/reopened via the
existing exceptions engine; creation, approval AND submission blocked
while the latest completed run is not MATCHED (a FAILED run therefore
blocks identically — that is the defined behavior); balances never
rewritten; affected program + projects identified in findings; resolved
only by a later attributable MATCHED run (exception auto-resolves with
SOURCE_CLEARED, history preserved). A crash that abandons a run in
RUNNING has no blocking effect (RUNNING is ignored by
`latestCompletedRun`); the abandoned row remains visible history.

## Authorization and tenant-isolation findings

Verified per route (JSON and crafted form posts): authorized same-tenant
user succeeds; same-tenant user without the capability → 403;
unrelated organization and nonexistent record → identical 404 (probes
covered instruction approve/cancel, hold release, credit, eligibility,
banking view — 6 routes by direct object-ID guessing); view-only
fallback (COMPLIANCE_REVIEWER) cannot mutate anything (5 mutation
routes → 403); creator-cannot-approve and draw-submitter-cannot-approve
hold in both authority modes; the lender tab reveals no balances,
recipients, instructions, transaction references or reconciliation
state without `VIEW_PROJECT_ACCOUNT` (fixed pre-merge, re-verified
adversarially). Idempotency keys are globally unique; a cross-tenant
key collision reveals only that some random string is in use (keys are
client-generated UUIDs; enumeration is infeasible) — accepted and
documented.

## Idempotency findings

- Instruction creation: same key + identical normalized request →
  same instruction returned (even after its state advanced), with NO
  second reservation; same key + any differing business parameter
  (draw, amount, recipient, method, reference) → explicit 409.
  **Defect fixed:** the equivalence check ran before the write lock, so
  two concurrent same-key requests could race to a raw UNIQUE-constraint
  error; the checks now run inside `BEGIN IMMEDIATE` with the
  constraint surfaced as the same controlled 409.
- Provider events: same eventId + same transaction + same type →
  idempotent no-op (fingerprint byte-identical). **Defect fixed:** a
  reused eventId against a DIFFERENT transaction or with a different
  event type was silently reported as a duplicate; the mock bank now
  records each eventId with its `type:transactionRef` identity and
  throws an explicit 409 conflict.
- Reconciliation: every run is a new immutable record (by design, not
  deduplicated). Package generation: every generation is a new
  immutable versioned report (by design).

## Webhook-processing findings

Event IDs deduplicated via the provider's event ledger (identity-
checked, conflict-rejecting); raw payloads never retained — only
SHA-256 hashes (`raw_event_hash`); failure text sanitized (control
characters stripped, truncated) before storage; event type validated
against the transaction's current state via guarded transitions;
provider reference resolved to the intended transaction by
construction (the service passes its own transaction's reference);
organization/account relationships revalidated through tenant-checked
accessors; processing wrapped in one `BEGIN IMMEDIATE` transaction —
the bank-book write, both state transitions, the balance movement and
the audit events commit or roll back together. **Defect fixed:**
failure/return/reversal moved the transaction without asserting the
instruction's matching transition; all monetary event paths now move
instruction and transaction in lockstep or roll back entirely.
Timestamps come from the OBV server clock (`new Date()`), the defined
trusted source for this simulation; a real adapter would additionally
record provider-supplied event times as data.

## Defects found and fixed (with regression coverage)

| # | Defect | Severity | Fix | Regression |
|---|---|---|---|---|
| 1 | Provider failure/return/reversal could move the bank transaction without the instruction (divergence on guard failure) | major (latent — not reachable through current flows, guarded against future ones) | lockstep transitions: event rolls back unless both records move | vam-adversarial §5–7 fingerprint checks |
| 2 | Conflicting provider-event reuse (same eventId, different transaction/type) silently reported duplicate | major | event-identity ledger; explicit 409 | vam-adversarial [24]–[25] |
| 3 | Idempotency/duplicate checks ran outside the write lock (concurrent race → raw constraint error / possible duplicate equivalents) | medium | checks inside `BEGIN IMMEDIATE`; UNIQUE surfaced as controlled 409 | vam-adversarial [12], vam-test idempotency block |

Additional adversarial cases examined WITHOUT defects: every forbidden
transition in both matrices, double release of holds, over-reservation
under concurrent-style repeats, negative-balance attempts, stale
decisions/conditions/exceptions/mismatches at approval and submission,
masked-identifier sweeps across HTML/JSON/package registers,
production-mode refusal of every demo control, cross-tenant object
guessing, view-only mutation attempts, direct-SQL-free route handlers.

## Tests added

- `scripts/vam-adversarial-test.js` — 50 checkpoints (list above).
- Unified runner `scripts/run-all-tests.js` + `npm test` / `npm run
  check`; `OBV_DB` support in intelligence/report suites so the
  runner's temp database is their truth source.
- CI: `.github/workflows/ci.yml` (required check `ci`) runs the
  complete validation on PRs into main, pushes to main and manual
  dispatch, pinned to `OBV_BANKING_PROVIDER=mock` /
  `OBV_BANKING_MODE=demo`.

## Remaining limitations

- Default branch + branch protection require the one-minute manual
  steps in `docs/REPOSITORY_PROTECTION.md` (proxy-blocked here).
- Mock provider only; adapters stay disabled boundaries; suspense ≡ 0.
- True multi-process concurrency is simulated (sequential replays +
  SQL-staged races + guarded single-statement arithmetic), not
  load-tested.
- Idempotency-key namespace is global (documented, accepted).

## Live deployment verification status

**Not verified live.** This sandbox cannot reach onrender.com or
api.render.com and no authenticated Render access exists. Verified in
repository configuration: production service tracks `main`; preview
service separate; no banking env configured in render.yaml (defaults =
mock/demo); no production-enable flag; no credentials committed;
deploy-check fails if any of that regresses. Manual Render-dashboard
checks still required: deployed commit SHA, `/api/health`, homepage,
`/project/proj-r47/account` (demo-simulation banner), lender-tab
banking summary, verification-package generation, startup log free of
errors.
