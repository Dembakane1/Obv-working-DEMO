/**
 * Dispute + release-hold HTTP routes — kept out of server.ts so the
 * domain, persistence, routing and view responsibilities stay separate.
 *
 * Every mutation is authorized inside the dispute service (tenant-safe
 * 404, capability 403, separation of duties, guarded transitions);
 * these handlers only parse input and content-negotiate the response.
 * Browser form posts bounce back to the dispute workspace with
 * ?ok= / ?err=; JSON clients receive plain JSON. Nothing here writes
 * SQLite directly.
 */
import type * as http from "node:http";
import * as disputes from "../services/disputes";
import type { User } from "../../shared/types";

export interface DisputeRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  getUser: () => User;
  readParams: () => Promise<Record<string, string>>;
  isForm: () => boolean;
  redirect: (location: string) => void;
  sendJson: (data: unknown, status?: number) => void;
}

/** Returns true when the request was handled by a dispute route. */
export async function handleDisputeRoutes(ctx: DisputeRouteContext): Promise<boolean> {
  const { pathname, method } = ctx;

  const finish = (disputeId: string | null, json: unknown, status = 200): void => {
    if (ctx.isForm() && disputeId) {
      ctx.redirect(`/dispute/${disputeId}?ok=1`);
    } else {
      ctx.sendJson(json, status);
    }
  };
  const list = (v: string | undefined): string[] =>
    (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

  // ---------------- project-scoped register ----------------
  const projectApi = /^\/api\/projects\/([^/]+)\/disputes$/.exec(pathname);
  if (projectApi) {
    const user = ctx.getUser();
    if (method === "GET") {
      ctx.sendJson({ disputes: disputes.listProjectDisputes(user, projectApi[1]) });
      return true;
    }
    if (method === "POST") {
      const body = await ctx.readParams();
      const dispute = disputes.openDispute(user, {
        projectId: projectApi[1],
        subjectType: body.subjectType ?? "",
        subjectId: body.subjectId ?? "",
        disputedAmount: body.disputedAmount,
        undisputedAmount: body.undisputedAmount || null,
        affectedScope: body.affectedScope ?? "",
        affectedLineIds: list(body.affectedLineIds),
        reason: body.reason ?? "",
        responsibleReviewerUserId: body.responsibleReviewerUserId || null,
      });
      finish(dispute.id, { dispute }, 201);
      return true;
    }
    throw new disputes.DisputeError("Method not allowed", 405);
  }

  // ---------------- dispute-scoped actions ----------------
  const disputeApi = /^\/api\/disputes\/([^/]+)(?:\/(transition|responses|evidence|cures|inspections|recommendation|legal-hold|escalations|resolve|close))?$/.exec(pathname);
  if (disputeApi) {
    const user = ctx.getUser();
    const id = disputeApi[1];
    const section = disputeApi[2] ?? null;
    if (method === "GET" && section === null) {
      ctx.sendJson(disputes.disputeDetail(user, id));
      return true;
    }
    if (method !== "POST") throw new disputes.DisputeError("Method not allowed", 405);
    const body = await ctx.readParams();
    switch (section) {
      case "transition": {
        const dispute = disputes.transitionDispute(user, id, body.to ?? "", body.reason || null);
        finish(dispute.id, { dispute });
        return true;
      }
      case "responses": {
        const response = disputes.submitResponse(user, id, {
          kind: body.kind || null,
          body: body.body ?? "",
          supersedesResponseId: body.supersedesResponseId || null,
        });
        finish(id, { response }, 201);
        return true;
      }
      case "evidence": {
        const record = disputes.submitEvidence(user, id, {
          evidenceType: body.evidenceType ?? "",
          title: body.title ?? "",
          description: body.description || null,
          linkedType: body.linkedType || null,
          linkedId: body.linkedId || null,
          externalReference: body.externalReference || null,
          supersedesEvidenceId: body.supersedesEvidenceId || null,
        });
        finish(id, { evidence: record }, 201);
        return true;
      }
      case "cures": {
        const cure = disputes.createCureItem(user, id, {
          title: body.title ?? "",
          description: body.description ?? "",
          responsiblePartyUserId: body.responsiblePartyUserId || null,
          responsibleOrganizationId: body.responsibleOrganizationId || null,
          dueAt: body.dueAt || null,
          evidenceRequired: body.evidenceRequired || null,
          affectedScope: body.affectedScope || null,
          affectedAmount: body.affectedAmount || null,
          priority: body.priority || null,
        });
        finish(id, { cure }, 201);
        return true;
      }
      case "inspections": {
        const inspection = disputes.requestDisputeInspection(user, id, {
          inspectionType: body.inspectionType ?? "",
          assignedInspectorUserId: body.assignedInspectorUserId || null,
          locationScope: body.locationScope || null,
        });
        finish(id, { inspection }, 201);
        return true;
      }
      case "recommendation": {
        const recommendation = disputes.recordRecommendation(user, id, {
          kind: body.kind ?? "",
          summary: body.summary ?? "",
          basis: body.basis || null,
          aiGenerated: body.aiGenerated === "true" || body.aiGenerated === "1",
          supersedesRecommendationId: body.supersedesRecommendationId || null,
        });
        finish(id, { recommendation, note: disputes.ADVISORY_NOTE }, 201);
        return true;
      }
      case "legal-hold": {
        const dispute = disputes.setLegalHold(user, id, {
          active: body.active === "true" || body.active === "1",
          reason: body.reason ?? "",
        });
        finish(dispute.id, { dispute });
        return true;
      }
      case "escalations": {
        const escalation = disputes.recordEscalation(user, id, {
          escalationType: body.escalationType ?? "",
          recipientName: body.recipientName ?? "",
          recipientOrganization: body.recipientOrganization || null,
          reason: body.reason ?? "",
          transmittedMaterials: body.transmittedMaterials || null,
        });
        finish(id, { escalation }, 201);
        return true;
      }
      case "resolve": {
        const dispute = disputes.resolveDispute(user, id, {
          resolutionType: body.resolutionType ?? "",
          amount: body.amount || null,
          reasoning: body.reasoning ?? "",
          conditions: body.conditions || null,
          evidenceIds: list(body.evidenceIds),
          externalReference: body.externalReference || null,
          acknowledged: body.acknowledged === "true" || body.acknowledged === "1",
        });
        finish(dispute.id, { dispute, acknowledgement: disputes.RESOLUTION_ACKNOWLEDGEMENT });
        return true;
      }
      case "close": {
        const dispute = disputes.closeDispute(user, id, body.note || null);
        finish(dispute.id, { dispute });
        return true;
      }
      default:
        throw new disputes.DisputeError("Method not allowed", 405);
    }
  }

  // ---------------- sub-record actions ----------------
  const evidenceApi = /^\/api\/dispute-evidence\/([^/]+)\/review$/.exec(pathname);
  if (evidenceApi && method === "POST") {
    const user = ctx.getUser();
    const body = await ctx.readParams();
    const record = disputes.reviewEvidence(user, evidenceApi[1], { status: body.status ?? "", notes: body.notes || null });
    finish(record.disputeId, { evidence: record });
    return true;
  }

  const cureApi = /^\/api\/dispute-cures\/([^/]+)\/(submit|review|waive|cancel|extend)$/.exec(pathname);
  if (cureApi && method === "POST") {
    const user = ctx.getUser();
    const body = await ctx.readParams();
    const action = cureApi[2];
    let cure;
    if (action === "submit") {
      cure = disputes.submitCure(user, cureApi[1], { completionNote: body.completionNote ?? "", completionEvidenceId: body.completionEvidenceId || null });
    } else if (action === "review") {
      cure = disputes.reviewCure(user, cureApi[1], { decision: body.decision ?? "", note: body.note || null });
    } else if (action === "waive") {
      cure = disputes.waiveCure(user, cureApi[1], body.reason ?? "");
    } else if (action === "cancel") {
      cure = disputes.cancelCure(user, cureApi[1], body.reason || null);
    } else {
      cure = disputes.extendCureDeadline(user, cureApi[1], { newDueAt: body.newDueAt ?? "", reason: body.reason ?? "" });
    }
    finish(cure.disputeId, { cure });
    return true;
  }

  const inspApi = /^\/api\/dispute-inspections\/([^/]+)\/(schedule|complete|access-failed|cancel)$/.exec(pathname);
  if (inspApi && method === "POST") {
    const user = ctx.getUser();
    const body = await ctx.readParams();
    const inspection = disputes.updateDisputeInspection(user, inspApi[1], {
      action: inspApi[2],
      scheduledAt: body.scheduledAt || null,
      assignedInspectorUserId: body.assignedInspectorUserId || null,
      result: body.result || null,
      notes: body.notes || null,
      followUp: body.followUp || null,
    });
    finish(inspection.disputeId, { inspection });
    return true;
  }

  const recApi = /^\/api\/dispute-recommendations\/([^/]+)\/approve$/.exec(pathname);
  if (recApi && method === "POST") {
    const user = ctx.getUser();
    const recommendation = disputes.approveRecommendation(user, recApi[1]);
    finish(recommendation.disputeId, { recommendation });
    return true;
  }

  const escApi = /^\/api\/dispute-escalations\/([^/]+)\/(respond|close)$/.exec(pathname);
  if (escApi && method === "POST") {
    const user = ctx.getUser();
    const body = await ctx.readParams();
    const escalation = disputes.updateEscalation(user, escApi[1], { action: escApi[2], response: body.response || null });
    finish(escalation.disputeId, { escalation });
    return true;
  }

  return false;
}
