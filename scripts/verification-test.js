/**
 * Hybrid verification pipeline tests — runs the OBV server as a child
 * process against a local stub AI provider to exercise every resilience
 * path without real network dependencies:
 *
 *   no key / live success / malformed output / timeout / provider error /
 *   outside geofence / missing GPS / bad timestamps / offline delayed sync
 *
 * Usage: node scripts/verification-test.js   (builds must exist: npm run build)
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = 3100;
const STUB_PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;

let step = 0;
const pass = (msg) => console.log(`  ✓ [${String(++step).padStart(2, "0")}] ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};

// ------------------------------------------------------------- stub AI

const stubCalls = { ok: 0, bad: 0, slow: 0, err: 0 };
const stub = http.createServer((req, res) => {
  const mode = req.url.split("/")[1]?.split("?")[0] ?? "ok";
  stubCalls[mode] = (stubCalls[mode] ?? 0) + 1;
  req.resume();
  req.on("end", () => {
    if (mode === "err") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("SECRET-PROVIDER-ERROR-BODY");
      return;
    }
    if (mode === "slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: "{}" }] }));
      }, 8000);
      return;
    }
    const text =
      mode === "bad"
        ? "Sure! The image looks broadly fine to me, no JSON needed."
        : '```json\n{"passed": true, "confidence": 0.94, "detail": "Visible compacted gravel base appears consistent with the road-base milestone requirement.", "reasoning": "The image shows graded road surface and compacted gravel coverage consistent with the stated requirement."}\n```';
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text }] }));
  });
});

// --------------------------------------------------------- server child

let child = null;
async function startServer(extraEnv) {
  if (child) {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
  }
  const env = { ...process.env, PORT: String(PORT), ...extraEnv };
  delete env.ANTHROPIC_API_KEY;
  Object.assign(env, extraEnv);
  child = spawn(process.execPath, ["dist/server/http/server.js"], { env, stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + "/");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  fail("server did not start");
}

async function resetDemo() {
  const r = await fetch(BASE + "/api/demo/reset", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: "obv_user=user-funder" },
  });
  if (r.status !== 200) fail(`reset -> ${r.status}`);
}

const PNG_DATA_URL =
  "data:image/png;base64," +
  fs.readFileSync(path.join(process.cwd(), "public", "icons", "icon-192.png")).toString("base64");

async function submit(overrides = {}) {
  const payload = {
    milestoneId: "ms-3",
    photoDataUrl: PNG_DATA_URL,
    latitude: -11.87,
    longitude: 33.594,
    capturedAt: new Date(Date.now() - 30 * 60000).toISOString(),
    deviceMetadata: { userAgent: "verif-test", platform: "Android", screen: "412x915", language: "en" },
    isDemoFallback: false,
    ...overrides,
  };
  const started = Date.now();
  const res = await fetch(BASE + "/api/evidence", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: "obv_user=user-field" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return { status: res.status, body, elapsedMs: Date.now() - started };
}

function expectHeroArtifacts(body, expectApproval = true) {
  if (!body.verification) fail("no verification record");
  if (expectApproval) {
    if (!body.ledgerEntry) fail("no ledger entry");
    if (!body.approvalRequest || body.approvalRequest.status !== "PENDING") fail("no pending ApprovalRequest");
    if (body.milestone.accountStatus !== "HELD") fail("milestone not HELD");
  }
}

async function main() {
  await new Promise((r) => stub.listen(STUB_PORT, r));

  // ---------- TEST 1: no API key -> MOCK_DEFAULT, hero loop intact ----------
  await startServer({});
  await resetDemo();
  let r = await submit();
  if (r.status !== 201) fail(`no-key submit -> ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  if (r.body.verification.source !== "MOCK_DEFAULT") fail(`source=${r.body.verification.source}, want MOCK_DEFAULT`);
  if (r.body.verification.verdict !== "VERIFIED") fail(`verdict=${r.body.verification.verdict}`);
  expectHeroArtifacts(r.body);
  pass("no key: MOCK_DEFAULT verification, ledger entry + ApprovalRequest created, funds HELD");

  // ---------- TEST 6: clearly outside geofence -> deterministic REJECTED ----------
  await resetDemo();
  r = await submit({ latitude: 40.7128, longitude: -74.006 });
  if (r.body.verification.verdict !== "REJECTED") fail(`outside-fence verdict=${r.body.verification.verdict}`);
  const geoCheck = r.body.verification.checks.find((c) => c.name.includes("geofence"));
  if (geoCheck.passed !== false || !geoCheck.detail.includes("clearly outside")) fail("geofence FAIL detail wrong");
  if (r.body.approvalRequest) fail("REJECTED must not create ApprovalRequest");
  if (r.body.ledgerEntry) fail("REJECTED must not enter the ledger");
  pass("clearly outside geofence: deterministic FAIL -> REJECTED, no approval, no ledger entry");

  // ---------- TEST 7: missing GPS -> REVIEW policy ----------
  await resetDemo();
  r = await submit({ latitude: null, longitude: null });
  if (r.body.verification.verdict !== "NEEDS_REVIEW") fail(`missing-GPS verdict=${r.body.verification.verdict}`);
  const geo2 = r.body.verification.checks.find((c) => c.name.includes("geofence"));
  if (!geo2.detail.toLowerCase().includes("missing")) fail("missing-GPS detail wrong");
  if (r.body.evidence.latitude !== null) fail("missing GPS should store null");
  pass("missing GPS: never silently passed -> REVIEW -> NEEDS_REVIEW");

  // ---------- TEST 8: bad timestamps -> deterministic metadata policy ----------
  await resetDemo();
  r = await submit({ capturedAt: new Date(Date.now() + 2 * 3600_000).toISOString() });
  if (r.body.verification.verdict !== "REJECTED") fail(`future-capture verdict=${r.body.verification.verdict}`);
  await resetDemo();
  r = await submit({ capturedAt: "not-a-timestamp" });
  if (r.body.verification.verdict !== "REJECTED") fail(`malformed-timestamp verdict=${r.body.verification.verdict}`);
  const meta = r.body.verification.checks.find((c) => c.name.includes("metadata") || c.name.includes("Timestamp"));
  if (!meta.detail.toLowerCase().includes("malformed")) fail("malformed timestamp detail wrong");
  pass("bad timestamps (future capture, malformed): metadata FAIL -> REJECTED");

  // ---------- TEST 9: offline delayed sync is legitimate ----------
  await resetDemo();
  r = await submit({ capturedAt: new Date(Date.now() - 26 * 3600_000).toISOString() });
  if (r.body.verification.verdict !== "VERIFIED") fail(`offline-delay verdict=${r.body.verification.verdict}`);
  const meta2 = r.body.verification.checks.find((c) => c.name.includes("Timestamp"));
  if (!meta2.detail.includes("offline queue — permitted")) fail("offline delay not acknowledged");
  pass("offline delayed sync (26h): PASS with explicit offline-queue note -> VERIFIED");

  // ---------- TEST 2: live provider success ----------
  await startServer({ ANTHROPIC_API_KEY: "test-key", OBV_AI_BASE_URL: `http://127.0.0.1:${STUB_PORT}/ok`, OBV_AI_TIMEOUT_MS: "2000" });
  await resetDemo();
  r = await submit();
  if (r.body.verification.source !== "LIVE_AI") fail(`live source=${r.body.verification.source}`);
  if (r.body.verification.verdict !== "VERIFIED") fail(`live verdict=${r.body.verification.verdict}`);
  const visual = r.body.verification.checks[0];
  if (!visual.detail.includes("Visible compacted gravel")) fail("live visual detail not used");
  expectHeroArtifacts(r.body);
  if (stubCalls.ok < 1) fail("stub never called");
  pass("live success: fenced JSON parsed, LIVE_AI provenance, deterministic checks + aggregator ran");

  // provenance appears in report preview
  const preview = await (await fetch(`${BASE}/report/proj-r47/preview`, { headers: { Cookie: "obv_user=user-funder" } })).text();
  if (!preview.includes("Live multimodal visual assessment")) fail("report missing live provenance");
  if (!preview.includes("Demo fallback visual assessment")) fail("report missing fallback provenance for seeded items");
  pass("funder report shows accurate verification method per evidence section");

  // ---------- TEST 3: malformed AI output -> fallback ----------
  await startServer({ ANTHROPIC_API_KEY: "test-key", OBV_AI_BASE_URL: `http://127.0.0.1:${STUB_PORT}/bad`, OBV_AI_TIMEOUT_MS: "2000" });
  await resetDemo();
  r = await submit();
  if (r.body.verification.source !== "MOCK_FALLBACK") fail(`malformed source=${r.body.verification.source}`);
  if (r.body.verification.verdict !== "VERIFIED") fail("fallback did not keep hero loop");
  expectHeroArtifacts(r.body);
  pass("malformed model output: no crash, MOCK_FALLBACK, hero loop continues");

  // ---------- TEST 4: provider timeout -> fast fallback ----------
  await startServer({ ANTHROPIC_API_KEY: "test-key", OBV_AI_BASE_URL: `http://127.0.0.1:${STUB_PORT}/slow`, OBV_AI_TIMEOUT_MS: "1200" });
  await resetDemo();
  r = await submit();
  if (r.body.verification.source !== "MOCK_FALLBACK") fail(`timeout source=${r.body.verification.source}`);
  if (r.elapsedMs > 6000) fail(`timeout path took ${r.elapsedMs}ms — hangs`);
  expectHeroArtifacts(r.body);
  pass(`provider timeout: bounded at ${r.elapsedMs}ms, MOCK_FALLBACK, no hang`);

  // ---------- TEST 5: provider 5xx -> retry once, sanitized fallback ----------
  stubCalls.err = 0;
  await startServer({ ANTHROPIC_API_KEY: "test-key", OBV_AI_BASE_URL: `http://127.0.0.1:${STUB_PORT}/err`, OBV_AI_TIMEOUT_MS: "2000" });
  await resetDemo();
  r = await submit();
  if (r.body.verification.source !== "MOCK_FALLBACK") fail(`5xx source=${r.body.verification.source}`);
  if (stubCalls.err !== 2) fail(`expected 1 retry (2 calls), saw ${stubCalls.err}`);
  const asText = JSON.stringify(r.body);
  if (asText.includes("SECRET-PROVIDER-ERROR")) fail("raw provider error leaked to client");
  const acts = await (await fetch(`${BASE}/overview`, { headers: { Cookie: "obv_user=user-funder" } })).text();
  if (acts.includes("SECRET-PROVIDER-ERROR")) fail("raw provider error leaked to activity feed");
  if (!acts.includes("AI VISUAL FALLBACK USED")) fail("fallback audit event missing");
  expectHeroArtifacts(r.body);
  pass("provider 5xx: one retry, sanitized error, fallback audit event, hero loop continues");

  // ---------- demo-fallback photo with key: honest MOCK_FALLBACK ----------
  await resetDemo();
  r = await submit({ photoDataUrl: undefined, demoPhotoId: "demo-m3-a", isDemoFallback: true });
  if (r.body.verification.source !== "MOCK_FALLBACK") fail(`svg-demo source=${r.body.verification.source}`);
  if (r.body.verification.verdict !== "VERIFIED") fail("demo photo fallback broke");
  pass("demo SVG asset with key configured: live skipped honestly (unsupported format) -> MOCK_FALLBACK");

  child.kill();
  stub.close();
  console.log(`\nVERIFICATION PIPELINE TESTS PASSED — ${step} checkpoints.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nVERIFICATION TESTS FAILED at checkpoint ${step + 1}: ${err.message}\n`);
  if (child) child.kill();
  stub.close();
  process.exit(1);
});
