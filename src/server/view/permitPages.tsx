/**
 * Project Permit Register — first-class permit records, code basis, and
 * open inspection conditions. Read/record surface only: nothing here can
 * verify work, pass inspections, approve, or release funds.
 */
import { h, Fragment, renderDocument, VNode } from "./jsx";
import { AppShell, NavContext, PageHeader, fmtDate } from "./components";
import { METHODOLOGY_NOTE, PermitRegisterRow } from "../services/permits";
import type { Milestone, Project, User } from "../../shared/types";

const PERMIT_STATUSES = [
  "DRAFT", "APPLIED", "ISSUED", "ACTIVE", "SUSPENDED", "EXPIRED", "CLOSED", "REVOKED", "UNKNOWN",
];

function statusTone(s: string): string {
  if (s === "ACTIVE" || s === "ISSUED") return "ok";
  if (["EXPIRED", "REVOKED", "SUSPENDED"].includes(s)) return "bad";
  if (s === "CLOSED") return "neutral";
  return "warn";
}

export function renderPermitRegister(input: {
  nav: NavContext;
  project: Project;
  rows: PermitRegisterRow[];
  milestones: Milestone[];
  filters: { status?: string; type?: string; authority?: string; milestone?: string; expiration?: string };
  canRecord: boolean;
  canDetermine: boolean;
  types: string[];
  authorities: string[];
}): string {
  const { project, filters } = input;
  const base = `/project/${project.id}/permits`;
  const sel = (name: string, current: string | undefined, options: Array<[string, string]>): VNode => (
    <label style="display:flex;flex-direction:column;gap:3px;font:550 12px/1.2 var(--sans,inherit);color:var(--muted)">
      {name}
      <select name={name.toLowerCase()} style="font-size:12px;padding:5px 8px;border:1px solid var(--line-2);border-radius:6px">
        <option value="">All</option>
        {options.map(([v, l]) => (
          <option value={v} selected={current === v ? true : undefined}>{l}</option>
        ))}
      </select>
    </label>
  );
  return renderDocument(
    <AppShell title="Permit Register" nav={input.nav} context={`${project.name} · Permits`}>
      <div className="page-wrap">
        <PageHeader
          title="Permit Register"
          sub={`${project.name} — permits, applicable code basis, and open inspection conditions.`}
          crumb={{ href: `/project/${project.id}`, label: project.name }}
        />

        <form method="GET" action={base} style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:0 0 12px">
          {sel("Status", filters.status, PERMIT_STATUSES.map((x) => [x, x]))}
          {sel("Type", filters.type, input.types.map((x) => [x, x]))}
          {sel("Authority", filters.authority, input.authorities.map((x) => [x, x]))}
          {sel("Milestone", filters.milestone, input.milestones.map((m) => [m.id, `M${m.seq}`]))}
          {sel("Expiration", filters.expiration, [["expired", "Expired"], ["active", "Not expired"]])}
          <button className="btn secondary sm" type="submit">Apply filters</button>
        </form>

        <div className="panel">
          <div className="panel-head">
            <h3>Permits</h3>
            <span className="right">{input.rows.length} record(s)</span>
          </div>
          {input.rows.length === 0 ? (
            <p style="padding:14px 16px;margin:0;font-size:12.5px;color:var(--muted)">
              No permit records match. Infrastructure projects with no permit regime record
              NOT_REQUIRED on the milestone inspection requirement with an attributable basis —
              no permit is invented.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="intg-table">
                <thead>
                  <tr>
                    <th>Permit</th><th>Type</th><th>Authority</th><th>Jurisdiction</th><th>Status</th>
                    <th>Code edition</th><th>Effective</th><th>Expires</th><th>Milestones</th>
                    <th>Open condition</th><th>Next action</th>
                  </tr>
                </thead>
                <tbody>
                  {input.rows.map((r) => (
                    <tr>
                      <td data-l="Permit" style="font-weight:650">{r.permit.permitNumber}
                        {r.permit.legacyReference ? <span className="sub" style="display:block;font-size:10px">legacy ref: {r.permit.legacyReference}</span> : null}
                      </td>
                      <td data-l="Type">{r.permit.permitType}</td>
                      <td data-l="Authority">{r.permit.issuingAuthority ?? "—"}</td>
                      <td data-l="Jurisdiction">{r.permit.jurisdiction ?? "—"}</td>
                      <td data-l="Status">
                        <span className={`sync-tag ${statusTone(r.effectiveStatus)}`} style="margin-left:0">{r.effectiveStatus}</span>
                        {r.effectiveStatus !== r.permit.status ? (
                          <span className="sub" style="display:block;font-size:10px">recorded: {r.permit.status}</span>
                        ) : null}
                      </td>
                      <td data-l="Code edition" style="font-size:12px">
                        {r.permit.applicableCodeEdition ?? "NOT RECORDED"}
                        {r.permit.codeBasis ? <span className="sub" style="display:block;font-size:10px">{r.permit.codeBasis}</span> : null}
                      </td>
                      <td data-l="Effective" className="mono" style="font-size:11px">{r.permit.effectiveAt?.slice(0, 10) ?? r.permit.issuedAt?.slice(0, 10) ?? "—"}</td>
                      <td data-l="Expires" className="mono" style="font-size:11px">{r.permit.expiresAt?.slice(0, 10) ?? "—"}</td>
                      <td data-l="Milestones">
                        {r.linkedMilestones.length
                          ? r.linkedMilestones.map((m) => (
                              <a href={`/milestone/${m.milestoneId}`} style="margin-right:6px">{m.label}</a>
                            ))
                          : "—"}
                      </td>
                      <td data-l="Open condition">{r.openInspectionCondition ? r.openInspectionCondition.replace(/_/g, " ") : "—"}</td>
                      <td data-l="Next action" style="font-size:11.5px">{r.nextAction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {input.canRecord ? (
          <div className="panel" style="margin-top:12px">
            <div className="panel-head"><h3>Record a permit</h3><span className="right">Attributable record — never a compliance certification</span></div>
            <form method="POST" action={`/api/projects/${project.id}/permits`} className="fo-form" style="padding:12px 16px">
              <div className="fo-row">
                <label>Permit number<input name="permitNumber" required maxlength="80" placeholder="e.g. DOB-2026-01881" /></label>
                <label>Type<input name="permitType" required maxlength="60" placeholder="e.g. BUILDING / ELECTRICAL" /></label>
                <label>Issuing authority<input name="issuingAuthority" maxlength="120" /></label>
                <label>Jurisdiction<input name="jurisdiction" maxlength="120" /></label>
              </div>
              <div className="fo-row">
                <label>Status
                  <select name="status">{PERMIT_STATUSES.map((x) => <option value={x} selected={x === "UNKNOWN" ? true : undefined}>{x}</option>)}</select>
                </label>
                <label>Issued<input name="issuedAt" type="date" /></label>
                <label>Effective<input name="effectiveAt" type="date" /></label>
                <label>Expires<input name="expiresAt" type="date" /></label>
              </div>
              {input.canDetermine ? (
                <div className="fo-row">
                  <label>Applicable code edition<input name="applicableCodeEdition" maxlength="120" placeholder="e.g. 2021 International Building Code" /></label>
                  <label>Code effective date<input name="codeEffectiveDate" type="date" /></label>
                  <label style="flex:2">Code basis / adoption reference<input name="codeBasis" maxlength="240" placeholder="e.g. DC Construction Codes Supplement (2022)" /></label>
                </div>
              ) : null}
              <div className="fo-row">
                <label>Official record #<input name="officialRecordNumber" maxlength="120" /></label>
                <label style="flex:2">Official record URL<input name="officialRecordUrl" maxlength="300" placeholder="A URL is a reference, not verified evidence" /></label>
                <label>Scope<input name="scopeDescription" maxlength="240" /></label>
              </div>
              <button className="btn sm" type="submit" style="align-self:flex-start">Record permit</button>
            </form>
          </div>
        ) : null}

        <p className="footer-note">{METHODOLOGY_NOTE}</p>
      </div>
    </AppShell>
  );
}
