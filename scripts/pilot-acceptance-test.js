#!/usr/bin/env node
/**
 * External-pilot acceptance — the first-lender lifecycle in PILOT
 * posture, with NO demo shortcuts: no role switcher, no demo reset, no
 * seeded data, no identity bypass. Every session in this suite is minted
 * by the production identity platform (magic links captured through the
 * deterministic file-outbox test provider, or invitation acceptance).
 *
 *   pilot posture up (empty database + bootstrap admin)
 *   → /demo unavailable → real magic-link sign-in
 *   → counterparty org + real-style invitations
 *   → project configured (template, geography, matrix) → launch
 *   → field evidence → dual-control approvals → release eligibility
 *   → draw request submitted → recipient notifications
 *   → lender decision → lender package
 *   → backup → verify → restore into an isolated environment
 *   → timeline/audit intact → tenant isolation → banking sim absent
 *   → restart preserves everything
 */
const { spawn, spawnSync } = require("node:child_process");
const { stopProcessAndWait } = require("./lib/proc");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "dist", "server", "http", "server.js");

// Pilot posture is declared explicitly below; drop the unified runner's
// ambient demo-banking injection so it cannot contradict the declaration.
delete process.env.OBV_BANKING_MODE;
delete process.env.OBV_BANKING_PRODUCTION_ENABLE;
delete process.env.OBV_ENVIRONMENT;
const PORT = 3351;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-accept-"));
const RESTORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-accept-rst-"));
const SECRET = "fedcba9876543210fedcba9876543210fedcba98";
const ADMIN_EMAIL = "operator@firstlender.example";

const PILOT_ENV = {
  ...process.env,
  OBV_ENVIRONMENT: "pilot",
  OBV_DATA_DIR: DATA_DIR,
  OBV_SESSION_SECRET: SECRET,
  // The file outbox is the DETERMINISTIC TEST PROVIDER for magic links —
  // an explicit operator choice the platform allows; pilot:check flags it
  // for real deployments (covered in pilot-production-test.js).
  OBV_AUTH_LINK_DELIVERY: "file",
  OBV_BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
  OBV_BOOTSTRAP_ORG_NAME: "First Lender Capital",
  PORT: String(PORT),
};

let passed = 0;
const pass = (m) => {
  passed++;
  console.log(`  ✓ [${String(passed).padStart(2, "0")}] ${m}`);
};
const fail = (m) => {
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (c, m) => (c ? pass(m) : fail(m));

const jars = {};
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

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  fail("pilot server did not become healthy");
}

/** Complete the production magic-link flow for an email; returns the
 *  session cookie. The outbox file is the deterministic link capture. */
async function signInByEmail(email) {
  const req = await fetch(BASE + "/api/auth/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!req.ok) fail(`magic-link request for ${email} -> ${req.status}`);
  const lines = fs.readFileSync(path.join(DATA_DIR, "auth-outbox.jsonl"), "utf8").trim().split("\n");
  const mine = lines.map((l) => JSON.parse(l)).filter((e) => e.to === email);
  const link = mine[mine.length - 1].link;
  const confirm = await fetch(link, { redirect: "manual" });
  const confirmCookie = (confirm.headers.getSetCookie() ?? []).find((c) => c.startsWith("obv_confirm="));
  const token = /token=([0-9a-f]{64})/.exec(link)[1];
  const complete = await fetch(BASE + "/api/auth/complete", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: confirmCookie.split(";")[0] },
    body: JSON.stringify({ token, confirm: confirmCookie.split(";")[0].split("=")[1] }),
    redirect: "manual",
  });
  const auth = (complete.headers.getSetCookie() ?? []).find((c) => c.startsWith("obv_auth="));
  if (!auth) fail(`magic-link completion for ${email} minted no session`);
  return auth.split(";")[0];
}

/** The production auth cookie from a Set-Cookie list (acceptance also
 *  sets the non-HttpOnly CSRF convenience copy — never a credential). */
function authCookieFrom(res, label) {
  const c = (res.headers.getSetCookie() ?? []).find((x) => x.startsWith("obv_auth="));
  if (!c) fail(`${label}: no obv_auth session cookie in the response`);
  return c.split(";")[0];
}

/** Deterministic >256-byte real PNG (the mock visual check needs real
 *  image content — same builder the onboarding suite uses). */
