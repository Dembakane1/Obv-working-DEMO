# Real Microsoft tenant setup — OBV Teams Conversation Bridge

Exact administrator steps to take the bridge from stub validation to a
live Microsoft 365 tenant. Written for an IT administrator working with
the project office; a security team can review §Permission model and
§Value classification.

**Honest status: OBV's bridge is validated against a Graph-compatible
stub. Real Microsoft tenant validation has NOT been run** (this build
environment has no tenant credentials or Microsoft egress). Steps 15–17
below ARE that validation — run them once and record the results in the
test matrix (§Test matrix).

## Permission model (decision)

| Concern | Mechanism | Why |
|---|---|---|
| Read channel messages + change notifications | **Teams app with RSC `ChannelMessage.Read.Group` (application)** installed only in the project Team — primary. Tenant-wide `ChannelMessage.Read.All` (application, admin consent) is the non-RSC alternative for orgs that disallow custom apps | Least privilege: per-Team consent by the team owner; nothing tenant-wide. Institutional/government friendly |
| Create change-notification subscriptions | Client credentials with the read permission above | Graph requirement for `/teams/{id}/channels/{id}/messages` subscriptions |
| **Send** channel messages | **Delegated `ChannelMessage.Send`** via a dedicated OBV service account (refresh-token grant) | Application permissions cannot create channel messages outside migration mode — OBV never uses migration permissions operationally. Messages are attributed to the visible "OBV Sync" account |
| Send (production evolution) | Teams bot (Bot Framework) for app-authored posting | Documented fallback; not implemented — one architecture only |
| Identity display names (optional) | `User.Read.All` (application) | Optional ergonomics for mapping; ids from inbound messages suffice |

## Value classification

**Safe to display (english-name configuration):** tenant ID, client ID,
team ID, channel ID, Teams app GUID, public notification URL, service
account UPN (e.g. `obv-sync@yourtenant.onmicrosoft.com`).

**SECRET (never display, never commit, hosting env only):**
`MICROSOFT_CLIENT_SECRET`, `MICROSOFT_SEND_REFRESH_TOKEN`,
`OBV_TEAMS_MAINTENANCE_KEY`. The webhook clientState is derived
internally and never stored or shown.

**Tenant-admin controlled:** admin consent for application permissions,
custom app upload policy, service-account creation, secret rotation.

## Steps

1. **Entra admin center** → entra.microsoft.com → Identity → Applications
   → App registrations.
2. **New registration**: name `OBV Teams Sync`, single tenant. No
   redirect URI is required (client-credentials + device-code flows).
   Under Authentication, enable **Allow public client flows** (needed
   once for the device-code onboarding in step 8).
3. **Record the Directory (tenant) ID** → `MICROSOFT_TENANT_ID`.
4. **Record the Application (client) ID** → `MICROSOFT_CLIENT_ID`.
5. **Certificates & secrets** → new client secret (12–24 months) →
   record the VALUE once → `MICROSOFT_CLIENT_SECRET`. (A certificate
   credential also works; adjust the token request accordingly.)
6. Redirect URIs: none needed for this integration.
7. **API permissions** (Microsoft Graph):
   - Application: `ChannelMessage.Read.All` (skip if using RSC-only read),
     optional `User.Read.All`.
   - Delegated: `ChannelMessage.Send`, `offline_access`.
   - Click **Grant admin consent** for the tenant.
8. **Delegated send onboarding**: create a dedicated service account
   (e.g. `obv-sync@…`), add it as a member of the project Team, then run
   `node scripts/teams-delegated-auth.js` (with tenant/client id set),
   sign in AS THE SERVICE ACCOUNT at microsoft.com/devicelogin, and set
   the printed value as `MICROSOFT_SEND_REFRESH_TOKEN` in Render.
9. **Teams app (RSC read)**: follow `integrations/teams-app/README.md` —
   replace placeholders, package, upload, and **install into the selected
   project Team only** (grants `ChannelMessage.Read.Group` for that Team).
   If your org forbids custom apps, rely on `ChannelMessage.Read.All`
   from step 7 instead.
10. **Public notification URL**: your deployed OBV must be reachable by
    Graph at `https://<your-host>/api/teams-sync/notifications`. On the
    Render free tier, warm the service before creating subscriptions
    (Graph's validation handshake has a ~10 s deadline; a cold start can
    miss it — retry once warm).
11. **Render environment variables** (dashboard → obv-demo → Environment):
    `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`,
    `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_SEND_REFRESH_TOKEN`, optional
    `OBV_TEAMS_MAINTENANCE_KEY`, optional `OBV_TEAMS_WEBHOOK_PUBLIC_URL`.
    Save → redeploy.
