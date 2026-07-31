/**
 * Notification Center — a per-user feed DERIVED from existing governed
 * records (system notifications, draw timelines, inspections, permits,
 * portfolio risk and fraud intelligence). The feed is never a second
 * source of truth: deleting every notification-center row changes no
 * business state. Per-user state is limited to preferences and read
 * receipts; digests compose the same feed into outbox emails.
 */
import type { Notification, User } from "../../../shared/types";
import * as repo from "../../db/repo";
import * as lrepo from "../../db/lenderRepo";
import * as prepo from "../../db/pilotOpsRepo";
import * as authz from "../authz";
import * as portfolio from "../portfolio";
import { PilotOpsError } from "./core";
import { addressForUser, sendTemplatedEmail } from "./email";

export interface FeedItem {
  key: string;
  type: string;
  title: string;
  body: string;
  href: string | null;
  at: string;
  read: boolean;
}

export const NOTIFICATION_TYPES = [
  "SYSTEM",
  "MENTION",
  "DRAW_SUBMITTED",
  "DRAW_APPROVED",
  "DRAW_REJECTED",
  "INSPECTION_SCHEDULED",
  "INSPECTION_COMPLETED",
  "PERMIT_ISSUE",
  "FRAUD_ALERT",
  "RISK_ALERT",
  "EXECUTIVE_SUMMARY",
] as const;

function drawEventType(type: string): { type: string; title: string } | null {
  if (type === "SUBMITTED" || type === "DRAW_SUBMITTED") return { type: "DRAW_SUBMITTED", title: "Draw submitted" };
  if (type === "APPROVED" || type === "DRAW_APPROVED" || type === "GOVERNANCE_APPROVED")
    return { type: "DRAW_APPROVED", title: "Draw approved" };
  if (type === "REJECTED" || type === "RETURNED" || type === "DRAW_REJECTED")
    return { type: "DRAW_REJECTED", title: "Draw returned" };
  return null;
}

/** Assemble the derived feed for a user (most recent first, capped). */
export function notificationFeed(user: User, limit = 50): { items: FeedItem[]; unread: number } {
  const prefs = prepo.getNotificationPrefs(user.id);
  const muted = new Set(prefs.mutedTypes);
  const readKeys = prepo.readKeysForUser(user.id);
  const items: FeedItem[] = [];
  const accessible = authz.accessibleProjects(user);
  const projectIds = new Set(accessible.map((p) => p.id));
  const projectName = new Map(accessible.map((p) => [p.id, p.name]));

  // System notifications (already project-scoped rows).
  for (const n of repo.listNotifications(100) as Notification[]) {
    if (n.projectId && !projectIds.has(n.projectId)) continue;
    const isMention = n.message.includes(`@${user.name}`);
    items.push({
      key: `sys:${n.id}`,
      type: isMention ? "MENTION" : "SYSTEM",
      title: isMention ? "You were mentioned" : n.type.replaceAll("_", " "),
      body: n.message,
      href: n.projectId ? `/project/${n.projectId}` : null,
      at: n.createdAt,
      read: readKeys.has(`sys:${n.id}`),
    });
  }

  for (const project of accessible) {
    // Draw lifecycle from the operational timeline.
    for (const draw of repo.listDrawRequestsForProject(project.id)) {
      for (const event of repo.listDrawEvents(draw.id)) {
        const mapped = drawEventType(event.type);
        if (!mapped) continue;
        items.push({
          key: `draw:${event.id}`,
          type: mapped.type,
          title: `${mapped.title} — #${draw.drawNumber}`,
          body: `${project.name}: ${event.detail}`,
          href: `/draw/${draw.id}`,
          at: event.createdAt,
          read: readKeys.has(`draw:${event.id}`),
        });
      }
    }
    // Independent inspections.
    for (const inspection of lrepo.listDrawInspectionsForProject(project.id)) {
      if (inspection.scheduledAt) {
        items.push({
          key: `insp-sched:${inspection.id}`,
          type: "INSPECTION_SCHEDULED",
          title: "Inspection scheduled",
          body: `${project.name}: draw inspection scheduled for ${inspection.scheduledAt.slice(0, 10)}`,
          href: `/draw/${inspection.drawRequestId}`,
          at: inspection.scheduledAt,
          read: readKeys.has(`insp-sched:${inspection.id}`),
        });
      }
      if (inspection.completedAt) {
        items.push({
          key: `insp-done:${inspection.id}`,
          type: "INSPECTION_COMPLETED",
          title: "Inspection completed",
          body: `${project.name}: draw inspection completed (${inspection.status})`,
          href: `/draw/${inspection.drawRequestId}`,
          at: inspection.completedAt,
          read: readKeys.has(`insp-done:${inspection.id}`),
        });
      }
    }
    // Permit trouble.
    for (const permit of repo.listPermitsForProject(project.id)) {
      if (["EXPIRED", "REVOKED", "SUSPENDED"].includes(permit.status)) {
        items.push({
          key: `permit:${permit.id}:${permit.status}`,
          type: "PERMIT_ISSUE",
          title: `Permit ${permit.status.toLowerCase()}`,
          body: `${project.name}: permit ${permit.permitNumber} is ${permit.status}`,
          href: `/project/${project.id}`,
          at: permit.updatedAt,
          read: readKeys.has(`permit:${permit.id}:${permit.status}`),
        });
      }
    }
  }

  // Portfolio intelligence alerts (viewer-gated; FIELD users skip them).
  if (user.role !== "FIELD") {
    const fraud = portfolio.fraud(user);
    for (const signal of fraud.signals.filter((sig) => sig.severity !== "LOW").slice(0, 10)) {
      const key = `fraud:${signal.code}:${signal.projectId ?? signal.entity ?? "portfolio"}`;
      items.push({
        key,
        type: "FRAUD_ALERT",
        title: `Fraud signal — ${signal.severity}`,
        body: signal.label + (signal.projectId ? ` (${projectName.get(signal.projectId) ?? signal.projectId})` : ""),
        href: "/executive",
        at: fraud.generatedAt,
        read: readKeys.has(key),
      });
    }
    const risk = portfolio.risk(user);
    for (const profile of risk.attention.slice(0, 10)) {
      const key = `risk:${profile.projectId}:${profile.band}`;
      items.push({
        key,
        type: "RISK_ALERT",
        title: `Portfolio risk — ${profile.band}`,
        body: `${profile.projectName} needs executive attention (risk ${profile.overallRisk}/100)`,
        href: `/project/${profile.projectId}`,
        at: risk.generatedAt,
        read: readKeys.has(key),
      });
    }
    const summaryKey = `exec-summary:${new Date().toISOString().slice(0, 10)}`;
    items.push({
      key: summaryKey,
      type: "EXECUTIVE_SUMMARY",
      title: "Executive summary available",
      body: portfolio.summary(user, "WEEKLY").headline,
      href: "/executive/summary",
      at: new Date().toISOString(),
      read: readKeys.has(summaryKey),
    });
  }

  const visible = items
    .filter((item) => !muted.has(item.type))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
  return { items: visible, unread: visible.filter((item) => !item.read).length };
}

