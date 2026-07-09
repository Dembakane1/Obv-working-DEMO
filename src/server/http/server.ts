/**
 * OBV HTTP server — node:http with hand-rolled routing.
 *
 * Built without a framework because the build environment has no access to
 * the npm registry. Handlers are organised like Next.js route handlers
 * (one function per method+path) so a future migration to Next.js App
 * Router route handlers is mechanical.
 */
import "../env";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb, REPORTS_DIR, WORM_DIR } from "../db/index";
import * as repo from "../db/repo";
import { seedDemo } from "../db/seed";
import { virtualAccountService } from "../services/VirtualAccountService";
import { wormEvidenceStore } from "../services/WormEvidenceStore";
import { TEAMS_CONFIG, teamsNotifier } from "../services/TeamsNotifier";
import { AI_PROVIDER } from "../services/verification/config";
import { integrityFailureCard } from "../services/teamsCards";
import { pointInPolygon, polygonCentroid } from "../services/geo";
import * as pilot from "../services/pilot/onboarding";
import { PROJECT_TEMPLATES } from "../services/pilot/templates";
import {
  renderInviteAccept,
  renderPilotDashboard,
  renderPilotSetup,
  renderProjectSetup,
} from "../view/pilotPages";
import {
  canAccessThread,
  ensureMilestoneThread,
  ensureProjectThread,
  listThreadsForUser,
  mirrorEvent,
  postMessage,
} from "../services/chat";
import {
  canManageBindings,
  connectThread,
  disconnectThread,
  maintainSubscriptions,
  processNotificationItem,
  sendCapability,
  syncConfigured,
  syncOutbound,
} from "../services/teamsSync/bridge";
import { GRAPH_CONFIG } from "../services/teamsSync/config";
import {
  assignParticipantContext,
  ensureUnresolvedThread,
  handleStatusUpdate,
  handleWhatsAppInbound,
  syncOutboundWhatsApp,
  whatsappConfigured,
  whatsappStatus,
  displayPhone,
} from "../services/whatsappSync/bridge";
import { WHATSAPP_CONFIG } from "../services/whatsappSync/config";
import {
  COMM_MEDIA_DIR,
  parseWebhook,
  probePhoneNumber,
  verifySignature,
  WhatsAppSyncError,
} from "../services/whatsappSync/provider";
import {
  canManageFieldOps,
  createClarification,
  createEvidenceDraft,
  createFieldIssue,
  submitDraft,
  updateClarificationStatus,
  updateIssueStatus,
} from "../services/fieldOps";
import { ConversationSyncError } from "../services/teamsSync/types";
import {
  processApprovalDecision,
  processEvidenceSubmission,
  SubmissionError,
} from "../workflow/orchestrator";
import {
  ApprovalQueueItem,
  ComplianceData,
  EvidenceBundle,
  Insight,
  MilestoneRow,
  OverviewMetrics,
  ProjectCardData,
  ProjectTab,
  renderApprovals,
  renderCompliance,
  renderError,
  renderFieldShell,
  renderInsights,
  renderLedger,
  renderCommunications,
  renderIntegrations,
  renderIssueDetail,
  renderIssueNew,
  renderIssues,
  renderDraftNew,
  renderMap,
  renderMilestoneDetail,
  renderMore,
  renderOverview,
  renderProjectDetail,
  renderProjects,
  renderReports,
  renderUserSwitcher,
} from "../view/pages";
import type { NavContext } from "../view/components";
import { assembleReportData, reportFilename } from "../report/data";
import { renderFunderReport } from "../view/report";
import type { EvidenceSubmission, Report, User } from "../../shared/types";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = path.join(process.cwd(), "public");

// Optional deployment-level access protection. When OBV_ACCESS_CODE is set,
// pages and APIs require a one-time code entry (cookie stores a hash of the
// code, never the code itself). /api/health stays open for platform health
// checks and /report-cache keeps its own single-use token gate. Static
// assets are served before the gate (demo assets only — nothing sensitive).
const ACCESS_CODE = process.env.OBV_ACCESS_CODE ?? "";
const ACCESS_COOKIE_VALUE = ACCESS_CODE
  ? createHash("sha256").update(`obv-access:${ACCESS_CODE}`).digest("hex")
  : "";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// PDF rendering: headless Chromium via the globally installed Playwright
// (no npm dependency added). One-time token lets the renderer fetch the
// report HTML without a demo session cookie.
const RENDER_SCRIPT = path.join(process.cwd(), "scripts", "render-pdf.js");
const PLAYWRIGHT_NODE_PATH =
  process.env.OBV_PLAYWRIGHT_NODE_PATH ?? "/opt/node22/lib/node_modules";
const previewToken = randomUUID();
/** Report HTML cached between generate-request and Chromium fetch. */
const pendingReportHtml = new Map<string, string>();

/**
 * Whether the Playwright-based PDF renderer is usable in this environment.
 * Checks module resolution the same way the render child process will:
 * via OBV_PLAYWRIGHT_NODE_PATH and normal resolution from the app root.
 * When unavailable, report generation degrades to the printable HTML
 * preview (the renderer interface is unchanged).
 */
