/**
 * Integration frameworks: e-signature and accounting.
 *
 * Both are PROVIDER-NEUTRAL. Adapters are looked up by name from small
 * registries; nothing anywhere in OBV contains DocuSign/Dropbox
 * Sign/Adobe/QuickBooks/Xero/Sage API logic — a future adapter
 * implements the same interface without touching this layer. The MOCK
 * e-sign adapter simulates the signature lifecycle for pilots; the CSV
 * accounting adapter is fully functional. Accounting IMPORTS land only
 * in a staging table: no adapter can create or modify verified records,
 * evidence, budgets, or banking state.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { User } from "../../../shared/types";
import { DATA_DIR, getDb } from "../../db/index";
import * as repo from "../../db/repo";
import * as lrepo from "../../db/lenderRepo";
import * as prepo from "../../db/pilotOpsRepo";
import * as authz from "../authz";
import { PilotOpsError, assertOrgAdmin, audit } from "./core";

// ================================================================ e-sign

export interface EsignProviderAdapter {
  name: string;
  /** Hand the request to the provider; returns the provider's reference. */
  send(request: prepo.EsignRequest): { providerReference: string };
}

/** Simulated provider for pilots: accepts everything, no network. */
const mockEsignAdapter: EsignProviderAdapter = {
  name: "MOCK",
  send: (request) => ({ providerReference: `mock-${request.id.slice(0, 8)}` }),
};

const ESIGN_ADAPTERS: Record<string, EsignProviderAdapter> = { MOCK: mockEsignAdapter };

/** Names surfaced as future-ready; only MOCK is installed. */
export const ESIGN_KNOWN_PROVIDERS = ["MOCK", "DOCUSIGN", "DROPBOX_SIGN", "ADOBE_SIGN"] as const;

const ESIGN_TRANSITIONS: Record<string, string[]> = {
  SENT: ["DRAFT"],
  VIEWED: ["SENT"],
  SIGNED: ["SENT", "VIEWED"],
  DECLINED: ["SENT", "VIEWED"],
  VOIDED: ["DRAFT", "SENT", "VIEWED"],
};

export function createSignatureRequest(
  user: User,
  input: { title: string; signerName: string; signerEmail: string; projectId?: string | null; documentPath?: string | null }
): prepo.EsignRequest {
  assertOrgAdmin(user);
  if (!input.title || !input.signerName || !input.signerEmail) {
    throw new PilotOpsError("Title, signer name and signer email are required", 400);
  }
  if (input.projectId) {
    // Same-404 through the central predicate.
    authz.requireProject(user, input.projectId);
  }
  let documentHash: string | null = null;
  if (input.documentPath) {
    const resolved = path.resolve(input.documentPath);
    if (!resolved.startsWith(path.resolve(DATA_DIR))) {
      throw new PilotOpsError("Document not found", 404);
    }
    if (!fs.existsSync(resolved)) throw new PilotOpsError("Document not found", 404);
    documentHash = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
  }
  const request = prepo.insertEsignRequest({
    id: prepo.newId(),
    organizationId: user.organizationId,
    projectId: input.projectId ?? null,
    provider: "MOCK",
    title: input.title,
    documentPath: input.documentPath ?? null,
    documentHash,
    signerName: input.signerName,
    signerEmail: input.signerEmail,
    requestedByUserId: user.id,
  });
  prepo.insertEsignEvent(request.id, "OBV", "CREATED", `Created by ${user.name}`);
  audit(user, "ESIGN_REQUEST_CREATED", "esign_request", request.id);
  return request;
}

function requireOrgEsignRequest(user: User, id: string): prepo.EsignRequest {
  const request = prepo.getEsignRequest(id);
  if (!request || request.organizationId !== user.organizationId) {
    throw new PilotOpsError("Signature request not found", 404);
  }
  return request;
}

export function sendSignatureRequest(user: User, id: string): prepo.EsignRequest {
  assertOrgAdmin(user);
  const request = requireOrgEsignRequest(user, id);
  const adapter = ESIGN_ADAPTERS[request.provider];
  if (!adapter) throw new PilotOpsError(`Provider ${request.provider} has no installed adapter`, 400);
  const { providerReference } = adapter.send(request);
  if (!prepo.transitionEsignStatus(id, ESIGN_TRANSITIONS.SENT, "SENT", { providerReference })) {
    throw new PilotOpsError(`Cannot send a request in status ${request.status}`, 409);
  }
  prepo.insertEsignEvent(id, "OBV", "SENT", `Sent via ${adapter.name} as ${providerReference}`);
  audit(user, "ESIGN_REQUEST_SENT", "esign_request", id);
  return prepo.getEsignRequest(id)!;
}

