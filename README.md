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

Requires Node.js ≥ 22.5 (uses the built-in `node:sqlite`). No other runtime
dependencies.

```bash
npm run setup   # compile TypeScript (server + client) and seed the demo database
npm start       # serve on http://localhost:3000
```

Then open **http://localhost:3000** and pick a demo user.

Rebuild/reseed at any time:

```bash
npm run build   # tsc (server TSX + client TS) + generate PWA icons
npm run seed    # drop & recreate data/obv.db with the seeded project
```

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
- **Risk & Compliance / AI Insights** — presentation layers over existing
  verification data (flagged evidence, approval bottlenecks, geofence misses,
  low-confidence verifications). Labelled as automated insights — no
  generative-AI claims.
- **Field PWA** — 4-step progress indicator, eligible milestone highlighted
  with status chips and tranche amounts, camera button disabled until the
  stream is live, explicit GPS-acquired state. Capture logic unchanged.
- **Demo reset** — "Reset demo data" on Overview (POST /api/demo/reset)
  restores the seeded state without restarting the server.

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
```

`scripts/idempotency-test.js` proves accidental repeats cannot duplicate
business records: an offline-queue replay of the same evidence payload
returns the original result (one evidence item, one verification, one
ledger entry); double-approve and approval replay are rejected 409; the
HELD → RELEASED transition happens exactly once. See also
`docs/DEMO_RUNBOOK.md` for the operational demo guide.

Requires the `playwright` npm package and a Chromium install (in the build
environment: `NODE_PATH=/opt/node22/lib/node_modules`). Reseed between runs.

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
`node_modules/@types/` is vendored (committed) only so `tsc` type-checks
without registry access.

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
