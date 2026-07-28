/**
 * Adversarial authorization and tenant-isolation tests.
 *
 * Every other suite proves the application works for a legitimate user.
 * This one proves it REFUSES everyone else, using REAL object ids belonging
 * to a real second tenant — not invented ids, which any lookup would reject
 * anyway and which therefore prove nothing about the tenant boundary.
 *
 * The contract under test:
 *
 *   1. SAME-404 — an object in another tenant is indistinguishable from an
 *      object that does not exist. Not 403, which would confirm existence.
 *   2. Identity is unforgeable — the cookie is a signed token, so a raw id,
 *      an edited payload, a stripped MAC or a foreign-secret signature is
 *      simply "not signed in".
 *   3. Enforcement lives at the SERVICE boundary — the last section calls
 *      the services DIRECTLY, bypassing every route, and they still refuse.
 *   4. None of this changed financial or historical state: balances,
 *      payment instructions, ledger entries and approval records are
 *      counted before and after every denied attempt.
 *
 *   node scripts/authz-test.js
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHmac, randomUUID } = require("node:crypto");

const OBV_PORT = 3210;
const BASE = `http://127.0.0.1:${OBV_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-authz-"));
const SESSION_SECRET = "authz-suite-fixed-secret-not-a-real-credential";

// The suite reads the same database the server writes, and requires the
// compiled services directly for the bypass section. Both need this set
// BEFORE any dist module is loaded.
process.env.OBV_DATA_DIR = DATA_DIR;
process.env.OBV_SESSION_SECRET = SESSION_SECRET;

const { DatabaseSync } = require("node:sqlite");

let n = 0;
const pass = (m) => console.log(`  ✓ [${++n}] ${m}`);
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
  if (res.status >= 400) fail(`sign-in failed for ${userId}: ${res.status}`);
  jars[key] = res.headers.getSetCookie()[0].split(";")[0];
}
const req = (key, method, p, body) =>
  fetch(BASE + p, {
    method,
    headers: { cookie: jars[key] ?? "", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
const raw = (cookie, p) =>
  fetch(BASE + p, { headers: cookie ? { cookie } : {}, redirect: "manual" });

function db() {
  return new DatabaseSync(path.join(DATA_DIR, "obv.db"));
}
function q(sql, ...args) {
  const d = db();
  const r = d.prepare(sql).all(...args);
  d.close();
  return r;
}
function exec(sql, ...args) {
  const d = db();
  d.prepare(sql).run(...args);
  d.close();
}

/** Financial + historical state fingerprint — must never move in this suite. */
function stateFingerprint() {
  const one = (sql) => {
    try {
      return q(sql)[0]?.c ?? 0;
    } catch {
      return 0; // table absent in this build
    }
  };
  return {
    ledger: one("SELECT COUNT(*) AS c FROM ledger_entries"),
    approvals: one("SELECT COUNT(*) AS c FROM approval_records"),
    accountEvents: one("SELECT COUNT(*) AS c FROM virtual_account_events"),
    bankTx: one("SELECT COUNT(*) AS c FROM bank_transactions"),
    instructions: one("SELECT COUNT(*) AS c FROM payment_instructions"),
    bankingEvents: one("SELECT COUNT(*) AS c FROM banking_events"),
    evidence: one("SELECT COUNT(*) AS c FROM evidence_items"),
    balances: JSON.stringify(
      (() => {
        try {
          return q("SELECT id, available_minor, held_minor FROM project_virtual_accounts ORDER BY id");
        } catch {
          return [];
        }
      })()
    ),
  };
}

/** Mint a cookie value with an arbitrary secret — the forgery primitive. */
function forgeToken(userId, secret, { expMs = Date.now() + 60_000 } = {}) {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, iat: Date.now(), exp: expMs }),
    "utf8"
  ).toString("base64url");
  const mac = createHmac("sha256", secret).update(`v1.${payload}`).digest("base64url");
  return `v1.${payload}.${mac}`;
}

