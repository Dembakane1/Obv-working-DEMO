/** Server-rendered pages. */
import { h, Fragment, VNode, renderDocument } from "./jsx";
import {
  AccountBadge,
  ApprovalBadge,
  ConfidenceBar,
  EvidencePanel,
  Layout,
  MilestoneStatusBadge,
  VerdictBadge,
  fmtDate,
  money,
  shortHash,
} from "./components";
import type {
  ApprovalRequest,
  EvidenceItem,
  LedgerEntry,
  Milestone,
  Notification,
  Organization,
  Project,
  User,
  Verification,
  VirtualAccountEvent,
} from "../../shared/types";
import type { ProjectAccountSummary } from "../services/VirtualAccountService";

export interface MilestoneRow {
  milestone: Milestone;
  latestEvidence: EvidenceItem | null;
  verification: Verification | null;
  approval: ApprovalRequest | null;
}

export interface EvidenceBundle {
  evidence: EvidenceItem;
  verification: Verification | null;
  ledgerEntry: LedgerEntry | null;
  milestone: Milestone;
  submittedBy: User | null;
}

// ---------------------------------------------------------------- home

export function renderUserSwitcher(users: User[], orgs: Map<string, Organization>): string {
  return renderDocument(
    <Layout title="Select demo user" user={null}>
      <div className="wrap-narrow" style="margin:0 auto">
        <h1>Demo sign-in</h1>
        <p className="sub">
          OBV is running in demo mode. Pick a seeded user to explore their view of the
          platform — no passwords required. Full authentication arrives with the
          production build.
        </p>
        <div className="roles">
          {users.map((u) => (
            <form method="POST" action="/api/session">
              <input type="hidden" name="userId" value={u.id} />
              <button className="role-card" type="submit" style="width:100%">
                <span className="role">{u.role.replace(/_/g, " ")}</span>
                <span className="name" style="display:block">{u.name}</span>
                <span className="title" style="display:block">{u.title}</span>
                <span className="org" style="display:block">{orgs.get(u.organizationId)?.name ?? ""}</span>
              </button>
            </form>
          ))}
        </div>
        <p className="footer-note">
          Funder, project-manager and compliance users land on the portfolio dashboard.
          The field engineer lands in the mobile capture app.
        </p>
      </div>
    </Layout>
  );
}

// ---------------------------------------------------------- dashboard

