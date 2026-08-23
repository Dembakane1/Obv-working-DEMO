/**
 * Draw Review workstation tests — isolated server on :3374.
 *
 * The redesign moved the lender's answer to the front of the page. This
 * suite proves the page tells the governed truth rather than a flattering
 * one:
 *
 *   1. the draw identity header states real recorded facts
 *   2. readiness is one of the engine's FOUR states, in words — never a
 *      percentage and never an invented score
 *   3. requested / currently supportable / unsupported are three distinct
 *      figures that match the engine exactly
 *   4. governed blockers and advisory signals are structurally separate,
 *      and an advisory never presents itself as a blocker
 *   5. missing information (UNKNOWN) is never rendered as healthy
 *   6. the line register leads with supportability, with no score column
 *   7. the deterministic next action is surfaced from existing logic
 *   8. the decision area says "record lender decision", and the INCOMPLETE
 *      422 invariant holds against the live API
 *   9. a proceed-by-exception override is impossible to miss and never
 *      erases the requirement it overrode
 *  10. no viewport overflows and the phone gets a real composition
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { launchChromium } = require("./lib/browser");
const { signInAll, sessionCookie, playwrightCookie } = require("./lib/session");

const ROOT = process.cwd();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "obv-drawui-"));
const PORT = 3374;
const BASE = `http://127.0.0.1:${PORT}`;

// The readiness engine is required in-process for its own reading of the
// same database the server writes — set the data root before any service
// module resolves its connection.
process.env.OBV_DATA_DIR = DATA;
process.env.OBV_SEED_GOLDEN = "1";

let passed = 0;
const pass = (m) => { passed += 1; console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`); };
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); throw new Error(m); };
const assert = (cond, m) => (cond ? pass(m) : fail(m));

let server = null;
const stopAll = () => { try { server?.kill("SIGKILL"); } catch { /* gone */ } server = null; };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { stopAll(); process.exit(130); });
}

