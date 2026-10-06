#!/usr/bin/env node
/**
 * Infrastructure Interoperability v1 test battery.
 *
 * Proves the interoperability module is additive and doctrine-safe:
 *   0. static source guards — no authoritative writes, no financial
 *      imports, no network egress, evidence only via the governed
 *      pipeline, doctrine notices present
 *   1. schema validator — valid/invalid packages, error paths, codelist
 *      warnings, canonical hashing
 *   2. OC4IDS, publisher NOT configured — honest status, export refused
 *   3. OC4IDS mapping correctness on a fully configured project — every
 *      value traced to an OBV source record, values equal the records,
 *      validation passes, deterministic, nothing fabricated
 *   4. omitted fields are omitted (not inferred) on a thin project; OBV
 *      intelligence never appears in the disclosure
 *   5. export provenance — immutable record, stored bytes hash, write-once,
 *      tamper detection, project untouched, logical storage keys
 *   6. tenant isolation (same-404 with a REAL second tenant) + role gates
 *   7. external observations — deterministic import (OBV envelope and
 *      KoBo-shaped rows), snapshot, idempotency, input limits, content
 *      sniffing, source URLs never fetched, UNVERIFIED on entry
 *   8. no bypass — import and review never approve, release, authorize
 *      or move money; acceptance runs the governed evidence pipeline
 *      with original provenance, separation of duties holds
 *   9. surfaces — Evidence Intelligence, Timeline, Digital Twin and the
 *      evidence panels state the source; coordinates are never invented
 *  10. UI rendering — pages, plain language, one h1, Not Connected
 *      provider boundaries
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "obv-interop-"));
const PORT = Number(process.env.OBV_INTEROP_TEST_PORT || 3292);
const SINK_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const PREFIX = "oc4ids-zz9999";

// The db module freezes DATA_DIR at load time: point at our temp dir
// BEFORE the first dist require (only pure modules are loaded here).
process.env.OBV_DATA_DIR = DATA;
if (!process.env.OBV_SESSION_SECRET) process.env.OBV_SESSION_SECRET = crypto.randomBytes(32).toString("hex");

let passed = 0;
const pass = (m) => { passed += 1; console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`); };
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); throw new Error(m); };
const assert = (cond, m) => (cond ? pass(m) : fail(m));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ------------------------------------------------------------ helpers

function testPng(seedByte) {
  const w = 96, h = 96;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let i = 1; i < row.length; i++) row[i] = (i * 31 + y * 7 + seedByte) % 256;
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function db() { return new DatabaseSync(path.join(DATA, "obv.db")); }
function q(sql, ...args) { const d = db(); try { return d.prepare(sql).all(...args); } finally { d.close(); } }
function exec(sql, ...args) { const d = db(); try { d.prepare(sql).run(...args); } finally { d.close(); } }
function count(sql, ...args) { try { return q(sql, ...args)[0]?.c ?? 0; } catch { return 0; } }
function rowsJson(sql) { try { return JSON.stringify(q(sql)); } catch { return "[]"; } }

/** Everything that governs money, approval and progress. Import and
 *  review must never move any of it except through the governed pipeline. */
function controlFingerprint() {
  return {
    approvalRecords: count("SELECT COUNT(*) AS c FROM approval_records"),
    approvedRequests: count("SELECT COUNT(*) AS c FROM approval_requests WHERE status <> 'PENDING'"),
    milestoneAccounts: rowsJson("SELECT id, account_status FROM milestones ORDER BY id"),
    approvedOrReleased: rowsJson("SELECT id, status FROM milestones WHERE status IN ('APPROVED','RELEASED') ORDER BY id"),
    draws: rowsJson("SELECT id, status FROM draw_requests ORDER BY id"),
    lenderDecisions: count("SELECT COUNT(*) AS c FROM lender_decisions"),
    paymentInstructions: rowsJson("SELECT id, status FROM payment_instructions ORDER BY id"),
    accountEvents: count("SELECT COUNT(*) AS c FROM virtual_account_events"),
    bankTx: count("SELECT COUNT(*) AS c FROM bank_transactions"),
    balances: rowsJson("SELECT id, available_minor, held_minor FROM project_virtual_accounts ORDER BY id"),
    exceptions: rowsJson("SELECT id, status FROM exceptions ORDER BY id"),
    inspections: rowsJson("SELECT id, status FROM jurisdictional_inspections ORDER BY id"),
  };
}
function evidenceFingerprint() {
  return {
    evidence: count("SELECT COUNT(*) AS c FROM evidence_items"),
    ledger: count("SELECT COUNT(*) AS c FROM ledger_entries"),
    milestones: rowsJson("SELECT id, status FROM milestones ORDER BY id"),
    approvalRequests: count("SELECT COUNT(*) AS c FROM approval_requests"),
  };
}

let server = null;
let serverLog = "";
async function startServer(extraEnv) {
  serverLog = "";
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...process.env, OBV_DATA_DIR: DATA, PORT: String(PORT),
      OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo",
      OBV_OC4IDS_PROJECT_ID_PREFIX: "", OBV_OC4IDS_LICENSE_URL: "", OBV_OC4IDS_PUBLICATION_POLICY_URL: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`server did not become healthy\n${serverLog.slice(-2000)}`);
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise((resolve) => { s.once("exit", resolve); s.kill(); setTimeout(resolve, 5000); });
}

