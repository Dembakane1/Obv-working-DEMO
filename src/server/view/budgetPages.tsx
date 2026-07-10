/**
 * Budget vs Verified Physical Progress pages.
 *
 * Presentation only — every figure comes from the deterministic
 * budgetProgress service and traces to stored records. The pages repeat
 * the language rule on purpose: a variance means financial progress is
 * ahead of currently verified physical progress; it is never presented
 * as proof of misconduct.
 */
import { h, Fragment, VNode, renderDocument } from "./jsx";
import { icons } from "./icons";
import { AppShell, NavContext, PageHeader, fmtDate, money } from "./components";
import type {
  BudgetLine,
  BudgetLineProgressRow,
  FinancialProgress,
  Milestone,
  PhysicalProgressAssessment,
  Project,
  User,
  VarianceState,
} from "../../shared/types";
import type { CategoryComparison } from "../services/budgetProgress";
import type {
  RetainageCondition,
  RetainagePolicy,
  RetainageReleaseRequest,
  RetainageSummary,
  ApprovalRecord,
  ApprovalRequest,
} from "../../shared/types";

export const VARIANCE_META: Record<VarianceState, { label: string; tone: string }> = {
  WITHIN_RANGE: { label: "Within range", tone: "ok" },
  WATCH: { label: "Watch", tone: "warn" },
  FINANCIAL_AHEAD: { label: "Financial ahead", tone: "bad" },
  PHYSICAL_AHEAD: { label: "Physical ahead", tone: "info" },
  DATA_INCOMPLETE: { label: "Data incomplete", tone: "neutral" },
};

export function VarianceTag(props: { state: VarianceState }): VNode {
  const m = VARIANCE_META[props.state];
  return <span className={`sync-tag ${m.tone}`} style="margin-left:0">{m.label}</span>;
}

/** The one comparison visualization: two labeled bars, same scale. */
export function ProgressCompareBars(props: {
  financialPct: number | null;
  verifiedPct: number | null;
  financialLabel?: string;
  compact?: boolean;
}): VNode {
  const f = props.financialPct;
  const v = props.verifiedPct;
  const bar = (label: string, pct: number | null, cls: string) => (
    <div className={`bvp-row ${props.compact ? "compact" : ""}`}>
      <span className="bvp-label">{label}</span>
      <span className="bvp-pct">{pct !== null ? `${pct}%` : "—"}</span>
      <span className="bvp-track">
        <span className={`bvp-fill ${cls}`} style={`width:${Math.max(0, Math.min(100, pct ?? 0))}%`}></span>
      </span>
    </div>
  );
  return (
    <div className="bvp-bars">
      {bar(props.financialLabel ?? "Financial progress", f, "fin")}
      {bar("Verified physical progress", v, "phys")}
    </div>
  );
}

export interface BudgetPortfolioRow {
  project: Project;
  financial: FinancialProgress;
}

