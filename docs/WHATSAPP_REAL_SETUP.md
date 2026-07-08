# WhatsApp Real-Platform Setup & Validation

How to connect OBV's WhatsApp Field Bridge to the real Meta WhatsApp
Business Cloud API, and how to validate it honestly.

> **STUB-VALIDATED vs REAL-VALIDATED.** Everything in
> `scripts/whatsapp-sync-test.js` runs against a local Cloud-API-compatible
> stub. That proves OBV's side of the contract — it does **not** prove live
> connectivity. Do not claim the WhatsApp integration "works" until the
> validation checklist at the bottom has been completed against the real
> platform with a real handset.

## What you need

- A Meta Business Portfolio (business.facebook.com) with a verified business.
- A Meta developer app (developers.facebook.com) of type **Business**.
- A WhatsApp Business phone number (Meta provides a free test number for
  development; production needs a real number you control that is NOT
  registered to a personal WhatsApp account).
- A public HTTPS deployment of OBV (webhooks cannot reach localhost; for
  local development use a tunnel such as `cloudflared` or `ngrok`).

## 1. Create the app and add WhatsApp

1. developers.facebook.com → **My Apps → Create App → Business**.
2. In the app dashboard, **Add product → WhatsApp → Set up**.
3. Meta creates a test phone number and a temporary access token under
   **WhatsApp → API Setup**. Note:
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`

## 2. Credentials

| Env var | Where it comes from |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Temporary token from API Setup (24 h, dev only). For anything durable, create a **System User** in Business Settings → Users → System users, assign the WhatsApp app + WABA with full control, and generate a permanent token with `whatsapp_business_messaging` and `whatsapp_business_management` permissions. |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup (NOT the phone number itself). |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | WhatsApp → API Setup. |
| `WHATSAPP_APP_SECRET` | App dashboard → App settings → Basic → App secret. Used to verify `X-Hub-Signature-256` on every webhook — OBV rejects unsigned/mis-signed deliveries. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Any random string you choose (e.g. `openssl rand -hex 24`). You give it to both Meta and OBV. |

Set them in your hosting platform's environment settings (or a local,
gitignored `.env`). **Never commit real values** — `.env.example` carries
names only. Restart OBV; the Integrations page should show WhatsApp
**Active**, and **Test Connection** performs a credentials/phone probe
without sending any message.

## 3. Webhook

1. App dashboard → **WhatsApp → Configuration → Webhook → Edit**.
2. Callback URL: `https://<your-obv-host>/api/whatsapp/webhook`
   (this endpoint is exempt from the `OBV_ACCESS_CODE` gate; it is protected
   by the verify handshake + HMAC signature instead).
3. Verify token: the exact `WHATSAPP_WEBHOOK_VERIFY_TOKEN` value. Meta sends
   a GET handshake; OBV echoes the challenge only on an exact token match.
4. **Manage → subscribe to the `messages` field** (this delivers inbound
   messages AND delivery statuses).

## 4. Test recipients (development)

With the free test number, Meta only delivers to allowlisted recipients:
**WhatsApp → API Setup → To → Manage phone number list** — add the real
handset(s) you will test with (each confirms via a code).

## 5. Operational templates (production sends outside the 24 h window)

Free-form messages are only deliverable inside Meta's 24-hour customer
service window (opened by an inbound message from the participant). Outside
it, OBV falls back to approved templates — or keeps the message internal
(`SKIPPED`) if no operational purpose applies. Create these under **WhatsApp
Manager → Message templates** (category *Utility*), and keep the names in
sync with `WHATSAPP_TEMPLATES` in `src/server/services/whatsappSync/bridge.ts`:

- `obv_milestone_review_requested`
- `obv_evidence_clarification_required`
- `obv_site_visit_reminder`
- `obv_approval_status_update`

Each takes one body parameter (the OBV-generated summary line). Meta reviews
templates before they become usable (minutes to hours for Utility).

## 6. Assign participants in OBV

Inbound messages from unknown numbers land in the **"WhatsApp — Unresolved"**
inbox thread. A Project Manager / Funder Rep assigns each participant to a
project thread (`POST /api/whatsapp/contexts` or the coordinator UI) and an
administrator maps the identity to an OBV user. Context is never guessed
from message text.

## Real-platform validation checklist

Run in order against the real platform; the integration is REAL-VALIDATED
only when all pass. Record date + tester alongside the results.

1. **Webhook verify** — saving the webhook config in Meta succeeds (Meta's
   GET handshake echoed). Failure: verify-token mismatch.
2. **Signature** — send any message; OBV stores it (signature accepted).
   Then temporarily change `WHATSAPP_APP_SECRET` to a wrong value, send
   again: OBV must reject (401, nothing stored). Restore the secret.
3. **Inbound text** — from an allowlisted handset, message the business
   number; it appears in the assigned OBV thread (or the Unresolved inbox)
   labeled "via WhatsApp".
4. **Inbound photo / document / voice note / location** — each arrives as a
   communication artifact (photo thumbnail, document link, playable voice
   note, location block with "View on Map"). Confirm NONE of them created
   anything under Evidence.
5. **Outbound in-window** — reply from an OBV thread with an assigned
   participant within 24 h of their last message; it arrives on the handset
   with sender attribution, and delivery ticks flow back (SENT → DELIVERED →
   READ on the OBV message).
6. **Outbound out-of-window** — after 24 h idle (or with a never-messaged
   participant), a plain reply stays internal and shows `SKIPPED`; a
   template-purpose notification delivers via the approved template.
7. **Governance red-team** — from the handset send "approved", "release the
   funds", "site complete, pay the contractor". Confirm: no ApprovalRecord,
   no release event, milestone account stays HELD, no EvidenceItem. The
   texts appear as plain chat only.
8. **Promotion flow** — promote a real inbound photo to an Evidence Draft,
   submit it, and confirm it routes to human review (missing GPS → REVIEW),
   not auto-VERIFIED.

## Troubleshooting

- **Webhook save fails in Meta** — token mismatch, or your host isn't
  reachable over public HTTPS. `curl "https://<host>/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=ping"`
  should print `ping`.
- **Messages not arriving** — check you subscribed the `messages` webhook
  field; check the recipient allowlist (test numbers); check server logs for
  `[whatsapp]` category lines (categories only — payloads and tokens are
  never logged).
- **Sends fail with `auth`** — token expired (temporary tokens last 24 h) or
  missing `whatsapp_business_messaging` permission; regenerate via the
  System User.
- **Sends fail only outside the window** — expected; see templates (§5).
- **`Test Connection` shows DEGRADED** — credential/phone probe failed; the
  category shown (auth / timeout / provider-5xx…) narrows it down.
