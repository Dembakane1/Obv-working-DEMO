/**
 * Project Audit Package tests — the 20 required cases.
 *
 *   node scripts/auditpackage-test.js   (HTTP + direct DB + ZIP assertions)
 *
 * Doctrine under test: the package assembles governed sources with a
 * hashed manifest; integrity failures are represented honestly, never
 * hidden; packages are immutable and versioned; access is role- and
 * tenant-gated and audited; no secrets, invitation tokens, provider
 * credentials, or chat transcripts leak into the export.
 */
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 3186;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "obv-ap-"));
// Fake provider secrets: the server sees them; the package must not.
const FAKE_WEBHOOK = "https://secret-webhook.example/hooks/T0P-S3CRET-URL";
const FAKE_WA_TOKEN = "WA-PROVIDER-TOKEN-8f3b2c1d9e";

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
function db() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(path.join(DATA_DIR, "obv.db"));
}
function q(sql, ...args) {
  const d = db();
  const r = d.prepare(sql).all(...args);
  d.close();
  return r;
}
const q1 = (sql, ...args) => q(sql, ...args)[0];
function exec(sql, ...args) {
  const d = db();
  d.prepare(sql).run(...args);
  d.close();
}

/** Minimal reader for our own STORE-method ZIPs. */
function readZip(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) fail("no ZIP end-of-central-directory record");
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const entries = {};
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) fail("bad ZIP central directory entry");
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

const csvRows = (text) =>
  text
    .trimEnd()
    .split(/\r\n/)
    .slice(1)
    .filter((l) => l.length);

async function download(key, id) {
  const res = await fetch(`${BASE}/audit-packages/${id}/download`, {
    headers: { cookie: jars[key] ?? "" },
    redirect: "manual",
  });
  return res;
}

