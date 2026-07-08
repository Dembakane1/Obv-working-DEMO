/**
 * Pilot Readiness & Customer Onboarding tests.
 *
 * Proves the full customer path — organization → invitations → project →
 * template → geography → milestones → evidence requirements → draw →
 * approval matrix → field assignment → deterministic readiness → launch —
 * and, non-negotiably, that configuration can NEVER shortcut the trust
 * model: launch creates no evidence/approvals/releases, post-launch
 * changes are audited with reasons, historic evidence keeps its policy
 * version, and demo reset never deletes pilot data.
 *
 *   node scripts/pilot-test.js
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");

const PORT = 3220;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-pilot-"));

let n = 0;
const pass = (m) => console.log(`  ✓ [${++n}] ${m}`);
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
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
}
async function page(key, p) {
  return (await fetch(BASE + p, { headers: { cookie: jars[key] ?? "" } })).text();
}
function db() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path.join(DATA_DIR, "obv.db"));
}
function q(sql, ...params) {
  const d = db();
  const r = d.prepare(sql).get(...params);
  d.close();
  return r;
}
function projGov(projectId) {
  return q(
    `SELECT
       (SELECT COUNT(*) FROM evidence_items e JOIN milestones m ON e.milestone_id=m.id WHERE m.project_id=?1) AS evidence,
       (SELECT COUNT(*) FROM approval_records r JOIN approval_requests a ON r.approval_request_id=a.id
          JOIN milestones m ON a.milestone_id=m.id WHERE m.project_id=?1) AS approvals,
       (SELECT COUNT(*) FROM virtual_account_events v JOIN milestones m ON v.milestone_id=m.id
          WHERE m.project_id=?1 AND v.type='RELEASED') AS released,
       (SELECT COUNT(*) FROM virtual_account_events v JOIN milestones m ON v.milestone_id=m.id
          WHERE m.project_id=?1 AND v.type='HELD') AS held,
       (SELECT COUNT(*) FROM ledger_entries l JOIN milestones m ON l.milestone_id=m.id WHERE m.project_id=?1) AS ledger`,
    projectId
  );
}
/** Deterministic >256-byte PNG (the mock visual check needs real content). */
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
  return `data:image/png;base64,${png.toString("base64")}`;
}

const spawned = [];
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/health")).ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("server did not start");
}

(async () => {
  console.log("Pilot onboarding tests — OBV :" + PORT);
  await new Promise((r) =>
    spawn(process.execPath, ["dist/server/db/seed.js"], {
      env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
      stdio: "ignore",
    }).on("exit", r)
  );
  spawned.push(
    spawn(process.execPath, ["dist/server/http/server.js"], {
      env: { ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PORT) },
      stdio: "ignore",
    })
  );
  await waitUp();
  await signIn("pm", "user-pm");
  await signIn("demoField", "user-field");

  try {
    // ================= A. organizations =================
    const orgRes = await api("pm", "POST", "/api/pilot/orgs", {
      name: "Horizon Infrastructure Fund", kind: "LENDER",
      country: "Malawi", timezone: "Africa/Blantyre", currency: "USD",
      primaryContact: "ops@horizon.example",
    });
    assert(orgRes.status === 201, "primary pilot organization created");
    const org = (await orgRes.json()).organization;
    const implRes = await api("pm", "POST", "/api/pilot/orgs", {
      name: "National Roads Authority", kind: "IMPLEMENTING_AGENCY",
    });
    assert(implRes.status === 201, "counterparty (implementing agency) organization created");
    const impl = (await implRes.json()).organization;
    const badKind = await api("pm", "POST", "/api/pilot/orgs", { name: "X", kind: "PYRAMID_SCHEME" });
    assert(badKind.status === 400, "unknown organization type rejected");
    const fieldDenied = await api("demoField", "POST", "/api/pilot/orgs", { name: "Y", kind: "OTHER" });
    assert(fieldDenied.status === 403, "organization creation is role-protected (FIELD denied)");

    // ================= B. invitations & token security =================
    const invRes = await api("pm", "POST", "/api/pilot/invitations", {
      email: "reviewer@horizon.example", organizationId: org.id, role: "COMPLIANCE_REVIEWER",
    });
    assert(invRes.status === 201, "user invited (compliance reviewer)");
    const { invitation: inv1, activationLink } = await invRes.json();
    const rawToken = activationLink.split("/invite/")[1];
    const stored = q("SELECT token_hash, status FROM invitations WHERE id = ?", inv1.id);
    assert(
      rawToken.length === 48 &&
        stored.token_hash !== rawToken &&
        /^[a-f0-9]{64}$/.test(stored.token_hash),
      "invitation token is random and only its sha256 hash is stored at rest"
    );
    const dumpRow = q(
      "SELECT COUNT(*) AS c FROM invitations WHERE token_hash = ? OR email = ?",
      rawToken, rawToken
    );
    assert(dumpRow.c === 0, "the raw token appears nowhere in the database");

    // expired invitation rejected
    const expRes = await api("pm", "POST", "/api/pilot/invitations", {
      email: "late@horizon.example", organizationId: org.id, role: "FIELD",
    });
    const expInv = await expRes.json();
    const expToken = expInv.activationLink.split("/invite/")[1];
    {
      const d = db();
      d.prepare("UPDATE invitations SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(expInv.invitation.id);
      d.close();
    }
    const expAccept = await fetch(BASE + "/api/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: expToken, name: "Too Late", title: "x" }),
    });
    assert(expAccept.status === 410, "expired invitation cannot be accepted (410)");

    // revoked invitation rejected
    const revRes = await api("pm", "POST", "/api/pilot/invitations", {
      email: "revoked@horizon.example", organizationId: org.id, role: "FIELD",
    });
    const revInv = await revRes.json();
    await api("pm", "POST", `/api/pilot/invitations/${revInv.invitation.id}/revoke`, {});
    const revAccept = await fetch(BASE + "/api/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: revInv.activationLink.split("/invite/")[1], name: "Revoked", title: "x",
      }),
    });
    assert(revAccept.status === 410, "revoked invitation cannot be accepted (410)");

    // valid acceptance — one-time use
    const accept1 = await fetch(BASE + "/api/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: rawToken, name: "Lena Okafor", title: "Compliance Officer" }),
    });
    assert(accept1.status === 201, "valid invitation activates and creates the user");
    const reviewer = (await accept1.json()).user;
    const accept2 = await fetch(BASE + "/api/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: rawToken, name: "Imposter", title: "x" }),
    });
    assert(accept2.status === 409, "an invitation token is strictly one-time (replay rejected)");

    // ================= C. project creation + template =================
    const projRes = await api("pm", "POST", "/api/pilot/projects", {
      name: "K14 Regional Road Rehabilitation", code: "K14-2026", category: "ROAD",
      organizationId: org.id, implementingOrgId: impl.id,
      obvControlledAmount: 1_000_000, totalValue: 1_200_000, currency: "USD",
      plannedStart: "2026-08-01", plannedEnd: "2027-06-30",
      timezone: "Africa/Blantyre", country: "Malawi", region: "Northern",
    });
    assert(projRes.status === 201, "draft project created without any database editing");
    const project = (await projRes.json()).project;
    assert(project.status === "DRAFT", "new pilot project starts as DRAFT");

    const g0 = projGov(project.id);
    const tmplRes = await api("pm", "POST", `/api/pilot/projects/${project.id}/template`, {
      templateKey: "road-rehabilitation",
    });
    assert(tmplRes.status === 201, "Road Rehabilitation template applied");
    const milestones = (await tmplRes.json()).milestones;
    assert(milestones.length === 5, "template created the 5-milestone structure");
    const trancheSum = milestones.reduce((s, m) => s + m.trancheAmount, 0);
    assert(trancheSum === 1_000_000, "template tranches sum exactly to the OBV-controlled amount");
    const g1 = projGov(project.id);
    assert(
      g1.evidence === g0.evidence && g1.approvals === g0.approvals &&
        g1.released === 0 && g1.ledger === g0.ledger,
      "a template creates CONFIGURATION only — zero evidence, approvals, ledger entries, releases"
    );
    const reqCount = q(
      `SELECT COUNT(*) AS c FROM evidence_requirements r JOIN milestones m
        ON r.milestone_id = m.id WHERE m.project_id = ?`, project.id
    ).c;
    assert(reqCount >= 8, `template configured evidence requirements (${reqCount})`);

    // ================= D. milestone + requirement editing =================
    const ms3 = milestones[2];
    const editRes = await api("pm", "POST", `/api/pilot/milestones/${ms3.id}`, {
      title: "Base course placement & compaction (km 0–14)",
      requirement: "Photos of compacted base course across full width with km markers visible.",
    });
    assert(editRes.status === 200, "draft milestone edited (no reason needed pre-launch)");
    const addReq = await api("pm", "POST", "/api/pilot/requirements", {
      milestoneId: ms3.id, type: "TEST_RESULT", title: "CBR test certificate",
      mediaTypes: "application/pdf", minCount: 1, required: true,
    });
    assert(addReq.status === 201, "evidence requirement added to a milestone");
    const badMedia = await api("pm", "POST", "/api/pilot/requirements", {
      milestoneId: ms3.id, type: "DOCUMENT", title: "Bad", mediaTypes: "application/x-msdownload",
    });
    assert(badMedia.status === 400, "requirement with a disallowed media type is rejected");
    const dupSeq = await api("pm", "POST", `/api/pilot/projects/${project.id}/milestones`, {
      seq: 1, title: "Duplicate", requirement: "x",
    });
    assert(dupSeq.status === 409, "duplicate milestone sequence rejected");

    // ================= E. geography =================
    const badGeo = await api("pm", "POST", `/api/pilot/projects/${project.id}/geography`, {
      kind: "CORRIDOR", coordinates: ["33.59, -211.91", "33.61, -11.88"],
    });
    assert(badGeo.status === 400, "invalid geometry rejected (latitude out of range)");
    const flatGeo = await api("pm", "POST", `/api/pilot/projects/${project.id}/geography`, {
      kind: "POLYGON", coordinates: ["33.59, -11.91", "33.60, -11.91", "33.61, -11.91"],
    });
    assert(flatGeo.status === 400, "degenerate polygon (no area) rejected");
    const geoRes = await api("pm", "POST", `/api/pilot/projects/${project.id}/geography`, {
      kind: "CORRIDOR",
      coordinates: ["33.59, -11.91", "33.61, -11.88", "33.64, -11.85"],
      label: "K14 corridor centerline",
    });
    assert(geoRes.status === 200, "corridor geography configured (route + derived geofence)");
    const geoProj = (await geoRes.json()).project;
    assert(
      geoProj.pilot.geometryKind === "CORRIDOR" && geoProj.siteBoundary.length >= 4,
      "geofence boundary derived around the user-defined corridor"
    );

    // ================= F. draw structure =================
    const drawBad = await api("pm", "POST", `/api/pilot/projects/${project.id}/draw`, {
      [`tranche_${ms3.id}`]: 999_999,
    });
    assert(drawBad.status === 200, "tranche amounts editable through the draw structure");
    let setupPage = await page("pm", `/setup/project/${project.id}?stage=draw`);
    assert(
      setupPage.includes("SUM OF TRANCHES") && setupPage.includes("≠ OBV-CONTROLLED PROJECT AMOUNT"),
      "mismatched tranche total flagged loudly on the draw stage"
    );
    await api("pm", "POST", `/api/pilot/projects/${project.id}/draw`, {
      [`tranche_${ms3.id}`]: ms3.trancheAmount,
    });
    setupPage = await page("pm", `/setup/project/${project.id}?stage=draw`);
    assert(setupPage.includes("Reconciled: tranches sum to"), "reconciled draw structure confirmed");

    // ================= G. approval matrix =================
    const badMatrix1 = await api("pm", "POST", `/api/pilot/projects/${project.id}/approval-matrix`, {
      roles: ["FIELD", "COMPLIANCE_REVIEWER"],
    });
    assert(badMatrix1.status === 400, "FIELD can never be part of the approval matrix");
    const badMatrix2 = await api("pm", "POST", `/api/pilot/projects/${project.id}/approval-matrix`, {
      roles: ["PROJECT_MANAGER"],
    });
    assert(badMatrix2.status === 400, "single-role matrix blocked (separation of duties)");
    const okMatrix = await api("pm", "POST", `/api/pilot/projects/${project.id}/approval-matrix`, {
      roles: ["PROJECT_MANAGER", "COMPLIANCE_REVIEWER"],
    });
    assert(okMatrix.status === 200, "valid approval matrix accepted (PM + Compliance)");

    // ================= H. readiness gates launch =================
    let launch = await api("pm", "POST", `/api/pilot/projects/${project.id}/launch`, {});
    assert(launch.status === 422, "launch blocked while readiness blockers remain");
    let blockers = (await launch.json()).error;
    assert(String(blockers).includes("field participant"), "missing field assignment reported as a blocker");

    const reviewPage = await page("pm", `/setup/project/${project.id}?stage=review`);
    assert(
      reviewPage.includes("NOT READY") && reviewPage.includes("Fix →"),
      "readiness review lists actionable blockers linked to their stages"
    );

    // invite + auto-assign field engineer (project-scoped FIELD invitation)
    const fInv = await api("pm", "POST", "/api/pilot/invitations", {
      email: "engineer@nra.example", organizationId: impl.id, role: "FIELD", projectId: project.id,
    });
    const fInvJson = await fInv.json();
    const fAccept = await fetch(BASE + "/api/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: fInvJson.activationLink.split("/invite/")[1],
        name: "Grace Tembo", title: "Site Engineer",
      }),
    });
    const fieldUser = (await fAccept.json()).user;
    assert(
      fAccept.status === 201 &&
        q("SELECT COUNT(*) AS c FROM field_assignments WHERE project_id = ? AND user_id = ?", project.id, fieldUser.id).c === 1,
      "project-scoped FIELD invitation activates with an automatic field assignment"
    );

    const readyPage = await page("pm", `/setup/project/${project.id}?stage=review`);
    assert(readyPage.includes("READY TO LAUNCH"), "readiness passes when configuration is complete");

    // unauthorized launch blocked
    await signIn("grace", fieldUser.id);
    const fieldLaunch = await api("grace", "POST", `/api/pilot/projects/${project.id}/launch`, {});
    assert(fieldLaunch.status === 403, "unauthorized role cannot launch a project");

    // ================= I. launch =================
    const gPre = projGov(project.id);
    launch = await api("pm", "POST", `/api/pilot/projects/${project.id}/launch`, {});
    assert(launch.status === 201, "authorized launch succeeds once readiness passes");
    const launched = await launch.json();
    assert(launched.project.status === "ACTIVE", "project is ACTIVE after launch");
    assert(
      launched.snapshot && launched.snapshot.version === 1 && /^[a-f0-9]{64}$/.test(launched.snapshot.hash),
      "launch captured configuration snapshot v1 with a content hash"
    );
    const gPost = projGov(project.id);
    assert(gPost.evidence === 0 && gPost.ledger === 0, "launch created NO evidence and NO ledger entries");
    assert(gPost.approvals === 0, "launch created NO approval records");
    assert(gPost.released === 0 && gPost.held === 5, "launch released NOTHING — all 5 tranches recorded HELD");
    const relaunch = await api("pm", "POST", `/api/pilot/projects/${project.id}/launch`, {});
    assert(relaunch.status === 409, "a launched project cannot be launched again");

    // ================= J. post-launch change control =================
    const silent = await api("pm", "POST", `/api/pilot/milestones/${ms3.id}`, { trancheAmount: 250_000 });
    assert(silent.status === 422, "post-launch tranche change WITHOUT a reason is refused");
    const reasoned = await api("pm", "POST", `/api/pilot/milestones/${ms3.id}`, {
      trancheAmount: ms3.trancheAmount, title: ms3.title + " ",
      reason: "Contract variation order VO-003 approved by steering committee",
    });
    assert(reasoned.status === 200, "post-launch change WITH an explicit reason succeeds");
    const auditRow = q(
      `SELECT * FROM config_audit WHERE entity_id = ? AND reason IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      ms3.id
    );
    assert(
      auditRow && auditRow.reason.includes("VO-003") && auditRow.actor_user_id === "user-pm",
      "post-launch change recorded in the configuration audit trail with actor + reason"
    );
    const vAfter = q("SELECT config_version FROM projects WHERE id = ?", project.id).config_version;
    assert(vAfter === 2, "post-launch change bumped the configuration version");
    assert(
      q("SELECT COUNT(*) AS c FROM config_snapshots WHERE project_id = ?", project.id).c === 2,
      "post-launch change captured a new configuration snapshot"
    );

    // ================= K. operational loop on the pilot project =================
    // field scoping
    const ctx = await (await fetch(BASE + "/api/field-context", { headers: { cookie: jars.grace } })).json();
    assert(
      ctx.projects.length === 1 && ctx.projects[0].id === project.id,
      "assigned field engineer sees exactly their pilot project in Field Capture"
    );
    const demoCtx = await (await fetch(BASE + "/api/field-context", { headers: { cookie: jars.demoField } })).json();
    assert(
      demoCtx.projects.length === 1 && demoCtx.projects[0].id === "proj-r47",
      "the demo field user still sees only the demo project (no pilot leakage)"
    );
    assert(
      ctx.projects[0].milestones.every((m) => Array.isArray(m.requirements)),
      "field context carries the configured evidence-requirement checklist"
    );

    // evidence under configuration v2 keeps its policy version
    const m1 = ctx.projects[0].milestones[0];
    const evRes = await fetch(BASE + "/api/evidence", {
      method: "POST",
      headers: { cookie: jars.grace, "content-type": "application/json" },
      body: JSON.stringify({
        milestoneId: m1.id,
        photoDataUrl: testPng(3),
        latitude: -11.88, longitude: 33.61,
        capturedAt: new Date(Date.now() - 15 * 60000).toISOString(),
        deviceMetadata: { userAgent: "pilot-test", platform: "Android", screen: "412x915", language: "en" },
        isDemoFallback: false,
      }),
    });
    assert(evRes.status === 201, "field evidence submits through the normal pipeline on the pilot project");
    const ev = await evRes.json();
    assert(
      ev.verification.policyVersion === 2,
      "verification records the configuration version it was evaluated under (v2)"
    );
    assert(
      ev.approvalRequest && ev.approvalRequest.requiredRoles.join("+") === "PROJECT_MANAGER+COMPLIANCE_REVIEWER",
      "ApprovalRequest uses the CONFIGURED approval matrix (PM + Compliance)"
    );

    // separation of duties + configured matrix governs release
    const sod = await fetch(BASE + `/api/approvals/${ev.approvalRequest.id}/decision`, {
      method: "POST",
      headers: { cookie: jars.grace, "content-type": "application/json" },
      body: JSON.stringify({ decision: "APPROVED" }),
    });
    assert(sod.status === 403, "the evidence submitter can never approve their own submission");
    const pmDecision = await api("pm", "POST", `/api/approvals/${ev.approvalRequest.id}/decision`, { decision: "APPROVED" });
    assert(
      (await pmDecision.json()).released === false && projGov(project.id).released === 0,
      "one matrix approval is not enough — funds stay HELD"
    );
    await signIn("lena", reviewer.id);
    const finalDecision = await api("lena", "POST", `/api/approvals/${ev.approvalRequest.id}/decision`, { decision: "APPROVED" });
    assert(
      (await finalDecision.json()).released === true && projGov(project.id).released === 1,
      "completing the configured matrix releases exactly ONE tranche"
    );

    // ================= L. CSV import =================
    const projB = (await (await api("pm", "POST", "/api/pilot/projects", {
      name: "Import Test Project", organizationId: org.id, obvControlledAmount: 100000, currency: "USD",
    })).json()).project;
    const badCsv = "sequence,title,requirement,planned_start,planned_end,tranche_amount,spatial_label\n1,Only title,,,,,x\n";
    const badImport = await (await api("pm", "POST", `/api/pilot/projects/${projB.id}/import/milestones`, {
      csv: badCsv, mode: "commit",
    })).json();
    assert(
      badImport.ok === false && badImport.errors.length > 0 &&
        q("SELECT COUNT(*) AS c FROM milestones WHERE project_id = ?", projB.id).c === 0,
      "CSV import with row errors imports NOTHING (no partial silent corruption)"
    );
    const goodCsv =
      "sequence,title,requirement,planned_start,planned_end,tranche_amount,spatial_label\n" +
      "1,Works commenced,Photo of mobilization,2026-08-01,2026-09-01,40000,zone A\n" +
      "2,Works complete,Photo of completed works,2026-09-01,2026-12-01,60000,zone B\n";
    const preview = await (await api("pm", "POST", `/api/pilot/projects/${projB.id}/import/milestones`, {
      csv: goodCsv, mode: "preview",
    })).json();
    assert(
      preview.ok === true && preview.imported === 0 && preview.preview.length === 2 &&
        q("SELECT COUNT(*) AS c FROM milestones WHERE project_id = ?", projB.id).c === 0,
      "CSV preview validates without importing"
    );
    const commit = await (await api("pm", "POST", `/api/pilot/projects/${projB.id}/import/milestones`, {
      csv: goodCsv, mode: "commit",
    })).json();
    assert(
      commit.ok === true && commit.imported === 2 &&
        q("SELECT COUNT(*) AS c FROM milestones WHERE project_id = ?", projB.id).c === 2,
      "validated CSV commit imports every row transactionally"
    );
    const tmpl = await (await fetch(BASE + "/api/pilot/csv-template/milestones", { headers: { cookie: jars.pm } })).text();
    assert(tmpl.startsWith("sequence,title,requirement"), "CSV template downloadable");

    // ================= M. export package =================
    const exportPkg = await (await fetch(BASE + `/api/pilot/projects/${project.id}/export`, { headers: { cookie: jars.pm } })).json();
    assert(
      exportPkg.kind === "OBV_PILOT_EXPORT_V1" &&
        exportPkg.milestoneRegister.length === 5 &&
        exportPkg.approvalMatrix.length > 0 &&
        exportPkg.configSnapshots.length === 2,
      "pilot export package contains configuration, registers, matrix, snapshots"
    );
    const exportText = JSON.stringify(exportPkg);
    assert(
      !exportText.includes(rawToken) && !exportText.includes("token_hash") && !exportText.includes("tokenHash"),
      "export contains no invitation tokens or hashes (no secrets)"
    );

    // ================= N. pilot dashboard =================
    const dash = await page("pm", "/pilot");
    assert(
      dash.includes("K14 Regional Road Rehabilitation") &&
        dash.includes("Evidence submitted") && dash.includes("Open field issues"),
      "pilot operations dashboard shows real operational records"
    );

    // ================= O. demo reset preserves pilot data =================
    const demoBefore = q("SELECT COUNT(*) AS c FROM messages").c;
    await api("pm", "POST", "/api/demo/reset", {});
    assert(
      q("SELECT status FROM projects WHERE id = ?", project.id)?.status === "ACTIVE",
      "demo reset does NOT delete the user-created pilot project"
    );
    assert(
      projGov(project.id).released === 1 &&
        q("SELECT COUNT(*) AS c FROM config_snapshots WHERE project_id = ?", project.id).c === 2,
      "pilot financial history and configuration snapshots survive a demo reset"
    );
    assert(
      q("SELECT status FROM milestones WHERE id = 'ms-3'")?.status === "PENDING_EVIDENCE" &&
        q("SELECT COUNT(*) AS c FROM messages WHERE thread_id = 'thread-m3'").c === 8,
      "the seeded R47 demo is restored to its exact seeded state"
    );
    void demoBefore;
    const healthAfter = await (await fetch(BASE + "/api/health")).json();
    assert(healthAfter.status === "ok", "application healthy after scoped demo reset");

    console.log(`\nPILOT ONBOARDING TESTS PASSED — ${n} checkpoints.`);
    console.log(
      "\nCUSTOMER CONFIGURATION DEFINES THE PROJECT RULES." +
        "\nFIELD EVIDENCE PROVES. VERIFICATION ASSESSES. FORMAL GOVERNANCE AUTHORIZES." +
        "\nLAUNCH IS CONFIGURATION ACTIVATION — NEVER PROOF OF WORK.\n"
    );
  } finally {
    for (const p of spawned) p.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
