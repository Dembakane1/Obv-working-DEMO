#!/usr/bin/env node
/**
 * Digital Twin test battery.
 *
 * Proves the twin is a READ-ONLY visualization layer that draws only
 * recorded coordinates, inherits (never widens) subsystem gates, stays
 * synchronized with the authoritative Timeline, replays rather than
 * simulates, and changes nothing:
 *   0. static guards (no writes anywhere in the layer, no POST routes,
 *      doctrine notice, all provider boundaries DISABLED, no tables)
 *   1. scene correctness over recorded geometry
 *   2. honesty (governance-lifecycle progress, degraded scenes,
 *      no invented coordinates, caps reported)
 *   3. authorization inheritance (EI / Official Sources / banking)
 *   4. timeline ↔ twin synchronization integrity
 *   5. construction playback = exact recorded history
 *   6. evidence pin detail + real distances + same-404
 *   7. coverage arithmetic (numerator/denominator)
 *   8. portfolio snapshots (tenancy + bounds)
 *   9. same-404 + READ-ONLY byte-identical proof
 *  10. performance on a large history
 *  11. frontend rendering + HTTP authorization (separate server)
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = process.cwd();
const DATA_A = fs.mkdtempSync(path.join(os.tmpdir(), "obv-twin-a-"));
const DATA_B = fs.mkdtempSync(path.join(os.tmpdir(), "obv-twin-b-"));
const PORT = 3275;
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
  console.log("\n== 0. Static guards: the twin never writes ==");
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const dir = "src/server/services/twin";
  const files = fs.readdirSync(path.join(ROOT, dir))
    .filter((f) => /\.ts$/.test(f))
    .map((f) => path.join(dir, f));
  files.push("src/server/http/twinRoutes.ts", "src/server/view/twinPages.tsx", "src/client/twin.ts");
  const combined = files.map(read).join("\n");

  assert(
    !/\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i.test(combined),
    "twin layer contains no INSERT / UPDATE / DELETE statement"
  );
  assert(!/\.prepare\(/.test(combined), "twin layer never prepares its own SQL");
  assert(
    !/insertEvidence|insertVerification|insertLedgerEntry|createManualException|releaseTranche|processApprovalDecision|createPaymentInstruction|updateProjectFields|insertSpatialFeature/.test(combined),
    "twin layer calls no write/decision/release path from any other service"
  );
  const routes = read("src/server/http/twinRoutes.ts");
  assert(!/method === "POST"/.test(routes), "twin routes define no POST handler");
  assert(/The Digital Twin is read-only/.test(routes), "non-GET requests are explicitly refused");
  const client = read("src/client/twin.ts");
  assert(!/method\s*:\s*["'](POST|PUT|DELETE|PATCH)/i.test(client), "the client script issues GET requests only");
  const scene = read("src/server/services/twin/scene.ts");
  const flat = scene.replace(/\s+/g, " ").replace(/" \+ "/g, "").replace(/\* /g, "");
  assert(/owns no data, performs no writes/i.test(flat), "the twin doctrine notice is defined");
  assert(/Timeline remains the authoritative interface/i.test(flat), "the notice names the Timeline as authoritative");
  const providers = read("src/server/services/twin/providers.ts");
  assert((providers.match(/status: "DISABLED"/g) ?? []).length === 9,
    "all nine provider boundaries are DISABLED (Cesium, ArcGIS, Mapbox, Google, DroneDeploy, Pix4D, Matterport, Bentley, Autodesk)");
  assert(!/computerVision|runVision|analyzeImagery|simulateFrame|synthesizeEvent|fakeEvent|generateSynthetic/i.test(combined),
    "no vision analysis and no frame-synthesis code exists");
  const schema = read("src/server/db/index.ts");
  assert(!/CREATE TABLE IF NOT EXISTS twin_/.test(schema), "the twin owns NO tables (derived on read)");
}

// ------------------------------------------------------------ helpers

const repo = require(path.join(ROOT, "dist/server/db/repo"));
const twin = require(path.join(ROOT, "dist/server/services/twin"));
const tl = require(path.join(ROOT, "dist/server/services/timeline"));
const eiCore = require(path.join(ROOT, "dist/server/services/evidenceIntel/core"));
const osCore = require(path.join(ROOT, "dist/server/services/officialSources/core"));
const bankAccess = require(path.join(ROOT, "dist/server/services/banking/bankingAccess"));

let db = null;
const tableHash = (t) =>
  crypto.createHash("sha256")
    .update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()))
    .digest("hex");

let server = null;

async function main() {
  staticGuards();

  seed(DATA_A);
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(DATA_A, "obv.db"));

  const funder = repo.getUser("user-funder");
  const pm = repo.getUser("user-pm");         // proj-r47 only
  const dmvpm = repo.getUser("user-dmv-pm");  // proj-dmv only
  const field = repo.getUser("user-field");
  const project = repo.getProject("proj-r47");

  // ------------------------------------------------------ 1. scene
  console.log("\n== 1. Scene correctness over recorded geometry ==");
  const scene = twin.twinScene(funder, "proj-r47");
  assert(scene.projectId === "proj-r47", "scene targets the requested project");
  assert(!scene.frame.degraded, "seeded project has recorded geometry — scene is not degraded");
  assert(
    scene.boundary.length === project.siteBoundary.length,
    `boundary has exactly the recorded vertices (${project.siteBoundary.length})`
  );
  const milestones = repo.listMilestones("proj-r47").filter((m) => !m.archived);
  assert(scene.stages.length === milestones.length, "one stage per recorded milestone");
  assert(
    scene.stages.every((s, i) => i === 0 || scene.stages[i - 1].seq <= s.seq),
    "stages are ordered by recorded sequence"
  );
  const features = repo.listSpatialFeatures("proj-r47");
  const segEls = scene.elements.filter((e) => e.kind === "SEGMENT");
  assert(
    segEls.length === features.filter((f) => f.kind === "SEGMENT" && f.geometry.length > 0).length,
    "one segment element per recorded SEGMENT feature"
  );
  const routeEl = scene.elements.find((e) => e.kind === "ROUTE");
  assert(Boolean(routeEl), "the recorded ROUTE is drawn");
  const pins = scene.elements.filter((e) => e.kind === "EVIDENCE_PIN");
  const gpsEvidence = milestones.flatMap((m) => repo.listEvidenceForMilestone(m.id))
    .filter((e) => e.latitude !== null && e.longitude !== null);
  assert(pins.length === gpsEvidence.length, `evidence pins exactly = GPS-located items (${gpsEvidence.length})`);
  assert(
    pins.every((p) => p.points.length === 1),
    "every pin is placed at exactly one recorded position"
  );
  assert(
    scene.anchored.every((a) => ["PERMIT", "INSPECTION", "OFFICIAL_SOURCE", "SOURCE_CANDIDATE", "VERIFICATION"].includes(a.group)),
    "anchored dock holds only coordinate-less record groups"
  );
  const permitEls = scene.elements.filter((e) => e.sourceTable === "permits" && e.kind !== "ADVISORY_MARKER");
  assert(permitEls.length === 0, "permits are NEVER placed on the scene (no recorded coordinates)");
  // Local frame is honest: distances derived from it match the recorded
  // geometry (boundary width for the seeded ring is ~12km east-west).
  assert(scene.frame.widthM > 5_000 && scene.frame.widthM < 30_000,
    `local frame extent is in the recorded ballpark (${scene.frame.widthM} m east-west)`);

  // ------------------------------------------------------ 2. honesty
  console.log("\n== 2. Honesty: lifecycle, degraded scenes, caps ==");
  const released = milestones.filter((m) => m.status === "RELEASED");
  const expectPct = Math.round(
    (released.reduce((s, m) => s + m.trancheAmount, 0) / milestones.reduce((s, m) => s + m.trancheAmount, 0)) * 100
  );
  assert(scene.completion.pct === expectPct, `completion = tranche-weighted RELEASED (${expectPct}%)`);
  assert(/not a physical measurement/i.test(scene.completion.basis), "completion states its basis explicitly");
  const lifecycle = ["NOT_STARTED", "PENDING_EVIDENCE", "UNDER_REVIEW", "VERIFIED", "APPROVED", "RELEASED"];
  assert(
    scene.stages.every((s) => s.lifecycleStep === lifecycle.indexOf(s.status)),
    "every stage's lifecycle step is exactly its recorded status position"
  );
  assert(
    scene.stages.every((s) => s.lifecycleTotal === lifecycle.length - 1),
    "lifecycle total matches the governance lifecycle length"
  );
  const progressLayer = scene.layers.find((l) => l.key === "progress");
  assert(/not a physical measurement/i.test(progressLayer.note ?? ""), "the progress layer repeats the honesty note");
  for (const key of ["drone", "lidar", "satellite"]) {
    const l = scene.layers.find((x) => x.key === key);
    assert(l && !l.available && !l.defaultOn && l.count === 0, `future layer ${key} is present but disabled`);
  }
  // Degraded scene: a project with no recorded geometry draws nothing
  // and says so, rather than inventing shapes.
  const bare = { ...project, id: "proj-bare-twin", name: "Bare", siteBoundary: [] };
  db.prepare(
    "INSERT INTO projects (id, organization_id, name, description, location, site_boundary, total_budget, status) VALUES (?,?,?,?,?,?,?,?)"
  ).run(bare.id, project.organizationId, bare.name, "d", "loc", JSON.stringify([]), 1000, "ACTIVE");
  const bareScene = twin.twinScene(funder, "proj-bare-twin");
  assert(bareScene.frame.degraded, "a project with no recorded geometry yields a DEGRADED frame");
  assert(bareScene.elements.every((e) => e.points.length === 0), "a degraded scene places nothing");
  db.prepare("DELETE FROM projects WHERE id = ?").run("proj-bare-twin");

  // ------------------------------------------------------ 3. gating
  console.log("\n== 3. Authorization inheritance (never widened) ==");
  const fieldScene = twin.twinScene(field, "proj-r47");
  assert(
    !eiCore.canViewEvidenceIntel(field) &&
      fieldScene.elements.every((e) => e.sourceTable !== "evidence_signals"),
    "a role Evidence Intelligence denies sees no signal markers"
  );
  assert(
    !osCore.canViewSources(field) &&
      fieldScene.anchored.every((a) => a.sourceTable !== "official_source_records"),
    "a role Official Sources denies sees no official-source dock records"
  );
  const fieldSources = fieldScene.layers.find((l) => l.key === "sources");
  assert(
    fieldSources && fieldSources.available &&
      fieldScene.anchored.some((a) => a.group === "PERMIT"),
    "permits stay visible to project viewers — only Official Sources' OWN records are gated"
  );
  const fieldPay = fieldScene.layers.find((l) => l.key === "payments");
  assert(
    !bankAccess.hasBankingCapability(field, "proj-r47", "VIEW_PROJECT_ACCOUNT") &&
      fieldPay && !fieldPay.available && fieldPay.count === 0,
    "the payments layer requires VIEW_PROJECT_ACCOUNT"
  );
  const pmDetailGate = twin.twinPinDetail(field, "proj-r47", gpsEvidence[0].id);
  assert(pmDetailGate.advisorySignals === null && pmDetailGate.metadataFacts === null && pmDetailGate.ocr === null,
    "pin detail hides EI sections from roles the subsystem denies (null, not empty)");
  const funderDetail = twin.twinPinDetail(funder, "proj-r47", gpsEvidence[0].id);
  assert(Array.isArray(funderDetail.advisorySignals), "a permitted role gets the advisory sections (positive control)");
  const funderSources = scene.anchored.some((a) => a.group === "OFFICIAL_SOURCE") || osCore.canViewSources(funder);
  assert(funderSources, "a permitted role keeps official sources (positive control)");

  // ------------------------------------------------------ 4. sync
  console.log("\n== 4. Timeline ↔ twin synchronization ==");
  const timeline = tl.projectTimeline(funder, "proj-r47");
  const elementIds = new Set([...scene.elements.map((e) => e.id), ...scene.anchored.map((a) => a.id)]);
  const eventIds = new Set(timeline.events.map((e) => e.id));
  assert(scene.sync.length > 0, `sync map is populated (${scene.sync.length} entries)`);
  assert(scene.sync.every((s) => eventIds.has(s.eventId)), "every sync entry references a real timeline event");
  assert(scene.sync.every((s) => elementIds.has(s.elementId)), "every sync entry references a real scene element or dock record");
  const uploadEvent = timeline.events.find((e) => e.type === "EVIDENCE_UPLOADED" && gpsEvidence.some((g) => g.id === e.sourceRecordId));
  if (uploadEvent) {
    const entry = scene.sync.find((s) => s.eventId === uploadEvent.id);
    assert(entry && entry.elementId === `EVIDENCE_PIN:${uploadEvent.sourceRecordId}`,
      "an evidence-upload event maps to its own pin");
  }
  const msEvent = timeline.events.find((e) => e.milestoneId && segEls.some((s) => s.milestoneId === e.milestoneId) && e.sourceTable === "config_audit");
  if (msEvent) {
    const entry = scene.sync.find((s) => s.eventId === msEvent.id);
    assert(entry && (entry.elementId.startsWith("SEGMENT:") || elementIds.has(entry.elementId)),
      "a milestone-linked event maps to its stage geometry");
  }

  // ------------------------------------------------------ 5. playback
  console.log("\n== 5. Construction playback = the recorded history ==");
  const playback = twin.twinPlayback(funder, "proj-r47");
  const happened = timeline.events.filter((e) => e.at <= timeline.asOf);
  assert(playback.steps.length === happened.length && !playback.truncated,
    `playback is exactly the recorded past (${happened.length} steps, no simulation)`);
  assert(
    playback.steps.every((s, i) => i === 0 || playback.steps[i - 1].at <= s.at),
    "playback steps are chronological"
  );
  assert(
    playback.steps.every((s) => eventIds.has(s.eventId)),
    "every playback step IS a recorded timeline event"
  );
  assert(
    playback.steps.every((s) => s.elementId === null || elementIds.has(s.elementId)),
    "every playback step highlight resolves to a real element"
  );
  const upcoming = timeline.events.filter((e) => e.at > timeline.asOf);
  assert(
    upcoming.every((u) => !playback.steps.some((s) => s.eventId === u.id)),
    "recorded FUTURE dates are never replayed as history"
  );

  // ------------------------------------------------------ 6. pin detail
  console.log("\n== 6. Evidence pin detail: real distances, same-404 ==");
  const detail = twin.twinPinDetail(funder, "proj-r47", gpsEvidence[0].id);
  assert(detail.evidence.hasGps, "pin detail reports the recorded GPS fix");
  assert(
    detail.distances.toSiteCentroidM !== null && detail.distances.toSiteCentroidM >= 0,
    `distance to site centroid computed from recorded coordinates (${detail.distances.toSiteCentroidM} m)`
  );
  assert(detail.distances.insideBoundary === true, "the seeded on-site pin is inside the recorded boundary");
  assert(
    detail.distances.toPlannedGeometryM !== null && detail.distances.toPlannedGeometryM < 500,
    `distance to planned stage geometry is real and small for on-segment evidence (${detail.distances.toPlannedGeometryM} m)`
  );
  // A no-GPS item gets NULL distances — never guessed.
  const ms0 = milestones[0];
  const noGps = {
    id: "ev-twin-nogps", milestoneId: ms0.id, userId: "user-field", photoPath: "/demo-evidence/none.jpg",
    latitude: null, longitude: null, capturedAt: "2026-02-01T10:00:00.000Z", uploadedAt: "2026-02-01T10:05:00.000Z",
    deviceMetadata: { userAgent: "t", platform: "t", screen: "1x1", language: "en" },
    hash: "h".repeat(64), previousHash: null, isDemoFallback: false,
  };
  repo.insertEvidence(noGps);
  const noGpsDetail = twin.twinPinDetail(funder, "proj-r47", "ev-twin-nogps");
  assert(
    !noGpsDetail.evidence.hasGps &&
      noGpsDetail.distances.toPlannedGeometryM === null &&
      noGpsDetail.distances.toSiteCentroidM === null &&
      noGpsDetail.distances.insideBoundary === null,
    "an item without GPS gets NULL distances — not computable, never guessed"
  );
  const noGpsScene = twin.twinScene(funder, "proj-r47");
  assert(
    !noGpsScene.elements.some((e) => e.id === "EVIDENCE_PIN:ev-twin-nogps"),
    "an item without GPS is never placed on the scene"
  );
  assert(
    noGpsScene.caps.some((c) => /no GPS fix/.test(c)),
    "the scene REPORTS how many items were listed instead of placed"
  );
  db.prepare("DELETE FROM evidence_items WHERE id = ?").run("ev-twin-nogps");
  // Same-404: cross-project and nonexistent evidence are indistinguishable.
  const dmvEvidence = repo.listMilestones("proj-dmv").flatMap((m) => repo.listEvidenceForMilestone(m.id));
  let crossPin = null;
  try { twin.twinPinDetail(funder, "proj-r47", dmvEvidence[0].id); } catch (e) { crossPin = e; }
  let missPin = null;
  try { twin.twinPinDetail(funder, "proj-r47", "no-such-evidence"); } catch (e) { missPin = e; }
  assert(crossPin?.statusCode === 404 && missPin?.statusCode === 404 && crossPin.message === missPin.message,
    "a foreign evidence id and a nonexistent one are the SAME 404");

  // ------------------------------------------------------ 7. coverage
  console.log("\n== 7. Coverage arithmetic ==");
  const cov = twin.twinCoverage(funder, "proj-r47");
  const withEvidence = milestones.filter((m) => repo.listEvidenceForMilestone(m.id).length > 0).length;
  assert(
    cov.evidenceCoverage.covered === withEvidence && cov.evidenceCoverage.total === milestones.length,
    `evidence coverage = ${withEvidence}/${milestones.length} stages with evidence`
  );
  const allItems = milestones.flatMap((m) => repo.listEvidenceForMilestone(m.id));
  assert(
    cov.gpsCoverage.withGps === allItems.filter((e) => e.latitude !== null).length &&
      cov.gpsCoverage.total === allItems.length,
    "GPS coverage counts recorded fixes over all items"
  );
  assert(cov.completionPct === scene.completion.pct, "coverage completion matches the scene's completion");
  assert(/not a physical measurement/i.test(cov.completionBasis), "coverage completion states its basis");
  assert(Array.isArray(cov.activityByWeek) && cov.activityByWeek.length > 0, "activity heatmap has weekly counts");
  assert(cov.riskDensity.length === milestones.length, "risk density has one row per stage");

  // ------------------------------------------------------ 8. snapshots
  console.log("\n== 8. Portfolio snapshots ==");
  const funderSnaps = twin.twinSnapshots(funder);
  assert(funderSnaps.snapshots.length >= 2, "funder sees snapshots for accessible projects");
  const pmSnaps = twin.twinSnapshots(pm);
  assert(
    pmSnaps.snapshots.every((s) => s.projectId !== "proj-dmv"),
    "snapshots contain ONLY the caller's accessible projects"
  );
  const r47Snap = funderSnaps.snapshots.find((s) => s.projectId === "proj-r47");
  assert(r47Snap && r47Snap.completionPct === scene.completion.pct, "snapshot completion matches the scene");
  assert(r47Snap.boundary.length === project.siteBoundary.length, "snapshot uses the recorded boundary");

  // ------------------------------------------------------ 9. read-only
  console.log("\n== 9. Same-404 + READ-ONLY byte-identical proof ==");
  let cross = null;
  try { twin.twinScene(dmvpm, "proj-r47"); } catch (e) { cross = e; }
  let miss = null;
  try { twin.twinScene(funder, "no-such-project"); } catch (e) { miss = e; }
  assert(cross?.statusCode === 404 && miss?.statusCode === 404 && cross.message === miss.message,
    "an inaccessible project and a nonexistent one are the SAME 404");
  let coverageCross = null;
  try { twin.twinCoverage(dmvpm, "proj-r47"); } catch (e) { coverageCross = e; }
  assert(coverageCross?.statusCode === 404, "coverage is same-404 across tenants");
  let playbackCross = null;
  try { twin.twinPlayback(dmvpm, "proj-r47"); } catch (e) { playbackCross = e; }
  assert(playbackCross?.statusCode === 404, "playback is same-404 across tenants");

  const TABLES = [
    "projects", "milestones", "evidence_items", "verifications", "ledger_entries",
    "draw_requests", "approval_requests", "approval_records", "exceptions", "disputes",
    "permits", "jurisdictional_inspections", "permit_basis_versions", "source_verifications",
    "evidence_signals", "evidence_review_queue", "source_snapshots", "source_review_items",
    "banking_events", "virtual_account_events", "config_audit", "spatial_features",
  ];
  const before = {};
  for (const t of TABLES) before[t] = tableHash(t);
  twin.twinScene(funder, "proj-r47");
  twin.twinScene(field, "proj-r47");
  twin.twinScene(funder, "proj-dmv");
  twin.twinPlayback(funder, "proj-r47");
  twin.twinPinDetail(funder, "proj-r47", gpsEvidence[0].id);
  twin.twinCoverage(funder, "proj-r47");
  twin.twinSnapshots(funder);
  twin.twinProviderReadiness();
  for (const t of TABLES) {
    assert(before[t] === tableHash(t), `${t} byte-identical after exercising the entire twin surface`);
  }

  // ------------------------------------------------------ 10. performance
  console.log("\n== 10. Large-history performance ==");
  const BULK = 1200;
  for (let i = 0; i < BULK; i += 1) {
    repo.insertConfigAudit({
      id: repo.newId(),
      projectId: "proj-r47",
      actorUserId: "user-funder",
      action: "BULK_TWIN_EVENT",
      entityType: "milestone",
      entityId: milestones[0].id,
      reason: null,
      beforeSummary: null,
      afterSummary: `synthetic event ${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 60), (i % 60) * 16)).toISOString(),
    });
  }
  let t0 = Date.now();
  const bigScene = twin.twinScene(funder, "proj-r47");
  const sceneMs = Date.now() - t0;
  assert(bigScene.sync.length >= BULK, `large scene sync covers the bulk history (${bigScene.sync.length} entries)`);
  assert(sceneMs < 4000, `large scene built in ${sceneMs}ms (budget 4000ms)`);
  t0 = Date.now();
  const bigPlayback = twin.twinPlayback(funder, "proj-r47");
  const pbMs = Date.now() - t0;
  assert(pbMs < 4000, `large playback built in ${pbMs}ms (budget 4000ms)`);
  assert(bigPlayback.truncated && bigPlayback.steps.length === twin.PLAYBACK_STEP_CAP,
    `oversized playback is capped at ${twin.PLAYBACK_STEP_CAP} steps AND says so`);
  assert(bigPlayback.totalEvents >= BULK, "the cap reports the true total");

  // ------------------------------------------------------ 11. frontend
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

  const twinPage = await page("/timeline/twin/proj-r47", cookie);
  assert(twinPage.status === 200, "twin page renders");
  assert(/id="twin-scene"/.test(twinPage.html), "the isometric scene SVG is rendered");
  assert(/id="twin-playbar"/.test(twinPage.html), "the playback bar is rendered");
  assert(/data-layer-toggle/.test(twinPage.html), "layer toggles are rendered");
  assert(/Construction progress/.test(twinPage.html), "the stage progress panel is rendered");
  assert(/not a physical measurement/.test(twinPage.html), "the page states progress is governance lifecycle");
  assert(/owns no data, performs no writes/.test(twinPage.html), "the page carries the twin doctrine notice");
  assert(/\/js\/twin\.js/.test(twinPage.html), "the client enhancement script is referenced");
  assert(/twin-data/.test(twinPage.html), "the sync/element index is embedded for the client");
  assert(/DroneDeploy — disabled/.test(twinPage.html) && /Cesium — disabled/.test(twinPage.html),
    "future providers are shown as disabled boundaries");
  assert(fs.existsSync(path.join(ROOT, "public/js/twin.js")), "the compiled client script exists");

  const sceneApi = await (await fetch(`${BASE}/api/twin/scene/proj-r47`, { headers: { cookie } })).json();
  const pinId = sceneApi.elements.find((e) => e.kind === "EVIDENCE_PIN").sourceRecordId;
  const drawer = await page(`/timeline/twin/proj-r47?pin=${pinId}`, cookie);
  assert(/Evidence detail/.test(drawer.html) && /twin-photo/.test(drawer.html),
    "the pin drawer renders the photo preview");
  assert(/Distance to planned stage geometry/.test(drawer.html), "the drawer shows the real planned-geometry distance");

  const tlPage = await page("/timeline/project/proj-r47", cookie);
  assert(/twin-mode-tabs/.test(tlPage.html), "the Timeline page carries the Timeline | Digital Twin tabs");
  assert(/show in twin/.test(tlPage.html), "every timeline event row links into the twin (?focus=)");
  const focusId = /href="\/timeline\/twin\/proj-r47\?focus=([^"]+)"/.exec(tlPage.html);
  assert(Boolean(focusId), "a focus deep-link is present");
  const focused = await page(`/timeline/twin/proj-r47?focus=${focusId[1]}`, cookie);
  assert(focused.status === 200, "a focus deep-link renders the twin page");

  const portfolio = await page("/timeline", cookie);
  assert(/Digital Twin snapshot/.test(portfolio.html) && /twin-snap-card/.test(portfolio.html),
    "the portfolio page shows miniature twins");
  const site = await page("/timeline/site/proj-r47", cookie);
  assert(/Coverage \(Digital Twin\)/.test(site.html) && /twin-heat-cell/.test(site.html),
    "site intelligence shows the coverage band and activity heatmap");

  assert((await status("/api/twin/scene/proj-r47", dmvCookie)) === 404, "cross-tenant scene API is 404");
  assert((await status("/timeline/twin/proj-r47", dmvCookie)) === 404, "cross-tenant twin page is 404");
  assert((await status("/api/twin/scene/proj-r47")) === 401, "anonymous API access is 401");
  const anon = await page("/timeline/twin/proj-r47");
  assert([302, 303].includes(anon.status), "anonymous twin page redirects to sign-in");
  assert((await status("/api/twin/scene/proj-r47", cookie, { method: "POST" })) === 405,
    "the twin API refuses non-GET requests (read-only)");
  assert((await status("/api/twin/pin/proj-r47/%", cookie)) === 404,
    "a malformed pin id is a 404, not a 500");
  assert((await status(`/api/twin/pin/proj-r47/${dmvCookie ? "no-such" : "x"}`, cookie)) === 404,
    "an unknown pin id is a plain 404");

  console.log(`\nDIGITAL TWIN TESTS PASSED — ${passed} checkpoints.`);
  console.log("THE TWIN SHOWS THE RECORD. THE TIMELINE REMAINS AUTHORITATIVE.");
}

main()
  .catch((err) => { console.error(err.stack ?? err); process.exitCode = 1; })
  .finally(() => {
    try { if (server) server.kill(); } catch {}
    try { fs.rmSync(DATA_A, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(DATA_B, { recursive: true, force: true }); } catch {}
  });
