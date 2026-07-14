/**
 * Pilot Readiness & Customer Onboarding views.
 *
 * Institutional project setup — controlled configuration, readiness
 * review, governance setup. No gamification. Launch is configuration
 * activation, never proof of work.
 */
import { h, Fragment, renderDocument, VNode } from "./jsx";
import {
  AppShell,
  EmptyState,
  NavContext,
  OperationalStatus,
  PageHeader,
  fmtDate,
  money,
  STYLESHEET_HREF,
} from "./components";
import { brandMark, icons } from "./icons";
import type {
  ApprovalPolicy,
  ConfigAuditEntry,
  ConfigSnapshot,
  EvidenceRequirement,
  FieldAssignment,
  Invitation,
  Milestone,
  Organization,
  Project,
  ReadinessCheck,
  SpatialFeature,
  User,
  VerificationPolicyConfig,
} from "../../shared/types";
import type { SetupStage, DrawReconciliation } from "../services/pilot/onboarding";
import type { ProjectTemplate } from "../services/pilot/templates";

const ORG_KIND_OPTIONS = [
  "LENDER", "FUNDER", "GOVERNMENT_AGENCY", "DEVELOPMENT_INSTITUTION",
  "PROJECT_OWNER", "IMPLEMENTING_AGENCY", "CONTRACTOR", "CONSULTANT", "OTHER",
];
const PROJECT_CATEGORY_OPTIONS = [
  "ROAD", "BUILDING", "SCHOOL", "CLINIC", "WATER", "ENERGY", "BRIDGE", "OTHER_INFRASTRUCTURE",
];
const REQUIREMENT_TYPE_OPTIONS = [
  "PHOTO", "VIDEO", "DOCUMENT", "LOCATION_CONFIRMATION", "FIELD_FORM",
  "INSPECTION", "CERTIFICATE", "TEST_RESULT", "OTHER",
];

function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const INV_TONE: Record<string, string> = {
  PENDING: "warn", ACCEPTED: "ok", REVOKED: "neutral", EXPIRED: "neutral",
};

// ================================================================ setup home

