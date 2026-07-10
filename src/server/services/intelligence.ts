/**
 * OBV Intelligence — deterministic operational intelligence computed from
 * recorded OBV data only.
 *
 * READ-ONLY. This module derives counts, signals, attention levels and
 * recommended actions from existing evidence, verification, governance,
 * field-issue, clarification and financial records. It never writes, never
 * predicts, and never invents records: every number traces to rows in the
 * repository, and every rule is listed in ATTENTION_RULES below.
 *
 * No generative model is involved. The only AI in OBV remains the visual
 * assessment inside verification, and its provenance (LIVE_AI /
 * MOCK_FALLBACK / MOCK_DEFAULT) is surfaced honestly here.
 */
import * as repo from "../db/repo";
// Read-only draw helpers (document checklist derivation). Nothing in this
// module can write draw state or reach the approval/financial paths.
import * as drawsService from "./draws";
import type {
  ApprovalRequest,
  ClarificationRequest,
  EvidenceItem,
  FieldIssue,
  Milestone,
  Project,
  UserRole,
  Verification,
  VerificationSource,
} from "../../shared/types";

// ------------------------------------------------------------------ types

export type IntelSeverity = "HIGH" | "MEDIUM" | "INFO";

export interface IntelSignal {
  severity: IntelSeverity;
  /** Deterministic rule that produced this signal (documented). */
  rule: string;
  projectName: string;
  /** e.g. "M3 · Gravel base course" — null for project-level signals. */
  milestoneLabel: string | null;
  reason: string;
  /** Age of the underlying record, human-formatted ("4d", "6h"), or null. */
  age: string | null;
  actionLabel: string;
  actionHref: string;
}

export interface IntelSummary {
  activeProjects: number;
  projectsNeedingAttention: number;
  highSeverityIssues: number;
  evidenceNeedsReview: number;
  pendingApprovals: number;
  openClarifications: number;
  integrityAlerts: number;
}

export interface VerificationIntel {
  total: number;
  verified: number;
  needsReview: number;
  rejected: number;
  /** verified / total, 0..100, null when no verifications exist. */
  verificationRatePct: number | null;
  avgConfidence: number | null;
  /** Failed-check names ranked by frequency (real check records). */
  reviewReasons: Array<{ reason: string; count: number }>;
  geofenceExceptions: number;
  metadataExceptions: number;
  demoFallbackEvidence: number;
  provenance: Array<{ source: VerificationSource; label: string; count: number }>;
  /** Month buckets, oldest first — only when >= 2 distinct months exist. */
  trend: Array<{ month: string; total: number; verified: number }> | null;
  recent: Array<{
    verdict: Verification["verdict"];
    confidence: number;
    milestoneLabel: string;
    projectName: string;
    href: string;
    createdAt: string;
  }>;
}

export interface GovernanceIntel {
  pending: number;
  partiallyApproved: number;
  /** Mean hours from request creation to final approval; null if none resolved. */
  avgApprovalHours: number | null;
  awaitingByRole: Array<{ role: UserRole; count: number }>;
  oldestPending: { label: string; age: string; href: string } | null;
  fundsHeldPendingGovernance: number;
  totalHeld: number;
  totalReleased: number;
}

export interface FieldRiskIntel {
  openIssues: number;
  highCritical: number;
  overdue: number;
  awaitingFieldResponse: number;
  openClarifications: number;
  oldestOpenIssue: { title: string; age: string; href: string } | null;
  byCategory: Array<{ category: string; open: number }>;
  bySeverity: Array<{ severity: string; open: number }>;
}

export type AttentionLevel = "HIGH" | "MEDIUM" | "LOW";
export type HealthState = "HEALTHY" | "WATCH" | "AT_RISK";

export interface ProjectAttentionRow {
  projectId: string;
  name: string;
  progressPct: number;
  currentGate: string;
  evidenceState: string;
  pendingGovernance: number;
  openIssues: number;
  openClarifications: number;
  fundsHeld: number;
  attention: AttentionLevel;
  health: HealthState;
  /** The exact factors that produced the attention level (explainable). */
  reasons: string[];
}

export interface Recommendation {
  priority: IntelSeverity;
  title: string;
  why: string;
  /** Human-readable source record references, e.g. "Field issue issue-1". */
  sources: string[];
  actionLabel: string;
  actionHref: string;
}

export interface IntelligenceData {
  summary: IntelSummary;
  signals: IntelSignal[];
  verification: VerificationIntel;
  governance: GovernanceIntel;
  fieldRisk: FieldRiskIntel;
  projects: ProjectAttentionRow[];
  recommendations: Recommendation[];
  chainValid: boolean;
  generatedAt: string;
}

/**
 * DETERMINISTIC ATTENTION RULES (documented; shown on the page).
 *
 * HIGH    — open CRITICAL or HIGH field issue; outstanding REJECTED
 *           evidence; ledger integrity alert; milestone past its
 *           configured planned end date and not released.
 * MEDIUM  — outstanding NEEDS_REVIEW evidence; approval request pending
 *           longer than 48 hours; clarification open longer than 3 days or
 *           past its due date; open MEDIUM field issue.
 * LOW     — none of the above: normal active workflow.
 *
 * Health mirrors attention: AT_RISK = HIGH, WATCH = MEDIUM, HEALTHY = LOW.
 */
