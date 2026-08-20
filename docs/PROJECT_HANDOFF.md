# OBV — Project Handoff

**Purpose.** This is a *navigation and continuity* document. It exists so a
future engineer — or a Claude session with **zero conversation history** —
can pick up OBV from this repository alone without architectural drift.

It is deliberately NOT a second specification. Where an authoritative design
document already exists, this file points at it instead of restating it.
If this file and the code ever disagree, **the code wins** — and this file
should be corrected.

**Fresh-session bootstrap:**

1. Pull the latest `main`.
2. Read this handoff.
3. Read the authoritative topic document for the task (§16 maps them).
4. Inspect the current implementation and tests before editing anything.
5. If the docs and the code disagree, **the code wins** — and the docs should
   be corrected.

**Reconstructed from:** `main` at `d95fd3fbf8933186ce8248384206b4be2020bcc0`
(merge of PR #24). Verified against source, tests, `.test-logs/summary.json`,
git merge history and the existing `docs/` set. Sections are marked
**CURRENT** (true on this SHA), **DEFERRED** (deliberately not built) or
**FUTURE** (direction only, not started).

---

## 1. What OBV is — CURRENT

OBV is a **construction draw-control and verification platform for lenders.**

For any construction draw it answers, deterministically:

- what amount is **currently supported**
- whether the draw is **ready for lender review**
- **what** is blocking it
- **why** it is blocked
- **what must happen next**
- **what decision the lender ultimately made**

…while preserving the governed evidence and audit trail behind every one of
those claims.

**First commercialization path:** US construction / rehab / private lending,
with initial emphasis on **DC / Maryland / Northern Virginia (DMV)**.

**Do not position OBV primarily as "AI for construction draws."** AI is
**advisory** unless an existing governed workflow explicitly turns a
human-reviewed result into authoritative state. A model score never blocks a
draw; a recorded governed verdict does.

> ⚠️ **Known doc drift.** `README.md` still opens with the earlier, broader
> framing ("the truth layer for physical projects… Prompt 0 demo build",
> aimed at infrastructure funders / development banks). That text predates
> the lender-pilot positioning above and has not been rewritten. Treat this
> section as the current product definition; the README is accurate about
> *how the system works*, stale about *who it is for*.

---

## 2. Core governance doctrine — CURRENT, must not be violated

This separation is the product. It is enforced in code and asserted by tests:

```
Evidence verification
  ≠ Draw readiness
    ≠ Lender approval
      ≠ Release eligibility
        ≠ Settlement / movement of money
```

- OBV **never** turns readiness itself into lender approval.
- OBV **does not move real lender funds** (see §9).
- **Human lender authority remains separate** — a separate governed act,
  behind capability checks, separation of duties and dual control.
- **UNKNOWN information is never silently converted into VERIFIED / PASS /
  READY.**
- Screens never say "Legally compliant", "Funding approved" or "Payment
  authorized" — asserted by `scripts/draw-readiness-test.js`.

---

## 3. Draw Readiness Engine — CURRENT, final contract

**Milestone complete: PR #24** (merged as `d95fd3f`).
Authoritative design: **`docs/DRAW_READINESS_ENGINE.md`**.
Implementation: `src/server/services/drawReadiness.ts`.

### 3.1 States

| State | Meaning |
|---|---|
| `READY` | All configured required information/conditions necessary for lender review are satisfied. Means **ready for lender review only.** |
| `HOLD` | One or more **substantive** requirements are outstanding. |
| `EXCEPTION_REVIEW` | An otherwise-ready draw carries formally recorded exception conditions that may be dispositioned through the governed lender exception path. |
| `INCOMPLETE` | OBV lacks enough **governed information** to support a readiness conclusion. |

Status resolution lives in one place (`drawReadiness.ts`, "status resolution"):
substantive blockers → `EXCEPTION_REVIEW` only if *every* one is an
exception-category, exception-eligible blocker, otherwise `HOLD`; else if any
unknown-information blocker remains → `INCOMPLETE`; else `READY`.

### 3.2 The critical invariant

**INCOMPLETE is NEVER approvable by exception.**

For approving lender decision types — `APPROVED`, `CONDITIONALLY_APPROVED`,
`REDUCED`:

| Readiness | Behaviour |
|---|---|
| `READY` | Normal existing lender decision workflow. |
| `HOLD` | Documented exception **only** when every blocker is exception-eligible **and** explicit justification is recorded. |
| `EXCEPTION_REVIEW` | Same governed documented-exception path. |
| `INCOMPLETE` | **Approving decision refused 422 — even with justification.** Nothing persists: no decision, no readiness snapshot, no proceeded-by-exception disposition. |

Missing information cannot be waived into existence. It is resolved through
the governed workflows (record the determination, record the inspection, map
the line), after which readiness recomputes.

**Non-approving lender actions** (reject, return, request clarification,
`PENDING`) remain governed by their existing workflows — the readiness gate
returns before touching them.

### 3.3 Unknown-information codes

`UNKNOWN_INFO_CODES` (in `drawReadiness.ts`) — currently `DRAW_IN_DRAFT`,
`DRAW_CANCELLED`, `NO_LINE_ITEMS`, `DRAW_STRUCTURE_INCOMPLETE`,
`INSPECTION_REQUIREMENT_UNKNOWN`, `LINE_WITHOUT_MILESTONE` — are **blocking**
reasons that describe missing information rather than a failed requirement:

- alone → `INCOMPLETE` (never `READY`, never a satisfied claim, category
  rolls up `UNKNOWN`)
- beside a substantive blocker → `HOLD`, with the unknown still listed
- all are members of `NEVER_EXCEPTIONABLE_CODES`, so `exceptionAllowed=false`

`exceptionAllowed` is the **one shared invariant** across evaluator, decision
gate, UI, snapshots, tests and docs. What the evaluator marks
non-exceptionable, no decision path may waive.

(An unknown-status **permit** is different: the gates record it as
`PERMIT_NOT_ACTIVE`, a substantive blocker where configuration gates it —
UNKNOWN never behaves as ACTIVE.)

---

## 4. One source of truth — CURRENT, must not be violated

Draw Readiness is a **deterministic synthesis layer over existing governed
records.** It owns no tables and adds no new truth.

It must **NOT** become a parallel: permit engine · inspection engine ·
exception system · lender-decision system · evidence-verification system ·
notification system · compliance/legal engine.

Existing single-source pieces — reuse these, never re-derive them:

| Concern | Owner |
|---|---|
| Jurisdiction-normalized permit / inspection model | `services/permits.ts`, `services/completionGates.ts` |
| Reviewed inspection-requirement determinations | `completionGates.determineInspectionRequirement` |
| Conservative UNKNOWN handling | `completionGates` + `UNKNOWN_INFO_CODES` |
| Completion gates | `completionGates.milestoneGates()` |
| Draw-review stage semantics of gate reasons | `completionGates.reasonBlocksDrawReview()` |
| Satisfied-inspection / released-milestone surface truth | `completionGates.inspectionSurfaceClean()` |
| DMV Draw Control Record / per-line eligibility | `services/dmvCompliance.ts` |
| Read-only control-record view (no basis pins on reads) | `dmvCompliance.drawControlRecordView()` |
| Blocking-exception predicate | `exceptions.isBlockingException` |
| Per-line supported-amount formula | `draws.lineSupported` |
| Lender decisions + refusal ladder | `services/lenderDecisions.ts` |
| Exceptions register | `services/exceptions.ts` |
| Evidence Ledger / `draw_events` | `services/WormEvidenceStore.ts`, `db/repo.ts` |
| Governed notification seam | `notifyGovernedEvent` (integrations) |

**Before adding a predicate or formula, search for an existing one.** Four
private copies of `lineSupported` and a literal copy of the blocking-exception
rule were consolidated in PR #24 precisely because they had drifted.

---

## 5. Supportable amount — CURRENT

Supportable dollars come from **recorded reviewer line decisions**, via the
shared `draws.lineSupported`:

- `SUPPORTED` → `currentRequested`
- `PARTIALLY_SUPPORTED` → the reviewer-recorded `supportedAmount`
- `EXCEPTION` / `REJECTED` / `PENDING` → zero

They are **NOT** inferred from physical completion percentage, an AI score, a
borrower claim, or a raw evidence count. Verified physical % is context and is
never converted into dollars.

**Requested amount and currently supportable amount are separate disclosed
values.** `supportBasis` marks a partial review as provisional.
(`verifiedAmount` on a lender decision intentionally differs: it stays null
until every line is reviewed, while `supportableAmount` discloses the partial
sum.)

---

## 6. Jurisdiction / official-source doctrine — CURRENT

Preserve the **normalized** model. Do not build separate DC / Fairfax /
Alexandria engines. The shape is:

```
Authority → Permit → Requirement → Inspection → Status
          → Official source → Blocking effect → Draw impact
```

- **Reviewed/manual determinations are acceptable for the pilot** and are
  first-class, not a fallback.
- Official-source retrieval candidates do **not** silently become
  authoritative:
  `candidate → human review → governed record → readiness evaluation`.
- A `PASSED` inspection without its reviewed official source is **not**
  claimed as a satisfied requirement.

Authoritative docs: `docs/OFFICIAL_SOURCES.md`, `docs/DMV_DRAW_CONTROL.md`,
`docs/COMPLETION_GATES.md`.

---

## 7. Exception doctrine — CURRENT

Proceed-by-exception preserves, in the readiness snapshot: **actor ·
justification · timestamp · readiness at decision · blocker codes ·
requested/supportable amounts · policy version.**

An exception **NEVER** changes:

- outstanding inspection → passed
- missing evidence → verified
- unknown → known

The underlying blocker **remains outstanding**, and the lender disposition
(`PROCEEDED BY EXCEPTION`) is displayed *alongside* it, permanently.

---

## 8. Historical truth, transitions and notifications — CURRENT

- **Live readiness** recomputes deterministically from current records.
- **Historical** lender decisions and packages preserve what OBV showed at
  the consequential moment. Readiness snapshots (`draw_events` type
  `READINESS_SNAPSHOT`) are **immutable historical records** — never
  recomputed, never rewritten. Asserted by test.
- **Ordinary page reads never write events.** Asserted by test.
- **Transitions occur only on actual governed state transitions**, through
  ONE central mechanism: `recordReadinessTransition` recomputes, compares
  with the last `READINESS_TRANSITION` event and no-ops when unchanged.
  Scope fan-outs (`…ForMilestone` / `…ForPermit` / `…ForProject` /
  `…ForException`) route non-draw-addressed mutations to only the relevant
  active draws of the mutated record's **own project**.

Notification pattern:

| Change | Result |
|---|---|
| `HOLD → HOLD` (wording change) | no transition, no notification |
| `HOLD → READY` | one transition + one `DRAW_READY_FOR_REVIEW` |
| `READY → HOLD` / `EXCEPTION_REVIEW` | one `DRAW_READINESS_HOLD` |
| page refresh | **no readiness write at all** |

No new notification kinds were introduced for readiness beyond
`DRAW_READINESS_HOLD`. The **mutation-point audit table** in
`docs/DRAW_READINESS_ENGINE.md` (§8) lists every governed input, its mutation
owner, whether it can change status, and its hook — including the deliberate
no-hook cases. **Keep that table current when adding a mutation route.**

---

## 9. Custody and payment limitations — CURRENT, state accurately

**OBV does not move real lender funds.** The lender/bank performs actual
settlement. `VirtualAccountService` is a governance/accounting ledger only
(HELD / RELEASED); the banking layer ships a **mock provider** and the
real-provider adapters are disabled boundaries with no SDKs, credentials or
network access. CI forces the mock provider.

**Byte custody differs by artifact class — do not overstate it:**

| Artifact | Custody on this SHA |
|---|---|
| Field evidence photos | **Bytes stored.** Content-addressed WORM store under `DATA_DIR/worm` (create-only), plus the append-only hash-chained Evidence Ledger. |
| **Draw documents** | **Metadata-only attestation records — NO bytes and NO hash** (`file_path` is `null` by design and `draw_documents` has no hash column; `draws.recordDocument`). For pilot 1 the lender retains the originals. Integrity hashes exist on adjacent records only: inspection report versions (API-supplied `documentBase64` is hashed, bytes discarded) and lien waivers (operator-supplied `documentHash` string). Documented in `docs/EXTERNAL_PILOT_READINESS.md` as INTENTIONALLY_DISABLED (bytes). |
| Official-source snapshots, permit source documents | Bytes under `DATA_DIR/uploads`. |
| Generated reports / audit packages | Bytes under `REPORTS_DIR` / `DATA_DIR/audit-packages` (write-once). |

`ObjectClass.IMMUTABLE` is today a **storage policy** (overwrite refused) plus
ledger-based tamper *detection* — it is **not** compliance-mode WORM, and the
code says so explicitly (`services/storage/objectStore.ts`). Do not claim
infrastructure-enforced retention until an adapter provides it.

---

## 10. Security and tenancy — CURRENT, must not be weakened

- Tenant isolation and authorization boundaries are pre-existing and
  asserted; an unrelated organization receives an undisclosing **404**.
- A readiness fan-out must **never** evaluate or mutate another tenant's
  records — fan-outs are scoped through the mutated record's own project.
- **FIELD users cannot invoke lender exception authority** (asserted).
- The existing refusal ladder runs **ahead** of readiness-specific override
  logic: capability 403 → submitter-separation 403 → amount-shape 400 →
  governance truth table 409 → supersede 409 → **then** the readiness gate's
  422 (`beforePersist` hook). Do not reorder it, and do not weaken existing
  400/403/409 behaviour to simplify readiness logic.

See `docs/AUTHORIZATION.md`, `docs/SECURITY_REVIEW.md`.

---

## 11. Workstation UI — CURRENT

Design direction: **institutional lender workstation, not consumer SaaS.**
Dark-first — deep-navy canvas (`#0A101E`, never pure black) with slate
surfaces, electric-blue action and restrained emerald/amber/soft-red
semantics; light is a complete first-class theme, not an inversion. Dense
information, compact controls, multi-panel workspaces, minimal empty space,
clear hierarchy; mobile deliberately *adapted*, not blindly stacked. One
token vocabulary drives both themes and every text token is verified ≥ 4.5:1.
Tokens and rules: `docs/DESIGN_SYSTEM.md`. Navigation source of truth:
`NAV_GROUPS` in `src/server/view/components.tsx`.

| Group | Workspaces (tabs) |
|---|---|
| **Command** | Command Center (Overview · Executive · Analytics) · Projects · Draws |
| **Verification** | Evidence (Review · Intelligence · Official Sources · Ledger) · Site Intelligence (Timeline · Digital Twin · Map/Satellite) |
| **Governance** | Governance (Approvals · Exceptions) · Project Controls (Budget & Progress · Change Orders) |
| **Operations** | Field (Capture · Issues) · Reports · Communications · Pilot (Operations · Setup · Readiness) · Administration (Overview · Integrations) |

Draws and Draw Review incorporate the Draw Readiness Engine (compact **OBV
READINESS** module in the workbench rail; Supported/Readiness columns in the
dense line table).

**Do not redesign already-completed workstation areas without a real pilot
reason.**

---

## 12. Completed milestones — CURRENT (verified from git)

| PR | Merge SHA | Milestone |
|---|---|---|
| #1 | `50d2943` | VAM foundation |
| #3 | `b094b39` | Dispute management |
| #4 | `f483b10` | DMV Draw Control |
| #5 | `bb6a818` | Demo repo structure |
| #6 | `d687d47` | Portfolio intelligence |
| #8 | `2bd9eeb` | Identity platform |
| #9 | `887355d` | Integrations platform |
| #10 | `7b501b5` | Evidence intelligence |
| #11 | `3d2f8e1` | Official sources |
| #12 / #13 | `0291096` / `9821b4f` | Project timeline (+ review fixes) |
| #14 | `a14adec` | Digital twin |
| #15 / #16 | `50b6d76` / `0d5aeb3` | Design v2 (+ mobile nav fix) |
| #17 | `3ffbe5a` | **Lender Pilot RC1** |
| #18 | `b543c4a` | Main reconciliation |
| #19 | `8f344f4` | **External pilot / production hardening** |
| #20 | `6ac18b5` | **Workstation frontend** |
| #21 | `5e699e6` | **Navigation consolidation** |
| #22 | `7fa85f8` | **Cloud-portability hardening** |
| #23 | `7b0b6ad` | **Workstation completion** |
| #24 | `d95fd3f` | **Draw Readiness Engine** (latest merged) |

(PRs #2 and #7 have no merge commit in this history.)

**Verified test state on `d95fd3f`** (from `.test-logs/summary.json`, run on
the byte-identical tree `5c5bf2c` that PR #24 merged):
**48/48 suites, 3,334 checkpoints**, ~254s. Notable suites: `draw-readiness`
171 · `lender` 185 · `dispute` 185 · `workstation-completion` 139 · `dmv` 125
· `cloud-portability` 67 · `authz` 58 · `pilot-acceptance` 32.
`npm audit --omit=dev`: **0 vulnerabilities**.

Run everything with `npm test` (`scripts/run-all-tests.js`). CI
(`.github/workflows/ci.yml`, required check name `ci`) runs `npm ci` + build +
the same `npm test`, with the banking provider forced to mock.

---

## 13. Cloud / deployment direction

**CURRENT (Stage A — the only supported deployment):** one Docker container,
Node 22 + Chromium, SQLite under `OBV_DATA_DIR` on a persistent volume,
Postmark, OBV identity. **No cloud credential is required to run OBV.**
`npm run pilot:check` verdicts a configuration.

**FUTURE (documented, not started):** containers · Postgres · immutable object
storage · managed secrets · monitoring. The `ObjectStore` boundary
(`services/storage/objectStore.ts`) and the dependency inventory in
`docs/CLOUD_PORTABILITY.md` + `docs/POSTGRES_MIGRATION_MAP.md` +
`docs/DEPLOYMENT_TARGETS.md` are the reuse points.

**Do NOT** start Azure migration, Kubernetes work, a Postgres migration or
broad infrastructure rewrites merely because they are future goals. **Pilot
needs come first.**

---

## 14. Next phase — DEPLOY / OPERATE / PILOT VALIDATE

The current major feature milestone is complete. The next phase is **not**
more features.

The question is no longer *"What else can we build?"* It is:

> **"Can a real lender use OBV to review one real construction draw
> end-to-end?"**

Drive the next work from actual friction discovered along this path:

```
Project → Draw → Evidence → verification → permits / inspections
       → supportable amount → readiness → exceptions if necessary
       → lender decision → lender package → audit history
```

Prioritize real pilot blockers over speculative features.
Start from `docs/FIRST_LENDER_RUNBOOK.md`, `docs/PILOT_ONBOARDING_RUNBOOK.md`
and `docs/EXTERNAL_PILOT_READINESS.md`.

### Do NOT build next by default — DEFERRED

Azure migration · Postgres migration · Kubernetes · nationwide permit APIs ·
mining · payment settlement · a general-purpose AI chatbot · CRM · a native
mobile app · another major workstation redesign.

Only if pilot evidence creates a real requirement.

### Remaining older-generation UI surfaces — DEFERRED

These render outside the workstation shell (they do not use `WorkHeader`):

`compliancePages.tsx` (project compliance, draw control) ·
`disputePages.tsx` · `permitPages.tsx` · `pilotPages.tsx` ·
`timelinePages.tsx` · `bankingPages.tsx` · `integrationPages.tsx` ·
`homePage.tsx` (role dashboards, Design v2).

*(Print/PDF documents — `auditCover`, `drawVerificationDoc`,
`executiveReport`, `report` — and `authPages` are intentionally not
workstation surfaces.)*

**Do NOT modernize these merely for visual completion.** Prioritize one only
when it blocks the pilot, a lender must use it, or real user testing shows
substantial friction.

---

## 15. Positioning continuity — CURRENT

OBV should be able to take a lender's real construction draw and show:

- what is supported
- what is blocking it
- why it is blocked
- what has to happen next
- what the lender ultimately decided

…with the governed records behind every claim.

**Avoid legal-compliance claims.** **Never say READY means approved or
funded** — READY means *ready for lender review*, nothing more.

---

## 16. Where to look — authoritative documents

| Topic | Document |
|---|---|
| Draw readiness (states, blockers, decision gate, transition audit) | `docs/DRAW_READINESS_ENGINE.md` |
| Completion gates / inspection requirements | `docs/COMPLETION_GATES.md` |
| DMV draw control + permit/code basis | `docs/DMV_DRAW_CONTROL.md` |
| Official-source connectors + review lifecycle | `docs/OFFICIAL_SOURCES.md` |
| Exceptions | `docs/EXCEPTIONS.md` |
| Draw requests / lender package | `docs/DRAW_REQUESTS.md`, `docs/DRAW_VERIFICATION_PACKAGE.md` |
| Pilot posture (area-by-area readiness) | `docs/EXTERNAL_PILOT_READINESS.md` |
| Pilot operations | `docs/PILOT_ONBOARDING_RUNBOOK.md`, `docs/FIRST_LENDER_RUNBOOK.md` |
| Cloud portability / deployment / Postgres | `docs/CLOUD_PORTABILITY.md`, `docs/DEPLOYMENT_TARGETS.md`, `docs/POSTGRES_MIGRATION_MAP.md` |
| Security + authorization | `docs/SECURITY_REVIEW.md`, `docs/AUTHORIZATION.md` |
| Design system / workstation UI | `docs/DESIGN_SYSTEM.md` |
| Identity, integrations, comms | `docs/IDENTITY_PLATFORM.md`, `docs/INTEGRATIONS_PLATFORM.md`, `docs/COMMUNICATIONS_INTEGRATION.md` |
| Full system reference (broad, some stale framing) | `README.md` |

**Rule for future work:** put detailed implementation rules in the topic
document that already owns them, and keep this handoff a short map. Duplicated
specifications drift apart; a map does not.

---

## 17. Working conventions — CURRENT

- Zero runtime dependencies. Node ≥ 22.5, `node:sqlite`, custom JSX SSR.
  `devDependencies` are build/test toolchain only.
- Build: `npm run build` · full battery: `npm test` · both: `npm run verify`.
- Every milestone lands as **one PR** into `main` with the full battery green
  and CI SUCCESS on the exact head SHA before merge.
- 144 tables in `src/server/db/index.ts`; repositories in `src/server/db/`,
  domain services in `src/server/services/`, HTTP in `src/server/http/`
  (`server.ts` plus per-domain route modules), SSR views in
  `src/server/view/`.
- Test suites are standalone Node scripts in `scripts/`, registered in
  `scripts/run-all-tests.js`; each spawns an isolated server on a fixed port
  and asserts against the database directly.
