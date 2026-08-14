#!/usr/bin/env node
/**
 * Unified deterministic test runner — one command that validates the
 * complete application.
 *
 *   node scripts/run-all-tests.js               build + every suite, fail fast
 *   npm test                                    (identical)
 *   npm test -- --continue                      keep going after a failure
 *   npm test -- --filter permits,draws          run only matching suites
 *   npm test -- --list                          print the suite inventory
 *   npm test -- --verbose                       stream suite output live
 *   npm test -- --skip-build                    reuse the existing dist/
 *   npm test -- --json out.json                 machine-readable summary
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
 *   - captures the FULL stdout+stderr of every suite to .test-logs/ and,
 *     on failure, prints the failing excerpt, the log path and the exact
 *     command to reproduce that one suite;
 *   - always writes .test-logs/summary.json (suite results + checkpoints)
 *     so CI can upload one artifact that explains the run;
 *   - prints a final suite + checkpoint summary and the slowest suites;
 *   - uses only Node built-ins; browser suites resolve the PINNED
 *     Playwright devDependency through scripts/lib/browser.js;
 *   - forces the banking layer to mock/demo regardless of ambient env;
 *   - cleans up its temp database and shared server on exit, including
 *     on SIGINT/SIGTERM;
 *   - never modifies committed files (all state lives under a temp dir
 *     or the gitignored .test-logs/).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const RAW_ARGS = process.argv.slice(2);
const ARGS = new Set(RAW_ARGS);
const FAIL_FAST = !ARGS.has("--continue");
const VERBOSE = ARGS.has("--verbose");
const SKIP_BUILD = ARGS.has("--skip-build");
const LIST_ONLY = ARGS.has("--list");

/** --filter a,b  (or --filter a --filter b) — substring match on suite name. */
const FILTERS = [];
for (let i = 0; i < RAW_ARGS.length; i++) {
  if (RAW_ARGS[i] === "--filter" && RAW_ARGS[i + 1]) {
    FILTERS.push(...RAW_ARGS[i + 1].split(",").map((s) => s.trim()).filter(Boolean));
  }
}
const jsonFlag = RAW_ARGS.indexOf("--json");
const JSON_OUT = jsonFlag !== -1 && RAW_ARGS[jsonFlag + 1] ? RAW_ARGS[jsonFlag + 1] : null;

const SERVER_PORT = Number(process.env.OBV_TEST_SERVER_PORT || 3600);
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

/** Full per-suite output lands here; CI uploads this directory. */
const LOG_DIR = path.join(ROOT, ".test-logs");
/** Per-suite wall-clock ceiling. The slowest suite is ~35s locally, so ten
 *  minutes is generous even on a slow shared CI runner — its only job is to
 *  turn a hang into a named failure with a transcript, well before the CI
 *  step timeout kills the whole job with no diagnosis. */
const SUITE_TIMEOUT_MS = Number(process.env.OBV_SUITE_TIMEOUT_MS || 600_000);

/** The banking layer is mock/demo-only in every test context. */
const SAFE_ENV = {
  ...process.env,
  OBV_BANKING_PROVIDER: "mock",
  OBV_BANKING_MODE: "demo",
  OBV_BANKING_PRODUCTION_ENABLE: "",
  // One signing secret for the whole run, so a suite that restarts its
  // server keeps the cookies it already holds. Random per run and never
  // committed — it exists only to make sessions stable within the battery.
  OBV_SESSION_SECRET:
    process.env.OBV_SESSION_SECRET || require("node:crypto").randomBytes(32).toString("hex"),
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
  "dispute-test.js",
  "dmv-test.js",
  "portfolio-test.js",
  "identity-test.js",
  "integrations-test.js",
  "evidence-intel-test.js",
  "official-sources-test.js",
  "timeline-test.js",
  "twin-test.js",
  "design-test.js",
  "workstation-test.js",
  "navigation-test.js",
  "cloud-portability-test.js",
  "lender-pilot-test.js",
  "authz-test.js",
  "toolchain-test.js",
  "backup-restore-test.js",
  "pilot-production-test.js",
  "pilot-acceptance-test.js",
];

/** Suites that target one shared, freshly seeded application server. */
const SERVER_BASED = [
  "intelligence-test.js",
  "report-test.js",
  "frontend-test.js",
  "acceptance-test.js",
];

const selected = (name) => FILTERS.length === 0 || FILTERS.some((f) => name.includes(f));

const results = [];
let anyFailure = false;
/** Module-scoped so finish() can ALWAYS tear it down — process.exit()
 *  skips finally blocks, and an orphaned shared server keeps the port
 *  bound and poisons every later run with stale state. */
