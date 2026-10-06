/**
 * OC4IDS mapping — the explicit, versioned translation from AUTHORITATIVE
 * OBV records into an OC4IDS project object.
 *
 * RULES (mapping version 1.0.0)
 *  - A field is populated ONLY from an authoritative OBV record, and every
 *    populated value carries its source (table, record id, field).
 *  - A field OBV cannot support is OMITTED with a stated reason. Nothing
 *    is inferred, defaulted or invented to make an export look complete.
 *  - OBV intelligence (verification, evidence integrity, review history,
 *    readiness, lender decisions, release controls, twin state) is NEVER
 *    placed in an OC4IDS field; the exclusion list is published with the
 *    mapping so a reader can see it is deliberate.
 *  - Output is deterministic: arrays are sorted on stable keys and the
 *    same records always produce the same object.
 *
 * Every rule below is a code-level statement a reviewer can check against
 * the OBV domain model; changing a rule bumps OC4IDS_MAPPING_VERSION.
 */
import * as repo from "../../../db/repo";
import * as lenderRepo from "../../../db/lenderRepo";
import type {
  ChangeOrder,
  InteropSourceRecordRef,
  Milestone,
  Organization,
  Project,
} from "../../../../shared/types";
import { OC4IDS_VERSION } from "./schema";
import { oc4idsPublisherConfig } from "../core";

export const OC4IDS_MAPPING_VERSION = "1.0.0";

export type OmissionReason =
  | "NOT_CONFIGURED"             // deployment-level publisher setting missing
  | "NO_AUTHORITATIVE_SOURCE"    // OBV holds no record that represents this field
  | "VALUE_ABSENT"               // the record exists but the value is empty
  | "NOT_REPRESENTABLE"          // OBV's value has no faithful OC4IDS encoding
  | "OBV_INTELLIGENCE_EXCLUDED"; // deliberately kept out of disclosure data

export interface MappedField {
  /** JSON pointer inside the project object. */
  path: string;
  value: unknown;
  source: { table: string; recordId: string; field: string; note?: string };
}

export interface OmittedField {
  path: string;
  reason: OmissionReason;
  detail: string;
}

export interface MappingResult {
  mappingVersion: string;
  schemaVersion: string;
  project: Record<string, unknown>;
  fields: MappedField[];
  omitted: OmittedField[];
  sourceRecords: InteropSourceRecordRef[];
  /** OBV concepts that are never exported as disclosure data. */
  excludedObvIntelligence: string[];
}

/** The deliberate exclusion list — OBV's verification model stays OBV's. */
export const EXCLUDED_OBV_INTELLIGENCE = [
  "Evidence Integrity Score",
  "Advisory signals and authenticity findings",
  "Duplicate detection",
  "OCR findings",
  "GPS consistency findings",
  "Official-source verification provenance",
  "Evidence and ledger hashes",
  "Reviewer history",
  "Draw readiness",
  "Lender decisions",
  "Release controls and payment authorization",
  "Digital Twin state",
] as const;

// ------------------------------------------------------------ code tables

/** OBV project lifecycle -> OC4IDS projectStatus (closed codelist). */
const STATUS_BY_OBV: Record<string, string | null> = {
  DRAFT: "preparation",       // configured, not launched: works have not begun
  ACTIVE: "implementation",   // launched: draws and verification under way
  COMPLETED: "completed",
  SUSPENDED: null,            // the standard has no suspended phase
};

/** OBV pilot category -> OC4IDS projectSector (open codelist). Only
 *  categories with an unambiguous sector are mapped. */
const SECTOR_BY_CATEGORY: Record<string, string | null> = {
  ROAD: "transport.road",
  BRIDGE: "transport",        // a bridge may carry road or rail: parent code only
  SCHOOL: "education",
  CLINIC: "health",
  WATER: "waterAndWaste",
  ENERGY: "energy",
  BUILDING: null,             // a building's sector is not stated by its category
  OTHER_INFRASTRUCTURE: null,
};

