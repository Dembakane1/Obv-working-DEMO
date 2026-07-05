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
import { teamsNotifier } from "../services/TeamsNotifier";
import type {
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