export function renderPilotSetup(input: {
  nav: NavContext;
  orgs: Organization[];
  invitations: Array<{ invitation: Invitation; org: Organization | null; acceptedUser: User | null }>;
  projects: Array<{ project: Project; stages: SetupStage[] }>;
  users: Map<string, User>;
  canAdmin: boolean;
  /** One-time activation link surfaced after creating/resending (mock
   *  delivery — no real email is sent in the pilot demo build). */
  issuedInvite: { email: string; link: string } | null;
  error: string | null;
}): string {
  return renderDocument(
    <AppShell title="Pilot Setup" nav={input.nav} context="Pilot Setup">
      <PageHeader
        title="Pilot Setup"
        sub="Guided onboarding: organization, team, project configuration, readiness review, launch. Configuration defines the rules — evidence, verification, and formal approvals remain the only path to release."
      >
        <a className="btn ghost" href="/pilot">Pilot Operations →</a>
      </PageHeader>

      {input.error ? <div className="banner warn" style="margin-bottom:12px">{input.error}</div> : null}
      {input.issuedInvite ? (
        <div className="banner ok" style="margin-bottom:12px">
          Invitation issued for <b>{input.issuedInvite.email}</b>. Activation link (shown once —
          demo build uses safe preview delivery, no real email was sent):
          <code style="display:block;margin-top:6px;word-break:break-all;user-select:all">{input.issuedInvite.link}</code>
        </div>
      ) : null}

      {/* ---- pilot projects ---- */}
      <div className="panel">
        <div className="panel-head">
          <h3>Pilot projects</h3>
          <span className="right">{input.projects.length} project(s)</span>
        </div>
        {input.projects.length === 0 ? (
          <p className="sub" style="padding:14px 16px">
            No pilot projects yet. Create one below — the seeded R47 demo project stays separate.
          </p>
        ) : (
          input.projects.map(({ project, stages }, i) => {
            const done = stages.filter((s) => s.complete).length;
            return (
              <div className="setup-proj" style={i > 0 ? "border-top:1px solid var(--line)" : ""}>
                <span className="sp-id">
                  <a href={`/setup/project/${project.id}`} style="font-weight:650;color:var(--action)">
                    {project.name}
                  </a>
                  <span className={`sync-tag ${project.status === "DRAFT" ? "warn" : "ok"}`}>{project.status}</span>
                  <span className="s">
                    {project.pilot?.code ? `${project.pilot.code} · ` : ""}
                    {project.pilot?.category ? kindLabel(project.pilot.category) : "Uncategorized"}
                    {project.pilot?.currency
                      ? ` · ${project.pilot.currency} ${(project.pilot.obvControlledAmount ?? project.totalBudget).toLocaleString("en-US")}`
                      : ""}
                  </span>
                </span>
                <span className="sp-progress">
                  <span className="s">PILOT SETUP · {done} of {stages.length} stages complete</span>
                  <span className="sp-bar"><i style={`width:${Math.round((done / stages.length) * 100)}%`}></i></span>
                </span>
                <a className="btn sm ghost" href={`/setup/project/${project.id}`}>
                  {project.status === "DRAFT" ? "Continue Setup" : "View Configuration"}
                </a>
              </div>
            );
          })
        )}
        {input.canAdmin ? (
          <form method="POST" action="/api/pilot/projects" className="fo-form" style="padding:14px 16px;border-top:1px solid var(--line)">
            <div className="fo-row">
              <label style="flex:2">Project name
                <input name="name" required maxlength="160" placeholder="e.g. K14 Regional Road Rehabilitation" />
              </label>
              <label>Project code
                <input name="code" maxlength="60" placeholder="e.g. K14-2026" />
              </label>
              <label>Project type
                <select name="category">
                  {PROJECT_CATEGORY_OPTIONS.map((c) => <option value={c}>{kindLabel(c)}</option>)}
                </select>
              </label>
            </div>
            <div className="fo-row">
              <label>Primary organization
                <select name="organizationId" required>
                  {input.orgs.map((o) => <option value={o.id}>{o.name}</option>)}
                </select>
              </label>
              <label>OBV-controlled amount
                <input name="obvControlledAmount" type="number" min="0" placeholder="1000000" />
              </label>
              <label>Currency
                <input name="currency" maxlength="6" value="USD" />
              </label>
            </div>
            <button className="btn" type="submit" style="align-self:flex-start">Create Draft Project</button>
          </form>
        ) : null}
      </div>

      {/* ---- organizations ---- */}
      <div className="panel" style="margin-top:12px">
        <div className="panel-head">
          <h3>Organizations</h3>
          <span className="right">Primary and counterparties</span>
        </div>
        <div className="intg-table-wrap">
          <table className="intg-table">
            <thead><tr><th>Organization</th><th>Type</th><th>Country</th><th>Currency</th><th>Timezone</th></tr></thead>
            <tbody>
              {input.orgs.map((o) => (
                <tr>
                  <td data-l="Organization" style="font-weight:600">{o.name}</td>
                  <td data-l="Type">{kindLabel(o.kind)}</td>
                  <td data-l="Country">{o.profile?.country ?? "—"}</td>
                  <td data-l="Currency">{o.profile?.currency ?? "—"}</td>
                  <td data-l="Timezone">{o.profile?.timezone ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {input.canAdmin ? (
          <form method="POST" action="/api/pilot/orgs" className="fo-form" style="padding:14px 16px;border-top:1px solid var(--line)">
            <div className="fo-row">
              <label style="flex:2">Organization name
                <input name="name" required maxlength="200" placeholder="e.g. Horizon Infrastructure Fund" />
              </label>
              <label>Type
                <select name="kind">
                  {ORG_KIND_OPTIONS.map((k) => <option value={k}>{kindLabel(k)}</option>)}
                </select>
              </label>
            </div>
            <div className="fo-row">
              <label>Country<input name="country" maxlength="100" /></label>
              <label>Timezone<input name="timezone" maxlength="60" placeholder="Africa/Blantyre" /></label>
              <label>Reporting currency<input name="currency" maxlength="6" placeholder="USD" /></label>
              <label>Primary contact<input name="primaryContact" maxlength="200" placeholder="name@example.org" /></label>
            </div>
            <button className="btn secondary sm" type="submit" style="align-self:flex-start">Add Organization</button>
          </form>
        ) : null}
      </div>

      {/* ---- team / invitations ---- */}
      <div className="panel" style="margin-top:12px">
        <div className="panel-head">
          <h3>Team invitations</h3>
          <span className="right">Tokens are hashed at rest, one-time, expiring</span>
        </div>
        {input.invitations.length === 0 ? (
          <p className="sub" style="padding:14px 16px">No invitations yet.</p>
        ) : (
          <div className="intg-table-wrap">
            <table className="intg-table">
              <thead><tr><th>Email</th><th>Role</th><th>Organization</th><th>Status</th><th>Expires</th><th></th></tr></thead>
              <tbody>
                {input.invitations.map(({ invitation: inv, org, acceptedUser }) => (
                  <tr>
                    <td data-l="Email">{inv.email}</td>
                    <td data-l="Role">{kindLabel(inv.role)}</td>
                    <td data-l="Org">{org?.name ?? "—"}</td>
                    <td data-l="Status">
                      <span className={`sync-tag ${INV_TONE[inv.status]}`} style="margin-left:0">{inv.status}</span>
                      {acceptedUser ? <span className="sub" style="font-size:10.5px"> {acceptedUser.name}</span> : null}
                    </td>
                    <td data-l="Expires">{inv.expiresAt.slice(0, 10)}</td>
                    <td data-l="">
                      {input.canAdmin && inv.status === "PENDING" ? (
                        <span style="display:flex;gap:6px">
                          <form method="POST" action={`/api/pilot/invitations/${inv.id}/resend`} style="margin:0">
                            <button className="btn ghost sm" type="submit">Resend</button>
                          </form>
                          <form method="POST" action={`/api/pilot/invitations/${inv.id}/revoke`} style="margin:0">
                            <button className="btn ghost sm" type="submit">Revoke</button>
                          </form>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {input.canAdmin ? (
          <form method="POST" action="/api/pilot/invitations" className="fo-form" style="padding:14px 16px;border-top:1px solid var(--line)">
            <div className="fo-row">
              <label style="flex:2">Email
                <input name="email" type="email" required placeholder="engineer@contractor.example" />
              </label>
              <label>Organization
                <select name="organizationId" required>
                  {input.orgs.map((o) => <option value={o.id}>{o.name}</option>)}
                </select>
              </label>
              <label>Role
                <select name="role">
                  {["FIELD", "PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"].map((r) => (
                    <option value={r}>{kindLabel(r)}</option>
                  ))}
                </select>
              </label>
              <label>Project access (optional)
                <select name="projectId">
                  <option value="">—</option>
                  {input.projects.map(({ project }) => <option value={project.id}>{project.name}</option>)}
                </select>
              </label>
            </div>
            <button className="btn secondary sm" type="submit" style="align-self:flex-start">Send Invitation</button>
          </form>
        ) : null}
      </div>

      {/* ---- danger zone ---- */}
      {input.canAdmin ? (
        <div className="panel" style="margin-top:12px;border-color:var(--warn)">
          <div className="panel-head">
            <h3>Development Full Reset</h3>
            <span className="right">Dangerous — wipes pilot data</span>
          </div>
          <form method="POST" action="/api/dev/full-reset" className="fo-form" style="padding:14px 16px">
            <p className="sub" style="font-size:12px;margin:0">
              “Reset demo data” on Overview restores the seeded R47 demo and <b>preserves</b> pilot
              projects. This full reset instead drops <b>everything</b> — pilot organizations,
              users, projects, configuration — and reseeds the demo. Type <code>FULL RESET</code> to confirm.
            </p>
            <div className="fo-row">
              <label style="max-width:280px">Confirmation
                <input name="confirm" placeholder="FULL RESET" autocomplete="off" />
              </label>
            </div>
            <button className="btn ghost sm" type="submit" style="align-self:flex-start;color:var(--bad)">
              Run Development Full Reset
            </button>
          </form>
        </div>
      ) : null}
    </AppShell>
  );
}

// ======================================================== project workspace

export interface ProjectSetupData {
  orgs: Organization[];
  milestones: Milestone[];
  requirementsByMilestone: Map<string, EvidenceRequirement[]>;
  templates: ProjectTemplate[];
  reconciliation: DrawReconciliation;
  approvalPolicies: ApprovalPolicy[];
  verificationPolicy: VerificationPolicyConfig | null;
  assignments: Array<{ assignment: FieldAssignment; user: User | null }>;
  participants: User[];
  readiness: { ready: boolean; checks: ReadinessCheck[] };
  route: SpatialFeature | null;
  integrations: { teamsConfigured: boolean; whatsappConfigured: boolean };
  audit: ConfigAuditEntry[];
  snapshots: ConfigSnapshot[];
  users: Map<string, User>;
  importResult: { kind: string; ok: boolean; imported: number; errors: string[] } | null;
  error: string | null;
}

export function renderProjectSetup(input: {
  nav: NavContext;
  project: Project;
  stage: string;
  stages: SetupStage[];
  canAdmin: boolean;
  data: ProjectSetupData;
}): string {
  const { project, stage, stages, data, canAdmin } = input;
  const launched = project.status !== "DRAFT";
  const done = stages.filter((s) => s.complete).length;
  const stageHref = (slug: string) => `/setup/project/${project.id}?stage=${slug}`;
  return renderDocument(
    <AppShell title={`Setup · ${project.name}`} nav={input.nav} context="Pilot Setup">
      <PageHeader
        title={project.name}
        sub={`${project.pilot?.code ? project.pilot.code + " · " : ""}${project.status === "DRAFT" ? "Draft configuration — editable until launch." : `ACTIVE — launched ${project.pilot?.launchedAt ? fmtDate(project.pilot.launchedAt) : ""}; material changes require a change reason and are audited.`}`}
        crumb={{ href: "/setup", label: "Pilot Setup" }}
      >
        <span className={`sync-tag ${project.status === "DRAFT" ? "warn" : "ok"}`} style="margin-left:0">
          {project.status}
        </span>
      </PageHeader>

      {data.error ? <div className="banner warn" style="margin-bottom:12px">{data.error}</div> : null}

      <div className="setup-grid">
        {/* ---- stage navigation ---- */}
        <nav className="setup-nav panel" aria-label="Setup stages">
          <div className="panel-head"><h3>Stages</h3><span className="right">{done}/{stages.length}</span></div>
          {stages.map((s) => (
            <a
              className={`setup-stage ${stage === s.slug ? "active" : ""}`}
              href={stageHref(s.slug)}
            >
              <span className={`st-dot ${s.complete ? "ok" : ""}`}>{s.complete ? "✓" : "○"}</span>
              <span className="st-body">
                <span className="st-title">{s.title}</span>
                <span className="st-detail">{s.detail}</span>
              </span>
            </a>
          ))}
        </nav>

        <div className="setup-body">
          {stage === "project" ? <StageProject project={project} data={data} canAdmin={canAdmin} launched={launched} /> : null}
          {stage === "geography" ? <StageGeography project={project} data={data} canAdmin={canAdmin} launched={launched} /> : null}
          {stage === "milestones" ? <StageMilestones project={project} data={data} canAdmin={canAdmin} launched={launched} /> : null}
          {stage === "evidence" ? <StageEvidence project={project} data={data} canAdmin={canAdmin} launched={launched} /> : null}
          {stage === "draw" ? <StageDraw project={project} data={data} canAdmin={canAdmin} launched={launched} /> : null}
          {stage === "approvals" ? <StageApprovals project={project} data={data} canAdmin={canAdmin} launched={launched} /> : null}
          {stage === "field" ? <StageField project={project} data={data} canAdmin={canAdmin} /> : null}
          {stage === "integrations" ? <StageIntegrations data={data} /> : null}
          {stage === "review" ? <StageReview project={project} data={data} canAdmin={canAdmin} stageHref={stageHref} /> : null}
        </div>
      </div>
    </AppShell>
  );
}

function ReasonField(props: { launched: boolean }): VNode {
  return props.launched ? (
    <label>Change reason (required — audited)
      <input name="reason" required maxlength="400" placeholder="Why this post-launch change is needed" />
    </label>
  ) : (
    <Fragment />
  );
}

function StageProject(props: { project: Project; data: ProjectSetupData; canAdmin: boolean; launched: boolean }): VNode {
  const { project, data, canAdmin, launched } = props;
  const p = project.pilot!;
  const orgSelect = (name: string, value: string | null) => (
    <select name={name}>
      <option value="">—</option>
      {data.orgs.map((o) => (
        <option value={o.id} selected={o.id === value}>{o.name}</option>
      ))}
    </select>
  );
  return (
    <div className="panel">
      <div className="panel-head"><h3>Project details</h3></div>
      <form method="POST" action={`/api/pilot/projects/${project.id}`} className="fo-form" style="padding:14px 16px">
        <div className="fo-row">
          <label style="flex:2">Name<input name="name" value={project.name} required maxlength="160" disabled={!canAdmin} /></label>
          <label>Code<input name="code" value={p.code ?? ""} maxlength="60" disabled={!canAdmin} /></label>
          <label>Type
            <select name="category" disabled={!canAdmin}>
              {PROJECT_CATEGORY_OPTIONS.map((c) => (
                <option value={c} selected={c === p.category}>{kindLabel(c)}</option>
              ))}
            </select>
          </label>
        </div>
        <label>Description
          <textarea name="description" rows="3" disabled={!canAdmin}>{project.description}</textarea>
        </label>
        <div className="fo-row">
          <label>Country<input name="country" value={p.country ?? ""} disabled={!canAdmin} /></label>
          <label>Region<input name="region" value={p.region ?? ""} disabled={!canAdmin} /></label>
          <label>Locality<input name="locality" value={p.locality ?? ""} disabled={!canAdmin} /></label>
          <label>Timezone<input name="timezone" value={p.timezone ?? ""} placeholder="Africa/Blantyre" disabled={!canAdmin} /></label>
        </div>
        <div className="fo-row">
          <label>Implementing organization{orgSelect("implementingOrgId", p.implementingOrgId)}</label>
          <label>Contractor{orgSelect("contractorOrgId", p.contractorOrgId)}</label>
          <label>Funder / lender{orgSelect("funderOrgId", p.funderOrgId)}</label>
          <label>Engineer / consultant{orgSelect("engineerOrgId", p.engineerOrgId)}</label>
        </div>
        <div className="fo-row">
          <label>Total project value<input name="totalValue" type="number" min="0" value={String(project.totalBudget)} disabled={!canAdmin} /></label>
          <label>OBV-controlled amount<input name="obvControlledAmount" type="number" min="0" value={p.obvControlledAmount !== null ? String(p.obvControlledAmount) : ""} disabled={!canAdmin} /></label>
          <label>Currency<input name="currency" value={p.currency ?? "USD"} maxlength="6" disabled={!canAdmin} /></label>
        </div>
        <div className="fo-row">
          <label>Planned start<input name="plannedStart" type="date" value={p.plannedStart ?? ""} disabled={!canAdmin} /></label>
          <label>Planned completion<input name="plannedEnd" type="date" value={p.plannedEnd ?? ""} disabled={!canAdmin} /></label>
        </div>
        <ReasonField launched={launched} />
        {canAdmin ? <button className="btn" type="submit" style="align-self:flex-start">Save Project</button> : null}
      </form>
    </div>
  );
}

function StageGeography(props: { project: Project; data: ProjectSetupData; canAdmin: boolean; launched: boolean }): VNode {
  const { project, data, canAdmin, launched } = props;
  const kind = project.pilot?.geometryKind;
  const current =
    kind === "CORRIDOR" && data.route
      ? data.route.geometry.map(([lng, lat]) => `${lng}, ${lat}`).join("\n")
      : project.siteBoundary.length
        ? project.siteBoundary.slice(0, -1).map(([lng, lat]) => `${lng}, ${lat}`).join("\n")
        : "";
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Project geography</h3>
        <span className="right">User-defined precision — not survey-grade data</span>
      </div>
      <div style="padding:14px 16px">
        <p className="sub" style="font-size:12px;margin:0 0 12px">
          {kind
            ? `Configured: ${kind} geometry with a ${project.siteBoundary.length}-vertex geofence. `
            : "No geography configured yet. "}
          The geofence drives the deterministic location check on every evidence submission.
          Enter one <code>longitude, latitude</code> pair per line (corridors follow the route; polygons
          list boundary vertices; a point site takes a single pair).
        </p>
        <form method="POST" action={`/api/pilot/projects/${project.id}/geography`} className="fo-form">
          <div className="fo-row">
            <label style="max-width:220px">Geometry kind
              <select name="kind" disabled={!canAdmin}>
                {["CORRIDOR", "POLYGON", "POINT"].map((k) => (
                  <option value={k} selected={k === kind}>{kindLabel(k)}</option>
                ))}
              </select>
            </label>
            <label>Label (corridors)
              <input name="label" maxlength="160" placeholder="e.g. K14 corridor centerline" disabled={!canAdmin} />
            </label>
          </div>
          <label>Coordinates — one “lng, lat” per line
            <textarea name="coordinates" rows="8" placeholder={"33.5900, -11.9100\n33.6100, -11.8800\n33.6400, -11.8500"} disabled={!canAdmin}>{current}</textarea>
          </label>
          <ReasonField launched={launched} />
          {canAdmin ? <button className="btn" type="submit" style="align-self:flex-start">Save Geography</button> : null}
        </form>
        {kind ? (
          <p className="sub" style="font-size:11.5px;margin-top:10px">
            View the result on the <a href="/map" style="color:var(--action);font-weight:600">Project Map</a> after launch.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function StageMilestones(props: { project: Project; data: ProjectSetupData; canAdmin: boolean; launched: boolean }): VNode {
  const { project, data, canAdmin, launched } = props;
  return (
    <Fragment>
      {!launched && data.milestones.length === 0 ? (
        <div className="panel" style="margin-bottom:12px">
          <div className="panel-head"><h3>Start from a template</h3><span className="right">Editable after applying — configuration only</span></div>
          {data.templates.map((t, i) => (
            <div className="setup-proj" style={i > 0 ? "border-top:1px solid var(--line)" : ""}>
              <span className="sp-id">
                <b>{t.name}</b>
                <span className="s">{t.description}</span>
                <span className="s">{t.milestones.length} milestones · approval: {t.approvalRoles.map(kindLabel).join(" + ")}</span>
              </span>
              {canAdmin ? (
                <form method="POST" action={`/api/pilot/projects/${project.id}/template`} style="margin:0">
                  <input type="hidden" name="templateKey" value={t.key} />
                  <button className="btn sm" type="submit">Use Template</button>
                </form>
              ) : null}
            </div>
          ))}
          <p className="sub" style="padding:10px 16px;font-size:11.5px">
            Or start blank by adding milestones below. A template creates configuration only —
            never evidence, approvals, or completed state.
          </p>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h3>Milestones</h3>
          <span className="right">{data.milestones.filter((m) => !m.archived).length} active</span>
        </div>
        {data.milestones.map((m, i) => (
          <details className="ms-edit" style={i > 0 ? "border-top:1px solid var(--line)" : ""}>
            <summary>
              <span className="sp-id">
                <b>M{m.seq} · {m.title}</b>
                {m.archived ? <span className="sync-tag neutral">ARCHIVED</span> : null}
                <span className="s">{money(m.trancheAmount)} · {m.status.replace(/_/g, " ")}</span>
              </span>
              <span className="sub" style="font-size:11px">edit</span>
            </summary>
            <form method="POST" action={`/api/pilot/milestones/${m.id}`} className="fo-form" style="padding:12px 16px 16px">
              <div className="fo-row">
                <label style="max-width:110px">Sequence<input name="seq" type="number" min="1" value={String(m.seq)} disabled={!canAdmin} /></label>
                <label style="flex:2">Title<input name="title" value={m.title} maxlength="160" disabled={!canAdmin} /></label>
                <label>Tranche amount<input name="trancheAmount" type="number" min="0" value={String(m.trancheAmount)} disabled={!canAdmin || m.accountStatus === "RELEASED"} /></label>
              </div>
              <label>Requirement (what the evidence must show)
                <textarea name="requirement" rows="2" disabled={!canAdmin}>{m.requirement}</textarea>
              </label>
              <div className="fo-row">
                <label>Planned start<input name="plannedStart" type="date" value={m.plannedStart ?? ""} disabled={!canAdmin} /></label>
                <label>Planned end<input name="plannedEnd" type="date" value={m.plannedEnd ?? ""} disabled={!canAdmin} /></label>
                <label>Spatial label<input name="spatialLabel" value={m.spatialLabel ?? ""} placeholder="e.g. km 0–3" disabled={!canAdmin} /></label>
              </div>
              <ReasonField launched={launched} />
              {canAdmin ? (
                <div style="display:flex;gap:8px">
                  <button className="btn sm" type="submit">Save Milestone</button>
                  {!launched ? (
                    <button className="btn ghost sm" type="submit" formaction={`/api/pilot/milestones/${m.id}/delete`}>Delete</button>
                  ) : null}
                </div>
              ) : null}
            </form>
          </details>
        ))}
        {canAdmin ? (
          <form method="POST" action={`/api/pilot/projects/${project.id}/milestones`} className="fo-form" style="padding:14px 16px;border-top:1px solid var(--line)">
            <div className="fo-row">
              <label style="max-width:110px">Sequence<input name="seq" type="number" min="1" value={String(data.milestones.length + 1)} /></label>
              <label style="flex:2">Title<input name="title" required maxlength="160" placeholder="New milestone" /></label>
              <label>Tranche amount<input name="trancheAmount" type="number" min="0" value="0" /></label>
            </div>
            <label>Requirement<textarea name="requirement" rows="2" required placeholder="What the field evidence must show"></textarea></label>
            <ReasonField launched={launched} />
            <button className="btn secondary sm" type="submit" style="align-self:flex-start">Add Milestone</button>
          </form>
        ) : null}
      </div>

      {!launched && canAdmin ? (
        <CsvImportPanel projectId={project.id} kind="milestones" title="Import milestones from CSV" result={data.importResult} />
      ) : null}
    </Fragment>
  );
}

function StageEvidence(props: { project: Project; data: ProjectSetupData; canAdmin: boolean; launched: boolean }): VNode {
  const { project, data, canAdmin, launched } = props;
  return (
    <Fragment>
      {data.milestones.filter((m) => !m.archived).map((m) => {
        const reqs = data.requirementsByMilestone.get(m.id) ?? [];
        return (
          <div className="panel" style="margin-bottom:12px">
            <div className="panel-head">
              <h3>M{m.seq} · {m.title}</h3>
              <span className="right">{reqs.length} requirement(s)</span>
            </div>
            {reqs.length === 0 ? (
              <p className="sub" style="padding:12px 16px;font-size:12px;color:var(--warn)">
                No evidence requirements — readiness will block launch until this milestone has at
                least one required item.
              </p>
            ) : (
              reqs.map((r, i) => (
                <div className="setup-proj" style={i > 0 ? "border-top:1px solid var(--line)" : ""}>
                  <span className="sp-id">
                    <b>{r.title}</b>
                    <span className="s">
                      {r.type}{r.required ? " · required" : " · optional"} · min {r.minCount}
                      {r.geolocationRequired ? " · geolocation required" : ""}
                      {r.recencyDays ? ` · capture within ${r.recencyDays} days` : ""}
                      {r.mediaTypes.length ? ` · ${r.mediaTypes.join(", ")}` : ""}
                    </span>
                    {r.description ? <span className="s">{r.description}</span> : null}
                  </span>
                  {canAdmin && !launched ? (
                    <form method="POST" action={`/api/pilot/requirements/${r.id}/delete`} style="margin:0">
                      <button className="btn ghost sm" type="submit">Remove</button>
                    </form>
                  ) : null}
                </div>
              ))
            )}
            {canAdmin ? (
              <form method="POST" action="/api/pilot/requirements" className="fo-form" style="padding:12px 16px;border-top:1px solid var(--line)">
                <input type="hidden" name="milestoneId" value={m.id} />
                <div className="fo-row">
                  <label>Type
                    <select name="type">
                      {REQUIREMENT_TYPE_OPTIONS.map((t) => <option value={t}>{kindLabel(t)}</option>)}
                    </select>
                  </label>
                  <label style="flex:2">Title<input name="title" required maxlength="200" placeholder="e.g. Compaction test results" /></label>
                  <label style="max-width:100px">Min count<input name="minCount" type="number" min="1" max="50" value="1" /></label>
                </div>
                <div className="fo-row">
                  <label>Allowed media (comma-separated)
                    <input name="mediaTypes" placeholder="image/jpeg, image/png" />
                  </label>
                  <label style="max-width:170px">Geolocation required
                    <select name="geolocationRequired"><option value="false">No</option><option value="true">Yes</option></select>
                  </label>
                  <label style="max-width:170px">Capture recency (days)
                    <input name="recencyDays" type="number" min="1" max="90" placeholder="—" />
                  </label>
                  <label style="max-width:130px">Required
                    <select name="required"><option value="true">Required</option><option value="false">Optional</option></select>
                  </label>
                </div>
                <ReasonField launched={launched} />
                <button className="btn secondary sm" type="submit" style="align-self:flex-start">Add Requirement</button>
              </form>
            ) : null}
          </div>
        );
      })}
      {data.milestones.length === 0 ? (
        <div className="panel"><EmptyState icon={icons.check()} title="No milestones yet" message="Configure milestones first — evidence requirements attach to them." /></div>
      ) : null}
      {!launched && canAdmin && data.milestones.length > 0 ? (
        <CsvImportPanel projectId={project.id} kind="requirements" title="Import evidence requirements from CSV" result={data.importResult} />
      ) : null}
    </Fragment>
  );
}

function StageDraw(props: { project: Project; data: ProjectSetupData; canAdmin: boolean; launched: boolean }): VNode {
  const { project, data, canAdmin, launched } = props;
  const r = data.reconciliation;
  const active = data.milestones.filter((m) => !m.archived);
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Draw structure</h3>
        <span className="right">{r.currency} {r.controlledAmount.toLocaleString("en-US")} OBV-controlled</span>
      </div>
      <div
        className={`banner ${r.matched && r.controlledAmount > 0 ? "ok" : "warn"}`}
        style="margin:12px 16px 0"
      >
        {r.matched && r.controlledAmount > 0
          ? `Reconciled: tranches sum to ${r.currency} ${r.trancheTotal.toLocaleString("en-US")} = OBV-controlled amount.`
          : `SUM OF TRANCHES (${r.currency} ${r.trancheTotal.toLocaleString("en-US")}) ≠ OBV-CONTROLLED PROJECT AMOUNT (${r.currency} ${r.controlledAmount.toLocaleString("en-US")}) — readiness will block launch until reconciled.`}
      </div>
      <form method="POST" action={`/api/pilot/projects/${project.id}/draw`} className="fo-form" style="padding:14px 16px">
        <div className="intg-table-wrap">
          <table className="intg-table">
            <thead><tr><th>Seq</th><th>Milestone</th><th>Account</th><th style="width:180px">Tranche amount</th></tr></thead>
            <tbody>
              {active.map((m) => (
                <tr>
                  <td data-l="Seq">M{m.seq}</td>
                  <td data-l="Milestone">{m.title}</td>
                  <td data-l="Account"><span className={`sync-tag ${m.accountStatus === "RELEASED" ? "ok" : "warn"}`} style="margin-left:0">{m.accountStatus}</span></td>
                  <td data-l="Amount">
                    <input
                      name={`tranche_${m.id}`}
                      type="number"
                      min="0"
                      value={String(m.trancheAmount)}
                      disabled={!canAdmin || m.accountStatus === "RELEASED"}
                      style="width:100%"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ReasonField launched={launched} />
        {canAdmin ? <button className="btn" type="submit" style="align-self:flex-start">Save Draw Structure</button> : null}
      </form>
      <p className="sub" style="padding:0 16px 14px;font-size:11.5px">
        Tranches are governance/accounting state on the virtual project account (no real money
        moves). Release eligibility is controlled only by the formal approval workflow.
      </p>
    </div>
  );
}

function StageApprovals(props: { project: Project; data: ProjectSetupData; canAdmin: boolean; launched: boolean }): VNode {
  const { project, data, canAdmin, launched } = props;
  const projectDefault = data.approvalPolicies.find((p) => p.milestoneId === null);
  const roles = projectDefault?.requiredRoles ?? [];
  const vp = data.verificationPolicy;
  return (
    <Fragment>
      <div className="panel" style="margin-bottom:12px">
        <div className="panel-head">
          <h3>Approval matrix</h3>
          <span className="right">Separation of duties enforced</span>
        </div>
        <form method="POST" action={`/api/pilot/projects/${project.id}/approval-matrix`} className="fo-form" style="padding:14px 16px">
          <p className="sub" style="font-size:12px;margin:0">
            Every selected role must approve (one decision per role) before a tranche can release.
            At least two distinct roles are required; FIELD can never approve; the evidence
            submitter can never approve their own submission — these constraints are enforced by
            the workflow, not just this form.
          </p>
          <div className="fo-row">
            {["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"].map((role) => (
              <label style="flex-direction:row;align-items:center;gap:8px;min-width:0;text-transform:none;letter-spacing:normal;font-size:12.5px;font-weight:500">
                <input type="checkbox" name="roles" value={role} checked={roles.includes(role as never)} disabled={!canAdmin} style="min-height:auto;width:16px" />
                {kindLabel(role)}
              </label>
            ))}
          </div>
          <ReasonField launched={launched} />
          {canAdmin ? <button className="btn" type="submit" style="align-self:flex-start">Save Approval Matrix</button> : null}
        </form>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Verification policy</h3>
          <span className="right">Customer policy — bounded by OBV integrity rules</span>
        </div>
        <form method="POST" action={`/api/pilot/projects/${project.id}/verification-policy`} className="fo-form" style="padding:14px 16px">
          <div className="fo-row">
            <label>AI confidence threshold (0.50–0.95)
              <input name="aiConfidenceThreshold" type="number" step="0.01" min="0.5" max="0.95" value={vp?.aiConfidenceThreshold !== null && vp?.aiConfidenceThreshold !== undefined ? String(vp.aiConfidenceThreshold) : ""} placeholder="0.75 (default)" disabled={!canAdmin} />
            </label>
            <label>Geofence policy
              <select name="geofencePolicy" disabled={!canAdmin}>
                <option value="">Standard (default)</option>
                {["STRICT", "EXTENDED_REVIEW"].map((g) => (
                  <option value={g} selected={vp?.geofencePolicy === g}>{kindLabel(g)}</option>
                ))}
              </select>
            </label>
            <label>Offline capture allowance (0–14 days)
              <input name="offlineAllowanceDays" type="number" min="0" max="14" value={vp?.offlineAllowanceDays !== null && vp?.offlineAllowanceDays !== undefined ? String(vp.offlineAllowanceDays) : ""} placeholder="7 (default)" disabled={!canAdmin} />
            </label>
          </div>
          <ReasonField launched={launched} />
          {canAdmin ? <button className="btn secondary sm" type="submit" style="align-self:flex-start">Save Verification Policy</button> : null}
        </form>
        <p className="sub" style="padding:0 16px 14px;font-size:11.5px">
          OBV NON-OVERRIDABLE INTEGRITY RULES always apply: missing GPS or capture metadata routes
          to review; malformed or future timestamps are rejected; a strong visual mismatch is
          rejected — no configuration can auto-verify them.
        </p>
      </div>
    </Fragment>
  );
}

function StageField(props: { project: Project; data: ProjectSetupData; canAdmin: boolean }): VNode {
  const { project, data, canAdmin } = props;
  const fieldUsers = data.participants.filter((u) => u.role === "FIELD");
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Field assignments</h3>
        <span className="right">Scopes mobile capture access</span>
      </div>
      {data.assignments.length === 0 ? (
        <p className="sub" style="padding:14px 16px">
          No field staff assigned. Invite FIELD users from Pilot Setup → Team, then assign them here.
        </p>
      ) : (
        data.assignments.map(({ assignment, user }, i) => (
          <div className="setup-proj" style={i > 0 ? "border-top:1px solid var(--line)" : ""}>
            <span className="sp-id">
              <b>{user?.name ?? assignment.userId}</b>
              <span className="s">
                {assignment.milestoneIds.length
                  ? `${assignment.milestoneIds.length} assigned milestone(s)`
                  : "All milestones"}
                {assignment.effectiveFrom ? ` · from ${assignment.effectiveFrom.slice(0, 10)}` : ""}
                {!assignment.active ? " · inactive" : ""}
              </span>
            </span>
            {canAdmin && assignment.active ? (
              <form method="POST" action={`/api/pilot/assignments/${assignment.id}/deactivate`} style="margin:0">
                <button className="btn ghost sm" type="submit">Deactivate</button>
              </form>
            ) : null}
          </div>
        ))
      )}
      {canAdmin ? (
        <form method="POST" action={`/api/pilot/projects/${project.id}/assignments`} className="fo-form" style="padding:14px 16px;border-top:1px solid var(--line)">
          <div className="fo-row">
            <label>Field user
              <select name="userId" required>
                {fieldUsers.length === 0 ? <option value="">No FIELD users yet — invite one first</option> : null}
                {fieldUsers.map((u) => <option value={u.id}>{u.name} — {u.title}</option>)}
              </select>
            </label>
            <label>Milestones (blank = all)
              <select name="milestoneIds" multiple size="4">
                {data.milestones.filter((m) => !m.archived).map((m) => (
                  <option value={m.id}>M{m.seq} · {m.title}</option>
                ))}
              </select>
            </label>
            <label>Effective from<input name="effectiveFrom" type="date" /></label>
          </div>
          <button className="btn secondary sm" type="submit" style="align-self:flex-start">Assign to Project</button>
        </form>
      ) : null}
      <p className="sub" style="padding:0 16px 14px;font-size:11.5px">
        Assigned field users see only their assigned projects and milestones in Field Capture.
        External WhatsApp participants are mapped separately under Communications → Integrations —
        a communication-only participant never becomes an OBV user implicitly.
      </p>
    </div>
  );
}

function StageIntegrations(props: { data: ProjectSetupData }): VNode {
  const { teamsConfigured, whatsappConfigured } = props.data.integrations;
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Communication integrations</h3>
        <span className="right">OPTIONAL — never required for launch</span>
      </div>
      <div className="setup-proj">
        <span className="sp-id">
          <b>Microsoft Teams</b>
          <span className={`sync-tag ${teamsConfigured ? "ok" : "neutral"}`}>{teamsConfigured ? "Configured" : "Not Configured"}</span>
          <span className="s">Two-way conversation sync for bound project threads.</span>
        </span>
        <a className="btn ghost sm" href="/communications/integrations">Manage</a>
      </div>
      <div className="setup-proj" style="border-top:1px solid var(--line)">
        <span className="sp-id">
          <b>WhatsApp Business</b>
          <span className={`sync-tag ${whatsappConfigured ? "ok" : "neutral"}`}>{whatsappConfigured ? "Configured" : "Not Configured"}</span>
          <span className="s">Field coordination bridge: identity mappings, participant contexts, unresolved inbox.</span>
        </span>
        <a className="btn ghost sm" href="/communications/integrations">Manage</a>
      </div>
      <p className="sub" style="padding:12px 16px;font-size:11.5px">
        Internal OBV Communications works fully without any integration. External channels
        coordinate only — nothing arriving on them can create evidence, satisfy approvals, or
        release funds.
      </p>
    </div>
  );
}

function StageReview(props: {
  project: Project;
  data: ProjectSetupData;
  canAdmin: boolean;
  stageHref: (slug: string) => string;
}): VNode {
  const { project, data, canAdmin, stageHref } = props;
  const { ready, checks } = data.readiness;
  const blockers = checks.filter((c) => !c.ok && !c.optional);
  const launched = project.status !== "DRAFT";
  return (
    <Fragment>
      <div className="panel" style="margin-bottom:12px">
        <div className="panel-head">
          <h3>Launch checklist</h3>
          <span className="right">Deterministic configuration checks — no AI</span>
        </div>
        <div
          className={`banner ${launched ? "ok" : ready ? "ok" : "warn"}`}
          style="margin:12px 16px 0;font-weight:650"
        >
          {launched
            ? `LAUNCHED ${project.pilot?.launchedAt ? fmtDate(project.pilot.launchedAt) : ""} — configuration v${project.pilot?.configVersion}`
            : ready
              ? "READY TO LAUNCH"
              : `NOT READY — ${blockers.length} BLOCKER(S) REMAIN`}
        </div>
        <ul className="readiness">
          {checks.map((c) => (
            <li className={c.ok ? "ok" : c.optional ? "opt" : "bad"}>
              <span className="r-ico">{c.ok ? "✓" : c.optional ? "○" : "✗"}</span>
              <span className="r-body">
                <span className="r-label">
                  {c.label}
                  {c.optional ? <span className="sync-tag neutral">OPTIONAL</span> : null}
                </span>
                <span className="r-detail">{c.detail}</span>
              </span>
              {!c.ok && !c.optional ? (
                <a className="btn ghost sm" href={stageHref(c.stage)}>Fix →</a>
              ) : null}
            </li>
          ))}
        </ul>
        {!launched && canAdmin ? (
          <form method="POST" action={`/api/pilot/projects/${project.id}/launch`} style="padding:0 16px 16px;margin:0">
            <button className="btn" type="submit" disabled={!ready} data-busy-label="Launching…">
              Launch Project
            </button>
            <p className="sub" style="font-size:11.5px;margin-top:8px">
              Launch activates configuration: status becomes ACTIVE, tranches are recorded HELD, a
              configuration snapshot is taken, and coordination threads open. It creates no
              evidence, no approvals, and no ledger entries — proof of work starts in the field.
            </p>
          </form>
        ) : null}
        {launched ? (
          <p className="sub" style="padding:0 16px 14px;font-size:11.5px">
            <a href={`/api/pilot/projects/${project.id}/export`} style="color:var(--action);font-weight:600">Download Pilot Export Package</a>
            {" "}— configuration summary, registers, matrices, readiness result, report index (no secrets).
          </p>
        ) : null}
      </div>

      {data.snapshots.length > 0 ? (
        <div className="panel" style="margin-bottom:12px">
          <div className="panel-head"><h3>Configuration snapshots</h3><span className="right">Immutable — separate from the Evidence Ledger</span></div>
          <div className="intg-table-wrap">
            <table className="intg-table">
              <thead><tr><th>Version</th><th>Reason</th><th>By</th><th>At</th><th>Hash</th></tr></thead>
              <tbody>
                {data.snapshots.map((s) => (
                  <tr>
                    <td data-l="Version">v{s.version}</td>
                    <td data-l="Reason">{s.reason}</td>
                    <td data-l="By">{data.users.get(s.createdBy)?.name ?? "—"}</td>
                    <td data-l="At">{fmtDate(s.createdAt)}</td>
                    <td data-l="Hash"><code style="font-size:10px">{s.hash.slice(0, 16)}…</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h3>Configuration audit trail</h3>
          <span className="right">Administrative record — NOT the Evidence Ledger</span>
        </div>
        {data.audit.length === 0 ? (
          <p className="sub" style="padding:14px 16px">No configuration actions recorded yet.</p>
        ) : (
          <ul className="activity">
            {data.audit.slice(0, 30).map((e) => (
              <li>
                <span className="ico warn">{icons.activity()}</span>
                <span className="body">
                  <span className="msg">
                    <b>{e.action.replace(/_/g, " ")}</b> — {e.afterSummary ?? e.beforeSummary ?? e.entityId}
                    {e.reason ? <span className="sub"> · reason: {e.reason}</span> : null}
                  </span>
                  <span className="meta">
                    <span className="when">{fmtDate(e.createdAt)}</span>
                    <span>{data.users.get(e.actorUserId)?.name ?? e.actorUserId}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Fragment>
  );
}

function CsvImportPanel(props: {
  projectId: string;
  kind: string;
  title: string;
  result: { kind: string; ok: boolean; imported: number; errors: string[] } | null;
}): VNode {
  const r = props.result && props.result.kind === props.kind ? props.result : null;
  return (
    <div className="panel" style="margin-top:12px">
      <div className="panel-head">
        <h3>{props.title}</h3>
        <span className="right">
          <a href={`/api/pilot/csv-template/${props.kind}`} style="color:var(--action);font-weight:600">Download template</a>
        </span>
      </div>
      {r ? (
        <div className={`banner ${r.ok ? "ok" : "warn"}`} style="margin:12px 16px 0">
          {r.ok
            ? `Imported ${r.imported} row(s).`
            : ["Import rejected — nothing was written:", ...r.errors.slice(0, 8)].join(" ")}
        </div>
      ) : null}
      <form method="POST" action={`/api/pilot/projects/${props.projectId}/import/${props.kind}`} className="fo-form" style="padding:14px 16px">
        <label>Paste CSV (header row required)
          <textarea name="csv" rows="5" placeholder="Paste rows matching the template columns"></textarea>
        </label>
        <div style="display:flex;gap:8px">
          <button className="btn ghost sm" type="submit" name="mode" value="preview">Validate Only</button>
          <button className="btn secondary sm" type="submit" name="mode" value="commit">Validate &amp; Import</button>
        </div>
      </form>
    </div>
  );
}

// ========================================================== invite accept

export function renderInviteAccept(input: {
  invitation: Invitation | null;
  orgName: string | null;
  token: string;
  error: string | null;
}): string {
  const inv = input.invitation;
  return renderDocument(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Activate access — OBV</title>
        <link rel="stylesheet" href={STYLESHEET_HREF} />
        <link rel="icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#0d1626" />
      </head>
      <body>
        <div className="auth-wrap">
          <div className="auth-box">
            <div className="auth-brand">
              <span className="mark">{brandMark(22)}</span>
              <span>
                <span className="name" style="display:block">OpenBuild Verify</span>
                <span className="tagline" style="display:block">The truth layer for physical projects</span>
              </span>
            </div>
            {input.error || !inv ? (
              <Fragment>
                <h1 style="font-size:16px;margin:14px 0 6px">Invitation unavailable</h1>
                <p className="sub" style="font-size:12.5px">
                  {input.error ?? "This invitation link is invalid, expired, revoked, or already used. Ask your administrator to issue a new one."}
                </p>
              </Fragment>
            ) : (
              <Fragment>
                <h1 style="font-size:16px;margin:14px 0 4px">Activate your OBV access</h1>
                <p className="sub" style="font-size:12.5px;margin:0 0 14px">
                  <b>{inv.email}</b> · {kindLabel(inv.role)}
                  {input.orgName ? ` · ${input.orgName}` : ""}
                </p>
                <form method="POST" action="/api/invitations/accept" className="fo-form">
                  <input type="hidden" name="token" value={input.token} />
                  <label>Your name<input name="name" required maxlength="120" placeholder="Full name" /></label>
                  <label>Title<input name="title" maxlength="120" placeholder="e.g. Site Engineer" /></label>
                  <button className="btn" type="submit">Activate Access</button>
                </form>
                <p className="sub" style="font-size:11px;margin-top:12px">
                  This link is one-time and expires {inv.expiresAt.slice(0, 10)}.
                </p>
              </Fragment>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}

// ======================================================== pilot dashboard

export function renderPilotDashboard(input: {
  nav: NavContext;
  stats: {
    activeProjects: number;
    draftProjects: number;
    evidenceSubmitted: number;
    verified: number;
    needsReview: number;
    rejected: number;
    pendingApprovals: number;
    fundsHeld: number;
    fundsReleased: number;
    openIssues: number;
    openClarifications: number;
    invitationsPending: number;
  };
  integrations: { teamsConfigured: boolean; whatsappConfigured: boolean };
  drafts: Array<{ project: Project; blockers: number }>;
  active: Array<{ project: Project; held: number; released: number; pendingApprovals: number }>;
  canAdmin: boolean;
}): string {
  const s = input.stats;
  return renderDocument(
    <AppShell title="Pilot Operations" nav={input.nav} context="Pilot Operations">
      <PageHeader
        title="Pilot Operations"
        sub="Operational state across the pilot — real records only: evidence, verification, governance, funds, field operations."
      >
        <a className="btn ghost" href="/setup">Pilot Setup →</a>
      </PageHeader>

      <OperationalStatus
        items={[
          { tone: "ok", value: String(s.activeProjects), label: "active projects" },
          { tone: s.draftProjects ? "warn" : "idle", value: String(s.draftProjects), label: "drafts in setup" },
          { tone: s.pendingApprovals ? "warn" : "ok", value: String(s.pendingApprovals), label: "pending approvals" },
          { tone: s.needsReview ? "warn" : "ok", value: String(s.needsReview), label: "evidence needing review" },
        ]}
      />

      <div className="issue-stats" style="margin-top:12px">
        <span><b className="num">{s.evidenceSubmitted}</b> Evidence submitted</span>
        <span><b className="num">{s.verified}</b> Verified</span>
        <span><b className="num" style={s.needsReview ? "color:var(--warn)" : ""}>{s.needsReview}</b> Needs review</span>
        <span><b className="num" style={s.rejected ? "color:var(--bad)" : ""}>{s.rejected}</b> Rejected</span>
        <span><b className="num">{money(s.fundsHeld)}</b> Held</span>
        <span><b className="num">{money(s.fundsReleased)}</b> Released</span>
        <span><b className="num" style={s.openIssues ? "color:var(--warn)" : ""}>{s.openIssues}</b> Open field issues</span>
        <span><b className="num">{s.openClarifications}</b> Open clarifications</span>
        <span><b className="num">{s.invitationsPending}</b> Invitations pending</span>
      </div>

      {input.drafts.length > 0 ? (
        <div className="panel" style="margin-top:12px">
          <div className="panel-head"><h3>Draft projects — readiness</h3></div>
          {input.drafts.map(({ project, blockers }, i) => (
            <div className="setup-proj" style={i > 0 ? "border-top:1px solid var(--line)" : ""}>
              <span className="sp-id">
                <b>{project.name}</b>
                <span className="s">{blockers === 0 ? "READY TO LAUNCH" : `${blockers} blocker(s) remain`}</span>
              </span>
              <span className={`sync-tag ${blockers === 0 ? "ok" : "warn"}`}>{blockers === 0 ? "READY" : "NOT READY"}</span>
              <a className="btn ghost sm" href={`/setup/project/${project.id}?stage=review`}>Open Checklist</a>
            </div>
          ))}
        </div>
      ) : null}

      <div className="panel" style="margin-top:12px">
        <div className="panel-head"><h3>Active projects</h3></div>
        {input.active.length === 0 ? (
          <p className="sub" style="padding:14px 16px">No active projects.</p>
        ) : (
          <div className="intg-table-wrap">
            <table className="intg-table">
              <thead><tr><th>Project</th><th>Status</th><th>Held</th><th>Released</th><th>Pending approvals</th><th></th></tr></thead>
              <tbody>
                {input.active.map(({ project, held, released, pendingApprovals }) => (
                  <tr>
                    <td data-l="Project" style="font-weight:600">{project.name}</td>
                    <td data-l="Status"><span className="sync-tag ok" style="margin-left:0">{project.status}</span></td>
                    <td data-l="Held">{money(held)}</td>
                    <td data-l="Released">{money(released)}</td>
                    <td data-l="Approvals">{pendingApprovals}</td>
                    <td data-l=""><a href={`/project/${project.id}`} style="color:var(--action);font-weight:600">Open →</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel" style="margin-top:12px">
        <div className="panel-head"><h3>Integration health</h3><span className="right">Optional channels</span></div>
        <div className="issue-stats" style="border:0;margin:0">
          <span>
            <span className={`sync-tag ${input.integrations.teamsConfigured ? "ok" : "neutral"}`} style="margin-left:0">
              {input.integrations.teamsConfigured ? "Configured" : "Not Configured"}
            </span>
            Microsoft Teams
          </span>
          <span>
            <span className={`sync-tag ${input.integrations.whatsappConfigured ? "ok" : "neutral"}`} style="margin-left:0">
              {input.integrations.whatsappConfigured ? "Configured" : "Not Configured"}
            </span>
            WhatsApp Business
          </span>
        </div>
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}
