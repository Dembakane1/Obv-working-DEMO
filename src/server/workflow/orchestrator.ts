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
import { aiVerificationService } from "../services/AiVerificationService";
import { wormEvidenceStore, sha256 } from "../services/WormEvidenceStore";
import { virtualAccountService } from "../services/VirtualAccountService";
import { teamsNotifier } from "../services/TeamsNotifier";
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
    const stored = await wormEvidenceStore.storeObject(photoBytes, ext);
    photoPath = stored.path;
    photoHash = stored.hash;
  } else {
    throw new SubmissionError("Submission must include photoDataUrl or demoPhotoId");
  }

  // ---- 2. Record the evidence item ----
  const previous = repo.latestEvidenceForMilestone(milestone.id);
  const uploadedAt = new Date().toISOString();
  const evidence: EvidenceItem = {
    id: repo.newId(),
    milestoneId: milestone.id,
    userId,
    photoPath,
    latitude: submission.latitude,
    longitude: submission.longitude,
    capturedAt: submission.capturedAt,
    uploadedAt,
    deviceMetadata: submission.deviceMetadata,
    hash: sha256(
      JSON.stringify({
        photoHash,
        latitude: submission.latitude,
        longitude: submission.longitude,
        capturedAt: submission.capturedAt,
        uploadedAt,
      })
    ),
    previousHash: previous?.hash ?? null,
    isDemoFallback: submission.isDemoFallback,
  };
  repo.insertEvidence(evidence);

  // ---- 3. Verification ----
  const result = await aiVerificationService.verify({
    evidence,
    milestone,
    project,
    photoBytes,
  });
  const verification: Verification = {
    id: repo.newId(),
    evidenceItemId: evidence.id,
    verdict: result.verdict,
    confidence: result.confidence,
    checks: result.checks,
    reasoning: result.reasoning,
    createdAt: new Date().toISOString(),
  };
  repo.insertVerification(verification);

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
    await teamsNotifier.notify(
      "MILESTONE_VERIFIED",
      `Milestone ${milestone.seq} "${milestone.title}" verified (confidence ${result.confidence}). Approval requested from Funder Rep + Compliance. Tranche of $${milestone.trancheAmount.toLocaleString("en-US")} remains HELD.`
    );
  } else if (verification.verdict === "NEEDS_REVIEW") {
    repo.updateMilestoneStatus(milestone.id, "UNDER_REVIEW");
    await teamsNotifier.notify(
      "EVIDENCE_NEEDS_REVIEW",
      `Evidence for milestone ${milestone.seq} "${milestone.title}" was flagged for human review: ${result.reasoning}`
    );
  } else {
    await teamsNotifier.notify(
      "EVIDENCE_REJECTED",
      `Evidence for milestone ${milestone.seq} "${milestone.title}" was rejected: ${result.reasoning}`
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

  repo.insertApprovalRecord({
    id: repo.newId(),
    approvalRequestId: request.id,
    userId: user.id,
    role: user.role,
    decision,
    createdAt: new Date().toISOString(),
  });
  const records = repo.listApprovalRecordsForRequest(request.id);

  let released = false;
  if (decision === "REJECTED") {
    repo.updateApprovalRequestStatus(request.id, "REJECTED");
    // Rejected governance sends the milestone back for new field evidence.
    repo.updateMilestoneStatus(milestone.id, "PENDING_EVIDENCE");
    await teamsNotifier.notify(
      "APPROVAL_REJECTED",
      `${user.name} (${user.title}) rejected release for milestone ${milestone.seq} "${milestone.title}". Tranche of $${milestone.trancheAmount.toLocaleString("en-US")} remains HELD; new evidence required.`
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
      await virtualAccountService.releaseTranche(milestone);
      repo.updateMilestoneStatus(milestone.id, "RELEASED");
      released = true;
      await teamsNotifier.notify(
        "TRANCHE_RELEASED",
        `All approvals complete for milestone ${milestone.seq} "${milestone.title}". Tranche of $${milestone.trancheAmount.toLocaleString("en-US")} RELEASED on the virtual project account.`
      );
    } else {
      const missing = request.requiredRoles.filter((role) => !approvedRoles.has(role));
      await teamsNotifier.notify(
        "APPROVAL_RECORDED",
        `${user.name} (${user.title}) approved milestone ${milestone.seq} "${milestone.title}" (${approvedRoles.size} of ${request.requiredRoles.length}). Awaiting ${missing.join(", ")}. Funds remain HELD.`
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
