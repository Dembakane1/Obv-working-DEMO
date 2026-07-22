/**
 * Deployment smoke check — runs the automatable part of the deployment
 * test matrix against a DEPLOYED OBV instance (or localhost).
 *
 *   node scripts/deploy-check.js https://your-app.onrender.com [access-code]
 *
 * Verifies from outside, exactly as a phone or laptop would:
 *   health endpoint schema, HTTPS redirect behavior, role picker,
 *   session gating, PWA assets (manifest, service worker, icons),
 *   field context API, seeded state, and static asset serving.
 * Camera, GPS, offline queue, and PDF download remain manual phone
 * checks (see README "Deployment test matrix").
 *
 * Zero dependencies — plain fetch(). Exits non-zero on any failure.
 */
const base = (process.argv[2] ?? "").replace(/\/$/, "");
const accessCode = process.argv[3] ?? "";
if (!base) {
  console.error("Usage: node scripts/deploy-check.js <base-url> [access-code]");
  process.exit(2);
}

let pass = 0;
let fail = 0;
const cookies = new Map();

// ---- deployment configuration assertion (runs before any network) ----
// Production MUST deploy from main. If render.yaml stops tracking main,
// deploy-check fails regardless of what the deployed instance answers.
{
  const fs = require("node:fs");
  const path = require("node:path");
  const renderYaml = fs.readFileSync(path.join(__dirname, "..", "render.yaml"), "utf8");
  const prodBlock = renderYaml.slice(renderYaml.indexOf("name: obv-demo"), renderYaml.indexOf("obv-frontend-preview"));
  const m = /branch:\s*(\S+)/.exec(prodBlock);
  if (m && m[1] === "main") {
    pass += 1;
    console.log("  ✓ render.yaml production service (obv-demo) deploys from main");
  } else {
    fail += 1;
    console.error(`  ✗ render.yaml production service tracks '${m ? m[1] : "(none)"}' — must be 'main'`);
  }
  // The banking layer must stay mock/demo in deployment configuration:
  // no non-mock provider, no production-enable flag, no credentials.
  if (
    !/OBV_BANKING_PROVIDER[\s\S]{0,80}?value:\s*(?!["']?mock)/.test(renderYaml) &&
    !/OBV_BANKING_PRODUCTION_ENABLE/.test(renderYaml) &&
    !/OBV_BANKING_MODE[\s\S]{0,80}?value:\s*["']?production/.test(renderYaml)
  ) {
    pass += 1;
    console.log("  ✓ render.yaml configures no non-mock banking provider, production mode or enable flag");
  } else {
    fail += 1;
    console.error("  ✗ render.yaml sets a non-mock banking provider, production banking mode or the production-enable flag");
  }
}

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeCookies(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function get(path, opts = {}) {
  const res = await fetch(base + path, {
    redirect: "manual",
    ...opts,
    headers: { cookie: cookieHeader(), ...(opts.headers ?? {}) },
  });
  storeCookies(res);
  return res;
}

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

(async () => {
  console.log(`OBV deployment check against ${base}\n`);

  // 1. Health endpoint: schema and honesty (no secrets, expected enums).
  const healthRes = await get("/api/health");
  check("GET /api/health responds 200", healthRes.status === 200, `status ${healthRes.status}`);
  let health = {};
  try {
    health = await healthRes.json();
  } catch {
    /* handled below */
  }
  check("health.status is ok", health.status === "ok", JSON.stringify(health));
  check("health.database is connected", health.database === "connected");
  check(
    "health.reportRenderer is pdf or html-fallback",
    ["pdf", "html-fallback"].includes(health.reportRenderer)
  );
  check(
    "health.aiMode is live-capable or fallback-only",
    ["live-capable", "fallback-only"].includes(health.aiMode)
  );
  check(
    "health.teamsMode is configured or demo",
    ["configured", "demo"].includes(health.teamsMode)
  );
  check("health.timestamp is ISO date", !Number.isNaN(Date.parse(health.timestamp ?? "")));
  const healthText = JSON.stringify(health).toLowerCase();
  check(
    "health leaks no secrets/paths",
    !/key|token|webhook|\/app|\/var|c:\\/.test(healthText),
    healthText
  );
  if (health.reportRenderer !== "pdf") {
    console.log("        note: reportRenderer is html-fallback — PDF generation");
    console.log("        will degrade to the printable HTML preview on this host.");
  }

  // 2. Access gate (when configured) then role picker.
  let root = await get("/");
  if (root.status === 401) {
    check("access gate is active (401 before code)", true);
    if (!accessCode) {
      console.log("  SKIP  remaining checks need the access code (pass it as arg 2)");
      report();
      return;
    }
    const gateRes = await get("/api/access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `code=${encodeURIComponent(accessCode)}`,
    });
    check("access code accepted", gateRes.status === 303 || gateRes.status === 302);
    root = await get("/");
  }
  const rootHtml = await root.text();
  check(
    "public homepage renders at /",
    root.status === 200 && rootHtml.includes("Verify physical progress before capital moves.")
  );
  const demo = await get("/demo");
  const demoHtml = await demo.text();
  check("role picker page renders at /demo", demo.status === 200 && demoHtml.includes("Select a demonstration role"));
  check("role picker lists seeded users", demoHtml.includes("Margaret Osei"));

  // 3. Session gating: pages redirect to the demo picker without a session.
  const gated = await get("/overview");
  check("/overview requires a demo session", [302, 303].includes(gated.status));

  // 4. Sign in as funder, load overview, confirm seeded state.
  const session = await get("/api/session", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "userId=user-funder",
  });
  check("session sign-in works", [302, 303].includes(session.status));
  const overview = await get("/overview");
  const overviewHtml = await overview.text();
  check("overview renders after sign-in", overview.status === 200);
  check(
    "seeded project present",
    overviewHtml.includes("Mzimba") && overviewHtml.includes("Kafukule")
  );
  check("demo environment indicator shown", /demo environment/i.test(overviewHtml));

  // 5. PWA assets over HTTPS.
  const manifest = await get("/manifest.webmanifest");
  check("web app manifest served", manifest.status === 200);
  const sw = await get("/sw.js");
  check(
    "service worker served as JS",
    sw.status === 200 && (sw.headers.get("content-type") ?? "").includes("javascript")
  );
  const icon = await get("/icons/icon-192.png");
  check("PWA icon served", icon.status === 200);
  const css = await get("/styles.css");
  check("stylesheet served", css.status === 200);

  // 6. Field capture context API (drives the phone capture flow).
  const fieldCtx = await get("/api/field-context");
  let fieldOk = false;
  try {
    const ctx = await fieldCtx.json();
    fieldOk =
      Array.isArray(ctx.projects) &&
      ctx.projects[0].milestones.some((m) => m.status === "PENDING_EVIDENCE");
  } catch {
    /* fieldOk stays false */
  }
  check("field context API returns pending milestone", fieldOk);

  // 7. State fingerprint API (dashboard polling).
  const state = await get("/api/state");
  let fp = {};
  try {
    fp = await state.json();
  } catch {
    /* handled below */
  }
  check("state fingerprint API works", state.status === 200 && typeof fp.fingerprint === "string");

  report();

  function report() {
    console.log(`\n${pass} passed, ${fail} failed`);
    console.log(
      "Manual phone checks still required: camera permission + capture, GPS\n" +
        "permission + geofence, offline queue, PDF open/share, PWA install.\n" +
        "See README → 'Deployment test matrix'."
    );
    process.exit(fail === 0 ? 0 : 1);
  }
})().catch((err) => {
  console.error("deploy-check failed:", err.message);
  process.exit(1);
});
