/**
 * Construction Draw Request pages — lender-native review workspace.
 *
 * Presentation layer only. Every action posts to a governed API route;
 * nothing rendered here can change financial state directly. The pages
 * repeat the doctrine on purpose: a draw request asks for review, a
 * recommendation advises, and only the formal approval workflow creates
 * release eligibility.
 */
import { h, Fragment, VNode, renderDocument, raw } from "./jsx";
import { icons } from "./icons";
import {
  AppShell,
  NavContext,
  PageHeader,
  VerdictChip,
  fmtDate,
  money,
  roleLabel,
} from "./components";
import type {
  ApprovalRecord,
  ApprovalRequest,
  DrawAccountEvent,
  DrawDocument,
  DrawEvent,
  DrawEvidenceLink,
  DrawLineItem,
  DrawLineItemStatus,
  DrawRecommendation,
  DrawRequest,
  DrawRequestStatus,
  EvidenceItem,
  LedgerEntry,
  Milestone,
  Organization,
  Project,
  Report,
  User,
  Verification,
} from "../../shared/types";
import type {
  DrawChecklistRow,
  DrawCompleteness,
  DrawHeaderSummary,
} from "../services/draws";
import type { DrawLineComparison } from "../services/budgetProgress";
import { VarianceTag, ProgressCompareBars, VARIANCE_META } from "./budgetPages";
import type { FinancialProgress, PhysicalProgressAssessment } from "../../shared/types";

// ------------------------------------------------------------ chips

const DRAW_STATUS_META: Record<DrawRequestStatus, { label: string; tone: string; glyph: string }> = {
  DRAFT: { label: "Draft", tone: "", glyph: "○" },
  SUBMITTED: { label: "Submitted", tone: "info", glyph: "●" },
  UNDER_REVIEW: { label: "Under review", tone: "info", glyph: "!" },
  CLARIFICATION_REQUIRED: { label: "Clarification required", tone: "warn", glyph: "?" },
  READY_FOR_GOVERNANCE: { label: "Ready for governance", tone: "warn", glyph: "○" },
  PARTIALLY_APPROVED: { label: "Partially approved", tone: "warn", glyph: "◐" },
  APPROVED: { label: "Approved", tone: "ok", glyph: "✓" },
  RELEASED: { label: "Released", tone: "ok", glyph: "✓" },
  RETURNED: { label: "Returned", tone: "bad", glyph: "↩" },
  CANCELLED: { label: "Cancelled", tone: "", glyph: "✕" },
};

export function DrawStatusChip(props: { status: DrawRequestStatus }): VNode {
  const m = DRAW_STATUS_META[props.status];
  return (
    <span className={`status ${m.tone}`}>
      <span className="g" aria-hidden="true">{m.glyph}</span>
      {m.label}
    </span>
  );
}

const LINE_STATUS_META: Record<DrawLineItemStatus, { label: string; tone: string }> = {
  PENDING: { label: "Pending review", tone: "neutral" },
  SUPPORTED: { label: "Supported", tone: "ok" },
  PARTIALLY_SUPPORTED: { label: "Partially supported", tone: "warn" },
  EXCEPTION: { label: "Exception", tone: "warn" },
  REJECTED: { label: "Rejected", tone: "bad" },
};

function LineStatusTag(props: { status: DrawLineItemStatus }): VNode {
  const m = LINE_STATUS_META[props.status];
  return <span className={`sync-tag ${m.tone}`} style="margin-left:0">{m.label}</span>;
}

const REQ_STATE_TONE: Record<string, string> = {
  ACCEPTED: "ok",
  RECEIVED: "info",
  MISSING: "bad",
  REJECTED: "bad",
  EXPIRED: "warn",
  REQUIRED: "neutral",
};

const RECOMMENDATION_LABEL: Record<string, string> = {
  READY_FOR_GOVERNANCE: "READY FOR GOVERNANCE",
  HOLD_DOCUMENTS_MISSING: "HOLD — DOCUMENTS MISSING",
  HOLD_EVIDENCE_NEEDS_REVIEW: "HOLD — EVIDENCE NEEDS REVIEW",
  HOLD_OPEN_HIGH_SEVERITY_ISSUE: "HOLD — OPEN HIGH-SEVERITY ISSUE",
  PARTIAL_SUPPORT: "PARTIAL SUPPORT",
  RETURN_FOR_CLARIFICATION: "RETURN FOR CLARIFICATION",
};

const RECOMMENDATION_TONE: Record<string, string> = {
  READY_FOR_GOVERNANCE: "ok",
  PARTIAL_SUPPORT: "warn",
  HOLD_DOCUMENTS_MISSING: "bad",
  HOLD_EVIDENCE_NEEDS_REVIEW: "warn",
  HOLD_OPEN_HIGH_SEVERITY_ISSUE: "bad",
  RETURN_FOR_CLARIFICATION: "warn",
};

const DOC_TYPES = [
  "CONTRACTOR_INVOICE", "PAY_APPLICATION", "LIEN_WAIVER", "CONDITIONAL_LIEN_WAIVER",
  "INSPECTION_REPORT", "PROGRESS_PHOTOS", "PERMIT", "CERTIFICATE",
  "MATERIAL_INVOICE", "CHANGE_ORDER_SUPPORT", "PROOF_OF_INSURANCE", "OTHER",
];

const docTypeLabel = (t: string) => t.replace(/_/g, " ").toLowerCase();

// ------------------------------------------------------------ register

export interface DrawRegisterRow {
  draw: DrawRequest;
  project: Project | null;
  summary: DrawHeaderSummary;
  nextAction: string;
}

