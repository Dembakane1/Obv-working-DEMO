# Dispute & Release Hold Management

## Legal boundary — read this first

OBV's dispute module is a **workflow, evidence and authorization record system**.
It is **not**:

- a licensed escrow service, and OBV is **never** the escrow agent;
- arbitration, mediation or any form of legal adjudication;
- banking custody, money transmission or payment processing;
- a replacement for a lender, bank, attorney or licensed escrow provider.

What OBV **does**: it records disputes, pauses *release eligibility* inside
OBV's own workflow, collects evidence, tracks cure requirements, requests
inspections, records advisory recommendations, records decisions made by
**authorized parties**, and maintains an immutable history of all of it.

Two sentences appear throughout the module and are enforced by tests:

> *Advisory recommendation only. OBV does not act as the escrow agent, make a
> binding legal determination, or move funds.*

> *This action records an authorized project decision. OBV does not hold funds
> or execute the payment or return. Actual financial activity must be
> performed and confirmed by the lender, bank, payment provider, or licensed
> escrow partner.*

The second sentence must be acknowledged, per decision, by the authorized
decision-maker before any resolution is recorded.

## Purpose

Construction draws fail in predictable ways: contested work quality, disputed
quantities, defective installations, documentation gaps. When that happens the
lender needs to (1) stop the affected money from becoming release-eligible,
(2) run a fair, recorded process to resolve the disagreement, and (3) prove
afterwards exactly what happened and who decided what. This module provides
that loop on top of OBV's existing verification, governance and banking-layer
controls — without weakening or bypassing any of them.

## Architecture

```
src/shared/types.ts                 dispute types + DISPUTE_CAPABILITIES
src/server/db/index.ts              dispute_* tables (9)
src/server/db/disputeRepo.ts        persistence; guarded single-statement transitions
src/server/services/disputes.ts     domain: state machine, authorization, hold read-model
src/server/services/disputeRegisters.ts  package registers (draw + audit packages)
src/server/http/disputeRoutes.ts    JSON + form API
src/server/view/disputePages.tsx    /project/:id/disputes register, /dispute/:id workspace
scripts/dispute-test.js             185-checkpoint suite
```

Layering follows the repo's doctrine: routes parse and content-negotiate only;
the service owns authorization and invariants; the repository owns SQL with
guarded `UPDATE … WHERE status IN (…)` transitions inside
`BEGIN IMMEDIATE` transactions (exactly-once, no lost updates); views render
read models. Nothing in the module writes any banking table, and no banking
module gained a call path into `VirtualAccountService`.

## Data model

| Table | Purpose |
|---|---|
| `disputes` | the dispute record: subject, attachment points, amounts, status, legal hold, resolution |
| `dispute_events` | append-only timeline (no UPDATE/DELETE path exists in the repository) |
| `dispute_responses` | immutable written submissions; corrections are new versions referencing the original |
| `dispute_evidence_records` | evidence register with integrity hashes; additive versioning; review states |
| `dispute_cure_items` | cure requirements with due dates and review lifecycle |
| `dispute_cure_extensions` | append-only deadline-extension history (prior + new + reason + actor) |
| `dispute_inspection_requests` | dispute-scoped inspection lifecycle |
| `dispute_recommendations` | advisory recommendations; AI flag; human approval gate |
| `dispute_escalations` | recorded external escalations and their responses |

A dispute attaches to an authoritative OBV object (`PROJECT`, `DRAW_REQUEST`,
`DRAW_LINE_ITEM`, `MILESTONE`, `PAYMENT_INSTRUCTION`, `CHANGE_ORDER`,
`INVOICE_DOCUMENT`, `RETAINAGE_RELEASE`, `INSPECTION_RESULT`,
`EVIDENCE_ITEM`). The subject must exist **in the same project/tenant** —
attachment points (`drawRequestId`, `milestoneId`, `paymentInstructionId`)
are derived from the subject and drive the release-hold read model.

Disputed and undisputed amounts are **whole-currency integers** and are
recorded assertions only: no authoritative balance, draw amount, budget line
or ledger entry is ever modified by any dispute action (regression-asserted
byte-for-byte across 17 protected tables).

## State machine

