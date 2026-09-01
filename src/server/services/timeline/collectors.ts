/**
 * Timeline collectors — one function per subsystem, each turning
 * already-stored authoritative (or explicitly advisory) records into
 * TimelineEvents.
 *
 * READ-ONLY BY CONSTRUCTION. Every collector calls list/get functions
 * only; this module contains no INSERT/UPDATE/DELETE and no call to any
 * approval, release, decision, or payment path. Where a record carries
 * several meaningful moments (requested / submitted / decided), each
 * moment becomes its own event so the history reads as it happened.
 */
import * as repo from "../../db/repo";
import * as evidenceIntelRepo from "../../db/evidenceIntelRepo";
import * as officialSourcesRepo from "../../db/officialSourcesRepo";
import * as disputeRepo from "../../db/disputeRepo";
import * as lenderRepo from "../../db/lenderRepo";
import * as bankingRepo from "../../db/bankingRepo";
import * as dmvRepo from "../../db/dmvRepo";
import { canViewEvidenceIntel } from "../evidenceIntel/core";
import { canViewSources } from "../officialSources/core";
import { hasBankingCapability } from "../banking/bankingAccess";
import type { Project, TimelineEvent, User } from "../../../shared/types";
import { ActorResolver, makeEvent, type EventDraft } from "./core";

type Push = (draft: EventDraft) => void;

/** Every collector receives this context; `push` drops undated rows. */
export interface CollectorContext {
  project: Project;
  actors: ActorResolver;
  push: Push;
  /** Report a source-level read cap so the view can say what it omitted
   *  — a silently truncated history would misrepresent the record. */
  noteCap: (note: string) => void;
}

