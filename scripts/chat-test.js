/**
 * Communications tests — 14 checkpoints + explicit governance proofs.
 *
 *   node scripts/chat-test.js     (HTTP + direct DB assertions; no browser)
 *
 * The core doctrine under test: CHAT COORDINATES — a message saying
 * "approved" or "release funds" is text. Only the ApprovalRequest state
 * machine records approvals; only completed governance releases funds.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3170;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-chat-"));

let n = 0;
const pass = (m) => console.log(`  ✓ [${++n}] ${m}`);
const fail = (m) => {
  // Throw (never process.exit) so the finally block kills the spawned
  // server — a direct exit leaves a zombie on the port for the next run.
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (c, m) => (c ? pass(m) : fail(m));

const jars = {};
async function signIn(key, userId) {
  const res = await fetch(BASE + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
    redirect: "manual",
  });
  jars[key] = res.headers.getSetCookie()[0].split(";")[0];
}
async function req(key, method, p, form) {
  return fetch(BASE + p, {
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
function govCounts() {
  const d = db();
  const r = d
    .prepare(
      `SELECT (SELECT COUNT(*) FROM approval_records) AS records,
              (SELECT COUNT(*) FROM virtual_account_events WHERE type='RELEASED') AS released,
              (SELECT COUNT(*) FROM milestones WHERE account_status='RELEASED') AS releasedMs,
              (SELECT COUNT(*) FROM notifications) AS notifications,
              (SELECT COUNT(*) FROM messages) AS messages,
              (SELECT COUNT(*) FROM conversation_threads) AS threads`
    )
    .get();
  d.close();
  return r;
}

(async () => {
  console.log("Communications tests — isolated server on :" + PORT);
  await new Promise((r) =>
    spawn(process.execPath, ["dist/server/db/seed.js"], {
      env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
      stdio: "ignore",
    }).on("exit", r)
  );
  const srv = spawn(process.execPath, ["dist/server/http/server.js"], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PORT) },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(BASE + "/api/health")).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    await signIn("field", "user-field");
    await signIn("funder", "user-funder");
    await signIn("compliance", "user-compliance");

    // 1. Thread list loads with the seeded threads.
    const list = await (await req("funder", "GET", "/communications")).text();
    assert(
      list.includes("Project General") && list.includes("M3 · Gravel Base Course Review"),
      "thread list loads with seeded threads"
    );

    // 2. Project General opens.
    const proj = await (await req("funder", "GET", "/communications?thread=thread-project")).text();
    assert(proj.includes("Welcome to the R47 project workspace"), "Project General opens with history");

    // 3. M3 thread opens.
    const m3 = await (await req("funder", "GET", "/communications?thread=thread-m3")).text();
    assert(
      m3.includes("compaction test certificate") && m3.includes("Amina Ndlovu"),
      "M3 review thread opens with seeded conversation"
    );

    // 4-6. FIELD user sends an authorized message; it persists with
    //      correct sender, timestamp, and OBV provider.
    const send = await req("field", "POST", "/api/threads/thread-m3/messages", {
      body: "Heading to km 10 marker now; will submit evidence within the hour.",
    });
    assert(send.status === 303, "FIELD user can send in an authorized thread");
    const d1 = db();
    const row = d1
      .prepare("SELECT * FROM messages WHERE thread_id='thread-m3' ORDER BY created_at DESC LIMIT 1")
      .get();
    d1.close();
    assert(row.body.includes("km 10 marker"), "message persists in the store");
    assert(
      row.sender_user_id === "user-field" &&
        row.sender_display_name === "Chikondi Banda" &&
        row.provider === "OBV" &&
        !Number.isNaN(Date.parse(row.created_at)),
      "sender attribution, OBV provider and stable timestamp recorded"
    );

    // 7. Evidence reference card links to the evidence record.
    assert(
      proj.includes("/milestone/ms-1") && /EVIDENCE/.test(proj),
      "evidence reference opens the correct evidence panel route"
    );

    // 8. Approval reference card shows governance state and links out.
    assert(
      /APPROVAL REQUEST/.test(proj) && proj.includes("2 of 2 complete") && proj.includes("/approvals"),
      "approval reference shows recorded/required counts and links to approvals"
    );

    // 9. System events mirror real product events: submit M3 evidence.
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
        capturedAt: new Date(Date.now() - 30 * 60000).toISOString(),
        deviceMetadata: { userAgent: "chat-test", platform: "test", screen: "1x1", language: "en" },
        isDemoFallback: true,
      }),
    });
    assert(evRes.status === 201, "evidence submission still works (workflow unchanged)");
    const m3after = await (await req("funder", "GET", "/communications?thread=thread-m3")).text();
    assert(
      m3after.includes("Evidence submitted for M3") &&
        m3after.includes("Verification completed: VERIFIED") &&
        m3after.includes("Approval request created"),
      "milestone thread received system events for evidence, verification and approval request"
    );

    // 10. Cross-project access is blocked (tenant boundary).
    const d2 = db();
    d2.exec(`INSERT INTO organizations (id, name, kind) VALUES ('org-x','Other Org','GOVERNMENT')`);
    d2.exec(`INSERT INTO users (id, organization_id, name, role, title)
             VALUES ('user-x','org-x','外部 User','PROJECT_MANAGER','PM')`);
    d2.exec(`INSERT INTO projects (id, organization_id, name, description, location, site_boundary, total_budget)
             VALUES ('proj-x','org-x','Other Project','d','loc','[[0,0],[1,0],[1,1],[0,0]]',1000)`);
    d2.exec(`INSERT INTO conversation_threads (id, organization_id, project_id, title, scope, created_at, created_by)
             VALUES ('thread-x','org-x','proj-x','Other Thread','PROJECT','2026-01-01T00:00:00Z','user-x')`);
    d2.close();
    const blockedPage = await req("funder", "GET", "/communications?thread=thread-x");
    const blockedPost = await req("funder", "POST", "/api/threads/thread-x/messages", { body: "hi" });
    const listAfter = await (await req("funder", "GET", "/communications")).text();
    assert(
      blockedPage.status === 404 && blockedPost.status === 404 && !listAfter.includes("Other Thread"),
      "unrelated project thread is invisible and inaccessible (page + API)"
    );

    // ---- governance proofs: chat cannot authorize money ----
    const before = govCounts();

    // 11. "approved" in chat creates no approval record.
    await req("funder", "POST", "/api/threads/thread-m3/messages", {
      body: "Looks great — approved! Go ahead.",
    });
    // 12. "release funds" in chat calls nothing on the virtual account.
    await req("compliance", "POST", "/api/threads/thread-m3/messages", {
      body: "Release funds for M3 immediately.",
    });
    const after = govCounts();
    const d3 = db();
    const approval = d3.prepare("SELECT status FROM approval_requests WHERE milestone_id='ms-3'").get();
    const ms3 = d3.prepare("SELECT account_status, status FROM milestones WHERE id='ms-3'").get();
    d3.close();
    assert(
      after.records === before.records && approval.status === "PENDING",
      'message saying "approved" does not create an ApprovalRecord (request stays PENDING)'
    );
    assert(
      after.released === before.released &&
        after.releasedMs === before.releasedMs &&
        ms3.account_status === "HELD",
      'message saying "release funds" does not touch the VirtualAccountService (funds stay HELD)'
    );
    assert(
      after.messages === before.messages + 2 && after.notifications === before.notifications,
      "chat messages create no notification-channel rows (chat and Teams delivery stay separate)"
    );

    // 13. Only the ApprovalRequest endpoint changes governance state.
    const apId = (() => {
      const d = db();
      const r = d.prepare("SELECT id FROM approval_requests WHERE milestone_id='ms-3'").get();
      d.close();
      return r.id;
    })();
    await req("funder", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    await req("compliance", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    const released = govCounts();
    assert(
      released.released === before.released + 1 && released.records === before.records + 2,
      "the existing ApprovalRequest workflow (and only it) records approvals and releases the tranche"
    );

    // 14. Reset restores the exact seeded conversation state.
    await req("funder", "POST", "/api/demo/reset", { ok: "1" });
    const resetCounts = govCounts();
    const resetList = await (await req("funder", "GET", "/communications")).text();
    // The reset preserves user-created (non-demo) data: 'proj-x' and its
    // thread from the tenant-boundary test survive, while the demo
    // threads/messages are restored to their exact seeded state.
    assert(
      resetCounts.threads === 4 &&
        resetCounts.messages === 15 &&
        resetList.includes("Project General") &&
        !resetList.includes("km 10 marker"),
      "demo reset restores the seeded demo threads/messages exactly (incl. draw thread; user-created project preserved)"
    );
    const dReset = db();
    const projX = dReset.prepare("SELECT id FROM projects WHERE id='proj-x'").get();
    dReset.close();
    assert(Boolean(projX), "demo reset does not delete non-demo (pilot) projects");

    console.log(`\nCOMMUNICATIONS TESTS PASSED — ${n} checkpoints.\n`);
  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
