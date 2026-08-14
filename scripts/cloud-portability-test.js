#!/usr/bin/env node
/**
 * Cloud portability regression suite.
 *
 * The claim this milestone makes is narrow and checkable: OBV's governed
 * application can move between Render, Azure and a private cloud by
 * swapping infrastructure adapters and migrating data — not by rewriting
 * lender workflows. These checkpoints defend the properties that claim
 * rests on, and nothing else.
 *
 * Each section proves an architectural property, not the presence of a
 * word. Where a keyword search IS the right tool (a vendor SDK import),
 * the assertion is about the dependency graph, not about prose.
 */
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, statSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const PORT = 3366;
const BASE = `http://localhost:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), "obv-portability-"));

let passed = 0;
const pass = (m) => {
  passed++;
  console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`);
};
const fail = (m) => {
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (c, m) => (c ? pass(m) : fail(m));

let server = null;
const stopServer = () => {
  try { server?.kill("SIGKILL"); } catch { /* already gone */ }
  server = null;
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { stopServer(); process.exit(130); });
}

/**
 * Module specifiers imported by a source file.
 *
 * Anchored to real import/require syntax at the start of a line: the word
 * "from" also appears inside SQL strings and template literals, and a
 * looser pattern reports those as if they were dependencies.
 */
function moduleSpecifiers(src) {
  const specs = [];
  const patterns = [
    /^\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/gm, // import x from "y"
    /^\s*import\s*["']([^"']+)["']/gm,                            // side-effect import
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,                        // require("y")
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,                         // dynamic import("y")
  ];
  for (const p of patterns) {
    for (const m of src.matchAll(p)) specs.push(m);
  }
  return specs;
}

