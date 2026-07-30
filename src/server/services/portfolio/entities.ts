/**
 * Entity intelligence: contractor, inspector, and vendor analytics.
 *
 * Identities are RESOLVED from existing verified records — organizations,
 * party assignments, loan assets, memberships, inspection records, and
 * draw-document metadata. Nothing here creates, replaces, or rewrites an
 * entity record: a contractor score is a read model over that
 * contractor's projects, recomputed on demand, stored nowhere.
 */
import type { DrawInspectionRow } from "../../db/portfolioRepo";
import {
  PortfolioContext,
  average,
  clampScore,
  daysBetween,
  monthKey,
  pct,
  projectFacets,
} from "./context";

// ------------------------------------------------------------ contractors

export interface ContractorScorecard {
  organizationId: string;
  name: string;
  kind: string;
  projects: { projectId: string; projectName: string; status: string }[];
  completedProjects: number;
  projectsInProgress: number;
  overallScore: number;
  qualityScore: number;
  documentationScore: number;
  schedulePerformance: number;
  budgetPerformance: number;
  inspectionSuccessRatePct: number | null;
  exceptionRatePerDraw: number | null;
  disputeRatePerDraw: number | null;
  permitCompliancePct: number | null;
  averageCostVariancePct: number | null;
  averageScheduleVarianceDays: number | null;
  averageDrawProcessingDays: number | null;
  historicalTrend: { month: string; exceptionsOpened: number; drawsSubmitted: number }[];
  topRisks: string[];
  topStrengths: string[];
}

export function contractorIntelligence(ctx: PortfolioContext): ContractorScorecard[] {
  // Contractor identity = every org referenced as a contractor by any
  // verified record within the accessible scope.
  const contractorProjects = new Map<string, Set<string>>();
  for (const project of ctx.projects) {
    for (const orgId of projectFacets(ctx, project.id).contractorOrgIds) {
      const set = contractorProjects.get(orgId) ?? new Set<string>();
      set.add(project.id);
      contractorProjects.set(orgId, set);
    }
  }
  return [...contractorProjects.entries()]
    .map(([orgId, projectIds]) => contractorScorecard(ctx, orgId, projectIds))
    .sort((a, b) => b.overallScore - a.overallScore);
}

