# OBV Frontend Reconstruction — Phase 0 Audit

Baseline: backend freeze at `94f1217` (branch `claude/obv-frontend-reconstruction`).
Before-screenshots: `docs/reconstruction/before/` (17 routes × 1440/768/390).

## Systemic defects (ranked by user impact)

1. **Aggressive uppercase micro-labels everywhere.** `.t-meta` (10.5px, 0.07em tracking,
   uppercase) and clones (`.is-l`, `.iv-cell .l`, `.nav-group`, `.env-tag`, table `th`,
   `.issue-stats`, chip styles) are applied to ordinary labels and card titles. At narrow
   widths these wrap into broken stacks ("OPEN / CLARIFICATIONS", "AWAITING / FIELD").
   69 `text-transform: uppercase` uses; 129 `letter-spacing` declarations.
2. **Warm-tan canvas** (`--canvas: #f5f4f0` plus `--inset/--line` beige family) reads
   dated rather than institutional; the user explicitly dislikes it.
3. **Sparse pages stretch one card across an empty viewport.** `/issues` (summary strip +
   one table row), `/ledger` (two plain entries), `/projects` (single asset card) leave
   60–80% of the viewport blank with no secondary context, methodology, or activity.
4. **Registers are plain tables with no filters, search, or next action.** `/issues`,
   `/ledger`, `/reports` show records but not urgency, ownership, age, or the governed
   next step.
5. **295 inline `style=` attributes in pages.tsx alone** (plus more in other page files) —
   one-off spacing/color decisions that drift per page and defeat the design system.
6. **Mobile = desktop squeezed.** `.intg-table` data-label collapse exists but key-value
   grids (`.ctx-kv` with fixed `130px` first column, `.kv` `96px`), `.iv-stats` metric
   grids, and two-column layouts compress rather than reflow; metric labels break word-by-word.
7. **Status chip zoo.** `status`, `chip`, `sync-tag`, `int-sev`, `int-health`, `pf-risk`,
   `sev` — seven chip systems with different padding/casing/tones.
8. **No meaningful empty states** outside a few panels: most are a bare `<p class="sub">`.
9. **Ledger hashes truncate with no proof interaction**; the chain relationship between
   `prev` and `hash` is not visualized; integrity/count/action all compete in one row.
10. **Intelligence page density collapse:** seven equal `int-stat` cards regardless of
    value (five zeros get identical prominence), uppercase sublabels wrap awkwardly,
    and metric labels are detached from their numbers at 390px.
11. **Next governed action is often implicit.** Overview's queue does this well, but
    Issues/Ledger/Reports/Compliance rows stop at the record and never say who must act.
12. **Bottom-nav clearance is inconsistent** (`.content` mobile padding 92px, but
    map/communications shells manage their own), and the "More" page is a flat link list
    with no grouping.
13. **Headers over-explain.** Page subs are full paragraphs (Issues, Ledger) pushing
    content down, while headers lack as-of context and primary actions.
14. **Financial amounts lack differentiation.** Draw amounts render in a single style;
    requested/supportable/approved/released distinctions rely on labels only.
15. **`white-space: nowrap` on prose-ish content** (51 uses) causes clipped chips and
    forced ellipses at 390px (org name, topbar context, chips inside tables).

## Shell audit

- **Desktop:** fixed navy sidebar 236px (flat 13-item list + 2 groups), 50px topbar
  (context crumb + env tag + identity), content max 1128px. Sidebar list has no grouping
  for the finance workflow; 16 items in one column with mixed icon reuse (shield ×3).
- **Mobile:** sticky navy `mobile-top` (avatar / title+org / demo switch), fixed
  `bottom-nav` with Overview·Projects·Approvals·Ledger·More. `/more` is an ungrouped
  9-row list; page content bottom padding 92px.
- **AppShell** renders full HTML doc; all pages funnel through it except /field, /map
  (own shells), home/demo.

## Component inventory (components.tsx)

`Status`+chips (Milestone/Account/Verdict/Approval/Integrity), `AppShell`, `PageHeader`
(title/sub/crumb/actions), `FinancialBand`, `OperationalStatus`, `Pipeline`,
`MilestoneCard`, `ApprovalProgress`, `Evidence*` composables, `ProofRail`, `ActivityFeed`,
`ConfidenceTrack`, `EmptyState`. These are sound primitives; the gaps are:
MetricStrip/Metric, FilterBar/SearchField, DesktopDataTable/MobileRecordCard,
DataIncompleteState, MethodologyPanel, ActionQueue, AmountBreakdown, Timeline,
ProvenancePanel, TechnicalHashField, SectionHeader, StickyActionBar.