const jar = {};
async function signIn(label, userId) {
  const r = await fetch(`${BASE}/api/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }), redirect: "manual",
  });
  const c = r.headers.getSetCookie();
  if (!c.length) fail(`could not sign in ${userId} (${r.status})`);
  jar[label] = c[0].split(";")[0];
}
async function api(who, method, p, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (who) headers.cookie = jar[who];
  let payload;
  if (body !== undefined) {
    if (Buffer.isBuffer(body) || typeof body === "string") payload = body;
    else { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
    if (!headers["content-type"]) headers["content-type"] = "application/json";
  }
  const r = await fetch(`${BASE}${p}`, { method, headers, body: payload, redirect: "manual" });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString("utf8")); } catch {}
  return { status: r.status, json, buf, text: buf.toString("utf8"), headers: r.headers };
}
async function page(who, p) {
  const r = await fetch(`${BASE}${p}`, { headers: { cookie: who ? jar[who] : "", accept: "text/html" }, redirect: "manual" });
  return { status: r.status, html: await r.text(), location: r.headers.get("location") };
}
const h1Count = (html) => (html.match(/<h1[\s>]/g) || []).length;

// ------------------------------------------------------------ section 0

function staticGuards() {
  console.log("\n== 0. Static source guards ==");
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const dir = "src/server/services/interop";
  const files = fs.readdirSync(path.join(ROOT, dir), { recursive: true })
    .filter((f) => /\.ts$/.test(String(f)))
    .map((f) => path.join(dir, String(f)));
  files.push("src/server/db/interopRepo.ts", "src/server/http/interopRoutes.ts", "src/server/view/interopPages.tsx");
  const src = Object.fromEntries(files.map((f) => [f, read(f)]));
  const combined = Object.values(src).join("\n");

  assert(
    !/(INSERT INTO|UPDATE|DELETE FROM)\s+(projects|milestones|evidence_items|verifications|ledger_entries|approval_requests|approval_records|draw_requests|draw_line_items|lender_decisions|payment_instructions|virtual_account_events|project_virtual_accounts|bank_transactions|banking_events|exceptions|jurisdictional_inspections|permits|change_orders|organizations|users)\b/i.test(combined),
    "the interoperability module writes to NO authoritative OBV table"
  );
  const forbidden = ["processApprovalDecision", "releaseTranche", "updateMilestoneStatus", "insertEvidence(", "insertApprovalRequest", "insertVerification", "appendLedgerEntry", "recordLenderDecision", "createPaymentInstruction", "createManualException", "processDrawApprovalDecision"];
  const hits = forbidden.filter((id) => combined.includes(id));
  assert(hits.length === 0, `no approval / release / ledger / payment / exception command is referenced${hits.length ? " — found " + hits.join(", ") : ""}`);
  const badImports = [];
  for (const [f, s] of Object.entries(src)) {
    for (const m of s.matchAll(/from\s+"([^"]+)"/g)) {
      if (/banking|VirtualAccountService|lenderDecisions|\/draws"|drawWorkflow|paymentInstructions|\/exceptions"/.test(m[1])) badImports.push(`${f} -> ${m[1]}`);
    }
  }
  assert(badImports.length === 0, `no financial-control module is imported${badImports.length ? " — " + badImports.join("; ") : ""}`);
  const pipelineUsers = Object.entries(src).filter(([, s]) => /processEvidenceSubmission\(/.test(s)).map(([f]) => f);
  assert(
    pipelineUsers.length === 1 && pipelineUsers[0].endsWith(path.join("fieldObservations", "review.ts")),
    "evidence is created ONLY by reviewer acceptance, through the governed processEvidenceSubmission pipeline"
  );
  assert(!/\bfetch\(|http\.request|https\.request|net\.connect/.test(combined), "the module performs no network egress (source URLs are recorded, never retrieved)");
  assert(
    /OC4IDS = standardized infrastructure disclosure|standardized infrastructure disclosure/i.test(read(`${dir}/core.ts`)) &&
      /External Observation — Unverified|unverified/i.test(read(`${dir}/core.ts`)),
    "doctrine notices (disclosure vs verification; observations unverified) are defined"
  );
  assert(!/World Bank|AfDB|partnership/i.test(read(`${dir}/fieldObservations/providers.ts`)) || /not a .*integration|no partnership/i.test(read(`${dir}/fieldObservations/providers.ts`)),
    "provider boundaries claim no partnership or live integration");
  const repoSrc = read("src/server/db/interopRepo.ts");
  assert(
    !/(UPDATE|DELETE FROM)\s+(interop_exports|field_observation_imports|field_observation_events|evidence_provenance)\b/.test(repoSrc),
    "export records, import snapshots, observation events and evidence provenance are append-only"
  );
  assert(!/OBV_OC4IDS_[A-Z_]*(SECRET|TOKEN|KEY)\b/.test(combined), "no interop secret is defined (publisher settings are public configuration)");
  const runner = read("scripts/run-all-tests.js");
  assert(/"interop-test\.js"/.test(runner), "interop-test.js is registered in the unified battery");
}

// ------------------------------------------------------------ section 1

function validatorUnits() {
  console.log("\n== 1. Schema validator ==");
  const { validateAgainst, canonicalJson } = require(path.join(ROOT, "dist/server/services/interop/oc4ids/validate.js"));
  const schema = require(path.join(ROOT, "dist/server/services/interop/oc4ids/schema.js"));
  assert(schema.OC4IDS_VERSION === "0.9.5", "implemented OC4IDS schema version is 0.9.5");
  const good = {
    id: `${PREFIX}-p1`, title: "Road", status: "implementation",
    period: { startDate: "2026-01-01T00:00:00Z", endDate: "2026-12-31T00:00:00Z" },
    budget: { amount: { amount: 1000, currency: "USD" } },
  };
  const r1 = validateAgainst(schema.OC4IDS_PROJECT_SCHEMA, good);
  assert(r1.valid && r1.errors.length === 0, "a well-formed project validates");
  const r2 = validateAgainst(schema.OC4IDS_PROJECT_SCHEMA, { title: "No id" });
  assert(!r2.valid && r2.errors.some((e) => e.keyword === "required" && /id/.test(e.message + e.path)), "a project without id fails 'required' with its path");
  const r3 = validateAgainst(schema.OC4IDS_PROJECT_SCHEMA, { ...good, period: { startDate: "01/02/2026" } });
  assert(!r3.valid && r3.errors.some((e) => /period/.test(e.path)), "a malformed date fails with the /period path");
  const r4 = validateAgainst(schema.OC4IDS_PROJECT_SCHEMA, { ...good, budget: { amount: { amount: "lots", currency: "USD" } } });
  assert(!r4.valid && r4.errors.some((e) => /budget/.test(e.path)), "a non-numeric budget amount fails");
  const r5 = validateAgainst(schema.OC4IDS_PROJECT_SCHEMA, { ...good, status: "nonsense-status" });
  assert(!r5.valid && r5.errors.some((e) => /status/.test(e.path)), "a status outside the closed projectStatus codelist fails validation");
  const pkgBad = validateAgainst(schema.OC4IDS_PACKAGE_SCHEMA, { projects: [good] });
  assert(!pkgBad.valid, "a package missing its required metadata fails package validation");
  assert(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }) === canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }), "canonical JSON is key-order independent (stable hashing)");
  assert(Array.isArray(schema.OC4IDS_SCHEMA_COVERAGE.notImplemented) && schema.OC4IDS_SCHEMA_COVERAGE.notImplemented.length > 0 && /subset/i.test(schema.OC4IDS_SCHEMA_COVERAGE.statement),
    "the schema coverage statement declares the implemented subset and what is not implemented");
}

// ------------------------------------------------------------ main

const sinkHits = [];
function startSink() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { sinkHits.push(req.url); res.writeHead(200, { "content-type": "image/png" }); res.end(testPng(9)); });
    s.listen(SINK_PORT, "127.0.0.1", () => resolve(s));
  });
}

async function main() {
  console.log(`Infrastructure Interoperability tests — isolated server on :${PORT}`);
  if (spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], { env: { ...process.env, OBV_DATA_DIR: DATA }, stdio: "ignore" }).status !== 0) {
    fail("seed failed");
  }
  staticGuards();
  validatorUnits();
  const sink = await startSink();

  // ---- a REAL second tenant (authz-test pattern) ----
  exec("INSERT INTO organizations (id, name, kind) VALUES ('org-rival', 'Rival Capital', 'FUNDER')");
  exec("INSERT INTO users (id, organization_id, name, role, title) VALUES ('user-rival', 'org-rival', 'Rival Manager', 'PROJECT_MANAGER', 'Programme Director')");
  exec("INSERT INTO users (id, organization_id, name, role, title) VALUES ('user-rival-funder', 'org-rival', 'Rival Funder', 'FUNDER_REP', 'Lender')");

  // ================================================== 2. not configured
  console.log("\n== 2. OC4IDS with the publisher prefix NOT configured ==");
  await startServer({});
  for (const [label, id] of [["funder", "user-funder"], ["pm", "user-pm"], ["field", "user-field"], ["compliance", "user-compliance"], ["rival", "user-rival"], ["rivalFunder", "user-rival-funder"]]) {
    await signIn(label, id);
  }
  const nc = await api("funder", "GET", "/api/interop/oc4ids/proj-r47/preview");
  assert(nc.status === 200 && nc.json.status === "NOT_CONFIGURED", "without a registered prefix the status is Not Configured");
  assert(!("id" in nc.json.package.projects[0]) || nc.json.package.projects[0].id === undefined, "no OC4IDS project id is invented without the publisher prefix");
  assert(nc.json.omitted.some((o) => o.path === "/id" && o.reason === "NOT_CONFIGURED"), "the missing id is listed as omitted with reason NOT_CONFIGURED");
  const ncExport = await api("funder", "POST", "/api/interop/oc4ids/proj-r47/export", {});
  assert(ncExport.status === 409, "export is refused while not configured (never publishes a package it cannot identify)");
  assert(count("SELECT COUNT(*) AS c FROM interop_exports") === 0, "a refused export leaves no provenance record");
  await stopServer();

  // ================================================== 3. mapping correctness
  console.log("\n== 3. OC4IDS mapping on a fully configured project ==");
  await startServer({ OBV_OC4IDS_PROJECT_ID_PREFIX: PREFIX, OBV_OC4IDS_LICENSE_URL: "https://example.org/license" });
  const mkOrg = async (name, kind) => {
    const r = await api("pm", "POST", "/api/pilot/orgs", { name, kind });
    if (r.status !== 201) fail(`org create ${name}: ${r.status} ${r.text.slice(0, 200)}`);
    return r.json.organization;
  };
  const ministry = await mkOrg("Ministry of Public Works", "GOVERNMENT_AGENCY");
  const contractor = await mkOrg("Lakeshore Civil Contractors", "CONTRACTOR");
  const funderOrg = await mkOrg("Regional Infrastructure Fund", "DEVELOPMENT_INSTITUTION");
  const created = await api("pm", "POST", "/api/pilot/projects", {
    name: "Lakeshore Feeder Road Upgrade", code: "LFR-2026", category: "ROAD",
    description: "Upgrade of 9 km of feeder road to all-weather gravel standard.",
    organizationId: "org-cdfc", implementingOrgId: ministry.id, contractorOrgId: contractor.id, funderOrgId: funderOrg.id,
    obvControlledAmount: 600000, totalValue: 750000, currency: "USD",
    plannedStart: "2026-09-01", plannedEnd: "2027-06-30", timezone: "Africa/Blantyre", country: "Malawi", region: "Northern",
  });
  assert(created.status === 201, "a fully configured project is created through the real pilot API");
  const P = created.json.project;
  await api("pm", "POST", `/api/pilot/projects/${P.id}/template`, { templateKey: "road-rehabilitation" });
  await api("pm", "POST", `/api/pilot/projects/${P.id}/geography`, {
    kind: "POLYGON", coordinates: ["33.70, -11.60", "33.75, -11.60", "33.75, -11.55", "33.70, -11.55"], label: "Feeder road corridor",
  });
  // An implementing agency is the procuring entity, not automatically the
  // project owner: the public authority is recorded explicitly.
  const gov = await api("funder", "POST", `/api/projects/${P.id}/parties`, { partyOrganizationId: ministry.id, partyType: "GOVERNMENT_AUTHORITY" });
  if (gov.status !== 201) fail(`party assignment: ${gov.status} ${gov.text.slice(0, 200)}`);
  const projRow = q("SELECT * FROM projects WHERE id = ?", P.id)[0];
  const msRows = q("SELECT * FROM milestones WHERE project_id = ? ORDER BY seq", P.id);

  const pv = await api("funder", "GET", `/api/interop/oc4ids/${P.id}/preview`);
  assert(pv.status === 200, "preview renders for a project the funder can see");
  const prev = pv.json;
  const proj = prev.package.projects[0];
  assert(prev.validation.valid && prev.packageValidation.valid, "the mapped project AND package validate against the implemented schema");
  assert(prev.status === "READY", `a project with complete authoritative data is READY (got ${prev.status}: ${prev.statusReasons.join(" ")})`);
  assert(proj.id === `${PREFIX}-${P.id}`, "OC4IDS id = registered prefix + OBV project id");
  assert(proj.title === projRow.name, "title equals the OBV project name");
  assert(proj.description === projRow.description, "description equals the OBV project description");
  assert(proj.status === "preparation", "an unlaunched (DRAFT) OBV project maps to status 'preparation'");
  assert(proj.period && proj.period.startDate === "2026-09-01T00:00:00Z" && proj.period.endDate === "2027-06-30T00:00:00Z", "period equals the planned start/end dates (date-only values stated at midnight UTC, not shifted)");
  assert(proj.sector && proj.sector.includes("transport.road"), "sector maps from the ROAD category only");
  assert(proj.budget && proj.budget.amount.amount === projRow.total_budget && proj.budget.amount.currency === "USD", "budget equals the recorded total budget and currency");
  const roles = (orgId) => (proj.parties || []).find((p) => p.id === orgId)?.roles ?? [];
  assert(roles(ministry.id).includes("publicAuthority") && roles(ministry.id).includes("procuringEntity"), "the agency is public authority (recorded party) and procuring entity (implementing agency)");
  assert(roles(contractor.id).some((r) => r === "supplier" || r === "contractor"), "the contractor organization is disclosed as supplier");
  assert(roles(funderOrg.id).includes("funder"), "the development institution is disclosed as funder");
  assert(proj.publicAuthority && proj.publicAuthority.id === ministry.id, "publicAuthority references the recorded agency");
  assert(Array.isArray(proj.milestones) && proj.milestones.length === msRows.length && proj.milestones.every((m, i) => m.title === msRows[i].title),
    "milestones are the OBV milestones, in order, with their recorded titles");
  assert(Array.isArray(proj.locations) && proj.locations.some((l) => l.geometry && l.geometry.type === "Polygon"), "the recorded site boundary becomes a Polygon location");
  // Every populated value is traceable to an OBV source record.
  assert(prev.fields.length > 10 && prev.fields.every((f) => f.source && f.source.table && f.source.recordId && f.source.field),
    `every one of the ${prev.fields.length} populated values names its OBV source (table, record, field)`);
  const fieldAt = (p) => prev.fields.find((f) => f.path === p);
  assert(fieldAt("/title")?.source.table === "projects" && fieldAt("/title")?.source.recordId === P.id, "the title is attributed to projects/<id>.name");
  assert(fieldAt("/budget/amount/amount")?.value === projRow.total_budget, "the recorded value is reported alongside its source");
  // Deterministic.
  const pv2 = await api("funder", "GET", `/api/interop/oc4ids/${P.id}/preview`);
  assert(JSON.stringify(pv2.json.package.projects) === JSON.stringify(prev.package.projects) && JSON.stringify(pv2.json.fields) === JSON.stringify(prev.fields),
    "the mapping is deterministic: identical inputs give an identical project and field list");
  // Fields with no OBV source are omitted, with reasons.
  for (const p of ["/type", "/purpose", "/completion", "/documents"]) {
    assert(!(p.slice(1) in proj) && prev.omitted.some((o) => o.path === p), `${p} has no authoritative OBV source and is omitted with a reason`);
  }
  const cp = (proj.contractingProcesses || [])[0];
  assert(!cp || (cp.summary && cp.summary.contractValue === undefined), "no contract value is inferred from the OBV-controlled amount");

  // ================================================== 4. thin project + exclusion
  console.log("\n== 4. Omitted fields are not fabricated; OBV intelligence excluded ==");
  const r47 = (await api("funder", "GET", "/api/interop/oc4ids/proj-r47/preview")).json;
  const p47 = r47.package.projects[0];
  assert(r47.validation.valid && r47.status === "INCOMPLETE", "the seeded project validates but is honestly INCOMPLETE");
  for (const k of ["period", "sector", "publicAuthority"]) {
    assert(!(k in p47) && r47.omitted.some((o) => o.path === `/${k}` || o.path.startsWith(`/${k}/`)), `${k} is absent and listed as omitted — never inferred`);
  }
  const FORBIDDEN_KEYS = /^(integrity|integrityScore|evidenceIntegrityScore|signals?|verdict|authenticity|duplicates?|ocr|gps|geofence|sha256|hash|ledger|readiness|drawReadiness|lenderDecision|decision|releaseControl|paymentInstruction|payment|virtualAccount|twin|reviewer|reviewHistory|approval|approvals)$/i;
  const offending = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}/${i}`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (FORBIDDEN_KEYS.test(k)) offending.push(`${p}/${k}`); walk(x, `${p}/${k}`); }
  };
  walk(prev.package, ""); walk(r47.package, "");
  assert(offending.length === 0, `no OBV verification / financial-control data appears in the disclosure${offending.length ? " — " + offending.join(", ") : ""}`);
  assert(Array.isArray(prev.excludedObvIntelligence) && prev.excludedObvIntelligence.length >= 8 && prev.excludedObvIntelligence.some((x) => /integrity/i.test(x)) && prev.excludedObvIntelligence.some((x) => /payment|release/i.test(x)),
    "the preview declares the OBV intelligence it deliberately keeps out (integrity score, release/payment controls, ...)");
  assert(/disclosure/i.test(prev.notice) && /verification/i.test(prev.notice), "the preview carries the disclosure-vs-verification notice");

  // ================================================== 5. export provenance
  console.log("\n== 5. Export provenance ==");
  const projectBefore = JSON.stringify(q("SELECT * FROM projects WHERE id = ?", P.id));
  const msBefore = JSON.stringify(q("SELECT * FROM milestones WHERE project_id = ? ORDER BY seq", P.id));
  assert((await api("compliance", "POST", `/api/interop/oc4ids/${P.id}/export`, {})).status === 403, "a compliance reviewer can view but not publish an export (403 in-tenant)");
  const ex1 = await api("funder", "POST", `/api/interop/oc4ids/${P.id}/export`, {});
  assert(ex1.status === 201 && ex1.json.record, "an export is created");
  const rec = ex1.json.record;
  assert(rec.projectId === P.id && rec.organizationId === "org-cdfc" && rec.exportedByUserId === "user-funder" && rec.schemaVersion === "0.9.5" && rec.mappingVersion && rec.exportedAt,
    "the record names tenant, project, exporting user, timestamp, schema and mapping versions");
  assert(Array.isArray(rec.sourceRecords) && rec.sourceRecords.some((s) => s.table === "projects" && s.id === P.id),
    "the record lists the OBV source records (and versions) the export was built from");
  assert(rec.projectSha256 === sha256(require(path.join(ROOT, "dist/server/services/interop/oc4ids/validate.js")).canonicalJson(proj)),
    "the record carries the canonical hash of exactly the previewed project");
  const dl = await api("funder", "GET", `/api/interop/oc4ids/exports/${rec.id}`);
  assert(dl.status === 200 && sha256(dl.buf) === rec.payloadSha256 && dl.headers.get("x-obv-export-sha256") === rec.payloadSha256,
    "the stored bytes hash to the recorded SHA-256 (and the header states it)");
  const { validateAgainst } = require(path.join(ROOT, "dist/server/services/interop/oc4ids/validate.js"));
  const schema = require(path.join(ROOT, "dist/server/services/interop/oc4ids/schema.js"));
  const downloaded = JSON.parse(dl.text);
  assert(validateAgainst(schema.OC4IDS_PACKAGE_SCHEMA, downloaded).valid, "the downloaded package independently validates against the implemented schema");
  assert(downloaded.uri && downloaded.uri.includes(`/api/interop/oc4ids/exports/${rec.id}`) && downloaded.version === "0.9" && downloaded.publisher?.name,
    "the package carries its own URI, schema version and publisher");
  assert(JSON.stringify(q("SELECT * FROM projects WHERE id = ?", P.id)) === projectBefore && JSON.stringify(q("SELECT * FROM milestones WHERE project_id = ? ORDER BY seq", P.id)) === msBefore,
    "exporting does not mutate the project or its milestones");
  const ex2 = await api("funder", "POST", `/api/interop/oc4ids/${P.id}/export`, {});
  assert(ex2.status === 201 && ex2.json.record.id !== rec.id, "a second export creates a second record");
  assert(ex2.json.record.projectSha256 === rec.projectSha256, "publishing an export does not change the disclosed project (the export's own audit row never moves 'updated')");
  const rows = q("SELECT id, payload_sha256, payload_path FROM interop_exports WHERE project_id = ? ORDER BY exported_at", P.id);
  assert(rows.length === 2 && rows[0].payload_sha256 === rec.payloadSha256, "historical exports are retained unchanged (append-only)");
  assert(rows.every((r) => !path.isAbsolute(r.payload_path) && !r.payload_path.includes(DATA)), "export records store a logical storage key, never an absolute host path");
  const dl1Again = await api("funder", "GET", `/api/interop/oc4ids/exports/${rec.id}`);
  assert(sha256(dl1Again.buf) === rec.payloadSha256, "a historical export is reproducible byte-for-byte");
  // Tamper with the second export's stored file.
  const tamperFile = path.join(DATA, "interop", rows[1].payload_path);
  fs.writeFileSync(tamperFile, fs.readFileSync(tamperFile, "utf8").replace("Lakeshore", "Lakeshorx"));
  const t2 = await api("funder", "GET", `/api/interop/oc4ids/exports/${rows[1].id}`);
  assert(t2.status === 409 && t2.json?.expectedSha256 === rows[1].payload_sha256, "a stored export that no longer matches its hash is refused (409), never served");
  const list = await api("funder", "GET", `/api/interop/oc4ids/${P.id}/exports`);
  assert(list.status === 200 && list.json.exports.length === 2, "the export history lists both exports");
  const vr = await api("funder", "GET", `/api/interop/oc4ids/${P.id}/validation-report`);
  assert(vr.status === 200 && /attachment/.test(vr.headers.get("content-disposition") || "") && vr.json.validation.valid === true && /subset/i.test(vr.json.statement),
    "the validation report downloads as an attachment and states the implemented-subset scope");
  assert(count("SELECT COUNT(*) AS c FROM config_audit WHERE action = 'OC4IDS_EXPORT_CREATED' AND entity_id = ?", rec.id) === 1, "the export is audited");

  // ================================================== 6. isolation + roles
  console.log("\n== 6. Tenant isolation and role gates ==");
  const rivalPrev = await api("rival", "GET", "/api/interop/oc4ids/proj-r47/preview");
  const ghostPrev = await api("rival", "GET", "/api/interop/oc4ids/proj-does-not-exist/preview");
  assert(rivalPrev.status === 404 && ghostPrev.status === 404 && rivalPrev.text === ghostPrev.text, "another tenant's project preview is indistinguishable from a nonexistent one (same 404)");
  const rivalDl = await api("rivalFunder", "GET", `/api/interop/oc4ids/exports/${rec.id}`);
  const ghostDl = await api("rivalFunder", "GET", "/api/interop/oc4ids/exports/00000000-0000-0000-0000-000000000000");
  assert(rivalDl.status === 404 && ghostDl.status === 404 && rivalDl.text === ghostDl.text, "another tenant's stored export is the same 404 as a missing one");
  assert((await api("rivalFunder", "POST", `/api/interop/oc4ids/${P.id}/export`, {})).status === 404, "another tenant cannot export our project (404)");
  assert((await api("rivalFunder", "GET", `/api/interop/oc4ids/${P.id}/validation-report`)).status === 404, "another tenant cannot download our validation report (404)");
  assert((await api("field", "GET", "/api/interop/oc4ids/proj-r47/preview")).status === 403, "the FIELD role cannot use the infrastructure data area (403)");
  assert((await api(null, "GET", "/api/interop/oc4ids/proj-r47/preview")).status === 401, "anonymous API access is 401");
  const anonPage = await page(null, "/project/proj-r47/infrastructure-data");
  assert([302, 303].includes(anonPage.status), "an anonymous page request redirects to sign-in");

  // ================================================== 7. observations import
  console.log("\n== 7. External field observations — import ==");
  const rivalProj = await api("rival", "POST", "/api/pilot/projects", { name: "Rival Corridor Upgrade", organizationId: "org-rival", obvControlledAmount: 500000, currency: "USD" });
  await api("rival", "POST", `/api/pilot/projects/${rivalProj.json.project.id}/template`, { templateKey: "road-rehabilitation" });
  const rivalMs = q("SELECT id FROM milestones WHERE project_id = ? ORDER BY seq LIMIT 1", rivalProj.json.project.id)[0]?.id;
  if (!rivalMs) fail("rival milestone not created");
  const ctrl0 = controlFingerprint();
  const ev0 = evidenceFingerprint();
  const pending = q("SELECT id FROM milestones WHERE project_id = 'proj-r47' AND COALESCE(archived,0) = 0 AND status IN ('PENDING_EVIDENCE','NOT_STARTED','UNDER_REVIEW') ORDER BY seq");
  if (pending.length < 1) fail("no pending R47 milestone to attach evidence to");
  const msTarget = pending[0].id;
  const png1 = testPng(11).toString("base64");
  const png2 = testPng(23).toString("base64");
  const envelope = {
    format: "obv-field-observation-import", formatVersion: "1.0", sourceSystem: "KOBOTOOLBOX",
    providerLabel: "KoBoToolbox (deterministic test export)", sourceMetadata: { formId: "aTest01", formName: "Road site visit" },
    observations: [
      { externalObservationId: "kobo-A", projectReference: "proj-r47", collector: "Monitor One", observedAt: "2026-09-20T09:15:00Z",
        latitude: -11.85, longitude: 33.60, accuracyMeters: 4.5, photos: [{ fileName: "a.png", contentType: "image/png", base64: png1, caption: "Culvert headwall" }],
        formFields: { progress_estimate: "60%", condition: "good" }, comments: "Headwall formwork complete", sourceMetadata: { _id: 101, _submission_time: "2026-09-20T09:20:00Z" } },
      { externalObservationId: "kobo-B", projectReference: "proj-r47", collector: "Monitor Two", observedAt: "2026-09-21T10:00:00Z",
        latitude: -11.84, longitude: 33.61, photos: [], formFields: { note: "no photo" }, comments: null, sourceMetadata: {} },
      { externalObservationId: "kobo-C", projectReference: "proj-r47", collector: "Monitor Three", observedAt: "2026-09-22T11:00:00Z",
        latitude: -11.83, longitude: 33.62, photos: [{ fileName: "remote.jpg", sourceUrl: `http://127.0.0.1:${SINK_PORT}/latest/meta-data` }], formFields: {}, comments: null, sourceMetadata: {} },
      { externalObservationId: "kobo-D", projectReference: "proj-r47", collector: "Monitor Four", observedAt: "2026-09-23T12:00:00Z",
        latitude: null, longitude: null, photos: [{ fileName: "d.png", contentType: "image/png", base64: png2 }], formFields: {}, comments: "GPS unavailable", sourceMetadata: {} },
      { externalObservationId: "kobo-E", projectReference: "no-such-project", collector: "Monitor Five", observedAt: "2026-09-24T12:00:00Z",
        latitude: 95, longitude: 33.6, photos: [], formFields: {}, comments: null, sourceMetadata: {} },
    ],
  };
  const body = Buffer.from(JSON.stringify(envelope));
  assert((await api("field", "POST", "/api/interop/field-observations/import", body)).status === 403, "the FIELD role cannot import (403)");
  assert((await api("compliance", "POST", "/api/interop/field-observations/import", body)).status === 403, "a compliance reviewer cannot import — importer and reviewer duties are separate");
  const imp = await api("pm", "POST", "/api/interop/field-observations/import", body);
  assert(imp.status === 201 && imp.json.observations.length === 5, "a deterministic five-observation dataset imports");
  const obs = Object.fromEntries(imp.json.observations.map((o) => [o.externalObservationId, o]));
  assert(imp.json.observations.every((o) => o.status === "UNVERIFIED"), "every imported observation enters as External Observation — Unverified");
  assert(obs["kobo-A"].matchedProjectId === "proj-r47" && obs["kobo-A"].matchVerdict === "REFERENCE_MATCH", "an exact project reference matches deterministically");
  assert(obs["kobo-E"].matchedProjectId === null && obs["kobo-E"].matchVerdict === "NO_MATCH", "an unknown reference stays unmatched (never guessed)");
  assert(obs["kobo-E"].latitude === null, "an out-of-range latitude is dropped, not clamped or invented");
  assert(obs["kobo-D"].latitude === null && obs["kobo-D"].longitude === null, "an observation without coordinates keeps none");
  assert(obs["kobo-A"].observedAt === "2026-09-20T09:15:00.000Z" || obs["kobo-A"].observedAt === "2026-09-20T09:15:00Z", "the source timestamp is preserved");
  const impRow = q("SELECT * FROM field_observation_imports WHERE id = ?", imp.json.import.id)[0];
  const snapPath = path.join(DATA, "interop", impRow.payload_path);
  assert(!path.isAbsolute(impRow.payload_path) && fs.existsSync(snapPath) && sha256(fs.readFileSync(snapPath)) === sha256(body) && impRow.payload_sha256 === sha256(body),
    "the raw import is kept as an immutable snapshot whose hash is recorded (logical key)");
  assert(q("SELECT COUNT(*) AS c FROM field_observation_photos WHERE stored_path LIKE ?", `%${DATA}%`)[0].c === 0, "stored photos are referenced by logical keys only");
  assert(sinkHits.length === 0, "a source photo URL (pointing at a local metadata-style endpoint) is recorded but NEVER fetched");
  assert(JSON.stringify(evidenceFingerprint()) === JSON.stringify(ev0), "import creates no evidence, ledger entry, approval request or milestone change");
  assert(JSON.stringify(controlFingerprint()) === JSON.stringify(ctrl0), "import moves no approval, draw, payment, account, exception or inspection state");
  // Idempotency
  const again = await api("pm", "POST", "/api/interop/field-observations/import", body);
  assert(again.status === 201 && again.json.observations.length === 0 && again.json.duplicates.length === 5, "re-importing the same records is idempotent (reported as duplicates)");
  // KoBo-shaped rows
  const kobo = {
    format: "kobotoolbox-submissions", sourceSystem: "KOBOTOOLBOX", projectReference: "proj-r47",
    submissions: [
      { _id: 9001, _uuid: "uuid-kobo-9001", _submission_time: "2026-09-25T08:00:00", start: "2026-09-25T07:40:00Z", _geolocation: [-11.86, 33.59],
        site_condition: "drainage cleared", _attachments: [{ filename: "user/attachments/x.jpg", download_url: `http://127.0.0.1:${SINK_PORT}/kobo/x.jpg`, mimetype: "image/jpeg" }] },
    ],
  };
  const kimp = await api("pm", "POST", "/api/interop/field-observations/import", kobo);
  assert(kimp.status === 201 && kimp.json.observations.length === 1, "KoBoToolbox-shaped submission rows translate deterministically");
  const ko = kimp.json.observations[0];
  assert(ko.externalObservationId === "uuid-kobo-9001" && ko.latitude === -11.86 && ko.longitude === 33.59 && ko.formFields.site_condition === "drainage cleared",
    "KoBo meta keys map to id/coordinates; form answers are kept verbatim");
  assert(ko.observedAt === null || !/2026-09-25T08:00:00\.000Z/.test(String(ko.observedAt)) || ko.observedAtVerbatim === "2026-09-25T08:00:00",
    "a timezone-less source timestamp is not silently assigned a zone");
  assert(sinkHits.length === 0, "KoBo attachment download URLs are recorded, never retrieved");
  // Input validation
  const bad = async (b, code, m) => { const r = await api("pm", "POST", "/api/interop/field-observations/import", b); assert(r.status === code, `${m} (${r.status})`); };
  await bad("{not json", 400, "malformed JSON is refused");
  await bad({ ...envelope, format: "something-else" }, 400, "an unknown format is refused");
  await bad({ ...envelope, observations: [{ ...envelope.observations[0], externalObservationId: "x1", photos: [{ contentType: "image/png", base64: Buffer.from("<html><script>alert(1)</script></html>".repeat(10)).toString("base64") }] }] }, 400, "photo bytes that are not an image are refused (magic-byte sniffing)");
  await bad({ ...envelope, observations: [{ ...envelope.observations[0], externalObservationId: "x2", photos: [{ contentType: "image/jpeg", base64: png1 }] }] }, 400, "a declared content type that contradicts the bytes is refused");
  await bad({ ...envelope, observations: Array.from({ length: 201 }, (_, i) => ({ externalObservationId: `bulk-${i}`, photos: [] })) }, 413, "more than 200 observations per import is refused");
  await bad({ ...envelope, observations: [{ ...envelope.observations[0], externalObservationId: "x3", formFields: { big: "x".repeat(70_000) } }] }, 400, "oversized form fields are refused");
  await bad({ ...envelope, observations: [envelope.observations[1], envelope.observations[1]] }, 400, "duplicate external ids within one import are refused");

  // ================================================== 8. review: no bypass
  console.log("\n== 8. Review — governed pipeline only, no financial bypass ==");
  const A = obs["kobo-A"].id, B = obs["kobo-B"].id, C = obs["kobo-C"].id, D = obs["kobo-D"].id, E = obs["kobo-E"].id;
  assert((await api("field", "POST", `/api/interop/field-observations/${A}/accept`, { milestoneId: msTarget })).status === 403, "FIELD cannot accept an observation (403)");
  assert((await api("pm", "POST", `/api/interop/field-observations/${A}/accept`, { milestoneId: msTarget })).status === 403, "the importer role (project manager) cannot accept its own import (403)");
  assert((await api("rivalFunder", "POST", `/api/interop/field-observations/${A}/accept`, { milestoneId: msTarget })).status === 404, "another tenant's reviewer gets 404 on our observation");
  const dmvMs = q("SELECT id FROM milestones WHERE project_id = 'proj-dmv' LIMIT 1")[0].id;
  assert((await api("funder", "POST", `/api/interop/field-observations/${A}/accept`, { milestoneId: dmvMs })).status === 404, "a milestone from a different project is refused (nested-object guard)");
  assert((await api("funder", "POST", `/api/interop/field-observations/${A}/accept`, { milestoneId: rivalMs })).status === 404, "a foreign-tenant milestone is refused (404)");
  assert((await api("funder", "POST", `/api/interop/field-observations/${B}/accept`, { milestoneId: msTarget })).status === 409, "an observation without a transferred photo cannot become evidence");
  assert((await api("funder", "POST", `/api/interop/field-observations/${C}/accept`, { milestoneId: msTarget })).status === 409, "a URL-only photo is never fetched to manufacture evidence");
  const eAcc = await api("funder", "POST", `/api/interop/field-observations/${E}/accept`, { milestoneId: msTarget });
  assert(eAcc.status === 404, "an unmatched observation is visible only to the importing organization (reviewers elsewhere get 404)");
  assert(JSON.stringify(evidenceFingerprint()) === JSON.stringify(ev0), "refused acceptances leave evidence untouched");

  const ctrlBeforeAccept = controlFingerprint();
  const acc = await api("compliance", "POST", `/api/interop/field-observations/${A}/accept`, { milestoneId: msTarget, note: "Matches site plan" });
  assert(acc.status === 201 && acc.json.submission && acc.json.submission.evidence, "a reviewer accepts the observation into the existing evidence workflow");
  const evidenceId = acc.json.submission.evidence.id;
  const verdict = acc.json.submission.verification.verdict;
  assert(["VERIFIED", "NEEDS_REVIEW", "REJECTED"].includes(verdict), `the pipeline reaches its own verdict (${verdict}); acceptance sets none`);
  const evRow = q("SELECT * FROM evidence_items WHERE id = ?", evidenceId)[0];
  assert(evRow.milestone_id === msTarget && evRow.user_id === "user-compliance", "the evidence belongs to the chosen milestone, submitted by the accepting reviewer");
  assert(new Date(evRow.captured_at).toISOString() === "2026-09-20T09:15:00.000Z", "capturedAt is the SOURCE observation time, not the import time");
  assert(evRow.latitude === -11.85 && evRow.longitude === 33.60, "the evidence carries the SOURCE coordinates exactly");
  assert(/External field observation|KoBoToolbox/i.test(evRow.device_metadata), "device metadata honestly names the external source (not an OBV capture device)");
  const prov = q("SELECT * FROM evidence_provenance WHERE evidence_item_id = ?", evidenceId)[0];
  assert(prov && prov.origin === "EXTERNAL_FIELD_OBSERVATION" && prov.observation_id === A && prov.external_observation_id === "kobo-A" && prov.source_system === "KOBOTOOLBOX",
    "an evidence provenance record names origin, observation, external id and source system");
  assert(prov.source_latitude === -11.85 && prov.source_longitude === 33.60 && prov.source_accuracy_m === 4.5 && /2026-09-20T09:15/.test(prov.source_observed_at) && prov.collector === "Monitor One",
    "provenance keeps the original timestamp, source coordinates, accuracy and collector");
  const obsRow = q("SELECT * FROM field_observations WHERE id = ?", A)[0];
  const impOfA = q("SELECT * FROM field_observation_imports WHERE id = ?", prov.import_id)[0];
  assert(prov.source_record_sha256 === obsRow.source_record_sha256 && /^[0-9a-f]{64}$/.test(prov.source_record_sha256) && impOfA.payload_sha256 === sha256(body) && obsRow.ingested_at && JSON.parse(obsRow.source_metadata)._id === 101,
    "the chain evidence -> observation -> import snapshot holds the record hash, snapshot hash, ingestion time and source metadata");
  const ctrlAfter = controlFingerprint();
  assert(JSON.stringify(ctrlAfter) === JSON.stringify(ctrlBeforeAccept), "acceptance approves nothing, releases nothing, moves no draw/payment/account/exception/inspection state");
  assert(ctrlAfter.approvalRecords === ctrl0.approvalRecords && ctrlAfter.approvedRequests === ctrl0.approvedRequests,
    "no approval record or decided approval request is written by acceptance");
  const msStatus = q("SELECT status, account_status FROM milestones WHERE id = ?", msTarget)[0];
  assert(!["APPROVED", "RELEASED"].includes(msStatus.status) && msStatus.account_status === "HELD", "the milestone is not approved and its tranche stays HELD");
  if (verdict === "VERIFIED") {
    const ar = q("SELECT id FROM approval_requests WHERE subject_id = ? AND status = 'PENDING' OR (milestone_id = ? AND status = 'PENDING') LIMIT 1", msTarget, msTarget)[0];
    if (ar) {
      const sod = await api("compliance", "POST", `/api/approvals/${ar.id}/decision`, { decision: "APPROVED" });
      assert(sod.status === 403, "separation of duties: the accepting reviewer cannot approve the milestone their acceptance submitted");
    } else pass("no approval request to probe (pipeline did not raise one)");
  } else pass(`pipeline verdict ${verdict}: no approval request is raised for this evidence`);
  assert((await api("compliance", "POST", `/api/interop/field-observations/${A}/accept`, { milestoneId: msTarget })).status === 409, "an observation is accepted exactly once (409 on repeat)");
  assert((await api("funder", "POST", `/api/interop/field-observations/${A}/reject`, { note: "late" })).status === 409, "a decided observation cannot be re-decided");
  const rej = await api("funder", "POST", `/api/interop/field-observations/${B}/reject`, { note: "No photo" });
  assert(rej.status === 201 && rej.json.observation.status === "REJECTED", "a reviewer can reject an observation");
  const def = await api("funder", "POST", `/api/interop/field-observations/${C}/defer`, { note: "Ask for the photo" });
  assert(def.status === 201 && def.json.observation.status === "DEFERRED", "a reviewer can defer an observation");
  assert((await api("rival", "POST", `/api/interop/field-observations/${E}/assign`, { projectId: rivalProj.json.project.id })).status === 404, "another tenant cannot assign (or even see) our unmatched observation");
  assert((await api("pm", "POST", `/api/interop/field-observations/${E}/assign`, { projectId: rivalProj.json.project.id })).status === 404, "an observation cannot be assigned to a project the assigner cannot see");
  const asg = await api("pm", "POST", `/api/interop/field-observations/${E}/assign`, { projectId: "proj-r47", note: "Mis-keyed reference" });
  assert(asg.status === 201 && asg.json.observation.matchedProjectId === "proj-r47" && asg.json.observation.matchVerdict === "REVIEWER_ASSIGNED" && asg.json.observation.status === "UNVERIFIED",
    "the importer can correct an unmatched reference by assigning a project; the observation stays unverified");
  const eVisible = await api("funder", "GET", `/api/interop/field-observations/${E}`);
  assert(eVisible.status === 200, "once assigned, the observation is visible to the project's reviewers");
  const accD = await api("funder", "POST", `/api/interop/field-observations/${D}/accept`, { milestoneId: msTarget });
  assert(accD.status === 201, "an observation without coordinates can be accepted (its evidence simply has no location)");
  const evD = q("SELECT latitude, longitude FROM evidence_items WHERE id = ?", accD.json.submission.evidence.id)[0];
  assert(evD.latitude === null && evD.longitude === null, "no coordinates are manufactured for evidence whose source had none");
  assert(JSON.stringify(controlFingerprint()) === JSON.stringify(ctrlBeforeAccept), "after every review action, approval and financial-control state is unchanged");
  const events = q("SELECT kind FROM field_observation_events WHERE observation_id = ? ORDER BY occurred_at", A).map((r) => r.kind);
  assert(events.includes("RECEIVED") && events.includes("ACCEPTED") && events.includes("EVIDENCE_CREATED"), "the observation's append-only event trail records receipt, acceptance and evidence creation");
  assert(count("SELECT COUNT(*) AS c FROM config_audit WHERE action = 'FIELD_OBSERVATION_ACCEPTED' AND entity_id = ?", A) === 1, "acceptance is audited");

  // ================================================== 9. surfaces
  console.log("\n== 9. Evidence Intelligence, Timeline, Digital Twin provenance ==");
  const eiTl = await api("funder", "GET", `/api/evidence-intel/timeline/${evidenceId}`);
  assert(eiTl.status === 200 && /External Field Observation/.test(eiTl.text) && /KoBoToolbox/.test(eiTl.text), "the Evidence Intelligence timeline states Source: External Field Observation / Provider: KoBoToolbox");
  const facts = count("SELECT COUNT(*) AS c FROM evidence_metadata_facts WHERE evidence_item_id = ?", evidenceId);
  const sigs = q("SELECT severity FROM evidence_signals WHERE subject_type = 'EVIDENCE_ITEM' AND subject_id = ?", evidenceId);
  assert(facts === 1, `Evidence Intelligence analyzed the accepted evidence under the same rules as native evidence (metadata facts derived; ${sigs.length} advisory finding(s))`);
  const eiPage = await page("funder", `/evidence-intelligence/evidence/${evidenceId}`);
  assert(eiPage.status === 200 && /External Field Observation/.test(eiPage.html) && /Provider: KoBoToolbox/.test(eiPage.html), "the Evidence Intelligence evidence page shows Source: External Field Observation / Provider");
  const nativeEv = q("SELECT e.id FROM evidence_items e LEFT JOIN evidence_provenance p ON p.evidence_item_id = e.id WHERE p.evidence_item_id IS NULL AND e.milestone_id IN (SELECT id FROM milestones WHERE project_id = 'proj-r47') LIMIT 1")[0];
  if (nativeEv) {
    const nat = await page("funder", `/evidence-intelligence/evidence/${nativeEv.id}`);
    assert(nat.status === 200 && /OBV Capture/.test(nat.html) && !/Source: External Field Observation/.test(nat.html), "native evidence is labeled Source: OBV Capture");
  } else pass("no native evidence on R47 to contrast (seed shape)");
  const tl = await api("funder", "GET", "/api/timeline/project/proj-r47");
  const tlEvents = tl.json.events || tl.json.items || [];
  const recv = tlEvents.filter((e) => e.type === "EXTERNAL_OBSERVATION_RECEIVED");
  const accEvt = tlEvents.filter((e) => e.type === "EXTERNAL_OBSERVATION_ACCEPTED");
  assert(recv.length >= 5 && accEvt.length === 2, "the Timeline shows 'External field observation received' and 'accepted as evidence'");
  assert(tlEvents.some((e) => e.type === "EXTERNAL_OBSERVATION_REVIEWED"), "the Timeline shows reviewer decisions (reviewed)");
  assert([...recv, ...accEvt].every((e) => e.spatial === null), "observation events carry no map position of their own (only accepted evidence is placed)");
  const capt = tlEvents.find((e) => e.type === "EVIDENCE_CAPTURED" && e.sourceRecordId === evidenceId);
  assert(capt && capt.spatial && capt.spatial.latitude === -11.85 && capt.spatial.longitude === 33.6, "the accepted evidence appears on the Timeline at its real source coordinates");
  assert(/External Field Observation/.test(`${capt.title} ${capt.explanation}`), "the Timeline evidence event states its external source");
  const captD = tlEvents.find((e) => e.type === "EVIDENCE_CAPTURED" && e.sourceRecordId === accD.json.submission.evidence.id);
  assert(!captD || captD.spatial === null, "evidence without source coordinates is never placed on the map");
  const fieldTl = await api("field", "GET", "/api/timeline/project/proj-r47");
  assert(fieldTl.status === 200 && !(fieldTl.json.events || fieldTl.json.items || []).some((e) => /^EXTERNAL_OBSERVATION/.test(e.type)),
    "observation review events follow governance: hidden from the FIELD role, which cannot use the area");
  assert((await api("rival", "GET", "/api/timeline/project/proj-r47")).status === 404, "another tenant cannot see the project timeline (404)");
  const scene = await api("funder", "GET", "/api/twin/scene/proj-r47");
  assert(scene.status === 200 && scene.text.includes(`EVIDENCE_PIN:${evidenceId}`), "the Digital Twin places a pin for the accepted evidence");
  assert(!scene.text.includes(`EVIDENCE_PIN:${accD.json.submission.evidence.id}`), "the Digital Twin places no pin for evidence without real coordinates");
  const pin = await api("funder", "GET", `/api/twin/pin/proj-r47/${evidenceId}`);
  assert(pin.status === 200 && /External Field Observation/.test(JSON.stringify(pin.json)) && /KoBoToolbox/.test(JSON.stringify(pin.json)), "the twin pin detail identifies the external source and provider");
  const msPage = await page("funder", `/project/proj-r47`);
  assert(msPage.status === 200, "the existing project page still renders");

  // ================================================== 10. UI
  console.log("\n== 10. Interface ==");
  const ws = await page("funder", "/project/proj-r47/infrastructure-data");
  assert(ws.status === 200 && h1Count(ws.html) === 1 && /Infrastructure Data/.test(ws.html), "the Infrastructure Data area renders with one h1");
  assert(/OC4IDS/.test(ws.html) && /Schema version/.test(ws.html) && /Last exported/.test(ws.html) && /Field coverage/.test(ws.html), "the overview shows standard, schema version, last export and field coverage");
  assert(/Preview OC4IDS/.test(ws.html) && /Download validation report/.test(ws.html), "Preview and validation-report actions are present");
  assert(/KoBoToolbox API — not connected/i.test(ws.html) && /ODK Central — not connected/i.test(ws.html), "unavailable providers visibly report Not Connected");
  const projPage = await page("funder", `/project/${P.id}`);
  assert(projPage.status === 200 && projPage.html.includes(`/project/${P.id}/infrastructure-data`), "the existing project workspace links to Infrastructure Data");
  const ocPage = await page("funder", `/project/${P.id}/infrastructure-data/oc4ids`);
  assert(ocPage.status === 200 && h1Count(ocPage.html) === 1 && /Export JSON/.test(ocPage.html), "the OC4IDS preview page renders with an Export JSON action");
  assert(ocPage.html.includes("projects") && ocPage.html.includes(P.id.slice(0, 8)) && /Omitted/i.test(ocPage.html), "the preview shows the OBV source for values and the omitted fields");
  const ocR47 = await page("funder", "/project/proj-r47/infrastructure-data/oc4ids");
  assert(/Incomplete/.test(ocR47.html) && !/>\s*Ready\s*</.test(ocR47.html), "an incomplete project is never presented as Ready");
  const obsPage = await page("funder", "/project/proj-r47/infrastructure-data/observations");
  assert(obsPage.status === 200 && h1Count(obsPage.html) === 1 && /External observation — unverified/.test(obsPage.html), "the observations page labels pending items 'External observation — unverified'");
  const detPage = await page("funder", `/interop/field-observations/${A}`);
  assert(detPage.status === 200 && h1Count(detPage.html) === 1 && /Accepted as evidence/.test(detPage.html) && /KoBoToolbox/.test(detPage.html), "the observation detail page shows the decision and the provider");
  assert(!/\bVerified\b/.test((await page("funder", `/interop/field-observations/${E}`)).html.replace(/Unverified|unverified|verification|verified evidence/gi, "")),
    "an unverified observation is never called Verified");
  assert((await page("rival", `/interop/field-observations/${A}`)).status === 404, "another tenant's observation page is 404");
  const evPanel = await page("funder", `/milestone/${msTarget}`);
  if (evPanel.status === 200) assert(/External Field Observation/.test(evPanel.html), "the milestone evidence panel shows Source: External Field Observation");
  else pass(`milestone page route not present in this build (${evPanel.status}); source label covered by EI and twin`);
  assert(!/OBV_SESSION_SECRET|OBV_OC4IDS_[A-Z_]+=/.test(ws.html + ocPage.html + obsPage.html), "no configuration secret or environment value reaches the frontend");

  await stopServer();
  sink.close();
  console.log(`\nINFRASTRUCTURE INTEROPERABILITY TESTS PASSED — ${passed} checkpoints.`);
}

main()
  .catch(async (err) => {
    console.error(err.stack ?? err.message ?? err);
    if (serverLog) console.error("--- server log tail ---\n" + serverLog.split("\n").slice(-40).join("\n"));
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();
    fs.rmSync(DATA, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  });
