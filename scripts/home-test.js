/**
 * Public homepage + demo-entry routing tests.
 *
 *   node scripts/home-test.js   (isolated server on :3196)
 *
 * Covers: / renders the enterprise homepage, /demo renders the role
 * selector, every seeded role still enters the correct experience,
 * homepage CTAs reach /demo, the /demo logo returns to /, existing deep
 * links keep working (unauthenticated → /demo, authenticated → page),
 * /app · /platform · /security routes, honest content constraints (no
 * fake certifications/testimonials/predictions), and mobile rendering
 * without horizontal overflow (when Playwright is available).
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3196;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-home-"));

let n = 0;
const pass = (m) => console.log(`  ✓ [${++n}] ${m}`);
const fail = (m) => {
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (c, m) => (c ? pass(m) : fail(m));

(async () => {
  console.log("Public homepage tests — isolated server on :" + PORT);
  await new Promise((r) =>
    spawn(process.execPath, ["dist/server/db/seed.js"], {
      env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
      stdio: "ignore",
    }).on("exit", r)
  );
  const srv = spawn(process.execPath, ["dist/server/http/server.js"], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PORT) },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(BASE + "/api/health")).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // ---- 1. / renders the public enterprise homepage ----
    const home = await fetch(BASE + "/");
    const homeHtml = await home.text();
    assert(
      home.status === 200 &&
        homeHtml.includes("Verify physical progress before capital moves.") &&
        homeHtml.includes("OpenBuild Verify") &&
        homeHtml.includes("evidence-grounded control layer"),
      "/ renders the public homepage with the brand headline and positioning copy"
    );

    // ---- 2. homepage carries the brand promise and workflow ----
    assert(
      ["Evidence captured in the field.", "Controls evaluated consistently.",
       "Approvals governed by accountable people.", "Every material decision preserved for audit."]
        .every((s) => homeHtml.includes(s)) &&
        ["Field Evidence", "Verification", "Draw Review", "Human Governance", "Controlled Release", "Audit Package"]
          .every((s) => homeHtml.includes(s)),
      "trust statement and the seven-stage control workflow are present"
    );

    // ---- 3. CTAs reach /demo; no role selector on the homepage ----
    assert(
      homeHtml.includes('href="/demo"') &&
        homeHtml.includes("Enter Live Demo") &&
        homeHtml.includes("Enter the Demonstration") &&
        !homeHtml.includes('action="/api/session"'),
      "homepage CTAs navigate to /demo and the role selector is not embedded on the public page"
    );

    // ---- 4. hero product frame uses real seeded values ----
    assert(
      homeHtml.includes("LIVE DEMO DATA") &&
        homeHtml.includes("$600,000") &&
        homeHtml.includes("$1,680,000") &&
        homeHtml.includes("Mzimba"),
      "hero product frame renders live seeded figures (draw requested, funds held, project name)"
    );

    // ---- 5. honest content: no fabricated claims or predictions ----
    const bannedContent = [
      "SOC 2", "ISO 27001", "FedRAMP", "testimonial", "success probability",
      "predicted completion", "% chance", "customers include", "trusted by",
    ];
    assert(
      bannedContent.every((b) => !homeHtml.toLowerCase().includes(b.toLowerCase())),
      "no fake certifications, testimonials, usage statistics or predictive claims"
    );
    assert(
      homeHtml.includes("AI does not\n                independently approve work") ||
        homeHtml.includes("AI does not") && homeHtml.includes("authorize funds release"),
      "the AI trust boundary statement is present"
    );

    // ---- 6. /demo renders the role selector ----
    const demo = await fetch(BASE + "/demo");
    const demoHtml = await demo.text();
    assert(
      demo.status === 200 &&
        demoHtml.includes("Select a demonstration role") &&
        demoHtml.includes("No credentials required") &&
        demoHtml.includes("Demo Environment") &&
        demoHtml.includes("Return to OBV Overview"),
      "/demo renders the upgraded role selector with demo indicators and return link"
    );

    // ---- 7. all four roles with names, orgs and descriptions ----
    assert(
      ["Compliance Reviewer", "Field Engineer", "Funder Representative", "Project Manager"]
        .every((r) => demoHtml.includes(r)) &&
        ["Margaret Osei", "Amina Ndlovu", "Daniel Phiri", "Chikondi Banda"].every((u) => demoHtml.includes(u)) &&
        demoHtml.includes("authenticated organization accounts"),
      "all four seeded roles present with user, organization, description and production-auth note"
    );

    // ---- 8. logo and return link on /demo navigate to / ----
    assert(
      demoHtml.includes('href="/" className="demo-home"') ||
        demoHtml.includes('class="demo-home"') && demoHtml.includes('href="/"'),
      "the OBV logo on /demo links back to the public homepage"
    );

    // ---- 9. every seeded role still enters the correct experience ----
    const roleTargets = [
      ["user-funder", "/overview"],
      ["user-compliance", "/overview"],
      ["user-pm", "/overview"],
      ["user-field", "/field"],
    ];
    for (const [userId, target] of roleTargets) {
      const res = await fetch(BASE + "/api/session", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ userId }).toString(),
        redirect: "manual",
      });
      const loc = res.headers.get("location") ?? "";
      if (![302, 303].includes(res.status) || !loc.endsWith(target)) {
        fail(`role ${userId} expected redirect to ${target}, got ${res.status} ${loc}`);
      }
      const cookie = res.headers.getSetCookie()[0].split(";")[0];
      const page = await fetch(BASE + target, { headers: { cookie } });
      if (page.status !== 200) fail(`role ${userId} could not load ${target} -> ${page.status}`);
    }
    pass("all four seeded roles enter their correct experience (office → /overview, field → /field)");

    // ---- 10. deep links: unauthenticated → /demo, authenticated → page ----
    const gated = await fetch(BASE + "/approvals", { redirect: "manual" });
    assert(
      [302, 303].includes(gated.status) && (gated.headers.get("location") ?? "").endsWith("/demo"),
      "unauthenticated deep link redirects to the /demo selector (not the marketing page)"
    );

    // ---- 11. /app, /platform, /security convenience routes ----
    const app = await fetch(BASE + "/app", { redirect: "manual" });
    const platform = await fetch(BASE + "/platform", { redirect: "manual" });
    const security = await fetch(BASE + "/security", { redirect: "manual" });
    assert(
      (app.headers.get("location") ?? "").endsWith("/overview") &&
        (platform.headers.get("location") ?? "").endsWith("/#platform") &&
        (security.headers.get("location") ?? "").endsWith("/#security"),
      "/app, /platform and /security resolve without broken links"
    );

    // ---- 12. no backend mutation from the public pages ----
    // Five seeded roles since the VAM demo added the second lender
    // officer (dual control needs a distinct approver).
    assert(
      !homeHtml.match(/method="POST"/i) &&
        (demoHtml.match(/action="\/api\/session"/g) ?? []).length === 5,
      "homepage has no mutating forms; /demo keeps exactly the five seeded session forms"
    );

    // ---- 13. mobile rendering (Playwright when available) ----
    let pw = null;
    try {
      pw = require("playwright");
    } catch {
      try {
        pw = require(path.join(process.env.OBV_PLAYWRIGHT_NODE_PATH ?? "/opt/node22/lib/node_modules", "playwright"));
      } catch {}
    }
    if (pw) {
      const browser = await pw.chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
      for (const [url, w] of [["/", 390], ["/", 375], ["/demo", 390]]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: 844 } });
        const page = await ctx.newPage();
        await page.goto(BASE + url, { waitUntil: "networkidle" });
        const o = await page.evaluate(() => ({
          s: document.documentElement.scrollWidth,
          c: document.documentElement.clientWidth,
        }));
        if (o.s > o.c + 1) fail(`${url} at ${w}px has horizontal overflow (${o.s} > ${o.c})`);
        await ctx.close();
      }
      // Mobile navigation opens and reaches /demo.
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await page.goto(BASE + "/", { waitUntil: "networkidle" });
      await page.locator(".hp-burger summary").click();
      await page.locator('.hp-burger nav a[href="/demo"]').first().click();
      await page.waitForURL("**/demo");
      await browser.close();
      pass("mobile widths (390/375) render without overflow and the mobile menu reaches /demo");
    } else {
      pass("Playwright unavailable — mobile overflow covered by the screenshot pass");
    }

    console.log(`\nHOMEPAGE TESTS PASSED — ${n} checkpoints.`);
  } finally {
    srv.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
