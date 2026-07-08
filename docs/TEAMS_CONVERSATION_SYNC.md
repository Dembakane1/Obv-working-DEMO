# Microsoft Teams ↔ OBV conversation synchronization

Two-way coordination-message sync between bound OBV project/milestone
threads and Microsoft Teams channel conversations.

**Validation status: validated against a Graph-compatible local stub
(`scripts/teams-sync-test.js`, 40 checkpoints); real Microsoft tenant
validation still required.** Without credentials, OBV runs fully with
sync shown as "not configured".

## Trust model (permanent)

```
CHAT COORDINATES.  EVIDENCE PROVES.  VERIFICATION ASSESSES.
HUMANS AUTHORIZE THROUGH THE FORMAL APPROVAL WORKFLOW.  LEDGER RECORDS.
```

A Teams message can NEVER: create an ApprovalRecord, satisfy an approval
requirement, call the VirtualAccountService, change HELD→RELEASED,
become verified evidence, bypass the EvidenceItem workflow, or bypass
role permissions. The bridge module imports nothing from the approval
workflow, verification pipeline, or virtual account — an inbound message
can only ever become a ChatMessage row. Proven by tests 16–20 and 31–34.

## Two separate integrations (do not merge)

| | TeamsNotifier (existing, unchanged) | TeamsConversationBridge (new) |
|---|---|---|
| Purpose | One-way workflow EVENT cards | Two-way coordination MESSAGES |
| Transport | Incoming webhook (`TEAMS_WEBHOOK_URL`) | Microsoft Graph app credentials |
| Content | Verification, approvals, release, integrity alerts | Human TEXT + explicitly shared references |
| Failure mode | Never blocks workflow | Never blocks chat, evidence, or governance |

## Architecture

```
src/server/services/teamsSync/
  types.ts          ExternalConversationProvider interface +
                    NormalizedInboundMessage (OBV depends on these only)
  config.ts         GRAPH_CONFIG (server-side env) + derived clientState
  graphProvider.ts  ALL Graph-specific code: client-credentials token
                    cache, channel message send/fetch, subscriptions,
                    HTML→text normalization, sanitized error categories
  bridge.ts         Business logic: bindings, outbound allowlist sync,
                    inbound processing, dedupe/loop prevention, identity
                    mapping, subscription lifecycle
```

Data (additive): `external_thread_bindings` (one per thread; ids only,
never credentials), `external_identity_mappings` (explicit Teams→OBV
user mapping), and message columns `origin`, `edited_at`,
`original_body`, `external_deleted`, `attachments`, plus a partial
unique index on `(thread_id, external_message_id)`.

## Deduplication & loop prevention

- `origin = OBV_LOCAL` messages may sync outbound **once** — a stored
  `external_message_id` short-circuits any retry.
- `origin = TEAMS_INBOUND` messages are never outbound candidates.
- An inbound notification whose message id already exists is a no-op —
  including the Graph echo of our own outbound message.
- Notification replays hit the database-level unique index even if
  application checks race.

## Outbound allowlist

Syncs outward: human TEXT; explicitly shared EVIDENCE_REFERENCE /
MILESTONE_REFERENCE / REPORT_REFERENCE (rendered as clean context blocks
with OBV deep links — page links only, never gated file URLs, and no
Teams-side action can record anything). Never syncs: SYSTEM_EVENT rows,
AI provenance, hash/audit noise, demo resets. TeamsNotifier keeps
delivering the high-value workflow cards, so there is no duplicate noise.

## Edits, deletions, attachments

- Teams **edit** → display body updates, original preserved
  (`original_body`), `edited_at` recorded, "edited in Teams" shown.
- Teams **delete** → marked deleted, audit metadata preserved, UI shows
  "Message deleted in Microsoft Teams". Chat history is auditable — it
  is NOT the Evidence Ledger; only the hash-chained ledger carries
  integrity guarantees, and edit/delete events never touch it.
- **Attachments** are communication artifacts (name + link). They are
  never ingested as evidence; evidence enters only through the governed
  Field Capture submission workflow.

## Environment variables (server-side only; never commit values)

| Variable | Purpose |
|---|---|
| `MICROSOFT_TENANT_ID` | Entra tenant id |
| `MICROSOFT_CLIENT_ID` | App registration client id |
| `MICROSOFT_CLIENT_SECRET` | Client secret (never exposed to browser/logs) |
| `OBV_TEAMS_WEBHOOK_PUBLIC_URL` | Public notification URL (defaults to `<OBV_PUBLIC_BASE_URL>/api/teams-sync/notifications`) |
| `OBV_TEAMS_MAINTENANCE_KEY` | Optional key for external schedulers calling the maintenance endpoint |
| `OBV_TEAMS_SYNC_TIMEOUT_MS` | Provider timeout (default 8000) |
| `OBV_GRAPH_BASE_URL` / `OBV_GRAPH_LOGIN_URL` | Stub overrides for tests; leave unset in production |

## Real Microsoft tenant setup (still required)

1. **App registration** (Entra admin center): register a confidential
   client; create a client secret; note tenant/client ids.
2. **Permission model (implemented)**: reading + subscriptions use
   application permissions (tenant-wide `ChannelMessage.Read.All`, or
   the team-scoped RSC `ChannelMessage.Read.Group` via the Teams app in
   `integrations/teams-app/`); **sending uses delegated
   `ChannelMessage.Send`** through a dedicated OBV service account
   (refresh-token grant, obtained with `scripts/teams-delegated-auth.js`)
   — application permissions cannot create channel messages outside
   migration mode, and OBV never uses migration permissions. The full
   administrator walkthrough is `docs/TEAMS_REAL_TENANT_SETUP.md`.
3. **Public HTTPS notification URL**: the deployment must be reachable
   by Graph at `/api/teams-sync/notifications` (Render deployments are;
   the endpoint answers the validation handshake and authenticates every
   notification via the derived `clientState`).
4. Set the environment variables in the hosting dashboard and redeploy.
5. In OBV, a Project Manager or Funder Representative opens the thread →
   context panel → **Manage Teams Connection** and enters the target
   team id + channel id (from the Teams channel link or Graph explorer).
6. **Subscription renewal**: Graph channel-message subscriptions expire
   (~1 hour). Schedule `POST /api/teams-sync/maintain` (with the
   `X-OBV-Maintenance-Key` header) every ~30 minutes via any external
   scheduler, or renew manually from the connection panel (Reconnect).
   Failed renewals mark the binding DEGRADED — visible, never silent.
7. **Identity mapping**: insert rows into `external_identity_mappings`
   (Teams AAD user id → OBV user). Unmapped senders appear as
   "Name · via Microsoft Teams" with no OBV permissions; mapping is
   never guessed from display names.

## Demo mode

No credentials → internal chat, TeamsNotifier demo mode, hero loop,
reports, reset: all fully functional; the connection panel shows
"Teams conversation sync not configured" with setup pointers. No fake
Teams connections are ever displayed.
