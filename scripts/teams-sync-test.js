/**
 * Teams conversation-sync tests — validated against a GRAPH-COMPATIBLE
 * LOCAL STUB (token endpoint, channel messages, subscriptions, webhook
 * validation handshake). Real Microsoft tenant validation still required;
 * this suite proves the contract boundary, dedupe/loop prevention, edit/
 * delete auditability, failure isolation and — non-negotiably — that no
 * Teams message can touch governance or money.
 *
 *   node scripts/teams-sync-test.js
 */
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");

const OBV_PORT = 3180;
const OBV_PORT_NOCREDS = 3181;
const STUB_PORT = 4610;
const BASE = `http://127.0.0.1:${OBV_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-tsync-"));

const TENANT = "stub-tenant";
const SECRET = "stub-secret-not-real";
const CLIENT_STATE = createHash("sha256")
  .update(`obv-teams-sync:${TENANT}:${SECRET}`)
  .digest("hex")
  .slice(0, 32);

let n = 0;
const pass = (m) => console.log(`  ✓ [${++n}] ${m}`);
const fail = (m) => {
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (c, m) => (c ? pass(m) : fail(m));

// ------------------------------------------------------------ stub
// Contract-faithful Microsoft Graph stub: client-credentials token,
// channel message create/fetch, subscription create/renew/delete with a
// REAL validation handshake against the notification URL.
const stub = {
  mode: "ok", // ok | 500 | timeout
  outbound: [], // messages OBV posted to "Teams"
  store: new Map(), // messageId -> graph message payload
  tokenCalls: 0,
  subs: new Map(),
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
  if (stub.mode === "500" && !url.pathname.includes("oauth2")) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "stub internal error" } }));
    return;
  }
  // token endpoint — issues DISTINCT tokens per grant so the tests can
  // prove OBV uses the delegated strategy for sends and the application
  // strategy for reads (real Graph enforces exactly this split).
  if (url.pathname === `/${TENANT}/oauth2/v2.0/token`) {
    stub.tokenCalls++;
    const form = new URLSearchParams(body);
    if (form.get("grant_type") === "refresh_token") {
      if (form.get("refresh_token") !== "stub-refresh-token" && !String(form.get("refresh_token")).startsWith("rotated-")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: "stub-send-token",
        expires_in: 3600,
        refresh_token: "rotated-" + ++stub.seq, // Azure rotates refresh tokens
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "stub-read-token", expires_in: 3600 }));
    return;
  }
  const auth = req.headers.authorization ?? "";
  const isRead = auth === "Bearer stub-read-token";
  const isSend = auth === "Bearer stub-send-token";
  if (!isRead && !isSend) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  // team / channel verification (read token)
  let m = /^\/v1\.0\/teams\/([^/]+)$/.exec(url.pathname);
  if (m && req.method === "GET") {
    if (m[1] !== "t1") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "t1", displayName: "R47 Project Delivery" }));
    return;
  }
  m = /^\/v1\.0\/teams\/([^/]+)\/channels\/([^/]+)$/.exec(url.pathname);
  if (m && req.method === "GET") {
    if (m[2] !== "c1") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c1", displayName: "M3 Coordination" }));
    return;
  }
  // send channel message — REQUIRES the delegated send token (real Graph
  // rejects application-permission channel message creation).
  m = /^\/v1\.0\/teams\/([^/]+)\/channels\/([^/]+)\/messages$/.exec(url.pathname);
  if (m && req.method === "POST") {
    if (!isSend) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "application permissions cannot post channel messages" } }));
      return;
    }
    const id = `tmsg-out-${++stub.seq}`;
    const payload = JSON.parse(body);
    stub.outbound.push({ id, teamId: m[1], channelId: m[2], content: payload.body.content });
    stub.store.set(id, {
      id,
      from: { application: { id: "obv-app" } }, // our own app-authored message
      body: payload.body,
      createdDateTime: new Date().toISOString(),
    });
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id }));
    return;
  }
  // fetch message
  m = /^\/v1\.0\/teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(url.pathname);
  if (m && req.method === "GET") {
    const msg = stub.store.get(m[3]);
    if (!msg) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(msg));
    return;
  }
  // subscriptions
  if (url.pathname === "/v1.0/subscriptions" && req.method === "POST") {
    const payload = JSON.parse(body);
    // Real Graph validates the notification URL with a handshake token.
    const token = "validate-" + Math.random().toString(36).slice(2);
    const check = await fetch(
      `${payload.notificationUrl}?validationToken=${encodeURIComponent(token)}`,
      { method: "POST" }
    ).catch(() => null);
    const echoed = check && check.ok ? await check.text() : "";
    if (echoed !== token) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "validation handshake failed" } }));
      return;
    }
    const id = `sub-${++stub.seq}`;
    stub.subs.set(id, payload);
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, expirationDateTime: payload.expirationDateTime }));
    return;
  }
  m = /^\/v1\.0\/subscriptions\/([^/]+)$/.exec(url.pathname);
  if (m && req.method === "PATCH") {
    const payload = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: m[1], expirationDateTime: payload.expirationDateTime }));
    return;
  }
  if (m && req.method === "DELETE") {
    stub.subs.delete(m[1]);
    res.writeHead(204);
    res.end();
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
async function notify(items) {
  return fetch(BASE + "/api/teams-sync/notifications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: items }),
  });
}
function notifItem(messageId, changeType = "created", clientState = CLIENT_STATE, subId = null) {
  const d = db();
  const sub =
    subId ??
    d.prepare("SELECT subscription_id FROM external_thread_bindings LIMIT 1").get().subscription_id;
  d.close();
  return {
    subscriptionId: sub,
    clientState,
    changeType,
    resource: `teams('t1')/channels('c1')/messages('${messageId}')`,
    resourceData: { id: messageId },
  };
}
function seedInboundStubMessage(id, opts = {}) {
  stub.store.set(id, {
    id,
    from: { user: { id: opts.extUser ?? "ext-amina", displayName: opts.name ?? "Amina Ndlovu" } },
    body: { contentType: "html", content: opts.html ?? "<p>Hello from Teams</p>" },
    createdDateTime: new Date().toISOString(),
    ...(opts.attachments ? { attachments: opts.attachments } : {}),
    ...(opts.deleted ? { deletedDateTime: new Date().toISOString() } : {}),
  });
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

const GRAPH_ENV = {
  MICROSOFT_TENANT_ID: TENANT,
  MICROSOFT_CLIENT_ID: "stub-client",
  MICROSOFT_CLIENT_SECRET: SECRET,
  MICROSOFT_SEND_REFRESH_TOKEN: "stub-refresh-token",
  OBV_GRAPH_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
  OBV_GRAPH_LOGIN_URL: `http://127.0.0.1:${STUB_PORT}`,
  OBV_TEAMS_WEBHOOK_PUBLIC_URL: `http://127.0.0.1:${OBV_PORT}/api/teams-sync/notifications`,
  OBV_TEAMS_SYNC_TIMEOUT_MS: "1200",
  OBV_PUBLIC_BASE_URL: `http://127.0.0.1:${OBV_PORT}`,
};

