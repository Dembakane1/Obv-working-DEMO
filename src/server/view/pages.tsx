/** Server-rendered pages — OBV design system v2. */
import { h, Fragment, VNode, renderDocument } from "./jsx";
import { icons } from "./icons";
import {
  AccountChip,
  ActivityFeed,
  AppShell,
  ApprovalChip,
  ApprovalProgress,
  EmptyState,
  EvidencePanel,
  MetricCard,
  MilestoneCard,
  MilestoneCardData,
  MilestoneStatusChip,
  NavContext,
  PageHeader,
  Pipeline,
  VerdictChip,
  approvalProgressLabel,
  fmtDate,
  initials,
  money,
  roleLabel,
  shortHash,
} from "./components";
import type {
  ApprovalRecord,
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

export interface MilestoneRow extends MilestoneCardData {
  latestEvidence: EvidenceItem | null;
}

export interface EvidenceBundle {
  evidence: EvidenceItem;
  verification: Verification | null;
  ledgerEntry: LedgerEntry | null;
  milestone: Milestone;
  submittedBy: User | null;
  approval: ApprovalRequest | null;
}

export interface ProjectCardData {
  project: Project;
  org: Organization | null;
  implementingOrg: Organization | null;
  milestones: MilestoneRow[];
  summary: ProjectAccountSummary;
  pendingApprovals: number;
}

// ------------------------------------------------------------ helpers

function projectProgressPct(d: ProjectCardData): number {
  return d.summary.totalBudget > 0
    ? Math.round((d.summary.released / d.summary.totalBudget) * 100)
    : 0;
}

function nextMilestone(d: ProjectCardData): Milestone | null {
  return (
    d.milestones.find((m) =>
      ["PENDING_EVIDENCE", "UNDER_REVIEW", "VERIFIED", "APPROVED"].includes(m.milestone.status)
    )?.milestone ??
    d.milestones.find((m) => m.milestone.status === "NOT_STARTED")?.milestone ??
    null
  );
}

function ProjectCard(props: { data: ProjectCardData }): VNode {
  const d = props.data;
  const pct = projectProgressPct(d);
  const next = nextMilestone(d);
  return (
    <div className="card project-card">
      <div className="top">
        <span style="min-width:0">
          <h3>
            <a href={`/project/${d.project.id}`}>{d.project.name}</a>
          </h3>
          <span className="meta">
            <span>{icons.mapPin()} {d.project.location}</span>
            <span>{icons.building()} {d.org?.name ?? "—"}</span>
            {d.implementingOrg ? <span>Implementing: {d.implementingOrg.name}</span> : null}
          </span>
        </span>
        <span className="chips">
          <span className="chip info">{d.project.projectType.replace(/_/g, " ")}</span>
          {d.pendingApprovals > 0 ? (
            <span className="chip warn">{d.pendingApprovals} approval{d.pendingApprovals > 1 ? "s" : ""} pending</span>
          ) : null}
        </span>
      </div>

      <div className="progress-row">
        <span className="track"><span className="fill" style={`width:${pct}%;display:block`}></span></span>
        <span className="pct">{pct}%</span>
        <span className="sub">of budget released</span>
      </div>

      <div className="figures">
        <div className="figure">
          <span className="l" style="display:block">Total budget</span>
          <span className="v" style="display:block">{money(d.summary.totalBudget)}</span>
        </div>
        <div className="figure">
          <span className="l" style="display:block">Released</span>
          <span className="v green" style="display:block">{money(d.summary.released)}</span>
        </div>
        <div className="figure">
          <span className="l" style="display:block">Held</span>
          <span className="v amber" style="display:block">{money(d.summary.held)}</span>
        </div>
        <div className="figure">
          <span className="l" style="display:block">Milestones</span>
          <span className="v" style="display:block">
            {d.milestones.filter((m) => m.milestone.status === "RELEASED").length} of {d.milestones.length} released
          </span>
        </div>
      </div>

      <div className="foot">
        {next ? (
          <span className="next">
            {icons.clock()} Next: M{next.seq} · {next.title}
          </span>
        ) : (
          <span className="next">{icons.check()} All milestones complete</span>
        )}
        <span className="cta">
          <a className="btn secondary sm" href={`/project/${d.project.id}`}>
            View project {icons.arrowRight()}
          </a>
        </span>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- auth

export function renderUserSwitcher(users: User[], orgs: Map<string, Organization>): string {
  return renderDocument(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Select demo user — OBV</title>
        <link rel="stylesheet" href="/styles.css" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#16233b" />
      </head>
      <body>
        <div className="auth-wrap">
          <div className="auth-box">
            <div className="auth-brand">
              <span className="mark">{icons.logo(24)}</span>
              <span>
                <span className="name" style="display:block">OpenBuild Verify</span>
                <span className="sub" style="display:block">The truth layer for physical projects</span>
              </span>
            </div>
            <p className="sub" style="max-width:620px">
              Demo mode — pick a seeded user to explore their view of the platform. No
              passwords required; full authentication arrives with the production build.
            </p>
            <div className="roles">
              {users.map((u) => (
                <form method="POST" action="/api/session">
                  <input type="hidden" name="userId" value={u.id} />
                  <button className="role-card" type="submit" style="width:100%">
                    <span className="role">{roleLabel(u.role)}</span>
                    <span className="name" style="display:block">{u.name}</span>
                    <span className="title" style="display:block">{u.title}</span>
                    <span className="org" style="display:block">{orgs.get(u.organizationId)?.name ?? ""}</span>
                  </button>
                </form>
              ))}
            </div>
            <p className="footer-note">
              Office roles land on the portfolio overview. The field engineer lands in the
              mobile capture app.
            </p>
          </div>
        </div>
      </body>
    </html>
  );
}

// ------------------------------------------------------------ overview

export interface OverviewMetrics {
  totalBudget: number;
  released: number;
  held: number;
  pendingApprovals: number;
  verifiedMilestones: number;
  totalMilestones: number;
  flaggedEvidence: number;
}

export function renderOverview(input: {
  nav: NavContext;
  metrics: OverviewMetrics;
  projects: ProjectCardData[];
  notifications: Notification[];
}): string {
  const { metrics } = input;
  return renderDocument(
    <AppShell title="Overview" nav={input.nav}>
      <PageHeader
        title="Portfolio overview"
        sub="Verified physical progress and governed fund release across active projects."
      >
        <form method="POST" action="/api/demo/reset" style="margin:0">
          <button className="btn ghost sm" type="submit" title="Restore the seeded demo state">
            Reset demo data
          </button>
        </form>
      </PageHeader>

      <div className="metrics">
        <MetricCard label="Total portfolio value" value={money(metrics.totalBudget)} tone="blue" icon={icons.projects()} />
        <MetricCard label="Funds released" value={money(metrics.released)} tone="green" icon={icons.dollar()} />
        <MetricCard label="Funds held" value={money(metrics.held)} tone="amber" icon={icons.dollar()} hint="pending verification & approval" />
        <MetricCard label="Pending approvals" value={String(metrics.pendingApprovals)} tone={metrics.pendingApprovals > 0 ? "amber" : "slate"} icon={icons.approvals()} hint="awaiting human sign-off" />
        <MetricCard label="Verified milestones" value={`${metrics.verifiedMilestones} / ${metrics.totalMilestones}`} tone="blue" icon={icons.check()} />
        <MetricCard label="Flagged evidence" value={String(metrics.flaggedEvidence)} tone={metrics.flaggedEvidence > 0 ? "red" : "slate"} icon={icons.alert()} hint="needs review or rejected" />
      </div>

      <h2 className="section">Active projects</h2>
      {input.projects.map((p) => (
        <ProjectCard data={p} />
      ))}

      <h2 className="section">Recent activity</h2>
      <div className="card">
        <ActivityFeed notifications={input.notifications} />
      </div>

      <p className="footer-note">
        Held/released figures are the virtual project account ledger — project-level
        financial control state. No real bank movement occurs in this demo.
      </p>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------------------ projects

export function renderProjects(input: { nav: NavContext; projects: ProjectCardData[] }): string {
  return renderDocument(
    <AppShell title="Projects" nav={input.nav}>
      <PageHeader title="Projects" sub="All projects under milestone-based financial governance." />
      {input.projects.map((p) => (
        <ProjectCard data={p} />
      ))}
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------------ project detail

export type ProjectTab = "overview" | "milestones" | "evidence" | "approvals" | "ledger" | "activity";

export function renderProjectDetail(input: {
  nav: NavContext;
  tab: ProjectTab;
  data: ProjectCardData;
  approvals: Array<{ approval: ApprovalRequest; records: ApprovalRecord[]; milestone: Milestone }>;
  evidenceBundles: EvidenceBundle[];
  ledger: LedgerEntry[];
  chainValid: boolean;
  accountEvents: VirtualAccountEvent[];
  notifications: Notification[];
  users: Map<string, User>;
}): string {
  const { data, tab } = input;
  const { project } = data;
  const pct = projectProgressPct(data);
  const flagged = data.milestones.filter(
    (m) => m.verification && m.verification.verdict !== "VERIFIED"
  ).length;

  const tabs: Array<{ key: ProjectTab; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "milestones", label: "Milestones" },
    { key: "evidence", label: "Evidence" },
    { key: "approvals", label: "Approvals" },
    { key: "ledger", label: "Ledger" },
    { key: "activity", label: "Activity" },
  ];

  return renderDocument(
    <AppShell title={project.name} nav={input.nav}>
      <PageHeader
        title={project.name}
        sub={`${project.location} · funded by ${data.org?.name ?? "—"}${data.implementingOrg ? ` · implementing agency: ${data.implementingOrg.name}` : ""}`}
        crumb={{ href: "/projects", label: "Projects" }}
      >
        <span className="chip info">{project.projectType.replace(/_/g, " ")}</span>
        <span className={`chip ${input.chainValid ? "ok" : "bad"}`}>
          {input.chainValid ? "Evidence chain intact" : "Chain integrity alert"}
        </span>
        {flagged > 0 ? <span className="chip warn">{flagged} flagged verification{flagged > 1 ? "s" : ""}</span> : null}
      </PageHeader>

      <div className="metrics">
        <MetricCard label="Total budget" value={money(data.summary.totalBudget)} tone="blue" icon={icons.dollar()} />
        <MetricCard label="Released" value={money(data.summary.released)} tone="green" icon={icons.dollar()} />
        <MetricCard label="Held" value={money(data.summary.held)} tone="amber" icon={icons.dollar()} />
        <MetricCard label="Progress" value={`${pct}%`} tone="slate" icon={icons.activity()} hint="of budget released" />
        <MetricCard label="Pending approvals" value={String(data.pendingApprovals)} tone={data.pendingApprovals > 0 ? "amber" : "slate"} icon={icons.approvals()} />
      </div>

      <nav className="tabs">
        {tabs.map((t) => (
          <a
            href={`/project/${project.id}?tab=${t.key}`}
            className={tab === t.key ? "active" : ""}
          >
            {t.label}
          </a>
        ))}
      </nav>

      {tab === "overview" ? (
        <>
          <div className="card card-pad">
            <h3 style="margin:0 0 6px;font-size:15px">About this project</h3>
            <p className="sub" style="margin:0;max-width:860px">{project.description}</p>
            <dl className="kv" style="margin-top:14px">
              <dt>Site geofence</dt>
              <dd>{project.siteBoundary.length - 1}-point boundary polygon</dd>
              <dt>Status</dt>
              <dd>{project.status}</dd>
            </dl>
          </div>
          <h2 className="section">Milestones</h2>
          {data.milestones.map((row) => (
            <MilestoneCard data={row} />
          ))}
        </>
      ) : null}

      {tab === "milestones" ? (
        <>{data.milestones.map((row) => <MilestoneCard data={row} />)}</>
      ) : null}

      {tab === "evidence" ? (
        input.evidenceBundles.length === 0 ? (
          <div className="card">
            <EmptyState icon={icons.camera()} title="No evidence yet" message="Field submissions will appear here with their full chain of proof." />
          </div>
        ) : (
          <>
            {input.evidenceBundles.map((b) => (
              <div style="margin-bottom:16px">
                <p className="sub" style="margin:0 0 7px;font-weight:650">
                  Milestone {b.milestone.seq}: {b.milestone.title}
                </p>
                <EvidencePanel
                  evidence={b.evidence}
                  verification={b.verification}
                  ledgerEntry={b.ledgerEntry}
                  requirement={b.milestone.requirement}
                  submittedBy={b.submittedBy}
                  approval={b.approval}
                  accountStatus={b.milestone.accountStatus}
                />
              </div>
            ))}
          </>
        )
      ) : null}

      {tab === "approvals" ? (
        input.approvals.length === 0 ? (
          <div className="card">
            <EmptyState icon={icons.approvals()} title="No approval requests" message="Approval requests are created automatically when a milestone is verified." />
          </div>
        ) : (
          <>
            {input.approvals.map(({ approval, records, milestone }) => (
              <div className="card card-pad">
                <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
                  <h3 style="margin:0;font-size:15px">
                    M{milestone.seq} · {milestone.title}
                  </h3>
                  <ApprovalChip status={approval.status} />
                  <span style="margin-left:auto;font-weight:800;font-variant-numeric:tabular-nums">
                    {money(milestone.trancheAmount)}
                  </span>
                </div>
                <ApprovalProgress approval={approval} records={records} users={input.users} />
                <p className="sub" style="margin:10px 0 0">
                  Requested {fmtDate(approval.createdAt)} ·{" "}
                  <a href={`/approvals`}>Review in approval queue →</a>
                </p>
              </div>
            ))}
          </>
        )
      ) : null}

      {tab === "ledger" ? (
        <LedgerCard
          ledger={input.ledger}
          chainValid={input.chainValid}
          milestoneById={new Map(data.milestones.map((m) => [m.milestone.id, m.milestone]))}
          projectById={new Map([[project.id, project]])}
          showVerify={false}
        />
      ) : null}

      {tab === "activity" ? (
        <>
          <div className="card">
            <div className="card-head">
              <h3>Virtual account — tranche ledger</h3>
              <span className="right">Financial control state · not cryptocurrency · no real bank movement</span>
            </div>
            <ul className="activity">
              {input.accountEvents.map((e) => {
                const m = data.milestones.find((r) => r.milestone.id === e.milestoneId)?.milestone;
                return (
                  <li>
                    <span className={`ico ${e.type === "RELEASED" ? "ok" : "warn"}`}>{icons.dollar()}</span>
                    <span className="body">
                      <span className="msg">
                        <b>{e.type === "RELEASED" ? "Released" : "Held"}</b> — Milestone {m?.seq}: {m?.title}
                      </span>
                      <span className="meta">
                        <span className="when">{fmtDate(e.createdAt)}</span>
                        <span style="font-weight:700">{money(e.amount)}</span>
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <h2 className="section">Events</h2>
          <div className="card">
            <ActivityFeed notifications={input.notifications} />
          </div>
        </>
      ) : null}

      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ---------------------------------------------------- milestone detail

export function renderMilestoneDetail(input: {
  nav: NavContext;
  project: Project;
  row: MilestoneRow;
  bundles: EvidenceBundle[];
  users: Map<string, User>;
  canDecide: boolean;
}): string {
  const { project, row } = input;
  const { milestone, approval, approvalRecords } = row;
  return renderDocument(
    <AppShell title={`Milestone ${milestone.seq}`} nav={input.nav}>
      <PageHeader
        title={`Milestone ${milestone.seq}: ${milestone.title}`}
        sub={project.location}
        crumb={{ href: `/project/${project.id}`, label: project.name }}
      >
        <MilestoneStatusChip status={milestone.status} />
        {row.verification ? <VerdictChip verdict={row.verification.verdict} /> : null}
        {approval ? <ApprovalChip status={approval.status} progress={approvalProgressLabel(row)} /> : null}
        <AccountChip status={milestone.accountStatus} />
      </PageHeader>

      <div className="card card-pad">
        <Pipeline
          milestone={milestone}
          verification={row.verification}
          approval={approval}
          approvalProgress={approvalProgressLabel(row)}
        />
        <dl className="kv" style="margin-top:16px">
          <dt>Tranche</dt>
          <dd style="font-weight:800">{money(milestone.trancheAmount)}</dd>
          <dt>Requirement</dt>
          <dd>{milestone.requirement}</dd>
        </dl>
      </div>

      {approval ? (
        <div className="card card-pad" style="margin-top:14px">
          <h3 style="margin:0 0 10px;font-size:15px">Human approval</h3>
          <ApprovalProgress approval={approval} records={approvalRecords} users={input.users} />
          {approval.status === "PENDING" ? (
            <>
              <div className="banner warn" style="margin-bottom:0">
                Funds stay <b>HELD</b> until every required role approves.{" "}
                {input.canDecide ? (
                  <a href="/approvals">Review and decide in the approval queue →</a>
                ) : (
                  "Your current role is not part of this approval."
                )}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {milestone.status === "PENDING_EVIDENCE" || milestone.status === "UNDER_REVIEW" ? (
        <div className="card card-pad" style="margin-top:14px">
          <h3 style="margin:0 0 4px;font-size:15px">Awaiting field evidence</h3>
          <p className="sub" style="margin:0 0 12px">
            A field engineer submits geo-tagged photo evidence from the mobile capture app.
          </p>
          <a className="btn" href="/field">Open field capture</a>
        </div>
      ) : null}

      <h2 className="section">Evidence</h2>
      {input.bundles.length === 0 ? (
        <div className="card">
          <EmptyState icon={icons.camera()} title="No evidence yet" message="No evidence has been submitted for this milestone." />
        </div>
      ) : (
        input.bundles.map((b) => (
          <div style="margin-bottom:14px">
            <EvidencePanel
              evidence={b.evidence}
              verification={b.verification}
              ledgerEntry={b.ledgerEntry}
              requirement={milestone.requirement}
              submittedBy={b.submittedBy}
              approval={approval}
              accountStatus={milestone.accountStatus}
            />
          </div>
        ))
      )}
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------------------ approvals

export interface ApprovalQueueItem {
  approval: ApprovalRequest;
  records: ApprovalRecord[];
  milestone: Milestone;
  project: Project;
  bundle: EvidenceBundle | null;
  /** Whether the current user can decide (role required + not yet voted). */
  canDecide: boolean;
  alreadyDecided: boolean;
}

export function renderApprovals(input: {
  nav: NavContext;
  items: ApprovalQueueItem[];
  users: Map<string, User>;
}): string {
  const pending = input.items.filter((i) => i.approval.status === "PENDING");
  const resolved = input.items.filter((i) => i.approval.status !== "PENDING");
  return renderDocument(
    <AppShell title="Pending approvals" nav={input.nav}>
      <PageHeader
        title="Pending approvals"
        sub="Release governance: every required role must approve verified evidence before a tranche is released."
      />

      {pending.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={icons.approvals()}
            title="Nothing awaiting approval"
            message="When a milestone is verified, its release approval appears here."
          />
        </div>
      ) : (
        pending.map((item) => {
          const approved = item.records.filter((r) => r.decision === "APPROVED").length;
          const missing = item.approval.requiredRoles.filter(
            (role) => !item.records.some((r) => r.role === role)
          );
          return (
            <div className="card" style="margin-bottom:16px">
              <div className="card-head">
                <h3>
                  {item.project.name} — M{item.milestone.seq}: {item.milestone.title}
                </h3>
                <span className="right">
                  <span className="chip warn">HELD — {money(item.milestone.trancheAmount)}</span>
                  {item.bundle?.verification ? (
                    <>
                      <VerdictChip verdict={item.bundle.verification.verdict} />
                      <span className="mono">conf {item.bundle.verification.confidence.toFixed(2)}</span>
                    </>
                  ) : null}
                </span>
              </div>
              <div className="card-pad" style="display:grid;grid-template-columns:280px 1fr;gap:20px">
                <div>
                  <ApprovalProgress approval={item.approval} records={item.records} users={input.users} />
                  <p className="sub" style="margin:8px 0 0">
                    Submitted {fmtDate(item.approval.createdAt)}
                    {missing.length > 0 ? (
                      <>
                        <br />
                        Awaiting: <b>{missing.map(roleLabel).join(", ")}</b>
                      </>
                    ) : null}
                  </p>
                  {item.canDecide ? (
                    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
                      <form method="POST" action={`/api/approvals/${item.approval.id}/decision`}>
                        <input type="hidden" name="decision" value="APPROVED" />
                        <button className="btn" type="submit">Approve release ({approved + 1} of {item.approval.requiredRoles.length})</button>
                      </form>
                      <form method="POST" action={`/api/approvals/${item.approval.id}/decision`}>
                        <input type="hidden" name="decision" value="REJECTED" />
                        <button className="btn danger" type="submit">Reject</button>
                      </form>
                    </div>
                  ) : item.alreadyDecided ? (
                    <div className="banner info" style="margin:14px 0 0">Your decision is recorded. Awaiting the remaining role(s).</div>
                  ) : (
                    <div className="banner info" style="margin:14px 0 0">
                      Sign in as one of the required roles to decide. Your current role is not part of this approval.
                    </div>
                  )}
                </div>
                <div style="min-width:0">
                  {item.bundle ? (
                    <EvidencePanel
                      evidence={item.bundle.evidence}
                      verification={item.bundle.verification}
                      ledgerEntry={item.bundle.ledgerEntry}
                      requirement={item.milestone.requirement}
                      submittedBy={item.bundle.submittedBy}
                      approval={item.approval}
                      accountStatus={item.milestone.accountStatus}
                    />
                  ) : (
                    <div className="note">Evidence record unavailable.</div>
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}

      {resolved.length > 0 ? (
        <>
          <h2 className="section">Resolved</h2>
          <div className="card">
            <ul className="activity">
              {resolved.map((item) => (
                <li>
                  <span className={`ico ${item.approval.status === "APPROVED" ? "ok" : "bad"}`}>
                    {item.approval.status === "APPROVED" ? icons.check() : icons.x()}
                  </span>
                  <span className="body">
                    <span className="msg">
                      <b>{item.approval.status === "APPROVED" ? "Approved & released" : "Rejected"}</b> — {item.project.name},
                      M{item.milestone.seq}: {item.milestone.title}
                    </span>
                    <span className="meta">
                      <span className="when">{fmtDate(item.approval.createdAt)}</span>
                      <span style="font-weight:700">{money(item.milestone.trancheAmount)}</span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// -------------------------------------------------------------- ledger

export function LedgerCard(props: {
  ledger: LedgerEntry[];
  chainValid: boolean;
  brokenAt?: number;
  milestoneById: Map<string, Milestone>;
  projectById: Map<string, Project>;
  showVerify: boolean;
  checkedBanner?: string | null;
}): VNode {
  const milestoneProject = (milestoneId: string): Project | undefined => {
    const m = props.milestoneById.get(milestoneId);
    return m ? props.projectById.get(m.projectId) : undefined;
  };
  return (
    <div className="card">
      <div className="card-head">
        <h3>Hash-chained entries</h3>
        <span className="right">
          {props.ledger.length} entries
          {props.chainValid ? (
            <span className="chip ok">Chain intact</span>
          ) : (
            <span className="chip bad">Tampering detected at entry {props.brokenAt}</span>
          )}
          {props.showVerify ? (
            <form method="POST" action="/api/ledger/verify" style="margin:0">
              <button className="btn secondary sm" type="submit">Verify integrity</button>
            </form>
          ) : null}
        </span>
      </div>
      {props.checkedBanner ? (
        <div className="card-pad" style="padding-top:12px;padding-bottom:0">
          <div className={`banner ${props.chainValid ? "ok" : "warn"}`} style="margin:0 0 12px">
            {props.checkedBanner}
          </div>
        </div>
      ) : null}

      <div className="desktop-only table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Timestamp</th>
              <th>Project / milestone</th>
              <th>Evidence</th>
              <th>Verdict</th>
              <th>Payload hash</th>
              <th>Prev hash</th>
              <th>Entry hash</th>
            </tr>
          </thead>
          <tbody>
            {props.ledger.length === 0 ? (
              <tr><td colspan="8" className="sub">Ledger is empty.</td></tr>
            ) : (
              props.ledger.map((e) => {
                const m = props.milestoneById.get(e.milestoneId);
                const p = milestoneProject(e.milestoneId);
                return (
                  <tr>
                    <td className="mono">{e.seq}</td>
                    <td className="mono" style="font-size:12px">{fmtDate(e.timestamp)}</td>
                    <td>
                      {p ? <span style="display:block;font-size:12px;color:var(--ink-mute)">{p.name}</span> : null}
                      M{m?.seq}: {m?.title}
                    </td>
                    <td className="mono" title={e.evidenceItemId}>{e.evidenceItemId.slice(0, 8)}…</td>
                    <td><span className="chip ok">Verified</span></td>
                    <td className="mono" title={e.payloadHash}>{shortHash(e.payloadHash, 12)}</td>
                    <td className="mono" title={e.previousHash}>{shortHash(e.previousHash, 12)}</td>
                    <td className="mono" title={e.currentHash}>{shortHash(e.currentHash, 12)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mobile-only">
        {props.ledger.map((e) => {
          const m = props.milestoneById.get(e.milestoneId);
          return (
            <div className="ledger-row">
              <div className="t">
                <span className="mono">#{e.seq}</span>
                <span>M{m?.seq}: {m?.title}</span>
              </div>
              <div className="sub mono" style="font-size:11.5px;margin-top:2px">{fmtDate(e.timestamp)}</div>
              <div className="hash">hash {shortHash(e.currentHash, 26)}<br />prev {shortHash(e.previousHash, 26)}</div>
            </div>
          );
        })}
      </div>

      <div className="proof-rail">
        <b>How to read this:</b> each entry's hash covers its content plus the previous
        entry's hash, so any retroactive edit breaks every later hash. Genesis entries
        chain from a fixed genesis value.
      </div>
    </div>
  );
}

export function renderLedger(input: {
  nav: NavContext;
  ledger: LedgerEntry[];
  chainValid: boolean;
  brokenAt?: number;
  milestoneById: Map<string, Milestone>;
  projectById: Map<string, Project>;
  checkedBanner?: string | null;
}): string {
  return renderDocument(
    <AppShell title="Evidence ledger" nav={input.nav}>
      <PageHeader
        title="Evidence ledger"
        sub="Append-only, hash-chained record of every verified evidence item. Tamper-evident by construction."
      />
      <LedgerCard
        ledger={input.ledger}
        chainValid={input.chainValid}
        brokenAt={input.brokenAt}
        milestoneById={input.milestoneById}
        projectById={input.projectById}
        showVerify={true}
        checkedBanner={input.checkedBanner}
      />
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// -------------------------------------------------------------- reports

export function renderReports(input: { nav: NavContext; projects: Project[] }): string {
  return renderDocument(
    <AppShell title="Reports" nav={input.nav}>
      <PageHeader title="Reports" sub="Audit-ready exports for funders, project offices and compliance teams." />
      <div className="card card-pad">
        <h3 style="margin:0 0 4px;font-size:15px">Project compliance report</h3>
        <p className="sub" style="max-width:680px;margin:0 0 14px">
          A signed PDF containing milestone status, the full evidence chain, verification
          results and the fund-release audit trail. Generation ships in a later release.
        </p>
        {input.projects.map((p) => (
          <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line);flex-wrap:wrap">
            <span style="font-weight:650;min-width:0">{p.name}</span>
            <span style="margin-left:auto">
              <button className="btn secondary sm" disabled title="PDF report generation ships in a later release">
                Generate PDF — coming soon
              </button>
            </span>
          </div>
        ))}
      </div>
    </AppShell>
  );
}

// ----------------------------------------------------------- compliance

export interface ComplianceData {
  needsReview: EvidenceBundle[];
  rejected: EvidenceBundle[];
  awaitingApproval: Array<{ milestone: Milestone; project: Project; approval: ApprovalRequest; records: ApprovalRecord[] }>;
  chainValid: boolean;
  brokenAt?: number;
}

export function renderCompliance(input: { nav: NavContext; data: ComplianceData; users: Map<string, User> }): string {
  const d = input.data;
  return renderDocument(
    <AppShell title="Risk & Compliance" nav={input.nav}>
      <PageHeader
        title="Risk & compliance"
        sub="Open items requiring compliance attention, summarized from recorded verification and governance data."
      />

      <div className="metrics">
        <MetricCard label="Evidence needing review" value={String(d.needsReview.length)} tone={d.needsReview.length > 0 ? "amber" : "slate"} icon={icons.alert()} />
        <MetricCard label="Rejected evidence" value={String(d.rejected.length)} tone={d.rejected.length > 0 ? "red" : "slate"} icon={icons.x()} />
        <MetricCard label="Awaiting approval" value={String(d.awaitingApproval.length)} tone={d.awaitingApproval.length > 0 ? "amber" : "slate"} icon={icons.approvals()} />
        <MetricCard label="Ledger integrity" value={d.chainValid ? "Intact" : "Alert"} tone={d.chainValid ? "green" : "red"} icon={icons.shield()} hint={d.chainValid ? "all entries verified" : `broken at entry ${d.brokenAt}`} />
      </div>

      <h2 className="section">Evidence needing review</h2>
      {d.needsReview.length === 0 ? (
        <div className="card"><EmptyState icon={icons.check()} title="Nothing flagged" message="No evidence currently requires human review." /></div>
      ) : (
        d.needsReview.map((b) => (
          <div style="margin-bottom:14px">
            <EvidencePanel
              evidence={b.evidence}
              verification={b.verification}
              ledgerEntry={b.ledgerEntry}
              requirement={b.milestone.requirement}
              submittedBy={b.submittedBy}
              accountStatus={b.milestone.accountStatus}
            />
          </div>
        ))
      )}

      <h2 className="section">Milestones awaiting approval</h2>
      {d.awaitingApproval.length === 0 ? (
        <div className="card"><EmptyState icon={icons.approvals()} title="No open approvals" message="All verified milestones have completed governance." /></div>
      ) : (
        <div className="card">
          <ul className="activity">
            {d.awaitingApproval.map((a) => (
              <li>
                <span className="ico warn">{icons.clock()}</span>
                <span className="body">
                  <span className="msg">
                    <b>{a.project.name}</b> — M{a.milestone.seq}: {a.milestone.title}
                  </span>
                  <span className="meta">
                    <span className="when">requested {fmtDate(a.approval.createdAt)}</span>
                    <span style="font-weight:700">{money(a.milestone.trancheAmount)} held</span>
                    <a href="/approvals">Review →</a>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.rejected.length > 0 ? (
        <>
          <h2 className="section">Rejected evidence</h2>
          {d.rejected.map((b) => (
            <div style="margin-bottom:14px">
              <EvidencePanel
                evidence={b.evidence}
                verification={b.verification}
                ledgerEntry={b.ledgerEntry}
                requirement={b.milestone.requirement}
                submittedBy={b.submittedBy}
                accountStatus={b.milestone.accountStatus}
              />
            </div>
          ))}
        </>
      ) : null}
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------------------- insights

export interface Insight {
  severity: "info" | "warn" | "bad";
  title: string;
  detail: string;
  href?: string;
}

export function renderInsights(input: { nav: NavContext; insights: Insight[] }): string {
  return renderDocument(
    <AppShell title="AI Insights" nav={input.nav}>
      <PageHeader
        title="Verification insights"
        sub="Automated observations derived from recorded verification, approval and submission data. Informational only — no autonomous decisions are made."
      />
      {input.insights.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={icons.insights()}
            title="No anomalies detected"
            message="All recorded verifications look consistent. Insights appear as evidence accumulates."
          />
        </div>
      ) : (
        <div className="card">
          <ul className="activity">
            {input.insights.map((ins) => (
              <li>
                <span className={`ico ${ins.severity === "bad" ? "bad" : ins.severity === "warn" ? "warn" : "info"}`}>
                  {ins.severity === "info" ? icons.insights() : icons.alert()}
                </span>
                <span className="body">
                  <span className="msg"><b>{ins.title}</b> — {ins.detail}</span>
                  {ins.href ? (
                    <span className="meta"><a href={ins.href}>View →</a></span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="footer-note">
        Labelled “Automated insights”: computed from stored verification records, not a
        generative model.
      </p>
    </AppShell>
  );
}

// ----------------------------------------------------------------- more

export function renderMore(input: { nav: NavContext }): string {
  const { user } = input.nav;
  const items = [
    { href: "/field", label: "Field Capture", icon: icons.camera, desc: "Mobile evidence capture PWA" },
    { href: "/reports", label: "Reports", icon: icons.reports, desc: "Compliance report exports" },
    { href: "/compliance", label: "Risk & Compliance", icon: icons.shield, desc: "Open review items and integrity" },
    { href: "/insights", label: "AI Insights", icon: icons.insights, desc: "Automated verification observations" },
  ];
  return renderDocument(
    <AppShell title="More" nav={{ ...input.nav, active: "more" }}>
      <PageHeader title="More" />
      <div className="card">
        {items.map((i) => (
          <a href={i.href} style="display:flex;gap:14px;align-items:center;padding:15px 18px;border-bottom:1px solid var(--line);color:var(--ink)">
            <span className="ico" style="width:38px;height:38px;border-radius:10px;background:var(--primary-soft);color:var(--primary-deep);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              {i.icon()}
            </span>
            <span style="min-width:0">
              <span style="font-weight:650;display:block">{i.label}</span>
              <span className="sub" style="display:block">{i.desc}</span>
            </span>
            <span style="margin-left:auto;color:var(--ink-faint)">{icons.arrowRight()}</span>
          </a>
        ))}
      </div>
      <div className="card card-pad" style="display:flex;gap:12px;align-items:center">
        <span className="avatar" style="width:40px;height:40px;border-radius:50%;background:var(--primary-soft);color:var(--primary-deep);font-weight:700;display:flex;align-items:center;justify-content:center">
          {initials(user.name)}
        </span>
        <span style="min-width:0;flex:1">
          <span style="font-weight:650;display:block">{user.name}</span>
          <span className="sub" style="display:block">{roleLabel(user.role)}</span>
        </span>
        <a className="btn secondary sm" href="/">Switch user</a>
      </div>
    </AppShell>
  );
}

// ------------------------------------------------------------ field app

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
        <meta name="theme-color" content="#0b1424" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body className="field-body">
        <div className="field-shell">
          <div className="field-head">
            <span className="mark">{icons.logo(18)}</span>
            <span>
              <span className="brand-sm" style="display:block">OBV Field</span>
              <span className="brand-sub" style="display:block">Evidence capture</span>
            </span>
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

// ---------------------------------------------------------------- error

export function renderError(nav: NavContext | null, title: string, message: string): string {
  if (!nav) {
    return renderDocument(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{title} — OBV</title>
          <link rel="stylesheet" href="/styles.css" />
        </head>
        <body>
          <div className="auth-wrap">
            <div className="auth-box" style="text-align:center">
              <h1>{title}</h1>
              <p className="sub">{message}</p>
              <a className="btn" href="/">Go to sign-in</a>
            </div>
          </div>
        </body>
      </html>
    );
  }
  return renderDocument(
    <AppShell title={title} nav={nav}>
      <PageHeader title={title} sub={message} />
      <a className="btn secondary" href="/overview">Back to overview</a>
    </AppShell>
  );
}
