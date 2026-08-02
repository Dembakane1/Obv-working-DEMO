/**
 * Analysis orchestrator — the pass that turns authoritative records into
 * advisory findings.
 *
 * It runs the metadata engine, OCR, duplicate + document detectors, and
 * scoring, records each finding (idempotently), and enqueues the
 * actionable ones for reviewers. It NEVER approves a draw, rejects
 * evidence, releases funds, changes project progress, or creates an
 * exception — analysis produces signals and queue items, nothing else.
 */
import * as repo from "../../db/repo";
import * as evidenceIntelRepo from "../../db/evidenceIntelRepo";
import * as authz from "../authz";
import type { EvidenceAnalysisRun, Project, User } from "../../../shared/types";
import {
  EvidenceIntelError,
  accessibleDocuments,
  accessibleEvidence,
  assertViewer,
  nowIso,
  recordSignal,
  requireVisibleProject,
  type SignalDraft,
} from "./core";
import { computeMetadataFacts, metadataFindings } from "./metadata";
import { extractDocument } from "./ocr";
import { evidenceDuplicateFindings, devicePatternFindings, documentDuplicateFindings } from "./detectors";
import { scoreProject, scoringFindings } from "./scoring";
import { enqueueSignal } from "./review";

/** Populate derived facts (metadata + OCR) across everything the caller
 *  can see, so cross-project / cross-contractor detectors have their
 *  peers present. Idempotent (upserts); pure derivation. */
function populateDerived(user: User): { evidence: number; documents: number } {
  const evidence = accessibleEvidence(user);
  for (const e of evidence) computeMetadataFacts(e);
  const documents = accessibleDocuments(user);
  for (const d of documents) extractDocument(d);
  return { evidence: evidence.length, documents: documents.length };
}

/** All advisory drafts for one project's subjects (peers assumed already
 *  populated by populateDerived; cross-record comparison restricted to
 *  the caller's accessible projects). */
function detectorsForProject(project: Project, allowed: Set<string>): SignalDraft[] {
  const drafts: SignalDraft[] = [];
  for (const milestone of repo.listMilestones(project.id)) {
    for (const evidence of repo.listEvidenceForMilestone(milestone.id)) {
      const facts = evidenceIntelRepo.getMetadataFacts(evidence.id) ?? computeMetadataFacts(evidence);
      drafts.push(...metadataFindings(evidence, facts));
      drafts.push(...evidenceDuplicateFindings(evidence, facts, allowed));
      drafts.push(...devicePatternFindings(evidence, facts, allowed));
    }
  }
  for (const draw of repo.listDrawRequestsForProject(project.id)) {
    for (const doc of repo.listDrawDocuments(draw.id)) {
      const extraction = evidenceIntelRepo.listExtractionsForSubject("DOCUMENT", doc.id)[0];
      if (extraction) drafts.push(...documentDuplicateFindings(doc, extraction, allowed));
    }
  }
  const score = scoreProject(project);
  drafts.push(...scoringFindings(project, score));
  return drafts;
}

function recordAndQueue(drafts: SignalDraft[], runId: string | null): { signals: number; queued: number } {
  let signals = 0;
  let queued = 0;
  for (const draft of drafts) {
    const signal = recordSignal(draft, runId);
    if (!signal) continue;
    signals += 1;
    if (enqueueSignal(signal)) queued += 1;
  }
  return { signals, queued };
}

/** Analyze one project. Same-404 for a project the caller cannot see. */
export function analyzeProject(
  user: User,
  projectId: string,
  trigger: "ON_DEMAND" | "REANALYZE" = "ON_DEMAND"
): { run: EvidenceAnalysisRun; signals: number; queued: number } {
  assertViewer(user);
  const project = requireVisibleProject(user, projectId);
  const run: EvidenceAnalysisRun = {
    id: repo.newId(),
    subjectType: "PROJECT",
    subjectId: project.id,
    organizationId: project.organizationId,
    projectId: project.id,
    trigger,
    status: "RUNNING",
    signalCount: 0,
    startedByUserId: user.id,
    startedAt: nowIso(),
    finishedAt: null,
    detail: null,
  };
  evidenceIntelRepo.insertAnalysisRun(run);
  try {
    populateDerived(user);
    const allowed = authz.accessibleProjectIds(user);
    const drafts = detectorsForProject(project, allowed);
    const { signals, queued } = recordAndQueue(drafts, run.id);
    evidenceIntelRepo.finishAnalysisRun(run.id, "COMPLETED", signals, `queued=${queued}`);
    return { run: evidenceIntelRepo.getAnalysisRun(run.id)!, signals, queued };
  } catch (err) {
    evidenceIntelRepo.finishAnalysisRun(run.id, "FAILED", 0, err instanceof Error ? err.message.slice(0, 300) : "error");
    throw err;
  }
}

/** Analyze the caller's entire accessible portfolio. */
export function analyzePortfolio(
  user: User,
  trigger: "ON_DEMAND" | "REANALYZE" = "ON_DEMAND"
): { run: EvidenceAnalysisRun; signals: number; queued: number; projects: number } {
  assertViewer(user);
  const projects = authz.accessibleProjects(user);
  const run: EvidenceAnalysisRun = {
    id: repo.newId(),
    subjectType: "PROJECT",
    subjectId: user.organizationId,
    organizationId: user.organizationId,
    projectId: null,
    trigger,
    status: "RUNNING",
    signalCount: 0,
    startedByUserId: user.id,
    startedAt: nowIso(),
    finishedAt: null,
    detail: `portfolio:${projects.length} projects`,
  };
  evidenceIntelRepo.insertAnalysisRun(run);
  try {
    populateDerived(user);
    const allowed = authz.accessibleProjectIds(user);
    let signals = 0;
    let queued = 0;
    for (const project of projects) {
      const r = recordAndQueue(detectorsForProject(project, allowed), run.id);
      signals += r.signals;
      queued += r.queued;
    }
    evidenceIntelRepo.finishAnalysisRun(run.id, "COMPLETED", signals, `projects=${projects.length} queued=${queued}`);
    return { run: evidenceIntelRepo.getAnalysisRun(run.id)!, signals, queued, projects: projects.length };
  } catch (err) {
    evidenceIntelRepo.finishAnalysisRun(run.id, "FAILED", 0, err instanceof Error ? err.message.slice(0, 300) : "error");
    throw err;
  }
}

/** On-demand single-item analysis (used when opening one evidence item):
 *  ensures peers are populated, then records that item's findings. */
export function analyzeEvidenceItem(user: User, evidenceItemId: string): { signals: number; queued: number } {
  assertViewer(user);
  const evidence = repo.getEvidence(String(evidenceItemId ?? ""));
  if (!evidence) throw new EvidenceIntelError("Not found", 404);
  const milestone = repo.getMilestone(evidence.milestoneId);
  const project = milestone ? repo.getProject(milestone.projectId) : null;
  if (!project || !authz.accessibleProjectIds(user).has(project.id)) {
    throw new EvidenceIntelError("Not found", 404);
  }
  populateDerived(user);
  const allowed = authz.accessibleProjectIds(user);
  const facts = evidenceIntelRepo.getMetadataFacts(evidence.id) ?? computeMetadataFacts(evidence);
  const drafts = [
    ...metadataFindings(evidence, facts),
    ...evidenceDuplicateFindings(evidence, facts, allowed),
    ...devicePatternFindings(evidence, facts, allowed),
  ];
  return recordAndQueue(drafts, null);
}
