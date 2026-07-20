# Lender-Pilot Domain — Correctness, Transaction-Safety & Authority Hardening

Base: `28e9213` (lender-pilot domain completion). This pass changes no
product boundaries: VerificationAggregator, the Evidence Ledger,
permit/government-inspection truth, the formal approval matrices,
VirtualAccountService, change orders, retainage and the exactly-once
release path are all untouched (re-verified by the financial no-touch and
boundary checkpoints below).

## 1. Capability integration with core draw actions

`capabilityGate(user, projectId, cap)` in `lenderAccess.ts` implements the
documented legacy-compatibility rule:

- A project with **no active memberships** keeps the existing legacy role
  behavior unchanged — the gate is a no-op.
- Once **any** active membership exists on the project, capabilities become
  authoritative: the actor must hold the required capability via membership
  or the conservative role fallback (FUNDER_REP → LENDER_REVIEWER,
  COMPLIANCE_REVIEWER → OBV_REVIEWER).

Wired into: `createDraw`/`submitDraw` (SUBMIT_DRAW), `recordDocument`
(UPLOAD_DRAW_DOCUMENT), every reviewer path via `assertReviewer`
(REVIEW_DRAW — separation of duties is never relaxed by a capability
grant), and `reportContractorCompletion` (REPORT_CONTRACTOR_COMPLETION).

## 2. Membership-based project access

`assertProjectAccess` and the draw-scoped lender routes now grant access to
holders of an active membership (additive — never restrictive). Users with
neither legacy finance access nor a membership still receive the same 404
as a nonexistent record, on this and on every unrelated project.

## 3. Lender decisions aligned with governance outcome

`recordLenderDecision` enforces the truth table against the draw's
authoritative ApprovalRequest (`getApprovalRequestForDraw`):

- APPROVED / CONDITIONALLY_APPROVED / REDUCED → governance **APPROVED**
- REJECTED → governance **REJECTED**
- PENDING / WITHDRAWN → non-final; no governance required

plus completeness (every required role decided) and contradiction checks
(no non-APPROVED role record behind an APPROVED outcome; a REJECTED
outcome must have a rejecting record). Input-shape validation runs first
(400) so state conflicts are cleanly 409.

## 4. Amount semantics

All amounts must be finite and non-negative; approved+reduced+rejected can
never exceed requested; holdback/retainage can never exceed approved.
APPROVED requires `approvedAmount === requestedAmount`; REDUCED requires
`approved + reduced === requested` with a reason; REJECTED accounts for
the full requested amount with a reason; CONDITIONALLY_APPROVED requires a
positive approvedAmount ≤ requested **and** explicit categorization of the
undisposed difference (holdback/reduced/rejected).

`verifiedAmount` is derived from reviewed draw-line `supportedAmount` with
its own provenance string (`verified_amount_source`);
`recommendedAmount` carries the advisory-recommendation provenance
(`recommended_amount_source`). Neither is ever copied from the other.

## 5. Transactional, unique decision creation

`createDecisionTx` validates everything, then supersedes priors and
inserts the decision + conditions in one `BEGIN IMMEDIATE` transaction
(FKs deferred to COMMIT so the forward supersede reference is validated on
the consistent whole). The partial unique index
`idx_one_current_lender_decision` (one row per draw with
`superseded_by_decision_id IS NULL`) makes concurrent final decisions one
success + one controlled 409. At most one active PENDING exists; a final
decision auto-supersedes it.

## 6. Condition semantics

Funding is possible only when every condition is SATISFIED or WAIVED —
OPEN, IN_PROGRESS, FAILED and CANCELLED all block. Terminal condition
states cannot be resurrected. Every condition status change appends to
`lender_condition_events` (append-only, fully chained prior→new).
Condition `dueAt` and responsible-party references are validated before
any write.

## 7. External funding hardening

