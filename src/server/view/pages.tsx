/** Server-rendered pages — OBV design system v3 (institutional). */
import { h, Fragment, VNode, renderDocument, raw } from "./jsx";
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
  STYLESHEET_HREF,
} from "./components";
import type {
  ApprovalRecord,
  ApprovalRequest,
  ChatMessage,
  ClarificationRequest,
  ConversationThread,
  EvidenceDraft,
  EvidenceItem,
  ExternalThreadBinding,
  FieldIssue,
  FieldIssueEvent,
  LedgerEntry,
  Milestone,
  Notification,
  Organization,
  Project,
  Report,
  AuditPackage,
  MilestoneGates,
  JurisdictionalInspection,
  OfficialSourceRecord,
  Permit,
  PermitMilestoneLink,
  User,
  Verification,
  VirtualAccountEvent,
} from "../../shared/types";
import type { ProjectAccountSummary } from "../services/VirtualAccountService";
import { ATTENTION_RULES, type IntelligenceData } from "../services/intelligence";
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
    const m = a.milestoneId ? repo.getMilestone(a.milestoneId) : null;
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
  issue: (id: string) => repo.getFieldIssue(id),
  draw: (id: string) => repo.getDrawRequest(id),
  exception: (id: string) => repo.getException(id),
  clarification: (id: string) => repo.getClarification(id),
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

const ROLE_DESCRIPTIONS: Record<User["role"], string> = {
  FUNDER_REP:
    "Review verified evidence, approve release eligibility, monitor draws, exposure and portfolio health.",
  COMPLIANCE_REVIEWER:
    "Review flagged evidence, record decisions, track exceptions, clarifications and audit integrity.",
  PROJECT_MANAGER:
    "Manage draws and change orders, respond to blockers, and coordinate inspections and field work.",
  FIELD:
    "Capture timestamped, GPS-tagged evidence in the mobile field application and respond to clarifications.",
};

