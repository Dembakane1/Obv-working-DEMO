#!/usr/bin/env node
/**
 * Navigation consolidation regression suite.
 *
 * Twenty-three first-level sidebar destinations became twelve workspaces.
 * The entire risk of that change is that something quietly stopped being
 * reachable, or that hiding a nav row was mistaken for revoking access.
 *
 * So these checkpoints assert three things and little else:
 *
 *   1. the consolidated SHAPE  — parent workspaces, their tab bars, and a
 *      mobile bar that stays short;
 *   2. NOTHING LOST            — every destination the flat sidebar used
 *      to advertise still answers, is still linked from its workspace,
 *      and is still findable by name in search;
 *   3. AUTHORIZATION UNCHANGED — the server, not the sidebar, still
 *      decides who may open what.
 *
 * They deliberately avoid asserting pixels or copy, so the pages inside
 * these workspaces can still receive their own reconstruction later.
 */
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = 3364;
const BASE = `http://localhost:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), "obv-navigation-"));

let passed = 0;
const pass = (m) => {
  passed++;
  console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`);
};
const fail = (m) => {
  console.error(`  ✗ FAIL: ${m}`);
  throw new Error(m);
};
const assert = (c, m) => (c ? pass(m) : fail(m));

let server = null;
const stopServer = () => {
  try { server?.kill(); } catch { /* already gone */ }
  server = null;
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { stopServer(); process.exit(130); });
}

/**
 * The complete old→new map, as data.
 *
 * Every row is a destination the PREVIOUS flat sidebar listed. `workspace`
 * is the parent that now advertises it; `tab` is the label it appears
 * under. A row here is a promise that consolidation moved a destination
 * rather than deleting it — and every promise is checked below.
 */
const MAP = [
  { old: "Executive Command", href: "/executive", workspace: "Command Center", tab: "Executive" },
  { old: "Overview", href: "/overview", workspace: "Command Center", tab: "Overview" },
  { old: "Portfolio Analytics", href: "/insights", workspace: "Command Center", tab: "Analytics" },
  { old: "Projects", href: "/projects", workspace: "Projects", tab: null },
  { old: "Draws", href: "/draws", workspace: "Draws", tab: null },
  { old: "Evidence Review", href: "/compliance", workspace: "Evidence", tab: "Review" },
  { old: "Evidence Intelligence", href: "/evidence-intelligence", workspace: "Evidence", tab: "Intelligence" },
  { old: "Official Sources", href: "/official-sources", workspace: "Evidence", tab: "Official Sources" },
  { old: "Evidence Ledger", href: "/ledger", workspace: "Evidence", tab: "Ledger" },
  { old: "Timeline", href: "/timeline", workspace: "Site Intelligence", tab: "Timeline" },
  { old: "Digital Twin", href: "/timeline#twin-snapshots", workspace: "Site Intelligence", tab: "Digital Twin" },
  { old: "Map / Satellite", href: "/map", workspace: "Site Intelligence", tab: "Map / Satellite" },
  { old: "Approvals", href: "/approvals", workspace: "Governance", tab: "Approvals" },
  { old: "Exceptions", href: "/exceptions", workspace: "Governance", tab: "Exceptions" },
  { old: "Budget & Progress", href: "/budget", workspace: "Project Controls", tab: "Budget &amp; Progress" },
  { old: "Change Orders", href: "/change-orders", workspace: "Project Controls", tab: "Change Orders" },
  { old: "Field Capture", href: "/field", workspace: "Field", tab: "Capture" },
  { old: "Field Issues", href: "/issues", workspace: "Field", tab: "Issues" },
  { old: "Reports", href: "/reports", workspace: "Reports", tab: null },
  { old: "Communications", href: "/communications", workspace: "Communications", tab: null },
  { old: "Pilot Setup", href: "/setup", workspace: "Pilot", tab: "Setup" },
  { old: "Pilot Operations", href: "/pilot", workspace: "Pilot", tab: "Operations" },
  { old: "Integrations", href: "/communications/integrations", workspace: "Administration", tab: "Integrations" },
];

/** The twelve first-level destinations the consolidated sidebar offers. */
const WORKSPACES = [
  "Command Center", "Projects", "Draws", "Evidence", "Site Intelligence",
  "Governance", "Project Controls", "Field", "Reports", "Communications",
  "Pilot", "Administration",
];

