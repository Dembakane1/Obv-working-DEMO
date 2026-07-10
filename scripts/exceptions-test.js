/**
 * Unified Exception Management tests — the 16 required cases plus waiver
 * and idempotency guardrails.
 *
 *   node scripts/exceptions-test.js   (HTTP + direct DB assertions)
 *
 * Doctrine under test: an Exception is a control record referencing an
 * authoritative source; auto-creation is idempotent; resolution respects
 * source state; waivers require authorization + reason + audit and never
 * rewrite the source; and no exception action can release funds.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3183;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-exc-"));

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
function exec(sql, ...args) {
  const d = db();
  d.prepare(sql).run(...args);
  d.close();
}
const financial = () =>
  q1(
    `SELECT (SELECT COUNT(*) FROM virtual_account_events WHERE type='RELEASED') AS rel,
            (SELECT COUNT(*) FROM draw_account_events) AS drawEv,
            (SELECT COUNT(*) FROM approval_records) AS recs`
  );

(async () => {
  console.log("Unified Exception tests — isolated server on :" + PORT);
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
    const before = financial();

    // ---------- seeded sweep + idempotency (2, 4, 5) ----------
    const evalOnce = await (await api("funder", "POST", "/api/exceptions/evaluate")).json();
    const count1 = q1("SELECT COUNT(*) c FROM exceptions").c;
    const evalTwice = await (await api("funder", "POST", "/api/exceptions/evaluate")).json();
    const count2 = q1("SELECT COUNT(*) c FROM exceptions").c;
    assert(
      count1 === count2 && evalTwice.created === 0 && evalTwice.reopened === 0,
      `2. repeated rule evaluation creates no duplicates (${count1} exceptions before and after)`
    );
    const docExc = q1("SELECT * FROM exceptions WHERE source_key LIKE 'draw-doc-missing:%'");
    assert(
      docExc && docExc.severity === "MEDIUM" && docExc.category === "DOCUMENT",
      "4. missing required draw document produced one MEDIUM document exception"
    );
    const varExc = q1("SELECT * FROM exceptions WHERE source_key = 'budget-variance:proj-r47'");
    assert(
      varExc && varExc.severity === "HIGH" && varExc.category === "COST",
      "5. material financial variance produced a HIGH cost exception (rule-based severity)"
    );
    const issueExc = q1("SELECT * FROM exceptions WHERE source_key = 'field-issue:issue-1'");
    assert(issueExc && issueExc.severity === "HIGH", "   HIGH field issue produced a linked operational exception");

    // ---------- 1. rejected evidence creates exactly one exception ----------
    const ctx = await (await api("field", "GET", "/api/field-context")).json();
    const m3ctx = ctx.projects[0].milestones.find((m) => m.id === "ms-3");
    const evRes = await api("field", "POST", "/api/evidence", {
      milestoneId: "ms-3",
      demoPhotoId: m3ctx.demoPhotos[0].id,
      latitude: ctx.projects[0].simulatedGps.latitude,
      longitude: ctx.projects[0].simulatedGps.longitude,
      capturedAt: new Date(Date.now() + 3 * 86400_000).toISOString(), // future capture -> metadata REJECTED
      deviceMetadata: { userAgent: "exc-test", platform: "test", screen: "1x1", language: "en" },
      isDemoFallback: true,
    });
    const evBody = await evRes.json();
    assert(evBody.verification.verdict === "REJECTED", "   future-dated capture is REJECTED by the unchanged pipeline");
    await api("funder", "POST", "/api/exceptions/evaluate");
    await api("funder", "POST", "/api/exceptions/evaluate");
    const rejExcs = q("SELECT * FROM exceptions WHERE source_key = ?", `evidence-rejected:${evBody.evidence.id}`);
    assert(
      rejExcs.length === 1 && rejExcs[0].severity === "HIGH" && rejExcs[0].category === "EVIDENCE",
      "1. rejected evidence created exactly ONE HIGH evidence exception (double evaluation, one record)"
    );
    const rejExcId = rejExcs[0].id;

    // ---------- 7/8. waiver authorization + reason + audit ----------
    const fieldWaive = await api("field", "POST", `/api/exceptions/${varExc.id}/waive`, { reason: "x" });
    const pmWaive = await api("pm", "POST", `/api/exceptions/${varExc.id}/waive`, { reason: "x" });
    assert(fieldWaive.status === 403 && pmWaive.status === 403, "7. field/PM roles cannot waive an exception");
    const noReason = await api("funder", "POST", `/api/exceptions/${varExc.id}/waive`, {});
    assert(noReason.status === 400, "8a. waiver without a reason is refused");
    const waived = await api("funder", "POST", `/api/exceptions/${varExc.id}/waive`, {
      reason: "Variance accepted for this period: stored materials invoice en route",
    });
    assert(waived.status === 200, "8b. authorized waiver with reason succeeds");
    const waiveAudit = q1(
      "SELECT * FROM config_audit WHERE action='EXCEPTION_WAIVED' AND entity_id = ?",
      varExc.id
    );
    assert(Boolean(waiveAudit?.reason), "8c. waiver is written to the configuration audit trail");
    // waiver does not rewrite source truth: variance state still FINANCIAL_AHEAD
    const prog = await (await api("funder", "GET", "/api/projects/proj-r47/progress")).json();
    assert(
      prog.financial.varianceState === "FINANCIAL_AHEAD",
      "8d. the waiver did not rewrite the source truth (budget variance still computed from records)"
    );
    await api("funder", "POST", "/api/exceptions/evaluate");
    assert(
      q1("SELECT status FROM exceptions WHERE id = ?", varExc.id).status === "WAIVED",
      "8e. the sweep respects the waiver (no reopen while waived)"
    );

    // ---------- 3. approval delay exception ----------
    exec("UPDATE approval_requests SET created_at = ? WHERE milestone_id = 'ms-3' AND status='PENDING'",
      new Date(Date.now() - 60 * 3600_000).toISOString());
    // (no pending milestone approval exists yet — create one via a fresh clean submission? Use the draw path instead)
    // Backdate is applied to any pending request; if none, create via draw governance is heavy. Check first:
    let delayExc = null;
    await api("funder", "POST", "/api/exceptions/evaluate");
    delayExc = q1("SELECT * FROM exceptions WHERE source_key LIKE 'approval-delay:%'");
    if (!delayExc) {
      // No pending approval in seed — make one: submit good M3 evidence (VERIFIED -> approval request), backdate it.
      const ok = await api("field", "POST", "/api/evidence", {
        milestoneId: "ms-3",
        demoPhotoId: m3ctx.demoPhotos[1].id,
        latitude: ctx.projects[0].simulatedGps.latitude,
        longitude: ctx.projects[0].simulatedGps.longitude,
        capturedAt: new Date(Date.now() - 30 * 60000).toISOString(),
        deviceMetadata: { userAgent: "exc-test", platform: "test", screen: "1x1", language: "en" },
        isDemoFallback: true,
      });
      const okBody = await ok.json();
      assert(okBody.approvalRequest, "   fresh verified evidence opened a pending approval request");
      exec("UPDATE approval_requests SET created_at = ? WHERE id = ?",
        new Date(Date.now() - 60 * 3600_000).toISOString(), okBody.approvalRequest.id);
      await api("funder", "POST", "/api/exceptions/evaluate");
      delayExc = q1("SELECT * FROM exceptions WHERE source_key LIKE 'approval-delay:%'");
    }
    assert(
      delayExc && delayExc.severity === "MEDIUM" && delayExc.category === "APPROVAL",
      "3. approval pending beyond the configured threshold produced a MEDIUM approval exception"
    );

    // ---------- 6. source link works ----------
    const docDetail = await (await page("funder", `/exception/${docExc.id}`)).text();
    assert(
      docDetail.includes(`/draw/${docExc.draw_request_id}?tab=documents`) &&
        docDetail.includes("remains authoritative"),
      "6. exception detail links to the authoritative source record (draw document checklist)"
    );

    // ---------- 16. SLA age states ----------
    const registerHtml = await (await page("funder", "/exceptions")).text();
    assert(registerHtml.includes("Within target"), "16a. fresh exceptions read Within target");
    exec("UPDATE exceptions SET opened_at = ?, due_at = ? WHERE id = ?",
      new Date(Date.now() - 5 * 86400_000).toISOString(),
      new Date(Date.now() - 3 * 86400_000).toISOString(),
      issueExc.id);
    const registerHtml2 = await (await page("funder", "/exceptions?overdue=1")).text();
    assert(
      registerHtml2.includes("Overdue") && registerHtml2.includes(issueExc.title),
      "16b. backdated exception reads Overdue and the overdue filter finds it"
    );

    // ---------- 14. intelligence links to exception detail ----------
    const insights = await (await page("funder", "/insights")).text();
    assert(
      insights.includes(`/exception/${issueExc.id}`),
      "14. OBV Intelligence links its overdue-exception signal to the exception detail"
    );

    // ---------- 13. map link through source layer ----------
    const issueDetail = await (await page("funder", `/exception/${issueExc.id}`)).text();
    assert(
      issueDetail.includes("View on map") && issueDetail.includes("/map"),
      "13. exception with a source location links to the map (through the source layer)"
    );

    // ---------- 15. communications reference; chat cannot resolve ----------
    const ref = await api("funder", "POST", `/api/exceptions/${issueExc.id}/reference`);
    assert(ref.status === 200, "15a. exception can be referenced into the project discussion");
    const refMsg = q1(
      "SELECT * FROM messages WHERE message_type = 'EXCEPTION_REFERENCE' AND ref_id = ?",
      issueExc.id
    );
    assert(Boolean(refMsg), "15b. EXCEPTION_REFERENCE message exists in the thread");
    await fetch(BASE + `/api/threads/${refMsg.thread_id}/messages`, {
      method: "POST",
      headers: { cookie: jars.funder, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body: "This exception is resolved, close it out." }).toString(),
      redirect: "manual",
    });
    assert(
      q1("SELECT status FROM exceptions WHERE id = ?", issueExc.id).status === "OPEN",
      "15c. a chat message saying it's resolved changes nothing — formal action required"
    );

    // ---------- 10. resolution respects source state ----------
    const blocked = await api("pm", "POST", `/api/exceptions/${issueExc.id}/resolve`, { summary: "done" });
    assert(
      blocked.status === 409,
      "10. Resolve is refused while the source field issue is still open (source stays authoritative)"
    );

    // ---------- 11. source resolution updates exception ----------
    await fetch(BASE + "/api/issues/issue-1/status", {
      method: "POST",
      headers: { cookie: jars.pm, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status: "RESOLVED", resolutionSummary: "Alternate supplier delivered" }).toString(),
      redirect: "manual",
    });
    await api("funder", "POST", "/api/exceptions/evaluate");
    const issueExcAfter = q1("SELECT * FROM exceptions WHERE id = ?", issueExc.id);
    assert(
      issueExcAfter.status === "RESOLVED" && issueExcAfter.resolution_type === "SOURCE_CLEARED",
      "11a. resolving the source field issue auto-resolved the exception (SOURCE_CLEARED)"
    );
    const timeline = q("SELECT type FROM exception_events WHERE exception_id = ? ORDER BY created_at", issueExc.id).map((e) => e.type);
    assert(
      timeline.includes("SOURCE_UPDATED") && timeline.includes("RESOLVED"),
      "11b. the exception timeline records SOURCE_UPDATED and RESOLVED"
    );
    // document exception clears when the required document is recorded
    await api("pm", "POST", `/api/draws/${docExc.draw_request_id}/documents`, {
      requirementId: docExc.source_id,
      title: "Conditional lien waiver — June",
    });
    await api("funder", "POST", "/api/exceptions/evaluate");
    assert(
      q1("SELECT status FROM exceptions WHERE id = ?", docExc.id).status === "RESOLVED",
      "11c. recording the required document auto-resolved the document exception"
    );

    // ---------- exception workflow actions ----------
    // The rejected-evidence exception auto-resolved when newer verified
    // evidence superseded it (source truth) — use the still-open
    // approval-delay exception for the workflow transitions.
    assert(
      q1("SELECT status, resolution_type FROM exceptions WHERE id = ?", rejExcId).resolution_type === "SOURCE_CLEARED",
      "   superseded rejected-evidence exception auto-resolved (source cleared honestly)"
    );
    const workId = delayExc.id;
    const ack = await api("pm", "POST", `/api/exceptions/${workId}/acknowledge`);
    assert(ack.status === 200, "acknowledge works for project roles");
    const assign = await api("pm", "POST", `/api/exceptions/${workId}/assign`, { ownerUserId: "user-funder" });
    assert(assign.status === 200, "assign records an owner");
    const start = await api("pm", "POST", `/api/exceptions/${workId}/start`);
    assert(start.status === 200, "start work moves the exception to IN_PROGRESS");
    const rr = await api("pm", "POST", `/api/exceptions/${workId}/request-response`, { note: "Chase the outstanding approval role" });
    assert(rr.status === 200 && q1("SELECT status FROM exceptions WHERE id=?", workId).status === "AWAITING_RESPONSE",
      "request-response moves the exception to AWAITING_RESPONSE");

    // ---------- 12. tenant isolation ----------
    {
      const d = db();
      d.exec(`INSERT INTO organizations (id, name, kind) VALUES ('org-x','Unrelated Org','LENDER')`);
      d.exec(`INSERT INTO users (id, organization_id, name, role, title)
              VALUES ('user-x','org-x','Xeno','COMPLIANCE_REVIEWER','Reviewer')`);
      d.close();
    }
    await signIn("tenantx", "user-x");
    const xDetail = await page("tenantx", `/exception/${workId}`);
    const xAct = await api("tenantx", "POST", `/api/exceptions/${workId}/acknowledge`);
    const xRegister = await (await page("tenantx", "/exceptions")).text();
    assert(
      xDetail.status === 404 && xAct.status === 404 && !xRegister.includes("Approval pending"),
      "12. unrelated tenant cannot see or act on exceptions (detail, API, register)"
    );

    // ---------- 9. no exception action released funds ----------
    const after = financial();
    assert(
      after.rel === before.rel && after.drawEv === before.drawEv && after.recs === before.recs,
      "9. the whole exception lifecycle moved no money and recorded no approvals"
    );
    const banned = /fraud|misuse|misappropri|theft|embezzl/i;
    const excPages = registerHtml2 + issueDetail + docDetail;
    assert(!banned.test(excPages), "   exception surfaces make no misconduct claims");

    console.log(`\nUNIFIED EXCEPTION TESTS PASSED — ${n} checkpoints.\n`);
  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
