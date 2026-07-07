/**
 * TeamsNotifier — pushes governance events to an institutional Microsoft
 * Teams channel. Teams is a NOTIFICATION CHANNEL ONLY: it is not part of
 * the trust boundary, cannot approve funds, and its failure must never
 * block verification, ledger writes, approvals, release transitions, or
 * report generation.
 *
 * Implementations:
 *   WebhookTeamsNotifier  — posts Adaptive Cards to an incoming webhook
 *   MockTeamsNotifier     — demo mode (no webhook configured)
 *   ResilientTeamsNotifier— chooses the path, bounds time, records
 *                           provenance, and swallows every failure
 *
 * Security: the webhook URL is read from TEAMS_WEBHOOK_URL server-side,
 * never sent to the browser, never committed, and never logged in full
 * (host only). Failures are stored as sanitized categories.
 */
import * as repo from "../db/repo";
import type { AdaptiveCard } from "./teamsCards";
import type { Notification } from "../../shared/types";

export interface NotifyOptions {
  projectId?: string | null;
  milestoneId?: string | null;
  /** Structured Adaptive Card. Absent/null = in-app-feed-only event. */
  card?: AdaptiveCard | null;
}

export interface TeamsNotifier {
  notify(type: string, message: string, opts?: NotifyOptions): Promise<Notification>;
}

export const TEAMS_CONFIG = {
  webhookUrl: () => process.env.TEAMS_WEBHOOK_URL ?? "",
  timeoutMs: () => {
    const n = Number(process.env.TEAMS_NOTIFICATION_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : 5000;
  },
  configured: () => Boolean(process.env.TEAMS_WEBHOOK_URL),
};

function webhookHostForLog(): string {
  try {
    return new URL(TEAMS_CONFIG.webhookUrl()).host;
  } catch {
    return "invalid-url";
  }
}

export class TeamsDeliveryError extends Error {
  constructor(public category: string) {
    super(category);
  }
}

/** Posts one Adaptive Card to the configured incoming webhook. */
export class WebhookTeamsNotifier {
  async send(card: AdaptiveCard): Promise<void> {
    const url = TEAMS_CONFIG.webhookUrl();
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad protocol");
    } catch {
      throw new TeamsDeliveryError("invalid_webhook_url");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEAMS_CONFIG.timeoutMs());
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "message",
          attachments: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              contentUrl: null,
              content: card,
            },
          ],
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      throw new TeamsDeliveryError(
        (err as Error).name === "AbortError" ? "timeout" : "network_failure"
      );
    }
    clearTimeout(timer);
    if (!res.ok) {
      throw new TeamsDeliveryError(res.status >= 500 ? "http_5xx" : "http_4xx");
    }
  }
}

/** Demo mode: records the event, delivers nothing. */
export class MockTeamsNotifier implements TeamsNotifier {
  async notify(type: string, message: string, opts?: NotifyOptions): Promise<Notification> {
    const notification: Notification = {
      id: repo.newId(),
      type,
      message,
      createdAt: new Date().toISOString(),
      projectId: opts?.projectId ?? null,
      milestoneId: opts?.milestoneId ?? null,
      deliveryMode: "MOCK",
      deliveryStatus: "SKIPPED",
      sentAt: null,
      failureCategory: null,
    };
    repo.insertNotification(notification);
    console.log(`[TeamsNotifier demo mode] ${type}: ${message}`);
    return notification;
  }
}

/**
 * Resilient wrapper: attempts real delivery when a webhook is configured
 * and the event carries a card; always records provenance; never throws.
 */
export class ResilientTeamsNotifier implements TeamsNotifier {
  constructor(private webhook = new WebhookTeamsNotifier(), private mock = new MockTeamsNotifier()) {}

  async notify(type: string, message: string, opts?: NotifyOptions): Promise<Notification> {
    if (!TEAMS_CONFIG.configured()) {
      return this.mock.notify(type, message, opts);
    }
    // Webhook configured. Card-less events are in-app only (SKIPPED):
    // low-value internal events are deliberately not pushed to Teams.
    if (!opts?.card) {
      const notification: Notification = {
        id: repo.newId(),
        type,
        message,
        createdAt: new Date().toISOString(),
        projectId: opts?.projectId ?? null,
        milestoneId: opts?.milestoneId ?? null,
        deliveryMode: "TEAMS_WEBHOOK",
        deliveryStatus: "SKIPPED",
        sentAt: null,
        failureCategory: null,
      };
      repo.insertNotification(notification);
      return notification;
    }

    let status: Notification["deliveryStatus"] = "SENT";
    let failureCategory: string | null = null;
    let sentAt: string | null = null;
    try {
      await this.webhook.send(opts.card);
      sentAt = new Date().toISOString();
      console.log(`[TeamsNotifier] ${type} card sent to ${webhookHostForLog()}`);
    } catch (err) {
      status = "FAILED";
      failureCategory =
        err instanceof TeamsDeliveryError ? err.category : "unexpected_failure";
      // Sanitized operational log only — never the full URL or payload.
      console.log(`[TeamsNotifier] ${type} card delivery FAILED (${failureCategory}) host=${webhookHostForLog()}`);
    }
    const notification: Notification = {
      id: repo.newId(),
      type,
      message,
      createdAt: new Date().toISOString(),
      projectId: opts?.projectId ?? null,
      milestoneId: opts?.milestoneId ?? null,
      deliveryMode: "TEAMS_WEBHOOK",
      deliveryStatus: status,
      sentAt,
      failureCategory,
    };
    repo.insertNotification(notification);
    return notification;
  }
}

export const teamsNotifier: TeamsNotifier = new ResilientTeamsNotifier();
