/**
 * Governed-event notification fan-out with REAL recipient routing.
 *
 * Recipients are resolved deterministically from authoritative records
 * (project memberships, the draw's submitter, tenancy-scoped role
 * fallback — see recipients.ts). Each recipient gets:
 *
 *  - an ADDRESSED in-app notification row (MANDATORY — preferences can
 *    never mute the authoritative in-app record), carrying the
 *    deterministic "why this user" reason for operator visibility;
 *  - an OPTIONAL email through the configured provider, honoring the
 *    per-user EMAIL channel preference, deduplicated per
 *    event+subject+recipient so a retried workflow call cannot
 *    double-mail anyone. Demo-seeded users without a linked identity
 *    have no address and receive in-app only.
 *
 * One broadcast row (no recipient) is always recorded as well — it is
 * the event's tenant-visible feed entry and keeps the historical feed
 * shape. The legacy pilot ops alias remains ONLY as an explicit opt-in
 * (OBV_PILOT_NOTIFY_EMAIL) plus the demo default, so development
 * environments keep a single predictable mailbox.
 *
 * NOTIFICATIONS NEVER MUTATE THE WORKFLOW. Every call here is
 * fire-and-forget over the authoritative transition that already
 * happened; a failing channel is swallowed and can never fail, delay,
 * or alter the governed operation that triggered it.
 */
import { randomUUID } from "node:crypto";
import * as repo from "../../db/repo";
import { composeEmail, sendEmail } from "../integrations/email";
import { productionPosture } from "../posture";
import { resolveRecipients } from "./recipients";
import type { EmailKind } from "../../../shared/types";

export type PilotEventKind =
  | "DRAW_SUBMITTED"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_RESUBMITTED"
  | "DRAW_READY_FOR_REVIEW"
  | "DRAW_READINESS_HOLD"
  | "APPROVAL_REQUIRED"
  | "DRAW_RETURNED"
  | "DRAW_DECISION_RECORDED"
  | "EXCEPTION_OPENED"
  | "DISPUTE_OPENED"
  | "INSPECTION_ATTENTION";

const EMAIL_KIND: Record<PilotEventKind, EmailKind> = {
  DRAW_SUBMITTED: "DRAW_NOTIFICATION",
  EVIDENCE_MISSING: "DRAW_NOTIFICATION",
  EVIDENCE_RESUBMITTED: "DRAW_NOTIFICATION",
  DRAW_READY_FOR_REVIEW: "DRAW_NOTIFICATION",
  DRAW_READINESS_HOLD: "DRAW_NOTIFICATION",
  APPROVAL_REQUIRED: "APPROVAL_REQUEST",
  DRAW_RETURNED: "DRAW_NOTIFICATION",
  DRAW_DECISION_RECORDED: "DRAW_NOTIFICATION",
  EXCEPTION_OPENED: "DRAW_NOTIFICATION",
  DISPUTE_OPENED: "DISPUTE_NOTIFICATION",
  INSPECTION_ATTENTION: "DRAW_NOTIFICATION",
};

/**
 * Channel policy per event kind. In-app is MANDATORY for every kind —
 * the feed is the authoritative record and preferences cannot suppress
 * it. Email is OPTIONAL (per-user preference). Teams (where configured)
 * is notified by the workflow call sites that already do so; it remains
 * OPTIONAL and unchanged here.
 */
export const CHANNEL_POLICY: Record<PilotEventKind, { inApp: "MANDATORY"; email: "OPTIONAL" }> = {
  DRAW_SUBMITTED: { inApp: "MANDATORY", email: "OPTIONAL" },
  EVIDENCE_MISSING: { inApp: "MANDATORY", email: "OPTIONAL" },
  EVIDENCE_RESUBMITTED: { inApp: "MANDATORY", email: "OPTIONAL" },
  DRAW_READY_FOR_REVIEW: { inApp: "MANDATORY", email: "OPTIONAL" },
  DRAW_READINESS_HOLD: { inApp: "MANDATORY", email: "OPTIONAL" },
  APPROVAL_REQUIRED: { inApp: "MANDATORY", email: "OPTIONAL" },
  DRAW_RETURNED: { inApp: "MANDATORY", email: "OPTIONAL" },
  DRAW_DECISION_RECORDED: { inApp: "MANDATORY", email: "OPTIONAL" },
  EXCEPTION_OPENED: { inApp: "MANDATORY", email: "OPTIONAL" },
  DISPUTE_OPENED: { inApp: "MANDATORY", email: "OPTIONAL" },
  INSPECTION_ATTENTION: { inApp: "MANDATORY", email: "OPTIONAL" },
};

