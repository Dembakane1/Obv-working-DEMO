/**
 * Field operations: Field Issues, Clarification Requests, and governed
 * Evidence Draft promotion.
 *
 * TRUST MODEL:
 * - A FieldIssue is operational context for humans. No code path here
 *   touches ApprovalRecords or the VirtualAccountService — severity can
 *   never change financial state.
 * - A ClarificationRequest response (from any channel) sets RESPONDED at
 *   most; acceptance/closure is a separate explicit reviewer action.
 * - An EvidenceDraft is NOT evidence. Explicit submission routes through
 *   processEvidenceSubmission — the SAME governed pipeline as field
 *   capture (verification -> ledger only if verified -> approval request
 *   -> human governance). Provenance stays honest: no fabricated GPS,
 *   no fabricated capture timestamps, no invented device metadata.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as repo from "../db/repo";
import { mirrorEvent, canAccessThread } from "./chat";
import * as authz from "./authz";
import { COMM_MEDIA_DIR } from "./whatsappSync/provider";
import { processEvidenceSubmission, SubmissionError } from "../workflow/orchestrator";
import type {
  ChatMessage,
  ClarificationRequest,
  EvidenceDraft,
  FieldIssue,
  User,
} from "../../shared/types";

/**
 * ROLE predicate only — which roles may operate field-ops surfaces at all.
 * It is NEVER sufficient authorization: object-level access is asserted
 * inside every exported mutation and query below. A true return says
 * nothing about whether this caller may touch THIS project, milestone,
 * issue, clarification, draft or message.
 */
