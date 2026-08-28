# Portfolio Intelligence Platform

OBV's portfolio layer turns every verified project into continuous
executive intelligence: portfolio aggregation, an eight-dimension risk
engine, contractor/inspector/vendor scorecards, deterministic
forecasting, advisory fraud signals, template-composed executive
summaries, and an exportable executive report — all derived, on demand,
from the same verified records the lender workflow already produces.

**The lender workflow remains the primary workflow.** The intelligence
layer sits strictly on top of it.

## Control principles

1. **Derived-only.** Every figure is computed on read from verified
   primary records. Historical project records are never altered,
   evidence is never modified, and existing packages are never
   rewritten. The only portfolio-layer write surface is the append-only
   `portfolio_snapshots` table (dated portfolio observations for the
   historical series), statically asserted by the test suite.
2. **Tenant-scoped by construction.** Every analytics context is built
   from `authz.accessibleProjects(viewer)` — the same predicate that
   guards every other surface. Cross-tenant aggregates are impossible,
   and project/entity detail endpoints follow the same-404 doctrine: an
   out-of-tenant contractor, vendor, or project is indistinguishable
   from one that does not exist.
3. **Advisory-only.** Risk scores, forecasts, fraud flags, and
   summaries never approve draws, never issue lender decisions, never
   create payment instructions, and never touch banking state. The test
   suite proves every primary table byte-identical across the full
   analytics surface.
4. **Explainable.** Risk dimensions carry reason codes and point
   contributions; forecasts disclose their basis; the scoring weights
   and band thresholds ship with every risk payload.

## Architecture

| Piece | Location |
| --- | --- |
| Read-only SQL layer | `src/server/db/portfolioRepo.ts` |
| Viewer-scoped context + facets | `src/server/services/portfolio/context.ts` |
| Aggregation / distributions / trends | `src/server/services/portfolio/aggregate.ts` |
| Risk engine (8 dimensions) | `src/server/services/portfolio/riskEngine.ts` |
| Contractor / inspector / vendor intel | `src/server/services/portfolio/entities.ts` |
| Forecasting | `src/server/services/portfolio/forecast.ts` |
| Fraud signals | `src/server/services/portfolio/fraud.ts` |
| Executive summaries | `src/server/services/portfolio/summary.ts` |
| Government foundation (disabled) | `src/server/services/portfolio/government.ts` |
| Snapshots (append-only) | `src/server/services/portfolio/snapshots.ts` |
| Facade (authorization boundary) | `src/server/services/portfolio/index.ts` |
| API routes | `src/server/http/portfolioRoutes.ts` (`/api/portfolio/*`) |
| Executive pages | `src/server/view/portfolioPages.tsx` (`/executive*`) |
| Executive report (print/PDF) | `src/server/view/executiveReport.tsx` |
| Tests (142 checkpoints) | `scripts/portfolio-test.js` (wired into `scripts/run-all-tests.js`) |

### Entity identity resolution

There are no new entity tables. Identities are resolved from existing
verified records:

- **Contractors** — organizations referenced by `loan_assets.primary_contractor_organization_id`,
  active `project_party_assignments` of type `CONTRACTOR`, or pilot
  configuration (`projects.contractor_org_id`).
- **Inspectors** — three sources, never merged: independent draw
  inspectors (`draw_inspections`), government inspection records
  (`jurisdictional_inspections.government_inspector_name`, free text —
  a record *about* a government inspection, never an OBV identity), and
  dispute re-inspections.
- **Vendors** — normalized `draw_documents.vendor` invoice metadata;
  lien-waiver posture matched best-effort by signing party / supplier
  organization name.

### Risk model

Each project scores 0–100 risk points per dimension — financial,
compliance, schedule, documentation, inspection, contractor, fraud,
operational — from documented, deterministic rules with reason codes.
Overall risk is a weighted blend (weights ship in the payload);
**Project Health = 100 − overall risk**. Bands: STABLE <25, WATCH
25–49, ELEVATED 50–74, CRITICAL ≥75. Projects at ELEVATED or worse
appear automatically in the executive attention queue. Portfolio health
aggregates as both a plain and budget-weighted average.

### Forecasting

Final cost (revised budget + open change-order exposure + any
cost-to-complete shortfall), projected completion (observed
release-pace extrapolation over the planned span), remaining
budget/funding, schedule and budget confidence bands, inspection and
permit completion estimates, and a six-month cash-flow spread of
unreleased tranches. Forecasts are labeled, disclose their basis, are
stored nowhere, and never modify actual values.

### Fraud intelligence

