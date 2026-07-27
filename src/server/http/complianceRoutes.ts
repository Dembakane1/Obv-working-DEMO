/**
 * DMV compliance HTTP routes — Governing Code and Permit Basis, transition
 * rules, line inspection requirements, manual source verifications, cost
 * to complete, and the Draw Control Record.
 *
 * Every mutation is authorized inside the compliance service (tenant-safe
 * 404, role 403, guarded lifecycle transitions); these handlers only
 * parse input and content-negotiate the response. Browser form posts
 * bounce back to the compliance workspace with ?ok= / ?err=; JSON clients
 * receive plain JSON. Nothing here writes SQLite directly, and nothing
 * here can approve a draw or reach a banking table.
 */
import type * as http from "node:http";
import * as compliance from "../services/dmvCompliance";
import type { User } from "../../shared/types";

export interface ComplianceRouteContext {
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

/** Returns true when the request was handled by a compliance route. */
export async function handleComplianceRoutes(ctx: ComplianceRouteContext): Promise<boolean> {
  const { pathname, method } = ctx;

  const finish = (backTo: string | null, json: unknown, status = 200): void => {
    if (ctx.isForm() && backTo) {
      ctx.redirect(`${backTo}?ok=1`);
    } else {
      ctx.sendJson(json, status);
    }
  };

  // ---------------- project compliance read model ----------------
  const projectApi = /^\/api\/projects\/([^/]+)\/compliance$/.exec(pathname);
  if (projectApi) {
    if (method !== "GET") throw new compliance.ComplianceError("Method not allowed", 405);
    const view = compliance.projectCompliance(ctx.getUser(), projectApi[1]);
    ctx.sendJson(view);
    return true;
  }

  // ---------------- permit basis lifecycle ----------------
  const permitBasisApi = /^\/api\/permits\/([^/]+)\/basis$/.exec(pathname);
  if (permitBasisApi) {
    const user = ctx.getUser();
    if (method === "POST") {
      const body = await ctx.readParams();
      const basis = compliance.createPermitBasis(user, {
        permitId: permitBasisApi[1],
        jurisdiction: body.jurisdiction ?? "",
        permittingAuthority: body.permittingAuthority ?? "",
        propertyAddress: body.propertyAddress || null,
        parcelIdentifier: body.parcelIdentifier || null,
        permitNumber: body.permitNumber ?? "",
        permitType: body.permitType ?? "",
        tradeType: body.tradeType || null,
        workCategory: body.workCategory || null,
        applicationDate: body.applicationDate || null,
        issuanceDate: body.issuanceDate || null,
        expirationDate: body.expirationDate || null,
        permitStatus: body.permitStatus ?? "",
        governingCodeEdition: body.governingCodeEdition || null,
        localAmendments: body.localAmendments || null,
        transitionRuleId: body.transitionRuleId || null,
        governingBasis: body.governingBasis ?? "",
        applicabilityExplanation: body.applicabilityExplanation || null,
        sourceSystem: body.sourceSystem || null,
        sourceUrl: body.sourceUrl || null,
        sourceRecordId: body.sourceRecordId || null,
        lookupAt: body.lookupAt || null,
        verificationMethod: body.verificationMethod ?? "",
        sourceEvidenceId: body.sourceEvidenceId || null,
        notes: body.notes || null,
      });
      finish(`/project/${basis.projectId}/compliance`, { basis }, 201);
      return true;
    }
    throw new compliance.ComplianceError("Method not allowed", 405);
  }

  const basisActionApi = /^\/api\/permit-basis\/([^/]+)\/(finalize|correct)$/.exec(pathname);
  if (basisActionApi) {
    const user = ctx.getUser();
    if (method !== "POST") throw new compliance.ComplianceError("Method not allowed", 405);
    const id = basisActionApi[1];
    if (basisActionApi[2] === "finalize") {
      const basis = compliance.finalizePermitBasis(user, id);
      finish(`/project/${basis.projectId}/compliance`, { basis });
      return true;
    }
    const body = await ctx.readParams();
    const patch: Partial<compliance.PermitBasisInput> = {};
    const patchKeys: Array<keyof compliance.PermitBasisInput> = [
      "jurisdiction", "permittingAuthority", "propertyAddress", "parcelIdentifier", "permitNumber",
      "permitType", "tradeType", "workCategory", "applicationDate", "issuanceDate", "expirationDate",
      "permitStatus", "governingCodeEdition", "localAmendments", "transitionRuleId", "governingBasis",
      "applicabilityExplanation", "sourceSystem", "sourceUrl", "sourceRecordId", "lookupAt",
      "verificationMethod", "sourceEvidenceId", "notes",
    ];
    for (const k of patchKeys) {
      if (body[k] !== undefined && body[k] !== "") (patch as Record<string, unknown>)[k] = body[k];
    }
    const basis = compliance.correctPermitBasis(user, id, patch, body.correctionReason ?? "");
    finish(`/project/${basis.projectId}/compliance`, { basis }, 201);
    return true;
  }

  // ---------------- transition rules ----------------
  const transitionApi = /^\/api\/projects\/([^/]+)\/transition-rules$/.exec(pathname);
  if (transitionApi) {
    const user = ctx.getUser();
    if (method !== "POST") throw new compliance.ComplianceError("Method not allowed", 405);
    const body = await ctx.readParams();
    const rule = compliance.recordTransitionRule(user, {
      projectId: transitionApi[1],
      jurisdiction: body.jurisdiction ?? "",
      priorCodeEdition: body.priorCodeEdition ?? "",
      replacementCodeEdition: body.replacementCodeEdition ?? "",
      transitionPeriodStart: body.transitionPeriodStart || null,
      transitionPeriodEnd: body.transitionPeriodEnd || null,
      applicationDateCutoff: body.applicationDateCutoff || null,
      permitIssuanceCutoff: body.permitIssuanceCutoff || null,
      governingInterpretation: body.governingInterpretation || null,
      officialSourceId: body.officialSourceId || null,
      lookupAt: body.lookupAt || null,
      notes: body.notes || null,
    });
    finish(`/project/${rule.projectId}/compliance`, { rule }, 201);
    return true;
  }

  const determineApi = /^\/api\/transition-rules\/([^/]+)\/determine$/.exec(pathname);
  if (determineApi) {
    const user = ctx.getUser();
    if (method !== "POST") throw new compliance.ComplianceError("Method not allowed", 405);
    const body = await ctx.readParams();
    const rule = compliance.determineTransition(
      user,
      determineApi[1],
      body.eligibility ?? "",
      body.governingInterpretation || null
    );
    finish(`/project/${rule.projectId}/compliance`, { rule });
    return true;
  }

  // ---------------- line inspection requirements ----------------
  const reqApi = /^\/api\/projects\/([^/]+)\/line-requirements$/.exec(pathname);
  if (reqApi) {
    const user = ctx.getUser();
    if (method !== "POST") throw new compliance.ComplianceError("Method not allowed", 405);
    const body = await ctx.readParams();
    const requirement = compliance.createLineRequirement(user, {
      projectId: reqApi[1],
      budgetLineId: body.budgetLineId || null,
      milestoneId: body.milestoneId || null,
      jurisdiction: body.jurisdiction || null,
      inspectionAuthority: body.inspectionAuthority || null,
      inspectionType: body.inspectionType ?? "",
      description: body.description || null,
      permitId: body.permitId || null,
      permitBasisVersionId: body.permitBasisVersionId || null,
      prerequisiteRequirementId: body.prerequisiteRequirementId || null,
      sequence: body.sequence ? Number(body.sequence) : 0,
      requiredBeforeConcealment: body.requiredBeforeConcealment === "1" || body.requiredBeforeConcealment === "true",
      requiredBeforePayment:
        body.requiredBeforePayment === undefined || body.requiredBeforePayment === ""
          ? undefined
          : body.requiredBeforePayment === "1" || body.requiredBeforePayment === "true",
      requiredBeforeFinal: body.requiredBeforeFinal === "1" || body.requiredBeforeFinal === "true",
      notes: body.notes || null,
    });
    finish(`/project/${requirement.projectId}/compliance`, { requirement }, 201);
    return true;
  }

  const reqStatusApi = /^\/api\/line-requirements\/([^/]+)\/status$/.exec(pathname);
  if (reqStatusApi) {
    const user = ctx.getUser();
    if (method !== "POST") throw new compliance.ComplianceError("Method not allowed", 405);
    const body = await ctx.readParams();
    const requirement = compliance.updateLineRequirementStatus(user, reqStatusApi[1], {
      toStatus: body.toStatus ?? "",
      scheduledDate: body.scheduledDate || null,
      completedDate: body.completedDate || null,
      officialResultText: body.officialResultText || null,
      correctionNotice: body.correctionNotice || null,
      reinspectionRequired:
        body.reinspectionRequired === undefined || body.reinspectionRequired === ""
          ? undefined
          : body.reinspectionRequired === "1" || body.reinspectionRequired === "true",
      jurisdictionalInspectionId: body.jurisdictionalInspectionId || null,
      officialSourceId: body.officialSourceId || null,
      lookupAt: body.lookupAt || null,
      externalIdentifier: body.externalIdentifier || null,
      notes: body.notes || null,
    });
    finish(`/project/${requirement.projectId}/compliance`, { requirement });
    return true;
  }

  // ---------------- manual source verifications ----------------
  const verifyApi = /^\/api\/projects\/([^/]+)\/source-verifications$/.exec(pathname);
  if (verifyApi) {
    const user = ctx.getUser();
    if (method !== "POST") throw new compliance.ComplianceError("Method not allowed", 405);
    const body = await ctx.readParams();
    const verification = compliance.recordSourceVerification(user, {
      projectId: verifyApi[1],
      officialService: body.officialService ?? "",
      searchCriteria: body.searchCriteria ?? "",
      sourceRecordIdentifier: body.sourceRecordIdentifier || null,
      lookupAt: body.lookupAt ?? "",
      resultStatus: body.resultStatus ?? "",
      resultSummary: body.resultSummary || null,
      evidenceSourceId: body.evidenceSourceId || null,
      verificationMethod: body.verificationMethod ?? "",
      confidence: body.confidence || null,
      nextReviewDate: body.nextReviewDate || null,
      notes: body.notes || null,
      permitId: body.permitId || null,
      permitBasisVersionId: body.permitBasisVersionId || null,
      lineRequirementId: body.lineRequirementId || null,
    });
    finish(`/project/${verification.projectId}/compliance`, { verification }, 201);
    return true;
  }

  // ---------------- cost to complete ----------------
  const ctcApi = /^\/api\/projects\/([^/]+)\/cost-to-complete$/.exec(pathname);
  if (ctcApi) {
    const user = ctx.getUser();
    if (method !== "POST") throw new compliance.ComplianceError("Method not allowed", 405);
    const body = await ctx.readParams();
    const estimate = compliance.recordCostToComplete(user, {
      projectId: ctcApi[1],
      budgetLineId: body.budgetLineId ?? "",
      drawRequestId: body.drawRequestId || null,
      verifiedCompletedValue: body.verifiedCompletedValue || null,
      remainingCommittedCost: body.remainingCommittedCost || null,
      estimatedCostToComplete: body.estimatedCostToComplete,
      sourceOfEstimate: body.sourceOfEstimate ?? "",
      estimateDate: body.estimateDate ?? "",
      confidence: body.confidence ?? "",
      notes: body.notes || null,
    });
    finish(`/project/${estimate.projectId}/compliance`, { estimate }, 201);
    return true;
  }

  // ---------------- draw control record ----------------
  const controlApi = /^\/api\/draws\/([^/]+)\/control-record$/.exec(pathname);
  if (controlApi) {
    if (method !== "GET") throw new compliance.ComplianceError("Method not allowed", 405);
    const record = compliance.drawControlRecord(ctx.getUser(), controlApi[1]);
    ctx.sendJson(record);
    return true;
  }

  return false;
}
