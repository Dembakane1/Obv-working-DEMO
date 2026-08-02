/**
 * Evidence analytics that extend Portfolio Intelligence. All figures are
 * DERIVED on read from the advisory signals and per-project scores,
 * scoped to the projects the caller can see. Advisory only: a contractor
 * is never labelled fraudulent, and no figure is a control decision.
 */
import * as repo from "../../db/repo";
import * as evidenceIntelRepo from "../../db/evidenceIntelRepo";
import * as authz from "../authz";
import type { User } from "../../../shared/types";
import { ADVISORY_NOTICE, assertViewer, projectContext } from "./core";
import { scoreProject } from "./scoring";

export interface EvidenceAnalytics {
  advisoryNotice: string;
  documentationCompleteness: Array<{ projectId: string; projectName: string; completeness: number; quality: number; confidence: number }>;
  averageCompleteness: number;
  averageQuality: number;
  averageConfidence: number;
  duplicateTrend: Array<{ week: string; count: number }>;
  confidenceTrend: Array<{ week: string; averageConfidence: number }>;
  contractorQuality: Array<{ contractor: string; projects: number; averageQuality: number; advisoryFindings: number }>;
  reviewerWorkload: { open: number; acknowledged: number; dismissed: number; promoted: number; total: number };
  repeatedFindings: Array<{ category: string; count: number }>;
}

const DUP_CATEGORIES = new Set([
  "DUPLICATE_FILE", "CROSS_PROJECT_DUPLICATE", "CROSS_CONTRACTOR_DUPLICATE",
  "DUPLICATE_INVOICE", "DUPLICATE_RECEIPT", "DUPLICATE_PERMIT", "DUPLICATE_LIEN_WAIVER",
  "DUPLICATE_INVOICE_NUMBER", "REUSED_DOCUMENT",
]);

function isoWeek(iso: string): string {
  // Group by ISO date's year+week — cheap bucket for a trend line.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const onejan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86_400_000 + onejan.getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function evidenceAnalytics(user: User): EvidenceAnalytics {
  assertViewer(user);
  const projects = authz.accessibleProjects(user);

  // Per-project scores → documentation completeness + quality.
  const perProject = projects.map((p) => {
    const score = scoreProject(p);
    return {
      projectId: p.id,
      projectName: p.name,
      completeness: score.completeness,
      quality: score.quality,
      confidence: score.confidence,
      contractor: projectContext(p.id).contractorName ?? "Unassigned",
    };
  });
  const mean = (nums: number[]) => (nums.length ? Math.round(nums.reduce((s, n) => s + n, 0) / nums.length) : 0);

  // Signal-driven trends (duplicate + confidence), scoped to this org.
  const projectIds = projects.map((p) => p.id);
  const signals = evidenceIntelRepo.listSignalsForProjects(projectIds, { limit: 2000 });
  const dupByWeek = new Map<string, number>();
  const confByWeek = new Map<string, { sum: number; n: number }>();
  const repeated = new Map<string, number>();
  for (const s of signals) {
    repeated.set(s.category, (repeated.get(s.category) ?? 0) + 1);
    const week = isoWeek(s.occurredAt);
    if (DUP_CATEGORIES.has(s.category)) dupByWeek.set(week, (dupByWeek.get(week) ?? 0) + 1);
    const c = confByWeek.get(week) ?? { sum: 0, n: 0 };
    c.sum += s.confidence;
    c.n += 1;
    confByWeek.set(week, c);
  }

  // Contractor evidence quality (advisory; never "fraudulent").
  const contractorAgg = new Map<string, { projects: number; qualitySum: number; findings: number }>();
  for (const p of perProject) {
    const agg = contractorAgg.get(p.contractor) ?? { projects: 0, qualitySum: 0, findings: 0 };
    agg.projects += 1;
    agg.qualitySum += p.quality;
    contractorAgg.set(p.contractor, agg);
  }
  for (const s of signals) {
    if (!s.projectId) continue;
    const contractor = projectContext(s.projectId).contractorName ?? "Unassigned";
    const agg = contractorAgg.get(contractor);
    if (agg) agg.findings += 1;
  }

  const queue = evidenceIntelRepo.reviewStatsForProjects(projectIds);

  return {
    advisoryNotice: ADVISORY_NOTICE,
    documentationCompleteness: perProject.map(({ contractor, ...rest }) => rest),
    averageCompleteness: mean(perProject.map((p) => p.completeness)),
    averageQuality: mean(perProject.map((p) => p.quality)),
    averageConfidence: mean(perProject.map((p) => p.confidence)),
    duplicateTrend: [...dupByWeek.entries()].map(([week, count]) => ({ week, count })).sort((a, b) => a.week.localeCompare(b.week)),
    confidenceTrend: [...confByWeek.entries()]
      .map(([week, v]) => ({ week, averageConfidence: Math.round((v.sum / v.n) * 100) }))
      .sort((a, b) => a.week.localeCompare(b.week)),
    contractorQuality: [...contractorAgg.entries()]
      .map(([contractor, agg]) => ({
        contractor,
        projects: agg.projects,
        averageQuality: Math.round(agg.qualitySum / agg.projects),
        advisoryFindings: agg.findings,
      }))
      .sort((a, b) => b.advisoryFindings - a.advisoryFindings),
    reviewerWorkload: { ...queue, total: queue.open + queue.acknowledged + queue.dismissed + queue.promoted },
    repeatedFindings: [...repeated.entries()]
      .map(([category, count]) => ({ category, count }))
      .filter((r) => r.count > 1)
      .sort((a, b) => b.count - a.count),
  };
}
