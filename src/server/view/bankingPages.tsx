/**
 * Project Account workspace — the project-level financial ledger surface
 * for the VAM foundation.
 *
 * Read/record surface only. Every displayed value comes from stored
 * banking records or renders "Not recorded"; every action posts to the
 * existing banking API routes whose services re-run authorization, dual
 * control and demo gating. Nothing on this page settles a payment — a
 * payment instruction is not proof of payment, and settlement truth
 * arrives only through provider-confirmed bank transaction events.
 */
import { h, Fragment, renderDocument, VNode, Child } from "./jsx";
import {
  AppShell,
  AttentionBanner,
  EmptyStateV2,
  Metric,
  MetricStrip,
  NavContext,
  PageHeader,
  SectionHead,
  enumLabel,
  fmtDate,
  money,
} from "./components";
import { icons } from "./icons";
import type { BankingCapabilityFlags } from "../services/banking/bankingAccess";
import type {
  BankTransaction,
  BankingProgram,
  DrawRequest,
  PaymentInstruction,
  ProjectAccountHold,
  ProjectVirtualAccount,
  ReconciliationRun,
  Project,
  User,
} from "../../shared/types";

const NOT_RECORDED = "Not recorded";

const TRUST_NOTE =
  "OBV records verified construction progress, governed release eligibility, account holds, payment instructions and bank-reported transaction events. A payment instruction is not proof of payment. Only a provider-confirmed settled bank transaction represents completed movement of funds.";

export interface ProjectAccountPageData {
  nav: NavContext;
  project: Project;
  program: BankingProgram | null;
  account: ProjectVirtualAccount | null;
  holds: ProjectAccountHold[];
  instructions: PaymentInstruction[];
  transactions: BankTransaction[];
  runs: ReconciliationRun[];
  latestRun: ReconciliationRun | null;
  lastSuccessfulRun: ReconciliationRun | null;
  reconciliationBlocked: boolean;
  caps: BankingCapabilityFlags;
  demoMode: boolean;
  users: Map<string, User>;
  draws: DrawRequest[];
  /** drawId → eligibility label + first blocker (server-computed). */
  eligibility: Map<string, { label: string; blocker: string | null }>;
  notice: { kind: "ok" | "err"; text: string } | null;
}

function chipTone(v: string): string {
  if (["ACTIVE", "SETTLED", "MATCHED", "RELEASED", "POSTED"].includes(v)) return "chip ok";
  if (["MISMATCH", "FAILED", "RETURNED", "REVERSED", "SUSPENDED", "CLOSED"].includes(v)) return "chip bad";
  if (["PENDING", "PENDING_APPROVAL", "RUNNING", "PROCESSING", "SUBMITTED_TO_PROVIDER"].includes(v)) return "chip warn";
  return "chip";
}

function Chip(props: { v: string | null | undefined }): VNode {
  const v = props.v ?? null;
  if (!v) return <span className="chip dim">{NOT_RECORDED}</span>;
  return <span className={chipTone(v)}>{enumLabel(v)}</span>;
}

function kv(label: string, value: Child): VNode {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value ?? NOT_RECORDED}</dd>
    </>
  );
}

function userName(users: Map<string, User>, id: string | null | undefined): string {
  if (!id) return NOT_RECORDED;
  return users.get(id)?.name ?? id;
}

function bankDate(iso: string | null | undefined): string {
  return iso ? fmtDate(iso) : NOT_RECORDED;
}

function demoBadge(): VNode {
  return <span className="chip warn" title="This control simulates the banking provider. No real money exists or moves.">Demo simulation only</span>;
}

// ------------------------------------------------------------ sections

