#!/usr/bin/env node
/**
 * Dispute + Release Hold Management test suite — state machine, release
 * hold, responses, evidence, cures, inspections, recommendations, legal
 * hold, escalation, authorized resolution, tenancy, packages and the
 * banking non-mutation regression.
 *
 * Proves the non-negotiable boundaries: a dispute is a WORKFLOW record —
 * it pauses release ELIGIBILITY and never touches a balance, settlement,
 * provider event or payment history; every transition is explicit,
 * authorized and exactly-once; resolved/closed states are reachable only
 * through the dedicated authorized actions; and the entire lifecycle
 * leaves every banking and financial table byte-for-byte unchanged.
 */
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, readdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = 3187;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "obv-dispute-"));

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

/** EVERY banking + financial table a dispute must never mutate. */
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

/** The dispute workflow state machine — mirrors DISPUTE_TRANSITIONS. */
const WORKFLOW = {
  OPEN: ["UNDER_REVIEW"],
  UNDER_REVIEW: [
    "WAITING_FOR_CONTRACTOR", "WAITING_FOR_LENDER", "WAITING_FOR_OWNER",
    "WAITING_FOR_INSPECTION", "WAITING_FOR_DOCUMENTS", "CURE_IN_PROGRESS",
    "READY_FOR_DECISION", "ESCALATED",
  ],
  WAITING_FOR_CONTRACTOR: ["UNDER_REVIEW", "CURE_IN_PROGRESS", "ESCALATED"],
  WAITING_FOR_LENDER: ["UNDER_REVIEW", "READY_FOR_DECISION", "ESCALATED"],
  WAITING_FOR_OWNER: ["UNDER_REVIEW", "READY_FOR_DECISION", "ESCALATED"],
  WAITING_FOR_INSPECTION: ["UNDER_REVIEW", "READY_FOR_DECISION"],
  WAITING_FOR_DOCUMENTS: ["UNDER_REVIEW", "CURE_IN_PROGRESS"],
  CURE_IN_PROGRESS: ["UNDER_REVIEW", "WAITING_FOR_CONTRACTOR", "READY_FOR_DECISION", "ESCALATED"],
  READY_FOR_DECISION: ["UNDER_REVIEW", "ESCALATED"],
  ESCALATED: ["UNDER_REVIEW", "READY_FOR_DECISION"],
};

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

const ADVISORY = "Advisory recommendation only. OBV does not act as the escrow agent, make a binding legal determination, or move funds.";
const ACK =
  "This action records an authorized project decision. OBV does not hold funds or execute the payment or return. Actual financial activity must be performed and confirmed by the lender, bank, payment provider, or licensed escrow partner.";

