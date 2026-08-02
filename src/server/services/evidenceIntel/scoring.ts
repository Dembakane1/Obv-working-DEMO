/**
 * Evidence completeness / quality / confidence scoring.
 *
 * All scores are DERIVED on read from the authoritative evidence,
 * verification, milestone, and document records — never stored as a
 * source of truth, never an input to any control decision. Scores are
 * explainable: each returns the parts it is composed of. A score is a
 * reviewer aid, not a verdict.
 */
import * as repo from "../../db/repo";
import type { EvidenceItem, Project } from "../../../shared/types";
import type { SignalDraft } from "./core";
import { projectContext } from "./core";

export interface EvidenceScore {
  /** 0-100 documentation completeness. */
  completeness: number;
  /** 0-100 evidence quality (verification confidence + metadata richness). */
  quality: number;
  /** 0-100 mean review confidence. */
  confidence: number;
  parts: {
    milestones: number;
    milestonesWithEvidence: number;
    milestonesVerified: number;
    meanVerificationConfidence: number;
    evidenceWithGps: number;
    evidenceTotal: number;
  };
}

const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 100) : 0);

/** Per-project evidence score, composed from existing records only. */
export function scoreProject(project: Project): EvidenceScore {
  const milestones = repo.listMilestones(project.id).filter((m) => !m.archived);
  let withEvidence = 0;
  let verified = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  let evidenceTotal = 0;
  let evidenceWithGps = 0;

  for (const m of milestones) {
    const items = repo.listEvidenceForMilestone(m.id);
    if (items.length > 0) withEvidence += 1;
    evidenceTotal += items.length;
    evidenceWithGps += items.filter((e) => e.latitude !== null && e.longitude !== null).length;
    const latest = repo.latestEvidenceForMilestone(m.id);
    if (latest) {
      const verification = repo.getVerificationForEvidence(latest.id);
      if (verification) {
        confidenceSum += verification.confidence;
        confidenceCount += 1;
        if (verification.verdict === "VERIFIED") verified += 1;
      }
    }
  }

  const meanConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0;
  // Completeness: how much of the milestone structure carries evidence.
  const completeness = pct(withEvidence, milestones.length);
  // Quality: verification confidence, lightly rewarded for GPS-tagged
  // evidence (richer metadata), capped at 100.
  const gpsBonus = evidenceTotal > 0 ? (evidenceWithGps / evidenceTotal) * 10 : 0;
  const quality = Math.min(100, Math.round(meanConfidence * 90 + gpsBonus));
  const confidence = Math.round(meanConfidence * 100);

  return {
    completeness,
    quality,
    confidence,
    parts: {
      milestones: milestones.length,
      milestonesWithEvidence: withEvidence,
      milestonesVerified: verified,
      meanVerificationConfidence: Number(meanConfidence.toFixed(4)),
      evidenceWithGps,
      evidenceTotal,
    },
  };
}

/** Per-evidence-item quality signal (0-100), from its verification and
 *  metadata richness. */
export function scoreEvidenceItem(evidence: EvidenceItem): { quality: number; confidence: number; hasGps: boolean } {
  const verification = repo.getVerificationForEvidence(evidence.id);
  const confidence = verification ? Math.round(verification.confidence * 100) : 0;
  const hasGps = evidence.latitude !== null && evidence.longitude !== null;
  const quality = Math.min(100, Math.round((verification?.confidence ?? 0) * 90 + (hasGps ? 10 : 0)));
  return { quality, confidence, hasGps };
}

const LOW_COMPLETENESS = 50;
const LOW_QUALITY = 55;

/** Advisory findings when a launched project scores low. Only for ACTIVE
 *  projects (a draft has not gathered evidence yet, so a low score is
 *  expected and not worth surfacing). */
export function scoringFindings(project: Project, score: EvidenceScore): SignalDraft[] {
  if (project.status !== "ACTIVE") return [];
  const ctx = projectContext(project.id);
  const drafts: SignalDraft[] = [];
  const base = {
    subjectType: "PROJECT" as const,
    subjectId: project.id,
    organizationId: ctx.organizationId,
    projectId: project.id,
  };
  if (score.completeness < LOW_COMPLETENESS && score.parts.milestones > 0) {
    drafts.push({
      ...base,
      category: "LOW_COMPLETENESS",
      severity: "LOW",
      confidence: 0.6,
      title: `Documentation completeness is ${score.completeness}%`,
      explanation:
        `${score.parts.milestonesWithEvidence} of ${score.parts.milestones} active milestones carry evidence. ` +
        "Low completeness is expected early in a project and is not a defect — surfaced so a reviewer can see where " +
        "evidence is still outstanding.",
      comparison: { completeness: score.completeness, milestones: score.parts.milestones, withEvidence: score.parts.milestonesWithEvidence },
      recommendation: "Follow up on milestones still missing evidence if the project is expected to be further along.",
      signalKey: `low-completeness:${project.id}`,
    });
  }
  if (score.quality < LOW_QUALITY && score.parts.evidenceTotal > 0) {
    drafts.push({
      ...base,
      category: "LOW_QUALITY",
      severity: "LOW",
      confidence: 0.55,
      title: `Evidence quality score is ${score.quality}`,
      explanation:
        `Mean verification confidence is ${(score.parts.meanVerificationConfidence * 100).toFixed(0)}% and ` +
        `${score.parts.evidenceWithGps} of ${score.parts.evidenceTotal} items carry GPS. This is a reviewer aid, ` +
        "not a verdict on any single item.",
      comparison: { quality: score.quality, meanConfidence: score.parts.meanVerificationConfidence, gps: `${score.parts.evidenceWithGps}/${score.parts.evidenceTotal}` },
      recommendation: "Review lower-confidence milestones; request richer captures where useful.",
      signalKey: `low-quality:${project.id}`,
    });
  }
  return drafts;
}