export function listSignatureRequests(user: User): prepo.EsignRequest[] {
  assertOrgAdmin(user);
  return prepo.listEsignRequests(user.organizationId);
}

export function signatureRequestDetail(
  user: User,
  id: string
): { request: prepo.EsignRequest; events: prepo.EsignEvent[] } {
  assertOrgAdmin(user);
  const request = requireOrgEsignRequest(user, id);
  return { request, events: prepo.listEsignEvents(id) };
}

/**
 * Provider webhook intake. The shared-secret token is compared against
 * OBV_ESIGN_WEBHOOK_TOKEN; with no token configured, webhooks are
 * refused entirely (nondisclosing 404 either way).
 */
export function handleEsignWebhook(
  providerName: string,
  token: string | null,
  payload: { reference?: string; event?: string; detail?: string }
): { requestId: string; status: string } {
  const configured = process.env.OBV_ESIGN_WEBHOOK_TOKEN ?? "";
  if (!configured || !token || token !== configured) {
    throw new PilotOpsError("Not found", 404);
  }
  const provider = providerName.toUpperCase();
  if (!(ESIGN_KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
    throw new PilotOpsError("Not found", 404);
  }
  const reference = payload.reference ?? "";
  const event = (payload.event ?? "").toUpperCase();
  if (!reference || !["VIEWED", "SIGNED", "DECLINED"].includes(event)) {
    throw new PilotOpsError("Unsupported webhook event", 400);
  }
  const request = findByReference(reference);
  if (!request || request.provider !== provider) {
    throw new PilotOpsError("Not found", 404);
  }
  const allowed = ESIGN_TRANSITIONS[event] ?? [];
  if (!prepo.transitionEsignStatus(request.id, allowed, event, {})) {
    // Out-of-order webhook: recorded but state unchanged.
    prepo.insertEsignEvent(request.id, "WEBHOOK", `IGNORED_${event}`, payload.detail ?? "Out-of-order provider event");
    return { requestId: request.id, status: prepo.getEsignRequest(request.id)!.status };
  }
  prepo.insertEsignEvent(request.id, "WEBHOOK", event, payload.detail ?? `Provider reported ${event}`);
  return { requestId: request.id, status: prepo.getEsignRequest(request.id)!.status };
}

function findByReference(reference: string): prepo.EsignRequest | null {
  const row = getDb()
    .prepare("SELECT id FROM esign_requests WHERE provider_reference = ?")
    .get(reference) as { id?: string } | undefined;
  return row?.id ? prepo.getEsignRequest(String(row.id)) : null;
}

// ============================================================ accounting

export const ACCOUNTING_PROVIDERS = ["QUICKBOOKS", "XERO", "SAGE", "CSV"] as const;
export type AccountingDataset = "PROJECTS" | "BUDGETS" | "INVOICES" | "PAYMENTS" | "CONTRACTORS";
export const ACCOUNTING_DATASETS: AccountingDataset[] = [
  "PROJECTS",
  "BUDGETS",
  "INVOICES",
  "PAYMENTS",
  "CONTRACTORS",
];

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const toCsv = (header: string[], rows: unknown[][]): string =>
  [header.join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\n") + "\n";

function datasetRows(user: User, dataset: AccountingDataset): { header: string[]; rows: unknown[][] } {
  const projects = authz.accessibleProjects(user);
  switch (dataset) {
    case "PROJECTS":
      return {
        header: ["project_id", "name", "status", "total_budget", "currency"],
        rows: projects.map((p) => [p.id, p.name, p.status, p.totalBudget, p.pilot?.currency ?? "USD"]),
      };
    case "BUDGETS": {
      const rows: unknown[][] = [];
      for (const project of projects) {
        for (const line of repo.listBudgetLines(project.id)) {
          rows.push([
            project.id,
            line.code,
            line.category,
            line.originalBudget,
            line.approvedChanges,
            line.paidToDate,
          ]);
        }
      }
      return { header: ["project_id", "code", "category", "original_budget", "approved_changes", "paid_to_date"], rows };
    }
    case "INVOICES": {
      const rows: unknown[][] = [];
      for (const project of projects) {
        for (const draw of repo.listDrawRequestsForProject(project.id)) {
          for (const doc of repo.listDrawDocuments(draw.id)) {
            if (!doc.invoiceNumber && !doc.vendor) continue;
            rows.push([project.id, draw.id, doc.vendor ?? "", doc.invoiceNumber ?? "", doc.amount ?? "", doc.status]);
          }
        }
      }
      return { header: ["project_id", "draw_id", "vendor", "invoice_number", "amount", "status"], rows };
    }
    case "PAYMENTS": {
      const rows: unknown[][] = [];
      for (const project of projects) {
        for (const funding of lrepo.listFundingRecordsForProject(project.id)) {
          rows.push([
            project.id,
            funding.drawRequestId,
            funding.status,
            funding.amountDisbursed ?? funding.amountScheduled ?? "",
            funding.fundedAt ?? funding.scheduledAt ?? "",
          ]);
        }
      }
      return { header: ["project_id", "draw_id", "status", "amount", "at"], rows };
    }
    case "CONTRACTORS": {
      const seen = new Map<string, unknown[]>();
      for (const project of projects) {
        for (const party of lrepo.listPartyAssignments(project.id)) {
          if (party.partyType !== "CONTRACTOR" || !party.active) continue;
          const org = repo.getOrganization(party.partyOrganizationId);
          if (org) seen.set(org.id, [org.id, org.name, org.kind]);
        }
      }
      return { header: ["organization_id", "name", "kind"], rows: [...seen.values()] };
    }
  }
}

export function listConnections(user: User): prepo.AccountingConnection[] {
  assertOrgAdmin(user);
  for (const provider of ACCOUNTING_PROVIDERS) {
    prepo.upsertAccountingConnection(user.organizationId, provider);
  }
  return prepo.listAccountingConnections(user.organizationId);
}

export function exportDataset(
  user: User,
  provider: string,
  dataset: AccountingDataset
): { run: prepo.AccountingRun; filePath: string } {
  assertOrgAdmin(user);
  if (!(ACCOUNTING_PROVIDERS as readonly string[]).includes(provider)) {
    throw new PilotOpsError("Unknown accounting provider", 400);
  }
  if (!ACCOUNTING_DATASETS.includes(dataset)) {
    throw new PilotOpsError("Unknown dataset", 400);
  }
  const connection = prepo.upsertAccountingConnection(user.organizationId, provider);
  const { header, rows } = datasetRows(user, dataset);
  const dir = path.join(DATA_DIR, "accounting");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(
    dir,
    `${provider.toLowerCase()}-${dataset.toLowerCase()}-${Date.now()}.csv`
  );
  fs.writeFileSync(filePath, toCsv(header, rows), "utf8");
  const run = prepo.insertAccountingRun({
    id: prepo.newId(),
    connectionId: connection.id,
    direction: "EXPORT",
    dataset,
    rowCount: rows.length,
    filePath,
    status: "COMPLETED",
    detail: `Normalized ${dataset.toLowerCase()} export (${provider})`,
    createdBy: user.id,
  });
  audit(user, "ACCOUNTING_EXPORT", "accounting_run", run.id, { after: `${dataset}:${rows.length} rows` });
  return { run, filePath };
}

/** CSV import: rows are parsed and STAGED only — never applied to any
 *  governed table. Review/apply is a human workflow through the existing
 *  governed mutation paths. */
export function importCsv(
  user: User,
  dataset: AccountingDataset,
  csvText: string
): prepo.AccountingRun {
  assertOrgAdmin(user);
  if (!ACCOUNTING_DATASETS.includes(dataset)) throw new PilotOpsError("Unknown dataset", 400);
  if (csvText.length > 512 * 1024) throw new PilotOpsError("Import too large", 413);
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new PilotOpsError("CSV needs a header row and at least one data row", 400);
  const header = lines[0].split(",").map((cell) => cell.trim());
  const connection = prepo.upsertAccountingConnection(user.organizationId, "CSV");
  const run = prepo.insertAccountingRun({
    id: prepo.newId(),
    connectionId: connection.id,
    direction: "IMPORT",
    dataset,
    rowCount: lines.length - 1,
    filePath: null,
    status: "COMPLETED",
    detail: "Rows staged for human review — imports never modify verified records",
    createdBy: user.id,
  });
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const payload: Record<string, unknown> = {};
    header.forEach((column, index) => {
      payload[column || `col_${index}`] = (cells[index] ?? "").trim();
    });
    prepo.insertImportRow(run.id, dataset, payload);
  }
  audit(user, "ACCOUNTING_IMPORT_STAGED", "accounting_run", run.id, {
    after: `${dataset}:${lines.length - 1} rows staged`,
  });
  return run;
}

export function listRuns(user: User): prepo.AccountingRun[] {
  assertOrgAdmin(user);
  const connections = prepo.listAccountingConnections(user.organizationId);
  return prepo.listAccountingRuns(connections.map((connection) => connection.id));
}
