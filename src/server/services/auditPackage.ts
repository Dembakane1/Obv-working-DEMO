/**
 * Project Audit Package — one-click auditor/funder/regulator-ready export.
 *
 * Doctrine: the package ASSEMBLES and REFERENCES the governed sources
 * (configuration snapshots, Evidence Ledger, verification results,
 * approvals, draws, budget, exceptions, change orders, retainage,
 * generated reports). It never rewrites them, never creates evidence,
 * approvals, ledger entries, or release state, and never includes
 * secrets, invitation tokens, provider credentials, or chat transcripts
 * (communication METADATA counts are an explicit opt-in).
 *
 * Integrity is validated before a package is marked READY: ledger chain,
 * configuration snapshot hashes, duplicate-release checks, approval
 * record consistency, and evidence object existence. A failure is never
 * hidden — the package carries integrityState WARNINGS and every finding
 * is listed in the manifest and on the cover summary.
 *
 * Packages are IMMUTABLE once READY (write-once ZIP). Regeneration
 * creates a new packageVersion; prior versions become SUPERSEDED but
 * remain downloadable (retention).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as repo from "../db/repo";
import { buildLenderFiles } from "./lenderReporting";
import * as permitService from "./permits";
import { AUDIT_PACKAGES_DIR, DATA_DIR, REPORTS_DIR, UPLOADS_DIR } from "../db/index";
import { wormEvidenceStore } from "./WormEvidenceStore";
import { assessFinancialProgress, assessPhysicalProgress, canAccessProjectFinance } from "./budgetProgress";
import { retainageSummary } from "./retainage";
import { audit } from "./pilot/onboarding";
import * as drawPackage from "./drawPackage";
import * as completionGates from "./completionGates";
import type {
  ApprovalRequest, AuditPackage, Project, User,
} from "../../shared/types";

export class AuditPackageError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
    /** Recorded on the FAILED package row when generation aborts. */
    public failureCategory: string | null = null
  ) {
    super(message);
  }
}

export const AUDIT_PACKAGE_SCHEMA_VERSION = 1;

/** Roles allowed to generate/download audit packages. FIELD is not an
 *  institutional export role. */
const AUTHORIZED_ROLES = new Set(["FUNDER_REP", "PROJECT_MANAGER", "COMPLIANCE_REVIEWER"]);

// ============================================================= access

function assertProjectAccess(user: User, projectId: string): Project {
  const project = repo.getProject(projectId);
  // Cross-tenant reads 404 (existence is not disclosed).
  if (!project || !canAccessProjectFinance(user, project)) {
    throw new AuditPackageError("Unknown project", 404);
  }
  if (!AUTHORIZED_ROLES.has(user.role)) {
    throw new AuditPackageError("Not authorized to generate or download audit packages", 403);
  }
  return project;
}

// =============================================================== CSV

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ========================================================== ZIP (store)

// Zero-dependency ZIP writer, STORE method (no compression — the
// registers are small; auditors value transparency over bytes).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(iso: string): { time: number; date: number } {
  const d = new Date(iso);
  const date =
    (Math.max(0, d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  return { time, date };
}

export interface PackageFile {
  /** Forward-slash path inside the ZIP, e.g. "03_evidence/evidence-register.csv". */
  name: string;
  data: Buffer;
}

export function buildZip(files: PackageFile[], timestampIso: string): Buffer {
  const { time, date } = dosDateTime(timestampIso);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, f.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + f.data.length;
  }
  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

// ===================================================== integrity checks

/** WARNING = availability finding (an optional artifact is missing while
 *  its register reference remains). CRITICAL = trust-chain finding (ledger
 *  chain failure, snapshot hash mismatch, duplicate governed release,
 *  approval-record anomaly). Fatal conditions (tenant isolation, package
 *  construction, mandatory financial reconciliation) never produce a
 *  finding — they abort generation with status FAILED. */
export type IntegrityFindingSeverity = "WARNING" | "CRITICAL";

export interface IntegrityFinding {
  severity: IntegrityFindingSeverity;
  category:
    | "LEDGER_CHAIN" | "SNAPSHOT_HASH" | "DUPLICATE_RELEASE"
    | "APPROVAL_RECORDS" | "EVIDENCE_OBJECT" | "REPORT_ARTIFACT" | "EVIDENCE_MEDIA"
    | "PERMIT_REGISTER";
  message: string;
}

export interface IntegrityValidation {
  ledger: { state: string; valid: boolean; entries: number };
  /** Ledger head reference at generation — lets a verifier confirm the
   *  package was cut against a specific chain position. */
  ledgerHead: { seq: number; hash: string } | null;
  configSnapshots: { total: number; validHashes: number; invalidVersions: number[] };
  duplicateReleases: {
    milestoneViolations: string[];
    drawViolations: string[];
    retainageViolations: string[];
  };
  approvals: { checked: number; violations: string[] };
  evidenceObjects: { checked: number; missing: string[]; notCheckable: number };
  findings: IntegrityFinding[];
  /** Derived from findings — refreshed via summarizeFindings(). */
  warnings: string[];
  criticalCount: number;
  overall: "CLEAN" | "WARNINGS";
}

/** Recompute the derived summary fields after findings change (register
 *  building can add availability findings after the base validation). */
export function summarizeFindings(v: IntegrityValidation): void {
  v.warnings = v.findings.map((f) => `[${f.severity}] ${f.message}`);
  v.criticalCount = v.findings.filter((f) => f.severity === "CRITICAL").length;
  v.overall = v.findings.length === 0 ? "CLEAN" : "WARNINGS";
}

const MEDIA_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  svg: "image/svg+xml", gif: "image/gif", mp4: "video/mp4", pdf: "application/pdf",
};

function mimeForFilename(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_MIME[ext] ?? "application/octet-stream";
}

/** Resolve a served evidence path to a file on disk, where accessible. */
function evidenceDiskPath(photoPath: string): string | null {
  if (photoPath.startsWith("/worm/")) return path.join(DATA_DIR, "worm", path.basename(photoPath));
  if (photoPath.startsWith("/uploads/")) return path.join(UPLOADS_DIR, path.basename(photoPath));
  if (photoPath.startsWith("/demo-evidence/")) {
    return path.join(process.cwd(), "public", "demo-evidence", path.basename(photoPath));
  }
  return null;
}