/** Public-sector organization kinds (OBV OrganizationKind). */
const PUBLIC_SECTOR_KINDS = new Set(["GOVERNMENT_AGENCY", "GOVERNMENT", "PROJECT_OWNER", "IMPLEMENTING_AGENCY"]);
/** Funding organization kinds. */
const FUNDER_KINDS = new Set(["LENDER", "FUNDER", "DEVELOPMENT_INSTITUTION", "DEVELOPMENT_FINANCE"]);

/** OBV change-order reason -> plain rationale text (verbatim category). */
const CO_REASON_LABEL: Record<string, string> = {
  OWNER_REQUEST: "Owner request",
  DESIGN_CHANGE: "Design change",
  SITE_CONDITION: "Site condition",
  MATERIAL_CHANGE: "Material change",
  SCOPE_CHANGE: "Scope change",
  REGULATORY: "Regulatory requirement",
  SCHEDULE: "Schedule",
  CORRECTION: "Correction",
  OTHER: "Other",
};

// ------------------------------------------------------------ helpers

/** Calendar dates are rendered at 00:00:00Z in the date-time format the
 *  schema requires; no time of day is asserted. Unparseable -> null. */
export function toDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00Z`;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const s = (value ?? "").trim();
  return s.length > 0 && s !== "—" ? s : null;
}

function closedRing(ring: Array<[number, number]>): boolean {
  if (ring.length < 4) return false;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly && ring.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

class Builder {
  readonly project: Record<string, unknown> = {};
  readonly fields: MappedField[] = [];
  readonly omitted: OmittedField[] = [];
  private readonly sources = new Map<string, InteropSourceRecordRef>();

  put(path: string, value: unknown, source: MappedField["source"]): void {
    if (value === null || value === undefined) return;
    setByPointer(this.project, path, value);
    this.fields.push({ path, value, source });
  }

  omit(path: string, reason: OmissionReason, detail: string): void {
    this.omitted.push({ path, reason, detail });
  }

  record(table: string, id: string, version: string | null = null): void {
    const key = `${table}:${id}`;
    if (!this.sources.has(key)) this.sources.set(key, { table, id, version });
  }

  sourceRecords(): InteropSourceRecordRef[] {
    return [...this.sources.values()].sort((a, b) =>
      a.table === b.table ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.table < b.table ? -1 : 1
    );
  }
}

/** Set a value at a JSON pointer, creating objects/arrays on the way. */
function setByPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = pointer.split("/").slice(1);
  let cur: unknown = root;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    const last = i === parts.length - 1;
    const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]);
    if (Array.isArray(cur)) {
      const idx = Number(key);
      if (last) cur[idx] = value;
      else {
        if (cur[idx] === undefined) cur[idx] = nextIsIndex ? [] : {};
        cur = cur[idx];
      }
    } else {
      const obj = cur as Record<string, unknown>;
      if (last) obj[key] = value;
      else {
        if (obj[key] === undefined) obj[key] = nextIsIndex ? [] : {};
        cur = obj[key];
      }
    }
  }
}

interface Party {
  org: Organization;
  roles: Set<string>;
  sources: Array<{ table: string; recordId: string; field: string; note?: string }>;
}

// ------------------------------------------------------------ mapping

/** Audit actions written by the interoperability module itself. */
export function isInteropAuditAction(action: string): boolean {
  return action.startsWith("OC4IDS_") || action.startsWith("FIELD_OBSERVATION");
}

export function mapProjectToOc4ids(project: Project): MappingResult {
  const b = new Builder();
  const cfg = oc4idsPublisherConfig();
  const pilot = project.pilot;
  b.record("projects", project.id, `configVersion:${pilot?.configVersion ?? 1}`);
  const src = (field: string, note?: string) => ({ table: "projects", recordId: project.id, field, note });

  // ---- id: registered prefix + OBV project id ----
  if (cfg.projectIdPrefix) {
    b.put("/id", `${cfg.projectIdPrefix}-${project.id}`, src("id", "prefixed with the deployment's registered OC4IDS prefix"));
  } else {
    b.omit("/id", "NOT_CONFIGURED", "OBV_OC4IDS_PROJECT_ID_PREFIX is not set; a project id requires the publisher's registered prefix");
  }

  // ---- title / description ----
  if (nonEmpty(project.name)) b.put("/title", project.name, src("name"));
  else b.omit("/title", "VALUE_ABSENT", "project name is empty");
  if (nonEmpty(project.description)) b.put("/description", project.description, src("description"));
  else b.omit("/description", "VALUE_ABSENT", "project description is empty");

  // ---- status ----
  const status = STATUS_BY_OBV[project.status] ?? null;
  if (status) b.put("/status", status, src("status", `OBV ${project.status} → OC4IDS ${status}`));
  else b.omit("/status", "NOT_REPRESENTABLE", `OBV status ${project.status} has no OC4IDS projectStatus code`);

  // ---- updated: the latest governed change recorded for the project ----
  // Interoperability's own audit rows (exports, observation imports and
  // decisions) are NOT changes to the project and never move "updated" —
  // otherwise publishing a disclosure would alter the next disclosure.
  const audit = repo.listConfigAudit(project.id, 500).find((a) => !isInteropAuditAction(a.action)) ?? null;
  const launched = toDateTime(pilot?.launchedAt ?? null);
  const auditAt = audit ? toDateTime(audit.createdAt) : null;
  if (auditAt && (!launched || auditAt >= launched)) {
    b.record("config_audit", audit!.id);
    b.put("/updated", auditAt, { table: "config_audit", recordId: audit!.id, field: "created_at", note: `latest audited change: ${audit!.action}` });
  } else if (launched) {
    b.put("/updated", launched, src("launched_at"));
  } else {
    b.omit("/updated", "VALUE_ABSENT", "no audited configuration change or launch timestamp is recorded for this project");
  }

  // ---- period ----
  const start = toDateTime(pilot?.plannedStart ?? null);
  const end = toDateTime(pilot?.plannedEnd ?? null);
  if (start) b.put("/period/startDate", start, src("planned_start", "calendar date rendered at 00:00:00Z"));
  else b.omit("/period/startDate", "VALUE_ABSENT", "no planned start date is recorded");
  if (end) b.put("/period/endDate", end, src("planned_end", "calendar date rendered at 00:00:00Z"));
  else b.omit("/period/endDate", "VALUE_ABSENT", "no planned end date is recorded");

  // ---- sector ----
  const sector = pilot?.category ? SECTOR_BY_CATEGORY[pilot.category] ?? null : null;
  if (sector) b.put("/sector/0", sector, src("category", `OBV category ${pilot!.category} → ${sector}`));
  else if (pilot?.category) b.omit("/sector", "NOT_REPRESENTABLE", `OBV category ${pilot.category} does not identify one OC4IDS sector`);
  else b.omit("/sector", "VALUE_ABSENT", "no project category is recorded");

  // ---- fields OBV holds no authoritative record for ----
  b.omit("/type", "NO_AUTHORITATIVE_SOURCE", "OBV does not record whether works create, expand or rehabilitate an asset");
  b.omit("/purpose", "NO_AUTHORITATIVE_SOURCE", "OBV records a description, not a separate statement of purpose");
  b.omit("/additionalClassifications", "NO_AUTHORITATIVE_SOURCE", "no classification scheme is recorded");
  b.omit("/completion", "NO_AUTHORITATIVE_SOURCE", "OBV records no final value, scope or completion date statement");
  b.omit("/relatedProjects", "NO_AUTHORITATIVE_SOURCE", "no related-project relationships are recorded");
  b.omit("/documents", "NOT_REPRESENTABLE", "OBV document records (pay applications, invoices, lien waivers, reports, audit packages) are tenant-gated financial-control artifacts, not public disclosure documents");
  b.omit("/budget/approvalDate", "NO_AUTHORITATIVE_SOURCE", "OBV does not record a budget approval date");

  // ---- locations ----
  let locIndex = 0;
  const locDescription = nonEmpty(project.location);
  const boundaryOk = Array.isArray(project.siteBoundary) && closedRing(project.siteBoundary);
  if (locDescription || boundaryOk || pilot?.country || pilot?.region || pilot?.locality) {
    const base = `/locations/${locIndex}`;
    b.put(`${base}/id`, "site", src("id", "local location identifier for the recorded site"));
    if (locDescription) b.put(`${base}/description`, locDescription, src("location"));
    if (boundaryOk) {
      b.put(`${base}/geometry/type`, "Polygon", src("site_boundary", "stored closed ring, [longitude, latitude] order"));
      b.put(`${base}/geometry/coordinates`, [project.siteBoundary.map((p) => [p[0], p[1]])], src("site_boundary"));
    } else if (Array.isArray(project.siteBoundary) && project.siteBoundary.length > 0) {
      b.omit(`${base}/geometry`, "NOT_REPRESENTABLE", "the stored site boundary is not a closed ring of at least four vertices");
    } else {
      b.omit(`${base}/geometry`, "VALUE_ABSENT", "no site boundary is recorded");
    }
    if (pilot?.locality) b.put(`${base}/address/locality`, pilot.locality, src("locality"));
    if (pilot?.region) b.put(`${base}/address/region`, pilot.region, src("region"));
    if (pilot?.country) b.put(`${base}/address/countryName`, pilot.country, src("country"));
    locIndex++;
  } else {
    b.omit("/locations", "VALUE_ABSENT", "no location text, boundary or address is recorded");
  }
  const route = repo.listSpatialFeatures(project.id).find((f) => f.kind === "ROUTE" && f.geometry.length >= 2);
  if (route) {
    const base = `/locations/${locIndex}`;
    b.record("spatial_features", route.id);
    const rs = (field: string, note?: string) => ({ table: "spatial_features", recordId: route.id, field, note });
    b.put(`${base}/id`, "route", rs("id", "local location identifier for the recorded corridor"));
    if (nonEmpty(route.label)) b.put(`${base}/description`, route.label, rs("label"));
    b.put(`${base}/geometry/type`, "LineString", rs("kind", "ROUTE polyline, [longitude, latitude] order"));
    b.put(`${base}/geometry/coordinates`, route.geometry.map((p) => [p[0], p[1]]), rs("geometry"));
    locIndex++;
  }

  // ---- budget ----
  if (project.totalBudget > 0) {
    b.put("/budget/amount/amount", project.totalBudget, src("total_budget", "whole currency units"));
    const owner = repo.getOrganization(project.organizationId);
    const currency = nonEmpty(pilot?.currency ?? null) ?? nonEmpty(owner?.profile?.currency ?? null);
    if (currency) {
      const fromProject = Boolean(nonEmpty(pilot?.currency ?? null));
      if (fromProject) b.put("/budget/amount/currency", currency.toUpperCase(), src("currency"));
      else {
        b.record("organizations", project.organizationId);
        b.put("/budget/amount/currency", currency.toUpperCase(), { table: "organizations", recordId: project.organizationId, field: "currency", note: "owning organization's reporting currency" });
      }
    } else {
      b.omit("/budget/amount/currency", "VALUE_ABSENT", "no currency is recorded on the project or its owning organization");
    }
  } else {
    b.omit("/budget", "VALUE_ABSENT", "no total budget is recorded (zero)");
  }

  // ---- parties ----
  const parties = new Map<string, Party>();
  const addParty = (orgId: string | null | undefined, role: string | null, source: Party["sources"][number], omitPath: string, omitDetail: string) => {
    if (!orgId) return;
    const org = repo.getOrganization(orgId);
    if (!org) {
      b.omit(omitPath, "VALUE_ABSENT", `${omitDetail}: organization ${orgId} is not recorded`);
      return;
    }
    if (!role) {
      b.omit(omitPath, "NOT_REPRESENTABLE", omitDetail);
      return;
    }
    const party = parties.get(org.id) ?? { org, roles: new Set<string>(), sources: [] };
    party.roles.add(role);
    party.sources.push(source);
    parties.set(org.id, party);
  };

  const owner = repo.getOrganization(project.organizationId);
  if (owner) {
    const role = PUBLIC_SECTOR_KINDS.has(owner.kind) ? "publicAuthority" : FUNDER_KINDS.has(owner.kind) ? "funder" : owner.kind === "CONTRACTOR" ? "supplier" : null;
    addParty(owner.id, role, src("organization_id", `owning organization (kind ${owner.kind})`), "/parties (owning organization)",
      `the owning organization's kind ${owner.kind} maps to no OC4IDS party role; the OBV tenant relationship itself is not disclosure data`);
  }
  addParty(pilot?.implementingOrgId, (() => {
    const o = pilot?.implementingOrgId ? repo.getOrganization(pilot.implementingOrgId) : null;
    return o && PUBLIC_SECTOR_KINDS.has(o.kind) ? "procuringEntity" : null;
  })(), src("implementing_org_id", "implementing agency"), "/parties (implementing organization)",
    "the implementing organization is not a public-sector kind, so it is not stated as the procuring entity");
  addParty(pilot?.contractorOrgId, "supplier", src("contractor_org_id"), "/parties (contractor)", "");
  addParty(pilot?.funderOrgId, "funder", src("funder_org_id"), "/parties (funder)", "");
  if (pilot?.engineerOrgId) {
    b.omit("/parties (supervising engineer)", "NOT_REPRESENTABLE", "the implemented party-role subset has no code for a supervising engineer");
  }
  for (const pa of lenderRepo.listPartyAssignments(project.id).filter((p) => p.active)) {
    const role = pa.partyType === "GOVERNMENT_AUTHORITY" ? "publicAuthority" : pa.partyType === "CONTRACTOR" ? "supplier" : pa.partyType === "LENDER" ? "funder" : null;
    if (!role) {
      b.omit(`/parties (party assignment ${pa.partyType})`, "NOT_REPRESENTABLE", `OBV party type ${pa.partyType} is a financial-control relationship with no OC4IDS disclosure role in the implemented subset`);
      continue;
    }
    b.record("project_party_assignments", pa.id);
    addParty(pa.partyOrganizationId, role, { table: "project_party_assignments", recordId: pa.id, field: "party_type", note: pa.partyType }, `/parties (party assignment ${pa.partyType})`, "");
  }
  const loan = lenderRepo.getLoanAssetForProject(project.id);
  if (loan) {
    b.record("loan_assets", loan.id, loan.updatedAt);
    addParty(loan.lenderOrganizationId, "funder", { table: "loan_assets", recordId: loan.id, field: "lender_organization_id" }, "/parties (loan lender)", "");
    addParty(loan.primaryContractorOrganizationId, "supplier", { table: "loan_assets", recordId: loan.id, field: "primary_contractor_organization_id" }, "/parties (loan contractor)", "");
  }
  const partyList = [...parties.values()].sort((a, c) => (a.org.id < c.org.id ? -1 : a.org.id > c.org.id ? 1 : 0));
  partyList.forEach((party, i) => {
    const base = `/parties/${i}`;
    b.record("organizations", party.org.id);
    const os = (field: string, note?: string) => ({ table: "organizations", recordId: party.org.id, field, note });
    b.put(`${base}/id`, party.org.id, os("id"));
    b.put(`${base}/name`, party.org.name, os("name"));
    const roles = [...party.roles].sort();
    roles.forEach((r, j) => b.put(`${base}/roles/${j}`, r, party.sources[Math.min(j, party.sources.length - 1)]));
    if (party.org.profile?.region) b.put(`${base}/address/region`, party.org.profile.region, os("region"));
    if (party.org.profile?.country) b.put(`${base}/address/countryName`, party.org.profile.country, os("country"));
  });
  if (partyList.length === 0) b.omit("/parties", "VALUE_ABSENT", "no organization with an OC4IDS party role is recorded for this project");

  const publicAuthority = partyList.find((p) => p.roles.has("publicAuthority"));
  if (publicAuthority) {
    b.put("/publicAuthority/id", publicAuthority.org.id, { table: "organizations", recordId: publicAuthority.org.id, field: "id", note: "party with the publicAuthority role" });
    b.put("/publicAuthority/name", publicAuthority.org.name, { table: "organizations", recordId: publicAuthority.org.id, field: "name" });
  } else {
    b.omit("/publicAuthority", "VALUE_ABSENT", "no public-sector organization is recorded as owner, implementing agency or government authority");
  }

  // ---- milestones ----
  const milestones = repo.listMilestones(project.id).filter((m) => !m.archived).sort((x, y) => x.seq - y.seq);
  if (milestones.length === 0) b.omit("/milestones", "VALUE_ABSENT", "no milestones are recorded");
  milestones.forEach((m, i) => mapMilestone(b, project, m, i));

  // ---- contracting process (works contract) ----
  const suppliers = partyList.filter((p) => p.roles.has("supplier"));
  if (suppliers.length > 0) {
    const base = "/contractingProcesses/0";
    const cpId = `${project.id}-works`;
    b.put(`${base}/id`, cpId, src("id", "local identifier derived from the project id for the single works contract OBV controls"));
    suppliers.forEach((s, i) => {
      b.put(`${base}/summary/suppliers/${i}/id`, s.org.id, { table: "organizations", recordId: s.org.id, field: "id", note: "contractor organization" });
      b.put(`${base}/summary/suppliers/${i}/name`, s.org.name, { table: "organizations", recordId: s.org.id, field: "name" });
    });
    b.omit(`${base}/summary/contractValue`, "NO_AUTHORITATIVE_SOURCE", "OBV records the OBV-controlled amount and milestone tranches, not the signed contract value");
    b.omit(`${base}/summary/contractPeriod`, "NO_AUTHORITATIVE_SOURCE", "OBV records no contract period");
    b.omit(`${base}/summary/status`, "NO_AUTHORITATIVE_SOURCE", "OBV records no contracting-process status");
    b.omit(`${base}/summary/nature`, "NO_AUTHORITATIVE_SOURCE", "OBV records no contract nature code");
    b.omit(`${base}/summary/tender`, "NO_AUTHORITATIVE_SOURCE", "OBV records no procurement method or tender data");
    b.omit(`${base}/summary/documents`, "NOT_REPRESENTABLE", "contract documents held by OBV are tenant-gated financial-control artifacts");
    const changeOrders = repo
      .listChangeOrdersForProject(project.id)
      .filter((co) => co.status === "APPROVED" || co.status === "PARTIALLY_APPROVED" || co.status === "IMPLEMENTED")
      .sort((x, y) => x.changeOrderNumber - y.changeOrderNumber);
    if (changeOrders.length === 0) {
      b.omit(`${base}/summary/modifications`, "VALUE_ABSENT", "no approved change orders are recorded");
    }
    changeOrders.forEach((co, i) => mapModification(b, co, `${base}/summary/modifications/${i}`));
  } else {
    b.omit("/contractingProcesses", "NO_AUTHORITATIVE_SOURCE", "no contractor organization is recorded, so OBV holds no works contract to disclose");
  }

  return {
    mappingVersion: OC4IDS_MAPPING_VERSION,
    schemaVersion: OC4IDS_VERSION,
    project: b.project,
    fields: b.fields,
    omitted: b.omitted,
    sourceRecords: b.sourceRecords(),
    excludedObvIntelligence: [...EXCLUDED_OBV_INTELLIGENCE],
  };
}

