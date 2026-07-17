/**
 * Unified Exception Management — one governed operational register for
 * anything preventing clean progression of a project, milestone, draw,
 * evidence package, approval, document set, schedule, or integrity state.
 *
 * CORE PRINCIPLE — an Exception is a CONTROL RECORD that references a
 * source problem. The source record stays authoritative: exceptions never
 * duplicate or rewrite verification truth, waivers never touch the
 * source, and NO exception action can release money (this module never
 * imports the VirtualAccountService or the approval workflow).
 *
 * AUTO-CREATION RULES (deterministic, idempotent — see RULES below).
 * Every auto exception carries a sourceKey; UNIQUE(source_key) at the
 * database level makes repeated evaluation duplicate-proof.
 *
 * SOURCE RECONCILIATION — the sweep and every manual Resolve consult
 * sourceStillActive(): an exception cannot be resolved while its source
 * condition still holds, and it auto-resolves (SOURCE_CLEARED) when the
 * source clears. A recurring condition reopens a RESOLVED/CLOSED
 * exception; a WAIVED exception stays waived (the waiver is the formal
 * record) until the underlying condition clears and recurs — waivers are
 * never silently overturned by the sweep.
 */
import * as repo from "../db/repo";
import { effectiveStatus as permitEffectiveStatus, completeSourcesForInspection } from "./permits";
import { wormEvidenceStore } from "./WormEvidenceStore";
import { audit } from "./pilot/onboarding";
import { canAccessProjectFinance, assessFinancialProgress, varianceThresholds } from "./budgetProgress";
import { missingRequiredDocuments } from "./draws";
import { mirrorEvent } from "./chat";
import type {
  ExceptionEvent,
  ExceptionSeverity,
  ExceptionSlaState,
  ExceptionStatus,
  FieldIssue,
  ObvException,
  Project,
  User,
} from "../../shared/types";

export class ExceptionError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

const OPEN_STATES: ExceptionStatus[] = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"];
export const isOpen = (e: ObvException): boolean => OPEN_STATES.includes(e.status);

// ------------------------------------------------------------ SLA policy

/** Simple configurable age targets (hours). Descriptive only — SLA state
 *  is shown as within-target / due-soon / overdue, never as a compliance
 *  certification. */
export function slaTargetHours(severity: ExceptionSeverity): number {
  const env = (k: string, d: number) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  switch (severity) {
    case "CRITICAL":
      return env("OBV_EXC_SLA_CRITICAL_HOURS", 24);
    case "HIGH":
      return env("OBV_EXC_SLA_HIGH_HOURS", 24);
    case "MEDIUM":
      return env("OBV_EXC_SLA_MEDIUM_HOURS", 72);
    case "LOW":
      return env("OBV_EXC_SLA_LOW_HOURS", 168);
  }
}

export function slaState(e: ObvException, now = Date.now()): ExceptionSlaState {
  if (!isOpen(e)) return "NO_TARGET";
  if (!e.dueAt) return "NO_TARGET";
  const due = Date.parse(e.dueAt);
  if (now > due) return "OVERDUE";
  const total = due - Date.parse(e.openedAt);
  if (total > 0 && due - now <= total * 0.25) return "DUE_SOON";
  return "WITHIN_TARGET";
}

export function ageDays(e: ObvException, now = Date.now()): number {
  return Math.max(0, Math.floor((now - Date.parse(e.openedAt)) / 86_400_000));
}

// ------------------------------------------------------------ access

export function canAccessException(user: User, exception: ObvException): boolean {
  const project = repo.getProject(exception.projectId);
  return Boolean(project && canAccessProjectFinance(user, project));
}

/** Operational management (acknowledge/assign/progress/resolve/close). */
export function canManageExceptions(user: User): boolean {
  return ["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(user.role);
}

/** Waivers are a formal control decision: lender review roles only, and
 *  INTEGRITY exceptions only by the compliance reviewer. */
export function canWaive(user: User, exception: ObvException): boolean {
  if (exception.category === "INTEGRITY") return user.role === "COMPLIANCE_REVIEWER";
  return user.role === "FUNDER_REP" || user.role === "COMPLIANCE_REVIEWER";
}

function getOr404(id: string, user?: User): ObvException {
  const e = repo.getException(id);
  if (!e || (user && !canAccessException(user, e))) {
    throw new ExceptionError("Exception not found", 404);
  }
  return e;
}

function event(
  exceptionId: string,
  type: ExceptionEvent["type"],
  detail: string,
  actorUserId: string | null
): void {
  repo.insertExceptionEvent({
    id: repo.newId(),
    exceptionId,
    type,
    detail,
    actorUserId,
    createdAt: new Date().toISOString(),
  });
}

// ------------------------------------------------------------ creation

interface ExceptionSeed {
  projectId: string;
  milestoneId?: string | null;
  drawRequestId?: string | null;
  budgetLineId?: string | null;
  sourceType: ObvException["sourceType"];
  sourceId: string;
  sourceKey: string;
  category: ObvException["category"];
  severity: ExceptionSeverity;
  title: string;
  description: string;
}

/**
 * Idempotent upsert used by the deterministic rules. Behavior on repeated
 * evaluation of the same condition:
 *  - open exception exists      → no-op (never duplicates)
 *  - RESOLVED/CLOSED exists     → reopened (condition recurred)
 *  - WAIVED exists              → no-op (the waiver stands as the record)
 *  - none exists                → created
 */
function ensureException(seed: ExceptionSeed): ObvException {
  const existing = repo.findExceptionBySourceKey(seed.sourceKey);
  if (existing) {
    if (isOpen(existing) || existing.status === "WAIVED") return existing;
    // Condition recurred after resolution/closure — reopen honestly.
    repo.updateException(existing.id, {
      status: "OPEN",
      resolvedAt: null,
      resolutionSummary: null,
      resolutionType: null,
    });
    event(existing.id, "REOPENED", "The underlying source condition holds again — exception reopened by rule evaluation.", null);
    return repo.getException(existing.id)!;
  }
  const project = repo.getProject(seed.projectId)!;
  const now = new Date().toISOString();
  const dueAt = new Date(Date.now() + slaTargetHours(seed.severity) * 3_600_000).toISOString();
  const exception: ObvException = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: seed.projectId,
    milestoneId: seed.milestoneId ?? null,
    drawRequestId: seed.drawRequestId ?? null,
    budgetLineId: seed.budgetLineId ?? null,
    sourceType: seed.sourceType,
    sourceId: seed.sourceId,
    sourceKey: seed.sourceKey,
    category: seed.category,
    severity: seed.severity,
    status: "OPEN",
    title: seed.title,
    description: seed.description,
    ownerUserId: null,
    dueAt,
    openedAt: now,
    acknowledgedAt: null,
    resolvedAt: null,
    resolutionSummary: null,
    resolutionType: null,
    createdBy: "system",
    createdAt: now,
    updatedAt: now,
  };
  repo.insertException(exception);
  event(exception.id, "CREATED", `Auto-created by deterministic rule (${seed.sourceKey.split(":")[0]}). ${seed.description}`, null);
  return exception;
}

