#!/usr/bin/env node
/**
 * Workstation composition regression suite.
 *
 * Asserts the STRUCTURE of the reconstructed flagship surfaces — the
 * thing that made OBV look like a stack of document cards instead of an
 * operator console. These checkpoints are about composition, not colour:
 * panel grids, rails, dense tables, the split workspace, the inspector,
 * mobile-specific composition, and the doctrine-compression rule.
 *
 * They deliberately do NOT assert pixel values, so a later visual
 * refinement can proceed — but a regression back to "full-width card →
 * heading → paragraph → next card" fails here.
 */
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 3362;
const BASE = `http://localhost:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), "obv-workstation-"));

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

let server = null;
process.on("exit", () => {
  try { server?.kill(); } catch { /* already gone */ }
});

async function main() {
  console.log("Workstation composition suite — structure, not styling");

  // ============ 0. the primitives exist in the stylesheet ============
  const css = readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
  for (const cls of [".kpi-rail", ".dpanel", ".dtable", ".workbench", ".splitws", ".wstabs", ".about-view", ".slist"]) {
    assert(css.includes(cls), `stylesheet defines the ${cls} workstation primitive`);
  }
  assert(
    /\.content:has\(> \.ws\) \{[^}]*max-width: none/.test(css),
    "workstation surfaces are full-bleed (the centered document column does not apply)"
  );
  assert(
    /--sidebar-w: 208px/.test(css) && /--topbar-h: 46px/.test(css),
    "chrome is narrow: the sidebar and topbar do not dominate the work surface"
  );
  // The split workspace must be a 3-column grid on desktop, and the mobile
  // rules must HIDE the unselected mode rather than stack both panes.
  assert(
    /\.splitws \{[^}]*grid-template-columns: minmax\(0, 25fr\) minmax\(0, 52fr\) minmax\(0, 23fr\)/.test(css),
    "the split workspace is a 25/52/23 three-pane grid (stream | canvas | inspector)"
  );
  assert(
    /\.splitws\.mode-timeline > \.ws-canvas, \.splitws\.mode-twin > \.ws-stream \{ display: none/.test(css),
    "on small screens the selected mode owns the viewport — panes are never stacked"
  );
  assert(
    /@media \(max-width: 720px\)[\s\S]{0,900}\.kpi-rail \{[\s\S]{0,200}overflow-x: auto/.test(css),
    "mobile KPI rails scroll horizontally instead of becoming a stacked block"
  );

  // ============ 1. server ============
  let squatter = false;
  try { squatter = (await fetch(`${BASE}/api/health`)).ok; } catch {}
  if (squatter) fail(`another process is already serving ${BASE}`);
  const seeded = spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA },
    stdio: "ignore",
  });
  if (seeded.status !== 0) fail("seed failed");
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...process.env, OBV_DATA_DIR: DATA, PORT: String(PORT),
      OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  const signIn = async (userId) => {
    const res = await fetch(`${BASE}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
      redirect: "manual",
    });
    return res.headers.getSetCookie()[0].split(";")[0];
  };
  const funder = await signIn("user-funder");
  const field = await signIn("user-field");
  const page = async (p, jar = funder) =>
    (await fetch(BASE + p, { headers: { cookie: jar, accept: "text/html" } })).text();

  // ============ 2. Executive Command Center composition ============
  const exec = await page("/executive");
  assert(exec.includes('class="page-wrap ws"'), "executive renders on the full-bleed workstation surface");
  assert(exec.includes('class="kpi-rail"'), "executive leads with a single KPI rail");
  const kpiCount = (exec.match(/class="kpi [^"]*"|class="kpi"/g) ?? []).length;
  assert(kpiCount >= 5, `the KPI rail carries ${kpiCount} headline metrics on one strip`);
  assert(
    exec.includes("ws-row-3") && exec.includes("ws-row-5"),
    "executive composes an intelligence row (3-up) and an operational row (5-up)"
  );
  const panels = (exec.match(/class="dpanel /g) ?? []).length;
  assert(panels >= 8, `executive shows ${panels} dense panels simultaneously, not a vertical card stack`);
  assert(
    exec.includes("Advisory signals") && exec.includes("Evidence intelligence overview") && exec.includes("Portfolio risk distribution"),
    "the three intelligence modules sit side by side"
  );
  assert(
    exec.includes("Projects needing attention") && exec.includes("Draws needing review") && exec.includes("High-risk projects"),
    "the compact operational modules are present"
  );
  assert(exec.includes('class="dtable"'), "the risk register is a dense table");
  assert(
    !/<h1[^>]*>Executive command center<\/h1>\s*<p class="sub">/.test(exec) && exec.includes('class="ws-head"'),
    "the tall document page header is replaced by the compact work header"
  );

  // ============ 3. Draw Review workbench ============
  const draw = await page("/draw/draw-1?tab=lines");
  assert(draw.includes("Draw Review — Draw #"), "draw review is titled as a review workstation");
  assert(draw.includes('class="workbench"'), "draw review is a workbench (work surface + inspector rail)");
  assert(draw.includes('class="wb-rail"'), "the inspector rail is present");
  assert(
    draw.includes("Evidence readiness") && draw.includes("Review progress") &&
      draw.includes("Advisory signals") && draw.includes("Draw summary"),
    "the four summary modules sit in the top region"
  );
  assert(draw.includes('class="wstabs"'), "record domains are tabs, not sequential full-width sections");
  assert(draw.includes('class="dtable"'), "line items are a dense table");
  assert(
    draw.includes("Current blockers") && draw.includes("Decision status"),
    "the rail carries decision status and current blockers"
  );
  assert(draw.includes('class="mobile-actionbar"'), "a sticky mobile decision region is rendered");
  // Governance content must survive the restructure.
  assert(
    draw.includes("Verified physical") && draw.includes("Exception candidate"),
    "the financial-vs-verified comparison and advisory exception candidates remain visible"
  );

  // ============ 4. Timeline + Digital Twin: ONE workspace ============
  const twin = await page("/timeline/twin/proj-r47");
  assert(twin.includes('class="splitws'), "timeline and twin render as a single split workspace");
  assert(
    twin.includes('class="ws-stream"') && twin.includes('class="ws-canvas"') && twin.includes("ws-inspector"),
    "the workspace has an event stream, a canvas and a context inspector"
  );
  assert(twin.includes("Event stream"), "the event stream pane lists governed timeline events");
  assert(twin.includes("Context inspector") || twin.includes("Evidence detail"), "the inspector pane is present");
  assert(twin.includes('class="segmented"'), "mobile gets a Timeline | Twin segmented control");
  assert(
    /href="\/timeline\/twin\/proj-r47\?focus=/.test(twin),
    "selecting a timeline event focuses the scene and the inspector (?focus sync)"
  );
  assert(
    !twin.includes("twin-snapshot-card") && (twin.match(/class="dpanel /g) ?? []).length <= 6,
    "no stack of giant twin snapshot cards"
  );

  // ============ 5. doctrine compressed, never deleted ============
  for (const [label, html] of [["executive", exec], ["draw review", draw], ["twin workspace", twin]]) {
    assert(html.includes('class="about-view"'), `${label} compresses its doctrine into an expandable disclosure`);
  }
  assert(
    twin.includes("never simulates") || twin.includes("Timeline remains authoritative") || twin.includes("not a physical measurement"),
    "the Digital Twin's truthfulness disclosure is still present (compressed, not removed)"
  );
  assert(
    exec.includes("never approve draws") && exec.includes("never alter records"),
    "the executive advisory limits are still stated"
  );

  // ============ 6. navigation shape + preserved authorization ============
  for (const group of ["Command", "Verification", "Governance", "Intelligence", "Operations"]) {
    assert(exec.includes(`>${group}</div>`), `sidebar groups navigation under ${group}`);
  }
  const fieldHome = await page("/field", field);
  assert(!fieldHome.includes("/executive\""), "a FIELD user's shell does not expose the executive command route");
  const fieldExec = await fetch(`${BASE}/executive`, { headers: { cookie: field, accept: "text/html" }, redirect: "manual" });
  assert(
    [302, 303, 403, 404].includes(fieldExec.status),
    `role authorization is unchanged by the reconstruction (FIELD → ${fieldExec.status} on /executive)`
  );

  console.log(`\nWORKSTATION COMPOSITION TESTS PASSED — ${passed} checkpoints.`);
  console.log("Structure asserted: rails, panels, dense tables, workbench, split workspace, mobile composition.");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