function mapMilestone(b: Builder, project: Project, m: Milestone, i: number): void {
  const base = `/milestones/${i}`;
  b.record("milestones", m.id);
  const ms = (field: string, note?: string) => ({ table: "milestones", recordId: m.id, field, note });
  b.put(`${base}/id`, m.id, ms("id"));
  b.put(`${base}/title`, m.title, ms("title"));
  if (nonEmpty(m.requirement)) b.put(`${base}/description`, m.requirement, ms("requirement", "the evidence requirement describes the milestone"));
  const due = toDateTime(m.plannedEnd ?? null);
  if (due) b.put(`${base}/dueDate`, due, ms("planned_end", "calendar date rendered at 00:00:00Z"));
  else b.omit(`${base}/dueDate`, "VALUE_ABSENT", `milestone ${m.seq} has no planned end date`);
  // Only a HUMAN governance approval states that a milestone was met.
  // VERIFIED (automated verdict awaiting approval) stays "scheduled".
  const met = m.status === "APPROVED" || m.status === "RELEASED";
  b.put(`${base}/status`, met ? "met" : "scheduled", ms("status", `OBV ${m.status} → ${met ? "met" : "scheduled"} (only governance approval counts as met)`));
  if (met) {
    const request = repo.getApprovalRequestForMilestone(m.id);
    const records = request ? repo.listApprovalRecordsForRequest(request.id).filter((r) => r.decision === "APPROVED") : [];
    const lastApproval = records.length ? records[records.length - 1] : null;
    if (lastApproval) {
      b.record("approval_records", lastApproval.id);
      b.put(`${base}/dateMet`, toDateTime(lastApproval.createdAt), { table: "approval_records", recordId: lastApproval.id, field: "created_at", note: "final governance approval" });
    } else {
      b.omit(`${base}/dateMet`, "VALUE_ABSENT", `milestone ${m.seq} is ${m.status} but no approval record timestamp is held (seeded or legacy state)`);
    }
  }
  void project;
}

