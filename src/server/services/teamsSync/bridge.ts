/**
 * TeamsConversationBridge — synchronizes COORDINATION MESSAGES between
 * OBV threads and bound Microsoft Teams channel conversations.
 *
 * STRICTLY SEPARATE from TeamsNotifier (one-way workflow event cards).
 *
 * TRUST MODEL (non-negotiable, proven by scripts/teams-sync-test.js):
 * this module imports NOTHING from the approval workflow, the
 * verification pipeline, or VirtualAccountService. An inbound Teams
 * message — whatever it says, whatever it attaches — can only ever
 * become a ChatMessage row. Approvals happen exclusively through the
 * formal ApprovalRequest state machine; evidence enters exclusively
 * through the governed submission workflow.
 *
 * Loop prevention:
 *   - OBV_LOCAL messages may sync outbound exactly once (externalMessageId
 *     acts as the retry guard).
 *   - inbound notifications whose message id matches something we already
 *     stored (including our own outbound ids) are no-ops.
 *   - TEAMS_INBOUND messages are never candidates for outbound sync.
 *   - a partial unique index on (thread_id, external_message_id) backstops
 *     replays at the database level.
 */
import * as repo from "../../db/repo";
import type {
  ChatMessage,
  ConversationThread,
  ExternalThreadBinding,
  User,
} from "../../../shared/types";
import { GRAPH_CONFIG, webhookClientState } from "./config";
import { teamsConversationProvider } from "./graphProvider";
import { ConversationSyncError, NormalizedInboundMessage } from "./types";

const provider = teamsConversationProvider;

export function syncConfigured(): boolean {
  return provider.configured();
}

// ------------------------------------------------------------ binding

/** Roles allowed to manage Teams connections (org-admin equivalent). */
export function canManageBindings(user: User): boolean {
  return user.role === "PROJECT_MANAGER" || user.role === "FUNDER_REP";
}

/**
 * Connect an OBV thread to a Teams channel. A binding is marked ACTIVE
 * only after real validation succeeds: the team resolves, the channel
 * resolves, and the change-notification subscription (including Graph's
 * webhook handshake) is created. Failures land in PERMISSION_REQUIRED
 * (auth/consent problems) or propagate as sanitized errors (bad ids) —
 * "Connected" is never shown merely because identifiers were saved.
 */
export async function connectThread(
  thread: ConversationThread,
  target: { teamId: string; channelId: string; rootMessageId?: string },
  createdBy: User
): Promise<ExternalThreadBinding> {
  if (!provider.configured()) throw new ConversationSyncError("not-configured", false);
  const existing = repo.getBindingForThread(thread.id);
  const now = new Date().toISOString();
  let binding: ExternalThreadBinding;
  if (existing) {
    // Reconnect flow: reuse the row; it must re-validate before ACTIVE.
    repo.updateBinding(existing.id, { status: "CONNECTING" });
    binding = repo.getBindingForThread(thread.id)!;
  } else {
    binding = {
      id: repo.newId(),
      threadId: thread.id,
      provider: "TEAMS",
      tenantId: GRAPH_CONFIG.tenantId(),
      teamId: target.teamId.trim(),
      channelId: target.channelId.trim(),
      rootMessageId: target.rootMessageId?.trim() || null,
      teamName: null,
      channelName: null,
      subscriptionId: null,
      subscriptionExpiresAt: null,
      status: "CONNECTING",
      lastSyncAt: null,
      createdBy: createdBy.id,
      createdAt: now,
      updatedAt: now,
    };
    repo.insertBinding(binding);
  }
  // Validation handshake: team -> channel -> subscription.
  try {
    const teamName = await provider.verifyTeam(binding.teamId);
    const channelName = await provider.verifyChannel(binding.teamId, binding.channelId);
    repo.updateBinding(binding.id, { teamName, channelName });
  } catch (err) {
    const category = err instanceof ConversationSyncError ? err.category : "unknown";
    // Consent/permission problems are an admin action, not an OBV error.
    repo.updateBinding(binding.id, {
      status: category === "auth" ? "PERMISSION_REQUIRED" : "DISCONNECTED",
    });
    throw err;
  }
  await ensureSubscription(repo.getBindingForThread(thread.id)!);
  const validated = repo.getBindingForThread(thread.id)!;
  if (validated.status === "CONNECTING") {
    // Subscription step degraded without throwing — reflect honestly.
    repo.updateBinding(validated.id, { status: "DEGRADED" });
  }
  return repo.getBindingForThread(thread.id)!;
}