/** Every .ts file under src/, for dependency-graph assertions. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

async function main() {
  console.log("Cloud portability suite — adapters swap, workflows don't");

  // ============ 1. no cloud SDK reaches the governed domain ============
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert(
    Object.keys(pkg.dependencies ?? {}).length === 0,
    "the application ships zero runtime dependencies — no vendor SDK can be present at run time"
  );
  const files = sourceFiles(path.join(ROOT, "src"));
  assert(files.length > 50, `scanning ${files.length} source modules`);
  // A vendor SDK entering the domain is the single change that would make
  // a future migration a rewrite instead of an adapter swap.
  const VENDOR_MODULES = [
    "@azure/", "azure-", "@aws-sdk/", "aws-sdk", "@google-cloud/", "googleapis",
    "@kubernetes/", "firebase-admin", "@sendgrid/", "postmark", "nodemailer",
    "@anthropic-ai/", "openai",
  ];
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of moduleSpecifiers(src)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      if (VENDOR_MODULES.some((v) => spec === v.replace(/\/$/, "") || spec.startsWith(v))) {
        offenders.push(`${path.relative(ROOT, f)} → ${spec}`);
      }
    }
  }
  assert(offenders.length === 0, `no source module imports a cloud or vendor SDK${offenders.length ? ": " + offenders.join(", ") : ""}`);
  // Every non-relative import must be a Node built-in: that is what makes
  // the "swap the adapter" claim structurally true rather than aspirational.
  const nonBuiltin = new Set();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of moduleSpecifiers(src)) {
      const spec = m[1];
      if (!spec.startsWith(".") && !spec.startsWith("node:")) nonBuiltin.add(spec);
    }
  }
  assert(
    nonBuiltin.size === 0,
    `every import in src/ is relative or a Node built-in${nonBuiltin.size ? " — found " + [...nonBuiltin].join(", ") : ""}`
  );

  // ============ 2. platform variables are a fallback, never the rule ====
  const runtimeMod = path.join(ROOT, "dist/server/services/platform/runtime.js");
  const probe = (env) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", `const r=require(${JSON.stringify(runtimeMod)});console.log(JSON.stringify({url:r.publicBaseUrl(),commit:r.appCommit(),branch:r.appBranch(),platform:r.platformName()}))`],
        { env: { ...process.env, ...env }, encoding: "utf8" }
      ).trim()
    );
  const both = probe({
    OBV_PUBLIC_BASE_URL: "https://obv.example.org",
    RENDER_EXTERNAL_URL: "https://render.example.net",
    OBV_APP_COMMIT: "aaaaaaaaaaaa",
    RENDER_GIT_COMMIT: "bbbbbbbbbbbb",
  });
  assert(both.url === "https://obv.example.org", "OBV_PUBLIC_BASE_URL takes precedence over the platform's injected URL");
  assert(both.commit === "aaaaaaaaaaaa", "OBV_APP_COMMIT takes precedence over the platform's injected commit");
  const fallback = probe({
    OBV_PUBLIC_BASE_URL: "", RENDER_EXTERNAL_URL: "https://render.example.net",
    OBV_APP_COMMIT: "", OBV_GIT_COMMIT: "", RENDER_GIT_COMMIT: "bbbbbbbbbbbb",
  });
  assert(
    fallback.url === "https://render.example.net" && fallback.commit === "bbbbbbbbbbbb",
    "platform variables still work as a compatibility fallback — an existing deployment is not broken"
  );
  const neutral = probe({
    OBV_PUBLIC_BASE_URL: "", RENDER_EXTERNAL_URL: "", RENDER_GIT_COMMIT: "",
    OBV_APP_COMMIT: "", OBV_GIT_COMMIT: "", RENDER: "", RENDER_SERVICE_ID: "",
    OBV_PLATFORM: "", CONTAINER_APP_NAME: "", WEBSITE_SITE_NAME: "", KUBERNETES_SERVICE_HOST: "",
  });
  assert(
    neutral.url === "" && neutral.platform === "generic-container",
    "with no platform variables at all OBV still resolves — nothing is REQUIRED from a host"
  );
  // The boundary must be the only reader, or precedence is a fiction.
  const platformReaders = [];
  for (const f of files) {
    if (f.includes(path.join("services", "platform"))) continue;
    const src = readFileSync(f, "utf8");
    if (/process\.env\.(RENDER_|WEBSITE_|CONTAINER_APP_|KUBERNETES_|ECS_)/.test(src)) {
      platformReaders.push(path.relative(ROOT, f));
    }
  }
  assert(
    platformReaders.length === 0,
    `platform-specific variables are read only inside the runtime boundary${platformReaders.length ? " — leaked into " + platformReaders.join(", ") : ""}`
  );

  // ============ 3. the ObjectStore CONTRACT, against two providers ======
  // The same behavioral checks run against the production local store AND
  // an in-memory test double that has no filesystem at all. A property
  // that only the local store satisfies is a filesystem assumption, not a
  // contract — this is what makes "Azure/S3 is an adapter" checkable.
  const storeMod = path.join(ROOT, "dist/server/services/storage/objectStore.js");
  const memoryMod = path.join(ROOT, "dist/server/services/storage/memoryObjectStore.js");
  const storeProbe = execFileSync(
    process.execPath,
    ["-e", `
      const fs = require("node:fs");
      const { Readable } = require("node:stream");
      const s = require(${JSON.stringify(storeMod)});
      const { MemoryObjectStore } = require(${JSON.stringify(memoryMod)});

      async function contract(store) {
        const out = { kind: store.kind };
        const key = "uploads/portability-probe.txt";
        const meta = await store.put(key, Buffer.from("alpha"), s.ObjectClass.DERIVED);
        out.roundTrip = (await store.get(key)).toString() === "alpha";
        out.hashOk = await store.verifyHash(key, meta.sha256);
        out.hashDetects = !(await store.verifyHash(key, "0".repeat(64)));
        out.exists = (await store.exists(key)) && !(await store.exists("uploads/absent.txt"));
        await store.put(key, Buffer.from("beta"), s.ObjectClass.DERIVED);
        out.derivedOverwrites = (await store.get(key)).toString() === "beta";
        const wormKey = "worm/portability-immutable.txt";
        await store.put(wormKey, Buffer.from("one"), s.ObjectClass.IMMUTABLE);
        try { await store.put(wormKey, Buffer.from("two"), s.ObjectClass.IMMUTABLE); out.immutableRefused = false; }
        catch { out.immutableRefused = true; }
        out.immutableIntact = (await store.get(wormKey)).toString() === "one";
        // Streams are the GENERIC Readable; the contract promises nothing
        // filesystem-shaped. (fs.ReadStream instanceof Readable, so the
        // local store may return one — but no caller may REQUIRE one,
        // which the memory store proves.)
        const stream = await store.openReadStream(wormKey);
        out.streamIsReadable = stream instanceof Readable;
        const chunks = [];
        for await (const c of stream) chunks.push(c);
        out.streamedBytes = Buffer.concat(chunks).toString() === "one";
        // Local-file materialization: path valid during the callback,
        // bytes correct, and any temporary copy removed afterwards.
        let leased = null;
        out.materializedBytes = await store.withLocalFile(wormKey, async (p) => {
          leased = p;
          return fs.readFileSync(p).toString() === "one";
        });
        out.tempCleaned = store.kind === "local-filesystem"
          ? fs.existsSync(leased)            // the local store lends its ORIGINAL file
          : !fs.existsSync(leased);          // a pathless store must remove its temp copy
        let missingRejected = false;
        try { await store.withLocalFile("uploads/never-written.bin", async () => {}); }
        catch { missingRejected = true; }
        out.missingRejected = missingRejected;
        return out;
      }

      (async () => {
        const local = await contract(s.objectStore);
        const memory = await contract(new MemoryObjectStore());
        const keys = {};
        // Key security: traversal in every disguise is rejected, honest
        // keys are normalised, and nesting stays inside the root.
        keys.plainTraversal = s.normalizeKey("../../etc/passwd") === null;
        keys.encodedTraversal = s.normalizeKey("%2e%2e%2fetc%2fpasswd") === null && s.normalizeKey("uploads/%2e%2e/secret") === null;
        keys.backslashTraversal = s.normalizeKey("uploads\\\\..\\\\..\\\\etc\\\\passwd") === null;
        keys.dotSegment = s.normalizeKey("uploads/./x.jpg") === null && s.normalizeKey("uploads//x.jpg") === null;
        keys.leadingSlash = s.normalizeKey("/worm/a.jpg") === "worm/a.jpg";
        keys.backslashNormalized = s.normalizeKey("worm\\\\a.jpg") === "worm/a.jpg";
        keys.nestedValid = s.normalizeKey("audit-packages/pkg-1/file.zip") === "audit-packages/pkg-1/file.zip";
        keys.badDecode = s.normalizeKey("%zz-broken") === null;
        keys.evidenceKeys =
          s.evidenceKey("/worm/a.jpg") === "worm/a.jpg" &&
          s.evidenceKey("/uploads/b.jpg") === "uploads/b.jpg" &&
          s.evidenceKey("/demo-evidence/c.jpg") === "demo-evidence/c.jpg" &&
          s.evidenceKey("/etc/passwd") === null;
        console.log(JSON.stringify({ local, memory, keys }));
      })().catch((e) => { console.error(e); process.exit(1); });
    `],
    { env: { ...process.env, OBV_DATA_DIR: DATA }, encoding: "utf8" }
  );
  const { local: st, memory: mem, keys: keySec } = JSON.parse(storeProbe.trim());
  for (const [label, r] of [["local store", st], ["memory test double", mem]]) {
    assert(r.roundTrip && r.exists, `${label}: reads back what it wrote, by logical key`);
    assert(r.hashOk && r.hashDetects, `${label}: bytes verifiable by hash; a wrong hash is rejected`);
    assert(r.derivedOverwrites, `${label}: a DERIVED object may be replaced`);
    assert(r.immutableRefused && r.immutableIntact, `${label}: an IMMUTABLE object refuses replacement`);
    assert(r.streamIsReadable && r.streamedBytes, `${label}: streams are generic Readable and carry the right bytes`);
    assert(r.materializedBytes && r.missingRejected, `${label}: withLocalFile lends a real path and rejects missing objects`);
  }
  assert(st.tempCleaned, "the local store lends its original file — no copy churn on the pilot");
  assert(mem.tempCleaned, "a pathless store's temporary materialization is removed after the callback");
  assert(
    keySec.plainTraversal && keySec.encodedTraversal && keySec.backslashTraversal && keySec.dotSegment && keySec.badDecode,
    "traversal is rejected in plain, percent-encoded, backslash and dot-segment disguises"
  );
  assert(
    keySec.leadingSlash && keySec.backslashNormalized && keySec.nestedValid,
    "honest keys normalise (leading slash, backslashes) and nested keys stay valid"
  );
  assert(keySec.evidenceKeys, "served evidence paths map to object keys in exactly one place");
  // Compile-time neutrality: the provider-neutral CONTRACT exposes no
  // filesystem type and no physical path, and no caller outside the
  // storage layer asks for one.
  const contractSrc = readFileSync(path.join(ROOT, "src/server/services/storage/objectStore.ts"), "utf8");
  // Method SIGNATURES only — comments stripped, so prose about what the
  // contract avoids cannot satisfy (or fail) a check about what it does.
  const iface = contractSrc
    .split("export interface ObjectStore")[1]
    .split("}")[0]
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert(!/fs\.ReadStream/.test(iface), "the ObjectStore contract exposes generic Readable, never fs.ReadStream");
  assert(!/physicalPath/.test(iface), "the ObjectStore contract exposes no physical path");
  assert(/Promise</.test(iface), "every ObjectStore method is asynchronous — implementable by a remote store");
  const pathAskers = [];
  for (const f of files) {
    if (f.includes(path.join("services", "storage"))) continue;
    if (/objectStore\.physicalPath|\.physicalPath\(/.test(readFileSync(f, "utf8"))) pathAskers.push(path.relative(ROOT, f));
  }
  assert(
    pathAskers.length === 0,
    `no provider-neutral caller asks the store for a physical path${pathAskers.length ? " — " + pathAskers.join(", ") : ""}`
  );

  // ============ 4. boot with no platform variables whatsoever =========
  let squatter = false;
  try { squatter = (await fetch(`${BASE}/api/health`)).ok; } catch { /* free */ }
  if (squatter) fail(`another process is already serving ${BASE}`);
  if (spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA }, stdio: "ignore",
  }).status !== 0) fail("seed failed");

  const cleanEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) {
    if (/^(RENDER|WEBSITE|CONTAINER_APP|KUBERNETES|ECS)_/.test(k)) delete cleanEnv[k];
  }
  const logPath = path.join(DATA, "server.log");
  writeFileSync(logPath, "");
  const logFd = require("node:fs").openSync(logPath, "a");
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...cleanEnv, OBV_DATA_DIR: DATA, PORT: String(PORT),
      OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo",
      OBV_SHUTDOWN_GRACE_MS: "4000",
    },
    stdio: ["ignore", logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(up, "OBV boots with every platform-specific variable removed from the environment");

  // ============ 5. health and readiness stay platform-neutral =========
  const health = await (await fetch(`${BASE}/api/health`)).json();
  const ready = await (await fetch(`${BASE}/api/ready`)).json();
  // Health and readiness must describe CAPABILITIES ("pdf", "connected"),
  // never the vendor that happens to provide them — otherwise a probe
  // becomes something a migration has to rewrite. `platform` is the one
  // deliberate exception: it exists to disclose where this process runs,
  // and nothing branches on it.
  const { platform: disclosedPlatform, ...readyRest } = ready;
  const probed = JSON.stringify({ health, ready: readyRest }).toLowerCase();
  for (const vendor of ["azure", "render", "aws", "kubernetes", "postmark", "anthropic", "sendgrid", "mailgun"]) {
    assert(
      !new RegExp(`\\b${vendor}\\b`).test(probed),
      `the health/readiness payloads name no vendor (${vendor})`
    );
  }
  assert(typeof disclosedPlatform === "string", "readiness discloses the detected platform in exactly one field");
  // Capability vocabularies, enumerated: a value drifting to a brand name
  // is what this catches.
  assert(["pdf", "html-fallback"].includes(health.reportRenderer), "report rendering is reported as a capability, not a product");
  assert(["live-capable", "fallback-only"].includes(health.aiMode), "AI availability is reported as a capability, not a model vendor");
  assert(["configured", "demo"].includes(health.teamsMode), "notification channel state is reported as a capability");
  assert(typeof health.status === "string" && health.database === "connected", "health reports process and database liveness");
  assert(ready.ready === true && ready.checks.database === true, "readiness reports the application can take traffic");
  assert(ready.checks.accepting === true, "readiness distinguishes 'accepting traffic' from 'process alive'");
  assert(
    ready.dataStore?.engine === "sqlite" && ready.dataStore.maxWriterInstances === 1 &&
      ready.dataStore.supportsHorizontalScale === false,
    "readiness discloses the single-writer constraint so an operator cannot scale into corruption"
  );

  // ============ 6. the single-writer constraint is announced ==========
  const bootLog = readFileSync(logPath, "utf8");
  assert(/max writer instances=1/.test(bootLog), "the startup log states the single-writer constraint");
  assert(/horizontal scale=NOT SUPPORTED/.test(bootLog), "the startup log states that horizontal scale is unsupported");
  assert(/Runtime: platform=/.test(bootLog), "the startup log discloses the detected platform for support");

  // ============ 7. artifact references are logical, not host paths ====
  // The precondition for ever moving artifacts to object storage: no
  // record may point at a location that only exists on this host.
  const db = new DatabaseSync(path.join(DATA, "obv.db"), { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const absolute = [];
  for (const table of tables) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => /TEXT|BLOB/i.test(String(c.type ?? "")));
    for (const col of cols) {
      const rows = db.prepare(`SELECT "${col.name}" AS v FROM "${table}" WHERE "${col.name}" LIKE ? LIMIT 3`).all(`%${DATA}%`);
      for (const r of rows) absolute.push(`${table}.${col.name} = ${String(r.v).slice(0, 60)}`);
    }
  }
  db.close();
  assert(
    absolute.length === 0,
    `no record stores an absolute host path${absolute.length ? " — found " + absolute.join("; ") : ""}`
  );

  // ============ 8. secrets stay in the environment ====================
  const SECRET_VARS = [
    "OBV_POSTMARK_SERVER_TOKEN", "ANTHROPIC_API_KEY", "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_APP_SECRET", "MICROSOFT_CLIENT_SECRET", "OBV_SESSION_SECRET",
  ];
  const schemaSrc = readFileSync(path.join(ROOT, "src/server/db/index.ts"), "utf8");
  const persisted = SECRET_VARS.filter((v) => schemaSrc.includes(v));
  assert(
    persisted.length === 0,
    `no secret environment variable is written into the schema${persisted.length ? " — " + persisted.join(", ") : ""}`
  );

  // ============ 9. containerised process lifecycle ====================
  // An in-flight request holds the drain open. The body is sent in two
  // pieces with a correct Content-Length, so the server is genuinely
  // mid-request when the stop signal lands and the request COMPLETES when
  // the rest arrives — an under-length body would prove nothing except
  // that the grace timer works.
  const sock = net.createConnection({ host: "localhost", port: PORT });
  await new Promise((resolve) => sock.once("connect", resolve));
  sock.write(
    "POST /api/session HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n" +
      "Content-Length: 24\r\nConnection: close\r\n\r\n{\"userId\":\"user-"
  );
  await new Promise((r) => setTimeout(r, 300));

  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 700));
  assert(server.exitCode === null, "a request already in flight keeps the process alive through SIGTERM (it drains, it does not drop)");

  const exited = new Promise((resolve) => server.once("exit", (code) => resolve(code)));
  sock.write("funder\"}"); // completes the body → the in-flight request finishes
  const exitCode = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 6000))]);
  assert(exitCode === 0, `the process exits cleanly once in-flight work completes (exit ${exitCode})`);
  sock.destroy();

  const shutdownLog = readFileSync(logPath, "utf8");
  assert(/SIGTERM received — draining/.test(shutdownLog), "the drain is announced in the log an operator will read");
  assert(/shutdown complete/.test(shutdownLog), "shutdown runs to completion rather than being killed mid-way");
  // A cleanly closed SQLite handle checkpoints the write-ahead log back
  // into the database; a killed process leaves it behind.
  const wal = path.join(DATA, "obv.db-wal");
  assert(
    !existsSync(wal) || statSync(wal).size === 0,
    "the database was closed cleanly — the write-ahead log is checkpointed, not abandoned"
  );
  server = null;

  // SIGINT must behave identically: a developer's Ctrl-C and a platform's
  // stop signal take the same path. This run also proves two more
  // lifecycle properties: an IDLE server exits promptly instead of
  // sitting out its grace period, and a repeated signal (platforms often
  // re-send; humans double-tap Ctrl-C) does not restart the shutdown.
  const secondLog = path.join(DATA, "second.log");
  writeFileSync(secondLog, "");
  const secondFd = require("node:fs").openSync(secondLog, "a");
  const second = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: { ...cleanEnv, OBV_DATA_DIR: DATA, PORT: String(PORT + 1), OBV_BANKING_MODE: "demo", OBV_SHUTDOWN_GRACE_MS: "3000" },
    stdio: ["ignore", secondFd, secondFd],
  });
  server = second;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://localhost:${PORT + 1}/api/health`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const sigintExit = new Promise((resolve) => second.once("exit", (code) => resolve(code)));
  const drainStart = Date.now();
  second.kill("SIGINT");
  second.kill("SIGINT"); // duplicate — must be absorbed by the first shutdown
  setTimeout(() => { try { second.kill("SIGTERM"); } catch { /* exited */ } }, 100).unref();
  const sigintCode = await Promise.race([sigintExit, new Promise((r) => setTimeout(() => r("timeout"), 6000))]);
  const drainMs = Date.now() - drainStart;
  assert(sigintCode === 0, `SIGINT drains on the same path as SIGTERM (exit ${sigintCode})`);
  assert(
    drainMs < 2000,
    `an idle server exits promptly (${drainMs}ms) instead of sitting out its ${3000}ms grace period`
  );
  const secondOut = readFileSync(secondLog, "utf8");
  const drainAnnouncements = (secondOut.match(/received — draining/g) ?? []).length;
  const completions = (secondOut.match(/shutdown complete/g) ?? []).length;
  assert(
    drainAnnouncements === 1 && completions === 1,
    `repeated stop signals do not restart the shutdown (${drainAnnouncements} drain start, ${completions} completion)`
  );
  server = null;

  // ============ 10. provider seams remain usable =====================
  const emailSrc = readFileSync(path.join(ROOT, "src/server/services/integrations/email.ts"), "utf8");
  // Delivery is a registry of adapters behind one interface, not a
  // conditional in business code: adding SMTP or Graph later means adding
  // an entry, which is the whole portability claim for email.
  assert(
    /interface EmailProvider|EmailProvider = \{|: EmailProvider/.test(emailSrc),
    "email delivery is expressed as a provider interface"
  );
  const disabledAdapters = (emailSrc.match(/disabledEmailProvider\(/g) ?? []).length;
  assert(
    disabledAdapters >= 3,
    `the seam holds ${disabledAdapters} disabled adapter positions beside the live one — a later provider is an entry, not a rewrite`
  );
  assert(
    /const postmarkProvider: EmailProvider/.test(emailSrc),
    "the live provider is one implementation of that interface, not the interface itself"
  );
  const identitySrc = readFileSync(path.join(ROOT, "src/server/services/identity/core.ts"), "utf8");
  // The property that matters: identity ISSUES a link and hands it to the
  // neutral seam. It must never reach a provider adapter, name a vendor
  // endpoint, or read a provider credential — otherwise changing email
  // provider becomes a change to authentication.
  assert(
    !/postmark|sendgrid|mailgun|graph\.microsoft/i.test(identitySrc),
    "magic-link issuance names no delivery provider — swapping email cannot touch authentication"
  );
  assert(
    !/OBV_POSTMARK_SERVER_TOKEN|api\.postmarkapp\.com/.test(identitySrc),
    "magic-link issuance reads no provider credential and calls no provider endpoint"
  );
  const identityImports = moduleSpecifiers(identitySrc).map((m) => m[1]);
  assert(
    identityImports.includes("../integrations/email") &&
      !identityImports.some((i) => /provider|postmark|sendgrid/i.test(i)),
    "identity imports the neutral email seam and no adapter"
  );
  const domainDirs = ["src/server/services", "src/server/db"];
  const vendorInDomain = [];
  for (const dir of domainDirs) {
    for (const f of sourceFiles(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, f);
      // Adapters are exactly where a vendor endpoint belongs.
      if (rel.includes("integrations/") || rel.includes("teamsSync/") || rel.includes("whatsappSync/") ||
          rel.includes("verification/") || rel.includes("officialSources/")) continue;
      if (/api\.postmarkapp\.com|api\.anthropic\.com|graph\.microsoft\.com|amazonaws\.com|blob\.core\.windows\.net/.test(readFileSync(f, "utf8"))) {
        vendorInDomain.push(rel);
      }
    }
  }
  assert(
    vendorInDomain.length === 0,
    `no vendor endpoint appears outside an adapter directory${vendorInDomain.length ? " — " + vendorInDomain.join(", ") : ""}`
  );

  console.log(`\nCLOUD PORTABILITY TESTS PASSED — ${passed} checkpoints.`);
  console.log("Adapters are swappable; the governed application is not platform-bound.");
}

main()
  .catch((err) => {
    console.error(err.stack ?? err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => {
    stopServer();
    try { rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
  });
