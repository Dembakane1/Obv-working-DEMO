/**
 * WhatsAppFieldBridge — coordination-message sync between OBV threads
 * and WhatsApp participants.
 *
 * WHATSAPP COORDINATES. OBV EVIDENCE PROVES. VERIFICATION ASSESSES.
 * HUMANS AUTHORIZE THROUGH THE FORMAL APPROVAL WORKFLOW. THE LEDGER
 * RECORDS. CHAT DOES NOT RELEASE FUNDS.
 *
 * This module imports NOTHING from the approval workflow, verification
 * pipeline, or VirtualAccountService: an inbound WhatsApp message —
 * whatever it says, whatever media it carries — can only ever become a
 * ChatMessage row with communication attachments. Evidence enters OBV
 * exclusively through the governed submission workflow (including the
 * explicit, human-driven Promote-to-Evidence-Draft flow, which itself
 * ends in the NORMAL pipeline).
 *
 * Loop prevention mirrors the Teams bridge: origin WHATSAPP_INBOUND is
 * never an outbound candidate; stored external ids dedupe replays and
 * echoes; the (thread_id, external_message_id) unique index backstops.
 */
import * as repo from "../../db/repo";
import type {
  ChatMessage,
  ConversationThread,
  ExternalParticipantContext,
  User,
} from "../../../shared/types";
import { WHATSAPP_CONFIG } from "./config";
import {
  WhatsAppInbound,
  WhatsAppStatusUpdate,
  WhatsAppSyncError,
  downloadMedia,
  sendTemplate,
  sendText,
} from "./provider";

export function whatsappConfigured(): boolean {
  return WHATSAPP_CONFIG.configured();
}

/** WhatsApp tenant key = the business account id. */
function tenantId(): string {
  return WHATSAPP_CONFIG.businessAccountId() || "whatsapp";
}

// ---------------------------------------------------- rate limiting
// Small in-memory per-sender bucket: 30 inbound messages / 5 minutes.
const rateBuckets = new Map<string, { count: number; windowStart: number }>();
export function rateLimited(phone: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(phone);
  if (!bucket || now - bucket.windowStart > 5 * 60_000) {
    rateBuckets.set(phone, { count: 1, windowStart: now });
    return false;
  }
  bucket.count++;
  return bucket.count > 30;
}

// ------------------------------------------------------ identity

export function displayPhone(phone: string): string {
  // Privacy: never show the full number across the UI.
  return phone.length > 6 ? `+${phone.slice(0, 3)}••••${phone.slice(-4)}` : "+••••";
}

