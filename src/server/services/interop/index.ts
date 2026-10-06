/**
 * Infrastructure Interoperability — service facade. Routes and pages
 * import ONLY from here. Every function on this surface is role-gated and
 * tenant-scoped (or pure configuration / doctrine).
 *
 *   OC4IDS export            — standardized infrastructure disclosure from
 *                              authoritative OBV records, field by field.
 *   External observations    — provider-neutral field-data import that
 *                              stays UNVERIFIED until a reviewer decides,
 *                              then enters the existing evidence pipeline.
 *   Provider boundaries      — declared, NOT CONNECTED.
 */
export {
  InteropError,
  OC4IDS_NOTICE,
  FIELD_OBSERVATION_NOTICE,
  canViewInterop,
  canExportOc4ids,
  canImportObservations,
  canReviewObservations,
  assertInteropViewer,
  requireVisibleProject,
  oc4idsPublisherConfig,
  interopStartupNotice,
  type Oc4idsPublisherConfig,
} from "./core";

export {
  OC4IDS_VERSION,
  OC4IDS_PACKAGE_VERSION,
  OC4IDS_SCHEMA_COVERAGE,
  OC4IDS_PROJECT_SCHEMA,
  OC4IDS_PACKAGE_SCHEMA,
} from "./oc4ids/schema";
export { validateAgainst, canonicalJson, type ValidationReport } from "./oc4ids/validate";
export {
  OC4IDS_MAPPING_VERSION,
  EXCLUDED_OBV_INTELLIGENCE,
  mapProjectToOc4ids,
  type MappingResult,
  type MappedField,
  type OmittedField,
} from "./oc4ids/mapping";
export {
  previewOc4ids,
  exportOc4ids,
  listOc4idsExports,
  getOc4idsExport,
  oc4idsValidationReport,
  exportUrl,
  CORE_DISCLOSURE_FIELDS,
  type Oc4idsPreview,
  type Oc4idsStatus,
  type Oc4idsCoverage,
  type Oc4idsExportResult,
  type Oc4idsValidationDocument,
} from "./oc4ids/exportSvc";

export {
  FIELD_OBSERVATION_FORMAT,
  FIELD_OBSERVATION_FORMAT_VERSION,
  KOBO_SUBMISSIONS_FORMAT,
  ADAPTER_ID,
  IMPORT_LIMITS,
  parseImportEnvelope,
  sniffImage,
} from "./fieldObservations/format";
export { importObservations, matchObservation, type ImportSummary } from "./fieldObservations/ingest";
export {
  listProjectObservations,
  listObservationsForUser,
  observationStats,
  listImports,
  observationDetail,
  observationPhoto,
  assignObservationProject,
  acceptObservation,
  rejectObservation,
  deferObservation,
  noteObservation,
  type ObservationListRow,
  type ObservationDetail,
  type AcceptResult,
} from "./fieldObservations/review";
export {
  evidenceSourceLabel,
  evidenceProvenance,
  sourceLabelFor,
  providerDisplayName,
  OBV_CAPTURE_LABEL,
} from "./fieldObservations/provenance";
export { INTEROP_PROVIDER_SPECS, interopProviderReadiness } from "./fieldObservations/providers";
