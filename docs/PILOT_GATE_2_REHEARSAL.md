# Pilot Gate #2 — Lender Workflow Rehearsal & Launch Hardening

An OPERATE / VALIDATE milestone. The complete lender workflow was run
against `main` at `cc060388d68341f73a80a4abc7f043830e9f9218` (PR #31
Timeline & Site Evidence and PR #32 Jurisdictional control hardening both
merged) through the NORMAL governed APIs and surfaces, in declared PILOT
posture (`OBV_ENVIRONMENT=pilot`, persistent `OBV_DATA_DIR`, production
magic-link identity captured through the deterministic file outbox, mock
banking, no demo seed, no role switcher). Database access from the
rehearsal harness was read-only verification; no state was injected.

Fictional project: **Ivy City Warehouse Conversion** (IVY-2026, District of
Columbia), lender **Potomac Ridge Capital**, borrower/contractor
**Anacostia Builders LLC**. Draws #1–#3 exist as cancelled history
("consolidated into draw #4"); they were never evaluated, approved or
funded.

Severity: **P0** governance/security/data integrity · **P1** can cause a
materially wrong lender decision · **P2** blocks a realistic pilot
workflow · **P3** material operator friction · **P4** cosmetic / defer.

---

## What the rehearsal proved (final run: 124 checks, 0 failures)

**Primary scenario — draw #4, $71,500.** Draw created → two lines (steel
moment frame $45,000, rough-in MEP $26,500) → submitted → two field photos
captured with site GPS inside the configured polygon → verified → dual
control approval (submitter excluded) → evidence linked to the draw →
contractor completion reported (CONTRACTOR membership) → both lines
reviewed SUPPORTED → 3 required documents recorded → inspection
requirement determined REQUIRED (permit + code basis gated) → permit
B2026-04471 recorded ACTIVE, linked, governing code basis recorded →
governance sent + dual approvals → amendment AMD-2026-0912 recorded
(effect undetermined surfaces as a non-waivable unknown) → reviewer
records inspection-scheduling effect **BLOCKED** with basis.

| Fact | Result |
|---|---|
| Requested / currently supportable / unsupported | $71,500 / $71,500 / $0 (100 % coverage) |
| Physical · Financial · Documents · Compliance | PASS · PASS · PASS · **HOLD** |
| Readiness | **HOLD** |
| Primary blocker | `PERMIT_AMENDMENT_BLOCKS_INSPECTION` (GOVERNMENT_INSPECTION) |
| Next action | "Resolve the permit amendment, then complete the required inspection." |

100 % support coverage never became READY while the governed blocker stood.

**HOLD → resolution → inspection.** Amendment resolved APPROVED through the
governed lifecycle → the amendment blocker cleared, the draw **remained
HOLD** (`INSPECTION_NOT_SCHEDULED`, `JURISDICTIONAL_INSPECTION_NOT_PASSED`),
no satisfied-inspection claim → inspection created and scheduled (still
HOLD) → result PASSED recorded by the reviewer → readiness recomputed
**READY**, all four domains PASS, one `READINESS_TRANSITION` HOLD→READY and
exactly one `DRAW_READY_FOR_REVIEW` governed event.

