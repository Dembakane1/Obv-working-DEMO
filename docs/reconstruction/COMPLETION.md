# OBV Frontend Reconstruction — Completion Report

Branch: `claude/obv-frontend-reconstruction` (from backend freeze `94f1217`).
Backend logic, schema, services, routes' authoritative behavior: **unchanged**.
Screenshots: `docs/reconstruction/before/` and `docs/reconstruction/after/`
(19 routes × 1440 / 768 / 390).

## Phase commits

1. `a902dc0` — frontend audit, route inventory, defect census, before-screenshots
2. `b5b32f9` — design-system foundation + application shell / navigation reconstruction
3. `7737bf4` — lender workflow: Field Issues, Ledger, Intelligence, Projects + typography detox
4. `6613758` / `11c54e3` — operational pages: Budget, Reports, Change Orders, Pilot, creation workspaces
5. `453cb39` — creation workspaces, communications trust boundary, label cleanup
6. `cf02bb9` — responsive hardening (evidence-panel collapse, touch targets)
7. (final) — frontend visual test suite + regression alignment + after-screenshots

## Design system summary

- Cool neutral canvas (`#f4f5f8`) replacing the warm-tan palette; graphite-navy chrome;
  restrained blue action color; AA-calibrated semantic green/amber/red; spacing scale
  tokens (4–32px); shadow/radius tokens; global `box-sizing` + media `max-width` reset;
  `prefers-reduced-motion` support.
- Type scale: 28px page titles (24 mobile), 18px sections, 14px body, 12px metadata.
  Sentence case everywhere; exactly 6 deliberate short uppercase tags remain
  (brand tag, nav group titles, environment tag, map layer/legend toggles) — all ≥10px.
- One status-chip system (glyph + sentence-case text + tone); severity/status/health map
  to the same treatment; state is never color-only.
- Three densities: summary (metric strips), operational (registers/queues), audit
  (mono hash fields, timelines) — never mixed in one card.

## Reusable components added

CSS + TSX: `MetricStrip`/`Metric` (with de-emphasized zeros), `AttentionBanner`,
`FilterBar` + `filter-grid`, register tables (`table.reg`) + `rec-card` mobile record
cards, `EmptyStateV2` (healthy / incomplete / unconfigured), `Methodology`,
`ActionQueue`, `AmountBreakdown`, `TechnicalHash`, `Timeline`, `Provenance`,
`SectionHead`, `sticky-actions`, `kv-grid`, `work-grid` two-zone layout,
`more-group`/`more-row` navigation surface, ledger `chain` visualization,
`enumLabel` (UPPER_SNAKE → operational language).

## Page-by-page

- **Shell**: grouped sidebar (portfolio → capital control → verification & records →
  field operations → pilot), aggregated More badge, grouped /more surface,
  as-of context line in page headers.
- **Overview**: retoned command center (structure retained; typography/tables detoxed).
- **Projects**: portfolio summary metrics, search + state filters, open-issue chips,
  per-project next action, honest empty state.
- **Field Issues**: decision metrics, overdue banner, severity/status/category/overdue
  filters, register with owner/age/due/overdue/next-action, mobile record cards,
  explanatory empty state, trust boundary in the footer.
- **Evidence Ledger**: integrity metrics, head hash field, per-project filter, visual
  hash chain with proof-detail expanders (prev/current/payload hashes, verification
  provenance + policy version), methodology panel.
- **OBV Intelligence**: shared metric system with dim zeros, sentence-case chips,
  honest HEALTHY/WATCH/AT_RISK model only (no fabricated statuses; `/control` does not
  exist on this branch), spacing defects fixed at the root (no clipping).
- **Approvals**: decision metrics (pending, value at stake, oldest, resolved), healthy
  empty state, sentence-cased resolution chips; per-role progress retained.
- **Draw Requests**: toned metrics, sentence-case recommendations, empty state; amount
  categories remain distinct columns (requested / supported / exception / retainage).
- **Evidence Review**: four-metric summary linking to approvals + ledger; queue panels.
- **Exceptions**: SLA metrics, readable filters, enumLabel presentation, empty state;
  source-truth language retained.
- **Change Orders**: metrics keeping requested vs approved distinct, empty state.
- **Budget & Progress**: portfolio summary with explicit partial-coverage language,
  structured comparison rows with data-incomplete tags and register links.
- **Reports**: audit-package register gains the missing mobile card fallback.
- **Communications**: persistent trust-boundary footer; sr-only H1 for accessibility.
- **Creation pages** (draw / change order / field issue): two-zone workspaces with
  what-happens-next methodology panels.
- **Pilot Operations**: grouped metric strips replacing the nine-item stat row.
- **Milestone detail**: evidence panel now collapses on mobile (cascade fix); gate-row
  labels sentence-cased with flexible label column.

## Test results

- New `scripts/frontend-test.js`: 6 aggregate checkpoints — 19 routes × desktop/mobile
  (single H1, decision summary, work area, overflow, chip containment, bottom-nav
  clearance), tablet spot pass, typography rules, long-content extremes at 375px
  (org/project/issue names temporarily extended via sqlite and restored), role smoke.
- Overflow scan: 26 routes × 375/390/393/430/768/1024/1280/1440 — **zero**
  document-level horizontal overflow.
- All 22 existing suites green: gates 35, permits 82, draw package 27, audit package 43,
  change orders 40, exceptions 34, draws 45, budget 39, field ops 40, pilot 70,
  idempotency 17, chat 17, verification 11, teams 8, teams-sync 52, whatsapp-sync 48,
  acceptance 17, intelligence 10, map 26, homepage 14, report 10, deploy-check 22.
- Three UI test assertions were updated to the new presentation (intelligence metric
  markup + calm-banner text; field-ops issues-page disclaimer phrasing). Data-equality
  assertions unchanged.

## Known limitations

- `/field` remains a client-JS capture shell (restyled via tokens; not rebuilt).
- The printed draw-verification document and PDF report keep their print typography.
- Pilot Setup workspace (`/setup/project/:id`) retains its dense configuration layout;
  it inherits tokens/typography but was not re-architected.
- Draw/change-order deep detail tabs inherit the system but keep their existing zones.

## Doctrine

No backend endpoint, schema, service, calculation, or authoritative state changed.
Filters added to GET routes are presentation-only (they narrow what is rendered).
The ledger page's verification lookup is a read-only view join. No hidden mutations.
