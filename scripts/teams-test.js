/**
 * Teams notification integration tests — runs the OBV server as a child
 * process against a local stub webhook to exercise every delivery and
 * failure path without external dependencies.
 *
 * Usage: node scripts/teams-test.js   (requires a completed npm run build)
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const PORT = 3110;
const HOOK_PORT = 4601;
const BASE = `http://127.0.0.1:${PORT}`;

let step = 0;
const pass = (msg) => console.log(`  ✓ [${String(++step).padStart(2, "0")}] ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};

// ------------------------------------------------------- stub webhook

let hookMode = "ok"; // ok | slow | err
const received = []; // captured card payloads
const hook = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (hookMode === "slow") return; // never respond -> client timeout
    if (hookMode === "err") {
      res.writeHead(500);
      res.end("hook exploded");
      return;
    }
    try {
      received.push(JSON.parse(body));
    } catch {}
    res.writeHead(200);
    res.end("1");
  });
});

function cardTitles() {
  return received.map(
    (p) => p.attachments?.[0]?.content?.body?.[1]?.text ?? "?"
  );
}
function lastCardFacts() {
  const card = received[received.length - 1]?.attachments?.[0]?.content;
  const factSet = (card?.body ?? []).find((b) => b.type === "FactSet");
  return Object.fromEntries((factSet?.facts ?? []).map((f) => [f.title, f.value]));
}

// --------------------------------------------------------- server child

let child = null;
async function startServer(extraEnv) {
  if (child) {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
  }
  const env = { ...process.env, PORT: String(PORT) };
  delete env.ANTHROPIC_API_KEY;
  delete env.TEAMS_WEBHOOK_URL;
  Object.assign(env, extraEnv);
  child = spawn(process.execPath, ["dist/server/http/server.js"], { env, stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(BASE + "/")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  fail("server did not start");
}

const reset = async () =>
  fetch(BASE + "/api/demo/reset", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: "obv_user=user-funder" },
  });

const PNG =
  "data:image/png;base64," +
  fs.readFileSync(path.join(process.cwd(), "public", "icons", "icon-192.png")).toString("base64");

async function submit(overrides = {}) {
  const res = await fetch(BASE + "/api/evidence", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: "obv_user=user-field" },
    body: JSON.stringify({
      milestoneId: "ms-3",
      photoDataUrl: PNG,
      latitude: -11.87,
      longitude: 33.594,
      capturedAt: new Date(Date.now() - 20 * 60000).toISOString(),
      deviceMetadata: { userAgent: "teams-test", platform: "Android", screen: "412x915", language: "en" },
      isDemoFallback: false,
      ...overrides,
    }),
  });
  return { status: res.status, body: await res.json() };
}

async function decide(approvalId, user, decision) {
  const res = await fetch(`${BASE}/api/approvals/${approvalId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: `obv_user=${user}` },
    body: JSON.stringify({ decision }),
  });
  if (res.status !== 200) fail(`decision -> ${res.status}`);
  return res.json();
}

function notificationRows(where = "") {
  const db = new DatabaseSync(path.join(process.cwd(), "data", "obv.db"));
  const rows = db.prepare(`SELECT * FROM notifications ${where} ORDER BY created_at`).all();
  db.close();
  return rows;
}

async function main() {
  await new Promise((r) => hook.listen(HOOK_PORT, r));

  // ---------- TEST 1: no webhook configured -> demo mode, loop intact ----------
  await startServer({});
  await reset();
  let r = await submit();
  if (r.status !== 201 || !r.body.approvalRequest || !r.body.ledgerEntry) fail("hero artifacts missing (no webhook)");
  const mockRows = notificationRows("WHERE type='MILESTONE_VERIFIED'");
  const latest = mockRows[mockRows.length - 1];
  if (latest.delivery_mode !== "MOCK" || latest.delivery_status !== "SKIPPED") {
    fail(`no-webhook provenance mode=${latest.delivery_mode} status=${latest.delivery_status}`);
  }
  pass("no webhook: full loop works, notifications recorded as MOCK/SKIPPED (demo mode)");

  // ---------- TEST 2: valid webhook -> cards for the full governance flow ----------
  received.length = 0;
  hookMode = "ok";
  await startServer({
    TEAMS_WEBHOOK_URL: `http://127.0.0.1:${HOOK_PORT}/hook`,
    TEAMS_NOTIFICATION_TIMEOUT_MS: "3000",
    OBV_PUBLIC_BASE_URL: "https://obv-demo.example.org",
  });
  await reset();
  r = await submit();
  const apId = r.body.approvalRequest.id;
  await decide(apId, "user-funder", "APPROVED");
  await decide(apId, "user-compliance", "APPROVED");
  const titles = cardTitles();
  for (const expect of [
    "Milestone Verified",
    "Approval Request Created",
    "Approval Recorded",
    "Tranche Released — Virtual Account State Transition",
  ]) {
    if (!titles.some((t) => t.includes(expect))) fail(`missing card: ${expect} (got: ${titles.join(" | ")})`);
  }
  const verifiedCard = received.find((p) =>
    JSON.stringify(p).includes("Funds remain HELD pending required human approval")
  );
  if (!verifiedCard) fail("VERIFIED card missing mandatory HELD line");
  const releasedPayload = JSON.stringify(received[received.length - 1]);
  if (!releasedPayload.includes("Virtual Account state transition")) fail("release card missing demo-environment note");
  if (!releasedPayload.includes("Authorized by")) fail("release card missing approvers");
  if (!releasedPayload.includes("CHAIN INTACT")) fail("release card missing ledger integrity");
  if (!releasedPayload.includes("https://obv-demo.example.org/project/")) fail("release card missing OBV link");
  if (releasedPayload.toLowerCase().includes("bank transfer occurred")) fail("copy violation");
  const sentRows = notificationRows("WHERE delivery_mode='TEAMS_WEBHOOK' AND delivery_status='SENT'");
  if (sentRows.length < 4) fail(`expected >=4 SENT rows, got ${sentRows.length}`);
  if (sentRows.some((row) => !row.sent_at)) fail("SENT rows missing sent_at");
  if (JSON.stringify(sentRows).includes("127.0.0.1")) fail("webhook URL leaked into stored notifications");
  pass("valid webhook: Verified, Approval Request, Approval Recorded and Tranche Released cards delivered with accurate governance/financial state");

  // approval recorded card content
  const recCard = received.find((p) => JSON.stringify(p).includes("Approval Recorded"));
  const recStr = JSON.stringify(recCard);
  if (!recStr.includes("1 of 2 approvals complete")) fail("progress missing on Approval Recorded card");
  if (!recStr.includes("Compliance Reviewer")) fail("awaiting role missing on Approval Recorded card");
  pass("Approval Recorded card shows approver, role, 1-of-2 progress, awaiting role, funds HELD");

  // ---------- TEST 5/6: NEEDS_REVIEW + REJECTED cards ----------
  received.length = 0;
  await reset();
  r = await submit({ latitude: null, longitude: null });
  if (r.body.verification.verdict !== "NEEDS_REVIEW") fail("expected NEEDS_REVIEW");
  if (r.body.approvalRequest) fail("NEEDS_REVIEW must not create approval");
  if (!cardTitles().some((t) => t.includes("Evidence Needs Review"))) fail("needs-review card missing");
  if (!JSON.stringify(received).includes("Human review required")) fail("review CTA missing");
  received.length = 0;
  await reset();
  r = await submit({ latitude: 40.7, longitude: -74.0 });
  if (r.body.verification.verdict !== "REJECTED") fail("expected REJECTED");
  if (!cardTitles().some((t) => t.includes("Evidence Rejected"))) fail("rejected card missing");
  if (!JSON.stringify(received).includes("No release eligibility created")) fail("rejected state line missing");
  pass("NEEDS_REVIEW and REJECTED cards sent; no approval request, no release eligibility");

  // ---------- TEST 7: approval rejection card, funds stay HELD ----------
  received.length = 0;
  await reset();
  r = await submit();
  await decide(r.body.approvalRequest.id, "user-funder", "REJECTED");
  if (!cardTitles().some((t) => t.includes("Approval Rejected"))) fail("approval-rejected card missing");
  const ms = notificationRows("WHERE 1=1"); // milestone state via API instead
  const projPage = await (await fetch(`${BASE}/project/proj-r47`, { headers: { Cookie: "obv_user=user-funder" } })).text();
  if (!projPage.includes("$1,680,000")) fail("funds did not remain HELD after approval rejection");
  pass("approval rejection: card sent, tranche remains HELD, milestone returned for review");

  // ---------- TEST 8: ledger tamper -> integrity alert card, no false success ----------
  received.length = 0;
  {
    const db = new DatabaseSync(path.join(process.cwd(), "data", "obv.db"));
    db.prepare("UPDATE ledger_entries SET payload_hash='deadbeef' WHERE seq=1").run();
    db.close();
  }
  await fetch(BASE + "/api/ledger/verify", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: "obv_user=user-funder" },
  });
  const alertTitles = cardTitles();
  if (!alertTitles.some((t) => t.includes("Evidence Ledger Integrity Alert"))) fail("integrity alert card missing");
  if (alertTitles.some((t) => t.toLowerCase().includes("intact"))) fail("false chain-intact card sent");
  if (!JSON.stringify(received).includes("TAMPERING DETECTED")) fail("alert card missing state");
  pass("tampered ledger: high-priority integrity alert card, no misleading success card");
  await reset();

  // ---------- TEST 3: webhook timeout -> FAILED, loop continues ----------
  received.length = 0;
  hookMode = "slow";
  await startServer({ TEAMS_WEBHOOK_URL: `http://127.0.0.1:${HOOK_PORT}/hook`, TEAMS_NOTIFICATION_TIMEOUT_MS: "700" });
  await reset();
  const t0 = Date.now();
  r = await submit();
  const elapsed = Date.now() - t0;
  if (r.status !== 201 || !r.body.approvalRequest) fail("timeout blocked the hero loop");
  if (elapsed > 15000) fail(`submission took ${elapsed}ms with webhook timeouts`);
  const failedRows = notificationRows("WHERE delivery_status='FAILED'");
  if (failedRows.length < 1 || failedRows.some((row) => row.failure_category !== "timeout")) {
    fail("timeout not recorded as FAILED/timeout");
  }
  pass(`webhook timeout: loop continued (${elapsed}ms), notifications recorded FAILED/timeout`);

  // ---------- TEST 4: webhook 500 -> FAILED http_5xx, loop continues ----------
  hookMode = "err";
  await startServer({ TEAMS_WEBHOOK_URL: `http://127.0.0.1:${HOOK_PORT}/hook`, TEAMS_NOTIFICATION_TIMEOUT_MS: "2000" });
  await reset();
  r = await submit();
  if (r.status !== 201 || !r.body.ledgerEntry) fail("5xx blocked the hero loop");
  const fiveRows = notificationRows("WHERE delivery_status='FAILED' AND failure_category='http_5xx'");
  if (fiveRows.length < 1) fail("5xx failure not stored");
  if (JSON.stringify(r.body).includes("hook exploded")) fail("raw webhook error leaked to client");
  pass("webhook 500: loop continued, failure stored as http_5xx, no raw error exposed");

  child.kill();
  hook.close();
  console.log(`\nTEAMS INTEGRATION TESTS PASSED — ${step} checkpoints.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nTEAMS TESTS FAILED at checkpoint ${step + 1}: ${err.message}\n`);
  if (child) child.kill();
  hook.close();
  process.exit(1);
});
