/**
 * OBV contextual project communications.
 *
 * CHAT COORDINATES. MAP EXPLAINS WHERE. EVIDENCE PROVES. VERIFICATION
 * ASSESSES. HUMANS AUTHORIZE. LEDGER RECORDS.
 *
 * This module persists conversation threads and messages. It has NO
 * imports from the approval workflow or VirtualAccountService and exposes
 * no code path that can create ApprovalRecords or release funds — a
 * message saying "approved" or "release funds" is text, nothing more.
 * Only the existing ApprovalRequest state machine creates release
 * eligibility (see scripts/chat-test.js for the explicit proof).
 *
 * Providers: OBV is the real internal channel. TEAMS and WHATSAPP are
 * architecture-ready enum values + external id columns for future sync —
 * no fake external connectivity is simulated (see
 * docs/COMMUNICATIONS_INTEGRATION.md for the integration seams).
 */
import * as repo from "../db/repo";
import { AccessError, canAccessProject, requireProject } from "./authz";
import type {
  ChatMessage,
  ChatMessageType,
  ConversationThread,
  DrawRequest,
  Project,
  User,
} from "../../shared/types";

// ------------------------------------------------------------ access

/** Denial that never discloses whether the thread or project exists. */
export class ChatAccessError extends AccessError {
  constructor() {
    super("Thread not found", 404);
  }
}

/**
 * Demo authorization: a user may access a thread when their organization
 * participates in the thread's project (funder organization or the
 * implementing agency, i.e. an org that fields PROJECT_MANAGER/FIELD
 * users). Organization-scoped threads require org membership. This
 * preserves tenant/project boundaries with the existing role model —
 * it is not a new authentication system.
 */
export function canAccessThread(user: User, thread: ConversationThread): boolean {
  if (!thread.projectId) {
    return thread.organizationId === user.organizationId;
  }
  const project = repo.getProject(thread.projectId);
  if (!project) return false;
  return participatesInProject(user, project);
}

/**
 * Participation in THIS project.
 *
 * The previous implementation asked "does my organization contain any
 * PROJECT_MANAGER or FIELD user?" — a property of the CALLER, not of the
 * requested project — so the `project` argument was inert and any org with
 * one such user participated in every project in the database.
 *
 * It now delegates to the same boundary the lender layer enforces: the
 * owning/funding org, a pilot counterparty org, an org that raised a draw
 * on this project, or an explicit active project membership.
 */
export function participatesInProject(user: User, project: Project): boolean {
  return canAccessProject(user, project);
}

/** Same-404: a thread outside the caller's projects is indistinguishable
 *  from a thread that does not exist. */
export function assertThreadAccess(user: User, thread: ConversationThread): void {
  if (!canAccessThread(user, thread)) throw new ChatAccessError();
}

/** The only supported way to resolve a thread id on behalf of a user. */
export function getThreadForUser(user: User, threadId: string): ConversationThread {
  const thread = repo.getThread(threadId);
  if (!thread) throw new ChatAccessError();
  assertThreadAccess(user, thread);
  return thread;
}

export function listThreadsForUser(user: User): ConversationThread[] {
  // Memoized per project: the predicate is now a real lookup, and a
  // communications page can hold many threads on the same project.
  const verdict = new Map<string, boolean>();
  return repo.listThreads().filter((t) => {
    if (!t.projectId) return t.organizationId === user.organizationId;
    let ok = verdict.get(t.projectId);
    if (ok === undefined) {
      const project = repo.getProject(t.projectId);
      ok = project ? participatesInProject(user, project) : false;
      verdict.set(t.projectId, ok);
    }
    return ok;
  });
}

// ------------------------------------------------------------ threads

/** Find or create the discussion thread for a milestone. */
export function ensureMilestoneThread(milestoneId: string, createdBy: User): ConversationThread {
  // Authorize BEFORE the find-or-create: an unrelated tenant must not be
  // able to force a row into another tenant's project by "opening" a
  // thread on a milestone it cannot see.
  const milestone = repo.getMilestone(milestoneId);
  if (!milestone) throw new ChatAccessError();
  const project = requireProject(createdBy, milestone.projectId);
  const existing = repo.findThreadForMilestone(milestoneId);
  if (existing) return existing;
  const thread: ConversationThread = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    milestoneId,
    evidenceItemId: null,
    approvalRequestId: null,
    title: `M${milestone.seq} · ${milestone.title}`,
    scope: "MILESTONE",
    createdAt: new Date().toISOString(),
    createdBy: createdBy.id,
  };
  repo.insertThread(thread);
  return thread;
}

