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

## Surfaces

- `/executive` — command center: KPI strip, attention queue,
  distributions (state, jurisdiction, lender, contractor, inspector,
  stage, risk, status), trends (exceptions, disputes, draws, permits,
  compliance, portfolio growth), full risk register, fraud panel,
  snapshot history, interactive GET filtering.
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

## What this layer never does

Approve draws · issue or alter lender decisions · create payment
instructions or banking state · open exceptions · alter historical
records, evidence, or packages · activate any government workflow ·
replace human decisions.

## Future portfolio metrics — data-readiness map (August 2026 pilot brief)

Prepared for a later Executive Command Center refresh — **none of this is
built yet**, and nothing here changes what the platform computes today.
Classification of the metrics the pilot brief raised, against the governed
records that exist on this SHA:

**CURRENTLY DERIVABLE** (governed records already carry the inputs):

- Supportable vs requested dollars, per draw and aggregated — reviewer
  line decisions via `draws.lineSupported` / readiness results.
- Outstanding construction reserve — virtual-account HELD/RELEASED ledger.
- Unresolved exceptions by severity/age — exceptions register.
- Permit / government-inspection / compliance blockers — readiness
  blocking reasons by category, plus the gates' own records.
- Lender overrides (proceed-by-exception) — immutable readiness snapshots
  with overridden blocker codes, actor, justification, policy version.
- Draw turnaround time — draw_events timestamps (submitted → decision).
- Inspection failures — jurisdictional inspection result lifecycle.

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
