# VAM Reconciliation — formula, mismatch handling, resolution

## The documented invariant

For a banking program, with all amounts as whole-currency integers
(floating point never touches a reconciliation comparison):

```
bankReportedBalance(program)
  = Σ over the program's project accounts
      ( available_balance
      + held_balance
      + pending_outbound_amount )
  + suspenseBalance(program)          // ≡ 0 in this phase
```

Why `pending_outbound_amount` is **added**: a submitted-but-unsettled
payment has already left OBV's spendable ledger (available) while the
funds are still at the bank. It is the "unsettled outbound adjustment"
between the two books. On settlement the amount leaves both sides at
once (pending → settled outbound on OBV's book; a settlement debit on
the bank's book), so the invariant holds through every lifecycle step:

| Step | OBV deltas | Bank book delta |
|---|---|---|
| Demo credit +C | available +C, releaseEligible +C | +C |
| Place hold H | available −H, held +H, releaseEligible −H | 0 |
| Release hold H | reverse of place | 0 |
| Create instruction A | releaseEligible −A (earmark) | 0 |
| Cancel (pre-submission) | releaseEligible +A | 0 |
| Submit A | available −A, pendingOutbound +A | 0 |
| Settle A | pendingOutbound −A, settledOutbound +A | −A |
| Fail A (in flight) | pendingOutbound −A, available +A, releaseEligible +A | 0 |
| Return A (post-settle) | available +A, releaseEligible +A, returned +A | +A |
| Reverse A (post-settle) | available +A, releaseEligible +A, settledOutbound −A | +A |

`release_eligible_balance` is intentionally **not** part of the
invariant: it is OBV's forward-looking commitment ledger (funds not
held and not already earmarked by an instruction), used for the
sufficient-balance rule at creation.

In demo mode the bank's book is the mock provider ledger
(`mock_provider_ledger`), written only by the mock provider when it
processes deposits and monetary events — a real adapter would replace
those reads with the provider's balance report and OBV's side would not
change.

## Running reconciliation

`POST /api/projects/:id/banking/reconcile` (capability
`RUN_RECONCILIATION`). Each run records: started/completed timestamps,
status (`MATCHED` / `MISMATCH` / `FAILED`), bank-reported balance,
ledger-calculated balance, exact difference, account and transaction
counts, findings JSON (including per-account components on a match and
affected projects on a mismatch), the initiating user and a link to the
previous successful run. A matched run stamps `last_reconciled_at` on
every program account.

`demoForceMismatchAmount` (demo mode only) offsets the mock bank's
*report* — never any stored balance — to exercise the mismatch path.

## Mismatch behavior

A `MISMATCH` (or `FAILED`) run:

1. records the reported and calculated values and the difference,
   identifying affected project accounts in its findings;
2. drives the deterministic exception rule
   `banking-reconciliation-mismatch:<program>:<project>` — a **CRITICAL**
   `BANKING_RECONCILIATION` / `INTEGRITY` exception is created (or
   reopened on recurrence) through the existing exceptions engine;
3. **blocks new payment work** for the program: while the most recent
   completed run is not `MATCHED`, `reconciliationBlocked` refuses
   instruction creation, approval and submission (409), and the
   workspace shows the blocking banner;
4. **never adjusts the ledger to force a match** — no code path writes
   balances during reconciliation.

## Resolution

Resolution is attributable: someone investigates, corrects the source
records through governed actions (or the demo offset is simply absent),
and runs reconciliation again. A later `MATCHED` run clears the
deterministic condition, so the exceptions sweep auto-resolves the
critical exception with `SOURCE_CLEARED` — recorded in the exception's
own append-only event history. The mismatch run, its findings and the
exception's REOPENED/RESOLVED history are immutable and are exported in
`reconciliation-runs.csv` with mismatch rows marked
`INTEGRITY_FINDING`.
