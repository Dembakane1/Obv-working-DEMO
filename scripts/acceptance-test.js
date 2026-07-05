/**
 * OBV hero-loop acceptance test.
 *
 * Drives the real UI in Chromium through the full loop:
 *   funder dashboard -> project -> switch to FIELD -> capture evidence
 *   (real camera or DEMO FALLBACK) -> verification -> ledger hash ->
 *   approval request -> funds stay HELD -> funder dashboard reflects it.
 *
 * Usage:  node scripts/acceptance-test.js [camera|fallback]
 * Requires the `playwright` package (available globally in the build
 * environment: NODE_PATH=/opt/node22/lib/node_modules) and a running
 * server on localhost:3000 with freshly seeded data.
 */
const MODE = process.argv[2] === "camera" ? "camera" : "fallback";
const BASE = process.env.OBV_BASE_URL || "http://localhost:3000";

const { chromium } = require("playwright");

let step = 0;
function pass(msg) {
  step += 1;
  console.log(`  ✓ [${String(step).padStart(2, "0")}] ${msg}`);
}

async function waitForText(page, text, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await page.getByText(text).count()) > 0) return;
    } catch {
      /* navigation in flight — retry */
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`Timed out waiting for text: ${text}`);
}

async function main() {
  const browser = await chromium.launch({
    args:
      MODE === "camera"
        ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
        : [],
  });

  // ---------- funder context ----------
  const funderCtx = await browser.newContext();
  const funder = await funderCtx.newPage();

  await funder.goto(BASE + "/");
  pass("application is up — demo sign-in page loads");

  await funder.getByText("Margaret Osei").click();
  await funder.waitForURL("**/dashboard");
  pass("selected Funder Representative demo user -> dashboard");

  await funder.getByRole("link", { name: /Mzimba–Kafukule/ }).first().click();
  await funder.waitForURL("**/project/**");
  const milestoneRows = await funder.locator("table.data tbody tr").first().locator("xpath=ancestor::table[1]//tbody/tr").count();
  if (milestoneRows !== 5) throw new Error(`expected 5 milestones, saw ${milestoneRows}`);
  pass("seeded project open — five milestones visible");

  await waitForText(funder, "$720,000"); // released
  await waitForText(funder, "$1,680,000"); // held
  const heldBadges = await funder.locator("table.data .badge", { hasText: "Held" }).count();
  const releasedBadges = await funder.locator("table.data .badge", { hasText: "Released" }).count();
  if (heldBadges < 3 || releasedBadges < 2) {
    throw new Error(`unexpected fund badges: held=${heldBadges} released=${releasedBadges}`);
  }
  pass("held/released financial state visible ($1,680,000 held, $720,000 released)");

  // ---------- field context ----------
  const fieldCtx = await browser.newContext(
    MODE === "camera"
      ? {
          permissions: ["camera", "geolocation"],
          geolocation: { latitude: -11.87, longitude: 33.594 },
        }
      : {}
  );
  const field = await fieldCtx.newPage();
  await field.goto(BASE + "/");
  await field.getByText("Chikondi Banda").click();
  await field.waitForURL("**/field");
  pass("switched to FIELD user -> field capture PWA");

  // Single project auto-selects; milestone list appears.
  await waitForText(field, "Gravel base course");
  await field.getByRole("button", { name: /Gravel base course/ }).click();
  await waitForText(field, "Requirement");
  pass("opened pending milestone M3 with requirement text");

  if (MODE === "camera") {
    await field.getByRole("button", { name: "Capture photo" }).click();
    pass("captured real photo from device camera (fake media stream)");
    await waitForText(field, "Live capture — real camera photo and device GPS");
    pass("device GPS acquired — live-capture confirmation shown");
  } else {
    // No camera permission in this context -> fallback path must appear
    // automatically, with no dead-end error screen.
    await waitForText(field, "Camera unavailable or permission denied");
    pass("camera unavailable -> clear fallback path offered (no dead end)");
    await field.locator(".fallback-grid button").first().click();
    await waitForText(field, "DEMO FALLBACK");
    pass("selected seeded DEMO FALLBACK photo with simulated GPS + timestamp");
  }

  await waitForText(field, "Confirm submission");
  await field.getByRole("button", { name: /Confirm & submit evidence/ }).click();
  pass("evidence submitted");

  await waitForText(field, "VERIFIED", 20000);
  pass("verification ran — structured verdict VERIFIED appears");

  const passMarks = await field.locator(".checks .mark", { hasText: "PASS" }).count();
  if (passMarks !== 3) throw new Error(`expected 3 passing checks, saw ${passMarks}`);
  pass("all three verification checks visible (photo / geofence / integrity)");

  await waitForText(field, "Confidence");
  pass("confidence score visible");

  const ledgerText = await field.locator("dd", { hasText: /#\d+ · [0-9a-f]{64}/ }).count();
  if (ledgerText < 1) throw new Error("ledger entry hash not shown on result screen");
  pass("hash-chained ledger entry created — ledger hash visible");

  await waitForText(field, "Approval requested");
  await waitForText(field, "Funds remain");
  pass("ApprovalRequest created — funds remain HELD pending human approval");

  // ---------- back to funder ----------
  // The funder's project page must reflect the new state via polling,
  // without manual reload.
  await waitForText(funder, "Pending approval", 25000);
  pass("funder project page auto-updated — milestone shows pending approval");

  await funder.goto(BASE + "/dashboard");
  await waitForText(funder, "Pending approval");
  await waitForText(funder, "MILESTONE VERIFIED");
  const dashHeld = await funder.locator("table.data .badge", { hasText: "Held" }).count();
  if (dashHeld < 3) throw new Error("verified milestone no longer HELD on dashboard");
  pass("funder dashboard shows verified milestone, pending approval, tranche still HELD");

  // Ledger chain integrity end-to-end.
  await funder.goto(BASE + "/project/proj-r47");
  await waitForText(funder, "Chain intact");
  const entries = await funder.locator("table.data tbody tr td:first-child", { hasText: /^3$/ }).count();
  if (entries < 1) throw new Error("third ledger entry not visible on project page");
  pass("evidence ledger shows new chained entry and chain reports intact");

  await browser.close();
  console.log(`\nHERO LOOP PASSED (${MODE} mode) — ${step} assertions.\n`);
}

main().catch((err) => {
  console.error(`\nHERO LOOP FAILED at step ${step + 1}: ${err.message}\n`);
  process.exit(1);
});