Scheduling rejects superseded/pending/rejected decisions, blocked
conditions and non-positive amounts; `idx_one_active_funding` allows only
one SCHEDULED/PROCESSING record per draw. `transitionFundingTx` enforces
the cumulative cap in-transaction: non-reversed disbursements can never
exceed the lender-approved amount. The decision row is **never** mutated
to FUNDED — payment state is derived (`derivedPaymentStatus`) and exposed
as `paymentStatus` on the decision read. Reversal preserves the original
disbursement figures and the derived stage falls back honestly (a
reversed/failed record never presents as FUNDS_DISBURSED or DRAW_CLOSED).

## 8. Grounded stage derivation

`drawWorkflow.ts` documents the exact 22-stage precedence. The
UNDER_REVIEW pipeline is sequential-cumulative (documents → government
inspections → evidence): each stage requires every earlier step, so a
vacuously-true later check can never mask an unfinished earlier one.
FINANCIAL_DOCUMENTS_REVIEWED requires the checklist complete and every
received document reviewed; GOVERNMENT_INSPECTION_CHECKED reads the same
InspectionRequirement + JurisdictionalInspection records the completion
gates use; EVIDENCE_REVIEW_COMPLETED requires ≥1 evidence link and
VerificationAggregator verdicts beyond NEEDS_REVIEW.

## 9. Transactional reinspection

`createDrawReinspectionTx` flags the prior REINSPECTION_REQUIRED (guarded
conditional UPDATE) and inserts the child in one transaction;
`idx_draw_reinspection_single_child` guarantees a single child per prior
under concurrency. Ancestry is walked before extending: self-references,
circular chains and cross-draw chains are refused.

## 10. Inspection-line relational integrity

Findings validate `drawLineItemId` (same draw), `budgetLineId` and
`milestoneId` (same project) and their consistency with the referenced
draw line — all as 422 with generic wording (no tenant leaks). Duplicate
findings per (inspection, draw line) are refused via
`idx_inspection_line_unique` → 409.

## 11. Frozen applied policy per draw

`freezeAppliedPolicy` records the active policy (id + version) into
`draw_policy_applications` at **first** successful submission; later
policy versions and resubmissions never rewrite it. The draw package's
`lender-policy-applied.json` reports the frozen version only; legacy
draws with no application report NOT RECORDED — never backfilled.
`createPolicyVersionTx` deactivates priors and inserts the new version in
one transaction; project-scoped changes also snapshot the project
configuration.

## 12. Strict dates & transactional transfers

All lender-domain dates go through the permit module's strict
`parseIsoDate` (loan closing/maturity/completion dates, transfer
`effectiveAt`, party/membership effective windows, inspection
scheduled/preferred/completed/report dates, condition `dueAt`, funding
`scheduledAt`, waiver `coveredThrough`/`signatureDate`). Ownership and
servicing transfers append the history event and move the current pointer
in one transaction (`recordLoanTransferTx`). Documented pilot rule:
**future-dated transfers are rejected (422)** so the current pointer can
never reflect an ownership that has not yet taken effect.

## Schema additions

- Tables: `lender_condition_events`, `draw_policy_applications`
- Columns: `lender_draw_decisions.verified_amount_source`,
  `recommended_amount_source`
- Partial unique indexes: `idx_one_current_lender_decision`,
  `idx_draw_reinspection_single_child`, `idx_one_active_funding`,
  `idx_inspection_line_unique`

## Verification

- `scripts/lender-test.js`: **110 checkpoints** (was 73), including the
  legacy→capability transition, membership access grant/end, governance
  truth table, amount reconciliation, PENDING auto-supersede with
  DB-enforced single current decision, provenance, funding caps and
  single-active-record, condition lifecycle blocking with append-only
  events, stage grounding (documents/government/evidence), duplicate
  findings, reinspection single-child, policy freeze across versions and
  resubmission, strict-date rejections, future-dated transfer rejection,
  and validate-before-write (failed amendment leaves the prior decision
  current).
- All 21 other suites pass unchanged (acceptance 17, audit package,
  budget, change orders, chat, draw package, draws, exceptions, field ops,
  gates, home, idempotency, intelligence, map 26, permits 82, pilot,
  report, teams, teams-sync, verification, whatsapp-sync).
- The boundary checkpoint re-verifies that no lender-domain module
  imports or calls VirtualAccountService or any release/withhold function,
  and the external-funding lifecycle changes zero governed account events.
