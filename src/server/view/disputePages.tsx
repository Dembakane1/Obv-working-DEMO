/**
 * Dispute + release-hold workspace — plain-language record surface.
 *
 * Every displayed value comes from stored records. Every action posts to
 * the dispute API routes whose services re-run authorization. The page
 * never claims OBV holds funds, rules, orders payment or arbitrates.
 */
import { h, Fragment, renderDocument, VNode, Child } from "./jsx";
import { AppShell, AttentionBanner, EmptyStateV2, NavContext, PageHeader, SectionHead, enumLabel, fmtDate, money, shortHash } from "./components";
import { icons } from "./icons";
import { ADVISORY_NOTE, RESOLUTION_ACKNOWLEDGEMENT, disputeDetail } from "../services/disputes";
import type { Dispute, DrawRequest, Project, User } from "../../shared/types";

const NOT_RECORDED = "Not recorded";

const TRUST_NOTE =
  "OBV provides verification, workflow, evidence, and authorization records. OBV is not the escrow agent and does not hold or move funds.";

type Detail = ReturnType<typeof disputeDetail>;

function chipTone(v: string): string {
  if (["RESOLVED_RELEASE", "ACCEPTED", "COMPLETED", "PASSED", "CLOSED"].includes(v)) return "chip ok";
  if (["ESCALATED", "REJECTED", "FAILED", "ACCESS_FAILED", "OVERDUE", "RESOLVED_CONTINUE_HOLD"].includes(v)) return "chip bad";
  if (v.startsWith("WAITING") || ["OPEN", "UNDER_REVIEW", "SUBMITTED", "CURE_IN_PROGRESS", "READY_FOR_DECISION", "REQUESTED", "SCHEDULED", "PENDING", "RECORDED"].includes(v)) return "chip warn";
  return "chip";
}
const Chip = (p: { v: string | null | undefined }): VNode =>
  p.v ? <span className={chipTone(p.v)}>{enumLabel(p.v)}</span> : <span className="chip dim">{NOT_RECORDED}</span>;

const kv = (label: string, value: Child): VNode => (
  <>
    <dt>{label}</dt>
    <dd>{value ?? NOT_RECORDED}</dd>
  </>
);

function name(users: Map<string, User>, id: string | null | undefined): string {
  if (!id) return NOT_RECORDED;
  return users.get(id)?.name ?? id;
}

const dt = (iso: string | null | undefined): string => (iso ? fmtDate(iso) : NOT_RECORDED);

