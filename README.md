# OBV — OpenBuild Verify

**The truth layer for physical projects.**

OBV is verification and milestone-tracking software for organizations that
release payments against physical project milestones: infrastructure funders,
government project offices, development banks, private lenders, project
managers, compliance reviewers and field engineers.

The core idea, end to end:

> Physical work produces evidence → evidence is verified → verified evidence
> enters a tamper-evident ledger → verification creates a human approval
> request → human governance controls release eligibility → the financial
> layer is a **virtual project account ledger** (no real bank movement in
> this demo).

This repository contains the **Prompt 0 demo build**: one complete, reliable
end-to-end hero loop, tested three times in a real browser, with heavy
production infrastructure mocked behind clean TypeScript interfaces.

---

## Run it

Requires Node.js ≥ 22.5 (uses the built-in `node:sqlite`). The application
has **zero runtime dependencies**; the pinned `devDependencies` are the
build and test toolchain only.

```bash
npm ci            # install the EXACT toolchain from package-lock.json
npm run build     # tsc (server TSX + client TS) + generate PWA icons
npm run seed      # create data/obv.db with the seeded demo project
npm start         # serve on http://localhost:3000
```

Then open **http://localhost:3000** and pick a demo user.

Shortcuts:

```bash
npm run setup     # build + seed (after npm ci)
npm run dev       # build + start
npm run doctor    # environment preflight: node, deps, browser, ports, banking
npm run clean     # remove dist/ and generated public assets
```

### Test it

```bash
npm ci                          # exact toolchain
npm run browsers                # Chromium for the browser checkpoints (once)
                                # (on a bare Linux box: npm run browsers:deps)
npm test                        # build + EVERY suite + deployment checks
```

`npm test` is the complete authoritative validation — the identical command
CI runs. Useful flags:

```bash
npm test -- --list              # show the suite inventory
npm test -- --filter permits    # run only matching suites
npm test -- --continue          # keep going after a failure
npm test -- --verbose           # stream suite output live (still summarised)
npm test -- --skip-build        # reuse the existing dist/
```

Every run writes `.test-logs/` (gitignored): `summary.json` plus the full
transcript of each suite. On failure the runner prints the failing lines,
the log path and the exact command to reproduce that one suite. CI uploads
the same directory as an artifact.

### Dependency policy

| Rule | Where it is enforced |
|---|---|
| Zero runtime dependencies | `scripts/toolchain-test.js` (also scans every `src/` import) |
| Exact version pins, no ranges | `package.json` + `.npmrc` `save-exact` + guard suite |
| Deterministic installs | committed `package-lock.json`, `npm ci` locally, in CI and in Docker |
| No dependency may execute install scripts | `.npmrc` `ignore-scripts=true`; browsers installed explicitly via `npm run browsers` |
| Vulnerability auditing never rewrites code | `npm run audit:prod` (blocking, production surface) and `npm run audit` (advisory); `npm audit fix` is never run |

```bash
npm run audit:prod   # production dependency surface — must stay clean
npm run audit        # full toolchain advisory report (needs registry access)
```

Full reasoning behind every control: **`docs/TOOLCHAIN.md`**.

### Security

`docs/AUTHORIZATION.md` documents the authorization model: the same-404
tenant boundary, service-layer (not route-layer) enforcement, the signed
session mechanism and `OBV_SESSION_SECRET`, and the scoped single-use
render tokens used for PDF generation. `scripts/authz-test.js` proves it
adversarially with real cross-tenant object ids.

`docs/SECURITY_REVIEW.md` records the automated review across SQL
injection, XSS, broken authorization, unsafe file handling, secret
exposure, dependency vulnerabilities and SSRF — what was fixed (each with
a regression checkpoint in `npm test`), and, explicitly, the
authorization gaps that were found and deferred to a dedicated change
rather than folded into a tooling pass.

### Demo users (no passwords — demo user switcher)

| User | Role | Lands on |
|---|---|---|
| Margaret Osei | FUNDER_REP | Portfolio dashboard |
| Daniel Phiri | PROJECT_MANAGER | Portfolio dashboard |
| Amina Ndlovu | COMPLIANCE_REVIEWER | Portfolio dashboard |
| Chikondi Banda | FIELD | Mobile field-capture PWA |

Switch users any time via **Switch user** in the top bar (or `/`).

## Design system v4 (premium institutional redesign)

The frontend was redesigned to read as institutional infrastructure-finance
software (development banks, lenders, project offices, auditors):

- **Tokens**: warm off-white canvas, midnight-navy chrome, one controlled deep
  blue for actions only, deep green / muted amber / controlled red semantics,
  warm hairline borders, 6–10px radii, near-zero shadows, 8px grid,
  tabular-numeral financial display type.
- **Shell**: restrained navy sidebar (left-accent active state, user + role +
  org + switch at bottom, new layered-strata brand mark) plus a top utility
  bar with page context, a persistent DEMO ENVIRONMENT tag, and the user.
- **Overview**: one financial summary band (portfolio / released / held /
  pending-governance value) with dividers and context lines, a compact
  operational status row, and dense portfolio asset rows.
- **Project detail**: command-center header (identity + code left, figures
  right), PROJECT SETUP → FIELD EVIDENCE → VERIFICATION → GOVERNANCE →
  RELEASE lifecycle strip, and a two-column operational overview with a
  sticky side panel (financial state, integrity, risk, next required action).
- **Milestones**: compact lifecycle rows (seq · title · requirement excerpt ·
  tranche/state · EVIDENCE→VERIFIED→APPROVAL→RELEASE pipeline · next action).
- **Approvals**: capital-release decision room — dominant amount-at-stake and
  HELD state, n-of-m progress, consequential "Approve release eligibility" /
  "Reject / return for review" actions, evidence as the evaluated object with
  capture metadata, proof column, audit trail, and a sticky mobile decision bar.
- **Ledger**: institutional evidence register (entry/timestamp/project/
  evidence/verification/actor/hash/prev-hash/integrity) with last-check time.
- **Field PWA**: numbered 01–04 step rail, eligible-milestone highlighting,
  dominant "Capture evidence" action, GPS/online/queued status strip.
- **Status system**: one glyph+text+color component across verification,
  governance (incl. partially approved), financial, and integrity states.
- Verified at 375/390/430/768/1024/1440 px with zero horizontal overflow;
  visible focus states and ≥44px touch targets on mobile navigation.

## What's new in v2 (frontend modernization + approval governance)

The frontend was rebuilt as a modern institutional SaaS shell while preserving
every piece of verification, ledger and financial-control logic:

- **App shell** — desktop sidebar (Overview, Projects, Field Capture, Pending
  Approvals, Evidence Ledger, Reports, Risk & Compliance, AI Insights) with the
  current demo user + switch action at the bottom; mobile gets a bottom
  navigation bar plus a More page. No desktop tables squeezed into phones.
- **Overview** — summary metric cards (portfolio value, released, held, pending
  approvals, verified milestones, flagged evidence), Base44-style project
  cards (progress, budget figures, next milestone), recent-activity feed.
- **Project detail** — tabbed (Overview / Milestones / Evidence / Approvals /
  Ledger / Activity) over the same data.
- **Milestone cards** — EVIDENCE → VERIFIED → APPROVAL → RELEASE pipeline
  stepper makes the current position obvious (e.g. "APPROVAL 1 OF 2").
- **Evidence Panel v2** — organized into Original evidence / Verification
  checks / AI verification result / Proof integrity, with a chain-of-proof
  rail: PHOTO → 3/3 CHECKS PASSED → 0.96 CONFIDENCE → VERIFIED → LEDGER #N →
  HUMAN APPROVAL REQUIRED → FUNDS HELD.
- **Approval workflow completed** (the one backend addition, using the
  Prompt-0 ApprovalRequest/ApprovalRecord model): the Pending Approvals page
  shows amount at stake, verdict, confidence, per-role progress (✓/○), and
  the full evidence panel next to the approve/reject actions. Funder Rep and
  Compliance Reviewer must both approve; on the final approval the
  orchestrator releases the tranche via `VirtualAccountService.releaseTranche`
  (VERIFIED → APPROVED → RELEASED). Rejection returns the milestone to
  PENDING_EVIDENCE. Decisions are role-gated server-side.
- **Evidence Ledger page** — institutional ledger with a "Verify integrity"
  action: CHAIN INTACT or TAMPERING DETECTED AT ENTRY N.
- **Risk & Compliance / OBV Intelligence** — presentation layers over existing
  records. `/insights` is the OBV Intelligence center: summary counts,
  deterministic attention signals, verification/governance/field-risk
  analytics, an explainable project attention table (HIGH/MEDIUM/LOW with the
  documented rule set rendered on the page) and record-grounded recommended
  actions. Every figure traces to stored rows — no generative scoring, no
  fabricated probabilities.
- **Field PWA** — 4-step progress indicator, eligible milestone highlighted
  with status chips and tranche amounts, camera button disabled until the
  stream is live, explicit GPS-acquired state. Capture logic unchanged.
- **Demo reset** — "Reset demo data" on Overview (POST /api/demo/reset)
  restores the seeded state without restarting the server.

## Project Timeline & Site Intelligence (v27)

