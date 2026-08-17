#!/usr/bin/env node
/**
 * Draw Readiness Engine test battery — the A–R matrix from the milestone
 * spec, plus the §29 language assertions, determinism, cross-tenant
 * boundaries and snapshot immutability.
 *
 *   A  everything satisfied            → READY
 *   B  missing required evidence       → HOLD
 *   C  verification rejected           → HOLD
 *   D  required inspection outstanding → HOLD
 *   E  permit/requirement unknown      → INCOMPLETE / HOLD per configured policy
 *   F  requested > supported           → correct supportable amount + variance
 *   G  approved change order           → correctly reflected
 *   H  unapproved change order         → cannot silently expand supportable
 *   I  blocking exception              → HOLD / EXCEPTION_REVIEW per policy
 *   J  authorized override             → blocker remains, decision records exception
 *   K  unauthorized override           → denied (unlabeled bypass refused)
 *   L  two blockers                    → both preserved, deterministic primary
 *   M  advisory AI issue only          → warning, never automatic HOLD
 *   N  unknown official-source state   → never an authoritative PASS
 *   O  historical snapshot             → unchanged when live readiness changes
 *   P  same inputs                     → identical result
 *   Q  cross-tenant                    → cannot read or affect
 *   R  FIELD user                      → cannot invoke the lender exception path
 *
 * Structure follows lender-pilot-test.js: service-level scenarios against
 * a golden-seeded database first, then a live server on PORT 3370 for the
 * HTTP/UI language assertions.
 */
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = process.cwd();
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "obv-readiness-"));
const PORT = 3370;
const BASE = `http://127.0.0.1:${PORT}`;

process.env.OBV_DATA_DIR = DATA;
process.env.OBV_SEED_GOLDEN = "1";

let passed = 0;
const pass = (m) => { passed += 1; console.log(`  ✓ [${String(passed).padStart(3, "0")}] ${m}`); };
const fail = (m) => { console.error(`  ✗ FAIL: ${m}`); throw new Error(m); };
const assert = (cond, m) => (cond ? pass(m) : fail(m));

if (spawnSync(process.execPath, [path.join(ROOT, "dist/server/db/seed.js")], {
  env: { ...process.env }, stdio: "ignore",
}).status !== 0) { console.error("seed failed"); process.exit(1); }

const repo = require(path.join(ROOT, "dist/server/db/repo"));
const draws = require(path.join(ROOT, "dist/server/services/draws"));
const dr = require(path.join(ROOT, "dist/server/services/drawReadiness"));
const lenderDecisions = require(path.join(ROOT, "dist/server/services/lenderDecisions"));
const drawPackage = require(path.join(ROOT, "dist/server/services/drawPackage"));
const { DatabaseSync } = require("node:sqlite");

const funder = repo.getUser("user-funder");
const compliance = repo.getUser("user-compliance");
const dmvPm = repo.getUser("user-dmv-pm");
const dmvField = repo.getUser("user-dmv-field");
const foreignField = repo.getUser("user-field"); // org-crra — no golden access
const foreignPm = repo.getUser("user-pm");       // org-crra — no golden access

const db = new DatabaseSync(path.join(DATA, "obv.db"));
const codes = (rs) => rs.blockingReasons.map((b) => b.code);
const warnCodes = (rs) => rs.warnings.map((w) => w.code);

let server = null;
const stopServer = () => { try { server?.kill("SIGKILL"); } catch { /* gone */ } server = null; };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { stopServer(); process.exit(130); });
}

// ---------------------------------------------------------------- pure-input helpers
// evaluateDrawReadiness is a pure function over assembled data — these
// build minimal realistic inputs using the SAME reason codes the real
// completionGates emit, so evaluator behavior is pinned without HTTP.
const T0 = "2026-08-17T12:00:00.000Z";
const COMPLETE_CHECKS = [
  { key: "amount", label: "Requested amount entered", ok: true, detail: "$10,000" },
  { key: "period", label: "Draw period set", ok: true, detail: "2026-08-01 → 2026-08-31" },
  { key: "lines", label: "At least one line item", ok: true, detail: "1 line item(s)" },
  { key: "reconcile", label: "Line items reconcile to the requested amount", ok: true, detail: "Lines total $10,000" },
  { key: "documents", label: "Required documents on file", ok: true, detail: "All required documents received." },
  { key: "evidence", label: "Field evidence linked (recommended)", ok: true, detail: "1 evidence link(s)" },
];
const gateRef = (reasons, over = {}) => ({
  milestoneId: "ms-syn",
  label: "M1 · Synthetic milestone",
  requiredEvidenceConfigured: over.requiredEvidenceConfigured ?? false,
  inspectionSurfaceClean: over.inspectionSurfaceClean ?? true,
  gates: {
    milestoneId: "ms-syn",
    contractor: { status: "REPORTED_COMPLETE", reportedByUserId: null, reportedAt: null, notes: null, linkedEvidenceIds: [] },
    evidenceReview: { status: over.evidenceStatus ?? "VERIFIED", evidenceCount: 1, latestVerdict: null, policyVersion: 1 },
    requirement: null,
    requirementValue: over.requirementValue ?? "NOT_REQUIRED",
    inspection: null,
    inspectionGate: over.inspectionGate ?? "NOT_APPLICABLE",
    eligibility: {
      milestoneId: "ms-syn", result: "NOT_ELIGIBLE", reasons,
      permitBlocksDrawReview: false, permitBlocksGovernance: false,
      codeBasisBlocksDrawReview: false, codeBasisBlocksGovernance: false, computedAt: T0,
    },
  },
});
const synInput = (reasons, over = {}) => ({
  draw: { id: "d-syn", status: "SUBMITTED", requestedAmount: 10000 },
  lines: over.lines ?? [{
    id: "l-syn", description: "Synthetic line", status: "SUPPORTED",
    currentRequested: 10000, supportedAmount: null, reviewNotes: null,
  }],
  completeness: { ok: true, checks: COMPLETE_CHECKS },
  checklist: over.checklist ?? [],
  evidenceLinkCount: 1,
  gates: [gateRef(reasons, over)],
  openExceptions: over.openExceptions ?? [],
  milestoneExceptions: over.milestoneExceptions ?? [],
  decision: over.decision ?? null,
  advisoryNotes: over.advisoryNotes ?? [],
  dmv: over.dmv ?? null,
  evaluatedAt: T0,
});