export function canManageFieldOps(user: User): boolean {
  return ["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(user.role);
}

// ---- object-level boundary (same-404: foreign and nonexistent match) ----

/** Assert project access, reporting it as the caller's own "unknown X". */
function requireProject(user: User, projectId: string | null | undefined, notFound: string) {
  try {
    return authz.requireProject(user, projectId);
  } catch {
    throw new SubmissionError(notFound, 404);
  }
}

/** Assert milestone access AND resolve its project. */
function requireMilestone(user: User, milestoneId: string | null | undefined, notFound: string) {
  try {
    return authz.requireMilestone(user, milestoneId);
  } catch {
    throw new SubmissionError(notFound, 404);
  }
}

/** A chat message the caller may actually read — resolved through its
 *  thread, so a message id from another tenant is simply "unknown". */
function requireReadableMessage(user: User, messageId: string, notFound = "Unknown message"): ChatMessage {
  const message = repo.getChatMessage(messageId);
  if (!message) throw new SubmissionError(notFound, 404);
  const thread = repo.getThread(message.threadId);
  if (!thread || !canAccessThread(user, thread)) throw new SubmissionError(notFound, 404);
  return message;
}

// ------------------------------------------------------------ issues

export function createFieldIssue(input: {
  projectId: string;
  milestoneId: string | null;
  sourceMessage: ChatMessage | null;
  title: string;
  description: string;
  category: FieldIssue["category"];
  severity: FieldIssue["severity"];
  assignedToUserId: string | null;
  dueAt: string | null;
  createdBy: User;
}): FieldIssue {
  const project = requireProject(input.createdBy, input.projectId, "Unknown project");
  // Nested-object substitution: a milestone id that RESOLVES is not proof
  // that it belongs to THIS project.
  if (input.milestoneId) {
    const m = repo.getMilestone(input.milestoneId);
    if (!m || m.projectId !== project.id) throw new SubmissionError("Unknown milestone", 404);
  }
  // The source message is copied into the issue (body, GPS, thread id), so
  // it must be one the caller can read.
  if (input.sourceMessage) requireReadableMessage(input.createdBy, input.sourceMessage.id);
  const now = new Date().toISOString();
  const issue: FieldIssue = {
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    milestoneId: input.milestoneId,
    evidenceItemId: null,
    sourceThreadId: input.sourceMessage?.threadId ?? null,
    sourceMessageId: input.sourceMessage?.id ?? null,
    title: input.title.trim().slice(0, 160),
    description: input.description.trim().slice(0, 4000),
    category: input.category,
    severity: input.severity,
    status: "OPEN",
    reportedByUserId: input.sourceMessage?.senderUserId ?? input.createdBy.id,
    reportedByExternalIdentityId:
      input.sourceMessage && !input.sourceMessage.senderUserId
        ? input.sourceMessage.externalThreadId
        : null,
    assignedToUserId: input.assignedToUserId,
    latitude: input.sourceMessage?.location?.latitude ?? null,
    longitude: input.sourceMessage?.location?.longitude ?? null,
    dueAt: input.dueAt,
    resolvedAt: null,
    resolutionSummary: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.insertFieldIssue(issue);
  repo.insertIssueEvent({
    id: repo.newId(),
    issueId: issue.id,
    type: "CREATED",
    detail: `Issue created (${issue.category} · ${issue.severity})${issue.assignedToUserId ? ` — assigned to ${repo.getUser(issue.assignedToUserId)?.name}` : ""}`,
    actorUserId: input.createdBy.id,
    createdAt: now,
  });
  mirrorEvent(
    `Field issue created: ${issue.title} (${issue.category} · ${issue.severity})${issue.assignedToUserId ? `. Assigned to ${repo.getUser(issue.assignedToUserId)?.name}.` : "."}`,
    {
      projectId: project.id,
      milestoneId: issue.milestoneId ?? undefined,
      refType: "ISSUE_REFERENCE",
      refId: issue.id,
    }
  );
  return issue;
}

const ISSUE_TRANSITIONS: Record<FieldIssue["status"], FieldIssue["status"][]> = {
  OPEN: ["ACKNOWLEDGED", "IN_PROGRESS", "CLOSED"],
  ACKNOWLEDGED: ["IN_PROGRESS", "AWAITING_FIELD_RESPONSE", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["AWAITING_FIELD_RESPONSE", "RESOLVED", "CLOSED"],
  AWAITING_FIELD_RESPONSE: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: [],
};

export function updateIssueStatus(
  issueId: string,
  status: FieldIssue["status"],
  actor: User,
  resolutionSummary?: string
): FieldIssue {
  const issue = repo.getFieldIssue(issueId);
  if (!issue) throw new SubmissionError("Unknown issue", 404);
  // Before the state machine, which would otherwise disclose the issue's
  // current status to a caller outside the tenant.
  requireProject(actor, issue.projectId, "Unknown issue");
  if (!ISSUE_TRANSITIONS[issue.status].includes(status)) {
    throw new SubmissionError(`Cannot move issue from ${issue.status} to ${status}`, 409);
  }
  repo.updateFieldIssue(issueId, {
    status,
    resolvedAt: status === "RESOLVED" ? new Date().toISOString() : issue.resolvedAt,
    resolutionSummary: resolutionSummary ?? issue.resolutionSummary,
  });
  repo.insertIssueEvent({
    id: repo.newId(),
    issueId,
    type: status === "RESOLVED" ? "RESOLVED" : "STATUS_CHANGED",
    detail: `${issue.status} → ${status}${resolutionSummary ? ` — ${resolutionSummary.slice(0, 300)}` : ""}`,
    actorUserId: actor.id,
    createdAt: new Date().toISOString(),
  });
  return repo.getFieldIssue(issueId)!;
}

// ---------------------------------------------------- clarifications

export function createClarification(input: {
  milestoneId: string;
  evidenceItemId: string | null;
  question: string;
  responseType: ClarificationRequest["responseType"];
  dueAt: string | null;
  assignedToUserId: string | null;
  requestedBy: User;
}): ClarificationRequest {
  const { milestone } = requireMilestone(input.requestedBy, input.milestoneId, "Unknown milestone");
  // evidenceItemId is stored verbatim and rendered on the milestone page —
  // it must belong to THIS milestone.
  if (input.evidenceItemId) {
    const ev = repo.getEvidence(input.evidenceItemId);
    if (!ev || ev.milestoneId !== milestone.id) {
      throw new SubmissionError("Unknown evidence item", 404);
    }
  }
  const now = new Date().toISOString();
  const clar: ClarificationRequest = {
    id: repo.newId(),
    milestoneId: milestone.id,
    evidenceItemId: input.evidenceItemId,
    question: input.question.trim().slice(0, 2000),
    responseType: input.responseType,
    dueAt: input.dueAt,
    assignedToUserId: input.assignedToUserId,
    requestedByUserId: input.requestedBy.id,
    status: "OPEN",
    responseMessageId: null,
    resolutionNote: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.insertClarification(clar);
  mirrorEvent(
    `Clarification requested for M${milestone.seq}: "${clar.question.slice(0, 200)}" (response required: ${clar.responseType.replace(/_/g, " ")}${clar.dueAt ? `, due ${clar.dueAt.slice(0, 10)}` : ""}).`,
    {
      projectId: milestone.projectId,
      milestoneId: milestone.id,
      refType: "CLARIFICATION_REFERENCE",
      refId: clar.id,
    }
  );
  return clar;
}

const CLAR_TRANSITIONS: Record<ClarificationRequest["status"], ClarificationRequest["status"][]> = {
  OPEN: ["RESPONDED", "CLOSED"],
  RESPONDED: ["ACCEPTED", "REOPENED", "CLOSED"],
  ACCEPTED: ["CLOSED", "REOPENED"],
  REOPENED: ["RESPONDED", "CLOSED"],
  CLOSED: [],
};

/** Reviewer decision — a response NEVER auto-accepts. */
export function updateClarificationStatus(
  id: string,
  status: ClarificationRequest["status"],
  actor: User,
  note?: string
): ClarificationRequest {
  const clar = repo.getClarification(id);
  if (!clar) throw new SubmissionError("Unknown clarification request", 404);
  requireMilestone(actor, clar.milestoneId, "Unknown clarification request");
  if (!CLAR_TRANSITIONS[clar.status].includes(status)) {
    throw new SubmissionError(`Cannot move clarification from ${clar.status} to ${status}`, 409);
  }
  repo.updateClarification(id, { status, resolutionNote: note ?? clar.resolutionNote });
  const milestone = repo.getMilestone(clar.milestoneId)!;
  mirrorEvent(
    `Clarification ${status.toLowerCase()} by ${actor.name} for M${milestone.seq}${note ? ` — ${note.slice(0, 200)}` : ""}.`,
    { projectId: milestone.projectId, milestoneId: milestone.id }
  );
  return repo.getClarification(id)!;
}

/** Every field issue in the caller's projects. */
export function listFieldIssuesForUser(user: User): FieldIssue[] {
  const visible = authz.accessibleProjectIds(user);
  return repo.listFieldIssues().filter((i) => visible.has(i.projectId));
}

/** One issue, with the tenant boundary: unknown and foreign are identical. */
export function getFieldIssueForUser(user: User, issueId: string): FieldIssue {
  const issue = repo.getFieldIssue(issueId);
  if (!issue) throw new SubmissionError("Unknown issue", 404);
  requireProject(user, issue.projectId, "Unknown issue");
  return issue;
}

// ------------------------------------------------- evidence drafts

const PROMOTABLE_KINDS = new Set(["IMAGE"]);

/**
 * Governed promotion: communication media -> DRAFT. Creates NOTHING in
 * the evidence tables; provenance is captured honestly (source identity,
 * provider message timestamp — not an original capture time — and a
 * location only when explicitly associated with a location message from
 * the same thread).
 */
export function createEvidenceDraft(input: {
  messageId: string;
  attachmentIndex: number;
  milestoneId: string;
  locationMessageId: string | null;
  createdBy: User;
}): EvidenceDraft {
  // Authorize BOTH ends before any 400 that would confirm the message
  // exists or describe its media: the source message must be readable by
  // this caller, and the destination milestone must be in their tenant.
  const message = requireReadableMessage(input.createdBy, input.messageId);
  const { milestone } = requireMilestone(input.createdBy, input.milestoneId, "Unknown milestone");
  const attachment = message.attachments[input.attachmentIndex];
  if (!attachment || !attachment.url) throw new SubmissionError("No media on this message", 400);
  if (!PROMOTABLE_KINDS.has(attachment.kind ?? "")) {
    throw new SubmissionError("Only image media can be promoted to an evidence draft", 400);
  }
  let latitude: number | null = null;
  let longitude: number | null = null;
  if (input.locationMessageId) {
    const locMsg = repo.getChatMessage(input.locationMessageId);
    // Explicit association only, and only from the same thread — never
    // merged silently by timing.
    if (!locMsg || locMsg.threadId !== message.threadId || !locMsg.location) {
      throw new SubmissionError("Location message not found in this thread", 400);
    }
    latitude = locMsg.location.latitude;
    longitude = locMsg.location.longitude;
  }
  const draft: EvidenceDraft = {
    id: repo.newId(),
    projectId: milestone.projectId,
    milestoneId: milestone.id,
    sourceMessageId: message.id,
    sourceAttachmentIndex: input.attachmentIndex,
    mediaPath: attachment.url,
    sourceProvider: message.provider,
    sourceIdentity: message.senderDisplayName,
    sourceTimestamp: message.createdAt,
    latitude,
    longitude,
    locationSourceMessageId: input.locationMessageId,
    status: "DRAFT",
    createdBy: input.createdBy.id,
    createdAt: new Date().toISOString(),
    submittedAt: null,
    evidenceItemId: null,
  };
  repo.insertDraft(draft);
  return draft;
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".svg": "image/svg+xml",
};

/**
 * Explicit "Submit for Verification": runs the NORMAL evidence pipeline.
 * No verified status is created here; missing GPS stays missing (the
 * deterministic geofence check routes it to REVIEW per existing policy);
 * device metadata honestly states the WhatsApp communication origin.
 */
export async function submitDraft(draftId: string, submitter: User) {
  const draft = repo.getDraft(draftId);
  if (!draft) throw new SubmissionError("Unknown draft", 404);
  // Before the 409, which would otherwise reveal another tenant's draft
  // state. Also re-checks that the draft's milestone and project agree.
  const { milestone: draftMilestone } = requireMilestone(submitter, draft.milestoneId, "Unknown draft");
  if (draft.projectId && draftMilestone.projectId !== draft.projectId) {
    throw new SubmissionError("Unknown draft", 404);
  }
  if (draft.status !== "DRAFT") {
    throw new SubmissionError("This draft has already been submitted or discarded", 409);
  }
  // Resolve the communication media file (comm-media or bundled demo asset).
  const rel = draft.mediaPath.replace(/^\//, "");
  const file = draft.mediaPath.startsWith("/comm-media/")
    ? path.join(COMM_MEDIA_DIR, path.basename(draft.mediaPath))
    : path.join(process.cwd(), "public", path.normalize(rel).replace(/^([./\\])+/, ""));
  if (!fs.existsSync(file)) throw new SubmissionError("Draft media file is no longer available", 404);
  const ext = path.extname(file).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw new SubmissionError("Draft media type cannot enter the evidence pipeline", 400);
  const bytes = fs.readFileSync(file);

  // SVG demo assets go through the demo-fallback path (the live pipeline
  // accepts raster photos only) — mirroring field capture behavior.
  const result = await processEvidenceSubmission(
    {
      milestoneId: draft.milestoneId,
      photoDataUrl:
        mime === "image/svg+xml"
          ? undefined
          : `data:${mime};base64,${bytes.toString("base64")}`,
      demoPhotoId:
        mime === "image/svg+xml"
          ? repo.listDemoFallbackPhotos(draft.milestoneId)[0]?.id
          : undefined,
      latitude: draft.latitude as unknown as number, // null preserved — geofence handles it
      longitude: draft.longitude as unknown as number,
      capturedAt: draft.sourceTimestamp, // provider message time — NOT claimed as capture time
      deviceMetadata: {
        userAgent: `Promoted communication media (source: ${draft.sourceProvider}; no original device metadata)`,
        platform: draft.sourceProvider,
        screen: "unknown",
        language: "unknown",
      },
      isDemoFallback: mime === "image/svg+xml",
    },
    submitter.id
  );
  repo.updateDraft(draftId, {
    status: "SUBMITTED",
    submittedAt: new Date().toISOString(),
    evidenceItemId: result.evidence.id,
  });
  return result;
}

// ==================================================================
// Field home summary — READ-ONLY presentation read model
// ==================================================================

/**
 * The Field home screen needs, in one payload, what a field engineer must
 * know: what they captured recently and what needs them next.
 *
 * This is a READ MODEL and nothing else. It computes no new truth: every
 * value is read from the records that already own it — evidence items and
 * their governed verifications, milestone status, clarification requests,
 * field issues. It never persists, never derives a new score, and never
 * turns an advisory signal into an authoritative fact.
 *
 * SCOPING IS THE CALLER'S: it operates on the milestone list the
 * /api/field-context route has ALREADY scoped through
 * authz.accessibleProjects + the caller's field assignments. Nothing here
 * widens that set, and no consumer filters a portfolio-wide list in the
 * browser.
 */
export interface FieldSummaryMilestoneRef {
  projectId: string;
  projectName: string;
  milestoneId: string;
  seq: number;
  title: string;
  status: string;
}

export interface FieldRecentEvidence {
  evidenceItemId: string;
  milestoneId: string;
  milestoneLabel: string;
  projectName: string;
  photoPath: string;
  capturedAt: string;
  uploadedAt: string;
  hasLocation: boolean;
  isDemoFallback: boolean;
  /** The GOVERNED evidence state — the authoritative reading. */
  state: "SUBMITTED" | "VERIFIED" | "NEEDS_REVIEW" | "REJECTED";
  /** Advisory only: the automated assessment's confidence, 0..1, or null
   *  when no verification has been recorded. It NEVER substitutes for
   *  `state` and never outranks it. */
  assessmentConfidence: number | null;
}

export interface FieldAttentionItem {
  /** Governed state label shown to the field user. */
  state: string;
  tone: "info" | "warn" | "bad";
  title: string;
  reason: string;
  context: string;
  href: string | null;
  action: string;
}

export interface FieldAdvisorySignal {
  severity: "REVIEW_REQUIRED" | "ADVISORY";
  name: string;
  detail: string;
  context: string;
}

export interface FieldHomeSummary {
  recentEvidence: FieldRecentEvidence[];
  attention: FieldAttentionItem[];
  advisory: FieldAdvisorySignal[];
  counts: { verified: number; needsReview: number; rejected: number; submitted: number };
}

const RECENT_EVIDENCE_LIMIT = 6;

/** Governed evidence state for one item — the same reading
 *  completionGates.evidenceReviewStatus applies to a milestone, resolved
 *  per evidence item. No verification recorded yet = SUBMITTED. */
function governedEvidenceState(evidenceItemId: string): {
  state: FieldRecentEvidence["state"];
  confidence: number | null;
} {
  const v = repo.getVerificationForEvidence(evidenceItemId);
  if (!v) return { state: "SUBMITTED", confidence: null };
  const state =
    v.verdict === "VERIFIED" ? "VERIFIED" : v.verdict === "REJECTED" ? "REJECTED" : "NEEDS_REVIEW";
  return { state, confidence: v.confidence };
}

export function fieldHomeSummary(
  user: User,
  scope: FieldSummaryMilestoneRef[]
): FieldHomeSummary {
  const recentEvidence: FieldRecentEvidence[] = [];
  const attention: FieldAttentionItem[] = [];
  const advisory: FieldAdvisorySignal[] = [];
  const counts = { verified: 0, needsReview: 0, rejected: 0, submitted: 0 };

  for (const ref of scope) {
    const label = `M${ref.seq} · ${ref.title}`;
    const items = repo.listEvidenceForMilestone(ref.milestoneId);

    for (const item of items) {
      const { state, confidence } = governedEvidenceState(item.id);
      if (state === "VERIFIED") counts.verified += 1;
      else if (state === "NEEDS_REVIEW") counts.needsReview += 1;
      else if (state === "REJECTED") counts.rejected += 1;
      else counts.submitted += 1;
      recentEvidence.push({
        evidenceItemId: item.id,
        milestoneId: ref.milestoneId,
        milestoneLabel: label,
        projectName: ref.projectName,
        photoPath: item.photoPath,
        capturedAt: item.capturedAt,
        uploadedAt: item.uploadedAt,
        hasLocation: item.latitude !== null && item.longitude !== null,
        isDemoFallback: item.isDemoFallback,
        state,
        assessmentConfidence: confidence,
      });
    }

    // Attention — milestone still awaiting its first evidence.
    if (ref.status === "PENDING_EVIDENCE" && items.length === 0) {
      attention.push({
        state: "EVIDENCE NEEDED",
        tone: "info",
        title: label,
        reason: "No evidence has been captured for this milestone yet.",
        context: ref.projectName,
        href: null,
        action: "Capture",
      });
    }

    // Attention — the latest submission came back needing work. The
    // governed verdict is the reason; the field user is who can act.
    const latest = items[items.length - 1];
    if (latest) {
      const { state } = governedEvidenceState(latest.id);
      if (state === "NEEDS_REVIEW") {
        attention.push({
          state: "UNDER REVIEW",
          tone: "warn",
          title: label,
          reason: "Your latest submission is with a reviewer. No action needed unless they ask.",
          context: ref.projectName,
          href: `/milestone/${ref.milestoneId}`,
          action: "Open",
        });
      } else if (state === "REJECTED") {
        attention.push({
          state: "RECAPTURE NEEDED",
          tone: "bad",
          title: label,
          reason: "The latest evidence was rejected in verification — capture a replacement.",
          context: ref.projectName,
          href: `/milestone/${ref.milestoneId}`,
          action: "Open",
        });
      }
    }

    // Attention — open clarification requests are an explicit ask of the
    // field side (the reviewer's own recorded question).
    for (const c of repo.listOpenClarificationsForMilestone(ref.milestoneId)) {
      attention.push({
        state: "NEEDS RESPONSE",
        tone: "warn",
        title: label,
        reason: c.question,
        context: ref.projectName,
        href: `/milestone/${ref.milestoneId}`,
        action: "Respond",
      });
    }

    // Advisory — deterministic checks the recorded verification itself
    // failed. Shown as signals, never as a governed conclusion.
    if (latest) {
      const v = repo.getVerificationForEvidence(latest.id);
      for (const check of v?.checks ?? []) {
        if (check.passed) continue;
        advisory.push({
          severity: v!.verdict === "VERIFIED" ? "ADVISORY" : "REVIEW_REQUIRED",
          name: check.name,
          detail: check.detail,
          context: label,
        });
      }
    }
  }

  // Field issues assigned to or reported by this user, already scoped by
  // the existing service predicate.
  const scopedProjectIds = new Set(scope.map((s) => s.projectId));
  for (const issue of listFieldIssuesForUser(user)) {
    if (!scopedProjectIds.has(issue.projectId)) continue;
    if (issue.status === "RESOLVED" || issue.status === "CLOSED") continue;
    attention.push({
      state: issue.severity === "CRITICAL" || issue.severity === "HIGH" ? "ISSUE OPEN" : "ISSUE LOGGED",
      tone: issue.severity === "CRITICAL" || issue.severity === "HIGH" ? "bad" : "warn",
      title: issue.title,
      reason: issue.description,
      context: scope.find((s) => s.projectId === issue.projectId)?.projectName ?? "",
      href: `/issue/${issue.id}`,
      action: "Open",
    });
  }

  // Newest first, capped — the phone shows what is current.
  recentEvidence.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  return {
    recentEvidence: recentEvidence.slice(0, RECENT_EVIDENCE_LIMIT),
    attention,
    advisory: advisory.slice(0, 4),
    counts,
  };
}
