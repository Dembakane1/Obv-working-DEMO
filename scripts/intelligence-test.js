/**
 * OBV Intelligence page test — verifies the /insights intelligence center
 * against the actual database records: counts must match real rows, the
 * attention state must follow the documented deterministic rules, links
 * must target real records, and honest empty/positive states must render.
 *
 * Requires a running, freshly seeded server on localhost:3000.
 * Usage: node scripts/intelligence-test.js
 */
const BASE = process.env.OBV_BASE_URL || "http://localhost:3000";
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

let step = 0;
const pass = (msg) => console.log(`  ✓ [${String(++step).padStart(2, "0")}] ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};

async function fetchPage(user = "user-funder") {
  const res = await fetch(`${BASE}/insights`, { headers: { Cookie: `obv_user=${user}` } });
  if (res.status !== 200) fail(`/insights -> ${res.status}`);
  return res.text();
}

function db() {
  return new DatabaseSync(path.join(process.cwd(), "data", "obv.db"));
}

async function main() {
  const d = db();
  const html = await fetchPage();

  // ---- 1: page identity + honesty framing ----
  if (!html.includes("OBV Intelligence")) fail("page title missing");
  if (!html.includes("DETERMINISTIC")) fail("deterministic mode chip missing");
  if (/success probability|forecast|predicted/i.test(html)) fail("unsupported predictive claim present");
  pass("page identity present; no predictive/probability claims");

  // ---- 2: summary counts match real records ----
  const activeProjects = d.prepare("SELECT COUNT(*) c FROM projects WHERE status='ACTIVE'").get().c;
  const pendingApprovals = d
    .prepare(
      `SELECT COUNT(*) c FROM approval_requests ar
       JOIN milestones m ON m.id = ar.milestone_id
       JOIN projects p ON p.id = m.project_id
       WHERE ar.status='PENDING' AND p.status='ACTIVE'`
    )
    .get().c;
  const highIssues = d
    .prepare(
      `SELECT COUNT(*) c FROM field_issues
       WHERE severity IN ('HIGH','CRITICAL')
         AND status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS','AWAITING_FIELD_RESPONSE')`
    )
    .get().c;
  const openClars = d
    .prepare("SELECT COUNT(*) c FROM clarification_requests WHERE status IN ('OPEN','REOPENED')")
    .get().c;

  // Summary card markup: <a class="int-stat ..."><span class="is-n">N</span><span class="is-l">Label</span>
  const cardValue = (label) => {
    const re = new RegExp(`<span class="is-n">(\\d+)</span><span class="is-l">${label}</span>`);
    const m = html.match(re);
    if (!m) fail(`summary card "${label}" missing`);
    return Number(m[1]);
  };
  if (cardValue("Active projects") !== activeProjects) fail("active projects count mismatch");
  if (cardValue("Pending approvals") !== pendingApprovals) fail("pending approvals count mismatch");
  if (cardValue("High-severity issues") !== highIssues) fail("high-severity issue count mismatch");
  if (cardValue("Open clarifications") !== openClars) fail("open clarifications count mismatch");
  pass(
    `summary counts match database (${activeProjects} active, ${pendingApprovals} pending approvals, ${highIssues} high issues, ${openClars} clarifications)`
  );

  // ---- 3: verification metrics match verification rows ----
  const totalVerifs = d.prepare("SELECT COUNT(*) c FROM verifications").get().c;
  const verified = d.prepare("SELECT COUNT(*) c FROM verifications WHERE verdict='VERIFIED'").get().c;
  if (!html.includes(`<span class="n">${totalVerifs}</span><span class="l">Submissions</span>`))
    fail("verification submission count mismatch");
  if (!html.includes(`<span class="n">${verified}</span><span class="l">Verified</span>`))
    fail("verified count mismatch");
  const rate = totalVerifs > 0 ? Math.round((verified / totalVerifs) * 100) : null;
  if (rate !== null && !html.includes(`${rate}%`)) fail("verification rate missing");
  pass(`verification metrics match records (${verified}/${totalVerifs} verified)`);

  // ---- 4: no fake projects — every project link resolves to a real row ----
  const projectIds = [...html.matchAll(/href="\/project\/([\w-]+)"/g)].map((m) => m[1]);
  for (const id of projectIds) {
    const row = d.prepare("SELECT id FROM projects WHERE id = ?").get(id);
    if (!row) fail(`page references non-existent project ${id}`);
  }
  pass(`all ${projectIds.length} project references resolve to real rows`);

  // ---- 5: signal links target real records ----
  const issueLinks = [...html.matchAll(/href="\/issue\/([\w-]+)"/g)].map((m) => m[1]);
  for (const id of issueLinks) {
    if (!d.prepare("SELECT id FROM field_issues WHERE id = ?").get(id))
      fail(`signal links to non-existent issue ${id}`);
  }
  const milestoneLinks = [...html.matchAll(/href="\/milestone\/([\w-]+)"/g)].map((m) => m[1]);
  for (const id of milestoneLinks) {
    if (!d.prepare("SELECT id FROM milestones WHERE id = ?").get(id))
      fail(`link to non-existent milestone ${id}`);
  }
  pass("issue and milestone links all resolve to real records");

  // ---- 6: deterministic attention state (seeded: HIGH issue -> AT RISK) ----
  if (highIssues > 0) {
    if (!html.includes("AT RISK")) fail("expected AT RISK health with open high-severity issue");
    if (!html.includes("open high/critical field issue")) fail("attention reason not explained");
  }
  if (!html.includes("How attention levels are computed")) fail("attention rule documentation missing");
  pass("attention level is deterministic and explained on the page");

  // ---- 7: recommendations grounded in real records ----
  const srcIds = [...html.matchAll(/Field issue ([\w-]+)/g)].map((m) => m[1]);
  for (const id of srcIds) {
    if (!d.prepare("SELECT id FROM field_issues WHERE id = ?").get(id))
      fail(`recommendation cites non-existent issue ${id}`);
  }
  if (highIssues > 0 && srcIds.length === 0) fail("high issue exists but no grounded recommendation");
  pass("recommendations cite real source records");

  // ---- 8: provenance honesty ----
  const sources = d.prepare("SELECT DISTINCT source FROM verifications").all().map((r) => r.source);
  for (const s of sources) {
    if (!html.includes(`(${s})`)) fail(`verification provenance ${s} not surfaced`);
  }
  pass(`assessment provenance surfaced (${sources.join(", ") || "none"})`);

  // ---- 9: empty state stays useful after resolving the seeded issue ----
  const resolve = await fetch(`${BASE}/api/issues/issue-1/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "obv_user=user-pm" },
    body: JSON.stringify({ status: "RESOLVED", resolutionSummary: "Test resolution for intelligence empty-state check." }),
  });
  if (resolve.status >= 400) fail(`could not resolve seeded issue -> ${resolve.status}`);
  const html2 = await fetchPage();
  // The calm banner follows the deterministic rule: it renders exactly when
  // zero HIGH and zero MEDIUM signals remain. Resolving the seeded HIGH issue
  // must clear the HIGH count; MEDIUM signals (seeded draw/budget review
  // states) legitimately keep the banner away until they are worked.
  const sevCount = (page, label) => {
    const m = page.match(new RegExp(`<span class="int-sev [a-z]+">(\\d+) ${label}</span>`));
    return m ? Number(m[1]) : 0;
  };
  if (sevCount(html2, "HIGH") !== 0) fail("HIGH signal count not cleared after resolving the seeded issue");
  const calmShown = html2.includes("NO CRITICAL SIGNALS");
  const calmExpected = sevCount(html2, "HIGH") === 0 && sevCount(html2, "MEDIUM") === 0;
  if (calmShown !== calmExpected)
    fail(`calm banner ${calmShown ? "shown" : "missing"} but HIGH+MEDIUM counts say it should ${calmExpected ? "show" : "not show"}`);
  if (!html2.includes("Verification outcomes") || !html2.includes("Governance intelligence"))
    fail("intelligence sections collapsed after issue resolution");
  pass(`resolving the seeded HIGH issue clears HIGH signals; calm banner obeys its rule (${calmShown ? "calm" : `${sevCount(html2, "MEDIUM")} MEDIUM remain`})`);

  // ---- 10: demo reset restores the seeded signal ----
  const reset = await fetch(`${BASE}/api/demo/reset`, {
    method: "POST",
    headers: { Cookie: "obv_user=user-funder" },
  });
  if (reset.status >= 400) fail(`demo reset -> ${reset.status}`);
  const html3 = await fetchPage();
  if (!html3.includes("unresolved-high-issue")) fail("seeded HIGH signal missing after reset");
  pass("demo reset restores the seeded intelligence state");

  d.close();
  console.log(`\nINTELLIGENCE TESTS PASSED — ${step} checkpoints.`);
}

main().catch((err) => {
  console.error(`\nINTELLIGENCE TESTS FAILED at checkpoint ${step + 1}: ${err.message}`);
  process.exit(1);
});
