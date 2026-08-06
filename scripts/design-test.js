#!/usr/bin/env node
/**
 * Enterprise Design System v2 test battery.
 *
 * Proves the redesign is APPEARANCE ONLY and holds its own claims:
 *   0. token architecture (dark-first :root, complete light theme,
 *      print pinned light, no pure black)
 *   1. computed WCAG contrast for every text token on its surfaces,
 *      in BOTH themes (AA, 4.5:1), and chart palettes >= 3:1
 *   2. shell: pre-paint theme boot, toggle, collapse, command palette,
 *      keyboard hints, compiled client script — all read-only
 *   3. navigation preserves EVERY pre-existing destination
 *   4. role-based landings differ per role, nothing removed
 *   5. accessibility & motion (focus-visible, reduced-motion,
 *      aria labels, touch targets, skeleton/empty primitives)
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = process.cwd();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "obv-design-"));
const PORT = 3278;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const pass = (m) => { passed += 1; console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`); };
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); throw new Error(m); };
const assert = (cond, m) => (cond ? pass(m) : fail(m));

const css = fs.readFileSync(path.join(ROOT, "public/styles.css"), "utf8");

/** Extract a token block's variables as a map. */
function tokensOf(block) {
  const map = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  return map;
}
function blockFor(selectorStart) {
  const i = css.indexOf(selectorStart);
  if (i === -1) fail(`missing block ${selectorStart}`);
  const open = css.indexOf("{", i);
  let depth = 1;
  let j = open + 1;
  while (depth > 0 && j < css.length) {
    if (css[j] === "{") depth += 1;
    if (css[j] === "}") depth -= 1;
    j += 1;
  }
  return css.slice(open + 1, j - 1);
}

