/**
 * Idempotency & double-submission tests — validates that accidental
 * repeats (offline-queue replay, double taps, refresh-and-retry) cannot
 * duplicate business records:
 *
 *   1.  identical evidence replay  -> ONE evidence / verification / ledger
 *   2.  replay returns the original result (same ids, same hashes)
 *   3.  a genuinely new capture (new capturedAt) still creates a new record
 *   4.  double-approve by the same role -> 409, one ApprovalRecord
 *   5.  approval replay after final approval -> 409
 *   6.  exactly ONE RELEASED account event (no double HELD->RELEASED)
 *   7.  wrong-role approval attempt -> 403
 *   8.  ledger chain remains INTACT throughout
 *
 * Run: node scripts/idempotency-test.js
 * (starts its own server on :3140 with an isolated data dir)
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3140;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-idem-"));

let passCount = 0;
function pass(msg) {
  passCount++;
  console.log(`  ✓ [${passCount}] ${msg}`);
}
function fail(msg) {
  console.error(`  ✗ FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
  pass(msg);
}

const jars = {};
async function req(userKey, method, p, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body) headers["content-type"] = "application/json";
  if (userKey && jars[userKey]) headers.cookie = jars[userKey];
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  return res;
}

async function signIn(userKey, userId) {
  const res = await fetch(BASE + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie()[0];
  jars[userKey] = setCookie.split(";")[0];
}

function dbCounts() {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(DATA_DIR, "obv.db"), { readOnly: true });
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM evidence_items) AS evidence,
              (SELECT COUNT(*) FROM verifications) AS verifications,
              (SELECT COUNT(*) FROM ledger_entries) AS ledger,
              (SELECT COUNT(*) FROM approval_requests) AS requests,
              (SELECT COUNT(*) FROM approval_records) AS records,
              (SELECT COUNT(*) FROM virtual_account_events WHERE type='RELEASED') AS released`
    )
    .get();
  db.close();
  return row;
}

(async () => {
  console.log("Idempotency tests — isolated server on :" + PORT);
  const server = spawn(
    process.execPath,
    ["dist/server/db/seed.js"],
    { env: { ...process.env, OBV_DATA_DIR: DATA_DIR }, stdio: "ignore" }
  );
  await new Promise((r) => server.on("exit", r));
  const srv = spawn(
    process.execPath,
    ["dist/server/http/server.js"],
    { env: { ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PORT) }, stdio: "ignore" }
  );
  try {
    // wait for boot
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

    // Fetch a seeded demo fallback photo id for milestone ms-3.
    const ctx = await (await req("field", "GET", "/api/field-context")).json();
    const m3 = ctx.projects[0].milestones.find((m) => m.id === "ms-3");
    const demoPhotoId = m3.demoPhotos[0].id;
    const gps = ctx.projects[0].simulatedGps;

    const payload = {
      milestoneId: "ms-3",
      demoPhotoId,
      latitude: gps.latitude,
      longitude: gps.longitude,
      capturedAt: new Date(Date.now() - 40 * 60000).toISOString(),
      deviceMetadata: { userAgent: "idem-test", platform: "test", screen: "1x1", language: "en" },
      isDemoFallback: true,
    };

    const before = dbCounts();

    // ---- 1+2: identical replay (simulates offline-queue resend) ----
    const r1 = await (await req("field", "POST", "/api/evidence", payload)).json();
    const r2 = await (await req("field", "POST", "/api/evidence", payload)).json();
    const after2 = dbCounts();
    assert(
      after2.evidence === before.evidence + 1,
      "identical replay creates exactly ONE evidence item"
    );
    assert(
      after2.verifications === before.verifications + 1,
      "identical replay creates exactly ONE verification"
    );
    assert(
      after2.ledger === before.ledger + 1,
      "identical replay creates exactly ONE ledger entry"
    );
    assert(
      after2.requests === before.requests + 1,
      "identical replay creates exactly ONE approval request"
    );
    assert(
      r1.evidence.id === r2.evidence.id &&
        r1.verification.id === r2.verification.id &&
        r1.ledgerEntry.currentHash === r2.ledgerEntry.currentHash,
      "replay returns the ORIGINAL result (same evidence, verification, ledger hash)"
    );

    // ---- 3: a genuinely new capture still works ----
    const fresh = { ...payload, capturedAt: new Date().toISOString() };
    const r3 = await req("field", "POST", "/api/evidence", fresh);
    assert(r3.status === 201, "new capture (new capturedAt) is accepted");
    const after3 = dbCounts();
    assert(after3.evidence === after2.evidence + 1, "new capture creates a new evidence item");
    assert(
      after3.requests === after2.requests,
      "existing PENDING approval request is reused (no duplicate request)"
    );

    // ---- 4-7: approval double-click / replay / role rules ----
    const approvalId = r1.approvalRequest.id;
    const a1 = await req("funder", "POST", `/api/approvals/${approvalId}/decision`, {
      decision: "APPROVED",
    });
    assert(a1.status === 200, "first funder approval records (funds still HELD)");
    const a2 = await req("funder", "POST", `/api/approvals/${approvalId}/decision`, {
      decision: "APPROVED",
    });
    assert(a2.status === 409, "double-click by the same role is rejected (409)");

    const wrongRole = await req("field", "POST", `/api/approvals/${approvalId}/decision`, {
      decision: "APPROVED",
    });
    assert(wrongRole.status === 403, "non-required role cannot approve (403)");

    const midCounts = dbCounts();
    assert(midCounts.released === 2, "funds remain HELD after partial approval (seeded 2 releases only)");

    const a3 = await req("compliance", "POST", `/api/approvals/${approvalId}/decision`, {
      decision: "APPROVED",
    });
    const a3body = await a3.json();
    assert(a3.status === 200 && a3body.released === true, "final compliance approval releases the tranche");

    const a4 = await req("compliance", "POST", `/api/approvals/${approvalId}/decision`, {
      decision: "APPROVED",
    });
    assert(a4.status === 409, "approval replay after resolution is rejected (409)");

    const finalCounts = dbCounts();
    assert(
      finalCounts.released === 3,
      "exactly ONE new RELEASED account event (no double HELD→RELEASED)"
    );
    assert(
      finalCounts.records === midCounts.records + 1,
      "exactly one approval record per role"
    );

    // ---- 8: chain integrity ----
    const chain = await (await req("funder", "POST", "/api/ledger/verify")).json();
    assert(chain.valid === true, "ledger chain remains INTACT after all replays");

    console.log(`\nIDEMPOTENCY TESTS PASSED — ${passCount} checkpoints.\n`);
  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