```
OPEN → UNDER_REVIEW → { WAITING_FOR_CONTRACTOR | WAITING_FOR_LENDER |
                        WAITING_FOR_OWNER | WAITING_FOR_INSPECTION |
                        WAITING_FOR_DOCUMENTS | CURE_IN_PROGRESS |
                        READY_FOR_DECISION | ESCALATED }
READY_FOR_DECISION / ESCALATED → (authorized resolution only) →
   RESOLVED_RELEASE | RESOLVED_PARTIAL_RELEASE |
   RESOLVED_CONTINUE_HOLD | RESOLVED_RETURN_RECOMMENDATION
RESOLVED_* → UNDER_REVIEW (formal reopen, recorded as REOPENED)
RESOLVED_* → CLOSED (authorized close only) ; CLOSED is terminal
```

Rules, all test-enforced:

- every transition must appear in the explicit allow-map — there are **no
  silent fallbacks** and no direct status editing;
- `RESOLVED_*` states are reachable **only** through the authorized
  resolution action; `CLOSED` only through the authorized close action;
- state-dependent checks run against a **fresh read inside the write
  lock**, then execute as one guarded UPDATE (concurrent duplicates and
  race-window legal-hold activations get a clean 409), and write an
  attributable immutable event;
- a formal **reopen clears the current-decision columns** (resolution
  type, amount, conditions, references, decider) so a later decision can
  never inherit values from an earlier one — the earlier decision remains
  verbatim in the append-only timeline, and the REOPENED event names it;
- a reopen is refused while a legal hold stands;
- a **CLOSED dispute is frozen**: no response, evidence, evidence review,
  cure action, inspection update, recommendation, approval or escalation
  update can be recorded on it (legal hold remains the one exception —
  record preservation stays possible on a closed record);
- unknown states are 400, disallowed edges are 409, cross-tenant access is
  the same 404 as nonexistence.

## Roles & authorization

Capabilities ride the existing project-membership capability machinery
(`lenderAccess`), assignable per membership: `OPEN_DISPUTE`,
`RESPOND_TO_DISPUTE`, `MANAGE_DISPUTE`, `DECIDE_DISPUTE`,
`MANAGE_LEGAL_HOLD`. Conservative legacy-role fallbacks: FUNDER_REP holds all
five; COMPLIANCE_REVIEWER holds open/manage/decide/legal-hold;
PROJECT_MANAGER holds open/respond; everyone else has none until explicitly
granted. Reading a dispute requires only project access; every mutation
requires its capability.

Separation of duties: **the dispute opener can never record its own
resolution.** Legal-hold **removal** is elevated: compliance reviewer or an
explicit `MANAGE_LEGAL_HOLD` membership grant.

Users *named on* dispute records (responsible reviewer, cure responsible
party, assigned inspector) must themselves have access to the project.
Naming a foreign-tenant user and naming a nonexistent user return the
identical 422 — record assignment can never be used as a cross-tenant
user-directory probe.

## Release hold

`drawDisputeHold(drawRequestId)` is a **pure read model** consumed by the
existing enforcement boundaries:

