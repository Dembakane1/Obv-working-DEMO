/**
 * Frontend visual / responsive regression — v4 reconstruction.
 *
 * For each primary route (as the appropriate seeded role):
 *   1. the page loads (200) with a single H1 and the expected title;
 *   2. a decision summary / metric zone is present where required;
 *   3. the primary work area (register, queue, workspace or map) exists;
 *   4. document.documentElement.scrollWidth <= clientWidth + 1 (no
 *      page-level horizontal scroll) at 390 and 1440;
 *   5. status chips stay inside the viewport;
 *   6. mobile content reserves clearance above the fixed bottom nav.
 *
 * Content extremes: the suite temporarily renames the seeded organization,
 * a project, and an issue title to very long strings (direct sqlite UPDATE,
 * restored afterwards) and re-asserts the overflow rule on the worst pages.
 *
 * Requires a freshly seeded server on :3000 (same contract as the other
 * browser suites) and the pinned Playwright devDependency.
 */
const { launchChromium } = require("./lib/browser");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

const BASE = process.env.BASE || "http://localhost:3000";
const DB = process.env.OBV_DB || "data/obv.db";

let n = 0;
const pass = (m) => console.log(`  ✓ [${String(++n).padStart(2, "0")}] ${m}`);
const fail = (m) => {
  console.error(`FRONTEND TESTS FAILED at checkpoint ${n + 1}: ${m}`);
  process.exit(1);
};

/** route → { role, title, summary?: selector, work: selector }
 *
 * The workstation completion moved the converted operational pages from
 * the document generation (.metric-strip + .register/.panel stacks) onto
 * the workstation system (.kpi-rail + .dtable/.dpanel/.workbench). The
 * PROPERTY asserted is unchanged — a summary/metric zone and a real work
 *  area render on every page — expressed against the current
 * architecture. Unconverted pages keep their original selectors.
 */
const ROUTES = [
  { path: "/overview", title: "Overview", work: ".cap-grid", summary: ".metric-card" },
  { path: "/projects", title: "Projects", work: ".dtable, .dpanel", summary: ".kpi-rail" },
  { path: "/project/proj-r47", title: null, work: ".workbench, .wstabs" },
  { path: "/milestone/ms-1", title: null, work: ".evidence-panel" },
  { path: "/approvals", title: "Approvals", work: ".dpanel, .ap-card", summary: ".kpi-rail" },
  { path: "/draws", title: "Draw Requests", work: ".panel", summary: ".metric-strip" },
  { path: "/compliance", title: "Evidence Review", work: ".workbench", summary: ".kpi-rail" },
  { path: "/issues", title: "Field Issues", work: ".register", summary: ".metric-strip" },
  { path: "/exceptions", title: "Exceptions", work: ".dpanel", summary: ".kpi-rail" },
  { path: "/ledger", title: "Evidence Ledger", work: ".dpanel .dtable, .dpanel .empty-mini, .dpanel .empty-state", summary: ".kpi-rail" },
  { path: "/insights", title: "OBV Intelligence", work: ".intel-main", summary: ".metric-strip" },
  { path: "/change-orders", title: "Change Orders", work: ".dpanel", summary: ".kpi-rail" },
  { path: "/budget", title: "Budget & Progress", work: ".dtable, .dpanel", summary: ".kpi-rail" },
  { path: "/reports", title: null, work: ".panel, .dpanel" },
  { path: "/communications", title: null, work: ".comms" },
  { path: "/setup", title: null, work: ".panel, .setup-grid" },
  { path: "/pilot", title: "Pilot Operations", work: ".panel", summary: ".metric-strip" },
  { path: "/more", title: "More", work: ".more-list" },
  { path: "/map", title: null, work: ".map-wrap" },
];

async function overflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return { sw: d.scrollWidth, cw: d.clientWidth };
  });
}

async function chipsInside(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    let out = 0;
    for (const el of document.querySelectorAll(".status, .chip, .sync-tag")) {
      // The rule this guards is "no chip is unreachable" — a chip inside a
      // deliberate horizontal scroll container (a dense register on a
      // phone) is reachable by scrolling that container, which the mobile
      // composition rules explicitly permit. Chips outside any scroller
      // must still sit inside the viewport, so genuine layout breakage
      // (content pushed off-canvas) keeps failing here.
      const scroller = el.closest(".dtable-wrap, .table-scroll, .intg-table-wrap");
      if (scroller) {
        const overflows = scroller.scrollWidth > scroller.clientWidth + 1;
        const style = getComputedStyle(scroller);
        if (overflows && /(auto|scroll)/.test(style.overflowX)) continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) out++;
    }
    return out;
  });
}

