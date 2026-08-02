/**
 * Evidence Intelligence core: typed error, configuration, role gates,
 * normalization helpers, subject resolution, and the append-only signal
 * recorder.
 *
 * DOCTRINE — every rule here is load-bearing:
 *  - Evidence Intelligence ANALYZES the authoritative records; it never
 *    creates evidence, verifications, ledger entries, approvals, account
 *    events, or documents, and it never writes to those tables.
 *  - Every output is ADVISORY. Nothing here approves a draw, rejects
 *    evidence, releases funds, changes project progress, or overrides a
 *    lender decision. A finding becomes governed only when a REVIEWER
 *    promotes it into a formal exception — never automatically.
 *  - Every finding is EXPLAINABLE: it states why it fired, what records
 *    were compared, a confidence, and a recommended reviewer action.
 */
import { createHash } from "node:crypto";
import * as repo from "../../db/repo";
import * as evidenceIntelRepo from "../../db/evidenceIntelRepo";
import * as authz from "../authz";
import type {
  DrawDocument,
  EvidenceSignal,
  EvidenceSignalCategory,
  EvidenceSignalSeverity,
  EvidenceSubjectType,
  Project,
  User,
} from "../../../shared/types";

export class EvidenceIntelError extends Error {
  constructor(
    message: string,
    public statusCode = 400
  ) {
    super(message);
  }
}

/** Stamped onto every advisory surface so no reader mistakes a signal for
 *  a control decision. */
export const ADVISORY_NOTICE =
  "Advisory analysis only. Evidence Intelligence never approves a draw, rejects evidence, releases funds, or changes project status. A finding becomes governed only when a reviewer promotes it into a formal exception.";

export const nowIso = (): string => new Date().toISOString();

// ------------------------------------------------------------ role gates

