#!/usr/bin/env node
/**
 * Environment preflight — `npm run doctor`.
 *
 * Answers the only question a new developer (or a confused CI log)
 * actually has: is this checkout ready to build, seed, run and test, and
 * if not, exactly which command fixes it?
 *
 * Read-only: it inspects, it never installs, builds, seeds or mutates.
 */
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const rows = [];
let blocking = 0;
const ok = (label, detail) => rows.push({ state: "ok", label, detail });
const warn = (label, detail, fix) => rows.push({ state: "warn", label, detail, fix });
const bad = (label, detail, fix) => {
  blocking++;
  rows.push({ state: "bad", label, detail, fix });
};

function installedVersion(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

(async () => {
  console.log("OBV environment doctor\n");

  // ---- runtime ----
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 5)) {
    ok("node", `${process.versions.node} (satisfies ${pkg.engines.node})`);
  } else {
    bad("node", `${process.versions.node} does not satisfy ${pkg.engines.node}`, "install Node >= 22.5 (see .node-version)");
  }
  // Satisfying engines is not the same as matching what CI runs. A
  // node:sqlite behaviour difference between two 22.x releases is enough
  // to pass locally and fail in CI, so surface the drift explicitly.
  try {
    const pinned = fs.readFileSync(path.join(ROOT, ".node-version"), "utf8").trim();
    if (pinned && pinned !== process.versions.node) {
      warn(
        "node version parity",
        `local ${process.versions.node} != .node-version ${pinned} (what CI runs)`,
        `use Node ${pinned} locally (nvm/fnm/volta read .node-version) so local results match CI`
      );
    } else if (pinned) {
      ok("node version parity", `matches .node-version (${pinned}) — same runtime as CI`);
    }
  } catch {
    warn("node version parity", ".node-version is unreadable", "restore .node-version");
  }
  try {
    require("node:sqlite");
    ok("node:sqlite", "built-in SQLite available (no native module needed)");
  } catch {
    bad("node:sqlite", "not available in this Node build", "use Node >= 22.5 with node:sqlite enabled");
  }

  // ---- dependencies ----
  const lockPath = path.join(ROOT, "package-lock.json");
  if (!fs.existsSync(lockPath)) {
    bad("lockfile", "package-lock.json is missing", "restore it from git — deterministic installs depend on it");
  } else {
    ok("lockfile", "package-lock.json present (npm ci installs exact versions)");
  }
  const declared = pkg.devDependencies || {};
  const missing = [];
  const mismatched = [];
  for (const [name, want] of Object.entries(declared)) {
    const have = installedVersion(name);
    if (!have) missing.push(name);
    else if (have !== want) mismatched.push(`${name} ${have} != ${want}`);
  }
  if (missing.length) {
    bad("devDependencies", `not installed: ${missing.join(", ")}`, "npm ci");
  } else if (mismatched.length) {
    bad("devDependencies", `version drift: ${mismatched.join(", ")}`, "npm ci");
  } else {
    ok("devDependencies", Object.entries(declared).map(([k, v]) => `${k}@${v}`).join(", "));
  }

  // ---- browser tooling ----
  try {
    const { chromiumUnavailableReason, playwrightVersion } = require("./lib/browser");
    const reason = chromiumUnavailableReason();
    if (reason) warn("chromium", reason, "npm run browsers");
    else ok("chromium", `installed for Playwright ${playwrightVersion()}`);
  } catch (err) {
    warn("chromium", `browser helper unavailable: ${err.message}`, "npm ci && npm run browsers");
  }

  // ---- build + data ----
  const serverEntry = path.join(ROOT, "dist", "server", "http", "server.js");
  if (fs.existsSync(serverEntry)) ok("build", "dist/ present (npm run build refreshes it)");
  else warn("build", "dist/ is missing or incomplete", "npm run build");

  const dbPath = path.join(ROOT, process.env.OBV_DATA_DIR ? path.relative(ROOT, process.env.OBV_DATA_DIR) : "data", "obv.db");
  if (fs.existsSync(dbPath)) ok("database", `${path.relative(ROOT, dbPath)} present`);
  else warn("database", "no seeded database yet", "npm run seed");

  // ---- ports ----
  const appPort = Number(process.env.PORT || 3000);
  const runnerPort = Number(process.env.OBV_TEST_SERVER_PORT || 3600);
  for (const [label, port] of [["app port", appPort], ["test runner port", runnerPort]]) {
    if (await portFree(port)) ok(label, `${port} is free`);
    else warn(label, `${port} is already in use`, `stop the process on :${port} (a stale server poisons test runs)`);
  }

  // ---- banking posture ----
  const provider = process.env.OBV_BANKING_PROVIDER || "(unset → mock)";
  const mode = process.env.OBV_BANKING_MODE || "(unset → demo)";
  const prodEnable = process.env.OBV_BANKING_PRODUCTION_ENABLE;
  if (prodEnable && /^(1|true)$/i.test(prodEnable)) {
    bad("banking", `OBV_BANKING_PRODUCTION_ENABLE=${prodEnable}`, "unset it — this repository is a demo and must stay on the mock provider");
  } else {
    ok("banking", `provider=${provider} mode=${mode} (tests force mock/demo regardless)`);
  }

  // ---- report ----
  const glyph = { ok: "✓", warn: "!", bad: "✗" };
  for (const r of rows) {
    console.log(`  ${glyph[r.state]} ${r.label.padEnd(16)} ${r.detail}`);
    if (r.fix) console.log(`  ${" ".repeat(18)}fix: ${r.fix}`);
  }

  const warns = rows.filter((r) => r.state === "warn").length;
  console.log(
    `\n  ${rows.filter((r) => r.state === "ok").length} ok, ${warns} warning(s), ${blocking} blocking issue(s)`
  );
  if (blocking === 0 && warns === 0) {
    console.log("\nReady:  npm run build && npm run seed && npm start   (or: npm test)");
  } else if (blocking === 0) {
    console.log("\nUsable — resolve the warnings above before running the browser suites.");
  } else {
    console.log("\nBlocked — fix the ✗ items above first.");
  }
  process.exit(blocking === 0 ? 0 : 1);
})();
