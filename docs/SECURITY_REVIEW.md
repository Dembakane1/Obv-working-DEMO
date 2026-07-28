# Automated security review

This records the automated review run over the OBV codebase, what was
fixed, and — just as important — what was found and deliberately *not*
fixed in the same change.

The review covered the seven categories requested for an OBV lender
pilot: SQL injection, cross-site scripting, broken authorization, unsafe
file handling, secret exposure, dependency vulnerabilities, and
server-side request forgery. It supplements the existing suites; it does
not replace them. Every fix below carries a regression checkpoint in
`npm test`, so a reintroduction fails the battery.

---

## Categories with no findings

**SQL injection — clean.** Every caller-controlled value in
`src/server/db/` is bound as a `?` parameter. The template-literal SQL
that a grep surfaces falls into three safe classes: placeholder
repetition for `IN (...)` clauses (`ids.map(() => "?").join(",")`),
identifiers drawn from a static allowlist (`INSPECTION_PATCH_COLS` in
`lenderRepo.ts` maps request keys onto hardcoded column names and
iterates the *map*, not the request), and literal table arrays in
`seed.ts`. No user string is concatenated into a statement.

**Secret exposure — clean in the repository.** No credential is
committed; `.env` is gitignored and `.env.example` carries empty keys.
`scripts/toolchain-test.js` scans every tracked file and fails on a
committed secret, and asserts the CI workflow never introduces one.

**Dependency vulnerabilities — nothing to exploit at runtime.** The
application has zero runtime dependencies (see `docs/TOOLCHAIN.md`), so
the production surface that could carry an advisory is empty. `npm run
audit:prod` is a blocking CI tripwire for the day that stops being true.

---

## Fixed in this change

### 1. Path traversal through the pilot code (unsafe file handling)

`src/server/services/auditPackage.ts` built the package filename from
`project.pilot.code` and joined it straight onto the packages directory:

```
obv-audit-package-${(project.pilot?.code ?? project.id).toLowerCase()}-v${n}.zip
```

The pilot code is free-form operator input (`strOrNull(input.code, 60)`
only trims and truncates) and is settable by any `PROJECT_MANAGER` — the
same role authorised to generate packages. A code of
`../../../../tmp/pwn` resolved outside the data directory, and the
un-normalised string was then persisted as the storage key.

**Fix.** The code is reduced to a filename-safe slug before it becomes a
path segment, matching the treatment already applied to permit source
artifacts in `services/permits.ts`. `resolvePackageDownload` additionally
refuses to serve any stored key that resolves outside `DATA_DIR`, so the
row is not trusted on the way back out either.

**Guarded by** `auditpackage-test.js` checkpoints 21–21c: a
traversal-shaped code yields `obv-audit-package-tmp-pwned-v1.zip`, the
file lands inside `data/audit-packages/`, and the package still
downloads normally.

### 2. Unauthenticated destructive reset (broken authorization)

`POST /api/demo/reset` had no session check. It reaches `resetDb()`,
which recursively removes `uploads/`, `worm/`, `reports/` and
`audit-packages/`. The blanket page guard that requires a session is
GET-only and sits ~450 lines further down the router, so it never
applied. The sibling `POST /api/dev/full-reset` was already gated on role
plus a typed confirmation phrase.

**Fix.** The route now requires a session before reseeding. The role
semantics are deliberately unchanged — every existing caller (the demo
UI form and seven test suites) already signs in, so this closes anonymous
remote destruction without altering who may reset.

**Guarded by** `intelligence-test.js`: an anonymous `POST` gets 403 and
provably mutates nothing.

### 3. SSRF in WhatsApp media download

`services/whatsappSync/provider.ts` read the media download URL out of
the provider's JSON response and passed it straight to `fetch` **with the
WhatsApp bearer token attached**, with no scheme, host or address
validation. The Graph base URL is environment-overridable, so an
attacker able to influence that response body could point the
credential-bearing request at cloud metadata, loopback, or any internal
service.

**Fix.** `assertSafeMediaUrl` validates before the token is sent: HTTPS
only — unless the URL is same-origin with the configured base URL, which
preserves the documented local stub — and no literal private, loopback or
link-local address. Meta serves media from CDN hosts distinct from the
Graph host, so an origin allowlist would have been too strict; this is
the narrowest rule that still protects the token. The codebase already
applies scheme allowlists at the two comparable boundaries
(`TeamsNotifier.ts`, `teamsSync/graphProvider.ts`).

