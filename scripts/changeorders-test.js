/**
 * Change Order + Retainage tests — the 18 required cases.
 *
 *   node scripts/changeorders-test.js   (HTTP + direct DB assertions)
 *
 * Doctrine under test: a submitted change order changes nothing; only
 * formal approval applies impact (once, audited, snapshotted, versioned);
 * historic evidence keeps its config reference; retainage is computed
 * transparently, withheld inside the governed draw release, and released
 * only through its own condition-gated approval — exactly once.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3184;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-co-"));

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
  console.log("Change Order + Retainage tests — isolated server on :" + PORT);
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

    // ---------- 1. create draft CO ----------
    const created = await api("pm", "POST", "/api/change-orders", {
      projectId: "proj-r47",
      title: "Additional culvert at km 9+200",
      description: "Unrecorded stream crossing discovered during base course works.",
      reasonCategory: "SITE_CONDITION",
      requestedAmount: 120000,
      scheduleImpactDays: 14,
      affectedMilestoneIds: ["ms-3"],
    });
    assert(created.status === 201, "1. PM creates a draft change order");
    const co = (await created.json()).changeOrder;
    assert(co.status === "DRAFT" && co.changeOrderNumber === 2, "   the new change order numbers after the seeded CO-1 (CO-2, DRAFT)");

    // budgets before anything is approved
    const budgetBefore = q1("SELECT SUM(original_budget + approved_changes) AS b FROM budget_lines WHERE project_id='proj-r47' AND active=1").b;
    const line3Before = q1("SELECT approved_changes FROM budget_lines WHERE id='bl-3'").approved_changes;
    const cfgBefore = q1("SELECT config_version v FROM projects WHERE id='proj-r47'").v;

    // ---------- 2. submit CO (requires reconciled allocations) ----------
    const badSubmit = await api("pm", "POST", `/api/change-orders/${co.id}/submit`);
    assert(badSubmit.status === 422, "2a. submission is blocked until allocations reconcile");
    const alloc = await api("pm", "POST", `/api/change-orders/${co.id}/allocations`, {
      budgetLineId: "bl-3", amount: 120000, note: "Culvert supply + install",
    });
    assert(alloc.status === 200, "   allocation added to budget line 02-610");
    const submit = await api("pm", "POST", `/api/change-orders/${co.id}/submit`);
    assert(submit.status === 200 && (await submit.json()).changeOrder.status === "SUBMITTED", "2b. reconciled CO submits");

    // ---------- 3. unapproved CO cannot alter budget ----------
    const budgetAfterSubmit = q1("SELECT SUM(original_budget + approved_changes) AS b FROM budget_lines WHERE project_id='proj-r47' AND active=1").b;
    assert(
      budgetAfterSubmit === budgetBefore &&
        q1("SELECT approved_changes FROM budget_lines WHERE id='bl-3'").approved_changes === line3Before,
      "3. a submitted (unapproved) change order alters no budget figures"
    );
    // impact preview is preview-only
    const preview = await (await api("funder", "GET", `/api/change-orders/${co.id}/preview`)).json();
    assert(
      preview.preview === true &&
        preview.projectedRevisedBudget === budgetBefore + 120000 &&
        q1("SELECT SUM(original_budget + approved_changes) AS b FROM budget_lines WHERE project_id='proj-r47' AND active=1").b === budgetBefore,
      "   impact preview projects the revised budget without changing anything"
    );

    // ---------- 4. unapproved CO cost in draw -> exception/signal ----------
    // draw-1 is UNDER_REVIEW (not editable) -> create a fresh draft draw for the CO line
    const d2 = (await (await api("pm", "POST", "/api/draws", {
      projectId: "proj-r47", requestedAmount: 40000, periodStart: "2026-07-01", periodEnd: "2026-07-31",
    })).json()).draw;
    const silentLine = await api("pm", "POST", `/api/draws/${d2.id}/lines`, {
      description: "Culvert works (CO-2)", changeOrderId: co.id, scheduledValue: 120000, currentRequested: 40000,
    });
    assert(silentLine.status === 422, "4a. billing against an unapproved CO without acknowledgement is refused");
    const ackLine = await api("pm", "POST", `/api/draws/${d2.id}/lines`, {
      description: "Culvert works (CO-2)", changeOrderId: co.id,
      scheduledValue: 120000, currentRequested: 40000, exceptionAcknowledged: true,
    });
    assert(ackLine.status === 201, "4b. explicit exception acknowledgement allows the line, held for review");
    await api("pm", "POST", `/api/draws/${d2.id}/submit`);
    await api("funder", "POST", "/api/exceptions/evaluate");
    const excRow = q1("SELECT * FROM exceptions WHERE source_key LIKE 'draw-unapproved-co:%'");
    assert(Boolean(excRow), "4c. deterministic exception created: unapproved change cost included in draw");
    const insights = await (await page("funder", "/insights")).text();
    assert(insights.includes("UNAPPROVED CHANGE COST INCLUDED IN DRAW"), "4d. intelligence signal uses the exact deterministic label");

    // ---------- 5-7. approve through required roles; budget updates once ----------
    const gov = await api("funder", "POST", `/api/change-orders/${co.id}/governance`, {});
    assert(gov.status === 200, "5a. reviewer opens formal governance");
    const apId = (await gov.json()).approvalRequest.id;
    const selfApprove = await api("pm", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    assert(selfApprove.status === 403, "5b. the submitter cannot approve their own change order (separation of duties)");
    const first = await api("funder", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    assert(first.status === 200, "5c. first required role approves");
    assert(
      q1("SELECT status FROM change_orders WHERE id = ?", co.id).status === "UNDER_REVIEW" &&
        q1("SELECT approved_changes FROM budget_lines WHERE id='bl-3'").approved_changes === line3Before,
      "5d. one approval of two changes nothing (configuration untouched)"
    );
    const second = await api("compliance", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    assert(second.status === 200 && (await second.json()).applied === true, "5e. final required role approves — CO applied");
    const coAfter = q1("SELECT * FROM change_orders WHERE id = ?", co.id);
    const line3After = q1("SELECT approved_changes FROM budget_lines WHERE id='bl-3'").approved_changes;
    assert(
      coAfter.status === "APPROVED" && line3After === line3Before + 120000,
      "6a. approved CO updates the budget line's approvedChanges by exactly the approved amount"
    );
    const progress = await (await api("funder", "GET", "/api/projects/proj-r47/progress")).json();
    assert(
      progress.financial.budgetBasis === budgetBefore + 120000 && progress.financial.approvedChanges === 120000,
      "6b. current project budget recalculates by derivation (original + approved changes)"
    );
    const dup = await api("funder", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    assert(
      dup.status === 409 && q1("SELECT approved_changes FROM budget_lines WHERE id='bl-3'").approved_changes === line3After,
      "6c. duplicate approval cannot apply the change twice"
    );
    const cfgAfter = q1("SELECT config_version v FROM projects WHERE id='proj-r47'").v;
    const snapshot = q1("SELECT version, reason FROM config_snapshots WHERE project_id='proj-r47' ORDER BY version DESC LIMIT 1");
    assert(
      cfgAfter === cfgBefore + 1 &&
        coAfter.applied_snapshot_version === snapshot.version &&
        snapshot.reason.includes("CO-2"),
      "7. configuration version increments and the new snapshot is linked to the change order"
    );
    const coAudit = q1("SELECT * FROM config_audit WHERE action='CHANGE_ORDER_APPLIED' AND entity_id = ?", co.id);
    assert(Boolean(coAudit), "   apply is written to the configuration audit trail");

    // ---------- 8. historic evidence keeps old policy/config reference ----------
    const historicVerifications = q("SELECT policy_version FROM verifications");
    assert(
      historicVerifications.every((v) => v.policy_version === null || v.policy_version < cfgAfter),
      "8. historic verifications keep their original policy/config reference (never rewritten)"
    );

    // ---------- 9. schedule impact updates approved dates ----------
    // seeded ms-3 has no plannedEnd; set one on a fresh CO to prove the shift.
    {
      const d = db();
      d.prepare("UPDATE milestones SET planned_end = '2026-09-30' WHERE id = 'ms-4'").run();
      d.close();
    }
    // pm submits (submitter cannot approve); funder + compliance are the matrix roles
    const co2 = (await (await api("pm", "POST", "/api/change-orders", {
      projectId: "proj-r47", title: "Bridge deck redesign", reasonCategory: "DESIGN_CHANGE",
      requestedAmount: 0, scheduleImpactDays: 10, affectedMilestoneIds: ["ms-4"],
    })).json()).changeOrder;
    const submit2 = await api("pm", "POST", `/api/change-orders/${co2.id}/submit`);
    assert(submit2.status === 200, "   zero-cost schedule CO submits (nothing to reconcile)");
    const gov2 = await api("compliance", "POST", `/api/change-orders/${co2.id}/governance`, {});
    const apId2 = (await gov2.json()).approvalRequest.id;
    const s9a = await api("funder", "POST", `/api/approvals/${apId2}/decision`, { decision: "APPROVED" });
    const s9b = await api("compliance", "POST", `/api/approvals/${apId2}/decision`, { decision: "APPROVED" });
    assert(s9a.status === 200 && s9b.status === 200, "   both matrix roles approve the schedule CO");
    const ms4 = q1("SELECT planned_end FROM milestones WHERE id='ms-4'");
    assert(ms4.planned_end === "2026-10-10", "9. approved schedule impact shifts the affected milestone's planned end (+10d)");

    // ---------- 10-12. retainage calculation + held ----------
    // draw-1 is seeded UNDER_REVIEW with lines reviewed except doc; finish its review path:
    // record the missing lien waiver, resolve the HIGH issue, review remaining doc state.
    const reqRow = q1("SELECT id FROM draw_document_requirements WHERE draw_request_id='draw-1' AND doc_type='CONDITIONAL_LIEN_WAIVER'");
    await api("pm", "POST", "/api/draws/draw-1/documents", { requirementId: reqRow.id, title: "Conditional lien waiver — June" });
    await fetch(BASE + "/api/issues/issue-1/status", {
      method: "POST",
      headers: { cookie: jars.pm, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status: "RESOLVED", resolutionSummary: "Alternate supplier delivered" }).toString(),
      redirect: "manual",
    });
    const govDraw = await api("compliance", "POST", "/api/draws/draw-1/governance", {});
    assert(govDraw.status === 200, "   draw-1 reaches governance");
    const drawRow = q1("SELECT recommended_amount, retainage_rate, retainage_withheld FROM draw_requests WHERE id='draw-1'");
    const gross = drawRow.recommended_amount;
    assert(
      drawRow.retainage_rate === 10 && drawRow.retainage_withheld === Math.round(gross * 0.1),
      `10. retainage computed transparently at finalize: ${gross} gross × 10% = ${drawRow.retainage_withheld}`
    );
    const drawApId = q1("SELECT id FROM approval_requests WHERE draw_request_id='draw-1'").id;
    await api("funder", "POST", `/api/approvals/${drawApId}/decision`, { decision: "APPROVED" });
    const heldMid = q("SELECT * FROM retainage_events WHERE project_id='proj-r47'");
    assert(heldMid.length === 0, "   first draw approval records no retainage event (funds untouched)");
    await api("compliance", "POST", `/api/approvals/${drawApId}/decision`, { decision: "APPROVED" });
    const releaseEvent = q1("SELECT amount FROM draw_account_events WHERE draw_request_id='draw-1' AND type='RELEASED'");
    const withheldEvent = q1("SELECT amount FROM retainage_events WHERE draw_request_id='draw-1' AND type='WITHHELD'");
    assert(
      releaseEvent.amount === gross - drawRow.retainage_withheld && withheldEvent.amount === drawRow.retainage_withheld,
      `11. governed release is NET (${releaseEvent.amount}) with retainage withheld inside the same transition`
    );
    const budgetHtml = await (await page("funder", "/project/proj-r47/budget")).text();
    assert(
      q1("SELECT COUNT(*) c FROM retainage_events WHERE type='RELEASED'").c === 0 &&
        budgetHtml.includes("Total retainage held"),
      "12. retainage remains held (dashboard shows the position; nothing auto-released)"
    );

    // ---------- 13. release request requires conditions ----------
    const rel = (await (await api("funder", "POST", "/api/retainage/releases", {
      projectId: "proj-r47",
    })).json()).release;
    assert(rel.amount === drawRow.retainage_withheld, "13a. release request defaults to retainage remaining");
    const early = await api("funder", "POST", `/api/retainage/releases/${rel.id}/governance`);
    assert(early.status === 422, "13b. governance is blocked while required conditions are outstanding");
    await api("compliance", "POST", `/api/retainage/releases/${rel.id}/condition`, {
      condition: "FINAL_LIEN_WAIVER", note: "Final lien waiver on file (doc #FLW-9)",
    });
    await api("compliance", "POST", `/api/retainage/releases/${rel.id}/condition`, {
      condition: "CERTIFICATE_OF_COMPLETION", note: "Engineer's certificate recorded",
    });
    // ALL_EXCEPTIONS_RESOLVED computed live: resolve the CO-billing exception source by approving CO-1 earlier;
    // sweep to reconcile any remaining open exceptions.
    await api("funder", "POST", "/api/exceptions/evaluate");
    const openExc = q1("SELECT COUNT(*) c FROM exceptions WHERE status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','AWAITING_RESPONSE')").c;
    if (openExc > 0) {
      // waive any stragglers with the authorized role so the computed condition can pass
      for (const e of q("SELECT id FROM exceptions WHERE status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','AWAITING_RESPONSE')")) {
        await api("compliance", "POST", `/api/exceptions/${e.id}/waive`, { reason: "Closed out for retainage release test" });
      }
    }
    const toGov = await api("funder", "POST", `/api/retainage/releases/${rel.id}/governance`);
    assert(toGov.status === 200, "13c. with all conditions satisfied the release opens formal governance");
    const relApId = (await toGov.json()).approvalRequest.id;

    // ---------- 14-16. retainage governance: held, exactly once ----------
    const relSelf = await api("funder", "POST", `/api/approvals/${relApId}/decision`, { decision: "APPROVED" });
    assert(relSelf.status === 403, "   the release requester cannot approve their own request");
    // funder requested -> compliance + ... matrix requires FUNDER_REP too. Requester block means we need
    // a different FUNDER_REP? Only one exists — so re-create request from compliance instead.
    await api("compliance", "POST", `/api/retainage/releases/${rel.id}/condition`, { condition: "FINAL_LIEN_WAIVER", note: "x" }).catch(() => {});
    // cancel path not needed: create a new release request from compliance? Amount remaining still withheld.
    // Simplest: mark original request RETURNED via rejection is heavy; instead verify with roles:
    const firstRel = await api("compliance", "POST", `/api/approvals/${relApId}/decision`, { decision: "APPROVED" });
    assert(
      firstRel.status === 200 &&
        q1("SELECT COUNT(*) c FROM retainage_events WHERE type='RELEASED'").c === 0,
      "14. first retainage approval releases nothing (retainage still held)"
    );
    // FUNDER_REP required but the only funder rep is the requester -> use PM? PM not in matrix.
    // Reassign requester check: requestedBy user-funder blocks funder. To complete the matrix we
    // demonstrate with a second funder-side identity added to the tenant.
    {
      const d = db();
      d.exec(`INSERT INTO users (id, organization_id, name, role, title)
              VALUES ('user-funder2','org-cdfc','Kwame Mensah','FUNDER_REP','Senior Funder Representative')`);
      d.close();
    }
    await signIn("funder2", "user-funder2");
    const finalRel = await api("funder2", "POST", `/api/approvals/${relApId}/decision`, { decision: "APPROVED" });
    const relBody = await finalRel.json();
    assert(
      finalRel.status === 200 && relBody.released === true &&
        q1("SELECT status FROM retainage_release_requests WHERE id = ?", rel.id).status === "RELEASED",
      "15a. final required approval releases the retainage state exactly once"
    );
    const relEvents = q("SELECT * FROM retainage_events WHERE retainage_release_id = ?", rel.id);
    assert(relEvents.length === 1 && relEvents[0].amount === rel.amount, "15b. exactly one RELEASED retainage event, matching the request");
    const dupRel = await api("compliance", "POST", `/api/approvals/${relApId}/decision`, { decision: "APPROVED" });
    assert(
      dupRel.status === 409 && q("SELECT * FROM retainage_events WHERE retainage_release_id = ?", rel.id).length === 1,
      "16. duplicate approval cannot duplicate the retainage release"
    );

    // ---------- 17. tenant isolation ----------
    {
      const d = db();
      d.exec(`INSERT INTO organizations (id, name, kind) VALUES ('org-x','Unrelated Org','LENDER')`);
      d.exec(`INSERT INTO users (id, organization_id, name, role, title)
              VALUES ('user-x','org-x','Xeno','FUNDER_REP','Reviewer')`);
      d.close();
    }
    await signIn("tenantx", "user-x");
    const xDetail = await page("tenantx", `/change-order/${co.id}`);
    const xCreate = await api("tenantx", "POST", "/api/retainage/releases", { projectId: "proj-r47" });
    const xRegister = await (await page("tenantx", "/change-orders")).text();
    assert(
      xDetail.status === 404 && xCreate.status === 404 && !xRegister.includes("culvert"),
      "17. unrelated tenant cannot see or act on change orders / retainage (detail, API, register)"
    );

    // ---------- 18. report totals match data ----------
    const report = await (await page("funder", "/draw/draw-1/report")).text();
    const fmt = (v) => "$" + Number(v).toLocaleString("en-US");
    const contract = q1("SELECT SUM(original_budget) AS o, SUM(approved_changes) AS c FROM budget_lines WHERE project_id='proj-r47' AND active=1");
    assert(
      report.includes(fmt(contract.o)) &&
        report.includes(fmt(contract.o + contract.c)) &&
        report.includes(fmt(drawRow.retainage_withheld)) &&
        report.includes(fmt(gross - drawRow.retainage_withheld)),
      "18. draw report shows original/current contract value, retainage withheld and net release matching the database"
    );

    console.log(`\nCHANGE ORDER + RETAINAGE TESTS PASSED — ${n} checkpoints.\n`);
  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
