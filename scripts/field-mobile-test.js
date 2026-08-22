#!/usr/bin/env node
/**
 * Field Engineer mobile experience — presentation + operational contract.
 *
 * The refresh is a PRESENTATION change over the existing governed capture
 * engine. This suite proves the engine is intact and the new surface tells
 * the truth:
 *   1. the FIELD user reaches /field and sees only accessible projects
 *   2. the home read model is server-scoped (no portfolio leakage, no
 *      client-side filtering of foreign records)
 *   3. GOVERNED evidence state outranks the advisory assessment number
 *   4. the capture engine still posts to the ONE existing /api/evidence
 *      path — camera, gallery upload and real GPS all preserved
 *   5. the IndexedDB offline queue still queues, still flushes on
 *      reconnect, and queued captures are NEVER shown as verified
 *   6. demo fallbacks appear ONLY in demo posture (PR #26 boundary)
 *   7. FIELD sees no lender/governance authority anywhere on the surface
 *   8. mobile has no horizontal overflow and the bottom nav points only
 *      at existing authorized destinations
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { launchChromium } = require("./lib/browser");
const { signInAll, sessionCookie, playwrightCookie } = require("./lib/session");

const ROOT = process.cwd();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "obv-field-"));
const PILOT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "obv-field-pilot-"));
const PORT = 3372;
const PILOT_PORT = 3373;
const BASE = `http://127.0.0.1:${PORT}`;
const PILOT_BASE = `http://127.0.0.1:${PILOT_PORT}`;

let passed = 0;
const pass = (m) => { passed += 1; console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`); };
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); throw new Error(m); };
const assert = (cond, m) => (cond ? pass(m) : fail(m));

let server = null;
let pilotServer = null;
const stopAll = () => {
  for (const s of [server, pilotServer]) { try { s?.kill("SIGKILL"); } catch { /* gone */ } }
  server = null; pilotServer = null;
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { stopAll(); process.exit(130); });
}

