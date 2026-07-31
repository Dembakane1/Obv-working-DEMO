/**
 * Accounting platform: provider-neutral, EXPORT-ONLY synchronization.
 *
 * OBV is the system of record; accounting mirrors it. The active provider
 * is CSV (deterministic files any accounting package imports). QuickBooks
 * Online, Xero, and Sage are DISABLED BOUNDARIES for later. There is no
 * import path at all, so accounting can never modify verified evidence —
 * or anything else.
 *
 * Entity mapping (all read-only SELECTs over existing records):
 *   PROJECT     projects the caller can see
 *   BUDGET_LINE active budget lines of those projects
 *   CONTRACTOR  contractor organizations those projects reference
 *   INVOICE     draw requests (the construction-lending invoice analogue)
 *   PAYMENT     RELEASED account events (governed releases)
 */
import { randomUUID } from "node:crypto";
import * as integrationsRepo from "../../db/integrationsRepo";
import * as repo from "../../db/repo";
import * as authz from "../authz";
import type { AccountingSyncRun, User } from "../../../shared/types";
import {
  IntegrationError,
  assertIntegrationManager,
  assertIntegrationViewer,
  integrationsConfig,
  nowIso,
  recordIntegration,
} from "./core";

export interface AccountingProvider {
  name: string;
  displayName: string;
  active: boolean;
  /** Future remote push — disabled boundaries throw. */
  pushRemote(entityType: string, rows: Array<Record<string, string>>): void;
}

function disabledAccountingProvider(name: string, displayName: string): AccountingProvider {
  return {
    name,
    displayName,
    active: false,
    pushRemote: () => {
      throw new IntegrationError(
        `The ${displayName} accounting adapter is a disabled boundary in this build.`,
        503
      );
    },
  };
}

export const ACCOUNTING_PROVIDER_CATALOG: AccountingProvider[] = [
  { name: "csv", displayName: "CSV Export", active: true, pushRemote: () => {} },
  disabledAccountingProvider("quickbooks", "QuickBooks Online"),
  disabledAccountingProvider("xero", "Xero"),
  disabledAccountingProvider("sage", "Sage"),
];

export function resolveAccountingProvider(): AccountingProvider {
  const cfg = integrationsConfig();
  return ACCOUNTING_PROVIDER_CATALOG.find((p) => p.name === cfg.accountingProvider)!;
}

// ------------------------------------------------------------- projection

function csvCell(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header: string[], rows: Array<Record<string, string>>): string {
  return [
    header.join(","),
    ...rows.map((r) => header.map((h) => csvCell(r[h])).join(",")),
  ].join("\n") + "\n";
}

export interface AccountingProjection {
  projects: Array<Record<string, string>>;
  budgets: Array<Record<string, string>>;
  contractors: Array<Record<string, string>>;
  invoices: Array<Record<string, string>>;
  payments: Array<Record<string, string>>;
}

/** Build the export projection from records the caller may see. Pure
 *  reads — this function performs no writes of any kind. */
export function buildProjection(actor: User): AccountingProjection {
  const projects = authz.accessibleProjects(actor);
  const projection: AccountingProjection = {
    projects: [],
    budgets: [],
    contractors: [],
    invoices: [],
    payments: [],
  };
  const contractorIds = new Set<string>();
  for (const project of projects) {
    projection.projects.push({
      id: project.id,
      name: project.name,
      status: project.status,
      total_budget: String(project.totalBudget),
      currency: project.pilot?.currency ?? "USD",
      location: project.location,
    });
    if (project.pilot?.contractorOrgId) contractorIds.add(project.pilot.contractorOrgId);
    for (const line of repo.listBudgetLines(project.id)) {
      if (!line.active) continue;
      projection.budgets.push({
        id: line.id,
        project_id: project.id,
        code: line.code,
        category: line.category,
        description: line.description,
        current_budget: String(line.currentBudget),
        paid_to_date: String(line.paidToDate),
        currency: line.currency,
      });
    }
    for (const draw of repo.listDrawRequestsForProject(project.id)) {
      projection.invoices.push({
        id: draw.id,
        project_id: project.id,
        number: `DRAW-${draw.drawNumber}`,
        status: draw.status,
        requested_amount: String(draw.requestedAmount),
        approved_amount: draw.approvedAmount !== null ? String(draw.approvedAmount) : "",
        currency: draw.currency,
        submitted_at: draw.submittedAt ?? "",
      });
    }
    for (const event of repo.listAccountEventsForProject(project.id)) {
      if (event.type !== "RELEASED") continue;
      projection.payments.push({
        id: event.id,
        project_id: project.id,
        amount: String(event.amount),
        occurred_at: event.createdAt,
        reference: event.milestoneId ?? "",
      });
    }
  }
  for (const orgId of contractorIds) {
    const org = repo.getOrganization(orgId);
    if (org) projection.contractors.push({ id: org.id, name: org.name, kind: org.kind });
  }
  return projection;
}

