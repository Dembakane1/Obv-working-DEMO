/**
 * Duplicate + document-intelligence detectors.
 *
 * Every detector COMPARES already-derived analysis outputs (metadata
 * facts, OCR extractions) that were populated earlier in the same
 * analysis pass, and emits explainable advisory findings. All comparison
 * is strictly within one organization: a hash or identifier that also
 * appears under a different tenant is never surfaced, preserving tenant
 * isolation. Nothing here reads a control decision or writes one.
 */
import * as repo from "../../db/repo";
import * as evidenceIntelRepo from "../../db/evidenceIntelRepo";
import type {
  DrawDocument,
  EvidenceItem,
  EvidenceMetadataFacts,
  EvidenceSignalCategory,
  OcrExtraction,
} from "../../../shared/types";
import { documentContext, projectContext, type SignalDraft } from "./core";
import { docKindFor } from "./ocr";

// ------------------------------------------------------ evidence duplicates

/** Duplicate-file findings for one evidence item, by exact content hash.
 *  Peers are restricted to the projects the analyzing user can see, so a
 *  collision under a project outside their access is never surfaced. */
export function evidenceDuplicateFindings(
  evidence: EvidenceItem,
  facts: EvidenceMetadataFacts,
  allowedProjectIds: Set<string>
): SignalDraft[] {
  if (!facts.contentHash || !facts.organizationId) return [];
  const peers = evidenceIntelRepo
    .listMetadataByHash(facts.contentHash)
    .filter(
      (m) => m.evidenceItemId !== evidence.id && m.organizationId === facts.organizationId &&
        (!m.projectId || allowedProjectIds.has(m.projectId))
    );
  if (peers.length === 0) return [];

  const myContractor = facts.projectId ? projectContext(facts.projectId).contractorOrgId : null;
  // A peer only counts as "different contractor" when BOTH sides actually
  // name a contractor and they differ — a null on either side is not a
  // different contractor (mirrors the devicePatternFindings guard).
  const crossContractor = peers.filter((p) => {
    const c = p.projectId ? projectContext(p.projectId).contractorOrgId : null;
    return p.projectId !== facts.projectId && !!myContractor && !!c && c !== myContractor;
  });
  const crossProject = peers.filter((p) => p.projectId !== facts.projectId);
  const base = {
    subjectType: "EVIDENCE_ITEM" as const,
    subjectId: evidence.id,
    organizationId: facts.organizationId,
    projectId: facts.projectId,
  };
  const asRecords = (list: typeof peers) =>
    list.map((p) => ({ evidenceItemId: p.evidenceItemId, projectId: p.projectId }));
  const related = asRecords(peers);

  if (crossContractor.length > 0) {
    const matches = asRecords(crossContractor); // exactly the different-contractor peers
    return [{
      ...base,
      category: "CROSS_CONTRACTOR_DUPLICATE",
      severity: "HIGH",
      confidence: 0.9,
      title: "Identical photo appears under a different contractor",
      explanation:
        "This photo's content hash is byte-for-byte identical to evidence recorded under a different contractor " +
        "in your portfolio. The same image standing in for two contractors' work is worth a close look — though it " +
        "can happen legitimately (shared subcontractor, re-used stock photo). This is advisory, not a determination.",
      comparison: { contentHash: facts.contentHash, matches },
      recommendation: "Compare the two submissions side by side and confirm each contractor's work independently.",
      relatedRecords: matches,
      signalKey: `evi-dup-crosscontractor:${evidence.id}`,
    }];
  }
  if (crossProject.length > 0) {
    const matches = asRecords(crossProject); // exactly the other-project peers
    return [{
      ...base,
      category: "CROSS_PROJECT_DUPLICATE",
      severity: "MEDIUM",
      confidence: 0.85,
      title: "Identical photo appears on another project",
      explanation:
        "This photo's content hash matches evidence on a different project in your portfolio. Re-use across projects " +
        "is sometimes legitimate; it is surfaced so a reviewer can confirm the image actually depicts each project's work.",
      comparison: { contentHash: facts.contentHash, matches },
      recommendation: "Confirm the image depicts this project specifically before relying on it.",
      relatedRecords: matches,
      signalKey: `evi-dup-crossproject:${evidence.id}`,
    }];
  }
  return [{
    ...base,
    category: "DUPLICATE_FILE",
    severity: "LOW",
    confidence: 0.8,
    title: "Identical photo submitted more than once",
    explanation:
      "This photo's content hash matches another evidence item on the same project — the same file was submitted " +
      "more than once. Often a harmless re-upload; surfaced so a reviewer can avoid double-counting the same proof.",
    comparison: { contentHash: facts.contentHash, matches: related },
    recommendation: "Treat the duplicates as a single piece of evidence; no recapture needed.",
    relatedRecords: related,
    signalKey: `evi-dup-file:${evidence.id}`,
  }];
}