let sharedServer = null;
let sharedDataDir = null;
let standaloneDataDir = null;

function killShared() {
  if (sharedServer) {
    try { sharedServer.kill(); } catch {}
    sharedServer = null;
  }
  if (sharedDataDir) {
    try { fs.rmSync(sharedDataDir, { recursive: true, force: true }); } catch {}
    sharedDataDir = null;
  }
  if (standaloneDataDir) {
    try { fs.rmSync(standaloneDataDir, { recursive: true, force: true }); } catch {}
    standaloneDataDir = null;
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.error(`\nreceived ${sig} — tearing down the shared server`);
    killShared();
    process.exit(130);
  });
}

function parseCheckpoints(output) {
  // Suites report "... PASSED — N checkpoints" (or similar).
  const matches = [...output.matchAll(/PASSED[^\n]*?(\d+)\s+checkpoints/g)];
  if (matches.length > 0) return Number(matches[matches.length - 1][1]);
  const alt = [...output.matchAll(/(\d+)[^\n]*?checkpoints/g)];
  return alt.length > 0 ? Number(alt[alt.length - 1][1]) : null;
}

/** The lines a human actually needs to see first when a suite fails. */
function failureHighlights(output) {
  const lines = output.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (/(✗|FAIL|FAILED|Error:|AssertionError|Timed out|ENOENT|ECONNREFUSED|EADDRINUSE)/.test(lines[i])) {
      hits.push(`    ${String(i + 1).padStart(4)}| ${lines[i].trim()}`);
    }
  }
  return hits.slice(0, 12);
}

