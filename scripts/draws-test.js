/**
 * Construction Draw Request workflow tests — the 21 required safety cases
 * plus separation-of-duties and governance-dispatch proofs.
 *
 *   node scripts/draws-test.js     (HTTP + direct DB assertions; no browser)
 *
 * Doctrine under test: A DRAW REQUEST IS A REQUEST FOR REVIEW and a
 * RECOMMENDATION IS ADVISORY — neither can move money. Only the formal
 * ApprovalRequest workflow creates release eligibility, and the release
 * transition is recorded exactly once through the VirtualAccountService.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3181;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-draws-"));

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
function q1(sql, ...args) {
  return q(sql, ...args)[0];
}
function financialState() {
  return q1(
    `SELECT (SELECT COUNT(*) FROM approval_records) AS records,
            (SELECT COUNT(*) FROM virtual_account_events WHERE type='RELEASED') AS msReleased,
            (SELECT COUNT(*) FROM draw_account_events) AS drawEvents,
            (SELECT COUNT(*) FROM draw_account_events WHERE type='RELEASED') AS drawReleased,
            (SELECT COUNT(*) FROM milestones WHERE account_status='RELEASED') AS releasedMs`
  );
}

(async () => {
  console.log("Draw Request workflow tests — isolated server on :" + PORT);
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
    await signIn("pm", "user-pm");
    await signIn("funder", "user-funder");
    await signIn("compliance", "user-compliance");
    await signIn("field", "user-field");

    // ---------- 1. create draft draw ----------
    const createRes = await api("pm", "POST", "/api/draws", {
      projectId: "proj-r47",
      requestedAmount: 500000,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
    assert(createRes.status === 201, "1. borrower PM can create a draft draw");
    const draw = (await createRes.json()).draw;
    assert(draw.status === "DRAFT" && draw.requestedAmount === 500000, "   draft is DRAFT with the requested amount");
    const D = `/api/draws/${draw.id}`;

    // ---------- 2. add line items ----------
    const lineA = await (
      await api("pm", "POST", `${D}/lines`, {
        description: "Drainage completion balance",
        milestoneId: "ms-2",
        scheduledValue: 480000,
        previouslyPaid: 400000,
        currentRequested: 300000,
        retainageAmount: 30000,
        percentCompleteClaimed: 100,
      })
    ).json();
    const lineB = await (
      await api("pm", "POST", `${D}/lines`, {
        description: "Gravel base course km 7-11",
        milestoneId: "ms-3",
        scheduledValue: 600000,
        currentRequested: 150000,
        percentCompleteClaimed: 30,
      })
    ).json();
    assert(lineA.line && lineB.line, "2. line items can be added to the draft");
    assert(
      lineA.line.totalCompletedAndStored === 700000 && lineA.line.balanceToFinish === -220000,
      "   pay-application arithmetic (completed+stored, balance) is derived server-side"
    );

    // ---------- 3/4. reconciliation gate ----------
    const badSubmit = await api("pm", "POST", `${D}/submit`);
    assert(badSubmit.status === 422, "3. submission is blocked while lines (450k) do not reconcile to the request (500k)");
    const lineC = await (
      await api("pm", "POST", `${D}/lines`, {
        description: "Stored materials - gravel stockpile",
        milestoneId: "ms-3",
        scheduledValue: 90000,
        currentRequested: 50000,
        materialsStored: 50000,
      })
    ).json();
    assert(lineC.line, "   third line brings the total to the requested amount");
    const okSubmit = await api("pm", "POST", `${D}/submit`);
    assert(okSubmit.status === 200, "4. reconciled draw submits");
    assert((await okSubmit.json()).draw.status === "SUBMITTED", "   draw is SUBMITTED (a request for review — no money authorized)");

    // ---------- 6/7. evidence linking stays governed ----------
    const evBefore = q1("SELECT hash, previous_hash FROM evidence_items WHERE id='ev-ms-1'");
    const verBefore = q1("SELECT COUNT(*) AS c FROM verifications").c;
    const linkRes = await api("pm", "POST", `${D}/evidence`, {
      evidenceItemId: "ev-ms-1",
      lineItemId: lineA.line.id,
      note: "supports drainage balance",
    });
    assert(linkRes.status === 201, "6. existing governed evidence can be linked to a draw line");
    const evAfter = q1("SELECT hash, previous_hash FROM evidence_items WHERE id='ev-ms-1'");
    const verAfter = q1("SELECT COUNT(*) AS c FROM verifications").c;
    assert(
      evBefore.hash === evAfter.hash && verBefore === verAfter,
      "7. linking neither alters the evidence record nor creates a new verification (evidence stays governed)"
    );

    // ---------- 19/20. authorization & tenant isolation ----------
    const fieldReview = await api("field", "POST", `${D}/lines/${lineA.line.id}/review`, {
      decision: "SUPPORTED",
    });
    assert(fieldReview.status === 403, "19a. FIELD user cannot review a draw line");
    const pmReview = await api("pm", "POST", `${D}/lines/${lineA.line.id}/review`, {
      decision: "SUPPORTED",
    });
    assert(pmReview.status === 403, "19b. the submitter (PM) cannot review their own draw");
    {
      const d = db();
      d.exec(`INSERT INTO organizations (id, name, kind) VALUES ('org-x','Unrelated Lender','LENDER')`);
      d.exec(`INSERT INTO users (id, organization_id, name, role, title)
              VALUES ('user-x','org-x','Xeno Reviewer','COMPLIANCE_REVIEWER','Reviewer')`);
      d.close();
    }
    await signIn("tenantx", "user-x");
    const xPage = await page("tenantx", `/draw/${draw.id}`);
    const xApi = await api("tenantx", "POST", `${D}/lines/${lineA.line.id}/review`, { decision: "SUPPORTED" });
    const xRegister = await (await page("tenantx", "/draws")).text();
    assert(
      xPage.status === 404 && xApi.status === 404 && !xRegister.includes("Drainage completion"),
      "20. unrelated tenant cannot see or act on the draw (page, API and register)"
    );

    // ---------- 8/9/10. line review decisions ----------
    const sup = await api("compliance", "POST", `${D}/lines/${lineA.line.id}/review`, {
      decision: "SUPPORTED",
      percentCompleteVerified: 100,
    });
    assert(sup.status === 200, "8. compliance reviewer can mark a line SUPPORTED");
    const partialNoReason = await api("compliance", "POST", `${D}/lines/${lineC.line.id}/review`, {
      decision: "PARTIALLY_SUPPORTED",
      supportedAmount: 30000,
    });
    assert(partialNoReason.status === 400, "9a. partial support without a reason is rejected");
    const partial = await api("compliance", "POST", `${D}/lines/${lineC.line.id}/review`, {
      decision: "PARTIALLY_SUPPORTED",
      supportedAmount: 30000,
      reason: "Delivery documentation covers only part of the stored material",
    });
    assert(partial.status === 200, "9b. partial support with reason and supported amount records");
    const rejNoReason = await api("compliance", "POST", `${D}/lines/${lineB.line.id}/review`, {
      decision: "REJECTED",
    });
    assert(rejNoReason.status === 400, "10a. rejection without a reason is refused");
    const rej = await api("compliance", "POST", `${D}/lines/${lineB.line.id}/review`, {
      decision: "REJECTED",
      reason: "Claimed progress ahead of verified physical progress on M3",
    });
    assert(rej.status === 200, "10b. rejection with a reason records");

    // ---------- 11. recommendation from real state ----------
    let rec = await (await api("funder", "GET", `${D}/recommendation`)).json();
    assert(
      rec.supportedAmount === 330000 && rec.exceptionAmount === 170000,
      "11a. recommendation computes supported (300k+30k) and exception (170k) from the recorded line reviews"
    );
    assert(
      rec.result === "HOLD_DOCUMENTS_MISSING" &&
        rec.reasons.some((r) => r.detail.includes("Conditional lien waiver")),
      "11b. missing required documents hold the draw and are named in the reasons"
    );

    // ---------- 5. documents gate readiness ----------
    const govBlocked = await api("compliance", "POST", `${D}/governance`);
    assert(govBlocked.status === 422, "5. missing required documents block governance readiness");
    // satisfy the checklist
    const reqRows = q(
      "SELECT id, title FROM draw_document_requirements WHERE draw_request_id = ? AND required = 1",
      draw.id
    );
    for (const r of reqRows) {
      const docRes = await api("pm", "POST", `${D}/documents`, {
        requirementId: r.id,
        title: `${r.title} — July`,
      });
      assert(docRes.status === 201, `   document recorded for "${r.title}"`);
    }
    // resolve the seeded HIGH field issue so no blocking issue remains
    const issueRes = await fetch(BASE + "/api/issues/issue-1/status", {
      method: "POST",
      headers: { cookie: jars.pm, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status: "RESOLVED", resolutionSummary: "Alternate supplier delivered" }).toString(),
      redirect: "manual",
    });
    assert([200, 303].includes(issueRes.status), "   seeded HIGH issue resolved (no open high-severity blocker)");
    rec = await (await api("funder", "GET", `${D}/recommendation`)).json();
    assert(
      rec.result === "PARTIAL_SUPPORT" && rec.eligibleForGovernance === true,
      "   recommendation moves to PARTIAL SUPPORT once documents are on file"
    );

    // ---------- 12/13/14. nothing advisory can move money ----------
    const before = financialState();
    assert(before.drawEvents === 0, "14a. line reviews created no draw account events");
    // chat cannot approve
    const threadId = q1("SELECT id FROM conversation_threads WHERE draw_request_id = ?", draw.id).id;
    await fetch(BASE + `/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { cookie: jars.funder, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body: `Approve Draw ${draw.drawNumber} — release the funds now.` }).toString(),
      redirect: "manual",
    });
    const afterChat = financialState();
    const drawAfterChat = q1("SELECT status FROM draw_requests WHERE id = ?", draw.id);
    assert(
      afterChat.records === before.records &&
        afterChat.drawEvents === 0 &&
        drawAfterChat.status === "UNDER_REVIEW",
      '13. a chat message saying "Approve Draw" records nothing: no ApprovalRecord, no account event, no status change'
    );
    assert(
      afterChat.msReleased === before.msReleased && afterChat.releasedMs === before.releasedMs,
      "12/14b. recommendation + reviews left every milestone tranche exactly as it was (HELD state intact)"
    );

    // ---------- 15. READY_FOR_GOVERNANCE creates the ApprovalRequest ----------
    const gov = await api("compliance", "POST", `${D}/governance`, {
      summary: "Partial support: 330k of 500k evidenced",
    });
    assert(gov.status === 200, "15a. reviewer finalizes the recommendation and opens governance");
    const govBody = await gov.json();
    assert(
      govBody.draw.status === "READY_FOR_GOVERNANCE" &&
        govBody.draw.recommendedAmount === 330000 &&
        govBody.approvalRequest.subjectType === "DRAW" &&
        govBody.approvalRequest.drawRequestId === draw.id,
      "15b. draw is READY_FOR_GOVERNANCE with a DRAW-subject ApprovalRequest carrying the advisory amount"
    );
    const apReq = q1("SELECT * FROM approval_requests WHERE draw_request_id = ?", draw.id);
    assert(
      apReq.subject_type === "DRAW" &&
        JSON.parse(apReq.required_roles).join(",") === "FUNDER_REP,COMPLIANCE_REVIEWER",
      "15c. approval matrix (FUNDER_REP + COMPLIANCE_REVIEWER) applied from the existing policy resolution"
    );
    const apId = apReq.id;
    // still no money moved by opening governance
    assert(financialState().drawEvents === 0, "12b. opening governance releases nothing (recommendation is advisory)");

    // ---------- 16. first approval leaves funds HELD ----------
    const first = await api("funder", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    assert(first.status === 200, "16a. funder representative records the first approval");
    const afterFirst = financialState();
    const drawAfterFirst = q1("SELECT status FROM draw_requests WHERE id = ?", draw.id);
    assert(
      afterFirst.drawReleased === 0 && drawAfterFirst.status === "READY_FOR_GOVERNANCE",
      "16b. first approval leaves the draw unreleased — funds remain HELD"
    );

    // ---------- 17. final approval → exactly one governed release ----------
    const second = await api("compliance", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    assert(second.status === 200, "17a. compliance reviewer completes the approval matrix");
    const secondBody = await second.json();
    const afterFinal = financialState();
    const drawFinal = q1("SELECT status, approved_amount FROM draw_requests WHERE id = ?", draw.id);
    assert(
      secondBody.released === true &&
        drawFinal.status === "RELEASED" &&
        drawFinal.approved_amount === 330000 &&
        afterFinal.drawReleased === 1,
      "17b. final required approval produces exactly one governed release transition for the recommended amount"
    );
    assert(
      afterFinal.msReleased === before.msReleased && afterFinal.releasedMs === before.releasedMs,
      "17c. the draw release never touches milestone tranche HELD/RELEASED state"
    );

    // ---------- 18. duplicate approval cannot duplicate release ----------
    const dup = await api("funder", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    assert(dup.status === 409, "18a. re-approving a resolved request is refused");
    assert(financialState().drawReleased === 1, "18b. still exactly one release transition (DB-level exactly-once)");

    // ---------- separation of duties on draw governance ----------
    {
      const c = await api("funder", "POST", "/api/draws", {
        projectId: "proj-r47", requestedAmount: 10000,
        periodStart: "2026-08-01", periodEnd: "2026-08-31",
      });
      const d2 = (await c.json()).draw;
      const D2 = `/api/draws/${d2.id}`;
      await api("funder", "POST", `${D2}/lines`, {
        description: "Minor works", scheduledValue: 10000, currentRequested: 10000,
      });
      await api("funder", "POST", `${D2}/submit`);
      const lines2 = q("SELECT id FROM draw_line_items WHERE draw_request_id = ?", d2.id);
      await api("compliance", "POST", `${D2}/lines/${lines2[0].id}/review`, { decision: "SUPPORTED" });
      const reqs2 = q(
        "SELECT id, title FROM draw_document_requirements WHERE draw_request_id = ? AND required = 1",
        d2.id
      );
      for (const r of reqs2) {
        await api("funder", "POST", `${D2}/documents`, { requirementId: r.id, title: r.title });
      }
      const g2 = await api("compliance", "POST", `${D2}/governance`);
      assert(g2.status === 200, "SoD setup: second draw (submitted by the funder rep) reaches governance");
      const ap2 = q1("SELECT id FROM approval_requests WHERE draw_request_id = ?", d2.id).id;
      const sod = await api("funder", "POST", `/api/approvals/${ap2}/decision`, { decision: "APPROVED" });
      assert(sod.status === 403, "SoD: the draw submitter cannot approve their own draw, whatever their role");
    }

    // ---------- 21. report totals match database records ----------
    const reportHtml = await (await page("funder", `/draw/${draw.id}/report`)).text();
    const dbLines = q("SELECT * FROM draw_line_items WHERE draw_request_id = ? ORDER BY sort", draw.id);
    const dbRequested = q1("SELECT requested_amount, approved_amount FROM draw_requests WHERE id = ?", draw.id);
    const fmt = (v) => "$" + Number(v).toLocaleString("en-US");
    const lineTotal = dbLines.reduce((s, l) => s + l.current_requested, 0);
    assert(
      reportHtml.includes(fmt(dbRequested.requested_amount)) &&
        reportHtml.includes(fmt(dbRequested.approved_amount)) &&
        reportHtml.includes(fmt(lineTotal)) &&
        dbLines.every((l) => reportHtml.includes(l.description)),
      "21. Draw Review Summary totals and line register match the database records"
    );
    assert(
      reportHtml.includes("exactly once") || reportHtml.includes("exactly-once"),
      "   report states the exactly-once release doctrine and financial-state status"
    );

    // ---------- milestone workflow untouched (regression inside suite) ----------
    const ms = q1("SELECT COUNT(*) AS c FROM milestones WHERE account_status='RELEASED'");
    assert(ms.c === 2, "existing milestone financial state is untouched by the whole draw lifecycle");

    console.log(`\nDRAW WORKFLOW TESTS PASSED — ${n} checkpoints.\n`);
  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