/** Outbound capability of the current configuration (for UI honesty). */
export function sendCapability(): "delegated" | "app-test" | "none" {
  return provider.sendCapability();
}

export async function disconnectThread(thread: ConversationThread): Promise<void> {
  const binding = repo.getBindingForThread(thread.id);
  if (!binding) return;
  if (binding.subscriptionId) await provider.deleteSubscription(binding.subscriptionId);
  repo.updateBinding(binding.id, {
    status: "DISCONNECTED",
    subscriptionId: null,
    subscriptionExpiresAt: null,
  });
}

// --------------------------------------------- subscription lifecycle

async function ensureSubscription(binding: ExternalThreadBinding): Promise<void> {
  if (binding.status === "DISCONNECTED" || binding.status === "PERMISSION_REQUIRED") return;
  const expiresSoon =
    !binding.subscriptionExpiresAt ||
    Date.parse(binding.subscriptionExpiresAt) < Date.now() + 10 * 60_000;
  if (binding.subscriptionId && !expiresSoon) return;
  try {
    const sub = binding.subscriptionId
      ? await provider.renewSubscription(binding.subscriptionId)
      : await provider.createSubscription(
          binding,
          GRAPH_CONFIG.webhookPublicUrl(),
          webhookClientState()
        );
    repo.updateBinding(binding.id, {
      subscriptionId: sub.subscriptionId,
      subscriptionExpiresAt: sub.expiresAt,
      status: "ACTIVE",
    });
  } catch (err) {
    // Subscriptions do not live forever; renewal failure degrades the
    // binding (visible in the connection panel) without breaking chat.
    repo.updateBinding(binding.id, { status: "DEGRADED" });
    console.error(
      `[teams-sync] subscription maintenance failed for binding ${binding.id}:`,
      err instanceof ConversationSyncError ? err.category : "unknown"
    );
  }
}

/** Maintenance sweep — renew every ACTIVE/DEGRADED binding's subscription.
 *  Called from the protected maintenance endpoint (or an external
 *  scheduler hitting it). Deliberately simple; no job platform. */
export async function maintainSubscriptions(): Promise<{ checked: number; degraded: number }> {
  if (!provider.configured()) return { checked: 0, degraded: 0 };
  let degraded = 0;
  const bindings = [...repo.listBindings("ACTIVE"), ...repo.listBindings("DEGRADED")];
  for (const b of bindings) {
    await ensureSubscription(b);
    if (repo.getBindingForThread(b.threadId)?.status === "DEGRADED") degraded++;
  }
  return { checked: bindings.length, degraded };
}

// ------------------------------------------------------------ outbound

/**
 * Outbound allowlist: only HUMAN-authored coordination content leaves
 * OBV — TEXT plus explicitly shared reference messages. System events,
 * AI provenance, audit noise and reset events never sync (TeamsNotifier
 * already delivers the high-value workflow cards).
 */
function outboundAllowed(message: ChatMessage): boolean {
  if (message.origin !== "OBV_LOCAL") return false; // never echo inbound
  if (!message.senderUserId) return false; // system events stay internal
  return ["TEXT", "EVIDENCE_REFERENCE", "MILESTONE_REFERENCE", "REPORT_REFERENCE"].includes(
    message.messageType
  );
}

/**
 * Sync one OBV message outward. NEVER throws: the internal message is
 * already persisted and the Communications page must not break on
 * provider failure. Retries cannot double-post — a stored external id
 * short-circuits.
 */
