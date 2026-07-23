/**
 * Dispute + release-hold registers for the Draw Verification Package and
 * the Project Audit Package.
 *
 * Honesty rules (same doctrine as the banking registers):
 *   - explicit as-of filtering: only records that existed at the
 *     package's generatedAt instant are included;
 *   - disputes are workflow records — the registers state disputed and
 *     undisputed amounts as recorded assertions, never as accounting
 *     adjustments; authoritative balances are computed elsewhere and are
 *     not modified by anything here;
 *   - recommendations carry the mandatory advisory disclaimer and their
 *     AI-generated flag; resolutions carry the recorded-decision
 *     acknowledgement — the package never implies OBV held funds or made
 *     a binding determination;
 *   - projects with no disputes get an explicit "No disputes recorded"
 *     summary — values are never fabricated.
 */
import * as drepo from "../db/disputeRepo";
import { drawDisputeHold, ADVISORY_NOTE, RESOLUTION_ACKNOWLEDGEMENT } from "./disputes";
import { csv, type PackageFile } from "./auditPackage";
import type { Dispute, User } from "../../shared/types";

const NOT_RECORDED = "Not recorded";

export function disputeRegisterFiles(input: {
  projectId: string;
  /** Restrict the registers to disputes attached to one draw (draw
   *  package); null includes the whole project (audit package). */
  drawRequestId: string | null;
  asOf: string;
  /** ZIP directory prefix, e.g. "" or "12_disputes/". */
  prefix: string;
  users: Map<string, User>;
}): { files: PackageFile[]; counts: Record<string, number> } {
  const { projectId, drawRequestId, asOf, prefix } = input;
  const inWindow = (iso: string): boolean => iso <= asOf;
  const userName = (id: string | null): string => (id ? input.users.get(id)?.name ?? id : NOT_RECORDED);

  const files: PackageFile[] = [];
  const counts: Record<string, number> = {};
  const add = (name: string, content: string, count: number): void => {
    files.push({ name: `${prefix}${name}`, data: Buffer.from(content, "utf8") });
    counts[`${prefix}${name}`] = count;
  };

  const all = drepo
    .listDisputesForProject(projectId)
    .filter((d) => inWindow(d.openedAt))
    .filter((d) => (drawRequestId ? d.drawRequestId === drawRequestId : true));

  // ---- dispute-summary.json (always present; honest when empty)
  // RESOLVED_PARTIAL_RELEASE stays "active" — the disputed remainder is
  // still held; only fully-terminal statuses end the hold.
  const activeStatuses = (d: Dispute): boolean =>
    !["RESOLVED_RELEASE", "RESOLVED_CONTINUE_HOLD", "RESOLVED_RETURN_RECOMMENDATION", "CLOSED"].includes(d.status);
  const hold = drawRequestId ? drawDisputeHold(drawRequestId) : null;
  const summary = all.length
    ? {
        state: "RECORDED",
        asOf,
        disputes: all.length,
        active: all.filter(activeStatuses).length,
        legalHoldActive: all.some((d) => d.legalHold),
        releaseHold: hold
          ? { blocked: hold.blocked, partialHeldAmount: hold.partialHeldAmount, reasons: hold.blockedReasons }
          : NOT_RECORDED + " — project-level package; release holds are evaluated per draw.",
        note:
          "Disputes are workflow and authorization records. Disputed and undisputed amounts are recorded assertions and never modify authoritative accounting balances. " +
          "OBV is not the escrow agent, does not make binding legal determinations, and does not hold or move funds.",
      }
    : {
        state: "NOT_RECORDED",
        asOf,
        note: "No disputes recorded for this scope at the as-of instant. Nothing is inferred or fabricated.",
      };
  add("dispute-summary.json", JSON.stringify(summary, null, 2), all.length);

  // ---- dispute-register.csv
  add(
    "dispute-register.csv",
    csv(
      [
        "disputeId", "status", "subjectType", "subjectId", "drawRequestId", "milestoneId",
        "paymentInstructionId", "disputedAmount", "undisputedAmount", "affectedScope",
        "reason", "openedBy", "openedAt", "legalHold", "legalHoldBy", "legalHoldReason",
        "resolutionType", "resolutionAmount", "resolvedBy", "resolvedByRole", "resolvedAt",
        "resolutionExternalReference", "closedAt",
      ],
      all.map((d) => [
        d.id, d.status, d.subjectType, d.subjectId, d.drawRequestId ?? "", d.milestoneId ?? "",
        d.paymentInstructionId ?? "", d.disputedAmount, d.undisputedAmount ?? "", d.affectedScope,
        d.reason, userName(d.openedByUserId), d.openedAt, d.legalHold ? "ACTIVE" : "",
        userName(d.legalHoldByUserId), d.legalHoldReason ?? "",
        d.resolutionType ?? "", d.resolutionAmount ?? "", userName(d.resolvedByUserId),
        d.resolvedByRole ?? "", d.resolvedAt ?? "", d.resolutionExternalReference ?? "", d.closedAt ?? "",
      ])
    ),
    all.length
  );

  // ---- per-dispute detail registers
  const events = all.flatMap((d) => drepo.listDisputeEvents(d.id)).filter((e) => inWindow(e.createdAt));
  add(
    "dispute-timeline.csv",
    csv(
      ["eventId", "disputeId", "type", "detail", "actor", "refId", "createdAt"],
      events.map((e) => [e.id, e.disputeId, e.type, e.detail, userName(e.actorUserId), e.refId ?? "", e.createdAt])
    ),
    events.length
  );

  const responses = all.flatMap((d) => drepo.listDisputeResponses(d.id)).filter((r) => inWindow(r.createdAt));
  add(
    "dispute-responses.csv",
    csv(
      ["responseId", "disputeId", "version", "kind", "body", "submittedBy", "supersedes", "createdAt"],
      responses.map((r) => [
        r.id, r.disputeId, r.version, r.kind, r.body, userName(r.submittedByUserId),
        r.supersedesResponseId ?? "", r.createdAt,
      ])
    ),
    responses.length
  );

  const evidence = all.flatMap((d) => drepo.listDisputeEvidence(d.id)).filter((e) => inWindow(e.createdAt));
  add(
    "dispute-evidence.csv",
    csv(
      [
        "recordId", "disputeId", "evidenceType", "title", "linkedType", "linkedId",
        "externalReference", "documentHash", "version", "supersedes", "submittedBy",
        "reviewStatus", "reviewedBy", "reviewedAt", "createdAt",
      ],
      evidence.map((e) => [
        e.id, e.disputeId, e.evidenceType, e.title, e.linkedType, e.linkedId ?? "",
        e.externalReference ?? "", e.documentHash, e.version, e.supersedesEvidenceId ?? "",
        userName(e.submittedByUserId), e.reviewStatus, userName(e.reviewedByUserId),
        e.reviewedAt ?? "", e.createdAt,
      ])
    ),
    evidence.length
  );

  const cures = all.flatMap((d) => drepo.listCureItems(d.id)).filter((c) => inWindow(c.createdAt));
  add(
    "dispute-cure-requirements.csv",
    csv(
      [
        "cureId", "disputeId", "title", "status", "priority", "responsibleParty", "dueAt",
        "affectedAmount", "submittedAt", "reviewedBy", "reviewedAt", "reviewNote",
        "waiverReason", "createdBy", "createdAt",
      ],
      cures.map((c) => [
        c.id, c.disputeId, c.title, c.status, c.priority, userName(c.responsiblePartyUserId),
        c.dueAt ?? "", c.affectedAmount ?? "", c.submittedAt ?? "", userName(c.reviewedByUserId),
        c.reviewedAt ?? "", c.reviewDecisionNote ?? "", c.waiverReason ?? "",
        userName(c.createdByUserId), c.createdAt,
      ])
    ),
    cures.length
  );

  const extensions = cures.flatMap((c) => drepo.listCureExtensions(c.id)).filter((x) => inWindow(x.createdAt));
  add(
    "dispute-cure-extensions.csv",
    csv(
      ["extensionId", "cureId", "priorDueAt", "newDueAt", "reason", "actor", "createdAt"],
      extensions.map((x) => [
        x.id, x.cureItemId, x.priorDueAt ?? "", x.newDueAt, x.reason, userName(x.actorUserId), x.createdAt,
      ])
    ),
    extensions.length
  );

  const inspections = all.flatMap((d) => drepo.listDisputeInspections(d.id)).filter((i) => inWindow(i.createdAt));
  add(
    "dispute-inspections.csv",
    csv(
      [
        "inspectionId", "disputeId", "inspectionType", "status", "requestedBy", "requestedAt",
        "assignedInspector", "scheduledAt", "completedAt", "result", "notes", "followUp",
      ],
      inspections.map((i) => [
        i.id, i.disputeId, i.inspectionType, i.status, userName(i.requestedByUserId), i.requestedAt,
        userName(i.assignedInspectorUserId), i.scheduledAt ?? "", i.completedAt ?? "",
        i.result ?? "", i.notes ?? "", i.followUp ?? "",
      ])
    ),
    inspections.length
  );

  const recommendations = all.flatMap((d) => drepo.listRecommendations(d.id)).filter((r) => inWindow(r.createdAt));
  add(
    "dispute-recommendations.csv",
    csv(
      ["recommendationId", "disputeId", "kind", "summary", "basis", "aiGenerated", "official", "createdBy", "approvedBy", "supersedes", "createdAt", "disclaimer"],
      recommendations.map((r) => [
        r.id, r.disputeId, r.kind, r.summary, r.basis ?? "", r.aiGenerated ? "AI_GENERATED" : "HUMAN",
        r.official ? "OFFICIAL" : "DRAFT", userName(r.createdByUserId), userName(r.approvedByUserId),
        r.supersedesRecommendationId ?? "", r.createdAt, ADVISORY_NOTE,
      ])
    ),
    recommendations.length
  );

  const escalations = all.flatMap((d) => drepo.listEscalations(d.id)).filter((e) => inWindow(e.createdAt));
  add(
    "dispute-escalations.csv",
    csv(
      ["escalationId", "disputeId", "escalationType", "recipient", "recipientOrganization", "reason", "transmittedMaterials", "status", "response", "submittedBy", "createdAt", "respondedAt", "closedAt"],
      escalations.map((e) => [
        e.id, e.disputeId, e.escalationType, e.recipientName, e.recipientOrganization ?? "",
        e.reason, e.transmittedMaterials ?? "", e.status, e.response ?? "",
        userName(e.submittedByUserId), e.createdAt, e.respondedAt ?? "", e.closedAt ?? "",
      ])
    ),
    escalations.length
  );

  // ---- resolutions (recorded decisions only)
  const resolved = all.filter((d) => d.resolvedAt && inWindow(d.resolvedAt));
  add(
    "dispute-resolutions.json",
    JSON.stringify(
      {
        asOf,
        acknowledgementRequiredAtDecision: RESOLUTION_ACKNOWLEDGEMENT,
        resolutions: resolved.map((d) => ({
          disputeId: d.id,
          resolutionType: d.resolutionType,
          resolutionAmount: d.resolutionAmount,
          reasoning: d.resolutionReasoning,
          conditions: d.resolutionConditions,
          evidenceIds: d.resolutionEvidenceIds ? JSON.parse(d.resolutionEvidenceIds) : [],
          externalReference: d.resolutionExternalReference,
          decidedBy: userName(d.resolvedByUserId),
          decidedByRole: d.resolvedByRole,
          resolvedAt: d.resolvedAt,
        })),
      },
      null,
      2
    ),
    resolved.length
  );

  return { files, counts };
}
