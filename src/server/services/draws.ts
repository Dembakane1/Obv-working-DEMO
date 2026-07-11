/**
 * Construction Draw Request workflow — lender-native review layer.
 *
 * DOCTRINE
 *   A DRAW REQUEST IS A REQUEST FOR REVIEW. It does not authorize money.
 *   A REVIEWER RECOMMENDATION IS ADVISORY. It does not authorize money.
 *   Only the existing formal governance path — an ApprovalRequest with
 *   its configured approval matrix, one decision per role, separation of
 *   duties, and the exactly-once release transition recorded through the
 *   VirtualAccountService — can create release eligibility.
 *
 * Layering:
 *   - Draft assembly, line items, document checklist and evidence links
 *     are administrative records (no financial effect).
 *   - Evidence linking references EXISTING EvidenceItems; the items stay
 *     governed by their own verification pipeline and ledger entries.
 *   - The recommendation engine is deterministic: it reads real draw
 *     state and explains its reasons. It has NO code path to the
 *     VirtualAccountService.
 *   - processDrawApprovalDecision below is the ONLY function that may
 *     reach virtualAccountService.releaseDraw, and only after every
 *     required role has approved.
 */
import * as repo from "../db/repo";
import { virtualAccountService } from "./VirtualAccountService";
import { teamsNotifier } from "./TeamsNotifier";
import { mirrorEvent, ensureDrawThread } from "./chat";
import { computeRetainage, rateForDraw } from "./retainage";
import type {
  ApprovalRecord,
  ApprovalRequest,
  DrawDocument,
  DrawDocumentRequirement,
  DrawDocumentType,
  DrawEvidenceLink,
  DrawLineItem,
  DrawLineItemStatus,
  DrawRecommendation,
  DrawRecommendationReason,
  DrawRequest,
  DrawRequirementState,
  Project,
  User,
} from "../../shared/types";

export class DrawError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

const money = (n: number) => "$" + n.toLocaleString("en-US");

// ------------------------------------------------------------ access
// Tenant boundary: a draw is visible to the lender/governing organization
// (the project's organization), the borrower organization that submitted
// it, and any organization wired into the project's pilot configuration.
// Unrelated tenants get 404 — the record's existence is not disclosed.

export function canAccessDraw(user: User, draw: DrawRequest): boolean {
  if (user.organizationId === draw.organizationId) return true;
  if (draw.requestedByOrganizationId && user.organizationId === draw.requestedByOrganizationId) {
    return true;
  }
  const project = repo.getProject(draw.projectId);
  const pilot = project?.pilot;
  return [
    pilot?.implementingOrgId,
    pilot?.contractorOrgId,
    pilot?.funderOrgId,
    pilot?.engineerOrgId,
  ].some((orgId) => orgId && orgId === user.organizationId);
}

function assertAccess(user: User, draw: DrawRequest): void {
  if (!canAccessDraw(user, draw)) throw new DrawError("Draw request not found", 404);
}

/** Lender-side review authority. The draw submitter can never review
 *  their own draw, whatever role they hold (separation of duties). */
export function canReviewDraw(user: User, draw: DrawRequest): boolean {
  return (
    canAccessDraw(user, draw) &&
    (user.role === "FUNDER_REP" || user.role === "COMPLIANCE_REVIEWER") &&
    user.id !== draw.requestedByUserId
  );
}

function assertReviewer(user: User, draw: DrawRequest): void {
  assertAccess(user, draw);
  if (!canReviewDraw(user, draw)) {
    throw new DrawError(
      "Not authorized to review this draw (requires an unconflicted funder representative or compliance reviewer)",
      403
    );
  }
}

/** Statuses in which the requester may still edit the draw contents. */
const EDITABLE: DrawRequest["status"][] = ["DRAFT", "RETURNED", "CLARIFICATION_REQUIRED"];
/** Statuses in which reviewers may record line/document decisions. */
const REVIEWABLE: DrawRequest["status"][] = ["SUBMITTED", "UNDER_REVIEW"];

function getDrawOr404(id: string): DrawRequest {
  const draw = repo.getDrawRequest(id);
  if (!draw) throw new DrawError("Draw request not found", 404);
  return draw;
}

function event(
  drawRequestId: string,
  type: Parameters<typeof repo.insertDrawEvent>[0]["type"],
  detail: string,
  actorUserId: string | null
): void {
  repo.insertDrawEvent({
    id: repo.newId(),
    drawRequestId,
    type,
    detail,
    actorUserId,
    createdAt: new Date().toISOString(),
  });
}

function mirrorDraw(draw: DrawRequest, body: string): void {
  mirrorEvent(body, {
    projectId: draw.projectId,
    drawRequestId: draw.id,
    refType: "DRAW_REFERENCE",
    refId: draw.id,
  });
}

// ------------------------------------------------------------ creation

/** Standard lender document checklist seeded onto every new draw. The
 *  requester/reviewer can add project-specific requirements on top. */
const DEFAULT_REQUIREMENTS: Array<{
  docType: DrawDocumentType;
  title: string;
  required: boolean;
}> = [
  { docType: "PAY_APPLICATION", title: "Pay application / schedule of values", required: true },
  { docType: "CONTRACTOR_INVOICE", title: "Contractor invoice", required: true },
  { docType: "CONDITIONAL_LIEN_WAIVER", title: "Conditional lien waiver", required: true },
  { docType: "INSPECTION_REPORT", title: "Inspection report", required: false },
  { docType: "MATERIAL_INVOICE", title: "Material invoices (stored materials)", required: false },
  { docType: "PROOF_OF_INSURANCE", title: "Proof of insurance (if lapsed/renewed)", required: false },
];

export function createDraw(
  user: User,
  input: {
    projectId: string;
    drawNumber?: number;
    requestedAmount?: number;
    currency?: string;
    periodStart?: string | null;
    periodEnd?: string | null;
  }
): DrawRequest {
  if (user.role === "FIELD") {
    throw new DrawError("Field users cannot create draw requests", 403);
  }
  const project = repo.getProject(input.projectId);
  if (!project) throw new DrawError("Unknown project", 404);
  const drawNumber = input.drawNumber ?? repo.nextDrawNumber(project.id);
  if (repo.listDrawRequestsForProject(project.id).some((d) => d.drawNumber === drawNumber)) {
    throw new DrawError(`Draw #${drawNumber} already exists for this project`, 409);
  }
  const requestedAmount = Math.round(Number(input.requestedAmount ?? 0));
  if (!Number.isFinite(requestedAmount) || requestedAmount < 0) {
    throw new DrawError("requestedAmount must be a non-negative number");
  }
  const now = new Date().toISOString();
  const draw: DrawRequest = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    drawNumber,
    requestedByUserId: user.id,
    requestedByOrganizationId:
      user.organizationId !== project.organizationId ? user.organizationId : null,
    submittedAt: null,
    requestedAmount,
    approvedAmount: null,
    recommendedAmount: null,
    currency: input.currency?.trim().toUpperCase().slice(0, 3) || project.pilot?.currency || "USD",
    periodStart: input.periodStart || null,
    periodEnd: input.periodEnd || null,
    retainageRate: null,
    retainageWithheld: null,
    status: "DRAFT",
    reviewRecommendation: null,
    reviewSummary: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.insertDrawRequest(draw);
  DEFAULT_REQUIREMENTS.forEach((r, i) =>
    repo.insertDrawRequirement({
      id: repo.newId(),
      drawRequestId: draw.id,
      sort: i,
      docType: r.docType,
      title: r.title,
      required: r.required,
      notes: null,
    })
  );
  event(draw.id, "CREATED", `Draft draw #${drawNumber} created by ${user.name} for ${money(requestedAmount)}.`, user.id);
  return draw;
}

