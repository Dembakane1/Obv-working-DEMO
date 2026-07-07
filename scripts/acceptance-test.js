/**
 * OBV full regression test — hero loop + approval governance + reset.
 *
 * Drives the real UI in Chromium through the 19-step sequence:
 *   overview -> project -> FIELD capture (camera or DEMO FALLBACK) ->
 *   verification -> ledger -> approval request -> partial approval (HELD) ->
 *   final approval -> release -> ledger integrity -> demo reset -> repeat.
 *
 * Usage:  node scripts/acceptance-test.js [camera|fallback]
 * Requires the `playwright` package (NODE_PATH=/opt/node22/lib/node_modules
 * in the build environment) and a running, freshly-seeded server.
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

async function signIn(ctx, name, urlPattern) {
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.getByText(name).click();
  await page.waitForURL(urlPattern);
  return page;
}

async function captureEvidence(field) {
  await waitForText(field, "Gravel base course");
  await field.getByRole("button", { name: /Gravel base course/ }).click();
  await waitForText(field, "Requirement");

  if (MODE === "camera") {
    await field.getByRole("button", { name: "Capture evidence" }).click();
    await waitForText(field, "Live capture — real camera photo and device GPS");
  } else {
    await waitForText(field, "Camera unavailable or permission denied");
    await field.locator(".fallback-grid button").first().click();
    await waitForText(field, "DEMO FALLBACK");
  }
  await waitForText(field, "Review & submit");
  await field.getByRole("button", { name: /Confirm & submit evidence/ }).click();
  await waitForText(field, "VERIFIED", 20000);
}

async function main() {
  const browser = await chromium.launch({
    args:
      MODE === "camera"
        ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
        : [],
  });

  // ---------- 1–3: funder opens overview and project ----------
  const funderCtx = await browser.newContext();
  const funder = await signIn(funderCtx, "Margaret Osei", "**/overview");
  pass("application up — Funder Representative signed in, Overview loads");

  await waitForText(funder, "$2,400,000"); // portfolio value
  await waitForText(funder, "$720,000"); // released
  await waitForText(funder, "$1,680,000"); // held
  pass("overview summary shows portfolio value, released and held amounts");

  await funder.getByRole("link", { name: /Mzimba–Kafukule/ }).first().click();
  await funder.waitForURL("**/project/**");
  await waitForText(funder, "About this project");
  const cards = await funder.locator(".ms-card").count();
  if (cards !== 5) throw new Error(`expected 5 milestone cards, saw ${cards}`);
  pass("seeded project open — five milestone cards with held/released state");

  // ---------- 4–8: field capture ----------
  const fieldCtx = await browser.newContext(
    MODE === "camera"
      ? {
          permissions: ["camera", "geolocation"],
          geolocation: { latitude: -11.87, longitude: 33.594 },
        }
      : {}
  );
  const field = await signIn(fieldCtx, "Chikondi Banda", "**/field");
  pass("switched to FIELD user — capture PWA loads");

  await captureEvidence(field);
  pass(`evidence submitted via ${MODE === "camera" ? "real camera + device GPS" : "DEMO FALLBACK"} — verdict VERIFIED`);

  // ---------- 9–11: verdict, checks, confidence, ledger, approval ----------
  const passMarks = await field.locator(".checks .mark", { hasText: "PASS" }).count();
  if (passMarks !== 3) throw new Error(`expected 3 passing checks, saw ${passMarks}`);
  await waitForText(field, "Confidence");
  pass("three verification checks and confidence visible");

  const ledgerHash = await field.locator("dd", { hasText: /#\d+ · [0-9a-f]{64}/ }).count();
  if (ledgerHash < 1) throw new Error("ledger entry hash not shown on result screen");
  pass("hash-chained ledger entry created — hash visible");

  await waitForText(field, "Approval requested");
  await waitForText(field, "Funds remain");
  pass("ApprovalRequest created — funds remain HELD");

  // funder page auto-updates via polling (no manual reload)
  await waitForText(funder, "approval 0 of 2", 25000);
  pass("funder project page auto-updated — milestone shows approval pending");

  // ---------- 12–14: partial approval ----------
  await funder.goto(BASE + "/approvals");
  await waitForText(funder, "Gravel base course");
  await waitForText(funder, "HELD — $600,000");
  const photoVisible = await funder.locator(".approval-photo img").count();
  const checksVisible = await funder.locator(".approval-review .checks li").count();
  if (photoVisible < 1 || checksVisible < 3) {
    throw new Error("evidence photo/checks not visible to approver before deciding");
  }
  pass("approval queue shows amount at stake, verdict, and full evidence context");

  await funder.getByRole("button", { name: /Approve release/ }).click();
  await funder.waitForURL("**/approvals");
  await waitForText(funder, "1 of 2 approvals");
  await waitForText(funder, "Your decision is recorded");
  pass("partial approval recorded — 1 of 2 shown, awaiting Compliance Reviewer");

  await funder.goto(BASE + "/project/proj-r47?tab=milestones");
  await waitForText(funder, "approval 1 of 2");
  await waitForText(funder, "$1,680,000"); // held unchanged
  pass("funds remain HELD before final approval");

  // ---------- 15–16: final approval -> release ----------
  const complianceCtx = await browser.newContext();
  const compliance = await signIn(complianceCtx, "Amina Ndlovu", "**/overview");
  await compliance.goto(BASE + "/approvals");
  await waitForText(compliance, "1 of 2 approvals");
  await compliance.getByRole("button", { name: /Approve release/ }).click();
  await compliance.waitForURL("**/approvals");
  await waitForText(compliance, "Nothing awaiting approval");
  pass("final required approval completed — queue empty");

  await compliance.goto(BASE + "/overview");
  await waitForText(compliance, "$1,320,000"); // released 720k + 600k
  await waitForText(compliance, "$1,080,000"); // held
  pass("release state updated — tranche RELEASED on virtual account");

  // ---------- 17: ledger integrity ----------
  await compliance.goto(BASE + "/ledger");
  await compliance.getByRole("button", { name: "Verify integrity" }).click();
  await compliance.waitForURL("**/ledger?checked=1");
  await waitForText(compliance, "CHAIN INTACT");
  pass("ledger integrity verified — CHAIN INTACT");

  // ---------- 18: demo reset ----------
  await compliance.goto(BASE + "/overview");
  await compliance.getByRole("button", { name: "Reset demo data" }).click();
  await compliance.waitForURL("**/overview");
  await waitForText(compliance, "$720,000");
  await waitForText(compliance, "$1,680,000");
  pass("demo reset — seeded state restored ($720,000 released)");

  // ---------- 19: repeat the loop ----------
  await field.goto(BASE + "/field");
  await captureEvidence(field);
  await waitForText(field, "Approval requested");
  pass("hero loop repeated after reset — verification and approval request again");

  // leave the demo clean for the next run
  await compliance.goto(BASE + "/overview");
  await compliance.getByRole("button", { name: "Reset demo data" }).click();
  await compliance.waitForURL("**/overview");

  await browser.close();
  console.log(`\nREGRESSION PASSED (${MODE} mode) — ${step} checkpoints, 19-step sequence complete.\n`);
}

main().catch((err) => {
  console.error(`\nREGRESSION FAILED at checkpoint ${step + 1}: ${err.message}\n`);
  process.exit(1);
});
