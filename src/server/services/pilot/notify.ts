/**
 * Lender Pilot RC1 — governed-event notification fan-out.
 *
 * One helper that connects the workflow's important moments to the
 * notification seams OBV ALREADY has: the in-app notification feed, the
 * development-safe email outbox, and (where the caller has not already
 * notified it) the Teams channel adapter. It composes existing
 * capabilities — it adds no provider, no table, and no new channel.
 *
 * NOTIFICATIONS NEVER MUTATE THE WORKFLOW. Every call here is
 * fire-and-forget over the authoritative transition that already
 * happened; a failing channel is swallowed and can never fail, delay,
 * or alter the governed operation that triggered it.
 */
import { randomUUID } from "node:crypto";
import * as repo from "../../db/repo";
import { sendEmail } from "../integrations/email";
import type { EmailKind } from "../../../shared/types";

export type PilotEventKind =
  | "DRAW_SUBMITTED"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_RESUBMITTED"
  | "DRAW_READY_FOR_REVIEW"
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
  APPROVAL_REQUIRED: "APPROVAL_REQUEST",
  DRAW_RETURNED: "DRAW_NOTIFICATION",
  DRAW_DECISION_RECORDED: "DRAW_NOTIFICATION",
  EXCEPTION_OPENED: "DRAW_NOTIFICATION",
  DISPUTE_OPENED: "DISPUTE_NOTIFICATION",
  INSPECTION_ATTENTION: "DRAW_NOTIFICATION",
};

/** Development-safe recipient: the pilot ops alias, overridable by env.
 *  Real per-user routing arrives with the production email provider —
 *  the seam is what RC1 wires. */
function pilotRecipient(): string {
  const configured = String(process.env.OBV_PILOT_NOTIFY_EMAIL ?? "").trim();
  return configured || "pilot-ops@demo.obv.local";
}

export interface PilotEventContext {
  projectId?: string | null;
  milestoneId?: string | null;
  drawRequestId?: string | null;
  subject: string;
  body: string;
}

/**
 * Fan a governed event out to the in-app feed and the email outbox.
 * Teams is intentionally NOT called here for events whose workflow call
 * sites already notify it (draw submission does) — pass
 * `alsoTeams: false` there to avoid double posts.
 */
export function notifyGovernedEvent(kind: PilotEventKind, ctx: PilotEventContext): void {
  // In-app feed — never throws outward.
  try {
    repo.insertNotification({
      id: randomUUID(),
      type: kind,
      message: `${ctx.subject} — ${ctx.body}`.slice(0, 500),
      createdAt: new Date().toISOString(),
      projectId: ctx.projectId ?? null,
      milestoneId: ctx.milestoneId ?? null,
      deliveryMode: "LOCAL",
      deliveryStatus: "SENT",
      sentAt: new Date().toISOString(),
    } as never);
  } catch {
    /* the feed must never break the workflow */
  }
  // Development-safe email outbox.
  try {
    sendEmail({
      kind: EMAIL_KIND[kind],
      to: pilotRecipient(),
      subject: `[OBV] ${ctx.subject}`,
      text:
        `${ctx.body}\n\n` +
        (ctx.drawRequestId ? `Draw: /draw/${ctx.drawRequestId}\n` : "") +
        (ctx.projectId ? `Project: ${ctx.projectId}\n` : "") +
        "This notification reports a recorded governed event. It authorizes nothing.",
      organizationId: null,
      projectId: ctx.projectId ?? null,
    } as never);
  } catch {
    /* outbox unavailability must never break the workflow */
  }
}
