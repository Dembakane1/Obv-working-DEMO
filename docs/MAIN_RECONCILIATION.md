# Main Branch Reconciliation + Hardening Recovery

Date: 2026-08-08.
Starting point: `main` at `3ffbe5af34174d376b98fae606781c778e4e3236`
(the merge of PR #17, Lender Pilot RC1). Default branch: `main`
(verified via the GitHub API). Open pull requests at start: none.
Work branch: `claude/obv-main-reconciliation`.

This milestone added no product features. It reconciled every remaining
branch against `main`, recovered banking hardening that had been lost on
a stale branch, rebuilt the VAM adversarial suite against the current
architecture, and audited the repository for presence, security,
cleanliness and CI safety.

---

## 1. Branch audit

Ahead/behind is measured against `origin/main` at the starting SHA.
Every disposition below was verified by reading the ACTUAL diff or the
actual absorbed content in `main` — not by trusting stale PR
descriptions.

| Branch | Ahead | Behind | Disposition |
|---|---:|---:|---|
| `claude/obv-vam-postmerge-audit` | 8 | 87 | **RECOVERED** (three banking defects + adversarial suite re-implemented; rest superseded — see §2) |
| `claude/obv-pilot-readiness` | 4 | 52 | **INTENTIONALLY_NOT_PORTED** (PilotOps platform) + **NEEDS_FUTURE_WORK** (operations docs — see §3) |
| `claude/obv-control-intelligence-enterprise` | 1 | 134 | **INTENTIONALLY_NOT_PORTED** — superseded by current command-center/intelligence architecture (see §4) |
| `claude/obv-design-v2` | 1 | 7 | **SUPERSEDED** — its unique commit is the pre-amend version of the mobile More-page fix already in `main`; the only content `main` lacks is a junk screenshot at `undefined/shots3/mobile-more.png` |
| `claude/obv-project-timeline` | 1 | 18 | **SUPERSEDED** — unique commit `aa561ff` (34 review fixes) was cherry-picked to `main` as `e45cc87` via PR #13; `git diff` of the timeline services against `main` is empty; every other difference is `main` having evolved past the branch |
| `claude/obv-demo-repo-structure-t0hjsc` | 0 | 75 | **ALREADY_IN_MAIN** |
| `claude/obv-dispute-management` | 0 | 80 | **ALREADY_IN_MAIN** |
| `claude/obv-dmv-draw-control` | 0 | 59 | **ALREADY_IN_MAIN** |
| `claude/obv-frontend-reconstruction` | 0 | 116 | **ALREADY_IN_MAIN** (stale Render preview service pinned to this branch removed from `render.yaml` — see §7) |
| `claude/obv-lender-main-integration` | 0 | 105 | **ALREADY_IN_MAIN** |
| `claude/obv-lender-pilot-domain-completion` | 0 | 120 | **ALREADY_IN_MAIN** |
| `claude/obv-portfolio-intelligence` | 0 | 53 | **ALREADY_IN_MAIN** |
| `claude/obv-vam-foundation` | 0 | 88 | **ALREADY_IN_MAIN** |
| `gpt-5.6/obv-frontend-reconstruction` | 0 | 138 | **ALREADY_IN_MAIN** |

"Ahead: 0" branches were additionally spot-verified: `git diff` against
`main` shows only content `main` gained later — nothing on the branch is
missing from `main`.

---

## 2. P0 — recovered VAM post-merge hardening

`claude/obv-vam-postmerge-audit` carried 8 unique commits (merge-base
`50d2943`). Its CI, unified-runner and deploy-check work had been
independently rebuilt richer in `main`, and of its four banking-layer
fixes only the settled-path lockstep guard had been absorbed. The three
missing defects were re-implemented against the CURRENT architecture
(not merged, not cherry-picked wholesale — the branch is 87 commits
stale):

### Defect A — provider event identity collision
`src/server/services/banking/mockProvider.ts`. An `eventId` is now
permanently bound to its original identity — normalized event type +
provider transaction reference — recorded as the mock-bank book entry's
`entryType`. An identical replay stays an idempotent duplicate; reusing
the id for a DIFFERENT transaction or event type is an explicit 409
(`BankingProviderError`) that mutates nothing. The seeded book entry
(`mockled-2`) now carries the same identity shape `processWebhook`
writes, so seeded-event replays remain idempotent.

### Defect B — payment-instruction idempotency race
`src/server/services/banking/paymentInstructions.ts`. Idempotency-key
lookup and duplicate/conflict decisions moved INSIDE
`brepo.withBankingTx` (the banking write lock): an identical replay
returns the original instruction; a conflicting replay (same key,
different parameters) is a controlled 409 with zero mutation. The
schema-level `idempotency_key … UNIQUE` constraint remains as a
backstop, and a constraint violation surfaces as the SAME controlled
409 — never a raw SQLite error.

### Defect C — provider-event transaction/instruction divergence
`src/server/services/banking/paymentInstructions.ts`. For
`payment.failed`, `payment.returned` and `payment.reversed`, the
transaction transition, instruction transition, balance arithmetic,
audit events and the mock bank's book move in LOCKSTEP inside one
banking transaction: if the instruction cannot make the matching
governed transition, the ENTIRE event — including the already-applied
transaction transition — rolls back. Proven byte-identically in the
adversarial suite with sha256 snapshots over every row of every banking
table before and after each refused event. (The `payment.settled` path
already had this guard in `main`.)

### Not recovered from this branch (superseded in main)
- `99f059e`, `058bde0` (CI workflow): `main`'s CI was rebuilt
  independently and is richer (concurrency groups, pinned Node via
  `.node-version`, two-job layout).
- `7aca4d0` (unified runner): `main`'s `scripts/run-all-tests.js`
  supersedes it (standalone + server-based phases, hermetic data dirs).
- `b9f0627` (deploy safeguards/disclosures): `main`'s
  `scripts/deploy-check.js`, Render blueprint and startup disclosures
  cover the same ground against the current architecture.
- `9ffe5cf` (docs): described the old branch's code; the recovered
  behavior is documented here and in `docs/vam/`.

---

## 3. `claude/obv-pilot-readiness` review

The branch adds a ~6,800-line "PilotOps" platform (onboarding, user
admin, notifications, email outbox, integrations seams, operations/
backups, success tracking, demo data generator, internal operator
console, 123-checkpoint suite) plus eight administrator guides.

**Platform code: INTENTIONALLY_NOT_PORTED.** Since that branch stalled,
`main` independently gained the Production Identity platform
(invitations, one-time activation links, sessions, production startup
gates), the Integrations Platform (webhook seams, deliveries,
notifications) and RC1 pilot notification wiring. Restoring PilotOps
would graft a second, conflicting admin/identity/notification stack
onto `main`.

**Operations documentation: NEEDS_FUTURE_WORK.** The eight guides
(ADMINISTRATOR, API, DISASTER_RECOVERY, INTEGRATION,
ORGANIZATION_SETUP, PILOT_DEPLOYMENT, SUPPORT, USER) document PilotOps
endpoints and tables that do not exist on `main`
(`/api/internal/backups`, `pilotOps/operations.ts`, `backup_records`…).
Porting them verbatim would document phantom features. The OPERATIONAL
DOCTRINE in them is worth carrying into a future operations milestone,
rebuilt against whatever is actually implemented then — in particular:
- backups via `VACUUM INTO` with recorded SHA-256, read-only
  verification (`PRAGMA quick_check`) and scheduled recovery TESTS;
- **no in-app restore path, ever** — restore stays a documented human
  operation;
- retention dates recorded but files never auto-deleted;
- the support/severity model and the plain-language user guide format.

---

## 4. `claude/obv-control-intelligence-enterprise` review

One unique commit (2,310 lines): a read-only "Control Intelligence"
service with a five-level precedence ladder (BLOCKED > AT_RISK > WATCH
> DATA_INCOMPLETE > HEALTHY), surveillance rows, control actions, draw
exposure, gate matrices and capacity indicators, plus a dashboard and a
420-line suite.

**INTENTIONALLY_NOT_PORTED — superseded by the current
command-center/intelligence architecture.** Verified against actual
code, `main` already provides this territory: `services/intelligence.ts`
(deterministic signals, documented ATTENTION_RULES, recommended
actions), `services/portfolio/` (risk engine, aggregation, forecasts,
fraud signals, snapshots — the Executive Command Center),
`services/pilot/lenderPilot.ts` (deterministic Next Action engine,
pilot command center), plus completion gates and the unified exception
register. Porting the branch would add a parallel, overlapping health
engine and a fourth dashboard with no new governed capability. Its two
genuinely distinctive ideas — the strict documented precedence ladder
and reviewer-capacity indicators — are recorded here for a future
intelligence iteration if wanted.

---

## 5. Platform presence audit (§8 of the task)

All 37 required platforms verified PRESENT on this branch by their
authoritative artifacts (service module + suite + doc where
applicable): lender draw workflow; Lender Pilot RC1; deterministic Next
Action; Pilot Command Center; golden demo project; draw verification;
evidence capture; Evidence Ledger; approvals/dual control; lender
decisions; lien waivers; independent inspections; governing permits;
DMV draw control; jurisdictional inspections; official-source review;
disputes/release holds; unified exceptions; budget vs verified
progress; change orders; retainage; draw verification packages; project
audit packages; VAM mock banking foundation; reconciliation controls;
Portfolio Intelligence; Evidence Intelligence; Production Identity;
Integrations Platform; Project Timeline; Digital Twin; enterprise
design system; mobile navigation parity; multi-tenant authorization;
same-404 protections; deployment checks; authoritative unified test
runner.

---

## 6. Security / authorization regression pass (§9)

Each control maps to executable evidence that ran green in the full
battery on this branch:

| Control | Evidence |
|---|---|
| Tenant isolation | authorization suite; vam-adversarial cp 46 (cross-tenant object guessing → same 404, 6 routes) |
| Same-404 | authorization + identity suites; vam-adversarial cp 46 |
| Role / capability authorization | authorization suite; vam-adversarial cp 47 (view-only capability cannot mutate, 5 routes → 403) |
| CSRF | identity suite (anti-login-CSRF confirmation cookie; per-session CSRF tokens with rotation) |
| Identity/session revocation | identity suite (suspension refuses sign-in; session rotation/expiry; revoked sessions refused) |
| Dual control / submitter cannot approve own payment | vam suite; `paymentInstructions.ts` creator-cannot-finally-approve + draw-submitter-cannot-approve guards (403) |
| Approval ≠ settlement | vam-adversarial cp 17 ("approval never settles and never moves funds"); TRUST_NOTE asserted at cp 50 |
| Lender decision separate from verification | lender suites; stale-decision revalidation cps 40–45 |
| Advisory intelligence cannot mutate | intelligence/portfolio/evidence-intel suites (read-only modules; no write imports) |
| Official sources cannot auto-change authoritative records | official-sources suite |
| Timeline cannot widen permissions | timeline suite (gated collectors) |
| Digital Twin cannot mutate | twin suite (GET-only routes) |
| Notification failure cannot change workflow | integrations suite (delivery failures recorded, never block governed transitions) |
| Banking mock-only without explicit production config | vam-adversarial cps 5–11: non-mock provider refuses startup; production posture refuses startup without `OBV_SESSION_SECRET`; passwordless switcher disabled (404); demo simulation surface refused even authenticated (403) |
| Provider events are the only settlement truth | vam + vam-adversarial suites throughout; no OBV approval path reaches settlement state |

The reconciliation work WIDENED coverage (two new production-posture
walls, defect A/B/C pins); no existing assertion was weakened. The two
adapted assertions in the adversarial suite are documented in §8 below.

---

## 7. Repository cleanliness audit (§11)

Findings on `main` + this branch:

- **No junk found**: no `undefined/` directories, no `*.log`/`*.tmp`/
  editor backups, no generated databases, no committed secrets or API
  keys (deploy secrets are `sync: false`/`generateValue` in
  `render.yaml`; `.env.example` holds placeholders only).
- **Tracked `node_modules/@types` + `node_modules/undici-types` are
  INTENTIONAL** — vendored type stubs, documented in `.gitignore`
  itself ("node_modules is ignored EXCEPT the vendored type stubs").
  Left in place. After a fresh `npm ci`, `git status` on them stays
  clean (the pinned versions reproduce the same files).
- **`docs/reconstruction/{before,after,preview}/*.png` are
  INTENTIONAL** — before/after evidence for the frontend-reconstruction
  milestone, referenced by its completion report. Left in place.
- **Removed: the stale Render preview service** in `render.yaml` that
  deployed `claude/obv-frontend-reconstruction` (a branch 116 commits
  behind and fully merged). It would have deployed an ancient UI and
  blocked that branch's retirement. This is the only cleanup this
  milestone performed.
- The junk file `undefined/shots3/mobile-more.png` exists ONLY on the
  stale `claude/obv-design-v2` branch, never on `main`.

---

## 8. Rebuilt VAM adversarial suite (§4 of the task)

`scripts/vam-adversarial-test.js` — 59 checkpoints, registered in the
unified runner's standalone phase, isolated servers on :3320 (demo) and
:3321 (production mode) with a pre-flight guard that refuses to run if
a foreign process already answers on a suite port.

Rebuilt from the stale branch against CURRENT `main`, not blindly
copied. Coverage: static boundary sweeps (no network paths, no
credentials, no direct SQL in routes); non-mock provider startup
refusal; production-mode identity walls; full payment-instruction and
transaction transition matrices; duplicate vs conflicting provider
events; idempotency replay and race; exactly-once restoration
accounting (failure/return/reversal/cancellation); stale
decision/condition/exception revalidation; reconciliation-mismatch
blocking; cross-tenant guessing (same-404); view-only capability;
masked identifiers in HTML, JSON and package registers; demo-only
enforcement; and the §2 defect pins with byte-identical snapshots.

Necessary adaptations (architecture drift, intent preserved or
strengthened — nothing weakened):

1. **Production-surface probes**: the old suite signed into the
   production-mode server through the demo role switcher. The Identity
   Platform (added after the audit branch) DISABLES that switcher under
   production posture — asserting it would now be asserting a security
   hole. The suite now proves TWO independent walls: (a) production
   posture disables `/api/session` entirely (404, no cookie) and
   refuses anonymous banking calls (401, zero mutation); (b) with the
   code-supported `OBV_DEMO_AUTH=1` override used as a test-only key
   past wall (a), an AUTHENTICATED user is still refused the demo
   simulation surface (403, zero mutation) and demo controls are hidden
   from the workspace. It also asserts production startup REFUSES to
   boot without `OBV_SESSION_SECRET`.
2. **Workspace disclosure copy**: the old page-level banner ("Demo
   financial simulation…") was replaced in Design v2 by per-control
   "Demo simulation only" badges plus the trust note. The checkpoint
   now asserts the badges, their "No real money exists or moves" text,
   AND the trust note's "a payment instruction is not proof of payment
   / only a provider-confirmed settled bank transaction represents
   completed movement of funds."

There is no path in which an OBV approval creates settlement truth:
approval-never-settles, submit-requires-approval, settle-requires-
submission and event-only settlement are each individually asserted.

---

## 9. CI + main safety (§12)

Verified on this branch:
- `.github/workflows/ci.yml` targets `pull_request: branches: [main]`
  and `push: branches: [main]`; runs `npm ci` then `npm test` (the
  authoritative unified runner) on the pinned Node from `.node-version`.
- `package.json` `test` = `node scripts/run-all-tests.js`.
- `render.yaml` production service tracks `branch: main`.
- Default branch is `main` and was NOT changed.

**Remaining manual GitHub settings (cannot be configured from this
environment — repository-settings writes are blocked at the proxy, as
recorded in PR #2):**
- Branch protection for `main` (require the CI check + pull requests
  before merging, disallow force pushes) must be enabled in GitHub →
  Settings → Branches.
- Branch DELETION also does not work through this environment's git
  proxy (pushes of `:branch` no-op silently) — the retirement table in
  §10 is therefore instructions for a human, per the task's "do not
  delete branches yet."

---

## 10. Branch retirement table (§13 — for the PR; no branches were deleted)

| Branch | Recommendation | Reason |
|---|---|---|
| `claude/obv-demo-repo-structure-t0hjsc` | SAFE TO DELETE | 0 ahead — fully contained in `main` |
| `claude/obv-dispute-management` | SAFE TO DELETE | 0 ahead |
| `claude/obv-dmv-draw-control` | SAFE TO DELETE | 0 ahead |
| `claude/obv-frontend-reconstruction` | SAFE TO DELETE | 0 ahead; stale preview deploy config removed in this PR |
| `claude/obv-lender-main-integration` | SAFE TO DELETE | 0 ahead |
| `claude/obv-lender-pilot-domain-completion` | SAFE TO DELETE | 0 ahead |
| `claude/obv-portfolio-intelligence` | SAFE TO DELETE | 0 ahead |
| `claude/obv-vam-foundation` | SAFE TO DELETE | 0 ahead |
| `gpt-5.6/obv-frontend-reconstruction` | SAFE TO DELETE | 0 ahead |
| `claude/obv-design-v2` | SAFE TO DELETE | unique commit superseded by the amended fix in `main`; only novel content is a junk screenshot |
| `claude/obv-project-timeline` | SAFE TO DELETE | unique commit's content cherry-picked to `main` (verified by empty content diff of the timeline layer) |
| `claude/obv-vam-postmerge-audit` | SAFE TO DELETE **after this PR merges** | its three unabsorbed fixes + suite are recovered by this PR; everything else superseded |
| `claude/obv-control-intelligence-enterprise` | FUTURE REFERENCE (keep or export) | intentionally not ported; precedence-ladder + capacity-indicator ideas may inform a future intelligence iteration |
| `claude/obv-pilot-readiness` | FUTURE REFERENCE (keep or export) | operations doctrine in its guides feeds a future operations milestone; platform code intentionally not ported |
| `claude/obv-main-reconciliation` | KEEP | this PR's branch |

---

## 11. Test results from a clean state (§10 of the task)

<!-- BATTERY_RESULTS -->

---

## 12. Remaining external-pilot blockers (pre-existing; separate from reconciliation)

Unchanged by this milestone and deliberately NOT claimed fixed:

1. **Production email delivery** — sign-in/invitation links use the
   file outbox (`OBV_AUTH_LINK_DELIVERY=file`) or off; no SMTP/provider
   integration exists.
2. **Per-user notification routing** — integrations deliver to
   configured seams (Teams webhook, outbox), not per-user channels.
3. **Persistent storage on the demo host** — the free-plan disk is
   ephemeral; restarts reseed. Paid disk + `OBV_DATA_DIR` documented in
   `render.yaml`.
4. **Backups + restore drill** — no backup tooling on `main` (the
   PilotOps implementation was not ported); operations milestone work.
5. **Deployment verification against a real host** — `deploy-check.js`
   validates configuration, but no live production deployment was
   exercised from this environment.
6. **Live integrations disabled by default** — AI verification, Teams,
   WhatsApp run in mock/disabled modes without explicit keys.
7. **Banking is intentionally not connected** — the mock provider is
   the only enabled provider; non-mock adapters are disabled boundaries
   that refuse every call. This is a safety posture, not an oversight.
8. **GitHub branch protection** — manual setting, see §9.