function summarySection(d: ProjectAccountPageData): VNode {
  const a = d.account;
  const p = d.program;
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Account summary</h3>
        <span className="right lender-sub">
          A virtual account may be a subledger balance at the partner bank, not a separate bank deposit account
        </span>
      </div>
      <div className="pad-sm">
        <dl className="kv">
          {kv("Program status", p ? <Chip v={p.status} /> : NOT_RECORDED)}
          {kv("Partner bank", p?.partnerBankName ?? NOT_RECORDED)}
          {kv("Account structure", p ? enumLabel(p.accountStructure) : NOT_RECORDED)}
          {kv("Provider", p ? enumLabel(p.provider) : NOT_RECORDED)}
          {kv("Virtual account", a ? `${a.virtualAccountNumberMasked} (masked; subledger identity)` : NOT_RECORDED)}
          {kv("Routing", a?.routingNumberMasked ?? NOT_RECORDED)}
          {kv("Account status", a ? <Chip v={a.status} /> : NOT_RECORDED)}
          {kv("Last successful reconciliation", d.lastSuccessfulRun ? bankDate(d.lastSuccessfulRun.completedAt) : NOT_RECORDED)}
          {kv(
            "Reconciliation state",
            d.latestRun ? <Chip v={d.latestRun.status} /> : NOT_RECORDED
          )}
        </dl>
      </div>
    </section>
  );
}

function metricStrip(d: ProjectAccountPageData): VNode {
  const a = d.account;
  if (!a) return <></>;
  return (
    <MetricStrip
      metrics={[
        { value: money(a.availableBalance), label: "Available", sub: "Unheld, unspent funds", dim: a.availableBalance === 0 },
        { value: money(a.heldBalance), label: "On hold", sub: "Under active holds", dim: a.heldBalance === 0 },
        { value: money(a.releaseEligibleBalance), label: "Release eligible", sub: "Not committed to an instruction", dim: a.releaseEligibleBalance === 0 },
        { value: money(a.pendingOutboundAmount), label: "Pending outbound", sub: "Submitted, not settled", tone: a.pendingOutboundAmount > 0 ? "warn" : undefined, dim: a.pendingOutboundAmount === 0 },
        { value: money(a.settledOutboundAmount), label: "Settled outbound", sub: "Provider-confirmed", dim: a.settledOutboundAmount === 0 },
        { value: money(a.returnedAmount), label: "Returned", sub: "Provider-confirmed returns", tone: a.returnedAmount > 0 ? "bad" : undefined, dim: a.returnedAmount === 0 },
      ]}
    />
  );
}

function provisioningForms(d: ProjectAccountPageData): VNode {
  const base = `/project/${d.project.id}/account`;
  if (!d.program && d.caps.manageProgram) {
    return (
      <form className="lender-form" method="POST" action={`/api/projects/${d.project.id}/banking/program`}>
        <div className="row">
          <label>Partner bank name <input name="partnerBankName" required placeholder="First Community Bank, N.A." /></label>
          <label>Account structure{" "}
            <select name="accountStructure">
              <option value="LENDER_CONTROLLED">Lender controlled</option>
              <option value="FBO">FBO</option>
              <option value="CUSTODIAL">Custodial</option>
              <option value="ESCROW_PARTNER">Escrow partner (licensed third party)</option>
              <option value="SEPARATE_PROJECT_ACCOUNTS">Separate project accounts</option>
            </select>
          </label>
          <label>Currency <input name="currency" value="USD" /></label>
          <button className="btn secondary sm" type="submit">Create banking program</button>
        </div>
        <input type="hidden" name="_back" value={base} />
      </form>
    );
  }
  if (d.program && !d.account && d.caps.manageAccount) {
    return (
      <form className="lender-form" method="POST" action={`/api/projects/${d.project.id}/banking/account`}>
        <div className="row">
          <button className="btn secondary sm" type="submit">Create project virtual account</button>
        </div>
      </form>
    );
  }
  return <></>;
}

function demoCreditForm(d: ProjectAccountPageData): VNode {
  if (!d.account || !d.demoMode || !d.caps.manageAccount || d.account.status !== "ACTIVE") return <></>;
  return (
    <form className="lender-form" method="POST" action={`/api/banking/accounts/${d.account.id}/credit`}>
      <div className="row">
        <label>Credit amount <input name="amount" type="number" min="1" step="1" required /></label>
        <label>Description <input name="description" placeholder="Construction reserve deposit" /></label>
        <button className="btn secondary sm" type="submit">Credit demo funds</button>
        {demoBadge()}
      </div>
    </form>
  );
}

