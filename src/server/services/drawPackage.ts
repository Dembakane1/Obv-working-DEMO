/**
 * Lender Draw Verification Package — one standardized record of a
 * specific draw decision and the evidence supporting it.
 *
 * Doctrine: the package ASSEMBLES authoritative records only — draw
 * lines and their formal reviews, linked governed evidence (never
 * re-verified), the document checklist (upload ≠ acceptance), the
 * exception register, the formal ApprovalRequest history and the
 * VirtualAccountService event stream. Requested, supported, approved,
 * released and retained amounts are computed separately and never
 * merged. Chat participants are never represented as reviewers or
 * approvers; missing data is shown as NOT AVAILABLE, never invented.
 */
import * as repo from "../db/repo";
import * as draws from "./draws";
import { DrawError } from "./draws";
import * as budget from "./budgetProgress";
import { retainageSummary } from "./retainage";
import { wormEvidenceStore } from "./WormEvidenceStore";
import { buildZip, csv, PackageFile } from "./auditPackage";
import { buildLenderDrawFiles } from "./lenderReporting";
import { bankingRegisterFiles } from "./banking/packageRegisters";
import { disputeRegisterFiles } from "./disputeRegisters";
import { createHash } from "node:crypto";
import type {
  ApprovalRecord, ApprovalRequest, DrawAccountEvent, DrawDocument,
  DrawLineItem, DrawRequest, EvidenceItem, LedgerEntry, Milestone,
  ObvException, Project, RetainageEvent, User, Verification,
} from "../../shared/types";
import { slaState, ageDays } from "./exceptions";
import * as completionGates from "./completionGates";
import { effectiveStatus as permitEffectiveStatus } from "./permits";

export const DRAW_PACKAGE_SCHEMA_VERSION = 1;
export const NOT_AVAILABLE = "NOT AVAILABLE";

/** Same institutional-export roles as the Project Audit Package. */
const PACKAGE_ROLES = new Set(["FUNDER_REP", "PROJECT_MANAGER", "COMPLIANCE_REVIEWER"]);

export function canGenerateDrawPackage(user: User, draw: DrawRequest): boolean {
  return PACKAGE_ROLES.has(user.role) && draws.canAccessDraw(user, draw);
}

function assertPackageAccess(user: User, drawId: string): DrawRequest {
  const draw = repo.getDrawRequest(drawId);
  if (!draw || !draws.canAccessDraw(user, draw)) {
    throw new DrawError("Draw request not found", 404);
  }
  if (!PACKAGE_ROLES.has(user.role)) {
    throw new DrawError("Not authorized to generate or download draw verification packages", 403);
  }
  return draw;
}

// ============================================================ amounts

/** Every figure computed independently from its own source records —
 *  requested/supported/approved/released/retained are never merged. */
export interface DrawAmounts {
  currentRequested: number;
  currentSupported: number;
  currentException: number;
  /** Set only once governance concluded (approvedAmount) or the reviewer
   *  finalized a recommendation carried into governance. Null before. */
  grossGoverned: number | null;
  grossGovernedBasis: "APPROVED_BY_GOVERNANCE" | "RECOMMENDED_ADVISORY" | "NOT_FINALIZED";
  retainageWithheld: number | null;
  netReleaseEligible: number | null;
  netReleased: number;
  cumulativeRequested: number;
  cumulativeSupported: number;
  cumulativeApproved: number;
  cumulativeReleased: number;
  remainingAvailableBudget: number;
  /** Which draws the cumulative figures cover (submitted, not cancelled,
   *  drawNumber <= this draw). */
  cumulativeDrawNumbers: number[];
}

function lineSupported(line: DrawLineItem): number {
  switch (line.status) {
    case "SUPPORTED":
      return line.currentRequested;
    case "PARTIALLY_SUPPORTED":
      return line.supportedAmount ?? 0;
    default:
      return 0;
  }
}

export function computeDrawAmounts(draw: DrawRequest): DrawAmounts {
  const lines = repo.listDrawLines(draw.id);
  const currentSupported = lines.reduce((s, l) => s + lineSupported(l), 0);
  const gross = draw.approvedAmount ?? draw.recommendedAmount;
  const netReleased = repo
    .listDrawAccountEvents(draw.id)
    .filter((e) => e.type === "RELEASED")
    .reduce((s, e) => s + e.amount, 0);

  // Cumulative = submitted, non-cancelled draws of this project with
  // drawNumber <= this one (this draw included).
  const cumulativeSet = repo
    .listDrawRequestsForProject(draw.projectId)
    .filter((d) => d.drawNumber <= draw.drawNumber && d.status !== "CANCELLED" && d.submittedAt)
    .sort((a, b) => a.drawNumber - b.drawNumber);
  let cumulativeRequested = 0;
  let cumulativeSupported = 0;
  let cumulativeApproved = 0;
  let cumulativeReleased = 0;
  for (const d of cumulativeSet) {
    cumulativeRequested += d.requestedAmount;
    cumulativeSupported += repo.listDrawLines(d.id).reduce((s, l) => s + lineSupported(l), 0);
    cumulativeApproved += d.approvedAmount ?? 0;
    cumulativeReleased += repo
      .listDrawAccountEvents(d.id)
      .filter((e) => e.type === "RELEASED")
      .reduce((s, e) => s + e.amount, 0);
  }
  const contract = contractContext(draw.projectId);
  return {
    currentRequested: draw.requestedAmount,
    currentSupported,
    currentException: Math.max(0, draw.requestedAmount - currentSupported),
    grossGoverned: gross,
    grossGovernedBasis: draw.approvedAmount !== null
      ? "APPROVED_BY_GOVERNANCE"
      : draw.recommendedAmount !== null
        ? "RECOMMENDED_ADVISORY"
        : "NOT_FINALIZED",
    retainageWithheld: draw.retainageWithheld,
    netReleaseEligible:
      gross !== null ? gross - (draw.retainageWithheld ?? 0) : null,
    netReleased,
    cumulativeRequested,
    cumulativeSupported,
    cumulativeApproved,
    cumulativeReleased,
    remainingAvailableBudget: contract.current - cumulativeApproved,
    cumulativeDrawNumbers: cumulativeSet.map((d) => d.drawNumber),
  };
}

export function contractContext(projectId: string): {
  original: number;
  approvedChanges: number;
  current: number;
} {
  const lines = repo.listBudgetLines(projectId).filter((l) => l.active);
  const project = repo.getProject(projectId);
  const original = lines.length
    ? lines.reduce((s, l) => s + l.originalBudget, 0)
    : project?.totalBudget ?? 0;
  const approvedChanges = lines.reduce((s, l) => s + l.approvedChanges, 0);
  return { original, approvedChanges, current: original + approvedChanges };
}

// ============================================================ registers

export interface BudgetLineRow {
  budgetLineId: string | null;
  code: string;
  description: string;
  originalBudget: number | string;
  approvedChanges: number | string;
  currentBudget: number | string;
  previouslyPaid: number | string;
  currentRequested: number;
  cumulativeRequested: number;
  cumulativeSupported: number;
  balanceToFinish: number | string;
  retainageHeld: number | string;
}

export interface ReviewerRow {
  capacity:
    | "EVIDENCE SUBMITTER" | "FIELD INSPECTOR" | "DOCUMENT REVIEWER"
    | "DRAW LINE REVIEWER" | "DRAW REVIEWER (ADVISORY RECOMMENDATION)"
    | "FORMAL APPROVER";
  userId: string;
  name: string;
  organization: string;
  role: string;
  timestamp: string;
  action: string;
  notes: string;
  linkedRef: string;
}

