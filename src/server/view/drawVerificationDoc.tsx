/**
 * Lender Draw Verification Package — print-styled document rendered to
 * PDF by headless Chromium (printable HTML when no renderer). Every
 * figure comes from DrawPackageData (source records only); requested,
 * supported, approved, released and retained amounts are labelled
 * distinctly and never merged. Grayscale-safe: state is always text.
 */
import { h, Fragment, VNode, renderDocument } from "./jsx";
import type { DrawPackageData } from "../services/drawPackage";
import { NOT_AVAILABLE } from "../services/drawPackage";

const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? NOT_AVAILABLE : "$" + n.toLocaleString("en-US");
const ts = (iso: string | null | undefined): string =>
  iso && iso !== NOT_AVAILABLE ? iso.replace("T", " ").replace(/\.\d+Z$/, " UTC") : NOT_AVAILABLE;

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font: 9.5pt/1.45 Georgia, 'Times New Roman', serif; color: #14202e; padding: 34px 42px; }
  .mast { border-bottom: 3px double #14202e; padding-bottom: 12px; margin-bottom: 16px; }
  .mast .brand { font: 700 8.5pt Arial, sans-serif; letter-spacing: 2.5px; color: #43536a; }
  h1 { font-size: 17pt; font-weight: 700; margin: 5px 0 2px; }
  .sub { color: #43536a; font-size: 9.5pt; }
  h2 { font: 700 9pt Arial, sans-serif; letter-spacing: 1.3px; text-transform: uppercase;
       border-bottom: 1px solid #b9c2cf; padding-bottom: 3px; margin: 18px 0 8px; }
  h2 .sec { color: #8a94a3; margin-right: 6px; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0; }
  th { font: 700 7pt Arial, sans-serif; letter-spacing: .8px; text-transform: uppercase;
       color: #43536a; text-align: left; padding: 4px 6px; border-bottom: 1.5px solid #14202e; }
  td { padding: 4px 6px; border-bottom: 1px solid #e6eaef; font-size: 8.5pt; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .kv td:first-child { width: 44%; color: #43536a; font-family: Arial, sans-serif; font-size: 7.5pt;
       letter-spacing: .5px; text-transform: uppercase; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 28px; }
  .flag { border: 1.5px solid #14202e; padding: 9px 12px; margin: 10px 0; font-family: Arial, sans-serif; font-size: 9pt; }
  .flag.warn { background: #f6efe2; }
  .flag.ok { background: #eef3ee; }
  .amount-band { display: grid; grid-template-columns: repeat(4, 1fr); border: 1.5px solid #14202e; margin: 10px 0; }
  .amount-band > div { padding: 8px 10px; border-right: 1px solid #d5dbe3; }
  .amount-band > div:last-child { border-right: 0; }
  .amount-band .l { font: 700 6.5pt Arial, sans-serif; letter-spacing: .8px; color: #43536a; text-transform: uppercase; }
  .amount-band .v { font-size: 12pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  .amount-band .s { font-size: 7pt; color: #5b6b7f; font-family: Arial, sans-serif; }
  .muted { color: #5b6b7f; font-size: 8pt; }
  .mono { font-family: 'Courier New', monospace; font-size: 7.5pt; }
  .tag { font: 700 6.5pt Arial, sans-serif; letter-spacing: .6px; border: 1px solid #14202e; padding: 1px 5px; white-space: nowrap; }
  .pagebreak { page-break-before: always; }
  .foot { margin-top: 22px; border-top: 1px solid #b9c2cf; padding-top: 8px; font: 7.5pt Arial, sans-serif; color: #5b6b7f; }
  ul { margin: 4px 0 4px 16px; font-size: 8.5pt; }
`;

function Amount(props: { label: string; value: string; note?: string }): VNode {
  return (
    <div>
      <div className="l">{props.label}</div>
      <div className="v">{props.value}</div>
      {props.note ? <div className="s">{props.note}</div> : null}
    </div>
  );
}

export function renderDrawVerificationDoc(d: DrawPackageData): string {
  const a = d.amounts;
  const disputed = a.currentException;
  const pendingRoles = d.approval
    ? d.approval.requiredRoles.filter(
        (r) => !d.approvalRecords.some((rec) => rec.role === r && rec.decision === "APPROVED")
      )
    : [];
  const reviewers = [...new Set(d.reviewerRows.filter((r) => r.capacity !== "EVIDENCE SUBMITTER").map((r) => r.name))];
  return renderDocument(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{`Draw Verification Package — Draw #${d.draw.drawNumber} — ${d.project.name}`}</title>
        <style>{CSS}</style>
      </head>
      <body>
        {/* ============ A. Cover & draw decision summary ============ */}
        <div className="mast">
          <div className="brand">OPENBUILD VERIFY · LENDER DRAW VERIFICATION PACKAGE</div>
          <h1>Draw Request #{d.draw.drawNumber} — {d.project.name}</h1>
          <div className="sub">
            Lender: {d.lenderOrg} · Borrower: {d.borrowerOrg} · Period {d.draw.periodStart ?? NOT_AVAILABLE} → {d.draw.periodEnd ?? NOT_AVAILABLE} ·
            Configuration v{d.configurationVersion} · Generated {ts(d.generatedAt)} by {d.generatedBy.name}
          </div>
        </div>

        <div className={`flag ${d.criticalIntegrityFindings.length ? "warn" : "ok"}`}>
          <b>
            {d.criticalIntegrityFindings.length
              ? "CRITICAL INTEGRITY FINDINGS PRESENT"
              : "NO CRITICAL INTEGRITY FINDINGS"}
          </b>
          {" — "}Evidence Ledger {d.ledger.valid ? `chain intact (${d.ledger.entries} entries)` : `TAMPERED AT ENTRY ${d.ledger.brokenAt}`}.
          {d.criticalIntegrityFindings.length ? (
            <ul>{d.criticalIntegrityFindings.map((w) => <li>{w}</li>)}</ul>
          ) : null}
        </div>

        <div className="amount-band">
          <Amount label="Current Draw Requested" value={money(a.currentRequested)} note="borrower request — authorizes nothing" />
          <Amount label="Current Draw Supported" value={money(a.currentSupported)} note="reviewer line decisions (advisory)" />
          <Amount label="Current Draw Exception" value={money(a.currentException)} note="requested minus supported" />
          <Amount
            label="Gross Governed Amount"
            value={money(a.grossGoverned)}
            note={a.grossGovernedBasis === "APPROVED_BY_GOVERNANCE" ? "approved by full governance" : a.grossGovernedBasis === "RECOMMENDED_ADVISORY" ? "advisory recommendation — not approval" : "not finalized"}
          />
        </div>
        <div className="amount-band">
          <Amount label="Retainage Withheld" value={money(a.retainageWithheld)} note={d.draw.retainageRate != null ? `${d.draw.retainageRate}% policy rate` : "computed at finalize"} />
          <Amount label="Net Release Eligible" value={money(a.netReleaseEligible)} note="gross governed minus retainage" />
          <Amount label="Net Released" value={money(a.netReleased)} note="exactly-once governed transition" />
          <Amount label="Remaining Available Budget" value={money(a.remainingAvailableBudget)} note="current contract minus cumulative approved" />
        </div>

        <h2><span className="sec">A</span>Draw decision summary</h2>
        <table className="kv">
          <tr><td>Draw status</td><td>{d.draw.status.replace(/_/g, " ")}</td></tr>
          <tr><td>How much was requested?</td><td>{money(a.currentRequested)}</td></tr>
          <tr><td>How much is supported by review?</td><td>{money(a.currentSupported)} (advisory — line-by-line reviewer decisions)</td></tr>
          <tr><td>What remains disputed or missing?</td><td>
            {money(disputed)} exception amount · {d.discrepancies.length} open discrepanc{d.discrepancies.length === 1 ? "y" : "ies"} (section J)
            {d.missingRequiredWaiver ? " · REQUIRED LIEN WAIVER MISSING (section I)" : ""}
          </td></tr>
          <tr><td>Who reviewed it?</td><td>{reviewers.length ? reviewers.join("; ") : "NO FORMAL REVIEW RECORDS"} (section G)</td></tr>
          <tr><td>What approvals remain?</td><td>
            {d.approval
              ? d.approval.status === "PENDING"
                ? `PENDING — awaiting ${pendingRoles.join(", ") || "final decision"}`
                : `${d.approval.status} — no further approvals pending`
              : "Formal governance not yet opened"}
          </td></tr>
          <tr><td>What amount is retained?</td><td>{money(a.retainageWithheld)} withheld on this draw · {money(d.retainagePosition.remaining)} project retainage remaining</td></tr>
          <tr><td>What amount was released?</td><td>{money(a.netReleased)} (net of retainage){a.netReleased === 0 ? " — no release event recorded" : ""}</td></tr>
          <tr><td>Critical integrity findings?</td><td>{d.criticalIntegrityFindings.length ? d.criticalIntegrityFindings.join("; ") : "None"}</td></tr>
        </table>

        {/* ============ B. Financial summary ============ */}
        <h2><span className="sec">B</span>Financial summary — cumulative position</h2>
        <table>
          <thead><tr><th>Measure</th><th className="num">Amount</th><th>Basis</th></tr></thead>
          <tbody>
            <tr><td>Cumulative Requested</td><td className="num">{money(a.cumulativeRequested)}</td><td>submitted draws #{a.cumulativeDrawNumbers.join(", #") || "—"}</td></tr>
            <tr><td>Cumulative Supported</td><td className="num">{money(a.cumulativeSupported)}</td><td>reviewer line decisions across those draws (advisory)</td></tr>
            <tr><td>Cumulative Approved</td><td className="num">{money(a.cumulativeApproved)}</td><td>completed formal governance only</td></tr>
            <tr><td>Cumulative Released</td><td className="num">{money(a.cumulativeReleased)}</td><td>VirtualAccountService release events (net)</td></tr>
            <tr><td>Remaining Available Budget</td><td className="num">{money(a.remainingAvailableBudget)}</td><td>current contract value minus cumulative approved</td></tr>
          </tbody>
        </table>
        <p className="muted">
          Requested, supported, approved, released and retained figures are independent
          measurements from distinct source records. They are reported separately and never merged.
        </p>

        {/* ============ C. Approved scope & budget lines ============ */}
        <h2 className="pagebreak"><span className="sec">C</span>Approved scope &amp; budget line detail</h2>
        <table className="kv">
          <tr><td>Project</td><td>{d.project.id} · {d.project.name}</td></tr>
          <tr><td>Approved scope (this draw)</td><td>{d.lines.map((l) => l.description).join("; ") || "No line items"}</td></tr>
          <tr><td>Original contract/project value</td><td>{money(d.contract.original)}</td></tr>
          <tr><td>Approved change orders</td><td>
            {d.approvedChangeOrders.length
              ? d.approvedChangeOrders.map((co) => `CO-${co.number} "${co.title}" (${money(co.approvedAmount)})`).join("; ")
              : "None approved"}
          </td></tr>
          <tr><td>Current contract/project value</td><td>{money(d.contract.current)}</td></tr>
          <tr><td>Configuration version</td><td>v{d.configurationVersion}</td></tr>
        </table>
        <table>
          <thead>
            <tr>
              <th>Budget line</th><th className="num">Original</th><th className="num">Changes</th>
              <th className="num">Current</th><th className="num">Prev. paid</th><th className="num">This draw</th>
              <th className="num">Cum. requested</th><th className="num">Cum. supported</th><th className="num">Balance to finish</th>
            </tr>
          </thead>
          <tbody>
            {d.budgetLines.map((b) => (
              <tr>
                <td>{b.code}<span className="muted" style="display:block">{b.description}</span></td>
                <td className="num">{typeof b.originalBudget === "number" ? money(b.originalBudget) : b.originalBudget}</td>
                <td className="num">{typeof b.approvedChanges === "number" ? money(b.approvedChanges) : b.approvedChanges}</td>
                <td className="num">{typeof b.currentBudget === "number" ? money(b.currentBudget) : b.currentBudget}</td>
                <td className="num">{typeof b.previouslyPaid === "number" ? money(b.previouslyPaid) : b.previouslyPaid}</td>
                <td className="num">{money(b.currentRequested)}</td>
                <td className="num">{money(b.cumulativeRequested)}</td>
                <td className="num">{money(b.cumulativeSupported)}</td>
                <td className="num">{typeof b.balanceToFinish === "number" ? money(b.balanceToFinish) : b.balanceToFinish}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Per-line approved and released amounts are NOT ALLOCATED PER LINE — formal governance operates at draw level (sections B and K).</p>

        {/* ============ D. Draw-line review register ============ */}
        <h2><span className="sec">D</span>Draw-line review register</h2>
        <table>
          <thead>
            <tr><th>Line</th><th className="num">Scheduled</th><th className="num">Requested</th><th>Review status</th><th className="num">Supported</th><th>Reviewer</th><th>Notes</th></tr>
          </thead>
          <tbody>
            {d.lines.map((l) => (
              <tr>
                <td>{l.description}</td>
                <td className="num">{money(l.scheduledValue)}</td>
                <td className="num">{money(l.currentRequested)}</td>
                <td><span className="tag">{l.status.replace(/_/g, " ")}</span></td>
                <td className="num">{l.supportedAmount != null ? money(l.supportedAmount) : l.status === "SUPPORTED" ? money(l.currentRequested) : "$0"}</td>
                <td>{l.reviewedByUserId ? d.users.get(l.reviewedByUserId)?.name ?? l.reviewedByUserId : "NOT REVIEWED"}</td>
                <td className="muted">{l.reviewNotes ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ============ E. Budget vs verified progress ============ */}
        <h2><span className="sec">E</span>Budget versus verified physical progress</h2>
        <table className="kv">
          <tr><td>Financial progress</td><td>{d.financialProgress.claimedPct}% (paid + claimed over current budget)</td></tr>
          <tr><td>Verified physical progress</td><td>{d.physicalProgress.verifiedPct}% — {d.physicalProgress.methodology}</td></tr>
          <tr><td>Reading</td><td>
            {d.financialProgress.claimedPct > d.physicalProgress.verifiedPct
              ? "Financial progress is ahead of currently verified physical progress. This is a comparison of two measurements — not a finding of misconduct."
              : "Financial progress is within or behind verified physical progress."}
          </td></tr>
        </table>

        {/* ============ F. Evidence register ============ */}
        <h2 className="pagebreak"><span className="sec">F</span>Timestamped evidence register</h2>
        {d.evidenceRows.length === 0 ? (
          <p className="muted">NO EVIDENCE LINKED to this draw. Linking references governed milestone evidence; it never re-verifies it.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Evidence</th><th>Milestone / requirement</th><th>Captured</th><th>Submitted</th><th>GPS</th><th>Verdict</th><th>Provenance</th><th>Ledger</th><th>Hash</th></tr>
            </thead>
            <tbody>
              {d.evidenceRows.map((r) => (
                <tr>
                  <td className="mono">{r.evidenceId}<span className="muted" style="display:block;font-family:Georgia">{r.metadataState}</span></td>
                  <td>{r.milestone}<span className="muted" style="display:block">{r.requirement.slice(0, 90)}{r.requirement.length > 90 ? "…" : ""}</span></td>
                  <td>{ts(r.capturedAt)}</td>
                  <td>{ts(r.submittedAt)}</td>
                  <td>{r.gpsState}</td>
                  <td><span className="tag">{r.verdict}</span> {r.confidence !== "NOT AVAILABLE" ? r.confidence : ""}</td>
                  <td>{r.provenance}{r.policyVersion !== "NOT AVAILABLE" ? ` · policy v${r.policyVersion}` : ""}</td>
                  <td className="num">{r.ledgerSeq !== "NOT AVAILABLE" ? `#${r.ledgerSeq}` : NOT_AVAILABLE}</td>
                  <td className="mono">{r.evidenceHash.slice(0, 16)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Evidence media is referenced by content hash and protected application reference
          per the media policy; raw media ships only in an explicitly authorized export.
          Missing capture data is shown as NOT AVAILABLE — never invented.
        </p>

        {/* ============ G. Inspector / reviewer attestations ============ */}
        <h2><span className="sec">G</span>Inspector / reviewer identity</h2>
        {!d.inspectionRecorded ? (
          <div className="flag warn"><b>NO FORMAL INSPECTION RECORD</b> — no inspection report is on file for this draw.</div>
        ) : null}
        <table>
          <thead><tr><th>Capacity</th><th>Name</th><th>Organization</th><th>Role</th><th>Timestamp</th><th>Action</th><th>Ref</th></tr></thead>
          <tbody>
            {d.reviewerRows.map((r) => (
              <tr>
                <td><span className="tag">{r.capacity}</span></td>
                <td>{r.name}</td>
                <td>{r.organization}</td>
                <td>{r.role}</td>
                <td>{ts(r.timestamp)}</td>
                <td>{r.action}{r.notes ? <span className="muted" style="display:block">{r.notes}</span> : null}</td>
                <td className="mono">{r.linkedRef}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Capacities are distinct: an evidence submitter is not an inspector; a line or document
          reviewer is not an approver; a recommendation is advisory. Communication participants
          never appear here — only formal review records do.
        </p>

        {/* ============ H. Permits & government inspections ============ */}
        <h2 className="pagebreak"><span className="sec">H</span>Permit &amp; government-inspection status</h2>
        <table>
          <thead><tr><th>Type</th><th>Title</th><th>Authority</th><th>Reference</th><th>Req.</th><th>State</th><th>Expires</th><th>Inspection</th><th>Result</th><th>Reviewer</th></tr></thead>
          <tbody>
            {d.permitRows.map((r) => (
              <tr>
                <td>{r.requirementType.replace(/_/g, " ")}</td>
                <td>{r.title}</td>
                <td>{r.issuingAuthority}</td>
                <td>{r.reference}</td>
                <td>{r.requiredOptional}</td>
                <td><span className="tag">{r.state}</span></td>
                <td>{r.expiresAt}</td>
                <td>{r.inspectionDate}</td>
                <td>{r.result}</td>
                <td>{r.reviewer}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">States come from authoritative document review records. A recorded upload is RECEIVED — PENDING REVIEW; it is never treated as accepted or compliant.</p>

        {/* ============ I. Invoices & lien waivers ============ */}
        <h2><span className="sec">I</span>Invoice &amp; lien-waiver status</h2>
        {d.missingRequiredWaiver ? (
          <div className="flag warn"><b>REQUIRED LIEN WAIVER MISSING OR NOT USABLE</b> — see the register below.</div>
        ) : null}
        <table>
          <thead><tr><th>Document</th><th>Type</th><th>Number / title</th><th>Vendor / kind</th><th className="num">Amount / scope</th><th>Line / coverage</th><th>Received</th><th>Review state</th><th>Reviewer</th><th>Deficiency</th></tr></thead>
          <tbody>
            {[...d.invoiceRows, ...d.waiverRows].map((r) => (
              <tr>
                <td className="mono">{String(r[0]).slice(0, 12)}</td>
                <td>{String(r[1]).replace(/_/g, " ")}</td>
                <td>{String(r[2])}</td>
                <td>{String(r[3])}</td>
                <td className="num">{typeof r[4] === "number" ? money(r[4] as number) : String(r[4])}</td>
                <td>{String(r[5])}</td>
                <td>{ts(String(r[7]))}</td>
                <td><span className="tag">{String(r[8])}</span></td>
                <td>{String(r[9])}</td>
                <td className="muted">{String(r[10] ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* ============ J. Discrepancies & exceptions ============ */}
        <h2 className="pagebreak"><span className="sec">J</span>Discrepancies &amp; unresolved exceptions</h2>
        {d.discrepancies.length === 0 ? (
          <p className="muted">No open discrepancies at generation time.</p>
        ) : (
          <table>
            <thead><tr><th>Kind</th><th>Detail</th><th>Source / exception</th></tr></thead>
            <tbody>
              {d.discrepancies.map((x) => (
                <tr><td><span className="tag">{x.kind}</span></td><td>{x.detail}</td><td className="mono">{x.sourceRef}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        <table>
          <thead><tr><th>Exception</th><th>Category</th><th>Sev.</th><th>Status</th><th>Association</th><th>Opened / age</th><th>SLA</th><th>Owner</th></tr></thead>
          <tbody>
            {d.exceptions.length === 0 ? (
              <tr><td colSpan={8} className="muted">No exception records associated with this draw.</td></tr>
            ) : (
              d.exceptions.map(({ e, ageDays: age, sla, association }) => (
                <tr>
                  <td className="mono">{e.id.slice(0, 12)}<span className="muted" style="display:block;font-family:Georgia">{e.title}</span></td>
                  <td>{e.category}</td>
                  <td>{e.severity}</td>
                  <td><span className="tag">{e.status.replace(/_/g, " ")}</span></td>
                  <td>{association}</td>
                  <td>{ts(e.openedAt)} · {age}d</td>
                  <td>{sla.replace(/_/g, " ")}</td>
                  <td>{e.ownerUserId ? d.users.get(e.ownerUserId)?.name ?? e.ownerUserId : ""}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <p className="muted">Each discrepancy references its single underlying source condition; the same condition is never counted as multiple unrelated discrepancies.</p>

        {/* ============ K. Approval history ============ */}
        <h2><span className="sec">K</span>Approval history</h2>
        <table className="kv">
          <tr><td>Review recommendation (ADVISORY)</td><td>
            {d.draw.reviewRecommendation
              ? `${d.draw.reviewRecommendation.replace(/_/g, " ")} — a recommendation releases nothing`
              : "Not finalized"}
          </td></tr>
          <tr><td>Formal approval request</td><td>
            {d.approval
              ? `${d.approval.id} · ${d.approval.status} · requires ${d.approval.requiredRoles.join(" + ")} (config v${d.configurationVersion})`
              : "NOT OPENED — no formal governance yet"}
          </td></tr>
          <tr><td>Financial release state</td><td>
            {d.amounts.netReleased > 0
              ? `RELEASED ${money(d.amounts.netReleased)} net of retainage (exactly once)`
              : "NO RELEASE EVENT — funds move only on full formal approval"}
          </td></tr>
        </table>
        {d.approvalRecords.length ? (
          <table>
            <thead><tr><th>#</th><th>Approver</th><th>Organization</th><th>Role</th><th>Decision</th><th>Timestamp</th></tr></thead>
            <tbody>
              {d.approvalRecords.map((rec, i) => {
                const u = d.users.get(rec.userId);
                return (
                  <tr>
                    <td className="num">{i + 1}</td>
                    <td>{u?.name ?? rec.userId}</td>
                    <td>{u ? d.orgName(u.organizationId) : NOT_AVAILABLE}</td>
                    <td>{rec.role}</td>
                    <td><span className="tag">{rec.decision}</span></td>
                    <td>{ts(rec.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="muted">No formal decisions recorded. Chat messages are never approvals.</p>
        )}

        {/* ============ L. Retainage & release state ============ */}
        <h2><span className="sec">L</span>Retainage &amp; release state</h2>
        <table>
          <thead><tr><th>Timestamp</th><th>Scope</th><th>Transition</th><th className="num">Amount</th><th>Event</th></tr></thead>
          <tbody>
            {d.accountEvents.length + d.retainageEvents.length === 0 ? (
              <tr><td colSpan={5} className="muted">No financial-state transitions recorded for this draw.</td></tr>
            ) : (
              <>
                {d.accountEvents.map((e) => (
                  <tr><td>{ts(e.createdAt)}</td><td>DRAW</td><td><span className="tag">{e.type}</span></td><td className="num">{money(e.amount)}</td><td className="mono">{e.id.slice(0, 12)}</td></tr>
                ))}
                {d.retainageEvents.map((e) => (
                  <tr><td>{ts(e.createdAt)}</td><td>RETAINAGE</td><td><span className="tag">{e.type}</span></td><td className="num">{money(e.amount)}</td><td className="mono">{e.id.slice(0, 12)}</td></tr>
                ))}
              </>
            )}
          </tbody>
        </table>
        <table className="kv">
          <tr><td>Project retainage withheld to date</td><td>{money(d.retainagePosition.withheldToDate)}</td></tr>
          <tr><td>Project retainage released to date</td><td>{money(d.retainagePosition.releasedToDate)} (formal retainage-release approvals only)</td></tr>
          <tr><td>Project retainage remaining</td><td>{money(d.retainagePosition.remaining)}</td></tr>
        </table>

        {/* ============ M. Ledger & package integrity ============ */}
        <h2><span className="sec">M</span>Ledger &amp; package-integrity summary</h2>
        <table className="kv">
          <tr><td>Evidence Ledger</td><td>{d.ledger.valid ? `CHAIN INTACT — ${d.ledger.entries} entries recomputed from genesis` : `TAMPERED AT ENTRY ${d.ledger.brokenAt}`}</td></tr>
          <tr><td>Critical findings</td><td>{d.criticalIntegrityFindings.length ? d.criticalIntegrityFindings.join("; ") : "None"}</td></tr>
          <tr><td>Machine-readable records</td><td>Every figure in this document reconciles to the CSV/JSON registers packaged alongside it; file hashes are listed in the package manifest.</td></tr>
        </table>

        {/* ============ N. Methodology & limitations ============ */}
        <h2><span className="sec">N</span>Methodology &amp; limitations</h2>
        <ul>
          <li><b>Supported amount</b>: sum of reviewer line decisions — SUPPORTED at requested value, PARTIALLY SUPPORTED at the reviewer-recorded amount, EXCEPTION/REJECTED/PENDING at zero. Advisory only.</li>
          <li><b>Gross governed amount</b>: the approved amount once formal governance concluded; before that, the reviewer-finalized advisory recommendation, labelled as such.</li>
          <li><b>Cumulative figures</b>: submitted, non-cancelled draws numbered up to and including this draw.</li>
          <li><b>Balance to finish</b>: current budget − previously paid − cumulative requested (conservative: treats requested as committed).</li>
          <li><b>Remaining available budget</b>: current contract value − cumulative gross approved.</li>
          <li><b>Verified physical progress</b>: {d.physicalProgress.methodology}</li>
          <li>This is a point-in-time record of governed application state. It is generated from a demo environment with a virtual project account ledger — no real bank movement. A reviewer recommendation is advisory; only the formal approval path creates release eligibility; a comparison of financial and physical progress is not a finding of misconduct.</li>
        </ul>

        <div className="foot">
          OpenBuild Verify · Lender Draw Verification Package · Draw #{d.draw.drawNumber} · {d.project.name} · generated {ts(d.generatedAt)} · schema v1
        </div>
      </body>
    </html>
  );
}
