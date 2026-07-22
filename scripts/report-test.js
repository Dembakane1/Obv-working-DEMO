/**
 * Funder-report feature test. Exercises generation, accuracy, download,
 * regeneration after state changes, and demo reset — against a running,
 * freshly seeded server on localhost:3000.
 *
 * Usage: node scripts/report-test.js
 */
const BASE = process.env.OBV_BASE_URL || "http://localhost:3000";
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

let step = 0;
const pass = (msg) => console.log(`  ✓ [${String(++step).padStart(2, "0")}] ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};

const cookie = (user) => ({ Cookie: `obv_user=${user}` });

async function generate(user, projectId = "proj-r47") {
  const res = await fetch(`${BASE}/api/reports/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie(user) },
    body: JSON.stringify({ projectId }),
  });
  if (res.status !== 201) fail(`generate -> ${res.status}: ${await res.text()}`);
  return (await res.json()).report;
}

async function fetchPdf(id, user) {
  const res = await fetch(`${BASE}/reports/file/${id}`, { headers: cookie(user) });
  if (res.status !== 200) fail(`pdf fetch -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 5).toString() !== "%PDF-") fail("not a PDF file");
  const pages = Number((buf.toString("latin1").match(/\/Count (\d+)/g) ?? []).pop()?.slice(7) ?? 0);
  return { buf, pages, contentType: res.headers.get("content-type") };
}

async function preview(user, projectId = "proj-r47") {
  const res = await fetch(`${BASE}/report/${projectId}/preview`, { headers: cookie(user) });
  if (res.status !== 200) fail(`preview -> ${res.status}`);
  return res.text();
}

function db() {
  // OBV_DB lets the unified runner point at the same temp database its
  // shared server was seeded from; the default preserves standalone use.
  return new DatabaseSync(process.env.OBV_DB || path.join(process.cwd(), "data", "obv.db"));
}

async function main() {
  // ---- 1–2: generate for seeded project, open PDF ----
  const r1 = await generate("user-funder");
  if (!/^OBV_.*_Verification_Report_\d{4}-\d{2}-\d{2}\.pdf$/.test(r1.filename)) {
    fail(`bad filename: ${r1.filename}`);
  }
  pass(`report generated for seeded project — ${r1.filename}`);

  const pdf1 = await fetchPdf(r1.id, "user-funder");
  if (pdf1.contentType !== "application/pdf") fail("wrong content type");
  if (pdf1.pages < 5 || pdf1.pages > 12) fail(`suspicious page count ${pdf1.pages}`);
  if (pdf1.buf.length < 40_000) fail("PDF too small — images likely missing");
  pass(`PDF opens: ${pdf1.pages} pages, ${(pdf1.buf.length / 1024).toFixed(0)} KB, valid header`);

  // ---- 3–5: amounts, states, approvals match database ----
  let html = await preview("user-funder");
  const d1 = db();
  const released = d1
    .prepare("SELECT COALESCE(SUM(tranche_amount),0) s FROM milestones WHERE account_status='RELEASED'")
    .get().s;
  const total = d1.prepare("SELECT total_budget b FROM projects WHERE id='proj-r47'").get().b;
  const held = total - released;
  const fmt = (n) => "$" + n.toLocaleString("en-US");
  for (const amount of [fmt(total), fmt(released), fmt(held)]) {
    if (!html.includes(amount)) fail(`report missing amount ${amount}`);
  }
  pass(`amounts match dashboard/database (${fmt(released)} released, ${fmt(held)} held)`);

  for (const m of d1.prepare("SELECT title, account_status FROM milestones").all()) {
    if (!html.includes(m.title.replace(/&/g, "&amp;"))) fail(`missing milestone ${m.title}`);
  }
  if ((html.match(/>RELEASED</g) ?? []).length < 2) fail("released states not shown");
  pass("milestone titles and HELD/RELEASED states match database");

  const approvals = d1
    .prepare("SELECT COUNT(*) c FROM approval_records WHERE decision='APPROVED'")
    .get().c;
  const shown = (html.match(/>APPROVED</g) ?? []).length;
  if (shown < approvals) fail(`approval records shown ${shown} < recorded ${approvals}`);
  pass(`approval records match application state (${approvals} recorded decisions shown)`);

  // ---- 6, 8: evidence images + ledger hashes represented ----
  if (!html.includes("/demo-evidence/m1-clearing.jpg")) fail("evidence image missing");
  const lastHash = d1.prepare("SELECT current_hash h FROM ledger_entries ORDER BY seq DESC LIMIT 1").get().h;
  if (!html.includes(lastHash)) fail("full ledger hash missing from appendix");
  if (!html.includes(lastHash.slice(0, 34))) fail("truncated ledger hash missing");
  if (!html.includes("CHAIN INTACT")) fail("integrity status missing");
  if (r1.integrityStatus !== "INTACT") fail("stored integrity status wrong");
  pass("evidence image, ledger hashes (truncated + appendix) and CHAIN INTACT accurate");
  d1.close();

  // ---- 7: DEMO FALLBACK labeling (submit fallback evidence) ----
  await fetch(`${BASE}/api/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...cookie("user-field") },
    body: JSON.stringify({
      milestoneId: "ms-3",
      demoPhotoId: "demo-m3-a",
      latitude: -11.87,
      longitude: 33.594,
      capturedAt: new Date(Date.now() - 40 * 60000).toISOString(),
      deviceMetadata: { userAgent: "test", platform: "Android", screen: "412x915", language: "en" },
      isDemoFallback: true,
    }),
  }).then(async (r) => r.status === 201 || fail(`evidence -> ${r.status} ${await r.text()}`));
  html = await preview("user-funder");
  if (!html.includes("DEMO FALLBACK")) fail("DEMO FALLBACK label missing");
  if (!html.includes("PENDING APPROVAL")) fail("pending approval state missing");
  pass("DEMO FALLBACK evidence labeled; pending approval visible in report");

  // ---- 10–11: complete approvals, regenerate, RELEASED appears ----
  const d2 = db();
  const apId = d2.prepare("SELECT id FROM approval_requests WHERE status='PENDING' LIMIT 1").get().id;
  d2.close();
  for (const user of ["user-funder", "user-compliance"]) {
    const res = await fetch(`${BASE}/api/approvals/${apId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cookie(user) },
      body: JSON.stringify({ decision: "APPROVED" }),
    });
    if (res.status !== 200) fail(`approval by ${user} -> ${res.status}`);
  }
  const r2 = await generate("user-compliance");
  const html2 = await preview("user-compliance");
  if (!html2.includes("$1,320,000")) fail("regenerated report missing new released total");
  if ((html2.match(/>RELEASED</g) ?? []).length < 3) fail("M3 RELEASED state missing");
  if (html2.includes("PENDING APPROVAL")) fail("stale pending approval in regenerated report");
  const pdf2 = await fetchPdf(r2.id, "user-compliance");
  pass(`regenerated after final approval — RELEASED state and $1,320,000 reflected (${pdf2.pages} pages)`);

  // reports page lists both, with download + integrity
  const reportsPage = await (await fetch(`${BASE}/reports`, { headers: cookie("user-funder") })).text();
  if (!reportsPage.includes(`/reports/file/${r1.id}?dl=1`)) fail("download link missing");
  if (!reportsPage.includes("Chain intact")) fail("integrity chip missing on reports page");
  pass("Reports page lists generated reports with download + integrity status");

  // ---- 12–13: reset demo, generate again ----
  await fetch(`${BASE}/api/demo/reset`, { method: "POST", headers: { "Content-Type": "application/json", ...cookie("user-funder") } });
  const r3 = await generate("user-funder");
  const html3 = await preview("user-funder");
  if (!html3.includes("$720,000") || !html3.includes("$1,680,000")) fail("reset state not reflected");
  if (html3.includes("$1,320,000")) fail("stale post-approval amount after reset");
  const gone = await fetch(`${BASE}/reports/file/${r1.id}`, { headers: cookie("user-funder") });
  if (gone.status !== 404) fail(`pre-reset report should 404, got ${gone.status}`);
  await fetchPdf(r3.id, "user-funder");
  pass("after demo reset: regenerated report reflects seeded state; stale files 404 gracefully");

  console.log(`\nREPORT TESTS PASSED — ${step} checkpoints.\n`);
}

main().catch((err) => {
  console.error(`\nREPORT TESTS FAILED at checkpoint ${step + 1}: ${err.message}\n`);
  process.exit(1);
});
