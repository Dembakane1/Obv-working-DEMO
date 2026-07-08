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
import { mirrorEvent } from "./chat";
import { COMM_MEDIA_DIR } from "./whatsappSync/provider";
import { processEvidenceSubmission, SubmissionError } from "../workflow/orchestrator";
import type {
  ChatMessage,
  ClarificationRequest,
  EvidenceDraft,
  FieldIssue,
  User,
} from "../../shared/types";

export function canManageFieldOps(user: User): boolean {
  return ["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(user.role);
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
  const project = repo.getProject(input.projectId);
  if (!project) throw new SubmissionError("Unknown project", 404);
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
  const milestone = repo.getMilestone(input.milestoneId);
  if (!milestone) throw new SubmissionError("Unknown milestone", 404);
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
  const message = repo.getChatMessage(input.messageId);
  if (!message) throw new SubmissionError("Unknown message", 404);
  const attachment = message.attachments[input.attachmentIndex];
  if (!attachment || !attachment.url) throw new SubmissionError("No media on this message", 400);
  if (!PROMOTABLE_KINDS.has(attachment.kind ?? "")) {
    throw new SubmissionError("Only image media can be promoted to an evidence draft", 400);
  }
  const milestone = repo.getMilestone(input.milestoneId);
  if (!milestone) throw new SubmissionError("Unknown milestone", 404);
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
