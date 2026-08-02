/**
 * Official Source Connectors — service facade. Routes and pages import
 * ONLY from here. Raw repository reads are never exposed to a request;
 * every function on this surface is role-gated and tenant-scoped (or
 * pure config/doctrine).
 */
export {
  OfficialSourceError,
  SOURCE_DOCTRINE_NOTICE,
  canViewSources,
  canReviewSources,
  assertSourceViewer,
  assertSourceReviewer,
  requireVisibleProject,
  pollingEnabled,
  assertOfficialSourcesConfig,
  officialSourcesStartupNotice,
  freshnessLabel,
  ageLabel,
  type FreshnessLabel,
} from "./core";

export {
  ensureSourceRegistry,
  listSourceRegistry,
  getSourceView,
  checkSourceHealth,
  setSourceStatus,
  type SourceRegistryView,
} from "./registry";

export {
  refreshSource,
  refreshProject,
  refreshPortfolio,
  runScheduledPoll,
  listDeadLetterQueue,
  requeueDeadLetter,
  discardDeadLetter,
  setSourcePaused,
  resetRateLimiters,
  type RefreshSummary,
} from "./polling";

export {
  listQueue,
  queueStats,
  queueItemDetail,
  confirmAndAttach,
  rejectMatch,
  deferItem,
  requestManualVerification,
  recordDiscrepancy,
  promoteToException,
  projectSourceRecords,
  snapshotPreview,
  enqueueFromRetrieval,
  type QueueItemDetail,
} from "./review";

export { evaluateCandidate, type CandidateEvaluation } from "./matching";
export { detectChangesForRecord, recordUnavailable } from "./changes";
export { snapshotPayload, searchSource, fetchSourceRecord, fetchSourceChanges, performRetrieval } from "./retrieval";
export { officialSourceAnalytics, type OfficialSourceAnalytics } from "./analytics";
export { connectorFor, allConnectors, registerConnectorForTests, MOCK_SOURCE_ID } from "./connectors";