export interface PermitRow {
  requirementType: string;
  title: string;
  issuingAuthority: string;
  reference: string;
  requiredOptional: "REQUIRED" | "OPTIONAL" | "";
  state: string;
  expiresAt: string;
  inspectionDate: string;
  result: string;
  documentRef: string;
  reviewer: string;
  notes: string;
}

export interface EvidenceRow {
  evidenceId: string;
  project: string;
  milestone: string;
  requirement: string;
  capturedAt: string;
  submittedAt: string;
  uploadedAt: string;
  gpsState: string;
  metadataState: string;
  verdict: string;
  confidence: string;
  provenance: string;
  policyVersion: string;
  ledgerSeq: string;
  evidenceHash: string;
  protectedReference: string;
  linkedLine: string;
}

export interface DrawPackageData {
  draw: DrawRequest;
  project: Project;
  lenderOrg: string;
  borrowerOrg: string;
  configurationVersion: number;
  contract: { original: number; approvedChanges: number; current: number };
  approvedChangeOrders: Array<{ number: number; title: string; status: string; approvedAmount: number | null }>;
  amounts: DrawAmounts;
  lines: DrawLineItem[];
  lineComparisons: Map<string, ReturnType<typeof budget.compareDrawLine>>;
  budgetLines: BudgetLineRow[];
  evidenceRows: EvidenceRow[];
  reviewerRows: ReviewerRow[];
  inspectionRecorded: boolean;
  permitRows: PermitRow[];
  invoiceRows: unknown[][];
  waiverRows: unknown[][];
  missingRequiredWaiver: boolean;
  exceptions: Array<{
    e: ObvException;
    ageDays: number;
    sla: string;
    association: string;
  }>;
  discrepancies: Array<{ kind: string; detail: string; sourceRef: string }>;
  approval: ApprovalRequest | null;
  approvalRecords: ApprovalRecord[];
  /** Six completion gates per milestone referenced by this draw's lines. */
  milestoneGates: Array<{ milestoneLabel: string; gates: import("../../shared/types").MilestoneGates }>;
  /** Permits linked to the draw's milestones + their inspection chains and
   *  official sources (line-scoped; unrelated project permits excluded). */
  permitContext: Array<{
    milestoneLabel: string;
    milestoneId: string;
    permit: import("../../shared/types").Permit;
    effectiveStatus: string;
  }>;
  inspectionHistory: import("../../shared/types").JurisdictionalInspection[];
  officialSources: import("../../shared/types").OfficialSourceRecord[];
  recommendation: ReturnType<typeof draws.computeRecommendation>;
  accountEvents: DrawAccountEvent[];
  retainageEvents: RetainageEvent[];
  retainagePosition: ReturnType<typeof retainageSummary>;
  financialProgress: ReturnType<typeof budget.assessFinancialProgress>;
  physicalProgress: ReturnType<typeof budget.assessPhysicalProgress>;
  ledger: { valid: boolean; entries: number; brokenAt?: number };
  criticalIntegrityFindings: string[];
  generatedAt: string;
  generatedBy: User;
  users: Map<string, User>;
  orgName: (orgId: string | null | undefined) => string;
}

const PERMIT_TYPES = new Set(["PERMIT", "CERTIFICATE", "PROOF_OF_INSURANCE", "INSPECTION_REPORT"]);
const INVOICE_TYPES = new Set(["CONTRACTOR_INVOICE", "MATERIAL_INVOICE", "PAY_APPLICATION"]);
const WAIVER_TYPES = new Set(["LIEN_WAIVER", "CONDITIONAL_LIEN_WAIVER"]);

const na = (v: unknown): string =>
  v === null || v === undefined || v === "" ? NOT_AVAILABLE : String(v);

/** Precise checklist state — upload is NEVER acceptance. */
function preciseState(state: string, required: boolean, docType: string): string {
  switch (state) {
    case "ACCEPTED":
      return "ACCEPTED";
    case "RECEIVED":
      return "RECEIVED — PENDING REVIEW";
    case "REJECTED":
      return "REJECTED";
    case "EXPIRED":
      return "EXPIRED";
    case "MISSING":
      return "MISSING";
    default:
      // Optional requirement with no document on file.
      return docType === "INSPECTION_REPORT" ? "NOT YET RECORDED" : "PENDING";
  }
}

export async function assembleDrawPackageData(user: User, drawId: string): Promise<DrawPackageData> {
  const draw = assertPackageAccess(user, drawId);
  const project = repo.getProject(draw.projectId)!;
  const users = new Map(repo.listUsers().map((u) => [u.id, u]));
  const orgName = (orgId: string | null | undefined): string =>
    orgId ? repo.getOrganization(orgId)?.name ?? orgId : NOT_AVAILABLE;
  const userName = (id: string | null | undefined) => (id ? users.get(id)?.name ?? id : NOT_AVAILABLE);
  const lines = repo.listDrawLines(draw.id);
  const milestones = new Map(repo.listMilestones(project.id).map((m) => [m.id, m]));
  const amounts = computeDrawAmounts(draw);
  const chain = await wormEvidenceStore.verifyChain();

  // ---- budget line rows: every figure from the budget register ----
  const projectDraws = repo
    .listDrawRequestsForProject(project.id)
    .filter((d) => d.drawNumber <= draw.drawNumber && d.status !== "CANCELLED" && d.submittedAt);
  const linesByBudgetRef = new Map<string, DrawLineItem[]>();
  for (const d of projectDraws) {
    for (const l of repo.listDrawLines(d.id)) {
      const key = l.budgetLineId ?? "(unassigned)";
      linesByBudgetRef.set(key, [...(linesByBudgetRef.get(key) ?? []), l]);
    }
  }
  const budgetRefs = [...new Set(lines.map((l) => l.budgetLineId ?? "(unassigned)"))];
  const budgetLines: BudgetLineRow[] = budgetRefs.map((ref) => {
    const bl =
      ref === "(unassigned)"
        ? null
        : repo.findBudgetLineByCode(project.id, ref) ?? repo.getBudgetLine(ref);
    const thisDraw = lines.filter((l) => (l.budgetLineId ?? "(unassigned)") === ref);
    const cumulative = linesByBudgetRef.get(ref) ?? [];
    const currentRequested = thisDraw.reduce((s, l) => s + l.currentRequested, 0);
    const cumulativeRequested = cumulative
      .filter((l) => l.drawRequestId !== draw.id || thisDraw.includes(l))
      .reduce((s, l) => s + l.currentRequested, 0);
    const cumulativeSupportedAmt = cumulative.reduce((s, l) => s + lineSupported(l), 0);
    return {
      budgetLineId: bl?.id ?? null,
      code: bl?.code ?? ref,
      description: bl?.description ?? (ref === "(unassigned)" ? "No budget line reference on the draw line" : NOT_AVAILABLE),
      originalBudget: bl ? bl.originalBudget : NOT_AVAILABLE,
      approvedChanges: bl ? bl.approvedChanges : NOT_AVAILABLE,
      currentBudget: bl ? bl.currentBudget : NOT_AVAILABLE,
      previouslyPaid: bl ? bl.paidToDate : NOT_AVAILABLE,
      currentRequested,
      cumulativeRequested,
      cumulativeSupported: cumulativeSupportedAmt,
      balanceToFinish: bl ? bl.currentBudget - bl.paidToDate - cumulativeRequested : NOT_AVAILABLE,
      retainageHeld: bl?.retainageHeld ?? NOT_AVAILABLE,
    };
  });

  // ---- evidence rows: linked governed evidence, never re-verified ----
  const evidenceRows: EvidenceRow[] = repo.listDrawEvidenceLinks(draw.id).map((link) => {
    const ev = repo.getEvidence(link.evidenceItemId);
    if (!ev) {
      return {
        evidenceId: link.evidenceItemId, project: project.name, milestone: NOT_AVAILABLE,
        requirement: NOT_AVAILABLE, capturedAt: NOT_AVAILABLE, submittedAt: NOT_AVAILABLE,
        uploadedAt: NOT_AVAILABLE, gpsState: NOT_AVAILABLE, metadataState: NOT_AVAILABLE,
        verdict: "EVIDENCE RECORD NOT FOUND", confidence: NOT_AVAILABLE, provenance: NOT_AVAILABLE,
        policyVersion: NOT_AVAILABLE, ledgerSeq: NOT_AVAILABLE, evidenceHash: NOT_AVAILABLE,
        protectedReference: NOT_AVAILABLE, linkedLine: link.lineItemId ?? "",
      };
    }
    const m = milestones.get(ev.milestoneId);
    const v = repo.getVerificationForEvidence(ev.id);
    const entry = repo.getLedgerEntryForEvidence(ev.id);
    const line = link.lineItemId ? lines.find((l) => l.id === link.lineItemId) : null;
    return {
      evidenceId: ev.id,
      project: project.name,
      milestone: m ? `M${m.seq} · ${m.title}` : ev.milestoneId,
      requirement: m?.requirement ?? NOT_AVAILABLE,
      capturedAt: na(ev.capturedAt),
      submittedAt: na(ev.uploadedAt),
      uploadedAt: na(ev.uploadedAt),
      gpsState:
        ev.latitude !== null && ev.longitude !== null
          ? `${ev.latitude},${ev.longitude}`
          : NOT_AVAILABLE,
      metadataState: ev.isDemoFallback ? "DEMO_FALLBACK" : "DEVICE_CAPTURE",
      verdict: v?.verdict ?? "NOT VERIFIED",
      confidence: v ? v.confidence.toFixed(2) : NOT_AVAILABLE,
      provenance: v?.source ?? NOT_AVAILABLE,
      policyVersion: v?.policyVersion != null ? String(v.policyVersion) : NOT_AVAILABLE,
      ledgerSeq: entry ? String(entry.seq) : NOT_AVAILABLE,
      evidenceHash: ev.hash,
      protectedReference: `/evidence/${ev.id}`,
      linkedLine: line ? line.description : "",
    };
  });

  // ---- reviewer register: FORMAL records only, capacities distinct ----
  const reviewerRows: ReviewerRow[] = [];
  const pushReviewer = (
    capacity: ReviewerRow["capacity"],
    userId: string | null,
    timestamp: string | null,
    action: string,
    notes: string | null,
    linkedRef: string
  ) => {
    const u = userId ? users.get(userId) : null;
    reviewerRows.push({
      capacity,
      userId: userId ?? NOT_AVAILABLE,
      name: u?.name ?? (userId ? userId : NOT_AVAILABLE),
      organization: u ? orgName(u.organizationId) : NOT_AVAILABLE,
      role: u?.role ?? NOT_AVAILABLE,
      timestamp: na(timestamp),
      action,
      notes: notes ?? "",
      linkedRef,
    });
  };
  for (const link of repo.listDrawEvidenceLinks(draw.id)) {
    const ev = repo.getEvidence(link.evidenceItemId);
    if (ev) {
      pushReviewer(
        "EVIDENCE SUBMITTER", ev.userId, ev.uploadedAt,
        "Submitted field evidence through the governed capture pipeline",
        null, `evidence ${ev.id}`
      );
    }
  }
  const documents = repo.listDrawDocuments(draw.id);
  let inspectionRecorded = false;
  for (const doc of documents) {
    if (doc.docType === "INSPECTION_REPORT") {
      inspectionRecorded = true;
      pushReviewer(
        "FIELD INSPECTOR", doc.uploadedByUserId, doc.receivedAt,
        `Inspection report recorded: ${doc.title}${doc.inspectionResult ? ` — result ${doc.inspectionResult}` : ""}`,
        doc.note, `document ${doc.id}`
      );
    }
    if (doc.reviewedByUserId) {
      pushReviewer(
        "DOCUMENT REVIEWER", doc.reviewedByUserId, doc.reviewedAt,
        `Document ${doc.status}: ${doc.title}`,
        doc.reviewNote, `document ${doc.id}`
      );
    }
  }
  for (const l of lines) {
    if (l.reviewedByUserId) {
      pushReviewer(
        "DRAW LINE REVIEWER", l.reviewedByUserId, l.reviewedAt,
        `Line "${l.description}" marked ${l.status}${l.supportedAmount != null ? ` ($${l.supportedAmount.toLocaleString("en-US")} supported)` : ""}`,
        l.reviewNotes, `line ${l.id}`
      );
    }
  }
  if (draw.reviewRecommendation) {
    const recEvent = repo
      .listDrawEvents(draw.id)
      .find((e) => e.type === "RECOMMENDATION_FINALIZED");
    pushReviewer(
      "DRAW REVIEWER (ADVISORY RECOMMENDATION)",
      recEvent?.actorUserId ?? null,
      recEvent?.createdAt ?? draw.updatedAt,
      `Recommendation finalized: ${draw.reviewRecommendation.replace(/_/g, " ")} — ADVISORY ONLY, releases nothing`,
      draw.reviewSummary, `draw ${draw.id}`
    );
  }
  const approval = repo.getApprovalRequestForDraw(draw.id);
  const approvalRecords = approval ? repo.listApprovalRecordsForRequest(approval.id) : [];
  for (const rec of approvalRecords) {
    pushReviewer(
      "FORMAL APPROVER", rec.userId, rec.createdAt,
      `Formal governance decision: ${rec.decision} (as ${rec.role})`,
      null, `approval ${rec.approvalRequestId}`
    );
  }

  // ---- permits / government inspections ----
  const checklist = draws.documentChecklist(draw.id);
  const permitChecklist = checklist.filter(
    (row) => row.requirement && PERMIT_TYPES.has(row.requirement.docType)
  );
  const permitRows: PermitRow[] = [];
  for (const row of permitChecklist) {
    const req = row.requirement!;
    const docs = row.documents;
    if (docs.length === 0) {
      permitRows.push({
        requirementType: req.docType, title: req.title,
        issuingAuthority: NOT_AVAILABLE, reference: NOT_AVAILABLE,
        requiredOptional: req.required ? "REQUIRED" : "OPTIONAL",
        state: preciseState(row.state, req.required, req.docType),
        expiresAt: NOT_AVAILABLE, inspectionDate: NOT_AVAILABLE, result: NOT_AVAILABLE,
        documentRef: "NONE ON FILE", reviewer: NOT_AVAILABLE, notes: req.notes ?? "",
      });
    }
    for (const doc of docs) {
      permitRows.push({
        requirementType: req.docType, title: doc.title,
        issuingAuthority: na(doc.issuingAuthority), reference: na(doc.referenceNumber),
        requiredOptional: req.required ? "REQUIRED" : "OPTIONAL",
        state: preciseState(
          doc.status === "RECEIVED" ? "RECEIVED" : doc.status,
          req.required, req.docType
        ),
        expiresAt: na(doc.expiresAt), inspectionDate: na(doc.inspectionDate),
        result: na(doc.inspectionResult), documentRef: doc.id,
        reviewer: doc.reviewedByUserId ? userName(doc.reviewedByUserId) : NOT_AVAILABLE,
        notes: doc.reviewNote ?? doc.note ?? "",
      });
    }
  }
  // Unattached permit-type documents (still authoritative records).
  for (const doc of documents.filter((d) => !d.requirementId && PERMIT_TYPES.has(d.docType))) {
    permitRows.push({
      requirementType: doc.docType, title: doc.title,
      issuingAuthority: na(doc.issuingAuthority), reference: na(doc.referenceNumber),
      requiredOptional: "",
      state: preciseState(doc.status === "RECEIVED" ? "RECEIVED" : doc.status, false, doc.docType),
      expiresAt: na(doc.expiresAt), inspectionDate: na(doc.inspectionDate),
      result: na(doc.inspectionResult), documentRef: doc.id,
      reviewer: doc.reviewedByUserId ? userName(doc.reviewedByUserId) : NOT_AVAILABLE,
      notes: doc.reviewNote ?? doc.note ?? "",
    });
  }
  if (!permitRows.some((r) => r.requirementType === "PERMIT")) {
    permitRows.push({
      requirementType: "PERMIT", title: "Construction / works permit",
      issuingAuthority: "", reference: "", requiredOptional: "",
      state: "NOT REQUIRED under current project configuration",
      expiresAt: "", inspectionDate: "", result: "", documentRef: "",
      reviewer: "", notes: "No permit requirement is configured on this draw's checklist.",
    });
  }
  if (!permitRows.some((r) => r.requirementType === "INSPECTION_REPORT")) {
    permitRows.push({
      requirementType: "INSPECTION_REPORT", title: "Government / engineer inspection",
      issuingAuthority: "", reference: "", requiredOptional: "",
      state: "NOT YET RECORDED",
      expiresAt: "", inspectionDate: "", result: "", documentRef: "",
      reviewer: "", notes: "No inspection requirement configured and no inspection report on file.",
    });
  }

  // ---- invoices & lien waivers (upload remains distinct from acceptance) ----
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const docReviewState = (d: DrawDocument): string =>
    d.status === "RECEIVED" ? "RECEIVED — PENDING REVIEW" : d.status;
  const invoiceRows = documents
    .filter((d) => INVOICE_TYPES.has(d.docType))
    .map((d) => {
      const line = d.lineItemId ? lineById.get(d.lineItemId) : null;
      return [
        d.id, d.docType, na(d.invoiceNumber), na(d.vendor),
        d.amount != null ? d.amount : NOT_AVAILABLE,
        line ? line.description : NOT_AVAILABLE,
        line?.budgetLineId ?? NOT_AVAILABLE,
        d.receivedAt, docReviewState(d), na(d.reviewedAt),
        d.reviewedByUserId ? userName(d.reviewedByUserId) : NOT_AVAILABLE,
        d.status === "REJECTED" ? d.reviewNote ?? "Rejected — no reason recorded" : "",
      ];
    });
  const waiverChecklist = checklist.filter(
    (row) => row.requirement && WAIVER_TYPES.has(row.requirement.docType)
  );
  const waiverRows: unknown[][] = [];
  let missingRequiredWaiver = false;
  for (const row of waiverChecklist) {
    const req = row.requirement!;
    if (row.documents.length === 0) {
      if (req.required && ["MISSING", "REJECTED", "EXPIRED"].includes(row.state)) {
        missingRequiredWaiver = true;
      }
      waiverRows.push([
        "NONE ON FILE", req.docType, req.title,
        req.docType === "CONDITIONAL_LIEN_WAIVER" ? "CONDITIONAL" : NOT_AVAILABLE,
        NOT_AVAILABLE, NOT_AVAILABLE, NOT_AVAILABLE, NOT_AVAILABLE,
        req.required ? "MISSING — REQUIRED" : "MISSING", NOT_AVAILABLE, "",
      ]);
    }
    for (const d of row.documents) {
      if (req.required && ["REJECTED", "EXPIRED"].includes(d.status)) missingRequiredWaiver = true;
      waiverRows.push([
        d.id, d.docType, d.title,
        d.waiverKind ?? (d.docType === "CONDITIONAL_LIEN_WAIVER" ? "CONDITIONAL" : NOT_AVAILABLE),
        na(d.waiverScope),
        d.amount != null ? d.amount : na(d.coveredThrough),
        na(d.expiresAt),
        d.receivedAt,
        docReviewState(d),
        d.reviewedByUserId ? userName(d.reviewedByUserId) : NOT_AVAILABLE,
        d.status === "REJECTED" ? d.reviewNote ?? "Rejected — no reason recorded" : "",
      ]);
    }
  }
  // Unattached waiver documents.
  for (const d of documents.filter((x) => !x.requirementId && WAIVER_TYPES.has(x.docType))) {
    waiverRows.push([
      d.id, d.docType, d.title,
      d.waiverKind ?? (d.docType === "CONDITIONAL_LIEN_WAIVER" ? "CONDITIONAL" : NOT_AVAILABLE),
      na(d.waiverScope), d.amount != null ? d.amount : na(d.coveredThrough),
      na(d.expiresAt), d.receivedAt, docReviewState(d),
      d.reviewedByUserId ? userName(d.reviewedByUserId) : NOT_AVAILABLE,
      d.status === "REJECTED" ? d.reviewNote ?? "" : "",
    ]);
  }

  // ---- exceptions + deduped discrepancy summary ----
  const lineMilestoneIds = new Set(lines.map((l) => l.milestoneId).filter(Boolean) as string[]);
  const lineBudgetIds = new Set(
    lines
      .map((l) => l.budgetLineId && (repo.findBudgetLineByCode(project.id, l.budgetLineId)?.id ?? l.budgetLineId))
      .filter(Boolean) as string[]
  );
  const UNRESOLVED = new Set(["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"]);
  const allExceptions = repo.listExceptionsForProject(project.id);
  const relevant = allExceptions.filter((e) => {
    if (e.drawRequestId === draw.id) return true; // draw-linked: any status
    if (!UNRESOLVED.has(e.status)) return false; // others: unresolved only
    if (e.milestoneId && lineMilestoneIds.has(e.milestoneId)) return true;
    if (e.budgetLineId && lineBudgetIds.has(e.budgetLineId)) return true;
    return e.category === "INTEGRITY";
  });
  const associationOf = (e: ObvException): string => {
    if (e.drawRequestId === draw.id) return `Draw #${draw.drawNumber}`;
    if (e.milestoneId) {
      const m = milestones.get(e.milestoneId);
      return m ? `M${m.seq}` : e.milestoneId;
    }
    if (e.budgetLineId) return `Budget line ${repo.getBudgetLine(e.budgetLineId)?.code ?? e.budgetLineId}`;
    return "Project";
  };
  const exceptions = relevant.map((e) => ({
    e,
    ageDays: ageDays(e),
    sla: slaState(e),
    association: associationOf(e),
  }));

  // Discrepancy summary: each row points at its SOURCE (and the exception
  // covering it, where one exists) — the same underlying condition is
  // never counted as multiple unrelated discrepancies.
  const excBySource = new Map(relevant.map((e) => [`${e.sourceType}:${e.sourceId}`, e]));
  const excRefFor = (sourceType: string, sourceId: string): string => {
    const e = excBySource.get(`${sourceType}:${sourceId}`);
    return e ? `exception ${e.id}` : "no exception record";
  };
  const discrepancies: Array<{ kind: string; detail: string; sourceRef: string }> = [];
  const fin = budget.assessFinancialProgress(project.id);
  const phys = budget.assessPhysicalProgress(project.id);
  if (fin.claimedPct - phys.verifiedPct > 0) {
    discrepancies.push({
      kind: "FINANCIAL vs PHYSICAL",
      detail: `Financial progress ${fin.claimedPct}% vs verified physical progress ${phys.verifiedPct}% — financial progress is ahead of currently verified physical progress.`,
      sourceRef: "budget-vs-progress registers",
    });
  }
  if (amounts.currentException > 0) {
    discrepancies.push({
      kind: "REQUESTED vs SUPPORTED",
      detail: `$${amounts.currentRequested.toLocaleString("en-US")} requested vs $${amounts.currentSupported.toLocaleString("en-US")} supported by review — $${amounts.currentException.toLocaleString("en-US")} exception amount.`,
      sourceRef: "draw line reviews",
    });
  }
  for (const l of lines.filter((x) => ["EXCEPTION", "REJECTED"].includes(x.status))) {
    discrepancies.push({
      kind: "UNSUPPORTED LINE",
      detail: `"${l.description}" is ${l.status} — $${l.currentRequested.toLocaleString("en-US")} requested. ${l.reviewNotes ?? ""}`.trim(),
      sourceRef: excRefFor("DRAW_LINE_ITEM", l.id),
    });
  }
  for (const l of lines.filter((x) => x.changeOrderId)) {
    const co = repo.getChangeOrder(l.changeOrderId!);
    if (co && !["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(co.status)) {
      discrepancies.push({
        kind: "UNAPPROVED CHANGE COST",
        detail: `UNAPPROVED CHANGE COST INCLUDED IN DRAW: "${l.description}" bills against CO-${co.changeOrderNumber} (${co.status.replace(/_/g, " ")}).`,
        sourceRef: excRefFor("DRAW_LINE_ITEM", l.id),
      });
    }
  }
  for (const row of checklist) {
    if (row.requirement?.required && !["ACCEPTED", "RECEIVED"].includes(row.state)) {
      discrepancies.push({
        kind: "MISSING DOCUMENT",
        detail: `Required document ${row.state}: ${row.requirement.title}.`,
        sourceRef: excRefFor("DRAW_DOCUMENT", row.requirement.id),
      });
    }
  }
  for (const issue of repo
    .listFieldIssues()
    .filter(
      (i) =>
        i.projectId === project.id &&
        ["HIGH", "CRITICAL"].includes(i.severity) &&
        !["RESOLVED", "CLOSED"].includes(i.status)
    )) {
    discrepancies.push({
      kind: "OPEN FIELD ISSUE",
      detail: `${issue.severity} field issue "${issue.title}" is ${issue.status.replace(/_/g, " ")}.`,
      sourceRef: excRefFor("FIELD_ISSUE", issue.id),
    });
  }
  for (const mId of lineMilestoneIds) {
    for (const c of repo.listOpenClarificationsForMilestone(mId)) {
      const m = milestones.get(mId);
      discrepancies.push({
        kind: "OPEN CLARIFICATION",
        detail: `Open clarification on ${m ? `M${m.seq}` : mId}: ${c.question}`,
        sourceRef: excRefFor("CLARIFICATION", c.id),
      });
    }
  }
  if (approval && approval.status === "PENDING") {
    discrepancies.push({
      kind: "PENDING APPROVAL",
      detail: `Formal approval request ${approval.id} is PENDING — ${approvalRecords.length} of ${approval.requiredRoles.length} required decisions recorded.`,
      sourceRef: `approval ${approval.id}`,
    });
  }
  const criticalIntegrityFindings: string[] = [];
  if (!chain.valid) {
    const msg = `Evidence Ledger chain broken at entry ${chain.brokenAt}`;
    criticalIntegrityFindings.push(msg);
    discrepancies.push({ kind: "INTEGRITY", detail: msg, sourceRef: "evidence ledger" });
  }

  const approvedCos = repo
    .listChangeOrdersForProject(project.id)
    .filter((c) => ["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(c.status))
    .map((c) => ({
      number: c.changeOrderNumber,
      title: c.title,
      status: c.status,
      approvedAmount: c.approvedAmount ?? c.requestedAmount,
    }));

  return {
    draw,
    project,
    lenderOrg: orgName(draw.organizationId),
    borrowerOrg: orgName(draw.requestedByOrganizationId),
    configurationVersion: project.pilot?.configVersion ?? 1,
    contract: contractContext(project.id),
    approvedChangeOrders: approvedCos,
    amounts,
    lines,
    lineComparisons: new Map(lines.map((l) => [l.id, budget.compareDrawLine(project.id, l)])),
    budgetLines,
    evidenceRows,
    reviewerRows,
    inspectionRecorded,
    permitRows,
    invoiceRows,
    waiverRows,
    missingRequiredWaiver,
    exceptions,
    discrepancies,
    approval,
    approvalRecords,
    permitContext: [...lineMilestoneIds].flatMap((id) => {
      const m = repo.getMilestone(id);
      const label = m ? `M${m.seq} · ${m.title}` : id;
      return repo.listPermitLinksForMilestone(id).flatMap((link) => {
        const permit = repo.getPermit(link.permitId);
        if (!permit) return [];
        return [{ milestoneLabel: label, milestoneId: id, permit, effectiveStatus: permitEffectiveStatus(permit) }];
      });
    }),
    inspectionHistory: [...lineMilestoneIds].flatMap((id) => repo.listInspectionsForMilestone(id)),
    officialSources: [...lineMilestoneIds].flatMap((id) =>
      repo.listInspectionsForMilestone(id).flatMap((i) => repo.listOfficialSourcesForInspection(i.id))
    ),
    milestoneGates: [...lineMilestoneIds].map((id) => {
      const m = milestones.get(id);
      return {
        milestoneLabel: m ? `M${m.seq} · ${m.title}` : id,
        gates: completionGates.milestoneGates(id),
      };
    }),
    recommendation: draws.computeRecommendation(draw.id),
    accountEvents: repo.listDrawAccountEvents(draw.id),
    retainageEvents: repo
      .listRetainageEventsForProject(project.id)
      .filter((e) => e.drawRequestId === draw.id),
    retainagePosition: retainageSummary(project.id),
    financialProgress: fin,
    physicalProgress: phys,
    ledger: { valid: chain.valid, entries: chain.entries, brokenAt: chain.brokenAt },
    criticalIntegrityFindings,
    generatedAt: new Date().toISOString(),
    generatedBy: user,
    users,
    orgName,
  };
}

// ==================================================== register files

/** Structured CSV/JSON records — relative names; callers add a prefix
 *  (standalone ZIP root or the audit package 04_draws/DRAW-nnn/ dir). */
export function buildDrawPackageFiles(d: DrawPackageData): {
  files: PackageFile[];
  counts: Record<string, number>;
} {
  const files: PackageFile[] = [];
  const counts: Record<string, number> = {};
  const add = (name: string, content: string, count?: number) => {
    files.push({ name, data: Buffer.from(content, "utf8") });
    if (count !== undefined) counts[name] = count;
  };
  const a = d.amounts;

  add(
    "draw-summary.json",
    JSON.stringify(
      {
        kind: "OBV_DRAW_VERIFICATION_SUMMARY",
        schemaVersion: DRAW_PACKAGE_SCHEMA_VERSION,
        generatedAt: d.generatedAt,
        generatedBy: { id: d.generatedBy.id, name: d.generatedBy.name, role: d.generatedBy.role },
        project: { id: d.project.id, name: d.project.name },
        draw: {
          id: d.draw.id,
          drawNumber: d.draw.drawNumber,
          status: d.draw.status,
          periodStart: d.draw.periodStart,
          periodEnd: d.draw.periodEnd,
          submittedAt: d.draw.submittedAt,
          requestedBy: d.draw.requestedByUserId,
          borrowerOrganization: d.borrowerOrg,
          lenderOrganization: d.lenderOrg,
        },
        configurationVersion: d.configurationVersion,
        contract: d.contract,
        approvedChangeOrders: d.approvedChangeOrders,
        amounts: {
          // Distinct, labelled figures — never merged.
          currentDrawRequested: a.currentRequested,
          currentDrawSupported: a.currentSupported,
          currentDrawExceptionAmount: a.currentException,
          grossGovernedAmount: a.grossGoverned,
          grossGovernedBasis: a.grossGovernedBasis,
          retainageWithheld: a.retainageWithheld,
          netReleaseEligible: a.netReleaseEligible,
          netReleased: a.netReleased,
          cumulativeRequested: a.cumulativeRequested,
          cumulativeSupported: a.cumulativeSupported,
          cumulativeApproved: a.cumulativeApproved,
          cumulativeReleased: a.cumulativeReleased,
          remainingAvailableBudget: a.remainingAvailableBudget,
          cumulativeDrawNumbers: a.cumulativeDrawNumbers,
        },
        methodology: {
          supported: "Sum of line reviews: SUPPORTED lines at requested value, PARTIALLY_SUPPORTED at the reviewer-recorded supported amount, EXCEPTION/REJECTED/PENDING at zero.",
          cumulative: "Submitted, non-cancelled draws of this project with drawNumber <= this draw, this draw included.",
          grossGoverned: "approvedAmount once governance concluded; otherwise the reviewer-finalized advisory recommendation; NOT_FINALIZED before that.",
          netRelease: "gross governed amount minus retainage withheld; released only by the exactly-once governed transition recorded by the VirtualAccountService.",
          remainingAvailableBudget: "current contract value (original + approved change orders) minus cumulative gross approved.",
          balanceToFinish: "per budget line: current budget - previously paid - cumulative requested (conservative: treats requested as committed).",
        },
        relationships: {
          lineItemIds: d.lines.map((l) => l.id),
          evidenceItemIds: d.evidenceRows.map((r) => r.evidenceId),
          approvalRequestId: d.approval?.id ?? null,
          exceptionIds: d.exceptions.map((x) => x.e.id),
          accountEventIds: d.accountEvents.map((e) => e.id),
          retainageEventIds: d.retainageEvents.map((e) => e.id),
        },
        recommendation: {
          result: d.draw.reviewRecommendation,
          summary: d.draw.reviewSummary,
          advisory: true,
          note: "A reviewer recommendation is ADVISORY — only the formal approval path creates release eligibility.",
        },
        governance: d.approval
          ? { approvalRequestId: d.approval.id, status: d.approval.status, requiredRoles: d.approval.requiredRoles }
          : null,
        ledgerIntegrity: d.ledger.valid ? "INTACT" : `TAMPERED_AT:${d.ledger.brokenAt}`,
        criticalIntegrityFindings: d.criticalIntegrityFindings,
        missingRequiredLienWaiver: d.missingRequiredWaiver,
        inspectionRecorded: d.inspectionRecorded,
        completionGates: d.milestoneGates.map(({ milestoneLabel, gates }) => ({
          milestone: milestoneLabel,
          milestoneId: gates.milestoneId,
          contractorCompletion: gates.contractor.status,
          obvEvidenceReview: gates.evidenceReview.status,
          inspectionRequirement: gates.requirementValue,
          inspectionStatus: gates.inspectionGate,
          drawEligibility: gates.eligibility.result,
          blockingReasonCodes: gates.eligibility.reasons.filter((r) => r.blocking).map((r) => r.code),
        })),
      },
      null,
      2
    )
  );

  add(
    "draw-line-items.csv",
    csv(
      ["lineId", "description", "milestone", "budgetLine", "changeOrder", "scheduledValue", "previouslyPaid", "currentRequested", "claimedPct", "verifiedPct", "reviewStatus", "supportedAmount", "reviewedBy", "reviewedAt", "reviewNotes"],
      d.lines.map((l) => {
        const m = l.milestoneId ? repo.getMilestone(l.milestoneId) : null;
        const co = l.changeOrderId ? repo.getChangeOrder(l.changeOrderId) : null;
        return [
          l.id, l.description, m ? `M${m.seq}` : "", l.budgetLineId ?? "",
          co ? `CO-${co.changeOrderNumber} (${co.status})` : "",
          l.scheduledValue, l.previouslyPaid, l.currentRequested,
          l.percentCompleteClaimed ?? NOT_AVAILABLE,
          l.percentCompleteVerified ?? NOT_AVAILABLE,
          l.status, l.supportedAmount ?? "",
          l.reviewedByUserId ? d.users.get(l.reviewedByUserId)?.name ?? l.reviewedByUserId : NOT_AVAILABLE,
          l.reviewedAt ?? NOT_AVAILABLE, l.reviewNotes ?? "",
        ];
      })
    ),
    d.lines.length
  );

  add(
    "budget-lines.csv",
    csv(
      ["code", "description", "originalBudget", "approvedChanges", "currentBudget", "previouslyPaid", "currentRequested", "cumulativeRequested", "cumulativeSupported", "balanceToFinish", "retainageHeld"],
      d.budgetLines.map((b) => [
        b.code, b.description, b.originalBudget, b.approvedChanges, b.currentBudget,
        b.previouslyPaid, b.currentRequested, b.cumulativeRequested, b.cumulativeSupported,
        b.balanceToFinish, b.retainageHeld,
      ])
    ),
    d.budgetLines.length
  );

  add(
    "budget-vs-progress.csv",
    csv(
      ["metric", "value", "basis"],
      [
        ["financialProgressPct", d.financialProgress.claimedPct, "paid + open draw claims over current budget"],
        ["verifiedPhysicalPct", d.physicalProgress.verifiedPct, d.physicalProgress.methodology],
        ["variancePts", d.financialProgress.claimedPct - d.physicalProgress.verifiedPct, "financial minus verified physical"],
        ...d.lines.map((l) => {
          const cmp = d.lineComparisons.get(l.id);
          return [
            `line:${l.description}`,
            `claimed ${l.percentCompleteClaimed ?? NOT_AVAILABLE}% / verified ${cmp?.verifiedPct ?? l.percentCompleteVerified ?? NOT_AVAILABLE}%`,
            cmp ? `variance ${cmp.variancePts ?? NOT_AVAILABLE} pts (${cmp.varianceState})` : "no verified basis",
          ];
        }),
      ]
    ),
    d.lines.length + 3
  );

  add(
    "evidence-register.csv",
    csv(
      ["evidenceId", "project", "milestone", "requirement", "capturedAt", "submittedAt", "uploadedAt", "gpsState", "metadataState", "verdict", "confidence", "provenance", "policyVersion", "ledgerSeq", "evidenceHash", "protectedReference", "linkedLine"],
      d.evidenceRows.map((r) => [
        r.evidenceId, r.project, r.milestone, r.requirement, r.capturedAt, r.submittedAt,
        r.uploadedAt, r.gpsState, r.metadataState, r.verdict, r.confidence, r.provenance,
        r.policyVersion, r.ledgerSeq, r.evidenceHash, r.protectedReference, r.linkedLine,
      ])
    ),
    d.evidenceRows.length
  );

  add(
    "reviewer-register.csv",
    csv(
      ["capacity", "userId", "name", "organization", "role", "timestamp", "action", "notes", "linkedRef"],
      d.reviewerRows.length
        ? d.reviewerRows.map((r) => [
            r.capacity, r.userId, r.name, r.organization, r.role, r.timestamp, r.action, r.notes, r.linkedRef,
          ])
        : [["NO FORMAL REVIEW RECORDS", "", "", "", "", "", "", "", ""]]
    ),
    d.reviewerRows.length
  );

  add(
    "permit-inspection-register.csv",
    csv(
      ["requirementType", "title", "issuingAuthority", "reference", "requiredOptional", "state", "expiresAt", "inspectionDate", "result", "documentRef", "reviewer", "notes"],
      d.permitRows.map((r) => [
        r.requirementType, r.title, r.issuingAuthority, r.reference, r.requiredOptional,
        r.state, r.expiresAt, r.inspectionDate, r.result, r.documentRef, r.reviewer, r.notes,
      ])
    ),
    d.permitRows.length
  );

  add(
    "invoice-lien-waiver-register.csv",
    csv(
      ["documentId", "docType", "invoiceNumberOrTitle", "vendorOrKind", "amountOrScope", "relatedLineOrCoverage", "budgetLineOrExpiry", "receivedAt", "reviewState", "reviewedAtOrReviewer", "reviewerOrReason", "deficiencyReason"],
      [
        ...d.invoiceRows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11]]),
        ...d.waiverRows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10] ?? ""]),
      ]
    ),
    d.invoiceRows.length + d.waiverRows.length
  );

  add(
    "exception-register.csv",
    csv(
      ["exceptionId", "category", "severity", "status", "sourceType", "sourceId", "association", "title", "owner", "openedAt", "ageDays", "dueAt", "slaState", "resolutionRequirement", "waiverStatus"],
      d.exceptions.map(({ e, ageDays: age, sla, association }) => [
        e.id, e.category, e.severity, e.status, e.sourceType, e.sourceId, association,
        e.title, e.ownerUserId ? d.users.get(e.ownerUserId)?.name ?? e.ownerUserId : "",
        e.openedAt, age, e.dueAt ?? "", sla,
        e.status === "WAIVED" ? "Waived — source condition stands as recorded" : "Source condition must clear before resolution",
        e.status === "WAIVED" ? "WAIVED" : "",
      ])
    ),
    d.exceptions.length
  );

  const approvalRows: unknown[][] = [];
  if (d.approval) {
    d.approvalRecords.forEach((rec, i) => {
      const u = d.users.get(rec.userId);
      approvalRows.push([
        d.approval!.id, "DRAW", d.draw.id, d.approval!.requiredRoles.join("|"),
        `config v${d.configurationVersion}`, i + 1, rec.userId, u?.name ?? rec.userId,
        u ? d.orgName(u.organizationId) : NOT_AVAILABLE, rec.role, rec.decision, rec.createdAt,
        "", d.approval!.status,
        d.amounts.grossGoverned ?? NOT_AVAILABLE,
        d.amounts.netReleased > 0 ? `RELEASED $${d.amounts.netReleased.toLocaleString("en-US")} (net)` : "No release event",
        d.accountEvents.find((e) => e.type === "RELEASED")?.id ?? "",
      ]);
    });
  }
  add(
    "approval-history.csv",
    csv(
      ["approvalRequestId", "subjectType", "subjectId", "requiredRoles", "approvalMatrixVersion", "sequence", "approverUserId", "approverName", "approverOrganization", "role", "decision", "timestamp", "reason", "currentGovernanceState", "governedAmount", "financialConsequence", "releaseEventRef"],
      approvalRows.length
        ? approvalRows
        : [[d.approval?.id ?? "NO APPROVAL REQUEST YET", "DRAW", d.draw.id, d.approval?.requiredRoles.join("|") ?? "", `config v${d.configurationVersion}`, "", "", "", "", "", "", "", "", d.approval?.status ?? "NOT OPENED", "", "No formal decisions recorded", ""]]
    ),
    approvalRows.length
  );

  add(
    "retainage-register.csv",
    csv(
      ["record", "value", "basis"],
      [
        ["drawRetainageRatePct", d.draw.retainageRate ?? NOT_AVAILABLE, "computed at governance finalize from the audited project policy"],
        ["drawRetainageWithheld", d.draw.retainageWithheld ?? NOT_AVAILABLE, "withheld inside the governed draw release, exactly once"],
        ["projectWithheldToDate", d.retainagePosition.withheldToDate, "retainage event stream"],
        ["projectReleasedToDate", d.retainagePosition.releasedToDate, "formal retainage-release approvals only"],
        ["projectRetainageRemaining", d.retainagePosition.remaining, "withheld minus released"],
      ]
    ),
    5
  );

  add(
    "release-events.csv",
    csv(
      ["timestamp", "scope", "type", "amount", "eventId", "note"],
      [
        ...d.accountEvents.map((e) => [
          e.createdAt, "DRAW", e.type, e.amount, e.id,
          e.type === "RELEASED" ? "Exactly-once governed release (net of retainage)" : "Draw reached governance",
        ]),
        ...d.retainageEvents.map((e) => [
          e.createdAt, "RETAINAGE", e.type, e.amount, e.id,
          "Recorded by the VirtualAccountService inside the governed transition",
        ]),
      ]
    ),
    d.accountEvents.length + d.retainageEvents.length
  );

  add(
    "milestone-gates.csv",
    csv(
      [
        "milestone", "contractorCompletion", "contractorReportedAt", "obvEvidenceReview",
        "inspectionRequirement", "requirementBasis", "inspectionStatus", "inspectionScheduledAt",
        "inspectionResult", "resultRecordedBy", "governmentInspector", "drawEligibility", "blockingReasons",
      ],
      d.milestoneGates.map(({ milestoneLabel, gates }) => [
        milestoneLabel,
        gates.contractor.status,
        gates.contractor.reportedAt ?? NOT_AVAILABLE,
        gates.evidenceReview.status,
        gates.requirementValue,
        gates.requirement?.requirementBasis ?? "NOT DETERMINED",
        gates.inspectionGate,
        gates.inspection?.scheduledAt ?? NOT_AVAILABLE,
        gates.inspection?.result ?? NOT_AVAILABLE,
        gates.inspection?.reviewedByUserId
          ? d.users.get(gates.inspection.reviewedByUserId)?.name ?? gates.inspection.reviewedByUserId
          : NOT_AVAILABLE,
        gates.inspection?.governmentInspectorName ?? NOT_AVAILABLE,
        gates.eligibility.result,
        gates.eligibility.reasons.filter((r) => r.blocking).map((r) => r.code).join("|"),
      ])
    ),
    d.milestoneGates.length
  );

  add(
    "permits.csv",
    csv(
      ["milestone", "permitNumber", "permitType", "issuingAuthority", "jurisdiction", "recordedStatus", "effectiveControlStatus", "issuedAt", "expiresAt", "applicableCodeEdition", "codeEffectiveDate", "codeBasis", "officialRecordNumber", "legacyReference"],
      d.permitContext.map((x) => [
        x.milestoneLabel, x.permit.permitNumber, x.permit.permitType,
        x.permit.issuingAuthority ?? NOT_AVAILABLE, x.permit.jurisdiction ?? NOT_AVAILABLE,
        x.permit.status, x.effectiveStatus, x.permit.issuedAt ?? NOT_AVAILABLE,
        x.permit.expiresAt ?? NOT_AVAILABLE, x.permit.applicableCodeEdition ?? "NOT RECORDED",
        x.permit.codeEffectiveDate ?? "", x.permit.codeBasis ?? "NOT RECORDED",
        x.permit.officialRecordNumber ?? "", x.permit.legacyReference ?? "",
      ])
    ),
    d.permitContext.length
  );
  add(
    "permit-milestone-links.csv",
    csv(
      ["permitNumber", "milestone", "effectiveControlStatus"],
      d.permitContext.map((x) => [x.permit.permitNumber, x.milestoneLabel, x.effectiveStatus])
    ),
    d.permitContext.length
  );
  add(
    "inspection-history.csv",
    csv(
      ["inspectionId", "milestoneId", "type", "status", "result", "scheduledAt", "resultRecordedAt", "governmentInspector", "reviewedBy", "reference", "reinspectionOf", "supersededBy", "correctionNotice", "correctionSummary"],
      d.inspectionHistory.map((i) => [
        i.id, i.milestoneId, i.inspectionType ?? "", i.status, i.result ?? NOT_AVAILABLE,
        i.scheduledAt ?? NOT_AVAILABLE, i.resultRecordedAt ?? NOT_AVAILABLE,
        i.governmentInspectorName ?? NOT_AVAILABLE,
        i.reviewedByUserId ? d.users.get(i.reviewedByUserId)?.name ?? i.reviewedByUserId : NOT_AVAILABLE,
        i.inspectionReference ?? "", i.reinspectionOfInspectionId ?? "", i.supersededByInspectionId ?? "",
        i.correctionNoticeReference ?? "", i.correctionSummary ?? "",
      ])
    ),
    d.inspectionHistory.length
  );
  add(
    "official-source-records.csv",
    csv(
      ["sourceType", "officialSystemName", "officialRecordNumber", "officialStatusText", "lookupPerformedAt", "lookupPerformedBy", "capturedAt", "inspectionId", "artifactHash"],
      d.officialSources.map((o) => [
        o.sourceType, o.officialSystemName ?? "", o.officialRecordNumber ?? "",
        o.officialStatusText ?? "", o.lookupPerformedAt ?? "",
        d.users.get(o.lookupPerformedByUserId)?.name ?? o.lookupPerformedByUserId,
        o.capturedAt ?? "", o.inspectionId ?? "", o.sourceArtifactHash ?? "",
      ])
    ),
    d.officialSources.length
  );

  add(
    "integrity-summary.json",
    JSON.stringify(
      {
        checkedAt: d.generatedAt,
        evidenceLedger: {
          state: d.ledger.valid ? "INTACT" : `TAMPERED_AT:${d.ledger.brokenAt}`,
          entries: d.ledger.entries,
        },
        criticalIntegrityFindings: d.criticalIntegrityFindings,
        reconciliation: {
          currentSupportedEqualsLineSum: true,
          note: "All figures computed from source records at generation time; requested, supported, approved, released and retained amounts are independent measurements and are never merged.",
        },
        stateBasis: "GENERATION_TIME — this package reflects draw state when generated; it is a point-in-time record.",
      },
      null,
      2
    )
  );

  // ---- lender operating layer registers (additive) ----
  for (const lf of buildLenderDrawFiles(d.project.id, d.draw.id)) {
    add(lf.name, lf.content, lf.count);
  }

  // ---- VAM banking registers (additive; as-of = generation time) ----
  const banking = bankingRegisterFiles({
    projectId: d.project.id,
    drawRequestId: d.draw.id,
    asOf: d.generatedAt,
    prefix: "",
    users: d.users,
  });
  for (const bf of banking.files) {
    files.push(bf);
    counts[bf.name] = banking.counts[bf.name];
  }

  // ---- dispute / release-hold registers (additive; as-of = generation
  //      time; workflow records only — balances are never restated)
  const disputeRegs = disputeRegisterFiles({
    projectId: d.project.id,
    drawRequestId: d.draw.id,
    asOf: d.generatedAt,
    prefix: "",
    users: d.users,
  });
  for (const df of disputeRegs.files) {
    files.push(df);
    counts[df.name] = disputeRegs.counts[df.name];
  }

  return { files, counts };
}

