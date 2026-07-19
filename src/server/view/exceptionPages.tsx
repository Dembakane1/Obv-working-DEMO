/**
 * Unified Exception register + detail pages.
 *
 * Presentation only. Every action posts to the exceptions service, which
 * enforces source-aware resolution, waiver authorization and audit. No
 * control on these pages can release money or change any source record —
 * the source panels link out to the authoritative records instead.
 */
import { h, Fragment, VNode, renderDocument } from "./jsx";
import { icons } from "./icons";
import {
  AppShell,
  NavContext,
  PageHeader,
  fmtDate,
  roleLabel,
  Metric,
  EmptyStateV2,
  enumLabel,
} from "./components";
import type {
  ExceptionEvent,
  ExceptionSlaState,
  ExceptionStatus,
  Milestone,
  ObvException,
  Project,
  User,
} from "../../shared/types";
import type { RULES } from "../services/exceptions";

export const EXC_SEVERITY_TONE: Record<string, string> = {
  LOW: "neutral", MEDIUM: "warn", HIGH: "warn", CRITICAL: "bad",
};
const STATUS_TONE: Record<ExceptionStatus, string> = {
  OPEN: "warn", ACKNOWLEDGED: "warn", IN_PROGRESS: "info",
  AWAITING_RESPONSE: "warn", RESOLVED: "ok", CLOSED: "neutral", WAIVED: "neutral",
};
const SLA_META: Record<ExceptionSlaState, { label: string; tone: string }> = {
  WITHIN_TARGET: { label: "Within target", tone: "ok" },
  DUE_SOON: { label: "Due soon", tone: "warn" },
  OVERDUE: { label: "Overdue", tone: "bad" },
  NO_TARGET: { label: "—", tone: "neutral" },
};

export function ExcStatusTag(props: { status: ExceptionStatus }): VNode {
  return (
    <span className={`sync-tag ${STATUS_TONE[props.status]}`} style="margin-left:0">
      {enumLabel(props.status)}
    </span>
  );
}
export function SlaTag(props: { state: ExceptionSlaState }): VNode {
  const m = SLA_META[props.state];
  return m.label === "—" ? <span className="sub">—</span> : (
    <span className={`sync-tag ${m.tone}`} style="margin-left:0">{m.label}</span>
  );
}

export interface ExceptionRow {
  exception: ObvException;
  project: Project | null;
  milestone: Milestone | null;
  drawNumber: number | null;
  owner: User | null;
  ageDays: number;
  sla: ExceptionSlaState;
  nextAction: string;
}

export interface ExceptionFilters {
  severity: string;
  category: string;
  project: string;
  owner: string;
  status: string;
  sourceType: string;
  overdue: string;
}

