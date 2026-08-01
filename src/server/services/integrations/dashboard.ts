/**
 * Integration dashboard aggregation: configured providers, connection
 * status, last sync, failures, retry queue, and provider health — all
 * derived on read. NO SECRETS: nothing in these view models carries a
 * webhook secret, an env value, or credential material of any kind.
 */
import * as integrationsRepo from "../../db/integrationsRepo";
import { TEAMS_CONFIG } from "../TeamsNotifier";
import { resolveBankingProvider, bankingMode } from "../banking/registry";
import type { User } from "../../../shared/types";
import { assertIntegrationViewer, integrationsConfig } from "./core";
import { EMAIL_PROVIDER_CATALOG, resolveEmailProvider } from "./email";
import { ESIGN_PROVIDER_CATALOG, resolveEsignProvider } from "./esign";
import { ACCOUNTING_PROVIDER_CATALOG, resolveAccountingProvider } from "./accounting";
import { outlookGraphProvider } from "./outlook";
import { TEAMS_EVENT_KINDS } from "./teamsIntegration";

export interface ProviderStatusView {
  category: string;
  provider: string;
  displayName: string;
  status: "ACTIVE" | "DISABLED_BOUNDARY" | "CONFIGURED" | "NOT_CONFIGURED";
  detail: string;
  alternatives: string[];
}

export interface IntegrationsDashboard {
  providers: ProviderStatusView[];
  email: { queued: number; sent: number; failed: number; lastFailureAt: string | null };
  webhooks: { queued: number; retry: number; delivered: number; deadLetter: number };
  lastEvents: ReturnType<typeof integrationsRepo.listIntegrationEvents>;
  failures: ReturnType<typeof integrationsRepo.listIntegrationEvents>;
  lastAccountingSync: { provider: string; status: string; startedAt: string } | null;
}

export function integrationsDashboard(actor: User): IntegrationsDashboard {
  assertIntegrationViewer(actor);
  const cfg = integrationsConfig();
  const email = resolveEmailProvider();
  const esign = resolveEsignProvider();
  const accounting = resolveAccountingProvider();
  const banking = resolveBankingProvider();
  const providers: ProviderStatusView[] = [
    {
      category: "EMAIL",
      provider: email.name,
      displayName: email.displayName,
      status: email.active ? "ACTIVE" : "DISABLED_BOUNDARY",
      detail: email.active
        ? "Outbound mail is recorded in the outbox (development delivery)."
        : "Adapter present; refuses every call until production credentials exist.",
      alternatives: EMAIL_PROVIDER_CATALOG.filter((p) => p.name !== email.name).map((p) => p.displayName),
    },
    {
      category: "OUTLOOK",
      provider: outlookGraphProvider.name,
      displayName: outlookGraphProvider.displayName,
      status: "DISABLED_BOUNDARY",
      detail: "ICS export is active for every event; the Graph adapter awaits credentials.",
      alternatives: ["ICS export (active, vendor-neutral)"],
    },
    {
      category: "TEAMS",
      provider: "adaptive_cards",
      displayName: "Microsoft Teams",
      status: TEAMS_CONFIG.configured() ? "CONFIGURED" : "NOT_CONFIGURED",
      detail: TEAMS_CONFIG.configured()
        ? "Webhook notifier configured; adaptive-card payload builders active."
        : `Payload builders active for ${TEAMS_EVENT_KINDS.length} event kinds; no webhook configured.`,
      alternatives: [],
    },
    {
      category: "ESIGN",
      provider: esign.name,
      displayName: esign.displayName,
      status: esign.active ? "ACTIVE" : "DISABLED_BOUNDARY",
      detail: esign.active
        ? "Requests tracked internally with a full audit trail."
        : "Adapter present; refuses every call until production credentials exist.",
      alternatives: ESIGN_PROVIDER_CATALOG.filter((p) => p.name !== esign.name).map((p) => p.displayName),
    },
    {
      category: "ACCOUNTING",
      provider: accounting.name,
      displayName: accounting.displayName,
      status: accounting.active ? "ACTIVE" : "DISABLED_BOUNDARY",
      detail: accounting.active
        ? "Export-only synchronization to CSV; OBV remains the system of record."
        : "Adapter present; refuses every call until production credentials exist.",
      alternatives: ACCOUNTING_PROVIDER_CATALOG.filter((p) => p.name !== accounting.name).map((p) => p.displayName),
    },
    {
      category: "BANKING",
      provider: banking.kind,
      displayName: `Banking (${banking.kind})`,
      status: banking.kind === "MOCK" ? "ACTIVE" : "DISABLED_BOUNDARY",
      detail:
        banking.kind === "MOCK"
          ? `Mock provider in ${bankingMode()} mode — no live money movement.`
          : "Non-mock adapters are disabled boundaries; live money movement stays off.",
      alternatives: ["Unit", "Treasury Prime", "Qolo"],
    },
    {
      category: "WEBHOOK",
      provider: "internal",
      displayName: "Outbound Webhooks",
      status: "ACTIVE",
      detail:
        cfg.webhookDispatchIntervalMs > 0
          ? `Dispatch every ${cfg.webhookDispatchIntervalMs} ms; signed, idempotent, dead-lettered after ${cfg.webhookMaxAttempts} attempts.`
          : `Manual/route-triggered dispatch; signed, idempotent, dead-lettered after ${cfg.webhookMaxAttempts} attempts.`,
      alternatives: [],
    },
  ];
  // EVERY aggregate below is scoped to the caller's organization. An
  // unscoped count here would be a cross-tenant activity oracle: audit
  // rows carry foreign entity ids and operation detail, and even bare
  // counters leak another lender's email volume and queue depth.
  const org = actor.organizationId;
  const failures = integrationsRepo
    .listIntegrationEvents({ organizationId: org, limit: 200 })
    .filter((e) => e.outcome === "FAILURE" || e.outcome === "DEAD_LETTER")
    .slice(0, 25);
  const emailStats = integrationsRepo.emailStatsForOrg(org);
  const lastFailure = integrationsRepo.listEmailsForOrg(org, { status: "FAILED", limit: 1 })[0] ?? null;
  const lastSync = integrationsRepo.listSyncRunsForOrgs([org], 1)[0] ?? null;
  return {
    providers,
    email: { ...emailStats, lastFailureAt: lastFailure?.createdAt ?? null },
    webhooks: integrationsRepo.webhookQueueStatsForOrg(org),
    lastEvents: integrationsRepo.listIntegrationEvents({ organizationId: org, limit: 25 }),
    failures,
    lastAccountingSync: lastSync
      ? { provider: lastSync.provider, status: lastSync.status, startedAt: lastSync.startedAt }
      : null,
  };
}