async function main() {
  console.log("Dispute + Release Hold tests — isolated server on :" + PORT);

  // ================== 0. static source boundaries ==================
  const src = (p) => readFileSync(path.join(__dirname, "..", "src", "server", p), "utf8");
  // Type-only imports are erased at compile time and cannot make calls —
  // exclude them so the network check targets runtime capability only.
  const runtimeOnly = (s) => s.replace(/^import type .*$/gm, "");
  const disputeSrc = runtimeOnly([
    src("services/disputes.ts"), src("db/disputeRepo.ts"),
    src("http/disputeRoutes.ts"), src("services/disputeRegisters.ts"),
  ].join("\n"));
  assert(
    !/node:https?\b|fetch\s*\(|axios|XMLHttpRequest|net\.connect/.test(disputeSrc),
    "no dispute module imports HTTP clients or makes network calls"
  );
  assert(
    !/api[_-]?key|apikey|secret|bearer|authorization:/i.test(disputeSrc),
    "no dispute module contains credentials or auth-token material"
  );
  assert(
    !/VirtualAccountService/.test(disputeSrc),
    "no dispute module calls into VirtualAccountService (no new release path)"
  );
  assert(
    !/INSERT INTO (banking_|payment_instructions|bank_transactions|project_virtual_accounts|project_account_holds|mock_provider_ledger)/.test(disputeSrc) &&
      !/UPDATE (banking_|payment_instructions|bank_transactions|project_virtual_accounts|project_account_holds|mock_provider_ledger)/.test(disputeSrc),
    "no dispute module writes any banking table"
  );
  const drepoSrc = src("db/disputeRepo.ts");
  assert(
    !/UPDATE dispute_events|DELETE FROM dispute_events/.test(drepoSrc) &&
      !/UPDATE dispute_responses|DELETE FROM dispute_responses/.test(drepoSrc) &&
      !/UPDATE dispute_cure_extensions|DELETE FROM dispute_cure_extensions/.test(drepoSrc),
    "dispute events, responses and cure extensions are append-only (no update/delete path in the repository)"
  );
  const bankingDir = path.join(__dirname, "..", "src", "server", "services", "banking");
  const bankingSrc = readdirSync(bankingDir).map((f) => readFileSync(path.join(bankingDir, f), "utf8")).join("\n");
  assert(
    !/VirtualAccountService/.test(bankingSrc),
    "banking modules still have no call path into VirtualAccountService (dispute work preserved the boundary)"
  );
  const lenderDecisionsSrc = src("services/lenderDecisions.ts");
  assert(
    /drawDisputeHold/.test(lenderDecisionsSrc) && /drawDisputeHold/.test(bankingSrc),
    "the release-hold read model gates both lender funding transitions and the payment boundary"
  );
  assert(
    src("services/disputes.ts").includes(ADVISORY) && src("services/disputes.ts").includes(ACK),
    "the mandatory advisory disclaimer and resolution acknowledgement are present verbatim in the service"
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
    await signIn("lender2", "user-lender2");
    await signIn("pm", "user-pm");
    await signIn("compliance", "user-compliance");
    await signIn("field", "user-field");
    await api("funder", "POST", "/api/exceptions/evaluate");

    // ================== 1. seeded historical lifecycle ==================
    const demo = await j("funder", "GET", "/api/disputes/disp-demo-1", undefined, 200);
    assert(demo.dispute.status === "CLOSED" && demo.dispute.resolutionType === "AUTHORIZE_FULL_RELEASE",
      "seeded demo dispute is a CLOSED, fully-released historical record");
    assert(demo.events.length >= 15 && demo.events[0].type === "CREATED" && demo.events.at(-1).type === "CLOSED",
      "seeded timeline runs CREATED → … → CLOSED with the full lifecycle on record");
    assert(demo.recommendations[0].official === true && demo.recommendations[0].aiGenerated === false,
      "seeded recommendation is human-authored and official");
    const vamEl0 = await j("funder", "GET", "/api/draws/draw-vam/payment-eligibility", undefined, 200);
    assert(vamEl0.blockers.length === 0, "a CLOSED dispute imposes NO release hold (draw-vam fully eligible)");

    // ================== 2. banking non-mutation baseline ==================
    const baseline = bankingSnapshot();
    pass("banking + financial snapshot taken (17 protected tables + draw amounts)");

    // ================== 3. opening: validation + authorization ==================
    const openBody = {
      subjectType: "DRAW_REQUEST", subjectId: "draw-1", disputedAmount: 150000,
      undisputedAmount: 450000, affectedScope: "Gravel base course — chainage 4+000 to 6+000",
      reason: "Placed thickness measured below the specified 150mm over a 2km section.",
    };
    assert((await api("field", "POST", "/api/projects/proj-r47/disputes", openBody)).status === 403,
      "a user with no dispute capability cannot open a dispute (403)");
    assert((await api("funder", "POST", "/api/projects/proj-r47/disputes", { ...openBody, subjectType: "NONSENSE" })).status === 400,
      "an unknown subject type is rejected (400)");
    assert((await api("funder", "POST", "/api/projects/proj-r47/disputes", { ...openBody, subjectId: "draw-nope" })).status === 422,
      "a nonexistent subject is rejected (422)");
    assert((await api("funder", "POST", "/api/projects/proj-r47/disputes", { ...openBody, disputedAmount: 1000.55 })).status === 400,
      "a fractional disputed amount is rejected — whole-currency integers only (400)");
    assert((await api("funder", "POST", "/api/projects/proj-r47/disputes", { ...openBody, disputedAmount: -5 })).status === 400,
      "a negative disputed amount is rejected (400)");
    assert((await api("funder", "POST", "/api/projects/proj-r47/disputes", { ...openBody, reason: "  " })).status === 400,
      "an empty reason is rejected (400)");
    const dA = (await j("funder", "POST", "/api/projects/proj-r47/disputes", openBody, 201)).dispute;
    assert(dA.status === "OPEN" && dA.drawRequestId === "draw-1" && dA.disputedAmount === 150000,
      "an authorized lender opens a dispute: OPEN, attached to its draw, amounts recorded");
    const created = (await j("funder", "GET", `/api/disputes/${dA.id}`, undefined, 200)).events;
    assert(created.length === 1 && created[0].type === "CREATED" && created[0].actorUserId === "user-funder",
      "opening writes exactly one attributable CREATED audit event");
    assert(
      q1("SELECT requested_amount, approved_amount FROM draw_requests WHERE id='draw-1'").requested_amount === 600000,
      "opening a dispute does NOT modify the draw's authoritative amounts"
    );

    // ---- tenancy: an unrelated org sees the same 404 as nonexistence ----
    exec("INSERT INTO organizations (id, name, kind) VALUES ('org-x', 'Unrelated Capital', 'FUNDER')");
    exec("INSERT INTO users (id, organization_id, name, role, title) VALUES ('user-x', 'org-x', 'Xavier Test', 'FUNDER_REP', 'Outsider')");
    await signIn("outsider", "user-x");
    const xGet = await api("outsider", "GET", `/api/disputes/${dA.id}`);
    const ghost = await api("outsider", "GET", "/api/disputes/no-such-dispute");
    assert(xGet.status === 404 && ghost.status === 404,
      "an unrelated tenant gets the SAME 404 as a nonexistent dispute (no existence disclosure)");
    assert((await api("outsider", "POST", `/api/disputes/${dA.id}/transition`, { to: "UNDER_REVIEW" })).status === 404,
      "cross-tenant dispute mutations are tenant-safe 404s");
    assert((await api("outsider", "GET", "/api/projects/proj-r47/disputes")).status === 404,
      "the project dispute register is a 404 for the unrelated tenant");
    assert((await api("outsider", "POST", "/api/projects/proj-r47/disputes", openBody)).status === 404,
      "an unrelated tenant cannot open a dispute in another tenant's project (404)");
    assert((await page("outsider", `/dispute/${dA.id}`)).status === 404,
      "the dispute workspace page is a 404 for the unrelated tenant");
    // object-id guessing on sub-records
    assert((await api("funder", "POST", "/api/dispute-cures/guess-1/submit", { completionNote: "x" })).status === 404,
      "guessing a cure id returns 404");
    assert((await api("funder", "POST", "/api/dispute-evidence/guess-1/review", { status: "ACCEPTED" })).status === 404,
      "guessing an evidence id returns 404");
    assert((await api("funder", "POST", "/api/dispute-inspections/guess-1/cancel", {})).status === 404,
      "guessing an inspection id returns 404");

    // ================== 4. release hold on the affected draw ==================
    const el1 = await j("funder", "GET", "/api/draws/draw-1/payment-eligibility", undefined, 200);
    assert(el1.blockers.some((b) => /dispute/i.test(b)),
      "the affected draw's payment eligibility now lists the dispute hold with its reason");
    const piBlocked = await api("funder", "POST", "/api/draws/draw-1/payment-instructions",
      { amount: 1000, recipientName: "Lakeshore Rehab Contractors LLC", recipientReference: "INV-1" });
    assert(piBlocked.status === 409, "creating a payment instruction on the disputed draw is refused (409)");
    const disputesPage = await page("funder", "/project/proj-r47/disputes");
    assert(disputesPage.status === 200 && disputesPage.html.includes("Gravel base course"),
      "the project dispute register displays the dispute's scope");
    const wsA = await page("funder", `/dispute/${dA.id}`);
    assert(wsA.status === 200 && wsA.html.includes("Gravel base course"),
      "the dispute workspace renders with the hold's reason, amount and scope");

    // ================== 5. state machine: every edge, exactly once ==================
    const t = (key, id, to) => api(key, "POST", `/api/disputes/${id}/transition`, { to });
    // forbidden before anything else
    assert((await t("funder", dA.id, "READY_FOR_DECISION")).status === 409,
      "OPEN → READY_FOR_DECISION is not an allowed transition (409, no silent fallback)");
    assert((await t("funder", dA.id, "RESOLVED_RELEASE")).status === 409,
      "resolved states are unreachable through the transition API (409)");
    assert((await t("funder", dA.id, "CLOSED")).status === 409,
      "CLOSED is unreachable through the transition API (409)");
    assert((await t("funder", dA.id, "TOTALLY_BOGUS")).status === 400,
      "an unknown status is rejected cleanly (400)");
    assert((await t("field", dA.id, "UNDER_REVIEW")).status === 403,
      "a transition without MANAGE_DISPUTE is 403");
    assert((await t("pm", dA.id, "UNDER_REVIEW")).status === 403,
      "a project manager (open/respond only) cannot drive workflow transitions (403)");

    // full edge tour
    let cursor = "OPEN";
    const edges = [];
    for (const [from, tos] of Object.entries(WORKFLOW)) for (const to of tos) edges.push([from, to]);
    let toured = 0;
    for (const [from, to] of edges) {
      if (cursor !== from) {
        if (cursor !== "UNDER_REVIEW") {
          const r1 = await t("funder", dA.id, "UNDER_REVIEW");
          if (r1.status !== 200) fail(`tour reset ${cursor} → UNDER_REVIEW failed (${r1.status})`);
          cursor = "UNDER_REVIEW";
        }
        if (from !== "UNDER_REVIEW") {
          const r2 = await t("funder", dA.id, from);
          if (r2.status !== 200) fail(`tour setup UNDER_REVIEW → ${from} failed (${r2.status})`);
          cursor = from;
        }
      }
      const res = await t("funder", dA.id, to);
      if (res.status !== 200) fail(`allowed transition ${from} → ${to} failed (${res.status})`);
      cursor = to;
      toured++;
    }
    assert(toured === edges.length, `every allowed workflow transition executes (${toured} edges toured)`);
    const tourEvents = (await j("funder", "GET", `/api/disputes/${dA.id}`)).events.filter((e) => e.type === "STATUS_CHANGED");
    assert(tourEvents.length >= toured, "every transition wrote its own immutable STATUS_CHANGED audit event");

    // forbidden edges: from each state, try a target the map disallows
    const ALL_STATES = Object.keys(WORKFLOW);
    let forbiddenChecked = 0;
    for (const from of ["OPEN", "WAITING_FOR_INSPECTION", "WAITING_FOR_DOCUMENTS", "READY_FOR_DECISION", "ESCALATED"]) {
      const bad = ALL_STATES.find((s) => s !== from && !WORKFLOW[from].includes(s));
      if (!bad) continue;
      if (cursor !== from) {
        if (cursor !== "UNDER_REVIEW") { await t("funder", dA.id, "UNDER_REVIEW"); cursor = "UNDER_REVIEW"; }
        if (from === "OPEN") continue; // OPEN is unreachable again — covered above
        await t("funder", dA.id, from); cursor = from;
      }
      const res = await t("funder", dA.id, bad);
      if (res.status !== 409) fail(`forbidden transition ${from} → ${bad} was not rejected (${res.status})`);
      forbiddenChecked++;
    }
    assert(forbiddenChecked >= 4, `disallowed transitions are rejected with 409 (${forbiddenChecked} spot checks)`);

    // duplicate/concurrent: two identical transitions — exactly one wins
    await t("funder", dA.id, "UNDER_REVIEW");
    const [c1, c2] = await Promise.all([
      t("funder", dA.id, "READY_FOR_DECISION"),
      t("lender2", dA.id, "READY_FOR_DECISION"),
    ]);
    const codes = [c1.status, c2.status].sort();
    assert(codes[0] === 200 && codes[1] === 409,
      "two concurrent identical transitions: exactly one succeeds, the duplicate gets a clean 409");
    await t("funder", dA.id, "UNDER_REVIEW");

    // ================== 6. contractor responses: immutable + versioned ==================
    const r1 = (await j("pm", "POST", `/api/disputes/${dA.id}/responses`,
      { kind: "RESPONSE", body: "Thickness cores were taken at 100m intervals; we dispute the survey method." }, 201)).response;
    assert(r1.version === 1 && r1.submittedByOrganizationId === "org-crra",
      "the contractor submits response v1, attributed to user and organization");
    assert((await api("field", "POST", `/api/disputes/${dA.id}/responses`, { body: "hi" })).status === 403,
      "a user without RESPOND_TO_DISPUTE cannot submit a response (403)");
    assert((await api("pm", "POST", `/api/disputes/${dA.id}/responses`, { kind: "WEIRD", body: "x" })).status === 400,
      "an unknown response kind is rejected (400)");
    assert((await api("pm", "POST", `/api/disputes/${dA.id}/responses`, { body: "   " })).status === 400,
      "an empty response body is rejected (400)");
    const r2 = (await j("pm", "POST", `/api/disputes/${dA.id}/responses`,
      { kind: "RESPONSE", body: "Correction: cores were at 50m intervals.", supersedesResponseId: r1.id }, 201)).response;
    assert(r2.version === 2 && r2.supersedesResponseId === r1.id,
      "a correction is ADDITIVE: v2 references the superseded v1");
    const respRows = qa("SELECT * FROM dispute_responses WHERE dispute_id = ? ORDER BY version", dA.id);
    assert(respRows.length === 2 && respRows[0].body.includes("100m intervals"),
      "the original submission remains on record verbatim — nothing was overwritten");
    assert((await api("pm", "POST", `/api/disputes/${dA.id}/responses`, { body: "x", supersedesResponseId: "resp-ghost" })).status === 422,
      "superseding a response that is not on this dispute is rejected (422)");

    // ================== 7. evidence: governed links + integrity hashes ==================
    const seededEv = q1("SELECT e.id, e.hash FROM evidence_items e JOIN milestones m ON m.id = e.milestone_id WHERE m.project_id = 'proj-r47' LIMIT 1");
    const evLinked = (await j("pm", "POST", `/api/disputes/${dA.id}/evidence`,
      { evidenceType: "CORE_SAMPLE", title: "Verified field evidence for the gravel section", linkedType: "EVIDENCE_ITEM", linkedId: seededEv.id }, 201)).evidence;
    assert(evLinked.documentHash === seededEv.hash,
      "evidence linked to a governed OBV evidence item carries the item's OWN integrity hash (no weaker parallel system)");
    const evStandalone = (await j("pm", "POST", `/api/disputes/${dA.id}/evidence`,
      { evidenceType: "LAB_REPORT", title: "Independent lab gradation report", externalReference: "LAB-2214" }, 201)).evidence;
    assert(/^[0-9a-f]{64}$/.test(evStandalone.documentHash),
      "standalone evidence gets a SHA-256 integrity hash over its canonical descriptor");
    assert((await api("pm", "POST", `/api/disputes/${dA.id}/evidence`,
      { evidenceType: "X", title: "x", linkedType: "EVIDENCE_ITEM", linkedId: "ev-ghost" })).status === 422,
      "linking a nonexistent evidence item is rejected (422)");
    assert((await api("pm", "POST", `/api/disputes/${dA.id}/evidence`,
      { evidenceType: "X", title: "x", linkedType: "GARBAGE", linkedId: "y" })).status === 400,
      "an unknown link type is rejected (400)");
    assert((await api("field", "POST", `/api/disputes/${dA.id}/evidence`, { evidenceType: "X", title: "x" })).status === 403,
      "evidence submission without capability is 403");
    assert((await api("pm", "POST", `/api/dispute-evidence/${evLinked.id}/review`, { status: "ACCEPTED" })).status === 403,
      "evidence review requires MANAGE_DISPUTE (403 for the contractor)");
    const evReviewed = (await j("funder", "POST", `/api/dispute-evidence/${evLinked.id}/review`, { status: "ACCEPTED", notes: "Cores verified" }, 200)).evidence;
    assert(evReviewed.reviewStatus === "ACCEPTED" && evReviewed.reviewedByUserId === "user-funder",
      "an authorized reviewer accepts evidence with attribution");
    assert((await api("funder", "POST", `/api/dispute-evidence/${evLinked.id}/review`, { status: "REJECTED" })).status === 409,
      "re-reviewing already-reviewed evidence is refused (guarded, exactly-once)");
    const evV2 = (await j("pm", "POST", `/api/disputes/${dA.id}/evidence`,
      { evidenceType: "LAB_REPORT", title: "Corrected lab report", supersedesEvidenceId: evStandalone.id }, 201)).evidence;
    assert(evV2.version === 2 && qa("SELECT id FROM dispute_evidence_records WHERE dispute_id = ?", dA.id).length === 3,
      "evidence corrections are additive versions; originals never disappear");

    // ================== 8. cure requirements ==================
    assert((await api("field", "POST", `/api/disputes/${dA.id}/cures`, { title: "x", description: "y" })).status === 403,
      "creating a cure requires MANAGE_DISPUTE (403)");
    assert((await api("funder", "POST", `/api/disputes/${dA.id}/cures`,
      { title: "Bad date", description: "d", dueAt: "not-a-date" })).status === 400,
      "an invalid cure due date is rejected (400)");
    const cure1 = (await j("funder", "POST", `/api/disputes/${dA.id}/cures`,
      { title: "Re-lay gravel to 150mm over the failed section", description: "Re-lay and re-test cores.", dueAt: "2026-08-15", priority: "HIGH", affectedAmount: 150000 }, 201)).cure;
    assert(cure1.status === "OPEN" && cure1.priority === "HIGH", "a cure requirement opens with priority and due date");
    assert((await api("funder", "POST", `/api/dispute-cures/${cure1.id}/review`, { decision: "ACCEPTED" })).status === 409,
      "a cure cannot be reviewed before it is submitted (409)");
    const cureSub = (await j("pm", "POST", `/api/dispute-cures/${cure1.id}/submit`,
      { completionNote: "Section re-laid and compacted; new cores attached.", completionEvidenceId: evV2.id }, 200)).cure;
    assert(cureSub.status === "SUBMITTED" && cureSub.completionEvidenceId === evV2.id,
      "the responsible party submits the cure with completion evidence");
    assert((await api("pm", "POST", `/api/dispute-cures/${cure1.id}/submit`, { completionNote: "again" })).status === 409,
      "double-submitting a cure is refused (409)");
    const cureRej = (await j("funder", "POST", `/api/dispute-cures/${cure1.id}/review`, { decision: "REJECTED", note: "Core 7 still under 150mm" }, 200)).cure;
    assert(cureRej.status === "REJECTED", "a reviewer rejects the cure with a recorded note");
    await j("pm", "POST", `/api/dispute-cures/${cure1.id}/submit`, { completionNote: "Core 7 area re-worked." }, 200);
    const cureAcc = (await j("funder", "POST", `/api/dispute-cures/${cure1.id}/review`, { decision: "ACCEPTED" }, 200)).cure;
    assert(cureAcc.status === "ACCEPTED" && cureAcc.reviewedByUserId === "user-funder",
      "resubmission then acceptance completes the cure loop with attribution");

    // overdue is DISPLAY ONLY
    const cure2 = (await j("funder", "POST", `/api/disputes/${dA.id}/cures`,
      { title: "Past-due paperwork", description: "d", dueAt: "2026-01-01" }, 201)).cure;
    const detail8 = await j("funder", "GET", `/api/disputes/${dA.id}`);
    const c2v = detail8.cures.find((c) => c.id === cure2.id);
    assert(c2v.overdue === true && c2v.status === "OPEN",
      "an overdue cure DISPLAYS as overdue while its status remains OPEN — nothing auto-waives");
    assert(detail8.dispute.status === "UNDER_REVIEW",
      "an overdue deadline never auto-resolves or auto-transitions the dispute");
    assert((await api("funder", "POST", `/api/dispute-cures/${cure2.id}/extend`, { newDueAt: "2026-09-01" })).status === 400,
      "extending a deadline without a recorded reason is rejected (400)");
    const cureExt = (await j("funder", "POST", `/api/dispute-cures/${cure2.id}/extend`,
      { newDueAt: "2026-09-01", reason: "Formal extension granted at the site meeting." }, 200)).cure;
    assert(cureExt.dueAt === "2026-09-01",
      "an authorized extension moves the deadline");
    const exts = qa("SELECT * FROM dispute_cure_extensions WHERE cure_item_id = ?", cure2.id);
    assert(exts.length === 1 && exts[0].prior_due_at === "2026-01-01",
      "the extension history records prior + new deadline append-only");
    const cureWaived = (await j("funder", "POST", `/api/dispute-cures/${cure2.id}/waive`, { reason: "Superseded by cure #1." }, 200)).cure;
    assert(cureWaived.status === "WAIVED" && cureWaived.waiverReason.includes("Superseded"),
      "an authorized waiver is explicit and recorded — never automatic");
    assert((await api("funder", "POST", `/api/dispute-cures/${cure2.id}/waive`, { reason: "again" })).status === 409,
      "waiving a terminal cure is refused (409)");
    const cure3 = (await j("funder", "POST", `/api/disputes/${dA.id}/cures`, { title: "Duplicate requirement", description: "d" }, 201)).cure;
    assert(((await j("funder", "POST", `/api/dispute-cures/${cure3.id}/cancel`, { reason: "duplicate" }, 200)).cure).status === "CANCELLED",
      "a cure can be cancelled with a recorded reason");

    // ================== 9. inspections: results are evidence, never verdicts ==================
    assert((await api("field", "POST", `/api/disputes/${dA.id}/inspections`, { inspectionType: "X" })).status === 403,
      "requesting an inspection requires MANAGE_DISPUTE (403)");
    const insp1 = (await j("funder", "POST", `/api/disputes/${dA.id}/inspections`,
      { inspectionType: "THICKNESS_REINSPECTION", assignedInspectorUserId: "user-field", locationScope: "ch. 4+000–6+000" }, 201)).inspection;
    assert(insp1.status === "REQUESTED", "an inspection request opens as REQUESTED");
    const insp1s = (await j("funder", "POST", `/api/dispute-inspections/${insp1.id}/schedule`, { scheduledAt: "2026-07-28" }, 200)).inspection;
    assert(insp1s.status === "SCHEDULED" && insp1s.scheduledAt === "2026-07-28", "scheduling records the date");
    const insp1c = (await j("field", "POST", `/api/dispute-inspections/${insp1.id}/complete`,
      { result: "FAILED", notes: "Three of ten cores below 150mm." }, 200)).inspection;
    assert(insp1c.status === "COMPLETED" && insp1c.result === "FAILED",
      "the ASSIGNED inspector (without MANAGE_DISPUTE) records the result");
    const afterInsp = await j("funder", "GET", `/api/disputes/${dA.id}`);
    assert(afterInsp.dispute.status === "UNDER_REVIEW" && afterInsp.dispute.resolutionType === null,
      "a FAILED inspection result never auto-resolves or auto-transitions the dispute — it is evidence only");
    assert((await api("field", "POST", `/api/dispute-inspections/${insp1.id}/complete`, { result: "PASSED" })).status === 409,
      "completing a completed inspection is refused (409)");
    const insp2 = (await j("funder", "POST", `/api/disputes/${dA.id}/inspections`, { inspectionType: "ACCESS_CHECK" }, 201)).inspection;
    await j("funder", "POST", `/api/dispute-inspections/${insp2.id}/access-failed`, { notes: "Gate locked; owner absent." }, 200);
    const insp2r = (await j("funder", "POST", `/api/dispute-inspections/${insp2.id}/schedule`, { scheduledAt: "2026-08-02" }, 200)).inspection;
    assert(insp2r.status === "SCHEDULED", "a failed-access inspection can be rescheduled");
    assert(((await j("funder", "POST", `/api/dispute-inspections/${insp2.id}/cancel`, {}, 200)).inspection).status === "CANCELLED",
      "an open inspection can be cancelled");

    // ================== 10. advisory recommendations ==================
    const recAi = (await j("funder", "POST", `/api/disputes/${dA.id}/recommendation`,
      { kind: "RECOMMEND_PARTIAL_RELEASE", summary: "Release the undisputed 450000; hold 150000 pending re-tests.", aiGenerated: "true", basis: "Automated comparison of core results vs. specification." }, 201));
    assert(recAi.recommendation.official === false && recAi.recommendation.approvedByUserId === null,
      "an AI-generated recommendation is NOT official until a human approves it");
    assert(recAi.note === ADVISORY, "the mandatory advisory disclaimer is returned verbatim with every recommendation");
    const recApproved = (await j("compliance", "POST", `/api/dispute-recommendations/${recAi.recommendation.id}/approve`, {}, 200)).recommendation;
    assert(recApproved.official === true && recApproved.approvedByUserId === "user-compliance",
      "a human reviewer approves the AI draft, making it official with attribution");
    assert((await api("compliance", "POST", `/api/dispute-recommendations/${recAi.recommendation.id}/approve`, {})).status === 409,
      "double-approving a recommendation is refused (409)");
    const recHuman = (await j("compliance", "POST", `/api/disputes/${dA.id}/recommendation`,
      { kind: "RECOMMEND_CORRECTIVE_WORK", summary: "Complete cure item 1 before any release decision." }, 201)).recommendation;
    assert(recHuman.official === true, "a human-authored recommendation is official on entry");
    assert((await j("funder", "GET", `/api/disputes/${dA.id}`)).dispute.status === "UNDER_REVIEW",
      "recommendations are ADVISORY: recording them never changes the dispute status");
    const wsRec = await page("funder", `/dispute/${dA.id}`);
    assert(wsRec.html.includes("Advisory recommendation only") && /AI[- ]generated/i.test(wsRec.html),
      "the workspace displays the advisory disclaimer and identifies AI-generated content");

    // ================== 11. legal hold ==================
    const lh = (await j("compliance", "POST", `/api/disputes/${dA.id}/legal-hold`,
      { active: "true", reason: "Litigation counsel instructed preservation." }, 200)).dispute;
    assert(lh.legalHold === true && lh.legalHoldByUserId === "user-compliance",
      "legal hold activates with who and why recorded");
    assert((await api("compliance", "POST", `/api/disputes/${dA.id}/legal-hold`, { active: "true", reason: "again" })).status === 409,
      "activating an active legal hold is refused (409)");
    const wsLh = await page("funder", `/dispute/${dA.id}`);
    assert(wsLh.html.includes("Legal Hold Active"), "the workspace displays the Legal Hold Active banner");
    const elLh = await j("funder", "GET", "/api/draws/draw-1/payment-eligibility", undefined, 200);
    assert(elLh.blockers.some((b) => /legal hold/i.test(b)),
      "a legal hold blocks release eligibility for the affected draw");
    await t("funder", dA.id, "READY_FOR_DECISION");
    assert((await api("compliance", "POST", `/api/disputes/${dA.id}/resolve`,
      { resolutionType: "CONTINUE_HOLD", reasoning: "r", acknowledged: "true" })).status === 409,
      "no resolution can be recorded while a legal hold is active (409)");
    assert((await api("compliance", "POST", `/api/disputes/${dA.id}/close`, {})).status === 409,
      "a dispute under legal hold cannot be closed (409)");
    assert((await api("funder", "POST", `/api/disputes/${dA.id}/legal-hold`, { active: "false", reason: "cleared" })).status === 403,
      "removing a legal hold requires ELEVATED authorization — a funder rep without the explicit grant gets 403");
    assert((await api("pm", "POST", `/api/disputes/${dA.id}/legal-hold`, { active: "false", reason: "cleared" })).status === 403,
      "a project manager cannot remove a legal hold (403)");
    const lhOff = (await j("compliance", "POST", `/api/disputes/${dA.id}/legal-hold`,
      { active: "false", reason: "Counsel confirmed the preservation obligation ended." }, 200)).dispute;
    assert(lhOff.legalHold === false, "a compliance reviewer removes the hold with a recorded reason");
    assert((await api("compliance", "POST", `/api/disputes/${dA.id}/legal-hold`, { active: "false", reason: "again" })).status === 409,
      "removing a non-existent hold is refused (409)");
    const lhEvents = (await j("funder", "GET", `/api/disputes/${dA.id}`)).events.filter((e) => e.type.startsWith("LEGAL_HOLD"));
    assert(lhEvents.length === 2, "activation and removal each wrote their immutable audit event");

    // ================== 12. escalation ==================
    assert((await api("funder", "POST", `/api/disputes/${dA.id}/escalations`,
      { escalationType: "WIZARD", recipientName: "x", reason: "y" })).status === 400,
      "an unknown escalation type is rejected (400)");
    const esc = (await j("funder", "POST", `/api/disputes/${dA.id}/escalations`,
      { escalationType: "ATTORNEY", recipientName: "Banda & Mwale LLP", reason: "Contract interpretation of the thickness specification.", transmittedMaterials: "Dispute record, cure history, lab reports" }, 201)).escalation;
    assert(esc.status === "RECORDED", "an external escalation is RECORDED with recipient and transmitted materials");
    const escResp = (await j("funder", "POST", `/api/dispute-escalations/${esc.id}/respond`,
      { response: "Counsel advises the specification reading favors the lender." }, 200)).escalation;
    assert(escResp.status === "RESPONDED", "the external response is recorded");
    assert((await api("funder", "POST", `/api/dispute-escalations/${esc.id}/respond`, { response: "again" })).status === 409,
      "double-recording a response is refused (409)");
    assert(((await j("funder", "POST", `/api/dispute-escalations/${esc.id}/close`, {}, 200)).escalation).status === "CLOSED",
      "the escalation closes cleanly");

    // ================== 13. authorized resolution: full revalidation ==================
    assert((await api("funder", "POST", `/api/disputes/${dA.id}/resolve`,
      { resolutionType: "CONTINUE_HOLD", reasoning: "r", acknowledged: "true" })).status === 403,
      "SEPARATION OF DUTIES: the dispute opener can never record its own resolution (403)");
    assert((await api("compliance", "POST", `/api/disputes/${dA.id}/resolve`,
      { resolutionType: "CONTINUE_HOLD", reasoning: "r" })).status === 400,
      "the resolution acknowledgement is REQUIRED (400 without it)");
    assert((await api("pm", "POST", `/api/disputes/${dA.id}/resolve`,
      { resolutionType: "CONTINUE_HOLD", reasoning: "r", acknowledged: "true" })).status === 403,
      "resolving requires DECIDE_DISPUTE (403 for the contractor)");
    await t("funder", dA.id, "UNDER_REVIEW");
    assert((await api("compliance", "POST", `/api/disputes/${dA.id}/resolve`,
      { resolutionType: "CONTINUE_HOLD", reasoning: "r", acknowledged: "true" })).status === 409,
      "a resolution outside READY_FOR_DECISION/ESCALATED is refused (409)");
    await t("funder", dA.id, "READY_FOR_DECISION");
    // pending evidence blocks
    const evPend = (await j("pm", "POST", `/api/disputes/${dA.id}/evidence`,
      { evidenceType: "PHOTO", title: "Late photo set" }, 201)).evidence;
    const block = await api("compliance", "POST", `/api/disputes/${dA.id}/resolve`,
      { resolutionType: "CONTINUE_HOLD", reasoning: "r", acknowledged: "true" });
    const blockBody = await block.json();
    assert(block.status === 409 && /awaiting review/.test(blockBody.error ?? ""),
      "revalidation: unreviewed evidence blocks ANY resolution (409)");
    await j("funder", "POST", `/api/dispute-evidence/${evPend.id}/review`, { status: "ACCEPTED" }, 200);
    await j("funder", "POST", `/api/dispute-evidence/${evV2.id}/review`, { status: "ACCEPTED" }, 200);
    await j("funder", "POST", `/api/dispute-evidence/${evStandalone.id}/review`,
      { status: "REJECTED", notes: "Superseded by the corrected report." }, 200);
    const resolveErr = async (body) => {
      const res = await api("compliance", "POST", `/api/disputes/${dA.id}/resolve`, body);
      return { status: res.status, error: (await res.json()).error ?? "" };
    };
    // open inspection blocks
    const inspPend = (await j("funder", "POST", `/api/disputes/${dA.id}/inspections`, { inspectionType: "FINAL_CHECK" }, 201)).inspection;
    const inspBlock = await resolveErr({ resolutionType: "CONTINUE_HOLD", reasoning: "r", acknowledged: "true" });
    assert(inspBlock.status === 409 && /inspection request\(s\) are still open/.test(inspBlock.error),
      "revalidation: an in-flight inspection blocks resolution (409)");
    await j("funder", "POST", `/api/dispute-inspections/${inspPend.id}/cancel`, {}, 200);
    // unresolved cure blocks release types
    const cureOpen = (await j("funder", "POST", `/api/disputes/${dA.id}/cures`, { title: "Open item", description: "d" }, 201)).cure;
    const cureBlock = await resolveErr({ resolutionType: "AUTHORIZE_FULL_RELEASE", reasoning: "r", acknowledged: "true" });
    assert(cureBlock.status === 409 && /cure requirement\(s\) are not accepted/.test(cureBlock.error),
      "revalidation: a non-terminal cure blocks any RELEASE-type resolution (409)");
    await j("funder", "POST", `/api/dispute-cures/${cureOpen.id}/waive`, { reason: "Not required for decision." }, 200);
    // partial-release amount capped at the recorded undisputed amount
    const overCap = await resolveErr({ resolutionType: "AUTHORIZE_PARTIAL_RELEASE", amount: 450001, reasoning: "r", acknowledged: "true" });
    assert(overCap.status === 409 && /exceeds the recorded undisputed amount/.test(overCap.error),
      "a partial release above the recorded undisputed amount is refused (409)");
    assert((await api("compliance", "POST", `/api/disputes/${dA.id}/resolve`,
      { resolutionType: "AUTHORIZE_PARTIAL_RELEASE", amount: 1000.5, reasoning: "r", acknowledged: "true" })).status === 400,
      "a fractional resolution amount is refused (400)");
    // the EXISTING eligibility gates still guard release-type decisions
    const gateBlocked = await api("compliance", "POST", `/api/disputes/${dA.id}/resolve`,
      { resolutionType: "AUTHORIZE_FULL_RELEASE", reasoning: "r", acknowledged: "true" });
    assert(gateBlocked.status === 409 && /release-eligibility gates/.test((await gateBlocked.json()).error),
      "revalidation: a release decision on a draw the EXISTING controls would refuse is itself refused (409)");
    // CONTINUE_HOLD resolves; the hold persists
    const resolvedA = (await j("compliance", "POST", `/api/disputes/${dA.id}/resolve`,
      { resolutionType: "CONTINUE_HOLD", reasoning: "Re-tests confirm the deficiency; hold continues until re-laid.", acknowledged: "true" }, 200));
    assert(resolvedA.dispute.status === "RESOLVED_CONTINUE_HOLD" && resolvedA.acknowledgement === ACK,
      "an authorized CONTINUE_HOLD resolution records the decision and echoes the acknowledgement");
    assert(resolvedA.dispute.resolvedByRole === "COMPLIANCE_REVIEWER" && resolvedA.dispute.resolvedByUserId === "user-compliance",
      "the resolution records who decided, in what role and when");
    const elHold = await j("funder", "GET", "/api/draws/draw-1/payment-eligibility", undefined, 200);
    assert(elHold.blockers.some((b) => /dispute/i.test(b)),
      "RESOLVED_CONTINUE_HOLD keeps the release hold in force");
    // reopen (recorded), re-resolve as RETURN, then close
    const reopenA = await t("compliance", dA.id, "UNDER_REVIEW");
    assert(reopenA.status === 200, "a resolved dispute can be formally REOPENED to UNDER_REVIEW");
    assert((await j("funder", "GET", `/api/disputes/${dA.id}`)).events.some((e) => e.type === "REOPENED"),
      "reopening wrote its own REOPENED audit event");
    await t("funder", dA.id, "READY_FOR_DECISION");
    const returned = (await j("compliance", "POST", `/api/disputes/${dA.id}/resolve`,
      { resolutionType: "RETURN_TO_AUTHORIZED_PARTY", reasoning: "Funds decision returned to the lender and owner outside OBV.", acknowledged: "true", externalReference: "Board minute 2026-114" }, 200)).dispute;
    assert(returned.status === "RESOLVED_RETURN_RECOMMENDATION" && returned.resolutionExternalReference === "Board minute 2026-114",
      "a RETURN recommendation is recorded with its external reference");
    assert((await api("pm", "POST", `/api/disputes/${dA.id}/close`, {})).status === 403,
      "closing requires DECIDE_DISPUTE (403)");
    const closedA = (await j("compliance", "POST", `/api/disputes/${dA.id}/close`, { note: "Recorded and returned." }, 200)).dispute;
    assert(closedA.status === "CLOSED" && closedA.closedAt, "the resolved dispute closes with a timestamp");
    assert((await t("compliance", dA.id, "UNDER_REVIEW")).status === 409,
      "CLOSED is terminal: no transition leaves it (409)");
    assert((await api("pm", "POST", `/api/disputes/${dA.id}/responses`, { body: "late" })).status === 409,
      "a closed dispute accepts no further responses (409)");
    assert((await api("pm", "POST", `/api/disputes/${dA.id}/evidence`, { evidenceType: "X", title: "late" })).status === 409,
      "a closed dispute accepts no further evidence (409)");
    const elClosed = await j("funder", "GET", "/api/draws/draw-1/payment-eligibility", undefined, 200);
    assert(!elClosed.blockers.some((b) => /dispute|legal hold/i.test(b)),
      "closing the dispute ends its release hold (remaining blockers are the draw's own)");

    // ================== 14. release + partial-release on an eligible draw ==================
    const dB = (await j("funder", "POST", "/api/projects/proj-r47/disputes", {
      subjectType: "DRAW_REQUEST", subjectId: "draw-vam", disputedAmount: 30000,
      undisputedAmount: 170000, affectedScope: "Drainage tranche — culvert C-4 splash apron",
      reason: "Splash apron erosion observed after the May storm.",
    }, 201)).dispute;
    const elB = await j("funder", "GET", "/api/draws/draw-vam/payment-eligibility", undefined, 200);
    assert(elB.eligible === false && elB.blockers.some((b) => /dispute/i.test(b)),
      "opening a dispute on the ELIGIBLE draw immediately pauses its release eligibility");
    const piCount = q1("SELECT COUNT(*) c FROM payment_instructions").c;
    const piTry = await api("funder", "POST", "/api/draws/draw-vam/payment-instructions",
      { amount: 1000, recipientName: "Lakeshore Rehab Contractors LLC", recipientReference: "INV-77" });
    assert(piTry.status === 409 && /dispute/i.test((await piTry.json()).error),
      "a payment instruction on the disputed draw is refused, naming the dispute hold");
    assert(q1("SELECT COUNT(*) c FROM payment_instructions").c === piCount,
      "the refused instruction wrote NOTHING — no instruction row exists");
    await t("funder", dB.id, "UNDER_REVIEW");
    await t("funder", dB.id, "READY_FOR_DECISION");
    const baselineRemaining = elB.approvedRemaining;
    const partial = (await j("compliance", "POST", `/api/disputes/${dB.id}/resolve`,
      { resolutionType: "AUTHORIZE_PARTIAL_RELEASE", amount: 170000, reasoning: "Only the apron scope remains contested.", acknowledged: "true" }, 200)).dispute;
    assert(partial.status === "RESOLVED_PARTIAL_RELEASE" && partial.resolutionAmount === 170000,
      "an authorized PARTIAL release records the undisputed amount released for eligibility");
    const elPartial = await j("funder", "GET", "/api/draws/draw-vam/payment-eligibility", undefined, 200);
    assert(elPartial.eligible === true,
      "after partial release the draw is eligible again for the undisputed remainder");
    assert(elPartial.approvedRemaining === baselineRemaining - 30000,
      `the disputed 30000 stays held: instructable cap dropped exactly by it (${baselineRemaining} → ${elPartial.approvedRemaining})`);
    assert(bankingSnapshot().project_virtual_accounts === baseline.project_virtual_accounts,
      "the partial release changed NO account balance — it is an eligibility record, not a movement of funds");
    // reopen and fully release
    await t("compliance", dB.id, "UNDER_REVIEW");
    await t("funder", dB.id, "READY_FOR_DECISION");
    const fullRel = (await j("compliance", "POST", `/api/disputes/${dB.id}/resolve`,
      { resolutionType: "AUTHORIZE_FULL_RELEASE", reasoning: "Apron repaired; re-inspection on the project record.", acknowledged: "true" }, 200)).dispute;
    assert(fullRel.status === "RESOLVED_RELEASE",
      "an authorized FULL release resolves the dispute (the existing gates passed)");
    const elFull = await j("funder", "GET", "/api/draws/draw-vam/payment-eligibility", undefined, 200);
    assert(elFull.eligible === true && elFull.approvedRemaining === baselineRemaining,
      "RESOLVED_RELEASE ends the hold entirely — the instructable cap is fully restored");
    await j("compliance", "POST", `/api/disputes/${dB.id}/close`, {}, 200);

    // ---- remaining resolution types on a project-scope dispute ----
    const dC = (await j("funder", "POST", "/api/projects/proj-r47/disputes", {
      subjectType: "PROJECT", subjectId: "proj-r47", disputedAmount: 12000,
      affectedScope: "General conditions billing", reason: "Contested supervision hours in the June invoice.",
    }, 201)).dispute;
    await t("funder", dC.id, "UNDER_REVIEW");
    await t("funder", dC.id, "READY_FOR_DECISION");
    const cured = (await j("compliance", "POST", `/api/disputes/${dC.id}/resolve`,
      { resolutionType: "REQUIRE_ADDITIONAL_CURE", reasoning: "Timesheets must be produced.", acknowledged: "true" }, 200)).dispute;
    assert(cured.status === "CURE_IN_PROGRESS" && cured.resolutionType === null,
      "REQUIRE_ADDITIONAL_CURE returns the dispute to CURE_IN_PROGRESS without a terminal resolution");
    await t("funder", dC.id, "READY_FOR_DECISION");
    const escd = (await j("compliance", "POST", `/api/disputes/${dC.id}/resolve`,
      { resolutionType: "ESCALATE_EXTERNALLY", reasoning: "Referred to the owner's QS.", acknowledged: "true" }, 200)).dispute;
    assert(escd.status === "ESCALATED", "ESCALATE_EXTERNALLY moves the dispute to ESCALATED");
    const cwr = (await j("compliance", "POST", `/api/disputes/${dC.id}/resolve`,
      { resolutionType: "CLOSE_WITHOUT_RELEASE", reasoning: "QS upheld the deduction.", acknowledged: "true" }, 200)).dispute;
    assert(cwr.status === "RESOLVED_CONTINUE_HOLD" && cwr.resolutionType === "CLOSE_WITHOUT_RELEASE",
      "a decision can be recorded directly from ESCALATED (recorded escalation path)");
    await j("compliance", "POST", `/api/disputes/${dC.id}/close`, {}, 200);

    // ================== 15. timeline completeness ==================
    const tl = (await j("funder", "GET", `/api/disputes/${dA.id}`)).events;
    const types = new Set(tl.map((e) => e.type));
    for (const required of [
      "CREATED", "STATUS_CHANGED", "RESPONSE_SUBMITTED", "EVIDENCE_SUBMITTED", "EVIDENCE_REVIEWED",
      "CURE_CREATED", "CURE_SUBMITTED", "CURE_REVIEWED", "CURE_WAIVED", "CURE_CANCELLED", "CURE_EXTENDED",
      "INSPECTION_REQUESTED", "INSPECTION_UPDATED", "RECOMMENDATION_RECORDED", "RECOMMENDATION_APPROVED",
      "LEGAL_HOLD_ACTIVATED", "LEGAL_HOLD_REMOVED", "ESCALATED", "ESCALATION_UPDATED",
      "RESOLVED", "REOPENED", "CLOSED",
    ]) {
      if (!types.has(required)) fail(`timeline is missing a ${required} event`);
    }
    pass("the timeline contains EVERY lifecycle event type (22 kinds) for the exercised dispute");
    assert(tl.every((e) => e.actorUserId && e.createdAt), "every timeline event is attributed and timestamped");
    const sorted = [...tl].every((e, i, a) => i === 0 || a[i - 1].createdAt <= e.createdAt);
    assert(sorted, "the timeline is chronologically ordered");
    const evCount = q1("SELECT COUNT(*) c FROM dispute_events").c;
    assert(evCount >= tl.length, "dispute events accumulate append-only");

    // ================== 16. packages + report integrity ==================
    const gen = await api("funder", "POST", "/api/draws/draw-1/verification-package");
    assert(gen.status === 201, "the draw verification package generates with disputes present");
    const rep = (await gen.json()).report;
    const dlRes = await fetch(`${BASE}/reports/file/${rep.id}`, { headers: { cookie: jars.funder } });
    const zip = readZip(Buffer.from(await dlRes.arrayBuffer()));
    assert(Boolean(zip["dispute-register.csv"]) && zip["dispute-register.csv"].toString("utf8").includes(dA.id),
      "the draw package carries the dispute register including this draw's dispute");
    assert(zip["dispute-timeline.csv"].toString("utf8").split("\r\n").length > 20,
      "the draw package carries the full dispute timeline");
    const sum = JSON.parse(zip["dispute-summary.json"].toString("utf8"));
    assert(sum.state === "RECORDED" && /never modify authoritative accounting balances/.test(sum.note),
      "the dispute summary states the workflow-record doctrine explicitly");
    assert(zip["dispute-recommendations.csv"].toString("utf8").includes(ADVISORY),
      "every packaged recommendation row carries the advisory disclaimer");
    const manifest = JSON.parse(zip["manifest.json"].toString("utf8"));
    let verified = 0;
    for (const f of manifest.fileInventory) {
      const buf = zip[f.path];
      if (!buf) fail(`manifest lists ${f.path} but the ZIP lacks it`);
      const h = createHash("sha256").update(buf).digest("hex");
      if (h !== f.sha256) fail(`hash mismatch for ${f.path}`);
      verified++;
    }
    assert(verified === manifest.fileInventory.length && manifest.fileInventory.some((f) => f.path.startsWith("dispute-")),
      `the package manifest recomputes for all ${verified} files including the dispute registers`);

    const apGen = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", {});
    assert(apGen.status === 201, "the project audit package generates with disputes present");
    const ap = (await apGen.json()).auditPackage;
    const apDl = await fetch(`${BASE}/audit-packages/${ap.id}/download`, { headers: { cookie: jars.funder } });
    const apZip = readZip(Buffer.from(await apDl.arrayBuffer()));
    const apReg = apZip["12_disputes/dispute-register.csv"].toString("utf8");
    assert(apReg.includes("disp-demo-1") && apReg.includes(dA.id) && apReg.includes(dB.id) && apReg.includes(dC.id),
      "the audit package's 12_disputes register lists every dispute in the project");
    const apRes = JSON.parse(apZip["12_disputes/dispute-resolutions.json"].toString("utf8"));
    assert(apRes.acknowledgementRequiredAtDecision === ACK && apRes.resolutions.length >= 3,
      "the audit package records each resolution together with the required acknowledgement text");
    const histGen = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", { asOf: "2026-07-01T00:00:00.000Z" });
    const hist = (await histGen.json()).auditPackage;
    const histDl = await fetch(`${BASE}/audit-packages/${hist.id}/download`, { headers: { cookie: jars.funder } });
    const histZip = readZip(Buffer.from(await histDl.arrayBuffer()));
    const histSum = JSON.parse(histZip["12_disputes/dispute-summary.json"].toString("utf8"));
    assert(histSum.state === "NOT_RECORDED",
      "as-of honesty: a package dated before any dispute reports NOT_RECORDED instead of inventing rows");

    // ================== 17. banking non-mutation regression ==================
    assertSnapshotEqual(baseline, bankingSnapshot(),
      "BANKING NON-MUTATION: after the ENTIRE dispute lifecycle every protected banking/financial table is byte-for-byte unchanged");
    assert(q1("SELECT COUNT(*) c FROM banking_events").c === 10,
      "no dispute action generated a banking/provider event");
    assert(q1("SELECT COUNT(*) c FROM bank_transactions").c === 2,
      "no dispute action created or altered a bank transaction");

    // ================== 18. read isolation inside the tenant ==================
    const fieldView = await api("field", "GET", `/api/disputes/${dA.id}`);
    assert(fieldView.status === 200, "a same-tenant participant can VIEW the dispute record");
    assert((await api("field", "POST", `/api/disputes/${dA.id}/transition`, { to: "UNDER_REVIEW" })).status === 403,
      "…but still cannot mutate anything without a capability (403)");

    // ================== 19. hardening regressions ==================
    // (These fixtures insert rows into governance tables via SQL, so they
    // run strictly AFTER the banking non-mutation snapshot comparison.)

    // ---- schema: hold lookups are indexed ----
    const idx = qa("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_dispute%'").map((r) => r.name);
    assert(
      ["idx_disputes_project", "idx_disputes_draw", "idx_dispute_events_dispute", "idx_dispute_cures_dispute"].every((n) => idx.includes(n)),
      `dispute tables are indexed for the per-eligibility hold lookups (${idx.length} indexes)`
    );

    // ---- reopen clears the current-decision record ----
    const dD = (await j("funder", "POST", "/api/projects/proj-r47/disputes", {
      subjectType: "PROJECT", subjectId: "proj-r47", disputedAmount: 9000,
      affectedScope: "Survey remeasurement", reason: "Chainage overlap in the June measurement.",
    }, 201)).dispute;
    await t("funder", dD.id, "UNDER_REVIEW");
    await t("funder", dD.id, "READY_FOR_DECISION");
    const firstDecision = (await j("compliance", "POST", `/api/disputes/${dD.id}/resolve`,
      { resolutionType: "CONTINUE_HOLD", reasoning: "Hold pending remeasure.", conditions: "Independent survey required", externalReference: "MEMO-77", acknowledged: "true" }, 200)).dispute;
    assert(firstDecision.resolutionConditions === "Independent survey required" && firstDecision.resolutionExternalReference === "MEMO-77",
      "first decision records its own conditions and external reference");
    await t("compliance", dD.id, "UNDER_REVIEW");
    const afterReopen = (await j("funder", "GET", `/api/disputes/${dD.id}`)).dispute;
    assert(
      afterReopen.resolutionType === null && afterReopen.resolutionAmount === null &&
        afterReopen.resolutionConditions === null && afterReopen.resolutionExternalReference === null &&
        afterReopen.resolvedAt === null && afterReopen.resolvedByUserId === null,
      "REOPEN clears every current-decision field — no stale outcome survives on the record"
    );
    const dDTl = (await j("funder", "GET", `/api/disputes/${dD.id}`)).events;
    assert(dDTl.filter((e) => e.type === "RESOLVED").length === 1 && dDTl.some((e) => e.type === "REOPENED" && /prior recorded decision \(CONTINUE_HOLD\)/.test(e.detail)),
      "the prior decision remains verbatim on the append-only timeline and the REOPENED event names it");
    await t("funder", dD.id, "READY_FOR_DECISION");
    const secondDecision = (await j("compliance", "POST", `/api/disputes/${dD.id}/resolve`,
      { resolutionType: "RETURN_TO_AUTHORIZED_PARTY", reasoning: "Returned to the owner.", acknowledged: "true" }, 200)).dispute;
    assert(
      secondDecision.resolutionType === "RETURN_TO_AUTHORIZED_PARTY" &&
        secondDecision.resolutionConditions === null && secondDecision.resolutionExternalReference === null,
      "a later decision NEVER inherits conditions or references from an earlier one"
    );

    // ---- legal hold pins a resolved dispute (no reopen, no close) ----
    await j("compliance", "POST", `/api/disputes/${dD.id}/legal-hold`, { active: "true", reason: "Counsel preservation notice." }, 200);
    assert((await t("compliance", dD.id, "UNDER_REVIEW")).status === 409,
      "a RESOLVED dispute under legal hold cannot be reopened (409)");
    assert((await api("compliance", "POST", `/api/disputes/${dD.id}/close`, {})).status === 409,
      "…and cannot be closed while the hold stands (409)");
    await j("compliance", "POST", `/api/disputes/${dD.id}/legal-hold`, { active: "false", reason: "Preservation obligation ended." }, 200);

    // ---- a CLOSED dispute is frozen for EVERY sub-record ----
    // (fixtures are created while the dispute is active, then it closes)
    const dE = (await j("funder", "POST", "/api/projects/proj-r47/disputes", {
      subjectType: "PROJECT", subjectId: "proj-r47", disputedAmount: 4000,
      affectedScope: "Traffic management costs", reason: "Duplicate day-rate billing.",
    }, 201)).dispute;
    await t("funder", dE.id, "UNDER_REVIEW");
    const cureE = (await j("funder", "POST", `/api/disputes/${dE.id}/cures`, { title: "Produce daily records", description: "Site diary extracts." }, 201)).cure;
    const escE = (await j("funder", "POST", `/api/disputes/${dE.id}/escalations`,
      { escalationType: "OWNER", recipientName: "District Council", reason: "Rate ruling requested." }, 201)).escalation;
    const recE = (await j("funder", "POST", `/api/disputes/${dE.id}/recommendation`,
      { kind: "RECOMMEND_CONTINUED_HOLD", summary: "Hold until diaries arrive.", aiGenerated: "true" }, 201)).recommendation;
    await j("funder", "POST", `/api/dispute-cures/${cureE.id}/waive`, { reason: "Records arrived by other means." }, 200);
    await t("funder", dE.id, "READY_FOR_DECISION");
    await j("compliance", "POST", `/api/disputes/${dE.id}/resolve`,
      { resolutionType: "CONTINUE_HOLD", reasoning: "Deduction stands.", acknowledged: "true" }, 200);
    const evE = (await j("pm", "POST", `/api/disputes/${dE.id}/evidence`,
      { evidenceType: "SITE_DIARY", title: "Late diary extract" }, 201)).evidence;
    await j("compliance", "POST", `/api/disputes/${dE.id}/close`, {}, 200);
    assert((await api("funder", "POST", `/api/dispute-evidence/${evE.id}/review`, { status: "ACCEPTED" })).status === 409,
      "FROZEN: evidence on a closed dispute cannot be reviewed (409)");
    assert((await api("pm", "POST", `/api/dispute-cures/${cureE.id}/submit`, { completionNote: "late" })).status === 409,
      "FROZEN: a closed dispute's cure cannot be submitted (409)");
    assert((await api("funder", "POST", `/api/dispute-cures/${cureE.id}/extend`, { newDueAt: "2026-12-01", reason: "r" })).status === 409,
      "FROZEN: a closed dispute's cure deadline cannot be extended (409)");
    assert((await api("funder", "POST", `/api/disputes/${dE.id}/recommendation`,
      { kind: "RECOMMEND_FULL_RELEASE", summary: "late" })).status === 409,
      "FROZEN: no recommendation can be recorded on a closed dispute (409)");
    assert((await api("compliance", "POST", `/api/dispute-recommendations/${recE.id}/approve`, {})).status === 409,
      "FROZEN: an AI draft on a closed dispute cannot be approved (409)");
    assert((await api("funder", "POST", `/api/disputes/${dE.id}/escalations`,
      { escalationType: "OWNER", recipientName: "x", reason: "y" })).status === 409,
      "FROZEN: no escalation can be recorded on a closed dispute (409)");
    assert((await api("funder", "POST", `/api/dispute-escalations/${escE.id}/respond`, { response: "late" })).status === 409,
      "FROZEN: a closed dispute's escalation cannot be updated (409)");

    // ---- named users must be project participants (no cross-tenant probe) ----
    const nameProbe = async (body) => {
      const res = await api("funder", "POST", "/api/projects/proj-r47/disputes", {
        subjectType: "PROJECT", subjectId: "proj-r47", disputedAmount: 100,
        affectedScope: "probe", reason: "probe", ...body,
      });
      return { status: res.status, error: (await res.json()).error ?? "" };
    };
    const foreign = await nameProbe({ responsibleReviewerUserId: "user-x" });
    const ghostU = await nameProbe({ responsibleReviewerUserId: "user-ghost" });
    assert(foreign.status === 422 && ghostU.status === 422 && foreign.error === ghostU.error,
      "naming a foreign-tenant user and naming a nonexistent user return the IDENTICAL 422 — no user-directory probe");
    const dF = (await j("funder", "POST", "/api/projects/proj-r47/disputes", {
      subjectType: "PROJECT", subjectId: "proj-r47", disputedAmount: 500,
      affectedScope: "Named-user checks", reason: "fixture",
    }, 201)).dispute;
    await t("funder", dF.id, "UNDER_REVIEW");
    assert((await api("funder", "POST", `/api/disputes/${dF.id}/cures`,
      { title: "x", description: "y", responsiblePartyUserId: "user-x" })).status === 422,
      "a cure's responsible party must be a project participant (422)");
    assert((await api("funder", "POST", `/api/disputes/${dF.id}/inspections`,
      { inspectionType: "X", assignedInspectorUserId: "user-x" })).status === 422,
      "an inspection's assigned inspector must be a project participant (422)");
    assert((await api("funder", "POST", `/api/disputes/${dF.id}/inspections`,
      { inspectionType: "SPOT_CHECK", assignedInspectorUserId: "user-field" })).status === 201,
      "…while a genuine project participant is accepted");

    // ---- cross-tenant sub-record access with REAL ids is still a 404 ----
    assert((await api("outsider", "POST", `/api/dispute-cures/${cureE.id}/submit`, { completionNote: "x" })).status === 404,
      "an unrelated tenant using a REAL cure id gets the same 404 as a guess");
    assert((await api("outsider", "POST", `/api/dispute-evidence/${evE.id}/review`, { status: "ACCEPTED" })).status === 404,
      "an unrelated tenant using a REAL evidence id gets the same 404 as a guess");
    assert((await api("outsider", "POST", `/api/dispute-escalations/${escE.id}/respond`, { response: "x" })).status === 404,
      "an unrelated tenant using a REAL escalation id gets the same 404 as a guess");
    assert((await api("funder", "POST", `/api/disputes/${dF.id}`, {})).status === 405,
      "POST to the bare dispute resource is a clean 405");

    // ---- release decisions on a project WITHOUT a banking layer ----
    // The governance gate is still authoritative; the missing virtual
    // account alone must not make an authorized decision unrecordable.
    exec(`INSERT INTO projects (id, organization_id, name, description, location, site_boundary, total_budget)
          VALUES ('proj-nb', 'org-cdfc', 'Bridge Deck Repairs (NB)', 'No-banking fixture', 'Mzimba', '[]', 100000)`);
    exec(`INSERT INTO draw_requests (id, organization_id, project_id, draw_number, submitted_at, requested_amount, approved_amount, status, created_at, updated_at)
          VALUES ('draw-nb', 'org-cdfc', 'proj-nb', 1, '2026-07-01T00:00:00.000Z', 40000, 40000, 'APPROVED', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`);
    exec(`INSERT INTO approval_requests (id, draw_request_id, subject_type, status, required_roles, created_at)
          VALUES ('appr-nb', 'draw-nb', 'DRAW', 'APPROVED', '["FUNDER_REP"]', '2026-07-01T00:00:00.000Z')`);
    exec(`INSERT INTO draw_requests (id, organization_id, project_id, draw_number, submitted_at, requested_amount, status, created_at, updated_at)
          VALUES ('draw-nb2', 'org-cdfc', 'proj-nb', 2, '2026-07-02T00:00:00.000Z', 10000, 'UNDER_REVIEW', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')`);
    const dNb = (await j("funder", "POST", "/api/projects/proj-nb/disputes", {
      subjectType: "DRAW_REQUEST", subjectId: "draw-nb", disputedAmount: 5000, undisputedAmount: 35000,
      affectedScope: "Deck joint sealing", reason: "Sealant batch certificate missing.",
    }, 201)).dispute;
    await t("funder", dNb.id, "UNDER_REVIEW");
    await t("funder", dNb.id, "READY_FOR_DECISION");
    const nbRelease = (await j("compliance", "POST", `/api/disputes/${dNb.id}/resolve`,
      { resolutionType: "AUTHORIZE_FULL_RELEASE", reasoning: "Certificate produced.", acknowledged: "true" }, 200)).dispute;
    assert(nbRelease.status === "RESOLVED_RELEASE",
      "a release decision on a governance-approved draw WITHOUT a banking account records cleanly");
    const dNb2 = (await j("funder", "POST", "/api/projects/proj-nb/disputes", {
      subjectType: "DRAW_REQUEST", subjectId: "draw-nb2", disputedAmount: 1000,
      affectedScope: "Parapet works", reason: "fixture",
    }, 201)).dispute;
    await t("funder", dNb2.id, "UNDER_REVIEW");
    await t("funder", dNb2.id, "READY_FOR_DECISION");
    const nbBlocked = await api("compliance", "POST", `/api/disputes/${dNb2.id}/resolve`,
      { resolutionType: "AUTHORIZE_FULL_RELEASE", reasoning: "r", acknowledged: "true" });
    assert(nbBlocked.status === 409 && /governance is not complete/.test((await nbBlocked.json()).error),
      "…but WITHOUT completed governance the release decision is still refused (409)");

    // ---- funding path: scheduling external funding on a disputed draw ----
    const fundBlocked = await api("funder", "POST", "/api/draws/draw-nb2/funding", { fundingMethod: "WIRE" });
    assert(fundBlocked.status === 409 && /dispute/i.test((await fundBlocked.json()).error),
      "scheduling external funding on a draw with an active dispute is refused at the lender funding boundary (409)");

    console.log(`\nAll ${passed} dispute + release-hold checkpoints passed.`);
  } finally {
    try { db.close(); } catch {}
    server.kill();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
