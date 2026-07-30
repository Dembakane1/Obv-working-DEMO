#!/usr/bin/env node
/**
 * Portfolio Intelligence test battery.
 *
 * Proves the executive analytics layer is derived-only, tenant-scoped,
 * advisory-only, and additive:
 *   0. static source guards (no network, no writes outside snapshots,
 *      government foundation has no write path)
 *   1. aggregation matches SQL over the seeded records
 *   2. risk engine: 8 dimensions, determinism, verified-record response
 *   3. contractor / inspector / vendor intelligence from real records
 *   4. forecasting stays separate from actuals
 *   5. fraud detection emits advisory flags only
 *   6. multi-lender isolation with same-404 behavior
 *   7. role gates (FIELD 403, anonymous 401)
 *   8. government architecture present but fully disabled
 *   9. snapshots append-only; executive report generation
 *  10. protected primary records byte-identical after every analytics read
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 3230;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-portfolio-"));
const ROOT = process.cwd();

let passed = 0;
const pass = (m) => {
  passed += 1;
  console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`);
};
const fail = (m) => {
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (cond, m) => (cond ? pass(m) : fail(m));

// ------------------------------------------------------------ http utils

const jars = {};
async function signIn(key, userId) {
  const res = await fetch(`${BASE}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
    redirect: "manual",
  });
  const cookies = res.headers.getSetCookie();
  if (!cookies || cookies.length === 0) fail(`sign-in for ${userId} returned no cookie (${res.status})`);
  jars[key] = cookies[0].split(";")[0];
}
function api(key, method, p, body) {
  return fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", cookie: jars[key] ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
}
async function j(key, method, p, body, expect = 200) {
  const res = await api(key, method, p, body);
  const text = await res.text();
  if (res.status !== expect) fail(`${method} ${p} → ${res.status} (expected ${expect}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
async function page(key, p) {
  const res = await fetch(`${BASE}${p}`, {
    headers: { cookie: jars[key] ?? "", accept: "text/html" },
    redirect: "manual",
  });
  return { status: res.status, html: await res.text(), location: res.headers.get("location") };
}

// ------------------------------------------------------------- db utils

let db = null;
const q1 = (sql, ...args) => db.prepare(sql).get(...args);
const qa = (sql, ...args) => db.prepare(sql).all(...args);
const exec = (sql, ...args) => db.prepare(sql).run(...args);

function tableHash(table) {
  const rows = qa(`SELECT * FROM ${table} ORDER BY 1`);
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
function snapshotTables(tables) {
  const out = {};
  for (const t of tables) {
    try {
      out[t] = tableHash(t);
    } catch {
      out[t] = "missing";
    }
  }
  return out;
}
function assertSnapshotEqual(before, after, label) {
  const diff = Object.keys(before).filter((t) => before[t] !== after[t]);
  assert(diff.length === 0, `${label}${diff.length ? ` (changed: ${diff.join(", ")})` : ""}`);
}

// draw_account_events is deliberately NOT in this list: section 4 inserts
// two synthetic rows into it (in this suite's own disposable database) to
// exercise the unified held/released read model, and section 16 asserts
// those two rows are the ONLY change.
const BANKING_AND_LEDGER = [
  "banking_programs", "project_virtual_accounts", "project_account_holds",
  "payment_instructions", "bank_transactions", "reconciliation_runs",
  "banking_events", "mock_provider_ledger",
  "retainage_events", "virtual_account_events", "ledger_entries",
  "evidence_items", "verifications", "reports", "audit_packages",
  "lender_draw_decisions",
];

function allUserTables() {
  return qa(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'portfolio_snapshots'"
  ).map((r) => r.name);
}

// ------------------------------------------------------------ section 0

function staticGuards() {
  console.log("\n== 0. Static source guards ==");
  const readSrc = (p) =>
    fs
      .readFileSync(path.join(ROOT, p), "utf8")
      .split("\n")
      .filter((line) => !/^import type /.test(line))
      .join("\n");

  const portfolioFiles = [
    "src/server/services/portfolio/context.ts",
    "src/server/services/portfolio/aggregate.ts",
    "src/server/services/portfolio/riskEngine.ts",
    "src/server/services/portfolio/entities.ts",
    "src/server/services/portfolio/forecast.ts",
    "src/server/services/portfolio/fraud.ts",
    "src/server/services/portfolio/summary.ts",
    "src/server/services/portfolio/government.ts",
    "src/server/services/portfolio/snapshots.ts",
    "src/server/services/portfolio/index.ts",
    "src/server/db/portfolioRepo.ts",
    "src/server/http/portfolioRoutes.ts",
  ];
  const combined = portfolioFiles.map(readSrc).join("\n");

  assert(
    !/\bnode:https?\b|fetch\s*\(|axios|XMLHttpRequest|net\.connect|playwright|puppeteer/.test(combined),
    "portfolio layer contains no network or browser primitives"
  );
  assert(
    !/api[_-]?key|apikey|client[_-]?secret|bearer |password\s*[:=]/i.test(combined),
    "portfolio layer contains no credential-shaped strings"
  );
  assert(!/VirtualAccountService/.test(combined), "portfolio layer never references VirtualAccountService");
  assert(
    !/from "\.\.\/banking|from "\.\/banking|services\/banking/.test(combined),
    "portfolio layer never imports the banking services"
  );

  const repoSrc = readSrc("src/server/db/portfolioRepo.ts");
  assert(!/\bUPDATE\s+\w+\s+SET\b/.test(repoSrc), "portfolioRepo contains no UPDATE statement");
  assert(!/\bDELETE\s+FROM\b/.test(repoSrc), "portfolioRepo contains no DELETE statement");
  const insertTargets = [...repoSrc.matchAll(/INSERT INTO\s+(\w+)/g)].map((m) => m[1]);
  assert(
    insertTargets.length > 0 && insertTargets.every((t) => t === "portfolio_snapshots"),
    `portfolioRepo's only INSERT target is portfolio_snapshots (found: ${insertTargets.join(", ")})`
  );

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
  const allSrc = walk(path.join(ROOT, "src"))
    .map((p) => fs.readFileSync(p, "utf8"))
    .join("\n");
  assert(!/INSERT INTO\s+gov_/.test(allSrc), "no source file inserts into any gov_* table");
  assert(
    !/UPDATE\s+gov_|DELETE\s+FROM\s+gov_/.test(allSrc),
    "no source file updates or deletes any gov_* table"
  );
  assert(
    !/UPDATE\s+portfolio_snapshots|DELETE\s+FROM\s+portfolio_snapshots/.test(allSrc),
    "portfolio_snapshots is append-only across the entire codebase"
  );

  const summarySrc = readSrc("src/server/services/portfolio/summary.ts");
  assert(
    summarySrc.includes("does not approve draws"),
    "executive summaries carry the does-not-approve advisory statement"
  );
  const fraudSrc = readSrc("src/server/services/portfolio/fraud.ts");
  assert(fraudSrc.includes("not accusations"), "fraud signals are labeled advisory, not accusations");
  const forecastSrc = readSrc("src/server/services/portfolio/forecast.ts");
  assert(
    forecastSrc.includes("never modify actual project values"),
    "forecasts state they never modify actual project values"
  );
  const riskSrc = readSrc("src/server/services/portfolio/riskEngine.ts");
  assert(riskSrc.includes("RISK_WEIGHTS"), "risk engine documents its dimension weights");
  const govSrc = readSrc("src/server/services/portfolio/government.ts");
  assert(
    govSrc.includes('PortfolioError("Not found", 404)') && govSrc.includes("return false"),
    "government module refuses activation with a nondisclosing 404 and reports disabled"
  );
  const ctxSrc = readSrc("src/server/services/portfolio/context.ts");
  assert(
    /accessibleProjects\(viewer\)/.test(ctxSrc),
    "portfolio context scopes through authz.accessibleProjects (single tenancy source of truth)"
  );
  const indexSrc = readSrc("src/server/services/portfolio/index.ts");
  assert(
    indexSrc.includes('PortfolioError("Project not found", 404)'),
    "project detail lookups apply the same-404 doctrine"
  );

  const schemaSrc = fs.readFileSync(path.join(ROOT, "src/server/db/index.ts"), "utf8");
  for (const table of ["portfolio_snapshots", "gov_portfolios", "gov_programs", "gov_program_links"]) {
    assert(schemaSrc.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `schema declares ${table}`);
  }
  assert(
    /status TEXT NOT NULL DEFAULT 'INACTIVE' CHECK \(status IN \('INACTIVE'\)\)/.test(schemaSrc),
    "gov_* rows are constrained INACTIVE at the database level"
  );
}

// ---------------------------------------------------------------- main

let server = null;

async function main() {
  staticGuards();

  console.log("\n== 1. Boot ==");
  const seed = spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
    stdio: "ignore",
  });
  if (seed.status !== 0) fail("seed failed");
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...process.env,
      OBV_DATA_DIR: DATA_DIR,
      PORT: String(PORT),
      OBV_BANKING_PROVIDER: "mock",
      OBV_BANKING_MODE: "demo",
    },
    stdio: "ignore",
  });
  let healthy = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!healthy) fail("server did not become healthy");
  pass("server healthy");
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(DATA_DIR, "obv.db"));
  const bankingBaseline = snapshotTables(BANKING_AND_LEDGER);
  pass("banking + ledger baseline captured");

  await signIn("funder", "user-funder");
  await signIn("pm", "user-pm");
  await signIn("compliance", "user-compliance");
  await signIn("dmvpm", "user-dmv-pm");
  await signIn("field", "user-field");
  pass("seeded users signed in");

  // ------------------------------------------------------------ section 2
  console.log("\n== 2. Aggregation matches SQL ==");
  const ov = await j("funder", "GET", "/api/portfolio/overview");
  const projCount = q1("SELECT COUNT(*) AS c FROM projects").c;
  assert(ov.totals.totalProjects === projCount, `totalProjects matches SQL (${projCount})`);
  const budgetSum = q1("SELECT SUM(total_budget) AS s FROM projects").s;
  assert(ov.totals.totalBudget === budgetSum, `totalBudget matches SQL (${budgetSum})`);
  const activeCount = q1("SELECT COUNT(*) AS c FROM projects WHERE status='ACTIVE'").c;
  assert(ov.totals.activeProjects === activeCount, "activeProjects matches SQL");
  const held = q1("SELECT COALESCE(SUM(amount),0) AS s FROM virtual_account_events WHERE type='HELD'").s;
  const released = q1("SELECT COALESCE(SUM(amount),0) AS s FROM virtual_account_events WHERE type='RELEASED'").s;
  assert(ov.totals.heldAmount === held, `heldAmount matches account events (${held})`);
  assert(ov.totals.releasedAmount === released, `releasedAmount matches account events (${released})`);
  const paid = q1("SELECT COALESCE(SUM(paid_to_date),0) AS s FROM budget_lines WHERE active=1").s;
  assert(ov.totals.paidToDate === paid, `paidToDate matches budget lines (${paid})`);
  const openExc = q1(
    "SELECT COUNT(*) AS c FROM exceptions WHERE status NOT IN ('RESOLVED','CLOSED','WAIVED')"
  ).c;
  assert(ov.totals.openExceptions === openExc, `openExceptions matches SQL (${openExc})`);
  const inReview = q1(
    "SELECT COUNT(*) AS c FROM draw_requests WHERE status IN ('SUBMITTED','UNDER_REVIEW','CLARIFICATION_REQUIRED','READY_FOR_GOVERNANCE')"
  ).c;
  assert(ov.totals.drawsInReview === inReview, `drawsInReview matches SQL (${inReview})`);
  assert(
    ov.totals.budgetUtilizationPct > 0 && ov.totals.fundingUtilizationPct > 0,
    "utilization percentages computed"
  );
  assert(
    ov.totals.fundingUtilizationPct === Math.round((released / held) * 1000) / 10,
    `funding utilization = released ÷ ever-held governed capital (${ov.totals.fundingUtilizationPct}%)`
  );

  const distSum = (entries) => entries.reduce((a, e) => a + e.count, 0);
  assert(distSum(ov.distributions.byStatus) === projCount, "byStatus distribution covers every project");
  assert(distSum(ov.distributions.byStage) === projCount, "byStage distribution covers every project");
  assert(distSum(ov.distributions.byRisk) === projCount, "byRisk distribution covers every project");
  const dmvState = q1("SELECT state AS s FROM jurisdiction_profiles WHERE project_id='proj-dmv'").s;
  assert(
    ov.distributions.byState.some((e) => e.key === dmvState),
    `byState includes the DMV project's state (${dmvState})`
  );
  assert(
    ov.distributions.byLender.length >= 1 && ov.distributions.byLender[0].count >= 1,
    "byLender distribution resolves a lender for every project"
  );
  assert(Array.isArray(ov.trends.exceptions) && Array.isArray(ov.trends.growth), "trend series present");
  assert(
    ov.trends.growth.length > 0 && ov.trends.growth.at(-1).cumulativeReleased === released,
    "growth series cumulative total equals released capital"
  );

  const filteredState = await j(
    "funder",
    "GET",
    `/api/portfolio/overview?state=${encodeURIComponent(dmvState)}`
  );
  assert(filteredState.totals.totalProjects === 1, "state filter narrows to the DMV project");
  assert(filteredState.totals.totalBudget === 495000, "filtered totals recompute over the filtered set");
  const filteredNone = await j("funder", "GET", "/api/portfolio/overview?status=SUSPENDED");
  assert(filteredNone.totals.totalProjects === 0, "status filter with no matches returns an empty scope");

  const ov2 = await j("funder", "GET", "/api/portfolio/overview");
  const strip = (o) => JSON.stringify({ ...o, generatedAt: null });
  assert(strip(ov2) === strip(ov), "overview is deterministic across calls");

  // ------------------------------------------------------------ section 3
  console.log("\n== 3. Risk engine baseline ==");
  const risk0 = await j("funder", "GET", "/api/portfolio/risk");
  assert(risk0.projects.length === projCount, "risk register covers every accessible project");
  const dims = [
    "financial", "compliance", "schedule", "documentation",
    "inspection", "contractor", "fraud", "operational",
  ];
  for (const p of risk0.projects) {
    const missing = dims.filter((d) => !p.dimensions[d]);
    if (missing.length > 0) fail(`project ${p.projectId} missing dimensions: ${missing.join(",")}`);
    const badScore = dims.filter(
      (d) => p.dimensions[d].score < 0 || p.dimensions[d].score > 100
    );
    if (badScore.length > 0) fail(`project ${p.projectId} has out-of-range scores`);
    if (p.health !== 100 - p.overallRisk) fail(`health must equal 100 - overallRisk for ${p.projectId}`);
  }
  pass("every project scores all 8 dimensions in range with health = 100 − risk");
  const bandFor = (score) =>
    score >= 75 ? "CRITICAL" : score >= 50 ? "ELEVATED" : score >= 25 ? "WATCH" : "STABLE";
  assert(
    risk0.projects.every((p) => p.band === bandFor(p.overallRisk)),
    "bands follow the documented thresholds"
  );
  const attentionIds = new Set(risk0.attention.map((p) => p.projectId));
  const expectedAttention = new Set(
    risk0.projects.filter((p) => p.band === "ELEVATED" || p.band === "CRITICAL").map((p) => p.projectId)
  );
  assert(
    attentionIds.size === expectedAttention.size && [...attentionIds].every((id) => expectedAttention.has(id)),
    "attention queue is exactly the ELEVATED/CRITICAL projects"
  );
  const dmvRisk0 = await j("funder", "GET", "/api/portfolio/project/proj-dmv/risk");
  const fromList = risk0.projects.find((p) => p.projectId === "proj-dmv");
  assert(
    dmvRisk0.overallRisk === fromList.overallRisk,
    "project risk endpoint agrees with the portfolio register"
  );
  const risk0b = await j("funder", "GET", "/api/portfolio/risk");
  assert(strip(risk0b) === strip(risk0), "risk scoring is deterministic across calls");
  assert(
    risk0.methodology && typeof risk0.methodology.weights === "object",
    "methodology (weights + bands) is disclosed with the scores"
  );

  // ------------------------------------------------------------ section 4
  console.log("\n== 4. Synthetic verified records (inserted via SQL into this suite's own database) ==");
  const T = "2026-07-10T12:00:00.000Z";
  exec("INSERT INTO organizations (id, name, kind) VALUES ('org-pi-contractor','Sterling Builders LLC (Demo)','CONTRACTOR')");
  exec("INSERT INTO organizations (id, name, kind) VALUES ('org-pi-lender2','Pinnacle Capital Partners (Demo)','DEVELOPMENT_FINANCE')");
  exec(
    "INSERT INTO users (id, organization_id, name, role, title) VALUES ('user-pi-exec','org-pi-lender2','Dana Whitfield','FUNDER_REP','Chief Credit Officer')"
  );
  exec(
    `INSERT INTO projects (id, organization_id, name, description, location, site_boundary, total_budget, status, project_type)
     VALUES ('proj-pi2','org-pi-lender2','Harbor Point Mixed-Use (Demo Second Lender)','demo','Harbor Point','[]',1000000,'ACTIVE','INFRASTRUCTURE')`
  );
  exec(
    `INSERT INTO milestones (id, project_id, seq, title, requirement, tranche_amount, status, account_status)
     VALUES ('ms-pi2-1','proj-pi2',1,'Foundation','Foundation photo',100000,'NOT_STARTED','HELD')`
  );
  exec(
    `INSERT INTO loan_assets (id, organization_id, project_id, loan_number, primary_contractor_organization_id, lender_organization_id, risk_level, status, created_at, updated_at)
     VALUES ('loan-pi-1','org-cdfc','proj-dmv','LN-2026-0001','org-pi-contractor','org-cdfc','MEDIUM','ACTIVE','${T}','${T}')`
  );
  exec(
    `INSERT INTO project_party_assignments (id, organization_id, project_id, party_organization_id, party_type, active, created_by_user_id, created_at)
     VALUES ('ppa-pi-1','org-cdfc','proj-dmv','org-pi-contractor','CONTRACTOR',1,'user-funder','${T}')`
  );
  // Independent draw inspections (lender-ordered) on the R47 draw.
  exec(
    `INSERT INTO draw_inspections (id, organization_id, project_id, draw_request_id, inspection_type, inspector_display_name, requested_at, scheduled_at, completed_at, status, created_at, updated_at)
     VALUES ('di-pi-1','org-cdfc','proj-r47','draw-1','DRAW_PROGRESS','Alex Rivera, P.E.','2026-07-01T10:00:00.000Z','2026-07-03T10:00:00.000Z','2026-07-05T10:00:00.000Z','ACCEPTED','${T}','${T}')`
  );
  exec(
    `INSERT INTO draw_inspections (id, organization_id, project_id, draw_request_id, inspection_type, inspector_display_name, requested_at, scheduled_at, completed_at, status, created_at, updated_at)
     VALUES ('di-pi-2','org-cdfc','proj-r47','draw-1','DRAW_PROGRESS','Alex Rivera, P.E.','2026-07-06T10:00:00.000Z','2026-07-08T10:00:00.000Z','2026-07-12T10:00:00.000Z','CORRECTION_REQUIRED','${T}','${T}')`
  );
  // Government inspection records (free-text inspector names, never users).
  exec(
    `INSERT INTO jurisdictional_inspections (id, organization_id, project_id, milestone_id, required, status, scheduled_at, completed_at, result, government_inspector_name, created_at, updated_at)
     VALUES ('ji-pi-1','org-cdfc','proj-dmv','ms-dmv-1',1,'PASSED','2026-07-01T09:00:00.000Z','2026-07-02T09:00:00.000Z','PASSED','Inspector J. Whitcomb','${T}','${T}')`
  );
  exec(
    `INSERT INTO jurisdictional_inspections (id, organization_id, project_id, milestone_id, required, status, scheduled_at, completed_at, result, government_inspector_name, correction_due_at, created_at, updated_at)
     VALUES ('ji-pi-2','org-cdfc','proj-dmv','ms-dmv-2',1,'CORRECTIONS_REQUIRED','2026-07-05T09:00:00.000Z','2026-07-06T09:00:00.000Z','CORRECTIONS_REQUIRED','Inspector J. Whitcomb','2026-07-20','${T}','${T}')`
  );
  // Vendor invoice documents, including a deliberate duplicate number.
  exec(
    `INSERT INTO draw_documents (id, draw_request_id, doc_type, title, status, received_at, vendor, invoice_number, amount)
     VALUES ('ddoc-pi-1','draw-1','MATERIAL_INVOICE','Concrete supply invoice','ACCEPTED','2026-07-02T00:00:00.000Z','Acme Concrete Supply','INV-1001',120000)`
  );
  exec(
    `INSERT INTO draw_documents (id, draw_request_id, doc_type, title, status, received_at, vendor, invoice_number, amount)
     VALUES ('ddoc-pi-2','draw-1','MATERIAL_INVOICE','Rebar invoice','REJECTED','2026-07-03T00:00:00.000Z','Acme Concrete Supply','INV-1002',45000)`
  );
  exec(
    `INSERT INTO draw_documents (id, draw_request_id, doc_type, title, status, received_at, vendor, invoice_number, amount)
     VALUES ('ddoc-pi-3','draw-1','MATERIAL_INVOICE','Concrete supply invoice (resubmitted)','RECEIVED','2026-07-09T00:00:00.000Z','Acme Concrete Supply','INV-1001',120000)`
  );
  // Risk drivers on the DMV project: critical exceptions, disputes with a
  // legal hold, an expired permit, an overdue milestone, and a budget line
  // paid beyond its revised value.
  for (let i = 1; i <= 4; i += 1) {
    exec(
      `INSERT INTO exceptions (id, organization_id, project_id, source_type, source_id, source_key, category, severity, status, title, opened_at, created_by, created_at, updated_at)
       VALUES ('exc-pi-${i}','org-cdfc','proj-dmv','MANUAL','manual-${i}','pi-test-exc-${i}','COST','CRITICAL','OPEN','Synthetic cost exception ${i}','${T}','user-funder','${T}','${T}')`
    );
  }
  exec(
    `INSERT INTO disputes (id, organization_id, project_id, subject_type, subject_id, disputed_amount, affected_scope, reason, status, opened_by_user_id, opened_by_organization_id, opened_at, legal_hold, legal_hold_at, legal_hold_reason, created_at, updated_at)
     VALUES ('disp-pi-1','org-cdfc','proj-dmv','DRAW','draw-dmv-1',25000,'LINE','Synthetic dispute for analytics','OPEN','user-funder','org-cdfc','${T}',1,'${T}','Litigation hold (synthetic)','${T}','${T}')`
  );
  exec(
    `INSERT INTO disputes (id, organization_id, project_id, subject_type, subject_id, disputed_amount, affected_scope, reason, status, opened_by_user_id, opened_by_organization_id, opened_at, created_at, updated_at)
     VALUES ('disp-pi-2','org-cdfc','proj-dmv','DRAW','draw-dmv-1',10000,'LINE','Second synthetic dispute','OPEN','user-funder','org-cdfc','${T}','${T}','${T}')`
  );
  exec(
    `INSERT INTO permits (id, organization_id, project_id, permit_number, permit_type, status, created_by_user_id, created_at, updated_at)
     VALUES ('permit-pi-exp','org-cdfc','proj-dmv','DEMO-EXP-001','DEMOLITION','EXPIRED','user-funder','${T}','${T}')`
  );
  exec(
    `INSERT INTO milestones (id, project_id, seq, title, requirement, tranche_amount, status, account_status, planned_end)
     VALUES ('ms-dmv-x','proj-dmv',9,'Overdue phase (synthetic)','photo',10000,'PENDING_EVIDENCE','HELD','2026-05-01')`
  );
  exec(
    `INSERT INTO budget_lines (id, project_id, code, category, description, original_budget, approved_changes, paid_to_date, active, created_at, updated_at)
     VALUES ('bl-pi-over','proj-dmv','99-999','Contingency','Synthetic overrun line',10000,0,25000,1,'${T}','${T}')`
  );
  // Draw-scoped governed account events (unified held/released read model)
  // and a pending CHANGE_ORDER approval (subject-type coverage).
  exec(
    `INSERT INTO draw_account_events (id, draw_request_id, type, amount, created_at)
     VALUES ('dae-pi-held','draw-vam','HELD',200000,'2026-07-12T00:00:00.000Z')`
  );
  exec(
    `INSERT INTO draw_account_events (id, draw_request_id, type, amount, created_at)
     VALUES ('dae-pi-rel','draw-vam','RELEASED',200000,'2026-07-15T00:00:00.000Z')`
  );
  exec(
    `INSERT INTO approval_requests (id, change_order_id, subject_type, status, required_roles, created_at)
     VALUES ('apr-pi-co','co-1','CHANGE_ORDER','PENDING','["FUNDER_REP"]','2026-07-01T00:00:00.000Z')`
  );
  pass("synthetic verified records inserted (organizations, loan, parties, inspections, invoices, exceptions, disputes, permit, milestone, budget line, draw account events, CO approval)");
  await signIn("exec2", "user-pi-exec");
  pass("second-lender executive signed in");

  // ------------------------------------------------------------ section 5
  console.log("\n== 5. Analytics reads mutate nothing ==");
  const frozen = snapshotTables(allUserTables());
  const readEndpoints = [
    "/api/portfolio/overview",
    "/api/portfolio/overview?risk=STABLE",
    "/api/portfolio/risk",
    "/api/portfolio/project/proj-dmv/risk",
    "/api/portfolio/project/proj-dmv/forecast",
    "/api/portfolio/contractors",
    "/api/portfolio/inspectors",
    "/api/portfolio/vendors",
    "/api/portfolio/forecast",
    "/api/portfolio/fraud",
    "/api/portfolio/summary?period=weekly",
    "/api/portfolio/summary?period=monthly",
    "/api/portfolio/summary?period=briefing",
    "/api/portfolio/snapshots",
    "/api/portfolio/government",
  ];
  for (const key of ["funder", "compliance", "dmvpm", "exec2"]) {
    for (const endpoint of readEndpoints) {
      const res = await api(key, "GET", endpoint);
      if (![200, 404].includes(res.status)) fail(`${key} GET ${endpoint} → ${res.status}`);
      await res.text();
    }
  }
  for (const p of ["/executive", "/executive/entities", "/executive/forecast", "/executive/summary", "/executive/report/preview"]) {
    const r = await page("funder", p);
    if (r.status !== 200) fail(`page ${p} → ${r.status}`);
  }
  assertSnapshotEqual(
    frozen,
    snapshotTables(allUserTables()),
    "every primary table is byte-identical after all analytics reads and pages, for all viewers"
  );

  // ------------------------------------------------------------ section 6
  console.log("\n== 6. Risk engine responds to verified records ==");
  const dmvRisk1 = await j("funder", "GET", "/api/portfolio/project/proj-dmv/risk");
  assert(
    dmvRisk1.dimensions.compliance.score > dmvRisk0.dimensions.compliance.score,
    "compliance risk rises with the expired permit and critical exceptions"
  );
  assert(
    ["ELEVATED", "CRITICAL"].includes(dmvRisk1.dimensions.compliance.band),
    `compliance dimension reaches ${dmvRisk1.dimensions.compliance.band}`
  );
  assert(
    dmvRisk1.dimensions.operational.score > dmvRisk0.dimensions.operational.score &&
      dmvRisk1.dimensions.operational.reasons.some((r) => r.code === "LEGAL_HOLDS"),
    "operational risk registers the open disputes and legal hold"
  );
  assert(
    dmvRisk1.dimensions.schedule.reasons.some((r) => r.code === "MILESTONES_OVERDUE"),
    "schedule risk registers the overdue milestone"
  );
  assert(
    dmvRisk1.dimensions.compliance.reasons.some((r) => r.code === "PERMIT_INVALID"),
    "risk reasons carry explainable codes (PERMIT_INVALID)"
  );
  assert(dmvRisk1.overallRisk > dmvRisk0.overallRisk, "overall project risk increased");
  assert(dmvRisk1.band !== "STABLE", `project band moved off STABLE (${dmvRisk1.band})`);
  const risk1 = await j("funder", "GET", "/api/portfolio/risk");
  const attention1 = new Set(risk1.attention.map((p) => p.projectId));
  const expected1 = new Set(
    risk1.projects.filter((p) => ["ELEVATED", "CRITICAL"].includes(p.band)).map((p) => p.projectId)
  );
  assert(
    attention1.size === expected1.size && [...attention1].every((id) => expected1.has(id)),
    "attention queue tracks the new band assignments automatically"
  );
  const r47Risk1 = risk1.projects.find((p) => p.projectId === "proj-r47");
  assert(
    r47Risk1.dimensions.operational.reasons.some((r) => r.code === "APPROVAL_BACKLOG"),
    "aged CHANGE_ORDER approval registers in operational risk (all subject types scoped)"
  );
  const ovAfter = await j("funder", "GET", "/api/portfolio/overview");
  assert(
    ovAfter.totals.releasedAmount === 920000,
    `released total unifies milestone and draw account events (${ovAfter.totals.releasedAmount})`
  );
  assert(
    ovAfter.trends.growth.at(-1).cumulativeReleased === ovAfter.totals.releasedAmount,
    "growth series and headline released total agree after a draw-scoped release"
  );
  assert(
    ovAfter.totals.pendingApprovals === 1,
    "pending approvals count includes CHANGE_ORDER subjects"
  );

  // ------------------------------------------------------------ section 7
  console.log("\n== 7. Contractor / inspector / vendor intelligence ==");
  const contractors = (await j("funder", "GET", "/api/portfolio/contractors")).contractors;
  const sterling = contractors.find((c) => c.organizationId === "org-pi-contractor");
  assert(Boolean(sterling), "contractor of record resolved from loan asset + party assignment");
  assert(
    sterling.projects.some((p) => p.projectId === "proj-dmv"),
    "contractor scorecard attributes the DMV project"
  );
  for (const field of [
    "overallScore", "qualityScore", "documentationScore", "schedulePerformance",
    "budgetPerformance", "completedProjects", "projectsInProgress",
  ]) {
    if (typeof sterling[field] !== "number") fail(`contractor scorecard missing numeric ${field}`);
  }
  pass("contractor scorecard carries all scoring fields");
  assert(
    Array.isArray(sterling.topRisks) && Array.isArray(sterling.topStrengths) && Array.isArray(sterling.historicalTrend),
    "contractor scorecard carries risks, strengths and historical trend"
  );
  assert(
    sterling.topRisks.some((r) => /exception/i.test(r)),
    "contractor top risks reflect the open exceptions on their project"
  );
  const detail = await j(
    "funder",
    "GET",
    "/api/portfolio/contractor/org-pi-contractor"
  );
  assert(detail.organizationId === "org-pi-contractor", "contractor detail endpoint resolves");
  const orgHashBefore = tableHash("organizations");
  await j("funder", "GET", "/api/portfolio/contractors");
  assert(tableHash("organizations") === orgHashBefore, "contractor scoring never replaces organization records");

  const inspectors = (await j("funder", "GET", "/api/portfolio/inspectors")).inspectors;
  const independent = inspectors.find((i) => i.name === "Alex Rivera, P.E.");
  assert(Boolean(independent) && independent.source === "INDEPENDENT", "independent draw inspector resolved");
  assert(independent.inspections === 2 && independent.completedInspections === 2, "independent inspector counts match");
  assert(
    independent.averageTurnaroundDays !== null && independent.averageTurnaroundDays >= 4 && independent.averageTurnaroundDays <= 7,
    `independent turnaround computed from requested→completed (${independent.averageTurnaroundDays}d)`
  );
  assert(independent.passRatePct === 50, `independent pass rate reflects one accepted, one correction (${independent.passRatePct}%)`);
  const gov = inspectors.find((i) => i.name === "Inspector J. Whitcomb");
  assert(Boolean(gov) && gov.source === "GOVERNMENT_RECORD", "government inspection record kept as a separate source");
  assert(gov.passRatePct === 50 && gov.correctionRatePct === 50, "government pass/correction rates computed");

  const vendors = (await j("funder", "GET", "/api/portfolio/vendors")).vendors;
  const acme = vendors.find((v) => v.name === "Acme Concrete Supply");
  assert(Boolean(acme), "vendor resolved from draw-document invoice metadata");
  assert(acme.invoiceCount === 3 && acme.invoiceTotal === 285000, "vendor invoice counts and totals match");
  assert(acme.invoiceRejectedCount === 1, "vendor rejected-invoice count matches");
  assert(typeof acme.reliabilityScore === "number", "vendor reliability score computed");
  const vendorDetail = await j("funder", "GET", `/api/portfolio/vendor/${encodeURIComponent("acme concrete supply")}`);
  assert(vendorDetail.name === "Acme Concrete Supply", "vendor detail endpoint resolves by normalized key");

  // ------------------------------------------------------------ section 8
  console.log("\n== 8. Forecasting stays separate from actuals ==");
  const actualsBefore = snapshotTables(["projects", "milestones", "budget_lines", "cost_to_complete_estimates"]);
  const forecast = await j("funder", "GET", "/api/portfolio/forecast");
  assert(forecast.projects.length === 2, "forecast covers every accessible project");
  const r47f = forecast.projects.find((p) => p.projectId === "proj-r47");
  for (const field of [
    "finalCostForecast", "remainingBudget", "remainingFunding", "scheduleConfidence",
    "budgetConfidence", "inspectionCompletionForecastDays", "permitCompletionForecastDays", "cashFlow",
  ]) {
    if (r47f[field] === undefined) fail(`forecast missing ${field}`);
  }
  pass("forecast carries every projection field");
  const r47Revised = q1(
    "SELECT SUM(original_budget + approved_changes) AS s FROM budget_lines WHERE project_id='proj-r47' AND active=1"
  ).s;
  const r47Paid = q1(
    "SELECT SUM(paid_to_date) AS s FROM budget_lines WHERE project_id='proj-r47' AND active=1"
  ).s;
  assert(r47f.remainingBudget === r47Revised - r47Paid, "remaining budget = revised − paid (derived, not stored)");
  assert(r47f.finalCostForecast >= r47Revised, "final cost forecast is at least the revised budget");
  assert(Array.isArray(r47f.basis) && r47f.basis.length > 0, "every forecast discloses its basis");
  assert(
    forecast.advisory.includes("never modify actual project values"),
    "forecast payload carries the separation advisory"
  );
  assertSnapshotEqual(actualsBefore, snapshotTables(["projects", "milestones", "budget_lines", "cost_to_complete_estimates"]), "actual project values unchanged by forecasting");

  // ------------------------------------------------------------ section 9
  console.log("\n== 9. Fraud intelligence (advisory only) ==");
  const fraud = await j("funder", "GET", "/api/portfolio/fraud");
  assert(fraud.signalCount > 0, "anomaly signals detected over the synthetic records");
  assert(
    fraud.signals.some((s) => s.code === "DUPLICATE_INVOICE"),
    "duplicate invoice number flagged"
  );
  assert(
    fraud.signals.some((s) => s.code === "PAID_OVER_BUDGET_LINE"),
    "budget line paid beyond revised value flagged"
  );
  assert(
    fraud.advisory.includes("not findings, not accusations"),
    "fraud payload carries the advisory-only statement"
  );
  assert(Array.isArray(fraud.riskClusters), "risk clustering reported");
  const excBefore = q1("SELECT COUNT(*) AS c FROM exceptions").c;
  const drawStatuses = qa("SELECT id, status FROM draw_requests ORDER BY id");
  await j("funder", "GET", "/api/portfolio/fraud");
  assert(q1("SELECT COUNT(*) AS c FROM exceptions").c === excBefore, "fraud flags never open exceptions");
  assert(
    JSON.stringify(qa("SELECT id, status FROM draw_requests ORDER BY id")) === JSON.stringify(drawStatuses),
    "fraud flags never change draw statuses"
  );

  // ----------------------------------------------------------- section 10
  console.log("\n== 10. Executive summaries (advisory narratives) ==");
  for (const period of ["weekly", "monthly", "briefing"]) {
    const s = await j("funder", "GET", `/api/portfolio/summary?period=${period}`);
    if (!s.headline || !Array.isArray(s.sections) || s.sections.length < 8) {
      fail(`summary ${period} malformed`);
    }
    if (!s.advisory.includes("does not approve draws")) fail(`summary ${period} missing advisory`);
  }
  pass("weekly, monthly and briefing summaries generate with advisory statement");
  const summary = await j("funder", "GET", "/api/portfolio/summary?period=weekly");
  const sectionKeys = summary.sections.map((s) => s.key);
  for (const key of ["risks", "budget", "compliance", "funding", "trends", "deadlines", "fraud"]) {
    if (!sectionKeys.includes(key)) fail(`summary missing section ${key}`);
  }
  pass("summary covers risks, budget, compliance, funding, trends, deadlines and fraud sections");
  await j("funder", "GET", "/api/portfolio/summary?period=quarterly", undefined, 400);
  pass("unknown summary period rejected with 400");
  assert(
    JSON.stringify(qa("SELECT id, status FROM draw_requests ORDER BY id")) === JSON.stringify(drawStatuses),
    "summaries never approve or alter draws"
  );

  // ----------------------------------------------------------- section 11
  console.log("\n== 11. Multi-lender isolation (same-404) ==");
  const execOv = await j("exec2", "GET", "/api/portfolio/overview");
  assert(execOv.totals.totalProjects === 1, "second lender sees exactly their own project");
  assert(execOv.totals.totalBudget === 1000000, "second lender totals cover only their portfolio");
  await j("exec2", "GET", "/api/portfolio/project/proj-r47/risk", undefined, 404);
  pass("cross-tenant project risk is 404 for the second lender");
  await j("exec2", "GET", "/api/portfolio/project/proj-does-not-exist/risk", undefined, 404);
  pass("nonexistent project risk is 404 — indistinguishable from cross-tenant");
  await j("exec2", "GET", "/api/portfolio/project/proj-pi2/risk");
  pass("second lender reads their own project risk");
  const funderOv = await j("funder", "GET", "/api/portfolio/overview");
  assert(funderOv.totals.totalProjects === 2, "first lender scope is unchanged by the second lender's project");
  assert(
    !funderOv.distributions.byLender.some((e) => e.key === "org-pi-lender2"),
    "first lender never sees the second lender in distributions"
  );
  await j("funder", "GET", "/api/portfolio/project/proj-pi2/risk", undefined, 404);
  pass("first lender cannot read the second lender's project risk (404)");
  const execContractors = (await j("exec2", "GET", "/api/portfolio/contractors")).contractors;
  assert(
    !execContractors.some((c) => c.organizationId === "org-pi-contractor"),
    "second lender never sees the first portfolio's contractors"
  );
  await j("exec2", "GET", "/api/portfolio/contractor/org-pi-contractor", undefined, 404);
  pass("cross-tenant contractor detail is 404");
  const execFraud = await j("exec2", "GET", "/api/portfolio/fraud");
  assert(
    execFraud.signals.every((s) => s.projectId === null || s.projectId === "proj-pi2"),
    "fraud signals never leak another tenant's projects"
  );
  const execSummary = await j("exec2", "GET", "/api/portfolio/summary?period=weekly");
  assert(
    !execSummary.headline.includes("2,895,000") && execSummary.headline.includes("1,000,000"),
    "summary narrative is scoped to the viewer's portfolio"
  );

  // ----------------------------------------------------------- section 12
  console.log("\n== 12. Role gates ==");
  {
    const res = await fetch(`${BASE}/api/portfolio/overview`);
    assert(res.status === 401, "anonymous portfolio API is 401");
    const fieldRes = await api("field", "GET", "/api/portfolio/overview");
    assert(fieldRes.status === 403, "FIELD role portfolio API is 403 (in-tenant capability gate)");
    const body = await fieldRes.json();
    assert(/not authorized/.test(body.error), "FIELD 403 carries an explanatory message");
    const fieldPage = await page("field", "/executive");
    assert(fieldPage.status === 403, "FIELD role executive page is 403");
    const anonPage = await fetch(`${BASE}/executive`, { redirect: "manual" });
    assert(
      anonPage.status === 303 || anonPage.status === 302,
      "anonymous executive page redirects to sign-in"
    );
    const fieldSnap = await api("field", "POST", "/api/portfolio/snapshots");
    assert(fieldSnap.status === 403, "FIELD role cannot record snapshots");
    const fieldSnapList = await api("field", "GET", "/api/portfolio/snapshots");
    assert(fieldSnapList.status === 403, "FIELD role cannot read the snapshot series either");
    const malformed = await api("funder", "GET", "/api/portfolio/vendor/%zz");
    assert(malformed.status === 404, "malformed entity keys are indistinguishable from nonexistent (404)");
  }

  // ----------------------------------------------------------- section 13
  console.log("\n== 13. Government foundation: architecture present, everything disabled ==");
  const govStatus = await j("funder", "GET", "/api/portfolio/government");
  assert(govStatus.enabled === false, "government module reports disabled");
  assert(govStatus.activationState === "ARCHITECTURE_ONLY", "activation state is ARCHITECTURE_ONLY");
  assert(
    JSON.stringify(govStatus.supportedKinds) ===
      JSON.stringify(["GOVERNMENT", "INFRASTRUCTURE_PROGRAM", "DONOR_FUNDED", "GRANT"]),
    "future portfolio kinds are declared"
  );
  assert(
    govStatus.tables.portfolios === 0 && govStatus.tables.programs === 0 && govStatus.tables.links === 0,
    "gov_* tables exist and are empty"
  );
  for (const t of ["gov_portfolios", "gov_programs", "gov_program_links"]) {
    const row = q1("SELECT name FROM sqlite_master WHERE type='table' AND name=?", t);
    if (!row) fail(`table ${t} missing from database`);
  }
  pass("government tables present in the schema");
  await j("funder", "POST", "/api/portfolio/government", {}, 405);
  pass("government status endpoint refuses mutation (405)");
  await j("funder", "GET", "/api/portfolio/government/activate", undefined, 404);
  await j("funder", "POST", "/api/portfolio/government/activate", { enable: true }, 404);
  pass("activation-shaped requests are indistinguishable from nonexistent (404)");

  // ----------------------------------------------------------- section 14
  console.log("\n== 14. Snapshots (append-only) ==");
  const snapBefore = q1("SELECT COUNT(*) AS c FROM portfolio_snapshots").c;
  const recorded = (await j("funder", "POST", "/api/portfolio/snapshots", {}, 201)).snapshot;
  assert(
    q1("SELECT COUNT(*) AS c FROM portfolio_snapshots").c === snapBefore + 1,
    "snapshot recording appends exactly one row"
  );
  const ovNow = await j("funder", "GET", "/api/portfolio/overview");
  assert(
    recorded.projectCount === ovNow.totals.totalProjects &&
      recorded.totalBudget === ovNow.totals.totalBudget,
    "snapshot values match the overview at record time"
  );
  const funderSnaps = (await j("funder", "GET", "/api/portfolio/snapshots")).snapshots;
  assert(funderSnaps.some((s) => s.id === recorded.id), "recorded snapshot appears in the viewer's history");
  await j("exec2", "POST", "/api/portfolio/snapshots", {}, 201);
  const execSnaps = (await j("exec2", "GET", "/api/portfolio/snapshots")).snapshots;
  assert(
    !execSnaps.some((s) => s.id === recorded.id),
    "snapshot series are tenant-scoped — one lender never sees another's"
  );
  const complianceSnaps = (await j("compliance", "GET", "/api/portfolio/snapshots")).snapshots;
  assert(
    !complianceSnaps.some((s) => s.id === recorded.id),
    "snapshot series are recorder-scoped — access sets are per-user, so even org-mates never read another recorder's aggregates"
  );
  const funderSnaps2 = (await j("funder", "GET", "/api/portfolio/snapshots")).snapshots;
  assert(
    funderSnaps2.every((s) => funderSnaps.some((x) => x.id === s.id) || s.takenAt >= recorded.takenAt),
    "snapshot history is append-only from the viewer's perspective"
  );

  // ----------------------------------------------------------- section 15
  console.log("\n== 15. Executive report ==");
  const preview = await page("funder", "/executive/report/preview");
  assert(preview.status === 200 && preview.html.includes("Executive Portfolio Report"), "printable preview renders");
  assert(preview.html.includes("Risk register"), "preview includes the risk register section");
  assert(
    preview.html.includes("never approve draws"),
    "preview carries the advisory reliance statement"
  );
  const reportsBefore = q1("SELECT COUNT(*) AS c FROM reports").c;
  const health = await (await fetch(`${BASE}/api/health`)).json();
  const pdfRes = await api("funder", "POST", "/api/reports/executive", {});
  if (health.reportRenderer === "pdf") {
    assert(pdfRes.status === 200, "executive PDF generation succeeds");
    const buf = Buffer.from(await pdfRes.arrayBuffer());
    assert(buf.subarray(0, 5).toString() === "%PDF-", "response streams a real PDF");
    assert(
      (pdfRes.headers.get("content-disposition") ?? "").includes("Executive_Portfolio_Report"),
      "PDF delivered as a named attachment"
    );
  } else {
    assert(pdfRes.status === 200, "executive report degrades gracefully without Chromium");
    const body = await pdfRes.json();
    assert(body.fallback === "html", "fallback response points at the printable preview");
    pass("(renderer unavailable — attachment naming not applicable)");
  }
  assert(
    q1("SELECT COUNT(*) AS c FROM reports").c === reportsBefore,
    "executive report writes no rows into the project-scoped reports register"
  );
  const execPage = await page("funder", "/executive");
  assert(execPage.status === 200 && /<h1>[^<]*Executive command center[^<]*<\/h1>/.test(execPage.html), "executive page renders with a single h1");
  assert(execPage.html.includes("metric-strip"), "executive page includes the KPI metric strip");
  assert(execPage.html.includes("Projects by lender"), "executive page includes lender distribution");
  const entPage = await page("funder", "/executive/entities");
  assert(entPage.status === 200 && entPage.html.includes("Acme Concrete Supply"), "entities page lists the resolved vendor");

  // ----------------------------------------------------------- section 16
  console.log("\n== 16. Banking + ledger untouched end-to-end ==");
  assertSnapshotEqual(
    bankingBaseline,
    snapshotTables(BANKING_AND_LEDGER),
    "banking, VAM, ledger, evidence, reports and package tables are byte-identical from suite start to finish"
  );
  const daeRows = qa("SELECT id FROM draw_account_events ORDER BY id").map((r) => r.id);
  assert(
    daeRows.length === 2 && daeRows.every((id) => id.startsWith("dae-pi-")),
    "draw_account_events contains only this suite's two synthetic rows — the analytics layer wrote none"
  );
  assert(
    q1("SELECT COUNT(*) AS c FROM gov_portfolios").c === 0 &&
      q1("SELECT COUNT(*) AS c FROM gov_programs").c === 0 &&
      q1("SELECT COUNT(*) AS c FROM gov_program_links").c === 0,
    "gov_* tables remain empty after the entire suite"
  );

  console.log(`\nPORTFOLIO INTELLIGENCE TESTS PASSED — ${passed} checkpoints.`);
}

main()
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
    if (server) server.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });
