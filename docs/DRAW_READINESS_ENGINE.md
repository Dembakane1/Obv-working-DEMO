# Draw Readiness Engine

Deterministic, explainable readiness for lender review. For every draw, one
answer: **what is preventing this draw from being ready for lender review** —
with the supportable amount, every blocker, and the next action.

**What readiness is NOT.** OBV Readiness is a synthesis of recorded facts.
It is not approval, not funding, not legal compliance, not payment
authorization, and not settlement. The chain of distinct states is:

```
evidence verification ≠ draw readiness ≠ lender approval
                     ≠ release eligibility ≠ settlement
```

The engine may conclude READY FOR LENDER REVIEW. It never approves a draw,
releases money, marks legal compliance, bypasses dual control or exceptions,
overwrites a government record, or treats advisory AI output as authoritative.

---

## 1. Input sources (all pre-existing; the engine adds no new truth)

| Source | Provider | Authority |
|---|---|---|
| Draw, lines, amounts, line reviews (`supportedAmount`, `percentCompleteVerified`) | `draws.ts` / repo | **Authoritative** (reviewer-recorded) |
| Completeness checks (amount, period, lines, reconcile, documents, evidence) | `draws.completeness()` | Authoritative |
| Recommendation reasons (BLOCKER / EXCEPTION / INFO), supported amount | `draws.computeRecommendation()` | Authoritative derivation |
| Document checklist + lien waiver requirements | `draws.documentChecklist()` | Authoritative |
| Milestone gates: contractor completion, evidence review, inspection requirement/gate, permit, code basis, official source | `completionGates.milestoneGates()` + `completionGates.drawReviewSurface()` | Authoritative (reviewed determinations). The engine evaluates gate reasons from `drawReviewSurface()` — the SAME assembly as `evaluateDrawEligibility` WITHOUT the RELEASED short-circuit, so tranche-release bookkeeping never suppresses jurisdictional truth for a later draw review (an UNDETERMINED requirement on a released milestone still resolves INCOMPLETE; the release event itself is never rewritten). Stage semantics stay with the gates module: reason `blocking` flags encode the governance stage, so readiness consumes `completionGates.reasonBlocksDrawReview()` for the draw-review reading and `inspectionSurfaceClean()` for satisfied-inspection claims and the released-milestone surface note — never a local re-derivation. Lines with no milestone mapping surface as a warning (their jurisdictional surface cannot be evaluated), never a silent pass. |
| Jurisdictional inspections (sequence, reinspection, result) | `completionGates` / DMV layer | Authoritative (recorded results) |
| Permits (`effectiveStatus`, UNKNOWN never ACTIVE) | `permits.ts` | Authoritative |
| DMV per-line eligibility (`drawControlRecordView`, read-only) where adopted | `dmvCompliance.ts` | Authoritative — adapted verbatim, never recomputed. The view shares the exact eligibility body with `drawControlRecord`; only the deliberate basis-pin write stays with consequential generation (packages), so readiness reads never write. Reasons already owned by another layer (reviewer line findings, register exceptions — deduped by id, draw-wide dispute holds) stay single-sourced. |
| Open exceptions (severity, status, draw linkage) | `exceptions.ts` | Authoritative register |
| Lender decision + conditions | `lenderDecisions.ts` | Authoritative |
| Draw inspection (lender's independent inspector) | `drawInspections.ts` | Authoritative |
| Verification verdicts (VERIFIED / NEEDS_REVIEW / REJECTED) | evidence pipeline | Authoritative **state**; the AI analysis behind it is advisory — the engine reacts only to the governed verdict |
| Evidence-intelligence signals | `evidenceIntel` | **Advisory only → warnings, never blockers** |

Advisory inputs can only ever produce `warnings[]`. A flagged verification
blocks because the governed verdict is `NEEDS_REVIEW`/`REJECTED` — never
because a raw model score crossed a threshold.

Evidence follows the configured model exactly: draw-level evidence links
are *recommended* (a missing link is a warning), while absent milestone
evidence blocks only where the project **configured required evidence**
(`EvidenceRequirement.required`) — the engine never invents a stricter
requirement than project configuration.

## 2. Readiness states

| State | Meaning |
|---|---|
| `READY` | Every configured required condition is satisfied. Means **ready for lender review** — not approval. |
| `HOLD` | ≥1 blocking requirement is unmet and at least one is not exception-eligible under policy. |
| `EXCEPTION_REVIEW` | Every configured requirement is satisfied **except** formally recorded exceptions awaiting the lender's disposition, and policy permits proceeding past them. Any other outstanding requirement is a HOLD — status describes what is outstanding; whether a documented override may proceed at decision time is a separate, policy-governed axis. |
| `INCOMPLETE` | OBV lacks enough **governed information** to support a readiness conclusion — about the draw itself (draft, cancelled, no lines, structure incomplete) or about the jurisdictional surface. The unknown-information **blocking** reasons are classified centrally (`UNKNOWN_INFO_CODES` / `isUnknownInformation()`): an undetermined inspection requirement (`INSPECTION_REQUIREMENT_UNKNOWN`), a line with no milestone mapping (`LINE_WITHOUT_MILESTONE`; not raised on DMV projects, whose control record evaluates lines by its own line-scoped requirements), a required permit whose authoritative current status cannot be established (`PERMIT_STATUS_UNKNOWN`), and an open permit amendment whose required-inspection scheduling effect has no recorded determination (`AMENDMENT_INSPECTION_EFFECT_UNKNOWN`). Alone they resolve INCOMPLETE — never READY, never a satisfied claim, and the category rolls up `UNKNOWN` — and beside a substantive blocker the draw HOLDs with the unknown still visible. They are never exception-eligible: missing information is resolved through the governed workflows, never waived into existence. |

### Known condition vs unknown information — the jurisdictional doctrine

```
KNOWN FAILURE                       → HOLD   (exception eligibility per policy)
MISSING / UNKNOWN GOVERNED INFO     → INCOMPLETE (never approvable by exception)
```

| Fact | Code | Class | Result alone | exceptionAllowed |
|---|---|---|---|---|
| Required permit missing entirely | `REQUIRED_PERMIT_MISSING` | KNOWN missing control | HOLD | per PERMIT policy |
| Permit DRAFT / APPLIED / CLOSED | `PERMIT_NOT_ACTIVE` | KNOWN recorded status | HOLD | per PERMIT policy |
| Permit SUSPENDED / EXPIRED / REVOKED | `PERMIT_SUSPENDED` / `PERMIT_EXPIRED` / `PERMIT_REVOKED` | KNOWN recorded status | HOLD | per PERMIT policy |
| Permit status **UNKNOWN** | `PERMIT_STATUS_UNKNOWN` | **UNKNOWN INFORMATION** | INCOMPLETE | **false, always** |
| Amendment effect recorded BLOCKED | `PERMIT_AMENDMENT_BLOCKS_INSPECTION` | KNOWN recorded determination | HOLD | per GOVERNMENT_INSPECTION policy |
| Amendment effect **not determined** | `AMENDMENT_INSPECTION_EFFECT_UNKNOWN` | **UNKNOWN INFORMATION** | INCOMPLETE | **false, always** |

"No permit" and "unknown permit status" are different facts and never
collapse: the first is a known missing required control, the second means
OBV cannot establish whether the requirement is satisfied. Where permit
configuration does not gate activity, an unknown status still surfaces as
a warning — never a silent pass.

## 3. Blocker model

Every evaluation returns the full `DrawReadinessResult`:
`status`, `requestedAmount`, `supportableAmount`, `blockingReasons[]`,
`warnings[]`, `satisfiedRequirements[]`, `nextActions[]`, `lineReadiness[]`,
`categories[]`, `evaluatedAt`, `policyVersion`, `inputRefs`.

Each reason: `{ code, category, message, sourceRecordId, lineItemId?, nextAction, exceptionAllowed }`.
Categories: `INTEGRITY, EVIDENCE, BUDGET, DRAW_INSPECTION,
GOVERNMENT_INSPECTION, PERMIT, DOCUMENT, LIEN, EXCEPTION, CHANGE_ORDER,
RETAINAGE, PROJECT_CONTROL`. Category-level rollup: `PASS / HOLD / WARNING /
NOT_APPLICABLE / UNKNOWN`.

**Deterministic primary blocker** (controls concise UI only; all blockers are
always returned), in priority order:

1. `INTEGRITY` (ledger/authorization) — never exceptionable
2. `EVIDENCE` (rejected / needs-review verification, missing required evidence)
3. `GOVERNMENT_INSPECTION` (required jurisdictional inspection not passed / sequence incomplete)
4. `PERMIT` (inactive / unknown where configured blocking)
5. `DRAW_INSPECTION` (lender inspection unresolved)
6. `DOCUMENT` / `LIEN` (missing or rejected required documents; lien waivers)
7. `BUDGET` / `CHANGE_ORDER` (reconciliation failure, unapproved CO billing)
8. `EXCEPTION` (open HIGH/CRITICAL exceptions on the draw)
9. `PROJECT_CONTROL` / `RETAINAGE`

Within a category, order follows the underlying register order (stable), so
identical inputs always produce the identical primary blocker.

## 4. Supportable amount

`supportableAmount` sums `draws.lineSupported` — the exported single
source of the recorded per-line formula, which `lenderDecisions.verifiedAmount`,
`computeRecommendation().supportedAmount` and the draw package all import
rather than re-implement. (The aggregates intentionally differ on a partial
review: `verifiedAmount` stays null until every line carries a review, while
`supportableAmount` is the partial sum, disclosed via `supportBasis` and the
`LINE_REVIEW_INCOMPLETE` blocker.)

```
per line:  SUPPORTED            → currentRequested
           PARTIALLY_SUPPORTED  → reviewer-recorded supportedAmount
           EXCEPTION | REJECTED → 0
           PENDING              → 0  (unreviewed value is never presumed)
supportable = Σ line support
```

Line-level variance is `currentRequested − supported`, with the reviewer's
recorded reason. Verified physical % is **context**, never converted into
dollars — dollars come only from reviewer-recorded line decisions. Retainage is
reported alongside (withheld at governance-finalize), never silently
subtracted; unapproved change-order billing cannot expand support (the line is
flagged and its support comes only from the reviewer's decision). While lines
are unreviewed the amount is reported as *provisional* (`supportBasis:
"PARTIAL_REVIEW"`), because PENDING lines contribute 0 by rule.

## 5. Jurisdiction requirement model (manual-first)

Reuses the existing normalized model — no per-jurisdiction engines:

```
JurisdictionProfile (DC / MD / VA template keys, authority, portal)
  → Permit (effectiveStatus; UNKNOWN never ACTIVE)
    → PermitAmendment (jurisdiction-neutral: the amendment's own recorded
      lifecycle PENDING/APPROVED/REJECTED/WITHDRAWN/UNKNOWN is SEPARATE
      from its inspectionSchedulingEffect BLOCKED/ALLOWED/UNKNOWN — the
      effect is a reviewed jurisdictional determination with basis and
      attribution, never inferred from the word "pending". While an OPEN
      amendment's recorded effect is BLOCKED, a not-yet-passed gated
      required inspection raises PERMIT_AMENDMENT_BLOCKS_INSPECTION
      (HOLD, the deterministic primary — "resolve the amendment, then
      complete the required inspection"); an undetermined effect raises
      AMENDMENT_INSPECTION_EFFECT_UNKNOWN (INCOMPLETE-side, never
      waivable). Resolving an amendment clears ONLY these reasons: the
      required inspection remains its own governed record — resolution
      never passes an inspection, and no historical transition, snapshot
      or audit row is rewritten. Lifecycle contract, enforced centrally:
      amendments are CREATED open (PENDING/UNKNOWN, resolvedAt null) and
      resolve only through the governed update (terminal states carry a
      recorded resolvedAt; reopening is refused; a resolvedAt correction
      is a reasoned, audited change). Every mutation writes an immutable
      config_audit record with the amendment as its governed subject —
      the timeline narrates amendment history from those records, never
      from the current mutable row.)
    → InspectionRequirement per milestone (REQUIRED / NOT_REQUIRED / UNKNOWN,
      reviewed determination with basis + attribution,
      gates: mustPassBeforeDrawReview / mustPassBeforeGovernance,
      permitRequired / permitMustBeActiveBeforeDrawReview…)
      → JurisdictionalInspection (result lifecycle, reinspection chain)
      → DMV LineInspectionRequirement (sequence + prerequisite) where adopted
```

**Governing basis ≠ latest rule.** Each permit carries its own reviewed
governing basis (`applicableCodeEdition`, `codeEffectiveDate`, `codeBasis`,
`codeDeterminedBy/At`, `configurationVersion`) — the project's recorded
applicable basis, which readiness consumes. A transition/grandfather
determination ("plan accepted before the newer edition's effective date —
project remains under the prior rule") is expressed in the existing
`codeBasis` text with full provenance; recording a newer basis on one
project never rewrites another project's recorded basis, and every change
is a separate attributable audit entry (pinned by regression). OBV never
concludes that the latest published rule governs a project, and this
engine never calculates grandfather eligibility — an authorized reviewer
records the determination and its basis.

Requirements are configured/confirmed by authorized humans from reviewed
sources. Official-source retrieval remains
`candidate → human review → recorded requirement/status → engine`. An
unreviewed candidate **cannot** become a readiness-blocking authoritative fact,
and `SOURCE_UNAVAILABLE` / `UNKNOWN` degrade to INCOMPLETE-side outcomes, never
to PASS.

## 6. What the engine explicitly does NOT conclude

The engine never emits "legally compliant", "funding approved", "payment
authorized" or any legal conclusion. Its language is: *configured requirement
satisfied*, *official record reviewed*, *OBV readiness requirement
outstanding*, *human review required*, *ready for lender review*. The lender
and counsel retain legal responsibility. (Asserted by test.)

## 7. Override — proceed by exception

Built on the existing lender-decision workflow (`RECORD_LENDER_DECISION`
capability, submitter excluded, governance truth table intact):

- When an approving-type decision (`APPROVED` / `CONDITIONALLY_APPROVED` /
  `REDUCED`) is recorded while OBV readiness is `INCOMPLETE`, it is **refused
  outright** (422), with or without justification: OBV does not have enough
  governed information to support a readiness conclusion, and missing
  information cannot be waived into existence. Nothing persists — no decision,
  no snapshot, no exception disposition. Once the missing information is
  resolved, readiness recomputes from governed state: `READY` proceeds
  normally, `HOLD` follows the documented-exception rules below.
  Non-approving dispositions (reject, return, clarification, `PENDING`)
  remain governed solely by the pre-existing lender-decision workflow.
- When it is recorded while readiness is `HOLD` or `EXCEPTION_REVIEW`,
  the service **requires explicit justification** (`exceptionsAccepted` or a
  decision reason) — a one-click unlabeled bypass is refused (422) — and
  every outstanding blocker must be exception-eligible: `exceptionAllowed`
  is the one shared invariant (evaluator, decision gate, UI, snapshots), so
  the never-exceptionable reasons — incomplete reviewer work, reconciliation
  failure, and the unknown-information codes — refuse the override regardless
  of justification.
- Every decision persists a **readiness snapshot** (`draw_events` type
  `READINESS_SNAPSHOT`): full result JSON, overridden blockers, requested and
  supportable amounts, policy version, actor, timestamp, decision id.
- **The override never erases the blocker.** The requirement remains
  OUTSTANDING with a lender disposition of PROCEEDED BY EXCEPTION; the UI
  shows both, permanently.

## 8. Audit & history

- **Live readiness** is recomputed deterministically on read — no ledger
  writes on render (that would be audit noise).
- **Snapshots** persist only on consequential events: lender decision
  (always), including proceed-by-exception. Snapshots use the existing
  `draw_events` infrastructure — no second Evidence Ledger.
- **Reproducibility**: every result carries `policyVersion` and
  `evaluatedAt`; a historical snapshot is never recomputed or rewritten when
  current readiness changes.
- **Transitions** are detected at governed mutation points — never on page
  render — through ONE central mechanism: `recordReadinessTransition`
  recomputes live readiness, compares it with the last recorded
  `READINESS_TRANSITION` event and no-ops when the status is unchanged, so
  repeated or overlapping invocations never duplicate an event or a
  notification. Scope fan-outs (`…ForMilestone` / `…ForPermit` /
  `…ForProject` / `…ForException`) route non-draw-addressed mutations to
  only the relevant active draws of the mutated record's own project —
  never another tenant. Notifications fire only on a state change:
  `DRAW_READY_FOR_REVIEW` on any transition to READY;
  `DRAW_READINESS_HOLD` when a READY draw moves to HOLD or
  EXCEPTION_REVIEW (one policy, no new kinds). HOLD→HOLD blocker-wording
  changes produce nothing.
  **Terminal rule (Pilot Gate #2):** a fan-out skips only CANCELLED draws
  and RELEASED draws whose lender decision **has been recorded**. Formal
  governance (release eligibility) is not the lender decision — the
  decision can only follow governance — so a released draw still awaiting
  it keeps transitioning and keeps notifying
  (`lenderDecisions.awaitingLenderDecision`, the one shared predicate, also
  drives the command centre / Executive / register open set).

### Transition coverage — mutation-point audit

`assembleReadinessInput` is the authoritative input map. Every mutation
owner below was audited for whether it can change a readiness STATUS and
whether the central transition mechanism runs after it. Warning-only
inputs deliberately carry **no hook** — warnings never change status.

| Input | Mutation owner (routes) | Can change status | Hook |
|---|---|---|---|
| Draw fields, lines, line reviews, checklist requirements, documents, document reviews, evidence links, lifecycle (submit/return/cancel/…) | `draws.*` via the single `POST /api/draws/:id/<action>` dispatcher | Yes (structure, reconciliation, LINE_REVIEW_INCOMPLETE, REQUIRED_DOCUMENT_*, DMV per-line evidence) | **Central** — one call inside `finishDrawPost`, the same seam every draw mutation already funnels through for stage sync |
| Lender decision | `recordDecisionWithReadiness` (`POST …/lender-decision`) | No status input, but decision-time snapshot + disposition | Hooked (kept — anchors the snapshot) |
| Lien waivers | `createLienWaiver` / `transitionLienWaiver` | Yes on DMV projects (lien EVIDENCE_INCOMPLETE) | Hooked (draw-scoped) |
| Decision conditions | `updateCondition` | No — `DECISION_CONDITIONS_OPEN` is a warning ("blocks funding, not review") | No hook, by design |
| External funding | funding routes | No — not a readiness input | No hook |
| Lender draw inspections | `drawInspections.*` | No — reach readiness only as advisory warnings | No hook |
| Evidence submission + verdict | `processEvidenceSubmission` (`POST /api/evidence`, `POST /api/evidence-drafts/:id/submit`) | Yes (EVIDENCE_NOT_SUBMITTED / REQUIRED_EVIDENCE_MISSING / NEEDS_REVIEW / REJECTED) | Hooked (milestone fan-out) |
| Configured evidence requirements | pilot onboarding (`POST /api/pilot/requirements[…/delete]`) | Yes (flips `requiredEvidenceConfigured`) | Hooked (milestone fan-out) |
| Inspection-requirement determination | `determineInspectionRequirement` | Yes (whole requirement family incl. the UNKNOWN unknown-info blocker) | Hooked (milestone fan-out) |
| Jurisdictional inspections (create / schedule / complete / result / reinspection / cancel) | `completionGates.*` inspection routes | Yes (result recording above all; schedule/complete are state-equivalent and dedup to no-ops) | Hooked (milestone fan-out) |
| Inspection record metadata correction | `correctInspectionRecord` | No — metadata only | No hook |
| Contractor completion | `reportContractorCompletion` | No — code is skipped by the evaluator | No hook |
| Permit create | `createPermit` | No — unlinked permits are readiness-invisible | No hook |
| Permit update / code basis / milestone link | `updatePermit`, `recordCodeBasis`, `linkMilestone` | Yes (PERMIT_*, CODE_BASIS_MISSING, linked-permit set) | Hooked (permit / milestone fan-out) |
| Official source (direct record) | `recordOfficialSource` | Yes (OFFICIAL_SOURCE_MISSING, surface-clean) | Hooked (milestone / permit fan-out) |
| Official-source review queue (confirm / reject / defer / discrepancy / promote) | `officialSources/review.*` | No — permit-scoped or advisory records no eligibility path consumes | No hook |
| Exceptions (create / lifecycle / waive) | `exceptions.*` routes | Yes (OPEN_BLOCKING_EXCEPTION by id) | Hooked (exception-linkage fan-out). The auto-evaluator (`evaluateExceptions`) runs during page reads (and the explicit sweep endpoint / banking reconcile call it with an unscoped affected set) and is deliberately NOT hooked — reads never write transitions and fan-out is never unscoped; sweep-created changes surface at the next governed mutation |
| Evidence-intel promotion | `evidenceIntel review.promote` (`POST /api/evidence-intel/queue/:id/promote`) | Yes — creates a milestone-linked governed exception | Hooked (`afterException` → exception-linkage fan-out). The official-source queue's promote creates a project-only exception no readiness path consumes — no hook |
| Change-order lifecycle | `changeOrders.*` | No — `CHANGE_ORDER_NOT_APPROVED` is a warning | No hook |
| Formal approval decision | `POST /api/approvals/:id/decision` | MILESTONE: yes (release collapses the milestone's ELIGIBILITY to bookkeeping; the engine keeps evaluating the release-independent `drawReviewSurface`, so jurisdiction blockers survive release); CHANGE_ORDER: yes on DMV projects (budget basis for OVER_BUDGET_REVIEW_REQUIRED); DRAW / RETAINAGE: no | Hooked per subject (milestone / project fan-out) |
| Disputes (open / transition / legal hold / resolve / close) | `disputes.*` via dispute routes | Yes on DMV projects (LEGAL_HOLD / DISPUTE_HOLD) | Hooked (`afterHoldMutation` → project fan-out). Dispute sub-records (responses, cures, dispute evidence…) never touch hold posture — no hook |
| DMV basis / line-requirement / cost-to-complete records | `dmvCompliance.*` via compliance routes (`POST /api/permits/:id/basis`, `/api/permit-basis/:id/(finalize\|correct)`, `/api/projects/:id/line-requirements`, `/api/line-requirements/:id/status`, `/api/projects/:id/cost-to-complete`) | Yes (per-line eligibility: basis NOT_READY, INSPECTION_REQUIRED, OVER_BUDGET_REVIEW_REQUIRED) | Hooked (`afterEligibilityMutation` → project fan-out). Transition rules / source verifications are records no eligibility path consumes — no hook |

## 9. Engine design

```
assembleReadinessInput(drawRequestId)   — data retrieval, batched
        ↓ plain data
evaluateDrawReadiness(input, policy)    — pure, deterministic, no I/O
        ↓ DrawReadinessResult
UI / snapshots / notifications          — presentation & persistence
```

`evaluateDrawReadiness` is a pure function over assembled data: no database
access, no clock reads beyond the injected `evaluatedAt`, no HTTP. Identical
inputs produce identical results (asserted by test). Policy defaults live in
`READINESS_POLICY` with `READINESS_POLICY_VERSION`; exception-eligibility per
category is part of the policy, so `EXCEPTION_REVIEW` vs `HOLD` is a
configured, versioned distinction.

## 10. Explicitly unsupported

- Legal compliance conclusions of any kind.
- Automatic approval, funding, settlement, or release.
- Readiness from unreviewed official-source candidates.
- Converting verified-physical % into payable dollars.
- Erasing or downgrading a blocker because a human proceeded past it.
- AI-score-driven state changes (`risk = 0.81 → HOLD` does not exist).

## 11. Control-domain presentation mapping (read-only)

The Draw Review page groups the engine's category rollups into four lender
CONTROL DOMAINS — the Draw Control Scorecard:

| Domain | Categories |
|---|---|
| PHYSICAL | EVIDENCE, DRAW_INSPECTION |
| FINANCIAL | BUDGET, CHANGE_ORDER, RETAINAGE |
| COMPLIANCE | GOVERNMENT_INSPECTION, PERMIT |
| DOCUMENTS | DOCUMENT, LIEN |
| *(cross-cutting, outside the domains)* | EXCEPTION, PROJECT_CONTROL, INTEGRITY |

The domains are EXPLANATORY, not total: no category belongs to more than
one domain, and cross-cutting categories are deliberately outside all
four — a formal exception can concern any subject, a dispute/legal hold
is not a financial control, integrity spans the whole record. They stay
fully visible through `crossCuttingControls(result)` (a compact summary
so four healthy domains can never silently coexist with a blocked draw)
and through the Governed Blockers panel, which with final readiness
remains their authoritative presentation.

`controlDomains(result)`, `crossCuttingControls(result)`,
`supportCoverage(result)` and `formatSupportCoverage(coverage)` in
`drawReadiness.ts` are pure reads over an already-computed result. Domain
state is the worst member state (HOLD > UNKNOWN > WARNING > PASS > N/A —
missing information never reads healthy). Support coverage is
`supportableAmount / requestedAmount` — supported **dollars**, never a
readiness percentage — and its display rule never overstates: "100%" is
shown only for exact full support, values below one are floored to one
decimal (99.96% → "99.9%"), and an inconsistent >1 anomaly is preserved,
never clamped healthy. None of these feed back into evaluation, the
status contract, the decision gate, or snapshots. There is no composite
0–100 score anywhere: the scorecard is a grouping, not a grade.