export async function validateProjectIntegrity(projectId: string): Promise<IntegrityValidation> {
  const findings: IntegrityFinding[] = [];
  const finding = (severity: IntegrityFindingSeverity, category: IntegrityFinding["category"], message: string) =>
    findings.push({ severity, category, message });

  // 1. Evidence Ledger hash chain (global, append-only).
  const chain = await wormEvidenceStore.verifyChain();
  const head = repo.lastLedgerEntry();
  const ledgerState = chain.valid ? "INTACT" : `TAMPERED_AT:${chain.brokenAt}`;
  if (!chain.valid) finding("CRITICAL", "LEDGER_CHAIN", `Evidence Ledger chain broken at entry ${chain.brokenAt}`);

  // 1b. Permit / inspection-chain / official-source structural integrity:
  // broken internal references, impossible reinspection chains, missing
  // mandatory source records, conflicting final results, artifact drift.
  for (const pf of permitService.validatePermitIntegrity(projectId)) {
    finding(pf.severity, "PERMIT_REGISTER", `${pf.code}: ${pf.detail}`);
  }

  // 2. Configuration snapshot hashes (recomputed, never trusted).
  const snapshots = repo.listConfigSnapshots(projectId);
  const invalidVersions = snapshots
    .filter((s) => createHash("sha256").update(s.data).digest("hex") !== s.hash)
    .map((s) => s.version);
  for (const v of invalidVersions) finding("CRITICAL", "SNAPSHOT_HASH", `Configuration snapshot v${v} hash mismatch`);

  // 3. Duplicate release checks — exactly-once transitions.
  const milestones = repo.listMilestones(projectId);
  const accountEvents = repo.listAccountEventsForProject(projectId);
  const milestoneViolations = milestones
    .filter((m) => accountEvents.filter((e) => e.milestoneId === m.id && e.type === "RELEASED").length > 1)
    .map((m) => `M${m.seq}`);
  const drawViolations: string[] = [];
  for (const d of repo.listDrawRequestsForProject(projectId)) {
    const released = repo.listDrawAccountEvents(d.id).filter((e) => e.type === "RELEASED");
    if (released.length > 1) drawViolations.push(`Draw #${d.drawNumber}`);
  }
  const retainageByRelease = new Map<string, number>();
  for (const e of repo.listRetainageEventsForProject(projectId)) {
    if (e.type === "RELEASED" && e.retainageReleaseId) {
      retainageByRelease.set(e.retainageReleaseId, (retainageByRelease.get(e.retainageReleaseId) ?? 0) + 1);
    }
  }
  const retainageViolations = [...retainageByRelease.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id);
  for (const v of milestoneViolations) finding("CRITICAL", "DUPLICATE_RELEASE", `Duplicate tranche release recorded for ${v}`);
  for (const v of drawViolations) finding("CRITICAL", "DUPLICATE_RELEASE", `Duplicate draw release recorded for ${v}`);
  for (const v of retainageViolations) finding("CRITICAL", "DUPLICATE_RELEASE", `Duplicate retainage release recorded for request ${v}`);

  // 4. Approval record consistency: one decision per role per request;
  //    APPROVED requests carry an APPROVED record from every required role.
  const requests = repo.listAllApprovalRequestsForProject(projectId);
  const approvalViolations: string[] = [];
  for (const ar of requests) {
    const records = repo.listApprovalRecordsForRequest(ar.id);
    const seenRoles = new Set<string>();
    for (const rec of records) {
      if (seenRoles.has(rec.role)) approvalViolations.push(`${ar.id}: duplicate decision for role ${rec.role}`);
      seenRoles.add(rec.role);
    }
    if (ar.status === "APPROVED") {
      for (const role of ar.requiredRoles) {
        const rec = records.find((r) => r.role === role);
        if (!rec || rec.decision !== "APPROVED") {
          approvalViolations.push(`${ar.id}: APPROVED without an APPROVED record from ${role}`);
        }
      }
    }
  }
  for (const v of approvalViolations) finding("CRITICAL", "APPROVAL_RECORDS", `Approval integrity: ${v}`);

  // 5. Evidence object existence, where the storage is locally accessible.
  const evidence = milestones.flatMap((m) => repo.listEvidenceForMilestone(m.id));
  const missing: string[] = [];
  let notCheckable = 0;
  for (const ev of evidence) {
    const p = evidenceDiskPath(ev.photoPath);
    if (!p) {
      notCheckable++;
    } else if (!fs.existsSync(p)) {
      missing.push(ev.id);
    }
  }
  // Availability finding, not a trust-chain failure: the recorded hash
  // and ledger reference remain authoritative even when the local copy
  // of the object is unavailable.
  for (const id of missing) finding("WARNING", "EVIDENCE_OBJECT", `Evidence object missing on storage: ${id}`);

  const result: IntegrityValidation = {
    ledger: { state: ledgerState, valid: chain.valid, entries: chain.entries },
    ledgerHead: head ? { seq: head.seq, hash: head.currentHash } : null,
    configSnapshots: {
      total: snapshots.length,
      validHashes: snapshots.length - invalidVersions.length,
      invalidVersions,
    },
    duplicateReleases: { milestoneViolations, drawViolations, retainageViolations },
    approvals: { checked: requests.length, violations: approvalViolations },
    evidenceObjects: { checked: evidence.length - notCheckable, missing, notCheckable },
    findings,
    warnings: [],
    criticalCount: 0,
    overall: "CLEAN",
  };
  summarizeFindings(result);
  return result;
}

// ======================================================== register build

const fmtRoles = (roles: string[]) => roles.join("|");

interface SubjectContext {
  association: string;
  releaseConsequence: string;
}

function approvalSubjectContext(ar: ApprovalRequest): SubjectContext {
  const subject = ar.subjectType ?? "MILESTONE";
  if (subject === "MILESTONE" && ar.milestoneId) {
    const m = repo.getMilestone(ar.milestoneId);
    const released = m
      ? repo
          .listAccountEventsForProject(m.projectId)
          .find((e) => e.milestoneId === m.id && e.type === "RELEASED")
      : undefined;
    return {
      association: m ? `Milestone M${m.seq} · ${m.title}` : ar.milestoneId,
      releaseConsequence:
        ar.status === "APPROVED"
          ? released
            ? `Tranche RELEASED at ${released.createdAt}`
            : "Approved — no release event recorded"
          : "None — release requires full approval",
    };
  }
  if (subject === "DRAW" && ar.drawRequestId) {
    const d = repo.getDrawRequest(ar.drawRequestId);
    const released = d
      ? repo.listDrawAccountEvents(d.id).find((e) => e.type === "RELEASED")
      : undefined;
    return {
      association: d ? `Draw #${d.drawNumber}` : ar.drawRequestId,
      releaseConsequence:
        ar.status === "APPROVED"
          ? released
            ? `Draw RELEASED (net) at ${released.createdAt}`
            : "Approved — no release event recorded"
          : "None — release requires full approval",
    };
  }
  if (subject === "CHANGE_ORDER" && ar.changeOrderId) {
    const co = repo.getChangeOrder(ar.changeOrderId);
    return {
      association: co ? `Change order CO-${co.changeOrderNumber} · ${co.title}` : ar.changeOrderId,
      releaseConsequence: co?.appliedAt
        ? `Configuration applied at ${co.appliedAt} (snapshot v${co.appliedSnapshotVersion})`
        : "No money movement — configuration change only",
    };
  }
  if (subject === "RETAINAGE" && ar.retainageReleaseId) {
    const released = repo
      .listRetainageEventsForProject(repo.getRetainageRelease(ar.retainageReleaseId)?.projectId ?? "")
      .find((e) => e.type === "RELEASED" && e.retainageReleaseId === ar.retainageReleaseId);
    return {
      association: `Retainage release ${ar.retainageReleaseId}`,
      releaseConsequence: released
        ? `Retainage RELEASED at ${released.createdAt}`
        : "None — release requires full approval",
    };
  }
  return { association: "(unresolved subject)", releaseConsequence: "" };
}

export interface GenerateOptions {
  asOf?: string | null;
  includeReports?: boolean;
  includeCommMetadata?: boolean;
  /** Raw evidence media copies — explicit opt-in restricted to
   *  FUNDER_REP / COMPLIANCE_REVIEWER. */
  includeEvidenceMedia?: boolean;
  /** Optional cover-PDF renderer (Chromium lives at the HTTP layer).
   *  Returns null when PDF rendering is unavailable — the package then
   *  carries the printable HTML cover, honestly labelled in the manifest. */
  renderCoverPdf?: (html: string) => Promise<Buffer | null>;
  /** Cover HTML renderer (view layer, injected to keep this service
   *  free of JSX imports). */
  renderCoverHtml: (data: AuditCoverData) => string;
  /** Lender Draw Verification document renderer (view layer, injected).
   *  When present, each draw gets its verification sub-package under
   *  04_draws/DRAW-nnn/ in the audit package. */
  renderDrawDoc?: (data: drawPackage.DrawPackageData) => string;
}

export interface AuditCoverData {
  packageId: string;
  packageVersion: number;
  project: Project;
  organizationName: string;
  generatedAt: string;
  generatedBy: string;
  asOf: string;
  configurationVersion: number;
  controlledAmount: number;
  released: number;
  held: number;
  verifiedMilestones: number;
  totalMilestones: number;
  openExceptions: number;
  pendingApprovals: number;
  approvedChangeOrders: number;
  approvedChangeValue: number;
  retainageWithheld: number;
  retainageReleased: number;
  retainageRemaining: number;
  ledgerIntegrity: string;
  integrityState: "CLEAN" | "WARNINGS";
  integrityFindings: IntegrityFinding[];
  criticalFindings: number;
  sections: string[];
}

interface BuiltRegisters {
  files: PackageFile[];
  counts: Record<string, number>;
  sections: string[];
  notes: string[];
}

/** ISO strings compare lexicographically — a record belongs to the
 *  package when its timestamp is at or before the as-of point. */
const atOrBefore = (ts: string | null | undefined, asOf: string) => Boolean(ts && ts <= asOf);

