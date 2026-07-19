/**
 * Change Order pages — register, creation, detail with impact preview.
 *
 * Presentation only. A submitted change order changes nothing; the pages
 * repeat that on purpose. All actions post to the changeOrders service;
 * approval decisions go through the shared governed approvals endpoint.
 */
import { h, Fragment, VNode, renderDocument } from "./jsx";
import { icons } from "./icons";
import { AppShell, NavContext, PageHeader, fmtDate, money, roleLabel, Metric, EmptyStateV2, enumLabel, Methodology } from "./components";
import type {
  ApprovalRecord,
  ApprovalRequest,
  BudgetLine,
  ChangeOrder,
  ChangeOrderAllocation,
  ChangeOrderDocument,
  ChangeOrderEvent,
  ChangeOrderStatus,
  Milestone,
  Project,
  User,
} from "../../shared/types";
import type { ChangeOrderImpactPreview } from "../services/changeOrders";

const CO_STATUS_META: Record<ChangeOrderStatus, { label: string; tone: string }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "info" },
  UNDER_REVIEW: { label: "Under review", tone: "info" },
  CLARIFICATION_REQUIRED: { label: "Clarification required", tone: "warn" },
  APPROVED: { label: "Approved", tone: "ok" },
  PARTIALLY_APPROVED: { label: "Partially approved", tone: "warn" },
  REJECTED: { label: "Rejected", tone: "bad" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  IMPLEMENTED: { label: "Implemented", tone: "ok" },
};

export function CoStatusTag(props: { status: ChangeOrderStatus }): VNode {
  const m = CO_STATUS_META[props.status];
  return <span className={`sync-tag ${m.tone}`} style="margin-left:0">{m.label}</span>;
}

const REASONS = [
  "OWNER_REQUEST", "DESIGN_CHANGE", "SITE_CONDITION", "MATERIAL_CHANGE",
  "SCOPE_CHANGE", "REGULATORY", "SCHEDULE", "CORRECTION", "OTHER",
];

export interface CoRegisterRow {
  co: ChangeOrder;
  project: Project | null;
  ageDays: number;
  nextAction: string;
}

