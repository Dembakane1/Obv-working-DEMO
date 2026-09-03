# Authorization and tenant isolation

How OBV decides who may see and change what, and where that decision is
made. Every rule here is exercised by `scripts/authz-test.js` (58
adversarial checkpoints) and structurally guarded by
`scripts/toolchain-test.js`.

---

## Two invariants

**1. Same-404.** A caller outside the tenant receives exactly what a caller
asking about a nonexistent object receives. Not 403 — that would confirm
the object exists. `403` is reserved for callers who *are* inside the
tenant but lack the capability, which is safe because they can already see
the object.

Ordering matters as much as the check itself. `processApprovalDecision`
used to validate status, role and separation-of-duties *before* resolving
the project, so a foreign caller could learn "this request has already been
resolved" or "a FUNDER_REP decision has already been recorded" about a
tenant they cannot see. The tenant check now runs first, before any message
that describes a real record.

**2. The service is the boundary, not the route.** Routes are one entry
point among several — another service, a page handler, a webhook, or a
future caller can all reach the same function. Authorization therefore
lives inside the authoritative service:

| Sink | Where the check lives |
|---|---|
| Milestone release | `workflow/orchestrator.ts` `processApprovalDecision` — the only path to `releaseTranche` |
| Evidence → ledger → approval request | `workflow/orchestrator.ts` `processEvidenceSubmission` — also reached internally by `fieldOps.submitDraft` |
| Threads and messages | `services/chat.ts` (`participatesInProject`, `getThreadForUser`, `ensure*Thread`) |
| Field issues, clarifications, drafts | `services/fieldOps.ts` (every exported mutation and query) |
| Pilot configuration | `services/pilot/onboarding.ts` `assertPilotProjectAccess` |
| Funder report assembly | `report/data.ts` `assembleReportData` |

`authz-test.js` calls each of these **directly, with no HTTP**, and asserts
they still refuse.

---

## The predicate

`services/authz.ts` is the single definition. It is deliberately a **leaf**
— it imports only the database layer. An earlier arrangement had it import
`lenderAccess`, which reaches `budgetProgress` → `pilot/onboarding` →
`orchestrator` → `chat` → back to `authz`, and that cycle crashed the
process at module-evaluation time. `budgetProgress.canAccessProjectFinance`
and `lenderAccess.hasActiveMembership` now re-export from here, so there is
one implementation and nothing to drift.

A user may access a project when **any** of these hold:

1. **Organisational relationship** — the project's own organisation, any
   pilot counterparty organisation (implementing / contractor / funder /
   engineer), or an organisation that has raised a draw on the project.
2. **Active project membership** — an explicit, currently-effective
   membership row (the additive lender-layer model).
3. **Explicit pilot participation** — the administrator who created the
   draft, anyone with an active field assignment, or anyone who accepted a
   project-scoped invitation.

Clause 3 is not optional. A pilot project is routinely *owned* by a
counterparty organisation that the administrator who set it up does not
belong to, so organisation alone would lock out the person who created it.

Helpers built on the predicate:

- `requireProject(user, id)` — the project or a same-404 `AccessError`.
- `accessibleProjects(user)` / `accessibleProjectIds(user)` — the basis for
  every scoped listing.
- `requireMilestone(user, id)` — resolves the milestone **and** proves its
  project is reachable.
- `requireMilestoneInProject(user, projectId, milestoneId)` — the
  nested-object guard.
- `requireApprovalRequestAccess(user, request)` — resolves the owning
  project through whichever subject the request carries.

### Nested objects

A child id that *resolves* proves nothing: the row is real, it just belongs
to someone else. Routes accepting both a parent and a child verify the pair
— a field issue naming your project but another tenant's milestone is
refused, as is a clarification against a foreign milestone, an evidence
draft promoting a message from a thread you cannot read, and a draft whose
milestone and project disagree.

### Listings

Scoping a mutation but not the listing next to it leaks the same data more
conveniently. Scoped to `accessibleProjects`: Overview, Projects, the
Approvals queue and its CSV export, Ledger, Reports, Compliance, Insights,
Issues, the map context, the pilot dashboard, and the nav badge counters —
an unscoped count is a side channel that discloses how much work exists in
other tenants.

---

## Sessions