function holdsSection(d: ProjectAccountPageData): VNode {
  const a = d.account;
  const drawNo = (id: string | null): string => {
    if (!id) return "—";
    const draw = d.draws.find((x) => x.id === id);
    return draw ? `Draw #${draw.drawNumber}` : id;
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Account holds</h3>
        <span className="right lender-sub">Holds are enforced by the bank/provider; OBV records who asked for them and why</span>
      </div>
      {!a || d.holds.length === 0 ? (
        <EmptyStateV2
          icon={icons.shield()}
          title="No holds recorded"
          what="An account hold sets funds aside — for retainage protection, a disputed line or a compliance stop — until an authorized user releases it."
          condition={a ? "healthy" : "unconfigured"}
        />
      ) : (
        <>
          <div className="table-scroll desktop-only">
            <table className="lender-table">
              <thead>
                <tr><th>Amount</th><th>Draw</th><th>Reason</th><th>Status</th><th>Placed by</th><th>Placed</th><th>Released by</th><th>Released</th></tr>
              </thead>
              <tbody>
                {d.holds.map((hold) => (
                  <tr>
                    <td className="num">{money(hold.amount)}</td>
                    <td>{drawNo(hold.drawRequestId)}</td>
                    <td>{enumLabel(hold.reasonCode)}{hold.reason ? ` — ${hold.reason}` : ""}</td>
                    <td><Chip v={hold.status} /></td>
                    <td>{userName(d.users, hold.placedByUserId)}</td>
                    <td>{bankDate(hold.placedAt)}</td>
                    <td>{userName(d.users, hold.releasedByUserId)}</td>
                    <td>{bankDate(hold.releasedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-only">
            {d.holds.map((hold) => (
              <div className="rec-card">
                <div className="rc-top">
                  <span className="rc-title">{money(hold.amount)} — {enumLabel(hold.reasonCode)}</span>
                  <span className="rc-side"><Chip v={hold.status} /></span>
                </div>
                <div className="rc-kv">
                  <span>Draw</span><span>{drawNo(hold.drawRequestId)}</span>
                  <span>Placed by</span><span>{userName(d.users, hold.placedByUserId)}</span>
                  <span>Placed</span><span>{bankDate(hold.placedAt)}</span>
                  <span>Released by</span><span>{userName(d.users, hold.releasedByUserId)}</span>
                  <span>Released</span><span>{bankDate(hold.releasedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {a && d.caps.manageAccount && a.status === "ACTIVE" ? (
        <div className="lender-actions">
          <form className="lender-form" method="POST" action={`/api/banking/accounts/${a.id}/holds`}>
            <div className="row">
              <label>Amount <input name="amount" type="number" min="1" step="1" required /></label>
              <label>Reason code{" "}
                <select name="reasonCode">
                  <option value="RETAINAGE_PROTECTION">Retainage protection</option>
                  <option value="DISPUTED_WORK">Disputed work</option>
                  <option value="COMPLIANCE_STOP">Compliance stop</option>
                  <option value="LENDER_DISCRETION">Lender discretion</option>
                </select>
              </label>
              <label>Draw{" "}
                <select name="drawRequestId">
                  <option value="">Not draw-specific</option>
                  {d.draws.map((draw) => <option value={draw.id}>Draw #{draw.drawNumber}</option>)}
                </select>
              </label>
              <label>Note <input name="reason" placeholder="Optional context" /></label>
              <button className="btn secondary sm" type="submit">Place hold</button>
            </div>
          </form>
          {d.holds.filter((x) => x.status === "ACTIVE").map((hold) => (
            <form className="lender-form" method="POST" action={`/api/banking/holds/${hold.id}/release`}>
              <div className="row">
                <span className="lender-sub">Release {money(hold.amount)} ({enumLabel(hold.reasonCode)})</span>
                <label>Outcome{" "}
                  <select name="outcome">
                    <option value="RELEASED">Released</option>
                    <option value="CANCELLED">Cancelled</option>
                    <option value="EXPIRED">Expired</option>
                  </select>
                </label>
                <button className="btn secondary sm" type="submit">Release hold</button>
              </div>
            </form>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function instructionsSection(d: ProjectAccountPageData): VNode {
  const a = d.account;
  const drawNo = (id: string): string => {
    const draw = d.draws.find((x) => x.id === id);
    return draw ? `Draw #${draw.drawNumber}` : id;
  };
  const timeline = (i: PaymentInstruction): string => {
    const steps: string[] = [`requested ${fmtDate(i.requestedAt)}`];
    if (i.approvedAt) steps.push(`approved ${fmtDate(i.approvedAt)}`);
    if (i.submittedAt) steps.push(`submitted ${fmtDate(i.submittedAt)}`);
    if (i.settledAt) steps.push(`settled ${fmtDate(i.settledAt)}`);
    if (i.failedAt) steps.push(`failed ${fmtDate(i.failedAt)}`);
    if (i.cancelledAt) steps.push(`cancelled ${fmtDate(i.cancelledAt)}`);
    return steps.join(" · ");
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Payment instructions</h3>
        <span className="right lender-sub">A payment instruction is not a completed payment — settlement truth comes only from the provider</span>
      </div>
      {!a || d.instructions.length === 0 ? (
        <EmptyStateV2
          icon={icons.dollar()}
          title="No payment instructions"
          what="A payment instruction can be created only for a draw whose formal governance is approved and whose current lender decision is fundable, and it requires approval by a second authorized user before submission."
          condition={a ? "healthy" : "unconfigured"}
        />
      ) : (
        <>
          <div className="table-scroll desktop-only">
            <table className="lender-table">
              <thead>
                <tr><th>Instruction</th><th>Draw</th><th>Amount</th><th>Recipient</th><th>Status</th><th>Created by</th><th>Approved by</th><th>Provider ref</th><th>Failure / return</th></tr>
              </thead>
              <tbody>
                {d.instructions.map((i) => (
                  <tr>
                    <td title={timeline(i)}>{i.id.slice(0, 8)}…</td>
                    <td>{drawNo(i.drawRequestId)}</td>
                    <td className="num">{money(i.amount)}</td>
                    <td>{i.recipientName}</td>
                    <td><Chip v={i.status} /></td>
                    <td>{userName(d.users, i.requestedByUserId)}</td>
                    <td>{userName(d.users, i.approvedByUserId)}</td>
                    <td>{i.providerReference ?? NOT_RECORDED}</td>
                    <td>{i.failureReason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-only">
            {d.instructions.map((i) => (
              <div className="rec-card">
                <div className="rc-top">
                  <span className="rc-title">{money(i.amount)} → {i.recipientName}</span>
                  <span className="rc-side"><Chip v={i.status} /></span>
                </div>
                <div className="rc-kv">
                  <span>Draw</span><span>{drawNo(i.drawRequestId)}</span>
                  <span>Created by</span><span>{userName(d.users, i.requestedByUserId)}</span>
                  <span>Approved by</span><span>{userName(d.users, i.approvedByUserId)}</span>
                  <span>Provider ref</span><span>{i.providerReference ?? NOT_RECORDED}</span>
                  <span>Timeline</span><span>{timeline(i)}</span>
                  {i.failureReason ? <><span>Failure / return</span><span>{i.failureReason}</span></> : null}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {a ? instructionForms(d, a) : null}
    </section>
  );
}

function instructionForms(d: ProjectAccountPageData, a: ProjectVirtualAccount): VNode {
  const eligibleDraws = d.draws.filter((draw) => d.eligibility.get(draw.id)?.blocker === null);
  return (
    <div className="lender-actions">
      {d.draws.length > 0 ? (
        <div className="pad-sm">
          {d.draws.map((draw) => {
            const e = d.eligibility.get(draw.id);
            if (!e) return null;
            return (
              <p className="lender-sub">
                Draw #{draw.drawNumber}: <strong>{e.label}</strong>
                {e.blocker ? ` — ${e.blocker}` : ""}
              </p>
            );
          })}
        </div>
      ) : null}
      {d.caps.createInstruction && a.status === "ACTIVE" && eligibleDraws.length > 0
        ? eligibleDraws.map((draw) => (
            <form className="lender-form" method="POST" action={`/api/draws/${draw.id}/payment-instructions`}>
              <div className="row">
                <span className="lender-sub">Draw #{draw.drawNumber} — eligible for payment instruction</span>
                <label>Amount <input name="amount" type="number" min="1" step="1" required /></label>
                <label>Recipient <input name="recipientName" required placeholder="General contractor LLC" /></label>
                <label>Reference <input name="recipientReference" placeholder="Invoice / job reference" /></label>
                <label>Method{" "}
                  <select name="paymentMethod">
                    <option value="ACH_SIMULATED">ACH (simulated)</option>
                    <option value="WIRE_SIMULATED">Wire (simulated)</option>
                    <option value="CHECK_SIMULATED">Check (simulated)</option>
                  </select>
                </label>
                <button className="btn secondary sm" type="submit">Create payment instruction</button>
              </div>
            </form>
          ))
        : null}
      {d.instructions.map((i) => {
        const actions: VNode[] = [];
        if (d.caps.approveInstruction && i.status === "PENDING_APPROVAL") {
          actions.push(
            <form className="lender-form" method="POST" action={`/api/payment-instructions/${i.id}/approve`}>
              <div className="row">
                <span className="lender-sub">{money(i.amount)} to {i.recipientName} — second-user approval (the creator and the draw submitter cannot approve)</span>
                <button className="btn secondary sm" type="submit">Approve instruction</button>
              </div>
            </form>
          );
        }
        if (d.caps.cancelInstruction && ["DRAFT", "PENDING_APPROVAL", "APPROVED_FOR_SUBMISSION"].includes(i.status)) {
          actions.push(
            <form className="lender-form" method="POST" action={`/api/payment-instructions/${i.id}/cancel`}>
              <div className="row">
                <span className="lender-sub">Cancel {money(i.amount)} to {i.recipientName}</span>
                <label>Reason <input name="reason" placeholder="Optional" /></label>
                <button className="btn secondary sm" type="submit">Cancel instruction</button>
              </div>
            </form>
          );
        }
        if (d.demoMode && d.caps.createInstruction && i.status === "APPROVED_FOR_SUBMISSION") {
          actions.push(
            <form className="lender-form" method="POST" action={`/api/payment-instructions/${i.id}/simulate/submit`}>
              <div className="row">
                <span className="lender-sub">Submit {money(i.amount)} to the provider</span>
                <button className="btn secondary sm" type="submit">Simulate provider submission</button>
                {demoBadge()}
              </div>
            </form>
          );
        }
        if (d.demoMode && d.caps.manageAccount && ["SUBMITTED_TO_PROVIDER", "PROCESSING"].includes(i.status)) {
          actions.push(
            <form className="lender-form" method="POST" action={`/api/payment-instructions/${i.id}/simulate/posted`}>
              <div className="row">
                <span className="lender-sub">{money(i.amount)} to {i.recipientName}</span>
                <button className="btn secondary sm" type="submit">Simulate posted</button>
                {demoBadge()}
              </div>
            </form>
          );
          actions.push(
            <form className="lender-form" method="POST" action={`/api/payment-instructions/${i.id}/simulate/settled`}>
              <div className="row">
                <span className="lender-sub">Settlement can come only from this provider event</span>
                <button className="btn secondary sm" type="submit">Simulate settlement</button>
                {demoBadge()}
              </div>
            </form>
          );
          actions.push(
            <form className="lender-form" method="POST" action={`/api/payment-instructions/${i.id}/simulate/failed`}>
              <div className="row">
                <label>Failure code <input name="failureCode" placeholder="R01" /></label>
                <label>Failure reason <input name="failureReason" placeholder="Insufficient funds at receiving bank" /></label>
                <button className="btn secondary sm" type="submit">Simulate failure</button>
                {demoBadge()}
              </div>
            </form>
          );
        }
        if (d.demoMode && d.caps.manageAccount && i.status === "SETTLED") {
          actions.push(
            <form className="lender-form" method="POST" action={`/api/payment-instructions/${i.id}/simulate/returned`}>
              <div className="row">
                <span className="lender-sub">Return the settled {money(i.amount)} payment</span>
                <button className="btn secondary sm" type="submit">Simulate return</button>
                {demoBadge()}
              </div>
            </form>
          );
        }
        return <>{actions}</>;
      })}
    </div>
  );
}

function transactionsSection(d: ProjectAccountPageData): VNode {
  const instrFor = (id: string | null): string => {
    if (!id) return "—";
    const i = d.instructions.find((x) => x.id === id);
    return i ? `${money(i.amount)} → ${i.recipientName}` : id;
  };
  const reconciled = (t: BankTransaction): string => {
    if (!d.lastSuccessfulRun?.completedAt) return "Not yet reconciled";
    return t.initiatedAt <= d.lastSuccessfulRun.completedAt ? "Covered by last matched run" : "After last matched run";
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Bank transactions</h3>
        <span className="right lender-sub">Bank-reported events mirrored from the provider — OBV never authors settlement</span>
      </div>
      {d.transactions.length === 0 ? (
        <EmptyStateV2
          icon={icons.ledger()}
          title="No bank transactions"
          what="Bank transactions appear when the provider reports movement: deposits, submitted payments, settlements, failures, returns and reversals."
          condition="healthy"
        />
      ) : (
        <>
          <div className="table-scroll desktop-only">
            <table className="lender-table">
              <thead>
                <tr><th>Date</th><th>Direction</th><th>Amount</th><th>Status</th><th>Type</th><th>Payment instruction</th><th>Provider ref</th><th>Reconciliation</th></tr>
              </thead>
              <tbody>
                {d.transactions.map((t) => (
                  <tr>
                    <td>{bankDate(t.initiatedAt)}</td>
                    <td>{enumLabel(t.direction)}</td>
                    <td className="num">{money(t.amount)}</td>
                    <td><Chip v={t.status} /></td>
                    <td>{enumLabel(t.transactionType)}</td>
                    <td>{instrFor(t.paymentInstructionId)}</td>
                    <td>{t.providerTransactionReference}</td>
                    <td>{reconciled(t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-only">
            {d.transactions.map((t) => (
              <div className="rec-card">
                <div className="rc-top">
                  <span className="rc-title">{enumLabel(t.direction)} {money(t.amount)}</span>
                  <span className="rc-side"><Chip v={t.status} /></span>
                </div>
                <div className="rc-kv">
                  <span>Date</span><span>{bankDate(t.initiatedAt)}</span>
                  <span>Type</span><span>{enumLabel(t.transactionType)}</span>
                  <span>Instruction</span><span>{instrFor(t.paymentInstructionId)}</span>
                  <span>Provider ref</span><span>{t.providerTransactionReference}</span>
                  <span>Reconciliation</span><span>{reconciled(t)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function reconciliationSection(d: ProjectAccountPageData): VNode {
  const latest = d.latestRun;
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Reconciliation</h3>
        <span className="right lender-sub">bank reported = available + held + pending outbound + suspense — the ledger is never adjusted to force a match</span>
      </div>
      {d.runs.length === 0 ? (
        <EmptyStateV2
          icon={icons.refresh()}
          title="No reconciliation runs"
          what="Reconciliation compares the bank-reported program balance with OBV's calculated ledger balance. A mismatch raises a critical blocking exception; it never silently adjusts the ledger."
          condition={d.account ? "incomplete" : "unconfigured"}
        />
      ) : (
        <div className="pad-sm">
          <dl className="kv">
            {kv("Last run", latest ? `${bankDate(latest.completedAt ?? latest.startedAt)} (${enumLabel(latest.status)})` : NOT_RECORDED)}
            {kv("Reported balance", latest?.bankReportedBalance !== null && latest ? money(latest.bankReportedBalance!) : NOT_RECORDED)}
            {kv("Calculated balance", latest?.ledgerCalculatedBalance !== null && latest ? money(latest.ledgerCalculatedBalance!) : NOT_RECORDED)}
            {kv(
              "Difference",
              latest?.differenceAmount !== null && latest
                ? <span className={latest.differenceAmount === 0 ? "" : "chip bad"}>{money(Math.abs(latest.differenceAmount!))}{latest.differenceAmount! < 0 ? " (ledger above bank)" : latest.differenceAmount! > 0 ? " (bank above ledger)" : ""}</span>
                : NOT_RECORDED
            )}
            {kv("Accounts covered", latest?.projectAccountCount !== null && latest ? String(latest.projectAccountCount) : NOT_RECORDED)}
            {kv("Initiated by", latest ? userName(d.users, latest.initiatedBy) : NOT_RECORDED)}
          </dl>
          <h4 className="lender-sub" style="margin:10px 0 4px">Run history (mismatch history is never deleted)</h4>
          <ol className="lender-stagelog">
            {d.runs.slice().reverse().map((run) => (
              <li>
                <Chip v={run.status} /> {bankDate(run.completedAt ?? run.startedAt)} — reported{" "}
                {run.bankReportedBalance !== null ? money(run.bankReportedBalance) : NOT_RECORDED}, calculated{" "}
                {run.ledgerCalculatedBalance !== null ? money(run.ledgerCalculatedBalance) : NOT_RECORDED}
              </li>
            ))}
          </ol>
        </div>
      )}
      {d.account && d.caps.runReconciliation ? (
        <div className="lender-actions">
          <form className="lender-form" method="POST" action={`/api/projects/${d.project.id}/banking/reconcile`}>
            <div className="row">
              <button className="btn secondary sm" type="submit">Run reconciliation</button>
              {d.demoMode ? (
                <>
                  <label>Force mismatch by <input name="demoForceMismatchAmount" type="number" min="0" step="1" placeholder="0" /></label>
                  {demoBadge()}
                </>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------- page

export function renderProjectAccountPage(d: ProjectAccountPageData): string {
  return renderDocument(
    <AppShell title="Project Account" nav={d.nav} context={`${d.project.name} · Project Account`}>
      <div className="page-wrap">
        <PageHeader
          title="Project Account"
          sub={`${d.project.name} — virtual account ledger, holds, payment instructions, bank-reported transactions and reconciliation.`}
          crumb={{ href: `/project/${d.project.id}`, label: d.project.name }}
        />
        {d.notice ? (
          <div className={`attn ${d.notice.kind === "ok" ? "info" : "bad"}`} role="status">
            <span className="a-body"><span className="a-t">{d.notice.kind === "ok" ? "Recorded" : "Not recorded"}</span><span className="a-s">{d.notice.text}</span></span>
          </div>
        ) : null}
        {d.reconciliationBlocked ? (
          <AttentionBanner
            tone="bad"
            title="Reconciliation mismatch — payment work is blocked"
            detail="The most recent reconciliation run did not match. New payment instructions, approvals and submissions for this program are refused until an attributable resolution and a later successful run."
          />
        ) : null}
        <AttentionBanner
          tone="info"
          title="Demo financial simulation"
          detail="No real bank account exists and no real money moves. Every balance, hold, payment instruction and transaction on this page is a mock-provider simulation."
        />
        {metricStrip(d)}
        <p className="lender-trust">{TRUST_NOTE}</p>
        {summarySection(d)}
        {provisioningForms(d)}
        {demoCreditForm(d)}
        {holdsSection(d)}
        {instructionsSection(d)}
        {transactionsSection(d)}
        {reconciliationSection(d)}
      </div>
    </AppShell>
  );
}
