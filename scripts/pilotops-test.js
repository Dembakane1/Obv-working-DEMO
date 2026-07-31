#!/usr/bin/env node
/**
 * Pilot Readiness test battery.
 *
 *   0. static guards (no network in the layer, append-only tables stay
 *      append-only, no restore path, no writes to governed tables)
 *   1. onboarding wizard + organization settings + branding
 *   2. user administration (suspend/restore/MFA/history, same-404, audit)
 *   3. notification center (derived feed, prefs, read state, digests)
 *   4. email abstraction (outbox, templates, no raw tokens, failure path)
 *   5. e-signature framework (lifecycle, webhook, append-only audit)
 *   6. accounting framework (exports, staging-only imports)
 *   7. monitoring + production configuration (maintenance, banners, flags)
 *   8. backups & recovery (create/verify/tamper/recovery-test, no restore)
 *   9. feedback portal (org scoping, internal notes hidden)
 *  10. pilot analytics (+ opt-in usage tracking, rate limiting, email
 *      failure adapter on a second configured server)
 *  11. demo data generator (gated, DEMO-marked, governed tables untouched)
 *  12. documentation set present
 *  13. banking/ledger/evidence/report/package tables byte-identical
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 3235;
const PORT2 = 3236;
const BASE = `http://127.0.0.1:${PORT}`;
const BASE2 = `http://127.0.0.1:${PORT2}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-pilotops-"));
const ROOT = process.cwd();
const WEBHOOK_TOKEN = "pilot-webhook-shared-value-for-tests";

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

const jars = {};
async function signIn(key, userId, base = BASE, expectStatus = 303) {
  const res = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": `obv-pilotops-test/${key}` },
    body: JSON.stringify({ userId }),
    redirect: "manual",
  });
  if (res.status !== expectStatus) fail(`sign-in ${userId} → ${res.status} (expected ${expectStatus})`);
  if (expectStatus === 303) jars[key] = res.headers.getSetCookie()[0].split(";")[0];
  return res.status;
}
function api(key, method, p, body, base = BASE) {
  return fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", cookie: jars[key] ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
}
async function j(key, method, p, body, expect = 200, base = BASE) {
  const res = await api(key, method, p, body, base);
  const text = await res.text();
  if (res.status !== expect) fail(`${method} ${p} → ${res.status} (expected ${expect}): ${text.slice(0, 250)}`);
  return text ? JSON.parse(text) : {};
}
async function page(key, p, base = BASE) {
  const res = await fetch(`${base}${p}`, {
    headers: { cookie: jars[key] ?? "", accept: "text/html" },
    redirect: "manual",
  });
  return { status: res.status, html: await res.text() };
}

let db = null;
const q1 = (sql, ...args) => db.prepare(sql).get(...args);
const qa = (sql, ...args) => db.prepare(sql).all(...args);

function tableHash(table) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(qa(`SELECT * FROM ${table} ORDER BY 1`)))
    .digest("hex");
}
const PROTECTED = [
  "banking_programs", "project_virtual_accounts", "project_account_holds", "payment_instructions",
  "bank_transactions", "reconciliation_runs", "banking_events", "mock_provider_ledger",
  "virtual_account_events", "draw_account_events", "retainage_events", "ledger_entries",
  "evidence_items", "verifications", "reports", "audit_packages", "approval_records",
];
function snapshot(tables) {
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

// ---------------------------------------------------------------- static

function staticGuards() {
  console.log("\n== 0. Static source guards ==");
  const read = (p) =>
    fs
      .readFileSync(path.join(ROOT, p), "utf8")
      .split("\n")
      .filter((line) => !/^import type /.test(line))
      .join("\n");
  const layerFiles = [
    "src/server/services/pilotOps/core.ts",
    "src/server/services/pilotOps/email.ts",
    "src/server/services/pilotOps/onboarding.ts",
    "src/server/services/pilotOps/userAdmin.ts",
    "src/server/services/pilotOps/notifications.ts",
    "src/server/services/pilotOps/integrations.ts",
    "src/server/services/pilotOps/operations.ts",
    "src/server/services/pilotOps/success.ts",
    "src/server/services/pilotOps/demoData.ts",
    "src/server/services/pilotOps/index.ts",
    "src/server/db/pilotOpsRepo.ts",
    "src/server/http/pilotOpsRoutes.ts",
  ];
  const combined = layerFiles.map(read).join("\n");
  assert(
    !/\bnode:https?\b|fetch\s*\(|axios|XMLHttpRequest|net\.connect|nodemailer|smtp/i.test(combined),
    "pilot-ops layer contains no network or SMTP primitives — providers are pure abstractions"
  );
  assert(!/VirtualAccountService/.test(combined), "pilot-ops layer never references VirtualAccountService");
  assert(
    !/docusign\.com|hellosign|dropboxapi|adobesign\.|echosign|intuit\.com|quickbooks\.api|xero\.com|sage\.com|oauth/i.test(
      combined
    ),
    "no provider-specific API endpoints or auth flows anywhere — provider names are registry labels only"
  );
  assert(
    !/INSERT INTO\s+(evidence_items|ledger_entries|verifications|approval_requests|approval_records|banking_|payment_instructions|bank_transactions|mock_provider_ledger|audit_packages|reports|portfolio_snapshots|gov_)/.test(
      combined
    ),
    "pilot-ops layer never inserts into evidence/ledger/approval/banking/report/package/gov tables"
  );
  const repoSrc = read("src/server/db/pilotOpsRepo.ts");
  assert(!/\bDELETE\s+FROM\b/.test(repoSrc), "pilotOpsRepo contains no DELETE statement anywhere");
  for (const table of ["user_access_events", "esign_events", "accounting_runs", "accounting_import_rows", "recovery_tests", "feedback_events", "onboarding_steps", "usage_events"]) {
    assert(!new RegExp(`UPDATE\\s+${table}`).test(repoSrc), `${table} is append-only (no UPDATE path)`);
  }
  const opsSrc = read("src/server/services/pilotOps/operations.ts");
  assert(
    !/copyFileSync|renameSync|cpSync/.test(opsSrc),
    "backups have no restore path — nothing copies a backup over the live database"
  );
  assert(/VACUUM INTO/.test(opsSrc) && /quick_check/i.test(opsSrc), "backups use VACUUM INTO with integrity checking");
  const emailSrc = read("src/server/services/pilotOps/email.ts");
  assert(
    emailSrc.includes("OBV_EMAIL_PRODUCTION_ENABLE"),
    "live email providers require the explicit production enable posture"
  );
  const demoSrc = read("src/server/services/pilotOps/demoData.ts");
  assert(demoSrc.includes('"DEMO — ') && demoSrc.includes("isDemoBankingMode"), "demo generator marks records and is demo-mode gated");
  const schemaSrc = fs.readFileSync(path.join(ROOT, "src/server/db/index.ts"), "utf8");
  for (const table of [
    "organization_settings", "onboarding_steps", "user_admin_state", "user_access_events",
    "cs_accounts", "user_notification_prefs", "email_outbox", "esign_requests",
    "accounting_connections", "backup_records", "recovery_tests", "feedback_items",
    "usage_events", "system_banners", "feature_flags",
  ]) {
    if (!schemaSrc.includes(`CREATE TABLE IF NOT EXISTS ${table}`)) fail(`schema missing ${table}`);
  }
  pass("schema declares every pilot-readiness table");
}

// ----------------------------------------------------------------- main

let server = null;
let server2 = null;

async function main() {
  staticGuards();

  console.log("\n== 1. Boot + onboarding ==");
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
      OBV_ESIGN_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
    },
    stdio: "ignore",
  });
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i += 1) {
    try {
      healthy = (await fetch(`${BASE}/api/health`)).ok;
    } catch {
      /* booting */
    }
    if (!healthy) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!healthy) fail("server did not become healthy");
  const health = await (await fetch(`${BASE}/api/health`)).json();
  assert(typeof health.deployVersion === "string" && health.deployVersion.length > 0, "health reports a deployVersion");
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(DATA_DIR, "obv.db"));
  const protectedBaseline = snapshot(PROTECTED);
  pass("protected-table baseline captured");
  await signIn("funder", "user-funder");
  await signIn("lender2", "user-lender2");
  await signIn("compliance", "user-compliance");
  await signIn("pm", "user-pm");
  await signIn("field", "user-field");
  pass("seeded users signed in (access events recorded)");

  let ob = await j("funder", "GET", "/api/pilot-ops/onboarding");
  assert(ob.totalSteps === 6 && Array.isArray(ob.steps), "onboarding wizard exposes six steps");
  assert(
    ob.steps.find((s) => s.key === "PORTFOLIO_CREATED").completed &&
      ob.steps.find((s) => s.key === "TEAM_INVITED").completed,
    "derived steps recognize existing projects and teammates"
  );
  assert(!ob.complete, "onboarding starts incomplete");
  await j("funder", "POST", "/api/pilot-ops/org-settings", { brandColor: "not-a-color" }, 400);
  pass("invalid brand color rejected");
  await j("funder", "POST", "/api/pilot-ops/org-settings", {
    displayName: "Continental DF",
    legalName: "Continental Development Finance Corporation",
    timezone: "America/New_York",
    brandColor: "#0B1323",
    defaultNotificationChannel: "BOTH",
  });
  pass("organization settings saved");
  const png1x1 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await j("funder", "POST", "/api/pilot-ops/org-logo", { dataUrl: png1x1 });
  const logoRes = await api("funder", "GET", "/api/pilot-ops/org-logo");
  assert(logoRes.status === 200 && (logoRes.headers.get("content-type") ?? "").includes("image/png"), "logo uploads and serves back");
  await j("funder", "POST", "/api/pilot-ops/org-logo", { dataUrl: "data:image/gif;base64,AAAA" }, 400);
  pass("non-PNG/JPEG logo rejected");
  await j("funder", "POST", "/api/pilot-ops/onboarding/step", { stepKey: "ORG_PROFILE" });
  await j("funder", "POST", "/api/pilot-ops/onboarding/step", { stepKey: "REVIEW" });
  ob = await j("funder", "GET", "/api/pilot-ops/onboarding");
  assert(ob.complete, "onboarding completes (recorded + derived steps)");
  assert(
    q1("SELECT COUNT(*) AS c FROM config_audit WHERE action='ONBOARDING_STEP_COMPLETED'").c >= 2,
    "onboarding steps are audited"
  );
  await j("field", "GET", "/api/pilot-ops/onboarding", undefined, 403);
  pass("FIELD role cannot administer onboarding (403)");

  console.log("\n== 2. User administration ==");
  let directory = await j("funder", "GET", "/api/pilot-ops/users");
  assert(directory.users.length === 3, "directory lists exactly the administrator's organization users");
  assert(
    directory.users.every((entry) => entry.status === "ACTIVE"),
    "all users start ACTIVE (absent admin state = active)"
  );
  assert(
    directory.users.find((entry) => entry.user.id === "user-funder").lastSignInAt !== null,
    "last sign-in derives from the access-event history"
  );
  await j("funder", "POST", "/api/pilot-ops/users/user-pm/suspend", { reason: "x" }, 404);
  pass("cross-organization suspension is a same-404");
  await j("funder", "POST", "/api/pilot-ops/users/user-nonexistent/suspend", { reason: "x" }, 404);
  pass("nonexistent user suspension is an identical 404");
  await j("funder", "POST", "/api/pilot-ops/users/user-funder/suspend", { reason: "x" }, 400);
  pass("self-suspension refused");
  await j("funder", "POST", "/api/pilot-ops/users/user-lender2/suspend", { reason: "Pilot rotation" });
  await j("lender2", "GET", "/api/portfolio/overview", undefined, 401);
  pass("suspended user's existing session stops resolving");
  await signIn("x", "user-lender2", BASE, 404);
  pass("suspended user cannot sign back in (non-oracle 404)");
  assert(
    q1("SELECT COUNT(*) AS c FROM user_access_events WHERE user_id='user-lender2' AND event='SIGN_IN_REFUSED'").c === 1,
    "refused sign-in recorded in the append-only access history"
  );
  await j("funder", "POST", "/api/pilot-ops/users/user-lender2/restore", {});
  await signIn("lender2", "user-lender2");
  pass("restored user signs back in");
  await j("funder", "POST", "/api/pilot-ops/users/user-lender2/mfa", { ready: "1" });
  directory = await j("funder", "GET", "/api/pilot-ops/users");
  assert(directory.users.find((entry) => entry.user.id === "user-lender2").mfaReady, "MFA readiness tracked");
  const access = await j("funder", "GET", "/api/pilot-ops/users/user-lender2/access");
  assert(access.events.length >= 3 && access.devices.length >= 1, "sign-in and device history returned");
  assert(
    access.devices[0].userAgent.includes("obv-pilotops-test"),
    "device history derives from recorded user agents"
  );
  const matrix = await j("funder", "GET", "/api/pilot-ops/permission-matrix");
  assert(matrix.matrix.length >= 8, "permission matrix documents the role capabilities");
  for (const action of ["USER_SUSPENDED", "USER_RESTORED", "USER_MFA_READY"]) {
    if (q1("SELECT COUNT(*) AS c FROM config_audit WHERE action=?", action).c < 1) fail(`missing audit ${action}`);
  }
  pass("every user-administration action is audited");

  console.log("\n== 3. Notification center ==");
  let feed = await j("funder", "GET", "/api/pilot-ops/notifications");
  assert(feed.items.length > 0 && typeof feed.unread === "number", "derived feed assembles");
  assert(
    feed.items.some((item) => item.type === "EXECUTIVE_SUMMARY"),
    "executive summary appears in the feed for review roles"
  );
  const firstKey = feed.items[0].key;
  await j("funder", "POST", "/api/pilot-ops/notifications/read", { key: firstKey });
  const feedAfter = await j("funder", "GET", "/api/pilot-ops/notifications");
  assert(
    feedAfter.items.find((item) => item.key === firstKey).read === true &&
      feedAfter.unread === feed.unread - 1,
    "read receipts persist and unread count drops"
  );
  await j("funder", "POST", "/api/pilot-ops/notification-prefs", { mutedTypes: "SYSTEM,MENTION" });
  const muted = await j("funder", "GET", "/api/pilot-ops/notifications");
  assert(
    muted.items.every((item) => item.type !== "SYSTEM" && item.type !== "MENTION"),
    "muted types disappear from the feed"
  );
  await j("funder", "POST", "/api/pilot-ops/notification-prefs", { mutedTypes: "NOT_A_TYPE" }, 400);
  pass("unknown notification types rejected");
  await j("funder", "POST", "/api/pilot-ops/notification-prefs", { mutedTypes: "" });
  const fieldFeed = await j("field", "GET", "/api/pilot-ops/notifications");
  assert(
    fieldFeed.items.every((item) => !["FRAUD_ALERT", "RISK_ALERT", "EXECUTIVE_SUMMARY"].includes(item.type)),
    "FIELD users get operational items but no portfolio-intelligence alerts"
  );
  const digest = await j("funder", "POST", "/api/pilot-ops/digest", { period: "WEEKLY" });
  assert(digest.email && digest.email.status === "SENT" && digest.email.template === "WEEKLY_PORTFOLIO_SUMMARY", "weekly digest lands in the outbox as SENT (log provider)");
  const dailySkip = await j("funder", "POST", "/api/pilot-ops/digest", { period: "DAILY" });
  assert(dailySkip.skipped === true, "daily digest skipped when the preference is off");

  console.log("\n== 4. Email abstraction ==");
  const emails = await j("funder", "GET", "/api/pilot-ops/emails");
  assert(emails.emails.length >= 1 && emails.emails.every((e) => e.provider === "log"), "outbox records sends through the log provider");
  const inviteForm = new URLSearchParams({
    email: "pilot.reviewer@example.com",
    organizationId: "org-cdfc",
    role: "FUNDER_REP",
  });
  // Invitation creation is the existing pilot-admin (PROJECT_MANAGER) flow.
  const inviteRes = await fetch(`${BASE}/api/pilot/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: jars.pm },
    body: JSON.stringify(Object.fromEntries(inviteForm)),
    redirect: "manual",
  });
  assert(inviteRes.status === 201, "invitation created");
  const inviteEmail = qa("SELECT * FROM email_outbox WHERE template='INVITATION' ORDER BY created_at DESC")[0];
  assert(Boolean(inviteEmail) && inviteEmail.to_address === "pilot.reviewer@example.com", "invitation email queued to the invitee");
  assert(!inviteEmail.body.includes("/invite/"), "the raw activation token is NEVER put in the email body");

  console.log("\n== 5. E-signature framework ==");
  await j("funder", "POST", "/api/pilot-ops/esign", { title: "", signerName: "", signerEmail: "" }, 400);
  pass("incomplete signature request rejected");
  const esign = (await j("funder", "POST", "/api/pilot-ops/esign", {
    title: "Draw certification",
    signerName: "Jordan Demo",
    signerEmail: "jordan@example.com",
  }, 201)).request;
  assert(esign.status === "DRAFT" && esign.provider === "MOCK", "signature request created as DRAFT via the MOCK adapter");
  const sent = (await j("funder", "POST", `/api/pilot-ops/esign/${esign.id}/send`, {})).request;
  assert(sent.status === "SENT" && sent.providerReference.startsWith("mock-"), "request sent with a provider reference");
  const noToken = await fetch(`${BASE}/api/esign/webhook/mock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: sent.providerReference, event: "VIEWED" }),
  });
  assert(noToken.status === 404, "webhook without the shared token is a nondisclosing 404");
  const viewed = await fetch(`${BASE}/api/esign/webhook/mock?token=${WEBHOOK_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: sent.providerReference, event: "VIEWED" }),
  });
  assert(viewed.status === 200 && (await viewed.json()).status === "VIEWED", "webhook advances SENT → VIEWED");
  const signed = await fetch(`${BASE}/api/esign/webhook/mock?token=${WEBHOOK_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: sent.providerReference, event: "SIGNED" }),
  });
  assert((await signed.json()).status === "SIGNED", "webhook advances to SIGNED");
  const replay = await fetch(`${BASE}/api/esign/webhook/mock?token=${WEBHOOK_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: sent.providerReference, event: "VIEWED" }),
  });
  assert((await replay.json()).status === "SIGNED", "out-of-order webhook events never regress the status");
  const detail = await j("funder", "GET", `/api/pilot-ops/esign/${esign.id}`);
  assert(
    detail.request.completedAt !== null &&
      detail.events.some((event) => event.source === "WEBHOOK") &&
      detail.events.some((event) => event.type.startsWith("IGNORED_")),
    "append-only audit trail records OBV actions, webhook deliveries and ignored replays"
  );
  await j("pm", "GET", `/api/pilot-ops/esign/${esign.id}`, undefined, 404);
  pass("cross-organization signature request is a same-404");
  const unknownRef = await fetch(`${BASE}/api/esign/webhook/mock?token=${WEBHOOK_TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: "mock-nope", event: "VIEWED" }),
  });
  assert(unknownRef.status === 404, "unknown provider reference is a 404");

  console.log("\n== 6. Accounting framework ==");
  const accounting = await j("funder", "GET", "/api/pilot-ops/accounting");
  assert(
    accounting.connections.length === 4 &&
      ["QUICKBOOKS", "XERO", "SAGE", "CSV"].every((provider) =>
        accounting.connections.some((connection) => connection.provider === provider)
      ),
    "provider registry lists QuickBooks, Xero, Sage and CSV"
  );
  const exported = (await j("funder", "POST", "/api/pilot-ops/accounting/export", { provider: "CSV", dataset: "PROJECTS" }, 201)).run;
  assert(exported.status === "COMPLETED" && exported.rowCount === 2, "projects export covers the accessible portfolio");
  assert(fs.existsSync(exported.filePath) && fs.readFileSync(exported.filePath, "utf8").startsWith("project_id,"), "normalized CSV written to disk");
  await j("funder", "POST", "/api/pilot-ops/accounting/export", { provider: "QUICKBOOKS", dataset: "INVOICES" }, 201);
  pass("named-provider adapters export the same normalized datasets");
  const governedBefore = snapshot(["projects", "budget_lines", "draw_requests", "draw_documents"]);
  const importRun = (await j("funder", "POST", "/api/pilot-ops/accounting/import", {
    dataset: "BUDGETS",
    csv: "code,category,amount\n01-000,General,100000\n02-000,Site,50000\n",
  }, 201)).run;
  assert(importRun.direction === "IMPORT" && importRun.rowCount === 2, "CSV import accepted");
  assert(
    q1("SELECT COUNT(*) AS c FROM accounting_import_rows WHERE run_id=?", importRun.id).c === 2,
    "imported rows are STAGED"
  );
  assertSnapshotEqual(governedBefore, snapshot(["projects", "budget_lines", "draw_requests", "draw_documents"]),
    "imports never touch governed tables — staging only");
  await j("funder", "POST", "/api/pilot-ops/accounting/export", { provider: "CSV", dataset: "NOPE" }, 400);
  pass("unknown dataset rejected");
  await j("field", "GET", "/api/pilot-ops/accounting", undefined, 403);
  pass("FIELD role has no accounting access");

  console.log("\n== 7. Monitoring + production configuration ==");
  await j("funder", "GET", "/api/internal/ops", undefined, 404);
  await j("pm", "GET", "/api/internal/ops", undefined, 404);
  pass("internal console is a nondisclosing 404 for lender-side roles");
  const ops = await j("compliance", "GET", "/api/internal/ops");
  assert(ops.application.status === "ok" && ops.database.quickCheck === "ok", "application and database health reported");
  assert(ops.apiPerformance.samples > 0 && typeof ops.apiPerformance.averageMs === "number", "API performance ring collects samples");
  assert(Array.isArray(ops.storage) && ops.storage.some((entry) => entry.name === "worm"), "storage usage reported per directory");
  assert(ops.recentErrors.length >= 1, "sanitized recent errors captured (induced 404s)");
  assert(!JSON.stringify(ops).includes(WEBHOOK_TOKEN), "ops dashboard never leaks secret values");
  const config = await j("compliance", "GET", "/api/internal/config");
  assert(
    config.environment.every((entry) => typeof entry.set === "boolean" && Object.keys(entry).join() === "name,set"),
    "environment inventory exposes names and set/unset only — never values"
  );
  await j("compliance", "POST", "/api/internal/banners", { message: "Pilot maintenance window Saturday", level: "WARN" }, 201);
  const overviewHtml = await page("funder", "/overview");
  assert(overviewHtml.html.includes("Pilot maintenance window Saturday"), "system banner renders across the shell");
  const bannerId = (await j("compliance", "GET", "/api/internal/config")).banners.find((banner) => banner.active).id;
  await j("compliance", "POST", `/api/internal/banners/${bannerId}/remove`, {});
  pass("banner deactivated");
  await j("compliance", "POST", "/api/internal/flags", { key: "maintenance_mode", enabled: "1", description: "test" });
  const maint = await api("funder", "GET", "/api/portfolio/overview");
  assert(maint.status === 503, "maintenance mode answers 503 to lender users");
  const maintHealth = await fetch(`${BASE}/api/health`);
  assert(maintHealth.status === 200, "health endpoint stays reachable during maintenance");
  const opsDuring = await api("compliance", "GET", "/api/internal/ops");
  assert(opsDuring.status === 200, "internal operators pass through maintenance mode");
  await j("compliance", "POST", "/api/internal/flags", { key: "maintenance_mode", enabled: "", description: "" });
  assert((await api("funder", "GET", "/api/portfolio/overview")).status === 200, "maintenance mode lifts cleanly");

  console.log("\n== 8. Backups & recovery ==");
  await j("funder", "POST", "/api/internal/backups", {}, 404);
  pass("backup creation is operator-only (404 elsewhere)");
  const backup = (await j("compliance", "POST", "/api/internal/backups", { notes: "pre-test" }, 201)).backup;
  assert(backup.status === "COMPLETED" && backup.sizeBytes > 0 && backup.sha256, "backup created via VACUUM INTO with recorded hash");
  const verified = (await j("compliance", "POST", `/api/internal/backups/${backup.id}/verify`, {})).backup;
  assert(verified.verifyStatus === "VERIFIED", "backup integrity verification passes");
  const recovery = await j("compliance", "POST", `/api/internal/backups/${backup.id}/recovery-test`, {});
  assert(recovery.outcome === "PASSED" && /projects=/.test(recovery.detail), "recovery test opens the backup read-only and confirms core tables");
  const backup2 = (await j("compliance", "POST", "/api/internal/backups", {}, 201)).backup;
  fs.appendFileSync(backup2.filePath, "tamper");
  const tampered = (await j("compliance", "POST", `/api/internal/backups/${backup2.id}/verify`, {})).backup;
  assert(tampered.verifyStatus === "MISMATCH", "tampered backup detected as a hash mismatch");
  const overview = await j("compliance", "GET", "/api/internal/backups");
  assert(overview.backups.length === 2 && overview.recoveryTests.length === 1 && overview.retentionDays === 30, "backup history, recovery log and retention schedule reported");

  console.log("\n== 9. Feedback portal ==");
  const feedbackItem = (await j("pm", "POST", "/api/pilot-ops/feedback", {
    kind: "BUG",
    title: "Draw register misaligns on tablet",
    body: "The register columns overlap at 800px width.",
    severity: "HIGH",
    pagePath: "/draws",
  }, 201)).item;
  assert(feedbackItem.status === "OPEN" && feedbackItem.organizationId === "org-crra", "feedback submitted org-scoped");
  const funderFeedback = await j("funder", "GET", "/api/pilot-ops/feedback");
  assert(!funderFeedback.items.some((item) => item.id === feedbackItem.id), "another organization never sees the feedback");
  await j("funder", "GET", `/api/pilot-ops/feedback/${feedbackItem.id}`, undefined, 404);
  pass("cross-organization feedback detail is a same-404");
  await j("compliance", "POST", `/api/internal/feedback/${feedbackItem.id}/respond`, {
    kind: "INTERNAL_NOTE",
    body: "Repro confirmed on 800px viewport.",
  });
  await j("compliance", "POST", `/api/internal/feedback/${feedbackItem.id}/respond`, {
    kind: "CUSTOMER_RESPONSE",
    body: "Thanks — a fix ships with the next update.",
    status: "TRIAGED",
  });
  const pmDetail = await j("pm", "GET", `/api/pilot-ops/feedback/${feedbackItem.id}`);
  assert(pmDetail.item.status === "TRIAGED", "customer sees the triage status");
  assert(
    pmDetail.events.some((event) => event.kind === "CUSTOMER_RESPONSE") &&
      !pmDetail.events.some((event) => event.kind === "INTERNAL_NOTE"),
    "customer sees responses but internal notes stay internal"
  );
  const internalDetail = await j("compliance", "GET", `/api/pilot-ops/feedback/${feedbackItem.id}`);
  assert(internalDetail.events.some((event) => event.kind === "INTERNAL_NOTE"), "operators see internal notes");
  await j("pm", "POST", "/api/pilot-ops/feedback", { kind: "NOPE", title: "x", body: "y" }, 400);
  pass("unknown feedback kind rejected");

  console.log("\n== 10. Pilot analytics + configured second server ==");
  const analytics = await j("funder", "GET", "/api/pilot-ops/analytics");
  assert(analytics.activeUsers.weekly >= 2, "weekly active users derive from sign-in history");
  assert(analytics.featureAdoption.length === 5 && analytics.pilotSuccess.length === 4, "adoption and success metrics reported");
  assert(analytics.usageTrackingEnabled === false, "usage tracking is off by default (no writes on reads)");
  assert(
    q1("SELECT COUNT(*) AS c FROM usage_events").c === 0,
    "usage_events stays empty with tracking disabled"
  );

  server2 = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...process.env,
      OBV_DATA_DIR: DATA_DIR,
      PORT: String(PORT2),
      OBV_BANKING_PROVIDER: "mock",
      OBV_BANKING_MODE: "demo",
      OBV_RATE_LIMIT_PER_MINUTE: "3",
      OBV_EMAIL_PROVIDER: "always-fail",
      OBV_USAGE_ANALYTICS: "1",
    },
    stdio: "ignore",
  });
  let healthy2 = false;
  for (let i = 0; i < 60 && !healthy2; i += 1) {
    try {
      healthy2 = (await fetch(`${BASE2}/api/health`)).ok;
    } catch {
      /* booting */
    }
    if (!healthy2) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!healthy2) fail("configured second server did not boot");
  await signIn("cfg", "user-funder", BASE2);
  await signIn("cfg", "user-funder", BASE2);
  await signIn("cfg", "user-funder", BASE2);
  const limited = await fetch(`${BASE2}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user-funder" }),
    redirect: "manual",
  });
  assert(limited.status === 429, "sign-in rate limit enforces the configured per-minute ceiling");
  const failedDigest = await j("cfg", "POST", "/api/pilot-ops/digest", { period: "WEEKLY" }, 200, BASE2);
  assert(failedDigest.email.status === "FAILED" && failedDigest.email.failureCategory === "PROVIDER_UNAVAILABLE", "provider failures are recorded with sanitized categories");
  await page("cfg", "/overview", BASE2);
  // The usage row is written in the response-finish callback; poll briefly.
  let usageRows = 0;
  for (let i = 0; i < 20 && usageRows === 0; i += 1) {
    usageRows = q1("SELECT COUNT(*) AS c FROM usage_events WHERE kind='PAGE_VIEW' AND path='/overview'").c;
    if (usageRows === 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(usageRows >= 1, "opt-in usage analytics records page views");
  server2.kill();
  server2 = null;

  console.log("\n== 11. Demo data generator ==");
  await j("funder", "POST", "/api/internal/demo-data", {}, 404);
  pass("demo generator is operator-only (404 elsewhere)");
  const governedForDemo = snapshot(["evidence_items", "ledger_entries", "approval_requests", "banking_events", "audit_packages", "reports"]);
  const demo = (await j("compliance", "POST", "/api/internal/demo-data", {}, 201)).summary;
  assert(demo.projects.length === 2 && demo.draws === 2 && demo.invoices === 6, "demo generator creates the demonstration portfolio");
  const demoNames = qa("SELECT name FROM projects WHERE id LIKE 'demo-gen-%'");
  assert(demoNames.length === 2 && demoNames.every((row) => row.name.startsWith("DEMO — ")), "every generated project is clearly marked DEMO");
  assertSnapshotEqual(governedForDemo, snapshot(["evidence_items", "ledger_entries", "approval_requests", "banking_events", "audit_packages", "reports"]),
    "the generator never creates evidence, ledger, approval, banking, package or report rows");
  await j("compliance", "POST", "/api/internal/demo-data", {}, 409);
  pass("second generation refused — demo data is idempotent");
  const complianceOverview = await j("compliance", "GET", "/api/portfolio/overview");
  assert(complianceOverview.totals.totalProjects === 4, "portfolio intelligence picks the demo projects up automatically");
  const fraud = await j("compliance", "GET", "/api/portfolio/fraud");
  assert(fraud.signals.some((signal) => signal.code === "DUPLICATE_INVOICE"), "the seeded duplicate invoice surfaces as a fraud example");

  console.log("\n== 12. Documentation set ==");
  const docs = [
    "docs/PILOT_DEPLOYMENT_GUIDE.md",
    "docs/ORGANIZATION_SETUP_GUIDE.md",
    "docs/USER_GUIDE.md",
    "docs/ADMINISTRATOR_GUIDE.md",
    "docs/SUPPORT_GUIDE.md",
    "docs/INTEGRATION_GUIDE.md",
    "docs/API_GUIDE.md",
    "docs/DISASTER_RECOVERY_GUIDE.md",
  ];
  for (const doc of docs) {
    const p = path.join(ROOT, doc);
    if (!fs.existsSync(p) || fs.readFileSync(p, "utf8").length < 1500) fail(`${doc} missing or too thin`);
  }
  pass("all eight administrator guides exist with substantive content");
  assert(
    fs.readFileSync(path.join(ROOT, "docs/DISASTER_RECOVERY_GUIDE.md"), "utf8").toLowerCase().includes("no restore"),
    "disaster recovery guide documents the no-automatic-restore posture"
  );

  console.log("\n== 13. Governed records byte-identical ==");
  assertSnapshotEqual(protectedBaseline, snapshot(PROTECTED),
    "banking, VAM, ledger, evidence, reports and package tables are byte-identical across the entire suite");
  const pages = ["/onboarding", "/admin", "/notifications", "/feedback"];
  for (const p of pages) {
    const res = await page("funder", p);
    if (res.status !== 200 || !/<h1>/.test(res.html)) fail(`page ${p} → ${res.status}`);
  }
  pass("onboarding, admin, notifications and feedback pages render");
  const internalPage = await page("compliance", "/internal");
  assert(internalPage.status === 200 && internalPage.html.includes("Internal operator console"), "internal console renders for operators");
  const internalDenied = await page("funder", "/internal");
  assert(internalDenied.status === 404, "internal console page is a 404 for lender users");

  console.log(`\nPILOT READINESS TESTS PASSED — ${passed} checkpoints.`);
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
    if (server2) server2.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });
