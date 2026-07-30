/**
 * Fraud Intelligence — anomaly detection over verified records.
 *
 * Every detector is deterministic pattern-matching on stored data and
 * produces ADVISORY FLAGS ONLY. A flag never changes any record, never
 * opens an exception, never blocks a draw, and never accuses anyone: it
 * marks a pattern a human investigator should look at. False positives
 * are expected and acceptable; silent false negatives are not a promise
 * this module can make either — it sees only what was recorded.
 */
import { PortfolioContext, daysBetween, projectFacets } from "./context";

export type FraudSeverity = "LOW" | "MEDIUM" | "HIGH";

export interface FraudSignal {
  code: string;
  severity: FraudSeverity;
  projectId: string | null;
  entity: string | null;
  label: string;
  detail: string;
}

export const FRAUD_ADVISORY =
  "Advisory anomaly flags derived from verified records. These are patterns for human review — " +
  "not findings, not accusations, and never a basis for automated action.";

function signal(
  code: string,
  severity: FraudSeverity,
  projectId: string | null,
  entity: string | null,
  label: string,
  detail: string
): FraudSignal {
  return { code, severity, projectId, entity, label, detail };
}

/** All portfolio-wide signals for the viewer's accessible scope. */
export function fraudSignals(ctx: PortfolioContext): FraudSignal[] {
  const signals: FraudSignal[] = [];

  // -- duplicate invoice numbers (same vendor+number on multiple documents,
  //    or the same number reused across vendors) -------------------------
  const invoices: { projectId: string; vendor: string; number: string; amount: number | null; docId: string }[] = [];
  for (const [drawId, docs] of ctx.docsByDraw()) {
    const draw = ctx.drawById().get(drawId);
    if (!draw) continue;
    for (const doc of docs) {
      if (!doc.invoiceNumber) continue;
      invoices.push({
        projectId: draw.projectId,
        vendor: (doc.vendor ?? "").trim().toLowerCase(),
        number: doc.invoiceNumber.trim().toLowerCase(),
        amount: doc.amount,
        docId: doc.id,
      });
    }
  }
  const byVendorNumber = new Map<string, typeof invoices>();
  const byNumber = new Map<string, typeof invoices>();
  for (const inv of invoices) {
    const vk = `${inv.vendor}::${inv.number}`;
    byVendorNumber.set(vk, [...(byVendorNumber.get(vk) ?? []), inv]);
    byNumber.set(inv.number, [...(byNumber.get(inv.number) ?? []), inv]);
  }
  for (const [key, group] of byVendorNumber) {
    if (group.length > 1) {
      signals.push(
        signal(
          "DUPLICATE_INVOICE",
          "HIGH",
          group[0].projectId,
          group[0].vendor || null,
          `Invoice number submitted ${group.length} times`,
          `Invoice "${key.split("::")[1]}" appears on ${group.length} draw documents for the same vendor.`
        )
      );
    }
  }
  for (const [number, group] of byNumber) {
    const vendors = new Set(group.map((g) => g.vendor).filter((v) => v.length > 0));
    if (vendors.size > 1) {
      signals.push(
        signal(
          "INVOICE_NUMBER_CROSS_VENDOR",
          "MEDIUM",
          group[0].projectId,
          null,
          `Invoice number shared by ${vendors.size} vendors`,
          `Invoice number "${number}" was submitted by ${vendors.size} different vendors.`
        )
      );
    }
  }

  // -- duplicate evidence content hashes --------------------------------
  for (const dup of ctx.duplicateEvidence()) {
    const milestoneIds = dup.milestoneIds.split(",");
    const acrossMilestones = new Set(milestoneIds).size > 1;
    signals.push(
      signal(
        acrossMilestones ? "DUPLICATE_EVIDENCE_CROSS_MILESTONE" : "DUPLICATE_EVIDENCE",
        acrossMilestones ? "HIGH" : "MEDIUM",
        null,
        null,
        acrossMilestones
          ? "Identical evidence content submitted for different milestones"
          : "Identical evidence content submitted more than once",
        `Evidence hash ${dup.hash.slice(0, 12)}… appears ${dup.count} times.`
      )
    );
  }

  // -- rapid budget changes ---------------------------------------------
  for (const project of ctx.projects) {
    const cos = (ctx.changeOrdersByProject().get(project.id) ?? []).filter((c) =>
      ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "IMPLEMENTED"].includes(c.status)
    );
    const windows = new Map<string, number>();
    for (const co of cos) {
      const month = (co.requestedAt ?? co.createdAt).slice(0, 7);
      windows.set(month, (windows.get(month) ?? 0) + 1);
    }
    for (const [month, count] of windows) {
      if (count >= 3) {
        signals.push(
          signal(
            "RAPID_BUDGET_CHANGES",
            "MEDIUM",
            project.id,
            null,
            `${count} change orders raised in one month`,
            `${count} change orders were raised on ${project.name} in ${month}.`
          )
        );
      }
    }
    const original = project.totalBudget;
    const approvedCoTotal = cos
      .filter((c) => ["APPROVED", "IMPLEMENTED"].includes(c.status))
      .reduce((a, c) => a + (c.approvedAmount ?? 0), 0);
    if (original > 0 && approvedCoTotal > original * 0.25) {
      signals.push(
        signal(
          "BUDGET_GROWTH_OUTSIZED",
          "HIGH",
          project.id,
          null,
          "Approved change orders exceed 25% of original budget",
          `Approved change-order value on ${project.name} is ${Math.round((approvedCoTotal / original) * 100)}% of the original budget.`
        )
      );
    }
  }

  // -- repeated contractor issues across projects ------------------------
  const contractorIssueProjects = new Map<string, Set<string>>();
  for (const project of ctx.projects) {
    const facets = projectFacets(ctx, project.id);
    const open = (ctx.exceptionsByProject().get(project.id) ?? []).filter(
      (e) => !["RESOLVED", "CLOSED", "WAIVED"].includes(e.status)
    );
    const openDisputes = (ctx.disputesByProject().get(project.id) ?? []).filter((d) => !d.closedAt);
    if (open.length === 0 && openDisputes.length === 0) continue;
    for (const contractorOrgId of facets.contractorOrgIds) {
      const set = contractorIssueProjects.get(contractorOrgId) ?? new Set<string>();
      set.add(project.id);
      contractorIssueProjects.set(contractorOrgId, set);
    }
  }
  for (const [orgId, projectSet] of contractorIssueProjects) {
    if (projectSet.size >= 2) {
      const org = ctx.orgs().get(orgId);
      signals.push(
        signal(
          "CONTRACTOR_REPEAT_ISSUES",
          "MEDIUM",
          null,
          org?.name ?? orgId,
          `Contractor has open issues on ${projectSet.size} projects`,
          `${org?.name ?? orgId} has open exceptions or disputes on ${projectSet.size} projects in this portfolio.`
        )
      );
    }
  }

  // -- suspicious inspection patterns ------------------------------------
  const byInspector = new Map<string, { completed: number; passed: number; sameDayCorrections: number }>();
  for (const list of ctx.jurisdictionalInspectionsByProject().values()) {
    for (const insp of list) {
      const key = insp.governmentInspectorName ?? "(unnamed)";
      const entry = byInspector.get(key) ?? { completed: 0, passed: 0, sameDayCorrections: 0 };
      if (insp.result) {
        entry.completed += 1;
        if (insp.result === "PASSED") entry.passed += 1;
      }
      if (insp.correctionDueAt && insp.correctionClearedAt) {
        const days = daysBetween(insp.correctionDueAt, insp.correctionClearedAt);
        if (days !== null && Math.abs(days) < 1) entry.sameDayCorrections += 1;
      }
      byInspector.set(key, entry);
    }
  }
  for (const [name, entry] of byInspector) {
    if (entry.completed >= 5 && entry.passed === entry.completed) {
      signals.push(
        signal(
          "INSPECTOR_UNIFORM_PASSES",
          "LOW",
          null,
          name,
          `Inspector recorded ${entry.completed} inspections, all passed`,
          `Government inspector "${name}" has a 100% pass rate across ${entry.completed} recorded inspections. This may be entirely legitimate.`
        )
      );
    }
    if (entry.sameDayCorrections >= 2) {
      signals.push(
        signal(
          "CORRECTIONS_CLEARED_SAME_DAY",
          "MEDIUM",
          null,
          name,
          "Corrections repeatedly cleared on their due day",
          `${entry.sameDayCorrections} correction notices recorded by "${name}" were cleared on the exact due date.`
        )
      );
    }
  }

  // -- schedule anomalies -------------------------------------------------
  for (const project of ctx.projects) {
    const milestones = ctx.milestonesByProject().get(project.id) ?? [];
    const evidenceStats = ctx.evidenceStatsByMilestone();
    for (const m of milestones) {
      if (m.accountStatus === "RELEASED" && (evidenceStats.get(m.id)?.total ?? 0) === 0) {
        signals.push(
          signal(
            "RELEASE_WITHOUT_EVIDENCE",
            "HIGH",
            project.id,
            null,
            "Milestone released with no evidence on file",
            `Milestone "${m.title}" on ${project.name} is RELEASED but has no evidence items.`
          )
        );
      }
    }
  }

  // -- cost anomalies ------------------------------------------------------
  for (const project of ctx.projects) {
    for (const line of ctx.budgetLinesByProject().get(project.id) ?? []) {
      const revised = line.originalBudget + line.approvedChanges;
      if (revised > 0 && line.paidToDate > revised) {
        signals.push(
          signal(
            "PAID_OVER_BUDGET_LINE",
            "HIGH",
            project.id,
            null,
            `Budget line ${line.code} paid beyond its revised budget`,
            `Line ${line.code} on ${project.name} shows paid-to-date above its revised budget.`
          )
        );
      }
    }
    // Round-number concentration on submitted invoices (weak signal).
    const amounts: number[] = [];
    for (const draw of ctx.drawsByProject().get(project.id) ?? []) {
      for (const doc of ctx.docsByDraw().get(draw.id) ?? []) {
        if (doc.amount !== null && doc.amount > 0) amounts.push(doc.amount);
      }
    }
    if (amounts.length >= 5) {
      const round = amounts.filter((a) => a % 10_000 === 0).length;
      if (round / amounts.length >= 0.9) {
        signals.push(
          signal(
            "ROUND_NUMBER_INVOICES",
            "LOW",
            project.id,
            null,
            "Invoice amounts are overwhelmingly round numbers",
            `${round} of ${amounts.length} invoice amounts on ${project.name} are exact multiples of $10,000.`
          )
        );
      }
    }
  }

  // -- verification-quality clustering ------------------------------------
  for (const project of ctx.projects) {
    const milestones = ctx.milestonesByProject().get(project.id) ?? [];
    const stats = milestones
      .map((m) => ctx.verificationStatsByMilestone().get(m.id))
      .filter((v): v is NonNullable<typeof v> => Boolean(v));
    const rejected = stats.reduce((a, v) => a + v.rejected, 0);
    const total = stats.reduce((a, v) => a + v.verified + v.needsReview + v.rejected, 0);
    if (total >= 5 && rejected / total > 0.4) {
      signals.push(
        signal(
          "EVIDENCE_REJECTION_CLUSTER",
          "MEDIUM",
          project.id,
          null,
          "High share of rejected evidence",
          `${rejected} of ${total} verifications on ${project.name} were rejected.`
        )
      );
    }
  }

  return signals;
}

/** Signals attributable to one project (portfolio-level signals excluded). */
export function fraudSignalsForProject(ctx: PortfolioContext, projectId: string): FraudSignal[] {
  return fraudSignals(ctx).filter((s) => s.projectId === projectId);
}

export interface FraudIntelligence {
  generatedAt: string;
  advisory: string;
  signalCount: number;
  bySeverity: Record<FraudSeverity, number>;
  signals: FraudSignal[];
  /** Projects where ≥3 risk dimensions are elevated cluster here (filled by facade). */
  riskClusters: { projectId: string; projectName: string; elevatedDimensions: string[] }[];
}

export function fraudIntelligence(ctx: PortfolioContext): Omit<FraudIntelligence, "riskClusters"> {
  const signals = fraudSignals(ctx);
  const bySeverity: Record<FraudSeverity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  for (const s of signals) bySeverity[s.severity] += 1;
  return {
    generatedAt: ctx.generatedAt,
    advisory: FRAUD_ADVISORY,
    signalCount: signals.length,
    bySeverity,
    signals: signals.sort((a, b) => {
      const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return rank[a.severity] - rank[b.severity];
    }),
  };
}
