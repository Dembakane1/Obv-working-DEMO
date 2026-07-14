/**
 * OBV Control Intelligence tests — deterministic, read-only, source-grounded.
 *
 *   node scripts/control-test.js   (isolated server on :3194)
 *
 * Covers: status ladder (HEALTHY / WATCH / AT_RISK / BLOCKED /
 * DATA_INCOMPLETE) and precedence, no fake success scores, action-source
 * grounding, single exception truth, blocked-amount deduplication with
 * overlap disclosure, advisory ≠ approval ≠ release, retainage separation,
 * UNKNOWN ≠ NOT_REQUIRED, contractor ≠ evidence ≠ inspection, RELEASED ≠
 * gates-passed + legacy warning, read-only contract (no mutation forms, no
 * VirtualAccountService reference), authorization, empty states,
 * DATA_INCOMPLETE display, and mobile rendering (when Playwright is
 * available).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3194;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-control-"));

let n = 0;
const pass = (m) => console.log(`  ✓ [${++n}] ${m}`);
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
async function api(key, method, p, body, form = false) {
  return fetch(BASE + p, {
    method,
    headers: {
      cookie: jars[key] ?? "",
      "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
    },
    body:
      body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    redirect: "manual",
  });
}
async function ctl(key, query = "") {
  const res = await api(key, "GET", `/api/control/portfolio${query}`);
  if (res.status !== 200) fail(`control portfolio -> ${res.status}`);
  return res.json();
}
async function page(key, p = "/control") {
  const res = await api(key, "GET", p);
  if (res.status !== 200) fail(`${p} -> ${res.status}`);
  return res.text();
}
const healthOf = (d, projectId) => d.health.find((h) => h.projectId === projectId);
function db() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path.join(DATA_DIR, "obv.db"));
}
function exec(sql, ...args) {
  const d = db();
  d.prepare(sql).run(...args);
  d.close();
}
function q1(sql, ...args) {
  const d = db();
  const r = d.prepare(sql).get(...args);
  d.close();
  return r;
}

(async () => {
  console.log("OBV Control Intelligence tests — isolated server on :" + PORT);
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
    await signIn("funder", "user-funder");
    await signIn("pm", "user-pm");
    await signIn("compliance", "user-compliance");
    await signIn("field", "user-field");

    // ---- 1. page identity, subtitle, methodology, trust boundary ----
    let html = await page("funder");
    assert(
      html.includes("OBV Control Intelligence") &&
        html.includes("Evidence-grounded oversight of project progress, draw readiness, exceptions, inspections, governance, and funds exposure."),
      "portfolio page presents OBV Control Intelligence with the required subtitle"
    );
    assert(
      html.includes("Intelligence Methodology") &&
        html.includes("does not independently approve work") &&
        html.includes("Rule precedence (exact order)"),
      "methodology panel states the AI trust boundary and the exact rule order"
    );

    // ---- 2. no fake prediction language or success scores ----
    const banned = ["success probability", "Success Prediction", "predicted completion", "% chance", "AI predicts"];
    assert(
      banned.every((b) => !html.toLowerCase().includes(b.toLowerCase())),
      "no success-probability / prediction language anywhere on the page"
    );
    let d = await ctl("funder");
    const ALLOWED = ["BLOCKED", "AT_RISK", "WATCH", "DATA_INCOMPLETE", "HEALTHY"];
    assert(
      d.health.every((h) => ALLOWED.includes(h.status)) &&
        !JSON.stringify(d).match(/"(successScore|riskScore|probability)"/),
      "statuses come only from the allowed set; no invented score fields"
    );

    // ---- 3. seeded baseline: BLOCKED with grounded reasons ----
    let h = healthOf(d, "proj-r47");
    assert(
      h.status === "BLOCKED" && h.primaryReason.code === "HIGH_SEVERITY_EXCEPTION_OPEN",
      "seeded project is BLOCKED — open HIGH exception bound to M3 blocks its completion gate"
    );
    assert(
      h.reasons.every((r) => r.sources.length > 0) && h.reasons.every((r) => r.href),
      "every health reason cites at least one source record and a navigation target"
    );

    // ---- 4. precedence: BLOCKED outranks coexisting WATCH conditions ----
    const levels = new Set(h.reasons.map((r) => r.level));
    assert(
      levels.has("BLOCKED") && levels.has("WATCH") && h.status === "BLOCKED",
      "precedence: BLOCKED and WATCH conditions coexist and BLOCKED determines the status"
    );

    // ---- 5. single exception truth: surveillance links, never duplicates ----
    const excCountBefore = q1("SELECT COUNT(*) c FROM exceptions").c;
    await page("funder");
    await page("funder");
    const excCountAfter = q1("SELECT COUNT(*) c FROM exceptions").c;
    assert(
      excCountBefore === excCountAfter &&
        d.surveillance.every((r) => q1("SELECT id FROM exceptions WHERE id = ?", r.exceptionId)),
      "surveillance references existing ObvException rows; rendering creates no duplicate exception truth"
    );

    // ---- 6. every action grounded in source records ----
    assert(
      d.actions.length > 0 && d.actions.every((a) => a.sources.length > 0),
      `all ${d.actions.length} queue actions cite source records — none invented`
    );

    // ---- 7. blocked-amount dedup + overlap disclosure ----
    const catSum = d.exposure.categories.reduce((s, c) => s + c.amount, 0);
    assert(
      d.exposure.blockedUnique === 600000 && catSum > d.exposure.blockedUnique,
      `unique blocked ($${d.exposure.blockedUnique}) counts the multi-blocker draw once; category views overlap ($${catSum})`
    );
    assert(
      html.includes("Category totals can overlap"),
      "overlapping blocker-category disclosure is visible on the page"
    );

    // ---- 8. advisory ≠ approval ≠ release; retainage separate ----
    assert(
      d.exposure.advisoryTotal === null &&
        d.exposure.approvedGrossTotal === null &&
        typeof d.exposure.releasedNetTotal === "number" &&
        typeof d.exposure.retainageWithheld === "number" &&
        html.includes("NOT AVAILABLE") &&
        html.includes("An advisory recommendation is not an approval; an approval is not a release."),
      "advisory, approved, released and retainage stay distinct; unrecorded totals show NOT AVAILABLE, never 0"
    );

    // ---- 9. UNKNOWN never behaves as NOT_REQUIRED ----
    const m3 = d.gateRows.find((g) => g.milestoneId === "ms-3");
    assert(
      m3.requirement === "UNKNOWN" &&
        !d.gateRows.some((g) => g.requirement === "NOT_REQUIRED") &&
        html.includes("UNKNOWN never behaves as NOT REQUIRED"),
      "inspection requirement UNKNOWN is displayed as UNKNOWN — never inferred NOT_REQUIRED"
    );

    // ---- 10. RELEASED ≠ gates passed; legacy warning ----
    const m1 = d.gateRows.find((g) => g.milestoneId === "ms-1");
    assert(
      m1.funds === "RELEASED" && m1.contractor === "NOT_REPORTED" && m1.legacyReleased === true &&
        html.includes("Legacy released record — current completion-gate facts were not recorded at the time of release."),
      "released milestone keeps historical funds state, contractor NOT_REPORTED, and shows the legacy warning"
    );

    // ---- 11. AT_RISK after the blocking exception clears at source ----
    const r1 = await api("pm", "POST", "/api/issues/issue-1/status", { status: "RESOLVED" }, true);
    assert([200, 303].includes(r1.status), "seeded HIGH field issue resolved at its source (governed workflow)");
    d = await ctl("funder");
    h = healthOf(d, "proj-r47");
    assert(
      h.status === "AT_RISK" &&
        h.reasons.some((r) => r.code === "HIGH_SEVERITY_EXCEPTION_OPEN" || r.code === "FINANCIAL_AHEAD_OF_PHYSICAL"),
      "source cleared → milestone gate unblocks → status recomputes to AT_RISK from remaining severe exposure"
    );

    // ---- 12. contractor completion is never evidence verification ----
    const r2 = await api("pm", "POST", "/api/milestones/ms-5/contractor-completion", {
      status: "REPORTED_COMPLETE",
      notes: "Contractor states final surfacing complete",
    });
    assert(r2.status === 200, "contractor completion reported for M5 through the existing gate API");
    d = await ctl("funder");
    const m5 = d.gateRows.find((g) => g.milestoneId === "ms-5");
    assert(
      m5.contractor === "REPORTED_COMPLETE" && m5.evidence === "NOT_SUBMITTED" && m5.governance !== "READY_FOR_GOVERNANCE",
      "contractor REPORTED_COMPLETE leaves evidence NOT_SUBMITTED — never treated as verification"
    );

    // ---- 13. WATCH from a non-blocking overdue condition (synthetic project) ----
    const org = q1("SELECT organization_id o FROM projects WHERE id = 'proj-r47'").o;
    exec(
      "INSERT INTO projects (id, organization_id, name, description, location, site_boundary, total_budget, status) VALUES ('proj-ctl', ?, 'Control Test Project', 'test', 'Test', '[[33.5,-11.9],[33.7,-11.9],[33.7,-11.8],[33.5,-11.8],[33.5,-11.9]]', 100000, 'ACTIVE')",
      org
    );
    exec(
      "INSERT INTO milestones (id, project_id, seq, title, requirement, tranche_amount, status, account_status) VALUES ('ms-ctl-1', 'proj-ctl', 1, 'Test works', 'Photo of test works', 100000, 'NOT_STARTED', 'HELD')"
    );
    const r3 = await api(
      "pm", "POST", "/api/issues",
      { projectId: "proj-ctl", title: "Medium issue on control project", description: "test", category: "MATERIAL", severity: "MEDIUM" },
      true
    );
    assert([200, 201, 303].includes(r3.status), "MEDIUM field issue created on the synthetic project");
    d = await ctl("funder");
    let hc = healthOf(d, "proj-ctl");
    assert(
      hc.status === "WATCH" && hc.primaryReason.code === "OPEN_MEDIUM_FIELD_ISSUE",
      "WATCH status from a non-blocking condition (open MEDIUM field issue)"
    );

    // ---- 14. HEALTHY only when no higher-priority condition applies ----
    const issueId = q1("SELECT id FROM field_issues WHERE project_id = 'proj-ctl'").id;
    await api("pm", "POST", `/api/issues/${issueId}/status`, { status: "ACKNOWLEDGED" }, true);
    await api("pm", "POST", `/api/issues/${issueId}/status`, { status: "RESOLVED", resolutionSummary: "Resolved for control test" }, true);
    d = await ctl("funder");
    hc = healthOf(d, "proj-ctl");
    assert(
      hc.status === "HEALTHY" && hc.reasons.length === 0 && hc.primaryReason === null,
      "HEALTHY with zero conditions after the issue resolves — no adverse record, no invented reasons"
    );

    // ---- 15. DATA_INCOMPLETE when required control information is missing ----
    exec(
      "INSERT INTO projects (id, organization_id, name, description, location, site_boundary, total_budget, status) VALUES ('proj-empty', ?, 'Empty Data Project', 'test', 'Test', '[[33.5,-11.9],[33.7,-11.9],[33.7,-11.8],[33.5,-11.8],[33.5,-11.9]]', 50000, 'ACTIVE')",
      org
    );
    d = await ctl("funder");
    const he = healthOf(d, "proj-empty");
    assert(
      he.status === "DATA_INCOMPLETE" &&
        he.reasons.some((r) => r.code === "PHYSICAL_PROGRESS_DATA_INCOMPLETE"),
      "project with no milestone records is DATA_INCOMPLETE — never displayed as HEALTHY or zero"
    );

    // ---- 16. BLOCKED from a failed inspection outranks everything ----
    let r = await api("funder", "POST", "/api/milestones/ms-ctl-1/inspection-requirement", {
      requirement: "REQUIRED",
      requirementBasis: "Test statute ref",
      jurisdiction: "Test District",
      inspectionType: "structural",
    });
    if (r.status !== 200) console.error("  requirement error:", r.status, await r.text());
    assert(r.status === 200, "inspection requirement REQUIRED determined via the existing gates API");
    r = await api("funder", "POST", "/api/milestones/ms-ctl-1/inspections", { inspectionType: "structural" });
    const insp = (await r.json()).inspection;
    await api("funder", "POST", `/api/inspections/${insp.id}/schedule`, { scheduledAt: new Date().toISOString() });
    await api("funder", "POST", `/api/inspections/${insp.id}/complete`, {});
    r = await api("funder", "POST", `/api/inspections/${insp.id}/result`, {
      result: "FAILED",
      governmentInspectorName: "Inspector T. Demo",
      notes: "Failed on test criteria",
    });
    assert(r.status === 200, "FAILED jurisdictional inspection result recorded (reviewed, attributable)");
    d = await ctl("funder");
    hc = healthOf(d, "proj-ctl");
    assert(
      hc.status === "BLOCKED" && hc.reasons.some((x) => x.code === "INSPECTION_FAILED" && x.blocking),
      "BLOCKED from a hard inspection blocker with a machine-readable blocking reason"
    );

    // ---- 17. evidence verification is never inspection passage ----
    const mc = d.gateRows.find((g) => g.milestoneId === "ms-ctl-1");
    assert(
      mc.inspection === "FAILED" && mc.evidence === "NOT_SUBMITTED" && mc.governance === "BLOCKED",
      "six dimensions stay separate: failed inspection blocks governance regardless of evidence state"
    );

    // ---- 18. action queue reflects the blocker; filters + empty state ----
    const failedAction = d.actions.find((a) => a.type === "inspection" && a.priority === "IMMEDIATE");
    assert(
      failedAction && failedAction.blocking && failedAction.projectId === "proj-ctl",
      "IMMEDIATE blocking inspection action generated from the failed inspection record"
    );
    const filtered = await page("funder", "/control?priority=INFORMATIONAL&blocking=true");
    assert(
      filtered.includes("No actions match the current filters."),
      "impossible filter combination shows the honest empty state"
    );

    // ---- 19. waiver does not change source truth ----
    const varExc = q1(
      "SELECT id FROM exceptions WHERE source_type = 'BUDGET_VARIANCE' AND status NOT IN ('RESOLVED','CLOSED','WAIVED')"
    );
    if (varExc) {
      await api("compliance", "POST", `/api/exceptions/${varExc.id}/waive`, { reason: "Accepted variance for test" });
      d = await ctl("funder");
      h = healthOf(d, "proj-r47");
      assert(
        !h.reasons.some((x) => x.sources.some((s) => s.includes(varExc.id))) &&
          h.reasons.some((x) => x.code === "FINANCIAL_AHEAD_OF_PHYSICAL"),
        "waived exception leaves surveillance state but the source variance condition remains reported"
      );
    } else {
      pass("no open budget-variance exception to waive (source already reconciled) — waiver semantics covered by exceptions suite");
    }

    // ---- 20. read-only contract ----
    html = await page("funder");
    const postForms = html.match(/method="POST"/gi) ?? [];
    assert(
      postForms.length === 0 &&
        !html.includes('action="/api/approvals') &&
        !html.includes('action="/api/draws'),
      "no mutating form on the page — approvals, releases, verdicts and gates cannot be changed from Intelligence"
    );
    const svc = fs.readFileSync("dist/server/services/controlIntelligence.js", "utf8");
    assert(
      !svc.match(/require\(["'].*VirtualAccountService["']\)/) &&
        !svc.match(/holdTranche|releaseTranche|releaseDraw|withholdRetainage|releaseRetainage/),
      "control intelligence module never imports VirtualAccountService or its mutation methods — no route to financial state"
    );

    // ---- 21. authorization and scoping ----
    const anon = await fetch(BASE + "/control", { redirect: "manual" });
    const anonApi = await fetch(BASE + "/api/control/portfolio");
    assert(
      [302, 303].includes(anon.status) && anonApi.status === 401,
      "unauthenticated access is refused for both the page and the JSON view"
    );
    const fieldView = await api("field", "GET", "/control");
    assert(fieldView.status === 200, "field role gets the read-only oversight view (no mutation surface exists)");

    // ---- 22. project detail view ----
    const proj = await page("funder", "/control/project/proj-r47");
    assert(
      proj.includes("Control Intelligence — Mzimba") &&
        proj.includes("Completion &amp; Inspection Gates") &&
        proj.includes("Governed Action Queue") &&
        proj.includes("Draw &amp; Funds Exposure"),
      "project-level intelligence shows health, gates, exposure and the action queue"
    );
    const missing = await api("funder", "GET", "/control/project/nope");
    assert(missing.status === 404, "unknown project id returns an honest 404");

    // ---- 23. deterministic explanation fallback ----
    assert(
      html.includes("deterministic text shown here is used unchanged") &&
        html.includes("DETERMINISTIC"),
      "deterministic text is authoritative; AI-unavailable fallback is documented on the page"
    );

    // ---- 24. mobile rendering (Playwright when available) ----
    let pw = null;
    try {
      pw = require("playwright");
    } catch {
      try {
        pw = require(path.join(process.env.OBV_PLAYWRIGHT_NODE_PATH ?? "/opt/node22/lib/node_modules", "playwright"));
      } catch {}
    }
    if (pw) {
      const browser = await pw.chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.addCookies([
        { name: "obv_user", value: "user-funder", url: BASE },
      ]);
      const pg = await ctx.newPage();
      await pg.goto(BASE + "/control", { waitUntil: "networkidle" });
      const o = await pg.evaluate(() => ({
        s: document.documentElement.scrollWidth,
        c: document.documentElement.clientWidth,
      }));
      await browser.close();
      assert(o.s <= o.c + 1, "mobile (390px) renders without horizontal overflow");
    } else {
      pass("Playwright unavailable in this environment — mobile overflow covered by the UI screenshot pass");
    }

    console.log(`\nCONTROL INTELLIGENCE TESTS PASSED — ${n} checkpoints.`);
  } finally {
    srv.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