/** Manual exception (sourceType MANUAL), for problems no rule covers. */
export function createManualException(
  user: User,
  input: {
    projectId: string;
    milestoneId?: string | null;
    drawRequestId?: string | null;
    category: ObvException["category"];
    severity: ExceptionSeverity;
    title: string;
    description?: string;
    ownerUserId?: string | null;
    dueAt?: string | null;
  }
): ObvException {
  const project = repo.getProject(input.projectId);
  if (!project || !canAccessProjectFinance(user, project)) {
    throw new ExceptionError("Project not found", 404);
  }
  if (!canManageExceptions(user)) throw new ExceptionError("Not authorized to raise exceptions", 403);
  const title = (input.title ?? "").trim();
  if (!title) throw new ExceptionError("An exception title is required");
  if (input.milestoneId && repo.getMilestone(input.milestoneId)?.projectId !== project.id) {
    throw new ExceptionError("milestoneId must belong to the project");
  }
  if (input.drawRequestId && repo.getDrawRequest(input.drawRequestId)?.projectId !== project.id) {
    throw new ExceptionError("drawRequestId must belong to the project");
  }
  const now = new Date().toISOString();
  const exception: ObvException = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    milestoneId: input.milestoneId ?? null,
    drawRequestId: input.drawRequestId ?? null,
    budgetLineId: null,
    sourceType: "MANUAL",
    sourceId: project.id,
    sourceKey: `manual:${repo.newId()}`,
    category: input.category,
    severity: input.severity,
    status: "OPEN",
    title,
    description: input.description?.trim() ?? "",
    ownerUserId: input.ownerUserId ?? null,
    dueAt: input.dueAt ?? new Date(Date.now() + slaTargetHours(input.severity) * 3_600_000).toISOString(),
    openedAt: now,
    acknowledgedAt: null,
    resolvedAt: null,
    resolutionSummary: null,
    resolutionType: null,
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  };
  repo.insertException(exception);
  event(exception.id, "CREATED", `Raised manually by ${user.name}: ${title}`, user.id);
  return exception;
}

// -------------------------------------------------- deterministic rules

/** Documented auto-creation rules (shown on the register). */
export const RULES: Array<{ key: string; severity: string; rule: string }> = [
  { key: "evidence-rejected", severity: "HIGH", rule: "Latest evidence for an active milestone was REJECTED by verification" },
  { key: "evidence-review", severity: "MEDIUM", rule: "Latest evidence is NEEDS_REVIEW and the milestone awaits a reviewer decision" },
  { key: "ledger-integrity", severity: "CRITICAL", rule: "Evidence Ledger hash chain failed integrity verification" },
  { key: "approval-delay", severity: "MEDIUM", rule: "Approval request pending longer than the configured threshold (default 48h)" },
  { key: "budget-variance", severity: "HIGH/MEDIUM", rule: "Financial progress materially ahead of verified physical progress (HIGH beyond 2× watch threshold)" },
  { key: "draw-doc-missing", severity: "MEDIUM", rule: "Required draw document missing while the draw is in review" },
  { key: "field-issue", severity: "mirrors issue", rule: "Open HIGH or CRITICAL field issue" },
  { key: "clarification-overdue", severity: "MEDIUM", rule: "Clarification open past its due date or older than 3 days" },
  { key: "draw-unapproved-co", severity: "MEDIUM", rule: "Draw line bills against a change order that is not yet approved" },
  { key: "integration-binding", severity: "MEDIUM", rule: "Teams thread binding degraded or missing permissions" },
  { key: "inspection-requirement-unknown", severity: "MEDIUM", rule: "Contractor reported work complete but the jurisdictional inspection requirement is undetermined (UNKNOWN)" },
  { key: "inspection-unscheduled", severity: "MEDIUM", rule: "Required jurisdictional inspection not scheduled although the contractor reported the work complete" },
  { key: "inspection-overdue", severity: "MEDIUM", rule: "Scheduled jurisdictional inspection is past its scheduled time without a recorded result" },
  { key: "inspection-failed", severity: "HIGH", rule: "Latest jurisdictional inspection FAILED" },
  { key: "inspection-doc-missing", severity: "MEDIUM", rule: "Inspection recorded PASSED without the configured result document reference" },
  { key: "inspection-expired", severity: "MEDIUM", rule: "Jurisdictional inspection or its permit is EXPIRED" },
  { key: "draw-inspection-blocked", severity: "MEDIUM", rule: "Open draw line references a milestone whose required jurisdictional inspection has not passed" },
  { key: "corrections-required", severity: "MEDIUM", rule: "Jurisdictional inspection recorded CORRECTIONS REQUIRED and no reinspection has been created" },
  { key: "reinspection-unscheduled", severity: "MEDIUM", rule: "A reinspection exists after a failed/corrections-required result but has not been scheduled" },
  { key: "reinspection-failed", severity: "HIGH", rule: "The reinspection was recorded FAILED" },
  { key: "permit-expired", severity: "MEDIUM", rule: "A permit linked to an active milestone is expired (recorded status or past its expiration date)" },
  { key: "permit-revoked", severity: "HIGH", rule: "A permit linked to an active milestone is revoked or suspended" },
  { key: "code-basis-missing", severity: "MEDIUM", rule: "Code basis is required by configuration but not recorded on any linked permit" },
  { key: "official-source-missing", severity: "MEDIUM", rule: "A PASSED inspection is missing its configured mandatory official source record" },
];