let child;
async function startServer() {
  child = spawn(process.execPath, ["dist/server/http/server.js"], {
    env: {
      ...process.env,
      PORT: String(OBV_PORT),
      OBV_DATA_DIR: DATA_DIR,
      OBV_SESSION_SECRET: SESSION_SECRET,
      OBV_BANKING_PROVIDER: "mock",
      OBV_BANKING_MODE: "demo",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  fail("server did not start");
}

(async () => {
  console.log(`Authorization / tenant-isolation tests — isolated server on :${OBV_PORT}`);
  const seed = spawn(process.execPath, ["dist/server/db/seed.js"], {
    env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
    stdio: "ignore",
  });
  await new Promise((r) => seed.on("exit", r));
  await startServer();

  try {
    // ============ build a REAL second tenant ============
    // A separate organisation with its own project manager. Everything this
    // tenant owns below is created through the real APIs, so the ids used in
    // the cross-tenant probes are genuine rows, not fabrications.
    exec(
      `INSERT INTO organizations (id, name, kind) VALUES ('org-rival', 'Rival Capital', 'FUNDER')`
    );
    exec(
      `INSERT INTO users (id, organization_id, name, role, title) VALUES
       ('user-rival', 'org-rival', 'Rival Manager', 'PROJECT_MANAGER', 'Programme Director')`
    );
    await signIn("funder", "user-funder"); // org-cdfc, owns proj-r47
    await signIn("rival", "user-rival"); // org-rival, owns nothing yet
    await signIn("field", "user-field");

    const rivalProj = await (
      await req("rival", "POST", "/api/pilot/projects", {
        name: "Rival Corridor Upgrade",
        organizationId: "org-rival",
        obvControlledAmount: 500000,
        currency: "USD",
      })
    ).json();
    const rivalProjectId = rivalProj.project.id;
    await req("rival", "POST", `/api/pilot/projects/${rivalProjectId}/template`, {
      templateKey: "road-rehabilitation",
    });
    const rivalMilestoneId = q(
      "SELECT id FROM milestones WHERE project_id = ? ORDER BY seq LIMIT 1",
      rivalProjectId
    )[0].id;
    assert(
      Boolean(rivalProjectId && rivalMilestoneId),
      `a second tenant exists with real objects (project ${rivalProjectId.slice(0, 8)}, milestone ${rivalMilestoneId.slice(0, 8)})`
    );

    // Ours, for the reverse direction.
    const ourMilestoneId = q(
      "SELECT id FROM milestones WHERE project_id = 'proj-r47' ORDER BY seq LIMIT 1"
    )[0].id;

    // A genuine thread owned by the rival tenant, so the direct chat-service
    // probe below runs against a real row rather than being skipped.
    await req("rival", "POST", "/api/threads/open", { projectId: rivalProjectId });

    const before = stateFingerprint();

    // ================= 1. FORGED AND MODIFIED COOKIES =================
    {
      const legacy = await raw("obv_user=user-funder", "/overview");
      assert(
        legacy.status === 302 || legacy.status === 303,
        "the pre-signature raw cookie (obv_user=user-funder) is dead — redirected to sign-in"
      );

      const good = jars.funder.slice("obv_user=".length);
      const [v, payload, mac] = good.split(".");
      const tampered = Buffer.from(
        JSON.stringify({ u: "user-rival", iat: Date.now(), exp: Date.now() + 60_000 }),
        "utf8"
      ).toString("base64url");
      const swapped = await raw(`obv_user=${v}.${tampered}.${mac}`, "/overview");
      assert(
        swapped.status === 302 || swapped.status === 303,
        "a payload edited to another user id, kept with the original MAC, is rejected"
      );

      const noMac = await raw(`obv_user=${v}.${payload}`, "/overview");
      assert(noMac.status === 302 || noMac.status === 303, "a token with the MAC stripped is rejected");

      const emptyMac = await raw(`obv_user=${v}.${payload}.`, "/overview");
      assert(emptyMac.status === 302 || emptyMac.status === 303, "a token with an empty MAC is rejected");

      const bumped = await raw(`obv_user=v2.${payload}.${mac}`, "/overview");
      assert(bumped.status === 302 || bumped.status === 303, "an unknown token version is rejected");

      const foreign = await raw(`obv_user=${forgeToken("user-funder", "a-different-secret-entirely")}`, "/overview");
      assert(
        foreign.status === 302 || foreign.status === 303,
        "a well-formed token signed with a DIFFERENT secret is rejected"
      );

      const expired = await raw(
        `obv_user=${forgeToken("user-funder", SESSION_SECRET, { expMs: Date.now() - 1000 })}`,
        "/overview"
      );
      assert(
        expired.status === 302 || expired.status === 303,
        "an expired but correctly-signed token is rejected"
      );

      const ok = await raw(jars.funder, "/overview");
      assert(ok.status === 200, "positive control: the genuine signed cookie still works");
    }

    // ================= 2. UNAUTHENTICATED ACCESS =================
    {
      const fc = await raw(null, "/api/field-context");
      assert(fc.status === 401, "GET /api/field-context requires a session (401)");

      const reset = await fetch(BASE + "/api/demo/reset", { method: "POST", redirect: "manual" });
      assert(reset.status === 403, "POST /api/demo/reset refuses an anonymous caller (403)");

      const page = await raw(null, "/overview");
      assert(page.status === 302 || page.status === 303, "page routes redirect an anonymous caller");

      const state = await raw(null, "/api/state");
      assert(
        state.status === 401,
        "GET /api/state requires a session — the fingerprint aggregates every tenant's activity"
      );

      const verify = await fetch(BASE + "/api/ledger/verify", { method: "POST", redirect: "manual" });
      assert(
        verify.status === 401,
        "POST /api/ledger/verify requires a session (it records a notification)"
      );

      const dispute = await raw(null, "/disputes");
      assert(
        dispute.status === 302 || dispute.status === 303,
        "dispute pages redirect an anonymous caller instead of failing on a null user"
      );
    }

    // ================= 3. CROSS-TENANT, REAL OBJECT IDS =================
    {
      const proj = await raw(jars.funder, `/project/${rivalProjectId}`);
      assert(proj.status === 404, "another tenant's project id returns 404, not 403");

      const missing = await raw(jars.funder, `/project/${randomUUID()}`);
      assert(
        missing.status === proj.status,
        "same-404: a nonexistent project and a foreign project are indistinguishable"
      );

      const ms = await raw(jars.funder, `/milestone/${rivalMilestoneId}`);
      assert(ms.status === 404, "another tenant's milestone id returns 404");

      const preview = await raw(jars.funder, `/report/${rivalProjectId}/preview`);
      assert(preview.status === 404, "another tenant's funder report preview returns 404");

      const reverse = await raw(jars.rival, "/project/proj-r47");
      assert(reverse.status === 404, "the boundary holds in both directions");

      const exportRes = await raw(jars.funder, `/api/pilot/projects/${rivalProjectId}/export`);
      assert(exportRes.status === 404, "another tenant's pilot export returns 404");
    }

    // ================= 4. CROSS-TENANT APPROVAL / ORCHESTRATION =========
    {
      // Give the rival tenant a genuine pending approval request.
      exec(
        `INSERT INTO approval_requests (id, milestone_id, status, required_roles, created_at, subject_type)
         VALUES ('appr-rival', ?, 'PENDING', '["PROJECT_MANAGER"]', '2026-07-01T00:00:00.000Z', 'MILESTONE')`,
        rivalMilestoneId
      );
      const decide = await req("funder", "POST", "/api/approvals/appr-rival/decision", {
        decision: "APPROVED",
      });
      assert(
        decide.status === 404,
        "a tranche release cannot be approved across tenants — 404, and never a role/SoD message that would confirm the request exists"
      );
      assert(
        q("SELECT COUNT(*) AS c FROM approval_records WHERE approval_request_id = 'appr-rival'")[0].c === 0,
        "the refused approval recorded no decision"
      );
      assert(
        q("SELECT status AS s FROM approval_requests WHERE id = 'appr-rival'")[0].s === "PENDING",
        "the refused approval left the request PENDING"
      );
    }

    // ================= 5. NESTED-OBJECT SUBSTITUTION =================
    {
      // Our project id, THEIR milestone id.
      const issue = await req("funder", "POST", "/api/issues", {
        projectId: "proj-r47",
        milestoneId: rivalMilestoneId,
        title: "Substituted milestone",
        description: "x",
        category: "OTHER",
        severity: "LOW",
      });
      assert(
        issue.status === 404,
        "a field issue naming our project but ANOTHER tenant's milestone is refused"
      );

      const clar = await req("funder", "POST", "/api/clarifications", {
        milestoneId: rivalMilestoneId,
        question: "Explain",
        responseType: "TEXT",
      });
      assert(clar.status === 404, "a clarification against another tenant's milestone is refused");

      const ev = await req("funder", "POST", "/api/evidence", {
        milestoneId: rivalMilestoneId,
        demoPhotoId: "demo-1",
        capturedAt: new Date().toISOString(),
        deviceMetadata: {},
      });
      assert(
        ev.status === 404,
        "evidence cannot be attached to another tenant's milestone (no ledger entry, no approval request)"
      );
      assert(
        q("SELECT COUNT(*) AS c FROM evidence_items WHERE milestone_id = ?", rivalMilestoneId)[0].c === 0,
        "the refused submission created no evidence row"
      );
    }

    // ================= 6. SAME TENANT, UNAUTHORIZED ROLE =================
    {
      const launch = await req("field", "POST", `/api/pilot/projects/${rivalProjectId}/launch`, {});
      assert(
        launch.status === 403 || launch.status === 404,
        "a FIELD user cannot administer pilot configuration"
      );
      const ourLaunch = await req("field", "POST", "/api/pilot/projects/proj-r47/launch", {});
      assert(
        ourLaunch.status === 403,
        "role gating still applies inside the caller's own tenant (403, not 404 — existence is already known)"
      );
    }

    // ================= 7. WORM EVIDENCE OBJECTS =================
    {
      const anon = await raw(null, "/worm/" + "a".repeat(64) + ".png");
      assert(anon.status === 404, "WORM evidence media requires a session");
      const signedIn = await raw(jars.funder, "/worm/" + "a".repeat(64) + ".png");
      assert(
        signedIn.status === 404,
        "a nonexistent WORM object returns the same 404 to a signed-in caller — no existence oracle"
      );
    }

    // ================= 8. REPORT ACCESS =================
    {
      // A genuine report row owned by the rival tenant.
      exec(
        `INSERT INTO reports (id, project_id, report_type, filename, generated_at, generated_by, integrity_status, ledger_entries)
         VALUES ('rep-rival', ?, 'VERIFICATION_FUND_RELEASE', 'rival.pdf', '2026-07-01T00:00:00.000Z', 'user-rival', 'INTACT', 0)`,
        rivalProjectId
      );
      const dl = await raw(jars.funder, "/reports/file/rep-rival");
      assert(
        dl.status === 404,
        "a non-package report PDF is not downloadable across tenants (this type was previously unchecked)"
      );
      const list = await (await raw(jars.funder, "/reports")).text();
      assert(
        !list.includes("rep-rival"),
        "the reports register does not list another tenant's reports"
      );
    }

    // ================= 9. PREVIEW / RENDER TOKENS =================
    {
      const { mintRenderToken, consumeRenderToken, outstandingRenderTokens } =
        require(path.join(process.cwd(), "dist/server/http/previewToken.js"));

      const t1 = mintRenderToken("report-A");
      assert(consumeRenderToken(t1, "report-B") === false, "a render token minted for one report is refused for another");

      const t2 = mintRenderToken("report-A");
      assert(consumeRenderToken(t2, "report-A") === true, "a render token works once for its own subject");
      assert(consumeRenderToken(t2, "report-A") === false, "a render token is single-use — replay is refused");

      const t3 = mintRenderToken("report-A", -1);
      assert(consumeRenderToken(t3, "report-A") === false, "an expired render token is refused");

      assert(consumeRenderToken("not-a-token", "report-A") === false, "an invented render token is refused");
      assert(outstandingRenderTokens() === 0, "consumed and expired tokens are not retained");

      // The token is single-purpose: it is not a session anywhere else.
      const t4 = mintRenderToken("proj-r47");
      const viaToken = await raw(null, `/report/proj-r47/preview?token=${t4}`);
      assert(
        viaToken.status === 302 || viaToken.status === 303,
        "a valid render token is not accepted in place of a session on any other route"
      );
    }

    // ================= 10. ENUMERATION =================
    {
      const demo = await (await raw(null, "/demo")).text();
      assert(demo.includes("user-funder"), "the demo switcher still lists seeded identities");
      const uuidUser = randomUUID();
      exec(
        `INSERT INTO users (id, organization_id, name, role, title) VALUES (?, 'org-cdfc', 'Real Invitee', 'FIELD', 'Engineer')`,
        uuidUser
      );
      const demo2 = await (await raw(null, "/demo")).text();
      assert(
        !demo2.includes(uuidUser) && !demo2.includes("Real Invitee"),
        "a user created by a real invitation is never enumerated on the demo switcher"
      );
      const assume = await fetch(BASE + "/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: uuidUser }),
        redirect: "manual",
      });
      assert(
        assume.status === 404 && assume.headers.getSetCookie().length === 0,
        "the switcher cannot assume a non-seeded identity, and issues no cookie"
      );
      const unknown = await fetch(BASE + "/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-does-not-exist" }),
        redirect: "manual",
      });
      assert(
        unknown.status === assume.status,
        "unknown and non-seeded ids produce the identical response — no existence oracle"
      );
    }

    // ============ 11. DIRECT SERVICE INVOCATION (ROUTE BYPASS) ============
    // The routes are not the boundary. These calls skip HTTP entirely and
    // must still be refused, which is what makes an internal call path
    // (another service, a page handler, a webhook) safe.
    {
      const repo = require(path.join(process.cwd(), "dist/server/db/repo.js"));
      const authz = require(path.join(process.cwd(), "dist/server/services/authz.js"));
      const chat = require(path.join(process.cwd(), "dist/server/services/chat.js"));
      const fieldOps = require(path.join(process.cwd(), "dist/server/services/fieldOps.js"));
      const orchestrator = require(path.join(process.cwd(), "dist/server/workflow/orchestrator.js"));
      const reportData = require(path.join(process.cwd(), "dist/server/report/data.js"));

      const funder = repo.getUser("user-funder");
      const rival = repo.getUser("user-rival");

      assert(
        authz.canAccessProject(funder, repo.getProject(rivalProjectId)) === false &&
          authz.canAccessProject(rival, repo.getProject("proj-r47")) === false,
        "authz.canAccessProject refuses both directions at the predicate level"
      );

      let threw = false;
      try {
        authz.requireProject(funder, rivalProjectId);
      } catch (e) {
        threw = e.statusCode === 404;
      }
      assert(threw, "authz.requireProject throws the same-404 when called directly");

      threw = false;
      try {
        await orchestrator.processApprovalDecision("appr-rival", "user-funder", "APPROVED");
      } catch (e) {
        threw = e.statusCode === 404;
      }
      assert(threw, "orchestrator.processApprovalDecision refuses a cross-tenant caller when invoked directly");

      threw = false;
      try {
        await orchestrator.processEvidenceSubmission(
          { milestoneId: rivalMilestoneId, demoPhotoId: "demo-1", capturedAt: new Date().toISOString(), deviceMetadata: {} },
          "user-funder"
        );
      } catch (e) {
        threw = e.statusCode === 404;
      }
      assert(threw, "orchestrator.processEvidenceSubmission refuses a cross-tenant milestone when invoked directly");

      threw = false;
      try {
        fieldOps.createFieldIssue({
          projectId: rivalProjectId,
          milestoneId: null,
          sourceMessage: null,
          title: "direct",
          description: "x",
          category: "OTHER",
          severity: "LOW",
          assignedToUserId: null,
          dueAt: null,
          createdBy: funder,
        });
      } catch (e) {
        threw = e.statusCode === 404;
      }
      assert(threw, "fieldOps.createFieldIssue refuses a cross-tenant project when invoked directly");

      const assembled = await reportData.assembleReportData(rivalProjectId, funder);
      assert(
        assembled === null,
        "report/data.assembleReportData returns null for a cross-tenant project — the assembly boundary itself refuses"
      );
      const ownAssembled = await reportData.assembleReportData("proj-r47", funder);
      assert(
        ownAssembled !== null,
        "positive control: the owning tenant still assembles its own report"
      );

      const rivalThreadId = q(
        "SELECT id FROM conversation_threads WHERE project_id = ? LIMIT 1",
        rivalProjectId
      )[0]?.id;
      if (rivalThreadId) {
        threw = false;
        try {
          chat.getThreadForUser(funder, rivalThreadId);
        } catch (e) {
          threw = e.statusCode === 404;
        }
        assert(threw, "chat.getThreadForUser refuses another tenant's thread when invoked directly");
      } else {
        fail("fixture error: the rival tenant has no thread to probe");
      }

      assert(
        chat.listThreadsForUser(funder).every((t) => t.projectId !== rivalProjectId),
        "chat.listThreadsForUser never returns another tenant's threads"
      );
      assert(
        fieldOps.listFieldIssuesForUser(funder).every((i) => i.projectId !== rivalProjectId),
        "fieldOps.listFieldIssuesForUser never returns another tenant's issues"
      );
    }

    // ============ 12. NOTHING FINANCIAL OR HISTORICAL MOVED ============
    {
      const after = stateFingerprint();
      const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
      assert(
        changed.length === 0,
        `no denied attempt altered financial or historical state (ledger, approval records, account events, bank transactions, payment instructions, banking events, evidence, balances all unchanged)`
      );
      assert(
        after.instructions === before.instructions && after.bankTx === before.bankTx,
        "no payment instruction or bank transaction was created by any refused action"
      );
      assert(
        after.balances === before.balances,
        "virtual account balances are byte-identical before and after the entire suite"
      );
    }

    console.log(`\nAUTHORIZATION TESTS PASSED — ${n} checkpoints.`);
  } finally {
    if (child) child.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
