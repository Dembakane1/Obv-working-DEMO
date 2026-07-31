#!/usr/bin/env node
/**
 * Production Identity Platform test battery.
 *
 * Proves the identity layer is durable, non-duplicating, revocable, and
 * additive on top of the untouched authorization model:
 *   0. static source guards (append-only audit, hashed secrets, no
 *      password path, readiness registries have no write path)
 *   1. boot (demo posture) — identities empty until first invitation
 *   2. invitation → durable identity + membership + signed-in session
 *   3. re-invitation to the same org NEVER duplicates the user
 *   4. second org → second users row behind the SAME identity
 *   5. magic-link sign-in (non-oracle request, GET does not consume)
 *   6. replay protection (single-use tokens, identical generic failure)
 *   7. expired links; 8. tampered tokens; 9. cookie tampering
 *  10. org switching = session rotation (same-404 for foreign memberships)
 *  11. concurrent sessions, per-device revoke, logout everywhere
 *  12. idle + absolute expiry; 13. trusted devices
 *  14. brute-force lockout; 15. CSRF enforcement
 *  16. suspension / restoration; 17. ownership transfer
 *  18. cross-tenant authorization through identity sessions (same-404)
 *  19. production posture: switcher dead, /signin live, bootstrap admin
 *  20. secret hygiene (hashes at rest, nothing secret serialized)
 *  21. audit immutability + primary records untouched by identity reads
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 3250;
const PROD_PORT = 3251;
const BASE = `http://127.0.0.1:${PORT}`;
const PROD_BASE = `http://127.0.0.1:${PROD_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-identity-"));
const PROD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-identity-prod-"));
const ROOT = process.cwd();

let passed = 0;
const pass = (m) => {
  passed += 1;
  console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`);
};
const fail = (m) => {
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (cond, m) => (cond ? pass(m) : fail(m));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------ http utils

const jars = {};
async function req(base, method, p, { cookie, body, headers, form } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: {
      "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
      ...(cookie ? { cookie } : {}),
      ...(headers ?? {}),
    },
    body:
      body === undefined
        ? undefined
        : form
          ? new URLSearchParams(body).toString()
          : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, setCookies: res.headers.getSetCookie() };
}
const api = (method, p, opts) => req(BASE, method, p, opts);

async function demoSignIn(key, userId) {
  const r = await api("POST", "/api/session", { body: { userId } });
  if (!r.setCookies.length) fail(`demo sign-in for ${userId} returned no cookie (${r.status})`);
  jars[key] = r.setCookies[0].split(";")[0];
}

function authCookieFrom(setCookies) {
  const c = (setCookies ?? []).find((x) => x.startsWith("obv_auth="));
  return c ? c.split(";")[0] : null;
}

function outboxLinks(dir) {
  const p = path.join(dir, "auth-outbox.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const lastLinkFor = (dir, email) => {
  const rows = outboxLinks(dir).filter((r) => r.to === email);
  return rows.length ? rows[rows.length - 1].link : null;
};
const tokenOf = (link) => link.split("token=")[1];

/** Request a magic link and return the freshly issued raw token. The
 *  suite legitimately signs in far more often than a person would, so
 *  earlier tokens are aged out of the issuance-throttle window first
 *  (this suite's own disposable database). */
async function issueLink(email) {
  run(
    "UPDATE auth_tokens SET created_at = '2000-01-01T00:00:00.000Z' WHERE identity_id IN (SELECT id FROM identities WHERE email = ?)",
    email
  );
  const before = outboxLinks(DATA_DIR).length;
  const r = await api("POST", "/api/auth/magic-link", { body: { email } });
  if (r.status !== 200) fail(`magic-link request → ${r.status}`);
  if (outboxLinks(DATA_DIR).length !== before + 1) fail(`no link delivered for ${email}`);
  return tokenOf(lastLinkFor(DATA_DIR, email));
}

/** Complete sign-in the way a browser does: GET the confirmation page
 *  (arming the anti-login-CSRF obv_confirm cookie), then POST echoing
 *  that cookie's value. */
async function completeLink(token, extra = {}, base = BASE) {
  const g = await req(base, "GET", `/auth/complete?token=${token}`, {});
  const confirmCookie = (g.setCookies ?? []).find((c) => c.startsWith("obv_confirm="));
  const confirm = confirmCookie ? confirmCookie.split(";")[0].split("=")[1] : "";
  return req(base, "POST", "/api/auth/complete", {
    cookie: `obv_confirm=${confirm}`,
    body: { token, confirm, ...extra },
  });
}

async function me(cookie) {
  return api("GET", "/api/auth/me", { cookie });
}

// ------------------------------------------------------------- db utils

let db = null;
const q1 = (sql, ...args) => db.prepare(sql).get(...args);
const qa = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);