function pdfRendererAvailable(): boolean {
  const req = createRequire(path.join(process.cwd(), "scripts", "render-pdf.js"));
  try {
    req.resolve("playwright", {
      paths: [PLAYWRIGHT_NODE_PATH, path.join(process.cwd(), "node_modules")],
    });
    return true;
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
};

// ------------------------------------------------------------ helpers

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? "";
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function currentUser(req: http.IncomingMessage): User | null {
  const id = parseCookies(req)["obv_user"];
  return id ? repo.getUser(id) : null;
}

function readBody(req: http.IncomingMessage, limitBytes = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new SubmissionError("Request body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isFormPost(req: http.IncomingMessage): boolean {
  return (req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
}

function sendHtml(res: http.ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function redirect(res: http.ServerResponse, location: string, status = 303): void {
  res.writeHead(status, { Location: location });
  res.end();
}

function serveStatic(res: http.ServerResponse, baseDir: string, relPath: string): boolean {
  const safe = path.normalize(relPath).replace(/^([./\\])+/, "");
  const filePath = path.join(baseDir, safe);
  if (!filePath.startsWith(baseDir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }
  const type = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": filePath.includes("demo-evidence") || filePath.includes("worm")
      ? "public, max-age=86400"
      : "no-cache",
  });
  res.end(fs.readFileSync(filePath));
  return true;
}

// ------------------------------------------------------ page data

function usersById(): Map<string, User> {
  return new Map(repo.listUsers().map((u) => [u.id, u]));
}

function navFor(user: User, active: string): NavContext {
  const org = repo.getOrganization(user.organizationId);
  return {
    user,
    active,
    pendingApprovals: repo.listPendingApprovalRequests().length,
    openIssues: repo.listFieldIssues().filter((i) => !["RESOLVED", "CLOSED"].includes(i.status)).length,
    orgName: org?.name,
    orgKind: org?.kind,
  };
}

function milestoneRows(projectId: string): MilestoneRow[] {
  return repo.listMilestones(projectId).map((milestone) => {
    const latestEvidence = repo.latestEvidenceForMilestone(milestone.id);
    const approval = repo.getApprovalRequestForMilestone(milestone.id);
    return {
      milestone,
      latestEvidence,
      verification: latestEvidence ? repo.getVerificationForEvidence(latestEvidence.id) : null,
      approval,
      approvalRecords: approval ? repo.listApprovalRecordsForRequest(approval.id) : [],
    };
  });
}

function evidenceBundlesForMilestone(milestoneId: string): EvidenceBundle[] {
  const milestone = repo.getMilestone(milestoneId)!;
  const approval = repo.getApprovalRequestForMilestone(milestoneId);
  return repo.listEvidenceForMilestone(milestoneId).map((evidence) => ({
    evidence,
    verification: repo.getVerificationForEvidence(evidence.id),
    ledgerEntry: repo.getLedgerEntryForEvidence(evidence.id),
    milestone,
    submittedBy: repo.getUser(evidence.userId),
    approval,
  }));
}

async function projectCardData(projectId: string): Promise<ProjectCardData | null> {
  const project = repo.getProject(projectId);
  if (!project) return null;
  const milestones = milestoneRows(project.id);
  // Implementing agency: presentation-layer inference — the organization of
  // the project's PROJECT_MANAGER user (no schema change for the demo).
  const pm = repo.listUsers().find((u) => u.role === "PROJECT_MANAGER");
  return {
    project,
    org: repo.getOrganization(project.organizationId),
    implementingOrg: pm ? repo.getOrganization(pm.organizationId) : null,
    milestones,
    summary: await virtualAccountService.getProjectSummary(project.id),
    pendingApprovals: milestones.filter((m) => m.approval?.status === "PENDING").length,
  };
}

async function allProjectCards(): Promise<ProjectCardData[]> {
  const out: ProjectCardData[] = [];
  for (const project of repo.listProjects()) {
    const d = await projectCardData(project.id);
    if (d) out.push(d);
  }
  return out;
}

function overviewMetrics(projects: ProjectCardData[]): OverviewMetrics {
  const allRows = projects.flatMap((p) => p.milestones);
  const flagged = repo
    .listAllVerifications()
    .filter((v) => v.verdict !== "VERIFIED").length;
  const pendingRequests = repo.listPendingApprovalRequests();
  return {
    totalBudget: projects.reduce((s, p) => s + p.summary.totalBudget, 0),
    released: projects.reduce((s, p) => s + p.summary.released, 0),
    held: projects.reduce((s, p) => s + p.summary.held, 0),
    pendingApprovals: pendingRequests.length,
    pendingValue: pendingRequests.reduce(
      (s, a) => s + (repo.getMilestone(a.milestoneId)?.trancheAmount ?? 0),
      0
    ),
    verifiedMilestones: allRows.filter((m) =>
      ["VERIFIED", "APPROVED", "RELEASED"].includes(m.milestone.status)
    ).length,
    totalMilestones: allRows.length,
    flaggedEvidence: flagged,
  };
}

function approvalQueue(user: User): ApprovalQueueItem[] {
  const items: ApprovalQueueItem[] = [];
  const projects = new Map(repo.listProjects().map((p) => [p.id, p]));
  for (const project of projects.values()) {
    for (const approval of repo.listApprovalRequestsForProject(project.id)) {
      const milestone = repo.getMilestone(approval.milestoneId)!;
      const records = repo.listApprovalRecordsForRequest(approval.id);
      const bundles = evidenceBundlesForMilestone(milestone.id);
      const bundle =
        bundles.find((b) => b.verification?.verdict === "VERIFIED") ?? bundles[0] ?? null;
      const roleTaken = records.some((r) => r.role === user.role);
      items.push({
        approval,
        records,
        milestone,
        project,
        bundle,
        canDecide:
          approval.status === "PENDING" &&
          approval.requiredRoles.includes(user.role) &&
          !roleTaken,
        alreadyDecided: roleTaken,
      });
    }
  }
  return items.sort((a, b) => (a.approval.createdAt < b.approval.createdAt ? 1 : -1));
}

function computeInsights(): Insight[] {
  const insights: Insight[] = [];
  const verifications = repo.listAllVerifications();
  const evidence = new Map(repo.listAllEvidence().map((e) => [e.id, e]));
  const milestoneOf = (evidenceId: string) => {
    const ev = evidence.get(evidenceId);
    return ev ? repo.getMilestone(ev.milestoneId) : null;
  };

  for (const v of verifications) {
    if (v.verdict === "VERIFIED" && v.confidence < 0.75) {
      const m = milestoneOf(v.evidenceItemId);
      insights.push({
        severity: "warn",
        title: "Low-confidence verification",
        detail: `Milestone ${m?.seq} "${m?.title}" verified at confidence ${v.confidence.toFixed(2)} — consider a spot check.`,
        href: m ? `/milestone/${m.id}` : undefined,
      });
    }
    const geo = v.checks.find((c) => c.name.toLowerCase().includes("geofence"));
    if (geo && !geo.passed) {
      const m = milestoneOf(v.evidenceItemId);
      insights.push({
        severity: "bad",
        title: "Evidence outside expected geofence",
        detail: `A submission for milestone ${m?.seq} "${m?.title}" was captured outside the registered site boundary.`,
        href: m ? `/milestone/${m.id}` : undefined,
      });
    }
  }

  // Repeated NEEDS_REVIEW verdicts per milestone.
  const reviewCounts = new Map<string, number>();
  for (const v of verifications) {
    if (v.verdict !== "NEEDS_REVIEW") continue;
    const m = milestoneOf(v.evidenceItemId);
    if (m) reviewCounts.set(m.id, (reviewCounts.get(m.id) ?? 0) + 1);
  }
  for (const [milestoneId, count] of reviewCounts) {
    if (count >= 2) {
      const m = repo.getMilestone(milestoneId)!;
      insights.push({
        severity: "warn",
        title: "Repeated review flags",
        detail: `Milestone ${m.seq} "${m.title}" has ${count} submissions flagged NEEDS_REVIEW.`,
        href: `/milestone/${m.id}`,
      });
    }
  }

  // Unusual submission timing (upload long after capture).
  for (const ev of evidence.values()) {
    const gap = Date.parse(ev.uploadedAt) - Date.parse(ev.capturedAt);
    if (gap > 24 * 3600_000) {
      const m = repo.getMilestone(ev.milestoneId);
      insights.push({
        severity: "info",
        title: "Delayed upload",
        detail: `Evidence for milestone ${m?.seq} "${m?.title}" was uploaded ${Math.round(gap / 3600_000)}h after capture.`,
        href: m ? `/milestone/${m.id}` : undefined,
      });
    }
  }

  // Approval bottlenecks.
  for (const approval of repo.listPendingApprovalRequests()) {
    const ageH = (Date.now() - Date.parse(approval.createdAt)) / 3600_000;
    const m = repo.getMilestone(approval.milestoneId)!;
    if (ageH > 48) {
      insights.push({
        severity: "warn",
        title: "Approval bottleneck",
        detail: `Release approval for milestone ${m.seq} "${m.title}" has been waiting ${Math.round(ageH / 24)} days.`,
        href: "/approvals",
      });
    } else {
      insights.push({
        severity: "info",
        title: "Approval in queue",
        detail: `Milestone ${m.seq} "${m.title}" is verified and awaiting human approval (${money(m.trancheAmount)} held).`,
        href: "/approvals",
      });
    }
  }
  return insights;
}

function money(amount: number): string {
  return "$" + amount.toLocaleString("en-US");
}

/**
 * Minimal access-code page shown when OBV_ACCESS_CODE is configured.
 * Self-contained (inline styles) so it renders even before any asset loads.
 */
function renderAccessGate(failed: boolean): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OBV — Access</title>
</head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f4f0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0d1626">
<form method="POST" action="/api/access" style="width:min(340px,88vw);border:1px solid #d9d6cd;background:#fff;padding:28px 26px 26px">
  <div style="font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#5b6b7f;margin-bottom:6px">OpenBuild Verify · Demo environment</div>
  <div style="font-size:19px;font-weight:600;letter-spacing:-.01em;margin-bottom:14px">Enter access code</div>
  <p style="font-size:12.5px;line-height:1.5;color:#3c4657;margin:0 0 16px">This demo deployment is protected by an access code. Ask the person who shared the link.</p>
  ${failed ? `<p style="font-size:12.5px;color:#a03123;margin:0 0 10px">Incorrect code — try again.</p>` : ""}
  <input name="code" type="password" autocomplete="off" autofocus required
    style="width:100%;box-sizing:border-box;height:40px;border:1px solid #b9b5a9;background:#fbfaf7;padding:0 10px;font-size:15px;margin-bottom:12px">
  <button type="submit"
    style="width:100%;height:42px;border:0;background:#1d3fad;color:#fff;font-size:13.5px;font-weight:600;letter-spacing:.02em;cursor:pointer">Continue</button>
</form>
</body></html>`;
}

/** Cheap change fingerprint used by the pages' polling refresh. */
function stateFingerprint(): string {
  const db = getDb();
  const milestones = db
    .prepare("SELECT id, status, account_status FROM milestones ORDER BY id")
    .all();
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM evidence_items) AS e,
              (SELECT COUNT(*) FROM verifications) AS v,
              (SELECT COUNT(*) FROM ledger_entries) AS l,
              (SELECT COUNT(*) FROM approval_requests) AS a,
              (SELECT COUNT(*) FROM approval_records) AS ar,
              (SELECT COUNT(*) FROM notifications) AS n,
              (SELECT COUNT(*) FROM messages) AS msg,
              (SELECT COUNT(*) FROM messages WHERE external_deleted = 1) AS msgdel,
              (SELECT COALESCE(MAX(edited_at), '') FROM messages) AS msgedit,
              (SELECT COUNT(*) FROM conversation_threads) AS th,
              (SELECT COUNT(*) FROM field_issues) AS fi,
              (SELECT COALESCE(MAX(updated_at), '') FROM field_issues) AS fiu,
              (SELECT COUNT(*) FROM clarification_requests) AS cr,
              (SELECT COALESCE(MAX(updated_at), '') FROM clarification_requests) AS cru,
              (SELECT COUNT(*) FROM evidence_drafts) AS ed`
    )
    .get();
  return createHash("sha256")
    .update(JSON.stringify({ milestones, counts }))
    .digest("hex")
    .slice(0, 20);
}

// ------------------------------------------------------------ routes

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;
  const method = req.method ?? "GET";

  // ---- deployment health check (always open; no secrets, no paths) ----
  if (method === "GET" && pathname === "/api/health") {
    let database = "connected";
    try {
      getDb().prepare("SELECT COUNT(*) AS c FROM projects").get();
    } catch {
      database = "unavailable";
    }
    sendJson(
      res,
      {
        status: database === "connected" ? "ok" : "degraded",
        database,
        reportRenderer: pdfRendererAvailable() ? "pdf" : "html-fallback",
        aiMode: AI_PROVIDER.apiKey() ? "live-capable" : "fallback-only",
        teamsMode: TEAMS_CONFIG.configured() ? "configured" : "demo",
        timestamp: new Date().toISOString(),
      },
      database === "connected" ? 200 : 503
    );
    return;
  }

  // ---- static assets ----
  if (method === "GET") {
    if (pathname.startsWith("/comm-media/")) {
      // Communication media (session-gated; never executed, inline-safe
      // types only via the MIME map).
      if (!currentUser(req)) {
        sendJson(res, { error: "Not found" }, 404);
        return;
      }
      if (serveStatic(res, COMM_MEDIA_DIR, pathname.slice("/comm-media/".length))) return;
    }
    if (pathname.startsWith("/worm/")) {
      if (serveStatic(res, WORM_DIR, pathname.slice("/worm/".length))) return;
    } else if (pathname !== "/" && serveStatic(res, PUBLIC_DIR, pathname.slice(1))) {
      return;
    }
  }

  // ---- optional deployment access gate ----
  if (
    ACCESS_CODE &&
    !pathname.startsWith("/report-cache/") &&
    pathname !== "/api/teams-sync/notifications" &&
    pathname !== "/api/whatsapp/webhook" &&
    // Invitation activation carries its own one-time secret token.
    !pathname.startsWith("/invite/") &&
    pathname !== "/api/invitations/accept"
  ) {
    if (method === "POST" && pathname === "/api/access") {
      const body = (await readBody(req, 4 * 1024)).toString("utf8");
      const code = new URLSearchParams(body).get("code") ?? "";
      if (safeEqual(code, ACCESS_CODE)) {
        res.setHeader(
          "Set-Cookie",
          `obv_access=${ACCESS_COOKIE_VALUE}; Path=/; SameSite=Lax; HttpOnly; Max-Age=604800`
        );
        redirect(res, "/");
      } else {
        sendHtml(res, renderAccessGate(true), 401);
      }
      return;
    }
    if (!safeEqual(parseCookies(req)["obv_access"] ?? "", ACCESS_COOKIE_VALUE)) {
      if (pathname.startsWith("/api/")) {
        sendJson(res, { error: "Access code required" }, 401);
      } else {
        sendHtml(res, renderAccessGate(false), 401);
      }
      return;
    }
  }

  // ---- demo session ----
  if (method === "POST" && pathname === "/api/session") {
    const body = await readBody(req, 64 * 1024);
    const text = body.toString("utf8");
    let userId = "";
    if ((req.headers["content-type"] ?? "").includes("application/json")) {
      userId = JSON.parse(text || "{}").userId ?? "";
    } else {
      userId = new URLSearchParams(text).get("userId") ?? "";
    }
    const user = repo.getUser(userId);
    if (!user) {
      sendJson(res, { error: "Unknown user" }, 400);
      return;
    }
    res.setHeader(
      "Set-Cookie",
      `obv_user=${encodeURIComponent(user.id)}; Path=/; SameSite=Lax; Max-Age=86400`
    );
    redirect(res, user.role === "FIELD" ? "/field" : "/overview");
    return;
  }

  // ---- APIs ----
  if (method === "GET" && pathname === "/api/state") {
    sendJson(res, { fingerprint: stateFingerprint() });
    return;
  }

  if (method === "GET" && pathname === "/api/field-context") {
    // Field scoping: ACTIVE projects only. A user with active field
    // assignments sees exactly their assigned projects/milestones; a user
    // without assignments keeps the legacy behavior for unassigned
    // (demo) projects but never sees assignment-scoped pilot projects.
    const fieldUser = currentUser(req);
    const myAssignments = fieldUser ? repo.listAssignmentsForUser(fieldUser.id) : [];
    const assignedProjectIds = new Set(myAssignments.map((a) => a.projectId));
    const visibleProjects = repo.listProjects().filter((project) => {
      if (project.status !== "ACTIVE") return false;
      if (assignedProjectIds.size > 0) return assignedProjectIds.has(project.id);
      return repo.listAssignmentsForProject(project.id).filter((a) => a.active).length === 0;
    });
    const projects = visibleProjects.map((project) => {
      const centre = polygonCentroid(project.siteBoundary);
      return {
        id: project.id,
        name: project.name,
        location: project.location,
        simulatedGps: { latitude: centre.lat, longitude: centre.lng },
        milestones: repo
          .listMilestones(project.id)
          .filter((m) => !m.archived)
          .filter((m) => {
            const scoped = myAssignments.find(
              (a) => a.projectId === project.id && a.milestoneIds.length > 0
            );
            return scoped ? scoped.milestoneIds.includes(m.id) : true;
          })
          .map((m) => ({
            id: m.id,
            seq: m.seq,
            title: m.title,
            requirement: m.requirement,
            trancheAmount: m.trancheAmount,
            status: m.status,
            accountStatus: m.accountStatus,
            requirements: repo.listRequirementsForMilestone(m.id),
            demoPhotos: repo.listDemoFallbackPhotos(m.id),
          })),
      };
    });
    sendJson(res, { projects });
    return;
  }

  // Spatial context for the map (session-gated; presentation data only —
  // every state shown is read from the primary verification/governance
  // records, never computed by the map).
  if (method === "GET" && pathname === "/api/map-context") {
    if (!currentUser(req)) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const projects = await Promise.all(
      repo.listProjects().filter((p) => p.status !== "DRAFT").map(async (project) => {
        const features = repo.listSpatialFeatures(project.id);
        const summary = await virtualAccountService.getProjectSummary(project.id);
        const chain = await wormEvidenceStore.verifyChain();
        const milestones = repo.listMilestones(project.id);
        const pendingApprovals = repo
          .listApprovalRequestsForProject(project.id)
          .filter((a) => a.status === "PENDING").length;
        return {
          id: project.id,
          name: project.name,
          location: project.location,
          boundary: project.siteBoundary,
          route: features.find((f) => f.kind === "ROUTE") ?? null,
          totalBudget: summary.totalBudget,
          released: summary.released,
          held: summary.held,
          milestoneCount: milestones.length,
          pendingApprovals,
          chainValid: chain.valid,
          segments: features
            .filter((f) => f.kind === "SEGMENT")
            .map((f) => {
              const m = milestones.find((ms) => ms.id === f.milestoneId)!;
              const approval = repo.getApprovalRequestForMilestone(m.id);
              const records = approval ? repo.listApprovalRecordsForRequest(approval.id) : [];
              const evidence = repo.listEvidenceForMilestone(m.id);
              const latestVerification = evidence[0]
                ? repo.getVerificationForEvidence(evidence[0].id)
                : null;
              return {
                evidenceCount: evidence.length,
                latestVerdict: latestVerification?.verdict ?? null,
                id: f.id,
                milestoneId: m.id,
                seq: m.seq,
                title: m.title,
                requirement: m.requirement,
                label: f.label,
                geometry: f.geometry,
                status: m.status,
                accountStatus: m.accountStatus,
                trancheAmount: m.trancheAmount,
                approvalStatus: approval?.status ?? null,
                approvalsRecorded: records.filter((r) => r.decision === "APPROVED").length,
                approvalsRequired: approval?.requiredRoles.length ?? 0,
                threadId: repo.findThreadForMilestone(m.id)?.id ?? null,
              };
            }),
          commLocations: repo
            .listThreads()
            .filter((t) => t.projectId === project.id)
            .flatMap((t) =>
              repo
                .listMessagesForThread(t.id)
                .filter((m) => m.location !== null)
                .map((m) => ({
                  messageId: m.id,
                  threadId: t.id,
                  threadTitle: t.title,
                  sender: m.senderDisplayName,
                  provider: m.provider,
                  createdAt: m.createdAt,
                  latitude: m.location!.latitude,
                  longitude: m.location!.longitude,
                }))
            ),
          issues: repo
            .listFieldIssues()
            .filter((i) => i.projectId === project.id && i.latitude !== null && i.longitude !== null)
            .map((i) => ({
              id: i.id,
              title: i.title,
              severity: i.severity,
              status: i.status,
              milestoneId: i.milestoneId,
              assignee: i.assignedToUserId ? repo.getUser(i.assignedToUserId)?.name ?? null : null,
              latitude: i.latitude,
              longitude: i.longitude,
            })),
          evidence: milestones.flatMap((m) =>
            repo
              .listEvidenceForMilestone(m.id)
              .filter((e) => e.latitude !== null && e.longitude !== null)
              .map((e) => {
                const v = repo.getVerificationForEvidence(e.id);
                const ledger = repo.getLedgerEntryForEvidence(e.id);
                return {
                  id: e.id,
                  milestoneId: m.id,
                  seq: m.seq,
                  milestoneTitle: m.title,
                  latitude: e.latitude,
                  longitude: e.longitude,
                  capturedAt: e.capturedAt,
                  uploadedAt: e.uploadedAt,
                  capturedBy: repo.getUser(e.userId)?.name ?? "—",
                  photoPath: e.photoPath,
                  isDemoFallback: e.isDemoFallback,
                  verdict: v?.verdict ?? null,
                  confidence: v?.confidence ?? null,
                  source: v?.source ?? null,
                  geofencePassed:
                    v?.checks.find((c) => c.name.toLowerCase().includes("geofence"))?.passed ?? null,
                  insideBoundary: pointInPolygon(e.longitude!, e.latitude!, project.siteBoundary),
                  approvalStatus: repo.getApprovalRequestForMilestone(m.id)?.status ?? null,
                  accountStatus: m.accountStatus,
                  ledgerSeq: ledger?.seq ?? null,
                  threadId: repo.findThreadForMilestone(m.id)?.id ?? null,
                };
              })
          ),
        };
      })
    );
    sendJson(res, { projects });
    return;
  }

  // ---- communications APIs (chat coordinates — it can never approve or
  //      release; only the ApprovalRequest workflow changes those states) ----
  const messageMatch = /^\/api\/threads\/([^/]+)\/messages$/.exec(pathname);
  if (method === "POST" && messageMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const thread = repo.getThread(messageMatch[1]);
    if (!thread || !canAccessThread(user, thread)) {
      // 404 for unauthorized too: don't reveal other tenants' thread ids.
      sendJson(res, { error: "Thread not found" }, 404);
      return;
    }
    const body = (await readBody(req, 64 * 1024)).toString("utf8");
    const text = isFormPost(req)
      ? new URLSearchParams(body).get("body") ?? ""
      : JSON.parse(body || "{}").body ?? "";
    if (!text.trim()) {
      sendJson(res, { error: "Message body required" }, 400);
      return;
    }
    const message = postMessage(thread, user, text);
    // Outbound Teams sync (allowlisted human content only). Awaited so
    // delivery state is visible on redirect, but it NEVER throws — a
    // provider failure keeps the internal message and marks FAILED.
    await syncOutbound(message, thread);
    // Outbound WhatsApp sync to this thread's assigned participants
    // (policy-gated; equally failure-isolated).
    await syncOutboundWhatsApp(message, thread);
    if (isFormPost(req)) {
      redirect(res, `/communications?thread=${thread.id}`);
    } else {
      sendJson(res, { message: repo.getChatMessage(message.id) ?? message }, 201);
    }
    return;
  }

  // ---- Teams conversation-sync: thread binding management ----
  const bindingMatch = /^\/api\/threads\/([^/]+)\/teams-binding$/.exec(pathname);
  if (method === "POST" && bindingMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const thread = repo.getThread(bindingMatch[1]);
    if (!thread || !canAccessThread(user, thread)) {
      sendJson(res, { error: "Thread not found" }, 404);
      return;
    }
    if (!canManageBindings(user)) {
      sendJson(res, { error: "Only a project manager or funder representative can manage Teams connections" }, 403);
      return;
    }
    const body = (await readBody(req, 16 * 1024)).toString("utf8");
    const params = isFormPost(req)
      ? new URLSearchParams(body)
      : new URLSearchParams(Object.entries(JSON.parse(body || "{}")) as [string, string][]);
    const action = params.get("action") ?? "connect";
    try {
      if (action === "disconnect") {
        await disconnectThread(thread);
      } else {
        if (!syncConfigured()) {
          throw new ConversationSyncError("not-configured", false);
        }
        const teamId = params.get("teamId") ?? "";
        const channelId = params.get("channelId") ?? "";
        if (action === "connect" && (!teamId.trim() || !channelId.trim())) {
          sendJson(res, { error: "teamId and channelId are required" }, 400);
          return;
        }
        if (action === "reconnect") {
          const existing = repo.getBindingForThread(thread.id);
          if (!existing) {
            sendJson(res, { error: "No existing connection to reconnect" }, 404);
            return;
          }
          await connectThread(thread, { teamId: existing.teamId, channelId: existing.channelId, rootMessageId: existing.rootMessageId ?? undefined }, user);
        } else {
          await connectThread(thread, { teamId, channelId, rootMessageId: params.get("rootMessageId") ?? undefined }, user);
        }
      }
    } catch (err) {
      const category = err instanceof ConversationSyncError ? err.category : "unknown";
      const msg =
        category === "not-configured"
          ? "Teams conversation sync is not configured on this deployment"
          : `Teams connection failed (${category})`;
      if (isFormPost(req)) {
        redirect(res, `/communications?thread=${thread.id}&sync_error=${encodeURIComponent(category)}`);
      } else {
        sendJson(res, { error: msg }, category === "not-configured" ? 409 : 502);
      }
      return;
    }
    if (isFormPost(req)) {
      redirect(res, `/communications?thread=${thread.id}`);
    } else {
      sendJson(res, { binding: repo.getBindingForThread(thread.id) });
    }
    return;
  }

  // Explicitly share the latest evidence of a milestone thread to Teams
  // (a human-authored reference message — the only reference type that
  // syncs outward; informational, with an OBV deep link, no actions).
  const shareMatch = /^\/api\/threads\/([^/]+)\/share-evidence$/.exec(pathname);
  if (method === "POST" && shareMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const thread = repo.getThread(shareMatch[1]);
    if (!thread || !canAccessThread(user, thread)) {
      sendJson(res, { error: "Thread not found" }, 404);
      return;
    }
    const evidence = thread.milestoneId
      ? repo.listEvidenceForMilestone(thread.milestoneId)[0] ?? null
      : null;
    if (!evidence) {
      sendJson(res, { error: "No evidence to share on this thread" }, 404);
      return;
    }
    const message = {
      id: repo.newId(),
      threadId: thread.id,
      senderUserId: user.id,
      senderDisplayName: user.name,
      provider: "OBV" as const,
      externalThreadId: null,
      externalMessageId: null,
      body: `Shared evidence reference for review.`,
      messageType: "EVIDENCE_REFERENCE" as const,
      refId: evidence.id,
      createdAt: new Date().toISOString(),
      deliveryStatus: "SENT" as const,
      origin: "OBV_LOCAL" as const,
      editedAt: null,
      originalBody: null,
      externalDeleted: false,
      attachments: [],
      location: null,
    };
    repo.insertChatMessage(message);
    await syncOutbound(message, thread);
    if (isFormPost(req)) {
      redirect(res, `/communications?thread=${thread.id}`);
    } else {
      sendJson(res, { message: repo.getChatMessage(message.id) }, 201);
    }
    return;
  }

  // ---- Graph change-notification webhook (session-free; authenticated
  //      by the derived clientState on every notification) ----
  if (pathname === "/api/teams-sync/notifications") {
    // Subscription validation handshake: echo the token as text/plain.
    const validationToken = url.searchParams.get("validationToken");
    if (validationToken !== null) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(validationToken);
      return;
    }
    if (method !== "POST") {
      sendJson(res, { error: "Method not allowed" }, 405);
      return;
    }
    let payload: { value?: Array<Record<string, unknown>> };
    try {
      payload = JSON.parse((await readBody(req, 512 * 1024)).toString("utf8"));
      if (!Array.isArray(payload.value)) throw new Error("bad shape");
    } catch {
      sendJson(res, { error: "Malformed notification" }, 400);
      return;
    }
    let rejected = 0;
    for (const item of payload.value) {
      try {
        const resource = String(item.resource ?? "");
        const resourceData = (item.resourceData ?? {}) as { id?: string };
        const messageId =
          resourceData.id ?? /messages\('([^']+)'\)/.exec(resource)?.[1] ?? "";
        if (!messageId) continue;
        await processNotificationItem({
          subscriptionId: String(item.subscriptionId ?? ""),
          clientState: String(item.clientState ?? ""),
          changeType: String(item.changeType ?? "created"),
          messageId,
        });
      } catch (err) {
        if (err instanceof ConversationSyncError && err.category === "auth") {
          rejected++;
        } else {
          console.error(
            "[teams-sync] inbound processing failed:",
            err instanceof ConversationSyncError ? err.category : "unknown"
          );
        }
      }
    }
    // Invalid clientState across the board -> reject; otherwise 202 so
    // Graph does not endlessly retry items we already handled.
    if (rejected > 0 && rejected === payload.value.length) {
      sendJson(res, { error: "Invalid notification" }, 401);
    } else {
      res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
      res.end("{}");
    }
    return;
  }

  // ---- WhatsApp Business webhook (session-free; HMAC-authenticated) ----
  if (pathname === "/api/whatsapp/webhook") {
    if (method === "GET") {
      // Meta verification handshake.
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge") ?? "";
      if (mode === "subscribe" && token && token === WHATSAPP_CONFIG.webhookVerifyToken()) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(challenge);
      } else {
        sendJson(res, { error: "Verification failed" }, 403);
      }
      return;
    }
    if (method !== "POST") {
      sendJson(res, { error: "Method not allowed" }, 405);
      return;
    }
    if (!whatsappConfigured()) {
      sendJson(res, { error: "Not configured" }, 404);
      return;
    }
    const raw = await readBody(req, 1024 * 1024); // payload cap
    if (!verifySignature(raw, req.headers["x-hub-signature-256"] as string | undefined)) {
      sendJson(res, { error: "Invalid signature" }, 401);
      return;
    }
    let parsed: ReturnType<typeof parseWebhook>;
    try {
      parsed = parseWebhook(JSON.parse(raw.toString("utf8")));
    } catch {
      sendJson(res, { error: "Malformed payload" }, 400);
      return;
    }
    // Acknowledge fast; message/media processing continues asynchronously
    // (no long AI or evidence work happens on this request path — chat
    // storage only).
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end("{}");
    (async () => {
      for (const st of parsed.statuses) handleStatusUpdate(st);
      for (const m of parsed.messages) {
        try {
          await handleWhatsAppInbound(m);
        } catch (err) {
          console.error(
            "[whatsapp] inbound processing failed:",
            err instanceof WhatsAppSyncError ? err.category : "unknown"
          );
        }
      }
    })().catch(() => {});
    return;
  }

  // Coordinator assigns a WhatsApp participant to a project/thread
  // (explicit context — never guessed from message text).
  if (method === "POST" && pathname === "/api/whatsapp/contexts") {
    const user = currentUser(req);
    if (!user || !canManageBindings(user)) {
      sendJson(res, { error: "Not authorized" }, 403);
      return;
    }
    const body = (await readBody(req, 16 * 1024)).toString("utf8");
    const params = isFormPost(req)
      ? new URLSearchParams(body)
      : new URLSearchParams(Object.entries(JSON.parse(body || "{}")) as [string, string][]);
    const phone = (params.get("phone") ?? "").trim();
    const threadId = params.get("threadId") || null;
    if (!phone) {
      sendJson(res, { error: "phone required" }, 400);
      return;
    }
    const thread = threadId ? repo.getThread(threadId) : null;
    if (threadId && (!thread || !canAccessThread(user, thread))) {
      sendJson(res, { error: "Thread not found" }, 404);
      return;
    }
    const ctx = assignParticipantContext(
      phone,
      {
        threadId,
        projectId: thread?.projectId ?? params.get("projectId") ?? null,
        milestoneId: thread?.milestoneId ?? null,
      },
      params.get("expiresAt") || null
    );
    if (isFormPost(req)) {
      redirect(res, threadId ? `/communications?thread=${threadId}` : "/communications/integrations");
    } else {
      sendJson(res, { context: ctx });
    }
    return;
  }

  // WhatsApp admin: safe connection test (credential + phone probe; no
  // message is ever sent).
  if (method === "POST" && pathname === "/api/whatsapp/test") {
    const user = currentUser(req);
    if (!user || !canManageBindings(user)) {
      sendJson(res, { error: "Not authorized" }, 403);
      return;
    }
    if (!whatsappConfigured()) {
      if (isFormPost(req)) redirect(res, "/communications/integrations?watest=fail:not-configured");
      else sendJson(res, { ok: false, status: "NOT_CONFIGURED" }, 409);
      return;
    }
    try {
      const probe = await probePhoneNumber();
      const masked = probe.displayPhone ? displayPhone(probe.displayPhone.replace(/\D/g, "")) : null;
      if (isFormPost(req)) {
        redirect(
          res,
          `/communications/integrations?watest=${encodeURIComponent(masked ? `ok:${masked}` : "ok")}`
        );
      } else {
        sendJson(res, {
          ok: true,
          status: "ACTIVE",
          displayPhone: masked,
          webhookConfigured: Boolean(WHATSAPP_CONFIG.webhookVerifyToken()),
        });
      }
    } catch (err) {
      const category = err instanceof WhatsAppSyncError ? err.category : "unknown";
      if (isFormPost(req)) redirect(res, `/communications/integrations?watest=fail:${category}`);
      else sendJson(res, { ok: false, status: "DEGRADED", category }, 502);
    }
    return;
  }

  // ---- field issues ----
  if (method === "POST" && pathname === "/api/issues") {
    const user = currentUser(req);
    if (!user || !canManageFieldOps(user)) {
      sendJson(res, { error: "Not authorized to create field issues" }, 403);
      return;
    }
    const body = (await readBody(req, 32 * 1024)).toString("utf8");
    const params = isFormPost(req)
      ? new URLSearchParams(body)
      : new URLSearchParams(Object.entries(JSON.parse(body || "{}")) as [string, string][]);
    const sourceMessage = params.get("messageId") ? repo.getChatMessage(params.get("messageId")!) : null;
    const issue = createFieldIssue({
      projectId: params.get("projectId") ?? "",
      milestoneId: params.get("milestoneId") || null,
      sourceMessage,
      title: params.get("title") ?? "",
      description: params.get("description") ?? sourceMessage?.body ?? "",
      category: (params.get("category") ?? "OTHER") as never,
      severity: (params.get("severity") ?? "MEDIUM") as never,
      assignedToUserId: params.get("assignedToUserId") || null,
      dueAt: params.get("dueAt") || null,
      createdBy: user,
    });
    if (isFormPost(req)) {
      redirect(res, `/issue/${issue.id}`);
    } else {
      sendJson(res, { issue }, 201);
    }
    return;
  }

  const issueStatusMatch = /^\/api\/issues\/([^/]+)\/status$/.exec(pathname);
  if (method === "POST" && issueStatusMatch) {
    const user = currentUser(req);
    if (!user || !canManageFieldOps(user)) {
      sendJson(res, { error: "Not authorized" }, 403);
      return;
    }
    const body = (await readBody(req, 16 * 1024)).toString("utf8");
    const params = isFormPost(req)
      ? new URLSearchParams(body)
      : new URLSearchParams(Object.entries(JSON.parse(body || "{}")) as [string, string][]);
    const issue = updateIssueStatus(
      issueStatusMatch[1],
      (params.get("status") ?? "") as never,
      user,
      params.get("resolutionSummary") || undefined
    );
    if (isFormPost(req)) {
      redirect(res, `/issue/${issue.id}`);
    } else {
      sendJson(res, { issue });
    }
    return;
  }

  // ---- clarification requests ----
  if (method === "POST" && pathname === "/api/clarifications") {
    const user = currentUser(req);
    if (!user || !canManageFieldOps(user)) {
      sendJson(res, { error: "Not authorized to request clarifications" }, 403);
      return;
    }
    const body = (await readBody(req, 16 * 1024)).toString("utf8");
    const params = isFormPost(req)
      ? new URLSearchParams(body)
      : new URLSearchParams(Object.entries(JSON.parse(body || "{}")) as [string, string][]);
    const clar = createClarification({
      milestoneId: params.get("milestoneId") ?? "",
      evidenceItemId: params.get("evidenceItemId") || null,
      question: params.get("question") ?? "",
      responseType: (params.get("responseType") ?? "TEXT") as never,
      dueAt: params.get("dueAt") || null,
      assignedToUserId: params.get("assignedToUserId") || null,
      requestedBy: user,
    });
    if (isFormPost(req)) {
      redirect(res, `/milestone/${clar.milestoneId}`);
    } else {
      sendJson(res, { clarification: clar }, 201);
    }
    return;
  }

  const clarStatusMatch = /^\/api\/clarifications\/([^/]+)\/status$/.exec(pathname);
  if (method === "POST" && clarStatusMatch) {
    const user = currentUser(req);
    if (!user || !canManageFieldOps(user)) {
      sendJson(res, { error: "Not authorized" }, 403);
      return;
    }
    const body = (await readBody(req, 16 * 1024)).toString("utf8");
    const params = isFormPost(req)
      ? new URLSearchParams(body)
      : new URLSearchParams(Object.entries(JSON.parse(body || "{}")) as [string, string][]);
    const clar = updateClarificationStatus(
      clarStatusMatch[1],
      (params.get("status") ?? "") as never,
      user,
      params.get("note") || undefined
    );
    if (isFormPost(req)) {
      redirect(res, `/milestone/${clar.milestoneId}`);
    } else {
      sendJson(res, { clarification: clar });
    }
    return;
  }

  // ---- evidence drafts (governed promotion) ----
  if (method === "POST" && pathname === "/api/evidence-drafts") {
    const user = currentUser(req);
    if (!user || !(canManageFieldOps(user) || user.role === "FIELD")) {
      sendJson(res, { error: "Not authorized" }, 403);
      return;
    }
    const body = (await readBody(req, 16 * 1024)).toString("utf8");
    const params = isFormPost(req)
      ? new URLSearchParams(body)
      : new URLSearchParams(Object.entries(JSON.parse(body || "{}")) as [string, string][]);
    const draft = createEvidenceDraft({
      messageId: params.get("messageId") ?? "",
      attachmentIndex: Number(params.get("attachmentIndex") ?? 0),
      milestoneId: params.get("milestoneId") ?? "",
      locationMessageId: params.get("locationMessageId") || null,
      createdBy: user,
    });
    if (isFormPost(req)) {
      redirect(res, `/milestone/${draft.milestoneId}`);
    } else {
      sendJson(res, { draft }, 201);
    }
    return;
  }

  const draftSubmitMatch = /^\/api\/evidence-drafts\/([^/]+)\/submit$/.exec(pathname);
  if (method === "POST" && draftSubmitMatch) {
    const user = currentUser(req);
    if (!user || !(canManageFieldOps(user) || user.role === "FIELD")) {
      sendJson(res, { error: "Not authorized" }, 403);
      return;
    }
    const result = await submitDraft(draftSubmitMatch[1], user);
    if (isFormPost(req)) {
      redirect(res, `/milestone/${result.milestone.id}`);
    } else {
      sendJson(res, result, 201);
    }
    return;
  }

  // ---- identity mapping admin flow (smallest practical: endpoints) ----
  // GET lists external Teams identities seen (mapped + unmapped);
  // POST maps/unmaps an external identity to an existing OBV user.
  // Mapping is always explicit — never inferred from display names.
  if (pathname === "/api/teams-sync/identities") {
    const user = currentUser(req);
    if (!user || !canManageBindings(user)) {
      sendJson(res, { error: "Not authorized" }, 403);
      return;
    }
    if (method === "GET") {
      sendJson(res, {
        identities: repo.listIdentityMappings().map((m) => ({
          tenantId: m.tenantId,
          // Truncated for display; full id accepted on POST.
          externalUserId: m.externalUserId.length > 12 ? `${m.externalUserId.slice(0, 12)}…` : m.externalUserId,
          externalUserIdFull: m.externalUserId,
          externalDisplayName: m.externalDisplayName,
          externalEmail: m.externalEmail,
          obvUserId: m.obvUserId,
          obvUserName: m.obvUserId ? repo.getUser(m.obvUserId)?.name ?? null : null,
          status: m.status,
        })),
      });
      return;
    }
    if (method === "POST") {
      const body = (await readBody(req, 16 * 1024)).toString("utf8");
      const params = isFormPost(req)
        ? new URLSearchParams(body)
        : new URLSearchParams(Object.entries(JSON.parse(body || "{}")) as [string, string][]);
      const externalUserId = params.get("externalUserId") ?? "";
      const obvUserId = params.get("obvUserId") || null; // empty -> unmap
      const tenantId = params.get("tenantId") || GRAPH_CONFIG.tenantId();
      if (!externalUserId) {
        sendJson(res, { error: "externalUserId required" }, 400);
        return;
      }
      if (obvUserId && !repo.getUser(obvUserId)) {
        sendJson(res, { error: "Unknown OBV user" }, 404);
        return;
      }
      if (!repo.findIdentityMapping(tenantId, externalUserId)) {
        sendJson(res, { error: "Unknown external identity (it appears after its first inbound message)" }, 404);
        return;
      }
      repo.setIdentityMapping(tenantId, externalUserId, obvUserId);
      sendJson(res, { ok: true, status: obvUserId ? "MAPPED" : "UNMAPPED" });
      return;
    }
    sendJson(res, { error: "Method not allowed" }, 405);
    return;
  }

  // Subscription maintenance sweep (PM session, or external scheduler
  // presenting the configured maintenance key).
  if (method === "POST" && pathname === "/api/teams-sync/maintain") {
    const user = currentUser(req);
    const key = GRAPH_CONFIG.maintenanceKey();
    const keyOk = key && req.headers["x-obv-maintenance-key"] === key;
    if (!keyOk && !(user && canManageBindings(user))) {
      sendJson(res, { error: "Not authorized" }, 403);
      return;
    }
    const result = await maintainSubscriptions();
    if (isFormPost(req)) {
      redirect(res, `/communications/integrations?maintained=${result.checked}-${result.degraded}`);
    } else {
      sendJson(res, result);
    }
    return;
  }

  // Find-or-create the discussion thread for a milestone or project.
  if (method === "POST" && pathname === "/api/threads/open") {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const body = (await readBody(req, 16 * 1024)).toString("utf8");
    const params = isFormPost(req)
      ? new URLSearchParams(body)
      : new URLSearchParams(Object.entries(JSON.parse(body || "{}")) as [string, string][]);
    const milestoneId = params.get("milestoneId");
    const projectId = params.get("projectId");
    let thread = null;
    if (milestoneId) {
      const milestone = repo.getMilestone(milestoneId);
      const project = milestone ? repo.getProject(milestone.projectId) : null;
      if (!milestone || !project) {
        sendJson(res, { error: "Unknown milestone" }, 404);
        return;
      }
      thread = ensureMilestoneThread(milestoneId, user);
    } else if (projectId) {
      if (!repo.getProject(projectId)) {
        sendJson(res, { error: "Unknown project" }, 404);
        return;
      }
      thread = ensureProjectThread(projectId, user);
    } else {
      sendJson(res, { error: "milestoneId or projectId required" }, 400);
      return;
    }
    if (!canAccessThread(user, thread)) {
      sendJson(res, { error: "Thread not found" }, 404);
      return;
    }
    if (isFormPost(req)) {
      redirect(res, `/communications?thread=${thread.id}`);
    } else {
      sendJson(res, { thread }, 201);
    }
    return;
  }

  if (method === "POST" && pathname === "/api/evidence") {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    let submission: EvidenceSubmission;
    try {
      submission = JSON.parse((await readBody(req)).toString("utf8"));
    } catch {
      sendJson(res, { error: "Invalid JSON body" }, 400);
      return;
    }
    const result = await processEvidenceSubmission(submission, user.id);
    sendJson(res, result, 201);
    return;
  }

  // Human approval decision — the governance gate.
  const approvalMatch = /^\/api\/approvals\/([^/]+)\/decision$/.exec(pathname);
  if (method === "POST" && approvalMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const body = (await readBody(req, 64 * 1024)).toString("utf8");
    const decision = isFormPost(req)
      ? new URLSearchParams(body).get("decision")
      : JSON.parse(body || "{}").decision;
    if (decision !== "APPROVED" && decision !== "REJECTED") {
      sendJson(res, { error: "decision must be APPROVED or REJECTED" }, 400);
      return;
    }
    const result = await processApprovalDecision(approvalMatch[1], user.id, decision);
    if (isFormPost(req)) {
      redirect(res, "/approvals");
    } else {
      sendJson(res, result);
    }
    return;
  }

  // Ledger integrity check on demand.
  if (method === "POST" && pathname === "/api/ledger/verify") {
    const chain = await wormEvidenceStore.verifyChain();
    if (chain.valid) {
      // Intact checks are routine — in-app record only, no Teams card
      // (and therefore no possibility of a misleading success card).
      await teamsNotifier.notify(
        "INTEGRITY_CHECK",
        `Ledger integrity check run: ${chain.entries} entries verified — CHAIN INTACT.`
      );
    } else {
      await teamsNotifier.notify(
        "LEDGER_INTEGRITY_FAILURE",
        `Ledger integrity check run: TAMPERING DETECTED AT ENTRY ${chain.brokenAt}.`,
        {
          card: integrityFailureCard({
            project: repo.listProjects()[0] ?? null,
            brokenAt: chain.brokenAt,
            checkedAt: new Date().toISOString(),
          }),
        }
      );
      const p = repo.listProjects()[0];
      if (p) {
        mirrorEvent(
          `LEDGER INTEGRITY ALERT: tampering detected at entry ${chain.brokenAt}. Evidence chain requires investigation.`,
          { projectId: p.id }
        );
      }
    }
    if (isFormPost(req) || (req.headers.accept ?? "").includes("text/html")) {
      redirect(res, "/ledger?checked=1");
    } else {
      sendJson(res, chain);
    }
    return;
  }

  // ---- funder report generation ----
  if (method === "POST" && pathname === "/api/reports/generate") {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const body = (await readBody(req, 64 * 1024)).toString("utf8");
    const projectId = isFormPost(req)
      ? new URLSearchParams(body).get("projectId") ?? ""
      : JSON.parse(body || "{}").projectId ?? "";

    // Assemble once: the stored record and the PDF share the same snapshot
    // (including the ledger integrity check run at generation time).
    const data = await assembleReportData(projectId, user);
    if (!data) {
      sendJson(res, { error: "Unknown project" }, 404);
      return;
    }
    const report: Report = {
      id: repo.newId(),
      projectId,
      reportType: "VERIFICATION_FUND_RELEASE",
      filename: reportFilename(data.project, data.generatedAt),
      generatedAt: data.generatedAt,
      generatedBy: user.id,
      integrityStatus: data.integrity.valid
        ? "INTACT"
        : `TAMPERED_AT:${data.integrity.brokenAt}`,
      ledgerEntries: data.integrity.entries,
    };
    pendingReportHtml.set(report.id, renderFunderReport(data));
    try {
      const outDir = path.join(REPORTS_DIR, report.id);
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, report.filename);
      const config = Buffer.from(
        JSON.stringify({
          url: `http://127.0.0.1:${PORT}/report-cache/${report.id}?token=${previewToken}`,
          outPath,
          projectName: data.project.name,
          generatedAt: data.generatedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC"),
        })
      ).toString("base64");
      await new Promise<void>((resolve, reject) => {
        execFile(
          process.execPath,
          [RENDER_SCRIPT, config],
          { env: { ...process.env, NODE_PATH: PLAYWRIGHT_NODE_PATH }, timeout: 90_000 },
          (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
        );
      });
      if (!fs.existsSync(outPath)) throw new Error("Renderer produced no output file");
      repo.insertReport(report);
      await teamsNotifier.notify(
        "REPORT_GENERATED",
        `Funder report generated for "${data.project.name}" by ${user.name} (ledger: ${report.integrityStatus === "INTACT" ? "chain intact" : report.integrityStatus}).`,
        { projectId: data.project.id }
      );
      if (!data.integrity.valid) {
        await teamsNotifier.notify(
          "LEDGER_INTEGRITY_FAILURE",
          `Integrity failure detected while generating the funder report: TAMPERING AT ENTRY ${data.integrity.brokenAt}.`,
          {
            projectId: data.project.id,
            card: integrityFailureCard({
              project: data.project,
              brokenAt: data.integrity.brokenAt,
              checkedAt: data.integrity.checkedAt,
            }),
          }
        );
      }
      if (isFormPost(req)) {
        redirect(res, `/reports/file/${report.id}`);
      } else {
        sendJson(res, { report }, 201);
      }
    } catch (err) {
      // Full renderer detail (may contain internal paths) stays in the
      // server log; clients get an honest but generic message.
      console.error("[report] PDF generation failed:", (err as Error).message);
      if (isFormPost(req)) {
        redirect(res, `/reports?error=pdf&project=${encodeURIComponent(projectId)}`);
      } else {
        sendJson(
          res,
          { error: "PDF generation failed — the printable HTML preview remains available on the Reports page" },
          500
        );
      }
    } finally {
      pendingReportHtml.delete(report.id);
    }
    return;
  }

  // Cached report HTML fetched by the headless renderer (token-gated).
  const cacheMatch = /^\/report-cache\/([^/]+)$/.exec(pathname);
  if (method === "GET" && cacheMatch) {
    const html = pendingReportHtml.get(cacheMatch[1]);
    if (!html || url.searchParams.get("token") !== previewToken) {
      sendJson(res, { error: "Not found" }, 404);
      return;
    }
    sendHtml(res, html);
    return;
  }

  // Live printable HTML preview (session-gated; also the graceful
  // degradation path if Chromium is unavailable).
  const previewMatch = /^\/report\/([^/]+)\/preview$/.exec(pathname);
  if (method === "GET" && previewMatch) {
    const user = currentUser(req);
    if (!user) {
      redirect(res, "/");
      return;
    }
    const data = await assembleReportData(previewMatch[1], user);
    if (!data) {
      sendHtml(res, renderError(navFor(user, ""), "Project not found", "No project exists at this address."), 404);
      return;
    }
    sendHtml(res, renderFunderReport(data));
    return;
  }

  // Download / open a generated report PDF.
  const fileMatch = /^\/reports\/file\/([^/]+)$/.exec(pathname);
  if (method === "GET" && fileMatch) {
    const user = currentUser(req);
    if (!user) {
      redirect(res, "/");
      return;
    }
    const report = repo.getReport(fileMatch[1]);
    const filePath = report ? path.join(REPORTS_DIR, report.id, report.filename) : "";
    if (!report || !fs.existsSync(filePath)) {
      sendHtml(res, renderError(navFor(user, "reports"), "Report not found", "This report is no longer available (demo data may have been reset). Generate a new one from the Reports page."), 404);
      return;
    }
    const disposition = url.searchParams.get("dl") === "1" ? "attachment" : "inline";
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${report.filename}"`,
      "Content-Length": fs.statSync(filePath).size,
      "Cache-Control": "no-cache",
    });
    res.end(fs.readFileSync(filePath));
    return;
  }

  // Reset the DEMO data to its seeded state. Pilot projects created
  // through onboarding are preserved — wiping everything requires the
  // explicitly gated Development Full Reset below.
  if (method === "POST" && pathname === "/api/demo/reset") {
    await seedDemo({ preservePilot: true });
    await teamsNotifier.notify("DEMO_RESET", "Demo data reset to the seeded state.");
    if (isFormPost(req) || (req.headers.accept ?? "").includes("text/html")) {
      redirect(res, "/overview");
    } else {
      sendJson(res, { ok: true });
    }
    return;
  }

  // ==================== pilot onboarding (configuration only) ====================
  // Nothing in these routes can create evidence, verifications, ledger
  // entries, approval records, or a RELEASED event — they configure.

  const pilotForm = async (max = 64 * 1024): Promise<URLSearchParams> => {
    const body = (await readBody(req, max)).toString("utf8");
    if (isFormPost(req)) return new URLSearchParams(body);
    const json = JSON.parse(body || "{}") as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(json)) {
      if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
      else if (v !== null && v !== undefined) params.append(k, String(v));
    }
    return params;
  };
  const pilotAdmin = (): User | null => {
    const u = currentUser(req);
    return u && pilot.canAdminPilot(u) ? u : null;
  };
  const pilotRespond = (fallbackPath: string, payload: Record<string, unknown>, status = 200) => {
    if (isFormPost(req)) redirect(res, fallbackPath);
    else sendJson(res, payload, status);
  };

  // ---- invitation activation (public; the token is the credential) ----
  const inviteMatch = /^\/invite\/([a-f0-9]{24,})$/.exec(pathname);
  if (method === "GET" && inviteMatch) {
    const invitation = pilot.findInvitationForToken(inviteMatch[1]);
    sendHtml(
      res,
      renderInviteAccept({
        invitation: invitation && invitation.status === "PENDING" ? invitation : null,
        orgName: invitation ? repo.getOrganization(invitation.organizationId)?.name ?? null : null,
        token: inviteMatch[1],
        error:
          invitation && invitation.status !== "PENDING"
            ? `This invitation is ${invitation.status.toLowerCase()}.`
            : invitation
              ? null
              : "This invitation link is invalid or has expired.",
      })
    );
    return;
  }
  if (method === "POST" && pathname === "/api/invitations/accept") {
    const params = await pilotForm(16 * 1024);
    const { user: newUser } = pilot.acceptInvitation(params.get("token") ?? "", {
      name: params.get("name") ?? "",
      title: params.get("title") ?? "",
    });
    res.setHeader(
      "Set-Cookie",
      `obv_user=${encodeURIComponent(newUser.id)}; Path=/; SameSite=Lax; Max-Age=86400`
    );
    if (isFormPost(req)) redirect(res, newUser.role === "FIELD" ? "/field" : "/overview");
    else sendJson(res, { user: newUser }, 201);
    return;
  }

  // ---- organizations ----
  if (method === "POST" && pathname === "/api/pilot/orgs") {
    const actor = pilotAdmin();
    if (!actor) { sendJson(res, { error: "Not authorized" }, 403); return; }
    const params = await pilotForm();
    const org = pilot.createOrganization(Object.fromEntries(params) as never, actor);
    pilotRespond("/setup", { organization: org }, 201);
    return;
  }

  // ---- invitations ----
  if (method === "POST" && pathname === "/api/pilot/invitations") {
    const actor = pilotAdmin();
    if (!actor) { sendJson(res, { error: "Not authorized" }, 403); return; }
    const params = await pilotForm();
    const { invitation, rawToken } = pilot.createInvitation(
      {
        email: params.get("email") ?? "",
        organizationId: params.get("organizationId") ?? "",
        role: params.get("role") ?? "",
        projectId: params.get("projectId") || null,
      },
      actor
    );
    // Mock delivery for the pilot demo build: the activation link is
    // surfaced ONCE to the administrator; no real email is sent and the
    // raw token is never logged or stored.
    const link = `${req.headers.host ? `http://${req.headers.host}` : ""}/invite/${rawToken}`;
    if (isFormPost(req)) {
      redirect(res, `/setup?invited=${encodeURIComponent(invitation.email)}&link=${encodeURIComponent(link)}`);
    } else {
      sendJson(res, { invitation, activationLink: link }, 201);
    }
    return;
  }
  const invActionMatch = /^\/api\/pilot\/invitations\/([^/]+)\/(resend|revoke)$/.exec(pathname);
  if (method === "POST" && invActionMatch) {
    const actor = pilotAdmin();
    if (!actor) { sendJson(res, { error: "Not authorized" }, 403); return; }
    if (invActionMatch[2] === "revoke") {
      const invitation = pilot.revokeInvitation(invActionMatch[1], actor);
      pilotRespond("/setup", { invitation });
    } else {
      const { invitation, rawToken } = pilot.resendInvitation(invActionMatch[1], actor);
      const link = `${req.headers.host ? `http://${req.headers.host}` : ""}/invite/${rawToken}`;
      if (isFormPost(req)) {
        redirect(res, `/setup?invited=${encodeURIComponent(invitation.email)}&link=${encodeURIComponent(link)}`);
      } else {
        sendJson(res, { invitation, activationLink: link });
      }
    }
    return;
  }

  // ---- project configuration ----
  if (method === "POST" && pathname === "/api/pilot/projects") {
    const actor = pilotAdmin();
    if (!actor) { sendJson(res, { error: "Not authorized" }, 403); return; }
    const params = await pilotForm();
    const project = pilot.createDraftProject(Object.fromEntries(params) as never, actor);
    if (isFormPost(req)) redirect(res, `/setup/project/${project.id}`);
    else sendJson(res, { project }, 201);
    return;
  }
  const pilotProjectMatch = /^\/api\/pilot\/projects\/([^/]+)(?:\/([a-z-]+))?(?:\/([a-z-]+))?$/.exec(pathname);
  if (pilotProjectMatch && pathname.startsWith("/api/pilot/projects/")) {
    const projectId = pilotProjectMatch[1];
    const sub = pilotProjectMatch[2] ?? "";
    // Export is readable by any pilot viewer role; everything else is admin.
    if (method === "GET" && sub === "export") {
      const viewer = currentUser(req);
      if (!viewer || !pilot.canViewPilot(viewer)) { sendJson(res, { error: "Not authorized" }, 403); return; }
      const pkg = pilot.buildExportPackage(projectId);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="obv-pilot-export-${projectId.slice(0, 8)}.json"`,
      });
      res.end(JSON.stringify(pkg, null, 2));
      return;
    }
    if (method === "POST") {
      const actor = pilotAdmin();
      if (!actor) { sendJson(res, { error: "Not authorized" }, 403); return; }
      const setupUrl = (stage: string) => `/setup/project/${projectId}?stage=${stage}`;
      if (sub === "") {
        const params = await pilotForm();
        pilot.updateDraftProject(projectId, Object.fromEntries(params) as never, actor);
        pilotRespond(setupUrl("project"), { project: repo.getProject(projectId) });
        return;
      }
      if (sub === "template") {
        const params = await pilotForm();
        const milestones = pilot.applyTemplate(projectId, params.get("templateKey") ?? "", actor);
        pilotRespond(setupUrl("milestones"), { milestones }, 201);
        return;
      }
      if (sub === "geography") {
        const params = await pilotForm();
        // Form posts carry one textarea (one "lng, lat" per line); JSON
        // callers may send an array of pairs (flattened to repeated params).
        const rawCoords = params.getAll("coordinates");
        const coordLines =
          rawCoords.length > 1
            ? rawCoords
            : (rawCoords[0] ?? "").split(/\n+/);
        const coordinates = coordLines
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.split(/[,;\s]+/).filter(Boolean).map(Number) as [number, number]);
        const project = pilot.setGeography(
          projectId,
          {
            kind: params.get("kind") ?? "",
            coordinates,
            label: params.get("label") ?? undefined,
            reason: params.get("reason") || null,
          },
          actor
        );
        pilotRespond(setupUrl("geography"), { project });
        return;
      }
      if (sub === "milestones") {
        const params = await pilotForm();
        const milestone = pilot.addMilestone(projectId, Object.fromEntries(params) as never, actor);
        pilotRespond(setupUrl("milestones"), { milestone }, 201);
        return;
      }
      if (sub === "draw") {
        const params = await pilotForm();
        const reason = params.get("reason") || null;
        for (const m of repo.listMilestones(projectId)) {
          const raw = params.get(`tranche_${m.id}`);
          if (raw !== null && Number(raw) !== m.trancheAmount) {
            pilot.updateMilestone(m.id, { trancheAmount: raw, reason }, actor);
          }
        }
        pilotRespond(setupUrl("draw"), { reconciliation: pilot.drawReconciliation(projectId) });
        return;
      }
      if (sub === "approval-matrix") {
        const params = await pilotForm();
        const policy = pilot.setApprovalMatrix(
          projectId, null, params.getAll("roles"), actor, params.get("reason") || null
        );
        pilotRespond(setupUrl("approvals"), { policy });
        return;
      }
      if (sub === "verification-policy") {
        const params = await pilotForm();
        const policy = pilot.saveVerificationPolicy(projectId, Object.fromEntries(params) as never, actor);
        pilotRespond(setupUrl("approvals"), { policy });
        return;
      }
      if (sub === "assignments") {
        const params = await pilotForm();
        const assignment = pilot.assignField(
          projectId,
          {
            userId: params.get("userId") ?? "",
            milestoneIds: params.getAll("milestoneIds").filter(Boolean),
            effectiveFrom: params.get("effectiveFrom") || null,
          },
          actor
        );
        pilotRespond(setupUrl("field"), { assignment }, 201);
        return;
      }
      if (sub === "launch") {
        const result = await pilot.launchProject(projectId, actor);
        pilotRespond(setupUrl("review"), result, 201);
        return;
      }
      if (sub === "import") {
        const kind = pilotProjectMatch[3] ?? "";
        const params = await pilotForm(512 * 1024);
        const commit = params.get("mode") === "commit";
        const result = pilot.importCsv(kind, projectId, params.get("csv") ?? "", commit, actor);
        if (isFormPost(req)) {
          const stage = kind === "requirements" ? "evidence" : "milestones";
          redirect(
            res,
            `${setupUrl(stage)}&import=${encodeURIComponent(JSON.stringify({ kind, ok: result.ok, imported: result.imported, errors: result.errors.slice(0, 8) }))}`
          );
        } else {
          sendJson(res, result, result.ok ? 200 : 422);
        }
        return;
      }
    }
  }
  const pilotMsMatch = /^\/api\/pilot\/milestones\/([^/]+)(?:\/(delete))?$/.exec(pathname);
  if (method === "POST" && pilotMsMatch) {
    const actor = pilotAdmin();
    if (!actor) { sendJson(res, { error: "Not authorized" }, 403); return; }
    const milestone = repo.getMilestone(pilotMsMatch[1]);
    const backTo = milestone ? `/setup/project/${milestone.projectId}?stage=milestones` : "/setup";
    if (pilotMsMatch[2] === "delete") {
      pilot.removeMilestone(pilotMsMatch[1], actor);
      pilotRespond(backTo, { ok: true });
    } else {
      const params = await pilotForm();
      const updated = pilot.updateMilestone(pilotMsMatch[1], Object.fromEntries(params) as never, actor);
      pilotRespond(backTo, { milestone: updated });
    }
    return;
  }
  if (method === "POST" && pathname === "/api/pilot/requirements") {
    const actor = pilotAdmin();
    if (!actor) { sendJson(res, { error: "Not authorized" }, 403); return; }
    const params = await pilotForm();
    const requirement = pilot.saveRequirement(Object.fromEntries(params) as never, actor);
    const ms = repo.getMilestone(requirement.milestoneId);
    pilotRespond(ms ? `/setup/project/${ms.projectId}?stage=evidence` : "/setup", { requirement }, 201);
    return;
  }
  const reqDeleteMatch = /^\/api\/pilot\/requirements\/([^/]+)\/delete$/.exec(pathname);
  if (method === "POST" && reqDeleteMatch) {
    const actor = pilotAdmin();
    if (!actor) { sendJson(res, { error: "Not authorized" }, 403); return; }
    const requirement = repo.getRequirement(reqDeleteMatch[1]);
    const ms = requirement ? repo.getMilestone(requirement.milestoneId) : null;
    pilot.removeRequirement(reqDeleteMatch[1], actor);
    pilotRespond(ms ? `/setup/project/${ms.projectId}?stage=evidence` : "/setup", { ok: true });
    return;
  }
  const assignDeactivateMatch = /^\/api\/pilot\/assignments\/([^/]+)\/deactivate$/.exec(pathname);
  if (method === "POST" && assignDeactivateMatch) {
    const actor = pilotAdmin();
    if (!actor) { sendJson(res, { error: "Not authorized" }, 403); return; }
    const rows = repo.listProjects().flatMap((p) => repo.listAssignmentsForProject(p.id));
    const target = rows.find((a) => a.id === assignDeactivateMatch[1]);
    repo.deactivateAssignment(assignDeactivateMatch[1]);
    pilotRespond(target ? `/setup/project/${target.projectId}?stage=field` : "/setup", { ok: true });
    return;
  }
  const csvTemplateMatch = /^\/api\/pilot\/csv-template\/([a-z]+)$/.exec(pathname);
  if (method === "GET" && csvTemplateMatch) {
    if (!currentUser(req)) { sendJson(res, { error: "Select a demo user first" }, 401); return; }
    const text = pilot.csvTemplateText(csvTemplateMatch[1]);
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="obv-${csvTemplateMatch[1]}-template.csv"`,
    });
    res.end(text);
    return;
  }

  // Development Full Reset — DANGEROUS: drops the entire database
  // including user-created pilot projects. Gated behind an authorized
  // role AND a typed confirmation phrase; never exposed casually.
  if (method === "POST" && pathname === "/api/dev/full-reset") {
    const resetUser = currentUser(req);
    if (!resetUser || resetUser.role !== "PROJECT_MANAGER") {
      sendJson(res, { error: "Not authorized" }, 403);
      return;
    }
    const body = (await readBody(req, 4 * 1024)).toString("utf8");
    const confirm = isFormPost(req)
      ? new URLSearchParams(body).get("confirm")
      : JSON.parse(body || "{}").confirm;
    if (confirm !== "FULL RESET") {
      sendJson(res, { error: 'Type the exact confirmation phrase "FULL RESET" to proceed' }, 422);
      return;
    }
    await seedDemo(); // full path: drops everything and reseeds
    if (isFormPost(req)) redirect(res, "/overview");
    else sendJson(res, { ok: true, mode: "FULL" });
    return;
  }

  // ---- pages ----
  if (method === "GET" && pathname === "/") {
    const users = repo.listUsers();
    const orgs = new Map(
      users.map((u) => [u.organizationId, repo.getOrganization(u.organizationId)!])
    );
    sendHtml(res, renderUserSwitcher(users, orgs));
    return;
  }

  const PAGE_PREFIXES = [
    "/overview", "/dashboard", "/projects", "/project/", "/milestone/",
    "/approvals", "/ledger", "/reports", "/compliance", "/insights", "/more", "/field",
    "/map", "/communications", "/issues", "/issue/", "/evidence-drafts",
    "/setup", "/pilot",
  ];
  const isPage = PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
  const user = currentUser(req);
  if (method === "GET" && isPage && !user) {
    redirect(res, "/");
    return;
  }

  if (method === "GET" && (pathname === "/dashboard" || pathname === "/overview")) {
    if (pathname === "/dashboard") {
      redirect(res, "/overview", 302);
      return;
    }
    // Overview shows operational (launched) projects; drafts live in
    // Pilot Setup until launched.
    const projects = (await allProjectCards()).filter((p) => p.project.status !== "DRAFT");
    const chain = await wormEvidenceStore.verifyChain();
    // Real records only: pending approvals -> next releases + queue; open
    // clarifications/issues/review counts from the primary stores.
    const pendingReqs = repo.listPendingApprovalRequests();
    const nextReleases = pendingReqs
      .map((req2) => {
        const ms = repo.getMilestone(req2.milestoneId)!;
        const proj = repo.getProject(ms.projectId)!;
        const approvedRoles = new Set(
          repo.listApprovalRecordsForRequest(req2.id).filter((r) => r.decision === "APPROVED").map((r) => r.role)
        );
        const missing = req2.requiredRoles.filter((r) => !approvedRoles.has(r));
        return {
          projectId: proj.id,
          projectName: proj.name,
          label: `${proj.name.split("(")[0].trim().slice(0, 28)} · M${ms.seq}`,
          amount: ms.trancheAmount,
          awaiting:
            approvedRoles.size > 0
              ? `Awaiting ${missing.map((r) => r.replace(/_/g, " ").toLowerCase()).join(", ")}`
              : `Awaiting ${req2.requiredRoles.length} approvals`,
        };
      })
      .sort((a, b) => b.amount - a.amount);
    const allMilestonesOv = projects.flatMap((p) => repo.listMilestones(p.project.id));
    const openClarsOv = allMilestonesOv
      .flatMap((ms) => repo.listClarificationsForMilestone(ms.id))
      .filter((c) => ["OPEN", "RESPONDED", "REOPENED"].includes(c.status)).length;
    const openIssuesOv = repo.listFieldIssues().filter((i) => !["RESOLVED", "CLOSED"].includes(i.status));
    const openIssuesByProject = new Map<string, number>();
    for (const issue of openIssuesOv) {
      openIssuesByProject.set(issue.projectId, (openIssuesByProject.get(issue.projectId) ?? 0) + 1);
    }
    sendHtml(
      res,
      renderOverview({
        nav: navFor(user!, "overview"),
        metrics: overviewMetrics(projects),
        projects,
        notifications: repo.listNotifications(),
        chainValid: chain.valid,
        teamsConfigured: TEAMS_CONFIG.configured(),
        nextReleases,
        queue: {
          approvals: pendingReqs.length,
          approvalsAmount: nextReleases.reduce((sum, r) => sum + r.amount, 0),
          approvalsProjects: new Set(nextReleases.map((r) => r.projectId)).size,
          clarifications: openClarsOv,
          highIssues: openIssuesOv.filter((i) => ["HIGH", "CRITICAL"].includes(i.severity)).length,
          evidenceReview: allMilestonesOv.filter((ms) => ms.status === "UNDER_REVIEW").length,
        },
        openIssuesByProject,
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/projects") {
    sendHtml(
      res,
      renderProjects({ nav: navFor(user!, "projects"), projects: await allProjectCards() })
    );
    return;
  }

  if (method === "GET" && pathname.startsWith("/project/")) {
    const data = await projectCardData(pathname.slice("/project/".length));
    if (!data) {
      sendHtml(res, renderError(navFor(user!, ""), "Project not found", "No project exists at this address."), 404);
      return;
    }
    const tabParam = (url.searchParams.get("tab") ?? "overview") as ProjectTab;
    const tab: ProjectTab = ["overview", "milestones", "evidence", "approvals", "ledger", "activity", "map", "discussion"].includes(tabParam)
      ? tabParam
      : "overview";
    const chain = await wormEvidenceStore.verifyChain();
    sendHtml(
      res,
      renderProjectDetail({
        nav: navFor(user!, "projects"),
        tab,
        data,
        approvals: repo.listApprovalRequestsForProject(data.project.id).map((approval) => ({
          approval,
          records: repo.listApprovalRecordsForRequest(approval.id),
          milestone: repo.getMilestone(approval.milestoneId)!,
        })),
        evidenceBundles: data.milestones.flatMap((r) => evidenceBundlesForMilestone(r.milestone.id)),
        ledger: repo.listLedgerEntries(),
        chainValid: chain.valid,
        accountEvents: repo.listAccountEventsForProject(data.project.id),
        notifications: repo.listNotifications(30),
        users: usersById(),
        threads: listThreadsForUser(user!)
          .filter((t) => t.projectId === data.project.id)
          .map((t) => ({
            thread: t,
            latest: repo.latestMessageForThread(t.id),
            milestone: t.milestoneId ? repo.getMilestone(t.milestoneId) : null,
          })),
      })
    );
    return;
  }

  if (method === "GET" && pathname.startsWith("/milestone/")) {
    const milestone = repo.getMilestone(pathname.slice("/milestone/".length));
    if (!milestone) {
      sendHtml(res, renderError(navFor(user!, ""), "Milestone not found", "No milestone exists at this address."), 404);
      return;
    }
    const project = repo.getProject(milestone.projectId)!;
    const rows = milestoneRows(project.id);
    const row = rows.find((r) => r.milestone.id === milestone.id)!;
    const canDecide = Boolean(
      row.approval &&
        row.approval.status === "PENDING" &&
        row.approval.requiredRoles.includes(user!.role) &&
        !row.approvalRecords.some((r) => r.role === user!.role)
    );
    sendHtml(
      res,
      renderMilestoneDetail({
        nav: navFor(user!, "projects"),
        project,
        row,
        bundles: evidenceBundlesForMilestone(milestone.id),
        users: usersById(),
        canDecide,
        clarifications: repo.listClarificationsForMilestone(milestone.id),
        drafts: repo.listDraftsForMilestone(milestone.id),
        canFieldOps: canManageFieldOps(user!),
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/approvals") {
    sendHtml(
      res,
      renderApprovals({
        nav: navFor(user!, "approvals"),
        items: approvalQueue(user!),
        users: usersById(),
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/ledger") {
    const chain = await wormEvidenceStore.verifyChain();
    const milestones = repo.listProjects().flatMap((p) => repo.listMilestones(p.id));
    const ledger = repo.listLedgerEntries();
    const users = usersById();
    const actorByEntry = new Map(
      ledger.map((e) => {
        const ev = repo.getEvidence(e.evidenceItemId);
        return [e.id, ev ? users.get(ev.userId)?.name ?? "—" : "—"] as [string, string];
      })
    );
    const lastCheck = repo
      .listNotifications(100)
      .find((n) => n.type === "INTEGRITY_CHECK");
    sendHtml(
      res,
      renderLedger({
        nav: navFor(user!, "ledger"),
        ledger,
        chainValid: chain.valid,
        brokenAt: chain.brokenAt,
        milestoneById: new Map(milestones.map((m) => [m.id, m])),
        projectById: new Map(repo.listProjects().map((p) => [p.id, p])),
        actorByEntry,
        lastCheckAt: lastCheck?.createdAt ?? null,
        checkedBanner: url.searchParams.get("checked")
          ? chain.valid
            ? `Integrity check complete: ${chain.entries} entries recomputed — CHAIN INTACT.`
            : `Integrity check complete: TAMPERING DETECTED AT ENTRY ${chain.brokenAt}.`
          : null,
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/reports") {
    sendHtml(
      res,
      renderReports({
        nav: navFor(user!, "reports"),
        projects: repo.listProjects(),
        reports: repo.listReports(),
        users: usersById(),
        pdfError: url.searchParams.get("error") === "pdf",
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/compliance") {
    const chain = await wormEvidenceStore.verifyChain();
    const bundles = repo
      .listProjects()
      .flatMap((p) => repo.listMilestones(p.id))
      .flatMap((m) => evidenceBundlesForMilestone(m.id));
    const projects = new Map(repo.listProjects().map((p) => [p.id, p]));
    const data: ComplianceData = {
      needsReview: bundles.filter((b) => b.verification?.verdict === "NEEDS_REVIEW"),
      rejected: bundles.filter((b) => b.verification?.verdict === "REJECTED"),
      awaitingApproval: repo.listPendingApprovalRequests().map((approval) => {
        const milestone = repo.getMilestone(approval.milestoneId)!;
        return {
          approval,
          milestone,
          project: projects.get(milestone.projectId)!,
          records: repo.listApprovalRecordsForRequest(approval.id),
        };
      }),
      chainValid: chain.valid,
      brokenAt: chain.brokenAt,
    };
    const allIssues = repo.listFieldIssues();
    const openIssues = allIssues.filter((i) => !["RESOLVED", "CLOSED"].includes(i.status));
    sendHtml(
      res,
      renderCompliance({
        nav: navFor(user!, "compliance"),
        data,
        users: usersById(),
        fieldIssues: {
          open: openIssues.length,
          critical: openIssues.filter((i) => i.severity === "CRITICAL").length,
          overdue: openIssues.filter((i) => i.dueAt && Date.parse(i.dueAt) < Date.now()).length,
        },
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/insights") {
    sendHtml(res, renderInsights({ nav: navFor(user!, "insights"), insights: computeInsights() }));
    return;
  }

  if (method === "GET" && pathname === "/map") {
    sendHtml(res, renderMap({ nav: navFor(user!, "map"), scope: "global" }));
    return;
  }

  if (method === "GET" && pathname === "/communications") {
    const threads = listThreadsForUser(user!);
    const selectedId = url.searchParams.get("thread");
    const selected = selectedId ? threads.find((t) => t.id === selectedId) ?? null : null;
    if (selectedId && !selected) {
      sendHtml(res, renderError(navFor(user!, "comms"), "Thread not found", "This conversation does not exist or is outside your organization's projects."), 404);
      return;
    }
    sendHtml(
      res,
      renderCommunications({
        nav: navFor(user!, "comms"),
        threads: threads.map((t) => ({
          thread: t,
          latest: repo.latestMessageForThread(t.id),
          project: t.projectId ? repo.getProject(t.projectId) : null,
          milestone: t.milestoneId ? repo.getMilestone(t.milestoneId) : null,
        })),
        selected: selected
          ? {
              thread: selected,
              messages: repo.listMessagesForThread(selected.id),
              project: selected.projectId ? repo.getProject(selected.projectId) : null,
              milestone: selected.milestoneId ? repo.getMilestone(selected.milestoneId) : null,
              binding: repo.getBindingForThread(selected.id),
              hasEvidence: selected.milestoneId
                ? repo.listEvidenceForMilestone(selected.milestoneId).length > 0
                : false,
            }
          : null,
        users: usersById(),
        currentUser: user!,
        teamsSyncConfigured: syncConfigured(),
        teamsSendCapability: sendCapability(),
        teamsTestMode: syncConfigured() && !GRAPH_CONFIG.realGraph(),
        canManageTeams: canManageBindings(user!),
        syncError: url.searchParams.get("sync_error"),
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/issues") {
    sendHtml(
      res,
      renderIssues({
        nav: navFor(user!, "issues"),
        issues: repo.listFieldIssues().map((issue) => ({
          issue,
          project: repo.getProject(issue.projectId),
          milestone: issue.milestoneId ? repo.getMilestone(issue.milestoneId) : null,
          assignee: issue.assignedToUserId ? repo.getUser(issue.assignedToUserId) : null,
        })),
        canManage: canManageFieldOps(user!),
      })
    );
    return;
  }

  if (method === "GET" && pathname.startsWith("/issue/")) {
    const issue = repo.getFieldIssue(pathname.slice("/issue/".length));
    if (!issue) {
      sendHtml(res, renderError(navFor(user!, "issues"), "Issue not found", "No field issue exists at this address."), 404);
      return;
    }
    sendHtml(
      res,
      renderIssueDetail({
        nav: navFor(user!, "issues"),
        issue,
        project: repo.getProject(issue.projectId)!,
        milestone: issue.milestoneId ? repo.getMilestone(issue.milestoneId) : null,
        assignee: issue.assignedToUserId ? repo.getUser(issue.assignedToUserId) : null,
        reporter: issue.reportedByUserId ? repo.getUser(issue.reportedByUserId) : null,
        events: repo.listIssueEvents(issue.id),
        sourceMessage: issue.sourceMessageId ? repo.getChatMessage(issue.sourceMessageId) : null,
        users: usersById(),
        canManage: canManageFieldOps(user!),
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/issues/new") {
    if (!canManageFieldOps(user!)) {
      sendHtml(res, renderError(navFor(user!, "issues"), "Not authorized", "Creating field issues requires a project manager, funder representative or compliance reviewer."), 403);
      return;
    }
    const sourceMessage = url.searchParams.get("messageId")
      ? repo.getChatMessage(url.searchParams.get("messageId")!)
      : null;
    const sourceThread = sourceMessage ? repo.getThread(sourceMessage.threadId) : null;
    sendHtml(
      res,
      renderIssueNew({
        nav: navFor(user!, "issues"),
        sourceMessage,
        project:
          (sourceThread?.projectId ? repo.getProject(sourceThread.projectId) : null) ??
          repo.listProjects()[0] ?? null,
        milestone: sourceThread?.milestoneId ? repo.getMilestone(sourceThread.milestoneId) : null,
        users: repo.listUsers(),
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/evidence-drafts/new") {
    const canPromote = canManageFieldOps(user!) || user!.role === "FIELD";
    const sourceMessage = url.searchParams.get("messageId")
      ? repo.getChatMessage(url.searchParams.get("messageId")!)
      : null;
    if (!canPromote || !sourceMessage) {
      sendHtml(res, renderError(navFor(user!, "comms"), "Cannot promote", !canPromote ? "Promoting media requires an authorized role." : "Source message not found."), canPromote ? 404 : 403);
      return;
    }
    const thread = repo.getThread(sourceMessage.threadId)!;
    const project = thread.projectId ? repo.getProject(thread.projectId) : repo.listProjects()[0];
    sendHtml(
      res,
      renderDraftNew({
        nav: navFor(user!, "comms"),
        sourceMessage,
        attachmentIndex: Number(url.searchParams.get("attachment") ?? 0),
        project: project!,
        milestones: project ? repo.listMilestones(project.id) : [],
        defaultMilestoneId: thread.milestoneId,
        locationMessages: repo
          .listMessagesForThread(thread.id)
          .filter((m) => m.location !== null),
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/communications/integrations") {
    const threads = listThreadsForUser(user!);
    const rows = threads
      .map((t) => ({
        thread: t,
        binding: repo.getBindingForThread(t.id),
        project: t.projectId ? repo.getProject(t.projectId) : null,
      }))
      .filter((r) => r.binding !== null);
    sendHtml(
      res,
      renderIntegrations({
        nav: navFor(user!, "integrations"),
        configured: syncConfigured(),
        testMode: syncConfigured() && !GRAPH_CONFIG.realGraph(),
        sendCap: sendCapability(),
        canManage: canManageBindings(user!),
        rows,
        threadCount: threads.length,
        maintained: url.searchParams.get("maintained"),
        watest: url.searchParams.get("watest"),
        whatsapp: {
          ...whatsappStatus(),
          canManage: canManageBindings(user!),
          unresolvedCount: (() => {
            const t = repo
              .listThreads()
              .find((x) => x.scope === "ORGANIZATION" && x.title === "WhatsApp — Unresolved");
            return t ? repo.listMessagesForThread(t.id).length : 0;
          })(),
          lastInbound:
            repo
              .listThreads()
              .flatMap((t) => repo.listMessagesForThread(t.id))
              .filter((m) => m.provider === "WHATSAPP" && m.origin === "WHATSAPP_INBOUND")
              .map((m) => m.createdAt)
              .sort()
              .pop() ?? null,
        },
      })
    );
    return;
  }

  // ---- pilot setup workspace ----
  if (method === "GET" && pathname === "/setup") {
    if (!pilot.canViewPilot(user!)) {
      sendHtml(res, renderError(navFor(user!, ""), "Not available", "Pilot setup is available to Project Manager, Funder Representative, and Compliance roles."), 403);
      return;
    }
    const pilotProjects = repo.listProjects().filter((p) => pilot.isPilotProject(p.id));
    sendHtml(
      res,
      renderPilotSetup({
        nav: navFor(user!, "setup"),
        orgs: repo.listOrganizations(),
        invitations: repo.listInvitations().map((invitation) => ({
          invitation,
          org: repo.getOrganization(invitation.organizationId),
          acceptedUser: invitation.acceptedUserId ? repo.getUser(invitation.acceptedUserId) : null,
        })),
        projects: pilotProjects.map((project) => ({
          project,
          stages: pilot.setupStages(project.id),
        })),
        users: usersById(),
        canAdmin: pilot.canAdminPilot(user!),
        issuedInvite:
          url.searchParams.get("invited") && url.searchParams.get("link")
            ? { email: url.searchParams.get("invited")!, link: url.searchParams.get("link")! }
            : null,
        error: url.searchParams.get("error"),
      })
    );
    return;
  }
  const setupProjectMatch = /^\/setup\/project\/([^/]+)$/.exec(pathname);
  if (method === "GET" && setupProjectMatch) {
    if (!pilot.canViewPilot(user!)) {
      redirect(res, "/overview");
      return;
    }
    const project = repo.getProject(setupProjectMatch[1]);
    if (!project) {
      sendHtml(res, renderError(navFor(user!, ""), "Not found", "No project at this address."), 404);
      return;
    }
    const stages = pilot.setupStages(project.id);
    const stage = stages.some((st) => st.slug === url.searchParams.get("stage"))
      ? url.searchParams.get("stage")!
      : "project";
    const milestones = repo.listMilestones(project.id);
    let importResult: { kind: string; ok: boolean; imported: number; errors: string[] } | null = null;
    try {
      importResult = url.searchParams.get("import")
        ? JSON.parse(url.searchParams.get("import")!)
        : null;
    } catch { /* ignore malformed */ }
    sendHtml(
      res,
      renderProjectSetup({
        nav: navFor(user!, "setup"),
        project,
        stage,
        stages,
        canAdmin: pilot.canAdminPilot(user!),
        data: {
          orgs: repo.listOrganizations(),
          milestones,
          requirementsByMilestone: new Map(
            milestones.map((m) => [m.id, repo.listRequirementsForMilestone(m.id)])
          ),
          templates: PROJECT_TEMPLATES,
          reconciliation: pilot.drawReconciliation(project.id),
          approvalPolicies: repo.listApprovalPolicies(project.id),
          verificationPolicy: repo.getVerificationPolicy(project.id),
          assignments: repo.listAssignmentsForProject(project.id).map((assignment) => ({
            assignment,
            user: repo.getUser(assignment.userId),
          })),
          participants: pilot.projectParticipants(project.id),
          readiness: pilot.evaluateReadiness(project.id),
          route: repo.listSpatialFeatures(project.id).find((f) => f.kind === "ROUTE") ?? null,
          integrations: {
            teamsConfigured: syncConfigured(),
            whatsappConfigured: whatsappConfigured(),
          },
          audit: repo.listConfigAudit(project.id, 50),
          snapshots: repo.listConfigSnapshots(project.id),
          users: usersById(),
          importResult,
          error: url.searchParams.get("error"),
        },
      })
    );
    return;
  }

  // ---- pilot operations dashboard ----
  if (method === "GET" && pathname === "/pilot") {
    const allProjects = repo.listProjects();
    const activeProjects = allProjects.filter((p) => p.status === "ACTIVE");
    const draftProjects = allProjects.filter((p) => p.status === "DRAFT");
    const verifications = repo.listAllVerifications();
    const allMilestones = allProjects.flatMap((p) => repo.listMilestones(p.id));
    const fundsHeld = allMilestones
      .filter((m) => m.accountStatus === "HELD" && !m.archived)
      .reduce((sum, m) => sum + m.trancheAmount, 0);
    const fundsReleased = allMilestones
      .filter((m) => m.accountStatus === "RELEASED")
      .reduce((sum, m) => sum + m.trancheAmount, 0);
    const openClarifications = allMilestones
      .flatMap((m) => repo.listClarificationsForMilestone(m.id))
      .filter((c) => !["ACCEPTED", "CLOSED"].includes(c.status)).length;
    const activeRows = await Promise.all(
      activeProjects.map(async (project) => {
        const summary = await virtualAccountService.getProjectSummary(project.id);
        return {
          project,
          held: summary.held,
          released: summary.released,
          pendingApprovals: repo
            .listApprovalRequestsForProject(project.id)
            .filter((a) => a.status === "PENDING").length,
        };
      })
    );
    sendHtml(
      res,
      renderPilotDashboard({
        nav: navFor(user!, "pilot"),
        stats: {
          activeProjects: activeProjects.length,
          draftProjects: draftProjects.length,
          evidenceSubmitted: verifications.length,
          verified: verifications.filter((v) => v.verdict === "VERIFIED").length,
          needsReview: verifications.filter((v) => v.verdict === "NEEDS_REVIEW").length,
          rejected: verifications.filter((v) => v.verdict === "REJECTED").length,
          pendingApprovals: repo.listPendingApprovalRequests().length,
          fundsHeld,
          fundsReleased,
          openIssues: repo.listFieldIssues().filter((i) => !["RESOLVED", "CLOSED"].includes(i.status)).length,
          openClarifications,
          invitationsPending: repo.listInvitations().filter((i) => i.status === "PENDING").length,
        },
        integrations: {
          teamsConfigured: syncConfigured(),
          whatsappConfigured: whatsappConfigured(),
        },
        drafts: draftProjects.map((project) => ({
          project,
          blockers: pilot
            .evaluateReadiness(project.id)
            .checks.filter((c) => !c.ok && !c.optional).length,
        })),
        active: activeRows,
        canAdmin: pilot.canAdminPilot(user!),
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/more") {
    sendHtml(res, renderMore({ nav: navFor(user!, "more") }));
    return;
  }

  if (method === "GET" && pathname === "/field") {
    sendHtml(res, renderFieldShell(user!));
    return;
  }

  sendHtml(res, renderError(user ? navFor(user, "") : null, "Not found", `No page at ${pathname}.`), 404);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    // SubmissionErrors carry intentional, user-safe messages. Anything
    // else is logged server-side only and surfaced generically — no
    // stack traces, no internal paths, no provider details.
    const known = err instanceof SubmissionError;
    const status = known ? err.statusCode : 500;
    console.error(`[error] ${req.method} ${req.url}:`, err.stack ?? err.message ?? err);
    const message = known ? err.message : "Internal server error";
    if (res.headersSent) {
      res.end();
      return;
    }
    if ((req.headers.accept ?? "").includes("text/html")) {
      // Browser navigation (form post) — styled error page, never raw JSON.
      sendHtml(res, renderError(null, "Something went wrong", message), status);
    } else {
      sendJson(res, { error: message }, status);
    }
  });
});

getDb(); // fail fast if the database cannot be opened
server.listen(PORT, () => {
  console.log(`OBV running at http://localhost:${PORT}`);
  console.log(`Demo sign-in: http://localhost:${PORT}/  (pick a seeded role)`);
});
