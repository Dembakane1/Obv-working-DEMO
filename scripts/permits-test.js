/**
 * Permit register, code basis, reinspection lifecycle, and official-source
 * provenance tests.
 *
 *   node scripts/permits-test.js   (isolated server on :3198)
 *
 * Doctrine under test: an uploaded permit, document, or official lookup
 * NEVER verifies work, passes an inspection, approves, or releases funds.
 * UNKNOWN never behaves as NOT_REQUIRED (or ACTIVE). Original inspection
 * results are immutable; reinspections extend the chain without rewriting
 * history. Only linked permits are control-relevant.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-permits-"));

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
async function j(key, method, p, body, expect = 200) {
  const res = await api(key, method, p, body);
  if (res.status !== expect && !(expect === 200 && res.status === 201)) {
    fail(`${method} ${p} -> ${res.status} (${(await res.text()).slice(0, 160)})`);
  }
  return res.json();
}
function db() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path.join(DATA_DIR, "obv.db"));
}
function exec(sql, ...args) {
  const d = db();
  d.prepare(sql).run(...args);
  d.close();
}
function q1(sql, ...args) {
  const d = db();
  const r = d.prepare(sql).get(...args);
  d.close();
  return r;
}
async function gates(milestoneId) {
  return (await j("funder", "GET", `/api/milestones/${milestoneId}/gates`)).gates;
}
const codes = (g) => g.eligibility.reasons.map((r) => r.code);

function readZip(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const entries = {};
  for (let k = 0; k < count; k++) {
    const size = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    entries[name] = buf.subarray(start, start + size);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

(async () => {
  console.log("Permit / code-basis / reinspection / official-source tests — :" + PORT);
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
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(BASE + "/api/health")).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    await signIn("funder", "user-funder");
    await signIn("pm", "user-pm");
    await signIn("compliance", "user-compliance");
    await signIn("field", "user-field");

    // ================= PART A · permit register =================
    const p1 = (await j("funder", "POST", "/api/projects/proj-r47/permits", {
      permitNumber: "DOB-2026-0001", permitType: "ROADWORKS",
      issuingAuthority: "Mzimba District Council", jurisdiction: "Mzimba District",
      status: "ISSUED", issuedAt: "2026-01-10", expiresAt: "2027-01-10",
    }, 201)).permit;
    const p2 = (await j("funder", "POST", "/api/projects/proj-r47/permits", {
      permitNumber: "ELEC-2026-0002", permitType: "ELECTRICAL",
      issuingAuthority: "Energy Board", status: "ACTIVE",
    }, 201)).permit;
    assert(p1.id && p2.id, "multiple permits recorded for one project");

    const dupNum = await api("funder", "POST", "/api/projects/proj-r47/permits", {
      permitNumber: "DOB-2026-0001", permitType: "ROADWORKS",
    });
    assert(dupNum.status === 409, "duplicate permit number within the project is rejected (409)");

    const badDates = await api("funder", "POST", "/api/projects/proj-r47/permits", {
      permitNumber: "BAD-1", permitType: "X", issuedAt: "2026-06-01", expiresAt: "2026-01-01",
    });
    const legacyOk = await api("funder", "POST", "/api/projects/proj-r47/permits", {
      permitNumber: "LEG-1", permitType: "X", issuedAt: "2026-06-01", expiresAt: "2026-01-01", legacyImport: true,
    });
    assert(badDates.status === 400 && legacyOk.status === 201,
      "expiration before issue is rejected unless the explicit legacy-import override is set");

    await j("funder", "POST", `/api/permits/${p1.id}/links`, { milestoneId: "ms-4" }, 201);
    await j("funder", "POST", `/api/permits/${p1.id}/links`, { milestoneId: "ms-5" }, 201);
    await j("funder", "POST", `/api/permits/${p2.id}/links`, { milestoneId: "ms-4" }, 201);
    const p1Links = (await j("funder", "GET", `/api/permits/${p1.id}`)).links;
    assert(p1Links.length === 2, "one permit links to multiple milestones (normalized rows, no comma lists)");
    const g4links = q1("SELECT COUNT(*) c FROM permit_milestone_links WHERE milestone_id = 'ms-4'").c;
    assert(g4links === 2, "one milestone links to multiple permits");
    const dupLink = await api("funder", "POST", `/api/permits/${p1.id}/links`, { milestoneId: "ms-4" });
    assert(dupLink.status === 409, "duplicate active permit-milestone link rejected");

    // Cross-project link: synthetic second project + milestone.
    const org = q1("SELECT organization_id o FROM projects WHERE id = 'proj-r47'").o;
    exec("INSERT INTO projects (id, organization_id, name, description, location, site_boundary, total_budget, status) VALUES ('proj-x', ?, 'Other', 'x', 'X', '[]', 1000, 'ACTIVE')", org);
    exec("INSERT INTO milestones (id, project_id, seq, title, requirement, tranche_amount, status, account_status) VALUES ('ms-x-1', 'proj-x', 1, 'X', 'x', 1000, 'NOT_STARTED', 'HELD')");
    const crossLink = await api("funder", "POST", `/api/permits/${p1.id}/links`, { milestoneId: "ms-x-1" });
    assert(crossLink.status === 404, "cross-project permit-milestone link rejected as not-found");

    // Cross-organization isolation: foreign org + user see 404 everywhere.
    exec("INSERT INTO organizations (id, name, kind) VALUES ('org-z', 'Unrelated Org', 'FUNDER')");
    exec("INSERT INTO users (id, organization_id, name, role, title) VALUES ('user-z', 'org-z', 'Zed Outsider', 'FUNDER_REP', 'Outsider')");
    await signIn("outsider", "user-z");
    const foreignGet = await api("outsider", "GET", `/api/permits/${p1.id}`);
    const foreignRegister = await api("outsider", "GET", "/api/projects/proj-r47/permits");
    const foreignPage = await api("outsider", "GET", "/project/proj-r47/permits");
    assert(
      foreignGet.status === 404 && foreignRegister.status === 404 && foreignPage.status === 404,
      "unrelated organization gets the same 404 as nonexistent records (API, JSON register, page)"
    );
    const anonReg = await fetch(BASE + "/api/projects/proj-r47/permits");
    assert(anonReg.status === 401, "unauthenticated permit API refused");

    assert(
      (await api("field", "POST", "/api/projects/proj-r47/permits", { permitNumber: "F-1", permitType: "X" })).status === 403,
      "field users cannot record permits (server-side, not just UI)"
    );

    // ================= PART B · code basis =================
    const cb = await j("compliance", "POST", `/api/permits/${p1.id}/code-basis`, {
      applicableCodeEdition: "2021 International Building Code",
      codeEffectiveDate: "2022-03-01",
      codeBasis: "Malawi National Construction Standards (2021 adoption)",
    });
    assert(
      cb.permit.applicableCodeEdition === "2021 International Building Code" &&
        cb.permit.codeDeterminedBy === "user-compliance" && cb.permit.codeDeterminedAt,
      "code edition recorded with basis, attributable reviewer, and timestamp"
    );
    assert(
      (await api("pm", "POST", `/api/permits/${p1.id}/code-basis`, { applicableCodeEdition: "X", codeBasis: "Y" })).status === 403,
      "project managers cannot determine the code basis"
    );
    const noReason = await api("compliance", "POST", `/api/permits/${p1.id}/code-basis`, {
      applicableCodeEdition: "2024 IBC", codeBasis: "New adoption",
    });
    assert(noReason.status === 400, "post-launch code-basis change without a reason is rejected");
    const auditBefore = q1("SELECT COUNT(*) c FROM config_audit WHERE action = 'CODE_BASIS_RECORDED'").c;
    const snapsBefore = q1("SELECT COUNT(*) c FROM config_snapshots WHERE project_id = 'proj-r47'").c;
    await j("compliance", "POST", `/api/permits/${p1.id}/code-basis`, {
      applicableCodeEdition: "2024 IBC", codeBasis: "Updated national adoption", reason: "Authority republished the adopted edition",
    });
    const auditAfter = q1("SELECT COUNT(*) c FROM config_audit WHERE action = 'CODE_BASIS_RECORDED'").c;
    const snapsAfter = q1("SELECT COUNT(*) c FROM config_snapshots WHERE project_id = 'proj-r47'").c;
    assert(
      auditAfter > auditBefore && snapsAfter > snapsBefore,
      "post-launch code-basis change with a reason is audited and configuration-snapshotted (prior values preserved)"
    );

    // ================= PART C · requirement configuration =================
    await j("funder", "POST", "/api/milestones/ms-4/inspection-requirement", {
      requirement: "REQUIRED", requirementBasis: "District roads act", inspectionType: "structural",
      permitRequired: true, officialSourceRequired: true, codeBasisRequired: true,
      permitMustBeActiveBeforeGovernance: true,
    });
    let g = await gates("ms-4");
    assert(
      !codes(g).some((c) => c.startsWith("PERMIT")) && !codes(g).includes("CODE_BASIS_MISSING"),
      "active linked permit with recorded code basis produces no permit/code blockers"
    );

    // Only LINKED permits are relevant: an unrelated expired permit changes nothing.
    const p3 = (await j("funder", "POST", "/api/projects/proj-r47/permits", {
      permitNumber: "OLD-1999", permitType: "DEMOLITION", status: "EXPIRED",
    }, 201)).permit;
    g = await gates("ms-4");
    assert(
      !codes(g).includes("PERMIT_EXPIRED"),
      "an unrelated project permit being expired never blocks a milestone it is not linked to"
    );

    await j("funder", "POST", `/api/permits/${p1.id}`, { status: "EXPIRED", reason: "Authority record shows expiration" });
    g = await gates("ms-4");
    assert(codes(g).includes("PERMIT_EXPIRED"), "linked expired permit produces the PERMIT_EXPIRED blocker");
    await j("funder", "POST", `/api/permits/${p2.id}`, { status: "REVOKED", reason: "Revoked by the energy board" });
    g = await gates("ms-4");
    assert(codes(g).includes("PERMIT_REVOKED"), "linked revoked permit produces the PERMIT_REVOKED blocker");
    await j("funder", "POST", `/api/permits/${p1.id}`, { status: "ACTIVE", reason: "Renewed with the district council" });
    await j("funder", "POST", `/api/permits/${p2.id}`, { status: "ACTIVE", reason: "Reinstated" });

    // codeBasisRequired without any code-basis permit → CODE_BASIS_MISSING (ms-5: p1 linked, strip its basis? p1 has basis).
    await j("funder", "POST", "/api/milestones/ms-5/inspection-requirement", {
      requirement: "REQUIRED", requirementBasis: "Final surfacing standard", inspectionType: "final",
      permitRequired: true, requiredPermitType: "SURFACING", codeBasisRequired: true,
      permitMustBeActiveBeforeGovernance: true,
    });
    g = await gates("ms-5");
    assert(
      codes(g).includes("REQUIRED_PERMIT_MISSING") && codes(g).includes("CODE_BASIS_MISSING"),
      "required permit type with no matching linked permit → REQUIRED_PERMIT_MISSING and CODE_BASIS_MISSING"
    );

    // ================= PART D · inspection + reinspection lifecycle =================
    const insp = (await j("funder", "POST", "/api/milestones/ms-4/inspections", {
      inspectionType: "structural", permitRefId: p1.id,
    }, 201)).inspection;
    assert(
      insp.permitRefId === p1.id && insp.jurisdiction === "Mzimba District",
      "inspection references the first-class permit and defaults jurisdiction from it"
    );
    await j("funder", "POST", `/api/inspections/${insp.id}/schedule`, { scheduledAt: "2026-07-20T09:00:00Z" });
    await j("funder", "POST", `/api/inspections/${insp.id}/complete`, {});

    const passNoSource = await api("funder", "POST", `/api/inspections/${insp.id}/result`, {
      result: "PASSED", governmentInspectorName: "Insp. T. Demo",
    });
    assert(passNoSource.status === 400, "PASSED cannot be recorded while the mandatory official source record is missing");

    const src = (await j("compliance", "POST", "/api/official-sources", {
      projectId: "proj-r47", inspectionId: insp.id,
      sourceType: "MANUAL_OFFICIAL_REFERENCE", officialSystemName: "District inspection portal",
      officialRecordNumber: "DC-DOB-99182", officialStatusText: "Corrections issued — see notice",
      officialRecordUrl: "https://portal.example.gov/rec/99182",
    }, 201)).record;
    assert(
      src.lookupPerformedByUserId === "user-compliance" && src.lookupPerformedAt &&
        src.officialStatusText === "Corrections issued — see notice",
      "official source is attributable (who + when) and keeps the official status text verbatim"
    );
    const inspAfterSource = q1("SELECT status FROM jurisdictional_inspections WHERE id = ?", insp.id).status;
    assert(
      inspAfterSource === "COMPLETED_PENDING_RESULT",
      "recording an official source (URL included) never creates a PASSED result by itself"
    );

    await j("funder", "POST", `/api/inspections/${insp.id}/result`, {
      result: "CORRECTIONS_REQUIRED", governmentInspectorName: "Insp. T. Demo",
      correctionNoticeReference: "DC-DOB-99182", correctionSummary: "Culvert headwall reinforcement missing",
      correctionDueAt: "2026-07-25",
    });
    g = await gates("ms-4");
    assert(
      g.inspectionGate === "CORRECTIONS_REQUIRED" &&
        codes(g).includes("INSPECTION_CORRECTIONS_REQUIRED") && codes(g).includes("REINSPECTION_REQUIRED"),
      "CORRECTIONS_REQUIRED gate state with machine-readable blocker codes"
    );

    const re = (await j("funder", "POST", `/api/inspections/${insp.id}/reinspection`, {}, 200)).inspection;
    assert(
      re.reinspectionOfInspectionId === insp.id &&
        q1("SELECT superseded_by_inspection_id s FROM jurisdictional_inspections WHERE id = ?", insp.id).s === re.id,
      "reinspection points to the prior inspection; the prior carries only a forward chain link"
    );
    g = await gates("ms-4");
    assert(
      g.inspectionGate === "AWAITING_REINSPECTION" && codes(g).includes("REINSPECTION_NOT_SCHEDULED"),
      "unscheduled reinspection derives the AWAITING_REINSPECTION gate state"
    );

    const overwrite = await api("funder", "POST", `/api/inspections/${insp.id}/result`, { result: "PASSED" });
    assert(overwrite.status === 409, "the original CORRECTIONS_REQUIRED result is immutable — overwrite rejected");
    const secondRe = await api("funder", "POST", `/api/inspections/${insp.id}/reinspection`, {});
    assert(secondRe.status === 409, "a superseded inspection cannot spawn a second parallel reinspection (no ambiguity)");
    const reOfPending = await api("funder", "POST", `/api/inspections/${re.id}/reinspection`, {});
    assert(reOfPending.status === 409, "a reinspection with no recorded result cannot itself be reinspected (no circular chains)");

    await j("funder", "POST", `/api/inspections/${re.id}/schedule`, { scheduledAt: "2026-07-28T09:00:00Z" });
    await j("funder", "POST", `/api/inspections/${re.id}/complete`, {});
    g = await gates("ms-4");
    assert(codes(g).includes("REINSPECTION_PENDING"), "completed reinspection awaiting result reports REINSPECTION_PENDING");

    await j("compliance", "POST", "/api/official-sources", {
      projectId: "proj-r47", inspectionId: re.id,
      sourceType: "OFFICIAL_PORTAL_LOOKUP", officialStatusText: "PASSED — final",
    }, 201);
    await j("funder", "POST", `/api/inspections/${re.id}/result`, {
      result: "PASSED", governmentInspectorName: "Insp. T. Demo",
    });
    g = await gates("ms-4");
    const original = q1("SELECT status, result FROM jurisdictional_inspections WHERE id = ?", insp.id);
    assert(
      g.inspectionGate === "PASSED" &&
        original.status === "CORRECTIONS_REQUIRED" && original.result === "CORRECTIONS_REQUIRED",
      "passed reinspection clears the gate while the original result remains historically unchanged"
    );
    assert(
      !codes(g).some((c) => c.startsWith("PERMIT") || c.includes("REINSPECTION") || c.includes("CORRECTIONS")),
      "passed reinspection with active permits restores eligibility (no permit/reinspection blockers remain)"
    );

    // Cancelled inspections never erase prior results.
    const extra = (await j("funder", "POST", "/api/milestones/ms-5/inspections", { inspectionType: "final" }, 201)).inspection;
    await j("funder", "POST", `/api/inspections/${extra.id}/cancel`, { reason: "Scheduled in error" });
    assert(
      q1("SELECT status FROM jurisdictional_inspections WHERE id = ?", insp.id).status === "CORRECTIONS_REQUIRED",
      "cancelling an unrelated inspection erases nothing from the chain history"
    );

    // Administrative correction: metadata only, reason required, audited.
    const noReasonCorr = await api("funder", "POST", `/api/inspections/${re.id}/correct`, { governmentInspectorName: "Insp. T. A. Demo" });
    assert(noReasonCorr.status === 400, "administrative correction without a reason is rejected");
    await j("funder", "POST", `/api/inspections/${re.id}/correct`, {
      reason: "Inspector name misspelled", governmentInspectorName: "Insp. T. A. Demo",
    });
    const corrected = q1("SELECT government_inspector_name g, result FROM jurisdictional_inspections WHERE id = ?", re.id);
    assert(
      corrected.g === "Insp. T. A. Demo" && corrected.result === "PASSED" &&
        q1("SELECT COUNT(*) c FROM config_audit WHERE action = 'INSPECTION_ADMIN_CORRECTION'").c === 1,
      "administrative correction updates metadata only, preserves the result, and writes a before/after audit entry"
    );

    // ================= PART E · official-source artifact hashing =================
    const pngBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("OFFICIAL RESULT CERTIFICATE"),
    ]);
    const artifact = (await j("compliance", "POST", "/api/official-sources", {
      projectId: "proj-r47", inspectionId: re.id, sourceType: "OFFICIAL_DOCUMENT",
      officialStatusText: "Final certificate", artifactFilename: "certificate.png",
      artifactDataUrl: "data:image/png;base64," + pngBytes.toString("base64"),
    }, 201)).record;
    const { createHash } = require("node:crypto");
    const expectHash = createHash("sha256").update(pngBytes).digest("hex");
    assert(
      artifact.sourceArtifactHash === expectHash && artifact.sourceDocumentPath.endsWith(".png"),
      "captured source artifact bytes are stored with a computed sha256 administrative hash and sniffed extension"
    );

    // ================= PART F · exceptions =================
    // Fresh corrections condition on the synthetic project's milestone.
    const gexc = (await j("funder", "POST", "/api/milestones/ms-x-1/inspection-requirement", {
      requirement: "REQUIRED", requirementBasis: "Test basis", inspectionType: "test",
    })).requirement;
    const xi = (await j("funder", "POST", "/api/milestones/ms-x-1/inspections", { inspectionType: "test" }, 201)).inspection;
    await j("funder", "POST", `/api/inspections/${xi.id}/complete`, {});
    await j("funder", "POST", `/api/inspections/${xi.id}/result`, {
      result: "CORRECTIONS_REQUIRED", correctionSummary: "Test corrections",
    });
    await j("funder", "POST", "/api/exceptions/evaluate", {});
    const corrExc = q1("SELECT id, status FROM exceptions WHERE source_key = ?", `corrections-required:${xi.id}`);
    assert(corrExc && ["OPEN"].includes(corrExc.status), "corrections-required exception created with a deterministic sourceKey");
    const xr = (await j("funder", "POST", `/api/inspections/${xi.id}/reinspection`, {})).inspection;
    await j("funder", "POST", `/api/inspections/${xr.id}/schedule`, { scheduledAt: "2026-08-01T09:00:00Z" });
    await j("funder", "POST", `/api/inspections/${xr.id}/complete`, {});
    await j("funder", "POST", `/api/inspections/${xr.id}/result`, { result: "PASSED", governmentInspectorName: "I" });
    await j("funder", "POST", "/api/exceptions/evaluate", {});
    const corrExcAfter = q1("SELECT status, resolution_type rt FROM exceptions WHERE source_key = ?", `corrections-required:${xi.id}`);
    assert(
      corrExcAfter.status === "RESOLVED" && corrExcAfter.rt === "SOURCE_CLEARED" &&
        q1("SELECT result FROM jurisdictional_inspections WHERE id = ?", xi.id).result === "CORRECTIONS_REQUIRED",
      "passed reinspection auto-resolves the active exception without rewriting the historical result"
    );
    // GET pages must not mutate exception state.
    const excCount = q1("SELECT COUNT(*) c FROM exceptions").c;
    await api("funder", "GET", "/milestone/ms-4");
    await api("funder", "GET", "/project/proj-r47/permits");
    assert(q1("SELECT COUNT(*) c FROM exceptions").c === excCount, "viewing milestone and register pages mutates no exception state");

    // ================= PART G · RELEASED stays historical =================
    const g1 = await gates("ms-1");
    assert(
      g1.eligibility.result === "RELEASED" && g1.requirementValue === "UNKNOWN",
      "legacy RELEASED milestone keeps its historical financial state and does not imply permit or inspection facts"
    );
    // Legacy free-text permit reference preserved, no Permit invented.
    const permitCountBefore = q1("SELECT COUNT(*) c FROM permits").c;
    exec("UPDATE jurisdictional_inspections SET permit_id = 'LEGACY-TXT-77' WHERE id = ?", extra.id);
    const msPage = await (await api("funder", "GET", "/milestone/ms-5")).text();
    assert(
      msPage.includes("Legacy permit reference preserved") &&
        q1("SELECT COUNT(*) c FROM permits").c === permitCountBefore,
      "legacy text permit reference is preserved and surfaced without inventing a Permit record"
    );

    // ================= PART H · reporting =================
    const gen = await j("funder", "POST", "/api/projects/proj-r47/audit-packages", {});
    const pkgId = gen.auditPackage?.id ?? gen.package?.id ?? gen.id;
    let pkg;
    for (let i = 0; i < 40; i++) {
      pkg = (await j("funder", "GET", `/api/audit-packages/${pkgId}`)).auditPackage;
      if (["READY", "READY_WITH_WARNINGS", "FAILED"].includes(pkg.status)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert(pkg.status !== "FAILED", `audit package generated (${pkg.status})`);
    const dl = await api("funder", "GET", `/audit-packages/${pkgId}/download`);
    const zip = readZip(Buffer.from(await dl.arrayBuffer()));
    const names = Object.keys(zip);
    assert(
      ["03_permits/permits.csv", "03_permits/code-basis-register.csv", "03_permits/official-source-records.csv",
       "02_milestones/permit-milestone-links.csv", "05_inspections/inspection-history.csv",
       "05_inspections/reinspection-links.csv", "05_inspections/correction-notices.csv"]
        .every((f) => names.includes(f)),
      "audit package includes the permit, code-basis, official-source, inspection-chain and correction registers"
    );
    const histCsv = zip["05_inspections/inspection-history.csv"].toString("utf8");
    assert(
      histCsv.includes(insp.id) && histCsv.includes(re.id) && histCsv.includes("CORRECTIONS_REQUIRED"),
      "inspection history export preserves the original result and the reinspection chain"
    );
    const permitsCsv = zip["03_permits/permits.csv"].toString("utf8");
    assert(
      permitsCsv.includes("DOB-2026-0001") && !permitsCsv.toLowerCase().includes("code compliant"),
      "permit register export uses recorded-status language, never a code-compliant claim"
    );

    // Mandatory-source inconsistency & artifact tamper → CRITICAL findings.
    // The live API refuses PASSED without a mandatory source, so the
    // inconsistency can only exist as imported/legacy data — simulate it
    // directly in the store and let the validator flag it. The tampered
    // artifact bytes on re's record must fail hash comparison.
    await j("funder", "POST", "/api/milestones/ms-5/inspection-requirement", {
      requirement: "REQUIRED", requirementBasis: "Final surfacing standard (tightened)", inspectionType: "final",
      officialSourceRequired: true,
    });
    const legacyPassed = (await j("funder", "POST", "/api/milestones/ms-5/inspections", { inspectionType: "final" }, 201)).inspection;
    exec(
      "UPDATE jurisdictional_inspections SET status = 'PASSED', result = 'PASSED', result_recorded_at = '2026-01-01T00:00:00Z' WHERE id = ?",
      legacyPassed.id
    );
    fs.writeFileSync(path.join(DATA_DIR, "uploads", artifact.sourceDocumentPath), "TAMPERED");
    const gen2 = await j("funder", "POST", "/api/projects/proj-r47/audit-packages", {});
    const pkgId2 = gen2.auditPackage?.id ?? gen2.package?.id ?? gen2.id;
    let pkg2;
    for (let i = 0; i < 40; i++) {
      pkg2 = (await j("funder", "GET", `/api/audit-packages/${pkgId2}`)).auditPackage;
      if (["READY", "READY_WITH_WARNINGS", "FAILED"].includes(pkg2.status)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const dl2 = await api("funder", "GET", `/audit-packages/${pkgId2}/download`);
    const zip2 = readZip(Buffer.from(await dl2.arrayBuffer()));
    const flat = Object.keys(zip2)
      .filter((k) => k.startsWith("10_integrity") && k.endsWith(".json"))
      .map((k) => zip2[k].toString("utf8"))
      .join("\n");
    if (!flat.includes("MANDATORY_OFFICIAL_SOURCE_MISSING") || !flat.includes("SOURCE_ARTIFACT_HASH_MISMATCH")) {
      console.error("  integrity findings seen:", (flat.match(/[A-Z_]{8,}/g) ?? []).filter((x) => x.includes("_")).slice(0, 30).join(", "));
    }
    assert(
      flat.includes("MANDATORY_OFFICIAL_SOURCE_MISSING") && flat.includes("SOURCE_ARTIFACT_HASH_MISMATCH"),
      "audit integrity reports CRITICAL findings for missing mandatory source and tampered artifact bytes"
    );

    // ============ HARDENING · stage-specific permit gating truth table ============
    // Real verified milestone: field submits demo evidence for ms-3.
    const fctx = await (await api("field", "GET", "/api/field-context")).json();
    const demoId = fctx.projects[0].milestones.find((m) => m.id === "ms-3").demoPhotos[0].id;
    await j("field", "POST", "/api/evidence", {
      milestoneId: "ms-3", demoPhotoId: demoId, latitude: -11.85, longitude: 33.6,
      capturedAt: new Date().toISOString(),
      deviceMetadata: { userAgent: "t", platform: "test", screen: "1x1", language: "en" },
      isDemoFallback: true,
    }, 201);
    // Clear the seeded HIGH field issue bound to ms-3 (its exception would
    // otherwise be an unrelated hard blocker in this matrix).
    await fetch(BASE + "/api/issues/issue-1/status", {
      method: "POST",
      headers: { cookie: jars.pm, "content-type": "application/json" },
      body: JSON.stringify({ status: "RESOLVED", resolutionSummary: "Cleared for stage-matrix test" }),
    });
    await j("funder", "POST", "/api/exceptions/evaluate", {});
    await j("funder", "POST", `/api/permits/${p3.id}/links`, { milestoneId: "ms-3" }, 201); // p3 is EXPIRED
    const setStage = (dr, gov) =>
      j("funder", "POST", "/api/milestones/ms-3/inspection-requirement", {
        requirement: "REQUIRED", requirementBasis: "Stage matrix test", inspectionType: "structural",
        mustPassBeforeGovernance: false, mustPassBeforeDrawReview: false,
        permitRequired: true, permitMustBeActiveBeforeDrawReview: dr, permitMustBeActiveBeforeGovernance: gov,
      });
    await setStage(true, false);
    let e3 = (await gates("ms-3")).eligibility;
    assert(
      e3.permitBlocksDrawReview === true && e3.permitBlocksGovernance === false &&
        e3.result === "NOT_ELIGIBLE" &&
        e3.reasons.some((r) => r.code === "PERMIT_EXPIRED" && !r.blocking && r.detail.includes("Blocks: draw review.")),
      "draw-review-only permit gate: prevents ELIGIBLE_FOR_DRAW_REVIEW without becoming a governance blocker"
    );
    await setStage(false, true);
    e3 = (await gates("ms-3")).eligibility;
    assert(
      e3.permitBlocksDrawReview === false && e3.permitBlocksGovernance === true &&
        e3.result === "BLOCKED" &&
        e3.reasons.some((r) => r.code === "PERMIT_EXPIRED" && r.blocking && r.detail.includes("Blocks: governance.")),
      "governance-only permit gate: hard blocker labeled with its stage"
    );
    await setStage(true, true);
    e3 = (await gates("ms-3")).eligibility;
    assert(
      e3.permitBlocksDrawReview === true && e3.permitBlocksGovernance === true && e3.result === "BLOCKED" &&
        e3.reasons.some((r) => r.detail.includes("Blocks: draw review and governance.")),
      "both-stage permit gate: blocks both stages explicitly"
    );
    await setStage(false, false);
    e3 = (await gates("ms-3")).eligibility;
    assert(
      e3.permitBlocksDrawReview === false && e3.permitBlocksGovernance === false &&
        e3.result === "ELIGIBLE_FOR_DRAW_REVIEW" &&
        e3.reasons.some((r) => r.code === "PERMIT_EXPIRED" && !r.blocking && r.detail.includes("non-gating")),
      "no stage flags: the permit issue is recorded as a non-gating condition and eligibility is restored"
    );

    // ============ HARDENING · recorded results are historically terminal ============
    exec("INSERT INTO milestones (id, project_id, seq, title, requirement, tranche_amount, status, account_status) VALUES ('ms-x-2', 'proj-x', 2, 'X2', 'x', 1000, 'NOT_STARTED', 'HELD')");
    await j("funder", "POST", "/api/milestones/ms-x-2/inspection-requirement", {
      requirement: "REQUIRED", requirementBasis: "Terminal test", inspectionType: "test",
    });
    const A = (await j("funder", "POST", "/api/milestones/ms-x-2/inspections", { inspectionType: "test" }, 201)).inspection;
    await j("funder", "POST", `/api/inspections/${A.id}/complete`, {});
    await j("funder", "POST", `/api/inspections/${A.id}/result`, {
      result: "CORRECTIONS_REQUIRED", correctionSummary: "Corrections for terminal test",
    });
    const attempts = [
      await api("funder", "POST", `/api/inspections/${A.id}/schedule`, { scheduledAt: "2026-09-01T09:00:00Z" }),
      await api("funder", "POST", `/api/inspections/${A.id}/cancel`, { reason: "should fail" }),
      await api("funder", "POST", `/api/inspections/${A.id}/complete`, {}),
      await api("funder", "POST", `/api/inspections/${A.id}/result`, { result: "PASSED" }),
    ];
    const aRow = q1("SELECT status, result, correction_cleared_at cca FROM jurisdictional_inspections WHERE id = ?", A.id);
    assert(
      attempts.every((r) => r.status === 409) &&
        aRow.status === "CORRECTIONS_REQUIRED" && aRow.result === "CORRECTIONS_REQUIRED",
      "CORRECTIONS_REQUIRED records cannot be rescheduled, cancelled, completed or re-resulted — status and result unchanged"
    );

    // ============ HARDENING · correctionClearedAt lifecycle ============
    const B = (await j("funder", "POST", `/api/inspections/${A.id}/reinspection`, {})).inspection;
    const cca = () => q1("SELECT correction_cleared_at c FROM jurisdictional_inspections WHERE id = ?", A.id).c;
    assert(cca() === null, "reinspection created → correctionClearedAt remains null");
    await j("funder", "POST", `/api/inspections/${B.id}/schedule`, { scheduledAt: "2026-09-02T09:00:00Z" });
    assert(cca() === null, "reinspection scheduled → correctionClearedAt remains null");
    await j("funder", "POST", `/api/inspections/${B.id}/complete`, {});
    await j("funder", "POST", `/api/inspections/${B.id}/result`, { result: "FAILED", governmentInspectorName: "I" });
    assert(cca() === null, "reinspection FAILED → correctionClearedAt remains null");
    const C = (await j("funder", "POST", `/api/inspections/${B.id}/reinspection`, {})).inspection;
    await j("funder", "POST", `/api/inspections/${C.id}/schedule`, { scheduledAt: "2026-09-03T09:00:00Z" });
    await j("funder", "POST", `/api/inspections/${C.id}/complete`, {});
    await j("funder", "POST", `/api/inspections/${C.id}/result`, { result: "PASSED", governmentInspectorName: "I" });
    const aAfter = q1("SELECT result, correction_cleared_at cca FROM jurisdictional_inspections WHERE id = ?", A.id);
    assert(
      aAfter.cca !== null && aAfter.result === "CORRECTIONS_REQUIRED",
      "passed reinspection populates correctionClearedAt while the original corrections result stays unchanged"
    );

    // ============ HARDENING · official-source relational consistency ============
    const mismatchMs = await api("compliance", "POST", "/api/official-sources", {
      projectId: "proj-x", inspectionId: C.id, milestoneId: "ms-x-1",
      sourceType: "MANUAL_OFFICIAL_REFERENCE", officialRecordNumber: "X-1",
    });
    assert(mismatchMs.status === 422, "milestoneId conflicting with the inspection's milestone is rejected (422)");
    const otherPermit = (await j("funder", "POST", "/api/projects/proj-r47/permits", {
      permitNumber: "OTHER-77", permitType: "OTHER",
    }, 201)).permit;
    const mismatchPermit = await api("compliance", "POST", "/api/official-sources", {
      projectId: "proj-r47", inspectionId: re.id, permitId: otherPermit.id,
      sourceType: "MANUAL_OFFICIAL_REFERENCE", officialRecordNumber: "X-2",
    });
    assert(mismatchPermit.status === 422, "permitId conflicting with the inspection's first-class permit is rejected (422)");
    const unlinked = await api("compliance", "POST", "/api/official-sources", {
      projectId: "proj-r47", milestoneId: "ms-5", permitId: otherPermit.id,
      sourceType: "MANUAL_OFFICIAL_REFERENCE", officialRecordNumber: "X-3",
    });
    assert(unlinked.status === 422, "permitId not linked to the referenced milestone is rejected (422)");

    // ============ HARDENING · substantive provenance required ============
    const empty = await api("compliance", "POST", "/api/official-sources", {
      projectId: "proj-x", inspectionId: C.id, sourceType: "OFFICIAL_PORTAL_LOOKUP",
    });
    assert(empty.status === 422, "a source with only sourceType and an association is rejected — no provenance basis");
    const badUrl = await api("compliance", "POST", "/api/official-sources", {
      projectId: "proj-x", inspectionId: C.id, sourceType: "OFFICIAL_PORTAL_LOOKUP",
      officialSystemName: "Portal", officialRecordUrl: "javascript:alert(1)",
    });
    assert(badUrl.status === 422, "a malformed/unsafe record URL makes the source INVALID and rejected");

    // ============ HARDENING · PM operational vs formal status ============
    const pmDraft = await api("pm", "POST", "/api/projects/proj-r47/permits", {
      permitNumber: "PM-OP-1", permitType: "ROADWORKS", status: "DRAFT",
    });
    assert(pmDraft.status === 201, "project manager records an operational DRAFT permit");
    const pmDraftId = q1("SELECT id FROM permits WHERE permit_number = 'PM-OP-1'").id;
    const pmFormal = await api("pm", "POST", "/api/projects/proj-r47/permits", {
      permitNumber: "PM-OP-2", permitType: "ROADWORKS", status: "ACTIVE",
    });
    assert(pmFormal.status === 403, "project manager cannot create a permit with formal ACTIVE status");
    const pmApplied = await api("pm", "POST", `/api/permits/${pmDraftId}`, { status: "APPLIED", reason: "Submitted to authority" });
    assert(pmApplied.status === 200, "project manager may move an operational record DRAFT → APPLIED");
    const pmIssue = await api("pm", "POST", `/api/permits/${pmDraftId}`, { status: "ISSUED", reason: "trying" });
    assert(pmIssue.status === 403, "project manager cannot set formal ISSUED status — lender-side determination only");
    const funderIssue = await api("funder", "POST", `/api/permits/${pmDraftId}`, { status: "ISSUED", reason: "Authority confirmation reviewed" });
    assert(funderIssue.status === 200, "funder representative records the reviewed formal status determination");

    // ============ HARDENING · concurrent reinspection creation ============
    const E = (await j("funder", "POST", "/api/milestones/ms-x-2/inspections", { inspectionType: "test" }, 201)).inspection;
    await j("funder", "POST", `/api/inspections/${E.id}/complete`, {});
    await j("funder", "POST", `/api/inspections/${E.id}/result`, { result: "FAILED", governmentInspectorName: "I" });
    const [c1, c2] = await Promise.all([
      api("funder", "POST", `/api/inspections/${E.id}/reinspection`, {}),
      api("funder", "POST", `/api/inspections/${E.id}/reinspection`, {}),
    ]);
    const statuses = [c1.status, c2.status].sort();
    const children = q1("SELECT COUNT(*) c FROM jurisdictional_inspections WHERE reinspection_of_inspection_id = ?", E.id).c;
    assert(
      statuses[0] === 200 && statuses[1] === 409 && children === 1,
      "concurrent duplicate reinspection attempts: one success, one controlled conflict, exactly one child"
    );

    // ============ HARDENING · date validation and expiration boundary ============
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const invalidDate = await api("funder", "POST", "/api/projects/proj-r47/permits", {
      permitNumber: "BAD-DATE", permitType: "X", expiresAt: "not-a-date",
    });
    assert(invalidDate.status === 400, "invalid ISO dates are rejected (real parsing, not lexical comparison)");
    const mk = async (num, expires) =>
      (await j("funder", "POST", "/api/projects/proj-r47/permits", {
        permitNumber: num, permitType: "X", status: "ISSUED", issuedAt: "2026-01-01", expiresAt: expires,
      }, 201)).permit.id;
    const effOf = async (id) => (await j("funder", "GET", `/api/permits/${id}`)).effectiveStatus;
    assert((await effOf(await mk("EXP-PAST", day(-2)))) === "EXPIRED", "date-only expiry before today → EXPIRED");
    assert((await effOf(await mk("EXP-TODAY", day(0)))) === "ISSUED", "date-only expiry TODAY → still valid through the end of the date (UTC boundary documented)");
    assert((await effOf(await mk("EXP-FUTURE", day(2)))) === "ISSUED", "date-only expiry in the future → valid");
    assert(
      (await effOf(await mk("EXP-TS", new Date(Date.now() - 3600e3).toISOString()))) === "EXPIRED",
      "timestamp expiry one hour ago → EXPIRED at that exact instant"
    );

    // ============ HARDENING · artifact security ============
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    const badType = await api("compliance", "POST", "/api/official-sources", {
      projectId: "proj-x", inspectionId: C.id, sourceType: "OFFICIAL_DOCUMENT",
      officialStatusText: "sneaky", artifactFilename: "cert.pdf",
      artifactDataUrl: "data:application/pdf;base64," + html.toString("base64"),
    });
    assert(
      badType.status === 400,
      "HTML/script content is rejected by magic-byte sniffing even with a pdf filename and MIME claim"
    );
    const freshArt = (await j("compliance", "POST", "/api/official-sources", {
      projectId: "proj-x", inspectionId: C.id, sourceType: "OFFICIAL_DOCUMENT",
      officialStatusText: "Reinspection certificate", artifactFilename: "reinspection.png",
      artifactDataUrl: "data:image/png;base64," + pngBytes.toString("base64"),
    }, 201)).record;
    const artDl = await api("funder", "GET", `/official-sources/${freshArt.id}/artifact`);
    assert(
      artDl.status === 200 &&
        (artDl.headers.get("content-disposition") ?? "").startsWith("attachment") &&
        artDl.headers.get("x-content-type-options") === "nosniff" &&
        artDl.headers.get("content-type") === "image/png",
      "artifact downloads are authenticated attachments with nosniff and the sniffed content type"
    );
    const dlAnon = await fetch(`${BASE}/official-sources/${freshArt.id}/artifact`);
    const dlForeign = await api("outsider", "GET", `/official-sources/${freshArt.id}/artifact`);
    assert(dlAnon.status === 404 && dlForeign.status === 404, "artifact downloads are denied (404) without an authorized session");

    // ================= PART I · read-only financial boundary =================
    const svc = fs.readFileSync("dist/server/services/permits.js", "utf8");
    const gatesSvc = fs.readFileSync("dist/server/services/completionGates.js", "utf8");
    const financialRoute = /require\(["'][^"']*VirtualAccountService["']\)|holdTranche\(|releaseTranche\(|releaseDraw\(|withholdRetainage\(|releaseRetainage\(/;
    assert(
      !financialRoute.test(svc) && !financialRoute.test(gatesSvc),
      "permit and gate services have no route to VirtualAccountService or financial mutations"
    );

    console.log(`\nPERMIT / CODE-BASIS / REINSPECTION TESTS PASSED — ${n} checkpoints.`);
  } finally {
    srv.kill();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
