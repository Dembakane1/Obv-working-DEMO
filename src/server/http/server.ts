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
import { getDb, REPORTS_DIR, WORM_DIR, UPLOADS_DIR } from "../db/index";
import * as repo from "../db/repo";
import { seedDemo } from "../db/seed";
import { virtualAccountService } from "../services/VirtualAccountService";
import { wormEvidenceStore } from "../services/WormEvidenceStore";
import { computeIntelligence } from "../services/intelligence";
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
import * as draws from "../services/draws";
import { DrawError } from "../services/draws";
import * as budget from "../services/budgetProgress";
import { BudgetError } from "../services/budgetProgress";
import * as exceptions from "../services/exceptions";
import { ExceptionError } from "../services/exceptions";
import * as changeOrders from "../services/changeOrders";
import { ChangeOrderError } from "../services/changeOrders";
import * as retainage from "../services/retainage";
import { RetainageError } from "../services/retainage";
import * as auditPackages from "../services/auditPackage";
import * as drawPackage from "../services/drawPackage";
import * as completionGates from "../services/completionGates";
import { GateError } from "../services/completionGates";
import * as permits from "../services/permits";
import { PermitError } from "../services/permits";
import { renderPermitRegister } from "../view/permitPages";
import { renderDrawVerificationDoc } from "../view/drawVerificationDoc";
import { AuditPackageError } from "../services/auditPackage";
import * as lrepo from "../db/lenderRepo";
import * as lenderAccess from "../services/lenderAccess";
import { LenderError } from "../services/lenderAccess";
import * as loanProfile from "../services/loanProfile";
import * as drawInspections from "../services/drawInspections";
import * as lenderDecisions from "../services/lenderDecisions";
import * as drawWorkflow from "../services/drawWorkflow";
import { renderAuditCover } from "../view/auditCover";
import { CoDetailData, renderCoDetail, renderCoNew, renderCoRegister } from "../view/coPages";
import {
  ExceptionDetailData,
  ExceptionRow,
  renderExceptionDetail,
  renderExceptionRegister,
} from "../view/exceptionPages";
import {
  BudgetPageData,
  renderBudgetPage,
  renderBudgetPortfolio,
} from "../view/budgetPages";
import {
  DrawDetailData,
  DrawEvidenceRow,
  DrawRegisterRow,
  DrawTab,
  LenderTabData,
  renderDrawDetail,
  renderDrawNew,
  renderDrawRegister,
  renderDrawReport,
} from "../view/drawPages";
import {
  ApprovalQueueItem,
  ComplianceData,
  EvidenceBundle,
  MilestoneRow,
  OverviewMetrics,
  ProjectCardData,
  ProjectTab,
  renderApprovals,
  renderCompliance,
  renderError,
  renderFieldShell,
  renderIntelligence,
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
import { renderHome, type HomeSnapshot } from "../view/homePage";
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
    openExceptions: repo
      .listExceptions()
      .filter(
        (e) =>
          ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"].includes(e.status) &&
          ["HIGH", "CRITICAL"].includes(e.severity)
      ).length,
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
      (s, a) => s + (repo.getMilestone(a.milestoneId!)?.trancheAmount ?? 0),
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
    const releasedByMilestone = new Map(
      repo
        .listAccountEventsForProject(project.id)
        .filter((e) => e.type === "RELEASED")
        .map((e) => [e.milestoneId, e.createdAt])
    );
    for (const approval of repo.listApprovalRequestsForProject(project.id)) {
      const milestone = repo.getMilestone(approval.milestoneId!)!;
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
        releasedAt: releasedByMilestone.get(milestone.id) ?? null,
      });
    }
  }
  return items.sort((a, b) => (a.approval.createdAt < b.approval.createdAt ? 1 : -1));
}


function drawContractContext(projectId: string): { original: number; approvedChanges: number; current: number } {
  const lines = repo.listBudgetLines(projectId).filter((l) => l.active);
  const original = lines.length
    ? lines.reduce((s2, l) => s2 + l.originalBudget, 0)
    : repo.getProject(projectId)?.totalBudget ?? 0;
  const approvedChanges = lines.length
    ? lines.reduce((s2, l) => s2 + l.approvedChanges, 0)
    : changeOrders.approvedChangeTotal(projectId);
  return { original, approvedChanges, current: original + approvedChanges };
}