export function renderDashboard(input: {
  user: User;
  projects: Array<{
    project: Project;
    org: Organization | null;
    milestones: MilestoneRow[];
    summary: ProjectAccountSummary;
    pendingApprovals: ApprovalRequest[];
  }>;
  notifications: Notification[];
}): string {
  const { user, projects, notifications } = input;
  return renderDocument(
    <Layout title="Dashboard" user={user} active="dashboard">
      <h1>Portfolio dashboard</h1>
      <p className="sub">
        Verified physical progress and fund-release state across active projects.
      </p>

      {projects.map(({ project, org, milestones, summary, pendingApprovals }) => {
        const releasedPct =
          summary.totalBudget > 0
            ? Math.round((summary.released / summary.totalBudget) * 100)
            : 0;
        const released = milestones.filter((m) => m.milestone.status === "RELEASED").length;
        return (
          <div className="panel" style="margin-top:18px">
            <div className="panel-head">
              <h3>
                <a href={`/project/${project.id}`}>{project.name}</a>
              </h3>
              <span className="right">
                {project.location} · funded by {org?.name ?? "—"}
              </span>
            </div>
            <div className="panel-pad">
              <div className="stats" style="margin:0 0 6px">
                <div className="stat">
                  <div className="label">Total budget</div>
                  <div className="value">{money(summary.totalBudget)}</div>
                </div>
                <div className="stat">
                  <div className="label">Released</div>
                  <div className="value" style="color:var(--ok)">{money(summary.released)}</div>
                  <div className="hint">{released} of {milestones.length} milestones</div>
                </div>
                <div className="stat">
                  <div className="label">Held</div>
                  <div className="value" style="color:var(--warn)">{money(summary.held)}</div>
                  <div className="hint">pending verification & approval</div>
                </div>
                <div className="stat">
                  <div className="label">Budget released</div>
                  <div className="value">{releasedPct}%</div>
                  <div className="meter"><div style={`width:${releasedPct}%`}></div></div>
                </div>
                <div className="stat">
                  <div className="label">Approvals pending</div>
                  <div className="value">{pendingApprovals.length}</div>
                  <div className="hint">awaiting human sign-off</div>
                </div>
              </div>

              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Milestone</th>
                      <th className="num">Tranche</th>
                      <th>Status</th>
                      <th>Verification</th>
                      <th>Approval</th>
                      <th>Funds</th>
                    </tr>
                  </thead>
                  <tbody>
                    {milestones.map((row) => (
                      <tr>
                        <td className="mono">{row.milestone.seq}</td>
                        <td>
                          <a href={`/milestone/${row.milestone.id}`}>{row.milestone.title}</a>
                        </td>
                        <td className="num">{money(row.milestone.trancheAmount)}</td>
                        <td><MilestoneStatusBadge status={row.milestone.status} /></td>
                        <td>
                          {row.verification ? (
                            <VerdictBadge verdict={row.verification.verdict} />
                          ) : (
                            <span className="badge neutral">No evidence</span>
                          )}
                        </td>
                        <td>
                          {row.approval ? (
                            <ApprovalBadge status={row.approval.status} />
                          ) : (
                            <span className="badge neutral">—</span>
                          )}
                        </td>
                        <td><AccountBadge status={row.milestone.accountStatus} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })}

      <h2>Recent activity</h2>
      <div className="panel">
        {notifications.length === 0 ? (
          <div className="panel-pad sub">No activity yet.</div>
        ) : (
          <ul className="timeline">
            {notifications.map((n) => (
              <li>
                <span className="when">{fmtDate(n.createdAt)}</span>
                <span>
                  <span className="badge neutral" style="margin-right:8px">{n.type.replace(/_/g, " ")}</span>
                  {n.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="footer-note">
        Held/Released figures are the project's virtual account ledger — governance state
        for milestone tranches. No real bank movement occurs in this demo.
      </p>
      <script src="/js/poll.js" defer></script>
    </Layout>
  );
}

// ------------------------------------------------------ project detail

export function renderProjectDetail(input: {
  user: User;
  project: Project;
  org: Organization | null;
  milestones: MilestoneRow[];
  summary: ProjectAccountSummary;
  approvals: ApprovalRequest[];
  ledger: LedgerEntry[];
  chainValid: boolean;
  evidenceBundles: EvidenceBundle[];
  accountEvents: VirtualAccountEvent[];
  milestoneById: Map<string, Milestone>;
}): string {
  const { user, project, org, milestones, summary, approvals, ledger } = input;
  const releasedPct =
    summary.totalBudget > 0 ? Math.round((summary.released / summary.totalBudget) * 100) : 0;
  const pendingApprovals = approvals.filter((a) => a.status === "PENDING");

  return renderDocument(
    <Layout title={project.name} user={user} active="dashboard">
      <p className="sub"><a href="/dashboard">← Portfolio dashboard</a></p>
      <h1>{project.name}</h1>
      <p className="sub">
        {project.location} · funded by {org?.name ?? "—"} · project type: {project.projectType}
      </p>
      <p style="max-width:820px;font-size:14px;color:var(--ink-soft)">{project.description}</p>

      <div className="stats">
        <div className="stat">
          <div className="label">Total budget</div>
          <div className="value">{money(summary.totalBudget)}</div>
        </div>
        <div className="stat">
          <div className="label">Released</div>
          <div className="value" style="color:var(--ok)">{money(summary.released)}</div>
        </div>
        <div className="stat">
          <div className="label">Held</div>
          <div className="value" style="color:var(--warn)">{money(summary.held)}</div>
        </div>
        <div className="stat">
          <div className="label">Budget released</div>
          <div className="value">{releasedPct}%</div>
          <div className="meter"><div style={`width:${releasedPct}%`}></div></div>
        </div>
        <div className="stat">
          <div className="label">Site boundary</div>
          <div className="value" style="font-size:15px">{project.siteBoundary.length - 1}-point geofence</div>
          <div className="hint mono">
            centre ≈ {centroidLabel(project)}
          </div>
        </div>
      </div>

      <h2>Milestones</h2>
      <div className="panel table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Milestone</th>
              <th className="num">Tranche</th>
              <th>Status</th>
              <th>Verification</th>
              <th>Approval</th>
              <th>Funds</th>
            </tr>
          </thead>
          <tbody>
            {milestones.map((row) => (
              <tr>
                <td className="mono">{row.milestone.seq}</td>
                <td>
                  <a href={`/milestone/${row.milestone.id}`}>{row.milestone.title}</a>
                  <span style="display:block;font-size:12.5px;color:var(--ink-mute);max-width:420px">
                    {row.milestone.requirement}
                  </span>
                </td>
                <td className="num">{money(row.milestone.trancheAmount)}</td>
                <td><MilestoneStatusBadge status={row.milestone.status} /></td>
                <td>
                  {row.verification ? (
                    <>
                      <VerdictBadge verdict={row.verification.verdict} />
                      <span className="mono" style="display:block;font-size:11.5px;color:var(--ink-mute)">
                        conf {row.verification.confidence.toFixed(2)}
                      </span>
                    </>
                  ) : (
                    <span className="badge neutral">No evidence</span>
                  )}
                </td>
                <td>
                  {row.approval ? (
                    <ApprovalBadge status={row.approval.status} />
                  ) : (
                    <span className="badge neutral">—</span>
                  )}
                </td>
                <td><AccountBadge status={row.milestone.accountStatus} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pendingApprovals.length > 0 ? (
        <>
          <h2>Approvals awaiting sign-off</h2>
          <div className="panel">
            <ul className="timeline">
              {pendingApprovals.map((a) => {
                const m = input.milestoneById.get(a.milestoneId);
                return (
                  <li>
                    <span className="when">{fmtDate(a.createdAt)}</span>
                    <span>
                      <ApprovalBadge status={a.status} />{" "}
                      Milestone {m?.seq}: {m?.title} — requires{" "}
                      {a.requiredRoles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(" + ")}.
                      Tranche remains <b>HELD</b> until approved.
                    </span>
                    <span className="amt">{m ? money(m.trancheAmount) : ""}</span>
                  </li>
                );
              })}
            </ul>
            <div className="panel-pad" style="border-top:1px solid var(--line-soft)">
              <button className="btn secondary" disabled title="Approval workflow is enabled in the next release">
                Review &amp; approve (coming soon)
              </button>
              <span className="sub" style="margin-left:10px">
                Multi-role approval governance ships in the next release.
              </span>
            </div>
          </div>
        </>
      ) : null}

      <h2>Evidence &amp; verification</h2>
      {input.evidenceBundles.length === 0 ? (
        <div className="note">No evidence submitted yet.</div>
      ) : (
        input.evidenceBundles.map((b) => (
          <div style="margin-bottom:14px">
            <p className="sub" style="margin:0 0 6px">
              Milestone {b.milestone.seq}: {b.milestone.title}
            </p>
            <EvidencePanel
              evidence={b.evidence}
              verification={b.verification}
              ledgerEntry={b.ledgerEntry}
              requirement={b.milestone.requirement}
              submittedBy={b.submittedBy}
            />
          </div>
        ))
      )}

      <h2>Evidence ledger (tamper-evident)</h2>
      <div className="panel">
        <div className="panel-head">
          <h3>Hash-chained entries</h3>
          <span className="right">
            {ledger.length} entries ·{" "}
            {input.chainValid ? (
              <span className="badge ok">Chain intact</span>
            ) : (
              <span className="badge bad">Chain broken</span>
            )}
          </span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Seq</th>
                <th>Timestamp</th>
                <th>Milestone</th>
                <th>Payload hash</th>
                <th>Prev hash</th>
                <th>Entry hash</th>
              </tr>
            </thead>
            <tbody>
              {ledger.length === 0 ? (
                <tr><td colspan="6" className="sub">Ledger is empty.</td></tr>
              ) : (
                ledger.map((e) => {
                  const m = input.milestoneById.get(e.milestoneId);
                  return (
                    <tr>
                      <td className="mono">{e.seq}</td>
                      <td className="mono" style="font-size:12px">{fmtDate(e.timestamp)}</td>
                      <td>M{m?.seq}: {m?.title}</td>
                      <td className="mono" title={e.payloadHash}>{shortHash(e.payloadHash)}</td>
                      <td className="mono" title={e.previousHash}>{shortHash(e.previousHash)}</td>
                      <td className="mono" title={e.currentHash}>{shortHash(e.currentHash)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="chainflow">
          <b>How to read this:</b> each entry's hash is computed from its content plus the
          previous entry's hash, so any retroactive edit breaks every later hash. Genesis
          entries chain from a fixed genesis value.
        </div>
      </div>

      <h2>Virtual project account</h2>
      <div className="panel">
        <div className="panel-head">
          <h3>Tranche ledger</h3>
          <span className="right">
            Project-level financial control state — not cryptocurrency, no real bank movement.
          </span>
        </div>
        <ul className="timeline">
          {input.accountEvents.map((e) => {
            const m = input.milestoneById.get(e.milestoneId);
            return (
              <li>
                <span className="when">{fmtDate(e.createdAt)}</span>
                <span>
                  {e.type === "RELEASED" ? (
                    <span className="badge ok">Released</span>
                  ) : (
                    <span className="badge warn">Held</span>
                  )}{" "}
                  Milestone {m?.seq}: {m?.title}
                </span>
                <span className="amt">{money(e.amount)}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <h2>Reports</h2>
      <div className="panel panel-pad">
        <h3>Project compliance report</h3>
        <p className="sub" style="max-width:640px">
          A signed PDF containing milestone status, the full evidence chain, verification
          results and the fund-release audit trail will be generated here.
        </p>
        <button className="btn secondary" disabled title="PDF report generation ships in a later release">
          Generate compliance report (PDF) — coming soon
        </button>
      </div>

      <script src="/js/poll.js" defer data-project={project.id}></script>
    </Layout>
  );
}

function centroidLabel(project: Project): string {
  let lng = 0;
  let lat = 0;
  for (const [x, y] of project.siteBoundary) {
    lng += x;
    lat += y;
  }
  const n = project.siteBoundary.length;
  return `${(lat / n).toFixed(4)}, ${(lng / n).toFixed(4)}`;
}

// ---------------------------------------------------- milestone detail

export function renderMilestoneDetail(input: {
  user: User;
  project: Project;
  milestone: Milestone;
  approval: ApprovalRequest | null;
  bundles: EvidenceBundle[];
}): string {
  const { user, project, milestone, approval, bundles } = input;
  return renderDocument(
    <Layout title={`Milestone ${milestone.seq}`} user={user} active="dashboard">
      <p className="sub">
        <a href={`/project/${project.id}`}>← {project.name}</a>
      </p>
      <h1>
        Milestone {milestone.seq}: {milestone.title}
      </h1>
      <p className="sub">{project.location}</p>

      <div className="stats">
        <div className="stat">
          <div className="label">Tranche</div>
          <div className="value">{money(milestone.trancheAmount)}</div>
        </div>
        <div className="stat">
          <div className="label">Milestone status</div>
          <div className="value" style="font-size:15px;margin-top:7px">
            <MilestoneStatusBadge status={milestone.status} />
          </div>
        </div>
        <div className="stat">
          <div className="label">Funds</div>
          <div className="value" style="font-size:15px;margin-top:7px">
            <AccountBadge status={milestone.accountStatus} />
          </div>
        </div>
        <div className="stat">
          <div className="label">Approval</div>
          <div className="value" style="font-size:15px;margin-top:7px">
            {approval ? <ApprovalBadge status={approval.status} /> : <span className="badge neutral">Not requested</span>}
          </div>
        </div>
      </div>

      <div className="panel panel-pad">
        <h3>Evidence requirement</h3>
        <p style="margin:6px 0 0;max-width:760px">{milestone.requirement}</p>
      </div>

      {approval && approval.status === "PENDING" ? (
        <div className="panel panel-pad" style="margin-top:14px;border-left:4px solid var(--warn)">
          <h3>Human approval required before release</h3>
          <p className="sub" style="max-width:720px">
            Verification passed, but funds stay <b>HELD</b> until{" "}
            {approval.requiredRoles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(" and ")}{" "}
            approve. Requested {fmtDate(approval.createdAt)}.
          </p>
          <button className="btn secondary" disabled title="Approval workflow is enabled in the next release">
            Review &amp; approve (coming soon)
          </button>
        </div>
      ) : null}

      {milestone.status === "PENDING_EVIDENCE" || milestone.status === "UNDER_REVIEW" ? (
        <div className="panel panel-pad" style="margin-top:14px">
          <h3>Awaiting field evidence</h3>
          <p className="sub">
            A field engineer submits geo-tagged photo evidence from the mobile capture app.
          </p>
          <a className="btn" href="/field">Open field capture</a>
        </div>
      ) : null}

      <h2>Evidence</h2>
      {bundles.length === 0 ? (
        <div className="note">No evidence submitted for this milestone yet.</div>
      ) : (
        bundles.map((b) => (
          <div style="margin-bottom:14px">
            <EvidencePanel
              evidence={b.evidence}
              verification={b.verification}
              ledgerEntry={b.ledgerEntry}
              requirement={milestone.requirement}
              submittedBy={b.submittedBy}
            />
          </div>
        ))
      )}
      <script src="/js/poll.js" defer data-project={project.id}></script>
    </Layout>
  );
}

// ---------------------------------------------------------- field app

export function renderFieldShell(user: User): string {
  return renderDocument(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>OBV Field Capture</title>
        <link rel="stylesheet" href="/styles.css" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icons/icon-192.png" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#0f172a" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body className="field-body">
        <div className="field-shell">
          <div className="field-head">
            <span className="brand-sm">OBV FIELD</span>
            <span className="role-tag">
              {user.name}
              <br />
              {user.title} · <a href="/" style="color:#7dd3fc">switch</a>
            </span>
          </div>
          <div id="app" data-user-id={user.id} data-user-name={user.name}>
            <div className="field-card">
              <div className="spin"></div>
              <p style="text-align:center;color:#94a3b8">Loading projects…</p>
            </div>
          </div>
          <noscript>
            <div className="field-warn">OBV Field Capture requires JavaScript.</div>
          </noscript>
        </div>
        <script src="/js/field.js" defer></script>
      </body>
    </html>
  );
}

// ------------------------------------------------------------- error

export function renderError(user: User | null, title: string, message: string): string {
  return renderDocument(
    <Layout title={title} user={user}>
      <h1>{title}</h1>
      <p className="sub">{message}</p>
      <p>
        <a className="btn secondary" href="/dashboard">Back to dashboard</a>
      </p>
    </Layout>
  );
}