export function renderUserSwitcher(users: User[], orgs: Map<string, Organization>): string {
  const ordered = [...users].sort((a, b) => roleLabel(a.role).localeCompare(roleLabel(b.role)));
  return renderDocument(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Enter the demonstration — OBV</title>
        <link rel="stylesheet" href={STYLESHEET_HREF} />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#0d1626" />
      </head>
      <body>
        <div className="auth-wrap">
          <div className="auth-box demo-box">
            <div className="auth-brand">
              <a href="/" className="demo-home" aria-label="Back to the OpenBuild Verify homepage">
                <span className="mark">{brandMark(22)}</span>
                <span>
                  <span className="name" style="display:block">OpenBuild Verify</span>
                  <span className="tagline" style="display:block">Evidence, governance and control for construction capital</span>
                </span>
              </a>
              <span className="demo-env" title="Seeded demonstration data — no real projects or funds">Demo Environment</span>
            </div>
            <h1 className="demo-h">Select a demonstration role</h1>
            <p className="sub" style="max-width:620px">
              Explore the same governed project from the perspective of a funder, compliance
              reviewer, project manager, or field engineer. No credentials required.
            </p>
            <div className="roles">
              {ordered.map((u) => (
                <form method="POST" action="/api/session">
                  <input type="hidden" name="userId" value={u.id} />
                  <button className="role-card" type="submit" style="width:100%">
                    <span className="role">{roleLabel(u.role)}</span>
                    <span className="name" style="display:block">{u.name}</span>
                    <span className="org" style="display:block">{orgs.get(u.organizationId)?.name ?? ""}</span>
                    <span className="desc" style="display:block">{ROLE_DESCRIPTIONS[u.role]}</span>
                    <span className="enter">Enter Demo →</span>
                  </button>
                </form>
              ))}
            </div>
            <p className="footer-note">
              Office roles open the portfolio overview · the field engineer opens the mobile
              capture application. Production access uses authenticated organization accounts —
              this seeded selector exists only in the demonstration environment.
            </p>
            <a className="demo-return" href="/">← Return to OBV Overview</a>
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

export function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return fmtDate(iso).slice(0, 16);
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return fmtDate(iso).slice(0, 10);
}

const ACTIVITY_TITLES: Record<string, { title: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  MILESTONE_VERIFIED: { title: "Evidence verified", tone: "ok" },
  VERIFICATION_AGGREGATED: { title: "Verification completed", tone: "ok" },
  APPROVAL_RECORDED: { title: "Approval recorded", tone: "ok" },
  APPROVAL_REQUEST_CREATED: { title: "Approval requested", tone: "warn" },
  APPROVAL_REJECTED: { title: "Release rejected", tone: "bad" },
  TRANCHE_RELEASED: { title: "Release executed", tone: "ok" },
  EVIDENCE_NEEDS_REVIEW: { title: "Evidence flagged for review", tone: "warn" },
  EVIDENCE_REJECTED: { title: "Evidence rejected", tone: "bad" },
  INTEGRITY_CHECK: { title: "Integrity check passed", tone: "ok" },
  INTEGRITY_FAILURE: { title: "Integrity alert", tone: "bad" },
  DEMO_RESET: { title: "Demo data reset", tone: "neutral" },
  AI_VISUAL_VERIFICATION_SUCCEEDED: { title: "AI visual assessment", tone: "ok" },
  AI_VISUAL_FALLBACK_USED: { title: "AI fallback used", tone: "warn" },
};

export interface OverviewQueue {
  approvals: number;
  approvalsAmount: number;
  approvalsProjects: number;
  clarifications: number;
  highIssues: number;
  evidenceReview: number;
  exceptionsOpen: number;
  exceptionsHighCritical: number;
  exceptionsOverdue: number;
  exceptionsAwaiting: number;
}

export function renderOverview(input: {
  nav: NavContext;
  metrics: OverviewMetrics;
  projects: ProjectCardData[];
  notifications: Notification[];
  chainValid: boolean;
  teamsConfigured: boolean;
  nextReleases: Array<{ projectId: string; projectName: string; label: string; amount: number; awaiting: string }>;
  queue: OverviewQueue;
  openIssuesByProject: Map<string, number>;
}): string {
  const m = input.metrics;
  const releasedPct = m.totalBudget > 0 ? Math.round((m.released / m.totalBudget) * 100) : 0;
  const q = input.queue;
  const queueEmpty =
    q.approvals === 0 && q.clarifications === 0 && q.highIssues === 0 &&
    q.evidenceReview === 0 && q.exceptionsOpen === 0;
  return renderDocument(
    <AppShell title="Overview" nav={input.nav} context="Portfolio control center">
      <PageHeader title="Overview" sub="Portfolio control center">
        <form method="POST" action="/api/demo/reset" style="margin:0">
          <button className="btn ghost sm" type="submit" title="Restore the seeded demo state">
            Reset demo data
          </button>
        </form>
      </PageHeader>

      {/* ---- capital position ---- */}
      <div className="sec-label">Capital position</div>
      <div className="cap-grid">
        <div className="metric-card">
          <span className="mc-head">Total held <i className="mc-ico hold">{icons.shield()}</i></span>
          <span className="mc-v">{money(m.held)}</span>
          <span className="mc-sub">Across {input.projects.length} project{input.projects.length === 1 ? "" : "s"}</span>
        </div>
        <div className="metric-card">
          <span className="mc-head">Released <i className="mc-ico rel">{icons.check()}</i></span>
          <span className="mc-v">{money(m.released)}</span>
          <span className="mc-sub">{releasedPct}% of controlled amount</span>
        </div>
        <div className="metric-card">
          <span className="mc-head">Pending governance <i className="mc-ico pend">{icons.clock()}</i></span>
          <span className="mc-v">{money(m.pendingValue)}</span>
          <span className="mc-sub">
            {m.pendingApprovals === 0 ? "No open approval requests" : `Awaiting ${m.pendingApprovals === 1 ? "final approvals" : `${m.pendingApprovals} approval requests`}`}
          </span>
        </div>
        <div className="next-rel">
          <span className="nr-head">Next releases to watch</span>
          {input.nextReleases.length === 0 ? (
            <span className="nr-empty">No tranches are awaiting governance right now.</span>
          ) : (
            input.nextReleases.slice(0, 3).map((r) => (
              <a className="nr-row" href="/approvals">
                <span className="nr-id">
                  <span className="n">{r.label}</span>
                  <span className="s">{r.awaiting}</span>
                </span>
                <span className="nr-amt">{money(r.amount)}</span>
              </a>
            ))
          )}
          <a className="nr-foot" href="/approvals">View all approvals →</a>
        </div>
      </div>

      {/* ---- portfolio · action queue · activity ---- */}
      <div className="ov-grid">
        <div className="panel pf-panel">
          <div className="panel-head">
            <h3>Project portfolio</h3>
            <span className="right"><a href="/projects">View all projects →</a></span>
          </div>
          <p className="pf-count">
            {input.projects.length} active project{input.projects.length === 1 ? "" : "s"} · {money(m.totalBudget)} committed
          </p>
          <div className="desktop-only">
            <table className="pf-table">
              <thead>
                <tr><th>Project</th><th>Progress</th><th>Current gate</th><th>Risk / Issues</th></tr>
              </thead>
              <tbody>
                {input.projects.map((d) => {
                  const pct = projectProgressPct(d);
                  const next = nextMilestone(d);
                  const issues = input.openIssuesByProject.get(d.project.id) ?? 0;
                  return (
                    <tr>
                      <td><a className="pf-name" href={`/project/${d.project.id}`}>{d.project.name}</a></td>
                      <td>
                        <span className="pf-prog">
                          <span className="num">{pct}%</span>
                          <span className="tr"><span className="fl" style={`width:${pct}%`}></span></span>
                        </span>
                      </td>
                      <td className="pf-gate">
                        {next ? `M${next.milestone.seq} ${next.milestone.title.split(",")[0].slice(0, 26)}` : "All released"}
                      </td>
                      <td>
                        {issues > 0 ? (
                          <span className="pf-risk warn">{issues > 1 ? "High" : "Medium"} <i>{issues}</i></span>
                        ) : (
                          <span className="pf-risk">Low</span>
                        )}
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
              const nextApproval = input.nextReleases.find((r) => r.projectId === d.project.id);
              return (
                <div className="pf-card">
                  <a className="pf-name" href={`/project/${d.project.id}`}>{d.project.name}</a>
                  <div className="pf-kv"><span className="k">Progress</span><span className="v num">{pct}%</span>
                    <span className="tr"><span className="fl" style={`width:${pct}%`}></span></span></div>
                  <div className="pf-kv"><span className="k">Current gate</span><span className="v">{next ? `M${next.milestone.seq} ${next.milestone.title.split(",")[0].slice(0, 24)}` : "All released"}</span></div>
                  {nextApproval ? (
                    <div className="pf-kv"><span className="k">Next approval</span><span className="v num" style="font-weight:650">{money(nextApproval.amount)} <i className="mc-ico pend" style="vertical-align:-3px">{icons.clock()}</i></span></div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel aq-panel">
          <div className="panel-head"><h3>Action queue</h3><span className="right"><a href="/approvals">View all</a></span></div>
          {queueEmpty ? (
            <p className="aq-empty">Queue clear — nothing requires your action.</p>
          ) : (
            <div className="aq-list">
              {q.approvals > 0 ? (
                <a className="aq-row" href="/approvals">
                  <i className="aq-ico warn">{icons.approvals()}</i>
                  <span className="aq-body">
                    <span className="t">{q.approvals} approval{q.approvals === 1 ? "" : "s"} require your action</span>
                    <span className="s">{money(q.approvalsAmount)} across {q.approvalsProjects} project{q.approvalsProjects === 1 ? "" : "s"}</span>
                  </span>
                  <span className="aq-n">{q.approvals}</span>
                </a>
              ) : null}
              {q.exceptionsOpen > 0 ? (
                <a className="aq-row" href="/exceptions">
                  <i className={`aq-ico ${q.exceptionsHighCritical > 0 ? "bad" : "warn"}`}>{icons.shield()}</i>
                  <span className="aq-body">
                    <span className="t">{q.exceptionsOpen} open exception{q.exceptionsOpen === 1 ? "" : "s"}</span>
                    <span className="s">
                      {q.exceptionsHighCritical} high/critical · {q.exceptionsOverdue} overdue · {q.exceptionsAwaiting} awaiting response
                    </span>
                  </span>
                  <span className="aq-n">{q.exceptionsOpen}</span>
                </a>
              ) : null}
              {q.clarifications > 0 ? (
                <a className="aq-row" href="/compliance">
                  <i className="aq-ico warn">{icons.chat()}</i>
                  <span className="aq-body">
                    <span className="t">{q.clarifications} clarification{q.clarifications === 1 ? "" : "s"} open</span>
                    <span className="s">Awaiting field response or review</span>
                  </span>
                  <span className="aq-n">{q.clarifications}</span>
                </a>
              ) : null}
              {q.highIssues > 0 ? (
                <a className="aq-row" href="/issues">
                  <i className="aq-ico bad">{icons.alert()}</i>
                  <span className="aq-body">
                    <span className="t">{q.highIssues} high severity issue{q.highIssues === 1 ? "" : "s"}</span>
                    <span className="s">Require attention</span>
                  </span>
                  <span className="aq-n">{q.highIssues}</span>
                </a>
              ) : null}
              {q.evidenceReview > 0 ? (
                <a className="aq-row" href="/compliance">
                  <i className="aq-ico warn">{icons.shield()}</i>
                  <span className="aq-body">
                    <span className="t">{q.evidenceReview} evidence item{q.evidenceReview === 1 ? "" : "s"} need review</span>
                    <span className="s">Flagged by verification</span>
                  </span>
                  <span className="aq-n">{q.evidenceReview}</span>
                </a>
              ) : null}
            </div>
          )}
        </div>

        <div className="panel act-panel">
          <div className="panel-head"><h3>Recent governed activity</h3><span className="right"><a href="/ledger">View all activity →</a></span></div>
          <div className="act-list">
            {input.notifications.length === 0 ? (
              <p className="aq-empty">No recorded activity yet.</p>
            ) : (
              input.notifications.slice(0, 6).map((n) => {
                const meta = ACTIVITY_TITLES[n.type] ?? { title: n.type.replace(/_/g, " ").toLowerCase(), tone: "neutral" as const };
                return (
                  <div className="act-row" title={n.type.replace(/_/g, " ")}>
                    <i className={`act-ico ${meta.tone}`}>{meta.tone === "bad" ? icons.alert() : meta.tone === "warn" ? icons.clock() : icons.check()}</i>
                    <span className="act-body">
                      <span className="t">{meta.title}</span>
                      <span className="s">{n.message}</span>
                    </span>
                    <span className="act-when">{timeAgo(n.createdAt)}</span>
                  </div>
                );
              })
            )}
          </div>
          <div className="act-foot">
            <span className={`status ${input.chainValid ? "ok" : "bad"}`}>
              <span className="g">{input.chainValid ? "✓" : "!"}</span>
              Ledger {input.chainValid ? "chain intact" : "integrity alert"}
            </span>
            <span className="sub" style="font-size:10.5px">
              {input.teamsConfigured ? "Teams notifications configured" : "Demo notification mode"}
            </span>
          </div>
        </div>
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
            <h1>
              {project.name}
              <span className={`status ${project.status === "ACTIVE" ? "ok" : ""}`} style="vertical-align:4px;margin-left:10px"><span className="g">●</span>{project.status}</span>
            </h1>
            <div className="meta" style="margin-top:4px">{project.location}</div>
            <div className="meta" style="margin-top:2px">
              Project code: <b style="color:var(--ink-2);font-weight:600">{project.pilot?.code ?? project.id.toUpperCase()}</b>
              {" · "}Funder: <b style="color:var(--ink-2);font-weight:600">{data.org?.name ?? "—"}</b>
              {data.implementingOrg ? <> · Implementing: {data.implementingOrg.name}</> : null}
            </div>
            <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
              <IntegrityChip valid={input.chainValid} />
              {flagged > 0 ? <span className="status warn"><span className="g">!</span>{flagged} flagged</span> : null}
            </div>
          </div>
          <div className="ph-figs">
            <div className="ph-fig">
              <div className="v num">{money(data.summary.totalBudget)}</div>
              <div className="l">Controlled amount</div>
            </div>
            <div className="ph-fig">
              <div className="v amber num">{money(data.summary.held)}</div>
              <div className="l">Held</div>
            </div>
            <div className="ph-fig">
              <div className="v green num">{money(data.summary.released)} <span style="font-size:11px;color:var(--ink-4);font-weight:500">{pct}%</span></div>
              <div className="l">Released</div>
            </div>
            <div className="ph-fig">
              <div className="v" style="font-size:14px;line-height:1.3;padding-top:3px">
                {front ? `M${front.milestone.seq} ${front.milestone.title.split(",")[0].slice(0, 22)}` : "All released"}
              </div>
              <div className="l">Current milestone</div>
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
        <a href={`/project/${project.id}/budget`}>Budget &amp; Progress</a>
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
  clarifications: ClarificationRequest[];
  drafts: EvidenceDraft[];
  canFieldOps: boolean;
  gates: MilestoneGates;
  canReportCompletion: boolean;
  canDetermineInspection: boolean;
  canRecordPermits: boolean;
  linkedPermits: Array<{
    link: PermitMilestoneLink;
    permit: Permit;
    effectiveStatus: string;
    sources: OfficialSourceRecord[];
  }>;
  projectPermits: Permit[];
  inspectionHistory: JurisdictionalInspection[];
  officialSourceCounts: Map<string, number>;
  permitMethodology: string;
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

      {(() => {
        const g = input.gates;
        const fmtTs = (iso: string | null) => (iso ? fmtDate(iso) : null);
        const userNameOf = (id: string | null) => (id ? input.users.get(id)?.name ?? id : null);
        const chip = (tone: "ok" | "warn" | "bad" | "neutral", label: string) => (
          <span className={`status ${tone === "neutral" ? "" : tone}`}>
            <span className="g">{tone === "ok" ? "✓" : tone === "bad" ? "✕" : "●"}</span>
            {label}
          </span>
        );
        const gateRow = (title: string, state: unknown, sub: unknown) => (
          <div className="gate-row" style="display:grid;grid-template-columns:190px minmax(0,1fr);gap:10px;padding:9px 0;border-top:1px solid var(--line);align-items:baseline">
            <span style="font:600 10.5px/1.3 var(--sans,inherit);letter-spacing:.7px;color:var(--ink-3);text-transform:uppercase">{title}</span>
            <span style="font-size:12.5px;min-width:0;overflow-wrap:anywhere">
              {state}
              {sub ? <span className="sub" style="display:block;font-size:11px;margin-top:2px">{sub}</span> : null}
            </span>
          </div>
        );
        const contractorTone =
          g.contractor.status === "REPORTED_COMPLETE" ? "ok" : g.contractor.status === "WITHDRAWN" ? "warn" : "neutral";
        const evTone =
          g.evidenceReview.status === "VERIFIED" ? "ok" : g.evidenceReview.status === "REJECTED" ? "bad"
            : g.evidenceReview.status === "NOT_SUBMITTED" ? "neutral" : "warn";
        const reqTone = g.requirementValue === "REQUIRED" ? "warn" : g.requirementValue === "NOT_REQUIRED" ? "ok" : "neutral";
        const inspTone =
          g.inspectionGate === "PASSED" || g.inspectionGate === "NOT_APPLICABLE" ? "ok"
            : ["FAILED", "EXPIRED", "CORRECTIONS_REQUIRED"].includes(g.inspectionGate) ? "bad"
              : "warn";
        const eligTone =
          g.eligibility.result === "RELEASED" || g.eligibility.result === "READY_FOR_GOVERNANCE" ? "ok"
            : g.eligibility.result === "BLOCKED" ? "bad"
              : g.eligibility.result === "ELIGIBLE_FOR_DRAW_REVIEW" ? "warn" : "neutral";
        const blocking = g.eligibility.reasons.filter((r) => r.blocking);
        return (
          <div className="panel panel-pad" style="margin-top:12px">
            <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
              <h3 style="margin:0;font-size:13px">Completion gates</h3>
              <span className="sub" style="font-size:11px">
                Photographic completion is NOT legal or contractual completion — each gate is a separate authoritative record.
              </span>
            </div>
            {gateRow(
              "1 · Contractor completion",
              chip(contractorTone as never, g.contractor.status.replace(/_/g, " ")),
              g.contractor.reportedAt
                ? `${fmtTs(g.contractor.reportedAt)} · ${userNameOf(g.contractor.reportedByUserId)}${g.contractor.notes ? ` — ${g.contractor.notes}` : ""} · a contractor representation, not verification`
                : "The contractor has not reported this work complete."
            )}
            {gateRow(
              "2 · OBV evidence review",
              chip(evTone as never, g.evidenceReview.status.replace(/_/g, " ")),
              `${g.evidenceReview.evidenceCount} evidence item(s)${g.evidenceReview.policyVersion ? ` · policy v${g.evidenceReview.policyVersion}` : ""} · satisfies the OBV evidence policy only — not a jurisdictional inspection`
            )}
            {gateRow(
              "3 · Jurisdictional inspection requirement",
              chip(reqTone as never, g.requirementValue === "UNKNOWN" ? "UNKNOWN — NOT DETERMINED" : g.requirementValue.replace(/_/g, " ")),
              g.requirement
                ? `${g.requirement.inspectionType ?? ""}${g.requirement.jurisdiction ? ` · ${g.requirement.jurisdiction}` : ""} — basis: ${g.requirement.requirementBasis} (determined by ${userNameOf(g.requirement.determinedBy)}, config v${g.requirement.configurationVersion})${g.requirement.permitRequired ? ` · permit required${g.requirement.requiredPermitType ? ` (${g.requirement.requiredPermitType})` : ""}` : ""}${g.requirement.officialSourceRequired ? " · official source required before PASSED" : ""}${g.requirement.codeBasisRequired ? " · code basis required before governance" : ""}${g.requirement.permitMustBeActiveBeforeGovernance ? " · permit must be active before governance" : ""}`
                : "No attributable determination on record. UNKNOWN never behaves as NOT REQUIRED."
            )}
            {gateRow(
              "4 · Inspection schedule",
              g.requirementValue === "NOT_REQUIRED"
                ? chip("ok", "NOT APPLICABLE")
                : g.inspection?.scheduledAt
                  ? chip(g.inspection.status === "SCHEDULED" ? "warn" : "ok", `SCHEDULED ${fmtTs(g.inspection.scheduledAt)}`)
                  : chip("neutral", g.requirementValue === "REQUIRED" ? "NOT SCHEDULED" : "—"),
              g.inspection?.issuingAuthority ?? null
            )}
            {gateRow(
              "5 · Inspection result",
              g.requirementValue === "NOT_REQUIRED"
                ? chip("ok", "NOT APPLICABLE")
                : g.inspectionGate === "PASSED"
                  ? chip("ok", "INSPECTION PASSED")
                  : g.inspectionGate === "FAILED"
                    ? chip("bad", "INSPECTION FAILED")
                    : chip("neutral", g.inspectionGate === "COMPLETED_PENDING_RESULT" ? "COMPLETED — RESULT PENDING" : "PENDING"),
              g.inspection?.result
                ? `${g.inspection.result} recorded ${fmtTs(g.inspection.resultRecordedAt)} by ${userNameOf(g.inspection.reviewedByUserId)}${g.inspection.governmentInspectorName ? ` · government inspector: ${g.inspection.governmentInspectorName}` : ""}${g.inspection.inspectionReference ? ` · ref ${g.inspection.inspectionReference}` : ""} — a passed inspection authorizes nothing by itself`
                : null
            )}
            {gateRow(
              "6 · Draw eligibility",
              chip(eligTone as never, g.eligibility.result.replace(/_/g, " ")),
              blocking.length
                ? `Blocking: ${blocking.map((r) => `${r.detail} [${r.code}]`).join(" ")}`
                : g.eligibility.reasons.length
                  ? g.eligibility.reasons.map((r) => `${r.detail} [${r.code}]`).join(" ")
                  : null
            )}

            <div style="display:flex;gap:14px;margin-top:12px;flex-wrap:wrap;align-items:flex-end">
              {input.canReportCompletion && g.contractor.status !== "REPORTED_COMPLETE" ? (
                <form method="POST" action={`/api/milestones/${milestone.id}/contractor-completion`} style="display:flex;gap:6px;align-items:flex-end;margin:0;flex-wrap:wrap">
                  <input type="hidden" name="status" value="REPORTED_COMPLETE" />
                  <input name="notes" placeholder="Completion notes (optional)" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;min-width:200px" />
                  <button className="btn sm" type="submit">Report work complete (contractor)</button>
                </form>
              ) : null}
              {input.canReportCompletion && g.contractor.status === "REPORTED_COMPLETE" ? (
                <form method="POST" action={`/api/milestones/${milestone.id}/contractor-completion`} style="margin:0">
                  <input type="hidden" name="status" value="WITHDRAWN" />
                  <button className="btn ghost sm" type="submit">Withdraw completion report</button>
                </form>
              ) : null}
              {input.canDetermineInspection && g.requirementValue === "UNKNOWN" ? (
                <form method="POST" action={`/api/milestones/${milestone.id}/inspection-requirement`} style="display:flex;gap:6px;align-items:flex-end;margin:0;flex-wrap:wrap">
                  <select name="requirement" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px">
                    <option value="REQUIRED">REQUIRED</option>
                    <option value="NOT_REQUIRED">NOT_REQUIRED</option>
                  </select>
                  <input name="inspectionType" placeholder="Inspection type" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px" />
                  <input name="jurisdiction" placeholder="Jurisdiction" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px" />
                  <input name="requirementBasis" placeholder="Basis (required)" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;min-width:180px" />
                  <button className="btn secondary sm" type="submit">Record determination</button>
                </form>
              ) : null}
              {g.requirementValue === "REQUIRED" && !g.inspection && input.nav.user?.role !== "FIELD" ? (
                <form method="POST" action={`/api/milestones/${milestone.id}/inspections`} style="display:flex;gap:6px;align-items:flex-end;margin:0;flex-wrap:wrap">
                  <input type="datetime-local" name="scheduledAtLocal" className="insp-sched" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px" />
                  <button className="btn secondary sm" type="submit">Schedule inspection</button>
                </form>
              ) : null}
              {input.nav.user?.role !== "FIELD" && g.inspection && ["FAILED", "CORRECTIONS_REQUIRED"].includes(g.inspection.status) && !g.inspection.supersededByInspectionId ? (
                <form method="POST" action={`/api/inspections/${g.inspection.id}/reinspection`} style="display:flex;gap:6px;align-items:flex-end;margin:0;flex-wrap:wrap">
                  <input type="datetime-local" name="scheduledAtLocal" className="insp-sched" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px" />
                  <button className="btn secondary sm" type="submit">Create reinspection (prior result preserved)</button>
                </form>
              ) : null}
              {input.canDetermineInspection && g.inspection && !["PASSED", "FAILED", "CORRECTIONS_REQUIRED", "CANCELLED"].includes(g.inspection.status) ? (
                <form method="POST" action={`/api/inspections/${g.inspection.id}/result`} style="display:flex;gap:6px;align-items:flex-end;margin:0;flex-wrap:wrap">
                  <select name="result" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px">
                    <option value="PASSED">PASSED</option>
                    <option value="FAILED">FAILED</option>
                    <option value="CORRECTIONS_REQUIRED">CORRECTIONS REQUIRED</option>
                  </select>
                  <input name="governmentInspectorName" placeholder="Government inspector (name)" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px" />
                  <input name="inspectionReference" placeholder="Reference #" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;max-width:120px" />
                  <input name="correctionNoticeReference" placeholder="Correction notice #" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;max-width:170px" />
                  <input name="correctionSummary" placeholder="Correction summary (if corrections)" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;min-width:180px" />
                  <button className="btn sm" type="submit">Record reviewed result</button>
                </form>
              ) : null}
            </div>
            {raw(`<script>
              document.querySelectorAll('input.insp-sched').forEach(function (inp) {
                inp.form && inp.form.addEventListener('submit', function () {
                  if (inp.value) {
                    var hidden = document.createElement('input');
                    hidden.type = 'hidden'; hidden.name = 'scheduledAt';
                    hidden.value = new Date(inp.value).toISOString();
                    inp.form.appendChild(hidden);
                  }
                });
              });
            </script>`)}
          </div>
        );
      })()}

      {/* ---- Permit & Code Basis (Part 9A) ---- */}
      <div className="panel" style="margin-top:12px">
        <div className="panel-head">
          <h3>Permit &amp; code basis</h3>
          <span className="right"><a href={`/project/${project.id}/permits`}>Permit register →</a></span>
        </div>
        {input.linkedPermits.length === 0 ? (
          <p className="ci-empty" style="padding:12px 16px;margin:0;font-size:12px;color:var(--muted)">
            No permit is linked to this milestone.
            {input.gates.requirement?.permitRequired
              ? " A permit is REQUIRED by configuration — link or record one."
              : " Where no permit regime applies, the inspection requirement records NOT_REQUIRED with an attributable basis."}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="intg-table">
              <thead>
                <tr><th>Permit</th><th>Type</th><th>Authority</th><th>Status</th><th>Issued / expires</th><th>Applicable code basis</th><th>Official record</th></tr>
              </thead>
              <tbody>
                {input.linkedPermits.map(({ permit, effectiveStatus }) => (
                  <tr>
                    <td style="font-weight:650">{permit.permitNumber}
                      <span className="sub" style="display:block;font-size:10.5px">config v{permit.configurationVersion}{permit.legacyReference ? ` · legacy ref: ${permit.legacyReference}` : ""}</span>
                    </td>
                    <td>{permit.permitType}</td>
                    <td>{permit.issuingAuthority ?? "—"}{permit.jurisdiction ? ` · ${permit.jurisdiction}` : ""}</td>
                    <td>
                      <span className={`sync-tag ${effectiveStatus === "ACTIVE" || effectiveStatus === "ISSUED" ? "ok" : ["EXPIRED", "REVOKED", "SUSPENDED"].includes(effectiveStatus) ? "bad" : "warn"}`} style="margin-left:0">{effectiveStatus}</span>
                      {effectiveStatus !== permit.status ? <span className="sub" style="display:block;font-size:10px">recorded: {permit.status}</span> : null}
                    </td>
                    <td className="mono" style="font-size:11px">{permit.issuedAt?.slice(0, 10) ?? "—"} / {permit.expiresAt?.slice(0, 10) ?? "—"}</td>
                    <td style="font-size:12px">
                      {permit.applicableCodeEdition
                        ? <>{permit.applicableCodeEdition}{permit.codeEffectiveDate ? ` (effective ${permit.codeEffectiveDate.slice(0, 10)})` : ""}<span className="sub" style="display:block;font-size:10.5px">Applicable code basis recorded for this permit: {permit.codeBasis}</span></>
                        : "NOT RECORDED"}
                    </td>
                    <td style="font-size:11.5px">{permit.officialRecordNumber ?? permit.officialRecordUrl ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {input.inspectionHistory.some((i) => i.permitId && !i.permitRefId) ? (
          <p className="sub" style="padding:0 16px 10px;margin:0;font-size:11px;color:#8a5a10">
            Legacy permit reference preserved from earlier inspection records — no Permit record was invented for it.
          </p>
        ) : null}
        {input.canRecordPermits && input.projectPermits.length > input.linkedPermits.length ? (
          <form method="POST" action="" className="pm-linkform" style="display:flex;gap:6px;padding:10px 16px;border-top:1px solid var(--line);flex-wrap:wrap;align-items:flex-end"
            onsubmit={`this.action='/api/permits/'+this.permitId.value+'/links';`}>
            <input type="hidden" name="milestoneId" value={milestone.id} />
            <select name="permitId" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px">
              {input.projectPermits
                .filter((pp) => !input.linkedPermits.some((lp) => lp.permit.id === pp.id))
                .map((pp) => <option value={pp.id}>{pp.permitNumber} ({pp.permitType})</option>)}
            </select>
            <input name="scopeNote" placeholder="Scope note (optional)" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;min-width:160px" />
            <button className="btn secondary sm" type="submit">Link permit to this milestone</button>
          </form>
        ) : null}
        <p className="sub" style="padding:8px 16px 12px;margin:0;font-size:10.5px;color:var(--muted)">{input.permitMethodology}</p>
      </div>

      {/* ---- Inspection history (Part 9C): chronological, chain-aware ---- */}
      {input.inspectionHistory.length > 0 ? (
        <div className="panel" style="margin-top:12px">
          <div className="panel-head">
            <h3>Inspection history</h3>
            <span className="right">Original results are preserved — reinspections never rewrite them</span>
          </div>
          {input.inspectionHistory.map((insp, idx) => (
            <div style={`padding:10px 16px;${idx > 0 ? "border-top:1px solid var(--line);" : ""}`}>
              <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
                <b style="font-size:12.5px">{insp.inspectionType ?? "Jurisdictional inspection"}</b>
                {insp.reinspectionOfInspectionId ? (
                  <span className="sync-tag" style="margin-left:0">REINSPECTION of {insp.reinspectionOfInspectionId.slice(0, 8)}…</span>
                ) : null}
                <span className={`sync-tag ${insp.status === "PASSED" ? "ok" : ["FAILED", "CORRECTIONS_REQUIRED"].includes(insp.status) ? "bad" : insp.status === "CANCELLED" ? "neutral" : "warn"}`} style="margin-left:0">{insp.status.replace(/_/g, " ")}</span>
                {insp.supersededByInspectionId ? (
                  <span className="sub" style="font-size:10.5px">superseded by reinspection {insp.supersededByInspectionId.slice(0, 8)}… (this record is historical)</span>
                ) : null}
              </div>
              <span className="sub" style="display:block;font-size:11px;margin-top:3px">
                {insp.scheduledAt ? `Scheduled ${fmtDate(insp.scheduledAt).slice(0, 16)}` : "Unscheduled"}
                {insp.resultRecordedAt ? ` · result recorded ${fmtDate(insp.resultRecordedAt).slice(0, 16)} by ${input.users.get(insp.reviewedByUserId ?? "")?.name ?? "—"}` : ""}
                {insp.governmentInspectorName ? ` · government inspector: ${insp.governmentInspectorName}` : ""}
                {insp.inspectionReference ? ` · ref ${insp.inspectionReference}` : ""}
                {(input.officialSourceCounts.get(insp.id) ?? 0) > 0 ? ` · ${input.officialSourceCounts.get(insp.id)} official source record(s)` : ""}
              </span>
              {insp.correctionSummary ? (
                <span className="sub" style="display:block;font-size:11px;margin-top:2px;color:#8a5a10">
                  Corrections: {insp.correctionSummary}
                  {insp.correctionNoticeReference ? ` · notice ${insp.correctionNoticeReference}` : ""}
                  {insp.correctionDueAt ? ` · due ${insp.correctionDueAt.slice(0, 10)}` : ""}
                  {insp.correctionClearedAt ? ` · corrections cleared by passed reinspection ${fmtDate(insp.correctionClearedAt).slice(0, 16)}` : ""}
                  {" — an uploaded correction notice does not itself clear corrections"}
                </span>
              ) : null}
            </div>
          ))}
          {input.canDetermineInspection && input.gates.inspection ? (
            <form method="POST" action="/api/official-sources" style="display:flex;gap:6px;padding:10px 16px;border-top:1px solid var(--line);flex-wrap:wrap;align-items:flex-end">
              <input type="hidden" name="projectId" value={project.id} />
              <input type="hidden" name="inspectionId" value={input.gates.inspection.id} />
              <select name="sourceType" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px">
                {["MANUAL_OFFICIAL_REFERENCE", "OFFICIAL_PORTAL_LOOKUP", "OFFICIAL_DOCUMENT", "INSPECTION_REPORT", "EMAIL_FROM_AUTHORITY"].map((t) => (
                  <option value={t}>{t.replace(/_/g, " ")}</option>
                ))}
              </select>
              <input name="officialSystemName" placeholder="Official system" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;max-width:150px" />
              <input name="officialRecordNumber" placeholder="Official record #" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;max-width:150px" />
              <input name="officialStatusText" placeholder="Official status text (verbatim)" style="font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;min-width:180px" />
              <button className="btn ghost sm" type="submit">Record official source (never a result)</button>
            </form>
          ) : null}
        </div>
      ) : null}

      {input.drafts.length > 0 ? (
        <div className="panel" style="margin-top:12px">
          <div className="panel-head">
            <h3>Evidence drafts</h3>
            <span className="right">Promoted communication media — NOT evidence until submitted and verified</span>
          </div>
          {input.drafts.map((d, i) => (
            <div className="draft-row" style={i > 0 ? "border-top:1px solid var(--line)" : ""}>
              <img src={d.mediaPath} alt="Draft media" />
              <span className="d-meta">
                <span className={`sync-tag ${d.status === "DRAFT" ? "warn" : d.status === "SUBMITTED" ? "ok" : "neutral"}`} style="margin-left:0">{d.status}</span>
                <span className="s">Source: {d.sourceIdentity} · {d.sourceProvider === "WHATSAPP" ? "WhatsApp communication" : d.sourceProvider} · {fmtDate(d.sourceTimestamp)}</span>
                <span className="s">
                  {d.latitude !== null
                    ? `Associated communication location: ${d.latitude.toFixed(4)}, ${d.longitude!.toFixed(4)}`
                    : "MISSING LOCATION — geofence will route to review"}
                  {" · no original capture metadata"}
                </span>
              </span>
              {d.status === "DRAFT" ? (
                <form method="POST" action={`/api/evidence-drafts/${d.id}/submit`} style="margin:0">
                  <button className="btn sm" type="submit" data-busy-label="Submitting…">Submit for Verification</button>
                </form>
              ) : d.evidenceItemId ? (
                <span className="sub" style="font-size:11px">submitted {d.submittedAt ? fmtDate(d.submittedAt) : ""}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {(input.clarifications.length > 0 || input.canFieldOps) ? (
        <div className="panel" style="margin-top:12px">
          <div className="panel-head">
            <h3>Clarification requests</h3>
            <span className="right">A response never auto-accepts — reviewer decision required</span>
          </div>
          {input.clarifications.map((c, i) => (
            <div className="clar-row" style={i > 0 ? "border-top:1px solid var(--line)" : ""}>
              <span className="c-body">
                <span className={`sync-tag ${c.status === "ACCEPTED" ? "ok" : c.status === "CLOSED" ? "neutral" : "warn"}`} style="margin-left:0">{c.status}</span>
                <span className="q">“{c.question}”</span>
                <span className="s">
                  Response required: {c.responseType.replace(/_/g, " ")}
                  {c.dueAt ? ` · due ${c.dueAt.slice(0, 10)}` : ""}
                  {c.assignedToUserId ? ` · assigned to ${input.users.get(c.assignedToUserId)?.name}` : ""}
                  {c.responseMessageId ? " · response received in thread" : ""}
                </span>
              </span>
              {input.canFieldOps && ["RESPONDED", "OPEN", "REOPENED"].includes(c.status) ? (
                <form method="POST" action={`/api/clarifications/${c.id}/status`} style="display:flex;gap:6px;margin:0;align-items:center;flex-wrap:wrap">
                  <select name="status" aria-label="Clarification decision">
                    {c.status === "RESPONDED" ? (
                      <>
                        <option value="ACCEPTED">Accept</option>
                        <option value="REOPENED">Reopen</option>
                        <option value="CLOSED">Close</option>
                      </>
                    ) : (
                      <option value="CLOSED">Close</option>
                    )}
                  </select>
                  <button className="btn ghost sm" type="submit">Apply</button>
                </form>
              ) : null}
            </div>
          ))}
          {input.canFieldOps ? (
            <form method="POST" action="/api/clarifications" className="fo-form" style="padding:12px 16px;border-top:1px solid var(--line)">
              <input type="hidden" name="milestoneId" value={milestone.id} />
              <div className="fo-row">
                <label style="flex:2">Question
                  <input name="question" required placeholder="e.g. Please attach the compaction test certificate" />
                </label>
                <label>Response type
                  <select name="responseType">
                    {["TEXT","PHOTO","DOCUMENT","LOCATION","SITE_REVISIT"].map((t) => (
                      <option value={t}>{t.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </label>
                <label>Due
                  <input name="dueAt" type="date" />
                </label>
              </div>
              <button className="btn secondary sm" type="submit" style="align-self:flex-start">Request Clarification</button>
            </form>
          ) : null}
        </div>
      ) : null}

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
  /** RELEASED virtual-account event timestamp (presentation only). */
  releasedAt: string | null;
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
      <div className="page-wrap">
      <PageHeader
        title="Approvals"
        sub="Release governance — every required role must approve verified evidence before a tranche becomes release-eligible."
      >
        <div className="ap-head-actions">
          <div style="text-align:right">
            <div className="t-display num" style="font-size:21px">{money(atStake)}</div>
            <div className="t-meta">{pending.length} request{pending.length === 1 ? "" : "s"} · held pending governance</div>
          </div>
          <a
            className="btn secondary sm"
            href="/approvals/export.csv"
            title="Download the approval register (read-only CSV)"
          >
            {icons.download(14)} Export approvals
          </a>
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
            <div className="panel ap-card">
              {/* ---- header: identity + held amount + n-of-m ---- */}
              <div className="ap-head">
                <span className="ap-badge" aria-hidden="true">{icons.clock(16)}</span>
                <div className="ap-id">
                  <span className="ap-eyebrow">Pending approval</span>
                  <h3 className="ap-title">
                    {item.project.name} · M{item.milestone.seq} · {item.milestone.title}
                  </h3>
                  <div className="ap-amount-row">
                    <span className="ap-amount">
                      <span className="l">Held amount</span>
                      <span className="v num">{money(item.milestone.trancheAmount)}</span>
                    </span>
                    <span className="chip warn">HELD — {money(item.milestone.trancheAmount)} · release requires governance</span>
                    {b?.verification ? <VerdictChip verdict={b.verification.verdict} /> : null}
                  </div>
                </div>
                <div className="ap-progress">
                  <span className="np"><b>{approved} OF {item.approval.requiredRoles.length}</b> approvals recorded</span>
                  {missing.length > 0 ? (
                    <span className="await">Awaiting: <b>{missing.map(roleLabel).join(", ")}</b></span>
                  ) : null}
                  <span className="sub">Submitted {fmtDate(item.approval.createdAt).slice(0, 16)}</span>
                </div>
              </div>

              {/* ---- the three numbered decision columns ---- */}
              <div className="approval-review ap-cols">
                <div className="ap-col">
                  <div className="ap-col-h"><span className="n">1.</span> Governance (required approvals)</div>
                  <ApprovalProgress approval={item.approval} records={item.records} users={input.users} hideSummary={true} />
                  <div className="ap-note">
                    {icons.alert(13)} All required roles must approve to make this milestone release-eligible.
                  </div>
                </div>

                <div className="ap-col">
                  <div className="ap-col-h"><span className="n">2.</span> Evidence basis</div>
                  {b ? (
                    <>
                      <div className="approval-photo">
                        <img src={b.evidence.photoPath} alt="Field evidence photo" />
                      </div>
                      <div className="evidence-cap">
                        Field evidence — M{item.milestone.seq} · {item.milestone.title}
                      </div>
                      <div style="margin:6px 0 8px">
                        <EvidenceStatusChips verification={b.verification} isDemoFallback={b.evidence.isDemoFallback} />
                      </div>
                      <div className="photo-meta">
                        <div className="row"><span className="k">Captured by</span><span className="v">{b.submittedBy?.name ?? "—"}</span></div>
                        <div className="row"><span className="k">Captured on</span><span className="v mono">{fmtDate(b.evidence.capturedAt)}</span></div>
                        <div className="row"><span className="k">GPS location</span><span className="v mono">{fmtGps(b.evidence.latitude, b.evidence.longitude)}</span></div>
                        <div className="row"><span className="k">Device</span><span className="v">{b.evidence.deviceMetadata.platform} · {b.evidence.deviceMetadata.screen}</span></div>
                        <div className="row"><span className="k">Capture mode</span><span className="v">{b.evidence.isDemoFallback ? "Demo fallback" : "Live capture"}</span></div>
                      </div>
                    </>
                  ) : (
                    <div className="note">Evidence record unavailable.</div>
                  )}
                </div>

                <div className="ap-col">
                  <div className="ap-col-h"><span className="n">3.</span> Verification summary</div>
                  <div className="ap-req">
                    <span className="k">Requirement</span>
                    <span className="v">{item.milestone.requirement}</span>
                  </div>
                  {b?.verification ? (
                    <>
                      <div className="ap-sub-h">Deterministic verification checks</div>
                      <EvidenceChecks verification={b.verification} />
                      <div className="ap-conf">
                        <span className="k">Overall confidence</span>
                        <span className="bar"><span className="fl" style={`width:${Math.round(b.verification.confidence * 100)}%`}></span></span>
                        <span className="v num">{b.verification.confidence.toFixed(2)}</span>
                      </div>
                      <div className="ap-proof-sub">
                        Visual assessment: {b.verification.source === "LIVE_AI" ? "live AI model" : "deterministic demo mock"} ({b.verification.source}) · location &amp; metadata checks: deterministic
                      </div>
                    </>
                  ) : null}
                  {b ? (
                    <div className="ap-proof">
                      <span className="k">Proof integrity (SHA-256)</span>
                      <span className="v mono" title={b.evidence.hash}>
                        {b.evidence.hash.slice(0, 10)}…{b.evidence.hash.slice(-24)}
                      </span>
                      <button
                        className="ap-copy"
                        type="button"
                        title="Copy full evidence hash"
                        data-hash={b.evidence.hash}
                        onclick="navigator.clipboard&&navigator.clipboard.writeText(this.dataset.hash)"
                      >
                        {icons.file(12)}
                      </button>
                      {b.ledgerEntry ? (
                        <span className="sub" style="display:block;margin-top:3px">Evidence Ledger entry #{b.ledgerEntry.seq} · chain-linked</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              {/* ---- decision footer (the only actions on the card) ---- */}
              <div className="ap-footer">
                {item.canDecide ? (
                  <>
                    <p className="decision-note">
                      Approving records your sign-off. The {money(item.milestone.trancheAmount)} tranche
                      releases only when all required roles have approved.
                    </p>
                    <div className="decision-actions">
                      <form className="f-approve" method="POST" action={`/api/approvals/${item.approval.id}/decision`} style="margin:0">
                        <input type="hidden" name="decision" value="APPROVED" />
                        <button className="btn approve" type="submit">{icons.check(14)} Approve release eligibility</button>
                      </form>
                      <form className="f-reject" method="POST" action={`/api/approvals/${item.approval.id}/decision`} style="margin:0">
                        <input type="hidden" name="decision" value="REJECTED" />
                        <button className="btn secondary" type="submit">{icons.refresh(14)} Return for review</button>
                      </form>
                    </div>
                  </>
                ) : item.alreadyDecided ? (
                  <div className="banner info" style="margin:0;flex:1">Your decision is recorded. Awaiting the remaining role(s).</div>
                ) : (
                  <div className="banner info" style="margin:0;flex:1">
                    Sign in as one of the required roles to decide. Your current role is not part of this approval.
                  </div>
                )}
              </div>

              {/* ---- full governance record, collapsed by default ---- */}
              <details className="ap-audit">
                <summary>Approval audit trail</summary>
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
              </details>
            </div>
          );
        })
      )}

      {resolved.length > 0 ? (
        <>
          <h2 className="section" style="display:inline-flex;align-items:center;gap:8px">
            <span className="res-h-ic">{icons.check(14)}</span>Resolved approvals
          </h2>
          <div className="res-list">
            {resolved.map((item) => {
              const ok = item.approval.status === "APPROVED";
              return (
                <div className={`panel res-row ${ok ? "ok" : "bad"}`}>
                  <span className={`res-ic ${ok ? "ok" : "bad"}`}>{ok ? icons.check(14) : icons.x(14)}</span>
                  <span className="res-id">
                    <b>M{item.milestone.seq} · {item.milestone.title}</b>
                    <span className="sub">{item.project.name}</span>
                  </span>
                  <span className="res-cell">
                    <span className="l">Amount released</span>
                    <span className="v num">{ok && item.releasedAt ? money(item.milestone.trancheAmount) : "—"}</span>
                  </span>
                  <span className="res-cell">
                    <span className="l">Status</span>
                    <span className={`chip ${ok ? "ok" : "bad"}`}>{ok ? "APPROVED & RELEASED" : "REJECTED — RETURNED"}</span>
                  </span>
                  <span className="res-cell">
                    <span className="l">{ok ? "Released on" : "Decided on"}</span>
                    <span className="v mono">{fmtDate(item.releasedAt ?? item.approval.createdAt).slice(0, 16)}</span>
                  </span>
                  <a className="btn ghost sm res-view" href={`/milestone/${item.milestone.id}`}>View approval ↗</a>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      </div>
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
  auditPackages: AuditPackage[];
  canGenerateAudit: boolean;
  canIncludeMedia: boolean;
  apReady?: string | null;
  apError?: string | null;
}): string {
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  const apStatusChip = (pkg: AuditPackage) => {
    if (pkg.status === "READY" && pkg.integrityCritical > 0) {
      return <span className="status bad"><span className="g">✕</span>READY — CRITICAL INTEGRITY WARNING</span>;
    }
    if (pkg.status === "READY" && pkg.integrityState === "WARNINGS") {
      return <span className="status warn"><span className="g">!</span>READY — INTEGRITY WARNING</span>;
    }
    if (pkg.status === "READY") return <span className="status ok"><span className="g">✓</span>Ready</span>;
    if (pkg.status === "FAILED") return <span className="status bad"><span className="g">✕</span>Failed</span>;
    if (pkg.status === "SUPERSEDED") return <span className="status"><span className="g">○</span>Superseded</span>;
    return <span className="status warn"><span className="g">●</span>{pkg.status === "GENERATING" ? "Generating" : "Queued"}</span>;
  };
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

      <div className="panel">
        <div className="panel-head">
          <h3>Project Audit Package</h3>
          <span className="right">Structured auditor-ready ZIP · registers, manifest, integrity validation · generation and download are audited</span>
        </div>
        {input.apError ? (
          <div className="banner warn" style="margin:10px 18px 0">
            <b>Audit package generation failed.</b> {input.apError}
          </div>
        ) : null}
        {input.apReady ? (
          <div className="banner ok" style="margin:10px 18px 0">
            <b>Audit package ready.</b> Download it from the register below.
          </div>
        ) : null}
        <div style="padding:4px 18px 12px">
          {!input.canGenerateAudit ? (
            <p className="sub" style="padding:8px 0">
              Audit packages can be generated by funder representatives, project managers and
              compliance reviewers.
            </p>
          ) : (
            input.projects.map((p) => (
              <form
                method="POST"
                action={`/api/projects/${p.id}/audit-packages`}
                style="display:flex;align-items:center;gap:14px;padding:9px 0;flex-wrap:wrap;border-top:1px solid var(--line);margin:0"
              >
                <span style="font-weight:600;min-width:0;font-size:13px">{p.name}</span>
                <span style="margin-left:auto;display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:12px">
                  <label style="display:flex;align-items:center;gap:5px">
                    As of
                    <input type="datetime-local" name="asOfLocal" className="ap-asof" style="font-size:12px;padding:3px 6px;border:1px solid var(--line);border-radius:6px" />
                  </label>
                  <label style="display:flex;align-items:center;gap:5px">
                    <input type="checkbox" name="includeReports" value="true" checked />
                    Include reports
                  </label>
                  <label style="display:flex;align-items:center;gap:5px" title="Counts only — transcripts are never included">
                    <input type="checkbox" name="includeCommMetadata" value="true" />
                    Comm metadata summary
                  </label>
                  {input.canIncludeMedia ? (
                    <label style="display:flex;align-items:center;gap:5px" title="Raw evidence media copies, re-hashed against the recorded evidence hash. Funder rep / compliance reviewer only.">
                      <input type="checkbox" name="includeEvidenceMedia" value="true" />
                      Evidence media
                    </label>
                  ) : null}
                  <button className="btn sm" type="submit" data-busy-label="Generating…">Generate Audit Package</button>
                </span>
              </form>
            ))
          )}
          <p className="sub" style="padding:6px 0 0;font-size:11px">
            Blank as-of = now. Chat transcripts are never included; evidence media is referenced
            by hash, not copied. Regeneration creates a new package version — prior versions stay
            available as SUPERSEDED.
          </p>
        </div>
      </div>

      {input.auditPackages.length ? (
        <div className="panel">
          <div className="panel-head">
            <h3>Audit package register</h3>
            <span className="right">{input.auditPackages.length} package(s) · immutable once ready</span>
          </div>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Project</th>
                  <th>As of</th>
                  <th>Status</th>
                  <th>Integrity</th>
                  <th>Files</th>
                  <th>Requested by</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {input.auditPackages.map((pkg) => {
                  const project = projectById.get(pkg.projectId);
                  const by = input.users.get(pkg.requestedBy);
                  return (
                    <tr>
                      <td>
                        <span style="font-weight:600">v{pkg.packageVersion}</span>
                        <span className="mono" style="display:block;font-size:10px;color:var(--ink-4)">{pkg.id}</span>
                      </td>
                      <td style="font-size:12px">{project?.name ?? pkg.projectId}</td>
                      <td className="mono" style="font-size:11px">{fmtDate(pkg.asOfTimestamp)}</td>
                      <td>{apStatusChip(pkg)}</td>
                      <td style="font-size:11.5px">
                        {pkg.integrityState === "NOT_EVALUATED" ? "—" : pkg.integrityState === "CLEAN" ? (
                          <span className="status ok"><span className="g">✓</span>Clean</span>
                        ) : pkg.integrityCritical > 0 ? (
                          <span className="status bad"><span className="g">✕</span>{pkg.integrityCritical} critical</span>
                        ) : (
                          <span className="status warn"><span className="g">!</span>Warnings</span>
                        )}
                        <span className="sub" style="display:block;font-size:10px">
                          ledger {pkg.ledgerIntegrityState === "INTACT" ? "intact" : pkg.ledgerIntegrityState}
                        </span>
                      </td>
                      <td className="mono" style="font-size:11px">
                        {pkg.fileCount || "—"}
                        <span className="sub" style="display:block;font-size:10px">
                          {pkg.sizeBytes ? `${Math.max(1, Math.round(pkg.sizeBytes / 1024))} KB` : ""}
                        </span>
                      </td>
                      <td style="font-size:12px">{by?.name ?? pkg.requestedBy}</td>
                      <td style="white-space:nowrap">
                        {["READY", "SUPERSEDED"].includes(pkg.status) ? (
                          <a className="btn secondary sm" href={`/audit-packages/${pkg.id}/download`}>Download ZIP</a>
                        ) : pkg.status === "FAILED" ? (
                          <span className="sub">{pkg.failureCategory ?? ""}</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {raw(`<script>
        // Convert the local datetime picker to an ISO asOf field on submit.
        document.querySelectorAll('input.ap-asof').forEach(function (inp) {
          inp.form && inp.form.addEventListener('submit', function () {
            if (inp.value) {
              var hidden = document.createElement('input');
              hidden.type = 'hidden'; hidden.name = 'asOf';
              hidden.value = new Date(inp.value).toISOString();
              inp.form.appendChild(hidden);
            }
          });
        });
      </script>`)}

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
                          {icons.file(13)}{" "}
                          {r.reportType === "DRAW_VERIFICATION_PACKAGE"
                            ? "Draw Verification Package"
                            : r.reportType === "DRAW_REVIEW_SUMMARY"
                              ? "Draw Review Summary"
                              : "Verification & Fund Release"}
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

export function renderCompliance(input: {
  nav: NavContext;
  data: ComplianceData;
  users: Map<string, User>;
  fieldIssues: { open: number; critical: number; overdue: number };
}): string {
  const d = input.data;
  const fi = input.fieldIssues;
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

      <h2 className="section">Field issues</h2>
      <div className="panel">
        <div className="panel-head">
          <h3>Operational field issues</h3>
          <span className="right"><a href="/issues" style="color:var(--action);font-weight:600">Open register →</a></span>
        </div>
        <div className="issue-stats" style="border:0;margin:0">
          <span><b className="num">{fi.open}</b> Open</span>
          <span><b className="num" style={fi.critical ? "color:var(--bad)" : ""}>{fi.critical}</b> Critical</span>
          <span><b className="num" style={fi.overdue ? "color:var(--warn)" : ""}>{fi.overdue}</b> Overdue</span>
        </div>
        <p className="sub" style="padding:0 16px 12px;font-size:11.5px">
          Issues coordinate field response and inform reviewers. They never
          change financial state — release eligibility is controlled only by
          the formal approval workflow.
        </p>
      </div>

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

// ------------------------------------------------- OBV Intelligence

function sevChip(sev: "HIGH" | "MEDIUM" | "INFO" | "LOW"): VNode {
  const cls = sev === "HIGH" ? "bad" : sev === "MEDIUM" ? "warn" : "ok";
  return <span className={`int-sev ${cls}`}>{sev}</span>;
}

function attChip(level: "HIGH" | "MEDIUM" | "LOW"): VNode {
  const cls = level === "HIGH" ? "bad" : level === "MEDIUM" ? "warn" : "ok";
  return <span className={`int-sev ${cls}`}>{level}</span>;
}

function healthChip(state: "HEALTHY" | "WATCH" | "AT_RISK"): VNode {
  const cls = state === "AT_RISK" ? "bad" : state === "WATCH" ? "warn" : "ok";
  return <span className={`int-health ${cls}`}>{state.replace("_", " ")}</span>;
}

export function renderIntelligence(input: { nav: NavContext; data: IntelligenceData }): string {
  const d = input.data;
  const s = d.summary;
  const v = d.verification;
  const g = d.governance;
  const f = d.fieldRisk;
  const critical = d.signals.filter((x) => x.severity === "HIGH").length;
  const medium = d.signals.filter((x) => x.severity === "MEDIUM").length;
  const calm = critical === 0 && medium === 0;
  const trendMax = v.trend ? Math.max(...v.trend.map((t) => t.total)) : 0;
  const catMax = Math.max(1, ...f.byCategory.map((c) => c.open));

  const sumCard = (
    n: number,
    label: string,
    href: string,
    tone: "neutral" | "warn" | "bad",
    icon: VNode,
    subActive: string,
  ): VNode => (
    <a className={`int-stat ${n > 0 && tone !== "neutral" ? tone : ""}`} href={href}>
      <span className="is-ic">{icon}</span>
      <span className="is-body">
        <span className="is-n">{n}</span>
        <span className="is-l">{label}</span>
        <span className="is-s">{n > 0 ? subActive : "No items at this time"}</span>
      </span>
    </a>
  );

  return renderDocument(
    <AppShell title="OBV Intelligence" nav={input.nav} context="Operational intelligence">
      <div className="intel-wrap">
      <PageHeader
        title="OBV Intelligence"
        sub="Verification, governance and field-risk intelligence computed deterministically from recorded OBV data. Every figure traces to stored records — no generative scoring, no predictions."
      >
        <span className="int-mode" title="All signals derive from stored records via documented rules">
          DETERMINISTIC
        </span>
      </PageHeader>

      {/* ---- Section 1 · intelligence summary (uniform card row) ---- */}
      <div className="intel-sum">
        {sumCard(s.activeProjects, "Active projects", "/projects", "neutral", icons.projects(), "Monitored portfolio")}
        {sumCard(s.projectsNeedingAttention, "Needing attention", "#attention", "warn", icons.alert(15), "Require review")}
        {sumCard(s.highSeverityIssues, "High-severity issues", "/issues", "bad", icons.shield(), "Immediate action")}
        {sumCard(s.evidenceNeedsReview, "Evidence needs review", "/compliance", "warn", icons.camera(), "Awaiting decision")}
        {sumCard(s.pendingApprovals, "Pending approvals", "/approvals", "warn", icons.clock(15), "Awaiting roles")}
        {sumCard(s.openClarifications, "Open clarifications", "/compliance", "warn", icons.chat(15), "Never auto-accepts")}
        {sumCard(s.integrityAlerts, "Integrity alerts", "/ledger", "bad", icons.ledger(), "Chain findings")}
      </div>

      {calm ? (
        <div className="int-calm">
          <i>{icons.check()}</i>
          <span>
            <b>NO CRITICAL SIGNALS</b>
            <span className="s">
              All recorded verification and governance checks are currently within normal
              operating state. The intelligence below reflects the live records.
            </span>
          </span>
        </div>
      ) : null}

      {/* ---- Section 2 + 7 · signals and recommended actions ---- */}
      <div className="intel-main">
        <div className="panel int-signals">
          <div className="panel-head">
            <h3>Attention signals</h3>
            <span className="right int-counts">
              {critical > 0 ? <span className="int-sev bad">{critical} HIGH</span> : null}
              {medium > 0 ? <span className="int-sev warn">{medium} MEDIUM</span> : null}
              <span className="int-sev ok">{d.signals.length - critical - medium} INFO</span>
            </span>
          </div>
          {d.signals.length === 0 ? (
            <p className="aq-empty">No signals — no anomalous records exist right now.</p>
          ) : (
            <div className="sig-list">
              {d.signals.map((sig) => (
                <div className="sig-row">
                  <span className="sig-side">{sevChip(sig.severity)}</span>
                  <span className="sig-body">
                    <span className="sig-scope">
                      {sig.projectName}
                      {sig.milestoneLabel ? <i> · {sig.milestoneLabel}</i> : null}
                    </span>
                    <span className="sig-reason">{sig.reason}</span>
                    <span className="sig-meta">
                      {sig.age ? <span>age {sig.age}</span> : null}
                      <span className="rule" title="Deterministic rule id">{sig.rule}</span>
                    </span>
                  </span>
                  <a className="btn ghost sm sig-act" href={sig.actionHref}>{sig.actionLabel}</a>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel int-recs">
          <div className="panel-head"><h3>Recommended actions</h3></div>
          {d.recommendations.length === 0 ? (
            <p className="aq-empty">
              Nothing to recommend — no open issue, flagged evidence, pending governance or
              clarification records require intervention.
            </p>
          ) : (
            <div className="rec-list">
              {d.recommendations.map((r, i) => (
                <div className="rec-card">
                  <span className="rec-head">
                    <span className="rec-n">{i + 1}</span>
                    {sevChip(r.priority)}
                  </span>
                  <span className="rec-title">{r.title}</span>
                  <span className="rec-why"><b>Why:</b> {r.why}</span>
                  <span className="rec-src">Source: {r.sources.join(" · ")}</span>
                  <a className="btn sm rec-act" href={r.actionHref}>{r.actionLabel}</a>
                </div>
              ))}
            </div>
          )}
          <p className="rec-note">
            Recommendations are deterministic next actions derived from open records — not
            generated advice.
          </p>
        </div>
      </div>

      {/* ---- Section 3 + 4 · verification & governance intelligence ---- */}
      <div className="intel-tri">
        <div className="panel int-verif">
          <div className="panel-head"><h3>Verification outcomes</h3><span className="right"><a href="/compliance">Evidence review →</a></span></div>
          <div className="iv-stats">
            <span className="iv-cell"><span className="n">{v.total}</span><span className="l">Submissions</span></span>
            <span className="iv-cell ok"><span className="n">{v.verified}</span><span className="l">Verified</span></span>
            <span className="iv-cell warn"><span className="n">{v.needsReview}</span><span className="l">Needs review</span></span>
            <span className="iv-cell bad"><span className="n">{v.rejected}</span><span className="l">Rejected</span></span>
            <span className="iv-cell"><span className="n">{v.verificationRatePct === null ? "—" : `${v.verificationRatePct}%`}</span><span className="l">Verification rate</span></span>
            <span className="iv-cell"><span className="n">{v.avgConfidence === null ? "—" : v.avgConfidence.toFixed(2)}</span><span className="l">Avg confidence</span></span>
          </div>
          <div className="iv-cols">
            <div>
              <span className="iv-h">Most common review reasons</span>
              {v.reviewReasons.length === 0 ? (
                <span className="iv-empty">No failed checks recorded.</span>
              ) : (
                v.reviewReasons.map((r) => (
                  <span className="iv-row"><span>{r.reason}</span><b>{r.count}</b></span>
                ))
              )}
              <span className="iv-row"><span>Geofence exceptions</span><b>{v.geofenceExceptions}</b></span>
              <span className="iv-row"><span>Metadata / timestamp exceptions</span><b>{v.metadataExceptions}</b></span>
              <span className="iv-row"><span>DEMO FALLBACK evidence items</span><b>{v.demoFallbackEvidence}</b></span>
            </div>
            <div>
              <span className="iv-h">Assessment provenance</span>
              {v.provenance.map((p) => (
                <span className="iv-row"><span>{p.label} <i className="mono">({p.source})</i></span><b>{p.count}</b></span>
              ))}
              {v.trend ? (
                <div className="iv-trend">
                  <span className="iv-h">Monthly submissions</span>
                  {v.trend.map((t) => (
                    <span className="tr-row">
                      <span className="m">{t.month}</span>
                      <span className="bar"><span className="fl" style={`width:${Math.round((t.total / trendMax) * 100)}%`}></span></span>
                      <span className="c">{t.verified}/{t.total} verified</span>
                    </span>
                  ))}
                </div>
              ) : (
                <span className="iv-empty">Not enough dated records for a trend.</span>
              )}
            </div>
          </div>
          <div className="iv-recent">
            <span className="iv-h">Recent verifications</span>
            {v.recent.length === 0 ? (
              <span className="iv-empty">No verifications recorded yet.</span>
            ) : (
              v.recent.map((r) => (
                <a className="ivr-row" href={r.href}>
                  <VerdictChip verdict={r.verdict} />
                  <span className="t">{r.milestoneLabel} <i>· {r.projectName}</i></span>
                  <span className="c num">{r.confidence.toFixed(2)}</span>
                  <span className="w">{timeAgo(r.createdAt)}</span>
                </a>
              ))
            )}
          </div>
        </div>

        <div className="panel int-gov">
          <div className="panel-head"><h3>Governance intelligence</h3><span className="right"><a href="/approvals">Approvals →</a></span></div>
          <div className="iv-stats">
            <span className="iv-cell warn"><span className="n">{g.pending}</span><span className="l">Pending requests</span></span>
            <span className="iv-cell"><span className="n">{g.partiallyApproved}</span><span className="l">Partially approved</span></span>
            <span className="iv-cell"><span className="n">{g.avgApprovalHours === null ? "—" : g.avgApprovalHours >= 48 ? `${(g.avgApprovalHours / 24).toFixed(1)}d` : `${Math.round(g.avgApprovalHours)}h`}</span><span className="l">Avg approval time</span></span>
            <span className="iv-cell"><span className="n">{g.oldestPending ? g.oldestPending.age : "—"}</span><span className="l">Oldest pending</span></span>
          </div>
          <div className="gov-funds">
            <span className="gf-cell hold">
              <span className="l">Held pending governance</span>
              <span className="n">{money(g.fundsHeldPendingGovernance)}</span>
            </span>
            <span className="gf-cell">
              <span className="l">Total held</span>
              <span className="n">{money(g.totalHeld)}</span>
            </span>
            <span className="gf-cell rel">
              <span className="l">Released</span>
              <span className="n">{money(g.totalReleased)}</span>
            </span>
          </div>
          <span className="iv-h">Approvals awaiting role</span>
          {g.awaitingByRole.length === 0 ? (
            <span className="iv-empty">No role is currently blocking an approval.</span>
          ) : (
            g.awaitingByRole.map((r) => (
              <a className="iv-row link" href="/approvals">
                <span>{roleLabel(r.role)}</span>
                <b>{r.count} request{r.count === 1 ? "" : "s"} awaiting action</b>
              </a>
            ))
          )}
          {g.oldestPending ? (
            <a className="gov-oldest" href={g.oldestPending.href}>
              Oldest pending request: <b>{g.oldestPending.label}</b> · waiting {g.oldestPending.age}
            </a>
          ) : null}
        </div>

        {/* ---- field risk (third analytics column) ---- */}
        <div className="panel int-field">
          <div className="panel-head"><h3>Field issues &amp; clarifications</h3><span className="right"><a href="/issues">Issue register →</a></span></div>
          <div className="iv-stats">
            <span className="iv-cell"><span className="n">{f.openIssues}</span><span className="l">Open issues</span></span>
            <span className="iv-cell bad"><span className="n">{f.highCritical}</span><span className="l">High / critical</span></span>
            <span className="iv-cell warn"><span className="n">{f.overdue}</span><span className="l">Overdue</span></span>
            <span className="iv-cell"><span className="n">{f.awaitingFieldResponse}</span><span className="l">Awaiting field</span></span>
            <span className="iv-cell warn"><span className="n">{f.openClarifications}</span><span className="l">Open clarifications</span></span>
          </div>
          {f.oldestOpenIssue ? (
            <a className="gov-oldest" href={f.oldestOpenIssue.href}>
              Oldest unresolved issue: <b>{f.oldestOpenIssue.title}</b> · open {f.oldestOpenIssue.age}
            </a>
          ) : (
            <span className="iv-empty">No unresolved field issues.</span>
          )}
          <div style="margin-top:12px">
          <span className="iv-h">Open issues by category</span>
          {f.byCategory.length === 0 ? (
            <span className="iv-empty">No open issues to categorize.</span>
          ) : (
            f.byCategory.map((c) => (
              <span className="tr-row">
                <span className="m">{c.category}</span>
                <span className="bar"><span className="fl warn" style={`width:${Math.round((c.open / catMax) * 100)}%`}></span></span>
                <span className="c">{c.open}</span>
              </span>
            ))
          )}
          {f.bySeverity.length > 0 ? (
            <div style="margin-top:10px">
              <span className="iv-h">By severity</span>
              {f.bySeverity.map((sv) => (
                <span className="iv-row"><span>{sv.severity}</span><b>{sv.open}</b></span>
              ))}
            </div>
          ) : null}
          </div>
        </div>
      </div>

      {/* ---- Section 6 + 8 · project attention table ---- */}
      <div className="panel int-table-panel" id="attention">
        <div className="panel-head"><h3>Project attention</h3></div>
        <div className="desktop-only table-scroll">
          <table className="pf-table int-table">
            <thead>
              <tr>
                <th>Project</th><th>Progress</th><th>Current gate</th><th>Evidence</th>
                <th>Governance</th><th>Issues</th><th>Clarif.</th><th>Funds held</th><th>Attention</th><th>Health</th>
              </tr>
            </thead>
            <tbody>
              {d.projects.map((p) => (
                <tr>
                  <td>
                    <a className="pf-name" href={`/project/${p.projectId}`}>{p.name}</a>
                    {p.reasons.length > 0 ? (
                      <span className="int-reasons">{p.reasons.join(" · ")}</span>
                    ) : null}
                  </td>
                  <td>
                    <span className="pf-prog">
                      <span className="num">{p.progressPct}%</span>
                      <span className="tr"><span className="fl" style={`width:${p.progressPct}%`}></span></span>
                    </span>
                  </td>
                  <td className="pf-gate">{p.currentGate}</td>
                  <td>{p.evidenceState}</td>
                  <td className="num">{p.pendingGovernance}</td>
                  <td className="num">{p.openIssues}</td>
                  <td className="num">{p.openClarifications}</td>
                  <td className="num">{money(p.fundsHeld)}</td>
                  <td>{attChip(p.attention)}</td>
                  <td>{healthChip(p.health)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mobile-only">
          {d.projects.map((p) => (
            <div className="pf-card">
              <a className="pf-name" href={`/project/${p.projectId}`}>{p.name}</a>
              <div className="int-chips">{attChip(p.attention)} {healthChip(p.health)}</div>
              {p.reasons.length > 0 ? <span className="int-reasons">{p.reasons.join(" · ")}</span> : null}
              <div className="pf-kv"><span className="k">Progress</span><span className="v num">{p.progressPct}%</span>
                <span className="tr"><span className="fl" style={`width:${p.progressPct}%`}></span></span></div>
              <div className="pf-kv"><span className="k">Current gate</span><span className="v">{p.currentGate}</span></div>
              <div className="pf-kv"><span className="k">Evidence</span><span className="v">{p.evidenceState}</span></div>
              <div className="pf-kv"><span className="k">Governance / issues / clarif.</span><span className="v num">{p.pendingGovernance} · {p.openIssues} · {p.openClarifications}</span></div>
              <div className="pf-kv"><span className="k">Funds held</span><span className="v num" style="font-weight:650">{money(p.fundsHeld)}</span></div>
            </div>
          ))}
        </div>
      </div>

      <details className="int-rules">
        <summary>How attention levels are computed</summary>
        <ul>
          {ATTENTION_RULES.map((r) => (
            <li>{attChip(r.level)} {r.rule}</li>
          ))}
        </ul>
        <p>
          Project health mirrors attention: AT RISK = any HIGH factor, WATCH = any MEDIUM
          factor, HEALTHY = normal workflow. The exact factors for each project are listed in
          the table above.
        </p>
      </details>

      <p className="footer-note">
        Computed {fmtDate(d.generatedAt)} from stored evidence, verification, governance,
        field-issue, clarification and virtual-account records. The only AI-assisted input is
        the visual assessment inside verification, labeled under assessment provenance above.
      </p>
      </div>
      <script src="/js/poll.js" defer></script>
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
    { href: "/issues", label: "Field Issues", icon: icons.activity, desc: "Operational issues from field coordination" },
    { href: "/pilot", label: "Pilot Operations", icon: icons.activity, desc: "Pilot status across projects" },
    { href: "/setup", label: "Pilot Setup", icon: icons.projects, desc: "Customer onboarding & project configuration" },
    { href: "/insights", label: "OBV Intelligence", icon: icons.insights, desc: "Operational intelligence from recorded data" },
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
        <a className="btn secondary sm" href="/demo">Switch user</a>
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
        <link rel="stylesheet" href={STYLESHEET_HREF} />
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
              {user.title} · <a href="/demo" style="color:#96b0f5">switch</a>
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
          <link rel="stylesheet" href={STYLESHEET_HREF} />
        </head>
        <body>
          <div className="auth-wrap">
            <div className="auth-box" style="text-align:center;max-width:420px">
              <h1 className="t-title">{title}</h1>
              <p className="sub">{message}</p>
              <a className="btn" href="/demo" style="margin-top:10px">Go to demo sign-in</a>
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
      {/* Intelligence-console strip: project identity left, utilities right */}
      <div className="map-head">
        <span className="mh-id">
          <i className="mh-glyph" aria-hidden="true">{icons.map()}</i>
          <h1 className="mh-title">
            <span className="mh-proj" id="map-head-project">Project Map</span>
            <span className="mh-kicker">Project Map · spatial intelligence</span>
          </h1>
        </span>
        <span className="mh-utils">
          <a className="mh-btn" href="/projects" title="Project register" aria-label="Project register">{icons.projects()}</a>
          <a className="mh-btn" href="/overview" title="Exit map" aria-label="Exit map">×</a>
        </span>
      </div>
      <div className="map-summary" id="map-summary" aria-live="polite"></div>
      <div className="map-stage">
        <div className="map-overlay-top">
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
    <AppShell title="Project Map" nav={input.nav} context="Spatial intelligence">
      <div className="map-page">
        <MapShell />
      </div>
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
  if (m.messageType === "ISSUE_REFERENCE" && m.refId) {
    const issue = repoView.issue(m.refId);
    return (
      <span className="msg-ref">
        <span className="k">FIELD ISSUE</span>
        {issue ? <span className="s">{issue.category} · {issue.severity} · {issue.status.replace(/_/g, " ")}</span> : null}
        <a href={`/issue/${m.refId}`}>Open Issue</a>
      </span>
    );
  }
  if (m.messageType === "CLARIFICATION_REFERENCE" && m.refId) {
    const clar = repoView.clarification(m.refId);
    return (
      <span className="msg-ref">
        <span className="k">CLARIFICATION</span>
        {clar ? <span className="s">{clar.responseType.replace(/_/g, " ")} required · {clar.status}</span> : null}
        {clar ? <a href={`/milestone/${clar.milestoneId}`}>View milestone</a> : null}
      </span>
    );
  }
  if (m.messageType === "EXCEPTION_REFERENCE" && m.refId) {
    const exc = repoView.exception(m.refId);
    return (
      <span className="msg-ref">
        <span className="k">EXCEPTION</span>
        {exc ? (
          <span className="s">
            {exc.severity} {exc.category} · {exc.status.replace(/_/g, " ")}
          </span>
        ) : null}
        <a href={`/exception/${m.refId}`}>Open exception</a>
      </span>
    );
  }
  if (m.messageType === "DRAW_REFERENCE" && m.refId) {
    const draw = repoView.draw(m.refId);
    return (
      <span className="msg-ref">
        <span className="k">DRAW REQUEST</span>
        {draw ? (
          <span className="s">
            Draw #{draw.drawNumber} · {money(draw.requestedAmount)} · {draw.status.replace(/_/g, " ")}
          </span>
        ) : null}
        <a href={`/draw/${m.refId}`}>Open draw</a>
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
function bindingShortLabel(
  b: ExternalThreadBinding | null,
  configured: boolean,
  testMode = false
): string {
  if (!configured) return "Not configured";
  if (!b || b.status === "DISCONNECTED") return "Not connected";
  if (b.status === "PERMISSION_REQUIRED") return "Permissions required";
  if (b.status === "CONNECTING") return "Connecting";
  if (b.status === "DEGRADED") return "Degraded";
  return testMode ? "Test mode" : "Connected";
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
            <div>
              <h3>Threads</h3>
              <span className="sub">Project-linked coordination</span>
            </div>
            <a className="btn ghost sm" href="/communications/integrations">Integrations</a>
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
                    Microsoft Teams · {bindingShortLabel(selected.binding, input.teamsSyncConfigured, input.teamsTestMode)}
                  </span>
                  {input.canManageTeams && input.teamsSyncConfigured ? (
                    <button type="button" className="conv-manage" id="teams-manage">
                      {selected.binding && selected.binding.status !== "DISCONNECTED"
                        ? "Manage Teams Connection"
                        : "Connect to Teams"}
                    </button>
                  ) : null}
                </span>
              </span>
              <button type="button" className="btn ghost sm conv-ctx-toggle" id="ctx-toggle">Context</button>
            </div>
            <div className="conv-scroll" id="conv-scroll">
              {selected.messages.map((m) => {
                const sender = m.senderUserId ? input.users.get(m.senderUserId) : null;
                const isTeams = m.provider === "TEAMS";
                const isExternal = m.provider !== "OBV";
                const isOwn = m.senderUserId === input.currentUser.id;
                const canFieldOps = ["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(input.currentUser.role);
                return m.senderUserId || isExternal ? (
                  <div className="msg">
                    <span className="avatar" aria-hidden="true">{initials(m.senderDisplayName)}</span>
                    <span className="body">
                      <span className="who">
                        <b>{m.senderDisplayName}</b>
                        {sender ? <span className="role">{roleLabel(sender.role)}</span> : null}
                        {isTeams ? <span className="prov">via Microsoft Teams</span> : null}
                        {m.provider === "WHATSAPP" ? <span className="prov">via WhatsApp</span> : null}
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
                          {m.attachments.map((a, ai) => (
                            <span className="att-row">
                              {a.kind === "AUDIO" && a.url ? (
                                <audio controls preload="none" src={a.url} style="height:32px;max-width:260px"></audio>
                              ) : a.kind === "IMAGE" && a.url ? (
                                <a href={a.url} target="_blank" rel="noopener noreferrer">
                                  <img src={a.url} alt={a.name} style="max-width:180px;max-height:120px;object-fit:cover;border:1px solid var(--line)" />
                                </a>
                              ) : a.url ? (
                                <a href={a.url} target="_blank" rel="noopener noreferrer">📎 {a.name}</a>
                              ) : (
                                <span>📎 {a.name}</span>
                              )}
                              {a.kind === "IMAGE" && a.url && (canFieldOps || input.currentUser.role === "FIELD") ? (
                                <a className="att-promote" href={`/evidence-drafts/new?messageId=${m.id}&attachment=${ai}`}>
                                  Promote to Evidence Draft
                                </a>
                              ) : null}
                            </span>
                          ))}
                          <span className="note">Communication attachment — not evidence; evidence enters only through the governed workflow</span>
                        </span>
                      ) : null}
                      {!m.externalDeleted && m.location ? (
                        <span className="msg-loc">
                          <span className="k">COMMUNICATION LOCATION</span>
                          <span className="num">{m.location.latitude.toFixed(5)}, {m.location.longitude.toFixed(5)}</span>
                          <a href={selected.project ? `/project/${selected.project.id}?tab=map` : "/map"}>View on Map</a>
                          <span className="note">not evidence capture location</span>
                        </span>
                      ) : null}
                      {canFieldOps && m.messageType === "TEXT" && !m.externalDeleted ? (
                        <a className="msg-mkissue" href={`/issues/new?messageId=${m.id}`}>Create Field Issue</a>
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

// -------------------------------------------- communication integrations

/**
 * Communication Integrations — discoverability surface over the EXISTING
 * Teams Conversation Bridge. Read-only aggregation plus links/forms to
 * the existing endpoints; no integration logic lives here.
 */
export function renderIntegrations(input: {
  nav: NavContext;
  configured: boolean;
  testMode: boolean;
  sendCap: "delegated" | "app-test" | "none";
  canManage: boolean;
  rows: Array<{
    thread: ConversationThread;
    binding: ExternalThreadBinding | null;
    project: Project | null;
  }>;
  threadCount: number;
  maintained: string | null;
  watest: string | null;
  whatsapp: {
    status: "NOT_CONFIGURED" | "ACTIVE" | "DEGRADED";
    businessAccountId: string | null;
    canManage: boolean;
    unresolvedCount: number;
    lastInbound: string | null;
  };
}): string {
  const live = input.rows.filter(
    (r) => r.binding && r.binding.status !== "DISCONNECTED"
  ) as Array<{ thread: ConversationThread; binding: ExternalThreadBinding; project: Project | null }>;
  const teamCount = new Set(live.map((r) => r.binding.teamId)).size;
  const lastSync = live
    .map((r) => r.binding.lastSyncAt)
    .filter(Boolean)
    .sort()
    .pop() as string | undefined;
  // Aggregate status: worst-first precedence over live bindings.
  const agg = !input.configured
    ? { label: "Not Configured", tone: "neutral" }
    : live.some((r) => r.binding.status === "PERMISSION_REQUIRED")
      ? { label: "Permissions Required", tone: "warn" }
      : live.some((r) => r.binding.status === "CONNECTING")
        ? { label: "Connecting", tone: "warn" }
        : live.some((r) => r.binding.status === "DEGRADED")
          ? { label: "Degraded", tone: "warn" }
          : live.length > 0
            ? { label: input.testMode ? "Active (integration test mode)" : "Active", tone: "ok" }
            : { label: "No threads connected", tone: "neutral" };
  const degradedCount = live.filter((r) => r.binding.status === "DEGRADED").length;
  const diagLine = !input.configured
    ? "Not configured — administrator setup required."
    : [
        input.sendCap === "delegated"
          ? "Send path: delegated (configured)"
          : input.sendCap === "app-test"
            ? "Send path: integration test mode"
            : "Receive-only — delegated send permission not configured",
        degradedCount > 0 ? `${degradedCount} subscription(s) degraded` : "Subscriptions healthy",
      ].join(" · ");

  return renderDocument(
    <AppShell title="Communication Integrations" nav={input.nav} context="Integrations">
      <PageHeader
        title="Communication Integrations"
        sub="External channels connected to OBV project coordination. Internal OBV Communications works independently of any integration."
        crumb={{ href: "/communications", label: "Communications" }}
      />

      {input.maintained ? (
        <div className="panel panel-pad" style="margin-bottom:12px;font-size:12.5px">
          Diagnostic run complete: {input.maintained.split("-")[0]} connection(s) checked,{" "}
          {input.maintained.split("-")[1]} degraded. Details appear per thread below.
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h3>Microsoft Teams</h3>
          <span className="right">Conversation synchronization</span>
        </div>
        <div className="intg-body">
          <div className="intg-facts">
            <dl className="ctx-kv" style="padding:0;margin:0">
              <dt>Status</dt>
              <dd><span className={`sync-tag ${agg.tone}`} style="margin-left:0">{agg.label}</span></dd>
              <dt>Teams connected</dt><dd>{teamCount}</dd>
              <dt>Threads connected</dt><dd>{live.length} of {input.threadCount} accessible threads</dd>
              <dt>Last successful sync</dt><dd>{lastSync ? fmtDate(lastSync) : "—"}</dd>
              <dt>Diagnostic</dt><dd>{diagLine}</dd>
            </dl>
          </div>
          <div className="intg-actions">
            {input.configured ? (
              <>
                {input.canManage ? (
                  <>
                    <a className="btn sm" href={live.length ? "#connected-threads" : "/communications"}>
                      {live.length ? "View Connected Threads" : "Configure Teams"}
                    </a>
                    <form method="POST" action="/api/teams-sync/maintain" style="margin:0">
                      <button className="btn secondary sm" type="submit" data-busy-label="Running…">
                        Run Diagnostic
                      </button>
                    </form>
                  </>
                ) : (
                  <span className="sub" style="font-size:11.5px">
                    Connection management requires a Project Manager or Funder Representative.
                  </span>
                )}
              </>
            ) : null}
            <details className="intg-setup">
              <summary>{input.configured ? "Open Setup Guide" : "View Setup Requirements"}</summary>
              <div className="intg-setup-body">
                <p>
                  <b>Administrator setup</b> (server-side only — no values are entered in this UI):
                </p>
                <ol>
                  <li>Entra app registration with application read permission (tenant-wide <code>ChannelMessage.Read.All</code> or team-scoped RSC via the OBV Teams app package in <code>integrations/teams-app/</code>).</li>
                  <li>Delegated <code>ChannelMessage.Send</code> service account (onboard with <code>scripts/teams-delegated-auth.js</code>).</li>
                  <li>Environment variables on the deployment: <code>MICROSOFT_TENANT_ID</code>, <code>MICROSOFT_CLIENT_ID</code>, <code>MICROSOFT_CLIENT_SECRET</code>, <code>MICROSOFT_SEND_REFRESH_TOKEN</code>.</li>
                  <li>Verify with <code>scripts/teams-real-tenant-check.js</code>; schedule subscription renewal (~30 min).</li>
                </ol>
                <p>
                  Full walkthrough: <code>docs/TEAMS_REAL_TENANT_SETUP.md</code> in the repository.
                  Coordination sync never affects evidence, verification, approvals or funds.
                </p>
              </div>
            </details>
          </div>
        </div>
        {!input.configured ? (
          <p className="sub" style="padding:0 16px 14px;font-size:12.5px">
            Microsoft Teams conversation sync is not configured. Administrator setup is
            required before project threads can be connected. Internal OBV Communications
            and Teams event notification cards are unaffected.
          </p>
        ) : null}
      </div>

      {input.configured ? (
        <div className="panel" id="connected-threads" style="margin-top:12px">
          <div className="panel-head">
            <h3>Connected threads</h3>
            <span className="right">{live.length} connection{live.length === 1 ? "" : "s"}</span>
          </div>
          {live.length === 0 ? (
            <p className="sub" style="padding:14px 16px">
              No threads are connected yet.{" "}
              {input.canManage
                ? "Open a thread in Communications and use Connect to Teams."
                : "A Project Manager or Funder Representative can connect threads."}
            </p>
          ) : (
            <div className="intg-table-wrap">
              <table className="intg-table">
                <thead>
                  <tr>
                    <th>OBV thread</th><th>Project</th><th>Team</th><th>Channel</th>
                    <th>Status</th><th>Last sync</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {live.map((r) => (
                    <tr>
                      <td data-l="Thread">{r.thread.title}</td>
                      <td data-l="Project">{r.project?.name ?? "—"}</td>
                      <td data-l="Team">{r.binding.teamName ?? "—"}</td>
                      <td data-l="Channel">{r.binding.channelName ?? "—"}</td>
                      <td data-l="Status">
                        <span className={`sync-tag ${bindingTone(r.binding, true)}`} style="margin-left:0">
                          {bindingShortLabel(r.binding, true, input.testMode)}
                        </span>
                      </td>
                      <td data-l="Last sync">{r.binding.lastSyncAt ? fmtDate(r.binding.lastSyncAt) : "—"}</td>
                      <td data-l="" className="intg-row-actions">
                        <a className="btn ghost sm" href={`/communications?thread=${r.thread.id}`}>Open Thread</a>
                        {input.canManage ? (
                          <>
                            <a className="btn ghost sm" href={`/communications?thread=${r.thread.id}#comms-ctx`}>Manage</a>
                            <form method="POST" action={`/api/threads/${r.thread.id}/teams-binding`} style="margin:0;display:inline">
                              <input type="hidden" name="action" value="disconnect" />
                              <button className="btn ghost sm" type="submit">Disconnect</button>
                            </form>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      <div className="panel" style="margin-top:12px">
        <div className="panel-head">
          <h3>WhatsApp Business</h3>
          <span className="right">Field coordination channel</span>
        </div>
        {input.watest ? (
          <div
            className={`banner ${input.watest.startsWith("ok") ? "ok" : "warn"}`}
            style="margin:12px 16px 0"
          >
            {input.watest.startsWith("ok")
              ? `Connection test passed — credentials valid${input.watest.includes(":") ? `, business number ${input.watest.split(":")[1]}` : ""}. No message was sent.`
              : `Connection test failed (${input.watest.replace(/^fail:/, "")}). Check credentials and webhook configuration.`}
          </div>
        ) : null}
        {input.whatsapp.status === "NOT_CONFIGURED" ? (
          <p className="sub" style="padding:14px 16px;font-size:12.5px">
            <span className="sync-tag neutral" style="margin-left:0">Not Configured</span>
            <span style="display:block;margin-top:8px">
              WhatsApp field coordination requires administrator setup (Meta
              Business / Cloud API credentials) — see
              <code> docs/WHATSAPP_REAL_SETUP.md</code>. Internal OBV
              Communications works independently.
            </span>
          </p>
        ) : (
          <div className="intg-body">
            <div className="intg-facts">
              <dl className="ctx-kv" style="padding:0;margin:0">
                <dt>Status</dt>
                <dd><span className={`sync-tag ${input.whatsapp.status === "ACTIVE" ? "ok" : "warn"}`} style="margin-left:0">{input.whatsapp.status}</span></dd>
                <dt>Business account</dt><dd>{input.whatsapp.businessAccountId ?? "—"}</dd>
                <dt>Webhook</dt><dd>Configured (verify token + signature validation)</dd>
                <dt>Last inbound</dt><dd>{input.whatsapp.lastInbound ? fmtDate(input.whatsapp.lastInbound) : "—"}</dd>
                <dt>Unresolved inbox</dt><dd>{input.whatsapp.unresolvedCount} message{input.whatsapp.unresolvedCount === 1 ? "" : "s"}</dd>
              </dl>
            </div>
            <div className="intg-actions">
              {input.whatsapp.canManage ? (
                <form method="POST" action="/api/whatsapp/test" style="margin:0">
                  <button className="btn secondary sm" type="submit" data-busy-label="Testing…">Test Connection</button>
                </form>
              ) : null}
              <p className="ctx-note" style="padding:0">
                Participants are assigned to project threads explicitly by a
                coordinator — context is never guessed from message text.
              </p>
            </div>
          </div>
        )}
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------------- field issues

const SEVERITY_TONE: Record<string, string> = {
  LOW: "neutral", MEDIUM: "warn", HIGH: "warn", CRITICAL: "bad",
};
const ISSUE_STATUS_TONE: Record<string, string> = {
  OPEN: "warn", ACKNOWLEDGED: "warn", IN_PROGRESS: "warn",
  AWAITING_FIELD_RESPONSE: "warn", RESOLVED: "ok", CLOSED: "neutral",
};

export function renderIssues(input: {
  nav: NavContext;
  issues: Array<{
    issue: FieldIssue;
    project: Project | null;
    milestone: Milestone | null;
    assignee: User | null;
  }>;
  canManage: boolean;
}): string {
  const open = input.issues.filter((r) => !["RESOLVED", "CLOSED"].includes(r.issue.status));
  const critical = open.filter((r) => r.issue.severity === "CRITICAL");
  const overdue = open.filter(
    (r) => r.issue.dueAt && Date.parse(r.issue.dueAt) < Date.now()
  );
  const awaiting = input.issues.filter((r) => r.issue.status === "AWAITING_FIELD_RESPONSE");
  const resolved = input.issues.filter((r) => ["RESOLVED", "CLOSED"].includes(r.issue.status));
  return renderDocument(
    <AppShell title="Field Issues" nav={input.nav} context="Field Issues">
      <PageHeader
        title="Field Issues"
        sub="Operational issues raised from field coordination. Issues inform human decisions — release eligibility is controlled only by the formal approval workflow."
        crumb={{ href: "/compliance", label: "Risk & Compliance" }}
      />
      <div className="issue-stats">
        <span><b className="num">{open.length}</b> Open</span>
        <span><b className="num" style={critical.length ? "color:var(--bad)" : ""}>{critical.length}</b> Critical</span>
        <span><b className="num" style={overdue.length ? "color:var(--warn)" : ""}>{overdue.length}</b> Overdue</span>
        <span><b className="num">{awaiting.length}</b> Awaiting field response</span>
        <span><b className="num">{resolved.length}</b> Resolved</span>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h3>Register</h3>
          <span className="right">{input.issues.length} issue{input.issues.length === 1 ? "" : "s"}</span>
        </div>
        {input.issues.length === 0 ? (
          <p className="sub" style="padding:14px 16px">
            No field issues. Issues are created from coordination messages in
            Communications or directly by authorized roles.
          </p>
        ) : (
          <div className="intg-table-wrap">
            <table className="intg-table">
              <thead>
                <tr><th>Issue</th><th>Project / milestone</th><th>Category</th><th>Severity</th><th>Status</th><th>Assigned</th><th>Due</th></tr>
              </thead>
              <tbody>
                {input.issues.map((r) => (
                  <tr>
                    <td data-l="Issue"><a href={`/issue/${r.issue.id}`} style="font-weight:600;color:var(--action)">{r.issue.title}</a></td>
                    <td data-l="Context">{r.milestone ? `M${r.milestone.seq}` : r.project?.name.slice(0, 28) ?? "—"}</td>
                    <td data-l="Category">{r.issue.category}</td>
                    <td data-l="Severity"><span className={`sync-tag ${SEVERITY_TONE[r.issue.severity]}`} style="margin-left:0">{r.issue.severity}</span></td>
                    <td data-l="Status"><span className={`sync-tag ${ISSUE_STATUS_TONE[r.issue.status]}`} style="margin-left:0">{r.issue.status.replace(/_/g, " ")}</span></td>
                    <td data-l="Assigned">{r.assignee?.name ?? "—"}</td>
                    <td data-l="Due">{r.issue.dueAt ? r.issue.dueAt.slice(0, 10) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

export function renderIssueDetail(input: {
  nav: NavContext;
  issue: FieldIssue;
  project: Project;
  milestone: Milestone | null;
  assignee: User | null;
  reporter: User | null;
  events: FieldIssueEvent[];
  sourceMessage: ChatMessage | null;
  users: Map<string, User>;
  canManage: boolean;
}): string {
  const { issue } = input;
  const NEXT: Record<string, string[]> = {
    OPEN: ["ACKNOWLEDGED", "IN_PROGRESS", "CLOSED"],
    ACKNOWLEDGED: ["IN_PROGRESS", "AWAITING_FIELD_RESPONSE", "RESOLVED", "CLOSED"],
    IN_PROGRESS: ["AWAITING_FIELD_RESPONSE", "RESOLVED", "CLOSED"],
    AWAITING_FIELD_RESPONSE: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
    RESOLVED: ["CLOSED", "IN_PROGRESS"],
    CLOSED: [],
  };
  return renderDocument(
    <AppShell title={issue.title} nav={input.nav} context={`Issue · ${issue.title}`}>
      <PageHeader
        title={issue.title}
        sub={`${input.project.name}${input.milestone ? ` · M${input.milestone.seq} ${input.milestone.title}` : ""}`}
        crumb={{ href: "/issues", label: "Field Issues" }}
      >
        <span className={`sync-tag ${SEVERITY_TONE[issue.severity]}`}>{issue.severity}</span>
        <span className={`sync-tag ${ISSUE_STATUS_TONE[issue.status]}`}>{issue.status.replace(/_/g, " ")}</span>
      </PageHeader>

      <div className="panel panel-pad">
        <dl className="ctx-kv" style="padding:0;grid-template-columns:130px 1fr">
          <dt>Description</dt><dd>{issue.description}</dd>
          <dt>Category</dt><dd>{issue.category}</dd>
          <dt>Reported by</dt>
          <dd>
            {input.reporter?.name ??
              (issue.reportedByExternalIdentityId
                ? `External participant · via WhatsApp`
                : "—")}
          </dd>
          <dt>Assigned to</dt><dd>{input.assignee?.name ?? "Unassigned"}</dd>
          <dt>Due</dt><dd>{issue.dueAt ? issue.dueAt.slice(0, 10) : "—"}</dd>
          {issue.latitude !== null ? (
            <>
              <dt>Location</dt>
              <dd>
                {issue.latitude.toFixed(5)}, {issue.longitude!.toFixed(5)}{" "}
                <span className="sub">(communication location)</span>{" "}
                <a href="/map" style="color:var(--action);font-weight:600">View on Map</a>
              </dd>
            </>
          ) : null}
          {issue.resolutionSummary ? (
            <>
              <dt>Resolution</dt><dd>{issue.resolutionSummary}</dd>
            </>
          ) : null}
        </dl>
        {input.sourceMessage ? (
          <div className="issue-src">
            <span className="k">SOURCE MESSAGE</span>
            <span className="b">
              {input.sourceMessage.senderDisplayName}
              {input.sourceMessage.provider !== "OBV" ? ` · via ${input.sourceMessage.provider === "WHATSAPP" ? "WhatsApp" : "Microsoft Teams"}` : ""}:
              “{input.sourceMessage.body.slice(0, 300)}”
            </span>
            <a href={`/communications?thread=${input.sourceMessage.threadId}`}>Open conversation</a>
          </div>
        ) : null}
        {input.canManage && NEXT[issue.status].length > 0 ? (
          <form method="POST" action={`/api/issues/${issue.id}/status`} className="issue-actions">
            <select name="status" aria-label="New status">
              {NEXT[issue.status].map((s) => (
                <option value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
            <input name="resolutionSummary" placeholder="Resolution note (for RESOLVED/CLOSED)" style="flex:1;min-width:160px" />
            <button className="btn sm" type="submit">Update status</button>
          </form>
        ) : null}
      </div>

      <div className="panel" style="margin-top:12px">
        <div className="panel-head">
          <h3>Field issue timeline</h3>
          <span className="right">Operational record — NOT the Evidence Ledger</span>
        </div>
        <ul className="activity">
          {input.events.map((e) => (
            <li>
              <span className={`ico ${e.type === "RESOLVED" ? "ok" : "warn"}`}>{icons.activity()}</span>
              <span className="body">
                <span className="msg">{e.detail}</span>
                <span className="meta">
                  <span className="when">{fmtDate(e.createdAt)}</span>
                  {e.actorUserId ? <span>{input.users.get(e.actorUserId)?.name}</span> : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

export function renderIssueNew(input: {
  nav: NavContext;
  sourceMessage: ChatMessage | null;
  project: Project | null;
  milestone: Milestone | null;
  users: User[];
}): string {
  return renderDocument(
    <AppShell title="Create Field Issue" nav={input.nav} context="New Field Issue">
      <PageHeader
        title="Create Field Issue"
        sub="An operational issue for human coordination. Issues never change financial state."
        crumb={{ href: "/issues", label: "Field Issues" }}
      />
      <div className="panel panel-pad" style="max-width:640px">
        {input.sourceMessage ? (
          <div className="issue-src" style="margin:0 0 14px">
            <span className="k">FROM MESSAGE</span>
            <span className="b">
              {input.sourceMessage.senderDisplayName}
              {input.sourceMessage.provider === "WHATSAPP" ? " · via WhatsApp" : input.sourceMessage.provider === "TEAMS" ? " · via Microsoft Teams" : ""}:
              “{input.sourceMessage.body.slice(0, 240)}”
            </span>
          </div>
        ) : null}
        <form method="POST" action="/api/issues" className="fo-form">
          {input.sourceMessage ? <input type="hidden" name="messageId" value={input.sourceMessage.id} /> : null}
          <input type="hidden" name="projectId" value={input.project?.id ?? ""} />
          {input.milestone ? <input type="hidden" name="milestoneId" value={input.milestone.id} /> : null}
          <label>Title
            <input name="title" required maxlength="160" placeholder="Short operational summary" />
          </label>
          <label>Description
            <textarea name="description" rows="3" placeholder="What happened, where, and what is needed">{input.sourceMessage?.body ?? ""}</textarea>
          </label>
          <div className="fo-row">
            <label>Category
              <select name="category">
                {["QUALITY","SAFETY","MATERIAL","SCHEDULE","ACCESS","ENVIRONMENTAL","DOCUMENTATION","EQUIPMENT","OTHER"].map((c) => (
                  <option value={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>Severity
              <select name="severity">
                {["LOW","MEDIUM","HIGH","CRITICAL"].map((c) => (
                  <option value={c} selected={c === "MEDIUM"}>{c}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="fo-row">
            <label>Assign to
              <select name="assignedToUserId">
                <option value="">Unassigned</option>
                {input.users.filter((u) => u.role !== "FIELD" || true).map((u) => (
                  <option value={u.id}>{u.name} — {u.title}</option>
                ))}
              </select>
            </label>
            <label>Due date
              <input name="dueAt" type="date" />
            </label>
          </div>
          <div style="display:flex;gap:8px">
            <button className="btn" type="submit">Create Field Issue</button>
            <a className="btn ghost" href={input.sourceMessage ? `/communications?thread=${input.sourceMessage.threadId}` : "/issues"}>Cancel</a>
          </div>
        </form>
      </div>
    </AppShell>
  );
}

// -------------------------------------------- evidence draft promotion

export function renderDraftNew(input: {
  nav: NavContext;
  sourceMessage: ChatMessage;
  attachmentIndex: number;
  project: Project;
  milestones: Milestone[];
  defaultMilestoneId: string | null;
  locationMessages: ChatMessage[];
}): string {
  const m = input.sourceMessage;
  const att = m.attachments[input.attachmentIndex];
  return renderDocument(
    <AppShell title="Promote to Evidence Draft" nav={input.nav} context="Evidence Draft">
      <PageHeader
        title="Promote to Evidence Draft"
        sub="Creates a DRAFT only. Submission runs the normal verification, ledger and governance pipeline — nothing is verified by promotion."
        crumb={{ href: `/communications?thread=${m.threadId}`, label: "Conversation" }}
      />
      <div className="panel panel-pad" style="max-width:640px">
        {att?.url && att.kind === "IMAGE" ? (
          <img src={att.url} alt="Communication media" style="max-width:100%;max-height:220px;object-fit:contain;border:1px solid var(--line);background:var(--inset)" />
        ) : null}
        <dl className="ctx-kv" style="padding:0;margin-top:12px;grid-template-columns:170px 1fr">
          <dt>Source</dt>
          <dd><span className="sync-tag warn" style="margin-left:0">SOURCE: {m.provider === "WHATSAPP" ? "WHATSAPP COMMUNICATION" : `${m.provider} COMMUNICATION`}</span></dd>
          <dt>Source identity</dt><dd>{m.senderDisplayName}{m.provider === "WHATSAPP" ? " · via WhatsApp" : ""}</dd>
          <dt>Source timestamp</dt><dd>{fmtDate(m.createdAt)} <span className="sub">(provider message time — not an original capture timestamp)</span></dd>
          <dt>Original capture metadata</dt>
          <dd><span className="sync-tag warn" style="margin-left:0">MISSING ORIGINAL CAPTURE METADATA</span></dd>
          <dt>Location</dt>
          <dd>
            {input.locationMessages.length === 0 ? (
              <span className="sync-tag warn" style="margin-left:0">MISSING LOCATION</span>
            ) : (
              <span className="sub">Optionally associate an explicitly shared location below.</span>
            )}
          </dd>
        </dl>
        <form method="POST" action="/api/evidence-drafts" className="fo-form" style="margin-top:14px">
          <input type="hidden" name="messageId" value={m.id} />
          <input type="hidden" name="attachmentIndex" value={String(input.attachmentIndex)} />
          <label>Milestone
            <select name="milestoneId" required>
              {input.milestones.map((ms) => (
                <option value={ms.id} selected={ms.id === input.defaultMilestoneId}>
                  M{ms.seq} · {ms.title}
                </option>
              ))}
            </select>
          </label>
          {input.locationMessages.length > 0 ? (
            <label>Associate communication location (explicit — otherwise stays missing)
              <select name="locationMessageId">
                <option value="">No location — leave honestly missing</option>
                {input.locationMessages.map((lm) => (
                  <option value={lm.id}>
                    {lm.senderDisplayName} · {fmtDate(lm.createdAt)} · {lm.location!.latitude.toFixed(4)}, {lm.location!.longitude.toFixed(4)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p className="sub" style="font-size:11.5px;margin:0">
            The draft appears on the milestone page. A separate explicit
            “Submit for Verification” runs the standard pipeline: missing GPS
            routes to review under the existing geofence policy; no verified
            status, ledger entry or approval is created by this step.
          </p>
          <div style="display:flex;gap:8px">
            <button className="btn" type="submit">Create Evidence Draft</button>
            <a className="btn ghost" href={`/communications?thread=${m.threadId}`}>Cancel</a>
          </div>
        </form>
      </div>
    </AppShell>
  );
}