function safe<T>(fn: () => T, fallback: T): T {
  // A subsystem that is not configured for a given project must never
  // break the whole history — the timeline degrades to what it can read.
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------ project

export function collectProject(ctx: CollectorContext): void {
  const { project, push } = ctx;
  const pilot = project.pilot;
  // NOTE: the projects table stores no creation timestamp, so no
  // PROJECT_CREATED event is emitted — a timeline never invents a time.
  // Story Mode instead opens with the earliest RECORDED activity and
  // says so explicitly.
  if (pilot?.launchedAt) {
    push({
      at: pilot.launchedAt,
      category: "PROJECT",
      type: "PROJECT_LAUNCHED",
      title: "Pilot launched",
      explanation:
        "Onboarding completed and the project was launched: participants, requirements, and the approval " +
        "matrix became active for governed decisions.",
      projectId: project.id,
      organizationId: project.organizationId,
      sourceTable: "projects",
      sourceRecordId: project.id,
      href: `/pilot`,
      recordStatus: "AUTHORITATIVE",
    });
  }
}

/** Per-source read cap. The audit trail is the highest-volume source, so
 *  it is read generously — and when a cap is actually reached the
 *  aggregate REPORTS it rather than silently showing a partial history. */
export const AUDIT_READ_CAP = 20_000;

/** The other source-level caps. Every one of these is reported through
 *  `noteCap` when it actually bites, so a capped history always says so
 *  — a partial history presented as complete would misrepresent the
 *  record just as badly as an invented event would. */
export const SIGNAL_READ_CAP = 500;
export const REVIEW_READ_CAP = 500;
export const SOURCE_READ_CAP = 300;

/** The configuration audit trail — the cross-cutting record of who
 *  changed what, already written by the governed services. */
export function collectGovernance(ctx: CollectorContext): void {
  const { project, push, noteCap } = ctx;
  const entries = safe(() => repo.listConfigAudit(project.id, AUDIT_READ_CAP), []);
  if (entries.length >= AUDIT_READ_CAP) {
    noteCap(`config_audit: showing the most recent ${AUDIT_READ_CAP} entries`);
  }
  for (const e of entries) {
    // Amendment mutation records surface as PERMIT-category events with
    // amendment identity via collectPermits — skip to avoid emitting the
    // same immutable record twice.
    if (e.entityType === "PERMIT_AMENDMENT") continue;
    push({
      at: e.createdAt,
      category: "GOVERNANCE",
      type: e.action,
      title: `${e.action.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}`,
      explanation:
        `${e.afterSummary ?? e.entityType}${e.reason ? ` — reason: ${e.reason}` : ""}. ` +
        "Recorded in the configuration audit trail by the governed service that made the change.",
      actorUserId: e.actorUserId,
      projectId: project.id,
      organizationId: project.organizationId,
      sourceTable: "config_audit",
      sourceRecordId: e.id,
      recordStatus: "AUTHORITATIVE",
      change: e.beforeSummary || e.afterSummary
        ? { field: e.entityType, previous: e.beforeSummary ?? null, current: e.afterSummary ?? null }
        : null,
    });
  }
}

// ------------------------------------------------------------ budget

export function collectBudget(ctx: CollectorContext): void {
  const { project, push } = ctx;
  for (const line of safe(() => repo.listBudgetLines(project.id), [])) {
    push({
      at: (line as { createdAt?: string }).createdAt,
      category: "BUDGET",
      type: "BUDGET_LINE_CREATED",
      title: `Budget line added — ${line.description ?? line.id}`,
      explanation: "A budget line was recorded, defining scheduled value against which draws are measured.",
      projectId: project.id,
      organizationId: project.organizationId,
      sourceTable: "budget_lines",
      sourceRecordId: line.id,
      href: `/projects/${project.id}`,
      recordStatus: "AUTHORITATIVE",
    });
  }
  for (const co of safe(() => repo.listChangeOrdersForProject(project.id), [])) {
    push({
      at: co.requestedAt ?? co.createdAt,
      category: "BUDGET",
      type: "CHANGE_ORDER_REQUESTED",
      title: `Change order requested — ${co.title ?? co.id}`,
      explanation: "A change order was raised to adjust scope or budget. It follows the governed approval path.",
      actorUserId: co.requestedByUserId,
      projectId: project.id,
      organizationId: project.organizationId,
      sourceTable: "change_orders",
      sourceRecordId: co.id,
      href: `/change-orders`,
      recordStatus: "AUTHORITATIVE",
    });
    if (co.appliedAt) {
      push({
        at: co.appliedAt,
        category: "BUDGET",
        type: "CHANGE_ORDER_APPLIED",
        title: `Change order applied — ${co.title ?? co.id}`,
        explanation: "The approved change order was applied to the budget.",
        projectId: project.id,
        organizationId: project.organizationId,
        sourceTable: "change_orders",
        sourceRecordId: co.id,
        href: `/change-orders`,
        recordStatus: "AUTHORITATIVE",
        change: { field: "status", previous: "APPROVED", current: co.status },
      });
    }
  }
}

// ------------------------------------------------------------ milestones

export function collectMilestones(ctx: CollectorContext): void {
  const { project, push } = ctx;
  for (const m of safe(() => repo.listMilestones(project.id), [])) {
    const planned = (m as { plannedStart?: string | null }).plannedStart ?? null;
    if (planned) {
      push({
        at: planned,
        category: "MILESTONE",
        type: "MILESTONE_PLANNED_START",
        title: `Milestone scheduled to start — ${m.title}`,
        explanation: `${m.title} was planned to begin on this date. Requirement: ${m.requirement}`,
        projectId: project.id,
        milestoneId: m.id,
        organizationId: project.organizationId,
        sourceTable: "milestones",
        sourceRecordId: m.id,
        href: `/projects/${project.id}`,
        recordStatus: "AUTHORITATIVE",
      });
    }
  }
}

// ------------------------------------------------------------ permits / DMV

export function collectPermits(ctx: CollectorContext): void {
  const { project, push, noteCap } = ctx;
  // Amendment HISTORY comes from the immutable config_audit mutation
  // records (entityType PERMIT_AMENDMENT) — never from the current
  // mutable permit_amendments row, which only knows its LATEST state.
  const amendmentAudit = safe(
    () => repo.listConfigAudit(project.id, AUDIT_READ_CAP),
    [] as ReturnType<typeof repo.listConfigAudit>
  );
  if (amendmentAudit.length >= AUDIT_READ_CAP) {
    noteCap(`permit amendment history: derived from the most recent ${AUDIT_READ_CAP} audit entries`);
  }
  const amendmentHistory = amendmentAudit.filter((e) => e.entityType === "PERMIT_AMENDMENT");
  for (const p of safe(() => repo.listPermitsForProject(project.id), [])) {
    push({
      at: p.createdAt,
      category: "PERMIT",
      type: "PERMIT_RECORDED",
      title: `Permit recorded — ${p.permitNumber}`,
      explanation:
        `A ${p.permitType.toLowerCase()} permit (${p.permitNumber}) was recorded for this project` +
        `${p.issuingAuthority ? ` from ${p.issuingAuthority}` : ""}. OBV records permits; it never issues them.`,
      actorUserId: p.createdByUserId,
      projectId: project.id,
      organizationId: project.organizationId,
      sourceTable: "permits",
      sourceRecordId: p.id,
      href: `/permits`,
      recordStatus: "AUTHORITATIVE",
    });
    if (p.issuedAt) {
      push({
        at: p.issuedAt,
        category: "PERMIT",
        type: "PERMIT_ISSUED",
        title: `Permit issued — ${p.permitNumber}`,
        explanation: `The issuing authority's recorded issuance date for ${p.permitNumber}.`,
        projectId: project.id,
        organizationId: project.organizationId,
        sourceTable: "permits",
        sourceRecordId: p.id,
        href: `/permits`,
        recordStatus: "AUTHORITATIVE",
      });
    }
    if (p.codeDeterminedAt) {
      push({
        at: p.codeDeterminedAt,
        category: "PERMIT",
        type: "GOVERNING_CODE_DETERMINED",
        title: `Governing code basis determined — ${p.permitNumber}`,
        explanation:
          `An authorized reviewer recorded the governing code basis` +
          `${p.applicableCodeEdition ? ` (${p.applicableCodeEdition})` : ""}. This is a human determination ` +
          "that OBV records — never an independent legal interpretation.",
        actorUserId: p.codeDeterminedBy,
        projectId: project.id,
        organizationId: project.organizationId,
        sourceTable: "permits",
        sourceRecordId: p.id,
        href: `/permits`,
        recordStatus: "AUTHORITATIVE",
      });
    }
    if (p.expiresAt) {
      push({
        at: p.expiresAt,
        category: "PERMIT",
        type: "PERMIT_EXPIRES",
        title: `Permit expiry — ${p.permitNumber}`,
        explanation: `The recorded expiration date for ${p.permitNumber}.`,
        projectId: project.id,
        organizationId: project.organizationId,
        sourceTable: "permits",
        sourceRecordId: p.id,
        href: `/permits`,
        recordStatus: "AUTHORITATIVE",
      });
    }
    // Permit amendments — NON-SPATIAL governed records. Every historical
    // event is derived from the amendment's OWN immutable mutation record
    // in config_audit: actual timestamp, actual actor, actual before/after
    // state at that moment. The current permit_amendments row describes
    // only CURRENT state and is never used to narrate an earlier event —
    // the same doctrine as READINESS_TRANSITION and decision snapshots.
    // Only immutable identity (the reference) is read from the row.
    for (const a of safe(() => repo.listPermitAmendmentsForPermit(p.id), [])) {
      for (const e of amendmentHistory.filter((h) => h.entityId === a.id)) {
        if (e.action === "PERMIT_AMENDMENT_RECORDED") {
          push({
            at: e.createdAt,
            category: "PERMIT",
            type: "PERMIT_AMENDMENT_RECORDED",
            title: `Permit amendment recorded — ${a.amendmentReference}`,
            // The initial status comes from the immutable creation record.
            // If that record carries no summary, say only that it was
            // recorded — never attach today's status to createdAt.
            explanation:
              `${e.afterSummary ?? `Amendment ${a.amendmentReference} on permit ${p.permitNumber} was recorded`}. ` +
              "Whether it affects required-inspection scheduling is a separate reviewed determination.",
            actorUserId: e.actorUserId,
            projectId: project.id,
            organizationId: project.organizationId,
            sourceTable: "config_audit",
            sourceRecordId: e.id,
            href: `/permits`,
            recordStatus: "AUTHORITATIVE",
          });
        } else if (e.action === "AMENDMENT_EFFECT_DETERMINED") {
          const isChange = e.beforeSummary !== null && e.beforeSummary !== "NOT DETERMINED";
          push({
            at: e.createdAt,
            category: "PERMIT",
            type: "AMENDMENT_EFFECT_DETERMINED",
            title: `Amendment inspection effect ${isChange ? "changed" : "determined"} — ${a.amendmentReference}`,
            explanation:
              `An authorized reviewer recorded the jurisdictional determination for amendment ${a.amendmentReference}: ` +
              `required-inspection scheduling ${e.afterSummary ?? "(recorded)"}` +
              `${isChange ? ` — previously ${e.beforeSummary}` : ""}. ` +
              "OBV records the determination — it never interprets law.",
            actorUserId: e.actorUserId,
            projectId: project.id,
            organizationId: project.organizationId,
            sourceTable: "config_audit",
            sourceRecordId: e.id,
            href: `/permits`,
            recordStatus: "AUTHORITATIVE",
            severity: e.afterSummary?.startsWith("BLOCKED") ? "MEDIUM" : "INFO",
            change: {
              field: "inspection scheduling",
              previous: isChange ? e.beforeSummary : null,
              current: e.afterSummary ?? null,
            },
          });
        } else if (e.action === "PERMIT_AMENDMENT_RESOLVED" || e.action === "PERMIT_AMENDMENT_UPDATED") {
          push({
            at: e.createdAt,
            category: "PERMIT",
            type: e.action,
            title: `Permit amendment ${e.action === "PERMIT_AMENDMENT_RESOLVED" ? "resolved" : "updated"} — ${a.amendmentReference}`,
            explanation:
              `${e.afterSummary ?? `Amendment ${a.amendmentReference} was updated`}` +
              `${e.reason ? ` — reason: ${e.reason}` : ""}. ` +
              (e.action === "PERMIT_AMENDMENT_RESOLVED"
                ? "Resolution never passes an inspection — the required inspection remains its own governed record."
                : "Recorded by the governed amendment service."),
            actorUserId: e.actorUserId,
            projectId: project.id,
            organizationId: project.organizationId,
            sourceTable: "config_audit",
            sourceRecordId: e.id,
            href: `/permits`,
            recordStatus: "AUTHORITATIVE",
            change: e.beforeSummary || e.afterSummary
              ? { field: "status", previous: e.beforeSummary ?? null, current: e.afterSummary ?? null }
              : null,
          });
        }
      }
    }
  }

  // Permit basis versions + corrections (DMV Draw Control).
  for (const basis of safe(() => dmvRepo.listPermitBasisForProject(project.id), [])) {
    push({
      at: basis.createdAt,
      category: "PERMIT",
      type: basis.supersedesVersionId ? "PERMIT_BASIS_CORRECTED" : "PERMIT_BASIS_RECORDED",
      title: basis.supersedesVersionId
        ? `Permit basis corrected (v${basis.version}) — ${basis.permitNumber}`
        : `Permit basis recorded (v${basis.version}) — ${basis.permitNumber}`,
      explanation:
        basis.supersedesVersionId
          ? `A versioned correction superseded the prior authoritative basis. ${basis.correctionReason ?? ""}`.trim()
          : `The governing permit basis was recorded for ${basis.permitNumber} (${basis.governingBasis}).`,
      actorUserId: (basis as { recordedByUserId?: string | null }).recordedByUserId ?? null,
      projectId: project.id,
      organizationId: project.organizationId,
      sourceTable: "permit_basis_versions",
      sourceRecordId: basis.id,
      href: `/compliance`,
      recordStatus: "AUTHORITATIVE",
    });
    if (basis.status === "AUTHORITATIVE" && basis.effectiveFrom) {
      push({
        at: basis.effectiveFrom,
        category: "PERMIT",
        type: "PERMIT_BASIS_FINALIZED",
        title: `Permit basis became authoritative (v${basis.version})`,
        explanation:
          "An authorized reviewer finalized this basis version; draws pin to the authoritative basis in force.",
        projectId: project.id,
        organizationId: project.organizationId,
        sourceTable: "permit_basis_versions",
        sourceRecordId: basis.id,
        href: `/compliance`,
        recordStatus: "AUTHORITATIVE",
        change: { field: "status", previous: "DRAFT", current: "AUTHORITATIVE" },
      });
    }
  }

  // Manual source verifications (governed record of an official lookup).
  for (const v of safe(() => dmvRepo.listSourceVerificationsForProject(project.id), [])) {
    push({
      at: v.lookupAt,
      category: "OFFICIAL_SOURCE",
      type: "SOURCE_VERIFICATION_RECORDED",
      title: `Official source verified — ${v.officialService}`,
      explanation:
        `${v.resultStatus.replace(/_/g, " ").toLowerCase()} via ${v.verificationMethod.replace(/_/g, " ").toLowerCase()}` +
        `${v.resultSummary ? `: ${v.resultSummary}` : ""}`,
      actorUserId: v.performedByUserId,
      projectId: project.id,
      organizationId: project.organizationId,
      sourceTable: "source_verifications",
      sourceRecordId: v.id,
      href: `/compliance`,
      recordStatus: "AUTHORITATIVE",
    });
  }
}

// ------------------------------------------------------------ inspections

export function collectInspections(ctx: CollectorContext): void {
  const { project, push } = ctx;
  for (const i of safe(() => repo.listInspectionsForProject(project.id), [])) {
    push({
      at: (i as { createdAt?: string }).createdAt,
      category: "INSPECTION",
      type: "INSPECTION_REQUESTED",
      title: `Inspection requested — ${i.inspectionType ?? "jurisdictional"}`,
      explanation: "An inspection was recorded as required for this milestone.",
      projectId: project.id,
      milestoneId: i.milestoneId,
      organizationId: project.organizationId,
      sourceTable: "jurisdictional_inspections",
      sourceRecordId: i.id,
      href: `/compliance`,
      recordStatus: "AUTHORITATIVE",
    });
    if (i.scheduledAt) {
      push({
        at: i.scheduledAt,
        category: "INSPECTION",
        type: "INSPECTION_SCHEDULED",
        title: `Inspection scheduled — ${i.inspectionType ?? "jurisdictional"}`,
        explanation: "The inspection was scheduled with the authority.",
        projectId: project.id,
        milestoneId: i.milestoneId,
        organizationId: project.organizationId,
        sourceTable: "jurisdictional_inspections",
        sourceRecordId: i.id,
        href: `/compliance`,
        recordStatus: "AUTHORITATIVE",
      });
    }
    if (i.completedAt) {
      const result = (i as { result?: string | null }).result ?? i.status;
      const failed = /FAIL|CORRECTION|REINSPECT/i.test(String(result));
      push({
        at: i.completedAt,
        category: "INSPECTION",
        type: "INSPECTION_RESULT",
        title: `Inspection result — ${String(result).replace(/_/g, " ").toLowerCase()}`,
        explanation:
          `The official inspection outcome recorded by an authorized reviewer: ${String(result)}. ` +
          "OBV records official results; it never performs government inspections.",
        projectId: project.id,
        milestoneId: i.milestoneId,
        organizationId: project.organizationId,
        sourceTable: "jurisdictional_inspections",
        sourceRecordId: i.id,
        href: `/compliance`,
        recordStatus: "AUTHORITATIVE",
        severity: failed ? "HIGH" : "INFO",
        change: { field: "status", previous: null, current: String(result) },
      });
    }
  }
}

// ------------------------------------------------------------ evidence

export function collectEvidence(ctx: CollectorContext): void {
  const { project, push } = ctx;
  for (const m of safe(() => repo.listMilestones(project.id), [])) {
    for (const e of safe(() => repo.listEvidenceForMilestone(m.id), [])) {
      push({
        at: e.capturedAt,
        category: "EVIDENCE",
        type: "EVIDENCE_CAPTURED",
        title: `Evidence captured — ${m.title}`,
        explanation:
          `A field photo was captured for ${m.title}` +
          `${e.latitude !== null && e.longitude !== null ? " with a GPS fix" : " without a GPS fix"}.`,
        actorUserId: e.userId,
        projectId: project.id,
        milestoneId: m.id,
        organizationId: project.organizationId,
        sourceTable: "evidence_items",
        sourceRecordId: e.id,
        href: `/evidence/${e.id}`,
        recordStatus: "AUTHORITATIVE",
        // Location comes ONLY from the record's own stored fix. The
        // capture is the moment the fix belongs to; the upload happened
        // wherever the device later found connectivity, so it carries none.
        spatial:
          e.latitude !== null && e.longitude !== null
            ? { latitude: e.latitude, longitude: e.longitude }
            : null,
      });
      push({
        at: e.uploadedAt,
        category: "EVIDENCE",
        type: "EVIDENCE_UPLOADED",
        title: `Evidence uploaded — ${m.title}`,
        explanation: "The captured evidence was uploaded and hash-anchored into the evidence ledger.",
        actorUserId: e.userId,
        projectId: project.id,
        milestoneId: m.id,
        organizationId: project.organizationId,
        sourceTable: "evidence_items",
        sourceRecordId: e.id,
        href: `/evidence/${e.id}`,
        recordStatus: "AUTHORITATIVE",
      });
      const v = safe(() => repo.getVerificationForEvidence(e.id), null);
      if (v) {
        push({
          at: v.createdAt,
          category: "EVIDENCE",
          type: "EVIDENCE_VERIFIED",
          title: `Evidence reviewed — ${v.verdict.replace(/_/g, " ").toLowerCase()}`,
          explanation:
            `Verification verdict ${v.verdict} at ${(v.confidence * 100).toFixed(0)}% confidence ` +
            `(source: ${v.source}).`,
          projectId: project.id,
          milestoneId: m.id,
          organizationId: project.organizationId,
          sourceTable: "verifications",
          sourceRecordId: v.id,
          href: `/evidence/${e.id}`,
          recordStatus: "AUTHORITATIVE",
          severity: v.verdict === "REJECTED" ? "HIGH" : v.verdict === "NEEDS_REVIEW" ? "MEDIUM" : "INFO",
          change: { field: "verdict", previous: null, current: v.verdict },
        });
      }
    }
  }
}

/** Evidence Intelligence — ADVISORY findings and reviewer queue actions. */
export function collectEvidenceIntel(ctx: CollectorContext): void {
  const { project, push, noteCap } = ctx;
  const signals = safe(() => evidenceIntelRepo.listSignalsForProjects([project.id], { limit: SIGNAL_READ_CAP }), []);
  if (signals.length >= SIGNAL_READ_CAP) {
    noteCap(`evidence_signals: showing the most recent ${SIGNAL_READ_CAP} advisory findings`);
  }
  for (const s of signals) {
    push({
      at: s.occurredAt,
      category: "EVIDENCE_INTEL",
      type: `SIGNAL_${s.category}`,
      title: `Advisory finding — ${s.title}`,
      explanation: s.explanation,
      projectId: project.id,
      organizationId: project.organizationId,
      sourceTable: "evidence_signals",
      sourceRecordId: s.id,
      href: `/evidence-intelligence`,
      recordStatus: "ADVISORY",
      severity: s.severity,
    });
  }
  const queue = safe(() => evidenceIntelRepo.listReviewForProjects([project.id], { limit: REVIEW_READ_CAP }), []);
  if (queue.length >= REVIEW_READ_CAP) {
    noteCap(`evidence review queue: showing the most recent ${REVIEW_READ_CAP} items`);
  }
  for (const item of queue) {
    for (const ev of safe(() => evidenceIntelRepo.listReviewEvents(item.id), [])) {
      if (ev.kind === "CREATED") continue; // the signal itself already appears
      push({
        at: ev.occurredAt,
        category: "EVIDENCE_INTEL",
        type: `REVIEW_${ev.kind}`,
        title: `Reviewer ${ev.kind.toLowerCase()} an advisory finding`,
        explanation:
          `A reviewer ${ev.kind.toLowerCase()} this Evidence Intelligence finding` +
          `${ev.detail ? `: ${ev.detail}` : ""}. Promotion to a governed exception is the only path from ` +
          "advisory to governed, and it is always a human decision.",
        actorUserId: ev.actorUserId,
        projectId: project.id,
        organizationId: project.organizationId,
        sourceTable: "evidence_review_events",
        sourceRecordId: ev.id,
        href: `/evidence-intelligence/queue/${item.id}`,
        recordStatus: "ADVISORY",
      });
    }
  }
}

/** Official Source Connectors — retrievals, changes, reviewer decisions. */
export function collectOfficialSources(ctx: CollectorContext): void {
  const { project, push, noteCap } = ctx;
  const candidates = safe(() => officialSourcesRepo.listCandidatesForProjects([project.id], SOURCE_READ_CAP), []);
  if (candidates.length >= SOURCE_READ_CAP) {
    noteCap(`source_candidates: showing the most recent ${SOURCE_READ_CAP} retrieved records`);
  }
  for (const c of candidates) {
    push({
      at: c.createdAt,
      category: "OFFICIAL_SOURCE",
      type: "SOURCE_RECORD_RETRIEVED",
      title: `Official record retrieved — ${c.externalId}`,
      explanation:
        `${c.agency} record ${c.externalId} was retrieved and normalized` +
        `${c.verbatimStatus ? ` (official status: "${c.verbatimStatus}")` : ""}. ` +
        "Retrieved information is evidence for human review, never an OBV determination.",
      projectId: project.id,
      organizationId: project.organizationId,
      sourceTable: "source_candidates",
      sourceRecordId: c.id,
      href: `/official-sources/project/${project.id}`,
      recordStatus: "ADVISORY",
    });
  }
  const changes = safe(() => officialSourcesRepo.listChangesForProjects([project.id], SOURCE_READ_CAP), []);
  if (changes.length >= SOURCE_READ_CAP) {
    noteCap(`source_change_events: showing the most recent ${SOURCE_READ_CAP} changes`);
  }
  for (const ch of changes) {
    push({
      at: ch.createdAt,
      category: "OFFICIAL_SOURCE",
      type: `SOURCE_${ch.changeKind}`,
      title: `Official source change — ${ch.changeKind.replace(/_/g, " ").toLowerCase()}`,
      explanation: ch.explanation,
      projectId: project.id,
      organizationId: project.organizationId,
      sourceTable: "source_change_events",
      sourceRecordId: ch.id,
      href: `/official-sources/project/${project.id}`,
      recordStatus: "ADVISORY",
      severity: ch.severity,
      change: ch.changedFields[0]
        ? { field: ch.changedFields[0].field, previous: ch.changedFields[0].previous, current: ch.changedFields[0].current }
        : null,
    });
  }
  const sourceQueue = safe(() => officialSourcesRepo.listReviewForProjects([project.id], { limit: SOURCE_READ_CAP }), []);
  if (sourceQueue.length >= SOURCE_READ_CAP) {
    noteCap(`source review queue: showing the most recent ${SOURCE_READ_CAP} items`);
  }
  for (const item of sourceQueue) {
    for (const ev of safe(() => officialSourcesRepo.listReviewEvents(item.id), [])) {
      if (ev.kind === "CREATED") continue;
      push({
        at: ev.occurredAt,
        category: "OFFICIAL_SOURCE",
        type: `SOURCE_REVIEW_${ev.kind}`,
        title: `Reviewer ${ev.kind.replace(/_/g, " ").toLowerCase()} an official-source item`,
        explanation:
          `A reviewer resolved the official-source review item "${item.title}" as ${ev.kind}` +
          `${ev.detail ? `: ${ev.detail}` : ""}. Confirmations attach through the governed permits and ` +
          "DMV commands; the connector layer never writes those records itself.",
        actorUserId: ev.actorUserId,
        projectId: project.id,
        organizationId: project.organizationId,
        sourceTable: "source_review_events",
        sourceRecordId: ev.id,
        href: `/official-sources/queue/${item.id}`,
        recordStatus: ev.kind === "CONFIRMED" || ev.kind === "PROMOTED" ? "AUTHORITATIVE" : "ADVISORY",
      });
    }
  }
  for (const rec of safe(() => repo.listOfficialSourcesForProject(project.id), [])) {
    push({
      at: rec.lookupPerformedAt,
      category: "OFFICIAL_SOURCE",
      type: "OFFICIAL_SOURCE_ATTACHED",
      title: `Official source reference attached${rec.officialRecordNumber ? ` — ${rec.officialRecordNumber}` : ""}`,
      explanation:
        `An authorized reviewer attached an official source reference` +
        `${rec.officialSystemName ? ` from ${rec.officialSystemName}` : ""}` +
        `${rec.officialStatusText ? ` (official status: "${rec.officialStatusText}")` : ""}.`,
      actorUserId: rec.lookupPerformedByUserId,
      projectId: project.id,
      milestoneId: rec.milestoneId,
      organizationId: project.organizationId,
      sourceTable: "official_source_records",
      sourceRecordId: rec.id,
      href: `/permits`,
      recordStatus: "AUTHORITATIVE",
    });
  }
}

// ------------------------------------------------------------ disputes / exceptions

export function collectDisputes(ctx: CollectorContext): void {
  const { project, push } = ctx;
  for (const d of safe(() => disputeRepo.listDisputesForProject(project.id), [])) {
    push({
      at: (d as { openedAt?: string; createdAt?: string }).openedAt ?? (d as { createdAt?: string }).createdAt,
      category: "DISPUTE",
      type: "DISPUTE_OPENED",
      title: `Dispute opened — ${(d as { title?: string }).title ?? d.id}`,
      explanation:
        "A dispute was opened against a governed record. Disputes follow their own resolution workflow and " +
        "can place holds on releases.",
      actorUserId: d.openedByUserId,
      projectId: project.id,
      milestoneId: d.milestoneId,
      drawRequestId: d.drawRequestId,
      organizationId: project.organizationId,
      sourceTable: "disputes",
      sourceRecordId: d.id,
      href: `/disputes`,
      recordStatus: "AUTHORITATIVE",
      severity: "MEDIUM",
    });
    const resolvedAt = (d as { resolvedAt?: string | null }).resolvedAt ?? null;
    if (resolvedAt) {
      push({
        at: resolvedAt,
        category: "DISPUTE",
        type: "DISPUTE_RESOLVED",
        title: `Dispute resolved — ${d.status}`,
        explanation: `The dispute reached status ${d.status} through its governed resolution workflow.`,
        projectId: project.id,
        milestoneId: d.milestoneId,
        drawRequestId: d.drawRequestId,
        organizationId: project.organizationId,
        sourceTable: "disputes",
        sourceRecordId: d.id,
        href: `/disputes`,
        recordStatus: "AUTHORITATIVE",
        change: { field: "status", previous: "OPEN", current: d.status },
      });
    }
  }
}

export function collectExceptions(ctx: CollectorContext): void {
  const { project, push } = ctx;
  for (const x of safe(() => repo.listExceptionsForProject(project.id), [])) {
    push({
      at: x.createdAt,
      category: "EXCEPTION",
      type: "EXCEPTION_RAISED",
      title: `Exception raised — ${x.title}`,
      explanation:
        `A ${x.severity.toLowerCase()} ${x.category.toLowerCase()} exception was recorded. Exceptions are ` +
        "control records: they never release money, and they clear only when their source condition clears.",
      projectId: project.id,
      milestoneId: x.milestoneId,
      drawRequestId: x.drawRequestId,
      organizationId: project.organizationId,
      sourceTable: "exceptions",
      sourceRecordId: x.id,
      href: `/exceptions`,
      recordStatus: "AUTHORITATIVE",
      severity: x.severity === "CRITICAL" ? "HIGH" : x.severity,
    });
    const resolvedAt = (x as { resolvedAt?: string | null }).resolvedAt ?? null;
    if (resolvedAt) {
      push({
        at: resolvedAt,
        category: "EXCEPTION",
        type: "EXCEPTION_RESOLVED",
        title: `Exception ${x.status.toLowerCase()} — ${x.title}`,
        explanation: `The exception reached status ${x.status}.`,
        projectId: project.id,
        milestoneId: x.milestoneId,
        drawRequestId: x.drawRequestId,
        organizationId: project.organizationId,
        sourceTable: "exceptions",
        sourceRecordId: x.id,
        href: `/exceptions`,
        recordStatus: "AUTHORITATIVE",
        change: { field: "status", previous: "OPEN", current: x.status },
      });
    }
  }
}

// ------------------------------------------------------------ draws / money

export function collectDraws(ctx: CollectorContext): void {
  const { project, push } = ctx;
  for (const d of safe(() => repo.listDrawRequestsForProject(project.id), [])) {
    push({
      at: (d as { createdAt?: string | null }).createdAt,
      category: "DRAW",
      type: "DRAW_CREATED",
      title: `Draw ${d.drawNumber} created`,
      explanation: "A draw request was opened and began assembling its evidence and document package.",
      actorUserId: d.requestedByUserId,
      projectId: project.id,
      drawRequestId: d.id,
      organizationId: project.organizationId,
      sourceTable: "draw_requests",
      sourceRecordId: d.id,
      href: `/draws/${d.id}`,
      recordStatus: "AUTHORITATIVE",
    });
    if (d.submittedAt) {
      push({
        at: d.submittedAt,
        category: "DRAW",
        type: "DRAW_SUBMITTED",
        title: `Draw ${d.drawNumber} submitted`,
        explanation: "The draw request was submitted for lender review with its supporting package.",
        actorUserId: d.requestedByUserId,
        projectId: project.id,
        drawRequestId: d.id,
        organizationId: project.organizationId,
        sourceTable: "draw_requests",
        sourceRecordId: d.id,
        href: `/draws/${d.id}`,
        recordStatus: "AUTHORITATIVE",
        change: { field: "status", previous: "DRAFT", current: "SUBMITTED" },
      });
    }

    // Readiness transitions — the governed readiness machine's own
    // immutable draw_events rows. Each is HISTORY: what OBV's recorded
    // readiness state became at that moment, under the policy version
    // then in force. The stored row carries {status, from, policyVersion}
    // and nothing else — in particular it records NO blocking reasons, so
    // no cause is ever attached here. Never recomputed, never reconciled
    // against today's readiness.
    for (const ev of safe(() => repo.listDrawEvents(d.id), [])) {
      if (ev.type !== "READINESS_TRANSITION") continue;
      let detail: { status?: string; from?: string | null; policyVersion?: number } = {};
      try {
        detail = JSON.parse(ev.detail) as typeof detail;
      } catch {
        detail = {};
      }
      const to = typeof detail.status === "string" ? detail.status : "UNRECORDED";
      const from = typeof detail.from === "string" ? detail.from : null;
      push({
        at: ev.createdAt,
        category: "DRAW",
        type: "READINESS_TRANSITION",
        title: `Draw ${d.drawNumber} readiness moved to ${to.replace(/_/g, " ")}`,
        explanation:
          (from
            ? `OBV's recorded readiness state for draw ${d.drawNumber} moved from ${from} to ${to}`
            : `OBV recorded its first readiness state for draw ${d.drawNumber}: ${to}`) +
          `${typeof detail.policyVersion === "number" ? ` under readiness policy version ${detail.policyVersion}` : ""}. ` +
          "Readiness is OBV's evaluation of governed requirements — it is not a lender approval and never releases funds.",
        actorUserId: ev.actorUserId,
        projectId: project.id,
        drawRequestId: d.id,
        organizationId: project.organizationId,
        sourceTable: "draw_events",
        sourceRecordId: ev.id,
        href: `/draws/${d.id}`,
        recordStatus: "AUTHORITATIVE",
        severity:
          to === "HOLD" || to === "EXCEPTION_REVIEW" || to === "INCOMPLETE" ? "MEDIUM" : "INFO",
        change: { field: "readiness", previous: from, current: to },
      });
    }
  }

  // Approval requests / records (the governed multi-party approval path).
  for (const req of safe(() => repo.listApprovalRequestsForProject(project.id), [])) {
    push({
      at: req.createdAt,
      category: "DECISION",
      type: "APPROVAL_REQUESTED",
      title: "Approval requested",
      explanation: "A governed approval request was opened against the configured approval matrix.",
      projectId: project.id,
      milestoneId: req.milestoneId,
      organizationId: project.organizationId,
      sourceTable: "approval_requests",
      sourceRecordId: req.id,
      href: `/approvals`,
      recordStatus: "AUTHORITATIVE",
    });
    for (const rec of safe(() => repo.listApprovalRecordsForRequest(req.id), [])) {
      push({
        at: rec.createdAt,
        category: "DECISION",
        type: "APPROVAL_RECORDED",
        title: `Approval decision recorded — ${(rec as { decision?: string }).decision ?? "recorded"}`,
        explanation: "An authorized approver recorded their decision on the governed approval request.",
        actorUserId: rec.userId,
        projectId: project.id,
        milestoneId: req.milestoneId,
        organizationId: project.organizationId,
        sourceTable: "approval_records",
        sourceRecordId: rec.id,
        href: `/approvals`,
        recordStatus: "AUTHORITATIVE",
      });
    }
  }

  // Lender draw decisions — ALL recorded decisions, superseded included:
  // a superseded decision is retained history, never erased. It is
  // marked as superseded so a reader can tell the standing decision from
  // an amended-past one.
  for (const dec of safe(() => lenderRepo.listLenderDecisionsForProject(project.id), [])) {
    const superseded = Boolean(dec.supersededByDecisionId);
    push({
      at: dec.decisionAt,
      category: "DECISION",
      type: `LENDER_${dec.decision}`,
      title: `Lender decision — ${String(dec.decision).replace(/_/g, " ").toLowerCase()}`,
      explanation:
        `The lender recorded a ${String(dec.decision).toLowerCase()} decision on this draw` +
        `${dec.decisionReason ? `: ${dec.decisionReason}` : ""}.` +
        (superseded
          ? " This decision was later superseded by an amended decision and is retained here as history."
          : ""),
      actorUserId: dec.reviewerUserId,
      projectId: project.id,
      drawRequestId: dec.drawRequestId,
      organizationId: project.organizationId,
      sourceTable: "lender_draw_decisions",
      sourceRecordId: dec.id,
      href: `/draws/${dec.drawRequestId}`,
      recordStatus: "AUTHORITATIVE",
      severity: /REJECT|DECLINE/i.test(String(dec.decision)) ? "HIGH" : "INFO",
    });
  }
}

/** Payment instructions and banking provider confirmations. */
export function collectPayments(ctx: CollectorContext): void {
  const { project, push } = ctx;
  for (const ev of safe(() => bankingRepo.listBankingEventsForProject(project.id), [])) {
    const kind = String((ev as { kind?: string; eventType?: string }).kind ?? (ev as { eventType?: string }).eventType ?? "BANKING_EVENT");
    push({
      at: (ev as { occurredAt?: string; createdAt?: string }).occurredAt ?? (ev as { createdAt?: string }).createdAt,
      category: "PAYMENT",
      type: kind,
      title: `Banking event — ${kind.replace(/_/g, " ").toLowerCase()}`,
      explanation:
        "A banking-layer event recorded against this project. Money movement follows the governed release " +
        "path with its own safeguards; the timeline only reports what was recorded.",
      projectId: project.id,
      drawRequestId: (ev as { drawRequestId?: string | null }).drawRequestId ?? null,
      organizationId: project.organizationId,
      sourceTable: "banking_events",
      sourceRecordId: (ev as { id: string }).id,
      href: `/banking`,
      recordStatus: "AUTHORITATIVE",
    });
  }
  // Payment instructions per draw (bounded by the project's draws).
  for (const d of safe(() => repo.listDrawRequestsForProject(project.id), [])) {
    for (const pi of safe(() => bankingRepo.listInstructionsForDraw(d.id), [])) {
      push({
        at: (pi as { createdAt?: string }).createdAt,
        category: "PAYMENT",
        type: "PAYMENT_INSTRUCTION_CREATED",
        title: `Payment instruction created — draw ${d.drawNumber}`,
        explanation:
          "A payment instruction was created for an approved draw. Creation follows the governed release " +
          "path; the timeline never creates or authorizes one.",
        projectId: project.id,
        drawRequestId: d.id,
        organizationId: project.organizationId,
        sourceTable: "payment_instructions",
        sourceRecordId: (pi as { id: string }).id,
        href: `/draws/${d.id}`,
        recordStatus: "AUTHORITATIVE",
      });
      const settledAt = (pi as { settledAt?: string | null }).settledAt ?? null;
      if (settledAt) {
        push({
          at: settledAt,
          category: "PAYMENT",
          type: "PAYMENT_CONFIRMED",
          title: `Provider confirmed settlement — draw ${d.drawNumber}`,
          explanation: "The banking provider confirmed settlement of this payment instruction.",
          projectId: project.id,
          drawRequestId: d.id,
          organizationId: project.organizationId,
          sourceTable: "payment_instructions",
          sourceRecordId: (pi as { id: string }).id,
          href: `/draws/${d.id}`,
          recordStatus: "AUTHORITATIVE",
          change: { field: "status", previous: "PENDING", current: "SETTLED" },
        });
      }
    }
  }
}

/** Executive reports and audit packages. */
export function collectReports(ctx: CollectorContext): void {
  const { project, push } = ctx;
  for (const pkg of safe(() => repo.listAuditPackagesForProject(project.id), [])) {
    push({
      at: (pkg as { createdAt?: string; generatedAt?: string }).generatedAt ?? (pkg as { createdAt?: string }).createdAt,
      category: "REPORT",
      type: "AUDIT_PACKAGE_GENERATED",
      title: "Audit package generated",
      explanation:
        "A point-in-time audit package was generated. Historical packages are immutable: later changes never " +
        "alter what a generated package contains.",
      actorUserId: (pkg as { generatedByUserId?: string | null }).generatedByUserId ?? null,
      projectId: project.id,
      organizationId: project.organizationId,
      sourceTable: "audit_packages",
      sourceRecordId: (pkg as { id: string }).id,
      href: `/reports`,
      recordStatus: "AUTHORITATIVE",
    });
  }
}

/** Collectors whose source records are readable by anyone who can reach
 *  the project itself. */
export const COLLECTORS: Array<(ctx: CollectorContext) => void> = [
  collectProject,
  collectGovernance,
  collectBudget,
  collectMilestones,
  collectPermits,
  collectInspections,
  collectEvidence,
  collectDisputes,
  collectExceptions,
  collectDraws,
  collectReports,
];

/**
 * Collectors whose subsystem gates reads MORE NARROWLY than "can see the
 * project". The timeline must never widen an existing gate, so each one
 * is admitted only when that subsystem's own predicate says this caller
 * could already read those records through its governed pages. The
 * predicates are imported rather than restated so there is exactly one
 * source of truth per gate.
 */
export const GATED_COLLECTORS: Array<{
  collect: (ctx: CollectorContext) => void;
  allowed: (user: User, project: Project) => boolean;
}> = [
  { collect: collectEvidenceIntel, allowed: (user) => canViewEvidenceIntel(user) },
  { collect: collectOfficialSources, allowed: (user) => canViewSources(user) },
  {
    // Banking reads require VIEW_PROJECT_ACCOUNT, not merely project
    // access — the governed banking surface shows nothing without it.
    collect: collectPayments,
    allowed: (user, project) => hasBankingCapability(user, project.id, "VIEW_PROJECT_ACCOUNT"),
  },
];

/** Run every collector this caller is entitled to for one project.
 *  Returns unsorted events plus any source-level caps that applied. */
export function collectAll(
  project: Project,
  actors: ActorResolver,
  user: User
): { events: TimelineEvent[]; caps: string[] } {
  const events: TimelineEvent[] = [];
  const caps: string[] = [];
  const push: Push = (draft) => {
    const event = makeEvent(draft, actors);
    if (event) events.push(event);
  };
  const ctx: CollectorContext = {
    project,
    actors,
    push,
    noteCap: (note) => { if (!caps.includes(note)) caps.push(note); },
  };
  for (const collector of COLLECTORS) {
    safe(() => collector(ctx), undefined);
  }
  for (const gated of GATED_COLLECTORS) {
    // A gate that cannot be evaluated denies rather than admits.
    if (!safe(() => gated.allowed(user, project), false)) continue;
    safe(() => gated.collect(ctx), undefined);
  }
  return { events, caps };
}