export function markRead(user: User, key: string): void {
  if (!key || key.length > 200) throw new PilotOpsError("Unknown notification", 400);
  prepo.markNotificationRead(user.id, key);
}

export function markAllRead(user: User): number {
  const { items } = notificationFeed(user);
  let marked = 0;
  for (const item of items.filter((i) => !i.read)) {
    prepo.markNotificationRead(user.id, item.key);
    marked += 1;
  }
  return marked;
}

export function preferences(user: User): prepo.NotificationPrefs {
  return prepo.getNotificationPrefs(user.id);
}

export function updatePreferences(
  user: User,
  patch: Partial<Omit<prepo.NotificationPrefs, "userId" | "updatedAt">>
): prepo.NotificationPrefs {
  if (patch.mutedTypes) {
    const valid = new Set<string>(NOTIFICATION_TYPES);
    for (const type of patch.mutedTypes) {
      if (!valid.has(type)) throw new PilotOpsError(`Unknown notification type "${type}"`, 400);
    }
  }
  return prepo.upsertNotificationPrefs(user.id, patch);
}

/** Compose and send a digest email of the user's current unread feed. */
export function sendDigest(user: User, period: "DAILY" | "WEEKLY"): prepo.OutboxEmail | null {
  const prefs = prepo.getNotificationPrefs(user.id);
  if (period === "DAILY" && !prefs.dailyDigest) return null;
  if (period === "WEEKLY" && !prefs.weeklyDigest) return null;
  if (!prefs.email) return null;
  const { items, unread } = notificationFeed(user, 20);
  const lines = items
    .slice(0, 12)
    .map((item) => `- [${item.type}] ${item.title}: ${item.body}`)
    .join("\n");
  const summaryText =
    `${unread} unread notification(s).\n\n${lines || "Nothing new since your last digest."}`;
  const template = period === "DAILY" ? "DAILY_DIGEST" : "WEEKLY_PORTFOLIO_SUMMARY";
  return sendTemplatedEmail(
    template,
    { address: addressForUser(user), userId: user.id },
    { recipientName: user.name, summaryText },
    { type: "digest", id: `${user.id}:${period}` }
  );
}