export function updateDraft(
  user: User,
  drawId: string,
  patch: {
    requestedAmount?: number;
    periodStart?: string | null;
    periodEnd?: string | null;
    currency?: string;
  }
): DrawRequest {
  const draw = getDrawOr404(drawId);
  assertAccess(user, draw);
  if (!EDITABLE.includes(draw.status)) {
    throw new DrawError(`Draw is ${draw.status} and can no longer be edited`, 409);
  }
  const requestedAmount =
    patch.requestedAmount !== undefined ? Math.round(Number(patch.requestedAmount)) : undefined;
  if (requestedAmount !== undefined && (!Number.isFinite(requestedAmount) || requestedAmount < 0)) {
    throw new DrawError("requestedAmount must be a non-negative number");
  }
  repo.updateDrawRequest(draw.id, {
    requestedAmount,
    periodStart: patch.periodStart,
    periodEnd: patch.periodEnd,
    currency: patch.currency ? patch.currency.trim().toUpperCase().slice(0, 3) : undefined,
  });
  event(draw.id, "UPDATED", `Draw details updated by ${user.name}.`, user.id);
  return repo.getDrawRequest(draw.id)!;
}

export function cancelDraw(user: User, drawId: string): DrawRequest {
  const draw = getDrawOr404(drawId);
  assertAccess(user, draw);
  if (!["DRAFT", "SUBMITTED", "RETURNED", "CLARIFICATION_REQUIRED"].includes(draw.status)) {
    throw new DrawError(`A ${draw.status} draw cannot be cancelled`, 409);
  }
  repo.updateDrawRequest(draw.id, { status: "CANCELLED" });
  event(draw.id, "CANCELLED", `Draw cancelled by ${user.name}.`, user.id);
  return repo.getDrawRequest(draw.id)!;
}

// ------------------------------------------------------------ line items

