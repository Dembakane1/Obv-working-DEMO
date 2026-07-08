/** Server-rendered pages — OBV design system v3 (institutional). */
import { h, Fragment, VNode, renderDocument } from "./jsx";
import { brandMark, icons } from "./icons";
import {
  AccountChip,
  ActivityFeed,
  AppShell,
  ApprovalChip,
  ApprovalProgress,
  EmptyState,
  EvidenceAiResult,
  EvidenceChecks,
  EvidenceFacts,
  EvidenceHashes,
  EvidencePanel,
  EvidenceStatusChips,
  FallbackChip,
  FinancialBand,
  IntegrityChip,
  MilestoneCard,
  MilestoneCardData,
  MilestoneStatusChip,
  NavContext,
  OperationalStatus,
  PageHeader,
  Pipeline,
  ProofRail,
  VerdictChip,
  approvalProgressLabel,
  fmtDate,
  fmtGps,
  initials,
  milestoneNextAction,
  money,
  roleLabel,
  shortHash,
} from "./components";
import type {
  ApprovalRecord,
  ApprovalRequest,
  ChatMessage,
  ConversationThread,
  EvidenceItem,
  ExternalThreadBinding,
  LedgerEntry,
  Milestone,
  Notification,
  Organization,
  Project,
  Report,
  User,
  Verification,
  VirtualAccountEvent,
} from "../../shared/types";
import type { ProjectAccountSummary } from "../services/VirtualAccountService";
import * as repo from "../db/repo";

/**
 * Minimal read-only lookups for chat reference cards and thread context
 * panels. Presentation only: no writes, no access to the approval
 * workflow or virtual account mutations.
 */
const repoView = {
  verificationForEvidence: (evidenceId: string) => repo.getVerificationForEvidence(evidenceId),
  milestoneIdForEvidence: (evidenceId: string) => repo.getEvidence(evidenceId)?.milestoneId ?? null,
  approval: (approvalId: string) => {
    const a = repo.getApprovalRequest(approvalId);
    if (!a) return null;
    const m = repo.getMilestone(a.milestoneId);
    const records = repo
      .listApprovalRecordsForRequest(a.id)
      .filter((r) => r.decision === "APPROVED").length;
    return {
      records,
      required: a.requiredRoles.length,
      amount: m?.trancheAmount ?? 0,
      accountStatus: m?.accountStatus ?? "HELD",
    };
  },
  milestoneContext: (milestoneId: string) => {
    const evidence = repo.listEvidenceForMilestone(milestoneId);
    const latest = evidence[0] ? repo.getVerificationForEvidence(evidence[0].id) : null;
    const a = repo.getApprovalRequestForMilestone(milestoneId);
    const recs = a
      ? repo.listApprovalRecordsForRequest(a.id).filter((r) => r.decision === "APPROVED").length
      : 0;
    return {
      requirement: true,
      evidenceCount: evidence.length,
      verdict: latest ? `${latest.verdict.replace(/_/g, " ")} · ${latest.confidence.toFixed(2)}` : null,
      approvalLine: a
        ? a.status === "PENDING"
          ? `${recs} of ${a.requiredRoles.length} recorded · PENDING`
          : a.status
        : "Not requested",
    };
  },
  projectContext: (projectId: string) => {
    const ms = repo.listMilestones(projectId);
    return {
      released: ms
        .filter((m) => m.accountStatus === "RELEASED")
        .reduce((s, m) => s + m.trancheAmount, 0),
      held: ms
        .filter((m) => m.accountStatus !== "RELEASED")
        .reduce((s, m) => s + m.trancheAmount, 0),
      pendingApprovals: repo
        .listApprovalRequestsForProject(projectId)
        .filter((a) => a.status === "PENDING").length,
    };
  },
};

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

function nextMilestone(d: ProjectCardData): MilestoneRow | null {
  return (
    d.milestones.find((m) =>
      ["PENDING_EVIDENCE", "UNDER_REVIEW", "VERIFIED", "APPROVED"].includes(m.milestone.status)
    ) ??
    d.milestones.find((m) => m.milestone.status === "NOT_STARTED") ??
    null
  );
}

function projectRisk(d: ProjectCardData): { tone: string; label: string } {
  const flagged = d.milestones.some(
    (m) => m.verification && m.verification.verdict !== "VERIFIED"
  );
  if (flagged) return { tone: "warn", label: "Attention" };
  return { tone: "ok", label: "On track" };
}

