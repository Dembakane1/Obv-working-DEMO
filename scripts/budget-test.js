/**
 * Budget vs Verified Physical Progress tests — the 16 required cases plus
 * verified-quantity guardrails.
 *
 *   node scripts/budget-test.js     (HTTP + direct DB assertions; no browser)
 *
 * Doctrine under test: financial progress and physical progress are
 * different measurements, compared but never merged; every physical
 * figure is traceable to verified records; unverified evidence
 * contributes nothing; variance language never claims misconduct; and
 * post-launch budget changes require reason + audit + config version.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3182;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-budget-"));

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
async function api(key, method, p, body) {
  return fetch(BASE + p, {
    method,
    headers: { cookie: jars[key] ?? "", "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
}
async function page(key, p) {
  return fetch(BASE + p, { headers: { cookie: jars[key] ?? "" }, redirect: "manual" });
}
function db() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path.join(DATA_DIR, "obv.db"));
}
function q(sql, ...args) {
  const d = db();
  const r = d.prepare(sql).all(...args);
  d.close();
  return r;
}
const q1 = (sql, ...args) => q(sql, ...args)[0];

(async () => {
  console.log("Budget vs Verified Progress tests — isolated server on :" + PORT);
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
    await signIn("compliance", "user-compliance");
    await signIn("pm", "user-pm");
    await signIn("field", "user-field");
    const progress = async () => (await api("funder", "GET", "/api/projects/proj-r47/progress")).json();

    // ---------- 1. create budget lines ----------
    const created = await api("funder", "POST", "/api/budget-lines", {
      projectId: "proj-r47", code: "05-100", category: "Testing",
      description: "test line", originalBudget: 100000, paidToDate: 8000,
      milestoneIds: ["ms-3"],
    });
    assert(created.status === 201, "1a. funder rep can create a budget line");
    const line5 = (await created.json()).line;
    assert(line5.currentBudget === 100000 && line5.approvedChanges === 0, "   currentBudget derives from original + approved changes");
    const dup = await api("funder", "POST", "/api/budget-lines", {
      projectId: "proj-r47", code: "05-100", category: "Testing", originalBudget: 1,
    });
    assert(dup.status === 409, "1b. duplicate budget line code is rejected");
    const fieldCreate = await api("field", "POST", "/api/budget-lines", {
      projectId: "proj-r47", code: "05-200", category: "Testing", originalBudget: 1,
    });
    const pmCreate = await api("pm", "POST", "/api/budget-lines", {
      projectId: "proj-r47", code: "05-201", category: "Testing", originalBudget: 1,
    });
    assert(fieldCreate.status === 403 && pmCreate.status === 403, "1c. budget management is restricted to lender review roles");

    // ---------- 2. totals reconcile ----------
    let d0 = await progress();
    const dbTotals = q1(
      "SELECT SUM(original_budget + approved_changes) AS budget, SUM(paid_to_date) AS paid FROM budget_lines WHERE project_id='proj-r47' AND active=1"
    );
    assert(
      d0.financial.budgetBasis === dbTotals.budget && d0.financial.paidToDate === dbTotals.paid,
      `2. project totals reconcile to budget line records (${dbTotals.budget} budget, ${dbTotals.paid} paid)`
    );
    assert(d0.financial.budgetBasisSource === "BUDGET_LINES", "   budget basis source is disclosed");

    // ---------- 3. milestone mapping ----------
    const row5 = d0.register.find((r) => r.line.code === "05-100");
    assert(
      row5 && row5.mappedMilestoneIds.includes("ms-3") && row5.verifiedPct !== null,
      "3. budget line maps to a milestone and gains a verified-progress basis"
    );

    // ---------- 4/5. physical progress contributions ----------
    const contrib = (id) => d0.physical.contributions.find((c) => c.milestoneId === id);
    assert(
      d0.physical.weightSource === "CONFIGURED_WEIGHTS" &&
        contrib("ms-1").contributionPct === 10 &&
        contrib("ms-2").contributionPct === 20,
      "4. verified milestones contribute exactly their configured weights (10 + 20 pts)"
    );
    assert(
      contrib("ms-3").contributionPct === 0 &&
        contrib("ms-3").state === "NO_VERIFIED_PROGRESS" &&
        d0.physical.verifiedPct === 30,
      "5. unverified milestones contribute zero — verified physical progress is 30%"
    );

    // ---------- 6/7. financial + claimed progress ----------
    assert(
      d0.financial.paidToDate === 728000 && d0.financial.paidPct === 29.1,
      "6. paid progress computes from budget line records (728k / 2.5M = 29.1%)"
    );
    assert(
      d0.financial.openDrawRequested === 600000 && d0.financial.claimedPct === 53.1,
      "7. claimed progress adds open draw requests ((728k + 600k) / 2.5M = 53.1%)"
    );

    // ---------- 8/9. variance states ----------
    assert(
      d0.financial.varianceState === "FINANCIAL_AHEAD" && d0.financial.variancePts > 10,
      "8a. project variance beyond the watch threshold reads FINANCIAL AHEAD"
    );
    const states = Object.fromEntries(d0.register.map((r) => [r.line.code, r.varianceState]));
    assert(states["01-000"] === "WITHIN_RANGE", "8b. fully paid + fully verified line is WITHIN RANGE");
    assert(states["02-610"] === "FINANCIAL_AHEAD", "8c. line requested ahead of verified progress is FINANCIAL AHEAD");
    assert(states["05-100"] === "WATCH", "8d. 8-point difference lands in WATCH (5–10 pts)");
    // PHYSICAL_AHEAD: financial 0% against a verified milestone.
    await api("funder", "POST", "/api/budget-lines", {
      projectId: "proj-r47", code: "05-300", category: "Testing",
      originalBudget: 50000, paidToDate: 0, milestoneIds: ["ms-1"],
    });
    // DATA_INCOMPLETE: no milestone mapping at all.
    await api("funder", "POST", "/api/budget-lines", {
      projectId: "proj-r47", code: "05-400", category: "Testing", originalBudget: 50000,
    });
    d0 = await progress();
    const stateOf = (code) => d0.register.find((r) => r.line.code === code).varianceState;
    assert(stateOf("05-300") === "PHYSICAL_AHEAD", "8e. verified work with no billing reads PHYSICAL AHEAD");
    assert(stateOf("05-400") === "DATA_INCOMPLETE", "9. a line with no milestone mapping reads DATA INCOMPLETE");

    // ---------- 10. traceability ----------
    const basis = contrib("ms-1").basis;
    assert(
      basis.evidenceItemId === "ev-ms-1" &&
        basis.verificationId &&
        basis.verdict === "VERIFIED" &&
        basis.ledgerSeq !== null,
      "10. every physical contribution traces to evidence, verification and ledger entry"
    );

    // ---------- 13. intelligence signals ----------
    const insights = await (await page("funder", "/insights")).text();
    assert(
      insights.includes("ahead of currently verified physical progress"),
      "13a. intelligence surfaces the financial-ahead signal with permitted language"
    );
    assert(
      /budget-line-unsupported-request|unsupported/i.test(insights) || insights.includes("02-610"),
      "13b. budget line with unsupported current request is signalled"
    );

    // ---------- verified-quantity guardrails (methodology) ----------
    const badQty1 = await api("compliance", "POST", "/api/verified-quantities", {
      milestoneId: "ms-3", percent: 50, quantityLabel: "7 of 14 km",
      evidenceItemId: "does-not-exist", reason: "test",
    });
    assert(badQty1.status === 400, "quantity without evidence of the milestone is rejected");
    const badQty2 = await api("compliance", "POST", "/api/verified-quantities", {
      milestoneId: "ms-1", percent: 50, quantityLabel: "x",
      evidenceItemId: "ev-ms-1", reason: "test",
    });
    assert(badQty2.status === 409, "quantity on an already-verified milestone is rejected (full weight applies)");
    const pmQty = await api("pm", "POST", "/api/verified-quantities", {
      milestoneId: "ms-3", percent: 50, quantityLabel: "x", evidenceItemId: "ev-ms-1", reason: "t",
    });
    assert(pmQty.status === 403, "quantities require an authorized lender review role");
    // Happy path: verify M3 evidence, reject governance (milestone returns
    // to PENDING_EVIDENCE with VERIFIED evidence on file), record quantity.
    const ctx = await (await api("field", "GET", "/api/field-context")).json();
    const m3ctx = ctx.projects[0].milestones.find((m) => m.id === "ms-3");
    const ev = await api("field", "POST", "/api/evidence", {
      milestoneId: "ms-3",
      demoPhotoId: m3ctx.demoPhotos[0].id,
      latitude: ctx.projects[0].simulatedGps.latitude,
      longitude: ctx.projects[0].simulatedGps.longitude,
      capturedAt: new Date(Date.now() - 20 * 60000).toISOString(),
      deviceMetadata: { userAgent: "budget-test", platform: "test", screen: "1x1", language: "en" },
      isDemoFallback: true,
    });
    const evBody = await ev.json();
    assert(ev.status === 201 && evBody.verification.verdict === "VERIFIED", "M3 evidence verifies through the unchanged pipeline");
    await api("funder", "POST", `/api/approvals/${evBody.approvalRequest.id}/decision`, { decision: "REJECTED" });
    const qty = await api("compliance", "POST", "/api/verified-quantities", {
      milestoneId: "ms-3", percent: 60, quantityLabel: "8.4 of 14 km base laid",
      evidenceItemId: evBody.evidence.id, reason: "Measured chainage supported by verified photo",
    });
    assert(qty.status === 201, "authorized reviewer records a measured quantity against VERIFIED evidence");
    d0 = await progress();
    const c3 = d0.physical.contributions.find((c) => c.milestoneId === "ms-3");
    assert(
      c3.state === "PARTIAL_MEASURED" && c3.contributionPct === 15 && d0.physical.verifiedPct === 45,
      "partial measured progress contributes percent × weight (60% × 25 = 15 pts → 45% total)"
    );
    assert(
      c3.basis.quantityRecordId && c3.basis.evidenceItemId === evBody.evidence.id,
      "the quantity contribution traces to its record and verified evidence"
    );

    // ---------- 11. no fraud language ----------
    const budgetHtml = await (await page("funder", "/project/proj-r47/budget")).text();
    const reportHtml = await (await page("funder", "/draw/draw-1/report")).text();
    const banned = /fraud|misuse|misappropri|theft|stolen|embezzl/i;
    assert(
      !banned.test(budgetHtml) && !banned.test(reportHtml),
      "11a. no fraud/misuse claims anywhere on the budget page or draw report"
    );
    assert(
      /ahead of currently verified physical progress/i.test(budgetHtml),
      '11b. variance language is exactly "financial progress is ahead of currently verified physical progress"'
    );

    // ---------- 12. draw integration ----------
    const drawLines = await (await page("funder", "/draw/draw-1?tab=lines")).text();
    assert(
      drawLines.includes("Exception candidate") && drawLines.includes("Verified physical"),
      "12a. draw line items show financial vs verified comparison with advisory exception candidates"
    );
    const drawStatus = q1("SELECT status FROM draw_requests WHERE id='draw-1'");
    assert(drawStatus.status === "UNDER_REVIEW", "12b. exception candidates never auto-reject the draw (status unchanged)");
    assert(
      reportHtml.includes("Budget vs verified physical progress") && /methodology/i.test(reportHtml),
      "12c. Draw Review Summary carries the comparison section with methodology disclosure"
    );

    // ---------- 14. post-launch change control ----------
    const silent = await api("funder", "POST", "/api/budget-lines/update", {
      budgetLineId: line5.id, originalBudget: 120000,
    });
    assert(silent.status === 422, "14a. silent budget change on a launched project is refused");
    const snapsBefore = q1("SELECT COUNT(*) c FROM config_snapshots WHERE project_id='proj-r47'").c;
    const withReason = await api("funder", "POST", "/api/budget-lines/update", {
      budgetLineId: line5.id, originalBudget: 120000, reason: "Scope adjustment approved by lender committee",
    });
    assert(withReason.status === 200, "14b. budget change with an explicit reason succeeds");
    const auditRow = q1(
      "SELECT reason FROM config_audit WHERE entity_id = ? AND action='BUDGET_LINE_UPDATED' ORDER BY created_at DESC LIMIT 1",
      line5.id
    );
    const snapsAfter = q1("SELECT COUNT(*) c FROM config_snapshots WHERE project_id='proj-r47'").c;
    const cfgVersion = q1("SELECT config_version v FROM projects WHERE id='proj-r47'").v;
    assert(
      auditRow?.reason?.includes("Scope adjustment") && snapsAfter === snapsBefore + 1 && cfgVersion >= 2,
      "14c. change is audited with reason, new configuration snapshot and bumped config version"
    );
    const paidOnly = await api("funder", "POST", "/api/budget-lines/update", {
      budgetLineId: line5.id, paidToDate: 9000,
    });
    assert(paidOnly.status === 200, "14d. recording paid-to-date (a financial record, not a budget change) needs no reason");

    // ---------- 15. tenant isolation ----------
    {
      const d = db();
      d.exec(`INSERT INTO organizations (id, name, kind) VALUES ('org-x','Unrelated Lender','LENDER')`);
      d.exec(`INSERT INTO users (id, organization_id, name, role, title)
              VALUES ('user-x','org-x','Xeno Reviewer','FUNDER_REP','Reviewer')`);
      d.close();
    }
    await signIn("tenantx", "user-x");
    const xPage = await page("tenantx", "/project/proj-r47/budget");
    const xApi = await api("tenantx", "POST", "/api/budget-lines", {
      projectId: "proj-r47", code: "06-000", category: "X", originalBudget: 1,
    });
    const xPortfolio = await (await page("tenantx", "/budget")).text();
    assert(
      xPage.status === 404 && xApi.status === 404 && !xPortfolio.includes("Mzimba"),
      "15. unrelated tenant cannot see or manage the project's budget (page, API, portfolio)"
    );

    // ---------- 16. report figures match source records ----------
    const d1 = await progress();
    const freshReport = await (await page("funder", "/draw/draw-1/report")).text();
    const freshBudgetHtml = await (await page("funder", "/project/proj-r47/budget")).text();
    assert(
      freshReport.includes(`${d1.financial.claimedPct}%`) &&
        freshReport.includes(`${d1.physical.verifiedPct}%`) &&
        freshBudgetHtml.includes("$" + d1.financial.budgetBasis.toLocaleString("en-US")) &&
        freshBudgetHtml.includes(`${d1.physical.verifiedPct}%`),
      "16. report and page figures match the computed source records exactly"
    );

    // ---------- preserved invariants ----------
    const fin = q1(
      `SELECT (SELECT COUNT(*) FROM virtual_account_events WHERE type='RELEASED') AS rel,
              (SELECT COUNT(*) FROM draw_account_events) AS drawEv,
              (SELECT COUNT(*) FROM ledger_entries) AS ledger`
    );
    assert(
      fin.rel === 2 && fin.drawEv === 0,
      "budget/progress activity moved no money: released tranches and draw accounts unchanged"
    );

    console.log(`\nBUDGET VS VERIFIED PROGRESS TESTS PASSED — ${n} checkpoints.\n`);
  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
