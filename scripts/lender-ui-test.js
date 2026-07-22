/**
 * Lender Review UI tests — isolated server on :3181.
 *
 * Proves the Lender Review draw tab renders only authoritative stored
 * data (or "Not recorded"), enforces tenant/capability boundaries in both
 * the UI and the underlying POST routes, keeps independent and
 * government inspections distinct, leaves every financial control
 * untouched, resolves package links, has no horizontal overflow at the
 * required widths, and that production deploys from main.
 *
 * Browser sections need playwright:
 *   NODE_PATH=/opt/node22/lib/node_modules node scripts/lender-ui-test.js
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3181;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-lender-ui-"));

let n = 0;
const pass = (m) => console.log(`  ✓ [${String(++n).padStart(2, "0")}] ${m}`);
const fail = (m) => {
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
async function api(key, method, p, body) {
  return fetch(BASE + p, {
    method,
    headers: { cookie: jars[key] ?? "", "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
}
async function j(key, method, p, body, expect) {
  const res = await api(key, method, p, body);
  if (expect !== undefined && res.status !== expect) {
    fail(`${method} ${p} -> ${res.status} (expected ${expect}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}
async function page(key, p) {
  const res = await fetch(BASE + p, { headers: { cookie: jars[key] ?? "", accept: "text/html" }, redirect: "manual" });
  return { status: res.status, html: res.status === 200 ? await res.text() : "" };
}
async function formPost(key, p, fields, referer) {
  return fetch(BASE + p, {
    method: "POST",
    headers: {
      cookie: jars[key] ?? "",
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      referer: referer ?? `${BASE}/draw/draw-1?tab=lender`,
    },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}
function db() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path.join(DATA_DIR, "obv.db"));
}
function q1(sql, ...args) {
  const d = db();
  const r = d.prepare(sql).get(...args);
  d.close();
  return r;
}
function q(sql, ...args) {
  const d = db();
  const r = d.prepare(sql).all(...args);
  d.close();
  return r;
}
function exec(sql, ...args) {
  const d = db();
  d.prepare(sql).run(...args);
  d.close();
}
const enumLabel = (v) => {
  const words = v.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const financialState = () =>
  q1(
    `SELECT (SELECT COUNT(*) FROM virtual_account_events) AS va,
            (SELECT COUNT(*) FROM draw_account_events) AS da,
            (SELECT COUNT(*) FROM approval_records) AS ar,
            (SELECT COUNT(*) FROM milestones WHERE account_status='RELEASED') AS rel`
  );

(async () => {
  console.log("Lender Review UI tests — isolated server on :" + PORT);

  // ---- 13. production configuration follows main (no server needed) ----
  const renderYaml = fs.readFileSync(path.join(__dirname, "..", "render.yaml"), "utf8");
  const prodBlock = renderYaml.slice(renderYaml.indexOf("name: obv-demo"), renderYaml.indexOf("obv-frontend-preview"));
  assert(/branch:\s*main\b/.test(prodBlock), "render.yaml production service (obv-demo) deploys from main");

  await new Promise((r) =>
    spawn(process.execPath, ["dist/server/db/seed.js"], { env: { ...process.env, OBV_DATA_DIR: DATA_DIR }, stdio: "ignore" }).on("exit", r)
  );
  const srv = spawn(process.execPath, ["dist/server/http/server.js"], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PORT) },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(BASE + "/api/health")).ok) break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    await signIn("pm", "user-pm");
    await signIn("funder", "user-funder");
    await signIn("compliance", "user-compliance");
    exec("INSERT INTO organizations (id, name, kind) VALUES ('org-x','Unrelated Lender','LENDER')");
    exec(`INSERT INTO users (id, organization_id, name, role, title) VALUES ('user-x','org-x','Xavier Outsider','FUNDER_REP','Unrelated Reviewer')`);
    await signIn("tenantx", "user-x");

    // ---- 1. the lender tab renders for accessible draws ----
    const legacy = await page("funder", "/draw/draw-1?tab=lender");
    assert(legacy.status === 200 && legacy.html.includes("Lender Review") && legacy.html.includes("Derived stage"),
      "the Lender Review tab renders for an accessible draw");
    assert((legacy.html.match(/<h1[ >]/g) || []).length === 1, "exactly one H1 on the page");

    // ---- 2. unrelated tenants receive 404 ----
    const xTab = await page("tenantx", "/draw/draw-1?tab=lender");
    assert(xTab.status === 404, "an unrelated tenant receives 404 for the lender tab (existence not disclosed)");

    // ---- 3. legacy draws show Not recorded, nothing fabricated ----
    // Scoped to draw-1: the seed now carries a HISTORICAL lender-decided
    // draw (draw-vam) for the VAM demo, but the legacy draw itself must
    // have zero lender-domain rows and render Not recorded values.
    const lenderRows =
      q1(`SELECT COUNT(*) c FROM lender_draw_decisions WHERE draw_request_id = 'draw-1'`).c +
      q1(`SELECT COUNT(*) c FROM lien_waiver_records WHERE draw_request_id = 'draw-1'`).c +
      q1(`SELECT COUNT(*) c FROM external_funding_records WHERE draw_request_id = 'draw-1'`).c +
      q1(`SELECT COUNT(*) c FROM draw_inspections WHERE draw_request_id = 'draw-1'`).c +
      q1(`SELECT COUNT(*) c FROM payment_instructions WHERE draw_request_id = 'draw-1'`).c;
    const notRecorded = (legacy.html.match(/Not recorded/g) || []).length;
    assert(lenderRows === 0 && notRecorded >= 5,
      `legacy draw renders "Not recorded" (${notRecorded}×) with zero lender rows for draw-1`);

    // ---- 4. displayed stage equals deriveDrawStage() ----
    const stageApi = (await j("funder", "GET", "/api/draws/draw-1/stage", undefined, 200)).stage;
    assert(legacy.html.includes(enumLabel(stageApi)),
      `the displayed stage equals deriveDrawStage() (${stageApi})`);

    // ---- 9a. independent vs government labels never mix ----
    assert(
      legacy.html.includes("Independent draw inspection") &&
        legacy.html.includes("separate from government/jurisdictional inspections"),
      "independent draw inspection is labeled distinct from government/jurisdictional inspection"
    );

    // ---- 6. capability-gated controls ----
    assert(legacy.html.includes("Order independent inspection"),
      "the funder (SCHEDULE_DRAW_INSPECTION) sees the order-inspection control");
    const pmTab = await page("pm", "/draw/draw-1?tab=lender");
    assert(
      pmTab.status === 200 && !pmTab.html.includes("Order independent inspection") && !pmTab.html.includes("Record lender decision</button>"),
      "the PM sees the workspace but no lender action controls (no capabilities in legacy mode)"
    );

    // ---- 7. server-side POST authorization still rejects manual posts ----
    const pmManual = await formPost("pm", "/api/draws/draw-1/inspections", { inspectorDisplayName: "X" });
    assert(pmManual.status === 303 && /err=/.test(pmManual.headers.get("location") ?? ""),
      "a manually submitted unauthorized FORM post is rejected by the service (403 bounced with err)");
    const pmManualJson = await api("pm", "POST", "/api/draws/draw-1/inspections", {});
    assert(pmManualJson.status === 403, "the same unauthorized JSON post returns 403");

    // ---- 5. displayed data equals stored truth (populate via existing APIs) ----
    const insp = (await j("funder", "POST", "/api/draws/draw-1/inspections", {
      inspectorDisplayName: "K. Banda, Site Inspector", inspectorUserId: "user-field",
    }, 201)).inspection;
    const sched = await formPost("funder", `/api/draw-inspections/${insp.id}/schedule`, { scheduledAt: "2026-07-25" });
    assert(sched.status === 303 && /tab=lender&ok=1/.test(sched.headers.get("location") ?? ""),
      "a governed form post redirects back to ?tab=lender with a success result");
    await j("funder", "POST", "/api/draws/draw-1/lien-waivers", {
      signingParty: "Central Region Roads Authority", waiverType: "CONDITIONAL", waiverScope: "PARTIAL", coveredThrough: "2026-06-30",
    }, 201);
    const populated = (await page("funder", "/draw/draw-1?tab=lender")).html;
    const inspRow = q1("SELECT inspector_display_name AS n, scheduled_at AS s, status AS st FROM draw_inspections WHERE id = ?", insp.id);
    assert(
      populated.includes(inspRow.n) && populated.includes(enumLabel(inspRow.st)) && populated.includes("2026-07-25"),
      "displayed inspection data equals the stored draw_inspections row"
    );
    const wRow = q1("SELECT signing_party AS p, status AS st, covered_through AS ct FROM lien_waiver_records LIMIT 1");
    assert(populated.includes(wRow.p) && populated.includes(enumLabel(wRow.st)) && populated.includes(wRow.ct),
      "displayed lien-waiver data equals the stored lien_waiver_records row");

    // ---- 8 + 10 + 5b. full governed flow on a fresh draw ----
    const d2 = (await j("pm", "POST", "/api/draws", { projectId: "proj-r47", requestedAmount: 120000, periodStart: "2026-07-01", periodEnd: "2026-07-31" }, 201)).draw;
    const D2 = `/api/draws/${d2.id}`;
    const l2 = (await j("pm", "POST", `${D2}/lines`, { description: "Culvert ring supply", scheduledValue: 240000, currentRequested: 120000, percentCompleteClaimed: 50 }, 201)).line;
    await j("pm", "POST", `${D2}/submit`, undefined, 200);
    // Separation of duties: PM submitted d2 — the funder decides; the pm
    // (submitter) must be rejected even with a lender capability granted.
    await j("compliance", "POST", `${D2}/lines/${l2.id}/review`, { decision: "SUPPORTED" }, 200);
    for (const r of q("SELECT id, title FROM draw_document_requirements WHERE draw_request_id = ? AND required = 1", d2.id)) {
      await j("pm", "POST", `${D2}/documents`, { requirementId: r.id, title: r.title }, 201);
    }
    await api("pm", "POST", "/api/issues/issue-1/status", { status: "ACKNOWLEDGED" });
    await j("pm", "POST", "/api/issues/issue-1/status", { status: "RESOLVED", resolutionSummary: "Stockpile replenished." }, 200);
    await j("compliance", "POST", `${D2}/governance`, {}, 200);
    const ap2 = q1("SELECT id FROM approval_requests WHERE draw_request_id = ?", d2.id).id;
    await j("funder", "POST", `/api/approvals/${ap2}/decision`, { decision: "APPROVED" }, 200);
    await j("compliance", "POST", `/api/approvals/${ap2}/decision`, { decision: "APPROVED" }, 200);

    // SoD via the decision route: a draw submitted by the funder
    const dF = (await j("funder", "POST", "/api/draws", { projectId: "proj-r47", requestedAmount: 5000, periodStart: "2026-07-01", periodEnd: "2026-07-31" }, 201)).draw;
    const sod = await api("funder", "POST", `/api/draws/${dF.id}/lender-decision`, { decision: "PENDING" });
    assert(sod.status === 403 && /own draw/.test(await sod.text()),
      "submitter-cannot-decide separation of duties remains enforced through the UI's route");

    const fin0 = financialState();
    const decRes = await formPost("funder", `${D2}/lender-decision`, {
      decision: "APPROVED", approvedAmount: "120000", decisionReason: "Fully supported",
    }, `${BASE}/draw/${d2.id}?tab=lender`);
    assert(decRes.status === 303 && /ok=1/.test(decRes.headers.get("location") ?? ""), "the lender decision form records through the existing route");
    const fundRes = await formPost("funder", `${D2}/funding`, { amountScheduled: "120000", fundingMethod: "Wire" }, `${BASE}/draw/${d2.id}?tab=lender`);
    assert(fundRes.status === 303 && /ok=1/.test(fundRes.headers.get("location") ?? ""), "the funding form schedules through the existing route");
    const fId = q1("SELECT id FROM external_funding_records WHERE draw_request_id = ?", d2.id).id;
    await formPost("funder", `/api/funding/${fId}`, { status: "DISBURSED", transactionReference: "WIRE-UI-1" }, `${BASE}/draw/${d2.id}?tab=lender`);
    const fin1 = financialState();
    assert(
      fin0.va === fin1.va && fin0.da === fin1.da && fin0.rel === fin1.rel,
      "the ENTIRE UI funding flow changed zero virtual-account/draw-account events and released nothing"
    );
    const d2page = (await page("funder", `/draw/${d2.id}?tab=lender`)).html;
    const decRow = q1("SELECT decision AS d, approved_amount AS a, requested_amount AS r FROM lender_draw_decisions WHERE draw_request_id = ? AND superseded_by_decision_id IS NULL", d2.id);
    assert(
      d2page.includes(enumLabel(decRow.d)) && d2page.includes("$120,000") && decRow.a === 120000,
      "displayed decision and amounts equal the stored lender_draw_decisions row"
    );
    const fRow = q1("SELECT status AS s, amount_disbursed AS ad, transaction_reference AS tr FROM external_funding_records WHERE id = ?", fId);
    assert(
      d2page.includes(enumLabel(fRow.s)) && d2page.includes(fRow.tr) && fRow.ad === 120000,
      "displayed external funding equals the stored external_funding_records row"
    );
    assert(d2page.includes("do not call VirtualAccountService"), "the no-money-movement trust note is present");

    // ---- 9b. types never mix in the DB either ----
    assert(
      q1("SELECT COUNT(*) c FROM jurisdictional_inspections").c === 0,
      "independent inspection actions created ZERO jurisdictional inspection rows"
    );

    // ---- 11. verification package links resolve ----
    const pkg = await j("funder", "POST", `${D2}/verification-package`, undefined, 201);
    const dl = await fetch(`${BASE}/reports/file/${pkg.report.id}`, { headers: { cookie: jars.funder } });
    assert(dl.status === 200 && (await dl.arrayBuffer()).byteLength > 1000, "the generated verification package downloads through the existing route");
    const d2page2 = (await page("funder", `/draw/${d2.id}?tab=lender`)).html;
    assert(d2page2.includes(`/reports/file/${pkg.report.id}`), "the lender tab links the generated package");
    const preview = await page("funder", `/draw/${d2.id}/verification-package/preview`);
    assert(preview.status === 200, "the printable package preview resolves");

    // ---- 12. no horizontal overflow at required widths ----
    let chromium = null;
    try { ({ chromium } = require("playwright")); } catch { /* NODE_PATH missing */ }
    if (!chromium) fail("playwright unavailable — run with NODE_PATH=/opt/node22/lib/node_modules");
    const browser = await chromium.launch();
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "obv_user", value: "user-funder", url: BASE }]);
    const bpage = await ctx.newPage();
    for (const w of [375, 390, 393, 430, 768, 1024, 1280, 1440]) {
      await bpage.setViewportSize({ width: w, height: 900 });
      await bpage.goto(`${BASE}/draw/${d2.id}?tab=lender`, { waitUntil: "networkidle" });
      const overflow = await bpage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) fail(`horizontal overflow ${overflow}px at ${w}px`);
    }
    await browser.close();
    pass("no document-level horizontal overflow at 375/390/393/430/768/1024/1280/1440");

    console.log(`\nLENDER UI TESTS PASSED — ${n} checkpoints.`);
  } finally {
    srv.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
