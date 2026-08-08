# Lender Pilot RC1

The composition milestone: OBV's existing capabilities arranged into one
focused lender workflow a real DMV rehab lender can pilot. Nothing was
rewritten; nothing was removed.

## The workflow

Project created → draw submitted → required evidence collected →
evidence/compliance reviewed → exceptions resolved → lender decision →
release eligibility recorded → lender-ready package generated.

## What RC1 adds

- **Deterministic Next Action** (`services/pilot/lenderPilot.ts`): every
  draw computes one human-readable next action from AUTHORITATIVE records
  only, checked in workflow order (draft/returned/clarification → missing
  required documents → open exceptions → required inspections without a
  recorded result → line review → approvals → decision conditions →
  release transition). Never probabilistic, never advisory-driven, never
  a mutation — proven byte-identical over the draw tables.
- **Pilot Command Center**: the funder landing answers "what needs
  attention today" — ready for decision / waiting on contractor / waiting
  on inspection / compliance exceptions / aging / recently approved —
  plus operational metrics with a REAL median submission→decision time
  (or null; never estimated).
- **Pilot navigation**: funders see the six pilot surfaces (Portfolio,
  Projects, Draws, Evidence Review, Approvals, Reports); every other
  destination stays one group away under Advanced & intelligence. Field
  users get capture-first navigation. No destination was deleted; no
  authorization changed.
- **Draw Review**: a Next Action banner on the flagship screen, over the
  existing summary strip, completeness checklist, compliance tabs, and
  decision area.
- **Golden demo project** (`OBV_SEED_GOLDEN=1`): DEMO — 214 Halcyon St
  NW, a fictional $860k DC rehab with six draws spanning the whole
  workflow (released history with recorded decision; awaiting second
  approval with a partially supported change-order line; returned for
  information; missing lien waiver; open permit-scope exception; required
  inspection awaiting result), fictional permits (one expiring), and a
  corrected inspection chain. Every record labeled fictional. Opt-in, so
  every existing suite keeps its exact baseline.
- **Lender package executive summary**: `00-EXECUTIVE-SUMMARY.txt` leads
  every draw package — nine plain-language sections a lender executive
  can read without the application. It restates governed figures and
  authorizes nothing.
- **Pilot ROI measurements** (`/api/pilot/roi`): per-draw recorded
  timestamps and counts (submission→first review→decision, resubmissions,
  clarifications, returns, exceptions) — the raw material to calculate
  savings after the pilot. No fabricated dollars.
- **Notification wiring** (`services/pilot/notify.ts`): draw submitted /
  evidence resubmitted / information requested / approval required /
  returned / decision recorded / exception opened fan out to the in-app
  feed and the development-safe email outbox (Teams already fires at the
  existing call sites). Notifications never mutate the workflow; a
  failing channel is swallowed.

## Tests

`scripts/lender-pilot-test.js` — 73 checkpoints: golden-project
integrity and flag-gating, deterministic next actions with a read-only
proof, command-center buckets, the LIVE golden path end to end through
the governed services (incomplete evidence → visible missing list →
correction → review → dual approval → release eligibility → lender
decision → package with executive summary → Timeline reflection),
notification wiring, ROI from real timestamps, and tenancy (foreign
tenants 404, anonymous 401).

## Remaining blockers before the first external lender

Documented, not hidden: production email delivery (the outbox seam is
wired; a real provider is not), persistent disk + backups on the
deployment target, and real per-user notification routing.