function tableHash(table) {
  const rows = qa(`SELECT * FROM ${table} ORDER BY 1`);
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

// ------------------------------------------------------------ section 0

function staticGuards() {
  console.log("\n== 0. Static source guards ==");
  const readSrc = (p) =>
    fs
      .readFileSync(path.join(ROOT, p), "utf8")
      .split("\n")
      .filter((line) => !/^import type /.test(line))
      .join("\n");
  const identityFiles = [
    "src/server/services/identity/core.ts",
    "src/server/services/identity/auth.ts",
    "src/server/services/identity/identities.ts",
    "src/server/services/identity/ssoReadiness.ts",
    "src/server/services/identity/index.ts",
    "src/server/db/identityRepo.ts",
    "src/server/http/identityRoutes.ts",
  ];
  const combined = identityFiles.map(readSrc).join("\n");
  assert(
    !/\bnode:https?\b|fetch\s*\(|axios|XMLHttpRequest|net\.connect/.test(combined),
    "identity layer contains no network primitives"
  );

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
  const allSrc = walk(path.join(ROOT, "src"))
    .map((p) => fs.readFileSync(p, "utf8"))
    .join("\n");
  assert(
    !/UPDATE\s+auth_events|DELETE\s+FROM\s+auth_events/.test(allSrc),
    "auth_events is append-only across the entire codebase"
  );
  assert(
    !/INSERT INTO\s+(identity_providers|identity_provider_links|mfa_methods)/.test(allSrc),
    "SSO/MFA readiness registries have no write path anywhere"
  );
  const passwordWrites = allSrc.match(/password_hash/g) ?? [];
  const schemaMentions = readSrc("src/server/db/index.ts").match(/password_hash/g) ?? [];
  assert(
    passwordWrites.length === schemaMentions.length,
    "password_hash exists in the schema only — no code path reads or writes it"
  );

  const repoSrc = readSrc("src/server/db/identityRepo.ts");
  assert(
    /consumed_at = \? WHERE id = \? AND consumed_at IS NULL/.test(repoSrc),
    "token consumption is a guarded single-use update"
  );
  assert(
    /revoked_at = \?, revoked_reason = \?, rotated_to = \? WHERE id = \? AND revoked_at IS NULL/.test(repoSrc),
    "session revocation is a guarded single-shot update"
  );

  const authSrc = readSrc("src/server/services/identity/auth.ts");
  assert(/sha256Hex\(rawToken\)/.test(authSrc), "magic-link tokens are stored as sha256 hashes");
  assert(/sha256Hex\(secret\)/.test(authSrc), "session secrets are stored as sha256 hashes");
  assert(/GENERIC_AUTH_FAILURE/.test(authSrc), "every completion failure shares one generic message");
  assert(/GENERIC_LINK_RESPONSE/.test(readSrc("src/server/services/identity/core.ts")), "link requests share one generic response");
  const coreSrc = readSrc("src/server/services/identity/core.ts");
  assert(/timingSafeEqual/.test(coreSrc), "secret comparison is constant-time");

  const routesSrc = readSrc("src/server/http/identityRoutes.ts");
  assert(
    /obv_confirm/.test(routesSrc) && /safeStringEqual\(confirmField, confirmCookie\)/.test(routesSrc),
    "sign-in completion requires the confirmation-page cookie (anti login-CSRF)"
  );
  assert(
    /split\(","\)\.pop\(\)/.test(routesSrc),
    "forwarded-for parsing uses the trusted proxy's hop, not the client-supplied first entry"
  );

  const ssoSrc = readSrc("src/server/services/identity/ssoReadiness.ts");
  assert(/return false/.test(ssoSrc) && /IdentityError\("Not found", 404\)/.test(ssoSrc),
    "SSO module refuses activation with a nondisclosing 404");

  const schemaSrc = readSrc("src/server/db/index.ts");
  for (const table of [
    "identities", "identity_users", "auth_tokens", "auth_sessions", "auth_events",
    "auth_lockouts", "identity_providers", "identity_provider_links", "mfa_methods",
  ]) {
    assert(schemaSrc.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `schema declares ${table}`);
  }
  const disabledChecks = schemaSrc.match(/DEFAULT 'DISABLED' CHECK \(status IN \('DISABLED'\)\)/g) ?? [];
  assert(disabledChecks.length >= 2, "identity_providers and mfa_methods are constrained DISABLED at the database level");
  assert(
    /UNIQUE \(identity_id, organization_id\)/.test(schemaSrc),
    "one membership per identity per organization is a database constraint"
  );

  const envExample = readSrc(".env.example");
  for (const name of ["OBV_BOOTSTRAP_ADMIN_EMAIL", "OBV_BOOTSTRAP_ORG_NAME", "OBV_AUTH_LINK_DELIVERY"]) {
    assert(new RegExp(`^# ${name}=\\s*$`, "m").test(envExample), `.env.example documents ${name} with an empty value`);
  }
}

// ---------------------------------------------------------------- main

let server = null;
let prodServer = null;

async function boot(base, extraEnv, dataDir) {
  const seed = spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: dataDir },
    stdio: "ignore",
  });
  if (seed.status !== 0) fail("seed failed");
  const child = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...process.env,
      OBV_DATA_DIR: dataDir,
      OBV_BANKING_PROVIDER: "mock",
      OBV_BANKING_MODE: "demo",
      ...extraEnv,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`server at ${base} did not become healthy`);
  return child;
}