(async () => {
  console.log("Teams conversation-sync tests — OBV :" + OBV_PORT + ", Graph stub :" + STUB_PORT);
  await new Promise((r) => stubServer.listen(STUB_PORT, r));
  await new Promise((r) =>
    spawn(process.execPath, ["dist/server/db/seed.js"], {
      env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
      stdio: "ignore",
    }).on("exit", r)
  );

  try {
    // ---- 1. no Graph credentials: everything still works ----
    const noCreds = startObv(OBV_PORT_NOCREDS, {});
    await waitUp(`http://127.0.0.1:${OBV_PORT_NOCREDS}`);
    await signIn("pm0", "user-pm", `http://127.0.0.1:${OBV_PORT_NOCREDS}`);
    const page0 = await (
      await req("pm0", "GET", "/communications?thread=thread-m3", null, `http://127.0.0.1:${OBV_PORT_NOCREDS}`)
    ).text();
    assert(
      page0.includes("Teams conversation sync not configured") &&
        page0.includes("compaction test certificate"),
      "no credentials: chat works and status shows Not Configured (no error banner)"
    );
    const bind0 = await fetch(`http://127.0.0.1:${OBV_PORT_NOCREDS}/api/threads/thread-m3/teams-binding`, {
      method: "POST",
      headers: { cookie: jars.pm0, "content-type": "application/json" },
      body: JSON.stringify({ action: "connect", teamId: "t1", channelId: "c1" }),
    });
    assert(bind0.status === 409, "no credentials: binding attempts are rejected honestly (409)");
    const intg0 = await (
      await req("pm0", "GET", "/communications/integrations", null, `http://127.0.0.1:${OBV_PORT_NOCREDS}`)
    ).text();
    assert(
      intg0.includes("Microsoft Teams conversation sync is not configured") &&
        intg0.includes("View Setup Requirements") &&
        intg0.includes("Not Configured") &&
        !intg0.includes("Run Diagnostic"),
      "integrations page: honest no-config state (setup requirements, no dead buttons, WhatsApp not faked)"
    );
    noCreds.kill();

    // ---- configured (stub) server ----
    startObv(OBV_PORT, GRAPH_ENV);
    await waitUp(BASE);
    await signIn("pm", "user-pm");
    await signIn("field", "user-field");
    await signIn("funder", "user-funder");
    await signIn("compliance", "user-compliance");

    // ---- 2. bind thread (incl. real validation handshake) ----
    const bindRes = await req("pm", "POST", "/api/threads/thread-m3/teams-binding", {
      action: "connect", teamId: "t1", channelId: "c1",
    });
    assert(bindRes.status === 303, "PM binds the M3 thread to a Teams channel");
    let d = db();
    const binding = d.prepare("SELECT * FROM external_thread_bindings").get();
    d.close();
    assert(
      binding.status === "ACTIVE" && binding.subscription_id && binding.subscription_expires_at,
      "binding ACTIVE only after team+channel+subscription validation succeeded"
    );
    assert(
      binding.team_name === "R47 Project Delivery" && binding.channel_name === "M3 Coordination",
      "validated team and channel display names stored (Connected to: names)"
    );
    // Unknown channel: validation fails, binding never shows Connected.
    const badBind = await fetch(BASE + "/api/threads/thread-project/teams-binding", {
      method: "POST",
      headers: { cookie: jars.pm, "content-type": "application/json" },
      body: JSON.stringify({ action: "connect", teamId: "t1", channelId: "wrong-channel" }),
    });
    d = db();
    const badRow = d.prepare("SELECT status FROM external_thread_bindings WHERE thread_id='thread-project'").get();
    d.close();
    assert(
      badBind.status === 502 && badRow && badRow.status !== "ACTIVE",
      "invalid channel: connect fails and the binding is NOT marked Connected"
    );
    const noAuth = await req("field", "POST", "/api/threads/thread-m3/teams-binding", {
      action: "connect", teamId: "t1", channelId: "c1",
    });
    assert(noAuth.status === 403, "FIELD role cannot manage Teams connections");

    // ---- 3-4. outbound sync, once, with external id ----
    await req("pm", "POST", "/api/threads/thread-m3/messages", {
      body: "Compaction certificate uploaded to the project file this morning.",
    });
    d = db();
    const outMsg = d
      .prepare("SELECT * FROM messages WHERE thread_id='thread-m3' AND sender_user_id='user-pm' ORDER BY created_at DESC LIMIT 1")
      .get();
    d.close();
    assert(
      stub.outbound.length === 1 && stub.outbound[0].content.includes("Compaction certificate"),
      "OBV human message sends outward exactly once"
    );
    pass("outbound send used the DELEGATED token (stub rejects app-permission posts with 403)");
    assert(
      outMsg.external_message_id === stub.outbound[0].id && outMsg.delivery_status === "SENT" && outMsg.origin === "OBV_LOCAL",
      "external message id stored; delivery SENT; origin OBV_LOCAL"
    );
    const pageSent = await (await req("pm", "GET", "/communications?thread=thread-m3")).text();
    assert(pageSent.includes("Sent to Teams"), "sender sees Sent to Teams delivery state");

    // Integrations page (configured): aggregate status, connected-thread
    // row with validated names, role-gated management.
    const intgPm = await (await req("pm", "GET", "/communications/integrations")).text();
    assert(
      intgPm.includes("R47 Project Delivery") &&
        intgPm.includes("M3 Coordination") &&
        intgPm.includes("Run Diagnostic") &&
        intgPm.includes("Disconnect") &&
        /Active \(integration test mode\)|>Active</.test(intgPm),
      "integrations page lists the connected thread with validated names and admin actions (PM)"
    );
    const intgField = await (await req("field", "GET", "/communications/integrations")).text();
    assert(
      intgField.includes("M3 Coordination") &&
        !intgField.includes("Run Diagnostic") &&
        !intgField.includes("Disconnect") &&
        intgField.includes("requires a Project Manager or Funder Representative"),
      "integrations page for FIELD: status visible, management actions hidden"
    );
    const convHeader = await (await req("pm", "GET", "/communications?thread=thread-m3")).text();
    assert(
      convHeader.includes("Microsoft Teams ·") && convHeader.includes("Manage Teams Connection"),
      "thread header shows compact Teams status and manage action for authorized roles"
    );
    const convField = await (await req("field", "GET", "/communications?thread=thread-m3")).text();
    assert(
      convField.includes("Microsoft Teams ·") && !convField.includes("Manage Teams Connection"),
      "thread header for FIELD shows status only (no management action)"
    );

    // ---- 5. echo of our own outbound message does not loop ----
    const before = counts();
    const echo = await notify([notifItem(outMsg.external_message_id)]);
    assert(echo.status === 202, "notification endpoint accepts the echo");
    assert(
      counts().messages === before.messages && stub.outbound.length === 1,
      "own outbound echo is a no-op — no duplicate, no re-send, no infinite loop"
    );

    // ---- 6. inbound Teams message appears once ----
    seedInboundStubMessage("tmsg-in-1", { html: "<p>Received — reviewing the certificate now.</p>" });
    await notify([notifItem("tmsg-in-1")]);
    d = db();
    const inMsg = d.prepare("SELECT * FROM messages WHERE external_message_id='tmsg-in-1'").get();
    d.close();
    assert(
      inMsg && inMsg.provider === "TEAMS" && inMsg.origin === "TEAMS_INBOUND" &&
        inMsg.sender_user_id === null && inMsg.sender_display_name === "Amina Ndlovu" &&
        inMsg.body.includes("reviewing the certificate"),
      "inbound Teams message stored once (provider TEAMS, unmapped identity, normalized body)"
    );
    const pageIn = await (await req("pm", "GET", "/communications?thread=thread-m3")).text();
    assert(pageIn.includes("via Microsoft Teams"), "provider source displayed for Teams messages");

    // ---- 7. notification replay does not duplicate ----
    const beforeReplay = counts();
    await notify([notifItem("tmsg-in-1")]);
    await notify([notifItem("tmsg-in-1")]);
    assert(counts().messages === beforeReplay.messages, "notification replay does not duplicate the message");
    assert(stub.outbound.length === 1, "inbound message is never echoed back to Teams (loop prevention)");

    // ---- 8. identity mapping ----
    d = db();
    d.exec(`INSERT INTO external_identity_mappings (id, provider, tenant_id, external_user_id,
              obv_user_id, external_display_name, status, created_at, updated_at)
            VALUES ('map-1','TEAMS','${TENANT}','ext-daniel','user-pm','Daniel P (Teams)','MAPPED',
                    '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`);
    d.close();
    seedInboundStubMessage("tmsg-in-2", { extUser: "ext-daniel", name: "Daniel P (Teams)", html: "<p>Mapped identity check.</p>" });
    await notify([notifItem("tmsg-in-2")]);
    d = db();
    const mapped = d.prepare("SELECT * FROM messages WHERE external_message_id='tmsg-in-2'").get();
    d.close();
    assert(
      mapped.sender_user_id === "user-pm" && mapped.sender_display_name === "Daniel Phiri",
      "explicitly mapped Teams identity resolves to the OBV user (never name-guessed)"
    );

    // Identity admin flow: unmapped identity was auto-recorded on first
    // inbound; PM can list and map it explicitly.
    const idList = await (await fetch(BASE + "/api/teams-sync/identities", { headers: { cookie: jars.pm } })).json();
    const amina = idList.identities.find((i) => i.externalUserIdFull === "ext-amina");
    assert(
      amina && amina.status === "UNMAPPED" && amina.externalDisplayName === "Amina Ndlovu",
      "external identities seen are listed for the administrator (UNMAPPED recorded)"
    );
    const fieldDenied = await fetch(BASE + "/api/teams-sync/identities", { headers: { cookie: jars.field } });
    assert(fieldDenied.status === 403, "identity admin endpoints are role-protected");
    const mapRes = await fetch(BASE + "/api/teams-sync/identities", {
      method: "POST",
      headers: { cookie: jars.pm, "content-type": "application/json" },
      body: JSON.stringify({ externalUserId: "ext-amina", obvUserId: "user-compliance" }),
    });
    assert(mapRes.status === 200, "administrator maps a Teams identity to an OBV user");
    seedInboundStubMessage("tmsg-in-3", { extUser: "ext-amina", name: "Amina Ndlovu", html: "<p>Now mapped.</p>" });
    await notify([notifItem("tmsg-in-3")]);
    d = db();
    const nowMapped = d.prepare("SELECT sender_user_id FROM messages WHERE external_message_id='tmsg-in-3'").get();
    d.close();
    assert(nowMapped.sender_user_id === "user-compliance", "subsequent inbound messages resolve via the new mapping");

    // ---- 9. GOVERNANCE SAFETY (non-negotiable) ----
    // Submit real evidence first so a PENDING approval exists to attack.
    const ctxRes = await (await req("field", "GET", "/api/field-context")).json();
    const m3ctx = ctxRes.projects[0].milestones.find((m) => m.id === "ms-3");
    const evRes = await fetch(BASE + "/api/evidence", {
      method: "POST",
      headers: { cookie: jars.field, "content-type": "application/json" },
      body: JSON.stringify({
        milestoneId: "ms-3",
        demoPhotoId: m3ctx.demoPhotos[0].id,
        latitude: ctxRes.projects[0].simulatedGps.latitude,
        longitude: ctxRes.projects[0].simulatedGps.longitude,
        capturedAt: new Date(Date.now() - 20 * 60000).toISOString(),
        deviceMetadata: { userAgent: "tsync", platform: "t", screen: "1x1", language: "en" },
        isDemoFallback: true,
      }),
    });
    assert(evRes.status === 201, "formal evidence submission works alongside active sync");
    const g0 = counts();
    seedInboundStubMessage("tmsg-gov-1", { html: "<p>approved — go ahead and release it, pay contractor</p>" });
    seedInboundStubMessage("tmsg-gov-2", { html: "<p>release funds for M3 immediately</p>" });
    await notify([notifItem("tmsg-gov-1"), notifItem("tmsg-gov-2")]);
    const g1 = counts();
    d = db();
    const ap = d.prepare("SELECT status FROM approval_requests WHERE milestone_id='ms-3'").get();
    const ms3 = d.prepare("SELECT account_status FROM milestones WHERE id='ms-3'").get();
    d.close();
    assert(
      g1.approvals === g0.approvals && ap.status === "PENDING",
      'inbound "approved" creates ZERO ApprovalRecords (request stays PENDING)'
    );
    assert(
      g1.released === g0.released && ms3.account_status === "HELD",
      'inbound "release funds" creates ZERO VirtualAccountEvents (funds stay HELD)'
    );
    // Attachment cannot become evidence.
    seedInboundStubMessage("tmsg-att-1", {
      html: "<p>site photo attached</p>",
      attachments: [{ name: "gravel.jpg", contentUrl: "https://example.invalid/gravel.jpg" }],
    });
    await notify([notifItem("tmsg-att-1")]);
    const g2 = counts();
    assert(
      g2.evidence === g1.evidence && g2.ledger === g1.ledger,
      "inbound Teams attachment stays a communication artifact — no EvidenceItem, no ledger entry"
    );
    d = db();
    const attMsg = d.prepare("SELECT attachments FROM messages WHERE external_message_id='tmsg-att-1'").get();
    d.close();
    assert(
      JSON.parse(attMsg.attachments)[0].name === "gravel.jpg",
      "attachment represented as communication metadata only"
    );

    // ---- 10. edit / delete auditability ----
    stub.store.get("tmsg-in-1").body.content = "<p>Received — certificate reviewed and archived.</p>";
    await notify([notifItem("tmsg-in-1", "updated")]);
    d = db();
    const edited = d.prepare("SELECT * FROM messages WHERE external_message_id='tmsg-in-1'").get();
    d.close();
    assert(
      edited.body.includes("archived") &&
        edited.original_body.includes("reviewing the certificate") &&
        edited.edited_at,
      "Teams edit: display updated, ORIGINAL preserved, editedAt recorded"
    );
    await notify([notifItem("tmsg-in-2", "deleted")]);
    d = db();
    const deleted = d.prepare("SELECT * FROM messages WHERE external_message_id='tmsg-in-2'").get();
    const ledgerAfterEdits = d.prepare("SELECT COUNT(*) AS c FROM ledger_entries").get().c;
    d.close();
    assert(
      deleted.external_deleted === 1 && deleted.original_body,
      "Teams delete: marked deleted with audit metadata preserved (not erased)"
    );
    assert(ledgerAfterEdits === g2.ledger, "edit/delete events never alter the Evidence Ledger");
    const pageDel = await (await req("pm", "GET", "/communications?thread=thread-m3")).text();
    assert(pageDel.includes("Message deleted in Microsoft Teams"), "deleted message shows the audit notice");

    // ---- 11. webhook security ----
    const badState = await notify([notifItem("tmsg-in-1", "created", "wrong-client-state")]);
    assert(badState.status === 401, "notification with invalid clientState is rejected (401)");
    const malformed = await fetch(BASE + "/api/teams-sync/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert(malformed.status === 400, "malformed notification body is rejected (400)");
    const handshake = await fetch(BASE + "/api/teams-sync/notifications?validationToken=abc123", { method: "POST" });
    assert(
      (await handshake.text()) === "abc123" &&
        (handshake.headers.get("content-type") ?? "").includes("text/plain"),
      "subscription validation handshake echoes the token as text/plain"
    );

    // ---- 12. provider failure isolation ----
    await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, { method: "POST", body: JSON.stringify({ mode: "500" }) });
    const failSend = await req("pm", "POST", "/api/threads/thread-m3/messages", {
      body: "This message must survive a Teams outage.",
    });
    assert(failSend.status === 303, "Graph 500: OBV chat send still succeeds");
    d = db();
    const failedMsg = d
      .prepare("SELECT * FROM messages WHERE body LIKE '%survive a Teams outage%'")
      .get();
    d.close();
    assert(
      failedMsg && failedMsg.delivery_status === "FAILED" && failedMsg.external_message_id === null,
      "internal message kept; external delivery marked FAILED (no loss, no crash)"
    );
    await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, { method: "POST", body: JSON.stringify({ mode: "timeout" }) });
    const timeoutSend = await req("pm", "POST", "/api/threads/thread-m3/messages", {
      body: "And this one must survive a Graph timeout.",
    });
    assert(timeoutSend.status === 303, "Graph timeout: OBV chat send still succeeds");
    // Formal governance is fully reachable while the provider is down.
    d = db();
    const apId = d.prepare("SELECT id FROM approval_requests WHERE milestone_id='ms-3' AND status='PENDING'").get().id;
    d.close();
    const a1 = await req("funder", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    const heldMid = counts();
    assert(a1.status === 303 || a1.status === 200, "first formal approval works during provider outage");
    assert(heldMid.released === g2.released, "funds remain HELD after partial approval");
    const a2 = await req("compliance", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    assert(a2.status === 303 || a2.status === 200, "final formal approval works during provider outage");
    const releasedNow = counts();
    assert(
      releasedNow.released === g2.released + 1,
      "exactly ONE RELEASED event — governance path is the only route to release"
    );
    await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, { method: "POST", body: JSON.stringify({ mode: "ok" }) });

    // ---- 13. subscription lifecycle ----
    d = db();
    d.exec(`UPDATE external_thread_bindings SET subscription_expires_at='2020-01-01T00:00:00Z'`);
    d.close();
    const maintain = await req("pm", "POST", "/api/teams-sync/maintain", { run: "1" });
    assert(
      maintain.status === 303 &&
        (maintain.headers.get("location") ?? "").includes("/communications/integrations?maintained="),
      "maintenance endpoint runs for authorized role (form flow returns to the integrations page)"
    );
    d = db();
    const renewed = d.prepare("SELECT * FROM external_thread_bindings").get();
    d.close();
    assert(
      Date.parse(renewed.subscription_expires_at) > Date.now() && renewed.status === "ACTIVE",
      "expiring subscription renewed; binding ACTIVE"
    );
    await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, { method: "POST", body: JSON.stringify({ mode: "500" }) });
    d = db();
    d.exec(`UPDATE external_thread_bindings SET subscription_expires_at='2020-01-01T00:00:00Z'`);
    d.close();
    await req("pm", "POST", "/api/teams-sync/maintain", { run: "1" });
    d = db();
    const degraded = d.prepare("SELECT status FROM external_thread_bindings").get();
    d.close();
    assert(degraded.status === "DEGRADED", "failed renewal marks the binding DEGRADED (visible, not silent)");
    await fetch(`http://127.0.0.1:${STUB_PORT}/__mode`, { method: "POST", body: JSON.stringify({ mode: "ok" }) });
    await req("pm", "POST", "/api/teams-sync/maintain", { run: "1" });
    d = db();
    assert(
      d.prepare("SELECT status FROM external_thread_bindings").get().status === "ACTIVE",
      "reconnect flow: successful renewal restores ACTIVE"
    );
    d.close();

    // ---- 14. disconnect stops outbound ----
    const outboundBefore = stub.outbound.length;
    await req("pm", "POST", "/api/threads/thread-m3/teams-binding", { action: "disconnect" });
    await req("pm", "POST", "/api/threads/thread-m3/messages", { body: "After disconnect this stays internal." });
    assert(stub.outbound.length === outboundBefore, "disconnected thread no longer syncs outbound");

    // ---- 15. reset restores clean demo state ----
    await req("pm", "POST", "/api/demo/reset", { ok: "1" });
    d = db();
    const after = d
      .prepare(
        `SELECT (SELECT COUNT(*) FROM external_thread_bindings) AS bindings,
                (SELECT COUNT(*) FROM external_identity_mappings) AS mappings,
                (SELECT COUNT(*) FROM messages) AS messages`
      )
      .get();
    d.close();
    assert(
      after.bindings === 0 && after.mappings === 1 && after.messages === 15,
      "demo reset restores seeded state (Teams bindings/mappings cleared; 15 seeded messages incl. WhatsApp + draw scenario)"
    );

    console.log(`\nTEAMS CONVERSATION-SYNC TESTS PASSED — ${n} checkpoints.`);
    console.log("\nTest matrix (never merge the columns):");
    const matrix = [
      "Token acquisition (read, app)", "Token acquisition (send, delegated)",
      "Team/channel verification", "Channel message read", "Channel message send",
      "Inbound notification + handshake", "Deduplication/replay", "Loop prevention",
      "Edit auditability", "Delete auditability", "Subscription lifecycle",
      "Governance isolation",
    ];
    for (const row of matrix) console.log(`  ${row.padEnd(38)} Stub PASS   Real NOT RUN`);
    console.log("\nValidated against a Graph-compatible stub; real Microsoft tenant validation still required");
    console.log("(run docs/TEAMS_REAL_TENANT_SETUP.md steps 12-17 against your tenant).\n");
  } finally {
    for (const p of spawned) p.kill();
    stubServer.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
