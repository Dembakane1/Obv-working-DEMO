"use strict";
/**
 * One reproducible Chromium entry point for every browser-driven script.
 *
 * Playwright is a PINNED project devDependency (package.json +
 * package-lock.json), so `require("playwright")` resolves from the
 * project's node_modules after `npm ci`. There is deliberately no
 * NODE_PATH lookup, no globally installed copy and no hardcoded browser
 * path: local and CI resolve the identical Playwright build, and the
 * browser itself is installed by the identical command
 * (`npm run browsers` → `playwright install --with-deps chromium`).
 *
 * Scripts keep full control of their launch options — this module only
 * centralises resolution and turns the two common setup failures into
 * actionable messages instead of raw module/launch stack traces.
 */
const fs = require("node:fs");

const SETUP_HINT = "run `npm ci` (installs the pinned Playwright) then `npm run browsers`";

/** The pinned Playwright module, or null when it is not installed. */
function requirePlaywright() {
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

/** Installed Playwright version, or null. */
function playwrightVersion() {
  try {
    return require("playwright/package.json").version;
  } catch {
    return null;
  }
}

/**
 * Why a browser run cannot proceed, or null when everything is ready.
 * Used by `npm run doctor` and by suites that want to explain a skip.
 */
function chromiumUnavailableReason() {
  const pw = requirePlaywright();
  if (!pw) return `Playwright is not installed — ${SETUP_HINT}.`;
  let exe;
  try {
    exe = pw.chromium.executablePath();
  } catch (err) {
    return `Playwright ${playwrightVersion()} could not resolve a Chromium path (${err.message}) — ${SETUP_HINT}.`;
  }
  if (!exe || !fs.existsSync(exe)) {
    return (
      `Chromium build for Playwright ${playwrightVersion()} is not installed ` +
      `(expected ${exe || "unknown path"}) — run \`npm run browsers\`.`
    );
  }
  return null;
}

/** True when a Chromium launch is expected to succeed. */
function chromiumAvailable() {
  return chromiumUnavailableReason() === null;
}

/**
 * Launch Chromium with the caller's own options (args, permissions,
 * geolocation, …) passed through untouched. Throws a setup-actionable
 * Error when Playwright or the browser build is missing.
 */
async function launchChromium(options = {}) {
  const reason = chromiumUnavailableReason();
  if (reason) throw new Error(reason);
  return requirePlaywright().chromium.launch(options);
}

module.exports = {
  SETUP_HINT,
  requirePlaywright,
  playwrightVersion,
  chromiumUnavailableReason,
  chromiumAvailable,
  launchChromium,
};
