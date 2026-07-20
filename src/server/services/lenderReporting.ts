/**
 * Lender-layer reporting registers, shared by the Draw Verification
 * Package (draw-scoped) and the Project Audit Package (project-wide,
 * as-of filtered). Honest unavailable states: when a record family has no
 * rows the register still ships with a NOT RECORDED marker row so its
 * absence is explicit, and the loan summary carries state NOT_RECORDED.
 * No secrets, no external calls; report-version document hashes are
 * included so the audit package can verify them.
 */
import * as repo from "../db/repo";
import * as lrepo from "../db/lenderRepo";
// Local CSV helpers (same escaping as auditPackage.csv; duplicated to keep
// this module free of an import cycle with the package builders).
function csvCell(v: unknown): string {
  const sVal = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(sVal) ? `"${sVal.replace(/"/g, '""')}"` : sVal;
}
function csv(header: string[], rows: unknown[][]): string {
  return [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";
}
import { deriveDrawStage } from "./drawWorkflow";
import { appliedPolicyForDraw } from "./loanProfile";

const NOT_RECORDED = "NOT RECORDED";

export interface LenderFile {
  name: string;
  content: string;
  count: number;
}

const orgName = (id: string | null): string => (id ? repo.getOrganization(id)?.name ?? id : "");
const userName = (id: string | null): string => (id ? repo.getUser(id)?.name ?? id : "");

/** asOf filter helper mirroring auditPackage.atOrBefore semantics. */
const atOrBefore = (ts: string | null | undefined, asOf: string | null): boolean =>
  !asOf || (Boolean(ts) && String(ts) <= asOf);

function loanSummaryJson(projectId: string, asOf: string | null): { content: string; count: number } {
  const loan = lrepo.getLoanAssetForProject(projectId);
  if (!loan || !atOrBefore(loan.createdAt, asOf)) {
    return {
      content: JSON.stringify({ kind: "OBV_LOAN_SUMMARY", state: NOT_RECORDED, note: "No loan profile has been recorded for this project." }, null, 2),
      count: 0,
    };
  }
  const project = repo.getProject(projectId);
  return {
    content: JSON.stringify(
      {
        kind: "OBV_LOAN_SUMMARY",
        state: "RECORDED",
        loan: {
          ...loan,
          borrowerOrganization: orgName(loan.borrowerOrganizationId) || null,
          lenderOrganization: orgName(loan.lenderOrganizationId) || null,
          currentServicerOrganization: orgName(loan.currentServicerOrganizationId) || null,
          currentLoanOwnerOrganization: orgName(loan.currentLoanOwnerOrganizationId) || null,
        },
        authoritativeNote:
          "Loan figures are external servicing references. The governed OBV project budget remains authoritative for verification; differences are labelled, never synchronized.",
        obvProjectBudget: project?.totalBudget ?? null,
      },
      null,
      2
    ),
    count: 1,
  };
}

export function buildLenderFiles(
  projectId: string,
  drawRequestId: string | null,
  asOf: string | null
): LenderFile[] {
  const files: LenderFile[] = [];
  const loan = lrepo.getLoanAssetForProject(projectId);

  const summary = loanSummaryJson(projectId, asOf);
  files.push({ name: "loan-summary.json", content: summary.content, count: summary.count });

  const parties = lrepo.listPartyAssignments(projectId).filter((p) => atOrBefore(p.createdAt, asOf));
  files.push({
    name: "project-parties.csv",
    content: csv(
      ["partyType", "organization", "active", "effectiveFrom", "effectiveTo", "reference", "recordedBy", "createdAt"],
      parties.length > 0
        ? parties.map((p) => [
            p.partyType, orgName(p.partyOrganizationId), p.active ? "yes" : "no",
            p.effectiveFrom ?? "", p.effectiveTo ?? "", p.reference ?? "",
            userName(p.createdByUserId), p.createdAt,
          ])
        : [[NOT_RECORDED, "", "", "", "", "", "", ""]]
    ),
    count: parties.length,
  });

  const ownership = loan ? lrepo.listLoanOwnershipEvents(loan.id).filter((e) => atOrBefore(e.createdAt, asOf)) : [];
  files.push({
    name: "ownership-history.csv",
    content: csv(
      ["effectiveAt", "priorOwner", "newOwner", "transferType", "reference", "recordedBy", "createdAt"],
      ownership.length > 0
        ? ownership.map((e) => [
            e.effectiveAt, orgName(e.priorOwnerOrganizationId), orgName(e.newOwnerOrganizationId),
            e.transferType ?? "", e.reference ?? "", userName(e.recordedByUserId), e.createdAt,
          ])
        : [[NOT_RECORDED, "", "", "", "", "", ""]]
    ),
    count: ownership.length,
  });

  const servicing = loan ? lrepo.listLoanServicingEvents(loan.id).filter((e) => atOrBefore(e.createdAt, asOf)) : [];
  files.push({
    name: "servicing-history.csv",
    content: csv(
      ["effectiveAt", "priorServicer", "newServicer", "reference", "recordedBy", "createdAt"],
      servicing.length > 0
        ? servicing.map((e) => [
            e.effectiveAt, orgName(e.priorServicerOrganizationId), orgName(e.newServicerOrganizationId),
            e.reference ?? "", userName(e.recordedByUserId), e.createdAt,
          ])
        : [[NOT_RECORDED, "", "", "", "", ""]]
    ),
    count: servicing.length,
  });

  const inspections = (drawRequestId
    ? lrepo.listDrawInspections(drawRequestId)
    : lrepo.listDrawInspectionsForProject(projectId)
  ).filter((i) => atOrBefore(i.createdAt, asOf));
  files.push({
    name: "independent-inspections.csv",
    content: csv(
      [
        "id", "drawRequestId", "status", "inspectionType", "inspectionCompany", "inspector",
        "requestedAt", "scheduledAt", "completedAt", "reportReceivedAt", "finalizedAt",
        "obvReviewStatus", "lenderAcceptanceStatus", "reinspectionOf",
      ],
      inspections.length > 0
        ? inspections.map((i) => [
            i.id, i.drawRequestId, i.status, i.inspectionType,
            orgName(i.inspectionCompanyOrganizationId),
            i.inspectorDisplayName ?? userName(i.inspectorUserId),
            i.requestedAt ?? "", i.scheduledAt ?? "", i.completedAt ?? "",
            i.reportReceivedAt ?? "", i.finalizedAt ?? "",
            i.obvReviewStatus ?? "", i.lenderAcceptanceStatus ?? "", i.reinspectionOfInspectionId ?? "",
          ])
        : [[NOT_RECORDED, "", "", "", "", "", "", "", "", "", "", "", "", ""]]
    ),
    count: inspections.length,
  });

  const lines = inspections.flatMap((i) => lrepo.listInspectionLines(i.id)).filter((l) => atOrBefore(l.createdAt, asOf));
  files.push({
    name: "inspection-line-findings.csv",
    content: csv(
      [
        "inspectionId", "drawLineItemId", "percentCompleteReported", "materialsPresent",
        "storedOnSite", "storedOffSite", "consistentWithPlans", "visibleDefects",
        "safetyConcerns", "inaccessibleAreas", "note", "createdAt",
      ],
      lines.length > 0
        ? lines.map((l) => [
            l.drawInspectionId, l.drawLineItemId ?? "", l.percentCompleteReported ?? "",
            l.materialsPresent === null ? "" : l.materialsPresent ? "yes" : "no",
            l.materialsStoredOnSite === null ? "" : l.materialsStoredOnSite ? "yes" : "no",
            l.materialsStoredOffSite === null ? "" : l.materialsStoredOffSite ? "yes" : "no",
            l.workConsistentWithPlans === null ? "" : l.workConsistentWithPlans ? "yes" : "no",
            l.visibleDefects ?? "", l.safetyConcerns ?? "", l.inaccessibleAreas ?? "",
            l.inspectorNote ?? "", l.createdAt,
          ])
        : [[NOT_RECORDED, "", "", "", "", "", "", "", "", "", "", ""]]
    ),
    count: lines.length,
  });

  const versions = inspections.flatMap((i) => lrepo.listReportVersions(i.id)).filter((v) => atOrBefore(v.createdAt, asOf));
  files.push({
    name: "inspection-report-versions.csv",
    content: csv(
      [
        "inspectionId", "version", "status", "reportDate", "preparedBy", "finalizedBy",
        "finalizedAt", "priorVersionId", "correctionReason", "documentHash", "createdAt",
      ],
      versions.length > 0
        ? versions.map((v) => [
            v.drawInspectionId, v.version, v.status, v.reportDate ?? "",
            userName(v.preparedByUserId), userName(v.finalizedByUserId),
            v.finalizedAt ?? "", v.priorVersionId ?? "", v.correctionReason ?? "",
            v.documentHash ?? "", v.createdAt,
          ])
        : [[NOT_RECORDED, "", "", "", "", "", "", "", "", "", ""]]
    ),
    count: versions.length,
  });

  const decisions = (drawRequestId
    ? lrepo.listLenderDecisions(drawRequestId)
    : lrepo.listLenderDecisionsForProject(projectId)
  ).filter((d) => atOrBefore(d.createdAt, asOf));
  files.push({
    name: "lender-decisions.csv",
    content: csv(
      [
        "id", "drawRequestId", "decision", "requestedAmount", "approvedAmount", "reducedAmount",
        "rejectedAmount", "holdbackAmount", "retainageAmount", "reviewer", "decisionAt",
        "decisionReason", "approvalRequestId", "supersedes", "supersededBy", "createdAt",
      ],
      decisions.length > 0
        ? decisions.map((d) => [
            d.id, d.drawRequestId, d.decision, d.requestedAmount, d.approvedAmount ?? "",
            d.reducedAmount ?? "", d.rejectedAmount ?? "", d.holdbackAmount ?? "",
            d.retainageAmount ?? "", userName(d.reviewerUserId), d.decisionAt ?? "",
            d.decisionReason ?? "", d.approvalRequestId ?? "", d.supersedesDecisionId ?? "",
            d.supersededByDecisionId ?? "", d.createdAt,
          ])
        : [[NOT_RECORDED, "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]]
    ),
    count: decisions.length,
  });

  const conditions = decisions.flatMap((d) => lrepo.listDecisionConditions(d.id)).filter((c) => atOrBefore(c.createdAt, asOf));
  files.push({
    name: "decision-conditions.csv",
    content: csv(
      ["decisionId", "conditionType", "description", "status", "dueAt", "responsibleParty", "satisfiedBy", "satisfiedAt", "waiverReason", "createdAt"],
      conditions.length > 0
        ? conditions.map((c) => [
            c.lenderDecisionId, c.conditionType, c.description, c.status, c.dueAt ?? "",
            orgName(c.responsiblePartyOrganizationId), userName(c.satisfiedByUserId),
            c.satisfiedAt ?? "", c.waiverReason ?? "", c.createdAt,
          ])
        : [[NOT_RECORDED, "", "", "", "", "", "", "", "", ""]]
    ),
    count: conditions.length,
  });

  const waivers = (drawRequestId
    ? lrepo.listLienWaivers(drawRequestId)
    : lrepo.listLienWaiversForProject(projectId)
  ).filter((w) => atOrBefore(w.createdAt, asOf));
  files.push({
    name: "lien-waivers.csv",
    content: csv(
      [
        "id", "drawRequestId", "status", "waiverType", "waiverScope", "signingParty",
        "relatedAmount", "coveredThrough", "receivedAt", "acceptedAt", "rejectedAt",
        "rejectionReason", "reviewedBy", "documentHash", "createdAt",
      ],
      waivers.length > 0
        ? waivers.map((w) => [
            w.id, w.drawRequestId, w.status, w.waiverType ?? "", w.waiverScope ?? "",
            w.signingParty ?? "", w.relatedAmount ?? "", w.coveredThrough ?? "",
            w.receivedAt ?? "", w.acceptedAt ?? "", w.rejectedAt ?? "",
            w.rejectionReason ?? "", userName(w.reviewedByUserId), w.documentHash ?? "", w.createdAt,
          ])
        : [[NOT_RECORDED, "", "", "", "", "", "", "", "", "", "", "", "", "", ""]]
    ),
    count: waivers.length,
  });

  const funding = (drawRequestId
    ? lrepo.listFundingRecords(drawRequestId)
    : lrepo.listFundingRecordsForProject(projectId)
  ).filter((f) => atOrBefore(f.createdAt, asOf));
  files.push({
    name: "external-funding.csv",
    content: csv(
      [
        "id", "drawRequestId", "status", "fundingMethod", "scheduledAt", "fundedAt",
        "amountScheduled", "amountDisbursed", "wireFee", "transactionReference",
        "failureReason", "reversalReference", "reversedAt", "closedAt", "recordedBy", "createdAt",
      ],
      funding.length > 0
        ? funding.map((f) => [
            f.id, f.drawRequestId, f.status, f.fundingMethod ?? "", f.scheduledAt ?? "",
            f.fundedAt ?? "", f.amountScheduled ?? "", f.amountDisbursed ?? "", f.wireFee ?? "",
            f.transactionReference ?? "", f.failureReason ?? "", f.reversalReference ?? "",
            f.reversedAt ?? "", f.closedAt ?? "", userName(f.recordedByUserId), f.createdAt,
          ])
        : [[NOT_RECORDED, "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]]
    ),
    count: funding.length,
  });

  const draws = drawRequestId
    ? [drawRequestId]
    : repo.listDrawRequestsForProject(projectId).map((d) => d.id);
  const stageRows = draws.flatMap((id) =>
    lrepo.listStageEvents(id).filter((e) => atOrBefore(e.createdAt, asOf))
  );
  files.push({
    name: "draw-stage-history.csv",
    content: csv(
      ["drawRequestId", "priorStage", "newStage", "actor", "reason", "sourceRecordId", "createdAt"],
      stageRows.length > 0
        ? stageRows.map((e) => [
            e.drawRequestId, e.priorStage ?? "", e.newStage, userName(e.actorUserId),
            e.reason ?? "", e.sourceRecordId ?? "", e.createdAt,
          ])
        : [[NOT_RECORDED, "", "", "", "", "", ""]]
    ),
    count: stageRows.length,
  });

  return files;
}

/** Draw-scoped register set for the Draw Verification Package, including
 *  the current derived stage and applicable policy version. */
export function buildLenderDrawFiles(projectId: string, drawRequestId: string): LenderFile[] {
  const files = buildLenderFiles(projectId, drawRequestId, null);
  // The APPLIED policy is the version frozen at the draw's first
  // submission — never the currently active policy, which may have
  // changed since. Legacy draws with no frozen record report NOT
  // RECORDED; the package never silently substitutes the current policy.
  const { application } = appliedPolicyForDraw(drawRequestId);
  files.push({
    name: "lender-policy-applied.json",
    content: JSON.stringify(
      application
        ? {
            state: "RECORDED",
            policyId: application.policyId,
            version: application.policyVersion,
            appliedAt: application.appliedAt,
            scope: application.source === "PROJECT_OVERRIDE" ? "project" : "organization",
            frozenAt: "first draw submission",
          }
        : { state: NOT_RECORDED, note: "No policy application was recorded when this draw was submitted." },
      null,
      2
    ),
    count: application ? 1 : 0,
  });
  files.push({
    name: "draw-workflow-stage.json",
    content: JSON.stringify(
      { derivedStage: deriveDrawStage(drawRequestId) ?? NOT_RECORDED, derivedFrom: "authoritative draw, inspection, decision, lien and funding records" },
      null,
      2
    ),
    count: 1,
  });
  return files;
}