export function renderExceptionRegister(input: {
  nav: NavContext;
  rows: ExceptionRow[];
  allRows: ExceptionRow[];
  filters: ExceptionFilters;
  projects: Project[];
  users: User[];
  rules: typeof RULES;
  canManage: boolean;
}): string {
  const open = input.allRows.filter((r) => ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"].includes(r.exception.status));
  const highCrit = open.filter((r) => ["HIGH", "CRITICAL"].includes(r.exception.severity));
  const overdue = open.filter((r) => r.sla === "OVERDUE");
  const awaiting = open.filter((r) => r.exception.status === "AWAITING_RESPONSE");
  const f = input.filters;
  const opt = (value: string, label: string, current: string) => (
    <option value={value} selected={current === value}>{label}</option>
  );
  return renderDocument(
    <AppShell title="Exceptions" nav={input.nav} context="Exceptions">
      <PageHeader
        title="Exceptions"
        sub="One governed register for anything preventing clean progression. Every exception references an authoritative source record — the source stays the truth, and no exception action can release funds."
      />
      <div className="metric-strip">
        <Metric d={{ value: String(open.length), label: "Open exceptions", sub: open.length > 0 ? "Preventing clean progression" : "Nothing open", dim: open.length === 0 }} />
        <Metric d={{ value: String(highCrit.length), label: "High / critical", tone: highCrit.length > 0 ? "bad" : undefined, edge: highCrit.length > 0 ? "bad" : undefined, sub: highCrit.length > 0 ? "One-day SLA target" : "None recorded", dim: highCrit.length === 0 }} />
        <Metric d={{ value: String(overdue.length), label: "Past SLA target", tone: overdue.length > 0 ? "warn" : undefined, edge: overdue.length > 0 ? "warn" : undefined, sub: overdue.length > 0 ? "Operational target, not a certification" : "All within target", dim: overdue.length === 0 }} />
        <Metric d={{ value: String(awaiting.length), label: "Awaiting response", sub: awaiting.length > 0 ? "Blocked on a named owner" : "No responses pending", dim: awaiting.length === 0 }} />
        <Metric d={{ value: String(input.allRows.length - open.length), label: "Resolved / closed / waived", sub: "Source truth is never rewritten", dim: input.allRows.length - open.length === 0 }} />
      </div>

      <form method="GET" action="/exceptions" className="panel panel-pad filter-grid">
        <label className="f-lab">Severity
          <select name="severity" style="display:block">
            {opt("", "All", f.severity)}
            {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((v) => opt(v, enumLabel(v), f.severity))}
          </select>
        </label>
        <label className="f-lab">Category
          <select name="category" style="display:block">
            {opt("", "All", f.category)}
            {["EVIDENCE","DOCUMENT","LOCATION","METADATA","QUALITY","MATERIAL","COST","SCHEDULE","APPROVAL","CLARIFICATION","INTEGRITY","INTEGRATION","OTHER"].map((v) => opt(v, enumLabel(v), f.category))}
          </select>
        </label>
        <label className="f-lab">Project
          <select name="project" style="display:block">
            {opt("", "All", f.project)}
            {input.projects.map((p) => opt(p.id, p.name.slice(0, 32), f.project))}
          </select>
        </label>
        <label className="f-lab">Owner
          <select name="owner" style="display:block">
            {opt("", "All", f.owner)}
            {opt("unassigned", "Unassigned", f.owner)}
            {input.users.map((u) => opt(u.id, u.name, f.owner))}
          </select>
        </label>
        <label className="f-lab">Status
          <select name="status" style="display:block">
            {opt("", "Open (default)", f.status)}
            {opt("all", "All", f.status)}
            {["OPEN","ACKNOWLEDGED","IN_PROGRESS","AWAITING_RESPONSE","RESOLVED","CLOSED","WAIVED"].map((v) => opt(v, enumLabel(v), f.status))}
          </select>
        </label>
        <label className="f-lab">Source
          <select name="sourceType" style="display:block">
            {opt("", "All", f.sourceType)}
            {["EVIDENCE_VERIFICATION","DRAW_DOCUMENT","BUDGET_VARIANCE","FIELD_ISSUE","CLARIFICATION","APPROVAL_REQUEST","LEDGER_INTEGRITY","INTEGRATION","MANUAL"].map((v) => opt(v, enumLabel(v), f.sourceType))}
          </select>
        </label>
        <label className="f-lab f-check">
          <input type="checkbox" name="overdue" value="1" checked={f.overdue === "1"} style="width:auto" /> Overdue only
        </label>
        <button className="btn ghost sm" type="submit">Filter</button>
      </form>

      <div className="panel">
        <div className="panel-head">
          <h3>Exception register</h3>
          <span className="right">{input.rows.length} shown</span>
        </div>
        {input.rows.length === 0 ? (
          <EmptyStateV2
            icon={icons.shield()}
            title="No exceptions match"
            what="Exceptions are created deterministically from source records (evidence verification, draw documents, budget variance, field issues, clarifications, approvals, ledger integrity, integrations). None match the current filters."
            condition="healthy"
            action={<a className="btn secondary sm" href="/exceptions">Reset to open exceptions</a>}
          />
        ) : (
          <div className="intg-table-wrap">
            <table className="intg-table">
              <thead>
                <tr>
                  <th>Severity</th><th>Exception</th><th>Project</th><th>Milestone / Draw</th>
                  <th>Category</th><th>Owner</th><th>Age</th><th>Due</th><th>Status</th><th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {input.rows.map((r) => (
                  <tr>
                    <td data-l="Severity">
                      <span className={`sync-tag ${EXC_SEVERITY_TONE[r.exception.severity]}`} style="margin-left:0">{enumLabel(r.exception.severity)}</span>
                    </td>
                    <td data-l="Exception">
                      <a href={`/exception/${r.exception.id}`} style="font-weight:600;color:var(--action)">{r.exception.title}</a>
                      <span className="sub" style="display:block">{enumLabel(r.exception.sourceType)}</span>
                    </td>
                    <td data-l="Project">{r.project?.name.slice(0, 26) ?? "—"}</td>
                    <td data-l="Context">
                      {r.milestone ? `M${r.milestone.seq}` : r.drawNumber !== null ? `Draw #${r.drawNumber}` : "Project"}
                    </td>
                    <td data-l="Category">{enumLabel(r.exception.category)}</td>
                    <td data-l="Owner">{r.owner?.name ?? "—"}</td>
                    <td data-l="Age">{r.ageDays}d</td>
                    <td data-l="Due"><SlaTag state={r.sla} /></td>
                    <td data-l="Status"><ExcStatusTag status={r.exception.status} /></td>
                    <td data-l="Next action" className="sub">{r.nextAction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <details style="margin:12px 2px">
        <summary style="font-size:11.5px;color:var(--ink-3);cursor:pointer">Deterministic auto-creation rules ({input.rules.length})</summary>
        <ul style="margin:8px 0 0;padding-left:18px;font-size:11.5px;color:var(--ink-2)">
          {input.rules.map((r) => (
            <li style="margin:2px 0"><b>{r.key}</b> ({enumLabel(r.severity)}) — {r.rule}</li>
          ))}
        </ul>
        <p className="sub" style="font-size:10.5px;margin:6px 0 0">
          Rules are idempotent: repeated evaluation never duplicates an exception, source-cleared
          conditions auto-resolve, and recurring conditions reopen. SLA targets (High/Critical 1 day,
          Medium 3, Low 7 — configurable) drive the within-target / due-soon / overdue display; they
          are operational targets, not compliance certifications.
        </p>
      </details>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

export interface ExceptionDetailData {
  nav: NavContext;
  exception: ObvException;
  project: Project;
  milestone: Milestone | null;
  drawNumber: number | null;
  owner: User | null;
  users: User[];
  usersById: Map<string, User>;
  events: ExceptionEvent[];
  sla: ExceptionSlaState;
  ageDays: number;
  source: { label: string; href: string; latitude: number | null; longitude: number | null };
  sourceActive: boolean;
  canManage: boolean;
  canWaive: boolean;
  currentUser: User;
}

export function renderExceptionDetail(d: ExceptionDetailData): string {
  const e = d.exception;
  const open = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_RESPONSE"].includes(e.status);
  const act = (action: string, label: string, cls = "btn ghost sm", extra?: VNode) => (
    <form method="POST" action={`/api/exceptions/${e.id}/${action}`} style="display:flex;gap:6px;align-items:center">
      {extra ?? null}
      <button className={cls} type="submit">{label}</button>
    </form>
  );
  return renderDocument(
    <AppShell title={e.title} nav={d.nav} context={`Exception · ${e.title.slice(0, 44)}`}>
      <PageHeader
        title={e.title}
        sub={`${d.project.name}${d.milestone ? ` · M${d.milestone.seq} ${d.milestone.title.slice(0, 40)}` : ""}${d.drawNumber !== null ? ` · Draw #${d.drawNumber}` : ""}`}
        crumb={{ href: "/exceptions", label: "Exceptions" }}
      >
        <span className={`sync-tag ${EXC_SEVERITY_TONE[e.severity]}`}>{e.severity}</span>
        <ExcStatusTag status={e.status} />
        <SlaTag state={d.sla} />
      </PageHeader>

      <div className="grid-2col">
        <div className="panel panel-pad">
          <h3 style="margin:0 0 8px;font-size:13px">Why this exception exists</h3>
          <p style="margin:0 0 10px;font-size:12.5px">{e.description}</p>
          <dl className="ctx-kv" style="padding:0;grid-template-columns:130px 1fr">
            <dt>Source record</dt>
            <dd>
              <a href={d.source.href} style="color:var(--action);font-weight:600">{d.source.label} →</a>
              <span className="sub" style="display:block">
                The source record remains authoritative — this exception tracks the operational
                response and never rewrites it.
              </span>
            </dd>
            <dt>Source state</dt>
            <dd>
              {e.sourceType === "MANUAL"
                ? "Manually raised (human judgment governs resolution)"
                : d.sourceActive
                  ? "Condition still holds — resolution is blocked until the source clears"
                  : "Condition no longer holds"}
            </dd>
            <dt>Category</dt><dd>{e.category} · {e.sourceType.replace(/_/g, " ").toLowerCase()}</dd>
            <dt>Opened</dt><dd>{fmtDate(e.openedAt)} ({d.ageDays}d ago)</dd>
            <dt>Owner</dt><dd>{d.owner?.name ?? "Unassigned"}</dd>
            <dt>Due</dt><dd>{e.dueAt ? fmtDate(e.dueAt) : "—"} <SlaTag state={d.sla} /></dd>
            {d.source.latitude !== null ? (
              <>
                <dt>Location</dt>
                <dd>
                  {d.source.latitude.toFixed(5)}, {d.source.longitude!.toFixed(5)}{" "}
                  <a href="/map" style="color:var(--action);font-weight:600">View on map</a>{" "}
                  <span className="sub">(shown through the source layer)</span>
                </dd>
              </>
            ) : null}
            {e.resolutionSummary ? (
              <>
                <dt>{e.status === "WAIVED" ? "Waiver reason" : "Resolution"}</dt>
                <dd>{e.resolutionSummary}{e.resolutionType ? ` (${e.resolutionType.replace(/_/g, " ").toLowerCase()})` : ""}</dd>
              </>
            ) : null}
          </dl>
          <p style="margin:12px 0 0;font-size:11.5px" className="sub">
            <a href={`/communications`} style="color:var(--action)">Project discussion</a> — chat
            coordinates only; a message cannot resolve an exception. Formal actions happen here.
          </p>
        </div>

        <div className="panel panel-pad">
          <h3 style="margin:0 0 8px;font-size:13px">Actions</h3>
          {!d.canManage ? (
            <p className="sub" style="margin:0">Your role can view this exception but not act on it.</p>
          ) : (
            <div style="display:flex;flex-direction:column;gap:8px">
              {e.status === "OPEN" ? act("acknowledge", "Acknowledge", "btn sm") : null}
              {open ? (
                <form method="POST" action={`/api/exceptions/${e.id}/assign`} style="display:flex;gap:6px;align-items:center">
                  <select name="ownerUserId" style="flex:1">
                    <option value="">Unassigned</option>
                    {d.users.filter((u) => u.role !== "FIELD").map((u) => (
                      <option value={u.id} selected={e.ownerUserId === u.id}>{u.name} — {roleLabel(u.role)}</option>
                    ))}
                  </select>
                  <button className="btn ghost sm" type="submit">Assign</button>
                </form>
              ) : null}
              {["OPEN", "ACKNOWLEDGED", "AWAITING_RESPONSE"].includes(e.status) ? act("start", "Start work") : null}
              {open ? (
                <form method="POST" action={`/api/exceptions/${e.id}/request-response`} style="display:flex;gap:6px;align-items:center">
                  <input name="note" placeholder="What response is needed?" style="flex:1" required />
                  <button className="btn ghost sm" type="submit">Request response</button>
                </form>
              ) : null}
              {open ? (
                <form method="POST" action={`/api/exceptions/${e.id}/resolve`} style="display:flex;gap:6px;align-items:center">
                  <input name="summary" placeholder="Resolution note (optional)" style="flex:1" />
                  <button className="btn sm" type="submit" disabled={d.sourceActive && e.sourceType !== "MANUAL"}>Resolve</button>
                </form>
              ) : null}
              {d.sourceActive && open && e.sourceType !== "MANUAL" ? (
                <p className="sub" style="margin:0;font-size:11px">
                  Resolve is blocked: the authoritative source still shows this condition. Clear the
                  source (new verified evidence, accepted document, completed approval…) or record a
                  formal waiver.
                </p>
              ) : null}
              {["RESOLVED", "WAIVED"].includes(e.status) ? act("close", "Close", "btn sm") : null}
              {open ? (
                d.canWaive ? (
                  <form method="POST" action={`/api/exceptions/${e.id}/waive`} style="display:flex;gap:6px;align-items:center">
                    <input name="reason" placeholder="Waiver reason (required, audited)" style="flex:1" required />
                    <button className="btn ghost sm" type="submit">Waive</button>
                  </form>
                ) : (
                  <p className="sub" style="margin:0;font-size:11px">
                    Waiving requires {e.category === "INTEGRITY" ? "a compliance reviewer" : "a lender review role"}.
                  </p>
                )
              ) : null}
              {open ? (
                <form method="POST" action={`/api/exceptions/${e.id}/comment`} style="display:flex;gap:6px;align-items:center">
                  <input name="note" placeholder="Add a timeline comment" style="flex:1" required />
                  <button className="btn ghost sm" type="submit">Comment</button>
                </form>
              ) : null}
              {act("reference", "Reference in project discussion")}
            </div>
          )}
          <p className="sub" style="margin:12px 0 0;font-size:11px">
            No exception action releases money or changes evidence, verification, approvals, or the
            ledger. A waiver records a control decision about this exception only — the source
            record is untouched.
          </p>
        </div>
      </div>

      <div className="panel" style="margin-top:12px">
        <div className="panel-head">
          <h3>Exception timeline</h3>
          <span className="right">Operational record — NOT the Evidence Ledger</span>
        </div>
        <ul className="activity">
          {[...d.events].reverse().map((ev) => (
            <li>
              <span className={`ico ${ev.type === "RESOLVED" || ev.type === "CLOSED" ? "ok" : ev.type === "WAIVED" || ev.type === "REOPENED" ? "bad" : "warn"}`}>
                {icons.activity()}
              </span>
              <span className="body">
                <span className="msg">{ev.detail}</span>
                <span className="meta">
                  <span className="when">{fmtDate(ev.createdAt)}</span>
                  {ev.actorUserId ? <span>{d.usersById.get(ev.actorUserId)?.name}</span> : <span>system</span>}
                  <span>{ev.type.replace(/_/g, " ").toLowerCase()}</span>
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}
