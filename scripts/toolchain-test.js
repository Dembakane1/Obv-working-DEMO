#!/usr/bin/env node
/**
 * Toolchain + supply-chain guard suite.
 *
 * These are the invariants that make an OBV build reproducible and
 * auditable for a lender pilot. They are cheap, offline, and they fail
 * loudly the moment someone reintroduces a floating dependency, drops
 * the lockfile, lets a runtime dependency into a zero-dependency
 * application, or weakens the mock-banking guarantee in CI.
 *
 *   node scripts/toolchain-test.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const json = (p) => JSON.parse(read(p));

let n = 0;
const pass = (m) => console.log(`  ✓ [${String(++n).padStart(2, "0")}] ${m}`);
const fail = (m) => {
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (c, m) => (c ? pass(m) : fail(m));

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

(function main() {
  console.log("Toolchain + supply-chain guards");

  const pkg = json("package.json");
  const lock = json("package-lock.json");

  // ---- 1. the application itself stays zero-dependency ----
  const runtimeDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.optionalDependencies || {}),
    ...(pkg.peerDependencies || {}),
  };
  assert(
    Object.keys(runtimeDeps).length === 0,
    "package.json declares ZERO runtime dependencies (the app runs on Node built-ins only)"
  );

  // The strongest form of the same claim: no non-node: import anywhere in
  // the shipped source. Type-only imports are erased, so they count too.
  const srcFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) srcFiles.push(p);
    }
  })(path.join(ROOT, "src"));
  const external = [];
  for (const f of srcFiles) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith(".") && !spec.startsWith("node:")) {
        external.push(`${path.relative(ROOT, f)} -> ${spec}`);
      }
    }
  }
  assert(
    external.length === 0,
    `no source file imports an external package (${srcFiles.length} files scanned)` +
      (external.length ? ` — found: ${external.join(", ")}` : "")
  );

  // ---- 2. deterministic installs ----
  assert(fs.existsSync(path.join(ROOT, "package-lock.json")), "a package-lock.json is committed");
  assert(lock.lockfileVersion >= 3, `lockfile format is v${lock.lockfileVersion} (>= 3)`);

  const declared = pkg.devDependencies || {};
  const floating = Object.entries(declared).filter(([, v]) => !EXACT_VERSION.test(v));
  assert(
    floating.length === 0,
    `every devDependency is pinned to an exact version (${Object.keys(declared).length} declared)` +
      (floating.length ? ` — floating: ${floating.map(([k, v]) => `${k}@${v}`).join(", ")}` : "")
  );

  const entries = Object.entries(lock.packages || {}).filter(([k]) => k !== "");
  const missingIntegrity = entries.filter(([, v]) => !v.integrity && !v.link);
  assert(
    entries.length > 0 && missingIntegrity.length === 0,
    `every one of the ${entries.length} locked packages carries an integrity hash` +
      (missingIntegrity.length ? ` — missing: ${missingIntegrity.map(([k]) => k).join(", ")}` : "")
  );
  const missingResolved = entries.filter(([, v]) => !v.resolved && !v.link);
  assert(
    missingResolved.length === 0,
    "every locked package records its resolved registry URL"
  );

  // package.json and the lockfile must agree exactly — otherwise `npm ci`
  // and a developer's `npm install` diverge.
  const rootDeps = (lock.packages[""] || {}).devDependencies || {};
  const drift = Object.entries(declared).filter(([k, v]) => rootDeps[k] !== v);
  assert(drift.length === 0, "package.json devDependencies match the lockfile root exactly");
  for (const [name, version] of Object.entries(declared)) {
    const locked = lock.packages[`node_modules/${name}`];
    if (!locked) fail(`${name} is declared but absent from the lockfile`);
    if (locked.version !== version) fail(`${name} locked at ${locked.version}, declared ${version}`);
  }
  pass(`each declared devDependency resolves to its exact locked version (${Object.keys(declared).join(", ")})`);

  // ---- 3. install-time execution surface ----
  const npmrc = read(".npmrc");
  assert(/^\s*ignore-scripts\s*=\s*true\s*$/m.test(npmrc),
    ".npmrc sets ignore-scripts=true (dependency install scripts cannot execute)");
  assert(/^\s*save-exact\s*=\s*true\s*$/m.test(npmrc),
    ".npmrc sets save-exact=true (new dependencies can never be added as floating ranges)");
  assert(/^\s*engine-strict\s*=\s*true\s*$/m.test(npmrc),
    ".npmrc sets engine-strict=true (refuses an unsupported Node)");

  // ---- 4. engine agreement ----
  const nodeVersionFile = read(".node-version").trim();
  const enginesMajor = (pkg.engines.node.match(/(\d+)/) || [])[1];
  assert(
    nodeVersionFile.startsWith(`${enginesMajor}.`),
    `.node-version (${nodeVersionFile}) satisfies engines.node (${pkg.engines.node})`
  );

  // ---- 5. the scripts a developer and CI both rely on ----
  for (const s of ["build", "test", "start", "seed", "doctor", "browsers", "audit", "audit:prod"]) {
    if (!pkg.scripts[s]) fail(`package.json is missing the "${s}" script`);
  }
  assert(true, "package.json exposes build, test, start, seed, doctor, browsers and audit scripts");
  assert(
    pkg.scripts.test.includes("run-all-tests.js"),
    "`npm test` runs the complete unified suite (not a subset)"
  );

  // ---- 6. browser tooling is a pinned project dependency ----
  assert(
    EXACT_VERSION.test(declared.playwright || ""),
    `Playwright is a pinned devDependency (${declared.playwright}) — not a global or --no-save install`
  );
  const scriptFiles = fs
    .readdirSync(path.join(ROOT, "scripts"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join("scripts", f));
  const globalRefs = [...scriptFiles, ...srcFiles.map((f) => path.relative(ROOT, f))].filter((f) =>
    /\/opt\/node22\/lib\/node_modules|\/opt\/pw-browsers/.test(fs.readFileSync(path.join(ROOT, f), "utf8"))
  );
  assert(
    globalRefs.length === 0,
    "no script or source file resolves Playwright or Chromium from a hardcoded machine-specific path" +
      (globalRefs.length ? ` — found in: ${globalRefs.join(", ")}` : "")
  );

  // ---- 6b. the vendored offline fallback must not drift from the pin ----
  // node_modules/@types is committed so `tsc` works without registry
  // access. If it ever diverges from the locked version, local builds and
  // CI builds type-check against different definitions.
  const vendoredTypesPkg = path.join(ROOT, "node_modules", "@types", "node", "package.json");
  if (fs.existsSync(vendoredTypesPkg)) {
    const vendored = JSON.parse(fs.readFileSync(vendoredTypesPkg, "utf8")).version;
    assert(
      vendored === declared["@types/node"],
      `the vendored @types/node (${vendored}) matches the locked pin (${declared["@types/node"]})`
    );
  } else {
    pass("no vendored @types/node present (nothing to drift)");
  }

  // ---- 6c. the Docker image must not silently ship a broken renderer ----
  // Negative checks read EXECUTED instructions only — a comment that
  // documents a forbidden pattern is not the forbidden pattern.
  const dockerfile = read("Dockerfile")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert(
    /npm ci/.test(dockerfile) && !/npm install/.test(dockerfile),
    "the Docker image installs from the lockfile (npm ci), never npm install"
  );
  assert(
    !/\|\|\s*true/.test(dockerfile),
    "no Dockerfile RUN chain masks a failure with `|| true`"
  );
  assert(
    !/npm prune/.test(dockerfile),
    "the runtime image never prunes dev dependencies (Playwright IS the renderer it needs)"
  );
  assert(
    /COPY scripts\/lib/.test(dockerfile),
    "the runtime image ships scripts/lib (the PDF renderer requires the browser helper)"
  );

  // ---- 7. CI parity and the mock-banking guarantee ----
  // Negative assertions must look at EXECUTED yaml only: a comment that
  // documents why something is forbidden is not the forbidden thing.
  const ciRaw = read(".github/workflows/ci.yml");
  const ci = ciRaw
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  assert(/\bnpm ci\b/.test(ci), "CI installs with `npm ci` (lockfile-exact, reproducible)");
  assert(!/\bnpm install\b/.test(ci), "CI never uses `npm install` (which could resolve different versions)");
  assert(
    /OBV_BANKING_PROVIDER:\s*mock/.test(ci) && /OBV_BANKING_MODE:\s*demo/.test(ci),
    "CI forces the banking layer to the mock provider in demo mode"
  );
  assert(
    !/OBV_BANKING_PRODUCTION_ENABLE:\s*(true|1|"true")/.test(ci),
    "CI never enables production banking"
  );
  assert(
    /node scripts\/run-all-tests\.js|npm test/.test(ci),
    "CI runs the same unified runner a developer runs locally"
  );
  assert(/npm (?:run )?audit/.test(ci), "CI runs a dependency vulnerability audit");
  assert(
    !/npm audit fix|--fix\b/.test(ci),
    "the CI audit never rewrites dependencies automatically (`npm audit fix` is absent)"
  );
  // .test-logs/ is a dotted path; upload-artifact treats dotted paths as
  // hidden and silently uploads NOTHING without this flag, which quietly
  // voids the whole failure-diagnostics contract.
  assert(
    !/path:\s*\.test-logs\//.test(ci) || /include-hidden-files:\s*true/.test(ci),
    "the CI test-log artifact sets include-hidden-files (a dotted path is skipped otherwise)"
  );
  // CI must run the Node version the repo pins, not a floating major —
  // that difference is what let a node:sqlite incompatibility pass
  // locally and fail in CI.
  assert(
    /node-version-file:\s*\.node-version/.test(ci) && !/node-version:\s*['"]?\d/.test(ci),
    "CI takes its Node version from .node-version, never a floating major"
  );

  // The runner itself must force mock/demo regardless of ambient env.
  const runner = read("scripts/run-all-tests.js");
  assert(
    /OBV_BANKING_PROVIDER:\s*"mock"/.test(runner) && /OBV_BANKING_MODE:\s*"demo"/.test(runner),
    "the test runner forces mock/demo banking regardless of ambient environment"
  );

  // ---- 7b. authorization controls stay in place ----
  // These are cheap structural guards, not a substitute for authz-test.js.
  // They catch the specific regressions that would silently reopen the
  // holes this pass closed.
  const sessionSrc = read("src/server/http/session.ts");
  assert(
    /createHmac\(/.test(sessionSrc) && /timingSafeEqual\(/.test(sessionSrc),
    "session tokens are HMAC-signed and compared in constant time"
  );
  assert(
    /OBV_SESSION_SECRET/.test(sessionSrc) && /SessionConfigError/.test(sessionSrc),
    "a server secret is required, with explicit startup validation"
  );
  assert(
    !/OBV_SESSION_SECRET\s*=\s*["'][^"']+["']/.test(sessionSrc),
    "no session secret is hardcoded in the session module"
  );
  const serverSrc = read("src/server/http/server.ts");
  assert(
    /readSessionToken\(parseCookies\(req\)\[SESSION_COOKIE\]\)/.test(serverSrc),
    "currentUser resolves identity through the signed-token reader, never the raw cookie"
  );
  const authzSrc = read("src/server/services/authz.ts");
  assert(
    /export function requireProject/.test(authzSrc) && /AccessError/.test(authzSrc),
    "the shared authorization boundary exposes requireProject with a same-404 error"
  );
  assert(
    !/from "\.\/lenderAccess"/.test(authzSrc) && !/from "\.\/budgetProgress"/.test(authzSrc),
    "authz stays a dependency leaf (importing services back would recreate the load-time cycle)"
  );
  const orchestratorSrc = read("src/server/workflow/orchestrator.ts");
  assert(
    /requireApprovalRequestAccess/.test(orchestratorSrc),
    "the approval orchestrator enforces the tenant boundary itself, not only at the route"
  );
  const previewSrc = read("src/server/http/previewToken.ts");
  assert(
    /randomBytes\(32\)/.test(previewSrc) && /tokens\.delete\(token\)/.test(previewSrc),
    "render tokens are cryptographically random and single-use"
  );
  assert(
    /inlineWormMedia/.test(serverSrc),
    "report HTML inlines WORM media, so /worm/ can stay session-gated without breaking PDFs"
  );
  assert(
    /"authz-test\.js"/.test(read("scripts/run-all-tests.js")),
    "the adversarial authorization suite runs as part of the battery"
  );

  // ---- 8. no committed secrets ----
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.startsWith("node_modules/"))
    .filter((f) => !/\.(png|jpg|jpeg|ico|webp|pdf|zip|woff2?)$/i.test(f));
  const SECRET_PATTERNS = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
    [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
    [/\bghp_[A-Za-z0-9]{30,}\b/, "GitHub personal access token"],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
    [/\bsk-[A-Za-z0-9]{32,}\b/, "OpenAI-style secret key"],
    [/\bsk_live_[A-Za-z0-9]{16,}\b/, "Stripe live key"],
  ];
  const leaks = [];
  for (const f of tracked) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(text)) leaks.push(`${f}: ${label}`);
    }
  }
  assert(leaks.length === 0, `no committed secret material in ${tracked.length} tracked files` +
    (leaks.length ? ` — found: ${leaks.join(", ")}` : ""));
  assert(/^\.env$/m.test(read(".gitignore")), ".gitignore excludes .env so provider keys cannot be committed");

  // .env.example must document variable NAMES without real values.
  const envExample = read(".env.example");
  const assigned = [...envExample.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)]
    .filter(([, , v]) => v.trim() !== "" && !/^(<|\$\{|change|your|example|placeholder|mock|demo|true|false|\d+$)/i.test(v.trim()));
  assert(
    assigned.length === 0,
    ".env.example documents variable names without real values" +
      (assigned.length ? ` — populated: ${assigned.map(([, k]) => k).join(", ")}` : "")
  );

  console.log(`\nTOOLCHAIN TESTS PASSED — ${n} checkpoints.`);
})();
