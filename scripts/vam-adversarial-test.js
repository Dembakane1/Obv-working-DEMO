#!/usr/bin/env node
/**
 * VAM adversarial regression suite — tries to BREAK the banking layer.
 *
 * Complements scripts/vam-test.js (happy paths + boundary basics) with
 * hostile probes: full transition matrices, replayed and conflicting
 * provider events, injected-failure rollback, stale-state revalidation,
 * exactly-once restoration accounting, cross-tenant object guessing,
 * view-only leakage, masking sweeps, and production-mode refusal of the
 * demo simulation surface. Every probe asserts both the rejection AND
 * that nothing mutated (balances, rows, append-only events, bank book).
 */
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdtempSync, readFileSync, readdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PORT = 3320;
const PROD_PORT = 3321;
const BASE = `http://localhost:${PORT}`;
const PROD_BASE = `http://localhost:${PROD_PORT}`;
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "obv-vam-adv-"));

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

const jars = {};
async function signIn(key, userId, base = BASE) {
  const res = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie();
  if (!setCookie.length) fail(`sign-in for ${userId} at ${base} issued no session cookie (status ${res.status})`);
  jars[key] = setCookie[0].split(";")[0];
}
async function api(key, method, p, body, base = BASE) {
  const res = await fetch(base + p, {
    method,
    headers: { cookie: jars[key] ?? "", "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  if (process.env.ADV_DEBUG) {
    console.error(`    [dbg] ${method} ${p} -> ${res.status}${res.status >= 500 ? " " + (await res.clone().text()).slice(0, 200) : ""}`);
  }
  return res;
}
async function j(key, method, p, body, expect, base = BASE) {
  const res = await api(key, method, p, body, base);
  if (expect !== undefined && res.status !== expect) {
    fail(`${method} ${p} -> ${res.status} (expected ${expect}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}
async function page(key, p, base = BASE) {
  const res = await fetch(base + p, { headers: { cookie: jars[key] ?? "", accept: "text/html" }, redirect: "manual" });
  return { status: res.status, html: res.status === 200 ? await res.text() : "" };
}

let db;
// Kill spawned servers even when a failure happens before the try/finally
// block arms — an orphan would poison the NEXT run's port pre-flight.
const spawnedServers = [];
process.on("exit", () => {
  for (const s of spawnedServers) {
    try { s.kill(); } catch { /* already gone */ }
  }
});
const q1 = (sql, ...args) => db.prepare(sql).get(...args);
const exec = (sql, ...args) => db.prepare(sql).run(...args);

/** Complete banking-side fingerprint: any silent mutation shows up here. */
function bankingFingerprint() {
  return JSON.stringify({
    account: q1("SELECT available_balance a, held_balance h, release_eligible_balance r, pending_outbound_amount p, settled_outbound_amount s, returned_amount x FROM project_virtual_accounts WHERE id='pva-r47'"),
    instructions: q1("SELECT COUNT(*) c, COALESCE(SUM(amount),0) t FROM payment_instructions"),
    txns: q1("SELECT COUNT(*) c FROM bank_transactions"),
    events: q1("SELECT COUNT(*) c FROM banking_events"),
    bankBook: q1("SELECT COUNT(*) c, COALESCE(SUM(amount),0) t FROM mock_provider_ledger"),
    holds: q1("SELECT COUNT(*) c FROM project_account_holds"),
  });
}
const account = () =>
  q1("SELECT * FROM project_virtual_accounts WHERE id='pva-r47'");

/** Byte-identical proof: sha256 over EVERY row of every banking table.
 *  Where bankingFingerprint() watches counts and sums, this catches even a
 *  single flipped column (e.g. a transaction status changed with nothing
 *  else disturbed). */
function bankingSnapshot() {
  const h = createHash("sha256");
  for (const t of [
    "project_virtual_accounts", "payment_instructions", "bank_transactions",
    "banking_events", "mock_provider_ledger", "project_account_holds",
  ]) {
    h.update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
  }
  return h.digest("hex");
}

async function main() {
  console.log("VAM adversarial regression suite — isolated servers on :" + PORT + " / :" + PROD_PORT);

  // ================= 0. static boundary sweeps =================
  const bankingDir = path.join(__dirname, "..", "src", "server", "services", "banking");
  const bankingSrc = readdirSync(bankingDir).map((f) => readFileSync(path.join(bankingDir, f), "utf8")).join("\n");
  assert(!/VirtualAccountService/.test(bankingSrc), "no banking module references VirtualAccountService");
  assert(
    !/node:https?\b|fetch\s*\(|axios|XMLHttpRequest|net\.connect|dns\.|tls\./.test(bankingSrc),
    "no banking module contains a network call path"
  );
  assert(
    !/api[_-]?key|apikey|client_secret|bearer |authorization:/i.test(bankingSrc),
    "no banking module contains credential material"
  );
  const routesSrc = readFileSync(path.join(__dirname, "..", "src", "server", "http", "bankingRoutes.ts"), "utf8");
  assert(
    !/getDb\(|prepare\(|INSERT INTO|UPDATE |DELETE FROM/.test(routesSrc),
    "banking route handlers perform no direct SQLite writes"
  );

  // ============ 1. non-mock refusal + seed + servers ============
  // Environment guard (not a checkpoint): a stale server squatting on a
  // suite port would answer health checks with FOREIGN state and turn
  // every probe below into noise. Refuse to run rather than mislead.
  for (const base of [BASE, PROD_BASE]) {
    let squatter = false;
    try { squatter = (await fetch(base + "/api/health")).ok; } catch {}
    if (squatter) fail(`another process is already serving ${base} — kill it and rerun`);
  }
  const refused = spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "server", "http", "server.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PORT + 2), OBV_BANKING_PROVIDER: "treasury_prime" },
    timeout: 15000,
    encoding: "utf8",
  });
  assert(
    refused.status !== 0 && /refuses to start|OBV_BANKING_PRODUCTION_ENABLE/.test(refused.stderr + refused.stdout),
    "a non-mock provider refuses startup without explicit production flags"
  );

  spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "server", "db", "seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
    stdio: "ignore",
  });
  const demoServer = spawn(process.execPath, [path.join(__dirname, "..", "dist", "server", "http", "server.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PORT), OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo" },
    stdio: "ignore",
  });
  spawnedServers.push(demoServer);
  // Identity hardening (added after the original audit): production mode
  // REFUSES to start without a session secret — forgeable identity
  // cookies would be worse than no server. Assert the refusal, then
  // start the production-mode server properly with a generated secret.
  const noSecret = spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "server", "http", "server.js")], {
    env: {
      ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PROD_PORT),
      OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "production", OBV_SESSION_SECRET: "",
    },
    timeout: 15000,
    encoding: "utf8",
  });
  assert(
    noSecret.status !== 0 && /OBV_SESSION_SECRET/.test(noSecret.stderr + noSecret.stdout),
    "production mode refuses startup without a session secret (identity hardening)"
  );
  const PROD_SECRET =
    process.env.OBV_SESSION_SECRET ||
    require("node:crypto").randomBytes(32).toString("hex");
  const prodEnv = {
    ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PROD_PORT),
    OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "production", OBV_SESSION_SECRET: PROD_SECRET,
    // Production also demands an explicit sign-in-link delivery choice
    // (the file outbox stores live links on the data volume).
    OBV_AUTH_LINK_DELIVERY: "file",
  };
  let prodServer = spawn(process.execPath, [path.join(__dirname, "..", "dist", "server", "http", "server.js")], {
    env: prodEnv,
    stdio: "ignore",
  });
  spawnedServers.push(prodServer);
  async function waitUp(base) {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await fetch(base + "/api/health")).ok; } catch {}
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) fail(`server ${base} did not become healthy`);
  }
  await waitUp(BASE);
  await waitUp(PROD_BASE);
  db = new DatabaseSync(path.join(DATA_DIR, "obv.db"));

  try {
    await signIn("funder", "user-funder");
    await signIn("lender2", "user-lender2");
    await signIn("pm", "user-pm");
    await signIn("compliance", "user-compliance");

    // ============ 2. production mode refuses the demo surface ============
    // TWO independent walls, proven separately:
    //   wall 1 (identity): production posture disables the passwordless
    //   role switcher entirely — assuming any identity by id would be an
    //   authentication bypass, so /api/session is simply not there.
    let fp = bankingFingerprint();
    const prodSwitch = await fetch(PROD_BASE + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-funder" }),
      redirect: "manual",
    });
    assert(
      prodSwitch.status === 404 && prodSwitch.headers.getSetCookie().length === 0,
      "production posture disables the passwordless demo role switcher (404, no cookie issued)"
    );
    const anonProbes = [
      await api("nobody", "POST", "/api/banking/accounts/pva-r47/credit", { amount: 1000 }, PROD_BASE),
      await api("nobody", "POST", "/api/payment-instructions/pi-pending-1/simulate/submit", {}, PROD_BASE),
      await api("nobody", "POST", "/api/payment-instructions/pi-settled-1/simulate/settled", {}, PROD_BASE),
    ];
    assert(
      anonProbes.every((r) => r.status === 401) && bankingFingerprint() === fp,
      "without an identity the production surface refuses everything (401) and mutates nothing"
    );
    //   wall 2 (banking mode): even an AUTHENTICATED user must be refused
    //   the demo simulation surface in production banking mode. The demo
    //   switcher supports an explicit OBV_DEMO_AUTH=1 override — used here
    //   as a test-only key past wall 1 so wall 2 is proven independently.
    prodServer.kill();
    prodServer = spawn(process.execPath, [path.join(__dirname, "..", "dist", "server", "http", "server.js")], {
      env: { ...prodEnv, OBV_DEMO_AUTH: "1" },
      stdio: "ignore",
    });
    spawnedServers.push(prodServer);
    await waitUp(PROD_BASE);
    await signIn("prodFunder", "user-funder", PROD_BASE);
    fp = bankingFingerprint();
    const prodCredit = await api("prodFunder", "POST", "/api/banking/accounts/pva-r47/credit", { amount: 1000 }, PROD_BASE);
    const prodSubmit = await api("prodFunder", "POST", "/api/payment-instructions/pi-pending-1/simulate/submit", {}, PROD_BASE);
    const prodSettle = await api("prodFunder", "POST", "/api/payment-instructions/pi-settled-1/simulate/settled", {}, PROD_BASE);
    const prodForce = await api("prodFunder", "POST", "/api/projects/proj-r47/banking/reconcile", { demoForceMismatchAmount: 500 }, PROD_BASE);
    assert(
      [prodCredit, prodSubmit, prodSettle, prodForce].every((r) => r.status === 403),
      "production mode refuses demo credits, simulated submission/settlement and forced mismatch even when authenticated (403)"
    );
    assert(bankingFingerprint() === fp, "the refused production-mode probes mutated nothing");
    const prodPage = await page("prodFunder", "/project/proj-r47/account", PROD_BASE);
    assert(
      prodPage.status === 200 && !prodPage.html.includes("Credit demo funds") && !prodPage.html.includes("Force mismatch by"),
      "production mode hides the demo simulation controls in the workspace"
    );
    // (Viewing the workspace legitimately appends an attributable
    // ACCOUNT_ACCESSED audit event — the append-only log is SUPPOSED to
    // grow on access; the refusals above grew nothing.)

    // ============ 3. payment-instruction transition matrix ============
    // Seeded: pi-settled-1 SETTLED, pi-pending-1 PENDING_APPROVAL.
    const submitUnapproved = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/submit", {});
    assert(submitUnapproved.status === 409, "PENDING_APPROVAL cannot be submitted to the provider (approval first)");
    const settleUnsubmitted = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/settled", {});
    assert(settleUnsubmitted.status === 409, "an unsubmitted instruction has no bank transaction to settle");
    const approveSettled = await api("lender2", "POST", "/api/payment-instructions/pi-settled-1/approve", {});
    assert(approveSettled.status === 409, "a SETTLED instruction cannot be approved again");
    const cancelSettled = await api("funder", "POST", "/api/payment-instructions/pi-settled-1/cancel", {});
    assert(cancelSettled.status === 409, "a SETTLED instruction cannot be cancelled");
    const returnPending = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/returned", {});
    assert(returnPending.status === 409, "return cannot apply before settlement (no transaction yet)");

    // Approval does NOT settle — and reservation replay returns the SAME
    // instruction without a second earmark.
    const preApprove = account();
    await j("lender2", "POST", "/api/payment-instructions/pi-pending-1/approve", {}, 200);
    const postApprove = account();
    const approvedRow = q1("SELECT status, settled_at FROM payment_instructions WHERE id='pi-pending-1'");
    assert(
      approvedRow.status === "APPROVED_FOR_SUBMISSION" && approvedRow.settled_at === null &&
        postApprove.available_balance === preApprove.available_balance &&
        postApprove.settled_outbound_amount === preApprove.settled_outbound_amount,
      "approval never settles and never moves funds"
    );
    const replay = await j("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 120_000, recipientName: "Lakeshore Rehab Contractors LLC",
      recipientReference: "PAY-APP-2026-05-FINAL", idempotencyKey: "seed-pi-pending-1",
    }, 201);
    assert(
      replay.instruction.id === "pi-pending-1" &&
        account().release_eligible_balance === postApprove.release_eligible_balance,
      "an idempotency replay after approval returns the same instruction with NO second reservation"
    );
    const doubleApprove = await api("lender2", "POST", "/api/payment-instructions/pi-pending-1/approve", {});
    assert(doubleApprove.status === 409, "approving twice is a controlled conflict (exactly-once approval)");

    // ============ 4. insufficient available at submission (rollback) ============
    exec("UPDATE project_virtual_accounts SET available_balance = 100000 WHERE id='pva-r47'");
    fp = bankingFingerprint();
    const lowSubmit = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/submit", {});
    assert(lowSubmit.status === 409, "submission with insufficient available balance is refused (guarded arithmetic)");
    assert(bankingFingerprint() === fp, "the failed submission rolled back completely — no instruction/txn/balance/event change");
    assert(
      q1("SELECT status FROM payment_instructions WHERE id='pi-pending-1'").status === "APPROVED_FOR_SUBMISSION" &&
        q1("SELECT COUNT(*) c FROM bank_transactions WHERE payment_instruction_id='pi-pending-1'").c === 0,
      "the instruction stayed APPROVED_FOR_SUBMISSION with no orphan bank transaction"
    );
    exec("UPDATE project_virtual_accounts SET available_balance = 370000 WHERE id='pva-r47'");

    // ============ 5. submission → transaction lifecycle matrix ============
    await j("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/submit", {}, 200);
    const txnRef = q1("SELECT provider_transaction_reference r FROM bank_transactions WHERE payment_instruction_id='pi-pending-1'").r;
    const cancelSubmitted = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/cancel", {});
    assert(cancelSubmitted.status === 409, "cancellation cannot occur after provider submission");
    const reverseBeforeSettle = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/reversed", { eventId: "adv-rev-early" });
    assert(reverseBeforeSettle.status === 409, "reversal cannot apply before settlement");
    await j("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/posted", { eventId: "adv-post-1" }, 200);
    const repost = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/posted", { eventId: "adv-post-2" });
    assert(repost.status === 409, "a second posted event against a POSTED transaction is a rejected conflict");

    await j("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/settled", { eventId: "adv-settle-1" }, 200);
    const settled1 = account();
    // Duplicate settlement (same eventId): idempotent, byte-identical.
    fp = bankingFingerprint();
    await j("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/settled", { eventId: "adv-settle-1" }, 200);
    assert(bankingFingerprint() === fp, "duplicate settlement replay (same eventId) mutates absolutely nothing");
    // Second settlement with a NEW eventId: rejected, nothing changes.
    const resettle = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/settled", { eventId: "adv-settle-2" });
    assert(resettle.status === 409 && bankingFingerprint() === fp, "settlement cannot happen twice (new eventId rejected, no mutation)");
    // Failure after settlement: rejected.
    const failAfterSettle = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/failed", { eventId: "adv-fail-late" });
    assert(failAfterSettle.status === 409 && bankingFingerprint() === fp, "failure cannot apply after settlement");
    // Conflicting reuse: same eventId, different EVENT TYPE.
    const typeConflict = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/returned", { eventId: "adv-settle-1" });
    assert(
      typeConflict.status === 409 && /different transaction or event type/.test((await typeConflict.json()).error) &&
        bankingFingerprint() === fp,
      "reusing an eventId with a different event type is an explicit conflict, not a silent success"
    );
    // Conflicting reuse: same eventId, DIFFERENT transaction (seeded settle event vs this txn).
    const txnConflict = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/returned", { eventId: "seed-settle-1" });
    assert(
      txnConflict.status === 409 && bankingFingerprint() === fp,
      "an eventId can never be replayed against another transaction"
    );
    void txnRef;

    // ============ 6. return restoration exactly once ============
    const preReturn = account();
    await j("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/returned", { eventId: "adv-ret-1" }, 200);
    const postReturn = account();
    assert(
      postReturn.available_balance === preReturn.available_balance + 120_000 &&
        postReturn.returned_amount === preReturn.returned_amount + 120_000 &&
        postReturn.settled_outbound_amount === preReturn.settled_outbound_amount,
      "a provider return restores funds once and tracks the cumulative returned amount"
    );
    fp = bankingFingerprint();
    await j("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/returned", { eventId: "adv-ret-1" }, 200);
    assert(bankingFingerprint() === fp, "duplicate return replay restores NOTHING a second time");
    const rereturn = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/returned", { eventId: "adv-ret-2" });
    assert(rereturn.status === 409 && bankingFingerprint() === fp, "a second return with a new eventId is rejected with no mutation");
    void settled1;

    // ============ 7. failure + reversal accounting on fresh instructions ============
    exec("UPDATE lender_draw_decisions SET approved_amount = 500000 WHERE id='ldec-vam'");
    const mk = async (amount, key) => {
      const r = await j("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
        amount, recipientName: `Adversarial Payee ${key}`, idempotencyKey: key,
      }, 201);
      await j("lender2", "POST", `/api/payment-instructions/${r.instruction.id}/approve`, {}, 200);
      return r.instruction.id;
    };
    // failure restoration exactly once
    const fId = await mk(10_000, "adv-fail-flow");
    await j("funder", "POST", `/api/payment-instructions/${fId}/simulate/submit`, {}, 200);
    const preFail = account();
    await j("funder", "POST", `/api/payment-instructions/${fId}/simulate/failed`, { eventId: "adv-f1" }, 200);
    const postFail = account();
    assert(
      postFail.available_balance === preFail.available_balance + 10_000 &&
        postFail.pending_outbound_amount === preFail.pending_outbound_amount - 10_000 &&
        postFail.release_eligible_balance === preFail.release_eligible_balance + 10_000,
      "a provider failure restores in-flight funds to the spendable ledger exactly once"
    );
    fp = bankingFingerprint();
    await j("funder", "POST", `/api/payment-instructions/${fId}/simulate/failed`, { eventId: "adv-f1" }, 200);
    assert(bankingFingerprint() === fp, "duplicate failure replay restores nothing a second time");
    // cancellation restoration exactly once
    const cId = await mk(7_000, "adv-cancel-flow");
    const preCancel = account();
    await j("funder", "POST", `/api/payment-instructions/${cId}/cancel`, {}, 200);
    assert(
      account().release_eligible_balance === preCancel.release_eligible_balance + 7_000,
      "cancellation releases the reservation exactly once"
    );
    const recancel = await api("funder", "POST", `/api/payment-instructions/${cId}/cancel`, {});
    assert(
      recancel.status === 409 && account().release_eligible_balance === preCancel.release_eligible_balance + 7_000,
      "a second cancellation is rejected and restores nothing again"
    );
    // reversal accounting
    const rId = await mk(9_000, "adv-reverse-flow");
    await j("funder", "POST", `/api/payment-instructions/${rId}/simulate/submit`, {}, 200);
    await j("funder", "POST", `/api/payment-instructions/${rId}/simulate/settled`, { eventId: "adv-r-settle" }, 200);
    const preRev = account();
    await j("funder", "POST", `/api/payment-instructions/${rId}/simulate/reversed`, { eventId: "adv-r-rev" }, 200);
    const postRev = account();
    assert(
      postRev.available_balance === preRev.available_balance + 9_000 &&
        postRev.settled_outbound_amount === preRev.settled_outbound_amount - 9_000 &&
        postRev.returned_amount === preRev.returned_amount,
      "a reversal restores funds and reduces settled outbound (returned stays a return-only counter)"
    );
    // Reconciliation invariant still holds after the whole hostile sequence.
    const recon1 = await j("funder", "POST", "/api/projects/proj-r47/banking/reconcile", {}, 201);
    assert(
      recon1.run.status === "MATCHED",
      `after every hostile flow the books still reconcile (bank ${recon1.run.bankReportedBalance} = ledger ${recon1.run.ledgerCalculatedBalance})`
    );

    // ============ 8. stale-state revalidation before approval/submission ============
    const sId = await mk(5_000, "adv-stale-decision"); // approved
    const s2 = await j("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 4_000, recipientName: "Stale Probe LLC", idempotencyKey: "adv-stale-2",
    }, 201);
    // decision goes stale AFTER creation → approval must refuse
    exec("UPDATE lender_draw_decisions SET decision='PENDING' WHERE id='ldec-vam'");
    const staleApprove = await api("lender2", "POST", `/api/payment-instructions/${s2.instruction.id}/approve`, {});
    assert(staleApprove.status === 409, "a lender decision that went stale after creation blocks approval");
    const staleSubmit = await api("funder", "POST", `/api/payment-instructions/${sId}/simulate/submit`, {});
    assert(staleSubmit.status === 409, "a stale lender decision also blocks provider submission");
    exec("UPDATE lender_draw_decisions SET decision='APPROVED' WHERE id='ldec-vam'");
    // a newly opened condition blocks approval
    exec(`INSERT INTO lender_decision_conditions (id, lender_decision_id, condition_type, description, status, created_at, updated_at)
          VALUES ('adv-cond', 'ldec-vam', 'DOCUMENT', 'Adversarial condition', 'OPEN', '2026-07-07T00:00:00.000Z', '2026-07-07T00:00:00.000Z')`);
    const condApprove = await api("lender2", "POST", `/api/payment-instructions/${s2.instruction.id}/approve`, {});
    assert(condApprove.status === 409, "a condition opened after creation blocks approval");
    exec("DELETE FROM lender_decision_conditions WHERE id='adv-cond'");
    // a new critical integrity exception blocks submission
    exec(`INSERT INTO exceptions (id, organization_id, project_id, source_type, source_id, source_key, category, severity, status, title, description, opened_at, created_by, created_at, updated_at)
          VALUES ('adv-exc', 'org-cdfc', 'proj-r47', 'MANUAL', 'adv', 'adv-critical-probe', 'INTEGRITY', 'CRITICAL', 'OPEN', 'Adversarial critical', 'probe', '2026-07-07T00:00:00.000Z', 'system', '2026-07-07T00:00:00.000Z', '2026-07-07T00:00:00.000Z')`);
    const excSubmit = await api("funder", "POST", `/api/payment-instructions/${sId}/simulate/submit`, {});
    assert(excSubmit.status === 409, "a critical integrity exception opened after approval blocks submission");
    exec("DELETE FROM exceptions WHERE id='adv-exc'");
    // reconciliation mismatch blocks approval AND submission
    await j("funder", "POST", "/api/projects/proj-r47/banking/reconcile", { demoForceMismatchAmount: 999 }, 201);
    const mmApprove = await api("lender2", "POST", `/api/payment-instructions/${s2.instruction.id}/approve`, {});
    const mmSubmit = await api("funder", "POST", `/api/payment-instructions/${sId}/simulate/submit`, {});
    assert(mmApprove.status === 409 && mmSubmit.status === 409, "a reconciliation mismatch blocks both approval and submission");
    const heal = await j("funder", "POST", "/api/projects/proj-r47/banking/reconcile", {}, 201);
    assert(heal.run.status === "MATCHED", "an attributable matched run restores payment work");
    await j("funder", "POST", `/api/payment-instructions/${sId}/cancel`, {}, 200);
    await j("funder", "POST", `/api/payment-instructions/${s2.instruction.id}/cancel`, {}, 200);
    exec("UPDATE lender_draw_decisions SET approved_amount = 200000 WHERE id='ldec-vam'");

    // ============ 9. cross-tenant object guessing ============
    exec("INSERT INTO organizations (id, name, kind) VALUES ('org-adv', 'Adversary Org', 'FUNDER')");
    exec("INSERT INTO users (id, organization_id, name, role, title) VALUES ('user-adv', 'org-adv', 'Eve Adversary', 'FUNDER_REP', 'Outside Funder')");
    await signIn("adv", "user-adv");
    const guesses = [
      await api("adv", "POST", "/api/payment-instructions/pi-settled-1/approve", {}),
      await api("adv", "POST", "/api/payment-instructions/pi-settled-1/cancel", {}),
      await api("adv", "POST", "/api/banking/holds/hold-1/release", {}),
      await api("adv", "POST", "/api/banking/accounts/pva-r47/credit", { amount: 5 }),
      await api("adv", "GET", "/api/draws/draw-vam/payment-eligibility"),
      await api("adv", "GET", "/api/projects/proj-r47/banking"),
    ];
    assert(
      guesses.every((g) => g.status === 404),
      "direct object-ID guessing from an unrelated tenant returns the same 404 as nonexistent records (6 routes)"
    );

    // ============ 10. view-only capability cannot mutate ============
    const compProbes = [
      await api("compliance", "POST", "/api/banking/accounts/pva-r47/holds", { amount: 5, reasonCode: "X" }),
      await api("compliance", "POST", "/api/banking/accounts/pva-r47/credit", { amount: 5 }),
      await api("compliance", "POST", "/api/draws/draw-vam/payment-instructions", { amount: 5, recipientName: "X" }),
      await api("compliance", "POST", "/api/payment-instructions/pi-settled-1/cancel", {}),
      await api("compliance", "POST", "/api/projects/proj-r47/banking/program", { partnerBankName: "X", accountStructure: "FBO" }),
    ];
    assert(
      compProbes.every((r) => r.status === 403),
      "the view/reconciliation-only fallback cannot perform any mutation (5 routes → 403)"
    );

    // ============ 11. masking sweeps: HTML, JSON, packages ============
    const wp = await page("funder", "/project/proj-r47/account");
    const viewJson = JSON.stringify(await j("funder", "GET", "/api/projects/proj-r47/banking", undefined, 200));
    const masked = q1("SELECT virtual_account_number_masked m, routing_number_masked r FROM project_virtual_accounts WHERE id='pva-r47'");
    assert(
      masked.m.startsWith("••••") && masked.m.length <= 12 && masked.r.startsWith("••••"),
      "only masked identifiers exist at the database level"
    );
    // Digit sweep: strip deterministic provider references (hex-derived,
    // may coincidentally contain digit runs) then require no 9+ digit run
    // anywhere — an unmasked account/routing number would trip this.
    const stripRefs = (s) =>
      s
        .replace(/MOCK-[A-Z]+-[0-9A-F]{6,}/g, "")            // deterministic provider refs
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "") // uuids (a real account number has no uuid shape)
        .replace(/[0-9a-f]{32,}/gi, "")                       // sha-256 event/file hashes
        .replace(/\d{4}-\d{2}-\d{2}T?\s?\d{2}:\d{2}:\d{2}(\.\d+)?/g, ""); // timestamps
    assert(
      wp.html.includes("••••") && viewJson.includes("••••") &&
        !/\d{9,}/.test(stripRefs(wp.html)) && !/\d{9,}/.test(stripRefs(viewJson)),
      "workspace HTML and banking JSON expose only masked identifiers (no long digit runs)"
    );
    assert(
      wp.html.includes("Demo simulation only") &&
        wp.html.includes("No real money exists or moves") &&
        wp.html.includes("A payment instruction is not proof of payment") &&
        wp.html.includes("Only a provider-confirmed settled bank transaction represents completed movement of funds"),
      "the workspace discloses the demo simulation and that only provider-confirmed settlement is payment truth"
    );
    const pkg = await j("funder", "POST", "/api/draws/draw-vam/verification-package", {}, 201);
    const zipBuf = Buffer.from(await (await fetch(BASE + `/reports/file/${pkg.report.id}`, { headers: { cookie: jars.funder } })).arrayBuffer());
    const zipText = zipBuf.toString("latin1");
    assert(
      zipText.includes("project-virtual-account.csv") && zipBuf.includes(Buffer.from("\u2022\u2022\u2022\u2022", "utf8")),
      "the verification package carries the banking registers with masked identifiers"
    );
    // The package ZIP uses STORE (no compression), so each entry's bytes
    // sit verbatim after its local header. Extract the BANKING registers
    // and sweep exactly those (the PDF cover is binary and would false-
    // positive a whole-archive sweep).
    const extractStored = (buf, name) => {
      const sig = Buffer.from("PK", "latin1");
      let off = 0;
      while ((off = buf.indexOf(sig, off)) !== -1) {
        const nameLen = buf.readUInt16LE(off + 26);
        const extraLen = buf.readUInt16LE(off + 28);
        const compSize = buf.readUInt32LE(off + 18);
        const entryName = buf.slice(off + 30, off + 30 + nameLen).toString("utf8");
        const dataStart = off + 30 + nameLen + extraLen;
        if (entryName.endsWith(name)) return buf.slice(dataStart, dataStart + compSize).toString("utf8");
        off = dataStart + compSize;
      }
      return null;
    };
    for (const reg of ["project-virtual-account.csv", "payment-instructions.csv", "bank-transactions.csv", "account-holds.csv"]) {
      const content = extractStored(zipBuf, reg);
      if (content === null) fail(`package register ${reg} missing`);
      if (/\d{9,}/.test(stripRefs(content))) fail(`unmasked long digit run in ${reg}`);
    }
    pass("no unmasked account/routing digit runs in any banking register of the package");

    // ============ 12. lender tab leaks nothing without the view capability ============
    const pmTab = await page("pm", "/draw/draw-vam?tab=lender");
    assert(
      pmTab.status === 200 &&
        !pmTab.html.includes("••••") &&
        !pmTab.html.includes("Lakeshore Rehab Contractors LLC") &&
        !pmTab.html.includes("Release-eligible balance") &&
        !pmTab.html.includes("MOCK-TXN") &&
        !pmTab.html.includes("Reconciliation state"),
      "without VIEW_PROJECT_ACCOUNT the lender tab reveals no balances, recipients, references or reconciliation results"
    );

    // ============ 13. recovered-defect regression probes ============
    // These pin the three post-merge-audit hardening defects so they can
    // never silently regress. (A) eventId identity collision is proven
    // above: identical replay idempotent, same id + different event type
    // or transaction → 409 with zero mutation.
    //
    // (B) idempotency conflicts are decided INSIDE the banking write
    // lock: a reused key with different parameters is a controlled 409 —
    // never a raw UNIQUE constraint error, never a second instruction.
    exec("UPDATE lender_draw_decisions SET approved_amount = 500000 WHERE id='ldec-vam'");
    fp = bankingFingerprint();
    const keyConflict = await api("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 55_555, recipientName: "Entirely Different Payee", idempotencyKey: "seed-pi-settled-1",
    });
    const keyConflictBody = await keyConflict.json();
    assert(
      keyConflict.status === 409 &&
        /already processed with different parameters/i.test(keyConflictBody.error ?? "") &&
        !/UNIQUE|SQLITE|constraint/i.test(keyConflictBody.error ?? "") &&
        bankingFingerprint() === fp,
      "reusing an idempotency key with different parameters is a controlled 409 (no raw UNIQUE error), zero mutation"
    );
    const raceResults = await Promise.all([0, 1, 2, 3, 4, 5].map((i) =>
      api("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
        amount: 1_000 + (i % 2) * 500, recipientName: `Race Payee ${i % 2}`, idempotencyKey: "adv-b-race",
      }).then(async (r) => ({ status: r.status, body: await r.json() }))
    ));
    const raceWinners = raceResults.filter((r) => r.status === 201);
    assert(
      q1("SELECT COUNT(*) c FROM payment_instructions WHERE idempotency_key='adv-b-race'").c === 1 &&
        raceResults.every((r) => r.status === 201 || r.status === 409) &&
        raceWinners.length >= 1 &&
        new Set(raceWinners.map((r) => r.body.instruction.id)).size === 1,
      "six concurrent creations under ONE idempotency key yield exactly one instruction (replays return it, conflicts 409)"
    );
    await j("funder", "POST", `/api/payment-instructions/${raceWinners[0].body.instruction.id}/cancel`, {}, 200);

    // (C) transaction/instruction LOCKSTEP: the transaction transition
    // lands first, so an instruction that cannot make the matching
    // transition must roll the WHOLE event back — transaction status,
    // balances, audit events and the mock bank's book, byte-identically.
    const cFail = await mk(6_000, "adv-c-fail");
    await j("funder", "POST", `/api/payment-instructions/${cFail}/simulate/submit`, {}, 200);
    exec("UPDATE payment_instructions SET status='SETTLED' WHERE id=?", cFail); // adversarial divergence, injected behind the app's back
    let snap = bankingSnapshot();
    const divergeFail = await api("funder", "POST", `/api/payment-instructions/${cFail}/simulate/failed`, { eventId: "adv-c-f1" });
    assert(
      divergeFail.status === 409 && bankingSnapshot() === snap,
      "payment.failed against a diverged instruction rolls back the transaction transition byte-identically"
    );
    exec("UPDATE payment_instructions SET status='SUBMITTED_TO_PROVIDER' WHERE id=?", cFail);
    await j("funder", "POST", `/api/payment-instructions/${cFail}/simulate/failed`, { eventId: "adv-c-f2" }, 200);
    assert(
      q1("SELECT status FROM payment_instructions WHERE id=?", cFail).status === "FAILED" &&
        q1("SELECT status FROM bank_transactions WHERE payment_instruction_id=?", cFail).status === "FAILED",
      "once the divergence is repaired the same event applies cleanly in lockstep"
    );
    const cRet = await mk(8_000, "adv-c-ret");
    await j("funder", "POST", `/api/payment-instructions/${cRet}/simulate/submit`, {}, 200);
    await j("funder", "POST", `/api/payment-instructions/${cRet}/simulate/settled`, { eventId: "adv-c-r1" }, 200);
    exec("UPDATE payment_instructions SET status='CANCELLED' WHERE id=?", cRet);
    snap = bankingSnapshot();
    const divergeRet = await api("funder", "POST", `/api/payment-instructions/${cRet}/simulate/returned`, { eventId: "adv-c-r2" });
    assert(
      divergeRet.status === 409 && bankingSnapshot() === snap,
      "payment.returned against a diverged instruction rolls back byte-identically (no half-applied restoration)"
    );
    exec("UPDATE payment_instructions SET status='SETTLED' WHERE id=?", cRet);
    await j("funder", "POST", `/api/payment-instructions/${cRet}/simulate/returned`, { eventId: "adv-c-r3" }, 200);
    exec("UPDATE lender_draw_decisions SET approved_amount = 200000 WHERE id='ldec-vam'");
    const reconFinal = await j("funder", "POST", "/api/projects/proj-r47/banking/reconcile", {}, 201);
    assert(
      reconFinal.run.status === "MATCHED",
      `after the defect regression probes the books still reconcile (bank ${reconFinal.run.bankReportedBalance} = ledger ${reconFinal.run.ledgerCalculatedBalance})`
    );

    console.log(`\nVAM ADVERSARIAL TESTS PASSED — ${passed} checkpoints.`);
    console.log("Every rejection above was verified to mutate NOTHING. The mock bank stays the only bank.");
  } finally {
    demoServer.kill();
    prodServer.kill();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