## CSS audit (public/styles.css, 2904 lines)

- Tokens exist (`:root`) but page sections accreted append-only "v4/v5/…" layers with
  local overrides; ~20 media queries at 9 different breakpoints (400/480/560/640/700/
  760/820/860/900/980/1023/1100).
- `box-sizing` reset present; `img { max-width }` NOT global (only in scoped rules).
- Fixed first columns: `.ctx-kv 130px`, `.kv 110px/96px`, `.pf-table` implicit,
  `.gate-row 190px` (fixed in v12 with minmax), trend rows `.tr-row .m` fixed 64px.
- Bottom clearance: `.content` 92px mobile only; map/comms shells own their padding.

## Route → archetype mapping (implementation plan)

| Route | Renderer | Current shape | Primary defect | Archetype target | Priority |
|---|---|---|---|---|---|
| /overview | renderOverview | metric cards + 3-col grid | good bones; tan, uppercase, weak traceability | Command Center | P2 |
| /projects | renderProjects | stacked ProjectAsset cards | no register affordances, no filters/search | Register | P2 |
| /project/:id | renderProjectDetail | tabbed workspace | tab sprawl, weak summary hierarchy | Detail Workspace | P2 |
| /milestone/:id | renderMilestoneDetail | six-gate + panels | dense but keep; typography + mobile | Detail Workspace | P2 |
| /approvals | renderApprovals | pending card + register | good structure; density + chips | Register/Queue | P2 |
| /draws, /draw/:id | drawPages.tsx | register + workspace | amount ambiguity, uppercase | Register + Detail | P2 |
| /compliance | renderCompliance | ops row + stacked EvidencePanels | queue not scannable; panels huge | Operational Workflow | P2 |
| /issues | renderIssues | stats strip + bare table | THE sparse-page example | Register | P2 |
| /exceptions | exceptionPages.tsx | register | visually identical to issues | Register (control-surveillance) | P2 |
| /ledger | renderLedger | one LedgerCard | sparse; no chain visual; no proof detail | Integrity workspace | P2 |
| /insights | renderIntelligence | 7-card row + tri-panel + table | uppercase wrap, equal-weight zeros | Command Center | P2 |
| /change-orders, /change-order/:id | coPages.tsx | register + detail | partial approval not explicit | Register + Detail | P3 |
| /budget | budgetPages.tsx | portfolio + comparison bars | subtotal vs coverage clarity | Register/Comparison | P3 |
| /field | renderFieldShell + field.js | JS shell | step hierarchy, technical context separation | Operational Workflow | P3 |
| /communications | renderCommunications | thread list + pane | boundary + unread state presentation | Workspace | P3 |
| /reports | renderReports | list | type distinction, integrity states | Register (library) | P3 |
| /setup | pilotPages | stages | checklist clarity | Operational Workflow | P3 |
| /pilot | renderPilotDashboard | panels | command-center hierarchy | Command Center | P3 |
| /communications/integrations | renderIntegrations | table | status-card rows, honest demo modes | Register | P3 |
| /map | renderMap | immersive console | inspector richness; mobile sheet | Spatial Workspace | P3 |
| /more | renderMore | flat list | grouped nav surface | Shell | P1 |
| /demo | renderUserSwitcher | role cards | keep, retone | — | P1 |
| /permits (project-scoped) | renderPermitRegister | filter+table | tone alignment | Register | P3 |

Intelligence health model on this branch supports HEALTHY / WATCH / AT_RISK only
(healthChip in pages.tsx). `/control` does NOT exist on this branch — no fabricated
statuses will be added.

## Design decisions for Phase 1

- **Canvas:** cool neutral `#f4f5f8`; surfaces white; hairlines `#e4e7ec`; chrome
  graphite-navy `#0e1420`; accent blue kept restrained (`#2050d8` family); semantic
  green/amber/red retained but recalibrated for AA contrast.
- **Type:** page title 28px/650 desktop → 24px mobile; section 18px; body 14px;
  secondary 13px; metadata 12px sentence-case medium; uppercase only for ≤2-word
  metadata tags at 11px/0.05em. Tabular numerals for all financial figures.
- **Spacing:** 4/8/12/16/20/24/32 scale; page gutter 16px mobile, 28px desktop;
  card padding 16px; section gap 20–24px.
- **Status:** single `StatusChip` (glyph + sentence-case text + tone), one radius, one
  padding; severity/status/health map to tones; never color-only.
