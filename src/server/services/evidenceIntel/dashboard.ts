/**
 * Evidence Intelligence dashboard aggregation — configured analysis
 * providers, signal + queue counts, recent activity, and provider
 * health. Every aggregate is tenant-scoped to the caller's organization;
 * no secret or credential appears in any view model.
 */
import * as evidenceIntelRepo from "../../db/evidenceIntelRepo";
import type { EvidenceSignal, EvidenceSignalSeverity, User } from "../../../shared/types";
import * as authz from "../authz";
import { ADVISORY_NOTICE, assertViewer, ocrProviderName } from "./core";
import { OCR_PROVIDER_CATALOG } from "./ocr";
import { futureAiReadiness } from "./futureAi";

export interface EvidenceIntelDashboard {
  advisoryNotice: string;
  providers: Array<{ category: string; name: string; status: string; detail: string }>;
  signals: { total: number; bySeverity: Record<EvidenceSignalSeverity, number>; byCategory: Array<{ category: string; count: number }> };
  queue: { open: number; acknowledged: number; dismissed: number; promoted: number };
  recentSignals: EvidenceSignal[];
  recentRuns: ReturnType<typeof evidenceIntelRepo.listAnalysisRunsForOrgs>;
  futureAi: ReturnType<typeof futureAiReadiness>;
}

export function evidenceIntelDashboard(user: User): EvidenceIntelDashboard {
  assertViewer(user);
  const projectIds = [...authz.accessibleProjectIds(user)];
  const signals = evidenceIntelRepo.listSignalsForProjects(projectIds, { limit: 1000 });
  const bySeverity: Record<EvidenceSignalSeverity, number> = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0 };
  const byCategoryMap = new Map<string, number>();
  for (const s of signals) {
    bySeverity[s.severity] += 1;
    byCategoryMap.set(s.category, (byCategoryMap.get(s.category) ?? 0) + 1);
  }
  const byCategory = [...byCategoryMap.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  const activeOcr = ocrProviderName();
  const providers = [
    {
      category: "OCR",
      name: OCR_PROVIDER_CATALOG.find((p) => p.name === activeOcr)?.displayName ?? activeOcr,
      status: activeOcr === "mock" ? "ACTIVE" : "DISABLED_BOUNDARY",
      detail:
        activeOcr === "mock"
          ? "Deterministic mock OCR derives fields from recorded document metadata."
          : "Adapter present; refuses every call until production credentials exist.",
    },
    ...futureAiReadiness().catalog.map((e) => ({
      category: "FUTURE_AI",
      name: e.displayName,
      status: "DISABLED_BOUNDARY",
      detail: e.purpose,
    })),
  ];

  return {
    advisoryNotice: ADVISORY_NOTICE,
    providers,
    signals: { total: signals.length, bySeverity, byCategory },
    queue: evidenceIntelRepo.reviewStatsForProjects(projectIds),
    recentSignals: signals.slice(0, 20),
    recentRuns: evidenceIntelRepo.listAnalysisRunsForOrgs([user.organizationId], 10),
    futureAi: futureAiReadiness(),
  };
}
