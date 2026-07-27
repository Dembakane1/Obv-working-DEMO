#!/usr/bin/env node
/**
 * DMV Draw Control Record + Governing Code and Permit Basis test suite.
 *
 * Proves the non-negotiable boundaries of the DMV compliance layer:
 *  - a permit-basis version is IMMUTABLE once authoritative — corrections
 *    insert a new version and never rewrite the old one, and changing the
 *    project's current compliance settings never touches basis history;
 *  - a draw keeps referencing the basis version pinned when its control
 *    record was first generated, even after later corrections;
 *  - historical packages are never regenerated from newer settings —
 *    as-of filtering governs every register;
 *  - an OBV field finding and an official jurisdiction inspection result
 *    are separate records; official statuses need official backing and a
 *    determination role;
 *  - eligibility means "eligible for lender review", never approval —
 *    no lender decision, approval, payment instruction, provider event
 *    or banking-balance change is ever produced by this layer;
 *  - tenant isolation: unrelated tenants get the same 404 as nonexistent
 *    records, and field users hold no compliance authority.
 */
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = 3191;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "obv-dmv-"));

let passed = 0;
const pass = (m) => {
  passed++;
  console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`);
};
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
    fail(`${method} ${p} -> ${res.status} (expected ${expect}): ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}
async function page(key, p) {
  const res = await fetch(BASE + p, { headers: { cookie: jars[key] ?? "", accept: "text/html" }, redirect: "manual" });
  return { status: res.status, html: res.status === 200 ? await res.text() : "" };
}

let db;
const q1 = (sql, ...args) => db.prepare(sql).get(...args);
const qa = (sql, ...args) => db.prepare(sql).all(...args);
const exec = (sql, ...args) => db.prepare(sql).run(...args);