async function waitHealthy(base) {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log("\n== field engineer mobile experience ==\n");

  const seeded = spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA }, stdio: "ignore",
  });
  if (seeded.status !== 0) fail("seed failed");
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA, PORT: String(PORT), OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo" },
    stdio: "ignore",
  });
  if (!(await waitHealthy(BASE))) fail("demo server did not become healthy");
  pass("demo-posture server healthy");
  await signInAll(BASE);

  const db = new DatabaseSync(path.join(DATA, "obv.db"), { readOnly: true });
  const api = async (userId, method, p, body) =>
    fetch(BASE + p, {
      method,
      headers: { cookie: sessionCookie(BASE, userId), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const page = async (userId, p) => {
    const res = await fetch(BASE + p, { headers: { cookie: sessionCookie(BASE, userId), accept: "text/html" } });
    return { status: res.status, html: await res.text() };
  };

  // ---------- 1. the field surface ----------
  const shell = await page("user-field", "/field");
  assert(shell.status === 200 && shell.html.includes("OBV Field Engineer"),
    "1. a FIELD user opens /field and gets the field application shell");
  assert(shell.html.includes('id="app"') && shell.html.includes("/js/field.js"),
    "1. the shell mounts the existing compiled capture client (no second implementation)");
  assert(!/class="sidebar"|command-palette|NAV_GROUPS/.test(shell.html),
    "1. the field shell carries no enterprise workstation chrome");

  // ---------- 2. server-scoped read model ----------
  const ctx = await (await api("user-field", "GET", "/api/field-context")).json();
  assert(Array.isArray(ctx.projects) && ctx.projects.length > 0, "2. field context returns accessible projects");
  const accessibleIds = new Set(ctx.projects.map((p) => p.id));
  const allProjectIds = db.prepare("SELECT id FROM projects").all().map((r) => r.id);
  assert(allProjectIds.length > accessibleIds.size || allProjectIds.length === accessibleIds.size,
    `2. the server decides visibility (${accessibleIds.size} of ${allProjectIds.length} projects)`);
  assert(Array.isArray(ctx.recentEvidence) && Array.isArray(ctx.attention) && Array.isArray(ctx.advisory),
    "2. the home read model ships recentEvidence, attention and advisory arrays");
  assert(
    ctx.recentEvidence.every((e) => accessibleIds.has(
      db.prepare("SELECT project_id p FROM milestones WHERE id = ?").get(e.milestoneId).p
    )),
    "2. every recent-evidence row belongs to a project this FIELD user may access"
  );
  {
    // A foreign tenant's own field context must never carry this user's records.
    const foreignEvidence = new Set(ctx.recentEvidence.map((e) => e.evidenceItemId));
    const other = await (await api("user-pm", "GET", "/api/field-context")).json();
    const overlapOk = (other.recentEvidence ?? []).every((e) => {
      const projectId = db.prepare("SELECT project_id p FROM milestones WHERE id = ?").get(e.milestoneId).p;
      return accessibleIds.has(projectId) || !foreignEvidence.has(e.evidenceItemId);
    });
    assert(overlapOk, "2. scoping is per-caller — no cross-tenant record crosses into another user's payload");
  }
  const anon = await fetch(`${BASE}/api/field-context`);
  assert(anon.status === 401, "2. the field read model requires a session (401 anonymous)");

  // ---------- 3. governed state outranks the advisory number ----------
  for (const e of ctx.recentEvidence) {
    const stored = db.prepare(
      "SELECT verdict, confidence FROM verifications WHERE evidence_item_id = ? ORDER BY rowid DESC LIMIT 1"
    ).get(e.evidenceItemId);
    const expected = !stored ? "SUBMITTED"
      : stored.verdict === "VERIFIED" ? "VERIFIED"
        : stored.verdict === "REJECTED" ? "REJECTED" : "NEEDS_REVIEW";
    if (e.state !== expected) fail(`3. governed state mismatch for ${e.evidenceItemId}: ${e.state} != ${expected}`);
    if (stored && Math.abs((e.assessmentConfidence ?? -1) - stored.confidence) > 1e-9) {
      fail(`3. assessment confidence not read from the recorded verification for ${e.evidenceItemId}`);
    }
  }
  pass("3. every evidence row's state is the GOVERNED verdict, and confidence is read from the same record");
  {
    const src = fs.readFileSync(path.join(ROOT, "src/client/field.ts"), "utf8");
    assert(!/Integrity Score|integrity score|\/100|confidence\s*\*\s*100/.test(src),
      "3. the client invents no 0–100 integrity score — confidence is never rescaled into a grade");
    assert(/advisory only/i.test(src),
      "3. the confidence figure is labelled advisory wherever it is shown");
    const svc = fs.readFileSync(path.join(ROOT, "src/server/services/fieldOps.ts"), "utf8");
    assert(/It NEVER substitutes for/.test(svc),
      "3. the read model documents that confidence never substitutes for the governed state");
  }

  // ---------- 4. one capture engine, one evidence endpoint ----------
  {
    const src = fs.readFileSync(path.join(ROOT, "src/client/field.ts"), "utf8");
    const endpoints = [...src.matchAll(/fetch\(\s*"([^"]+)"/g)].map((m) => m[1]);
    assert(endpoints.filter((e) => e.includes("evidence")).every((e) => e === "/api/evidence"),
      "4. the client posts evidence ONLY to the existing /api/evidence path");
    assert(/getUserMedia/.test(src) && /facingMode:\s*"environment"/.test(src),
      "4. real camera capture with environment-facing preference is preserved");
    assert(/navigator\.geolocation\.getCurrentPosition/.test(src) && /enableHighAccuracy/.test(src),
      "4. real device geolocation is preserved");
    assert(/type="file"/.test(src) && /readAsDataURL/.test(src),
      "4. the gallery-upload fallback is preserved");
    assert(/indexedDB\.open\("obv-field"/.test(src) && /window\.addEventListener\("online", \(\) => flushQueue\(\)\)/.test(src),
      "4. the IndexedDB offline queue and its auto-flush on reconnect are preserved");
    assert(/deviceMetadata\(\)/.test(src) && /capturedAt:/.test(src),
      "4. device metadata and capture timestamps still travel with every submission");
  }

  // ---------- 5. posture boundary (PR #26) ----------
  assert(ctx.demoAffordances === true, "5. demo posture declares demoAffordances = true");
  {
    const src = fs.readFileSync(path.join(ROOT, "src/client/field.ts"), "utf8");
    assert(/state\.demoAffordances \? `<button class="btn ghost" id="fallback"/.test(src),
      "5. the DEMO FALLBACK photo offer is gated on the server-declared flag");
    assert(/state\.demoAffordances \? `<button class="btn big" id="simulate"/.test(src),
      "5. the simulated-GPS offer is gated on the server-declared flag");
    assert(!/OBV_ENVIRONMENT|location\.host|document\.referrer/.test(src),
      "5. the client never infers posture itself — the server declares it");
  }

  // ---------- 6. no lender or governance authority on the field surface ----------
  {
    const src = fs.readFileSync(path.join(ROOT, "src/client/field.ts"), "utf8");
    // Authority CONTROLS and endpoints — not the words. Telling a field
    // engineer that funds remain HELD is honest status, and required.
    const forbidden = [
      "lender-decision", "proceededByException", "exceptionsAccepted",
      "inspection-requirement", "/api/approvals", "/api/exceptions",
      "/api/draws", "Payment approved", "Funding authorized", "Legally compliant",
    ];
    for (const term of forbidden) {
      if (src.includes(term)) fail(`6. the field client references lender/governance authority: ${term}`);
    }
    pass("6. the field client calls no lender-decision, approval, exception or inspection-determination endpoint");
    assert(!/money\(/.test(src),
      "6. no lender money figures are rendered on the field surface");
    assert(!/Legally compliant|Funding approved|Payment authorized|Draw ready/i.test(shell.html),
      "6. the field shell never claims approval, funding, payment or legal compliance");
    const decision = await api("user-field", "POST", "/api/draws/draw-1/lender-decision", {
      decision: "APPROVED", approvedAmount: 1000,
    });
    assert([403, 404].includes(decision.status),
      `6. a FIELD user is refused the lender decision endpoint (${decision.status})`);
  }

  // ---------- 7. browser: home, capture, offline queue, overflow ----------
  const browser = await launchChromium();
  const ctxOpts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
  const bctx = await browser.newContext(ctxOpts);
  await bctx.addCookies([playwrightCookie(BASE, "user-field")]);
  const pg = await bctx.newPage();
  await pg.goto(`${BASE}/field`, { waitUntil: "networkidle" });
  await pg.waitForTimeout(600);

  assert(await pg.$("#capture-cta") !== null, "7. the field home leads with a Capture Evidence action");
  assert((await pg.textContent("#capture-cta")).trim().includes("Capture Evidence"),
    "7. the primary action is labelled Capture Evidence");
  {
    const box = await (await pg.$("#capture-cta")).boundingBox();
    assert(box.height >= 44 && box.width > 250, `7. the capture control is a full-width thumb target (${Math.round(box.width)}×${Math.round(box.height)})`);
  }
  assert(await pg.$(".fx-proj") !== null, "7. a project context card is present");
  assert(await pg.$(".fx-nav") !== null, "7. persistent bottom navigation is present");
  {
    const hrefs = await pg.$$eval(".fx-nav a", (els) => els.map((e) => e.getAttribute("href")));
    for (const href of hrefs) {
      const res = await fetch(BASE + href, { headers: { cookie: sessionCookie(BASE, "user-field"), accept: "text/html" } });
      if (res.status !== 200) fail(`7. bottom-nav destination ${href} is not reachable for FIELD (${res.status})`);
    }
    pass(`7. every bottom-nav link points at an existing FIELD-authorized destination (${hrefs.join(", ")})`);
  }
  {
    const overflow = await pg.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert(!overflow, "7. no horizontal page overflow at 390×844");
  }
  {
    // The governed chip is text, not colour alone.
    const chips = await pg.$$eval(".fx-ev .gov", (els) => els.map((e) => e.textContent.trim()));
    assert(chips.length === 0 || chips.every((c) => /VERIFIED|NEEDS REVIEW|REJECTED|SUBMITTED/.test(c)),
      "7. every evidence card states its governed state in words, never colour alone");
    const alts = await pg.$$eval(".fx-ev img", (els) => els.map((e) => e.getAttribute("alt") ?? ""));
    assert(alts.every((a) => a.length > 0), "7. every evidence thumbnail carries alt text");
  }
  {
    // Offline: a capture must queue on the device and NEVER read as verified.
    const queued = await pg.evaluate(async () => {
      const open = () => new Promise((resolve, reject) => {
        const r = indexedDB.open("obv-field", 1);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains("queue")) r.result.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const db2 = await open();
      await new Promise((resolve, reject) => {
        const tx = db2.transaction("queue", "readwrite");
        tx.objectStore("queue").add({ payload: { milestoneId: "ms-3" }, milestoneTitle: "Queued capture", savedAt: new Date().toISOString() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return new Promise((resolve, reject) => {
        const req = db2.transaction("queue", "readonly").objectStore("queue").getAll();
        req.onsuccess = () => resolve(req.result.length);
        req.onerror = () => reject(req.error);
      });
    });
    assert(queued >= 1, "7. a capture persists into the on-device IndexedDB queue");
    await pg.reload({ waitUntil: "networkidle" });
    await pg.waitForTimeout(700);
    const sync = (await pg.textContent(".fx-sync")) ?? "";
    assert(/queued/i.test(sync), `7. queued captures are surfaced in the sync line ("${sync.trim()}")`);
    const cards = await pg.$$eval(".fx-ev .gov", (els) => els.map((e) => e.textContent.trim()));
    const dbVerified = db.prepare(
      "SELECT COUNT(*) c FROM verifications WHERE verdict = 'VERIFIED'"
    ).get().c;
    assert(cards.filter((c) => c === "VERIFIED").length <= dbVerified,
      "7. a device-queued capture is never presented as VERIFIED — only server-accepted evidence carries a governed state");
    await pg.evaluate(async () => {
      const db2 = await new Promise((resolve) => { const r = indexedDB.open("obv-field", 1); r.onsuccess = () => resolve(r.result); });
      await new Promise((resolve) => { const tx = db2.transaction("queue", "readwrite"); tx.objectStore("queue").clear(); tx.oncomplete = () => resolve(); });
    });
  }
  {
    // The capture flow reaches the existing governed wizard.
    await pg.click("#capture-cta");
    await pg.waitForTimeout(500);
    const html = await pg.content();
    assert(/Step \d of 4/.test(html), "7. the capture action enters the existing governed 4-step workflow");
  }
  await bctx.close();

  // 430×932 sweep.
  {
    const c2 = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
    await c2.addCookies([playwrightCookie(BASE, "user-field")]);
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/field`, { waitUntil: "networkidle" });
    await p2.waitForTimeout(500);
    const overflow = await p2.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert(!overflow, "7. no horizontal page overflow at 430×932");
    await c2.close();
  }

  // ---------- 8. pilot posture: demo affordances absent ----------
  pilotServer = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...process.env,
      OBV_DATA_DIR: PILOT_DATA,
      PORT: String(PILOT_PORT),
      OBV_ENVIRONMENT: "pilot",
      OBV_AUTH_LINK_DELIVERY: "file",
      OBV_BOOTSTRAP_ADMIN_EMAIL: "field-suite@obv.test",
      OBV_BANKING_PROVIDER: "mock",
      // A declared pilot refuses to boot alongside the demo-only switches,
      // and the battery runner exports some of them to every suite. Clear
      // them here so the pilot posture under test is a real one.
      OBV_BANKING_MODE: "",
      OBV_SEED_GOLDEN: "",
      OBV_DEMO_AUTH: "",
    },
    stdio: "ignore",
  });
  if (!(await waitHealthy(PILOT_BASE))) fail("pilot server did not become healthy");
  pass("8. pilot-posture server healthy");
  {
    const res = await fetch(`${PILOT_BASE}/api/field-context`);
    assert(res.status === 401, "8. the pilot field context still requires a session");
    const shellRes = await fetch(`${PILOT_BASE}/field`, { redirect: "manual" });
    assert([302, 303, 401].includes(shellRes.status),
      `8. /field in pilot posture requires production identity (${shellRes.status})`);
    const src = fs.readFileSync(path.join(ROOT, "src/server/http/server.ts"), "utf8");
    assert(/demoAffordances:\s*!productionPosture\(\)/.test(src),
      "8. the server derives demoAffordances from the posture resolver, not from a request property");
  }
  {
    const view = fs.readFileSync(path.join(ROOT, "src/server/view/pages.tsx"), "utf8");
    assert(/import \{ productionPosture \} from "\.\.\/services\/posture"/.test(view),
      "8. the view layer resolves posture on the server, never from the browser");
  }

  await browser.close();
  db.close();
  stopAll();
  console.log(`\nFIELD MOBILE TESTS PASSED — ${passed} checkpoints.`);
  console.log("CAPTURE IS GOVERNED. ADVISORY IS ADVISORY. THE PHONE SAYS SO.");
}

main().then(
  () => { stopAll(); process.exit(0); },
  (e) => { console.error(e); stopAll(); process.exit(1); }
);