export function renderProjectDisputes(input: {
  nav: NavContext;
  project: Project;
  disputes: Dispute[];
  caps: string[];
  draws: DrawRequest[];
  users: Map<string, User>;
}): string {
  const canOpen = input.caps.includes("OPEN_DISPUTE");
  return renderDocument(
    <AppShell title="Disputes" nav={input.nav} context={`${input.project.name} · Disputes`}>
      <div className="page-wrap">
        <PageHeader
          title="Payment disputes"
          sub={`${input.project.name} — dispute register with release holds, cure requirements and authorized decisions.`}
          crumb={{ href: `/project/${input.project.id}`, label: input.project.name }}
        />
        <p className="lender-trust">{TRUST_NOTE}</p>
        {input.disputes.length === 0 ? (
          <EmptyStateV2
            icon={icons.shield()}
            title="No disputes recorded"
            what="A dispute records a disagreement over payment for construction work, pauses release eligibility for the affected scope, and tracks evidence, cure requirements and the authorized decision."
            condition="healthy"
          />
        ) : (
          <div className="table-scroll">
            <table className="lender-table">
              <thead>
                <tr><th>Dispute</th><th>Scope</th><th>Status</th><th>Disputed</th><th>Undisputed</th><th>Legal hold</th><th>Opened by</th><th>Opened</th></tr>
              </thead>
              <tbody>
                {input.disputes.map((d) => (
                  <tr>
                    <td><a href={`/dispute/${d.id}`}>{d.id.slice(0, 8)}…</a></td>
                    <td>{d.affectedScope}</td>
                    <td><Chip v={d.status} /></td>
                    <td className="num">{money(d.disputedAmount)}</td>
                    <td className="num">{d.undisputedAmount !== null ? money(d.undisputedAmount) : NOT_RECORDED}</td>
                    <td>{d.legalHold ? <span className="chip bad">Legal Hold Active</span> : "—"}</td>
                    <td>{name(input.users, d.openedByUserId)}</td>
                    <td>{dt(d.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canOpen ? (
          <section className="panel">
            <div className="panel-head"><h3>Open a dispute</h3><span className="right lender-sub">Opening a dispute pauses release eligibility for the affected scope — it never moves funds</span></div>
            <form className="lender-form" method="POST" action={`/api/projects/${input.project.id}/disputes`}>
              <div className="row">
                <label>Subject{" "}
                  <select name="subjectType">
                    <option value="DRAW_REQUEST">Draw request</option>
                    <option value="MILESTONE">Milestone</option>
                    <option value="PROJECT">Project</option>
                    <option value="PAYMENT_INSTRUCTION">Payment instruction</option>
                    <option value="DRAW_LINE_ITEM">Draw line item</option>
                    <option value="CHANGE_ORDER">Change order</option>
                    <option value="INVOICE_DOCUMENT">Invoice document</option>
                    <option value="RETAINAGE_RELEASE">Retainage release</option>
                    <option value="INSPECTION_RESULT">Inspection result</option>
                    <option value="EVIDENCE_ITEM">Evidence item</option>
                  </select>
                </label>
                <label>Subject id <input name="subjectId" required placeholder="e.g. a draw id" /></label>
                <label>Disputed amount <input name="disputedAmount" type="number" min="1" step="1" required /></label>
                <label>Undisputed amount <input name="undisputedAmount" type="number" min="0" step="1" /></label>
              </div>
              <div className="row">
                <label>Affected scope <input name="affectedScope" required placeholder="What work or payment is disputed" /></label>
                <label>Reason <input name="reason" required placeholder="Why the payment is disputed" /></label>
                <button className="btn secondary sm" type="submit">Open dispute</button>
              </div>
            </form>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

export function renderDisputeWorkspace(input: {
  nav: NavContext;
  detail: Detail;
  project: Project;
  draw: DrawRequest | null;
  users: Map<string, User>;
  notice: { kind: "ok" | "err"; text: string } | null;
}): string {
  const { detail, users } = input;
  const d = detail.dispute;
  const caps = new Set(detail.caps);
  const active = !["CLOSED"].includes(d.status);
  const officialRec = [...detail.recommendations].reverse().find((r) => r.official) ?? null;
  const participants = new Map<string, string>();
  participants.set(d.openedByUserId, "Opened the dispute");
  if (d.responsibleReviewerUserId) participants.set(d.responsibleReviewerUserId, "Responsible reviewer");
  for (const r of detail.responses) if (!participants.has(r.submittedByUserId)) participants.set(r.submittedByUserId, "Submitted a response");
  for (const e of detail.evidence) if (!participants.has(e.submittedByUserId)) participants.set(e.submittedByUserId, "Submitted evidence");
  if (d.resolvedByUserId) participants.set(d.resolvedByUserId, "Recorded the authorized decision");

  return renderDocument(
    <AppShell title="Dispute" nav={input.nav} context={`${input.project.name} · Dispute`}>
      <div className="page-wrap">
        <PageHeader
          title={`Dispute ${d.id.slice(0, 8)}`}
          sub={`${input.project.name} — ${d.affectedScope}`}
          crumb={{ href: `/project/${d.projectId}/disputes`, label: "Disputes" }}
        />
        {input.notice ? (
          <div className={`attn ${input.notice.kind === "ok" ? "info" : "bad"}`} role="status">
            <span className="a-body"><span className="a-t">{input.notice.kind === "ok" ? "Recorded" : "Not recorded"}</span><span className="a-s">{input.notice.text}</span></span>
          </div>
        ) : null}
        {d.legalHold ? (
          <AttentionBanner
            tone="bad"
            title="Legal Hold Active"
            detail={`Activated ${dt(d.legalHoldAt)} by ${name(users, d.legalHoldByUserId)}: ${d.legalHoldReason ?? ""}. While active, the dispute cannot be closed and affected payments cannot be submitted. A legal-hold flag is a record-preservation and workflow control — not legal advice or a court order.`}
          />
        ) : null}
        {active && !["RESOLVED_RELEASE"].includes(d.status) ? (
          <AttentionBanner
            tone="warn"
            title="Release hold active"
            detail={`${money(d.disputedAmount)} of ${d.affectedScope} is release-held while this dispute is ${enumLabel(d.status)}. The hold pauses eligibility only — no funds move, no balance changes, and OBV holds no escrow.`}
          />
        ) : null}
        <p className="lender-trust">{TRUST_NOTE}</p>

        <section className="panel">
          <div className="panel-head"><h3>Summary</h3><span className="right"><Chip v={d.status} /></span></div>
          <div className="pad-sm">
            <dl className="kv">
              {kv("Subject", `${enumLabel(d.subjectType)} · ${d.subjectId}`)}
              {kv("Affected draw", input.draw ? <a href={`/draw/${input.draw.id}?tab=lender`}>Draw #{input.draw.drawNumber}</a> : NOT_RECORDED)}
              {kv("Disputed amount", money(d.disputedAmount))}
              {kv("Undisputed amount", d.undisputedAmount !== null ? money(d.undisputedAmount) : NOT_RECORDED)}
              {kv("Reason", d.reason)}
              {kv("Opened by", `${name(users, d.openedByUserId)} · ${dt(d.openedAt)}`)}
              {kv("Responsible reviewer", name(users, d.responsibleReviewerUserId))}
            </dl>
            <h4 className="lender-sub" style="margin:10px 0 4px">Participants</h4>
            <dl className="kv">{[...participants.entries()].map(([uid, role]) => kv(name(users, uid), role))}</dl>
          </div>
          {caps.has("MANAGE_DISPUTE") && detail.allowedTransitions.length > 0 && active ? (
            <div className="lender-actions">
              <form className="lender-form" method="POST" action={`/api/disputes/${d.id}/transition`}>
                <div className="row">
                  <label>Move to{" "}
                    <select name="to">{detail.allowedTransitions.map((t) => <option value={t}>{enumLabel(t)}</option>)}</select>
                  </label>
                  <label>Reason <input name="reason" placeholder="Optional note" /></label>
                  <button className="btn secondary sm" type="submit">Record transition</button>
                </div>
              </form>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Questions and responses</h3><span className="right lender-sub">Submissions are immutable; corrections create a new version</span></div>
          {detail.responses.length === 0 ? (
            <p className="sub pad-sm">No written submissions yet.</p>
          ) : (
            <ol className="lender-stagelog">
              {detail.responses.map((r) => (
                <li>
                  <Chip v={r.kind} /> v{r.version} · {name(users, r.submittedByUserId)} · {dt(r.createdAt)}
                  {r.supersedesResponseId ? " · corrects an earlier version" : ""} — {r.body}
                </li>
              ))}
            </ol>
          )}
          {(caps.has("RESPOND_TO_DISPUTE") || caps.has("MANAGE_DISPUTE")) && active ? (
            <div className="lender-actions">
              <form className="lender-form" method="POST" action={`/api/disputes/${d.id}/responses`}>
                <div className="row">
                  <label>Kind{" "}
                    <select name="kind">
                      <option value="RESPONSE">Response</option>
                      <option value="QUESTION">Question</option>
                      <option value="ANSWER">Answer</option>
                      <option value="DISPUTED_FACTS">Disputed facts</option>
                      <option value="CURE_PROPOSAL">Corrective-action proposal</option>
                      <option value="CLARIFICATION_REQUEST">Clarification request</option>
                    </select>
                  </label>
                  <label>Body <input name="body" required placeholder="Written submission" /></label>
                  <button className="btn secondary sm" type="submit">Submit</button>
                </div>
              </form>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Evidence register</h3><span className="right lender-sub">Integrity hashes reuse the linked object's stored hash wherever one exists</span></div>
          {detail.evidence.length === 0 ? (
            <p className="sub pad-sm">No dispute evidence submitted.</p>
          ) : (
            <div className="table-scroll">
              <table className="lender-table">
                <thead><tr><th>Title</th><th>Type</th><th>Link</th><th>Hash</th><th>v</th><th>Review</th><th>Submitted by</th><th>When</th></tr></thead>
                <tbody>
                  {detail.evidence.map((e) => (
                    <tr>
                      <td>{e.title}</td>
                      <td>{enumLabel(e.evidenceType)}</td>
                      <td>{e.linkedType !== "NONE" ? `${enumLabel(e.linkedType)} ${e.linkedId?.slice(0, 8)}…` : e.externalReference ?? "—"}</td>
                      <td>{shortHash(e.documentHash, 12)}</td>
                      <td className="num">{e.version}</td>
                      <td><Chip v={e.reviewStatus} /></td>
                      <td>{name(users, e.submittedByUserId)}</td>
                      <td>{dt(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(caps.has("RESPOND_TO_DISPUTE") || caps.has("MANAGE_DISPUTE")) && active ? (
            <div className="lender-actions">
              <form className="lender-form" method="POST" action={`/api/disputes/${d.id}/evidence`}>
                <div className="row">
                  <label>Title <input name="title" required /></label>
                  <label>Type <input name="evidenceType" required placeholder="PHOTOGRAPH, INVOICE, CONTRACT…" /></label>
                  <label>External reference <input name="externalReference" placeholder="Optional" /></label>
                  <button className="btn secondary sm" type="submit">Record evidence</button>
                </div>
              </form>
              {caps.has("MANAGE_DISPUTE")
                ? detail.evidence.filter((e) => e.reviewStatus === "PENDING").map((e) => (
                    <form className="lender-form" method="POST" action={`/api/dispute-evidence/${e.id}/review`}>
                      <div className="row">
                        <span className="lender-sub">Review "{e.title}"</span>
                        <label>Decision <select name="status"><option value="ACCEPTED">Accept</option><option value="REJECTED">Reject</option></select></label>
                        <label>Notes <input name="notes" /></label>
                        <button className="btn secondary sm" type="submit">Record review</button>
                      </div>
                    </form>
                  ))
                : null}
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Cure requirements</h3><span className="right lender-sub">An overdue deadline is displayed — it never auto-resolves, auto-waives or releases payment</span></div>
          {detail.cures.length === 0 ? (
            <p className="sub pad-sm">No cure requirements.</p>
          ) : (
            <div className="table-scroll">
              <table className="lender-table">
                <thead><tr><th>Title</th><th>Responsible</th><th>Due</th><th>Priority</th><th>Status</th><th>Review</th></tr></thead>
                <tbody>
                  {detail.cures.map((c) => (
                    <tr>
                      <td>{c.title}{c.extensions.length > 0 ? ` (deadline moved ×${c.extensions.length})` : ""}</td>
                      <td>{name(users, c.responsiblePartyUserId)}</td>
                      <td>{c.dueAt ?? NOT_RECORDED}{c.overdue ? " " : ""}{c.overdue ? <span className="chip bad">Overdue</span> : null}</td>
                      <td>{enumLabel(c.priority)}</td>
                      <td><Chip v={c.status} /></td>
                      <td>{c.status === "WAIVED" ? `Waived: ${c.waiverReason}` : c.reviewDecisionNote ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {active ? (
            <div className="lender-actions">
              {caps.has("MANAGE_DISPUTE") ? (
                <form className="lender-form" method="POST" action={`/api/disputes/${d.id}/cures`}>
                  <div className="row">
                    <label>Title <input name="title" required /></label>
                    <label>Description <input name="description" required /></label>
                    <label>Due <input name="dueAt" type="date" /></label>
                    <label>Priority <select name="priority"><option>MEDIUM</option><option>HIGH</option><option>LOW</option></select></label>
                    <button className="btn secondary sm" type="submit">Create cure requirement</button>
                  </div>
                </form>
              ) : null}
              {detail.cures.filter((c) => ["OPEN", "REJECTED"].includes(c.status)).map((c) =>
                caps.has("RESPOND_TO_DISPUTE") || caps.has("MANAGE_DISPUTE") ? (
                  <form className="lender-form" method="POST" action={`/api/dispute-cures/${c.id}/submit`}>
                    <div className="row">
                      <span className="lender-sub">"{c.title}" — mark ready for review</span>
                      <label>Completion note <input name="completionNote" required /></label>
                      <button className="btn secondary sm" type="submit">Submit cure</button>
                    </div>
                  </form>
                ) : null
              )}
              {caps.has("MANAGE_DISPUTE")
                ? detail.cures.filter((c) => c.status === "SUBMITTED").map((c) => (
                    <form className="lender-form" method="POST" action={`/api/dispute-cures/${c.id}/review`}>
                      <div className="row">
                        <span className="lender-sub">Review "{c.title}"</span>
                        <label>Decision <select name="decision"><option value="ACCEPTED">Accept</option><option value="REJECTED">Reject</option></select></label>
                        <label>Note <input name="note" /></label>
                        <button className="btn secondary sm" type="submit">Record review</button>
                      </div>
                    </form>
                  ))
                : null}
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Inspection requests</h3><span className="right lender-sub">Results are evidence — they never auto-resolve the dispute or authorize payment</span></div>
          {detail.inspections.length === 0 ? (
            <p className="sub pad-sm">No inspections requested for this dispute.</p>
          ) : (
            <div className="table-scroll">
              <table className="lender-table">
                <thead><tr><th>Type</th><th>Status</th><th>Inspector</th><th>Scheduled</th><th>Completed</th><th>Result</th><th>Notes</th></tr></thead>
                <tbody>
                  {detail.inspections.map((i) => (
                    <tr>
                      <td>{i.inspectionType}</td>
                      <td><Chip v={i.status} /></td>
                      <td>{name(users, i.assignedInspectorUserId)}</td>
                      <td>{i.scheduledAt ?? NOT_RECORDED}</td>
                      <td>{dt(i.completedAt)}</td>
                      <td>{i.result ? <Chip v={i.result} /> : NOT_RECORDED}</td>
                      <td>{i.notes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {caps.has("MANAGE_DISPUTE") && active ? (
            <div className="lender-actions">
              <form className="lender-form" method="POST" action={`/api/disputes/${d.id}/inspections`}>
                <div className="row">
                  <label>Type <input name="inspectionType" required placeholder="Site verification" /></label>
                  <label>Scope <input name="locationScope" placeholder="Optional" /></label>
                  <button className="btn secondary sm" type="submit">Request inspection</button>
                </div>
              </form>
              {detail.inspections.filter((i) => ["REQUESTED", "ACCESS_FAILED"].includes(i.status)).map((i) => (
                <form className="lender-form" method="POST" action={`/api/dispute-inspections/${i.id}/schedule`}>
                  <div className="row">
                    <span className="lender-sub">Schedule {i.inspectionType}</span>
                    <label>Date <input name="scheduledAt" type="date" required /></label>
                    <button className="btn secondary sm" type="submit">Schedule</button>
                  </div>
                </form>
              ))}
              {detail.inspections.filter((i) => ["SCHEDULED", "REQUESTED"].includes(i.status)).map((i) => (
                <form className="lender-form" method="POST" action={`/api/dispute-inspections/${i.id}/complete`}>
                  <div className="row">
                    <span className="lender-sub">Complete {i.inspectionType}</span>
                    <label>Result <select name="result"><option>PASSED</option><option>FAILED</option><option>INCONCLUSIVE</option><option>NOT_APPLICABLE</option></select></label>
                    <label>Notes <input name="notes" /></label>
                    <button className="btn secondary sm" type="submit">Record completion</button>
                  </div>
                </form>
              ))}
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Advisory recommendation</h3><span className="right lender-sub">{ADVISORY_NOTE}</span></div>
          {officialRec ? (
            <div className="pad-sm">
              <dl className="kv">
                {kv("Recommendation", enumLabel(officialRec.kind))}
                {kv("Summary", officialRec.summary)}
                {kv("Recorded by", `${name(users, officialRec.createdByUserId)} · ${dt(officialRec.createdAt)}${officialRec.aiGenerated ? " · AI-generated, human-approved by " + name(users, officialRec.approvedByUserId) : ""}`)}
              </dl>
              <p className="lender-trust">{ADVISORY_NOTE}</p>
            </div>
          ) : (
            <p className="sub pad-sm">No official recommendation yet.{detail.recommendations.some((r) => !r.official) ? " An AI-generated draft awaits human review." : ""}</p>
          )}
          {caps.has("MANAGE_DISPUTE") && active ? (
            <div className="lender-actions">
              <form className="lender-form" method="POST" action={`/api/disputes/${d.id}/recommendation`}>
                <div className="row">
                  <label>Kind{" "}
                    <select name="kind">
                      <option value="RECOMMEND_FULL_RELEASE">Recommend full release</option>
                      <option value="RECOMMEND_PARTIAL_RELEASE">Recommend partial release</option>
                      <option value="RECOMMEND_CONTINUED_HOLD">Recommend continued hold</option>
                      <option value="RECOMMEND_CORRECTIVE_WORK">Recommend corrective work</option>
                      <option value="RECOMMEND_EXTERNAL_ESCALATION">Recommend external escalation</option>
                      <option value="RECOMMEND_RETURN_CONSIDERATION">Recommend return consideration</option>
                    </select>
                  </label>
                  <label>Summary <input name="summary" required /></label>
                  <button className="btn secondary sm" type="submit">Record recommendation</button>
                </div>
              </form>
              {detail.recommendations.filter((r) => !r.official).map((r) => (
                <form className="lender-form" method="POST" action={`/api/dispute-recommendations/${r.id}/approve`}>
                  <div className="row">
                    <span className="lender-sub">AI-generated draft: {enumLabel(r.kind)} — requires human review</span>
                    <button className="btn secondary sm" type="submit">Approve as official</button>
                  </div>
                </form>
              ))}
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Escalations</h3></div>
          {detail.escalations.length === 0 ? (
            <p className="sub pad-sm">No escalations recorded.</p>
          ) : (
            <ol className="lender-stagelog">
              {detail.escalations.map((e) => (
                <li><Chip v={e.status} /> {enumLabel(e.escalationType)} → {e.recipientName} · {dt(e.createdAt)} — {e.reason}{e.response ? ` · Response: ${e.response}` : ""}</li>
              ))}
            </ol>
          )}
          {caps.has("MANAGE_DISPUTE") && active ? (
            <div className="lender-actions">
              <form className="lender-form" method="POST" action={`/api/disputes/${d.id}/escalations`}>
                <div className="row">
                  <label>To{" "}
                    <select name="escalationType">
                      <option>LENDER</option><option>OWNER</option><option>ATTORNEY</option>
                      <option>INSURER</option><option>SURETY</option><option>INDEPENDENT_INSPECTOR</option>
                      <option>EXTERNAL_REVIEWER</option><option>ESCROW_PARTNER</option><option>BANK_REPRESENTATIVE</option>
                    </select>
                  </label>
                  <label>Recipient <input name="recipientName" required /></label>
                  <label>Reason <input name="reason" required /></label>
                  <button className="btn secondary sm" type="submit">Record escalation</button>
                </div>
              </form>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Authorized decision</h3><span className="right lender-sub">Recorded by an authorized party — never by OBV</span></div>
          {d.resolutionType ? (
            <div className="pad-sm">
              <dl className="kv">
                {kv("Decision", enumLabel(d.resolutionType))}
                {kv("Amount", d.resolutionAmount !== null ? money(d.resolutionAmount) : NOT_RECORDED)}
                {kv("Decision maker", `${name(users, d.resolvedByUserId)} (${enumLabel(d.resolvedByRole ?? "")})`)}
                {kv("Recorded", dt(d.resolvedAt))}
                {kv("Reasoning", d.resolutionReasoning)}
                {kv("Conditions", d.resolutionConditions ?? NOT_RECORDED)}
                {kv("External authorization reference", d.resolutionExternalReference ?? NOT_RECORDED)}
              </dl>
              <p className="lender-trust">{RESOLUTION_ACKNOWLEDGEMENT}</p>
            </div>
          ) : (
            <p className="sub pad-sm">No authorized decision recorded yet.</p>
          )}
          {caps.has("DECIDE_DISPUTE") && ["READY_FOR_DECISION", "ESCALATED"].includes(d.status) ? (
            <div className="lender-actions">
              <form className="lender-form" method="POST" action={`/api/disputes/${d.id}/resolve`}>
                <div className="row">
                  <label>Decision{" "}
                    <select name="resolutionType">
                      <option value="AUTHORIZE_FULL_RELEASE">Authorize full release</option>
                      <option value="AUTHORIZE_PARTIAL_RELEASE">Authorize partial release</option>
                      <option value="CONTINUE_HOLD">Continue hold</option>
                      <option value="REQUIRE_ADDITIONAL_CURE">Require additional cure</option>
                      <option value="ESCALATE_EXTERNALLY">Escalate externally</option>
                      <option value="CLOSE_WITHOUT_RELEASE">Close without release</option>
                      <option value="RETURN_TO_AUTHORIZED_PARTY">Return to the authorized party</option>
                    </select>
                  </label>
                  <label>Amount <input name="amount" type="number" min="0" step="1" /></label>
                  <label>Reasoning <input name="reasoning" required /></label>
                </div>
                <div className="row">
                  <label style="flex:2 1 320px"><input type="checkbox" name="acknowledged" value="true" required /> {RESOLUTION_ACKNOWLEDGEMENT}</label>
                  <button className="btn secondary sm" type="submit">Record authorized decision</button>
                </div>
              </form>
            </div>
          ) : null}
          {caps.has("DECIDE_DISPUTE") && d.resolutionType && d.status !== "CLOSED" && !d.legalHold ? (
            <div className="lender-actions">
              <form className="lender-form" method="POST" action={`/api/disputes/${d.id}/close`}>
                <div className="row">
                  <span className="lender-sub">Close the dispute record (the decision above remains the authorized outcome)</span>
                  <button className="btn secondary sm" type="submit">Close dispute</button>
                </div>
              </form>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Timeline</h3><span className="right lender-sub">Append-only history — corrections are additive, never overwrites</span></div>
          <ol className="lender-stagelog">
            {detail.events.map((e) => (
              <li><Chip v={e.type} /> {dt(e.createdAt)} · {name(users, e.actorUserId)} — {e.detail}</li>
            ))}
          </ol>
        </section>
      </div>
    </AppShell>
  );
}
