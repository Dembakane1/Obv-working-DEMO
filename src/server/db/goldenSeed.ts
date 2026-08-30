/**
 * Lender Pilot RC1 — the "golden" demonstration project.
 *
 * One extremely realistic FICTIONAL DMV rehab loan that exercises the
 * entire lender workflow without constructing state live in a
 * presentation: six draws spanning every stage a lender will meet —
 * fully funded history, a draw awaiting its second approval with a
 * partially supported line, a draw returned for information, a missing
 * lien waiver, an open compliance exception, and a required inspection
 * awaiting its recorded result.
 *
 * EVERY record is clearly fictional demo data. The seed writes through
 * the same repositories the governed services use, mirrors the existing
 * demo-seed conventions, and is OPT-IN: it runs only when
 * OBV_SEED_GOLDEN=1, so every existing test suite keeps its exact
 * baseline state.
 */
import * as repo from "./repo";
import * as lenderRepo from "./lenderRepo";
import type { Milestone } from "../../shared/types";

export const GOLDEN_PROJECT_ID = "proj-golden";

export function seedGoldenProject(): void {
  if (repo.getProject(GOLDEN_PROJECT_ID)) return; // idempotent

  const now = "2026-08-01T12:00:00.000Z";

  repo.insertProject({
    id: GOLDEN_PROJECT_ID,
    organizationId: "org-cdfc",
    name: "DEMO — 214 Halcyon St NW Rowhouse Rehabilitation (Washington, DC)",
    description:
      "Fictional golden-pilot demonstration: $860,000 acquisition/rehab loan on an invented " +
      "three-story rowhouse at 214 Halcyon St NW. Six construction draws across demolition, " +
      "structure, envelope, MEP rough-in, finishes and closeout under fictional DC permits. " +
      "All names, addresses, parcels, permit numbers and amounts are fictional demo data.",
    location: "Washington, DC (fictional demo address)",
    siteBoundary: [
      [-77.0321, 38.9172],
      [-77.0308, 38.9172],
      [-77.0308, 38.9181],
      [-77.0321, 38.9181],
      [-77.0321, 38.9172],
    ],
    totalBudget: 860_000,
    status: "ACTIVE",
    projectType: "INFRASTRUCTURE",
  });

  const milestones: Milestone[] = [
    { id: "ms-g1", projectId: GOLDEN_PROJECT_ID, seq: 1, title: "Demolition & site prep",
      requirement: "Photos showing completed interior demolition and debris removal.",
      trancheAmount: 95_000, weight: 11, status: "RELEASED", accountStatus: "RELEASED" },
    { id: "ms-g2", projectId: GOLDEN_PROJECT_ID, seq: 2, title: "Structural framing & repairs",
      requirement: "Photos showing new framing, sistered joists and structural steel before close-in.",
      trancheAmount: 160_000, weight: 19, status: "APPROVED", accountStatus: "HELD" },
    { id: "ms-g3", projectId: GOLDEN_PROJECT_ID, seq: 3, title: "Roof & building envelope",
      requirement: "Photos showing completed roof membrane, flashing and window installation.",
      trancheAmount: 140_000, weight: 16, status: "UNDER_REVIEW", accountStatus: "HELD" },
    { id: "ms-g4", projectId: GOLDEN_PROJECT_ID, seq: 4, title: "MEP rough-in",
      requirement: "Photos showing electrical panel, branch wiring and supply/waste piping before concealment.",
      trancheAmount: 185_000, weight: 22, status: "UNDER_REVIEW", accountStatus: "HELD" },
    { id: "ms-g5", projectId: GOLDEN_PROJECT_ID, seq: 5, title: "Interior finishes",
      requirement: "Photos showing drywall, trim, flooring and kitchen/bath installation.",
      trancheAmount: 190_000, weight: 22, status: "PENDING_EVIDENCE", accountStatus: "HELD" },
    { id: "ms-g6", projectId: GOLDEN_PROJECT_ID, seq: 6, title: "Final completion & punchlist",
      requirement: "Photos showing completed interiors and exterior, punchlist items closed.",
      trancheAmount: 90_000, weight: 10, status: "NOT_STARTED", accountStatus: "HELD" },
  ];
  for (const m of milestones) repo.insertMilestone(m);

  // ---- fictional DC permits ----
  const permitBase = {
    organizationId: "org-cdfc", projectId: GOLDEN_PROJECT_ID,
    issuingAuthority: "DC Department of Buildings", jurisdiction: "District of Columbia",
    effectiveAt: null, closedAt: null,
    applicableCodeEdition: null, codeEffectiveDate: null, codeBasis: null,
    codeDeterminedBy: null, codeDeterminedAt: null,
    officialRecordUrl: null, officialRecordNumber: null, notes: null,
    legacyReference: null, configurationVersion: 1,
    createdByUserId: "user-compliance", createdAt: now, updatedAt: now,
  };
  repo.insertPermit({
    ...permitBase, id: "permit-g-bldg", permitNumber: "DEMO-B2026-11402",
    permitType: "BUILDING", status: "ISSUED",
    issuedAt: "2026-02-18", expiresAt: "2027-02-18",
    scopeDescription: "Interior alteration and structural repair, three-story rowhouse (fictional demo permit).",
  });
  repo.insertPermit({
    ...permitBase, id: "permit-g-elec", permitNumber: "DEMO-E2026-22815",
    permitType: "ELECTRICAL", status: "ISSUED",
    issuedAt: "2026-03-11", expiresAt: "2026-09-11",
    scopeDescription: "Heavy-up service upgrade and full rewiring (fictional demo permit; expiry within the pilot window).",
  });

  // ---- inspections: a corrected historical one, and one awaiting result ----
  const inspBase = {
    organizationId: "org-cdfc", projectId: GOLDEN_PROJECT_ID,
    permitId: null, jurisdiction: "District of Columbia",
    issuingAuthority: "DC Department of Buildings",
    scheduledAt: null, completedAt: null,
    governmentInspectorName: null, supportingDocumentId: null,
    reinspectionOfInspectionId: null, supersededByInspectionId: null,
    correctionNoticeReference: null, correctionSummary: null,
    correctionDueAt: null, correctionClearedAt: null,
    notes: null, createdAt: now, updatedAt: now,
  };
  // Framing inspection: first attempt required corrections; the original
  // result is preserved and the reinspection PASSED.
  repo.insertInspection({
    ...inspBase, id: "insp-g-frame-1", milestoneId: "ms-g2",
    permitRefId: "permit-g-bldg", inspectionType: "FRAMING",
    inspectionReference: "DEMO-INS-2026-3301", required: true,
    status: "CORRECTIONS_REQUIRED", scheduledAt: "2026-04-02",
    completedAt: "2026-04-02", resultRecordedAt: "2026-04-03T15:00:00.000Z",
    result: "CORRECTIONS_REQUIRED",
    governmentInspectorName: "Fictional DC inspector (external)",
    reviewedByUserId: "user-compliance",
    correctionNoticeReference: "DEMO-CN-1188",
    correctionSummary: "Joist hanger spacing at rear addition did not meet the approved drawings (fictional).",
    correctionDueAt: "2026-04-20",
    correctionClearedAt: "2026-04-16T00:00:00.000Z",
  });
  repo.insertInspection({
    ...inspBase, id: "insp-g-frame-2", milestoneId: "ms-g2",
    permitRefId: "permit-g-bldg", inspectionType: "FRAMING",
    inspectionReference: "DEMO-INS-2026-3388", required: true,
    status: "PASSED", scheduledAt: "2026-04-16", completedAt: "2026-04-16",
    resultRecordedAt: "2026-04-17T10:00:00.000Z", result: "PASSED",
    governmentInspectorName: "Fictional DC inspector (external)",
    reviewedByUserId: "user-compliance",
    reinspectionOfInspectionId: "insp-g-frame-1",
  });
  // Electrical rough-in on ms-g4: REQUIRED, no recorded result yet —
  // this is what holds draw #6's milestone.
  repo.insertInspection({
    ...inspBase, id: "insp-g-elec-rough", milestoneId: "ms-g4",
    permitRefId: "permit-g-elec", inspectionType: "ELECTRICAL_ROUGH_IN",
    inspectionReference: "DEMO-INS-2026-4712", required: true,
    status: "SCHEDULED", scheduledAt: "2026-08-12",
    resultRecordedAt: null, result: null, reviewedByUserId: null,
  });

  // ---- inspection-requirement determinations (reviewed, attributable) ----
  // The readiness engine treats an UNDETERMINED requirement as missing
  // information (INCOMPLETE) — the same doctrine the payment boundary
  // applies. The demo therefore records the reviewed determinations its
  // story already implies: framing REQUIRED (chain passed), electrical
  // rough-in REQUIRED (result outstanding; review sequencing carried by
  // the exception workflow in this demo), the rest NOT_REQUIRED. All
  // fictional demo determinations.
  const reqBase = {
    projectId: GOLDEN_PROJECT_ID,
    determinedBy: "user-compliance",
    determinedAt: "2026-03-10T10:00:00.000Z",
    jurisdiction: "District of Columbia",
    issuingAuthority: "DC Department of Buildings",
    mustPassBeforeDrawReview: false,
    mustPassBeforeGovernance: false,
    finalCompletionOnly: false,
    resultDocumentRequired: false,
    permitRequired: false,
    requiredPermitType: null,
    officialSourceRequired: false,
    codeBasisRequired: false,
    permitMustBeActiveBeforeDrawReview: false,
    permitMustBeActiveBeforeGovernance: false,
    configurationVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  repo.upsertInspectionRequirement({
    ...reqBase, id: "insreq-g1", milestoneId: "ms-g1",
    requirement: "NOT_REQUIRED", inspectionType: null,
    requirementBasis: "Interior demolition below the jurisdictional inspection threshold — reviewed determination (fictional demo).",
  });
  repo.upsertInspectionRequirement({
    ...reqBase, id: "insreq-g2", milestoneId: "ms-g2",
    requirement: "REQUIRED", inspectionType: "FRAMING",
    mustPassBeforeGovernance: true,
    requirementBasis: "Structural framing requires a DC framing inspection — reviewed determination (fictional demo). The recorded chain passed on reinspection.",
  });
  repo.upsertInspectionRequirement({
    ...reqBase, id: "insreq-g3", milestoneId: "ms-g3",
    requirement: "NOT_REQUIRED", inspectionType: null,
    requirementBasis: "Roof membrane work within the existing building-permit scope — reviewed determination (fictional demo).",
  });
  repo.upsertInspectionRequirement({
    ...reqBase, id: "insreq-g4", milestoneId: "ms-g4",
    requirement: "REQUIRED", inspectionType: "ELECTRICAL_ROUGH_IN",
    requirementBasis: "MEP rough-in requires DC electrical inspection — reviewed determination (fictional demo). Result outstanding; the review hold is carried by the open exception.",
  });
  repo.upsertInspectionRequirement({
    ...reqBase, id: "insreq-g5", milestoneId: "ms-g5",
    requirement: "NOT_REQUIRED", inspectionType: null,
    requirementBasis: "Interior finishes carry no jurisdictional inspection — reviewed determination (fictional demo).",
  });

  // ---- one approved change order (referenced by draw #2's story) ----
  repo.insertChangeOrder({
    id: "co-g1", organizationId: "org-cdfc", projectId: GOLDEN_PROJECT_ID,
    changeOrderNumber: 1, title: "Structural steel upgrade at rear addition (fictional)",
    description: "Engineer-directed beam upsizing discovered during demolition. Fictional demo change order.",
    reasonCategory: "DESIGN_CHANGE" as never, requestedByUserId: "user-dmv-pm",
    requestedAt: "2026-03-20T10:00:00.000Z",
    requestedAmount: 22_000, approvedAmount: 22_000, currency: "USD",
    scheduleImpactDays: 10, status: "APPROVED" as never,
    affectedMilestoneIds: ["ms-g2"], affectedBudgetLineIds: [],
    appliedAt: null, appliedSnapshotVersion: null,
    createdAt: "2026-03-20T10:00:00.000Z", updatedAt: "2026-03-28T10:00:00.000Z",
    supportingDocumentCount: 0,
  });

  // ---- draws ----
  const drawBase = {
    organizationId: "org-cdfc",
    projectId: GOLDEN_PROJECT_ID,
    requestedByUserId: "user-dmv-pm",
    requestedByOrganizationId: "org-dmv-borrower",
    currency: "USD",
    retainageRate: 0.1,
    retainageWithheld: null,
    reviewRecommendation: null,
    reviewSummary: null,
    approvedAmount: null,
    recommendedAmount: null,
  };
  const mkReq = (drawId: string, n: number, rows: Array<[string, string, boolean]>) =>
    rows.forEach(([docType, title, required], i) =>
      repo.insertDrawRequirement({
        id: `dreq-${drawId}-${i}`, drawRequestId: drawId, sort: i,
        docType: docType as never, title, required, notes: null,
      })
    );
  const mkDoc = (drawId: string, i: number, docType: string, title: string, status: string, receivedAt: string, reviewed: boolean) =>
    repo.insertDrawDocument({
      id: `ddoc-${drawId}-${i}`, drawRequestId: drawId,
      requirementId: `dreq-${drawId}-${i}`, lineItemId: null,
      docType: docType as never, title, filePath: null, note: null,
      status: status as never, expiresAt: null,
      uploadedByUserId: "user-dmv-pm", receivedAt,
      reviewedByUserId: reviewed ? "user-compliance" : null,
      reviewedAt: reviewed ? receivedAt : null,
      reviewNote: reviewed ? "Reviewed — consistent with the schedule of values (fictional)." : null,
    });
  const mkEvent = (drawId: string, i: number, type: string, detail: string, actor: string | null, createdAt: string) =>
    repo.insertDrawEvent({
      id: `dev-${drawId}-${i}`, drawRequestId: drawId,
      type: type as never, detail, actorUserId: actor, createdAt,
    });

  // Draw 1 — RELEASED history: the full journey with real timestamps.
  repo.insertDrawRequest({
    ...drawBase, id: "draw-g1", drawNumber: 1,
    submittedAt: "2026-03-05T09:00:00.000Z",
    requestedAmount: 95_000, approvedAmount: 95_000, recommendedAmount: 95_000,
    periodStart: "2026-02-15", periodEnd: "2026-03-01",
    status: "RELEASED",
    reviewSummary: "Demolition complete and evidenced; released after dual approval (fictional).",
    createdAt: "2026-03-04T15:00:00.000Z", updatedAt: "2026-03-14T16:00:00.000Z",
  });
  mkReq("draw-g1", 1, [
    ["PAY_APPLICATION", "Pay application #1", true],
    ["CONTRACTOR_INVOICE", "Demolition contractor invoice", true],
    ["CONDITIONAL_LIEN_WAIVER", "Conditional lien waiver #1", true],
  ]);
  mkDoc("draw-g1", 0, "PAY_APPLICATION", "Pay Application #1 (fictional)", "ACCEPTED", "2026-03-05T09:05:00.000Z", true);
  mkDoc("draw-g1", 1, "CONTRACTOR_INVOICE", "Invoice MRV-101 (fictional)", "ACCEPTED", "2026-03-05T09:06:00.000Z", true);
  mkDoc("draw-g1", 2, "CONDITIONAL_LIEN_WAIVER", "Conditional waiver #1 (fictional)", "ACCEPTED", "2026-03-05T09:07:00.000Z", true);
  repo.insertDrawLine({
    id: "dline-g1-1", drawRequestId: "draw-g1", sort: 0, budgetLineId: null,
    milestoneId: "ms-g1", description: "Interior demolition, disposal and site protection",
    scheduledValue: 95_000, previouslyPaid: 0, currentRequested: 95_000,
    materialsStored: null, retainageAmount: 9_500,
    percentCompleteClaimed: 100, percentCompleteVerified: 100,
    supportedAmount: 95_000, status: "SUPPORTED",
    reviewNotes: null, reviewedByUserId: "user-compliance",
    reviewedAt: "2026-03-08T10:00:00.000Z",
    totalCompletedAndStored: 95_000, balanceToFinish: 0,
    varianceAmount: null, variancePercent: null,
  });
  mkEvent("draw-g1", 1, "SUBMITTED", "Draw #1 submitted — $95,000 requested (fictional demo).", "user-dmv-pm", "2026-03-05T09:00:00.000Z");
  // Readiness transition history (immutable rows the readiness machine
  // writes at governed mutation points; final state matches the live
  // evaluation of this seeded draw).
  mkEvent("draw-g1", 6, "READINESS_TRANSITION", JSON.stringify({ status: "INCOMPLETE", from: null, policyVersion: 1 }), "user-dmv-pm", "2026-03-05T09:00:05.000Z");
  mkEvent("draw-g1", 2, "LINE_REVIEWED", "Demolition line marked SUPPORTED after evidence review.", "user-compliance", "2026-03-08T10:00:00.000Z");
  mkEvent("draw-g1", 7, "READINESS_TRANSITION", JSON.stringify({ status: "READY", from: "INCOMPLETE", policyVersion: 1 }), "user-compliance", "2026-03-08T10:00:05.000Z");
  mkEvent("draw-g1", 3, "RECOMMENDATION_FINALIZED", "Recommendation finalized at $95,000.", "user-compliance", "2026-03-09T09:30:00.000Z");
  mkEvent("draw-g1", 4, "GOVERNANCE_DECISION", "Dual approval recorded; draw approved at $95,000.", "user-funder", "2026-03-12T14:00:00.000Z");
  mkEvent("draw-g1", 5, "RELEASE_TRANSITION", "Release eligibility recorded after governance (fictional demo — no real funds move).", "user-funder", "2026-03-14T16:00:00.000Z");
  lenderRepo.insertLenderDecision({
    id: "ldec-g1", organizationId: "org-cdfc", projectId: GOLDEN_PROJECT_ID,
    drawRequestId: "draw-g1", requestedAmount: 95_000, verifiedAmount: 95_000,
    recommendedAmount: 95_000, approvedAmount: 95_000, reducedAmount: null,
    rejectedAmount: null, decision: "APPROVED", reviewerUserId: "user-funder",
    decisionAt: "2026-03-12T14:00:00.000Z",
    decisionReason: "Demolition fully evidenced and inspected (fictional demo decision).",
    holdbackAmount: null, retainageAmount: 9_500, exceptionsAccepted: null,
    governmentInspectionRequirement: null, lienReleaseRequirement: "Conditional waiver on file; unconditional due with next draw.",
    fundingInstructions: null, notes: null, approvalRequestId: null,
    supersedesDecisionId: null, supersededByDecisionId: null,
    verifiedAmountSource: "Line-item review totals (fictional demo)",
    recommendedAmountSource: "Finalized reviewer recommendation (fictional demo)",
    createdAt: "2026-03-12T14:00:00.000Z", updatedAt: "2026-03-12T14:00:00.000Z",
  });

  // Draw 2 — READY_FOR_GOVERNANCE, partially supported line, awaiting 2nd approval.
  repo.insertDrawRequest({
    ...drawBase, id: "draw-g2", drawNumber: 2,
    submittedAt: "2026-07-18T09:00:00.000Z",
    requestedAmount: 182_000, recommendedAmount: 160_000,
    periodStart: "2026-06-15", periodEnd: "2026-07-15",
    status: "READY_FOR_GOVERNANCE",
    reviewSummary:
      "Framing complete (passed reinspection after corrections). Change-order steel line partially " +
      "supported pending final invoice reconciliation (fictional).",
    createdAt: "2026-07-17T15:00:00.000Z", updatedAt: "2026-07-24T10:00:00.000Z",
  });
  mkReq("draw-g2", 2, [
    ["PAY_APPLICATION", "Pay application #2", true],
    ["CONTRACTOR_INVOICE", "Framing contractor invoice", true],
    ["CONDITIONAL_LIEN_WAIVER", "Conditional lien waiver #2", true],
  ]);
  mkDoc("draw-g2", 0, "PAY_APPLICATION", "Pay Application #2 (fictional)", "ACCEPTED", "2026-07-18T09:05:00.000Z", true);
  mkDoc("draw-g2", 1, "CONTRACTOR_INVOICE", "Invoice MRV-118 (fictional)", "ACCEPTED", "2026-07-18T09:06:00.000Z", true);
  mkDoc("draw-g2", 2, "CONDITIONAL_LIEN_WAIVER", "Conditional waiver #2 (fictional)", "ACCEPTED", "2026-07-18T09:07:00.000Z", true);
  repo.insertDrawLine({
    id: "dline-g2-1", drawRequestId: "draw-g2", sort: 0, budgetLineId: null,
    milestoneId: "ms-g2", description: "Structural framing and repairs (base scope)",
    scheduledValue: 160_000, previouslyPaid: 0, currentRequested: 160_000,
    materialsStored: null, retainageAmount: 16_000,
    percentCompleteClaimed: 100, percentCompleteVerified: 100,
    supportedAmount: 160_000, status: "SUPPORTED",
    reviewNotes: "Framing passed reinspection DEMO-INS-2026-3388 after corrections were cleared.",
    reviewedByUserId: "user-compliance", reviewedAt: "2026-07-22T11:00:00.000Z",
    totalCompletedAndStored: 160_000, balanceToFinish: 0,
    varianceAmount: null, variancePercent: null,
  });
  repo.insertDrawLine({
    id: "dline-g2-2", drawRequestId: "draw-g2", sort: 1, budgetLineId: null,
    milestoneId: "ms-g2", description: "CO-1 structural steel upgrade (fictional change order)",
    scheduledValue: 22_000, previouslyPaid: 0, currentRequested: 22_000,
    materialsStored: null, retainageAmount: 2_200,
    percentCompleteClaimed: 100, percentCompleteVerified: 60,
    supportedAmount: 0, status: "PARTIALLY_SUPPORTED",
    reviewNotes: "Steel installed, but the fabricator's final invoice does not yet reconcile to CO-1 — $0 supported until reconciled (fictional).",
    reviewedByUserId: "user-funder", reviewedAt: "2026-07-23T09:00:00.000Z",
    totalCompletedAndStored: 22_000, balanceToFinish: 0,
    varianceAmount: null, variancePercent: null,
  });
  mkEvent("draw-g2", 1, "SUBMITTED", "Draw #2 submitted — $182,000 requested (fictional demo).", "user-dmv-pm", "2026-07-18T09:00:00.000Z");
  mkEvent("draw-g2", 6, "READINESS_TRANSITION", JSON.stringify({ status: "INCOMPLETE", from: null, policyVersion: 1 }), "user-dmv-pm", "2026-07-18T09:00:05.000Z");
  mkEvent("draw-g2", 2, "LINE_REVIEWED", "Framing line marked SUPPORTED; reinspection history attached.", "user-compliance", "2026-07-22T11:00:00.000Z");
  mkEvent("draw-g2", 3, "LINE_REVIEWED", "CO-1 steel line PARTIALLY SUPPORTED pending invoice reconciliation.", "user-funder", "2026-07-23T09:00:00.000Z");
  mkEvent("draw-g2", 4, "RECOMMENDATION_FINALIZED", "Recommendation finalized at $160,000 of $182,000 requested.", "user-compliance", "2026-07-24T10:00:00.000Z");
  mkEvent("draw-g2", 7, "READINESS_TRANSITION", JSON.stringify({ status: "READY", from: "INCOMPLETE", policyVersion: 1 }), "user-compliance", "2026-07-24T10:00:30.000Z");
  mkEvent("draw-g2", 5, "SENT_TO_GOVERNANCE", "Sent to formal governance — dual approval required.", "user-compliance", "2026-07-24T10:01:00.000Z");
  repo.insertApprovalRequest({
    id: "appr-g2", milestoneId: null, drawRequestId: "draw-g2",
    subjectType: "DRAW", status: "PENDING",
    requiredRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"],
    createdAt: "2026-07-24T10:01:00.000Z",
  });
  repo.insertApprovalRecord({
    id: "apprec-g2-1", approvalRequestId: "appr-g2",
    userId: "user-compliance", role: "COMPLIANCE_REVIEWER",
    decision: "APPROVED",
    createdAt: "2026-07-25T09:00:00.000Z",
  });

  // Draw 3 — RETURNED for more evidence (aging past target).
  repo.insertDrawRequest({
    ...drawBase, id: "draw-g3", drawNumber: 3,
    submittedAt: "2026-07-06T09:00:00.000Z",
    requestedAmount: 96_000,
    periodStart: "2026-06-20", periodEnd: "2026-07-05",
    status: "RETURNED",
    reviewSummary: "Returned: envelope photos do not show completed flashing at the rear parapet (fictional).",
    createdAt: "2026-07-05T15:00:00.000Z", updatedAt: "2026-07-10T10:00:00.000Z",
  });
  mkReq("draw-g3", 3, [
    ["PAY_APPLICATION", "Pay application #3", true],
    ["CONTRACTOR_INVOICE", "Roofing contractor invoice", true],
  ]);
  mkDoc("draw-g3", 0, "PAY_APPLICATION", "Pay Application #3 (fictional)", "RECEIVED", "2026-07-06T09:05:00.000Z", false);
  mkDoc("draw-g3", 1, "CONTRACTOR_INVOICE", "Invoice MRV-124 (fictional)", "RECEIVED", "2026-07-06T09:06:00.000Z", false);
  repo.insertDrawLine({
    id: "dline-g3-1", drawRequestId: "draw-g3", sort: 0, budgetLineId: null,
    milestoneId: "ms-g3", description: "Roof membrane and parapet flashing",
    scheduledValue: 96_000, previouslyPaid: 0, currentRequested: 96_000,
    materialsStored: null, retainageAmount: 9_600,
    percentCompleteClaimed: 90, percentCompleteVerified: null,
    supportedAmount: null, status: "PENDING",
    reviewNotes: null, reviewedByUserId: null, reviewedAt: null,
    totalCompletedAndStored: 0, balanceToFinish: 0,
    varianceAmount: null, variancePercent: null,
  });
  mkEvent("draw-g3", 1, "SUBMITTED", "Draw #3 submitted — $96,000 requested (fictional demo).", "user-dmv-pm", "2026-07-06T09:00:00.000Z");
  mkEvent("draw-g3", 3, "READINESS_TRANSITION", JSON.stringify({ status: "INCOMPLETE", from: null, policyVersion: 1 }), "user-dmv-pm", "2026-07-06T09:00:05.000Z");
  mkEvent("draw-g3", 2, "RETURNED", "Returned for additional evidence: rear parapet flashing not visible in submitted photos (fictional).", "user-compliance", "2026-07-10T10:00:00.000Z");
  mkEvent("draw-g3", 4, "READINESS_TRANSITION", JSON.stringify({ status: "HOLD", from: "INCOMPLETE", policyVersion: 1 }), "user-compliance", "2026-07-10T10:00:05.000Z");

  // Draw 4 — UNDER_REVIEW with a MISSING required lien waiver.
  repo.insertDrawRequest({
    ...drawBase, id: "draw-g4", drawNumber: 4,
    submittedAt: "2026-07-28T09:00:00.000Z",
    requestedAmount: 74_000,
    periodStart: "2026-07-01", periodEnd: "2026-07-25",
    status: "UNDER_REVIEW",
    createdAt: "2026-07-27T15:00:00.000Z", updatedAt: "2026-07-29T10:00:00.000Z",
  });
  mkReq("draw-g4", 4, [
    ["PAY_APPLICATION", "Pay application #4", true],
    ["CONTRACTOR_INVOICE", "Window supplier invoice", true],
    ["CONDITIONAL_LIEN_WAIVER", "Conditional lien waiver #4", true],
  ]);
  mkDoc("draw-g4", 0, "PAY_APPLICATION", "Pay Application #4 (fictional)", "ACCEPTED", "2026-07-28T09:05:00.000Z", true);
  mkDoc("draw-g4", 1, "CONTRACTOR_INVOICE", "Invoice HW-2214 (fictional)", "RECEIVED", "2026-07-28T09:06:00.000Z", false);
  // NOTE: requirement index 2 (lien waiver) has NO document — this is the
  // missing-document situation the pilot demo tells.
  repo.insertDrawLine({
    id: "dline-g4-1", drawRequestId: "draw-g4", sort: 0, budgetLineId: null,
    milestoneId: "ms-g3", description: "Window installation and envelope completion balance",
    scheduledValue: 74_000, previouslyPaid: 0, currentRequested: 74_000,
    materialsStored: null, retainageAmount: 7_400,
    percentCompleteClaimed: 80, percentCompleteVerified: null,
    supportedAmount: null, status: "PENDING",
    reviewNotes: null, reviewedByUserId: null, reviewedAt: null,
    totalCompletedAndStored: 0, balanceToFinish: 0,
    varianceAmount: null, variancePercent: null,
  });
  mkEvent("draw-g4", 1, "SUBMITTED", "Draw #4 submitted — $74,000 requested (fictional demo).", "user-dmv-pm", "2026-07-28T09:00:00.000Z");
  mkEvent("draw-g4", 2, "DOCUMENT_RECORDED", "Pay application and invoice received; conditional lien waiver outstanding.", "user-dmv-pm", "2026-07-28T09:06:00.000Z");

  // Draw 5 — SUBMITTED with an OPEN compliance exception (permit discrepancy).
  repo.insertDrawRequest({
    ...drawBase, id: "draw-g5", drawNumber: 5,
    submittedAt: "2026-07-30T09:00:00.000Z",
    requestedAmount: 118_000,
    periodStart: "2026-07-05", periodEnd: "2026-07-28",
    status: "SUBMITTED",
    createdAt: "2026-07-29T15:00:00.000Z", updatedAt: "2026-07-30T09:00:00.000Z",
  });
  mkReq("draw-g5", 5, [
    ["PAY_APPLICATION", "Pay application #5", true],
    ["CONTRACTOR_INVOICE", "Electrical contractor invoice", true],
  ]);
  mkDoc("draw-g5", 0, "PAY_APPLICATION", "Pay Application #5 (fictional)", "RECEIVED", "2026-07-30T09:05:00.000Z", false);
  mkDoc("draw-g5", 1, "CONTRACTOR_INVOICE", "Invoice VE-3310 (fictional)", "RECEIVED", "2026-07-30T09:06:00.000Z", false);
  repo.insertDrawLine({
    id: "dline-g5-1", drawRequestId: "draw-g5", sort: 0, budgetLineId: null,
    milestoneId: "ms-g4", description: "Electrical rough-in labor and materials",
    scheduledValue: 118_000, previouslyPaid: 0, currentRequested: 118_000,
    materialsStored: null, retainageAmount: 11_800,
    percentCompleteClaimed: 70, percentCompleteVerified: null,
    supportedAmount: null, status: "PENDING",
    reviewNotes: null, reviewedByUserId: null, reviewedAt: null,
    totalCompletedAndStored: 0, balanceToFinish: 0,
    varianceAmount: null, variancePercent: null,
  });
  mkEvent("draw-g5", 1, "SUBMITTED", "Draw #5 submitted — $118,000 requested (fictional demo).", "user-dmv-pm", "2026-07-30T09:00:00.000Z");
  repo.insertException({
    id: "exc-g5", organizationId: "org-cdfc", projectId: GOLDEN_PROJECT_ID,
    milestoneId: "ms-g4", drawRequestId: "draw-g5", budgetLineId: null,
    sourceType: "MANUAL" as never, sourceId: "permit-g-elec",
    sourceKey: "golden:permit-scope-discrepancy",
    category: "DOCUMENT", severity: "HIGH", status: "OPEN",
    title: "Permit scope discrepancy — service size (fictional)",
    description:
      "The electrical invoice references a 400A heavy-up while fictional permit DEMO-E2026-22815 was " +
      "issued for 200A service. A reviewer must reconcile the recorded permit scope with the invoiced " +
      "work before this draw's electrical line can support release. Fictional demo exception.",
    ownerUserId: "user-compliance", dueAt: "2026-08-08T00:00:00.000Z",
    openedAt: "2026-07-31T10:00:00.000Z", acknowledgedAt: null,
    resolvedAt: null, resolutionSummary: null, resolutionType: null,
    createdBy: "user-compliance",
    createdAt: "2026-07-31T10:00:00.000Z", updatedAt: "2026-07-31T10:00:00.000Z",
  });

  // Draw 6 — SUBMITTED, docs complete, required inspection result outstanding.
  repo.insertDrawRequest({
    ...drawBase, id: "draw-g6", drawNumber: 6,
    submittedAt: "2026-08-01T09:00:00.000Z",
    requestedAmount: 67_000,
    periodStart: "2026-07-10", periodEnd: "2026-07-31",
    status: "SUBMITTED",
    createdAt: "2026-07-31T15:00:00.000Z", updatedAt: "2026-08-01T09:00:00.000Z",
  });
  mkReq("draw-g6", 6, [
    ["PAY_APPLICATION", "Pay application #6", true],
    ["CONTRACTOR_INVOICE", "Plumbing contractor invoice", true],
  ]);
  mkDoc("draw-g6", 0, "PAY_APPLICATION", "Pay Application #6 (fictional)", "ACCEPTED", "2026-08-01T09:05:00.000Z", true);
  mkDoc("draw-g6", 1, "CONTRACTOR_INVOICE", "Invoice PL-889 (fictional)", "ACCEPTED", "2026-08-01T09:06:00.000Z", true);
  repo.insertDrawLine({
    id: "dline-g6-1", drawRequestId: "draw-g6", sort: 0, budgetLineId: null,
    milestoneId: "ms-g4", description: "Plumbing rough-in — supply and waste",
    scheduledValue: 67_000, previouslyPaid: 0, currentRequested: 67_000,
    materialsStored: null, retainageAmount: 6_700,
    percentCompleteClaimed: 65, percentCompleteVerified: null,
    supportedAmount: null, status: "PENDING",
    reviewNotes: null, reviewedByUserId: null, reviewedAt: null,
    totalCompletedAndStored: 0, balanceToFinish: 0,
    varianceAmount: null, variancePercent: null,
  });
  mkEvent("draw-g6", 1, "SUBMITTED", "Draw #6 submitted — $67,000 requested (fictional demo).", "user-dmv-pm", "2026-08-01T09:00:00.000Z");
}