(async () => {
  console.log("Project Audit Package tests — isolated server on :" + PORT);
  await new Promise((r) =>
    spawn(process.execPath, ["dist/server/db/seed.js"], {
      env: { ...process.env, OBV_DATA_DIR: DATA_DIR },
      stdio: "ignore",
    }).on("exit", r)
  );
  const srv = spawn(process.execPath, ["dist/server/http/server.js"], {
    env: {
      ...process.env,
      OBV_DATA_DIR: DATA_DIR,
      PORT: String(PORT),
      OBV_TEAMS_WEBHOOK_URL: FAKE_WEBHOOK,
      OBV_WA_TOKEN: FAKE_WA_TOKEN,
    },
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

    // Pre-plant records that must NEVER appear in a package: a pending
    // invitation (token hash) rides in the configuration tables.
    const SECRET_TOKEN_HASH = createHash("sha256").update("raw-invite-token-abc123").digest("hex");
    exec(
      `INSERT INTO invitations (id, email, organization_id, role, project_id, token_hash,
         status, expires_at, created_by, created_at)
       VALUES ('inv-secret', 'auditor@example.com', 'org-cdfc', 'COMPLIANCE_REVIEWER',
         'proj-r47', ?, 'PENDING', '2027-01-01T00:00:00.000Z', 'user-funder', '2026-07-01T00:00:00.000Z')`,
      SECRET_TOKEN_HASH
    );

    // ---------- 1. one-click generation ----------
    const gen = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", {});
    assert(gen.status === 201, "1. authorized reviewer generates a package in one call");
    const pkg = (await gen.json()).auditPackage;
    assert(
      pkg.status === "READY" && pkg.packageVersion === 1 && pkg.storageObjectKey,
      "   package is READY, version 1, stored"
    );

    const dl = await download("funder", pkg.id);
    assert(dl.status === 200, "   authorized download succeeds");
    const zipBuf = Buffer.from(await dl.arrayBuffer());
    const files = readZip(zipBuf);

    // ---------- 2. manifest ----------
    assert(Boolean(files["manifest.json"]), "2a. manifest.json exists at the package root");
    const manifest = JSON.parse(files["manifest.json"].toString("utf8"));
    assert(
      manifest.kind === "OBV_AUDIT_PACKAGE" &&
        manifest.schemaVersion === 1 &&
        manifest.packageId === pkg.id &&
        manifest.project.id === "proj-r47" &&
        manifest.organization.id === "org-cdfc" &&
        manifest.asOfTimestamp === pkg.asOfTimestamp &&
        manifest.generatedAt &&
        manifest.configurationVersion === pkg.configurationVersion &&
        Array.isArray(manifest.fileInventory) &&
        manifest.generatedBy.id === "user-funder",
      "2b. manifest carries ids, project, organization, generator, as-of, config version and inventory"
    );
    const ledgerHeadRow = q1("SELECT seq, current_hash FROM ledger_entries ORDER BY seq DESC LIMIT 1");
    assert(
      manifest.ledgerHead &&
        manifest.ledgerHead.seq === ledgerHeadRow.seq &&
        manifest.ledgerHead.hash === ledgerHeadRow.current_hash &&
        manifest.consistencyModel === "CREATION_TIME_CUTOFF",
      "2c. manifest pins the ledger head reference and states the consistency model"
    );
    const evInv = manifest.fileInventory.find((f) => f.path === "03_evidence/evidence-register.csv");
    assert(
      manifest.fileInventory.every(
        (f) => typeof f.path === "string" && typeof f.bytes === "number" &&
          /^[0-9a-f]{64}$/.test(f.sha256) && typeof f.kind === "string" && "records" in f
      ) && evInv.kind === "csv-register" && typeof evInv.records === "number",
      "2d. every inventory entry records path, size, sha256, kind and record count where applicable"
    );

    // ---------- 3. correct project only ----------
    const msRegister = files["02_milestones/milestone-register.csv"].toString("utf8");
    const dbMs = q("SELECT seq, title FROM milestones WHERE project_id='proj-r47'");
    assert(
      csvRows(msRegister).length === dbMs.length &&
        dbMs.every((m) => msRegister.includes(m.title)),
      "3. registers contain exactly the target project's records"
    );

    // ---------- 4. record counts match the database ----------
    const evCount = q1(
      `SELECT COUNT(*) c FROM evidence_items e JOIN milestones m ON m.id=e.milestone_id
       WHERE m.project_id='proj-r47'`
    ).c;
    const exCount = q1("SELECT COUNT(*) c FROM exceptions WHERE project_id='proj-r47'").c;
    assert(
      manifest.recordCounts["03_evidence/evidence-register.csv"] === evCount &&
        csvRows(files["03_evidence/evidence-register.csv"].toString("utf8")).length === evCount &&
        manifest.recordCounts["06_exceptions/exception-register.csv"] === exCount,
      `4. manifest record counts match the database (${evCount} evidence, ${exCount} exceptions)`
    );

    // ---------- 5. evidence register matches EvidenceItems ----------
    const evRegister = files["03_evidence/evidence-register.csv"].toString("utf8");
    const dbEvidence = q(
      `SELECT e.id, e.hash FROM evidence_items e JOIN milestones m ON m.id=e.milestone_id
       WHERE m.project_id='proj-r47'`
    );
    assert(
      dbEvidence.every((e) => evRegister.includes(e.id) && evRegister.includes(e.hash)),
      "5. every evidence item appears with its content hash"
    );

    // ---------- 6. verification register matches ----------
    const vRegister = files["03_evidence/verification-register.csv"].toString("utf8");
    const dbVerifs = q(
      `SELECT v.id, v.verdict FROM verifications v
       JOIN evidence_items e ON e.id = v.evidence_item_id
       JOIN milestones m ON m.id = e.milestone_id WHERE m.project_id='proj-r47'`
    );
    assert(
      csvRows(vRegister).length === dbVerifs.length &&
        dbVerifs.every((v) => vRegister.includes(v.id) && vRegister.includes(v.verdict)),
      "6. verification register matches stored verification results"
    );

    // ---------- 7. approval register matches ApprovalRecords ----------
    const recRegister = files["07_governance/approval-records.csv"].toString("utf8");
    const dbRecords = q(
      `SELECT r.id, r.approval_request_id, r.role, r.decision FROM approval_records r
       JOIN approval_requests ar ON ar.id = r.approval_request_id
       JOIN milestones m ON m.id = ar.milestone_id WHERE m.project_id='proj-r47'`
    );
    assert(
      csvRows(recRegister).length >= dbRecords.length &&
        dbRecords.every((r) => recRegister.includes(r.approval_request_id) && recRegister.includes(r.decision)),
      "7. approval records register matches stored decisions"
    );

    // ---------- 8. exactly one release per valid transition ----------
    const releases = csvRows(files["08_financial_state/release-events.csv"].toString("utf8"));
    const msReleases = releases.filter((r) => r.includes("MILESTONE_TRANCHE"));
    const dbReleases = q(
      `SELECT milestone_id, COUNT(*) c FROM virtual_account_events
       WHERE type='RELEASED' GROUP BY milestone_id`
    );
    assert(
      msReleases.length === dbReleases.length && dbReleases.every((r) => r.c === 1),
      `8. release timeline shows exactly one RELEASED transition per released tranche (${msReleases.length})`
    );

    // ---------- 9. configuration hashes validate ----------
    const cfgValidation = JSON.parse(files["10_integrity/configuration-hash-validation.json"].toString("utf8"));
    const dbSnapshots = q("SELECT hash, data FROM config_snapshots WHERE project_id='proj-r47'");
    assert(
      cfgValidation.result.invalidVersions.length === 0 &&
        dbSnapshots.every(
          (s) => createHash("sha256").update(s.data).digest("hex") === s.hash
        ),
      "9. configuration snapshot hashes recompute and validate"
    );

    // ---------- 10. ledger chain validates ----------
    assert(
      manifest.integrity.ledger.valid === true &&
        manifest.integrity.overall === "CLEAN" &&
        manifest.integrity.criticalFindings === 0 &&
        manifest.integrity.findings.length === 0 &&
        pkg.ledgerIntegrityState === "INTACT" &&
        pkg.integrityState === "CLEAN" &&
        pkg.integrityCritical === 0,
      "10. fully clean package: CLEAN, zero findings, zero critical"
    );

    // ---------- 11. manifest file hashes validate ----------
    for (const f of manifest.fileInventory) {
      const data = files[f.path];
      if (!data) fail(`manifest lists ${f.path} but the ZIP does not contain it`);
      if (createHash("sha256").update(data).digest("hex") !== f.sha256) {
        fail(`hash mismatch for ${f.path}`);
      }
      if (data.length !== f.bytes) fail(`size mismatch for ${f.path}`);
    }
    const recomputed = createHash("sha256")
      .update(JSON.stringify({ ...manifest, manifestHash: null }, null, 2))
      .digest("hex");
    assert(
      recomputed === manifest.manifestHash && manifest.manifestHash === pkg.manifestHash,
      `11. all ${manifest.fileInventory.length} file hashes + the manifest hash recompute exactly`
    );

    // ---------- 12-15. secret & transcript leakage ----------
    const everything = Object.entries(files)
      .filter(([name]) => !name.endsWith(".pdf"))
      .map(([, buf]) => buf.toString("latin1"))
      .join("\n");
    assert(
      !everything.includes(FAKE_WEBHOOK) && !everything.includes("secret-webhook.example"),
      "12. no environment/webhook secrets in the package"
    );
    assert(
      !everything.includes(SECRET_TOKEN_HASH) && !everything.includes("raw-invite-token-abc123") && !everything.toLowerCase().includes("token_hash"),
      "13. no invitation tokens or token hashes in the package"
    );
    assert(!everything.includes(FAKE_WA_TOKEN), "14. no provider tokens in the package");
    const seededMessage =
      "Gravel base compaction is complete from km 9–14. I will capture and submit evidence";
    assert(
      q1("SELECT COUNT(*) c FROM messages").c > 0 &&
        !everything.includes("Gravel base compaction is complete") &&
        !Object.keys(files).some((f) => f.includes("communications") || f.includes("transcript")),
      "15a. chat transcripts are not included by default"
    );
    // opt-in metadata: counts only, still no bodies
    const genMeta = await api("compliance", "POST", "/api/projects/proj-r47/audit-packages", {
      includeCommMetadata: true,
    });
    const metaPkg = (await genMeta.json()).auditPackage;
    const metaZip = readZip(Buffer.from(await (await download("compliance", metaPkg.id)).arrayBuffer()));
    const metaFile = metaZip["12_communications_metadata/comm-metadata-summary.json"];
    const metaEverything = Object.entries(metaZip)
      .filter(([name]) => !name.endsWith(".pdf"))
      .map(([, buf]) => buf.toString("latin1"))
      .join("\n");
    assert(
      Boolean(metaFile) &&
        JSON.parse(metaFile.toString("utf8")).threads === q1("SELECT COUNT(*) c FROM conversation_threads WHERE project_id='proj-r47'").c &&
        !metaEverything.includes("Gravel base compaction is complete"),
      "15b. opt-in communication metadata carries counts only — still no message bodies"
    );
    void seededMessage;

    // ---------- 16. cross-tenant + role protection ----------
    exec("INSERT INTO organizations (id, name, kind) VALUES ('org-other', 'Unrelated Fund', 'DEVELOPMENT_FINANCE')");
    exec(
      `INSERT INTO users (id, organization_id, name, role, title)
       VALUES ('user-outsider', 'org-other', 'Outside Analyst', 'FUNDER_REP', 'Analyst')`
    );
    await signIn("outsider", "user-outsider");
    const xTenantGen = await api("outsider", "POST", "/api/projects/proj-r47/audit-packages", {});
    const xTenantDl = await download("outsider", pkg.id);
    const xTenantList = await api("outsider", "GET", "/api/projects/proj-r47/audit-packages");
    assert(
      xTenantGen.status === 404 && xTenantDl.status === 404 && xTenantList.status === 404,
      "16a. cross-tenant generation, listing and download are blocked (404)"
    );
    const fieldGen = await api("field", "POST", "/api/projects/proj-r47/audit-packages", {});
    assert(fieldGen.status === 403, "16b. FIELD role cannot generate audit packages (403)");

    // ---------- 17-19. immutability, versioning, retention ----------
    const v1Path = path.join(DATA_DIR, pkg.storageObjectKey);
    const v1BytesBefore = createHash("sha256").update(fs.readFileSync(v1Path)).digest("hex");
    const regen = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", {});
    const pkg3 = (await regen.json()).auditPackage;
    assert(
      pkg3.packageVersion === 3 && pkg3.status === "READY",
      "18. regeneration creates a new package version"
    );
    const v1After = q1("SELECT status, manifest_hash FROM audit_packages WHERE id = ?", pkg.id);
    assert(
      v1After.status === "SUPERSEDED" &&
        v1After.manifest_hash === pkg.manifestHash &&
        createHash("sha256").update(fs.readFileSync(v1Path)).digest("hex") === v1BytesBefore,
      "17. the READY package is immutable — regeneration never rewrites it (now SUPERSEDED)"
    );
    const oldDl = await download("funder", pkg.id);
    assert(
      oldDl.status === 200 &&
        createHash("sha256").update(Buffer.from(await oldDl.arrayBuffer())).digest("hex") === v1BytesBefore,
      "19. superseded package remains downloadable, byte-identical (retention)"
    );

    // generation + download audit trail
    const auditRows = q(
      "SELECT action FROM config_audit WHERE entity_type='AUDIT_PACKAGE' AND project_id='proj-r47'"
    ).map((r) => r.action);
    assert(
      auditRows.filter((a) => a === "AUDIT_PACKAGE_GENERATED").length >= 3 &&
        auditRows.includes("AUDIT_PACKAGE_DOWNLOADED"),
      "   every generation and download is written to the configuration audit trail"
    );

    // ---------- as-of consistency ----------
    const asOf = "2026-04-01T00:00:00.000Z"; // between M1 (March) and M2 (May) history
    const histGen = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", { asOf });
    const histPkg = (await histGen.json()).auditPackage;
    const histZip = readZip(Buffer.from(await (await download("funder", histPkg.id)).arrayBuffer()));
    const histEvidence = csvRows(histZip["03_evidence/evidence-register.csv"].toString("utf8"));
    const dbHistCount = q1(
      `SELECT COUNT(*) c FROM evidence_items e JOIN milestones m ON m.id=e.milestone_id
       WHERE m.project_id='proj-r47' AND e.uploaded_at <= ?`,
      asOf
    ).c;
    const histReleases = csvRows(histZip["08_financial_state/release-events.csv"].toString("utf8"));
    assert(
      histEvidence.length === dbHistCount &&
        histEvidence.length < evCount &&
        histReleases.length === 1 &&
        histZip["manifest.json"].toString("utf8").includes(asOf),
      `   as-of package excludes records after the audit point (${histEvidence.length}/${evCount} evidence, 1 release)`
    );
    const future = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", {
      asOf: "2030-01-01T00:00:00.000Z",
    });
    assert(future.status === 400, "   a future as-of timestamp is refused");

    // ---------- as-of: records inserted after the cutoff never leak ----------
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    const lateTs = new Date().toISOString();
    exec(
      `INSERT INTO exceptions (id, organization_id, project_id, source_type, source_id,
         source_key, category, severity, status, title, description, opened_at,
         created_by, created_at, updated_at)
       VALUES ('exc-late', 'org-cdfc', 'proj-r47', 'FIELD_ISSUE', 'late-src', 'late-key',
         'OTHER', 'LOW', 'OPEN', 'Inserted after cutoff', '', ?, 'user-funder', ?, ?)`,
      lateTs, lateTs, lateTs
    );
    const cutoffGen = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", { asOf: cutoff });
    const cutoffPkg = (await cutoffGen.json()).auditPackage;
    const cutoffZip = readZip(Buffer.from(await (await download("funder", cutoffPkg.id)).arrayBuffer()));
    const cutoffExc = cutoffZip["06_exceptions/exception-register.csv"].toString("utf8");
    const cutoffManifest = JSON.parse(cutoffZip["manifest.json"].toString("utf8"));
    assert(
      q1("SELECT COUNT(*) c FROM exceptions WHERE id='exc-late'").c === 1 &&
        !cutoffExc.includes("exc-late") &&
        !cutoffExc.includes("Inserted after cutoff") &&
        cutoffManifest.recordCounts["06_exceptions/exception-register.csv"] ===
          q1("SELECT COUNT(*) c FROM exceptions WHERE project_id='proj-r47' AND opened_at <= ?", cutoff).c,
      "   a record inserted after the cutoff is excluded from registers AND counts"
    );
    const liveGen = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", {});
    const livePkg = (await liveGen.json()).auditPackage;
    const liveZip = readZip(Buffer.from(await (await download("funder", livePkg.id)).arrayBuffer()));
    assert(
      liveZip["06_exceptions/exception-register.csv"].toString("utf8").includes("exc-late"),
      "   the same record appears in a package cut after its creation (no over-exclusion)"
    );

    // ---------- evidence media policy ----------
    const pmMedia = await api("pm", "POST", "/api/projects/proj-r47/audit-packages", {
      includeEvidenceMedia: true,
    });
    assert(
      pmMedia.status === 403 &&
        q1("SELECT COUNT(*) c FROM audit_packages WHERE requested_by='user-pm'").c === 0,
      "   unauthorized media inclusion attempt is refused (403) — PM cannot export raw media"
    );
    assert(
      !Object.keys(liveZip).some((f) => f.startsWith("03_evidence/media/")) &&
        !liveZip["03_evidence/media-manifest.csv"],
      "   default packages contain no raw media files"
    );
    const mediaGen = await api("compliance", "POST", "/api/projects/proj-r47/audit-packages", {
      includeEvidenceMedia: true,
    });
    assert(mediaGen.status === 201, "   compliance reviewer may explicitly include evidence media");
    const mediaPkg = (await mediaGen.json()).auditPackage;
    const mediaZip = readZip(Buffer.from(await (await download("compliance", mediaPkg.id)).arrayBuffer()));
    const mediaManifest = mediaZip["03_evidence/media-manifest.csv"].toString("utf8");
    const mediaRows = csvRows(mediaManifest);
    const mediaFiles = Object.keys(mediaZip).filter((f) => f.startsWith("03_evidence/media/"));
    assert(
      mediaRows.length === q1(
        `SELECT COUNT(*) c FROM evidence_items e JOIN milestones m ON m.id=e.milestone_id
         WHERE m.project_id='proj-r47'`
      ).c && mediaFiles.length > 0,
      "   media manifest covers every evidence item; media files are packaged"
    );
    for (const f of mediaFiles) {
      const base = f.slice("03_evidence/media/".length);
      if (!/^[A-Za-z0-9._-]+(__([A-Za-z0-9._-]+))?$/.test(base.replace("__", "_"))) {
        fail(`unsanitized media filename: ${f}`);
      }
      const packagedHash = createHash("sha256").update(mediaZip[f]).digest("hex");
      if (!mediaManifest.includes(packagedHash)) fail(`packaged media hash not recorded for ${f}`);
    }
    assert(
      mediaRows.every((r) => /,(ORIGINAL|DEMO_FALLBACK_STANDIN|DERIVATIVE),/.test(r)) &&
        mediaManifest.includes("recordedEvidenceHash") &&
        mediaManifest.includes("mimeType"),
      "   each packaged copy is re-hashed, MIME-typed and marked ORIGINAL vs derivative"
    );
    const mediaManifestJson = JSON.parse(mediaZip["manifest.json"].toString("utf8"));
    assert(
      mediaManifestJson.options.includeEvidenceMedia === true &&
        mediaManifestJson.options.includeCommTranscripts === false &&
        !Object.keys(mediaZip).some((f) => /whatsapp|comm-media|attachment/i.test(f)),
      "   media opt-in never pulls in communication media or transcripts"
    );

    // ---------- nonfatal availability warning (READY_WITH_WARNINGS) ----------
    exec(
      `INSERT INTO reports (id, project_id, report_type, filename, generated_at,
         generated_by, integrity_status, ledger_entries)
       VALUES ('rep-ghost', 'proj-r47', 'VERIFICATION_FUND_RELEASE', 'ghost.pdf',
         '2026-06-01T00:00:00.000Z', 'user-funder', 'INTACT', 2)`
    );
    const warnGen = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", {});
    const warnPkg = (await warnGen.json()).auditPackage;
    const warnZip = readZip(Buffer.from(await (await download("funder", warnPkg.id)).arrayBuffer()));
    const warnManifest = JSON.parse(warnZip["manifest.json"].toString("utf8"));
    assert(
      warnPkg.status === "READY" &&
        warnPkg.integrityState === "WARNINGS" &&
        warnPkg.integrityCritical === 0 &&
        warnManifest.integrity.criticalFindings === 0 &&
        warnManifest.integrity.findings.some(
          (f) => f.severity === "WARNING" && f.category === "REPORT_ARTIFACT" && f.message.includes("rep-ghost")
        ),
      "   missing historical report artifact → READY with a nonfatal WARNING finding, zero critical"
    );
    assert(
      warnZip["11_reports/report-index.csv"].toString("utf8").includes("rep-ghost") &&
        warnZip["11_reports/report-index.csv"].toString("utf8").includes("NOT_ON_DISK"),
      "   the register reference remains while the artifact is honestly marked unavailable"
    );
    const warnPage = await (
      await fetch(BASE + "/reports", { headers: { cookie: jars.funder } })
    ).text();
    assert(
      warnPage.includes("READY — INTEGRITY WARNING") && !warnPage.includes("CRITICAL INTEGRITY"),
      "   register chip shows READY — INTEGRITY WARNING (not critical, not clean)"
    );

    // ---------- 20. integrity failure is honestly represented ----------
    exec("UPDATE ledger_entries SET payload_hash='deadbeef' WHERE seq=1");
    const tamperGen = await api("funder", "POST", "/api/projects/proj-r47/audit-packages", {});
    const tamperPkg = (await tamperGen.json()).auditPackage;
    assert(
      tamperPkg.status === "READY" &&
        tamperPkg.integrityState === "WARNINGS" &&
        tamperPkg.integrityCritical > 0 &&
        tamperPkg.ledgerIntegrityState === "TAMPERED_AT:1",
      "20a. tampered ledger → READY with CRITICAL finding + TAMPERED_AT state, never silently clean"
    );
    const tamperZip = readZip(Buffer.from(await (await download("funder", tamperPkg.id)).arrayBuffer()));
    const tamperManifest = JSON.parse(tamperZip["manifest.json"].toString("utf8"));
    const coverName = tamperZip["00_project_summary/project-summary.pdf"]
      ? "00_project_summary/project-summary.pdf"
      : "00_project_summary/project-summary.html";
    assert(
      tamperManifest.integrity.overall === "WARNINGS" &&
        tamperManifest.integrity.ledger.valid === false &&
        tamperManifest.integrity.criticalFindings > 0 &&
        tamperManifest.integrity.findings.some(
          (f) => f.severity === "CRITICAL" && f.category === "LEDGER_CHAIN" && f.message.includes("chain broken")
        ),
      "20b. manifest classifies the ledger failure as a CRITICAL finding"
    );
    const reportsPage = await (
      await fetch(BASE + "/reports", { headers: { cookie: jars.funder } })
    ).text();
    assert(
      reportsPage.includes("READY — CRITICAL INTEGRITY WARNING"),
      "20c. the register shows READY — CRITICAL INTEGRITY WARNING, not a clean state"
    );
    void coverName;

    console.log(`\nAUDIT PACKAGE TESTS PASSED — ${n} checkpoints.`);
  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
