/**
 * OBV HTTP server — node:http with hand-rolled routing.
 *
 * Built without a framework because the build environment has no access to
 * the npm registry. Handlers are organised like Next.js route handlers
 * (one function per method+path) so a future migration to Next.js App
 * Router route handlers is mechanical.
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { getDb, REPORTS_DIR, WORM_DIR } from "../db/index";
import * as repo from "../db/repo";
import { seedDemo } from "../db/seed";
import { virtualAccountService } from "../services/VirtualAccountService";
import { wormEvidenceStore } from "../services/WormEvidenceStore";
import { teamsNotifier } from "../services/TeamsNotifier";
import { polygonCentroid } from "../services/geo";
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

// Minimal .env loader (no dependency): KEY=VALUE lines, existing env wins.
// Values are never logged. Used for ANTHROPIC_API_KEY / OBV_AI_* settings.
try {
  const envFile = path.join(process.cwd(), ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
} catch {
  /* .env is optional */
}

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = path.join(process.cwd(), "public");

// PDF rendering: headless Chromium via the globally installed Playwright
// (no npm dependency added). One-time token lets the renderer fetch the
// report HTML without a demo session cookie.
const RENDER_SCRIPT = path.join(process.cwd(), "scripts", "render-pdf.js");
const PLAYWRIGHT_NODE_PATH =
  process.env.OBV_PLAYWRIGHT_NODE_PATH ?? "/opt/node22/lib/node_modules";
const previewToken = randomUUID();
/** Report HTML cached between generate-request and Chromium fetch. */
const pendingReportHtml = new Map<string, string>();

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
  return {
    user,
    active,
    pendingApprovals: repo.listPendingApprovalRequests().length,
    orgName: repo.getOrganization(user.organizationId)?.name,
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
              (SELECT COUNT(*) FROM notifications) AS n`
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

  // ---- static assets ----
  if (method === "GET") {
    if (pathname.startsWith("/worm/")) {
      if (serveStatic(res, WORM_DIR, pathname.slice("/worm/".length))) return;
    } else if (pathname !== "/" && serveStatic(res, PUBLIC_DIR, pathname.slice(1))) {
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
    const projects = repo.listProjects().map((project) => {
      const centre = polygonCentroid(project.siteBoundary);
      return {
        id: project.id,
        name: project.name,
        location: project.location,
        simulatedGps: { latitude: centre.lat, longitude: centre.lng },
        milestones: repo.listMilestones(project.id).map((m) => ({
          id: m.id,
          seq: m.seq,
          title: m.title,
          requirement: m.requirement,
          trancheAmount: m.trancheAmount,
          status: m.status,
          accountStatus: m.accountStatus,
          demoPhotos: repo.listDemoFallbackPhotos(m.id),
        })),
      };
    });
    sendJson(res, { projects });
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
    await teamsNotifier.notify(
      "INTEGRITY_CHECK",
      chain.valid
        ? `Ledger integrity check run: ${chain.entries} entries verified — CHAIN INTACT.`
        : `Ledger integrity check run: TAMPERING DETECTED AT ENTRY ${chain.brokenAt}.`
    );
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
        `Funder report generated for "${data.project.name}" by ${user.name} (ledger: ${report.integrityStatus === "INTACT" ? "chain intact" : report.integrityStatus}).`
      );
      if (isFormPost(req)) {
        redirect(res, `/reports/file/${report.id}`);
      } else {
        sendJson(res, { report }, 201);
      }
    } catch (err) {
      console.error("[report] PDF generation failed:", (err as Error).message);
      if (isFormPost(req)) {
        redirect(res, `/reports?error=pdf&project=${encodeURIComponent(projectId)}`);
      } else {
        sendJson(res, { error: "PDF generation failed: " + (err as Error).message }, 500);
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

  // Reset the demo database to its seeded state.
  if (method === "POST" && pathname === "/api/demo/reset") {
    await seedDemo();
    await teamsNotifier.notify("DEMO_RESET", "Demo data reset to the seeded state.");
    if (isFormPost(req) || (req.headers.accept ?? "").includes("text/html")) {
      redirect(res, "/overview");
    } else {
      sendJson(res, { ok: true });
    }
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
    const projects = await allProjectCards();
    const chain = await wormEvidenceStore.verifyChain();
    sendHtml(
      res,
      renderOverview({
        nav: navFor(user!, "overview"),
        metrics: overviewMetrics(projects),
        projects,
        notifications: repo.listNotifications(),
        chainValid: chain.valid,
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
    const tab: ProjectTab = ["overview", "milestones", "evidence", "approvals", "ledger", "activity"].includes(tabParam)
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
    sendHtml(res, renderCompliance({ nav: navFor(user!, "compliance"), data, users: usersById() }));
    return;
  }

  if (method === "GET" && pathname === "/insights") {
    sendHtml(res, renderInsights({ nav: navFor(user!, "insights"), insights: computeInsights() }));
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
    const status = err instanceof SubmissionError ? err.statusCode : 500;
    console.error(`[error] ${req.method} ${req.url}:`, err.message ?? err);
    if (!res.headersSent) {
      sendJson(res, { error: err.message ?? "Internal server error" }, status);
    } else {
      res.end();
    }
  });
});

getDb(); // fail fast if the database cannot be opened
server.listen(PORT, () => {
  console.log(`OBV running at http://localhost:${PORT}`);
  console.log(`Demo sign-in: http://localhost:${PORT}/  (pick a seeded role)`);
});