async function main() {
  console.log("Navigation consolidation suite — fewer doors, same rooms");

  let squatter = false;
  try { squatter = (await fetch(`${BASE}/api/health`)).ok; } catch { /* free */ }
  if (squatter) fail(`another process is already serving ${BASE}`);
  if (spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA }, stdio: "ignore",
  }).status !== 0) fail("seed failed");
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...process.env, OBV_DATA_DIR: DATA, PORT: String(PORT),
      OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  const signIn = async (userId) => {
    const res = await fetch(`${BASE}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }), redirect: "manual",
    });
    return res.headers.getSetCookie()[0].split(";")[0];
  };
  const funder = await signIn("user-funder");
  const field = await signIn("user-field");
  const compliance = await signIn("user-compliance");
  const pm = await signIn("user-pm");
  const get = (p, jar) => fetch(BASE + p, { headers: { cookie: jar, accept: "text/html" }, redirect: "manual" });
  const page = async (p, jar = funder) => (await get(p, jar)).text();
  const sidebarOf = (html) => html.split('<nav class="sidebar-nav"')[1]?.split("</nav>")[0] ?? "";
  const navRows = (html) => [...sidebarOf(html).matchAll(/class="nav-item[^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)/g)]
    .map((m) => m[1].trim()).filter(Boolean);

  // =============== 1. the consolidated shape ===============
  const overview = await page("/overview");
  const rows = navRows(overview);
  assert(rows.length <= 12, `the lender sidebar offers ${rows.length} first-level destinations, not twenty-three`);
  for (const w of WORKSPACES) {
    assert(rows.includes(w), `sidebar offers the ${w} workspace`);
  }
  for (const group of ["Command", "Verification", "Governance", "Operations"]) {
    assert(overview.includes(`>${group}</div>`), `workspaces are grouped under ${group}`);
  }
  assert(
    !rows.includes("Evidence Ledger") && !rows.includes("Official Sources") && !rows.includes("Change Orders"),
    "consolidated destinations no longer compete for a first-level slot"
  );

  // =============== 2. nothing lost ===============
  // Every old destination still answers, on its own unchanged URL.
  for (const row of MAP) {
    const url = row.href.split("#")[0];
    const res = await get(url, funder);
    assert(res.status === 200, `${row.old} still answers on ${url} (${res.status})`);
  }
  // …and every consolidated one is reachable from its workspace's tab bar.
  const tabbed = MAP.filter((r) => r.tab !== null);
  for (const row of tabbed) {
    const html = await page(row.href.split("#")[0]);
    const bar = html.split('class="wsnav"')[1]?.split("</nav>")[0] ?? "";
    if (row.href === "/field") {
      // Field Capture keeps its own stripped PWA shell — imposing the
      // enterprise chrome on it would break capture-first mobile use.
      assert(html.includes('href="/issues"'), `${row.old} links to the rest of its workspace without the app shell`);
      continue;
    }
    assert(bar.includes(row.tab), `${row.old} is a "${row.tab}" tab inside ${row.workspace}`);
    assert(
      bar.includes(`href="${row.href}"`),
      `the ${row.workspace} tab bar links ${row.old} at its original URL`
    );
  }
  // …and remains findable by name, which sidebar-scraped search would lose.
  const indexJson = overview.split('id="nav-index">')[1]?.split("</script>")[0] ?? "[]";
  const index = JSON.parse(indexJson);
  assert(index.length >= 23, `search indexes ${index.length} destinations, not just the twelve workspaces`);
  for (const href of ["/ledger", "/official-sources", "/evidence-intelligence", "/insights", "/map", "/exceptions", "/change-orders", "/setup"]) {
    assert(index.some((e) => e.href === href), `search still finds the destination at ${href}`);
  }

  // =============== 3. workspaces are tabbed, not dumped ===============
  for (const [url, label, count] of [
    ["/compliance", "Evidence", 4], ["/timeline", "Site Intelligence", 3],
    ["/approvals", "Governance", 2], ["/budget", "Project Controls", 2],
    ["/pilot", "Pilot", 3], ["/overview", "Command Center", 3],
  ]) {
    const bar = (await page(url)).split('class="wsnav"')[1]?.split("</nav>")[0] ?? "";
    const tabs = (bar.match(/class="wsnav-tab/g) ?? []).length;
    assert(tabs === count, `${label} presents its ${count} destinations as tabs, not one long screen`);
  }

  // =============== 4. badges still describe real work ===============
  const approvals = await page("/approvals");
  const govBar = approvals.split('class="wsnav"')[1]?.split("</nav>")[0] ?? "";
  const sidebarCount = /Governance\s*<span class="count"[^>]*>(\d+)</.exec(sidebarOf(approvals));
  const approvalsTab = /Approvals<span class="count">(\d+)</.exec(govBar);
  const exceptionsTab = /Exceptions<span class="count">(\d+)</.exec(govBar);
  assert(sidebarCount !== null, "the Governance workspace carries an attention badge");
  const parent = Number(sidebarCount[1]);
  const split = Number(approvalsTab?.[1] ?? 0) + Number(exceptionsTab?.[1] ?? 0);
  assert(
    parent === split,
    `the parent badge (${parent}) is exactly its tabs' categories (${split}) — a summary, never a merged record`
  );
  assert(
    /title="\d+ pending approvals? · \d+ open exceptions?"/.test(sidebarOf(approvals)),
    "the summarised badge names both categories rather than presenting one number"
  );

  // =============== 5. role-aware navigation ===============
  const fieldHome = await page("/more", field);
  const fieldRows = navRows(fieldHome);
  assert(fieldRows[0] === "Field", "a FIELD user's sidebar leads with Field — capture is never behind a lender workspace");
  assert(!fieldRows.includes("Pilot"), "pilot administration is not advertised to field users");
  for (const w of ["Projects", "Evidence", "Site Intelligence", "Governance", "Reports"]) {
    assert(fieldRows.includes(w), `a FIELD user keeps reaching ${w} — the sidebar shortened, it did not shrink access`);
  }
  for (const [role, jar, expect] of [["FUNDER_REP", funder, "Draws"], ["COMPLIANCE_REVIEWER", compliance, "Approvals"]]) {
    const html = await page("/overview", jar);
    const bar = html.split('class="bottom-nav"')[1]?.split("</nav>")[0] ?? "";
    assert(bar.includes(`>${expect}<`), `the mobile bar gives ${role} ${expect} in its role-dependent slot`);
  }
  for (const [role, jar] of [["FUNDER_REP", funder], ["PROJECT_MANAGER", pm], ["FIELD", field]]) {
    const bar = (await page("/overview", jar)).split('class="bottom-nav"')[1]?.split("</nav>")[0] ?? "";
    const entries = (bar.match(/<a href=/g) ?? []).length;
    assert(entries <= 5, `${role}'s mobile bar carries ${entries} destinations — a thumb bar, not a mirror of the sidebar`);
    assert(bar.includes('href="/more"'), `${role} reaches every remaining workspace through More`);
  }
  const fieldBar = (await page("/overview", field)).split('class="bottom-nav"')[1]?.split("</nav>")[0] ?? "";
  assert(/href="\/field"[^>]*>[\s\S]*?Capture/.test(fieldBar), "Capture is the first thing in a field user's mobile bar");
  // More must still expose the destinations INSIDE a workspace, or a
  // phone user would have to guess which parent hides the Ledger.
  const more = await page("/more");
  for (const href of ["/ledger", "/official-sources", "/exceptions", "/change-orders", "/map"]) {
    assert(more.includes(`href="${href}"`), `the mobile More page reaches ${href} directly`);
  }

  // =============== 6. authorization is untouched ===============
  // Hiding a nav row is not a permission. The server still decides.
  const fieldSetup = await get("/setup", field);
  assert(
    [302, 303, 403, 404].includes(fieldSetup.status),
    `/setup still refuses a FIELD user server-side (${fieldSetup.status}), independently of the sidebar`
  );
  const anonymous = await fetch(`${BASE}/administration`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert(
    [302, 303, 401, 403, 404].includes(anonymous.status),
    `the Administration directory requires a session (${anonymous.status})`
  );
  const admin = await page("/administration");
  assert(
    admin.includes("Navigation") && admin.includes("never grants access"),
    "the Administration page states that navigation visibility is not authorization"
  );
  assert(
    admin.includes("Pilot configuration"),
    "Administration offers pilot configuration to a role the server already admits"
  );
  const fieldAdmin = await page("/administration", field);
  assert(
    !fieldAdmin.includes(">Pilot configuration<"),
    "a FIELD user's Administration page omits the pilot surface that would refuse them anyway"
  );

  console.log(`\nNAVIGATION CONSOLIDATION TESTS PASSED — ${passed} checkpoints.`);
  console.log(`${MAP.length} previous destinations → ${WORKSPACES.length} workspaces, none lost.`);
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => {
    stopServer();
    try { rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
  });
