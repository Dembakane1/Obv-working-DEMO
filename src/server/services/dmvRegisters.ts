/**
 * DMV compliance registers for the Draw Verification Package and the
 * Project Audit Package.
 *
 * Honesty rules (same doctrine as the banking/dispute registers):
 *   - explicit as-of filtering: only records created at or before the
 *     package's generatedAt instant are included, and the basis status
 *     column is derived AT that instant (a later correction never
 *     rewrites what a historical package shows);
 *   - manual government-record verifications are labeled as documented
 *     MANUAL lookups — never presented as a live integration;
 *   - eligibility means eligibility for LENDER REVIEW; the registers
 *     never state approval, authorization, or release;
 *   - projects with no DMV records get an explicit "Not recorded"
 *     summary — values are never fabricated.
 */
import * as repo from "../db/repo";
import * as dmv from "../db/dmvRepo";
import {
  DMV_SCOPE_NOTE,
  ELIGIBLE_WORDING,
  NOT_LEGAL_ADVICE_NOTE,
  type DrawControlRecord,
} from "./dmvCompliance";
import { csv, type PackageFile } from "./auditPackage";
import type { PermitBasisVersion, User } from "../../shared/types";

const NOT_RECORDED = "Not recorded";

/** Basis status AT the as-of instant — how a historical package must
 *  describe a version regardless of what happened to it later. */
function basisStatusAt(b: PermitBasisVersion, asOf: string): string {
  if (b.supersededAt && b.supersededAt <= asOf) return "SUPERSEDED";
  if (b.effectiveFrom && b.effectiveFrom <= asOf) return "AUTHORITATIVE";
  return "DRAFT";
}

