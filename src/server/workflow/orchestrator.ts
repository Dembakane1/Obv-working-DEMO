/**
 * Central workflow orchestrator — the single place that owns the pipeline:
 *
 *   evidence submitted
 *     -> verification completed (AiVerificationService)
 *     -> ledger entry created   (WormEvidenceStore, hash-chained)
 *     -> approval request created (human governance gate)
 *
 * Funds are NEVER released here: a VERIFIED milestone stays financially
 * HELD until a human approves the ApprovalRequest (later prompt).
 *
 * TODO: swap orchestration to a Temporal.io workflow (one activity per
 *       step, with retries and compensation) without changing the
 *       services' interfaces.
 */
import * as repo from "../db/repo";
import { runVerificationPipeline } from "../services/verification/index";
import { wormEvidenceStore, sha256 } from "../services/WormEvidenceStore";
import { virtualAccountService } from "../services/VirtualAccountService";
import { teamsNotifier } from "../services/TeamsNotifier";
import { mirrorEvent } from "../services/chat";
import {
  approvalRecordedCard,
  approvalRejectedCard,
  approvalRequestCard,
  milestoneVerifiedCard,
  needsReviewCard,
  rejectedCard,
  trancheReleasedCard,
} from "../services/teamsCards";
import type {
  ApprovalRecord,
  ApprovalRequest,
  EvidenceItem,
  EvidenceSubmission,
  LedgerEntry,
  Milestone,
  Verification,
} from "../../shared/types";

export interface SubmissionResult {
  evidence: EvidenceItem;
  verification: Verification;
  ledgerEntry: LedgerEntry | null;
  approvalRequest: ApprovalRequest | null;
  milestone: Milestone;
}

export class SubmissionError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

