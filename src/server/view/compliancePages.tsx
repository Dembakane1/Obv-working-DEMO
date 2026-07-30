/**
 * DMV compliance workspace — Governing Code and Permit Basis, transition
 * rules, required official inspections, manual government-record
 * verifications, cost to complete, and the per-draw Draw Control Record.
 *
 * Display doctrine: contractor-reported, OBV inspector-observed,
 * government-record verified, and lender-decided values are labelled
 * distinctly and never merged. Eligibility is always presented as
 * "Eligible for lender review — not automatically approved."
 */
import { h, Fragment, renderDocument, VNode, Child } from "./jsx";
import { AppShell, EmptyStateV2, NavContext, PageHeader, enumLabel, money } from "./components";
import { icons } from "./icons";
import type {
  DrawControlRecord,
  ProjectComplianceView,
} from "../services/dmvCompliance";
import type { DrawRequest, Project, User } from "../../shared/types";

const NOT_RECORDED = "Not recorded";

function chipTone(v: string): string {
  if (["AUTHORITATIVE", "PASSED", "VERIFIED_MATCH", "ELIGIBLE_FOR_LENDER_REVIEW", "ELIGIBLE_PRIOR_CODE", "ACCEPTED", "NOT_REQUIRED"].includes(v)) return "chip ok";
  if (["FAILED", "REVOKED", "SUSPENDED", "INELIGIBLE", "HELD_BY_DISPUTE", "HELD_BY_LEGAL_HOLD", "NO_MATCH_FOUND", "EXCEPTION_OPEN", "NOT_ELIGIBLE", "CORRECTION_REQUIRED"].includes(v)) return "chip bad";
  if (["SUPERSEDED", "UNKNOWN", "NOT_FOUND", "WAIVED_BY_AUTHORITY"].includes(v)) return "chip dim";
  return "chip warn";
}
const Chip = (p: { v: string | null | undefined }): VNode =>
  p.v ? <span className={chipTone(p.v)}>{enumLabel(p.v)}</span> : <span className="chip dim">{NOT_RECORDED}</span>;

function name(users: Map<string, User>, id: string | null | undefined): string {
  if (!id) return NOT_RECORDED;
  return users.get(id)?.name ?? id;
}
const dt = (iso: string | null | undefined): string =>
  iso ? iso.slice(0, 16).replace("T", " ") : NOT_RECORDED;
const orDash = (v: Child): Child => v ?? "—";

function Notice(props: { notice: { kind: "ok" | "err"; text: string } | null }): VNode | null {
  if (!props.notice) return null;
  return (
    <p className={props.notice.kind === "ok" ? "lender-trust" : "lender-trust warn"} role="status">
      {props.notice.kind === "ok" ? "Recorded. " : "Not recorded: "}
      {props.notice.text}
    </p>
  );
}

// =====================================================================
// Project compliance workspace
// =====================================================================

