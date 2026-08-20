# Pilot Friction Log

Findings from the **pilot-launch operational rehearsal** on `main` at
`213f807`, executed against a real PILOT-posture deployment
(`OBV_ENVIRONMENT=pilot`, persistent `OBV_DATA_DIR`, magic-link identity
with file-outbox delivery, mock banking): bootstrap admin → organizations →
invitations → project → launch → evidence → draws → documents → jurisdiction
workflow → reviews → readiness → governance → decisions → package → audit,
entirely through normal user/API/UI paths. Full context in the pilot-launch
report; this log records the friction only.

Severity: **BLOCKER** (prevents responsible external use) · **HIGH**
(must be addressed or explicitly accepted before onboarding) · **MEDIUM**
(address early in the pilot) · **LOW** (batch into normal work).
Per the validation rules, nothing below was fixed during the rehearsal.
Statuses were added by the corrective pass (branch
`claude/obv-pilot-corrective-pass`); the original findings and
reproductions are preserved unchanged below each status.

---

## P-01 · "Demo environment" badge on every page in pilot posture — HIGH

**Status: FIXED** — the workstation shell (desktop top bar, mobile top bar, /more, field shell, error page) renders demo tags/switch affordances only in demo posture (`productionPosture()` gate in the view layer).

- **Step:** every workstation page (sign-in excluded).
- **Observed:** the top bar renders a hard-coded `DEMO ENVIRONMENT` tag and
  a "Switch" control on desktop and mobile even when the server runs
  declared PILOT posture with real lender data
  (`src/server/view/components.tsx` — unconditional `env-tag`). "Switch"
  leads to `/demo`, which correctly 404s in pilot.
- **Expected:** a lender reviewing a real draw must never be told they are
  in a demo.
- **Repro:** boot with `OBV_ENVIRONMENT=pilot`, sign in, open any page.
- **Recommended:** render the tag from the posture resolver (hide or say
  PILOT in pilot/production); hide "Switch" when the demo switcher is
  disabled.
- **Requires code:** yes (small, view-layer only).

## P-02 · Unauthenticated public homepage exposes pilot project data — HIGH

**Status: FIXED** — in pilot/production posture `/` never queries `homeSnapshot()`: the marketing page renders a tenant-safe generic preview ("Illustrative product preview — no live project data") and every CTA routes to `/signin`. Demo posture keeps the seeded demonstration snapshot. `OBV_ACCESS_CODE` remains a temporary operational defense-in-depth, no longer the only boundary.

- **Step:** public `/` of a pilot deployment.
- **Observed:** the homepage renders the largest ACTIVE project's real
  name, held amount and progress figures to unauthenticated visitors,
  labeled "LIVE DEMO DATA" with "Enter Demo" CTAs (`homeSnapshot()` reads
  live data; `src/server/view/homePage.tsx`). In the rehearsal the real
  pilot project name and $450,000 held were visible with no session.
- **Mitigation (verified):** setting `OBV_ACCESS_CODE` gates `/` — the
  rehearsal confirmed 401 + access-code prompt and zero data in the body.
- **Expected:** a pilot deployment must not disclose tenant data on a
  public page, and must not brand real data as demo data.
- **Repro:** `curl` the deployment root with no cookie.
- **Recommended:** operational condition NOW — `OBV_ACCESS_CODE` is
  MANDATORY for any externally reachable pilot until the homepage is
  posture-gated; then posture-gate the marketing homepage (code).
- **Requires code:** yes (for the real fix); no (for the access-code
  condition).

## P-03 · Milestone tranche release never consults the jurisdictional determination — HIGH

**Status: FIXED** — `completionGates.drawReviewSurface()` exposes the exact eligibility assembly WITHOUT the RELEASED short-circuit, and the Draw Readiness engine now evaluates gate reasons from that surface. Release bookkeeping (untouched, never rewritten) no longer suppresses jurisdictional truth: an UNDETERMINED requirement on a RELEASED milestone resolves INCOMPLETE, approving decisions refuse 422 justified or not, and governed resolution recomputes normally. Regression A–L added to `scripts/draw-readiness-test.js` (block P).

- **Step:** evidence dual-control approvals (step G) vs jurisdiction
  workflow (step H).