**The timeline explains the record. It never changes it.** A read-only
visualization and intelligence layer that assembles every governed event
OBV already stores into one chronological project history: pilot launch
and the configuration audit trail, budget lines and change orders,
milestones, permits + governing code + basis versions and corrections,
inspections, evidence capture/upload/verification, Evidence Intelligence
findings and reviewer actions, Official Source retrievals/changes/
decisions, disputes, exceptions, draws + approvals + lender decisions,
payment instructions + provider confirmations, and audit packages. The
layer **owns no tables and performs no writes** — it prepares no SQL,
calls no approval/release/decision/payment path, and its route module
has no POST handler at all (non-GET is refused 405); twenty-one
authoritative tables are proven byte-identical after exercising the
whole surface. Every event carries timestamp, actor, category, type,
project/draw/milestone, the source record, a plain-language explanation,
and an AUTHORITATIVE-or-ADVISORY label. Ordering breaks ties on time,
category, type, then id, so same-millisecond writes never reorder.
It never invents a timestamp: the projects table stores no creation time,
so Story Mode opens with the earliest *recorded* activity and says so,
and recorded future dates (permit expiry, scheduled inspections) render
as "Upcoming — not yet happened" and are excluded from story and
playback. Eight named views, search, date ranges, and week/month/
category/milestone grouping; **Project Story Mode** narrates the project
for non-technical lenders; **draw playback** walks requested → evidence →
review → official sources → inspection → exceptions → disputes → lender
decision → payment instruction → provider confirmation (resolving both
draw→milestone linkages); **executive playback** replays it period by
period; **Timeline Intelligence** raises eight advisory patterns, each
publishing the measurement and threshold behind it and never a decision;
**Site Intelligence** composes fourteen panels plus an executive summary;
the **project map** places evidence only where a real GPS fix exists and
never invents a coordinate; and seven future spatial capabilities (drone,
satellite, LiDAR, photogrammetry, volumetric, BIM, GIS) are declared
interfaces only — all DISABLED, with no imagery retrieved and no vision
analysis performed. Portfolio timeline plus an advisory Project history
band on the Executive command center. All reads are tenant-scoped with
same-404. 157-checkpoint suite (`scripts/timeline-test.js`) — see
`docs/PROJECT_TIMELINE.md`.

## Official Source Connectors Platform (v26)

**Official sources inform the reviewer. They never decide for OBV.** A
secure, provider-neutral connectors layer for government and licensing
systems, built on one lifecycle: official-source retrieval -> immutable
raw snapshot (append-only, SHA-256 hashed, secret-free) -> normalized
candidate (the source's verbatim wording preserved beside OBV's
normalized value) -> explainable match evaluation (EXACT / HIGH /
POSSIBLE / AMBIGUOUS / NO_MATCH / CONFLICT with confidence, reason
codes, fields compared, and differences; ambiguity and conflict are
never auto-linked) -> reviewer confirmation -> authoritative OBV record
**only through the existing governed commands**
(`permits.recordOfficialSource`, `dmvCompliance.recordSourceVerification`,
`exceptions.createManualException`). A connector never approves or
rejects a draw, marks an inspection passed, alters a permit basis,
clears an exception, releases a hold, creates a lender decision or
payment, moves funds, or overwrites history — proven statically and by
byte-identical authoritative tables under retrieval. The DC source map
is classified by ACTUAL access method: Open Data DC datasets (DOB
building permits, Certificates of Occupancy, DLCP Basic Business
Licenses, parcels) behind operator-configured documented endpoints;
DDOT TOPS via its documented Web API (registered license key); DOB
inspections/enforcement and DLCP professional licenses as explicit
MANUAL_VERIFICATION_REQUIRED boundaries (portals are never scraped);
plus a deterministic mock labeled "not a government system". The egress
client allowlists each source's hosts, pins validated DNS resolutions
(rebinding defense), refuses cross-host redirects and embedded
credentials, caps response sizes, fetches uncompressed, and redacts
credentials from every error path. Deterministic change detection quotes
verbatim wording and labels disappeared records UNAVAILABLE — never
inferred revoked. Polling is explicit-request only (rate caps, retries
with jitter, circuit breaker, dead-letter queue, pause) and scheduled
polling refuses until `OBV_SOURCES_POLLING_ENABLE` is set. The
`/official-sources` workspace shows the registry with secret-free config
status, health, freshness labels that never call cached data "live", the
review queue with side-by-side comparison, raw snapshot previews, and
lookup; the Executive command center gains an advisory Official Sources
band; Evidence Intelligence gains advisory SOURCE_* signals.
144-checkpoint suite (`scripts/official-sources-test.js`) — see
`docs/OFFICIAL_SOURCES.md`.

## Evidence Intelligence Platform (v25)