**Lender decision.** APPROVED $71,500 recorded by the LENDER_REVIEWER:
readiness at decision READY, `proceededByException=false`, one lender
decision row, one immutable `READINESS_SNAPSHOT` (status READY, no
overridden blockers, byte-identical after later recomputation), lender
package generated, payment eligibility read per existing semantics ("Not
eligible for payment instruction — no active virtual account"), banking
simulation unavailable, no funding/payment/legal claim in the package.

**Historical truth.** The project timeline holds amendment recorded →
effect BLOCKED → (standing) readiness HOLD → amendment resolved →
inspection scheduled → inspection passed → readiness READY → lender
decision, in chronological order; the historical HOLD transition still
says HOLD while the current linked state is READY; every earlier
`READINESS_TRANSITION` row is byte-identical after later changes; the
amendment creation event still says PENDING after approval; inspection
events carry no spatial position; only evidence events carry a recorded
fix; the EventInspector separates AT THE TIME from CURRENT LINKED STATE;
no invented cause.

**Executive.** While blocked: 1 open draw, $71,500 requested and $71,500
supportable, readiness distribution HOLD 1, Compliance pressure 1 HOLD,
attention register names the amendment blocker and the next action. After
the inspection passed: READY 1, HOLD 0. (After fix PG2-01 — see below.)

**Scenario 2 — UNKNOWN permit (draw #5, $38,000).** Everything else
satisfied, inspection PASSED, permit status UNKNOWN → `PERMIT_STATUS_UNKNOWN`
with `exceptionAllowed=false`, Compliance UNKNOWN, readiness **INCOMPLETE**;
APPROVED refused 422 without and WITH documented exception justification
("Missing information cannot be waived into existence"); zero lender
decision, zero readiness snapshot, zero proceed-by-exception disposition
persisted.

**Scenario 3 — legitimate exception (draw #6, $24,000).** READY draw, formal
HIGH exception recorded → `OPEN_BLOCKING_EXCEPTION` (EXCEPTION,
exception-eligible) → EXCEPTION_REVIEW → APPROVED without justification
422 → field 403 / borrower 403 → APPROVED with justification 201,
`proceededByException=true`, immutable snapshot preserving readiness,
overridden blockers and justification; the exception remains OPEN;
Executive lists the proceeded-by-exception draw; Draw Review shows the
permanent disposition; timeline carries the exception history.

**Tenancy / read-only / notifications / posture.** Foreign tenant probes
404 (draw, decision, permit, amendment, timeline, twin, inspection); the
foreign Executive is empty. Page and API reads leave 14 governed tables
byte-identical; repeated reads add no notification or audit rows;
governed notifications are addressed with a recorded reason. Graceful
SIGTERM restart preserved sessions, draws and decisions with identical
readiness; backup created + verified + checksum re-verified; restore into
an isolated root (post-backup mutation absent) booted on its own port and a
write inside it never reached the primary. `npm run pilot:check`: 15 pass,
2 warn, 3 fail — all three are deployment configuration (see PG2-06).

**Visual review** (Playwright, pilot posture, real session cookies):
Executive, Draw Review and Timeline & Site Evidence at 1440×900 dark;
Field Engineer and Draw Review at 390×844 dark; Executive and Draw Review
at 1440×900 light. No horizontal overflow, no demo affordances, no
legal/funding/payment claims. No usability defect blocking the pilot was
confirmed; the mobile Draw Review stacks the line register as records.

**Adversarial pass.** UNKNOWN → exception bypass (422, nothing persisted);
100 % support → false READY (HOLD held); amendment resolution → false
inspection PASS (HOLD held); current state rewriting history (byte-identical
rows); governance decision vs lender decision (PG2-01 fixed + pinned);
supportable vs approved (separate facts; over-request refused); release
eligibility vs fund movement (no active virtual account, no banking path);
tenant leakage (404s, empty Executive); read causing writes (none);
duplicate notifications (one READY event); stale Executive (distribution
updated); invented spatial position (none); demo data in pilot posture
(none). A reviewer without the LENDER_REVIEWER capability cannot decide;
after the decision the draw is terminal for transitions.

---

## Friction log

### PG2-01 · Governance-released, undecided draws were treated as terminal — **P1 · FIXED**

- **Surfaces:** Executive Command Center, Pilot command centre, Draws
  register, Draw Review header ("Draw workflow stage"), Timeline & Site
  Evidence CURRENT strip, readiness transitions + notifications.
- **Repro:** complete formal governance (dual approvals → `RELEASED`) with
  no lender decision, then change a governed input (amendment effect,
  inspection result). The draw vanished from the Executive open set
  (requested/supportable capital, readiness distribution, domain pressure,
  attention queue all read zero), its next action read "Complete — no
  action required" while readiness was HOLD, milestone/permit fan-outs
  skipped it (`TRANSITION_TERMINAL` included every RELEASED draw), so the
  HOLD→READY transition and `DRAW_READY_FOR_REVIEW` fired only when the
  lender happened to open the decision route.
- **Truth / governance impact:** formal governance conflated with the
  lender decision — the lender decision can only be recorded AFTER
  governance, so every draw awaiting the lender was invisible as open
  capital and un-notified.
- **Pilot impact:** the head of lending could read "no HOLD capital" while
  $71,500 sat on HOLD awaiting their decision.
- **Disposition:** fixed. `lenderDecisions.awaitingLenderDecision` is the
  one shared predicate (RELEASED + no standing final decision);
  `lenderPilot.isOpenForLenderControl` = review statuses + awaiting
  decision, consumed by the command centre, Executive capital control
  (`isOpenDraw`, inclusion rule text updated), the Draws register, the
  twin's CURRENT strip and the fan-out terminal rule; next action
  `LENDER_DECISION_REQUIRED` ("Governance complete — lender decision
  required", actor LENDER) mapped into the existing pipeline bucket
  (relabelled "Awaiting lender review / decision"). No new metric, state
  or workspace. Regressions: `lender-pilot-test` (+4), `executive-ui-test`
  (+2), `draw-readiness-test` S5/PG2 (+2), `pilot-acceptance-test` (+3).
  Bite: reverting the terminal rule / the open predicate failed the
  suites before restoration.

### PG2-02 · Clean draws could never show Physical PASS — **P2 · FIXED**

- **Surface:** Draw Control Scorecard (Draw Review), Executive domain
  pressure.
- **Repro:** any draw whose recommendation is "READY FOR GOVERNANCE": the
  recommendation engine's positive draw-level INFO summary ("All line
  items supported by review; documents complete; no blocking issues") was
  consumed as an EVIDENCE `ADVISORY_SIGNAL` warning, so the PHYSICAL domain
  rolled up WARNING on every clean draw.
- **Impact:** a lender sees "Physical: WARNING" beside "no blocking issues".
- **Disposition:** fixed — only line-scoped INFO notes (the grounded-progress
  cross-checks) are advisory warnings. Regression: `draw-readiness-test`
  block M. Bite caught.

### PG2-03 · Draw Review told a governance approver "a decision is already recorded" — **P2 · FIXED**

- **Surface:** Draw Review → Lender Decision panel.
- **Repro:** a COMPLIANCE_REVIEWER who recorded their formal governance
  approval opens the draw before any lender decision exists; the panel says
  "A decision is already recorded for this draw by this reviewer."
- **Impact:** governance approval presented as a lender decision.
- **Disposition:** fixed (copy: "This reviewer's formal governance approval
  is already recorded … The lender decision is a separate governed act").
  Regression: `pilot-acceptance-test`.

### PG2-12 · Pilot command centre labelled a mixed queue "Ready for lender decision" and governance bookkeeping "Recently approved" — **P2 · FIXED**

- **Surface:** Pilot command centre (`/overview`, funder landing).
- **Repro:** the "Ready for lender decision" bucket held BEGIN_REVIEW,
  CONTINUE_LINE_REVIEW, LENDER_REVIEW_READY and AWAITING_APPROVALS draws
  (review not begun / incomplete / governance incomplete) beside the only
  literally decision-ready code, LENDER_DECISION_REQUIRED; "Recently
  approved" listed draws by workflow status (APPROVED / PARTIALLY_APPROVED
  / RELEASED) sorted by `submittedAt`, so a governance-released draw with
  NO lender decision showed as "recently approved" while also reading
  "Governance complete — lender decision required".
- **Disposition:** fixed. The queue is the **Lender control queue** (same
  five codes — every open draw whose next actor is the lender side);
  **Recent lender decisions** is derived from the lender decision register
  (standing recorded dispositions APPROVED / CONDITIONALLY_APPROVED /
  REDUCED / REJECTED / WITHDRAWN / FUNDED, never PENDING, never workflow
  status), sorted by `decisionAt`, showing the disposition and its own
  decision date. Formal governance completion alone never creates an
  entry. Regression: `lender-pilot-test` A–E; bites (heading restored /
  status-based list restored) fail before restoration.

### PG2-04 · "Released" precedes the lender decision; evidence approval releases milestone tranches — **P3 · CONDITION (training)**

- Draw Review shows "✓ Released" beside "READINESS HOLD"; the lender
  decision panel lists "Released $71,500" before any decision; approving
  field evidence releases the milestone tranche on the virtual account
  with a "Tranche … RELEASED" notification. All are release *eligibility*
  bookkeeping (no money moves — verified). Existing accepted condition
  P-06; onboarding must explain the term. Label copy deferred.

### PG2-05 · Exception path available past a required government inspection — **P3 · CONDITION (policy acceptance)**

- The HOLD draw showed "Exception path available under current policy"
  because GOVERNMENT_INSPECTION (incl. `PERMIT_AMENDMENT_BLOCKS_INSPECTION`)
  is exception-eligible in the shipped matrix (P-05). The pilot lender must
  accept the shipped eligibility matrix at kickoff; per-tenant policy stays
  future work.

### PG2-06 · pilot:check reports 3 FAILs in the rehearsal environment — **P2 · CONDITION (deployment configuration)**

- `auth link delivery` (file outbox), `email provider` (development
  outbox), `public base URL` unset — expected in a test-provider
  rehearsal, but each is a hard precondition for external traffic
  (`docs/FIRST_LENDER_RUNBOOK.md` §1–2). Also set `OBV_ACCESS_CODE` for any
  externally reachable pilot (P-02 condition).

### PG2-07 · Static assets resolve from `process.cwd()` — **P4 · DOCUMENTED**

- Starting `dist/server/http/server.js` from another working directory
  serves unstyled pages (`PUBLIC_DIR = cwd/public`). The supported start is
  `npm start` from the repository root / container WORKDIR, which is what
  the runbooks and the container do. No code change.

### PG2-08 · Handoff doc drift — **P4 · FIXED (docs)**

- `docs/PROJECT_HANDOFF.md` §3.3 still described an unknown-status permit as
  `PERMIT_NOT_ACTIVE` (superseded by PR #32) and the milestone table ended
  at PR #24. Corrected; `DRAW_READINESS_ENGINE.md` §8 and the friction log
  P-06 note carry the new terminal rule.

### PG2-09 · One milestone approval request covers every evidence item — **P4 · DOCUMENTED**

- Two photos submitted for the same milestone share one approval request;
  a second approval pass returns 409 "already been resolved". Expected
  behaviour; operator guidance only.

### PG2-10 · Unlinked evidence keeps Physical at WARNING — **P3 · DOCUMENTED (SOP)**

- Draw-level evidence links are recommended, not required: draw #5, whose
  evidence was verified but not linked, reads `EVIDENCE_LINKS_MISSING` →
  Physical WARNING. Pilot SOP: link field evidence to the draw during
  review (one click on the Evidence tab).

### PG2-11 · Cancelled draft draws leave readiness transitions in "Recent control changes" — **P4 · DEFERRED**

- Drafts created with lines record a `READINESS_TRANSITION` before
  submission; cancelled drafts therefore appear as "Draw #3 — Readiness
  HOLD" in the Executive change feed. Harmless, truthful, noisy.

---

## Pilot success gate

**GO WITH CONDITIONS.**

- Governance integrity: proven (P0 checks all pass; PG2-01 corrected).
- Workflow completion: proven end to end through normal interfaces.
- Operator usability: acceptable on desktop and mobile; conditions PG2-04
  (training), PG2-10 (SOP).
- Historical truth: proven.
- Tenant isolation, persistence, backup/restore, notification behaviour:
  proven.
- Deployment posture: NOT READY until PG2-06 is satisfied (real magic-link
  delivery, real email provider, public base URL, access code) and the
  lender accepts PG2-05.
