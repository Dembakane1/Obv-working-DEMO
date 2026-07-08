/**
 * Microsoft Graph implementation of ExternalConversationProvider.
 *
 * ALL Graph-specific payload shapes are contained here. Errors are
 * sanitized to categories — provider bodies may contain internal detail
 * and are never propagated to callers, the UI, or client responses.
 * Tokens live only in this module's in-memory cache.
 */
import type { ExternalThreadBinding, MessageAttachment } from "../../../shared/types";
import { GRAPH_CONFIG } from "./config";
import {
  ConversationSyncError,
  ExternalConversationProvider,
  NormalizedInboundMessage,
  OutboundMessage,
  SubscriptionInfo,
} from "./types";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

/**
 * TWO credential strategies, modeled explicitly because real Microsoft
 * Graph does not allow one flow for everything:
 *
 *  READ strategy (client credentials / application permissions —
 *  ChannelMessage.Read.All or team-scoped RSC ChannelMessage.Read.Group):
 *  message fetch, change-notification subscriptions, team/channel
 *  verification, identity lookups.
 *
 *  SEND strategy (delegated ChannelMessage.Send via the dedicated OBV
 *  service account's refresh token): channel message creation.
 *  Application permissions CANNOT create channel messages outside
 *  migration mode, and OBV never uses migration permissions — an
 *  "app-test" send mode exists solely for the contract stub and is
 *  hard-blocked against real Graph (see GRAPH_CONFIG.sendCapability).
 */
let readTokenCache: TokenCache | null = null;
let sendTokenCache: TokenCache | null = null;
/** Azure rotates refresh tokens; keep the newest in memory (the env value
 *  remains the durable fallback until the admin rotates it). */
let currentRefreshToken: string | null = null;

async function graphFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? GRAPH_CONFIG.timeoutMs());
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new ConversationSyncError("timeout", true);
    }
    throw new ConversationSyncError("network", true);
  } finally {
    clearTimeout(timer);
  }
}

async function tokenRequest(form: Record<string, string>): Promise<TokenCache & { refreshToken?: string }> {
  const res = await graphFetch(
    `${GRAPH_CONFIG.loginUrl()}/${encodeURIComponent(GRAPH_CONFIG.tenantId())}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    }
  );
  if (!res.ok) {
    // Token endpoint bodies can include descriptive detail — never
    // propagate them. Category only.
    throw new ConversationSyncError(res.status >= 500 ? "provider-5xx" : "auth", res.status >= 500);
  }
  const data = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  } | null;
  if (!data?.access_token) throw new ConversationSyncError("invalid-response", false);
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    refreshToken: data.refresh_token,
  };
}

/** READ credential strategy: application permissions (client credentials). */
async function readAccessToken(): Promise<string> {
  if (!GRAPH_CONFIG.configured()) throw new ConversationSyncError("not-configured", false);
  if (readTokenCache && readTokenCache.expiresAt > Date.now() + 60_000) {
    return readTokenCache.accessToken;
  }
  readTokenCache = await tokenRequest({
    client_id: GRAPH_CONFIG.clientId(),
    client_secret: GRAPH_CONFIG.clientSecret(),
    scope: `${GRAPH_CONFIG.baseUrl()}/.default`,
    grant_type: "client_credentials",
  });
  return readTokenCache.accessToken;
}

/** SEND credential strategy: delegated ChannelMessage.Send (service
 *  account refresh token), or the stub-only app-test mode. */
async function sendAccessToken(): Promise<string> {
  const capability = GRAPH_CONFIG.sendCapability();
  if (capability === "none") throw new ConversationSyncError("send-not-authorized", false);
  if (capability === "app-test") return readAccessToken(); // stub only — guarded in config
  if (sendTokenCache && sendTokenCache.expiresAt > Date.now() + 60_000) {
    return sendTokenCache.accessToken;
  }
  const result = await tokenRequest({
    client_id: GRAPH_CONFIG.clientId(),
    client_secret: GRAPH_CONFIG.clientSecret(),
    scope: `${GRAPH_CONFIG.baseUrl()}/ChannelMessage.Send offline_access`,
    grant_type: "refresh_token",
    refresh_token: currentRefreshToken ?? GRAPH_CONFIG.sendRefreshToken(),
  });
  if (result.refreshToken) currentRefreshToken = result.refreshToken; // rotation
  sendTokenCache = result;
  return sendTokenCache.accessToken;
}

async function authed(
  method: string,
  path: string,
  body?: unknown,
  strategy: "read" | "send" = "read"
): Promise<Record<string, unknown>> {
  const token = strategy === "send" ? await sendAccessToken() : await readAccessToken();
  const res = await graphFetch(`${GRAPH_CONFIG.baseUrl()}/v1.0${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.status === 403) {
    if (strategy === "send") sendTokenCache = null;
    else readTokenCache = null; // force re-auth next attempt
    throw new ConversationSyncError("auth", false);
  }
  if (!res.ok) {
    throw new ConversationSyncError(
      res.status >= 500 ? "provider-5xx" : "provider-4xx",
      res.status >= 500
    );
  }
  if (res.status === 204) return {};
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (json === null) throw new ConversationSyncError("invalid-response", false);
  return json;
}

/** Strip provider HTML to plain coordination text (chat stores text). */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim()
    .slice(0, 4000);
}

function escHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class TeamsConversationProvider implements ExternalConversationProvider {
  configured(): boolean {
    return GRAPH_CONFIG.configured();
  }

  async sendMessage(binding: ExternalThreadBinding, message: OutboundMessage): Promise<string> {
    const path = binding.rootMessageId
      ? `/teams/${binding.teamId}/channels/${binding.channelId}/messages/${binding.rootMessageId}/replies`
      : `/teams/${binding.teamId}/channels/${binding.channelId}/messages`;
    const attribution = message.senderRoleTitle
      ? `${message.senderDisplayName} (${message.senderRoleTitle}) via OBV`
      : `${message.senderDisplayName} via OBV`;
    const result = await authed(
      "POST",
      path,
      {
        body: {
          contentType: "html",
          content: `<p><b>${escHtml(attribution)}</b></p><p>${escHtml(message.text).replace(/\n/g, "<br/>")}</p>`,
        },
      },
      "send" // delegated ChannelMessage.Send — never app permissions on real Graph
    );
    const id = result.id;
    if (typeof id !== "string" || !id) throw new ConversationSyncError("invalid-response", false);
    return id;
  }

  async fetchMessage(
    binding: ExternalThreadBinding,
    externalMessageId: string,
    changeType: NormalizedInboundMessage["changeType"]
  ): Promise<NormalizedInboundMessage> {
    const raw = await authed(
      "GET",
      `/teams/${binding.teamId}/channels/${binding.channelId}/messages/${externalMessageId}`
    );
    const from = (raw.from ?? {}) as { user?: { id?: string; displayName?: string } };
    const bodyObj = (raw.body ?? {}) as { content?: string; contentType?: string };
    const attachments = Array.isArray(raw.attachments)
      ? (raw.attachments as Array<{ name?: string; contentUrl?: string }>)
          .map((a): MessageAttachment => ({
            name: String(a.name ?? "attachment").slice(0, 200),
            url: typeof a.contentUrl === "string" ? a.contentUrl : null,
          }))
          .slice(0, 10)
      : [];
    const deletedFlag = Boolean(raw.deletedDateTime);
    return {
      externalMessageId,
      changeType: deletedFlag ? "deleted" : changeType,
      senderExternalId: from.user?.id ?? null,
      senderDisplayName: String(from.user?.displayName ?? "Microsoft Teams user").slice(0, 120),
      body:
        bodyObj.contentType === "html"
          ? htmlToText(String(bodyObj.content ?? ""))
          : String(bodyObj.content ?? "").slice(0, 4000),
      createdAt: String(raw.createdDateTime ?? new Date().toISOString()),
      attachments,
    };
  }

  async createSubscription(
    binding: ExternalThreadBinding,
    notificationUrl: string,
    clientState: string
  ): Promise<SubscriptionInfo> {
    // Graph caps channel-message subscriptions at ~1 hour; request one
    // hour and rely on renewal.
    const expires = new Date(Date.now() + 55 * 60_000).toISOString();
    const result = await authed("POST", "/subscriptions", {
      changeType: "created,updated,deleted",
      notificationUrl,
      resource: `/teams/${binding.teamId}/channels/${binding.channelId}/messages`,
      expirationDateTime: expires,
      clientState,
    });
    if (typeof result.id !== "string") throw new ConversationSyncError("invalid-response", false);
    return {
      subscriptionId: result.id,
      expiresAt: String(result.expirationDateTime ?? expires),
    };
  }

  async renewSubscription(subscriptionId: string): Promise<SubscriptionInfo> {
    const expires = new Date(Date.now() + 55 * 60_000).toISOString();
    const result = await authed("PATCH", `/subscriptions/${subscriptionId}`, {
      expirationDateTime: expires,
    });
    return {
      subscriptionId,
      expiresAt: String(result.expirationDateTime ?? expires),
    };
  }

  async deleteSubscription(subscriptionId: string): Promise<void> {
    try {
      await authed("DELETE", `/subscriptions/${subscriptionId}`);
    } catch {
      /* best-effort on disconnect */
    }
  }

  /** Verify the team exists and is readable; returns its display name. */
  async verifyTeam(teamId: string): Promise<string> {
    const t = await authed("GET", `/teams/${teamId}`);
    return String(t.displayName ?? teamId).slice(0, 120);
  }

  /** Verify the channel exists in the team; returns its display name. */
  async verifyChannel(teamId: string, channelId: string): Promise<string> {
    const c = await authed("GET", `/teams/${teamId}/channels/${channelId}`);
    return String(c.displayName ?? channelId).slice(0, 120);
  }

  /** What outbound capability the current configuration provides. */
  sendCapability(): "delegated" | "app-test" | "none" {
    return GRAPH_CONFIG.sendCapability();
  }
}

export const teamsConversationProvider: ExternalConversationProvider =
  new TeamsConversationProvider();

/** Test-only: clear the token caches between stub scenarios. */
export function _resetTokenCache(): void {
  readTokenCache = null;
  sendTokenCache = null;
  currentRefreshToken = null;
}