/** Device-pattern finding: the same capturing device across evidence from
 *  different contractors. Advisory INFO — a shared device is common on
 *  small projects and is never proof of anything. */
export function devicePatternFindings(
  evidence: EvidenceItem,
  facts: EvidenceMetadataFacts,
  allowedProjectIds: Set<string>
): SignalDraft[] {
  if (!facts.deviceFingerprint || !facts.organizationId) return [];
  const peers = evidenceIntelRepo
    .listMetadataByFingerprint(facts.deviceFingerprint)
    .filter(
      (m) => m.evidenceItemId !== evidence.id && m.organizationId === facts.organizationId &&
        (!m.projectId || allowedProjectIds.has(m.projectId))
    );
  const myContractor = facts.projectId ? projectContext(facts.projectId).contractorOrgId : null;
  const otherContractors = peers.filter((p) => {
    const c = p.projectId ? projectContext(p.projectId).contractorOrgId : null;
    return c && c !== myContractor;
  });
  if (otherContractors.length === 0) return [];
  return [{
    subjectType: "EVIDENCE_ITEM",
    subjectId: evidence.id,
    organizationId: facts.organizationId,
    projectId: facts.projectId,
    category: "DUPLICATE_DEVICE_PATTERN",
    severity: "INFO",
    confidence: 0.35,
    title: "Same capture device used across different contractors",
    explanation:
      "The device fingerprint on this evidence also appears on evidence attributed to a different contractor. " +
      "A shared device is common (a single site supervisor, a lent phone) and is NOT evidence of a problem. " +
      "Surfaced only for awareness.",
    comparison: { deviceFingerprint: facts.deviceFingerprint, otherContractorItems: otherContractors.length },
    recommendation: "No action required; note the shared device if contractor independence matters for this milestone.",
    relatedRecords: otherContractors.map((p) => ({ evidenceItemId: p.evidenceItemId, projectId: p.projectId })),
    signalKey: `evi-device-pattern:${evidence.id}`,
  }];
}

// ------------------------------------------------------ document duplicates

const DUP_CATEGORY_BY_KIND: Record<string, EvidenceSignalCategory> = {
  INVOICE: "DUPLICATE_INVOICE",
  RECEIPT: "DUPLICATE_RECEIPT",
  PERMIT: "DUPLICATE_PERMIT",
  LIEN_WAIVER: "DUPLICATE_LIEN_WAIVER",
};

/** Human labels for the OCR fields that can form a document fingerprint, so
 *  a reused-document explanation names exactly what was compared. */
const OCR_FIELD_LABEL: Record<string, string> = {
  CONTRACTOR_NAME: "contractor name",
  INVOICE_NUMBER: "invoice number",
  TOTAL: "total",
  PERMIT_NUMBER: "permit number",
  DATE: "date",
  ADDRESS: "address",
  LINE_ITEM: "line item",
};

/** Findings for one document, comparing its OCR fingerprint and salient
 *  fields against other documents in the same organization. */
export function documentDuplicateFindings(
  doc: DrawDocument,
  extraction: OcrExtraction,
  allowedProjectIds: Set<string>
): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  const ctx = documentContext(doc);
  if (!ctx.organizationId) return drafts;
  const orgIds = [ctx.organizationId];
  const visible = (projectId: string | null) => !projectId || allowedProjectIds.has(projectId);
  const base = {
    subjectType: "DOCUMENT" as const,
    subjectId: doc.id,
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
  };

  // Reused document — identical normalized content fingerprint.
  if (extraction.fingerprint) {
    const twins = evidenceIntelRepo
      .listExtractionsByFingerprint(extraction.fingerprint)
      .filter((e) => e.subjectId !== doc.id && e.organizationId === ctx.organizationId && visible(e.projectId));
    if (twins.length > 0) {
      const kind = docKindFor(doc);
      const category = DUP_CATEGORY_BY_KIND[kind] ?? "REUSED_DOCUMENT";
      // Name exactly the fields that formed the fingerprint, so the
      // explanation never asserts a field both documents actually lack.
      const matchedFieldKeys = evidenceIntelRepo
        .listFields(extraction.id)
        .filter((f) => f.normalizedValue)
        .map((f) => f.fieldKey);
      const fieldList = matchedFieldKeys.length
        ? matchedFieldKeys.map((k) => OCR_FIELD_LABEL[k] ?? k.toLowerCase().replace(/_/g, " ")).join(", ")
        : "extracted content";
      const matches = twins.map((t) => ({ documentId: t.subjectId, projectId: t.projectId }));
      drafts.push({
        ...base,
        category,
        severity: "HIGH",
        confidence: 0.88,
        title: `Document content matches ${twins.length} other document(s)`,
        explanation:
          `The extracted fields that define this document's content fingerprint (${fieldList}) are identical to ` +
          `${twins.length} other document(s) in your portfolio, so the same document appears to have been submitted ` +
          "more than once. Legitimate re-submission happens; surfaced so a reviewer can avoid paying twice.",
        comparison: { fingerprint: extraction.fingerprint, matchedFields: matchedFieldKeys, matches },
        recommendation: "Confirm this is a distinct document before it supports a distinct payment.",
        relatedRecords: matches,
        signalKey: `doc-reused:${doc.id}`,
      });
    }
  }

  // Duplicate invoice number (with contractor/total cross-checks).
  const fields = evidenceIntelRepo.listFields(extraction.id);
  const invoiceField = fields.find((f) => f.fieldKey === "INVOICE_NUMBER");
  if (invoiceField?.normalizedValue) {
    const matches = evidenceIntelRepo
      .findFieldMatches(orgIds, "INVOICE_NUMBER", invoiceField.normalizedValue)
      .filter((m) => m.extraction.subjectId !== doc.id && visible(m.extraction.projectId));
    if (matches.length > 0) {
      drafts.push({
        ...base,
        category: "DUPLICATE_INVOICE_NUMBER",
        severity: "MEDIUM",
        confidence: 0.8,
        title: `Invoice number "${invoiceField.fieldValue}" appears on ${matches.length} other document(s)`,
        explanation:
          `The invoice number "${invoiceField.fieldValue}" also appears on ${matches.length} other document(s) in ` +
          "your portfolio. Re-used invoice numbers can be innocuous (a vendor's own numbering reset) but are a common " +
          "double-billing pattern, so a reviewer should confirm each is a distinct charge.",
        comparison: { invoiceNumber: invoiceField.fieldValue, matches: matches.map((m) => ({ documentId: m.extraction.subjectId })) },
        recommendation: "Verify each invoice covers distinct work before both support payment.",
        relatedRecords: matches.map((m) => ({ documentId: m.extraction.subjectId, projectId: m.extraction.projectId })),
        signalKey: `doc-dup-invoiceno:${doc.id}`,
      });

      // Contractor-name conflict on a shared invoice number.
      const myVendor = fields.find((f) => f.fieldKey === "CONTRACTOR_NAME")?.normalizedValue ?? null;
      const conflicting = matches.filter((m) => {
        const theirVendor = evidenceIntelRepo
          .listFields(m.extraction.id)
          .find((f) => f.fieldKey === "CONTRACTOR_NAME")?.normalizedValue ?? null;
        return myVendor && theirVendor && theirVendor !== myVendor;
      });
      if (conflicting.length > 0) {
        drafts.push({
          ...base,
          category: "CONTRACTOR_NAME_CONFLICT",
          severity: "MEDIUM",
          confidence: 0.7,
          title: "Same invoice number, different contractor names",
          explanation:
            "Documents sharing this invoice number name different contractors. That inconsistency is worth a reviewer's " +
            "eye — a genuine invoice number is usually unique to one vendor. Advisory only.",
          comparison: { invoiceNumber: invoiceField.fieldValue, thisVendor: myVendor },
          recommendation: "Reconcile which contractor the invoice belongs to.",
          relatedRecords: conflicting.map((m) => ({ documentId: m.extraction.subjectId })),
          signalKey: `doc-contractor-conflict:${doc.id}`,
        });
      }

      // Total inconsistency on a shared invoice number.
      const myTotal = fields.find((f) => f.fieldKey === "TOTAL")?.normalizedValue ?? null;
      const differingTotals = matches.filter((m) => {
        const theirTotal = evidenceIntelRepo
          .listFields(m.extraction.id)
          .find((f) => f.fieldKey === "TOTAL")?.normalizedValue ?? null;
        return myTotal && theirTotal && theirTotal !== myTotal;
      });
      if (differingTotals.length > 0) {
        drafts.push({
          ...base,
          category: "TOTAL_INCONSISTENCY",
          severity: "MEDIUM",
          confidence: 0.7,
          title: "Same invoice number, different totals",
          explanation:
            "Documents sharing this invoice number carry different totals. A reviewer should confirm which amount is " +
            "correct before either supports a payment. Advisory only.",
          comparison: { invoiceNumber: invoiceField.fieldValue, thisTotal: myTotal },
          recommendation: "Confirm the correct amount and which document is authoritative.",
          relatedRecords: differingTotals.map((m) => ({ documentId: m.extraction.subjectId })),
          signalKey: `doc-total-inconsistency:${doc.id}`,
        });
      }
    }
  }

  // Duplicate permit number.
  const permitField = fields.find((f) => f.fieldKey === "PERMIT_NUMBER");
  if (permitField?.normalizedValue) {
    const matches = evidenceIntelRepo
      .findFieldMatches(orgIds, "PERMIT_NUMBER", permitField.normalizedValue)
      .filter((m) => m.extraction.subjectId !== doc.id && visible(m.extraction.projectId));
    if (matches.length > 0) {
      drafts.push({
        ...base,
        category: "DUPLICATE_PERMIT",
        severity: "LOW",
        confidence: 0.6,
        title: `Permit number "${permitField.fieldValue}" appears on ${matches.length} other document(s)`,
        explanation:
          "The same permit number appears on multiple documents. Often legitimate (one permit supports several draws), " +
          "surfaced so a reviewer can confirm the permit is being applied correctly across them.",
        comparison: { permitNumber: permitField.fieldValue, matches: matches.map((m) => ({ documentId: m.extraction.subjectId })) },
        recommendation: "Confirm the permit legitimately covers each referencing document.",
        relatedRecords: matches.map((m) => ({ documentId: m.extraction.subjectId })),
        signalKey: `doc-dup-permitno:${doc.id}`,
      });
    }
  }

  // Project-reference inconsistency: a document filed under one draw but
  // citing a line item that lives under a draw on a DIFFERENT project is a
  // structural data-entry artifact worth a reviewer's confirmation. The
  // line item's own draw is the genuinely independent project reference —
  // comparing the document's project to the project it was already resolved
  // through would always agree and detect nothing.
  if (doc.lineItemId && ctx.projectId) {
    const line = repo.getDrawLine(doc.lineItemId);
    const lineDraw = line ? repo.getDrawRequest(line.drawRequestId) : null;
    if (lineDraw && lineDraw.projectId !== ctx.projectId) {
      drafts.push({
        ...base,
        category: "PROJECT_REFERENCE_INCONSISTENCY",
        severity: "LOW",
        confidence: 0.55,
        title: "Document project reference is inconsistent",
        explanation:
          "This document is filed under a draw on one project, but the line item it cites belongs to a draw on a " +
          "different project. Usually a data-entry artifact; surfaced so a reviewer can confirm the document is filed " +
          "against the right project.",
        comparison: { documentProject: ctx.projectId, lineItemProject: lineDraw.projectId },
        recommendation: "Confirm the document is attached to the correct project's draw.",
        signalKey: `doc-project-inconsistency:${doc.id}`,
      });
    }
  }

  return drafts;
}