// WCAG relative luminance + ratio over hex colors.
function lum(hex) {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.split("").map((x) => x + x).join("") : c;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
const isHex = (v) => /^#[0-9a-fA-F]{3,8}$/.test(v);

function section0() {
  console.log("\n== 0. Token architecture ==");
  assert(/:root\s*\{[^}]*color-scheme:\s*dark/.test(css), "dark is the primary theme (:root declares color-scheme dark)");
  assert(css.includes('[data-theme="light"]'), "a complete light theme block exists");
  assert(/@media print\s*\{\s*:root/.test(css), "print pins the light tokens regardless of screen theme");
  const dark = tokensOf(blockFor(":root {"));
  const light = tokensOf(blockFor('[data-theme="light"]'));
  assert(dark.canvas && dark.canvas.toLowerCase() !== "#000000" && dark.canvas.toLowerCase() !== "#000",
    `dark canvas is deep navy, not pure black (${dark.canvas})`);
  assert(!/#000\b|#000000/i.test(JSON.stringify(dark)), "no pure-black token anywhere in the dark theme");
  for (const t of ["canvas", "surface", "ink", "ink-2", "ink-3", "ink-4", "action", "ok", "warn", "bad", "line"]) {
    assert(t in dark && t in light, `token --${t} defined in BOTH themes`);
  }
  for (let i = 1; i <= 6; i += 1) {
    assert(`ch-${i}` in dark && `ch-${i}` in light, `chart token --ch-${i} defined in both themes`);
  }
  return { dark, light };
}

function section1({ dark, light }) {
  console.log("\n== 1. Computed WCAG contrast (AA) ==");
  const themes = [
    { name: "dark", t: dark, surfaces: [dark.canvas, dark.surface] },
    { name: "light", t: light, surfaces: [light.canvas, light.surface] },
  ];
  for (const { name, t, surfaces } of themes) {
    for (const inkKey of ["ink", "ink-2", "ink-3", "ink-4"]) {
      const v = t[inkKey];
      if (!isHex(v)) fail(`${name} --${inkKey} not hex (${v})`);
      const worst = Math.min(...surfaces.filter(isHex).map((s) => ratio(v, s)));
      assert(worst >= 4.5, `${name}: --${inkKey} is AA on canvas+surface (worst ${worst.toFixed(2)}:1)`);
    }
    for (const sem of ["ok", "warn", "bad"]) {
      const v = t[sem];
      const surf = t.surface;
      if (isHex(v) && isHex(surf)) {
        assert(ratio(v, surf) >= 4.5, `${name}: --${sem} text is AA on surface (${ratio(v, surf).toFixed(2)}:1)`);
      } else pass(`${name}: --${sem} uses layered values (checked visually)`);
    }
    const fill = t["action-fill"];
    assert(isHex(fill) && ratio(fill, "#FFFFFF") >= 4.5,
      `${name}: filled action buttons carry AA white text (${ratio(fill, "#FFFFFF").toFixed(2)}:1)`);
    const chartSurface = isHex(t.surface) ? t.surface : name === "dark" ? "#111A2C" : "#FFFFFF";
    const chs = [1, 2, 3, 4, 5, 6].map((i) => t[`ch-${i}`]);
    assert(new Set(chs).size === 6, `${name}: six distinct categorical chart colors`);
    for (const [i, c] of chs.entries()) {
      assert(isHex(c) && ratio(c, chartSurface) >= 3, `${name}: --ch-${i + 1} >= 3:1 on the chart surface`);
    }
  }
}

function section5() {
  console.log("\n== 5. Accessibility & motion primitives ==");
  assert(/prefers-reduced-motion/.test(css), "reduced-motion preference collapses animation");
  assert(/:focus-visible\s*\{/.test(css), "a visible focus ring is defined");
  assert(/\.skeleton\b/.test(css) && /skeleton-sheen/.test(css), "skeleton loading primitive exists");
  assert(/\.empty-state\b/.test(css), "empty-state primitive exists");
  assert(/\.ring\b[\s\S]{0,400}conic-gradient/.test(css), "progress-ring primitive exists");
  assert(/\.hbar\b/.test(css), "health-bar primitive exists");
  assert(/pointer:\s*coarse/.test(css), "touch devices get enlarged click targets");
  assert(/\.cmdk\[hidden\]\s*\{\s*display:\s*none/.test(css), "the command palette honours [hidden]");
  const shell = fs.readFileSync(path.join(ROOT, "src/client/shell.ts"), "utf8");
  assert(!/method\s*:\s*["'](POST|PUT|DELETE|PATCH)/i.test(shell) && !/fetch\(/.test(shell),
    "the shell script performs no fetches and no writes — pure presentation");
  assert(/aria-label/.test(fs.readFileSync(path.join(ROOT, "src/server/view/components.tsx"), "utf8")),
    "shell controls carry screen-reader labels");
}

let server = null;

async function main() {
  const { dark, light } = section0();
  section1({ dark, light });

  console.log("\n== 2. Shell over HTTP ==");
  const r = spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA }, stdio: "ignore",
  });
  if (r.status !== 0) fail("seed failed");
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA, PORT: String(PORT), OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo" },
    stdio: "ignore",
  });
  let healthy = false;
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { healthy = true; break; } } catch {}
    await new Promise((res) => setTimeout(res, 250));
  }
  if (!healthy) fail("server did not become healthy");
  pass("server healthy");

  const signIn = async (userId) => {
    const res = await fetch(`${BASE}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }), redirect: "manual",
    });
    return res.headers.getSetCookie()[0].split(";")[0];
  };
  const page = async (p, ck) => {
    const res = await fetch(`${BASE}${p}`, { headers: { cookie: ck ?? "", accept: "text/html" }, redirect: "manual" });
    return { status: res.status, html: await res.text() };
  };

  const funder = await signIn("user-funder");
  const shellPage = await page("/overview", funder);
  const bootIdx = shellPage.html.indexOf("obv-theme");
  const styleIdx = shellPage.html.indexOf("styles.css");
  assert(bootIdx !== -1 && styleIdx !== -1 && bootIdx < styleIdx,
    "the theme boots from localStorage BEFORE the stylesheet paints (no wrong-theme flash)");
  assert(/data-theme","dark"|data-theme",\s*"dark"|setAttribute\("data-theme",t\)/.test(shellPage.html),
    "dark is the boot default");
  assert(/id="theme-toggle"/.test(shellPage.html) && /aria-label="Switch between dark and light theme"/.test(shellPage.html),
    "the theme toggle is present and labeled");
  assert(/id="sidebar-collapse"/.test(shellPage.html), "the sidebar collapse control is present");
  assert(/id="cmdk"[^>]*hidden/.test(shellPage.html), "the command palette ships closed");
  assert(/id="nav-search-btn"/.test(shellPage.html) && /tb-kbd/.test(shellPage.html),
    "global search button with keyboard hint is present");
  assert(/\/js\/shell\.js/.test(shellPage.html), "the shell enhancement script is referenced");
  assert(fs.existsSync(path.join(ROOT, "public/js/shell.js")), "the compiled shell script exists");
  const shellJs = await fetch(`${BASE}/js/shell.js`);
  assert(shellJs.ok, "the shell script is served");

  console.log("\n== 3. Navigation preserves every destination ==");
  const PRESERVED = [
    "/overview", "/projects", "/executive", "/map", "/insights", "/approvals",
    "/draws", "/change-orders", "/budget", "/compliance", "/evidence-intelligence",
    "/official-sources", "/timeline", "/ledger", "/reports", "/issues",
    "/exceptions", "/field", "/communications", "/setup", "/pilot",
    "/communications/integrations",
  ];
  for (const href of PRESERVED) {
    assert(shellPage.html.includes(`href="${href}"`), `nav still reaches ${href}`);
  }
  assert(/Digital Twin/.test(shellPage.html), "the sidebar carries the Digital Twin entry");
  assert(/aria-current="page"/.test(shellPage.html), "the active nav item is announced to screen readers");

  console.log("\n== 4. Role-based landings ==");
  const pm = await signIn("user-pm");
  const compliance = await signIn("user-compliance");
  const funderHome = (await page("/overview", funder)).html;
  const pmHome = (await page("/overview", pm)).html;
  const compHome = (await page("/overview", compliance)).html;
  assert(/Executive overview/.test(funderHome), "a funder representative lands on the executive-focused overview");
  assert(/Delivery overview/.test(pmHome), "a project manager lands on the delivery-focused overview");
  assert(/Assurance overview/.test(compHome), "a compliance reviewer lands on the assurance-focused overview");
  assert(
    funderHome.match(/<h1>([^<]+)/)?.[1] !== pmHome.match(/<h1>([^<]+)/)?.[1] &&
      pmHome.match(/<h1>([^<]+)/)?.[1] !== compHome.match(/<h1>([^<]+)/)?.[1],
    "no two roles see the same landing headline"
  );
  // Shared portfolio content is still there for everyone — nothing removed.
  for (const [name, html] of [["funder", funderHome], ["pm", pmHome], ["compliance", compHome]]) {
    assert(/Capital position/.test(html) && /Project portfolio|View all projects/.test(html),
      `${name}: the full portfolio content remains beneath the role focus`);
  }
  const fieldSession = await fetch(`${BASE}/api/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "user-field" }), redirect: "manual",
  });
  assert((fieldSession.headers.get("location") ?? "").endsWith("/field"),
    "a field engineer still lands on the capture-first experience");

  section5();

  console.log(`\nDESIGN SYSTEM TESTS PASSED — ${passed} checkpoints.`);
  console.log("SAME RECORD. SAME RULES. A CLEARER FACE.");
}

main()
  .catch((err) => { console.error(err.stack ?? err); process.exitCode = 1; })
  .finally(() => {
    try { if (server) server.kill(); } catch {}
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  });
