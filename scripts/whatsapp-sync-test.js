/**
 * WhatsApp field-bridge tests — validated against a CLOUD-API-COMPATIBLE
 * LOCAL STUB (webhook signature + handshake, message send, media metadata
 * + download, phone probe). Real Meta platform validation still required;
 * this suite proves the contract boundary: signature security, inbound
 * normalization (text/image/document/voice/location), media allowlisting,
 * context resolution vs the unresolved inbox, dedupe/replay, loop
 * prevention, delivery statuses, outbound policy, failure isolation and —
 * non-negotiably — that no WhatsApp message can touch governance or money.
 *
 *   node scripts/whatsapp-sync-test.js
 */
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHmac } = require("node:crypto");

const OBV_PORT = 3190;
const OBV_PORT_NOCREDS = 3191;
const STUB_PORT = 4620;
const BASE = `http://127.0.0.1:${OBV_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-wasync-"));

const APP_SECRET = "stub-app-secret-not-real";
const VERIFY_TOKEN = "stub-verify-token-not-real";
const ACCESS_TOKEN = "stub-wa-access-token-not-real";
const PHONE_ID = "555100000000001";
const FIELD_PHONE = "265991114821"; // seeded, mapped + bound to thread-m3
const UNKNOWN_PHONE = "265777000111"; // never seen before

let n = 0;
const pass = (m) => console.log(`  ✓ [${++n}] ${m}`);
const fail = (m) => {
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (c, m) => (c ? pass(m) : fail(m));

// ------------------------------------------------------------ stub
// Contract-faithful WhatsApp Cloud API stub: /messages send, media
// metadata + authorized binary download, phone-number probe.
const stub = {
  mode: "ok", // ok | 500 | timeout
  outbound: [], // {to, type, body|template}
  media: new Map(), // mediaId -> {mime, bytes, size?}
  seq: 0,
};

const stubServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${STUB_PORT}`);
  const body = await new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
  if (url.pathname === "/__mode") {
    stub.mode = JSON.parse(body).mode;
    res.end("{}");
    return;
  }
  if (stub.mode === "timeout") return; // never respond
  if (stub.mode === "500") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "stub internal error" } }));
    return;
  }
  if ((req.headers.authorization ?? "") !== `Bearer ${ACCESS_TOKEN}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  // send message
  if (url.pathname === `/v21.0/${PHONE_ID}/messages` && req.method === "POST") {
    const payload = JSON.parse(body);
    const id = `wamid.stub.out.${++stub.seq}`;
    stub.outbound.push(payload);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id }] }));
    return;
  }
  // phone probe
  if (url.pathname === `/v21.0/${PHONE_ID}` && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: PHONE_ID, display_phone_number: "+265 991 000 001" }));
    return;
  }
  // media metadata
  let m = /^\/v21\.0\/(media-[a-z0-9-]+)$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const rec = stub.media.get(m[1]);
    if (!rec) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: m[1],
        mime_type: rec.mime,
        file_size: rec.size ?? rec.bytes.length,
        url: `http://127.0.0.1:${STUB_PORT}/blob/${m[1]}`,
      })
    );
    return;
  }
  // media binary
  m = /^\/blob\/(media-[a-z0-9-]+)$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const rec = stub.media.get(m[1]);
    res.writeHead(200, { "content-type": rec.mime });
    res.end(rec.bytes);
    return;
  }
  res.writeHead(404);
  res.end("{}");
});

