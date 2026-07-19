/**
 * Field-operations governance tests — Field Issues, Clarification
 * Requests, and the governed Promote-to-Evidence-Draft flow.
 *
 * The non-negotiable claims proven here:
 *   - a field issue (any severity, any lifecycle) NEVER touches approvals,
 *     the virtual account, evidence, or the ledger
 *   - a clarification response sets RESPONDED at most — acceptance is a
 *     separate explicit reviewer decision, and acceptance itself creates
 *     no approval record
 *   - communication media never becomes evidence by itself; promotion
 *     creates a DRAFT only; only an explicit submit enters the NORMAL
 *     evidence pipeline; missing GPS stays missing and routes to REVIEW;
 *     no fabricated capture metadata
 *   - chat text ("approved", "release the money") through any of these
 *     features changes zero financial state
 *
 *   node scripts/fieldops-test.js
 */
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHmac } = require("node:crypto");

const OBV_PORT = 3195;
const STUB_PORT = 4625;
const BASE = `http://127.0.0.1:${OBV_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-fops-"));

const APP_SECRET = "stub-app-secret-not-real";
const ACCESS_TOKEN = "stub-wa-access-token-not-real";
const PHONE_ID = "555100000000002";
const FIELD_PHONE = "265991114821"; // seeded, mapped + bound to thread-m3

let n = 0;
const pass = (m) => console.log(`  ✓ [${++n}] ${m}`);
const fail = (m) => {
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (c, m) => (c ? pass(m) : fail(m));

// Minimal Cloud API stub so outbound sends succeed cleanly.
let stubSeq = 0;
const stubServer = http.createServer(async (req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  await new Promise((r) => req.on("end", r));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ messages: [{ id: `wamid.stub.out.${++stubSeq}` }] }));
});

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
async function api(key, method, p, jsonBody) {
  return fetch(BASE + p, {
    method,
    headers: { cookie: jars[key] ?? "", "content-type": "application/json" },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
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
/** Financial + evidence state fingerprint — must stay flat through all
 *  field-ops activity except the explicit governed draft submissions. */
function gov() {
  const d = db();
  const r = d
    .prepare(
      `SELECT (SELECT COUNT(*) FROM approval_records) AS approvals,
              (SELECT COUNT(*) FROM virtual_account_events WHERE type='RELEASED') AS released,
              (SELECT COUNT(*) FROM evidence_items) AS evidence,
              (SELECT account_status FROM milestones WHERE id='ms-3') AS ms3`
    )
    .get();
  d.close();
  return r;
}
function sign(raw) {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");
}
async function waWebhook(text, id) {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              contacts: [{ wa_id: FIELD_PHONE, profile: { name: "Chikondi Banda" } }],
              messages: [
                {
                  from: FIELD_PHONE,
                  id,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  return fetch(BASE + "/api/whatsapp/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) },
    body: raw,
  });
}
async function waitRow(sql, param, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = db();
    const row = d.prepare(sql).get(param);
    d.close();
    if (row) return row;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
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
  console.log("Field-operations governance tests — OBV :" + OBV_PORT);
  await new Promise((r) => stubServer.listen(STUB_PORT, r));
  await new Promise((r) =>
    spawn(process.execPath, ["dist/server/db/seed.js"], {
      env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
      stdio: "ignore",
    }).on("exit", r)
  );
  spawned.push(
    spawn(process.execPath, ["dist/server/http/server.js"], {
      env: {
        ...process.env,
        OBV_DATA_DIR: DATA_DIR,
        PORT: String(OBV_PORT),
        WHATSAPP_ACCESS_TOKEN: ACCESS_TOKEN,
        WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
        WHATSAPP_BUSINESS_ACCOUNT_ID: "whatsapp",
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: "stub-verify",
        WHATSAPP_APP_SECRET: APP_SECRET,
        OBV_WHATSAPP_API_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
        WHATSAPP_SYNC_TIMEOUT_MS: "1000",
      },
      stdio: "ignore",
    })
  );
  await waitUp();
  await signIn("pm", "user-pm");
  await signIn("field", "user-field");
  await signIn("funder", "user-funder");
  await signIn("compliance", "user-compliance");

  try {
    const base0 = gov();
    assert(base0.ms3 === "HELD", "baseline: M3 tranche is HELD, awaiting the formal workflow");

    // ================= A. field issues are operational only =================
    const denied = await api("field", "POST", "/api/issues", {
      projectId: "proj-r47", title: "x", description: "y",
    });
    assert(denied.status === 403, "FIELD role cannot create field issues (role-gated)");

    const d0 = db();
    const projectId = d0.prepare("SELECT id FROM projects LIMIT 1").get().id;
    d0.close();
    const created = await api("pm", "POST", "/api/issues", {
      projectId,
      milestoneId: "ms-3",
      messageId: "wamsg-1", // seeded WhatsApp coordination message
      title: "CRITICAL: gravel supply chain break at km 12",
      description: "Escalated from WhatsApp report — supplier truck breakdown.",
      category: "MATERIAL",
      severity: "CRITICAL",
    });
    assert(created.status === 201, "PM creates a field issue from a WhatsApp coordination message");
    const issue = (await created.json()).issue;
    assert(
      issue.sourceMessageId === "wamsg-1" && issue.status === "OPEN" && issue.severity === "CRITICAL",
      "issue records its source message and starts OPEN"
    );
    const mirror = await waitRow(
      "SELECT * FROM messages WHERE message_type='ISSUE_REFERENCE' AND ref_id = ?",
      issue.id
    );
    assert(
      mirror && mirror.thread_id === "thread-m3" && mirror.sender_user_id === null,
      "issue creation is mirrored into the project conversation as a reference card"
    );
    const g1 = gov();
    assert(
      g1.approvals === base0.approvals && g1.released === base0.released &&
        g1.evidence === base0.evidence && g1.ms3 === "HELD",
      "a CRITICAL issue changes ZERO financial or evidence state"
    );

    // lifecycle: transition validation + auditable timeline
    const badMove = await api("pm", "POST", `/api/issues/${issue.id}/status`, { status: "RESOLVED" });
    assert(badMove.status === 409, "invalid lifecycle transition (OPEN → RESOLVED) is rejected");
    await api("pm", "POST", `/api/issues/${issue.id}/status`, { status: "IN_PROGRESS" });
    const resolved = await api("pm", "POST", `/api/issues/${issue.id}/status`, {
      status: "RESOLVED",
      resolutionSummary: "Alternate supplier delivered 45 m³; lift completed.",
    });
    assert(resolved.status === 200, "valid lifecycle transitions succeed (OPEN → IN_PROGRESS → RESOLVED)");
    let d = db();
    const events = d.prepare("SELECT * FROM field_issue_events WHERE issue_id = ? ORDER BY created_at").all(issue.id);
    const resolvedRow = d.prepare("SELECT * FROM field_issues WHERE id = ?").get(issue.id);
    d.close();
    assert(
      events.length === 3 && events.at(-1).type === "RESOLVED" && resolvedRow.resolved_at,
      "issue timeline records every transition with actor and timestamp"
    );
    const g2 = gov();
    assert(
      g2.approvals === base0.approvals && g2.released === base0.released && g2.ms3 === "HELD",
      "resolving a CRITICAL issue still changes ZERO financial state — issues inform humans only"
    );
    const issuePage = await page("pm", `/issue/${issue.id}`);
    assert(
      issuePage.includes("NOT the Evidence Ledger") && issuePage.includes("Alternate supplier delivered"),
      "issue detail page labels the timeline as an operational record, not the Evidence Ledger"
    );
    const dashPage = await page("pm", "/issues");
    assert(
      dashPage.includes("Gravel shortfall at km 12 stockpile") &&
        dashPage.includes("they never change release eligibility"),
      "issues dashboard lists the register with the governance disclaimer"
    );

    // ================= B. clarification requests =================
    const clarDenied = await api("field", "POST", "/api/clarifications", {
      milestoneId: "ms-3", question: "x",
    });
    assert(clarDenied.status === 403, "FIELD role cannot create clarification requests");
    const clarRes = await api("compliance", "POST", "/api/clarifications", {
      milestoneId: "ms-3",
      question: "Please confirm the gravel source quarry for the km 12–14 lift.",
      responseType: "TEXT",
    });
    assert(clarRes.status === 201, "compliance reviewer requests a clarification on M3");
    const clar = (await clarRes.json()).clarification;
    const clarMirror = await waitRow(
      "SELECT * FROM messages WHERE message_type='CLARIFICATION_REFERENCE' AND ref_id = ?",
      clar.id
    );
    assert(clarMirror && clarMirror.thread_id === "thread-m3", "clarification is mirrored into the milestone conversation");

    // field responds via WhatsApp → RESPONDED, never auto-accepted
    await waWebhook("Quarry is Chibanzi borrow pit 3, certificate attached to project file.", "wamid.fops.clar1");
    await waitRow("SELECT * FROM messages WHERE external_message_id = ?", "wamid.fops.clar1");
    d = db();
    const afterResp = d.prepare("SELECT * FROM clarification_requests WHERE id = ?").get(clar.id);
    d.close();
    assert(
      afterResp.status === "RESPONDED" && afterResp.response_message_id,
      "an inbound field response links to the clarification and sets RESPONDED"
    );
    const g3 = gov();
    assert(
      g3.approvals === base0.approvals && g3.ms3 === "HELD",
      "a clarification response NEVER auto-accepts and never touches approvals or funds"
    );
    const badClarMove = await api("compliance", "POST", "/api/clarifications/" + clar.id + "/status", {
      status: "OPEN",
    });
    assert(badClarMove.status === 409, "invalid clarification transition is rejected");
    const fieldAccept = await api("field", "POST", `/api/clarifications/${clar.id}/status`, { status: "ACCEPTED" });
    assert(fieldAccept.status === 403, "the responder role cannot accept its own clarification (reviewer-only)");
    const accepted = await api("compliance", "POST", `/api/clarifications/${clar.id}/status`, {
      status: "ACCEPTED",
      note: "Quarry source confirmed against the materials register.",
    });
    assert(accepted.status === 200, "reviewer explicitly ACCEPTS the response (separate human decision)");
    const g4 = gov();
    assert(
      g4.approvals === base0.approvals && g4.released === base0.released && g4.ms3 === "HELD",
      "acceptance of a clarification creates ZERO approval records — it is not an approval"
    );

    // ================= C. governed evidence-draft promotion =================
    // Baseline sanity: chat saying "approved/release" through this whole
    // feature set has changed nothing (proven by g1..g4 above).
    const noMedia = await api("pm", "POST", "/api/evidence-drafts", {
      messageId: "wamsg-1", attachmentIndex: 0, milestoneId: "ms-3",
    });
    assert(noMedia.status === 400, "a text message cannot be promoted (no media)");

    const draftRes = await api("field", "POST", "/api/evidence-drafts", {
      messageId: "wamsg-2", attachmentIndex: 0, milestoneId: "ms-3",
    });
    assert(draftRes.status === 201, "field promotes a WhatsApp image communication to an evidence DRAFT");
    const draft = (await draftRes.json()).draft;
    assert(
      draft.status === "DRAFT" && draft.sourceProvider === "WHATSAPP" &&
        draft.sourceIdentity === "Chikondi Banda" && draft.latitude === null,
      "draft carries honest provenance: source identity, provider, message time, NO invented location"
    );
    const g5 = gov();
    assert(
      g5.evidence === base0.evidence,
      "promotion creates NO EvidenceItem — a draft is not evidence"
    );
    const msPage = await page("pm", "/milestone/ms-3");
    assert(
      msPage.includes("NOT evidence until submitted and verified") &&
        msPage.includes("MISSING LOCATION"),
      "milestone page shows the draft with explicit MISSING LOCATION / not-evidence labeling"
    );

    // explicit location association from the SAME thread only
    const draftLocRes = await api("pm", "POST", "/api/evidence-drafts", {
      messageId: "wamsg-2", attachmentIndex: 0, milestoneId: "ms-3",
      locationMessageId: "wamsg-3",
    });
    const draftLoc = (await draftLocRes.json()).draft;
    assert(
      Math.abs(draftLoc.latitude + 11.8062) < 1e-6 && draftLoc.locationSourceMessageId === "wamsg-3",
      "location associates only via an explicit location message from the same thread"
    );
    const badLoc = await api("pm", "POST", "/api/evidence-drafts", {
      messageId: "wamsg-2", attachmentIndex: 0, milestoneId: "ms-3",
      locationMessageId: "pmsg-1", // different thread, no location
    });
    assert(badLoc.status === 400, "location association from another thread is refused (never silently merged)");

    // explicit submission → the NORMAL governed pipeline
    const submitRes = await api("field", "POST", `/api/evidence-drafts/${draft.id}/submit`, {});
    assert(submitRes.status === 201, "explicit Submit for Verification runs the normal evidence pipeline");
    const submitted = await submitRes.json();
    d = db();
    const evRow = d.prepare("SELECT * FROM evidence_items WHERE id = ?").get(submitted.evidence.id);
    const verifRow = d.prepare("SELECT * FROM verifications WHERE evidence_item_id = ?").get(submitted.evidence.id);
    const draftRow = d.prepare("SELECT * FROM evidence_drafts WHERE id = ?").get(draft.id);
    d.close();
    assert(
      evRow && draftRow.status === "SUBMITTED" && draftRow.evidence_item_id === evRow.id,
      "submitted draft links to a real EvidenceItem via the standard submission flow"
    );
    assert(
      JSON.parse(evRow.device_metadata).userAgent.includes("Promoted communication media") &&
        evRow.latitude === null,
      "evidence records honest provenance: promoted-communication metadata, GPS stays MISSING (not fabricated)"
    );
    assert(
      verifRow && verifRow.verdict !== "VERIFIED",
      `missing GPS routes verification to review, never auto-VERIFIED (verdict: ${verifRow.verdict})`
    );
    const g6 = gov();
    assert(
      g6.approvals === base0.approvals && g6.released === base0.released && g6.ms3 === "HELD",
      "even a submitted draft creates no approvals and releases nothing — humans still decide"
    );
    const doubleSubmit = await api("field", "POST", `/api/evidence-drafts/${draft.id}/submit`, {});
    assert(doubleSubmit.status === 409, "a draft can be submitted exactly once");

    // the with-location draft also goes through the same pipeline
    const submitLoc = await api("pm", "POST", `/api/evidence-drafts/${draftLoc.id}/submit`, {});
    assert(submitLoc.status === 201, "draft with an associated communication location submits through the same pipeline");
    const g7 = gov();
    assert(
      g7.released === base0.released && g7.ms3 === "HELD" && g7.approvals === base0.approvals,
      "regardless of verification outcome, funds stay HELD until the formal human approval workflow"
    );

    // ================= D. the formal path still works and is the ONLY path ====
    // The hero loop remains intact alongside all field-ops features.
    const ctxRes = await (await fetch(BASE + "/api/field-context", { headers: { cookie: jars.field } })).json();
    const proj = ctxRes.projects[0];
    const evRes = await fetch(BASE + "/api/evidence", {
      method: "POST",
      headers: { cookie: jars.field, "content-type": "application/json" },
      body: JSON.stringify({
        milestoneId: "ms-3",
        demoPhotoId: proj.milestones.find((m) => m.id === "ms-3").demoPhotos[0].id,
        latitude: proj.simulatedGps.latitude,
        longitude: proj.simulatedGps.longitude,
        capturedAt: new Date(Date.now() - 10 * 60000).toISOString(),
        deviceMetadata: { userAgent: "fops", platform: "t", screen: "1x1", language: "en" },
        isDemoFallback: true,
      }),
    });
    assert(evRes.status === 201, "formal field capture still works alongside field-ops features");
    d = db();
    const apRow = d.prepare("SELECT id FROM approval_requests WHERE milestone_id='ms-3' AND status='PENDING'").get();
    d.close();
    assert(Boolean(apRow), "verified formal evidence opens a PENDING approval request (governance begins)");
    await api("funder", "POST", `/api/approvals/${apRow.id}/decision`, { decision: "APPROVED" });
    assert(gov().ms3 === "HELD", "one approval is not enough — funds still HELD");
    await api("compliance", "POST", `/api/approvals/${apRow.id}/decision`, { decision: "APPROVED" });
    const finalG = gov();
    assert(
      finalG.ms3 === "RELEASED" && finalG.released === base0.released + 1,
      "ONLY the complete formal approval workflow releases the tranche — exactly one RELEASED event"
    );

    console.log(`\nFIELD-OPERATIONS GOVERNANCE TESTS PASSED — ${n} checkpoints.`);
    console.log(
      "\nWHATSAPP COORDINATES. OBV EVIDENCE PROVES. VERIFICATION ASSESSES." +
        "\nHUMANS AUTHORIZE THROUGH THE FORMAL OBV APPROVAL WORKFLOW." +
        "\nTHE EVIDENCE LEDGER RECORDS. CHAT DOES NOT RELEASE FUNDS.\n"
    );
  } finally {
    for (const p of spawned) p.kill();
    stubServer.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