Deterministic anomaly detectors: duplicate invoice numbers (same-vendor
and cross-vendor), duplicate evidence content hashes (including
cross-milestone), rapid budget changes, outsized change-order growth,
repeated contractor issues across projects, suspicious inspection
patterns, releases without evidence, budget lines paid beyond revised
value, round-number invoice concentration, evidence-rejection clusters,
and multi-dimension risk clustering. **Advisory flags only** — never
findings, never accusations, never automated action.

### AI executive intelligence

Weekly, monthly, and lender-briefing narratives composed
deterministically from the computed analytics (headline, highest risks,
best/worst performers, budget and compliance concerns, funding
bottlenecks, emerging trends, upcoming deadlines, fraud indicators).
Every summary carries the advisory statement: OBV does not approve
draws, authorize payments, or replace human review.

### Multi-lender behavior

Each lender's executives see exactly their accessible portfolio —
aggregates, entities, fraud signals, summaries, and snapshots are all
scoped before computation. Snapshot series are keyed to the recording
viewer (organization + recorder): a snapshot aggregates the recorder's
accessible portfolio, and access sets are per-user, so listings never
cross a recorder boundary. The suite proves a second seeded lender cannot
observe the first's projects, contractors, or snapshots, and that
cross-tenant detail requests 404 identically to nonexistent ones.

### Government foundation (disabled)

`gov_portfolios`, `gov_programs`, and `gov_program_links` exist with a
database-level `status IN ('INACTIVE')` constraint so future
government, infrastructure-program, donor-funded, and grant portfolios
have a stable shape to land on. **There is no write path anywhere in
the application** (statically asserted), activation-shaped requests
404, and `/api/portfolio/government` reports
`ARCHITECTURE_ONLY`/disabled. No government workflow is active.

## Executive Command Center — governed presentation model

`/executive` has two halves, and the split is the whole point: a
**governed capital-control** half derived from the Draw Readiness Engine,
and an **advisory** half carrying the analytics described everywhere else
in this document. The advisory band is wrapped in `.ec-advisory`, dimmed,
dashed, and every panel heading carries the word ADVISORY. Nothing in it
is a control.

The governed half is `services/portfolio/control.ts` — a read model that
**aggregates and never reinterprets**. Every readiness figure comes from
`drawReadiness()`, every domain from `controlDomains()`, every
cross-cutting rollup from `crossCuttingControls()`, every coverage label
from `formatSupportCoverage()`, and every next action from
`lenderPilot.drawNextAction()`. There is no second engine.

**Capital inclusion rule.** All capital figures, the readiness
distribution, domain pressure and the attention queue run over ONE set:
open draws, defined exactly as `lenderPilot.OPEN_STATUSES` —
`SUBMITTED · UNDER_REVIEW · CLARIFICATION_REQUIRED ·
READY_FOR_GOVERNANCE · RETURNED`. Reused rather than redefined so the two
lender surfaces can never disagree. DRAFT is excluded (not yet a request
against the lender); APPROVED / PARTIALLY_APPROVED / RELEASED / CANCELLED
are excluded (the lender has recorded a disposition, so the capital has
left review). Note that `server.ts`'s older `OPEN_DRAWS` constant also
counts PARTIALLY_APPROVED; the console deliberately follows the lender
pilot's narrower set, and the rule is stated on the page itself.

- `requested` — the sum of `requestedAmount` over that set.
- `supportable` — the sum of the engine's own `supportableAmount` over
  the SAME set. Supported **dollars**. Never approved, authorized,
  payable, funded or settled, and never a measure of readiness.
- `unsupported` — the sum of the engine's own **per-draw** shortfalls,
  deliberately NOT `requested − supportable`. If one draw's lines record
  more support than that draw requested (an inconsistency the engine flags
  with `RECONCILIATION_FAILED`), a netted difference would let that overage
  cancel a different draw's genuine gap and the portfolio would report full
  coverage over a real shortfall.
- `overSupported` — `Σ max(0, supportable − requested)`. Non-zero means at
  least one draw records more support than it requested; it is shown on its
  own line with a plain-language warning, never netted away.
- `covered` — `requested − unsupported`, i.e. `Σ min(requested,
  supportable)`.
- `coverage` — `covered / requested`, so it reaches 1 only when **every**
  included draw is fully supported. The displayed label goes through the
  shared non-overstating formatter, so 100% means exact full support.

`aggregateCapital(results)` is exported pure precisely so this rule can be
tested against the over-supported case the seeded portfolio cannot produce.

