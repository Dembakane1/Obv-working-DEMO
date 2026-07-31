# OBV Production Identity Platform

The identity platform replaces the demonstration role switcher as the way
real people sign in, without touching the authorization model underneath.
Sign-in is **passwordless**: possession of a short-lived, single-use,
cryptographically random emailed link is the credential.

## Architecture

```
identities            one row per PERSON (unique normalized email)
identity_users        links an identity to the existing per-org `users`
                      rows — one membership per identity per organization
auth_tokens           single-use sign-in secrets (sha256 at rest)
auth_sessions         server-side revocable session records
auth_events           append-only authentication audit (no update/delete)
auth_lockouts         brute-force counters (email + ip scopes)
identity_providers    SSO readiness registry — DISABLED only, no write path
identity_provider_links   future provider-subject links — empty
mfa_methods           MFA/passkey readiness registry — DISABLED only
```

The load-bearing decision: **sessions still resolve to the existing
per-organization `users` rows.** `identity_users` links a durable person
to those rows; belonging to three organizations means three `users` rows
behind one identity. Authorization, tenant isolation, same-404 behavior,
portfolio scoping, banking access — all downstream code is structurally
unchanged, because the `User` it receives is the same object it always
received.

### One email, one identity — the anti-duplication rule

- An email address resolves to exactly one identity, forever
  (normalized: trimmed, lowercased, shape-validated).
- Accepting an invitation **never creates a second identity**, and never
  creates a second `users` row inside an organization the identity
  already belongs to: the existing membership is reused (and reactivated
  if it was suspended/deactivated). The existing role is kept — an
  invitation is not a silent role-change instrument; the difference is
  audited.
- An invitation to a **new** organization creates that organization's
  `users` row and links it to the same identity.
- Invitation acceptance proves mailbox control, so it also verifies the
  identity's email.
- **Acceptance signs the browser in only when it CREATED the identity.**
  Activation links are visible to the inviting administrator, so for a
  pre-existing account the link attaches the membership and then requires
  the person's own email sign-in — it can never become a bridge into an
  existing account or, through org switching, that person's other
  organizations.

## Authentication flow

1. `GET /signin` — email form. `POST /api/auth/magic-link` answers with
   **one generic message regardless of outcome** (unknown address,
   suspended identity, throttle, lockout — the audit log keeps the real
   reason; the response is a non-oracle).
2. A link `/auth/complete?token=<64-hex>` is delivered through the
   delivery seam (below). Only the sha256 of the token is stored; TTL is
   15 minutes (configurable).
3. `GET /auth/complete` renders a **confirmation form and never consumes
   the token** — inbox scanners that prefetch links cannot burn them. It
   also arms a short-lived `obv_confirm` cookie.
4. `POST /api/auth/complete` must echo the `obv_confirm` value (anti
   **login-CSRF**: a cross-site page can post a token but can neither
   read nor set our cookie, so it cannot sign a victim's browser into an
   attacker-chosen account). It then consumes the token via a guarded
   single-use update (`WHERE consumed_at IS NULL`): under a race exactly
   one request wins; replays fail. Every token failure — unknown,
   malformed, expired, consumed, tampered — returns the **byte-identical
   generic 400**.
5. A server-side session is created. The cookie is
   `obv_auth=<sessionId>.<secret>`; the database stores sha256(secret),
   compared in constant time on every request. HttpOnly, SameSite=Lax,
   Secure behind TLS.

### Sessions

- **Idle timeout** (default 60 min) slides with activity (touches are
  throttled to once a minute); **absolute timeout** (default 12 h) is
  fixed at sign-in and **never extends** — org switching rotates the
  session but inherits the original deadline.
- **Trusted devices** ("stay signed in longer") extend the absolute
  window to 30 days and do not idle-expire — only the absolute deadline
  bounds them; recorded per session.
- **Concurrent sessions** are first-class rows: `/account/security`
  lists every device with sign-in time, last activity, and expiry.
- **Revocation** is immediate and server-side: per-device revoke,
  sign-out, and sign-out-everywhere all mark rows revoked; expiry is
  recorded once with its reason (`IDLE_TIMEOUT` / `ABSOLUTE_TIMEOUT`).
- **Org switching** (`POST /api/auth/switch-org`) rotates to a new
  session bound to the target membership's `users` row; the old session
  records its successor (`rotated_to`). A membership id the identity
  does not hold is a plain 404 (same-404 doctrine).