function buildRegisters(
  project: Project,
  asOf: string,
  opts: { includeReports: boolean; includeCommMetadata: boolean; includeEvidenceMedia: boolean },
  integrity: IntegrityValidation
): BuiltRegisters {
  const files: PackageFile[] = [];
  const counts: Record<string, number> = {};
  const sections: string[] = [];
  const notes: string[] = [
    "Registers containing timestamped records exclude records created after asOfTimestamp.",
    "Current-state registers (milestones, budget lines, retainage position) reflect state at generation time.",
    "Evidence media is NOT included — the evidence register carries content hashes and protected application references.",
    "Communication transcripts are NEVER included; metadata counts appear only when explicitly requested.",
  ];
  const users = new Map(repo.listUsers().map((u) => [u.id, u]));
  const userName = (id: string | null | undefined) => (id ? users.get(id)?.name ?? id : "");
  const add = (name: string, data: string | Buffer, section: string, count?: number) => {
    files.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8") });
    if (!sections.includes(section)) sections.push(section);
    if (count !== undefined) counts[name] = count;
  };
  const milestones = repo.listMilestones(project.id);
  const milestoneById = new Map(milestones.map((m) => [m.id, m]));
  const msLabel = (id: string | null | undefined) => {
    const m = id ? milestoneById.get(id) : undefined;
    return m ? `M${m.seq}` : "";
  };

  // ---- 00_project_summary/project-config.json (current configuration)
  const projectConfig = {
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      location: project.location,
      totalBudget: project.totalBudget,
      status: project.status,
      projectType: project.projectType,
      pilot: project.pilot ?? null,
    },
    milestones: milestones.map((m) => ({
      id: m.id, seq: m.seq, title: m.title, requirement: m.requirement,
      trancheAmount: m.trancheAmount, weight: m.weight, status: m.status,
      accountStatus: m.accountStatus, plannedStart: m.plannedStart ?? null,
      plannedEnd: m.plannedEnd ?? null, archived: m.archived ?? false,
      requirements: repo.listRequirementsForMilestone(m.id),
    })),
    verificationPolicy: repo.getVerificationPolicy(project.id),
    approvalMatrix: repo.listApprovalPolicies(project.id),
  };
  add(
    "00_project_summary/project-config.json",
    JSON.stringify(projectConfig, null, 2),
    "00_project_summary"
  );

  // ---- 01_configuration
  const snapshots = repo.listConfigSnapshots(project.id).filter((s) => atOrBefore(s.createdAt, asOf));
  add(
    "01_configuration/configuration-snapshots.json",
    JSON.stringify(
      snapshots.map((s) => ({
        version: s.version,
        hash: s.hash,
        hashValid: !integrity.configSnapshots.invalidVersions.includes(s.version),
        reason: s.reason,
        createdBy: userName(s.createdBy),
        createdAt: s.createdAt,
        configuration: JSON.parse(s.data),
      })),
      null,
      2
    ),
    "01_configuration",
    snapshots.length
  );
  const auditRows = repo
    .listConfigAudit(project.id)
    .filter((a) => atOrBefore(a.createdAt, asOf));
  add(
    "01_configuration/configuration-audit.csv",
    csv(
      ["timestamp", "actor", "action", "entityType", "entityId", "reason", "before", "after"],
      auditRows.map((a) => [
        a.createdAt, userName(a.actorUserId), a.action, a.entityType, a.entityId,
        a.reason ?? "", a.beforeSummary ?? "", a.afterSummary ?? "",
      ])
    ),
    "01_configuration",
    auditRows.length
  );
  const matrix = repo.listApprovalPolicies(project.id);
  add(
    "01_configuration/approval-matrix.csv",
    csv(
      ["scope", "milestone", "requiredRoles"],
      matrix.map((p) => [
        p.milestoneId ? "MILESTONE" : "PROJECT_DEFAULT",
        msLabel(p.milestoneId),
        fmtRoles(p.requiredRoles),
      ])
    ),
    "01_configuration",
    matrix.length
  );
  add(
    "01_configuration/verification-policy.json",
    JSON.stringify(repo.getVerificationPolicy(project.id) ?? { policy: "DEFAULT" }, null, 2),
    "01_configuration"
  );

  // ---- 02_milestones
  add(
    "02_milestones/milestone-register.csv",
    csv(
      ["seq", "title", "requirement", "trancheAmount", "weight", "status", "accountStatus", "plannedStart", "plannedEnd", "archived"],
      milestones.map((m) => [
        m.seq, m.title, m.requirement, m.trancheAmount, m.weight ?? "", m.status,
        m.accountStatus, m.plannedStart ?? "", m.plannedEnd ?? "", m.archived ? "yes" : "no",
      ])
    ),
    "02_milestones",
    milestones.length
  );

  // ---- permit register, code basis, links, inspection chains, official
  // sources (Parts 11-12). Missing data stays NOT RECORDED — no invented
  // permits, editions, or sources; released milestones stay historical. ----
  const permitList = repo.listPermitsForProject(project.id);
  add(
    "02_milestones/permit-milestone-links.csv",
    csv(
      ["permitNumber", "permitType", "milestone", "scopeNote", "createdBy", "createdAt"],
      repo.listPermitLinksForProject(project.id).map((l) => {
        const permit = repo.getPermit(l.permitId);
        const m = repo.getMilestone(l.milestoneId);
        return [
          permit?.permitNumber ?? l.permitId,
          permit?.permitType ?? "",
          m ? `M${m.seq} · ${m.title}` : l.milestoneId,
          l.scopeNote ?? "",
          userName(l.createdByUserId),
          l.createdAt,
        ];
      })
    ),
    "03_permits",
    repo.listPermitLinksForProject(project.id).length
  );
  add(
    "03_permits/permits.csv",
    csv(
      ["permitNumber", "permitType", "issuingAuthority", "jurisdiction", "recordedStatus", "issuedAt", "effectiveAt", "expiresAt", "closedAt", "officialRecordNumber", "officialRecordUrl", "legacyReference", "configurationVersion", "createdBy", "createdAt"],
      permitList.map((x) => [
        x.permitNumber, x.permitType, x.issuingAuthority ?? "NOT RECORDED", x.jurisdiction ?? "NOT RECORDED",
        x.status, x.issuedAt ?? "", x.effectiveAt ?? "", x.expiresAt ?? "", x.closedAt ?? "",
        x.officialRecordNumber ?? "", x.officialRecordUrl ?? "", x.legacyReference ?? "",
        x.configurationVersion, userName(x.createdByUserId), x.createdAt,
      ])
    ),
    "03_permits",
    permitList.length
  );
  add(
    "03_permits/code-basis-register.csv",
    csv(
      ["permitNumber", "applicableCodeEdition", "codeEffectiveDate", "codeBasis", "determinedBy", "determinedAt", "configurationVersion"],
      permitList.map((x) => [
        x.permitNumber,
        x.applicableCodeEdition ?? "NOT RECORDED",
        x.codeEffectiveDate ?? "",
        x.codeBasis ?? "NOT RECORDED",
        x.codeDeterminedBy ? userName(x.codeDeterminedBy) : "",
        x.codeDeterminedAt ?? "",
        x.configurationVersion,
      ])
    ),
    "03_permits",
    permitList.length
  );
  const officialSources = repo.listOfficialSourcesForProject(project.id);
  add(
    "03_permits/official-source-records.csv",
    csv(
      ["sourceType", "officialSystemName", "officialRecordNumber", "officialRecordUrl", "officialStatusText", "lookupPerformedAt", "lookupPerformedBy", "capturedAt", "permitNumber", "inspectionId", "artifactHash"],
      officialSources.map((o) => [
        o.sourceType, o.officialSystemName ?? "", o.officialRecordNumber ?? "", o.officialRecordUrl ?? "",
        o.officialStatusText ?? "", o.lookupPerformedAt ?? "", userName(o.lookupPerformedByUserId),
        o.capturedAt ?? "", o.permitId ? repo.getPermit(o.permitId)?.permitNumber ?? o.permitId : "",
        o.inspectionId ?? "", o.sourceArtifactHash ?? "",
      ])
    ),
    "03_permits",
    officialSources.length
  );
  const inspectionChain = repo.listInspectionsForProject(project.id);
  add(
    "05_inspections/inspection-history.csv",
    csv(
      ["inspectionId", "milestone", "type", "status", "result", "scheduledAt", "completedAt", "resultRecordedAt", "governmentInspector", "reviewedBy", "reference", "permitNumber", "legacyPermitRef", "reinspectionOf", "supersededBy"],
      inspectionChain.map((i) => {
        const m = repo.getMilestone(i.milestoneId);
        return [
          i.id, m ? `M${m.seq}` : i.milestoneId, i.inspectionType ?? "", i.status, i.result ?? "",
          i.scheduledAt ?? "", i.completedAt ?? "", i.resultRecordedAt ?? "",
          i.governmentInspectorName ?? "", i.reviewedByUserId ? userName(i.reviewedByUserId) : "",
          i.inspectionReference ?? "",
          i.permitRefId ? repo.getPermit(i.permitRefId)?.permitNumber ?? i.permitRefId : "",
          i.permitId ?? "", i.reinspectionOfInspectionId ?? "", i.supersededByInspectionId ?? "",
        ];
      })
    ),
    "05_inspections",
    inspectionChain.length
  );
  add(
    "05_inspections/reinspection-links.csv",
    csv(
      ["reinspectionId", "followsInspectionId", "priorResultPreserved", "createdAt"],
      inspectionChain
        .filter((i) => i.reinspectionOfInspectionId)
        .map((i) => {
          const prior = repo.getInspection(i.reinspectionOfInspectionId!);
          return [i.id, i.reinspectionOfInspectionId!, prior?.result ?? "", i.createdAt];
        })
    ),
    "05_inspections",
    inspectionChain.filter((i) => i.reinspectionOfInspectionId).length
  );
  add(
    "05_inspections/correction-notices.csv",
    csv(
      ["inspectionId", "milestone", "correctionNoticeReference", "correctionSummary", "correctionDueAt", "reinspectionCreatedAt"],
      inspectionChain
        .filter((i) => i.correctionSummary || i.correctionNoticeReference)
        .map((i) => {
          const m = repo.getMilestone(i.milestoneId);
          return [
            i.id, m ? `M${m.seq}` : i.milestoneId, i.correctionNoticeReference ?? "",
            i.correctionSummary ?? "", i.correctionDueAt ?? "", i.correctionClearedAt ?? "",
          ];
        })
    ),
    "05_inspections",
    inspectionChain.filter((i) => i.correctionSummary || i.correctionNoticeReference).length
  );
  const reqRows = milestones.flatMap((m) =>
    repo.listRequirementsForMilestone(m.id).map((r) => [
      `M${m.seq}`, r.type, r.title, r.required ? "required" : "optional",
      r.minCount ?? "", (r.mediaTypes ?? []).join("|"),
      r.geolocationRequired ? "yes" : "no", r.recencyDays ?? "",
    ])
  );
  add(
    "02_milestones/milestone-gates.csv",
    csv(
      ["milestone", "contractorCompletion", "obvEvidenceReview", "inspectionRequirement", "requirementBasis", "inspectionStatus", "drawEligibility", "blockingReasonCodes"],
      milestones.map((m) => {
        const g = completionGates.milestoneGates(m.id);
        return [
          `M${m.seq} · ${m.title}`,
          g.contractor.status,
          g.evidenceReview.status,
          g.requirementValue,
          g.requirement?.requirementBasis ?? "NOT DETERMINED",
          g.inspectionGate,
          g.eligibility.result,
          g.eligibility.reasons.filter((r) => r.blocking).map((r) => r.code).join("|"),
        ];
      })
    ),
    "02_milestones",
    milestones.length
  );
  add(
    "02_milestones/evidence-requirements.csv",
    csv(["milestone", "type", "title", "required", "minCount", "mediaTypes", "geolocationRequired", "recencyDays"], reqRows),
    "02_milestones",
    reqRows.length
  );

  // ---- 03_evidence
  const ledger = repo.listLedgerEntries();
  const ledgerByEvidence = new Map(ledger.map((l) => [l.evidenceItemId, l]));
  const evidence = milestones
    .flatMap((m) => repo.listEvidenceForMilestone(m.id))
    .filter((e) => atOrBefore(e.uploadedAt, asOf));
  const evidenceRows = evidence.map((ev) => {
    const m = milestoneById.get(ev.milestoneId)!;
    const v = repo.getVerificationForEvidence(ev.id);
    const entry = ledgerByEvidence.get(ev.id);
    const approval = repo.getApprovalRequestForMilestone(ev.milestoneId);
    return [
      ev.id,
      `M${m.seq} · ${m.title}`,
      m.requirement,
      userName(ev.userId),
      ev.uploadedAt,
      ev.isDemoFallback ? "DEMO_FALLBACK" : "DEVICE_CAPTURE",
      ev.latitude != null && ev.longitude != null ? `${ev.latitude},${ev.longitude}` : "NO_FIX",
      v?.verdict ?? "NOT_VERIFIED",
      v ? v.confidence.toFixed(2) : "",
      v?.source ?? "",
      v?.policyVersion ?? "",
      entry?.seq ?? "",
      ev.hash,
      approval ? `${approval.id} (${approval.status})` : "",
      m.accountStatus,
      `/evidence/${ev.id}`,
    ];
  });
  add(
    "03_evidence/evidence-register.csv",
    csv(
      [
        "evidenceId", "milestone", "requirement", "submittedBy", "submittedAt",
        "captureMetadataState", "gpsState", "verificationVerdict", "confidence",
        "verificationProvenance", "policyVersion", "ledgerSeq", "evidenceHash",
        "approvalRequest", "fundState", "protectedReference",
      ],
      evidenceRows
    ),
    "03_evidence",
    evidenceRows.length
  );
  const verifications = evidence
    .map((ev) => repo.getVerificationForEvidence(ev.id))
    .filter((v): v is NonNullable<typeof v> => Boolean(v))
    .filter((v) => atOrBefore(v.createdAt, asOf));
  add(
    "03_evidence/verification-register.csv",
    csv(
      ["verificationId", "evidenceId", "verdict", "confidence", "provenance", "policyVersion", "checksPassed", "checksTotal", "verifiedAt", "reasoning"],
      verifications.map((v) => [
        v.id, v.evidenceItemId, v.verdict, v.confidence.toFixed(2), v.source,
        v.policyVersion ?? "", v.checks.filter((c) => c.passed).length, v.checks.length,
        v.createdAt, v.reasoning,
      ])
    ),
    "03_evidence",
    verifications.length
  );
  add(
    "03_evidence/provenance-register.csv",
    csv(
      ["evidenceId", "capturedAt", "uploadedAt", "captureMetadataState", "device", "gpsState", "contentHash", "previousEvidenceHash"],
      evidence.map((ev) => [
        ev.id, ev.capturedAt, ev.uploadedAt,
        ev.isDemoFallback ? "DEMO_FALLBACK" : "DEVICE_CAPTURE",
        ev.deviceMetadata?.platform || "unknown",
        ev.latitude != null && ev.longitude != null ? `${ev.latitude},${ev.longitude}` : "NO_FIX",
        ev.hash, ev.previousHash ?? "",
      ])
    ),
    "03_evidence",
    evidence.length
  );
  const projectLedger = ledger.filter(
    (l) => milestoneById.has(l.milestoneId) && atOrBefore(l.timestamp, asOf)
  );
  add(
    "03_evidence/ledger-references.csv",
    csv(
      ["seq", "timestamp", "evidenceId", "milestone", "verificationId", "payloadHash", "previousHash", "currentHash"],
      projectLedger.map((l) => [
        l.seq, l.timestamp, l.evidenceItemId, msLabel(l.milestoneId), l.verificationId,
        l.payloadHash, l.previousHash, l.currentHash,
      ])
    ),
    "03_evidence",
    projectLedger.length
  );

  // ---- 04_draws (only when the project has draws)
  const draws = repo
    .listDrawRequestsForProject(project.id)
    .filter((d) => atOrBefore(d.createdAt, asOf));
  if (draws.length) {
    add(
      "04_draws/draw-register.csv",
      csv(
        ["drawNumber", "status", "requestedAmount", "recommendedAmount", "approvedAmount", "retainageRate", "retainageWithheld", "periodStart", "periodEnd", "requestedBy", "submittedAt"],
        draws.map((d) => [
          d.drawNumber, d.status, d.requestedAmount, d.recommendedAmount ?? "", d.approvedAmount ?? "",
          d.retainageRate ?? "", d.retainageWithheld ?? "", d.periodStart, d.periodEnd,
          userName(d.requestedByUserId), d.submittedAt ?? "",
        ])
      ),
      "04_draws",
      draws.length
    );
    const lineRows = draws.flatMap((d) =>
      repo.listDrawLines(d.id).map((l) => [
        `#${d.drawNumber}`, l.description, msLabel(l.milestoneId),
        l.budgetLineId ?? "", l.changeOrderId ?? "", l.scheduledValue,
        l.currentRequested, l.status, l.supportedAmount ?? "",
      ])
    );
    add(
      "04_draws/draw-line-items.csv",
      csv(
        ["draw", "description", "milestone", "budgetLine", "changeOrder", "scheduledValue", "currentRequested", "reviewStatus", "supportedAmount"],
        lineRows
      ),
      "04_draws",
      lineRows.length
    );
    const drawReports = repo
      .listReports()
      .filter((r) => r.projectId === project.id && r.reportType === "DRAW_REVIEW_SUMMARY")
      .filter((r) => atOrBefore(r.generatedAt, asOf));
    add(
      "04_draws/draw-report-index.csv",
      csv(
        ["reportId", "filename", "generatedAt", "generatedBy", "ledgerIntegrityAtGeneration"],
        drawReports.map((r) => [r.id, r.filename, r.generatedAt, userName(r.generatedBy), r.integrityStatus])
      ),
      "04_draws",
      drawReports.length
    );
  }

  // ---- 05_budget (only when budget lines exist)
  const budgetLines = repo.listBudgetLines(project.id).filter((l) => l.active);
  if (budgetLines.length) {
    add(
      "05_budget/budget-register.csv",
      csv(
        ["code", "category", "description", "originalBudget", "approvedChanges", "currentBudget", "paidToDate", "retainageHeld"],
        budgetLines.map((l) => [
          l.code, l.category, l.description, l.originalBudget, l.approvedChanges,
          l.currentBudget, l.paidToDate, l.retainageHeld ?? "",
        ])
      ),
      "05_budget",
      budgetLines.length
    );
    const fin = assessFinancialProgress(project.id);
    const phys = assessPhysicalProgress(project.id);
    add(
      "05_budget/budget-vs-progress.csv",
      csv(
        ["metric", "value", "basis"],
        [
          ["financialProgressPct", fin.claimedPct, "paid + open draw claims over current budget"],
          ["paidPct", fin.paidPct, "paid to date over current budget"],
          ["verifiedPhysicalPct", phys.verifiedPct, phys.methodology],
          ["budgetBasis", fin.budgetBasis, fin.budgetBasisSource],
          ["originalBudget", fin.originalBudget, ""],
          ["approvedChanges", fin.approvedChanges, "approved change orders"],
          ["paidToDate", fin.paidToDate, ""],
          ["openDrawRequested", fin.openDrawRequested, ""],
          ["retainageHeld", fin.retainageHeld, ""],
          ...phys.contributions.map((c) => [
            `physical:${c.milestoneLabel}`,
            `${Math.round(c.weight * c.completion * 1000) / 10} pts`,
            `weight ${Math.round(c.weight * 1000) / 10}% × completion ${Math.round(c.completion * 100)}%`,
          ]),
        ]
      ),
      "05_budget",
      budgetLines.length
    );
  }

  // ---- 06_exceptions
  const exceptions = repo
    .listExceptionsForProject(project.id)
    .filter((e) => atOrBefore(e.openedAt, asOf));
  const waiverReason = (excId: string) => {
    const w = repo.listExceptionEvents(excId).find((ev) => ev.type === "WAIVED");
    return w ? w.detail : "";
  };
  if (exceptions.length) {
    add(
      "06_exceptions/exception-register.csv",
      csv(
        ["exceptionId", "category", "severity", "status", "sourceType", "sourceId", "title", "owner", "openedAt", "resolvedAt", "resolutionSummary", "waiverReason"],
        exceptions.map((e) => [
          e.id, e.category, e.severity, e.status, e.sourceType, e.sourceId, e.title,
          userName(e.ownerUserId), e.openedAt, e.resolvedAt ?? "",
          e.resolutionSummary ?? "", e.status === "WAIVED" ? waiverReason(e.id) : "",
        ])
      ),
      "06_exceptions",
      exceptions.length
    );
  }
  const issues = repo
    .listFieldIssues()
    .filter((i) => i.projectId === project.id && atOrBefore(i.createdAt, asOf));
  if (issues.length) {
    add(
      "06_exceptions/field-issues.csv",
      csv(
        ["issueId", "title", "category", "severity", "status", "milestone", "reportedBy", "createdAt", "resolvedAt", "resolutionSummary"],
        issues.map((i) => [
          i.id, i.title, i.category, i.severity, i.status, msLabel(i.milestoneId),
          userName(i.reportedByUserId), i.createdAt, i.resolvedAt ?? "", i.resolutionSummary ?? "",
        ])
      ),
      "06_exceptions",
      issues.length
    );
  }
  const clarifications = milestones
    .flatMap((m) => repo.listClarificationsForMilestone(m.id))
    .filter((c) => atOrBefore(c.createdAt, asOf));
  if (clarifications.length) {
    add(
      "06_exceptions/clarifications.csv",
      csv(
        ["clarificationId", "milestone", "question", "responseType", "status", "requestedBy", "createdAt", "resolutionNote"],
        clarifications.map((c) => [
          c.id, msLabel(c.milestoneId), c.question, c.responseType, c.status,
          userName(c.requestedByUserId), c.createdAt, c.resolutionNote ?? "",
        ])
      ),
      "06_exceptions",
      clarifications.length
    );
  }

  // ---- 07_governance
  const requests = repo
    .listAllApprovalRequestsForProject(project.id)
    .filter((ar) => atOrBefore(ar.createdAt, asOf));
  add(
    "07_governance/approval-requests.csv",
    csv(
      ["approvalRequestId", "subjectType", "association", "requiredRoles", "status", "createdAt", "releaseConsequence"],
      requests.map((ar) => {
        const ctx = approvalSubjectContext(ar);
        return [
          ar.id, ar.subjectType ?? "MILESTONE", ctx.association, fmtRoles(ar.requiredRoles),
          ar.status, ar.createdAt, ctx.releaseConsequence,
        ];
      })
    ),
    "07_governance",
    requests.length
  );
  const recordRows = requests.flatMap((ar) =>
    repo
      .listApprovalRecordsForRequest(ar.id)
      .filter((rec) => atOrBefore(rec.createdAt, asOf))
      .map((rec) => [ar.id, rec.role, userName(rec.userId), rec.decision, rec.createdAt])
  );
  add(
    "07_governance/approval-records.csv",
    csv(["approvalRequestId", "role", "actor", "decision", "timestamp"], recordRows),
    "07_governance",
    recordRows.length
  );
  const timeline = requests
    .flatMap((ar) => {
      const ctx = approvalSubjectContext(ar);
      const rows: unknown[][] = [
        [ar.createdAt, ar.id, ctx.association, "REQUEST_OPENED", "", `Requires: ${fmtRoles(ar.requiredRoles)}`],
      ];
      for (const rec of repo.listApprovalRecordsForRequest(ar.id)) {
        if (!atOrBefore(rec.createdAt, asOf)) continue;
        rows.push([rec.createdAt, ar.id, ctx.association, `DECISION_${rec.decision}`, userName(rec.userId), `as ${rec.role}`]);
      }
      if (ar.status !== "PENDING") {
        rows.push(["", ar.id, ctx.association, `FINAL_${ar.status}`, "", ctx.releaseConsequence]);
      }
      return rows;
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  add(
    "07_governance/approval-timeline.csv",
    csv(["timestamp", "approvalRequestId", "association", "event", "actor", "detail"], timeline),
    "07_governance",
    timeline.length
  );

  // ---- 08_financial_state
  const accountEvents = repo
    .listAccountEventsForProject(project.id)
    .filter((e) => atOrBefore(e.createdAt, asOf));
  add(
    "08_financial_state/tranche-state-register.csv",
    csv(
      ["timestamp", "milestone", "amount", "previousState", "newState", "reason", "approvalRequestId", "releaseEventId"],
      accountEvents.map((e) => {
        const m = milestoneById.get(e.milestoneId);
        const approval = e.type === "RELEASED" ? repo.getApprovalRequestForMilestone(e.milestoneId) : null;
        return [
          e.createdAt, m ? `M${m.seq} · ${m.title}` : e.milestoneId, e.amount,
          e.type === "HELD" ? "UNFUNDED" : "HELD", e.type,
          e.type === "HELD" ? "Tranche held at financial close" : "Full governance approval",
          approval?.id ?? "", e.id,
        ];
      })
    ),
    "08_financial_state",
    accountEvents.length
  );
  const releaseRows: unknown[][] = [];
  for (const e of accountEvents.filter((e) => e.type === "RELEASED")) {
    const m = milestoneById.get(e.milestoneId);
    releaseRows.push([
      e.createdAt, "MILESTONE_TRANCHE", m ? `M${m.seq}` : e.milestoneId, e.amount,
      "HELD", "RELEASED", "Milestone approved by full governance",
      repo.getApprovalRequestForMilestone(e.milestoneId)?.id ?? "", e.id,
    ]);
  }
  for (const d of draws) {
    for (const e of repo.listDrawAccountEvents(d.id).filter((e) => atOrBefore(e.createdAt, asOf))) {
      releaseRows.push([
        e.createdAt, `DRAW_${e.type}`, `Draw #${d.drawNumber}`, e.amount,
        e.type === "RELEASED" ? "HELD" : "REQUESTED", e.type,
        e.type === "RELEASED" ? "Draw approved by full governance (net of retainage)" : "Draw reached governance",
        repo.getApprovalRequestForDraw(d.id)?.id ?? "", e.id,
      ]);
    }
  }
  const retEvents = repo
    .listRetainageEventsForProject(project.id)
    .filter((e) => atOrBefore(e.createdAt, asOf));
  for (const e of retEvents) {
    releaseRows.push([
      e.createdAt, `RETAINAGE_${e.type}`,
      e.drawRequestId ? `Draw ${e.drawRequestId}` : `Release ${e.retainageReleaseId}`,
      e.amount,
      e.type === "WITHHELD" ? "DUE_ON_DRAW" : "WITHHELD", e.type,
      e.type === "WITHHELD"
        ? "Withheld inside the governed draw release"
        : "Retainage release approved by full governance",
      e.retainageReleaseId ? repo.getApprovalRequestForRetainageRelease(e.retainageReleaseId)?.id ?? "" : "",
      e.id,
    ]);
  }
  releaseRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  add(
    "08_financial_state/release-events.csv",
    csv(
      ["timestamp", "scope", "reference", "amount", "previousState", "newState", "reason", "approvalRequestId", "releaseEventId"],
      releaseRows
    ),
    "08_financial_state",
    releaseRows.length
  );
  const retSummary = retainageSummary(project.id);
  const retReleases = repo
    .listRetainageReleasesForProject(project.id)
    .filter((r) => atOrBefore(r.createdAt, asOf));
  add(
    "08_financial_state/retainage-register.csv",
    csv(
      ["record", "amount", "status", "requestedBy", "requestedAt", "conditions", "approvalRequestId"],
      [
        ["POSITION_WITHHELD_TO_DATE", retSummary.withheldToDate, "", "", "", "", ""],
        ["POSITION_RELEASED_TO_DATE", retSummary.releasedToDate, "", "", "", "", ""],
        ["POSITION_REMAINING", retSummary.remaining, "", "", "", "", ""],
        ...retReleases.map((r) => [
          `RELEASE_REQUEST ${r.id}`, r.amount, r.status, userName(r.requestedByUserId), r.createdAt,
          repo
            .listRetainageConditions(r.id)
            .map((c) => `${c.condition}:${c.satisfied ? "SATISFIED" : "OUTSTANDING"}`)
            .join("|"),
          repo.getApprovalRequestForRetainageRelease(r.id)?.id ?? "",
        ]),
      ]
    ),
    "08_financial_state",
    retReleases.length + 3
  );

  // ---- 09_change_orders (only when the project has change orders)
  const changeOrders = repo
    .listChangeOrdersForProject(project.id)
    .filter((c) => atOrBefore(c.createdAt, asOf));
  if (changeOrders.length) {
    add(
      "09_change_orders/change-order-register.csv",
      csv(
        ["number", "title", "reason", "status", "requestedAmount", "approvedAmount", "scheduleImpactDays", "requestedBy", "requestedAt", "appliedAt", "appliedSnapshotVersion", "approvalRequestId"],
        changeOrders.map((c) => [
          `CO-${c.changeOrderNumber}`, c.title, c.reasonCategory, c.status,
          c.requestedAmount, c.approvedAmount ?? "", c.scheduleImpactDays ?? "",
          userName(c.requestedByUserId), c.requestedAt ?? "", c.appliedAt ?? "",
          c.appliedSnapshotVersion ?? "", repo.getApprovalRequestForChangeOrder(c.id)?.id ?? "",
        ])
      ),
      "09_change_orders",
      changeOrders.length
    );
  }

  // ---- 11_reports
  const projectReports = repo
    .listReports()
    .filter((r) => r.projectId === project.id && atOrBefore(r.generatedAt, asOf));
  const reportFileRefs: string[] = [];
  if (opts.includeReports) {
    for (const r of projectReports) {
      const p = path.join(REPORTS_DIR, r.id, r.filename);
      if (fs.existsSync(p)) {
        const name = `11_reports/files/${r.id}__${r.filename}`;
        add(name, fs.readFileSync(p), "11_reports");
        reportFileRefs.push(name);
      } else {
        // Availability warning: the register reference remains; the
        // historical artifact itself is no longer on storage.
        integrity.findings.push({
          severity: "WARNING",
          category: "REPORT_ARTIFACT",
          message: `Historical report artifact unavailable while register reference remains: ${r.id} (${r.filename})`,
        });
        reportFileRefs.push("NOT_ON_DISK");
      }
    }
  }
  add(
    "11_reports/report-index.csv",
    csv(
      ["reportId", "type", "filename", "generatedAt", "generatedBy", "configurationVersion", "integrityStateAtGeneration", "fileReference"],
      projectReports.map((r, i) => [
        r.id, r.reportType, r.filename, r.generatedAt, userName(r.generatedBy),
        "", r.integrityStatus,
        opts.includeReports ? reportFileRefs[i] ?? "" : `application:/reports/file/${r.id}`,
      ])
    ),
    "11_reports",
    projectReports.length
  );

  // ---- optional communication METADATA summary (counts only, no bodies,
  // no identities, no transcripts).
  if (opts.includeCommMetadata) {
    const threads = repo.listThreads().filter((t) => t.projectId === project.id);
    const byScope: Record<string, number> = {};
    let messageCount = 0;
    for (const t of threads) {
      byScope[t.scope] = (byScope[t.scope] ?? 0) + 1;
      messageCount += repo
        .listMessagesForThread(t.id)
        .filter((msg) => atOrBefore(msg.createdAt, asOf)).length;
    }
    add(
      "12_communications_metadata/comm-metadata-summary.json",
      JSON.stringify(
        {
          note:
            "Metadata counts only. Message bodies, attachments, participant identities and transcripts are NEVER included in audit packages.",
          threads: threads.length,
          threadsByScope: byScope,
          messagesAtOrBeforeAsOf: messageCount,
        },
        null,
        2
      ),
      "12_communications_metadata",
      threads.length
    );
    notes.push("Communication metadata summary included by explicit request (counts only).");
  }

  // ---- 03_evidence/media (explicit, role-authorized opt-in ONLY) ----
  // Copies PROJECT EVIDENCE objects only — never communication media or
  // attachments, never signed URLs, never provider paths. Each copy is
  // re-hashed so the packaged bytes are independently verifiable against
  // the recorded evidence hash.
  if (opts.includeEvidenceMedia) {
    const mediaRows: unknown[][] = [];
    for (const ev of evidence) {
      const diskPath = evidenceDiskPath(ev.photoPath);
      const safeBase = path
        .basename(ev.photoPath)
        .replace(/[^A-Za-z0-9._-]/g, "_")
        .slice(0, 80);
      if (diskPath && fs.existsSync(diskPath)) {
        const bytes = fs.readFileSync(diskPath);
        const packagedHash = createHash("sha256").update(bytes).digest("hex");
        const name = `03_evidence/media/${ev.id}__${safeBase}`;
        add(name, bytes, "03_evidence");
        mediaRows.push([
          ev.id, name, mimeForFilename(safeBase), ev.hash, packagedHash,
          packagedHash === ev.hash ? "yes" : "no",
          packagedHash === ev.hash
            ? "ORIGINAL"
            : ev.isDemoFallback
              ? "DEMO_FALLBACK_STANDIN"
              : "DERIVATIVE",
          bytes.length,
        ]);
      } else {
        integrity.findings.push({
          severity: "WARNING",
          category: "EVIDENCE_MEDIA",
          message: `Optional evidence media unavailable on storage: ${ev.id}`,
        });
        mediaRows.push([ev.id, "NOT_AVAILABLE", "", ev.hash, "", "", "", ""]);
      }
    }
    add(
      "03_evidence/media-manifest.csv",
      csv(
        ["evidenceId", "packagedPath", "mimeType", "recordedEvidenceHash", "packagedCopyHash", "hashesMatch", "provenance", "bytes"],
        mediaRows
      ),
      "03_evidence",
      mediaRows.length
    );
    notes.push(
      "Evidence media copies included by explicit authorized request. Each packaged copy is re-hashed; " +
        "provenance ORIGINAL means the packaged bytes match the recorded evidence hash. " +
        "No signed URLs, no provider credentials, no communication attachments."
    );
  }

  // ---- 10_integrity (written LAST so availability findings recorded
  // while building the registers above are included) ----
  summarizeFindings(integrity);
  add(
    "10_integrity/ledger-integrity-report.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        method: "Recomputed hash chain from genesis over all ledger entries",
        result: integrity.ledger,
        ledgerHead: integrity.ledgerHead,
        projectEntries: projectLedger.length,
      },
      null,
      2
    ),
    "10_integrity"
  );
  add(
    "10_integrity/configuration-hash-validation.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        method: "sha256 recomputed over each stored snapshot document",
        result: integrity.configSnapshots,
      },
      null,
      2
    ),
    "10_integrity"
  );
  add(
    "10_integrity/object-hash-validation.json",
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        method:
          "Evidence object existence on locally accessible storage; duplicate-release and approval-record consistency checks",
        evidenceObjects: integrity.evidenceObjects,
        duplicateReleases: integrity.duplicateReleases,
        approvals: integrity.approvals,
        findings: integrity.findings,
        criticalFindings: integrity.criticalCount,
        overall: integrity.overall,
        warnings: integrity.warnings,
      },
      null,
      2
    ),
    "10_integrity"
  );

  // ---- 07_lender (lender operating layer, as-of filtered) ----
  for (const lf of buildLenderFiles(project.id, null, asOf)) {
    add(`07_lender/${lf.name}`, lf.content, "07_lender", lf.count);
  }
  notes.push(
    "Lender-layer registers are administrative records: loan figures are external servicing references, external funding rows mirror lender actions outside OBV, and none of them change verification, approval, or release state."
  );

  return { files, counts, sections, notes };
}