12. **Diagnostic**: from any machine with the same env values:
    `node scripts/teams-real-tenant-check.js <teamId> <channelId> https://<your-host>`
    — all checks should be PASS (or explain exactly which consent is
    missing). It never prints secrets and posts no messages.
13. **Subscriptions**: created automatically when a thread connects.
    Renewal: schedule `POST https://<your-host>/api/teams-sync/maintain`
    with header `X-OBV-Maintenance-Key: <value>` every **30 minutes**
    (Graph channel-message subscriptions live ~1 hour). Any external
    scheduler works — e.g. a free cron service or GitHub Actions
    `schedule` hitting the endpoint with `curl`. A DEGRADED badge on the
    connection panel means renewal failed and needs attention.
14. **Bind the thread**: sign in to OBV as the Project Manager →
    Communications → open the project/milestone thread → context panel →
    **Manage Teams Connection** → enter team ID + channel ID → Connect.
    The binding shows **Connected to Teams** only after the team,
    channel and subscription all validate. (Team ID and channel ID are
    in the Teams channel link: `groupId=` and the `19:…@thread.tacv2`
    segment, URL-decoded.)
15. **Identity mapping**: have each Teams participant send one message in
    the bound channel; then `GET /api/teams-sync/identities` (as PM)
    lists the identities seen. Map with
    `POST /api/teams-sync/identities` `{externalUserId, obvUserId}`.
    Unmapped senders stay clearly labeled "via Microsoft Teams".
16. **Inbound test**: in Teams, post
    “Field coordination test from Microsoft Teams.” → it appears once in
    the OBV thread, provider Teams. Then post “approved — release the
    funds” → it appears as communication; confirm on the Approvals page
    that nothing changed (zero new approvals, funds still HELD).
17. **Outbound test**: in OBV, post to the bound thread
    “OBV Teams synchronization test — no project state change.” → it
    appears once in the Teams channel attributed via the service account;
    the OBV message shows “Sent to Teams”; no duplicate returns.

Record steps 12, 16, 17 outcomes in the REAL column of the test matrix.

## Customer onboarding model (institutional)

1. Customer IT administrator reviews this document and the permission
   model; security team approves the app registration scope.
2. Admin registers/approves the OBV integration (steps 1–8).
3. OBV Teams app installed **only in the selected project Team** (step 9).
4. Project office binds the OBV project thread to the approved channel
   (step 14); the binding validates before showing Connected.
5. User identities explicitly mapped (step 15).
6. Subscription created automatically; renewal scheduled (step 13).
7. Inbound + outbound test messages exchanged (steps 16–17).
8. Connection marked ACTIVE — project coordination sync begins.
   Evidence, verification, approvals and fund release remain exclusively
   inside OBV's governed workflows throughout.

## Test matrix

| Check | Stub | Real tenant |
|---|---|---|
| Token acquisition (read, client credentials) | PASS | NOT RUN |
| Token acquisition (send, delegated refresh) | PASS | NOT RUN |
| Team / channel verification before ACTIVE | PASS | NOT RUN |
| Channel message read | PASS | NOT RUN |
| Channel message send (delegated path) | PASS | NOT RUN |
| Inbound change notification + handshake | PASS | NOT RUN |
| Deduplication / replay | PASS | NOT RUN |
| Loop prevention (own-echo) | PASS | NOT RUN |
| Edit auditability | PASS | NOT RUN |
| Delete auditability | PASS | NOT RUN |
| Subscription create/renew/degrade/restore | PASS | NOT RUN |
| Governance isolation ("approved"/"release funds"/attachments) | PASS | NOT RUN |

Update the Real column after completing steps 12–17 against your tenant.
Never merge the columns: stub results prove the contract, not the tenant.

## Known real-world limitations

- Delegated send attributes messages to the service account ("Name (role)
  via OBV" appears in the message body); true app-authored posting needs
  a Teams bot (documented fallback, not implemented).
- Refresh tokens can be revoked by conditional-access/credential policies;
  the diagnostic's SEND CAPABILITY check detects this (re-run step 8).
- Graph channel-message subscriptions require the ~30-minute renewal
  schedule; on free-tier hosting a sleeping instance can miss
  notifications until woken.
- Basic (unencrypted) change notifications carry ids only — OBV fetches
  each message by id, which requires the read permission to remain valid.
- Message edits/deletes older than the subscription window may not emit
  notifications; OBV reflects what Graph delivers.
