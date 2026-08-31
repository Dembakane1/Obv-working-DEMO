# DMV Draw Control Record + Governing Code and Permit Basis

> OBV records construction compliance evidence, source lookups, inspection status, verification results, and lender-review eligibility. OBV does not issue permits, perform government inspections, provide legal interpretations, approve loans, or automatically authorize payment.

This module gives OBV's first lender pilot a complete draw-control layer for
DMV rehab and fix-and-flip projects (District of Columbia, Maryland local
jurisdictions, Fairfax County, Arlington County, City of Alexandria). The
central control principle:

**A project's current compliance settings must never silently rewrite the
permit, code, inspection, or jurisdictional basis that applied when the work
was permitted or reviewed.**

## Architecture

The layer is additive and reuses the existing OBV architecture end to end:

| Concern | Module |
| --- | --- |
| Types | `src/shared/types.ts` (DMV block) |
| Schema | `src/server/db/index.ts` — 6 new tables |
| Repository | `src/server/db/dmvRepo.ts` (guarded transitions, append-only stores) |
| Domain service | `src/server/services/dmvCompliance.ts` |
| Exception rules | `src/server/services/exceptions.ts` (`dmv-*` rules) |
| Package registers | `src/server/services/dmvRegisters.ts` |
| Draw package | `src/server/services/drawPackage.ts` (+ `dmv` on `DrawPackageData`) |
| Audit package | `src/server/services/auditPackage.ts` (`13_dmv_compliance/`) |
| Visible package section | `src/server/view/drawVerificationDoc.tsx` |
| HTTP routes | `src/server/http/complianceRoutes.ts` |
| UI | `src/server/view/compliancePages.tsx` (`/project/:id/compliance`, `/draw/:id/control`) |
| Seeded demo | `src/server/db/seed.ts` (`seedDmvDemo`, project `proj-dmv`) |
| Tests | `scripts/dmv-test.js` (117 checkpoints, wired into `scripts/run-all-tests.js`) |

Existing infrastructure that is reused, not duplicated: the permit register
(`permits`), official-source provenance (`official_source_records`),
jurisdictional inspections, jurisdiction profiles, budget lines, draw
requests/lines/documents/evidence links, lien waivers, the exception engine,
the dispute release-hold read model (`drawDisputeHold`), the zero-dependency
ZIP/manifest package machinery, and `canAccessProjectFinance` tenancy.

## Data model

Six tables (all ids `randomUUID`, all timestamps ISO-8601 strings, all
amounts whole-currency INTEGER):

- **`permit_basis_versions`** — the Governing Code and Permit Basis. One row
  per version per permit (`UNIQUE(permit_id, version)`), carrying
  jurisdiction, permitting authority, property address, parcel identifier,
  permit number/type/status, trade type, work category, application/issuance/
  expiration dates, governing code edition, local amendments, transition-rule
  reference, governing-basis kind, applicability explanation, source system/
  URL/record id, lookup timestamp + user, verification method, attached
  source evidence, notes, correction metadata, a sha256 `record_hash` over
  the canonical content fields, effective-from/superseded bounds, and
  finalization attribution.
- **`transition_rule_records`** — prior/replacement code editions, transition
  period, application-date and permit-issuance cutoffs, eligibility
  (`ELIGIBLE_PRIOR_CODE` / `NOT_ELIGIBLE` / `PENDING_DETERMINATION`),
  governing interpretation, official source, lookup date, reviewer, notes,
  determination timestamp.
- **`line_inspection_requirements`** — required official inspections per
  budget line or milestone: authority, type, permit + basis-version link,
  prerequisite + sequence, before-concealment/payment/final flags, the
  12-status vocabulary, verbatim official result text, correction notice,
  reinspection fields, jurisdictional-inspection + official-source links,
  lookup date, external identifier, reviewer, notes.
- **`source_verifications`** — manual government-record verification runs
  (append-only): official service, search criteria, source-record id, lookup
  timestamp, performer, result status (6 values), summary, evidence source,
  method, confidence, next review date, scope links.
- **`cost_to_complete_estimates`** — append-only estimate history per budget
  line: verified completed value, remaining committed cost, estimate, source,
  estimator, date, confidence, notes.
- **`draw_permit_basis_pins`** — `UNIQUE(draw_request_id, permit_id)`; the
  basis version that governed a draw when its control record was generated.

## Permit-basis versioning (immutability)

- A version is created as `DRAFT` (recording roles), and becomes
  `AUTHORITATIVE` through an exactly-once guarded finalization by a
  determination role. A permit has at most one authoritative version.
- **Once authoritative, content never changes.** The only writes the
  repository exposes against the table are two guarded lifecycle updates
  (`DRAFT → AUTHORITATIVE`, `AUTHORITATIVE → SUPERSEDED`); no code path can
  touch a content column, and the test suite statically proves it.