export async function syncOutbound(message: ChatMessage, thread: ConversationThread): Promise<void> {
  try {
    if (!provider.configured()) return;
    const binding = repo.getBindingForThread(thread.id);
    if (!binding || binding.status === "DISCONNECTED" || binding.status === "PERMISSION_REQUIRED" || binding.status === "CONNECTING") return;
    if (!outboundAllowed(message)) return;
    const current = repo.getChatMessage(message.id);
    if (!current || current.externalMessageId) return; // already delivered once
    const sender = message.senderUserId ? repo.getUser(message.senderUserId) : null;
    const externalId = await provider.sendMessage(binding, {
      text: outboundText(message),
      senderDisplayName: message.senderDisplayName,
      senderRoleTitle: sender?.title ?? null,
    });
    repo.updateMessageExternalDelivery(message.id, externalId, "SENT");
    repo.updateBinding(binding.id, { lastSyncAt: new Date().toISOString() });
  } catch (err) {
    // Keep the internal message; record the failure for the sender only.
    repo.updateMessageExternalDelivery(message.id, null, "FAILED");
    console.error(
      "[teams-sync] outbound delivery failed:",
      err instanceof ConversationSyncError ? err.category : "unknown"
    );
  }
}

/** Reference messages render as clean context blocks with OBV deep links
 *  — informational only; no Teams-side action can record an approval. */