- **Density:** summary (large numerals) / operational (rows) / audit (mono technical)
  as distinct components, never mixed in one card.

---

# Appendix — detailed route-by-route audit (verified against source)

## Inline-style census
813 inline `style=` occurrences across 12 view files (drawPages 146, pages.tsx 295,
budgetPages 72, pilotPages 126, exceptionPages 54, coPages 47, permitPages 19...).

## Per-route findings

| Route | Renderer | Layout zones | Primary defects | Mobile risk |
|---|---|---|---|---|
| /overview | renderOverview pages.tsx:367 | capital metrics, portfolio/queue/activity 3-col | inline % bars, uppercase micro-labels | Low (mobile cards exist) |
| /projects | renderProjects pages.tsx:604 | stacked ProjectAsset cards | sparse; no summary/filters/empty state | Low |
| /project/:id | renderProjectDetail pages.tsx:661 | proj-head, lifecycle, 8 tabs | heaviest inline styling; fixed 300px sidebar col | Med |
| /milestone/:id | renderMilestoneDetail pages.tsx:967 | gates panel, permits, evidence | inline 190px gate grid collapsing via !important | Med |
| /approvals | renderApprovals pages.tsx:1474 | at-stake, pending ap-cards, resolved | fixed 250/264px cols; uppercase chips | Med |
| /draws | renderDrawRegister drawPages.tsx:133 | stats + 10-col table | per-cell inline styles; uppercase th | Low |
| /draws/new /change-orders/new /issues/new /evidence-drafts/new | various | narrow 640-680px forms | sparse; stranded desktop whitespace | Low |
| /draw/:id | renderDrawDetail drawPages.tsx:366 | fin-band, 8 tabs | 146 inline styles in file | Med |
| /change-orders | renderCoRegister coPages.tsx:55 | stats + 10-col table | same pattern as draws | Low |
| /exceptions | renderExceptionRegister exceptionPages.tsx:72 | stats, 7 filters, 10-col table | inline 10.5px uppercase filter labels | Low |
| /budget | renderBudgetPortfolio budgetPages.tsx:77 | thin per-project bar rows | sparse; no summary band; right-side void | Low |
| /compliance | renderCompliance pages.tsx:2257 | ops dots, stacked EvidencePanels | queue not scannable | Low |
| /insights | renderIntelligence pages.tsx:2379 | 7-card sum, signals/recs, tri-panel, attention | uppercase iv-labels 10px; equal-weight zeros | Low |
| /map | renderMap pages.tsx:2949 | JS-rendered console | own shell; fixed mp-kv 84-96px labels | Med |
| /communications | renderCommunications pages.tsx:3110 | 300px/1fr/280px 3-col | narrow center 700-980px; uppercase ref labels | Med |
| /issues | renderIssues pages.tsx:3725 | stats strip + bare 7-col table | THE sparse exemplar; no EmptyState; no filters | Low |
| /issue/:id | renderIssueDetail pages.tsx:3794 | ctx-kv 130px inline grid, timeline | inline uppercase SOURCE MESSAGE | Low |
| /reports | renderReports pages.tsx:1947 | report panels + registers | audit-package table has NO mobile fallback | Med-High |
| /ledger | renderLedger pages.tsx:1794 | one LedgerCard | 9-col table; sparse; no proof detail | Low |
| /setup | renderPilotSetup pilotPages.tsx:60 | orgs/invites/projects | 126 inline styles; setup-grid 250px | Med |
| /pilot | renderPilotDashboard pilotPages.tsx:1113 | 9-item stats + panels | 9 stats wrap oddly | Low |
| /more | renderMore pages.tsx:2740 | 9 fully inline-styled rows | zero reusable classes on primary mobile nav | Low |
| /field | renderFieldShell pages.tsx:2786 | JS skeleton | server-sparse by design | own shell |
| /demo | renderUserSwitcher pages.tsx:253 | role cards | clean; retone only | Low |
| /project/:id/permits | renderPermitRegister permitPages.tsx:22 | filters + 11-col table | widest table; uppercase 10px filter labels | Low |

## CSS specifics
- 44 @media rules across 14 distinct breakpoints (400→1240) — no token system.
- ~50 classes with uppercase below 12px (worst: 8.5-9.5px).
- Fixed label columns: .kv 118px, .field-kv 104px, .mp-kv 96/84px, .ctx-kv 92px +
  inline 130px/170px/190px variants.
- Bottom-nav clearance: content 92px @≤1023px; map manages its own.
- No global overflow guard; reports audit-package table can force document scroll.