function drawLineChangeOrders(drawId: string): Map<string, { number: number; status: string; approved: boolean }> {
  return new Map(
    repo
      .listDrawLines(drawId)
      .filter((l) => l.changeOrderId)
      .map((l) => {
        const co = repo.getChangeOrder(l.changeOrderId!)!;
        return [
          l.id,
          {
            number: co.changeOrderNumber,
            status: co.status,
            approved: ["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(co.status),
          },
        ];
      })
  );
}

function drawRetainageContext(draw: import("../../shared/types").DrawRequest): { rate: number; withheld: number; netEligible: number } | null {
  if (draw.retainageRate === null || draw.retainageWithheld === null) return null;
  const gross = draw.recommendedAmount ?? 0;
  return { rate: draw.retainageRate, withheld: draw.retainageWithheld, netEligible: gross - draw.retainageWithheld };
}

// ------------------------------------------------- exception page data

function exceptionRow(e: import("../../shared/types").ObvException): ExceptionRow {
  const milestone = e.milestoneId ? repo.getMilestone(e.milestoneId) : null;
  const draw = e.drawRequestId ? repo.getDrawRequest(e.drawRequestId) : null;
  const status = e.status;
  const nextAction =
    status === "OPEN"
      ? "Acknowledge & assign"
      : status === "ACKNOWLEDGED"
        ? "Start work"
        : status === "IN_PROGRESS"
          ? "Clear the source condition, then resolve"
          : status === "AWAITING_RESPONSE"
            ? "Awaiting requested response"
            : status === "RESOLVED"
              ? "Close"
              : "No action";
  return {
    exception: e,
    project: repo.getProject(e.projectId),
    milestone,
    drawNumber: draw?.drawNumber ?? null,
    owner: e.ownerUserId ? repo.getUser(e.ownerUserId) : null,
    ageDays: exceptions.ageDays(e),
    sla: exceptions.slaState(e),
    nextAction,
  };
}

// ------------------------------------------------------ draw page data

function drawEvidenceRows(drawId: string): DrawEvidenceRow[] {
  const lines = repo.listDrawLines(drawId);
  return repo.listDrawEvidenceLinks(drawId).map((link) => {
    const evidence = repo.getEvidence(link.evidenceItemId);
    const milestone = evidence ? repo.getMilestone(evidence.milestoneId) : null;
    return {
      link,
      evidence,
      verification: evidence ? repo.getVerificationForEvidence(evidence.id) : null,
      milestone,
      ledgerEntry: evidence ? repo.getLedgerEntryForEvidence(evidence.id) : null,
      line: link.lineItemId ? lines.find((l) => l.id === link.lineItemId) ?? null : null,
    };
  });
}

function assembleDrawDetail(
  user: User,
  draw: import("../../shared/types").DrawRequest,
  tab: DrawTab,
  notice: { kind: "ok" | "err"; text: string } | null = null
): DrawDetailData {
  const project = repo.getProject(draw.projectId)!;
  const summary = draws.drawHeaderSummary(draw.id);
  const milestones = repo.listMilestones(project.id).filter((m) => !m.archived);
  const approval = summary.approval;
  const approvalRecords = summary.approvalRecords;
  const alreadyDecided = Boolean(approval && approvalRecords.some((r) => r.role === user.role));
  const isSubmitter = draw.requestedByUserId === user.id;
  return {
    nav: navFor(user, "draws"),
    tab,
    draw,
    project,
    borrowerOrg: draw.requestedByOrganizationId ? repo.getOrganization(draw.requestedByOrganizationId) : null,
    lenderOrg: repo.getOrganization(draw.organizationId),
    summary,
    lines: repo.listDrawLines(draw.id),
    milestones,
    checklist: draws.documentChecklist(draw.id),
    documents: repo.listDrawDocuments(draw.id),
    evidenceRows: drawEvidenceRows(draw.id),
    projectEvidence: milestones.flatMap((m) =>
      repo.listEvidenceForMilestone(m.id).map((evidence) => ({
        evidence,
        milestone: m,
        verification: repo.getVerificationForEvidence(evidence.id),
      }))
    ),
    events: repo.listDrawEvents(draw.id),
    accountEvents: repo.listDrawAccountEvents(draw.id),
    recommendation: draws.computeRecommendation(draw.id),
    completeness: draws.completeness(draw.id),
    lineComparisons: new Map(
      repo.listDrawLines(draw.id).map((l) => [l.id, budget.compareDrawLine(draw.projectId, l)])
    ),
    contract: drawContractContext(draw.projectId),
    lineChangeOrders: drawLineChangeOrders(draw.id),
    lineMilestoneGates: (() => {
      const out = new Map<string, { summary: string; eligibility: string; blocking: string[] }>();
      for (const l of repo.listDrawLines(draw.id)) {
        if (!l.milestoneId || out.has(l.milestoneId)) continue;
        const g = completionGates.milestoneGates(l.milestoneId);
        out.set(l.milestoneId, {
          summary: completionGates.gateSummaryLabel(g),
          eligibility: g.eligibility.result,
          blocking: g.eligibility.reasons.filter((r) => r.blocking).map((r) => r.detail),
        });
      }
      return out;
    })(),
    retainage: drawRetainageContext(draw),
    approval,
    approvalRecords,
    users: usersById(),
    threadId: repo.findThreadForDraw(draw.id)?.id ?? null,
    reports: repo
      .listReports()
      .filter(
        (r) =>
          r.projectId === draw.projectId &&
          r.reportType === "DRAW_REVIEW_SUMMARY" &&
          r.filename.includes(`Draw-${draw.drawNumber}-`)
      ),
    canEdit: draws.canAccessDraw(user, draw) && user.role !== "FIELD",
    canReview: draws.canReviewDraw(user, draw),
    canDecide: Boolean(
      approval &&
        approval.status === "PENDING" &&
        approval.requiredRoles.includes(user.role) &&
        !alreadyDecided &&
        !isSubmitter &&
        draws.canAccessDraw(user, draw)
    ),
    alreadyDecided,
    isSubmitter,
    lender: tab === "lender" ? assembleLenderTab(user, draw, isSubmitter, summary.approval, notice) : null,
  };
}

/**
 * Lender Review workspace assembly — every value is read from the
 * authoritative services/repositories for THIS draw and project. Nothing
 * is synthesized: absent lender-domain records surface as nulls / empty
 * arrays and the view renders them as "Not recorded". The one derived
 * value (nextAction) is a presentation mapping of drawWorkflow's derived
 * stage plus stored record states — never a second workflow.
 */
function assembleLenderTab(
  user: User,
  draw: import("../../shared/types").DrawRequest,
  isSubmitter: boolean,
  approval: import("../../shared/types").ApprovalRequest | null,
  notice: { kind: "ok" | "err"; text: string } | null
): LenderTabData {
  const stage = drawWorkflow.deriveDrawStage(draw.id);
  const loan = lrepo.getLoanAssetForProject(draw.projectId);
  const inspections = lrepo.listDrawInspections(draw.id).map((inspection) => ({
    inspection,
    lines: lrepo.listInspectionLines(inspection.id),
    versions: lrepo.listReportVersions(inspection.id),
    events: lrepo.listInspectionEvents(inspection.id),
  }));
  const decisions = [...lrepo.listLenderDecisions(draw.id)].reverse();
  const currentDecision = lenderDecisions.currentDecision(draw.id);
  const conditions = currentDecision ? lrepo.listDecisionConditions(currentDecision.id) : [];
  const waivers = lrepo.listLienWaivers(draw.id);
  const funding = lrepo.listFundingRecords(draw.id);
  const caps = lenderAccess.capabilitiesFor(user, draw.projectId);
  const assignedInspector = inspections.some((i) => i.inspection.inspectorUserId === user.id);
  const parties = lrepo.listPartyAssignments(draw.projectId);
  const orgs = new Map<string, import("../../shared/types").Organization>();
  const addOrg = (id: string | null | undefined) => {
    if (id && !orgs.has(id)) {
      const o = repo.getOrganization(id);
      if (o) orgs.set(id, o);
    }
  };
  for (const pa of parties) addOrg(pa.partyOrganizationId);
  for (const w of waivers) addOrg(w.contractorOrSupplierOrganizationId);
  for (const i of inspections) addOrg(i.inspection.inspectionCompanyOrganizationId);
  for (const c of conditions) addOrg(c.responsiblePartyOrganizationId);
  if (loan) {
    for (const id of [
      loan.borrowerOrganizationId, loan.primaryContractorOrganizationId, loan.lenderOrganizationId,
      loan.currentServicerOrganizationId, loan.currentLoanOwnerOrganizationId,
      loan.warehouseLenderOrganizationId, loan.secondaryMarketPurchaserOrganizationId,
    ]) addOrg(id);
    for (const e of lrepo.listLoanOwnershipEvents(loan.id)) { addOrg(e.priorOwnerOrganizationId); addOrg(e.newOwnerOrganizationId); }
    for (const e of lrepo.listLoanServicingEvents(loan.id)) { addOrg(e.priorServicerOrganizationId); addOrg(e.newServicerOrganizationId); }
  }
  return {
    stage,
    stageHistory: drawWorkflow.stageHistory(draw.id),
    packageReports: repo
      .listReports()
      .filter(
        (r) =>
          r.projectId === draw.projectId &&
          r.reportType === "DRAW_VERIFICATION_PACKAGE" &&
          r.filename.includes(`Draw-${draw.drawNumber}-`)
      ),
    nextAction: lenderNextAction(draw, stage, approval, inspections, currentDecision, conditions, waivers, funding),
    loan,
    ownershipHistory: loan ? lrepo.listLoanOwnershipEvents(loan.id) : [],
    servicingHistory: loan ? lrepo.listLoanServicingEvents(loan.id) : [],
    parties,
    jurisdiction: lrepo.getJurisdictionProfile(draw.projectId),
    appliedPolicy: loanProfile.appliedPolicyForDraw(draw.id),
    inspections,
    decisions,
    currentDecision,
    conditions,
    waivers,
    funding,
    paymentStatus: funding.length > 0 ? lenderDecisions.derivedPaymentStatus(draw.id) : null,
    caps: {
      scheduleInspection: caps.has("SCHEDULE_DRAW_INSPECTION"),
      recordFindings: caps.has("RECORD_INSPECTION_FINDINGS") || assignedInspector,
      finalizeReport: caps.has("FINALIZE_INSPECTION_REPORT") || assignedInspector,
      reviewDraw: caps.has("REVIEW_DRAW"),
      lenderDecision: caps.has("RECORD_LENDER_DECISION") && !isSubmitter,
      recordFunding: caps.has("RECORD_EXTERNAL_FUNDING"),
    },
    orgs,
    notice,
  };
}

/** One deterministic next action, mapped from the derived stage and the
 *  stored lender records. Presentation only — it never computes a second
 *  workflow, never authorizes anything, and never invents state. */
function lenderNextAction(
  draw: import("../../shared/types").DrawRequest,
  stage: import("../../shared/types").DrawWorkflowStage | null,
  approval: import("../../shared/types").ApprovalRequest | null,
  inspections: LenderTabData["inspections"],
  decision: import("../../shared/types").LenderDrawDecision | null,
  conditions: import("../../shared/types").LenderDecisionCondition[],
  waivers: import("../../shared/types").LienWaiverRecord[],
  funding: import("../../shared/types").ExternalFundingRecord[]
): { title: string; detail: string } {
  const latest = inspections.length > 0 ? inspections[inspections.length - 1] : null;
  const draftVersion = latest?.versions.find((v) => v.status === "DRAFT") ?? null;
  const blockingConds = conditions.filter((c) => !["SATISFIED", "WAIVED"].includes(c.status));
  const outstandingWaivers = waivers.filter((w) =>
    ["REQUIRED", "REQUESTED", "RECEIVED", "UNDER_REVIEW", "REJECTED", "EXPIRED"].includes(w.status)
  );
  if (!stage) return { title: "Draft not submitted", detail: "The lender workflow begins at submission." };
  switch (stage) {
    case "DRAW_CLOSED":
      return { title: "Draw closed", detail: "The verification package remains available below." };
    case "FUNDS_DISBURSED":
      return { title: "Verification package ready", detail: "External funding is recorded; download the complete package below." };
    case "FUNDS_SCHEDULED":
      return { title: "Record or reconcile external funding", detail: "A funding record is in flight — record the disbursement outcome when the lender's own systems complete it." };
    case "LIEN_RELEASE_REQUESTED":
      return { title: "Accept required lien waivers", detail: "Waivers are in review; acceptance is an explicit reviewed act." };
    case "LIEN_RELEASE_COMPLETED":
      return { title: "Record or reconcile external funding", detail: "Waivers are settled; external funding is the remaining administrative record." };
    case "REJECTED":
      return { title: "Decision recorded: rejected", detail: "Record an amendment only if formal governance later changes." };
    case "APPROVED":
    case "REDUCED":
    case "CONDITIONALLY_APPROVED":
      if (blockingConds.length > 0) {
        return { title: "Resolve decision conditions", detail: `${blockingConds.length} condition(s) must be satisfied or formally waived before funding.` };
      }
      if (outstandingWaivers.length > 0) {
        return { title: "Accept required lien waivers", detail: `${outstandingWaivers.length} waiver(s) are not yet accepted.` };
      }
      return { title: "Record or reconcile external funding", detail: "The decision is fundable; external funding records are administrative only." };
    case "LENDER_REVIEW_IN_PROGRESS":
      return approval && approval.status === "APPROVED"
        ? { title: "Record lender decision", detail: "Formal governance is complete; the lender business decision is outstanding." }
        : { title: "Await formal governance", detail: "Role decisions are being recorded through the formal approval matrix." };
    case "ELIGIBLE_FOR_LENDER_REVIEW":
      return { title: "Await formal governance", detail: "Governance is ready; no role decisions are recorded yet. Eligibility is never automatic approval." };
    case "CORRECTIONS_REQUESTED":
      if (latest?.inspection.status === "CORRECTION_REQUIRED") {
        return { title: "Prepare corrected inspection report", detail: "OBV review flagged the report; create and finalize a correction version." };
      }
      if (latest?.inspection.status === "REINSPECTION_REQUIRED") {
        return { title: "Schedule reinspection", detail: "The reinspection record is open; schedule the site visit." };
      }
      return { title: "Awaiting requester corrections", detail: "The draw was returned to the requester." };
    case "MISSING_INFORMATION_REQUESTED":
      return { title: "Awaiting requester clarification", detail: "A clarification question is open with the requester." };
    case "EXCEPTIONS_IDENTIFIED":
      return { title: "Resolve open draw exceptions", detail: "Open exceptions on this draw block the review pipeline." };
    case "INSPECTION_REQUESTED":
      return latest?.inspection.status === "ACCESS_FAILED"
        ? { title: "Reschedule after property-access failure", detail: "The recorded access failure needs a new scheduled visit (or a failed-inspection outcome)." }
        : { title: "Schedule independent inspection", detail: "The ordered inspection has no scheduled site visit yet." };
    case "INSPECTION_SCHEDULED":
      return { title: "Complete site visit", detail: "Record completion — or record a property-access failure if the visit could not proceed." };
    case "PHYSICAL_INSPECTION_COMPLETED":
      if (draftVersion) return { title: "Finalize inspection report", detail: "A draft report version exists; finalized versions are immutable." };
      if (latest && ["COMPLETED", "REPORT_PENDING"].includes(latest.inspection.status)) {
        return { title: "Add inspection line findings", detail: "Record what the inspector observed by line, then prepare the written report." };
      }
      return { title: "Record OBV review", detail: "The report is under OBV completeness review." };
    default: {
      if (latest && latest.inspection.status === "FINALIZED" && latest.inspection.lenderAcceptanceStatus === "PENDING") {
        return { title: "Record lender acceptance or request reinspection", detail: "The finalized inspection report awaits the lender's own acceptance decision." };
      }
      if (inspections.length === 0) {
        return { title: "Schedule independent inspection", detail: "No independent draw inspection has been ordered for this draw." };
      }
      return { title: "Continue OBV review", detail: "Documents, government inspections and evidence are reviewed in sequence before governance." };
    }
  }
}

async function assembleDrawReportData(
  draw: import("../../shared/types").DrawRequest,
  user: User
): Promise<import("../view/drawPages").DrawReportData> {
  const project = repo.getProject(draw.projectId)!;
  const chain = await wormEvidenceStore.verifyChain();
  const approval = repo.getApprovalRequestForDraw(draw.id);
  return {
    draw,
    project,
    lenderOrg: repo.getOrganization(draw.organizationId),
    borrowerOrg: draw.requestedByOrganizationId ? repo.getOrganization(draw.requestedByOrganizationId) : null,
    lines: repo.listDrawLines(draw.id),
    milestones: repo.listMilestones(project.id),
    checklist: draws.documentChecklist(draw.id),
    evidenceRows: drawEvidenceRows(draw.id),
    recommendation: draws.computeRecommendation(draw.id),
    approval,
    approvalRecords: approval ? repo.listApprovalRecordsForRequest(approval.id) : [],
    accountEvents: repo.listDrawAccountEvents(draw.id),
    users: usersById(),
    financialProgress: budget.assessFinancialProgress(project.id),
    physicalProgress: budget.assessPhysicalProgress(project.id),
    lineComparisons: new Map(
      repo.listDrawLines(draw.id).map((l) => [l.id, budget.compareDrawLine(project.id, l)])
    ),
    contract: drawContractContext(project.id),
    retainage: drawRetainageContext(draw),
    milestoneGateSummaries: (() => {
      const out = new Map<string, string>();
      for (const l of repo.listDrawLines(draw.id)) {
        if (l.milestoneId && !out.has(l.milestoneId)) {
          out.set(l.milestoneId, completionGates.gateSummaryLabel(completionGates.milestoneGates(l.milestoneId)));
        }
      }
      return out;
    })(),
    drawChangeOrders: (() => {
      const byCo = new Map<string, { number: number; title: string; status: string; amount: number }>();
      for (const l of repo.listDrawLines(draw.id)) {
        if (!l.changeOrderId) continue;
        const co = repo.getChangeOrder(l.changeOrderId);
        if (!co) continue;
        const cur = byCo.get(co.id) ?? { number: co.changeOrderNumber, title: co.title, status: co.status, amount: 0 };
        cur.amount += l.currentRequested;
        byCo.set(co.id, cur);
      }
      return [...byCo.values()];
    })(),
    generatedAt: new Date().toISOString(),
    generatedBy: user,
    ledger: { valid: chain.valid, entries: chain.entries, brokenAt: chain.brokenAt },
    funderReports: repo
      .listReports()
      .filter((r) => r.projectId === project.id && r.reportType === "VERIFICATION_FUND_RELEASE"),
  };
}

/** Generate and store the Draw Review Summary PDF (mirrors the funder
 *  report pipeline; degrades to the HTML preview when Chromium is
 *  unavailable). */
async function generateDrawReport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  user: User,
  drawId: string
): Promise<void> {
  const draw = repo.getDrawRequest(drawId);
  if (!draw || !draws.canAccessDraw(user, draw)) {
    sendJson(res, { error: "Draw request not found" }, 404);
    return;
  }
  const data = await assembleDrawReportData(draw, user);
  const report: Report = {
    id: repo.newId(),
    projectId: draw.projectId,
    reportType: "DRAW_REVIEW_SUMMARY",
    filename: `OBV-Draw-${draw.drawNumber}-Review-Summary-${data.generatedAt.slice(0, 10)}.pdf`,
    generatedAt: data.generatedAt,
    generatedBy: user.id,
    integrityStatus: data.ledger.valid ? "INTACT" : `TAMPERED_AT:${data.ledger.brokenAt}`,
    ledgerEntries: data.ledger.entries,
  };
  pendingReportHtml.set(report.id, renderDrawReport(data));
  try {
    const outDir = path.join(REPORTS_DIR, report.id);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, report.filename);
    const config = Buffer.from(
      JSON.stringify({
        url: `http://127.0.0.1:${PORT}/report-cache/${report.id}?token=${previewToken}`,
        outPath,
        projectName: `Draw #${draw.drawNumber} — ${data.project.name}`,
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
      "DRAW_REPORT_GENERATED",
      `Draw Review Summary generated for Draw #${draw.drawNumber} by ${user.name} (ledger: ${report.integrityStatus}).`,
      { projectId: draw.projectId }
    );
    if (isFormPost(req)) {
      redirect(res, `/reports/file/${report.id}`);
    } else {
      sendJson(res, { report }, 201);
    }
  } catch (err) {
    console.error("[draw-report] PDF generation failed:", (err as Error).message);
    if (isFormPost(req)) {
      redirect(res, `/draw/${draw.id}?tab=governance&reportError=1`);
    } else {
      sendJson(
        res,
        { error: "PDF generation failed — the printable HTML preview remains available at /draw/:id/report" },
        500
      );
    }
  } finally {
    pendingReportHtml.delete(report.id);
  }
}

/** Generate and store the Lender Draw Verification Package (ZIP with the
 *  lender PDF + structured CSV/JSON registers + hashed manifest). Stored
 *  in the report registry; generation is role- and tenant-gated by the
 *  drawPackage service and audited via the report record itself. */
async function generateDrawVerificationPackage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  user: User,
  drawId: string
): Promise<void> {
  const data = await drawPackage.assembleDrawPackageData(user, drawId); // throws 404/403
  const registers = drawPackage.buildDrawPackageFiles(data);
  const html = renderDrawVerificationDoc(data);
  let pdf: Buffer | null = null;
  if (pdfRendererAvailable()) {
    const key = `draw-pkg-${randomUUID()}`;
    const outPath = path.join(REPORTS_DIR, `${key}.pdf`);
    pendingReportHtml.set(key, html);
    try {
      fs.mkdirSync(REPORTS_DIR, { recursive: true });
      const config = Buffer.from(
        JSON.stringify({
          url: `http://127.0.0.1:${PORT}/report-cache/${key}?token=${previewToken}`,
          outPath,
          projectName: `Draw #${data.draw.drawNumber} — ${data.project.name}`,
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
      pdf = fs.existsSync(outPath) ? fs.readFileSync(outPath) : null;
    } catch (err) {
      console.error("[draw-package] PDF render failed:", (err as Error).message);
      pdf = null; // honest fallback: printable HTML ships in the ZIP
    } finally {
      pendingReportHtml.delete(key);
      try {
        fs.unlinkSync(path.join(REPORTS_DIR, `${key}.pdf`));
      } catch {
        /* not created */
      }
    }
  }
  const { zip } = drawPackage.buildStandaloneDrawZip(data, registers, pdf, html);
  const report: Report = {
    id: repo.newId(),
    projectId: data.project.id,
    reportType: "DRAW_VERIFICATION_PACKAGE",
    filename: `OBV-Draw-${data.draw.drawNumber}-Verification-Package-${data.generatedAt.slice(0, 10)}.zip`,
    generatedAt: data.generatedAt,
    generatedBy: user.id,
    integrityStatus: data.ledger.valid ? "INTACT" : `TAMPERED_AT:${data.ledger.brokenAt}`,
    ledgerEntries: data.ledger.entries,
  };
  const outDir = path.join(REPORTS_DIR, report.id);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, report.filename), zip, { flag: "wx" });
  repo.insertReport(report);
  await teamsNotifier.notify(
    "DRAW_REPORT_GENERATED",
    `Lender Draw Verification Package generated for Draw #${data.draw.drawNumber} by ${user.name} (ledger: ${report.integrityStatus}).`,
    { projectId: data.project.id }
  );
  if (isFormPost(req)) {
    redirect(res, `/reports/file/${report.id}?dl=1`);
  } else {
    sendJson(res, { report }, 201);
  }
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
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#F7F8FA;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0d1626">
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
              (SELECT COUNT(*) FROM evidence_drafts) AS ed,
              (SELECT COUNT(*) FROM draw_requests) AS dr,
              (SELECT COALESCE(MAX(updated_at), '') FROM draw_requests) AS dru,
              (SELECT COUNT(*) FROM draw_line_items) AS drl,
              (SELECT COUNT(*) FROM draw_documents) AS drd,
              (SELECT COUNT(*) FROM draw_evidence_links) AS drel,
              (SELECT COUNT(*) FROM draw_events) AS drev,
              (SELECT COUNT(*) FROM budget_lines) AS bl,
              (SELECT COALESCE(MAX(updated_at), '') FROM budget_lines) AS blu,
              (SELECT COUNT(*) FROM budget_line_maps) AS blm,
              (SELECT COUNT(*) FROM verified_quantities) AS vq,
              (SELECT COUNT(*) FROM exceptions) AS exc,
              (SELECT COALESCE(MAX(updated_at), '') FROM exceptions) AS excu,
              (SELECT COUNT(*) FROM change_orders) AS co,
              (SELECT COALESCE(MAX(updated_at), '') FROM change_orders) AS cou,
              (SELECT COUNT(*) FROM retainage_events) AS re,
              (SELECT COUNT(*) FROM retainage_release_requests) AS rrr,
              (SELECT COALESCE(MAX(updated_at), '') FROM retainage_release_requests) AS rrru,
              (SELECT COUNT(*) FROM audit_packages) AS ap,
              (SELECT COALESCE(MAX(completed_at), '') FROM audit_packages) AS apu,
              (SELECT COUNT(*) FROM jurisdictional_inspections) AS ji,
              (SELECT COALESCE(MAX(updated_at), '') FROM jurisdictional_inspections) AS jiu,
              (SELECT COUNT(*) FROM inspection_requirements) AS ir,
              (SELECT COALESCE(MAX(updated_at), '') FROM inspection_requirements) AS iru,
              (SELECT COUNT(*) FROM milestones WHERE contractor_completion_status != 'NOT_REPORTED') AS ccm`
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
        // Deployed commit (Render injects RENDER_GIT_COMMIT) so the live
        // version is verifiable from the outside. Short hash only.
        version: (process.env.RENDER_GIT_COMMIT ?? process.env.OBV_GIT_COMMIT ?? "").slice(0, 7) || "unknown",
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
    const form = isFormPost(req) ? new URLSearchParams(body) : null;
    const decision = form ? form.get("decision") : JSON.parse(body || "{}").decision;
    if (decision !== "APPROVED" && decision !== "REJECTED") {
      sendJson(res, { error: "decision must be APPROVED or REJECTED" }, 400);
      return;
    }
    // Same governance endpoint, two subjects: MILESTONE requests release
    // milestone tranches; DRAW requests run the draw governance gate.
    // Both use ApprovalRecords, matrices and separation of duties.
    const subject = repo.getApprovalRequest(approvalMatch[1]);
    const subjectType = subject?.subjectType ?? "MILESTONE";
    const result =
      subjectType === "DRAW"
        ? await draws.processDrawApprovalDecision(approvalMatch[1], user.id, decision)
        : subjectType === "CHANGE_ORDER"
          ? await changeOrders.processChangeOrderApprovalDecision(approvalMatch[1], user.id, decision)
          : subjectType === "RETAINAGE"
            ? await retainage.processRetainageApprovalDecision(approvalMatch[1], user.id, decision)
            : await processApprovalDecision(approvalMatch[1], user.id, decision);
    if (form) {
      const back = form.get("redirect") ?? "";
      redirect(res, back.startsWith("/") && !back.startsWith("//") ? back : "/approvals");
    } else {
      sendJson(res, result);
    }
    return;
  }

  // ============================== change orders + retainage ============
  // Governance-controlled records. No route below can directly edit a
  // change-order state or release retainage — transitions run through the
  // services, and approvals through the shared governed endpoint.

  const coParams = async (): Promise<Record<string, string>> => {
    const text = (await readBody(req, 128 * 1024)).toString("utf8");
    if (isFormPost(req)) return Object.fromEntries(new URLSearchParams(text));
    return text ? JSON.parse(text) : {};
  };

  if (method === "POST" && pathname === "/api/change-orders") {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const p = await coParams();
    const co = changeOrders.createChangeOrder(user, {
      projectId: String(p.projectId ?? ""),
      title: String(p.title ?? ""),
      description: p.description ? String(p.description) : "",
      reasonCategory: (p.reasonCategory ? String(p.reasonCategory) : "OTHER") as never,
      requestedAmount: p.requestedAmount !== undefined && p.requestedAmount !== "" ? Number(p.requestedAmount) : 0,
      scheduleImpactDays: p.scheduleImpactDays !== undefined && p.scheduleImpactDays !== "" ? Number(p.scheduleImpactDays) : null,
      affectedMilestoneIds: p.milestoneId ? [String(p.milestoneId)] : Array.isArray(p.affectedMilestoneIds) ? p.affectedMilestoneIds : [],
    });
    if (isFormPost(req)) {
      redirect(res, `/change-order/${co.id}`);
    } else {
      sendJson(res, { changeOrder: co }, 201);
    }
    return;
  }

  const coActionMatch = /^\/api\/change-orders\/([^/]+)\/(allocations|documents|submit|clarification|governance|implemented|cancel)$/.exec(pathname);
  if (method === "POST" && coActionMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const [, coId, action] = coActionMatch;
    const p = await coParams();
    let body: unknown;
    switch (action) {
      case "allocations":
        body = { allocation: changeOrders.allocate(user, coId, {
          budgetLineId: String(p.budgetLineId ?? ""),
          amount: Number(p.amount),
          note: p.note ? String(p.note) : null,
        }) };
        break;
      case "documents":
        changeOrders.addDocument(user, coId, {
          title: String(p.title ?? ""),
          docType: p.docType ? String(p.docType) : undefined,
          note: p.note ? String(p.note) : null,
        });
        body = { ok: true };
        break;
      case "submit":
        body = { changeOrder: changeOrders.submitChangeOrder(user, coId) };
        break;
      case "clarification":
        body = { changeOrder: changeOrders.requestClarification(user, coId, String(p.question ?? "")) };
        break;
      case "governance":
        body = changeOrders.sendToGovernance(
          user, coId,
          p.approvedAmount !== undefined && p.approvedAmount !== "" ? Number(p.approvedAmount) : null
        );
        break;
      case "implemented":
        body = { changeOrder: changeOrders.markImplemented(user, coId, p.note ? String(p.note) : null) };
        break;
      default:
        body = { changeOrder: changeOrders.cancelChangeOrder(user, coId) };
    }
    if (isFormPost(req)) {
      redirect(res, `/change-order/${coId}`);
    } else {
      sendJson(res, body);
    }
    return;
  }

  const coPreviewMatch = /^\/api\/change-orders\/([^/]+)\/preview$/.exec(pathname);
  if (method === "GET" && coPreviewMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const co = repo.getChangeOrder(coPreviewMatch[1]);
    const project = co ? repo.getProject(co.projectId) : null;
    if (!co || !project || !budget.canAccessProjectFinance(user, project)) {
      sendJson(res, { error: "Change order not found" }, 404);
      return;
    }
    sendJson(res, changeOrders.impactPreview(co.id));
    return;
  }

  if (method === "POST" && pathname === "/api/retainage/policy") {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const p = await coParams();
    const policy = retainage.setPolicy(user, {
      projectId: String(p.projectId ?? ""),
      retainagePercent: Number(p.retainagePercent),
      requiredConditions: Array.isArray(p.requiredConditions) ? p.requiredConditions : undefined,
    });
    if (isFormPost(req)) {
      redirect(res, `/project/${policy.projectId}/budget`);
    } else {
      sendJson(res, { policy });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/retainage/releases") {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const p = await coParams();
    const release = retainage.createReleaseRequest(user, {
      projectId: String(p.projectId ?? ""),
      amount: p.amount !== undefined && p.amount !== "" ? Number(p.amount) : undefined,
      note: p.note ? String(p.note) : null,
    });
    if (isFormPost(req)) {
      redirect(res, `/project/${release.projectId}/budget`);
    } else {
      sendJson(res, { release }, 201);
    }
    return;
  }

  const retActionMatch = /^\/api\/retainage\/releases\/([^/]+)\/(condition|governance)$/.exec(pathname);
  if (method === "POST" && retActionMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const [, relId, action] = retActionMatch;
    const p = await coParams();
    let body: unknown;
    if (action === "condition") {
      body = {
        conditions: retainage.satisfyCondition(
          user, relId, String(p.condition ?? "") as never, String(p.note ?? "")
        ),
      };
    } else {
      body = retainage.sendReleaseToGovernance(user, relId);
    }
    const projectId = repo.getRetainageRelease(relId)?.projectId ?? "";
    if (isFormPost(req)) {
      redirect(res, `/project/${projectId}/budget`);
    } else {
      sendJson(res, body);
    }
    return;
  }

  // ======================================= unified exceptions ==========
  // Control records referencing authoritative sources. No route below can
  // verify evidence, approve anything, or move HELD/RELEASED state.

  if (method === "POST" && pathname === "/api/exceptions/evaluate") {
    if (!currentUser(req)) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    sendJson(res, await exceptions.evaluateExceptions());
    return;
  }

  if (method === "POST" && pathname === "/api/exceptions") {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const text = (await readBody(req, 128 * 1024)).toString("utf8");
    const p = isFormPost(req)
      ? (Object.fromEntries(new URLSearchParams(text)) as Record<string, string>)
      : JSON.parse(text || "{}");
    const exception = exceptions.createManualException(user, {
      projectId: String(p.projectId ?? ""),
      milestoneId: p.milestoneId ? String(p.milestoneId) : null,
      drawRequestId: p.drawRequestId ? String(p.drawRequestId) : null,
      category: (p.category ? String(p.category) : "OTHER") as never,
      severity: (p.severity ? String(p.severity) : "MEDIUM") as never,
      title: String(p.title ?? ""),
      description: p.description ? String(p.description) : "",
      ownerUserId: p.ownerUserId ? String(p.ownerUserId) : null,
      dueAt: p.dueAt ? String(p.dueAt) : null,
    });
    if (isFormPost(req)) {
      redirect(res, `/exception/${exception.id}`);
    } else {
      sendJson(res, { exception }, 201);
    }
    return;
  }

  const excActionMatch = /^\/api\/exceptions\/([^/]+)\/(acknowledge|assign|start|request-response|resolve|close|waive|comment|reference)$/.exec(pathname);
  if (method === "POST" && excActionMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const [, excId, action] = excActionMatch;
    const text = (await readBody(req, 64 * 1024)).toString("utf8");
    const p = isFormPost(req)
      ? (Object.fromEntries(new URLSearchParams(text)) as Record<string, string>)
      : JSON.parse(text || "{}");
    let exception;
    switch (action) {
      case "acknowledge":
        exception = exceptions.acknowledgeException(user, excId);
        break;
      case "assign":
        exception = exceptions.assignException(user, excId, p.ownerUserId ? String(p.ownerUserId) : null);
        break;
      case "start":
        exception = exceptions.startException(user, excId);
        break;
      case "request-response":
        exception = exceptions.requestResponse(user, excId, String(p.note ?? ""));
        break;
      case "resolve":
        exception = await exceptions.resolveException(user, excId, p.summary ? String(p.summary) : null);
        break;
      case "close":
        exception = exceptions.closeException(user, excId);
        break;
      case "waive":
        exception = exceptions.waiveException(user, excId, String(p.reason ?? ""));
        break;
      case "comment":
        exception = exceptions.commentException(user, excId, String(p.note ?? ""));
        break;
      default: {
        exceptions.referenceInThread(user, excId);
        exception = repo.getException(excId)!;
      }
    }
    if (isFormPost(req)) {
      redirect(res, `/exception/${excId}`);
    } else {
      sendJson(res, { exception });
    }
    return;
  }

  // ==================================== budget vs verified progress ====
  // Financial-control records and reviewed quantities. Nothing here can
  // verify evidence, approve anything, or move HELD/RELEASED state.

  if (method === "POST" && pathname === "/api/budget-lines") {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const text = (await readBody(req, 256 * 1024)).toString("utf8");
    const p = isFormPost(req)
      ? (Object.fromEntries(new URLSearchParams(text)) as Record<string, string>)
      : JSON.parse(text || "{}");
    const line = budget.createBudgetLine(user, {
      projectId: String(p.projectId ?? ""),
      code: String(p.code ?? ""),
      category: String(p.category ?? ""),
      description: p.description ? String(p.description) : null,
      originalBudget: p.originalBudget !== undefined && p.originalBudget !== "" ? Number(p.originalBudget) : 0,
      committedAmount: p.committedAmount !== undefined && p.committedAmount !== "" ? Number(p.committedAmount) : null,
      paidToDate: p.paidToDate !== undefined && p.paidToDate !== "" ? Number(p.paidToDate) : 0,
      retainageHeld: p.retainageHeld !== undefined && p.retainageHeld !== "" ? Number(p.retainageHeld) : null,
      milestoneIds: p.milestoneId ? [String(p.milestoneId)] : Array.isArray(p.milestoneIds) ? p.milestoneIds : [],
    });
    if (isFormPost(req)) {
      redirect(res, `/project/${line.projectId}/budget`);
    } else {
      sendJson(res, { line }, 201);
    }
    return;
  }

  if (method === "POST" && pathname === "/api/budget-lines/update") {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const text = (await readBody(req, 256 * 1024)).toString("utf8");
    const p = isFormPost(req)
      ? (Object.fromEntries(new URLSearchParams(text)) as Record<string, string>)
      : JSON.parse(text || "{}");
    const line = budget.updateBudgetLine(user, String(p.budgetLineId ?? ""), {
      description: p.description !== undefined ? String(p.description) : undefined,
      category: p.category !== undefined && p.category !== "" ? String(p.category) : undefined,
      originalBudget: p.originalBudget !== undefined && p.originalBudget !== "" ? Number(p.originalBudget) : undefined,
      approvedChanges: p.approvedChanges !== undefined && p.approvedChanges !== "" ? Number(p.approvedChanges) : undefined,
      committedAmount: p.committedAmount !== undefined && p.committedAmount !== "" ? Number(p.committedAmount) : undefined,
      paidToDate: p.paidToDate !== undefined && p.paidToDate !== "" ? Number(p.paidToDate) : undefined,
      retainageHeld: p.retainageHeld !== undefined && p.retainageHeld !== "" ? Number(p.retainageHeld) : undefined,
      active: p.active !== undefined && p.active !== "" ? p.active === "1" || p.active === "true" || p.active === true : undefined,
      reason: p.reason ? String(p.reason) : null,
    });
    if (p.milestoneId) {
      budget.mapBudgetLine(user, line.id, { milestoneId: String(p.milestoneId) });
    }
    if (isFormPost(req)) {
      redirect(res, `/project/${line.projectId}/budget`);
    } else {
      sendJson(res, { line });
    }
    return;
  }

  if (method === "POST" && pathname === "/api/verified-quantities") {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const text = (await readBody(req, 256 * 1024)).toString("utf8");
    const p = isFormPost(req)
      ? (Object.fromEntries(new URLSearchParams(text)) as Record<string, string>)
      : JSON.parse(text || "{}");
    const evidence = repo.getEvidence(String(p.evidenceItemId ?? ""));
    const record = budget.recordVerifiedQuantity(user, {
      milestoneId: p.milestoneId ? String(p.milestoneId) : evidence?.milestoneId ?? "",
      percent: Number(p.percent),
      quantityLabel: String(p.quantityLabel ?? ""),
      evidenceItemId: String(p.evidenceItemId ?? ""),
      reason: String(p.reason ?? ""),
    });
    if (isFormPost(req)) {
      const m = repo.getMilestone(record.milestoneId);
      redirect(res, `/project/${m?.projectId ?? ""}/budget`);
    } else {
      sendJson(res, { record }, 201);
    }
    return;
  }

  const progressApiMatch = /^\/api\/projects\/([^/]+)\/progress$/.exec(pathname);
  if (method === "GET" && progressApiMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const project = repo.getProject(progressApiMatch[1]);
    if (!project || !budget.canAccessProjectFinance(user, project)) {
      sendJson(res, { error: "Project not found" }, 404);
      return;
    }
    sendJson(res, {
      financial: budget.assessFinancialProgress(project.id),
      physical: budget.assessPhysicalProgress(project.id),
      register: budget.budgetLineRegister(project.id),
    });
    return;
  }

  // ============================================================ draws
  // Construction Draw Request workflow. Every route below is either an
  // administrative record (draft, lines, documents, evidence links) or an
  // advisory action (review, recommendation). None of them can release
  // funds — the only financial transition is the DRAW-subject approval
  // decision handled by the shared /api/approvals/:id/decision route.

  const readParams = async (): Promise<Record<string, string>> => {
    const text = (await readBody(req, 256 * 1024)).toString("utf8");
    if (isFormPost(req)) return Object.fromEntries(new URLSearchParams(text));
    return text ? JSON.parse(text) : {};
  };
  const finishDrawPost = (drawId: string, tab: DrawTab, json: unknown, status = 200): void => {
    // Derived-stage observation: every draw mutation funnels through here.
    try { drawWorkflow.syncDrawStage(drawId, currentUser(req)); } catch { /* stage log must never break the action */ }
    if (isFormPost(req)) {
      redirect(res, `/draw/${drawId}?tab=${tab}`);
    } else {
      sendJson(res, json, status);
    }
  };
  const drawUser = (): User | null => currentUser(req);

  // ===================== lender operating layer (API) =====================
  // Administrative lender records. All mutations sync the derived draw
  // stage; GET handlers never mutate. LenderError maps 400/403/404/409/413/422.

  const lenderUser = (): User => {
    const u = currentUser(req);
    if (!u) throw new LenderError("Select a demo user first", 401);
    return u;
  };
  const loanApi = /^\/api\/projects\/([^/]+)\/(loan|parties|jurisdiction|memberships|lender-policy)$/.exec(pathname);
  if (loanApi) {
    const user = lenderUser();
    const projectId = loanApi[1];
    const section = loanApi[2];
    const body = method === "POST" ? await readParams() : {};
    if (section === "loan") {
      if (method === "POST") {
        const loan = loanProfile.createLoanAsset(user, { ...(body as object), projectId } as never);
        sendJson(res, { loan }, 201);
        return;
      }
      if (method === "GET") {
        const project = lenderAccess.assertProjectAccess(user, projectId);
        const loan = lrepo.getLoanAssetForProject(projectId);
        if (!loan) {
          sendJson(res, { loan: null, state: "NOT RECORDED" });
          return;
        }
        sendJson(res, {
          loan,
          ownershipHistory: lrepo.listLoanOwnershipEvents(loan.id),
          servicingHistory: lrepo.listLoanServicingEvents(loan.id),
          reconciliation: loanProfile.reconcileLoanBudget(loan, project),
        });
        return;
      }
    }
    if (section === "parties") {
      if (method === "POST") {
        const party = loanProfile.assignParty(user, { ...(body as object), projectId } as never);
        sendJson(res, { party }, 201);
        return;
      }
      if (method === "GET") {
        lenderAccess.assertProjectAccess(user, projectId);
        sendJson(res, { parties: lrepo.listPartyAssignments(projectId) });
        return;
      }
    }
    if (section === "jurisdiction") {
      if (method === "POST") {
        const profile = loanProfile.configureJurisdiction(user, { ...(body as object), projectId } as never);
        sendJson(res, { profile }, 201);
        return;
      }
      if (method === "GET") {
        lenderAccess.assertProjectAccess(user, projectId);
        const profile = lrepo.getJurisdictionProfile(projectId);
        sendJson(res, profile ? { profile } : { profile: null, state: "NOT RECORDED" });
        return;
      }
    }
    if (section === "memberships") {
      if (method === "POST") {
        const membership = lenderAccess.assignMembership(user, { ...(body as object), projectId } as never);
        sendJson(res, { membership }, 201);
        return;
      }
      if (method === "GET") {
        lenderAccess.assertProjectAccess(user, projectId);
        sendJson(res, {
          memberships: lrepo.listMemberships(projectId),
          capabilities: [...lenderAccess.capabilitiesFor(user, projectId)],
        });
        return;
      }
    }
    if (section === "lender-policy") {
      if (method === "POST") {
        const policy = loanProfile.configureLenderPolicy(user, { ...(body as object), projectId } as never);
        sendJson(res, { policy }, 201);
        return;
      }
      if (method === "GET") {
        lenderAccess.assertProjectAccess(user, projectId);
        const policy = loanProfile.policyForDraw(projectId);
        sendJson(res, policy ? { policy } : { policy: null, state: "NOT RECORDED" });
        return;
      }
    }
    sendJson(res, { error: "Unsupported method" }, 405);
    return;
  }

  if (method === "POST" && pathname === "/api/lender-policy") {
    const user = lenderUser();
    const body = await readParams();
    const policy = loanProfile.configureLenderPolicy(user, { ...(body as object), projectId: null } as never);
    sendJson(res, { policy }, 201);
    return;
  }

  const loanActionApi = /^\/api\/loans\/([^/]+)(?:\/(.+))?$/.exec(pathname);
  if (loanActionApi && method === "POST") {
    const user = lenderUser();
    const loanId = loanActionApi[1];
    const action = loanActionApi[2];
    const body = await readParams();
    if (!action) {
      const loan = loanProfile.updateLoanAsset(user, loanId, body as never);
      sendJson(res, { loan });
      return;
    }
    if (action === "ownership-transfer") {
      const event = loanProfile.recordOwnershipTransfer(user, loanId, body as never);
      sendJson(res, { event }, 201);
      return;
    }
    if (action === "servicing-transfer") {
      const event = loanProfile.recordServicingTransfer(user, loanId, body as never);
      sendJson(res, { event }, 201);
      return;
    }
    sendJson(res, { error: `Unknown loan action: ${action}` }, 404);
    return;
  }

  if (method === "POST" && /^\/api\/parties\/[^/]+\/end$/.test(pathname)) {
    const user = lenderUser();
    const partyId = pathname.split("/")[3];
    const body = (await readParams()) as { projectId?: string };
    loanProfile.endParty(user, String(body.projectId ?? ""), partyId);
    sendJson(res, { ok: true });
    return;
  }

  if (method === "POST" && /^\/api\/memberships\/[^/]+\/end$/.test(pathname)) {
    const user = lenderUser();
    const membershipId = pathname.split("/")[3];
    const body = (await readParams()) as { projectId?: string };
    lenderAccess.endMembership(user, String(body.projectId ?? ""), membershipId);
    sendJson(res, { ok: true });
    return;
  }

  // ---- draw-scoped lender records ----
  const drawLenderApi = /^\/api\/draws\/([^/]+)\/(inspections|lender-decision|lien-waivers|funding|stage)$/.exec(pathname);
  if (drawLenderApi) {
    const user = lenderUser();
    const drawId = drawLenderApi[1];
    const section = drawLenderApi[2];
    const body = method === "POST" ? await readParams() : {};
    const draw = repo.getDrawRequest(drawId);
    // Access is the legacy draw-tenant check EXTENDED by explicit project
    // membership: an active membership grants lender-endpoint access even
    // for users outside the pilot org wiring. Users with neither still get
    // the same 404 as a nonexistent draw (existence is not disclosed).
    if (
      !draw ||
      (!draws.canAccessDraw(user, draw) && !lenderAccess.hasActiveMembership(user, draw.projectId))
    ) {
      sendJson(res, { error: "Draw request not found" }, 404);
      return;
    }
    if (section === "inspections") {
      if (method === "POST") {
        const inspection = drawInspections.requestInspection(user, { ...(body as object), drawRequestId: drawId } as never);
        drawWorkflow.syncDrawStage(drawId, user, "Independent inspection requested", inspection.id);
        sendJson(res, { inspection }, 201);
        return;
      }
      sendJson(res, { inspections: lrepo.listDrawInspections(drawId) });
      return;
    }
    if (section === "lender-decision") {
      if (method === "POST") {
        const decision = lenderDecisions.recordLenderDecision(user, { ...(body as object), drawRequestId: drawId } as never);
        drawWorkflow.syncDrawStage(drawId, user, `Lender decision ${decision.decision}`, decision.id);
        sendJson(res, { decision, conditions: lrepo.listDecisionConditions(decision.id) }, 201);
        return;
      }
      const decision = lenderDecisions.currentDecision(drawId);
      sendJson(res, decision
        ? {
            decision,
            conditions: lrepo.listDecisionConditions(decision.id),
            history: lrepo.listLenderDecisions(drawId),
            // Funded state is DERIVED from external funding records — the
            // decision row itself is never rewritten to FUNDED.
            paymentStatus: lenderDecisions.derivedPaymentStatus(drawId),
          }
        : { decision: null, state: "NOT RECORDED" });
      return;
    }
    if (section === "lien-waivers") {
      if (method === "POST") {
        const waiver = lenderDecisions.createLienWaiver(user, { ...(body as object), drawRequestId: drawId } as never);
        drawWorkflow.syncDrawStage(drawId, user, "Lien waiver required", waiver.id);
        sendJson(res, { waiver }, 201);
        return;
      }
      sendJson(res, { waivers: lrepo.listLienWaivers(drawId) });
      return;
    }
    if (section === "funding") {
      if (method === "POST") {
        const funding = lenderDecisions.scheduleFunding(user, { ...(body as object), drawRequestId: drawId } as never);
        drawWorkflow.syncDrawStage(drawId, user, "External funding scheduled", funding.id);
        sendJson(res, { funding }, 201);
        return;
      }
      sendJson(res, { funding: lrepo.listFundingRecords(drawId) });
      return;
    }
    if (section === "stage") {
      // Read-only: derives without writing.
      sendJson(res, {
        stage: drawWorkflow.deriveDrawStage(drawId),
        history: drawWorkflow.stageHistory(drawId),
      });
      return;
    }
  }

  const inspectionApi = /^\/api\/draw-inspections\/([^/]+)(?:\/(.+))?$/.exec(pathname);
  if (inspectionApi) {
    const user = lenderUser();
    const inspectionId = inspectionApi[1];
    const action = inspectionApi[2];
    const body = method === "POST" ? (await readParams()) as Record<string, unknown> : {};
    if (method === "GET" && !action) {
      sendJson(res, drawInspections.inspectionDetail(user, inspectionId));
      return;
    }
    if (method !== "POST") {
      sendJson(res, { error: "Unsupported method" }, 405);
      return;
    }
    const sync = (detail: string) => {
      const insp = lrepo.getDrawInspection(inspectionId);
      if (insp) drawWorkflow.syncDrawStage(insp.drawRequestId, user, detail, inspectionId);
    };
    if (action === "schedule") {
      const inspection = drawInspections.scheduleInspection(user, inspectionId, body as never);
      sync("Inspection scheduled");
      sendJson(res, { inspection });
      return;
    }
    if (action === "access-failed") {
      const inspection = drawInspections.recordAccessFailure(user, inspectionId, String(body.note ?? ""));
      sync("Property access failed");
      sendJson(res, { inspection });
      return;
    }
    if (action === "complete") {
      const inspection = drawInspections.completeInspection(user, inspectionId, body.completedAt as never);
      sync("Site visit completed");
      sendJson(res, { inspection });
      return;
    }
    if (action === "lines") {
      const line = drawInspections.recordLineFinding(user, inspectionId, body as never);
      sendJson(res, { line }, 201);
      return;
    }
    if (action === "report") {
      const version = drawInspections.createReportDraft(user, inspectionId, body as never);
      sync("Inspection report received");
      sendJson(res, { version }, 201);
      return;
    }
    if (action === "obv-review") {
      const inspection = drawInspections.recordObvReview(user, inspectionId, body as never);
      sync("OBV review recorded");
      sendJson(res, { inspection });
      return;
    }
    if (action === "accept") {
      const inspection = drawInspections.recordLenderAcceptance(
        user, inspectionId, body.accepted !== false && body.accepted !== "false", body.note as never
      );
      sync("Lender acceptance recorded");
      sendJson(res, { inspection });
      return;
    }
    if (action === "reinspection") {
      const inspection = drawInspections.requestReinspection(user, inspectionId, String(body.reason ?? ""));
      sync("Reinspection requested");
      sendJson(res, { inspection }, 201);
      return;
    }
    if (action === "cancel") {
      const inspection = drawInspections.cancelInspection(user, inspectionId, body.reason as never);
      sync("Inspection cancelled");
      sendJson(res, { inspection });
      return;
    }
    sendJson(res, { error: `Unknown inspection action: ${action}` }, 404);
    return;
  }

  const reportVersionApi = /^\/api\/inspection-reports\/([^/]+)(?:\/(finalize))?$/.exec(pathname);
  if (reportVersionApi && method === "POST") {
    const user = lenderUser();
    const versionId = reportVersionApi[1];
    const body = (await readParams()) as Record<string, unknown>;
    if (reportVersionApi[2] === "finalize") {
      const version = drawInspections.finalizeReport(user, versionId);
      const insp = lrepo.getDrawInspection(version.drawInspectionId);
      if (insp) drawWorkflow.syncDrawStage(insp.drawRequestId, user, "Inspection report finalized", version.id);
      sendJson(res, { version });
      return;
    }
    const version = drawInspections.updateReportDraft(user, versionId, body as never);
    sendJson(res, { version });
    return;
  }

  if (method === "POST" && /^\/api\/decision-conditions\/[^/]+$/.test(pathname)) {
    const user = lenderUser();
    const conditionId = pathname.split("/")[3];
    const body = await readParams();
    const condition = lenderDecisions.updateCondition(user, conditionId, body as never);
    const decision = lrepo.getLenderDecision(condition.lenderDecisionId);
    if (decision) drawWorkflow.syncDrawStage(decision.drawRequestId, user, `Condition ${condition.status}`, condition.id);
    sendJson(res, { condition });
    return;
  }

  if (method === "POST" && /^\/api\/lien-waivers\/[^/]+$/.test(pathname)) {
    const user = lenderUser();
    const waiverId = pathname.split("/")[3];
    const body = await readParams();
    const waiver = lenderDecisions.transitionLienWaiver(user, waiverId, body as never);
    drawWorkflow.syncDrawStage(waiver.drawRequestId, user, `Lien waiver ${waiver.status}`, waiver.id);
    sendJson(res, { waiver });
    return;
  }

  if (method === "POST" && /^\/api\/funding\/[^/]+$/.test(pathname)) {
    const user = lenderUser();
    const fundingId = pathname.split("/")[3];
    const body = await readParams();
    const funding = lenderDecisions.transitionFunding(user, fundingId, body as never);
    drawWorkflow.syncDrawStage(funding.drawRequestId, user, `External funding ${funding.status}`, funding.id);
    sendJson(res, { funding });
    return;
  }


  if (method === "POST" && pathname === "/api/draws") {
    const user = drawUser();
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const p = await readParams();
    const draw = draws.createDraw(user, {
      projectId: String(p.projectId ?? ""),
      drawNumber: p.drawNumber ? Number(p.drawNumber) : undefined,
      requestedAmount: p.requestedAmount !== undefined ? Number(p.requestedAmount) : 0,
      currency: p.currency ? String(p.currency) : undefined,
      periodStart: p.periodStart ? String(p.periodStart) : null,
      periodEnd: p.periodEnd ? String(p.periodEnd) : null,
    });
    if (isFormPost(req)) {
      redirect(res, `/draw/${draw.id}?tab=lines`);
    } else {
      sendJson(res, { draw }, 201);
    }
    return;
  }

  const drawApiMatch = /^\/api\/draws\/([^/]+)(?:\/(.+))?$/.exec(pathname);
  if (method === "POST" && drawApiMatch) {
    const user = drawUser();
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const drawId = drawApiMatch[1];
    const action = drawApiMatch[2] ?? "";
    const p = await readParams();

    if (action === "update") {
      const draw = draws.updateDraft(user, drawId, {
        requestedAmount: p.requestedAmount !== undefined && p.requestedAmount !== "" ? Number(p.requestedAmount) : undefined,
        periodStart: p.periodStart !== undefined ? String(p.periodStart) || null : undefined,
        periodEnd: p.periodEnd !== undefined ? String(p.periodEnd) || null : undefined,
        currency: p.currency ? String(p.currency) : undefined,
      });
      finishDrawPost(drawId, "overview", { draw });
      return;
    }
    if (action === "submit") {
      const draw = await draws.submitDraw(user, drawId);
      // Freeze the applied lender policy at FIRST successful submission;
      // resubmissions keep the original frozen version.
      loanProfile.freezeAppliedPolicy(drawId);
      finishDrawPost(drawId, "review", { draw });
      return;
    }
    if (action === "cancel") {
      const draw = draws.cancelDraw(user, drawId);
      finishDrawPost(drawId, "overview", { draw });
      return;
    }
    if (action === "return") {
      const draw = draws.returnDraw(user, drawId, String(p.reason ?? ""));
      finishDrawPost(drawId, "overview", { draw });
      return;
    }
    if (action === "clarification") {
      const draw = draws.requestClarification(user, drawId, String(p.question ?? ""));
      finishDrawPost(drawId, "review", { draw });
      return;
    }
    if (action === "clarification/resolve") {
      const draw = draws.resolveClarification(user, drawId, String(p.note ?? ""));
      finishDrawPost(drawId, "review", { draw });
      return;
    }
    if (action === "governance") {
      const result = await draws.sendToGovernance(user, drawId, p.summary ? String(p.summary) : null);
      finishDrawPost(drawId, "governance", result);
      return;
    }
    if (action === "lines") {
      const line = draws.addLine(user, drawId, {
        description: String(p.description ?? ""),
        budgetLineId: p.budgetLineId ? String(p.budgetLineId) : null,
        milestoneId: p.milestoneId ? String(p.milestoneId) : null,
        changeOrderId: p.changeOrderId ? String(p.changeOrderId) : null,
        exceptionAcknowledged: ["1", "true"].includes(String(p.exceptionAcknowledged)),
        scheduledValue: p.scheduledValue !== undefined && p.scheduledValue !== "" ? Number(p.scheduledValue) : 0,
        previouslyPaid: p.previouslyPaid !== undefined && p.previouslyPaid !== "" ? Number(p.previouslyPaid) : 0,
        currentRequested: p.currentRequested !== undefined && p.currentRequested !== "" ? Number(p.currentRequested) : 0,
        materialsStored: p.materialsStored !== undefined && p.materialsStored !== "" ? Number(p.materialsStored) : null,
        retainageAmount: p.retainageAmount !== undefined && p.retainageAmount !== "" ? Number(p.retainageAmount) : null,
        percentCompleteClaimed:
          p.percentCompleteClaimed !== undefined && p.percentCompleteClaimed !== "" ? Number(p.percentCompleteClaimed) : null,
      });
      finishDrawPost(drawId, "lines", { line }, 201);
      return;
    }
    const lineActionMatch = /^lines\/([^/]+)\/(review|delete|update)$/.exec(action);
    if (lineActionMatch) {
      const [, lineId, lineAction] = lineActionMatch;
      if (lineAction === "review") {
        const line = draws.reviewLine(user, lineId, {
          decision: String(p.decision ?? "") as never,
          reason: p.reason ? String(p.reason) : null,
          supportedAmount: p.supportedAmount !== undefined && p.supportedAmount !== "" ? Number(p.supportedAmount) : null,
          percentCompleteVerified:
            p.percentCompleteVerified !== undefined && p.percentCompleteVerified !== "" ? Number(p.percentCompleteVerified) : null,
        });
        finishDrawPost(drawId, "lines", { line });
        return;
      }
      if (lineAction === "delete") {
        draws.deleteLine(user, lineId);
        finishDrawPost(drawId, "lines", { ok: true });
        return;
      }
      const line = draws.updateLine(user, lineId, p as never);
      finishDrawPost(drawId, "lines", { line });
      return;
    }
    if (action === "documents") {
      const doc = draws.recordDocument(user, drawId, {
        requirementId: p.requirementId ? String(p.requirementId) : null,
        lineItemId: p.lineItemId ? String(p.lineItemId) : null,
        docType: p.docType ? (String(p.docType) as never) : undefined,
        title: String(p.title ?? ""),
        note: p.note ? String(p.note) : null,
        expiresAt: p.expiresAt ? String(p.expiresAt) : null,
        vendor: p.vendor ? String(p.vendor) : null,
        invoiceNumber: p.invoiceNumber ? String(p.invoiceNumber) : null,
        amount: p.amount !== undefined && p.amount !== "" ? Number(p.amount) : null,
        waiverKind: p.waiverKind ? String(p.waiverKind) : null,
        waiverScope: p.waiverScope ? String(p.waiverScope) : null,
        coveredThrough: p.coveredThrough ? String(p.coveredThrough) : null,
        issuingAuthority: p.issuingAuthority ? String(p.issuingAuthority) : null,
        referenceNumber: p.referenceNumber ? String(p.referenceNumber) : null,
        inspectionDate: p.inspectionDate ? String(p.inspectionDate) : null,
        inspectionResult: p.inspectionResult ? String(p.inspectionResult) : null,
      });
      finishDrawPost(drawId, "documents", { document: doc }, 201);
      return;
    }
    const docReviewMatch = /^documents\/([^/]+)\/review$/.exec(action);
    if (docReviewMatch) {
      const decision = String(p.decision ?? "");
      if (decision !== "ACCEPTED" && decision !== "REJECTED") {
        sendJson(res, { error: "decision must be ACCEPTED or REJECTED" }, 400);
        return;
      }
      const doc = draws.reviewDocument(user, docReviewMatch[1], decision, p.note ? String(p.note) : null);
      finishDrawPost(drawId, "documents", { document: doc });
      return;
    }
    if (action === "requirements") {
      const requirement = draws.addRequirement(user, drawId, {
        docType: (p.docType ? String(p.docType) : "OTHER") as never,
        title: String(p.title ?? ""),
        required: p.required === "1" || p.required === "true" || p.required === undefined,
        notes: p.notes ? String(p.notes) : null,
      });
      finishDrawPost(drawId, "documents", { requirement }, 201);
      return;
    }
    if (action === "evidence") {
      const link = draws.linkEvidence(user, drawId, {
        evidenceItemId: String(p.evidenceItemId ?? ""),
        lineItemId: p.lineItemId ? String(p.lineItemId) : null,
        note: p.note ? String(p.note) : null,
      });
      finishDrawPost(drawId, "evidence", { link }, 201);
      return;
    }
    const unlinkMatch = /^evidence\/([^/]+)\/unlink$/.exec(action);
    if (unlinkMatch) {
      draws.unlinkEvidence(user, unlinkMatch[1]);
      finishDrawPost(drawId, "evidence", { ok: true });
      return;
    }
    if (action === "report") {
      await generateDrawReport(req, res, user, drawId);
      return;
    }
    if (action === "verification-package") {
      await generateDrawVerificationPackage(req, res, user, drawId);
      return;
    }
    sendJson(res, { error: `Unknown draw action: ${action}` }, 404);
    return;
  }



  if (method === "GET" && drawApiMatch && drawApiMatch[2] === "recommendation") {
    const user = drawUser();
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const draw = repo.getDrawRequest(drawApiMatch[1]);
    if (!draw || !draws.canAccessDraw(user, draw)) {
      sendJson(res, { error: "Draw request not found" }, 404);
      return;
    }
    sendJson(res, draws.computeRecommendation(draw.id));
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
      redirect(res, "/demo");
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
      redirect(res, "/demo");
      return;
    }
    const report = repo.getReport(fileMatch[1]);
    const filePath = report ? path.join(REPORTS_DIR, report.id, report.filename) : "";
    if (!report || !fs.existsSync(filePath)) {
      sendHtml(res, renderError(navFor(user, "reports"), "Report not found", "This report is no longer available (demo data may have been reset). Generate a new one from the Reports page."), 404);
      return;
    }
    // Lender Draw Verification Packages carry the audit-package policy:
    // institutional roles + tenant access only (404 across tenants).
    if (report.reportType === "DRAW_VERIFICATION_PACKAGE") {
      const project = repo.getProject(report.projectId);
      const allowed =
        project &&
        ["FUNDER_REP", "PROJECT_MANAGER", "COMPLIANCE_REVIEWER"].includes(user.role) &&
        budget.canAccessProjectFinance(user, project);
      if (!allowed) {
        sendHtml(res, renderError(navFor(user, "reports"), "Report not found", "This report is no longer available (demo data may have been reset). Generate a new one from the Reports page."), 404);
        return;
      }
    }
    const isZip = report.filename.endsWith(".zip");
    const disposition = isZip || url.searchParams.get("dl") === "1" ? "attachment" : "inline";
    res.writeHead(200, {
      "Content-Type": isZip ? "application/zip" : "application/pdf",
      "Content-Disposition": `${disposition}; filename="${report.filename}"`,
      "Content-Length": fs.statSync(filePath).size,
      "Cache-Control": "no-cache",
    });
    res.end(fs.readFileSync(filePath));
    return;
  }

  // ========================= project audit packages =====================
  // One-click auditor-ready export. Generation ASSEMBLES governed sources;
  // nothing in these routes can create evidence, approvals, ledger entries
  // or release state. Generation and every download are audited.

  const apGenerateMatch = /^\/api\/projects\/([^/]+)\/audit-packages$/.exec(pathname);
  if (method === "POST" && apGenerateMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const text = (await readBody(req, 64 * 1024)).toString("utf8");
    const p: Record<string, unknown> = isFormPost(req)
      ? Object.fromEntries(new URLSearchParams(text))
      : text
        ? JSON.parse(text)
        : {};
    const truthy = (v: unknown) => v === true || v === "true" || v === "1" || v === "on";
    try {
      const pkg = await auditPackages.generateAuditPackage(user, apGenerateMatch[1], {
        asOf: p.asOf ? String(p.asOf) : null,
        includeReports: p.includeReports === undefined ? true : truthy(p.includeReports),
        includeCommMetadata: truthy(p.includeCommMetadata),
        includeEvidenceMedia: truthy(p.includeEvidenceMedia),
        renderCoverHtml: renderAuditCover,
        renderDrawDoc: renderDrawVerificationDoc,
        renderCoverPdf: async (html) => {
          if (!pdfRendererAvailable()) return null;
          const key = `audit-cover-${randomUUID()}`;
          const outPath = path.join(REPORTS_DIR, `${key}.pdf`);
          pendingReportHtml.set(key, html);
          try {
            fs.mkdirSync(REPORTS_DIR, { recursive: true });
            const config = Buffer.from(
              JSON.stringify({
                url: `http://127.0.0.1:${PORT}/report-cache/${key}?token=${previewToken}`,
                outPath,
                projectName: "Project Audit Package",
                generatedAt: new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC"),
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
            return fs.existsSync(outPath) ? fs.readFileSync(outPath) : null;
          } catch (err) {
            // Honest fallback: the package ships the printable HTML cover.
            console.error("[audit-package] cover PDF render failed:", (err as Error).message);
            return null;
          } finally {
            pendingReportHtml.delete(key);
            try {
              fs.unlinkSync(outPath);
            } catch {
              /* not created */
            }
          }
        },
      });
      if (isFormPost(req)) {
        redirect(res, `/reports?apReady=${pkg.id}`);
      } else {
        sendJson(res, { auditPackage: pkg }, 201);
      }
    } catch (err) {
      if (isFormPost(req) && err instanceof AuditPackageError) {
        redirect(res, `/reports?apError=${encodeURIComponent(err.message)}`);
        return;
      }
      throw err;
    }
    return;
  }

  if (method === "GET" && apGenerateMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    sendJson(res, { auditPackages: auditPackages.listPackages(user, apGenerateMatch[1]) });
    return;
  }

  const apStatusMatch = /^\/api\/audit-packages\/([^/]+)$/.exec(pathname);
  if (method === "GET" && apStatusMatch) {
    const user = currentUser(req);
    if (!user) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const pkg = repo.getAuditPackage(apStatusMatch[1]);
    if (!pkg) {
      sendJson(res, { error: "Unknown audit package" }, 404);
      return;
    }
    // Same tenant + role gate as generation/download (404 across tenants).
    auditPackages.listPackages(user, pkg.projectId);
    sendJson(res, { auditPackage: pkg });
    return;
  }

  const apDownloadMatch = /^\/audit-packages\/([^/]+)\/download$/.exec(pathname);
  if (method === "GET" && apDownloadMatch) {
    const user = currentUser(req);
    if (!user) {
      redirect(res, "/demo");
      return;
    }
    const { pkg, filePath, filename } = auditPackages.resolvePackageDownload(user, apDownloadMatch[1]);
    auditPackages.auditPackageDownload(user, pkg);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": fs.statSync(filePath).size,
      "Cache-Control": "no-cache",
    });
    res.end(fs.readFileSync(filePath));
    return;
  }

  // =================== milestone completion gates =====================
  // Six separate dimensions — contractor report, OBV evidence review,
  // inspection requirement, schedule, result, draw eligibility. Nothing
  // here can verify evidence, approve, or release funds.

  const gateParams = async (): Promise<Record<string, unknown>> => {
    const text = (await readBody(req, 64 * 1024)).toString("utf8");
    if (isFormPost(req)) return Object.fromEntries(new URLSearchParams(text));
    return text ? JSON.parse(text) : {};
  };
  const gateTruthy = (v: unknown) => v === true || v === "true" || v === "1" || v === "on";

  const gatesMatch = /^\/api\/milestones\/([^/]+)\/gates$/.exec(pathname);
  if (method === "GET" && gatesMatch) {
    const user2 = currentUser(req);
    if (!user2) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    sendJson(res, { gates: completionGates.gatesForUser(user2, gatesMatch[1]) });
    return;
  }

  const contractorMatch = /^\/api\/milestones\/([^/]+)\/contractor-completion$/.exec(pathname);
  if (method === "POST" && contractorMatch) {
    const user2 = currentUser(req);
    if (!user2) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const p = await gateParams();
    const milestone = completionGates.reportContractorCompletion(user2, contractorMatch[1], {
      status: String(p.status ?? "") as never,
      notes: p.notes ? String(p.notes) : null,
      linkedEvidenceIds: Array.isArray(p.linkedEvidenceIds)
        ? (p.linkedEvidenceIds as string[])
        : p.linkedEvidenceIds
          ? String(p.linkedEvidenceIds).split(",").map((x) => x.trim()).filter(Boolean)
          : [],
    });
    if (isFormPost(req)) {
      redirect(res, `/milestone/${milestone.id}`);
    } else {
      sendJson(res, { milestone, gates: completionGates.milestoneGates(milestone.id) });
    }
    return;
  }

  const requirementMatch = /^\/api\/milestones\/([^/]+)\/inspection-requirement$/.exec(pathname);
  if (method === "POST" && requirementMatch) {
    const user2 = currentUser(req);
    if (!user2) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const p = await gateParams();
    const requirement = completionGates.determineInspectionRequirement(user2, requirementMatch[1], {
      requirement: String(p.requirement ?? "") as never,
      requirementBasis: String(p.requirementBasis ?? ""),
      jurisdiction: p.jurisdiction ? String(p.jurisdiction) : null,
      inspectionType: p.inspectionType ? String(p.inspectionType) : null,
      issuingAuthority: p.issuingAuthority ? String(p.issuingAuthority) : null,
      mustPassBeforeDrawReview: gateTruthy(p.mustPassBeforeDrawReview),
      mustPassBeforeGovernance:
        p.mustPassBeforeGovernance === undefined ? true : gateTruthy(p.mustPassBeforeGovernance),
      finalCompletionOnly: gateTruthy(p.finalCompletionOnly),
      resultDocumentRequired: gateTruthy(p.resultDocumentRequired),
      permitRequired: p.permitRequired === undefined ? undefined : gateTruthy(p.permitRequired),
      requiredPermitType: p.requiredPermitType ? String(p.requiredPermitType) : null,
      officialSourceRequired: p.officialSourceRequired === undefined ? undefined : gateTruthy(p.officialSourceRequired),
      codeBasisRequired: p.codeBasisRequired === undefined ? undefined : gateTruthy(p.codeBasisRequired),
      permitMustBeActiveBeforeDrawReview:
        p.permitMustBeActiveBeforeDrawReview === undefined ? undefined : gateTruthy(p.permitMustBeActiveBeforeDrawReview),
      permitMustBeActiveBeforeGovernance:
        p.permitMustBeActiveBeforeGovernance === undefined ? undefined : gateTruthy(p.permitMustBeActiveBeforeGovernance),
    });
    if (isFormPost(req)) {
      redirect(res, `/milestone/${requirementMatch[1]}`);
    } else {
      sendJson(res, { requirement, gates: completionGates.milestoneGates(requirementMatch[1]) });
    }
    return;
  }

  const inspCreateMatch = /^\/api\/milestones\/([^/]+)\/inspections$/.exec(pathname);
  if (method === "POST" && inspCreateMatch) {
    const user2 = currentUser(req);
    if (!user2) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const p = await gateParams();
    const inspection = completionGates.createInspection(user2, inspCreateMatch[1], {
      permitRefId: p.permitRefId ? String(p.permitRefId) : null,
      scheduledAt: p.scheduledAt ? String(p.scheduledAt) : null,
      inspectionType: p.inspectionType ? String(p.inspectionType) : null,
      jurisdiction: p.jurisdiction ? String(p.jurisdiction) : null,
      issuingAuthority: p.issuingAuthority ? String(p.issuingAuthority) : null,
      inspectionReference: p.inspectionReference ? String(p.inspectionReference) : null,
      permitId: p.permitId ? String(p.permitId) : null,
      notes: p.notes ? String(p.notes) : null,
    });
    if (isFormPost(req)) {
      redirect(res, `/milestone/${inspCreateMatch[1]}`);
    } else {
      sendJson(res, { inspection }, 201);
    }
    return;
  }

  const inspActionMatch = /^\/api\/inspections\/([^/]+)\/(schedule|complete|result|cancel|reinspection|correct)$/.exec(pathname);
  if (method === "POST" && inspActionMatch) {
    const user2 = currentUser(req);
    if (!user2) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const p = await gateParams();
    const [, inspId, act] = inspActionMatch;
    let inspection;
    if (act === "schedule") {
      inspection = completionGates.scheduleInspection(user2, inspId, String(p.scheduledAt ?? ""));
    } else if (act === "complete") {
      inspection = completionGates.markInspectionCompleted(user2, inspId, p.completedAt ? String(p.completedAt) : null);
    } else if (act === "result") {
      inspection = completionGates.recordInspectionResult(user2, inspId, {
        result: String(p.result ?? "") as never,
        governmentInspectorName: p.governmentInspectorName ? String(p.governmentInspectorName) : null,
        inspectionReference: p.inspectionReference ? String(p.inspectionReference) : null,
        supportingDocumentId: p.supportingDocumentId ? String(p.supportingDocumentId) : null,
        correctionNoticeReference: p.correctionNoticeReference ? String(p.correctionNoticeReference) : null,
        correctionSummary: p.correctionSummary ? String(p.correctionSummary) : null,
        correctionDueAt: p.correctionDueAt ? String(p.correctionDueAt) : null,
        notes: p.notes ? String(p.notes) : null,
      });
    } else if (act === "reinspection") {
      inspection = completionGates.createReinspection(user2, inspId, {
        scheduledAt: p.scheduledAt ? String(p.scheduledAt) : null,
        notes: p.notes ? String(p.notes) : null,
      });
    } else if (act === "correct") {
      inspection = completionGates.correctInspectionRecord(user2, inspId, {
        reason: String(p.reason ?? ""),
        governmentInspectorName: p.governmentInspectorName !== undefined ? (p.governmentInspectorName ? String(p.governmentInspectorName) : null) : undefined,
        inspectionReference: p.inspectionReference !== undefined ? (p.inspectionReference ? String(p.inspectionReference) : null) : undefined,
        notes: p.notes !== undefined ? (p.notes ? String(p.notes) : null) : undefined,
      });
    } else {
      inspection = completionGates.cancelInspection(user2, inspId, p.reason ? String(p.reason) : null);
    }
    if (isFormPost(req)) {
      redirect(res, `/milestone/${inspection.milestoneId}`);
    } else {
      sendJson(res, { inspection, gates: completionGates.milestoneGates(inspection.milestoneId) });
    }
    return;
  }

  // ---- permit register / code basis / official sources (Part 1-5) ----
  const projPermitsMatch = /^\/api\/projects\/([^/]+)\/permits$/.exec(pathname);
  if (projPermitsMatch) {
    const user2 = currentUser(req);
    if (!user2) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    if (method === "GET") {
      sendJson(res, {
        register: permits.permitRegister(user2, projPermitsMatch[1], {
          status: url.searchParams.get("status") ?? undefined,
          permitType: url.searchParams.get("type") ?? undefined,
          authority: url.searchParams.get("authority") ?? undefined,
          milestoneId: url.searchParams.get("milestone") ?? undefined,
          expiration: url.searchParams.get("expiration") ?? undefined,
        }),
        methodology: permits.METHODOLOGY_NOTE,
      });
      return;
    }
    if (method === "POST") {
      const p = await gateParams();
      const permit = permits.createPermit(user2, projPermitsMatch[1], {
        permitNumber: String(p.permitNumber ?? ""),
        permitType: String(p.permitType ?? ""),
        issuingAuthority: p.issuingAuthority ? String(p.issuingAuthority) : null,
        jurisdiction: p.jurisdiction ? String(p.jurisdiction) : null,
        status: p.status ? String(p.status) : null,
        issuedAt: p.issuedAt ? String(p.issuedAt) : null,
        effectiveAt: p.effectiveAt ? String(p.effectiveAt) : null,
        expiresAt: p.expiresAt ? String(p.expiresAt) : null,
        scopeDescription: p.scopeDescription ? String(p.scopeDescription) : null,
        applicableCodeEdition: p.applicableCodeEdition ? String(p.applicableCodeEdition) : null,
        codeEffectiveDate: p.codeEffectiveDate ? String(p.codeEffectiveDate) : null,
        codeBasis: p.codeBasis ? String(p.codeBasis) : null,
        officialRecordUrl: p.officialRecordUrl ? String(p.officialRecordUrl) : null,
        officialRecordNumber: p.officialRecordNumber ? String(p.officialRecordNumber) : null,
        notes: p.notes ? String(p.notes) : null,
        legacyReference: p.legacyReference ? String(p.legacyReference) : null,
        legacyImport: p.legacyImport === true || p.legacyImport === "true" || p.legacyImport === "on",
      });
      if (isFormPost(req)) {
        redirect(res, `/project/${projPermitsMatch[1]}/permits`);
      } else {
        sendJson(res, { permit }, 201);
      }
      return;
    }
  }

  const permitActionMatch = /^\/api\/permits\/([^/]+)(?:\/(code-basis|links))?$/.exec(pathname);
  if (permitActionMatch && (method === "GET" || method === "POST")) {
    const user2 = currentUser(req);
    if (!user2) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const [, permitId, sub] = permitActionMatch;
    if (method === "GET" && !sub) {
      const { permit } = permits.getPermitFor(user2, permitId);
      sendJson(res, {
        permit,
        effectiveStatus: permits.effectiveStatus(permit),
        links: repo.listPermitLinksForPermit(permitId),
        officialSources: repo.listOfficialSourcesForPermit(permitId),
      });
      return;
    }
    if (method === "POST") {
      const p = await gateParams();
      if (sub === "code-basis") {
        const permit = permits.recordCodeBasis(user2, permitId, {
          applicableCodeEdition: String(p.applicableCodeEdition ?? ""),
          codeEffectiveDate: p.codeEffectiveDate ? String(p.codeEffectiveDate) : null,
          codeBasis: String(p.codeBasis ?? ""),
          reason: p.reason ? String(p.reason) : null,
        });
        if (isFormPost(req)) redirect(res, `/project/${permit.projectId}/permits`);
        else sendJson(res, { permit });
        return;
      }
      if (sub === "links") {
        const link = permits.linkMilestone(
          user2, permitId, String(p.milestoneId ?? ""), p.scopeNote ? String(p.scopeNote) : null
        );
        if (isFormPost(req)) {
          redirect(res, `/milestone/${link.milestoneId}`);
        } else {
          sendJson(res, { link }, 201);
        }
        return;
      }
      const permit = permits.updatePermit(user2, permitId, {
        permitNumber: p.permitNumber !== undefined ? String(p.permitNumber) : undefined,
        permitType: p.permitType !== undefined ? String(p.permitType) : undefined,
        issuingAuthority: p.issuingAuthority !== undefined ? (p.issuingAuthority ? String(p.issuingAuthority) : null) : undefined,
        jurisdiction: p.jurisdiction !== undefined ? (p.jurisdiction ? String(p.jurisdiction) : null) : undefined,
        status: p.status !== undefined ? String(p.status) : undefined,
        issuedAt: p.issuedAt !== undefined ? (p.issuedAt ? String(p.issuedAt) : null) : undefined,
        effectiveAt: p.effectiveAt !== undefined ? (p.effectiveAt ? String(p.effectiveAt) : null) : undefined,
        expiresAt: p.expiresAt !== undefined ? (p.expiresAt ? String(p.expiresAt) : null) : undefined,
        closedAt: p.closedAt !== undefined ? (p.closedAt ? String(p.closedAt) : null) : undefined,
        scopeDescription: p.scopeDescription !== undefined ? (p.scopeDescription ? String(p.scopeDescription) : null) : undefined,
        officialRecordUrl: p.officialRecordUrl !== undefined ? (p.officialRecordUrl ? String(p.officialRecordUrl) : null) : undefined,
        officialRecordNumber: p.officialRecordNumber !== undefined ? (p.officialRecordNumber ? String(p.officialRecordNumber) : null) : undefined,
        notes: p.notes !== undefined ? (p.notes ? String(p.notes) : null) : undefined,
        reason: p.reason ? String(p.reason) : null,
      });
      if (isFormPost(req)) redirect(res, `/project/${permit.projectId}/permits`);
      else sendJson(res, { permit });
      return;
    }
  }

  // Authenticated official-source artifact download. Never inline: the
  // browser must not render or sniff artifact content.
  const srcArtifactMatch = /^\/official-sources\/([^/]+)\/artifact$/.exec(pathname);
  if (method === "GET" && srcArtifactMatch) {
    const user2 = currentUser(req);
    const record = user2 ? repo.getOfficialSource(srcArtifactMatch[1]) : null;
    const project = record ? repo.getProject(record.projectId) : null;
    if (!user2 || !record || !project || !budget.canAccessProjectFinance(user2, project) || !record.sourceDocumentPath) {
      sendJson(res, { error: "Not found" }, 404);
      return;
    }
    const filePath = path.join(UPLOADS_DIR, record.sourceDocumentPath);
    if (!filePath.startsWith(UPLOADS_DIR) || !fs.existsSync(filePath)) {
      sendJson(res, { error: "Not found" }, 404);
      return;
    }
    const bytes = fs.readFileSync(filePath);
    const sniffed = permits.sniffArtifactType(bytes);
    res.writeHead(200, {
      "Content-Type": sniffed?.mime ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(record.sourceDocumentPath)}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Length": bytes.length,
    });
    res.end(bytes);
    return;
  }

  if (method === "POST" && pathname === "/api/official-sources") {
    const user2 = currentUser(req);
    if (!user2) {
      sendJson(res, { error: "Select a demo user first" }, 401);
      return;
    }
    const p = await gateParams();
    const record = permits.recordOfficialSource(user2, {
      projectId: String(p.projectId ?? ""),
      milestoneId: p.milestoneId ? String(p.milestoneId) : null,
      permitId: p.permitId ? String(p.permitId) : null,
      inspectionId: p.inspectionId ? String(p.inspectionId) : null,
      sourceType: String(p.sourceType ?? ""),
      officialSystemName: p.officialSystemName ? String(p.officialSystemName) : null,
      officialRecordNumber: p.officialRecordNumber ? String(p.officialRecordNumber) : null,
      officialRecordUrl: p.officialRecordUrl ? String(p.officialRecordUrl) : null,
      lookupPerformedAt: p.lookupPerformedAt ? String(p.lookupPerformedAt) : null,
      capturedAt: p.capturedAt ? String(p.capturedAt) : null,
      officialStatusText: p.officialStatusText ? String(p.officialStatusText) : null,
      artifactDataUrl: p.artifactDataUrl ? String(p.artifactDataUrl) : null,
      artifactFilename: p.artifactFilename ? String(p.artifactFilename) : null,
      notes: p.notes ? String(p.notes) : null,
    });
    if (isFormPost(req)) {
      redirect(res, record.milestoneId ? `/milestone/${record.milestoneId}` : `/project/${record.projectId}/permits`);
    } else {
      sendJson(res, { record }, 201);
    }
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
  // Public enterprise homepage. Marketing surface only — the product frame
  // reads real seeded values (read-only); role selection lives at /demo.
  if (method === "GET" && pathname === "/") {
    sendHtml(res, renderHome(homeSnapshot()));
    return;
  }

  function homeSnapshot(): HomeSnapshot | null {
    try {
      const project = repo.listProjects().find((p) => p.status === "ACTIVE");
      if (!project) return null;
      const fin = budget.assessFinancialProgress(project.id);
      const phys = budget.assessPhysicalProgress(project.id);
      const OPEN_DRAWS = new Set([
        "SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED", "READY_FOR_GOVERNANCE", "PARTIALLY_APPROVED",
      ]);
      const openDraws = repo.listDrawRequestsForProject(project.id).filter((d) => OPEN_DRAWS.has(d.status));
      let supportable = 0;
      let anyReviewed = false;
      for (const d of openDraws) {
        for (const l of repo.listDrawLines(d.id)) {
          if (l.supportedAmount !== null) {
            supportable += l.supportedAmount;
            anyReviewed = true;
          } else if (l.status === "SUPPORTED") {
            supportable += l.currentRequested;
            anyReviewed = true;
          }
        }
      }
      const openExc = repo.listExceptionsForProject(project.id).filter(exceptions.isOpen);
      const blockedAmount = openDraws
        .filter(
          (d) =>
            draws.missingRequiredDocuments(d.id).length > 0 ||
            openExc.some((e) => e.drawRequestId === d.id && ["HIGH", "CRITICAL"].includes(e.severity))
        )
        .reduce((s, d) => s + d.requestedAmount, 0);
      const milestones = repo.listMilestones(project.id).filter((m) => !m.archived);
      const pendingInspections = milestones.filter((m) =>
        ["REQUIRED_UNSCHEDULED", "SCHEDULED", "COMPLETED_PENDING_RESULT"].includes(
          completionGates.inspectionGateState(m.id)
        )
      ).length;
      const held = repo
        .listAccountEventsForProject(project.id)
        .reduce((s, e) => s + (e.type === "HELD" ? e.amount : -e.amount), 0);
      const sevRank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      return {
        projectName: project.name,
        verifiedPhysicalPct: phys.verifiedPct,
        claimedFinancialPct: fin.claimedPct,
        drawRequested: openDraws.reduce((s, d) => s + d.requestedAmount, 0),
        drawSupportable: anyReviewed ? supportable : null,
        blockedAmount,
        pendingInspections,
        highCriticalExceptions: openExc.filter((e) => ["HIGH", "CRITICAL"].includes(e.severity)).length,
        fundsHeld: Math.max(0, held),
        retainageWithheld: retainage.retainageSummary(project.id).withheldToDate,
        evidenceAwaitingReview: milestones.filter((m) => {
          const s = completionGates.evidenceReviewStatus(m.id).status;
          return s === "NEEDS_REVIEW" || s === "UNDER_REVIEW";
        }).length,
        recentExceptions: [...openExc]
          .sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9))
          .slice(0, 3)
          .map((e) => ({ severity: e.severity, title: e.title })),
        milestones: milestones.map((m) => ({
          label: `M${m.seq}`,
          state: m.accountStatus === "RELEASED" ? "RELEASED" : "HELD",
        })),
      };
    } catch {
      return null; // the public page must render even if demo data is absent
    }
  }

  // Seeded demonstration role selector (moved from the root route).
  if (method === "GET" && pathname === "/demo") {
    const users = repo.listUsers();
    const orgs = new Map(
      users.map((u) => [u.organizationId, repo.getOrganization(u.organizationId)!])
    );
    sendHtml(res, renderUserSwitcher(users, orgs));
    return;
  }

  // Convenience section routes — permanent homepage anchors, and the app
  // entry which defers to the existing session gate.
  if (method === "GET" && pathname === "/app") {
    redirect(res, "/overview", 302);
    return;
  }
  if (method === "GET" && (pathname === "/platform" || pathname === "/security")) {
    redirect(res, `/#${pathname.slice(1)}`, 302);
    return;
  }

  const PAGE_PREFIXES = [
    "/overview", "/dashboard", "/projects", "/project/", "/milestone/",
    "/approvals", "/ledger", "/reports", "/compliance", "/insights", "/more", "/field",
    "/map", "/communications", "/issues", "/issue/", "/evidence-drafts",
    "/setup", "/pilot", "/draws", "/draw/", "/budget", "/exceptions", "/exception/", "/change-orders", "/change-order/",
  ];
  const isPage = PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
  const user = currentUser(req);
  if (method === "GET" && isPage && !user) {
    redirect(res, "/demo");
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
        const ms = repo.getMilestone(req2.milestoneId!)!;
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
    await exceptions.evaluateExceptions();
    const openExceptionsOv = repo
      .listExceptions()
      .filter((e) => ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"].includes(e.status));
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
          exceptionsOpen: openExceptionsOv.length,
          exceptionsHighCritical: openExceptionsOv.filter((e) => ["HIGH", "CRITICAL"].includes(e.severity)).length,
          exceptionsOverdue: openExceptionsOv.filter((e) => exceptions.slaState(e) === "OVERDUE").length,
          exceptionsAwaiting: openExceptionsOv.filter((e) => e.status === "AWAITING_RESPONSE").length,
        },
        openIssuesByProject,
      })
    );
    return;
  }

  if (method === "GET" && pathname === "/projects") {
    sendHtml(
      res,
      renderProjects({
        nav: navFor(user!, "projects"),
        projects: await allProjectCards(),
        filters: {
          q: url.searchParams.get("q") ?? "",
          state: url.searchParams.get("state") ?? "",
        },
        openIssuesByProject: new Map(
          repo.listProjects().map((p) => [
            p.id,
            repo.listFieldIssues().filter((i) => i.projectId === p.id && !["RESOLVED", "CLOSED"].includes(i.status)).length,
          ])
        ),
      })
    );
    return;
  }

  const budgetPageMatch = /^\/project\/([^/]+)\/budget$/.exec(pathname);
  if (method === "GET" && budgetPageMatch) {
    const project = repo.getProject(budgetPageMatch[1]);
    // Tenant boundary: unrelated organizations get the same 404 as a
    // nonexistent project — existence is not disclosed.
    if (!project || !budget.canAccessProjectFinance(user!, project)) {
      sendHtml(res, renderError(navFor(user!, "budget"), "Project not found", "No project exists at this address."), 404);
      return;
    }
    const milestones = repo.listMilestones(project.id).filter((m) => !m.archived);
    const verifiedEvidenceOptions = milestones
      .filter((m) => !["VERIFIED", "APPROVED", "RELEASED"].includes(m.status))
      .flatMap((m) =>
        repo
          .listEvidenceForMilestone(m.id)
          .filter((ev) => repo.getVerificationForEvidence(ev.id)?.verdict === "VERIFIED")
          .map((ev) => ({
            id: ev.id,
            milestoneId: m.id,
            label: `M${m.seq} · verified evidence ${ev.id.slice(0, 8)}… (${ev.capturedAt.slice(0, 10)})`,
          }))
      );
    const data: BudgetPageData = {
      nav: navFor(user!, "budget"),
      project,
      financial: budget.assessFinancialProgress(project.id),
      physical: budget.assessPhysicalProgress(project.id),
      register: budget.budgetLineRegister(project.id),
      categories: budget.categoryComparisons(project.id),
      milestones,
      users: usersById(),
      auditTrail: repo
        .listConfigAudit(project.id, 30)
        .filter((e) => e.entityType === "budget_line" || e.entityType === "verified_quantity")
        .map((e) => ({
          action: e.action, reason: e.reason, afterSummary: e.afterSummary,
          createdAt: e.createdAt, actorUserId: e.actorUserId,
        })),
      verifiedEvidenceOptions,
      retainage: {
        policy: retainage.effectivePolicy(project.id),
        summary: retainage.retainageSummary(project.id),
        releases: repo.listRetainageReleasesForProject(project.id).map((release) => {
          const approval = repo.getApprovalRequestForRetainageRelease(release.id);
          const approvalRecords = approval ? repo.listApprovalRecordsForRequest(approval.id) : [];
          return {
            release,
            conditions: retainage.conditionStates(release.id),
            approval,
            approvalRecords,
            canDecide: Boolean(
              approval &&
                approval.status === "PENDING" &&
                approval.requiredRoles.includes(user!.role) &&
                !approvalRecords.some((r) => r.role === user!.role) &&
                release.requestedByUserId !== user!.id
            ),
          };
        }),
      },
      canManage: budget.canManageBudget(user!),
      launched: project.status !== "DRAFT",
    };
    sendHtml(res, renderBudgetPage(data));
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
          milestone: repo.getMilestone(approval.milestoneId!)!,
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
        gates: completionGates.milestoneGates(milestone.id),
        canReportCompletion: ["PROJECT_MANAGER", "FIELD"].includes(user!.role),
        canDetermineInspection: ["FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(user!.role),
        canRecordPermits: ["FUNDER_REP", "COMPLIANCE_REVIEWER", "PROJECT_MANAGER"].includes(user!.role),
        linkedPermits: repo.listPermitLinksForMilestone(milestone.id).flatMap((link) => {
          const permit = repo.getPermit(link.permitId);
          return permit
            ? [{ link, permit, effectiveStatus: permits.effectiveStatus(permit), sources: repo.listOfficialSourcesForPermit(permit.id) }]
            : [];
        }),
        projectPermits: repo.listPermitsForProject(project.id),
        inspectionHistory: repo.listInspectionsForMilestone(milestone.id),
        officialSourceCounts: new Map(
          repo
            .listInspectionsForMilestone(milestone.id)
            .map((i) => [i.id, repo.listOfficialSourcesForInspection(i.id).length])
        ),
        permitMethodology: permits.METHODOLOGY_NOTE,
      })
    );
    return;
  }

  // ---- change order pages ----
  if (method === "GET" && pathname === "/change-orders") {
    const rows = changeOrders.listChangeOrdersForUser(user!).map((co) => ({
      co,
      project: repo.getProject(co.projectId),
      ageDays: Math.max(0, Math.floor((Date.now() - Date.parse(co.requestedAt ?? co.createdAt)) / 86_400_000)),
      nextAction: changeOrders.nextAction(co),
    }));
    sendHtml(res, renderCoRegister({ nav: navFor(user!, "change-orders"), rows, canCreate: changeOrders.canManageChangeOrders(user!) }));
    return;
  }

  if (method === "GET" && pathname === "/change-orders/new") {
    if (!changeOrders.canManageChangeOrders(user!)) {
      sendHtml(res, renderError(navFor(user!, "change-orders"), "Not authorized", "Field users cannot create change orders."), 403);
      return;
    }
    sendHtml(
      res,
      renderCoNew({
        nav: navFor(user!, "change-orders"),
        projects: repo
          .listProjects()
          .filter((p) => p.status === "ACTIVE" && budget.canAccessProjectFinance(user!, p))
          .map((project) => ({
            project,
            milestones: repo.listMilestones(project.id).filter((m) => !m.archived),
            nextNumber: repo.nextChangeOrderNumber(project.id),
          })),
      })
    );
    return;
  }

  if (method === "GET" && pathname.startsWith("/change-order/")) {
    const co = repo.getChangeOrder(pathname.slice("/change-order/".length));
    const coProject = co ? repo.getProject(co.projectId) : null;
    // Tenant boundary: unrelated organizations get the same 404.
    if (!co || !coProject || !budget.canAccessProjectFinance(user!, coProject)) {
      sendHtml(res, renderError(navFor(user!, "change-orders"), "Change order not found", "No change order exists at this address."), 404);
      return;
    }
    const approval = repo.getApprovalRequestForChangeOrder(co.id);
    const approvalRecords = approval ? repo.listApprovalRecordsForRequest(approval.id) : [];
    const alreadyDecided = approvalRecords.some((r) => r.role === user!.role);
    const data: CoDetailData = {
      nav: navFor(user!, "change-orders"),
      co,
      project: coProject,
      requestedBy: repo.getUser(co.requestedByUserId),
      allocations: repo.listCoAllocations(co.id).map((allocation) => ({
        allocation,
        line: repo.getBudgetLine(allocation.budgetLineId),
      })),
      budgetLines: repo.listBudgetLines(co.projectId).filter((l) => l.active),
      documents: repo.listCoDocuments(co.id),
      events: repo.listCoEvents(co.id),
      affectedMilestones: co.affectedMilestoneIds
        .map((id) => repo.getMilestone(id))
        .filter((m): m is NonNullable<typeof m> => Boolean(m)),
      preview: changeOrders.impactPreview(co.id),
      approval,
      approvalRecords,
      users: usersById(),
      canManage: changeOrders.canManageChangeOrders(user!),
      canGovern: budget.canManageBudget(user!),
      canDecide: Boolean(
        approval &&
          approval.status === "PENDING" &&
          approval.requiredRoles.includes(user!.role) &&
          !alreadyDecided &&
          co.requestedByUserId !== user!.id
      ),
      isSubmitter: co.requestedByUserId === user!.id,
    };
    sendHtml(res, renderCoDetail(data));
    return;
  }

  // ---- exception pages ----
  if (method === "GET" && pathname === "/exceptions") {
    // Deterministic sweep on view: idempotent create/reopen/auto-resolve.
    await exceptions.evaluateExceptions();
    const allRows = exceptions.listExceptionsForUser(user!).map(exceptionRow);
    const f = {
      severity: url.searchParams.get("severity") ?? "",
      category: url.searchParams.get("category") ?? "",
      project: url.searchParams.get("project") ?? "",
      owner: url.searchParams.get("owner") ?? "",
      status: url.searchParams.get("status") ?? "",
      sourceType: url.searchParams.get("sourceType") ?? "",
      overdue: url.searchParams.get("overdue") ?? "",
    };
    const OPEN = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"];
    const rows = allRows.filter((r) => {
      const e = r.exception;
      if (f.severity && e.severity !== f.severity) return false;
      if (f.category && e.category !== f.category) return false;
      if (f.project && e.projectId !== f.project) return false;
      if (f.owner === "unassigned" ? e.ownerUserId !== null : f.owner && e.ownerUserId !== f.owner) return false;
      if (f.status === "" && !OPEN.includes(e.status)) return false;
      if (f.status && f.status !== "all" && e.status !== f.status) return false;
      if (f.sourceType && e.sourceType !== f.sourceType) return false;
      if (f.overdue === "1" && r.sla !== "OVERDUE") return false;
      return true;
    });
    const sevOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as Record<string, number>;
    rows.sort((a, b) => sevOrder[a.exception.severity] - sevOrder[b.exception.severity] || (a.exception.openedAt < b.exception.openedAt ? -1 : 1));
    sendHtml(
      res,
      renderExceptionRegister({
        nav: navFor(user!, "exceptions"),
        rows,
        allRows,
        filters: f,
        projects: repo.listProjects().filter((p) => budget.canAccessProjectFinance(user!, p)),
        users: repo.listUsers(),
        rules: exceptions.RULES,
        canManage: exceptions.canManageExceptions(user!),
      })
    );
    return;
  }

  if (method === "GET" && pathname.startsWith("/exception/")) {
    await exceptions.evaluateExceptions();
    const exception = repo.getException(pathname.slice("/exception/".length));
    // Tenant boundary: unrelated organizations get the same 404 as a
    // nonexistent exception — existence is not disclosed.
    if (!exception || !exceptions.canAccessException(user!, exception)) {
      sendHtml(res, renderError(navFor(user!, "exceptions"), "Exception not found", "No exception exists at this address."), 404);
      return;
    }
    const draw = exception.drawRequestId ? repo.getDrawRequest(exception.drawRequestId) : null;
    const data: ExceptionDetailData = {
      nav: navFor(user!, "exceptions"),
      exception,
      project: repo.getProject(exception.projectId)!,
      milestone: exception.milestoneId ? repo.getMilestone(exception.milestoneId) : null,
      drawNumber: draw?.drawNumber ?? null,
      owner: exception.ownerUserId ? repo.getUser(exception.ownerUserId) : null,
      users: repo.listUsers(),
      usersById: usersById(),
      events: repo.listExceptionEvents(exception.id),
      sla: exceptions.slaState(exception),
      ageDays: exceptions.ageDays(exception),
      source: exceptions.sourceContext(exception),
      sourceActive: await exceptions.sourceStillActive(exception),
      canManage: exceptions.canManageExceptions(user!),
      canWaive: exceptions.canWaive(user!, exception),
      currentUser: user!,
    };
    sendHtml(res, renderExceptionDetail(data));
    return;
  }

  // ---- budget & progress pages ----
  if (method === "GET" && pathname === "/budget") {
    const rows = repo
      .listProjects()
      .filter((project) => project.status === "ACTIVE" && budget.canAccessProjectFinance(user!, project))
      .map((project) => ({ project, financial: budget.assessFinancialProgress(project.id) }));
    sendHtml(res, renderBudgetPortfolio({ nav: navFor(user!, "budget"), rows }));
    return;
  }

  // ---- draw request pages ----
  if (method === "GET" && pathname === "/draws") {
    const rows: DrawRegisterRow[] = draws.listDrawsForUser(user!).map((draw) => {
      const summary = draws.drawHeaderSummary(draw.id);
      return {
        draw,
        project: repo.getProject(draw.projectId),
        summary,
        nextAction: draws.nextAction(draw, summary),
      };
    });
    sendHtml(
      res,
      renderDrawRegister({ nav: navFor(user!, "draws"), rows, canCreate: user!.role !== "FIELD" })
    );
    return;
  }

  if (method === "GET" && pathname === "/draws/new") {
    if (user!.role === "FIELD") {
      sendHtml(res, renderError(navFor(user!, "draws"), "Not authorized", "Field users cannot create draw requests."), 403);
      return;
    }
    sendHtml(
      res,
      renderDrawNew({
        nav: navFor(user!, "draws"),
        projects: repo
          .listProjects()
          .filter((p) => p.status === "ACTIVE")
          .map((project) => ({ project, nextNumber: repo.nextDrawNumber(project.id) })),
      })
    );
    return;
  }

  const drawReportMatch = /^\/draw\/([^/]+)\/report$/.exec(pathname);
  if (method === "GET" && drawReportMatch) {
    const draw = repo.getDrawRequest(drawReportMatch[1]);
    if (!draw || !draws.canAccessDraw(user!, draw)) {
      sendHtml(res, renderError(navFor(user!, "draws"), "Draw not found", "No draw request exists at this address."), 404);
      return;
    }
    sendHtml(res, renderDrawReport(await assembleDrawReportData(draw, user!)));
    return;
  }

  // Lender Draw Verification Package — printable document preview
  // (assembleDrawPackageData enforces role + tenant access: 404/403).
  const drawPkgPreviewMatch = /^\/draw\/([^/]+)\/verification-package\/preview$/.exec(pathname);
  if (method === "GET" && drawPkgPreviewMatch) {
    const data = await drawPackage.assembleDrawPackageData(user!, drawPkgPreviewMatch[1]);
    sendHtml(res, renderDrawVerificationDoc(data));
    return;
  }

  if (method === "GET" && pathname.startsWith("/draw/")) {
    const draw = repo.getDrawRequest(pathname.slice("/draw/".length));
    // Tenant boundary: unrelated organizations get the same 404 as a
    // nonexistent draw — existence is not disclosed.
    if (!draw || !draws.canAccessDraw(user!, draw)) {
      sendHtml(res, renderError(navFor(user!, "draws"), "Draw not found", "No draw request exists at this address."), 404);
      return;
    }
    const tabParam = (url.searchParams.get("tab") ?? "overview") as DrawTab;
    const tab: DrawTab = ([
      "overview", "lines", "evidence", "documents", "exceptions", "review", "governance", "activity", "lender",
    ] as DrawTab[]).includes(tabParam)
      ? tabParam
      : "overview";
    const noticeErr = url.searchParams.get("err");
    const notice = noticeErr
      ? ({ kind: "err", text: noticeErr.slice(0, 300) } as const)
      : url.searchParams.get("ok")
        ? ({ kind: "ok", text: "Recorded." } as const)
        : null;
    sendHtml(res, renderDrawDetail(assembleDrawDetail(user!, draw, tab, notice)));
    return;
  }

  const permitRegisterMatch = /^\/project\/([^/]+)\/permits$/.exec(pathname);
  if (method === "GET" && permitRegisterMatch) {
    const project = repo.getProject(permitRegisterMatch[1]);
    if (!project || !budget.canAccessProjectFinance(user!, project)) {
      sendHtml(res, renderError(navFor(user!, "projects"), "Project not found", "No project exists at this address."), 404);
      return;
    }
    const filters = {
      status: url.searchParams.get("status") ?? undefined,
      type: url.searchParams.get("type") ?? undefined,
      authority: url.searchParams.get("authority") ?? undefined,
      milestone: url.searchParams.get("milestone") ?? undefined,
      expiration: url.searchParams.get("expiration") ?? undefined,
    };
    const all = permits.permitRegister(user!, project.id, {});
    sendHtml(
      res,
      renderPermitRegister({
        nav: navFor(user!, "projects"),
        project,
        rows: permits.permitRegister(user!, project.id, {
          status: filters.status,
          permitType: filters.type,
          authority: filters.authority,
          milestoneId: filters.milestone,
          expiration: filters.expiration,
        }),
        milestones: repo.listMilestones(project.id).filter((m) => !m.archived),
        filters,
        canRecord: ["FUNDER_REP", "COMPLIANCE_REVIEWER", "PROJECT_MANAGER"].includes(user!.role),
        canDetermine: ["FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(user!.role),
        types: [...new Set(all.map((r) => r.permit.permitType))].sort(),
        authorities: [...new Set(all.map((r) => r.permit.issuingAuthority).filter((x): x is string => Boolean(x)))].sort(),
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

  // Read-only approval register export. Reuses the exact same queue the
  // Approvals page renders from — no governance or financial state is touched.
  if (method === "GET" && pathname === "/approvals/export.csv") {
    const usersMap = usersById();
    const body = auditPackages.csv(
      [
        "approval_request_id",
        "project",
        "milestone",
        "tranche_amount",
        "status",
        "approvals_recorded",
        "approvals_required",
        "required_roles",
        "awaiting_roles",
        "recorded_decisions",
        "created_at",
        "released_at",
      ],
      approvalQueue(user!).map((item) => {
        const recorded = item.records.filter((r) => r.decision === "APPROVED").length;
        const awaiting = item.approval.requiredRoles.filter(
          (role) => !item.records.some((r) => r.role === role)
        );
        return [
          item.approval.id,
          item.project.name,
          `M${item.milestone.seq} · ${item.milestone.title}`,
          item.milestone.trancheAmount,
          item.approval.status,
          recorded,
          item.approval.requiredRoles.length,
          item.approval.requiredRoles.join("; "),
          awaiting.join("; "),
          item.records
            .map((r) => `${usersMap.get(r.userId)?.name ?? r.userId} (${r.role}): ${r.decision} @ ${r.createdAt}`)
            .join(" | "),
          item.approval.createdAt,
          item.releasedAt ?? "",
        ];
      })
    );
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="obv-approvals-register.csv"',
      "Cache-Control": "no-cache",
    });
    res.end(body);
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
    // Read-only presentation context: the verification each entry ledgered.
    const verificationByEntry = new Map(
      ledger.map((e) => [e.id, repo.getVerificationForEvidence(e.evidenceItemId)])
    );
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
        verificationByEntry,
        projectFilter: url.searchParams.get("project") ?? "",
        lastCheckAt: lastCheck?.createdAt ?? null,
        checkedBanner: url.searchParams.get("checked")
          ? chain.valid
            ? `Integrity check complete: ${chain.entries} entries recomputed — chain intact.`
            : `Integrity check complete: tampering detected at entry ${chain.brokenAt}.`
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
        auditPackages: repo
          .listProjects()
          .filter((p) => budget.canAccessProjectFinance(user!, p))
          .flatMap((p) => repo.listAuditPackagesForProject(p.id))
          .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
        canGenerateAudit: ["FUNDER_REP", "PROJECT_MANAGER", "COMPLIANCE_REVIEWER"].includes(user!.role),
        canIncludeMedia: ["FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(user!.role),
        apReady: url.searchParams.get("apReady"),
        apError: url.searchParams.get("apError"),
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
        const milestone = repo.getMilestone(approval.milestoneId!)!;
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
    await exceptions.evaluateExceptions();
    const chain = await wormEvidenceStore.verifyChain();
    sendHtml(
      res,
      renderIntelligence({
        nav: navFor(user!, "insights"),
        data: computeIntelligence({ chainValid: chain.valid }),
      })
    );
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
    // Presentation-only filters: the register narrows what is shown; the
    // underlying records and their truth are untouched.
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
        filters: {
          severity: url.searchParams.get("severity") ?? "",
          status: url.searchParams.get("status") ?? "",
          category: url.searchParams.get("category") ?? "",
          overdue: url.searchParams.get("overdue") ?? "",
        },
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
    const known = err instanceof SubmissionError || err instanceof DrawError || err instanceof BudgetError || err instanceof ExceptionError || err instanceof ChangeOrderError || err instanceof RetainageError || err instanceof AuditPackageError || err instanceof GateError || err instanceof PermitError || err instanceof LenderError;
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