/** Find or create the general thread for a project. */
export function ensureProjectThread(projectId: string, createdBy: User): ConversationThread {
  // Authorize before creating — same reason as ensureMilestoneThread.
  const project = requireProject(createdBy, projectId);
  const existing = repo.findProjectThread(projectId);
  if (existing) return existing;
  const thread: ConversationThread = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    milestoneId: null,
    evidenceItemId: null,
    approvalRequestId: null,
    title: "Project General",
    scope: "PROJECT",
    createdAt: new Date().toISOString(),
    createdBy: createdBy.id,
  };
  repo.insertThread(thread);
  return thread;
}

/** Find or create the coordination thread for a draw request. Chat about
 *  a draw stays coordination only — a message saying "Approve Draw 4"
 *  approves nothing; governance lives in the ApprovalRequest workflow.
 *
 *  NOT user-authorized on purpose: the only caller is submitDraw (draws.ts),
 *  which has already run the full draw authorization chain for the actor and
 *  persisted the draw's owning organization immediately before calling here.
 *  Never call this from a route. */
export function ensureDrawThread(draw: DrawRequest, createdBy: User): ConversationThread {
  const existing = repo.findThreadForDraw(draw.id);
  if (existing) return existing;
  const thread: ConversationThread = {
    id: repo.newId(),
    organizationId: draw.organizationId,
    projectId: draw.projectId,
    milestoneId: null,
    evidenceItemId: null,
    approvalRequestId: null,
    drawRequestId: draw.id,
    title: `Draw #${draw.drawNumber} · Review`,
    scope: "DRAW",
    createdAt: new Date().toISOString(),
    createdBy: createdBy.id,
  };
  repo.insertThread(thread);
  return thread;
}

// ------------------------------------------------------------ messages

/** Post a human text message (no editing/deletion is supported). */
export function postMessage(thread: ConversationThread, sender: User, body: string): ChatMessage {
  const trimmed = body.trim().slice(0, 4000);
  if (!trimmed) throw new Error("Empty message");
  const message: ChatMessage = {
    id: repo.newId(),
    threadId: thread.id,
    senderUserId: sender.id,
    senderDisplayName: sender.name,
    provider: "OBV",
    externalThreadId: null,
    externalMessageId: null,
    body: trimmed,
    messageType: "TEXT",
    refId: null,
    createdAt: new Date().toISOString(),
    deliveryStatus: "SENT",
    origin: "OBV_LOCAL",
    editedAt: null,
    originalBody: null,
    externalDeleted: false,
    attachments: [],
    location: null,
  };
  repo.insertChatMessage(message);
  return message;
}

// ------------------------------------------------------ event mirroring

export interface MirrorContext {
  projectId: string;
  milestoneId?: string;
  /** Prefer the draw's own thread when set. */
  drawRequestId?: string;
  /** Referenced record for a compact context card in the thread. */
  refType?: Extract<
    ChatMessageType,
    | "EVIDENCE_REFERENCE" | "MILESTONE_REFERENCE" | "APPROVAL_REFERENCE"
    | "REPORT_REFERENCE" | "ISSUE_REFERENCE" | "CLARIFICATION_REFERENCE"
    | "DRAW_REFERENCE" | "DRAW_LINE_REFERENCE" | "DRAW_DOCUMENT_REFERENCE"
    | "EXCEPTION_REFERENCE"
  >;
  refId?: string;
}

/**
 * Mirror an important product event into the most specific EXISTING
 * thread (milestone thread first, then the project thread). Never
 * creates threads and never posts when no thread exists — system events
 * inform conversations, they don't flood the workspace. These are
 * SYSTEM_EVENT rows, visually distinct from human messages, and are
 * entirely separate from Teams notification delivery (TeamsNotifier).
 */
export function mirrorEvent(body: string, ctx: MirrorContext): ChatMessage | null {
  const thread =
    (ctx.drawRequestId ? repo.findThreadForDraw(ctx.drawRequestId) : null) ??
    (ctx.milestoneId ? repo.findThreadForMilestone(ctx.milestoneId) : null) ??
    repo.findProjectThread(ctx.projectId);
  if (!thread) return null;
  const message: ChatMessage = {
    id: repo.newId(),
    threadId: thread.id,
    senderUserId: null,
    senderDisplayName: "OBV",
    provider: "OBV",
    externalThreadId: null,
    externalMessageId: null,
    body,
    messageType: ctx.refType && ctx.refId ? ctx.refType : "SYSTEM_EVENT",
    refId: ctx.refId ?? null,
    createdAt: new Date().toISOString(),
    deliveryStatus: "SENT",
    origin: "OBV_LOCAL",
    editedAt: null,
    originalBody: null,
    externalDeleted: false,
    attachments: [],
    location: null,
  };
  repo.insertChatMessage(message);
  return message;
}