export function renderBudgetPortfolio(input: { nav: NavContext; rows: BudgetPortfolioRow[] }): string {
  return renderDocument(
    <AppShell title="Budget & Progress" nav={input.nav} context="Budget & Progress">
      <PageHeader
        title="Budget & Progress"
        sub="Money claimed or paid, compared with physical progress supported by verified evidence. Two different measurements — compared side by side, never merged."
      />
      {input.rows.length === 0 ? (
        <div className="panel panel-pad"><p className="sub" style="margin:0">No active projects.</p></div>
      ) : (
        input.rows.map((r) => (
          <div className="panel panel-pad" style="margin-bottom:12px">
            <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
              <h3 style="margin:0;font-size:13.5px">
                <a href={`/project/${r.project.id}/budget`} style="color:var(--action)">{r.project.name}</a>
              </h3>
              <VarianceTag state={r.financial.varianceState} />
              <span className="sub" style="margin-left:auto">
                Budget {money(r.financial.budgetBasis)} · paid {money(r.financial.paidToDate)}
                {r.financial.openDrawRequested > 0 ? ` · ${money(r.financial.openDrawRequested)} in open draws` : ""}
              </span>
            </div>
            <div style="max-width:640px;margin-top:10px">
              <ProgressCompareBars
                financialPct={r.financial.dataComplete ? r.financial.claimedPct : null}
                verifiedPct={r.financial.dataComplete ? r.financial.verifiedPhysicalPct : null}
                financialLabel="Financial progress (paid + claimed)"
              />
            </div>
          </div>
        ))
      )}
      <p className="sub" style="margin:10px 2px;font-size:11px">
        Figures come from stored budget lines, released tranches, open draw requests and the
        verified-evidence record. A variance means financial progress is ahead of currently
        verified physical progress — it is not a finding about conduct.
      </p>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

export interface BudgetPageData {
  nav: NavContext;
  project: Project;
  financial: FinancialProgress;
  physical: PhysicalProgressAssessment;
  register: BudgetLineProgressRow[];
  categories: CategoryComparison[];
  milestones: Milestone[];
  users: Map<string, User>;
  auditTrail: Array<{ action: string; reason: string | null; afterSummary: string | null; createdAt: string; actorUserId: string }>;
  verifiedEvidenceOptions: Array<{ id: string; milestoneId: string; label: string }>;
  retainage: {
    policy: RetainagePolicy;
    summary: RetainageSummary;
    releases: Array<{
      release: RetainageReleaseRequest;
      conditions: RetainageCondition[];
      approval: ApprovalRequest | null;
      approvalRecords: ApprovalRecord[];
      canDecide: boolean;
    }>;
  };
  canManage: boolean;
  launched: boolean;
}

const WEIGHT_SOURCE_LABEL: Record<string, string> = {
  CONFIGURED_WEIGHTS: "configured milestone weights",
  TRANCHE_PROPORTIONS: "tranche proportions (no milestone weights configured)",
  EQUAL_WEIGHTS: "equal weights",
};

export function renderBudgetPage(d: BudgetPageData): string {
  const { financial: f, physical: p } = d;
  const kpi = (label: string, value: string, tone?: string) => (
    <div className="fin-cell">
      <div className={`v ${tone ?? ""}`}>{value}</div>
      <div className="l">{label}</div>
    </div>
  );
  return renderDocument(
    <AppShell title="Budget & Progress" nav={d.nav} context={`Budget & Progress · ${d.project.name.slice(0, 40)}`}>
      <PageHeader
        title="Budget & Progress"
        sub={`${d.project.name} — financial progress vs physical progress supported by verified evidence. Two measurements, compared — never merged.`}
        crumb={{ href: `/project/${d.project.id}`, label: d.project.name.slice(0, 40) }}
      >
        <VarianceTag state={f.varianceState} />
      </PageHeader>

      <div className="fin-band" style="margin-bottom:12px">
        {kpi("Original budget", money(f.originalBudget))}
        {kpi("Approved changes", f.approvedChanges !== 0 ? money(f.approvedChanges) : "—")}
        {kpi("Current budget", money(f.budgetBasis))}
        {kpi("Paid to date", `${money(f.paidToDate)} · ${f.paidPct}%`)}
        {kpi("Open draw requested", f.openDrawRequested > 0 ? money(f.openDrawRequested) : "—")}
        {kpi("Retainage held", f.retainageHeld > 0 ? money(f.retainageHeld) : "—")}
      </div>

      <div className="grid-2col">
        <div className="panel panel-pad">
          <h3 style="margin:0 0 10px;font-size:13px">Financial vs verified physical progress</h3>
          {f.dataComplete ? (
            <>
              <ProgressCompareBars
                financialPct={f.claimedPct}
                verifiedPct={f.verifiedPhysicalPct}
                financialLabel="Financial progress (paid + claimed)"
              />
              <p style="margin:12px 0 0;font-size:12.5px">
                <b>Variance: {f.variancePts > 0 ? "+" : ""}{f.variancePts} percentage points.</b>{" "}
                {f.varianceState === "FINANCIAL_AHEAD" || f.varianceState === "WATCH"
                  ? "Financial progress is ahead of currently verified physical progress."
                  : f.varianceState === "PHYSICAL_AHEAD"
                    ? "Verified physical progress is ahead of billing."
                    : "Financial and verified physical progress are within the configured range."}
              </p>
              <p className="sub" style="margin:6px 0 0;font-size:11px">
                Paid {f.paidPct}% · claimed (paid + open draws) {f.claimedPct}% · verified physical {f.verifiedPhysicalPct}%.
                Thresholds: within ≤ {f.thresholds.withinPts} pts, watch ≤ {f.thresholds.watchPts} pts (configurable).
              </p>
            </>
          ) : (
            <p className="sub" style="margin:0">
              DATA INCOMPLETE — a budget basis and configured milestones are required before the
              comparison can be computed.
            </p>
          )}
        </div>

        <div className="panel panel-pad">
          <h3 style="margin:0 0 8px;font-size:13px">Physical progress methodology</h3>
          <p className="sub" style="margin:0 0 8px;font-size:11.5px">
            Weights: <b>{WEIGHT_SOURCE_LABEL[p.weightSource]}</b>. Verified milestones contribute
            their full weight; measurably partial milestones contribute only through explicit
            reviewed quantities; unverified evidence contributes nothing. No completion percentage
            is ever inferred from a photo.
          </p>
          <ul style="margin:0;padding:0;list-style:none">
            {p.contributions.map((c) => (
              <li style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--line);font-size:12px;flex-wrap:wrap">
                <span style={`font-weight:700;color:var(--${c.state === "VERIFIED" ? "ok" : c.state === "PARTIAL_MEASURED" ? "warn" : "ink-4"})`}>
                  {c.state === "VERIFIED" ? "✓" : c.state === "PARTIAL_MEASURED" ? "◐" : "○"}
                </span>
                <span style="flex:1;min-width:180px">
                  {c.milestoneLabel}
                  <span className="sub" style="display:block">
                    weight {(c.weight * 100).toFixed(1)}% × completion {(c.completion * 100).toFixed(0)}% = <b>{c.contributionPct} pts</b>
                    {c.basis.quantityLabel ? ` · measured: ${c.basis.quantityLabel}` : ""}
                  </span>
                </span>
                {c.basis.evidenceItemId ? (
                  <a href={`/milestone/${c.milestoneId}`} style="color:var(--action);font-size:11.5px;white-space:nowrap">
                    View evidence basis →
                  </a>
                ) : (
                  <span className="sub" style="font-size:11px;white-space:nowrap">No verified progress</span>
                )}
                {c.basis.evidenceItemId ? (
                  <span className="sub" style="flex-basis:100%;font-size:10.5px">
                    Basis: evidence {c.basis.evidenceItemId.slice(0, 8)}… · verification {c.basis.verdict} ·{" "}
                    {(100 * (c.basis.confidence ?? 0)).toFixed(0)}% confidence
                    {c.basis.policyVersion ? ` · policy v${c.basis.policyVersion}` : ""}
                    {c.basis.ledgerSeq ? ` · ledger #${c.basis.ledgerSeq}` : ""}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="sub" style="margin:8px 0 0;font-size:10.5px">
            Verified physical progress = Σ contributions = <b>{p.verifiedPct}%</b>.
          </p>
        </div>
      </div>

      {d.categories.length > 0 ? (
        <div className="panel panel-pad" style="margin-top:12px">
          <h3 style="margin:0 0 10px;font-size:13px">By budget category</h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">
            {d.categories.map((c) => (
              <div style="border:1px solid var(--line);padding:10px 12px">
                <div style="display:flex;gap:8px;align-items:baseline;margin-bottom:8px">
                  <b style="font-size:12.5px">{c.category}</b>
                  <span className="sub" style="font-size:11px">{money(c.budget)}</span>
                  <span style="margin-left:auto"><VarianceTag state={c.varianceState} /></span>
                </div>
                <ProgressCompareBars financialPct={c.financialPct} verifiedPct={c.verifiedPct} compact />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel" style="margin-top:12px">
        <div className="panel-head">
          <h3>Budget line register</h3>
          <span className="right">
            {d.register.filter((r) => r.line.active).length} active line(s) ·{" "}
            {money(d.register.filter((r) => r.line.active).reduce((s, r) => s + r.line.currentBudget, 0))} current budget
          </span>
        </div>
        {d.register.length === 0 ? (
          <p className="sub" style="padding:14px 16px">
            No budget lines configured. Without budget lines the project-level comparison uses the
            project total budget and released tranches.
          </p>
        ) : (
          <div className="intg-table-wrap">
            <table className="intg-table">
              <thead>
                <tr>
                  <th>Code</th><th>Category</th><th>Current budget</th><th>Paid</th>
                  <th>Current requested</th><th>Verified progress</th><th>Financial progress</th>
                  <th>Variance</th><th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {d.register.map((r) => (
                  <tr style={r.line.active ? "" : "opacity:.55"}>
                    <td data-l="Code"><b>{r.line.code}</b>{r.line.active ? "" : " (inactive)"}
                      <span className="sub" style="display:block">{r.line.description.slice(0, 48)}</span>
                    </td>
                    <td data-l="Category">{r.line.category}</td>
                    <td data-l="Current budget" style="font-variant-numeric:tabular-nums">
                      {money(r.line.currentBudget)}
                      {r.line.approvedChanges !== 0 ? (
                        <span className="sub" style="display:block">incl. {money(r.line.approvedChanges)} changes</span>
                      ) : null}
                    </td>
                    <td data-l="Paid" style="font-variant-numeric:tabular-nums">{money(r.paid)}</td>
                    <td data-l="Requested" style="font-variant-numeric:tabular-nums">{r.openRequested > 0 ? money(r.openRequested) : "—"}</td>
                    <td data-l="Verified">{r.verifiedPct !== null ? `${r.verifiedPct}%` : "—"}</td>
                    <td data-l="Financial">{r.financialPct !== null ? `${r.financialPct}%` : "—"}</td>
                    <td data-l="Variance">
                      <VarianceTag state={r.varianceState} />
                      {r.variancePts !== null && r.varianceState !== "WITHIN_RANGE" ? (
                        <span className="sub" style="display:block">{r.variancePts > 0 ? "+" : ""}{r.variancePts} pts</span>
                      ) : null}
                    </td>
                    <td data-l="Next action" className="sub">{r.nextAction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {d.canManage ? (
        <div className="grid-2col" style="margin-top:12px">
          <div className="panel panel-pad">
            <h3 style="margin:0 0 8px;font-size:13px">Add budget line</h3>
            <form method="POST" action="/api/budget-lines" className="fo-form">
              <input type="hidden" name="projectId" value={d.project.id} />
              <div className="fo-row">
                <label>Code
                  <input name="code" required placeholder="e.g. 02-610" />
                </label>
                <label>Category
                  <input name="category" required placeholder="e.g. Base Course" />
                </label>
              </div>
              <label>Description
                <input name="description" placeholder="optional" />
              </label>
              <div className="fo-row">
                <label>Original budget
                  <input name="originalBudget" type="number" min="0" step="1" required />
                </label>
                <label>Paid to date
                  <input name="paidToDate" type="number" min="0" step="1" value="0" />
                </label>
                <label>Retainage held
                  <input name="retainageHeld" type="number" min="0" step="1" placeholder="optional" />
                </label>
              </div>
              <label>Map to milestone (physical basis)
                <select name="milestoneId">
                  <option value="">None yet</option>
                  {d.milestones.map((m) => (
                    <option value={m.id}>M{m.seq} · {m.title.slice(0, 44)}</option>
                  ))}
                </select>
              </label>
              <button className="btn sm" type="submit">Add budget line</button>
            </form>
          </div>
          <div className="panel panel-pad">
            <h3 style="margin:0 0 8px;font-size:13px">Update budget line{d.launched ? " (change-controlled)" : ""}</h3>
            {d.register.length === 0 ? (
              <p className="sub" style="margin:0">Add a budget line first.</p>
            ) : (
              <form method="POST" action="/api/budget-lines/update" className="fo-form">
                <input type="hidden" name="projectId" value={d.project.id} />
                <label>Budget line
                  <select name="budgetLineId" required>
                    {d.register.map((r) => (
                      <option value={r.line.id}>{r.line.code} · {r.line.category}</option>
                    ))}
                  </select>
                </label>
                <div className="fo-row">
                  <label>Original budget
                    <input name="originalBudget" type="number" min="0" step="1" placeholder="unchanged" />
                  </label>
                  <label>Approved changes
                    <input name="approvedChanges" type="number" step="1" placeholder="unchanged" />
                  </label>
                  <label>Paid to date
                    <input name="paidToDate" type="number" min="0" step="1" placeholder="unchanged" />
                  </label>
                </div>
                <div className="fo-row">
                  <label>Map to milestone
                    <select name="milestoneId">
                      <option value="">No change</option>
                      {d.milestones.map((m) => (
                        <option value={m.id}>M{m.seq} · {m.title.slice(0, 44)}</option>
                      ))}
                    </select>
                  </label>
                  <label>Change reason{d.launched ? " (required for budget changes)" : ""}
                    <input name="reason" placeholder={d.launched ? "Why is the budget changing?" : "optional"} />
                  </label>
                </div>
                <button className="btn sm" type="submit">Save (audited)</button>
                <p className="sub" style="margin:4px 0 0;font-size:10.5px">
                  Post-launch budget changes require a reason and are written to the configuration
                  audit trail with a new configuration version. Approved changes will be derived from
                  the Change Orders module when it exists.
                </p>
              </form>
            )}
          </div>
        </div>
      ) : null}

      {d.canManage ? (
        <div className="panel panel-pad" style="margin-top:12px;max-width:720px">
          <h3 style="margin:0 0 8px;font-size:13px">Record measured partial progress (reviewed)</h3>
          {d.verifiedEvidenceOptions.length === 0 ? (
            <p className="sub" style="margin:0">
              Requires VERIFIED evidence on a not-yet-verified milestone. Unverified evidence can
              never support a quantity.
            </p>
          ) : (
            <form method="POST" action="/api/verified-quantities" className="fo-form">
              <input type="hidden" name="projectId" value={d.project.id} />
              <label>Verified evidence basis
                <select name="evidenceItemId" required>
                  {d.verifiedEvidenceOptions.map((o) => (
                    <option value={o.id}>{o.label}</option>
                  ))}
                </select>
              </label>
              <div className="fo-row">
                <label>Measured completion %
                  <input name="percent" type="number" min="1" max="99" step="0.1" required />
                </label>
                <label>Measured quantity
                  <input name="quantityLabel" required placeholder='e.g. "9.8 of 14 km base laid"' />
                </label>
              </div>
              <label>Reason
                <input name="reason" required placeholder="Why this measured value is supported" />
              </label>
              <button className="btn sm" type="submit">Record measured progress</button>
              <p className="sub" style="margin:4px 0 0;font-size:10.5px">
                Contributes percent × milestone weight until the milestone itself verifies. Audited;
                a new record supersedes the previous one.
              </p>
            </form>
          )}
        </div>
      ) : null}

      <div className="panel" style="margin-top:12px">
        <div className="panel-head">
          <h3>Retainage</h3>
          <span className="right">
            Policy {d.retainage.policy.retainagePercent}% · withheld only inside governed draw
            releases · released only through its own formal approval
          </span>
        </div>
        <div className="fin-band">
          <div className="fin-cell"><div className="v">{money(d.retainage.summary.withheldToDate)}</div><div className="l">Total retainage held</div></div>
          <div className="fin-cell"><div className={`v ${d.retainage.summary.releasedToDate > 0 ? "green" : ""}`}>{money(d.retainage.summary.releasedToDate)}</div><div className="l">Retainage released</div></div>
          <div className="fin-cell"><div className="v">{money(d.retainage.summary.remaining)}</div><div className="l">Retainage remaining</div></div>
          <div className="fin-cell"><div className={`v ${d.retainage.summary.conditionsOutstanding > 0 ? "amber" : ""}`}>{d.retainage.summary.conditionsOutstanding}</div><div className="l">Conditions outstanding</div></div>
          <div className="fin-cell"><div className="v">{d.retainage.summary.pendingReleaseRequests}</div><div className="l">Pending release requests</div></div>
        </div>
        {d.retainage.releases.length > 0 ? (
          <div style="padding:12px 16px;border-top:1px solid var(--line)">
            {d.retainage.releases.map((r) => (
              <div style="border:1px solid var(--line);padding:10px 12px;margin-bottom:10px">
                <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
                  <b style="font-size:12.5px">Release request · {money(r.release.amount)}</b>
                  <span className={`sync-tag ${r.release.status === "RELEASED" ? "ok" : r.release.status === "RETURNED" ? "bad" : "warn"}`}>
                    {r.release.status.replace(/_/g, " ")}
                  </span>
                  {r.release.note ? <span className="sub">{r.release.note}</span> : null}
                </div>
                <ul style="margin:8px 0 0;padding:0;list-style:none;font-size:12px">
                  {r.conditions.map((c) => (
                    <li style="display:flex;gap:8px;padding:4px 0;border-top:1px solid var(--line);align-items:center;flex-wrap:wrap">
                      <span style={`font-weight:700;color:var(--${c.satisfied ? "ok" : "warn"})`}>{c.satisfied ? "✓" : "○"}</span>
                      <span style="flex:1;min-width:160px">
                        {c.condition.replace(/_/g, " ").toLowerCase()}
                        {c.note ? <span className="sub" style="display:block">{c.note}</span> : null}
                      </span>
                      {!c.satisfied && c.condition !== "ALL_EXCEPTIONS_RESOLVED" && d.canManage && r.release.status === "PENDING_CONDITIONS" ? (
                        <form method="POST" action={`/api/retainage/releases/${r.release.id}/condition`} style="display:flex;gap:5px">
                          <input type="hidden" name="condition" value={c.condition} />
                          <input name="note" placeholder="Closeout document / verification note" style="width:220px;font-size:11px" required />
                          <button className="btn ghost sm" type="submit">Record</button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {r.release.status === "PENDING_CONDITIONS" && d.canManage ? (
                  <form method="POST" action={`/api/retainage/releases/${r.release.id}/governance`} style="margin-top:8px">
                    <button className="btn sm" type="submit" disabled={r.conditions.some((c) => !c.satisfied)}>
                      Send to formal approval
                    </button>
                  </form>
                ) : null}
                {r.approval ? (
                  <div style="margin-top:8px;font-size:12px">
                    Governance: {r.approval.status === "PENDING"
                      ? `${r.approvalRecords.filter((rec) => rec.decision === "APPROVED").length} of ${r.approval.requiredRoles.length} approvals — retainage remains held`
                      : r.approval.status}
                    {r.canDecide && r.approval.status === "PENDING" ? (
                      <form method="POST" action={`/api/approvals/${r.approval.id}/decision`} style="display:inline-flex;gap:6px;margin-left:10px">
                        <input type="hidden" name="redirect" value={`/project/${d.project.id}/budget`} />
                        <button className="btn sm" name="decision" value="APPROVED" type="submit">Approve release</button>
                        <button className="btn ghost sm" name="decision" value="REJECTED" type="submit">Reject</button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {d.canManage ? (
          <div className="grid-2col" style="padding:12px 16px;border-top:1px solid var(--line)">
            <form method="POST" action="/api/retainage/policy" className="fo-form">
              <input type="hidden" name="projectId" value={d.project.id} />
              <label>Retainage policy % (0–20, audited)
                <input name="retainagePercent" type="number" min="0" max="20" step="0.5" value={String(d.retainage.policy.retainagePercent)} />
              </label>
              <button className="btn ghost sm" type="submit">Save policy</button>
            </form>
            <form method="POST" action="/api/retainage/releases" className="fo-form">
              <input type="hidden" name="projectId" value={d.project.id} />
              <div className="fo-row">
                <label>Request release (blank = all remaining)
                  <input name="amount" type="number" min="1" step="1" placeholder={String(d.retainage.summary.remaining)} />
                </label>
                <label>Note
                  <input name="note" placeholder="optional" />
                </label>
              </div>
              <button className="btn sm" type="submit" disabled={d.retainage.summary.remaining <= 0}>Create release request</button>
              <p className="sub" style="margin:4px 0 0;font-size:10.5px">
                Retainage is never released automatically: required closeout conditions must be
                recorded, then the release passes the formal approval matrix — exactly once.
              </p>
            </form>
          </div>
        ) : null}
      </div>

      {d.auditTrail.length > 0 ? (
        <div className="panel" style="margin-top:12px">
          <div className="panel-head">
            <h3>Budget change audit</h3>
            <span className="right">Configuration audit trail — NOT the Evidence Ledger</span>
          </div>
          <ul className="activity">
            {d.auditTrail.map((e) => (
              <li>
                <span className="ico warn">{icons.activity()}</span>
                <span className="body">
                  <span className="msg">
                    {e.action.replace(/_/g, " ").toLowerCase()} — {e.afterSummary ?? ""}
                    {e.reason ? <span className="sub" style="display:block">Reason: {e.reason}</span> : null}
                  </span>
                  <span className="meta">
                    <span className="when">{fmtDate(e.createdAt)}</span>
                    <span>{d.users.get(e.actorUserId)?.name ?? "—"}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="sub" style="margin:12px 2px;font-size:11px">
        <b>Methodology.</b> {d.physical.methodology}
      </p>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}
