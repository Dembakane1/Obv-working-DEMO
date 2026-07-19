/**
 * Screenshot harness — captures full-page screenshots of primary routes.
 * Usage: node scripts/shots.js <outDir> [routesCsv] [widthsCsv]
 * Signs in as a funder representative via /api/session (demo).
 */
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.BASE || "http://localhost:3000";
const OUT = process.argv[2] || "shots";
const ROUTES = (process.argv[3] ||
  "/overview,/projects,/approvals,/draws,/compliance,/issues,/exceptions,/ledger,/insights,/change-orders,/budget,/reports,/communications,/setup,/pilot,/more,/map"
).split(",");
const SIZES = (process.argv[4] || "1440x900,390x844,768x1024")
  .split(",")
  .map((s) => s.split("x").map(Number));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const userId = process.env.SHOT_USER || "user-funder";
  for (const [w, hgt] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: hgt } });
    const res = await ctx.request.post(`${BASE}/api/session`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: `userId=${userId}`,
      maxRedirects: 0,
    });
    if (res.status() >= 400) console.error("session sign-in failed", res.status());
    const page = await ctx.newPage();
    for (const route of ROUTES) {
      try {
        await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 20000 });
        await page.waitForTimeout(350);
        const name = route === "/" ? "home" : route.replace(/^\//, "").replace(/[/?=]/g, "-");
        await page.screenshot({ path: path.join(OUT, `${name}-${w}.png`), fullPage: true });
        // overflow assertion data
        const sw = await page.evaluate(
          () => [document.documentElement.scrollWidth, document.documentElement.clientWidth]
        );
        if (sw[0] > sw[1] + 1) console.log(`OVERFLOW ${route} @${w}: scrollWidth ${sw[0]} > clientWidth ${sw[1]}`);
      } catch (e) {
        console.log(`ERROR ${route} @${w}: ${e.message.split("\n")[0]}`);
      }
    }
    await ctx.close();
  }
  await browser.close();
  console.log("done → " + OUT);
})();