export const ATTENTION_RULES: Array<{ level: AttentionLevel; rule: string }> = [
  { level: "HIGH", rule: "Open CRITICAL or HIGH severity field issue" },
  { level: "HIGH", rule: "Evidence rejected by verification and not yet superseded" },
  { level: "HIGH", rule: "Evidence ledger integrity alert" },
  { level: "HIGH", rule: "Milestone past its configured planned end date and not released" },
  { level: "MEDIUM", rule: "Evidence flagged NEEDS_REVIEW awaiting reviewer decision" },
  { level: "MEDIUM", rule: "Approval request pending longer than 48 hours" },
  { level: "MEDIUM", rule: "Clarification open longer than 3 days or past its due date" },
  { level: "MEDIUM", rule: "Open MEDIUM severity field issue" },
  { level: "LOW", rule: "Normal active workflow" },
];

// ---------------------------------------------------------------- helpers

const DAY = 86_400_000;
const OPEN_ISSUE_STATES = new Set(["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_FIELD_RESPONSE"]);
const OPEN_CLAR_STATES = new Set(["OPEN", "REOPENED"]);

function ageOf(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < DAY) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / DAY)}d`;
}

function msLabel(m: Milestone): string {
  return `M${m.seq} · ${m.title.split(",")[0]}`;
}

const SOURCE_LABELS: Record<VerificationSource, string> = {
  LIVE_AI: "Live AI visual assessment",
  MOCK_FALLBACK: "Demo fallback assessment",
  MOCK_DEFAULT: "Deterministic mock assessment",
};

// ------------------------------------------------------------------ main

export function computeIntelligence(opts: { chainValid: boolean }): IntelligenceData {
  const now = Date.now();
  const projects = repo.listProjects().filter((p) => p.status === "ACTIVE");
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const milestones: Milestone[] = [];
  const milestonesByProject = new Map<string, Milestone[]>();
  for (const p of projects) {
    const ms = repo.listMilestones(p.id).filter((m) => !m.archived);
    milestonesByProject.set(p.id, ms);
    milestones.push(...ms);
  }
  const milestoneById = new Map(milestones.map((m) => [m.id, m]));

  const evidence = repo.listAllEvidence().filter((e) => milestoneById.has(e.milestoneId));
  const verifications = repo
    .listAllVerifications()
    .filter((v) => evidence.some((e) => e.id === v.evidenceItemId));
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));

  // Latest verification per evidence item (list is created_at DESC).
  const latestVerification = new Map<string, Verification>();
  for (const v of verifications) {
    if (!latestVerification.has(v.evidenceItemId)) latestVerification.set(v.evidenceItemId, v);
  }

  const allIssues = repo.listFieldIssues().filter((i) => projectById.has(i.projectId));
  const openIssues = allIssues.filter((i) => OPEN_ISSUE_STATES.has(i.status));
  const clarifications = repo
    .listClarifications()
    .filter((c) => milestoneById.has(c.milestoneId));
  const openClars = clarifications.filter((c) => OPEN_CLAR_STATES.has(c.status));

  const pendingApprovals = repo
    .listPendingApprovalRequests()
    .filter((a) => milestoneById.has(a.milestoneId!));
  const approvalRecords = new Map(
    pendingApprovals.map((a) => [a.id, repo.listApprovalRecordsForRequest(a.id)]),
  );

  // Outstanding review/rejection: latest verdict on an evidence item whose
  // milestone is still in an evidence-gathering state.
  const outstandingReview: EvidenceItem[] = [];
  const outstandingRejected: EvidenceItem[] = [];
  for (const [evId, v] of latestVerification) {
    const ev = evidenceById.get(evId)!;
    const m = milestoneById.get(ev.milestoneId)!;
    if (m.status !== "UNDER_REVIEW" && m.status !== "PENDING_EVIDENCE") continue;
    if (v.verdict === "NEEDS_REVIEW") outstandingReview.push(ev);
    if (v.verdict === "REJECTED") outstandingRejected.push(ev);
  }

  // ------------------------------------------------------------- signals
  const signals: IntelSignal[] = [];
  const projName = (id: string) => projectById.get(id)?.name ?? id;

  if (!opts.chainValid) {
    signals.push({
      severity: "HIGH",
      rule: "ledger-integrity",
      projectName: "All projects",
      milestoneLabel: null,
      reason: "Evidence ledger hash chain failed its last integrity verification.",
      age: null,
      actionLabel: "Verify ledger",
      actionHref: "/ledger",
    });
  }

  for (const issue of openIssues) {
    if (issue.severity !== "CRITICAL" && issue.severity !== "HIGH") continue;
    const m = issue.milestoneId ? milestoneById.get(issue.milestoneId) : null;
    signals.push({
      severity: "HIGH",
      rule: "unresolved-high-issue",
      projectName: projName(issue.projectId),
      milestoneLabel: m ? msLabel(m) : null,
      reason: `${issue.severity} ${issue.category} issue "${issue.title}" is ${issue.status.replace(/_/g, " ").toLowerCase()}.`,
      age: ageOf(issue.createdAt, now),
      actionLabel: "Open issue",
      actionHref: `/issue/${issue.id}`,
    });
  }

  for (const ev of outstandingRejected) {
    const m = milestoneById.get(ev.milestoneId)!;
    signals.push({
      severity: "HIGH",
      rule: "rejected-evidence",
      projectName: projName(m.projectId),
      milestoneLabel: msLabel(m),
      reason: "Latest evidence submission was REJECTED by verification.",
      age: ageOf(ev.uploadedAt, now),
      actionLabel: "Open evidence",
      actionHref: `/milestone/${m.id}`,
    });
  }

  for (const m of milestones) {
    if (m.status === "RELEASED" || !m.plannedEnd) continue;
    if (Date.parse(m.plannedEnd) < now) {
      signals.push({
        severity: "HIGH",
        rule: "milestone-overdue",
        projectName: projName(m.projectId),
        milestoneLabel: msLabel(m),
        reason: `Milestone is past its configured planned end (${m.plannedEnd.slice(0, 10)}) and not released.`,
        age: ageOf(m.plannedEnd, now),
        actionLabel: "Open milestone",
        actionHref: `/milestone/${m.id}`,
      });
    }
  }

  for (const ev of outstandingReview) {
    const m = milestoneById.get(ev.milestoneId)!;
    const v = latestVerification.get(ev.id)!;
    const failed = v.checks.filter((c) => !c.passed).map((c) => c.name);
    signals.push({
      severity: "MEDIUM",
      rule: "needs-review-evidence",
      projectName: projName(m.projectId),
      milestoneLabel: msLabel(m),
      reason: `Evidence routed to NEEDS_REVIEW${failed.length ? ` (${failed.join("; ")})` : ""} — awaiting reviewer decision.`,
      age: ageOf(ev.uploadedAt, now),
      actionLabel: "Open evidence",
      actionHref: `/milestone/${m.id}`,
    });
  }

  // Repeated NEEDS_REVIEW routing per milestone (2+ historical flags).
  const reviewCounts = new Map<string, number>();
  for (const v of verifications) {
    if (v.verdict !== "NEEDS_REVIEW") continue;
    const ev = evidenceById.get(v.evidenceItemId);
    if (ev) reviewCounts.set(ev.milestoneId, (reviewCounts.get(ev.milestoneId) ?? 0) + 1);
  }
  for (const [milestoneId, count] of reviewCounts) {
    if (count < 2) continue;
    const m = milestoneById.get(milestoneId)!;
    signals.push({
      severity: "MEDIUM",
      rule: "repeated-needs-review",
      projectName: projName(m.projectId),
      milestoneLabel: msLabel(m),
      reason: `${count} submissions for this milestone have been routed to NEEDS_REVIEW.`,
      age: null,
      actionLabel: "Open milestone",
      actionHref: `/milestone/${m.id}`,
    });
  }

  for (const approval of pendingApprovals) {
    const m = milestoneById.get(approval.milestoneId!)!;
    const ageH = (now - Date.parse(approval.createdAt)) / 3_600_000;
    const records = approvalRecords.get(approval.id) ?? [];
    const recorded = new Set(records.map((r) => r.role));
    const awaiting = approval.requiredRoles.filter((r) => !recorded.has(r));
    if (ageH > 48) {
      signals.push({
        severity: "MEDIUM",
        rule: "approval-pending-delay",
        projectName: projName(m.projectId),
        milestoneLabel: msLabel(m),
        reason: `Release approval pending ${Math.round(ageH / 24)} days — awaiting ${awaiting.map(roleName).join(", ") || "final decision"}. $${m.trancheAmount.toLocaleString("en-US")} remains HELD.`,
        age: ageOf(approval.createdAt, now),
        actionLabel: "Open approval",
        actionHref: "/approvals",
      });
    } else if (awaiting.length > 0 && records.length > 0) {
      signals.push({
        severity: "MEDIUM",
        rule: "tranche-held-awaiting-role",
        projectName: projName(m.projectId),
        milestoneLabel: msLabel(m),
        reason: `Tranche of $${m.trancheAmount.toLocaleString("en-US")} remains HELD awaiting ${awaiting.map(roleName).join(", ")} (${records.length} of ${approval.requiredRoles.length} roles recorded).`,
        age: ageOf(approval.createdAt, now),
        actionLabel: "Open approval",
        actionHref: "/approvals",
      });
    } else {
      signals.push({
        severity: "INFO",
        rule: "approval-in-queue",
        projectName: projName(m.projectId),
        milestoneLabel: msLabel(m),
        reason: `Verified evidence awaiting governance — $${m.trancheAmount.toLocaleString("en-US")} held pending ${awaiting.map(roleName).join(" and ")}.`,
        age: ageOf(approval.createdAt, now),
        actionLabel: "Open approval",
        actionHref: "/approvals",
      });
    }
  }

  for (const clar of openClars) {
    const m = milestoneById.get(clar.milestoneId)!;
    const overdue = clar.dueAt !== null && Date.parse(clar.dueAt) < now;
    const old = now - Date.parse(clar.createdAt) > 3 * DAY;
    signals.push({
      severity: overdue || old ? "MEDIUM" : "INFO",
      rule: overdue ? "clarification-overdue" : "clarification-open",
      projectName: projName(m.projectId),
      milestoneLabel: msLabel(m),
      reason: `Clarification "${clar.question.slice(0, 80)}${clar.question.length > 80 ? "…" : ""}" is awaiting a ${clar.responseType.replace(/_/g, " ").toLowerCase()} response${overdue ? " and is past its due date" : ""}.`,
      age: ageOf(clar.createdAt, now),
      actionLabel: "Open milestone",
      actionHref: `/milestone/${m.id}`,
    });
  }

  // Multiple evidence items missing GPS on one project.
  const noGpsByProject = new Map<string, number>();
  for (const ev of evidence) {
    if (ev.latitude !== null) continue;
    const m = milestoneById.get(ev.milestoneId)!;
    noGpsByProject.set(m.projectId, (noGpsByProject.get(m.projectId) ?? 0) + 1);
  }
  for (const [projectId, count] of noGpsByProject) {
    if (count < 2) continue;
    signals.push({
      severity: "MEDIUM",
      rule: "missing-gps-pattern",
      projectName: projName(projectId),
      milestoneLabel: null,
      reason: `${count} evidence items on this project were submitted without a GPS fix.`,
      age: null,
      actionLabel: "Open evidence review",
      actionHref: "/compliance",
    });
  }

  // Repeated metadata integrity exceptions across the portfolio.
  let metadataExceptions = 0;
  let geofenceExceptions = 0;
  for (const v of verifications) {
    for (const c of v.checks) {
      if (c.passed) continue;
      const n = c.name.toLowerCase();
      if (n.includes("geofence") || n.includes("gps")) geofenceExceptions++;
      if (n.includes("metadata") || n.includes("timestamp")) metadataExceptions++;
    }
  }
  if (metadataExceptions >= 2) {
    signals.push({
      severity: "MEDIUM",
      rule: "repeated-metadata-exceptions",
      projectName: "Portfolio",
      milestoneLabel: null,
      reason: `${metadataExceptions} metadata/timestamp integrity exceptions recorded across verifications.`,
      age: null,
      actionLabel: "Open evidence review",
      actionHref: "/compliance",
    });
  }

  // Low-confidence verified evidence (informational spot-check cue).
  for (const [evId, v] of latestVerification) {
    if (v.verdict !== "VERIFIED" || v.confidence >= 0.75) continue;
    const ev = evidenceById.get(evId)!;
    const m = milestoneById.get(ev.milestoneId)!;
    signals.push({
      severity: "INFO",
      rule: "low-confidence-verification",
      projectName: projName(m.projectId),
      milestoneLabel: msLabel(m),
      reason: `Verified at confidence ${v.confidence.toFixed(2)} — consider a spot check.`,
      age: ageOf(v.createdAt, now),
      actionLabel: "Open evidence",
      actionHref: `/milestone/${m.id}`,
    });
  }

  // Delayed uploads (capture -> upload gap over 24h) — informational.
  for (const ev of evidence) {
    const gap = Date.parse(ev.uploadedAt) - Date.parse(ev.capturedAt);
    if (gap <= DAY) continue;
    const m = milestoneById.get(ev.milestoneId)!;
    signals.push({
      severity: "INFO",
      rule: "delayed-upload",
      projectName: projName(m.projectId),
      milestoneLabel: msLabel(m),
      reason: `Evidence uploaded ${Math.round(gap / 3_600_000)}h after capture (offline queue window).`,
      age: ageOf(ev.uploadedAt, now),
      actionLabel: "Open evidence",
      actionHref: `/milestone/${m.id}`,
    });
  }

  // ---- draw request signals (grounded in stored draw state only) ----
  // Deterministic rules over the lender draw workflow: draw-awaiting-review,
  // draw-missing-documents, draw-supported-shortfall, draw-cost-ahead-of-
  // verified-progress, draw-governance-delay, draw-clarification-unanswered,
  // draw-exception-unresolved. No predictions — every figure traces to
  // draw_requests / draw_line_items / draw_documents / approval rows.
  const govSlaHours = Number(process.env.OBV_DRAW_GOVERNANCE_SLA_HOURS ?? 48);
  const drawLabel = (d: { drawNumber: number }) => `Draw #${d.drawNumber}`;
  const usd = (n: number) => "$" + n.toLocaleString("en-US");
  for (const draw of repo.listDrawRequests()) {
    if (!projectById.has(draw.projectId)) continue;
    if (["CANCELLED", "RELEASED", "DRAFT"].includes(draw.status)) continue;
    const lines = repo.listDrawLines(draw.id);
    const href = `/draw/${draw.id}`;

    if (draw.status === "SUBMITTED") {
      const ageH = (now - Date.parse(draw.submittedAt ?? draw.createdAt)) / 3_600_000;
      signals.push({
        severity: ageH > 48 ? "MEDIUM" : "INFO",
        rule: "draw-awaiting-review",
        projectName: projName(draw.projectId),
        milestoneLabel: drawLabel(draw),
        reason: `${usd(draw.requestedAmount)} draw submitted with no line-item review recorded yet.`,
        age: ageOf(draw.submittedAt ?? draw.createdAt, now),
        actionLabel: "Open draw",
        actionHref: href,
      });
    }
    const missingDocs = drawsService.missingRequiredDocuments(draw.id);
    if (missingDocs.length > 0) {
      signals.push({
        severity: "MEDIUM",
        rule: "draw-missing-documents",
        projectName: projName(draw.projectId),
        milestoneLabel: drawLabel(draw),
        reason: `Required document${missingDocs.length > 1 ? "s" : ""} missing: ${missingDocs.map((d) => d.title).join(", ")}.`,
        age: null,
        actionLabel: "Open documents",
        actionHref: `${href}?tab=documents`,
      });
    }
    const supported = lines.reduce(
      (s, l) =>
        s +
        (l.status === "SUPPORTED"
          ? l.currentRequested
          : l.status === "PARTIALLY_SUPPORTED"
            ? l.supportedAmount ?? 0
            : 0),
      0,
    );
    if (lines.length > 0 && lines.every((l) => l.status !== "PENDING") && supported < draw.requestedAmount) {
      signals.push({
        severity: "MEDIUM",
        rule: "draw-supported-shortfall",
        projectName: projName(draw.projectId),
        milestoneLabel: drawLabel(draw),
        reason: `${usd(draw.requestedAmount)} requested vs ${usd(supported)} supported by review (${usd(draw.requestedAmount - supported)} exception).`,
        age: null,
        actionLabel: "Open exceptions",
        actionHref: `${href}?tab=exceptions`,
      });
    }
    const drawLinks = repo.listDrawEvidenceLinks(draw.id);
    for (const l of lines) {
      if (!l.milestoneId || (l.percentCompleteClaimed ?? 0) <= 0) continue;
      const m = milestoneById.get(l.milestoneId);
      const msVerified = m && ["VERIFIED", "APPROVED", "RELEASED"].includes(m.status);
      const hasVerifiedEvidence = drawLinks.some((k) => {
        const ev = evidenceById.get(k.evidenceItemId);
        return (
          ev?.milestoneId === l.milestoneId &&
          latestVerification.get(k.evidenceItemId)?.verdict === "VERIFIED"
        );
      });
      if (!msVerified && !hasVerifiedEvidence) {
        signals.push({
          severity: "MEDIUM",
          rule: "draw-cost-ahead-of-verified-progress",
          projectName: projName(draw.projectId),
          milestoneLabel: m ? msLabel(m) : drawLabel(draw),
          reason: `${drawLabel(draw)} line "${l.description}" claims ${l.percentCompleteClaimed}% complete, but the milestone has no verified evidence.`,
          age: null,
          actionLabel: "Open line items",
          actionHref: `${href}?tab=lines`,
        });
      }
    }
    const exceptions = lines.filter((l) => ["EXCEPTION", "REJECTED"].includes(l.status));
    if (exceptions.length > 0) {
      signals.push({
        severity: "MEDIUM",
        rule: "draw-exception-unresolved",
        projectName: projName(draw.projectId),
        milestoneLabel: drawLabel(draw),
        reason: `${exceptions.length} exception/rejected line(s) totalling ${usd(exceptions.reduce((s, l) => s + l.currentRequested, 0))} remain unresolved.`,
        age: null,
        actionLabel: "Open exceptions",
        actionHref: `${href}?tab=exceptions`,
      });
    }
    if (draw.status === "CLARIFICATION_REQUIRED") {
      signals.push({
        severity: "MEDIUM",
        rule: "draw-clarification-unanswered",
        projectName: projName(draw.projectId),
        milestoneLabel: drawLabel(draw),
        reason: "A reviewer clarification is awaiting the requester's response.",
        age: ageOf(draw.updatedAt, now),
        actionLabel: "Open review",
        actionHref: `${href}?tab=review`,
      });
    }
    if (draw.status === "READY_FOR_GOVERNANCE") {
      const approval = repo.getApprovalRequestForDraw(draw.id);
      const ageH = approval ? (now - Date.parse(approval.createdAt)) / 3_600_000 : 0;
      signals.push({
        severity: ageH > govSlaHours ? "MEDIUM" : "INFO",
        rule: ageH > govSlaHours ? "draw-governance-delay" : "draw-awaiting-governance",
        projectName: projName(draw.projectId),
        milestoneLabel: drawLabel(draw),
        reason:
          ageH > govSlaHours
            ? `Awaiting formal approval for ${Math.round(ageH)}h (threshold ${govSlaHours}h). ${usd(draw.recommendedAmount ?? draw.requestedAmount)} recommended (advisory).`
            : `${usd(draw.recommendedAmount ?? draw.requestedAmount)} recommended (advisory) — awaiting the formal approval matrix.`,
        age: approval ? ageOf(approval.createdAt, now) : null,
        actionLabel: "Open governance",
        actionHref: `${href}?tab=governance`,
      });
    }
  }

  const sevOrder: Record<IntelSeverity, number> = { HIGH: 0, MEDIUM: 1, INFO: 2 };
  signals.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  // ------------------------------------------------------- verification
  const verified = verifications.filter((v) => v.verdict === "VERIFIED").length;
  const needsReview = verifications.filter((v) => v.verdict === "NEEDS_REVIEW").length;
  const rejected = verifications.filter((v) => v.verdict === "REJECTED").length;

  const reasonCounts = new Map<string, number>();
  for (const v of verifications) {
    for (const c of v.checks) {
      if (!c.passed) reasonCounts.set(c.name, (reasonCounts.get(c.name) ?? 0) + 1);
    }
  }
  const provenanceCounts = new Map<VerificationSource, number>();
  for (const v of verifications) {
    provenanceCounts.set(v.source, (provenanceCounts.get(v.source) ?? 0) + 1);
  }

  const monthBuckets = new Map<string, { total: number; verified: number }>();
  for (const v of verifications) {
    const month = v.createdAt.slice(0, 7);
    const b = monthBuckets.get(month) ?? { total: 0, verified: 0 };
    b.total++;
    if (v.verdict === "VERIFIED") b.verified++;
    monthBuckets.set(month, b);
  }
  const trend =
    monthBuckets.size >= 2
      ? [...monthBuckets.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([month, b]) => ({ month, ...b }))
      : null;

  const verificationIntel: VerificationIntel = {
    total: verifications.length,
    verified,
    needsReview,
    rejected,
    verificationRatePct:
      verifications.length > 0 ? Math.round((verified / verifications.length) * 100) : null,
    avgConfidence:
      verifications.length > 0
        ? verifications.reduce((s, v) => s + v.confidence, 0) / verifications.length
        : null,
    reviewReasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4),
    geofenceExceptions,
    metadataExceptions,
    demoFallbackEvidence: evidence.filter((e) => e.isDemoFallback).length,
    provenance: (["LIVE_AI", "MOCK_FALLBACK", "MOCK_DEFAULT"] as VerificationSource[])
      .map((source) => ({ source, label: SOURCE_LABELS[source], count: provenanceCounts.get(source) ?? 0 }))
      .filter((p) => p.count > 0),
    trend,
    recent: verifications.slice(0, 5).map((v) => {
      const ev = evidenceById.get(v.evidenceItemId)!;
      const m = milestoneById.get(ev.milestoneId)!;
      return {
        verdict: v.verdict,
        confidence: v.confidence,
        milestoneLabel: msLabel(m),
        projectName: projName(m.projectId),
        href: `/milestone/${m.id}`,
        createdAt: v.createdAt,
      };
    }),
  };

  // --------------------------------------------------------- governance
  const allApprovalRequests: ApprovalRequest[] = projects.flatMap((p) =>
    repo.listApprovalRequestsForProject(p.id),
  );
  const resolvedDurations: number[] = [];
  for (const req of allApprovalRequests) {
    if (req.status !== "APPROVED") continue;
    const records = repo.listApprovalRecordsForRequest(req.id);
    if (records.length === 0) continue;
    const last = Math.max(...records.map((r) => Date.parse(r.createdAt)));
    resolvedDurations.push((last - Date.parse(req.createdAt)) / 3_600_000);
  }

  const awaitingByRole = new Map<UserRole, number>();
  for (const approval of pendingApprovals) {
    const recorded = new Set((approvalRecords.get(approval.id) ?? []).map((r) => r.role));
    for (const role of approval.requiredRoles) {
      if (!recorded.has(role)) awaitingByRole.set(role, (awaitingByRole.get(role) ?? 0) + 1);
    }
  }

  const oldestPendingReq = [...pendingApprovals].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : 1,
  )[0];
  const oldestMilestone = oldestPendingReq ? milestoneById.get(oldestPendingReq.milestoneId!)! : null;

  const governance: GovernanceIntel = {
    pending: pendingApprovals.length,
    partiallyApproved: pendingApprovals.filter((a) => (approvalRecords.get(a.id) ?? []).length > 0)
      .length,
    avgApprovalHours:
      resolvedDurations.length > 0
        ? resolvedDurations.reduce((s, h) => s + h, 0) / resolvedDurations.length
        : null,
    awaitingByRole: [...awaitingByRole.entries()]
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count),
    oldestPending:
      oldestPendingReq && oldestMilestone
        ? {
            label: msLabel(oldestMilestone),
            age: ageOf(oldestPendingReq.createdAt, now),
            href: "/approvals",
          }
        : null,
    fundsHeldPendingGovernance: pendingApprovals.reduce(
      (s, a) => s + (milestoneById.get(a.milestoneId!)?.trancheAmount ?? 0),
      0,
    ),
    totalHeld: milestones.filter((m) => m.accountStatus === "HELD").reduce((s, m) => s + m.trancheAmount, 0),
    totalReleased: milestones
      .filter((m) => m.accountStatus === "RELEASED")
      .reduce((s, m) => s + m.trancheAmount, 0),
  };

  // --------------------------------------------------------- field risk
  const catCounts = new Map<string, number>();
  for (const i of openIssues) catCounts.set(i.category, (catCounts.get(i.category) ?? 0) + 1);
  const sevCounts = new Map<string, number>();
  for (const i of openIssues) sevCounts.set(i.severity, (sevCounts.get(i.severity) ?? 0) + 1);
  const oldestIssue = [...openIssues].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];

  const fieldRisk: FieldRiskIntel = {
    openIssues: openIssues.length,
    highCritical: openIssues.filter((i) => i.severity === "HIGH" || i.severity === "CRITICAL").length,
    overdue: openIssues.filter((i) => i.dueAt && Date.parse(i.dueAt) < now).length,
    awaitingFieldResponse: openIssues.filter((i) => i.status === "AWAITING_FIELD_RESPONSE").length,
    openClarifications: openClars.length,
    oldestOpenIssue: oldestIssue
      ? { title: oldestIssue.title, age: ageOf(oldestIssue.createdAt, now), href: `/issue/${oldestIssue.id}` }
      : null,
    byCategory: [...catCounts.entries()]
      .map(([category, open]) => ({ category, open }))
      .sort((a, b) => b.open - a.open),
    bySeverity: (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const)
      .map((severity) => ({ severity, open: sevCounts.get(severity) ?? 0 }))
      .filter((s) => s.open > 0),
  };

  // ------------------------------------------------- project attention
  const rows: ProjectAttentionRow[] = projects.map((p) => {
    const ms = milestonesByProject.get(p.id) ?? [];
    const total = ms.reduce((s, m) => s + m.trancheAmount, 0);
    const released = ms
      .filter((m) => m.accountStatus === "RELEASED")
      .reduce((s, m) => s + m.trancheAmount, 0);
    const gateMilestone = [...ms].sort((a, b) => a.seq - b.seq).find((m) => m.status !== "RELEASED");
    const projIssues = openIssues.filter((i) => i.projectId === p.id);
    const projClars = openClars.filter((c) => milestoneById.get(c.milestoneId)?.projectId === p.id);
    const projPending = pendingApprovals.filter(
      (a) => milestoneById.get(a.milestoneId!)?.projectId === p.id,
    );
    const projReview = outstandingReview.filter(
      (e) => milestoneById.get(e.milestoneId)?.projectId === p.id,
    );
    const projRejected = outstandingRejected.filter(
      (e) => milestoneById.get(e.milestoneId)?.projectId === p.id,
    );

    const reasons: string[] = [];
    let anyHigh = false;
    let anyMedium = false;
    const raise = (level: "HIGH" | "MEDIUM", reason: string) => {
      reasons.push(reason);
      if (level === "HIGH") anyHigh = true;
      else anyMedium = true;
    };

    const highIssues = projIssues.filter((i) => i.severity === "HIGH" || i.severity === "CRITICAL");
    if (highIssues.length > 0)
      raise("HIGH", `${highIssues.length} open high/critical field issue${highIssues.length === 1 ? "" : "s"}`);
    if (projRejected.length > 0) raise("HIGH", "rejected evidence outstanding");
    if (!opts.chainValid) raise("HIGH", "ledger integrity alert");
    const overdueMs = ms.filter(
      (m) => m.status !== "RELEASED" && m.plannedEnd && Date.parse(m.plannedEnd) < now,
    );
    if (overdueMs.length > 0)
      raise("HIGH", `${overdueMs.length} milestone${overdueMs.length === 1 ? "" : "s"} past planned end`);

    if (projReview.length > 0)
      raise("MEDIUM", `${projReview.length} evidence item${projReview.length === 1 ? "" : "s"} awaiting review`);
    const delayed = projPending.filter((a) => now - Date.parse(a.createdAt) > 48 * 3_600_000);
    if (delayed.length > 0)
      raise("MEDIUM", `approval pending ${ageOf(delayed[0].createdAt, now)}`);
    const staleClars = projClars.filter(
      (c) => (c.dueAt && Date.parse(c.dueAt) < now) || now - Date.parse(c.createdAt) > 3 * DAY,
    );
    if (staleClars.length > 0) raise("MEDIUM", "clarification aging beyond 3 days");
    const medIssues = projIssues.filter((i) => i.severity === "MEDIUM");
    if (medIssues.length > 0)
      raise("MEDIUM", `${medIssues.length} open medium issue${medIssues.length === 1 ? "" : "s"}`);

    const attention: AttentionLevel = anyHigh ? "HIGH" : anyMedium ? "MEDIUM" : "LOW";
    return {
      projectId: p.id,
      name: p.name,
      progressPct: total > 0 ? Math.round((released / total) * 100) : 0,
      currentGate: gateMilestone
        ? `${msLabel(gateMilestone)} — ${gateMilestone.status.replace(/_/g, " ").toLowerCase()}`
        : "All milestones released",
      evidenceState:
        projRejected.length > 0
          ? `${projRejected.length} rejected`
          : projReview.length > 0
            ? `${projReview.length} needs review`
            : "In order",
      pendingGovernance: projPending.length,
      openIssues: projIssues.length,
      openClarifications: projClars.length,
      fundsHeld: ms.filter((m) => m.accountStatus === "HELD").reduce((s, m) => s + m.trancheAmount, 0),
      attention,
      health: attention === "HIGH" ? "AT_RISK" : attention === "MEDIUM" ? "WATCH" : "HEALTHY",
      reasons,
    };
  });
  const attOrder: Record<AttentionLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  rows.sort((a, b) => attOrder[a.attention] - attOrder[b.attention]);

  // ----------------------------------------------------- recommendations
  const recommendations: Recommendation[] = [];

  for (const issue of openIssues
    .filter((i) => i.severity === "HIGH" || i.severity === "CRITICAL")
    .slice(0, 2)) {
    recommendations.push({
      priority: "HIGH",
      title: `Resolve ${issue.severity.toLowerCase()} ${issue.category.toLowerCase()} issue "${issue.title}"`,
      why: `${issue.severity} ${issue.category} issue has been ${issue.status.replace(/_/g, " ").toLowerCase()} for ${ageOf(issue.createdAt, now)} on ${projName(issue.projectId)}.`,
      sources: [`Field issue ${issue.id}`],
      actionLabel: "Open issue",
      actionHref: `/issue/${issue.id}`,
    });
  }

  for (const ev of outstandingRejected.slice(0, 1)) {
    const m = milestoneById.get(ev.milestoneId)!;
    recommendations.push({
      priority: "HIGH",
      title: `Re-collect evidence for ${msLabel(m)}`,
      why: "Latest submission was REJECTED by verification; the milestone cannot progress until acceptable evidence is recorded.",
      sources: [`Evidence ${ev.id}`],
      actionLabel: "Open milestone",
      actionHref: `/milestone/${m.id}`,
    });
  }

  for (const approval of pendingApprovals) {
    const records = approvalRecords.get(approval.id) ?? [];
    if (records.length === 0) continue;
    const m = milestoneById.get(approval.milestoneId!)!;
    const recorded = new Set(records.map((r) => r.role));
    const awaiting = approval.requiredRoles.filter((r) => !recorded.has(r));
    if (awaiting.length === 0) continue;
    recommendations.push({
      priority: "MEDIUM",
      title: `Complete ${awaiting.map(roleName).join(" and ")} approval for ${msLabel(m)}`,
      why: `${records.length} of ${approval.requiredRoles.length} required roles recorded; $${m.trancheAmount.toLocaleString("en-US")} remains HELD awaiting the final required role.`,
      sources: [`Approval request ${approval.id}`],
      actionLabel: "Open approval",
      actionHref: "/approvals",
    });
  }

  for (const ev of outstandingReview.slice(0, 2)) {
    const m = milestoneById.get(ev.milestoneId)!;
    const v = latestVerification.get(ev.id)!;
    const missingGps = ev.latitude === null;
    recommendations.push({
      priority: "MEDIUM",
      title: missingGps
        ? `Request location evidence for ${msLabel(m)}`
        : `Review flagged evidence for ${msLabel(m)}`,
      why: missingGps
        ? "Evidence is NEEDS_REVIEW because no GPS fix was recorded with the submission."
        : `Evidence is NEEDS_REVIEW${v.checks.some((c) => !c.passed) ? ` (${v.checks.filter((c) => !c.passed).map((c) => c.name).join("; ")})` : ""} and needs a reviewer decision.`,
      sources: [`Evidence ${ev.id}`, `Verification ${v.id}`],
      actionLabel: "Open evidence",
      actionHref: `/milestone/${m.id}`,
    });
  }

  for (const clar of openClars.slice(0, 2)) {
    const m = milestoneById.get(clar.milestoneId)!;
    recommendations.push({
      priority:
        (clar.dueAt && Date.parse(clar.dueAt) < now) || now - Date.parse(clar.createdAt) > 3 * DAY
          ? "MEDIUM"
          : "INFO",
      title: `Follow up clarification on ${msLabel(m)}`,
      why: `Open clarification (${clar.responseType.replace(/_/g, " ").toLowerCase()} requested ${ageOf(clar.createdAt, now)} ago) — a response never auto-accepts; reviewer decision required.`,
      sources: [`Clarification ${clar.id}`],
      actionLabel: "Open milestone",
      actionHref: `/milestone/${m.id}`,
    });
  }

  recommendations.sort((a, b) => sevOrder[a.priority] - sevOrder[b.priority]);

  // ------------------------------------------------------------ summary
  const summary: IntelSummary = {
    activeProjects: projects.length,
    projectsNeedingAttention: rows.filter((r) => r.attention !== "LOW").length,
    highSeverityIssues: fieldRisk.highCritical,
    evidenceNeedsReview: outstandingReview.length + outstandingRejected.length,
    pendingApprovals: pendingApprovals.length,
    openClarifications: openClars.length,
    integrityAlerts: opts.chainValid ? 0 : 1,
  };

  return {
    summary,
    signals,
    verification: verificationIntel,
    governance,
    fieldRisk,
    projects: rows,
    recommendations: recommendations.slice(0, 6),
    chainValid: opts.chainValid,
    generatedAt: new Date(now).toISOString(),
  };
}

function roleName(role: UserRole): string {
  switch (role) {
    case "FUNDER_REP": return "Funder Representative";
    case "PROJECT_MANAGER": return "Project Manager";
    case "COMPLIANCE_REVIEWER": return "Compliance Reviewer";
    case "FIELD": return "Field Engineer";
  }
}