export function renderDrawRegister(input: {
  nav: NavContext;
  rows: DrawRegisterRow[];
  canCreate: boolean;
}): string {
  const active = input.rows.filter(
    (r) => !["RELEASED", "CANCELLED"].includes(r.draw.status)
  );
  const awaitingGov = input.rows.filter((r) => r.draw.status === "READY_FOR_GOVERNANCE");
  const inReview = input.rows.filter((r) =>
    ["SUBMITTED", "UNDER_REVIEW", "CLARIFICATION_REQUIRED"].includes(r.draw.status)
  );
  const released = input.rows.filter((r) => r.draw.status === "RELEASED");
  return renderDocument(
    <AppShell title="Draw Requests" nav={input.nav} context="Draw Requests">
      <PageHeader
        title="Draw Requests"
        sub="Lender review of construction draw requests. A draw request asks for review; a recommendation advises. Release eligibility is created only by the formal approval workflow."
      >
        {input.canCreate ? (
          <a className="btn" href="/draws/new">Create Draw Request</a>
        ) : null}
      </PageHeader>
      <div className="issue-stats">
        <span><b className="num">{active.length}</b> Active</span>
        <span><b className="num">{inReview.length}</b> In review</span>
        <span><b className="num" style={awaitingGov.length ? "color:var(--warn)" : ""}>{awaitingGov.length}</b> Awaiting governance</span>
        <span><b className="num">{released.length}</b> Released</span>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h3>Draw register</h3>
          <span className="right">{input.rows.length} draw{input.rows.length === 1 ? "" : "s"}</span>
        </div>
        {input.rows.length === 0 ? (
          <p className="sub" style="padding:14px 16px">
            No draw requests yet. Create one to run a governed draw review —
            budget lines, documents, field evidence and formal approval.
          </p>
        ) : (
          <div className="intg-table-wrap">
            <table className="intg-table">
              <thead>
                <tr>
                  <th>Draw #</th><th>Project</th><th>Requested</th><th>Supported</th>
                  <th>Exception</th><th>Retainage</th><th>Recommendation</th>
                  <th>Governance</th><th>Age</th><th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {input.rows.map((r) => {
                  const s = r.summary;
                  const gov = s.approval
                    ? s.approval.status === "PENDING"
                      ? `${s.approvalRecords.filter((rec) => rec.decision === "APPROVED").length} of ${s.approval.requiredRoles.length} approvals`
                      : s.approval.status
                    : "—";
                  return (
                    <tr>
                      <td data-l="Draw">
                        <a href={`/draw/${r.draw.id}`} style="font-weight:600;color:var(--action)">
                          Draw #{r.draw.drawNumber}
                        </a>{" "}
                        <DrawStatusChip status={r.draw.status} />
                      </td>
                      <td data-l="Project">{r.project?.name.slice(0, 34) ?? "—"}</td>
                      <td data-l="Requested" style="font-variant-numeric:tabular-nums">{money(s.requested)}</td>
                      <td data-l="Supported" style="font-variant-numeric:tabular-nums">{money(s.supported)}</td>
                      <td data-l="Exception" style={`font-variant-numeric:tabular-nums;${s.exception > 0 ? "color:var(--warn);font-weight:600" : ""}`}>
                        {s.exception > 0 ? money(s.exception) : "—"}
                      </td>
                      <td data-l="Retainage" style="font-variant-numeric:tabular-nums">{s.retainage > 0 ? money(s.retainage) : "—"}</td>
                      <td data-l="Recommendation">
                        {r.draw.reviewRecommendation ? (
                          <span className={`sync-tag ${RECOMMENDATION_TONE[r.draw.reviewRecommendation]}`} style="margin-left:0">
                            {RECOMMENDATION_LABEL[r.draw.reviewRecommendation]}
                          </span>
                        ) : (
                          <span className="sub">Not finalized</span>
                        )}
                      </td>
                      <td data-l="Governance">{gov}</td>
                      <td data-l="Age">{s.ageDays}d</td>
                      <td data-l="Next action" className="sub">{r.nextAction}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="sub" style="margin:10px 2px;font-size:11px">
        Draw amounts are review-layer figures. Milestone tranche HELD / RELEASED
        state on the virtual project account is governed separately by the
        milestone verification workflow and is never changed by a draw review.
      </p>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------------------ create

export function renderDrawNew(input: {
  nav: NavContext;
  projects: Array<{ project: Project; nextNumber: number }>;
}): string {
  return renderDocument(
    <AppShell title="Create Draw Request" nav={input.nav} context="New Draw Request">
      <PageHeader
        title="Create Draw Request"
        sub="Step 1 of the draw workflow: identify the project, draw number, period and requested amount. Line items, documents and evidence are added on the draft workspace before submission."
        crumb={{ href: "/draws", label: "Draw Requests" }}
      />
      <div className="panel panel-pad" style="max-width:640px">
        <form method="POST" action="/api/draws" className="fo-form">
          <label>Project
            <select name="projectId" required>
              {input.projects.map((p, i) => (
                <option value={p.project.id} selected={i === 0}>
                  {p.project.name} (next: Draw #{p.nextNumber})
                </option>
              ))}
            </select>
          </label>
          <div className="fo-row">
            <label>Draw number (blank = next)
              <input name="drawNumber" type="number" min="1" step="1" placeholder="auto" />
            </label>
            <label>Requested amount (USD)
              <input name="requestedAmount" type="number" min="0" step="1" required placeholder="e.g. 500000" />
            </label>
          </div>
          <div className="fo-row">
            <label>Period start
              <input name="periodStart" type="date" required />
            </label>
            <label>Period end
              <input name="periodEnd" type="date" required />
            </label>
          </div>
          <div style="display:flex;gap:8px">
            <button className="btn" type="submit">Create draft</button>
            <a className="btn ghost" href="/draws">Cancel</a>
          </div>
          <p className="sub" style="margin:4px 0 0;font-size:11px">
            Drafts save independently and authorize nothing. Submission requires
            line items that reconcile exactly to the requested amount.
          </p>
        </form>
      </div>
    </AppShell>
  );
}

// ------------------------------------------------------------ detail

export type DrawTab =
  | "overview" | "lines" | "evidence" | "documents" | "exceptions"
  | "review" | "governance" | "activity";

export interface DrawEvidenceRow {
  link: DrawEvidenceLink;
  evidence: EvidenceItem | null;
  verification: Verification | null;
  milestone: Milestone | null;
  ledgerEntry: LedgerEntry | null;
  line: DrawLineItem | null;
}

export interface DrawDetailData {
  nav: NavContext;
  tab: DrawTab;
  draw: DrawRequest;
  project: Project;
  borrowerOrg: Organization | null;
  lenderOrg: Organization | null;
  summary: DrawHeaderSummary;
  lines: DrawLineItem[];
  milestones: Milestone[];
  checklist: DrawChecklistRow[];
  documents: DrawDocument[];
  evidenceRows: DrawEvidenceRow[];
  projectEvidence: Array<{ evidence: EvidenceItem; milestone: Milestone; verification: Verification | null }>;
  events: DrawEvent[];
  accountEvents: DrawAccountEvent[];
  recommendation: DrawRecommendation;
  completeness: DrawCompleteness;
  /** Budget-vs-verified comparison per line (advisory; never rejects). */
  lineComparisons: Map<string, DrawLineComparison>;
  /** Contract position: original value, approved change orders, current. */
  contract: { original: number; approvedChanges: number; current: number };
  /** Change orders referenced by draw lines (id → CO summary). */
  lineChangeOrders: Map<string, { number: number; status: string; approved: boolean }>;
  /** Retainage computed at governance-finalize (null before). */
  retainage: { rate: number; withheld: number; netEligible: number } | null;
  approval: ApprovalRequest | null;
  approvalRecords: ApprovalRecord[];
  users: Map<string, User>;
  threadId: string | null;
  reports: Report[];
  // capabilities for the signed-in user
  canEdit: boolean;
  canReview: boolean;
  canDecide: boolean;
  alreadyDecided: boolean;
  isSubmitter: boolean;
}

const TABS: Array<{ key: DrawTab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "lines", label: "Line Items" },
  { key: "evidence", label: "Evidence" },
  { key: "documents", label: "Documents" },
  { key: "exceptions", label: "Exceptions" },
  { key: "review", label: "Review" },
  { key: "governance", label: "Governance" },
  { key: "activity", label: "Activity" },
];

function kpi(label: string, value: string, tone?: string): VNode {
  const cls = tone === "ok" ? "green" : tone === "warn" ? "amber" : "";
  return (
    <div className="fin-cell">
      <div className={`v ${cls}`}>{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function renderDrawDetail(d: DrawDetailData): string {
  const { draw, summary: s } = d;
  const url = (tab: DrawTab) => `/draw/${draw.id}?tab=${tab}`;
  const editable = ["DRAFT", "RETURNED", "CLARIFICATION_REQUIRED"].includes(draw.status) && d.canEdit;
  const reviewOpen = ["SUBMITTED", "UNDER_REVIEW"].includes(draw.status) && d.canReview;
  const exceptions = d.lines.filter((l) =>
    ["PARTIALLY_SUPPORTED", "EXCEPTION", "REJECTED"].includes(l.status)
  );
  return renderDocument(
    <AppShell
      title={`Draw #${draw.drawNumber}`}
      nav={d.nav}
      context={`Draw #${draw.drawNumber} · ${d.project.name.slice(0, 40)}`}
    >
      <PageHeader
        title={`Draw Request #${draw.drawNumber}`}
        sub={`${d.project.name} · ${d.borrowerOrg ? `Requested by ${d.borrowerOrg.name}` : "Lender-entered"} · Period ${draw.periodStart ?? "—"} → ${draw.periodEnd ?? "—"}`}
        crumb={{ href: "/draws", label: "Draw Requests" }}
      >
        <DrawStatusChip status={draw.status} />
      </PageHeader>

      {/* header financial band — answers the page's core questions */}
      <div className="fin-band" style="margin-bottom:12px">
        {kpi("Requested", money(s.requested))}
        {kpi("Supported", money(s.supported), s.supported < s.requested ? "warn" : "ok")}
        {kpi("Exception", s.exception > 0 ? money(s.exception) : "—", s.exception > 0 ? "warn" : undefined)}
        {kpi("Retainage", s.retainage > 0 ? money(s.retainage) : "—")}
        {kpi("Recommended", s.recommended !== null ? money(s.recommended) : "Not finalized")}
        {kpi(
          "Released",
          d.accountEvents.some((e) => e.type === "RELEASED")
            ? money(d.accountEvents.find((e) => e.type === "RELEASED")!.amount)
            : "—",
          d.accountEvents.some((e) => e.type === "RELEASED") ? "ok" : undefined
        )}
      </div>

      <nav className="tabs" aria-label="Draw sections">
        {TABS.map((t) => (
          <a href={url(t.key)} className={d.tab === t.key ? "active" : ""} aria-current={d.tab === t.key ? "page" : undefined}>
            {t.label}
            {t.key === "exceptions" && exceptions.length ? <span className="count">{exceptions.length}</span> : null}
          </a>
        ))}
      </nav>

      {d.tab === "overview" ? renderOverviewTab(d, editable) : null}
      {d.tab === "lines" ? renderLinesTab(d, editable, reviewOpen) : null}
      {d.tab === "evidence" ? renderEvidenceTab(d, editable || reviewOpen) : null}
      {d.tab === "documents" ? renderDocumentsTab(d, editable, reviewOpen) : null}
      {d.tab === "exceptions" ? renderExceptionsTab(d, exceptions) : null}
      {d.tab === "review" ? renderReviewTab(d, reviewOpen) : null}
      {d.tab === "governance" ? renderGovernanceTab(d) : null}
      {d.tab === "activity" ? renderActivityTab(d) : null}
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

function renderOverviewTab(d: DrawDetailData, editable: boolean): VNode {
  const { draw } = d;
  return (
    <>
      <div className="grid-2col">
        <div className="panel panel-pad">
          <h3 style="margin:0 0 8px;font-size:13px">Draw facts</h3>
          <dl className="ctx-kv" style="padding:0;grid-template-columns:150px 1fr">
            <dt>Project</dt><dd><a href={`/project/${d.project.id}`} style="color:var(--action)">{d.project.name}</a></dd>
            <dt>Borrower / implementer</dt><dd>{d.borrowerOrg?.name ?? "—"}</dd>
            <dt>Lender / governing org</dt><dd>{d.lenderOrg?.name ?? "—"}</dd>
            <dt>Draw number</dt><dd>#{draw.drawNumber}</dd>
            <dt>Original contract value</dt><dd>{money(d.contract.original)}</dd>
            <dt>Approved change orders</dt><dd>{d.contract.approvedChanges !== 0 ? money(d.contract.approvedChanges) : "—"}</dd>
            <dt>Current contract value</dt><dd><b>{money(d.contract.current)}</b></dd>
            <dt>Period</dt><dd>{draw.periodStart ?? "—"} → {draw.periodEnd ?? "—"}</dd>
            <dt>Currency</dt><dd>{draw.currency}</dd>
            <dt>Requested by</dt><dd>{draw.requestedByUserId ? d.users.get(draw.requestedByUserId)?.name ?? "—" : "—"}</dd>
            <dt>Submitted</dt><dd>{draw.submittedAt ? fmtDate(draw.submittedAt) : "Not yet submitted"}</dd>
            <dt>Status</dt><dd><DrawStatusChip status={draw.status} /></dd>
            {draw.reviewSummary ? (<><dt>Review summary</dt><dd>{draw.reviewSummary}</dd></>) : null}
            {draw.approvedAmount !== null ? (<><dt>Approved amount</dt><dd>{money(draw.approvedAmount)}</dd></>) : null}
          </dl>
          {d.threadId ? (
            <p style="margin:12px 0 0;font-size:12px">
              <a href={`/communications?thread=${d.threadId}`} style="color:var(--action);font-weight:600">
                Open draw discussion thread
              </a>{" "}
              <span className="sub">— coordination only; chat can never approve a draw.</span>
            </p>
          ) : null}
        </div>

        <div className="panel panel-pad">
          <h3 style="margin:0 0 8px;font-size:13px">Completeness</h3>
          <ul className="checks" style="list-style:none;margin:0;padding:0">
            {d.completeness.checks.map((c) => (
              <li style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:12px">
                <span style={`font-weight:700;color:var(--${c.ok ? "ok" : "warn"})`}>{c.ok ? "✓" : "!"}</span>
                <span>
                  <b style="display:block;font-weight:600">{c.label}</b>
                  <span className="sub">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          {editable ? (
            <div style="margin-top:14px;display:flex;flex-wrap:wrap;gap:8px">
              <form method="POST" action={`/api/draws/${draw.id}/submit`}>
                <input type="hidden" name="redirect" value={`/draw/${draw.id}?tab=review`} />
                <button className="btn" type="submit" disabled={!d.completeness.ok}>
                  {draw.status === "DRAFT" ? "Submit draw request" : "Resubmit draw request"}
                </button>
              </form>
              <form method="POST" action={`/api/draws/${draw.id}/cancel`}>
                <button className="btn ghost" type="submit">Cancel draw</button>
              </form>
            </div>
          ) : null}
          {editable && !d.completeness.ok ? (
            <p className="sub" style="margin:8px 0 0;font-size:11px">
              Submission is blocked until the amount, period, line items and
              reconciliation checks pass.
            </p>
          ) : null}
        </div>
      </div>

      {editable ? (
        <div className="panel panel-pad" style="margin-top:12px;max-width:640px">
          <h3 style="margin:0 0 8px;font-size:13px">Edit draft details</h3>
          <form method="POST" action={`/api/draws/${draw.id}/update`} className="fo-form">
            <div className="fo-row">
              <label>Requested amount
                <input name="requestedAmount" type="number" min="0" step="1" value={String(draw.requestedAmount)} />
              </label>
              <label>Currency
                <input name="currency" value={draw.currency} maxlength="3" />
              </label>
            </div>
            <div className="fo-row">
              <label>Period start
                <input name="periodStart" type="date" value={draw.periodStart ?? ""} />
              </label>
              <label>Period end
                <input name="periodEnd" type="date" value={draw.periodEnd ?? ""} />
              </label>
            </div>
            <button className="btn sm" type="submit">Save details</button>
          </form>
        </div>
      ) : null}

      <div className="panel panel-pad" style="margin-top:12px">
        <p className="sub" style="margin:0;font-size:11.5px">
          <b>Trust model.</b> This draw request is a request for review — it
          authorizes nothing. Line-item reviews and the recommendation are
          advisory. Release eligibility is created only when every required
          role approves the formal governance request, and the release
          transition is recorded exactly once on the virtual project account.
          Linked field evidence remains governed by its own verification
          pipeline and the tamper-evident Evidence Ledger.
        </p>
      </div>
    </>
  );
}

function renderLinesTab(d: DrawDetailData, editable: boolean, reviewOpen: boolean): VNode {
  const { draw } = d;
  const rec = d.lines.reduce((s, l) => s + l.currentRequested, 0);
  const reconciled = rec === draw.requestedAmount;
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h3>Line items</h3>
          <span className="right" style={reconciled ? "color:var(--ok)" : "color:var(--warn)"}>
            Lines {money(rec)} / requested {money(draw.requestedAmount)} {reconciled ? "· reconciled" : `· off by ${money(Math.abs(draw.requestedAmount - rec))}`}
          </span>
        </div>
        {d.lines.length === 0 ? (
          <p className="sub" style="padding:14px 16px">No line items yet.</p>
        ) : (
          <div className="intg-table-wrap">
            <table className="intg-table">
              <thead>
                <tr>
                  <th>Line</th><th>Milestone</th><th>Scheduled</th><th>Prev. paid</th>
                  <th>This draw</th><th>Stored</th><th>Retainage</th><th>Balance</th>
                  <th>% claimed</th><th>Financial</th><th>Verified physical</th>
                  <th>Progress variance</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => {
                  const ms = l.milestoneId ? d.milestones.find((m) => m.id === l.milestoneId) : null;
                  const cmp = d.lineComparisons.get(l.id);
                  return (
                    <tr>
                      <td data-l="Line">
                        <b>{l.description}</b>
                        {l.budgetLineId ? <span className="sub" style="display:block">{l.budgetLineId}</span> : null}
                        {l.changeOrderId && d.lineChangeOrders.get(l.id) ? (
                          <span
                            className={`sync-tag ${d.lineChangeOrders.get(l.id)!.approved ? "ok" : "bad"}`}
                            style="margin:2px 0 0"
                          >
                            CO-{d.lineChangeOrders.get(l.id)!.number}{d.lineChangeOrders.get(l.id)!.approved ? "" : " UNAPPROVED — held for review"}
                          </span>
                        ) : null}
                        {l.reviewNotes ? <span className="sub" style="display:block;color:var(--warn)">{l.reviewNotes}</span> : null}
                      </td>
                      <td data-l="Milestone">{ms ? <a href={`/milestone/${ms.id}`} style="color:var(--action)">M{ms.seq}</a> : "—"}</td>
                      <td data-l="Scheduled" style="font-variant-numeric:tabular-nums">{money(l.scheduledValue)}</td>
                      <td data-l="Prev paid" style="font-variant-numeric:tabular-nums">{money(l.previouslyPaid)}</td>
                      <td data-l="This draw" style="font-variant-numeric:tabular-nums;font-weight:600">{money(l.currentRequested)}</td>
                      <td data-l="Stored" style="font-variant-numeric:tabular-nums">{l.materialsStored != null ? money(l.materialsStored) : "—"}</td>
                      <td data-l="Retainage" style="font-variant-numeric:tabular-nums">{l.retainageAmount != null ? money(l.retainageAmount) : "—"}</td>
                      <td data-l="Balance" style="font-variant-numeric:tabular-nums">{money(l.balanceToFinish)}</td>
                      <td data-l="% claimed">{l.percentCompleteClaimed != null ? `${l.percentCompleteClaimed}%` : "—"}</td>
                      <td data-l="Financial">{cmp?.financialPct != null ? `${cmp.financialPct}%` : "—"}</td>
                      <td data-l="Verified physical">{cmp?.verifiedPct != null ? `${cmp.verifiedPct}%` : "—"}</td>
                      <td data-l="Progress variance">
                        {cmp ? <VarianceTag state={cmp.varianceState} /> : "—"}
                        {cmp?.exceptionCandidate ? (
                          <span className="sub" style="display:block;color:var(--warn)">Exception candidate — review evidence basis</span>
                        ) : null}
                      </td>
                      <td data-l="Status"><LineStatusTag status={l.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {reviewOpen
        ? d.lines.map((l) => (
            <div className="panel panel-pad" style="margin-top:10px">
              <h3 style="margin:0 0 6px;font-size:12.5px">
                Review — {l.description} ({money(l.currentRequested)}) <LineStatusTag status={l.status} />
                {d.lineComparisons.get(l.id)?.exceptionCandidate ? (
                  <span className="sync-tag bad" style="margin-left:8px">Exception candidate</span>
                ) : null}
              </h3>
              {d.lineComparisons.get(l.id)?.exceptionCandidate ? (
                <p className="sub" style="margin:0 0 8px;font-size:11px">
                  Financial progress ({d.lineComparisons.get(l.id)!.financialPct}%) is ahead of currently
                  verified physical progress ({d.lineComparisons.get(l.id)!.verifiedPct}%). Advisory only —
                  the reviewer decides; the draw is never rejected automatically.
                </p>
              ) : null}
              <form method="POST" action={`/api/draws/${draw.id}/lines/${l.id}/review`} className="fo-form">
                <div className="fo-row">
                  <label>Decision
                    <select name="decision">
                      {(["SUPPORTED", "PARTIALLY_SUPPORTED", "EXCEPTION", "REJECTED"] as const).map((s) => (
                        <option value={s} selected={l.status === s}>{s.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  </label>
                  <label>Supported amount (partial only)
                    <input name="supportedAmount" type="number" min="0" step="1" value={l.supportedAmount != null ? String(l.supportedAmount) : ""} />
                  </label>
                  <label>Verified % complete
                    <input name="percentCompleteVerified" type="number" min="0" max="100" step="1" value={l.percentCompleteVerified != null ? String(l.percentCompleteVerified) : ""} />
                  </label>
                </div>
                <label>Reason (required unless fully supported)
                  <input name="reason" placeholder="Evidence basis / why the amount is or is not supported" value={l.reviewNotes ?? ""} />
                </label>
                <button className="btn sm" type="submit">Record line review</button>
              </form>
              <p className="sub" style="margin:6px 0 0;font-size:11px">
                Line review is advisory — it cannot release funds.
              </p>
            </div>
          ))
        : null}

      {editable ? (
        <div className="panel panel-pad" style="margin-top:12px;max-width:720px">
          <h3 style="margin:0 0 8px;font-size:13px">Add line item</h3>
          <form method="POST" action={`/api/draws/${draw.id}/lines`} className="fo-form">
            <label>Description
              <input name="description" required maxlength="160" placeholder="e.g. Gravel base course, km 7–11" />
            </label>
            <div className="fo-row">
              <label>Budget line / cost code
                <input name="budgetLineId" placeholder="optional" />
              </label>
              <label>Milestone
                <select name="milestoneId">
                  <option value="">None</option>
                  {d.milestones.map((m) => (
                    <option value={m.id}>M{m.seq} · {m.title.slice(0, 44)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="fo-row">
              <label>Scheduled value
                <input name="scheduledValue" type="number" min="0" step="1" required />
              </label>
              <label>Previously paid
                <input name="previouslyPaid" type="number" min="0" step="1" value="0" />
              </label>
              <label>This draw (requested)
                <input name="currentRequested" type="number" min="0" step="1" required />
              </label>
            </div>
            <div className="fo-row">
              <label>Materials stored
                <input name="materialsStored" type="number" min="0" step="1" placeholder="optional" />
              </label>
              <label>Retainage
                <input name="retainageAmount" type="number" min="0" step="1" placeholder="optional" />
              </label>
              <label>% complete claimed
                <input name="percentCompleteClaimed" type="number" min="0" max="100" step="1" placeholder="optional" />
              </label>
            </div>
            <button className="btn sm" type="submit">Add line item</button>
          </form>
          {d.lines.length ? (
            <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px">
              {d.lines.map((l) => (
                <form method="POST" action={`/api/draws/${draw.id}/lines/${l.id}/delete`}>
                  <button className="btn ghost sm" type="submit">Remove “{l.description.slice(0, 26)}”</button>
                </form>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function renderEvidenceTab(d: DrawDetailData, canLink: boolean): VNode {
  const { draw } = d;
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h3>Linked field evidence</h3>
          <span className="right">{d.evidenceRows.length} link(s) — evidence stays governed by its own verification &amp; ledger</span>
        </div>
        {d.evidenceRows.length === 0 ? (
          <p className="sub" style="padding:14px 16px">
            No evidence linked yet. Link governed milestone evidence that
            supports the claimed progress — a document upload is never treated
            as verified physical progress.
          </p>
        ) : (
          <div className="intg-table-wrap">
            <table className="intg-table">
              <thead>
                <tr><th>Evidence</th><th>Milestone</th><th>Verification</th><th>Ledger</th><th>Line</th><th>Note</th><th></th></tr>
              </thead>
              <tbody>
                {d.evidenceRows.map((r) => (
                  <tr>
                    <td data-l="Evidence">
                      {r.milestone ? (
                        <a href={`/milestone/${r.milestone.id}`} style="color:var(--action);font-weight:600">
                          {r.evidence ? `Photo · ${fmtDate(r.evidence.capturedAt).slice(0, 16)}` : r.link.evidenceItemId.slice(0, 8) + "…"}
                        </a>
                      ) : (
                        r.link.evidenceItemId.slice(0, 8) + "…"
                      )}
                    </td>
                    <td data-l="Milestone">{r.milestone ? `M${r.milestone.seq} · ${r.milestone.title.slice(0, 30)}` : "—"}</td>
                    <td data-l="Verification">{r.verification ? <VerdictChip verdict={r.verification.verdict} /> : <span className="sub">None</span>}</td>
                    <td data-l="Ledger">{r.ledgerEntry ? `#${r.ledgerEntry.seq} in chain` : "—"}</td>
                    <td data-l="Line">{r.line ? r.line.description.slice(0, 28) : "Draw-level"}</td>
                    <td data-l="Note" className="sub">{r.link.note ?? "—"}</td>
                    <td>
                      {canLink ? (
                        <form method="POST" action={`/api/draws/${draw.id}/evidence/${r.link.id}/unlink`}>
                          <button className="btn ghost sm" type="submit">Unlink</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canLink ? (
        <div className="panel panel-pad" style="margin-top:12px;max-width:720px">
          <h3 style="margin:0 0 8px;font-size:13px">Link milestone evidence</h3>
          {d.projectEvidence.length === 0 ? (
            <p className="sub" style="margin:0">No evidence exists on this project yet — capture it through the governed field workflow.</p>
          ) : (
            <form method="POST" action={`/api/draws/${draw.id}/evidence`} className="fo-form">
              <label>Evidence record
                <select name="evidenceItemId" required>
                  {d.projectEvidence.map((e) => (
                    <option value={e.evidence.id}>
                      M{e.milestone.seq} · {fmtDate(e.evidence.capturedAt).slice(0, 16)} · {e.verification ? e.verification.verdict.replace(/_/g, " ") : "unverified"}
                    </option>
                  ))}
                </select>
              </label>
              <div className="fo-row">
                <label>Attach to line (optional)
                  <select name="lineItemId">
                    <option value="">Draw-level</option>
                    {d.lines.map((l) => (
                      <option value={l.id}>{l.description.slice(0, 44)}</option>
                    ))}
                  </select>
                </label>
                <label>Note
                  <input name="note" placeholder="optional" />
                </label>
              </div>
              <button className="btn sm" type="submit">Link evidence</button>
            </form>
          )}
          <p className="sub" style="margin:8px 0 0;font-size:11px">
            Linking references the existing evidence record — it never copies,
            re-verifies or alters it.
          </p>
        </div>
      ) : null}
    </>
  );
}

function renderDocumentsTab(d: DrawDetailData, editable: boolean, reviewOpen: boolean): VNode {
  const { draw } = d;
  const canRecord = editable || reviewOpen;
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h3>Supporting document checklist</h3>
          <span className="right">Documents are administrative records — never verified physical progress</span>
        </div>
        <div className="intg-table-wrap">
          <table className="intg-table">
            <thead>
              <tr><th>Requirement</th><th>State</th><th>Documents on file</th><th></th></tr>
            </thead>
            <tbody>
              {d.checklist.map((row) => (
                <tr>
                  <td data-l="Requirement">
                    {row.requirement ? (
                      <>
                        <b>{row.requirement.title}</b>
                        <span className="sub" style="display:block">
                          {docTypeLabel(row.requirement.docType)}{row.requirement.required ? " · required" : " · optional"}
                        </span>
                      </>
                    ) : (
                      <b>Unassigned documents</b>
                    )}
                  </td>
                  <td data-l="State">
                    <span className={`sync-tag ${REQ_STATE_TONE[row.state]}`} style="margin-left:0">{row.state}</span>
                  </td>
                  <td data-l="Documents">
                    {row.documents.length === 0 ? (
                      <span className="sub">None</span>
                    ) : (
                      row.documents.map((doc) => (
                        <span style="display:block;margin:2px 0">
                          {doc.title}{" "}
                          <span className={`sync-tag ${doc.status === "ACCEPTED" ? "ok" : doc.status === "RECEIVED" ? "info" : doc.status === "EXPIRED" ? "warn" : "bad"}`}>
                            {doc.status}
                          </span>
                          {doc.reviewNote ? <span className="sub" style="display:block">{doc.reviewNote}</span> : null}
                          {reviewOpen && doc.status === "RECEIVED" ? (
                            <span style="display:inline-flex;gap:4px;margin-left:6px">
                              <form method="POST" action={`/api/draws/${draw.id}/documents/${doc.id}/review`} style="display:inline">
                                <input type="hidden" name="decision" value="ACCEPTED" />
                                <button className="btn ghost sm" type="submit">Accept</button>
                              </form>
                              <form method="POST" action={`/api/draws/${draw.id}/documents/${doc.id}/review`} style="display:inline">
                                <input type="hidden" name="decision" value="REJECTED" />
                                <input name="note" placeholder="rejection note" style="width:130px;font-size:11px" required />
                                <button className="btn ghost sm" type="submit">Reject</button>
                              </form>
                            </span>
                          ) : null}
                        </span>
                      ))
                    )}
                  </td>
                  <td></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {canRecord ? (
        <div className="grid-2col" style="margin-top:12px">
          <div className="panel panel-pad">
            <h3 style="margin:0 0 8px;font-size:13px">Record received document</h3>
            <form method="POST" action={`/api/draws/${draw.id}/documents`} className="fo-form">
              <label>Fulfils requirement
                <select name="requirementId">
                  <option value="">None / additional document</option>
                  {d.checklist.filter((r) => r.requirement).map((r) => (
                    <option value={r.requirement!.id}>{r.requirement!.title}</option>
                  ))}
                </select>
              </label>
              <div className="fo-row">
                <label>Title
                  <input name="title" required placeholder="e.g. Pay Application #4" />
                </label>
                <label>Type
                  <select name="docType">
                    {DOC_TYPES.map((t) => (
                      <option value={t}>{docTypeLabel(t)}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label>Note
                <input name="note" placeholder="optional" />
              </label>
              <button className="btn sm" type="submit">Record document</button>
            </form>
          </div>
          <div className="panel panel-pad">
            <h3 style="margin:0 0 8px;font-size:13px">Add checklist requirement</h3>
            <form method="POST" action={`/api/draws/${draw.id}/requirements`} className="fo-form">
              <div className="fo-row">
                <label>Title
                  <input name="title" required placeholder="e.g. Compaction test certificate" />
                </label>
                <label>Type
                  <select name="docType">
                    {DOC_TYPES.map((t) => (
                      <option value={t}>{docTypeLabel(t)}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label style="flex-direction:row;display:flex;align-items:center;gap:6px">
                <input type="checkbox" name="required" value="1" checked style="width:auto" /> Required for governance readiness
              </label>
              <button className="btn sm" type="submit">Add requirement</button>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

function renderExceptionsTab(d: DrawDetailData, exceptions: DrawLineItem[]): VNode {
  const recExceptions = d.recommendation.reasons.filter((r) => r.kind !== "INFO");
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h3>Exceptions &amp; disputed amounts</h3>
          <span className="right">{money(d.recommendation.exceptionAmount)} not currently supported</span>
        </div>
        {exceptions.length === 0 && recExceptions.length === 0 ? (
          <p className="sub" style="padding:14px 16px">No exceptions recorded.</p>
        ) : (
          <ul className="activity">
            {exceptions.map((l) => (
              <li>
                <span className="ico warn">{icons.alert()}</span>
                <span className="body">
                  <span className="msg">
                    <b>{l.description}</b> — {money(l.currentRequested)} requested,{" "}
                    {l.status === "PARTIALLY_SUPPORTED"
                      ? `${money(l.supportedAmount ?? 0)} supported (${money(l.currentRequested - (l.supportedAmount ?? 0))} exception)`
                      : l.status === "REJECTED"
                        ? "rejected in full"
                        : "held as exception in full"}
                  </span>
                  <span className="meta">
                    <span>{l.reviewNotes ?? "No reason recorded"}</span>
                    {l.reviewedByUserId ? <span>{d.users.get(l.reviewedByUserId)?.name}</span> : null}
                  </span>
                </span>
              </li>
            ))}
            {recExceptions
              .filter((r) => !r.lineItemId)
              .map((r) => (
                <li>
                  <span className="ico warn">{icons.alert()}</span>
                  <span className="body">
                    <span className="msg">{r.detail}</span>
                    <span className="meta"><span>{r.kind === "BLOCKER" ? "Blocks governance readiness" : "Exception"}</span></span>
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </>
  );
}

function renderReviewTab(d: DrawDetailData, reviewOpen: boolean): VNode {
  const { draw, recommendation: rec } = d;
  return (
    <>
      <div className="panel panel-pad">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
          <h3 style="margin:0;font-size:13px">Draw recommendation</h3>
          <span className={`sync-tag ${RECOMMENDATION_TONE[rec.result]}`} style="margin-left:0;font-size:12px">
            {RECOMMENDATION_LABEL[rec.result]}
          </span>
          <span className="sub" style="margin-left:auto">Deterministic — computed from real draw state · advisory only</span>
        </div>
        <div className="fin-band" style="margin:12px 0">
          {kpi("Requested", money(rec.requestedAmount))}
          {kpi("Supported", money(rec.supportedAmount), rec.supportedAmount < rec.requestedAmount ? "warn" : "ok")}
          {kpi("Exception", rec.exceptionAmount > 0 ? money(rec.exceptionAmount) : "—", rec.exceptionAmount > 0 ? "warn" : undefined)}
          {kpi("Retainage", rec.retainageAmount > 0 ? money(rec.retainageAmount) : "—")}
        </div>
        <h4 style="margin:6px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3)">Reasons</h4>
        {rec.reasons.length === 0 ? (
          <p className="sub" style="margin:0">No findings.</p>
        ) : (
          <ul style="margin:0;padding:0 0 0 2px;list-style:none">
            {rec.reasons.map((r) => (
              <li style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--line);font-size:12px">
                <span style={`font-weight:700;color:var(--${r.kind === "BLOCKER" ? "bad" : r.kind === "EXCEPTION" ? "warn" : "ink-3"})`}>
                  {r.kind === "BLOCKER" ? "✕" : r.kind === "EXCEPTION" ? "!" : "·"}
                </span>
                <span>{r.detail}{r.amount != null ? ` (${money(r.amount)})` : ""}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="sub" style="margin:12px 0 0;font-size:11.5px">
          <b>This recommendation is advisory.</b> It cannot release funds and
          never calls the virtual account. Sending to governance opens a formal
          approval that requires {(d.approval?.requiredRoles ?? ["FUNDER_REP", "COMPLIANCE_REVIEWER"])
            .map((r) => roleLabel(r))
            .join(" + ")}.
        </p>
      </div>

      {reviewOpen ? (
        <div className="grid-2col" style="margin-top:12px">
          <div className="panel panel-pad">
            <h3 style="margin:0 0 8px;font-size:13px">Send to formal governance</h3>
            <form method="POST" action={`/api/draws/${draw.id}/governance`} className="fo-form">
              <label>Review summary (optional)
                <input name="summary" placeholder="One-line basis for the recommendation" />
              </label>
              <button className="btn" type="submit" disabled={!rec.eligibleForGovernance}>
                Finalize recommendation &amp; open approval
              </button>
            </form>
            {!rec.eligibleForGovernance ? (
              <p className="sub" style="margin:8px 0 0;font-size:11px">
                Blocked: resolve the blocking reasons above first (documents,
                unreviewed lines, open issues or clarifications).
              </p>
            ) : null}
          </div>
          <div className="panel panel-pad">
            <h3 style="margin:0 0 8px;font-size:13px">Other review actions</h3>
            <form method="POST" action={`/api/draws/${draw.id}/clarification`} className="fo-form" style="margin-bottom:10px">
              <label>Request clarification
                <input name="question" placeholder="What must the requester clarify?" required />
              </label>
              <button className="btn ghost sm" type="submit">Request clarification</button>
            </form>
            <form method="POST" action={`/api/draws/${draw.id}/return`} className="fo-form">
              <label>Return to requester
                <input name="reason" placeholder="Why is the draw being returned?" required />
              </label>
              <button className="btn ghost sm" type="submit">Return draw</button>
            </form>
          </div>
        </div>
      ) : null}

      {draw.status === "CLARIFICATION_REQUIRED" ? (
        <div className="panel panel-pad" style="margin-top:12px;max-width:640px">
          <h3 style="margin:0 0 8px;font-size:13px">Answer clarification</h3>
          <form method="POST" action={`/api/draws/${draw.id}/clarification/resolve`} className="fo-form">
            <label>Response
              <input name="note" placeholder="Answer to the reviewer's question" required />
            </label>
            <button className="btn sm" type="submit">Submit response &amp; return to review</button>
          </form>
          <p className="sub" style="margin:6px 0 0;font-size:11px">
            A response never auto-accepts anything — the draw simply returns to review.
          </p>
        </div>
      ) : null}
    </>
  );
}

function renderGovernanceTab(d: DrawDetailData): VNode {
  const { draw, approval } = d;
  const approvedRoles = new Set(
    d.approvalRecords.filter((r) => r.decision === "APPROVED").map((r) => r.role)
  );
  const released = d.accountEvents.find((e) => e.type === "RELEASED");
  return (
    <>
      <div className="panel panel-pad">
        <h3 style="margin:0 0 8px;font-size:13px">Formal approval — the only release authority</h3>
        {!approval ? (
          <p className="sub" style="margin:0">
            No approval request yet. Governance opens when a reviewer finalizes
            the recommendation on the Review tab.
          </p>
        ) : (
          <>
            <dl className="ctx-kv" style="padding:0;grid-template-columns:170px 1fr">
              <dt>Requested amount</dt><dd>{money(draw.requestedAmount)}</dd>
              <dt>Supported amount</dt><dd>{money(d.summary.supported)}</dd>
              <dt>Recommended amount</dt><dd>{draw.recommendedAmount !== null ? money(draw.recommendedAmount) : "—"} <span className="sub">(advisory)</span></dd>
              {d.retainage ? (
                <>
                  <dt>Gross supported</dt><dd>{money(draw.recommendedAmount ?? 0)}</dd>
                  <dt>Retainage withheld</dt><dd>{money(d.retainage.withheld)} ({d.retainage.rate}%)</dd>
                  <dt>Net release eligible</dt>
                  <dd>
                    <b>{money(d.retainage.netEligible)}</b>
                    <span className="sub" style="display:block">
                      Retainage is withheld inside the governed release and released only through its
                      own formal RetainageReleaseRequest.
                    </span>
                  </dd>
                </>
              ) : null}
              <dt>Exceptions</dt><dd>{d.summary.exception > 0 ? money(d.summary.exception) : "None"}</dd>
              <dt>Evidence basis</dt><dd>{d.summary.evidenceLinks} linked evidence record(s), each governed by its own verification and ledger entry</dd>
              <dt>Required roles</dt><dd>{approval.requiredRoles.map((r) => roleLabel(r)).join(" + ")}</dd>
              <dt>Approval status</dt>
              <dd>
                {approval.status === "PENDING"
                  ? `${approvedRoles.size} of ${approval.requiredRoles.length} approvals recorded — funds remain HELD`
                  : approval.status}
              </dd>
            </dl>
            <ul className="activity" style="margin-top:10px">
              {approval.requiredRoles.map((role) => {
                const record = d.approvalRecords.find((r) => r.role === role);
                return (
                  <li>
                    <span className={`ico ${record ? (record.decision === "APPROVED" ? "ok" : "bad") : "warn"}`}>
                      {record ? (record.decision === "APPROVED" ? icons.check() : icons.x()) : icons.clock()}
                    </span>
                    <span className="body">
                      <span className="msg">
                        <b>{roleLabel(role)}</b>{" "}
                        {record
                          ? `${record.decision.toLowerCase()} by ${d.users.get(record.userId)?.name ?? "—"}`
                          : "decision pending"}
                      </span>
                      {record ? <span className="meta"><span className="when">{fmtDate(record.createdAt)}</span></span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            {d.canDecide && approval.status === "PENDING" ? (
              <form method="POST" action={`/api/approvals/${approval.id}/decision`} style="display:flex;gap:8px;margin-top:12px">
                <input type="hidden" name="redirect" value={`/draw/${draw.id}?tab=governance`} />
                <button className="btn" name="decision" value="APPROVED" type="submit">Approve release</button>
                <button className="btn ghost" name="decision" value="REJECTED" type="submit">Reject</button>
              </form>
            ) : null}
            {d.alreadyDecided ? (
              <p className="sub" style="margin:10px 0 0;font-size:11.5px">Your role's decision has been recorded.</p>
            ) : null}
            {d.isSubmitter && approval.status === "PENDING" ? (
              <p className="sub" style="margin:10px 0 0;font-size:11.5px">
                Separation of duties: as the draw submitter you cannot approve this draw.
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="panel" style="margin-top:12px">
        <div className="panel-head">
          <h3>Draw account record</h3>
          <span className="right">Written only by the VirtualAccountService · exactly-once release</span>
        </div>
        {d.accountEvents.length === 0 ? (
          <p className="sub" style="padding:14px 16px">
            No release transition recorded. {released ? "" : "Funds are authorized only when every required role approves."}
          </p>
        ) : (
          <ul className="activity">
            {d.accountEvents.map((e) => (
              <li>
                <span className={`ico ${e.type === "RELEASED" ? "ok" : "warn"}`}>{icons.dollar()}</span>
                <span className="body">
                  <span className="msg">
                    <b>{e.type}</b> — {money(e.amount)} on the virtual project account (draw-scoped record)
                  </span>
                  <span className="meta"><span className="when">{fmtDate(e.createdAt)}</span></span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel panel-pad" style="margin-top:12px">
        <h3 style="margin:0 0 8px;font-size:13px">Draw Review Summary report</h3>
        {d.reports.length ? (
          <ul style="margin:0 0 10px;padding:0;list-style:none">
            {d.reports.map((r) => (
              <li style="font-size:12px;padding:3px 0">
                <a href={`/reports/file/${r.id}`} style="color:var(--action);font-weight:600">{r.filename}</a>{" "}
                <span className="sub">generated {fmtDate(r.generatedAt)} · ledger {r.integrityStatus}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a className="btn ghost sm" href={`/draw/${draw.id}/report`} target="_blank">Preview report</a>
          <form method="POST" action={`/api/draws/${draw.id}/report`}>
            <button className="btn sm" type="submit">Generate Draw Review Summary</button>
          </form>
        </div>
      </div>

      <div className="panel panel-pad" style="margin-top:12px">
        <h3 style="margin:0 0 8px;font-size:13px">Lender Draw Verification Package</h3>
        <p className="sub" style="margin:0 0 10px;font-size:12px">
          One standardized ZIP: lender PDF (decision summary, budget lines, evidence,
          reviewers, permits, invoices &amp; lien waivers, exceptions, approvals, retainage)
          plus structured CSV/JSON registers with a hashed manifest. Requested, supported,
          approved, released and retained amounts stay distinct.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a className="btn ghost sm" href={`/draw/${draw.id}/verification-package/preview`} target="_blank">Preview document</a>
          <form method="POST" action={`/api/draws/${draw.id}/verification-package`}>
            <button className="btn sm" type="submit" data-busy-label="Generating…">Generate Verification Package (ZIP)</button>
          </form>
        </div>
      </div>
    </>
  );
}

function renderActivityTab(d: DrawDetailData): VNode {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Draw activity</h3>
        <span className="right">Operational record — NOT the Evidence Ledger</span>
      </div>
      {d.events.length === 0 ? (
        <p className="sub" style="padding:14px 16px">No activity yet.</p>
      ) : (
        <ul className="activity">
          {[...d.events].reverse().map((e) => (
            <li>
              <span className={`ico ${e.type === "RELEASE_TRANSITION" ? "ok" : ["RETURNED", "CANCELLED"].includes(e.type) ? "bad" : "warn"}`}>
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
      )}
    </div>
  );
}

// ------------------------------------------------------------ report
// Draw Review Summary — printable, audit-grade. All figures come from the
// same stored records the detail page reads. Links out to the existing
// Funder Verification Report rather than duplicating it.

const DRAW_REPORT_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 9.5pt; line-height: 1.45; color: #16202e; padding: 28pt 34pt;
  }
  h1 { font-size: 19pt; margin: 0; letter-spacing: -0.015em; }
  h2 { font-size: 12pt; margin: 16pt 0 6pt; border-bottom: 1.5pt solid #111d33; padding-bottom: 3pt; break-after: avoid; }
  .muted { color: #5b6b7f; }
  table { width: 100%; border-collapse: collapse; font-size: 8.4pt; }
  th { text-align: left; font-size: 7.4pt; text-transform: uppercase; letter-spacing: .05em;
       color: #47566b; background: #eef1f6; padding: 4pt 6pt; border: .5pt solid #c5cedb; }
  td { padding: 4pt 6pt; border: .5pt solid #d8dfe8; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr { break-inside: avoid; }
  .tag { display: inline-block; font-size: 7pt; font-weight: 700; letter-spacing: .05em;
         border: .75pt solid #8d9bad; border-radius: 2pt; padding: .5pt 4pt; color: #34404f; white-space: nowrap; }
  .tag.ok { border-color: #15803d; color: #14532d; background: #f0f9f2; }
  .tag.warn { border-color: #b45309; color: #7c3d0a; background: #fdf6e9; }
  .tag.bad { border-color: #b91c1c; color: #7f1d1d; background: #fdf1f0; }
  .kpis { display: flex; flex-wrap: wrap; gap: 8pt; margin: 10pt 0; }
  .kpi { flex: 1 1 20%; border: .75pt solid #c5cedb; border-radius: 4pt; padding: 6pt 9pt; min-width: 90pt; }
  .kpi .l { font-size: 7pt; text-transform: uppercase; letter-spacing: .06em; color: #5b6b7f; font-weight: 700; }
  .kpi .v { font-size: 12.5pt; font-weight: 800; font-variant-numeric: tabular-nums; margin-top: 1pt; }
  .statement { border-left: 2.5pt solid #1e40af; background: #f4f6fa; padding: 7pt 10pt; margin: 10pt 0; font-size: 8.8pt; }
  ul.reasons { margin: 4pt 0; padding-left: 14pt; }
  ul.reasons li { margin: 2pt 0; }
  .cover-rule { height: 2.5pt; background: #111d33; margin: 10pt 0 12pt; }
`;

export interface DrawReportData {
  draw: DrawRequest;
  project: Project;
  lenderOrg: Organization | null;
  borrowerOrg: Organization | null;
  lines: DrawLineItem[];
  milestones: Milestone[];
  checklist: DrawChecklistRow[];
  evidenceRows: DrawEvidenceRow[];
  recommendation: DrawRecommendation;
  approval: ApprovalRequest | null;
  approvalRecords: ApprovalRecord[];
  accountEvents: DrawAccountEvent[];
  users: Map<string, User>;
  /** Budget vs verified progress (project + per line), with methodology. */
  financialProgress: FinancialProgress;
  physicalProgress: PhysicalProgressAssessment;
  lineComparisons: Map<string, DrawLineComparison>;
  contract: { original: number; approvedChanges: number; current: number };
  retainage: { rate: number; withheld: number; netEligible: number } | null;
  drawChangeOrders: Array<{ number: number; title: string; status: string; amount: number }>;
  generatedAt: string;
  generatedBy: User;
  ledger: { valid: boolean; entries: number; brokenAt?: number };
  funderReports: Report[];
}

export function renderDrawReport(d: DrawReportData): string {
  const { draw, recommendation: rec } = d;
  const released = d.accountEvents.find((e) => e.type === "RELEASED");
  return renderDocument(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{`Draw Review Summary — Draw #${draw.drawNumber} — ${d.project.name}`}</title>
        <style>{raw(DRAW_REPORT_CSS)}</style>
      </head>
      <body>
        <div style="display:flex;align-items:center;gap:9pt">
          <div style="width:30pt;height:30pt;border-radius:6pt;background:#1e40af;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11pt">OBV</div>
          <div>
            <div style="font-weight:800;font-size:12pt">OpenBuild Verify</div>
            <div className="muted" style="font-size:8pt">Draw Review Summary</div>
          </div>
          <div style="margin-left:auto;text-align:right" className="muted">
            <div style="font-size:8pt">Generated {fmtDate(d.generatedAt)}</div>
            <div style="font-size:8pt">By {d.generatedBy.name} ({roleLabel(d.generatedBy.role)})</div>
          </div>
        </div>
        <div className="cover-rule"></div>

        <h1>Draw Request #{draw.drawNumber}</h1>
        <p className="muted" style="margin:3pt 0 0">
          {d.project.name} · {d.project.location}
          {d.borrowerOrg ? ` · Requested by ${d.borrowerOrg.name}` : ""}
          {d.lenderOrg ? ` · Governed by ${d.lenderOrg.name}` : ""}
        </p>
        <p className="muted" style="margin:2pt 0 0">
          Period {draw.periodStart ?? "—"} → {draw.periodEnd ?? "—"} · Status: <b>{draw.status.replace(/_/g, " ")}</b>
        </p>

        <div className="kpis">
          <div className="kpi"><div className="l">Requested</div><div className="v">{money(rec.requestedAmount)}</div></div>
          <div className="kpi"><div className="l">Supported</div><div className="v">{money(rec.supportedAmount)}</div></div>
          <div className="kpi"><div className="l">Exception</div><div className="v">{money(rec.exceptionAmount)}</div></div>
          <div className="kpi"><div className="l">Retainage</div><div className="v">{money(rec.retainageAmount)}</div></div>
          <div className="kpi"><div className="l">Released</div><div className="v">{released ? money(released.amount) : "—"}</div></div>
        </div>

        <div className="statement">
          <b>Standing doctrine.</b> A draw request is a request for review and the
          reviewer recommendation is advisory — neither authorizes money. Release
          eligibility is created only by the formal approval workflow (
          {(d.approval?.requiredRoles ?? []).map((r) => roleLabel(r)).join(" + ") || "configured approval matrix"}
          ), and the release transition is recorded exactly once on the virtual
          project account. Linked evidence remains governed by the OBV
          verification pipeline and the tamper-evident Evidence Ledger
          {d.ledger.valid ? ` (chain INTACT, ${d.ledger.entries} entries at generation)` : ` (WARNING: chain TAMPERED at #${d.ledger.brokenAt})`}.
        </div>

        <h2>Recommendation — {RECOMMENDATION_LABEL[rec.result]}</h2>
        <ul className="reasons">
          {rec.reasons.map((r) => (
            <li>
              <b>{r.kind === "BLOCKER" ? "BLOCKER: " : r.kind === "EXCEPTION" ? "EXCEPTION: " : ""}</b>
              {r.detail}{r.amount != null ? ` (${money(r.amount)})` : ""}
            </li>
          ))}
        </ul>
        {draw.reviewSummary ? <p className="muted">Reviewer summary: {draw.reviewSummary}</p> : null}

        <h2>Line-item register</h2>
        <table>
          <thead>
            <tr>
              <th>Line</th><th>Milestone</th><th className="num">Scheduled</th>
              <th className="num">Prev. paid</th><th className="num">This draw</th>
              <th className="num">Stored</th><th className="num">Retainage</th>
              <th className="num">Balance</th><th>% claimed / verified</th><th>Status</th><th>Review notes</th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr>
                <td>{l.description}{l.budgetLineId ? <span className="muted"> · {l.budgetLineId}</span> : null}</td>
                <td>{l.milestoneId ? `M${d.milestones.find((m) => m.id === l.milestoneId)?.seq ?? "?"}` : "—"}</td>
                <td className="num">{money(l.scheduledValue)}</td>
                <td className="num">{money(l.previouslyPaid)}</td>
                <td className="num"><b>{money(l.currentRequested)}</b></td>
                <td className="num">{l.materialsStored != null ? money(l.materialsStored) : "—"}</td>
                <td className="num">{l.retainageAmount != null ? money(l.retainageAmount) : "—"}</td>
                <td className="num">{money(l.balanceToFinish)}</td>
                <td>{l.percentCompleteClaimed ?? "—"}% / {l.percentCompleteVerified ?? "—"}%</td>
                <td>
                  <span className={`tag ${l.status === "SUPPORTED" ? "ok" : l.status === "PENDING" ? "" : l.status === "REJECTED" ? "bad" : "warn"}`}>
                    {l.status.replace(/_/g, " ")}
                  </span>
                </td>
                <td>{l.reviewNotes ?? "—"}</td>
              </tr>
            ))}
            <tr>
              <td><b>Total</b></td><td></td>
              <td className="num"><b>{money(d.lines.reduce((s, l) => s + l.scheduledValue, 0))}</b></td>
              <td className="num"><b>{money(d.lines.reduce((s, l) => s + l.previouslyPaid, 0))}</b></td>
              <td className="num"><b>{money(d.lines.reduce((s, l) => s + l.currentRequested, 0))}</b></td>
              <td className="num"><b>{money(d.lines.reduce((s, l) => s + (l.materialsStored ?? 0), 0))}</b></td>
              <td className="num"><b>{money(d.lines.reduce((s, l) => s + (l.retainageAmount ?? 0), 0))}</b></td>
              <td className="num"><b>{money(d.lines.reduce((s, l) => s + l.balanceToFinish, 0))}</b></td>
              <td></td><td></td><td></td>
            </tr>
          </tbody>
        </table>

        <h2>Document checklist</h2>
        <table>
          <thead>
            <tr><th>Requirement</th><th>State</th><th>Documents on file</th></tr>
          </thead>
          <tbody>
            {d.checklist.map((row) => (
              <tr>
                <td>{row.requirement ? `${row.requirement.title}${row.requirement.required ? " (required)" : ""}` : "Unassigned documents"}</td>
                <td>
                  <span className={`tag ${row.state === "ACCEPTED" ? "ok" : row.state === "RECEIVED" ? "" : row.state === "MISSING" || row.state === "REJECTED" ? "bad" : "warn"}`}>
                    {row.state}
                  </span>
                </td>
                <td>
                  {row.documents.length === 0
                    ? "—"
                    : row.documents.map((doc) => `${doc.title} [${doc.status}]`).join("; ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style="font-size:8pt">
          Documents are administrative records. They are never treated as verified physical progress.
        </p>

        <h2>Evidence references</h2>
        {d.evidenceRows.length === 0 ? (
          <p className="muted">No evidence linked to this draw.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Evidence</th><th>Milestone</th><th>Captured</th><th>Verification</th><th>Ledger entry</th><th>Linked to</th></tr>
            </thead>
            <tbody>
              {d.evidenceRows.map((r) => (
                <tr>
                  <td style="font-family:monospace;font-size:7.6pt">{r.link.evidenceItemId.slice(0, 12)}…</td>
                  <td>{r.milestone ? `M${r.milestone.seq} · ${r.milestone.title}` : "—"}</td>
                  <td>{r.evidence ? fmtDate(r.evidence.capturedAt) : "—"}</td>
                  <td>
                    {r.verification ? (
                      <span className={`tag ${r.verification.verdict === "VERIFIED" ? "ok" : r.verification.verdict === "REJECTED" ? "bad" : "warn"}`}>
                        {r.verification.verdict.replace(/_/g, " ")} · {(r.verification.confidence * 100).toFixed(0)}%
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{r.ledgerEntry ? `#${r.ledgerEntry.seq}` : "—"}</td>
                  <td>{r.line ? r.line.description : "Draw-level"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style="font-size:8pt">
          Evidence records are referenced, not copied — each remains governed by the
          OBV verification pipeline and hash-chained Evidence Ledger.
          {d.funderReports.length
            ? ` Full evidence detail: see Funder Verification Report(s) ${d.funderReports.map((r) => r.filename).join(", ")}.`
            : ""}
        </p>

        <h2>Budget vs verified physical progress</h2>
        <p className="muted" style="font-size:8.4pt;margin:2pt 0 6pt">
          Financial progress and physical progress are different measurements — compared side by
          side, never merged. A variance means financial progress is ahead of currently verified
          physical progress; it is not a finding about conduct.
        </p>
        <table>
          <tbody>
            <tr><td style="width:34%;color:#5b6b7f">Project financial progress (paid + claimed)</td>
              <td>{d.financialProgress.dataComplete ? `${d.financialProgress.claimedPct}% of ${money(d.financialProgress.budgetBasis)} (paid ${d.financialProgress.paidPct}%)` : "DATA INCOMPLETE"}</td></tr>
            <tr><td style="color:#5b6b7f">Verified physical progress</td>
              <td>{d.physicalProgress.verifiedPct}% (weights: {d.physicalProgress.weightSource.replace(/_/g, " ").toLowerCase()})</td></tr>
            <tr><td style="color:#5b6b7f">Variance</td>
              <td>
                {d.financialProgress.dataComplete
                  ? `${d.financialProgress.variancePts > 0 ? "+" : ""}${d.financialProgress.variancePts} percentage points — ${VARIANCE_META[d.financialProgress.varianceState].label}`
                  : "DATA INCOMPLETE"}
              </td></tr>
          </tbody>
        </table>
        {d.lines.length ? (
          <table style="margin-top:6pt">
            <thead>
              <tr><th>Line</th><th className="num">Financial</th><th className="num">Verified physical</th><th>Progress variance</th></tr>
            </thead>
            <tbody>
              {d.lines.map((l) => {
                const cmp = d.lineComparisons.get(l.id);
                return (
                  <tr>
                    <td>{l.description}</td>
                    <td className="num">{cmp?.financialPct != null ? `${cmp.financialPct}%` : "—"}</td>
                    <td className="num">{cmp?.verifiedPct != null ? `${cmp.verifiedPct}%` : "—"}</td>
                    <td>
                      <span className={`tag ${cmp ? (cmp.varianceState === "WITHIN_RANGE" ? "ok" : cmp.varianceState === "FINANCIAL_AHEAD" ? "bad" : cmp.varianceState === "DATA_INCOMPLETE" ? "" : "warn") : ""}`}>
                        {cmp ? VARIANCE_META[cmp.varianceState].label : "—"}
                      </span>
                      {cmp?.exceptionCandidate ? " exception candidate (advisory)" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        <p className="muted" style="font-size:7.6pt">
          Methodology: {d.physicalProgress.methodology}
        </p>

        <h2>Contract, change orders &amp; retainage</h2>
        <table>
          <tbody>
            <tr><td style="width:34%;color:#5b6b7f">Original contract / project value</td><td>{money(d.contract.original)}</td></tr>
            <tr><td style="color:#5b6b7f">Approved change orders</td><td>{d.contract.approvedChanges !== 0 ? money(d.contract.approvedChanges) : "—"}</td></tr>
            <tr><td style="color:#5b6b7f">Current contract / project value</td><td><b>{money(d.contract.current)}</b></td></tr>
            <tr><td style="color:#5b6b7f">Gross supported (this draw)</td><td>{d.draw.recommendedAmount !== null ? money(d.draw.recommendedAmount) : "Not finalized"}</td></tr>
            <tr><td style="color:#5b6b7f">Retainage withheld</td>
              <td>{d.retainage ? `${money(d.retainage.withheld)} (${d.retainage.rate}%)` : "None (no policy or not finalized)"}</td></tr>
            <tr><td style="color:#5b6b7f">Net recommended release</td>
              <td><b>{d.retainage ? money(d.retainage.netEligible) : d.draw.recommendedAmount !== null ? money(d.draw.recommendedAmount) : "—"}</b></td></tr>
          </tbody>
        </table>
        {d.drawChangeOrders.length > 0 ? (
          <>
            <p className="muted" style="font-size:8.4pt;margin:6pt 0 2pt"><b>Change orders affecting this draw:</b></p>
            <table>
              <thead><tr><th>CO #</th><th>Title</th><th>Status</th><th className="num">Line amount</th></tr></thead>
              <tbody>
                {d.drawChangeOrders.map((co) => (
                  <tr>
                    <td>CO-{co.number}</td>
                    <td>{co.title}</td>
                    <td>
                      <span className={`tag ${["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(co.status) ? "ok" : "bad"}`}>
                        {co.status.replace(/_/g, " ")}{["APPROVED", "PARTIALLY_APPROVED", "IMPLEMENTED"].includes(co.status) ? "" : " — UNAPPROVED CHANGE COST"}
                      </span>
                    </td>
                    <td className="num">{money(co.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        <h2>Governance &amp; financial state</h2>
        <table>
          <tbody>
            <tr><td style="width:34%;color:#5b6b7f">Approval request</td>
              <td>{d.approval ? `${d.approval.status} — requires ${d.approval.requiredRoles.map((r) => roleLabel(r)).join(" + ")}` : "Not opened"}</td></tr>
            {d.approvalRecords.map((r) => (
              <tr>
                <td style="color:#5b6b7f">{roleLabel(r.role)}</td>
                <td>{r.decision} by {d.users.get(r.userId)?.name ?? "—"} at {fmtDate(r.createdAt)}</td>
              </tr>
            ))}
            <tr><td style="color:#5b6b7f">Approved amount</td><td>{draw.approvedAmount !== null ? money(draw.approvedAmount) : "—"}</td></tr>
            <tr><td style="color:#5b6b7f">Release transition</td>
              <td>{released ? `RELEASED ${money(released.amount)} at ${fmtDate(released.createdAt)} (exactly-once, VirtualAccountService)` : "None — draw funds not released"}</td></tr>
            <tr><td style="color:#5b6b7f">Evidence Ledger integrity</td>
              <td>{d.ledger.valid ? `INTACT — ${d.ledger.entries} entries` : `TAMPERED at #${d.ledger.brokenAt}`}</td></tr>
          </tbody>
        </table>

        <p className="muted" style="font-size:8pt;margin-top:14pt">
          OBV demonstration environment — the virtual project account is financial
          control state, not real bank movement. Draw figures are review-layer
          records; milestone tranche HELD/RELEASED state is governed separately by
          the milestone verification workflow.
        </p>
      </body>
    </html>
  );
}