const ISSUE_CATEGORY: Record<FieldIssue["category"], ObvException["category"]> = {
  QUALITY: "QUALITY", SAFETY: "QUALITY", MATERIAL: "MATERIAL", SCHEDULE: "SCHEDULE",
  ACCESS: "OTHER", ENVIRONMENTAL: "OTHER", DOCUMENTATION: "DOCUMENT",
  EQUIPMENT: "OTHER", OTHER: "OTHER",
};

const ACTIVE_DRAW_STATES = new Set([
  "SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED", "READY_FOR_GOVERNANCE",
]);

interface RuleCondition {
  seed: ExceptionSeed;
}

/** Evaluate every deterministic condition and return the seeds that
 *  currently hold. Pure read — creation happens in evaluateExceptions. */
async function activeConditions(): Promise<RuleCondition[]> {
  const out: RuleCondition[] = [];
  const projects = repo.listProjects().filter((p) => p.status === "ACTIVE");
  const approvalSlaHours = Number(process.env.OBV_EXC_APPROVAL_SLA_HOURS ?? 48);
  const now = Date.now();

  for (const project of projects) {
    const milestones = repo.listMilestones(project.id).filter((m) => !m.archived);
    const milestoneById = new Map(milestones.map((m) => [m.id, m]));

    // -- evidence verdicts (latest evidence of active milestones) --
    for (const m of milestones) {
      if (!["UNDER_REVIEW", "PENDING_EVIDENCE"].includes(m.status)) continue;
      const latest = repo.latestEvidenceForMilestone(m.id);
      if (!latest) continue;
      const v = repo.getVerificationForEvidence(latest.id);
      if (v?.verdict === "REJECTED") {
        out.push({
          seed: {
            projectId: project.id, milestoneId: m.id,
            sourceType: "EVIDENCE_VERIFICATION", sourceId: latest.id,
            sourceKey: `evidence-rejected:${latest.id}`,
            category: "EVIDENCE", severity: "HIGH",
            title: `Evidence rejected — M${m.seq} ${m.title.split(",")[0]}`,
            description: `The latest evidence submission was REJECTED by verification (${v.reasoning.slice(0, 160)}). The verification record remains authoritative.`,
          },
        });
      } else if (v?.verdict === "NEEDS_REVIEW" && m.status === "UNDER_REVIEW") {
        out.push({
          seed: {
            projectId: project.id, milestoneId: m.id,
            sourceType: "EVIDENCE_VERIFICATION", sourceId: latest.id,
            sourceKey: `evidence-review:${latest.id}`,
            category: "EVIDENCE", severity: "MEDIUM",
            title: `Evidence needs review — M${m.seq} ${m.title.split(",")[0]}`,
            description: "Evidence was routed to NEEDS_REVIEW and awaits a reviewer decision. The verification record remains authoritative.",
          },
        });
      }
    }

    // -- approval delays (milestone + draw subjects) --
    const pendingApprovals = [
      ...repo.listPendingApprovalRequests().filter((a) => a.milestoneId && milestoneById.has(a.milestoneId)),
      ...repo.listPendingDrawApprovalRequests().filter(
        (a) => a.drawRequestId && repo.getDrawRequest(a.drawRequestId)?.projectId === project.id
      ),
    ];
    for (const a of pendingApprovals) {
      const ageH = (now - Date.parse(a.createdAt)) / 3_600_000;
      if (ageH <= approvalSlaHours) continue;
      const m = a.milestoneId ? milestoneById.get(a.milestoneId) : null;
      const d = a.drawRequestId ? repo.getDrawRequest(a.drawRequestId) : null;
      out.push({
        seed: {
          projectId: project.id, milestoneId: m?.id ?? null, drawRequestId: d?.id ?? null,
          sourceType: "APPROVAL_REQUEST", sourceId: a.id,
          sourceKey: `approval-delay:${a.id}`,
          category: "APPROVAL", severity: "MEDIUM",
          title: `Approval pending ${Math.round(ageH / 24)}d — ${m ? `M${m.seq}` : `Draw #${d?.drawNumber}`}`,
          description: `The approval request has been pending beyond the configured ${approvalSlaHours}h threshold. Funds remain HELD; only the formal approval workflow can change that.`,
        },
      });
    }

    // -- budget variance --
    const fin = assessFinancialProgress(project.id);
    if (fin.dataComplete && fin.varianceState === "FINANCIAL_AHEAD") {
      const t = varianceThresholds();
      out.push({
        seed: {
          projectId: project.id,
          sourceType: "BUDGET_VARIANCE", sourceId: project.id,
          sourceKey: `budget-variance:${project.id}`,
          category: "COST",
          severity: fin.variancePts > t.watchPts * 2 ? "HIGH" : "MEDIUM",
          title: `Financial progress ${fin.variancePts} pts ahead of verified physical progress`,
          description: `Financial progress (${fin.claimedPct}%) is ahead of currently verified physical progress (${fin.verifiedPhysicalPct}%). This is a comparison of recorded measurements, not a finding about conduct.`,
        },
      });
    }

    // -- missing required draw documents --
    for (const draw of repo.listDrawRequestsForProject(project.id)) {
      if (!ACTIVE_DRAW_STATES.has(draw.status)) continue;
      for (const req of missingRequiredDocuments(draw.id)) {
        out.push({
          seed: {
            projectId: project.id, drawRequestId: draw.id,
            sourceType: "DRAW_DOCUMENT", sourceId: req.id,
            sourceKey: `draw-doc-missing:${draw.id}:${req.id}`,
            category: "DOCUMENT", severity: "MEDIUM",
            title: `Missing required document — Draw #${draw.drawNumber}: ${req.title}`,
            description: `The draw is in review without its required "${req.title}". The document checklist on the draw remains authoritative.`,
          },
        });
      }
    }

    // -- unapproved change-order cost included in a draw --
    for (const draw of repo.listDrawRequestsForProject(project.id)) {
      if (!ACTIVE_DRAW_STATES.has(draw.status)) continue;
      for (const line of repo.listDrawLines(draw.id)) {
        if (!line.changeOrderId) continue;
        const co = repo.getChangeOrder(line.changeOrderId);
        if (!co || ["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(co.status)) continue;
        out.push({
          seed: {
            projectId: project.id, drawRequestId: draw.id,
            sourceType: "DRAW_LINE_ITEM", sourceId: line.id,
            sourceKey: `draw-unapproved-co:${line.id}`,
            category: "COST", severity: "MEDIUM",
            title: `Unapproved change cost in Draw #${draw.drawNumber}: ${line.description.slice(0, 60)}`,
            description: `UNAPPROVED CHANGE COST INCLUDED IN DRAW — line "${line.description}" bills $${line.currentRequested.toLocaleString("en-US")} against CO-${co.changeOrderNumber} (${co.status.replace(/_/g, " ")}). The change order record remains authoritative.`,
          },
        });
      }
    }

    // -- HIGH/CRITICAL field issues --
    for (const issue of repo.listFieldIssues()) {
      if (issue.projectId !== project.id) continue;
      if (["RESOLVED", "CLOSED"].includes(issue.status)) continue;
      if (issue.severity !== "HIGH" && issue.severity !== "CRITICAL") continue;
      out.push({
        seed: {
          projectId: project.id, milestoneId: issue.milestoneId,
          sourceType: "FIELD_ISSUE", sourceId: issue.id,
          sourceKey: `field-issue:${issue.id}`,
          category: ISSUE_CATEGORY[issue.category], severity: issue.severity,
          title: `Field issue: ${issue.title}`,
          description: `${issue.severity} ${issue.category} field issue is ${issue.status.replace(/_/g, " ").toLowerCase()}. The field issue record remains authoritative.`,
        },
      });
    }

    // -- overdue clarifications --
    for (const m of milestones) {
      for (const clar of repo.listOpenClarificationsForMilestone(m.id)) {
        const overdue = clar.dueAt !== null && Date.parse(clar.dueAt) < now;
        const old = now - Date.parse(clar.createdAt) > 3 * 86_400_000;
        if (!overdue && !old) continue;
        out.push({
          seed: {
            projectId: project.id, milestoneId: m.id,
            sourceType: "CLARIFICATION", sourceId: clar.id,
            sourceKey: `clarification:${clar.id}`,
            category: "CLARIFICATION", severity: "MEDIUM",
            title: `Clarification unanswered — M${m.seq}`,
            description: `"${clar.question.slice(0, 120)}" is ${overdue ? "past its due date" : "open beyond 3 days"}. The clarification record remains authoritative.`,
          },
        });
      }
    }
  }

  // -- ledger integrity (portfolio-wide; anchored to the broken entry) --
  const chain = await wormEvidenceStore.verifyChain();
  if (!chain.valid && chain.brokenAt !== undefined) {
    const entry = repo.listLedgerEntries().find((e) => e.seq === chain.brokenAt);
    const milestone = entry ? repo.getMilestone(entry.milestoneId) : null;
    const project = milestone ? repo.getProject(milestone.projectId) : repo.listProjects()[0];
    if (project) {
      out.push({
        seed: {
          projectId: project.id, milestoneId: milestone?.id ?? null,
          sourceType: "LEDGER_INTEGRITY", sourceId: entry?.id ?? `seq-${chain.brokenAt}`,
          sourceKey: `ledger-integrity:${chain.brokenAt}`,
          category: "INTEGRITY", severity: "CRITICAL",
          title: `Ledger integrity failure at entry #${chain.brokenAt}`,
          description: "The Evidence Ledger hash chain failed verification. The ledger itself remains the authoritative record; this exception tracks the operational response.",
        },
      });
    }
  }

  // -- integration bindings (Teams sync) --
  for (const binding of repo.listBindings()) {
    if (binding.status !== "DEGRADED" && binding.status !== "PERMISSION_REQUIRED") continue;
    const thread = repo.getThread(binding.threadId);
    if (!thread?.projectId) continue;
    out.push({
      seed: {
        projectId: thread.projectId,
        sourceType: "INTEGRATION", sourceId: binding.id,
        sourceKey: `integration-binding:${binding.id}`,
        category: "INTEGRATION", severity: "MEDIUM",
        title: `Teams connection ${binding.status === "DEGRADED" ? "degraded" : "needs permissions"} — ${thread.title}`,
        description: "The Teams conversation binding is not healthy; coordination sync may be interrupted. The binding record remains authoritative.",
      },
    });
  }

  // -- milestone completion gates: jurisdictional inspections --
  // All conditions read the authoritative inspection/configuration
  // records; clearing the source reconciles the exception on the next
  // sweep. Conservative scoping: "unknown"/"unscheduled" fire only once
  // the contractor has formally reported the work complete (the decision
  // point where the gap matters) — migration defaults create nothing.
  for (const project of projects) {
    const milestones = repo.listMilestones(project.id).filter((m) => !m.archived);
    for (const m of milestones) {
      const req = repo.getInspectionRequirement(m.id);
      const inspections = repo
        .listInspectionsForMilestone(m.id)
        .filter((i) => i.status !== "CANCELLED" && i.supersededByInspectionId === null);
      const latest = inspections.length ? inspections[inspections.length - 1] : null;
      const reported = (m.contractorCompletionStatus ?? "NOT_REPORTED") === "REPORTED_COMPLETE";

      if (!req && reported && m.accountStatus !== "RELEASED") {
        out.push({
          seed: {
            projectId: project.id, milestoneId: m.id,
            sourceType: "INSPECTION_REQUIREMENT", sourceId: m.id,
            sourceKey: `inspection-requirement-unknown:${m.id}`,
            category: "DOCUMENT", severity: "MEDIUM",
            title: `Inspection requirement undetermined — M${m.seq}`,
            description:
              "The contractor reported this milestone complete but whether a jurisdictional inspection is required has not been determined. UNKNOWN never behaves as NOT REQUIRED.",
          },
        });
      }
      if (req?.requirement === "REQUIRED") {
        const passed = latest?.status === "PASSED";
        if (!latest && reported) {
          out.push({
            seed: {
              projectId: project.id, milestoneId: m.id,
              sourceType: "INSPECTION_REQUIREMENT", sourceId: req.id,
              sourceKey: `inspection-unscheduled:${m.id}`,
              category: "SCHEDULE", severity: "MEDIUM",
              title: `Required inspection not scheduled — M${m.seq}`,
              description: `A ${req.inspectionType ?? "jurisdictional"} inspection is REQUIRED (${req.requirementBasis}) and the contractor has reported the work complete, but no inspection is scheduled.`,
            },
          });
        }
        if (latest?.status === "SCHEDULED" && latest.scheduledAt && Date.parse(latest.scheduledAt) < now) {
          out.push({
            seed: {
              projectId: project.id, milestoneId: m.id,
              sourceType: "INSPECTION", sourceId: latest.id,
              sourceKey: `inspection-overdue:${latest.id}`,
              category: "SCHEDULE", severity: "MEDIUM",
              title: `Scheduled inspection overdue — M${m.seq}`,
              description: `The ${latest.inspectionType ?? "jurisdictional"} inspection was scheduled for ${latest.scheduledAt} and no result has been recorded.`,
            },
          });
        }
        if (latest?.status === "FAILED") {
          out.push({
            seed: {
              projectId: project.id, milestoneId: m.id,
              sourceType: "INSPECTION", sourceId: latest.id,
              sourceKey: `inspection-failed:${latest.id}`,
              category: "QUALITY", severity: "HIGH",
              title: `Jurisdictional inspection FAILED — M${m.seq}`,
              description: `The ${latest.inspectionType ?? "jurisdictional"} inspection was recorded FAILED${latest.governmentInspectorName ? ` (inspector: ${latest.governmentInspectorName})` : ""}. Reinspection is required before the milestone can pass its legal gate.`,
            },
          });
        }
        if (latest?.status === "PASSED" && req.resultDocumentRequired && !latest.supportingDocumentId) {
          out.push({
            seed: {
              projectId: project.id, milestoneId: m.id,
              sourceType: "INSPECTION", sourceId: latest.id,
              sourceKey: `inspection-doc-missing:${latest.id}`,
              category: "DOCUMENT", severity: "MEDIUM",
              title: `Inspection result document missing — M${m.seq}`,
              description: "The inspection is recorded PASSED but the configured result document reference is missing.",
            },
          });
        }
        if (latest?.status === "EXPIRED") {
          out.push({
            seed: {
              projectId: project.id, milestoneId: m.id,
              sourceType: "INSPECTION", sourceId: latest.id,
              sourceKey: `inspection-expired:${latest.id}`,
              category: "DOCUMENT", severity: "MEDIUM",
              title: `Inspection or permit expired — M${m.seq}`,
              description: "The jurisdictional inspection (or its permit) has EXPIRED and must be renewed.",
            },
          });
        }
        if (latest?.status === "CORRECTIONS_REQUIRED") {
          out.push({
            seed: {
              projectId: project.id, milestoneId: m.id,
              sourceType: "INSPECTION", sourceId: latest.id,
              sourceKey: `corrections-required:${latest.id}`,
              category: "QUALITY", severity: "MEDIUM",
              title: `Inspection corrections required — M${m.seq}`,
              description: `The ${latest.inspectionType ?? "jurisdictional"} inspection recorded CORRECTIONS REQUIRED${latest.correctionNoticeReference ? ` (notice ${latest.correctionNoticeReference})` : ""}. An uploaded correction notice does not itself clear corrections — a reinspection with a reviewed result is required.`,
            },
          });
        }
        if (latest?.reinspectionOfInspectionId && latest.status === "REQUIRED_UNSCHEDULED") {
          out.push({
            seed: {
              projectId: project.id, milestoneId: m.id,
              sourceType: "INSPECTION", sourceId: latest.id,
              sourceKey: `reinspection-unscheduled:${latest.id}`,
              category: "SCHEDULE", severity: "MEDIUM",
              title: `Reinspection not scheduled — M${m.seq}`,
              description: "A reinspection follows the prior failed/corrections-required result but has not been scheduled.",
            },
          });
        }
        if (latest?.reinspectionOfInspectionId && latest.status === "FAILED") {
          out.push({
            seed: {
              projectId: project.id, milestoneId: m.id,
              sourceType: "INSPECTION", sourceId: latest.id,
              sourceKey: `reinspection-failed:${latest.id}`,
              category: "QUALITY", severity: "HIGH",
              title: `Reinspection FAILED — M${m.seq}`,
              description: "The reinspection was recorded FAILED. The original result remains preserved; a further reinspection with a passing reviewed result is required.",
            },
          });
        }
        if (
          latest?.status === "PASSED" &&
          req.officialSourceRequired &&
          completeSourcesForInspection(latest.id).length === 0
        ) {
          out.push({
            seed: {
              projectId: project.id, milestoneId: m.id,
              sourceType: "INSPECTION", sourceId: latest.id,
              sourceKey: `official-source-missing:${latest.id}`,
              category: "DOCUMENT", severity: "MEDIUM",
              title: `Mandatory official source record missing — M${m.seq}`,
              description: "The inspection is recorded PASSED but the configured official source record has not been captured.",
            },
          });
        }
        if (req.codeBasisRequired) {
          const linked = repo
            .listPermitLinksForMilestone(m.id)
            .map((l) => repo.getPermit(l.permitId))
            .filter((x): x is NonNullable<typeof x> => x !== null);
          if (!linked.some((x) => x.applicableCodeEdition && x.codeBasis)) {
            out.push({
              seed: {
                projectId: project.id, milestoneId: m.id,
                sourceType: "INSPECTION_REQUIREMENT", sourceId: req.id,
                sourceKey: `code-basis-missing:${m.id}`,
                category: "DOCUMENT", severity: "MEDIUM",
                title: `Applicable code basis not recorded — M${m.seq}`,
                description: "Configuration requires a recorded code basis for this milestone's permit(s), but none is recorded. OBV records the reviewed governing basis — it does not independently determine legal compliance.",
              },
            });
          }
        }
      }
      // ---- linked permit control conditions (only permits linked to
      // THIS milestone are relevant; unrelated permits never fire) ----
      if (m.accountStatus !== "RELEASED") {
        for (const link of repo.listPermitLinksForMilestone(m.id)) {
          const permit = repo.getPermit(link.permitId);
          if (!permit) continue;
          const effective = permitEffectiveStatus(permit);
          if (effective === "EXPIRED") {
            out.push({
              seed: {
                projectId: project.id, milestoneId: m.id,
                sourceType: "PERMIT", sourceId: permit.id,
                sourceKey: `permit-expired:${permit.id}:${m.id}`,
                category: "DOCUMENT", severity: "MEDIUM",
                title: `Linked permit expired — ${permit.permitNumber}`,
                description: `Permit ${permit.permitNumber} (${permit.permitType}) linked to M${m.seq} is expired. The stored permit status remains authoritative and is never rewritten by this exception.`,
              },
            });
          } else if (effective === "REVOKED" || effective === "SUSPENDED") {
            out.push({
              seed: {
                projectId: project.id, milestoneId: m.id,
                sourceType: "PERMIT", sourceId: permit.id,
                sourceKey: `permit-revoked:${permit.id}:${m.id}`,
                category: "DOCUMENT", severity: "HIGH",
                title: `Linked permit ${effective.toLowerCase()} — ${permit.permitNumber}`,
                description: `Permit ${permit.permitNumber} (${permit.permitType}) linked to M${m.seq} is ${effective}.`,
              },
            });
          }
        }
      }
      // Draws billing against an inspection-blocked milestone (unchanged
      // semantics — the guard mirrors the original REQUIRED-block scope).
      if (
        req?.requirement === "REQUIRED" &&
        latest?.status !== "PASSED" &&
        (req.mustPassBeforeGovernance || req.mustPassBeforeDrawReview)
      ) {
        for (const d of repo.listDrawRequestsForProject(project.id)) {
          if (!ACTIVE_DRAW_STATES.has(d.status)) continue;
          for (const l of repo.listDrawLines(d.id)) {
            if (l.milestoneId !== m.id) continue;
            out.push({
              seed: {
                projectId: project.id, milestoneId: m.id, drawRequestId: d.id,
                sourceType: "DRAW_LINE_ITEM", sourceId: l.id,
                sourceKey: `draw-inspection-blocked:${l.id}`,
                category: "APPROVAL", severity: "MEDIUM",
                title: `Draw line blocked by required inspection — M${m.seq}`,
                description: `Draw #${d.drawNumber} line "${l.description}" references M${m.seq}, whose required ${req.inspectionType ?? "jurisdictional"} inspection has not passed.`,
              },
            });
          }
        }
      }
    }
  }

  return out;
}

/**
 * Deterministic sweep: create/reopen exceptions for conditions that hold
 * and auto-resolve open auto-created exceptions whose condition cleared.
 * Idempotent — running it any number of times converges to the same set.
 */
export async function evaluateExceptions(): Promise<{ created: number; reopened: number; autoResolved: number }> {
  const conditions = await activeConditions();
  const activeKeys = new Set(conditions.map((c) => c.seed.sourceKey));
  let created = 0;
  let reopened = 0;
  for (const c of conditions) {
    const before = repo.findExceptionBySourceKey(c.seed.sourceKey);
    const after = ensureException(c.seed);
    if (!before) created++;
    else if (!isOpen(before) && isOpen(after)) reopened++;
  }
  // Source reconciliation: open auto exceptions whose condition cleared.
  let autoResolved = 0;
  for (const e of repo.listExceptions()) {
    if (e.sourceType === "MANUAL" || !isOpen(e)) continue;
    if (activeKeys.has(e.sourceKey)) continue;
    repo.updateException(e.id, {
      status: "RESOLVED",
      resolvedAt: new Date().toISOString(),
      resolutionType: "SOURCE_CLEARED",
      resolutionSummary: "The underlying source condition no longer holds.",
    });
    event(e.id, "SOURCE_UPDATED", "Rule evaluation found the source condition cleared.", null);
    event(e.id, "RESOLVED", "Auto-resolved: the authoritative source record no longer shows the condition.", null);
    autoResolved++;
  }
  return { created, reopened, autoResolved };
}

/** Whether the exception's source condition still holds right now.
 *  Used to protect Resolve: source records stay authoritative. */
export async function sourceStillActive(e: ObvException): Promise<boolean> {
  if (e.sourceType === "MANUAL") return false; // manual: human judgment
  const conditions = await activeConditions();
  return conditions.some((c) => c.seed.sourceKey === e.sourceKey);
}

// ------------------------------------------------------------ actions
// Operational transitions only. Nothing here can touch verification,
// approvals, HELD/RELEASED state, or the ledger.

export function acknowledgeException(user: User, id: string): ObvException {
  const e = getOr404(id, user);
  if (!canManageExceptions(user)) throw new ExceptionError("Not authorized", 403);
  if (!["OPEN"].includes(e.status)) throw new ExceptionError(`A ${e.status} exception cannot be acknowledged`, 409);
  repo.updateException(e.id, { status: "ACKNOWLEDGED", acknowledgedAt: new Date().toISOString() });
  event(e.id, "ACKNOWLEDGED", `Acknowledged by ${user.name}.`, user.id);
  return repo.getException(e.id)!;
}

export function assignException(user: User, id: string, ownerUserId: string | null): ObvException {
  const e = getOr404(id, user);
  if (!canManageExceptions(user)) throw new ExceptionError("Not authorized", 403);
  if (!isOpen(e)) throw new ExceptionError(`A ${e.status} exception cannot be reassigned`, 409);
  if (ownerUserId && !repo.getUser(ownerUserId)) throw new ExceptionError("Unknown owner", 400);
  repo.updateException(e.id, { ownerUserId });
  event(
    e.id, "ASSIGNED",
    ownerUserId ? `Assigned to ${repo.getUser(ownerUserId)!.name} by ${user.name}.` : `Unassigned by ${user.name}.`,
    user.id
  );
  return repo.getException(e.id)!;
}

export function startException(user: User, id: string): ObvException {
  const e = getOr404(id, user);
  if (!canManageExceptions(user)) throw new ExceptionError("Not authorized", 403);
  if (!["OPEN", "ACKNOWLEDGED", "AWAITING_RESPONSE"].includes(e.status)) {
    throw new ExceptionError(`Work cannot start on a ${e.status} exception`, 409);
  }
  repo.updateException(e.id, { status: "IN_PROGRESS", acknowledgedAt: e.acknowledgedAt ?? new Date().toISOString() });
  event(e.id, "STATUS_CHANGED", `Work started by ${user.name}.`, user.id);
  return repo.getException(e.id)!;
}

export function requestResponse(user: User, id: string, note: string): ObvException {
  const e = getOr404(id, user);
  if (!canManageExceptions(user)) throw new ExceptionError("Not authorized", 403);
  if (!isOpen(e)) throw new ExceptionError(`A ${e.status} exception cannot await a response`, 409);
  const n = note.trim();
  if (!n) throw new ExceptionError("A note describing the requested response is required");
  repo.updateException(e.id, { status: "AWAITING_RESPONSE" });
  event(e.id, "RESPONSE_REQUESTED", `${user.name} requested a response: ${n}`, user.id);
  return repo.getException(e.id)!;
}

export function commentException(user: User, id: string, note: string): ObvException {
  const e = getOr404(id, user);
  if (!canManageExceptions(user)) throw new ExceptionError("Not authorized", 403);
  const n = note.trim();
  if (!n) throw new ExceptionError("An empty comment cannot be recorded");
  event(e.id, "COMMENT", `${user.name}: ${n}`, user.id);
  return repo.getException(e.id)!;
}

/**
 * SOURCE-AWARE RESOLVE — an exception cannot be resolved while its
 * authoritative source condition still holds (e.g. an evidence exception
 * whose latest verification is still REJECTED). Clearing the source
 * (new verified evidence, accepted document, completed approval, closed
 * clarification) is what makes resolution possible.
 */
export async function resolveException(user: User, id: string, summary?: string | null): Promise<ObvException> {
  const e = getOr404(id, user);
  if (!canManageExceptions(user)) throw new ExceptionError("Not authorized", 403);
  if (!isOpen(e)) throw new ExceptionError(`A ${e.status} exception cannot be resolved`, 409);
  if (await sourceStillActive(e)) {
    throw new ExceptionError(
      "The authoritative source record still shows this condition — resolve the source first (or a waiver by an authorized role is required)",
      409
    );
  }
  repo.updateException(e.id, {
    status: "RESOLVED",
    resolvedAt: new Date().toISOString(),
    resolutionType: e.sourceType === "MANUAL" ? "MANUAL" : "SOURCE_CLEARED",
    resolutionSummary: summary?.trim() || "Resolved after the source condition cleared.",
  });
  event(e.id, "RESOLVED", `Resolved by ${user.name}${summary?.trim() ? `: ${summary.trim()}` : ""}.`, user.id);
  return repo.getException(e.id)!;
}

export function closeException(user: User, id: string): ObvException {
  const e = getOr404(id, user);
  if (!canManageExceptions(user)) throw new ExceptionError("Not authorized", 403);
  if (e.status !== "RESOLVED" && e.status !== "WAIVED") {
    throw new ExceptionError("Only resolved or waived exceptions can be closed", 409);
  }
  repo.updateException(e.id, { status: "CLOSED" });
  event(e.id, "CLOSED", `Closed by ${user.name}.`, user.id);
  return repo.getException(e.id)!;
}

/**
 * FORMAL WAIVER — authorized roles only (INTEGRITY: compliance reviewer
 * only), reason required, written to the configuration audit trail. A
 * waiver records a control decision about the EXCEPTION; it never
 * rewrites the source truth (the verification verdict, ledger state or
 * issue record are untouched).
 */
export function waiveException(user: User, id: string, reason: string): ObvException {
  const e = getOr404(id, user);
  if (!canWaive(user, e)) {
    throw new ExceptionError(
      e.category === "INTEGRITY"
        ? "Integrity exceptions can only be waived by a compliance reviewer"
        : "Waiving an exception requires a lender review role",
      403
    );
  }
  if (!isOpen(e)) throw new ExceptionError(`A ${e.status} exception cannot be waived`, 409);
  const r = reason.trim();
  if (!r) throw new ExceptionError("A waiver reason is required");
  repo.updateException(e.id, {
    status: "WAIVED",
    resolvedAt: new Date().toISOString(),
    resolutionType: "WAIVED",
    resolutionSummary: r,
  });
  event(e.id, "WAIVED", `Waived by ${user.name} (${user.role.replace(/_/g, " ").toLowerCase()}): ${r}. The source record is unchanged.`, user.id);
  audit({
    projectId: e.projectId,
    actorUserId: user.id,
    action: "EXCEPTION_WAIVED",
    entityType: "exception",
    entityId: e.id,
    reason: r,
    beforeSummary: `${e.severity} ${e.category} · ${e.title}`,
    afterSummary: "WAIVED (source record unchanged)",
  });
  return repo.getException(e.id)!;
}

/** Post an EXCEPTION_REFERENCE into the project/milestone thread. Chat
 *  stays coordination-only: referencing (or discussing) an exception
 *  never changes its status. */
export function referenceInThread(user: User, id: string): boolean {
  const e = getOr404(id, user);
  const msg = mirrorEvent(
    `Exception raised for review: "${e.title}" (${e.severity} ${e.category}, ${e.status.replace(/_/g, " ")}). Formal actions happen on the exception record — chat cannot resolve it.`,
    {
      projectId: e.projectId,
      milestoneId: e.milestoneId ?? undefined,
      drawRequestId: e.drawRequestId ?? undefined,
      refType: "EXCEPTION_REFERENCE",
      refId: e.id,
    }
  );
  if (msg) event(e.id, "COMMENT", `${user.name} referenced this exception in the project discussion.`, user.id);
  return Boolean(msg);
}

// ------------------------------------------------------------ queries

export function listExceptionsForUser(user: User): ObvException[] {
  const projects = new Map(repo.listProjects().map((p) => [p.id, p]));
  return repo.listExceptions().filter((e) => {
    const project = projects.get(e.projectId);
    return project && canAccessProjectFinance(user, project);
  });
}

/** Where the exception's source lives (drill-down link + map anchor). */
export function sourceContext(e: ObvException): {
  label: string;
  href: string;
  latitude: number | null;
  longitude: number | null;
} {
  switch (e.sourceType) {
    case "EVIDENCE_VERIFICATION": {
      const ev = repo.getEvidence(e.sourceId);
      return {
        label: `Evidence ${e.sourceId.slice(0, 8)}… (verification record)`,
        href: e.milestoneId ? `/milestone/${e.milestoneId}` : `/project/${e.projectId}`,
        latitude: ev?.latitude ?? null,
        longitude: ev?.longitude ?? null,
      };
    }
    case "FIELD_ISSUE": {
      const issue = repo.getFieldIssue(e.sourceId);
      return {
        label: `Field issue "${issue?.title ?? e.sourceId}"`,
        href: `/issue/${e.sourceId}`,
        latitude: issue?.latitude ?? null,
        longitude: issue?.longitude ?? null,
      };
    }
    case "APPROVAL_REQUEST":
      return { label: "Approval request", href: e.drawRequestId ? `/draw/${e.drawRequestId}?tab=governance` : "/approvals", latitude: null, longitude: null };
    case "DRAW_DOCUMENT":
      return { label: "Draw document checklist", href: `/draw/${e.drawRequestId}?tab=documents`, latitude: null, longitude: null };
    case "DRAW_REQUEST":
    case "DRAW_LINE_ITEM":
      return { label: "Draw request", href: `/draw/${e.drawRequestId ?? e.sourceId}`, latitude: null, longitude: null };
    case "BUDGET_VARIANCE":
      return { label: "Budget vs verified progress", href: `/project/${e.projectId}/budget`, latitude: null, longitude: null };
    case "CLARIFICATION":
      return { label: "Clarification request", href: e.milestoneId ? `/milestone/${e.milestoneId}` : `/project/${e.projectId}`, latitude: null, longitude: null };
    case "LEDGER_INTEGRITY":
      return { label: "Evidence Ledger", href: "/ledger", latitude: null, longitude: null };
    case "INTEGRATION":
      return { label: "Teams connection", href: "/communications/integrations", latitude: null, longitude: null };
    case "INSPECTION":
      return {
        label: "Jurisdictional inspection record",
        href: e.milestoneId ? `/milestone/${e.milestoneId}` : `/project/${e.projectId}`,
        latitude: null, longitude: null,
      };
    case "INSPECTION_REQUIREMENT":
      return {
        label: "Inspection requirement configuration",
        href: e.milestoneId ? `/milestone/${e.milestoneId}` : `/project/${e.projectId}`,
        latitude: null, longitude: null,
      };
    case "PERMIT": {
      const permit = repo.getPermit(e.sourceId);
      return {
        label: `Permit ${permit?.permitNumber ?? e.sourceId}`,
        href: `/project/${e.projectId}/permits`,
        latitude: null,
        longitude: null,
      };
    }
    case "OFFICIAL_SOURCE":
      return {
        label: "Official source record",
        href: e.milestoneId ? `/milestone/${e.milestoneId}` : `/project/${e.projectId}`,
        latitude: null,
        longitude: null,
      };
    case "MANUAL":
      return { label: "Manually raised", href: `/project/${e.projectId}`, latitude: null, longitude: null };
  }
}
