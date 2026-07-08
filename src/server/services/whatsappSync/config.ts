/**
 * WhatsApp Business Cloud API configuration — server-side only. No token
 * ever reaches the browser, page HTML, logs, or API responses; surfaces
 * expose booleans and sanitized categories only.
 *
 * OBV_WHATSAPP_API_BASE_URL exists so the contract-stub test suite can
 * point the provider at a local stub; production leaves it at Meta's
 * graph endpoint.
 */
export const WHATSAPP_CONFIG = {
  accessToken: () => process.env.WHATSAPP_ACCESS_TOKEN ?? "",
  phoneNumberId: () => process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
  businessAccountId: () => process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? "",
  webhookVerifyToken: () => process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? "",
  appSecret: () => process.env.WHATSAPP_APP_SECRET ?? "",
  baseUrl: () =>
    (process.env.OBV_WHATSAPP_API_BASE_URL ?? "https://graph.facebook.com").replace(/\/$/, ""),
  apiVersion: () => process.env.WHATSAPP_API_VERSION ?? "v21.0",
  timeoutMs: () => {
    const n = Number(process.env.WHATSAPP_SYNC_TIMEOUT_MS ?? 8000);
    return Number.isFinite(n) && n > 0 ? n : 8000;
  },
  /** Max accepted media size (bytes) for communication attachments. */
  maxMediaBytes: () => 16 * 1024 * 1024,
  configured(): boolean {
    return Boolean(
      this.accessToken() &&
        this.phoneNumberId() &&
        this.webhookVerifyToken() &&
        this.appSecret()
    );
  },
  /** Service-window hours for free-form outbound (Meta policy: 24h). */
  serviceWindowHours: () => 24,
} as const;
