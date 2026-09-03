# External Pilot Readiness — Production Posture Audit

Audited against the ACTUAL code (not prior docs) at the start of the
production-readiness milestone, then updated with what the milestone
implemented. Classifications describe the state ON THIS BRANCH.

Legend: **READY** (works for the pilot as-is) · **NEEDS_CONFIGURATION**
(code ready; operator must configure) · **NEEDS_IMPLEMENTATION** (code
missing) · **DEMO_ONLY** (exists for demo use only) ·
**INTENTIONALLY_DISABLED** (deliberate safety posture) · **BLOCKER**.

## The environment declaration

`OBV_ENVIRONMENT=demo|pilot|production` (services/posture.ts) is the ONE
resolver every boundary keys on. Legacy flags (`OBV_BANKING_MODE`,
`OBV_SESSION_REQUIRE_SECRET`) keep working; contradictions (pilot +
`OBV_DEMO_AUTH=1`, pilot + `OBV_BANKING_MODE=demo`, pilot +
`OBV_SEED_GOLDEN=1`) REFUSE STARTUP. `npm run pilot:check` verdicts the
whole configuration.

## Area classifications

| Area | State | Detail |
|---|---|---|
| Authentication | **NEEDS_CONFIGURATION** | Passwordless magic links: 32-byte tokens, sha256-only at rest, 15-min TTL, single-use with a guarded consume, throttled, non-oracle responses, lockouts, anti-login-CSRF confirm page. Was NEEDS_IMPLEMENTATION (no real email); now `OBV_AUTH_LINK_DELIVERY=email` delivers through the live provider. |
| Sessions | **READY** | Server-side rows, sha256 secrets, constant-time compare, idle + fixed absolute expiry, rotation on org switch, immediate revocation, per-session CSRF tokens. Demo cookie is ignored entirely under production posture. |
| Demo user switcher | **INTENTIONALLY_DISABLED** (pilot) | `/demo` + `POST /api/session` are hard 404 in pilot/production. `OBV_DEMO_AUTH=1` refuses startup when OBV_ENVIRONMENT is declared. |
| Golden demo data / seeding | **READY** (was **BLOCKER**) | `seedDemo()` now REFUSES in pilot/production posture at the service level — covering the CLI, the container's seed-if-missing start command and both reset endpoints (which are additionally 404). The audited hazard (boot-time reseed destroying a real volume's WORM evidence when obv.db is missing) cannot occur in a declared pilot: a pilot cold start is empty schema + bootstrap admin. Demo reset endpoints: 404 in pilot. |
| Email delivery | **NEEDS_CONFIGURATION** (was **BLOCKER**) | Postmark is a LIVE adapter (`OBV_EMAIL_PROVIDER=postmark` + `OBV_INTEGRATIONS_PRODUCTION_ENABLE=true` + env-only credentials, validated at startup). Async delivery with timeout; sanitized errors; credential kinds (MAGIC_LINK, INVITATION, PASSWORD_RESET) redacted at rest BY KIND; dedupe keys suppress duplicate sends; failures never touch governed actions; no silent fallback to the outbox in any posture. m365/sendgrid/mailgun/ses remain disabled boundaries. |
| Notification delivery | **READY** (was **NEEDS_IMPLEMENTATION**) | The pilot alias is gone from pilot posture. Recipients derive deterministically from project memberships, the draw's submitter, and a tenancy-scoped role fallback — every candidate re-validated by the canonical `canAccessProject` predicate. Addressed in-app rows are mandatory and carry a stored "why this user" reason (operator view: `/api/ops/status`); email/Teams honor per-user preferences (`notification_preferences`, `/api/me/notification-preferences`). |
| Database storage | **NEEDS_CONFIGURATION** | SQLite under `OBV_DATA_DIR` (WAL). Pilot posture REQUIRES the explicit data root (startup refusal without it). `PRAGMA quick_check` + `foreign_key_check` + schema-version stamp run at startup; the server refuses corrupted, referentially broken (production) or newer-schema databases and never auto-repairs. Deploy needs a paid persistent disk. |
| Uploaded evidence storage | **READY** | Content-addressed WORM store under `DATA_DIR/worm` (create-only writes); uploads under `DATA_DIR/uploads`; startup writability probes on every root; restore drill proves references resolve after restore. |
| Draw documents | **INTENTIONALLY_DISABLED** (bytes) | Draw documents are METADATA-ONLY attestation records: no file bytes are stored (`file_path` null by design) and the `draw_documents` schema carries **no hash column** — an earlier revision of this row overstated ("metadata + SHA-256"). Integrity hashes exist on ADJACENT lender records only (inspection report versions hash an API-supplied `documentBase64` then discard the bytes; lien waivers accept an operator-supplied `documentHash` string). For pilot 1 this is the documented custody model — the lender retains the originals. Revisit (object storage) in a later milestone if custody must move. |
| Generated reports/packages | **READY** | PDFs under `REPORTS_DIR`, audit packages under `DATA_DIR/audit-packages` (write-once). All under the persistent root. |
| Official-source connectors | **NEEDS_CONFIGURATION** / manual | Disabled until per-source documented endpoints are configured; egress guard refuses private hosts/non-HTTPS; manual verification is first-class and preferred over unreliable automation (per the milestone: government sources are OPTIONAL for pilot 1). |
| External integrations | **NEEDS_CONFIGURATION** | Teams webhook/graph + WhatsApp bridge run only with explicit credentials; webhook framework has signing, SSRF guard, retries, dead-letter. All optional for pilot 1. |
| Banking / VAM | **INTENTIONALLY_DISABLED** | Pilot posture implies production banking mode: demo credits, simulated events and forced mismatches are unreachable (service-level 403 walls, adversarially tested). Non-mock providers refuse startup without double consent AND are disabled boundaries regardless. OBV records "eligible for payment instruction"; real money moves outside OBV. |
| Secrets | **READY** | Env-only (session secret, Postmark token, integration credentials); never in the database; never logged; `pilot:check` prints presence, never values. |
| Backups | **READY** (was **NEEDS_IMPLEMENTATION**) | `VACUUM INTO` snapshots with provenance records (env, size, sha256, source schema version, deploy commit, retention metadata); manual audited route + `npm run backup` for schedulers; read-only verification; tamper detection; automated restore drill (`backup-restore-test.js`); NO in-app restore by design. |
| Health checks | **READY** (was liveness-only) | `/api/health` = liveness; `/api/ready` = readiness (terse pass/fail); `/api/ops/status` = authenticated operator detail (storage, db safety, email/webhook queues, backup freshness, routing records). |
| Logging / supportability | **READY** | X-Request-Id correlation on every response, stamped into error logs, quoted in generic 500s. Operator status view exposes sanitized failure classes only. Severity levels: docs/FIRST_LENDER_RUNBOOK.md. |
| Deployments | **NEEDS_CONFIGURATION** | render.yaml carries a commented obv-pilot service (paid disk, `numInstances: 1`, pilot env, readiness health check, dashboard-entered secrets, mock banking stated explicitly). The runtime image ships the operator commands the runbook runs in the container (`npm run pilot:check`, `npm run backup`, the restore drill) and never runs the demo seed in pilot/production posture. Deployment has NOT been executed from this environment — the runbook's provisioning steps and `pilot:check` remain to be run on the real host. |

## Remaining blockers before a real external lender

1. **Provision the pilot host** (paid persistent disk) and run
   `npm run pilot:check` there until it reports READY — this cannot be
   verified from the development environment and is honestly NOT claimed
   done.
2. **Postmark account**: server token + verified sender signature.
3. **Operational cadence**: schedule `npm run backup` INSIDE the pilot
   service (an external scheduler over Render SSH, or the dashboard Shell
   daily — a Render Cron Job is a separate service that cannot mount the
   pilot's disk) and check `/api/ops/status` backup freshness. The
   sequence is deploy → initialize → `npm run backup` →
   `npm run pilot:check` → READY (docs/FIRST_LENDER_RUNBOOK.md §2).
4. Everything else in the definition of done is implemented and covered
   by `pilot-production-test.js` (53 checkpoints, including the
   fully-configured READY verdict, demo-fixture detection, the optional
   access gate in pilot posture and public-URL sign-in links),
   `pilot-acceptance-test.js`
   (32 checkpoints — the full first-lender lifecycle with no demo
   shortcuts) and `backup-restore-test.js` (16 checkpoints; self-contained
   so it runs inside the pilot container without inheriting its posture
   or touching the live backup directory).
