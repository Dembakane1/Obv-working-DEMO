# OBV Demo Runbook

Operational guide for demonstrating OBV from the public deployment to
lenders, funders, development-bank personnel, government project offices,
auditors and pilot partners.

Core story to land: **AI verifies evidence. Code evaluates deterministic
checks. Humans authorize. OBV records.**

---

## A. Pre-demo checklist (2 minutes, do this before every demo)

| Check | How | Expected |
|---|---|---|
| Service awake | Open `https://<your-url>/api/health` | JSON responds (free tier wakes in ~30–60 s after idle — do this 5 min before the demo, not during it) |
| Database | same JSON | `"database": "connected"` |
| PDF renderer | same JSON | `"reportRenderer": "pdf"` (if `html-fallback`, plan to show the HTML preview instead — see D) |
| AI mode | same JSON | `"live-capable"` (key configured) or `"fallback-only"` (deterministic demo verification — fully demoable) |
| Teams mode | same JSON | `"configured"` or `"demo"` (in-app notifications only) |
| Access code | Open the URL in a private window | Gate page appears if `OBV_ACCESS_CODE` is set — have the code ready for attendees |
| Clean state | Sign in as any office role → **More → Reset demo data** | Overview shows $720,000 released / $1,680,000 held, M3 "Awaiting evidence" |
| Connection | Load Overview once fully | Styles, tables and activity register all render |

Optional deeper check from a laptop:
`node scripts/deploy-check.js https://<your-url> [access-code]`

## B. 3-minute demo script

Roles used: **Margaret Osei** (Funder Rep) → **Chikondi Banda** (Field) →
Margaret again → **Amina Ndlovu** (Compliance). Switch via **Switch user**
in the top bar (or `/`).

1. **[Margaret]** Overview: point at the capital position — total, released,
   **held**, and the pending-governance line. "Funds move only on verified
   physical progress plus human approval."
2. Open the R47 project → milestone M3 "Gravel base course" is awaiting
   evidence; its $600,000 tranche is HELD.
3. **[Switch → Chikondi]** Field capture: select M3 → **Use DEMO FALLBACK
   evidence** → pick a photo → review screen (GPS + timestamp labelled
   simulated) → **Confirm & submit**.
4. Verification result appears: visual assessment, geofence check, metadata
   check, verdict VERIFIED, the evidence hash and ledger entry #3. "Three
   independent checks; the verdict is computed centrally; the record is
   hash-chained."
5. **[Switch → Margaret]** Approvals: the $600,000 request. Show funds still
   HELD. Approve → partial governance (1 of 2, awaiting compliance).
6. **[Switch → Amina]** Approve as Compliance → status flips to RELEASED;
   Overview allocation bar moves to $1,320,000 released.
7. Reports → **Generate report (PDF)** → the audit-grade Funder Verification
   Report opens with evidence, approvals, amounts and the chain-integrity
   statement.

## C. 5-minute demo script

The 3-minute script plus:

- After step 2: open the project's **Ledger** tab — show hash chaining
  (each entry's previous-hash links to the prior entry) and run
  **Verify integrity** → CHAIN INTACT.
- In step 3: attempt the **camera path first** on a phone — grant camera
  permission, capture a real photo, grant location. If anything is denied
  the app offers DEMO FALLBACK immediately (that moment itself demos well:
  "the demo never dead-ends on a permission screen").
- After step 4: show the milestone record page — evidence photo, all three
  checks with details, verification provenance line (live vs demo fallback,
  stated honestly).
- After step 6: if Teams is configured, show the channel: verified →
  approval request → approval recorded → tranche released cards, each with
  "Open in OBV" links.
- Close on **Insights** or the Overview activity register: every action of
  the last five minutes is in the audit trail.

## D. Backup demo paths (nothing here blocks the demo)

| If | Then |
|---|---|
| Camera or GPS denied / unavailable | **DEMO FALLBACK** buttons are offered inline — seeded photos + simulated site GPS, clearly labelled throughout |
| No AI key / provider down | Verification runs the deterministic demo path automatically; provenance honestly shows demo fallback; verdict logic unchanged |
| No Teams webhook | Demo notification mode: everything appears in the in-app activity register with a "demo mode" chip |
| PDF generation fails / `reportRenderer: html-fallback` | Reports → **Preview HTML** shows the identical report content printable from the browser; say "PDF rendering is a deployment capability, content is identical" |
| Network drops mid-submission | Evidence queues on-device ("Saved offline") and uploads automatically on reconnect — replays cannot create duplicates |

## E. Recovery procedures

- **Reset the demo**: any office role → **More → Reset demo data** (or
  `POST /api/demo/reset`). Returns to the exact seeded baseline: M1–M2
  released, M3 awaiting evidence, ledger of 2 entries, chain intact.
- **Service restart** (Render): dashboard → `obv-demo` → **Manual Deploy →
  Restart**. On the free tier this also reseeds (ephemeral disk).
- **Verify health after recovery**: `https://<your-url>/api/health` →
  `"status": "ok"`, then load Overview once before presenting.
- **Stale report links** after a reset/restart show a graceful "Report not
  found — generate a new one" page; just regenerate.

## F. Known limitations (say these plainly if asked)

- **Demo authentication**: the role switcher is demo functionality, not
  real auth. `OBV_ACCESS_CODE` protects the deployment, not user identity.
- **Virtual account**: HELD → RELEASED is a real state machine on a mocked
  virtual project account; production disbursement would run through
  regulated banking rails.
- **Free-host persistence**: on the free tier, a restart/redeploy returns
  the demo to its seeded state (a paid instance + persistent disk changes
  this — see README "Persistence & demo reset").
- **Cold start**: after ~15 min idle the free instance sleeps; first hit
  takes ~30–60 s. Warm it before the demo (checklist A).
- **Provider status**: whether live AI / Teams are active is environment
  configuration; `/api/health` always tells the truth (`aiMode`,
  `teamsMode`) — never claim live AI if it says `fallback-only`.