**Evidence Intelligence analyzes the record. It never authors it.** An
explainable, advisory layer that helps a reviewer answer *is this
evidence complete and consistent, does it resemble prior evidence, does
it deserve closer human review* — never *is this automatically fraud*.
It consumes the existing evidence pipeline and draw documents (never a
parallel store) and produces only advisory signals: it never approves a
draw, rejects evidence, releases funds, changes progress, creates an
exception on its own, or overrides a lender decision (statically
asserted, and proven by authoritative tables being byte-identical before
and after analysis). The engine does exact content-hash duplicate
detection across files, projects, and contractors, plus device-pattern
awareness; a metadata engine flags timestamp/GPS/upload-timing
inconsistencies while treating **missing metadata as INFO, never an
accusation**; a provider-neutral OCR framework (deterministic mock active;
Azure Document Intelligence / AWS Textract / Google Document AI as
disabled boundaries) fingerprints documents for reused-document,
duplicate-invoice/permit-number, contractor-name, and total
inconsistencies; and 0–100 completeness/quality/confidence scoring. Every
finding is explainable — why it fired, which records it compared, a
confidence, and a recommended action — with no black-box score. Actionable
findings enqueue to an **Evidence Review Queue** where a reviewer can
acknowledge, dismiss, or **promote** a finding into a governed exception
(through the existing exceptions service and its authorization; promoted
findings can't then be dismissed; every transition is append-only). The
Evidence Intelligence dashboard, review queue, side-by-side duplicate /
metadata / OCR viewer, and evidence timeline carry the advisory notice on
every surface; the Executive command center gains an advisory *Evidence
quality* band. Seven future engines (perceptual hashing, computer vision,
drone, satellite, photogrammetry, volumetric, LiDAR) are provider-neutral
interfaces only — disabled at the database level, no placeholder
algorithms. Three viewer roles may view it (field refused `403`);
everything is scoped by `authz.accessibleProjectIds` with same-`404`
tenant isolation and no cross-tenant peer leakage. Vendor OCR requires
double consent (`OBV_EVIDENCE_AI_PRODUCTION_ENABLE`). 68-checkpoint suite
(`scripts/evidence-intel-test.js`) — see `docs/EVIDENCE_INTELLIGENCE.md`.

## Production Integrations Platform (v24)

**Integrations observe the system of record. They never author it.**
Provider-neutral connections to a lender's daily systems: an email
abstraction (8 message kinds, deterministic templates, development
outbox active; Microsoft 365 / SendGrid / Mailgun / Amazon SES /
Postmark as disabled-boundary adapters, credential-bearing bodies
redacted at rest); Outlook readiness via active RFC 5545 ICS export for
inspections, draw reviews, meetings, and permit deadlines (Microsoft
Graph adapter is a boundary — no Microsoft credentials required);
Adaptive Card 1.5 payload builders for seven Teams event kinds with the
advisory statement baked into fraud/portfolio/summary cards; an
e-signature platform (internal tracking active with pending / signed /
declined / expired lifecycle, guarded one-shot settlement, append-only
trail; DocuSign / Dropbox Sign / Adobe Acrobat Sign boundaries);
EXPORT-only accounting synchronization (CSV active, QuickBooks / Xero /
Sage boundaries — no import path exists, so accounting can never modify
verified evidence); untouched mock-default banking with Unit / Treasury
Prime / Qolo adapter readiness; and a signed outbound webhook framework
(HMAC signatures with replay-bounding timestamps, idempotent enqueue,
atomic claim, exponential backoff, dead-letter queue with audited
requeue, tenant-scoped fan-out). The `/integrations` dashboard shows
providers, status, last sync, failures, retry queue, and health with no
secrets in any view model; every action appends the immutable
`integration_events` audit (provider, operation, actor, organization,
request id, outcome). Vendor selection requires double consent
(`OBV_INTEGRATIONS_PRODUCTION_ENABLE`) and refuses at startup otherwise.
Webhook egress is bounded (loopback / private / link-local / metadata
destinations refused at registration and dispatch), every dashboard
aggregate is tenant-scoped, and credential-bearing email is redacted by
kind rather than caller opt-in. 167-checkpoint suite
(`scripts/integrations-test.js`) — see `docs/INTEGRATIONS_PLATFORM.md`.

## Production Identity Platform (v23)

**One email, one identity. Sessions are revocable rows, not bearer
statements.** Passwordless magic-link sign-in (`/signin`) replaces the
demo role switcher as the production path: durable identities (unique
normalized email, display name, verified-email state, lifecycle status)
link to the existing per-organization `users` rows through
`identity_users`, so authorization, tenancy, and same-404 behavior are
structurally untouched — multi-org membership is simply multiple users
rows behind one identity, with org switching as audited session
rotation. Sign-in links are single-use sha256-hashed tokens (guarded
consume defeats replays even under a race; the GET confirmation page
never consumes, so inbox scanners cannot burn links) with non-oracle
responses everywhere: unknown, throttled, locked, expired, and tampered
attempts are indistinguishable to the caller and fully distinguished in
the append-only `auth_events` audit. Server-side sessions carry idle +
absolute expiry (absolute never extends — rotation inherits it),
trusted-device windows, concurrent-session listing, per-device and
global revocation, constant-time secret verification against hashes at
rest, and synchronizer-token CSRF on every management POST. Brute-force
lockout (email + IP scopes) and issuance throttling are audited.
Invitation acceptance attaches to the durable identity and never
duplicates a user inside an organization; owners administer membership
suspension/restoration/deactivation (live sessions revoked immediately)
and ownership transfer, all same-404 to non-owners. Passwords, SSO
(Entra ID, Okta, Google Workspace, Auth0, Ping, generic OIDC/SAML 2.0),
and MFA/passkeys (TOTP, WebAuthn, FIDO2) exist as readiness
architecture only — DISABLED-constrained registries with no write path
and no active flow. First-admin bootstrap via
`OBV_BOOTSTRAP_ADMIN_EMAIL` acts only on an empty identities table.
156-checkpoint suite (`scripts/identity-test.js`) — see
`docs/IDENTITY_PLATFORM.md`.

## Portfolio Intelligence Platform (v22)

**Every verified project continuously produces intelligence.** The
Executive Command Center (`/executive`) derives portfolio analytics on
demand from verified records — never altering historical records,
evidence, or packages: portfolio overview with distributions by state,
jurisdiction, lender, contractor, inspector, stage, status and risk;
funding/budget utilization; draw-approval and inspection-turnaround
timing; exception/dispute/permit/compliance trends and portfolio growth.
An eight-dimension deterministic risk engine (financial, compliance,
schedule, documentation, inspection, contractor, fraud, operational —
explainable reason codes, documented weights) yields Project Health =
100 − risk and surfaces ELEVATED/CRITICAL projects in an automatic
attention queue. Contractor, inspector, and vendor scorecards resolve
identities from existing records (no entity is ever replaced; government
inspector names stay records-about-inspections, never OBV identities).
Deterministic forecasting (final cost, projected completion, remaining
budget/funding, confidence bands, inspection/permit completion, cash
flow) stays separate from actuals. Fraud intelligence emits advisory
flags only (duplicate invoices, duplicate evidence hashes, rapid budget
changes, suspicious inspection patterns, releases without evidence, cost
anomalies, risk clustering). AI executive summaries (weekly / monthly /
lender briefing) are template-composed from the computed analytics and
always carry the does-not-approve advisory. Multi-lender: every figure
is scoped through `authz.accessibleProjects` with same-404 detail
behavior; append-only `portfolio_snapshots` power the historical series
per tenant. A disabled government-portfolio foundation (gov_* tables,
`status IN ('INACTIVE')`, zero write paths, activation 404s) is
architecture only. Exportable executive PDF via the existing report
pipeline. 142-checkpoint suite (`scripts/portfolio-test.js`) proves the
layer read-only against every primary table — see
`docs/PORTFOLIO_INTELLIGENCE.md`.

## DMV Draw Control Record + Governing Code and Permit Basis (v21)

**A project's current compliance settings never silently rewrite the permit,
code, inspection, or jurisdictional basis that applied when the work was
permitted or reviewed.** The DMV lender-pilot layer adds: immutable,
versioned Governing Code and Permit Basis records (corrections insert new
versions with reason + attribution; the only writes are two guarded
lifecycle transitions), human-determined code-transition rules (never
date-inferred), line-level required official inspections with a 12-status
guarded machine (official results demand a determination role plus official
backing — an OBV field finding never impersonates a government inspection),
append-only manual government-record verifications (documented lookups, no
live integration, no credentials, no scraping), append-only whole-currency
cost-to-complete estimates, draw permit-basis pins (first pin wins — a draw
keeps citing the version that applied at review), and a per-line DMV Draw
Control Record whose transparent evaluator emits explicit reason codes with
a documented precedence ending at **"Eligible for lender review — not
automatically approved."** Eligibility never creates a lender decision,
approval, payment instruction, provider event, or banking change. Draw and
audit packages gain a visible "Governing Code and Permit Basis" section and
as-of-honest DMV registers (`13_dmv_compliance/`); a clearly fictional DC
fix-and-flip demo (`proj-dmv`) seeds the full lifecycle. 117-checkpoint
suite (`scripts/dmv-test.js`) ends with the byte-for-byte banking
non-mutation regression — see `docs/DMV_DRAW_CONTROL.md`.

## Dispute & Release Hold Management (v20)

Construction payment disputes as governed workflow records: a dispute
attaches to an authoritative OBV object (draw, line, milestone, payment
instruction, change order, invoice, retainage release, inspection result,
evidence item), records disputed/undisputed whole-currency amounts without
touching any balance, and pauses **release eligibility** for the affected
draw through the existing payment boundary. Validated state machine (no
silent fallbacks, exactly-once guarded transitions, immutable append-only
timeline), immutable versioned contractor responses, governed evidence with
integrity hashes, cure requirements (display-only overdue; explicit
waive/extend with recorded reasons), dispute inspections (results are
evidence, never verdicts), advisory recommendations (AI-generated content
flagged and human-approved; mandatory disclaimer), legal hold (elevated
removal authorization), recorded external escalation, and authorized
resolutions with separation of duties, a mandatory acknowledgement and full
in-lock revalidation — including the existing release-eligibility gates.
Dispute registers ship inside both the Draw Verification Package and the
Project Audit Package (`12_disputes/`, manifest-hashed). 185-checkpoint
suite (`scripts/dispute-test.js`) ends with a byte-for-byte banking
non-mutation regression across 17 protected tables. OBV is not an escrow
agent and never moves funds — see `docs/DISPUTES_RELEASE_HOLDS.md`.

## Milestone Completion Gates (v19)

**Photographic completion is not legal or contractual completion.** One
ambiguous COMPLETE status is replaced by six separate authoritative
dimensions, all visible at once on every milestone: (1) contractor
completion (REPORTED COMPLETE is a representation — attributable,
audited, never verification), (2) OBV evidence review (derived live from
the governed evidence pipeline; VERIFIED means the OBV evidence policy
only), (3) jurisdictional inspection requirement (UNKNOWN / NOT_REQUIRED
/ REQUIRED — always an attributable determination with a stated basis,
snapshotted with configuration; UNKNOWN never behaves as NOT REQUIRED),
(4) inspection scheduling and (5) inspection outcome (first-class
inspection records; the government inspector is a text identity, the
result is recorded by an attributable lender-side reviewer, and an
uploaded document never becomes PASSED), and (6) draw eligibility — a
deterministic derived state (NOT_ELIGIBLE / ELIGIBLE_FOR_DRAW_REVIEW /
READY_FOR_GOVERNANCE / BLOCKED / RELEASED) with machine-readable reason
codes and plain-language explanations that can never release funds.

A milestone can honestly read: evidence VERIFIED · inspection SCHEDULED ·
draw eligibility BLOCKED · funds HELD. Draw lines show the gates and the
recommendation holds only the inspection-blocked line amount (never the
whole draw); deterministic exceptions cover unknown requirements,
unscheduled/overdue/failed/expired inspections, missing result documents
and inspection-blocked draw lines, reconciling when the authoritative
condition clears; seven grounded intelligence signals follow the same
records. The six gates appear in the Draw Verification Package (PDF
section D2 + milestone-gates.csv + draw-summary.json), the Draw Review
Summary, and the Project Audit Package. Migration is conservative — no
invented contractor reports or inspection history; existing governance
and exactly-once release are untouched. `scripts/gates-test.js`
(35 checkpoints) covers the 22 required cases; see
`docs/COMPLETION_GATES.md`.

---

## Lender Draw Verification Package (v18)

One standardized ZIP per draw answering the lender's questions directly:
what work and budget were approved, how much is requested now, the
cumulative requested/approved/released position, what physical evidence
supports the draw, who reviewed or inspected it, whether permits and
government inspections are current, whether invoices and lien waivers
are complete, what discrepancies remain, who approved it, and what is
supported, retained, held or released. **Requested, supported, approved,
released and retained amounts are independent, labelled figures — never
merged.**

Contents: a lender PDF (sections A–N: decision summary, cumulative
financials, budget-line detail, line reviews, budget-vs-progress,
timestamped evidence, reviewer attestations, permits/inspections,
invoices/lien waivers, discrepancies, approval history, retainage,
integrity, methodology) plus structured CSV/JSON registers with a hashed
manifest. Truthful states throughout: NOT AVAILABLE (never invented),
RECEIVED — PENDING REVIEW (upload is never acceptance), MISSING —
REQUIRED lien waivers flagged prominently, NO FORMAL INSPECTION RECORD,
NOT REQUIRED under current configuration. Reviewer capacities are
distinct (submitter ≠ inspector ≠ reviewer ≠ approver) and come from
formal records only — chat can never appear as review or approval.

Generated from the draw's Governance tab
(`POST /api/draws/:id/verification-package`), stored in the report
registry, and embedded per draw into every Project Audit Package under
`04_draws/DRAW-nnn/` with every file hashed in the audit manifest.
Access mirrors the audit package (institutional roles + tenant, 404
across tenants). `scripts/drawpackage-test.js` (27 checkpoints) covers
the 21 required cases; see `docs/DRAW_VERIFICATION_PACKAGE.md`.

---

## Project Audit Package (v17)

One-click, auditor/funder/regulator-ready export answering: what was the
configuration, what changed, what evidence was submitted, how it was
verified, what exceptions occurred, who approved what, what money state
changed, which change orders were approved, what retainage remains, and
whether the Evidence Ledger is intact. The package is a structured ZIP —
not merely another PDF — that ASSEMBLES and REFERENCES the governed
sources (configuration snapshots, Evidence Ledger, verifications,
approvals, draws, budget, exceptions, change orders, retainage, report
index) without duplicating or rewriting them.

Contents: `manifest.json` (record counts, integrity results, hashed file
inventory, recomputable manifest hash), a human-readable cover summary
PDF (printable HTML when no renderer), and numbered register sections
(`00_project_summary` … `11_reports`). All timestamped registers are
consistent to an explicit **as-of** point. Before a package is READY,
integrity is validated: ledger chain, configuration snapshot hashes,
exactly-once release transitions, approval-record consistency, evidence
object existence. Failures are represented honestly — **READY WITH
INTEGRITY WARNING** — never hidden.

Controls: generation/download restricted to funder rep, project manager
and compliance reviewer with tenant access (cross-tenant → 404); every
generation and download is written to the configuration audit trail;
packages are immutable once READY; regeneration creates a new version
and retains prior versions as SUPERSEDED (still downloadable). Never
included: secrets, invitation tokens, provider credentials, chat
transcripts (communication metadata counts are an explicit opt-in),
evidence media (hashes + protected references instead).
Hardened (v17.1): manifest pins the
ledger head and states the consistency model (creation-time cutoff, no
historical-state overclaim); per-file inventory records kind + record
counts; integrity findings are classified WARNING (availability) vs
CRITICAL (trust chain) vs FATAL (aborts with FAILED — including
mandatory financial reconciliation); raw evidence media is a
role-restricted opt-in (funder rep / compliance only) with sanitized
names, per-copy re-hashing and ORIGINAL/derivative provenance.
`scripts/auditpackage-test.js` (43 checkpoints) covers the 20 required
cases plus the hardening pass; see `docs/AUDIT_PACKAGE.md`.

---

## Change Orders + Retainage Control (v16)

Construction-native change control and retainage discipline that
preserve the existing governed release path. **A submitted change order
changes nothing** — budget, milestones and schedule stay as configured
until every required role approves through the formal ApprovalRequest
path (≥2 distinct roles, one decision per role, no submitter
self-approval, no direct state-edit endpoint). Allocations must
reconcile exactly to the requested amount before submission; the impact
preview is PREVIEW ONLY and writes nothing.

The final approval applies the impact **exactly once, transactionally,
audited**: budget-line `approvedChanges` (scaled to a partial approved
amount when set), planned-date shifts on affected milestones, a new
configuration version + snapshot linked to the change order, and a
`CHANGE_ORDER_APPLIED` audit event. Historic verifications keep their
original policy/config references. Billing a draw line against an
unapproved change order is refused unless explicitly
exception-acknowledged — then held for review with a deterministic
exception and the exact intelligence signal **UNAPPROVED CHANGE COST
INCLUDED IN DRAW**.

Retainage: an audited per-project policy (0–20%, default closeout
conditions) computes withholding transparently at draw finalize —
governance shows gross / retainage / net, and the governed release moves
net while recording the held position exactly once. Release is never
automatic: a condition-gated `RetainageReleaseRequest`
(ALL_EXCEPTIONS_RESOLVED computed live from the exception register) goes
through its own formal approval and releases exactly once (database
UNIQUE constraints). Surfaces: **Change Orders** register/detail, a
retainage panel on **Budget & Progress**, contract/CO/retainage sections
on draw detail + report, and six deterministic intelligence signals.
`scripts/changeorders-test.js` (40 checkpoints) covers the 18 required
cases; see `docs/CHANGE_ORDERS_RETAINAGE.md`.

---

## Unified Exception Management (v15)

One governed operational register for anything preventing clean
progression — NEEDS_REVIEW/REJECTED evidence, missing draw documents,
approval delays, financial-vs-physical variance, high-severity field
issues, overdue clarifications, ledger integrity alerts and integration
failures — WITHOUT replacing the underlying records. An Exception is a
control record that references an authoritative source; the source stays
the truth.

Deterministic auto-creation rules are idempotent (UNIQUE sourceKey at the
database level): repeated evaluation never duplicates, cleared conditions
auto-resolve (SOURCE_CLEARED), recurring conditions reopen, and waivers
are never overturned by the sweep. Resolution is source-aware — Resolve
is refused while the source condition still holds. Waivers require an
authorized lender role (INTEGRITY: compliance reviewer only), a reason,
and a configuration-audit entry — and never rewrite the source. No
exception action can release money.

Surfaces: **Exceptions** register (filters, SLA age states — within
target / due soon / overdue from configurable per-severity targets,
compact mobile cards), exception detail (source panel, timeline, formal
actions), Overview action-queue row, OBV Intelligence overdue-exception
signals + top recommendation, map via source layers, and
EXCEPTION_REFERENCE cards in Communications (chat cannot resolve an
exception). `scripts/exceptions-test.js` (34 checkpoints) covers the 16
required cases; see `docs/EXCEPTIONS.md`.

---

## Budget vs Verified Physical Progress (v14)

A transparent financial-control comparison between money claimed/paid and
physical progress supported by verified evidence — two different
measurements, compared side by side, never merged. Not accounting
software, not forecasting, not an AI prediction engine.

`BudgetLine` cost codes (original budget, approved changes, derived
current budget, paid to date, retainage) map optionally to milestones and
draw line items. Physical progress is deterministic and explainable:
normalized milestone weights (configured weights, else tranche
proportions — source disclosed) × verified completion. Verified
milestones contribute their full weight; measurably partial milestones
contribute only through explicit reviewed `VerifiedQuantity` records
(authorized reviewer + reason + VERIFIED evidence of the same milestone);
unverified evidence contributes nothing, and no percentage is ever
inferred from a photo. Every contribution traces to its evidence item,
verification, policy version and ledger entry ("View evidence basis").

Financial progress comes from real records (budget lines / released
tranches / open draw requests): paid %, claimed % and verified physical %
with deterministic variance states — WITHIN RANGE (≤5 pts), WATCH (5–10),
FINANCIAL AHEAD (>10), PHYSICAL AHEAD, DATA INCOMPLETE — behind
configurable thresholds. The permitted language is exactly "financial
progress is ahead of currently verified physical progress"; the test
suite greps every surface for anything stronger.

Surfaces: **Budget & Progress** (portfolio + per-project control page
with dual-bar comparison, category rollups, budget line register,
methodology panel, audited change control), draw line items showing
financial vs verified per line with advisory **exception candidate**
flags (never auto-rejecting), a Budget vs Verified Progress section in
the Draw Review Summary with methodology disclosure, and five grounded
OBV Intelligence signals. Post-launch budget changes require an explicit
reason and produce an audit entry + configuration snapshot + version
bump. `scripts/budget-test.js` (39 checkpoints) covers the 16 required
cases; see `docs/BUDGET_VS_PROGRESS.md` for the full methodology and
known limitations.

---

## Construction Draw Requests (v13)

A lender-native draw management workflow layered on top of the existing
evidence, verification, approval, ledger and financial-state architecture —
for rehab lenders, private construction lenders, development lenders and
draw administrators.

**Doctrine.** A Draw Request is a REQUEST FOR REVIEW — it does not
authorize money. A reviewer recommendation is ADVISORY — it does not
authorize money. Only the existing formal governance path (an
`ApprovalRequest` with its configured approval matrix, one decision per
role, separation of duties) creates release eligibility, and the release
transition is recorded exactly once through the `VirtualAccountService`
(`draw_account_events` carries a DB-level `UNIQUE(draw, type)`
exactly-once constraint). Draw releases never touch milestone tranche
HELD/RELEASED state.

The flow: borrower/contractor submits a draw (drafts save independently;
line items must reconcile exactly to the requested amount) -> supporting
documents tracked against a configurable checklist (a document on file is
never treated as verified physical progress) -> existing governed evidence
linked by reference (never copied or re-verified) -> authorized reviewers
decide each line (SUPPORTED / PARTIALLY_SUPPORTED / EXCEPTION / REJECTED,
reasons required for anything but full support) -> a deterministic advisory
recommendation explains its reasons (READY FOR GOVERNANCE / HOLD —
DOCUMENTS MISSING / HOLD — EVIDENCE NEEDS REVIEW / HOLD — OPEN
HIGH-SEVERITY ISSUE / PARTIAL SUPPORT / RETURN FOR CLARIFICATION) ->
READY_FOR_GOVERNANCE opens a DRAW-subject `ApprovalRequest` using the
project's approval matrix -> first approval leaves funds HELD; the final
required approval produces exactly one governed release transition.

Surfaces: **Draw Requests** register (Draw # / requested / supported /
exception / retainage / recommendation / governance state / age / next
action; compact cards on mobile), a draw detail workspace (Overview, Line
Items, Evidence, Documents, Exceptions, Review, Governance, Activity), a
per-draw coordination thread ("Approve Draw 1" in chat approves nothing),
grounded Verification Insights signals (awaiting review, missing required
document, requested exceeds supported, cost ahead of verified progress,
pending governance beyond threshold, clarification unanswered, exception
unresolved — no fake predictions), and a printable **Draw Review Summary**
report (PDF via the existing renderer) whose totals come from the same
stored records and which references the Funder Verification Report rather
than duplicating it.

`scripts/draws-test.js` (45 checkpoints) proves the trust model: reviews
and recommendations move no money, chat cannot approve, duplicate
approvals cannot duplicate the release, unrelated tenants cannot see the
draw, and report totals match the database. See `docs/DRAW_REQUESTS.md`
for the lender demo runbook.

## Pilot readiness & customer onboarding (v12)

OBV can now onboard a real customer project — organization, team, project,
geography, milestones, evidence requirements, draw structure, approval
matrix, field assignments — without database editing, and launch it into
the same trust architecture the demo runs on.

> CUSTOMER CONFIGURATION DEFINES THE PROJECT RULES. FIELD EVIDENCE PROVES.
> VERIFICATION ASSESSES. FORMAL GOVERNANCE AUTHORIZES. THE LEDGER RECORDS.
> LAUNCH IS CONFIGURATION ACTIVATION — NEVER PROOF OF WORK.

- **Pilot Setup** (`/setup`) — stage-based workspace: organizations
  (primary + counterparties), team invitations (random one-time tokens,
  sha256 at rest, expiring, revocable; activation link surfaced once —
  mock delivery, no real email), draft projects, editable setup templates
  (road, school, clinic, water, generic), geography (corridor/polygon/
  point with validation; drives the geofence), milestone builder, evidence
  requirement builder (types, min counts, allowlisted media, geolocation,
  recency), draw structure with loud tranche-total reconciliation,
  approval matrix (≥2 distinct roles, FIELD excluded, submitter can never
  self-approve), bounded verification policy (CUSTOMER POLICY vs
  non-overridable OBV integrity rules), field assignments (scope Field
  Capture), CSV import (users/milestones/requirements — transactional,
  preview-first), and a deterministic readiness engine whose blockers link
  to their stages.
- **Launch** — explicit, role-gated, readiness-gated. Creates a hashed
  configuration snapshot, sets ACTIVE, records tranches HELD, opens
  threads. Creates no evidence, no approvals, no ledger entries.
- **Post-launch change control** — material changes require a reason,
  bump the config version, snapshot again, and land in a configuration
  audit trail (separate from the Evidence Ledger). Historic verifications
  keep the policy version they were evaluated under.
- **Pilot Operations** (`/pilot`) — real-record dashboard: evidence,
  verdicts, approvals, funds held/released, issues, clarifications,
  integration health, draft readiness. **Pilot Export Package** — one
  JSON document with configuration, registers, matrices, readiness and
  report index (never tokens or secrets).
- **Demo-reset safety** — "Reset demo data" now restores the seeded R47
  demo while **preserving** pilot data (the append-only ledger is never
  rewritten); a separate, typed-confirmation Development Full Reset wipes
  everything.

Runbook: `docs/PILOT_ONBOARDING_RUNBOOK.md`. Tests: `scripts/pilot-test.js`
(70 checkpoints).

## WhatsApp field bridge + field issues + evidence-draft promotion (v11)

Field teams coordinate on WhatsApp; OBV stays the source of truth.

> WHATSAPP COORDINATES. OBV EVIDENCE PROVES. VERIFICATION ASSESSES.
> HUMANS AUTHORIZE THROUGH THE FORMAL OBV APPROVAL WORKFLOW.
> THE EVIDENCE LEDGER RECORDS. CHAT DOES NOT RELEASE FUNDS.

- **WhatsApp Business Cloud API bridge** (provider-isolated, server-side
  only): signed webhook (HMAC + verify handshake) for inbound text, photos,
  documents, voice notes and locations; policy-gated outbound (free-form in
  the 24 h service window, operational templates outside it, otherwise
  honestly `SKIPPED`); delivery statuses; dedupe/loop prevention; per-sender
  rate limiting. Participants are **explicitly** assigned to project threads
  by a coordinator (never guessed from text); unknown senders land in a
  "WhatsApp — Unresolved" inbox. Media is allowlisted, size-capped, stored
  under `data/comm-media/` as communication artifacts — never WORM evidence.
- **Field Issues** — structured operational records (category, severity,
  assignment, due date, transition-validated lifecycle, auditable timeline)
  raised from coordination messages or directly. Issues inform humans and
  appear on the map and Risk & Compliance; they can never move money.
- **Clarification Requests** — reviewer asks the field for something
  specific; an inbound response sets RESPONDED at most; acceptance is a
  separate explicit reviewer decision.
- **Promote to Evidence Draft** — governed path from a coordination photo to
  the formal pipeline: DRAFT (not evidence) → explicit submit → the SAME
  `processEvidenceSubmission` flow as field capture. Missing GPS stays
  missing (geofence routes to REVIEW); provenance stays honest.

Docs: `docs/WHATSAPP_FIELD_BRIDGE.md` (architecture + trust model),
`docs/WHATSAPP_REAL_SETUP.md` (Meta setup + real-platform validation
checklist). Unconfigured, WhatsApp shows "Not Configured" and everything
else works fully. Stub-validated only until a real message is exchanged.

## Teams ↔ OBV conversation sync (v9)

Selected OBV project/milestone threads can bind to Microsoft Teams
channels for two-way coordination-message sync via a provider-isolated
TeamsConversationBridge (Microsoft Graph client-credentials, server-side
only). Strictly separate from the TeamsNotifier event cards. Outbound:
human messages and explicitly shared references sync once (external ids
guard retries); inbound: an authenticated change-notification webhook
(`/api/teams-sync/notifications`) with validation handshake, clientState
verification, replay dedupe (DB-level unique index) and loop prevention
via message origin. Explicit identity mapping (never name-guessed);
Teams edits/deletes stay auditable ("edited in Teams" with original
preserved, "Message deleted in Microsoft Teams"); attachments remain
communication artifacts — never auto-evidence. **No message from any
channel can approve or release funds** — proven by
`scripts/teams-sync-test.js` (40 checkpoints against a Graph-compatible
stub; real tenant validation still required). Real-tenant readiness
(v10): split credential strategies — application-permission READ
(tenant-wide or team-scoped RSC via `integrations/teams-app/`) and
delegated `ChannelMessage.Send` for outbound (app-only channel posting
is migration-mode-only in real Graph and is hard-blocked here);
bindings validate team + channel + subscription before ever showing
Connected (`PERMISSION_REQUIRED` state for consent problems); identity
admin endpoints; `scripts/teams-real-tenant-check.js` diagnostics and
`scripts/teams-delegated-auth.js` onboarding; administrator guide in
`docs/TEAMS_REAL_TENANT_SETUP.md`. Without credentials everything runs
in demo mode with sync shown as "not configured".

## Spatial map + contextual communications (v8)

**Project Map** (`/map`, plus a Map tab in each project): an operational
GIS view driven entirely by existing records — the map presents state, it
never computes it. Zero-dependency Web-Mercator engine (~450 lines,
`src/client/map.ts`) behind a tile-provider adapter; standard tiles from
OpenStreetMap and satellite from Esri World Imagery — both public and
token-free, so no map key exists anywhere. Shows the registered site
boundary (dashed), the demo corridor centerline, per-milestone segments
colored by live milestone state (labels like "km 7–11" are explicit
demonstration metadata seeded in `spatial_features`), and evidence markers
colored by verification verdict (with demo-fallback and outside-geofence
treatments). Selecting the project / a segment / a marker opens an
inspector panel (bottom sheet on mobile) with budget/held/released,
requirement/tranche/approval progress, or the evidence photo, checks,
confidence, GPS, fund state and ledger reference — with cross-links to the
full records and threads. Filters: time (all/7/30 days), milestone,
verdict. Tests: `scripts/map-test.js` (16 checkpoints).

**Communications** (`/communications`, plus a Discussion tab per project
and "Open thread" on milestones): real internal project-linked messaging —
thread list, conversation, and a linked-context panel (drawer on mobile).
Threads scope to organization/project/milestone/evidence/approval; two are
seeded (Project General, M3 · Gravel Base Course Review) with history
consistent with the seeded governance state. Important product events
(evidence submitted, verification completed, approval requested/recorded/
rejected, tranche released, integrity alerts) mirror into the most
specific existing thread as visually distinct system events with compact
evidence/approval reference cards. **Chat coordinates — it cannot
authorize:** no code path from messages reaches the approval workflow or
VirtualAccountService, and `scripts/chat-test.js` (16 checkpoints) proves
"approved"/"release funds" messages change nothing, plus tenant-boundary
enforcement and reset consistency. Teams/WhatsApp are architecture-ready
seams only (provider enum + external id columns) — see
`docs/COMMUNICATIONS_INTEGRATION.md`. TeamsNotifier remains the separate,
unchanged notification channel.

## Microsoft Teams notifications (v6)

OBV can notify an institutional Teams channel on decision- and risk-relevant
events. **Teams is a notification channel only** — it is not part of the
trust boundary, cannot approve funds, and its failure never blocks
verification, ledger writes, approvals, release transitions, or reports.

- **Setup**: create an incoming webhook on a Teams channel (Channel → ⋯ →
  Connectors/Workflows → Incoming Webhook), then set `TEAMS_WEBHOOK_URL` in
  `.env` (server-side only, gitignored, never logged in full). Optional:
  `TEAMS_NOTIFICATION_TIMEOUT_MS` (default 5000) and `OBV_PUBLIC_BASE_URL`
  (adds an "Open in OBV" action to cards; omitted cleanly when unset).
- **Events with Adaptive Cards**: Milestone Verified (with "Funds remain
  HELD pending required human approval"), Evidence Needs Review, Evidence
  Rejected, Approval Request Created, Approval Recorded (n-of-m + awaiting
  role), Approval Rejected / Returned for Review, Tranche Released (approvers,
  timestamps, ledger integrity, virtual-account state, and an explicit
  demo-environment note — no real bank transfer is claimed), and Evidence
  Ledger Integrity Alert. Routine internal events (AI provenance, aggregation,
  intact integrity checks, resets) stay in-app only.
- **Resilience**: `ResilientTeamsNotifier` wraps `WebhookTeamsNotifier` /
  `MockTeamsNotifier` — short timeout, sanitized failure categories
  (`timeout`, `http_4xx`, `http_5xx`, `network_failure`,
  `invalid_webhook_url`), and it never throws into the business flow.
- **Provenance**: every notification stores delivery mode
  (`TEAMS_WEBHOOK`/`MOCK`), status (`SENT`/`FAILED`/`SKIPPED`), `sentAt`, and
  project/milestone context. The Overview activity register shows the
  delivery state per event and a quiet "Demo notification mode" indicator
  when no webhook is configured.
- **Tests**: `node scripts/teams-test.js` (8 checkpoints against a local stub
  webhook: demo mode, full card flow, card content, review/reject paths,
  approval rejection, tamper alert with no false success card, timeout and
  5xx resilience).

## Hybrid live verification (v5)

The verification engine is now a hybrid pipeline:

> **AI evaluates the physical image. Code evaluates objective system facts.
> Humans authorize financial release.**

```
PHYSICAL EVIDENCE → AI VISUAL ASSESSMENT (live → mock fallback)
                  → DETERMINISTIC GEOFENCE CHECK
                  → DETERMINISTIC METADATA CHECK
                  → VERDICT AGGREGATOR → LEDGER → HUMAN GOVERNANCE → RELEASE
```

- **Enable live verification**: copy `.env.example` to `.env` (gitignored) and
  set `ANTHROPIC_API_KEY`, or export it before `npm start`. The key is used
  server-side only. Optional: `OBV_AI_MODEL` (default
  `claude-haiku-4-5-20251001`), `OBV_AI_TIMEOUT_MS` (default 8000),
  `OBV_AI_BASE_URL` (provider stays replaceable behind the
  `AiVisualVerificationService` interface).
- **Without a key** everything works exactly as before (deterministic mock,
  provenance `MOCK_DEFAULT`).
- **Resilience**: the live path has a hard timeout, strict schema validation
  of model output (fences/prose/malformed JSON/bad types/out-of-range
  confidence all rejected), one retry only for transient transport failures,
  then automatic deterministic fallback (`MOCK_FALLBACK`). Provider errors
  are sanitized; image payloads and keys are never logged. The hero loop
  cannot break on provider behavior.
- **The model's only job** is visual consistency of the photo with the
  milestone requirement. Geofence inclusion (`services/verification/geofence.ts`)
  and timestamp/metadata integrity (`metadata.ts`) are deterministic code;
  offline delayed uploads are explicitly legitimate; missing GPS is never
  silently passed (→ REVIEW). All verdict thresholds live in
  `services/verification/config.ts`; the aggregator (`aggregator.ts`) is the
  only place a verdict is computed. The model can never move money, approve
  its own verification, or bypass the ApprovalRequest — VERIFIED still
  requires the same human governance to release funds.
- **Provenance** is stored per verification (`LIVE_AI` / `MOCK_FALLBACK` /
  `MOCK_DEFAULT`), shown quietly on the Evidence Panel ("AI-assisted visual
  verification" vs "Demo verification fallback"), included in the Funder
  Report ("Verification method" per evidence section), and audited via
  activity events (`AI_VISUAL_VERIFICATION_SUCCEEDED`,
  `AI_VISUAL_FALLBACK_USED`, `VERIFICATION_AGGREGATED`).
- **Tests**: `node scripts/verification-test.js` runs the server against a
  local stub provider and covers no-key, live success, malformed output,
  timeout, 5xx with single retry + sanitized errors, outside-geofence,
  missing GPS, bad timestamps, and offline delayed sync (11 checkpoints).

## Funder Verification Report (v3)

One-click, audit-grade PDF built entirely from live application data:

- **Generate** from the project detail header ("Generate funder report") or the
  Reports page; **download / open / regenerate** from Reports.
- **Contents**: executive cover (budget, released/held, verified milestones,
  pending approvals, flagged evidence, ledger integrity), project + financial +
  verification summaries, milestone register, per-evidence sections
  (photo, capture metadata, DEMO FALLBACK labeling, the three verification
  checks, verdict + confidence + reasoning, per-role approval records,
  HELD/RELEASED state with reason or release event reference, truncated hashes),
  virtual-account summary, governance summary (with the
  VERIFICATION → APPROVAL → SIGN-OFF → ELIGIBILITY → ACCOUNT STATE sequence),
  ledger-integrity section (integrity check runs at generation; tampering is
  reported prominently, never suppressed), activity timeline, and a full-hash
  appendix. Every page footer carries project, timestamp, page number and
  "Generated by OBV Demo Environment".
- **How**: the server renders a print-styled HTML document
  (`src/server/view/report.tsx`) from `assembleReportData()` and converts it
  with headless Chromium via the environment's global Playwright
  (`scripts/render-pdf.js` child process — no npm dependency added). Override
  the Playwright location with `OBV_PLAYWRIGHT_NODE_PATH` if needed; if PDF
  rendering is unavailable, the printable HTML preview
  (`/report/<projectId>/preview`) remains as graceful degradation.
- **Storage**: PDFs live under `data/reports/<reportId>/<filename>.pdf` with a
  `reports` table row (project, generated by/at, ledger-integrity status at
  generation). Demo reset clears them. Filenames:
  `OBV_<project>_Verification_Report_<date>.pdf`.
- **Endpoints**: `POST /api/reports/generate`, `GET /reports/file/:id[?dl=1]`,
  `GET /report/:projectId/preview`.
- **Tests**: `node scripts/report-test.js` (10 checkpoints: accuracy vs DB,
  images, DEMO FALLBACK labels, hashes, regeneration after approval/release,
  reset behavior, 404s for stale files) — plus a manual tampering check
  (mutated ledger row → report states TAMPERING DETECTED AT ENTRY 1).

## Deployment (v7) — public HTTPS from a phone or laptop

### Deployability audit (what this app actually needs from a host)

| Requirement | Detail |
|---|---|
| Process model | ONE long-running `node:http` server (`npm start`). Not serverless-compatible. |
| Runtime | Node ≥ 22.5 (built-in `node:sqlite`). Zero runtime npm dependencies. |
| Disk writes | Everything under one root (default `./data`): `obv.db` + WAL/SHM, `uploads/`, `worm/` (immutable evidence), `reports/` (generated PDFs). |
| PDF rendering | Headless Chromium via Playwright, invoked as a child process (`scripts/render-pdf.js`). Needs Chromium **and its system libraries** — this is the requirement managed "native Node" runtimes don't meet. |
| Build | `npm install && npm run build` (TypeScript → `dist/`, client JS, PWA icons), then seed-if-missing at boot. |
| HTTPS | Mandatory for phone features: `getUserMedia` (camera), Geolocation, and service workers only work in secure contexts. |
| Config | Environment variables only (see table below). None are required. |

### Host selection — compatibility, not popularity

- **Vercel / Netlify (serverless)** — incompatible: no long-lived process, no
  persistent local disk, execution time limits vs. Chromium PDF rendering.
- **Render, native Node runtime** — runs the app but cannot render PDFs
  (no Chromium system libraries on the managed image).
- **Render, Docker runtime (chosen)** — the included `Dockerfile` bakes
  Playwright + Chromium into the image, so **PDF generation works in the
  deployed environment**. Works on the free plan, automatic HTTPS, one-click
  Blueprint deploy from this repo. Fly.io / Railway / any Docker host would
  work with the same image; Render was chosen for the smallest number of
  steps from GitHub to a URL.

### Deploy it (≈5 minutes, phone-friendly steps)

1. Open **https://render.com** and sign in (**Sign in with GitHub** is fastest).
2. Tap **New → Blueprint**.
3. Connect the **Dembakane1/Obv-working-DEMO** repository (grant access if asked).
4. Choose the branch **claude/obv-demo-repo-structure-t0hjsc** — the included
   `render.yaml` + `Dockerfile` configure everything (Docker build, health
   check at `/api/health`, seed-on-first-boot).
5. When prompted for **OBV_ACCESS_CODE**, either type a code (visitors must
   enter it once per browser) or leave it blank for an open demo.
6. Tap **Apply / Deploy**. The first Docker build takes ~5–8 min (it installs
   Chromium); later deploys are faster (cached layers).
7. Open the generated URL, e.g. `https://obv-demo.onrender.com`, and pick a
   demo user. Verify `https://<your-url>/api/health` shows
   `"reportRenderer": "pdf"`.

**Redeploying after new GitHub commits:** Render auto-deploys the pinned
branch on every push. Manual: Render dashboard → the `obv-demo` service →
**Manual Deploy → Deploy latest commit**. To start truly fresh:
**Manual Deploy → Clear build cache & deploy**.

### Environment variables

All optional — OBV boots and demos fully with zero configuration. Set values
in the Render dashboard (or platform equivalent), **never in the repo**.
`.env.example` mirrors this table; a local `.env` file (gitignored) works too.

| Group | Variable | Effect |
|---|---|---|
| REQUIRED | *(none)* | `PORT` is injected by the platform (Docker default 10000, local 3000). |
| OPTIONAL — AI | `ANTHROPIC_API_KEY` | Enables live AI visual verification (`aiMode: "live-capable"`). Without it: deterministic demo verification. Server-side only, never logged. |
| | `OBV_AI_MODEL`, `OBV_AI_TIMEOUT_MS`, `OBV_AI_BASE_URL` | Provider overrides (sane defaults). |
| OPTIONAL — TEAMS | `TEAMS_WEBHOOK_URL` | Enables Microsoft Teams governance notifications (`teamsMode: "configured"`). Without it: in-app demo notification mode. Never logged in full. |
| | `TEAMS_NOTIFICATION_TIMEOUT_MS` | Delivery timeout (default 5000 ms). |
| | `OBV_PUBLIC_BASE_URL` | Base URL for "Open in OBV" links on Teams cards. On Render, defaults to the platform-provided `RENDER_EXTERNAL_URL`. |
| OPTIONAL — WHATSAPP | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | Enables the WhatsApp field bridge (all five required together). Server-side only, never logged. Setup: `docs/WHATSAPP_REAL_SETUP.md`. |
| | `WHATSAPP_API_VERSION`, `WHATSAPP_SYNC_TIMEOUT_MS`, `OBV_WHATSAPP_API_BASE_URL` | Provider overrides (defaults `v21.0`, 8000 ms, Meta Graph; base URL override is for the contract-stub tests). |
| OPTIONAL — STORAGE | `OBV_DATA_DIR` | Root for ALL runtime data. Point at a persistent volume (e.g. `/var/data`) for restart-safe state. Default `./data` (ephemeral in containers). |
| | `OBV_REPORT_STORAGE_PATH` | Relocates generated report PDFs only (default `<OBV_DATA_DIR>/reports`). |
| OPTIONAL — DEPLOYMENT | `OBV_ACCESS_CODE` | Simple access gate for the public demo. Everything except `/api/health` requires the code once per browser; the cookie stores only a hash. |
| | `OBV_PLAYWRIGHT_NODE_PATH` | Where the PDF child process resolves `playwright` (Docker image sets `/app/node_modules`). |

### Persistence & demo reset

- The start command seeds **only when `obv.db` is missing**, so restarts
  never wipe a persistent volume — verified restart-safe.
- Free plan: the filesystem is ephemeral; a restart/redeploy returns the demo
  to its seeded state (often desirable). **More → Reset demo data** does the
  same on demand at any time.
- Restart-safe state: use a paid instance, uncomment the `disk:` block in
  `render.yaml` (mounts at `/var/data`), and set `OBV_DATA_DIR=/var/data`.
- A report row whose PDF file no longer exists (e.g. after redeploy without a
  volume) returns a graceful "Report not found — generate a new one" page,
  never a broken download.

### Health endpoint

`GET /api/health` (open even when the access gate is on; no secrets, no paths):

```json
{
  "status": "ok",
  "database": "connected",
  "reportRenderer": "pdf",
  "aiMode": "fallback-only",
  "teamsMode": "demo",
  "timestamp": "2026-07-07T16:59:47.585Z"
}
```

`reportRenderer` honestly reports `"html-fallback"` where Chromium is
unavailable; `aiMode`/`teamsMode` flip to `"live-capable"`/`"configured"`
when the corresponding variables are set. Render uses this path for
deploy-time health checks.

### Phone checklist (iPhone Safari / Android Chrome)

1. Open the deployed HTTPS URL → (enter access code if set) → pick
   **Chikondi Banda (Field Engineer)**.
2. Tap **Use camera** — Safari asks for camera permission. **Allow** shows
   the live viewfinder; **Deny** shows a clear message and the DEMO FALLBACK
   path remains fully usable.
3. Location permission is requested for GPS capture. Deny → evidence submits
   with "no usable GPS fix" and the geofence check goes to REVIEW (never a
   silent pass).
4. Install as app: Safari share sheet → **Add to Home Screen** (Android
   Chrome: **Install app**). Launches standalone with the OBV icon.
5. Offline queue: airplane mode → capture → submit → "queued" → back online →
   the queued evidence uploads automatically.
6. Reports: generate on a desktop role, then open the PDF from the phone —
   it opens inline in Safari's PDF viewer and shares via the share sheet.

### Deployment test matrix

Automatable checks (≈21 assertions: health schema + honesty, access gate,
role picker, session gating, seeded state, PWA assets, field API, polling
API) run from any machine against the deployed URL:

```bash
node scripts/deploy-check.js https://your-app.onrender.com [access-code]
```

Full 12-test matrix — run against the **deployed** URL:

| # | Test | How |
|---|---|---|
| 1 | Health endpoint schema + no secrets | `deploy-check.js` |
| 2 | Role picker loads over HTTPS | `deploy-check.js` |
| 3 | Session gating (pages redirect without a role) | `deploy-check.js` |
| 4 | Seeded project + DEMO ENVIRONMENT indicator | `deploy-check.js` |
| 5 | PWA assets (manifest, service worker, icons) | `deploy-check.js` |
| 6 | Access gate blocks/unlocks (when code set) | `deploy-check.js` with code |
| 7 | Phone camera permission + capture | manual — phone checklist 2 |
| 8 | GPS permission + geofence honesty on denial | manual — phone checklist 3 |
| 9 | Offline queue upload | manual — phone checklist 5 |
| 10 | Full hero loop on the deployed app (capture → verify → approve ×2 → RELEASED) | manual: follow the hero-loop script below on the deployed URL |
| 11 | PDF report generated and downloadable | Reports → Generate; confirm a real PDF opens (health shows `"reportRenderer": "pdf"`) |
| 12 | Reset returns to seeded state | More → Reset demo data → overview shows $720,000 released |

## Hero-loop demo script

1. `npm run setup && npm start`, open http://localhost:3000.
2. Select **Margaret Osei (Funder Representative)** → portfolio dashboard.
3. Open **Mzimba–Kafukule Rural Road Rehabilitation (R47)** — five milestones:
   M1–M2 released ($720,000), M3 awaiting evidence, M4–M5 not started;
   $1,680,000 held.
4. **Switch user** → **Chikondi Banda (Field Engineer)** → field capture PWA
   (installable; phone-first).
5. The project is pre-selected. Tap milestone **M3 — Gravel base course**.
6. Read the evidence requirement, then either:
   - **Primary path** — allow camera, capture a photo, allow location; or
   - **DEMO FALLBACK** — if camera/GPS are unavailable or denied, the app
     immediately offers seeded demo photos with simulated site GPS and a
     simulated timestamp, clearly labelled `DEMO FALLBACK`. There is no
     dead-end error screen.
7. Confirm the submission. Verification runs server-side and returns a
   structured verdict: three checks (photo↔requirement, GPS-in-geofence,
   timestamp/metadata integrity), a confidence score and reasoning.
8. On VERIFIED: a hash-chained ledger entry is appended (hash shown), an
   **ApprovalRequest** is created, and the $600,000 tranche **remains HELD** —
   release requires human approval (next release).
9. Switch back to the funder. The overview/project pages auto-refresh by
   polling and show: M3 `VERIFIED` + approval `0 of 2` + funds `HELD`, the
   new ledger entry with *Chain intact*, and the activity feed entry.
10. Open **Pending Approvals**, review the evidence panel, and **Approve
    release (1 of 2)** as the funder. Funds remain HELD.
11. Switch to **Amina Ndlovu (Compliance Reviewer)** → Pending Approvals →
    approve. The tranche releases: overview now shows $1,320,000 released.
12. Open **Evidence Ledger** → **Verify integrity** → CHAIN INTACT.
13. Click **Generate funder report** (project header or Reports page) — the PDF
    opens with evidence, checks, approvals, financial state, ledger integrity
    and the activity timeline.
14. **Reset demo data** on the Overview page to restore the seeded state.

If the device is offline at submit time, the capture is stored in an
IndexedDB queue and auto-uploads when connectivity returns.

## Acceptance test

`scripts/acceptance-test.js` drives the full 19-step regression in headless
Chromium: overview state → field capture → verdict/checks/confidence → ledger
hash → approval request → partial approval (funds HELD) → final approval →
release → ledger integrity → demo reset → repeat loop.

```bash
node scripts/acceptance-test.js fallback   # DEMO FALLBACK path
node scripts/acceptance-test.js camera     # real camera + GPS (fake media stream)
node scripts/idempotency-test.js           # replay/double-submit protections (no Playwright needed)
node scripts/map-test.js                   # spatial map: layers, geometry, markers, filters, mobile
node scripts/chat-test.js                  # communications + proof that chat cannot approve/release
node scripts/teams-sync-test.js            # Teams conversation sync vs Graph stub (dedupe, loops, governance)
node scripts/whatsapp-sync-test.js         # WhatsApp bridge vs Cloud API stub (signatures, media, policy, governance)
node scripts/fieldops-test.js              # field issues, clarifications, draft promotion — none of it moves money
node scripts/pilot-test.js                 # pilot onboarding: invitations, config, readiness, launch, change control
node scripts/draws-test.js                 # draw requests: reconciliation, review, advisory recommendation, exactly-once governed release
node scripts/budget-test.js                # budget vs verified physical progress: methodology, variance states, traceability, change control
node scripts/exceptions-test.js            # unified exceptions: idempotent rules, source-aware resolution, waivers, SLA, isolation
```

`scripts/idempotency-test.js` proves accidental repeats cannot duplicate
business records: an offline-queue replay of the same evidence payload
returns the original result (one evidence item, one verification, one
ledger entry); double-approve and approval replay are rejected 409; the
HELD → RELEASED transition happens exactly once. See also
`docs/DEMO_RUNBOOK.md` for the operational demo guide.

Requires the `playwright` npm package and a Chromium install (in the build
environment: `npm ci && npm run browsers`). Reseed between runs.

**Status: v2 regression passed in both modes** (fallback ×2, camera ×1)
before this commit; the v1 hero loop passed 3/3 before the redesign.

---

## Architecture

```
src/
  shared/types.ts              core data model (single source of truth)
  server/
    db/index.ts                node:sqlite connection + schema (TODO: Prisma/PostgreSQL)
    db/repo.ts                 typed repository layer — all SQL lives here
    db/seed.ts                 seeded demo project (npm run seed)
    services/
      AiVerificationService.ts interface + deterministic mock (TODO: real multimodal model)
      WormEvidenceStore.ts     WORM storage + hash-chained ledger (TODO: Azure Blob immutability)
      VirtualAccountService.ts HELD/RELEASED tranche ledger (TODO: sponsor-bank/BaaS)
      TeamsNotifier.ts         notifications (TODO: Teams incoming webhook)
      geo.ts                   point-in-polygon geofence math
    workflow/orchestrator.ts   THE single pipeline: evidence → verification →
                               ledger → approval request (TODO: Temporal.io)
    http/server.ts             node:http server, routing, static files, demo session
    view/jsx.ts                minimal server-side JSX runtime
    view/components.tsx        Layout, badges, reusable EvidencePanel
    view/pages.tsx             user switcher, dashboard, project, milestone, field shell
  client/
    field.ts                   field-capture wizard: camera, GPS, fallbacks, IndexedDB queue
    poll.ts                    dashboard auto-refresh (fingerprint polling)
public/
  styles.css                   institutional design system
  manifest.webmanifest, sw.js  installable PWA + offline shell
  demo-evidence/*.jpg          simulated demo evidence photos (procedurally
                               generated, watermarked "SIMULATED DEMO EVIDENCE")
scripts/
  gen-icons.js                 dependency-free PNG icon generator
  acceptance-test.js           hero-loop browser test
```

### Key design decisions

- **Mocked heavy infrastructure behind interfaces.** `AiVerificationService`,
  `WormEvidenceStore`, `VirtualAccountService` and `TeamsNotifier` are
  interfaces with mock implementations and explicit `TODO:` notes for the
  production mapping (server-side multimodal model; Azure Blob Storage
  immutability policy / legal hold; sponsor-bank/BaaS; Teams webhook).
  Application logic depends only on the interfaces.
- **The ledger is real.** Hash chaining is fully implemented (SHA-256; each
  entry's hash covers its content + the previous hash; fixed genesis value).
  `verifyChain()` recomputes the whole chain and the project page shows
  *Chain intact / Chain broken*.
- **Verification is deterministic.** The mock derives confidence from the
  evidence hash and runs two of the three checks for real (geofence
  point-in-polygon, timestamp/metadata integrity), so demos are repeatable.
  Only photo-content matching is simulated.
- **One orchestrator.** The whole evidence→verification→ledger→approval
  pipeline lives in `processEvidenceSubmission()` — nothing scattered across
  routes; marked for a future Temporal.io swap.
- **Funds never release automatically.** A VERIFIED milestone creates an
  `ApprovalRequest` (persisted, visible in UI, approval action stubbed) and
  its tranche stays `HELD` on the virtual account. The UI states explicitly
  that this is project-level financial control logic, not cryptocurrency.
- **Future-ready model.** `Project.projectType` supports later
  mining/battery-passport verticals without schema surgery.

## Build environment constraint (important)

This demo was built in a sandbox whose network egress policy **blocks the
npm registry** (only GitHub is reachable), so Next.js, Prisma and Tailwind
could not be installed. Rather than ship nothing, the app is built
**dependency-free** on the same conceptual stack:

| Spec | This build | Migration path |
|---|---|---|
| Next.js + React | `node:http` + server-rendered TSX components (tiny JSX runtime) | components/pages port ~mechanically to Next.js App Router |
| Prisma + PostgreSQL | `node:sqlite` behind a typed repository layer (`db/repo.ts`) | schema mirrors `shared/types.ts` one-to-one; swap repo internals for Prisma |
| Tailwind CSS | hand-written utility-flavoured design system (`public/styles.css`) | class names are semantic; restyle with Tailwind at migration |

Everything else (PWA, camera/geolocation, IndexedDB queue, hash-chained
ledger, polling refresh) uses standard web/Node APIs and carries over as-is.

The toolchain is now pinned and lockfile-driven (`npm ci` installs exactly
`typescript`, `@types/node` and `playwright` at the versions in
`package-lock.json`). `node_modules/@types/` remains vendored (committed)
as an OFFLINE FALLBACK so `tsc` still type-checks in a sandbox with no
registry access; it is byte-identical to the version the lockfile pins, and
`scripts/toolchain-test.js` fails if the two ever drift.

## Implementation log

1. Inspected repo — empty; discovered npm registry blocked by egress policy →
   pivoted to zero-dependency build (documented above).
2. Scaffolded TypeScript build (global `tsc`), server-side JSX runtime,
   shared domain types.
3. Database schema + typed repository on `node:sqlite`; seed script for the
   Mzimba–Kafukule R47 road project (5 milestones, 4 users, 2 historical
   evidence/verification/ledger/release records, 3 demo fallback photos).
4. Services: mock `AiVerificationService` (3 checks, deterministic),
   `WormEvidenceStore` (content-addressed WORM dir + hash-chained ledger),
   mock `VirtualAccountService`, mock `TeamsNotifier`.
5. Central orchestrator `processEvidenceSubmission()`.
6. HTTP server, demo-session cookie auth, API routes, SSR pages: user
   switcher, portfolio dashboard, project detail (milestones, approvals,
   evidence panels, ledger, virtual account timeline, report placeholder),
   milestone detail.
7. Field PWA: capture wizard (camera → GPS → confirm → result), DEMO
   FALLBACK paths for camera and GPS, IndexedDB offline queue, manifest +
   service worker + generated icons.
8. Fixes found while testing: snake_case→camelCase row-mapping bugs
   (notifications, demo photos); capture-button race before camera ready
   (button now disabled until stream is live).
9. Hero-loop acceptance test written and passed 3× (fallback, real-camera,
   fallback), including the dashboard auto-update assertion.

## Known limitations

- Without `ANTHROPIC_API_KEY`, photo-content verification uses the
  deterministic demo path (honestly labelled); geofence and integrity checks
  are always real. With a key, the live AI path assesses the image only —
  it can never move money or bypass human governance.
- Demo "photos" for fallback are SVG stand-ins (no image tooling available
  in the build sandbox).
- Single-node SQLite; fine for demo, not for production concurrency.
- Demo session cookie is not real authentication; `OBV_ACCESS_CODE` is
  deployment-level demo protection, not a user-auth system.
- The service worker caches the app shell; full offline navigation of
  dashboard pages is not a goal in this build.

## Recommended next prompt

> **Prompt 2 — Real AI verification.** Replace `MockAiVerificationService`
> with a server-side multimodal model call (photo vs milestone requirement)
> behind the existing interface, including confidence calibration, retry and
> failure fallbacks to NEEDS_REVIEW, and per-check reasoning from the model.
> Requires enabling network egress and adding API credentials via environment
> variables — no application logic changes.