export function renderProjectCompliance(input: {
  nav: NavContext;
  view: ProjectComplianceView;
  draws: DrawRequest[];
  users: Map<string, User>;
  notice: { kind: "ok" | "err"; text: string } | null;
}): string {
  const v = input.view;
  const p = v.project;
  const authoritative = v.bases.filter((b) => b.status === "AUTHORITATIVE");
  return renderDocument(
    <AppShell title="Compliance basis" nav={input.nav} context={`${p.name} · Governing Code and Permit Basis`}>
      <div className="page-wrap">
        <PageHeader
          title="Governing Code and Permit Basis"
          sub={`${p.name} — the recorded permit, code, inspection, and jurisdictional basis for the permitted work. Once authoritative, a version never changes; corrections create a new version.`}
          crumb={{ href: `/project/${p.id}`, label: p.name }}
        />
        <Notice notice={input.notice} />
        <p className="lender-trust">{v.scopeNote}</p>
        <p className="lender-trust">{v.legalNote}</p>

        {/* -------- compliance summary -------- */}
        <section className="panel">
          <div className="panel-head"><h3>Compliance summary</h3></div>
          <div className="pad-sm">
            <dl className="kv">
              <dt>Authoritative basis versions</dt><dd>{authoritative.length} of {v.bases.length} recorded versions</dd>
              <dt>Transition rules</dt><dd>{v.transitionRules.length} ({v.transitionRules.filter((r) => r.eligibility === "PENDING_DETERMINATION").length} pending determination)</dd>
              <dt>Required official inspections</dt><dd>{v.requirements.length} ({v.requirements.filter((r) => r.status === "PASSED").length} passed)</dd>
              <dt>Manual source verifications</dt><dd>{v.verifications.length} recorded lookup runs (manual — not a live integration)</dd>
              <dt>Cost-to-complete estimates</dt><dd>{v.estimates.length}</dd>
            </dl>
          </div>
        </section>

        {/* -------- permit basis register -------- */}
        <section className="panel">
          <div className="panel-head">
            <h3>Permit basis versions</h3>
            <span className="right lender-sub">Corrections create a new version; prior versions keep their original values</span>
          </div>
          {v.bases.length === 0 ? (
            <EmptyStateV2
              icon={icons.shield()}
              title="No permit basis recorded"
              what="A Governing Code and Permit Basis version records which jurisdiction, permitting authority, permit, code edition, and transition or grandfathering basis governs the permitted work — preserved historically once authoritative."
              condition="unconfigured"
            />
          ) : (
            <div className="table-scroll">
              <table className="lender-table">
                <thead>
                  <tr><th>Permit</th><th>Ver</th><th>Status</th><th>Type / trade</th><th>Jurisdiction</th><th>Authority</th><th>Code edition</th><th>Governing basis</th><th>Method</th><th>Lookup</th><th>Effective</th><th>Correction</th></tr>
                </thead>
                <tbody>
                  {v.bases.map((b) => (
                    <tr>
                      <td>{b.permitNumber}</td>
                      <td>v{b.version}</td>
                      <td><Chip v={b.status} /></td>
                      <td>{enumLabel(b.permitType)}{b.tradeType ? ` / ${enumLabel(b.tradeType)}` : ""}</td>
                      <td>{b.jurisdiction}</td>
                      <td>{b.permittingAuthority}</td>
                      <td>{orDash(b.governingCodeEdition)}</td>
                      <td><Chip v={b.governingBasis} /></td>
                      <td>{enumLabel(b.verificationMethod)}</td>
                      <td>{b.lookupAt ? `${dt(b.lookupAt)} by ${name(input.users, b.lookupByUserId)}` : NOT_RECORDED}</td>
                      <td>{b.effectiveFrom ? `${dt(b.effectiveFrom)}${b.supersededAt ? ` → ${dt(b.supersededAt)}` : ""}` : "Draft"}</td>
                      <td className="lender-sub">{b.correctionReason ? `${b.correctionReason} (${name(input.users, b.correctedByUserId)})` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* -------- transition rules -------- */}
        <section className="panel">
          <div className="panel-head">
            <h3>Code transition rules</h3>
            <span className="right lender-sub">Applicability is a human determination — never inferred from the current date</span>
          </div>
          {v.transitionRules.length === 0 ? (
            <p className="pad-sm lender-sub">No transition rules recorded.</p>
          ) : (
            <div className="table-scroll">
              <table className="lender-table">
                <thead>
                  <tr><th>Jurisdiction</th><th>Prior code</th><th>Replacement</th><th>Application cutoff</th><th>Issuance cutoff</th><th>Eligibility</th><th>Interpretation</th><th>Reviewer</th><th>Determined</th></tr>
                </thead>
                <tbody>
                  {v.transitionRules.map((r) => (
                    <tr>
                      <td>{r.jurisdiction}</td>
                      <td>{r.priorCodeEdition}</td>
                      <td>{r.replacementCodeEdition}</td>
                      <td>{orDash(r.applicationDateCutoff)}</td>
                      <td>{orDash(r.permitIssuanceCutoff)}</td>
                      <td><Chip v={r.eligibility} /></td>
                      <td className="lender-sub">{orDash(r.governingInterpretation)}</td>
                      <td>{name(input.users, r.reviewerUserId)}</td>
                      <td>{r.determinedAt ? dt(r.determinedAt) : "Pending"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* -------- required official inspections -------- */}
        <section className="panel">
          <div className="panel-head">
            <h3>Required official inspections</h3>
            <span className="right lender-sub">Official jurisdiction results — separate from any OBV field finding</span>
          </div>
          {v.requirements.length === 0 ? (
            <p className="pad-sm lender-sub">No line-level inspection requirements recorded.</p>
          ) : (
            <div className="table-scroll">
              <table className="lender-table">
                <thead>
                  <tr><th>Scope</th><th>Inspection</th><th>Authority</th><th>Before payment</th><th>Status</th><th>Official result (verbatim)</th><th>Lookup</th><th>Reviewer</th></tr>
                </thead>
                <tbody>
                  {v.requirements.map((r) => (
                    <tr>
                      <td>{r.budgetLineId ? `Line ${r.budgetLineId.slice(0, 10)}` : r.milestoneId ? `Milestone ${r.milestoneId.slice(0, 10)}` : "—"}</td>
                      <td>{r.inspectionType}</td>
                      <td>{orDash(r.inspectionAuthority)}</td>
                      <td>{r.requiredBeforePayment ? "Required" : "—"}</td>
                      <td><Chip v={r.status} /></td>
                      <td className="lender-sub">{orDash(r.officialResultText)}</td>
                      <td>{r.lookupAt ? dt(r.lookupAt) : NOT_RECORDED}</td>
                      <td>{name(input.users, r.reviewerUserId)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* -------- manual source verifications -------- */}
        <section className="panel">
          <div className="panel-head">
            <h3>Government-record verifications</h3>
            <span className="right lender-sub">Documented manual lookups by authorized reviewers — OBV has no live government integration</span>
          </div>
          {v.verifications.length === 0 ? (
            <p className="pad-sm lender-sub">No verification runs recorded.</p>
          ) : (
            <div className="table-scroll">
              <table className="lender-table">
                <thead>
                  <tr><th>Official service</th><th>Search criteria</th><th>Record id</th><th>Lookup</th><th>Performed by</th><th>Result</th><th>Confidence</th><th>Next review</th></tr>
                </thead>
                <tbody>
                  {v.verifications.map((s) => (
                    <tr>
                      <td>{s.officialService}</td>
                      <td className="lender-sub">{s.searchCriteria}</td>
                      <td>{orDash(s.sourceRecordIdentifier)}</td>
                      <td>{dt(s.lookupAt)}</td>
                      <td>{name(input.users, s.performedByUserId)}</td>
                      <td><Chip v={s.resultStatus} /></td>
                      <td>{orDash(s.confidence)}</td>
                      <td>{orDash(s.nextReviewDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* -------- cost to complete -------- */}
        <section className="panel">
          <div className="panel-head">
            <h3>Cost to complete</h3>
            <span className="right lender-sub">Analytical records — never a balance change or a payment</span>
          </div>
          {v.estimates.length === 0 ? (
            <p className="pad-sm lender-sub">No estimates recorded.</p>
          ) : (
            <div className="table-scroll">
              <table className="lender-table">
                <thead>
                  <tr><th>Budget line</th><th>Estimate to complete</th><th>Verified completed value</th><th>Source</th><th>Confidence</th><th>Date</th><th>Estimator</th></tr>
                </thead>
                <tbody>
                  {v.estimates.map((e) => (
                    <tr>
                      <td>{e.budgetLineId.slice(0, 10)}</td>
                      <td className="num">{money(e.estimatedCostToComplete)}</td>
                      <td className="num">{e.verifiedCompletedValue !== null ? money(e.verifiedCompletedValue) : NOT_RECORDED}</td>
                      <td>{e.sourceOfEstimate}</td>
                      <td>{e.confidence}</td>
                      <td>{e.estimateDate}</td>
                      <td>{name(input.users, e.estimatorUserId)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* -------- draw control records -------- */}
        {input.draws.length > 0 ? (
          <section className="panel">
            <div className="panel-head"><h3>Draw Control Records</h3></div>
            <div className="pad-sm">
              <ul className="lender-sub">
                {input.draws.map((d) => (
                  <li><a href={`/draw/${d.id}/control`}>Draw #{d.drawNumber} — DMV Draw Control Record</a></li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

// =====================================================================
// Draw Control Record page
// =====================================================================

export function renderDrawControl(input: {
  nav: NavContext;
  record: DrawControlRecord;
  project: Project;
  users: Map<string, User>;
  notice: { kind: "ok" | "err"; text: string } | null;
}): string {
  const r = input.record;
  const bases = [...new Map(r.lines.flatMap((l) => l.governingBases).map((b) => [b.basisVersionId, b])).values()];
  return renderDocument(
    <AppShell title="Draw control" nav={input.nav} context={`${input.project.name} · Draw #${r.drawNumber} control record`}>
      <div className="page-wrap">
        <PageHeader
          title={`DMV Draw Control Record — Draw #${r.drawNumber}`}
          sub={`${input.project.name} — per-line verification control with explicit reason codes. ${r.eligibleWording}`}
          crumb={{ href: `/project/${input.project.id}/compliance`, label: "Compliance basis" }}
        />
        <Notice notice={input.notice} />
        <p className="lender-trust">{r.scopeNote}</p>
        <p className="lender-trust">
          <b>{r.eligibleWording}</b> Eligibility is a verification result; the lender decision workflow
          remains a separate human act. Contractor-reported, OBV inspector-observed, government-record
          verified, and lender-decided values are separate records.
        </p>
        {r.disputeHold.blocked || r.disputeHold.legalHold ? (
          <p className="lender-trust warn">
            <b>{r.disputeHold.legalHold ? "Legal hold active." : "Dispute hold active."}</b>{" "}
            {r.disputeHold.reasons.join(" ")}
          </p>
        ) : null}

        {/* -------- pinned governing bases -------- */}
        <section className="panel">
          <div className="panel-head">
            <h3>Governing Code and Permit Basis (pinned to this draw)</h3>
            <span className="right lender-sub">The version that applied at review time — later corrections never move it</span>
          </div>
          {bases.length === 0 ? (
            <p className="pad-sm lender-sub">No authoritative permit basis is pinned to this draw.</p>
          ) : (
            <div className="table-scroll">
              <table className="lender-table">
                <thead>
                  <tr><th>Permit</th><th>Type</th><th>Version</th><th>Governing basis</th><th>Code edition</th><th>Jurisdiction</th><th>Authority</th><th>Permit control status</th></tr>
                </thead>
                <tbody>
                  {bases.map((b) => (
                    <tr>
                      <td>{b.permitNumber}</td>
                      <td>{enumLabel(b.permitType)}</td>
                      <td>v{b.version}</td>
                      <td><Chip v={b.governingBasis} /></td>
                      <td>{orDash(b.governingCodeEdition)}</td>
                      <td>{b.jurisdiction}</td>
                      <td>{b.permittingAuthority}</td>
                      <td><Chip v={b.permitControlStatus} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* -------- line control table -------- */}
        <section className="panel">
          <div className="panel-head"><h3>Budget-line draw control</h3></div>
          <div className="table-scroll">
            <table className="lender-table">
              <thead>
                <tr>
                  <th>Line</th><th>Scope</th><th className="num">Requested</th>
                  <th>Contractor-reported</th><th>OBV inspector-observed</th>
                  <th>Official inspections (government record)</th>
                  <th>Evidence</th><th>Lien waiver</th>
                  <th className="num">Prior funded</th><th className="num">Remaining budget</th>
                  <th className="num">Est. cost to complete</th><th className="num">Projected variance</th>
                  <th>Exceptions</th><th>Eligibility (not approval)</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr>
                    <td>{l.budgetLineCode ?? l.budgetLineRef ?? "—"}</td>
                    <td>{l.scopeDescription}</td>
                    <td className="num">{money(l.borrowerRequestedAmount)}</td>
                    <td>{l.contractorPercentComplete === null ? NOT_RECORDED : `${l.contractorPercentComplete}% claimed${l.contractorCompletedAmount !== null ? ` (${money(l.contractorCompletedAmount)})` : ""}`}</td>
                    <td>
                      {l.inspectorObservedPercent === null ? NOT_RECORDED : `${l.inspectorObservedPercent}% observed`}
                      {" · "}
                      <Chip v={l.drawInspectorFinding} />
                      {l.inspectorSupportedAmount !== null ? ` ${money(l.inspectorSupportedAmount)} supported` : ""}
                    </td>
                    <td>
                      {l.requiredInspections.length === 0
                        ? "None recorded"
                        : l.requiredInspections.map((q) => (
                            <div>
                              {q.inspectionType}: <Chip v={q.status} />
                              {q.lookupAt ? <span className="lender-sub"> looked up {dt(q.lookupAt)}</span> : null}
                            </div>
                          ))}
                    </td>
                    <td className="lender-sub">
                      {l.verifiedPhotoEvidenceCount}/{l.photoEvidenceCount} photos verified · {l.invoiceDocumentCount} invoice docs
                    </td>
                    <td><Chip v={l.lienWaiverStatus} /></td>
                    <td className="num">{money(l.priorFunded)}</td>
                    <td className="num">{l.remainingBudget !== null ? money(l.remainingBudget) : NOT_RECORDED}</td>
                    <td className="num">{l.estimatedCostToComplete !== null ? money(l.estimatedCostToComplete) : NOT_RECORDED}</td>
                    <td className="num">{l.projectedVariance !== null ? money(l.projectedVariance) : NOT_RECORDED}</td>
                    <td>
                      {l.openExceptions.length === 0
                        ? "—"
                        : l.openExceptions.map((x) => (
                            <div><span className={x.blocking ? "chip bad" : "chip warn"}>{x.severity}</span> {x.title}</div>
                          ))}
                    </td>
                    <td><Chip v={l.finalEligibilityStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* -------- reason codes -------- */}
        <section className="panel">
          <div className="panel-head">
            <h3>Eligibility reasons</h3>
            <span className="right lender-sub">Every result carries explicit reason codes — no hidden scoring</span>
          </div>
          <div className="table-scroll">
            <table className="lender-table">
              <thead><tr><th>Line</th><th>Final status</th><th>Reason code</th><th>Explanation</th></tr></thead>
              <tbody>
                {r.lines.flatMap((l) =>
                  l.eligibilityReasons.map((reason) => (
                    <tr>
                      <td>{l.budgetLineCode ?? l.budgetLineRef ?? "—"}</td>
                      <td><Chip v={l.finalEligibilityStatus} /></td>
                      <td className="lender-sub">{reason.code}</td>
                      <td>{reason.message}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <p className="lender-trust">{r.legalNote}</p>
      </div>
    </AppShell>
  );
}
