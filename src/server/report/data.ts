/**
 * Funder-report data assembly — reads ONLY existing application records
 * (projects, milestones, evidence, verifications, approvals, virtual
 * account events, ledger, notifications). Nothing here is hard-coded
 * report content; regenerating after state changes reflects current data.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as repo from "../db/repo";
import { WORM_DIR } from "../db/index";
import { virtualAccountService } from "../services/VirtualAccountService";
import { wormEvidenceStore } from "../services/WormEvidenceStore";
import type {
  ApprovalRecord,
  ApprovalRequest,
  EvidenceItem,
  LedgerEntry,
  Milestone,
  Organization,
  Project,
  User,
  Verification,
  VirtualAccountEvent,
} from "../../shared/types";

export interface ReportMilestone {
  milestone: Milestone;
  evidence: Array<{
    evidence: EvidenceItem;
    verification: Verification | null;
    ledgerEntry: LedgerEntry | null;
    submittedBy: User | null;
    /** Whether the photo file exists on disk (missing images degrade gracefully). */
    photoAvailable: boolean;
  }>;
  approval: ApprovalRequest | null;
  approvalRecords: ApprovalRecord[];
  releasedAt: string | null;
  releaseEventId: string | null;
}

export interface TimelineEvent {
  timestamp: string;
  event: string;
  actor: string | null;
  context: string;
  detail: string | null;
}

export interface FunderReportData {
  generatedAt: string;
  generatedBy: User;
  project: Project;
  funder: Organization | null;
  implementingOrg: Organization | null;
  totals: {
    budget: number;
    released: number;
    held: number;
    releasedPct: number;
  };
  counts: {
    milestones: number;
    verified: number; // reached VERIFIED or beyond
    needsReview: number;
    rejectedEvidence: number;
    pendingApprovals: number;
    flaggedEvidence: number;
  };
  financialClose: string | null; // earliest virtual-account event
  milestones: ReportMilestone[];
  accountEvents: VirtualAccountEvent[];
  governance: {
    totalRequests: number;
    approved: number;
    pending: number;
    rejected: number;
    amountAwaiting: number;
    amountReleasedAfterGovernance: number;
  };
  ledger: LedgerEntry[];
  integrity: { valid: boolean; entries: number; brokenAt?: number; checkedAt: string };
  timeline: TimelineEvent[];
}

