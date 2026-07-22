/**
 * Construction Draw Request pages — lender-native review workspace.
 *
 * Presentation layer only. Every action posts to a governed API route;
 * nothing rendered here can change financial state directly. The pages
 * repeat the doctrine on purpose: a draw request asks for review, a
 * recommendation advises, and only the formal approval workflow creates
 * release eligibility.
 */
import { h, Fragment, VNode, Child, renderDocument, raw } from "./jsx";
import { icons } from "./icons";
import {
  AppShell,
  NavContext,
  PageHeader,
  VerdictChip,
  fmtDate,
  money,
  roleLabel,
  Metric,
  MetricStrip,
  MetricData,
  AttentionBanner,
  SectionHead,
  EmptyStateV2,
  Methodology,
  enumLabel,
  shortHash,
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
import type {
  DrawInspection, DrawInspectionEvent, DrawInspectionLine, DrawInspectionReportVersion,
  DrawPolicyApplication, DrawStageEvent, DrawWorkflowStage, ExternalFundingRecord,
  JurisdictionProfile, LenderDecisionCondition, LenderDrawDecision, LenderDrawPolicy,
  LienWaiverRecord, LoanAsset, LoanOwnershipEvent, LoanServicingEvent, ProjectPartyAssignment,
  BankTransaction, PaymentInstruction, ProjectAccountHold, ProjectVirtualAccount,
} from "../../shared/types";
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
  READY_FOR_GOVERNANCE: "Ready for governance",
  HOLD_DOCUMENTS_MISSING: "Hold — documents missing",
  HOLD_EVIDENCE_NEEDS_REVIEW: "Hold — evidence needs review",
  HOLD_OPEN_HIGH_SEVERITY_ISSUE: "Hold — open high-severity issue",
  PARTIAL_SUPPORT: "Partial support",
  RETURN_FOR_CLARIFICATION: "Return for clarification",
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
      <div className="metric-strip">
        <Metric d={{ value: String(active.length), label: "Active draw requests", sub: active.length > 0 ? "In the review pipeline" : "None active", dim: active.length === 0 }} />
        <Metric d={{ value: String(inReview.length), label: "In lender review", sub: inReview.length > 0 ? "Documents and evidence being checked" : "Review queue clear", dim: inReview.length === 0 }} />
        <Metric d={{ value: String(awaitingGov.length), label: "Awaiting formal approval", tone: awaitingGov.length > 0 ? "warn" : undefined, edge: awaitingGov.length > 0 ? "warn" : undefined, sub: awaitingGov.length > 0 ? "Review complete — roles must sign" : "Nothing at governance", dim: awaitingGov.length === 0 }} />
        <Metric d={{ value: String(released.length), label: "Released", tone: released.length > 0 ? "ok" : undefined, sub: "Through governed approval only", dim: released.length === 0 }} />
      </div>
      <div className="panel">
        <div className="panel-head">
          <h3>Draw register</h3>
          <span className="right">{input.rows.length} draw{input.rows.length === 1 ? "" : "s"}</span>
        </div>
        {input.rows.length === 0 ? (
          <EmptyStateV2
            icon={icons.dollar()}
            title="No draw requests yet"
            what="Draw requests run the governed review: budget lines, required documents, field-evidence support, exceptions and formal approval. None have been submitted for this portfolio."
            condition="healthy"
            action={input.canCreate ? <a className="btn secondary sm" href="/draws/new">Create the first draw request</a> : undefined}
          />
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
      <div className="work-grid">
      <div className="panel panel-pad">
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
      <div>
        <Methodology title="What happens next">
          <p>
            The draft opens a workspace where budget-line items, required documents and
            field-evidence support are attached. Submission starts the lender review;
            a review recommendation advises, and only the formal approval workflow can
            make funds release-eligible.
          </p>
        </Methodology>
      </div>
      </div>
    </AppShell>
  );
}

// ------------------------------------------------------------ detail

export type DrawTab =
  | "overview" | "lines" | "evidence" | "documents" | "exceptions"
  | "review" | "governance" | "activity" | "lender";

/**
 * Lender Review workspace data — assembled entirely on the server from
 * authoritative stored records (services + lender repository). The view
 * never derives lender facts: anything absent renders as "Not recorded".
 */
export interface LenderTabData {
  /** drawWorkflow.deriveDrawStage — the single derived stage. */
  stage: DrawWorkflowStage | null;
  stageHistory: DrawStageEvent[];
  /** One deterministic next action label + detail, mapped server-side
   *  from the derived stage and stored records (no second workflow). */
  nextAction: { title: string; detail: string };
  loan: LoanAsset | null;
  ownershipHistory: LoanOwnershipEvent[];
  servicingHistory: LoanServicingEvent[];
  parties: ProjectPartyAssignment[];
  jurisdiction: JurisdictionProfile | null;
  appliedPolicy: { application: DrawPolicyApplication | null; policy: LenderDrawPolicy | null };
  inspections: Array<{
    inspection: DrawInspection;
    lines: DrawInspectionLine[];
    versions: DrawInspectionReportVersion[];
    events: DrawInspectionEvent[];
  }>;
  /** Full decision chain, newest first; superseded rows stay visible. */
  decisions: LenderDrawDecision[];
  currentDecision: LenderDrawDecision | null;
  /** Conditions of the CURRENT decision. */
  conditions: LenderDecisionCondition[];
  waivers: LienWaiverRecord[];
  funding: ExternalFundingRecord[];
  /** Derived payment status — never a mutation of the decision. */
  paymentStatus: { status: string; disbursedTotal: number } | null;
  /** Server-enforced capability flags for rendering action controls.
   *  Convenience only: every POST re-authorizes in the service layer. */
  caps: {
    scheduleInspection: boolean;
    recordFindings: boolean;
    finalizeReport: boolean;
    reviewDraw: boolean;
    lenderDecision: boolean;
    recordFunding: boolean;
  };
  orgs: Map<string, Organization>;
  /** Existing generated verification packages for THIS draw (download via
   *  the existing /reports/file/:id route — no second generator). */
  packageReports: Report[];
  /** Read-only VAM summary: linked project virtual account, active holds,
   *  this draw's latest payment instruction and bank-reported transaction,
   *  reconciliation state. Never an action surface — lender-review forms
   *  cannot settle or transfer money; the workspace link is the way in.
   *  NULL when the viewer lacks VIEW_PROJECT_ACCOUNT: banking data keeps
   *  its own capability boundary even inside the lender tab. */
  banking: {
    account: ProjectVirtualAccount | null;
    activeHolds: ProjectAccountHold[];
    latestInstruction: PaymentInstruction | null;
    latestTransaction: BankTransaction | null;
    reconciliationState: string | null;
  } | null;
  /** Post-redirect notice (?ok= / ?err=). */
  notice: { kind: "ok" | "err"; text: string } | null;
}

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
  /** Six-gate summary + eligibility per line milestone (Part 8). */
  lineMilestoneGates: Map<string, { summary: string; eligibility: string; blocking: string[] }>;
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
  /** Lender Review workspace data (assembled only for tab === "lender"). */
  lender: LenderTabData | null;
}