export function canViewEvidenceIntel(user: User): boolean {
  return ["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(user.role);
}

/** Reviewers who may act on the queue (acknowledge / dismiss / promote).
 *  Mirrors canManageExceptions so promotion authority is consistent. */
export function canReviewEvidence(user: User): boolean {
  return ["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(user.role);
}

export function assertViewer(user: User): void {
  if (!canViewEvidenceIntel(user)) {
    throw new EvidenceIntelError("Evidence Intelligence is not available for this role", 403);
  }
}

export function assertReviewer(user: User): void {
  assertViewer(user);
  if (!canReviewEvidence(user)) {
    throw new EvidenceIntelError("Evidence review actions require a reviewer role", 403);
  }
}

// ------------------------------------------------------- configuration

export const OCR_PROVIDERS = ["mock", "azure_document_intelligence", "aws_textract", "google_document_ai"] as const;
export type OcrProviderName = (typeof OCR_PROVIDERS)[number];

export function ocrProviderName(): OcrProviderName {
  const raw = (process.env.OBV_OCR_PROVIDER ?? "mock").trim().toLowerCase();
  if (!(OCR_PROVIDERS as readonly string[]).includes(raw)) {
    throw new EvidenceIntelError(
      `OBV_OCR_PROVIDER must be one of: ${OCR_PROVIDERS.join(", ")} (got "${raw}")`,
      500
    );
  }
  // The vendor adapters are disabled boundaries; selecting one requires
  // the same explicit second consent the integrations layer uses.
  if (raw !== "mock" && process.env.OBV_EVIDENCE_AI_PRODUCTION_ENABLE !== "true") {
    throw new EvidenceIntelError(
      "A vendor OCR provider is configured but OBV_EVIDENCE_AI_PRODUCTION_ENABLE is not 'true'. " +
        "This build refuses external OCR providers without the explicit switch — and its shipped adapters " +
        "are disabled boundaries that refuse every call regardless.",
      500
    );
  }
  return raw as OcrProviderName;
}

export function assertEvidenceIntelConfig(): void {
  ocrProviderName();
}

export function evidenceIntelStartupNotice(): string {
  return `evidence intelligence: advisory analysis active (OCR provider: ${ocrProviderName()}; future-AI engines disabled)`;
}

// ------------------------------------------------------------ hashing

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Casefold + collapse whitespace — the normalization every text
 *  comparison shares, so "INV-100" and " inv-100 " compare equal. */
export function normalizeText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Alphanumeric-only key for identifiers (invoice/permit numbers), so
 *  formatting differences do not hide a genuine duplicate. */
export function normalizeIdentifier(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ------------------------------------------------------ subject resolution

export interface SubjectContext {
  organizationId: string | null;
  projectId: string | null;
  contractorOrgId: string | null;
  contractorName: string | null;
}

/** Resolve the org / project / contractor an evidence item belongs to,
 *  by walking milestone -> project (never mutating anything). */
export function evidenceContext(evidenceItemId: string): SubjectContext | null {
  const evidence = repo.getEvidence(evidenceItemId);
  if (!evidence) return null;
  const milestone = repo.getMilestone(evidence.milestoneId);
  if (!milestone) return { organizationId: null, projectId: null, contractorOrgId: null, contractorName: null };
  return projectContext(milestone.projectId);
}

export function projectContext(projectId: string): SubjectContext {
  const project = repo.getProject(projectId);
  if (!project) return { organizationId: null, projectId, contractorOrgId: null, contractorName: null };
  const contractorOrgId = project.pilot?.contractorOrgId ?? null;
  const contractorName = contractorOrgId ? repo.getOrganization(contractorOrgId)?.name ?? null : null;
  return { organizationId: project.organizationId, projectId, contractorOrgId, contractorName };
}

/** Resolve a draw document's context via its draw request -> project. */
export function documentContext(doc: DrawDocument): SubjectContext {
  const draw = repo.getDrawRequest(doc.drawRequestId);
  if (!draw) return { organizationId: null, projectId: null, contractorOrgId: null, contractorName: doc.vendor ?? null };
  const ctx = projectContext(draw.projectId);
  // A document names its own vendor; prefer that as the contractor label.
  return { ...ctx, contractorName: doc.vendor ?? ctx.contractorName };
}

/** Every draw document across the projects a user may see. */
export function accessibleDocuments(user: User): DrawDocument[] {
  const out: DrawDocument[] = [];
  for (const project of authz.accessibleProjects(user)) {
    for (const draw of repo.listDrawRequestsForProject(project.id)) {
      out.push(...repo.listDrawDocuments(draw.id));
    }
  }
  return out;
}

/** Every evidence item across the projects a user may see. */
export function accessibleEvidence(user: User) {
  const out = [];
  for (const project of authz.accessibleProjects(user)) {
    for (const milestone of repo.listMilestones(project.id)) {
      out.push(...repo.listEvidenceForMilestone(milestone.id));
    }
  }
  return out;
}

// ------------------------------------------------------ signal recording

export interface SignalDraft {
  category: EvidenceSignalCategory;
  severity: EvidenceSignalSeverity;
  confidence: number;
  subjectType: EvidenceSubjectType;
  subjectId: string;
  organizationId: string | null;
  projectId: string | null;
  title: string;
  explanation: string;
  comparison?: unknown;
  recommendation: string;
  relatedRecords?: unknown;
  /** Idempotency key: one finding per (category + subjects). */
  signalKey: string;
}

/** Append one advisory finding (idempotent) and return the stored signal,
 *  or the existing one if this key already fired. Never throws on a
 *  duplicate — re-analysis is safe. */
export function recordSignal(draft: SignalDraft, runId: string | null): EvidenceSignal | null {
  const existing = evidenceIntelRepo.findSignalByKey(draft.signalKey);
  if (existing) return existing;
  const signal: EvidenceSignal = {
    id: repo.newId(),
    runId,
    occurredAt: nowIso(),
    category: draft.category,
    severity: draft.severity,
    confidence: Math.max(0, Math.min(1, draft.confidence)),
    subjectType: draft.subjectType,
    subjectId: draft.subjectId,
    organizationId: draft.organizationId,
    projectId: draft.projectId,
    title: draft.title,
    explanation: draft.explanation,
    comparison: draft.comparison ?? null,
    recommendation: draft.recommendation,
    relatedRecords: draft.relatedRecords ?? null,
    signalKey: draft.signalKey,
  };
  return evidenceIntelRepo.insertSignal(signal) ? signal : evidenceIntelRepo.findSignalByKey(draft.signalKey);
}

/** Same-404 helper: a project the caller cannot see is indistinguishable
 *  from one that does not exist. */
export function requireVisibleProject(user: User, projectId: string): Project {
  const project = repo.getProject(projectId);
  if (!project || !authz.accessibleProjectIds(user).has(project.id)) {
    throw new EvidenceIntelError("Not found", 404);
  }
  return project;
}