const ENTITY_FILES: Array<{ entityType: "PROJECT" | "BUDGET_LINE" | "CONTRACTOR" | "INVOICE" | "PAYMENT"; key: keyof AccountingProjection; filename: string }> = [
  { entityType: "PROJECT", key: "projects", filename: "projects.csv" },
  { entityType: "BUDGET_LINE", key: "budgets", filename: "budgets.csv" },
  { entityType: "CONTRACTOR", key: "contractors", filename: "contractors.csv" },
  { entityType: "INVOICE", key: "invoices", filename: "invoices.csv" },
  { entityType: "PAYMENT", key: "payments", filename: "payments.csv" },
];

export interface AccountingExportResult {
  run: AccountingSyncRun;
  files: Array<{ filename: string; entityType: string; rows: number; csv: string }>;
}

/** Run one export synchronization: project the records, emit CSV text,
 *  record links + the audited run. Nothing outside the integrations
 *  tables is written. */
export function runExport(actor: User): AccountingExportResult {
  assertIntegrationManager(actor);
  const provider = resolveAccountingProvider();
  const run: AccountingSyncRun = {
    id: randomUUID(),
    provider: provider.name,
    organizationId: actor.organizationId,
    direction: "EXPORT",
    status: "RUNNING",
    entityCounts: null,
    error: null,
    startedBy: actor.id,
    startedAt: nowIso(),
    finishedAt: null,
  };
  integrationsRepo.insertSyncRun(run);
  try {
    const projection = buildProjection(actor);
    const files: AccountingExportResult["files"] = [];
    const counts: Record<string, number> = {};
    for (const spec of ENTITY_FILES) {
      const rows = projection[spec.key];
      const header = rows.length > 0 ? Object.keys(rows[0]) : ["id"];
      provider.pushRemote(spec.entityType, rows); // csv: no-op; boundaries throw
      files.push({ filename: spec.filename, entityType: spec.entityType, rows: rows.length, csv: toCsv(header, rows) });
      counts[spec.key as string] = rows.length;
      for (const row of rows) {
        integrationsRepo.upsertAccountingLink({
          id: randomUUID(),
          provider: provider.name,
          entityType: spec.entityType,
          entityId: row.id,
          externalRef: `${provider.name}:${spec.filename}#${row.id}`,
          organizationId: actor.organizationId,
          syncRunId: run.id,
          syncedAt: nowIso(),
        });
      }
    }
    integrationsRepo.finishSyncRun(run.id, "SUCCEEDED", counts, null);
    recordIntegration({
      category: "ACCOUNTING",
      provider: provider.name,
      operation: "EXPORT_SYNC",
      outcome: "SUCCESS",
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      subjectType: "accounting_sync_run",
      subjectId: run.id,
      detail: JSON.stringify(counts),
    });
    return { run: { ...run, status: "SUCCEEDED", entityCounts: counts, finishedAt: nowIso() }, files };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    integrationsRepo.finishSyncRun(run.id, "FAILED", null, detail.slice(0, 500));
    recordIntegration({
      category: "ACCOUNTING",
      provider: provider.name,
      operation: "EXPORT_SYNC",
      outcome: "FAILURE",
      actorUserId: actor.id,
      organizationId: actor.organizationId,
      subjectType: "accounting_sync_run",
      subjectId: run.id,
      detail: detail.slice(0, 500),
    });
    throw err;
  }
}

export function listSyncRuns(actor: User): AccountingSyncRun[] {
  assertIntegrationViewer(actor);
  return integrationsRepo.listSyncRunsForOrgs([actor.organizationId]);
}

export function listLinks(actor: User) {
  assertIntegrationViewer(actor);
  return integrationsRepo.listAccountingLinksForOrgs([actor.organizationId]);
}