export async function processEvidenceSubmission(
  submission: EvidenceSubmission,
  userId: string
): Promise<SubmissionResult> {
  const milestone = repo.getMilestone(submission.milestoneId);
  if (!milestone) throw new SubmissionError("Unknown milestone", 404);
  const project = repo.getProject(milestone.projectId);
  if (!project) throw new SubmissionError("Unknown project", 404);
  const user = repo.getUser(userId);
  if (!user) throw new SubmissionError("Unknown user — select a demo user first", 401);

  // ---- 1. Persist the photo into WORM evidence storage ----
  let photoPath: string;
  let photoBytes: Buffer | undefined;
  let photoMediaType: string | undefined;
  let photoHash: string;

  if (submission.demoPhotoId) {
    // DEMO FALLBACK: a seeded evidence photo, served from /demo-evidence/.
    const demoPhoto = repo.getDemoFallbackPhoto(submission.demoPhotoId);
    if (!demoPhoto) throw new SubmissionError("Unknown demo fallback photo", 404);
    photoPath = demoPhoto.path;
    photoHash = sha256(`demo-fallback:${demoPhoto.path}`);
  } else if (submission.photoDataUrl) {
    const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(
      submission.photoDataUrl
    );
    if (!match) throw new SubmissionError("photoDataUrl must be a base64 image data URL");
    photoBytes = Buffer.from(match[2], "base64");
    if (photoBytes.length < 64) throw new SubmissionError("Photo payload is empty");
    if (photoBytes.length > 12 * 1024 * 1024) {
      throw new SubmissionError("Photo too large (12 MB limit)", 413);
    }
    const ext = match[1] === "jpg" ? "jpeg" : match[1];
    photoMediaType = `image/${ext}`;
    const stored = await wormEvidenceStore.storeObject(photoBytes, ext);
    photoPath = stored.path;
    photoHash = stored.hash;
  } else {
    throw new SubmissionError("Submission must include photoDataUrl or demoPhotoId");
  }

  // ---- 2. Record the evidence item ----
  // GPS is stored as-provided or null; missing GPS is never silently
  // passed — the deterministic geofence check routes it to REVIEW.
  const latitude =
    typeof submission.latitude === "number" && Number.isFinite(submission.latitude)
      ? submission.latitude
      : null;
  const longitude =
    typeof submission.longitude === "number" && Number.isFinite(submission.longitude)
      ? submission.longitude
      : null;
  // ---- Offline-retry idempotency ----
  // If the network drops after the server processed a submission but
  // before the client saw the response, the field client queues the same
  // payload and replays it on reconnect. The replayed payload is
  // byte-identical (same photo, GPS, capture timestamp), so it derives
  // the same key; return the already-recorded result instead of creating
  // duplicate evidence / verification / ledger entries. A genuinely new
  // capture always carries a new capturedAt and never collides.
  // NOTE: the lookup below and insertEvidence further down execute with
  // no await between them, so the check-then-insert is atomic on the
  // single-threaded event loop.
  const submissionKey = sha256(
    JSON.stringify({
      milestoneId: milestone.id,
      photoHash,
      latitude: submission.latitude ?? null,
      longitude: submission.longitude ?? null,
      capturedAt: submission.capturedAt,
    })
  );
  const duplicate = repo.findEvidenceBySubmissionKey(submissionKey);
  if (duplicate) {
    const existingVerification = repo.getVerificationForEvidence(duplicate.id);
    if (!existingVerification) {
      // First attempt still mid-pipeline — tell the client to stand by
      // rather than double-processing.
      throw new SubmissionError("This submission is already being processed", 409);
    }
    return {
      evidence: duplicate,
      verification: existingVerification,
      ledgerEntry: repo.getLedgerEntryForEvidence(duplicate.id),
      approvalRequest: repo.getApprovalRequestForMilestone(milestone.id),
      milestone: repo.getMilestone(milestone.id)!,
    };
  }

  const previous = repo.latestEvidenceForMilestone(milestone.id);
  const uploadedAt = new Date().toISOString();
  const evidence: EvidenceItem = {
    id: repo.newId(),
    milestoneId: milestone.id,
    userId,
    photoPath,
    latitude,
    longitude,
    capturedAt: submission.capturedAt,
    uploadedAt,
    deviceMetadata: submission.deviceMetadata,
    hash: sha256(
      JSON.stringify({ photoHash, latitude, longitude, capturedAt: submission.capturedAt, uploadedAt })
    ),
    previousHash: previous?.hash ?? null,
    isDemoFallback: submission.isDemoFallback,
  };
  repo.insertEvidence(evidence, submissionKey);

  // ---- 3. Hybrid verification pipeline ----
  // AI assesses the image; geofence and metadata checks are deterministic
  // application logic; the aggregator computes the verdict. The model can
  // never move money or bypass governance — release stays behind the
  // ApprovalRequest created in step 5.
  const result = await runVerificationPipeline({
    milestone,
    project,
    photoPath,
    photoBytes,
    photoMediaType,
    latitude,
    longitude,
    capturedAt: submission.capturedAt,
    uploadedAt,
    deviceMetadata: submission.deviceMetadata,
    seedHash: evidence.hash,
    isDemoFallback: submission.isDemoFallback,
  });
  const verification: Verification = {
    id: repo.newId(),
    evidenceItemId: evidence.id,
    verdict: result.verdict,
    confidence: result.confidence,
    checks: result.checks,
    reasoning: result.reasoning,
    createdAt: new Date().toISOString(),
    source: result.source,
  };
  repo.insertVerification(verification);

  // ---- audit events (in-app only — low-value for a Teams channel) ----
  const auditCtx = { projectId: project.id, milestoneId: milestone.id };
  if (result.source === "LIVE_AI") {
    await teamsNotifier.notify(
      "AI_VISUAL_VERIFICATION_SUCCEEDED",
      `Live AI visual assessment completed for milestone ${milestone.seq} "${milestone.title}".`,
      auditCtx
    );
  } else if (result.source === "MOCK_FALLBACK") {
    await teamsNotifier.notify(
      "AI_VISUAL_FALLBACK_USED",
      `Live AI visual assessment unavailable (${result.fallbackNote ?? "provider failure"}); deterministic demo fallback used for milestone ${milestone.seq}.`,
      auditCtx
    );
  }
  await teamsNotifier.notify(
    "VERIFICATION_AGGREGATED",
    `Verification aggregated for milestone ${milestone.seq}: ${result.verdict} (confidence ${result.confidence.toFixed(2)}; visual: ${result.checks[0].passed ? "pass" : "flag"}, geofence: ${result.checks[1].passed ? "pass" : "flag"}, metadata: ${result.checks[2].passed ? "pass" : "flag"}; source: ${result.source}).`,
    auditCtx
  );

  // Mirror into the project/milestone discussion thread (informational
  // system events only — chat never drives any workflow state).
  mirrorEvent(
    `Evidence submitted for M${milestone.seq} by ${user.name}${evidence.isDemoFallback ? " (demo fallback)" : ""}.`,
    { projectId: project.id, milestoneId: milestone.id, refType: "EVIDENCE_REFERENCE", refId: evidence.id }
  );
  mirrorEvent(
    `Verification completed: ${result.verdict.replace(/_/g, " ")} · confidence ${result.confidence.toFixed(2)}.`,
    { projectId: project.id, milestoneId: milestone.id }
  );

  // ---- 4. Ledger entry (only successfully verified evidence enters the
  //         tamper-evident chain) ----
  let ledgerEntry: LedgerEntry | null = null;
  if (verification.verdict === "VERIFIED") {
    ledgerEntry = await wormEvidenceStore.appendLedgerEntry({
      evidenceItemId: evidence.id,
      milestoneId: milestone.id,
      verificationId: verification.id,
      payloadHash: sha256(
        JSON.stringify({ evidenceHash: evidence.hash, verdict: verification.verdict, confidence: verification.confidence })
      ),
    });
  }

  // ---- 5. Milestone state + approval request (human governance gate) ----
  let approvalRequest: ApprovalRequest | null = null;
  if (verification.verdict === "VERIFIED") {
    repo.updateMilestoneStatus(milestone.id, "VERIFIED");
    approvalRequest = repo.getApprovalRequestForMilestone(milestone.id);
    if (!approvalRequest || approvalRequest.status !== "PENDING") {
      approvalRequest = {
        id: repo.newId(),
        milestoneId: milestone.id,
        status: "PENDING",
        requiredRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"],
        createdAt: new Date().toISOString(),
      };
      repo.insertApprovalRequest(approvalRequest);
    }
    // Funds intentionally remain HELD: release requires human approval.
    const cardCtx = { project, milestone, verification, submittedBy: user };
    await teamsNotifier.notify(
      "MILESTONE_VERIFIED",
      `Milestone ${milestone.seq} "${milestone.title}" verified (confidence ${result.confidence}). Tranche of $${milestone.trancheAmount.toLocaleString("en-US")} remains HELD.`,
      { ...auditCtx, card: milestoneVerifiedCard(cardCtx) }
    );
    await teamsNotifier.notify(
      "APPROVAL_REQUEST_CREATED",
      `Approval request created for milestone ${milestone.seq} "${milestone.title}" — requires ${approvalRequest.requiredRoles.join(" + ")}. Funds HELD.`,
      { ...auditCtx, card: approvalRequestCard({ ...cardCtx, approval: approvalRequest }) }
    );
    mirrorEvent(
      `Approval request created — requires ${approvalRequest.requiredRoles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(" + ")}. $${milestone.trancheAmount.toLocaleString("en-US")} remains HELD.`,
      { projectId: project.id, milestoneId: milestone.id, refType: "APPROVAL_REFERENCE", refId: approvalRequest.id }
    );
  } else if (verification.verdict === "NEEDS_REVIEW") {
    repo.updateMilestoneStatus(milestone.id, "UNDER_REVIEW");
    await teamsNotifier.notify(
      "EVIDENCE_NEEDS_REVIEW",
      `Evidence for milestone ${milestone.seq} "${milestone.title}" was flagged for human review: ${result.reasoning}`,
      { ...auditCtx, card: needsReviewCard({ project, milestone, verification, submittedBy: user }) }
    );
  } else {
    await teamsNotifier.notify(
      "EVIDENCE_REJECTED",
      `Evidence for milestone ${milestone.seq} "${milestone.title}" was rejected: ${result.reasoning}`,
      { ...auditCtx, card: rejectedCard({ project, milestone, verification, submittedBy: user }) }
    );
  }

  const updatedMilestone = repo.getMilestone(milestone.id)!;
  return { evidence, verification, ledgerEntry, approvalRequest, milestone: updatedMilestone };
}

