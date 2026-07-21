# Lender-Pilot Domain — Final Correction Pass

Base: `1f9171a` (hardening pass). This pass corrects the eleven defects
identified in the hardening review. Product boundaries are unchanged:
VerificationAggregator, the Evidence Ledger, permit/government-inspection
truth, the formal approval matrices, VirtualAccountService, change orders,
retainage and the exactly-once release path are untouched.

## 1. Capabilities truly authoritative in membership mode

`requireAuthority(user, projectId, cap, legacyCheck)` replaces the old
additive `capabilityGate`. In **legacy mode** (no active memberships) the
original role checks run unchanged. In **membership mode** the capability
is the sole authority and the legacy role gate is *not consulted*: a FIELD
user explicitly granted SUBMIT_DRAW can create and submit a draw, and a
role that would legacy-pass cannot act without the capability.
Separation-of-duties checks are not role gates — they hold in both modes.
Applied to `createDraw`/`submitDraw` (SUBMIT_DRAW), `recordDocument`
(UPLOAD_DRAW_DOCUMENT), `canReviewDraw`/`assertReviewer` (REVIEW_DRAW) and
`reportContractorCompletion` (REPORT_CONTRACTOR_COMPLETION).

## 2. Tenant-safe project access in createDraw and draw operations

`createDraw` now resolves the project and requires
`canAccessProjectFinance` **or** an active membership before anything else
— unrelated tenants (and nonexistent projects) receive the same 404.
`canAccessDraw` additionally honours active memberships, so every draw
operation behind `assertAccess` is reachable by explicitly assigned
participants and closed to everyone else.

## 3. Correct verifiedAmount

A SUPPORTED line contributes its full `currentRequested`; a
PARTIALLY_SUPPORTED line contributes its reviewed `supportedAmount`;
EXCEPTION/REJECTED lines contribute nothing. The value stays **null until
every line carries a review outcome** — a partial review never
masquerades as verified. Provenance string updated accordingly.

## 4. Strict normalized whole-currency validation

`wholeAmount()` (lenderDecisions, exported) and `num()` (loanProfile)
normalize with `Number()` and require a finite, non-negative **integer**.
Fractional amounts are rejected with 400 — never silently rounded.
Applied to all decision amounts, funding `amountScheduled` /
`amountDisbursed` / `wireFee`, lien-waiver `relatedAmount`, and every loan
figure.

## 5. Atomic condition state + condition-event transactions

`updateConditionTx` commits the guarded state UPDATE (prior status must
still be non-terminal) and the history event as one unit; a concurrent
transition is a controlled 409 and a refused transition appends **no**
event. Condition creation events now ride inside `createDecisionTx`.

## 6. Funding revalidation at PROCESSING and DISBURSED

Entering PROCESSING or DISBURSED re-checks, as of now: the decision still
exists and is not superseded; its type is still fundable; no condition is
in a blocking state; and the pending amount respects the cumulative
disbursement cap. The in-transaction cap check at DISBURSED is retained
on top.

## 7. Completion-gate-based government inspection stage

`governmentInspectionsChecked` now evaluates every draw-line milestone
through `completionGates.evaluateDrawEligibility` — the authoritative
six-gate machinery including reinspections, permit activity and
code-basis controls. Any inspection/permit/code-basis reason code blocks
the stage, and an UNDETERMINED requirement never behaves as NOT_REQUIRED.

## 8. Complete per-line evidence coverage

`evidenceReviewCompleted` requires **every draw line** to be covered by at
least one evidence link whose VerificationAggregator verdict is VERIFIED
(line-scoped, or a VERIFIED draw-level link). REJECTED or NEEDS_REVIEW
evidence never counts as coverage.

## 9. Chronological membership effective-date evaluation

`chronoMs` replaces lexicographic string comparison. Date-only values are
UTC calendar days: `effectiveFrom` takes effect at 00:00:00Z,
`effectiveTo` remains effective **through** that day (23:59:59.999Z).
Window validation in `assignMembership` uses the same semantics.

## 10. Transactional party replacement

`replacePartyAssignmentTx` ends the displaced active assignment(s) with a
guarded UPDATE and inserts the successor in one transaction — no window
with two active holders, no dangling predecessor, concurrent replacement
surfaces as 409.

## 11. Transactional inspection report/version/state/event lifecycle

All independent-inspection lifecycle writes are single transactions with
optimistic-concurrency guards: creation + REQUESTED event; every status
transition + its event (`inspectionTransitionsTx`); the COMPLETED →
REPORT_PENDING pair; draft creation + REPORT_RECEIVED → UNDER_OBV_REVIEW
advancement (`createReportVersionTx`, with the new
`idx_one_draft_report_version` partial unique index enforcing a single
draft); finalization + SUPERSEDED priors + inspection transitions
(`finalizeReportLifecycleTx`); OBV review / lender-decline field updates
(`updateInspectionFieldsTx`); line findings (`insertInspectionLineTx`);
and reinspection with both events (`createDrawReinspectionTx`).

## 12. Adversarial-review fixes

An adversarial multi-agent review of this pass confirmed and fixed nine
further defects before commit:

1. Membership-based draw access no longer bypasses capabilities: every
   draw mutation (updateDraft, cancelDraw, addLine, updateLine,
   deleteLine, addRequirement, linkEvidence, unlinkEvidence,
   resolveClarification) now carries its membership-mode capability
   (SUBMIT_DRAW for request assembly; SUBMIT_DRAW / UPLOAD_DRAW_DOCUMENT /
   REVIEW_DRAW for evidence curation).
2. addRequirement's unconditional legacy FIELD gate is now mode-split.
3. The FORMAL governance path (`processDrawApprovalDecision`) uses the
   pre-membership ORGANIZATIONAL access rule verbatim — an administrative
   membership can never reach the approval matrix or the release path.
4. `completionGates.assertAccess` honours active memberships, so a
   membership-granted REPORT_CONTRACTOR_COMPLETION is exercisable
   cross-org (authority still sits with each action's own gate).
5. `transitionFundingTx` is guarded on the OBSERVED prior status —
   concurrent funding transitions are one success + one 409, never a
   double-applied status.
6. `updateInspectionFieldsTx` re-checks the caller's status precondition
   INSIDE the transaction (OBV review: UNDER_OBV_REVIEW/FINALIZED; lender
   decline: FINALIZED).
7. `idx_one_active_party` (partial unique index) makes a second ACTIVE
   holder of a party role impossible at the database level — closing the
   vacant-role concurrent-insert race.
8. Editing a reviewed line's `currentRequested` RESETS its review
   (status → PENDING, supportedAmount/reviewer cleared), so a SUPPORTED
   verdict can never be inflated after the fact — verifiedAmount
   integrity holds end-to-end.
9. `wireFee` is persisted normalized (`''` → NULL, never 0), and the
   RELEASED-milestone eligibility short-circuit no longer clears the
   government stage: `inspectionSurfaceClean` evaluates the inspection /
   permit / code-basis surface independent of tranche accountStatus, so a
   released milestone keeps its inspection truth.

## 13. Tests

`scripts/lender-test.js` PART P adds 22 checkpoints and PART Q adds 9
review-fix checkpoints (110 → **141**), covering all eleven correction
areas; all 21 other suites pass unchanged.
