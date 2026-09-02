#!/usr/bin/env node
/**
 * Lender Pilot RC1 test battery — the golden path, end to end.
 *
 * Proves the pilot composition layer over real governed services:
 *   0. golden project (flag-gated; absent from the baseline seed)
 *   1. deterministic Next Action per golden draw + read-only proof
 *   2. command center buckets + operational metrics
 *   3. the LIVE golden path: create draw -> incomplete evidence ->
 *      lender sees what is missing -> complete -> review -> governance
 *      -> dual approval -> release eligibility -> lender decision ->
 *      draw package with the executive summary + manifest
 *   4. notification wiring (in-app + dev-safe email outbox), and that
 *      notifications never mutate the workflow
 *   5. ROI measurements from real timestamps
 *   6. authorization: foreign tenants and anonymous callers
 *   7. HTTP: command center, next-action banner, pilot navigation
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = process.cwd();
const DATA_A = fs.mkdtempSync(path.join(os.tmpdir(), "obv-rc1-a-"));
const DATA_BASE = fs.mkdtempSync(path.join(os.tmpdir(), "obv-rc1-base-"));
const DATA_B = fs.mkdtempSync(path.join(os.tmpdir(), "obv-rc1-b-"));
const PORT = 3280;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.OBV_DATA_DIR = DATA_A;
process.env.OBV_SEED_GOLDEN = "1";

let passed = 0;
const pass = (m) => { passed += 1; console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`); };
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); throw new Error(m); };
const assert = (cond, m) => (cond ? pass(m) : fail(m));

function seed(dir, golden) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: dir, OBV_SEED_GOLDEN: golden ? "1" : "" },
    stdio: "ignore",
  });
  if (r.status !== 0) fail("seed failed");
}

const repo = require(path.join(ROOT, "dist/server/db/repo"));
const draws = require(path.join(ROOT, "dist/server/services/draws"));
const lenderDecisions = require(path.join(ROOT, "dist/server/services/lenderDecisions"));
const drawPackage = require(path.join(ROOT, "dist/server/services/drawPackage"));
const pilot = require(path.join(ROOT, "dist/server/services/pilot/lenderPilot"));
const integrationsRepo = require(path.join(ROOT, "dist/server/db/integrationsRepo"));
const tl = require(path.join(ROOT, "dist/server/services/timeline"));

let db = null;
const tableHash = (t) =>
  crypto.createHash("sha256")
    .update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()))
    .digest("hex");

let server = null;

async function main() {
  seed(DATA_A, true);
  seed(DATA_BASE, false);
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(DATA_A, "obv.db"));
  const baseDb = new DatabaseSync(path.join(DATA_BASE, "obv.db"));

  const funder = repo.getUser("user-funder");
  const compliance = repo.getUser("user-compliance");
  const dmvPm = repo.getUser("user-dmv-pm");
  const r47Pm = repo.getUser("user-pm");

  // ------------------------------------------------ 0. golden project
  console.log("\n== 0. Golden project (flag-gated) ==");
  const golden = repo.getProject("proj-golden");
  assert(Boolean(golden), "the golden project exists when OBV_SEED_GOLDEN=1");
  assert(/DEMO — /.test(golden.name) && /[Ff]ictional/.test(golden.description),
    "the golden project is clearly labeled fictional demo data");
  assert(
    baseDb.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = 'proj-golden'").get().n === 0,
    "the baseline seed (no flag) does NOT contain the golden project — existing suites keep their state"
  );
  const goldenDraws = repo.listDrawRequestsForProject("proj-golden");
  assert(goldenDraws.length === 6, "six draws span the lender workflow");
  const byNumber = new Map(goldenDraws.map((d) => [d.drawNumber, d]));
  assert(byNumber.get(1).status === "RELEASED", "draw #1 is completed history (RELEASED)");
  assert(byNumber.get(2).status === "READY_FOR_GOVERNANCE", "draw #2 awaits formal approval");
  assert(byNumber.get(3).status === "RETURNED", "draw #3 was returned for more evidence");
  assert(byNumber.get(4).status === "UNDER_REVIEW", "draw #4 is under review");
  assert(byNumber.get(5).status === "SUBMITTED" && byNumber.get(6).status === "SUBMITTED",
    "draws #5 and #6 are submitted");
  assert(repo.listPermitsForProject("proj-golden").length === 2, "fictional permits are recorded");
  assert(
    repo.listInspectionsForProject("proj-golden").some((i) => i.result === "CORRECTIONS_REQUIRED") &&
      repo.listInspectionsForProject("proj-golden").some((i) => i.reinspectionOfInspectionId),
    "the inspection correction chain is present (original result preserved)"
  );

  // ------------------------------------------------ 1. next action
  console.log("\n== 1. Deterministic Next Action ==");
  const expect = [
    [1, "NO_ACTION_REQUIRED"], [2, "AWAITING_APPROVALS"], [3, "REVISE_AND_RESUBMIT"],
    [4, "UPLOAD_MISSING_DOCUMENTS"], [5, "RESOLVE_EXCEPTIONS"], [6, "INSPECTION_RESULT_REQUIRED"],
  ];
  for (const [n, code] of expect) {
    const a = pilot.drawNextAction(byNumber.get(n).id);
    assert(a.code === code, `draw #${n} → ${code} ("${a.label}")`);
  }
  const first = pilot.drawNextAction(byNumber.get(4).id);
  const second = pilot.drawNextAction(byNumber.get(4).id);
  assert(JSON.stringify(first) === JSON.stringify(second), "the same records always yield the same next action");
  const TABLES = ["draw_requests", "draw_line_items", "draw_documents", "approval_requests", "exceptions", "lender_draw_decisions"];
  const before = {};
  for (const t of TABLES) before[t] = tableHash(t);
  for (const d of goldenDraws) pilot.drawNextAction(d.id);
  pilot.pilotCommandCenter(funder);
  pilot.pilotRoiMeasurements(funder);
  for (const t of TABLES) {
    assert(before[t] === tableHash(t), `${t} byte-identical after next-action/center/ROI reads`);
  }

  // ------------------------------------------------ 2. command center
  console.log("\n== 2. Pilot command center ==");
  const center = pilot.pilotCommandCenter(funder);
  const inBucket = (bucket, n) => bucket.some((r) => r.projectId === "proj-golden" && r.drawNumber === n);
  assert(inBucket(center.readyForDecision, 2), "draw #2 sits in Ready for lender decision");
  assert(inBucket(center.waitingOnContractor, 3) && inBucket(center.waitingOnContractor, 4),
    "draws #3 and #4 sit in Waiting on contractor");
  assert(inBucket(center.waitingOnInspection, 6), "draw #6 sits in Waiting on inspection");
  assert(inBucket(center.complianceExceptions, 5), "draw #5 sits in Compliance exceptions");
  assert(center.recentlyApproved.some((r) => r.drawNumber === 1 && r.projectId === "proj-golden"),
    "draw #1 shows under Recently approved");
  assert(center.metrics.medianReviewDays !== null, "median review time is measured from recorded decisions");
  assert(center.metrics.openDraws > 0 && center.metrics.totalRequestedOpen > 0, "operational metrics are populated");
  const pmCenter = pilot.pilotCommandCenter(r47Pm);
  assert(
    [...pmCenter.readyForDecision, ...pmCenter.waitingOnContractor, ...pmCenter.waitingOnInspection,
     ...pmCenter.complianceExceptions, ...pmCenter.aging, ...pmCenter.recentlyApproved]
      .every((r) => r.projectId !== "proj-golden"),
    "a foreign-tenant PM's command center contains NO golden-project draws"
  );

  // ------------------------------------------------ 3. the golden path, live
  console.log("\n== 3. Golden path end to end (live services) ==");
  const draw = draws.createDraw(dmvPm, {
    projectId: "proj-golden",
    requestedAmount: 150_000,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
  });
  pass(`created draw #${draw.drawNumber} through the governed service`);
  draws.addLine(dmvPm, draw.id, {
    description: "Interior finishes — drywall and trim",
    budgetLineId: null, milestoneId: "ms-g5", changeOrderId: null,
    exceptionAcknowledged: false,
    scheduledValue: 190_000, previouslyPaid: 0, currentRequested: 150_000,
    materialsStored: null, retainageAmount: 15_000, percentCompleteClaimed: 79,
  });
  const req = draws.addRequirement(dmvPm, draw.id, {
    docType: "CONDITIONAL_LIEN_WAIVER", title: "Conditional lien waiver #7", required: true, notes: null,
  });
  draws.recordDocument(dmvPm, draw.id, {
    requirementId: null, lineItemId: null, docType: "PAY_APPLICATION",
    title: "Pay Application #7 (fictional)", note: null, expiresAt: null,
    vendor: null, invoiceNumber: null, amount: null,
    waiverKind: null, waiverScope: null, coveredThrough: null,
    issuingAuthority: null, referenceNumber: null, inspectionDate: null, inspectionResult: null,
  });
  await draws.submitDraw(dmvPm, draw.id);
  let action = pilot.drawNextAction(draw.id);
  assert(
    action.code === "UPLOAD_MISSING_DOCUMENTS" && /lien waiver/i.test(action.detail),
    "after submission with incomplete evidence, the lender sees exactly what is missing"
  );
  const missingBefore = draws.missingRequiredDocuments(draw.id);
  assert(
    missingBefore.length >= 1 && missingBefore.some((m) => /lien waiver/i.test(m.title)),
    `${missingBefore.length} required document(s) outstanding, including the lien waiver`
  );

  // Contractor supplies every outstanding required document.
  for (const m of missingBefore) {
    draws.recordDocument(dmvPm, draw.id, {
      requirementId: m.id, lineItemId: null, docType: m.docType,
      title: `${m.title} (fictional)`, note: null, expiresAt: null,
      vendor: null, invoiceNumber: m.docType === "CONTRACTOR_INVOICE" ? "GP-7001" : null,
      amount: m.docType === "CONTRACTOR_INVOICE" ? 150000 : null,
      waiverKind: /LIEN_WAIVER/.test(m.docType) ? "CONDITIONAL" : null,
      waiverScope: /LIEN_WAIVER/.test(m.docType) ? "PROGRESS" : null,
      coveredThrough: /LIEN_WAIVER/.test(m.docType) ? "2026-08-31" : null,
      issuingAuthority: null, referenceNumber: null, inspectionDate: null, inspectionResult: null,
    });
  }
  assert(draws.missingRequiredDocuments(draw.id).length === 0, "corrected evidence clears the missing list");
  action = pilot.drawNextAction(draw.id);
  assert(action.code === "BEGIN_REVIEW", "the draw becomes lender-review ready");

  const line = repo.listDrawLines(draw.id)[0];
  draws.reviewLine(funder, line.id, { decision: "SUPPORTED" });
  action = pilot.drawNextAction(draw.id);
  assert(action.code === "LENDER_REVIEW_READY", "all lines reviewed → finalize recommendation");

  const { approvalRequest } = await draws.sendToGovernance(funder, draw.id, null);
  action = pilot.drawNextAction(draw.id);
  assert(action.code === "AWAITING_APPROVALS", "governance opened → awaiting formal approvals");
  const roles = approvalRequest.requiredRoles;
  assert(roles.length >= 2, `approval matrix requires ${roles.length} roles (dual control)`);
  await draws.processDrawApprovalDecision(approvalRequest.id, "user-funder", "APPROVED");
  const midAction = pilot.drawNextAction(draw.id);
  assert(midAction.code === "AWAITING_APPROVALS" && /1 of/.test(midAction.label),
    "first approval recorded — still awaiting the second (dual control holds)");
  await draws.processDrawApprovalDecision(approvalRequest.id, "user-compliance", "APPROVED");
  const approved = repo.getDrawRequest(draw.id);
  assert(["APPROVED", "PARTIALLY_APPROVED", "RELEASED"].includes(approved.status),
    `dual approval recorded → draw ${approved.status} (release eligibility exists only after both approvals)`);
  // Governance ≠ the lender decision: a governance-released draw with no
  // recorded lender decision is still OPEN for lender control — it keeps
  // its place in the command centre and names the lender as next actor.
  const awaiting = pilot.drawNextAction(draw.id);
  assert(awaiting.code === "LENDER_DECISION_REQUIRED" && awaiting.actor === "LENDER",
    `released + undecided → next action LENDER_DECISION_REQUIRED ("${awaiting.label}"), never "complete"`);
  assert(pilot.awaitingLenderDecision(approved) && pilot.isOpenForLenderControl(approved),
    "the shared predicate reports the draw as awaiting the lender decision / open for lender control");
  const centreAwaiting = pilot.pilotCommandCenter(funder);
  assert(centreAwaiting.readyForDecision.some((r) => r.drawRequestId === draw.id) &&
    centreAwaiting.metrics.openDraws >= 1 && centreAwaiting.metrics.totalRequestedOpen >= 150_000,
    "the command centre keeps the undecided draw in the ready-for-decision bucket and in open capital");

  lenderDecisions.recordLenderDecision(funder, {
    drawRequestId: draw.id, decision: "APPROVED", approvedAmount: 150_000,
    decisionReason: "Golden-path test decision (fictional).",
  });
  pass("lender decision recorded through the governed service");
  const decided = repo.getDrawRequest(draw.id);
  assert(!pilot.awaitingLenderDecision(decided) && !pilot.isOpenForLenderControl(decided) &&
    pilot.drawNextAction(draw.id).code === "NO_ACTION_REQUIRED" &&
    !pilot.pilotCommandCenter(funder).readyForDecision.some((r) => r.drawRequestId === draw.id),
    "once the lender decision is recorded the draw is disposed of — it leaves the open set (NO_ACTION_REQUIRED)");

  const pkgData = await drawPackage.assembleDrawPackageData(funder, draw.id);
  const pkg = drawPackage.buildDrawPackageFiles(pkgData);
  assert(pkg.files[0].name === "00-EXECUTIVE-SUMMARY.txt", "the package leads with the executive summary");
  const summary = pkg.files[0].data.toString("utf8");
  for (const section of ["1. PROJECT AND DRAW", "2. REQUESTED AMOUNT", "3. RELEASE ELIGIBILITY",
    "4. BUDGET STATUS", "5. EVIDENCE COMPLETENESS", "6. PERMITS AND INSPECTIONS",
    "7. EXCEPTIONS", "8. LENDER DECISION STATUS", "9. AUDIT AND VERIFICATION"]) {
    if (!summary.includes(section)) fail(`executive summary missing section ${section}`);
  }
  pass("the executive summary carries all nine lender-facing sections");
  assert(/authorizes nothing/.test(summary), "the summary states it authorizes nothing");
  assert(pkg.files.some((f) => f.name === "draw-summary.json"), "the detailed machine summary follows");

  const timeline = tl.projectTimeline(funder, "proj-golden");
  const drawEvents = timeline.events.filter((e) => e.drawRequestId === draw.id);
  assert(drawEvents.some((e) => e.type === "DRAW_SUBMITTED" || /SUBMITTED/.test(e.type)),
    "the Timeline reflects the draw lifecycle");

  // ------------------------------------------------ 4. notifications
  console.log("\n== 4. Notification wiring (never mutates) ==");
  const notifications = repo.listNotifications(100);
  for (const kind of ["DRAW_SUBMITTED", "APPROVAL_REQUIRED", "DRAW_DECISION_RECORDED"]) {
    assert(notifications.some((n) => n.type === kind), `in-app notification recorded for ${kind}`);
  }
  draws.returnDraw(funder, byNumber.get(5).id, "Golden-path test: permit discrepancy must be resolved first.");
  assert(repo.listNotifications(100).some((n) => n.type === "DRAW_RETURNED"),
    "returning a draw notifies DRAW_RETURNED");
  const outbox = integrationsRepo.listEmails ? integrationsRepo.listEmails(100) : [];
  assert(outbox.length > 0, `the dev-safe email outbox holds ${outbox.length} governed-event emails`);
  assert(
    outbox.every((e) => !/authoriz(es|ed) funds|release executed by email/i.test(e.subject)),
    "no email claims to authorize anything"
  );

  // ------------------------------------------------ 5. ROI measurements
  console.log("\n== 5. Pilot ROI measurements ==");
  const roi = pilot.pilotRoiMeasurements(funder);
  const journey = roi.draws.find((d2) => d2.drawRequestId === draw.id);
  assert(journey && journey.submittedAt && journey.decisionAt,
    "the live draw's journey carries real recorded timestamps");
  assert(journey.daysSubmissionToDecision !== null && journey.daysSubmissionToDecision >= 0,
    "submission→decision time is measured, not estimated");
  const g1 = roi.draws.find((d2) => d2.drawRequestId === "draw-g1");
  assert(g1 && g1.daysSubmissionToFirstReview === 3 && g1.daysSubmissionToDecision === 7.2,
    "historical measurements derive exactly from recorded timestamps");
  assert(!JSON.stringify(roi).includes("$"), "ROI reports measurements only — no fabricated dollar savings");

  // ------------------------------------------------ 6. authorization
  console.log("\n== 6. Authorization ==");
  let foreign = null;
  try { await drawPackage.assembleDrawPackageData(r47Pm, draw.id); } catch (e) { foreign = e; }
  assert(foreign && [403, 404].includes(foreign.statusCode), "a foreign-tenant PM cannot assemble the package");
  let foreignReview = null;
  try { draws.reviewLine(r47Pm, line.id, { decision: "SUPPORTED" }); } catch (e) { foreignReview = e; }
  assert(Boolean(foreignReview), "a foreign-tenant PM cannot mutate the draw");

  // ------------------------------------------------ 7. HTTP
  console.log("\n== 7. HTTP: command center, banner, pilot navigation ==");
  seed(DATA_B, true);
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_B, OBV_SEED_GOLDEN: "1", PORT: String(PORT), OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo" },
    stdio: "ignore",
  });
  let healthy = false;
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { healthy = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!healthy) fail("server did not become healthy");
  pass("server healthy");
  const signIn = async (userId) => {
    const r = await fetch(`${BASE}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }), redirect: "manual",
    });
    return r.headers.getSetCookie()[0].split(";")[0];
  };
  const cookie = await signIn("user-funder");
  const page = async (p, ck) => {
    const r = await fetch(`${BASE}${p}`, { headers: { cookie: ck ?? "", accept: "text/html" }, redirect: "manual" });
    return { status: r.status, html: await r.text() };
  };
  const overview = await page("/overview", cookie);
  assert(/What needs attention today/.test(overview.html), "the funder landing opens on the command center");
  for (const s of ["Ready for lender decision", "Waiting on contractor", "Waiting on inspection", "Compliance exceptions", "Recently approved"]) {
    if (!overview.html.includes(s)) fail(`command center section missing: ${s}`);
  }
  pass("all command-center sections render");
  // The pilot rule is "the lender's surfaces lead; everything else stays one
  // group away, nothing deleted". The workstation shell keeps that promise
  // with named groups instead of one "Advanced & intelligence" bucket, so
  // assert the shape that now carries the rule — every secondary group
  // present, and the pilot's own group leading the sidebar.
  for (const group of ["Command", "Verification", "Governance", "Operations"]) {
    assert(overview.html.includes(`>${group}</div>`),
      `advanced capabilities stay one group away under ${group} — nothing deleted`);
  }
  assert(
    overview.html.indexOf(">Command</div>") < overview.html.indexOf(">Verification</div>"),
    "the lender's pilot surfaces lead the sidebar; advanced groups follow"
  );
  // Advanced destinations now sit inside consolidated workspaces, so a
  // lender reaches them by workspace tab rather than by a sidebar row of
  // their own. The shell publishes the complete destination set — the
  // same list global search reads — which is where "nothing deleted" is
  // actually provable.
  const navIndex = JSON.parse(overview.html.split('id="nav-index">')[1].split("</script>")[0]);
  const reachable = new Set(navIndex.map((e) => e.href));
  for (const href of ["/timeline", "/evidence-intelligence", "/official-sources", "/executive", "/ledger", "/insights"]) {
    assert(
      reachable.has(href) || overview.html.includes(`href="${href}"`),
      `advanced destination preserved: ${href}`
    );
  }
  const g4 = repo.listDrawRequestsForProject("proj-golden").find((d2) => d2.drawNumber === 4);
  const drawPage = await page(`/draw/${g4.id}`, cookie);
  assert(/Next action/.test(drawPage.html) && /missing document/i.test(drawPage.html),
    "the Draw Review page carries the deterministic Next Action banner");
  assert((await fetch(`${BASE}/api/pilot/next-action?draw=${g4.id}`, { headers: { cookie } })).status === 200,
    "the next-action API answers the lender");
  assert((await fetch(`${BASE}/api/pilot/next-action?draw=${g4.id}`)).status === 401, "anonymous next-action is 401");
  const foreignCookie = await signIn("user-pm");
  assert((await fetch(`${BASE}/api/pilot/next-action?draw=${g4.id}`, { headers: { cookie: foreignCookie } })).status === 404,
    "a foreign tenant gets a plain 404 for the same draw");
  const roiRes = await fetch(`${BASE}/api/pilot/roi`, { headers: { cookie } });
  assert(roiRes.ok && Array.isArray((await roiRes.json()).draws), "the ROI API returns raw measurements");

  console.log(`\nLENDER PILOT RC1 TESTS PASSED — ${passed} checkpoints.`);
  console.log("ONE WORKFLOW. EVERY SAFEGUARD. LENDER-READABLE.");
}

main()
  .catch((err) => { console.error(err.stack ?? err); process.exitCode = 1; })
  .finally(() => {
    try { if (server) server.kill(); } catch {}
    for (const d of [DATA_A, DATA_BASE, DATA_B]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });
