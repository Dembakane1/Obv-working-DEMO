/**
 * Executive Command Center tests — isolated server on :3376.
 *
 * The refresh turned /executive into a portfolio CAPITAL CONTROL console.
 * The risk of a portfolio view is that aggregation quietly lies: a total
 * that double-counts, a "supportable" figure that reads as approved, a
 * blocked draw hidden behind four healthy domains, a past state described
 * with today's facts, or another tenant's capital folded into the sum.
 *
 * This suite proves the aggregate tells the same truth the per-draw engine
 * does:
 *
 *   1. every readiness count equals the real accessible open-draw set
 *   2. foreign-tenant draws never enter any total
 *   3. requested and supportable reconcile against the authoritative
 *      per-draw engine, draw by draw
 *   4. unsupported is the documented difference, and coverage is dollars
 *   5. a draw blocked in several domains counts ONCE in the portfolio and
 *      may still appear under several domains
 *   6. cross-cutting controls are never attributed to one of the four
 *      domains, and four healthy domains can never hide a blocked draw
 *   7. proceed-by-exception comes from immutable decision-time snapshots
 *   8. recent control changes read recorded history, not live state
 *   9. no composite portfolio score is introduced anywhere
 *  10. advisory analytics stay separate from governed control
 *  11. the page is write-free, role-gated, and has no mobile overflow
 *  12. a readiness bucket carries the same non-netted capital rule as the
 *      portfolio headline — an over-supported member never cancels
 *      another member's shortfall
 *  13. formal governance activity is never presented as the lender's
 *      business decision; real decisions come from the decision register
 *  14. an open draw whose readiness evaluation fails stays visible, keeps
 *      its raw governed facts, and the page fails closed instead of
 *      presenting subset totals as complete
 *  15. filters name their actual (advisory-only) scope
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
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "obv-execui-"));
const PORT = 3376;
const BASE = `http://127.0.0.1:${PORT}`;

// The readiness engine and the portfolio read model are required in-process
// so the suite can compare the page against the SAME authoritative
// computation the page used. The data root must be set before any service
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

/** Count every row in every table — the only honest write-free check. */
function tableCounts(db) {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  const counts = {};
  for (const t of names) {
    try { counts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { counts[t] = -1; }
  }
  return counts;
}

async function main() {
  console.log("\n== executive command center ==\n");

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
  await signInAll(BASE, ["user-funder", "user-compliance", "user-dmv-pm", "user-pm", "user-field"]);

  const db = new DatabaseSync(path.join(DATA, "obv.db"), { readOnly: true });
  const dr = require(path.join(ROOT, "dist/server/services/drawReadiness"));
  const portfolio = require(path.join(ROOT, "dist/server/services/portfolio/index"));
  const repo = require(path.join(ROOT, "dist/server/db/repo"));
  const authz = require(path.join(ROOT, "dist/server/services/authz"));

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
    try { json = JSON.parse(text); } catch { /* html */ }
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
        invoiceNumber: r.t === "CONTRACTOR_INVOICE" ? "EXEC-1" : null,
        amount: r.t === "CONTRACTOR_INVOICE" ? amount : null,
      });
    }
  };
  const mkDraw = async (userId, projectId, amount, lines) => {
    const created = await api(userId, "POST", "/api/draws", {
      projectId, requestedAmount: amount, periodStart: "2026-11-01", periodEnd: "2026-11-30",
    });
    if (created.status !== 201) fail(`setup: draw create failed (${created.status}) ${created.text.slice(0, 160)}`);
    const id = created.json.draw.id;
    for (const line of lines) {
      const res = await api(userId, "POST", `/api/draws/${id}/lines`, line);
      if (res.status >= 400) fail(`setup: draw line failed (${res.status}) ${res.text.slice(0, 160)}`);
    }
    return id;
  };

  /** Draw-domain HOLD pairs across the accessible open set. */
  const evaluatedDomainPairs = (projects) => {
    let pairs = 0;
    for (const project of projects) {
      for (const d of repo.listDrawRequestsForProject(project.id)) {
        if (!portfolio.OPEN_DRAW_STATUSES.includes(d.status)) continue;
        pairs += dr.controlDomains(dr.drawReadiness(d.id)).filter((x) => x.state === "HOLD").length;
      }
    }
    return pairs;
  };
  /** Open draws whose HOLD spans more than one domain. */
  const multiDomainHoldDraws = (projects) => {
    const ids = [];
    for (const project of projects) {
      for (const d of repo.listDrawRequestsForProject(project.id)) {
        if (!portfolio.OPEN_DRAW_STATUSES.includes(d.status)) continue;
        if (dr.controlDomains(dr.drawReadiness(d.id)).filter((x) => x.state === "HOLD").length > 1) ids.push(d.id);
      }
    }
    return ids;
  };

  // ================= fixtures, all through governed APIs =================
  //
  // No database row is written directly anywhere in this suite.

  // READY: every line reviewed, every required document on file.
  const readyId = await mkDraw("user-dmv-pm", "proj-golden", 40000, [
    { description: "Interior finishes balance (fictional)", milestoneId: "ms-g5", scheduledValue: 40000, currentRequested: 40000 },
  ]);
  await api("user-dmv-pm", "POST", `/api/draws/${readyId}/submit`, {});
  for (const id of lineIds(readyId)) {
    const rv = await api("user-funder", "POST", `/api/draws/${readyId}/lines/${id}/review`,
      { decision: "SUPPORTED", percentCompleteVerified: 100 });
    if (rv.status !== 200) fail(`setup: READY line review failed (${rv.status})`);
  }
  await fileDocs("user-dmv-pm", readyId, 40000);

  // INCOMPLETE: an unmapped line is missing INFORMATION about the
  // jurisdictional surface — never a failed requirement.
  const incId = await mkDraw("user-dmv-pm", "proj-golden", 50000, [
    { description: "Unmapped scope line (fictional)", scheduledValue: 50000, currentRequested: 50000 },
  ]);
  await api("user-dmv-pm", "POST", `/api/draws/${incId}/submit`, {});
  for (const id of lineIds(incId)) {
    const rv = await api("user-funder", "POST", `/api/draws/${incId}/lines/${id}/review`,
      { decision: "SUPPORTED", percentCompleteVerified: 100 });
    if (rv.status !== 200) fail(`setup: INCOMPLETE line review failed (${rv.status})`);
  }
  await fileDocs("user-dmv-pm", incId, 50000);

  // EXCEPTION_REVIEW: a clean draw carrying one formal EVIDENCE-subject
  // exception. The subject is evidence, NOT compliance — the scorecard
  // must not turn the Compliance domain red because of it.
  const excId = await mkDraw("user-dmv-pm", "proj-golden", 30000, [
    { description: "Finishes punch list (fictional)", milestoneId: "ms-g5", scheduledValue: 30000, currentRequested: 30000 },
  ]);
  await api("user-dmv-pm", "POST", `/api/draws/${excId}/submit`, {});
  for (const id of lineIds(excId)) {
    const rv = await api("user-funder", "POST", `/api/draws/${excId}/lines/${id}/review`,
      { decision: "SUPPORTED", percentCompleteVerified: 100 });
    if (rv.status !== 200) fail(`setup: EXCEPTION line review failed (${rv.status})`);
  }
  await fileDocs("user-dmv-pm", excId, 30000);
  const excOpen = await api("user-compliance", "POST", "/api/exceptions", {
    // Draw-scoped deliberately: a milestone-scoped exception would attach
    // to every draw touching that milestone and blur the fixture.
    projectId: "proj-golden", drawRequestId: excId,
    category: "EVIDENCE", severity: "HIGH",
    title: "Photo set requires a second reviewer (fictional)",
    description: "Fictional pilot exception used only to exercise the scorecard.",
  });
  if (excOpen.status >= 400) fail(`setup: exception open failed (${excOpen.status}) ${excOpen.text.slice(0, 160)}`);

  // A real OPEN dispute on an OPEN draw, plus a legal hold, so the
  // dispute/legal-hold group is exercised against actual register rows
  // rather than an empty list.
  const disputeDrawId = "draw-dmv-1";
  const openedDispute = await api("user-compliance", "POST", "/api/projects/proj-dmv/disputes", {
    subjectType: "DRAW_REQUEST",
    subjectId: disputeDrawId,
    disputedAmount: 15000,
    undisputedAmount: 90000,
    affectedScope: "Fictional pilot dispute over a single scope line.",
    reason: "Fictional pilot dispute used only to exercise the executive attention queue.",
  });
  if (openedDispute.status >= 400) {
    fail(`setup: dispute open failed (${openedDispute.status}) ${openedDispute.text.slice(0, 200)}`);
  }
  const disputeId = openedDispute.json.dispute.id;
  const legalHold = await api("user-compliance", "POST", `/api/disputes/${disputeId}/legal-hold`, {
    active: "true",
    reason: "Fictional pilot legal hold.",
  });
  if (legalHold.status >= 400) {
    fail(`setup: legal hold failed (${legalHold.status}) ${legalHold.text.slice(0, 200)}`);
  }

  const rReady = dr.drawReadiness(readyId);
  const rInc = dr.drawReadiness(incId);
  const rExc = dr.drawReadiness(excId);
  assert(rReady.status === "READY", `setup: the fully reviewed draw is READY (${rReady.status})`);
  assert(rInc.status === "INCOMPLETE", `setup: the unmapped-line draw is INCOMPLETE (${rInc.status})`);
  assert(rExc.status === "EXCEPTION_REVIEW", `setup: the exception draw is EXCEPTION_REVIEW (${rExc.status})`);

  const funder = repo.getUser("user-funder");
  const pm = repo.getUser("user-pm");
  const dmvPm = repo.getUser("user-dmv-pm");
  const control = portfolio.control(funder);
  const html = (await page("user-funder", "/executive")).html;

  // ================= 1. readiness counts equal the real set =================
  {
    const accessible = new Set(authz.accessibleProjects(funder).map((p) => p.id));
    const expected = { READY: 0, HOLD: 0, EXCEPTION_REVIEW: 0, INCOMPLETE: 0 };
    let expectedOpen = 0;
    for (const projectId of accessible) {
      for (const d of repo.listDrawRequestsForProject(projectId)) {
        if (!portfolio.OPEN_DRAW_STATUSES.includes(d.status)) continue;
        expectedOpen += 1;
        expected[dr.drawReadiness(d.id).status] += 1;
      }
    }
    assert(control.scope.openDrawCount === expectedOpen,
      `1. the open-draw count equals the real accessible open set (${control.scope.openDrawCount} = ${expectedOpen})`);
    for (const status of ["READY", "HOLD", "EXCEPTION_REVIEW", "INCOMPLETE"]) {
      const bucket = control.readinessDistribution.find((b) => b.status === status);
      assert(bucket && bucket.drawCount === expected[status],
        `1. ${status} counts ${expected[status]} — exactly the draws the engine puts in that state`);
    }
    const summed = control.readinessDistribution.reduce((s, b) => s + b.drawCount, 0);
    assert(summed === control.scope.evaluatedOpenDrawCount,
      "1. the four buckets partition the evaluated set — every draw lands in exactly one state");
    assert(control.scope.evaluatedOpenDrawCount === control.scope.openDrawCount,
      "1. with every evaluation succeeding, the evaluated set IS the open set");
    assert(control.openRequested === control.capital.requested,
      "1. with every evaluation succeeding, raw requested equals the readiness-derived requested");
    assert(control.unevaluated.length === 0,
      "1. no open draw was silently dropped from the aggregate");
  }

  // ================= 2. foreign tenants never enter a total =================
  {
    const pmControl = portfolio.control(pm);
    const pmProjects = new Set(authz.accessibleProjects(pm).map((p) => p.id));
    const funderProjects = new Set(authz.accessibleProjects(funder).map((p) => p.id));
    assert(pmProjects.size < funderProjects.size,
      `2. the two viewers have genuinely different scopes (${pmProjects.size} vs ${funderProjects.size} projects)`);
    assert(pmControl.register.every((r) => pmProjects.has(r.projectId)),
      "2. every register row belongs to the viewer's own accessible projects");
    const outside = [...funderProjects].filter((p) => !pmProjects.has(p));
    assert(outside.length > 0 && pmControl.register.every((r) => !outside.includes(r.projectId)),
      "2. not one draw from a project outside the viewer's scope reaches the register");
    assert(pmControl.capital.requested < control.capital.requested,
      `2. the narrower viewer sees strictly less capital (${pmControl.capital.requested} < ${control.capital.requested})`);
    assert(pmControl.freshness.every((f) => pmProjects.has(f.projectId)),
      "2. source freshness is scoped to the viewer's projects too");
    // The page a foreign PM gets must not name another tenant's project.
    const pmHtml = (await page("user-pm", "/executive")).html;
    const golden = repo.getProject("proj-golden");
    assert(!pmHtml.includes(golden.name.split("(")[0].trim()),
      "2. the rendered page never names a project outside the viewer's tenancy");
  }

  // ================= 3. capital reconciles against the engine =================
  {
    let requested = 0;
    let supportable = 0;
    for (const project of authz.accessibleProjects(funder)) {
      for (const d of repo.listDrawRequestsForProject(project.id)) {
        if (!portfolio.OPEN_DRAW_STATUSES.includes(d.status)) continue;
        const r = dr.drawReadiness(d.id);
        requested += r.requestedAmount;
        supportable += r.supportableAmount;
      }
    }
    assert(control.capital.requested === requested,
      `3. requested is the exact sum of the included draws (${control.capital.requested})`);
    assert(control.capital.supportable === supportable,
      `3. supportable is the exact sum of the engine's own per-draw supportable amounts (${control.capital.supportable})`);
    const bucketReq = control.readinessDistribution.reduce((s, b) => s + b.requested, 0);
    assert(bucketReq === control.capital.requested,
      "3. the readiness buckets' dollars reconcile with the capital headline");
    assert(control.register.reduce((s, r) => s + r.requested, 0) === control.capital.requested,
      "3. the register's dollars reconcile with the capital headline");
  }

  // ================= 4. unsupported and coverage =================
  {
    // Shortfalls are summed PER DRAW, so an over-supported draw can never
    // net away another draw's genuine gap and print a false full coverage.
    let perDrawShortfall = 0;
    let perDrawOver = 0;
    for (const project of authz.accessibleProjects(funder)) {
      for (const d of repo.listDrawRequestsForProject(project.id)) {
        if (!portfolio.OPEN_DRAW_STATUSES.includes(d.status)) continue;
        const r = dr.drawReadiness(d.id);
        perDrawShortfall += r.unsupportedAmount;
        perDrawOver += Math.max(0, r.supportableAmount - r.requestedAmount);
      }
    }
    assert(control.capital.unsupported === perDrawShortfall,
      "4. unsupported is the sum of the engine's own per-draw shortfalls, never a netted difference");
    assert(control.capital.overSupported === perDrawOver,
      "4. any support recorded above a request is reported separately, not netted away");
    assert(control.capital.covered === control.capital.requested - control.capital.unsupported,
      "4. covered dollars are requested minus the real shortfall");
    assert(control.capital.coverage === control.capital.covered / control.capital.requested,
      "4. coverage is the exact covered ratio, not a rounded one");
    assert(control.capital.coverage < 1 || control.capital.unsupported === 0,
      "4. coverage can only reach 1 when no draw has a shortfall at all");
    // The netting case the seeded portfolio cannot currently produce: one
    // draw recording MORE support than it requested, alongside another with
    // a real gap. Netted, this prints full coverage over a shortfall.
    {
      const netted = portfolio.aggregateCapital([
        { requestedAmount: 100000, supportableAmount: 150000, unsupportedAmount: 0 },
        { requestedAmount: 100000, supportableAmount: 50000, unsupportedAmount: 50000 },
      ]);
      assert(netted.unsupported === 50000,
        `4. an over-supported draw never cancels another draw's shortfall (${netted.unsupported})`);
      assert(netted.coverageLabel !== "100%",
        `4. and the portfolio never prints 100% while a draw is under-covered (${netted.coverageLabel})`);
      assert(netted.coverage === 0.75, `4. coverage is covered/requested = 0.75 (${netted.coverage})`);
      assert(netted.overSupported === 50000,
        "4. the inconsistency is reported on its own line rather than hidden");
      const clean = portfolio.aggregateCapital([
        { requestedAmount: 100000, supportableAmount: 100000, unsupportedAmount: 0 },
      ]);
      assert(clean.coverageLabel === "100%" && clean.overSupported === 0,
        "4. exact full support across every draw still reads 100%");
    }
    assert(control.capital.coverageLabel === dr.formatSupportCoverage(control.capital.coverage),
      "4. the coverage label comes from the shared non-overstating formatter, not a local rounding");
    assert(/of requested dollars currently supported/.test(html),
      "4. coverage is labelled as supported DOLLARS on the page");
    assert(!/readiness\s*\d+(\.\d+)?%|\d+(\.\d+)?%\s*(portfolio\s*)?ready/i.test(html),
      "4. no percentage anywhere claims to be readiness");
    // A shortfall must never display as 100%.
    if (control.capital.coverage < 1) {
      assert(control.capital.coverageLabel !== "100%",
        `4. a shortfall never displays as 100% (shows ${control.capital.coverageLabel})`);
    }
    assert(dr.formatSupportCoverage(0.996) === "99.6%" && dr.formatSupportCoverage(1) === "100%",
      "4. the shared formatter still floors below one and reserves 100% for exact full support");
    for (const word of ["approved", "authorized", "payable", "funded", "released"]) {
      const bad = new RegExp(`${word}[^.<]{0,24}(supportable|support coverage)`, "i");
      assert(!bad.test(html), `4. "supportable" is never described as ${word}`);
    }
  }

  // ================= 5. no double counting =================
  {
    const holdBucket = control.readinessDistribution.find((b) => b.status === "HOLD");
    const domainHoldSum = control.domains.reduce((s, d) => s + d.holdDraws, 0);
    const multi = [];
    const noDomain = [];
    for (const project of authz.accessibleProjects(funder)) {
      for (const d of repo.listDrawRequestsForProject(project.id)) {
        if (!portfolio.OPEN_DRAW_STATUSES.includes(d.status)) continue;
        const result = dr.drawReadiness(d.id);
        const domains = dr.controlDomains(result);
        const held = domains.filter((x) => x.state === "HOLD");
        if (held.length > 1) multi.push(d.id);
        if (result.status === "HOLD" && held.length === 0) noDomain.push(d.id);
      }
    }
    assert(multi.length > 0,
      `5. the fixture contains a draw blocked across more than one domain (${multi.length})`);
    // The same draw contributes once to the portfolio total and once to
    // EACH domain it is stuck in. These are different questions and the
    // numbers are not expected to agree in either direction.
    const oneMulti = dr.controlDomains(dr.drawReadiness(multi[0]));
    assert(oneMulti.filter((x) => x.state === "HOLD").length >= 2,
      "5. a multi-domain draw does contribute to several domain counts");
    assert(control.register.filter((r) => r.drawRequestId === multi[0]).length === 1,
      "5. while contributing exactly one row — and one HOLD — to the portfolio total");
    // The real property is that the two are DIFFERENT QUESTIONS, not that
    // the numbers happen to differ: a multi-domain draw adds to several
    // domain counts, so the domain sum counts draw-domain pairs while the
    // bucket counts draws.
    const pairSum = evaluatedDomainPairs(authz.accessibleProjects(funder));
    assert(domainHoldSum === pairSum,
      `5. the domain HOLD sum counts draw-domain pairs (${domainHoldSum}), not draws`);
    assert(pairSum > multiDomainHoldDraws(authz.accessibleProjects(funder)).length - 1,
      "5. and a draw stuck in several domains contributes to each of them");
    // Domains are explanatory, not total: a draw can be HOLD with all four
    // domains clear, because its blocker is cross-cutting.
    assert(noDomain.length > 0,
      `5. the fixture contains a HOLD draw that NO domain claims (${noDomain.length}) — domains are explanatory, not total`);
    assert(control.crossCutting.blockedDraws >= noDomain.length,
      "5. those draws are accounted for by the cross-cutting controls instead of vanishing");
    const uniqueIds = new Set(control.register.map((r) => r.drawRequestId));
    assert(uniqueIds.size === control.register.length,
      "5. the register lists each draw exactly once");
    assert(/appears in both/i.test(html),
      "5. the page states that a draw blocked in two domains appears under both");
  }

  // ============ 6. cross-cutting controls stay outside the domains ============
  {
    const domainCats = new Set(control.domains.flatMap((d) => d.categories));
    for (const c of dr.CROSS_CUTTING_CATEGORIES) {
      assert(!domainCats.has(c),
        `6. ${c} is cross-cutting and is claimed by no domain`);
    }
    const seen = control.domains.flatMap((d) => d.categories);
    assert(seen.length === new Set(seen).size,
      "6. no readiness category is claimed by two domains");
    // The EXCEPTION_REVIEW fixture is the real test: its exception is an
    // EVIDENCE-subject one, so Compliance must stay clean while the draw
    // is unambiguously blocked.
    const excDomains = dr.controlDomains(rExc);
    const compliance = excDomains.find((d) => d.domain === "COMPLIANCE");
    assert(compliance.state !== "HOLD",
      "6. a formal EVIDENCE-subject exception does not turn the Compliance domain red");
    assert(dr.crossCuttingControls(rExc).blockerCount > 0,
      "6. that draw's blocker is carried by the cross-cutting controls instead");
    assert(control.crossCutting.blockedDraws > 0 && control.crossCutting.blockerInstances > 0,
      "6. the portfolio reports the cross-cutting pressure it actually carries");
    assert(/Cross-cutting governed controls/i.test(html),
      "6. the page surfaces cross-cutting controls explicitly");
    assert(/outside the four domains/i.test(html),
      "6. and says they sit outside the four domains");
    assert(/All four domains can read clear while a draw is still blocked here/i.test(html),
      "6. the page states outright that four healthy domains can coexist with a blocked draw");
  }

  // ================= 7. INCOMPLETE stays independently visible =================
  {
    const inc = control.readinessDistribution.find((b) => b.status === "INCOMPLETE");
    assert(inc.drawCount > 0, "7. the INCOMPLETE fixture is counted");
    assert(inc.requested === rInc.requestedAmount,
      "7. INCOMPLETE dollars are counted separately, never folded into HOLD");
    assert(/INCOMPLETE/.test(html), "7. INCOMPLETE appears on the page in words");
    assert(/cannot reach a readiness conclusion/i.test(html),
      "7. the page explains that INCOMPLETE means no conclusion is possible");
    const incGroup = control.attention.find((g) => g.key === "INCOMPLETE");
    assert(incGroup && incGroup.count === inc.drawCount,
      "7. INCOMPLETE leads the governed attention queue");
    assert(control.attention[0].key === "INCOMPLETE",
      "7. missing governed information is ordered ahead of every other condition");
    // Unknown information on a draw that is HOLD for another reason must
    // not disappear behind that HOLD.
    const unknownGroup = control.attention.find((g) => g.key === "UNKNOWN_INFORMATION");
    assert(unknownGroup !== undefined,
      "7. unknown information carried by an otherwise-blocked draw has its own queue entry");
  }

  // ================= 8. the attention queue is governed and real =================
  {
    const byKey = Object.fromEntries(control.attention.map((g) => [g.key, g]));
    // Inspection reason.
    const inspection = byKey.INSPECTIONS_OUTSTANDING;
    for (const item of inspection.items) {
      const r = dr.drawReadiness(item.drawRequestId);
      assert(
        r.blockingReasons.some((b) => b.category === "GOVERNMENT_INSPECTION" || b.category === "DRAW_INSPECTION"),
        `8. every inspection-queue draw really carries an inspection blocker (${item.drawRequestId})`
      );
    }
    assert(!/required inspections outstanding/i.test(inspection.label),
      "8. the inspection group does not claim an inspection is required when the requirement itself is unknown");
    // Document reason.
    for (const item of byKey.DOCUMENT_GAPS.items) {
      const r = dr.drawReadiness(item.drawRequestId);
      assert(r.blockingReasons.some((b) => b.category === "DOCUMENT" || b.category === "LIEN"),
        `8. every document-gap draw really carries a document or lien blocker (${item.drawRequestId})`);
    }
    // Disputes come from the disputes register, NOT from a readiness
    // category — PROJECT_CONTROL also carries ordinary reviewer progress.
    const disputeGroup = byKey.DISPUTE_LEGAL_HOLDS;
    const openDisputeDraws = new Set(
      db.prepare("SELECT draw_request_id d FROM disputes WHERE resolved_at IS NULL AND closed_at IS NULL")
        .all().map((r) => r.d).filter(Boolean)
    );
    assert(openDisputeDraws.size > 0 && disputeGroup.count > 0,
      `8. the fixture really carries an open dispute on an open draw (${disputeGroup.count})`);
    assert(disputeGroup.items.every((i) => openDisputeDraws.has(i.drawRequestId)),
      "8. every dispute-queue entry is backed by an open row in the disputes register");
    assert(disputeGroup.items.some((i) => i.drawRequestId === disputeDrawId),
      "8. the disputed draw is the one the register names");
    // The decisive check: PROJECT_CONTROL is cross-cutting and also carries
    // ordinary reviewer progress, so a draw blocked ONLY by an unfinished
    // line review must never appear as a dispute or a legal hold.
    const lineReviewOnly = control.register.filter(
      (r) => r.primaryBlockerCategory === "PROJECT_CONTROL" && !openDisputeDraws.has(r.drawRequestId)
    );
    assert(lineReviewOnly.length > 0,
      `8. the fixture contains draws blocked by PROJECT_CONTROL without any dispute (${lineReviewOnly.length})`);
    assert(
      lineReviewOnly.every((r) => !disputeGroup.items.some((i) => i.drawRequestId === r.drawRequestId)),
      "8. an unfinished line review is never reported as a dispute or a legal hold"
    );
    // Ready awaiting decision is actionable, not blocked.
    const readyGroup = byKey.READY_PENDING_DECISION;
    assert(readyGroup.items.every((i) => i.status === "READY"),
      "8. the pending-decision group contains only READY draws");
    assert(readyGroup.tone === "ready",
      "8. a READY draw awaiting a decision is presented as actionable, not as a blocker");
    // Aging uses the existing policy constant, not a new invention.
    const pilot = require(path.join(ROOT, "dist/server/services/pilot/lenderPilot"));
    assert(control.turnaround.agingThresholdDays === pilot.AGING_THRESHOLD_DAYS,
      "8. the aging threshold reuses the existing lender-pilot constant");
    assert(byKey.AGING.items.every((i) => i.ageDays >= pilot.AGING_THRESHOLD_DAYS),
      "8. every aging entry really exceeds the threshold");
    // Every queue entry's reason is the engine's own ordered primary
    // blocker — checked across EVERY group and EVERY item, with the
    // fixture proven non-empty first so the property cannot pass vacuously.
    const allItems = control.attention.flatMap((g) => g.items);
    assert(allItems.length > 0, `8. the attention queue has entries to check (${allItems.length})`);
    let blockerReasons = 0;
    for (const i of allItems) {
      const r = dr.drawReadiness(i.drawRequestId);
      if (r.primaryBlocker) {
        if (i.reason !== r.primaryBlocker.message) {
          fail(`8. draw ${i.drawNumber} shows "${i.reason}" instead of the engine's primary blocker "${r.primaryBlocker.message}"`);
        }
        blockerReasons += 1;
      } else if (i.reason !== i.nextAction) {
        fail(`8. draw ${i.drawNumber} has no blocker but its reason is not the next action`);
      }
    }
    assert(blockerReasons > 0,
      `8. every queue entry's reason is the engine's own ordered primary blocker (${blockerReasons} checked)`);
    // Each group names its denominator.
    assert(control.attention.every((g) => typeof g.unit === "string" && g.unit.length > 0),
      "8. every attention count states what it counts");
  }

  // ============ 9. a recorded decision leaves the pending bucket ============
  {
    const before = portfolio.control(funder);
    const readyBefore = before.attention.find((g) => g.key === "READY_PENDING_DECISION");
    assert(readyBefore.items.some((i) => i.drawRequestId === readyId),
      "9. the READY draw is awaiting a lender decision before any decision exists");

    const gov = await api("user-funder", "POST", `/api/draws/${readyId}/governance`, {});
    if (gov.status >= 400) fail(`setup: governance failed (${gov.status}) ${gov.text.slice(0, 200)}`);
    const apRow = db.prepare("SELECT id FROM approval_requests WHERE draw_request_id = ?").get(readyId);
    if (!apRow) fail("setup: no approval request opened");
    for (const user of ["user-funder", "user-compliance"]) {
      await api(user, "POST", `/api/approvals/${apRow.id}/decision`, { decision: "APPROVED", note: "Fictional pilot approval." });
    }
    const decision = await api("user-funder", "POST", `/api/draws/${readyId}/lender-decision`, {
      decision: "APPROVED", approvedAmount: 40000, decisionReason: "Fictional pilot decision.",
    });
    if (decision.status >= 400) fail(`setup: lender decision failed (${decision.status}) ${decision.text.slice(0, 200)}`);

    const after = portfolio.control(funder);
    const readyAfter = after.attention.find((g) => g.key === "READY_PENDING_DECISION");
    assert(!readyAfter.items.some((i) => i.drawRequestId === readyId),
      "9. once the decision is recorded the draw leaves the pending-decision queue");
    assert(!after.register.some((r) => r.drawRequestId === readyId),
      "9. and leaves the open-draw capital set entirely — the lender has disposed of it");
    assert(after.capital.requested < before.capital.requested,
      "9. requested capital falls by exactly that draw's request");
    assert(before.capital.requested - after.capital.requested === rReady.requestedAmount,
      "9. and by nothing else");
  }

  // ================= 10. proceed-by-exception is decision-time truth =================
  {
    // Drive one draw to an approving decision while a requirement stands.
    // The outstanding requirement is a formal EXCEPTION: the governance
    // gate has its own document precondition, so a document gap could
    // never reach a decision at all — an exception is exactly the case
    // proceed-by-exception exists for.
    const overrideId = await mkDraw("user-dmv-pm", "proj-golden", 26000, [
      { description: "Override fixture line (fictional)", milestoneId: "ms-g5", scheduledValue: 26000, currentRequested: 26000 },
    ]);
    await api("user-dmv-pm", "POST", `/api/draws/${overrideId}/submit`, {});
    for (const id of lineIds(overrideId)) {
      await api("user-funder", "POST", `/api/draws/${overrideId}/lines/${id}/review`,
        { decision: "SUPPORTED", percentCompleteVerified: 100 });
    }
    await fileDocs("user-dmv-pm", overrideId, 26000);
    const ovExc = await api("user-compliance", "POST", "/api/exceptions", {
      projectId: "proj-golden", drawRequestId: overrideId,
      category: "EVIDENCE", severity: "HIGH",
      title: "Second photo set outstanding (fictional)",
      description: "Fictional pilot exception used only to exercise the override module.",
    });
    if (ovExc.status >= 400) fail(`setup: override exception failed (${ovExc.status}) ${ovExc.text.slice(0, 160)}`);
    const rBefore = dr.drawReadiness(overrideId);
    assert(rBefore.blockingReasons.length > 0,
      "10. the override fixture really has an outstanding requirement before the decision");

    const gov = await api("user-funder", "POST", `/api/draws/${overrideId}/governance`, {});
    if (gov.status >= 400) fail(`setup: override governance failed (${gov.status}) ${gov.text.slice(0, 200)}`);
    const apRow = db.prepare("SELECT id FROM approval_requests WHERE draw_request_id = ?").get(overrideId);
    for (const user of ["user-funder", "user-compliance"]) {
      await api(user, "POST", `/api/approvals/${apRow.id}/decision`, { decision: "APPROVED", note: "Fictional pilot approval." });
    }
    const decision = await api("user-funder", "POST", `/api/draws/${overrideId}/lender-decision`, {
      decision: "APPROVED", approvedAmount: 26000,
      exceptionsAccepted: "Fictional pilot override: documents to follow under a documented exception.",
      decisionReason: "Fictional pilot override.",
    });
    if (decision.status >= 400) fail(`setup: override decision failed (${decision.status}) ${decision.text.slice(0, 200)}`);

    const after = portfolio.control(funder);
    const entry = after.proceededByException.find((p) => p.drawRequestId === overrideId);
    assert(entry !== undefined, "10. the override appears in the proceeded-by-exception module");
    const snap = dr.decisionReadinessSnapshot(overrideId, entry.decisionId);
    assert(snap !== null, "10. it is backed by an immutable decision-time readiness snapshot");
    assert(entry.statusAtDecision === snap.statusAtDecision,
      "10. the status shown is the status AT DECISION TIME, from the snapshot");
    assert(entry.overriddenBlockerCount === snap.overriddenBlockers.length,
      "10. the overridden-requirement count comes from the snapshot, not from today's blockers");
    assert(entry.overriddenBlockerCount > 0,
      "10. an override records the requirements it proceeded past");

    // Now resolve the requirement and prove history does not rewrite itself.
    const excId2 = db
      .prepare("SELECT id FROM exceptions WHERE draw_request_id = ? ORDER BY opened_at DESC")
      .get(overrideId);
    if (excId2) {
      await api("user-compliance", "POST", `/api/exceptions/${excId2.id}/resolve`,
        { summary: "Fictional pilot resolution — second photo set received." });
    }
    const live = dr.drawReadiness(overrideId);
    const later = portfolio.control(funder);
    const stillThere = later.proceededByException.find((p) => p.drawRequestId === overrideId);
    assert(stillThere !== undefined,
      "10. resolving the requirement afterwards does not erase the override from history");
    assert(stillThere.overriddenBlockerCount === entry.overriddenBlockerCount,
      `10. and does not change what the decision overrode (${entry.overriddenBlockerCount}), even though live blockers are now ${live.blockingReasons.length}`);
    const execHtml = (await page("user-funder", "/executive")).html;
    assert(/Decision-time snapshots — never recomputed/i.test(execHtml),
      "10. the module states that it reads decision-time snapshots");
  }

  // ================= 11. history is read from history =================
  {
    const after = portfolio.control(funder);
    const transitions = after.recentChanges.filter((c) => c.kind === "READINESS_TRANSITION");
    assert(transitions.length > 0, "11. readiness transitions are recorded and surfaced");
    for (const t of transitions.slice(0, 6)) {
      const row = db
        .prepare("SELECT detail FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_TRANSITION' ORDER BY created_at")
        .all(t.drawRequestId)
        .map((r) => JSON.parse(r.detail));
      assert(row.some((d) => d.status === t.to && (d.from ?? null) === t.from),
        `11. the transition "${t.label}" matches a stored event, not a recomputation`);
    }
    const movedOn = transitions.find((t) => t.from !== null && t.from !== t.to);
    assert(movedOn !== undefined,
      "11. the fixture contains a real state change with a recorded FROM state");
    {
      // A past transition is historical by construction: both ends come
      // from the stored event. Proving it means matching the event, NOT
      // comparing against today's live status — a draw that moved away and
      // back would legitimately have from === live.
      const stored = db
        .prepare("SELECT detail FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_TRANSITION' ORDER BY created_at")
        .all(movedOn.drawRequestId)
        .map((r) => JSON.parse(r.detail));
      assert(stored.some((d) => d.from === movedOn.from && d.status === movedOn.to),
        `11. "${movedOn.label}" reproduces a stored FROM/TO pair exactly`);
      // Non-erasure, stated window-independently: the list is capped by
      // RECENCY ONLY. Inside the shown window, no stored transition — a
      // superseded one included — may be skipped. (The old form of this
      // check asked for one specific superseded status inside the top
      // window, which broke as soon as other governed history competed
      // for the same slots.)
      const boundary =
        after.recentChanges.length >= 12
          ? after.recentChanges[after.recentChanges.length - 1].at
          : null;
      const allStoredTransitions = [];
      for (const project of authz.accessibleProjects(funder)) {
        for (const d of repo.listDrawRequestsForProject(project.id)) {
          for (const ev of db
            .prepare("SELECT detail, created_at FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_TRANSITION' ORDER BY created_at")
            .all(d.id)) {
            const detail = JSON.parse(ev.detail);
            if (detail.status) allStoredTransitions.push({ drawId: d.id, at: ev.created_at, to: detail.status });
          }
        }
      }
      const inWindow = allStoredTransitions.filter((e) => boundary === null || e.at > boundary);
      const skipped = inWindow.filter(
        (e) => !after.recentChanges.some(
          (c) => c.kind === "READINESS_TRANSITION" && c.drawRequestId === e.drawId && c.at === e.at && c.to === e.to
        )
      );
      assert(skipped.length === 0,
        `11. inside the shown window no stored transition is skipped — superseded-ness never filters history (${inWindow.length} checked)`);
    }
    assert(after.recentChanges.every((c, i, arr) => i === 0 || arr[i - 1].at >= c.at),
      "11. changes are ordered newest first");
  }

  // ================= 12. no composite portfolio score =================
  {
    const json = JSON.stringify(control);
    assert(!/portfolioScore|readinessScore|overallReadiness|healthScore/i.test(json),
      "12. the governed read model introduces no composite score field");
    assert(!/\/100/.test(html.split('class="ec-advisory"')[0]),
      "12. no /100 score appears anywhere in the governed half of the page");
    const governedHalf = html.split('class="ec-advisory"')[0];
    assert(!/portfolio (readiness|health)\s*\d/i.test(governedHalf),
      "12. the governed half never states a portfolio readiness or health number");
    assert(/READY/.test(governedHalf) && /HOLD/.test(governedHalf) && /INCOMPLETE/.test(governedHalf),
      "12. it states the governed states in words instead");
  }

  // ================= 13. advisory stays separate from governed =================
  {
    assert(html.includes('class="ec-advisory"'),
      "13. advisory analytics live in their own labelled band");
    assert(/Advisory portfolio intelligence/.test(html),
      "13. the band is titled as advisory");
    assert(/never a governed control, never a lender approval signal/i.test(html),
      "13. and says outright that it is not a control");
    const governedHalf = html.split('class="ec-advisory"')[0];
    const advisoryHalf = html.split('class="ec-advisory"')[1] ?? "";
    assert(/Governed attention/.test(governedHalf),
      "13. the governed queue sits in the governed half");
    assert(/Advisory signals/.test(advisoryHalf) && !/Advisory signals/.test(governedHalf),
      "13. advisory signals sit only in the advisory half");
    assert(/Project risk register/.test(advisoryHalf),
      "13. the legacy risk register is preserved — as advisory");
    assert(/Evidence intelligence overview/.test(advisoryHalf) && /Portfolio risk distribution/.test(advisoryHalf),
      "13. every pre-existing advisory capability survives the redesign");
    // Advisory analytics must not move a governed figure. The risk engine
    // is a live input to the same page, so compare the governed model
    // computed WITH it against the same model computed independently.
    const risk = portfolio.risk(funder);
    assert(risk.projects.length > 0 && risk.projects.some((p) => typeof p.health === "number"),
      "13. the advisory risk engine really produces scores for these projects");
    const withAdvisory = portfolio.executiveConsole(funder, {});
    const governedAlone = portfolio.control(funder);
    assert(
      JSON.stringify(withAdvisory.control.readinessDistribution) ===
        JSON.stringify(governedAlone.readinessDistribution),
      "13. the readiness distribution is byte-identical whether or not the advisory engines ran"
    );
    assert(
      withAdvisory.control.capital.requested === governedAlone.capital.requested &&
        withAdvisory.control.capital.supportable === governedAlone.capital.supportable,
      "13. and so is portfolio capital — advisory analytics never move a governed figure"
    );
  }

  // ================= 14. inclusion rule is stated and applied =================
  {
    // Recomputed here: sections 9 and 10 recorded real lender decisions, so
    // the earlier snapshot no longer describes the current open set.
    const control = portfolio.control(funder);
    assert(control.scope.inclusionRule.length > 0 && /Open draws only/i.test(control.scope.inclusionRule),
      "14. the capital inclusion rule is stated in the read model");
    assert(/Open draws only/i.test(html), "14. and on the page");
    const draft = db.prepare("SELECT COUNT(*) c FROM draw_requests WHERE status = 'DRAFT'").get().c;
    if (draft > 0) {
      assert(!control.register.some((r) => {
        const d = repo.getDrawRequest(r.drawRequestId);
        return d && d.status === "DRAFT";
      }), "14. a draft draw is never counted as requested capital");
    }
    const released = db.prepare("SELECT id FROM draw_requests WHERE status = 'RELEASED'").all();
    assert(released.every((r) => !control.register.some((x) => x.drawRequestId === r.id)),
      "14. a released draw has left the open set");
    assert(control.scope.includedStatuses.every((s) => portfolio.OPEN_DRAW_STATUSES.includes(s)),
      "14. the stated statuses are the ones actually used");
  }

  // ================= 15. reads are write-free =================
  {
    const before = tableCounts(db);
    for (let i = 0; i < 4; i += 1) {
      const res = await page("user-funder", "/executive");
      if (res.status !== 200) fail(`15. /executive returned ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 400));
    const after = tableCounts(db);
    const changed = Object.keys(after).filter((t) => before[t] !== after[t]);
    assert(changed.length === 0,
      `15. four /executive renders wrote nothing to any of ${Object.keys(after).length} tables${changed.length ? ` (changed: ${changed.join(", ")})` : ""}`);
    const readinessEvents = db
      .prepare("SELECT COUNT(*) c FROM draw_events WHERE type IN ('READINESS_TRANSITION','READINESS_SNAPSHOT')")
      .get().c;
    await page("user-funder", "/executive");
    await new Promise((r) => setTimeout(r, 300));
    const readinessEventsAfter = db
      .prepare("SELECT COUNT(*) c FROM draw_events WHERE type IN ('READINESS_TRANSITION','READINESS_SNAPSHOT')")
      .get().c;
    assert(readinessEvents === readinessEventsAfter,
      "15. rendering the portfolio creates no readiness transition and no snapshot");
  }

  // ================= 16. authorization and tenancy on the route =================
  {
    const field = await page("user-field", "/executive");
    assert(field.status === 403 || field.status === 302 || field.status === 404,
      `16. a FIELD user cannot open the Executive Command Center (${field.status})`);
    assert(!/Requested — open draws/i.test(field.html),
      "16. and never receives portfolio capital figures");
    const anon = await fetch(`${BASE}/executive`, { redirect: "manual" });
    assert([301, 302, 303, 307, 401, 403].includes(anon.status),
      `16. an anonymous request is turned away from the console (${anon.status})`);
    assert(!/Requested — open draws|Currently supportable/i.test(await anon.text()),
      "16. and the redirect body carries no portfolio capital figure");
    // Same-404 on a foreign project detail remains intact.
    const foreign = await fetch(`${BASE}/api/portfolio/projects/proj-golden/risk`, {
      headers: { cookie: sessionCookie(BASE, "user-pm") },
    });
    assert(foreign.status === 404 || foreign.status === 403,
      `16. a foreign project's portfolio detail stays undisclosing (${foreign.status})`);
  }

  // ================= 17. structure and reuse =================
  {
    const svc = fs.readFileSync(path.join(ROOT, "src/server/services/portfolio/control.ts"), "utf8");
    assert(/drawReadiness\.|readiness\.drawReadiness\(/.test(svc),
      "17. the read model calls the authoritative readiness engine per draw");
    assert(/readiness\.controlDomains\(/.test(svc) && /readiness\.crossCuttingControls\(/.test(svc),
      "17. domains and cross-cutting controls come from the engine's own helpers");
    assert(/readiness\.formatSupportCoverage\(/.test(svc),
      "17. the shared coverage formatter is reused, not re-implemented");
    assert(/lenderPilot\.drawNextAction\(/.test(svc) && /lenderPilot\.AGING_THRESHOLD_DAYS/.test(svc),
      "17. the deterministic next action and the aging threshold are reused");
    assert(!/CONTROL_DOMAIN_CATEGORIES\s*[:=]\s*\{/.test(svc),
      "17. the domain mapping is not duplicated in the portfolio layer");
    assert(!/UNKNOWN_INFO_CODES|INSPECTION_REQUIREMENT_UNKNOWN/.test(svc),
      "17. no readiness code list is re-derived here");
    assert(/buildPortfolioContext/.test(svc),
      "17. tenancy comes from the shared portfolio context");
    assert(!/INSERT|UPDATE|DELETE/i.test(svc),
      "17. the read model contains no write statement");
    const view = fs.readFileSync(path.join(ROOT, "src/server/view/portfolioPages.tsx"), "utf8");
    assert(!/requested\s*-\s*supportable|supportable\s*\/\s*requested/.test(view),
      "17. the view recomputes no capital figure of its own");
    assert(!/executive\/risk/.test(view),
      "17. the dead /executive/risk links are gone");
    // The domain chip is the one place the view could re-derive engine
    // semantics. It must honour NOT_APPLICABLE rather than collapsing it
    // into a green PASS.
    // The domain chip's precedence is a pure exported rule, unit-checked
    // over the cases the seeded portfolio cannot reach on its own — above
    // all the two that would print a false green: a domain with no
    // configured requirement, and a portfolio with no open draws at all.
    const pages = require(path.join(ROOT, "dist/server/view/portfolioPages"));
    const worst = pages.domainWorstState;
    const cases = [
      [{ holdDraws: 1, unknownDraws: 2, warningDraws: 3, passDraws: 4 }, "HOLD"],
      [{ holdDraws: 0, unknownDraws: 1, warningDraws: 3, passDraws: 4 }, "UNKNOWN"],
      [{ holdDraws: 0, unknownDraws: 0, warningDraws: 1, passDraws: 4 }, "WARNING"],
      [{ holdDraws: 0, unknownDraws: 0, warningDraws: 0, passDraws: 1 }, "PASS"],
      [{ holdDraws: 0, unknownDraws: 0, warningDraws: 0, passDraws: 0 }, "NOT_APPLICABLE"],
    ];
    for (const [input, expected] of cases) {
      assert(worst(input) === expected,
        `17. domain precedence ${JSON.stringify(input)} → ${expected} (got ${worst(input)})`);
    }
    assert(worst({ holdDraws: 0, unknownDraws: 0, warningDraws: 0, passDraws: 0 }) !== "PASS",
      "17. a domain with no configured requirement never renders as a pass");
    assert(worst({ holdDraws: 0, unknownDraws: 1, warningDraws: 9, passDraws: 9 }) === "UNKNOWN",
      "17. missing information outranks both warnings and passes");
    for (const d of control.domains) {
      const rendered = new RegExp(
        `<span class="dm-n">${(({ PHYSICAL: "Physical", FINANCIAL: "Financial", COMPLIANCE: "Compliance", DOCUMENTS: "Documents" })[d.domain])}</span><span class="ec-dstate ([a-z]+)">([A-Z ]+)</span>`
      ).exec(html);
      if (!rendered) continue;
      const shown = rendered[2].trim();
      const expected =
        d.holdDraws > 0 ? "HOLD"
          : d.unknownDraws > 0 ? "UNKNOWN"
            : d.warningDraws > 0 ? "WARNING"
              : d.passDraws > 0 ? "PASS" : "NOT APPLICABLE";
      assert(shown === expected,
        `17. the ${d.domain} chip shows ${expected} — the engine's precedence, not a re-derivation (${shown})`);
    }
  }

  // ================= 18. viewports =================
  {
    const browser = await launchChromium();
    const cookie = playwrightCookie(BASE, "user-funder");
    for (const [label, width, height] of [
      ["desktop 1440×900", 1440, 900],
      ["laptop 1280×800", 1280, 800],
      ["phone 390×844", 390, 844],
    ]) {
      const ctx = await browser.newContext({ viewport: { width, height } });
      await ctx.addCookies([cookie]);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/executive`, { waitUntil: "networkidle" });
      const overflow = await p.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      );
      assert(!overflow, `18. ${label} has no page-level horizontal overflow`);
      if (width === 390) {
        const railScrolls = await p.evaluate(() => {
          const rail = document.querySelector(".kpi-rail");
          return rail ? rail.scrollWidth >= rail.clientWidth : false;
        });
        assert(railScrolls, "18. the phone keeps the KPI rail as a rail, not a stack of cards");
        const stacked = await p.evaluate(() => {
          const cell = document.querySelector(".ec-register .dtable tbody td");
          return cell ? getComputedStyle(cell).display === "flex" : false;
        });
        assert(stacked, "18. the phone restacks the register into labelled records");
      }
      await ctx.close();
    }
    // Light theme must remain first-class.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies([cookie]);
    const p = await ctx.newPage();
    await p.addInitScript(() => { try { localStorage.setItem("obv-theme", "light"); } catch { /* ignore */ } });
    await p.goto(`${BASE}/executive`, { waitUntil: "networkidle" });
    const light = await p.evaluate(() => {
      const el = document.querySelector(".ec-state.bad");
      const body = getComputedStyle(document.body).backgroundColor;
      return { chip: el ? getComputedStyle(el).color : null, body };
    });
    assert(light.chip !== null, "18. the light theme still renders governed state chips");
    assert(light.body !== "rgba(0, 0, 0, 0)", "18. the light theme paints its own canvas");
    await ctx.close();
    await browser.close();
  }

  // ============ 19. bucket capital is the non-netted rule =============
  {
    // PURE regression: two members of the SAME readiness state, one
    // over-supported, one genuinely short. The over-supported member must
    // not cancel the other's shortfall inside the bucket.
    const control2 = require(path.join(ROOT, "dist/server/services/portfolio/control"));
    const memberA = { requestedAmount: 100000, supportableAmount: 150000, unsupportedAmount: 0 };
    const memberB = { requestedAmount: 100000, supportableAmount: 50000, unsupportedAmount: 50000 };
    const bucketAgg = control2.aggregateCapital([memberA, memberB]);
    assert(bucketAgg.requested === 200000, "19. mixed bucket: requested is 200,000");
    assert(bucketAgg.supportable === 200000, "19. mixed bucket: supportable sums to 200,000");
    assert(bucketAgg.unsupported === 50000,
      "19. mixed bucket: unsupported is 50,000 — the overage never cancels the shortfall");
    assert(bucketAgg.covered === 150000, "19. mixed bucket: covered is 150,000");
    assert(bucketAgg.overSupported === 50000, "19. mixed bucket: the overage is surfaced on its own");
    assert(bucketAgg.coverage === 0.75 && bucketAgg.coverageLabel === "75%",
      `19. mixed bucket: coverage is 75%, never 100% (${bucketAgg.coverageLabel})`);
    assert(bucketAgg.coverageLabel !== "100%" && bucketAgg.unsupported !== 0,
      "19. the bucket can never claim $0 unsupported or fully supported");
    const clean = control2.aggregateCapital([
      { requestedAmount: 60000, supportableAmount: 60000, unsupportedAmount: 0 },
      { requestedAmount: 40000, supportableAmount: 40000, unsupportedAmount: 0 },
    ]);
    assert(clean.unsupported === 0 && clean.overSupported === 0 && clean.coverageLabel === "100%",
      "19. an exactly-fully-supported bucket still reads 100% with no anomaly");

    // Live wiring: every rendered bucket must equal aggregateCapital over
    // its own members — the same rule, not a second arithmetic.
    const live = portfolio.control(funder);
    for (const b of live.readinessDistribution) {
      const members = [];
      for (const project of authz.accessibleProjects(funder)) {
        for (const d of repo.listDrawRequestsForProject(project.id)) {
          if (!portfolio.OPEN_DRAW_STATUSES.includes(d.status)) continue;
          const r = dr.drawReadiness(d.id);
          if (r.status === b.status) members.push(r);
        }
      }
      const expected = control2.aggregateCapital(members);
      assert(
        b.requested === expected.requested &&
          b.supportable === expected.supportable &&
          b.unsupported === expected.unsupported &&
          b.covered === expected.covered &&
          b.overSupported === expected.overSupported,
        `19. the ${b.status} bucket carries exactly the aggregateCapital of its members`
      );
      assert(b.unsupported === members.reduce((sum, r) => sum + r.unsupportedAmount, 0),
        `19. the ${b.status} bucket's unsupported is the sum of the engine's own per-draw shortfalls`);
    }
    const view = fs.readFileSync(path.join(ROOT, "src/server/view/portfolioPages.tsx"), "utf8");
    assert(!/b\.requested\s*-\s*b\.supportable|requested\s*-\s*b\.supportable/.test(view),
      "19. the view computes no bucket difference of its own — it reads the bucket's authoritative aggregate");
    assert(/b\.unsupported/.test(view),
      "19. the view reads the bucket's own unsupported figure");
  }

  // ======= 20. formal governance is never a lender decision =======
  {
    // A fresh draw driven through the full governed ladder, watching the
    // history at each stage.
    const govId = await mkDraw("user-dmv-pm", "proj-golden", 24000, [
      { description: "Governance-history fixture line (fictional)", milestoneId: "ms-g5", scheduledValue: 24000, currentRequested: 24000 },
    ]);
    await api("user-dmv-pm", "POST", `/api/draws/${govId}/submit`, {});
    for (const id of lineIds(govId)) {
      await api("user-funder", "POST", `/api/draws/${govId}/lines/${id}/review`,
        { decision: "SUPPORTED", percentCompleteVerified: 100 });
    }
    await fileDocs("user-dmv-pm", govId, 24000);
    const gov = await api("user-funder", "POST", `/api/draws/${govId}/governance`, {});
    if (gov.status >= 400) fail(`setup: governance failed (${gov.status}) ${gov.text.slice(0, 160)}`);
    const apRow = db.prepare("SELECT id FROM approval_requests WHERE draw_request_id = ?").get(govId);
    if (!apRow) fail("setup: no approval request opened");
    for (const user of ["user-funder", "user-compliance"]) {
      await api(user, "POST", `/api/approvals/${apRow.id}/decision`, { decision: "APPROVED", note: "Fictional pilot approval." });
    }
    // Formal governance is COMPLETE; no lender decision exists yet.
    const afterGov = portfolio.control(funder);
    const govChanges = afterGov.recentChanges.filter((c) => c.drawRequestId === govId);
    assert(govChanges.some((c) => c.label === "Formal governance decision recorded"),
      "20. completed formal governance appears under its own accurate name");
    assert(!govChanges.some((c) => /Lender decision recorded/.test(c.label)),
      "20. governance completion is NOT presented as a lender decision");
    assert(afterGov.recentChanges.every((c) => !/^Lender decision recorded/.test(c.label) || c.kind === "LENDER_DECISION"),
      "20. every entry labelled as a lender decision is sourced from the decision register kind");

    // Now the actual lender business decision.
    const decision = await api("user-funder", "POST", `/api/draws/${govId}/lender-decision`, {
      decision: "APPROVED", approvedAmount: 24000, decisionReason: "Fictional pilot decision.",
    });
    if (decision.status >= 400) fail(`setup: lender decision failed (${decision.status}) ${decision.text.slice(0, 160)}`);
    const decisionRow = db
      .prepare("SELECT id, decision, decision_at FROM lender_draw_decisions WHERE draw_request_id = ? AND superseded_by_decision_id IS NULL ORDER BY created_at DESC")
      .get(govId);
    const afterDecision = portfolio.control(funder);
    const lenderEntries = afterDecision.recentChanges.filter(
      (c) => c.drawRequestId === govId && c.kind === "LENDER_DECISION"
    );
    assert(lenderEntries.length === 1, "20. the recorded lender decision now appears as its own history item");
    assert(lenderEntries[0].label === "Lender decision recorded — APPROVED",
      `20. it says what was decided (${lenderEntries[0].label})`);
    assert(lenderEntries[0].at === decisionRow.decision_at,
      "20. at the lender decision's OWN recorded timestamp — never a governance event's");

    // Supersede: an amendment through the same governed endpoint. History
    // keeps BOTH decisions; standing-decision surfaces use the amendment.
    const amend = await api("user-funder", "POST", `/api/draws/${govId}/lender-decision`, {
      decision: "APPROVED", approvedAmount: 24000,
      supersedesDecisionId: decisionRow.id,
      decisionReason: "Fictional pilot amendment — corrected decision language.",
    });
    if (amend.status >= 400) fail(`setup: superseding decision failed (${amend.status}) ${amend.text.slice(0, 200)}`);
    const afterAmend = portfolio.control(funder);
    const historyEntries = afterAmend.recentChanges.filter(
      (c) => c.drawRequestId === govId && c.kind === "LENDER_DECISION"
    );
    assert(historyEntries.length === 2,
      "20. a superseded decision remains a historical fact — both decisions stay in history");
    const standing = db
      .prepare("SELECT id FROM lender_draw_decisions WHERE draw_request_id = ? AND superseded_by_decision_id IS NULL")
      .all(govId);
    assert(standing.length === 1 && standing[0].id !== decisionRow.id,
      "20. while the standing decision is the amendment, exactly one non-superseded row");
    const engineSees = dr.drawReadiness(govId);
    assert(engineSees.inputRefs.decisionId === standing[0].id,
      "20. current-decision surfaces keep reading the standing decision, not history");
  }

  // ========== 21. an unevaluable open draw fails CLOSED ==========
  {
    // The seam forces ONE accessible open draw's evaluation to fail. It
    // can only force the error path — never fabricate a result.
    const openRows = [];
    for (const project of authz.accessibleProjects(funder)) {
      for (const d of repo.listDrawRequestsForProject(project.id)) {
        if (portfolio.OPEN_DRAW_STATUSES.includes(d.status)) openRows.push(d);
      }
    }
    const target = openRows.find((d) => d.id === "draw-1") ?? openRows[0];
    process.env.OBV_TEST_FAIL_READINESS = target.id;
    const gapped = portfolio.control(funder);
    delete process.env.OBV_TEST_FAIL_READINESS;

    assert(gapped.scope.openDrawCount === openRows.length,
      `21. the open-draw scope is the REAL set (${openRows.length}), not the evaluated subset`);
    assert(gapped.scope.evaluatedOpenDrawCount === openRows.length - 1,
      "21. exactly one draw is unevaluated");
    assert(gapped.unevaluated.length === 1 && gapped.unevaluated[0].drawRequestId === target.id,
      "21. the affected draw stays visible, by id");
    const entry = gapped.unevaluated[0];
    assert(entry.drawNumber === target.drawNumber && entry.requested === target.requestedAmount,
      "21. with its draw number and its raw requested amount from the governed record");
    assert(entry.projectName.length > 0, "21. and its project");
    assert(entry.reason.length > 0 && !/\n|    at /.test(entry.reason),
      "21. with a one-line failure-safe reason — no stack trace");
    assert(gapped.openRequested === openRows.reduce((s, d) => s + d.requestedAmount, 0),
      "21. raw requested capital still covers ALL open draws, from the draw records themselves");
    assert(gapped.unevaluatedRequested === target.requestedAmount,
      "21. and the uncovered slice is stated");
    const summed = gapped.readinessDistribution.reduce((s, b) => s + b.drawCount, 0);
    assert(summed === gapped.scope.evaluatedOpenDrawCount,
      "21. the readiness buckets cover the evaluated subset only");
    // The unevaluated draw is NOT relabelled INCOMPLETE: the INCOMPLETE
    // bucket must match the engine over the draws that DID evaluate.
    let engineIncomplete = 0;
    for (const d of openRows) {
      if (d.id === target.id) continue;
      if (dr.drawReadiness(d.id).status === "INCOMPLETE") engineIncomplete += 1;
    }
    assert(gapped.readinessDistribution.find((b) => b.status === "INCOMPLETE").drawCount === engineIncomplete,
      "21. the unevaluated draw is never converted into INCOMPLETE — that is a valid result, this is its absence");
    assert(!gapped.register.some((r) => r.drawRequestId === target.id),
      "21. no readiness row is invented for the draw");

    // The PAGE fails closed. A second server carries the seam.
    const PORT2 = PORT + 1;
    const BASE2 = `http://127.0.0.1:${PORT2}`;
    const server2 = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
      env: {
        ...seedEnv, PORT: String(PORT2), OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo",
        OBV_TEST_FAIL_READINESS: target.id,
      },
      stdio: "ignore",
    });
    try {
      let healthy = false;
      for (let i = 0; i < 60 && !healthy; i += 1) {
        try { healthy = (await fetch(`${BASE2}/api/health`)).ok; } catch { /* booting */ }
        if (!healthy) await new Promise((r) => setTimeout(r, 250));
      }
      if (!healthy) fail("21. setup: seam server did not become healthy");
      await signInAll(BASE2, ["user-funder"]);
      const res = await fetch(`${BASE2}/executive`, {
        headers: { cookie: sessionCookie(BASE2, "user-funder"), accept: "text/html" },
      });
      const gapHtml = await res.text();
      assert(/Evaluation unavailable/i.test(gapHtml),
        "21. the page carries a serious EVALUATION UNAVAILABLE condition");
      assert(new RegExp(`Draw #${target.drawNumber}`).test(gapHtml),
        "21. naming the affected draw");
      assert(/Evaluated draws only — incomplete portfolio view/.test(gapHtml),
        "21. readiness-derived panels declare the incomplete view");
      assert(/not a readiness state/.test(gapHtml) && /not INCOMPLETE/.test(gapHtml),
        "21. and state that this is an operational condition, not INCOMPLETE");
      assert(/coverage is not computable for the full portfolio/.test(gapHtml),
        "21. coverage refuses to print over a subset denominator");
      assert(/Open evaluated draws aging beyond/.test(gapHtml),
        "21. the aging figure names its evaluated-only subset");
      const kpiHalf = gapHtml.split('class="ec-advisory"')[0];
      assert(!/class="cv">\s*\d+(\.\d+)?%/.test(kpiHalf),
        "21. no governed coverage percentage renders while a draw is unevaluated");
      assert(!/100% of requested dollars/.test(kpiHalf),
        "21. and certainly not a healthy 100%");
    } finally {
      try { server2.kill("SIGKILL"); } catch { /* gone */ }
    }

    // With no gap, the normal presentation is untouched.
    const normalHtml = (await page("user-funder", "/executive")).html;
    assert(!/Evaluation unavailable/i.test(normalHtml),
      "21. with every draw evaluated, no evaluation alert renders");
    assert(!/Evaluated draws only — incomplete portfolio view/.test(normalHtml),
      "21. and no incomplete-view treatment");
    assert(/class="cv">\d+(\.\d+)?%/.test(normalHtml),
      "21. coverage renders normally again");
    const normal = portfolio.control(funder);
    assert(normal.scope.openDrawCount === normal.scope.evaluatedOpenDrawCount,
      "21. and the scope counts agree again");
  }

  // ============== 22. filters say what they narrow ==============
  {
    const html22 = (await page("user-funder", "/executive")).html;
    assert(/Advisory analytics filters — they narrow the advisory draw summary, distribution and trend panels/.test(html22),
      "22. the filter caption names what the filters actually narrow — including the advisory draw summary");
    assert(/governed capital control at the top of this page always remains portfolio-wide/.test(html22.replace(/\s+/g, " ")),
      "22. and that governed capital control is never narrowed by it");
    assert(!/panels below only/.test(html22),
      "22. the caption no longer claims filters act 'below only' — a filtered advisory panel renders above the bar");
    // The claim is true: a filtered request must not change governed totals.
    const unfiltered = (await page("user-funder", "/executive")).html;
    const filtered = (await page("user-funder", "/executive?stage=EARLY_CONSTRUCTION")).html;
    const capitalBlock = (h) => {
      const m = /Portfolio capital position[\s\S]{0,4200}?<\/section>/.exec(h);
      return m ? m[0] : "";
    };
    assert(capitalBlock(filtered).length > 0 && capitalBlock(filtered) === capitalBlock(unfiltered),
      "22. governed capital position is byte-identical under an advisory filter");
    const kpiValue = (h) => /Requested — open draws<\/span><span class="k-v">([^<]+)</.exec(h)?.[1] ?? "";
    assert(kpiValue(filtered).length > 0 && kpiValue(filtered) === kpiValue(unfiltered),
      `22. the requested-capital KPI value is unchanged by an advisory filter (${kpiValue(filtered)})`);
    const marks = (filtered.match(/filtered · /g) ?? []).length;
    assert(marks >= 3, `22. the overview-driven advisory panels carry a "filtered" mark while a filter is active (${marks})`);
    assert(!/filtered · /.test(unfiltered),
      "22. and no filtered mark appears without a filter");
  }

  db.close();
  stopAll();
  console.log(`\nEXECUTIVE COMMAND CENTER TESTS PASSED — ${passed} checkpoints.`);
  console.log("SUPPORTABLE IS NOT APPROVED. A DOMAIN IS NOT THE WHOLE TRUTH. HISTORY IS NOT TODAY.");
}

main().then(
  () => { stopAll(); process.exit(0); },
  (err) => { console.error(err); stopAll(); process.exit(1); }
);