// ====================================================== standalone ZIP

/** Assemble the standalone downloadable package: PDF (or printable HTML
 *  when no renderer), the structured registers, and a hashed manifest —
 *  independently verifiable like the Project Audit Package. */
export function buildStandaloneDrawZip(
  d: DrawPackageData,
  registers: { files: PackageFile[]; counts: Record<string, number> },
  pdf: Buffer | null,
  html: string
): { zip: Buffer; fileCount: number } {
  const files: PackageFile[] = [...registers.files];
  if (pdf) {
    files.unshift({ name: "draw-verification-package.pdf", data: pdf });
  } else {
    files.unshift({ name: "draw-verification-package.html", data: Buffer.from(html, "utf8") });
  }
  const kindOf = (name: string): string =>
    name.endsWith(".csv") ? "csv-register" : name.endsWith(".json") ? "json" : name.endsWith(".pdf") ? "pdf" : "html";
  const manifestBase = {
    kind: "OBV_DRAW_VERIFICATION_PACKAGE",
    schemaVersion: DRAW_PACKAGE_SCHEMA_VERSION,
    project: { id: d.project.id, name: d.project.name },
    draw: { id: d.draw.id, drawNumber: d.draw.drawNumber, status: d.draw.status },
    generatedAt: d.generatedAt,
    generatedBy: { id: d.generatedBy.id, name: d.generatedBy.name, role: d.generatedBy.role },
    configurationVersion: d.configurationVersion,
    ledgerIntegrity: d.ledger.valid ? "INTACT" : `TAMPERED_AT:${d.ledger.brokenAt}`,
    coverFormat: pdf ? "pdf" : "html",
    fileInventory: files.map((f) => ({
      path: f.name,
      bytes: f.data.length,
      sha256: createHash("sha256").update(f.data).digest("hex"),
      kind: kindOf(f.name),
      records: registers.counts[f.name] ?? null,
      schemaVersion: DRAW_PACKAGE_SCHEMA_VERSION,
    })),
    manifestHash: null as string | null,
  };
  const manifestHash = createHash("sha256")
    .update(JSON.stringify(manifestBase, null, 2))
    .digest("hex");
  files.unshift({
    name: "manifest.json",
    data: Buffer.from(JSON.stringify({ ...manifestBase, manifestHash }, null, 2), "utf8"),
  });
  return { zip: buildZip(files, d.generatedAt), fileCount: files.length };
}