**Readiness aggregation.** Each open draw is evaluated once and lands in
exactly one of READY / HOLD / EXCEPTION_REVIEW / INCOMPLETE. The four
buckets partition the set (asserted), each carrying its own draw count
and dollars. The only percentage shown is a bucket's share **of open
draws by count**, always rendered with that denominator named. There is
no portfolio readiness score and no composite grade — a single severe
UNKNOWN cannot be averaged away by twenty healthy records. A draw whose
readiness cannot be evaluated is surfaced in `unevaluated`, never
silently dropped from the totals.

**Domain-pressure semantics.** For each of PHYSICAL / FINANCIAL /
COMPLIANCE / DOCUMENTS the console reports how many open draws sit at
HOLD / UNKNOWN / WARNING / PASS in that domain, plus blocker instances.
A draw blocked in two domains is counted in **both** — that is the
question the module answers — so **domain counts never sum to a unique
blocked-draw count**. Unique blocked draws come only from the readiness
distribution. The page states this explicitly.

**Cross-cutting treatment.** EXCEPTION, PROJECT_CONTROL and INTEGRITY
belong to no domain, exactly as in the Draw Control Scorecard. They are
rolled up separately and rendered as a distinct line that says it sits
outside the four domains, because **all four domains can read clear
while a draw is still blocked** — a formal exception, a dispute/legal
hold or an integrity finding is not a physical, financial, compliance or
document control. There is no fifth domain.

**Attention queue.** Deterministic order, never a score: missing
governed information first (INCOMPLETE, then unknown information carried
by an otherwise-blocked draw), then governed blockers, high/critical
exceptions, inspection controls, document gaps, disputes/legal holds,
aging draws, and finally READY draws awaiting a lender decision. Each
group states the unit it counts, because the units genuinely differ —
`GOVERNED_BLOCKERS` counts blocker instances while its items are draws.
Two groups are sourced from registers rather than readiness categories:
high/critical exceptions from the exceptions register, and disputes and
legal holds from the disputes register — PROJECT_CONTROL is cross-cutting
and also carries ordinary reviewer progress such as
`LINE_REVIEW_INCOMPLETE`, which must never be reported as a legal event.
The inspection group is called "inspection controls outstanding" rather
than "required inspections outstanding" because one of its blockers means
the inspection *surface itself* is unknown, which is not the same claim.

**History.** RECENT CONTROL CHANGES reads recorded history only. A
readiness transition is a `draw_events` row of type
`READINESS_TRANSITION` whose detail carries the status it moved FROM and
TO at the time it was written; today's live blockers are never consulted
to describe a past change. That record carries **no reason text**, so
none is invented. PROCEEDED BY EXCEPTION is bound to the immutable
decision-time `READINESS_SNAPSHOT` for the standing decision, so
resolving a requirement later never rewrites what the lender overrode.

**Source freshness.** Timestamps come from `source_verifications` rows
(`lookup_at`, `result_status`). OBV defines **no staleness threshold of
its own**: "review due" appears only where the record itself carries a
`next_review_date` that has passed. A project with no recorded lookup
reads "not recorded" — never "current". Freshness is advisory and can
never change readiness.

**Turnaround.** True median of submitted → decision over draws that
actually reached a decision, with the sample size shown. (`lenderPilot`
previously took the *lower* median, which always biased the reported
turnaround toward the faster half — on the seeded demo it reported 1.1 d
for a 4.1 d median. Both surfaces now share one `median()` helper.) When no
draw has completed the journey it reads "Insufficient recorded decisions" —
never an estimate. The aging threshold is
`lenderPilot.AGING_THRESHOLD_DAYS`, and the open-draw set is
`lenderPilot.OPEN_STATUSES`, both imported rather than restated.

## Surfaces

- `/executive` — command center. Governed half: capital KPI rail,
  readiness distribution, control-domain pressure, governed attention
  queue, draw pipeline, portfolio capital position, recent control
  changes, project attention register, proceeded-by-exception, official
  source freshness, draw turnaround. Advisory half: distributions
  (state, jurisdiction, lender, contractor, inspector, stage, risk,
  status), trends (exceptions, disputes, draws, permits, compliance,
  portfolio growth), full risk register, fraud panel, snapshot history,
  interactive GET filtering.
- `/executive/entities`, `/executive/forecast`, `/executive/summary`.
- `/api/portfolio/*` — JSON per section (lazy, per-request, read-only).
- Executive PDF — `POST /api/reports/executive` streams a portfolio
  report through the existing Chromium pipeline (printable HTML at
  `/executive/report/preview` is the graceful degradation and the
  durable surface); it writes no rows into the project-scoped reports
  register.

