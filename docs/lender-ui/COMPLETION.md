# Lender Review UI + Production Alignment — Completion Report

Scope: add a lender decision workspace as a new draw-detail tab, backed entirely
by authoritative stored records and existing service authorization, and align
the production Render service with `main`. Baseline: merge commit `2b6b0d4`
(lender-pilot domain integrated into main).

## Commits

| # | Commit | Subject |
|---|--------|---------|
| 1 | `007db68` | Deploy production from main; assert it in deploy-check |
| 2 | `2f6041a` | Lender Review tab: server-side data assembly and view types |
| 3 | `48bb9ad` | Lender Review tab: read-only decision workspace |
| 4 | `6beab46` | Lender Review tab: governed action forms with redirect-back |
| 5 | `6489bab` | Lender Review tab: mobile form ergonomics |
| 5a | `3a9489f` | Lender Review tab: next-action banner reflects the stored current decision |
| 6 | (this commit) | Lender Review tab: dedicated UI test suite and completion report |

The 5a fix came out of an adversarial review of the cumulative diff: a
released/approved draw derives stage `APPROVED` even when the current lender
decision was later withdrawn or restarted as pending, and the banner's
APPROVED branch unconditionally claimed "the decision is fundable." The
banner now checks the stored decision and falls back to "Record lender
decision" with the actual stored decision status. No service or control
behavior changed — the funding service already rejected non-fundable
decisions; only the banner copy was wrong.

## Files changed

- `render.yaml` — production service `obv-demo` now deploys from `branch: main`
  (previously `claude/obv-demo-repo-structure-t0hjsc`). The separate
  `obv-frontend-preview` service and its branch are unchanged.
- `scripts/deploy-check.js` — new pre-network assertion: the run fails if the
  `obv-demo` service block in `render.yaml` stops tracking `main`.
- `src/server/http/server.ts` — `assembleLenderTab(...)` (authoritative data
  assembly), `lenderNextAction(...)` (presentation mapping of the derived
  stage), `finishLenderPost(...)` (form/JSON content negotiation for existing
  lender POST routes), `?ok=`/`?err=` notice parsing on the draw page, and a
  lender-tab bounce in the global error handler for known domain errors on
  form posts.
- `src/server/view/drawPages.tsx` — `lender` added to the `DrawTab` union and
  `TABS`; `LenderTabData` type; `renderLenderTab` with sections A–H
  (metric strip, next-action banner, loan/project context, independent
  inspections, decision + conditions, lien waivers, external funding,
  packages) plus capability-gated action forms.
- `public/styles.css` — lender workspace styles (tables, record cards, forms,
  trust note, stage log) using the existing token system only.
- `scripts/lender-ui-test.js` — new dedicated suite (26 checkpoints).
- `docs/lender-ui/COMPLETION.md` — this report.

## Routes and components added

- **Route surface:** no new HTTP routes. The tab is served by the existing
  `GET /draw/:drawId` handler via `?tab=lender`. All actions POST to the
  pre-existing lender API routes (`/api/draws/:id/(inspections|lender-decision|
  lien-waivers|funding)`, `/api/draw-inspections/:id/*`,
  `/api/inspection-reports/:id[/finalize]`, `/api/decision-conditions/:id`,
  `/api/lien-waivers/:id`, `/api/funding/:id`). Those routes now content-
  negotiate: browser form posts get a `303` back to `?tab=lender` with an
  `ok`/`err` result; JSON clients get the identical JSON responses as before.
- **View components:** `renderLenderTab` and its section helpers
  (`lenderMetricStrip`, `lenderContext`, `lenderInspections`,
  `lenderDecisionSection`, `lenderWaivers`, `lenderFunding`,
  `lenderPackages`, `inspectionForms`) in `drawPages.tsx`, all built from the
  shared component library (`MetricStrip`, `AttentionBanner`, `SectionHead`,
  `EmptyState`, chips, panels, record cards).

## Authoritative data sources

Every displayed value comes from one of these; nothing is synthesized:

- `drawWorkflow.deriveDrawStage(...)` and draw stage event history
- `lenderRepo`: loan asset, ownership events, servicing events, party
  assignments, jurisdiction profile, draw inspections + lines + report
  versions + events, lender decisions + conditions, lien waivers, external
  funding records
- `loanProfile.appliedPolicyForDraw(...)` — the frozen policy application
- `lenderDecisions.currentDecision(...)` / `derivedPaymentStatus(...)`
- `lenderAccess.capabilitiesFor(...)` — server-computed capability flags
- Existing report records for verification-package downloads

Legacy draws with no lender-domain rows render **Not recorded** for each
absent fact (verified: 12 distinct "Not recorded" values on the seeded legacy
draw with zero rows in every lender table). The next-action banner is a
presentation mapping over the derived stage and existing service outputs — the
UI computes no second workflow.

## Capability / action matrix

