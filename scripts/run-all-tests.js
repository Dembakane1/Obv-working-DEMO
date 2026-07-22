#!/usr/bin/env node
/**
 * Unified deterministic test runner — one command that validates the
 * complete application.
 *
 *   node scripts/run-all-tests.js              build + every suite, fail fast
 *   node scripts/run-all-tests.js --continue   keep going after a failure
 *   node scripts/run-all-tests.js --verbose    stream suite output live
 *   node scripts/run-all-tests.js --skip-build reuse the existing dist/
 *
 * Behavior:
 *   - runs the TypeScript build first (exactly once — callers must not
 *     wrap this runner in another build);
 *   - runs every standalone suite (each seeds its own temp database and
 *     spawns its own isolated server);
 *   - boots ONE temp-seeded application server for the server-based
 *     suites (intelligence, report, frontend, acceptance) and the
 *     deployment checks, then tears it down;
 *   - stops on the first failure by default and names the failed suite;
 *   - prints a final suite + checkpoint summary;
 *   - uses only Node built-ins (browser suites resolve `playwright` via
 *     normal module resolution — local node_modules or NODE_PATH);
 *   - forces the banking layer to mock/demo regardless of ambient env;
 *   - cleans up its temp database and server on exit;
 *   - never modifies committed files (all state lives under a temp dir).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const ARGS = new Set(process.argv.slice(2));
const FAIL_FAST = !ARGS.has("--continue");
const VERBOSE = ARGS.has("--verbose");
const SKIP_BUILD = ARGS.has("--skip-build");

const SERVER_PORT = Number(process.env.OBV_TEST_SERVER_PORT || 3600);
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

/** The banking layer is mock/demo-only in every test context. */
const SAFE_ENV = {
  ...process.env,
  OBV_BANKING_PROVIDER: "mock",
  OBV_BANKING_MODE: "demo",
  OBV_BANKING_PRODUCTION_ENABLE: "",
};

/** Standalone suites — each owns its isolated database and server. */
const STANDALONE = [
  "verification-test.js",
  "idempotency-test.js",
  "chat-test.js",
  "teams-test.js",
  "teams-sync-test.js",
  "whatsapp-sync-test.js",
  "home-test.js",
  "draws-test.js",
  "gates-test.js",
  "fieldops-test.js",
  "exceptions-test.js",
  "budget-test.js",
  "changeorders-test.js",
  "permits-test.js",
  "pilot-test.js",
  "map-test.js",
  "auditpackage-test.js",
  "drawpackage-test.js",
  "lender-test.js",
  "lender-ui-test.js",
  "vam-test.js",
  "vam-adversarial-test.js",
];

/** Suites that target one shared, freshly seeded application server. */
const SERVER_BASED = [
  "intelligence-test.js",
  "report-test.js",
  "frontend-test.js",
  "acceptance-test.js",
];

const results = [];
let anyFailure = false;

function parseCheckpoints(output) {
  // Suites report "... PASSED — N checkpoints" (or similar).
  const matches = [...output.matchAll(/PASSED[^\n]*?(\d+)\s+checkpoints/g)];
  if (matches.length > 0) return Number(matches[matches.length - 1][1]);
  const alt = [...output.matchAll(/(\d+)\s+checkpoints/g)];
  return alt.length > 0 ? Number(alt[alt.length - 1][1]) : null;
}

function runSuite(name, argv, extraEnv = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, argv, {
      cwd: ROOT,
      env: { ...SAFE_ENV, ...extraEnv },
      stdio: VERBOSE ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    });
    let output = "";
    if (!VERBOSE) {
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
    }
    child.on("exit", (code) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const ok = code === 0;
      results.push({ name, ok, seconds, checkpoints: ok ? parseCheckpoints(output) : null });
      if (ok) {
        console.log(`  PASS  ${name} (${seconds}s)`);
      } else {
        anyFailure = true;
        console.error(`\n  FAIL  ${name} (exit ${code}, ${seconds}s)`);
        if (!VERBOSE) {
          console.error("  ---- last output ----");
          console.error(output.split("\n").slice(-25).join("\n"));
        }
      }
      resolve(ok);
    });
  });
}

function runNpmBuild() {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: ROOT,
      env: SAFE_ENV,
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function waitForHealth(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log("OBV unified test runner");
  console.log(`mode: ${FAIL_FAST ? "fail-fast" : "continue-on-failure"}${VERBOSE ? ", verbose" : ""}`);

  // ---- 1. build (exactly once) ----
  if (!SKIP_BUILD) {
    console.log("\n== build ==");
    if (!(await runNpmBuild())) {
      console.error("\nFAILED SUITE: TypeScript build");
      process.exit(1);
    }
  } else {
    console.log("\n== build skipped (--skip-build) ==");
  }

  // ---- 2. standalone suites ----
  console.log("\n== standalone suites ==");
  for (const script of STANDALONE) {
    const full = path.join(ROOT, "scripts", script);
    if (!fs.existsSync(full)) {
      console.log(`  SKIP  ${script} (not present)`);
      continue;
    }
    const ok = await runSuite(script, [full]);
    if (!ok && FAIL_FAST) return finish();
  }

  // ---- 3. shared server for the server-based suites ----
  console.log("\n== server-based suites ==");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obv-runner-"));
  let server = null;
  try {
    await new Promise((r) =>
      spawn(process.execPath, [path.join(ROOT, "dist", "server", "db", "seed.js")], {
        cwd: ROOT,
        env: { ...SAFE_ENV, OBV_DATA_DIR: dataDir },
        stdio: "ignore",
      }).on("exit", r)
    );
    server = spawn(process.execPath, [path.join(ROOT, "dist", "server", "http", "server.js")], {
      cwd: ROOT,
      env: { ...SAFE_ENV, OBV_DATA_DIR: dataDir, PORT: String(SERVER_PORT) },
      stdio: "ignore",
    });
    if (!(await waitForHealth(BASE))) {
      anyFailure = true;
      console.error(`  FAIL  shared application server did not become healthy on :${SERVER_PORT}`);
      return finish();
    }
    const serverEnv = {
      OBV_BASE_URL: BASE,
      BASE,
      OBV_DB: path.join(dataDir, "obv.db"),
    };
    for (const script of SERVER_BASED) {
      const full = path.join(ROOT, "scripts", script);
      if (!fs.existsSync(full)) {
        console.log(`  SKIP  ${script} (not present)`);
        continue;
      }
      const ok = await runSuite(script, [full], serverEnv);
      if (!ok && FAIL_FAST) return finish();
    }

    // ---- 4. deployment configuration checks ----
    console.log("\n== deployment checks ==");
    const ok = await runSuite("deploy-check.js", [path.join(ROOT, "scripts", "deploy-check.js"), BASE]);
    if (!ok && FAIL_FAST) return finish();
  } finally {
    if (server) server.kill();
    // Best-effort temp cleanup; never touches the repository tree.
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  finish();
}

function finish() {
  console.log("\n== summary ==");
  let totalCheckpoints = 0;
  for (const r of results) {
    const cp = r.checkpoints !== null ? ` ${String(r.checkpoints).padStart(4)} checkpoints` : "     —";
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(28)}${cp}  ${r.seconds}s`);
    if (r.checkpoints) totalCheckpoints += r.checkpoints;
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n  suites: ${results.length - failed.length}/${results.length} passed, ${totalCheckpoints} checkpoints`);
  if (failed.length > 0) {
    console.error(`\nFAILED SUITE${failed.length > 1 ? "S" : ""}: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
  console.log("\nALL SUITES PASSED.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
