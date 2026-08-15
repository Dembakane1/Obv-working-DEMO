const { chromium } = require("playwright");
const BASE = "http://localhost:3421";
const OUT = "/tmp/claude-0/-home-user-Obv-working-DEMO/20d6e833-b756-5696-ac52-52cf3226940f/scratchpad/shots";
const PAGES = [
  ["projects", "/projects"], ["project-detail", "/project/proj-r47"],
  ["evidence-review", "/compliance"], ["ledger", "/ledger"],
  ["approvals", "/approvals"], ["exceptions", "/exceptions"],
  ["budget", "/budget"], ["change-orders", "/change-orders"], ["reports", "/reports"],
];
(async () => {
  const browser = await chromium.launch();
  const res = await fetch(`${BASE}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "user-funder" }), redirect: "manual" });
  const [cn, cv] = res.headers.getSetCookie()[0].split(";")[0].split("=");
  for (const [vp, w, h] of [["1440", 1440, 900], ["390", 390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
    const page = await ctx.newPage();
    for (const [slug, p] of PAGES) {
      await page.goto(BASE + p, { waitUntil: "networkidle" });
      const m = await page.evaluate(() => ({
        o: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        h: document.body.scrollHeight,
      }));
      console.log(`${vp.padEnd(5)} ${slug.padEnd(16)} overflow=${m.o} page=${m.h}px`);
      await page.screenshot({ path: `${OUT}/done-${slug}-${vp}.png` });
    }
    await ctx.close();
  }
  // light theme spot check
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: cn, value: cv, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem("obv-theme", "light"));
  await page.goto(BASE + "/projects", { waitUntil: "networkidle" });
  await page.screenshot({ path: `${OUT}/done-projects-light-1440.png` });
  console.log("light theme spot check captured");
  await browser.close();
})();