/** Dense portfolio asset row. */
function ProjectAsset(props: { data: ProjectCardData }): VNode {
  const d = props.data;
  const pct = projectProgressPct(d);
  const next = nextMilestone(d);
  const risk = projectRisk(d);
  return (
    <div className="panel asset">
      <div className="a-head">
        <h3><a href={`/project/${d.project.id}`}>{d.project.name}</a></h3>
        <span className="flags">
          {d.pendingApprovals > 0 ? (
            <span className="status warn"><span className="g">●</span>{d.pendingApprovals} approval{d.pendingApprovals > 1 ? "s" : ""} pending</span>
          ) : null}
          <span className={`status ${risk.tone}`}><span className="g">●</span>{risk.label}</span>
        </span>
      </div>
      <div className="a-meta">
        <span>{icons.mapPin(13)} {d.project.location}</span>
        <span>{d.project.projectType.replace(/_/g, " ")}</span>
        <span>{icons.building(13)} {d.org?.name ?? "—"}</span>
        {d.implementingOrg ? <span>Implementing: {d.implementingOrg.name}</span> : null}
      </div>
      <div className="a-figs">
        <div className="a-fig">
          <span className="l" style="display:block">Progress</span>
          <span className="progress">
            <span className="track"><span className="fill" style={`width:${pct}%`}></span></span>
            <span className="pct">{pct}%</span>
          </span>
        </div>
        <div className="a-fig">
          <span className="l" style="display:block">Budget</span>
          <span className="v num" style="display:block">{money(d.summary.totalBudget)}</span>
        </div>
        <div className="a-fig">
          <span className="l" style="display:block">Released</span>
          <span className="v green num" style="display:block">{money(d.summary.released)}</span>
        </div>
        <div className="a-fig">
          <span className="l" style="display:block">Held</span>
          <span className="v amber num" style="display:block">{money(d.summary.held)}</span>
        </div>
        <div className="a-fig">
          <span className="l" style="display:block">Next milestone</span>
          <span className="v small" style="display:block">
            {next ? `M${next.milestone.seq} · ${next.milestone.title}` : "All complete"}
          </span>
        </div>
      </div>
      <div className="a-foot">
        <span>
          {d.milestones.filter((m) => m.milestone.status === "RELEASED").length} of {d.milestones.length} milestones released
        </span>
        <span className="cta">
          <a className="btn sm" href={`/project/${d.project.id}`}>View project {icons.arrowRight(13)}</a>
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
        <title>Sign in — OBV</title>
        <link rel="stylesheet" href="/styles.css" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#0d1626" />
      </head>
      <body>
        <div className="auth-wrap">
          <div className="auth-box">
            <div className="auth-brand">
              <span className="mark">{brandMark(22)}</span>
              <span>
                <span className="name" style="display:block">OpenBuild Verify</span>
                <span className="tagline" style="display:block">The truth layer for physical projects</span>
              </span>
            </div>
            <p className="sub" style="max-width:600px;margin-top:10px">
              Demo environment — select a seeded role to explore its view of the platform.
              No credentials required; production authentication replaces this screen.
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
              Office roles open the portfolio overview · the field engineer opens the mobile
              capture application.
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
  pendingValue: number;
  verifiedMilestones: number;
  totalMilestones: number;
  flaggedEvidence: number;
}

export function renderOverview(input: {
  nav: NavContext;
  metrics: OverviewMetrics;
  projects: ProjectCardData[];
  notifications: Notification[];
  chainValid: boolean;
  teamsConfigured: boolean;
}): string {
  const m = input.metrics;
  const releasedPct = m.totalBudget > 0 ? Math.round((m.released / m.totalBudget) * 100) : 0;
  return renderDocument(
    <AppShell title="Overview" nav={input.nav}>
      <PageHeader
        title="Portfolio overview"
        sub={`${input.projects.length} active project${input.projects.length === 1 ? "" : "s"} under milestone-based release governance.`}
      >
        <form method="POST" action="/api/demo/reset" style="margin:0">
          <button className="btn danger sm" type="submit" title="Restore the seeded demo state">
            Reset demo data
          </button>
        </form>
      </PageHeader>

      {/* Financial statement band — ruled figures on the page, not cards */}
      <div className="statement">
        <div className="stmt-row">
          <div className="stmt-fig">
            <div className="v">{money(m.totalBudget)}</div>
            <div className="l">Portfolio value</div>
            <div className="c">{input.projects.length} project{input.projects.length === 1 ? "" : "s"} · {m.totalMilestones} milestones</div>
          </div>
          <div className="stmt-fig">
            <div className="v green">{money(m.released)}</div>
            <div className="l">Released</div>
            <div className="c">{releasedPct}% of portfolio</div>
          </div>
          <div className="stmt-fig">
            <div className="v amber">{money(m.held)}</div>
            <div className="l">Held</div>
            <div className="c">pending verification &amp; governance</div>
          </div>
          <div className="stmt-fig">
            <div className="v">{money(m.pendingValue)}</div>
            <div className="l">Pending governance</div>
            <div className="c">{m.pendingApprovals} approval request{m.pendingApprovals === 1 ? "" : "s"}</div>
          </div>
        </div>
        {/* Released vs held allocation — one restrained visualization */}
        <div className="alloc">
          <div className="bar" role="img" aria-label={`Released ${releasedPct}%, held ${100 - releasedPct}%`}>
            <span className="seg-rel" style={`width:${releasedPct}%`}></span>
            <span className="seg-held" style={`width:${100 - releasedPct}%`}></span>
          </div>
          <div className="legend">
            <span className="k"><span className="sw" style="background:var(--ok)"></span>Released <b>{money(m.released)}</b> · {releasedPct}%</span>
            <span className="k"><span className="sw" style="background:#e9d6ab"></span>Held <b>{money(m.held)}</b> · {100 - releasedPct}%</span>
          </div>
        </div>
        <div className="stmt-sub">
          <span className="it"><span className={`g ${m.verifiedMilestones > 0 ? "ok" : "idle"}`}>●</span><b>{m.verifiedMilestones}/{m.totalMilestones}</b> milestones verified</span>
          <span className="it"><span className={`g ${m.pendingApprovals > 0 ? "warn" : "idle"}`}>●</span><b>{m.pendingApprovals}</b> pending approval{m.pendingApprovals === 1 ? "" : "s"}</span>
          <span className="it"><span className={`g ${m.flaggedEvidence > 0 ? "bad" : "ok"}`}>●</span><b>{m.flaggedEvidence}</b> flagged evidence</span>
          <span className="it"><span className={`g ${input.chainValid ? "ok" : "bad"}`}>●</span>ledger <b>{input.chainValid ? "chain intact" : "integrity alert"}</b></span>
        </div>
      </div>

      {/* Portfolio as a holdings register */}
      <div className="doc-head">
        <h2>Project portfolio</h2>
        <span className="right">{input.projects.length} holding{input.projects.length === 1 ? "" : "s"} · {money(m.totalBudget)} committed</span>
      </div>
      <div className="sheet" style="margin-top:10px;border-radius:0 0 8px 8px;border-top:none">
        <div className="desktop-only">
          <table className="holdings">
            <thead>
              <tr>
                <th style="width:30%">Project</th>
                <th style="text-align:right">Budget</th>
                <th style="text-align:right">Released</th>
                <th style="text-align:right">Held</th>
                <th>Progress</th>
                <th>Next milestone</th>
                <th>Governance</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {input.projects.map((d) => {
                const pct = projectProgressPct(d);
                const next = nextMilestone(d);
                return (
                  <tr>
                    <td>
                      <span className="h-name"><a href={`/project/${d.project.id}`}>{d.project.name}</a></span>
                      <span className="h-sub" style="display:block">
                        {d.project.location} · {d.project.projectType.replace(/_/g, " ")} · {d.org?.name ?? "—"}
                      </span>
                    </td>
                    <td className="fig">{money(d.summary.totalBudget)}</td>
                    <td className="fig green">{money(d.summary.released)}</td>
                    <td className="fig amber">{money(d.summary.held)}</td>
                    <td>
                      <span className="microbar">
                        <span className="tr"><span className="fl" style={`width:${pct}%`}></span></span>
                        <span className="num" style="font-weight:650;font-size:11.5px">{pct}%</span>
                      </span>
                      <span style="display:block;font-size:10px;color:var(--ink-4)">
                        {d.milestones.filter((x) => x.milestone.status === "RELEASED").length}/{d.milestones.length} released
                      </span>
                    </td>
                    <td className="h-next">
                      {next ? (
                        <>
                          <span className="nl">M{next.milestone.seq}</span>
                          {next.milestone.title}
                        </>
                      ) : (
                        "All complete"
                      )}
                    </td>
                    <td>
                      {d.pendingApprovals > 0 ? (
                        <span className="status warn"><span className="g">●</span>{d.pendingApprovals} pending</span>
                      ) : (
                        <span className="status ok"><span className="g">✓</span>Clear</span>
                      )}
                    </td>
                    <td style="text-align:right;white-space:nowrap">
                      <a className="btn sm" href={`/project/${d.project.id}`}>View project</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mobile-only">
          {input.projects.map((d) => {
            const pct = projectProgressPct(d);
            const next = nextMilestone(d);
            return (
              <div className="holding-m">
                <div style="display:flex;gap:8px;align-items:baseline">
                  <span className="hm-name" style="min-width:0;flex:1"><a href={`/project/${d.project.id}`}>{d.project.name}</a></span>
                  {d.pendingApprovals > 0 ? (
                    <span className="status warn" style="flex-shrink:0"><span className="g">●</span>{d.pendingApprovals}</span>
                  ) : null}
                </div>
                <div className="hm-sub">{d.project.location} · {d.org?.name ?? ""}</div>
                <div className="hm-figs">
                  <span className="f"><span className="v">{money(d.summary.totalBudget)}</span><span className="l">Budget</span></span>
                  <span className="f"><span className="v green">{money(d.summary.released)}</span><span className="l">Released</span></span>
                  <span className="f"><span className="v amber">{money(d.summary.held)}</span><span className="l">Held</span></span>
                  <span className="f"><span className="v">{pct}%</span><span className="l">Progress</span></span>
                </div>
                <div className="hm-foot">
                  {next ? <span>Next: <b>M{next.milestone.seq} · {next.milestone.title}</b></span> : <span>All milestones complete</span>}
                  <a className="btn sm" href={`/project/${d.project.id}`}>View project</a>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Activity as a ruled register with notification provenance */}
      <div className="doc-head">
        <h2>Activity register</h2>
        <span className="right">
          {input.teamsConfigured ? (
            <span className="status info" style="margin-right:8px"><span className="g">●</span>Teams webhook configured</span>
          ) : (
            <span className="status" style="margin-right:8px"><span className="g">●</span>Demo notification mode</span>
          )}
          most recent first
        </span>
      </div>
      <div className="reglist" style="margin-top:10px;border-radius:0 0 8px 8px;border-top:none">
        {input.notifications.length === 0 ? (
          <div className="reg-row"><span className="ev sub">No recorded activity yet.</span></div>
        ) : (
          input.notifications.map((n) => (
            <div className="reg-row">
              <span className="ts">{fmtDate(n.createdAt).slice(0, 16)}</span>
              <span className="ev">{n.message}</span>
              <span className="tag-r">
                {n.type.replace(/_/g, " ")}
                <span style="display:block;text-align:right;font-size:8.5px;letter-spacing:0.05em">
                  {n.deliveryMode === "TEAMS_WEBHOOK"
                    ? n.deliveryStatus === "SENT"
                      ? "teams · sent"
                      : n.deliveryStatus === "FAILED"
                        ? "teams · failed"
                        : "in-app"
                    : n.deliveryStatus === "SKIPPED"
                      ? "demo mode"
                      : "in-app"}
                </span>
              </span>
            </div>
          ))
        )}
      </div>

      <p className="footer-note">
        Held/released figures are the virtual project account ledger — governed release
        eligibility, not real bank movement.
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
        <ProjectAsset data={p} />
      ))}
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------------ project detail

export type ProjectTab = "overview" | "milestones" | "evidence" | "approvals" | "ledger" | "activity" | "map" | "discussion";

type LifecycleStage = "SETUP" | "EVIDENCE" | "VERIFICATION" | "GOVERNANCE" | "RELEASE";

function projectLifecycleStage(d: ProjectCardData): LifecycleStage {
  if (d.milestones.every((m) => m.milestone.status === "RELEASED")) return "RELEASE";
  const front = d.milestones.find((m) => m.milestone.status !== "RELEASED")!;
  switch (front.milestone.status) {
    case "UNDER_REVIEW": return "VERIFICATION";
    case "VERIFIED": return "GOVERNANCE";
    case "APPROVED": return "RELEASE";
    default: return "EVIDENCE";
  }
}

function LifecycleStrip(props: { stage: LifecycleStage; anyReleased: boolean }): VNode {
  const stages: Array<{ key: LifecycleStage; label: string }> = [
    { key: "SETUP", label: "PROJECT SETUP" },
    { key: "EVIDENCE", label: "FIELD EVIDENCE" },
    { key: "VERIFICATION", label: "VERIFICATION" },
    { key: "GOVERNANCE", label: "GOVERNANCE" },
    { key: "RELEASE", label: "RELEASE" },
  ];
  const order = stages.map((s) => s.key);
  const idx = order.indexOf(props.stage);
  return (
    <div className="lifecycle">
      {stages.map((s, i) => {
        const cls = i < idx || (s.key === "SETUP") ? "done" : i === idx ? "current" : "";
        return (
          <>
            {i > 0 ? <span className={`ln ${i <= idx ? "done" : ""}`}></span> : null}
            <span className={`lc ${cls}`}>
              <span className="d"></span>
              {s.label}
            </span>
          </>
        );
      })}
    </div>
  );
}

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
  threads: Array<{ thread: ConversationThread; latest: ChatMessage | null; milestone: Milestone | null }>;
}): string {
  const { data, tab } = input;
  const { project } = data;
  const pct = projectProgressPct(data);
  const stage = projectLifecycleStage(data);
  const flagged = data.milestones.filter(
    (m) => m.verification && m.verification.verdict !== "VERIFIED"
  ).length;
  const bottleneck = data.milestones.find((m) => m.approval?.status === "PENDING");
  const front = nextMilestone(data);

  const tabs: Array<{ key: ProjectTab; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "milestones", label: "Milestones" },
    { key: "evidence", label: "Evidence" },
    { key: "approvals", label: "Approvals" },
    { key: "ledger", label: "Ledger" },
    { key: "map", label: "Map" },
    { key: "discussion", label: "Discussion" },
    { key: "activity", label: "Activity" },
  ];

  return renderDocument(
    <AppShell title={project.name} nav={input.nav} context={project.name}>
      <div style="display:flex;align-items:center;gap:12px;margin:2px 0 10px">
        <a className="crumb" href="/projects" style="font-size:12px;color:var(--ink-3)">← Projects</a>
        <form method="POST" action="/api/reports/generate" style="margin:0 0 0 auto">
          <input type="hidden" name="projectId" value={project.id} />
          <button className="btn sm" type="submit" data-busy-label="Generating report…" title="Generate the Project Verification & Fund Release Report (PDF)">
            {icons.file(13)} Generate funder report
          </button>
        </form>
      </div>

      <div className="proj-head">
        <div className="ph-top">
          <div className="ph-id">
            <span className="code">{project.id.toUpperCase()} · {project.projectType.replace(/_/g, " ")}</span>
            <h1>{project.name}</h1>
            <div className="meta">
              {project.location}
              <br />
              Funder: <b style="color:var(--ink-2);font-weight:600">{data.org?.name ?? "—"}</b>
              {data.implementingOrg ? <> · Implementing: {data.implementingOrg.name}</> : null}
            </div>
            <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
              <span className={`status ${project.status === "ACTIVE" ? "ok" : ""}`}><span className="g">●</span>{project.status}</span>
              <IntegrityChip valid={input.chainValid} />
              {flagged > 0 ? <span className="status warn"><span className="g">!</span>{flagged} flagged</span> : null}
            </div>
          </div>
          <div className="ph-figs">
            <div className="ph-fig">
              <div className="v num">{money(data.summary.totalBudget)}</div>
              <div className="l">Total budget</div>
            </div>
            <div className="ph-fig">
              <div className="v green num">{money(data.summary.released)}</div>
              <div className="l">Released</div>
            </div>
            <div className="ph-fig">
              <div className="v amber num">{money(data.summary.held)}</div>
              <div className="l">Held</div>
            </div>
            <div className="ph-fig">
              <div className="v num">{pct}%</div>
              <div className="l">Physical progress</div>
            </div>
          </div>
        </div>
        <LifecycleStrip stage={stage} anyReleased={data.summary.released > 0} />
      </div>

      <nav className="tabs">
        {tabs.map((t) => (
          <a href={`/project/${project.id}?tab=${t.key}`} className={tab === t.key ? "active" : ""}>
            {t.label}
          </a>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="op-grid">
          <div>
            <div className="panel panel-pad">
              <h3 style="margin:0 0 4px;font-size:13px;font-weight:650">About this project</h3>
              <p className="sub" style="margin:0">{project.description}</p>
            </div>
            {bottleneck ? (
              <div className="banner warn" style="margin:12px 0 0">
                <b>Approval bottleneck:</b> M{bottleneck.milestone.seq} "{bottleneck.milestone.title}" is verified —{" "}
                {milestoneNextAction(bottleneck)?.toLowerCase()}. <a href="/approvals">Review →</a>
              </div>
            ) : null}
            <h2 className="section">Milestones</h2>
            <div className="ms-list">
              {data.milestones.map((row) => (
                <MilestoneCard data={row} />
              ))}
            </div>
          </div>

          <div className="panel" style="position:sticky;top:calc(var(--topbar-h) + 14px)">
            <div className="side-block">
              <div className="l">Financial state</div>
              <div className="side-kv"><span className="k">Total budget</span><span className="v">{money(data.summary.totalBudget)}</span></div>
              <div className="side-kv"><span className="k">Released</span><span className="v green">{money(data.summary.released)}</span></div>
              <div className="side-kv"><span className="k">Held</span><span className="v amber">{money(data.summary.held)}</span></div>
              <div className="side-kv"><span className="k">Release progress</span><span className="v">{pct}%</span></div>
            </div>
            <div className="side-block">
              <div className="l">Ledger integrity</div>
              <IntegrityChip valid={input.chainValid} />
              <div className="sub" style="margin-top:5px">{input.ledger.length} hash-chained entries · <a href="/ledger">register →</a></div>
            </div>
            <div className="side-block">
              <div className="l">Risk indicators</div>
              <div className="side-kv"><span className="k">Flagged verifications</span><span className="v">{flagged}</span></div>
              <div className="side-kv"><span className="k">Pending approvals</span><span className="v">{data.pendingApprovals}</span></div>
              <div className="side-kv"><span className="k">Rejected approvals</span><span className="v">{input.approvals.filter((a) => a.approval.status === "REJECTED").length}</span></div>
            </div>
            <div className="side-block">
              <div className="l">Next required action</div>
              <p style="margin:0;font-size:12.5px;color:var(--ink-2);font-weight:550">
                {bottleneck
                  ? milestoneNextAction(bottleneck)
                  : front
                    ? milestoneNextAction(front) ?? "Begin next milestone"
                    : "All milestones released"}
              </p>
              {bottleneck ? (
                <a className="btn sm" href="/approvals" style="margin-top:9px">Open approval queue</a>
              ) : front && front.milestone.status === "PENDING_EVIDENCE" ? (
                <a className="btn secondary sm" href="/field" style="margin-top:9px">Open field capture</a>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "milestones" ? (
        <div className="ms-list">
          {data.milestones.map((row) => (
            <MilestoneCard data={row} />
          ))}
        </div>
      ) : null}

      {tab === "evidence" ? (
        input.evidenceBundles.length === 0 ? (
          <div className="panel">
            <EmptyState icon={icons.camera()} title="No evidence yet" message="Field submissions appear here with their full chain of proof." />
          </div>
        ) : (
          <>
            {input.evidenceBundles.map((b) => (
              <div style="margin-bottom:14px">
                <p className="t-meta" style="margin:0 0 6px">Milestone {b.milestone.seq} · {b.milestone.title}</p>
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
          <div className="panel">
            <EmptyState icon={icons.approvals()} title="No approval requests" message="Approval requests are created automatically when a milestone is verified." />
          </div>
        ) : (
          <>
            {input.approvals.map(({ approval, records, milestone }) => (
              <div className="panel panel-pad">
                <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
                  <h3 style="margin:0;font-size:13.5px;font-weight:650">
                    M{milestone.seq} · {milestone.title}
                  </h3>
                  <ApprovalChip
                    status={approval.status}
                    progress={`${records.filter((r) => r.decision === "APPROVED").length} of ${approval.requiredRoles.length}`}
                  />
                  <span className="num" style="margin-left:auto;font-weight:650">{money(milestone.trancheAmount)}</span>
                </div>
                <ApprovalProgress approval={approval} records={records} users={input.users} />
                <p className="sub" style="margin:9px 0 0">
                  Requested {fmtDate(approval.createdAt)} · <a href="/approvals">Review in approval queue →</a>
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

      {tab === "map" ? <MapShell projectId={project.id} /> : null}

      {tab === "discussion" ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Project discussion</h3>
            <span className="right">Coordination only — approvals & evidence stay in their formal workflows</span>
          </div>
          {input.threads.length === 0 ? (
            <p className="sub" style="padding:14px 16px">No threads yet.</p>
          ) : (
            input.threads.map((t, i) => (
              <a
                href={`/communications?thread=${t.thread.id}`}
                style={`display:block;padding:12px 16px;color:var(--ink);${i > 0 ? "border-top:1px solid var(--line)" : ""}`}
              >
                <span style="font-weight:600;font-size:13px;display:block">{t.thread.title}</span>
                {t.latest ? (
                  <span className="sub" style="display:block;font-size:12px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    {t.latest.senderDisplayName}: {t.latest.body.slice(0, 110)}
                  </span>
                ) : null}
                <span className="sub" style="display:block;font-size:10.5px;margin-top:2px;color:var(--ink-4)">
                  {t.latest ? fmtDate(t.latest.createdAt) : fmtDate(t.thread.createdAt)}
                </span>
              </a>
            ))
          )}
          <div style="padding:10px 16px;border-top:1px solid var(--line)">
            <form method="POST" action="/api/threads/open" style="margin:0">
              <input type="hidden" name="projectId" value={project.id} />
              <button className="btn secondary sm" type="submit">Open project thread</button>
            </form>
          </div>
        </div>
      ) : null}

      {tab === "activity" ? (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>Virtual account — tranche ledger</h3>
              <span className="right">Governed release eligibility · no real bank movement</span>
            </div>
            <ul className="activity">
              {input.accountEvents.map((e) => {
                const m = data.milestones.find((r) => r.milestone.id === e.milestoneId)?.milestone;
                return (
                  <li>
                    <span className={`ico ${e.type === "RELEASED" ? "ok" : "warn"}`}>{icons.dollar()}</span>
                    <span className="body">
                      <span className="msg">
                        <b>{e.type === "RELEASED" ? "Released" : "Held"}</b> — M{m?.seq}: {m?.title}
                      </span>
                      <span className="meta">
                        <span className="when">{fmtDate(e.createdAt)}</span>
                        <span className="num" style="font-weight:650;color:var(--ink-2)">{money(e.amount)}</span>
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <h2 className="section">Events</h2>
          <div className="panel">
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
    <AppShell title={`Milestone ${milestone.seq}`} nav={input.nav} context={`${project.name} · M${milestone.seq}`}>
      <PageHeader
        title={`M${milestone.seq} · ${milestone.title}`}
        sub={project.location}
        crumb={{ href: `/project/${project.id}`, label: project.name }}
      >
        <MilestoneStatusChip status={milestone.status} />
        <AccountChip status={milestone.accountStatus} />
      </PageHeader>

      <div className="panel panel-pad">
        <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
          <div>
            <div className="t-display num">{money(milestone.trancheAmount)}</div>
            <div className="t-meta" style="margin-top:2px">Tranche · {milestone.accountStatus}</div>
          </div>
          <div style="flex:1;min-width:240px">
            <div className="t-meta" style="margin-bottom:6px">Lifecycle</div>
            <Pipeline
              milestone={milestone}
              verification={row.verification}
              approval={approval}
              approvalProgress={approvalProgressLabel(row)}
            />
            {milestoneNextAction(row) ? (
              <p className="sub" style="margin:8px 0 0">Next: <b style="color:var(--ink-2)">{milestoneNextAction(row)}</b></p>
            ) : null}
          </div>
        </div>
        <div className="ev-sec" style="margin-top:14px">Evidence requirement</div>
        <p style="margin:0;font-size:13px;color:var(--ink-2)">{milestone.requirement}</p>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <form method="POST" action="/api/threads/open" style="margin:0">
            <input type="hidden" name="milestoneId" value={milestone.id} />
            <button className="btn ghost sm" type="submit">{icons.chat(13)} Open thread</button>
          </form>
          <a className="btn ghost sm" href={`/project/${project.id}?tab=map`}>{icons.map(13)} View on map</a>
        </div>
      </div>

      {approval ? (
        <div className="panel panel-pad" style="margin-top:12px">
          <div className="t-meta" style="margin-bottom:8px">Human approval</div>
          <ApprovalProgress approval={approval} records={approvalRecords} users={input.users} />
          {approval.status === "PENDING" ? (
            <div className="banner warn" style="margin:10px 0 0">
              Funds stay <b>HELD</b> until every required role approves.{" "}
              {input.canDecide ? (
                <a href="/approvals">Review and decide in the approval queue →</a>
              ) : (
                "Your current role is not part of this approval."
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {milestone.status === "PENDING_EVIDENCE" || milestone.status === "UNDER_REVIEW" ? (
        <div className="panel panel-pad" style="margin-top:12px">
          <div className="t-meta" style="margin-bottom:4px">Awaiting field evidence</div>
          <p className="sub" style="margin:0 0 10px">
            A field engineer submits geo-tagged photo evidence from the mobile capture app.
          </p>
          <a className="btn sm" href="/field">Open field capture</a>
        </div>
      ) : null}

      <h2 className="section">Evidence</h2>
      {input.bundles.length === 0 ? (
        <div className="panel">
          <EmptyState icon={icons.camera()} title="No evidence yet" message="No evidence has been submitted for this milestone." />
        </div>
      ) : (
        input.bundles.map((b) => (
          <div style="margin-bottom:12px">
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
  const atStake = pending.reduce((s, i) => s + i.milestone.trancheAmount, 0);
  return renderDocument(
    <AppShell title="Pending approvals" nav={input.nav}>
      <PageHeader
        title="Pending approvals"
        sub="Release governance — every required role must approve verified evidence before a tranche becomes release-eligible."
      >
        <div style="text-align:right">
          <div className="t-display num" style="font-size:21px">{money(atStake)}</div>
          <div className="t-meta">{pending.length} request{pending.length === 1 ? "" : "s"} · held pending governance</div>
        </div>
      </PageHeader>

      {pending.length === 0 ? (
        <div className="panel">
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
          const b = item.bundle;

          // Structured audit trail: timestamp / actor / role / decision / status.
          const trail: Array<{
            when: string;
            actor: string;
            role: string;
            event: VNode | string;
            tone: string;
            statusLabel: string;
          }> = [];
          if (b) {
            trail.push({
              when: b.evidence.uploadedAt,
              actor: b.submittedBy?.name ?? "Field user",
              role: b.submittedBy ? roleLabel(b.submittedBy.role) : "—",
              event: `Evidence submitted (${b.evidence.isDemoFallback ? "demo fallback" : "live capture"})`,
              tone: "info",
              statusLabel: "Submitted",
            });
            if (b.verification) {
              trail.push({
                when: b.verification.createdAt,
                actor: "AiVerificationService",
                role: "Automated check",
                event: (<>Confidence {b.verification.confidence.toFixed(2)} · {b.verification.checks.filter((c) => c.passed).length}/{b.verification.checks.length} checks passed</>),
                tone: b.verification.verdict === "VERIFIED" ? "ok" : "warn",
                statusLabel: b.verification.verdict.replace(/_/g, " "),
              });
            }
            if (b.ledgerEntry) {
              trail.push({
                when: b.ledgerEntry.timestamp,
                actor: "Evidence ledger",
                role: "System",
                event: (<>Entry #{b.ledgerEntry.seq} appended · <span className="mono">{shortHash(b.ledgerEntry.currentHash, 16)}</span></>),
                tone: "ok",
                statusLabel: "Chained",
              });
            }
          }
          trail.push({
            when: item.approval.createdAt,
            actor: "Governance",
            role: "System",
            event: `Approval requested — requires ${item.approval.requiredRoles.map(roleLabel).join(" + ")}`,
            tone: "warn",
            statusLabel: "Pending",
          });
          for (const rec of item.records) {
            trail.push({
              when: rec.createdAt,
              actor: input.users.get(rec.userId)?.name ?? roleLabel(rec.role),
              role: roleLabel(rec.role),
              event: rec.decision === "APPROVED" ? "Release eligibility approved" : "Returned for review",
              tone: rec.decision === "APPROVED" ? "ok" : "bad",
              statusLabel: rec.decision,
            });
          }

          return (
            <div className="panel" style="margin-bottom:16px">
              <div className="panel-head">
                <h3>
                  {item.project.name} — M{item.milestone.seq}: {item.milestone.title}
                </h3>
                <span className="right">
                  <span className="chip warn">HELD — {money(item.milestone.trancheAmount)}</span>
                  {b?.verification ? <VerdictChip verdict={b.verification.verdict} /> : null}
                </span>
              </div>

              {/* Dominant money-control statement — the financial consequence
                  is understood before any button is reachable. */}
              <div className="money-strip">
                <span className="amt">
                  <span className="v">{money(item.milestone.trancheAmount)}</span>
                  <span className="s">● HELD — RELEASE REQUIRES GOVERNANCE</span>
                </span>
                <span className="await">
                  Submitted {fmtDate(item.approval.createdAt).slice(0, 16)}
                  {missing.length > 0 ? (
                    <>
                      <br />
                      Awaiting: <b>{missing.map(roleLabel).join(", ")}</b>
                    </>
                  ) : null}
                </span>
                <span className="gp">
                  <span className="v" style="display:block">{approved} OF {item.approval.requiredRoles.length}</span>
                  <span className="l" style="display:block">Approvals recorded</span>
                </span>
              </div>

              <div className="approval-review">
                <div className="col-decide">
                  <div className="blk-progress">
                    <div className="t-meta" style="margin-bottom:7px">Governance</div>
                    <ApprovalProgress approval={item.approval} records={item.records} users={input.users} hideSummary={true} />
                  </div>
                  <div className="blk-actions">
                    {item.canDecide ? (
                      <>
                        <div className="decision-actions">
                          <form className="f-approve" method="POST" action={`/api/approvals/${item.approval.id}/decision`} style="margin:0">
                            <input type="hidden" name="decision" value="APPROVED" />
                            <button className="btn approve" type="submit">
                              Approve release eligibility
                            </button>
                          </form>
                          <form className="f-reject" method="POST" action={`/api/approvals/${item.approval.id}/decision`} style="margin:0">
                            <input type="hidden" name="decision" value="REJECTED" />
                            <button className="btn danger" type="submit" style="width:100%">Return for review</button>
                          </form>
                        </div>
                        <div className="decision-note-wrap">
                          <p className="decision-note">
                            Approving records your sign-off. The {money(item.milestone.trancheAmount)} tranche
                            releases only when all required roles have approved.
                          </p>
                        </div>
                      </>
                    ) : item.alreadyDecided ? (
                      <div className="banner info" style="margin:0">Your decision is recorded. Awaiting the remaining role(s).</div>
                    ) : (
                      <div className="banner info" style="margin:0">
                        Sign in as one of the required roles to decide. Your current role is not part of this approval.
                      </div>
                    )}
                  </div>
                </div>

                <div className="col-photo">
                  {b ? (
                    <>
                      <div className="blk-photo">
                        <div className="approval-photo">
                          <img src={b.evidence.photoPath} alt="Field evidence photo" />
                        </div>
                        <div className="evidence-cap">
                          Field evidence — M{item.milestone.seq} · {item.milestone.title}
                          <span className="mono">{fmtDate(b.evidence.capturedAt).slice(0, 16)}</span>
                        </div>
                        <div style="margin-top:7px">
                          <EvidenceStatusChips verification={b.verification} isDemoFallback={b.evidence.isDemoFallback} />
                        </div>
                      </div>
                      <div className="blk-meta">
                        <div className="photo-meta">
                          <div className="row"><span className="k">Captured by</span><span className="v">{b.submittedBy?.name ?? "—"}</span></div>
                          <div className="row"><span className="k">Captured</span><span className="v mono">{fmtDate(b.evidence.capturedAt)}</span></div>
                          <div className="row"><span className="k">GPS</span><span className="v mono">{fmtGps(b.evidence.latitude, b.evidence.longitude)}</span></div>
                          <div className="row"><span className="k">Device</span><span className="v">{b.evidence.deviceMetadata.platform} · {b.evidence.deviceMetadata.screen}</span></div>
                          <div className="row"><span className="k">Capture mode</span><span className="v">{b.evidence.isDemoFallback ? "Demo fallback" : "Live capture"}</span></div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="note">Evidence record unavailable.</div>
                  )}
                </div>

                <div className="col-facts">
                  {b ? (
                    <>
                      <div className="blk-checks">
                        <div className="ev-sec">Requirement</div>
                        <p style="margin:0;font-size:13px;color:var(--ink-2)">{item.milestone.requirement}</p>
                        {b.verification ? (
                          <>
                            <div className="ev-sec">Verification checks</div>
                            <EvidenceChecks verification={b.verification} />
                            <div className="ev-sec">AI verification result</div>
                            <EvidenceAiResult verification={b.verification} />
                          </>
                        ) : null}
                      </div>
                      <div className="blk-proof">
                        <div className="ev-sec">Proof integrity</div>
                        <EvidenceHashes evidence={b.evidence} ledgerEntry={b.ledgerEntry} />
                      </div>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="audit-trail">
                <div className="lbl">Approval audit trail</div>
                <table className="audit-table" style="margin-top:8px">
                  <thead>
                    <tr>
                      <th style="width:140px">Timestamp</th>
                      <th style="width:170px">Actor</th>
                      <th style="width:150px">Role</th>
                      <th>Decision / event</th>
                      <th style="width:120px">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trail.map((t) => (
                      <tr>
                        <td className="ts">{fmtDate(t.when).slice(0, 19)}</td>
                        <td className="who">{t.actor}</td>
                        <td className="role">{t.role}</td>
                        <td>
                          {t.event}
                          <span className="ts-inline">{fmtDate(t.when).slice(0, 19)} · {t.role}</span>
                        </td>
                        <td className="st">
                          <span className={`status ${t.tone === "info" ? "" : t.tone}`}>
                            <span className="g">{t.tone === "ok" ? "✓" : t.tone === "bad" ? "✕" : "●"}</span>
                            {t.statusLabel}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })
      )}

      {resolved.length > 0 ? (
        <>
          <h2 className="section">Resolved</h2>
          <div className="panel">
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
                      <span className="num" style="font-weight:650;color:var(--ink-2)">{money(item.milestone.trancheAmount)}</span>
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
  actorByEntry?: Map<string, string>;
  showVerify: boolean;
  checkedBanner?: string | null;
  lastCheckAt?: string | null;
}): VNode {
  const milestoneProject = (milestoneId: string): Project | undefined => {
    const m = props.milestoneById.get(milestoneId);
    return m ? props.projectById.get(m.projectId) : undefined;
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Evidence register</h3>
        <span className="right">
          <span className="num">{props.ledger.length} entries</span>
          {props.lastCheckAt ? <span>last check {fmtDate(props.lastCheckAt).slice(0, 16)}</span> : null}
          <IntegrityChip valid={props.chainValid} brokenAt={props.brokenAt} />
          {props.showVerify ? (
            <form method="POST" action="/api/ledger/verify" style="margin:0">
              <button className="btn secondary sm" type="submit">Verify integrity</button>
            </form>
          ) : null}
        </span>
      </div>
      {props.checkedBanner ? (
        <div style="padding:12px 18px 0">
          <div className={`banner ${props.chainValid ? "ok" : "warn"}`} style="margin:0">
            {props.checkedBanner}
          </div>
        </div>
      ) : null}

      <div className="desktop-only table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Entry</th>
              <th>Timestamp</th>
              <th>Project / milestone</th>
              <th>Evidence</th>
              <th>Verification</th>
              <th>Actor</th>
              <th>Hash</th>
              <th>Prev hash</th>
              <th>Integrity</th>
            </tr>
          </thead>
          <tbody>
            {props.ledger.length === 0 ? (
              <tr><td colspan="9" className="sub">Ledger is empty.</td></tr>
            ) : (
              props.ledger.map((e) => {
                const m = props.milestoneById.get(e.milestoneId);
                const p = milestoneProject(e.milestoneId);
                return (
                  <tr>
                    <td className="mono">#{e.seq}</td>
                    <td className="mono" style="font-size:11px">{fmtDate(e.timestamp)}</td>
                    <td>
                      {p ? <span style="display:block;font-size:10.5px;color:var(--ink-4)">{p.name}</span> : null}
                      <a href={m ? `/milestone/${m.id}` : "#"}>M{m?.seq}: {m?.title}</a>
                    </td>
                    <td className="mono" title={e.evidenceItemId}>{e.evidenceItemId.slice(0, 8)}…</td>
                    <td><span className="status ok"><span className="g">✓</span>Verified</span></td>
                    <td style="font-size:11.5px">{props.actorByEntry?.get(e.id) ?? "—"}</td>
                    <td className="mono" title={e.currentHash}>{shortHash(e.currentHash, 12)}</td>
                    <td className="mono" title={e.previousHash}>{shortHash(e.previousHash, 12)}</td>
                    <td>
                      {props.chainValid || (props.brokenAt !== undefined && e.seq < props.brokenAt) ? (
                        <span className="status ok"><span className="g">✓</span>OK</span>
                      ) : (
                        <span className="status bad"><span className="g">✕</span>Suspect</span>
                      )}
                    </td>
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
              <div className="sub mono" style="font-size:10.5px;margin-top:2px">{fmtDate(e.timestamp)}</div>
              <div className="hash">hash {shortHash(e.currentHash, 26)}<br />prev {shortHash(e.previousHash, 26)}</div>
            </div>
          );
        })}
      </div>

      <div className="panel-foot">
        Each entry's hash covers its content plus the previous entry's hash — any retroactive
        edit breaks every later hash. Open a milestone for the full proof detail.
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
  actorByEntry: Map<string, string>;
  checkedBanner?: string | null;
  lastCheckAt?: string | null;
}): string {
  return renderDocument(
    <AppShell title="Evidence ledger" nav={input.nav}>
      <PageHeader
        title="Evidence ledger"
        sub="Append-only, hash-chained register of every verified evidence item. Tamper-evident by construction."
      />
      {!input.chainValid ? (
        <div className="banner warn" style="border-color:var(--bad-line);background:var(--bad-bg);color:var(--bad)">
          <b>TAMPERING DETECTED AT ENTRY {input.brokenAt}.</b> Entries at and after this point
          cannot be relied upon. Investigate before accepting any report generated from this ledger.
        </div>
      ) : null}
      <LedgerCard
        ledger={input.ledger}
        chainValid={input.chainValid}
        brokenAt={input.brokenAt}
        milestoneById={input.milestoneById}
        projectById={input.projectById}
        actorByEntry={input.actorByEntry}
        showVerify={true}
        checkedBanner={input.checkedBanner}
        lastCheckAt={input.lastCheckAt}
      />
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// -------------------------------------------------------------- reports

export function renderReports(input: {
  nav: NavContext;
  projects: Project[];
  reports: Report[];
  users: Map<string, User>;
  pdfError?: boolean;
}): string {
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  return renderDocument(
    <AppShell title="Reports" nav={input.nav}>
      <PageHeader title="Reports" sub="Audit-ready document registry for funders, project offices and compliance teams." />

      {input.pdfError ? (
        <div className="banner warn">
          <b>PDF rendering is unavailable in this environment.</b> The printable HTML version
          remains available via "Preview HTML" below.
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h3>Project Verification &amp; Fund Release Report</h3>
          <span className="right">Generated from live application data · runs a ledger integrity check</span>
        </div>
        <div style="padding:4px 18px 8px">
          {input.projects.map((p) => (
            <div style="display:flex;align-items:center;gap:12px;padding:9px 0;flex-wrap:wrap;border-top:1px solid var(--line)">
              <span style="font-weight:600;min-width:0;font-size:13px">{p.name}</span>
              <span style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
                <a className="btn ghost sm" href={`/report/${p.id}/preview`} target="_blank">Preview HTML</a>
                <form method="POST" action="/api/reports/generate" style="margin:0">
                  <input type="hidden" name="projectId" value={p.id} />
                  <button className="btn sm" type="submit" data-busy-label="Generating…">Generate report (PDF)</button>
                </form>
              </span>
            </div>
          ))}
        </div>
      </div>

      <h2 className="section">Generated reports</h2>
      {input.reports.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={icons.reports()}
            title="No reports generated yet"
            message="Generate a report above — it stays available for download here."
          />
        </div>
      ) : (
        <div className="panel">
          <div className="desktop-only table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Report</th>
                  <th>Project</th>
                  <th>Generated</th>
                  <th>Generated by</th>
                  <th>Ledger integrity</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {input.reports.map((r) => {
                  const project = projectById.get(r.projectId);
                  const by = input.users.get(r.generatedBy);
                  return (
                    <tr>
                      <td>
                        <span style="display:inline-flex;align-items:center;gap:7px;font-weight:550">
                          {icons.file(13)} Verification &amp; Fund Release
                        </span>
                        <span className="mono" style="display:block;font-size:10px;color:var(--ink-4)">{r.filename}</span>
                      </td>
                      <td style="font-size:12px">{project?.name ?? r.projectId}</td>
                      <td className="mono" style="font-size:11px">{fmtDate(r.generatedAt)}</td>
                      <td style="font-size:12px">{by ? by.name : r.generatedBy}</td>
                      <td>
                        {r.integrityStatus === "INTACT" ? (
                          <span className="status ok"><span className="g">✓</span>Chain intact</span>
                        ) : (
                          <span className="status bad"><span className="g">✕</span>{r.integrityStatus.replace("TAMPERED_AT:", "Tampering at #")}</span>
                        )}
                        <span className="sub" style="display:block;font-size:10px">{r.ledgerEntries} entries</span>
                      </td>
                      <td style="white-space:nowrap">
                        <a className="btn secondary sm" href={`/reports/file/${r.id}`} target="_blank">Open</a>{" "}
                        <a className="btn ghost sm" href={`/reports/file/${r.id}?dl=1`}>Download</a>{" "}
                        <form method="POST" action="/api/reports/generate" style="display:inline;margin:0">
                          <input type="hidden" name="projectId" value={r.projectId} />
                          <button className="btn ghost sm" type="submit" data-busy-label="Generating…">Regenerate</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mobile-only">
            {input.reports.map((r) => {
              const project = projectById.get(r.projectId);
              const by = input.users.get(r.generatedBy);
              return (
                <div className="ledger-row">
                  <div className="t"><span>{project?.name ?? r.projectId}</span></div>
                  <div className="sub" style="margin-top:2px">
                    Verification &amp; Fund Release · {by?.name ?? ""}{" "}
                    {r.integrityStatus === "INTACT" ? (
                      <span className="status ok" style="margin-left:4px"><span className="g">✓</span>Intact</span>
                    ) : (
                      <span className="status bad"><span className="g">✕</span>Tampering</span>
                    )}
                  </div>
                  <div className="sub mono" style="font-size:10.5px;margin-top:2px">{fmtDate(r.generatedAt)}</div>
                  <div style="display:flex;gap:8px;margin-top:8px">
                    <a className="btn secondary sm" href={`/reports/file/${r.id}`}>Open</a>
                    <a className="btn ghost sm" href={`/reports/file/${r.id}?dl=1`}>Download</a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="footer-note">
        Reports are point-in-time snapshots generated from live application data and stored in
        the demo environment. Regenerating reflects the current state.
      </p>
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

      <OperationalStatus
        items={[
          { tone: d.needsReview.length > 0 ? "warn" : "ok", value: String(d.needsReview.length), label: "evidence needing review" },
          { tone: d.rejected.length > 0 ? "bad" : "ok", value: String(d.rejected.length), label: "rejected evidence" },
          { tone: d.awaitingApproval.length > 0 ? "warn" : "idle", value: String(d.awaitingApproval.length), label: "awaiting approval" },
          { tone: d.chainValid ? "ok" : "bad", value: d.chainValid ? "Intact" : `Alert #${d.brokenAt}`, label: "ledger integrity" },
        ]}
      />

      <h2 className="section">Evidence needing review</h2>
      {d.needsReview.length === 0 ? (
        <div className="panel"><EmptyState icon={icons.check()} title="Nothing flagged" message="No evidence currently requires human review." /></div>
      ) : (
        d.needsReview.map((b) => (
          <div style="margin-bottom:12px">
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
        <div className="panel"><EmptyState icon={icons.approvals()} title="No open approvals" message="All verified milestones have completed governance." /></div>
      ) : (
        <div className="panel">
          <ul className="activity">
            {d.awaitingApproval.map((a) => (
              <li>
                <span className="ico warn">{icons.clock()}</span>
                <span className="body">
                  <span className="msg"><b>{a.project.name}</b> — M{a.milestone.seq}: {a.milestone.title}</span>
                  <span className="meta">
                    <span className="when">requested {fmtDate(a.approval.createdAt)}</span>
                    <span className="num" style="font-weight:650;color:var(--ink-2)">{money(a.milestone.trancheAmount)} held</span>
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
            <div style="margin-bottom:12px">
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
    <AppShell title="Verification Insights" nav={input.nav}>
      <PageHeader
        title="Verification insights"
        sub="Automated observations derived from recorded verification, approval and submission data. Informational only — no autonomous decisions are made."
      />
      {input.insights.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={icons.insights()}
            title="No anomalies detected"
            message="All recorded verifications look consistent. Insights appear as evidence accumulates."
          />
        </div>
      ) : (
        <div className="panel">
          <ul className="activity">
            {input.insights.map((ins) => (
              <li>
                <span className={`ico ${ins.severity === "bad" ? "bad" : ins.severity === "warn" ? "warn" : "info"}`}>
                  {ins.severity === "info" ? icons.insights() : icons.alert()}
                </span>
                <span className="body">
                  <span className="msg"><b>{ins.title}</b> — {ins.detail}</span>
                  {ins.href ? <span className="meta"><a href={ins.href}>View →</a></span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="footer-note">
        Computed from stored verification records, not a generative model.
      </p>
    </AppShell>
  );
}

// ----------------------------------------------------------------- more

export function renderMore(input: { nav: NavContext }): string {
  const { user } = input.nav;
  const items = [
    { href: "/map", label: "Project Map", icon: icons.map, desc: "Spatial project intelligence" },
    { href: "/communications", label: "Communications", icon: icons.chat, desc: "Project-linked coordination threads" },
    { href: "/field", label: "Field Capture", icon: icons.camera, desc: "Mobile evidence capture" },
    { href: "/reports", label: "Reports", icon: icons.reports, desc: "Document registry & exports" },
    { href: "/compliance", label: "Risk & Compliance", icon: icons.shield, desc: "Open review items and integrity" },
    { href: "/insights", label: "Verification Insights", icon: icons.insights, desc: "Automated observations" },
  ];
  return renderDocument(
    <AppShell title="More" nav={{ ...input.nav, active: "more" }}>
      <PageHeader title="More" />
      <div className="panel">
        {items.map((i, idx) => (
          <a href={i.href} style={`display:flex;gap:12px;align-items:center;padding:13px 16px;color:var(--ink);min-height:48px;${idx > 0 ? "border-top:1px solid var(--line)" : ""}`}>
            <span style="width:32px;height:32px;border-radius:7px;background:var(--inset);border:1px solid var(--line);color:var(--ink-3);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              {i.icon()}
            </span>
            <span style="min-width:0">
              <span style="font-weight:600;display:block;font-size:13px">{i.label}</span>
              <span className="sub" style="display:block;font-size:11.5px">{i.desc}</span>
            </span>
            <span style="margin-left:auto;color:var(--ink-4)">{icons.arrowRight(14)}</span>
          </a>
        ))}
      </div>
      <div className="panel panel-pad" style="display:flex;gap:12px;align-items:center;margin-top:12px">
        <span style="width:36px;height:36px;border-radius:8px;background:var(--inset);border:1px solid var(--line);color:var(--ink-2);font-weight:650;font-size:12px;display:flex;align-items:center;justify-content:center">
          {initials(user.name)}
        </span>
        <span style="min-width:0;flex:1">
          <span style="font-weight:600;display:block;font-size:13px">{user.name}</span>
          <span className="sub" style="display:block;font-size:11.5px">{roleLabel(user.role)}{input.nav.orgName ? ` · ${input.nav.orgName}` : ""}</span>
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
        <meta name="theme-color" content="#0c1220" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body className="field-body">
        <div className="field-shell">
          <div className="field-head">
            <span className="mark">{brandMark(16)}</span>
            <span>
              <span className="brand-sm" style="display:block">OBV Field</span>
              <span className="brand-sub" style="display:block">Evidence capture</span>
            </span>
            <span className="role-tag">
              {user.name}
              <br />
              {user.title} · <a href="/" style="color:#96b0f5">switch</a>
            </span>
          </div>
          <div id="app" data-user-id={user.id} data-user-name={user.name}>
            <div className="field-card">
              <div className="skeleton" style="height:14px;width:40%;margin-bottom:12px;background:#263a58"></div>
              <div className="skeleton" style="height:52px;margin-bottom:8px;background:#1a2740"></div>
              <div className="skeleton" style="height:52px;margin-bottom:8px;background:#1a2740"></div>
              <div className="skeleton" style="height:52px;background:#1a2740"></div>
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
            <div className="auth-box" style="text-align:center;max-width:420px">
              <h1 className="t-title">{title}</h1>
              <p className="sub">{message}</p>
              <a className="btn" href="/" style="margin-top:10px">Go to sign-in</a>
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

// ------------------------------------------------------ spatial map

/**
 * Shared map shell — the interactive engine lives in /js/map.js (a
 * zero-dependency slippy map behind a tile-provider adapter; standard
 * tiles from OpenStreetMap, satellite from Esri World Imagery — public,
 * token-free sources, so there is no map secret to leak). The map only
 * PRESENTS state read from /api/map-context; it never computes verdicts.
 */
function MapShell(props: { projectId?: string }): VNode {
  return (
    <div className="map-wrap" id="map-wrap" data-project={props.projectId ?? ""}>
      <div className="map-toolbar">
        <div className="map-layers" role="group" aria-label="Map layer">
          <button type="button" id="layer-map" className="active" aria-pressed="true">Map</button>
          <button type="button" id="layer-sat" aria-pressed="false">Satellite</button>
        </div>
        <button type="button" className="map-filters-btn" id="flt-btn" aria-expanded="false" aria-controls="map-filters">
          Filters
        </button>
        <div className="map-filters" id="map-filters" role="group" aria-label="Evidence filters">
          <div className="map-filters-head">
            <span>Filters</span>
            <button type="button" id="flt-close" aria-label="Close filters">×</button>
          </div>
          <label>Time
            <select id="flt-time" aria-label="Evidence time filter">
              <option value="all">All evidence</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
            </select>
          </label>
          <label>Milestone
            <select id="flt-milestone" aria-label="Milestone filter">
              <option value="all">All milestones</option>
            </select>
          </label>
          <label>Verification
            <select id="flt-verdict" aria-label="Verdict filter">
              <option value="all">All verdicts</option>
              <option value="VERIFIED">Verified</option>
              <option value="NEEDS_REVIEW">Needs review</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </label>
        </div>
      </div>
      <div className="map-summary" id="map-summary" aria-live="polite"></div>
      <div className="map-stage">
        <div className="map-canvas" id="map-canvas" aria-label="Project map"></div>
        <div className="map-note" id="map-note" hidden>
          Base map unavailable — project geometry still available
        </div>
        <div className="map-legend" id="map-legend" aria-label="Map legend">
          <button type="button" className="legend-toggle" id="legend-toggle" aria-expanded="true">Legend</button>
          <div className="legend-body" id="legend-body"></div>
        </div>
        <aside className="map-panel" id="map-panel" aria-live="polite">
          <button type="button" className="map-panel-close" id="map-panel-close" aria-label="Close details">×</button>
          <div className="map-panel-empty" id="map-panel-empty">
            Select the project, a milestone segment, or an evidence marker.
          </div>
          <div id="map-panel-body"></div>
        </aside>
      </div>
      <script src="/js/map.js" defer></script>
    </div>
  );
}

export function renderMap(input: { nav: NavContext; scope: "global" }): string {
  return renderDocument(
    <AppShell title="Project Map" nav={input.nav}>
      <PageHeader
        title="Project Map"
        sub="Spatial view of project boundaries, milestone progress, and evidence capture locations."
      />
      <MapShell />
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------ communications

/**
 * Contextual project communications. CHAT COORDINATES — nothing here can
 * approve or release; reference cards link to the formal screens where
 * governance actually happens.
 */
export interface ThreadListItem {
  thread: ConversationThread;
  latest: ChatMessage | null;
  project: Project | null;
  milestone: Milestone | null;
}

function threadStamp(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 90_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return fmtDate(iso);
}

function MessageRefCard(props: { m: ChatMessage }): VNode | null {
  const { m } = props;
  if (m.messageType === "EVIDENCE_REFERENCE" && m.refId) {
    const v = repoView.verificationForEvidence(m.refId);
    return (
      <span className="msg-ref">
        <span className="k">EVIDENCE</span>
        {v ? (
          <span className="s">{v.verdict.replace(/_/g, " ")} · {v.confidence.toFixed(2)} confidence</span>
        ) : null}
        <a href={`/milestone/${repoView.milestoneIdForEvidence(m.refId) ?? ""}`}>View evidence</a>
        <a href={`/map`}>View on map</a>
      </span>
    );
  }
  if (m.messageType === "APPROVAL_REFERENCE" && m.refId) {
    const a = repoView.approval(m.refId);
    return (
      <span className="msg-ref">
        <span className="k">APPROVAL REQUEST</span>
        {a ? (
          <span className="s">
            {a.records} of {a.required} complete · {money(a.amount)} {a.accountStatus}
          </span>
        ) : null}
        <a href="/approvals">View approval</a>
      </span>
    );
  }
  if (m.messageType === "MILESTONE_REFERENCE" && m.refId) {
    return (
      <span className="msg-ref">
        <span className="k">MILESTONE</span>
        <a href={`/milestone/${m.refId}`}>View milestone</a>
      </span>
    );
  }
  if (m.messageType === "REPORT_REFERENCE" && m.refId) {
    return (
      <span className="msg-ref">
        <span className="k">REPORT</span>
        <a href={`/reports/file/${m.refId}`}>Open report</a>
      </span>
    );
  }
  return null;
}

function bindingStatusLabel(
  b: ExternalThreadBinding | null,
  configured: boolean,
  testMode = false
): string {
  if (!configured) return "Demo mode";
  if (!b || b.status === "DISCONNECTED") return "Disconnected";
  if (b.status === "PERMISSION_REQUIRED") return "Teams permissions required";
  if (b.status === "CONNECTING") return "Connecting";
  if (b.status === "DEGRADED") return "Connection degraded";
  return testMode ? "Integration test mode" : "Connected to Teams";
}
function bindingTone(b: ExternalThreadBinding | null, configured: boolean): string {
  if (!configured) return "neutral";
  if (!b || b.status === "DISCONNECTED") return "neutral";
  if (b.status === "PERMISSION_REQUIRED" || b.status === "DEGRADED" || b.status === "CONNECTING") return "warn";
  return "ok";
}

export function renderCommunications(input: {
  nav: NavContext;
  threads: ThreadListItem[];
  selected: {
    thread: ConversationThread;
    messages: ChatMessage[];
    project: Project | null;
    milestone: Milestone | null;
    binding: ExternalThreadBinding | null;
    hasEvidence: boolean;
  } | null;
  users: Map<string, User>;
  currentUser: User;
  teamsSyncConfigured: boolean;
  teamsSendCapability: "delegated" | "app-test" | "none";
  teamsTestMode: boolean;
  canManageTeams: boolean;
  syncError: string | null;
}): string {
  const { selected } = input;
  const sorted = [...input.threads].sort((a, b) => {
    const at = a.latest?.createdAt ?? a.thread.createdAt;
    const bt = b.latest?.createdAt ?? b.thread.createdAt;
    return at < bt ? 1 : -1;
  });
  return renderDocument(
    <AppShell title="Communications" nav={input.nav} context={selected?.thread.title}>
      <div className={`comms ${selected ? "has-selection" : ""}`}>
        <section className="comms-list" aria-label="Threads">
          <div className="comms-list-head">
            <h3>Threads</h3>
            <span className="sub">Project-linked coordination</span>
          </div>
          {sorted.map((t) => (
            <a
              className={`thread-row ${selected?.thread.id === t.thread.id ? "active" : ""}`}
              href={`/communications?thread=${t.thread.id}`}
            >
              <span className="t">{t.thread.title}</span>
              <span className="p">{t.project?.name ?? "Organization"}</span>
              {t.latest ? (
                <span className="prev">
                  {t.latest.messageType === "TEXT" ? `${t.latest.senderDisplayName}: ` : ""}
                  {t.latest.body.slice(0, 96)}
                </span>
              ) : (
                <span className="prev sub">No messages yet.</span>
              )}
              <span className="when">{threadStamp(t.latest?.createdAt ?? t.thread.createdAt)}</span>
            </a>
          ))}
        </section>

        {selected ? (
          <section className="comms-conv" aria-label="Conversation">
            <div className="conv-head">
              <a className="conv-back" href="/communications" aria-label="Back to threads">←</a>
              <span className="t">
                <b>{selected.thread.title}</b>
                <span className="s">
                  {selected.project?.name}
                  {selected.milestone ? ` · M${selected.milestone.seq}` : ""}
                  <span className={`sync-tag ${bindingTone(selected.binding, input.teamsSyncConfigured)}`}>
                    {bindingStatusLabel(selected.binding, input.teamsSyncConfigured, input.teamsTestMode)}
                  </span>
                </span>
              </span>
              <button type="button" className="btn ghost sm conv-ctx-toggle" id="ctx-toggle">Context</button>
            </div>
            <div className="conv-scroll" id="conv-scroll">
              {selected.messages.map((m) => {
                const sender = m.senderUserId ? input.users.get(m.senderUserId) : null;
                const isTeams = m.provider === "TEAMS";
                const isOwn = m.senderUserId === input.currentUser.id;
                return m.senderUserId || isTeams ? (
                  <div className="msg">
                    <span className="avatar" aria-hidden="true">{initials(m.senderDisplayName)}</span>
                    <span className="body">
                      <span className="who">
                        <b>{m.senderDisplayName}</b>
                        {sender ? <span className="role">{roleLabel(sender.role)}</span> : null}
                        {isTeams ? <span className="prov">via Microsoft Teams</span> : null}
                        <span className="when">{fmtDate(m.createdAt)}</span>
                        {m.editedAt ? <span className="edited">edited in Teams</span> : null}
                      </span>
                      {m.externalDeleted ? (
                        <span className="text deleted">Message deleted in Microsoft Teams</span>
                      ) : (
                        <span className="text">{m.body}</span>
                      )}
                      {!m.externalDeleted && m.attachments.length > 0 ? (
                        <span className="msg-attach">
                          {m.attachments.map((a) =>
                            a.url ? (
                              <a href={a.url} target="_blank" rel="noopener noreferrer">📎 {a.name}</a>
                            ) : (
                              <span>📎 {a.name}</span>
                            )
                          )}
                          <span className="note">Communication attachment — evidence is submitted only via Field Capture</span>
                        </span>
                      ) : null}
                      <MessageRefCard m={m} />
                      {isOwn && selected.binding && selected.binding.status !== "DISCONNECTED" && m.origin === "OBV_LOCAL" ? (
                        <span className={`msg-sync ${m.externalMessageId ? "ok" : m.deliveryStatus === "FAILED" ? "bad" : ""}`}>
                          {m.externalMessageId
                            ? "Sent to Teams"
                            : m.deliveryStatus === "FAILED"
                              ? "Teams delivery failed — kept in OBV"
                              : ""}
                        </span>
                      ) : null}
                    </span>
                  </div>
                ) : (
                  <div className="msg system">
                    <span className="body">
                      <span className="text">{m.body}</span>
                      <MessageRefCard m={m} />
                      <span className="when">{fmtDate(m.createdAt)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
            <form className="composer" method="POST" action={`/api/threads/${selected.thread.id}/messages`}>
              <input
                type="text"
                name="body"
                placeholder="Write a coordination message… (messages never authorize approvals or funds)"
                autocomplete="off"
                maxlength="4000"
                required
              />
              <button className="btn" type="submit">Send</button>
            </form>
          </section>
        ) : (
          <section className="comms-conv empty" aria-label="Conversation">
            <div className="comms-empty">
              <p><b>Select a thread.</b></p>
              <p className="sub">
                Chat coordinates. Evidence proves. Humans authorize. The ledger records.
                Nothing written here can approve a release — governance stays on the
                Approvals screen.
              </p>
            </div>
          </section>
        )}

        {selected ? (
          <CommsContextPanel
            selected={selected}
            teamsSyncConfigured={input.teamsSyncConfigured}
            teamsSendCapability={input.teamsSendCapability}
            teamsTestMode={input.teamsTestMode}
            canManageTeams={input.canManageTeams}
            syncError={input.syncError}
          />
        ) : null}
      </div>
      <script src="/js/poll.js" defer></script>
      <script src="/js/comms.js" defer></script>
    </AppShell>
  );
}

function CommsContextPanel(props: {
  selected: {
    thread: ConversationThread;
    project: Project | null;
    milestone: Milestone | null;
    binding: ExternalThreadBinding | null;
    hasEvidence: boolean;
  };
  teamsSyncConfigured: boolean;
  teamsSendCapability: "delegated" | "app-test" | "none";
  teamsTestMode: boolean;
  canManageTeams: boolean;
  syncError: string | null;
}): VNode {
  const { thread, project, milestone, binding } = props.selected;
  const ctx = milestone
    ? repoView.milestoneContext(milestone.id)
    : project
      ? repoView.projectContext(project.id)
      : null;
  return (
    <aside className="comms-ctx" id="comms-ctx" aria-label="Thread context">
      <div className="ctx-head">Linked context</div>
      {milestone && ctx && "requirement" in ctx ? (
        <dl className="ctx-kv">
          <dt>Milestone</dt><dd>M{milestone.seq} · {milestone.title}</dd>
          <dt>Requirement</dt><dd>{milestone.requirement}</dd>
          <dt>Tranche</dt><dd className="num">{money(milestone.trancheAmount)} · {milestone.accountStatus}</dd>
          <dt>Evidence</dt><dd>{ctx.evidenceCount} item{ctx.evidenceCount === 1 ? "" : "s"}</dd>
          <dt>Verification</dt><dd>{ctx.verdict ?? "—"}</dd>
          <dt>Approval</dt><dd>{ctx.approvalLine}</dd>
        </dl>
      ) : project && ctx && "released" in ctx ? (
        <dl className="ctx-kv">
          <dt>Project</dt><dd>{project.name}</dd>
          <dt>Location</dt><dd>{project.location}</dd>
          <dt>Budget</dt><dd className="num">{money(project.totalBudget)}</dd>
          <dt>Released</dt><dd className="num">{money(ctx.released)}</dd>
          <dt>Held</dt><dd className="num">{money(ctx.held)}</dd>
          <dt>Pending approvals</dt><dd>{ctx.pendingApprovals}</dd>
        </dl>
      ) : (
        <p className="sub" style="padding:0 14px">Organization-scope thread.</p>
      )}
      <div className="ctx-links">
        {project ? <a className="btn ghost sm" href={`/project/${project.id}?tab=map`}>View project map</a> : null}
        {milestone ? <a className="btn ghost sm" href={`/milestone/${milestone.id}`}>View milestone</a> : null}
        {project && !milestone ? <a className="btn ghost sm" href={`/project/${project.id}`}>View project</a> : null}
      </div>

      <div className="ctx-head" style="margin-top:8px;border-top:1px solid var(--line);padding-top:12px">
        Microsoft Teams connection
      </div>
      {props.syncError ? (
        <p className="sub" style="padding:8px 14px 0;color:var(--bad)">
          Teams connection error: {props.syncError}. The OBV thread is unaffected.
        </p>
      ) : null}
      {!props.teamsSyncConfigured ? (
        <div style="padding:10px 14px">
          <span className="sync-tag neutral">Teams conversation sync not configured</span>
          <p className="ctx-note" style="padding:8px 0 0">
            An administrator can enable it by configuring the Microsoft Graph
            application credentials — see docs/TEAMS_CONVERSATION_SYNC.md.
            OBV chat and Teams event notifications work fully without it.
          </p>
        </div>
      ) : binding && binding.status !== "DISCONNECTED" ? (
        <>
          <dl className="ctx-kv">
            <dt>Status</dt>
            <dd><span className={`sync-tag ${bindingTone(binding, true)}`}>{bindingStatusLabel(binding, true, props.teamsTestMode)}</span></dd>
            {binding.status === "PERMISSION_REQUIRED" ? (
              <>
                <dt>Action</dt>
                <dd>Teams connection requires administrator approval — grant admin consent or install the OBV Teams app in this Team, then Reconnect.</dd>
              </>
            ) : null}
            <dt>Team</dt><dd>{binding.teamName ?? binding.teamId}</dd>
            <dt>Channel</dt><dd>{binding.channelName ?? binding.channelId}</dd>
            {props.teamsSendCapability === "none" ? (
              <>
                <dt>Sending</dt>
                <dd>Receive-only — outbound posting requires the delegated send permission (see docs/TEAMS_REAL_TENANT_SETUP.md).</dd>
              </>
            ) : null}
            <dt>Last sync</dt><dd>{binding.lastSyncAt ? fmtDate(binding.lastSyncAt) : "—"}</dd>
            <dt>Subscription</dt>
            <dd>{binding.subscriptionExpiresAt ? `expires ${fmtDate(binding.subscriptionExpiresAt)}` : "not active"}</dd>
          </dl>
          {props.canManageTeams ? (
            <div className="ctx-links">
              <form method="POST" action={`/api/threads/${thread.id}/teams-binding`} style="margin:0">
                <input type="hidden" name="action" value="reconnect" />
                <button className="btn ghost sm" type="submit">Reconnect</button>
              </form>
              <form method="POST" action={`/api/threads/${thread.id}/teams-binding`} style="margin:0">
                <input type="hidden" name="action" value="disconnect" />
                <button className="btn ghost sm" type="submit">Disconnect</button>
              </form>
              {props.selected.hasEvidence ? (
                <form method="POST" action={`/api/threads/${thread.id}/share-evidence`} style="margin:0">
                  <button className="btn ghost sm" type="submit" title="Share the latest evidence reference to the connected Teams channel">
                    Share evidence to Teams
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </>
      ) : props.canManageTeams ? (
        <form
          method="POST"
          action={`/api/threads/${thread.id}/teams-binding`}
          style="padding:10px 14px;display:flex;flex-direction:column;gap:8px"
        >
          <input type="hidden" name="action" value="connect" />
          <label style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3)">
            Team ID
            <input name="teamId" required style="width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:6px 8px;border:1px solid var(--line-2);margin-top:3px" />
          </label>
          <label style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3)">
            Channel ID
            <input name="channelId" required style="width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:6px 8px;border:1px solid var(--line-2);margin-top:3px" />
          </label>
          <button className="btn sm" type="submit">Manage Teams Connection — Connect</button>
          <p className="ctx-note" style="padding:0">
            Connects this thread to one Teams channel for coordination-message
            sync. Event notification cards (TeamsNotifier) are separate and
            unaffected.
          </p>
        </form>
      ) : (
        <p className="sub" style="padding:10px 14px">
          <span className="sync-tag neutral">Disconnected</span>
        </p>
      )}
      <p className="ctx-note">
        Formal decisions happen in their own workflows: evidence via Field Capture,
        approvals via Pending Approvals. Messages — from OBV or Teams — never
        authorize approvals or funds.
      </p>
    </aside>
  );
}