function ensureIdentity(inbound: WhatsAppInbound): { obvUser: User | null; display: string } {
  const mapping = repo.findIdentityMapping(tenantId(), inbound.fromPhone, "WHATSAPP");
  if (!mapping) {
    repo.upsertIdentityMapping({
      id: repo.newId(),
      provider: "WHATSAPP",
      tenantId: tenantId(),
      externalUserId: inbound.fromPhone,
      obvUserId: null,
      externalDisplayName: inbound.profileName || displayPhone(inbound.fromPhone),
      externalEmail: null,
      status: "UNMAPPED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { obvUser: null, display: inbound.profileName || displayPhone(inbound.fromPhone) };
  }
  const obvUser = mapping.obvUserId ? repo.getUser(mapping.obvUserId) : null;
  return {
    obvUser,
    display: obvUser?.name ?? mapping.externalDisplayName ?? displayPhone(inbound.fromPhone),
  };
}

// ------------------------------------------------- context resolution

/**
 * Which OBV thread does this sender's message belong to?
 * 1. active, non-expired explicit participant context
 * 2. otherwise the per-organization "WhatsApp — Unresolved" inbox thread,
 *    where an authorized coordinator explicitly assigns the participant.
 * Context is NEVER guessed from message text.
 */
export function resolveThread(inbound: WhatsAppInbound): ConversationThread {
  const ctx = repo.getParticipantContext("WHATSAPP", inbound.fromPhone);
  if (ctx?.activeThreadId && (!ctx.expiresAt || Date.parse(ctx.expiresAt) > Date.now())) {
    const thread = repo.getThread(ctx.activeThreadId);
    if (thread) return thread;
  }
  return ensureUnresolvedThread();
}

export function ensureUnresolvedThread(): ConversationThread {
  const existing = repo
    .listThreads()
    .find((t) => t.scope === "ORGANIZATION" && t.title === "WhatsApp — Unresolved");
  if (existing) return existing;
  const org = repo.listUsers().find((u) => u.role === "PROJECT_MANAGER");
  const thread: ConversationThread = {
    id: repo.newId(),
    organizationId: org?.organizationId ?? repo.listProjects()[0]?.organizationId ?? "org-crra",
    projectId: null,
    milestoneId: null,
    evidenceItemId: null,
    approvalRequestId: null,
    title: "WhatsApp — Unresolved",
    scope: "ORGANIZATION",
    createdAt: new Date().toISOString(),
    createdBy: org?.id ?? "user-pm",
  };
  repo.insertThread(thread);
  return thread;
}

/** Coordinator explicitly assigns a participant to a project/thread. */
export function assignParticipantContext(
  phone: string,
  target: { projectId?: string | null; threadId?: string | null; milestoneId?: string | null },
  expiresAt: string | null
): ExternalParticipantContext {
  const existing = repo.getParticipantContext("WHATSAPP", phone);
  const ctx: ExternalParticipantContext = {
    id: existing?.id ?? repo.newId(),
    provider: "WHATSAPP",
    externalUserId: phone,
    activeProjectId: target.projectId ?? null,
    activeThreadId: target.threadId ?? null,
    activeMilestoneId: target.milestoneId ?? null,
    lastInboundAt: existing?.lastInboundAt ?? null,
    expiresAt,
    updatedAt: new Date().toISOString(),
  };
  repo.upsertParticipantContext(ctx);
  return ctx;
}

// ------------------------------------------------------------- inbound

export interface WhatsAppInboundResult {
  outcome: "stored" | "duplicate" | "own-echo" | "rate-limited" | "unsupported";
  threadId?: string;
}

/**
 * Process one normalized inbound message. Writes ONLY message rows (and
 * identity/context bookkeeping). Media is downloaded through the media
 * service as a communication artifact — never into evidence storage.
 */
export async function handleWhatsAppInbound(inbound: WhatsAppInbound): Promise<WhatsAppInboundResult> {
  if (rateLimited(inbound.fromPhone)) return { outcome: "rate-limited" };
  const thread = resolveThread(inbound);
  const existing = repo.findMessageByExternalId(thread.id, inbound.externalMessageId);
  if (existing) {
    return { outcome: existing.origin === "OBV_LOCAL" ? "own-echo" : "duplicate" };
  }
  const identity = ensureIdentity(inbound);
  repo.touchParticipantInbound("WHATSAPP", inbound.fromPhone);

  let attachments: ChatMessage["attachments"] = [];
  if (inbound.mediaId) {
    try {
      attachments = [await downloadMedia(inbound.mediaId, inbound.mimeType)];
      if (inbound.filename && attachments[0]) {
        // Keep the human-readable name for display only; the stored file
        // uses a random safe filename.
        attachments[0] = { ...attachments[0], name: inbound.filename };
      }
    } catch (err) {
      // Media failure never loses the message — represent it honestly.
      attachments = [
        {
          name: "media unavailable",
          url: null,
          externalMediaId: inbound.mediaId,
          mimeType: inbound.mimeType ?? undefined,
        },
      ];
      console.error(
        "[whatsapp-sync] media download failed:",
        err instanceof WhatsAppSyncError ? err.category : "unknown"
      );
    }
  }

  const body =
    inbound.type === "UNSUPPORTED"
      ? "(unsupported message type — content not imported)"
      : inbound.type === "LOCATION"
        ? inbound.text || "Shared a location"
        : inbound.text ||
          (inbound.type === "VOICE_NOTE"
            ? "(voice note)"
            : attachments.length
              ? "(attachment)"
              : "(empty message)");

  try {
    repo.insertChatMessage({
      id: repo.newId(),
      threadId: thread.id,
      senderUserId: identity.obvUser?.id ?? null,
      senderDisplayName: identity.display,
      provider: "WHATSAPP",
      externalThreadId: inbound.fromPhone,
      externalMessageId: inbound.externalMessageId,
      body: body.slice(0, 4000),
      messageType: "TEXT",
      refId: null,
      createdAt: inbound.timestamp,
      deliveryStatus: "SENT",
      origin: "WHATSAPP_INBOUND",
      editedAt: null,
      originalBody: null,
      externalDeleted: false,
      attachments,
      location: inbound.location,
    });
  } catch {
    return { outcome: "duplicate" }; // unique index caught a replay race
  }

  // Clarification linkage: an inbound response in a milestone thread with
  // an OPEN clarification attaches as its response — status RESPONDED.
  // Reviewer acceptance remains a separate, explicit human step.
  if (thread.milestoneId) {
    const open = repo.listOpenClarificationsForMilestone(thread.milestoneId)[0];
    if (open) {
      const stored = repo.findMessageByExternalId(thread.id, inbound.externalMessageId);
      if (stored) {
        repo.updateClarification(open.id, { status: "RESPONDED", responseMessageId: stored.id });
      }
    }
  }
  return { outcome: "stored", threadId: thread.id };
}

/** Delivery-status webhook: updates existing outbound message rows only
 *  (never creates messages; unknown ids are no-ops). */
export function handleStatusUpdate(update: WhatsAppStatusUpdate): boolean {
  const map: Record<WhatsAppStatusUpdate["status"], ChatMessage["deliveryStatus"]> = {
    sent: "SENT",
    delivered: "DELIVERED",
    read: "READ",
    failed: "FAILED",
  };
  return repo.updateMessageDeliveryByExternalId(update.externalMessageId, map[update.status]);
}

// ------------------------------------------------------------ outbound

export type OutboundDecision =
  | { mode: "freeform" }
  | { mode: "template"; template: string; params: string[] }
  | { mode: "internal-only"; reason: string };

/** Operational template registry (no marketing templates). */
export const WHATSAPP_TEMPLATES = {
  MILESTONE_REVIEW_REQUESTED: "obv_milestone_review_requested",
  EVIDENCE_CLARIFICATION_REQUIRED: "obv_evidence_clarification_required",
  SITE_VISIT_REMINDER: "obv_site_visit_reminder",
  APPROVAL_STATUS_UPDATE: "obv_approval_status_update",
} as const;

/**
 * WhatsAppOutboundPolicy — centralizes messaging-window rules. Free-form
 * sends are allowed only inside the provider service window (participant
 * messaged us within ~24h). Outside it, purposeful sends use an approved
 * template; plain coordination chat stays internal (SKIPPED, visible).
 */
export function outboundPolicy(
  ctx: ExternalParticipantContext,
  purpose?: keyof typeof WHATSAPP_TEMPLATES,
  templateParams?: string[]
): OutboundDecision {
  const windowMs = WHATSAPP_CONFIG.serviceWindowHours() * 3600_000;
  const inWindow =
    ctx.lastInboundAt !== null && Date.now() - Date.parse(ctx.lastInboundAt) < windowMs;
  if (inWindow) return { mode: "freeform" };
  if (purpose) {
    return { mode: "template", template: WHATSAPP_TEMPLATES[purpose], params: templateParams ?? [] };
  }
  return {
    mode: "internal-only",
    reason: "outside WhatsApp service window and no operational template applies",
  };
}

/**
 * Sync one OBV message outward to the thread's WhatsApp participants.
 * NEVER throws; the internal message is already saved. Only human
 * OBV_LOCAL TEXT syncs; a stored external id blocks re-sends; failures
 * mark FAILED and keep the message.
 */
export async function syncOutboundWhatsApp(
  message: ChatMessage,
  thread: ConversationThread,
  purpose?: keyof typeof WHATSAPP_TEMPLATES,
  templateParams?: string[]
): Promise<void> {
  try {
    if (!WHATSAPP_CONFIG.configured()) return;
    if (message.origin !== "OBV_LOCAL" || !message.senderUserId) return;
    if (message.messageType !== "TEXT") return;
    const current = repo.getChatMessage(message.id);
    if (!current || current.externalMessageId) return; // already delivered once
    const participants = repo
      .listParticipantContextsForThread(thread.id)
      .filter((c) => c.provider === "WHATSAPP");
    if (participants.length === 0) return;
    const sender = repo.getUser(message.senderUserId);
    const text = `${message.senderDisplayName}${sender ? ` (${sender.title})` : ""} via OBV:\n${message.body}`;
    let lastExternalId: string | null = null;
    let failed = 0;
    let skipped = 0;
    for (const participant of participants) {
      const decision = outboundPolicy(participant, purpose, templateParams);
      try {
        if (decision.mode === "freeform") {
          lastExternalId = await sendText(participant.externalUserId, text);
        } else if (decision.mode === "template") {
          lastExternalId = await sendTemplate(
            participant.externalUserId,
            decision.template,
            decision.params.length ? decision.params : [message.body.slice(0, 400)]
          );
        } else {
          skipped++;
        }
      } catch (err) {
        failed++;
        console.error(
          "[whatsapp-sync] outbound failed:",
          err instanceof WhatsAppSyncError ? err.category : "unknown"
        );
      }
    }
    if (lastExternalId) {
      repo.updateMessageExternalDelivery(message.id, lastExternalId, "SENT");
    } else if (failed > 0) {
      repo.updateMessageExternalDelivery(message.id, null, "FAILED");
    } else if (skipped === participants.length) {
      // Internal-only per policy — visible, honest, not an error.
      repo.updateMessageExternalDelivery(message.id, null, "SKIPPED");
    }
  } catch (err) {
    repo.updateMessageExternalDelivery(message.id, null, "FAILED");
    console.error(
      "[whatsapp-sync] outbound delivery failed:",
      err instanceof WhatsAppSyncError ? err.category : "unknown"
    );
  }
}

/** Connection status summary for the admin panel (no secrets). */
export function whatsappStatus(): {
  status: "NOT_CONFIGURED" | "ACTIVE" | "DEGRADED";
  businessAccountId: string | null;
} {
  if (!WHATSAPP_CONFIG.configured()) return { status: "NOT_CONFIGURED", businessAccountId: null };
  // DEGRADED is reflected per-message via FAILED delivery states; the
  // aggregate here stays simple and honest.
  return { status: "ACTIVE", businessAccountId: WHATSAPP_CONFIG.businessAccountId() || null };
}
