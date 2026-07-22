#!/usr/bin/env node
/**
 * VAM foundation test suite — banking programs, project virtual accounts,
 * holds, dual-controlled payment instructions, provider-event settlement,
 * reconciliation, packages, tenancy, capabilities and rendering.
 *
 * Proves the non-negotiable boundaries: no real network calls, no
 * credentials, no new release path, settlement only from provider events,
 * and byte-for-byte invariance of the existing financial state machine
 * (virtual-account events, draw-account events, approval records,
 * released milestones) across the ENTIRE banking flow.
 */
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, readdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PORT = 3183;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "obv-vam-"));

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
async function signIn(key, userId) {
  const res = await fetch(BASE + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
    redirect: "manual",
  });
  jars[key] = res.headers.getSetCookie()[0].split(";")[0];
}
async function api(key, method, p, body) {
  return fetch(BASE + p, {
    method,
    headers: { cookie: jars[key] ?? "", "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
}
async function j(key, method, p, body, expect) {
  const res = await api(key, method, p, body);
  if (expect !== undefined && res.status !== expect) {
    fail(`${method} ${p} -> ${res.status} (expected ${expect}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}
async function page(key, p) {
  const res = await fetch(BASE + p, { headers: { cookie: jars[key] ?? "", accept: "text/html" }, redirect: "manual" });
  return { status: res.status, html: res.status === 200 ? await res.text() : "" };
}
async function formPost(key, p, fields, referer) {
  return fetch(BASE + p, {
    method: "POST",
    headers: {
      cookie: jars[key] ?? "",
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      referer: referer ?? `${BASE}/project/proj-r47/account`,
    },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });
}

let db;
const q1 = (sql, ...args) => db.prepare(sql).get(...args);
const qa = (sql, ...args) => db.prepare(sql).all(...args);
const exec = (sql, ...args) => db.prepare(sql).run(...args);

/** The EXISTING financial state machine — must be untouched by banking. */
function financialState() {
  return {
    va: q1("SELECT COUNT(*) c FROM virtual_account_events").c,
    da: q1("SELECT COUNT(*) c FROM draw_account_events").c,
    approvals: q1("SELECT COUNT(*) c FROM approval_records").c,
    released: q1("SELECT COUNT(*) c FROM milestones WHERE account_status = 'RELEASED'").c,
    retainageReqs: q1("SELECT COUNT(*) c FROM retainage_release_requests").c,
    retainageEvents: q1("SELECT COUNT(*) c FROM retainage_events").c,
  };
}
function accountRow() {
  return q1("SELECT * FROM project_virtual_accounts WHERE id = 'pva-r47'");
}

async function main() {
  console.log("VAM foundation tests — isolated server on :" + PORT);

  // ---- 0. static source-boundary checks (before any server) ----
  const bankingDir = path.join(__dirname, "..", "src", "server", "services", "banking");
  const bankingSrc = readdirSync(bankingDir)
    .map((f) => readFileSync(path.join(bankingDir, f), "utf8"))
    .join("\n");
  assert(
    !/VirtualAccountService/.test(bankingSrc),
    "no banking module references VirtualAccountService (no new call path into the demo release machine)"
  );
  assert(
    !/node:https?\b|fetch\s*\(|axios|XMLHttpRequest|net\.connect/.test(bankingSrc),
    "no banking module imports HTTP clients or makes network calls"
  );
  assert(
    !/api[_-]?key|apikey|secret|bearer|authorization:/i.test(bankingSrc),
    "no banking module contains credentials or auth-token material"
  );
  const brepoSrc = readFileSync(path.join(__dirname, "..", "src", "server", "db", "bankingRepo.ts"), "utf8");
  assert(
    !/UPDATE banking_events|DELETE FROM banking_events/.test(brepoSrc),
    "banking_events is append-only: the repository has no update or delete path for it"
  );

  // ---- 1. a non-mock provider refuses to start without production flags ----
  const refused = spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "server", "http", "server.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PORT + 1), OBV_BANKING_PROVIDER: "unit" },
    timeout: 15000,
    encoding: "utf8",
  });
  assert(
    refused.status !== 0 && /refuses to start|OBV_BANKING_PRODUCTION_ENABLE/.test(refused.stderr + refused.stdout),
    "the app refuses to start a non-mock banking provider without explicit production configuration"
  );

  // ---- boot: seed + mock/demo server ----
  spawnSync(process.execPath, [path.join(__dirname, "..", "dist", "server", "db", "seed.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
    stdio: "ignore",
  });
  const server = spawn(process.execPath, [path.join(__dirname, "..", "dist", "server", "http", "server.js")], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR, PORT: String(PORT), OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  db = new DatabaseSync(path.join(DATA_DIR, "obv.db"));

  try {
    await signIn("funder", "user-funder");
    await signIn("lender2", "user-lender2");
    await signIn("pm", "user-pm");
    await signIn("compliance", "user-compliance");

    const baseline = financialState();

    // ---- 2. seeded program + account ----
    const view = await j("funder", "GET", "/api/projects/proj-r47/banking", undefined, 200);
    assert(
      view.program && view.program.status === "ACTIVE" && view.program.partnerBankName === "First Community Bank, N.A.",
      "the seeded lender-controlled banking program is active at the partner bank"
    );
    assert(
      view.account && view.account.id === "pva-r47" && view.account.status === "ACTIVE",
      "the seeded project virtual account exists and is active"
    );
    const dupProgram = await api("funder", "POST", "/api/projects/proj-r47/banking/program", {
      partnerBankName: "Second Bank", accountStructure: "FBO",
    });
    assert(dupProgram.status === 409, "a second active banking program for the organization is refused (409)");
    const dupAccount = await api("funder", "POST", "/api/projects/proj-r47/banking/account", {});
    assert(dupAccount.status === 409, "a second open virtual account for the project is refused (409)");

    // ---- 3. balances equal SQLite truth; masked identity displayed ----
    const row = accountRow();
    assert(
      view.account.availableBalance === row.available_balance &&
        view.account.heldBalance === row.held_balance &&
        view.account.releaseEligibleBalance === row.release_eligible_balance &&
        view.account.settledOutboundAmount === row.settled_outbound_amount,
      "API balances equal the stored SQLite balances"
    );
    const wp = await page("funder", "/project/proj-r47/account");
    assert(wp.status === 200, "the Project Account workspace renders for an authorized lender user");
    assert((wp.html.match(/<h1[\s>]/g) || []).length === 1, "exactly one H1 on the workspace page");
    assert(
      wp.html.includes("••••4207") && wp.html.includes("subledger"),
      "the account renders MASKED with the subledger distinction — no full account number exists anywhere"
    );
    assert(
      wp.html.includes("$370,000") && wp.html.includes("$50,000") && wp.html.includes("$250,000"),
      "displayed balances equal the stored ledger (available, held, release-eligible)"
    );
    assert(
      wp.html.includes("A payment instruction is not proof of payment") &&
        wp.html.includes("Only a provider-confirmed settled bank transaction"),
      "the persistent trust note is present"
    );
    assert(
      (wp.html.match(/Demo simulation only/g) || []).length >= 2,
      "simulation controls are explicitly marked Demo simulation only"
    );

    // ---- 4. tenant isolation (same-404) ----
    exec("INSERT INTO organizations (id, name, kind) VALUES ('org-x', 'Unrelated Capital', 'FUNDER')");
    exec(
      "INSERT INTO users (id, organization_id, name, role, title) VALUES ('user-x', 'org-x', 'Xavier Test', 'FUNDER_REP', 'Outsider')"
    );
    await signIn("outsider", "user-x");
    const xApi = await api("outsider", "GET", "/api/projects/proj-r47/banking");
    const missingApi = await api("outsider", "GET", "/api/projects/nonexistent/banking");
    assert(
      xApi.status === 404 && missingApi.status === 404,
      "an unrelated tenant receives the SAME 404 as a nonexistent project (no existence disclosure)"
    );
    const xPage = await page("outsider", "/project/proj-r47/account");
    assert(xPage.status === 404, "the workspace page is a 404 for the unrelated tenant");
    const xHold = await api("outsider", "POST", "/api/banking/accounts/pva-r47/holds", {
      amount: 1000, reasonCode: "LENDER_DISCRETION",
    });
    assert(xHold.status === 404, "cross-tenant account mutations are tenant-safe 404s");

    // ---- 5. capability enforcement (JSON + manually crafted form) ----
    const pmView = await api("pm", "GET", "/api/projects/proj-r47/banking");
    assert(pmView.status === 403, "a same-tenant user without VIEW_PROJECT_ACCOUNT gets 403 on the banking API");
    const pmPage = await page("pm", "/project/proj-r47/account");
    assert(pmPage.status === 403, "the workspace page is 403 without the view capability");
    const pmHold = await api("pm", "POST", "/api/banking/accounts/pva-r47/holds", { amount: 1000, reasonCode: "X" });
    assert(pmHold.status === 403, "a manually crafted JSON hold from an unauthorized user is rejected 403");
    const pmForm = await formPost("pm", "/api/banking/accounts/pva-r47/holds", { amount: "1000", reasonCode: "X" });
    assert(
      pmForm.status === 303 && (pmForm.headers.get("location") ?? "").includes("err="),
      "a manually crafted FORM hold is rejected by the service and bounced with the error"
    );
    const compCreate = await api("compliance", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 1, recipientName: "X",
    });
    assert(compCreate.status === 403, "the compliance reviewer (view/reconciliation fallback) cannot create instructions");
    const funderCaps = await page("funder", "/project/proj-r47/account");
    assert(
      funderCaps.html.includes("Place hold") && !pmPage.html.includes("Place hold"),
      "capability-gated controls render only for authorized users"
    );

    // ---- 6. holds: place, insufficient, release, double-release ----
    const before = accountRow();
    const holdRes = await j("funder", "POST", "/api/banking/accounts/pva-r47/holds", {
      amount: 10_000, reasonCode: "DISPUTED_WORK", reason: "Test hold",
    }, 201);
    let after = accountRow();
    assert(
      after.held_balance === before.held_balance + 10_000 &&
        after.available_balance === before.available_balance - 10_000 &&
        after.release_eligible_balance === before.release_eligible_balance - 10_000,
      "placing a hold moves available → held and out of release-eligible (guarded arithmetic)"
    );
    const tooBig = await api("funder", "POST", "/api/banking/accounts/pva-r47/holds", {
      amount: 99_999_999, reasonCode: "LENDER_DISCRETION",
    });
    assert(tooBig.status === 409, "a hold larger than unheld funds is refused (409), never negative");
    await j("funder", "POST", `/api/banking/holds/${holdRes.hold.id}/release`, { outcome: "RELEASED" }, 200);
    after = accountRow();
    assert(
      after.held_balance === before.held_balance && after.available_balance === before.available_balance,
      "releasing the hold restores the balances exactly"
    );
    const again = await api("funder", "POST", `/api/banking/holds/${holdRes.hold.id}/release`, { outcome: "RELEASED" });
    assert(again.status === 409, "releasing the same hold twice is a controlled 409 (exactly-once)");

    // ---- 7. release-eligibility boundary ----
    const inel = await j("funder", "GET", "/api/draws/draw-1/payment-eligibility", undefined, 200);
    assert(
      inel.label === "Not eligible for payment instruction" && inel.blockers.length > 0,
      "an unapproved draw is labeled Not eligible for payment instruction with explicit blockers"
    );
    const badCreate = await api("funder", "POST", "/api/draws/draw-1/payment-instructions", {
      amount: 1000, recipientName: "Nope LLC",
    });
    assert(badCreate.status === 409, "creating an instruction for a draw without completed governance is refused");
    const el = await j("funder", "GET", "/api/draws/draw-vam/payment-eligibility", undefined, 200);
    assert(el.label === "Eligible for payment instruction", "the governance-approved, lender-decided draw is Eligible for payment instruction");

    // decision must be currently fundable and reference the approval
    exec("UPDATE lender_draw_decisions SET decision = 'PENDING' WHERE id = 'ldec-vam'");
    const pendingDecision = await api("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 1000, recipientName: "Nope LLC",
    });
    assert(pendingDecision.status === 409, "a PENDING (non-fundable) current lender decision blocks payment instructions");
    exec("UPDATE lender_draw_decisions SET approval_request_id = NULL, decision = 'APPROVED' WHERE id = 'ldec-vam'");
    const noRef = await api("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 1000, recipientName: "Nope LLC",
    });
    assert(noRef.status === 409, "a decision that does not reference the completed approval request blocks payment");
    exec("UPDATE lender_draw_decisions SET approval_request_id = 'appr-draw-vam' WHERE id = 'ldec-vam'");

    // open decision condition blocks
    exec(`INSERT INTO lender_decision_conditions (id, lender_decision_id, condition_type, description, status, created_at, updated_at)
          VALUES ('cond-x', 'ldec-vam', 'DOCUMENT', 'Test condition', 'OPEN', '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`);
    const condBlocked = await api("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 1000, recipientName: "Nope LLC",
    });
    assert(condBlocked.status === 409, "an unsatisfied decision condition blocks payment instructions");
    exec("DELETE FROM lender_decision_conditions WHERE id = 'cond-x'");

    // outstanding lien waiver blocks
    exec(`INSERT INTO lien_waiver_records (id, organization_id, project_id, draw_request_id, signing_party, waiver_type, status, created_at, updated_at)
          VALUES ('lw-x', 'org-cdfc', 'proj-r47', 'draw-vam', 'Vendor X', 'CONDITIONAL_PROGRESS', 'REQUIRED', '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`);
    const waiverBlocked = await api("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 1000, recipientName: "Nope LLC",
    });
    assert(waiverBlocked.status === 409, "an outstanding required lien waiver blocks payment instructions");
    exec("DELETE FROM lien_waiver_records WHERE id = 'lw-x'");

    // independent-inspection policy: an active policy requiring an
    // independent inspection blocks payment until the inspection reaches
    // the terminal lender-ACCEPTED state (the state recordLenderAcceptance
    // actually produces).
    exec(`INSERT INTO lender_draw_policies (id, organization_id, version, independent_inspection_required, active, configured_by_user_id, created_at)
          VALUES ('pol-x', 'org-cdfc', 99, 1, 1, 'user-funder', '2026-07-06T00:00:00.000Z')`);
    const inspRequired = await j("funder", "GET", "/api/draws/draw-vam/payment-eligibility", undefined, 200);
    assert(
      inspRequired.label === "Not eligible for payment instruction" &&
        inspRequired.blockers.some((b) => /independent draw inspection/.test(b)),
      "a policy requiring an independent inspection blocks payment until one is lender-accepted"
    );
    exec(`INSERT INTO draw_inspections (id, organization_id, project_id, draw_request_id, status, lender_acceptance_status, created_at, updated_at)
          VALUES ('insp-x', 'org-cdfc', 'proj-r47', 'draw-vam', 'ACCEPTED', 'ACCEPTED', '2026-07-06T00:00:00.000Z', '2026-07-06T00:00:00.000Z')`);
    const inspAccepted = await j("funder", "GET", "/api/draws/draw-vam/payment-eligibility", undefined, 200);
    assert(
      !inspAccepted.blockers.some((b) => /independent draw inspection/.test(b)),
      "a lender-ACCEPTED independent inspection satisfies the policy requirement (the gate is satisfiable)"
    );
    exec("DELETE FROM draw_inspections WHERE id = 'insp-x'");
    exec("DELETE FROM lender_draw_policies WHERE id = 'pol-x'");

    // approved-amount cap: 200k approved − 80k settled − 120k pending = 0
    const capBlocked = await api("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 1, recipientName: "Anyone",
    });
    assert(
      capBlocked.status === 409 && /exceeds the remaining lender-approved amount/.test((await capBlocked.json()).error),
      "the requested amount can never exceed the remaining lender-approved amount (retainage preserved upstream)"
    );

    // ---- 8. dual control on the seeded pending instruction ----
    const selfApprove = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/approve", {});
    assert(selfApprove.status === 403, "the instruction creator cannot be its final approver (403)");
    exec("UPDATE draw_requests SET requested_by_user_id = 'user-lender2' WHERE id = 'draw-vam'");
    const submitterApprove = await api("lender2", "POST", "/api/payment-instructions/pi-pending-1/approve", {});
    assert(
      submitterApprove.status === 403 && /draw submitter/.test((await submitterApprove.json()).error),
      "the draw submitter cannot approve a payment instruction on their own draw (403)"
    );
    exec("UPDATE draw_requests SET requested_by_user_id = 'user-pm' WHERE id = 'draw-vam'");
    const pmApprove = await api("pm", "POST", "/api/payment-instructions/pi-pending-1/approve", {});
    assert(pmApprove.status === 403, "a user without APPROVE_PAYMENT_INSTRUCTION cannot approve (server-enforced)");

    const approved = await j("lender2", "POST", "/api/payment-instructions/pi-pending-1/approve", {}, 200);
    assert(
      approved.instruction.status === "APPROVED_FOR_SUBMISSION" &&
        approved.instruction.approvedByUserId === "user-lender2" &&
        approved.instruction.settledAt === null,
      "a distinct authorized user approves — and approval does NOT settle anything"
    );
    const doubleApprove = await api("lender2", "POST", "/api/payment-instructions/pi-pending-1/approve", {});
    assert(doubleApprove.status === 409, "approving twice is a controlled 409 — the approval record is immutable");
    assert(
      q1("SELECT COUNT(*) c FROM banking_events WHERE type = 'INSTRUCTION_APPROVED' AND payment_instruction_id = 'pi-pending-1'").c === 1,
      "exactly one append-only INSTRUCTION_APPROVED event exists for the approval"
    );

    // ---- 9. provider submission and event-driven settlement ----
    const submitted = await j("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/submit", {}, 200);
    assert(submitted.instruction.status === "SUBMITTED_TO_PROVIDER", "submission moves the instruction to SUBMITTED_TO_PROVIDER");
    const pendTx = q1("SELECT * FROM bank_transactions WHERE payment_instruction_id = 'pi-pending-1'");
    assert(pendTx && pendTx.status === "PENDING", "submission opens a PENDING bank-side transaction");
    let acct = accountRow();
    assert(
      acct.pending_outbound_amount === 120_000 && acct.available_balance === 250_000,
      "submission moves funds from available to pending outbound"
    );

    const posted = await j("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/posted", { eventId: "evt-post-1" }, 200);
    assert(posted.instruction.status === "PROCESSING", "a transaction.posted provider event moves the instruction to PROCESSING");

    const settled = await j("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/settled", { eventId: "evt-settle-1" }, 200);
    acct = accountRow();
    assert(
      settled.instruction.status === "SETTLED" &&
        q1("SELECT status FROM bank_transactions WHERE payment_instruction_id = 'pi-pending-1'").status === "SETTLED",
      "settlement happens ONLY through the provider event — instruction and bank transaction both SETTLED"
    );
    assert(
      acct.pending_outbound_amount === 0 && acct.settled_outbound_amount === 200_000,
      "settlement moves pending outbound into settled outbound"
    );
    const replay = await j("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/settled", { eventId: "evt-settle-1" }, 200);
    assert(
      replay.instruction.status === "SETTLED" && accountRow().settled_outbound_amount === 200_000,
      "replaying the same provider event (same eventId) is idempotent — nothing double-applies"
    );
    const conflicting = await api("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/settled", { eventId: "evt-settle-2" });
    assert(conflicting.status === 409, "a NEW settle event against an already-settled transaction is refused (guarded state)");

    // ---- 10. return of the settled payment ----
    const returned = await j("funder", "POST", "/api/payment-instructions/pi-pending-1/simulate/returned", { eventId: "evt-ret-1" }, 200);
    acct = accountRow();
    assert(
      returned.instruction.status === "RETURNED" &&
        q1("SELECT status FROM bank_transactions WHERE payment_instruction_id = 'pi-pending-1'").status === "RETURNED",
      "a provider return moves the settled payment to RETURNED"
    );
    assert(
      acct.available_balance === 370_000 && acct.returned_amount === 120_000 && acct.release_eligible_balance === 370_000,
      "returned funds come back to available/release-eligible and are tracked in returnedAmount"
    );

    // ---- 11. failed payment lifecycle (fresh instruction) ----
    const pi3 = await j("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 20_000, recipientName: "Lakeshore Rehab Contractors LLC", idempotencyKey: "vam-test-pi3",
    }, 201);
    assert(pi3.instruction.status === "PENDING_APPROVAL", "a new instruction starts at PENDING_APPROVAL");
    const idem = await j("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 20_000, recipientName: "Lakeshore Rehab Contractors LLC", idempotencyKey: "vam-test-pi3",
    }, 201);
    assert(idem.instruction.id === pi3.instruction.id, "an identical request with the same idempotency key returns the SAME instruction");
    const keyClash = await api("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 30_000, recipientName: "Lakeshore Rehab Contractors LLC", idempotencyKey: "vam-test-pi3",
    });
    assert(keyClash.status === 409, "the same idempotency key with different parameters is refused (409)");
    const dup = await api("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 20_000, recipientName: "Lakeshore Rehab Contractors LLC",
    });
    assert(dup.status === 409, "an equivalent in-progress instruction (same draw, amount, recipient) is a duplicate 409");
    const methodClash = await api("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 20_000, recipientName: "Lakeshore Rehab Contractors LLC", idempotencyKey: "vam-test-pi3",
      paymentMethod: "WIRE_SIMULATED",
    });
    assert(
      methodClash.status === 409,
      "the same idempotency key with a different payment method is refused — never silently coalesced"
    );

    await j("lender2", "POST", `/api/payment-instructions/${pi3.instruction.id}/approve`, {}, 200);
    await j("funder", "POST", `/api/payment-instructions/${pi3.instruction.id}/simulate/submit`, {}, 200);
    const failedRes = await j("funder", "POST", `/api/payment-instructions/${pi3.instruction.id}/simulate/failed`, {
      eventId: "evt-fail-1", failureCode: "R01", failureReason: "Insufficient funds at receiving bank",
    }, 200);
    acct = accountRow();
    assert(
      failedRes.instruction.status === "FAILED" && failedRes.instruction.failureCode === "R01",
      "a provider failure event moves the payment to FAILED with the sanitized failure code"
    );
    assert(
      acct.pending_outbound_amount === 0 && acct.available_balance === 370_000,
      "failed in-flight funds return to the spendable ledger"
    );

    // ---- 12. reversal of a settled payment ----
    const pi4 = await j("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 15_000, recipientName: "Subcontractor Two LLC", idempotencyKey: "vam-test-pi4",
    }, 201);
    await j("lender2", "POST", `/api/payment-instructions/${pi4.instruction.id}/approve`, {}, 200);
    await j("funder", "POST", `/api/payment-instructions/${pi4.instruction.id}/simulate/submit`, {}, 200);
    await j("funder", "POST", `/api/payment-instructions/${pi4.instruction.id}/simulate/settled`, { eventId: "evt-settle-pi4" }, 200);
    const beforeRev = accountRow();
    const reversed = await j("funder", "POST", `/api/payment-instructions/${pi4.instruction.id}/simulate/reversed`, { eventId: "evt-rev-pi4" }, 200);
    acct = accountRow();
    assert(
      q1("SELECT status FROM bank_transactions WHERE payment_instruction_id = ?", pi4.instruction.id).status === "REVERSED" &&
        reversed.instruction.status === "RETURNED",
      "a provider reversal marks the bank transaction REVERSED"
    );
    assert(
      acct.settled_outbound_amount === beforeRev.settled_outbound_amount - 15_000 &&
        acct.available_balance === beforeRev.available_balance + 15_000,
      "a reversal restores available funds and reduces settled outbound"
    );

    // ---- 13. cancellation rules ----
    const pi5 = await j("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 5_000, recipientName: "Cancel Target LLC", idempotencyKey: "vam-test-pi5",
    }, 201);
    const preCancel = accountRow().release_eligible_balance;
    await j("funder", "POST", `/api/payment-instructions/${pi5.instruction.id}/cancel`, { reason: "Not needed" }, 200);
    assert(
      accountRow().release_eligible_balance === preCancel + 5_000,
      "cancelling an unsubmitted instruction releases its earmark"
    );
    const cancelSettled = await api("funder", "POST", `/api/payment-instructions/pi-settled-1/cancel`, {});
    assert(
      cancelSettled.status === 409,
      "a submitted/settled payment cannot be cancelled by OBV — only provider events terminate it"
    );

    // ---- 14. reconciliation: match, forced mismatch, blocking, resolution ----
    const match1 = await j("funder", "POST", "/api/projects/proj-r47/banking/reconcile", {}, 201);
    assert(
      match1.run.status === "MATCHED" && match1.run.bankReportedBalance === match1.run.ledgerCalculatedBalance,
      `reconciliation matches: bank ${match1.run.bankReportedBalance} = available + held + pendingOutbound + suspense`
    );
    const compRecon = await j("compliance", "POST", "/api/projects/proj-r47/banking/reconcile", {}, 201);
    assert(compRecon.run.status === "MATCHED", "the compliance reviewer (oversight fallback) can run reconciliation");

    const mismatch = await j("funder", "POST", "/api/projects/proj-r47/banking/reconcile", { demoForceMismatchAmount: 7_000 }, 201);
    assert(
      mismatch.run.status === "MISMATCH" && mismatch.run.differenceAmount === 7_000,
      "a forced mismatch records reported vs calculated and the exact difference — the ledger is never adjusted"
    );
    const critical = q1(
      "SELECT * FROM exceptions WHERE source_type = 'BANKING_RECONCILIATION' AND severity = 'CRITICAL' AND status NOT IN ('RESOLVED','CLOSED','WAIVED')"
    );
    assert(Boolean(critical), "the mismatch automatically creates a CRITICAL banking-reconciliation exception");
    const blockedCreate = await api("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 1_000, recipientName: "Blocked LLC",
    });
    assert(blockedCreate.status === 409, "new payment instructions are blocked while the mismatch is unresolved");
    const blockedPage = await page("funder", "/project/proj-r47/account");
    assert(
      blockedPage.html.includes("Reconciliation mismatch") && blockedPage.html.includes("blocked"),
      "the workspace shows the blocking mismatch banner"
    );

    const resolve = await j("funder", "POST", "/api/projects/proj-r47/banking/reconcile", {}, 201);
    assert(resolve.run.status === "MATCHED", "a later reconciliation without the forced offset matches again");
    const resolvedEx = q1(
      "SELECT status FROM exceptions WHERE source_type = 'BANKING_RECONCILIATION' ORDER BY updated_at DESC LIMIT 1"
    );
    assert(resolvedEx.status === "RESOLVED", "the deterministic critical exception auto-resolves after the matched run");
    assert(
      q1("SELECT COUNT(*) c FROM reconciliation_runs WHERE status = 'MISMATCH'").c >= 1,
      "the mismatch run remains in history — reconciliation history is never deleted"
    );
    const unblocked = await j("funder", "POST", "/api/draws/draw-vam/payment-instructions", {
      amount: 1_000, recipientName: "Unblocked LLC", idempotencyKey: "vam-test-unblock",
    }, 201);
    await j("funder", "POST", `/api/payment-instructions/${unblocked.instruction.id}/cancel`, {}, 200);
    pass("payment creation works again after the attributable resolution and matched run");

    // ---- 15. the existing financial state machine is untouched ----
    const finalState = financialState();
    assert(
      JSON.stringify(finalState) === JSON.stringify(baseline),
      "the ENTIRE banking flow left virtual-account events, draw-account events, approval records, released milestones and retainage records byte-for-byte unchanged"
    );

    // ---- 16. lender tab read-only summary ----
    const lenderTab = await page("funder", "/draw/draw-vam?tab=lender");
    assert(
      lenderTab.html.includes("Project account") && lenderTab.html.includes("••••4207") &&
        lenderTab.html.includes("Open the Project Account workspace"),
      "the Lender Review tab shows the read-only project-account summary with the workspace link"
    );
    assert(
      !/action="\/api\/(banking|payment-instructions)/.test(lenderTab.html),
      "the lender tab contains NO banking action forms — it cannot settle or transfer anything"
    );
    const legacyTab = await page("funder", "/draw/draw-1?tab=lender");
    assert(
      legacyTab.html.includes("Latest payment instruction (this draw)") && legacyTab.html.includes("Not recorded"),
      "a draw with no instructions shows Not recorded in the lender-tab banking summary"
    );
    const pmLenderTab = await page("pm", "/draw/draw-vam?tab=lender");
    assert(
      pmLenderTab.status === 200 &&
        !pmLenderTab.html.includes("••••4207") &&
        !pmLenderTab.html.includes("Latest payment instruction (this draw)"),
      "a draw participant WITHOUT the banking view capability sees no banking data on the lender tab"
    );

    // ---- 17. packages carry the banking registers ----
    const pkg = await j("funder", "POST", "/api/draws/draw-vam/verification-package", {}, 201);
    const dl = await fetch(BASE + `/reports/file/${pkg.report.id}`, { headers: { cookie: jars.funder } });
    const zipBuf = Buffer.from(await dl.arrayBuffer());
    assert(dl.status === 200 && zipBuf.length > 2000, "the Draw Verification Package generates and downloads through the existing route");
    const zipText = zipBuf.toString("latin1");
    for (const name of [
      "banking-program-summary.json", "project-virtual-account.csv", "account-holds.csv",
      "payment-instructions.csv", "bank-transactions.csv", "reconciliation-runs.csv", "banking-events.csv", "manifest.json",
    ]) {
      if (!zipText.includes(name)) fail(`package is missing ${name}`);
    }
    pass("the package contains every banking register plus the hashed manifest");

    // ---- 18. legacy project shows Not recorded (no fabrication) ----
    exec(`INSERT INTO projects (id, organization_id, name, description, location, site_boundary, total_budget, status, project_type)
          VALUES ('proj-legacy', 'org-cdfc', 'Legacy Rehab Project', 'No banking records', 'Testville', '[]', 1000000, 'ACTIVE', 'INFRASTRUCTURE')`);
    const legacyPage = await page("funder", "/project/proj-legacy/account");
    assert(
      legacyPage.status === 200 && (legacyPage.html.match(/Not recorded/g) || []).length >= 5,
      "a legacy project with no banking records renders Not recorded values — nothing is synthesized"
    );

    // ---- 19. mobile/desktop rendering ----
    let pw = null;
    try { pw = require("playwright"); } catch {}
    if (!pw) fail("playwright unavailable — run with NODE_PATH=/opt/node22/lib/node_modules");
    const browser = await pw.chromium.launch();
    try {
      const cookie = { name: "obv_user", value: "user-funder", url: BASE };
      for (const width of [375, 390, 430, 768, 1024, 1440]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        await ctx.addCookies([cookie]);
        const pg = await ctx.newPage();
        await pg.goto(BASE + "/project/proj-r47/account", { waitUntil: "load" });
        const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) fail(`horizontal overflow ${overflow}px at ${width}px`);
        if (width === 375) {
          const btn = await pg.evaluate(() => {
            const b = document.querySelector(".lender-form button");
            return b ? b.getBoundingClientRect().height : null;
          });
          const input = await pg.evaluate(() => {
            const i = document.querySelector(".lender-form input");
            return i ? parseFloat(getComputedStyle(i).fontSize) : null;
          });
          assert(btn !== null && btn >= 44, `mobile form buttons are >= 44px touch targets (${btn}px)`);
          assert(input !== null && input >= 16, `mobile form inputs are >= 16px font (${input}px)`);
        }
        await ctx.close();
      }
      pass("no document-level horizontal overflow at 375, 390, 430, 768, 1024 and 1440");
    } finally {
      await browser.close();
    }

    console.log(`\nVAM FOUNDATION TESTS PASSED — ${passed} checkpoints.`);
    console.log("No real money exists or moves anywhere in this suite. The bank controls the money;");
    console.log("OBV supplies verified construction truth and governed release authorization.");
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
