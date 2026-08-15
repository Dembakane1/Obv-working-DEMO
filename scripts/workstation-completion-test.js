#!/usr/bin/env node
/**
 * Workstation completion regression suite.
 *
 * The flagship surfaces (Executive, Draw Review, Timeline/Twin) already
 * had structural protection in workstation-test.js. This suite protects
 * the COMPLETION: the remaining operational pages — Projects, Evidence,
 * Governance, Project Controls, Reports — now share the same workstation
 * system, and a regression back to "hero header → paragraph → full-width
 * card stack" on any of them fails here.
 *
 * These checkpoints assert design-system ARCHITECTURE (which primitives
 * compose the page), never pixel values and never arbitrary class counts
 * without meaning.
 */
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 3368;
const BASE = `http://localhost:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), "obv-completion-"));

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

let server = null;
const stopServer = () => {
  try { server?.kill("SIGKILL"); } catch { /* already gone */ }
  server = null;
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { stopServer(); process.exit(130); });
}

/** A page renders on the workstation surface with the compact header. */
function assertWorkstationShell(html, label) {
  assert(html.includes('class="page-wrap ws"'), `${label} renders on the full-bleed workstation surface`);
  assert(html.includes('class="ws-head"'), `${label} uses the compact work header, not the old hero header`);
  assert(!/class="page-head"/.test(html), `${label} carries no legacy document page header`);
  assert(html.includes('class="kpi-rail"'), `${label} leads with a KPI rail`);
  assert(html.includes('class="about-view"'), `${label} compresses doctrine into a disclosure instead of deleting it`);
}

async function main() {
  console.log("Workstation completion suite — one product, every operational page");

  let squatter = false;
  try { squatter = (await fetch(`${BASE}/api/health`)).ok; } catch { /* free */ }
  if (squatter) fail(`another process is already serving ${BASE}`);
  if (spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA }, stdio: "ignore",
  }).status !== 0) fail("seed failed");
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...process.env, OBV_DATA_DIR: DATA, PORT: String(PORT),
      OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  const signIn = async (userId) => {
    const res = await fetch(`${BASE}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }), redirect: "manual",
    });
    return res.headers.getSetCookie()[0].split(";")[0];
  };
  const funder = await signIn("user-funder");
  const field = await signIn("user-field");
  const page = async (p, jar = funder) =>
    (await fetch(BASE + p, { headers: { cookie: jar, accept: "text/html" } })).text();

  // ================= 1. Projects — portfolio register =================
  const projects = await page("/projects");
  assertWorkstationShell(projects, "projects");
  assert(projects.includes('class="dtable"'), "the project list is a dense register table, not a stack of project cards");
  assert(!/class="proj-row"/.test(projects), "the old per-project card rows are gone");
  for (const col of ["Project", "Organization", "Stage", "Active draw", "Verified physical", "Released", "Next action"]) {
    assert(projects.includes(`>${col}</th>`), `the register carries a ${col} column`);
  }
  for (const [q, label] of [["attention", "Needs attention"], ["draw", "Active draw"], ["evidence", "Waiting on evidence"], ["approvals", "Waiting on approval"], ["exceptions", "With open exceptions"]]) {
    assert(projects.includes(`value="${q}"`), `filter derives honestly from records: ${label}`);
  }
  assert(
    projects.includes("compared, never merged"),
    "the physical-vs-financial doctrine survives in the disclosure"
  );

  // ================= 2. Project detail — command workspace =============
  const detail = await page("/project/proj-r47");
  assertWorkstationShell(detail, "project detail");
  assert(detail.includes('class="wstabs"'), "project record domains are workspace tabs");
  assert(detail.includes('class="workbench"') && detail.includes('class="wb-rail"'), "the overview is a workbench with an inspector rail");
  for (const tabLabel of ["Milestones", "Evidence", "Approvals", "Ledger", "Budget &amp; Progress"]) {
    assert(detail.includes(tabLabel), `deep detail remains one tab away: ${tabLabel}`);
  }
  assert(detail.includes("Required next action"), "the rail carries the required next action");
  assert(detail.includes("Ledger integrity"), "the rail carries ledger integrity");

  // ================= 3. Evidence Review — queue + workbench ============
  const compliance = await page("/compliance");
  assertWorkstationShell(compliance, "evidence review");
  assert(compliance.includes("Review queue"), "evidence review exposes an operational review queue");
  assert(compliance.includes('class="workbench"'), "evidence review is a workbench (queue + record detail + inspector)");
  assert(
    compliance.includes("Verification state") || compliance.includes("Verification</th>"),
    "the queue reports verification state per record"
  );
  assert(
    /\?focus=/.test(compliance) || compliance.includes("No evidence is awaiting review"),
    "queue rows select a record for detail without leaving the page (or the queue is honestly empty)"
  );
  assert(
    compliance.includes("advisory") || compliance.includes("Advisory"),
    "advisory analysis stays labeled advisory — never authoritative"
  );
  assert(
    compliance.includes("release eligibility") || compliance.includes("Release eligibility"),
    "the review/release boundary doctrine survives"
  );

  // ================= 4. Evidence Ledger — audit register ==============
  const ledger = await page("/ledger");
  assertWorkstationShell(ledger, "evidence ledger");
  assert(ledger.includes('class="dtable"'), "the ledger is a dense audit register, not decorated chain cards");
  assert(!/class="chain-row"/.test(ledger), "the old decorated chain rows are gone");
  for (const col of ["Seq", "Recorded (UTC)", "Record", "Project", "Captured by", "State", "Hash / proof"]) {
    assert(ledger.includes(`>${col}</th>`), `the ledger register carries a ${col} column`);
  }
  assert(ledger.includes("Verify integrity"), "the integrity check action is preserved");
  assert(
    ledger.includes("previous entry") || ledger.includes("previous entry's hash"),
    "the hash-chain doctrine survives"
  );

  // ================= 5. Governance — approvals ========================
  const approvals = await page("/approvals");
  assertWorkstationShell(approvals, "approvals");
  assert(approvals.includes("Approval queue"), "approvals lead with a dense queue register");
  assert(approvals.includes("Awaiting my action"), "the rail distinguishes 'awaiting my action' from the rest");
  assert(approvals.includes("Awaiting second approval"), "dual-control wait state is a first-class number");
  assert(
    approvals.includes("It does NOT authorize") || approvals.includes("does NOT authorize"),
    "what an approval does NOT authorize is stated on the work surface"
  );
  assert(
    approvals.includes("not settlement") || approvals.includes("moves no funds"),
    "the approval ≠ settlement doctrine survives"
  );

  // ================= 6. Governance — exceptions =======================
  const exceptions = await page("/exceptions");
  assertWorkstationShell(exceptions, "exceptions");
  assert(
    exceptions.includes("Exception register") && exceptions.includes("<table"),
    "exceptions are a dense register, not independent exception cards"
  );
  for (const col of ["Severity", "Owner", "Age", "Status", "Next action"]) {
    assert(exceptions.includes(`<th>${col}</th>`), `the exception register carries a ${col} column`);
  }
  assert(exceptions.includes("no exception action can release funds") || exceptions.includes("never rewritten"),
    "the exception/source-truth doctrine survives");

  // ================= 7. Project Controls — budget =====================
  const budget = await page("/budget");
  assertWorkstationShell(budget, "budget & progress");
  assert(budget.includes('class="dtable"'), "the portfolio comparison is a dense financial-control table");
  assert(
    budget.includes("Financial vs verified physical") || budget.includes("verified physical"),
    "financial and verified physical progress stay distinct, compared columns"
  );
  const projBudget = await page("/project/proj-r47/budget");
  assert(projBudget.includes('class="kpi-rail"'), "the project budget page carries the financial KPI rail");
  for (const label of ["Original budget", "Approved changes", "Current budget", "Verified physical"]) {
    assert(projBudget.includes(label), `financial KPI present: ${label}`);
  }
  assert(
    projBudget.includes("never merged"),
    "the two-measurements doctrine survives on the project budget page"
  );

  // ================= 8. Project Controls — change orders ==============
  const cos = await page("/change-orders");
  assertWorkstationShell(cos, "change orders");
  assert(cos.includes("Change order register") && cos.includes("<table"), "change orders are a dense register");
  for (const col of ["CO #", "Requested", "Approved", "Status", "Age", "Next action"]) {
    assert(cos.includes(`<th>${col}</th>`), `the CO register carries a ${col} column`);
  }
  assert(cos.includes("modifies nothing"), "the change-control doctrine survives");

  // ================= 9. Reports — document center =====================
  const reports = await page("/reports");
  assertWorkstationShell(reports, "reports");
  assert(reports.includes("ws-row-3"), "the three generators sit side by side, not stacked");
  assert(reports.includes("Generated reports"), "the generated-report register is present");
  assert(reports.includes("immutable once ready") || reports.includes("Audit package register") || reports.includes("SUPERSEDED"),
    "package immutability language survives");
  assert(reports.includes("Download"), "downloads remain available");

  // ================= 10. Evidence workspace siblings ==================
  const ei = await page("/evidence-intelligence");
  assert(ei.includes('class="ws-head"') && ei.includes('class="kpi-rail"'), "evidence intelligence joins the workstation system");
  assert(/advisor/i.test(ei), "evidence intelligence remains labeled advisory");
  const os_ = await page("/official-sources");
  assert(os_.includes('class="ws-head"') && os_.includes('class="kpi-rail"'), "official sources joins the workstation system");
  assert(os_.includes("permit official-record coverage") || os_.includes("Permit official-record coverage"),
    "official-source coverage wording is preserved");
  assert(/human review/i.test(os_), "retrieved records remain evidence for human review, never automatic authority");

  // ================= 11. flagship pages untouched =====================
  const exec = await page("/executive");
  assert(exec.includes('class="kpi-rail"') && exec.includes("ws-row-3") && exec.includes("ws-row-5"),
    "the Executive Command Center composition is unchanged");
  const twin = await page("/timeline/twin/proj-r47");
  assert(twin.includes('class="splitws'), "the Timeline/Twin split workspace is unchanged");

  // ================= 12. routes and authorization unchanged ===========
  for (const p of ["/projects", "/compliance", "/ledger", "/approvals", "/exceptions", "/budget", "/change-orders", "/reports", "/evidence-intelligence", "/official-sources"]) {
    const res = await fetch(BASE + p, { headers: { cookie: funder, accept: "text/html" } });
    assert(res.status === 200, `route unchanged: ${p} answers 200`);
  }
  const fieldExec = await fetch(`${BASE}/executive`, { headers: { cookie: field, accept: "text/html" }, redirect: "manual" });
  assert([302, 303, 403, 404].includes(fieldExec.status), `authorization unchanged (FIELD → ${fieldExec.status} on /executive)`);
  const anonProjects = await fetch(`${BASE}/projects`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert([302, 303, 401].includes(anonProjects.status), "anonymous requests still redirect to sign-in");

  // ================= 13. mobile: no desktop 3-column forcing ==========
  // The CSS contract: below the tablet boundary the multi-column rows
  // and the workbench collapse (display:block / single column), and KPI
  // rails become horizontal scrollers. Structural assertions on the
  // stylesheet, matching workstation-test.js's approach.
  const css = await (await fetch(`${BASE}/styles.css`)).text();
  assert(
    /@media \(max-width: 1023px\)[\s\S]{0,2200}\.workbench[^{]*\{[^}]*display: block/.test(css) ||
      /\.workbench, \.splitws, \.ws-row-3, \.ws-row-5, \.ws-row-2 \{ display: block/.test(css),
    "below the tablet boundary the workbench and multi-column rows collapse — no forced 3-column mobile"
  );
  assert(
    /@media \(max-width: 720px\)[\s\S]{0,900}\.kpi-rail \{[\s\S]{0,200}overflow-x: auto/.test(css),
    "mobile KPI rails scroll horizontally instead of stacking"
  );

  console.log(`\nWORKSTATION COMPLETION TESTS PASSED — ${passed} checkpoints.`);
  console.log("Projects, Evidence, Governance, Project Controls and Reports share the workstation system.");
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => {
    stopServer();
    try { rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
  });
