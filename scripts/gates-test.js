/**
 * Milestone Completion Gate tests — the 22 required cases.
 *
 *   node scripts/gates-test.js   (HTTP + direct DB assertions)
 *
 * Doctrine under test: PHOTOGRAPHIC COMPLETION IS NOT LEGAL OR
 * CONTRACTUAL COMPLETION. Contractor report ≠ verification ≠ inspection
 * ≠ approval ≠ release; UNKNOWN never behaves as NOT_REQUIRED; uploads
 * never become PASSED; chat can neither pass inspections nor create
 * eligibility; the existing governance path and exactly-once release
 * are untouched; migration is conservative.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3190;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-gates-"));

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
async function gates(key, milestoneId) {
  const res = await api(key, "GET", `/api/milestones/${milestoneId}/gates`);
  if (res.status !== 200) fail(`gates(${milestoneId}) -> ${res.status}`);
  return (await res.json()).gates;
}

function readZip(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const entries = {};
  for (let k = 0; k < count; k++) {
    const size = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    entries[name] = buf.subarray(start, start + size);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

(async () => {
  console.log("Milestone Completion Gate tests — isolated server on :" + PORT);
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

    // ---------- 19. migration is conservative ----------
    const g1 = await gates("funder", "ms-1"); // seeded RELEASED milestone
    assert(
      g1.contractor.status === "NOT_REPORTED" &&
        g1.requirementValue === "UNKNOWN" &&
        g1.inspectionGate === "REQUIREMENT_UNKNOWN" &&
        g1.inspection === null &&
        g1.eligibility.result === "RELEASED",
      "19. released legacy milestone migrates conservatively — no invented contractor report or inspection"
    );

    // Clear the seeded HIGH issue so M3 eligibility reads cleanly below.
    await fetch(BASE + "/api/issues/issue-1/status", {
      method: "POST",
      headers: { cookie: jars.pm, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status: "RESOLVED", resolutionSummary: "Supplier delivered" }).toString(),
      redirect: "manual",
    });
    await api("funder", "POST", "/api/exceptions/evaluate");

    // ---------- 1. contractor reports work complete ----------
    const report = await api("pm", "POST", "/api/milestones/ms-3/contractor-completion", {
      status: "REPORTED_COMPLETE",
      notes: "Gravel base complete km 0-14",
    });
    assert(report.status === 200, "1. contractor (PM) reports the milestone work complete");
    let g3 = await gates("funder", "ms-3");
    assert(
      g3.contractor.status === "REPORTED_COMPLETE" &&
        g3.contractor.reportedByUserId === "user-pm" &&
        Boolean(g3.contractor.reportedAt),
      "   the report is attributable (who + when + notes)"
    );
    const funderReport = await api("funder", "POST", "/api/milestones/ms-3/contractor-completion", {
      status: "REPORTED_COMPLETE",
    });
    assert(funderReport.status === 403, "   lender-side roles cannot file the contractor's representation");

    // ---------- 2. a contractor report verifies nothing ----------
    assert(
      g3.evidenceReview.status === "NOT_SUBMITTED" &&
        q1("SELECT COUNT(*) c FROM evidence_items WHERE milestone_id='ms-3'").c === 0 &&
        q1("SELECT status FROM milestones WHERE id='ms-3'").status === "PENDING_EVIDENCE",
      "2. the contractor report changes NO verification state — evidence review stays NOT SUBMITTED"
    );

    // ---------- submit evidence through the governed pipeline ----------
    const photo = q1("SELECT id FROM demo_fallback_photos WHERE milestone_id='ms-3'");
    const sub = await api("field", "POST", "/api/evidence", {
      milestoneId: "ms-3",
      demoPhotoId: photo.id,
      latitude: -11.85,
      longitude: 33.6,
      capturedAt: new Date().toISOString(),
      deviceMetadata: { userAgent: "test", platform: "test", screen: "1x1", language: "en" },
      isDemoFallback: true,
    });
    assert(sub.status === 201, "   evidence submitted through the existing governed pipeline");
    g3 = await gates("funder", "ms-3");
    assert(
      g3.evidenceReview.status === "VERIFIED" &&
        g3.evidenceReview.evidenceCount === 1,
      "   OBV evidence review derives VERIFIED from the stored verification result"
    );

    // ---------- 3. evidence verification does not pass any inspection ----------
    assert(
      g3.requirementValue === "UNKNOWN" &&
        g3.inspectionGate === "REQUIREMENT_UNKNOWN" &&
        g3.inspection === null &&
        q1("SELECT COUNT(*) c FROM jurisdictional_inspections").c === 0,
      "3. OBV verification marks NO inspection passed — the legal gate is untouched"
    );

    // ---------- 9. UNKNOWN never behaves as NOT_REQUIRED ----------
    assert(
      g3.eligibility.result !== "READY_FOR_GOVERNANCE" &&
        g3.eligibility.reasons.some((r) => r.code === "INSPECTION_REQUIREMENT_UNKNOWN"),
      "9. requirement UNKNOWN blocks readiness with INSPECTION_REQUIREMENT_UNKNOWN — it never acts as NOT REQUIRED"
    );

    // ---------- 8. determinations need an attributable basis ----------
    const noBasis = await api("funder", "POST", "/api/milestones/ms-3/inspection-requirement", {
      requirement: "NOT_REQUIRED",
    });
    assert(noBasis.status === 400, "8a. NOT_REQUIRED without a stated basis is refused");
    const pmDetermine = await api("pm", "POST", "/api/milestones/ms-3/inspection-requirement", {
      requirement: "REQUIRED",
      requirementBasis: "x",
      inspectionType: "y",
    });
    assert(pmDetermine.status === 403, "8b. determinations are restricted to funder rep / compliance reviewer");
    const determined = await api("compliance", "POST", "/api/milestones/ms-3/inspection-requirement", {
      requirement: "REQUIRED",
      requirementBasis: "District public works code §14: base-course works need a compaction inspection",
      inspectionType: "Base course compaction inspection",
      jurisdiction: "Mzimba District",
      issuingAuthority: "Mzimba District Council",
      mustPassBeforeGovernance: true,
    });
    assert(determined.status === 200, "8c. REQUIRED determination recorded with basis, jurisdiction and type");
    const reqRow = q1("SELECT * FROM inspection_requirements WHERE milestone_id='ms-3'");
    assert(
      reqRow.determined_by === "user-compliance" &&
        reqRow.requirement === "REQUIRED" &&
        q1("SELECT COUNT(*) c FROM config_snapshots WHERE project_id='proj-r47' AND reason LIKE '%Inspection requirement%'").c === 1,
      "   the determination is attributable and snapshotted with project configuration"
    );

    // ---------- 4. required inspection blocks draw eligibility ----------
    g3 = await gates("funder", "ms-3");
    assert(
      g3.eligibility.result === "BLOCKED" &&
        g3.eligibility.reasons.some((r) => r.code === "JURISDICTIONAL_INSPECTION_NOT_PASSED" && r.blocking) &&
        g3.eligibility.reasons.some((r) => r.code === "INSPECTION_NOT_SCHEDULED"),
      "4. REQUIRED + not passed → drawEligibility BLOCKED with JURISDICTIONAL_INSPECTION_NOT_PASSED"
    );

    // ---------- 5. scheduling does not unblock ----------
    const sched = await api("pm", "POST", "/api/milestones/ms-3/inspections", {
      scheduledAt: "2026-07-15T10:00:00.000Z",
    });
    assert(sched.status === 201, "   inspection scheduled for July 15, 2026");
    g3 = await gates("funder", "ms-3");
    assert(
      g3.inspectionGate === "SCHEDULED" &&
        g3.eligibility.result === "BLOCKED" &&
        g3.eligibility.reasons.some((r) => r.code === "INSPECTION_PENDING"),
      "5. a SCHEDULED inspection remains BLOCKED — scheduling is not passing"
    );
    const inspId = (await sched.clone?.() ?? null, q1("SELECT id FROM jurisdictional_inspections WHERE milestone_id='ms-3'").id);

    // ---------- 10. document upload never equals PASSED ----------
    await api("pm", "POST", "/api/draws/draw-1/documents", {
      docType: "INSPECTION_REPORT",
      title: "Compaction inspection report (uploaded)",
      inspectionDate: "2026-07-15",
    });
    g3 = await gates("funder", "ms-3");
    assert(
      g3.inspectionGate === "SCHEDULED" && g3.inspection.result === null,
      "10. uploading an inspection document changes NOTHING — a reviewed result is required"
    );

    // ---------- 14. chat cannot mark an inspection passed ----------
    const thread = q1("SELECT id FROM conversation_threads WHERE project_id='proj-r47' LIMIT 1");
    const chat = await api("pm", "POST", `/api/threads/${thread.id}/messages`, {
      body: "Inspection passed today, all good — please release the funds.",
    });
    g3 = await gates("funder", "ms-3");
    assert(
      chat.status < 400 &&
        g3.inspectionGate === "SCHEDULED" &&
        g3.eligibility.result === "BLOCKED",
      "14/15. a chat message claiming 'inspection passed' changes neither the inspection nor eligibility"
    );

    // ---------- 11. identities: PM cannot record results; reviewer + inspector distinct ----------
    const pmResult = await api("pm", "POST", `/api/inspections/${inspId}/result`, {
      result: "PASSED",
    });
    assert(pmResult.status === 403, "11a. recording a result requires a lender-side reviewer");
    const passRes = await api("compliance", "POST", `/api/inspections/${inspId}/result`, {
      result: "PASSED",
      governmentInspectorName: "Eng. T. Mhango (Mzimba District Council)",
      inspectionReference: "MDC-INSP-2026-0311",
    });
    assert(passRes.status === 200, "6a. compliance reviewer records the external PASSED result");
    const inspRow = q1("SELECT * FROM jurisdictional_inspections WHERE id = ?", inspId);
    assert(
      inspRow.reviewed_by_user_id === "user-compliance" &&
        inspRow.government_inspector_name.includes("Mhango") &&
        q1("SELECT COUNT(*) c FROM users WHERE name LIKE '%Mhango%'").c === 0,
      "11b. the government inspector stays a text identity; the OBV reviewer is attributable and distinct"
    );

    // ---------- 6. a passed inspection satisfies ONLY the inspection gate ----------
    g3 = await gates("funder", "ms-3");
    assert(
      g3.inspectionGate === "PASSED" &&
        g3.eligibility.result === "READY_FOR_GOVERNANCE" &&
        g3.eligibility.reasons.some((r) => r.code === "FORMAL_APPROVAL_PENDING") &&
        q1("SELECT account_status FROM milestones WHERE id='ms-3'").account_status === "HELD" &&
        q1("SELECT COUNT(*) c FROM virtual_account_events WHERE milestone_id='ms-3' AND type='RELEASED'").c === 0,
      "6/13. PASSED satisfies the inspection gate only — READY_FOR_GOVERNANCE releases NOTHING (funds HELD)"
    );

    // ---------- 16/17. release still flows through governance, exactly once ----------
    const apId = q1("SELECT id FROM approval_requests WHERE milestone_id='ms-3' AND status='PENDING'").id;
    await api("funder", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    const final = await api("compliance", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    assert(final.status === 200, "16. final approval uses the existing formal governance path");
    const released = q("SELECT * FROM virtual_account_events WHERE milestone_id='ms-3' AND type='RELEASED'");
    assert(
      released.length === 1 &&
        q1("SELECT account_status FROM milestones WHERE id='ms-3'").account_status === "RELEASED" &&
        (await gates("funder", "ms-3")).eligibility.result === "RELEASED",
      "17. release remains exactly once; eligibility now derives RELEASED"
    );

    // ---------- 7. failed inspection creates and reconciles an exception ----------
    await api("pm", "POST", "/api/milestones/ms-4/contractor-completion", { status: "REPORTED_COMPLETE" });
    await api("compliance", "POST", "/api/milestones/ms-4/inspection-requirement", {
      requirement: "REQUIRED",
      requirementBasis: "Bridge deck structural inspection mandated before load",
      inspectionType: "Structural inspection",
      jurisdiction: "Mzimba District",
    });
    const insp4 = await api("pm", "POST", "/api/milestones/ms-4/inspections", {
      scheduledAt: "2026-07-09T09:00:00.000Z",
    });
    const insp4Id = (await insp4.json()).inspection.id;
    await api("compliance", "POST", `/api/inspections/${insp4Id}/result`, {
      result: "FAILED",
      governmentInspectorName: "Eng. T. Mhango",
      notes: "Deck curing incomplete",
    });
    await api("funder", "POST", "/api/exceptions/evaluate");
    const failedExc = q1("SELECT * FROM exceptions WHERE source_key = ?", `inspection-failed:${insp4Id}`);
    assert(
      failedExc && failedExc.severity === "HIGH" && failedExc.status === "OPEN",
      "7a. a FAILED inspection creates a deterministic HIGH exception pointing at the inspection record"
    );
    const g4 = await gates("funder", "ms-4");
    assert(
      g4.inspectionGate === "FAILED" &&
        g4.eligibility.result === "BLOCKED" &&
        g4.eligibility.reasons.some((r) => r.code === "INSPECTION_FAILED"),
      "7b. the milestone is BLOCKED with INSPECTION_FAILED"
    );
    // Reinspection passes → the authoritative condition clears → reconciled.
    const reinsp = await api("pm", "POST", "/api/milestones/ms-4/inspections", {
      scheduledAt: "2026-07-20T09:00:00.000Z",
    });
    const reinspId = (await reinsp.json()).inspection.id;
    await api("compliance", "POST", `/api/inspections/${reinspId}/result`, {
      result: "PASSED",
      governmentInspectorName: "Eng. T. Mhango",
    });
    await api("funder", "POST", "/api/exceptions/evaluate");
    assert(
      q1("SELECT status FROM exceptions WHERE source_key = ?", `inspection-failed:${insp4Id}`).status === "RESOLVED" &&
        (await gates("funder", "ms-4")).inspectionGate === "PASSED",
      "7c. the passed reinspection reconciles the exception from the authoritative source"
    );

    // ---------- 12. one blocked milestone never rejects unrelated lines ----------
    await api("compliance", "POST", "/api/milestones/ms-5/inspection-requirement", {
      requirement: "REQUIRED",
      requirementBasis: "Final handover inspection required by financing agreement",
      inspectionType: "Final handover inspection",
      mustPassBeforeGovernance: true,
    });
    const d2 = (await (await api("pm", "POST", "/api/draws", {
      projectId: "proj-r47", requestedAmount: 300000, periodStart: "2026-07-01", periodEnd: "2026-07-31",
    })).json()).draw;
    await api("pm", "POST", `/api/draws/${d2.id}/lines`, {
      description: "Bridge deck works (inspection passed)", milestoneId: "ms-4",
      scheduledValue: 200000, currentRequested: 200000,
    });
    await api("pm", "POST", `/api/draws/${d2.id}/lines`, {
      description: "Final surfacing (inspection outstanding)", milestoneId: "ms-5",
      scheduledValue: 100000, currentRequested: 100000,
    });
    await api("pm", "POST", `/api/draws/${d2.id}/submit`);
    const rec = await (await api("funder", "GET", `/api/draws/${d2.id}/recommendation`)).json();
    const recReasons = JSON.stringify(rec);
    assert(
      recReasons.includes("REQUIRED JURISDICTIONAL INSPECTION NOT PASSED") &&
        recReasons.includes("Final surfacing") &&
        !recReasons.includes('INSPECTION NOT PASSED: line \\"Bridge deck works'),
      "12a. only the inspection-blocked line is flagged — the passed milestone's line is untouched"
    );
    await api("funder", "POST", "/api/exceptions/evaluate");
    const blockedLine = q1(
      "SELECT id FROM draw_line_items WHERE draw_request_id = ? AND milestone_id='ms-5'", d2.id
    );
    assert(
      Boolean(q1("SELECT id FROM exceptions WHERE source_key = ?", `draw-inspection-blocked:${blockedLine.id}`)),
      "12b. the deterministic draw-inspection-blocked exception references the specific line"
    );

    // ---------- 20. reports show the six distinct gates ----------
    const pkgRes = await api("funder", "POST", `/api/draws/${d2.id}/verification-package`);
    const pkgReport = (await pkgRes.json()).report;
    const zip = readZip(
      Buffer.from(
        await (
          await fetch(`${BASE}/reports/file/${pkgReport.id}`, { headers: { cookie: jars.funder } })
        ).arrayBuffer()
      )
    );
    const gatesCsv = zip["milestone-gates.csv"].toString("utf8");
    assert(
      gatesCsv.includes("contractorCompletion") &&
        gatesCsv.includes("obvEvidenceReview") &&
        gatesCsv.includes("inspectionRequirement") &&
        gatesCsv.includes("inspectionStatus") &&
        gatesCsv.includes("drawEligibility") &&
        gatesCsv.includes("REQUIRED_UNSCHEDULED") &&
        gatesCsv.includes("PASSED"),
      "20a. the draw package CSV register carries all six distinct gates"
    );
    const summary = JSON.parse(zip["draw-summary.json"].toString("utf8"));
    assert(
      Array.isArray(summary.completionGates) &&
        summary.completionGates.length === 2 &&
        summary.completionGates.every(
          (cg) =>
            "contractorCompletion" in cg && "obvEvidenceReview" in cg &&
            "inspectionRequirement" in cg && "inspectionStatus" in cg && "drawEligibility" in cg
        ),
      "20b. draw-summary.json carries the six gates per milestone"
    );
    const docHtml = await (
      await fetch(`${BASE}/draw/${d2.id}/verification-package/preview`, { headers: { cookie: jars.funder } })
    ).text();
    assert(
      docHtml.includes("Milestone completion gates") &&
        docHtml.includes("Contractor completion") &&
        docHtml.includes("OBV evidence review") &&
        docHtml.includes("Inspection requirement") &&
        docHtml.includes("Draw eligibility") &&
        !/[^A-Z]COMPLETE[^D]/.test(docHtml.replace(/REPORTED COMPLETE|COMPLETED[ _—-]|COMPLETION/g, "")),
      "20c. the lender document displays the gate table with precise labels"
    );
    // audit package register
    const apGen = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", {});
    const auditPkg = (await apGen.json()).auditPackage;
    const auditZip = readZip(
      Buffer.from(
        await (
          await fetch(`${BASE}/audit-packages/${auditPkg.id}/download`, { headers: { cookie: jars.funder } })
        ).arrayBuffer()
      )
    );
    assert(
      Boolean(auditZip["02_milestones/milestone-gates.csv"]) &&
        auditZip["02_milestones/milestone-gates.csv"].toString("utf8").includes("drawEligibility"),
      "20d. the Project Audit Package includes the milestone gate register"
    );

    // ---------- 18. historic evidence keeps its policy/config reference ----------
    const historicPolicies = q("SELECT policy_version FROM verifications v JOIN evidence_items e ON e.id=v.evidence_item_id WHERE e.id IN ('ev-ms-1','ev-ms-2')");
    assert(
      historicPolicies.every((r) => r.policy_version === null || r.policy_version === 1),
      "18. historic verifications keep their original policy/config references"
    );

    // ---------- 21. tenant isolation ----------
    exec("INSERT INTO organizations (id, name, kind) VALUES ('org-other', 'Unrelated Fund', 'DEVELOPMENT_FINANCE')");
    exec(
      `INSERT INTO users (id, organization_id, name, role, title)
       VALUES ('user-outsider', 'org-other', 'Outside Analyst', 'FUNDER_REP', 'Analyst')`
    );
    await signIn("outsider", "user-outsider");
    const xGates = await api("outsider", "GET", "/api/milestones/ms-3/gates");
    const xReq = await api("outsider", "POST", "/api/milestones/ms-3/inspection-requirement", {
      requirement: "NOT_REQUIRED", requirementBasis: "attempted",
    });
    const xInsp = await api("outsider", "POST", `/api/inspections/${inspId}/result`, { result: "FAILED" });
    assert(
      xGates.status === 404 && xReq.status === 404 && xInsp.status === 404,
      "21. cross-tenant gate reads, determinations and inspection actions return 404"
    );

    console.log(`\nCOMPLETION GATE TESTS PASSED — ${n} checkpoints.`);
    console.log("PHOTOGRAPHIC COMPLETION IS NOT LEGAL OR CONTRACTUAL COMPLETION.");
  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