- **Observed:** the milestone-release approval path releases the tranche
  with NO inspection-requirement determination on record, and a RELEASED
  milestone's gate surface collapses (the documented RELEASED
  short-circuit, `completionGates.evaluateDrawEligibility`). A draw billing
  that milestone then evaluates READY although whether a government
  inspection was even required was never determined. On HELD milestones the
  doctrine holds exactly (INCOMPLETE, proven in the rehearsal).
- **Expected:** the "UNKNOWN never behaves as NOT_REQUIRED" boundary should
  not be avoidable by releasing the tranche first.
- **Repro:** launch a template project (no determinations exist), submit +
  dual-approve evidence for a milestone, then create a draw billing it —
  readiness reads READY with `inspection_requirements` empty.
- **Recommended:** pilot SOP NOW — record the reviewed
  inspection-requirement determination for every milestone during Day-2
  project configuration, before any evidence approval; consider (future,
  with review) surfacing an undetermined requirement in the release
  approval UI or gating release eligibility on the determination.
- **Requires code:** no for the SOP; yes for a platform-level guard
  (doctrine-sensitive — do not change without review).

## P-04 · Draw governance completes over an undetermined requirement — MEDIUM

**Status: OPEN** (works as designed) — the readiness decision gate remains the enforcing boundary; surfacing readiness in the governance panel stays a future refinement.

- **Step:** send-to-governance + dual approvals (step L).
- **Observed:** `POST /api/draws/:id/governance` returns 200 and both
  approvals complete while the billed milestone's requirement is
  UNDETERMINED and readiness is INCOMPLETE. The readiness **decision gate**
  is the enforcing boundary — the rehearsal proved the approving decision
  refuses 422 even fully justified, persisting nothing.
- **Expected:** reviewers might expect governance eligibility to surface
  the unknown earlier than the final decision.
- **Recommended:** none required for the pilot (the boundary holds at the
  decision); consider surfacing the readiness state in the governance
  panel as a future refinement.
- **Requires code:** no (works as designed); yes for the refinement.

## P-05 · Shipped policy allows exception past a REQUIRED government inspection — MEDIUM (policy acceptance)

**Status: ACCEPTED CONDITION** — deliberately unchanged in the corrective pass: the shipped exception-eligibility matrix (GOVERNMENT_INSPECTION exceptionable, documented and preserved) is a pilot policy-acceptance item; per-tenant policy configuration remains future work.

- **Step:** lender decision at HOLD (step M / §8).
- **Observed:** `DEFAULT_READINESS_POLICY.exceptionEligible.GOVERNMENT_INSPECTION
  = true`, so a justified APPROVED over `INSPECTION_NOT_SCHEDULED` /
  `JURISDICTIONAL_INSPECTION_NOT_PASSED` records as a documented
  PROCEEDED BY EXCEPTION (rehearsal-verified: justification required,
  snapshot preserved, blocker stays outstanding, activity shows the
  disposition, the governed record still says REQUIRED with no passed
  inspection).
- **Expected:** some lenders will not want a required government
  inspection to be exceptionable at all.
- **Recommended:** the pilot lender must explicitly accept the shipped
  eligibility matrix at kickoff (per-tenant policy configuration is
  documented FUTURE work); until then treat such exceptions as
  policy-visible business decisions.
- **Requires code:** no (acceptance); yes for per-tenant configuration
  (already on the deferred list).

## P-06 · "Released" appears before the lender decision — MEDIUM

**Status: ACCEPTED CONDITION** — onboarding/training item ("Released" = virtual-account eligibility recorded; the lender decision is a separate governed act). Label copy deferred.

- **Step:** draw approvals (L) → decision (M).
- **Observed:** completing the draw's dual-control approvals immediately
  records the governed release transition; the draw badge reads
  "Released" BEFORE any lender decision exists. "Released" is
  virtual-account eligibility (no money moves — verified), and the
  decision + package follow, but the label invites misreading. Also,
  milestone-scoped readiness fan-outs skip RELEASED draws (terminal), so
  post-release determination/inspection changes update the readiness
  history only when a draw-scoped hook (e.g. the decision) fires.