function runSuite(name, argv, extraEnv = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, argv, {
      cwd: ROOT,
      env: { ...SAFE_ENV, ...extraEnv },
      // Always pipe: --verbose tees to the console AND keeps the
      // transcript, so verbose runs still produce checkpoint counts,
      // summary.json and per-suite logs.
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so a timeout can kill the suite AND the server
      // it spawned. Killing only the suite orphans that server, which
      // keeps its port bound and silently answers the next run from stale
      // data — a failure that looks like a real regression but is not.
      detached: true,
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d;
      if (VERBOSE) process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      output += d;
      if (VERBOSE) process.stderr.write(d);
    });
    // A suite that hangs must FAIL with its transcript, not stall the run
    // until the CI step timeout kills everything opaquely. SIGKILL follows
    // shortly after SIGTERM so a wedged browser process cannot ignore it.
    let timedOut = false;
    /** Signal the suite's whole process group (negative pid), so any
     *  server it started dies with it rather than being orphaned. */
    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch {} }
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      output += `\n\n*** SUITE TIMEOUT after ${SUITE_TIMEOUT_MS}ms — killed by the runner ***\n`;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000).unref();
    }, SUITE_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(killTimer);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const ok = code === 0 && !timedOut;
      // Always persist the full transcript — a CI failure must be
      // diagnosable from the uploaded artifact alone.
      const logPath = path.join(LOG_DIR, `${name.replace(/\.js$/, "")}.log`);
      try { fs.writeFileSync(logPath, output); } catch {}
      results.push({
        name, ok, seconds: Number(seconds), exitCode: code,
        checkpoints: ok ? parseCheckpoints(output) : null,
        log: path.relative(ROOT, logPath),
      });
      if (ok) {
        console.log(`  PASS  ${name} (${seconds}s)`);
      } else {
        anyFailure = true;
        console.error(`\n  FAIL  ${name} (exit ${code}, ${seconds}s)`);
        {
          const highlights = failureHighlights(output);
          if (highlights.length) {
            console.error("  ---- failure lines ----");
            console.error(highlights.join("\n"));
          }
          console.error("  ---- last output ----");
          console.error(output.split("\n").slice(-25).join("\n"));
        }
        const envPrefix = Object.entries(extraEnv)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ");
        console.error(`  full log:   ${path.relative(ROOT, logPath)}`);
        console.error(`  reproduce:  ${envPrefix ? envPrefix + " " : ""}node ${path.relative(ROOT, argv[0])}${argv.length > 1 ? " " + argv.slice(1).join(" ") : ""}`);
        if (envPrefix) {
          console.error("              (that suite needs the shared server: npm test -- --filter " + name.replace(/-test\.js$/, "") + ")");
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

/** Fail fast on a broken environment instead of deep inside a suite. */
function preflight() {
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  let browser = "not checked";
  try {
    const { chromiumUnavailableReason, playwrightVersion } = require("./lib/browser");
    const reason = chromiumUnavailableReason();
    browser = reason ? `UNAVAILABLE — ${reason}` : `playwright ${playwrightVersion()} + chromium ready`;
  } catch (err) {
    browser = `UNAVAILABLE — ${err.message}`;
  }
  console.log(`node:    ${process.versions.node}${nodeOk ? "" : "  (WARNING: node:sqlite needs >= 22.5)"}`);
  console.log(`browser: ${browser}`);
  console.log(`banking: provider=${SAFE_ENV.OBV_BANKING_PROVIDER} mode=${SAFE_ENV.OBV_BANKING_MODE} (forced)`);
  return { nodeVersion: process.versions.node, nodeOk, browser };
}

async function main() {
  const startedAll = Date.now();
  console.log("OBV unified test runner");

  if (LIST_ONLY) {
    console.log("\nstandalone suites (own database + server):");
    for (const s of STANDALONE) console.log(`  ${s}`);
    console.log("\nserver-based suites (shared seeded server):");
    for (const s of SERVER_BASED) console.log(`  ${s}`);
    console.log("\ndeployment checks:\n  deploy-check.js");
    return;
  }

  console.log(`mode: ${FAIL_FAST ? "fail-fast" : "continue-on-failure"}${VERBOSE ? ", verbose" : ""}` +
    (FILTERS.length ? `, filter=[${FILTERS.join(", ")}]` : ""));
  fs.rmSync(LOG_DIR, { recursive: true, force: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const env = preflight();

  // ---- 1. build (exactly once) ----
  if (!SKIP_BUILD) {
    console.log("\n== build ==");
    if (!(await runNpmBuild())) {
      console.error("\nFAILED SUITE: TypeScript build");
      writeSummary(env, startedAll);
      process.exit(1);
    }
  } else {
    console.log("\n== build skipped (--skip-build) ==");
    if (!fs.existsSync(path.join(ROOT, "dist", "server", "http", "server.js"))) {
      console.error("\nFAILED: --skip-build was requested but dist/ is missing or incomplete — run `npm run build` first");
      anyFailure = true;
      writeSummary(env, startedAll);
      process.exit(1);
    }
  }

  // ---- 2. standalone suites ----
  // Most standalone suites create their own temp database. The few that
  // fall back to the ambient data directory must NOT get the developer's
  // repository data/ — they get a freshly seeded throwaway instead, so a
  // test run is hermetic and never depends on (or destroys) local state.
  const standalone = STANDALONE.filter(selected);
  console.log(`\n== standalone suites (${standalone.length}) ==`);
  standaloneDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obv-standalone-"));
  await new Promise((r) =>
    spawn(process.execPath, [path.join(ROOT, "dist", "server", "db", "seed.js")], {
      cwd: ROOT,
      env: { ...SAFE_ENV, OBV_DATA_DIR: standaloneDataDir },
      stdio: "ignore",
    }).on("exit", r)
  );
  for (const script of standalone) {
    const full = path.join(ROOT, "scripts", script);
    if (!fs.existsSync(full)) {
      // A suite listed in the inventory but missing from disk means the
      // runner silently stopped validating something. That is a failure,
      // not a skip.
      anyFailure = true;
      results.push({ name: script, ok: false, seconds: 0, exitCode: null, checkpoints: null, log: null });
      console.error(`  FAIL  ${script} (listed in the runner inventory but not present on disk)`);
      if (FAIL_FAST) return finish(env, startedAll);
      continue;
    }
    const ok = await runSuite(script, [full], { OBV_DATA_DIR: standaloneDataDir });
    if (!ok && FAIL_FAST) return finish(env, startedAll);
  }

  // ---- 3. shared server for the server-based suites ----
  const serverBased = SERVER_BASED.filter(selected);
  const wantDeployCheck = selected("deploy-check.js");
  if (serverBased.length === 0 && !wantDeployCheck) {
    console.log("\n== server-based suites skipped (filtered out) ==");
    return finish(env, startedAll);
  }
  console.log(`\n== server-based suites (${serverBased.length}) ==`);
  // The port must be FREE before we boot: a stale server (e.g. orphaned
  // by a crashed earlier run) would answer the health check with the
  // WRONG database and every count comparison would silently diverge.
  const stale = await (async () => {
    try {
      return (await fetch(BASE + "/api/health")).ok;
    } catch {
      return false;
    }
  })();
  if (stale) {
    anyFailure = true;
    console.error(`  FAIL  something is already listening on :${SERVER_PORT} — kill the stale server (or set OBV_TEST_SERVER_PORT) and rerun`);
    return finish(env, startedAll);
  }
  sharedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obv-runner-"));
  try {
    await new Promise((r) =>
      spawn(process.execPath, [path.join(ROOT, "dist", "server", "db", "seed.js")], {
        cwd: ROOT,
        env: { ...SAFE_ENV, OBV_DATA_DIR: sharedDataDir },
        stdio: "ignore",
      }).on("exit", r)
    );
    sharedServer = spawn(process.execPath, [path.join(ROOT, "dist", "server", "http", "server.js")], {
      cwd: ROOT,
      env: { ...SAFE_ENV, OBV_DATA_DIR: sharedDataDir, PORT: String(SERVER_PORT) },
      stdio: "ignore",
    });
    if (!(await waitForHealth(BASE))) {
      anyFailure = true;
      console.error(`  FAIL  shared application server did not become healthy on :${SERVER_PORT}`);
      return finish(env, startedAll);
    }
    const serverEnv = {
      OBV_BASE_URL: BASE,
      BASE,
      OBV_DB: path.join(sharedDataDir, "obv.db"),
    };
    for (const script of serverBased) {
      const full = path.join(ROOT, "scripts", script);
      if (!fs.existsSync(full)) {
        anyFailure = true;
        results.push({ name: script, ok: false, seconds: 0, exitCode: null, checkpoints: null, log: null });
        console.error(`  FAIL  ${script} (listed in the runner inventory but not present on disk)`);
        if (FAIL_FAST) return finish(env, startedAll);
        continue;
      }
      const ok = await runSuite(script, [full], serverEnv);
      if (!ok && FAIL_FAST) return finish(env, startedAll);
    }

    // ---- 4. deployment configuration checks ----
    if (wantDeployCheck) {
      console.log("\n== deployment checks ==");
      const ok = await runSuite("deploy-check.js", [path.join(ROOT, "scripts", "deploy-check.js"), BASE]);
      if (!ok && FAIL_FAST) return finish(env, startedAll);
    }
  } finally {
    killShared();
  }

  finish(env, startedAll);
}

function writeSummary(env, startedAll) {
  const failed = results.filter((r) => !r.ok);
  const summary = {
    ok: !anyFailure,
    startedAt: new Date(startedAll).toISOString(),
    durationSeconds: Number(((Date.now() - startedAll) / 1000).toFixed(1)),
    node: env.nodeVersion,
    browser: env.browser,
    banking: { provider: SAFE_ENV.OBV_BANKING_PROVIDER, mode: SAFE_ENV.OBV_BANKING_MODE },
    filters: FILTERS,
    suites: results,
    totals: {
      suites: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      checkpoints: results.reduce((s, r) => s + (r.checkpoints || 0), 0),
    },
    failedSuites: failed.map((r) => ({ name: r.name, exitCode: r.exitCode, log: r.log })),
  };
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, "summary.json"), JSON.stringify(summary, null, 2));
    if (JSON_OUT) fs.writeFileSync(path.resolve(ROOT, JSON_OUT), JSON.stringify(summary, null, 2));
  } catch {}
  return summary;
}

function finish(env, startedAll) {
  // finish() may process.exit(), which skips finally blocks — the shared
  // server MUST die here or it poisons the port for every later run.
  killShared();
  console.log("\n== summary ==");
  let totalCheckpoints = 0;
  for (const r of results) {
    const cp = r.checkpoints !== null ? ` ${String(r.checkpoints).padStart(4)} checkpoints` : "     —";
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(28)}${cp}  ${r.seconds}s`);
    if (r.checkpoints) totalCheckpoints += r.checkpoints;
  }
  const failed = results.filter((r) => !r.ok);
  const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 3);
  if (slowest.length) {
    console.log(`\n  slowest: ${slowest.map((r) => `${r.name} ${r.seconds}s`).join(", ")}`);
  }
  console.log(`  total:   ${((Date.now() - startedAll) / 1000).toFixed(1)}s`);
  console.log(`\n  suites: ${results.length - failed.length}/${results.length} passed` +
    (totalCheckpoints ? `, ${totalCheckpoints} checkpoints` : ""));
  writeSummary(env, startedAll);
  console.log(`  logs:   ${path.relative(ROOT, LOG_DIR)}/ (summary.json + one log per suite)`);
  if (anyFailure) {
    console.error(`\nFAILED: ${failed.map((r) => r.name).join(", ") || "server bootstrap"}`);
    process.exit(1);
  }
  console.log("\nALL SUITES PASSED.");
}

main().catch((err) => {
  console.error(err);
  killShared();
  process.exit(1);
});
