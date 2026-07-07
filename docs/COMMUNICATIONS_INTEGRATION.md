# OBV Communications — Teams & WhatsApp integration architecture

Status: **OBV internal messaging is real and shipped.** Teams and WhatsApp
are architecture-ready seams — no external connectivity is implemented or
simulated, and no Meta/Microsoft credentials are required to run OBV.

## Doctrine (applies to every provider, present and future)

```
CHAT COORDINATES.  MAP EXPLAINS WHERE.  EVIDENCE PROVES.
VERIFICATION ASSESSES.  HUMANS AUTHORIZE.  LEDGER RECORDS.
```

- A message — from any provider — is text. Message content can NEVER
  create an ApprovalRecord, change an ApprovalRequest, or reach
  `VirtualAccountService`. `scripts/chat-test.js` proves this against the
  running server ("approved" / "release funds" messages change nothing).
- An inbound attachment is **communication until explicitly promoted**
  into an `EvidenceItem` through the governed evidence workflow
  (`POST /api/evidence` → verification pipeline → ledger → approval).
  A chat photo never becomes verified evidence automatically.
- The Communications timeline is auditable (stable timestamps, sender
  attribution, no editing/deletion) but it is NOT the Evidence Ledger.
  Only the hash-chained ledger carries integrity guarantees.

## What exists today (the seam)

| Piece | Where | Purpose |
|---|---|---|
| `provider` enum `OBV \| TEAMS \| WHATSAPP` | `messages.provider` | Marks message origin; UI already renders a provider tag for non-OBV messages |
| `external_thread_id` | `messages` + reserved for thread mapping | Future: map an OBV thread to a Teams channel/thread id or WhatsApp conversation |
| `external_message_id` | `messages` | Future: dedupe inbound webhook deliveries (at-least-once → exactly-once) |
| `deliveryStatus` | `messages` | `SENT / PENDING / FAILED` for future outbound sync |
| `ConversationThread.scope` + context ids | `conversation_threads` | Deterministic routing target for inbound messages |
| `TeamsNotifier` (unchanged) | `services/TeamsNotifier.ts` | One-way governance NOTIFICATIONS. Deliberately separate from chat persistence — notification cards are not conversation messages |

## Future Teams conversation sync (not implemented)

Direction:

1. **Thread mapping** — an admin links an OBV project thread to a Teams
   channel (store the channel/thread id as `external_thread_id` on a
   thread-mapping row). One OBV thread ↔ one Teams thread; no fan-out.
2. **Outbound** — new OBV TEXT messages post to the mapped Teams thread
   via Microsoft Graph (`chatMessage` create), recording the returned id
   as `external_message_id`, `deliveryStatus` SENT/FAILED. Failures never
   block OBV (same resilience contract as TeamsNotifier).
3. **Inbound** — Graph change notifications (webhook + subscription
   renewal) deliver Teams replies; the handler:
   - drops deliveries whose `external_message_id` already exists (dedupe);
   - resolves identity: Teams AAD user → OBV user via an explicit mapping
     table (never trust display names); unmapped senders appear as
     provider-attributed external participants with no OBV permissions;
   - inserts a `provider: "TEAMS"` message into the mapped thread —
     nothing else. No workflow side effects.
4. **Threading rules** — replies stay in the mapped thread; Teams
   messages in unmapped channels are ignored; OBV SYSTEM_EVENT rows are
   never echoed to Teams (TeamsNotifier already covers governance events
   with proper Adaptive Cards — avoiding duplicate noise).
5. **Separation** — TeamsNotifier keeps owning notifications. Sync is a
   separate service with its own credentials (Graph app registration),
   so a sync failure can never break governance notifications.

## Future WhatsApp Business integration (not implemented)

Direction (WhatsApp Business Cloud API):

1. **Identity** — inbound `wa_id` (phone) → OBV user via an explicit,
   admin-managed mapping. Unknown numbers are rejected with a polite
   auto-reply; no guest access.
2. **Context resolution** — the field worker's mapped user + their single
   active project determines the default project thread; an explicit
   short-code convention (e.g. "M3: message…") may route to a milestone
   thread. Ambiguity falls back to Project General — never to another
   tenant's thread (same `canAccessThread` rules apply on write).
3. **Messages** — inserted with `provider: "WHATSAPP"`,
   `external_message_id` = WhatsApp message id (dedupe on webhook
   retries), body sanitized/length-capped like OBV messages.
4. **Media** — an image received on WhatsApp is stored as a chat
   attachment reference ONLY. The thread shows a "promote to evidence"
   affordance for an authorized FIELD user, which routes into the
   existing `POST /api/evidence` submission (photo + explicit milestone +
   capture metadata) — geofence/metadata checks run as usual and will
   flag missing GPS as REVIEW. Nothing is auto-verified.
5. **Governance language** — "approved", "release", "go ahead" over
   WhatsApp are text. The approval workflow is unreachable from the
   message path by construction (no code path exists), which
   `scripts/chat-test.js` asserts.

## Permissions model (current)

Access to a thread requires the user's organization to participate in the
thread's project (funder organization or implementing agency);
organization-scope threads require org membership. Unauthorized threads
return 404 (existence is not revealed). This is demo authorization on the
existing role model — production would replace it with real authn/authz
without changing the thread/message schema.
