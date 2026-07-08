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
  /** Delegated refresh token for the dedicated OBV send service account
   *  (ChannelMessage.Send). SECRET — server-side only. */
  sendRefreshToken: () => process.env.MICROSOFT_SEND_REFRESH_TOKEN ?? "",
  /**
   * Outbound send mode:
   *  - "delegated"  (default): delegated ChannelMessage.Send via the OBV
   *    service-account refresh token — the supported production path.
   *  - "app-test": application-permission send, ONLY valid against a
   *    non-Microsoft base URL (contract stub). Application permissions
   *    cannot create channel messages in real Graph outside migration
   *    mode, and OBV never uses migration permissions operationally.
   */
  sendMode: (): "delegated" | "app-test" =>
    process.env.OBV_TEAMS_SEND_MODE === "app-test" ? "app-test" : "delegated",
  /** True when the base URL points at real Microsoft Graph. */
  realGraph(): boolean {
    return this.baseUrl() === "https://graph.microsoft.com";
  },
  configured(): boolean {
    return Boolean(this.tenantId() && this.clientId() && this.clientSecret());
  },
  /** What outbound capability the current configuration provides. */
  sendCapability(): "delegated" | "app-test" | "none" {
    if (!this.configured()) return "none";
    if (this.sendMode() === "app-test") {
      // Hard guard: the unsupported app-permission send path can never
      // run against real Microsoft Graph.
      return this.realGraph() ? "none" : "app-test";
    }
    return this.sendRefreshToken() ? "delegated" : "none";
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
