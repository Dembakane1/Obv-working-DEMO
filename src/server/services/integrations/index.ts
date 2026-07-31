/**
 * Production Integrations Platform facade. Routes and server.ts import
 * from HERE. Every module observes the verified system of record and
 * never authors it; external-vendor adapters are disabled boundaries.
 */
export {
  IntegrationError,
  assertIntegrationsConfig,
  integrationsConfig,
  integrationsStartupNotice,
  canManageIntegrations,
  canViewIntegrations,
  assertIntegrationManager,
  assertIntegrationViewer,
  recordIntegration,
  EMAIL_PROVIDERS,
  ESIGN_PROVIDERS,
  ACCOUNTING_PROVIDERS,
} from "./core";
export {
  sendEmail,
  composeEmail,
  resolveEmailProvider,
  EMAIL_PROVIDER_CATALOG,
  type EmailMessage,
  type EmailProvider,
} from "./email";
export { buildIcs, outlookGraphProvider } from "./outlook";
export { buildTeamsCard, TEAMS_EVENT_KINDS, type TeamsEventKind, type TeamsCardInput } from "./teamsIntegration";
export {
  createSignatureRequest,
  settleSignatureRequest,
  listSignatureRequests,
  signatureRequestDetail,
  requesterName,
  resolveEsignProvider,
  ESIGN_PROVIDER_CATALOG,
} from "./esign";
export {
  createCalendarEvent,
  setCalendarEventStatus,
  listCalendar,
  calendarEventForIcs,
  suggestedPermitDeadlines,
} from "./calendarSvc";
export {
  buildProjection,
  runExport,
  listSyncRuns,
  listLinks,
  resolveAccountingProvider,
  ACCOUNTING_PROVIDER_CATALOG,
} from "./accounting";
export {
  registerEndpoint,
  setEndpointActive,
  listEndpoints,
  listDeliveries,
  emitWebhookEvent,
  dispatchDueDeliveries,
  requeueDeadLetter,
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_EVENT_KINDS,
  SIGNATURE_TOLERANCE_SECONDS,
} from "./webhooks";
export { integrationsDashboard, type IntegrationsDashboard, type ProviderStatusView } from "./dashboard";
