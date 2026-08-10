#!/usr/bin/env node
/**
 * Production readiness command — `npm run pilot:check`.
 *
 * Inspects the CURRENT environment (the same env vars the server reads)
 * and reports PASS / WARN / FAIL per readiness control. Exit code 1 when
 * anything FAILs: external pilot traffic must not begin.
 *
 * NEVER prints secret values — only whether one is configured, and its
 * length class where that is operationally meaningful.
 *
 * Run it in the deployment environment (e.g. as a Render one-off job or
 * over SSH) so it sees the real configuration; run with
 * OBV_PILOT_CHECK_SKIP_NET=1 to skip the provider reachability probe in
 * network-restricted contexts (reported as WARN, never silently).
 */
const path = require("node:path");
const fs = require("node:fs");

const DIST = path.join(__dirname, "..", "dist", "server");
const results = [];
const add = (level, control, detail) => results.push({ level, control, detail });
const pass = (c, d) => add("PASS", c, d);
const warn = (c, d) => add("WARN", c, d);
const fail = (c, d) => add("FAIL", c, d);

async function main() {
  // ---------- posture ----------
  let posture;
  try {
    posture = require(path.join(DIST, "services", "posture.js"));
    const env = posture.environmentName();
    if (env === "demo") {
      warn("environment", "OBV_ENVIRONMENT is demo (or unset) — do not point external lender users at this deployment");
    } else {
      pass("environment", `OBV_ENVIRONMENT=${env}`);
    }
    posture.assertPostureConfig();
    pass("posture flags", "no contradictory demo flags");
  } catch (e) {
    fail("environment", e.message);
    finish();
    return;
  }
  const production = posture.productionPosture();

  // ---------- identity / sessions ----------
  const secret = (process.env.OBV_SESSION_SECRET ?? "").trim();
  if (secret.length >= 32) pass("session secret", "OBV_SESSION_SECRET configured (>=32 chars)");
  else if (production) fail("session secret", "OBV_SESSION_SECRET missing/short — production refuses to start without it");
  else warn("session secret", "ephemeral per-boot secret (fine for demo only)");

  try {
    const session = require(path.join(DIST, "http", "session.js"));
    if (session.demoAuthEnabled()) {
      (production ? fail : warn)("demo switcher", "the passwordless demo role switcher is ENABLED");
    } else {
      pass("demo switcher", "disabled — production identity is the only sign-in");
    }
  } catch (e) {
    fail("demo switcher", e.message);
  }

  let identityCfg = null;
  try {
    const core = require(path.join(DIST, "services", "identity", "core.js"));
    identityCfg = core.identityConfig();
    if (identityCfg.deliveryMode === "email") {
      pass("auth link delivery", "OBV_AUTH_LINK_DELIVERY=email (real provider)");
    } else if (production) {
      fail("auth link delivery", `development ${identityCfg.deliveryMode} delivery active in a ${posture.environmentName()} environment — external users cannot sign in`);
    } else {
      pass("auth link delivery", `${identityCfg.deliveryMode} (development)`);
    }
  } catch (e) {
    fail("auth link delivery", e.message);
  }

  // ---------- email provider ----------
  let emailMod = null;
  try {
    emailMod = require(path.join(DIST, "services", "integrations", "email.js"));
    require(path.join(DIST, "services", "integrations", "core.js")).integrationsConfig();
    emailMod.assertEmailProviderConfig();
    const provider = emailMod.resolveEmailProvider();
    if (provider.name === "outbox") {
      (production ? fail : pass)(
        "email provider",
        production
          ? "development outbox active in pilot environment — no real email can leave"
          : "development outbox (fine for demo)"
      );
    } else {
      pass("email provider", `${provider.name} configured (credentials present; values not printed)`);
    }
  } catch (e) {
    fail("email provider", e.message);
  }
  if (emailMod && production) {
    if (process.env.OBV_PILOT_CHECK_SKIP_NET === "1") {
      warn("email reachability", "network probe skipped (OBV_PILOT_CHECK_SKIP_NET=1)");
    } else {
      try {
        const cfg = emailMod.postmarkConfig();
        const res = await fetch(cfg.apiBaseUrl, { method: "GET", signal: AbortSignal.timeout(5000) });
        pass("email reachability", `provider endpoint reachable (HTTP ${res.status})`);
      } catch (e) {
        warn("email reachability", `provider endpoint not reachable from here: ${String(e.message ?? e).slice(0, 80)}`);
      }
    }
  }
  const baseUrl = (process.env.OBV_PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").trim();
  if (baseUrl) pass("public base URL", baseUrl);
  else (production ? fail : warn)("public base URL", "OBV_PUBLIC_BASE_URL not set — emailed links would use the request host");

  // ---------- storage / database ----------
  try {
    const storage = require(path.join(DIST, "services", "ops", "storage.js"));
    const sp = storage.storagePosture();
    if (sp.dataDirExplicit) pass("persistent data root", sp.dataDir);
    else (production ? fail : warn)("persistent data root", `cwd-relative ${sp.dataDir} — ephemeral on hosted deploys`);
    const broken = sp.roots.filter((r) => !r.writable);
    if (broken.length === 0) pass("storage writable", `${sp.roots.length} roots writable`);
    else fail("storage writable", broken.map((r) => `${r.name}: ${r.dir}`).join("; "));
    if (sp.databaseExists) {
      try {
        const report = storage.databaseSafetyCheck();
        pass("database integrity", `quick_check ok, ${report.foreignKeyViolations} FK violation(s), schema v${report.schemaVersion}`);
      } catch (e) {
        fail("database integrity", e.message);
      }
      // Demo fixtures inside a pilot database defeat the separation.
      try {
        const repo = require(path.join(DIST, "db", "repo.js"));
        const demoProjects = ["proj-r47", "proj-dmv"].filter((id) => repo.getProject(id));
        if (production && demoProjects.length) fail("no demo data", `demo project(s) present: ${demoProjects.join(", ")}`);
        else pass("no demo data", production ? "no demo fixtures in the database" : "demo database (expected in demo)");
      } catch (e) {
        warn("no demo data", `could not inspect: ${String(e.message ?? e).slice(0, 80)}`);
      }
    } else {
      warn("database", "no database file yet (first boot will create the schema and the bootstrap admin)");
    }
    if ((process.env.OBV_SEED_GOLDEN ?? "") === "1") {
      (production ? fail : pass)("golden seed", production ? "OBV_SEED_GOLDEN=1 set in a production posture" : "golden seed enabled (demo)");
    } else {
      pass("golden seed", "not enabled");
    }

    // ---------- backups ----------
    try {
      const backups = require(path.join(DIST, "services", "ops", "backups.js"));
      pass("backup directory", storage.BACKUPS_DIR);
      if (sp.databaseExists) {
        const latest = backups.latestVerifiedBackup();
        const hours = backups.hoursSinceLastBackup();
        if (latest && hours <= 26) pass("latest backup verified", `${latest.createdAt} (${hours.toFixed(1)}h ago)`);
        else if (latest) (production ? fail : warn)("latest backup verified", `last verified backup is ${hours.toFixed(1)}h old — schedule npm run backup`);
        else (production ? fail : warn)("latest backup verified", "no verified backup exists — run npm run backup");
      } else {
        warn("latest backup verified", "no database yet — nothing to back up");
      }
    } catch (e) {
      fail("backups", e.message);
    }
  } catch (e) {
    fail("storage", e.message);
  }

  // ---------- banking ----------
  try {
    const registry = require(path.join(DIST, "services", "banking", "registry.js"));
    if (registry.bankingMode() === "production") {
      pass("banking simulation", "unavailable (production banking mode; mock provider only records eligibility)");
    } else {
      (production ? fail : warn)("banking simulation", "demo banking mode — simulation surfaces are live");
    }
    if ((process.env.OBV_BANKING_PROVIDER ?? "mock") !== "mock" ) {
      fail("banking provider", "a non-mock provider is configured — real banking is out of scope for the pilot");
    } else {
      pass("banking provider", "mock (no real money can move through OBV)");
    }
  } catch (e) {
    fail("banking", e.message);
  }

  // ---------- bootstrap ----------
  const bootstrap = (process.env.OBV_BOOTSTRAP_ADMIN_EMAIL ?? "").trim();
  try {
    const identityRepo = require(path.join(DIST, "db", "identityRepo.js"));
    const identities = identityRepo.countIdentities();
    if (identities > 0) pass("admin identity", `${identities} identit${identities === 1 ? "y" : "ies"} exist`);
    else if (bootstrap) pass("admin identity", "none yet; OBV_BOOTSTRAP_ADMIN_EMAIL set for first boot");
    else (production ? fail : warn)("admin identity", "no identities and no OBV_BOOTSTRAP_ADMIN_EMAIL — nobody can ever sign in");
  } catch {
    if (bootstrap) pass("admin identity", "OBV_BOOTSTRAP_ADMIN_EMAIL set for first boot");
    else (production ? fail : warn)("admin identity", "no database and no OBV_BOOTSTRAP_ADMIN_EMAIL");
  }

  finish();
}

function finish() {
  const width = Math.max(...results.map((r) => r.control.length));
  let fails = 0;
  for (const r of results) {
    if (r.level === "FAIL") fails++;
    console.log(`${r.level.padEnd(5)} ${r.control.padEnd(width)}  ${r.detail}`);
  }
  const warns = results.filter((r) => r.level === "WARN").length;
  console.log(`\n${fails === 0 ? "READY" : "NOT READY"} — ${results.length} controls: ${results.length - fails - warns} pass, ${warns} warn, ${fails} fail`);
  if (fails > 0) {
    console.log("A FAIL means external pilot traffic should not begin.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`pilot:check crashed: ${err.stack ?? err}`);
  process.exit(1);
});