export function addLine(
  user: User,
  drawId: string,
  input: {
    description: string;
    budgetLineId?: string | null;
    milestoneId?: string | null;
    changeOrderId?: string | null;
    /** Required when billing against a change order that is not yet
     *  APPROVED: the requester explicitly acknowledges the exception and
     *  the line is surfaced for review — never silent, never automatic
     *  rejection. */
    exceptionAcknowledged?: boolean;
    scheduledValue?: number;
    previouslyPaid?: number;
    currentRequested?: number;
    materialsStored?: number | null;
    retainageAmount?: number | null;
    percentCompleteClaimed?: number | null;
  }
): DrawLineItem {
  const draw = getDrawOr404(drawId);
  assertAccess(user, draw);
  if (!EDITABLE.includes(draw.status)) {
    throw new DrawError(`Draw is ${draw.status} — line items can no longer be changed`, 409);
  }
  const description = (input.description ?? "").trim();
  if (!description) throw new DrawError("Line item description is required");
  if (input.milestoneId) {
    const ms = repo.getMilestone(input.milestoneId);
    if (!ms || ms.projectId !== draw.projectId) {
      throw new DrawError("milestoneId must reference a milestone of the draw's project");
    }
  }
  if (input.changeOrderId) {
    const co = repo.getChangeOrder(input.changeOrderId);
    if (!co || co.projectId !== draw.projectId) {
      throw new DrawError("changeOrderId must reference a change order of the draw's project");
    }
    const approved = ["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(co.status);
    if (!approved && !input.exceptionAcknowledged) {
      throw new DrawError(
        `Change order CO-${co.changeOrderNumber} is ${co.status.replace(/_/g, " ")} — billing against an unapproved change order requires an explicit exception acknowledgement and is held for review`,
        422
      );
    }
  }
  const num = (v: unknown, label: string, min = 0): number => {
    const n = Math.round(Number(v ?? 0));
    if (!Number.isFinite(n) || n < min) throw new DrawError(`${label} must be a number >= ${min}`);
    return n;
  };
  const line: DrawLineItem = {
    id: repo.newId(),
    drawRequestId: draw.id,
    sort: repo.listDrawLines(draw.id).length,
    budgetLineId: input.budgetLineId?.trim() || null,
    milestoneId: input.milestoneId || null,
    changeOrderId: input.changeOrderId || null,
    description,
    scheduledValue: num(input.scheduledValue, "scheduledValue"),
    previouslyPaid: num(input.previouslyPaid, "previouslyPaid"),
    currentRequested: num(input.currentRequested, "currentRequested"),
    materialsStored: input.materialsStored != null ? num(input.materialsStored, "materialsStored") : null,
    retainageAmount: input.retainageAmount != null ? num(input.retainageAmount, "retainageAmount") : null,
    percentCompleteClaimed:
      input.percentCompleteClaimed != null
        ? Math.max(0, Math.min(100, Number(input.percentCompleteClaimed)))
        : null,
    percentCompleteVerified: null,
    supportedAmount: null,
    status: "PENDING",
    reviewNotes: null,
    reviewedByUserId: null,
    reviewedAt: null,
    totalCompletedAndStored: 0,
    balanceToFinish: 0,
    varianceAmount: null,
    variancePercent: null,
  };
  repo.insertDrawLine(line);
  const coNote = (() => {
    if (!line.changeOrderId) return "";
    const co = repo.getChangeOrder(line.changeOrderId);
    const approved = co && ["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(co.status);
    return co
      ? approved
        ? ` (change order CO-${co.changeOrderNumber})`
        : ` (UNAPPROVED change order CO-${co.changeOrderNumber} — exception acknowledged, held for review)`
      : "";
  })();
  event(draw.id, "LINE_ADDED", `Line added: "${description}" — ${money(line.currentRequested)} requested${coNote}.`, user.id);
  return repo.getDrawLine(line.id)!;
}

export function updateLine(
  user: User,
  lineId: string,
  patch: {
    description?: string;
    budgetLineId?: string | null;
    milestoneId?: string | null;
    scheduledValue?: number;
    previouslyPaid?: number;
    currentRequested?: number;
    materialsStored?: number | null;
    retainageAmount?: number | null;
    percentCompleteClaimed?: number | null;
  }
): DrawLineItem {
  const line = repo.getDrawLine(lineId);
  if (!line) throw new DrawError("Line item not found", 404);
  const draw = getDrawOr404(line.drawRequestId);
  assertAccess(user, draw);
  if (!EDITABLE.includes(draw.status)) {
    throw new DrawError(`Draw is ${draw.status} — line items can no longer be changed`, 409);
  }
  if (patch.milestoneId) {
    const ms = repo.getMilestone(patch.milestoneId);
    if (!ms || ms.projectId !== draw.projectId) {
      throw new DrawError("milestoneId must reference a milestone of the draw's project");
    }
  }
  const num = (v: unknown, label: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0) throw new DrawError(`${label} must be a non-negative number`);
    return n;
  };
  repo.updateDrawLine(line.id, {
    description: patch.description?.trim() || undefined,
    budgetLineId: patch.budgetLineId !== undefined ? patch.budgetLineId?.trim() || null : undefined,
    milestoneId: patch.milestoneId !== undefined ? patch.milestoneId || null : undefined,
    scheduledValue: num(patch.scheduledValue, "scheduledValue"),
    previouslyPaid: num(patch.previouslyPaid, "previouslyPaid"),
    currentRequested: num(patch.currentRequested, "currentRequested"),
    materialsStored:
      patch.materialsStored !== undefined
        ? patch.materialsStored != null
          ? num(patch.materialsStored, "materialsStored")
          : null
        : undefined,
    retainageAmount:
      patch.retainageAmount !== undefined
        ? patch.retainageAmount != null
          ? num(patch.retainageAmount, "retainageAmount")
          : null
        : undefined,
    percentCompleteClaimed:
      patch.percentCompleteClaimed !== undefined
        ? patch.percentCompleteClaimed != null
          ? Math.max(0, Math.min(100, Number(patch.percentCompleteClaimed)))
          : null
        : undefined,
  });
  event(draw.id, "LINE_UPDATED", `Line "${line.description}" updated by ${user.name}.`, user.id);
  return repo.getDrawLine(line.id)!;
}

export function deleteLine(user: User, lineId: string): void {
  const line = repo.getDrawLine(lineId);
  if (!line) throw new DrawError("Line item not found", 404);
  const draw = getDrawOr404(line.drawRequestId);
  assertAccess(user, draw);
  if (!EDITABLE.includes(draw.status)) {
    throw new DrawError(`Draw is ${draw.status} — line items can no longer be changed`, 409);
  }
  repo.deleteDrawLine(line.id);
  event(draw.id, "LINE_UPDATED", `Line "${line.description}" removed by ${user.name}.`, user.id);
}

// ------------------------------------------------------------ documents

export function addRequirement(
  user: User,
  drawId: string,
  input: { docType: DrawDocumentType; title: string; required?: boolean; notes?: string | null }
): DrawDocumentRequirement {
  const draw = getDrawOr404(drawId);
  assertAccess(user, draw);
  if (user.role === "FIELD") throw new DrawError("Not authorized", 403);
  const title = (input.title ?? "").trim();
  if (!title) throw new DrawError("Requirement title is required");
  const req: DrawDocumentRequirement = {
    id: repo.newId(),
    drawRequestId: draw.id,
    sort: repo.listDrawRequirements(draw.id).length,
    docType: input.docType,
    title,
    required: input.required !== false,
    notes: input.notes?.trim() || null,
  };
  repo.insertDrawRequirement(req);
  event(draw.id, "DOCUMENT_RECORDED", `Document requirement added: "${title}"${req.required ? " (required)" : ""}.`, user.id);
  return req;
}

/** Record a received supporting document. Administrative record only —
 *  never verified physical progress. */
export function recordDocument(
  user: User,
  drawId: string,
  input: {
    requirementId?: string | null;
    lineItemId?: string | null;
    docType?: DrawDocumentType;
    title: string;
    note?: string | null;
    expiresAt?: string | null;
    // Structured metadata for the lender draw package (all optional —
    // absent values render as NOT AVAILABLE, never invented).
    vendor?: string | null;
    invoiceNumber?: string | null;
    amount?: number | null;
    waiverKind?: string | null;
    waiverScope?: string | null;
    coveredThrough?: string | null;
    issuingAuthority?: string | null;
    referenceNumber?: string | null;
    inspectionDate?: string | null;
    inspectionResult?: string | null;
  }
): DrawDocument {
  const draw = getDrawOr404(drawId);
  assertAccess(user, draw);
  if (!EDITABLE.includes(draw.status) && !REVIEWABLE.includes(draw.status)) {
    throw new DrawError(`Draw is ${draw.status} — documents can no longer be recorded`, 409);
  }
  const title = (input.title ?? "").trim();
  if (!title) throw new DrawError("Document title is required");
  let requirement: DrawDocumentRequirement | null = null;
  if (input.requirementId) {
    requirement = repo.getDrawRequirement(input.requirementId);
    if (!requirement || requirement.drawRequestId !== draw.id) {
      throw new DrawError("requirementId does not belong to this draw");
    }
  }
  if (input.lineItemId) {
    const line = repo.getDrawLine(input.lineItemId);
    if (!line || line.drawRequestId !== draw.id) {
      throw new DrawError("lineItemId does not belong to this draw");
    }
  }
  const doc: DrawDocument = {
    id: repo.newId(),
    drawRequestId: draw.id,
    requirementId: requirement?.id ?? null,
    lineItemId: input.lineItemId || null,
    docType: input.docType ?? requirement?.docType ?? "OTHER",
    title,
    filePath: null,
    note: input.note?.trim() || null,
    vendor: input.vendor?.trim() || null,
    invoiceNumber: input.invoiceNumber?.trim() || null,
    amount:
      input.amount !== undefined && input.amount !== null && String(input.amount) !== ""
        ? Math.round(Number(input.amount))
        : null,
    waiverKind: input.waiverKind?.trim() || null,
    waiverScope: input.waiverScope?.trim() || null,
    coveredThrough: input.coveredThrough?.trim() || null,
    issuingAuthority: input.issuingAuthority?.trim() || null,
    referenceNumber: input.referenceNumber?.trim() || null,
    inspectionDate: input.inspectionDate?.trim() || null,
    inspectionResult: input.inspectionResult?.trim() || null,
    status: "RECEIVED",
    expiresAt: input.expiresAt || null,
    uploadedByUserId: user.id,
    receivedAt: new Date().toISOString(),
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNote: null,
  };
  repo.insertDrawDocument(doc);
  event(draw.id, "DOCUMENT_RECORDED", `Document received: "${title}" (${doc.docType.replace(/_/g, " ").toLowerCase()}).`, user.id);
  return doc;
}

export function reviewDocument(
  user: User,
  documentId: string,
  decision: "ACCEPTED" | "REJECTED",
  note?: string | null
): DrawDocument {
  const doc = repo.getDrawDocument(documentId);
  if (!doc) throw new DrawError("Document not found", 404);
  const draw = getDrawOr404(doc.drawRequestId);
  assertReviewer(user, draw);
  if (decision === "REJECTED" && !note?.trim()) {
    throw new DrawError("A rejection note is required");
  }
  repo.updateDrawDocument(doc.id, {
    status: decision,
    reviewedByUserId: user.id,
    reviewedAt: new Date().toISOString(),
    reviewNote: note?.trim() || null,
  });
  event(draw.id, "DOCUMENT_REVIEWED", `Document "${doc.title}" ${decision.toLowerCase()} by ${user.name}${note?.trim() ? ` — ${note.trim()}` : ""}.`, user.id);
  return repo.getDrawDocument(doc.id)!;
}

/** Derived checklist: one row per requirement plus unmatched documents. */
export interface DrawChecklistRow {
  requirement: DrawDocumentRequirement | null;
  state: DrawRequirementState;
  documents: DrawDocument[];
}

export function documentChecklist(drawRequestId: string): DrawChecklistRow[] {
  const requirements = repo.listDrawRequirements(drawRequestId);
  const documents = repo.listDrawDocuments(drawRequestId);
  const now = Date.now();
  const effective = (d: DrawDocument): DrawDocument["status"] =>
    d.status === "RECEIVED" && d.expiresAt && Date.parse(d.expiresAt) < now ? "EXPIRED" : d.status;
  const rows: DrawChecklistRow[] = requirements.map((requirement) => {
    const docs = documents.filter((d) => d.requirementId === requirement.id);
    const accepted = docs.some((d) => effective(d) === "ACCEPTED");
    const received = docs.some((d) => effective(d) === "RECEIVED");
    const rejected = docs.length > 0 && docs.every((d) => effective(d) === "REJECTED");
    const expired = docs.length > 0 && docs.every((d) => ["EXPIRED", "REJECTED"].includes(effective(d)));
    const state: DrawRequirementState = accepted
      ? "ACCEPTED"
      : received
        ? "RECEIVED"
        : rejected
          ? "REJECTED"
          : expired
            ? "EXPIRED"
            : requirement.required
              ? "MISSING"
              : "REQUIRED";
    return { requirement, state, documents: docs };
  });
  const unmatched = documents.filter((d) => !d.requirementId);
  if (unmatched.length) rows.push({ requirement: null, state: "RECEIVED", documents: unmatched });
  return rows;
}

/** Required requirements that have no usable (received/accepted) document. */
export function missingRequiredDocuments(drawRequestId: string): DrawDocumentRequirement[] {
  return documentChecklist(drawRequestId)
    .filter((row) => row.requirement?.required && !["ACCEPTED", "RECEIVED"].includes(row.state))
    .map((row) => row.requirement!);
}

// ------------------------------------------------------------ evidence

/** Link an EXISTING governed evidence record to the draw (or a line).
 *  The evidence stays owned by its milestone workflow — linking never
 *  copies, re-verifies or alters it, and unlinking never deletes it. */
export function linkEvidence(
  user: User,
  drawId: string,
  input: { evidenceItemId: string; lineItemId?: string | null; note?: string | null }
): DrawEvidenceLink {
  const draw = getDrawOr404(drawId);
  assertAccess(user, draw);
  if (!EDITABLE.includes(draw.status) && !REVIEWABLE.includes(draw.status)) {
    throw new DrawError(`Draw is ${draw.status} — evidence links can no longer be changed`, 409);
  }
  const evidence = repo.getEvidence(input.evidenceItemId);
  if (!evidence) throw new DrawError("Unknown evidence record", 404);
  const milestone = repo.getMilestone(evidence.milestoneId);
  if (!milestone || milestone.projectId !== draw.projectId) {
    throw new DrawError("Evidence must belong to the draw's project");
  }
  if (input.lineItemId) {
    const line = repo.getDrawLine(input.lineItemId);
    if (!line || line.drawRequestId !== draw.id) {
      throw new DrawError("lineItemId does not belong to this draw");
    }
  }
  const existing = repo
    .listDrawEvidenceLinks(draw.id)
    .find(
      (l) =>
        l.evidenceItemId === input.evidenceItemId &&
        (l.lineItemId ?? null) === (input.lineItemId || null)
    );
  if (existing) return existing;
  const link: DrawEvidenceLink = {
    id: repo.newId(),
    drawRequestId: draw.id,
    lineItemId: input.lineItemId || null,
    evidenceItemId: input.evidenceItemId,
    note: input.note?.trim() || null,
    linkedByUserId: user.id,
    createdAt: new Date().toISOString(),
  };
  repo.insertDrawEvidenceLink(link);
  event(draw.id, "EVIDENCE_LINKED", `Evidence ${evidence.id.slice(0, 8)}… (M${milestone.seq}) linked by ${user.name}.`, user.id);
  return link;
}

export function unlinkEvidence(user: User, linkId: string): void {
  const link = repo.getDrawEvidenceLink(linkId);
  if (!link) throw new DrawError("Evidence link not found", 404);
  const draw = getDrawOr404(link.drawRequestId);
  assertAccess(user, draw);
  if (!EDITABLE.includes(draw.status) && !REVIEWABLE.includes(draw.status)) {
    throw new DrawError(`Draw is ${draw.status} — evidence links can no longer be changed`, 409);
  }
  repo.deleteDrawEvidenceLink(link.id);
  event(draw.id, "EVIDENCE_UNLINKED", `Evidence link removed by ${user.name}. The evidence record itself is unchanged.`, user.id);
}

// ------------------------------------------------------------ submission

export interface DrawCompleteness {
  ok: boolean;
  checks: Array<{ key: string; label: string; ok: boolean; detail: string }>;
}

/** Reconciliation: line items must sum exactly to the requested amount. */
export function reconcile(draw: DrawRequest, lines: DrawLineItem[]): {
  lineTotal: number;
  delta: number;
  reconciled: boolean;
} {
  const lineTotal = lines.reduce((s, l) => s + l.currentRequested, 0);
  return { lineTotal, delta: draw.requestedAmount - lineTotal, reconciled: lineTotal === draw.requestedAmount };
}

export function completeness(drawRequestId: string): DrawCompleteness {
  const draw = getDrawOr404(drawRequestId);
  const lines = repo.listDrawLines(draw.id);
  const rec = reconcile(draw, lines);
  const missingDocs = missingRequiredDocuments(draw.id);
  const links = repo.listDrawEvidenceLinks(draw.id);
  const checks: DrawCompleteness["checks"] = [
    {
      key: "amount",
      label: "Requested amount entered",
      ok: draw.requestedAmount > 0,
      detail: draw.requestedAmount > 0 ? money(draw.requestedAmount) : "Requested amount must be greater than zero.",
    },
    {
      key: "period",
      label: "Draw period set",
      ok: Boolean(draw.periodStart && draw.periodEnd),
      detail: draw.periodStart && draw.periodEnd ? `${draw.periodStart} → ${draw.periodEnd}` : "Set the period this draw covers.",
    },
    {
      key: "lines",
      label: "At least one line item",
      ok: lines.length > 0,
      detail: lines.length ? `${lines.length} line item(s)` : "Add the budget lines this draw pays.",
    },
    {
      key: "reconcile",
      label: "Line items reconcile to the requested amount",
      ok: lines.length > 0 && rec.reconciled,
      detail: rec.reconciled
        ? `Lines total ${money(rec.lineTotal)}`
        : `Lines total ${money(rec.lineTotal)} vs requested ${money(draw.requestedAmount)} (difference ${money(Math.abs(rec.delta))}).`,
    },
    {
      key: "documents",
      label: "Required documents on file (blocks readiness, not submission)",
      ok: missingDocs.length === 0,
      detail: missingDocs.length
        ? `Missing: ${missingDocs.map((d) => d.title).join(", ")}`
        : "All required documents received.",
    },
    {
      key: "evidence",
      label: "Field evidence linked (recommended)",
      ok: links.length > 0,
      detail: links.length ? `${links.length} evidence link(s)` : "Link milestone evidence that supports the claimed progress.",
    },
  ];
  // Submission gate: amount, period, lines and reconciliation are hard
  // requirements. Documents/evidence block governance readiness instead.
  const ok = checks.filter((c) => ["amount", "period", "lines", "reconcile"].includes(c.key)).every((c) => c.ok);
  return { ok, checks };
}

export async function submitDraw(user: User, drawId: string): Promise<DrawRequest> {
  const draw = getDrawOr404(drawId);
  assertAccess(user, draw);
  if (!EDITABLE.includes(draw.status)) {
    throw new DrawError(`A ${draw.status} draw cannot be submitted`, 409);
  }
  const check = completeness(draw.id);
  if (!check.ok) {
    const failing = check.checks.filter((c) => !c.ok && ["amount", "period", "lines", "reconcile"].includes(c.key));
    throw new DrawError(`Draw cannot be submitted: ${failing.map((c) => c.detail).join(" ")}`, 422);
  }
  const resubmission = draw.status !== "DRAFT";
  repo.updateDrawRequest(draw.id, {
    status: "SUBMITTED",
    submittedAt: new Date().toISOString(),
    requestedByUserId: draw.requestedByUserId ?? user.id,
    requestedByOrganizationId:
      draw.requestedByOrganizationId ??
      (user.organizationId !== draw.organizationId ? user.organizationId : null),
  });
  event(draw.id, "SUBMITTED", `Draw #${draw.drawNumber} ${resubmission ? "resubmitted" : "submitted"} by ${user.name} — ${money(draw.requestedAmount)} requested. Awaiting lender review; no funds are authorized by submission.`, user.id);
  ensureDrawThread(repo.getDrawRequest(draw.id)!, user);
  mirrorDraw(
    draw,
    `Draw #${draw.drawNumber} ${resubmission ? "resubmitted" : "submitted"} for review — ${money(draw.requestedAmount)} requested. Review and formal governance still required; nothing is released by submission.`
  );
  await teamsNotifier.notify(
    "DRAW_SUBMITTED",
    `Draw #${draw.drawNumber} submitted for review on project ${draw.projectId} — ${money(draw.requestedAmount)} requested. Funds remain governed by the formal approval workflow.`,
    { projectId: draw.projectId }
  );
  return repo.getDrawRequest(draw.id)!;
}

// ------------------------------------------------------------ review

export function reviewLine(
  user: User,
  lineId: string,
  input: {
    decision: DrawLineItemStatus;
    reason?: string | null;
    supportedAmount?: number | null;
    percentCompleteVerified?: number | null;
  }
): DrawLineItem {
  const line = repo.getDrawLine(lineId);
  if (!line) throw new DrawError("Line item not found", 404);
  const draw = getDrawOr404(line.drawRequestId);
  assertReviewer(user, draw);
  if (!REVIEWABLE.includes(draw.status)) {
    throw new DrawError(`Draw is ${draw.status} — line review is not open`, 409);
  }
  const decision = input.decision;
  if (!["SUPPORTED", "PARTIALLY_SUPPORTED", "EXCEPTION", "REJECTED"].includes(decision)) {
    throw new DrawError("decision must be SUPPORTED, PARTIALLY_SUPPORTED, EXCEPTION or REJECTED");
  }
  const reason = input.reason?.trim() || null;
  if (decision !== "SUPPORTED" && !reason) {
    throw new DrawError(`A review reason is required for ${decision.replace(/_/g, " ").toLowerCase()}`);
  }
  let supportedAmount: number | null = null;
  if (decision === "PARTIALLY_SUPPORTED") {
    supportedAmount = Math.round(Number(input.supportedAmount));
    if (!Number.isFinite(supportedAmount) || supportedAmount <= 0 || supportedAmount >= line.currentRequested) {
      throw new DrawError("supportedAmount must be between 0 and the requested line amount (exclusive)");
    }
  }
  const verified =
    input.percentCompleteVerified != null
      ? Math.max(0, Math.min(100, Number(input.percentCompleteVerified)))
      : undefined;
  // First review action moves a SUBMITTED draw into UNDER_REVIEW.
  if (draw.status === "SUBMITTED") {
    repo.updateDrawRequest(draw.id, { status: "UNDER_REVIEW" });
    event(draw.id, "UPDATED", `Review started by ${user.name}.`, user.id);
  }
  repo.updateDrawLine(line.id, {
    status: decision,
    reviewNotes: reason,
    supportedAmount,
    percentCompleteVerified: verified,
    reviewedByUserId: user.id,
    reviewedAt: new Date().toISOString(),
  });
  event(
    draw.id,
    "LINE_REVIEWED",
    `Line "${line.description}" marked ${decision.replace(/_/g, " ")} by ${user.name}` +
      (supportedAmount != null ? ` (${money(supportedAmount)} of ${money(line.currentRequested)} supported)` : "") +
      (reason ? ` — ${reason}` : "") +
      ". Line review is advisory: it cannot release funds.",
    user.id
  );
  return repo.getDrawLine(line.id)!;
}

export function requestClarification(user: User, drawId: string, question: string): DrawRequest {
  const draw = getDrawOr404(drawId);
  assertReviewer(user, draw);
  if (!REVIEWABLE.includes(draw.status)) {
    throw new DrawError(`Draw is ${draw.status} — clarification cannot be requested`, 409);
  }
  const q = question.trim();
  if (!q) throw new DrawError("A clarification question is required");
  repo.updateDrawRequest(draw.id, { status: "CLARIFICATION_REQUIRED" });
  event(draw.id, "CLARIFICATION_REQUESTED", `Clarification requested by ${user.name}: ${q}`, user.id);
  mirrorDraw(draw, `Clarification requested on Draw #${draw.drawNumber}: ${q}`);
  return repo.getDrawRequest(draw.id)!;
}

/** The requester answers a clarification (a response never auto-accepts
 *  anything — the draw simply returns to review). */
export function resolveClarification(user: User, drawId: string, note: string): DrawRequest {
  const draw = getDrawOr404(drawId);
  assertAccess(user, draw);
  if (draw.status !== "CLARIFICATION_REQUIRED") {
    throw new DrawError("No open clarification on this draw", 409);
  }
  const n = note.trim();
  if (!n) throw new DrawError("A response note is required");
  repo.updateDrawRequest(draw.id, { status: "UNDER_REVIEW" });
  event(draw.id, "CLARIFICATION_RESOLVED", `Clarification answered by ${user.name}: ${n}`, user.id);
  mirrorDraw(draw, `Clarification on Draw #${draw.drawNumber} answered: ${n}`);
  return repo.getDrawRequest(draw.id)!;
}

export function returnDraw(user: User, drawId: string, reason: string): DrawRequest {
  const draw = getDrawOr404(drawId);
  assertReviewer(user, draw);
  if (!REVIEWABLE.includes(draw.status) && draw.status !== "CLARIFICATION_REQUIRED") {
    throw new DrawError(`A ${draw.status} draw cannot be returned`, 409);
  }
  const r = reason.trim();
  if (!r) throw new DrawError("A return reason is required");
  repo.updateDrawRequest(draw.id, { status: "RETURNED" });
  event(draw.id, "RETURNED", `Draw returned to requester by ${user.name}: ${r}`, user.id);
  mirrorDraw(draw, `Draw #${draw.drawNumber} returned to requester: ${r}`);
  return repo.getDrawRequest(draw.id)!;
}

// ------------------------------------------------------ recommendation

/** Supported amount a reviewed line contributes. PENDING contributes 0
 *  (nothing unreviewed is ever counted as supported). */
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

/**
 * Deterministic advisory recommendation, computed from real draw state:
 * document checklist, line reviews, linked evidence verification, open
 * high-severity field issues and open clarifications. The result shows
 * its reasons. IT IS ADVISORY — this function reads state and returns a
 * value; it has no code path to the VirtualAccountService or the
 * approval workflow.
 */
export function computeRecommendation(drawRequestId: string): DrawRecommendation {
  const draw = getDrawOr404(drawRequestId);
  const lines = repo.listDrawLines(draw.id);
  const reasons: DrawRecommendationReason[] = [];

  const supportedAmount = lines.reduce((s, l) => s + lineSupported(l), 0);
  const exceptionAmount = Math.max(0, draw.requestedAmount - supportedAmount);
  const retainageAmount = lines.reduce((s, l) => s + (l.retainageAmount ?? 0), 0);

  // ---- blockers (checked in priority order) ----
  const missingDocs = missingRequiredDocuments(draw.id);
  for (const d of missingDocs) {
    reasons.push({ kind: "BLOCKER", detail: `Required document missing: ${d.title}`, amount: null, lineItemId: null });
  }
  const pendingLines = lines.filter((l) => l.status === "PENDING");
  for (const l of pendingLines) {
    reasons.push({
      kind: "BLOCKER",
      detail: `Line "${l.description}" (${money(l.currentRequested)}) has not been reviewed against evidence`,
      amount: l.currentRequested,
      lineItemId: l.id,
    });
  }
  const openHighIssues = repo
    .listFieldIssues()
    .filter(
      (i) =>
        i.projectId === draw.projectId &&
        !["RESOLVED", "CLOSED"].includes(i.status) &&
        ["HIGH", "CRITICAL"].includes(i.severity)
    );
  for (const i of openHighIssues) {
    reasons.push({ kind: "BLOCKER", detail: `Open ${i.severity} field issue: "${i.title}"`, amount: null, lineItemId: null });
  }

  // ---- per-line exception explanations ----
  for (const l of lines) {
    if (l.status === "PARTIALLY_SUPPORTED") {
      reasons.push({
        kind: "EXCEPTION",
        detail: `${money(l.currentRequested - (l.supportedAmount ?? 0))} of "${l.description}" not supported${l.reviewNotes ? ` — ${l.reviewNotes}` : ""}`,
        amount: l.currentRequested - (l.supportedAmount ?? 0),
        lineItemId: l.id,
      });
    } else if (l.status === "EXCEPTION" || l.status === "REJECTED") {
      reasons.push({
        kind: "EXCEPTION",
        detail: `${money(l.currentRequested)} line "${l.description}" ${l.status === "REJECTED" ? "rejected" : "held as exception"}${l.reviewNotes ? ` — ${l.reviewNotes}` : ""}`,
        amount: l.currentRequested,
        lineItemId: l.id,
      });
    }
  }

  // ---- unapproved change-order billing (deterministic signal) ----
  for (const l of lines) {
    if (!l.changeOrderId) continue;
    const co = repo.getChangeOrder(l.changeOrderId);
    if (co && !["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(co.status)) {
      reasons.push({
        kind: "EXCEPTION",
        detail: `UNAPPROVED CHANGE COST INCLUDED IN DRAW: line "${l.description}" (${money(l.currentRequested)}) bills against CO-${co.changeOrderNumber} which is ${co.status.replace(/_/g, " ")}`,
        amount: l.currentRequested,
        lineItemId: l.id,
      });
    }
  }

  // ---- jurisdictional inspection gate (line-scoped, deterministic) ----
  // A milestone whose REQUIRED inspection has not passed never rejects
  // the whole draw — only its own line amount is surfaced for exception
  // handling through the existing partial-support workflow.
  for (const l of lines) {
    if (!l.milestoneId) continue;
    const req = repo.getInspectionRequirement(l.milestoneId);
    if (!req || req.requirement !== "REQUIRED") continue;
    if (!req.mustPassBeforeDrawReview && !req.mustPassBeforeGovernance) continue;
    const inspections = repo
      .listInspectionsForMilestone(l.milestoneId)
      .filter((i) => i.status !== "CANCELLED");
    const latest = inspections.length ? inspections[inspections.length - 1] : null;
    if (latest?.status !== "PASSED") {
      const ms = repo.getMilestone(l.milestoneId);
      reasons.push({
        kind: "EXCEPTION",
        detail: `REQUIRED JURISDICTIONAL INSPECTION NOT PASSED: line "${l.description}" (${money(l.currentRequested)}) references M${ms?.seq} — ${req.inspectionType ?? "inspection"} is ${latest ? latest.status.replace(/_/g, " ") : "NOT SCHEDULED"}`,
        amount: l.currentRequested,
        lineItemId: l.id,
      });
    }
  }

  // ---- grounded progress cross-check (informational) ----
  const links = repo.listDrawEvidenceLinks(draw.id);
  for (const l of lines) {
    if (l.milestoneId && (l.percentCompleteClaimed ?? 0) > 0) {
      const ms = repo.getMilestone(l.milestoneId);
      const msVerified = ms && ["VERIFIED", "APPROVED", "RELEASED"].includes(ms.status);
      const hasVerifiedEvidence = links
        .filter((k) => k.lineItemId === l.id || (!k.lineItemId && true))
        .some((k) => {
          const v = repo.getVerificationForEvidence(k.evidenceItemId);
          return v?.verdict === "VERIFIED" && repo.getEvidence(k.evidenceItemId)?.milestoneId === l.milestoneId;
        });
      if (!msVerified && !hasVerifiedEvidence) {
        reasons.push({
          kind: "INFO",
          detail: `Line "${l.description}" claims ${l.percentCompleteClaimed}% complete but milestone M${ms?.seq} has no verified evidence yet`,
          amount: null,
          lineItemId: l.id,
        });
      }
    }
  }

  // ---- result (deterministic priority) ----
  let result: DrawRecommendation["result"];
  if (draw.status === "CLARIFICATION_REQUIRED") {
    result = "RETURN_FOR_CLARIFICATION";
    reasons.unshift({ kind: "BLOCKER", detail: "An open clarification is awaiting the requester's response", amount: null, lineItemId: null });
  } else if (missingDocs.length > 0) {
    result = "HOLD_DOCUMENTS_MISSING";
  } else if (pendingLines.length > 0) {
    result = "HOLD_EVIDENCE_NEEDS_REVIEW";
  } else if (openHighIssues.length > 0) {
    result = "HOLD_OPEN_HIGH_SEVERITY_ISSUE";
  } else if (lines.length > 0 && supportedAmount === draw.requestedAmount) {
    result = "READY_FOR_GOVERNANCE";
    reasons.push({ kind: "INFO", detail: "All line items supported by review; documents complete; no blocking issues", amount: supportedAmount, lineItemId: null });
  } else {
    result = "PARTIAL_SUPPORT";
  }

  return {
    drawRequestId: draw.id,
    result,
    requestedAmount: draw.requestedAmount,
    supportedAmount,
    exceptionAmount,
    retainageAmount,
    reasons,
    eligibleForGovernance:
      (result === "READY_FOR_GOVERNANCE" || result === "PARTIAL_SUPPORT") && supportedAmount > 0,
    computedAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------ governance

/** Effective approval matrix for draws: the project's configured default
 *  approval policy, else the standing OBV default. */
export function resolveDrawApprovalRoles(projectId: string): User["role"][] {
  const projectDefault = repo.listApprovalPolicies(projectId).find((p) => p.milestoneId === null);
  if (projectDefault && projectDefault.requiredRoles.length > 0) return projectDefault.requiredRoles;
  return ["FUNDER_REP", "COMPLIANCE_REVIEWER"];
}

/**
 * Finalize the advisory recommendation and open formal governance. The
 * draw becomes READY_FOR_GOVERNANCE and an ApprovalRequest (subject DRAW)
 * is created against the project's approval matrix. NOTHING is released
 * here — the recommendation is carried into governance as advice.
 */
export async function sendToGovernance(
  user: User,
  drawId: string,
  summary?: string | null
): Promise<{ draw: DrawRequest; approvalRequest: ApprovalRequest }> {
  const draw = getDrawOr404(drawId);
  assertReviewer(user, draw);
  if (!REVIEWABLE.includes(draw.status)) {
    throw new DrawError(`Draw is ${draw.status} — it cannot be sent to governance`, 409);
  }
  const recommendation = computeRecommendation(draw.id);
  if (!recommendation.eligibleForGovernance) {
    throw new DrawError(
      `Draw is not governance-eligible: ${recommendation.result.replace(/_/g, " ")}. ` +
        recommendation.reasons.filter((r) => r.kind === "BLOCKER").map((r) => r.detail).join("; "),
      422
    );
  }
  // Retainage computed transparently at finalize: gross supported ×
  // policy rate (no policy = 0%). Withholding itself happens only inside
  // the governed release transition.
  const retainage = computeRetainage(
    recommendation.supportedAmount,
    rateForDraw(draw.projectId)
  );
  repo.updateDrawRequest(draw.id, {
    status: "READY_FOR_GOVERNANCE",
    reviewRecommendation: recommendation.result,
    recommendedAmount: recommendation.supportedAmount,
    retainageRate: retainage.ratePct,
    retainageWithheld: retainage.withheld,
    reviewSummary:
      summary?.trim() ||
      `${recommendation.result.replace(/_/g, " ")}: ${money(recommendation.supportedAmount)} of ${money(recommendation.requestedAmount)} supported.` +
        (retainage.withheld > 0
          ? ` Retainage ${retainage.ratePct}% (${money(retainage.withheld)}) — net release eligible ${money(retainage.netEligible)}.`
          : ""),
  });
  event(
    draw.id,
    "RECOMMENDATION_FINALIZED",
    `Recommendation finalized by ${user.name}: ${recommendation.result.replace(/_/g, " ")} — ${money(recommendation.supportedAmount)} of ${money(recommendation.requestedAmount)} supported. The recommendation is advisory.`,
    user.id
  );

  // Reuse an existing PENDING request if one is already open (idempotent).
  let approvalRequest = repo.getApprovalRequestForDraw(draw.id);
  if (!approvalRequest || approvalRequest.status !== "PENDING") {
    approvalRequest = {
      id: repo.newId(),
      milestoneId: null,
      drawRequestId: draw.id,
      subjectType: "DRAW",
      status: "PENDING",
      requiredRoles: resolveDrawApprovalRoles(draw.projectId),
      createdAt: new Date().toISOString(),
    };
    repo.insertApprovalRequest(approvalRequest);
  }
  event(
    draw.id,
    "SENT_TO_GOVERNANCE",
    `Formal approval opened — requires ${approvalRequest.requiredRoles.join(" + ")}. Funds are authorized only when every required role approves.`,
    user.id
  );
  mirrorDraw(
    draw,
    `Draw #${draw.drawNumber} sent to formal governance — requires ${approvalRequest.requiredRoles
      .map((r) => r.replace(/_/g, " ").toLowerCase())
      .join(" + ")}. Recommended ${money(recommendation.supportedAmount)} of ${money(recommendation.requestedAmount)} (advisory).`
  );
  await teamsNotifier.notify(
    "DRAW_READY_FOR_GOVERNANCE",
    `Draw #${draw.drawNumber} is ready for governance — recommended ${money(recommendation.supportedAmount)} of ${money(recommendation.requestedAmount)} requested. Requires ${approvalRequest.requiredRoles.join(" + ")}.`,
    { projectId: draw.projectId }
  );
  return { draw: repo.getDrawRequest(draw.id)!, approvalRequest };
}

export interface DrawApprovalDecisionResult {
  approvalRequest: ApprovalRequest;
  records: ApprovalRecord[];
  draw: DrawRequest;
  released: boolean;
}

/**
 * Human governance decision on a DRAW-subject ApprovalRequest — the ONLY
 * path that can make a draw release-eligible. Mirrors the milestone
 * governance gate exactly: one decision per required role, separation of
 * duties, funds move only when the matrix is complete, and the release
 * transition is recorded exactly once through the VirtualAccountService.
 */
export async function processDrawApprovalDecision(
  approvalRequestId: string,
  userId: string,
  decision: "APPROVED" | "REJECTED"
): Promise<DrawApprovalDecisionResult> {
  const request = repo.getApprovalRequest(approvalRequestId);
  if (!request || !request.drawRequestId || (request.subjectType ?? "MILESTONE") !== "DRAW") {
    throw new DrawError("Unknown draw approval request", 404);
  }
  if (request.status !== "PENDING") {
    throw new DrawError("This approval request has already been resolved", 409);
  }
  const user = repo.getUser(userId);
  if (!user) throw new DrawError("Select a demo user first", 401);
  const draw = getDrawOr404(request.drawRequestId);
  assertAccess(user, draw);
  if (!request.requiredRoles.includes(user.role)) {
    throw new DrawError(
      `Role ${user.role} is not part of this approval (requires ${request.requiredRoles.join(", ")})`,
      403
    );
  }
  const existing = repo.listApprovalRecordsForRequest(request.id);
  if (existing.some((r) => r.role === user.role)) {
    throw new DrawError(`A ${user.role} decision has already been recorded`, 409);
  }
  // Separation of duties: whoever submitted the draw can never approve it.
  if (draw.requestedByUserId === user.id) {
    throw new DrawError("Separation of duties: the draw submitter cannot approve their own draw", 403);
  }

  repo.insertApprovalRecord({
    id: repo.newId(),
    approvalRequestId: request.id,
    userId: user.id,
    role: user.role,
    decision,
    createdAt: new Date().toISOString(),
  });
  const records = repo.listApprovalRecordsForRequest(request.id);
  const releaseAmount = draw.recommendedAmount ?? draw.requestedAmount;
  let released = false;

  if (decision === "REJECTED") {
    repo.updateApprovalRequestStatus(request.id, "REJECTED");
    repo.updateDrawRequest(draw.id, { status: "RETURNED" });
    event(
      draw.id,
      "GOVERNANCE_DECISION",
      `${user.name} (${user.title}) rejected Draw #${draw.drawNumber} in formal governance. No funds released; draw returned to requester.`,
      user.id
    );
    mirrorDraw(draw, `${user.name} rejected Draw #${draw.drawNumber} in governance. Draw returned; no funds released.`);
    await teamsNotifier.notify(
      "DRAW_APPROVAL_REJECTED",
      `${user.name} rejected Draw #${draw.drawNumber} — draw returned to requester, no funds released.`,
      { projectId: draw.projectId }
    );
  } else {
    const approvedRoles = new Set(records.filter((r) => r.decision === "APPROVED").map((r) => r.role));
    const complete = request.requiredRoles.every((role) => approvedRoles.has(role));
    if (complete) {
      repo.updateApprovalRequestStatus(request.id, "APPROVED");
      const partial = releaseAmount < draw.requestedAmount;
      repo.updateDrawRequest(draw.id, {
        status: partial ? "PARTIALLY_APPROVED" : "APPROVED",
        approvedAmount: releaseAmount,
      });
      event(
        draw.id,
        "GOVERNANCE_DECISION",
        `All required approvals complete (${request.requiredRoles.join(" + ")}). Draw ${partial ? "partially approved" : "approved"} for ${money(releaseAmount)} gross.`,
        user.id
      );
      // Governed release transition — exactly once, through the
      // VirtualAccountService (the only financial gateway). Retainage
      // computed at finalize is withheld inside the same governed
      // transition; the draw releases the NET amount.
      const withheld = draw.retainageWithheld ?? 0;
      const netRelease = releaseAmount - withheld;
      await virtualAccountService.releaseDraw(repo.getDrawRequest(draw.id)!, netRelease);
      if (withheld > 0) {
        await virtualAccountService.withholdRetainage(repo.getDrawRequest(draw.id)!, withheld);
      }
      repo.updateDrawRequest(draw.id, { status: "RELEASED" });
      released = true;
      event(
        draw.id,
        "RELEASE_TRANSITION",
        `Governed release transition recorded on the virtual project account: ${money(netRelease)} net${withheld > 0 ? ` (${money(releaseAmount)} gross − ${money(withheld)} retainage at ${draw.retainageRate}%)` : ""}${partial ? ` · ${money(draw.requestedAmount)} was requested` : ""}. Retainage is released only through its own governed RetainageReleaseRequest.`,
        user.id
      );
      mirrorDraw(
        draw,
        `All approvals complete for Draw #${draw.drawNumber}. ${money(releaseAmount)} release transition recorded on the virtual project account.`
      );
      await teamsNotifier.notify(
        "DRAW_RELEASED",
        `Draw #${draw.drawNumber} fully approved — ${money(releaseAmount)} governed release transition recorded.`,
        { projectId: draw.projectId }
      );
    } else {
      const missing = request.requiredRoles.filter((role) => !approvedRoles.has(role));
      event(
        draw.id,
        "GOVERNANCE_DECISION",
        `${user.name} (${user.title}) approved Draw #${draw.drawNumber} (${approvedRoles.size} of ${request.requiredRoles.length}). Awaiting ${missing.join(", ")}. Funds remain HELD.`,
        user.id
      );
      mirrorDraw(
        draw,
        `${user.name} approved Draw #${draw.drawNumber} (${approvedRoles.size} of ${request.requiredRoles.length}). Awaiting ${missing
          .map((r) => r.replace(/_/g, " ").toLowerCase())
          .join(", ")}. Funds remain HELD.`
      );
      await teamsNotifier.notify(
        "DRAW_APPROVAL_RECORDED",
        `${user.name} approved Draw #${draw.drawNumber} (${approvedRoles.size} of ${request.requiredRoles.length}). Funds remain HELD.`,
        { projectId: draw.projectId }
      );
    }
  }

  return {
    approvalRequest: repo.getApprovalRequest(request.id)!,
    records,
    draw: repo.getDrawRequest(draw.id)!,
    released,
  };
}

// ------------------------------------------------------------ summaries

export interface DrawHeaderSummary {
  draw: DrawRequest;
  project: Project | null;
  requested: number;
  supported: number;
  exception: number;
  retainage: number;
  recommended: number | null;
  lineCount: number;
  pendingLines: number;
  missingDocuments: number;
  evidenceLinks: number;
  approval: ApprovalRequest | null;
  approvalRecords: ApprovalRecord[];
  ageDays: number;
}

export function drawHeaderSummary(drawRequestId: string): DrawHeaderSummary {
  const draw = getDrawOr404(drawRequestId);
  const lines = repo.listDrawLines(draw.id);
  const approval = repo.getApprovalRequestForDraw(draw.id);
  const anchor = draw.submittedAt ?? draw.createdAt;
  return {
    draw,
    project: repo.getProject(draw.projectId),
    requested: draw.requestedAmount,
    supported: lines.reduce((s, l) => s + lineSupported(l), 0),
    exception: Math.max(0, draw.requestedAmount - lines.reduce((s, l) => s + lineSupported(l), 0)),
    retainage: lines.reduce((s, l) => s + (l.retainageAmount ?? 0), 0),
    recommended: draw.recommendedAmount,
    lineCount: lines.length,
    pendingLines: lines.filter((l) => l.status === "PENDING").length,
    missingDocuments: missingRequiredDocuments(draw.id).length,
    evidenceLinks: repo.listDrawEvidenceLinks(draw.id).length,
    approval,
    approvalRecords: approval ? repo.listApprovalRecordsForRequest(approval.id) : [],
    ageDays: Math.max(0, Math.floor((Date.now() - Date.parse(anchor)) / 86_400_000)),
  };
}

/** Draws visible to a user across all projects (register). */
export function listDrawsForUser(user: User): DrawRequest[] {
  return repo.listDrawRequests().filter((d) => canAccessDraw(user, d));
}

/** Suggested next action shown on the register. Descriptive only. */
export function nextAction(draw: DrawRequest, summary?: DrawHeaderSummary): string {
  switch (draw.status) {
    case "DRAFT":
      return "Complete draft and submit";
    case "SUBMITTED":
      return "Begin line-item review";
    case "UNDER_REVIEW":
      return summary && summary.pendingLines > 0
        ? `Review ${summary.pendingLines} remaining line(s)`
        : summary && summary.missingDocuments > 0
          ? "Chase missing documents"
          : "Finalize recommendation";
    case "CLARIFICATION_REQUIRED":
      return "Awaiting requester response";
    case "READY_FOR_GOVERNANCE":
      return "Awaiting formal approvals";
    case "PARTIALLY_APPROVED":
    case "APPROVED":
      return "Release transition pending";
    case "RELEASED":
      return "Complete — no action";
    case "RETURNED":
      return "Requester to revise and resubmit";
    case "CANCELLED":
      return "Cancelled — no action";
  }
}
