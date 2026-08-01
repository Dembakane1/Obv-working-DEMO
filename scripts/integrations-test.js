#!/usr/bin/env node
/**
 * Production Integrations Platform test battery.
 *
 * Proves the integrations layer is provider-neutral, observer-only, and
 * additive:
 *   0. static source guards (append-only audit, no vendor hostnames in
 *      business logic, export-only accounting, network only in webhooks)
 *   1. boot + primary-record baseline
 *   2. provider abstraction + double-consent refusal at startup
 *   3. email delivery abstraction (outbox provider, magic-link redaction)
 *   4. Teams adaptive-card payload generation (7 kinds)
 *   5. Outlook/ICS event generation + calendar + permit deadlines
 *   6. e-signature workflow (pending/signed/declined/expired, trail,
 *      same-404, role gates)
 *   7. accounting export sync (counts match SQL, links, tenancy)
 *   8. webhook framework: signatures, replay bound, idempotency,
 *      retries, dead-letter, requeue, org scoping, claim atomicity
 *   9. banking adapter selection stays safeguarded
 *  10. integration audit completeness + immutability
 *  11. authorization: anonymous 401, FIELD 403, cross-tenant 404
 *  12. primary records byte-identical after the entire suite
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PORT = 3255;
const RECEIVER_PORT = 3256;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-integrations-"));
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

// ------------------------------------------------------------- db utils

let db = null;
const q1 = (sql, ...args) => db.prepare(sql).get(...args);
const qa = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);

function tableHash(table) {
  const rows = qa(`SELECT * FROM ${table} ORDER BY 1`);
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const PRIMARY_TABLES = [
  "evidence_items", "verifications", "ledger_entries", "virtual_account_events",
  "reports", "audit_packages", "banking_events", "draw_requests", "budget_lines",
  "milestones", "projects", "users", "organizations", "approval_requests",
  "approval_records", "permits",
];

// ------------------------------------------------------- local receiver

const received = [];
let receiverFailures = 0; // fail the next N requests with HTTP 500
let receiver = null;

function startReceiver() {
  return new Promise((resolve) => {
    receiver = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({
          body,
          signature: String(req.headers["x-obv-signature"] ?? ""),
          event: String(req.headers["x-obv-event"] ?? ""),
          delivery: String(req.headers["x-obv-delivery"] ?? ""),
          timestamp: String(req.headers["x-obv-timestamp"] ?? ""),
        });
        if (receiverFailures > 0) {
          receiverFailures -= 1;
          res.writeHead(500);
        } else {
          res.writeHead(200);
        }
        res.end();
      });
    });
    receiver.listen(RECEIVER_PORT, () => resolve());
  });
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
  const files = {
    core: "src/server/services/integrations/core.ts",
    email: "src/server/services/integrations/email.ts",
    outlook: "src/server/services/integrations/outlook.ts",
    teams: "src/server/services/integrations/teamsIntegration.ts",
    esign: "src/server/services/integrations/esign.ts",
    accounting: "src/server/services/integrations/accounting.ts",
    calendar: "src/server/services/integrations/calendarSvc.ts",
    webhooks: "src/server/services/integrations/webhooks.ts",
    dashboard: "src/server/services/integrations/dashboard.ts",
    repo: "src/server/db/integrationsRepo.ts",
    routes: "src/server/http/integrationRoutes.ts",
  };
  const nonNetwork = Object.entries(files)
    .filter(([k]) => k !== "webhooks")
    .map(([, p]) => readSrc(p))
    .join("\n");
  assert(
    !/\bnode:https?\b|fetch\s*\(|axios|XMLHttpRequest|net\.connect/.test(nonNetwork),
    "network primitives exist ONLY in the webhook dispatcher"
  );
  const combined = Object.values(files).map(readSrc).join("\n");
  assert(
    !/api\.sendgrid|api\.mailgun|sesv2|api\.postmarkapp|graph\.microsoft|docusign\.net|sign\.dropbox|adobesign|quickbooks\.api|api\.xero|sage\.com/i.test(
      combined
    ),
    "no vendor API hostnames anywhere — adapters are named boundaries, not implementations"
  );
  assert(
    !/api[_-]?key|client[_-]?secret|bearer /i.test(combined),
    "no credential-shaped strings in the integrations layer"
  );

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
  const allSrc = walk(path.join(ROOT, "src"))
    .map((p) => fs.readFileSync(p, "utf8"))
    .join("\n");
  assert(
    !/UPDATE\s+integration_events|DELETE\s+FROM\s+integration_events/.test(allSrc),
    "integration_events is append-only across the entire codebase"
  );
  assert(
    !/UPDATE\s+esign_events|DELETE\s+FROM\s+esign_events/.test(allSrc),
    "esign_events is append-only across the entire codebase"
  );

  const accountingSrc = readSrc(files.accounting);
  const writeTargets = [...accountingSrc.matchAll(/INSERT INTO\s+(\w+)|UPDATE\s+(\w+)\s+SET|DELETE\s+FROM\s+(\w+)/g)];
  assert(writeTargets.length === 0, "accounting service contains no direct SQL writes at all (repo-only, export-only)");
  assert(/EXPORT-ONLY|EXPORT ONLY|export-only/i.test(accountingSrc), "accounting documents its export-only doctrine");
  const schemaSrc = readSrc("src/server/db/index.ts");
  assert(
    /direction TEXT NOT NULL DEFAULT 'EXPORT' CHECK \(direction IN \('EXPORT'\)\)/.test(schemaSrc),
    "accounting sync direction is constrained EXPORT at the database level"
  );
  for (const table of [
    "integration_events", "email_outbox", "esign_requests", "esign_events", "calendar_events",
    "webhook_endpoints", "webhook_deliveries", "accounting_sync_runs", "accounting_links",
  ]) {
    assert(schemaSrc.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `schema declares ${table}`);
  }
  const emailSrc = readSrc(files.email);
  assert((emailSrc.match(/disabledEmailProvider\("/g) ?? []).length === 5, "five email vendor adapters exist as disabled boundaries");
  assert(/REDACTION|credential-bearing/i.test(emailSrc), "credential-bearing email bodies are redacted by doctrine");
  assert((readSrc(files.esign).match(/disabledEsignProvider\("/g) ?? []).length === 3, "three e-sign vendor adapters exist as disabled boundaries");
  assert((readSrc(files.accounting).match(/disabledAccountingProvider\("/g) ?? []).length === 3, "three accounting vendor adapters exist as disabled boundaries");
  const webhooksSrc = readSrc(files.webhooks);
  assert(/timingSafeEqual/.test(webhooksSrc), "webhook signature verification is constant-time");
  assert(/SIGNATURE_TOLERANCE_SECONDS/.test(webhooksSrc), "webhook signatures carry a replay-bounding timestamp tolerance");
  const routesSrc = readSrc(files.routes);
  assert(/ever carries a secret/i.test(routesSrc), "routes document the no-secrets rule");
}

// ---------------------------------------------------------------- main

let server = null;

async function boot(extraEnv = {}) {
  const seed = spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
    stdio: "ignore",
  });
  if (seed.status !== 0) fail("seed failed");
  const child = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...process.env,
      OBV_DATA_DIR: DATA_DIR,
      PORT: String(PORT),
      OBV_BANKING_PROVIDER: "mock",
      OBV_BANKING_MODE: "demo",
      // The battery's webhook receiver runs on loopback, which the SSRF
      // egress guard refuses by default. This is the documented local
      // escape hatch; section 8 proves the guard is on without it.
      OBV_WEBHOOK_ALLOW_PRIVATE_HOSTS: "1",
      ...extraEnv,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("server did not become healthy");
  return child;
}

function bootRefused(extraEnv, needle, label) {
  const res = spawnSync(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...process.env,
      OBV_DATA_DIR: DATA_DIR,
      PORT: String(PORT + 10),
      OBV_BANKING_PROVIDER: "mock",
      OBV_BANKING_MODE: "demo",
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert(res.status === 1 && new RegExp(needle).test(String(res.stderr)), label);
}

async function main() {
  staticGuards();

  console.log("\n== 1. Boot + baseline ==");
  server = await boot();
  pass("server healthy");
  await startReceiver();
  pass("local webhook receiver listening");
  // Point in-process dist requires (used for the claim-atomicity and
  // signature-verifier checks) at this suite's disposable database BEFORE
  // any dist module resolves its data directory.
  process.env.OBV_DATA_DIR = DATA_DIR;
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(DATA_DIR, "obv.db"));
  const baseline = {};
  for (const t of PRIMARY_TABLES) baseline[t] = tableHash(t);
  baseline_count_banking = q1("SELECT COUNT(*) AS c FROM banking_events").c;
  pass("primary-record baseline captured");
  await signIn("pm", "user-pm");
  await signIn("funder", "user-funder");
  await signIn("field", "user-field");
  await signIn("dmvpm", "user-dmv-pm");
  pass("seeded users signed in");
  const pmOrg = q1("SELECT organization_id AS o FROM users WHERE id = 'user-pm'").o;

  // ------------------------------------------------------------ section 2
  console.log("\n== 2. Provider abstraction ==");
  const dash = await j("pm", "GET", "/api/integrations/dashboard");
  assert(dash.providers.length === 7, "dashboard reports seven provider categories");
  const emailCard = dash.providers.find((p) => p.category === "EMAIL");
  assert(emailCard.provider === "outbox" && emailCard.status === "ACTIVE", "email provider defaults to the outbox (ACTIVE)");
  assert(emailCard.alternatives.length === 5, "five email vendor alternatives are declared ready");
  const bankingCard = dash.providers.find((p) => p.category === "BANKING");
  assert(bankingCard.provider === "MOCK" && bankingCard.status === "ACTIVE", "banking stays MOCK by default");
  assert(
    bankingCard.alternatives.join(",") === "Unit,Treasury Prime,Qolo",
    "banking declares Unit / Treasury Prime / Qolo adapter readiness"
  );
  assert(dash.providers.find((p) => p.category === "ESIGN").provider === "internal", "e-sign defaults to internal tracking");
  assert(dash.providers.find((p) => p.category === "ACCOUNTING").provider === "csv", "accounting defaults to CSV export");
  const dashJson = JSON.stringify(dash);
  assert(!/secret/i.test(dashJson), "dashboard payload contains no secret material");
  bootRefused(
    { OBV_EMAIL_PROVIDER: "sendgrid" },
    "OBV_INTEGRATIONS_PRODUCTION_ENABLE",
    "choosing a vendor email provider without the enablement switch refuses to start"
  );
  bootRefused(
    { OBV_EMAIL_PROVIDER: "gmail" },
    "OBV_EMAIL_PROVIDER",
    "an unknown email provider name refuses to start"
  );

  // ------------------------------------------------------------ section 3
  console.log("\n== 3. Email delivery abstraction ==");
  const sent = await j("pm", "POST", "/api/integrations/email/test", { to: "ops@lender.example" }, 201);
  assert(sent.email.status === "SENT" && sent.email.provider === "outbox", "test email recorded and sent via the outbox provider");
  assert(sent.email.kind === "EXECUTIVE_SUMMARY", "test email uses a declared message kind");
  const badRecipient = await api("pm", "POST", "/api/integrations/email/test", { to: "not-an-email" });
  assert(badRecipient.status === 400, "an invalid recipient is rejected");
  // Magic-link redaction: invite a fresh person, then request a sign-in link.
  const org = (await j("pm", "POST", "/api/pilot/orgs", { name: "Integration Lender", kind: "LENDER" }, 201)).organization;
  const inv = await j("pm", "POST", "/api/pilot/invitations", {
    email: "iris@integration.example", organizationId: org.id, role: "FUNDER_REP",
  }, 201);
  const acceptRes = await fetch(`${BASE}/api/invitations/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: inv.activationLink.split("/invite/")[1], name: "Iris Vance", title: "Analyst" }),
  });
  assert(acceptRes.status === 201, "invitation accepted (fresh identity)");
  // The invitation setup above legitimately wrote users/organizations via
  // the PILOT layer. Re-baseline those two tables here: everything after
  // this point exercises only integrations, which must never touch them.
  baseline.users = tableHash("users");
  baseline.organizations = tableHash("organizations");
  await fetch(`${BASE}/api/auth/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "iris@integration.example" }),
  });
  const linkRow = q1("SELECT * FROM email_outbox WHERE kind = 'MAGIC_LINK' ORDER BY created_at DESC LIMIT 1");
  assert(Boolean(linkRow), "magic-link sign-in records a companion outbox entry");
  assert(
    /withheld/.test(linkRow.body_text) && !/token=/.test(linkRow.body_text),
    "…with a REDACTED body — no raw link ever lands in the database"
  );
  const fileOutbox = fs.readFileSync(path.join(DATA_DIR, "auth-outbox.jsonl"), "utf8");
  assert(/token=/.test(fileOutbox), "the raw link still travels through the identity delivery seam");

  // ------------------------------------------------------------ section 4
  console.log("\n== 4. Teams payload generation ==");
  const kinds = ["DRAW_SUBMITTED", "DRAW_APPROVED", "DISPUTE_OPENED", "INSPECTION_COMPLETED", "FRAUD_ALERT", "PORTFOLIO_ALERT", "EXECUTIVE_SUMMARY"];
  for (const kind of kinds) {
    const preview = await j("pm", "POST", "/api/integrations/teams/preview", {
      kind, title: `${kind} test`, projectName: "Riverside", amount: "$25,000",
    });
    const card = preview.card;
    const content = card.attachments[0].content;
    assert(
      card.type === "message" &&
        card.attachments[0].contentType === "application/vnd.microsoft.card.adaptive" &&
        content.version === "1.5" &&
        JSON.stringify(content.body).includes(`${kind} test`),
      `adaptive card built for ${kind}`
    );
  }
  const fraudPreview = await j("pm", "POST", "/api/integrations/teams/preview", { kind: "FRAUD_ALERT", title: "Duplicate invoice" });
  assert(
    JSON.stringify(fraudPreview.card).includes("Advisory only"),
    "fraud/portfolio cards carry the advisory-only statement in the payload itself"
  );
  const badKind = await api("pm", "POST", "/api/integrations/teams/preview", { kind: "NOPE", title: "x" });
  assert(badKind.status === 400, "unknown Teams event kind is rejected");

  // ------------------------------------------------------------ section 5
  console.log("\n== 5. Calendar + Outlook/ICS ==");
  const inspection = (await j("pm", "POST", "/api/integrations/calendar", {
    kind: "INSPECTION", title: "Footing, north; phase 1", startsAt: "2026-08-12T14:00:00Z",
    endsAt: "2026-08-12T15:00:00Z", projectId: "proj-r47", location: "Site office",
  }, 201)).event;
  pass("inspection scheduled");
  const drawReview = (await j("pm", "POST", "/api/integrations/calendar", {
    kind: "DRAW_REVIEW", title: "Draw 2 review", startsAt: "2026-08-14T10:00:00Z",
  }, 201)).event;
  pass("draw review scheduled");
  const icsRes = await api("pm", "GET", `/api/integrations/calendar/${inspection.id}.ics`);
  const ics = await icsRes.text();
  assert(icsRes.status === 200 && icsRes.headers.get("content-type").includes("text/calendar"), "ICS served with the calendar content type");
  assert(ics.includes("BEGIN:VCALENDAR") && ics.includes(`UID:obv-${inspection.id}`), "ICS carries the calendar envelope and stable UID");
  assert(ics.includes("Footing\\, north\\; phase 1"), "ICS escapes RFC 5545 special characters");
  assert(ics.includes("DTSTART:20260812T140000Z") && ics.includes("DTEND:20260812T150000Z"), "ICS times are correct UTC stamps");
  const badTime = await api("pm", "POST", "/api/integrations/calendar", { kind: "REMINDER", title: "x", startsAt: "not-a-date" });
  assert(badTime.status === 400, "invalid start time rejected");
  const badRange = await api("pm", "POST", "/api/integrations/calendar", {
    kind: "REMINDER", title: "x", startsAt: "2026-08-12T15:00:00Z", endsAt: "2026-08-12T14:00:00Z",
  });
  assert(badRange.status === 400, "end-before-start rejected");
  const foreignProject = await api("funder", "POST", "/api/integrations/calendar", {
    kind: "INSPECTION", title: "x", startsAt: "2026-08-12T14:00:00Z", projectId: "proj-r47",
  });
  assert([403, 404].includes(foreignProject.status), "scheduling against a foreign project is refused");
  const crossIcs = await api("funder", "GET", `/api/integrations/calendar/${inspection.id}.ics`);
  assert(crossIcs.status === 404, "another tenant's event ICS is a plain 404 (same-404)");
  await j("pm", "POST", `/api/integrations/calendar/${drawReview.id}/complete`, {});
  assert(
    q1("SELECT status AS s FROM calendar_events WHERE id = ?", drawReview.id).s === "COMPLETED",
    "event completion recorded"
  );
  const dmvDeadlines = (await j("dmvpm", "GET", "/api/integrations/calendar/permit-deadlines")).deadlines;
  assert(dmvDeadlines.length >= 1, `permit deadlines derived for the DMV pilot (${dmvDeadlines.length})`);
  assert(
    dmvDeadlines.every((d) => {
      const p = q1("SELECT * FROM permits WHERE id = ?", d.permitId);
      return p && p.expires_at === d.expiresAt && p.permit_number === d.permitNumber;
    }),
    "every suggested deadline traces to a real permit row with that expiry"
  );
  // Scheduling one removes it from the suggestions (derived, not stored).
  const firstDeadline = dmvDeadlines[0];
  await j("dmvpm", "POST", "/api/integrations/calendar", {
    kind: "PERMIT_DEADLINE", title: `Permit ${firstDeadline.permitNumber} expiry`,
    startsAt: firstDeadline.expiresAt, subjectType: "permit", subjectId: firstDeadline.permitId,
  }, 201);
  const remaining = (await j("dmvpm", "GET", "/api/integrations/calendar/permit-deadlines")).deadlines;
  assert(
    remaining.every((d) => d.permitId !== firstDeadline.permitId),
    "a scheduled permit deadline leaves the suggestion list"
  );

  // ------------------------------------------------------------ section 6
  console.log("\n== 6. E-signature workflow ==");
  const waiver = (await j("pm", "POST", "/api/integrations/esign", {
    kind: "LIEN_WAIVER", title: "M2 conditional lien waiver", signerName: "Kofi Mensah",
    signerEmail: "kofi@contractor.example", projectId: "proj-r47", documentRef: "report:draw-2",
  }, 201)).request;
  assert(waiver.status === "PENDING" && waiver.provider === "internal", "signature request created PENDING via internal provider");
  const detail0 = await j("pm", "GET", `/api/integrations/esign/${waiver.id}`);
  assert(
    detail0.trail.map((t) => t.kind).join(",") === "CREATED,SENT",
    "creation trail records CREATED then SENT"
  );
  // Same-millisecond events must still read back in INSERTION order: ids
  // are random UUIDs, so a timestamp tie broken by id would shuffle the
  // trail on a fast machine (this is exactly what CI hit).
  const tiedAt = "2030-01-01T00:00:00.000Z";
  for (const kind of ["REMINDED", "SIGNED", "DECLINED"]) {
    run(
      "INSERT INTO esign_events (id, request_id, occurred_at, actor_user_id, kind, detail) VALUES (?, ?, ?, NULL, ?, 'tie')",
      crypto.randomUUID(), waiver.id, tiedAt, kind
    );
  }
  const tiedTrail = (await j("pm", "GET", `/api/integrations/esign/${waiver.id}`)).trail
    .filter((t) => t.detail === "tie")
    .map((t) => t.kind)
    .join(",");
  assert(
    tiedTrail === "REMINDED,SIGNED,DECLINED",
    "identical timestamps still read back in insertion order (stable trail, no id shuffle)"
  );
  run("DELETE FROM esign_events WHERE detail = 'tie'");
  const signed = (await j("pm", "POST", `/api/integrations/esign/${waiver.id}/signed`, {})).request;
  assert(signed.status === "SIGNED" && signed.completedAt !== null, "request settles SIGNED with completion time");
  const doubleSettle = await api("pm", "POST", `/api/integrations/esign/${waiver.id}/declined`, {});
  assert(doubleSettle.status === 409, "a settled request cannot settle again (guarded transition)");
  const declineReq = (await j("pm", "POST", "/api/integrations/esign", {
    kind: "APPROVAL_ACKNOWLEDGEMENT", title: "Ack draw 2", signerName: "Ama Boateng", signerEmail: "ama@lender.example",
  }, 201)).request;
  const declined = (await j("pm", "POST", `/api/integrations/esign/${declineReq.id}/declined`, { detail: "terms disputed" })).request;
  assert(declined.status === "DECLINED", "declined path recorded");
  const expiring = (await j("pm", "POST", "/api/integrations/esign", {
    kind: "COMPLETION_CERTIFICATE", title: "M3 completion cert", signerName: "Lena Okafor", signerEmail: "lena@lender.example",
  }, 201)).request;
  run("UPDATE esign_requests SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?", expiring.id);
  const listed = (await j("pm", "GET", "/api/integrations/esign")).requests;
  assert(listed.find((r) => r.id === expiring.id).status === "EXPIRED", "overdue requests expire on read");
  assert(
    qa("SELECT * FROM esign_events WHERE request_id = ? AND kind = 'EXPIRED'", expiring.id).length === 1,
    "expiry lands once in the append-only trail"
  );
  const crossTenant = await api("funder", "GET", `/api/integrations/esign/${waiver.id}`);
  assert(crossTenant.status === 404, "another tenant's request is a plain 404 (same-404)");
  const fieldCreate = await api("field", "POST", "/api/integrations/esign", {
    kind: "OTHER", title: "x", signerName: "y", signerEmail: "y@z.example",
  });
  assert(fieldCreate.status === 403, "FIELD role cannot create signature requests");
  const esignAudit = qa("SELECT * FROM integration_events WHERE category = 'ESIGN'");
  assert(esignAudit.length >= 4 && esignAudit.every((e) => e.request_id && e.provider && e.operation && e.outcome), "every e-sign action recorded provider, operation, request id, outcome");
  assert(esignAudit.some((e) => e.actor_user_id === "user-pm" && e.organization_id === pmOrg), "e-sign audit attributes actor and organization");

  // ------------------------------------------------------------ section 7
  console.log("\n== 7. Accounting export sync ==");
  const exportResult = await j("pm", "POST", "/api/integrations/accounting/export", {}, 201);
  assert(exportResult.run.status === "SUCCEEDED" && exportResult.run.direction === "EXPORT", "export run succeeds, direction EXPORT");
  const fileByName = Object.fromEntries(exportResult.files.map((f) => [f.filename, f]));
  const csvIds = (csv) => csv.trim().split("\n").slice(1).map((l) => l.split(",")[0]).filter(Boolean);
  const pmIds = csvIds(fileByName["projects.csv"].csv);
  assert(pmIds.length > 0 && pmIds.length === fileByName["projects.csv"].rows, `export projects the caller's visible set (${pmIds.length})`);
  const marks = pmIds.map(() => "?").join(",");
  const expectedBudgets = q1(`SELECT COUNT(*) AS c FROM budget_lines WHERE active = 1 AND project_id IN (${marks})`, ...pmIds).c;
  assert(fileByName["budgets.csv"].rows === expectedBudgets, `budgets.csv rows match SQL over exported projects (${expectedBudgets})`);
  const expectedInvoices = q1(`SELECT COUNT(*) AS c FROM draw_requests WHERE project_id IN (${marks})`, ...pmIds).c;
  assert(fileByName["invoices.csv"].rows === expectedInvoices, `invoices.csv rows match draw requests (${expectedInvoices})`);
  const expectedPayments = q1(
    `SELECT COUNT(*) AS c FROM virtual_account_events e JOIN milestones m ON m.id = e.milestone_id
     WHERE e.type = 'RELEASED' AND m.project_id IN (${marks})`, ...pmIds
  ).c;
  assert(fileByName["payments.csv"].rows === expectedPayments, `payments.csv rows match RELEASED events (${expectedPayments})`);
  const header = fileByName["projects.csv"].csv.split("\n")[0];
  assert(header.startsWith("id,name,status"), "CSV files carry a deterministic header row");
  const linkCount = q1("SELECT COUNT(*) AS c FROM accounting_links WHERE provider = 'csv'").c;
  assert(linkCount > 0, "accounting links recorded for exported entities");
  await j("pm", "POST", "/api/integrations/accounting/export", {}, 201);
  assert(
    q1("SELECT COUNT(*) AS c FROM accounting_links WHERE provider = 'csv'").c === linkCount,
    "re-export upserts links — no duplicates"
  );
  const otherExport = await j("dmvpm", "POST", "/api/integrations/accounting/export", {}, 201);
  const otherIds = csvIds(otherExport.files.find((f) => f.filename === "projects.csv").csv);
  assert(otherIds.length > 0, `another tenant's export covers its own visible set (${otherIds.length})`);
  // Tenancy proof against the live authorization layer: every exported
  // project is one the caller can actually open, and a project outside
  // the caller's tenancy never appears in their export.
  for (const id of otherIds.slice(0, 3)) {
    const page = await api("dmvpm", "GET", `/project/${id}`);
    if (page.status !== 200) fail(`exported project ${id} not visible to its exporter (${page.status})`);
  }
  pass("every exported project is visible to its exporter");
  const pmOnly = pmIds.find((id) => !otherIds.includes(id));
  if (pmOnly) {
    const foreign = await api("dmvpm", "GET", `/project/${pmOnly}`);
    assert(foreign.status === 404, "a project outside the exporter's tenancy is absent from their export and 404 to them");
  } else {
    pass("tenant scopes overlap fully in this seed (foreign-project probe skipped)");
  }
  const fieldExport = await api("field", "POST", "/api/integrations/accounting/export", {});
  assert(fieldExport.status === 403, "FIELD role cannot run accounting exports");
  assert(
    qa("SELECT * FROM integration_events WHERE category = 'ACCOUNTING' AND outcome = 'SUCCESS'").length >= 2,
    "accounting syncs audited"
  );

  // ------------------------------------------------------------ section 8
  console.log("\n== 8. Webhook framework ==");
  const reg = await j("pm", "POST", "/api/integrations/webhooks", {
    url: `http://127.0.0.1:${RECEIVER_PORT}/hook`, description: "test sink", events: "*",
  }, 201);
  assert(/^[a-f0-9]{48}$/.test(reg.secret), "registration returns the signing secret exactly once");
  const secret = reg.secret;
  const endpoints = (await j("pm", "GET", "/api/integrations/webhooks")).endpoints;
  assert(endpoints.length === 1 && endpoints[0].secret === undefined, "endpoint listings never carry the secret");
  assert(
    !JSON.stringify(await j("pm", "GET", "/api/integrations/dashboard")).includes(secret),
    "the dashboard never leaks the signing secret"
  );
  const emit1 = await j("pm", "POST", "/api/integrations/webhooks/emit-test", { eventKind: "portfolio.alert", eventId: "evt-idem" });
  assert(emit1.queued === 1, "event enqueued for the subscribed endpoint");
  const emit2 = await j("pm", "POST", "/api/integrations/webhooks/emit-test", { eventKind: "portfolio.alert", eventId: "evt-idem" });
  assert(emit2.queued === 0, "re-emitting the same event id enqueues nothing (idempotency)");
  const d1 = await j("pm", "POST", "/api/integrations/webhooks/dispatch", {});
  assert(d1.attempted === 1 && d1.delivered === 1, "dispatch delivers the queued event");
  const hit = received[received.length - 1];
  assert(hit.event === "portfolio.alert" && hit.delivery.length > 0, "delivery carries event and delivery-id headers");
  const sigMatch = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(hit.signature);
  assert(Boolean(sigMatch), "delivery is signed (t=…,v1=…)");
  const expectedMac = crypto.createHmac("sha256", secret).update(`${sigMatch[1]}.${hit.body}`).digest("hex");
  assert(expectedMac === sigMatch[2], "signature verifies against the registration secret and exact body");
  const tamperedMac = crypto.createHmac("sha256", secret).update(`${sigMatch[1]}.${hit.body}x`).digest("hex");
  assert(tamperedMac !== sigMatch[2], "a tampered body cannot reuse the signature");
  const wh = require(path.join(ROOT, "dist/server/services/integrations/webhooks.js"));
  assert(wh.verifyWebhookSignature(secret, hit.signature, hit.body, Number(sigMatch[1]) + 10), "receiver-side verifier accepts a fresh signature");
  assert(
    !wh.verifyWebhookSignature(secret, hit.signature, hit.body, Number(sigMatch[1]) + 10_000),
    "…and rejects the same capture replayed outside the tolerance window (replay protection)"
  );
  assert(!wh.verifyWebhookSignature(secret, hit.signature, hit.body + "x", Number(sigMatch[1]) + 10), "…and rejects a modified body");
  // retries → dead letter → requeue → delivered
  receiverFailures = 99;
  await j("pm", "POST", "/api/integrations/webhooks/emit-test", { eventKind: "fraud.alert", eventId: "evt-retry" });
  let delivery = null;
  for (let i = 0; i < 5; i += 1) {
    run("UPDATE webhook_deliveries SET next_attempt_at = '2020-01-01T00:00:00Z' WHERE event_id = 'evt-retry' AND status IN ('QUEUED','RETRY')");
    await j("pm", "POST", "/api/integrations/webhooks/dispatch", {});
    delivery = q1("SELECT * FROM webhook_deliveries WHERE event_id = 'evt-retry'");
    if (delivery.status === "DEAD_LETTER") break;
  }
  assert(delivery.status === "DEAD_LETTER" && delivery.attempt_count === 5, "after five failed attempts the delivery dead-letters");
  assert(
    qa("SELECT * FROM integration_events WHERE category = 'WEBHOOK' AND outcome = 'DEAD_LETTER'").length >= 1,
    "dead-lettering is audited"
  );
  const midRetry = q1("SELECT * FROM webhook_deliveries WHERE event_id = 'evt-retry'");
  assert(midRetry.last_error !== null && midRetry.last_status_code === 500, "failure detail retained for diagnosis");
  receiverFailures = 0;
  await j("pm", "POST", `/api/integrations/webhooks/deliveries/${delivery.id}/requeue`, {});
  run("UPDATE webhook_deliveries SET next_attempt_at = '2020-01-01T00:00:00Z' WHERE id = ?", delivery.id);
  await j("pm", "POST", "/api/integrations/webhooks/dispatch", {});
  assert(
    q1("SELECT status AS s FROM webhook_deliveries WHERE id = ?", delivery.id).s === "DELIVERED",
    "a requeued dead-letter delivers once the receiver recovers"
  );
  // A requeue must restore a FULL attempt budget: with the counter left
  // at the maximum, one more failure would immediately re-dead-letter.
  receiverFailures = 99;
  await j("pm", "POST", "/api/integrations/webhooks/emit-test", { eventKind: "draw.approved", eventId: "evt-budget" });
  for (let i = 0; i < 6; i += 1) {
    run("UPDATE webhook_deliveries SET next_attempt_at = '2020-01-01T00:00:00Z' WHERE event_id = 'evt-budget' AND status IN ('QUEUED','RETRY')");
    await j("pm", "POST", "/api/integrations/webhooks/dispatch", {});
    if (q1("SELECT status AS s FROM webhook_deliveries WHERE event_id = 'evt-budget'").s === "DEAD_LETTER") break;
  }
  const budgetRow = q1("SELECT * FROM webhook_deliveries WHERE event_id = 'evt-budget'");
  assert(budgetRow.status === "DEAD_LETTER", "second delivery dead-letters after its budget");
  await j("pm", "POST", `/api/integrations/webhooks/deliveries/${budgetRow.id}/requeue`, {});
  const requeued = q1("SELECT * FROM webhook_deliveries WHERE id = ?", budgetRow.id);
  assert(
    requeued.status === "RETRY" && requeued.attempt_count === 0,
    "requeue resets the attempt counter — a fresh budget, not one last try"
  );
  run("UPDATE webhook_deliveries SET next_attempt_at = '2020-01-01T00:00:00Z' WHERE id = ?", budgetRow.id);
  await j("pm", "POST", "/api/integrations/webhooks/dispatch", {});
  assert(
    q1("SELECT status AS s FROM webhook_deliveries WHERE id = ?", budgetRow.id).s === "RETRY",
    "…so one further failure retries rather than re-dead-lettering"
  );
  receiverFailures = 0;
  // claim atomicity: the same due delivery cannot be claimed twice
  await j("pm", "POST", "/api/integrations/webhooks/emit-test", { eventKind: "draw.submitted", eventId: "evt-claim" });
  const claimRow = q1("SELECT * FROM webhook_deliveries WHERE event_id = 'evt-claim'");
  const irepo = require(path.join(ROOT, "dist/server/db/integrationsRepo.js"));
  const t0 = new Date().toISOString();
  const later = new Date(Date.now() + 60_000).toISOString();
  const claimA = irepo.claimWebhookDelivery(claimRow.id, t0, later);
  const claimB = irepo.claimWebhookDelivery(claimRow.id, t0, later);
  assert(claimA === true && claimB === false, "concurrent claims: exactly one dispatcher wins (atomic claim)");
  // org scoping: another tenant's endpoint never sees this org's events
  const otherReg = await j("dmvpm", "POST", "/api/integrations/webhooks", {
    url: `http://127.0.0.1:${RECEIVER_PORT}/other`, events: "*",
  }, 201);
  const before = q1("SELECT COUNT(*) AS c FROM webhook_deliveries WHERE endpoint_id = ?", otherReg.endpoint.id).c;
  await j("pm", "POST", "/api/integrations/webhooks/emit-test", { eventKind: "portfolio.alert", eventId: "evt-scope" });
  assert(
    q1("SELECT COUNT(*) AS c FROM webhook_deliveries WHERE endpoint_id = ?", otherReg.endpoint.id).c === before,
    "webhook fan-out is tenant-scoped — another organization's endpoint receives nothing"
  );
  const crossRequeue = await api("dmvpm", "POST", `/api/integrations/webhooks/deliveries/${delivery.id}/requeue`, {});
  assert(crossRequeue.status === 404, "another tenant's delivery is a plain 404 (same-404)");
  // esign + calendar domain events flow through the framework (now that
  // an endpoint is subscribed, real actions enqueue deliveries).
  const hookAck = (await j("pm", "POST", "/api/integrations/esign", {
    kind: "OTHER", title: "Webhook ack", signerName: "Sam Ellis", signerEmail: "sam@lender.example",
  }, 201)).request;
  await j("pm", "POST", `/api/integrations/esign/${hookAck.id}/signed`, {});
  await j("pm", "POST", "/api/integrations/calendar", {
    kind: "LENDER_MEETING", title: "Hook check", startsAt: "2026-08-20T09:00:00Z",
  }, 201);
  const domainDeliveries = qa("SELECT DISTINCT event_kind FROM webhook_deliveries").map((r) => r.event_kind);
  assert(
    domainDeliveries.includes("esign.completed") && domainDeliveries.includes("calendar.scheduled"),
    "real domain events (esign.completed, calendar.scheduled) entered the queue"
  );
  const badHook = await api("pm", "POST", "/api/integrations/webhooks", { url: "ftp://nope", events: "*" });
  assert(badHook.status === 400, "non-http(s) endpoint URLs are rejected");
  const badEvent = await api("pm", "POST", "/api/integrations/webhooks/emit-test", { eventKind: "not.a.kind" });
  assert(badEvent.status === 400, "unknown webhook event kinds are rejected");

  // ---- SSRF egress boundary (server-side request forgery) ----
  const guard = require(path.join(ROOT, "dist/server/services/integrations/webhooks.js"));
  const blocked = [
    "http://127.0.0.1:6379/", "http://localhost/hook", "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/x", "http://192.168.1.10/x", "http://172.16.4.4/x", "http://[::1]/x",
    "http://0.0.0.0/x", "http://100.64.1.1/x", "http://svc.internal/x",
  ];
  const savedFlag = process.env.OBV_WEBHOOK_ALLOW_PRIVATE_HOSTS;
  delete process.env.OBV_WEBHOOK_ALLOW_PRIVATE_HOSTS; // guard ON, as in production
  let allBlocked = true;
  for (const u of blocked) {
    try {
      guard.assertDeliverableUrl(u);
      allBlocked = false;
      console.error(`      (not blocked: ${u})`);
    } catch {
      /* expected */
    }
  }
  assert(allBlocked, `every loopback / private / link-local / metadata destination is refused (${blocked.length} forms)`);
  let publicOk = true;
  try {
    guard.assertDeliverableUrl("https://hooks.example.com/obv");
  } catch {
    publicOk = false;
  }
  assert(publicOk, "a public https receiver is accepted");
  let credsBlocked = false;
  try {
    guard.assertDeliverableUrl("https://user:pass@hooks.example.com/obv");
  } catch {
    credsBlocked = true;
  }
  assert(credsBlocked, "endpoint URLs embedding credentials are refused");
  if (savedFlag !== undefined) process.env.OBV_WEBHOOK_ALLOW_PRIVATE_HOSTS = savedFlag;
  // The running server has the dev flag set, so registration succeeds
  // there; without it the same URL is refused at the route.
  const guardedServer = spawnSync(
    process.execPath,
    ["-e", `process.env.OBV_WEBHOOK_ALLOW_PRIVATE_HOSTS='';const w=require(${JSON.stringify(path.join(ROOT, "dist/server/services/integrations/webhooks.js"))});try{w.assertDeliverableUrl('http://127.0.0.1:6379/');process.exit(0)}catch(e){process.exit(7)}`],
    { encoding: "utf8", env: { ...process.env, OBV_WEBHOOK_ALLOW_PRIVATE_HOSTS: "" } }
  );
  assert(guardedServer.status === 7, "with the dev flag unset, loopback registration is refused in a fresh process");
  // Delivery failures reach the dashboard, so their text must be a coarse
  // class, never a verbatim socket read-out of the host network.
  const failedDelivery = q1("SELECT last_error AS e FROM webhook_deliveries WHERE last_error IS NOT NULL LIMIT 1");
  assert(
    !failedDelivery || !/ECONN|EHOSTUNREACH|ENOTFOUND|127\.0\.0\.1|:\d{2,5}\b/.test(failedDelivery.e),
    "stored delivery errors are coarse labels — no socket codes, hosts, or ports"
  );

  // ------------------------------------------------------------ section 9
  console.log("\n== 9. Banking adapter selection ==");
  bootRefused(
    { OBV_BANKING_PROVIDER: "unit" },
    "refuses to start a non-mock banking provider",
    "selecting a non-mock banking provider without full production consent refuses to start"
  );
  assert(
    q1("SELECT COUNT(*) AS c FROM banking_events").c === baseline_count_banking,
    "no banking event was created by any integration action"
  );

  // ------------------------------------------------------------ section 10
  console.log("\n== 10. Integration audit ==");
  const audit = qa("SELECT * FROM integration_events");
  assert(audit.length >= 20, `integration audit populated (${audit.length} events)`);
  assert(
    audit.every((e) => e.provider && e.operation && e.request_id && e.outcome && e.occurred_at),
    "every audit event carries provider, operation, request id, outcome, timestamp"
  );
  const categories = new Set(audit.map((e) => e.category));
  for (const c of ["EMAIL", "ESIGN", "ACCOUNTING", "CALENDAR", "WEBHOOK"]) {
    assert(categories.has(c), `audit covers the ${c} category`);
  }
  const snapshot = audit.map((e) => JSON.stringify(e));
  await j("pm", "POST", "/api/integrations/email/test", { to: "again@lender.example" }, 201);
  const after = qa("SELECT * FROM integration_events");
  const byId = new Map(after.map((e) => [e.id, JSON.stringify(e)]));
  assert(
    snapshot.every((s) => byId.get(JSON.parse(s).id) === s),
    "no existing audit event was modified (append-only verified at runtime)"
  );
  assert(after.length > snapshot.length, "the audit log only ever grows");

  // ------------------------------------------------------------ section 11
  console.log("\n== 11. Authorization ==");
  const anon = await fetch(`${BASE}/api/integrations/dashboard`);
  assert(anon.status === 401, "anonymous API access is refused");
  const anonPage = await fetch(`${BASE}/integrations`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert([302, 303].includes(anonPage.status), "anonymous dashboard page redirects to sign-in");
  const fieldDash = await api("field", "GET", "/api/integrations/dashboard");
  assert(fieldDash.status === 403, "FIELD role cannot read the integrations dashboard");
  const fieldPage = await api("pm", "GET", "/integrations");
  assert(fieldPage.status === 200, "viewer roles load the dashboard page");

  // ---- dashboard tenant isolation (aggregates, not just detail rows) ----
  const pmDash = await j("pm", "GET", "/api/integrations/dashboard");
  const otherDash = await j("dmvpm", "GET", "/api/integrations/dashboard");
  const pmOrgId = q1("SELECT organization_id AS o FROM users WHERE id = 'user-pm'").o;
  const otherOrgId = q1("SELECT organization_id AS o FROM users WHERE id = 'user-dmv-pm'").o;
  assert(pmOrgId !== otherOrgId, "the two dashboard callers are in different organizations");
  assert(
    pmDash.lastEvents.every((e) => e.organizationId === pmOrgId || e.organizationId === null),
    "dashboard audit feed contains only the caller's organization"
  );
  assert(
    otherDash.lastEvents.every((e) => e.organizationId === otherOrgId || e.organizationId === null),
    "…and the same holds for the other tenant"
  );
  const pmEventIds = new Set(pmDash.lastEvents.map((e) => e.id));
  assert(
    otherDash.lastEvents.every((e) => !pmEventIds.has(e.id)),
    "the two tenants' audit feeds share no events (no cross-tenant leak)"
  );
  assert(
    pmDash.failures.every((e) => e.organizationId === pmOrgId || e.organizationId === null),
    "failure feed is tenant-scoped"
  );
  const globalSent = q1("SELECT COUNT(*) AS c FROM email_outbox WHERE status = 'SENT'").c;
  const pmSent = q1(
    "SELECT COUNT(*) AS c FROM email_outbox WHERE status = 'SENT' AND organization_id = ?", pmOrgId
  ).c;
  assert(globalSent > pmSent, "the database holds email outside the caller's organization (scoping is observable)");
  assert(pmDash.email.sent === pmSent, `email counters are tenant-scoped (${pmSent}, not the global ${globalSent})`);
  const globalQueue = q1("SELECT COUNT(*) AS c FROM webhook_deliveries WHERE status = 'DELIVERED'").c;
  const pmQueue = q1(
    `SELECT COUNT(*) AS c FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.status = 'DELIVERED' AND e.organization_id = ?`, pmOrgId
  ).c;
  assert(pmDash.webhooks.delivered === pmQueue, `webhook queue depth is tenant-scoped (${pmQueue} of ${globalQueue})`);
  assert(
    otherDash.webhooks.delivered !== pmDash.webhooks.delivered || pmQueue === 0,
    "the other tenant sees its own queue depth, not this one's"
  );
  // Manual dispatch must not drain (or report on) another tenant's queue.
  receiverFailures = 0;
  await j("dmvpm", "POST", "/api/integrations/webhooks/emit-test", { eventKind: "portfolio.alert", eventId: "evt-otherorg" });
  run("UPDATE webhook_deliveries SET next_attempt_at = '2020-01-01T00:00:00Z' WHERE event_id = 'evt-otherorg'");
  await j("pm", "POST", "/api/integrations/webhooks/emit-test", { eventKind: "portfolio.alert", eventId: "evt-ownorg" });
  run("UPDATE webhook_deliveries SET next_attempt_at = '2020-01-01T00:00:00Z' WHERE event_id = 'evt-ownorg'");
  const otherBefore = q1("SELECT * FROM webhook_deliveries WHERE event_id = 'evt-otherorg'");
  await j("pm", "POST", "/api/integrations/webhooks/dispatch", {});
  const otherAfter = q1("SELECT * FROM webhook_deliveries WHERE event_id = 'evt-otherorg'");
  const ownAfter = q1("SELECT * FROM webhook_deliveries WHERE event_id = 'evt-ownorg'");
  assert(ownAfter.attempt_count === 1, "manual dispatch attempted the caller's own due delivery");
  assert(
    otherAfter.attempt_count === otherBefore.attempt_count && otherAfter.status === otherBefore.status,
    "…and never touched the other organization's due delivery (dispatch is tenant-scoped)"
  );

  // ---- email redaction is enforced by kind, not caller opt-in ----
  const emailSvc = require(path.join(ROOT, "dist/server/services/integrations/email.js"));
  const beforeRows = q1("SELECT COUNT(*) AS c FROM email_outbox").c;
  emailSvc.sendEmail({
    kind: "MAGIC_LINK",
    to: "forgetful@lender.example",
    subject: "s",
    text: "https://obv.example/auth/complete?token=deadbeefdeadbeef",
    // containsCredential deliberately omitted — the KIND must still redact
  });
  assert(q1("SELECT COUNT(*) AS c FROM email_outbox").c === beforeRows + 1, "credential-kind email recorded");
  const forgetful = q1("SELECT * FROM email_outbox WHERE to_email = 'forgetful@lender.example'");
  assert(
    !/token=/.test(forgetful.body_text) && /withheld/.test(forgetful.body_text),
    "a caller that forgets the credential flag still cannot write a live link into the outbox"
  );

  // ------------------------------------------------------------ section 12
  console.log("\n== 12. Primary records untouched ==");
  for (const t of PRIMARY_TABLES) {
    assert(baseline[t] === tableHash(t), `${t} byte-identical after the entire integrations suite`);
  }

  console.log(`\nINTEGRATIONS PLATFORM TESTS PASSED — ${passed} checkpoints.`);
  console.log("INTEGRATIONS OBSERVE THE SYSTEM OF RECORD. THEY NEVER AUTHOR IT.");
}

let baseline_count_banking = 0;

main()
  .catch((err) => {
    console.error(err.stack ?? err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) server.kill();
    if (receiver) receiver.close();
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