- **Corrections insert a new version** carrying the merged content, the
  correction reason (required, substantive), the correcting user, the
  prior-version relationship (`supersedes_version_id`), a fresh content
  hash, and a new effective-from bound; the prior version keeps its original
  values with a `superseded_at` bound. Both run in one transaction.
- Changing the project's jurisdiction profile or a permit row's current code
  basis (the mutable "current compliance settings") never touches basis
  history — an explicit regression proves the table is byte-identical across
  those changes.

## Draw pinning (historical reference)

Generating a draw's control record pins the currently authoritative basis
version of every project permit to that draw via `INSERT OR IGNORE` — **the
first pin wins permanently**. Later corrections create new versions but never
move a pin, so an existing draw and its packages keep referencing the version
that applied when the draw was reviewed.

## Transition rules

Recorded rules start `PENDING_DETERMINATION`. OBV never infers legal
applicability from the current date: an authorized human (determination role)
confirms eligibility exactly once, and an `ELIGIBLE_PRIOR_CODE` determination
requires a recorded governing interpretation. A `PRIOR_CODE_TRANSITION` basis
can only be finalized against a rule determined `ELIGIBLE_PRIOR_CODE`. The UI
and packages display which of the five bases governs: current code, prior
code under transition, permit-specific grandfathering, local amendment, or
unresolved — in plain language, never as legal advice.

## Jurisdiction model

Jurisdiction profiles (`jurisdiction_profiles`) remain the mutable per-project
settings, with templates for DC, Montgomery/Prince George's Counties (MD),
Fairfax/Arlington/Loudoun/Prince William Counties, Alexandria and Falls
Church (VA). Basis versions snapshot the jurisdiction and permitting
authority at recording time, so profile changes never rewrite them. Permit and
trade types are free-form (validated, length-bounded) with a suggested DMV
vocabulary (`DMV_TRADE_TYPES`) — not a closed list.

## Inspection separation

An OBV field finding (draw-line reviewer status, verified photo evidence) and
an official jurisdiction inspection result are separate records:

- Official-result statuses (`PASSED`, `FAILED`, `PARTIAL`,
  `CORRECTION_REQUIRED`, `REINSPECTION_REQUIRED`, `NOT_FOUND`,
  `WAIVED_BY_AUTHORITY`) require a determination role **and** FRESH
  official backing supplied with the recording itself — the lookup
  timestamp plus verbatim official result text, an official-source record,
  or a jurisdictional-inspection record. Backing carried over from an
  earlier (possibly contradictory) lookup never supports a new status, and
  terminal results (`PASSED`/`FAILED`/`PARTIAL`) always require the
  verbatim result text of their own lookup.
- `NOT_REQUIRED` is itself a determination about what the jurisdiction
  requires: it demands a determination role and recorded basis notes — a
  borrower-side project manager can never neutralize a requirement.
- A recorded official `PASSED` is immutable (no transitions out; record a
  new requirement if the situation changes). `PARTIAL` is not a pass — it
  keeps blocking payment eligibility until the jurisdiction records the
  full result.
- Contractor completion, photographic evidence, OBV inspector findings, and
  official government status are carried as distinct fields everywhere and
  are never substituted for one another.

## Manual government-record verification

There is **no** live government integration, no credentials, no scraping, and
no automated calls to DOB or any other system (statically asserted by the
test suite). Authorized reviewers record documented manual lookups: official
service, search criteria, record identifier, lookup timestamp, result status
(`VERIFIED_MATCH`, `PARTIAL_MATCH`, `NO_MATCH_FOUND`, `RECORD_UNAVAILABLE`,
`SOURCE_UNAVAILABLE`, `MANUAL_REVIEW_REQUIRED`), screenshot/PDF evidence via
official-source records, confidence, next review date, and notes. Every
surface labels these as manual lookups.

## DMV Draw Control Record

`drawControlRecord(user, drawId)` builds a per-line read model with the full
specified field set: budget line, scope, jurisdiction, pinned governing
basis version(s), borrower-requested amount, contractor-reported percent and
completed amount, photo/invoice evidence counts, lien-waiver status, OBV
inspector finding + observed percent + supported amount, required official
inspections (status, source record, lookup date), prior funded, current and
cumulative requested, remaining budget, estimated cost to complete, projected
variance, retainage, open exceptions (severity + blocking effect), reviewer
notes, final eligibility status, and explicit reason codes.

### Eligibility logic

The evaluator is transparent — every result carries reason codes; there is no
hidden scoring. Reasons accumulate and the final status is the first bucket
in a documented precedence order with at least one reason:

`HELD_BY_LEGAL_HOLD → HELD_BY_DISPUTE → INELIGIBLE → EXCEPTION_OPEN →
INSPECTION_REQUIRED → OFFICIAL_STATUS_PENDING → EVIDENCE_INCOMPLETE →
OVER_BUDGET_REVIEW_REQUIRED → NOT_READY → ELIGIBLE_FOR_LENDER_REVIEW`

Inputs: pinned permit basis + live permit control status, dispute/legal holds
(`drawDisputeHold` unchanged), open HIGH/CRITICAL exceptions scoped to the
line, before-payment official inspections, verified line-scoped photo
evidence, line-scoped invoices, lien waivers, contractor-vs-inspector claim
comparison, prior funded/remaining budget/cost-to-complete, and reviewer
findings. The positive terminal is **"Eligible for lender review — not
automatically approved."** — the record never sets approved/authorized/
cleared state, never creates a lender decision or approval request, and the
existing lender decision + governance workflow is untouched.

## Cost to complete

Estimates are append-only whole-currency records. Per line the control record
preserves original budget, approved changes, revised budget, prior funded,
current requested, cumulative requested, remaining budget, verified completed
value, remaining committed cost, estimated cost to complete (recorded, or a
labeled `DERIVED_FROM_BUDGET` fallback), projected final cost, projected
variance, source, estimator, date, and confidence. Nothing here touches
budget rows, banking balances, or payments.

## Exceptions

Deterministic `dmv-*` rules extend the existing engine, guarded to projects
that actually use the DMV layer: unresolved basis, expired/revoked permit
with an authoritative basis, failed official inspection, correction/
reinspection pending, official record not found, missing permit mapping,
missing authoritative basis, contractor claim exceeding the inspector
finding, budget overrun, cost-to-complete shortfall, and
verification-needs-review. Each carries source, affected line/scope,
severity, blocking effect (HIGH/CRITICAL block eligibility), owner, due
date, status, resolution and audit history through the existing exception
lifecycle (idempotent creation, auto-resolve when the source condition
clears).

## Package output

- **Draw Verification Package** — a visible section titled **"Governing Code
  and Permit Basis"** (jurisdiction-labelled for non-DC DMV jurisdictions)
  renders the pinned bases, per-line eligibility, and the disclaimer; the ZIP
  gains structured registers: `permit-basis-register.csv`,
  `permit-basis-version-history.csv`, `transition-rules.csv`,
  `required-inspections.csv`, `official-inspection-status.csv`,
  `source-verifications.csv`, `cost-to-complete.csv`,
  `draw-permit-basis-pins.csv`, `draw-control-record.csv`,
  `eligibility-reasons.csv`, and `dmv-summary.json` (scope statement +
  manual-lookup honesty). Hashing, manifest inventory, and the manifest hash
  are unchanged and cover the new files.
- **Project Audit Package** — a `13_dmv_compliance/` section with the same
  registers (minus the per-draw control record, which stays a per-draw
  artifact). Projects without DMV records get no section.
- **As-of honesty** — registers include only records created at or before
  the package's as-of instant; basis rows are shown with their status *at*
  that instant; historical packages are stored artifacts and are never
  regenerated from newer settings (regression-tested byte-for-byte).

## Security model

- Tenant isolation via `canAccessProjectFinance` with same-404 semantics
  (an unrelated tenant cannot distinguish existing from nonexistent
  records), on every read and mutation, including UI pages.
- Role split mirrors the permit register: `FUNDER_REP` and
  `COMPLIANCE_REVIEWER` hold determination authority (finalize/correct a
  basis, determine transitions, record official statuses, record
  verifications); `PROJECT_MANAGER` may additionally record drafts,
  requirements, and estimates; `FIELD` holds nothing.
- All attribution (lookup performer, reviewer, estimator, correcting user)
  is the authenticated actor — never caller-supplied.
- Input validation throughout: strict ISO dates (explicit timezone or
  date-only), http(s)-only URLs, enum checks, length bounds, project-scoped
  reference checks for every linked record, whole-currency integers.
- Output encoding via the existing JSX renderer (all text escaped).
- Audit history through the existing configuration-audit trail for every
  lifecycle action.

## Pilot demonstration steps

1. `npm run build && npm run seed && npm start`, sign in as the funder or
   compliance reviewer.
2. Open **DEMO — 1427 Verity Place SE Fix-and-Flip (Washington, DC)**
   (`proj-dmv`) — a clearly fictional project: fictional borrower (Meridian
   Row Ventures LLC), contractor (Capitol Stone Builders LLC), address,
   parcel, and `DEMO-*` permit numbers.
