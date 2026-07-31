/**
 * Demo data generator — realistic, CLEARLY-MARKED demonstration records
 * for pilot walkthroughs. Internal-operator + demo-banking-mode gated.
 *
 * Every generated name carries the "DEMO — " prefix and generated ids
 * carry the "demo-gen-" prefix, so demo records are unmistakable in
 * every register and trivially queryable. The generator writes
 * administrative/financial demonstration records only: it NEVER creates
 * evidence items, ledger entries, verifications, approvals, banking
 * rows, or packages — those exist only through the governed pipelines.
 * Portfolio trends, forecasts, risk, fraud examples and executive
 * reports then derive automatically from the generated records.
 */
import type { User } from "../../../shared/types";
import { getDb } from "../../db/index";
import { isDemoBankingMode } from "../banking/registry";
import { PilotOpsError, assertInternalOperator, audit } from "./core";

const P = "demo-gen";
const nowIso = (): string => new Date().toISOString();
const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString();
const dateOnly = (offset: number): string => day(offset).slice(0, 10);

export interface DemoGenerationSummary {
  organizationId: string;
  contractorOrganizationId: string;
  projects: string[];
  milestones: number;
  budgetLines: number;
  permits: number;
  draws: number;
  invoices: number;
  inspections: number;
  exceptions: number;
  disputes: number;
  costEstimates: number;
  note: string;
}

export function demoDataExists(): boolean {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c FROM organizations WHERE id LIKE ?")
    .get(`${P}-%`) as { c?: number };
  return Number(row?.c ?? 0) > 0;
}