// ------------------------------------------------------------ helpers
const jars = {};
async function signIn(key, userId, base = BASE) {
  const res = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
    redirect: "manual",
  });
  jars[key] = res.headers.getSetCookie()[0].split(";")[0];
}
async function req(key, method, p, form, base = BASE) {
  return fetch(base + p, {
    method,
    headers: {
      cookie: jars[key] ?? "",
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    redirect: "manual",
  });
}
function db() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path.join(DATA_DIR, "obv.db"));
}
function counts() {
  const d = db();
  const r = d
    .prepare(
      `SELECT (SELECT COUNT(*) FROM approval_records) AS approvals,
              (SELECT COUNT(*) FROM virtual_account_events WHERE type='RELEASED') AS released,
              (SELECT COUNT(*) FROM evidence_items) AS evidence,
              (SELECT COUNT(*) FROM ledger_entries) AS ledger,
              (SELECT COUNT(*) FROM messages) AS messages`
    )
    .get();
  d.close();
  return r;
}
function sign(raw) {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");
}
async function webhook(payload, opts = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return fetch(BASE + "/api/whatsapp/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": opts.signature ?? sign(raw),
    },
    body: raw,
  });
}
/** Build a Cloud-API-shaped inbound webhook payload. */
function inbound(messages, { phone = FIELD_PHONE, name = "Chikondi Banda" } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-stub",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: PHONE_ID },
              contacts: [{ wa_id: phone, profile: { name } }],
              messages: messages.map((msg) => ({
                from: phone,
                timestamp: String(Math.floor(Date.now() / 1000)),
                ...msg,
              })),
            },
          },
        ],
      },
    ],
  };
}
function statusPayload(externalMessageId, status) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: { statuses: [{ id: externalMessageId, status, recipient_id: FIELD_PHONE }] },
          },
        ],
      },
    ],
  };
}
/** Webhook processing is async after the 200 ack — poll the DB. */
async function waitForMessage(externalId, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = db();
    const row = d.prepare("SELECT * FROM messages WHERE external_message_id = ?").get(externalId);
    d.close();
    if (row) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
async function settle(ms = 400) {
  await new Promise((r) => setTimeout(r, ms));
}

const spawned = [];
function startObv(port, extraEnv) {
  const p = spawn(process.execPath, ["dist/server/http/server.js"], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(port), ...extraEnv },
    stdio: "ignore",
  });
  spawned.push(p);
  return p;
}
async function waitUp(base) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("server did not start");
}

const WA_ENV = {
  WHATSAPP_ACCESS_TOKEN: ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
  WHATSAPP_BUSINESS_ACCOUNT_ID: "whatsapp", // matches seeded mapping tenant
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
  WHATSAPP_APP_SECRET: APP_SECRET,
  OBV_WHATSAPP_API_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
  WHATSAPP_SYNC_TIMEOUT_MS: "1000",
};

