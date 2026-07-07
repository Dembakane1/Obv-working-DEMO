/**
 * Teams conversation-sync contracts.
 *
 * The OBV application depends on these normalized shapes — never on
 * Graph payload structures. Graph-specific code lives exclusively in
 * graphProvider.ts behind ExternalConversationProvider.
 */
import type { ExternalThreadBinding, MessageAttachment } from "../../../shared/types";

/** A provider message normalized for OBV consumption. */
export interface NormalizedInboundMessage {
  externalMessageId: string;
  changeType: "created" | "updated" | "deleted";
  senderExternalId: string | null; // null for app/bot-authored messages
  senderDisplayName: string;
  body: string;
  createdAt: string;
  attachments: MessageAttachment[];
}

export interface OutboundMessage {
  /** Plain coordination text (already trimmed/capped by OBV chat). */
  text: string;
  senderDisplayName: string;
  senderRoleTitle: string | null;
}

export interface SubscriptionInfo {
  subscriptionId: string;
  expiresAt: string;
}

/** Sanitized sync failure — category only, never tokens or secrets. */
export class ConversationSyncError extends Error {
  constructor(
    public category:
      | "not-configured"
      | "auth"
      | "timeout"
      | "network"
      | "provider-4xx"
      | "provider-5xx"
      | "invalid-response",
    public transient: boolean
  ) {
    super(`teams-sync:${category}`);
  }
}

/**
 * Provider-isolated conversation bridge surface. TEAMS today; the same
 * interface is the seam a future WhatsApp provider would implement.
 */
export interface ExternalConversationProvider {
  /** True when server-side credentials are configured. */
  configured(): boolean;
  /** Send a coordination message; returns the provider message id. */
  sendMessage(binding: ExternalThreadBinding, message: OutboundMessage): Promise<string>;
  /** Fetch + normalize one provider message (inbound notification path). */
  fetchMessage(
    binding: ExternalThreadBinding,
    externalMessageId: string,
    changeType: NormalizedInboundMessage["changeType"]
  ): Promise<NormalizedInboundMessage>;
  /** Create a change-notification subscription for the bound channel. */
  createSubscription(binding: ExternalThreadBinding, notificationUrl: string, clientState: string): Promise<SubscriptionInfo>;
  /** Extend an existing subscription. */
  renewSubscription(subscriptionId: string): Promise<SubscriptionInfo>;
  /** Best-effort subscription removal on disconnect. */
  deleteSubscription(subscriptionId: string): Promise<void>;
}