export function renderCoRegister(input: {
  nav: NavContext;
  rows: CoRegisterRow[];
  canCreate: boolean;
}): string {
  const open = input.rows.filter((r) =>
    ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED"].includes(r.co.status)
  );
  const approved = input.rows.filter((r) =>
    ["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(r.co.status)
  );
  return renderDocument(
    <AppShell title="Change Orders" nav={input.nav} context="Change Orders">
      <PageHeader
        title="Change Orders"
        sub="Governed construction change control. A submitted change order modifies nothing — only formal approval applies budget and schedule impact, transactionally and with an audited configuration snapshot."
      >
        {input.canCreate ? <a className="btn" href="/change-orders/new">Create Change Order</a> : null}
      </PageHeader>
      <div className="metric-strip">
        <Metric d={{ value: String(input.rows.length), label: "Change orders", sub: "All recorded change control", dim: input.rows.length === 0 }} />
        <Metric d={{ value: String(open.length), label: "In review", tone: open.length > 0 ? "warn" : undefined, sub: open.length > 0 ? "Submitted — nothing applied yet" : "Review queue clear", dim: open.length === 0 }} />
        <Metric d={{ value: String(approved.length), label: "Approved / implemented", sub: "Applied through formal approval only", dim: approved.length === 0 }} />
        <Metric d={{ value: money(approved.reduce((s, r) => s + (r.co.approvedAmount ?? 0), 0)), label: "Approved value", sub: "Approved amounts may differ from requested", dim: approved.length === 0 }} />
      </div>
      <div className="panel">
        <div className="panel-head">
          <h3>Change order register</h3>
          <span className="right">{input.rows.length} record(s)</span>
        </div>
        {input.rows.length === 0 ? (
          <EmptyStateV2
            icon={icons.refresh()}
            title="No change orders yet"
            what="Change orders run governed change control: a submitted request modifies nothing until formal approval applies the budget and schedule impact transactionally, with an audited configuration snapshot."
            condition="healthy"
            action={input.canCreate ? <a className="btn secondary sm" href="/change-orders/new">Create the first change order</a> : undefined}
          />
        ) : (
          <div className="intg-table-wrap">
            <table className="intg-table">
              <thead>
                <tr>
                  <th>CO #</th><th>Project</th><th>Title</th><th>Reason</th>
                  <th>Requested</th><th>Approved</th><th>Schedule</th>
                  <th>Status</th><th>Age</th><th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {input.rows.map((r) => (
                  <tr>
                    <td data-l="CO #">
                      <a href={`/change-order/${r.co.id}`} style="font-weight:600;color:var(--action)">
                        CO-{r.co.changeOrderNumber}
                      </a>
                    </td>
                    <td data-l="Project">{r.project?.name.slice(0, 24) ?? "—"}</td>
                    <td data-l="Title">{r.co.title.slice(0, 40)}</td>
                    <td data-l="Reason">{enumLabel(r.co.reasonCategory)}</td>
                    <td data-l="Requested" style="font-variant-numeric:tabular-nums">{money(r.co.requestedAmount)}</td>
                    <td data-l="Approved" style="font-variant-numeric:tabular-nums">{r.co.approvedAmount !== null ? money(r.co.approvedAmount) : "—"}</td>
                    <td data-l="Schedule">{r.co.scheduleImpactDays ? `+${r.co.scheduleImpactDays}d` : "—"}</td>
                    <td data-l="Status"><CoStatusTag status={r.co.status} /></td>
                    <td data-l="Age">{r.ageDays}d</td>
                    <td data-l="Next action" className="sub">{r.nextAction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

export function renderCoNew(input: {
  nav: NavContext;
  projects: Array<{ project: Project; milestones: Milestone[]; nextNumber: number }>;
}): string {
  const first = input.projects[0];
  return renderDocument(
    <AppShell title="Create Change Order" nav={input.nav} context="New Change Order">
      <PageHeader
        title="Create Change Order"
        sub="A draft change order documents a proposed change. Nothing changes until it is submitted, reviewed, and formally approved by the required roles."
        crumb={{ href: "/change-orders", label: "Change Orders" }}
      />
      <div className="work-grid">
      <div className="panel panel-pad">
        <form method="POST" action="/api/change-orders" className="fo-form">
          <label>Project
            <select name="projectId" required>
              {input.projects.map((p, i) => (
                <option value={p.project.id} selected={i === 0}>
                  {p.project.name} (next: CO-{p.nextNumber})
                </option>
              ))}
            </select>
          </label>
          <label>Title
            <input name="title" required maxlength="160" placeholder="e.g. Additional culvert at km 9+200" />
          </label>
          <label>Description
            <textarea name="description" rows="3" placeholder="What is changing and why"></textarea>
          </label>
          <div className="fo-row">
            <label>Reason
              <select name="reasonCategory">
                {REASONS.map((r) => (
                  <option value={r}>{r.replace(/_/g, " ").toLowerCase()}</option>
                ))}
              </select>
            </label>
            <label>Requested amount (±)
              <input name="requestedAmount" type="number" step="1" required placeholder="e.g. 120000" />
            </label>
            <label>Schedule impact (days)
              <input name="scheduleImpactDays" type="number" step="1" placeholder="optional" />
            </label>
          </div>
          <label>Affected milestone (optional)
            <select name="milestoneId">
              <option value="">None</option>
              {(first?.milestones ?? []).map((m) => (
                <option value={m.id}>M{m.seq} · {m.title.slice(0, 44)}</option>
              ))}
            </select>
          </label>
          <div style="display:flex;gap:8px">
            <button className="btn" type="submit">Create draft</button>
            <a className="btn ghost" href="/change-orders">Cancel</a>
          </div>
        </form>
      </div>
      <div>
        <Methodology title="What happens next">
          <p>
            The draft documents the proposed change, affected milestones and budget lines,
            and supporting documents. Review may approve a different amount than requested —
            partial approval is explicit — and nothing modifies the approved budget until
            formal approval applies it transactionally with an audited snapshot.
          </p>
        </Methodology>
      </div>
      </div>
    </AppShell>
  );
}

export interface CoDetailData {
  nav: NavContext;
  co: ChangeOrder;
  project: Project;
  requestedBy: User | null;
  allocations: Array<{ allocation: ChangeOrderAllocation; line: BudgetLine | null }>;
  budgetLines: BudgetLine[];
  documents: ChangeOrderDocument[];
  events: ChangeOrderEvent[];
  affectedMilestones: Milestone[];
  preview: ChangeOrderImpactPreview;
  approval: ApprovalRequest | null;
  approvalRecords: ApprovalRecord[];
  users: Map<string, User>;
  canManage: boolean;
  canGovern: boolean;
  canDecide: boolean;
  isSubmitter: boolean;
}

export function renderCoDetail(d: CoDetailData): string {
  const { co, preview } = d;
  const editable = ["DRAFT", "CLARIFICATION_REQUIRED"].includes(co.status) && d.canManage;
  const reviewable = ["SUBMITTED", "UNDER_REVIEW"].includes(co.status);
  const allocTotal = d.allocations.reduce((s, a) => s + a.allocation.amount, 0);
  const approvedRoles = new Set(
    d.approvalRecords.filter((r) => r.decision === "APPROVED").map((r) => r.role)
  );
  return renderDocument(
    <AppShell title={`CO-${co.changeOrderNumber}`} nav={d.nav} context={`CO-${co.changeOrderNumber} · ${co.title.slice(0, 40)}`}>
      <PageHeader
        title={`Change Order CO-${co.changeOrderNumber} — ${co.title}`}
        sub={`${d.project.name} · ${co.reasonCategory.replace(/_/g, " ").toLowerCase()} · requested by ${d.requestedBy?.name ?? "—"}`}
        crumb={{ href: "/change-orders", label: "Change Orders" }}
      >
        <CoStatusTag status={co.status} />
      </PageHeader>

      {/* ---- summary + financial/schedule impact preview ---- */}
      <div className="grid-2col">
        <div className="panel panel-pad">
          <h3 style="margin:0 0 8px;font-size:13px">Summary</h3>
          <p style="margin:0 0 10px;font-size:12.5px">{co.description || "No description."}</p>
          <dl className="ctx-kv" style="padding:0;grid-template-columns:150px 1fr">
            <dt>Requested amount</dt><dd>{money(co.requestedAmount)}</dd>
            <dt>Approved amount</dt><dd>{co.approvedAmount !== null ? money(co.approvedAmount) : "—"}</dd>
            <dt>Schedule impact</dt><dd>{co.scheduleImpactDays ? `+${co.scheduleImpactDays} day(s)` : "None"}</dd>
            <dt>Submitted</dt><dd>{co.requestedAt ? fmtDate(co.requestedAt) : "Not yet submitted"}</dd>
            <dt>Documents</dt><dd>{co.supportingDocumentCount} on file</dd>
            {co.appliedAt ? (
              <>
                <dt>Applied</dt>
                <dd>
                  {fmtDate(co.appliedAt)} — configuration snapshot v{co.appliedSnapshotVersion}
                  <span className="sub" style="display:block">
                    Audited and versioned; prior configuration history is preserved and historic
                    evidence keeps its original policy version.
                  </span>
                </dd>
              </>
            ) : null}
          </dl>
        </div>

        <div className="panel panel-pad">
          <h3 style="margin:0 0 8px;font-size:13px">
            Impact preview {co.appliedAt ? "" : <span className="sync-tag neutral">PREVIEW ONLY — nothing is changed until formal approval</span>}
          </h3>
          <dl className="ctx-kv" style="padding:0;grid-template-columns:190px 1fr">
            <dt>Current project budget</dt><dd>{money(preview.currentProjectBudget)}</dd>
            <dt>Requested change</dt><dd>{co.requestedAmount >= 0 ? "+" : ""}{money(co.requestedAmount)}</dd>
            <dt>Projected revised budget</dt><dd><b>{money(preview.projectedRevisedBudget)}</b></dd>
            <dt>Current completion date</dt><dd>{preview.currentCompletionDate ?? "—"}</dd>
            <dt>Schedule impact</dt><dd>{preview.scheduleImpactDays ? `+${preview.scheduleImpactDays} day(s)` : "None"}</dd>
            <dt>Projected completion</dt><dd>{preview.projectedRevisedCompletion ?? "—"}</dd>
          </dl>
          {preview.affectedMilestones.length > 0 ? (
            <>
              <h4 style="margin:10px 0 4px;font-size:12px;color:var(--ink-3)">Affected milestones</h4>
              <ul style="margin:0;padding:0;list-style:none;font-size:12px">
                {preview.affectedMilestones.map((m) => (
                  <li style="padding:3px 0;border-bottom:1px solid var(--line)">
                    {m.label} — planned end {m.plannedEnd ?? "—"}
                    {m.projectedEnd && m.projectedEnd !== m.plannedEnd ? ` → ${m.projectedEnd}` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {preview.affectedBudgetLines.length > 0 ? (
            <>
              <h4 style="margin:10px 0 4px;font-size:12px;color:var(--ink-3)">Affected budget lines</h4>
              <ul style="margin:0;padding:0;list-style:none;font-size:12px">
                {preview.affectedBudgetLines.map((l) => (
                  <li style="padding:3px 0;border-bottom:1px solid var(--line)">
                    {l.code} {l.category}: {money(l.currentBudget)} {l.allocation >= 0 ? "+" : ""}{money(l.allocation)} → <b>{money(l.projectedBudget)}</b>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      {/* ---- allocations / affected scope ---- */}
      <div className="panel" style="margin-top:12px">
        <div className="panel-head">
          <h3>Budget allocations</h3>
          <span className="right" style={allocTotal === co.requestedAmount ? "color:var(--ok)" : "color:var(--warn)"}>
            {money(allocTotal)} allocated / {money(co.requestedAmount)} requested
            {allocTotal === co.requestedAmount ? " · reconciled" : ""}
          </span>
        </div>
        {d.allocations.length === 0 ? (
          <p className="sub" style="padding:14px 16px">No allocations yet — allocations must reconcile to the requested amount before submission.</p>
        ) : (
          <div className="intg-table-wrap">
            <table className="intg-table">
              <thead><tr><th>Budget line</th><th>Amount</th><th>Note</th></tr></thead>
              <tbody>
                {d.allocations.map((a) => (
                  <tr>
                    <td data-l="Line">{a.line ? `${a.line.code} · ${a.line.category}` : a.allocation.budgetLineId}</td>
                    <td data-l="Amount" style="font-variant-numeric:tabular-nums">{money(a.allocation.amount)}</td>
                    <td data-l="Note" className="sub">{a.allocation.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editable ? (
          <form method="POST" action={`/api/change-orders/${co.id}/allocations`} className="fo-form" style="padding:12px 16px;border-top:1px solid var(--line)">
            <div className="fo-row">
              <label>Budget line
                <select name="budgetLineId" required>
                  {d.budgetLines.map((l) => (
                    <option value={l.id}>{l.code} · {l.category}</option>
                  ))}
                </select>
              </label>
              <label>Amount (±)
                <input name="amount" type="number" step="1" required />
              </label>
              <label>Note
                <input name="note" placeholder="optional" />
              </label>
            </div>
            <button className="btn sm" type="submit">Add allocation</button>
          </form>
        ) : null}
      </div>

      {/* ---- documents ---- */}
      <div className="grid-2col" style="margin-top:12px">
        <div className="panel panel-pad">
          <h3 style="margin:0 0 8px;font-size:13px">Supporting documents</h3>
          {d.documents.length === 0 ? (
            <p className="sub" style="margin:0 0 10px">None recorded.</p>
          ) : (
            <ul style="margin:0 0 10px;padding:0;list-style:none;font-size:12px">
              {d.documents.map((doc) => (
                <li style="padding:3px 0;border-bottom:1px solid var(--line)">
                  <b>{doc.title}</b> <span className="sub">({doc.docType.toLowerCase()}) · {d.users.get(doc.uploadedByUserId)?.name}</span>
                  {doc.note ? <span className="sub" style="display:block">{doc.note}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {(editable || reviewable) && d.canManage ? (
            <form method="POST" action={`/api/change-orders/${co.id}/documents`} className="fo-form">
              <div className="fo-row">
                <label>Title
                  <input name="title" required placeholder="e.g. Engineer's estimate" />
                </label>
                <label>Type
                  <input name="docType" placeholder="e.g. ESTIMATE" />
                </label>
              </div>
              <button className="btn ghost sm" type="submit">Record document</button>
            </form>
          ) : null}
        </div>

        {/* ---- workflow actions ---- */}
        <div className="panel panel-pad">
          <h3 style="margin:0 0 8px;font-size:13px">Workflow</h3>
          <div style="display:flex;flex-direction:column;gap:8px">
            {editable ? (
              <form method="POST" action={`/api/change-orders/${co.id}/submit`}>
                <button className="btn" type="submit">Submit change order</button>
              </form>
            ) : null}
            {reviewable && d.canGovern ? (
              <form method="POST" action={`/api/change-orders/${co.id}/governance`} style="display:flex;gap:6px;align-items:center">
                <input name="approvedAmount" type="number" step="1" placeholder={`Approved amount (default ${co.requestedAmount})`} style="flex:1" />
                <button className="btn sm" type="submit">Send to formal approval</button>
              </form>
            ) : null}
            {reviewable && d.canGovern ? (
              <form method="POST" action={`/api/change-orders/${co.id}/clarification`} style="display:flex;gap:6px;align-items:center">
                <input name="question" placeholder="Request clarification" style="flex:1" required />
                <button className="btn ghost sm" type="submit">Request</button>
              </form>
            ) : null}
            {["APPROVED", "PARTIALLY_APPROVED"].includes(co.status) && d.canManage ? (
              <form method="POST" action={`/api/change-orders/${co.id}/implemented`} style="display:flex;gap:6px;align-items:center">
                <input name="note" placeholder="Implementation note (optional)" style="flex:1" />
                <button className="btn sm" type="submit">Mark implemented</button>
              </form>
            ) : null}
            {["DRAFT", "SUBMITTED", "CLARIFICATION_REQUIRED"].includes(co.status) && d.canManage ? (
              <form method="POST" action={`/api/change-orders/${co.id}/cancel`}>
                <button className="btn ghost sm" type="submit">Cancel change order</button>
              </form>
            ) : null}
          </div>
          <p className="sub" style="margin:12px 0 0;font-size:11px">
            A submitted change order does not modify budget or milestone configuration. Only formal
            approval by every required role applies the impact — transactionally, audited, with a new
            configuration snapshot version linked here. There is no direct state-edit endpoint.
          </p>
        </div>
      </div>

      {/* ---- governance ---- */}
      <div className="panel panel-pad" style="margin-top:12px">
        <h3 style="margin:0 0 8px;font-size:13px">Formal approval — the only path that applies this change</h3>
        {!d.approval ? (
          <p className="sub" style="margin:0">No approval request yet. A reviewer opens governance from the workflow panel.</p>
        ) : (
          <>
            <dl className="ctx-kv" style="padding:0;grid-template-columns:170px 1fr">
              <dt>Required roles</dt><dd>{d.approval.requiredRoles.map((r) => roleLabel(r)).join(" + ")}</dd>
              <dt>Status</dt>
              <dd>
                {d.approval.status === "PENDING"
                  ? `${approvedRoles.size} of ${d.approval.requiredRoles.length} approvals recorded — configuration unchanged`
                  : d.approval.status}
              </dd>
            </dl>
            <ul className="activity" style="margin-top:8px">
              {d.approval.requiredRoles.map((role) => {
                const record = d.approvalRecords.find((r) => r.role === role);
                return (
                  <li>
                    <span className={`ico ${record ? (record.decision === "APPROVED" ? "ok" : "bad") : "warn"}`}>
                      {record ? (record.decision === "APPROVED" ? icons.check() : icons.x()) : icons.clock()}
                    </span>
                    <span className="body">
                      <span className="msg">
                        <b>{roleLabel(role)}</b>{" "}
                        {record ? `${record.decision.toLowerCase()} by ${d.users.get(record.userId)?.name ?? "—"}` : "decision pending"}
                      </span>
                      {record ? <span className="meta"><span className="when">{fmtDate(record.createdAt)}</span></span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            {d.canDecide && d.approval.status === "PENDING" ? (
              <form method="POST" action={`/api/approvals/${d.approval.id}/decision`} style="display:flex;gap:8px;margin-top:10px">
                <input type="hidden" name="redirect" value={`/change-order/${co.id}`} />
                <button className="btn" name="decision" value="APPROVED" type="submit">Approve change order</button>
                <button className="btn ghost" name="decision" value="REJECTED" type="submit">Reject</button>
              </form>
            ) : null}
            {d.isSubmitter && d.approval.status === "PENDING" ? (
              <p className="sub" style="margin:10px 0 0;font-size:11.5px">
                Separation of duties: as the submitter you cannot approve this change order.
              </p>
            ) : null}
          </>
        )}
      </div>

      {/* ---- activity ---- */}
      <div className="panel" style="margin-top:12px">
        <div className="panel-head">
          <h3>Change order activity</h3>
          <span className="right">Operational record — NOT the Evidence Ledger</span>
        </div>
        <ul className="activity">
          {[...d.events].reverse().map((e) => (
            <li>
              <span className={`ico ${e.type === "APPLIED" || e.type === "IMPLEMENTED" ? "ok" : ["REJECTED", "CANCELLED"].includes(e.type) ? "bad" : "warn"}`}>
                {icons.activity()}
              </span>
              <span className="body">
                <span className="msg">{e.detail}</span>
                <span className="meta">
                  <span className="when">{fmtDate(e.createdAt)}</span>
                  {e.actorUserId ? <span>{d.users.get(e.actorUserId)?.name}</span> : null}
                  <span>{e.type.replace(/_/g, " ").toLowerCase()}</span>
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