- `paymentEligibility` (the banking layer's single gate) lists the dispute
  hold as a blocker, so instruction creation on an affected draw is refused
  and nothing is written;
- `lenderDecisions.scheduleFunding` / `transitionFunding(DISBURSED)` refuse
  while a hold is active;
- after `RESOLVED_PARTIAL_RELEASE`, the disputed amount keeps reducing the
  remaining instructable cap while the undisputed remainder becomes eligible.

The hold ends only at `RESOLVED_RELEASE` or `CLOSED`. A hold never moves
funds, changes a balance, creates a settlement, emits a provider event, or
rewrites payment history — the banking non-mutation regression asserts all
protected tables are unchanged across the entire lifecycle.

Partial release of the undisputed amount is **manual and authorized only**
(never automatic), is capped at the recorded undisputed amount, and passes
the same full revalidation as any other resolution.

## Responses, evidence, cures, inspections

- **Responses** are immutable after submission; a correction is a new
  version referencing the superseded original — nothing is overwritten.
- **Evidence** reuses OBV's governed evidence architecture: linking a
  governed object carries that object's own integrity hash; standalone
  submissions get a SHA-256 over their canonical descriptor. Reviews are
  guarded (exactly-once) and corrections are additive versions.
- **Cures** run OPEN → SUBMITTED → ACCEPTED/REJECTED, with explicit WAIVED
  and CANCELLED. Overdue is **display-only**: a passed deadline never
  auto-resolves, auto-waives or auto-releases anything. Deadline extensions
  require a recorded reason and append to an extension history.
- **Inspections** run REQUESTED → SCHEDULED → COMPLETED/ACCESS_FAILED/
  CANCELLED. The assigned inspector may record the result without
  MANAGE_DISPUTE. Results are **evidence** — a PASSED result never
  auto-resolves the dispute and never authorizes payment.

## Advisory recommendations

Recommendations are advisory only and always carry the disclaimer.
AI-generated content is flagged, is **not official** until a human reviewer
approves it, and the approval is recorded. Recording a recommendation never
changes the dispute status.

## Legal hold

Activating a legal hold records who and why, displays **“Legal Hold
Active”**, blocks resolution and closure, and blocks release eligibility for
the affected draw regardless of dispute status. Removal requires elevated
authorization and a recorded reason. A legal-hold flag is a
record-preservation and workflow control — not legal advice or a court order.

## Escalation & decisions

External escalations (attorney, insurer, surety, inspector, escrow partner,
bank representative, …) are recorded with recipient, reason and transmitted
materials; responses and closure are recorded too. A decision may be recorded
from `ESCALATED` exactly as from `READY_FOR_DECISION`.

The authorized resolution revalidates **everything inside the write lock**:
state, legal hold, unreviewed evidence, non-terminal cures (for release
types), in-flight inspections, amount caps, and — for release-type decisions
on draw-attached disputes — the **existing** release-eligibility gates
(ignoring only the dispute's own hold). A release decision the existing
controls would refuse is itself refused. On a project with no banking layer,
a missing virtual account alone does not make an authorized decision
unrecordable — the draw's formal governance approval remains the
authoritative gate and must have passed. Resolution records the decision
type, amount, reasoning, evidence relied upon, external reference, and who
decided in which role — after the mandatory acknowledgement.

## Reporting & packages

Both the Draw Verification Package and the Project Audit Package
(`12_disputes/`) carry as-of-filtered dispute registers: dispute register,
timeline, responses, evidence, cures + extensions, inspections,
recommendations (each row carries the advisory disclaimer), escalations, and
resolutions (with the acknowledgement text). Manifest hashing is unchanged —
every register file is hashed into the package manifest and recomputes.
Scopes with no disputes state `NOT_RECORDED` honestly.

## Security & audit

- Tenant isolation: unrelated organizations receive the same 404 as
  nonexistence for disputes, sub-records, pages and registers.
- Object-ID guessing on cures/evidence/inspections/escalations returns 404.
- Every event is attributed and timestamped; the timeline is append-only at
  the repository layer (no UPDATE/DELETE path exists).
- No dispute module makes network calls or contains credential material
  (statically asserted by the test suite).

## Banking safety

Banking stays in the safe simulated configuration
(`OBV_BANKING_PROVIDER=mock`, `OBV_BANKING_MODE=demo`). The dispute module
adds no provider, SDK, credential, network call, account, custody or money
movement, and introduces no call path from any banking module into
`VirtualAccountService`. The test suite ends with a byte-for-byte snapshot
comparison of 17 protected banking/financial tables across the entire
dispute lifecycle.

## Testing

`node scripts/dispute-test.js` — 185 checkpoints: static source boundaries,
seeded lifecycle, open validation, tenancy/ID-guessing, release-hold
enforcement, the complete transition graph (every allowed edge executed,
disallowed edges refused, concurrent duplicates exactly-once), response
versioning, evidence integrity, the full cure/inspection lifecycles,
AI-recommendation approval, legal hold, escalation, all seven resolution
types with full revalidation, timeline completeness (all 22 event kinds),
package output with manifest re-hashing, as-of honesty, and the banking
non-mutation regression.

## Future integration points (explicitly out of scope today)

- A licensed escrow partner could consume the resolution record as its
  instruction source; OBV would remain the system of record, not the agent.
- Payment-provider webhooks could annotate dispute records with
  provider-confirmed outcomes (still never OBV-initiated).
- Structured export of the dispute package for counsel/arbitration.

## Known limitations

- Recommendations are recorded by humans (optionally flagged AI-generated);
  no model integration generates them in-app.
- Escalation is a recorded manual process; no external notifications are
  sent.
- Cure "overdue" is computed at read time against the server clock; there is
  no scheduler and no automatic consequence (by design).
- The undisputed-amount cap is validated against the recorded assertion, not
  re-derived from line items; reviewers are expected to verify the split
  before deciding.