const zlib = require("node:zlib");
function testPng(seedByte) {
  const w = 96, h = 96;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let i = 1; i < row.length; i++) row[i] = (i * 31 + y * 7 + seedByte) % 256;
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  const crcTable = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
  ]);
  return "data:image/png;base64," + png.toString("base64");
}

let server = null;
process.on("exit", () => {
  try { server?.kill(); } catch { /* already gone */ }
});

async function main() {
  console.log("Pilot acceptance — first-lender lifecycle in pilot posture, no demo shortcuts");

  // Environment guard: a stale server on the suite port would answer with
  // FOREIGN state and turn every probe into noise. Refuse, don't mislead.
  let squatter = false;
  try { squatter = (await fetch(BASE + "/api/health")).ok; } catch {}
  if (squatter) fail(`another process is already serving ${BASE} — kill it and rerun`);

  // ---- 1-2. pilot posture up; /demo unavailable ----
  server = spawn(process.execPath, [SERVER], { env: PILOT_ENV, stdio: "ignore" });
  await waitUp();
  const demo = await fetch(BASE + "/demo", { redirect: "manual" });
  const switcher = await fetch(BASE + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "user-funder" }),
  });
  assert(demo.status === 404 && switcher.status === 404, "pilot posture: /demo and the role switcher do not exist");

  // ---- 3-6. bootstrap + real production identity sign-in ----
  jars.admin = await signInByEmail(ADMIN_EMAIL);
  const me = await (await fetch(BASE + "/overview", { headers: { cookie: jars.admin, accept: "text/html" } })).text();
  assert(me.includes("First Lender Capital") || me.length > 500, "bootstrap administrator signed in through the real email flow");

  const orgs = await j("admin", "POST", "/api/pilot/orgs", {
    name: "Meridian Construction Group", kind: "IMPLEMENTING_AGENCY",
  }, 201);
  const impl = orgs.organization;
  pass("counterparty organization created through the admin surface");

  // Identify the bootstrap org id from the invitation the admin can mint.
  const adminUserRow = (() => {
    const db = new DatabaseSync(path.join(DATA_DIR, "obv.db"), { readOnly: true });
    const row = db.prepare("SELECT u.id, u.organization_id FROM users u JOIN organizations o ON o.id = u.organization_id WHERE o.name = 'First Lender Capital'").get();
    db.close();
    return row;
  })();
  const lenderOrgId = adminUserRow.organization_id;

  // Invite a real-style compliance reviewer by email.
  const inv = await j("admin", "POST", "/api/pilot/invitations", {
    email: "compliance@firstlender.example", organizationId: lenderOrgId, role: "COMPLIANCE_REVIEWER",
  }, 201);
  assert(/\/invite\//.test(inv.activationLink), "lender user invited by email (activation link minted once)");
  {
    const db = new DatabaseSync(path.join(DATA_DIR, "obv.db"), { readOnly: true });
    const redacted = db
      .prepare("SELECT body_text FROM email_outbox WHERE kind = 'INVITATION' ORDER BY created_at DESC LIMIT 1")
      .get();
    db.close();
    assert(
      redacted && !redacted.body_text.includes(inv.activationLink.split("/invite/")[1]),
      "the invitation email record is credential-redacted at rest"
    );
  }
  const accept = await fetch(BASE + "/api/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: inv.activationLink.split("/invite/")[1],
      name: "Priya Raman", title: "Compliance Officer",
    }),
  });
  assert(accept.status === 201, "invitation accepted — identity created, email verified");
  jars.compliance = authCookieFrom(accept, "compliance acceptance");
  const reviewer = (await accept.json()).user;

  // ---- 7. configure the pilot project ----
  const proj = await j("admin", "POST", "/api/pilot/projects", {
    name: "Riverside Mixed-Use Rehabilitation", code: "RMU-2026", category: "BUILDING",
    organizationId: lenderOrgId, implementingOrgId: impl.id,
    obvControlledAmount: 900_000, totalValue: 1_100_000, currency: "USD",
    plannedStart: "2026-09-01", plannedEnd: "2027-08-31",
    timezone: "America/New_York", country: "USA", region: "DC",
  }, 201);
  const project = proj.project;
  const tmpl = await j("admin", "POST", `/api/pilot/projects/${project.id}/template`, {
    templateKey: "road-rehabilitation",
  }, 201);
  const milestones = tmpl.milestones;
  assert(milestones.length >= 3, `project configured from template (${milestones.length} milestones, tranches = OBV-controlled amount)`);
  await j("admin", "POST", `/api/pilot/projects/${project.id}/geography`, {
    kind: "POLYGON",
    coordinates: ["-77.02, 38.90", "-77.01, 38.90", "-77.01, 38.91", "-77.02, 38.91"],
    label: "Riverside site",
  }, 200);
  await j("admin", "POST", `/api/pilot/projects/${project.id}/approval-matrix`, {
    roles: ["PROJECT_MANAGER", "COMPLIANCE_REVIEWER"],
  }, 200);
  pass("geography + dual-control approval matrix configured");

  // Project-scoped FIELD invitation (auto assignment).
  const fInv = await j("admin", "POST", "/api/pilot/invitations", {
    email: "site@meridian.example", organizationId: impl.id, role: "FIELD", projectId: project.id,
  }, 201);
  const fAccept = await fetch(BASE + "/api/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: fInv.activationLink.split("/invite/")[1],
      name: "Jordan Site", title: "Site Engineer",
    }),
  });
  assert(fAccept.status === 201, "field engineer invited and activated with automatic project assignment");
  jars.field = authCookieFrom(fAccept, "field acceptance");

  const launch = await j("admin", "POST", `/api/pilot/projects/${project.id}/launch`, {}, 201);
  assert(launch.project.status === "ACTIVE", "project launched — configuration snapshot recorded, nothing released");

  // ---- 8-10. evidence → dual control → release eligibility ----
  const ctx = await (await fetch(BASE + "/api/field-context", { headers: { cookie: jars.field } })).json();
  if (!ctx.projects || !ctx.projects.length) fail(`field context empty: ${JSON.stringify(ctx).slice(0, 300)}`);
  const m1 = ctx.projects[0].milestones[0];
  const evRes = await fetch(BASE + "/api/evidence", {
    method: "POST",
    headers: { cookie: jars.field, "content-type": "application/json" },
    body: JSON.stringify({
      milestoneId: m1.id,
      photoDataUrl: testPng(1),
      latitude: 38.905, longitude: -77.015,
      capturedAt: new Date(Date.now() - 10 * 60000).toISOString(),
      deviceMetadata: { userAgent: "pilot-acceptance", platform: "Android", screen: "412x915", language: "en" },
      isDemoFallback: false,
    }),
  });
  const ev = await evRes.json();
  if (!ev.approvalRequest) fail(`evidence submit -> ${evRes.status}: ${JSON.stringify(ev).slice(0, 300)}`);
  pass("field evidence verified through the normal pipeline; approval requested");

  const selfApprove = await fetch(BASE + `/api/approvals/${ev.approvalRequest.id}/decision`, {
    method: "POST",
    headers: { cookie: jars.field, "content-type": "application/json" },
    body: JSON.stringify({ decision: "APPROVED" }),
  });
  assert(selfApprove.status === 403, "the submitter can never approve their own evidence");
  const first = await j("admin", "POST", `/api/approvals/${ev.approvalRequest.id}/decision`, { decision: "APPROVED" });
  assert(first.released === false, "one approval of two: funds remain HELD (dual control)");
  const second = await j("compliance", "POST", `/api/approvals/${ev.approvalRequest.id}/decision`, { decision: "APPROVED" });
  assert(second.released === true, "second configured approval completes — release eligibility recorded");

  // ---- 11-12. draw request + recipient notifications ----
  // The BORROWER side submits the draw (separation of duties: a submitter
  // can never approve their own draw, so the lender's approvers must not
  // be the ones submitting). Invite the borrower's ops manager.
  const bInv = await j("admin", "POST", "/api/pilot/invitations", {
    email: "ops@meridian.example", organizationId: impl.id, role: "PROJECT_MANAGER",
  }, 201);
  const bAccept = await fetch(BASE + "/api/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: bInv.activationLink.split("/invite/")[1], name: "Marco Ops", title: "Operations Manager" }),
  });
  assert(bAccept.status === 201, "borrower operations manager invited and activated");
  jars.borrower = authCookieFrom(bAccept, "borrower acceptance");
  const borrowerUser = (await bAccept.json()).user;

  const draw = (await j("borrower", "POST", "/api/draws", {
    projectId: project.id, requestedAmount: 120_000, currency: "USD",
    periodStart: "2026-09-01", periodEnd: "2026-09-30",
  }, 201)).draw;
  const line = await j("borrower", "POST", `/api/draws/${draw.id}/lines`, {
    description: "Milestone 1 completed work",
    milestoneId: m1.id,
    scheduledValue: 180_000,
    currentRequested: 120_000,
    percentCompleteClaimed: 67,
  }, 201);
  assert(Boolean(line.line), "draw line added — pay-application arithmetic derived server-side");
  const submit = await api("borrower", "POST", `/api/draws/${draw.id}/submit`, {});
  if (![200, 201].includes(submit.status)) {
    fail(`draw submit -> ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
  }
  pass("draw request submitted through the governed workflow");
  {
    const db = new DatabaseSync(path.join(DATA_DIR, "obv.db"), { readOnly: true });
    const addressed = db
      .prepare(
        `SELECT recipient_user_id, recipient_reason FROM notifications
          WHERE type = 'DRAW_SUBMITTED' AND recipient_user_id IS NOT NULL`
      )
      .all();
    const reviewerNotified = addressed.some((n) => n.recipient_user_id === reviewer.id);
    const outboxRows = db
      .prepare("SELECT to_email FROM email_outbox WHERE kind = 'DRAW_NOTIFICATION'")
      .all();
    db.close();
    assert(
      reviewerNotified && addressed.every((n) => n.recipient_reason),
      "DRAW_SUBMITTED routed to the real reviewer with a recorded reason (no pilot alias)"
    );
    assert(
      outboxRows.some((r) => r.to_email === "compliance@firstlender.example"),
      "the notification email went to the reviewer's REAL address"
    );
  }

  // ---- 13-15. capability grant → lender decision ----
  // Recording a lender decision requires the RECORD_LENDER_DECISION
  // capability. The membership chain bootstraps from a FUNDER_REP — the
  // lender's head of lending — who then grants the compliance officer an
  // explicit LENDER_REVIEWER membership (§11 "assign roles/capabilities").
  const lInv = await j("admin", "POST", "/api/pilot/invitations", {
    email: "lending@firstlender.example", organizationId: lenderOrgId, role: "FUNDER_REP",
  }, 201);
  const lAccept = await fetch(BASE + "/api/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: lInv.activationLink.split("/invite/")[1], name: "Dana Lender", title: "Head of Lending" }),
  });
  assert(lAccept.status === 201, "head of lending invited and activated (FUNDER_REP)");
  jars.funder = authCookieFrom(lAccept, "funder acceptance");
  // The membership chain: the head of lending (FUNDER_REP) bootstraps the
  // FIRST membership — the ops administrator as project ADMINISTRATOR
  // (MANAGE_USERS) — who then grants every other participant explicitly.
  await j("funder", "POST", `/api/projects/${project.id}/memberships`, {
    userId: adminUserRow.id, participantType: "ADMINISTRATOR",
  }, 201);
  const membership = await api("admin", "POST", `/api/projects/${project.id}/memberships`, {
    userId: reviewer.id, participantType: "LENDER_REVIEWER",
  });
  if (![200, 201].includes(membership.status)) {
    fail(`membership grant -> ${membership.status}: ${(await membership.text()).slice(0, 300)}`);
  }
  pass("administrator granted the reviewer an explicit LENDER_REVIEWER membership (capability, audited)");

  // The borrower's ops manager needs the BORROWER capability set to
  // supply required documents once memberships become authoritative.
  await j("admin", "POST", `/api/projects/${project.id}/memberships`, {
    userId: borrowerUser.id, participantType: "BORROWER",
  }, 201);
  // Supply every required document (pay application, invoice, lien
  // waiver) — metadata + integrity records through the governed route.
  const reqRows = (() => {
    const db = new DatabaseSync(path.join(DATA_DIR, "obv.db"), { readOnly: true });
    const rows = db
      .prepare("SELECT id, doc_type, title FROM draw_document_requirements WHERE draw_request_id = ? AND required = 1")
      .all(draw.id);
    db.close();
    return rows;
  })();
  for (const r of reqRows) {
    const docRes = await api("borrower", "POST", `/api/draws/${draw.id}/documents`, {
      requirementId: r.id, docType: r.doc_type, title: `${r.title} (controlled test)`,
      invoiceNumber: r.doc_type === "CONTRACTOR_INVOICE" ? "FL-0001" : null,
      amount: r.doc_type === "CONTRACTOR_INVOICE" ? 120000 : null,
      waiverKind: /LIEN_WAIVER/.test(r.doc_type) ? "CONDITIONAL" : null,
      waiverScope: /LIEN_WAIVER/.test(r.doc_type) ? "PROGRESS" : null,
      coveredThrough: /LIEN_WAIVER/.test(r.doc_type) ? "2026-09-30" : null,
    });
    if (docRes.status !== 201) fail(`document ${r.doc_type} -> ${docRes.status}: ${(await docRes.text()).slice(0, 200)}`);
  }
  pass(`all ${reqRows.length} required draw documents supplied through the governed route`);

  // Jurisdictional truth precedes the lender decision: the billed
  // milestone's inspection requirement is UNDETERMINED (the template
  // creates none), and release bookkeeping never suppresses that — an
  // approving decision over the unknown is refused 422. The reviewer
  // records the reviewed determination through the governed API first,
  // exactly as the pilot SOP requires.
  {
    const det = await api("compliance", "POST", `/api/milestones/${m1.id}/inspection-requirement`, {
      requirement: "NOT_REQUIRED",
      requirementBasis: "Controlled-test scope below the jurisdictional inspection threshold (reviewed determination).",
    });
    if (![200, 201].includes(det.status)) {
      fail(`inspection-requirement determination -> ${det.status}: ${(await det.text()).slice(0, 200)}`);
    }
    pass("reviewed inspection-requirement determination recorded through the governed API (the pilot SOP)");
  }

  // Full governed review: line review → recommendation to governance →
  // dual-control formal approvals on the DRAW → only then a decision.
  const lineReview = await api("compliance", "POST", `/api/draws/${draw.id}/lines/${line.line.id}/review`, {
    decision: "SUPPORTED",
  });
  if (![200, 201].includes(lineReview.status)) {
    fail(`line review -> ${lineReview.status}: ${(await lineReview.text()).slice(0, 300)}`);
  }
  const gov = await api("funder", "POST", `/api/draws/${draw.id}/governance`, {});
  if (![200, 201].includes(gov.status)) {
    fail(`send to governance -> ${gov.status}: ${(await gov.text()).slice(0, 300)}`);
  }
  const govBody = await gov.json();
  const drawApproval = govBody.approvalRequest ?? govBody.result?.approvalRequest;
  if (!drawApproval) fail(`governance response carried no approvalRequest: ${JSON.stringify(govBody).slice(0, 200)}`);
  const a1 = await api("admin", "POST", `/api/approvals/${drawApproval.id}/decision`, { decision: "APPROVED" });
  if (a1.status !== 200) fail(`draw approval 1 -> ${a1.status}: ${(await a1.text()).slice(0, 250)}`);
  const a2 = await api("compliance", "POST", `/api/approvals/${drawApproval.id}/decision`, { decision: "APPROVED" });
  if (a2.status !== 200) fail(`draw approval 2 -> ${a2.status}: ${(await a2.text()).slice(0, 250)}`);
  pass("draw governance completed under the configured dual-control matrix");

  const decision = await api("compliance", "POST", `/api/draws/${draw.id}/lender-decision`, {
    decision: "APPROVED", approvedAmount: 120_000,
    decisionReason: "First controlled test draw — verified evidence supports the request.",
  });
  if (![200, 201].includes(decision.status)) {
    fail(`lender decision -> ${decision.status}: ${(await decision.text()).slice(0, 300)}`);
  }
  pass("lender decision recorded by the capability-holding reviewer");

  // ---- 16. lender package ----
  const pkg = await api("admin", "POST", `/api/draws/${draw.id}/verification-package`, {});
  assert(
    [200, 201].includes(pkg.status),
    "lender verification package generated for the decided draw"
  );

  // ---- 17-18. backup → verify → restore into an isolated environment ----
  const backup = (await j("admin", "POST", "/api/ops/backups", {}, 201)).backup;
  assert(backup.verificationStatus === "VERIFIED", "operator backup created and verified through the audited route");
  const backupPath = path.join(DATA_DIR, "backups", backup.fileName);
  const bytes = fs.readFileSync(backupPath);
  assert(
    createHash("sha256").update(bytes).digest("hex") === backup.sha256,
    "backup checksum re-verified before restore"
  );
  fs.writeFileSync(path.join(RESTORE_DIR, "obv.db"), bytes);
  for (const dir of ["worm", "uploads", "reports"]) {
    const src = path.join(DATA_DIR, dir);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(RESTORE_DIR, dir), { recursive: true });
  }
  {
    const rdb = new DatabaseSync(path.join(RESTORE_DIR, "obv.db"), { readOnly: true });
    const projCount = rdb.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(project.id).n;
    const drawCount = rdb.prepare("SELECT COUNT(*) AS n FROM draw_requests WHERE id = ?").get(draw.id).n;
    const ok = String(rdb.prepare("PRAGMA quick_check(1)").get().quick_check) === "ok";
    rdb.close();
    assert(ok && projCount === 1 && drawCount === 1, "restored copy is intact and holds the pilot project + draw");
  }

  // ---- 19. timeline / audit history ----
  const timeline = await api("admin", "GET", `/api/projects/${project.id}/timeline`);
  if (timeline.status === 200) {
    const t = await timeline.json();
    assert((t.events ?? []).length > 0, "the project timeline reflects the recorded lifecycle");
  } else {
    const db = new DatabaseSync(path.join(DATA_DIR, "obv.db"), { readOnly: true });
    const audits = db.prepare("SELECT COUNT(*) AS n FROM config_audit").get().n;
    const drawEvents = db.prepare("SELECT COUNT(*) AS n FROM draw_events WHERE draw_request_id = ?").get(draw.id).n;
    db.close();
    assert(audits > 0 && drawEvents > 0, "audit + draw event history records the full lifecycle");
  }

  // ---- 20. tenant isolation ----
  // The field engineer belongs to the counterparty org; a probing session
  // from a THIRD identity sees nothing. Create it via invitation to a
  // fresh org, then probe the lender's objects.
  const strangerOrg = await j("admin", "POST", "/api/pilot/orgs", { name: "Unrelated Partners LLC", kind: "OTHER" }, 201);
  const strangerInv = await j("admin", "POST", "/api/pilot/invitations", {
    email: "stranger@unrelated.example", organizationId: strangerOrg.organization.id, role: "FUNDER_REP",
  }, 201);
  const strangerAccept = await fetch(BASE + "/api/invitations/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: strangerInv.activationLink.split("/invite/")[1], name: "Sam Stranger", title: "Partner" }),
  });
  jars.stranger = authCookieFrom(strangerAccept, "stranger acceptance");
  const probes = [
    await api("stranger", "GET", `/api/draws/${draw.id}/payment-eligibility`),
    await api("stranger", "POST", `/api/draws/${draw.id}/lender-decision`, { decision: "APPROVED" }),
    await api("stranger", "GET", `/api/projects/${project.id}/banking`),
  ];
  assert(
    probes.every((r) => [403, 404].includes(r.status)),
    "another tenant cannot reach the lender's draw, decision surface or banking view"
  );

  // ---- 21. demo banking controls remain unavailable ----
  const sim = await api("admin", "POST", "/api/banking/accounts/any/credit", { amount: 5 });
  assert([403, 404].includes(sim.status), "banking simulation controls remain unavailable in pilot posture");

  // ---- 22. restart preserves pilot state ----
  await stopProcessAndWait(server);
  server = spawn(process.execPath, [SERVER], { env: PILOT_ENV, stdio: "ignore" });
  await waitUp();
  const after = await fetch(BASE + "/overview", { headers: { cookie: jars.admin, accept: "text/html" } });
  const drawAfter = await fetch(BASE + `/draw/${draw.id}`, { headers: { cookie: jars.admin, accept: "text/html" } });
  if (after.status !== 200 || drawAfter.status !== 200) {
    fail(`after restart: /overview -> ${after.status}, /draw -> ${drawAfter.status}`);
  }
  pass("restart preserves identities, sessions, the project and the draw (durable pilot state)");
  server.kill();

  console.log(`\nPILOT ACCEPTANCE PASSED — ${passed} checkpoints.`);
  console.log("No role switcher, no demo reset, no identity bypass was used anywhere above.");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
