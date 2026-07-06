/**
 * Funder Verification Report — print-styled HTML document rendered to PDF
 * by headless Chromium (see scripts/render-pdf.js). All content comes from
 * FunderReportData (real application records).
 *
 * Design: institutional, audit-grade, printable, grayscale-safe (status is
 * always conveyed by text labels, never color alone).
 */
import { h, Fragment, VNode, renderDocument, raw } from "./jsx";
import type { FunderReportData, ReportMilestone, TimelineEvent } from "../report/data";
import type { UserRole, Verdict } from "../../shared/types";

const money = (n: number): string => "$" + n.toLocaleString("en-US");
const ts = (iso: string | null): string =>
  iso ? iso.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC") : "—";
const short = (hash: string | null | undefined, n = 20): string =>
  hash ? hash.slice(0, n) + "…" : "—";
const roleLabel = (r: UserRole): string =>
  ({ FUNDER_REP: "Funder Representative", PROJECT_MANAGER: "Project Manager", COMPLIANCE_REVIEWER: "Compliance Reviewer", FIELD: "Field Engineer" })[r];

function verdictLabel(v: Verdict): string {
  return v === "VERIFIED" ? "VERIFIED" : v === "NEEDS_REVIEW" ? "NEEDS REVIEW" : "REJECTED";
}

function Tag(props: { tone?: string; children?: unknown }): VNode {
  return <span className={`tag ${props.tone ?? ""}`}>{props.children}</span>;
}

/** Why a tranche is currently held, from real stored state. */
function heldReason(m: ReportMilestone): string {
  if (m.milestone.accountStatus === "RELEASED") return "";
  switch (m.milestone.status) {
    case "VERIFIED":
      return m.approval?.status === "PENDING"
        ? `Awaiting human approval (${m.approvalRecords.filter((r) => r.decision === "APPROVED").length} of ${m.approval.requiredRoles.length} recorded)`
        : "Verified — approval request not yet resolved";
    case "UNDER_REVIEW":
      return "Evidence flagged NEEDS REVIEW — human review required";
    case "PENDING_EVIDENCE":
      return m.approval?.status === "REJECTED"
        ? "Release rejected by governance — new evidence required"
        : "Awaiting field evidence";
    case "NOT_STARTED":
      return "Milestone not started";
    case "APPROVED":
      return "Approved — release pending";
    default:
      return "Held";
  }
}

function approvalProgressText(m: ReportMilestone): string {
  if (!m.approval) return "Not requested";
  if (m.approval.status === "APPROVED") return `Approved (${m.approval.requiredRoles.length} of ${m.approval.requiredRoles.length})`;
  if (m.approval.status === "REJECTED") return "Rejected";
  const n = m.approvalRecords.filter((r) => r.decision === "APPROVED").length;
  return `Pending (${n} of ${m.approval.requiredRoles.length})`;
}

function evidenceStatusText(m: ReportMilestone): string {
  if (m.evidence.length === 0) return "None submitted";
  const latest = m.evidence[0];
  return `Submitted${latest.evidence.isDemoFallback ? " (demo fallback)" : ""}`;
}