export function generateDemoData(user: User): DemoGenerationSummary {
  assertInternalOperator(user);
  if (!isDemoBankingMode()) {
    throw new PilotOpsError("The demo generator is available only in demo banking mode", 403);
  }
  if (demoDataExists()) {
    throw new PilotOpsError("Demo data has already been generated in this database", 409);
  }
  const db = getDb();
  const ts = nowIso();
  const run = (sql: string, ...args: unknown[]): void => {
    db.prepare(sql).run(...(args as never[]));
  };

  // Organizations: the invoker's org hosts the projects (so their own
  // dashboards light up); one demo contractor org is created.
  const orgId = user.organizationId;
  const contractorOrg = `${P}-contractor`;
  run(
    "INSERT INTO organizations (id, name, kind) VALUES (?, ?, 'CONTRACTOR')",
    contractorOrg,
    "DEMO — Beacon Ridge Builders LLC"
  );

  const projects: { id: string; name: string; budget: number }[] = [
    { id: `${P}-proj-a`, name: "DEMO — 1804 Concordia Ave Fix-and-Flip", budget: 640_000 },
    { id: `${P}-proj-b`, name: "DEMO — Fairlane Court Townhome Rehab", budget: 910_000 },
  ];
  let milestones = 0;
  let budgetLines = 0;
  let permits = 0;
  let draws = 0;
  let invoices = 0;
  let inspections = 0;
  let exceptions = 0;
  let disputes = 0;
  let costEstimates = 0;

  for (const [pi, project] of projects.entries()) {
    run(
      `INSERT INTO projects (id, organization_id, name, description, location, site_boundary,
         total_budget, status, project_type, planned_start, planned_end, contractor_org_id)
       VALUES (?, ?, ?, ?, ?, '[]', ?, 'ACTIVE', 'INFRASTRUCTURE', ?, ?, ?)`,
      project.id,
      orgId,
      project.name,
      "Clearly-marked demonstration project generated for pilot walkthroughs.",
      "DEMO — Fictional Address",
      project.budget,
      dateOnly(-120),
      dateOnly(60 + pi * 30),
      contractorOrg
    );
    const phases = ["Foundation & structure", "Rough-in trades", "Finishes & closeout"];
    for (const [mi, title] of phases.entries()) {
      milestones += 1;
      run(
        `INSERT INTO milestones (id, project_id, seq, title, requirement, tranche_amount, status,
           account_status, planned_start, planned_end, weight)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'HELD', ?, ?, ?)`,
        `${P}-ms-${pi}-${mi}`,
        project.id,
        mi + 1,
        `DEMO — ${title}`,
        "Demonstration milestone",
        Math.round(project.budget / 3 / 1000) * 1000,
        mi === 0 ? "UNDER_REVIEW" : "NOT_STARTED",
        dateOnly(-100 + mi * 40),
        // First project's last phase is deliberately overdue → schedule risk.
        dateOnly(pi === 0 && mi === 2 ? -10 : 30 + mi * 30),
        [30, 40, 30][mi]
      );
    }
    const lines = [
      ["01-000", "General requirements", 0.15],
      ["03-300", "Concrete", 0.25],
      ["06-100", "Rough carpentry", 0.35],
      ["09-900", "Finishes", 0.25],
    ] as const;
    for (const [code, category, share] of lines) {
      budgetLines += 1;
      run(
        `INSERT INTO budget_lines (id, project_id, code, category, description, original_budget,
           approved_changes, paid_to_date, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'DEMO line', ?, 0, ?, 1, ?, ?)`,
        `${P}-bl-${pi}-${code}`,
        project.id,
        code,
        category,
        Math.round((project.budget * share) / 1000) * 1000,
        pi === 0 && code === "03-300" ? Math.round(project.budget * 0.1) : 0,
        ts,
        ts
      );
    }
    const permitRows: [string, string, string][] = [
      [`${P}-permit-${pi}-bldg`, "BUILDING", "ISSUED"],
      // First project carries an expired permit → permit-issue example.
      [`${P}-permit-${pi}-elec`, "ELECTRICAL", pi === 0 ? "EXPIRED" : "ISSUED"],
    ];
    for (const [id, type, status] of permitRows) {
      permits += 1;
      run(
        `INSERT INTO permits (id, organization_id, project_id, permit_number, permit_type, status,
           jurisdiction, issuing_authority, issued_at, expires_at, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'DEMO County', 'DEMO Building Department', ?, ?, ?, ?, ?)`,
        id,
        orgId,
        project.id,
        `DEMO-${type.slice(0, 4)}-${pi + 1}00`,
        type,
        status,
        dateOnly(-90),
        dateOnly(status === "EXPIRED" ? -5 : 275),
        user.id,
        ts,
        ts
      );
    }

    // One draw under review with three lines and vendor invoices — the
    // first project includes a duplicate invoice number (fraud example).
    draws += 1;
    const drawId = `${P}-draw-${pi}`;
    run(
      `INSERT INTO draw_requests (id, organization_id, project_id, draw_number, requested_by_user_id,
         requested_by_organization_id, submitted_at, requested_amount, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'UNDER_REVIEW', ?, ?)`,
      drawId,
      orgId,
      project.id,
      user.id,
      contractorOrg,
      day(-9),
      Math.round(project.budget * 0.18),
      ts,
      ts
    );
    const lineSpecs: [string, number, string][] = [
      ["Concrete placement", 0.08, "SUPPORTED"],
      ["Framing package", 0.06, "PARTIALLY_SUPPORTED"],
      ["Site logistics", 0.04, "PENDING"],
    ];
    for (const [li, [description, share, status]] of lineSpecs.entries()) {
      run(
        `INSERT INTO draw_line_items (id, draw_request_id, sort, budget_line_id, description,
           current_requested, percent_complete_claimed, percent_complete_verified, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `${P}-dline-${pi}-${li}`,
        drawId,
        li,
        lines[Math.min(li + 1, 3)][0],
        `DEMO — ${description}`,
        Math.round(project.budget * share),
        60,
        45,
        status
      );
    }
    const invoiceSpecs: [string, string, number, string][] = [
      ["DEMO Concrete Supply Co", `INV-${pi + 1}001`, 42_000, "ACCEPTED"],
      ["DEMO Lumber & Truss", `INV-${pi + 1}002`, 28_000, "RECEIVED"],
      // Duplicate number on the first project only.
      ["DEMO Concrete Supply Co", pi === 0 ? "INV-1001" : `INV-${pi + 1}003`, 42_000, "RECEIVED"],
    ];
    for (const [ii, [vendor, number, amount, status]] of invoiceSpecs.entries()) {
      invoices += 1;
      run(
        `INSERT INTO draw_documents (id, draw_request_id, doc_type, title, status, received_at,
           vendor, invoice_number, amount)
         VALUES (?, ?, 'MATERIAL_INVOICE', ?, ?, ?, ?, ?, ?)`,
        `${P}-ddoc-${pi}-${ii}`,
        drawId,
        `DEMO invoice ${number}`,
        status,
        day(-8 + ii),
        vendor,
        number,
        amount
      );
    }

    // Government inspection records (free-text inspector).
    for (const [gi, [status, result]] of (
      [
        ["PASSED", "PASSED"],
        ["CORRECTIONS_REQUIRED", "CORRECTIONS_REQUIRED"],
      ] as [string, string][]
    ).entries()) {
      inspections += 1;
      run(
        `INSERT INTO jurisdictional_inspections (id, organization_id, project_id, milestone_id, required,
           status, scheduled_at, completed_at, result, government_inspector_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'DEMO Inspector A. Morgan', ?, ?)`,
        `${P}-ji-${pi}-${gi}`,
        orgId,
        project.id,
        `${P}-ms-${pi}-0`,
        status,
        day(-6),
        day(-5),
        result,
        ts,
        ts
      );
    }

    exceptions += 1;
    run(
      `INSERT INTO exceptions (id, organization_id, project_id, source_type, source_id, source_key,
         category, severity, status, title, opened_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'MANUAL', ?, ?, 'DOCUMENT', 'HIGH', 'OPEN', ?, ?, ?, ?, ?)`,
      `${P}-exc-${pi}`,
      orgId,
      project.id,
      `${P}-manual-${pi}`,
      `${P}-exc-key-${pi}`,
      "DEMO — Missing conditional lien waiver",
      day(-4),
      user.id,
      ts,
      ts
    );
    costEstimates += 1;
    run(
      `INSERT INTO cost_to_complete_estimates (id, organization_id, project_id, budget_line_id,
         estimated_cost_to_complete, source_of_estimate, estimator_user_id, estimate_date, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, 'DEMO walkthrough estimate', ?, ?, 'MEDIUM', ?)`,
      `${P}-ctc-${pi}`,
      orgId,
      project.id,
      `${P}-bl-${pi}-03-300`,
      Math.round(project.budget * 0.4),
      user.id,
      dateOnly(-3),
      ts
    );
  }

  // One open dispute with a legal-hold example on the first project.
  disputes += 1;
  run(
    `INSERT INTO disputes (id, organization_id, project_id, subject_type, subject_id, draw_request_id,
       disputed_amount, affected_scope, reason, status, opened_by_user_id, opened_by_organization_id,
       opened_at, legal_hold, legal_hold_at, legal_hold_reason, created_at, updated_at)
     VALUES (?, ?, ?, 'DRAW', ?, ?, 18000, 'LINE', 'DEMO — Contractor disputes framing reduction',
       'OPEN', ?, ?, ?, 1, ?, 'DEMO — counsel review', ?, ?)`,
    `${P}-disp-0`,
    orgId,
    projects[0].id,
    `${P}-draw-0`,
    `${P}-draw-0`,
    user.id,
    orgId,
    day(-3),
    day(-2),
    ts,
    ts
  );
  run(
    `INSERT INTO project_party_assignments (id, organization_id, project_id, party_organization_id,
       party_type, active, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, 'CONTRACTOR', 1, ?, ?)`,
    `${P}-ppa-0`,
    orgId,
    projects[0].id,
    contractorOrg,
    user.id,
    ts
  );

  audit(user, "DEMO_DATA_GENERATED", "demo_generation", `${P}:${projects.length} projects`);
  return {
    organizationId: orgId,
    contractorOrganizationId: contractorOrg,
    projects: projects.map((project) => project.id),
    milestones,
    budgetLines,
    permits,
    draws,
    invoices,
    inspections,
    exceptions,
    disputes,
    costEstimates,
    note:
      "All records carry the DEMO prefix. Portfolio trends, risk, forecasts, fraud signals and " +
      "executive reports derive automatically. Evidence, approvals, banking and packages are never " +
      "generated — those exist only through the governed pipelines.",
  };
}