function outboundText(message: ChatMessage): string {
  const base = (process.env.OBV_PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
  const link = (path: string) => (base ? `${base}${path}` : "Open OBV to review");
  if (message.messageType === "EVIDENCE_REFERENCE" && message.refId) {
    const ev = repo.getEvidence(message.refId);
    const v = ev ? repo.getVerificationForEvidence(ev.id) : null;
    const m = ev ? repo.getMilestone(ev.milestoneId) : null;
    const p = m ? repo.getProject(m.projectId) : null;
    return [
      "OBV Evidence Reference",
      p ? `Project: ${p.name}` : null,
      m ? `Milestone: M${m.seq} · ${m.title}` : null,
      v ? `Verdict: ${v.verdict.replace(/_/g, " ")} · confidence ${v.confidence.toFixed(2)}` : null,
      ev ? `Captured: ${ev.capturedAt}` : null,
      message.body,
      m ? `Open in OBV: ${link(`/milestone/${m.id}`)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (message.messageType === "REPORT_REFERENCE" && message.refId) {
    const report = repo.getReport(message.refId);
    const p = report ? repo.getProject(report.projectId) : null;
    // Reports page link only — never a direct gated file link.
    return [
      "Project Verification & Fund Release Report",
      p ? `Project: ${p.name}` : null,
      report ? `Generated: ${report.generatedAt}` : null,
      report ? `Ledger integrity: ${report.integrityStatus}` : null,
      message.body,
      `Open in OBV: ${link("/reports")}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (message.messageType === "MILESTONE_REFERENCE" && message.refId) {
    const m = repo.getMilestone(message.refId);
    return [
      "OBV Milestone Reference",
      m ? `M${m.seq} · ${m.title}` : null,
      message.body,
      m ? `Open in OBV: ${link(`/milestone/${m.id}`)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return message.body;
}

// ------------------------------------------------------------- inbound

export interface InboundResult {
  outcome: "stored" | "duplicate" | "own-echo" | "edited" | "deleted" | "ignored";
}

/**
 * Process one normalized inbound provider message for a binding.
 * Idempotent: notification replays and echoes of our own outbound
 * messages resolve to no-ops. Writes ONLY message rows.
 */
export function handleInbound(
  binding: ExternalThreadBinding,
  inbound: NormalizedInboundMessage
): InboundResult {
  const thread = repo.getThread(binding.threadId);
  if (!thread || binding.status === "DISCONNECTED") return { outcome: "ignored" };
  const existing = repo.findMessageByExternalId(thread.id, inbound.externalMessageId);

  if (inbound.changeType === "deleted") {
    if (existing && !existing.externalDeleted) {
      repo.applyExternalDelete(existing.id);
      return { outcome: "deleted" };
    }
    return { outcome: "ignored" };
  }

  if (inbound.changeType === "updated") {
    if (!existing) return { outcome: "ignored" };
    if (existing.origin === "OBV_LOCAL") return { outcome: "own-echo" }; // our message; nothing to mirror
    if (existing.body === inbound.body) return { outcome: "duplicate" };
    repo.applyExternalEdit(existing.id, inbound.body, new Date().toISOString());
    return { outcome: "edited" };
  }

  // created
  if (existing) {
    // Either a replayed notification or the echo of our own outbound
    // message returning through the subscription — both are no-ops.
    return { outcome: existing.origin === "OBV_LOCAL" ? "own-echo" : "duplicate" };
  }
  if (!inbound.body.trim() && inbound.attachments.length === 0) return { outcome: "ignored" };

  // Identity: exact configured mapping only — never guessed from names.
  // First sight of an unmapped external identity records an UNMAPPED row
  // so administrators can review and map it explicitly.
  const mapping = inbound.senderExternalId
    ? repo.findIdentityMapping(binding.tenantId, inbound.senderExternalId)
    : null;
  if (inbound.senderExternalId && !mapping) {
    repo.upsertIdentityMapping({
      id: repo.newId(),
      provider: "TEAMS",
      tenantId: binding.tenantId,
      externalUserId: inbound.senderExternalId,
      obvUserId: null,
      externalDisplayName: inbound.senderDisplayName,
      externalEmail: null,
      status: "UNMAPPED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  const obvUser = mapping?.obvUserId ? repo.getUser(mapping.obvUserId) : null;

  try {
    repo.insertChatMessage({
      id: repo.newId(),
      threadId: thread.id,
      senderUserId: obvUser?.id ?? null,
      senderDisplayName: obvUser?.name ?? inbound.senderDisplayName,
      provider: "TEAMS",
      externalThreadId: `${binding.teamId}/${binding.channelId}`,
      externalMessageId: inbound.externalMessageId,
      body: inbound.body.trim().slice(0, 4000) || "(attachment)",
      messageType: "TEXT",
      refId: null,
      createdAt: inbound.createdAt,
      deliveryStatus: "SENT",
      origin: "TEAMS_INBOUND",
      editedAt: null,
      originalBody: null,
      externalDeleted: false,
      // Communication artifacts only — promotion to evidence goes
      // through the governed submission workflow, never automatically.
      attachments: inbound.attachments,
      location: inbound.location ?? null,
    });
  } catch {
    // Unique (thread_id, external_message_id) index caught a replay race.
    return { outcome: "duplicate" };
  }
  repo.updateBinding(binding.id, { lastSyncAt: new Date().toISOString() });
  return { outcome: "stored" };
}

/** Fetch + process a notification item (used by the webhook route). */
export async function processNotificationItem(item: {
  subscriptionId: string;
  clientState: string;
  changeType: string;
  messageId: string;
}): Promise<InboundResult> {
  if (item.clientState !== webhookClientState()) {
    throw new ConversationSyncError("auth", false);
  }
  const binding = repo.getBindingBySubscription(item.subscriptionId);
  if (!binding) return { outcome: "ignored" };
  const changeType =
    item.changeType === "deleted" ? "deleted" : item.changeType === "updated" ? "updated" : "created";
  if (changeType === "deleted") {
    // Deleted messages may no longer be fetchable — act on the id alone.
    return handleInbound(binding, {
      externalMessageId: item.messageId,
      changeType: "deleted",
      senderExternalId: null,
      senderDisplayName: "Microsoft Teams",
      body: "",
      createdAt: new Date().toISOString(),
      attachments: [],
    });
  }
  const normalized = await provider.fetchMessage(binding, item.messageId, changeType);
  return handleInbound(binding, normalized);
}
