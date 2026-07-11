/**
 * Lender Draw Verification Package tests — the 21 required cases.
 *
 *   node scripts/drawpackage-test.js   (HTTP + direct DB + ZIP assertions)
 *
 * Doctrine under test: requested / supported / approved / released /
 * retained amounts stay distinct and reconcile to source records;
 * evidence timestamps are never invented (NOT AVAILABLE when missing);
 * reviewer capacities are distinct and come from formal records only;
 * upload is never acceptance; a missing required lien waiver is
 * prominent; chat is never an approval; the package embeds into the
 * Project Audit Package manifest; tenant isolation and secret hygiene
 * hold.
 */
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3188;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-dvp-"));
const FAKE_WEBHOOK = "https://secret-webhook.example/hooks/T0P-S3CRET-URL";
const FAKE_WA_TOKEN = "WA-PROVIDER-TOKEN-8f3b2c1d9e";

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

function readZip(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) fail("no ZIP end-of-central-directory record");
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

const csvRows = (text) => text.trimEnd().split(/\r\n/).slice(1).filter((l) => l.length);

/** Generate a package and return { report, zip } (funder by default). */
async function generatePackage(key = "funder") {
  const res = await api(key, "POST", "/api/draws/draw-1/verification-package");
  if (res.status !== 201) fail(`package generation -> ${res.status}`);
  const report = (await res.json()).report;
  const dl = await fetch(`${BASE}/reports/file/${report.id}`, {
    headers: { cookie: jars[key] },
  });
  if (dl.status !== 200) fail(`package download -> ${dl.status}`);
  return { report, zip: readZip(Buffer.from(await dl.arrayBuffer())) };
}

