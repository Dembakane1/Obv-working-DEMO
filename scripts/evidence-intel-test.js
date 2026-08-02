#!/usr/bin/env node
/**
 * Evidence Intelligence test battery.
 *
 * Proves the analysis layer is explainable, advisory-only, provider-
 * neutral, tenant-scoped, and additive:
 *   0. static source guards (append-only signals/events, no writes to
 *      authoritative tables, future-AI DISABLED registry, advisory notice)
 *   1. in-process fixtures + baseline
 *   2. duplicate file detection (same project, cross-project, cross-contractor)
 *   3. metadata analysis (missing metadata as INFO, timestamp inconsistency)
 *   4. OCR extraction (fields + fingerprint) and document intelligence
 *      (duplicate invoice number, reused document)
 *   5. review queue (acknowledge / dismiss / promote-to-exception, guarded)
 *   6. authorization + tenant isolation (FIELD 403, same-404)
 *   7. advisory-only guarantee: analysis changes no authoritative record
 *   8. append-only signal immutability at runtime
 *   9. future-AI engines disabled, no fabricated output
 *  10. frontend rendering + HTTP authorization (separate server)
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = process.cwd();
const DATA_A = fs.mkdtempSync(path.join(os.tmpdir(), "obv-evi-a-"));
const DATA_B = fs.mkdtempSync(path.join(os.tmpdir(), "obv-evi-b-"));
const PORT = 3260;
const BASE = `http://127.0.0.1:${PORT}`;

// The db module freezes DATA_DIR/DB_PATH at load time, so the in-process
// section must point OBV_DATA_DIR at DATA_A BEFORE the first require of any
// dist/ module (repo below). The server section runs in a separate process
// with its own OBV_DATA_DIR=DATA_B, so this assignment does not affect it.
process.env.OBV_DATA_DIR = DATA_A;

let passed = 0;
const pass = (m) => { passed += 1; console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`); };
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); throw new Error(m); };
const assert = (cond, m) => (cond ? pass(m) : fail(m));

function seed(dir) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: dir }, stdio: "ignore",
  });
  if (r.status !== 0) fail("seed failed");
}

// ------------------------------------------------------------ section 0

function staticGuards() {
  console.log("\n== 0. Static source guards ==");
  const readSrc = (p) =>
    fs.readFileSync(path.join(ROOT, p), "utf8").split("\n").filter((l) => !/^import type /.test(l)).join("\n");
  const files = [
    "src/server/services/evidenceIntel/core.ts",
    "src/server/services/evidenceIntel/metadata.ts",
    "src/server/services/evidenceIntel/ocr.ts",
    "src/server/services/evidenceIntel/detectors.ts",
    "src/server/services/evidenceIntel/scoring.ts",
    "src/server/services/evidenceIntel/futureAi.ts",
    "src/server/services/evidenceIntel/analyze.ts",
    "src/server/services/evidenceIntel/review.ts",
    "src/server/services/evidenceIntel/dashboard.ts",
    "src/server/services/evidenceIntel/analytics.ts",
    "src/server/services/evidenceIntel/index.ts",
    "src/server/db/evidenceIntelRepo.ts",
    "src/server/http/evidenceIntelRoutes.ts",
  ];
  const combined = files.map(readSrc).join("\n");
  // The layer must never WRITE the authoritative tables.
  assert(
    !/(INSERT INTO|UPDATE|DELETE FROM)\s+(evidence_items|verifications|ledger_entries|draw_documents|permits|approval_requests|approval_records|virtual_account_events|banking_events)\b/.test(combined),
    "evidence-intelligence layer writes to NO authoritative table"
  );
  assert(
    !/insertEvidence|insertVerification|insertLedgerEntry|insertDrawDocument|releaseTranche|processApprovalDecision/.test(combined),
    "layer never calls an evidence/verification/ledger/document/release write path"
  );

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
  const allSrc = walk(path.join(ROOT, "src")).map((p) => fs.readFileSync(p, "utf8")).join("\n");
  assert(
    !/UPDATE\s+evidence_signals|DELETE\s+FROM\s+evidence_signals/.test(allSrc),
    "evidence_signals is append-only across the entire codebase"
  );
  assert(
    !/UPDATE\s+evidence_review_events|DELETE\s+FROM\s+evidence_review_events/.test(allSrc),
    "evidence_review_events is append-only across the entire codebase"
  );
  assert(
    !/INSERT INTO\s+evidence_ai_engines/.test(allSrc),
    "future-AI readiness registry has no write path anywhere"
  );

  const schema = readSrc("src/server/db/index.ts");
  for (const t of [
    "evidence_analysis_runs", "evidence_signals", "evidence_metadata_facts",
    "ocr_extractions", "ocr_fields", "evidence_review_queue", "evidence_review_events", "evidence_ai_engines",
  ]) assert(schema.includes(`CREATE TABLE IF NOT EXISTS ${t}`), `schema declares ${t}`);
  assert(
    /status TEXT NOT NULL DEFAULT 'DISABLED' CHECK \(status IN \('DISABLED'\)\)/.test(schema),
    "future-AI engines are constrained DISABLED at the database level"
  );
  const core = readSrc("src/server/services/evidenceIntel/core.ts");
  assert(/never approves a draw, rejects evidence, releases funds/i.test(core), "advisory-only notice is defined");
  const ocr = readSrc("src/server/services/evidenceIntel/ocr.ts");
  assert((ocr.match(/disabledProvider\("/g) ?? []).length === 3, "three OCR vendor adapters exist as disabled boundaries");
  const futureAi = readSrc("src/server/services/evidenceIntel/futureAi.ts");
  assert(/return false/.test(futureAi) && /EvidenceIntelError\("Not found", 404\)/.test(futureAi),
    "future engines refuse activation with a non-disclosing 404");
  const routes = readSrc("src/server/http/evidenceIntelRoutes.ts");
  assert(/never approves, rejects, or releases/i.test(routes), "routes document the advisory-only rule");
}

// ------------------------------------------------------------ helpers

const repo = require(path.join(ROOT, "dist/server/db/repo"));
let db = null;
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const qa = (sql, ...a) => db.prepare(sql).all(...a);
const tableHash = (t) => crypto.createHash("sha256").update(JSON.stringify(qa(`SELECT * FROM ${t} ORDER BY 1`))).digest("hex");

function makeEvidence(milestoneId, hash, over = {}) {
  const e = {
    id: repo.newId(),
    milestoneId,
    userId: "user-funder",
    photoPath: "/demo-evidence/x.jpg",
    latitude: 40.0,
    longitude: -74.0,
    capturedAt: "2026-03-01T10:00:00.000Z",
    uploadedAt: "2026-03-01T10:05:00.000Z",
    deviceMetadata: { userAgent: "test", platform: "test", screen: "1x1", language: "en" },
    hash,
    previousHash: null,
    isDemoFallback: true,
    ...over,
  };
  repo.insertEvidence(e);
  return e;
}
function makeDoc(drawRequestId, over = {}) {
  const d = {
    id: repo.newId(),
    drawRequestId,
    requirementId: null,
    lineItemId: null,
    docType: "CONTRACTOR_INVOICE",
    title: "Invoice",
    filePath: null,
    note: null,
    status: "RECEIVED",
    expiresAt: null,
    uploadedByUserId: "user-funder",
    receivedAt: "2026-03-01T10:00:00.000Z",
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNote: null,
    vendor: "Acme Builders",
    invoiceNumber: "INV-100",
    amount: 5000,
    ...over,
  };
  repo.insertDrawDocument(d);
  return d;
}

// ---------------------------------------------------------------- main

let server = null;

async function main() {
  staticGuards();

  console.log("\n== 1. Fixtures + baseline (in-process) ==");
  seed(DATA_A);
  process.env.OBV_DATA_DIR = DATA_A;
  const ei = require(path.join(ROOT, "dist/server/services/evidenceIntel"));
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(DATA_A, "obv.db"));

  const funder = repo.getUser("user-funder");   // sees proj-dmv + proj-r47
  const pm = repo.getUser("user-pm");            // sees proj-r47 only
  const dmvpm = repo.getUser("user-dmv-pm");     // sees proj-dmv only
  const field = repo.getUser("user-field");
  const r47ms = repo.listMilestones("proj-r47")[0].id;
  const dmvms = repo.listMilestones("proj-dmv")[0].id;
  const r47draw = repo.listDrawRequestsForProject("proj-r47")[0].id;

  // Give the two projects distinct contractor orgs so cross-contractor can fire.
  repo.updateProjectFields("proj-r47", { contractorOrgId: "org-crra" });
  repo.updateProjectFields("proj-dmv", { contractorOrgId: "org-dmv-borrower" });

  const dupHash = "dup" + crypto.randomBytes(20).toString("hex");
  makeEvidence(r47ms, dupHash);                          // r47 #1
  makeEvidence(r47ms, dupHash);                          // r47 #2 (same project -> DUPLICATE_FILE base)
  makeEvidence(dmvms, dupHash);                          // dmv (cross-project + cross-contractor)
  const badTime = makeEvidence(r47ms, "t" + crypto.randomBytes(20).toString("hex"), {
    capturedAt: "2026-03-02T12:00:00.000Z", uploadedAt: "2026-03-02T10:00:00.000Z", // captured after upload
  });
  const noGps = makeEvidence(r47ms, "g" + crypto.randomBytes(20).toString("hex"), { latitude: null, longitude: null });
  // Two byte-identical invoices: identical OCR fingerprint (an INVOICE kind ->
  // DUPLICATE_INVOICE) and a shared invoice number (-> DUPLICATE_INVOICE_NUMBER).
  makeDoc(r47draw, { invoiceNumber: "INV-777", vendor: "Acme" });
  makeDoc(r47draw, { invoiceNumber: "INV-777", vendor: "Acme" });
  // Two byte-identical generic documents (a kind with no specialized duplicate
  // category) exercise the fallback REUSED_DOCUMENT signal by fingerprint alone.
  makeDoc(r47draw, { docType: "CHANGE_ORDER_SUPPORT", vendor: "Reuse Co", invoiceNumber: null, amount: 1200, title: "Change order backup" });
  makeDoc(r47draw, { docType: "CHANGE_ORDER_SUPPORT", vendor: "Reuse Co", invoiceNumber: null, amount: 1200, title: "Change order backup" });
  pass("fixtures inserted (duplicate photo across projects/contractors, bad timestamp, no-GPS, duplicate invoices, reused generic doc)");

  const PRIMARY = [
    "evidence_items", "verifications", "ledger_entries", "milestones", "draw_requests",
    "draw_documents", "projects", "approval_requests", "approval_records", "permits", "budget_lines",
  ];
  const baseline = {};
  for (const t of PRIMARY) baseline[t] = tableHash(t);
  const exceptionsBefore = q1("SELECT COUNT(*) AS c FROM exceptions").c;
  pass("authoritative-record baseline captured (after fixtures, before analysis)");

  // ------------------------------------------------------------ section 2-4
  console.log("\n== 2-4. Analysis produces explainable findings ==");
  const run = ei.analyzePortfolio(funder, "ON_DEMAND");
  assert(run.run.status === "COMPLETED" && run.signals > 0, `analysis completed with ${run.signals} findings`);
  const cats = new Set(qa("SELECT DISTINCT category AS c FROM evidence_signals").map((r) => r.c));
  assert(cats.has("DUPLICATE_FILE") || cats.has("CROSS_PROJECT_DUPLICATE") || cats.has("CROSS_CONTRACTOR_DUPLICATE"),
    "duplicate-photo detection fired");
  assert(cats.has("CROSS_CONTRACTOR_DUPLICATE"), "cross-contractor duplicate detected (identical photo, two contractors)");
  assert(cats.has("TIMESTAMP_INCONSISTENCY"), "metadata engine flagged capture-after-upload");
  assert(cats.has("MISSING_METADATA"), "missing metadata surfaced as an advisory (INFO)");
  assert(cats.has("DUPLICATE_INVOICE_NUMBER"), "duplicate invoice number detected");
  assert(cats.has("DUPLICATE_INVOICE"), "identical invoice content (OCR fingerprint) detected as a duplicate invoice");
  assert(cats.has("REUSED_DOCUMENT"), "reused generic document (identical OCR fingerprint) detected");
  // Every signal is explainable.
  const sample = qa("SELECT * FROM evidence_signals LIMIT 50");
  assert(sample.every((s) => s.explanation && s.recommendation && s.confidence != null && s.title),
    "every finding carries an explanation, recommendation, confidence, and title");
  // Missing-metadata is INFO severity (never fraud).
  const mm = q1("SELECT severity AS s FROM evidence_signals WHERE category='MISSING_METADATA' LIMIT 1");
  assert(mm && mm.s === "INFO", "missing metadata is INFO severity, not an accusation");

  // OCR extraction + fields + fingerprint.
  const ocrRows = qa("SELECT * FROM ocr_extractions");
  assert(ocrRows.length > 0 && ocrRows.every((e) => e.fingerprint), "OCR extractions recorded with fingerprints");
  const invField = q1("SELECT * FROM ocr_fields WHERE field_key='INVOICE_NUMBER' AND normalized_value='inv777' LIMIT 1");
  assert(Boolean(invField), "OCR extracted and normalized the invoice number field");

  // ------------------------------------------------------------ section 5
  console.log("\n== 5. Review queue + reviewer actions ==");
  const queue = ei.listQueue(funder);
  assert(queue.length > 0, `actionable findings enqueued (${queue.length})`);
  assert(queue.every((i) => i.severity !== "INFO"), "INFO findings are not queued (kept out of the actionable queue)");
  const target = queue.find((i) => i.status === "OPEN");
  const ack = ei.acknowledge(funder, target.id, "looking into it");
  assert(ack.status === "ACKNOWLEDGED", "reviewer can acknowledge a finding");
  const promo = ei.promote(funder, target.id, "confirmed duplicate");
  assert(promo.item.status === "PROMOTED" && promo.exception && promo.exception.id, "reviewer promotes a finding into a governed exception");
  assert(q1("SELECT COUNT(*) AS c FROM exceptions").c === exceptionsBefore + 1, "exactly one governed exception created by promotion");
  let reDismiss = null;
  try { ei.dismiss(funder, target.id, "x"); } catch (e) { reDismiss = e; }
  assert(reDismiss && /promoted/i.test(reDismiss.message), "a promoted finding cannot then be dismissed");
  // A separate OPEN item can be dismissed.
  const other = ei.listQueue(funder, "OPEN")[0];
  if (other) { const d = ei.dismiss(funder, other.id, "not a concern"); assert(d.status === "DISMISSED", "reviewer can dismiss an open finding"); }
  else pass("no second open item to dismiss (acceptable)");

  // ------------------------------------------------------------ section 6
  console.log("\n== 6. Authorization + tenant isolation ==");
  let fieldErr = null;
  try { ei.evidenceIntelDashboard(field); } catch (e) { fieldErr = e; }
  assert(fieldErr && fieldErr.statusCode === 403, "FIELD role cannot view Evidence Intelligence (403)");
  // dmv-pm sees only proj-dmv; a proj-r47 finding is same-404 to them.
  const r47Item = ei.listQueue(funder).find((i) => i.projectId === "proj-r47");
  let crossErr = null;
  try { ei.queueItemDetail(dmvpm, r47Item.id); } catch (e) { crossErr = e; }
  assert(crossErr && crossErr.statusCode === 404, "a queue item on a project outside the caller's access is a plain 404");
  let analyzeErr = null;
  try { ei.analyzeProject(dmvpm, "proj-r47"); } catch (e) { analyzeErr = e; }
  assert(analyzeErr && analyzeErr.statusCode === 404, "analyzing a project the caller cannot see is a plain 404");
  // dmv-pm's own dashboard must not contain proj-r47 signals.
  const dmvSignals = ei.evidenceIntelDashboard(dmvpm).recentSignals;
  assert(dmvSignals.every((s) => s.projectId !== "proj-r47"), "another tenant's dashboard never shows this project's findings");

  // ------------------------------------------------------------ section 7
  console.log("\n== 7. Advisory-only: authoritative records untouched by analysis ==");
  // Re-run analysis; the only governed change since baseline is the ONE
  // promotion exception, which lives in the exceptions table (excluded).
  ei.analyzePortfolio(funder, "REANALYZE");
  for (const t of PRIMARY) {
    assert(baseline[t] === tableHash(t), `${t} byte-identical after analysis (never authored)`);
  }

  // ------------------------------------------------------------ section 8
  console.log("\n== 8. Append-only signal immutability ==");
  const before = qa("SELECT * FROM evidence_signals ORDER BY id");
  ei.analyzePortfolio(funder, "REANALYZE");
  const after = qa("SELECT * FROM evidence_signals ORDER BY id");
  const byId = new Map(after.map((s) => [s.id, JSON.stringify(s)]));
  assert(before.every((s) => byId.get(s.id) === JSON.stringify(s)), "no existing signal was modified (idempotent re-analysis)");
  assert(after.length >= before.length, "the signal log only ever grows");

  // ------------------------------------------------------------ section 9
  console.log("\n== 9. Future-AI engines disabled ==");
  assert(ei.futureAiReadiness().enabled === false, "future-AI readiness reports disabled");
  assert(ei.futureAiReadiness().catalog.length === 7, "seven future engine capabilities are declared");
  assert(q1("SELECT COUNT(*) AS c FROM evidence_ai_engines").c === 0, "the future-AI registry is empty (no write path ran)");
  let engErr = null;
  try { ei.runFutureEngine("COMPUTER_VISION", "x"); } catch (e) { engErr = e; }
  assert(engErr && engErr.statusCode === 404, "activating a future engine refuses with a non-disclosing 404");

  db.close();

  // ------------------------------------------------------------ section 10
  console.log("\n== 10. Frontend rendering + HTTP authorization ==");
  seed(DATA_B);
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_B, PORT: String(PORT), OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo" },
    stdio: "ignore",
  });
  let healthy = false;
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { healthy = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!healthy) fail("server did not become healthy");
  pass("server healthy");

  const signIn = async (userId) => {
    const r = await fetch(`${BASE}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }), redirect: "manual",
    });
    return r.headers.getSetCookie()[0].split(";")[0];
  };
  const cookie = await signIn("user-pm");
  const fieldCookie = await signIn("user-field");
  const page = async (p, ck) => {
    const r = await fetch(`${BASE}${p}`, { headers: { cookie: ck ?? "", accept: "text/html" }, redirect: "manual" });
    return { status: r.status, html: await r.text() };
  };

  await fetch(`${BASE}/api/evidence-intel/analyze`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" });
  const dash = await page("/evidence-intelligence", cookie);
  assert(dash.status === 200 && /Evidence Intelligence/.test(dash.html), "dashboard page renders");
  assert(/Advisory analysis only/.test(dash.html), "dashboard shows the advisory-only notice");
  assert((await page("/evidence-intelligence/queue", cookie)).status === 200, "review queue page renders");
  assert((await page("/evidence-intelligence/analytics", cookie)).status === 200, "analytics page renders");

  const apiStatus = async (p, ck) => (await fetch(`${BASE}${p}`, { headers: { cookie: ck ?? "" }, redirect: "manual" })).status;
  assert((await apiStatus("/api/evidence-intel/dashboard", fieldCookie)) === 403, "FIELD role gets 403 from the dashboard API");
  assert((await apiStatus("/api/evidence-intel/dashboard")) === 401, "anonymous API access is 401");
  const anon = await page("/evidence-intelligence");
  assert([302, 303].includes(anon.status), "anonymous dashboard page redirects to sign-in");

  console.log(`\nEVIDENCE INTELLIGENCE TESTS PASSED — ${passed} checkpoints.`);
  console.log("EVIDENCE INTELLIGENCE ANALYZES THE RECORD. IT NEVER AUTHORS IT.");
}

main()
  .catch((err) => { console.error(err.stack ?? err); process.exitCode = 1; })
  .finally(() => {
    if (server) server.kill();
    try { fs.rmSync(DATA_A, { recursive: true, force: true }); fs.rmSync(DATA_B, { recursive: true, force: true }); } catch {}
  });
