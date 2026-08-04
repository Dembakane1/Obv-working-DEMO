#!/usr/bin/env node
/**
 * Project Timeline & Site Intelligence test battery.
 *
 * Proves the timeline is a READ-ONLY view that is deterministic,
 * explainable, tenant-scoped, honest about what the records do and do
 * not say, and fast enough on large histories:
 *   0. static guards (no writes anywhere in the layer, no POST routes,
 *      doctrine notice, future spatial capabilities all DISABLED)
 *   1. aggregation across every subsystem
 *   2. ordering determinism (incl. same-millisecond ties)
 *   3. filtering + named views + search + date range
 *   4. grouping (week / month / category / milestone)
 *   5. story mode (plain language, no invented timestamps)
 *   6. draw playback + executive playback
 *   7. timeline intelligence insights (advisory, measured)
 *   8. site intelligence + map layers + spatial boundaries
 *   9. authorization, tenant isolation, same-404, read-only guarantee
 *  10. performance on a large timeline + relationship graph + export
 *  11. frontend rendering + HTTP authorization (separate server)
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = process.cwd();
const DATA_A = fs.mkdtempSync(path.join(os.tmpdir(), "obv-tl-a-"));
const DATA_B = fs.mkdtempSync(path.join(os.tmpdir(), "obv-tl-b-"));
const PORT = 3270;
const BASE = `http://127.0.0.1:${PORT}`;

// The db module freezes DATA_DIR at load time: point at DATA_A BEFORE
// the first dist require.
process.env.OBV_DATA_DIR = DATA_A;

let passed = 0;
const pass = (m) => { passed += 1; console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`); };
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); throw new Error(m); };
const assert = (cond, m) => (cond ? pass(m) : fail(m));

function seed(dir) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: dir }, stdio: "ignore",
  });
  if (r.status !== 0) fail("seed failed");
}

// ------------------------------------------------------------ section 0

function staticGuards() {
  console.log("\n== 0. Static guards: the timeline never writes ==");
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const dir = "src/server/services/timeline";
  const files = fs.readdirSync(path.join(ROOT, dir))
    .filter((f) => /\.ts$/.test(f))
    .map((f) => path.join(dir, f));
  files.push("src/server/http/timelineRoutes.ts", "src/server/view/timelinePages.tsx");
  const combined = files.map(read).join("\n");

  assert(
    !/\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i.test(combined),
    "timeline layer contains no INSERT / UPDATE / DELETE statement"
  );
  assert(
    !/\.prepare\(/.test(combined),
    "timeline layer never prepares its own SQL — it reads through the repositories"
  );
  assert(
    !/insertEvidence|insertVerification|insertLedgerEntry|createManualException|recordOfficialSource|recordSourceVerification|releaseTranche|processApprovalDecision|createPaymentInstruction/.test(combined),
    "timeline layer calls no write/decision/release path from any other service"
  );
  const routes = read("src/server/http/timelineRoutes.ts");
  assert(!/method === "POST"/.test(routes), "timeline routes define no POST handler");
  assert(/The timeline is read-only/.test(routes), "non-GET requests are explicitly refused");
  const core = read("src/server/services/timeline/core.ts");
  // The notice spans source lines AND a string concatenation, so join
  // the literal fragments before matching.
  const coreFlat = core.replace(/\s+/g, " ").replace(/" \+ "/g, "").replace(/\* /g, "");
  assert(/never creates approvals, changes project state, releases funds/i.test(coreFlat),
    "the read-only doctrine notice is defined");
  const site = read("src/server/services/timeline/siteIntelligence.ts");
  assert((site.match(/status: "DISABLED"/g) ?? []).length === 7,
    "all seven future spatial capabilities are DISABLED");
  assert(!/computerVision|runVision|analyzeImagery/i.test(combined),
    "no computer-vision or imagery analysis is implemented");
  // No new tables: the timeline is derived-on-read.
  const schema = read("src/server/db/index.ts");
  assert(!/CREATE TABLE IF NOT EXISTS timeline_/.test(schema),
    "the timeline owns NO tables (derived on read)");
}

// ------------------------------------------------------------ helpers

const repo = require(path.join(ROOT, "dist/server/db/repo"));
const tl = require(path.join(ROOT, "dist/server/services/timeline"));

let db = null;
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const tableHash = (t) =>
  crypto.createHash("sha256")
    .update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()))
    .digest("hex");

// ---------------------------------------------------------------- main

let server = null;

async function main() {
  staticGuards();

  console.log("\n== 1. Aggregation across every subsystem ==");
  seed(DATA_A);
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(DATA_A, "obv.db"));
  const funder = repo.getUser("user-funder");
  const pm = repo.getUser("user-pm");           // proj-r47 only
  const dmvpm = repo.getUser("user-dmv-pm");    // proj-dmv only
  const field = repo.getUser("user-field");

  const r47 = tl.projectTimeline(funder, "proj-r47");
  const dmv = tl.projectTimeline(funder, "proj-dmv");
  assert(r47.totalEvents > 20, `proj-r47 aggregated ${r47.totalEvents} events`);
  assert(dmv.totalEvents > 20, `proj-dmv aggregated ${dmv.totalEvents} events`);
  const allCategories = new Set([...r47.events, ...dmv.events].map((e) => e.category));
  for (const expected of ["EVIDENCE", "DRAW", "DECISION", "EXCEPTION", "PERMIT", "BUDGET"]) {
    assert(allCategories.has(expected), `events collected from the ${expected} subsystem`);
  }
  assert(
    r47.events.every((e) => e.projectId === "proj-r47"),
    "every event on a project timeline belongs to that project"
  );
  assert(
    r47.events.every((e) => e.title && e.explanation && e.sourceTable && e.sourceRecordId),
    "every event carries a title, explanation, and its source record"
  );
  assert(
    r47.events.every((e) => e.recordStatus === "AUTHORITATIVE" || e.recordStatus === "ADVISORY"),
    "every event is labeled authoritative or advisory"
  );
  const advisory = [...r47.events, ...dmv.events].filter((e) => e.recordStatus === "ADVISORY");
  assert(
    advisory.every((e) => e.category === "EVIDENCE_INTEL" || e.category === "OFFICIAL_SOURCE"),
    "only Evidence Intelligence and Official Source observations are labeled advisory"
  );
  assert(
    r47.events.every((e) => !Number.isNaN(Date.parse(e.at))),
    "every event carries a parseable timestamp (undated records are dropped, never invented)"
  );

  console.log("\n== 2. Ordering determinism ==");
  const idsA = tl.projectTimeline(funder, "proj-r47").events.map((e) => e.id).join("|");
  const idsB = tl.projectTimeline(funder, "proj-r47").events.map((e) => e.id).join("|");
  assert(idsA === idsB, "repeated reads produce identical ordering");
  const times = r47.events.map((e) => e.at);
  assert(
    times.every((t, i) => i === 0 || times[i - 1] <= t),
    "events are in ascending chronological order"
  );
  // Same-millisecond ties must break deterministically, not by luck.
  const sameMs = new Map();
  for (const e of r47.events) sameMs.set(e.at, (sameMs.get(e.at) ?? 0) + 1);
  const tied = [...sameMs.values()].filter((n) => n > 1).length;
  const shuffled = [...r47.events].sort(() => 0.5 - Math.random());
  const resorted = tl.sortEvents(shuffled).map((e) => e.id).join("|");
  assert(resorted === idsA, `ordering is stable under input shuffling (${tied} tied timestamp group(s))`);

  console.log("\n== 3. Filtering, views, search ==");
  const evidenceOnly = tl.projectTimeline(funder, "proj-r47", { categories: ["EVIDENCE"] });
  assert(
    evidenceOnly.events.length > 0 && evidenceOnly.events.every((e) => e.category === "EVIDENCE"),
    "category filter returns only that category"
  );
  assert(evidenceOnly.totalEvents === r47.totalEvents, "filtered reads still report the unfiltered total");
  assert(evidenceOnly.truncated === true, "a filtered view reports that it hid events");
  const viewCats = tl.categoriesForView("financial");
  assert(Array.isArray(viewCats) && viewCats.includes("DRAW") && viewCats.includes("PAYMENT"),
    "named views map to category sets");
  const searched = tl.projectTimeline(funder, "proj-r47", { search: "evidence" });
  assert(
    searched.events.length > 0 &&
      searched.events.every((e) =>
        `${e.title} ${e.explanation} ${e.type} ${e.actorName ?? ""}`.toLowerCase().includes("evidence")
      ),
    "search matches title, explanation, type, or actor"
  );
  const mid = r47.events[Math.floor(r47.events.length / 2)].at;
  const fromMid = tl.projectTimeline(funder, "proj-r47", { from: mid });
  assert(fromMid.events.every((e) => e.at >= mid), "from-date filter excludes earlier events");
  const toMid = tl.projectTimeline(funder, "proj-r47", { to: mid });
  assert(toMid.events.every((e) => e.at <= mid), "to-date filter excludes later events");
  assert(fromMid.events.length + toMid.events.length >= r47.totalEvents,
    "the two half-ranges together cover the whole timeline");
  const capped = tl.projectTimeline(funder, "proj-r47", { limit: 5 });
  assert(capped.events.length === 5 && capped.truncated, "limit caps the window and reports truncation");
  assert(
    capped.events[capped.events.length - 1].at === r47.events[r47.events.length - 1].at,
    "a capped window keeps the MOST RECENT events"
  );

  console.log("\n== 4. Grouping ==");
  const labels = tl.milestoneLabels(r47.project);
  for (const mode of ["week", "month", "category", "milestone"]) {
    const groups = tl.groupEvents(r47.events, mode, labels);
    const total = groups.reduce((s, g) => s + g.events.length, 0);
    assert(total === r47.events.length, `${mode} grouping preserves every event (${groups.length} groups)`);
    const again = tl.groupEvents(r47.events, mode, labels).map((g) => g.key).join("|");
    assert(again === groups.map((g) => g.key).join("|"), `${mode} grouping is deterministic`);
  }
  const weekGroups = tl.groupEvents(r47.events, "week", labels);
  assert(
    weekGroups.every((g, i) => i === 0 || weekGroups[i - 1].key <= g.key),
    "time-based groups are in chronological order"
  );

  console.log("\n== 5. Story mode ==");
  const story = tl.projectStory(funder, "proj-dmv");
  assert(story.steps.length > 0, `story produced ${story.steps.length} narrative steps`);
  assert(
    story.steps.every((s, i) => i === 0 || story.steps[i - 1].at <= s.at),
    "story steps are chronological"
  );
  assert(
    story.steps.every((s) => s.headline && s.detail && s.eventId),
    "every story step has a headline, detail, and a link back to its event"
  );
  assert(
    /does not store a separate project-creation timestamp/.test(story.opening),
    "the story is explicit that no project-creation timestamp exists (never invented)"
  );
  assert(/milestones released/.test(story.currentState), "the story states where the project stands now");
  const storyEventIds = new Set(dmv.events.map((e) => e.id));
  assert(
    story.steps.every((s) => storyEventIds.has(s.eventId)),
    "every story step traces to a real timeline event"
  );
  // Story narrates only what happened — never future-dated records.
  assert(
    story.steps.every((s) => s.at <= story.asOf),
    "the story never narrates a future-dated record as history"
  );
  assert(dmv.upcomingCount > 0, `future-dated records are counted as upcoming (${dmv.upcomingCount})`);

  console.log("\n== 6. Playback ==");
  const draws = repo.listDrawRequestsForProject("proj-r47");
  const dp = tl.drawPlayback(funder, "proj-r47", draws[0].id);
  assert(dp.stages.length === 10, "draw playback covers all ten lifecycle stages");
  assert(dp.stages[0].key === "requested" && dp.stages[9].key === "confirmation",
    "draw playback runs requested → provider confirmation");
  assert(dp.stages.some((s) => s.state === "COMPLETE"), "completed stages are detected from the records");
  assert(
    dp.stages.find((s) => s.key === "evidence").state === "COMPLETE",
    "the evidence stage resolves through the draw→milestone linkage"
  );
  assert(dp.stages.every((s) => s.detail && s.detail.length > 0), "every stage explains its state");
  const pb = tl.executivePlayback(funder, "proj-r47");
  assert(pb.frames.length > 0, `executive playback produced ${pb.frames.length} frames`);
  assert(
    pb.frames.every((f, i) => i === 0 || pb.frames[i - 1].cumulativeEvents <= f.cumulativeEvents),
    "cumulative event counts never decrease across frames"
  );
  assert(
    pb.frames[pb.frames.length - 1].cumulativeEvents ===
      tl.pastEvents(r47.events, r47.asOf).length,
    "the final frame accounts for every event that has happened"
  );
  assert(pb.frames.every((f) => f.narrative && f.narrative.length > 0), "every frame is explained in words");
  assert(pb.frames.every((f) => f.openExceptions >= 0 && f.openDisputes >= 0),
    "open counts never go negative");

  console.log("\n== 7. Timeline intelligence (advisory) ==");
  const ins = tl.timelineInsights(funder, "proj-r47");
  assert(ins.insights.length > 0, `insights engine produced ${ins.insights.length} observation(s)`);
  assert(
    ins.insights.every((i) => i.title && i.explanation && i.recommendation && i.evidence),
    "every insight explains itself and shows the measurement behind it"
  );
  assert(
    ins.insights.every((i) => Object.keys(i.evidence).length > 0),
    "no insight is a black box — each carries its evidence object"
  );
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
  assert(
    ins.insights.every((i, idx) => idx === 0 || rank[ins.insights[idx - 1].severity] >= rank[i.severity]),
    "insights are ordered most severe first"
  );
  const insAgain = tl.timelineInsights(funder, "proj-r47").insights.map((i) => i.kind).join("|");
  assert(insAgain === ins.insights.map((i) => i.kind).join("|"), "insight ordering is deterministic");
  assert(
    JSON.stringify(ins.insights).toLowerCase().indexOf("fraud") === -1,
    "insights never label anything fraudulent"
  );
  assert(typeof tl.THRESHOLDS.approvalDelayDays === "number",
    "advisory thresholds are published, not hidden");

  console.log("\n== 8. Site intelligence, map, spatial boundaries ==");
  const site = tl.siteIntelligence(funder, "proj-dmv");
  assert(site.panels.length >= 13, `site intelligence composed ${site.panels.length} panels`);
  const panelKeys = new Set(site.panels.map((p) => p.key));
  for (const key of [
    "health", "budget", "schedule", "evidence", "permits", "inspections",
    "official_sources", "contractor", "risk", "exceptions", "disputes", "draws", "payment", "portfolio",
  ]) assert(panelKeys.has(key), `site intelligence includes the ${key} panel`);
  assert(site.panels.every((p) => p.detail && p.detail.length > 0), "every panel explains its figure");
  assert(site.executiveSummary.includes(site.project.name), "the executive summary names the project");
  assert(
    site.panels.find((p) => p.key === "contractor").detail.includes("never rates integrity"),
    "the contractor panel is explicit that OBV does not rate integrity"
  );
  const map = tl.projectMapData(funder, "proj-dmv");
  assert(Array.isArray(map.layers.evidence), "map exposes an evidence layer");
  assert(
    map.layers.evidence.every((f) => f.latitude !== null && f.longitude !== null),
    "only evidence with a real GPS fix appears on the map (never a guessed point)"
  );
  assert(
    map.layers.permits.every((f) => f.latitude === null && f.longitude === null),
    "permits are project-anchored records, not placed at invented coordinates"
  );
  assert(Array.isArray(map.boundary) && map.boundary.length > 0, "the map reuses the project's site boundary");
  const spatial = tl.spatialReadiness();
  assert(spatial.enabled === false, "future spatial capabilities are disabled");
  assert(spatial.capabilities.length === 7, "seven future spatial capabilities are declared");
  assert(
    spatial.capabilities.every((c) => c.status === "DISABLED" && c.requires.length > 0),
    "each declared capability is DISABLED and states what it would require"
  );
  assert(/no computer-vision, photogrammetric, or volumetric analysis is performed/i.test(spatial.notice),
    "the spatial notice is explicit that no analysis is performed");

  console.log("\n== 9. Authorization, tenancy, read-only guarantee ==");
  let crossErr = null;
  try { tl.projectTimeline(dmvpm, "proj-r47"); } catch (e) { crossErr = e; }
  assert(crossErr?.statusCode === 404, "a project outside the caller's access is a plain 404");
  let missErr = null;
  try { tl.projectTimeline(funder, "no-such-project"); } catch (e) { missErr = e; }
  assert(missErr?.statusCode === 404, "a nonexistent project is the SAME 404 as an inaccessible one");
  const pmPortfolio = tl.portfolioTimeline(pm);
  assert(
    pmPortfolio.entries.every((e) => e.projectId !== "proj-dmv"),
    "the portfolio timeline shows only the caller's accessible projects"
  );
  let siteErr = null;
  try { tl.siteIntelligence(dmvpm, "proj-r47"); } catch (e) { siteErr = e; }
  assert(siteErr?.statusCode === 404, "site intelligence is same-404 across tenants");
  let storyErr = null;
  try { tl.projectStory(dmvpm, "proj-r47"); } catch (e) { storyErr = e; }
  assert(storyErr?.statusCode === 404, "story mode is same-404 across tenants");
  let drawErr = null;
  try { tl.drawPlayback(funder, "proj-dmv", draws[0].id); } catch (e) { drawErr = e; }
  assert(drawErr?.statusCode === 404, "a draw from another project is a plain 404");
  // FIELD can see its own project's history (it is their work).
  const fieldTimeline = tl.projectTimeline(field, "proj-r47");
  assert(fieldTimeline.totalEvents > 0, "a field engineer can read the history of their own project");

  // READ-ONLY: reading the whole surface must not alter a single table.
  const TABLES = [
    "projects", "milestones", "evidence_items", "verifications", "ledger_entries",
    "draw_requests", "approval_requests", "approval_records", "exceptions", "disputes",
    "permits", "jurisdictional_inspections", "permit_basis_versions", "source_verifications",
    "evidence_signals", "evidence_review_queue", "source_snapshots", "source_review_items",
    "banking_events", "virtual_account_events", "config_audit",
  ];
  const before = {};
  for (const t of TABLES) before[t] = tableHash(t);
  tl.projectTimeline(funder, "proj-r47");
  tl.projectTimeline(funder, "proj-dmv");
  tl.projectStory(funder, "proj-r47");
  tl.siteIntelligence(funder, "proj-r47");
  tl.timelineInsights(funder, "proj-r47");
  tl.executivePlayback(funder, "proj-r47");
  tl.drawPlayback(funder, "proj-r47", draws[0].id);
  tl.relationshipGraph(funder, "proj-r47");
  tl.projectMapData(funder, "proj-r47");
  tl.portfolioTimeline(funder);
  for (const t of TABLES) {
    assert(before[t] === tableHash(t), `${t} byte-identical after reading the entire timeline surface`);
  }

  console.log("\n== 10. Large timelines, graph, export ==");
  // Synthesize a large history against a real milestone, then confirm
  // the engine stays ordered, correct, and fast.
  const milestone = repo.listMilestones("proj-r47")[0];
  const BULK = 1200;
  for (let i = 0; i < BULK; i += 1) {
    repo.insertConfigAudit({
      id: repo.newId(),
      projectId: "proj-r47",
      actorUserId: "user-funder",
      action: "BULK_TEST_EVENT",
      entityType: "milestone",
      entityId: milestone.id,
      reason: null,
      beforeSummary: null,
      afterSummary: `synthetic event ${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 60), (i % 60) * 16)).toISOString(),
    });
  }
  const t0 = Date.now();
  const big = tl.projectTimeline(funder, "proj-r47");
  const elapsed = Date.now() - t0;
  assert(big.totalEvents >= BULK, `large timeline aggregated ${big.totalEvents} events`);
  assert(Array.isArray(big.sourceCaps) && big.sourceCaps.length === 0,
    "no source read-cap applied at this size — and caps are reported, never silent");
  assert(elapsed < 4000, `large timeline built in ${elapsed}ms (budget 4000ms)`);
  const bigTimes = big.events.map((e) => e.at);
  assert(
    bigTimes.every((t, i) => i === 0 || bigTimes[i - 1] <= t),
    "a large timeline is still correctly ordered"
  );
  const t1 = Date.now();
  const bigFiltered = tl.projectTimeline(funder, "proj-r47", { categories: ["GOVERNANCE"], limit: 50 });
  const elapsedFiltered = Date.now() - t1;
  assert(bigFiltered.events.length === 50, "filtering a large timeline returns the requested window");
  assert(elapsedFiltered < 4000, `filtered large read in ${elapsedFiltered}ms`);
  const tStory = Date.now();
  tl.projectStory(funder, "proj-r47");
  assert(Date.now() - tStory < 4000, "story mode stays responsive on a large timeline");
  const tSite = Date.now();
  tl.siteIntelligence(funder, "proj-r47");
  assert(Date.now() - tSite < 5000, "site intelligence stays responsive on a large timeline");
  const bigPb = tl.executivePlayback(funder, "proj-r47");
  assert(bigPb.frames.length <= 17, `playback collapses a long history into ${bigPb.frames.length} readable frames`);

  const graph = tl.relationshipGraph(funder, "proj-dmv");
  assert(graph.nodes.length > 0 && graph.edges.length > 0,
    `relationship graph built ${graph.nodes.length} nodes / ${graph.edges.length} edges`);
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  assert(
    graph.edges.every((e) => nodeIds.has(e.from) && nodeIds.has(e.to)),
    "every graph edge connects two declared nodes"
  );
  const dupEdges = new Set(graph.edges.map((e) => `${e.from}->${e.to}:${e.label}`));
  assert(dupEdges.size === graph.edges.length, "the graph contains no duplicate edges");

  db.close();

  console.log("\n== 11. Frontend rendering + HTTP authorization ==");
  seed(DATA_B);
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_B, PORT: String(PORT), OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo" },
    stdio: "ignore",
  });
  let healthy = false;
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { healthy = true; break; } } catch {}
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
  const dmvCookie = await signIn("user-dmv-pm");
  const page = async (p, ck) => {
    const r = await fetch(`${BASE}${p}`, { headers: { cookie: ck ?? "", accept: "text/html" }, redirect: "manual" });
    return { status: r.status, html: await r.text() };
  };
  const status = async (p, ck, opts = {}) =>
    (await fetch(`${BASE}${p}`, { headers: { cookie: ck ?? "" }, redirect: "manual", ...opts })).status;

  const portfolioPage = await page("/timeline", cookie);
  assert(portfolioPage.status === 200 && /Portfolio timeline/.test(portfolioPage.html), "portfolio timeline page renders");
  assert(/never creates approvals/.test(portfolioPage.html), "pages carry the read-only notice");
  const projPage = await page("/timeline/project/proj-r47", cookie);
  assert(projPage.status === 200 && /recorded events/.test(projPage.html), "project timeline page renders");
  assert((await page("/timeline/project/proj-r47?group=week&view=evidence", cookie)).status === 200,
    "grouped + filtered timeline renders");
  const sitePage = await page("/timeline/site/proj-r47", cookie);
  assert(sitePage.status === 200 && /Executive summary/.test(sitePage.html), "site intelligence page renders");
  const storyPage = await page("/timeline/story/proj-dmv", cookie);
  assert(storyPage.status === 200 && /got here/.test(storyPage.html), "story page renders");
  assert((await page("/timeline/playback/proj-r47", cookie)).status === 200, "executive playback page renders");
  const mapPage = await page("/timeline/map/proj-dmv", cookie);
  assert(mapPage.status === 200 && /Future spatial layers/.test(mapPage.html), "project map page renders");
  assert(/no computer-vision/i.test(mapPage.html), "the map page states no vision analysis is performed");
  assert((await page("/timeline/graph/proj-r47", cookie)).status === 200, "relationship graph page renders");
  const drawsB = await (await fetch(`${BASE}/api/timeline/project/proj-r47`, { headers: { cookie } })).json();
  const withDraw = drawsB.events.find((e) => e.drawRequestId);
  if (withDraw) {
    assert((await page(`/timeline/draw/proj-r47/${withDraw.drawRequestId}`, cookie)).status === 200,
      "draw playback page renders");
  } else pass("no draw-linked event to render playback (acceptable)");
  const firstEvent = drawsB.events[0];
  assert(
    (await page(`/timeline/event/proj-r47/${encodeURIComponent(firstEvent.id)}`, cookie)).status === 200,
    "event detail page renders"
  );

  // Export.
  const csv = await fetch(`${BASE}/api/timeline/export/proj-r47?format=csv`, { headers: { cookie } });
  const csvText = await csv.text();
  assert(csv.status === 200 && /^at,category,type,title/.test(csvText), "CSV export renders with a header row");
  assert(csvText.split("\n").length > 5, "CSV export contains event rows");
  const jsonExport = await (await fetch(`${BASE}/api/timeline/export/proj-r47`, { headers: { cookie } })).json();
  assert(jsonExport.notice && jsonExport.events.length > 0, "JSON export carries the notice and the events");

  // Authorization over HTTP.
  assert((await status("/timeline/project/proj-r47", dmvCookie)) === 404, "cross-tenant project timeline is 404 over HTTP");
  assert((await status("/api/timeline/site/proj-r47", dmvCookie)) === 404, "cross-tenant site intelligence API is 404");
  assert((await status("/api/timeline/portfolio")) === 401, "anonymous API access is 401");
  const anon = await page("/timeline");
  assert([302, 303].includes(anon.status), "anonymous timeline page redirects to sign-in");
  assert(
    (await status("/api/timeline/portfolio", cookie, { method: "POST" })) === 405,
    "the timeline API refuses non-GET requests (read-only)"
  );
  const exec = await page("/executive", cookie);
  assert(/Project history/.test(exec.html) && /Recorded events/.test(exec.html),
    "the executive command center shows the read-only project-history band");

  console.log(`\nPROJECT TIMELINE TESTS PASSED — ${passed} checkpoints.`);
  console.log("THE TIMELINE EXPLAINS THE RECORD. IT NEVER CHANGES IT.");
}

main()
  .catch((err) => { console.error(err.stack ?? err); process.exitCode = 1; })
  .finally(() => {
    try { if (server) server.kill(); } catch {}
    try { fs.rmSync(DATA_A, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(DATA_B, { recursive: true, force: true }); } catch {}
  });
