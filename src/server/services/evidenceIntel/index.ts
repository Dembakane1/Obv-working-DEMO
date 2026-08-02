/**
 * Evidence Intelligence facade. Routes and server.ts import from HERE.
 *
 * Everything below ANALYZES the authoritative evidence, verification,
 * document, permit, and draw records and produces EXPLAINABLE, ADVISORY
 * outputs. Nothing here approves a draw, rejects evidence, releases
 * funds, changes project progress, or overrides a lender decision; a
 * finding becomes governed only when a reviewer promotes it.
 */
export {
  EvidenceIntelError,
  ADVISORY_NOTICE,
  assertEvidenceIntelConfig,
  evidenceIntelStartupNotice,
  ocrProviderName,
  canViewEvidenceIntel,
  canReviewEvidence,
  assertViewer,
  assertReviewer,
  evidenceContext,
  projectContext,
  documentContext,
  OCR_PROVIDERS,
} from "./core";
export { computeMetadataFacts, metadataFindings } from "./metadata";
export { extractDocument, resolveOcrProvider, OCR_PROVIDER_CATALOG, docKindFor } from "./ocr";
export {
  evidenceDuplicateFindings,
  devicePatternFindings,
  documentDuplicateFindings,
} from "./detectors";
export { scoreProject, scoreEvidenceItem, type EvidenceScore } from "./scoring";
export {
  FUTURE_AI_CATALOG,
  engineEnabled,
  runFutureEngine,
  futureAiReadiness,
} from "./futureAi";
export {
  analyzeProject,
  analyzePortfolio,
  analyzeEvidenceItem,
} from "./analyze";
export {
  enqueueSignal,
  listQueue,
  queueItemDetail,
  acknowledge,
  dismiss,
  promote,
  evidenceTimeline,
  signalsForSubject,
  type TimelineEntry,
} from "./review";
export { evidenceIntelDashboard, type EvidenceIntelDashboard } from "./dashboard";
export { evidenceAnalytics, type EvidenceAnalytics } from "./analytics";

// Direct repo re-exports the routes/pages need for read views.
// NOTE: the raw listSignalsForSubject is intentionally NOT re-exported —
// requests must go through the gated, tenant-scoped signalsForSubject.
export {
  getSignal,
  listExtractionsForSubject,
  listFields,
  getMetadataFacts,
} from "../../db/evidenceIntelRepo";