export function contractorScorecard(
  ctx: PortfolioContext,
  organizationId: string,
  projectIds: Set<string>
): ContractorScorecard {
  const org = ctx.orgs().get(organizationId);
  const projects = [...projectIds]
    .map((id) => ctx.projectById.get(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  const completed = projects.filter((p) => p.status === "COMPLETED").length;
  const inProgress = projects.length - completed;

  // ---- verified quality: verification verdicts on their projects -------
  let verified = 0;
  let adverse = 0;
  for (const project of projects) {
    for (const m of ctx.milestonesByProject().get(project.id) ?? []) {
      const stats = ctx.verificationStatsByMilestone().get(m.id);
      if (!stats) continue;
      verified += stats.verified;
      adverse += stats.needsReview + stats.rejected;
    }
  }
  const qualityScore = verified + adverse > 0 ? clampScore(pct(verified, verified + adverse)) : 50;

  // ---- documentation: accepted vs rejected/expired docs + waivers ------
  let docsGood = 0;
  let docsBad = 0;
  let waiversAccepted = 0;
  let waiversAdverse = 0;
  const drawIds: string[] = [];
  const draws = projects.flatMap((p) => ctx.drawsByProject().get(p.id) ?? []);
  for (const draw of draws) {
    drawIds.push(draw.id);
    for (const doc of ctx.docsByDraw().get(draw.id) ?? []) {
      if (doc.status === "ACCEPTED") docsGood += 1;
      if (doc.status === "REJECTED" || doc.status === "EXPIRED") docsBad += 1;
    }
  }
  for (const project of projects) {
    for (const w of ctx.waiversByProject().get(project.id) ?? []) {
      if (w.status === "ACCEPTED") waiversAccepted += 1;
      if (["REJECTED", "EXPIRED", "REQUIRED", "REQUESTED"].includes(w.status)) waiversAdverse += 1;
    }
  }
  const docSignals = docsGood + docsBad + waiversAccepted + waiversAdverse;
  const documentationScore =
    docSignals > 0 ? clampScore(pct(docsGood + waiversAccepted, docSignals)) : 50;

  // ---- schedule: milestone slip on their projects ----------------------
  const now = ctx.generatedAt;
  const slipDays: number[] = [];
  for (const project of projects) {
    for (const m of (ctx.milestonesByProject().get(project.id) ?? []).filter((x) => !x.archived)) {
      if (!m.plannedEnd) continue;
      if (m.accountStatus === "RELEASED") continue;
      const slip = daysBetween(m.plannedEnd, now);
      if (slip !== null && slip > 0) slipDays.push(slip);
    }
  }
  const averageScheduleVarianceDays = slipDays.length > 0 ? Math.round(average(slipDays)!) : 0;
  const schedulePerformance = clampScore(100 - averageScheduleVarianceDays);

  // ---- budget: cost variance across their projects ---------------------
  const costVariances: number[] = [];
  for (const project of projects) {
    const lines = (ctx.budgetLinesByProject().get(project.id) ?? []).filter((l) => l.active);
    const original = lines.reduce((a, l) => a + l.originalBudget, 0);
    const revised = lines.reduce((a, l) => a + l.originalBudget + l.approvedChanges, 0);
    if (original > 0) costVariances.push(pct(revised - original, original));
  }
  const averageCostVariancePct =
    costVariances.length > 0 ? Math.round(average(costVariances)! * 10) / 10 : null;
  const budgetPerformance = clampScore(100 - Math.max(0, averageCostVariancePct ?? 0) * 2);

  // ---- inspections on their projects -----------------------------------
  let inspectionsPassed = 0;
  let inspectionsAdverse = 0;
  for (const project of projects) {
    for (const i of ctx.jurisdictionalInspectionsByProject().get(project.id) ?? []) {
      if (i.result === "PASSED") inspectionsPassed += 1;
      if (i.result === "FAILED" || i.result === "CORRECTIONS_REQUIRED") inspectionsAdverse += 1;
    }
    for (const r of ctx.lineRequirementsByProject().get(project.id) ?? []) {
      if (r.status === "PASSED") inspectionsPassed += 1;
      if (["FAILED", "CORRECTION_REQUIRED", "REINSPECTION_REQUIRED"].includes(r.status))
        inspectionsAdverse += 1;
    }
  }
  const inspectionSuccessRatePct =
    inspectionsPassed + inspectionsAdverse > 0
      ? Math.round(pct(inspectionsPassed, inspectionsPassed + inspectionsAdverse) * 10) / 10
      : null;

  // ---- exceptions / disputes per draw ----------------------------------
  const exceptions = projects.flatMap((p) => ctx.exceptionsByProject().get(p.id) ?? []);
  const disputes = projects.flatMap((p) => ctx.disputesByProject().get(p.id) ?? []);
  const exceptionRatePerDraw = draws.length > 0 ? Math.round((exceptions.length / draws.length) * 100) / 100 : null;
  const disputeRatePerDraw = draws.length > 0 ? Math.round((disputes.length / draws.length) * 100) / 100 : null;

  // ---- permits ----------------------------------------------------------
  let permitsGood = 0;
  let permitsBad = 0;
  for (const project of projects) {
    for (const p of ctx.permitsByProject().get(project.id) ?? []) {
      if (["ISSUED", "ACTIVE", "CLOSED"].includes(p.status)) permitsGood += 1;
      if (["EXPIRED", "REVOKED", "SUSPENDED", "UNKNOWN"].includes(p.status)) permitsBad += 1;
    }
  }
  const permitCompliancePct =
    permitsGood + permitsBad > 0 ? Math.round(pct(permitsGood, permitsGood + permitsBad) * 10) / 10 : null;

  // ---- draw processing time --------------------------------------------
  const processingDays: number[] = [];
  for (const draw of draws) {
    if (!draw.submittedAt) continue;
    for (const decision of ctx.decisionsByDraw().get(draw.id) ?? []) {
      if (decision.decisionAt && decision.decision !== "PENDING") {
        const days = daysBetween(draw.submittedAt, decision.decisionAt);
        if (days !== null && days >= 0) processingDays.push(days);
      }
    }
  }
  const averageDrawProcessingDays =
    processingDays.length > 0 ? Math.round(average(processingDays)! * 10) / 10 : null;

  // ---- trend ------------------------------------------------------------
  const trendBuckets = new Map<string, { exceptionsOpened: number; drawsSubmitted: number }>();
  for (const e of exceptions) {
    const month = monthKey(e.openedAt);
    if (!month) continue;
    const b = trendBuckets.get(month) ?? { exceptionsOpened: 0, drawsSubmitted: 0 };
    b.exceptionsOpened += 1;
    trendBuckets.set(month, b);
  }
  for (const d of draws) {
    const month = monthKey(d.submittedAt);
    if (!month) continue;
    const b = trendBuckets.get(month) ?? { exceptionsOpened: 0, drawsSubmitted: 0 };
    b.drawsSubmitted += 1;
    trendBuckets.set(month, b);
  }
  const historicalTrend = [...trendBuckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([month, v]) => ({ month, ...v }));

  const openExceptions = exceptions.filter((e) => !["RESOLVED", "CLOSED", "WAIVED"].includes(e.status));
  const topRisks: string[] = [];
  if (openExceptions.length > 0) topRisks.push(`${openExceptions.length} open exception(s) across their projects`);
  if (disputes.some((d) => !d.closedAt && !d.resolvedAt)) topRisks.push("Open dispute(s) on their projects");
  if ((averageCostVariancePct ?? 0) > 10) topRisks.push(`Average cost growth of ${averageCostVariancePct}%`);
  if (averageScheduleVarianceDays > 14) topRisks.push(`Average schedule slip of ${averageScheduleVarianceDays} days`);
  if (inspectionSuccessRatePct !== null && inspectionSuccessRatePct < 70)
    topRisks.push(`Inspection success rate ${inspectionSuccessRatePct}%`);

  const topStrengths: string[] = [];
  if (qualityScore >= 80) topStrengths.push("High verified-evidence quality");
  if (documentationScore >= 80) topStrengths.push("Strong documentation acceptance rate");
  if (inspectionSuccessRatePct !== null && inspectionSuccessRatePct >= 90)
    topStrengths.push("Consistently passing inspections");
  if ((averageCostVariancePct ?? 0) <= 0 && costVariances.length > 0)
    topStrengths.push("Delivering at or under original budget");
  if (averageScheduleVarianceDays === 0 && projects.length > 0) topStrengths.push("No schedule slip on active milestones");

  const overallScore = clampScore(
    qualityScore * 0.25 +
      documentationScore * 0.2 +
      schedulePerformance * 0.2 +
      budgetPerformance * 0.2 +
      (inspectionSuccessRatePct ?? 60) * 0.15
  );

  return {
    organizationId,
    name: org?.name ?? organizationId,
    kind: org?.kind ?? "UNKNOWN",
    projects: projects.map((p) => ({ projectId: p.id, projectName: p.name, status: p.status })),
    completedProjects: completed,
    projectsInProgress: inProgress,
    overallScore,
    qualityScore,
    documentationScore,
    schedulePerformance,
    budgetPerformance,
    inspectionSuccessRatePct,
    exceptionRatePerDraw,
    disputeRatePerDraw,
    permitCompliancePct,
    averageCostVariancePct,
    averageScheduleVarianceDays,
    averageDrawProcessingDays,
    historicalTrend,
    topRisks,
    topStrengths,
  };
}

// ------------------------------------------------------------- inspectors

export interface InspectorScorecard {
  key: string;
  name: string;
  source: "INDEPENDENT" | "GOVERNMENT_RECORD" | "DISPUTE";
  inspections: number;
  completedInspections: number;
  passRatePct: number | null;
  correctionRatePct: number | null;
  reinspectionCount: number;
  averageTurnaroundDays: number | null;
  averageResponseDays: number | null;
  turnaroundConsistencyDays: number | null;
  openWorkload: number;
  jurisdictions: string[];
  historicalMonthly: { month: string; completed: number }[];
}

export function inspectorIntelligence(ctx: PortfolioContext): InspectorScorecard[] {
  const cards: InspectorScorecard[] = [];

  // Independent (lender-ordered) draw inspectors.
  const independent = new Map<string, { name: string; rows: DrawInspectionRow[] }>();
  for (const list of ctx.drawInspectionsByProject().values()) {
    for (const i of list) {
      const key = i.inspectorUserId
        ? `user:${i.inspectorUserId}`
        : i.inspectorDisplayName
          ? `name:${i.inspectorDisplayName}`
          : i.companyOrganizationId
            ? `org:${i.companyOrganizationId}`
            : "unattributed";
      const name = i.inspectorUserId
        ? ctx.users().get(i.inspectorUserId)?.name ?? i.inspectorUserId
        : i.inspectorDisplayName ??
          (i.companyOrganizationId ? ctx.orgs().get(i.companyOrganizationId)?.name ?? i.companyOrganizationId : "Unattributed");
      const entry = independent.get(key) ?? { name, rows: [] };
      entry.rows.push(i);
      independent.set(key, entry);
    }
  }
  for (const [key, entry] of independent) {
    const rows = entry.rows;
    const completed = rows.filter((r) => r.completedAt);
    const adverse = rows.filter((r) =>
      ["FAILED", "CORRECTION_REQUIRED", "REINSPECTION_REQUIRED"].includes(r.status)
    );
    const accepted = rows.filter((r) => ["ACCEPTED", "FINALIZED"].includes(r.status));
    const turnarounds = rows
      .map((r) => daysBetween(r.requestedAt, r.completedAt))
      .filter((d): d is number => d !== null && d >= 0);
    const responses = rows
      .map((r) => daysBetween(r.requestedAt, r.scheduledAt))
      .filter((d): d is number => d !== null && d >= 0);
    cards.push({
      key,
      name: entry.name,
      source: "INDEPENDENT",
      inspections: rows.length,
      completedInspections: completed.length,
      passRatePct:
        accepted.length + adverse.length > 0
          ? Math.round(pct(accepted.length, accepted.length + adverse.length) * 10) / 10
          : null,
      correctionRatePct:
        completed.length > 0 ? Math.round(pct(adverse.length, completed.length) * 10) / 10 : null,
      reinspectionCount: rows.filter((r) => r.reinspectionOfInspectionId).length,
      averageTurnaroundDays: round1(average(turnarounds)),
      averageResponseDays: round1(average(responses)),
      turnaroundConsistencyDays: round1(stddev(turnarounds)),
      openWorkload: rows.length - completed.length,
      jurisdictions: [],
      historicalMonthly: monthly(completed.map((r) => r.completedAt!)),
    });
  }

  // Government inspection records (free-text inspector names; these are
  // records ABOUT government inspections, never OBV identities).
  const government = new Map<string, { rows: { status: string; result: string | null; scheduledAt: string | null; completedAt: string | null; jurisdiction: string | null; reinspectionOfInspectionId: string | null }[] }>();
  for (const list of ctx.jurisdictionalInspectionsByProject().values()) {
    for (const i of list) {
      const key = i.governmentInspectorName ?? "(not recorded)";
      const entry = government.get(key) ?? { rows: [] };
      entry.rows.push(i);
      government.set(key, entry);
    }
  }
  for (const [name, entry] of government) {
    const rows = entry.rows;
    const withResult = rows.filter((r) => r.result);
    const passed = withResult.filter((r) => r.result === "PASSED");
    const corrections = withResult.filter((r) => r.result === "CORRECTIONS_REQUIRED" || r.result === "FAILED");
    const turnarounds = rows
      .map((r) => daysBetween(r.scheduledAt, r.completedAt))
      .filter((d): d is number => d !== null && d >= 0);
    cards.push({
      key: `gov:${name}`,
      name,
      source: "GOVERNMENT_RECORD",
      inspections: rows.length,
      completedInspections: rows.filter((r) => r.completedAt).length,
      passRatePct:
        withResult.length > 0 ? Math.round(pct(passed.length, withResult.length) * 10) / 10 : null,
      correctionRatePct:
        withResult.length > 0 ? Math.round(pct(corrections.length, withResult.length) * 10) / 10 : null,
      reinspectionCount: rows.filter((r) => r.reinspectionOfInspectionId).length,
      averageTurnaroundDays: round1(average(turnarounds)),
      averageResponseDays: null,
      turnaroundConsistencyDays: round1(stddev(turnarounds)),
      openWorkload: rows.filter((r) => !r.completedAt && !["CANCELLED", "EXPIRED"].includes(r.status)).length,
      jurisdictions: [...new Set(rows.map((r) => r.jurisdiction).filter((j): j is string => Boolean(j)))],
      historicalMonthly: monthly(rows.filter((r) => r.completedAt).map((r) => r.completedAt!)),
    });
  }

  return cards.sort((a, b) => b.inspections - a.inspections);
}

// ---------------------------------------------------------------- vendors

export interface VendorScorecard {
  key: string;
  name: string;
  projects: string[];
  invoiceCount: number;
  invoiceTotal: number;
  invoiceAcceptedPct: number | null;
  invoiceRejectedCount: number;
  lienWaivers: { accepted: number; outstanding: number; rejected: number };
  averagePaymentDays: number | null;
  disputeTouchCount: number;
  documentationCompletenessPct: number | null;
  reliabilityScore: number;
  historicalMonthly: { month: string; invoices: number }[];
}

export function vendorIntelligence(ctx: PortfolioContext): VendorScorecard[] {
  interface VendorAgg {
    name: string;
    projects: Set<string>;
    invoices: { status: string; amount: number | null; receivedAt: string; drawId: string }[];
    docsTotal: number;
    docsAccepted: number;
  }
  const vendors = new Map<string, VendorAgg>();
  for (const [drawId, docs] of ctx.docsByDraw()) {
    const draw = ctx.drawById().get(drawId);
    if (!draw) continue;
    for (const doc of docs) {
      if (!doc.vendor) continue;
      const key = doc.vendor.trim().toLowerCase();
      const entry =
        vendors.get(key) ?? { name: doc.vendor.trim(), projects: new Set<string>(), invoices: [], docsTotal: 0, docsAccepted: 0 };
      entry.projects.add(draw.projectId);
      entry.docsTotal += 1;
      if (doc.status === "ACCEPTED") entry.docsAccepted += 1;
      if (["CONTRACTOR_INVOICE", "MATERIAL_INVOICE"].includes(doc.docType) || doc.invoiceNumber) {
        entry.invoices.push({ status: doc.status, amount: doc.amount, receivedAt: doc.receivedAt, drawId });
      }
      vendors.set(key, entry);
    }
  }

  // Lien-waiver posture by matching signing party / supplier org name.
  const waiverIndex = new Map<string, { accepted: number; outstanding: number; rejected: number }>();
  for (const list of ctx.waiversByProject().values()) {
    for (const w of list) {
      const names: string[] = [];
      if (w.signingParty) names.push(w.signingParty.trim().toLowerCase());
      if (w.supplierOrganizationId) {
        const org = ctx.orgs().get(w.supplierOrganizationId);
        if (org) names.push(org.name.trim().toLowerCase());
      }
      for (const name of names) {
        const entry = waiverIndex.get(name) ?? { accepted: 0, outstanding: 0, rejected: 0 };
        if (w.status === "ACCEPTED") entry.accepted += 1;
        else if (w.status === "REJECTED") entry.rejected += 1;
        else if (["REQUIRED", "REQUESTED", "RECEIVED", "UNDER_REVIEW"].includes(w.status)) entry.outstanding += 1;
        waiverIndex.set(name, entry);
      }
    }
  }

  const results: VendorScorecard[] = [];
  for (const [key, v] of vendors) {
    const accepted = v.invoices.filter((i) => i.status === "ACCEPTED").length;
    const rejected = v.invoices.filter((i) => i.status === "REJECTED" || i.status === "EXPIRED").length;
    const reviewed = accepted + rejected;

    // Payment timing: one sample per invoice — the EARLIEST settlement
    // event (settled payment instruction or recorded external funding)
    // on that invoice's draw at or after the invoice was received. One
    // sample per invoice keeps a draw with many settlement events from
    // multiplying into a cross-join of misleading averages.
    const paymentDays: number[] = [];
    for (const invoice of v.invoices) {
      const candidates: number[] = [];
      for (const instruction of ctx.instructionsByDraw().get(invoice.drawId) ?? []) {
        const days = daysBetween(invoice.receivedAt, instruction.settledAt);
        if (days !== null && days >= 0) candidates.push(days);
      }
      const draw = ctx.drawById().get(invoice.drawId);
      if (draw) {
        for (const funding of ctx.fundingByProject().get(draw.projectId) ?? []) {
          if (funding.drawRequestId !== invoice.drawId) continue;
          const days = daysBetween(invoice.receivedAt, funding.fundedAt);
          if (days !== null && days >= 0) candidates.push(days);
        }
      }
      if (candidates.length > 0) paymentDays.push(Math.min(...candidates));
    }

    const disputeTouches = new Set<string>();
    for (const invoice of v.invoices) {
      const draw = ctx.drawById().get(invoice.drawId);
      if (!draw) continue;
      for (const d of ctx.disputesByProject().get(draw.projectId) ?? []) {
        if (d.drawRequestId === invoice.drawId) disputeTouches.add(d.id);
      }
    }

    const waivers = waiverIndex.get(key) ?? { accepted: 0, outstanding: 0, rejected: 0 };
    const invoiceAcceptedPct = reviewed > 0 ? Math.round(pct(accepted, reviewed) * 10) / 10 : null;
    const documentationCompletenessPct =
      v.docsTotal > 0 ? Math.round(pct(v.docsAccepted, v.docsTotal) * 10) / 10 : null;
    const reliabilityScore = clampScore(
      (invoiceAcceptedPct ?? 50) * 0.4 +
        (documentationCompletenessPct ?? 50) * 0.3 +
        (waivers.accepted + waivers.rejected + waivers.outstanding > 0
          ? pct(waivers.accepted, waivers.accepted + waivers.rejected + waivers.outstanding)
          : 50) *
          0.2 +
        (disputeTouches.size === 0 ? 100 : Math.max(0, 100 - disputeTouches.size * 25)) * 0.1
    );

    results.push({
      key,
      name: v.name,
      projects: [...v.projects],
      invoiceCount: v.invoices.length,
      invoiceTotal: v.invoices.reduce((a, i) => a + (i.amount ?? 0), 0),
      invoiceAcceptedPct,
      invoiceRejectedCount: rejected,
      lienWaivers: waivers,
      averagePaymentDays: round1(average(paymentDays)),
      disputeTouchCount: disputeTouches.size,
      documentationCompletenessPct,
      reliabilityScore,
      historicalMonthly: monthly(v.invoices.map((i) => i.receivedAt)).map((m) => ({
        month: m.month,
        invoices: m.completed,
      })),
    });
  }
  return results.sort((a, b) => b.invoiceTotal - a.invoiceTotal);
}

// ----------------------------------------------------------------- utils

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = average(values)!;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function monthly(timestamps: string[]): { month: string; completed: number }[] {
  const buckets = new Map<string, number>();
  for (const t of timestamps) {
    const month = monthKey(t);
    if (month) buckets.set(month, (buckets.get(month) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([month, completed]) => ({ month, completed }));
}
