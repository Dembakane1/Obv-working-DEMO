# Milestone Completion Gates — model & runbook

**PHOTOGRAPHIC COMPLETION IS NOT LEGAL OR CONTRACTUAL COMPLETION.**

Six separate authoritative dimensions replace any single ambiguous
"COMPLETE" state. A milestone can truthfully display, at the same time:

```
Contractor completion     REPORTED COMPLETE
OBV evidence review       VERIFIED
Inspection requirement    REQUIRED
Inspection status         SCHEDULED
Draw eligibility          BLOCKED
Funds                     HELD
```

## State model

1. **Contractor completion** (`NOT_REPORTED / IN_PROGRESS /
   REPORTED_COMPLETE / WITHDRAWN`) — additive milestone fields with
   reportedBy/At, notes and linked evidence submissions. Reported by the
   delivery side (PM/field), audited. REPORTED_COMPLETE means only "the
   contractor represents the configured work is complete" — never a
   verification result, inspection result, approval or release.
2. **OBV evidence review** (`NOT_SUBMITTED / SUBMITTED / UNDER_REVIEW /
   NEEDS_REVIEW / REJECTED / VERIFIED`) — DERIVED live from the governed
   EvidenceItems + VerificationAggregator results; no second truth is
   stored. VERIFIED means only that the configured OBV evidence policy
   is satisfied.
3. **Jurisdictional inspection requirement** (`UNKNOWN / NOT_REQUIRED /
   REQUIRED`) — an `inspection_requirements` row records the attributable
   determination (basis, determinedBy/At, jurisdiction, type, authority,
   config version) plus gate configuration (mustPassBeforeDrawReview,
   mustPassBeforeGovernance, finalCompletionOnly,
   resultDocumentRequired). ABSENCE of a row is UNKNOWN — NOT_REQUIRED is
   never inferred, and a basis is mandatory. Determinations are restricted
   to funder rep / compliance reviewer, audited, and snapshotted with
   project configuration (prospective only; history never rewritten).
4. **Inspection scheduling** and 5. **Inspection outcome** — first-class
   `jurisdictional_inspections` records (`REQUIRED_UNSCHEDULED /
   SCHEDULED / COMPLETED_PENDING_RESULT / PASSED / FAILED / CANCELLED /
   EXPIRED`) with schedule, completion, result, permit/reference,
   supporting document and notes. The government inspector is recorded as
   TEXT identity — never an OBV user unless they hold a real OBV account;
   the attributable internal reviewer (`reviewedByUserId`) records the
   external result. **An uploaded document never becomes PASSED** — only
   the formal reviewed result action (funder rep / compliance) does, and
   a configured result-document requirement blocks PASSED without a
   reference.
6. **Draw eligibility** — derived, below.

## Derived eligibility rules

`evaluateDrawEligibility(milestoneId)` is deterministic and returns
`NOT_ELIGIBLE / ELIGIBLE_FOR_DRAW_REVIEW / READY_FOR_GOVERNANCE /
BLOCKED / RELEASED` plus structured reasons `{code, detail, blocking}`
(e.g. `CONTRACTOR_COMPLETION_NOT_REPORTED`, `EVIDENCE_NEEDS_REVIEW`,
`EVIDENCE_REJECTED`, `INSPECTION_REQUIREMENT_UNKNOWN`,
`INSPECTION_NOT_SCHEDULED`, `INSPECTION_PENDING`, `INSPECTION_FAILED`,
`JURISDICTIONAL_INSPECTION_NOT_PASSED`, `REQUIRED_DOCUMENT_MISSING`,
`HIGH_SEVERITY_EXCEPTION_OPEN`, `CHANGE_ORDER_NOT_APPROVED`,
`FORMAL_APPROVAL_PENDING`). Hard blockers (rejected evidence; REQUIRED
inspection not passed where governance-gated; failed/expired inspection;
missing configured result document; open HIGH/CRITICAL milestone
exception) → BLOCKED. UNKNOWN requirement never passes any gate.
READY_FOR_GOVERNANCE means only "all configured pre-governance gates are
satisfied" — eligibility has no code path to the VirtualAccountService;
release stays with the existing formal ApprovalRequest path, exactly
once. `finalCompletionOnly` scopes an inspection gate to the final
milestone.

