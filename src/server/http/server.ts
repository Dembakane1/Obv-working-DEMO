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
import { createHash } from "node:crypto";
import { getDb, WORM_DIR } from "../db/index";
import * as repo from "../db/repo";
import { virtualAccountService } from "../services/VirtualAccountService";
import { wormEvidenceStore } from "../services/WormEvidenceStore";
import { polygonCentroid } from "../services/geo";
import { processEvidenceSubmission, SubmissionError } from "../workflow/orchestrator";
import {
  EvidenceBundle,
  MilestoneRow,
  renderDashboard,
  renderError,
  renderFieldShell,
  renderMilestoneDetail,
  renderProjectDetail,
  renderUserSwitcher,
} from "../view/pages";
import type { EvidenceSubmission, User } from "../../shared/types";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = path.join(process.cwd(), "public");

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

function milestoneRows(projectId: string): MilestoneRow[] {
  return repo.listMilestones(projectId).map((milestone) => {
    const latestEvidence = repo.latestEvidenceForMilestone(milestone.id);
    return {
      milestone,
      latestEvidence,
      verification: latestEvidence ? repo.getVerificationForEvidence(latestEvidence.id) : null,
      approval: repo.getApprovalRequestForMilestone(milestone.id),
    };
  });
}

function evidenceBundlesForMilestone(milestoneId: string): EvidenceBundle[] {
  const milestone = repo.getMilestone(milestoneId)!;
  return repo.listEvidenceForMilestone(milestoneId).map((evidence) => ({
    evidence,
    verification: repo.getVerificationForEvidence(evidence.id),
    ledgerEntry: repo.getLedgerEntryForEvidence(evidence.id),
    milestone,
    submittedBy: repo.getUser(evidence.userId),
  }));
}

/** Cheap change fingerprint used by the dashboard's polling refresh. */
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
    redirect(res, user.role === "FIELD" ? "/field" : "/dashboard");
    return;
  }

  // ---- APIs ----
  if (method === "GET" && pathname === "/api/state") {
    sendJson(res, { fingerprint: stateFingerprint() });
    return;
  }

  if (method === "GET" && pathname === "/api/field-context") {
    // Everything the field PWA needs in one payload: projects, milestones,
    // demo fallback photos, and a simulated-GPS point inside each geofence.
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

  // ---- pages ----
  if (method === "GET" && pathname === "/") {
    const users = repo.listUsers();
    const orgs = new Map(
      users.map((u) => [u.organizationId, repo.getOrganization(u.organizationId)!])
    );
    sendHtml(res, renderUserSwitcher(users, orgs));
    return;
  }

  const user = currentUser(req);
  if (method === "GET" && (pathname === "/dashboard" || pathname.startsWith("/project/") || pathname.startsWith("/milestone/") || pathname === "/field")) {
    if (!user) {
      redirect(res, "/");
      return;
    }
  }

  if (method === "GET" && pathname === "/dashboard") {
    const projects = [];
    for (const project of repo.listProjects()) {
      projects.push({
        project,
        org: repo.getOrganization(project.organizationId),
        milestones: milestoneRows(project.id),
        summary: await virtualAccountService.getProjectSummary(project.id),
        pendingApprovals: repo
          .listApprovalRequestsForProject(project.id)
          .filter((a) => a.status === "PENDING"),
      });
    }
    sendHtml(res, renderDashboard({ user: user!, projects, notifications: repo.listNotifications() }));
    return;
  }

  if (method === "GET" && pathname.startsWith("/project/")) {
    const project = repo.getProject(pathname.slice("/project/".length));
    if (!project) {
      sendHtml(res, renderError(user, "Project not found", "No project exists at this address."), 404);
      return;
    }
    const rows = milestoneRows(project.id);
    const bundles = rows.flatMap((r) => evidenceBundlesForMilestone(r.milestone.id));
    const chain = await wormEvidenceStore.verifyChain();
    sendHtml(
      res,
      renderProjectDetail({
        user: user!,
        project,
        org: repo.getOrganization(project.organizationId),
        milestones: rows,
        summary: await virtualAccountService.getProjectSummary(project.id),
        approvals: repo.listApprovalRequestsForProject(project.id),
        ledger: repo.listLedgerEntries(),
        chainValid: chain.valid,
        evidenceBundles: bundles,
        accountEvents: repo.listAccountEventsForProject(project.id),
        milestoneById: new Map(rows.map((r) => [r.milestone.id, r.milestone])),
      })
    );
    return;
  }

  if (method === "GET" && pathname.startsWith("/milestone/")) {
    const milestone = repo.getMilestone(pathname.slice("/milestone/".length));
    if (!milestone) {
      sendHtml(res, renderError(user, "Milestone not found", "No milestone exists at this address."), 404);
      return;
    }
    const project = repo.getProject(milestone.projectId)!;
    sendHtml(
      res,
      renderMilestoneDetail({
        user: user!,
        project,
        milestone,
        approval: repo.getApprovalRequestForMilestone(milestone.id),
        bundles: evidenceBundlesForMilestone(milestone.id),
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/field") {
    sendHtml(res, renderFieldShell(user!));
    return;
  }

  sendHtml(res, renderError(user, "Not found", `No page at ${pathname}.`), 404);
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