**Guarded by** `whatsapp-sync-test.js` checkpoints 9b: media pointed at a
foreign origin and at `169.254.169.254` is rejected, the message survives
with the attachment honestly marked unavailable, a probe server proves
the token request is never sent, and no bytes reach disk.

### 4. Stored XSS via Teams attachment URL

`teamsSync/graphProvider.ts` accepted `contentUrl` from an inbound Graph
payload verbatim and later rendered it into an `href`, so a
`javascript:` URL became clickable. A scheme allowlist now drops
anything that is not `http(s)` at the ingestion boundary.

### 5. Response hardening

HTML responses now carry a Content-Security-Policy plus
`X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options`, and
the `obv_user` session cookie is `HttpOnly`. `Secure` is **not** set: the
app has no `x-forwarded-proto` handling, and adding proxy-trust is new
production behaviour rather than a hardening tweak.

### 6. Report/audit CSS was silently escaped

`drawVerificationDoc.tsx` and `auditCover.tsx` passed their CSS
constants as ordinary JSX children, so the renderer HTML-escaped them
(`.amount-band > div` became `&gt;`), quietly breaking styling in the
lender and audit PDF deliverables. Both now use the existing `raw()`
escape hatch. Not a vulnerability, but it was found by the same pass and
it corrupts a lender-facing artifact.

---

## Found and NOT fixed — recommended follow-up

These are real and independently reproduced, but fixing them means
reworking the authorization model. That is a behaviour change of a size
this dependency/tooling pass should not smuggle in, and it would
legitimately alter who can see and do what across the demo. They are
listed here so the decision is explicit rather than silent, and they
warrant a dedicated change.

Severities below are the **post-verification** ratings: each finding was
re-checked by an independent adversarial pass instructed to refute it, and
two were downgraded on that evidence (the orchestrator gap from CRITICAL,
because the ledger is a mock and identity is already a self-asserted demo
cookie; the chat gap from HIGH).

| Severity | Where | Issue |
|---|---|---|
| HIGH | `workflow/orchestrator.ts` | `processApprovalDecision` performs no project/tenant check, so a milestone tranche release can be approved across tenants. The Approvals queue also lists every tenant's pending requests. |
| MEDIUM | `services/chat.ts` | `participatesInProject` ignores its project argument, so the predicate returns the same answer for every project — the thread tenant boundary is open to any `PROJECT_MANAGER`/`FIELD` user. `repo.getThread`/`listThreads` are unscoped, and this is the only authorization on message posting, Teams binding and evidence sharing. |
| HIGH | `services/fieldOps.ts` | Issue, clarification and evidence-draft handlers check role but never object-level or tenant ownership. |
| MEDIUM | `http/server.ts` | Pilot onboarding mutations are role-gated only (`canAdminPilot` is exactly `role === "PROJECT_MANAGER"`, with no project or org argument), so any project manager can rewrite another tenant's approval matrix, tranche amounts and field assignments. |
| MEDIUM | `http/server.ts` | Sign-in identity is a self-asserted unsigned cookie (`obv_user` is the raw user primary key, no MAC, no server-side session), `POST /api/session` validates only that the id exists, and `/demo` enumerates every user unfiltered with no session or env gate. |
| LOW | `report/data.ts` | Funder report assembly performs no tenant check — `assembleReportData` validates only that the project exists and never compares `generatedBy` against the project's organization, so any signed-in user can read any project's evidence, ledger and financials by project id. |
| MEDIUM | `http/server.ts` | Report PDFs are listed and downloaded across tenants — only `DRAW_VERIFICATION_PACKAGE` is access-checked. |
| MEDIUM | `http/server.ts` | `GET /api/field-context` returns project, milestone and tranche data with no session. |
| MEDIUM | `http/server.ts` | `/worm/` evidence media is served with no session check and before the access-code gate. |

Note on `/worm/` specifically: the obvious one-line session gate **breaks
PDF generation**. The renderer fetches report HTML with a one-time
preview token rather than a session cookie, and `view/report.tsx` embeds
evidence photos as `<img src="/worm/…">`, so those sub-resource requests
are unauthenticated by design. Closing this properly means giving the
renderer a real credential or inlining the media — worth doing, but not a
one-liner, and not something to land untested alongside a toolchain
change.

The newer layers are notably *not* in this table. Banking, disputes,
lender decisions, draw inspections, retainage, change orders, exceptions,
permits and audit packages consistently enforce a same-404 tenant
boundary via `lenderAccess.assertProjectAccess` /
`canAccessProjectFinance`, with real separation-of-duties rules. The gaps
are concentrated in the original core that predates that doctrine, and in
the demo identity surface.