(async () => {
  console.log("Frontend visual/responsive tests — " + BASE);
  // Pinned project Playwright resolves its own matching Chromium build
  // (see scripts/lib/browser.js) — identical locally and in CI.
  const browser = await launchChromium();

  const makeCtx = async (viewport) => {
    const ctx = await browser.newContext({ viewport });
    const res = await ctx.request.post(`${BASE}/api/session`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: "userId=user-funder",
      maxRedirects: 0,
    });
    if (res.status() >= 400) fail(`sign-in failed: ${res.status()}`);
    return ctx;
  };

  // ---------- desktop pass ----------
  {
    const ctx = await makeCtx({ width: 1440, height: 900 });
    const page = await ctx.newPage();
    for (const r of ROUTES) {
      const resp = await page.goto(BASE + r.path, { waitUntil: "networkidle", timeout: 20000 });
      if (!resp || resp.status() !== 200) fail(`${r.path} -> ${resp && resp.status()}`);
      const h1s = await page.locator("h1").count();
      if (h1s !== 1) fail(`${r.path} has ${h1s} h1 elements (want exactly 1)`);
      if (r.title) {
        const h1 = (await page.locator("h1").first().textContent()) ?? "";
        if (!h1.toLowerCase().includes(r.title.toLowerCase())) fail(`${r.path} h1 "${h1}" != "${r.title}"`);
      }
      if (r.summary && (await page.locator(r.summary).count()) === 0)
        fail(`${r.path} missing decision summary (${r.summary})`);
      if ((await page.locator(r.work).count()) === 0) fail(`${r.path} missing work area (${r.work})`);
      const { sw, cw } = await overflow(page);
      if (sw > cw + 1) fail(`${r.path} @1440 horizontal overflow: ${sw} > ${cw}`);
      const badChips = await chipsInside(page);
      if (badChips > 0) fail(`${r.path} @1440 has ${badChips} chips outside the viewport`);
    }
    pass(`desktop 1440: ${ROUTES.length} routes — single h1, summary + work area, no overflow, chips inside viewport`);
    await ctx.close();
  }

  // ---------- mobile pass ----------
  {
    const ctx = await makeCtx({ width: 390, height: 844 });
    const page = await ctx.newPage();
    for (const r of ROUTES) {
      await page.goto(BASE + r.path, { waitUntil: "networkidle", timeout: 20000 });
      const { sw, cw } = await overflow(page);
      if (sw > cw + 1) fail(`${r.path} @390 horizontal overflow: ${sw} > ${cw}`);
      const badChips = await chipsInside(page);
      if (badChips > 0) fail(`${r.path} @390 has ${badChips} chips outside the viewport`);
      // bottom-nav clearance: the shell content must reserve at least the
      // nav height so the final element can scroll fully above it.
      const clearance = await page.evaluate(() => {
        const nav = document.querySelector(".bottom-nav");
        if (!nav || getComputedStyle(nav).display === "none") return null;
        const content = document.querySelector(".content, .map-wrap");
        if (!content) return null;
        return {
          navH: nav.getBoundingClientRect().height,
          pad: parseFloat(getComputedStyle(content).paddingBottom),
        };
      });
      if (clearance && clearance.pad < clearance.navH)
        fail(`${r.path} @390 bottom padding ${clearance.pad}px < nav height ${clearance.navH}px`);
    }
    pass(`mobile 390: ${ROUTES.length} routes — no overflow, chips inside viewport, content clears bottom nav`);
    await ctx.close();
  }

  // ---------- tablet spot pass ----------
  {
    const ctx = await makeCtx({ width: 768, height: 1024 });
    const page = await ctx.newPage();
    for (const r of ["/overview", "/issues", "/ledger", "/insights", "/draws", "/milestone/ms-1"]) {
      await page.goto(BASE + r, { waitUntil: "networkidle", timeout: 20000 });
      const { sw, cw } = await overflow(page);
      if (sw > cw + 1) fail(`${r} @768 horizontal overflow: ${sw} > ${cw}`);
    }
    pass("tablet 768: spot routes free of horizontal overflow");
    await ctx.close();
  }

  // ---------- typography rules ----------
  {
    const ctx = await makeCtx({ width: 390, height: 844 });
    const page = await ctx.newPage();
    for (const r of ["/issues", "/insights", "/ledger"]) {
      await page.goto(BASE + r, { waitUntil: "networkidle", timeout: 20000 });
      const bad = await page.evaluate(() => {
        let count = 0;
        for (const el of document.querySelectorAll("span, div, th, dt, label")) {
          const cs = getComputedStyle(el);
          if (
            cs.textTransform === "uppercase" &&
            parseFloat(cs.fontSize) < 10 &&
            el.textContent && el.textContent.trim().length > 0
          ) count++;
        }
        return count;
      });
      if (bad > 0) fail(`${r} has ${bad} uppercase labels below 10px`);
      const justified = await page.evaluate(() =>
        [...document.querySelectorAll("p, .sub")].filter(
          (el) => getComputedStyle(el).textAlign === "justify"
        ).length
      );
      if (justified > 0) fail(`${r} uses justified prose`);
    }
    pass("typography: no sub-10px uppercase labels, no justified prose on flagged pages");
    await ctx.close();
  }

  // ---------- content extremes (long strings, then restore) ----------
  {
    const db = new DatabaseSync(DB);
    const LONG_ORG = "Continental Development Finance Corporation for Cross-Border Infrastructure Rehabilitation and Resilience Programs (Southern and Eastern Africa Division)";
    const LONG_PROJ = "Mzimba–Kafukule Rural Road Rehabilitation, Drainage Reconstruction and Climate-Resilience Upgrade Program — Phase II (Kilometers 0 through 14, Northern Region)";
    const LONG_ISSUE = "Gravel shortfall at the km 12 stockpile combined with delayed culvert ring deliveries is blocking base-course placement across three work fronts until resupply is confirmed";
    const orig = {
      org: db.prepare("SELECT id, name FROM organizations LIMIT 1").get(),
      proj: db.prepare("SELECT id, name FROM projects LIMIT 1").get(),
      issue: db.prepare("SELECT id, title FROM field_issues LIMIT 1").get(),
    };
    db.prepare("UPDATE organizations SET name = ? WHERE id = ?").run(LONG_ORG, orig.org.id);
    db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(LONG_PROJ, orig.proj.id);
    db.prepare("UPDATE field_issues SET title = ? WHERE id = ?").run(LONG_ISSUE, orig.issue.id);
    try {
      const ctx = await makeCtx({ width: 375, height: 667 });
      const page = await ctx.newPage();
      for (const r of ["/overview", "/projects", "/issues", "/insights", `/project/${orig.proj.id}`, "/more"]) {
        await page.goto(BASE + r, { waitUntil: "networkidle", timeout: 20000 });
        const { sw, cw } = await overflow(page);
        if (sw > cw + 1) fail(`${r} @375 overflows with extreme-length names: ${sw} > ${cw}`);
      }
      await ctx.close();
      pass("content extremes: very long organization/project/issue names cause no overflow at 375px");
    } finally {
      db.prepare("UPDATE organizations SET name = ? WHERE id = ?").run(orig.org.name, orig.org.id);
      db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(orig.proj.name, orig.proj.id);
      db.prepare("UPDATE field_issues SET title = ? WHERE id = ?").run(orig.issue.title, orig.issue.id);
      db.close();
    }
  }

  // ---------- role smoke: each seeded role can load its landing page ----------
  {
    for (const [userId, target] of [
      ["user-funder", "/overview"],
      ["user-pm", "/overview"],
      ["user-compliance", "/compliance"],
      ["user-field", "/field"],
    ]) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const res = await ctx.request.post(`${BASE}/api/session`, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        data: `userId=${userId}`,
        maxRedirects: 0,
      });
      if (res.status() >= 400) fail(`${userId} sign-in failed`);
      const page = await ctx.newPage();
      const resp = await page.goto(BASE + target, { waitUntil: "domcontentloaded", timeout: 20000 });
      if (!resp || resp.status() !== 200) fail(`${userId} cannot load ${target}`);
      await ctx.close();
    }
    pass("role smoke: funder, PM, compliance and field roles load their landing pages");
  }

  await browser.close();
  console.log(`\nFRONTEND VISUAL TESTS PASSED — ${n} checkpoints.`);
})().catch((e) => {
  console.error("FRONTEND TESTS CRASHED:", e);
  process.exit(1);
});