const REPORT_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 9.5pt; line-height: 1.45; color: #16202e;
  }
  .page-break { break-after: page; }
  .avoid-break { break-inside: avoid; }
  h1 { font-size: 21pt; margin: 0; letter-spacing: -0.015em; }
  h2 {
    font-size: 12.5pt; margin: 18pt 0 7pt; color: #111d33;
    border-bottom: 1.5pt solid #111d33; padding-bottom: 3pt;
    break-after: avoid;
  }
  h3 { font-size: 10.5pt; margin: 10pt 0 5pt; break-after: avoid; }
  p { margin: 4pt 0; }
  .muted { color: #5b6b7f; }
  .small { font-size: 8pt; }
  .mono { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 0.92em; }

  table { width: 100%; border-collapse: collapse; font-size: 8.6pt; }
  table.register { table-layout: fixed; font-size: 7.9pt; width: 99%; }
  table.register td { word-wrap: break-word; overflow-wrap: break-word; }
  table.register td.date { white-space: nowrap; font-size: 7.3pt; }
  table.gov th { white-space: normal; }
  table.register .tag { font-size: 6.2pt; padding: 0.5pt 2.5pt; letter-spacing: 0.02em; }
  th {
    text-align: left; font-size: 7.4pt; text-transform: uppercase; letter-spacing: 0.05em;
    color: #47566b; background: #eef1f6; padding: 4pt 6pt;
    border: 0.5pt solid #c5cedb; break-inside: avoid;
  }
  td { padding: 4pt 6pt; border: 0.5pt solid #d8dfe8; vertical-align: top; }
  tr { break-inside: avoid; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.plain td, table.plain th { border-left: none; border-right: none; }
  table.plain th { background: #f4f6fa; }
  td.k { color: #5b6b7f; width: 34%; }

  .tag {
    display: inline-block; font-size: 7pt; font-weight: 700; letter-spacing: 0.05em;
    border: 0.75pt solid #8d9bad; border-radius: 2pt; padding: 0.5pt 4pt;
    color: #34404f; white-space: nowrap;
  }
  .tag.ok { border-color: #15803d; color: #14532d; background: #f0f9f2; }
  .tag.warn { border-color: #b45309; color: #7c3d0a; background: #fdf6e9; }
  .tag.bad { border-color: #b91c1c; color: #7f1d1d; background: #fdf1f0; }
  .tag.info { border-color: #1e40af; color: #1e3a8a; background: #f0f4fd; }

  /* cover */
  .cover-brand { display: flex; align-items: center; gap: 9pt; }
  .cover-mark {
    width: 34pt; height: 34pt; border-radius: 6pt; background: #1e40af;
    color: #fff; display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 13pt; letter-spacing: 0.02em;
  }
  .cover-rule { height: 2.5pt; background: #111d33; margin: 14pt 0 16pt; }
  .cover-facts { margin: 14pt 0; }
  .kpis { display: flex; flex-wrap: wrap; gap: 8pt; margin: 12pt 0; }
  .kpi {
    flex: 1 1 28%; border: 0.75pt solid #c5cedb; border-radius: 4pt; padding: 7pt 9pt;
    min-width: 110pt;
  }
  .kpi .l { font-size: 7pt; text-transform: uppercase; letter-spacing: 0.06em; color: #5b6b7f; font-weight: 700; }
  .kpi .v { font-size: 14pt; font-weight: 800; font-variant-numeric: tabular-nums; margin-top: 1pt; }
  .statement {
    border-left: 2.5pt solid #1e40af; background: #f4f6fa;
    padding: 8pt 11pt; margin: 14pt 0; font-size: 9pt;
  }
  .note {
    border: 0.75pt dashed #8d9bad; background: #fafbfd;
    padding: 7pt 10pt; margin: 8pt 0; font-size: 8.3pt; color: #34404f;
  }

  /* evidence sections */
  .ev-section {
    border: 0.75pt solid #c5cedb; border-radius: 4pt;
    padding: 10pt 12pt; margin: 10pt 0; break-inside: avoid;
  }
  .ev-head { display: flex; align-items: baseline; gap: 8pt; margin-bottom: 6pt; }
  .ev-head .amount { margin-left: auto; font-weight: 800; font-size: 11pt; font-variant-numeric: tabular-nums; }
  .ev-grid { display: flex; gap: 12pt; }
  .ev-photo { width: 165pt; flex-shrink: 0; }
  .ev-photo img {
    width: 165pt; height: 124pt; object-fit: cover;
    border: 0.75pt solid #c5cedb; border-radius: 3pt; display: block;
  }
  .ev-photo .missing {
    width: 165pt; height: 124pt; border: 0.75pt dashed #8d9bad; border-radius: 3pt;
    display: flex; align-items: center; justify-content: center;
    color: #5b6b7f; font-size: 8pt; text-align: center;
  }
  .ev-body { flex: 1; min-width: 0; }
  .sub-label {
    font-size: 7pt; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;
    color: #5b6b7f; margin: 8pt 0 3pt;
  }
  .checks { margin: 0; padding: 0; list-style: none; }
  .checks li { display: flex; gap: 6pt; padding: 2.5pt 0; border-top: 0.5pt solid #e3e8ef; font-size: 8.4pt; }
  .checks li:first-child { border-top: none; }
  .checks .detail { color: #5b6b7f; display: block; font-size: 7.8pt; }

  .seq { font-size: 8.6pt; font-weight: 700; letter-spacing: 0.03em; margin: 8pt 0; }
  .seq .arr { color: #8d9bad; padding: 0 3pt; }

  .hashrow td { font-size: 7.6pt; }
  .footer-space { height: 4pt; }
`;

export function renderFunderReport(d: FunderReportData): string {
  const p = d.project;
  const verifiedWithEvidence = d.milestones.filter((m) => m.evidence.length > 0);

  return renderDocument(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{`Project Verification & Fund Release Report — ${p.name}`}</title>
        <style>{raw(REPORT_CSS)}</style>
      </head>
      <body>
        {/* ============================ PAGE 1 — COVER ============================ */}
        <section className="page-break">
          <div className="cover-brand">
            <div className="cover-mark">OBV</div>
            <div>
              <div style="font-weight:800;font-size:13pt">OpenBuild Verify</div>
              <div className="muted" style="font-size:8.5pt">The truth layer for physical projects</div>
            </div>
          </div>
          <div className="cover-rule"></div>

          <div className="muted" style="font-size:9pt;letter-spacing:0.08em;text-transform:uppercase;font-weight:700">
            Project Verification &amp; Fund Release Report
          </div>
          <h1 style="margin-top:4pt">{p.name}</h1>
          <p className="muted" style="font-size:10pt;margin-top:2pt">{p.location}</p>

          <table className="plain cover-facts">
            <tbody>
              <tr><td className="k">Funding organization</td><td>{d.funder?.name ?? "—"}</td></tr>
              <tr><td className="k">Implementing organization</td><td>{d.implementingOrg?.name ?? "—"}</td></tr>
              <tr><td className="k">Project status</td><td>{p.status}</td></tr>
              <tr><td className="k">Report generated</td><td className="mono">{ts(d.generatedAt)}</td></tr>
              <tr><td className="k">Generated by</td><td>{d.generatedBy.name} ({d.generatedBy.title})</td></tr>
            </tbody>
          </table>

          <div className="kpis">
            <div className="kpi"><div className="l">Total budget</div><div className="v">{money(d.totals.budget)}</div></div>
            <div className="kpi"><div className="l">Funds released</div><div className="v">{money(d.totals.released)}</div></div>
            <div className="kpi"><div className="l">Funds held</div><div className="v">{money(d.totals.held)}</div></div>
            <div className="kpi"><div className="l">Budget released</div><div className="v">{d.totals.releasedPct}%</div></div>
            <div className="kpi"><div className="l">Verified milestones</div><div className="v">{d.counts.verified} / {d.counts.milestones}</div></div>
            <div className="kpi"><div className="l">Pending approvals</div><div className="v">{d.counts.pendingApprovals}</div></div>
            <div className="kpi"><div className="l">Flagged evidence</div><div className="v">{d.counts.flaggedEvidence}</div></div>
            <div className="kpi">
              <div className="l">Ledger integrity</div>
              <div className="v" style="font-size:11pt">
                {d.integrity.valid ? "CHAIN INTACT" : `TAMPERING AT #${d.integrity.brokenAt}`}
              </div>
            </div>
          </div>

          <div className="statement">
            OBV records physical evidence, verification results, approval governance,
            fund-release state, and evidence-ledger integrity for milestone-based
            infrastructure projects.
          </div>
          <p className="muted small">
            Generated by the OBV demonstration environment. Verification of photo content is
            simulated in this demo; geofence and metadata-integrity checks are computed from
            recorded data. This document reports stored application state and makes no further
            compliance claims.
          </p>
        </section>

        {/* ============================ PAGE 2 — SUMMARY ============================ */}
        <section className="page-break">
          <h2>1 · Project summary</h2>
          <table className="plain">
            <tbody>
              <tr><td className="k">Project ID</td><td className="mono">{p.id}</td></tr>
              <tr><td className="k">Project name</td><td>{p.name}</td></tr>
              <tr><td className="k">Project type</td><td>{p.projectType.replace(/_/g, " ")}</td></tr>
              <tr><td className="k">Location</td><td>{p.location}</td></tr>
              <tr><td className="k">Funder</td><td>{d.funder?.name ?? "—"}</td></tr>
              <tr><td className="k">Implementing organization</td><td>{d.implementingOrg?.name ?? "—"}</td></tr>
              <tr><td className="k">Total budget</td><td>{money(d.totals.budget)}</td></tr>
              <tr><td className="k">Financial close (first account event)</td><td className="mono">{ts(d.financialClose)}</td></tr>
              <tr><td className="k">Current project status</td><td>{p.status}</td></tr>
              <tr>
                <td className="k">Overall physical progress</td>
                <td>{d.counts.verified} of {d.counts.milestones} milestones verified or beyond ({d.totals.releasedPct}% of budget released)</td>
              </tr>
              <tr>
                <td className="k">Current financial state</td>
                <td>{money(d.totals.released)} released · {money(d.totals.held)} held</td>
              </tr>
            </tbody>
          </table>

          <h3>Financial summary</h3>
          <table>
            <thead>
              <tr><th>Total committed</th><th className="num">Total released</th><th className="num">Total held</th><th className="num">Release %</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>{money(d.totals.budget)}</td>
                <td className="num">{money(d.totals.released)}</td>
                <td className="num">{money(d.totals.held)}</td>
                <td className="num">{d.totals.releasedPct}%</td>
              </tr>
            </tbody>
          </table>

          <h3>Verification summary</h3>
          <table>
            <thead>
              <tr>
                <th className="num">Total milestones</th>
                <th className="num">Verified</th>
                <th className="num">Needs review</th>
                <th className="num">Rejected evidence</th>
                <th className="num">Pending approvals</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="num">{d.counts.milestones}</td>
                <td className="num">{d.counts.verified}</td>
                <td className="num">{d.counts.needsReview}</td>
                <td className="num">{d.counts.rejectedEvidence}</td>
                <td className="num">{d.counts.pendingApprovals}</td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* ======================= PAGE 3 — MILESTONE REGISTER ======================= */}
        <section>
          <h2>2 · Milestone register</h2>
          <table className="register">
            <colgroup>
              <col style="width:3.5%" />
              <col style="width:14%" />
              <col style="width:23.5%" />
              <col style="width:8.5%" />
              <col style="width:10.5%" />
              <col style="width:9%" />
              <col style="width:5%" />
              <col style="width:9.5%" />
              <col style="width:7.5%" />
              <col style="width:9%" />
            </colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>Milestone</th>
                <th>Requirement summary</th>
                <th className="num">Tranche</th>
                <th>Evidence</th>
                <th>Verdict</th>
                <th className="num">Conf.</th>
                <th>Approval</th>
                <th>Funds</th>
                <th>Released</th>
              </tr>
            </thead>
            <tbody>
              {d.milestones.map((m) => {
                const v = m.evidence[0]?.verification ?? null;
                return (
                  <tr>
                    <td>{m.milestone.seq}</td>
                    <td>{m.milestone.title}</td>
                    <td className="small">
                      {m.milestone.requirement.length > 130
                        ? m.milestone.requirement.slice(0, 129) + "…"
                        : m.milestone.requirement}
                    </td>
                    <td className="num">{money(m.milestone.trancheAmount)}</td>
                    <td>{evidenceStatusText(m)}</td>
                    <td>{v ? <Tag tone={v.verdict === "VERIFIED" ? "ok" : v.verdict === "NEEDS_REVIEW" ? "warn" : "bad"}>{verdictLabel(v.verdict)}</Tag> : "—"}</td>
                    <td className="num">{v ? v.confidence.toFixed(2) : "—"}</td>
                    <td>{approvalProgressText(m)}</td>
                    <td>
                      <Tag tone={m.milestone.accountStatus === "RELEASED" ? "ok" : "warn"}>
                        {m.milestone.accountStatus}
                      </Tag>
                    </td>
                    <td className="mono date">{m.releasedAt ? ts(m.releasedAt).slice(0, 10) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {/* ===================== PER-MILESTONE EVIDENCE SECTIONS ===================== */}
        <section>
          <h2>3 · Evidence &amp; verification detail</h2>
          {verifiedWithEvidence.length === 0 ? (
            <p className="muted">No evidence has been submitted for this project yet.</p>
          ) : (
            verifiedWithEvidence.map((m) =>
              m.evidence.map((e, idx) => (
                <div className="ev-section">
                  <div className="ev-head">
                    <h3 style="margin:0">
                      M{m.milestone.seq} · {m.milestone.title}
                      {m.evidence.length > 1 ? ` — submission ${m.evidence.length - idx} of ${m.evidence.length}` : ""}
                    </h3>
                    <span className="amount">{money(m.milestone.trancheAmount)}</span>
                  </div>
                  <p className="small muted" style="margin:0 0 7pt">
                    <b>Requirement:</b> {m.milestone.requirement}
                  </p>
                  <div className="ev-grid">
                    <div className="ev-photo">
                      {e.photoAvailable ? (
                        <img src={e.evidence.photoPath} alt="Evidence photo" />
                      ) : (
                        <div className="missing">Photo file unavailable<br />hash retained in ledger</div>
                      )}
                      <div style="margin-top:3pt">
                        {e.verification ? (
                          <Tag tone={e.verification.verdict === "VERIFIED" ? "ok" : e.verification.verdict === "NEEDS_REVIEW" ? "warn" : "bad"}>
                            {verdictLabel(e.verification.verdict)}
                          </Tag>
                        ) : (
                          <Tag>UNVERIFIED</Tag>
                        )}{" "}
                        {e.evidence.isDemoFallback ? <Tag tone="warn">DEMO FALLBACK</Tag> : null}
                      </div>
                    </div>
                    <div className="ev-body">
                      <div className="sub-label">B · Evidence record</div>
                      <table className="plain">
                        <tbody>
                          <tr><td className="k">Submitted by</td><td>{e.submittedBy ? `${e.submittedBy.name} (${e.submittedBy.title})` : "—"}</td></tr>
                          <tr><td className="k">Captured</td><td className="mono">{ts(e.evidence.capturedAt)}</td></tr>
                          <tr><td className="k">Uploaded</td><td className="mono">{ts(e.evidence.uploadedAt)}</td></tr>
                          <tr><td className="k">GPS</td><td className="mono">{e.evidence.latitude.toFixed(5)}, {e.evidence.longitude.toFixed(5)}</td></tr>
                          <tr><td className="k">Device</td><td>{e.evidence.deviceMetadata?.platform ?? "—"} · {e.evidence.deviceMetadata?.screen ?? "—"} · {e.evidence.deviceMetadata?.language ?? "—"}</td></tr>
                        </tbody>
                      </table>

                      {e.verification ? (
                        <>
                          <div className="sub-label">C · Verification results</div>
                          <ul className="checks">
                            {e.verification.checks.map((c) => (
                              <li>
                                <Tag tone={c.passed ? "ok" : e.verification!.verdict === "NEEDS_REVIEW" ? "warn" : "bad"}>
                                  {c.passed ? "PASS" : e.verification!.verdict === "NEEDS_REVIEW" ? "REVIEW" : "FAIL"}
                                </Tag>
                                <span>
                                  <b>{c.name}</b>
                                  <span className="detail">{c.detail}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                          <p style="margin:4pt 0 0;font-size:8.4pt">
                            <b>Verdict:</b> {verdictLabel(e.verification.verdict)} ·{" "}
                            <b>Confidence:</b> {e.verification.confidence.toFixed(2)}
                            <span className="detail muted" style="display:block">{e.verification.reasoning}</span>
                          </p>
                        </>
                      ) : null}

                      <div className="sub-label">D · Governance</div>
                      {m.approval ? (
                        <table className="plain">
                          <tbody>
                            <tr>
                              <td className="k">Approval request</td>
                              <td>
                                <Tag tone={m.approval.status === "APPROVED" ? "ok" : m.approval.status === "REJECTED" ? "bad" : "warn"}>
                                  {m.approval.status === "PENDING" ? "PENDING APPROVAL" : m.approval.status}
                                </Tag>{" "}
                                <span className="small muted">requested {ts(m.approval.createdAt)}</span>
                              </td>
                            </tr>
                            {m.approval.requiredRoles.map((role) => {
                              const rec = m.approvalRecords.find((r) => r.role === role);
                              return (
                                <tr>
                                  <td className="k">{roleLabel(role)}</td>
                                  <td>
                                    {rec ? (
                                      <>
                                        <Tag tone={rec.decision === "APPROVED" ? "ok" : "bad"}>{rec.decision}</Tag>{" "}
                                        <span className="small muted">{ts(rec.createdAt)}</span>
                                      </>
                                    ) : (
                                      <Tag>AWAITING</Tag>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : (
                        <p className="small muted" style="margin:0">No approval request (created automatically on VERIFIED verdict).</p>
                      )}

                      <div className="sub-label">E · Financial state</div>
                      <p style="margin:0;font-size:8.6pt">
                        <b>Tranche {money(m.milestone.trancheAmount)}</b> —{" "}
                        <Tag tone={m.milestone.accountStatus === "RELEASED" ? "ok" : "warn"}>{m.milestone.accountStatus}</Tag>
                        {m.milestone.accountStatus === "RELEASED" ? (
                          <span className="small muted" style="display:block">
                            Released {ts(m.releasedAt)} · virtual account event <span className="mono">{short(m.releaseEventId, 13)}</span>
                          </span>
                        ) : (
                          <span className="small muted" style="display:block">{heldReason(m)}</span>
                        )}
                      </p>

                      <div className="sub-label">F · Proof integrity</div>
                      <table className="plain hashrow">
                        <tbody>
                          <tr><td className="k">Evidence hash</td><td className="mono">{short(e.evidence.hash, 34)}</td></tr>
                          <tr><td className="k">Previous ledger hash</td><td className="mono">{short(e.ledgerEntry?.previousHash, 34)}</td></tr>
                          <tr><td className="k">Current ledger hash</td><td className="mono">{short(e.ledgerEntry?.currentHash, 34)}</td></tr>
                          <tr><td className="k">Ledger entry</td><td>{e.ledgerEntry ? `#${e.ledgerEntry.seq}` : "not ledgered (only verified evidence enters the chain)"}</td></tr>
                          <tr>
                            <td className="k">Integrity status</td>
                            <td>
                              <Tag tone={d.integrity.valid ? "ok" : "bad"}>
                                {d.integrity.valid ? "CHAIN INTACT" : `TAMPERING DETECTED AT ENTRY ${d.integrity.brokenAt}`}
                              </Tag>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                      <p className="small muted" style="margin:2pt 0 0">Full hashes are listed in Appendix A.</p>
                    </div>
                  </div>
                </div>
              ))
            )
          )}
        </section>

        {/* ======================== VIRTUAL ACCOUNT SUMMARY ======================== */}
        <section>
          <h2>4 · Virtual account summary (financial control)</h2>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Milestone</th>
                <th className="num">Tranche</th>
                <th>State</th>
                <th>Release eligibility</th>
                <th>Approval</th>
                <th>Event timestamp</th>
              </tr>
            </thead>
            <tbody>
              {d.milestones.map((m) => {
                const lastEvent = [...d.accountEvents]
                  .reverse()
                  .find((e) => e.milestoneId === m.milestone.id);
                const eligibility =
                  m.milestone.accountStatus === "RELEASED"
                    ? "Released after completed governance"
                    : m.approval?.status === "PENDING"
                      ? `Eligible on sign-off (${approvalProgressText(m)})`
                      : m.milestone.status === "UNDER_REVIEW"
                        ? "Blocked — evidence needs review"
                        : "Not yet eligible — " + heldReason(m).toLowerCase();
                return (
                  <tr>
                    <td>{m.milestone.seq}</td>
                    <td>{m.milestone.title}</td>
                    <td className="num">{money(m.milestone.trancheAmount)}</td>
                    <td><Tag tone={m.milestone.accountStatus === "RELEASED" ? "ok" : "warn"}>{m.milestone.accountStatus}</Tag></td>
                    <td className="small">{eligibility}</td>
                    <td className="small">{approvalProgressText(m)}</td>
                    <td className="mono small">{lastEvent ? ts(lastEvent.createdAt) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="note">
            OBV does not execute real bank transfers in this demonstration environment. The
            Virtual Account ledger represents governed release eligibility and project-level
            financial state. Production disbursement would occur through regulated banking
            partners and approved payment rails.
          </div>
        </section>

        {/* ====================== APPROVAL GOVERNANCE SUMMARY ====================== */}
        <section className="avoid-break">
          <h2>5 · Approval governance summary</h2>
          <table className="gov">
            <thead>
              <tr>
                <th className="num">Approval requests</th>
                <th className="num">Completed</th>
                <th className="num">Pending</th>
                <th className="num">Rejected</th>
                <th className="num">Amount awaiting approval</th>
                <th className="num">Released after governance</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="num">{d.governance.totalRequests}</td>
                <td className="num">{d.governance.approved}</td>
                <td className="num">{d.governance.pending}</td>
                <td className="num">{d.governance.rejected}</td>
                <td className="num">{money(d.governance.amountAwaiting)}</td>
                <td className="num">{money(d.governance.amountReleasedAfterGovernance)}</td>
              </tr>
            </tbody>
          </table>
          <div className="seq">
            VERIFICATION <span className="arr">→</span> APPROVAL REQUEST <span className="arr">→</span>{" "}
            REQUIRED HUMAN SIGN-OFF <span className="arr">→</span> RELEASE ELIGIBILITY{" "}
            <span className="arr">→</span> VIRTUAL ACCOUNT STATE CHANGE
          </div>
          <p className="small muted">
            AI verification does not independently release funds. Every release requires the
            configured human approvals ({(d.milestones.find((m) => m.approval)?.approval?.requiredRoles ?? ["FUNDER_REP", "COMPLIANCE_REVIEWER"]).map(roleLabel).join(" and ")}) recorded above.
          </p>
        </section>

        {/* ========================= LEDGER INTEGRITY ========================= */}
        <section className="avoid-break">
          <h2>6 · Evidence-ledger integrity</h2>
          <table className="plain">
            <tbody>
              <tr><td className="k">Ledger entries</td><td>{d.integrity.entries}</td></tr>
              <tr><td className="k">Integrity check run</td><td className="mono">{ts(d.integrity.checkedAt)}</td></tr>
              <tr>
                <td className="k">Status</td>
                <td>
                  <Tag tone={d.integrity.valid ? "ok" : "bad"}>
                    {d.integrity.valid ? "CHAIN INTACT" : `TAMPERING DETECTED AT ENTRY ${d.integrity.brokenAt}`}
                  </Tag>
                  {!d.integrity.valid ? (
                    <span style="display:block;font-weight:700;color:#7f1d1d;margin-top:2pt">
                      First affected entry: #{d.integrity.brokenAt}. Entries at and after this
                      point cannot be relied upon; investigate before accepting this report.
                    </span>
                  ) : null}
                </td>
              </tr>
            </tbody>
          </table>
          <div className="note">
            Each evidence-ledger entry is hash-chained to the previous entry. This
            demonstration uses application-level hash chaining. Production architecture may
            add immutable object storage and retention/legal-hold controls.
          </div>
        </section>

        {/* ========================= ACTIVITY TIMELINE ========================= */}
        <section>
          <h2>7 · Activity timeline</h2>
          <table>
            <thead>
              <tr>
                <th style="width:98pt">Timestamp</th>
                <th>Event</th>
                <th>Actor</th>
                <th>Context</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {d.timeline.map((t: TimelineEvent) => (
                <tr>
                  <td className="mono small">{ts(t.timestamp)}</td>
                  <td>{t.event}</td>
                  <td className="small">{t.actor ?? "—"}</td>
                  <td className="small">{t.context}</td>
                  <td className="small">{t.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* ============================ APPENDIX ============================ */}
        <section>
          <h2>Appendix A · Full ledger hashes</h2>
          <table>
            <thead>
              <tr><th>#</th><th>Timestamp</th><th>Hashes (payload / previous / current)</th></tr>
            </thead>
            <tbody>
              {d.ledger.map((e) => (
                <tr>
                  <td>{e.seq}</td>
                  <td className="mono small">{ts(e.timestamp)}</td>
                  <td className="mono" style="font-size:7pt;word-break:break-all">
                    P: {e.payloadHash}<br />
                    ← {e.previousHash}<br />
                    = {e.currentHash}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table style="margin-top:8pt">
            <thead>
              <tr><th>Milestone</th><th>Evidence ID</th><th>Evidence hash (full)</th></tr>
            </thead>
            <tbody>
              {verifiedWithEvidence.flatMap((m) =>
                m.evidence.map((e) => (
                  <tr>
                    <td>M{m.milestone.seq}</td>
                    <td className="mono small">{e.evidence.id.slice(0, 13)}…</td>
                    <td className="mono" style="font-size:7pt;word-break:break-all">{e.evidence.hash}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="footer-space"></div>
        </section>
      </body>
    </html>
  );
}
