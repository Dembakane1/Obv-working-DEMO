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
const permitsSvc = require(path.join(ROOT, "dist/server/services/permits"));
const gatesSvc = require(path.join(ROOT, "dist/server/services/completionGates"));
const tlSvc = require(path.join(ROOT, "dist/server/services/timeline"));
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
  // The release-independent draw-review surface. Defaults to the same
  // reasons as eligibility (identical for HELD milestones); a released
  // fixture overrides it with the TRUE surface via over.surfaceReasons.
  surface: {
    milestoneId: "ms-syn", result: "NOT_ELIGIBLE", reasons: over.surfaceReasons ?? reasons,
    permitBlocksDrawReview: over.permitBlocksDrawReview ?? false, permitBlocksGovernance: false,
    codeBasisBlocksDrawReview: false, codeBasisBlocksGovernance: false, computedAt: T0,
  },
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
  assert(g2.satisfiedRequirements.some((s) => s.code === "REQUIRED_INSPECTION_PASSED"),
    "the REQUIRED framing inspection with its passed reviewed chain is an explicit satisfied requirement");
  const rA = dr.evaluateDrawReadiness(synInput([], { requirementValue: "REQUIRED", inspectionGate: "PASSED" }));
  assert(rA.status === "READY" && rA.satisfiedRequirements.some((s) => s.code === "REQUIRED_INSPECTION_PASSED"),
    "all required inspection information reviewed and satisfied → READY");

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
    { code: "PERMIT_NOT_ACTIVE", detail: "Linked permit DCRA-000 is APPLIED — not an active permit. Blocks: governance.", blocking: true },
  ]));
  assert(rE2.status === "HOLD" && rE2.primaryBlocker.category === "PERMIT",
    "a KNOWN non-active permit (APPLIED) where configuration gates it → HOLD");
  // An UNKNOWN-status permit is DIFFERENT: missing information, not a
  // known non-active condition — the gates emit PERMIT_STATUS_UNKNOWN
  // and readiness resolves INCOMPLETE, never a waivable pseudo-HOLD.
  const rE2u = dr.evaluateDrawReadiness(synInput([
    { code: "PERMIT_STATUS_UNKNOWN", detail: "Linked permit DCRA-000 has no established current status. Blocks: governance.", blocking: true },
  ]));
  assert(rE2u.status === "INCOMPLETE" && rE2u.primaryBlocker.code === "PERMIT_STATUS_UNKNOWN",
    "an UNKNOWN-status permit where configuration gates it → INCOMPLETE (missing information, never a known failure)");
  assert(rE2u.primaryBlocker.category === "PERMIT" && rE2u.primaryBlocker.exceptionAllowed === false,
    "PERMIT_STATUS_UNKNOWN stays in the PERMIT category and is never exception-eligible");
  assert(rE2u.categories.find((c) => c.category === "PERMIT").state === "UNKNOWN",
    "the PERMIT category rolls up UNKNOWN, never PASS or HOLD, for an unknown-status permit");
  // Stage semantics are owned by completionGates.reasonBlocksDrawReview:
  // a draw-review-only permit rule arrives with blocking=false (the flag
  // encodes governance) plus permitBlocksDrawReview=true on eligibility.
  const drawReviewPermit = synInput([
    { code: "PERMIT_EXPIRED", detail: "Linked permit DCRA-001 is expired. Blocks: draw review.", blocking: false },
  ]);
  drawReviewPermit.gates[0].gates.eligibility.permitBlocksDrawReview = true;
  drawReviewPermit.gates[0].surface.permitBlocksDrawReview = true;
  const rE4 = dr.evaluateDrawReadiness(drawReviewPermit);
  assert(rE4.status === "HOLD" && codes(rE4).includes("PERMIT_EXPIRED"),
    "a draw-review-only permit gate blocks readiness even though its governance flag is off");
  const rE5 = dr.evaluateDrawReadiness(synInput([
    { code: "INSPECTION_NOT_SCHEDULED", detail: "Required inspection has not been scheduled. Blocks: draw review.", blocking: false },
  ], { requirementValue: "REQUIRED", inspectionGate: "REQUIRED_UNSCHEDULED" }));
  assert(rE5.status === "HOLD" && codes(rE5).includes("INSPECTION_NOT_SCHEDULED"),
    "a draw-review-only inspection gate (emitted non-blocking by the governance flag) still holds lender review");
  // A RELEASED milestone keeps its inspection truth: eligibility
  // short-circuits to release BOOKKEEPING, but the engine evaluates the
  // release-independent SURFACE — a dirty jurisdiction surface BLOCKS a
  // later draw review, and the release-vs-surface note is still warned.
  const released = synInput([
    { code: "TRANCHE_RELEASED", detail: "The tranche was released by completed formal governance (exactly once).", blocking: false },
  ], {
    requirementValue: "REQUIRED", inspectionGate: "FAILED",
    // The exact pair the real gates emit for gate = FAILED
    // (completionGates: INSPECTION_FAILED + REINSPECTION_REQUIRED).
    surfaceReasons: [
      { code: "INSPECTION_FAILED", detail: "Required FINAL inspection FAILED — corrective work and reinspection are required.", blocking: true },
      { code: "REINSPECTION_REQUIRED", detail: "A reinspection must be recorded after the failed result.", blocking: true },
    ],
  });
  released.gates[0].inspectionSurfaceClean = false;
  const rE6 = dr.evaluateDrawReadiness(released);
  assert(rE6.status === "HOLD" && codes(rE6).includes("INSPECTION_FAILED"),
    "release bookkeeping never suppresses jurisdictional truth — the dirty surface BLOCKS the later draw review");
  assert(rE6.warnings.some((w) => w.code === "RELEASED_MILESTONE_SURFACE_NOT_CLEAN"),
    "a released milestone with a dirty inspection surface is surfaced, never silently clean");
  // The P-03 shape at the pure level: RELEASED bookkeeping + an
  // UNDETERMINED requirement on the surface → INCOMPLETE, never READY.
  const releasedUnknown = synInput([
    { code: "TRANCHE_RELEASED", detail: "The tranche was released by completed formal governance (exactly once).", blocking: false },
  ], {
    requirementValue: "UNKNOWN", inspectionGate: "REQUIREMENT_UNKNOWN",
    surfaceReasons: [
      { code: "INSPECTION_REQUIREMENT_UNKNOWN", detail: "Whether a jurisdictional inspection is required has not been determined — UNKNOWN never behaves as NOT REQUIRED.", blocking: false },
    ],
  });
  releasedUnknown.gates[0].inspectionSurfaceClean = false;
  const rE6b = dr.evaluateDrawReadiness(releasedUnknown);
  assert(rE6b.status === "INCOMPLETE" && codes(rE6b).includes("INSPECTION_REQUIREMENT_UNKNOWN"),
    "P-03: an UNDETERMINED requirement on a RELEASED milestone resolves INCOMPLETE — release bookkeeping cannot convert UNKNOWN into READY");
  assert(rE6b.blockingReasons.find((b) => b.code === "INSPECTION_REQUIREMENT_UNKNOWN").exceptionAllowed === false,
    "P-03: the unknown on the released milestone is never exceptionable");
  // Unmapped lines: the jurisdictional surface cannot be evaluated —
  // missing information, never READY and never a vacuous pass.
  const unmapped = synInput([]);
  unmapped.gates = [];
  unmapped.unmappedLineCount = 1;
  const rE7 = dr.evaluateDrawReadiness(unmapped);
  assert(rE7.status === "INCOMPLETE" && codes(rE7).includes("LINE_WITHOUT_MILESTONE"),
    "a line with no milestone mapping alone → INCOMPLETE, never READY");
  const rE7b = rE7.blockingReasons.find((b) => b.code === "LINE_WITHOUT_MILESTONE");
  assert(rE7b.exceptionAllowed === false, "the unmapped-line unknown is never exceptionable");
  // On a DMV project the control record evaluates EVERY line through its
  // own line-scoped requirements — the surface IS evaluated there.
  const unmappedDmv = synInput([]);
  unmappedDmv.gates = [];
  unmappedDmv.unmappedLineCount = 1;
  unmappedDmv.dmv = { disputeHold: { blocked: false, legalHold: false, reasons: [] }, lines: [] };
  assert(!codes(dr.evaluateDrawReadiness(unmappedDmv)).includes("LINE_WITHOUT_MILESTONE"),
    "a DMV-adopting project's lines are evaluated by the control record — no unmapped-line unknown");
  // §8 — UNKNOWN regression contract.
  const rE3 = dr.evaluateDrawReadiness(synInput([
    { code: "INSPECTION_REQUIREMENT_UNKNOWN", detail: "Whether a jurisdictional inspection is required has not been determined — UNKNOWN never behaves as NOT REQUIRED.", blocking: false },
  ], { requirementValue: "UNKNOWN", inspectionGate: "REQUIREMENT_UNKNOWN" }));
  assert(rE3.status === "INCOMPLETE", "INSPECTION_REQUIREMENT_UNKNOWN alone → INCOMPLETE, never READY");
  assert(rE3.categories.find((c) => c.category === "GOVERNMENT_INSPECTION").state === "UNKNOWN",
    "the category rollup shows UNKNOWN, not PASS, for the undetermined requirement");
  assert(!rE3.satisfiedRequirements.some((s) => s.category === "GOVERNMENT_INSPECTION"),
    "UNKNOWN never appears among satisfied requirements");
  const rE3b = rE3.blockingReasons.find((b) => b.code === "INSPECTION_REQUIREMENT_UNKNOWN");
  assert(rE3b && rE3b.exceptionAllowed === false, "the missing-information reason is never exceptionable");
  const rE8 = dr.evaluateDrawReadiness(synInput([
    { code: "INSPECTION_REQUIREMENT_UNKNOWN", detail: "Undetermined on a second milestone.", blocking: false },
    { code: "INSPECTION_FAILED", detail: "Required framing inspection FAILED — reinspection required.", blocking: true },
  ], { requirementValue: "REQUIRED", inspectionGate: "FAILED" }));
  assert(rE8.status === "HOLD", "UNKNOWN + a failed inspection → HOLD (the substantive failure drives the state)");
  assert(codes(rE8).includes("INSPECTION_REQUIREMENT_UNKNOWN") && codes(rE8).includes("INSPECTION_FAILED"),
    "both the unknown and the failed requirement stay visible in blockingReasons");

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
  assert(pageReady.html.includes("Draw control scorecard"), "Draw Review leads with the Draw Control Scorecard");
  assert(pageReady.html.includes("Ready for lender review"), "READY is phrased as ready for lender REVIEW");
  assert((pageReady.html.match(/dr-state-badge/g) || []).length === 1,
    "one readiness summary — not a wall of per-category cards");
  assert(pageReady.html.includes("not lender approval"),
    "the module states what readiness is NOT (approval, release, legal, payment)");

  const pageHold = await get("/draw/draw-g4");
  assert(pageHold.html.includes("dr-state-badge") && pageHold.html.includes("HOLD"), "a held draw shows the HOLD badge");
  assert(pageHold.html.includes("Governed blockers") && pageHold.html.includes("Next action"),
    "the held draw explains its governed blockers and next action");

  const pageExc = await get("/draw/draw-g5");
  assert(pageExc.html.includes("EXCEPTION REVIEW"), "the exception-review draw shows its distinct state");

  const pageOverride = await get(`/draw/${drawB.id}`);
  assert(pageOverride.status === 200 && pageOverride.html.includes("Draw control scorecard"),
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
  assert(screens.some((h) => h.includes("OBV readiness")) && screens.some((h) => h.includes("Ready for lender review")),
    'screens name OBV readiness and phrase READY as "Ready for lender review"');

  // Tenant boundary over HTTP: the foreign PM gets an undisclosing 404.
  const foreignCookie = await signIn("user-pm");
  const foreignView = await get("/draw/draw-g2", foreignCookie);
  assert(foreignView.status === 404, "a foreign tenant receives 404 for the golden draw — existence undisclosed");
  const foreignList = await get("/draws", foreignCookie);
  assert(!foreignList.html.includes("draw-g2"), "the foreign tenant's register contains no golden draws");

  // ============ transitions · REAL governed mutation paths ============
  console.log("\n== transitions · real mutation paths, exact-once events and notifications ==");
  const pmCookie = await signIn("user-dmv-pm");
  const complianceCookie = await signIn("user-compliance");
  const post = async (p, bodyObj, cookie, expect) => {
    const res = await fetch(`${BASE}${p}`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(bodyObj ?? {}),
    });
    const text = await res.text();
    if (expect !== undefined && res.status !== expect) {
      fail(`POST ${p} -> ${res.status} (expected ${expect}): ${text.slice(0, 220)}`);
    }
    try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null }; }
  };
  const transitions = (id) =>
    Number(db.prepare("SELECT COUNT(*) c FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_TRANSITION'").get(id).c);
  const lastTransition = (id) =>
    JSON.parse(db.prepare("SELECT detail FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_TRANSITION' ORDER BY rowid DESC LIMIT 1").get(id).detail);
  // One broadcast row (recipient_user_id IS NULL) per notify invocation.
  const notifCount = (kind) =>
    Number(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type = ? AND recipient_user_id IS NULL").get(kind).c);

  // ---- A · required document: HOLD -> document recorded -> READY ----
  const dA = (await post("/api/draws", {
    projectId: "proj-golden", requestedAmount: 30000, periodStart: "2026-10-01", periodEnd: "2026-10-31",
  }, pmCookie, 201)).json.draw;
  await post(`/api/draws/${dA.id}/lines`, {
    description: "Interior finishes balance (transition test)", milestoneId: "ms-g5",
    scheduledValue: 30000, currentRequested: 30000,
  }, pmCookie, 201);
  await post(`/api/draws/${dA.id}/submit`, {}, pmCookie);
  assert(lastTransition(dA.id).status === "HOLD",
    "A: submitted with required documents outstanding → transition records HOLD");
  const evA = transitions(dA.id);
  // Reviewer records the line so documents are the ONLY remaining blocker.
  const lineA = db.prepare("SELECT id FROM draw_line_items WHERE draw_request_id = ?").get(dA.id).id;
  await post(`/api/draws/${dA.id}/lines/${lineA}/review`, { decision: "SUPPORTED" }, funderCookie);
  assert(lastTransition(dA.id).status === "HOLD", "A: still HOLD while documents are outstanding");
  const reqRowsA = db.prepare("SELECT id, title, doc_type t FROM draw_document_requirements WHERE draw_request_id = ? AND required = 1").all(dA.id);
  const readyBeforeA = notifCount("DRAW_READY_FOR_REVIEW");
  for (const r of reqRowsA) {
    await post(`/api/draws/${dA.id}/documents`, {
      requirementId: r.id, title: `${r.title} (fictional)`, docType: r.t,
      waiverKind: /LIEN_WAIVER/.test(r.t) ? "CONDITIONAL" : null,
      waiverScope: /LIEN_WAIVER/.test(r.t) ? "PROGRESS" : null,
      coveredThrough: /LIEN_WAIVER/.test(r.t) ? "2026-10-31" : null,
      invoiceNumber: r.t === "CONTRACTOR_INVOICE" ? "TT-1001" : null,
      amount: r.t === "CONTRACTOR_INVOICE" ? 30000 : null,
    }, pmCookie, 201);
  }
  assert(lastTransition(dA.id).status === "READY",
    "A: recording the required documents through the normal API flips readiness to READY");
  assert(transitions(dA.id) === evA + 1,
    "A: exactly ONE readiness transition for the whole document sequence (HOLD→HOLD dedup, then HOLD→READY)");
  assert(notifCount("DRAW_READY_FOR_REVIEW") === readyBeforeA + 1,
    "A: exactly ONE ready-for-review notification");

  // ---- E · repeated same-state mutation: no duplicates ----
  const evE = transitions(dA.id);
  await post(`/api/draws/${dA.id}/documents`, {
    requirementId: null, title: "Duplicate supplemental photo log (fictional)", docType: "PROGRESS_PHOTOS",
  }, pmCookie, 201);
  assert(transitions(dA.id) === evE && notifCount("DRAW_READY_FOR_REVIEW") === readyBeforeA + 1,
    "E: a mutation that leaves readiness READY records no transition and no duplicate notification");

  // ---- C · READY draw gains a blocking governed condition -> HOLD ----
  const holdBeforeC = notifCount("DRAW_READINESS_HOLD");
  const excC = (await post("/api/exceptions", {
    projectId: "proj-golden", drawRequestId: dA.id, severity: "HIGH",
    category: "QUALITY", title: "Transition test exception (fictional)",
    description: "Opened against a READY draw to prove the HOLD transition.",
  }, complianceCookie, 201)).json.exception;
  const cT = lastTransition(dA.id);
  assert(cT.status === "EXCEPTION_REVIEW" && cT.from === "READY" && transitions(dA.id) === evE + 1,
    "C: a newly blocking exception on a READY draw records exactly one READY→EXCEPTION_REVIEW transition");
  assert(notifCount("DRAW_READINESS_HOLD") === holdBeforeC + 1,
    "C: exactly one no-longer-ready notification, reusing the configured HOLD policy");
  await post(`/api/exceptions/${excC.id}/acknowledge`, {}, complianceCookie);
  assert(transitions(dA.id) === evE + 1,
    "acknowledging (still open) leaves the state unchanged — no duplicate transition");
  await post(`/api/exceptions/${excC.id}/resolve`, { summary: "Resolved for the transition test." }, complianceCookie);
  assert(lastTransition(dA.id).status === "READY" && transitions(dA.id) === evE + 2,
    "resolving the exception through the exception workflow flips the draw back to READY — one transition");
  assert(notifCount("DRAW_READY_FOR_REVIEW") === readyBeforeA + 2,
    "the return to READY notifies exactly once more");

  // ---- G · INCOMPLETE is never approvable: the bypass is closed ----
  // A draw whose ONLY remaining problem is missing information resolves
  // INCOMPLETE — here through the one shape that can coexist with
  // completed formal governance: a line with no milestone mapping
  // (an undetermined milestone requirement honestly blocks governance
  // itself, so it can never reach the decision ladder). An approving
  // lender decision over INCOMPLETE is refused outright, justified or
  // not: OBV does not have enough governed information to support a
  // readiness conclusion, and missing information cannot be waived into
  // existence. Non-approving dispositions stay with the existing lender
  // workflow.
  const dC = (await post("/api/draws", {
    projectId: "proj-golden", requestedAmount: 15000, periodStart: "2026-11-01", periodEnd: "2026-11-30",
  }, pmCookie, 201)).json.draw;
  await post(`/api/draws/${dC.id}/lines`, {
    description: "Unmapped allowance (incomplete-gate test)",
    scheduledValue: 15000, currentRequested: 15000,
  }, pmCookie, 201);
  await post(`/api/draws/${dC.id}/submit`, {}, pmCookie);
  const lineC = db.prepare("SELECT id FROM draw_line_items WHERE draw_request_id = ?").get(dC.id).id;
  await post(`/api/draws/${dC.id}/lines/${lineC}/review`, { decision: "SUPPORTED" }, funderCookie);
  const reqRowsC = db.prepare("SELECT id, title, doc_type t FROM draw_document_requirements WHERE draw_request_id = ? AND required = 1").all(dC.id);
  for (const r of reqRowsC) {
    await post(`/api/draws/${dC.id}/documents`, {
      requirementId: r.id, title: `${r.title} (fictional)`, docType: r.t,
      waiverKind: /LIEN_WAIVER/.test(r.t) ? "CONDITIONAL" : null,
      waiverScope: /LIEN_WAIVER/.test(r.t) ? "PROGRESS" : null,
      coveredThrough: /LIEN_WAIVER/.test(r.t) ? "2026-11-30" : null,
      invoiceNumber: r.t === "CONTRACTOR_INVOICE" ? "TT-4001" : null,
      amount: r.t === "CONTRACTOR_INVOICE" ? 15000 : null,
    }, pmCookie, 201);
  }
  assert(lastTransition(dC.id).status === "INCOMPLETE",
    "G: every requirement satisfied but a line without milestone mapping → INCOMPLETE, never READY");
  await post(`/api/draws/${dC.id}/governance`, {}, funderCookie, 200);
  const apC = db.prepare("SELECT id FROM approval_requests WHERE draw_request_id = ?").get(dC.id).id;
  await post(`/api/approvals/${apC}/decision`, { decision: "APPROVED" }, funderCookie, 200);
  await post(`/api/approvals/${apC}/decision`, { decision: "APPROVED" }, complianceCookie, 200);
  const decCountC = () => Number(db.prepare("SELECT COUNT(*) c FROM lender_draw_decisions WHERE draw_request_id = ?").get(dC.id).c);
  const snapCountC = () => Number(db.prepare("SELECT COUNT(*) c FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_SNAPSHOT'").get(dC.id).c);
  const bareC = await post(`/api/draws/${dC.id}/lender-decision`, {
    decision: "APPROVED", approvedAmount: 15000,
  }, funderCookie);
  assert(bareC.status === 422 && /INCOMPLETE/.test(JSON.stringify(bareC.json)),
    "G: an authorized APPROVED with NO justification over INCOMPLETE is refused 422");
  assert(decCountC() === 0 && snapCountC() === 0,
    "G: the refusal persisted NO decision and NO snapshot");
  const justifiedC = await post(`/api/draws/${dC.id}/lender-decision`, {
    decision: "APPROVED", approvedAmount: 15000,
    decisionReason: "Attempting to justify past missing information (must be refused).",
    exceptionsAccepted: "Missing milestone mapping accepted by lender (must be refused).",
  }, funderCookie);
  assert(justifiedC.status === 422 && /INCOMPLETE/.test(JSON.stringify(justifiedC.json)) &&
    /enough governed information/i.test(JSON.stringify(justifiedC.json)),
    "G: justification does NOT unlock INCOMPLETE — OBV lacks the governed information to support a conclusion");
  assert(decCountC() === 0 && snapCountC() === 0,
    "G: the justified attempt also persisted NO decision and NO snapshot");
  const rejC = await post(`/api/draws/${dC.id}/lender-decision`, {
    decision: "REJECTED", decisionReason: "Non-approving-path check (fictional).",
  }, funderCookie);
  assert(rejC.status === 409 && !/INCOMPLETE/.test(JSON.stringify(rejC.json)),
    "G: REJECTED is answered by the EXISTING governance truth table — the readiness gate never intercepts non-approving dispositions");
  const pendC = await post(`/api/draws/${dC.id}/lender-decision`, { decision: "PENDING" }, funderCookie, 201);
  assert(pendC.json.proceededByException === false && decCountC() === 1,
    "G: a non-approving PENDING records over INCOMPLETE through the untouched lender workflow");
  const snapRowsC = db.prepare("SELECT detail FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_SNAPSHOT'").all(dC.id);
  assert(snapRowsC.length === 1 && JSON.parse(snapRowsC[0].detail).overriddenBlockers.length === 0,
    "G: the snapshot carries NO overridden blockers — INCOMPLETE is never recorded as PROCEEDED BY EXCEPTION");
  const actC = await get(`/draw/${dC.id}?tab=activity`);
  assert(!actC.html.includes("PROCEEDED BY EXCEPTION"),
    "G: no proceed-by-exception disposition ever appears for the incomplete draw");

  // ---- B · required jurisdictional inspection: HOLD -> PASSED -> READY ----
  const dB = (await post("/api/draws", {
    projectId: "proj-golden", requestedAmount: 20000, periodStart: "2026-11-01", periodEnd: "2026-11-30",
  }, pmCookie, 201)).json.draw;
  await post(`/api/draws/${dB.id}/lines`, {
    description: "Punchlist scope (transition test)", milestoneId: "ms-g6",
    scheduledValue: 20000, currentRequested: 20000,
  }, pmCookie, 201);
  await post(`/api/draws/${dB.id}/submit`, {}, pmCookie);
  const lineB2 = db.prepare("SELECT id FROM draw_line_items WHERE draw_request_id = ?").get(dB.id).id;
  await post(`/api/draws/${dB.id}/lines/${lineB2}/review`, { decision: "SUPPORTED" }, funderCookie);
  const reqRowsB = db.prepare("SELECT id, title, doc_type t FROM draw_document_requirements WHERE draw_request_id = ? AND required = 1").all(dB.id);
  for (const r of reqRowsB) {
    await post(`/api/draws/${dB.id}/documents`, {
      requirementId: r.id, title: `${r.title} (fictional)`, docType: r.t,
      waiverKind: /LIEN_WAIVER/.test(r.t) ? "CONDITIONAL" : null,
      waiverScope: /LIEN_WAIVER/.test(r.t) ? "PROGRESS" : null,
      coveredThrough: /LIEN_WAIVER/.test(r.t) ? "2026-11-30" : null,
      invoiceNumber: r.t === "CONTRACTOR_INVOICE" ? "TT-2001" : null,
      amount: r.t === "CONTRACTOR_INVOICE" ? 20000 : null,
    }, pmCookie, 201);
  }
  // ms-g6 has no recorded determination → missing information, INCOMPLETE.
  assert(lastTransition(dB.id).status === "INCOMPLETE",
    "B: an undetermined inspection requirement resolves INCOMPLETE, never READY");
  // The reviewed determination REQUIRED arrives through the normal API —
  // the milestone-scoped fan-out flips the draw to HOLD.
  await post(`/api/milestones/ms-g6/inspection-requirement`, {
    requirement: "REQUIRED", requirementBasis: "Final completion requires a DC final inspection (fictional test determination).",
    inspectionType: "FINAL", mustPassBeforeGovernance: true,
  }, complianceCookie);
  assert(lastTransition(dB.id).status === "HOLD",
    "B: the REQUIRED determination moves the draw to HOLD via the milestone fan-out");
  const evB2 = transitions(dB.id);
  const readyBeforeB = notifCount("DRAW_READY_FOR_REVIEW");
  const insp = (await post(`/api/milestones/ms-g6/inspections`, {
    inspectionType: "FINAL", jurisdiction: "District of Columbia",
    issuingAuthority: "DC Department of Buildings", inspectionReference: "TT-INS-9001",
  }, complianceCookie, 201)).json.inspection;
  await post(`/api/inspections/${insp.id}/schedule`, { scheduledAt: "2026-11-15" }, complianceCookie);
  await post(`/api/inspections/${insp.id}/complete`, { completedAt: "2026-11-15" }, complianceCookie);
  assert(transitions(dB.id) === evB2,
    "B: scheduling and completion without a result leave HOLD — no transition events");
  await post(`/api/inspections/${insp.id}/result`, {
    result: "PASSED", governmentInspectorName: "Fictional DC inspector",
  }, complianceCookie);
  assert(lastTransition(dB.id).status === "READY" && transitions(dB.id) === evB2 + 1,
    "B: the PASSED recorded result flips the draw to READY — exactly one transition");
  assert(notifCount("DRAW_READY_FOR_REVIEW") === readyBeforeB + 1,
    "B: exactly one ready-for-review notification for the inspection path");

  // ---- G2 · once the missing information is resolved, the normal
  // approval path works with NO justification. ms-g6's requirement is
  // now a reviewed REQUIRED determination with a PASSED inspection
  // (scenario B resolved it through the governed workflow), so a fresh
  // draw billing it reaches READY — and READY needs no exception path.
  const dD = (await post("/api/draws", {
    projectId: "proj-golden", requestedAmount: 12000, periodStart: "2026-12-01", periodEnd: "2026-12-31",
  }, pmCookie, 201)).json.draw;
  await post(`/api/draws/${dD.id}/lines`, {
    description: "Punchlist closeout (resolved-information test)", milestoneId: "ms-g6",
    scheduledValue: 12000, currentRequested: 12000,
  }, pmCookie, 201);
  await post(`/api/draws/${dD.id}/submit`, {}, pmCookie);
  const lineD = db.prepare("SELECT id FROM draw_line_items WHERE draw_request_id = ?").get(dD.id).id;
  await post(`/api/draws/${dD.id}/lines/${lineD}/review`, { decision: "SUPPORTED" }, funderCookie);
  const reqRowsD = db.prepare("SELECT id, title, doc_type t FROM draw_document_requirements WHERE draw_request_id = ? AND required = 1").all(dD.id);
  for (const r of reqRowsD) {
    await post(`/api/draws/${dD.id}/documents`, {
      requirementId: r.id, title: `${r.title} (fictional)`, docType: r.t,
      waiverKind: /LIEN_WAIVER/.test(r.t) ? "CONDITIONAL" : null,
      waiverScope: /LIEN_WAIVER/.test(r.t) ? "PROGRESS" : null,
      coveredThrough: /LIEN_WAIVER/.test(r.t) ? "2026-12-31" : null,
      invoiceNumber: r.t === "CONTRACTOR_INVOICE" ? "TT-5001" : null,
      amount: r.t === "CONTRACTOR_INVOICE" ? 12000 : null,
    }, pmCookie, 201);
  }
  assert(lastTransition(dD.id).status === "READY",
    "G2: with the requirement determined and the inspection passed, the same milestone now yields READY — resolution recomputes, never waives");
  await post(`/api/draws/${dD.id}/governance`, {}, funderCookie, 200);
  const apD = db.prepare("SELECT id FROM approval_requests WHERE draw_request_id = ?").get(dD.id).id;
  await post(`/api/approvals/${apD}/decision`, { decision: "APPROVED" }, funderCookie, 200);
  await post(`/api/approvals/${apD}/decision`, { decision: "APPROVED" }, complianceCookie, 200);
  const decD = await post(`/api/draws/${dD.id}/lender-decision`, {
    decision: "APPROVED", approvedAmount: 12000,
  }, funderCookie, 201);
  assert(decD.json.proceededByException === false && decD.json.readinessAtDecision === "READY",
    "G2: at READY the normal approval path works with no justification and no exception disposition");
  const snapRowsD = db.prepare("SELECT detail FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_SNAPSHOT'").all(dD.id);
  assert(snapRowsD.length === 1 && JSON.parse(snapRowsD[0].detail).overriddenBlockers.length === 0,
    "G2: the decision snapshot records a READY state with no overridden blockers");

  // ---- P · P-03 regression: release bookkeeping never suppresses the
  // jurisdiction surface. A milestone with NO determination is RELEASED
  // through the NORMAL evidence + dual-control workflow; a later draw
  // referencing it must be INCOMPLETE, approving decisions must refuse
  // 422 with or without justification, nothing persists, the release is
  // never rewritten, and governed resolution recomputes readiness. ----
  console.log("\n== P · released-milestone unknown → INCOMPLETE (P-03) ==");
  const msP = "ms-4"; // demo project milestone, HELD, no determination
  const r47pm = foreignCookie;             // user-pm — proj-r47's own PM
  const fieldCookie = await signIn("user-field");
  assert(!db.prepare("SELECT 1 FROM inspection_requirements WHERE milestone_id = ?").get(msP),
    "P/A: the milestone starts with NO inspection-requirement determination");
  const PNG16 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAABWklEQVR4nGNQckyon7f3zm8py4jyaVuvfBYyDMjvW3vmNZemR3rb0iOPmRQd4uvm7rn9S9IivGzqlssMOMQ/CRr45/WuOf2KU8M9rXXJ4UeMCvZxtXN232LAIf5TwjysdMrmSx8F9P1ye1afesmh7pbasvjQQwZc4vJ2sTWzd938IW4WWjJ508UP/Hq+Od2rTr5gwCHOruaa0rzo4IP/crYx1bN23vguZhpSPGnjhfcMOMT5dH2yu1aeeM6m6pLctPDA/X+yNtFVM3dc/8aAQ1zUJLho4obz73h1vLM6Vxx/xqrinNS4YP+9vww4xGWsoypnbL/2VcQ4qHDC+nNvebS9MjuWH3vKwoBDXNkpsWH+vrt/pK0iK6Zvu/pF2CiwoH/d2TfcDDjEtTwz2pcdfcKMEa8MOMRxxjcD3nSAJb4Z8KYDLPHNgD8dYMY3A950gCW+GfCmAyzxDQA/T4QQ0Nni4QAAAABJRU5ErkJggg==";
  const evP = (await post("/api/evidence", {
    milestoneId: msP, photoDataUrl: PNG16,
    latitude: -11.85, longitude: 33.6,
    capturedAt: new Date().toISOString(),
    deviceMetadata: { userAgent: "p03-regression", platform: "test", screen: "1x1", language: "en" },
    isDemoFallback: false,
  }, fieldCookie, 201)).json;
  await post(`/api/approvals/${evP.approvalRequest.id}/decision`, { decision: "APPROVED" }, funderCookie, 200);
  const relP = (await post(`/api/approvals/${evP.approvalRequest.id}/decision`, { decision: "APPROVED" }, complianceCookie, 200)).json;
  assert(relP.released === true &&
    db.prepare("SELECT account_status s FROM milestones WHERE id = ?").get(msP).s === "RELEASED",
    "P/B: the tranche is RELEASED through the normal evidence + dual-control workflow, requirement still undetermined");
  const dP = (await post("/api/draws", {
    projectId: "proj-r47", requestedAmount: 25000, periodStart: "2026-11-01", periodEnd: "2026-11-30",
  }, r47pm, 201)).json.draw;
  await post(`/api/draws/${dP.id}/lines`, {
    description: "Post-release works on the released milestone (P-03)", milestoneId: msP,
    scheduledValue: 50000, currentRequested: 25000,
  }, r47pm, 201);
  await post(`/api/draws/${dP.id}/submit`, {}, r47pm);
  const linePId = db.prepare("SELECT id FROM draw_line_items WHERE draw_request_id = ?").get(dP.id).id;
  await post(`/api/draws/${dP.id}/lines/${linePId}/review`, { decision: "SUPPORTED" }, complianceCookie);
  for (const r of db.prepare("SELECT id, title, doc_type t FROM draw_document_requirements WHERE draw_request_id = ? AND required = 1").all(dP.id)) {
    await post(`/api/draws/${dP.id}/documents`, {
      requirementId: r.id, title: `${r.title} (fictional)`, docType: r.t,
      waiverKind: /LIEN_WAIVER/.test(r.t) ? "CONDITIONAL" : null,
      waiverScope: /LIEN_WAIVER/.test(r.t) ? "PROGRESS" : null,
      coveredThrough: /LIEN_WAIVER/.test(r.t) ? "2026-11-30" : null,
      invoiceNumber: r.t === "CONTRACTOR_INVOICE" ? "P03-1001" : null,
      amount: r.t === "CONTRACTOR_INVOICE" ? 25000 : null,
    }, r47pm, 201);
  }
  assert(lastTransition(dP.id).status === "INCOMPLETE",
    "P/D: the draw on the RELEASED, undetermined milestone is INCOMPLETE — release bookkeeping suppresses nothing");
  // The seeded HIGH field issue blocks governance on the demo project —
  // resolve it through its own workflow first (as the demo story does).
  await post("/api/issues/issue-1/status", { status: "ACKNOWLEDGED" }, r47pm);
  await post("/api/issues/issue-1/status", {
    status: "RESOLVED", resolutionSummary: "Alternate supplier delivered gravel; stockpile replenished (fictional).",
  }, r47pm);
  const govP = await post(`/api/draws/${dP.id}/governance`, {}, funderCookie);
  if (!govP.json?.approvalRequest && !govP.json?.result?.approvalRequest) {
    fail(`P: governance -> ${govP.status}: ${JSON.stringify(govP.json).slice(0, 240)}`);
  }
  const apP = (govP.json.approvalRequest ?? govP.json.result?.approvalRequest).id;
  await post(`/api/approvals/${apP}/decision`, { decision: "APPROVED" }, funderCookie, 200);
  await post(`/api/approvals/${apP}/decision`, { decision: "APPROVED" }, complianceCookie, 200);
  const decCountP = () => Number(db.prepare("SELECT COUNT(*) c FROM lender_draw_decisions WHERE draw_request_id = ?").get(dP.id).c);
  const snapCountP = () => Number(db.prepare("SELECT COUNT(*) c FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_SNAPSHOT'").get(dP.id).c);
  const bareP = await post(`/api/draws/${dP.id}/lender-decision`, {
    decision: "APPROVED", approvedAmount: 25000,
  }, funderCookie);
  assert(bareP.status === 422 && /INSPECTION_REQUIREMENT_UNKNOWN/.test(JSON.stringify(bareP.json)),
    "P/E-F: APPROVED with no justification → 422 naming INSPECTION_REQUIREMENT_UNKNOWN");
  const justP = await post(`/api/draws/${dP.id}/lender-decision`, {
    decision: "APPROVED", approvedAmount: 25000,
    decisionReason: "Attempting to approve past the undetermined requirement (must be refused).",
    exceptionsAccepted: "Unknown accepted (must be refused).",
  }, funderCookie);
  assert(justP.status === 422 && /INCOMPLETE/.test(JSON.stringify(justP.json)),
    "P/G: APPROVED WITH justification → still 422 — missing information cannot be waived into existence");
  assert(decCountP() === 0 && snapCountP() === 0,
    "P/H: the refusals persisted NO lender decision and NO readiness snapshot");
  assert(db.prepare("SELECT account_status s FROM milestones WHERE id = ?").get(msP).s === "RELEASED",
    "P/I: the milestone remains RELEASED — the readiness correction rewrites no release bookkeeping");
  // J. Governed resolution: NOT_REQUIRED → live readiness recomputes READY.
  await post(`/api/milestones/${msP}/inspection-requirement`, {
    requirement: "NOT_REQUIRED",
    requirementBasis: "Stored-materials tranche below the district inspection threshold (fictional reviewed determination).",
  }, complianceCookie, 200);
  const pageJ = await get(`/draw/${dP.id}`);
  assert(pageJ.html.includes("Ready for lender review"),
    "P/J: determining NOT_REQUIRED through the governed API recomputes readiness — the draw can reach READY");
  // K. Separately determine REQUIRED: the outstanding inspection prevents
  // READY under the existing stage rules; a PASSED result clears it.
  await post(`/api/milestones/${msP}/inspection-requirement`, {
    requirement: "REQUIRED",
    requirementBasis: "Re-determined on review: district final inspection applies to this tranche (fictional).",
    inspectionType: "FINAL", mustPassBeforeGovernance: true,
  }, complianceCookie, 200);
  const pageK1 = await get(`/draw/${dP.id}`);
  assert(!pageK1.html.includes("Ready for lender review") && /jurisdictional inspection/i.test(pageK1.html),
    "P/K: re-determined REQUIRED with the inspection outstanding prevents READY — the jurisdictional blocker is the rendered reason");
  const inspP = (await post(`/api/milestones/${msP}/inspections`, {
    inspectionType: "FINAL", jurisdiction: "Central Region",
    issuingAuthority: "District council building office", inspectionReference: "P03-INS-1",
  }, complianceCookie, 201)).json.inspection;
  await post(`/api/inspections/${inspP.id}/schedule`, { scheduledAt: "2026-11-20" }, complianceCookie);
  await post(`/api/inspections/${inspP.id}/complete`, { completedAt: "2026-11-20" }, complianceCookie);
  await post(`/api/inspections/${inspP.id}/result`, {
    result: "PASSED", governmentInspectorName: "Fictional district inspector",
  }, complianceCookie);
  const pageK2 = await get(`/draw/${dP.id}`);
  assert(pageK2.html.includes("Ready for lender review"),
    "P/K: the PASSED result through the normal governed workflow clears readiness");
  const decP = (await post(`/api/draws/${dP.id}/lender-decision`, {
    decision: "APPROVED", approvedAmount: 25000,
  }, funderCookie, 201)).json;
  assert(decP.readinessAtDecision === "READY" && decP.proceededByException === false,
    "P/K: the normal approval then records at READY with no exception disposition");
  // Register borrower-org column: the draw requested by the borrower PM
  // shows the REQUESTING organization, never the project's owning org.
  {
    const regP = await get("/draws");
    const borrowerOrgName = db.prepare(
      "SELECT o.name n FROM draw_requests d JOIN organizations o ON o.id = d.requested_by_organization_id WHERE d.id = ?"
    ).get(dP.id).n;
    assert(regP.html.includes(borrowerOrgName),
      `P: the register's Borrower org column shows the requesting organization (${borrowerOrgName})`);
  }
  // L. Reads write nothing.
  const evCountL = Number(db.prepare("SELECT COUNT(*) c FROM draw_events WHERE type IN ('READINESS_TRANSITION','READINESS_SNAPSHOT')").get().c);
  for (let i = 0; i < 3; i += 1) { await get(`/draw/${dP.id}`); await get("/draws"); }
  assert(Number(db.prepare("SELECT COUNT(*) c FROM draw_events WHERE type IN ('READINESS_TRANSITION','READINESS_SNAPSHOT')").get().c) === evCountL,
    "P/L: repeated page reads create no readiness writes");

  // ---- D · repeated page reads: zero writes ----
  const evD = transitions(dA.id) + transitions(dB.id);
  const allEventsBefore = Number(db.prepare("SELECT COUNT(*) c FROM draw_events WHERE type IN ('READINESS_TRANSITION','READINESS_SNAPSHOT')").get().c);
  for (let i = 0; i < 3; i += 1) {
    await get(`/draw/${dA.id}`);
    await get(`/draw/${dB.id}`);
    await get("/draws");
  }
  assert(transitions(dA.id) + transitions(dB.id) === evD,
    "D: repeated page reads record zero readiness events for the watched draws");
  assert(Number(db.prepare("SELECT COUNT(*) c FROM draw_events WHERE type IN ('READINESS_TRANSITION','READINESS_SNAPSHOT')").get().c) === allEventsBefore,
    "D: repeated page reads write nothing readiness-related anywhere");

  // ---- F · cross-tenant mutation cannot touch another tenant ----
  const evF = transitions(dA.id) + transitions(dB.id);
  const foreignDrawT = (await post("/api/draws", {
    projectId: "proj-r47", requestedAmount: 4000, periodStart: "2026-10-01", periodEnd: "2026-10-31",
  }, foreignCookie, 201)).json.draw;
  await post(`/api/draws/${foreignDrawT.id}/lines`, {
    description: "Foreign tenant line (test)", milestoneId: "ms-3", scheduledValue: 4000, currentRequested: 4000,
  }, foreignCookie, 201);
  await post(`/api/draws/${foreignDrawT.id}/submit`, {}, foreignCookie);
  assert(transitions(dA.id) + transitions(dB.id) === evF,
    "F: a foreign tenant's mutations record no transitions on this tenant's draws");
  const crossAttempt = await post(`/api/draws/${dA.id}/documents`, { title: "cross-tenant doc", docType: "OTHER" }, foreignCookie);
  assert(crossAttempt.status === 404 && transitions(dA.id) + transitions(dB.id) === evF,
    "F: a cross-tenant mutation attempt is refused and records nothing");

  stopServer();

  // ============ S · jurisdictional control hardening ============
  // KNOWN FAILURE → HOLD. MISSING/UNKNOWN GOVERNED INFORMATION →
  // INCOMPLETE, never approvable by exception. Permit amendments block
  // required-inspection scheduling only through a RECORDED jurisdictional
  // determination; resolution never passes an inspection.
  console.log("\n== S · jurisdictional control hardening ==");

  // Shared governed fixture builder: fresh draw on a clean milestone with
  // a full document checklist and completed formal governance, so ONLY
  // the readiness gate stands between the lender and a decision.
  const buildDecisionReadyDraw = async (amount, milestoneId) => {
    const d = draws.createDraw(dmvPm, {
      projectId: "proj-golden", requestedAmount: amount,
      periodStart: "2026-10-01", periodEnd: "2026-10-31",
    });
    draws.addLine(dmvPm, d.id, {
      description: "JCH fixture line", budgetLineId: null, milestoneId,
      changeOrderId: null, exceptionAcknowledged: false,
      scheduledValue: amount + 5000, previouslyPaid: 0, currentRequested: amount,
      materialsStored: null, retainageAmount: null, percentCompleteClaimed: 90,
    });
    await draws.submitDraw(dmvPm, d.id);
    draws.reviewLine(funder, repo.listDrawLines(d.id)[0].id, { decision: "SUPPORTED" });
    for (const m of draws.missingRequiredDocuments(d.id)) {
      draws.recordDocument(dmvPm, d.id, {
        requirementId: m.id, lineItemId: null, docType: m.docType,
        title: `${m.title} (fictional)`, note: null, expiresAt: null,
        vendor: null, invoiceNumber: m.docType === "CONTRACTOR_INVOICE" ? "JCH-1" : null,
        amount: m.docType === "CONTRACTOR_INVOICE" ? amount : null,
        waiverKind: /LIEN_WAIVER/.test(m.docType) ? "CONDITIONAL" : null,
        waiverScope: /LIEN_WAIVER/.test(m.docType) ? "PROGRESS" : null,
        coveredThrough: /LIEN_WAIVER/.test(m.docType) ? "2026-10-31" : null,
        issuingAuthority: null, referenceNumber: null, inspectionDate: null, inspectionResult: null,
      });
    }
    const { approvalRequest } = await draws.sendToGovernance(funder, d.id, null);
    await draws.processDrawApprovalDecision(approvalRequest.id, "user-funder", "APPROVED");
    await draws.processDrawApprovalDecision(approvalRequest.id, "user-compliance", "APPROVED");
    return d;
  };
  const decisionRows = (id) =>
    Number(db.prepare("SELECT COUNT(*) c FROM lender_draw_decisions WHERE draw_request_id = ?").get(id).c);
  const snapshotRows = (id) =>
    Number(db.prepare("SELECT COUNT(*) c FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_SNAPSHOT'").get(id).c);

  // ---- S1 · §23 regression: required permit status UNKNOWN → INCOMPLETE,
  //      non-exceptionable, 422 with AND without justification, nothing
  //      persisted. Everything else on the draw is satisfied.
  const dS1 = await buildDecisionReadyDraw(25_000, "ms-g1");
  const pS1 = permitsSvc.createPermit(compliance, "proj-golden", {
    permitNumber: "JCH-S1", permitType: "BUILDING", status: "UNKNOWN",
  });
  permitsSvc.linkMilestone(compliance, pS1.id, "ms-g1", "S1 fixture");
  gatesSvc.determineInspectionRequirement(compliance, "ms-g1", {
    requirement: "NOT_REQUIRED", requirementBasis: "No inspection for this scope (fixture); permit must be active.",
    permitRequired: true, permitMustBeActiveBeforeDrawReview: true,
  });
  const rS1 = dr.drawReadiness(dS1.id);
  assert(rS1.status === "INCOMPLETE", "S1: required permit with UNKNOWN status → INCOMPLETE (all else satisfied)");
  const bS1 = rS1.blockingReasons.find((b) => b.code === "PERMIT_STATUS_UNKNOWN");
  assert(Boolean(bS1) && bS1.category === "PERMIT" && bS1.exceptionAllowed === false,
    "S1: the blocker is PERMIT_STATUS_UNKNOWN — PERMIT category, never exception-eligible");
  assert(dr.isUnknownInformation("PERMIT_STATUS_UNKNOWN") === true,
    "S1: the central classifier marks PERMIT_STATUS_UNKNOWN as missing information");
  const domS1 = dr.controlDomains(rS1).find((x) => x.domain === "COMPLIANCE");
  assert(domS1.state === "UNKNOWN" && domS1.hasUnknown === true,
    "S1: the Compliance domain reads UNKNOWN with hasUnknown — never healthy");
  for (const justification of [null, "Documented exception: county portal outage (fixture)."]) {
    let refusedS1 = null;
    try {
      dr.recordDecisionWithReadiness(funder, dS1.id, {
        decision: "APPROVED", approvedAmount: 25_000,
        ...(justification ? { exceptionsAccepted: justification } : {}),
      });
    } catch (e) { refusedS1 = e; }
    assert(refusedS1 && refusedS1.statusCode === 422 && /INCOMPLETE/.test(refusedS1.message),
      `S1: APPROVED over the unknown permit is refused 422 ${justification ? "WITH" : "without"} justification`);
  }
  assert(decisionRows(dS1.id) === 0 && snapshotRows(dS1.id) === 0,
    "S1: the refusals persisted ZERO decisions and ZERO snapshots");

  // ---- S2 · §24 regression: KNOWN SUSPENDED permit → HOLD (never
  //      relabelled INCOMPLETE); eligibility follows known-permit policy.
  permitsSvc.updatePermit(compliance, pS1.id, { status: "SUSPENDED", reason: "S2 fixture: county suspension recorded." });
  const rS2 = dr.drawReadiness(dS1.id);
  assert(rS2.status === "HOLD", "S2: a KNOWN suspended permit → HOLD, not INCOMPLETE");
  const bS2 = rS2.blockingReasons.find((b) => b.code === "PERMIT_SUSPENDED");
  assert(Boolean(bS2) && !rS2.blockingReasons.some((b) => b.code === "PERMIT_STATUS_UNKNOWN"),
    "S2: the blocker is PERMIT_SUSPENDED — the unknown-status code never fires for a recorded status");
  assert(bS2.exceptionAllowed === dr.DEFAULT_READINESS_POLICY.exceptionEligible.PERMIT,
    "S2: a known non-active permit keeps the existing known-permit exception policy");
  assert(dr.isUnknownInformation("PERMIT_SUSPENDED") === false && dr.isUnknownInformation("PERMIT_NOT_ACTIVE") === false,
    "S2: known non-active codes are never classified as missing information");

  // ---- S3 · §5 regression: NO PERMIT vs UNKNOWN STATUS are different
  //      facts — a missing required permit is a KNOWN missing control.
  const rS3 = dr.evaluateDrawReadiness(synInput([
    { code: "REQUIRED_PERMIT_MISSING", detail: "A BUILDING permit is required but no permit record is linked. Blocks: governance.", blocking: true },
  ]));
  assert(rS3.status === "HOLD" && rS3.primaryBlocker.code === "REQUIRED_PERMIT_MISSING",
    "S3: a missing required permit is a substantive HOLD — never collapsed into unknown-status");
  assert(dr.isUnknownInformation("REQUIRED_PERMIT_MISSING") === false,
    "S3: REQUIRED_PERMIT_MISSING is a known condition, not missing information");

  // ---- S4 · §22 regression: FULLY SUPPORTED DOLLARS ≠ READY. Active
  //      permit, recorded amendment, recorded BLOCKED scheduling effect.
  // A FRESH milestone fixture: prior scenarios left ms-g6 with a PASSED
  // inspection chain, which would (correctly) make a scheduling
  // constraint moot — S4 needs a not-yet-passed required inspection.
  repo.insertMilestone({
    id: "ms-jch-s4", projectId: "proj-golden", seq: 97, title: "JCH S4 stage",
    requirement: "Fixture stage for the amendment regression.",
    trancheAmount: 0, status: "UNDER_REVIEW", accountStatus: "HELD",
    plannedStart: null, plannedEnd: null, weight: null, spatialLabel: null, archived: false,
  });
  const dS4 = await buildDecisionReadyDraw(71_500, "ms-jch-s4");
  const pS4 = permitsSvc.createPermit(compliance, "proj-golden", {
    permitNumber: "JCH-S4", permitType: "BUILDING", status: "ACTIVE",
  });
  permitsSvc.linkMilestone(compliance, pS4.id, "ms-jch-s4", "S4 fixture");
  gatesSvc.determineInspectionRequirement(compliance, "ms-jch-s4", {
    requirement: "REQUIRED", requirementBasis: "Final inspection required before draw review (fixture).",
    inspectionType: "FINAL", mustPassBeforeDrawReview: true, mustPassBeforeGovernance: false,
    permitRequired: true, permitMustBeActiveBeforeDrawReview: true,
  });
  const amS4 = permitsSvc.recordPermitAmendment(compliance, pS4.id, {
    amendmentReference: "AM-2026-014", description: "Scope revision (fixture)", status: "PENDING", submittedAt: "2026-08-20",
  });
  assert(amS4.inspectionSchedulingEffect === "UNKNOWN",
    "S4: recording an amendment NEVER infers its scheduling effect — it starts UNKNOWN");
  // §25 first — effect UNKNOWN, isolated at the evaluator: INCOMPLETE.
  const rS4u = dr.evaluateDrawReadiness(synInput([
    { code: "AMENDMENT_INSPECTION_EFFECT_UNKNOWN", detail: "Permit JCH-S4 amendment AM-2026-014 is open and whether it prevents the required inspection from being scheduled has not been determined.", blocking: false },
  ], { requirementValue: "REQUIRED", inspectionGate: "REQUIRED_UNSCHEDULED" }));
  assert(rS4u.status === "INCOMPLETE" && rS4u.primaryBlocker.code === "AMENDMENT_INSPECTION_EFFECT_UNKNOWN",
    "S4/§25: an undetermined amendment effect ALONE → INCOMPLETE, never a hold-by-assumption");
  assert(rS4u.primaryBlocker.exceptionAllowed === false &&
    dr.controlDomains(rS4u).find((x) => x.domain === "COMPLIANCE").state === "UNKNOWN",
    "S4/§25: the undetermined effect is non-exceptionable and the Compliance domain reads UNKNOWN");
  // Governed end-to-end: with the required inspection also outstanding,
  // the draw HOLDs and the unknown stays visible + non-waivable (§9).
  const rS4g = dr.drawReadiness(dS4.id);
  assert(rS4g.status === "HOLD" &&
    rS4g.blockingReasons.some((b) => b.code === "AMENDMENT_INSPECTION_EFFECT_UNKNOWN" && !b.exceptionAllowed),
    "S4/§9: beside the substantive inspection blockers the unknown effect stays visible and non-exceptionable");
  let refusedS4 = null;
  try {
    dr.recordDecisionWithReadiness(funder, dS4.id, {
      decision: "APPROVED", approvedAmount: 71_500,
      exceptionsAccepted: "Documented exception attempt over missing information (must be refused).",
    });
  } catch (e) { refusedS4 = e; }
  assert(refusedS4 && refusedS4.statusCode === 422,
    "S4/§9: a justified APPROVED cannot proceed while ANY blocker is missing information — even on a HOLD draw");
  assert(decisionRows(dS4.id) === 0 && snapshotRows(dS4.id) === 0, "S4: nothing persisted by the refusal");
  // Now the recorded jurisdictional determination: scheduling BLOCKED.
  permitsSvc.determineAmendmentInspectionEffect(compliance, amS4.id, {
    effect: "BLOCKED",
    effectBasis: "Recorded jurisdictional determination: required inspections cannot be scheduled while the amendment is open (fixture).",
  });
  const rS4 = dr.drawReadiness(dS4.id);
  assert(rS4.supportableAmount === 71_500 && rS4.unsupportedAmount === 0 &&
    dr.formatSupportCoverage(dr.supportCoverage(rS4)) === "100%",
    "S4/§22: support coverage is exactly 100% — $71,500 of $71,500");
  assert(rS4.status === "HOLD", "S4/§22: 100% supported dollars ≠ READY — the draw HOLDs");
  assert(rS4.primaryBlocker.code === "PERMIT_AMENDMENT_BLOCKS_INSPECTION",
    "S4/§22: the deterministic primary blocker is the amendment scheduling condition");
  assert(rS4.primaryBlocker.category === "GOVERNMENT_INSPECTION",
    "S4: the blocked control is the required inspection — GOVERNMENT_INSPECTION category (permit remains valid)");
  assert(/Resolve the permit amendment, then complete the required inspection/.test(rS4.nextActions[0]),
    "S4/§13: the next action states the true order — resolve the amendment, then the inspection");
  assert(!/contacted|checked with|queried/.test(rS4.primaryBlocker.message),
    "S4: the message never implies OBV itself contacted the county");
  assert(dr.controlDomains(rS4).find((x) => x.domain === "COMPLIANCE").state === "HOLD",
    "S4/§22: Compliance HOLD; the other domains carry no blocker from this condition");

  // ---- S5 · §26 regression: amendment resolves → blocker clears, but
  //      the inspection remains its own governed fact; history immutable.
  dr.recordReadinessTransition(dS4.id, "user-compliance"); // record the HOLD (governed mutation point)
  const transS5Before = db.prepare(
    "SELECT id, detail FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_TRANSITION' ORDER BY rowid"
  ).all(dS4.id).map((r) => `${r.id}:${r.detail}`);
  permitsSvc.updatePermitAmendment(compliance, amS4.id, {
    status: "APPROVED", reason: "County approved the amendment (fixture).",
  });
  const rS5 = dr.drawReadiness(dS4.id);
  assert(!rS5.blockingReasons.some((b) => b.code.startsWith("PERMIT_AMENDMENT") || b.code.startsWith("AMENDMENT_")),
    "S5/§26: resolving the amendment clears the amendment blockers");
  assert(rS5.status === "HOLD" &&
    rS5.blockingReasons.some((b) => ["INSPECTION_NOT_SCHEDULED", "JURISDICTIONAL_INSPECTION_NOT_PASSED"].includes(b.code)),
    "S5/§15: amendment resolution NEVER passes the inspection — the required inspection still gates");
  assert(!rS5.satisfiedRequirements.some((s) => s.code === "REQUIRED_INSPECTION_PASSED"),
    "S5: no satisfied-inspection claim appears from an amendment approval");
  const inspS5 = gatesSvc.createInspection(compliance, "ms-jch-s4", { inspectionType: "FINAL", permitRefId: pS4.id });
  gatesSvc.scheduleInspection(compliance, inspS5.id, "2026-10-10T10:00:00Z");
  gatesSvc.recordInspectionResult(compliance, inspS5.id, { result: "PASSED", resultRecordedAt: "2026-10-10T15:00:00Z" });
  assert(dr.drawReadiness(dS4.id).status === "READY",
    "S5/§26: after the REAL inspection passes through the normal API, readiness recomputes READY");
  const transS5After = db.prepare(
    "SELECT id, detail FROM draw_events WHERE draw_request_id = ? AND type = 'READINESS_TRANSITION' ORDER BY rowid"
  ).all(dS4.id).map((r) => `${r.id}:${r.detail}`);
  assert(transS5Before.every((row, i) => transS5After[i] === row),
    "S5/§16: no historical READINESS_TRANSITION row was rewritten by the amendment change");

  // ---- S6 · §27 regression: each project's recorded governing basis is
  //      preserved; editing the newer basis never rewrites the older one.
  const pS6a = permitsSvc.createPermit(compliance, "proj-golden", {
    permitNumber: "JCH-S6A", permitType: "BUILDING", status: "ACTIVE", jurisdiction: "Test County",
  });
  const pS6b = permitsSvc.createPermit(compliance, "proj-dmv", {
    permitNumber: "JCH-S6B", permitType: "BUILDING", status: "ACTIVE", jurisdiction: "Test County",
  });
  permitsSvc.recordCodeBasis(compliance, pS6a.id, {
    applicableCodeEdition: "2015 Building Code",
    codeEffectiveDate: "2016-01-01",
    codeBasis: "Reviewer determination: plan accepted before the newer edition's effective date — project remains under the prior rule (fixture).",
  });
  permitsSvc.recordCodeBasis(compliance, pS6b.id, {
    applicableCodeEdition: "2021 Building Code",
    codeEffectiveDate: "2022-07-01",
    codeBasis: "Reviewer determination: plan accepted under the current edition (fixture).",
  });
  const aBefore = repo.getPermit(pS6a.id);
  permitsSvc.recordCodeBasis(compliance, pS6b.id, {
    applicableCodeEdition: "2024 Building Code",
    codeEffectiveDate: "2025-01-01",
    codeBasis: "Newer rule recorded for project B (fixture).",
    reason: "Jurisdiction adopted a newer edition (fixture).",
  });
  const aAfter = repo.getPermit(pS6a.id);
  assert(
    aAfter.applicableCodeEdition === "2015 Building Code" &&
      aAfter.codeBasis === aBefore.codeBasis &&
      aAfter.codeDeterminedAt === aBefore.codeDeterminedAt &&
      aAfter.codeDeterminedBy === aBefore.codeDeterminedBy,
    "S6/§27: project A's recorded governing basis (incl. provenance) survives project B's newer-rule update"
  );
  assert(repo.getPermit(pS6b.id).applicableCodeEdition === "2024 Building Code",
    "S6: project B carries its own updated recorded basis");
  assert(/prior rule/.test(aAfter.codeBasis),
    "S6/§17: the transition/grandfather determination is expressible in the existing codeBasis field");
  const s6Audit = db.prepare(
    "SELECT COUNT(*) c FROM config_audit WHERE action = 'CODE_BASIS_RECORDED' AND entity_id = ?"
  ).get(pS6b.id).c;
  assert(Number(s6Audit) === 2, "S6: every basis determination is a separate attributable audit entry");

  // ---- S7 · §28 exception matrix: every jurisdiction-related readiness
  //      reason, isolated. FORBIDDEN: missing-information classification
  //      with exceptionAllowed=true.
  const MATRIX = [
    // [code, blockingFlag, expected isolated status, expected unknown-info]
    ["REQUIRED_PERMIT_MISSING", true, "HOLD", false],
    ["PERMIT_EXPIRED", true, "HOLD", false],
    ["PERMIT_REVOKED", true, "HOLD", false],
    ["PERMIT_SUSPENDED", true, "HOLD", false],
    ["PERMIT_NOT_ACTIVE", true, "HOLD", false],
    ["PERMIT_STATUS_UNKNOWN", true, "INCOMPLETE", true],
    ["CODE_BASIS_MISSING", true, "HOLD", false],
    ["OFFICIAL_SOURCE_MISSING", true, "HOLD", false],
    ["INSPECTION_NOT_SCHEDULED", true, "HOLD", false],
    ["INSPECTION_PENDING", true, "HOLD", false],
    ["INSPECTION_FAILED", true, "HOLD", false],
    ["REINSPECTION_REQUIRED", true, "HOLD", false],
    ["REINSPECTION_FAILED", true, "HOLD", false],
    ["REINSPECTION_PENDING", true, "HOLD", false],
    ["REINSPECTION_NOT_SCHEDULED", true, "HOLD", false],
    ["INSPECTION_CORRECTIONS_REQUIRED", true, "HOLD", false],
    ["INSPECTION_EXPIRED", true, "HOLD", false],
    ["JURISDICTIONAL_INSPECTION_NOT_PASSED", true, "HOLD", false],
    ["INSPECTION_REQUIREMENT_UNKNOWN", false, "INCOMPLETE", true],
    ["PERMIT_AMENDMENT_BLOCKS_INSPECTION", true, "HOLD", false],
    ["AMENDMENT_INSPECTION_EFFECT_UNKNOWN", false, "INCOMPLETE", true],
  ];
  console.log("  code · known/unknown · isolated · exceptionAllowed");
  for (const [code, blockingFlag, expectedStatus, expectedUnknown] of MATRIX) {
    const over = expectedUnknown && code !== "PERMIT_STATUS_UNKNOWN"
      ? { requirementValue: code === "INSPECTION_REQUIREMENT_UNKNOWN" ? "UNKNOWN" : "REQUIRED",
          inspectionGate: code === "INSPECTION_REQUIREMENT_UNKNOWN" ? "REQUIREMENT_UNKNOWN" : "REQUIRED_UNSCHEDULED" }
      : {};
    const rM = dr.evaluateDrawReadiness(synInput([
      { code, detail: `${code} (matrix fixture). Blocks: governance.`, blocking: blockingFlag },
    ], over));
    const bM = rM.blockingReasons.find((b) => b.code === code);
    if (!bM) fail(`matrix: ${code} did not surface as a blocker`);
    if (rM.status !== expectedStatus) fail(`matrix: ${code} isolated → ${rM.status}, expected ${expectedStatus}`);
    if (dr.isUnknownInformation(code) !== expectedUnknown) {
      fail(`matrix: ${code} unknown-info classification mismatch`);
    }
    // THE FORBIDDEN COMBINATION: missing information + exceptionAllowed.
    if (dr.isUnknownInformation(code) && bM.exceptionAllowed) {
      fail(`matrix FORBIDDEN: ${code} is missing information yet exceptionAllowed=true`);
    }
    console.log(`    ${code} · ${expectedUnknown ? "UNKNOWN-INFO" : "known"} · ${rM.status} · exceptionAllowed=${bM.exceptionAllowed}`);
  }
  pass("S7/§28: full jurisdiction reason matrix — no missing-information reason is ever exception-eligible");
  assert([...["DRAW_IN_DRAFT","DRAW_CANCELLED","NO_LINE_ITEMS","DRAW_STRUCTURE_INCOMPLETE","INSPECTION_REQUIREMENT_UNKNOWN","LINE_WITHOUT_MILESTONE","PERMIT_STATUS_UNKNOWN","AMENDMENT_INSPECTION_EFFECT_UNKNOWN"]]
    .every((c) => dr.isUnknownInformation(c)),
    "S7: the central unknown-information set carries every unknown code exactly once — one classifier, no side lists");

  // ---- S8 · §31 adversarial: tenancy, read-only, roles ----------------
  const foreignFunderS8 = repo.getUser("user-funder") && repo.getUser("user-pm"); // org-crra
  let deniedS8 = null;
  try { permitsSvc.recordPermitAmendment(repo.getUser("user-pm"), pS4.id, { amendmentReference: "X-1" }); }
  catch (e) { deniedS8 = e; }
  assert(deniedS8 && deniedS8.statusCode === 404,
    "S8/G: a foreign tenant recording an amendment on this tenant's permit gets the same 404");
  deniedS8 = null;
  try { permitsSvc.getAmendmentFor(repo.getUser("user-pm"), amS4.id); } catch (e) { deniedS8 = e; }
  assert(deniedS8 && deniedS8.statusCode === 404, "S8/G: a foreign tenant cannot read the amendment (same 404)");
  deniedS8 = null;
  try {
    permitsSvc.determineAmendmentInspectionEffect(dmvPm, amS4.id, { effect: "ALLOWED", effectBasis: "PM attempt (must be refused)." });
  } catch (e) { deniedS8 = e; }
  assert(deniedS8 && deniedS8.statusCode === 403,
    "S8: a project manager cannot determine the inspection-scheduling effect (lender-side determination)");
  deniedS8 = null;
  try { permitsSvc.recordPermitAmendment(dmvPm, pS4.id, { amendmentReference: "X-2", status: "APPROVED" }); }
  catch (e) { deniedS8 = e; }
  assert(deniedS8 && deniedS8.statusCode === 403,
    "S8: a project manager may record PENDING only — formal amendment states are lender-side");
  const rowsBeforeS8 = JSON.stringify(db.prepare("SELECT * FROM permit_amendments ORDER BY id").all());
  dr.drawReadiness(dS4.id);
  gatesSvc.drawReviewSurface("ms-g6");
  tlSvc.projectTimeline(funder, "proj-golden");
  assert(JSON.stringify(db.prepare("SELECT * FROM permit_amendments ORDER BY id").all()) === rowsBeforeS8,
    "S8/H: readiness, gate and timeline READS leave every amendment row byte-identical");

  // ---- S9 · §19 timeline integration: non-spatial governed events,
  // every one derived from the amendment's IMMUTABLE audit records ------
  const tlS9 = tlSvc.projectTimeline(funder, "proj-golden");
  const amEvents = tlS9.events.filter((e) => /AM-2026-014/.test(e.title));
  assert(amEvents.some((e) => e.type === "PERMIT_AMENDMENT_RECORDED") &&
    amEvents.some((e) => e.type === "AMENDMENT_EFFECT_DETERMINED") &&
    amEvents.some((e) => e.type === "PERMIT_AMENDMENT_RESOLVED"),
    "S9: the amendment lifecycle appears on the governed timeline");
  assert(amEvents.length > 0 && amEvents.every((e) => e.sourceTable === "config_audit"),
    "S9: every amendment history event cites an immutable audit record, never the mutable row");
  assert(amEvents.every((e) => e.spatial === null),
    "S9: amendment events are NON-SPATIAL — no invented coordinates");
  assert(amEvents.every((e) => e.truthClass === "GOVERNED_FACT" || e.truthClass === "HISTORICAL_EVENT"),
    "S9: amendment events carry the central truth classification, never advisory");
  void drawPackage; void foreignFunderS8;

  // ---- S10 · historical truth: the timeline narrates each amendment
  // event from the immutable record written AT THAT MOMENT — later
  // lifecycle changes never rewrite what an earlier event says ----------
  const amHist = permitsSvc.recordPermitAmendment(funder, pS4.id, {
    amendmentReference: "AM-HIST-1", description: "History regression (fixture)",
  });
  permitsSvc.determineAmendmentInspectionEffect(funder, amHist.id, {
    effect: "BLOCKED", effectBasis: "Initial recorded jurisdictional determination (fixture).",
  });
  const tlAfterBlocked = tlSvc.projectTimeline(funder, "proj-golden");
  const blockedEvent = tlAfterBlocked.events.find(
    (e) => e.type === "AMENDMENT_EFFECT_DETERMINED" && /AM-HIST-1/.test(e.title)
  );
  assert(blockedEvent && /BLOCKED/.test(blockedEvent.change?.current ?? "") && blockedEvent.severity === "MEDIUM",
    "S10: the first determination appears as its own BLOCKED event");
  const blockedFrozen = JSON.stringify(blockedEvent);
  permitsSvc.determineAmendmentInspectionEffect(funder, amHist.id, {
    effect: "ALLOWED", effectBasis: "Jurisdiction confirmed scheduling may proceed (fixture).",
    reason: "Recorded determination superseded by the authority's confirmation (fixture).",
  });
  const tlAfterAllowed = tlSvc.projectTimeline(funder, "proj-golden");
  const detEvents = tlAfterAllowed.events.filter(
    (e) => e.type === "AMENDMENT_EFFECT_DETERMINED" && /AM-HIST-1/.test(e.title)
  );
  assert(detEvents.length === 2,
    "S10: BOTH determinations remain on the timeline — a redetermination adds, never replaces");
  assert(detEvents.some((e) => JSON.stringify(e) === blockedFrozen),
    "S10: the original BLOCKED event is byte-identical after the change — history is never rewritten");
  const changedEvent = detEvents.find((e) => /BLOCKED/.test(e.change?.previous ?? "") && /ALLOWED/.test(e.change?.current ?? ""));
  assert(changedEvent && /changed/.test(changedEvent.title),
    "S10: the second event states the real transition BLOCKED → ALLOWED from its own immutable record");
  permitsSvc.updatePermitAmendment(funder, amHist.id, {
    status: "APPROVED", reason: "County approved the amendment (fixture).",
  });
  const tlAfterApproved = tlSvc.projectTimeline(funder, "proj-golden");
  const createdEvent = tlAfterApproved.events.find(
    (e) => e.type === "PERMIT_AMENDMENT_RECORDED" && /AM-HIST-1/.test(e.title)
  );
  assert(createdEvent && /recorded as PENDING/.test(createdEvent.explanation) && !/APPROVED/.test(createdEvent.explanation),
    "S10: after approval, the record-created event STILL says PENDING — the initial status comes from the immutable creation record, never today's row");
  const resolvedEvent = tlAfterApproved.events.find(
    (e) => e.type === "PERMIT_AMENDMENT_RESOLVED" && /AM-HIST-1/.test(e.title)
  );
  assert(resolvedEvent && /PENDING/.test(resolvedEvent.change?.previous ?? "") && /APPROVED/.test(resolvedEvent.change?.current ?? ""),
    "S10: the resolution event carries the real before/after transition");
  // A transition whose prior state is NOT pending: UNKNOWN → WITHDRAWN.
  const amHist2 = permitsSvc.recordPermitAmendment(funder, pS4.id, {
    amendmentReference: "AM-HIST-2", status: "UNKNOWN",
  });
  permitsSvc.updatePermitAmendment(funder, amHist2.id, {
    status: "WITHDRAWN", reason: "Applicant withdrew the amendment (fixture).",
  });
  const resolved2 = tlSvc.projectTimeline(funder, "proj-golden").events.find(
    (e) => e.type === "PERMIT_AMENDMENT_RESOLVED" && /AM-HIST-2/.test(e.title)
  );
  assert(resolved2 && /UNKNOWN/.test(resolved2.change?.previous ?? "") && !/PENDING/.test(resolved2.change?.previous ?? ""),
    "S10: a non-PENDING transition shows its REAL prior state — the timeline never assumes PENDING");

  console.log(`\nDRAW READINESS TESTS PASSED — ${passed} checkpoints.`);
  console.log("DETERMINISTIC. EXPLAINED. NEVER AN APPROVAL.");
}

main().then(
  () => { stopServer(); process.exit(0); },
  (e) => { console.error(e); stopServer(); process.exit(1); }
);
