#!/usr/bin/env node
/**
 * External-pilot production boundaries — regression suite.
 *
 * Proves every NEW production boundary from the pilot-readiness
 * milestone: the environment posture walls (startup refusals + runtime
 * 404s), the no-silent-fallback email rules, the live Postmark adapter
 * (against a local capture server — no real network), credential
 * redaction at rest, duplicate-send suppression, deterministic
 * tenant-scoped recipient routing with explanations, preference
 * behavior, backup creation/verification/tamper-detection, database
 * schema-version refusal, and the pilot:check verdict.
 */
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "dist", "server", "http", "server.js");

// This suite declares every posture explicitly. The unified runner
// injects OBV_BANKING_MODE=demo (a safety default for OTHER suites) into
// the ambient environment; inherited into a declared-pilot child it
// would fire the contradiction refusal instead of the wall under test.
delete process.env.OBV_BANKING_MODE;
delete process.env.OBV_BANKING_PRODUCTION_ENABLE;
delete process.env.OBV_ENVIRONMENT;
const SEED = path.join(ROOT, "dist", "server", "db", "seed.js");
const PORT = 3345;
const BASE = `http://localhost:${PORT}`;
const CAPTURE_PORT = 3346;
const DIR_MAIN = fs.mkdtempSync(path.join(os.tmpdir(), "obv-pp-main-"));
const DIR_PILOT = fs.mkdtempSync(path.join(os.tmpdir(), "obv-pp-pilot-"));
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

let passed = 0;
const pass = (m) => {
  passed++;
  console.log(`  ✓ [${String(passed).padStart(2, "0")}] ${m}`);
};
const fail = (m) => {
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (c, m) => (c ? pass(m) : fail(m));

/** Spawn the server with env and expect a REFUSAL containing `needle`. */
function refuses(env, needle, label) {
  const r = spawnSync(process.execPath, [SERVER], {
    env: { ...process.env, PORT: "3999", ...env },
    timeout: 20000,
    encoding: "utf8",
  });
  const out = (r.stderr ?? "") + (r.stdout ?? "");
  assert(r.status !== 0 && new RegExp(needle).test(out), label);
}

async function waitUp(base) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(`server ${base} did not become healthy`);
}

