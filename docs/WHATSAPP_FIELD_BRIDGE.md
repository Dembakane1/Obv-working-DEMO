# WhatsApp Field Operations Bridge

WhatsApp is where road crews, site supervisors, and local suppliers already
coordinate. OBV meets them there — **without ever letting chat become the
system of record**.

```
WHATSAPP COORDINATES.
OBV EVIDENCE PROVES.
VERIFICATION ASSESSES.
HUMANS AUTHORIZE THROUGH THE FORMAL OBV APPROVAL WORKFLOW.
THE EVIDENCE LEDGER RECORDS.
CHAT DOES NOT RELEASE FUNDS.
```

This is not a generic WhatsApp inbox. Every capability below exists to move
field coordination *toward* the formal evidence → verification → approval →
release workflow, never around it.

## Trust boundary (non-negotiable)

An inbound WhatsApp message — whatever it says, whatever media it carries —
can only ever become a **ChatMessage row with communication attachments**.
Enforced structurally, not by filters:

- `whatsappSync/bridge.ts` imports **nothing** from the approval workflow,
  verification pipeline, or `VirtualAccountService`. There is no code path
  from webhook to money.
- "approved", "release the funds", "site complete — pay the contractor":
  stored as text, displayed as text, nothing else. Proven by
  `scripts/whatsapp-sync-test.js` and `scripts/fieldops-test.js`.
- A photo/voice note/document/location from WhatsApp is a **communication
  artifact** in `data/comm-media/` (mutable, retention-managed) — never in
  the WORM evidence store. Evidence enters OBV exclusively through the
  governed submission pipeline (field capture, or the explicit
  Promote-to-Evidence-Draft flow, which itself ends in that same pipeline).

## Architecture

```
Meta Cloud API ── webhook (HMAC X-Hub-Signature-256, verify handshake)
      │                            │
      ▼                            ▼
provider.ts  ── normalizes ──▶  bridge.ts ── ChatMessage rows only
(all Meta payload shapes,       (identity, context, dedupe/loop
 media API, allowlist,           prevention, outbound policy)
 sanitized error categories)
```

- **`provider.ts`** — the only file that knows Meta payload shapes. Verifies
  signatures over the raw body (timing-safe), parses text / image / video /
  audio (incl. voice notes) / document / location / contacts / unsupported,
  downloads media (content-type allowlist, 16 MB cap, random safe filenames,
  malware-scan seam, never executed), sends text/template messages. Errors
  sanitize to categories; tokens never leave this module.
- **`bridge.ts`** — OBV-side logic. WhatsApp is 1:1, so instead of the Teams
  channel binding there is an **`ExternalParticipantContext`**: a coordinator
  explicitly assigns a phone number to a project thread (optionally with an
  expiry). Context is **never guessed from message text**. Unassigned senders
  land in the per-organization **"WhatsApp — Unresolved"** inbox thread.
- **Identity** — `external_identity_mappings` with `provider='WHATSAPP'`.
  First inbound records the identity UNMAPPED; an administrator explicitly
  maps it to an OBV user. Phone numbers render masked (`+265••••4821`).
- **Loop prevention** — same origin discipline as Teams: `WHATSAPP_INBOUND`
  is never an outbound candidate; stored external ids dedupe replays; the
  `(thread_id, external_message_id)` unique index backstops race conditions.
- **Outbound policy** (`WhatsAppOutboundPolicy`) — free-form sends only
  inside Meta's 24-hour service window; outside it, purposeful sends use an
  approved operational template (milestone review requested, clarification
  required, site-visit reminder, approval status update); plain chat stays
  internal and is honestly marked `SKIPPED`. Provider failures mark `FAILED`
  and never lose the internal message.
- **Rate limiting** — 30 inbound messages per sender per 5 minutes.

## Field Issues

Structured operational records raised from coordination (or directly):
category (QUALITY / SAFETY / MATERIAL / SCHEDULE / ACCESS / ENVIRONMENTAL /
DOCUMENTATION / EQUIPMENT / OTHER), severity, assignment, due date,
transition-validated lifecycle (OPEN → ACKNOWLEDGED / IN_PROGRESS →
AWAITING_FIELD_RESPONSE → RESOLVED → CLOSED) with an auditable event
timeline — an operational record, **not** the Evidence Ledger.

Issues inform human decisions. Nothing on an issue — severity, resolution,
anything — touches approvals, the virtual account, evidence, or the ledger.

## Clarification Requests

A reviewer asks the field for something specific (text / photo / document /
location / site revisit) against a milestone. The request mirrors into the
conversation; an inbound response links and sets `RESPONDED` — **at most**.
Acceptance is a separate, explicit reviewer decision, and acceptance itself
creates no approval record.

## Promote to Evidence Draft (governed)

Coordination photos are context, not proof — but sometimes a field photo is
worth formalizing. The path is deliberate:

1. Authorized user promotes an image attachment → **DRAFT** (no evidence
   tables touched). Provenance stays honest: source identity, provider
   message timestamp (not claimed as capture time), and a location **only**
   when explicitly associated with a location message from the same thread.
2. Explicit **Submit for Verification** runs `processEvidenceSubmission` —
   the *same* pipeline as field capture. Missing GPS stays missing, so the
   deterministic geofence check routes it to REVIEW per existing policy.
   Device metadata honestly states the communication origin. No fabricated
   capture metadata, ever.

## Configuration

All server-side, names-only in `.env.example`: `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`,
`WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`. Optional:
`WHATSAPP_API_VERSION`, `WHATSAPP_SYNC_TIMEOUT_MS`,
`OBV_WHATSAPP_API_BASE_URL` (contract-stub testing). Real-platform setup:
`docs/WHATSAPP_REAL_SETUP.md`. Unconfigured, the Integrations page shows an
honest "Not Configured" and everything else works fully.

## Privacy & retention

- Phone numbers masked everywhere in the UI; full numbers live only in
  identity/context rows.
- Tokens/secrets never appear in logs, pages, or API responses; provider
  errors reduce to sanitized categories.
- Communication media lives in `data/comm-media/` outside WORM storage, so
  ordinary retention (deletion) policies can apply to chat artifacts without
  touching the evidence ledger. A demo reset clears it with the rest of the
  data directory.
- Voice notes remain playable audio; no transcription provider is configured
  (a seam exists), and a transcript could never constitute approval.

## Tests

- `scripts/whatsapp-sync-test.js` — 47 checkpoints against a
  Cloud-API-compatible stub: signature/handshake security, inbound
  normalization for every media type, allowlist/size-cap rejection, context
  resolution, dedupe/replay/loop prevention, outbound policy, delivery
  statuses, failure isolation, governance isolation, rate limiting.
- `scripts/fieldops-test.js` — 40 checkpoints: issues/clarifications/drafts
  lifecycles and, non-negotiably, that none of it moves money — only the
  complete formal approval workflow releases a tranche.

Stub validation only proves the contract boundary. **Do not claim live
WhatsApp connectivity until a real message has been exchanged with the real
platform** (see the validation checklist in `WHATSAPP_REAL_SETUP.md`).
