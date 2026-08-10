/**
 * Integrations core: typed error, provider configuration, role gates,
 * and the append-only integration audit recorder.
 *
 * DOCTRINE
 *  - Provider-NEUTRAL: business logic never branches on a vendor name.
 *    Vendors appear only inside adapter objects behind an interface.
 *  - DISABLED BOUNDARIES: every external-vendor adapter in this build
 *    refuses every call (no credentials exist here to configure them
 *    with). Selecting one requires BOTH the provider env var and
 *    OBV_INTEGRATIONS_PRODUCTION_ENABLE=true — the same double-consent
 *    the banking registry uses — and even then the adapter refuses.
 *  - OBSERVERS, NEVER AUTHORS: no integration writes to evidence,
 *    verification, ledger, approval, banking, or package tables.
 */
import { randomUUID } from "node:crypto";
import * as integrationsRepo from "../../db/integrationsRepo";
import type { IntegrationCategory, IntegrationOutcome, User } from "../../../shared/types";

export class IntegrationError extends Error {
  constructor(
    message: string,
    public statusCode = 400
  ) {
    super(message);
  }
}

export const nowIso = (): string => new Date().toISOString();
export const newRequestId = (): string => randomUUID();

// ------------------------------------------------------------ role gates

/** Integration configuration authority — the pilot-admin role. */
export function canManageIntegrations(user: User): boolean {
  return user.role === "PROJECT_MANAGER";
}

/** Read authority over the dashboard and integration state. */
export function canViewIntegrations(user: User): boolean {
  return ["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(user.role);
}

export function assertIntegrationViewer(user: User): void {
  if (!canViewIntegrations(user)) {
    throw new IntegrationError("Integrations are not available for this role", 403);
  }
}

export function assertIntegrationManager(user: User): void {
  // Viewer check first so FIELD gets the same 403 either way; managers
  // are a subset of viewers.
  assertIntegrationViewer(user);
  if (!canManageIntegrations(user)) {
    throw new IntegrationError("Integration changes require an administrator", 403);
  }
}

// ---------------------------------------------------------- configuration

export const EMAIL_PROVIDERS = ["outbox", "m365", "sendgrid", "mailgun", "ses", "postmark"] as const;
export const ESIGN_PROVIDERS = ["internal", "docusign", "dropbox_sign", "adobe_sign"] as const;
export const ACCOUNTING_PROVIDERS = ["csv", "quickbooks", "xero", "sage"] as const;

export interface IntegrationsConfig {
  emailProvider: (typeof EMAIL_PROVIDERS)[number];
  esignProvider: (typeof ESIGN_PROVIDERS)[number];
  accountingProvider: (typeof ACCOUNTING_PROVIDERS)[number];
  productionEnable: boolean;
  webhookDispatchIntervalMs: number;
  webhookMaxAttempts: number;
}

function pick<T extends readonly string[]>(
  name: string,
  allowed: T,
  fallback: T[number]
): T[number] {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new IntegrationError(
      `${name} must be one of: ${allowed.join(", ")} (got "${raw}")`,
      500
    );
  }
  return raw as T[number];
}

export function integrationsConfig(): IntegrationsConfig {
  const productionEnable = process.env.OBV_INTEGRATIONS_PRODUCTION_ENABLE === "true";
  const cfg: IntegrationsConfig = {
    emailProvider: pick("OBV_EMAIL_PROVIDER", EMAIL_PROVIDERS, "outbox"),
    esignProvider: pick("OBV_ESIGN_PROVIDER", ESIGN_PROVIDERS, "internal"),
    accountingProvider: pick("OBV_ACCOUNTING_PROVIDER", ACCOUNTING_PROVIDERS, "csv"),
    productionEnable,
    webhookDispatchIntervalMs: Number(process.env.OBV_WEBHOOK_DISPATCH_INTERVAL_MS ?? 0) || 0,
    webhookMaxAttempts: Math.min(10, Math.max(1, Number(process.env.OBV_WEBHOOK_MAX_ATTEMPTS ?? 5) || 5)),
  };
  // Selecting any external vendor is a production declaration and needs
  // the explicit second switch — refuse at startup, not at first use.
  const vendorChosen =
    cfg.emailProvider !== "outbox" || cfg.esignProvider !== "internal" || cfg.accountingProvider !== "csv";
  if (vendorChosen && !productionEnable) {
    throw new IntegrationError(
      "An external integration provider is configured but OBV_INTEGRATIONS_PRODUCTION_ENABLE is not 'true'. " +
        "This build refuses external providers without the explicit enablement switch — and its shipped " +
        "adapters are disabled boundaries that refuse every call regardless.",
      500
    );
  }
  return cfg;
}

/** Startup validation, alongside the banking/session/identity checks. */
export function assertIntegrationsConfig(): void {
  integrationsConfig();
}

export function integrationsStartupNotice(): string {
  const cfg = integrationsConfig();
  // Postmark is the one LIVE external adapter in this build; every other
  // external vendor remains a disabled boundary.
  const emailNote =
    cfg.emailProvider === "postmark"
      ? "email=postmark (LIVE transactional provider)"
      : `email=${cfg.emailProvider}`;
  return (
    `integrations: ${emailNote} esign=${cfg.esignProvider} ` +
    `accounting=${cfg.accountingProvider} (other external adapters are disabled boundaries)`
  );
}

// ------------------------------------------------------- audit recording

/** Append one immutable integration audit event and return its request id. */
export function recordIntegration(entry: {
  category: IntegrationCategory;
  provider: string;
  operation: string;
  outcome: IntegrationOutcome;
  actorUserId?: string | null;
  organizationId?: string | null;
  requestId?: string;
  subjectType?: string | null;
  subjectId?: string | null;
  detail?: string | null;
}): string {
  const requestId = entry.requestId ?? newRequestId();
  integrationsRepo.insertIntegrationEvent({
    id: randomUUID(),
    occurredAt: nowIso(),
    category: entry.category,
    provider: entry.provider,
    operation: entry.operation,
    actorUserId: entry.actorUserId ?? null,
    organizationId: entry.organizationId ?? null,
    requestId,
    outcome: entry.outcome,
    subjectType: entry.subjectType ?? null,
    subjectId: entry.subjectId ?? null,
    detail: entry.detail ?? null,
  });
  return requestId;
}