// ---------------------------------------------------------------------
// Human approval decisions — the governance gate that controls release.
// Uses the ApprovalRequest/ApprovalRecord model created in Prompt 0:
// every role in requiredRoles must approve before the tranche releases.
// ---------------------------------------------------------------------

export interface ApprovalDecisionResult {
  approvalRequest: ApprovalRequest;
  records: ApprovalRecord[];
  milestone: Milestone;
  released: boolean;
}

export async function processApprovalDecision(
  approvalRequestId: string,
  userId: string,
  decision: "APPROVED" | "REJECTED"
): Promise<ApprovalDecisionResult> {
  const request = repo.getApprovalRequest(approvalRequestId);
  if (!request) throw new SubmissionError("Unknown approval request", 404);
  if (request.status !== "PENDING") {
    throw new SubmissionError("This approval request has already been resolved", 409);
  }
  const user = repo.getUser(userId);
  if (!user) throw new SubmissionError("Select a demo user first", 401);
  if (!request.requiredRoles.includes(user.role)) {
    throw new SubmissionError(
      `Role ${user.role} is not part of this approval (requires ${request.requiredRoles.join(", ")})`,
      403
    );
  }
  const existing = repo.listApprovalRecordsForRequest(request.id);
  if (existing.some((r) => r.role === user.role)) {
    throw new SubmissionError(`A ${user.role} decision has already been recorded`, 409);
  }
  const milestone = repo.getMilestone(request.milestoneId)!;
  const project = repo.getProject(milestone.projectId)!;

  repo.insertApprovalRecord({
    id: repo.newId(),
    approvalRequestId: request.id,
    userId: user.id,
    role: user.role,
    decision,
    createdAt: new Date().toISOString(),
  });
  const records = repo.listApprovalRecordsForRequest(request.id);

  const notifyCtx = { projectId: project.id, milestoneId: milestone.id };
  let released = false;
  if (decision === "REJECTED") {
    repo.updateApprovalRequestStatus(request.id, "REJECTED");
    // Rejected governance sends the milestone back for new field evidence.
    repo.updateMilestoneStatus(milestone.id, "PENDING_EVIDENCE");
    await teamsNotifier.notify(
      "APPROVAL_REJECTED",
      `${user.name} (${user.title}) rejected release for milestone ${milestone.seq} "${milestone.title}". Tranche of $${milestone.trancheAmount.toLocaleString("en-US")} remains HELD; new evidence required.`,
      {
        ...notifyCtx,
        card: approvalRejectedCard({ project, milestone, approval: request, records, actor: user, decision }),
      }
    );
    mirrorEvent(
      `${user.name} (${user.title}) rejected release for M${milestone.seq}. Funds remain HELD; new evidence required.`,
      { projectId: project.id, milestoneId: milestone.id, refType: "APPROVAL_REFERENCE", refId: request.id }
    );
  } else {
    const approvedRoles = new Set(
      records.filter((r) => r.decision === "APPROVED").map((r) => r.role)
    );
    const complete = request.requiredRoles.every((role) => approvedRoles.has(role));
    if (complete) {
      repo.updateApprovalRequestStatus(request.id, "APPROVED");
      repo.updateMilestoneStatus(milestone.id, "APPROVED");
      // Governance satisfied — release the tranche on the virtual account.
      // (Only this human-driven path may reach releaseTranche; the AI
      // verification layer has no route here.)
      await virtualAccountService.releaseTranche(milestone);
      repo.updateMilestoneStatus(milestone.id, "RELEASED");
      released = true;
      const latestEvidence = repo.latestEvidenceForMilestone(milestone.id);
      const verification = latestEvidence
        ? repo.getVerificationForEvidence(latestEvidence.id)
        : null;
      const chain = await wormEvidenceStore.verifyChain();
      await teamsNotifier.notify(
        "TRANCHE_RELEASED",
        `All approvals complete for milestone ${milestone.seq} "${milestone.title}". Tranche of $${milestone.trancheAmount.toLocaleString("en-US")} RELEASED on the virtual project account.`,
        {
          ...notifyCtx,
          card: trancheReleasedCard({
            project,
            milestone,
            approval: repo.getApprovalRequest(request.id)!,
            records,
            approversByRecord: new Map(records.map((r) => [r.id, repo.getUser(r.userId) ?? undefined])),
            verification,
            chainValid: chain.valid,
          }),
        }
      );
      mirrorEvent(
        `All approvals complete for M${milestone.seq}. Tranche of $${milestone.trancheAmount.toLocaleString("en-US")} RELEASED on the virtual project account.`,
        { projectId: project.id, milestoneId: milestone.id, refType: "APPROVAL_REFERENCE", refId: request.id }
      );
    } else {
      const missing = request.requiredRoles.filter((role) => !approvedRoles.has(role));
      await teamsNotifier.notify(
        "APPROVAL_RECORDED",
        `${user.name} (${user.title}) approved milestone ${milestone.seq} "${milestone.title}" (${approvedRoles.size} of ${request.requiredRoles.length}). Awaiting ${missing.join(", ")}. Funds remain HELD.`,
        {
          ...notifyCtx,
          card: approvalRecordedCard({ project, milestone, approval: request, records, actor: user, decision }),
        }
      );
      mirrorEvent(
        `${user.name} (${user.title}) approved M${milestone.seq} (${approvedRoles.size} of ${request.requiredRoles.length}). Awaiting ${missing.map((r) => r.replace(/_/g, " ").toLowerCase()).join(", ")}. Funds remain HELD.`,
        { projectId: project.id, milestoneId: milestone.id, refType: "APPROVAL_REFERENCE", refId: request.id }
      );
    }
  }

  return {
    approvalRequest: repo.getApprovalRequest(request.id)!,
    records,
    milestone: repo.getMilestone(milestone.id)!,
    released,
  };
}