- **Expected:** lenders read "Released" as funds/decision done.
- **Recommended:** onboarding must explain the term ("release eligibility
  recorded on the virtual project account — the lender decision is a
  separate governed act"); consider label copy later.
- **Requires code:** no (training); cosmetic copy change later.

## P-07 · Draws register "Borrower org" column shows the lender org — MEDIUM

**Status: FIXED** — the register's Borrower-org column now uses the draw's requesting organization, the same authoritative source Draw Review uses.

- **Step:** Draws register (step J surface).
- **Observed:** the register's "Borrower org" column rendered
  "Chesapeake Bridge Capital" (the project's owning/lender organization)
  while the Draw Review header correctly names "Anacostia Restoration
  Builders" as borrower/implementer.
- **Expected:** the column should show the borrower/implementing
  organization.
- **Repro:** open `/draws` on the rehearsal data.
- **Requires code:** yes (small register fix).

## P-08 · Docs overstate draw-document custody ("metadata + SHA-256") — MEDIUM (documentation)

**Status: FIXED** (documentation) — `docs/EXTERNAL_PILOT_READINESS.md` and `docs/PROJECT_HANDOFF.md` now state the verified custody model: draw documents are metadata-only attestations with no bytes and no hash column; integrity hashes exist on adjacent records only. No byte storage was added.

- **Step:** required documents (step E) / custody statements.
- **Observed:** `draw_documents` has **no hash column at all** — draw
  documents are metadata-only attestations (`file_path` null by design,
  no bytes AND no sha256). `docs/EXTERNAL_PILOT_READINESS.md` ("METADATA +
  SHA-256 only") and `docs/PROJECT_HANDOFF.md` (which repeated it)
  overstate. SHA-256 exists on adjacent records only (inspection report
  versions' API-only `documentBase64` → hash, lien-waiver `documentHash`
  string). Field evidence photos DO store bytes (WORM + hash chain,
  rehearsal-verified).
- **Recommended:** correct both documents; state the custody model to the
  pilot lender exactly: evidence photos = bytes held by OBV; draw
  documents = recorded attestations, lender retains originals.
- **Requires code:** no (documentation correction).

## P-09 · Demo affordances visible inside pilot surfaces — LOW

**Status: MITIGATED** — the Reset-demo-data button, /more switch, field-shell switch link, error-page demo link and the field client's DEMO FALLBACK photo/simulated-GPS offers are now posture-gated (server-declared `demoAffordances` flag on `/api/field-context`). Remaining: the server-side pipeline still ACCEPTS a `demoPhotoId` submission in any posture (inert on a declared pilot — demo photos are never seeded there — and always honestly labeled DEMO FALLBACK downstream, but not posture-refused at the API); plus "Select a demo user first" 401 strings and report-missing copy (cosmetic).

- **Observed:** `/overview` renders a "Reset demo data" button in pilot
  (endpoint correctly 404s); the field capture wizard renders DEMO
  FALLBACK zones (empty photo grid in pilot) and offers "simulated site
  GPS (DEMO FALLBACK)" on GPS failure — accepted server-side in any
  posture, though honestly labeled downstream; API 401 text says "Select a
  demo user first"; report-missing copy mentions demo resets.
- **Recommended:** cosmetic posture sweep of demo affordances and error
  copy.
- **Requires code:** yes (cosmetic batch).

## P-10 · pilot:check email-reachability WARN prints a raw config error — LOW

**Status: OPEN** — cosmetic checker copy, unchanged in this pass.

- **Observed:** with the outbox provider active, the WARN line prints a
  truncated internal refusal string ("provider endpoint not reachable from
  here: OBV_EMAIL_PROVIDER=postmark requires OBV_POSTMARK_SERVER_TOKEN…")
  which reads as misconfiguration of the checker rather than of the
  environment.
- **Recommended:** clearer message when the resolved provider is the
  outbox.
- **Requires code:** yes (cosmetic).

---

## What the rehearsal proved working (no friction)

End-to-end without developer intervention: bootstrap → magic-link sign-in →
counterparty orgs → invitations (activation links surfaced once,
credential-redacted at rest) → project from template → geography, approval
matrix, launch → membership chain → real-photo evidence into the WORM store
with hash-chained ledger → dual-control evidence approvals (submitter
excluded) → draw + milestone-mapped lines → derived document checklist →
line review → readiness INCOMPLETE→HOLD→READY through governed records only
→ INCOMPLETE approving decision refused 422 with justification, nothing
persisted → EXCEPTION_REVIEW on a formally recorded exception →
exactly-once ready/no-longer-ready notifications, same-state dedup, zero
writes from page reads → documented proceed-by-exception with snapshot,
preserved blocker and permanent disposition → READY amendment → package ZIP
generation + download → full activity reconstruction → graceful restart
with zero record loss and surviving sessions → verified backup + documented
restore into an isolated instance → tenant 404s, FIELD/submitter refusals,
intact refusal ordering.
