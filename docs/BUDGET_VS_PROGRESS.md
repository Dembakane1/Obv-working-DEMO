# Budget vs Verified Physical Progress — methodology & runbook

A transparent comparison between money claimed/paid and physical progress
supported by verified evidence. This is not accounting software, not cost
forecasting, and not an AI prediction engine. Its purpose is to make
visible when financial progress appears materially ahead of verified
physical progress.

## Core principle

Financial progress and physical progress are **different measurements**.
OBV computes each from its own records and compares them side by side —
it never merges them into one number.

**Language rule.** The strongest statement any OBV surface makes is:
*"financial progress is ahead of currently verified physical progress."*
A variance is a comparison result, never a claim of misuse — the test
suite greps every surface for prohibited language.

## Model

| Entity | Purpose |
| --- | --- |
| `BudgetLine` | Cost code per project: original budget, approved changes, committed, paid to date, retainage, currency, sequence, active. `currentBudget` is **derived** (original + approved changes), never stored. Codes are unique per project. |
| `BudgetLineMap` | Optional mapping to milestones (the physical basis) and evidence requirements. Draw line items map through `DrawLineItem.budgetLineId` matching the line's code or id. |
| `VerifiedQuantity` | Explicit reviewed partial-progress record ("9.8 of 14 km base laid", 60%). Entered only by an authorized reviewer, with a reason, referencing a **VERIFIED** evidence item of the same milestone. New records supersede old ones; all are audited. |

## Physical-progress methodology (deterministic, explainable)

1. **Weights.** Every non-archived milestone gets a normalized weight:
   - `CONFIGURED_WEIGHTS` when every milestone has a configured weight,
   - else `TRANCHE_PROPORTIONS` (tranche amount over total tranches),
   - else `EQUAL_WEIGHTS`.
   The source used is disclosed on every surface.
2. **Completion.** A milestone contributes `weight × completion` where:
   - completion = **1** when the milestone is VERIFIED / APPROVED /
     RELEASED (its evidence passed the verification pipeline),
   - completion = **percent/100** when an active `VerifiedQuantity`
     exists (explicit measured data through the authorized reviewed
     process — never inferred from a photo),
   - completion = **0** otherwise. **Unverified evidence contributes
     nothing.** No arbitrary percentage is ever inferred from one photo.
3. **Traceability.** Every non-zero contribution carries its basis:
   evidence item id, verification id/verdict/confidence, policy version,
   ledger entry number, and (when applicable) the quantity record. The
   Budget & Progress page shows "View evidence basis" per contribution —
   no physical percentage appears without an explainable source.

## Financial-progress methodology (real records only)

- **Budget basis** = Σ `currentBudget` of active budget lines; when no
  budget lines exist, the project total budget (source disclosed).
- **Paid to date** = Σ budget-line `paidToDate`; fallback = released
  milestone tranches on the virtual account.
- **Claimed** = paid + Σ requested amounts of draws currently open
  (SUBMITTED → READY_FOR_GOVERNANCE).
- `paidPct` / `claimedPct` = those figures over the budget basis.

## Variance rules

`variance = claimedPct − verifiedPhysicalPct` (percentage points).
Thresholds are configurable (`OBV_VARIANCE_WITHIN_PTS` /
`OBV_VARIANCE_WATCH_PTS`; defaults 5 / 10):

| State | Rule |
| --- | --- |
| WITHIN RANGE | \|variance\| ≤ within (5 pts) |
| WATCH | within < variance ≤ watch (5–10 pts) |
| FINANCIAL AHEAD | variance > watch (10 pts) |
| PHYSICAL AHEAD | variance < −within (verified work ahead of billing) |
| DATA INCOMPLETE | missing budget basis, no milestones, or (per line) no milestone mapping |

The same rules apply per budget line (financial = paid + open requested
over the line's current budget; verified = mapped milestones with weights
re-normalized) and per draw line item (financial = completed + stored
over scheduled value; verified = the anchored milestone's completion).

## Surfaces

- **`/budget`** — portfolio comparison (one dual-bar visualization per
  project: financial vs verified physical, same scale).
- **`/project/:id/budget`** — Budget & Progress control page: original /
  changes / current budget, paid, open draw requested, retainage,
  variance; the comparison bars; per-category rollups; the budget line
  register (code, category, current budget, paid, current requested,
  verified progress, financial progress, variance state, next action);
  the methodology panel with per-milestone evidence basis; audited
  budget-change forms and the reviewed-quantity form.
- **Draw detail → Line Items** — every line shows financial %, verified
  physical %, and a variance state. Material variance surfaces an
  **exception candidate** flag (advisory — the reviewer decides; the
  draw is never rejected automatically).
- **Draw Review Summary report** — a "Budget vs verified physical
  progress" section (project + per-line) with the methodology disclosed.
- **OBV Intelligence** — deterministic signals: `budget-financial-ahead`,
  `budget-physical-ahead-of-billing`, `budget-line-unsupported-request`,
  `budget-line-repeated-variance`,
  `budget-line-missing-evidence-requirement` — each linking to the draw,
  budget page, or setup record it derives from.

## Change control

Post-launch budget changes (original budget, approved changes,
active/inactive) can never happen silently: an explicit reason is
required (HTTP 422 otherwise), the change is written to the
configuration audit trail, and a new configuration snapshot/version is
recorded. `approvedChanges` is the integration seam for a future Change
Orders module — when it exists, approved changes must be derived from
approved change records rather than edited here. Recording paid-to-date
is a financial record update, not a budget change, and needs no reason.

## Known limitations

- Paid-to-date on budget lines is an entered financial record (OBV is
  not connected to a bank or accounting system); the honest fallback is
  released virtual-account tranches.
- Physical progress is milestone-grained; partial progress exists only
  through explicit reviewed quantities, so a project with coarse
  milestones will read conservatively (verified progress lags).
- Weights are configuration; if they misrepresent the real cost/effort
  distribution, both measurements remain honest but the comparison
  inherits the configuration's shape (the weight source is always
  disclosed).
- Category rollups re-normalize weights within mapped milestones; lines
  without milestone mappings read DATA INCOMPLETE rather than guessing.

## Tests

`node scripts/budget-test.js` — 39 checkpoints covering the 16 required
cases: line creation/reconciliation, milestone mapping, verified and
unverified contributions, paid/claimed math, all five variance states,
traceability, quantity guardrails (authorized role, verified evidence
only, no 100% via quantity), prohibited-language scan, draw integration
(advisory exception candidates, no auto-reject), intelligence signals,
post-launch change control (reason + audit + snapshot + version), tenant
isolation, and report-figure reconciliation.