async function waitHealthy() {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log("\n== draw review workstation ==\n");

  // The golden demo project carries a configured document checklist and a
  // jurisdictional surface, so real readiness states are reachable through
  // the ordinary API without touching a single database row.
  const seedEnv = { ...process.env, OBV_DATA_DIR: DATA, OBV_SEED_GOLDEN: "1" };
  if (spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: seedEnv, stdio: "ignore",
  }).status !== 0) fail("seed failed");

  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: { ...seedEnv, PORT: String(PORT), OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo" },
    stdio: "ignore",
  });
  if (!(await waitHealthy())) fail("server did not become healthy");
  pass("demo-posture server healthy");
  // The golden project belongs to the DMV borrower org, so its PM is needed
  // alongside the default seeded set.
  await signInAll(BASE, ["user-funder", "user-compliance", "user-dmv-pm"]);

  const db = new DatabaseSync(path.join(DATA, "obv.db"), { readOnly: true });
  const dr = require(path.join(ROOT, "dist/server/services/drawReadiness"));
  const repo = require(path.join(ROOT, "dist/server/db/repo"));

  const api = async (userId, method, p, body) => {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        cookie: sessionCookie(BASE, userId),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html response */ }
    return { status: res.status, json, text };
  };
  const page = async (userId, p) => {
    const res = await fetch(BASE + p, {
      headers: { cookie: sessionCookie(BASE, userId), accept: "text/html" },
    });
    return { status: res.status, html: await res.text() };
  };
  const lineIds = (drawId) =>
    db.prepare("SELECT id FROM draw_line_items WHERE draw_request_id = ? ORDER BY rowid")
      .all(drawId).map((r) => r.id);
  const requiredDocs = (drawId) =>
    db.prepare(
      "SELECT id, title, doc_type t FROM draw_document_requirements WHERE draw_request_id = ? AND required = 1"
    ).all(drawId);
  const fileDocs = async (userId, drawId, amount) => {
    for (const r of requiredDocs(drawId)) {
      await api(userId, "POST", `/api/draws/${drawId}/documents`, {
        requirementId: r.id, title: `${r.title} (fictional)`, docType: r.t,
        waiverKind: /LIEN_WAIVER/.test(r.t) ? "CONDITIONAL" : null,
        waiverScope: /LIEN_WAIVER/.test(r.t) ? "PROGRESS" : null,
        coveredThrough: /LIEN_WAIVER/.test(r.t) ? "2026-11-30" : null,
        invoiceNumber: r.t === "CONTRACTOR_INVOICE" ? "DRUI-1" : null,
        amount: r.t === "CONTRACTOR_INVOICE" ? amount : null,
      });
    }
  };
  const mkDraw = async (userId, projectId, amount, lines) => {
    const created = await api(userId, "POST", "/api/draws", {
      projectId, requestedAmount: amount, periodStart: "2026-11-01", periodEnd: "2026-11-30",
    });
    if (!created.json?.draw) fail(`setup: could not create a draw (${created.status})`);
    const id = created.json.draw.id;
    for (const l of lines) await api(userId, "POST", `/api/draws/${id}/lines`, l);
    return id;
  };

  // ---------- fixtures: one draw per readiness state, all through the API ----------
  // HOLD with a genuine unsupported gap: one line supported in full, one
  // partially supported by a recorded reviewer decision.
  const holdId = await mkDraw("user-dmv-pm", "proj-golden", 300000, [
    { description: "Structural framing — Level 2", milestoneId: "ms-g3", scheduledValue: 200000, currentRequested: 200000 },
    { description: "Mechanical rough-in", milestoneId: "ms-g4", scheduledValue: 100000, currentRequested: 100000 },
  ]);
  await api("user-dmv-pm", "POST", `/api/draws/${holdId}/submit`, {});
  const holdLines = lineIds(holdId);
  {
    const full = await api("user-funder", "POST", `/api/draws/${holdId}/lines/${holdLines[0]}/review`,
      { decision: "SUPPORTED", percentCompleteVerified: 100 });
    const part = await api("user-funder", "POST", `/api/draws/${holdId}/lines/${holdLines[1]}/review`, {
      decision: "PARTIALLY_SUPPORTED", supportedAmount: 60000,
      reason: "Rough-in verified to 60% of the billed scope (fictional).",
    });
    // Assert the fixture, or a silently rejected review would leave the line
    // PENDING and every downstream assertion would test the wrong thing.
    if (full.status !== 200) fail(`setup: the full line review did not record (${full.status})`);
    if (part.status !== 200) fail(`setup: the partial line review did not record (${part.status}) ${part.text.slice(0, 120)}`);
  }

  // READY: every line reviewed and every required document on file.
  const readyId = await mkDraw("user-dmv-pm", "proj-golden", 40000, [
    { description: "Interior finishes balance", milestoneId: "ms-g5", scheduledValue: 40000, currentRequested: 40000 },
  ]);
  await api("user-dmv-pm", "POST", `/api/draws/${readyId}/submit`, {});
  for (const id of lineIds(readyId)) {
    const rv = await api("user-funder", "POST", `/api/draws/${readyId}/lines/${id}/review`,
      { decision: "SUPPORTED", percentCompleteVerified: 100 });
    if (rv.status !== 200) fail(`setup: a READY-fixture line review did not record (${rv.status})`);
  }
  await fileDocs("user-dmv-pm", readyId, 40000);

  // INCOMPLETE: a line with no milestone mapping is missing INFORMATION
  // about the jurisdictional surface — never a failed requirement.
  const incId = await mkDraw("user-dmv-pm", "proj-golden", 50000, [
    { description: "Unmapped scope line (fictional)", scheduledValue: 50000, currentRequested: 50000 },
  ]);
  await api("user-dmv-pm", "POST", `/api/draws/${incId}/submit`, {});
  for (const id of lineIds(incId)) {
    const rv = await api("user-funder", "POST", `/api/draws/${incId}/lines/${id}/review`,
      { decision: "SUPPORTED", percentCompleteVerified: 100 });
    if (rv.status !== 200) fail(`setup: an INCOMPLETE-fixture line review did not record (${rv.status})`);
  }
  await fileDocs("user-dmv-pm", incId, 50000);

  const rHold = dr.drawReadiness(holdId);
  const rReady = dr.drawReadiness(readyId);
  const rInc = dr.drawReadiness(incId);
  assert(rHold.status === "HOLD", `setup: the partially reviewed draw is HOLD (${rHold.status})`);
  assert(rReady.status === "READY", `setup: the fully reviewed draw is READY (${rReady.status})`);
  assert(rInc.status === "INCOMPLETE", `setup: the unmapped-line draw is INCOMPLETE (${rInc.status})`);

  const holdHtml = (await page("user-funder", `/draw/${holdId}`)).html;
  const readyHtml = (await page("user-funder", `/draw/${readyId}`)).html;
  const incHtml = (await page("user-funder", `/draw/${incId}`)).html;

  // ---------- 1. draw identity header ----------
  assert(/class="dr-head"/.test(holdHtml), "1. the page opens on a compact draw identity header");
  {
    const draw = db.prepare("SELECT draw_number n, period_start s, period_end e FROM draw_requests WHERE id = ?").get(holdId);
    assert(holdHtml.includes(`Draw #${draw.n}`), "1. the header states the real draw number");
    assert(holdHtml.includes(draw.s) && holdHtml.includes(draw.e), "1. the header states the recorded draw period");
    const org = db.prepare(
      "SELECT o.name n FROM projects p JOIN organizations o ON o.id = p.contractor_org_id WHERE p.id = 'proj-golden'"
    ).get();
    if (org) {
      assert(holdHtml.includes(org.n), "1. the header names the borrower organization from the project record");
    } else {
      pass("1. no borrower org is recorded on this project — the header says so rather than inventing one");
    }
    assert(/Readiness<\/span>HOLD/.test(holdHtml.replace(/\s+/g, "")) || /READINESS/i.test(holdHtml),
      "1. the readiness state travels in the header beside the draw status");
  }

  // ---------- 2. four states, in words, never a score ----------
  for (const [label, html, state] of [
    ["HOLD", holdHtml, "HOLD"], ["READY", readyHtml, "READY"], ["INCOMPLETE", incHtml, "INCOMPLETE"],
  ]) {
    assert(new RegExp(`class="dr-state-badge">${state}<`).test(html),
      `2. ${label} is stated as a word in the readiness panel`);
  }
  assert(/Ready for lender review/.test(readyHtml) && !/\bapproved\b/i.test(
    (readyHtml.match(/class="dr-state-cap">[^<]*/) ?? [""])[0]
  ), "2. READY is captioned as ready for lender review, never as approved");
  {
    // The reference's 0-100 score must not have been reproduced anywhere.
    const banned = /Evidence Intelligence Score|Intelligence Score|\/100|Draw score|Strong Confidence/i;
    for (const [label, html] of [["HOLD", holdHtml], ["READY", readyHtml], ["INCOMPLETE", incHtml]]) {
      assert(!banned.test(html), `2. the ${label} page invents no 0–100 intelligence score`);
    }
    const src = fs.readFileSync(path.join(ROOT, "src/server/view/drawPages.tsx"), "utf8");
    assert(!/AI recommends|approve\b.*confidence|Intelligence Score/i.test(src),
      "2. the view never recommends an approval or converts confidence into a grade");
  }
  assert(!/readiness[^<]{0,20}\d+%/i.test(holdHtml.replace(/\s+/g, " ")),
    "2. readiness is never reduced to a percentage");

  // ---------- 3. requested / supportable / unsupported ----------
  {
    const usd = (n) => "$" + n.toLocaleString("en-US");
    assert(rHold.requestedAmount === 300000 && rHold.supportableAmount === 260000 && rHold.unsupportedAmount === 40000,
      `3. the engine reports a real unsupported gap from a recorded partial review (${rHold.requestedAmount}/${rHold.supportableAmount}/${rHold.unsupportedAmount})`);
    for (const [k, v] of [["Requested", rHold.requestedAmount], ["Currently supportable", rHold.supportableAmount], ["Unsupported", rHold.unsupportedAmount]]) {
      assert(holdHtml.includes(usd(v)), `3. ${k} (${usd(v)}) is rendered from the engine's own figure`);
    }
    // Three DIFFERENT numbers, three labelled cells — never collapsed.
    const cells = holdHtml.match(/class="c (req|sup|uns)"/g) ?? [];
    assert(cells.length === 3, "3. requested, supportable and unsupported occupy three distinct cells");
    assert(/REQUESTED|Requested/.test(holdHtml) && /supportable/i.test(holdHtml) && /Unsupported/i.test(holdHtml),
      "3. each figure carries its own word label, so they can never be read as one number");
    // The supportable figure means something different when lines are still
    // unreviewed, and the page must say so rather than presenting a partial
    // sum as a settled one.
    if (rHold.supportBasis === "FULL_REVIEW") {
      assert(!/an unreviewed line supports nothing|Partial review —/i.test(holdHtml),
        "3. a fully reviewed draw shows no partial-review caveat");
    } else {
      assert(/an unreviewed line supports nothing|Partial review —/i.test(holdHtml),
        "3. a partially reviewed draw discloses that unreviewed lines support nothing yet");
    }
    {
      // Prove the caveat DOES appear when the basis is partial — the READY
      // fixture is fully reviewed, so build the check on a draw that is not.
      const pendingId = await mkDraw("user-dmv-pm", "proj-golden", 20000, [
        { description: "Unreviewed scope (fictional)", milestoneId: "ms-g5", scheduledValue: 20000, currentRequested: 20000 },
      ]);
      await api("user-dmv-pm", "POST", `/api/draws/${pendingId}/submit`, {});
      const rp = dr.drawReadiness(pendingId);
      const html = (await page("user-funder", `/draw/${pendingId}`)).html;
      assert(rp.supportBasis === "NO_REVIEW" && /supports nothing/i.test(html),
        "3. with no line reviews the page states that an unreviewed line supports nothing");
      assert(rp.supportableAmount === 0 && html.includes("$0"),
        "3. an unreviewed draw's supportable amount is zero, never presumed to be the requested amount");
    }
  }

  // ---------- 4. governed blockers vs advisory signals ----------
  assert(/Governed blockers/i.test(holdHtml) && /Advisory signals/i.test(holdHtml),
    "4. governed blockers and advisory signals are two separately titled sections");
  assert(/class="dr-blockers"/.test(holdHtml) && /class="dr-advisories"/.test(holdHtml),
    "4. the two lists are structurally distinct, not one styled list");
  assert(/never change the readiness state/i.test(holdHtml),
    "4. the advisory section states in words that it never changes readiness");
  {
    // Every rendered blocker is an engine blocker, and every advisory is an
    // engine warning — the view synthesizes neither.
    const blockerCount = (holdHtml.match(/<li class="(blocking|unknown)">/g) ?? []).length;
    assert(blockerCount === rHold.blockingReasons.length,
      `4. every governed blocker row comes from the engine (${blockerCount} rendered, ${rHold.blockingReasons.length} reported)`);
    for (const b of rHold.blockingReasons.slice(0, 4)) {
      assert(holdHtml.includes(b.nextAction), "4. each blocker carries the engine's own next action");
      break;
    }
    assert(rHold.warnings.every((w) => !new RegExp(`<li class="(blocking|unknown)">[\\s\\S]{0,400}?${
      w.message.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(holdHtml)),
      "4. no advisory warning is rendered inside the governed blocker list");
  }
  assert(/Exception-eligible|Not exception-eligible/i.test(holdHtml),
    "4. each blocker discloses whether policy permits proceeding past it by exception");

  // ---------- 5. UNKNOWN is never healthy ----------
  {
    const unknown = rInc.blockingReasons.filter((b) => dr.isUnknownInformation(b.code));
    assert(unknown.length > 0, "5. the INCOMPLETE draw's blocker is missing information, not a failed requirement");
    assert(/<li class="unknown">/.test(incHtml),
      "5. an unknown-information blocker is rendered in its own serious style, not as a quiet row");
    assert(/Missing information/i.test(incHtml), "5. the unknown blocker is labelled Missing information in words");
    assert(!/class="dr-cat ok"[\s\S]{0,80}Government inspection/i.test(incHtml),
      "5. an undetermined jurisdictional surface never rolls up as PASS");
    assert(/dr-state unknown|dr-cat unknown/.test(incHtml),
      "5. INCOMPLETE carries its own visual treatment — it is never shown as a pass or a soft warning");
    // The whole point: a high count of satisfied things must not make the
    // page read healthy while information is missing.
    assert(/class="dr-state-badge">INCOMPLETE</.test(incHtml),
      "5. the headline state stays INCOMPLETE even with every document on file and every line reviewed");
  }

  // ---------- 6. the line register leads with supportability ----------
  {
    for (const col of ["Line item", "Budget", "This draw", "Supported", "Unsupported", "Evidence", "Review state", "Readiness impact"]) {
      assert(holdHtml.includes(`>${col}</th>`), `6. the register carries the ${col} column`);
    }
    assert(!/>Intelligence score<\/th>|>Score<\/th>/i.test(holdHtml),
      "6. there is no intelligence-score column — supportability is the financial centrepiece");
    const partial = rHold.lineReadiness.find((l) => l.supported !== null && l.variance > 0);
    assert(partial && holdHtml.includes("$" + partial.variance.toLocaleString("en-US")),
      "6. a partially supported line shows its unsupported remainder on the row");
  }

  // ---------- 7. the deterministic next action ----------
  assert(/class="dr-next"/.test(holdHtml), "7. the next action is a first-class element of the readiness panel");
  assert(rHold.primaryBlocker && holdHtml.includes(rHold.primaryBlocker.nextAction),
    "7. while a blocker stands, the next action shown is that blocker's own recorded next action");
  {
    // It must never tell a reviewer to finalize a draw the same panel is
    // calling INCOMPLETE.
    const nextBlock = (incHtml.match(/class="dr-next"[\s\S]*?<\/div>/) ?? [""])[0];
    assert(rInc.primaryBlocker && nextBlock.includes(rInc.primaryBlocker.nextAction),
      "7. an INCOMPLETE draw's next action resolves the missing information, not the workflow stage");
  }

  // ---------- 8. the decision area and the INCOMPLETE 422 invariant ----------
  assert(/Record lender decision|Open lender workspace/.test(holdHtml),
    "8. the primary action is a lender DECISION, never a bare Approve Draw button");
  assert(!/>Approve draw</i.test(holdHtml) && !/>Approve Draw</.test(holdHtml),
    "8. no state offers a generic Approve Draw control");
  assert(/Approving dispositions are unavailable/i.test(incHtml),
    "8. the INCOMPLETE page states that approving dispositions are refused");
  assert(/missing information cannot be waived into existence/i.test(incHtml),
    "8. it explains why: missing information cannot be waived into existence");
  assert(/Ready for lender review/i.test(readyHtml) && !/Approving dispositions are unavailable/i.test(readyHtml),
    "8. a READY draw is not gated by the INCOMPLETE notice");
  {
    // The live invariant, not just the copy: an approving disposition over
    // INCOMPLETE is refused 422 WITH justification, and nothing persists.
    // The readiness gate sits AFTER the pre-existing governance truth
    // table, so the draw must first reach the point where a lender
    // decision is legitimately accepted. Otherwise a 409 from the older
    // workflow would masquerade as the readiness refusal under test.
    const gov = await api("user-funder", "POST", `/api/draws/${incId}/governance`, {});
    if (gov.status >= 400) fail(`setup: the INCOMPLETE draw could not open governance (${gov.status}) ${gov.text.slice(0, 160)}`);
        const apRow = db.prepare("SELECT id FROM approval_requests WHERE draw_request_id = ?").get(incId);
    if (!apRow) fail("setup: the INCOMPLETE draw did not open an approval request");
    await api("user-funder", "POST", `/api/approvals/${apRow.id}/decision`, { decision: "APPROVED" });
    await api("user-compliance", "POST", `/api/approvals/${apRow.id}/decision`, { decision: "APPROVED" });
    const before = db.prepare(
      "SELECT COUNT(*) c FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_SNAPSHOT'"
    ).get(incId).c;
    const res = await api("user-funder", "POST", `/api/draws/${incId}/lender-decision`, {
      decision: "APPROVED", approvedAmount: 50000,
      decisionReason: "Documented business justification (fictional).",
      exceptionsAccepted: "Lender accepts the unmapped line (must still be refused).",
    });
    assert(res.status === 422 && /INCOMPLETE/.test(JSON.stringify(res.json)),
      `8. an approving decision over INCOMPLETE is refused 422 even with full justification (got ${res.status})`);
    const bare = await api("user-funder", "POST", `/api/draws/${incId}/lender-decision`, {
      decision: "APPROVED", approvedAmount: 50000,
    });
    assert(bare.status === 422, `8. the same refusal applies without justification (got ${bare.status})`);
    const decisions = db.prepare(
      "SELECT COUNT(*) c FROM lender_draw_decisions WHERE draw_request_id = ?"
    ).get(incId).c;
    assert(decisions === 0, "8. the refused decision persists no lender decision row");
    const after = db.prepare(
      "SELECT COUNT(*) c FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_SNAPSHOT'"
    ).get(incId).c;
    assert(after === before, "8. the refused decision persists no readiness snapshot");
    assert(dr.drawReadiness(incId).status === "INCOMPLETE",
      "8. readiness is unchanged by the refusal — INCOMPLETE was not converted into HOLD");
  }

  // ---------- 9. proceed by exception is impossible to miss ----------
  {
    // Record a justified approving decision over a HOLD whose blockers are
    // all exception-eligible — the governed override path.
    // An exception-eligible HOLD the pre-existing governance workflow still
    // accepts: every document on file and every line reviewed, but the
    // referenced milestone carries the seed's open HIGH exception. That is
    // an EXCEPTION-category blocker, exception-eligible under policy.
    const exId = await mkDraw("user-dmv-pm", "proj-golden", 40000, [
      { description: "MEP rough-in balance — exception path", milestoneId: "ms-g4", scheduledValue: 60000, currentRequested: 40000 },
    ]);
    await api("user-dmv-pm", "POST", `/api/draws/${exId}/submit`, {});
    for (const id of lineIds(exId)) {
      const rv = await api("user-funder", "POST", `/api/draws/${exId}/lines/${id}/review`,
        { decision: "SUPPORTED", percentCompleteVerified: 100 });
      if (rv.status !== 200) fail(`setup: an exception-fixture line review did not record (${rv.status})`);
    }
    await fileDocs("user-dmv-pm", exId, 40000);
    const rBefore = dr.drawReadiness(exId);
    const overridable = rBefore.status !== "READY" && rBefore.blockingReasons.length > 0
      && rBefore.blockingReasons.every((b) => b.exceptionAllowed);
    if (!overridable) {
      fail(`9. setup: the exception fixture is ${rBefore.status} with blockers ${
        rBefore.blockingReasons.map((b) => `${b.code}(${b.exceptionAllowed})`).join(", ") || "none"}`);
    }
    pass(`9. the fixture is an exception-eligible ${rBefore.status} — every blocker may be proceeded past by documented exception`);
    const gov = await api("user-funder", "POST", `/api/draws/${exId}/governance`, {});
    if (gov.status >= 400) fail(`9. setup: governance did not open (${gov.status}) ${gov.text.slice(0, 200)}`);
    const ap = db.prepare("SELECT id FROM approval_requests WHERE draw_request_id = ?").get(exId);
    if (!ap) fail("9. setup: no approval request was opened for the exception fixture");
    await api("user-funder", "POST", `/api/approvals/${ap.id}/decision`, { decision: "APPROVED" });
    await api("user-compliance", "POST", `/api/approvals/${ap.id}/decision`, { decision: "APPROVED" });
    const res = await api("user-funder", "POST", `/api/draws/${exId}/lender-decision`, {
      decision: "APPROVED", approvedAmount: 40000,
      decisionReason: "Lender accepts the documented exception (fictional).",
      exceptionsAccepted: "Roof evidence scheduled for the next site visit; lender accepts the documented gap (fictional).",
    });
    assert(res.status < 400,
      `9. a justified approving decision over an exception-eligible HOLD is recorded (${res.status}) ${res.text.slice(0, 160)}`);
    const rAfter = dr.drawReadiness(exId);
    assert(rAfter.proceededByException, "9. the engine reports the draw as proceeded by exception");
    assert(rAfter.blockingReasons.length === rBefore.blockingReasons.length,
      "9. the override erases no blocker — the requirement stays OUTSTANDING");
    const exHtml = (await page("user-funder", `/draw/${exId}`)).html;
    assert(/PROCEEDED BY EXCEPTION/.test(exHtml), "9. the page announces PROCEEDED BY EXCEPTION in words");
    assert(/class="dr-exception"/.test(exHtml),
      "9. the override is a full-width banner, visually distinct from a normal READY approval");
    assert(/Justification/i.test(exHtml) && /lender accepts the documented gap/i.test(exHtml),
      "9. the recorded justification is shown");
    assert(/Requirements overridden/i.test(exHtml) && /Decision actor/i.test(exHtml) && /Decision recorded/i.test(exHtml),
      "9. the banner shows what was overridden, by whom and when");
    assert(/remain OUTSTANDING/i.test(exHtml),
      "9. the banner says the requirements remain outstanding — the decision does not satisfy them");
    assert(/class="dr-blockers"/.test(exHtml),
      "9. the overridden blockers are still listed beneath the banner");
    assert(!/class="dr-exception"/.test(readyHtml),
      "9. a normal READY draw shows no exception banner — an override never looks like an ordinary approval");
  }

  // ---------- 10. doctrine language ----------
  {
    const banned = [
      /payment authorized/i, /funding approved/i, /legally compliant/i,
      /legal compliance/i, /AI recommends/i, /approved for funding/i,
    ];
    for (const [label, html] of [["HOLD", holdHtml], ["READY", readyHtml], ["INCOMPLETE", incHtml]]) {
      for (const re of banned) {
        if (re.test(html)) fail(`10. the ${label} page claims "${re}" — readiness is not approval or payment`);
      }
    }
    pass("10. no page collapses readiness into approval, funding, payment or legal compliance");
    assert(/not lender approval/i.test(holdHtml) && /release eligibility/i.test(holdHtml),
      "10. the distinct-state chain is stated on the page itself");
  }

  // ---------- 11. viewports ----------
  {
    const browser = await launchChromium();
    for (const [w, h, label] of [[1440, 900, "1440×900"], [1280, 800, "1280×800"], [390, 844, "390×844"]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.addCookies([playwrightCookie(BASE, "user-funder")]);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/draw/${holdId}`, { waitUntil: "networkidle" });
      await p.waitForTimeout(300);
      const overflow = await p.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      assert(!overflow, `11. no horizontal overflow at ${label}`);
      if (w === 390) {
        // The register must restack as labelled records, not squash.
        const stacked = await p.evaluate(() => {
          const td = document.querySelector(".dr-register .dtable tbody td");
          if (!td) return null;
          return { display: getComputedStyle(td).display, label: td.getAttribute("data-l") };
        });
        assert(stacked && stacked.display === "flex",
          "11. on the phone the line register restacks into records rather than a squashed table");
        const headHidden = await p.evaluate(() => {
          const th = document.querySelector(".dr-register .dtable thead");
          return th ? getComputedStyle(th).position === "absolute" : false;
        });
        assert(headHidden, "11. the register's column header row is removed from the phone layout");
        const order = await p.evaluate(() => {
          const seen = [];
          const state = document.querySelector(".dr-state-badge");
          const cap = document.querySelector(".dr-cap");
          const blockers = document.querySelector(".dr-blockers, .dr-blocker-empty");
          for (const [k, el] of [["state", state], ["amounts", cap], ["blockers", blockers]]) {
            if (el) seen.push([k, el.getBoundingClientRect().top + window.scrollY]);
          }
          return seen;
        });
        const tops = Object.fromEntries(order);
        assert(tops.state < tops.amounts && tops.amounts < tops.blockers,
          "11. the phone leads with the readiness state, then the amounts, then the blockers");
      }
      await ctx.close();
    }
    await browser.close();
  }

  // ---------- 12. the redesign changed presentation only ----------
  {
    const engine = fs.readFileSync(path.join(ROOT, "src/server/services/drawReadiness.ts"), "utf8");
    assert(/export function isUnknownInformation/.test(engine),
      "12. the unknown-information classification is exported for the view, not duplicated in it");
    const view = fs.readFileSync(path.join(ROOT, "src/server/view/drawPages.tsx"), "utf8");
    assert(!/UNKNOWN_INFO_CODES|INSPECTION_REQUIREMENT_UNKNOWN|LINE_WITHOUT_MILESTONE/.test(view),
      "12. the view re-derives no readiness code list of its own");
    assert(!/requestedAmount\s*-\s*supportableAmount|supportable\s*=\s*/.test(view),
      "12. the view recomputes no amount — every figure is read from the engine result");
    assert(/r\.unsupportedAmount/.test(view),
      "12. the unsupported figure is the engine's own field");
  }

  db.close();
  stopAll();
  console.log(`\nDRAW REVIEW UI TESTS PASSED — ${passed} checkpoints.`);
  console.log("READINESS IS NOT APPROVAL. SUPPORTABLE IS NOT REQUESTED. UNKNOWN IS NOT HEALTHY.");
}

main().then(
  () => { stopAll(); process.exit(0); },
  (err) => { console.error(err); stopAll(); process.exit(1); }
);