// =========================================================== generation

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export async function generateAuditPackage(
  user: User,
  projectId: string,
  opts: GenerateOptions
): Promise<AuditPackage> {
  const project = assertProjectAccess(user, projectId);
  const now = new Date().toISOString();
  let asOf = now;
  if (opts.asOf) {
    const t = Date.parse(opts.asOf);
    if (!Number.isFinite(t)) throw new AuditPackageError("asOf must be a valid ISO timestamp");
    if (t > Date.now() + 60_000) throw new AuditPackageError("asOf cannot be in the future");
    asOf = new Date(t).toISOString();
  }
  const includeReports = opts.includeReports !== false;
  const includeCommMetadata = opts.includeCommMetadata === true;
  const includeEvidenceMedia = opts.includeEvidenceMedia === true;
  // Raw evidence media is a stronger disclosure than registers+hashes:
  // it requires an explicitly authorized lender-side role.
  if (includeEvidenceMedia && !["FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(user.role)) {
    throw new AuditPackageError(
      "Including raw evidence media requires a funder representative or compliance reviewer",
      403
    );
  }
  const configurationVersion = project.pilot?.configVersion ?? 1;

  const pkg: AuditPackage = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    packageVersion: repo.nextAuditPackageVersion(project.id),
    requestedBy: user.id,
    requestedAt: now,
    status: "QUEUED",
    asOfTimestamp: asOf,
    configurationVersion,
    ledgerIntegrityState: "NOT_EVALUATED",
    integrityState: "NOT_EVALUATED",
    manifestHash: null,
    storageObjectKey: null,
    completedAt: null,
    failureCategory: null,
    includeReports,
    includeCommMetadata,
    includeEvidenceMedia,
    integrityCritical: 0,
    fileCount: 0,
    sizeBytes: 0,
  };
  repo.insertAuditPackage(pkg);
  repo.updateAuditPackage(pkg.id, { status: "GENERATING" });

  try {
    // 0. Mandatory financial reconciliation — FATAL on mismatch, never a
    //    mere warning: the released totals recorded by the
    //    VirtualAccountService must equal the tranche amounts of
    //    milestones in RELEASED state. Checked on live state (not as-of
    //    filtered) because it guards the register sources themselves. A
    //    mismatch aborts generation with an auditable FAILED package row.
    const reconMilestones = repo.listMilestones(project.id);
    const releasedEventTotal = repo
      .listAccountEventsForProject(project.id)
      .filter((e) => e.type === "RELEASED")
      .reduce((sum, e) => sum + e.amount, 0);
    const releasedStateTotal = reconMilestones
      .filter((m) => m.accountStatus === "RELEASED")
      .reduce((sum, m) => sum + m.trancheAmount, 0);
    if (releasedEventTotal !== releasedStateTotal) {
      throw new AuditPackageError(
        `Financial register reconciliation failed: released events total ${releasedEventTotal} but milestone release state totals ${releasedStateTotal}`,
        500,
        "FINANCIAL_RECONCILIATION"
      );
    }

    // 1. Integrity validation FIRST — the outcome shapes the package.
    const integrity = await validateProjectIntegrity(project.id);

    // 2. Structured registers.
    const { files, counts, sections, notes } = buildRegisters(
      project,
      asOf,
      { includeReports, includeCommMetadata, includeEvidenceMedia },
      integrity
    );
    // Register building can add availability findings (missing report
    // artifacts, unavailable optional media) — refresh the summary.
    summarizeFindings(integrity);

    // 2b. Lender Draw Verification sub-packages — one per draw, under
    //     04_draws/DRAW-nnn/, assembled from the same authoritative
    //     sources (registers + lender document). Failures are honest
    //     availability warnings, never silent omissions.
    if (opts.renderDrawDoc) {
      const packageDraws = repo
        .listDrawRequestsForProject(project.id)
        .filter((dr) => dr.createdAt <= asOf && dr.status !== "CANCELLED");
      for (const dr of packageDraws) {
        try {
          const subData = await drawPackage.assembleDrawPackageData(user, dr.id);
          const regs = drawPackage.buildDrawPackageFiles(subData);
          const dir = `04_draws/DRAW-${String(dr.drawNumber).padStart(3, "0")}`;
          const docHtml = opts.renderDrawDoc(subData);
          const docPdf = opts.renderCoverPdf ? await opts.renderCoverPdf(docHtml) : null;
          if (docPdf) {
            files.push({ name: `${dir}/draw-verification-package.pdf`, data: docPdf });
          } else {
            files.push({
              name: `${dir}/draw-verification-package.html`,
              data: Buffer.from(docHtml, "utf8"),
            });
          }
          for (const f of regs.files) {
            files.push({ name: `${dir}/${f.name}`, data: f.data });
            if (regs.counts[f.name] !== undefined) counts[`${dir}/${f.name}`] = regs.counts[f.name];
          }
        } catch (err) {
          integrity.findings.push({
            severity: "WARNING",
            category: "REPORT_ARTIFACT",
            message: `Draw verification sub-package could not be assembled for Draw #${dr.drawNumber}: ${(err as Error).message}`,
          });
        }
      }
      summarizeFindings(integrity);
    }

    // 3. Human-readable cover summary (entry point for an auditor).
    const org = repo.getOrganization(project.organizationId);
    const milestones = repo.listMilestones(project.id);
    const verifiedStates = new Set(["VERIFIED", "APPROVED", "RELEASED"]);
    const released = repo
      .listAccountEventsForProject(project.id)
      .filter((e) => e.type === "RELEASED" && atOrBefore(e.createdAt, asOf))
      .reduce((s, e) => s + e.amount, 0);
    const controlled = project.pilot?.obvControlledAmount ?? project.totalBudget;
    const openExceptions = repo
      .listExceptionsForProject(project.id)
      .filter((e) => !["RESOLVED", "CLOSED", "WAIVED"].includes(e.status)).length;
    const pendingApprovals = repo
      .listAllApprovalRequestsForProject(project.id)
      .filter((ar) => ar.status === "PENDING").length;
    const approvedCos = repo
      .listChangeOrdersForProject(project.id)
      .filter((c) => ["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(c.status));
    const retSummary = retainageSummary(project.id);
    const cover: AuditCoverData = {
      packageId: pkg.id,
      packageVersion: pkg.packageVersion,
      project,
      organizationName: org?.name ?? project.organizationId,
      generatedAt: now,
      generatedBy: user.name,
      asOf,
      configurationVersion,
      controlledAmount: controlled,
      released,
      held: Math.max(0, controlled - released),
      verifiedMilestones: milestones.filter((m) => verifiedStates.has(m.status)).length,
      totalMilestones: milestones.length,
      openExceptions,
      pendingApprovals,
      approvedChangeOrders: approvedCos.length,
      approvedChangeValue: approvedCos.reduce((s, c) => s + (c.approvedAmount ?? c.requestedAmount), 0),
      retainageWithheld: retSummary.withheldToDate,
      retainageReleased: retSummary.releasedToDate,
      retainageRemaining: retSummary.remaining,
      ledgerIntegrity: integrity.ledger.state,
      integrityState: integrity.overall,
      integrityFindings: integrity.findings,
      criticalFindings: integrity.criticalCount,
      sections,
    };
    const coverHtml = opts.renderCoverHtml(cover);
    let coverFormat: "pdf" | "html" = "html";
    if (opts.renderCoverPdf) {
      const pdf = await opts.renderCoverPdf(coverHtml);
      if (pdf) {
        files.unshift({ name: "00_project_summary/project-summary.pdf", data: pdf });
        coverFormat = "pdf";
      }
    }
    if (coverFormat === "html") {
      files.unshift({ name: "00_project_summary/project-summary.html", data: Buffer.from(coverHtml, "utf8") });
      notes.push("Cover summary is printable HTML (PDF renderer unavailable in this environment).");
    }

    // 4. Manifest with a full hashed file inventory. The manifest hash is
    //    computed over the manifest with manifestHash set to null, then
    //    embedded — recomputable by any verifier.
    const fileKind = (name: string): string => {
      if (name.endsWith(".csv")) return "csv-register";
      if (name.endsWith(".json")) return "json";
      if (name.endsWith(".pdf")) return "pdf";
      if (name.endsWith(".html")) return "html";
      return "binary";
    };
    const inventory = files.map((f) => ({
      path: f.name,
      bytes: f.data.length,
      sha256: createHash("sha256").update(f.data).digest("hex"),
      kind: fileKind(f.name),
      /** Data rows for CSV registers / primary records for JSON registers;
       *  null where a record count does not apply (cover, binaries). */
      records: counts[f.name] ?? null,
      schemaVersion: AUDIT_PACKAGE_SCHEMA_VERSION,
    }));
    const manifestBase = {
      kind: "OBV_AUDIT_PACKAGE",
      schemaVersion: AUDIT_PACKAGE_SCHEMA_VERSION,
      packageId: pkg.id,
      packageVersion: pkg.packageVersion,
      project: { id: project.id, name: project.name, location: project.location },
      organization: { id: project.organizationId, name: org?.name ?? null },
      generatedAt: now,
      generatedBy: { id: user.id, name: user.name, role: user.role },
      asOfTimestamp: asOf,
      configurationVersion,
      /** Consistency model — stated, not overclaimed: registers with
       *  record timestamps exclude records created after asOfTimestamp
       *  (creation-time cutoff). Mutable current-state registers
       *  (milestones, budget lines, retainage position) reflect state at
       *  generation time; full historical state reconstruction is NOT
       *  performed. */
      consistencyModel: "CREATION_TIME_CUTOFF",
      /** Ledger head reference at generation — pins the package to a
       *  specific chain position for later verification. */
      ledgerHead: integrity.ledgerHead,
      options: {
        includeReports,
        includeCommMetadata,
        includeEvidenceMedia,
        includeCommTranscripts: false,
      },
      includedSections: sections,
      recordCounts: counts,
      integrity: {
        overall: integrity.overall,
        criticalFindings: integrity.criticalCount,
        warningFindings: integrity.findings.length - integrity.criticalCount,
        findings: integrity.findings,
        ledger: integrity.ledger,
        configurationSnapshots: integrity.configSnapshots,
        duplicateReleases: integrity.duplicateReleases,
        approvals: { checked: integrity.approvals.checked, violations: integrity.approvals.violations },
        evidenceObjects: integrity.evidenceObjects,
        warnings: integrity.warnings,
      },
      coverSummaryFormat: coverFormat,
      notes,
      fileInventory: inventory,
      manifestHash: null as string | null,
    };
    const manifestHash = createHash("sha256").update(canonicalJson(manifestBase)).digest("hex");
    const manifest = { ...manifestBase, manifestHash };
    files.unshift({ name: "manifest.json", data: Buffer.from(canonicalJson(manifest), "utf8") });

    // 5. Write-once ZIP (immutable once READY).
    const zip = buildZip(files, now);
    const filename = `obv-audit-package-${(project.pilot?.code ?? project.id).toLowerCase()}-v${pkg.packageVersion}.zip`;
    const dir = path.join(AUDIT_PACKAGES_DIR, pkg.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), zip, { flag: "wx" });

    // 6. READY — and never silently clean: integrityState carries the
    //    explicit outcome, and prior READY packages become SUPERSEDED
    //    (still stored and downloadable per retention).
    for (const prev of repo.listAuditPackagesForProject(project.id)) {
      if (prev.id !== pkg.id && prev.status === "READY") {
        repo.updateAuditPackage(prev.id, { status: "SUPERSEDED" });
      }
    }
    repo.updateAuditPackage(pkg.id, {
      status: "READY",
      ledgerIntegrityState: integrity.ledger.state,
      integrityState: integrity.overall,
      integrityCritical: integrity.criticalCount,
      manifestHash,
      storageObjectKey: `audit-packages/${pkg.id}/${filename}`,
      completedAt: new Date().toISOString(),
      fileCount: files.length,
      sizeBytes: zip.length,
    });
    audit({
      projectId: project.id,
      actorUserId: user.id,
      action: "AUDIT_PACKAGE_GENERATED",
      entityType: "AUDIT_PACKAGE",
      entityId: pkg.id,
      reason: null,
      beforeSummary: pkg.packageVersion > 1 ? `Supersedes v${pkg.packageVersion - 1}` : null,
      afterSummary: `v${pkg.packageVersion} · ${files.length} files · integrity ${integrity.overall}${integrity.criticalCount ? ` (${integrity.criticalCount} critical)` : ""} · ledger ${integrity.ledger.state}${includeEvidenceMedia ? " · evidence media included" : ""}`,
    });
    return repo.getAuditPackage(pkg.id)!;
  } catch (err) {
    repo.updateAuditPackage(pkg.id, {
      status: "FAILED",
      failureCategory:
        err instanceof AuditPackageError
          ? err.failureCategory ?? "VALIDATION"
          : "GENERATION_ERROR",
      completedAt: new Date().toISOString(),
    });
    audit({
      projectId: project.id,
      actorUserId: user.id,
      action: "AUDIT_PACKAGE_FAILED",
      entityType: "AUDIT_PACKAGE",
      entityId: pkg.id,
      reason: (err as Error).message.slice(0, 200),
      beforeSummary: null,
      afterSummary: null,
    });
    throw err;
  }
}

// ============================================================= download

export function listPackages(user: User, projectId: string): AuditPackage[] {
  assertProjectAccess(user, projectId);
  return repo.listAuditPackagesForProject(projectId);
}

/** Resolve a package for download: tenant + role gated, must be READY or
 *  SUPERSEDED (retention keeps old versions available), file must exist.
 *  Every successful resolution is audited by the caller. */
export function resolvePackageDownload(
  user: User,
  packageId: string
): { pkg: AuditPackage; filePath: string; filename: string } {
  const pkg = repo.getAuditPackage(packageId);
  if (!pkg) throw new AuditPackageError("Unknown audit package", 404);
  assertProjectAccess(user, pkg.projectId); // 404 across tenants
  if (!["READY", "SUPERSEDED"].includes(pkg.status) || !pkg.storageObjectKey) {
    throw new AuditPackageError(`Package is ${pkg.status} — not downloadable`, 409);
  }
  const filePath = path.join(DATA_DIR, pkg.storageObjectKey);
  if (!fs.existsSync(filePath)) throw new AuditPackageError("Package file no longer on storage", 410);
  return { pkg, filePath, filename: path.basename(filePath) };
}

export function auditPackageDownload(user: User, pkg: AuditPackage): void {
  audit({
    projectId: pkg.projectId,
    actorUserId: user.id,
    action: "AUDIT_PACKAGE_DOWNLOADED",
    entityType: "AUDIT_PACKAGE",
    entityId: pkg.id,
    reason: null,
    beforeSummary: null,
    afterSummary: `v${pkg.packageVersion} (${pkg.status})`,
  });
}