export function dmvRegisterFiles(input: {
  projectId: string;
  /** Restrict draw-scoped registers to one draw (draw package); null
   *  includes the whole project (audit package). */
  drawRequestId: string | null;
  asOf: string;
  /** ZIP directory prefix, e.g. "" or "13_dmv_compliance/". */
  prefix: string;
  users: Map<string, User>;
  /** The generated Draw Control Record for a draw package; null for the
   *  audit package (control records are per-draw artifacts and are never
   *  regenerated from newer settings at audit time). */
  controlRecord: DrawControlRecord | null;
}): { files: PackageFile[]; counts: Record<string, number> } {
  const { projectId, drawRequestId, asOf, prefix, controlRecord } = input;
  const inWindow = (iso: string | null): boolean => Boolean(iso && iso <= asOf);
  const userName = (id: string | null): string => (id ? input.users.get(id)?.name ?? id : NOT_RECORDED);

  const files: PackageFile[] = [];
  const counts: Record<string, number> = {};
  const add = (name: string, content: string, count: number): void => {
    files.push({ name: `${prefix}${name}`, data: Buffer.from(content, "utf8") });
    counts[`${prefix}${name}`] = count;
  };

  const bases = dmv.listPermitBasisForProject(projectId).filter((b) => inWindow(b.createdAt));
  const rules = dmv.listTransitionRulesForProject(projectId).filter((r) => inWindow(r.createdAt));
  const reqs = dmv.listLineRequirementsForProject(projectId).filter((r) => inWindow(r.createdAt));
  const verifications = dmv.listSourceVerificationsForProject(projectId).filter((v) => inWindow(v.createdAt));
  const estimates = dmv.listEstimatesForProject(projectId).filter((e) => inWindow(e.createdAt));

  // ---- dmv-summary.json (always present; honest when empty)
  const empty = bases.length === 0 && reqs.length === 0;
  add(
    "dmv-summary.json",
    JSON.stringify(
      {
        state: empty ? NOT_RECORDED + " — this project does not use the DMV compliance layer." : "RECORDED",
        asOf,
        scopeNote: DMV_SCOPE_NOTE,
        legalNote: NOT_LEGAL_ADVICE_NOTE,
        eligibilityMeaning: ELIGIBLE_WORDING,
        verificationBasis:
          "Government-record verifications in these registers are documented MANUAL lookups by " +
          "authorized reviewers. OBV has no live integration with any government system.",
        historicalBasis:
          "Basis versions are shown with their status AT the as-of instant. A correction after this " +
          "instant creates a new version and never rewrites what this package records.",
        counts: {
          permitBasisVersions: bases.length,
          transitionRules: rules.length,
          lineInspectionRequirements: reqs.length,
          sourceVerifications: verifications.length,
          costToCompleteEstimates: estimates.length,
        },
      },
      null,
      2
    ),
    1
  );
  if (empty) return { files, counts };

  // ---- permit-basis-register.csv (every version, full field set)
  add(
    "permit-basis-register.csv",
    csv(
      [
        "permitNumber", "version", "statusAtAsOf", "storedStatus", "governingBasis", "jurisdiction",
        "permittingAuthority", "propertyAddress", "parcelIdentifier", "permitType", "tradeType",
        "workCategory", "applicationDate", "issuanceDate", "expirationDate", "permitStatus",
        "governingCodeEdition", "localAmendments", "transitionRuleId", "applicabilityExplanation",
        "sourceSystem", "sourceUrl", "sourceRecordId", "lookupAt", "lookupBy", "verificationMethod",
        "sourceEvidenceId", "recordHash", "effectiveFrom", "supersededAt", "finalizedBy",
        "createdBy", "createdAt", "basisVersionId", "permitId",
      ],
      bases.map((b) => [
        b.permitNumber, b.version, basisStatusAt(b, asOf), b.status, b.governingBasis, b.jurisdiction,
        b.permittingAuthority, b.propertyAddress ?? "", b.parcelIdentifier ?? "", b.permitType,
        b.tradeType ?? "", b.workCategory ?? "", b.applicationDate ?? "", b.issuanceDate ?? "",
        b.expirationDate ?? "", b.permitStatus, b.governingCodeEdition ?? "", b.localAmendments ?? "",
        b.transitionRuleId ?? "", b.applicabilityExplanation ?? "", b.sourceSystem ?? "",
        b.sourceUrl ?? "", b.sourceRecordId ?? "", b.lookupAt ?? "", userName(b.lookupByUserId),
        b.verificationMethod, b.sourceEvidenceId ?? "", b.recordHash, b.effectiveFrom ?? "",
        b.supersededAt && b.supersededAt <= asOf ? b.supersededAt : "", userName(b.finalizedByUserId),
        userName(b.createdByUserId), b.createdAt, b.id, b.permitId,
      ])
    ),
    bases.length
  );

  // ---- permit-basis-version-history.csv (correction chain)
  const corrections = bases.filter((b) => b.supersedesVersionId !== null);
  add(
    "permit-basis-version-history.csv",
    csv(
      [
        "permitNumber", "version", "supersedesVersionId", "correctionReason", "correctedBy",
        "effectiveFrom", "supersededAt", "recordHash", "basisVersionId",
      ],
      corrections.map((b) => [
        b.permitNumber, b.version, b.supersedesVersionId ?? "", b.correctionReason ?? "",
        userName(b.correctedByUserId), b.effectiveFrom ?? "",
        b.supersededAt && b.supersededAt <= asOf ? b.supersededAt : "", b.recordHash, b.id,
      ])
    ),
    corrections.length
  );

  // ---- transition-rules.csv
  add(
    "transition-rules.csv",
    csv(
      [
        "jurisdiction", "priorCodeEdition", "replacementCodeEdition", "transitionPeriodStart",
        "transitionPeriodEnd", "applicationDateCutoff", "permitIssuanceCutoff", "eligibility",
        "governingInterpretation", "officialSourceId", "lookupAt", "reviewer", "determinedAt",
        "notes", "ruleId",
      ],
      rules.map((r) => [
        r.jurisdiction, r.priorCodeEdition, r.replacementCodeEdition, r.transitionPeriodStart ?? "",
        r.transitionPeriodEnd ?? "", r.applicationDateCutoff ?? "", r.permitIssuanceCutoff ?? "",
        r.determinedAt && r.determinedAt <= asOf ? r.eligibility : "PENDING_DETERMINATION",
        r.governingInterpretation ?? "", r.officialSourceId ?? "", r.lookupAt ?? "",
        userName(r.reviewerUserId), r.determinedAt && r.determinedAt <= asOf ? r.determinedAt : "",
        r.notes ?? "", r.id,
      ])
    ),
    rules.length
  );

  // ---- required-inspections.csv (requirement status is generation-time
  //      record state; the created-at filter keeps later requirements out)
  const budgetLines = new Map(repo.listBudgetLines(projectId).map((b) => [b.id, b]));
  const milestoneName = (id: string | null): string =>
    id ? repo.getMilestone(id)?.title ?? id : "";
  add(
    "required-inspections.csv",
    csv(
      [
        "budgetLineCode", "milestone", "inspectionType", "inspectionAuthority", "jurisdiction",
        "sequence", "requiredBeforeConcealment", "requiredBeforePayment", "requiredBeforeFinal",
        "prerequisiteRequirementId", "permitId", "permitBasisVersionId", "status", "scheduledDate",
        "completedDate", "reviewer", "notes", "createdAt", "requirementId",
      ],
      reqs.map((r) => [
        r.budgetLineId ? budgetLines.get(r.budgetLineId)?.code ?? r.budgetLineId : "",
        milestoneName(r.milestoneId), r.inspectionType, r.inspectionAuthority ?? "",
        r.jurisdiction ?? "", r.sequence, r.requiredBeforeConcealment ? "YES" : "NO",
        r.requiredBeforePayment ? "YES" : "NO", r.requiredBeforeFinal ? "YES" : "NO",
        r.prerequisiteRequirementId ?? "", r.permitId ?? "", r.permitBasisVersionId ?? "",
        r.status, r.scheduledDate ?? "", r.completedDate ?? "", userName(r.reviewerUserId),
        r.notes ?? "", r.createdAt, r.id,
      ])
    ),
    reqs.length
  );

  // ---- official-inspection-status.csv (the official-record slice: the
  //      jurisdiction's verbatim result and its provenance — kept separate
  //      from any OBV field finding)
  const officialRows = reqs.filter(
    (r) => r.officialResultText || r.officialSourceId || r.jurisdictionalInspectionId || r.lookupAt
  );
  add(
    "official-inspection-status.csv",
    csv(
      [
        "inspectionType", "status", "officialResultText", "correctionNotice", "reinspectionRequired",
        "officialSystemName", "officialRecordNumber", "officialStatusTextVerbatim",
        "jurisdictionalInspectionId", "lookupAt", "externalIdentifier", "recordedBy", "requirementId",
      ],
      officialRows.map((r) => {
        const src = r.officialSourceId ? repo.getOfficialSource(r.officialSourceId) : null;
        return [
          r.inspectionType, r.status, r.officialResultText ?? "", r.correctionNotice ?? "",
          r.reinspectionRequired ? "YES" : "NO", src?.officialSystemName ?? "",
          src?.officialRecordNumber ?? "", src?.officialStatusText ?? "",
          r.jurisdictionalInspectionId ?? "", r.lookupAt ?? "", r.externalIdentifier ?? "",
          userName(r.reviewerUserId), r.id,
        ];
      })
    ),
    officialRows.length
  );

  // ---- source-verifications.csv (manual lookup runs, append-only)
  add(
    "source-verifications.csv",
    csv(
      [
        "officialService", "searchCriteria", "sourceRecordIdentifier", "lookupAt", "performedBy",
        "resultStatus", "resultSummary", "verificationMethod", "confidence", "nextReviewDate",
        "evidenceSourceId", "permitId", "permitBasisVersionId", "lineRequirementId", "notes",
        "verificationId",
      ],
      verifications.map((v) => [
        v.officialService, v.searchCriteria, v.sourceRecordIdentifier ?? "", v.lookupAt,
        userName(v.performedByUserId), v.resultStatus, v.resultSummary ?? "", v.verificationMethod,
        v.confidence ?? "", v.nextReviewDate ?? "", v.evidenceSourceId ?? "", v.permitId ?? "",
        v.permitBasisVersionId ?? "", v.lineRequirementId ?? "", v.notes ?? "", v.id,
      ])
    ),
    verifications.length
  );

  // ---- cost-to-complete.csv (append-only estimate history; the latest
  //      row per line AT the as-of instant is flagged)
  const latestAtAsOf = new Map<string, string>();
  for (const e of estimates) latestAtAsOf.set(e.budgetLineId, e.id); // ordered by createdAt
  add(
    "cost-to-complete.csv",
    csv(
      [
        "budgetLineCode", "estimatedCostToComplete", "verifiedCompletedValue",
        "remainingCommittedCost", "sourceOfEstimate", "confidence", "estimateDate", "estimator",
        "drawRequestId", "latestForLineAtAsOf", "notes", "estimateId",
      ],
      estimates.map((e) => [
        budgetLines.get(e.budgetLineId)?.code ?? e.budgetLineId, e.estimatedCostToComplete,
        e.verifiedCompletedValue ?? "", e.remainingCommittedCost ?? "", e.sourceOfEstimate,
        e.confidence, e.estimateDate, userName(e.estimatorUserId), e.drawRequestId ?? "",
        latestAtAsOf.get(e.budgetLineId) === e.id ? "YES" : "NO", e.notes ?? "", e.id,
      ])
    ),
    estimates.length
  );

  // ---- draw-permit-basis-pins.csv (which basis version governed which
  //      draw — the historical binding that later corrections never move)
  const draws = drawRequestId
    ? [repo.getDrawRequest(drawRequestId)].filter((d): d is NonNullable<typeof d> => d !== null)
    : repo.listDrawRequestsForProject(projectId);
  const pinRows: unknown[][] = [];
  for (const d of draws) {
    for (const pin of dmv.listPinsForDraw(d.id)) {
      if (!inWindow(pin.pinnedAt)) continue;
      const basis = dmv.getPermitBasis(pin.permitBasisVersionId);
      pinRows.push([
        d.drawNumber, basis?.permitNumber ?? pin.permitId, basis?.version ?? "",
        basis?.governingBasis ?? "", pin.pinnedAt, userName(pin.pinnedByUserId),
        pin.permitBasisVersionId, d.id,
      ]);
    }
  }
  add(
    "draw-permit-basis-pins.csv",
    csv(
      ["drawNumber", "permitNumber", "basisVersion", "governingBasis", "pinnedAt", "pinnedBy", "basisVersionId", "drawRequestId"],
      pinRows
    ),
    pinRows.length
  );

  // ---- draw-control-record.csv + eligibility reasons (draw packages
  //      only — the control record is a per-draw artifact)
  if (controlRecord) {
    add(
      "draw-control-record.csv",
      csv(
        [
          "budgetLineCode", "scopeDescription", "jurisdiction", "governingBasisVersions",
          "borrowerRequestedAmount", "contractorPercentComplete", "contractorCompletedAmount",
          "photoEvidenceCount", "verifiedPhotoEvidenceCount", "invoiceDocumentCount",
          "lienWaiverStatus", "drawInspectorFinding", "inspectorObservedPercent",
          "inspectorSupportedAmount", "requiredInspections", "officialInspectionStatuses",
          "priorFunded", "currentRequested", "cumulativeRequested", "remainingBudget",
          "estimatedCostToComplete", "projectedVariance", "retainageAmount", "openExceptions",
          "reviewerNotes", "finalEligibilityStatus", "eligibilityReasonCodes", "drawLineItemId",
        ],
        controlRecord.lines.map((l) => [
          l.budgetLineCode ?? l.budgetLineRef ?? "", l.scopeDescription, l.jurisdiction ?? "",
          l.governingBases.map((b) => `${b.permitNumber} v${b.version} (${b.governingBasis})`).join("; "),
          l.borrowerRequestedAmount, l.contractorPercentComplete ?? "", l.contractorCompletedAmount ?? "",
          l.photoEvidenceCount, l.verifiedPhotoEvidenceCount, l.invoiceDocumentCount,
          l.lienWaiverStatus, l.drawInspectorFinding, l.inspectorObservedPercent ?? "",
          l.inspectorSupportedAmount ?? "",
          l.requiredInspections.map((r) => r.inspectionType).join("; "),
          l.requiredInspections.map((r) => `${r.inspectionType}: ${r.status}`).join("; "),
          l.priorFunded, l.currentRequested, l.cumulativeRequested, l.remainingBudget ?? "",
          l.estimatedCostToComplete ?? "", l.projectedVariance ?? "", l.retainageAmount ?? "",
          l.openExceptions.map((x) => `${x.severity}: ${x.title}`).join("; "),
          l.reviewerNotes ?? "", l.finalEligibilityStatus,
          l.eligibilityReasons.map((r) => r.code).join("; "), l.drawLineItemId,
        ])
      ),
      controlRecord.lines.length
    );

    const reasonRows = controlRecord.lines.flatMap((l) =>
      l.eligibilityReasons.map((r) => [
        l.budgetLineCode ?? l.budgetLineRef ?? "", l.finalEligibilityStatus, r.code, r.status,
        r.message, l.drawLineItemId,
      ])
    );
    add(
      "eligibility-reasons.csv",
      csv(
        ["budgetLineCode", "finalEligibilityStatus", "reasonCode", "reasonStatus", "message", "drawLineItemId"],
        reasonRows
      ),
      reasonRows.length
    );
  }

  return { files, counts };
}