async function main() {
  console.log("External-pilot production boundaries — startup walls, live walls, email, routing, backups");

  // ============ 1. startup refusal walls ============
  const pilotBase = {
    OBV_ENVIRONMENT: "pilot", OBV_DATA_DIR: DIR_PILOT, OBV_SESSION_SECRET: SECRET,
    OBV_AUTH_LINK_DELIVERY: "file",
  };
  refuses({ OBV_ENVIRONMENT: "staging" }, "OBV_ENVIRONMENT must be", "an unknown OBV_ENVIRONMENT value refuses startup");
  refuses(
    { OBV_ENVIRONMENT: "demo", OBV_BANKING_MODE: "production" },
    "contradicts a production flag",
    "OBV_ENVIRONMENT=demo with a production banking flag is a refused contradiction"
  );
  refuses(
    { ...pilotBase, OBV_BANKING_MODE: "demo" },
    "contradicts OBV_BANKING_MODE=demo",
    "OBV_ENVIRONMENT=pilot with demo banking mode is a refused contradiction"
  );
  refuses({ ...pilotBase, OBV_DEMO_AUTH: "1" }, "OBV_DEMO_AUTH", "the demo role switcher cannot be enabled in a declared pilot");
  refuses({ ...pilotBase, OBV_SEED_GOLDEN: "1" }, "OBV_SEED_GOLDEN", "the golden demo seed cannot be enabled in a declared pilot");
  {
    const env = { ...pilotBase };
    delete env.OBV_DATA_DIR;
    const r = spawnSync(process.execPath, [SERVER], {
      env: { ...process.env, PORT: "3999", ...env, OBV_DATA_DIR: "" },
      timeout: 20000,
      encoding: "utf8",
    });
    const out = (r.stderr ?? "") + (r.stdout ?? "");
    assert(r.status !== 0 && /OBV_DATA_DIR must be set/.test(out), "a pilot without an explicit persistent data root refuses startup");
  }
  refuses(
    { ...pilotBase, OBV_AUTH_LINK_DELIVERY: "email", OBV_EMAIL_PROVIDER: "outbox" },
    "requires a real email provider",
    "OBV_AUTH_LINK_DELIVERY=email with the development outbox refuses startup (no silent fallback)"
  );
  refuses(
    {
      ...pilotBase, OBV_AUTH_LINK_DELIVERY: "email", OBV_EMAIL_PROVIDER: "postmark",
      OBV_INTEGRATIONS_PRODUCTION_ENABLE: "true", OBV_POSTMARK_SERVER_TOKEN: "", OBV_EMAIL_FROM: "",
    },
    "OBV_POSTMARK_SERVER_TOKEN",
    "postmark without credentials refuses startup (validated at boot, not first send)"
  );
  {
    const r = spawnSync(process.execPath, [SEED], {
      env: { ...process.env, OBV_ENVIRONMENT: "pilot", OBV_DATA_DIR: DIR_PILOT },
      timeout: 30000,
      encoding: "utf8",
    });
    const out = (r.stderr ?? "") + (r.stdout ?? "");
    assert(r.status !== 0 && /Demo seeding is disabled/.test(out), "the demo seed CLI refuses to run against a pilot environment");
  }

  // ============ 2. schema-version refusal ============
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obv-pp-schema-"));
    spawnSync(process.execPath, [SEED], { env: { ...process.env, OBV_DATA_DIR: dir }, stdio: "ignore" });
    const db = new DatabaseSync(path.join(dir, "obv.db"));
    db.exec("PRAGMA user_version = 99");
    db.close();
    const r = spawnSync(process.execPath, [SERVER], {
      env: { ...process.env, OBV_DATA_DIR: dir, PORT: "3999" },
      timeout: 20000,
      encoding: "utf8",
    });
    const out = (r.stderr ?? "") + (r.stdout ?? "");
    assert(r.status !== 0 && /NEWER build/.test(out), "an older build refuses a newer database (schema version wall)");
  }

  // ============ 3. live pilot server: runtime walls ============
  const pilotServer = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, ...pilotBase, PORT: String(PORT),
      OBV_BOOTSTRAP_ADMIN_EMAIL: "operator@lender-pilot.example",
      OBV_BOOTSTRAP_ORG_NAME: "First Lender Capital",
    },
    stdio: "ignore",
  });
  try {
    await waitUp(BASE);
    const demoPage = await fetch(BASE + "/demo", { redirect: "manual" });
    const demoSession = await fetch(BASE + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-funder" }),
      redirect: "manual",
    });
    assert(demoPage.status === 404 && demoSession.status === 404, "pilot posture: /demo and POST /api/session are 404");
    const reset = await fetch(BASE + "/api/demo/reset", { method: "POST" });
    const fullReset = await fetch(BASE + "/api/dev/full-reset", { method: "POST" });
    assert(reset.status === 404 && fullReset.status === 404, "pilot posture: demo reset and full reset are 404");

    const health = await fetch(BASE + "/api/health");
    const ready = await fetch(BASE + "/api/ready");
    const readyBody = await ready.json();
    assert(health.ok && typeof readyBody.ready === "boolean" && readyBody.checks, "liveness (/api/health) and readiness (/api/ready) are distinct endpoints");
    assert(
      /^[A-Za-z0-9._-]{8,}$/.test(health.headers.get("x-request-id") ?? ""),
      "every response carries an X-Request-Id correlation header"
    );
    const echoed = await fetch(BASE + "/api/health", { headers: { "x-request-id": "test-rid-12345" } });
    assert(echoed.headers.get("x-request-id") === "test-rid-12345", "a sane inbound request id is honored end-to-end");

    // Bootstrap admin + full production magic-link sign-in.
    const link = await fetch(BASE + "/api/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "operator@lender-pilot.example" }),
    });
    assert(link.ok, "the bootstrap administrator can request a sign-in link");
    const outbox = fs.readFileSync(path.join(DIR_PILOT, "auth-outbox.jsonl"), "utf8").trim().split("\n");
    const lastLink = JSON.parse(outbox[outbox.length - 1]).link;
    assert(/\/auth\/complete\?token=[0-9a-f]{64}$/.test(lastLink), "the link landed in the explicitly chosen file outbox");
    const confirmPage = await fetch(lastLink, { redirect: "manual" });
    const confirmCookie = (confirmPage.headers.getSetCookie() ?? []).find((c) => c.startsWith("obv_confirm="));
    assert(confirmPage.status === 200 && confirmCookie, "the confirmation page arms the anti-login-CSRF cookie without consuming the token");
    const token = /token=([0-9a-f]{64})/.exec(lastLink)[1];
    const complete = await fetch(BASE + "/api/auth/complete", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: confirmCookie.split(";")[0] },
      body: JSON.stringify({ token, confirm: confirmCookie.split(";")[0].split("=")[1] }),
      redirect: "manual",
    });
    const authCookie = (complete.headers.getSetCookie() ?? []).find((c) => c.startsWith("obv_auth="));
    assert(authCookie, "magic-link completion mints a production session");
    const jar = authCookie.split(";")[0];
    const overview = await fetch(BASE + "/overview", { headers: { cookie: jar, accept: "text/html" } });
    assert(overview.status === 200, "the production session reaches the application");

    // Banking simulation unavailable even to the signed-in administrator.
    const credit = await fetch(BASE + "/api/banking/accounts/anything/credit", {
      method: "POST",
      headers: { cookie: jar, "content-type": "application/json" },
      body: JSON.stringify({ amount: 100 }),
    });
    assert([403, 404].includes(credit.status), "banking demo credit is unavailable in pilot posture (no simulation surface)");

    // Restart preserves state (same data dir): kill, restart, session…
    // sessions are server-side rows, so the SAME cookie must survive.
    pilotServer.kill();
    await new Promise((r) => setTimeout(r, 500));
    const pilotServer2 = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env, ...pilotBase, PORT: String(PORT),
        OBV_BOOTSTRAP_ADMIN_EMAIL: "operator@lender-pilot.example",
      },
      stdio: "ignore",
    });
    try {
      await waitUp(BASE);
      const afterRestart = await fetch(BASE + "/overview", { headers: { cookie: jar, accept: "text/html" } });
      assert(afterRestart.status === 200, "a restart preserves identities AND live sessions (durable state, configured secret)");
    } finally {
      pilotServer2.kill();
    }
  } finally {
    try { pilotServer.kill(); } catch {}
  }

  // ============ 4. in-process: email adapter, routing, backups ============
  process.env.OBV_DATA_DIR = DIR_MAIN;
  delete process.env.OBV_ENVIRONMENT;
  spawnSync(process.execPath, [SEED], { env: { ...process.env, OBV_DATA_DIR: DIR_MAIN }, stdio: "ignore" });

  // Local Postmark capture server — the ONLY network the adapter sees.
  const captured = [];
  let respondWith = 200;
  const capture = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({ headers: req.headers, body: body ? JSON.parse(body) : null });
      res.writeHead(respondWith, { "content-type": "application/json" });
      res.end(respondWith === 200 ? JSON.stringify({ MessageID: "x" }) : JSON.stringify({ ErrorCode: 300, Message: "Invalid email request" }));
    });
  });
  await new Promise((r) => capture.listen(CAPTURE_PORT, r));

  process.env.OBV_EMAIL_PROVIDER = "postmark";
  process.env.OBV_INTEGRATIONS_PRODUCTION_ENABLE = "true";
  process.env.OBV_POSTMARK_SERVER_TOKEN = "test-token-never-logged";
  process.env.OBV_EMAIL_FROM = "obv@pilot-test.example";
  process.env.OBV_POSTMARK_API_BASE_URL = `http://localhost:${CAPTURE_PORT}`;

  const email = require(path.join(ROOT, "dist", "server", "services", "integrations", "email.js"));
  const irepo = require(path.join(ROOT, "dist", "server", "db", "integrationsRepo.js"));
  const repo = require(path.join(ROOT, "dist", "server", "db", "repo.js"));

  const sent = email.sendEmail({
    kind: "MAGIC_LINK", to: "person@lender.example", subject: "Your OBV sign-in link",
    text: "Use this one-time link: http://x/auth/complete?token=deadbeef", containsCredential: true,
  });
  await email.emailDeliveriesSettled();
  const sentRow = irepo.getEmail(sent.id);
  assert(sentRow.status === "SENT" && captured.length === 1, "the Postmark adapter delivers through HTTP and records SENT");
  assert(
    captured[0].headers["x-postmark-server-token"] === "test-token-never-logged" &&
      captured[0].body.TextBody.includes("token=deadbeef"),
    "the RAW credential body reaches the wire provider"
  );
  assert(
    !sentRow.bodyText.includes("deadbeef") && /withheld/.test(sentRow.bodyText),
    "the outbox row stores a REDACTION — the raw link never lands in the database"
  );
  const invite = email.sendEmail({
    kind: "INVITATION", to: "invitee@lender.example", subject: "You are invited",
    text: "Activate: http://x/invite/rawtoken123",
  });
  await email.emailDeliveriesSettled();
  assert(
    !irepo.getEmail(invite.id).bodyText.includes("rawtoken123"),
    "INVITATION bodies are credential-redacted at rest BY KIND (caller cannot forget)"
  );

  respondWith = 422;
  const refused = email.sendEmail({ kind: "DRAW_NOTIFICATION", to: "p@l.example", subject: "s", text: "governed event" });
  await email.emailDeliveriesSettled();
  const refusedRow = irepo.getEmail(refused.id);
  assert(
    refusedRow.status === "FAILED" &&
      !String(refusedRow.error).includes("test-token-never-logged") &&
      /ErrorCode=300/.test(String(refusedRow.error)),
    "provider refusal records a sanitized FAILED outcome (no token, no body) and throws nothing"
  );
  respondWith = 200;

  const before = captured.length;
  const d1 = email.sendEmail({ kind: "DRAW_NOTIFICATION", to: "p@l.example", subject: "s", text: "b", dedupeKey: "evt:draw-1:user-1" });
  await email.emailDeliveriesSettled();
  const d2 = email.sendEmail({ kind: "DRAW_NOTIFICATION", to: "p@l.example", subject: "s", text: "b", dedupeKey: "evt:draw-1:user-1" });
  await email.emailDeliveriesSettled();
  assert(
    d2.id === d1.id && captured.length === before + 1,
    "duplicate-send protection: the same dedupe key delivers exactly once"
  );

  // ---- recipient routing ----
  const recipients = require(path.join(ROOT, "dist", "server", "services", "pilot", "recipients.js"));
  const authz = require(path.join(ROOT, "dist", "server", "services", "authz.js"));
  const resolved = recipients.resolveRecipients("DRAW_SUBMITTED", { projectId: "proj-r47", drawRequestId: "draw-vam" });
  assert(resolved.length > 0, `DRAW_SUBMITTED resolves ${resolved.length} deterministic recipient(s)`);
  assert(
    resolved.every((r) => r.reason && r.reason.length > 4),
    "every recipient carries a deterministic non-secret reason"
  );
  const project = repo.getProject("proj-r47");
  assert(
    resolved.every((r) => authz.canAccessProject(r.user, project)),
    "every recipient passes the canonical tenancy predicate — routing can never cross organizations"
  );
  const again = recipients.resolveRecipients("DRAW_SUBMITTED", { projectId: "proj-r47", drawRequestId: "draw-vam" });
  assert(
    JSON.stringify(again.map((r) => r.user.id)) === JSON.stringify(resolved.map((r) => r.user.id)),
    "recipient resolution is deterministic (same records in, same recipients out)"
  );
  // A foreign-tenant user must never appear even if roles match.
  repo.insertOrganization({ id: "org-pp-foreign", name: "Foreign Org", kind: "FUNDER" });
  repo.insertUser({ id: "user-pp-foreign", organizationId: "org-pp-foreign", name: "Foreign Funder", role: "FUNDER_REP", title: "F" });
  const withForeign = recipients.resolveRecipients("DRAW_SUBMITTED", { projectId: "proj-r47", drawRequestId: "draw-vam" });
  assert(
    !withForeign.some((r) => r.user.id === "user-pp-foreign"),
    "a same-role user in another organization is never selected"
  );

  // ---- preferences + addressed in-app rows ----
  const notify = require(path.join(ROOT, "dist", "server", "services", "pilot", "notify.js"));
  const muted = resolved[0];
  repo.setNotificationChannelEnabled(muted.user.id, "EMAIL", false, new Date().toISOString());
  const outboxBefore = irepo.listEmails({ limit: 500 }).length;
  notify.notifyGovernedEvent("DRAW_SUBMITTED", {
    projectId: "proj-r47", drawRequestId: "draw-vam",
    subject: "PP routing probe", body: "governed event fan-out",
  });
  await email.emailDeliveriesSettled();
  const addressed = repo.listNotificationsForUser(muted.user.id, 10);
  assert(
    addressed.some((n) => n.type === "DRAW_SUBMITTED" && n.recipientReason),
    "a muted-email recipient still receives the MANDATORY addressed in-app record (with its reason)"
  );
  const feed = repo.listBroadcastNotifications(10);
  assert(
    feed.some((n) => n.type === "DRAW_SUBMITTED") && feed.every((n) => !n.recipientUserId),
    "the rendered feed shows broadcast rows only — addressed routing records never leak into it"
  );
  void outboxBefore;

  // ---- backups: verify + tamper detection ----
  const backups = require(path.join(ROOT, "dist", "server", "services", "ops", "backups.js"));
  const rec = backups.createBackup(null);
  assert(rec.status === "COMPLETED", "backup created via VACUUM INTO");
  assert(backups.verifyBackup(rec.id).verificationStatus === "VERIFIED", "verification passes on the intact file");
  const filePath = path.join(DIR_MAIN, "backups", rec.fileName);
  fs.appendFileSync(filePath, Buffer.from("tamper"));
  assert(
    backups.verifyBackup(rec.id).verificationStatus === "MISMATCH",
    "a tampered backup file is detected as MISMATCH (stored sha256 no longer matches)"
  );
  assert(Number.isFinite(backups.hoursSinceLastBackup()), "backup freshness is measurable for readiness checks");

  // ============ 5. pilot:check verdicts ============
  {
    const r = spawnSync(process.execPath, [path.join(__dirname, "pilot-check.js")], {
      env: {
        ...process.env, OBV_ENVIRONMENT: "pilot", OBV_DATA_DIR: DIR_PILOT, OBV_SESSION_SECRET: SECRET,
        OBV_AUTH_LINK_DELIVERY: "file", OBV_PILOT_CHECK_SKIP_NET: "1",
        OBV_EMAIL_PROVIDER: "outbox", OBV_INTEGRATIONS_PRODUCTION_ENABLE: "",
        OBV_POSTMARK_SERVER_TOKEN: "", OBV_EMAIL_FROM: "", OBV_POSTMARK_API_BASE_URL: "",
      },
      timeout: 30000,
      encoding: "utf8",
    });
    assert(
      r.status === 1 && /FAIL/.test(r.stdout) && /development file delivery active|development outbox active/.test(r.stdout),
      "pilot:check FAILS (exit 1) when development delivery is active in a pilot environment"
    );
    assert(!/test-token-never-logged|0123456789abcdef/.test(r.stdout + r.stderr), "pilot:check never prints secret values");
  }

  capture.close();
  console.log(`\nPILOT PRODUCTION BOUNDARY TESTS PASSED — ${passed} checkpoints.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
