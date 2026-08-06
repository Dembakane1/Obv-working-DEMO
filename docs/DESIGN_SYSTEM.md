# Enterprise Design System v2

Frontend/UI only. Every backend capability, workflow, authorization rule,
route, and API is untouched — the redesign is a new face on the same
record, verified by the full regression battery and a dedicated design
suite.

## Themes

Dark is the primary experience: deep-navy canvas (`#0A101E` — never pure
black), slate surfaces, electric-blue action, emerald / amber / soft-red
semantics. Light is a complete first-class theme (white surfaces, cool
grays, blue accents, soft shadows) with identical hierarchy — not an
inversion. The theme boots from `localStorage` before first paint, a
topbar control toggles it (`t`), and **print always renders light**.

The entire application reads one token vocabulary (`--canvas`,
`--surface*`, `--ink*`, `--line*`, `--action*`, `--ok/--warn/--bad/--info`
with `*-bg`/`*-line` pairs, `--ch-1…6`, radii, shadows, spacing), so the
two token blocks in `public/styles.css` ARE the two themes.

## Verified color

- Every text token is computed ≥ 4.5:1 (WCAG AA) on both its surfaces, in
  both themes — asserted by `scripts/design-test.js`, not eyeballed.
- The categorical chart palettes (6 fixed-order slots per theme) passed a
  six-check palette validator: lightness band, chroma floor, CVD
  separation, normal-vision separation, and ≥ 3:1 contrast against each
  theme's chart surface.
- Filled action buttons use a dedicated `--action-fill` that carries AA
  white text; links use a lighter accent that is AA on the dark surfaces.

## Shell

Regrouped sidebar (every pre-existing destination preserved — asserted
per-href), smooth collapse (`[`), pinned favorites + recent projects
(viewer's own localStorage), global search command palette (`/` or
Ctrl-K) over pages and recent projects, theme toggle, keyboard hints.
`/js/shell.js` is pure presentation: no fetches, no writes.

## Components

Cards with gradient sheen and hover lift, buttons/chips/status pills,
tables with hover traces, tabs, inputs, skeleton loaders, empty states,
conic progress rings, health bars, animated counters, micro-transitions
— all respecting `prefers-reduced-motion`, with enlarged touch targets
on coarse pointers. The Digital Twin scene palette follows the theme.

## Role-based landings

`/overview` opens on the caller's work: executive focus for funder
representatives, delivery focus for project managers, assurance focus
for compliance reviewers; field engineers keep the capture-first `/field`
experience. The full portfolio content remains beneath every role focus —
nothing is removed for any role, and no authorization changed.

## Tests

`scripts/design-test.js` — 104 checkpoints: token architecture, computed
AA contrast in both themes, chart-palette contrast, shell controls and
boot order, per-href navigation preservation, role landings (distinct
and complete), accessibility/motion primitives, and the read-only proof
for the shell script.
