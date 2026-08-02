/**
 * Provider-neutral OCR framework.
 *
 * The active provider is a DETERMINISTIC MOCK: it derives extracted text
 * and typed fields from a document's own recorded structured metadata,
 * with stable confidences — honest about being a stand-in, and stable
 * enough to test. Azure Document Intelligence, AWS Textract, and Google
 * Document AI are DISABLED BOUNDARIES: the adapters exist so a production
 * deployment plugs credentials into exactly one place, but in this build
 * every vendor call refuses. Extracted text, fields, and per-field
 * confidences are preserved verbatim.
 */
import * as evidenceIntelRepo from "../../db/evidenceIntelRepo";
import * as repo from "../../db/repo";
import type { DrawDocument, OcrDocKind, OcrExtraction, OcrField, OcrFieldKey } from "../../../shared/types";
import {
  EvidenceIntelError,
  documentContext,
  normalizeIdentifier,
  normalizeText,
  nowIso,
  ocrProviderName,
  sha256Hex,
} from "./core";

export interface ExtractedField {
  fieldKey: OcrFieldKey;
  value: string;
  confidence: number;
}

export interface OcrResult {
  docKind: OcrDocKind;
  rawText: string;
  overallConfidence: number;
  fields: ExtractedField[];
}

export interface OcrProvider {
  name: string;
  displayName: string;
  active: boolean;
  extract(doc: DrawDocument): OcrResult;
}

// ---------------------------------------------------- doc-kind mapping

const DOC_KIND: Record<string, OcrDocKind> = {
  CONTRACTOR_INVOICE: "INVOICE",
  MATERIAL_INVOICE: "INVOICE",
  PAY_APPLICATION: "INVOICE",
  LIEN_WAIVER: "LIEN_WAIVER",
  CONDITIONAL_LIEN_WAIVER: "LIEN_WAIVER",
  INSPECTION_REPORT: "INSPECTION",
  PERMIT: "PERMIT",
  CERTIFICATE: "PERMIT",
};

export function docKindFor(doc: DrawDocument): OcrDocKind {
  return DOC_KIND[doc.docType] ?? "OTHER";
}

// ------------------------------------------------------- mock provider

/** Derive fields from the document's recorded metadata. Absent metadata
 *  is simply omitted — never invented. */
function mockExtract(doc: DrawDocument): OcrResult {
  const kind = docKindFor(doc);
  const fields: ExtractedField[] = [];
  const add = (fieldKey: OcrFieldKey, value: unknown, confidence: number) => {
    const v = String(value ?? "").trim();
    if (v) fields.push({ fieldKey, value: v, confidence });
  };
  add("CONTRACTOR_NAME", doc.vendor, 0.92);
  add("INVOICE_NUMBER", doc.invoiceNumber, 0.9);
  if (typeof doc.amount === "number") add("TOTAL", String(doc.amount), 0.88);
  add("PERMIT_NUMBER", kind === "PERMIT" ? doc.referenceNumber : null, 0.9);
  add("DATE", doc.coveredThrough ?? doc.inspectionDate ?? doc.expiresAt, 0.8);
  add("ADDRESS", doc.issuingAuthority, 0.75);
  add("LINE_ITEM", doc.title, 0.7);

  const rawText = [
    `[${doc.docType}] ${doc.title}`,
    doc.vendor ? `Vendor: ${doc.vendor}` : null,
    doc.invoiceNumber ? `Invoice #: ${doc.invoiceNumber}` : null,
    typeof doc.amount === "number" ? `Amount: ${doc.amount}` : null,
    doc.referenceNumber ? `Reference: ${doc.referenceNumber}` : null,
    doc.coveredThrough ? `Covered through: ${doc.coveredThrough}` : null,
    doc.note ? `Note: ${doc.note}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const overall = fields.length
    ? Number((fields.reduce((s, f) => s + f.confidence, 0) / fields.length).toFixed(4))
    : 0.5;
  return { docKind: kind, rawText, overallConfidence: overall, fields };
}

function disabledProvider(name: string, displayName: string): OcrProvider {
  return {
    name,
    displayName,
    active: false,
    extract: () => {
      throw new EvidenceIntelError(
        `The ${displayName} OCR adapter is a disabled boundary in this build. ` +
          "It exists so production credentials can be configured in exactly one place; " +
          "no document can be sent to it.",
        503
      );
    },
  };
}

export const OCR_PROVIDER_CATALOG: OcrProvider[] = [
  { name: "mock", displayName: "Deterministic Mock OCR", active: true, extract: mockExtract },
  disabledProvider("azure_document_intelligence", "Azure Document Intelligence"),
  disabledProvider("aws_textract", "AWS Textract"),
  disabledProvider("google_document_ai", "Google Document AI"),
];

export function resolveOcrProvider(): OcrProvider {
  const name = ocrProviderName();
  return OCR_PROVIDER_CATALOG.find((p) => p.name === name)!;
}

// ---------------------------------------------- normalization + fingerprint

const NORMALIZE_AS_IDENTIFIER = new Set<OcrFieldKey>(["INVOICE_NUMBER", "PERMIT_NUMBER"]);

export function normalizeField(fieldKey: OcrFieldKey, value: string): string {
  if (NORMALIZE_AS_IDENTIFIER.has(fieldKey)) return normalizeIdentifier(value);
  if (fieldKey === "TOTAL") return String(Math.round(Number(value.replace(/[^0-9.-]/g, "")) || 0));
  return normalizeText(value);
}

/** The canonical fingerprint over normalized fields — two documents with
 *  the same salient content hash to the same value (the "reused document"
 *  signal). Order-independent so field ordering does not matter. */
export function fingerprintFields(fields: Array<{ fieldKey: OcrFieldKey; normalized: string }>): string {
  const canonical = fields
    .filter((f) => f.normalized)
    .map((f) => `${f.fieldKey}=${f.normalized}`)
    .sort()
    .join("|");
  return sha256Hex(canonical);
}

// ------------------------------------------------------------ persistence

/** Extract one document with the configured provider and persist the
 *  result (idempotent per subject+provider). Returns the stored
 *  extraction id. Pure analysis — never touches the document itself. */
export function extractDocument(doc: DrawDocument): string {
  const provider = resolveOcrProvider();
  const ctx = documentContext(doc);
  const result = provider.extract(doc);
  const extractionId = repo.newId();
  const fieldRows: OcrField[] = result.fields.map((f, i) => ({
    id: repo.newId(),
    extractionId,
    fieldKey: f.fieldKey,
    fieldValue: f.value,
    normalizedValue: normalizeField(f.fieldKey, f.value),
    confidence: f.confidence,
    sort: i,
  }));
  const fingerprint = fingerprintFields(
    fieldRows.map((f) => ({ fieldKey: f.fieldKey, normalized: f.normalizedValue ?? "" }))
  );
  const extraction: OcrExtraction = {
    id: extractionId,
    subjectType: "DOCUMENT",
    subjectId: doc.id,
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    docKind: result.docKind,
    provider: provider.name,
    status: "COMPLETED",
    rawText: result.rawText,
    overallConfidence: result.overallConfidence,
    fingerprint,
    extractedAt: nowIso(),
  };
  evidenceIntelRepo.saveExtraction(extraction, fieldRows);
  const stored = evidenceIntelRepo.listExtractionsForSubject("DOCUMENT", doc.id).find((e) => e.provider === provider.name);
  return stored ? stored.id : extractionId;
}