3. Visit `/project/proj-dmv/compliance`: 4 permits (building/electrical/
   plumbing/mechanical), 5 basis versions including a corrected building
   basis (v1 → v2 with reason + attribution), a determined prior-code
   transition rule for the electrical permit, three required official
   inspections (one PASSED, one SCHEDULED, one CORRECTION_REQUIRED), manual
   source verifications (VERIFIED_MATCH, MANUAL_REVIEW_REQUIRED), and
   cost-to-complete estimates.
4. Visit `/draw/draw-dmv-1/control`: the Draw Control Record shows one line
   **Eligible for lender review — not automatically approved**, one line
   blocked (`EXCEPTION_OPEN` — failed plumbing inspection + claim mismatch),
   and one line `EVIDENCE_INCOMPLETE` (missing invoice, photo, waiver), each
   with explicit reason codes.
5. Generate the draw's Verification Package (Draw → Verification package) and
   download the ZIP to inspect the "Governing Code and Permit Basis" section
   and the DMV registers; generate a Project Audit Package to inspect
   `13_dmv_compliance/`.
6. Exceptions register shows one resolved and several open `dmv-*`
   exceptions.

## Known limitations

- Government-record verification is manual by design for the pilot; there is
  no live DOB/portal integration, and lookups are labeled accordingly.
- The demo models jurisdiction timezones as UTC (consistent with the permit
  register's documented expiry boundary).
- Requirement statuses are current-state records; packages disclose that the
  as-of filter applies to record creation, with basis status derived at the
  as-of instant.
- Basis pinning is draw-level per permit (not per line); lines surface the
  pinned versions relevant to their mapped permits.
- `budget_line_id` on draw lines remains a free-form reference (id or cost
  code), resolved defensively.

## Future official-data integration points

- `official_source_records.source_type = "API_LOOKUP"` and
  `BasisVerificationMethod = "API_LOOKUP"` are reserved for a future secure
  integration; a live source would slot in as a new verification method
  without schema changes.
- `source_verifications.next_review_date` supports scheduled re-checks that
  an integration could automate.
- `line_inspection_requirements.external_identifier` carries the
  jurisdiction's record key for future reconciliation.

## Permit amendments (built — jurisdiction-neutral)

The August 2026 pilot use case — physical work complete and verified, every
requested dollar supportable, the permit otherwise valid, yet the required
jurisdictional inspection cannot proceed while a permit **amendment** is
open — is now a first-class governed record: one `permit_amendments` table
under the existing permit register, exactly the smallest extension this
document previously reserved.

**What the record answers.** Which permit; the jurisdiction's own recorded
amendment lifecycle (`PENDING / APPROVED / REJECTED / WITHDRAWN / UNKNOWN`,
with submitted/resolved dates); and — SEPARATELY — whether the authority's
determination says required inspections cannot be scheduled while it stands
(`inspectionSchedulingEffect: BLOCKED / ALLOWED / UNKNOWN`, with a required
`effectBasis` and reviewer attribution). The two are never inferred from
each other: **OBV does not conclude law from the word "pending"** — a
lender-side reviewer records what the jurisdiction actually determined.

**Purpose and limitations.** The model exists to make one honest readiness
statement — "the recorded jurisdictional determination says the required
inspection cannot be scheduled while this amendment remains open" — and its
unknown-information counterpart. It is deliberately jurisdiction-neutral:
no authority-specific fields, no county branches, no effective-date rules
engine (Fairfax / Montgomery / Prince George's remain validation examples,
never code paths). It performs no lookups, contacts no portal, and never
touches inspection records: resolving an amendment clears only the
amendment reasons, and the required inspection remains its own governed
record with its own result lifecycle.

**Readiness semantics** (through the existing `completionGates` reason
model; no new engine):

- open amendment + gated REQUIRED inspection not yet passed + recorded
  effect `BLOCKED` → `PERMIT_AMENDMENT_BLOCKS_INSPECTION`, a KNOWN
  condition: **HOLD**, the deterministic primary blocker, next action
  "Resolve the permit amendment, then complete the required inspection";
- same shape with the effect **not determined** →
  `AMENDMENT_INSPECTION_EFFECT_UNKNOWN`, missing information:
  **INCOMPLETE**-side, never exception-eligible;
- effect `ALLOWED`, or amendment resolved, or inspection already PASSED →
  no amendment reason; the inspection gates carry the rest.

Historical truth is untouched: amendment changes rewrite no
`READINESS_TRANSITION`, no decision-time snapshot, and no audit row; each
mutation writes its own audit entry and appears on the governed timeline
as non-spatial events (`PERMIT_AMENDMENT_RECORDED`,
`AMENDMENT_EFFECT_DETERMINED`, `PERMIT_AMENDMENT_RESOLVED`).