(async () => {
  console.log("Lender Draw Verification Package tests — isolated server on :" + PORT);
  await new Promise((r) =>
    spawn(process.execPath, ["dist/server/db/seed.js"], {
      env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
      stdio: "ignore",
    }).on("exit", r)
  );
  const srv = spawn(process.execPath, ["dist/server/http/server.js"], {
    env: {
      ...process.env,
      OBV_DATA_DIR: DATA_DIR,
      PORT: String(PORT),
      OBV_TEAMS_WEBHOOK_URL: FAKE_WEBHOOK,
      OBV_WA_TOKEN: FAKE_WA_TOKEN,
    },
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

    // Make sure the deterministic exception register exists up front.
    await api("funder", "POST", "/api/exceptions/evaluate");

    // ================= phase 1: pre-governance package =================
    const p1 = await generatePackage();
    const zip1 = p1.zip;
    const summary1 = JSON.parse(zip1["draw-summary.json"].toString("utf8"));

    // ---- 1. approved scope and budget lines ----
    const budgetCsv = zip1["budget-lines.csv"].toString("utf8");
    const dbLines = q(
      `SELECT DISTINCT b.code, b.original_budget, b.approved_changes,
              (b.original_budget + b.approved_changes) AS current
       FROM draw_line_items l JOIN budget_lines b
         ON b.code = l.budget_line_id AND b.project_id = 'proj-r47'
       WHERE l.draw_request_id = 'draw-1'`
    );
    assert(
      dbLines.length > 0 &&
        dbLines.every(
          (b) =>
            budgetCsv.includes(b.code) &&
            budgetCsv.includes(String(b.original_budget)) &&
            budgetCsv.includes(String(b.current))
        ) &&
        summary1.contract.original ===
          q1("SELECT SUM(original_budget) s FROM budget_lines WHERE project_id='proj-r47' AND active=1").s,
      "1. approved scope, contract value and every affected budget line reconcile to source records"
    );

    // ---- 2. current + cumulative amounts reconcile ----
    const drawRow = q1("SELECT * FROM draw_requests WHERE id='draw-1'");
    const supportedDb = q(
      "SELECT status, current_requested, supported_amount FROM draw_line_items WHERE draw_request_id='draw-1'"
    ).reduce(
      (s, l) =>
        s +
        (l.status === "SUPPORTED"
          ? l.current_requested
          : l.status === "PARTIALLY_SUPPORTED"
            ? (l.supported_amount ?? 0)
            : 0),
      0
    );
    const cumulativeReqDb = q1(
      `SELECT SUM(requested_amount) s FROM draw_requests
       WHERE project_id='proj-r47' AND draw_number <= 1 AND status != 'CANCELLED' AND submitted_at IS NOT NULL`
    ).s;
    assert(
      summary1.amounts.currentDrawRequested === drawRow.requested_amount &&
        summary1.amounts.currentDrawSupported === supportedDb &&
        summary1.amounts.currentDrawExceptionAmount === drawRow.requested_amount - supportedDb &&
        summary1.amounts.cumulativeRequested === cumulativeReqDb,
      `2. current and cumulative draw amounts reconcile to the database (${supportedDb} supported)`
    );

    // ---- 3. amounts remain distinct ----
    const a1 = summary1.amounts;
    assert(
      "currentDrawRequested" in a1 && "currentDrawSupported" in a1 &&
        "currentDrawExceptionAmount" in a1 && "grossGovernedAmount" in a1 &&
        "retainageWithheld" in a1 && "netReleaseEligible" in a1 && "netReleased" in a1 &&
        "cumulativeRequested" in a1 && "cumulativeSupported" in a1 &&
        "cumulativeApproved" in a1 && "cumulativeReleased" in a1 &&
        "remainingAvailableBudget" in a1 &&
        a1.currentDrawRequested !== a1.currentDrawSupported &&
        a1.grossGovernedAmount === null && a1.grossGovernedBasis === "NOT_FINALIZED" &&
        a1.cumulativeApproved === 0 && a1.netReleased === 0,
      "3. requested / supported / approved / released / retained are distinct, labelled figures"
    );

    // ---- 4. evidence timestamps match source records ----
    const evCsv1 = zip1["evidence-register.csv"].toString("utf8");
    const evDb = q1("SELECT captured_at, uploaded_at, hash FROM evidence_items WHERE id='ev-ms-2'");
    assert(
      evCsv1.includes("ev-ms-2") &&
        evCsv1.includes(evDb.captured_at) &&
        evCsv1.includes(evDb.uploaded_at) &&
        evCsv1.includes(evDb.hash),
      "4. evidence capture/submission timestamps and hash match the stored evidence record"
    );

    // ---- 6/7. reviewer identities from formal records only ----
    const rev1 = zip1["reviewer-register.csv"].toString("utf8");
    const lineReviewers = q(
      `SELECT DISTINCT reviewed_by_user_id u FROM draw_line_items
       WHERE draw_request_id='draw-1' AND reviewed_by_user_id IS NOT NULL`
    ).map((r) => r.u);
    const names = new Map(q("SELECT id, name FROM users").map((r) => [r.id, r.name]));
    assert(
      lineReviewers.every((u) => {
        const row = csvRows(rev1).find((l) => l.startsWith("DRAW LINE REVIEWER") && l.includes(names.get(u)));
        return Boolean(row);
      }) && rev1.includes("DOCUMENT REVIEWER") && rev1.includes("Amina Ndlovu"),
      "6. reviewer identities match the formal line/document review records"
    );
    const submitterRows = csvRows(rev1).filter((l) => l.includes("Chikondi Banda"));
    assert(
      submitterRows.length > 0 &&
        submitterRows.every((l) => l.startsWith("EVIDENCE SUBMITTER")) &&
        summary1.inspectionRecorded === false &&
        zip1["permit-inspection-register.csv"].toString("utf8").includes("NOT YET RECORDED"),
      "7. the evidence submitter is never mislabeled as an inspector; NO FORMAL INSPECTION RECORD is explicit"
    );

    // ---- 8. permit status from authoritative records ----
    const permits1 = zip1["permit-inspection-register.csv"].toString("utf8");
    assert(
      permits1.includes("NOT REQUIRED under current project configuration") &&
        permits1.includes("INSPECTION_REPORT") &&
        !permits1.includes("COMPLIANT"),
      "8. permit register shows truthful states (NOT REQUIRED / NOT YET RECORDED), never blanket compliance"
    );

    // ---- 10. invoices reconcile ----
    const inv1 = zip1["invoice-lien-waiver-register.csv"].toString("utf8");
    const invDb = q1("SELECT invoice_number, vendor, amount FROM draw_documents WHERE id='ddoc-2'");
    assert(
      inv1.includes(invDb.invoice_number) &&
        inv1.includes(String(invDb.amount)) &&
        inv1.includes("ACCEPTED") &&
        inv1.includes("RECEIVED — PENDING REVIEW"),
      "10. invoice register reconciles to stored documents; received pay application stays PENDING REVIEW"
    );

    // ---- 11. missing required lien waiver is prominent ----
    assert(
      summary1.missingRequiredLienWaiver === true &&
        inv1.includes("MISSING — REQUIRED") &&
        inv1.includes("CONDITIONAL"),
      "11. missing required conditional lien waiver is prominently visible"
    );

    // ---- 12. unresolved exceptions included ----
    const excCsv1 = zip1["exception-register.csv"].toString("utf8");
    const drawExc = q("SELECT id FROM exceptions WHERE draw_request_id='draw-1'");
    assert(
      drawExc.length > 0 && drawExc.every((e) => excCsv1.includes(e.id)),
      `12. all ${drawExc.length} draw-linked exceptions appear in the register`
    );

    // ---- 15. chat is never an approval ----
    const appr1 = zip1["approval-history.csv"].toString("utf8");
    const allText1 = Object.entries(zip1)
      .filter(([k]) => !k.endsWith(".pdf"))
      .map(([, v]) => v.toString("latin1"))
      .join("\n");
    assert(
      appr1.includes("NO APPROVAL REQUEST YET") &&
        q1("SELECT COUNT(*) c FROM messages").c > 0 &&
        !allText1.includes("Gravel base compaction is complete") &&
        !allText1.includes("disbursement register is up to date"),
      "15. no approvals exist yet and chat messages never appear as approvals or reviews"
    );

    // ============ phase 2: NOT AVAILABLE + upload≠acceptance ============
    // Evidence with no GPS fix and no verification, linked to the draw.
    exec(
      `INSERT INTO evidence_items (id, milestone_id, user_id, photo_path, latitude,
         longitude, captured_at, uploaded_at, device_metadata, hash, previous_hash, is_demo_fallback)
       VALUES ('ev-nogps', 'ms-3', 'user-field', '/demo-evidence/m1-clearing.jpg', NULL, NULL,
         '2026-07-09T08:00:00.000Z', '2026-07-09T08:30:00.000Z',
         '{"userAgent":"t","platform":"t","screen":"t","language":"t"}', 'feedc0de', NULL, 0)`
    );
    const link = await api("pm", "POST", "/api/draws/draw-1/evidence", {
      evidenceItemId: "ev-nogps",
      note: "No-GPS evidence for register truthfulness test",
    });
    assert(link.status === 201, "   evidence without GPS links to the draw");
    // Optional permit document, recorded but NOT reviewed.
    const permitDoc = await api("pm", "POST", "/api/draws/draw-1/documents", {
      docType: "PERMIT",
      title: "District council works permit",
      issuingAuthority: "Mzimba District Council",
      referenceNumber: "MDC-2026-0417",
      expiresAt: "2027-01-31T00:00:00.000Z",
    });
    assert(permitDoc.status === 201, "   permit document recorded (upload only)");

    const p2 = await generatePackage("compliance");
    const zip2 = p2.zip;
    const evCsv2 = zip2["evidence-register.csv"].toString("utf8");
    const noGpsRow = csvRows(evCsv2).find((l) => l.includes("ev-nogps"));
    assert(
      Boolean(noGpsRow) &&
        noGpsRow.split(",").filter((c) => c.includes("NOT AVAILABLE")).length >= 3 &&
        noGpsRow.includes("NOT VERIFIED"),
      "5. missing GPS / verification / ledger data appears as NOT AVAILABLE — never invented"
    );
    const permits2 = zip2["permit-inspection-register.csv"].toString("utf8");
    const permitRow = csvRows(permits2).find((l) => l.includes("MDC-2026-0417"));
    assert(
      Boolean(permitRow) &&
        permitRow.includes("RECEIVED — PENDING REVIEW") &&
        !permitRow.includes("ACCEPTED") &&
        permitRow.includes("Mzimba District Council"),
      "9. an uploaded permit is PENDING REVIEW — never automatically accepted"
    );

    // ============ phase 3: governance walk to release ============
    const reqRow = q1(
      "SELECT id FROM draw_document_requirements WHERE draw_request_id='draw-1' AND doc_type='CONDITIONAL_LIEN_WAIVER'"
    );
    await api("pm", "POST", "/api/draws/draw-1/documents", {
      requirementId: reqRow.id,
      title: "Conditional lien waiver — June",
      waiverKind: "CONDITIONAL",
      waiverScope: "PARTIAL",
      coveredThrough: "2026-06-30",
      vendor: "CRRA civil works",
    });
    await fetch(BASE + "/api/issues/issue-1/status", {
      method: "POST",
      headers: { cookie: jars.pm, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status: "RESOLVED", resolutionSummary: "Alternate supplier delivered" }).toString(),
      redirect: "manual",
    });
    await api("funder", "POST", "/api/exceptions/evaluate");
    const gov = await api("compliance", "POST", "/api/draws/draw-1/governance", {});
    assert(gov.status === 200, "   draw reaches formal governance");
    const apId = q1("SELECT id FROM approval_requests WHERE draw_request_id='draw-1'").id;
    await api("funder", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    const final = await api("compliance", "POST", `/api/approvals/${apId}/decision`, { decision: "APPROVED" });
    assert(final.status === 200, "   both required roles approve — governed release executes");

    const p3 = await generatePackage();
    const zip3 = p3.zip;
    const summary3 = JSON.parse(zip3["draw-summary.json"].toString("utf8"));
    const a3 = summary3.amounts;
    const drawAfter = q1("SELECT * FROM draw_requests WHERE id='draw-1'");
    const releasedDb = q1(
      "SELECT COALESCE(SUM(amount),0) s FROM draw_account_events WHERE draw_request_id='draw-1' AND type='RELEASED'"
    ).s;

    // ---- 13. resolved unrelated exceptions excluded; draw-linked history kept ----
    const excCsv3 = zip3["exception-register.csv"].toString("utf8");
    const resolvedIssueExc = q1(
      "SELECT id, status FROM exceptions WHERE source_key LIKE 'field-issue:%'"
    );
    const resolvedDrawExc = q1(
      "SELECT id, status FROM exceptions WHERE source_key LIKE 'draw-doc-missing:%'"
    );
    assert(
      resolvedIssueExc &&
        resolvedIssueExc.status === "RESOLVED" &&
        !excCsv3.includes(resolvedIssueExc.id) &&
        resolvedDrawExc &&
        excCsv3.includes(resolvedDrawExc.id),
      "13. resolved unrelated exceptions are excluded; draw-linked exception history remains (with status)"
    );

    // ---- 14. approval history matches ApprovalRecords ----
    const apprCsv3 = zip3["approval-history.csv"].toString("utf8");
    const recordsDb = q(
      "SELECT user_id, role, decision, created_at FROM approval_records WHERE approval_request_id = ?",
      apId
    );
    assert(
      csvRows(apprCsv3).length === recordsDb.length &&
        recordsDb.every(
          (r) =>
            apprCsv3.includes(names.get(r.user_id)) &&
            apprCsv3.includes(r.decision) &&
            apprCsv3.includes(r.created_at) &&
            apprCsv3.includes(r.role)
        ) &&
        apprCsv3.includes(apId),
      "14. approval history matches the stored ApprovalRecords exactly"
    );

    // ---- amounts after release remain distinct and reconcile ----
    assert(
      a3.grossGovernedAmount === drawAfter.approved_amount &&
        a3.grossGovernedBasis === "APPROVED_BY_GOVERNANCE" &&
        a3.retainageWithheld === drawAfter.retainage_withheld &&
        a3.netReleaseEligible === drawAfter.approved_amount - drawAfter.retainage_withheld &&
        a3.netReleased === releasedDb &&
        a3.netReleased === a3.netReleaseEligible &&
        a3.cumulativeReleased === releasedDb &&
        a3.currentDrawRequested === drawAfter.requested_amount &&
        a3.currentDrawRequested !== a3.netReleased,
      `2b. gross/retainage/net/released reconcile after the governed release (net ${releasedDb})`
    );
    const rel3 = zip3["release-events.csv"].toString("utf8");
    assert(
      csvRows(rel3).filter((l) => l.includes("DRAW,RELEASED")).length === 1 &&
        rel3.includes("RETAINAGE,WITHHELD"),
      "   release-events register shows exactly one governed release plus the retainage withhold"
    );

    // ---- 16. PDF/document totals equal CSV/JSON totals ----
    const html = await (
      await fetch(`${BASE}/draw/draw-1/verification-package/preview`, {
        headers: { cookie: jars.funder },
      })
    ).text();
    const fmt = (x) => "$" + x.toLocaleString("en-US");
    assert(
      html.includes(fmt(a3.currentDrawRequested)) &&
        html.includes(fmt(a3.currentDrawSupported)) &&
        html.includes(fmt(a3.netReleased)) &&
        html.includes(fmt(a3.remainingAvailableBudget)) &&
        html.includes("Current Draw Requested") &&
        html.includes("Net Released"),
      "16. the lender document totals equal the CSV/JSON figures"
    );

    // ---- 17. CSV records match database sources ----
    const linesCsv3 = zip3["draw-line-items.csv"].toString("utf8");
    const dbLineRows = q("SELECT id, description, status FROM draw_line_items WHERE draw_request_id='draw-1'");
    assert(
      csvRows(linesCsv3).length === dbLineRows.length &&
        dbLineRows.every((l) => linesCsv3.includes(l.id) && linesCsv3.includes(l.status)),
      "17. line-item register rows match the database exactly"
    );
    // manifest self-verifies
    const manifest3 = JSON.parse(zip3["manifest.json"].toString("utf8"));
    for (const f of manifest3.fileInventory) {
      if (createHash("sha256").update(zip3[f.path]).digest("hex") !== f.sha256) {
        fail(`hash mismatch for ${f.path}`);
      }
    }
    pass("   standalone package manifest hashes recompute for every file");

    // ---- 18. audit package integration ----
    const apGen = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", {});
    const auditPkg = (await apGen.json()).auditPackage;
    const auditZip = readZip(
      Buffer.from(
        await (
          await fetch(`${BASE}/audit-packages/${auditPkg.id}/download`, {
            headers: { cookie: jars.funder },
          })
        ).arrayBuffer()
      )
    );
    const auditManifest = JSON.parse(auditZip["manifest.json"].toString("utf8"));
    const subFiles = auditManifest.fileInventory.filter((f) => f.path.startsWith("04_draws/DRAW-001/"));
    const subSummary = subFiles.find((f) => f.path === "04_draws/DRAW-001/draw-summary.json");
    const subDoc = subFiles.find((f) => /draw-verification-package\.(pdf|html)$/.test(f.path));
    assert(
      subFiles.length >= 13 &&
        Boolean(subSummary) &&
        Boolean(subDoc) &&
        subFiles.every(
          (f) =>
            createHash("sha256").update(auditZip[f.path]).digest("hex") === f.sha256 &&
            typeof f.kind === "string" &&
            "records" in f
        ) &&
        JSON.parse(auditZip["04_draws/DRAW-001/draw-summary.json"].toString("utf8")).amounts.netReleased === releasedDb,
      `18. audit package embeds the draw verification sub-package (${subFiles.length} files, hashed in the manifest)`
    );

    // ---- 19. cross-tenant + role protection ----
    exec("INSERT INTO organizations (id, name, kind) VALUES ('org-other', 'Unrelated Fund', 'DEVELOPMENT_FINANCE')");
    exec(
      `INSERT INTO users (id, organization_id, name, role, title)
       VALUES ('user-outsider', 'org-other', 'Outside Analyst', 'FUNDER_REP', 'Analyst')`
    );
    await signIn("outsider", "user-outsider");
    const xGen = await api("outsider", "POST", "/api/draws/draw-1/verification-package");
    const xDl = await fetch(`${BASE}/reports/file/${p3.report.id}`, {
      headers: { cookie: jars.outsider },
      redirect: "manual",
    });
    const xPrev = await fetch(`${BASE}/draw/draw-1/verification-package/preview`, {
      headers: { cookie: jars.outsider, accept: "text/html" },
      redirect: "manual",
    });
    const fieldGen = await api("field", "POST", "/api/draws/draw-1/verification-package");
    assert(
      xGen.status === 404 && xDl.status === 404 && xPrev.status === 404 && fieldGen.status === 403,
      "19. cross-tenant generation/preview/download return 404; FIELD role gets 403"
    );

    // ---- 20. secret leakage scan ----
    const allText3 = Object.entries(zip3)
      .filter(([k]) => !k.endsWith(".pdf"))
      .map(([, v]) => v.toString("latin1"))
      .join("\n");
    assert(
      !allText3.includes(FAKE_WEBHOOK) &&
        !allText3.includes(FAKE_WA_TOKEN) &&
        !allText3.toLowerCase().includes("token_hash") &&
        !allText3.includes("Gravel base compaction is complete"),
      "20. no secrets, provider tokens, or chat transcripts in the package"
    );

    console.log(`\nDRAW VERIFICATION PACKAGE TESTS PASSED — ${n} checkpoints.`);
  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