- **CSRF**: every session-management POST requires the session's
  synchronizer token (form field `csrf` or header `x-obv-csrf`),
  compared in constant time against the server-side row. The `obv_csrf`
  cookie is a convenience copy; validation never trusts it.

### Brute force & rate limiting

- Failed completions count against `email:` and `ip:` scopes; 5 failures
  inside a 15-minute window lock the scope for 15 minutes (audited as
  `ACCOUNT_LOCKED`). While locked, even a valid token fails with the same
  generic message, and link requests silently stop delivering. The `ip:`
  scope reads the **last** X-Forwarded-For hop (the trusted proxy's
  append) — the client-supplied first entry could otherwise be rotated
  to dodge the lockout or spoofed to poison it for a victim.
- Link issuance is throttled per identity (5 per 15-minute window);
  throttled requests still answer generically.
- Successful sign-in clears the failure counters.

### Audit

`auth_events` is append-only — no UPDATE or DELETE statement for it
exists anywhere in the codebase (statically asserted by the test
battery). Recorded events include sign-in/out (single and everywhere),
link issued/throttled, replay blocked, expired/tampered attempts,
lockouts, CSRF rejections, session rotation/revocation/expiry, org
switches, invitation acceptance, membership suspension/restoration/
deactivation, and ownership transfers. Administrative membership actions
are additionally mirrored into the existing `config_audit` register.

## Organization membership

- **Ownership**: the first identity-linked member of an organization
  stewards it; `POST /api/auth/orgs/:orgId/transfer-ownership` moves the
  flag atomically (actor loses it in the same operation).
- **Suspension / restoration / deactivation** (owner-only, same org):
  suspension immediately revokes the member's live sessions for that
  organization; restore re-enables sign-in; deactivation is terminal —
  the way back in is a fresh invitation, which reactivates the existing
  membership in place (never duplicates). A non-owner attempting any of
  these gets the same 404 as for a membership that does not exist.
- **Membership history** is reconstructable from `auth_events`
  (`MEMBERSHIP_*`, `OWNERSHIP_TRANSFERRED`, `ORG_SWITCHED`).

## Demo mode vs production posture

| | Demo posture (default) | Production posture |
|---|---|---|
| Demo role switcher (`/demo`, `POST /api/session`) | Active (seeded identities only) | **404 — dead** |
| Magic-link sign-in (`/signin`) | Active alongside the switcher | The only sign-in |
| Unauthenticated page GETs | Redirect to `/demo` | Redirect to `/signin` |
| Session cookies | `obv_user` (signed) or `obv_auth` | **`obv_auth` only** — the legacy signed cookie is rejected even when correctly signed, because it is a bearer statement no revocation can reach |
| Link delivery | `file` outbox by default | `OBV_AUTH_LINK_DELIVERY` must be set **explicitly** or startup refuses |

Logout and logout-everywhere also expire the legacy `obv_user` cookie in
the browser, so signing out never leaves a second working credential.

Production posture is declared with `OBV_BANKING_MODE=production` or
`OBV_SESSION_REQUIRE_SECRET=1`, exactly as before.

### First-admin bootstrap

With `OBV_BOOTSTRAP_ADMIN_EMAIL` set and an **empty** identities table,
startup mints the founding identity, its organization
(`OBV_BOOTSTRAP_ORG_NAME`, default "OBV Operations"), and a
PROJECT_MANAGER `users` row so the first sign-in link has somewhere to
land. A non-empty table makes it a no-op — it can never resurrect or
duplicate anything.

### Link delivery seam

`deliverSignInLink` (src/server/services/identity/core.ts) is the single
place a sign-in link leaves the process. `OBV_AUTH_LINK_DELIVERY=file`
(default) appends to `auth-outbox.jsonl` under the data directory — a
development outbox; `off` mints without delivering. A real deployment
replaces the body of that one function with its email provider; nothing
else in the platform knows how links travel. Raw tokens are never
logged, never stored, and never appear in audit events.

## Passwords, SSO, MFA — architectural readiness only

- **Passwords**: `identities.password_hash` is a schema slot. No code
  path accepts, stores, or verifies a password (statically asserted).