async function main() {
  staticGuards();

  console.log("\n== 1. Boot (demo posture) ==");
  server = await boot(BASE, { PORT: String(PORT) }, DATA_DIR);
  pass("server healthy");
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(path.join(DATA_DIR, "obv.db"));
  assert(q1("SELECT COUNT(*) AS c FROM identities").c === 0, "identities table empty at boot (no bootstrap env set)");
  await demoSignIn("pm", "user-pm");
  pass("seeded demo switcher still signs in (demo posture preserved)");

  // ------------------------------------------------------------ section 2
  console.log("\n== 2. Invitation creates durable identity + session ==");
  let r = await api("POST", "/api/pilot/orgs", { cookie: jars.pm, body: { name: "Meridian Capital", kind: "LENDER" } });
  assert(r.status === 201, "org A created");
  const orgA = JSON.parse(r.text).organization;
  r = await api("POST", "/api/pilot/orgs", { cookie: jars.pm, body: { name: "Northgate Fund", kind: "FUNDER" } });
  const orgB = JSON.parse(r.text).organization;
  pass("org B created");

  const invite = async (email, organizationId, role) => {
    const res = await api("POST", "/api/pilot/invitations", {
      cookie: jars.pm,
      body: { email, organizationId, role },
    });
    if (res.status !== 201) fail(`invitation for ${email} → ${res.status}: ${res.text.slice(0, 200)}`);
    return JSON.parse(res.text);
  };
  const accept = (link, name, title) =>
    api("POST", "/api/invitations/accept", {
      body: { token: link.split("/invite/")[1], name, title },
    });

  const inv1 = await invite("dana@meridian.example", orgA.id, "PROJECT_MANAGER");
  r = await accept(inv1.activationLink, "Dana Whitfield", "Portfolio Director");
  assert(r.status === 201, "invitation accepted");
  const danaOrgACookie = authCookieFrom(r.setCookies);
  assert(danaOrgACookie !== null, "acceptance response sets the production obv_auth session cookie");
  assert(r.setCookies.some((c) => c.startsWith("obv_user=")), "acceptance keeps the legacy signed demo cookie");
  const identityRow = q1("SELECT * FROM identities WHERE email = ?", "dana@meridian.example");
  assert(Boolean(identityRow), "durable identity created for the invited email");
  assert(identityRow.email_verified_at !== null, "invitation acceptance verifies the email (mailbox control proven)");
  const danaUserA = JSON.parse(r.text).user;
  const membershipA = q1("SELECT * FROM identity_users WHERE identity_id = ? AND organization_id = ?", identityRow.id, orgA.id);
  assert(membershipA && membershipA.user_id === danaUserA.id, "membership links the identity to the org's users row");
  assert(membershipA.is_owner === 1, "first identity-linked member stewards the organization (owner)");
  assert(
    qa("SELECT * FROM auth_events WHERE identity_id = ? AND kind = 'SIGN_IN'", identityRow.id).length === 1,
    "sign-in recorded in the immutable audit log"
  );
  r = await me(danaOrgACookie);
  assert(r.status === 200 && JSON.parse(r.text).user.id === danaUserA.id, "session resolves to the invited users row");

  // ------------------------------------------------------------ section 3
  console.log("\n== 3. Re-invitation never duplicates ==");
  const usersInOrgA = () => q1("SELECT COUNT(*) AS c FROM users WHERE organization_id = ?", orgA.id).c;
  const before = usersInOrgA();
  const inv2 = await invite("dana@meridian.example", orgA.id, "COMPLIANCE_REVIEWER");
  r = await accept(inv2.activationLink, "Dana Whitfield", "Portfolio Director");
  assert(r.status === 201, "second invitation to the same org accepted");
  assert(usersInOrgA() === before, "NO duplicate users row was created");
  assert(JSON.parse(r.text).user.id === danaUserA.id, "acceptance resolved to the existing users row");
  assert(
    authCookieFrom(r.setCookies) === null && JSON.parse(r.text).signInRequired === true,
    "acceptance for an EXISTING account attaches only — the admin-visible activation link never becomes a session"
  );
  assert(
    q1("SELECT COUNT(*) AS c FROM identities WHERE email = ?", "dana@meridian.example").c === 1,
    "still exactly one identity for the email"
  );
  assert(
    q1("SELECT accepted_user_id FROM invitations WHERE id = ?", inv2.invitation.id).accepted_user_id === danaUserA.id,
    "invitation marked accepted against the existing user"
  );
  const danaRole = q1("SELECT role FROM users WHERE id = ?", danaUserA.id).role;
  assert(danaRole === "PROJECT_MANAGER", "existing role preserved (invitation is not a silent role change)");

  // ------------------------------------------------------------ section 4
  console.log("\n== 4. Multiple organizations, one identity ==");
  const inv3 = await invite("dana@meridian.example", orgB.id, "FUNDER_REP");
  r = await accept(inv3.activationLink, "Dana Whitfield", "Fund Analyst");
  assert(r.status === 201, "invitation to a second organization accepted");
  const danaUserB = JSON.parse(r.text).user;
  assert(danaUserB.id !== danaUserA.id, "second org gets its own users row");
  assert(
    q1("SELECT COUNT(*) AS c FROM identities WHERE email = ?", "dana@meridian.example").c === 1,
    "…linked to the SAME single identity"
  );
  assert(authCookieFrom(r.setCookies) === null, "cross-org acceptance also requires the person's own sign-in");
  const danaOrgBCookie = authCookieFrom((await completeLink(await issueLink("dana@meridian.example"))).setCookies);
  r = await me(danaOrgBCookie);
  const meBody = JSON.parse(r.text);
  assert(meBody.memberships.length === 2, "identity reports both memberships");
  assert(
    meBody.memberships.some((m) => m.organizationId === orgA.id) &&
      meBody.memberships.some((m) => m.organizationId === orgB.id),
    "memberships span both organizations"
  );

  // ------------------------------------------------------------ section 5
  console.log("\n== 5. Magic-link sign-in ==");
  const outboxBefore = outboxLinks(DATA_DIR).length;
  r = await api("POST", "/api/auth/magic-link", { body: { email: "dana@meridian.example" } });
  const realBody = r.text;
  assert(r.status === 200, "link request returns 200");
  r = await api("POST", "/api/auth/magic-link", { body: { email: "ghost@nowhere.example" } });
  assert(r.status === 200 && r.text === realBody, "unknown email gets a byte-identical generic response (non-oracle)");
  const outboxAfter = outboxLinks(DATA_DIR);
  assert(outboxAfter.length === outboxBefore + 1, "a link was delivered only for the real account");
  const magicToken = tokenOf(lastLinkFor(DATA_DIR, "dana@meridian.example"));
  r = await req(BASE, "GET", `/auth/complete?token=${magicToken}`, {});
  assert(r.status === 200 && r.text.includes("Confirm sign-in"), "GET renders the confirmation form");
  r = await req(BASE, "GET", `/auth/complete?token=${magicToken}`, {});
  assert(r.status === 200, "GET is repeatable — it never consumes the token (scanner-safe)");
  r = await req(BASE, "POST", "/api/auth/complete", { body: { token: magicToken } });
  assert(r.status === 403, "a bare cross-site POST cannot complete sign-in (login-CSRF confirm required)");
  assert(
    q1("SELECT consumed_at FROM auth_tokens WHERE token_hash = ?", sha256(magicToken)).consumed_at === null,
    "…and the rejected request did not consume the token"
  );
  r = await completeLink(magicToken);
  assert(r.status === 201, "POST completes sign-in");
  const magicCookie = authCookieFrom(r.setCookies);
  r = await api("GET", "/overview", { cookie: magicCookie, headers: { accept: "text/html" } });
  assert(r.status === 200, "magic-link session reaches the application");

  // ------------------------------------------------------------ section 6
  console.log("\n== 6. Replay protection ==");
  r = await completeLink(magicToken);
  assert(r.status === 400, "replaying a consumed link fails");
  const replayBody = r.text;
  assert(
    qa("SELECT * FROM auth_events WHERE kind = 'LOGIN_REPLAY_BLOCKED'").length >= 1,
    "replay attempt recorded in the audit log"
  );
  const tok = q1("SELECT * FROM auth_tokens WHERE token_hash = ?", sha256(magicToken));
  assert(tok.consumed_at !== null, "token is marked consumed exactly once");

  // ------------------------------------------------------------ section 7
  console.log("\n== 7. Expired links ==");
  const expiredToken = await issueLink("dana@meridian.example");
  run("UPDATE auth_tokens SET expires_at = ? WHERE token_hash = ?", "2000-01-01T00:00:00.000Z", sha256(expiredToken));
  r = await completeLink(expiredToken);
  assert(r.status === 400 && r.text === replayBody, "expired link fails with the identical generic body");
  assert(
    qa("SELECT * FROM auth_events WHERE kind = 'LOGIN_FAILED_EXPIRED_LINK'").length >= 1,
    "expiry recorded distinctly in the audit log"
  );

  // ------------------------------------------------------------ section 8
  console.log("\n== 8. Token tampering ==");
  const realToken = await issueLink("dana@meridian.example");
  const flipped = (realToken[0] === "a" ? "b" : "a") + realToken.slice(1);
  r = await completeLink(flipped);
  assert(r.status === 400 && r.text === replayBody, "tampered token fails with the identical generic body");
  r = await completeLink("zz");
  assert(r.status === 400 && r.text === replayBody, "malformed token fails with the identical generic body");
  r = await completeLink(realToken);
  assert(r.status === 201, "the untampered token still works after tamper attempts");
  const sessionCookie = authCookieFrom(r.setCookies);

  // ------------------------------------------------------------ section 9
  console.log("\n== 9. Cookie tampering ==");
  const [cName, cValue] = sessionCookie.split("=");
  const [sid, secret] = cValue.split(".");
  const wrongSecret = (secret[0] === "f" ? "e" : "f") + secret.slice(1);
  r = await me(`${cName}=${sid}.${wrongSecret}`);
  assert(r.status === 401, "flipped session secret is rejected");
  r = await me(`${cName}=${sid}.${secret.slice(0, 32)}`);
  assert(r.status === 401, "truncated secret is rejected");
  r = await me(`${cName}=${sid}`);
  assert(r.status === 401, "cookie without a secret half is rejected");
  const sessRow = q1("SELECT * FROM auth_sessions WHERE id = ?", sid);
  assert(sessRow.secret_hash === sha256(secret), "database stores only the sha256 of the cookie secret");
  assert(sessRow.secret_hash !== secret, "…never the secret itself");
  r = await me(sessionCookie);
  assert(r.status === 200, "the genuine cookie still works");

  // ------------------------------------------------------------ section 10
  console.log("\n== 10. Org switching rotates the session ==");
  const meNow = JSON.parse((await me(sessionCookie)).text);
  const otherMembership = meNow.memberships.find((m) => !m.current);
  const csrfRow = q1("SELECT csrf_token FROM auth_sessions WHERE id = ?", sid);
  r = await api("POST", "/api/auth/switch-org", {
    cookie: sessionCookie,
    headers: { "x-obv-csrf": csrfRow.csrf_token },
    body: { membershipId: otherMembership.id },
  });
  assert(r.status === 200, "org switch succeeds with CSRF token");
  const rotatedCookie = authCookieFrom(r.setCookies);
  assert(rotatedCookie !== null && rotatedCookie !== sessionCookie, "switch issues a NEW session cookie");
  r = await me(sessionCookie);
  assert(r.status === 401, "the pre-rotation cookie is dead immediately");
  r = await me(rotatedCookie);
  const afterSwitch = JSON.parse(r.text);
  assert(afterSwitch.user.organizationId === otherMembership.organizationId, "session now acts as the other org's users row");
  const oldRow = q1("SELECT * FROM auth_sessions WHERE id = ?", sid);
  assert(oldRow.revoked_reason === "ROTATED" && oldRow.rotated_to !== null, "old session records its rotation successor");
  const newRow = q1("SELECT * FROM auth_sessions WHERE id = ?", oldRow.rotated_to);
  assert(newRow.absolute_expires_at === oldRow.absolute_expires_at, "rotation inherits the absolute deadline (never extends)");
  // same-404 for memberships outside this identity
  const rotatedSid = rotatedCookie.split("=")[1].split(".")[0];
  const rotatedCsrf = q1("SELECT csrf_token FROM auth_sessions WHERE id = ?", rotatedSid).csrf_token;
  r = await api("POST", "/api/auth/switch-org", {
    cookie: rotatedCookie,
    headers: { "x-obv-csrf": rotatedCsrf },
    body: { membershipId: "no-such-membership" },
  });
  assert(r.status === 404, "unknown membership id → 404");

  // ------------------------------------------------------------ section 11
  console.log("\n== 11. Concurrent sessions + revocation ==");
  const tokenB = await issueLink("dana@meridian.example");
  const rb = await completeLink(tokenB);
  const cookieB = authCookieFrom(rb.setCookies);
  r = await api("GET", "/api/auth/sessions", { cookie: rotatedCookie });
  const sessions = JSON.parse(r.text).sessions;
  assert(sessions.length >= 2, `concurrent sessions listed (${sessions.length})`);
  assert(sessions.every((s) => s.secretHash === undefined && s.csrfToken === undefined), "session listing leaks no secrets");
  const otherSession = sessions.find((s) => !s.current);
  r = await api("POST", `/api/auth/sessions/${otherSession.id}/revoke`, {
    cookie: rotatedCookie,
    headers: { "x-obv-csrf": rotatedCsrf },
    body: {},
  });
  assert(r.status === 200, "per-device revoke succeeds");
  r = await me(cookieB);
  assert(r.status === 401, "the revoked device is signed out immediately");
  r = await me(rotatedCookie);
  assert(r.status === 200, "the surviving device is untouched");
  // sign in again, then logout everywhere
  const tokenC = await issueLink("dana@meridian.example");
  const cookieC = authCookieFrom((await completeLink(tokenC)).setCookies);
  r = await api("POST", "/api/auth/logout-all", {
    cookie: rotatedCookie,
    headers: { "x-obv-csrf": rotatedCsrf },
    body: {},
  });
  assert(r.status === 200, "logout everywhere succeeds");
  assert((await me(rotatedCookie)).status === 401, "current device signed out");
  assert((await me(cookieC)).status === 401, "every other device signed out");
  assert(
    qa("SELECT * FROM auth_events WHERE kind = 'SIGN_OUT_EVERYWHERE'").length >= 1,
    "global sign-out recorded in the audit log"
  );

  // ------------------------------------------------------------ section 12
  console.log("\n== 12. Idle + absolute expiry ==");
  const tokenD = await issueLink("dana@meridian.example");
  const cookieD = authCookieFrom((await completeLink(tokenD)).setCookies);
  const sidD = cookieD.split("=")[1].split(".")[0];
  run("UPDATE auth_sessions SET idle_expires_at = ? WHERE id = ?", "2000-01-01T00:00:00.000Z", sidD);
  assert((await me(cookieD)).status === 401, "idle-expired session is rejected");
  assert(
    q1("SELECT revoked_reason FROM auth_sessions WHERE id = ?", sidD).revoked_reason === "IDLE_TIMEOUT",
    "idle expiry recorded once as IDLE_TIMEOUT"
  );
  const tokenE = await issueLink("dana@meridian.example");
  const cookieE = authCookieFrom((await completeLink(tokenE)).setCookies);
  const sidE = cookieE.split("=")[1].split(".")[0];
  run("UPDATE auth_sessions SET absolute_expires_at = ? WHERE id = ?", "2000-01-01T00:00:00.000Z", sidE);
  assert((await me(cookieE)).status === 401, "absolute-expired session is rejected even when recently active");
  assert(
    q1("SELECT revoked_reason FROM auth_sessions WHERE id = ?", sidE).revoked_reason === "ABSOLUTE_TIMEOUT",
    "absolute expiry recorded as ABSOLUTE_TIMEOUT"
  );
  assert(
    qa("SELECT * FROM auth_events WHERE kind = 'SESSION_EXPIRED'").length >= 2,
    "session expirations audited"
  );

  // ------------------------------------------------------------ section 13
  console.log("\n== 13. Trusted devices ==");
  const tokenF = await issueLink("dana@meridian.example");
  const cookieF = authCookieFrom((await completeLink(tokenF)).setCookies);
  const rowF = q1("SELECT * FROM auth_sessions WHERE id = ?", cookieF.split("=")[1].split(".")[0]);
  const tokenG = await issueLink("dana@meridian.example");
  const cookieG = authCookieFrom((await completeLink(tokenG, { trust: "1" })).setCookies);
  const rowG = q1("SELECT * FROM auth_sessions WHERE id = ?", cookieG.split("=")[1].split(".")[0]);
  assert(rowF.trusted_device === 0 && rowG.trusted_device === 1, "trust choice recorded per session");
  const spanF = Date.parse(rowF.absolute_expires_at) - Date.parse(rowF.created_at);
  const spanG = Date.parse(rowG.absolute_expires_at) - Date.parse(rowG.created_at);
  assert(spanF <= 13 * 3600_000, "standard session absolute window is short (≤ ~12h)");
  assert(spanG >= 20 * 86400_000, "trusted device window is long (≥ 20 days)");
  assert(
    rowG.idle_expires_at === rowG.absolute_expires_at,
    "trusted devices do not idle-expire — only the absolute deadline bounds them"
  );

  // ------------------------------------------------------------ section 14
  console.log("\n== 14. Brute force → lockout ==");
  const preLock = outboxLinks(DATA_DIR).length;
  for (let i = 0; i < 6; i += 1) {
    const bogus = crypto.randomBytes(32).toString("hex");
    await completeLink(bogus);
  }
  assert(
    qa("SELECT * FROM auth_events WHERE kind = 'ACCOUNT_LOCKED'").length >= 1,
    "repeated failures start a lockout (audited)"
  );
  const validDuringLock = q1(
    "SELECT COUNT(*) AS c FROM auth_lockouts WHERE locked_until > ?", new Date().toISOString()
  ).c;
  assert(validDuringLock >= 1, "lockout state persisted with a future expiry");
  const tokenH = await (async () => {
    // Issue while locked: the request is silently swallowed (non-oracle).
    const rr = await api("POST", "/api/auth/magic-link", { body: { email: "dana@meridian.example" } });
    assert(rr.status === 200, "link request while locked still returns the generic 200");
    assert(outboxLinks(DATA_DIR).length === preLock, "…but no link is delivered while locked");
    return null;
  })();
  void tokenH;
  run("DELETE FROM auth_lockouts");
  // Issuance throttle: a burst of link requests stops delivering after
  // the per-identity window fills, still answering generically each time.
  run(
    "UPDATE auth_tokens SET created_at = '2000-01-01T00:00:00.000Z' WHERE identity_id IN (SELECT id FROM identities WHERE email = 'dana@meridian.example')"
  );
  const burstStart = outboxLinks(DATA_DIR).length;
  for (let i = 0; i < 6; i += 1) {
    const rr = await api("POST", "/api/auth/magic-link", { body: { email: "dana@meridian.example" } });
    if (rr.status !== 200) fail(`burst request ${i} → ${rr.status}`);
  }
  assert(
    outboxLinks(DATA_DIR).length === burstStart + 5,
    "issuance throttle caps deliveries per window (5 of 6 burst requests delivered)"
  );
  assert(
    qa("SELECT * FROM auth_events WHERE kind = 'LINK_REQUEST_THROTTLED'").length >= 1,
    "throttled request recorded in the audit log"
  );
  const tokenI = await issueLink("dana@meridian.example");
  assert((await completeLink(tokenI)).status === 201, "sign-in works again after the lockout clears");

  // ------------------------------------------------------------ section 15
  console.log("\n== 15. CSRF enforcement ==");
  const tokenJ = await issueLink("dana@meridian.example");
  const cookieJ = authCookieFrom((await completeLink(tokenJ)).setCookies);
  const sidJ = cookieJ.split("=")[1].split(".")[0];
  const csrfJ = q1("SELECT csrf_token FROM auth_sessions WHERE id = ?", sidJ).csrf_token;
  r = await api("POST", "/api/auth/logout", { cookie: cookieJ, body: {} });
  assert(r.status === 403, "logout without a CSRF token → 403");
  r = await api("POST", "/api/auth/logout", { cookie: cookieJ, headers: { "x-obv-csrf": "0".repeat(32) }, body: {} });
  assert(r.status === 403, "logout with a wrong CSRF token → 403");
  assert(qa("SELECT * FROM auth_events WHERE kind = 'CSRF_REJECTED'").length >= 2, "CSRF rejections audited");
  r = await api("POST", "/api/auth/logout", { cookie: cookieJ, headers: { "x-obv-csrf": csrfJ }, body: {} });
  assert(r.status === 200, "logout with the session's CSRF token succeeds");
  assert((await me(cookieJ)).status === 401, "logout revoked the session server-side");

  // ------------------------------------------------------------ section 16
  console.log("\n== 16. Suspension / restoration ==");
  const invK = await invite("kofi@meridian.example", orgA.id, "COMPLIANCE_REVIEWER");
  r = await accept(invK.activationLink, "Kofi Mensah", "Reviewer");
  const kofiCookie = authCookieFrom(r.setCookies);
  const kofiIdentity = q1("SELECT * FROM identities WHERE email = ?", "kofi@meridian.example");
  const kofiMembership = q1("SELECT * FROM identity_users WHERE identity_id = ?", kofiIdentity.id);
  assert(kofiMembership.is_owner === 0, "second member of the org is not the owner");
  // Dana (owner of org A) suspends Kofi.
  const tokenL = await issueLink("dana@meridian.example");
  let danaCookie = authCookieFrom((await completeLink(tokenL)).setCookies);
  let danaSid = danaCookie.split("=")[1].split(".")[0];
  // Ensure Dana's session is on org A (owner org) — switch if needed.
  let danaMe = JSON.parse((await me(danaCookie)).text);
  if (danaMe.user.organizationId !== orgA.id) {
    const target = danaMe.memberships.find((m) => m.organizationId === orgA.id);
    const csrfNow = q1("SELECT csrf_token FROM auth_sessions WHERE id = ?", danaSid).csrf_token;
    const sw = await api("POST", "/api/auth/switch-org", {
      cookie: danaCookie,
      headers: { "x-obv-csrf": csrfNow },
      body: { membershipId: target.id },
    });
    danaCookie = authCookieFrom(sw.setCookies);
    danaSid = danaCookie.split("=")[1].split(".")[0];
  }
  const danaCsrf = q1("SELECT csrf_token FROM auth_sessions WHERE id = ?", danaSid).csrf_token;
  assert((await me(kofiCookie)).status === 200, "member session live before suspension");
  r = await api("POST", `/api/auth/memberships/${kofiMembership.id}/suspend`, {
    cookie: danaCookie,
    headers: { "x-obv-csrf": danaCsrf },
    body: {},
  });
  assert(r.status === 200, "owner suspends the membership");
  assert((await me(kofiCookie)).status === 401, "suspension revokes the member's live sessions immediately");
  r = await api("POST", "/api/auth/magic-link", { body: { email: "kofi@meridian.example" } });
  const kofiLinks = outboxLinks(DATA_DIR).filter((x) => x.to === "kofi@meridian.example");
  const suspendedLink = kofiLinks[kofiLinks.length - 1];
  r = await completeLink(tokenOf(suspendedLink.link));
  assert(r.status === 403, "suspended membership cannot produce a working session (no active membership)");
  assert(
    qa("SELECT * FROM auth_events WHERE kind = 'MEMBERSHIP_SUSPENDED'").length === 1,
    "suspension recorded in the auth audit"
  );
  assert(
    qa("SELECT * FROM config_audit WHERE action = 'MEMBERSHIP_SUSPENDED'").length === 1,
    "suspension recorded in the administrative audit"
  );
  r = await api("POST", `/api/auth/memberships/${kofiMembership.id}/restore`, {
    cookie: danaCookie,
    headers: { "x-obv-csrf": danaCsrf },
    body: {},
  });
  assert(r.status === 200, "owner restores the membership");
  const tokenM = await issueLink("kofi@meridian.example");
  assert((await completeLink(tokenM)).status === 201, "restored member signs in again");
  // Non-owner cannot administer: Kofi tries to suspend Dana's membership.
  const tokenN = await issueLink("kofi@meridian.example");
  const kofiCookie2 = authCookieFrom((await completeLink(tokenN)).setCookies);
  const kofiSid2 = kofiCookie2.split("=")[1].split(".")[0];
  const kofiCsrf2 = q1("SELECT csrf_token FROM auth_sessions WHERE id = ?", kofiSid2).csrf_token;
  r = await api("POST", `/api/auth/memberships/${membershipA.id}/suspend`, {
    cookie: kofiCookie2,
    headers: { "x-obv-csrf": kofiCsrf2 },
    body: {},
  });
  assert(r.status === 404, "non-owner suspension attempt → same-404 (no authority disclosure)");

  // ------------------------------------------------------------ section 17
  console.log("\n== 17. Ownership transfer ==");
  r = await api("POST", `/api/auth/orgs/${orgA.id}/transfer-ownership`, {
    cookie: danaCookie,
    headers: { "x-obv-csrf": danaCsrf },
    body: { membershipId: kofiMembership.id },
  });
  assert(r.status === 200, "owner transfers ownership");
  assert(
    q1("SELECT is_owner FROM identity_users WHERE id = ?", kofiMembership.id).is_owner === 1,
    "target membership now owns the organization"
  );
  assert(
    q1("SELECT is_owner FROM identity_users WHERE id = ?", membershipA.id).is_owner === 0,
    "previous owner lost the owner flag in the same operation"
  );
  r = await api("POST", `/api/auth/memberships/${kofiMembership.id}/suspend`, {
    cookie: danaCookie,
    headers: { "x-obv-csrf": danaCsrf },
    body: {},
  });
  assert(r.status === 404, "former owner has no administrative authority (same-404)");
  assert(
    qa("SELECT * FROM auth_events WHERE kind = 'OWNERSHIP_TRANSFERRED'").length === 1,
    "transfer recorded in the audit log"
  );

  // ------------------------------------------------------------ section 18
  console.log("\n== 18. Cross-tenant authorization through identity sessions ==");
  const tokenO = await issueLink("dana@meridian.example");
  const danaCookie2 = authCookieFrom((await completeLink(tokenO)).setCookies);
  r = await api("GET", "/project/proj-r47", { cookie: danaCookie2, headers: { accept: "text/html" } });
  assert(r.status === 404, "identity session cannot see another tenant's project (same-404)");
  r = await api("GET", "/api/portfolio/overview", { cookie: danaCookie2 });
  const scoped = JSON.parse(r.text);
  assert(
    scoped.totals.totalProjects === 0,
    "portfolio intelligence scopes the identity session to its own (empty) tenancy"
  );

  // ------------------------------------------------------------ section 19
  console.log("\n== 19. Production posture ==");
  const prodSecret = crypto.randomBytes(32).toString("hex");
  const prodEnv = {
    PORT: String(PROD_PORT),
    OBV_BANKING_MODE: "production",
    OBV_BANKING_PROVIDER: "mock",
    OBV_SESSION_SECRET: prodSecret,
    OBV_BOOTSTRAP_ADMIN_EMAIL: "ops@obv.example",
    OBV_BOOTSTRAP_ORG_NAME: "OBV Pilot Operations",
  };
  // Refuse-rather-than-degrade: production must CHOOSE a delivery mode.
  const noDelivery = spawnSync(
    process.execPath,
    [path.join(ROOT, "dist/server/http/server.js")],
    {
      env: { ...process.env, ...prodEnv, OBV_DATA_DIR: PROD_DATA_DIR, OBV_AUTH_LINK_DELIVERY: "" },
      encoding: "utf8",
      timeout: 20_000,
    }
  );
  assert(
    noDelivery.status === 1 && /OBV_AUTH_LINK_DELIVERY/.test(String(noDelivery.stderr)),
    "production posture refuses to start without an explicit link-delivery choice"
  );
  prodServer = await boot(
    PROD_BASE,
    { ...prodEnv, OBV_AUTH_LINK_DELIVERY: "file" },
    PROD_DATA_DIR
  );
  pass("production-posture server healthy (delivery mode explicitly chosen)");
  r = await req(PROD_BASE, "POST", "/api/session", { body: { userId: "user-funder" } });
  assert(r.status === 404, "demo switcher is dead under production posture");
  r = await req(PROD_BASE, "GET", "/overview", { headers: { accept: "text/html" } });
  assert([302, 303].includes(r.status) && r.headers.get("location") === "/signin",
    "unauthenticated pages redirect to /signin (not the demo picker)");
  r = await req(PROD_BASE, "GET", "/signin", {});
  assert(r.status === 200 && r.text.includes("Sign in to OBV"), "sign-in page live in production");
  assert(!r.text.includes("/demo"), "production sign-in page does not advertise the demo switcher");
  r = await req(PROD_BASE, "POST", "/api/auth/magic-link", { body: { email: "ops@obv.example" } });
  assert(r.status === 200, "bootstrap admin can request a link");
  const prodLink = lastLinkFor(PROD_DATA_DIR, "ops@obv.example");
  assert(prodLink !== null, "bootstrap identity was created at startup (link delivered)");
  r = await completeLink(tokenOf(prodLink), {}, PROD_BASE);
  assert(r.status === 201, "bootstrap admin completes sign-in");
  const prodCookie = authCookieFrom(r.setCookies);
  // The legacy signed demo cookie is a non-revocable bearer statement, so
  // production posture must reject it outright — even correctly signed.
  const forgePayload = Buffer.from(
    JSON.stringify({ u: "user-funder", iat: Date.now(), exp: Date.now() + 3600_000 }),
    "utf8"
  ).toString("base64url");
  const forgeMac = crypto
    .createHmac("sha256", prodSecret)
    .update(`v1.${forgePayload}`)
    .digest()
    .toString("base64url");
  r = await req(PROD_BASE, "GET", "/overview", {
    cookie: `obv_user=v1.${forgePayload}.${forgeMac}`,
    headers: { accept: "text/html" },
  });
  assert(
    [302, 303].includes(r.status),
    "a correctly signed legacy demo cookie does NOT authenticate under production posture"
  );
  r = await req(PROD_BASE, "GET", "/api/auth/me", { cookie: prodCookie });
  const prodMe = JSON.parse(r.text);
  assert(prodMe.user.role === "PROJECT_MANAGER", "bootstrap admin lands as PROJECT_MANAGER");
  assert(prodMe.memberships[0].organizationName === "OBV Pilot Operations", "bootstrap organization honored");
  r = await req(PROD_BASE, "GET", "/overview", { cookie: prodCookie, headers: { accept: "text/html" } });
  assert(r.status === 200, "production session reaches the application without any demo affordance");

  // ------------------------------------------------------------ section 20
  console.log("\n== 20. Secret hygiene ==");
  const meFull = (await me(danaCookie2)).text;
  assert(!/secretHash|csrf_token|csrfToken|password/.test(meFull), "identity/me responses carry no secret material");
  const sessionsFull = (await api("GET", "/api/auth/sessions", { cookie: danaCookie2 })).text;
  assert(!/secretHash|csrfToken/.test(sessionsFull), "session listing carries no secret material");
  const anyRawToken = qa("SELECT token_hash FROM auth_tokens").every((t) => /^[a-f0-9]{64}$/.test(t.token_hash));
  assert(anyRawToken, "every stored auth token is a sha256 hash");
  assert(
    qa("SELECT * FROM auth_events WHERE detail LIKE '%token=%'").length === 0,
    "no audit event ever contains a raw token"
  );

  // ------------------------------------------------------------ section 21
  console.log("\n== 21. Audit immutability + primary records untouched ==");
  const eventsMid = qa("SELECT * FROM auth_events ORDER BY id");
  const primaryTables = [
    "evidence_items", "verifications", "ledger_entries", "virtual_account_events",
    "reports", "audit_packages", "banking_events", "draw_requests", "budget_lines",
    "milestones", "projects",
  ];
  const primaryBefore = {};
  for (const t of primaryTables) primaryBefore[t] = tableHash(t);
  await me(danaCookie2);
  await api("GET", "/api/auth/sessions", { cookie: danaCookie2 });
  await api("GET", "/api/auth/history", { cookie: danaCookie2 });
  await api("GET", "/api/auth/sso/readiness", { cookie: danaCookie2 });
  await api("GET", "/api/auth/mfa/readiness", { cookie: danaCookie2 });
  await api("GET", "/account/security", { cookie: danaCookie2, headers: { accept: "text/html" } });
  for (const t of primaryTables) {
    assert(primaryBefore[t] === tableHash(t), `${t} byte-identical after identity reads`);
  }
  const eventsAfter = qa("SELECT * FROM auth_events ORDER BY id");
  const byId = new Map(eventsAfter.map((e) => [e.id, JSON.stringify(e)]));
  const mutated = eventsMid.filter((e) => byId.get(e.id) !== JSON.stringify(e));
  assert(mutated.length === 0, "no existing audit event was modified (append-only verified)");
  assert(eventsAfter.length >= eventsMid.length, "audit log only ever grows");
  assert(
    q1("SELECT COUNT(*) AS c FROM identity_providers").c === 0 &&
      q1("SELECT COUNT(*) AS c FROM mfa_methods").c === 0,
    "SSO/MFA readiness registries remain empty (no active flow wrote to them)"
  );
  const sso = JSON.parse((await api("GET", "/api/auth/sso/readiness", { cookie: danaCookie2 })).text);
  assert(sso.enabled === false && sso.catalog.length === 7, "SSO readiness reports 7 provider kinds, none enabled");
  const mfa = JSON.parse((await api("GET", "/api/auth/mfa/readiness", { cookie: danaCookie2 })).text);
  assert(mfa.enabled === false && mfa.enrolled.length === 0, "MFA readiness reports no enrollment paths");

  console.log(`\nIDENTITY PLATFORM TESTS PASSED — ${passed} checkpoints.`);
  console.log("ONE EMAIL, ONE IDENTITY. SESSIONS ARE REVOCABLE ROWS, NOT BEARER STATEMENTS.");
}

main()
  .catch((err) => {
    console.error(err.stack ?? err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (server) server.kill();
    if (prodServer) prodServer.kill();
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      fs.rmSync(PROD_DATA_DIR, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