## Migration behavior (conservative)

Additive columns/tables only. Existing milestones: contractor
NOT_REPORTED (no invented reports), evidence review derived live from
existing VerificationResults, inspection requirement UNKNOWN (absence of
a determination), inspection NOT_APPLICABLE only when explicitly
NOT_REQUIRED, eligibility recomputed from the gates. Released milestones
read RELEASED without implying an inspection ever passed. No historical
inspection events are invented; historic verifications keep their
original policy/config references.

## Draw integration

Draw line items linked to milestones show the six-gate summary and
blocking reasons on the lines tab. The deterministic reviewer
recommendation adds a line-scoped EXCEPTION reason ("REQUIRED
JURISDICTIONAL INSPECTION NOT PASSED") for lines whose milestone has a
REQUIRED, non-passed inspection with a configured gate — one blocked
milestone never rejects the whole draw; the existing partial-support
workflow holds only the ineligible amount.

## Exception integration

Deterministic, source-pointing, self-reconciling rules:
`inspection-requirement-unknown` and `inspection-unscheduled` (both only
once the contractor reported complete — migration creates nothing),
`inspection-overdue`, `inspection-failed` (HIGH), `inspection-doc-missing`,
`inspection-expired`, `draw-inspection-blocked` (per draw line). Clearing
the authoritative condition (e.g. a passed reinspection) auto-resolves
the exception on the next sweep; manual resolve remains source-aware.

## Reporting

- **Draw Verification Package**: `milestone-gates.csv`, six gates per
  milestone in `draw-summary.json` (`completionGates`), and a "Milestone
  completion gates" table in the lender PDF (section D2).
- **Draw Review Summary**: a milestone completion-gates table.
- **Project Audit Package**: `02_milestones/milestone-gates.csv`.
- All reports distinguish CONTRACTOR-REPORTED COMPLETE / OBV EVIDENCE
  VERIFIED / JURISDICTIONAL INSPECTION PASSED / READY FOR GOVERNANCE /
  FORMALLY APPROVED / RELEASED — the bare word COMPLETE is never used
  where the completion type is unclear.

## Intelligence signals (deterministic, no predictions)

`contractor-complete-evidence-pending`,
`verified-inspection-requirement-unknown`,
`inspection-required-not-scheduled`, `inspection-scheduled-overdue`,
`inspection-failed` (HIGH), `verified-but-inspection-blocked`,
`inspection-passed-governance-pending` (INFO).

## UI gate tracker

Every milestone detail page shows the six-gate sequence with precise
labels (REPORTED COMPLETE, NOT SUBMITTED/VERIFIED, REQUIRED/UNKNOWN —
NOT DETERMINED, SCHEDULED <date>, INSPECTION PASSED/FAILED/PENDING,
BLOCKED/READY FOR GOVERNANCE/RELEASED) plus blocking reason codes, and
role-appropriate actions: contractor report/withdraw (PM/field),
requirement determination (funder/compliance, basis required),
scheduling, and the formal reviewed-result action (funder/compliance,
with government inspector name + reference).

## API

```
GET  /api/milestones/:id/gates                    six gates + eligibility + reasons
POST /api/milestones/:id/contractor-completion    {status, notes, linkedEvidenceIds}
POST /api/milestones/:id/inspection-requirement   determination (basis required)
POST /api/milestones/:id/inspections              create/schedule inspection
POST /api/inspections/:id/schedule|complete|result|cancel
```

Tenant isolation: 404 outside the project's organizations. Chat has no
code path to any gate: messages can neither pass inspections nor create
eligibility (proven by test).

## Tests

`scripts/gates-test.js` — 35 checkpoints covering the 22 required cases,
including the full walk: contractor report → evidence verification
(gates stay separate) → REQUIRED determination → scheduled-still-blocked
→ upload-never-passes → chat-changes-nothing → reviewed PASSED
(inspector identity distinct) → READY_FOR_GOVERNANCE releases nothing →
existing governance path releases exactly once → FAILED inspection
exception created and reconciled → partial draw support → six gates in
PDF/CSV/JSON/audit package → conservative migration → tenant isolation.