const TABS: Array<{ key: DrawTab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "lines", label: "Line Items" },
  { key: "evidence", label: "Evidence" },
  { key: "documents", label: "Documents" },
  { key: "exceptions", label: "Exceptions" },
  { key: "review", label: "Review" },
  { key: "governance", label: "Governance" },
  { key: "lender", label: "Lender Review" },
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
      {d.tab === "lender" && d.lender ? renderLenderTab(d, d.lender) : null}
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
                        {l.milestoneId && d.lineMilestoneGates.get(l.milestoneId) ? (
                          <span className="sub" style="display:block;font-size:10px;margin-top:2px">
                            {d.lineMilestoneGates.get(l.milestoneId)!.summary}
                            {d.lineMilestoneGates.get(l.milestoneId)!.blocking.length ? (
                              <span style="color:var(--bad);display:block">
                                Blocked: {d.lineMilestoneGates.get(l.milestoneId)!.blocking.join("; ")}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
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
        <h4 style="margin:6px 0 4px;font-size:12px;color:var(--ink-3)">Reasons</h4>
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

const NOT_RECORDED = "Not recorded";

function lenderChipTone(v: string): string {
  if (["ACCEPTED", "PASSED", "APPROVED", "SATISFIED", "DISBURSED", "FINALIZED", "CLOSED", "REVIEWED"].includes(v)) return "chip ok";
  if (["REJECTED", "FAILED", "REVERSED", "CANCELLED", "EXPIRED", "CORRECTION_REQUIRED", "REINSPECTION_REQUIRED", "NOT_ACCEPTED"].includes(v)) return "chip bad";
  return "chip";
}

function LenderChip(props: { v: string | null | undefined }): VNode {
  const v = props.v ?? null;
  if (!v) return <span className="chip dim">{NOT_RECORDED}</span>;
  return <span className={lenderChipTone(v)}>{enumLabel(v)}</span>;
}

function kvRow(k: string, v: Child): VNode {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v ?? NOT_RECORDED}</dd>
    </>
  );
}

function orgName(L: LenderTabData, id: string | null | undefined): string {
  if (!id) return NOT_RECORDED;
  return L.orgs.get(id)?.name ?? id;
}

function lenderDate(v: string | null | undefined): string {
  return v ? fmtDate(v) : NOT_RECORDED;
}

/** Section A — decision summary metric strip (absent values recede). */
function lenderMetricStrip(d: DrawDetailData, L: LenderTabData): VNode {
  const latestInsp = L.inspections.length ? L.inspections[L.inspections.length - 1].inspection : null;
  const openConds = L.conditions.filter((c) => !["SATISFIED", "WAIVED"].includes(c.status)).length;
  const outstandingWaivers = L.waivers.filter((w) =>
    ["REQUIRED", "REQUESTED", "RECEIVED", "UNDER_REVIEW", "REJECTED", "EXPIRED"].includes(w.status)
  ).length;
  const metrics: MetricData[] = [
    { value: L.stage ? enumLabel(L.stage) : NOT_RECORDED, label: "Derived stage", dim: !L.stage },
    { value: latestInsp ? enumLabel(latestInsp.status) : NOT_RECORDED, label: "Independent inspection", dim: !latestInsp },
    { value: L.currentDecision ? enumLabel(L.currentDecision.decision) : NOT_RECORDED, label: "Lender decision", dim: !L.currentDecision },
    { value: String(openConds), label: "Open conditions", dim: openConds === 0, tone: openConds > 0 ? "warn" : undefined },
    {
      value: L.waivers.length === 0 ? NOT_RECORDED : outstandingWaivers > 0 ? `${outstandingWaivers} outstanding` : "Settled",
      label: "Lien waivers",
      dim: L.waivers.length === 0,
      tone: outstandingWaivers > 0 ? "warn" : undefined,
    },
    {
      value: L.paymentStatus ? enumLabel(L.paymentStatus.status) : NOT_RECORDED,
      label: "External funding",
      dim: !L.paymentStatus,
      sub: L.paymentStatus && L.paymentStatus.disbursedTotal > 0 ? `${money(L.paymentStatus.disbursedTotal)} disbursed` : undefined,
    },
  ];
  return <MetricStrip metrics={metrics} />;
}

/** Section C — loan and project context. */
function lenderContext(d: DrawDetailData, L: LenderTabData): VNode {
  const loan = L.loan;
  return (
    <div className="lender-grid">
      <section className="panel">
        <div className="panel-head"><h3>Loan and asset</h3><span className="right">External servicing reference — the OBV project budget stays authoritative</span></div>
        <div className="pad-sm">
          {loan ? (
            <dl className="kv">
              {kvRow("Loan number", loan.loanNumber)}
              {kvRow("Property", loan.propertyAddress ?? NOT_RECORDED)}
              {kvRow("Original lender", orgName(L, loan.lenderOrganizationId))}
              {kvRow("Current owner", orgName(L, loan.currentLoanOwnerOrganizationId))}
              {kvRow("Servicer", orgName(L, loan.currentServicerOrganizationId))}
              {kvRow("Maturity", loan.currentMaturityDate ?? loan.originalMaturityDate ?? NOT_RECORDED)}
              {kvRow("Construction reserve", loan.currentConstructionReserve !== null ? money(loan.currentConstructionReserve) : NOT_RECORDED)}
              {kvRow("Loan amount", loan.currentLoanAmount !== null ? money(loan.currentLoanAmount) : NOT_RECORDED)}
            </dl>
          ) : (
            <p className="muted">{NOT_RECORDED} — no loan profile exists for this project.</p>
          )}
          {L.ownershipHistory.length > 0 ? (
            <p className="sub">Ownership history: {L.ownershipHistory.map((e) => `${orgName(L, e.newOwnerOrganizationId)} (${e.effectiveAt})`).join(" → ")}</p>
          ) : null}
          {L.servicingHistory.length > 0 ? (
            <p className="sub">Servicing history: {L.servicingHistory.map((e) => `${orgName(L, e.newServicerOrganizationId)} (${e.effectiveAt})`).join(" → ")}</p>
          ) : null}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h3>Parties, jurisdiction and policy</h3></div>
        <div className="pad-sm">
          {L.parties.length > 0 ? (
            <dl className="kv">
              {L.parties.filter((pa) => pa.active).map((pa) => kvRow(enumLabel(pa.partyType), orgName(L, pa.partyOrganizationId)))}
            </dl>
          ) : (
            <p className="muted">Project parties: {NOT_RECORDED}.</p>
          )}
          <dl className="kv" style="margin-top:8px">
            {kvRow("Jurisdiction", L.jurisdiction ? `${L.jurisdiction.jurisdictionName}${L.jurisdiction.permitAuthority ? ` · ${L.jurisdiction.permitAuthority}` : ""}` : NOT_RECORDED)}
            {kvRow(
              "Applied lender policy",
              L.appliedPolicy.application
                ? `Version ${L.appliedPolicy.application.policyVersion} · frozen at first submission (${fmtDate(L.appliedPolicy.application.appliedAt)})`
                : NOT_RECORDED
            )}
          </dl>
          <p className="sub">
            The stored lender policy configures lender workflow preferences only. OBV integrity rules —
            evidence verification, permits, formal governance, exactly-once release — are not
            overridable by policy.
          </p>
        </div>
      </section>
    </div>
  );
}

/** Governed action forms. Rendered only when the signed-in user holds the
 *  relevant server-enforced capability AND the record state allows the
 *  action; the browser controls are convenience only — every POST
 *  re-authorizes in the service layer. */
function inspectionForms(d: DrawDetailData, L: LenderTabData, x: LenderTabData["inspections"][number]): VNode | null {
  const i = x.inspection;
  const api = (a: string) => `/api/draw-inspections/${i.id}/${a}`;
  const draft = x.versions.find((v) => v.status === "DRAFT") ?? null;
  const forms: VNode[] = [];
  if (L.caps.scheduleInspection && ["REQUESTED", "SCHEDULING", "ACCESS_FAILED"].includes(i.status)) {
    forms.push(
      <form method="POST" action={api("schedule")} className="lender-form">
        <div className="row">
          <label>Site visit date<input type="date" name="scheduledAt" required /></label>
          <button className="btn sm" type="submit">Schedule site visit</button>
        </div>
      </form>
    );
  }
  if (L.caps.recordFindings && i.status === "SCHEDULED") {
    forms.push(
      <form method="POST" action={api("complete")} className="lender-form">
        <div className="row"><button className="btn sm" type="submit">Complete site visit</button></div>
      </form>
    );
    forms.push(
      <form method="POST" action={api("access-failed")} className="lender-form">
        <div className="row">
          <label>Access failure note<input type="text" name="note" placeholder="Gate locked, no contact on site" /></label>
          <button className="btn sm ghost" type="submit">Record access failure</button>
        </div>
      </form>
    );
  }
  if (L.caps.recordFindings && ["COMPLETED", "REPORT_PENDING"].includes(i.status)) {
    forms.push(
      <form method="POST" action={api("lines")} className="lender-form">
        <div className="row">
          <label>Draw line
            <select name="drawLineItemId">
              {d.lines.map((l) => <option value={l.id}>{l.description.slice(0, 48)}</option>)}
            </select>
          </label>
          <label>Observed complete %<input type="number" name="percentCompleteReported" min="0" max="100" step="1" /></label>
          <label>Inspector note<input type="text" name="inspectorNote" /></label>
          <button className="btn sm" type="submit">Record line finding</button>
        </div>
      </form>
    );
  }
  if (L.caps.recordFindings && !draft && ["COMPLETED", "REPORT_PENDING", "CORRECTION_REQUIRED"].includes(i.status)) {
    forms.push(
      <form method="POST" action={api("report")} className="lender-form">
        <div className="row">
          <label>Report summary<input type="text" name="summary" required /></label>
          <label>Conclusion<input type="text" name="conclusion" /></label>
          {i.status === "CORRECTION_REQUIRED" ? <label>Correction reason<input type="text" name="correctionReason" required /></label> : null}
          <button className="btn sm" type="submit">Create report draft</button>
        </div>
      </form>
    );
  }
  if (L.caps.finalizeReport && draft) {
    forms.push(
      <form method="POST" action={`/api/inspection-reports/${draft.id}/finalize`} className="lender-form">
        <div className="row"><button className="btn sm" type="submit">Finalize report v{draft.version}</button>
        <span className="sub">Finalized versions are immutable; corrections create a new version.</span></div>
      </form>
    );
  }
  if (L.caps.reviewDraw && i.status === "UNDER_OBV_REVIEW") {
    forms.push(
      <form method="POST" action={api("obv-review")} className="lender-form">
        <div className="row">
          <label>OBV completeness review
            <select name="outcome"><option value="REVIEWED">Reviewed</option><option value="CORRECTION_REQUIRED">Correction required</option></select>
          </label>
          <label>Note<input type="text" name="note" /></label>
          <button className="btn sm" type="submit">Record OBV review</button>
        </div>
      </form>
    );
  }
  if (L.caps.lenderDecision && i.status === "FINALIZED" && i.lenderAcceptanceStatus === "PENDING") {
    forms.push(
      <form method="POST" action={api("accept")} className="lender-form">
        <div className="row">
          <label>Note<input type="text" name="note" /></label>
          <button className="btn sm" type="submit" name="accepted" value="true">Accept report</button>
          <button className="btn sm ghost" type="submit" name="accepted" value="false">Decline report</button>
        </div>
      </form>
    );
  }
  if (L.caps.scheduleInspection && ["FINALIZED", "FAILED", "CORRECTION_REQUIRED"].includes(i.status)) {
    forms.push(
      <form method="POST" action={api("reinspection")} className="lender-form">
        <div className="row">
          <label>Reinspection reason<input type="text" name="reason" required /></label>
          <button className="btn sm ghost" type="submit">Request reinspection</button>
        </div>
      </form>
    );
  }
  if (forms.length === 0) return null;
  return <>{forms}</>;
}

/** Section D — independent draw inspections. */
function lenderInspections(d: DrawDetailData, L: LenderTabData): VNode {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Independent draw inspection</h3>
        <span className="right">Lender-ordered — separate from government/jurisdictional inspections</span>
      </div>
      {L.inspections.length === 0 ? (
        <div className="pad-sm">
          <p className="muted">{NOT_RECORDED} — no independent inspection has been ordered for this draw.</p>
          {L.caps.scheduleInspection && !["CANCELLED", "RETURNED", "DRAFT"].includes(d.draw.status) ? (
            <form method="POST" action={`/api/draws/${d.draw.id}/inspections`} className="lender-form">
              <div className="row">
                <label>Inspector name<input type="text" name="inspectorDisplayName" placeholder="Site inspector" /></label>
                <button className="btn sm" type="submit">Order independent inspection</button>
              </div>
            </form>
          ) : null}
        </div>
      ) : (
        L.inspections.map(({ inspection: i, lines, versions }) => {
          const finalized = versions.filter((v) => v.status === "FINALIZED");
          const latestReport = finalized.length ? finalized[finalized.length - 1] : null;
          return (
            <div className="pad-sm lender-insp">
              <div className="li-head">
                <span className="li-title">
                  {enumLabel(i.inspectionType)} · ordered {lenderDate(i.requestedAt)}
                  {i.reinspectionOfInspectionId ? <span className="chip warn" style="margin-left:6px">Reinspection</span> : null}
                </span>
                <LenderChip v={i.status} />
              </div>
              <dl className="kv">
                {kvRow("Inspector", i.inspectorDisplayName ?? (i.inspectorUserId ? d.users.get(i.inspectorUserId)?.name ?? i.inspectorUserId : NOT_RECORDED))}
                {kvRow("Company", orgName(L, i.inspectionCompanyOrganizationId))}
                {kvRow("Scheduled", lenderDate(i.scheduledAt))}
                {kvRow("Site visit completed", lenderDate(i.completedAt))}
                {kvRow("Access result", i.status === "ACCESS_FAILED" ? "Access failed" : i.completedAt ? "Access obtained" : NOT_RECORDED)}
                {kvRow("Report version", latestReport ? `v${latestReport.version} · ${latestReport.documentHash ? shortHash(latestReport.documentHash) : "no document hash"}` : versions.length ? `v${versions[versions.length - 1].version} (draft)` : NOT_RECORDED)}
                {kvRow("OBV review", <LenderChip v={i.obvReviewStatus === "PENDING" ? null : i.obvReviewStatus} />)}
                {kvRow("Lender acceptance", <LenderChip v={i.lenderAcceptanceStatus === "PENDING" ? null : i.lenderAcceptanceStatus} />)}
              </dl>
              {lines.length > 0 ? (
                <>
                  <div className="desktop-only table-scroll">
                    <table className="lender-table">
                      <thead><tr><th>Line</th><th className="num">Claimed</th><th className="num">Observed</th><th className="num">Supported</th><th>Inspector note</th></tr></thead>
                      <tbody>
                        {lines.map((f) => {
                          const dl = f.drawLineItemId ? d.lines.find((x) => x.id === f.drawLineItemId) : null;
                          return (
                            <tr>
                              <td>{dl ? dl.description : "Unlinked finding"}</td>
                              <td className="num">{dl?.percentCompleteClaimed != null ? `${dl.percentCompleteClaimed}%` : "—"}</td>
                              <td className="num">{f.percentCompleteReported != null ? `${f.percentCompleteReported}%` : "—"}</td>
                              <td className="num">{dl?.supportedAmount != null ? money(dl.supportedAmount) : dl?.status === "SUPPORTED" ? money(dl.currentRequested) : "—"}</td>
                              <td>{f.inspectorNote ?? "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="mobile-only">
                    {lines.map((f) => {
                      const dl = f.drawLineItemId ? d.lines.find((x) => x.id === f.drawLineItemId) : null;
                      return (
                        <div className="rec-card">
                          <span className="rc-top"><span className="rc-title">{dl ? dl.description : "Unlinked finding"}</span></span>
                          <span className="rc-kv">
                            <span className="k">Claimed</span><span className="v num">{dl?.percentCompleteClaimed != null ? `${dl.percentCompleteClaimed}%` : "—"}</span>
                            <span className="k">Observed</span><span className="v num">{f.percentCompleteReported != null ? `${f.percentCompleteReported}%` : "—"}</span>
                            <span className="k">Supported</span><span className="v num">{dl?.supportedAmount != null ? money(dl.supportedAmount) : dl?.status === "SUPPORTED" ? money(dl.currentRequested) : "—"}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <p className="sub">Line findings: {NOT_RECORDED}.</p>
              )}
              {inspectionForms(d, L, { inspection: i, lines, versions, events: [] })}
            </div>
          );
        })
      )}
    </section>
  );
}

/** Section E — lender decision and conditions. */
function lenderDecisionSection(d: DrawDetailData, L: LenderTabData): VNode {
  const cur = L.currentDecision;
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Lender decision</h3>
        <span className="right">A lender business decision — recorded after, and never a substitute for, formal governance approval</span>
      </div>
      <div className="pad-sm">
        {cur ? (
          <>
            <div className="li-head">
              <span className="li-title">{enumLabel(cur.decision)} · {cur.decisionAt ? fmtDate(cur.decisionAt) : "pending"} · {d.users.get(cur.reviewerUserId)?.name ?? cur.reviewerUserId}</span>
              <LenderChip v={cur.decision} />
            </div>
            <dl className="kv">
              {kvRow("Requested (snapshot)", money(cur.requestedAmount))}
              {kvRow("Verified (line review)", cur.verifiedAmount !== null ? money(cur.verifiedAmount) : NOT_RECORDED)}
              {kvRow("Recommended (advisory)", cur.recommendedAmount !== null ? money(cur.recommendedAmount) : NOT_RECORDED)}
              {kvRow("Approved", cur.approvedAmount !== null ? money(cur.approvedAmount) : NOT_RECORDED)}
              {kvRow(
                "Reconciliation",
                (() => {
                  const parts: string[] = [];
                  if (cur.reducedAmount) parts.push(`${money(cur.reducedAmount)} reduced`);
                  if (cur.rejectedAmount) parts.push(`${money(cur.rejectedAmount)} rejected`);
                  if (cur.holdbackAmount) parts.push(`${money(cur.holdbackAmount)} holdback`);
                  const disposed = (cur.approvedAmount ?? 0) + (cur.reducedAmount ?? 0) + (cur.rejectedAmount ?? 0);
                  return parts.length ? parts.join(" · ") : disposed === cur.requestedAmount ? "Fully disposed" : "—";
                })()
              )}
              {kvRow("Reason", cur.decisionReason ?? NOT_RECORDED)}
              {kvRow("Governance reference", cur.approvalRequestId ? `Approval ${cur.approvalRequestId.slice(0, 8)}…` : NOT_RECORDED)}
            </dl>
            {L.decisions.length > 1 ? (
              <p className="sub">
                Decision chain:{" "}
                {L.decisions.map((x) => `${enumLabel(x.decision)}${x.supersededByDecisionId ? " (superseded)" : " (current)"}`).join(" ← ")}
              </p>
            ) : null}
          </>
        ) : (
          <p className="muted">{NOT_RECORDED} — no lender business decision has been recorded for this draw.</p>
        )}
        {L.caps.lenderDecision && (!cur || cur.decision === "PENDING") ? (
          <form method="POST" action={`/api/draws/${d.draw.id}/lender-decision`} className="lender-form">
            <div className="row">
              <label>Decision
                <select name="decision">
                  <option value="APPROVED">Approved</option>
                  <option value="REDUCED">Reduced</option>
                  <option value="CONDITIONALLY_APPROVED">Conditionally approved</option>
                  <option value="REJECTED">Rejected</option>
                  <option value="PENDING">Pending placeholder</option>
                </select>
              </label>
              <label>Approved amount<input type="number" name="approvedAmount" step="1" min="0" /></label>
              <label>Reduced amount<input type="number" name="reducedAmount" step="1" min="0" /></label>
              <label>Holdback amount<input type="number" name="holdbackAmount" step="1" min="0" /></label>
            </div>
            <div className="row">
              <label>Reason<input type="text" name="decisionReason" /></label>
              <label>Condition (optional)<input type="text" name="conditionDescription" placeholder="Required for conditional approval" /></label>
              <label>Condition due<input type="date" name="conditionDueAt" /></label>
              <button className="btn sm" type="submit">Record lender decision</button>
            </div>
            <p className="sub">
              Recorded only after the formal approval matrix completes; it is the lender's business
              decision and never a substitute for governance approval or a release of funds.
            </p>
          </form>
        ) : null}
        {L.conditions.length > 0 ? (
          <>
            <h4 className="lender-sub">Decision conditions</h4>
            <div className="desktop-only table-scroll">
              <table className="lender-table">
                <thead><tr><th>Condition</th><th>Due</th><th>Responsible</th><th>Status</th><th>Resolution</th></tr></thead>
                <tbody>
                  {L.conditions.map((c) => (
                    <tr>
                      <td>{c.description}</td>
                      <td>{c.dueAt ?? "—"}</td>
                      <td>{c.responsiblePartyOrganizationId ? orgName(L, c.responsiblePartyOrganizationId) : "—"}</td>
                      <td><LenderChip v={c.status} /></td>
                      <td>{c.status === "SATISFIED" ? `Satisfied ${c.satisfiedAt ? fmtDate(c.satisfiedAt) : ""}` : c.status === "WAIVED" ? `Waived — ${c.waiverReason ?? ""}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobile-only">
              {L.conditions.map((c) => (
                <div className="rec-card">
                  <span className="rc-top"><span className="rc-title">{c.description}</span><span className="rc-side"><LenderChip v={c.status} /></span></span>
                  <span className="rc-kv">
                    <span className="k">Due</span><span className="v">{c.dueAt ?? "—"}</span>
                    <span className="k">Responsible</span><span className="v">{c.responsiblePartyOrganizationId ? orgName(L, c.responsiblePartyOrganizationId) : "—"}</span>
                  </span>
                </div>
              ))}
            </div>
            {L.caps.lenderDecision
              ? L.conditions
                  .filter((c) => ["OPEN", "IN_PROGRESS"].includes(c.status))
                  .map((c) => (
                    <form method="POST" action={`/api/decision-conditions/${c.id}`} className="lender-form">
                      <div className="row">
                        <span className="sub" style="align-self:center">{c.description.slice(0, 60)}</span>
                        <label>New status
                          <select name="status">
                            <option value="SATISFIED">Satisfied</option>
                            <option value="IN_PROGRESS">In progress</option>
                            <option value="WAIVED">Waived</option>
                            <option value="FAILED">Failed</option>
                          </select>
                        </label>
                        <label>Waiver reason<input type="text" name="waiverReason" placeholder="Required when waiving" /></label>
                        <button className="btn sm" type="submit">Update condition</button>
                      </div>
                    </form>
                  ))
              : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

/** Section F — lien waivers. */
function lenderWaivers(d: DrawDetailData, L: LenderTabData): VNode {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Lien waivers</h3>
        <span className="right">An uploaded document is not an accepted waiver — acceptance is a reviewed act</span>
      </div>
      {L.waivers.length === 0 ? (
        <div className="pad-sm"><p className="muted">{NOT_RECORDED} — no lien-waiver records for this draw.</p></div>
      ) : (
        <>
          <div className="desktop-only table-scroll pad-sm">
            <table className="lender-table">
              <thead><tr><th>Vendor / signer</th><th>Kind · scope</th><th className="num">Amount</th><th>Covered through</th><th>Document</th><th>Status</th><th>Outcome</th></tr></thead>
              <tbody>
                {L.waivers.map((w) => (
                  <tr>
                    <td>{w.contractorOrSupplierOrganizationId ? orgName(L, w.contractorOrSupplierOrganizationId) : w.signingParty ?? NOT_RECORDED}</td>
                    <td>{[w.waiverType, w.waiverScope].filter(Boolean).map((x) => enumLabel(x!)).join(" · ") || "—"}</td>
                    <td className="num">{w.relatedAmount !== null ? money(w.relatedAmount) : "—"}</td>
                    <td>{w.coveredThrough ?? "—"}</td>
                    <td>{w.drawDocumentId ? "Linked" : "—"}</td>
                    <td><LenderChip v={w.status} /></td>
                    <td>{w.status === "ACCEPTED" ? `Accepted ${w.acceptedAt ? fmtDate(w.acceptedAt) : ""}` : w.status === "REJECTED" ? `Rejected — ${w.rejectionReason ?? ""}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-only">
            {L.waivers.map((w) => (
              <div className="rec-card">
                <span className="rc-top">
                  <span className="rc-title">{w.contractorOrSupplierOrganizationId ? orgName(L, w.contractorOrSupplierOrganizationId) : w.signingParty ?? NOT_RECORDED}</span>
                  <span className="rc-side"><LenderChip v={w.status} /></span>
                </span>
                <span className="rc-kv">
                  <span className="k">Kind</span><span className="v">{[w.waiverType, w.waiverScope].filter(Boolean).map((x) => enumLabel(x!)).join(" · ") || "—"}</span>
                  <span className="k">Amount</span><span className="v num">{w.relatedAmount !== null ? money(w.relatedAmount) : "—"}</span>
                  <span className="k">Covered</span><span className="v">{w.coveredThrough ?? "—"}</span>
                </span>
              </div>
            ))}
          </div>
          {L.caps.reviewDraw
            ? L.waivers
                .filter((w) => !["ACCEPTED", "SUPERSEDED", "NOT_REQUIRED"].includes(w.status))
                .map((w) => (
                  <div className="pad-sm">
                    <form method="POST" action={`/api/lien-waivers/${w.id}`} className="lender-form" style="border-top:0;padding-top:0;margin-top:0">
                      <div className="row">
                        <span className="sub" style="align-self:center">{(w.signingParty ?? "Waiver").slice(0, 40)} · {enumLabel(w.status)}</span>
                        <label>Transition
                          <select name="status">
                            {w.status === "REQUIRED" ? <><option value="REQUESTED">Requested</option><option value="RECEIVED">Received</option></> : null}
                            {w.status === "REQUESTED" ? <option value="RECEIVED">Received</option> : null}
                            {w.status === "RECEIVED" ? <option value="UNDER_REVIEW">Under review</option> : null}
                            {w.status === "UNDER_REVIEW" ? <><option value="ACCEPTED">Accepted</option><option value="REJECTED">Rejected</option></> : null}
                            {["REJECTED", "EXPIRED"].includes(w.status) ? <option value="REQUESTED">Re-requested</option> : null}
                          </select>
                        </label>
                        <label>Signature date<input type="date" name="signatureDate" /></label>
                        <label>Rejection reason<input type="text" name="rejectionReason" /></label>
                        <button className="btn sm" type="submit">Record transition</button>
                      </div>
                    </form>
                  </div>
                ))
            : null}
        </>
      )}
      {L.caps.reviewDraw && !["CANCELLED", "DRAFT"].includes(d.draw.status) ? (
        <div className="pad-sm">
          <form method="POST" action={`/api/draws/${d.draw.id}/lien-waivers`} className="lender-form" style="border-top:0;padding-top:0;margin-top:0">
            <div className="row">
              <label>Signing party<input type="text" name="signingParty" placeholder="Contractor or supplier" required /></label>
              <label>Kind
                <select name="waiverType"><option value="CONDITIONAL">Conditional</option><option value="UNCONDITIONAL">Unconditional</option></select>
              </label>
              <label>Scope
                <select name="waiverScope"><option value="PARTIAL">Partial</option><option value="FINAL">Final</option></select>
              </label>
              <label>Covered through<input type="date" name="coveredThrough" /></label>
              <button className="btn sm ghost" type="submit">Require lien waiver</button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

/** Section G — external funding (administrative reconciliation only). */
function lenderFunding(d: DrawDetailData, L: LenderTabData): VNode {
  return (
    <section className="panel">
      <div className="panel-head"><h3>External funding</h3><span className="right">Administrative reconciliation only</span></div>
      {L.funding.length === 0 ? (
        <div className="pad-sm"><p className="muted">{NOT_RECORDED} — no external funding records for this draw.</p></div>
      ) : (
        <>
          <div className="desktop-only table-scroll pad-sm">
            <table className="lender-table">
              <thead><tr><th>Reference</th><th className="num">Scheduled</th><th className="num">Disbursed</th><th>Status</th><th>Scheduled at</th><th>Funded at</th><th>Reversal / failure</th></tr></thead>
              <tbody>
                {L.funding.map((f) => (
                  <tr>
                    <td>{f.transactionReference ?? f.fundingMethod ?? "—"}</td>
                    <td className="num">{f.amountScheduled !== null ? money(f.amountScheduled) : "—"}</td>
                    <td className="num">{f.amountDisbursed !== null ? money(f.amountDisbursed) : "—"}</td>
                    <td><LenderChip v={f.status} /></td>
                    <td>{lenderDate(f.scheduledAt)}</td>
                    <td>{lenderDate(f.fundedAt)}</td>
                    <td>{f.reversedAt ? `Reversed ${fmtDate(f.reversedAt)} (${f.reversalReference ?? "—"})` : f.failureReason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-only">
            {L.funding.map((f) => (
              <div className="rec-card">
                <span className="rc-top"><span className="rc-title">{f.transactionReference ?? f.fundingMethod ?? "Funding record"}</span><span className="rc-side"><LenderChip v={f.status} /></span></span>
                <span className="rc-kv">
                  <span className="k">Scheduled</span><span className="v num">{f.amountScheduled !== null ? money(f.amountScheduled) : "—"}</span>
                  <span className="k">Disbursed</span><span className="v num">{f.amountDisbursed !== null ? money(f.amountDisbursed) : "—"}</span>
                  {f.reversedAt ? <><span className="k">Reversed</span><span className="v">{fmtDate(f.reversedAt)}</span></> : null}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {L.caps.recordFunding && L.currentDecision && ["APPROVED", "CONDITIONALLY_APPROVED", "REDUCED"].includes(L.currentDecision.decision) && !L.funding.some((f) => ["SCHEDULED", "PROCESSING"].includes(f.status)) ? (
        <div className="pad-sm">
          <form method="POST" action={`/api/draws/${d.draw.id}/funding`} className="lender-form" style="border-top:0;padding-top:0;margin-top:0">
            <div className="row">
              <label>Amount to schedule<input type="number" name="amountScheduled" step="1" min="1" /></label>
              <label>Method<input type="text" name="fundingMethod" placeholder="Wire" /></label>
              <button className="btn sm" type="submit">Record scheduled funding</button>
            </div>
          </form>
        </div>
      ) : null}
      {L.caps.recordFunding
        ? L.funding
            .filter((f) => ["SCHEDULED", "PROCESSING", "DISBURSED", "FAILED"].includes(f.status))
            .map((f) => (
              <div className="pad-sm">
                <form method="POST" action={`/api/funding/${f.id}`} className="lender-form" style="border-top:0;padding-top:0;margin-top:0">
                  <div className="row">
                    <span className="sub" style="align-self:center">{f.transactionReference ?? f.fundingMethod ?? "Record"} · {enumLabel(f.status)}</span>
                    <label>Transition
                      <select name="status">
                        {f.status === "SCHEDULED" ? <><option value="PROCESSING">Processing</option><option value="DISBURSED">Disbursed</option><option value="FAILED">Failed</option><option value="CANCELLED">Cancelled</option></> : null}
                        {f.status === "PROCESSING" ? <><option value="DISBURSED">Disbursed</option><option value="FAILED">Failed</option></> : null}
                        {f.status === "DISBURSED" ? <><option value="REVERSED">Reversed</option><option value="CLOSED">Closed</option></> : null}
                        {f.status === "FAILED" ? <><option value="SCHEDULED">Rescheduled</option><option value="CANCELLED">Cancelled</option></> : null}
                      </select>
                    </label>
                    <label>Reference<input type="text" name="transactionReference" placeholder="Wire reference" /></label>
                    <label>Disbursed amount<input type="number" name="amountDisbursed" step="1" min="1" /></label>
                    <label>Failure reason<input type="text" name="failureReason" /></label>
                    <label>Reversal reference<input type="text" name="reversalReference" /></label>
                    <button className="btn sm" type="submit">Record transition</button>
                  </div>
                </form>
              </div>
            ))
        : null}
      <div className="pad-sm">
        <p className="sub lender-trust">
          External funding records do not move money and do not call VirtualAccountService. They
          mirror actions the lender takes in its own systems; OBV's governed release remains the
          only financial state machine.
        </p>
      </div>
    </section>
  );
}

/** Section H — packages (existing routes only). */
function lenderPackages(d: DrawDetailData, L: LenderTabData): VNode {
  return (
    <section className="panel">
      <div className="panel-head"><h3>Verification package</h3><span className="right">Assembled from authoritative registers with manifest hashing</span></div>
      <div className="pad-sm">
        <p className="lender-actions">
          <a className="btn sm" href={`/draw/${d.draw.id}/verification-package/preview`}>Printable preview</a>
          {d.reports.map((r) => (
            <a className="btn sm ghost" href={`/reports/file/${r.id}`}>Draw report · {fmtDate(r.generatedAt)}</a>
          ))}
          {L.packageReports.map((r) => (
            <a className="btn sm ghost" href={`/reports/file/${r.id}`}>Package · {fmtDate(r.generatedAt)}</a>
          ))}
        </p>
        {L.packageReports.length === 0 ? (
          <p className="sub">No generated package yet — generate one from the printable preview or the API; downloads appear here.</p>
        ) : null}
      </div>
    </section>
  );
}

/** Read-only VAM summary inside the Lender Review tab. No forms here by
 *  design — lender-review forms can never settle or transfer money; all
 *  banking actions live in the capability-gated Project Account
 *  workspace, linked below. */
function lenderBankingSummary(d: DrawDetailData, L: LenderTabData): VNode {
  const B = L.banking;
  // Banking data keeps its own capability boundary: without
  // VIEW_PROJECT_ACCOUNT the section simply does not exist.
  if (!B) return <></>;
  const a = B.account;
  const holdsTotal = B.activeHolds.reduce((sum, hold) => sum + hold.amount, 0);
  const i = B.latestInstruction;
  const t = B.latestTransaction;
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Project account</h3>
        <span className="right lender-sub">Read-only summary — a payment instruction is not proof of payment</span>
      </div>
      <div className="pad-sm">
        <dl className="kv">
          {kvRow("Virtual account", a ? `${a.virtualAccountNumberMasked} (masked; subledger identity)` : NOT_RECORDED)}
          {kvRow("Release-eligible balance", a ? money(a.releaseEligibleBalance) : NOT_RECORDED)}
          {kvRow(
            "Active holds",
            a
              ? B.activeHolds.length > 0
                ? `${B.activeHolds.length} hold(s) totalling ${money(holdsTotal)}`
                : "None"
              : NOT_RECORDED
          )}
          {kvRow(
            "Latest payment instruction (this draw)",
            i ? `${money(i.amount)} to ${i.recipientName} — ${enumLabel(i.status)}` : NOT_RECORDED
          )}
          {kvRow(
            "Latest bank-reported transaction",
            t ? `${enumLabel(t.direction)} ${money(t.amount)} — ${enumLabel(t.status)} (${t.providerTransactionReference})` : NOT_RECORDED
          )}
          {kvRow("Reconciliation state", B.reconciliationState ? enumLabel(B.reconciliationState) : NOT_RECORDED)}
        </dl>
        <p className="sub" style="margin-top:8px">
          <a className="btn sm ghost" href={`/project/${d.draw.projectId}/account`}>Open the Project Account workspace</a>
        </p>
      </div>
    </section>
  );
}

function renderLenderTab(d: DrawDetailData, L: LenderTabData): VNode {
  return (
    <>
      {L.notice ? (
        <div className={`attn ${L.notice.kind === "ok" ? "info" : "bad"}`} role="status">
          <span className="a-body"><span className="a-t">{L.notice.kind === "ok" ? "Recorded" : "Not recorded"}</span><span className="a-s">{L.notice.text}</span></span>
        </div>
      ) : null}
      {lenderMetricStrip(d, L)}
      <AttentionBanner tone="info" title={L.nextAction.title} detail={L.nextAction.detail} />
      {lenderContext(d, L)}
      {lenderInspections(d, L)}
      {lenderDecisionSection(d, L)}
      {lenderWaivers(d, L)}
      {lenderFunding(d, L)}
      {lenderBankingSummary(d, L)}
      {lenderPackages(d, L)}
      {L.stageHistory.length > 0 ? (
        <section className="panel">
          <div className="panel-head"><h3>Stage history</h3><span className="right">Append-only observations; the stage itself is derived on every read</span></div>
          <div className="pad-sm">
            <ol className="lender-stagelog">
              {L.stageHistory.map((e) => (
                <li>
                  <span className="num">{fmtDate(e.createdAt)}</span> — {e.priorStage ? `${enumLabel(e.priorStage)} → ` : ""}{enumLabel(e.newStage)}
                  {e.reason ? <span className="muted"> · {e.reason}</span> : null}
                </li>
              ))}
            </ol>
          </div>
        </section>
      ) : null}
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
  /** Six-gate summary per milestone referenced by the draw lines. */
  milestoneGateSummaries: Map<string, string>;
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

        {d.milestoneGateSummaries.size ? (
          <>
            <h2>Milestone completion gates</h2>
            <table>
              <thead><tr><th>Milestone</th><th>Six-gate state (each dimension is a separate authoritative record)</th></tr></thead>
              <tbody>
                {[...d.milestoneGateSummaries.entries()].map(([mid, label]) => {
                  const m = d.milestones.find((x) => x.id === mid);
                  return (
                    <tr>
                      <td style="width:26%">{m ? `M${m.seq} · ${m.title}` : mid}</td>
                      <td>{label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted" style="font-size:7.6pt">
              CONTRACTOR-REPORTED COMPLETE, OBV EVIDENCE VERIFIED, JURISDICTIONAL INSPECTION PASSED,
              READY FOR GOVERNANCE, FORMALLY APPROVED and RELEASED are six different facts —
              photographic completion is never legal, contractual or financial completion by itself.
            </p>
          </>
        ) : null}

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