async function main() {
  console.log("Draw Readiness Engine — deterministic blockers, supportable amount, exception path");

  // ================= A · everything satisfied → READY =================
  console.log("\n== A · everything satisfied → READY ==");
  const g2 = dr.drawReadiness("draw-g2");
  assert(g2.status === "READY", "fully reviewed, fully documented draw evaluates READY");
  assert(g2.blockingReasons.length === 0, "READY carries zero blocking reasons");
  assert(g2.satisfiedRequirements.length > 0, "READY lists the satisfied requirements, not just a green light");
  assert(g2.primaryBlocker === null, "no primary blocker on a READY draw");
  assert(g2.policyVersion === dr.READINESS_POLICY_VERSION, "every result carries the policy version");
  assert(typeof g2.evaluatedAt === "string" && g2.evaluatedAt.length > 0, "every result carries evaluatedAt");
  assert(g2.satisfiedRequirements.some((s) => s.code === "REQUIRED_DOCUMENT_ON_FILE" && s.category === "LIEN"),
    "the accepted lien waiver is an explicit satisfied requirement");
  assert(g2.warnings.some((w) => w.code === "INSPECTION_REQUIREMENT_UNKNOWN"),
    "the undetermined inspection requirement stays visible as a warning even on a READY draw");
  const rA = dr.evaluateDrawReadiness(synInput([], { requirementValue: "REQUIRED", inspectionGate: "PASSED" }));
  assert(rA.status === "READY" && rA.satisfiedRequirements.some((s) => s.code === "REQUIRED_INSPECTION_PASSED"),
    "a REQUIRED inspection with a PASSED reviewed result is an explicit satisfied requirement");

  // ================= B · missing required evidence → HOLD =============
  console.log("\n== B · configured required evidence missing → HOLD ==");
  // Configure REQUIRED evidence on ms-g3 (roof), where nothing has been
  // submitted through the governed capture pipeline.
  repo.insertRequirement({
    id: "evreq-test-roof", milestoneId: "ms-g3", sort: 0, type: "PHOTO",
    title: "Roof membrane progress photos", description: "Configured required evidence (test).",
    required: true, minCount: 2, mediaTypes: ["image/jpeg"], geolocationRequired: true,
    recencyDays: null, notes: null,
  });
  const drawB = draws.createDraw(dmvPm, {
    projectId: "proj-golden", requestedAmount: 40000,
    periodStart: "2026-09-01", periodEnd: "2026-09-30",
  });
  draws.addLine(dmvPm, drawB.id, {
    description: "Roof membrane balance", budgetLineId: null, milestoneId: "ms-g3",
    changeOrderId: null, exceptionAcknowledged: false,
    scheduledValue: 60000, previouslyPaid: 0, currentRequested: 40000,
    materialsStored: null, retainageAmount: null, percentCompleteClaimed: 60,
  });
  await draws.submitDraw(dmvPm, drawB.id);
  const lineB = repo.listDrawLines(drawB.id)[0];
  draws.reviewLine(funder, lineB.id, { decision: "SUPPORTED" });
  const rB = dr.drawReadiness(drawB.id);
  assert(rB.status === "HOLD", "missing configured required evidence → HOLD (not EXCEPTION_REVIEW, not INCOMPLETE)");
  assert(codes(rB).includes("REQUIRED_EVIDENCE_MISSING"), "the blocker is REQUIRED_EVIDENCE_MISSING");
  const evB = rB.blockingReasons.find((b) => b.code === "REQUIRED_EVIDENCE_MISSING");
  assert(evB.category === "EVIDENCE" && evB.nextAction.length > 0 && evB.sourceRecordId === "ms-g3",
    "the blocker carries category, next action and the source milestone");
  assert(rB.supportableAmount === 40000 && rB.supportBasis === "FULL_REVIEW",
    "supportable amount still comes from the recorded line review — readiness and dollars are separate axes");

  // Where NO required evidence is configured, absence is a warning only.
  const g1 = dr.drawReadiness("draw-g1");
  assert(g1.status === "READY" && warnCodes(g1).includes("EVIDENCE_LINKS_MISSING"),
    "without a configured requirement, absent evidence links warn — the engine never invents a stricter rule");

  // ================= C · verification rejected → HOLD =================
  console.log("\n== C · governed verification verdict REJECTED → HOLD ==");
  const rC = dr.evaluateDrawReadiness(synInput([
    { code: "EVIDENCE_REJECTED", detail: "The latest evidence was REJECTED by verification — acceptable evidence must be recorded.", blocking: true },
  ], { evidenceStatus: "REJECTED" }));
  assert(rC.status === "HOLD", "a REJECTED governed verdict holds the draw");
  assert(codes(rC).includes("EVIDENCE_REJECTED"), "the blocker names the rejected verification");
  assert(rC.primaryBlocker.category === "EVIDENCE", "rejected verification is the EVIDENCE primary");

  // ================= D · required inspection outstanding → HOLD =======
  console.log("\n== D · required jurisdictional inspection outstanding → HOLD ==");
  const rD = dr.evaluateDrawReadiness(synInput([
    { code: "INSPECTION_NOT_SCHEDULED", detail: "Required electrical inspection has not been scheduled.", blocking: true },
    { code: "JURISDICTIONAL_INSPECTION_NOT_PASSED", detail: "Required jurisdictional inspection has not passed.", blocking: true },
  ], { requirementValue: "REQUIRED", inspectionGate: "REQUIRED_UNSCHEDULED" }));
  assert(rD.status === "HOLD", "an outstanding required inspection holds the draw");
  assert(codes(rD).includes("JURISDICTIONAL_INSPECTION_NOT_PASSED"),
    "the inspection blocker is preserved verbatim from the gate record");
  assert(rD.primaryBlocker.category === "GOVERNMENT_INSPECTION",
    "GOVERNMENT_INSPECTION outranks the other categories present");

  // ================= E · unknown → INCOMPLETE / HOLD per policy =======
  console.log("\n== E · UNKNOWN states → INCOMPLETE or HOLD per configured policy ==");
  const incompleteInput = synInput([]);
  incompleteInput.completeness = {
    ok: false,
    checks: COMPLETE_CHECKS.map((c) => (c.key === "period" ? { ...c, ok: false, detail: "Set the period this draw covers." } : c)),
  };
  const rE1 = dr.evaluateDrawReadiness(incompleteInput);
  assert(rE1.status === "INCOMPLETE", "missing draw-structure information → INCOMPLETE, never READY");
  const rE2 = dr.evaluateDrawReadiness(synInput([
    { code: "PERMIT_NOT_ACTIVE", detail: "Linked permit DCRA-000 is UNKNOWN — not an active permit. Blocks: governance.", blocking: true },
  ]));
  assert(rE2.status === "HOLD" && rE2.primaryBlocker.category === "PERMIT",
    "an unknown-status permit where configuration gates it → HOLD (UNKNOWN never behaves as ACTIVE)");
  // Stage semantics are owned by completionGates.reasonBlocksDrawReview:
  // a draw-review-only permit rule arrives with blocking=false (the flag
  // encodes governance) plus permitBlocksDrawReview=true on eligibility.
  const drawReviewPermit = synInput([
    { code: "PERMIT_EXPIRED", detail: "Linked permit DCRA-001 is expired. Blocks: draw review.", blocking: false },
  ]);
  drawReviewPermit.gates[0].gates.eligibility.permitBlocksDrawReview = true;
  const rE4 = dr.evaluateDrawReadiness(drawReviewPermit);
  assert(rE4.status === "HOLD" && codes(rE4).includes("PERMIT_EXPIRED"),
    "a draw-review-only permit gate blocks readiness even though its governance flag is off");
  const rE5 = dr.evaluateDrawReadiness(synInput([
    { code: "INSPECTION_NOT_SCHEDULED", detail: "Required inspection has not been scheduled. Blocks: draw review.", blocking: false },
  ], { requirementValue: "REQUIRED", inspectionGate: "REQUIRED_UNSCHEDULED" }));
  assert(rE5.status === "HOLD" && codes(rE5).includes("INSPECTION_NOT_SCHEDULED"),
    "a draw-review-only inspection gate (emitted non-blocking by the governance flag) still holds lender review");
  // A RELEASED milestone keeps its inspection truth: eligibility
  // short-circuits to bookkeeping, but a dirty surface is surfaced.
  const released = synInput([
    { code: "TRANCHE_RELEASED", detail: "The tranche was released by completed formal governance (exactly once).", blocking: false },
  ], { requirementValue: "REQUIRED", inspectionGate: "FAILED" });
  released.gates[0].inspectionSurfaceClean = false;
  const rE6 = dr.evaluateDrawReadiness(released);
  assert(rE6.warnings.some((w) => w.code === "RELEASED_MILESTONE_SURFACE_NOT_CLEAN"),
    "a released milestone with a dirty inspection surface is surfaced, never silently clean");
  // Unmapped lines: no jurisdictional surface — surfaced, never a
  // vacuous pass.
  const unmapped = synInput([]);
  unmapped.gates = [];
  unmapped.unmappedLineCount = 1;
  const rE7 = dr.evaluateDrawReadiness(unmapped);
  assert(rE7.warnings.some((w) => w.code === "LINE_WITHOUT_MILESTONE"),
    "a line with no milestone mapping warns that its gates cannot be evaluated");
  const rE3 = dr.evaluateDrawReadiness(synInput([
    { code: "INSPECTION_REQUIREMENT_UNKNOWN", detail: "Undetermined.", blocking: false },
  ], { requirementValue: "UNKNOWN", inspectionGate: "REQUIREMENT_UNKNOWN" }));
  assert(rE3.status === "READY" && warnCodes(rE3).includes("INSPECTION_REQUIREMENT_UNKNOWN"),
    "an ungated UNKNOWN requirement surfaces as a warning — visible, never a silent pass");
  assert(rE3.categories.find((c) => c.category === "GOVERNMENT_INSPECTION").state === "WARNING",
    "the category rollup shows WARNING, not PASS, for the undetermined requirement");
  assert(!rE3.satisfiedRequirements.some((s) => s.category === "GOVERNMENT_INSPECTION"),
    "UNKNOWN never appears among satisfied requirements");

  // ================= F · requested > supported → variance =============
  console.log("\n== F · requested vs supported variance ==");
  assert(g2.requestedAmount === 182000 && g2.supportableAmount === 160000,
    "draw #2: requested $182,000, supportable $160,000 from recorded line reviews");
  const partial = g2.lineReadiness.find((l) => l.variance !== null && l.variance > 0);
  assert(partial && partial.requested - partial.supported === partial.variance,
    "the variance line explains exactly which line creates the difference");
  assert(typeof partial.reason === "string" && partial.reason.length > 0,
    "the per-line variance carries the reviewer's recorded reason — no opaque adjustment");
  assert(g2.lineReadiness.reduce((s, l) => s + (l.supported ?? 0), 0) === g2.supportableAmount,
    "supportable amount is exactly the sum of line-level supported amounts");

  // ================= G · approved change order reflected ==============
  console.log("\n== G · approved change order in the valid basis ==");
  const coG1 = repo.getChangeOrder("co-g1");
  assert(coG1.status === "APPROVED" && coG1.approvedAmount === 22000,
    "CO-1 is formally APPROVED for $22,000 — the valid basis for its billing line");
  const coRead = g2.lineReadiness.find((l) => /CO-1/.test(l.description));
  assert(coRead && g2.requestedAmount === 182000,
    "the approved-CO line participates in the requested amount");
  assert(coRead.supported === 0 && coRead.variance === coRead.requested,
    "the CO line's support is exactly the reviewer's recorded decision — $0 until the invoice reconciles");
  assert(typeof coRead.reason === "string" && /reconcil/i.test(coRead.reason),
    "the CO line's variance carries the reviewer's recorded reason");
  assert(!codes(g2).some((c) => c.startsWith("CHANGE_ORDER")) && !warnCodes(g2).includes("CHANGE_ORDER_NOT_APPROVED"),
    "an APPROVED change order raises no change-order blocker or warning");

  // ================= H · unapproved CO cannot expand support ==========
  console.log("\n== H · unapproved change order cannot silently expand support ==");
  repo.insertChangeOrder({
    id: "co-test-pending", organizationId: "org-cdfc", projectId: "proj-golden",
    changeOrderNumber: 99, title: "Unapproved scope increase (test)",
    description: "Fictional pending change order for the readiness test.",
    reasonCategory: "SCOPE_CHANGE", requestedByUserId: dmvPm.id, requestedAt: T0,
    requestedAmount: 25000, approvedAmount: null, currency: "USD", scheduleImpactDays: null,
    status: "SUBMITTED", affectedMilestoneIds: ["ms-g5"], affectedBudgetLineIds: [],
    appliedAt: null, appliedSnapshotVersion: null, createdAt: T0, updatedAt: T0,
  });
  const drawH = draws.createDraw(dmvPm, {
    projectId: "proj-golden", requestedAmount: 25000,
    periodStart: "2026-09-01", periodEnd: "2026-09-30",
  });
  let silent = null;
  try {
    draws.addLine(dmvPm, drawH.id, {
      description: "Unapproved CO-99 billing (test)", budgetLineId: null, milestoneId: "ms-g5",
      changeOrderId: "co-test-pending", exceptionAcknowledged: false,
      scheduledValue: 25000, previouslyPaid: 0, currentRequested: 25000,
      materialsStored: null, retainageAmount: null, percentCompleteClaimed: 0,
    });
  } catch (e) { silent = e; }
  assert(silent && /unapproved change order/i.test(silent.message),
    "billing an unapproved CO without an explicit acknowledgement is refused at entry");
  draws.addLine(dmvPm, drawH.id, {
    description: "Unapproved CO-99 billing (test)", budgetLineId: null, milestoneId: "ms-g5",
    changeOrderId: "co-test-pending", exceptionAcknowledged: true,
    scheduledValue: 25000, previouslyPaid: 0, currentRequested: 25000,
    materialsStored: null, retainageAmount: null, percentCompleteClaimed: 0,
  });
  await draws.submitDraw(dmvPm, drawH.id);
  const rH = dr.drawReadiness(drawH.id);
  assert(rH.supportableAmount === 0 && rH.supportBasis === "NO_REVIEW",
    "an unreviewed line contributes ZERO — no CO can create supportable dollars by itself");
  assert(warnCodes(rH).includes("CHANGE_ORDER_NOT_APPROVED"),
    "the unapproved change order is surfaced to the lender, never silently absorbed");
  const lineH = repo.listDrawLines(drawH.id)[0];
  draws.reviewLine(funder, lineH.id, {
    decision: "EXCEPTION",
    reason: "Billed under unapproved CO-99 — no supportable basis until the change order is approved.",
  });
  const rH2 = dr.drawReadiness(drawH.id);
  assert(rH2.supportableAmount === 0,
    "an EXCEPTION line review keeps support at zero — only an explicit reviewer decision could support it");

  // ================= I · blocking exception → per policy ==============
  console.log("\n== I · blocking exception → HOLD / EXCEPTION_REVIEW per policy ==");
  const g5Before = dr.drawReadiness("draw-g5");
  assert(g5Before.status === "HOLD" && codes(g5Before).includes("LINE_REVIEW_INCOMPLETE"),
    "with reviewer work incomplete the draw HOLDs regardless of the exception");
  for (const l of repo.listDrawLines("draw-g5")) {
    draws.reviewLine(funder, l.id, { decision: "SUPPORTED" });
  }
  const g5 = dr.drawReadiness("draw-g5");
  assert(g5.status === "EXCEPTION_REVIEW",
    "once only recorded exceptions remain, status is EXCEPTION_REVIEW — the lender may proceed by documented exception");
  assert(codes(g5).some((c) => c === "OPEN_BLOCKING_EXCEPTION" || c === "HIGH_SEVERITY_EXCEPTION_OPEN"),
    "the open HIGH-severity exception is the blocking reason");
  // exc-g5 is linked to BOTH the draw and milestone ms-g4 — one recorded
  // exception must appear as exactly ONE blocker, keyed by its id.
  assert(g5.blockingReasons.filter((b) => b.sourceRecordId === "exc-g5").length === 1,
    "a dual-linked exception (draw + milestone) is reported exactly once, by exception id");
  const g6 = dr.drawReadiness("draw-g6");
  assert(g6.blockingReasons.filter((b) => b.sourceRecordId === "exc-g5").length === 1,
    "a milestone-linked exception reaches sibling draws on the milestone exactly once, by id");
  const strict = JSON.parse(JSON.stringify(dr.DEFAULT_READINESS_POLICY));
  strict.exceptionEligible.EXCEPTION = false;
  const g5strict = dr.evaluateDrawReadiness(dr.assembleReadinessInput("draw-g5", T0), strict);
  assert(g5strict.status === "HOLD",
    "under a policy where exceptions are not exception-eligible the same facts resolve HOLD — policy versioned, not hardcoded");

  // ================= L · two blockers, deterministic primary ==========
  console.log("\n== L · multiple blockers — all preserved, deterministic primary ==");
  const g4 = dr.drawReadiness("draw-g4");
  assert(g4.blockingReasons.length >= 2, `draw #4 carries ${g4.blockingReasons.length} blockers — all returned`);
  assert(codes(g4).includes("REQUIRED_DOCUMENT_MISSING") && codes(g4).includes("LINE_REVIEW_INCOMPLETE"),
    "both underlying reasons are preserved (lien waiver missing + review incomplete)");
  assert(g4.primaryBlocker.code === codes(g4)[0],
    "the primary blocker is the first of the deterministically ordered list");
  const g4again = dr.drawReadiness("draw-g4");
  assert(g4again.primaryBlocker.code === g4.primaryBlocker.code,
    "re-evaluating the same records yields the same primary blocker");
  const rL = dr.evaluateDrawReadiness(synInput([
    { code: "JURISDICTIONAL_INSPECTION_NOT_PASSED", detail: "Not passed.", blocking: true },
    { code: "EVIDENCE_REJECTED", detail: "Rejected verification.", blocking: true },
  ], { evidenceStatus: "REJECTED", requirementValue: "REQUIRED", inspectionGate: "FAILED" }));
  assert(rL.primaryBlocker.code === "EVIDENCE_REJECTED",
    "EVIDENCE outranks GOVERNMENT_INSPECTION in the documented category order regardless of input order");

  // ================= M · advisory AI issue → warning only =============
  console.log("\n== M · advisory intelligence never sets HOLD ==");
  assert(g1.status === "READY" && warnCodes(g1).includes("ADVISORY_SIGNAL"),
    "a draw with only advisory signals stays READY — advisory output warns, never blocks");
  const rM = dr.evaluateDrawReadiness(synInput([], {
    advisoryNotes: ["Financial progress is ahead of verified physical progress on one line (advisory)."],
  }));
  assert(rM.status === "READY" && rM.warnings.some((w) => w.code === "ADVISORY_SIGNAL"),
    "pure evaluator: advisory notes surface as warnings on a READY result");

  // ================= N · unknown official source → never PASS =========
  console.log("\n== N · official-source gaps can never become PASS ==");
  // The gates module records the dirty surface itself: a PASSED result
  // without its COMPLETE official source is not surface-clean.
  const rN = dr.evaluateDrawReadiness(synInput([
    { code: "OFFICIAL_SOURCE_MISSING", detail: "A PASSED result is recorded but no COMPLETE official source record supports it.", blocking: true },
  ], { requirementValue: "REQUIRED", inspectionGate: "PASSED", inspectionSurfaceClean: false }));
  assert(rN.status === "HOLD" && codes(rN).includes("OFFICIAL_SOURCE_MISSING"),
    "a passed inspection without its reviewed official source blocks — retrieval candidates are not authoritative");
  assert(!rN.satisfiedRequirements.some((s) => s.code === "REQUIRED_INSPECTION_PASSED"),
    "no satisfied-requirement claim is emitted while the official source is missing");

  // ================= K · unlabeled bypass refused =====================
  console.log("\n== K · one-click unlabeled bypass refused ==");
  // Complete formal governance on drawB so ONLY the readiness gate stands
  // between the lender and a recorded decision. The standard document
  // checklist is satisfied first — the configured evidence requirement
  // (deliberately) remains outstanding.
  for (const m of draws.missingRequiredDocuments(drawB.id)) {
    draws.recordDocument(dmvPm, drawB.id, {
      requirementId: m.id, lineItemId: null, docType: m.docType,
      title: `${m.title} (fictional)`, note: null, expiresAt: null,
      vendor: null, invoiceNumber: m.docType === "CONTRACTOR_INVOICE" ? "TEST-9001" : null,
      amount: m.docType === "CONTRACTOR_INVOICE" ? 40000 : null,
      waiverKind: /LIEN_WAIVER/.test(m.docType) ? "CONDITIONAL" : null,
      waiverScope: /LIEN_WAIVER/.test(m.docType) ? "PROGRESS" : null,
      coveredThrough: /LIEN_WAIVER/.test(m.docType) ? "2026-09-30" : null,
      issuingAuthority: null, referenceNumber: null, inspectionDate: null, inspectionResult: null,
    });
  }
  const { approvalRequest } = await draws.sendToGovernance(funder, drawB.id, null);
  await draws.processDrawApprovalDecision(approvalRequest.id, "user-funder", "APPROVED");
  await draws.processDrawApprovalDecision(approvalRequest.id, "user-compliance", "APPROVED");
  assert(dr.drawReadiness(drawB.id).status === "HOLD", "drawB still HOLDs on the configured evidence requirement");
  const decisionsBefore = lenderDecisions.listDecisionsForDraw
    ? lenderDecisions.listDecisionsForDraw(drawB.id).length
    : db.prepare("SELECT COUNT(*) c FROM lender_draw_decisions WHERE draw_request_id = ?").get(drawB.id).c;
  let refused = null;
  try {
    dr.recordDecisionWithReadiness(funder, drawB.id, { decision: "APPROVED", approvedAmount: 40000 });
  } catch (e) { refused = e; }
  assert(refused && refused.statusCode === 422, "an APPROVED decision over HOLD without justification is refused 422");
  assert(/justification/i.test(refused.message), "the refusal explains that justification is required");
  const decisionsAfter = db.prepare("SELECT COUNT(*) c FROM lender_draw_decisions WHERE draw_request_id = ?").get(drawB.id).c;
  assert(Number(decisionsAfter) === Number(decisionsBefore), "the refused bypass recorded NO decision");
  assert(dr.readinessSnapshots(drawB.id).length === 0, "the refused bypass persisted NO snapshot");

  // ================= R · FIELD cannot invoke the exception path =======
  console.log("\n== R · FIELD users cannot record a lender exception decision ==");
  for (const [who, label] of [[dmvField, "borrower-org FIELD user"], [foreignField, "foreign-tenant FIELD user"]]) {
    let denied = null;
    try {
      dr.recordDecisionWithReadiness(who, drawB.id, {
        decision: "APPROVED", approvedAmount: 40000,
        exceptionsAccepted: "Attempted field-side override (must be refused).",
      });
    } catch (e) { denied = e; }
    assert(denied && denied.statusCode >= 403 && denied.statusCode <= 404, `${label} is denied (${denied ? denied.statusCode : "??"})`);
  }
  assert(db.prepare("SELECT COUNT(*) c FROM lender_draw_decisions WHERE draw_request_id = ?").get(drawB.id).c === 0,
    "no decision was recorded by either denied attempt");

  // ================= J · authorized, justified override ===============
  console.log("\n== J · authorized proceed-by-exception ==");
  const outcome = dr.recordDecisionWithReadiness(funder, drawB.id, {
    decision: "APPROVED", approvedAmount: 40000,
    exceptionsAccepted: "Roof photos scheduled for tomorrow's site visit; lender accepts the documented evidence gap (fictional test justification).",
  });
  assert(outcome.decision.decision === "APPROVED", "with explicit justification the governed decision records");
  assert(outcome.proceededByException === true, "the outcome is labelled proceed-by-exception — never a silent approval");
  assert(outcome.readinessAtDecision.status === "HOLD", "the readiness state AT DECISION TIME is captured");
  const snaps = dr.readinessSnapshots(drawB.id);
  assert(snaps.length === 1, "exactly one readiness snapshot persisted with the decision");
  const snap = snaps[0].snapshot;
  assert(snap.status === "HOLD" && Array.isArray(snap.overriddenBlockers) && snap.overriddenBlockers.includes("REQUIRED_EVIDENCE_MISSING"),
    "the snapshot records the overridden blockers by code");
  assert(snap.policyVersion === dr.READINESS_POLICY_VERSION && snap.requestedAmount === 40000,
    "the snapshot pins policy version and amounts for later reconstruction");
  assert(snap.decisionId === outcome.decision.id && snaps[0].actorUserId === funder.id,
    "the snapshot is tied to the decision and the acting user");
  // The override never erases the blocker.
  const rAfter = dr.drawReadiness(drawB.id);
  assert(codes(rAfter).includes("REQUIRED_EVIDENCE_MISSING"),
    "AFTER the decision the requirement remains OUTSTANDING — the override erased nothing");
  assert(rAfter.proceededByException && rAfter.proceededByException.decisionId === outcome.decision.id,
    "live readiness shows the permanent lender disposition PROCEEDED BY EXCEPTION alongside the blocker");
  assert(typeof rAfter.proceededByException.justification === "string" && rAfter.proceededByException.justification.length > 0,
    "the disposition carries the recorded justification");

  // ================= O · snapshots never rewritten ====================
  console.log("\n== O · historical snapshot immune to later changes ==");
  const frozen = JSON.stringify(snaps[0].snapshot);
  const rowBefore = db.prepare(
    "SELECT detail FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_SNAPSHOT'"
  ).get(drawB.id).detail;
  // Resolve the underlying requirement — live readiness changes...
  repo.deleteRequirement("evreq-test-roof");
  const rResolved = dr.drawReadiness(drawB.id);
  assert(!codes(rResolved).includes("REQUIRED_EVIDENCE_MISSING"),
    "live readiness reflects the resolved requirement");
  // ...but the decision-time snapshot does not move.
  const snapsAfter = dr.readinessSnapshots(drawB.id);
  assert(JSON.stringify(snapsAfter[0].snapshot) === frozen,
    "the snapshot content is byte-identical after the world changed");
  const rowAfter = db.prepare(
    "SELECT detail FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_SNAPSHOT'"
  ).get(drawB.id).detail;
  assert(rowAfter === rowBefore, "the stored draw_events row is untouched");

  // ================= P · determinism ==================================
  console.log("\n== P · same inputs → identical result ==");
  const inputP = dr.assembleReadinessInput("draw-g4", T0);
  const p1 = dr.evaluateDrawReadiness(inputP);
  const p2 = dr.evaluateDrawReadiness(inputP);
  assert(JSON.stringify(p1) === JSON.stringify(p2), "evaluating the same assembled input twice is byte-identical");
  const p3 = dr.evaluateDrawReadiness(dr.assembleReadinessInput("draw-g4", T0));
  assert(JSON.stringify(p1) === JSON.stringify(p3), "assemble + evaluate with a pinned evaluatedAt reproduces the result");

  // ================= Q · cross-tenant boundaries ======================
  console.log("\n== Q · cross-tenant data cannot read or affect ==");
  const q1 = JSON.stringify(dr.evaluateDrawReadiness(dr.assembleReadinessInput("draw-g2", T0)));
  // A foreign tenant's activity cannot perturb the golden evaluation.
  const foreignDraw = draws.createDraw(foreignPm, {
    projectId: "proj-r47", requestedAmount: 5000,
    periodStart: "2026-09-01", periodEnd: "2026-09-30",
  });
  assert(Boolean(foreignDraw.id), "a foreign tenant records its own draw normally");
  const q2 = JSON.stringify(dr.evaluateDrawReadiness(dr.assembleReadinessInput("draw-g2", T0)));
  assert(q1 === q2, "foreign-tenant records do not change the golden draw's readiness by a single byte");
  let qDenied = null;
  try {
    dr.recordDecisionWithReadiness(foreignPm, "draw-g2", {
      decision: "APPROVED", approvedAmount: 182000, exceptionsAccepted: "cross-tenant attempt",
    });
  } catch (e) { qDenied = e; }
  assert(qDenied && qDenied.statusCode >= 403 && qDenied.statusCode <= 404,
    "a foreign tenant cannot record a decision against the golden draw");

  // ============ transitions: meaningful, deduplicated =================
  console.log("\n== transitions · recorded once per state change, never per read ==");
  const evBefore = repo.listDrawEvents("draw-g5").filter((e) => e.type === "READINESS_TRANSITION").length;
  dr.recordReadinessTransition("draw-g5", funder.id);
  dr.recordReadinessTransition("draw-g5", funder.id);
  const evAfter = repo.listDrawEvents("draw-g5").filter((e) => e.type === "READINESS_TRANSITION").length;
  assert(evAfter === evBefore + 1, "an unchanged state records exactly one transition — repeats are no-ops");
  for (let i = 0; i < 3; i += 1) dr.drawReadiness("draw-g5");
  assert(
    repo.listDrawEvents("draw-g5").filter((e) => e.type === "READINESS_TRANSITION").length === evAfter,
    "reading readiness never writes an event — no audit noise from page views"
  );

  // ============ lender package carries readiness at generation ========
  console.log("\n== package · readiness pinned at generation ==");
  const pkgData = await drawPackage.assembleDrawPackageData(funder, drawB.id);
  const pkg = drawPackage.buildDrawPackageFiles(pkgData);
  const exec = pkg.files[0].data.toString("utf8");
  assert(exec.includes("10. OBV READINESS (AT GENERATION)"), "the executive summary carries the readiness section");
  assert(/not lender approval/.test(exec) && /not a legal conclusion/i.test(exec),
    "the package readiness section repeats the non-approval doctrine");
  const machine = JSON.parse(pkg.files.find((f) => f.name === "draw-summary.json").data.toString("utf8"));
  assert(machine.obvReadiness && machine.obvReadiness.policyVersion === dr.READINESS_POLICY_VERSION,
    "draw-summary.json carries the structured readiness block with its policy version");
  assert(typeof machine.obvReadiness.evaluatedAt === "string" && machine.obvReadiness.supportableAmount === 40000,
    "the machine block pins as-of timestamp and supportable amount");

  // ============ DMV · line eligibility adapted, never recomputed ======
  console.log("\n== DMV · control-record eligibility adapted into readiness ==");
  const dmvCompliance = require(path.join(ROOT, "dist/server/services/dmvCompliance"));
  const pinsBefore = db.prepare("SELECT COUNT(*) c FROM draw_permit_basis_pins WHERE draw_request_id = 'draw-dmv-1'").get().c;
  const rDmv = dr.drawReadiness("draw-dmv-1");
  const pinsAfterRead = db.prepare("SELECT COUNT(*) c FROM draw_permit_basis_pins WHERE draw_request_id = 'draw-dmv-1'").get().c;
  assert(Number(pinsAfterRead) === Number(pinsBefore),
    "live readiness reads the DMV layer WITHOUT pinning a basis — reads never write");
  assert(rDmv.status === "HOLD", "the DMV demo draw holds on its recorded line eligibility");
  for (const code of ["PHOTO_EVIDENCE_MISSING", "INSPECTION_CORRECTION_REQUIRED"]) {
    const b = rDmv.blockingReasons.find((x) => x.code === code);
    assert(b && b.lineItemId, `DMV reason ${code} is adapted verbatim as a line-scoped blocker`);
  }
  assert(rDmv.satisfiedRequirements.some((s) => s.code === "DMV_LINE_ELIGIBLE"),
    "the eligible DMV line surfaces as a satisfied requirement, not silence");
  const dmvHeld = rDmv.lineReadiness.find((l) => l.status === "HOLD" && /inspection requires correction/i.test(l.reason ?? ""));
  assert(Boolean(dmvHeld), "line readiness carries the DMV hold reason on the affected line");
  // Single source of truth: the read-only view and the pinning generator
  // compute IDENTICAL eligibility — same function, one flag.
  const view = dmvCompliance.drawControlRecordView("draw-dmv-1");
  const pinned = dmvCompliance.drawControlRecord(funder, "draw-dmv-1");
  const elig = (rec) => rec.lines.map((l) => `${l.drawLineItemId}:${l.finalEligibilityStatus}:${l.eligibilityReasons.map((r) => r.code).join(",")}`);
  assert(JSON.stringify(elig(view)) === JSON.stringify(elig(pinned)),
    "drawControlRecordView and drawControlRecord agree on every line's eligibility — one source of truth");
  assert(db.prepare("SELECT COUNT(*) c FROM draw_permit_basis_pins WHERE draw_request_id = 'draw-dmv-1'").get().c > 0,
    "the deliberate pin write stays with the consequential generation path only");
  const dmvA = JSON.stringify(dr.evaluateDrawReadiness(dr.assembleReadinessInput("draw-dmv-1", T0)));
  const dmvB = JSON.stringify(dr.evaluateDrawReadiness(dr.assembleReadinessInput("draw-dmv-1", T0)));
  assert(dmvA === dmvB, "readiness over the DMV layer is byte-identical for identical state");

  // ================= HTTP · register, module, language ================
  console.log("\n== HTTP · Draws List, readiness module, §29 language ==");
  server = spawn(process.execPath, [path.join(ROOT, "dist/server/http/server.js")], {
    env: {
      ...process.env, OBV_DATA_DIR: DATA, PORT: String(PORT),
      OBV_BANKING_PROVIDER: "mock", OBV_BANKING_MODE: "demo",
    },
    stdio: "ignore",
  });
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) fail("server did not come up");

  const signIn = async (userId) => {
    const res = await fetch(`${BASE}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }), redirect: "manual",
    });
    return res.headers.get("set-cookie").split(";")[0];
  };
  const funderCookie = await signIn("user-funder");
  const get = async (p, cookie = funderCookie) => {
    const res = await fetch(`${BASE}${p}`, { headers: { cookie } });
    return { status: res.status, html: await res.text() };
  };

  const list = await get("/draws");
  assert(list.status === 200 && list.html.includes('class="page-wrap ws"') && list.html.includes('class="ws-head"'),
    "the Draws List renders on the workstation surface");
  assert(!/class="page-head"/.test(list.html), "the old document-style header is gone from the Draws List");
  for (const kpi of ["Open draws", "Ready for review", "On hold", "Exception review", "Requested (open)", "Supportable (open)"]) {
    assert(list.html.includes(kpi), `KPI rail carries "${kpi}"`);
  }
  for (const col of ["Borrower org", "Supportable", "Readiness", "Primary blocker", "Next action"]) {
    assert(list.html.includes(col), `dense register carries the "${col}" column`);
  }
  assert(list.html.includes('name="readiness"') && list.html.includes("Exception review"),
    "the readiness filter offers All / Ready / Hold / Exception review / Incomplete");

  const ready = await get("/draws?readiness=READY");
  assert(ready.html.includes("/draw/draw-g2") && !ready.html.includes("/draw/draw-g4"),
    "filter READY keeps the ready draw and drops the held draw");
  const hold = await get("/draws?readiness=HOLD");
  assert(hold.html.includes("/draw/draw-g4") && !hold.html.includes("/draw/draw-g2"),
    "filter HOLD keeps the held draw and drops the ready draw");
  const excf = await get("/draws?readiness=EXCEPTION_REVIEW");
  assert(excf.html.includes("/draw/draw-g5"), "filter EXCEPTION REVIEW finds the exception-review draw");

  const pageReady = await get("/draw/draw-g2");
  assert(pageReady.html.includes("OBV Readiness"), "the Draw Review rail leads with the OBV Readiness module");
  assert(pageReady.html.includes("Ready for lender review"), "READY is phrased as ready for lender REVIEW");
  assert((pageReady.html.match(/rd-badge/g) || []).length === 1,
    "one readiness summary — not a wall of per-category cards");
  assert(pageReady.html.includes("not lender approval"),
    "the module states what readiness is NOT (approval, release, legal, payment)");

  const pageHold = await get("/draw/draw-g4");
  assert(pageHold.html.includes("rd-badge") && pageHold.html.includes("HOLD"), "a held draw shows the HOLD badge");
  assert(pageHold.html.includes("Primary reason") && pageHold.html.includes("Next action"),
    "the held draw explains its primary reason and next action");

  const pageExc = await get("/draw/draw-g5");
  assert(pageExc.html.includes("EXCEPTION REVIEW"), "the exception-review draw shows its distinct state");

  const pageOverride = await get(`/draw/${drawB.id}`);
  assert(pageOverride.status === 200 && pageOverride.html.includes("OBV Readiness"),
    "the decided draw still renders its readiness module");
  const act = await get(`/draw/${drawB.id}?tab=activity`);
  assert(act.html.includes("OBV readiness snapshot at lender decision"),
    "the activity feed renders the snapshot as a readable record, not raw JSON");
  assert(act.html.includes("PROCEEDED BY EXCEPTION"),
    "the activity feed permanently shows the PROCEEDED BY EXCEPTION disposition");
  assert(!/&quot;blockingReasons&quot;|"blockingReasons"/.test(act.html),
    "no raw snapshot JSON leaks into the activity feed");

  // §29 — the language the screens must NOT use, and must use.
  const screens = [list.html, pageReady.html, pageHold.html, pageExc.html, pageOverride.html];
  for (const banned of ["Legally compliant", "legally compliant", "Funding approved", "Payment authorized", "payment authorized"]) {
    assert(screens.every((h) => !h.includes(banned)), `no readiness screen says "${banned}"`);
  }
  assert(screens.some((h) => h.includes("OBV Readiness")) && screens.some((h) => h.includes("Ready for lender review")),
    'screens use "OBV Readiness" and "Ready for lender review"');

  // Tenant boundary over HTTP: the foreign PM gets an undisclosing 404.
  const foreignCookie = await signIn("user-pm");
  const foreignView = await get("/draw/draw-g2", foreignCookie);
  assert(foreignView.status === 404, "a foreign tenant receives 404 for the golden draw — existence undisclosed");
  const foreignList = await get("/draws", foreignCookie);
  assert(!foreignList.html.includes("draw-g2"), "the foreign tenant's register contains no golden draws");

  stopServer();
  console.log(`\nDRAW READINESS TESTS PASSED — ${passed} checkpoints.`);
  console.log("DETERMINISTIC. EXPLAINED. NEVER AN APPROVAL.");
}

main().then(
  () => { stopServer(); process.exit(0); },
  (e) => { console.error(e); stopServer(); process.exit(1); }
);