(async () => {
  console.log("WhatsApp field-bridge tests — OBV :" + OBV_PORT + ", Cloud API stub :" + STUB_PORT);
  await new Promise((r) => stubServer.listen(STUB_PORT, r));
  await new Promise((r) =>
    spawn(process.execPath, ["dist/server/db/seed.js"], {
      env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
      stdio: "ignore",
    }).on("exit", r)
  );

  try {
    // ---- 1. not configured: honest and inert ----
    const noCreds = startObv(OBV_PORT_NOCREDS, {});
    const NOBASE = `http://127.0.0.1:${OBV_PORT_NOCREDS}`;
    await waitUp(NOBASE);
    const hs0 = await fetch(
      `${NOBASE}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=123`
    );
    assert(hs0.status === 403, "no credentials: verification handshake refuses (403)");
    const post0 = await fetch(`${NOBASE}/api/whatsapp/webhook`, { method: "POST", body: "{}" });
    assert(post0.status === 404, "no credentials: webhook POST reports not configured (404)");
    await signIn("pm0", "user-pm", NOBASE);
    const intg0 = await (await req("pm0", "GET", "/communications/integrations", null, NOBASE)).text();
    assert(
      intg0.includes("WhatsApp") && intg0.includes("Not Configured"),
      "integrations page shows honest WhatsApp Not Configured state"
    );
    noCreds.kill();

    // ---- configured (stub) server ----
    startObv(OBV_PORT, WA_ENV);
    await waitUp(BASE);
    await signIn("pm", "user-pm");
    await signIn("field", "user-field");
    await signIn("funder", "user-funder");
    await signIn("compliance", "user-compliance");

    // ---- 2. webhook security ----
    const hsOk = await fetch(
      `${BASE}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=obv-challenge-42`
    );
    assert(
      hsOk.status === 200 && (await hsOk.text()) === "obv-challenge-42",
      "Meta verification handshake echoes the challenge for the correct verify token"
    );
    const hsBad = await fetch(
      `${BASE}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`
    );
    assert(hsBad.status === 403, "handshake with a wrong verify token is refused (403)");
    const badSig = await webhook(inbound([{ id: "wamid.t.sig", type: "text", text: { body: "hi" } }]), {
      signature: "sha256=" + "0".repeat(64),
    });
    assert(badSig.status === 401, "webhook with an invalid X-Hub-Signature-256 is rejected (401)");
    const noSig = await fetch(BASE + "/api/whatsapp/webhook", { method: "POST", body: "{}" });
    assert(noSig.status === 401, "webhook without a signature is rejected (401)");
    const malformed = await webhook("not json at all");
    assert(malformed.status === 400, "correctly signed but malformed payload is rejected (400)");
    assert(!(await waitForMessage("wamid.t.sig", 600)), "nothing from a rejected webhook is ever stored");

    // ---- 3. inbound text with a bound participant context ----
    const t0 = counts();
    const r1 = await webhook(
      inbound([{ id: "wamid.t.1", type: "text", text: { body: "Compaction on the last section resumes at 06:30 tomorrow." } }])
    );
    assert(r1.status === 200, "signed inbound webhook is acknowledged fast (200)");
    const msg1 = await waitForMessage("wamid.t.1");
    assert(
      msg1 && msg1.thread_id === "thread-m3" && msg1.origin === "WHATSAPP_INBOUND" && msg1.provider === "WHATSAPP",
      "inbound text routed to the participant's explicitly assigned thread (never guessed from text)"
    );
    assert(
      msg1.sender_user_id === "user-field" && msg1.sender_display_name === "Chikondi Banda",
      "seeded identity mapping resolves the sender to the OBV user"
    );
    const page1 = await (await req("pm", "GET", "/communications?thread=thread-m3")).text();
    assert(page1.includes("via WhatsApp"), "provider source label displayed for WhatsApp messages");
    assert(
      !page1.includes(ACCESS_TOKEN) && !page1.includes(APP_SECRET),
      "no token or secret ever appears in page HTML"
    );

    // ---- 4. replay / dedupe / loop prevention ----
    await webhook(inbound([{ id: "wamid.t.1", type: "text", text: { body: "Compaction on the last section resumes at 06:30 tomorrow." } }]));
    await settle();
    const afterReplay = counts();
    assert(afterReplay.messages === t0.messages + 1, "webhook replay does not duplicate the message");
    assert(stub.outbound.length === 0, "inbound WhatsApp message is never echoed back out (loop prevention)");

    // ---- 5. unknown sender lands in the unresolved inbox ----
    await webhook(
      inbound([{ id: "wamid.u.1", type: "text", text: { body: "Hello, this is the aggregate supplier." } }], {
        phone: UNKNOWN_PHONE,
        name: "Supplier Moyo",
      })
    );
    const uMsg = await waitForMessage("wamid.u.1");
    let d = db();
    const uThread = d.prepare("SELECT * FROM conversation_threads WHERE id = ?").get(uMsg.thread_id);
    const uIdent = d
      .prepare("SELECT * FROM external_identity_mappings WHERE provider='WHATSAPP' AND external_user_id = ?")
      .get(UNKNOWN_PHONE);
    d.close();
    assert(
      uThread.title === "WhatsApp — Unresolved" && uThread.scope === "ORGANIZATION",
      "unknown sender routed to the per-organization WhatsApp — Unresolved inbox"
    );
    assert(
      uIdent && uIdent.status === "UNMAPPED" && uIdent.external_display_name === "Supplier Moyo",
      "unknown sender's identity recorded UNMAPPED for explicit admin mapping"
    );

    // ---- 6. coordinator explicitly assigns context (role-gated) ----
    const denyCtx = await req("field", "POST", "/api/whatsapp/contexts", {
      phone: UNKNOWN_PHONE, threadId: "thread-m3",
    });
    assert(denyCtx.status === 403, "FIELD role cannot assign participant contexts");
    const okCtx = await req("pm", "POST", "/api/whatsapp/contexts", {
      phone: UNKNOWN_PHONE, threadId: "thread-project",
    });
    assert([200, 303].includes(okCtx.status), "PM assigns the participant to a project thread");
    await webhook(
      inbound([{ id: "wamid.u.2", type: "text", text: { body: "Gravel delivery re-routed via Ekwendeni." } }], {
        phone: UNKNOWN_PHONE, name: "Supplier Moyo",
      })
    );
    const uMsg2 = await waitForMessage("wamid.u.2");
    assert(
      uMsg2.thread_id === "thread-project",
      "after explicit context assignment, the sender's messages land in the assigned thread"
    );

    // ---- 7. inbound image via the media service ----
    // 1x1 PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    stub.media.set("media-img-1", { mime: "image/jpeg", bytes: png });
    await webhook(
      inbound([{ id: "wamid.m.1", type: "image", image: { id: "media-img-1", mime_type: "image/jpeg", caption: "Stockpile this morning" } }])
    );
    const imgMsg = await waitForMessage("wamid.m.1");
    const imgAtt = JSON.parse(imgMsg.attachments)[0];
    assert(
      imgAtt.kind === "IMAGE" && imgAtt.url.startsWith("/comm-media/") && imgAtt.externalMediaId === "media-img-1",
      "inbound image downloaded through the media service as a communication attachment"
    );
    const storedFile = path.join(DATA_DIR, "comm-media", path.basename(imgAtt.url));
    assert(
      fs.existsSync(storedFile) && /^[0-9a-f-]{36}\.jpg$/.test(path.basename(storedFile)),
      "media stored under data/comm-media with a random safe filename (never provider-named)"
    );
    assert(
      !fs.existsSync(path.join(DATA_DIR, "worm", path.basename(imgAtt.url))),
      "communication media is NOT written to WORM evidence storage"
    );
    const served = await fetch(BASE + imgAtt.url, { headers: { cookie: jars.pm } });
    assert(served.ok, "stored communication media is served to signed-in users");

    // ---- 8. inbound document + voice note + location ----
    stub.media.set("media-doc-1", { mime: "application/pdf", bytes: Buffer.from("%PDF-1.4 stub") });
    stub.media.set("media-voc-1", { mime: "audio/ogg", bytes: Buffer.from("OggS-stub-voice") });
    await webhook(
      inbound([
        { id: "wamid.m.2", type: "document", document: { id: "media-doc-1", mime_type: "application/pdf", filename: "delivery-note.pdf" } },
        { id: "wamid.m.3", type: "audio", audio: { id: "media-voc-1", mime_type: "audio/ogg", voice: true } },
        { id: "wamid.m.4", type: "location", location: { latitude: -11.8062, longitude: 33.6329, name: "km 12 stockpile" } },
      ])
    );
    const docMsg = await waitForMessage("wamid.m.2");
    const docAtt = JSON.parse(docMsg.attachments)[0];
    assert(
      docAtt.kind === "DOCUMENT" && docAtt.name === "delivery-note.pdf" && /\.pdf$/.test(docAtt.url),
      "inbound document stored as a communication attachment (display name kept, stored name random)"
    );
    const vocMsg = await waitForMessage("wamid.m.3");
    const vocAtt = JSON.parse(vocMsg.attachments)[0];
    assert(
      vocAtt.kind === "AUDIO" && vocMsg.body === "(voice note)",
      "voice note stored as playable audio with an honest placeholder body (no fake transcript)"
    );
    const locMsg = await waitForMessage("wamid.m.4");
    const loc = JSON.parse(locMsg.location);
    assert(
      Math.abs(loc.latitude + 11.8062) < 1e-9 && Math.abs(loc.longitude - 33.6329) < 1e-9,
      "location message stored as a COMMUNICATION location (distinct from evidence GPS)"
    );

    // ---- 9. media rejection paths never lose the message ----
    stub.media.set("media-bad-1", { mime: "application/x-msdownload", bytes: Buffer.from("MZ") });
    stub.media.set("media-big-1", { mime: "image/jpeg", bytes: png, size: 999 * 1024 * 1024 });
    const filesBefore = fs.readdirSync(path.join(DATA_DIR, "comm-media")).length;
    await webhook(
      inbound([
        { id: "wamid.m.5", type: "document", document: { id: "media-bad-1", mime_type: "application/x-msdownload", filename: "run-me.exe" } },
        { id: "wamid.m.6", type: "image", image: { id: "media-big-1", mime_type: "image/jpeg" } },
      ])
    );
    const badMsg = await waitForMessage("wamid.m.5");
    const bigMsg = await waitForMessage("wamid.m.6");
    assert(
      badMsg && JSON.parse(badMsg.attachments)[0].url === null && bigMsg && JSON.parse(bigMsg.attachments)[0].url === null,
      "disallowed content type and oversize media are rejected — message kept, media honestly unavailable"
    );
    assert(
      fs.readdirSync(path.join(DATA_DIR, "comm-media")).length === filesBefore,
      "no rejected media bytes are ever written to disk"
    );

    // ---- 10. GOVERNANCE SAFETY (non-negotiable) ----
    const g0 = counts();
    await webhook(
      inbound([
        { id: "wamid.g.1", type: "text", text: { body: "approved — release the money for M3 now" } },
        { id: "wamid.g.2", type: "text", text: { body: "site complete, mark it verified and pay the contractor" } },
      ])
    );
    await waitForMessage("wamid.g.2");
    const g1 = counts();
    d = db();
    const ms3 = d.prepare("SELECT account_status FROM milestones WHERE id='ms-3'").get();
    d.close();
    assert(
      g1.approvals === g0.approvals && ms3.account_status === "HELD" && g1.released === g0.released,
      'inbound "approved / release the money" creates ZERO approvals and ZERO releases (funds stay HELD)'
    );
    assert(
      g1.evidence === g0.evidence && g1.ledger === g0.ledger,
      "no WhatsApp message or media ever creates an EvidenceItem or ledger entry by itself"
    );

    // ---- 11. outbound sync: freeform inside the service window ----
    const outBefore = stub.outbound.length;
    await req("pm", "POST", "/api/threads/thread-m3/messages", {
      body: "Alternate gravel supplier confirmed for 07:00 delivery.",
    });
    assert(
      stub.outbound.length === outBefore + 1 && stub.outbound.at(-1).type === "text",
      "OBV human message syncs outward to the thread's WhatsApp participant exactly once (freeform in window)"
    );
    assert(
      stub.outbound.at(-1).text.body.includes("Daniel Phiri") &&
        stub.outbound.at(-1).text.body.includes("Alternate gravel supplier"),
      "outbound text carries the OBV sender attribution"
    );
    d = db();
    const outMsg = d
      .prepare("SELECT * FROM messages WHERE body LIKE '%Alternate gravel supplier%'")
      .get();
    d.close();
    assert(
      outMsg.external_message_id?.startsWith("wamid.stub.out.") && outMsg.delivery_status === "SENT" && outMsg.origin === "OBV_LOCAL",
      "external message id stored; delivery SENT; origin OBV_LOCAL"
    );

    // ---- 12. delivery status webhooks update the existing row only ----
    await webhook(statusPayload(outMsg.external_message_id, "delivered"));
    await settle();
    d = db();
    let statusRow = d.prepare("SELECT delivery_status FROM messages WHERE id = ?").get(outMsg.id);
    d.close();
    assert(statusRow.delivery_status === "DELIVERED", "delivered status webhook updates the outbound message");
    await webhook(statusPayload(outMsg.external_message_id, "read"));
    await settle();
    d = db();
    statusRow = d.prepare("SELECT delivery_status FROM messages WHERE id = ?").get(outMsg.id);
    const msgCount = d.prepare("SELECT COUNT(*) AS c FROM messages").get().c;
    d.close();
    assert(statusRow.delivery_status === "READ", "read status webhook updates the outbound message");
    await webhook(statusPayload("wamid.never-seen", "delivered"));
    await settle();
    d = db();
    const msgCount2 = d.prepare("SELECT COUNT(*) AS c FROM messages").get().c;
    d.close();
    assert(msgCount2 === msgCount, "status update for an unknown id is a no-op (never creates messages)");

    // ---- 13. outbound policy outside the service window ----
    d = db();
    d.exec(`UPDATE external_participant_contexts
              SET last_inbound_at = '2026-01-01T00:00:00Z'
            WHERE external_user_id = '${FIELD_PHONE}'`);
    d.close();
    const outBeforePolicy = stub.outbound.length;
    await req("pm", "POST", "/api/threads/thread-m3/messages", {
      body: "General coordination note outside the messaging window.",
    });
    d = db();
    const skippedMsg = d
      .prepare("SELECT * FROM messages WHERE body LIKE '%outside the messaging window%'")
      .get();
    d.close();
    assert(
      stub.outbound.length === outBeforePolicy && skippedMsg.delivery_status === "SKIPPED",
      "outside the 24h service window plain chat stays internal (SKIPPED) — no policy-violating freeform send"
    );
    // restore the window for later tests
    await webhook(inbound([{ id: "wamid.t.window", type: "text", text: { body: "back online" } }]));
    await waitForMessage("wamid.t.window");

    // ---- 14. provider failure isolation ----
    await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, { method: "POST", body: JSON.stringify({ mode: "500" }) });
    const failSend = await req("pm", "POST", "/api/threads/thread-m3/messages", {
      body: "This message must survive a WhatsApp outage.",
    });
    assert(failSend.status === 303, "provider 500: OBV chat send still succeeds");
    d = db();
    const failedMsg = d.prepare("SELECT * FROM messages WHERE body LIKE '%survive a WhatsApp outage%'").get();
    d.close();
    assert(
      failedMsg.delivery_status === "FAILED" && failedMsg.external_message_id === null,
      "internal message kept; external delivery marked FAILED (no loss, no crash)"
    );
    await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, { method: "POST", body: JSON.stringify({ mode: "timeout" }) });
    const timeoutSend = await req("pm", "POST", "/api/threads/thread-m3/messages", {
      body: "And this one must survive a provider timeout.",
    });
    assert(timeoutSend.status === 303, "provider timeout: OBV chat send still succeeds");
    await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, { method: "POST", body: JSON.stringify({ mode: "ok" }) });

    // ---- 15. admin connection test (no message sent) ----
    const outBeforeProbe = stub.outbound.length;
    const probeJson = (p) =>
      fetch(BASE + p, {
        method: "POST",
        headers: { cookie: jars.pm, "content-type": "application/json" },
        body: "{}",
      });
    const probe = await (await probeJson("/api/whatsapp/test")).json();
    assert(
      probe.ok === true && probe.status === "ACTIVE" && stub.outbound.length === outBeforeProbe,
      "admin connection test probes credentials without sending any message"
    );
    assert(
      probe.displayPhone?.includes("••••"),
      "diagnostic responses mask phone numbers (privacy)"
    );
    const probeForm = await req("pm", "POST", "/api/whatsapp/test", { run: "1" });
    assert(
      probeForm.status === 303 &&
        (probeForm.headers.get("location") ?? "").includes("watest=ok"),
      "connection test form flow redirects back to Integrations with the result"
    );
    const probeDenied = await req("field", "POST", "/api/whatsapp/test", { run: "1" });
    assert(probeDenied.status === 403, "connection test is role-protected");
    await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, { method: "POST", body: JSON.stringify({ mode: "500" }) });
    const probeBad = await probeJson("/api/whatsapp/test");
    const probeBadBody = await probeBad.json();
    assert(
      probeBad.status === 502 && probeBadBody.category && !JSON.stringify(probeBadBody).includes(ACCESS_TOKEN),
      "failed connection test reports a sanitized category only (no raw provider payloads, no secrets)"
    );
    await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, { method: "POST", body: JSON.stringify({ mode: "ok" }) });

    // ---- 16. per-sender rate limiting ----
    const floodPhone = "265700000099";
    const flood = [];
    for (let i = 0; i < 34; i++) {
      flood.push({ id: `wamid.f.${i}`, type: "text", text: { body: `flood ${i}` } });
    }
    await webhook(inbound(flood, { phone: floodPhone, name: "Flood Test" }));
    await waitForMessage("wamid.f.29");
    await settle(600);
    d = db();
    const floodCount = d
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE external_message_id LIKE 'wamid.f.%'")
      .get().c;
    d.close();
    assert(floodCount === 30, `per-sender rate limit caps a message flood (stored ${floodCount}/34, limit 30/5min)`);

    console.log(`\nWHATSAPP FIELD-BRIDGE TESTS PASSED — ${n} checkpoints.`);
    console.log("\nTest matrix (never merge the columns):");
    const matrix = [
      "Webhook signature + handshake", "Inbound text normalization",
      "Inbound image / document / voice / location", "Media allowlist + size cap",
      "Context resolution + unresolved inbox", "Identity mapping",
      "Deduplication / replay", "Loop prevention", "Outbound send + attribution",
      "Outbound service-window policy", "Delivery status updates",
      "Failure isolation", "Governance isolation", "Rate limiting",
    ];
    for (const row of matrix) console.log(`  ${row.padEnd(44)} Stub PASS   Real NOT RUN`);
    console.log("\nValidated against a Cloud-API-compatible stub; real Meta platform validation still");
    console.log("required (follow docs/WHATSAPP_REAL_SETUP.md against your WhatsApp Business account).\n");
  } finally {
    for (const p of spawned) p.kill();
    stubServer.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