/** EVERY banking + financial table the DMV layer must never mutate. */
const PROTECTED_TABLES = [
  "banking_programs", "project_virtual_accounts", "project_account_holds",
  "payment_instructions", "bank_transactions", "mock_provider_ledger",
  "reconciliation_runs", "banking_events", "virtual_account_events",
  "draw_account_events", "approval_records", "approval_requests",
  "retainage_events", "retainage_release_requests", "ledger_entries",
  "budget_lines", "draw_line_items",
];
function bankingSnapshot() {
  const snap = {};
  for (const t of PROTECTED_TABLES) {
    const rows = qa(`SELECT * FROM ${t} ORDER BY rowid`);
    snap[t] = createHash("sha256").update(JSON.stringify(rows)).digest("hex") + ":" + rows.length;
  }
  snap.draw_amounts = JSON.stringify(
    qa("SELECT id, requested_amount, approved_amount, recommended_amount, retainage_withheld, status FROM draw_requests ORDER BY id")
  );
  snap.milestones_released = q1("SELECT COUNT(*) c FROM milestones WHERE account_status = 'RELEASED'").c;
  return snap;
}
function assertSnapshotEqual(a, b, label) {
  for (const k of Object.keys(a)) {
    if (a[k] !== b[k]) fail(`${label}: table ${k} changed (${a[k]} -> ${b[k]})`);
  }
  pass(label);
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

const SCOPE_NOTE =
  "OBV records construction compliance evidence, source lookups, inspection status, verification " +
  "results, and lender-review eligibility. OBV does not issue permits, perform government inspections, " +
  "provide legal interpretations, approve loans, or automatically authorize payment.";
const ELIGIBLE_WORDING = "Eligible for lender review — not automatically approved.";

const P = "proj-dmv";
const D = "draw-dmv-1";

async function controlRecord(key = "funder") {
  return j(key, "GET", `/api/draws/${D}/control-record`, undefined, 200);
}
const lineOf = (rec, id) => rec.lines.find((l) => l.drawLineItemId === id);
const codes = (line) => line.eligibilityReasons.map((r) => r.code);

async function main() {
  console.log("DMV Draw Control + Permit Basis tests — isolated server on :" + PORT);

  // ================== 0. static source boundaries ==================
  const src = (p) => readFileSync(path.join(__dirname, "..", "src", "server", p), "utf8");
  const runtimeOnly = (s) => s.replace(/^import type .*$/gm, "");
  const dmvSrc = runtimeOnly([
    src("services/dmvCompliance.ts"), src("db/dmvRepo.ts"),
    src("http/complianceRoutes.ts"), src("services/dmvRegisters.ts"),
  ].join("\n"));
  assert(
    !/node:https?\b|fetch\s*\(|axios|XMLHttpRequest|net\.connect|playwright|puppeteer/.test(dmvSrc),
    "no DMV module imports HTTP clients, scrapers, or makes network calls (manual lookups only)"
  );
  assert(
    !/api[_-]?key|apikey|client[_-]?secret|bearer |password\s*[:=]/i.test(dmvSrc),
    "no DMV module contains government credentials or auth-token material"
  );
  assert(
    !/VirtualAccountService/.test(dmvSrc),
    "no DMV module calls into VirtualAccountService (no new release path)"
  );
  assert(
    !/INSERT INTO (banking_|payment_instructions|bank_transactions|project_virtual_accounts|project_account_holds|mock_provider_ledger)/.test(dmvSrc) &&
      !/UPDATE (banking_|payment_instructions|bank_transactions|project_virtual_accounts|project_account_holds|mock_provider_ledger|budget_lines|draw_requests|draw_line_items)/.test(dmvSrc),
    "no DMV module writes any banking, budget, or draw financial table"
  );
  const repoSrc = src("db/dmvRepo.ts");
  assert(
    !/UPDATE source_verifications|DELETE FROM source_verifications|UPDATE cost_to_complete_estimates|DELETE FROM cost_to_complete_estimates/.test(repoSrc),
    "source verifications and cost-to-complete estimates are append-only (no update/delete path)"
  );
  const basisUpdates = [...repoSrc.matchAll(/UPDATE permit_basis_versions\s+SET ([^\n]+)/g)].map((m) => m[1]);
  assert(
    basisUpdates.length === 2 &&
      basisUpdates.every((s) => /^(status|effective_from|finalized_at|finalized_by_user_id|superseded_at|\s|=|'|,|\?|[A-Z_])+$/.test(s)) &&
      !basisUpdates.some((s) => /jurisdiction|permit_number|governing|parcel|address|record_hash|notes|lookup/.test(s)),
    "the ONLY permit-basis updates are the guarded lifecycle transitions — content columns have no write path"
  );

  // ================== boot: seed + demo server ==================
  spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "server", "db", "seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
    stdio: "ignore",
  });
  const server = spawn(process.execPath, [path.join(__dirname, "..", "dist", "server", "http", "server.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PORT), OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  db = new DatabaseSync(path.join(DATA_DIR, "obv.db"));

  try {
    await signIn("funder", "user-funder");
    await signIn("compliance", "user-compliance");
    await signIn("pm", "user-dmv-pm"); // fictional borrower-side PM (org-dmv-borrower)
    await signIn("field", "user-field");

    // ================== 1. seeded demonstration project ==================
    const view = await j("funder", "GET", `/api/projects/${P}/compliance`, undefined, 200);
    assert(view.scopeNote === SCOPE_NOTE, "the compliance view carries the exact required scope statement");
    assert(view.bases.length === 5, "seeded demo has 5 permit-basis versions across 4 permits");
    const v1 = view.bases.find((b) => b.id === "pbv-dmv-bldg-1");
    const v2 = view.bases.find((b) => b.id === "pbv-dmv-bldg-2");
    assert(v1.status === "SUPERSEDED" && v1.supersededAt !== null && v1.parcelIdentifier.includes("0041"),
      "the corrected v1 keeps its ORIGINAL (wrong) parcel value and a superseded bound — history preserved");
    assert(v2.status === "AUTHORITATIVE" && v2.supersedesVersionId === "pbv-dmv-bldg-1" &&
      v2.correctionReason !== null && v2.correctedByUserId === "user-compliance" && v2.parcelIdentifier.includes("0042"),
      "the correction is a NEW version carrying reason, correcting user, and the prior-version relationship");
    assert(v1.recordHash !== v2.recordHash && /^[0-9a-f]{64}$/.test(v1.recordHash),
      "each basis version carries its own sha256 content hash");
    const elec = view.bases.find((b) => b.id === "pbv-dmv-elec-1");
    assert(elec.governingBasis === "PRIOR_CODE_TRANSITION" && elec.transitionRuleId === "trr-dmv-1",
      "the electrical basis is governed by a PRIOR_CODE_TRANSITION referencing the recorded rule");
    const mech = view.bases.find((b) => b.id === "pbv-dmv-mech-1");
    assert(mech.status === "DRAFT" && mech.governingBasis === "UNRESOLVED",
      "the mechanical basis is an UNRESOLVED draft (permit application pending)");
    const rule = view.transitionRules.find((r) => r.id === "trr-dmv-1");
    assert(rule.eligibility === "ELIGIBLE_PRIOR_CODE" && rule.determinedAt !== null &&
      rule.reviewerUserId === "user-compliance" && rule.governingInterpretation !== null,
      "the transition rule holds a HUMAN determination with reviewer, timestamp, and interpretation");
    assert(rule.applicationDateCutoff === "2026-03-15" && rule.priorCodeEdition.includes("2013"),
      "the transition rule preserves cutoffs and both code editions");
    const reqStatuses = view.requirements.map((r) => r.status).sort();
    assert(JSON.stringify(reqStatuses) === JSON.stringify(["CORRECTION_REQUIRED", "PASSED", "SCHEDULED"]),
      "seeded requirements cover PASSED, SCHEDULED (pending), and CORRECTION_REQUIRED (failed) inspections");
    const passedReq = view.requirements.find((r) => r.id === "lir-dmv-1");
    assert(passedReq.officialSourceId === "osr-dmv-1" && passedReq.lookupAt !== null &&
      passedReq.officialResultText.includes("PASSED"),
      "the passed requirement is backed by an official-source record, verbatim result text, and a lookup timestamp");
    assert(view.verifications.length === 3 &&
      view.verifications.some((s) => s.resultStatus === "VERIFIED_MATCH") &&
      view.verifications.some((s) => s.resultStatus === "MANUAL_REVIEW_REQUIRED") &&
      view.verifications.every((s) => s.verificationMethod === "MANUAL_PORTAL_LOOKUP" && s.lookupAt),
      "manual source verifications are recorded with lookup timestamps and labeled as manual portal lookups");
    assert(view.estimates.length === 2 && view.estimates.every((e) => Number.isInteger(e.estimatedCostToComplete)),
      "cost-to-complete estimates are whole-currency integers");
    const openExc = qa("SELECT source_key, status FROM exceptions WHERE project_id = ?", P);
    assert(openExc.some((e) => e.source_key === "dmv-verification-review:srcver-dmv-2" && e.status === "OPEN"),
      "seeded demo carries an OPEN exception (verification needs review)");
    assert(openExc.some((e) => e.source_key === "dmv-verification-review:srcver-dmv-0" && e.status === "RESOLVED"),
      "seeded demo carries a RESOLVED exception with its lifecycle history");
    assert(openExc.some((e) => e.source_key === "dmv-correction-required:lir-dmv-3" && e.status === "OPEN"),
      "the failed official inspection surfaced a correction-required exception");
    assert(qa("SELECT id FROM exception_events WHERE exception_id = 'exc-dmv-resolved'").length >= 2,
      "the resolved exception keeps its audit event history");

    // ================== 2. banking non-mutation baseline ==================
    const baseline = bankingSnapshot();
    pass("banking + financial snapshot baseline captured");

    // ================== 3. Draw Control Record ==================
    let rec = await controlRecord();
    assert(rec.scopeNote === SCOPE_NOTE && rec.eligibleWording === ELIGIBLE_WORDING,
      "the control record carries the scope statement and the exact eligible-for-review wording");
    assert(rec.lines.length === 3, "the control record shows every draw line independently");

    const l1 = lineOf(rec, "dline-dmv-1");
    const FIELDS = [
      "budgetLineCode", "scopeDescription", "jurisdiction", "governingBases",
      "borrowerRequestedAmount", "contractorPercentComplete", "contractorCompletedAmount",
      "photoEvidenceCount", "verifiedPhotoEvidenceCount", "invoiceDocumentCount", "lienWaiverStatus",
      "drawInspectorFinding", "inspectorObservedPercent", "inspectorSupportedAmount",
      "requiredInspections", "priorFunded", "currentRequested", "cumulativeRequested",
      "remainingBudget", "estimatedCostToComplete", "projectedVariance", "retainageAmount",
      "openExceptions", "reviewerNotes", "finalEligibilityStatus", "eligibilityReasons",
    ];
    assert(FIELDS.every((f) => f in l1), "every specified control-record field is present on each line");
    assert(l1.finalEligibilityStatus === "ELIGIBLE_FOR_LENDER_REVIEW" &&
      l1.eligibilityReasons.length === 1 && l1.eligibilityReasons[0].code === "ELIGIBLE" &&
      l1.eligibilityReasons[0].message === ELIGIBLE_WORDING,
      "line 1 is ELIGIBLE_FOR_LENDER_REVIEW with the exact non-approval wording as its reason");
    assert(l1.priorFunded === 60000 && l1.currentRequested === 30000 && l1.cumulativeRequested === 90000 &&
      l1.remainingBudget === 30000 && l1.estimatedCostToComplete === 30000 && l1.projectedVariance === 0,
      "line 1 financials: prior funded, cumulative, remaining budget, CTC, and variance all computed correctly");
    assert(l1.contractorPercentComplete === 75 && l1.inspectorObservedPercent === 75 &&
      l1.drawInspectorFinding === "SUPPORTED" && l1.verifiedPhotoEvidenceCount === 1 &&
      l1.invoiceDocumentCount === 1 && l1.lienWaiverStatus === "ACCEPTED",
      "line 1 keeps contractor-reported, inspector-observed, evidence, invoice, and waiver values distinct");
    assert(l1.requiredInspections.length === 1 && l1.requiredInspections[0].status === "PASSED" &&
      l1.requiredInspections[0].officialSourceId === "osr-dmv-1" && l1.requiredInspections[0].lookupAt,
      "line 1's official inspection shows PASSED with its source record and lookup date");
    assert(l1.governingBases.length === 1 && l1.governingBases[0].basisVersionId === "pbv-dmv-bldg-2" &&
      l1.governingBases[0].version === 2,
      "line 1 is governed by the authoritative (corrected) basis version 2");

    const l2 = lineOf(rec, "dline-dmv-2");
    assert(l2.finalEligibilityStatus === "EXCEPTION_OPEN",
      "line 2 (failed plumbing inspection + reviewer exception) is EXCEPTION_OPEN — blocked");
    assert(codes(l2).includes("INSPECTION_CORRECTION_REQUIRED") && codes(l2).includes("CLAIM_EXCEEDS_INSPECTOR") &&
      codes(l2).includes("LINE_EXCEPTION_FINDING"),
      "line 2 carries explicit reason codes: correction-required inspection, claim>inspector, reviewer exception");
    assert(l2.contractorPercentComplete === 60 && l2.inspectorObservedPercent === 40,
      "line 2 shows the contractor claim (60%) and inspector observation (40%) as separate figures");

    const l3 = lineOf(rec, "dline-dmv-3");
    assert(l3.finalEligibilityStatus === "EVIDENCE_INCOMPLETE",
      "line 3 (no invoice, no verified photo, no waiver) is EVIDENCE_INCOMPLETE — needs documentation");
    assert(codes(l3).includes("PHOTO_EVIDENCE_MISSING") && codes(l3).includes("INVOICE_MISSING") &&
      codes(l3).includes("LIEN_WAIVER_MISSING"),
      "line 3 lists each missing document as its own reason code");

    const ALLOWED = new Set([
      "NOT_READY", "EVIDENCE_INCOMPLETE", "INSPECTION_REQUIRED", "OFFICIAL_STATUS_PENDING",
      "EXCEPTION_OPEN", "OVER_BUDGET_REVIEW_REQUIRED", "ELIGIBLE_FOR_LENDER_REVIEW",
      "INELIGIBLE", "HELD_BY_DISPUTE", "HELD_BY_LEGAL_HOLD",
    ]);
    assert(rec.lines.every((l) => ALLOWED.has(l.finalEligibilityStatus)) &&
      !JSON.stringify(rec).includes('"APPROVED"'),
      "every final status is from the allowed vocabulary — no line is ever labeled approved");

    // Pins: generating the control record pinned the authoritative basis
    // versions to this draw (permits without one are not pinned).
    const pins = qa("SELECT permit_id, permit_basis_version_id FROM draw_permit_basis_pins WHERE draw_request_id = ?", D);
    assert(pins.length === 3 && !pins.some((p) => p.permit_id === "permit-dmv-mech"),
      "three authoritative bases were pinned to the draw; the draft mechanical basis was not");
    assert(pins.find((p) => p.permit_id === "permit-dmv-bldg").permit_basis_version_id === "pbv-dmv-bldg-2",
      "the building permit pin references version 2 — the version authoritative at review time");

    // ================== 4. historical package BEFORE correction ==================
    const genA = await api("funder", "POST", `/api/draws/${D}/verification-package`);
    assert(genA.status === 201, "draw verification package A generates (before correction)");
    const repA = (await genA.json()).report;
    const zipA = readZip(Buffer.from(await (await fetch(`${BASE}/reports/file/${repA.id}`, { headers: { cookie: jars.funder } })).arrayBuffer()));
    for (const f of [
      "dmv-summary.json", "permit-basis-register.csv", "permit-basis-version-history.csv",
      "transition-rules.csv", "required-inspections.csv", "official-inspection-status.csv",
      "source-verifications.csv", "cost-to-complete.csv", "draw-permit-basis-pins.csv",
      "draw-control-record.csv", "eligibility-reasons.csv",
    ]) {
      assert(Boolean(zipA[f]), `package A carries the structured register ${f}`);
    }
    const sumA = JSON.parse(zipA["dmv-summary.json"].toString("utf8"));
    assert(sumA.scopeNote === SCOPE_NOTE && /MANUAL lookups/.test(sumA.verificationBasis) &&
      /no live integration/.test(sumA.verificationBasis),
      "the package summary carries the scope statement and presents lookups as manual, never a live integration");
    const regA = zipA["permit-basis-register.csv"].toString("utf8");
    assert(regA.split("\r\n").filter((l) => l.startsWith("DEMO-B2026-04517")).length === 2 &&
      /DEMO-B2026-04517,2,AUTHORITATIVE/.test(regA) && !/,3,/.test(regA),
      "package A's basis register shows v2 authoritative and no v3 — the state at generation time");
    const htmlA = zipA["draw-verification-package.pdf"]
      ? null
      : zipA["draw-verification-package.html"].toString("utf8");
    if (htmlA) {
      assert(htmlA.includes("Governing Code and Permit Basis"),
        "the visible DC package document carries the 'Governing Code and Permit Basis' section");
      assert(htmlA.includes("Eligible for lender review — not automatically approved."),
        "the visible package document carries the prominent non-approval wording");
      assert(htmlA.includes("contractor-reported") && htmlA.includes("OBV inspector"),
        "the package document labels contractor-reported and inspector-observed figures distinctly");
    }
    const manifestA = JSON.parse(zipA["manifest.json"].toString("utf8"));
    assert(manifestA.kind === "OBV_DRAW_VERIFICATION_PACKAGE", "package A manifest kind preserved");
    let allHashesOk = true;
    for (const entry of manifestA.fileInventory) {
      const got = createHash("sha256").update(zipA[entry.path]).digest("hex");
      if (got !== entry.sha256) allHashesOk = false;
    }
    assert(allHashesOk && manifestA.fileInventory.some((e) => e.path === "draw-control-record.csv"),
      "every DMV register file hash in the manifest verifies — package integrity intact");

    // ================== 5. immutability + versioned correction ==================
    const noReason = await api("compliance", "POST", "/api/permit-basis/pbv-dmv-bldg-2/correct",
      { notes: "x", correctionReason: "short" });
    assert(noReason.status === 400, "a correction without a substantive reason is refused (400)");
    const v2Before = q1("SELECT * FROM permit_basis_versions WHERE id = 'pbv-dmv-bldg-2'");
    const corr = await j("compliance", "POST", "/api/permit-basis/pbv-dmv-bldg-2/correct", {
      governingCodeEdition: "2017 DC Construction Codes (2015 IBC/IEBC with DC amendments), errata 2",
      correctionReason: "Recorded code edition updated to cite the errata batch (fictional demo correction).",
    }, 201);
    assert(corr.basis.version === 3 && corr.basis.status === "AUTHORITATIVE" &&
      corr.basis.supersedesVersionId === "pbv-dmv-bldg-2" && corr.basis.correctedByUserId === "user-compliance",
      "a correction inserts version 3 as the new authoritative record with full attribution");
    const v2After = q1("SELECT * FROM permit_basis_versions WHERE id = 'pbv-dmv-bldg-2'");
    const contentEqual = Object.keys(v2Before).every(
      (k) => ["status", "superseded_at"].includes(k) || String(v2Before[k]) === String(v2After[k])
    );
    assert(contentEqual && v2After.status === "SUPERSEDED" && v2After.superseded_at !== null,
      "v2's CONTENT is byte-identical after the correction — only its lifecycle status and superseded bound changed");
    assert(String(q1("SELECT record_hash FROM permit_basis_versions WHERE id = 'pbv-dmv-bldg-1'").record_hash) === v1.recordHash,
      "v1 remains completely untouched through a second correction");
    assert((await api("compliance", "POST", "/api/permit-basis/pbv-dmv-bldg-2/correct",
      { notes: "y", correctionReason: "Correcting a superseded version must fail." })).status === 409,
      "only the AUTHORITATIVE version can be corrected — superseded versions are closed (409)");
    assert((await api("compliance", "POST", "/api/permit-basis/pbv-dmv-bldg-2/finalize")).status === 409,
      "a superseded version can never be re-finalized (409)");
    assert((await api("funder", "PUT", "/api/permit-basis/pbv-dmv-bldg-2/finalize")).status !== 200 &&
      (await api("funder", "POST", "/api/permit-basis/pbv-dmv-bldg-2/edit")).status === 404,
      "no in-place edit endpoint exists for basis versions");

    // The draw STILL references the version pinned at review time.
    rec = await controlRecord();
    assert(lineOf(rec, "dline-dmv-1").governingBases[0].basisVersionId === "pbv-dmv-bldg-2",
      "after the correction the draw's control record still cites pinned v2 — the version that applied at review");
    assert(qa("SELECT * FROM draw_permit_basis_pins WHERE draw_request_id = ?", D).length === 3,
      "no duplicate or replacement pins were created (first pin wins permanently)");

    // ================== 6. compliance-settings changes never rewrite history ==================
    const basisTableBefore = createHash("sha256")
      .update(JSON.stringify(qa("SELECT * FROM permit_basis_versions ORDER BY id")))
      .digest("hex");
    await j("funder", "POST", `/api/projects/${P}/jurisdiction`, {
      templateKey: "ARLINGTON_COUNTY_VA",
      jurisdictionName: "Arlington County",
      permitAuthority: "Arlington County CPHD (settings change test)",
    });
    pass("project jurisdiction compliance settings changed (template, authority)");
    const basisTableAfter = createHash("sha256")
      .update(JSON.stringify(qa("SELECT * FROM permit_basis_versions ORDER BY id")))
      .digest("hex");
    assert(basisTableBefore === basisTableAfter,
      "REGRESSION: changing project compliance settings did not alter ANY permit-basis version");
    const codeBasisRes = await api("compliance", "POST", "/api/permits/permit-dmv-bldg/code-basis", {
      applicableCodeEdition: "2026 DC Construction Codes (hypothetical future edition)",
      codeBasis: "Settings-change regression test",
    });
    assert(codeBasisRes.status === 200 || codeBasisRes.status === 201,
      "the permit row's CURRENT code basis (mutable setting) can be updated");
    assert(basisTableAfter === createHash("sha256")
      .update(JSON.stringify(qa("SELECT * FROM permit_basis_versions ORDER BY id"))).digest("hex"),
      "REGRESSION: changing the current code edition did not rewrite any authoritative basis version");
    const zipA2 = readZip(Buffer.from(await (await fetch(`${BASE}/reports/file/${repA.id}`, { headers: { cookie: jars.funder } })).arrayBuffer()));
    assert(createHash("sha256").update(zipA2["permit-basis-register.csv"]).digest("hex") ===
      createHash("sha256").update(zipA["permit-basis-register.csv"]).digest("hex"),
      "REGRESSION: the historical package's stored registers are byte-identical after every settings change");
    // Restore the DC profile for the remaining demo-realistic checks.
    await j("funder", "POST", `/api/projects/${P}/jurisdiction`, { templateKey: "DISTRICT_OF_COLUMBIA" });

    // Package B reflects the new correction going forward (never backward).
    const genB = await api("funder", "POST", `/api/draws/${D}/verification-package`);
    const repB = (await genB.json()).report;
    const zipB = readZip(Buffer.from(await (await fetch(`${BASE}/reports/file/${repB.id}`, { headers: { cookie: jars.funder } })).arrayBuffer()));
    const regB = zipB["permit-basis-register.csv"].toString("utf8");
    assert(/DEMO-B2026-04517,3,AUTHORITATIVE/.test(regB) && /DEMO-B2026-04517,2,SUPERSEDED/.test(regB) &&
      /DEMO-B2026-04517,1,SUPERSEDED/.test(regB),
      "package B (generated after the correction) shows v3 authoritative with the full preserved version history");
    assert(/pbv-dmv-bldg-2/.test(zipB["draw-permit-basis-pins.csv"].toString("utf8")),
      "package B's pin register still binds the draw to v2 — historical binding survives corrections");
    const histB = zipB["permit-basis-version-history.csv"].toString("utf8");
    assert(histB.includes("errata") && histB.includes("Amina Ndlovu"),
      "the version-history register carries each correction's reason and the correcting user");

    // ================== 7. official vs OBV separation ==================
    const noBacking = await api("compliance", "POST", "/api/line-requirements/lir-dmv-2/status",
      { toStatus: "PASSED" });
    assert(noBacking.status === 400 && /official/i.test((await noBacking.json()).error),
      "an official PASSED status without official backing or a lookup timestamp is refused (400)");
    const pmOfficial = await api("pm", "POST", "/api/line-requirements/lir-dmv-2/status",
      { toStatus: "PASSED", officialResultText: "PASSED (demo)", lookupAt: "2026-07-19T10:00:00.000Z" });
    assert(pmOfficial.status === 403,
      "a PROJECT_MANAGER cannot record official inspection results (determination roles only, 403)");
    // In-tenant FIELD user: tenancy passes, role authority must still fail.
    exec("INSERT INTO users (id, organization_id, name, role, title) VALUES ('user-dmv-field', 'org-dmv-borrower', 'Field Demo (Fictional)', 'FIELD', 'Site Tech')");
    await signIn("dmvField", "user-dmv-field");
    const fieldAny = await api("dmvField", "POST", "/api/line-requirements/lir-dmv-2/status",
      { toStatus: "SCHEDULED" });
    assert(fieldAny.status === 403, "a FIELD user holds no compliance recording authority (403)");
    const passElec = await j("compliance", "POST", "/api/line-requirements/lir-dmv-2/status", {
      toStatus: "PASSED",
      officialResultText: "PASSED — rough-in approved (fictional demo record)",
      lookupAt: "2026-07-19T10:00:00.000Z",
      completedDate: "2026-07-18",
    }, 200);
    assert(passElec.requirement.status === "PASSED" && passElec.requirement.reviewerUserId === "user-compliance",
      "a determination role records PASSED with official backing, verbatim text, and attribution");
    assert((await api("compliance", "POST", "/api/line-requirements/lir-dmv-2/status",
      { toStatus: "UNKNOWN" })).status === 409,
      "an official PASSED result is immutable — no transition out of PASSED (409)");

    // A verified OBV photo/evidence NEVER moves an official inspection status.
    const freshReq = (await j("compliance", "POST", `/api/projects/${P}/line-requirements`, {
      budgetLineId: "bl-dmv-1", inspectionType: "Close-in inspection (demo)",
      jurisdiction: "District of Columbia", inspectionAuthority: "DC Department of Buildings",
      requiredBeforePayment: false,
    }, 201)).requirement;
    assert(freshReq.status === "REQUIRED_NOT_SCHEDULED",
      "a new requirement starts REQUIRED_NOT_SCHEDULED");
    assert((await j("compliance", "GET", `/api/projects/${P}/compliance`, undefined, 200))
      .requirements.find((r) => r.id === freshReq.id).status === "REQUIRED_NOT_SCHEDULED",
      "REGRESSION: verified OBV field evidence on the same budget line did not move the official status");

    // Walk the remaining status vocabulary with proper backing.
    const walk = async (id, toStatus, extra = {}, expect = 200) =>
      j("compliance", "POST", `/api/line-requirements/${id}/status`, { toStatus, ...extra }, expect);
    await walk(freshReq.id, "SCHEDULED", { scheduledDate: "2026-08-01" });
    await walk(freshReq.id, "PENDING_OFFICIAL_CONFIRMATION", {});
    await walk(freshReq.id, "FAILED", { officialResultText: "FAILED (demo)", lookupAt: "2026-08-02T10:00:00.000Z" });
    await walk(freshReq.id, "REINSPECTION_REQUIRED", { officialResultText: "Reinspection required (demo)", lookupAt: "2026-08-02T10:05:00.000Z" });
    await walk(freshReq.id, "SCHEDULED", { scheduledDate: "2026-08-09" });
    await walk(freshReq.id, "PARTIAL", { officialResultText: "PARTIAL approval (demo)", lookupAt: "2026-08-10T10:00:00.000Z" });
    await walk(freshReq.id, "CORRECTION_REQUIRED", { correctionNotice: "Fix flashing (demo)", officialResultText: "Corrections (demo)", lookupAt: "2026-08-11T10:00:00.000Z" });
    await walk(freshReq.id, "UNKNOWN", {});
    await walk(freshReq.id, "NOT_FOUND", { lookupAt: "2026-08-12T10:00:00.000Z", officialResultText: "No record found in portal (demo)" });
    await walk(freshReq.id, "REQUIRED_NOT_SCHEDULED", {});
    await walk(freshReq.id, "WAIVED_BY_AUTHORITY", { officialResultText: "Waived per authority letter (demo)", lookupAt: "2026-08-13T10:00:00.000Z" });
    await walk(freshReq.id, "REQUIRED_NOT_SCHEDULED", {});
    await walk(freshReq.id, "NOT_REQUIRED", {});
    pass("the full official-status vocabulary is reachable through guarded, backed transitions");
    await walk(freshReq.id, "SCHEDULED", {}, 409);
    pass("invalid transitions (NOT_REQUIRED → SCHEDULED) are refused by the status machine");

    // Trade-type extensibility: not a closed DMV-only list.
    const draftCustom = (await j("compliance", "POST", "/api/permits/permit-dmv-mech/basis", {
      jurisdiction: "District of Columbia", permittingAuthority: "DC Department of Buildings",
      permitNumber: "DEMO-M2026-05120", permitType: "MECHANICAL", tradeType: "GEOTHERMAL_LOOP",
      permitStatus: "APPLIED", governingBasis: "UNRESOLVED", verificationMethod: "OTHER",
    }, 201)).basis;
    assert(draftCustom.tradeType === "GEOTHERMAL_LOOP",
      "trade types are extensible free-form values — no hard-coded DMV-only closed list");

    // ================== 8. transition rules need a human determination ==================
    const newRule = (await j("compliance", "POST", `/api/projects/${P}/transition-rules`, {
      jurisdiction: "District of Columbia",
      priorCodeEdition: "2017 DC Construction Codes",
      replacementCodeEdition: "2026 DC Construction Codes (hypothetical)",
      applicationDateCutoff: "2026-12-31",
    }, 201)).rule;
    assert(newRule.eligibility === "PENDING_DETERMINATION" && newRule.determinedAt === null,
      "a recorded transition rule starts PENDING_DETERMINATION — applicability is never date-inferred");
    assert((await api("pm", "POST", `/api/transition-rules/${newRule.id}/determine`,
      { eligibility: "ELIGIBLE_PRIOR_CODE", governingInterpretation: "x" })).status === 403,
      "eligibility determination requires a determination role (403 for PM)");
    assert((await api("compliance", "POST", `/api/transition-rules/${newRule.id}/determine`,
      { eligibility: "ELIGIBLE_PRIOR_CODE" })).status === 400,
      "an ELIGIBLE determination without a governing interpretation is refused (400)");
    const det = await j("compliance", "POST", `/api/transition-rules/${newRule.id}/determine`,
      { eligibility: "NOT_ELIGIBLE", governingInterpretation: "Application filed after the cutoff (demo)." }, 200);
    assert(det.rule.eligibility === "NOT_ELIGIBLE" && det.rule.determinedAt !== null,
      "an authorized human determination is recorded exactly once with its timestamp");
    assert((await api("compliance", "POST", `/api/transition-rules/${newRule.id}/determine`,
      { eligibility: "ELIGIBLE_PRIOR_CODE", governingInterpretation: "y" })).status === 409,
      "a determined rule cannot be re-determined (409)");
    const draftTrans = (await j("compliance", "POST", "/api/permits/permit-dmv-mech/basis", {
      jurisdiction: "District of Columbia", permittingAuthority: "DC Department of Buildings",
      permitNumber: "DEMO-M2026-05120", permitType: "MECHANICAL", permitStatus: "APPLIED",
      governingBasis: "PRIOR_CODE_TRANSITION", transitionRuleId: newRule.id,
      verificationMethod: "MANUAL_PORTAL_LOOKUP",
    }, 201)).basis;
    assert((await api("compliance", "POST", `/api/permit-basis/${draftTrans.id}/finalize`)).status === 409,
      "a PRIOR_CODE_TRANSITION basis cannot become authoritative without an ELIGIBLE_PRIOR_CODE determination");

    // ================== 9. manual verification workflow ==================
    assert((await api("pm", "POST", `/api/projects/${P}/source-verifications`, {
      officialService: "x", searchCriteria: "y", lookupAt: "2026-07-20T10:00:00.000Z",
      resultStatus: "VERIFIED_MATCH", verificationMethod: "MANUAL_PORTAL_LOOKUP",
    })).status === 403, "recording a source verification requires a determination role (403 for PM)");
    assert((await api("compliance", "POST", `/api/projects/${P}/source-verifications`, {
      officialService: "x", searchCriteria: "y", lookupAt: "2026-07-20T10:00:00.000Z",
      resultStatus: "TOTALLY_FINE", verificationMethod: "MANUAL_PORTAL_LOOKUP",
    })).status === 400, "an unknown verification result status is rejected (400)");
    assert((await api("compliance", "POST", `/api/projects/${P}/source-verifications`, {
      officialService: "x", searchCriteria: "y",
      resultStatus: "VERIFIED_MATCH", verificationMethod: "MANUAL_PORTAL_LOOKUP",
    })).status === 400, "a verification without its lookup timestamp is rejected (400)");
    for (const status of ["VERIFIED_MATCH", "PARTIAL_MATCH", "NO_MATCH_FOUND", "RECORD_UNAVAILABLE", "SOURCE_UNAVAILABLE", "MANUAL_REVIEW_REQUIRED"]) {
      const v = (await j("compliance", "POST", `/api/projects/${P}/source-verifications`, {
        officialService: `Status coverage (${status})`, searchCriteria: "coverage run (demo)",
        lookupAt: "2026-07-20T11:00:00.000Z", resultStatus: status,
        verificationMethod: "MANUAL_PORTAL_LOOKUP", confidence: "MEDIUM",
      }, 201)).verification;
      if (v.resultStatus !== status || v.performedByUserId !== "user-compliance") fail(`status ${status} not recorded faithfully`);
    }
    pass("all six verification result statuses record with actor attribution (never caller-supplied)");

    // ================== 10. cost to complete ==================
    assert((await api("compliance", "POST", `/api/projects/${P}/cost-to-complete`, {
      budgetLineId: "bl-dmv-2", estimatedCostToComplete: 100.5, sourceOfEstimate: "s",
      estimateDate: "2026-07-20", confidence: "LOW",
    })).status === 400, "a fractional cost-to-complete amount is rejected — whole-currency integers only");
    assert((await api("compliance", "POST", `/api/projects/${P}/cost-to-complete`, {
      budgetLineId: "bl-dmv-2", estimatedCostToComplete: -5, sourceOfEstimate: "s",
      estimateDate: "2026-07-20", confidence: "LOW",
    })).status === 400, "a negative cost-to-complete amount is rejected");
    await j("compliance", "POST", `/api/projects/${P}/cost-to-complete`, {
      budgetLineId: "bl-dmv-2", drawRequestId: D, estimatedCostToComplete: 90000,
      verifiedCompletedValue: 20000, remainingCommittedCost: 65000,
      sourceOfEstimate: "Electrician change-order pricing (demo)", estimateDate: "2026-07-20",
      confidence: "MEDIUM", notes: "Deliberate over-budget scenario for the regression suite.",
    }, 201);
    rec = await controlRecord();
    const l3b = lineOf(rec, "dline-dmv-3");
    assert(l3b.estimatedCostToComplete === 90000 && l3b.costSummary.projectedFinalCost === 125000 &&
      l3b.projectedVariance === -40000,
      "the new estimate drives projected final cost (35k requested + 90k CTC) and a -40,000 variance");
    assert(codes(l3b).includes("PROJECTED_OVERRUN") && l3b.finalEligibilityStatus === "EVIDENCE_INCOMPLETE",
      "the overrun surfaces as an explicit reason while the documented precedence still governs the final status");
    await j("funder", "POST", "/api/exceptions/evaluate", {});
    assert(q1("SELECT status FROM exceptions WHERE source_key = 'dmv-ctc-shortfall:bl-dmv-2'")?.status === "OPEN",
      "a cost-to-complete shortfall opens its deterministic exception");

    // ================== 11. dispute + legal holds govern the control record ==================
    const disp = (await j("funder", "POST", `/api/projects/${P}/disputes`, {
      subjectType: "DRAW_REQUEST", subjectId: D, disputedAmount: 40000,
      affectedScope: "Plumbing rough-in workmanship (demo)", reason: "Disputed workmanship pending reinspection.",
    }, 201)).dispute;
    rec = await controlRecord();
    assert(rec.lines.every((l) => l.finalEligibilityStatus === "HELD_BY_DISPUTE"),
      "an active dispute on the draw holds EVERY line as HELD_BY_DISPUTE — existing release-hold controls enforced");
    await j("funder", "POST", `/api/disputes/${disp.id}/legal-hold`, { active: "true", reason: "Litigation notice (demo)." }, 200);
    rec = await controlRecord();
    assert(rec.lines.every((l) => l.finalEligibilityStatus === "HELD_BY_LEGAL_HOLD"),
      "a legal hold outranks everything — every line becomes HELD_BY_LEGAL_HOLD");
    await j("compliance", "POST", `/api/disputes/${disp.id}/legal-hold`, { active: "false", reason: "Notice withdrawn (demo)." }, 200);
    await j("funder", "POST", `/api/disputes/${disp.id}/transition`, { to: "UNDER_REVIEW" }, 200);
    await j("funder", "POST", `/api/disputes/${disp.id}/transition`, { to: "READY_FOR_DECISION" }, 200);
    await j("compliance", "POST", `/api/disputes/${disp.id}/resolve`, {
      resolutionType: "RETURN_TO_AUTHORIZED_PARTY",
      reasoning: "Returned to the lender team for the workmanship decision (demo).",
      acknowledged: "true",
    }, 200);
    rec = await controlRecord();
    assert(rec.lines.every((l) => l.finalEligibilityStatus === "HELD_BY_DISPUTE"),
      "a RETURN resolution still holds release eligibility — only RELEASE or CLOSED ends the hold");
    await j("compliance", "POST", `/api/disputes/${disp.id}/close`, { note: "Demo closure after return." }, 200);
    rec = await controlRecord();
    assert(lineOf(rec, "dline-dmv-1").finalEligibilityStatus === "ELIGIBLE_FOR_LENDER_REVIEW",
      "after the dispute CLOSES through its own authorized workflow the eligible line returns to eligible");

    // ================== 12. eligibility never becomes approval ==================
    const drawRow = q1("SELECT status, approved_amount, recommended_amount FROM draw_requests WHERE id = ?", D);
    assert(drawRow.status === "UNDER_REVIEW" && drawRow.approved_amount === null && drawRow.recommended_amount === null,
      "REGRESSION: control-record generation never changed the draw's status, approval, or recommendation");
    assert(q1("SELECT COUNT(*) c FROM lender_draw_decisions WHERE draw_request_id = ?", D).c === 0,
      "REGRESSION: no lender decision was created by any eligibility evaluation");
    assert(q1("SELECT COUNT(*) c FROM approval_requests WHERE draw_request_id = ?", D).c === 0,
      "REGRESSION: no governance approval request was created automatically");
    const funding = await api("funder", "POST", `/api/draws/${D}/funding`, { fundingMethod: "WIRE" });
    assert(funding.status >= 400,
      "REGRESSION: the existing lender funding gate still refuses an unapproved draw — gates unchanged");

    // ================== 13. tenant isolation + cross-tenant probing ==================
    exec("INSERT INTO organizations (id, name, kind) VALUES ('org-x', 'Unrelated Capital', 'FUNDER')");
    exec("INSERT INTO users (id, organization_id, name, role, title) VALUES ('user-x', 'org-x', 'Xavier Test', 'FUNDER_REP', 'Outsider')");
    await signIn("outsider", "user-x");
    const probes = [
      ["GET", `/api/projects/${P}/compliance`],
      ["GET", `/api/draws/${D}/control-record`],
      ["POST", "/api/permits/permit-dmv-bldg/basis", { jurisdiction: "x", permittingAuthority: "x", permitNumber: "x", permitType: "x", permitStatus: "ISSUED", governingBasis: "CURRENT_CODE", verificationMethod: "OTHER" }],
      ["POST", "/api/permit-basis/pbv-dmv-bldg-1/finalize"],
      ["POST", "/api/transition-rules/trr-dmv-1/determine", { eligibility: "NOT_ELIGIBLE", governingInterpretation: "x" }],
      ["POST", "/api/line-requirements/lir-dmv-1/status", { toStatus: "UNKNOWN" }],
      ["POST", `/api/projects/${P}/source-verifications`, { officialService: "x", searchCriteria: "y", lookupAt: "2026-07-20T10:00:00.000Z", resultStatus: "VERIFIED_MATCH", verificationMethod: "OTHER" }],
      ["POST", `/api/projects/${P}/cost-to-complete`, { budgetLineId: "bl-dmv-1", estimatedCostToComplete: 1, sourceOfEstimate: "s", estimateDate: "2026-07-20", confidence: "LOW" }],
    ];
    for (const [method, p, body] of probes) {
      const res = await api("outsider", method, p, body);
      if (res.status !== 404) fail(`outsider ${method} ${p} -> ${res.status} (expected tenant-safe 404)`);
    }
    pass("every DMV read and mutation is a tenant-safe 404 for an unrelated organization");
    const ghost = await api("outsider", "GET", "/api/draws/no-such-draw/control-record");
    assert(ghost.status === 404, "a nonexistent record returns the SAME 404 — no existence disclosure");
    assert((await page("outsider", `/project/${P}/compliance`)).status === 404 &&
      (await page("outsider", `/draw/${D}/control`)).status === 404,
      "the compliance and draw-control pages are tenant-safe 404s for outsiders");

    // ================== 14. audit package + UI surfaces ==================
    const apGen = await j("funder", "POST", `/api/projects/${P}/audit-packages`, {}, 201);
    const apId = apGen.auditPackage?.id ?? apGen.package?.id ?? apGen.id;
    const apDl = await fetch(`${BASE}/audit-packages/${apId}/download`, { headers: { cookie: jars.funder } });
    const apZip = readZip(Buffer.from(await apDl.arrayBuffer()));
    assert(Boolean(apZip["13_dmv_compliance/permit-basis-register.csv"]) &&
      Boolean(apZip["13_dmv_compliance/dmv-summary.json"]) &&
      Boolean(apZip["13_dmv_compliance/source-verifications.csv"]),
      "the project audit package carries the 13_dmv_compliance registers");
    const apGenR47 = await j("funder", "POST", "/api/projects/proj-r47/audit-packages", {}, 201);
    const apIdR47 = apGenR47.auditPackage?.id ?? apGenR47.package?.id ?? apGenR47.id;
    const apZipR47 = readZip(Buffer.from(await (await fetch(`${BASE}/audit-packages/${apIdR47}/download`, { headers: { cookie: jars.funder } })).arrayBuffer()));
    assert(!Object.keys(apZipR47).some((n) => n.startsWith("13_dmv_compliance/")),
      "a project without DMV records gets NO DMV section — existing packages unchanged");

    const compPage = await page("funder", `/project/${P}/compliance`);
    assert(compPage.status === 200 && compPage.html.includes("Governing Code and Permit Basis") &&
      compPage.html.includes(SCOPE_NOTE.slice(0, 60)),
      "the project compliance workspace renders with the scope statement");
    const ctrlPage = await page("funder", `/draw/${D}/control`);
    assert(ctrlPage.status === 200 && ctrlPage.html.includes("Eligible for lender review — not automatically approved.") &&
      ctrlPage.html.includes("Contractor-reported") && ctrlPage.html.includes("inspector"),
      "the Draw Control page shows the prominent non-approval wording and separates the reporting sources");
    assert(ctrlPage.html.includes("ELIGIBLE") && ctrlPage.html.includes("reason"),
      "the Draw Control page lists explicit per-line reason codes");

    // ================== 15. banking + settlement non-mutation ==================
    assert(q1("SELECT COUNT(*) c FROM payment_instructions").c ===
      Number(baseline.payment_instructions.split(":")[1]),
      "REGRESSION: no payment instruction was created by any DMV operation");
    assert(q1("SELECT COUNT(*) c FROM mock_provider_ledger").c ===
      Number(baseline.mock_provider_ledger.split(":")[1]),
      "REGRESSION: no provider/settlement event was generated");
    assertSnapshotEqual(baseline, bankingSnapshot(),
      "REGRESSION: every banking and financial table is byte-for-byte unchanged through the entire DMV lifecycle");

    console.log(`\nAll ${passed} DMV draw-control checkpoints passed.`);
  } finally {
    try { db.close(); } catch {}
    server.kill();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