- **Enterprise SSO**: provider-neutral shapes exist for Microsoft Entra
  ID, Okta, Google Workspace, Auth0, Ping Identity, generic OIDC, and
  generic SAML 2.0 (`identity_providers`, status-constrained DISABLED,
  no write path anywhere; `ssoEnabled()` is hard false and not
  configurable). `GET /api/auth/sso/readiness` reports the catalog.
- **MFA / passkeys**: TOTP, WebAuthn, and FIDO2 have a landing shape
  (`mfa_methods`, DISABLED only, no enrollment path).
  `GET /api/auth/mfa/readiness` reports the same.

Enabling any of these is a future code change, not a configuration flag.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OBV_BOOTSTRAP_ADMIN_EMAIL` | unset | First-admin bootstrap (empty table only) |
| `OBV_BOOTSTRAP_ORG_NAME` | `OBV Operations` | Bootstrap organization name |
| `OBV_AUTH_LINK_DELIVERY` | `file` | `file` (dev outbox) or `off` |
| `OBV_AUTH_LINK_TTL_MINUTES` | 15 | Magic-link lifetime |
| `OBV_AUTH_LINK_MAX_PER_WINDOW` | 5 | Links per identity per window |
| `OBV_AUTH_LINK_WINDOW_MINUTES` | 15 | Issuance-throttle window |
| `OBV_AUTH_IDLE_MINUTES` | 60 | Session idle timeout |
| `OBV_AUTH_ABSOLUTE_HOURS` | 12 | Session absolute timeout |
| `OBV_AUTH_TRUSTED_DEVICE_DAYS` | 30 | Trusted-device absolute window |
| `OBV_AUTH_LOCKOUT_THRESHOLD` | 5 | Failures before lockout |
| `OBV_AUTH_LOCKOUT_WINDOW_MINUTES` | 15 | Failure-counting window |
| `OBV_AUTH_LOCKOUT_MINUTES` | 15 | Lockout duration |

All identity configuration is validated at startup
(`assertIdentityConfig`, alongside the banking and session checks); a
misconfiguration refuses to start with a one-line instruction. No new
secrets are introduced: session secrets are per-session random values
hashed at rest, so there is nothing to configure and nothing to commit.

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /signin` | — | Email form (redirects if signed in) |
| `POST /api/auth/magic-link` | — | Request a link (generic non-oracle response) |
| `GET /auth/complete?token=` | — | Confirmation page (never consumes) |
| `POST /api/auth/complete` | — | Consume token, create session |
| `GET /account/security` | session | Sessions, devices, memberships, history, owner admin |
| `GET /api/auth/me` | session | Identity, memberships, current session view |
| `GET /api/auth/sessions` | session | Active sessions (no secret material) |
| `GET /api/auth/history` | session | Sign-in history |
| `POST /api/auth/logout` | session + CSRF | Sign out this device |
| `POST /api/auth/logout-all` | session + CSRF | Sign out everywhere |
| `POST /api/auth/sessions/:id/revoke` | session + CSRF | Per-device logout (same-404) |
| `POST /api/auth/switch-org` | session + CSRF | Rotate into another membership |
| `POST /api/auth/memberships/:id/suspend·restore·deactivate` | owner + CSRF | Membership administration |
| `POST /api/auth/orgs/:orgId/transfer-ownership` | owner + CSRF | Move stewardship |
| `GET /api/auth/sso/readiness`, `GET /api/auth/mfa/readiness` | session | Readiness reports (everything disabled) |

## Known limitations

- Link delivery ships with the development file outbox only; production
  email requires plugging a provider into the single delivery seam (and
  production posture refuses to start until a mode is chosen
  explicitly — the outbox stores live single-use links on the data
  volume, which an operator must opt into knowingly).
- Response **timing** on `POST /api/auth/magic-link` is not equalized:
  a known address does more work (token mint + delivery) than an unknown
  one, so a patient attacker measuring latency could infer address
  existence even though the response body is identical. This residual is
  shared by most magic-link systems; the audit log records every probe.
- Organization "owner" is an identity-platform stewardship concept for
  membership administration; it does not change any project-level
  authorization rule.
- Identity-level `status` (SUSPENDED/DEACTIVATED) exists and is enforced
  by every sign-in and session check, but no administrative surface
  writes it yet — membership-level suspension is the operative control.
- SSO and MFA are readiness-only by design for this milestone.