export async function assembleReportData(
  projectId: string,
  generatedBy: User
): Promise<FunderReportData | null> {
  const project = repo.getProject(projectId);
  if (!project) return null;

  const funder = repo.getOrganization(project.organizationId);
  const pm = repo.listUsers().find((u) => u.role === "PROJECT_MANAGER");
  const implementingOrg = pm ? repo.getOrganization(pm.organizationId) : null;
  const users = new Map(repo.listUsers().map((u) => [u.id, u]));

  const summary = await virtualAccountService.getProjectSummary(project.id);
  const accountEvents = repo.listAccountEventsForProject(project.id);

  const milestones: ReportMilestone[] = repo.listMilestones(project.id).map((milestone) => {
    const approval = repo.getApprovalRequestForMilestone(milestone.id);
    const releaseEvent = accountEvents.find(
      (e) => e.milestoneId === milestone.id && e.type === "RELEASED"
    );
    return {
      milestone,
      evidence: repo.listEvidenceForMilestone(milestone.id).map((evidence) => ({
        evidence,
        verification: repo.getVerificationForEvidence(evidence.id),
        ledgerEntry: repo.getLedgerEntryForEvidence(evidence.id),
        submittedBy: users.get(evidence.userId) ?? null,
        photoAvailable: photoExists(evidence.photoPath),
      })),
      approval,
      approvalRecords: approval ? repo.listApprovalRecordsForRequest(approval.id) : [],
      releasedAt: releaseEvent?.createdAt ?? null,
      releaseEventId: releaseEvent?.id ?? null,
    };
  });

  const allVerifications = milestones.flatMap((m) =>
    m.evidence.map((e) => e.verification).filter(Boolean)
  ) as Verification[];

  const pendingApprovals = milestones.filter((m) => m.approval?.status === "PENDING");
  const approvedRequests = milestones.filter((m) => m.approval?.status === "APPROVED");
  const rejectedRequests = milestones.filter((m) => m.approval?.status === "REJECTED");

  const integrityResult = await wormEvidenceStore.verifyChain();
  const integrity = { ...integrityResult, checkedAt: new Date().toISOString() };

  // ---- activity timeline from primary records ----
  const timeline: TimelineEvent[] = [];
  for (const m of milestones) {
    const ctx = `M${m.milestone.seq}: ${m.milestone.title}`;
    for (const e of m.evidence) {
      timeline.push({
        timestamp: e.evidence.uploadedAt,
        event: "Evidence submitted",
        actor: e.submittedBy?.name ?? null,
        context: ctx,
        detail: e.evidence.isDemoFallback ? "demo fallback" : "live capture",
      });
      if (e.verification) {
        timeline.push({
          timestamp: e.verification.createdAt,
          event: "Verification completed",
          actor:
            e.verification.source === "LIVE_AI"
              ? "Live multimodal visual assessment"
              : "Demo fallback visual assessment",
          context: ctx,
          detail: `${e.verification.verdict.replace(/_/g, " ")} · confidence ${e.verification.confidence.toFixed(2)}`,
        });
      }
      if (e.ledgerEntry) {
        timeline.push({
          timestamp: e.ledgerEntry.timestamp,
          event: "Ledger entry created",
          actor: null,
          context: ctx,
          detail: `entry #${e.ledgerEntry.seq}`,
        });
      }
    }
    if (m.approval) {
      timeline.push({
        timestamp: m.approval.createdAt,
        event: "Approval requested",
        actor: null,
        context: ctx,
        detail: m.approval.requiredRoles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(" + "),
      });
      for (const rec of m.approvalRecords) {
        timeline.push({
          timestamp: rec.createdAt,
          event: rec.decision === "APPROVED" ? "Approval recorded" : "Approval rejected",
          actor: users.get(rec.userId)?.name ?? rec.role,
          context: ctx,
          detail: rec.role.replace(/_/g, " ").toLowerCase(),
        });
      }
    }
    if (m.releasedAt) {
      timeline.push({
        timestamp: m.releasedAt,
        event: "Tranche released",
        actor: null,
        context: ctx,
        detail: "$" + m.milestone.trancheAmount.toLocaleString("en-US"),
      });
    }
  }
  for (const n of repo.listNotifications(200)) {
    if (n.type === "INTEGRITY_CHECK" || n.type === "DEMO_RESET") {
      timeline.push({
        timestamp: n.createdAt,
        event: n.type === "INTEGRITY_CHECK" ? "Integrity verification run" : "Demo reset",
        actor: null,
        context: "—",
        detail: n.type === "INTEGRITY_CHECK" ? (n.message.includes("INTACT") ? "chain intact" : "tampering detected") : null,
      });
    }
  }
  timeline.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

  return {
    generatedAt: new Date().toISOString(),
    generatedBy,
    project,
    funder,
    implementingOrg,
    totals: {
      budget: summary.totalBudget,
      released: summary.released,
      held: summary.held,
      releasedPct:
        summary.totalBudget > 0 ? Math.round((summary.released / summary.totalBudget) * 100) : 0,
    },
    counts: {
      milestones: milestones.length,
      verified: milestones.filter((m) =>
        ["VERIFIED", "APPROVED", "RELEASED"].includes(m.milestone.status)
      ).length,
      needsReview: allVerifications.filter((v) => v.verdict === "NEEDS_REVIEW").length,
      rejectedEvidence: allVerifications.filter((v) => v.verdict === "REJECTED").length,
      pendingApprovals: pendingApprovals.length,
      flaggedEvidence: allVerifications.filter((v) => v.verdict !== "VERIFIED").length,
    },
    financialClose: accountEvents.length > 0 ? accountEvents[0].createdAt : null,
    milestones,
    accountEvents,
    governance: {
      totalRequests: milestones.filter((m) => m.approval).length,
      approved: approvedRequests.length,
      pending: pendingApprovals.length,
      rejected: rejectedRequests.length,
      amountAwaiting: pendingApprovals.reduce((s, m) => s + m.milestone.trancheAmount, 0),
      amountReleasedAfterGovernance: approvedRequests
        .filter((m) => m.milestone.accountStatus === "RELEASED")
        .reduce((s, m) => s + m.milestone.trancheAmount, 0),
    },
    ledger: repo.listLedgerEntries(),
    integrity,
    timeline,
  };
}

function photoExists(photoPath: string): boolean {
  try {
    const rel = photoPath.replace(/^\//, "");
    const file = photoPath.startsWith("/worm/")
      ? path.join(WORM_DIR, rel.slice("worm/".length))
      : path.join(process.cwd(), "public", rel);
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** OBV_<slug>_Verification_Report_<date>.pdf */
export function reportFilename(project: Project, generatedAt: string): string {
  const slug = project.name
    .normalize("NFKD")
    .replace(/[^\w\s()-]/g, " ")
    .replace(/[()]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/-$/, "");
  return `OBV_${slug}_Verification_Report_${generatedAt.slice(0, 10)}.pdf`;
}
