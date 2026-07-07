/**
 * Spatial map tests — 12 checkpoints against an isolated server.
 *
 *   node scripts/map-test.js     (requires global playwright via NODE_PATH)
 *
 * Tile IMAGES may not load in a sandboxed environment (no egress to the
 * public tile services) — the tests assert the correct tile URLs are
 * requested and that geometry/markers/panels work regardless, which is
 * exactly the engine's offline behavior.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3160;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-map-"));

let n = 0;
const pass = (m) => console.log(`  ✓ [${++n}] ${m}`);
const fail = (m) => {
  // Throw (never process.exit) so the finally block kills the spawned
  // server — a direct exit leaves a zombie on the port for the next run.
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (c, m) => (c ? pass(m) : fail(m));

(async () => {
  console.log("Map tests — isolated server on :" + PORT);
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
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(BASE + "/api/health")).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
    const page = await ctx.newPage();
    await page.request.post(BASE + "/api/session", { form: { userId: "user-funder" } });

    // 1. Map page loads.
    await page.goto(BASE + "/map", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".geo-boundary", { timeout: 10000 });
    assert(await page.locator("h1, h2").filter({ hasText: "Project Map" }).count() > 0 ||
      (await page.title()).includes("Project Map"), "map page loads");

    // 2. Standard tiles requested from OpenStreetMap.
    const osmTiles = await page.locator('.tile[src*="tile.openstreetmap.org"]').count();
    assert(osmTiles > 0, `standard tile layer requested (${osmTiles} OSM tiles)`);

    // 3. Satellite mode requests Esri World Imagery tiles.
    await page.click("#layer-sat");
    await page.waitForTimeout(400);
    const satTiles = await page.locator('.tile[src*="World_Imagery"]').count();
    assert(satTiles > 0, `satellite layer requested (${satTiles} Esri tiles)`);
    await page.click("#layer-map");

    // 4. Project boundary renders.
    assert((await page.locator(".geo-boundary").count()) === 1, "project boundary polygon renders");

    // 5. Evidence markers appear (seeded M1 + M2 evidence).
    assert((await page.locator(".geo-marker").count()) === 2, "both seeded evidence markers appear");

    // 6. Marker state matches verification verdict (VERIFIED tone).
    const fills = await page.locator(".geo-marker .dot").evaluateAll((els) => els.map((e) => e.getAttribute("fill")));
    assert(fills.every((f) => f === "#196138"), "marker color matches VERIFIED verdict");

    // 7. Evidence panel data is correct.
    await page.locator(".geo-marker").first().click();
    const panel = await page.locator("#map-panel-body").innerText();
    assert(
      /VERIFIED/.test(panel) && /Chikondi Banda/.test(panel) && /entry #/.test(panel) && /Confidence/i.test(panel),
      "evidence panel shows verdict, captured-by, confidence and ledger reference"
    );

    // 8. Milestone segment states match milestone records.
    const strokes = await page.locator(".geo-segment").evaluateAll((els) => els.map((e) => e.getAttribute("stroke")));
    assert(strokes.length === 5, "five milestone segments render");
    assert(
      strokes.filter((s) => s === "#196138").length === 2 && // M1, M2 released (green)
        strokes.filter((s) => s === "#1d3fad").length === 1 && // M3 awaiting evidence (blue)
        strokes.filter((s) => s === "#6a7280").length === 2, // M4, M5 not started (slate)
      "segment colors match milestone states (2 released, 1 awaiting evidence, 2 not started)"
    );
    assert(
      (await page.locator(".geo-casing").count()) === 5,
      "every segment has a light casing for satellite readability"
    );

    // Inset legend: visible, only currently-present states, boundary entry.
    const legend = await page.locator("#legend-body").innerText();
    assert(
      legend.includes("Released") &&
        legend.includes("Awaiting Evidence") &&
        legend.includes("Not Started") &&
        legend.includes("Project boundary") &&
        !legend.includes("Rejected"),
      "inset legend lists only present states plus the project boundary"
    );

    // Executive corridor summary from seeded demo km labels.
    const summary = await page.locator("#map-summary").innerText();
    assert(
      summary.includes("7 km") && summary.includes("4 km") && summary.includes("3 km"),
      "corridor summary shows 7 km verified · 4 km awaiting evidence · 3 km not started"
    );

    // Degraded base map is honest: tiles either load or the restrained
    // notice appears (in this sandbox tile hosts are unreachable). Tile
    // fetch outcomes can take a few seconds — poll for the settled state.
    let degradedHonest = false;
    for (let i = 0; i < 30 && !degradedHonest; i++) {
      const noteVisible = await page.locator("#map-note").isVisible();
      const loadedTiles = await page
        .locator(".tile")
        .evaluateAll((els) => els.filter((e) => e.complete && e.naturalWidth > 0).length);
      degradedHonest = noteVisible || loadedTiles > 0;
      if (!degradedHonest) await page.waitForTimeout(400);
    }
    assert(degradedHonest, "tile failure shows the geometry-still-available notice (or tiles loaded)");

    // Segment panel content (pending area shows evidence/governance still
    // required). Click a point ON the polyline (bbox centers of bent paths
    // fall off the stroke).
    const segPoint = await page.locator(".geo-hit").nth(2).evaluate((el) => {
      const p = el.getPointAtLength(el.getTotalLength() / 2);
      const r = el.ownerSVGElement.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    });
    await page.mouse.click(segPoint.x, segPoint.y);
    const segPanel = await page.locator("#map-panel-body").innerText();
    assert(
      /AWAITING EVIDENCE/.test(segPanel) && /\$600,000/.test(segPanel) && /km 7–11/.test(segPanel),
      "pending segment panel shows awaiting-evidence state, tranche and demo km label"
    );
    assert(
      segPanel.includes("Submit field evidence"),
      "pending segment panel shows the next required action"
    );

    // 9. Verdict filter works.
    await page.selectOption("#flt-verdict", "NEEDS_REVIEW");
    assert((await page.locator(".geo-marker").count()) === 0, "verdict filter hides non-matching markers");
    await page.selectOption("#flt-verdict", "all");
    assert((await page.locator(".geo-marker").count()) === 2, "clearing the filter restores markers");

    // 10. Mobile interaction: clean first paint, compact filters, inset
    //     legend, bottom-sheet inspector, no horizontal overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" }); // re-fit view to the mobile canvas
    await page.waitForSelector(".geo-marker");
    assert(
      !(await page.locator("#map-panel.open").count()),
      "mobile boot keeps the map clean (no auto-opened sheet)"
    );
    const legendInView = await page.evaluate(() => {
      const r = document.getElementById("map-legend").getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && window.scrollY === 0;
    });
    assert(legendInView, "legend is visible inside the viewport without scrolling");
    await page.click("#flt-btn");
    assert(await page.locator("#map-filters.open").isVisible(), "Filters button opens the mobile filter sheet");
    await page.selectOption("#flt-verdict", "VERIFIED");
    assert((await page.locator("#flt-btn").innerText()).includes("1 active"), "filter button shows active count");
    await page.selectOption("#flt-verdict", "all");
    await page.click("#flt-close");
    await page.locator(".geo-marker").last().click();
    assert(await page.locator("#map-panel.open").isVisible(), "mobile marker tap opens the details sheet");
    assert(
      (await page.locator("#map-panel-body").innerText()).length > 0 &&
        (await page.locator('#map-panel-body :text("Open thread")').count()) > 0,
      "evidence sheet offers Open thread"
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    assert(overflow === 0, "no horizontal overflow at 390px");

    // 11. Cross-link to the evidence record works.
    await page.locator('#map-panel-body a:has-text("View evidence")').click();
    await page.waitForURL(/\/milestone\/ms-/);
    assert(/\/milestone\/ms-/.test(page.url()), "View evidence navigates to the full evidence record");

    // 12. No map token/secret leakage.
    const mapJs = await (await fetch(BASE + "/js/map.js")).text();
    const mapHtml = await (await page.request.get(BASE + "/map")).text();
    assert(
      !/token=|apikey|api_key|access_token/i.test(mapJs) && !/token=|apikey|access_token/i.test(mapHtml),
      "no map tokens or secrets in client code or page (token-free providers)"
    );

    console.log(`\nMAP TESTS PASSED — ${n} checkpoints.\n`);
  } finally {
    await browser.close();
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