function mapModification(b: Builder, co: ChangeOrder, base: string): void {
  b.record("change_orders", co.id, co.updatedAt);
  const cs = (field: string, note?: string) => ({ table: "change_orders", recordId: co.id, field, note });
  b.put(`${base}/id`, co.id, cs("id"));
  const effective = co.appliedAt ? toDateTime(co.appliedAt) : null;
  if (effective) b.put(`${base}/date`, effective, cs("applied_at", "when the approved change was applied"));
  else b.omit(`${base}/date`, "VALUE_ABSENT", `change order ${co.changeOrderNumber} is ${co.status} but not yet applied; no effective date is asserted`);
  b.put(`${base}/description`, co.description ? `${co.title} — ${co.description}` : co.title, cs("title"));
  b.put(`${base}/rationale`, CO_REASON_LABEL[co.reasonCategory] ?? co.reasonCategory, cs("reason_category"));
  const amount = co.approvedAmount ?? co.requestedAmount;
  const type = amount !== 0 ? "price" : co.scheduleImpactDays ? "duration" : "other";
  b.put(`${base}/type`, type, cs(amount !== 0 ? "approved_amount" : co.scheduleImpactDays ? "schedule_impact_days" : "status", `${type}: ${amount !== 0 ? "the change carries an amount" : co.scheduleImpactDays ? "the change carries a schedule impact" : "neither amount nor schedule impact is recorded"}`));
  b.omit(`${base}/newContractValue`, "NO_AUTHORITATIVE_SOURCE", "OBV records the change amount, not the resulting contract value");
}
