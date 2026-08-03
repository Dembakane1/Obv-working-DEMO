#!/usr/bin/env node
/**
 * Official Source Connectors test battery.
 *
 * Proves the connectors layer is doctrine-safe (advisory retrieval that
 * never authors an authoritative record), immutable at the snapshot
 * layer, explainable at the match layer, tenant-scoped, resilient, and
 * hardened against SSRF/redirect/size/secret-leak attacks:
 *   0. static source guards (no authoritative writes, append-only
 *      snapshots + review events, doctrine notices, no live-government
 *      CI dependency, no secret storage)
 *   1. registry: classifications, manual boundaries, config gating
 *   2. mock retrieval lifecycle: snapshot -> candidates (verbatim kept)
 *   3. snapshot immutability + idempotent re-retrieval
 *   4. matching: exact / conflict / ambiguous / license, explainability
 *   5. tenant isolation + same-404
 *   6. change detection: status/stop-work/inspection/disappearance
 *   7. reviewer workflow: confirm/reject/defer/discrepancy/promote via
 *      the governed commands, exactly-once, role-gated
 *   8. governed non-mutation: authoritative tables byte-identical under
 *      retrieval; no automatic exception/decision/payment
 *   9. resilience + egress security over real HTTP (deterministic local
 *      mock server): drift, malformed, size cap, redirects, 500s,
 *      retries, circuit breaker, DLQ, rate limit, SSRF units, redaction
 *  10. frontend rendering + HTTP authorization (separate server)
 *
 * Live government systems are NEVER contacted: real DC sources are
 * asserted to be not-configured (REFUSED/manual) in this environment.
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = process.cwd();
const DATA_A = fs.mkdtempSync(path.join(os.tmpdir(), "obv-osrc-a-"));
const DATA_B = fs.mkdtempSync(path.join(os.tmpdir(), "obv-osrc-b-"));
const PORT = 3265;               // app server (section 10)
const GIS_PORT = 3266;           // deterministic local "official dataset" server
const BASE = `http://127.0.0.1:${PORT}`;

// The db module freezes DATA_DIR at load time: point at DATA_A BEFORE
// the first dist require. Loopback hosts + tiny retry delays are the
// documented test hatches; they never appear in production config.
process.env.OBV_DATA_DIR = DATA_A;
process.env.OBV_SOURCES_ALLOW_PRIVATE_HOSTS = "1";
process.env.OBV_SOURCES_RETRY_BASE_MS = "1";

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
  console.log("\n== 0. Static source guards ==");
  const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
  const dir = "src/server/services/officialSources";
  const files = fs.readdirSync(path.join(ROOT, dir), { recursive: true })
    .filter((f) => /\.ts$/.test(String(f)))
    .map((f) => path.join(dir, String(f)));
  files.push("src/server/db/officialSourcesRepo.ts", "src/server/http/officialSourceRoutes.ts");
  const combined = files.map(readSrc).join("\n");

  assert(
    !/(INSERT INTO|UPDATE|DELETE FROM)\s+(permits|jurisdictional_inspections|permit_basis_versions|line_inspection_requirements|source_verifications|official_source_records|exceptions|draw_requests|ledger_entries|approval_requests|approval_records|virtual_account_events|banking_events|lender_decisions)\b/.test(combined),
    "connectors layer writes to NO authoritative table"
  );
  assert(
    !/releaseTranche|processApprovalDecision|recordLenderDecision|createPaymentInstruction|submitDraw|approveDraw/.test(combined),
    "layer never calls an approval/release/decision/payment path"
  );
  const allSrc = fs.readdirSync(path.join(ROOT, "src"), { recursive: true })
    .filter((f) => /\.(ts|tsx)$/.test(String(f)))
    .map((f) => readSrc(path.join("src", String(f))))
    .join("\n");
  assert(
    !/UPDATE\s+source_snapshots|DELETE\s+FROM\s+source_snapshots/.test(allSrc),
    "source_snapshots is append-only across the entire codebase"
  );
  assert(
    !/UPDATE\s+source_review_events|DELETE\s+FROM\s+source_review_events/.test(allSrc),
    "source_review_events is append-only across the entire codebase"
  );

  const schema = readSrc("src/server/db/index.ts");
  for (const t of [
    "official_sources", "source_snapshots", "source_candidates", "source_matches",
    "source_change_events", "source_review_items", "source_review_events",
    "source_poll_state", "source_dead_letters",
  ]) assert(schema.includes(`CREATE TABLE IF NOT EXISTS ${t}`), `schema declares ${t}`);

  const core = readSrc("src/server/services/officialSources/core.ts");
  assert(/does not issue\s*\n?\s*.*permits, perform government inspections, grant licenses/i.test(core) ||
    /OBV does not issue/.test(core), "doctrine notice is defined");
  const routes = readSrc("src/server/http/officialSourceRoutes.ts");
  assert(/never approves, rejects, or\s*\n?\s*\* releases funds/.test(routes) || /never approves, rejects, or releases/.test(routes),
    "routes document the doctrine");
  const manual = readSrc("src/server/services/officialSources/connectors/manualBoundary.ts");
  assert(/MANUAL_VERIFICATION_REQUIRED/.test(manual) && !/fetchOfficial/.test(manual),
    "manual boundaries never perform automated egress (no scraping)");
  const repoCode = readSrc("src/server/db/officialSourcesRepo.ts")
    .split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
  assert(!/process\.env/.test(repoCode), "repository never reads environment secrets");
  assert(
    !/OBV_BANKING|VirtualAccountService|services\/banking|BankingProvider/.test(combined),
    "connector layer never touches banking credentials or the banking service"
  );
  const egress = readSrc("src/server/services/officialSources/egress.ts");
  assert(/accept-encoding.*identity/s.test(egress), "responses are fetched uncompressed (no decompression lever)");
  assert(/isBlockedAddress/.test(egress) && /lookup:/.test(egress), "DNS resolution is validated and pinned");
}

// ------------------------------------------------------------ helpers

const repo = require(path.join(ROOT, "dist/server/db/repo"));
const osSvc = require(path.join(ROOT, "dist/server/services/officialSources"));
const connectors = require(path.join(ROOT, "dist/server/services/officialSources/connectors"));
const egress = require(path.join(ROOT, "dist/server/services/officialSources/egress"));
const coreSvc = require(path.join(ROOT, "dist/server/services/officialSources/core"));
const permitsSvc = require(path.join(ROOT, "dist/server/services/permits"));

let db = null;
const q1 = (sql, ...a) => db.prepare(sql).get(...a);
const qa = (sql, ...a) => db.prepare(sql).all(...a);
const tableHash = (t) => crypto.createHash("sha256").update(JSON.stringify(qa(`SELECT * FROM ${t} ORDER BY 1`))).digest("hex");

// Deterministic local "official dataset" server (ArcGIS query shape).
// Modes are switched per-test; every response is deterministic.
const gis = {
  mode: "ok",
  requests: 0,
  records: [
    { PERMIT_ID: "TB-1001", STATUS: "ISSUED", FULL_ADDRESS: "1427 VERITY PL SE", OWNER_NAME: "MERIDIAN ROW VENTURES LLC", ISSUE_DATE: 1770000000000, LASTMODIFIEDDATE: 1770000000000 },
  ],
};
function startGisServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      gis.requests += 1;
      if (gis.mode === "http500") { res.writeHead(500, { "content-type": "application/json" }); res.end("{\"error\":{\"code\":500}}"); return; }
      if (gis.mode === "malformed") { res.writeHead(200, { "content-type": "application/json" }); res.end("{not json!!"); return; }
      if (gis.mode === "huge") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ features: [{ attributes: { PERMIT_ID: "X", BLOB: "y".repeat(5 * 1024 * 1024) } }] }));
        return;
      }
      if (gis.mode === "redirect-cross") { res.writeHead(302, { location: "http://127.0.0.2:9/steal" }); res.end(); return; }
      if (gis.mode === "redirect-same" && !String(req.url).includes("redirected=1")) {
        res.writeHead(302, { location: `http://127.0.0.1:${GIS_PORT}/layer/query?f=json&where=1%3D1&redirected=1` });
        res.end();
        return;
      }
      if (gis.mode === "drift") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ features: [{ attributes: { PERMIT_ID: "TB-DRIFT", FULL_ADDRESS: "1 DRIFT ST" } }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ features: gis.records.map((attributes) => ({ attributes })) }));
    });
    server.listen(GIS_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------- main

let server = null;
let gisServer = null;

async function main() {
  staticGuards();

  console.log("\n== 1. Registry: classification + configuration gating ==");
  seed(DATA_A);
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(DATA_A, "obv.db"));
  osSvc.ensureSourceRegistry();
  const funder = repo.getUser("user-funder");
  const pm = repo.getUser("user-pm");           // r47 only
  const dmvpm = repo.getUser("user-dmv-pm");    // proj-dmv only (viewer, not reviewer)
  const field = repo.getUser("user-field");

  const registry = osSvc.listSourceRegistry(funder);
  assert(registry.length >= 9, `registry seeded with ${registry.length} sources`);
  const byId = Object.fromEntries(registry.map((v) => [v.source.id, v]));
  assert(byId["dc-dob-building-permits"]?.source.category === "OFFICIAL_OPEN_DATA", "DOB permits classified OFFICIAL_OPEN_DATA");
  assert(byId["dc-ddot-tops-permits"]?.source.category === "OFFICIAL_API", "DDOT TOPS classified OFFICIAL_API (documented Web API)");
  assert(byId["dc-dob-inspections"]?.source.category === "OFFICIAL_PORTAL_MANUAL", "DOB inspections classified OFFICIAL_PORTAL_MANUAL");
  assert(byId["dc-dlcp-professional-licenses"]?.source.category === "OFFICIAL_PORTAL_MANUAL", "DLCP professional licenses classified OFFICIAL_PORTAL_MANUAL");
  assert(
    registry.filter((v) => v.source.id.startsWith("dc-")).every((v) => v.automatedRetrievalAvailable === false),
    "every real DC source is not-configured here — live government systems are never a CI dependency"
  );
  assert(byId[connectors.MOCK_SOURCE_ID]?.source.name.includes("not a government system"),
    "the mock source is unmistakably labeled as not a government system");
  // Manual boundary behavior.
  const manualOut = await osSvc.performRetrieval("dc-dob-inspections", "SEARCH", { query: { permitNumber: "X" } },
    { actorUserId: funder.id, organizationId: null, projectId: null });
  assert(manualOut.kind === "MANUAL_VERIFICATION_REQUIRED", "manual-boundary source returns MANUAL_VERIFICATION_REQUIRED");
  assert(/portal/i.test(manualOut.manualInstructions ?? ""), "manual instructions point at the official portal");
  assert(manualOut.snapshot.outcome === "MANUAL_VERIFICATION_REQUIRED", "the manual outcome is itself snapshotted");
  // Unconfigured open-data source refuses (never guesses endpoints).
  const unconfigured = await osSvc.performRetrieval("dc-dob-building-permits", "SEARCH", { query: { permitNumber: "X" } },
    { actorUserId: funder.id, organizationId: null, projectId: null });
  assert(unconfigured.kind === "NOT_CONFIGURED" && unconfigured.snapshot.outcome === "REFUSED",
    "unconfigured official source REFUSES retrieval with manual fallback (no fabricated endpoint)");
  // TOPS requires its credential.
  const tops = await osSvc.performRetrieval("dc-ddot-tops-permits", "SEARCH", { query: { permitNumber: "X" } },
    { actorUserId: funder.id, organizationId: null, projectId: null });
  assert(tops.kind === "NOT_CONFIGURED" && /license key|endpoint/i.test(tops.manualInstructions ?? ""),
    "TOPS adapter refuses without its documented endpoint + license key");

  console.log("\n== 2. Mock retrieval lifecycle: snapshot -> candidates ==");
  const permit = permitsSvc.createPermit(funder, "proj-dmv", {
    permitNumber: "B2401001", permitType: "BUILDING", issuingAuthority: "DC DOB",
    jurisdiction: "US-DC", status: "ISSUED", issuedAt: "2026-01-21", expiresAt: "2027-01-21",
  });
  const refresh1 = await osSvc.refreshSource(funder, connectors.MOCK_SOURCE_ID, { projectId: "proj-dmv" });
  assert(refresh1.kind === "OK" && refresh1.candidates > 0, `project refresh retrieved ${refresh1.candidates} candidate(s)`);
  const snap = qa("SELECT * FROM source_snapshots WHERE outcome='SUCCESS' ORDER BY rowid DESC LIMIT 1")[0];
  assert(Boolean(snap), "successful retrieval wrote a snapshot");
  const payload = snap.payload ?? "";
  assert(
    crypto.createHash("sha256").update(payload).digest("hex") === snap.payload_sha256,
    "snapshot payload hash verifies (SHA-256 of the raw payload)"
  );
  const cand = qa("SELECT * FROM source_candidates WHERE external_id='MOCK-B2401001' ORDER BY rowid DESC LIMIT 1")[0];
  assert(Boolean(cand), "candidate normalized from the raw record");
  assert(cand.verbatim_status === "PERMIT ISSUED" && cand.normalized_status === "permit issued",
    "the source's verbatim status is preserved alongside the normalized value");
  const candFields = JSON.parse(cand.fields);
  assert(candFields.status?.verbatim === "PERMIT ISSUED", "field map keeps verbatim source wording");

  console.log("\n== 3. Snapshot immutability + idempotent re-retrieval ==");
  const snapshotRows = qa("SELECT id, payload_sha256 FROM source_snapshots ORDER BY rowid");
  const candCountBefore = q1("SELECT COUNT(*) AS c FROM source_candidates").c;
  osSvc.resetRateLimiters();
  await osSvc.refreshSource(funder, connectors.MOCK_SOURCE_ID, { projectId: "proj-dmv" });
  const snapshotRowsAfter = qa("SELECT id, payload_sha256 FROM source_snapshots ORDER BY rowid");
  assert(snapshotRowsAfter.length > snapshotRows.length, "re-retrieval appends new snapshots (append-only)");
  assert(
    JSON.stringify(snapshotRowsAfter.slice(0, snapshotRows.length)) === JSON.stringify(snapshotRows),
    "prior snapshots are byte-identical after re-retrieval (immutable)"
  );
  assert(q1("SELECT COUNT(*) AS c FROM source_candidates").c === candCountBefore,
    "unchanged source content creates no duplicate candidates (idempotent on content)");

  console.log("\n== 4. Matching: explainable verdicts ==");
  const match = qa("SELECT * FROM source_matches WHERE obv_entity_id = ? ORDER BY rowid", permit.id)[0];
  assert(Boolean(match), "candidate evaluated against the OBV permit");
  assert(match.verdict === "EXACT_MATCH", "exact permit number + consistent dates -> EXACT_MATCH");
  const reasons = JSON.parse(match.reason_codes);
  assert(reasons.includes("PERMIT_NUMBER_EXACT"), "match carries reason codes");
  const fieldsCompared = JSON.parse(match.fields_compared);
  assert(Array.isArray(fieldsCompared) && fieldsCompared.some((c) => c.field === "permitNumber"),
    "match records exactly which fields were compared");
  assert(typeof match.confidence === "number" && match.recommendation.length > 10,
    "match carries a confidence score and a reviewer recommendation");

  // CONFLICT: same number, different house number at the source.
  repo.updateProjectFields?.("proj-dmv", {}); // no-op guard if helper exists
  connectors.setMockFixtures([{
    externalId: "MOCK-CONFLICT-1", recordType: "PERMIT", status: "ISSUED",
    address: "2209 Maple Ave NE, Washington, DC", permitNumber: "B2401001",
    applicationDate: null, issuanceDate: "2026-01-21", expirationDate: "2027-01-21",
    inspectionDate: null, inspectionResult: null, partyName: "Someone Else LLC",
    updatedAt: "2026-02-01T00:00:00.000Z",
  }]);
  // Give the project a street address so house numbers are comparable.
  db.prepare("UPDATE projects SET location = ? WHERE id = ?").run("1427 Verity Pl SE, Washington, DC", "proj-dmv");
  osSvc.resetRateLimiters();
  const conflictRefresh = await osSvc.refreshSource(funder, connectors.MOCK_SOURCE_ID, { projectId: "proj-dmv" });
  assert(conflictRefresh.kind === "OK", "conflict scenario retrieval succeeded");
  const conflictMatch = qa("SELECT * FROM source_matches WHERE verdict='CONFLICT' ORDER BY rowid DESC LIMIT 1")[0];
  assert(Boolean(conflictMatch), "same permit number + genuinely different street address -> CONFLICT");
  const conflictItem = qa("SELECT * FROM source_review_items WHERE event_kind='SOURCE_CONFLICT' ORDER BY rowid DESC LIMIT 1")[0];
  assert(Boolean(conflictItem), "conflict enqueued for reviewer attention");
  assert(/differs|disagree/i.test(conflictItem.explanation) || /conflict/i.test(conflictItem.title.toLowerCase()),
    "conflict item explains the disagreement in plain language");

  // AMBIGUOUS: one candidate matching two different permits equally.
  const permit2 = permitsSvc.createPermit(funder, "proj-dmv", {
    permitNumber: "AMB-77", permitType: "ELECTRICAL", status: "ISSUED", issuedAt: "2026-02-01",
  });
  const r47permit = permitsSvc.createPermit(funder, "proj-r47", {
    permitNumber: "AMB-77", permitType: "ELECTRICAL", status: "ISSUED", issuedAt: "2026-02-01",
  });
  connectors.setMockFixtures([{
    externalId: "MOCK-AMB-77", recordType: "PERMIT", status: "ISSUED",
    address: null, permitNumber: "AMB-77",
    applicationDate: null, issuanceDate: "2026-02-01", expirationDate: null,
    inspectionDate: null, inspectionResult: null, partyName: null,
    updatedAt: "2026-02-02T00:00:00.000Z",
  }]);
  osSvc.resetRateLimiters();
  await osSvc.refreshSource(funder, connectors.MOCK_SOURCE_ID, { projectId: "proj-dmv" });
  const ambMatches = qa("SELECT verdict FROM source_matches m JOIN source_candidates c ON c.id=m.candidate_id WHERE c.external_id='MOCK-AMB-77'");
  assert(ambMatches.length >= 2 && ambMatches.every((m) => m.verdict === "AMBIGUOUS"),
    "one official record matching two OBV permits equally -> AMBIGUOUS (never auto-linked)");
  assert(Boolean(permit2 && r47permit), "ambiguity fixtures created");

  console.log("\n== 5. Tenant isolation + same-404 ==");
  // pm sees ONLY items on their own project (the cross-project ambiguity
  // legitimately surfaced an r47-scoped item); never a proj-dmv item.
  const pmItems = osSvc.listQueue(pm);
  assert(pmItems.every((i) => i.projectId === "proj-r47"),
    "a user sees only queue items on projects they can access");
  const dmvItem = osSvc.listQueue(funder, "OPEN").find((i) => i.projectId === "proj-dmv");
  let crossErr = null;
  try { osSvc.queueItemDetail(pm, dmvItem.id); } catch (e) { crossErr = e; }
  assert(crossErr?.statusCode === 404, "another tenant's queue item is a plain 404");
  let missErr = null;
  try { osSvc.queueItemDetail(funder, "no-such-item"); } catch (e) { missErr = e; }
  assert(missErr?.statusCode === 404, "a nonexistent item is the same 404 as an inaccessible one");
  const scopedSnap = qa("SELECT id FROM source_snapshots WHERE project_id='proj-dmv' LIMIT 1")[0];
  let snapErr = null;
  try { osSvc.snapshotPreview(pm, scopedSnap.id); } catch (e) { snapErr = e; }
  assert(snapErr?.statusCode === 404, "a project-scoped snapshot is same-404 outside the tenant");
  let fieldErr = null;
  try { osSvc.listQueue(field); } catch (e) { fieldErr = e; }
  assert(fieldErr?.statusCode === 403, "FIELD role cannot view Official Sources (403)");
  // The interactive lookup is role-gated BEFORE any egress: a FIELD user
  // triggers no retrieval and leaves no snapshot.
  const snapsBeforeLookup = q1("SELECT COUNT(*) AS c FROM source_snapshots").c;
  let lookupErr = null;
  try { await osSvc.lookupSource(field, connectors.MOCK_SOURCE_ID, { permitNumber: "B2401001" }); } catch (e) { lookupErr = e; }
  assert(lookupErr?.statusCode === 403, "FIELD role cannot run a source lookup (403, before any egress)");
  assert(q1("SELECT COUNT(*) AS c FROM source_snapshots").c === snapsBeforeLookup,
    "a refused lookup performs no retrieval and writes no snapshot");
  // An interactive lookup without a project is stamped with the caller's
  // organization; its snapshot (holding the search terms) is same-404 to
  // other organizations.
  osSvc.resetRateLimiters();
  const orgLookup = await osSvc.lookupSource(funder, connectors.MOCK_SOURCE_ID, { permitNumber: "B2401001" });
  assert(orgLookup.snapshot.organizationId === funder.organizationId,
    "an unscoped lookup snapshot is stamped with the caller's organization");
  const crraPm = pm; // org-crra
  let orgSnapErr = null;
  try { osSvc.snapshotPreview(crraPm, orgLookup.snapshot.id); } catch (e) { orgSnapErr = e; }
  assert(orgSnapErr?.statusCode === 404, "another organization's lookup snapshot is a plain 404 (search terms stay private)");
  // Dead letters can reference tenant search terms: reviewer-only.
  let dlqErr = null;
  try { osSvc.listDeadLetterQueue(dmvpm); } catch (e) { dlqErr = e; }
  assert(dlqErr?.statusCode === 403, "the dead-letter queue is reviewer-only (a PM cannot read other tenants' lookup params)");
  // The ambiguous candidate matched permits in BOTH projects for the
  // funder (who sees both). A dmv-only viewer's own refresh must never
  // evaluate against r47 permits.
  connectors.setMockFixtures([{
    externalId: "MOCK-AMB-77", recordType: "PERMIT", status: "ISSUED",
    address: null, permitNumber: "AMB-77",
    applicationDate: null, issuanceDate: "2026-02-01", expirationDate: null,
    inspectionDate: null, inspectionResult: null, partyName: null,
    updatedAt: "2026-02-03T00:00:00.000Z",
  }]);
  const r47MatchesBefore = q1("SELECT COUNT(*) AS c FROM source_matches WHERE project_id='proj-r47'").c;
  osSvc.resetRateLimiters();
  await osSvc.refreshSource(dmvpm, connectors.MOCK_SOURCE_ID, { projectId: "proj-dmv" });
  assert(
    q1("SELECT COUNT(*) AS c FROM source_matches WHERE project_id='proj-r47'").c === r47MatchesBefore,
    "a tenant-scoped refresh never evaluates against another tenant's records"
  );

  console.log("\n== 6. Change detection ==");
  connectors.resetMockFixtures();
  osSvc.resetRateLimiters();
  await osSvc.refreshSource(funder, connectors.MOCK_SOURCE_ID, { projectId: "proj-dmv" });
  connectors.mutateMockRecord("MOCK-B2401001", { status: "STOP WORK ORDER ISSUED" });
  osSvc.resetRateLimiters();
  const changeRefresh = await osSvc.refreshSource(funder, connectors.MOCK_SOURCE_ID, { projectId: "proj-dmv" });
  assert(changeRefresh.changes >= 1, "status change detected between successive snapshots");
  const stopChange = qa("SELECT * FROM source_change_events WHERE change_kind='STOP_WORK' ORDER BY rowid DESC LIMIT 1")[0];
  assert(Boolean(stopChange), "stop-work wording classified from the source's own words");
  assert(/previously reported/.test(stopChange.explanation) && /STOP WORK ORDER ISSUED/.test(stopChange.explanation),
    "change event quotes the verbatim wording of both sides");
  const changedFields = JSON.parse(stopChange.changed_fields);
  assert(changedFields.some((f) => f.field === "status" && f.previous && f.current),
    "change event preserves previous and current values field by field");
  const stopItem = qa("SELECT * FROM source_review_items WHERE event_kind='STOP_WORK_DETECTED' ORDER BY rowid DESC LIMIT 1")[0];
  assert(Boolean(stopItem) && stopItem.severity === "HIGH", "stop-work change queued at HIGH severity");
  // Inspection result change -> failed inspection.
  connectors.mutateMockRecord("MOCK-INSP-7001", { inspectionResult: "FAILED — REINSPECTION REQUIRED" });
  osSvc.resetRateLimiters();
  await osSvc.refreshSource(funder, connectors.MOCK_SOURCE_ID, { projectId: "proj-dmv" });
  const failedItem = qa("SELECT * FROM source_review_items WHERE event_kind='FAILED_INSPECTION' ORDER BY rowid DESC LIMIT 1")[0];
  assert(Boolean(failedItem), "failed inspection detected and queued");
  // Disappearance: retrieve the record once while present, then remove
  // it at the source and re-check.
  osSvc.resetRateLimiters();
  const seen = await osSvc.refreshRecord(funder, connectors.MOCK_SOURCE_ID, "MOCK-LIC-410552", { projectId: "proj-dmv" });
  assert(seen.kind === "OK" && seen.candidates === 1, "targeted record fetch retrieves the license while present");
  connectors.removeMockRecord("MOCK-LIC-410552");
  osSvc.resetRateLimiters();
  await osSvc.refreshRecord(funder, connectors.MOCK_SOURCE_ID, "MOCK-LIC-410552", { projectId: "proj-dmv" });
  const gone = qa("SELECT * FROM source_change_events WHERE change_kind='RECORD_UNAVAILABLE' ORDER BY rowid DESC LIMIT 1")[0];
  assert(Boolean(gone), "a record the source stopped returning is labeled RECORD_UNAVAILABLE");
  assert(/does NOT mean it was revoked|NOT.*revoked/i.test(gone.explanation),
    "disappearance is explicitly NOT inferred to be revocation");
  const idemChanges = q1("SELECT COUNT(*) AS c FROM source_change_events").c;
  osSvc.resetRateLimiters();
  await osSvc.refreshRecord(funder, connectors.MOCK_SOURCE_ID, "MOCK-LIC-410552", { projectId: "proj-dmv" });
  assert(q1("SELECT COUNT(*) AS c FROM source_change_events").c === idemChanges,
    "repeated disappearance checks are idempotent (no duplicate change events)");

  console.log("\n== 7. Reviewer workflow through the governed commands ==");
  const officialBefore = q1("SELECT COUNT(*) AS c FROM official_source_records").c;
  const verificationsBefore = q1("SELECT COUNT(*) AS c FROM source_verifications").c;
  const confirmTarget = osSvc.listQueue(funder, "OPEN").find((i) => i.eventKind === "NEW_PERMIT_CANDIDATE");
  assert(Boolean(confirmTarget), "an attachable candidate item is open");
  const confirmed = osSvc.confirmAndAttach(funder, confirmTarget.id, { note: "verified against the record" });
  assert(confirmed.item.status === "CONFIRMED", "reviewer confirmed the item");
  assert(q1("SELECT COUNT(*) AS c FROM official_source_records").c === officialBefore + 1,
    "confirm attached the record THROUGH permits.recordOfficialSource (one governed row)");
  assert(q1("SELECT COUNT(*) AS c FROM source_verifications").c === verificationsBefore + 1,
    "confirm recorded a verification THROUGH dmvCompliance.recordSourceVerification");
  const auditRow = qa("SELECT * FROM config_audit WHERE action='OFFICIAL_SOURCE_RECORDED' ORDER BY rowid DESC LIMIT 1")[0];
  assert(Boolean(auditRow), "the governed command wrote its own audit event");
  let reErr = null;
  try { osSvc.confirmAndAttach(funder, confirmTarget.id, {}); } catch (e) { reErr = e; }
  assert(reErr?.statusCode === 409, "a resolved item cannot be resolved twice (exactly-once)");
  // Conflict refuses attachment.
  const conflictOpen = osSvc.listQueue(funder, "OPEN").find((i) => i.eventKind === "SOURCE_CONFLICT");
  if (conflictOpen) {
    let cErr = null;
    try { osSvc.confirmAndAttach(funder, conflictOpen.id, {}); } catch (e) { cErr = e; }
    assert(cErr?.statusCode === 422, "a conflicting match refuses confirm & attach");
  } else pass("no open conflict item left to test refusal (acceptable)");
  // Defer then confirm from deferred.
  const deferTarget = osSvc.listQueue(funder, "OPEN").find((i) => i.eventKind === "NEW_PERMIT_CANDIDATE");
  if (deferTarget) {
    assert(osSvc.deferItem(funder, deferTarget.id, "circle back").status === "DEFERRED", "reviewer can defer");
    const back = osSvc.confirmAndAttach(funder, deferTarget.id, {});
    assert(back.item.status === "CONFIRMED", "a deferred item can later be confirmed");
  } else pass("no second candidate to defer (acceptable)");
  // Discrepancy requires a meaningful summary and records a verification.
  const discTarget = osSvc.listQueue(funder, "OPEN")[0];
  let shortErr = null;
  try { osSvc.recordDiscrepancy(funder, discTarget.id, { summary: "short" }); } catch (e) { shortErr = e; }
  assert(shortErr instanceof Error, "a discrepancy demands a meaningful summary");
  const disc = osSvc.recordDiscrepancy(funder, discTarget.id, { summary: "Official status disagrees with uploaded permit copy." });
  assert(disc.item.status === "DISCREPANCY_RECORDED" && Boolean(disc.sourceVerificationId),
    "discrepancy recorded through the governed DMV verification command");
  // Promote -> governed exception.
  const excBefore = q1("SELECT COUNT(*) AS c FROM exceptions").c;
  const promoTarget = osSvc.listQueue(funder, "OPEN").find((i) => i.severity === "HIGH") ?? osSvc.listQueue(funder, "OPEN")[0];
  const promoted = osSvc.promoteToException(funder, promoTarget.id, "verified on the portal");
  assert(promoted.item.status === "PROMOTED" && Boolean(promoted.exceptionId), "reviewer promoted to a governed exception");
  assert(q1("SELECT COUNT(*) AS c FROM exceptions").c === excBefore + 1,
    "exactly one exception created — by the reviewer, through the exceptions service");
  // Role gates: a PM can view but not act.
  const pmView = osSvc.listQueue(dmvpm, "OPEN");
  let pmErr = null;
  try { osSvc.confirmAndAttach(dmvpm, (pmView[0] ?? { id: "x" }).id, {}); } catch (e) { pmErr = e; }
  assert(pmErr?.statusCode === 403 || pmErr?.statusCode === 404, "a PROJECT_MANAGER cannot resolve queue items");
  const events = qa("SELECT kind FROM source_review_events ORDER BY rowid");
  assert(events.length >= 6 && events.some((e) => e.kind === "CREATED") && events.some((e) => e.kind === "CONFIRMED"),
    "every reviewer action appended to the immutable review trail");

  console.log("\n== 8. Governed non-mutation under retrieval ==");
  const AUTHORITATIVE = [
    "permits", "jurisdictional_inspections", "permit_basis_versions",
    "line_inspection_requirements", "draw_requests", "ledger_entries",
    "evidence_items", "verifications", "approval_requests", "approval_records",
    "virtual_account_events", "banking_events",
  ];
  const baseline = {};
  for (const t of AUTHORITATIVE) baseline[t] = tableHash(t);
  const excBaseline = q1("SELECT COUNT(*) AS c FROM exceptions").c;
  connectors.mutateMockRecord("MOCK-B2401001", { status: "PERMIT REVOKED" });
  osSvc.resetRateLimiters();
  await osSvc.refreshSource(funder, connectors.MOCK_SOURCE_ID, { projectId: "proj-dmv" });
  osSvc.resetRateLimiters();
  await osSvc.refreshPortfolio(funder);
  for (const t of AUTHORITATIVE) {
    assert(baseline[t] === tableHash(t), `${t} byte-identical after retrieval (never authored by connectors)`);
  }
  assert(q1("SELECT COUNT(*) AS c FROM exceptions").c === excBaseline,
    "retrieval created NO automatic exception — even for revocation wording");
  const revokedItem = qa("SELECT * FROM source_review_items WHERE title LIKE '%revoked%' ORDER BY rowid DESC LIMIT 1")[0];
  assert(Boolean(revokedItem), "revocation wording queued for HUMAN review instead");

  console.log("\n== 9. Resilience + egress security (deterministic local HTTP) ==");
  gisServer = await startGisServer();
  const { makeArcgisConnector } = connectors;
  const TEST_ID = "test-arcgis-source";
  process.env.OBV_SOURCE_TEST_ARCGIS_SOURCE_URL = `http://127.0.0.1:${GIS_PORT}/layer/query`;
  const testConnector = makeArcgisConnector({
    sourceId: TEST_ID, name: "Deterministic test dataset", agency: "TEST",
    recordType: "PERMIT", recordTypes: ["PERMIT"],
    portalUrl: "https://example.invalid/portal", docsUrl: "https://example.invalid/docs",
    allowedHosts: ["127.0.0.1"],
    fieldCandidates: {
      externalId: ["PERMIT_ID"], permitNumber: ["PERMIT_ID"], status: ["STATUS"],
      address: ["FULL_ADDRESS"], party: ["OWNER_NAME"], applicationDate: [],
      issuanceDate: ["ISSUE_DATE"], expirationDate: [], inspectionDate: [],
      inspectionResult: [], lastModified: ["LASTMODIFIEDDATE"],
    },
    expectedUpdateFrequency: "test", termsNotes: "test", retentionNotes: "test",
  });
  connectors.registerConnectorForTests(TEST_ID, testConnector);
  const osRepoDist = require(path.join(ROOT, "dist/server/db/officialSourcesRepo"));
  osRepoDist.upsertSource({ ...testConnector.sourceMetadata(), rateLimitPerMinute: 1000 });
  const scope = { actorUserId: funder.id, organizationId: null, projectId: null };

  gis.mode = "ok";
  const httpOut = await osSvc.performRetrieval(TEST_ID, "SEARCH", { query: { permitNumber: "TB-1001" } }, scope);
  assert(httpOut.kind === "OK" && httpOut.candidates.length === 1, "real HTTP retrieval through the egress client works");
  assert(httpOut.candidates[0].verbatimStatus === "ISSUED", "HTTP candidate preserves verbatim status");
  gis.mode = "drift";
  const driftOut = await osSvc.performRetrieval(TEST_ID, "SEARCH", { query: {} }, scope);
  assert(driftOut.kind === "OK" && driftOut.candidates[0].normalizationWarnings.some((w) => /status/.test(w)),
    "schema drift (missing status column) recorded as a normalization warning — never invented");
  gis.mode = "malformed";
  const malOut = await osSvc.performRetrieval(TEST_ID, "SEARCH", { query: {} }, scope);
  assert(malOut.kind === "SOURCE_UNAVAILABLE" && /malformed/i.test(malOut.errorLabel ?? ""),
    "malformed JSON -> SOURCE_UNAVAILABLE with a sanitized label (and the attempt snapshotted)");
  assert(malOut.snapshot.outcome === "ERROR", "the malformed response attempt is itself an ERROR snapshot");
  gis.mode = "huge";
  const hugeOut = await osSvc.performRetrieval(TEST_ID, "SEARCH", { query: {} }, scope);
  assert(hugeOut.kind === "SOURCE_UNAVAILABLE" && /size limit/i.test(hugeOut.errorLabel ?? ""),
    "oversized response refused by the streaming size cap");
  gis.mode = "redirect-cross";
  const crossOut = await osSvc.performRetrieval(TEST_ID, "SEARCH", { query: {} }, scope);
  assert(crossOut.kind === "SOURCE_UNAVAILABLE", "cross-host redirect refused");
  gis.mode = "redirect-same";
  const sameOut = await osSvc.performRetrieval(TEST_ID, "SEARCH", { query: {} }, scope);
  assert(sameOut.kind === "OK", "same-host redirect re-validated and followed");

  // SSRF / allowlist units.
  const src = osRepoDist.getSource(TEST_ID);
  let hostErr = null;
  try { egress.assertAllowedSourceUrl(src, "http://evil.example.com/steal"); } catch (e) { hostErr = e; }
  assert(hostErr?.statusCode === 403, "a host outside the source allowlist is refused");
  assert(egress.isBlockedAddress("169.254.169.254"), "cloud metadata address is blocked");
  assert(egress.isBlockedAddress("10.0.0.8") && egress.isBlockedAddress("::1") && egress.isBlockedAddress("localhost"),
    "private, loopback, and pseudo-host addresses are blocked");
  delete process.env.OBV_SOURCES_ALLOW_PRIVATE_HOSTS;
  let privErr = null;
  try { egress.assertAllowedSourceUrl(src, `http://127.0.0.1:${GIS_PORT}/layer/query`); } catch (e) { privErr = e; }
  assert(privErr instanceof Error, "without the test hatch, loopback endpoints and plain http are refused");
  process.env.OBV_SOURCES_ALLOW_PRIVATE_HOSTS = "1";
  let credErr = null;
  try { egress.assertAllowedSourceUrl(src, `http://user:pw@127.0.0.1:${GIS_PORT}/x`); } catch (e) { credErr = e; }
  assert(credErr instanceof Error, "URLs embedding credentials are refused");

  // Secret redaction: an Authorization header never leaks into errors,
  // snapshots, labels, or dead letters.
  gis.mode = "http500";
  const SECRET = "supersecret-key-99441";
  let authFailure = null;
  try {
    await egress.fetchOfficial(src, `http://127.0.0.1:${GIS_PORT}/layer/query`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
  } catch (e) { authFailure = e; }
  assert(!String(authFailure?.message ?? "").includes(SECRET), "egress errors never contain credentials");
  assert(coreSvc.redactSecrets(`authorization: Bearer ${SECRET} and ?api_key=${SECRET}`).includes("[redacted]"),
    "redaction scrubs bearer tokens and key parameters");
  const dbDump = qa("SELECT payload, lookup_params FROM source_snapshots").map((r) => `${r.payload}|${r.lookup_params}`).join("");
  assert(!dbDump.includes(SECRET), "no snapshot row contains a credential");

  // Retries -> circuit breaker -> dead letters.
  gis.mode = "http500";
  osSvc.resetRateLimiters();
  for (let i = 0; i < 3; i += 1) {
    const out = await osSvc.refreshSource(funder, TEST_ID);
    assert(out.kind === "SOURCE_UNAVAILABLE", `failure ${i + 1}/3 recorded (retries exhausted)`);
  }
  let circuitErr = null;
  try { await osSvc.refreshSource(funder, TEST_ID); } catch (e) { circuitErr = e; }
  assert(circuitErr?.statusCode === 409 && /circuit/i.test(circuitErr.message),
    "circuit breaker opens after consecutive failures");
  const letters = osSvc.listDeadLetterQueue(funder);
  assert(letters.length >= 3 && letters.every((l) => !l.errorLabel.includes(SECRET)),
    "exhausted retrievals dead-lettered with sanitized labels");
  gis.mode = "ok";
  db.prepare("UPDATE source_poll_state SET circuit_open_until = NULL, consecutive_failures = 0 WHERE source_id = ?").run(TEST_ID);
  const requeued = await osSvc.requeueDeadLetter(funder, letters[0].id);
  assert(requeued.kind === "OK", "a dead letter can be requeued once the source recovers");
  let reqErr = null;
  try { await osSvc.requeueDeadLetter(funder, letters[0].id); } catch (e) { reqErr = e; }
  assert(reqErr?.statusCode === 409, "a resolved dead letter cannot be requeued twice");
  osSvc.discardDeadLetter(funder, letters[1].id);
  pass("a reviewer can discard a dead letter");

  // Rate limiting.
  osRepoDist.upsertSource({ ...testConnector.sourceMetadata(), rateLimitPerMinute: 2 });
  osSvc.resetRateLimiters();
  await osSvc.refreshSource(funder, TEST_ID);
  await osSvc.refreshSource(funder, TEST_ID);
  let rateErr = null;
  try { await osSvc.refreshSource(funder, TEST_ID); } catch (e) { rateErr = e; }
  assert(rateErr?.statusCode === 429, "client-side rate cap protects the official service (429)");

  // Cursor-based incremental fetch.
  osRepoDist.upsertSource({ ...testConnector.sourceMetadata(), rateLimitPerMinute: 1000 });
  osSvc.resetRateLimiters();
  const inc1 = await osSvc.refreshSource(funder, TEST_ID);
  assert(inc1.kind === "OK", "incremental fetch established a cursor");
  const state = osRepoDist.getPollState(TEST_ID);
  assert(Boolean(state?.cursor), "cursor persisted for the next incremental poll");

  // Scheduled polling stays off until explicitly enabled.
  let pollErr = null;
  try { await osSvc.runScheduledPoll(funder); } catch (e) { pollErr = e; }
  assert(pollErr?.statusCode === 409 && /disabled/i.test(pollErr.message),
    "scheduled polling refuses until OBV_SOURCES_POLLING_ENABLE is set");
  // Pause blocks refresh.
  osSvc.setSourcePaused(funder, TEST_ID, true);
  let pausedErr = null;
  try { await osSvc.refreshSource(funder, TEST_ID); } catch (e) { pausedErr = e; }
  assert(pausedErr?.statusCode === 409 && /paused/i.test(pausedErr.message), "a paused source refuses retrieval");
  osSvc.setSourcePaused(funder, TEST_ID, false);

  db.close();

  console.log("\n== 10. Frontend rendering + HTTP authorization ==");
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
  const fieldCookie = await signIn("user-field");
  const page = async (p, ck) => {
    const r = await fetch(`${BASE}${p}`, { headers: { cookie: ck ?? "", accept: "text/html" }, redirect: "manual" });
    return { status: r.status, html: await r.text() };
  };
  const api = (p, opts = {}) => fetch(`${BASE}${p}`, { redirect: "manual", ...opts });

  const ws = await page("/official-sources", cookie);
  assert(ws.status === 200 && /Official Sources/.test(ws.html), "workspace page renders");
  assert(/OBV retrieves and records official-source information/.test(ws.html),
    "workspace carries the doctrine notice");
  assert(/not a government system/.test(ws.html), "the mock source is labeled honestly in the UI");
  assert(/manual workflow/.test(ws.html), "manual-boundary sources display their manual workflow");
  assert((await page("/official-sources/queue", cookie)).status === 200, "queue page renders");
  assert((await page("/official-sources/lookup", cookie)).status === 200, "lookup page renders");

  // Refresh via API, then act on the queue over HTTP.
  const permitRes = await api(`/api/projects/proj-dmv/permits`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ permitNumber: "B2401001", permitType: "BUILDING", status: "ISSUED", issuedAt: "2026-01-21" }),
  });
  assert([200, 201].includes(permitRes.status), "created a matching OBV permit over HTTP");
  const refreshRes = await api(`/api/official-sources/source/${connectors.MOCK_SOURCE_ID}/refresh`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ projectId: "proj-dmv" }),
  });
  assert(refreshRes.status === 201 && (await refreshRes.json()).kind === "OK", "explicit refresh via API succeeds");
  const queueJson = await (await api("/api/official-sources/queue?status=OPEN", { headers: { cookie } })).json();
  const item = queueJson.items.find((i) => i.eventKind === "NEW_PERMIT_CANDIDATE");
  assert(Boolean(item), "queue API returns the attachable item");
  const itemPage = await page(`/official-sources/queue/${item.id}`, cookie);
  assert(itemPage.status === 200 && /Official source record \(retrieved\)/.test(itemPage.html)
    && /OBV record \(authoritative\)/.test(itemPage.html),
    "queue item page renders the side-by-side comparison");
  assert(/Match explanation/.test(itemPage.html) && /Fields? compared/i.test(itemPage.html),
    "queue item page explains the match");
  const confirmRes = await api(`/api/official-sources/queue/${item.id}/confirm`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ note: "ok" }),
  });
  assert(confirmRes.status === 201, "reviewer confirm works over HTTP");
  const snapLink = /\/official-sources\/snapshot\/([a-z0-9-]+)/.exec(itemPage.html);
  if (snapLink) {
    const snapPage = await page(snapLink[0], cookie);
    assert(snapPage.status === 200 && /SHA-256/.test(snapPage.html), "raw snapshot preview renders with its hash");
  } else pass("no snapshot link on item page (acceptable)");

  assert((await api("/api/official-sources/registry", { headers: { cookie: fieldCookie } })).status === 403,
    "FIELD role gets 403 from the registry API");
  assert((await api("/api/official-sources/registry")).status === 401, "anonymous API access is 401");
  const anon = await page("/official-sources");
  assert([302, 303].includes(anon.status), "anonymous workspace page redirects to sign-in");
  const exec = await page("/executive", cookie);
  assert(/Official sources/.test(exec.html) && /official-record coverage/i.test(exec.html),
    "executive command center shows the advisory Official Sources band");

  console.log(`\nOFFICIAL SOURCE CONNECTORS TESTS PASSED — ${passed} checkpoints.`);
  console.log("OFFICIAL SOURCES INFORM THE REVIEWER. THEY NEVER DECIDE FOR OBV.");
}

main()
  .catch((err) => { console.error(err.stack ?? err); process.exitCode = 1; })
  .finally(() => {
    try { if (server) server.kill(); } catch {}
    try { if (gisServer) gisServer.close(); } catch {}
    try { fs.rmSync(DATA_A, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(DATA_B, { recursive: true, force: true }); } catch {}
  });