| Control on the lender tab | Server-enforced requirement |
|---|---|
| Order / schedule / cancel independent inspection, record access failure, complete site visit | `SCHEDULE_DRAW_INSPECTION` |
| Record line findings, draft report version | `RECORD_INSPECTION_FINDINGS` or assigned inspector |
| Finalize report version | `FINALIZE_INSPECTION_REPORT` or assigned inspector |
| Record OBV review | `REVIEW_DRAW` (OBV reviewer surface) |
| Lender acceptance / decline / reinspection request | `SCHEDULE_DRAW_INSPECTION` |
| Record lender decision, update decision conditions | `RECORD_LENDER_DECISION` **and not the draw submitter** (separation of duties) |
| Create / transition lien waivers | `RECORD_LENDER_DECISION` |
| Schedule / transition external funding records | `RECORD_EXTERNAL_FUNDING` |
| Verification-package preview / download | existing draw access rules |

Rendering a control requires the capability, but the browser is convenience
only: every POST re-runs the same service authorization, so a manually crafted
request from an unauthorized user is rejected (403 for JSON; `303` back to the
tab with the error message for form posts). In membership mode capabilities
are authoritative; in legacy mode (projects with no memberships) the role
fallback applies (`FUNDER_REP` → lender reviewer, `COMPLIANCE_REVIEWER` → OBV
reviewer).

## Legacy behavior

- Draws created before the lender domain render the full workspace with
  **Not recorded** placeholders — no fabricated loan, inspection, decision,
  waiver, or funding values.
- Tenant behavior is unchanged: an unrelated organization receives the same
  404 for `?tab=lender` as for a nonexistent draw (existence not disclosed).
- All previous draw tabs and their behavior are untouched.

## Responsive results

Playwright (bundled Chromium) measured `document.documentElement.scrollWidth
=== window.innerWidth` (0px overflow) at **375, 390, 393, 430, 768, 1024,
1280 and 1440** on a fully populated lender tab. Wide registers (inspection
lines, conditions, waivers, funding) collapse to record cards below 820px;
forms stack full-width with 16px inputs and ≥44px touch targets on mobile;
one H1 per page; sentence-case labels; existing tokens only (canvas
`#F7F8FA`, white cards, no warm tan, no uppercase micro-labels).

## Test results (2026-07-21, all green)

New suite — `scripts/lender-ui-test.js`: **26 checkpoints**, covering: tab
renders; single H1; unrelated tenant 404; legacy "Not recorded" with zero
lender rows; displayed stage === `deriveDrawStage()`; independent-vs-
jurisdictional labeling never mixes (and inspection actions create zero
`jurisdictional_inspections` rows); capability-gated controls (funder sees
them, PM does not); manually submitted unauthorized form and JSON posts both
rejected server-side; governed form posts redirect to `?tab=lender` with a
result; displayed inspection/waiver/decision/funding data equals the stored
SQLite rows; submitter-cannot-decide enforced through the UI's route; the
entire UI funding flow (schedule → disburse) leaves virtual-account events,
draw-account events, approval records and released milestones **byte-for-byte
unchanged**; trust note present; verification package generates, downloads
and is linked from the tab; printable preview resolves; zero horizontal
overflow at all eight widths; `render.yaml` production branch is `main`.

Full existing battery:

| Suite | Checkpoints |
|---|---|
| lender-test | 181 |
| permits-test | 82 |
| pilot-test | 70 |
| teams-sync-test | 52 |
| whatsapp-sync-test | 48 |
| draws-test | 45 |
| auditpackage-test | 43 |
| changeorders-test | 40 |
| fieldops-test | 40 |
| budget-test | 39 |
| gates-test | 35 |
| exceptions-test | 34 |
| drawpackage-test | 27 |
| map-test | 26 |
| **lender-ui-test (new)** | **26** |
| chat-test | 17 |
| idempotency-test | 17 |
| acceptance-test (19-step regression) | 17 |
| home-test | 14 |
| verification-test | 11 |
| intelligence-test | 10 |
| report-test | 10 |
| teams-test | 8 |
| frontend-test | 6 |
| deploy-check (incl. render.yaml `main` assertion) | pass |

## Deployment configuration status

- `render.yaml` production service `obv-demo` tracks `branch: main`; the
  `obv-frontend-preview` service still tracks its reconstruction branch,
  unchanged.
- `deploy-check` now fails if production stops tracking `main`.
- **The live Render service is not claimed to have changed.** This sandbox
  cannot reach `onrender.com`/`api.render.com`, so neither the Render service
  configuration nor a Blueprint sync could be observed. The next Blueprint
  sync / manual deploy should pick up `main`; confirming that requires the
  Render dashboard.

## Control integrity confirmation

No verification, governance, ledger, permit, retainage, exception or
financial-control behavior was weakened:

- No real money movement and **no new call path into `VirtualAccountService`**
  from any lender module or page handler (proved by the funding-flow
  financial-state equality checkpoint).
- No automatic approval or release; the lender decision is recorded only
  after formal governance and is labeled in the UI as a business decision,
  never as governance approval.
- No mutation of approval matrices from the lender UI.
- Evidence verification, Evidence Ledger records, permit/official-source
  rules, exception source truth, retainage controls and exactly-once release
  are untouched — their suites (verification, fieldops, permits, exceptions,
  changeorders, gates, draws, idempotency) all pass unmodified.
- Independent draw inspection remains technically and visibly distinct from
  government/jurisdictional inspection.
- No invented legacy data; no cross-tenant disclosure (same-404 preserved).
- Page handlers write nothing to SQLite directly; every mutation flows
  through the existing service methods and their authorization.