## Performance posture

Aggregation is single-pass over per-request Maps grouped once per table
(the established `computeIntelligence` idiom), with lazy per-table
loading so each endpoint touches only what it needs. SQLite easily
sustains thousands of projects at this shape; the append-only snapshot
series keeps the historical trend line O(snapshots) instead of
recomputing history. Existing request paths are untouched — no existing
workflow gained a query.

The decision-time snapshot behind PROCEEDED BY EXCEPTION is read from the
context's already-loaded draw events rather than through
`decisionReadinessSnapshot`, which would issue one query per decided draw.

`executiveConsole(user, filters)` builds **one** context for the whole
page. Previously each panel called its own `overview(user)` /
`risk(user)` / `fraud(user)` entry point and each rebuilt the scope
resolution and its lazy maps. Measured against the seeded demo portfolio
(3 projects, 7 open draws), all five engines over one shared context cost
**23.5 ms** — less than the governed control model alone on a cold
context (34.4 ms), because the shared maps are already warm.

The governed control model's cost is dominated by readiness evaluation,
which is **per draw by design**: the portfolio total must be the sum of
the authoritative per-draw figures, so it calls `drawReadiness()` once
for each open draw. That is ~3–5 ms per draw here (each evaluation issues
80–113 SQL statements, and `draws.computeRecommendation` inside it still
performs one unscoped `field_issues` scan). `/executive` measures 15 ms →
50 ms median for this portfolio. Everything that CAN be batched is: draw
events are loaded once through `portfolioRepo.drawEventRows()` and
grouped in the context rather than per draw, and `drawHeaderSummary` is
computed once per draw and handed to `drawNextAction` instead of letting
it recompute. **The honest limit**: at portfolio scales in the hundreds
of open draws this becomes the page's dominant cost, and the fix is a
batch entry point in the readiness engine (one pass assembling many
draws' inputs), not a cache — a cache here would risk serving stale or
cross-tenant readiness, which is precisely what this layer must never do.

## What this layer never does

Approve draws · issue or alter lender decisions · create payment
instructions or banking state · open exceptions · alter historical
records, evidence, or packages · activate any government workflow ·
replace human decisions.

## Portfolio metrics — data-readiness map (August 2026 pilot brief)

Classification of the metrics the pilot brief raised, against the governed
records that exist. The **CURRENTLY DERIVABLE** set is now BUILT on
`/executive`; the other two remain deliberately unbuilt.

**CURRENTLY DERIVABLE** (governed records already carry the inputs) —
**built in the Executive Command Center refresh**:

- Supportable vs requested dollars, per draw and aggregated — reviewer
  line decisions via `draws.lineSupported` / readiness results. *Built:
  the capital rail and portfolio capital position.*
- Outstanding construction reserve — virtual-account HELD/RELEASED ledger.
  *Retained on the advisory overview totals (`heldAmount`,
  `releasedAmount`, `paidToDate`).*
- Unresolved exceptions by severity/age — exceptions register. *Built:
  the high/critical exception group in the governed attention queue.*
- Permit / government-inspection / compliance blockers — readiness
  blocking reasons by category, plus the gates' own records. *Built:
  COMPLIANCE domain pressure and the inspection-controls group.*
- Lender overrides (proceed-by-exception) — immutable readiness snapshots
  with overridden blocker codes, actor, justification, policy version.
  *Built: the PROCEEDED BY EXCEPTION module, snapshot-bound.*
- Draw turnaround time — draw_events timestamps (submitted → decision).
  *Built: median with sample size, or an explicit insufficient-data
  statement.*
- Inspection failures — jurisdictional inspection result lifecycle.
  *Surfaced through the inspection-controls attention group; a dedicated
  failure-rate trend remains advisory analytics.*

**REQUIRES ADDITIONAL DATA** (partial today; honest gaps):

- Draw pace vs physical completion — per-line, the reviewer's
  verified-physical % already powers the existing advisory
  ("financial progress ahead of verified physical", exception-candidate
  flag). A PORTFOLIO pace metric needs consistent verified-% coverage
  across lines and draws, which reviewer practice does not yet guarantee.
- Cost-to-complete deterioration — `project_cost_to_complete` records
  exist on DMV projects only, and depend on operator entry cadence.

**FUTURE PORTFOLIO METRIC** (needs new inputs or history not yet kept):

- Disbursed vs supportable across lenders (real disbursement happens
  outside OBV; would need recorded settlement confirmations).
- Benchmarked draw-cycle percentiles across tenants (needs a privacy
  model before any cross-tenant aggregation).
