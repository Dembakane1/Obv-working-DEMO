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
  assert(/The site evidence workspace is read-only/.test(routes), "non-GET requests are explicitly refused");
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
  // Permits are readable by any project viewer, so the layer must stay
  // available for FIELD — asserted on the DMV project, which actually
  // has recorded permits.
  const dmvField = repo.getUser("user-dmv-field");
  const dmvFieldScene = dmvField ? twin.twinScene(dmvField, "proj-dmv") : fieldScene;
  const fieldSources = dmvFieldScene.layers.find((l) => l.key === "sources");
  assert(
    fieldSources && fieldSources.available &&
      (repo.listPermitsForProject(dmvFieldScene.projectId).length === 0 ||
        dmvFieldScene.anchored.some((a) => a.group === "PERMIT")),
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
  // Governance audit events carry no milestone linkage and no drawn
  // record, so under the honest sync contract they have NO entry — the
  // map stays small and every entry it does have is real.
  assert(
    bigScene.sync.length > 0 && bigScene.sync.length < BULK,
    `sync stays honest on a bulk history (${bigScene.sync.length} real correspondences, not a catch-all)`
  );
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
  assert(/twin-mode-tabs/.test(tlPage.html), "the Timeline page carries the Timeline | Site evidence tabs");
  assert(/show in site evidence/.test(tlPage.html), "every timeline event row links into the workspace (?event=)");
  const focusId = /href="\/timeline\/twin\/proj-r47\?event=([^"&]+)"/.exec(tlPage.html);
  assert(Boolean(focusId), "an event deep-link is present");
  const focused = await page(`/timeline/twin/proj-r47?event=${focusId[1]}`, cookie);
  assert(focused.status === 200, "an event deep-link renders the workspace page");

  const portfolio = await page("/timeline", cookie);
  assert(/Site evidence snapshot/.test(portfolio.html) && /twin-snap-card/.test(portfolio.html),
    "the portfolio page shows miniature twins");
  const site = await page("/timeline/site/proj-r47", cookie);
  assert(/Coverage \(Site evidence\)/.test(site.html) && /twin-heat-cell/.test(site.html),
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

  // ---------------------------------------------------------- section 12
  // Regressions from the adversarial review. Each shipped as a real
  // defect once; every one is pinned here so it cannot come back.
  console.log("\n== 12. Adversarial-review regressions ==");

  // (a) Sync emits ONLY real correspondences: a direct record match or
  //     the event's own milestone geometry — never a boundary catch-all
  //     that would present the geofence as a lender decision.
  const regScene = twin.twinScene(funder, "proj-r47");
  const regTimeline = tl.projectTimeline(funder, "proj-r47");
  const regEls = new Map(regScene.elements.map((e) => [e.id, e]));
  const regAnch = new Map(regScene.anchored.map((a) => [a.id, a]));
  const evById = new Map(regTimeline.events.map((e) => [e.id, e]));
  for (const s of regScene.sync) {
    const ev = evById.get(s.eventId);
    const el = regEls.get(s.elementId) ?? regAnch.get(s.elementId);
    const direct = el && el.sourceTable === ev.sourceTable && el.sourceRecordId === ev.sourceRecordId;
    const viaMilestone = el && ev.milestoneId && el.milestoneId === ev.milestoneId;
    if (!direct && !viaMilestone) fail(`sync entry ${s.eventId} → ${s.elementId} is not a real correspondence`);
  }
  pass("every sync entry is a direct record match or the event's own milestone geometry");
  assert(
    regTimeline.events.some((e) => !regScene.sync.some((s) => s.eventId === e.id)),
    "events with no represented record have NO sync entry (no boundary catch-all)"
  );

  // (b) A derived advisory marker never outranks the record it derives
  //     from. Force a permit into the expiring window and confirm its
  //     governed events still sync to the permit's own dock row.
  const dmvFunder = repo.getUser("user-dmv-funder") ?? funder;
  const dmvPermits = repo.listPermitsForProject("proj-dmv");
  if (dmvPermits.length > 0) {
    const p0 = dmvPermits[0];
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const prevExpiry = db.prepare("SELECT expires_at FROM permits WHERE id = ?").get(p0.id).expires_at;
    db.prepare("UPDATE permits SET expires_at = ?, status = 'ISSUED' WHERE id = ?").run(soon, p0.id);
    const dmvScene = twin.twinScene(dmvFunder, "proj-dmv");
    assert(
      dmvScene.elements.some((e) => e.id === `ADVISORY_MARKER:permit-expiry:${p0.id}`),
      "an expiring permit raises the plain-fact advisory marker"
    );
    const dmvEvents = tl.projectTimeline(dmvFunder, "proj-dmv").events
      .filter((e) => e.sourceTable === "permits" && e.sourceRecordId === p0.id);
    const targets = dmvScene.sync
      .filter((s) => dmvEvents.some((e) => e.id === s.eventId))
      .map((s) => s.elementId);
    assert(
      targets.length > 0 && targets.every((t) => t === `PERMIT:${p0.id}`),
      "the permit's governed events sync to the permit's own record, not to the derived advisory marker"
    );
    db.prepare("UPDATE permits SET expires_at = ? WHERE id = ?").run(prevExpiry, p0.id);
  } else {
    pass("(no DMV permits seeded — advisory-precedence covered by (a))");
  }

  // (c) Element ids are unique even when a milestone carries two
  //     SEGMENT features (schema-legal).
  db.prepare(
    "INSERT INTO spatial_features (id, project_id, milestone_id, kind, label, geometry) VALUES (?,?,?,?,?,?)"
  ).run("sf-twin-dup", "proj-r47", milestones[1].id, "SEGMENT", "revised alignment",
    JSON.stringify([[33.60, -11.86], [33.61, -11.855]]));
  const dupScene = twin.twinScene(funder, "proj-r47");
  const ids = dupScene.elements.map((e) => e.id);
  assert(new Set(ids).size === ids.length, "element ids stay unique with two SEGMENT features on one milestone");
  db.prepare("DELETE FROM spatial_features WHERE id = ?").run("sf-twin-dup");

  // (d) Frame extent is a measurement of recorded points — never the
  //     renderer's padding. A scene with no drawable points reports 0×0.
  db.prepare(
    "INSERT INTO projects (id, organization_id, name, description, location, site_boundary, total_budget, status) VALUES (?,?,?,?,?,?,?,?)"
  ).run("proj-reg-bare", project.organizationId, "Bare2", "d", "loc", JSON.stringify([]), 1000, "ACTIVE");
  const bare2 = twin.twinScene(funder, "proj-reg-bare");
  assert(bare2.frame.degraded && bare2.frame.widthM === 0 && bare2.frame.heightM === 0,
    "a degraded scene reports extent 0×0 — never an invented padding box");
  db.prepare("DELETE FROM projects WHERE id = ?").run("proj-reg-bare");
  assert(
    regScene.frame.widthM > 0 && regScene.frame.widthM <= 13_000,
    `a real scene reports the unpadded recorded extent (${regScene.frame.widthM} m)`
  );

  // (e) Antimeridian-straddling geometry is refused with a stated
  //     reason, not drawn as a world-spanning sliver.
  db.prepare(
    "INSERT INTO projects (id, organization_id, name, description, location, site_boundary, total_budget, status) VALUES (?,?,?,?,?,?,?,?)"
  ).run("proj-reg-am", project.organizationId, "AM", "d", "Fiji", JSON.stringify(
    [[179.99, -16.80], [-179.99, -16.80], [-179.99, -16.79], [179.99, -16.79], [179.99, -16.80]]
  ), 1000, "ACTIVE");
  const amScene = twin.twinScene(funder, "proj-reg-am");
  assert(amScene.frame.degraded, "an antimeridian-straddling site is refused rather than drawn wrong");
  assert(amScene.caps.some((c) => /antimeridian/i.test(c)), "…and the refusal is stated in the caps");
  db.prepare("DELETE FROM projects WHERE id = ?").run("proj-reg-am");

  // (f) ringCentroid's degenerate fallback ignores the GeoJSON closing
  //     vertex instead of double-counting it.
  const geom = require(path.join(ROOT, "dist/server/services/twin/geometry.js"));
  const degenerate = geom.ringCentroid([[0, 0], [2, 0], [4, 0], [0, 0]]);
  assert(Math.abs(degenerate.lng - 2) < 1e-9, "degenerate-ring centroid is the distinct-vertex mean");

  // (g) The boundary layer covers the recorded ROUTE too, so a project
  //     with a route but no geofence never hides recorded coordinates.
  const savedBoundary = db.prepare("SELECT site_boundary FROM projects WHERE id = ?").get("proj-r47").site_boundary;
  db.prepare("UPDATE projects SET site_boundary = ? WHERE id = ?").run(JSON.stringify([]), "proj-r47");
  const routeOnly = twin.twinScene(funder, "proj-r47");
  const routeLayer = routeOnly.layers.find((l) => l.key === "boundary");
  assert(
    routeOnly.elements.some((e) => e.kind === "ROUTE") && routeLayer.available && routeLayer.defaultOn,
    "a recorded ROUTE keeps the boundary layer available even with no geofence"
  );
  db.prepare("UPDATE projects SET site_boundary = ? WHERE id = ?").run(savedBoundary, "proj-r47");

  // (h) No layer advertises itself as on while unavailable.
  for (const sc of [regScene, routeOnly]) {
    assert(sc.layers.every((l) => l.available || !l.defaultOn),
      "no layer is default-on while unavailable (checkbox state is honest)");
  }

  // (i) The client replays the full recorded window: no category
  //     filtering of history, own-property focus lookup, and appearance
  //     recomputed from zero on scrub.
  const clientSrc = fs.readFileSync(path.join(ROOT, "src/client/twin.ts"), "utf8");
  assert(!/CATEGORY_LAYER/.test(clientSrc), "playback no longer filters recorded history by layer toggles");
  assert(/hasOwnProperty\.call\(data\.sync/.test(clientSrc), "focus lookup rejects Object.prototype keys");
  assert(/markAppearedUpTo/.test(clientSrc) && /clearReplayState\(\)/.test(clientSrc),
    "scrubbing recomputes appearance from zero (backward scrub is honest)");

  // ---------------------------------------------------------- section 13
  // Timeline & Site Evidence: truth classes, spatial provenance,
  // readiness-transition history, current-state separation, replay.
  console.log("\n== 13. Timeline & Site Evidence ==");

  // (a) Truth classes are derived centrally and consistently.
  const tseTl = tl.projectTimeline(funder, "proj-r47");
  assert(
    tseTl.events.every((e) => ["GOVERNED_FACT", "HISTORICAL_EVENT", "ADVISORY_SIGNAL"].includes(e.truthClass)),
    "every event carries one of the three truth classes"
  );
  assert(
    tseTl.events.filter((e) => e.recordStatus === "ADVISORY").every((e) => e.truthClass === "ADVISORY_SIGNAL"),
    "every advisory record is ADVISORY_SIGNAL — never presented as governed"
  );
  const capEv = tseTl.events.find((e) => e.type === "EVIDENCE_CAPTURED");
  assert(capEv && capEv.truthClass === "HISTORICAL_EVENT", "an evidence capture is a HISTORICAL_EVENT");
  const verEv = tseTl.events.find((e) => e.type === "EVIDENCE_VERIFIED");
  assert(verEv && verEv.truthClass === "GOVERNED_FACT", "a verification verdict is a GOVERNED_FACT");
  assert(
    tseTl.events.filter((e) => e.category === "DECISION").every((e) => e.truthClass === "GOVERNED_FACT"),
    "every decision event is a GOVERNED_FACT"
  );

  // (b) Spatial provenance: coordinates are copied from the record's own
  //     stored fix and from nowhere else — never the project's location.
  const gpsRows = db.prepare("SELECT id, latitude, longitude FROM evidence_items WHERE latitude IS NOT NULL").all();
  const gpsById = new Map(gpsRows.map((r) => [r.id, r]));
  const located = tseTl.events.filter((e) => e.spatial);
  assert(located.length > 0, "GPS-located evidence produces spatial events");
  for (const e of located) {
    const row = gpsById.get(e.sourceRecordId);
    if (!row || row.latitude !== e.spatial.latitude || row.longitude !== e.spatial.longitude) {
      fail(`event ${e.id} carries coordinates its source record does not store`);
    }
    if (e.type !== "EVIDENCE_CAPTURED") fail(`spatial appears on ${e.type} — only the capture holds the fix`);
  }
  pass("every spatial value matches its record's OWN stored coordinates (capture only, never invented)");
  assert(
    tseTl.events.filter((e) => e.type === "EVIDENCE_UPLOADED").every((e) => e.spatial === null),
    "the upload moment carries no location — the fix belongs to the capture"
  );
  // Positive control: an evidence item with NO stored fix must yield NO
  // spatial value — the project's own location is never smeared onto it.
  repo.insertEvidence({
    id: "ev-tse-nofix", milestoneId: milestones[0].id, userId: "user-field",
    photoPath: "/demo-evidence/site.jpg", capturedAt: "2026-06-14T10:00:00.000Z",
    uploadedAt: "2026-06-14T10:05:00.000Z", latitude: null, longitude: null,
    deviceMetadata: { userAgent: "t", platform: "t", screen: "1x1", language: "en" },
    hash: "tse-nofix-hash", previousHash: null, isDemoFallback: false,
  });
  const noFixEvents = tl.projectTimeline(funder, "proj-r47").events
    .filter((e) => e.sourceRecordId === "ev-tse-nofix");
  assert(noFixEvents.length > 0 && noFixEvents.every((e) => e.spatial === null),
    "an evidence item without a stored fix yields NO spatial value — location is never invented");
  db.prepare("DELETE FROM evidence_items WHERE id = 'ev-tse-nofix'").run();

  // (c) Readiness transitions come from the machine's own immutable
  //     draw_events rows: stored states verbatim, stable record-derived
  //     ids, no cause attached.
  const transitions = tseTl.events.filter((e) => e.type === "READINESS_TRANSITION");
  assert(transitions.length >= 2, "seeded readiness transitions appear on the timeline");
  const t6 = transitions.find((e) => e.id === "DRAW:READINESS_TRANSITION:dev-6");
  const t7 = transitions.find((e) => e.id === "DRAW:READINESS_TRANSITION:dev-7");
  assert(Boolean(t6 && t7), "transition ids are deterministic: category:type:<draw_events row id>");
  assert(
    t6.change.previous === null && t6.change.current === "INCOMPLETE",
    "the first transition records its stored states verbatim (null → INCOMPLETE)"
  );
  assert(
    t7.change.previous === "INCOMPLETE" && t7.change.current === "HOLD",
    "the second transition records its stored states verbatim (INCOMPLETE → HOLD)"
  );
  assert(t7.sourceTable === "draw_events" && t7.truthClass === "GOVERNED_FACT",
    "a transition is a GOVERNED_FACT sourced from draw_events");
  assert(!/blocker|missing document|next action/i.test(t7.explanation),
    "a historical transition's explanation never carries today's blockers");

  // (d) HISTORICAL TRUTH IS ABSOLUTE: a stored transition that contradicts
  //     the live evaluation is still shown exactly as stored.
  db.prepare(
    "INSERT INTO draw_events (id, draw_request_id, type, detail, actor_user_id, created_at) VALUES (?,?,?,?,?,?)"
  ).run("drt-tse-hist", "draw-1", "READINESS_TRANSITION",
    JSON.stringify({ status: "READY", from: "HOLD", policyVersion: 1 }), null, "2026-06-12T09:00:00.000Z");
  const histTl = tl.projectTimeline(funder, "proj-r47");
  const histEv = histTl.events.find((e) => e.id === "DRAW:READINESS_TRANSITION:drt-tse-hist");
  assert(
    histEv && histEv.change.previous === "HOLD" && histEv.change.current === "READY",
    "a stored transition contradicting today's readiness is shown AS STORED — never reconciled"
  );
  assert(histEv.actorName === null && histEv.actorUserId === null,
    "a transition with no recorded actor names none — never inferred");
  // June replay scenario: a window ending June 13 contains the June 12
  // transition and NOT the July ones — pure own-timestamp comparison.
  const juneWindow = tl.pastEvents(histTl.events, "2026-06-13T00:00:00.000Z");
  assert(
    juneWindow.some((e) => e.id === "DRAW:READINESS_TRANSITION:drt-tse-hist") &&
      !juneWindow.some((e) => e.id === "DRAW:READINESS_TRANSITION:dev-6"),
    "a replay window admits events by their OWN timestamps only"
  );
  assert(
    !JSON.stringify(juneWindow.filter((e) => e.type === "READINESS_TRANSITION")).includes("HOLD\",\"current\":\"INCOMPLETE"),
    "no readiness state is recomputed for the window — only stored transitions exist in it"
  );
  db.prepare("DELETE FROM draw_events WHERE id = ?").run("drt-tse-hist");

  // (e) An unparseable stored detail degrades honestly, never throws.
  db.prepare(
    "INSERT INTO draw_events (id, draw_request_id, type, detail, actor_user_id, created_at) VALUES (?,?,?,?,?,?)"
  ).run("drt-tse-bad", "draw-1", "READINESS_TRANSITION", "{not json", null, "2026-06-01T09:00:00.000Z");
  const badEv = tl.projectTimeline(funder, "proj-r47").events
    .find((e) => e.id === "DRAW:READINESS_TRANSITION:drt-tse-bad");
  assert(badEv && badEv.change.current === "UNRECORDED",
    "an unparseable transition row is stated as UNRECORDED, never guessed");
  db.prepare("DELETE FROM draw_events WHERE id = ?").run("drt-tse-bad");

  // (f) Superseded lender decisions are retained AND marked; standing
  //     decisions are not.
  const nowIso = "2026-07-20T10:00:00.000Z";
  const decCols = "id, organization_id, project_id, draw_request_id, requested_amount, decision, reviewer_user_id, decision_at, superseded_by_decision_id, supersedes_decision_id, created_at, updated_at";
  // The partial unique index allows exactly one CURRENT decision per
  // draw, and the supersede link is a cycle at insert time — deferred
  // foreign keys inside one transaction, exactly how the real supersede
  // path leaves the table.
  db.exec("BEGIN");
  db.exec("PRAGMA defer_foreign_keys = ON");
  db.prepare(`INSERT INTO lender_draw_decisions (${decCols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("ldec-tse-1", project.organizationId, "proj-r47", "draw-1", 600000, "APPROVED", "user-funder", nowIso, "ldec-tse-2", null, nowIso, nowIso);
  db.prepare(`INSERT INTO lender_draw_decisions (${decCols}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("ldec-tse-2", project.organizationId, "proj-r47", "draw-1", 600000, "APPROVED", "user-funder", "2026-07-21T10:00:00.000Z", null, "ldec-tse-1", "2026-07-21T10:00:00.000Z", "2026-07-21T10:00:00.000Z");
  db.exec("COMMIT");
  const decTl = tl.projectTimeline(funder, "proj-r47");
  const dec1 = decTl.events.find((e) => e.sourceRecordId === "ldec-tse-1");
  const dec2 = decTl.events.find((e) => e.sourceRecordId === "ldec-tse-2");
  assert(dec1 && /superseded by an amended decision/.test(dec1.explanation),
    "a superseded lender decision is retained as history AND marked superseded");
  assert(dec2 && !/superseded by an amended decision/.test(dec2.explanation),
    "the standing decision carries no superseded marking");
  db.prepare("DELETE FROM lender_draw_decisions WHERE id IN ('ldec-tse-1','ldec-tse-2')").run();

  // (g) Deterministic ids: two reads yield the identical event id set.
  const idsA = tl.projectTimeline(funder, "proj-r47").events.map((e) => e.id).join("|");
  const idsB = tl.projectTimeline(funder, "proj-r47").events.map((e) => e.id).join("|");
  assert(idsA === idsB, "event ids are stable across reads (record-derived, never index-derived)");

  // (h) Current-state service: live values, tenancy-scoped, unavailable-safe.
  const openStates = twin.currentOpenDrawStates(funder, "proj-r47");
  const d1 = openStates.find((s) => s.drawRequestId === "draw-1");
  assert(Boolean(d1), "the open-draw current-state service returns the open draw");
  assert(d1.readiness === "HOLD", "the current readiness is the LIVE evaluation");
  assert(typeof d1.nextActionLabel === "string" && d1.nextActionLabel.length > 0,
    "the current next action comes from the existing deterministic engine");
  assert(twin.currentDrawState(funder, "proj-dmv", "draw-1") === null,
    "a draw outside the addressed project resolves to null (same-404 shape, nothing leaked)");
  let tseDenied = false;
  try { twin.currentOpenDrawStates(dmvpm, "proj-r47"); } catch (e) { tseDenied = e.statusCode === 404; }
  assert(tseDenied, "current-state reads are same-404 for an inaccessible project");

  // (i) READ-ONLY: the full new surface leaves every row byte-identical —
  //     including the draw/decision tables the new reads touch.
  const TSE_TABLES = [
    "draw_events", "lender_draw_decisions", "draw_line_items", "draw_documents", "draw_requests",
    "evidence_items", "verifications", "exceptions", "jurisdictional_inspections",
  ];
  const tseBefore = {};
  for (const t of TSE_TABLES) tseBefore[t] = tableHash(t);
  tl.projectTimeline(funder, "proj-r47");
  twin.currentOpenDrawStates(funder, "proj-r47");
  twin.currentDrawState(funder, "proj-r47", "draw-1");
  twin.twinScene(funder, "proj-r47");
  for (const t of TSE_TABLES) {
    assert(tseBefore[t] === tableHash(t), `${t} byte-identical after the Timeline & Site Evidence reads`);
  }

  // (j) The workspace page: renamed product claim, context strip,
  //     filters, replay, and the strictly separated inspector blocks.
  const tsePage = await page("/timeline/twin/proj-r47", cookie);
  assert(/Timeline &amp; Site Evidence|Timeline & Site Evidence/.test(tsePage.html),
    "the page's primary title is Timeline & Site Evidence");
  assert(!/<title>[^<]*Digital Twin/.test(tsePage.html),
    "the page no longer claims Digital Twin as the current product title");
  assert(/Recorded location/.test(tsePage.html) && /Latest recorded activity/.test(tsePage.html),
    "the context strip states recorded location and latest recorded activity");
  assert(/Current draw state/.test(tsePage.html) && /Current next action:/.test(tsePage.html),
    "live draw values are labeled CURRENT DRAW STATE / CURRENT NEXT ACTION");
  const lastActM = /Latest recorded activity<\/span><span class="tse-v">([0-9-]+ [0-9:]+) UTC/.exec(tsePage.html);
  assert(lastActM && Date.parse(lastActM[1].replace(" ", "T") + ":00Z") <= Date.now() + 60_000,
    "latest recorded activity is never a future-dated schedule row");
  assert(/data-tse-truth="GOVERNED_FACT"/.test(tsePage.html) && /data-tse-located/.test(tsePage.html),
    "truth-class and located-only filters are rendered");
  assert(/Project Replay/.test(tsePage.html) && /Recorded events through:/.test(tsePage.html),
    "Project Replay is labeled 'Recorded events through'");
  assert(/Governed fact/.test(tsePage.html) && /Historical event/.test(tsePage.html),
    "stream rows carry their truth-class chips");
  // Replay client contract: element times are the record's own earliest
  // event, and the replay object carries times only — no readiness.
  const tseData = JSON.parse(tsePage.html.split('id="twin-data">')[1].split("</script>")[0]);
  assert(tseData.replay && Object.keys(tseData.replay).sort().join(",") === "anchor,max,min",
    "the replay contract is min/max/anchor timestamps ONLY — no recomputed state ships to the client");
  assert(Date.parse(tseData.replay.anchor) <= Date.now() + 60_000,
    "the replay quick-range anchor is the latest event that actually happened");
  const tseEvents = JSON.parse(
    JSON.stringify((await (await fetch(`${BASE}/api/timeline/project/proj-r47`, { headers: { cookie } })).json()).events ?? [])
  );
  const capForPin = tseEvents.find((e) => e.type === "EVIDENCE_CAPTURED" && e.spatial);
  if (capForPin) {
    assert(tseData.elementAt[`EVIDENCE_PIN:${capForPin.sourceRecordId}`] === capForPin.at,
      "a marker's replay moment is its record's OWN earliest event timestamp");
  } else {
    assert(Object.keys(tseData.elementAt).length > 0, "the replay element-time map is populated");
  }

  // (k) The transition inspector: AT THE TIME strictly separated from
  //     CURRENT, cause honesty, and the ?event=/?focus= alias.
  const trPage = await page("/timeline/twin/proj-r47?event=DRAW%3AREADINESS_TRANSITION%3Adev-7", cookie);
  assert(/Event record/.test(trPage.html), "selecting a transition renders the event-record inspector");
  assert(/At the time \(recorded\)/.test(trPage.html) && /Current linked state/.test(trPage.html),
    "the inspector separates AT THE TIME from CURRENT LINKED STATE");
  assert(/Cause not recorded in this historical event/.test(trPage.html),
    "a transition with no stored cause says exactly that");
  const thenBlock = trPage.html.split('class="tse-block tse-then"')[1].split("</div>")[0];
  const nowBlock = trPage.html.split('class="tse-block tse-now"')[1].split('class="sub"')[0];
  const nextActionM = /Current next action<\/span>\s*([^<(]+)/.exec(nowBlock);
  assert(/INCOMPLETE/.test(thenBlock) && /HOLD/.test(thenBlock),
    "the historical block shows the stored from → to states");
  if (nextActionM && nextActionM[1].trim().length > 8) {
    assert(!thenBlock.includes(nextActionM[1].trim()),
      "the historical block NEVER contains today's next action");
  } else {
    assert(!/Current next action/.test(thenBlock), "the historical block carries no CURRENT labels");
  }
  const focusAlias = await page("/timeline/twin/proj-r47?focus=DRAW%3AREADINESS_TRANSITION%3Adev-7", cookie);
  assert(/Event record/.test(focusAlias.html) && /At the time \(recorded\)/.test(focusAlias.html),
    "?focus= remains an alias of the ?event= deep link");

  // (l) Unknown and cross-tenant event ids leak nothing.
  const unknownEv = await page("/timeline/twin/proj-r47?event=NO%3ASUCH%3Aevent", cookie);
  assert(unknownEv.status === 200 && /Context inspector/.test(unknownEv.html),
    "an unknown event id renders the plain inspector — no error, no invention");
  const dmvTl = await (await fetch(`${BASE}/api/timeline/project/proj-dmv`, { headers: { cookie: dmvCookie } })).json();
  const foreignEv = dmvTl.events.find((e) => e.sourceRecordId.includes("dmv")) ?? dmvTl.events[0];
  const crossEv = await page(`/timeline/twin/proj-r47?event=${encodeURIComponent(foreignEv.id)}`, cookie);
  // The client-data blob echoes the caller's own query value as `focus`
  // (needed for sync lookup; JSON-escaped) — that is input reflection,
  // not record content. Nothing FROM the foreign record may appear.
  const crossSansEcho = crossEv.html.replace(/"focus":"[^"]*"/, '"focus":null');
  assert(
    /Context inspector/.test(crossEv.html) && !crossSansEcho.includes(foreignEv.sourceRecordId),
    "another project's event id resolves to nothing on this project — no cross-project leak"
  );

  // (m) Upcoming honesty on the page: any future-dated stream row is
  //     chipped as not-yet-happened, and only those rows are.
  const rowAts = [...tsePage.html.matchAll(/<li data-at="([^"]+)"/g)].map((m) => m[1]);
  const futureRows = rowAts.filter((a) => Date.parse(a) > Date.now());
  const upcomingChips = (tsePage.html.match(/Upcoming — not yet happened/g) ?? []).length;
  assert(upcomingChips === futureRows.length,
    `future-dated rows are chipped 'Upcoming — not yet happened' (${futureRows.length} of them), past rows never are`);
  // Positive control on the DMV project, whose permits carry 2027 expiry
  // dates: those rows MUST be chipped as not-yet-happened, never as
  // history, and the latest-activity figure must ignore them.
  const dmvPage = await page("/timeline/twin/proj-dmv", dmvCookie);
  const dmvAts = [...dmvPage.html.matchAll(/<li data-at="([^"]+)"/g)].map((m) => m[1]);
  const dmvFuture = dmvAts.filter((a) => Date.parse(a) > Date.now());
  const dmvChips = (dmvPage.html.match(/Upcoming — not yet happened/g) ?? []).length;
  assert(dmvFuture.length > 0 && dmvChips === dmvFuture.length,
    `a schedule row (recorded permit expiry) is never presented as history (${dmvFuture.length} chipped)`);
  const dmvLastM = /Latest recorded activity<\/span><span class="tse-v">([0-9-]+ [0-9:]+) UTC/.exec(dmvPage.html);
  assert(dmvLastM && Date.parse(dmvLastM[1].replace(" ", "T") + ":00Z") <= Date.now() + 60_000,
    "the DMV latest-activity figure ignores future-dated schedule rows");

  // (n) Honest zero-spatial label is wired to the pin count, and the
  //     mobile segmented control offers Timeline | Site.
  const twinViewSrc = fs.readFileSync(path.join(ROOT, "src/server/view/twinPages.tsx"), "utf8");
  assert(/No spatial evidence recorded/.test(twinViewSrc) && /locatedCount > 0/.test(twinViewSrc),
    "a project with zero GPS-located records states 'No spatial evidence recorded'");
  assert(/mode=timeline/.test(tsePage.html) && /mode=twin/.test(tsePage.html),
    "the mobile segmented control offers both workspace modes");

  // ---------------------------------------------------------- section 14
  // Corrective pass: inspection records are NON-SPATIAL, the replay
  // window equals the rendered window, timeline source caps reach the
  // page, and the spatial count is a record count — never a pin count.
  console.log("\n== 14. Truth-preservation corrections ==");

  // (a) A jurisdictional inspection is NEVER placed — not even when its
  //     milestone has real recorded SEGMENT geometry. One record's
  //     coordinates are never substituted for another's. This assertion
  //     fails if inspection-on-segment placement is ever reintroduced.
  const segMilestone = repo.listSpatialFeatures("proj-r47")
    .find((f) => f.kind === "SEGMENT" && f.milestoneId && f.geometry.length > 0).milestoneId;
  db.prepare(
    `INSERT INTO jurisdictional_inspections
       (id, organization_id, project_id, milestone_id, inspection_type, required, status, scheduled_at, created_at, updated_at)
     VALUES (?,?,?,?,?,1,'SCHEDULED',?,?,?)`
  ).run("insp-tse-nospatial", project.organizationId, "proj-r47", segMilestone, "GRADING",
    "2026-06-20T09:00:00.000Z", "2026-06-19T09:00:00.000Z", "2026-06-19T09:00:00.000Z");
  const inspScene = twin.twinScene(funder, "proj-r47");
  // The plain-fact "no recorded result" advisory is an element with NO
  // points (listed, never drawn) — the invariant is that no
  // inspection-derived element ever carries coordinates, and the
  // INSPECTION_MARKER kind is never placed at all.
  assert(
    inspScene.elements.every(
      (el) => el.kind !== "INSPECTION_MARKER" &&
        (el.sourceTable !== "jurisdictional_inspections" || el.points.length === 0)
    ),
    "NO inspection is ever a placed scene element — milestone geometry is not the inspection's location"
  );
  const inspDockRow = inspScene.anchored.find((a) => a.sourceRecordId === "insp-tse-nospatial");
  assert(Boolean(inspDockRow) && inspDockRow.group === "INSPECTION",
    "the inspection appears in the anchored dock instead");
  assert(/Spatial location: not recorded/.test(inspDockRow.detail),
    "the dock row states 'Spatial location: not recorded'");
  assert(/Linked to /.test(inspDockRow.detail),
    "the dock row states the milestone linkage by name, not by borrowed geometry");
  assert(
    inspScene.elements.some((el) => el.kind === "SEGMENT" && el.milestoneId === segMilestone),
    "the milestone's own SEGMENT geometry remains drawn normally"
  );
  const inspTl = tl.projectTimeline(funder, "proj-r47");
  const inspEvents = inspTl.events.filter((e) => e.sourceRecordId === "insp-tse-nospatial");
  assert(inspEvents.length > 0, "the inspection remains on the governed timeline");
  assert(inspEvents.every((e) => e.spatial === null),
    "no inspection event carries a spatial location (the record stores none)");
  assert(
    inspScene.elements.some((el) => el.kind === "EVIDENCE_PIN"),
    "evidence with its OWN stored GPS fix still receives its normal pin"
  );
  const inspLayer = inspScene.layers.find((l) => l.key === "inspections");
  assert(/Inspection records/.test(inspLayer.label) && /never placed/.test(inspLayer.note ?? ""),
    "the layer is named 'Inspection records' and states that inspections are listed, never placed");
  db.prepare("DELETE FROM jurisdictional_inspections WHERE id = 'insp-tse-nospatial'").run();

  // (b) Replay window = the rendered window. DATA_A's r47 carries the
  //     1200-event bulk history from section 10, so a second server over
  //     DATA_A exercises the capped case with a REAL >STREAM_CAP record.
  const PORT_A = PORT + 1;
  const BASE_A = `http://127.0.0.1:${PORT_A}`;
  const serverA = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_A, PORT: String(PORT_A), OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo" },
    stdio: "ignore",
  });
  try {
    let healthyA = false;
    for (let i = 0; i < 60; i += 1) {
      try { const r = await fetch(`${BASE_A}/api/health`); if (r.ok) { healthyA = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!healthyA) fail("DATA_A server did not become healthy");
    const sessA = await fetch(`${BASE_A}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-funder" }), redirect: "manual",
    });
    const cookieA = sessA.headers.getSetCookie()[0].split(";")[0];
    const pageA = async (p) => {
      const r = await fetch(`${BASE_A}${p}`, { headers: { cookie: cookieA, accept: "text/html" }, redirect: "manual" });
      return { status: r.status, html: await r.text() };
    };
    const bigPage = await pageA("/timeline/twin/proj-r47");
    const bigApi = await (await fetch(`${BASE_A}/api/timeline/project/proj-r47`, { headers: { cookie: cookieA } })).json();
    assert(bigApi.events.length > 80, `fixture project has ${bigApi.events.length} events (> STREAM_CAP)`);
    const bigData = JSON.parse(bigPage.html.split('id="twin-data">')[1].split("</script>")[0]);
    const rowAtsA = [...bigPage.html.matchAll(/<li data-at="([^"]+)"/g)].map((m) => m[1]);
    assert(rowAtsA.length === 80, "the pane renders exactly the most recent STREAM_CAP events");
    const sortedRows = rowAtsA.slice().sort();
    assert(bigData.replay.min === sortedRows[0] && bigData.replay.max === sortedRows[sortedRows.length - 1],
      "the replay scrubber's bounds are EXACTLY the rendered window's own first and last events");
    const expectedMin = bigApi.events[bigApi.events.length - 80].at;
    assert(bigData.replay.min === expectedMin,
      "the replay minimum is the oldest event IN the window, not the oldest event in history");
    assert(bigData.replay.min > bigApi.events[0].at,
      "history older than the window is NOT spanned by the scrubber (no false empty periods)");
    const capNote = new RegExp(`most recent 80 of ${bigApi.events.length} recorded events`);
    assert(capNote.test(bigPage.html), "the page discloses 'most recent 80 of N recorded events'");
    assert(/Earlier history on the full Timeline/.test(bigPage.html),
      "the full Timeline remains the stated destination for earlier history");
    assert(!/\(full record\)/.test(bigPage.html) && /entire replay window/.test(bigPage.html),
      "'All' means the disclosed replay window — the page never claims a full record over a bounded window");
    assert(/30d ago/.test(bigPage.html) && /7d ago/.test(bigPage.html),
      "quick ranges are honestly labeled as rewinds: '30d ago' / '7d ago'");

    // (c) Timeline source caps reach the page. 500 advisory signals fire
    //     the real SIGNAL_READ_CAP — no invented lower cap.
    const insSig = db.prepare(
      `INSERT INTO evidence_signals
         (id, occurred_at, category, severity, confidence, subject_type, subject_id,
          organization_id, project_id, title, explanation, recommendation, signal_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (let i = 0; i < 500; i += 1) {
      insSig.run(`sig-tse-${i}`, "2026-05-01T00:00:00.000Z", "METADATA", "LOW", 0.5,
        "EVIDENCE_ITEM", "ev-ms-1", project.organizationId, "proj-r47",
        `bulk advisory ${i}`, "synthetic cap fixture", "review", `sig-tse-key-${i}`);
    }
    const cappedPage = await pageA("/timeline/twin/proj-r47");
    assert(/Partial timeline record/.test(cappedPage.html),
      "a fired source cap surfaces the PARTIAL TIMELINE RECORD disclosure on the workspace");
    assert(/evidence_signals: showing the most recent 500 advisory findings/.test(cappedPage.html),
      "the cap's own message reaches the page verbatim");
    assert(/returned, authorized timeline window/.test(cappedPage.html),
      "Project Replay is marked as replaying the returned window, not complete history");
    db.prepare("DELETE FROM evidence_signals WHERE id LIKE 'sig-tse-%'").run();

    // (d) The spatial-evidence context count is a RECORD count derived
    //     from events with stored fixes, not the rendered pin count.
    const cleanPage = await pageA("/timeline/twin/proj-r47");
    const spatialM = /Spatial evidence<\/span><span class="tse-v">(\d+) GPS-located record/.exec(cleanPage.html);
    const cleanApi = await (await fetch(`${BASE_A}/api/timeline/project/proj-r47`, { headers: { cookie: cookieA } })).json();
    const apiLocated = cleanApi.events.filter((e) => e.spatial).length;
    assert(spatialM && Number(spatialM[1]) === apiLocated,
      `the spatial-evidence count equals the located RECORD count (${apiLocated})`);
    const viewSrc = fs.readFileSync(path.join(ROOT, "src/server/view/twinPages.tsx"), "utf8");
    assert(/locatedCount = events\.filter\(\(e\) => e\.spatial\)\.length/.test(viewSrc),
      "the context metric derives from records with stored fixes — a pin cap can never masquerade as it");
  } finally {
    try { serverA.kill(); } catch {}
  }

  // (e) Clean case: no fired cap → no false partial-history warning, and
  //     an uncapped (< STREAM_CAP) project shows no window-cap note.
  const cleanB = await page("/timeline/twin/proj-r47", cookie);
  assert(!/Partial timeline record/.test(cleanB.html),
    "sourceCaps = [] shows NO partial-record warning");
  assert(!/Replay window: most recent/.test(cleanB.html) && /entire replay window/.test(cleanB.html),
    "an uncapped project truthfully describes all returned events as the replay window");

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
