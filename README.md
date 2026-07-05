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
13. **Reset demo data** on the Overview page to restore the seeded state.

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
```

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
  demo-evidence/*.svg          seeded demo evidence photos
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

- Photo-content verification is simulated; geofence and integrity checks are
  real. No live AI call is made.
- Demo "photos" for fallback are SVG stand-ins (no image tooling available
  in the build sandbox).
- Single-node SQLite; fine for demo, not for production concurrency.
- Demo session cookie is not real authentication.
- The service worker caches the app shell; full offline navigation of
  dashboard pages is not a goal in this build.

## Recommended next prompt

> **Prompt 2 — Real AI verification.** Replace `MockAiVerificationService`
> with a server-side multimodal model call (photo vs milestone requirement)
> behind the existing interface, including confidence calibration, retry and
> failure fallbacks to NEEDS_REVIEW, and per-check reasoning from the model.
> Requires enabling network egress and adding API credentials via environment
> variables — no application logic changes.