/** Development-safe ops alias. In demo posture it defaults on so local
 *  runs keep one predictable mailbox; in pilot/production it exists ONLY
 *  when an operator explicitly configures it. */
function pilotOpsAlias(): string | null {
  const configured = String(process.env.OBV_PILOT_NOTIFY_EMAIL ?? "").trim();
  if (configured) return configured;
  return productionPosture() ? null : "pilot-ops@demo.obv.local";
}

export interface PilotEventContext {
  projectId?: string | null;
  milestoneId?: string | null;
  drawRequestId?: string | null;
  subject: string;
  body: string;
}

function emailBody(ctx: PilotEventContext): string {
  return (
    `${ctx.body}\n\n` +
    (ctx.drawRequestId ? `Draw: /draw/${ctx.drawRequestId}\n` : "") +
    (ctx.projectId ? `Project: ${ctx.projectId}\n` : "") +
    "This notification reports a recorded governed event. It authorizes nothing."
  );
}

/**
 * Fan a governed event out: one broadcast feed row, one addressed in-app
 * row per resolved recipient, and optional per-recipient email.
 */
export function notifyGovernedEvent(kind: PilotEventKind, ctx: PilotEventContext): void {
  const now = () => new Date().toISOString();
  // Broadcast feed row — never throws outward.
  try {
    repo.insertNotification({
      id: randomUUID(),
      type: kind,
      message: `${ctx.subject} — ${ctx.body}`.slice(0, 500),
      createdAt: now(),
      projectId: ctx.projectId ?? null,
      milestoneId: ctx.milestoneId ?? null,
      deliveryMode: "LOCAL",
      deliveryStatus: "SENT",
      sentAt: now(),
    } as never);
  } catch {
    /* the feed must never break the workflow */
  }

  // Deterministic per-recipient fan-out.
  let recipients: ReturnType<typeof resolveRecipients> = [];
  try {
    recipients = resolveRecipients(kind, ctx);
  } catch {
    recipients = []; // resolution failure degrades to broadcast-only
  }
  for (const r of recipients) {
    try {
      repo.insertNotification({
        id: randomUUID(),
        type: kind,
        message: `${ctx.subject} — ${ctx.body}`.slice(0, 500),
        createdAt: now(),
        projectId: ctx.projectId ?? null,
        milestoneId: ctx.milestoneId ?? null,
        deliveryMode: "LOCAL",
        deliveryStatus: "SENT",
        sentAt: now(),
        recipientUserId: r.user.id,
        recipientReason: r.reason,
      } as never);
    } catch {
      /* in-app fan-out must never break the workflow */
    }
    if (!r.email) continue; // no linked identity — in-app only
    if (!repo.notificationChannelEnabled(r.user.id, "EMAIL")) continue;
    try {
      sendEmail({
        kind: EMAIL_KIND[kind],
        to: r.email,
        subject: `[OBV] ${ctx.subject}`,
        text: emailBody(ctx),
        organizationId: r.user.organizationId,
        projectId: ctx.projectId ?? null,
        dedupeKey: `${kind}:${ctx.drawRequestId ?? ctx.projectId ?? "global"}:${r.user.id}`,
      });
    } catch {
      /* recorded by the email layer; never breaks the workflow */
    }
  }

  // Development / explicitly-configured ops alias.
  const alias = pilotOpsAlias();
  if (alias) {
    try {
      sendEmail({
        kind: EMAIL_KIND[kind],
        to: alias,
        subject: `[OBV] ${ctx.subject}`,
        text: emailBody(ctx),
        organizationId: null,
        projectId: ctx.projectId ?? null,
      } as never);
    } catch {
      /* outbox unavailability must never break the workflow */
    }
  }
}

// Re-exported so routes and the readiness checklist can explain routing
// without importing the resolver directly.
export { resolveRecipients, RECIPIENT_RULES, type ResolvedRecipient } from "./recipients";
export { composeEmail };
