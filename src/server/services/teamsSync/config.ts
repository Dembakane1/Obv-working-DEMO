/**
 * Microsoft Graph configuration — server-side only. Nothing here is ever
 * sent to the browser, logged, or included in API responses; UI and
 * health surfaces expose booleans only.
 *
 * OBV_GRAPH_BASE_URL / OBV_GRAPH_LOGIN_URL exist so the test suite can
 * point the provider at a contract-faithful local stub; production
 * deployments leave them at the Microsoft defaults.
 */
import { createHash } from "node:crypto";

export const GRAPH_CONFIG = {
  tenantId: () => process.env.MICROSOFT_TENANT_ID ?? "",
  clientId: () => process.env.MICROSOFT_CLIENT_ID ?? "",
  clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET ?? "",
  baseUrl: () => (process.env.OBV_GRAPH_BASE_URL ?? "https://graph.microsoft.com").replace(/\/$/, ""),
  loginUrl: () =>
    (process.env.OBV_GRAPH_LOGIN_URL ?? "https://login.microsoftonline.com").replace(/\/$/, ""),
  /** Public URL Graph calls back with change notifications. */
  webhookPublicUrl: () =>
    (
      process.env.OBV_TEAMS_WEBHOOK_PUBLIC_URL ??
      `${process.env.OBV_PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? ""}/api/teams-sync/notifications`
    ).replace(/^\/api/, "/api"),
  timeoutMs: () => {
    const n = Number(process.env.OBV_TEAMS_SYNC_TIMEOUT_MS ?? 8000);
    return Number.isFinite(n) && n > 0 ? n : 8000;
  },
  /** Optional key allowing an external scheduler to hit the maintenance
   *  endpoint without a session. */
  maintenanceKey: () => process.env.OBV_TEAMS_MAINTENANCE_KEY ?? "",
  configured(): boolean {
    return Boolean(this.tenantId() && this.clientId() && this.clientSecret());
  },
} as const;

/**
 * Graph clientState for webhook authenticity. Derived (not stored) so it
 * never appears in the database; verified on every inbound notification.
 */
export function webhookClientState(): string {
  return createHash("sha256")
    .update(`obv-teams-sync:${GRAPH_CONFIG.tenantId()}:${GRAPH_CONFIG.clientSecret()}`)
    .digest("hex")
    .slice(0, 32);
}