Identity was the raw user primary key: `obv_user=user-funder` was a
complete, forgeable credential that anyone could type. It is now a signed,
expiring token:

```
v1.<base64url(payload)>.<base64url(HMAC-SHA256(payload))>
```

`payload` carries the user id, issue time and expiry (24h). Verification is
constant-time, and **every** failure mode — bad MAC, edited payload,
stripped or empty MAC, unknown version, unparseable payload, expiry —
returns `null`, never a partially trusted session.

**The secret.** `OBV_SESSION_SECRET`, at least 32 characters, never
committed. `render.yaml` uses `generateValue: true`, so Render mints a
random one per service.

**Posture.** Production is declared explicitly via `OBV_ENVIRONMENT=pilot`
or `OBV_ENVIRONMENT=production` (the legacy `OBV_BANKING_MODE=production` /
`OBV_SESSION_REQUIRE_SECRET=1` flags remain a compatibility inference) —
deliberately **not** `NODE_ENV`, which
the Dockerfile sets for Node's own runtime behaviour. Keying on `NODE_ENV`
would have made every container refuse to start unless a secret happened to
be present, turning a hardening change into a deploy outage.

- Production posture, no secret → the process refuses to start with a
  one-line instruction (no stack trace), alongside the existing database and
  banking startup checks.
- Demo/dev/test, no secret → a random per-boot secret. Cookies are still
  unforgeable; they simply do not survive a restart, and the boot log says
  so.

**Cookie flags.** `HttpOnly`, `SameSite=Lax`, `Max-Age`, and `Secure` when
the request arrived over TLS or carried `x-forwarded-proto: https` (Render
terminates TLS upstream). Trusting that header can only ever *add* `Secure`
— a client cannot use it to remove the flag — so local development over
http keeps working.

**The demo switcher** (`GET /demo`, `POST /api/session`) is the demo's
passwordless sign-in. It now lists and accepts **only seeded `user-*`
identities**, so people created by real pilot invitations are neither
enumerated nor impersonable — they receive their session from the
invitation acceptance itself. Under production posture the whole switcher
returns 404. Unknown and non-seeded ids produce identical responses, so it
is not an existence oracle.

---

## Render tokens (PDF generation)

Chromium fetches report HTML back from the server and has no session. That
used to be a single process-wide `randomUUID()` that never expired and was
accepted for *any* report id — one leaked URL was a permanent, unscoped
read capability.

A render token (`http/previewToken.ts`) is now 32 random bytes, scoped to
one subject, single-purpose (only `/report-cache` accepts it, never in
place of a session anywhere else), short-lived (60s), and single-use —
consumed on the first attempt, so it cannot be probed subject by subject.

**WORM media.** `/worm/` is session-gated like `/comm-media/`. That would
normally break PDFs, because report HTML embeds evidence as
`<img src="/worm/…">` and those sub-resource requests carry no credential.
Rather than authorize them, the media is **inlined as `data:` URIs** when
the HTML is cached for rendering: the request no longer exists. This was
chosen over minting per-image tokens — those would be live read credentials
written into HTML that ships inside draw-verification and audit-package
ZIPs handed to external auditors — and over giving the renderer a real
session cookie, which would upgrade it from a least-privilege reader to a
full impersonation of the requesting user.

---

## What this pass did not change

No product features, no redesign, no new dependencies. Verification,
approval matrices, separation of duties, lender decisions, dispute and
legal holds, retainage, change orders, permits, banking safeguards and the
WORM ledger are untouched — `authz-test.js` counts ledger entries, approval
records, account events, bank transactions, payment instructions, banking
events, evidence rows and virtual-account balances before and after every
denied attempt and asserts they are byte-identical.

## Known limitations

- **Secret rotation invalidates every live session.** There is no key id
  and no multi-secret verification window. Acceptable for a pilot; a
  `kid` field would make rotation seamless.
- **The demo switcher is still passwordless** in demo posture. That is the
  product's sign-in, and closing it means adding real authentication, which
  is a product change rather than a hardening one. Production posture
  disables it outright.
- **Sessions are stateless.** There is no server-side revocation list, so a
  stolen cookie is valid until it expires (24h). Rotating the secret is the
  blunt revocation instrument.
- **`GET /` remains public** by design — the marketing homepage renders a
  seeded snapshot. It is not tenant data.
