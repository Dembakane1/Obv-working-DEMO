/** Shared UI components — OBV design system v3 (institutional). */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { h, Fragment, VNode, Child } from "./jsx";
import { brandMark, icons } from "./icons";
import type {
  AccountStatus,
  ApprovalRecord,
  ApprovalRequest,
  ApprovalStatus,
  EvidenceItem,
  LedgerEntry,
  Milestone,
  MilestoneStatus,
  Notification,
  User,
  UserRole,
  Verdict,
  Verification,
} from "../../shared/types";

// ------------------------------------------------------------ helpers

// Content-derived stylesheet version so every deploy that changes styles.css
// forces browsers/CDNs past any cached copy. Computed once at startup; the
// static server routes on pathname, so the query string never affects lookup.
export const STYLESHEET_HREF: string = (() => {
  try {
    const hash = createHash("sha256")
      .update(readFileSync(join(process.cwd(), "public", "styles.css")))
      .digest("hex")
      .slice(0, 12);
    return `/styles.css?v=${hash}`;
  } catch {
    return "/styles.css";
  }
})();

export function money(amount: number): string {
  return "$" + amount.toLocaleString("en-US");
}

export function shortHash(hash: string | null | undefined, len = 16): string {
  if (!hash) return "—";
  return hash.slice(0, len) + "…";
}

export function fmtDate(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, " UTC").replace(/Z$/, " UTC");
}

export function fmtGps(lat: number | null, lng: number | null): string {
  if (lat === null || lng === null) return "— (no GPS fix)";
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export function roleLabel(role: UserRole): string {
  const map: Record<UserRole, string> = {
    FUNDER_REP: "Funder Representative",
    PROJECT_MANAGER: "Project Manager",
    COMPLIANCE_REVIEWER: "Compliance Reviewer",
    FIELD: "Field Engineer",
  };
  return map[role];
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// -------------------------------------------------------- status system
// One consistent treatment: glyph + text + restrained semantic color.

function Status(props: { tone: string; glyph: string; children?: Child }): VNode {
  return (
    <span className={`status ${props.tone}`}>
      <span className="g" aria-hidden="true">{props.glyph}</span>
      {props.children}
    </span>
  );
}

const MILESTONE_STATUS_META: Record<MilestoneStatus, { label: string; tone: string; glyph: string }> = {
  NOT_STARTED: { label: "Not started", tone: "", glyph: "○" },
  PENDING_EVIDENCE: { label: "Awaiting evidence", tone: "warn", glyph: "○" },
  UNDER_REVIEW: { label: "Under review", tone: "info", glyph: "!" },
  VERIFIED: { label: "Verified", tone: "info", glyph: "✓" },
  APPROVED: { label: "Approved", tone: "ok", glyph: "✓" },
  RELEASED: { label: "Released", tone: "ok", glyph: "✓" },
};

export function MilestoneStatusChip(props: { status: MilestoneStatus }): VNode {
  const m = MILESTONE_STATUS_META[props.status];
  return <Status tone={m.tone} glyph={m.glyph}>{m.label}</Status>;
}

export function AccountChip(props: { status: AccountStatus }): VNode {
  return props.status === "RELEASED" ? (
    <Status tone="ok" glyph="✓">Released</Status>
  ) : (
    <Status tone="warn" glyph="●">Held</Status>
  );
}

export function VerdictChip(props: { verdict: Verdict }): VNode {
  return props.verdict === "VERIFIED" ? (
    <Status tone="ok" glyph="✓">Verified</Status>
  ) : props.verdict === "NEEDS_REVIEW" ? (
    <Status tone="warn" glyph="!">Needs review</Status>
  ) : (
    <Status tone="bad" glyph="✕">Rejected</Status>
  );
}

export function ApprovalChip(props: { status: ApprovalStatus; progress?: string }): VNode {
  if (props.status === "APPROVED") return <Status tone="ok" glyph="✓">Approved</Status>;
  if (props.status === "REJECTED") return <Status tone="bad" glyph="✕">Rejected</Status>;
  if (props.progress && props.progress[0] !== "0") {
    return <Status tone="warn" glyph="◐">Partially approved · {props.progress}</Status>;
  }
  return <Status tone="warn" glyph="○">Pending approval{props.progress ? ` · ${props.progress}` : ""}</Status>;
}

export function IntegrityChip(props: { valid: boolean; brokenAt?: number }): VNode {
  return props.valid ? (
    <Status tone="ok" glyph="✓">Chain intact</Status>
  ) : (
    <Status tone="bad" glyph="✕">Tampering detected{props.brokenAt ? ` at #${props.brokenAt}` : ""}</Status>
  );
}

export function FallbackChip(): VNode {
  return <span className="chip fallback">Demo fallback</span>;
}

// ---------------------------------------------------------- app shell

export interface NavContext {
  user: User;
  active: string;
  pendingApprovals: number;
  /** Open field issues (badge on the Field Issues nav item). */
  openIssues?: number;
  /** Open HIGH/CRITICAL exceptions (badge on the Exceptions nav item). */
  openExceptions?: number;
  /** Organization identity shown at the bottom of the sidebar. */
  orgName?: string;
  orgKind?: string;
}

interface NavItem { key: string; href: string; label: string; icon: () => VNode; badge?: "approvals" | "issues" | "exceptions" }

const NAV_ITEMS: NavItem[] = [
  { key: "overview", href: "/overview", label: "Overview", icon: icons.overview },
  { key: "projects", href: "/projects", label: "Projects", icon: icons.projects },
  { key: "map", href: "/map", label: "Map / Satellite", icon: icons.map },
  { key: "approvals", href: "/approvals", label: "Approvals", icon: icons.approvals, badge: "approvals" },
  { key: "draws", href: "/draws", label: "Draw Requests", icon: icons.dollar },
  { key: "change-orders", href: "/change-orders", label: "Change Orders", icon: icons.refresh },
  { key: "compliance", href: "/compliance", label: "Evidence Review", icon: icons.shield },
  { key: "comms", href: "/communications", label: "Communications", icon: icons.chat },
  { key: "issues", href: "/issues", label: "Field Issues", icon: icons.alert, badge: "issues" },
  { key: "exceptions", href: "/exceptions", label: "Exceptions", icon: icons.shield, badge: "exceptions" },
  { key: "field", href: "/field", label: "Field Capture", icon: icons.camera },
  { key: "reports", href: "/reports", label: "Reports", icon: icons.reports },
  { key: "ledger", href: "/ledger", label: "Ledger", icon: icons.ledger },
];

const NAV_ITEMS_PILOT: NavItem[] = [
  { key: "setup", href: "/setup", label: "Pilot Setup", icon: icons.projects },
  { key: "pilot", href: "/pilot", label: "Pilot Operations", icon: icons.activity },
  { key: "integrations", href: "/communications/integrations", label: "Integrations", icon: icons.refresh },
];

const NAV_ITEMS_UTILITY: NavItem[] = [
  { key: "control", href: "/control", label: "Control Intelligence", icon: icons.shield },
  { key: "insights", href: "/insights", label: "OBV Intelligence", icon: icons.insights },
  { key: "budget", href: "/budget", label: "Budget & Progress", icon: icons.ledger },
];

const ALL_NAV_ITEMS = [...NAV_ITEMS, ...NAV_ITEMS_PILOT, ...NAV_ITEMS_UTILITY];

const BOTTOM_NAV = ["overview", "projects", "approvals", "ledger"];

export function AppShell(props: {
  title: string;
  nav: NavContext;
  /** Optional context shown in the top bar after the section name. */
  context?: string;
  children?: Child;
}): VNode {
  const { user, active, pendingApprovals, openIssues = 0, openExceptions = 0 } = props.nav;
  const activeItem = ALL_NAV_ITEMS.find((i) => i.key === active);
  const badgeCount = (item: NavItem) =>
    item.badge === "approvals"
      ? pendingApprovals
      : item.badge === "issues"
        ? openIssues
        : item.badge === "exceptions"
          ? openExceptions
          : 0;
  const navLink = (item: NavItem) => (
    <a
      href={item.href}
      className={`nav-item ${active === item.key ? "active" : ""}`}
      aria-current={active === item.key ? "page" : undefined}
    >
      {item.icon()}
      {item.label}
      {badgeCount(item) > 0 ? <span className="count">{badgeCount(item)}</span> : null}
    </a>
  );
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} — OBV</title>
        <link rel="stylesheet" href={STYLESHEET_HREF} />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#0d1626" />
      </head>
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="sidebar-brand">
              <span className="mark">{brandMark(18)}</span>
              <span className="word">
                <span className="n">OBV</span>
                <span className="s">OpenBuild Verify</span>
              </span>
            </div>
            <nav className="sidebar-nav" aria-label="Primary">
              {NAV_ITEMS.map(navLink)}
              <div className="nav-group">Pilot</div>
              {NAV_ITEMS_PILOT.map(navLink)}
              <div className="nav-group">Analysis</div>
              {NAV_ITEMS_UTILITY.map(navLink)}
            </nav>
            {props.nav.orgName ? (
              <div className="sidebar-org">
                <span className="o-mark" aria-hidden="true">{icons.building()}</span>
                <span className="o-body">
                  <span className="o-n">{props.nav.orgName}</span>
                  {props.nav.orgKind ? (
                    <span className="o-k">{props.nav.orgKind.replace(/_/g, " ").toLowerCase()}</span>
                  ) : null}
                </span>
              </div>
            ) : null}
          </aside>

          <div className="main">
            <div className="topbar">
              <span className="ctx">
                <b>{activeItem?.label ?? props.title}</b>
                {props.context && props.context !== (activeItem?.label ?? props.title) ? (
                  <>
                    <span className="sep">/</span>
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{props.context}</span>
                  </>
                ) : null}
              </span>
              <span className="right">
                <span className="env-tag">Demo environment</span>
                <span className="id-block">
                  <span className="avatar" aria-hidden="true">{initials(user.name)}</span>
                  <span className="who">
                    <span className="n">{user.name}</span>
                    <span className="r">{roleLabel(user.role)}</span>
                  </span>
                </span>
                <a className="switch" href="/" title="Switch demo user">Switch</a>
              </span>
            </div>

            <div className="mobile-top">
              <span className="m-avatar" aria-hidden="true">{initials(user.name)}</span>
              <span className="m-id">
                <span className="t">{activeItem?.label ?? props.title}</span>
                <span className="o">{props.nav.orgName ?? "OpenBuild Verify"}</span>
              </span>
              <span className="u">
                <span className="env-tag" style="font-size:8.5px;padding:1px 5px">Demo</span>{" "}
                <a href="/">switch</a>
              </span>
            </div>

            <div className="content">{props.children}</div>
          </div>
        </div>

        <nav className="bottom-nav" aria-label="Primary">
          {NAV_ITEMS.filter((i) => BOTTOM_NAV.includes(i.key)).map((item) => (
            <a href={item.href} className={active === item.key ? "active" : ""}>
              <span className="bn-ico">
                {item.icon()}
                {item.key === "approvals" && pendingApprovals > 0 ? (
                  <span className="bn-badge">{pendingApprovals}</span>
                ) : null}
              </span>
              {item.key === "approvals" ? "Approvals" : item.key === "ledger" ? "Ledger" : item.label.split(" ")[0]}
            </a>
          ))}
          <a href="/more" className={active === "more" ? "active" : ""}>
            {icons.more()}
            More
          </a>
        </nav>
      </body>
    </html>
  );
}

export function PageHeader(props: {
  title: string;
  sub?: string;
  crumb?: { href: string; label: string };
  children?: Child;
}): VNode {
  return (
    <header className="page-head">
      <div className="id">
        {props.crumb ? (
          <a className="crumb" href={props.crumb.href}>← {props.crumb.label}</a>
        ) : null}
        <h1>{props.title}</h1>
        {props.sub ? <p className="sub">{props.sub}</p> : null}
      </div>
      {props.children ? <div className="actions">{props.children}</div> : null}
    </header>
  );
}

// ------------------------------------------------- financial summary band

export interface FinCell {
  value: string;
  label: string;
  context?: string;
  tone?: "green" | "amber";
}

export function FinancialBand(props: { cells: FinCell[] }): VNode {
  return (
    <div className="fin-band">
      {props.cells.map((c) => (
        <div className="fin-cell">
          <div className={`v ${c.tone ?? ""}`}>{c.value}</div>
          <div className="l">{c.label}</div>
          {c.context ? <div className="c">{c.context}</div> : null}
        </div>
      ))}
    </div>
  );
}

export interface OpsItem {
  tone: "ok" | "warn" | "bad" | "idle";
  value: string;
  label: string;
}

export function OperationalStatus(props: { items: OpsItem[] }): VNode {
  return (
    <div className="ops-row">
      {props.items.map((i) => (
        <span className="ops-item">
          <span className={`g ${i.tone}`} aria-hidden="true">●</span>
          <b>{i.value}</b> {i.label}
        </span>
      ))}
    </div>
  );
}

// ----------------------------------------------------------- pipeline

/** EVIDENCE → VERIFIED → APPROVAL → RELEASE lifecycle indicator. */
export function Pipeline(props: {
  milestone: Milestone;
  verification: Verification | null;
  approval: ApprovalRequest | null;
  approvalProgress?: string;
}): VNode {
  const { milestone, verification, approval } = props;
  const s = milestone.status;

  type StageState = "done" | "current" | "blocked" | "idle";
  const evidence: StageState =
    s === "NOT_STARTED" ? "idle" : s === "PENDING_EVIDENCE" ? "current" : "done";
  const verified: StageState =
    s === "UNDER_REVIEW"
      ? "blocked"
      : s === "VERIFIED" || s === "APPROVED" || s === "RELEASED"
        ? "done"
        : verification?.verdict === "REJECTED"
          ? "blocked"
          : "idle";
  const approvalStage: StageState =
    approval?.status === "APPROVED"
      ? "done"
      : approval?.status === "REJECTED"
        ? "blocked"
        : approval?.status === "PENDING"
          ? "current"
          : "idle";
  const release: StageState = milestone.accountStatus === "RELEASED" ? "done" : "idle";

  const stages: Array<{ label: string; state: StageState }> = [
    { label: "Evidence", state: evidence },
    { label: verified === "blocked" ? "Review" : "Verified", state: verified },
    {
      label:
        approvalStage === "current" && props.approvalProgress
          ? `Approval ${props.approvalProgress}`
          : "Approval",
      state: approvalStage,
    },
    { label: "Release", state: release },
  ];

  return (
    <div className="pipeline">
      {stages.map((stage, i) => (
        <>
          {i > 0 ? <span className={`link ${stages[i - 1].state === "done" ? "done" : ""}`}></span> : null}
          <span className={`stage ${stage.state}`}>
            <span className="node">{stage.state === "done" ? "✓" : stage.state === "blocked" ? "!" : i + 1}</span>
            <span className="lbl">{stage.label.toUpperCase()}</span>
          </span>
        </>
      ))}
    </div>
  );
}

// ------------------------------------------------------ milestone rows

export interface MilestoneCardData {
  milestone: Milestone;
  verification: Verification | null;
  approval: ApprovalRequest | null;
  approvalRecords: ApprovalRecord[];
}

export function approvalProgressLabel(d: MilestoneCardData): string | undefined {
  if (!d.approval || d.approval.status !== "PENDING") return undefined;
  const approved = d.approvalRecords.filter((r) => r.decision === "APPROVED").length;
  return `${approved} of ${d.approval.requiredRoles.length}`;
}

/** The next action a reader should understand in two seconds. */
export function milestoneNextAction(d: MilestoneCardData): string | null {
  const { milestone, approval, approvalRecords } = d;
  if (milestone.status === "RELEASED") return null;
  if (approval?.status === "PENDING") {
    const missing = approval.requiredRoles.filter(
      (role) => !approvalRecords.some((r) => r.role === role)
    );
    return missing.length > 0 ? `Awaiting ${missing.map(roleLabel).join(", ")}` : "Awaiting sign-off";
  }
  if (milestone.status === "UNDER_REVIEW") return "Awaiting compliance review of flagged evidence";
  if (milestone.status === "PENDING_EVIDENCE") return "Awaiting field evidence capture";
  if (milestone.status === "NOT_STARTED") return null;
  return null;
}

export function MilestoneCard(props: { data: MilestoneCardData; cta?: VNode }): VNode {
  const { milestone } = props.data;
  const next = milestoneNextAction(props.data);
  return (
    <div className="ms-card">
      <div className="m-row1">
        <span className={`m-seq ${milestone.status === "RELEASED" ? "done" : ""}`}>M{milestone.seq}</span>
        <span className="m-main">
          <h4 className="m-title">
            <a href={`/milestone/${milestone.id}`}>{milestone.title}</a>
          </h4>
          <p className="m-req">{milestone.requirement}</p>
        </span>
        <span className="m-money">
          <span className="v num">{money(milestone.trancheAmount)}</span>
          <span className={`s ${milestone.accountStatus === "RELEASED" ? "released" : "held"}`}>
            {milestone.accountStatus}
          </span>
        </span>
      </div>
      <div className="m-row2">
        <Pipeline
          milestone={milestone}
          verification={props.data.verification}
          approval={props.data.approval}
          approvalProgress={approvalProgressLabel(props.data)}
        />
        {next ? (
          <span className="m-next">Next: <b>{next}</b></span>
        ) : null}
        <span className="m-cta">
          {props.cta ?? (
            <a className="btn ghost sm" href={`/milestone/${milestone.id}`}>Details</a>
          )}
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------ approval progress

export function ApprovalProgress(props: {
  approval: ApprovalRequest;
  records: ApprovalRecord[];
  users: Map<string, User>;
  hideSummary?: boolean;
}): VNode {
  const { approval, records } = props;
  const byRole = new Map(records.map((r) => [r.role, r]));
  const approved = records.filter((r) => r.decision === "APPROVED").length;
  return (
    <div className="approval-progress">
      {props.hideSummary ? null : (
        <div className="summary">
          {approval.status === "APPROVED"
            ? "Fully approved"
            : approval.status === "REJECTED"
              ? "Rejected"
              : `${approved} of ${approval.requiredRoles.length} approvals`}
        </div>
      )}
      {approval.requiredRoles.map((role) => {
        const rec = byRole.get(role);
        const cls = rec ? (rec.decision === "APPROVED" ? "yes" : "no") : "";
        const person = rec ? props.users.get(rec.userId) : undefined;
        return (
          <div className={`row ${cls}`}>
            <span className="tick" aria-hidden="true">{rec ? (rec.decision === "APPROVED" ? "✓" : "✕") : "○"}</span>
            <span className="who">
              {roleLabel(role)}
              {person ? <span className="sub" style="display:block">{person.name}</span> : null}
            </span>
            {rec ? (
              <span className="when">{fmtDate(rec.createdAt).slice(0, 16)}</span>
            ) : (
              <span className="when">awaiting</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Evidence panel building blocks (composed by the approvals page too) ---

export function EvidenceStatusChips(props: {
  verification: Verification | null;
  isDemoFallback: boolean;
}): VNode {
  return (
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 10px">
      {props.verification ? (
        <VerdictChip verdict={props.verification.verdict} />
      ) : (
        <span className="chip neutral">Unverified</span>
      )}
      {props.isDemoFallback ? <FallbackChip /> : null}
    </div>
  );
}

export function EvidenceFacts(props: {
  evidence: EvidenceItem;
  requirement: string;
  submittedBy?: User | null;
}): VNode {
  const { evidence } = props;
  return (
    <dl className="kv">
      <dt>Requirement</dt>
      <dd>{props.requirement}</dd>
      <dt>Captured</dt>
      <dd className="mono">{fmtDate(evidence.capturedAt)}</dd>
      <dt>Uploaded</dt>
      <dd className="mono">{fmtDate(evidence.uploadedAt)}</dd>
      <dt>GPS</dt>
      <dd className="mono">{fmtGps(evidence.latitude, evidence.longitude)}</dd>
      <dt>Device</dt>
      <dd>
        {evidence.deviceMetadata.platform} · {evidence.deviceMetadata.screen} ·{" "}
        {evidence.deviceMetadata.language}
      </dd>
      {props.submittedBy ? (
        <>
          <dt>Submitted by</dt>
          <dd>
            {props.submittedBy.name} ({props.submittedBy.title})
          </dd>
        </>
      ) : null}
    </dl>
  );
}

export function EvidenceChecks(props: { verification: Verification }): VNode {
  const v = props.verification;
  return (
    <ul className="checks">
      {v.checks.map((c) => (
        <li className={c.passed ? "pass" : "fail"}>
          <span className="mark">{c.passed ? "PASS" : v.verdict === "NEEDS_REVIEW" ? "REVIEW" : "FAIL"}</span>
          <span>
            <span className="name">{c.name}</span>
            <span className="detail">{c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function EvidenceAiResult(props: { verification: Verification }): VNode {
  const v = props.verification;
  const provenance =
    v.source === "LIVE_AI"
      ? "AI-assisted visual verification"
      : v.source === "MOCK_FALLBACK"
        ? "Demo verification fallback (live analysis unavailable)"
        : "Demo verification (deterministic mock)";
  return (
    <>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <VerdictChip verdict={v.verdict} />
      </div>
      <div className="confbar">
        <span style="font-weight:600">Confidence</span>
        <ConfidenceTrack confidence={v.confidence} />
        <span className="mono">{v.confidence.toFixed(2)}</span>
      </div>
      <p className="sub" style="margin:4px 0 0">{v.reasoning}</p>
      <p className="sub" style="margin:4px 0 0;font-size:11px;color:var(--ink-4)">
        Visual assessment: {provenance} · location &amp; metadata checks: deterministic
      </p>
    </>
  );
}

export function EvidenceHashes(props: {
  evidence: EvidenceItem;
  ledgerEntry: LedgerEntry | null;
}): VNode {
  return (
    <>
      <div className="hashline">
        <span className="lbl">Evidence hash (sha-256)</span>
        {props.evidence.hash}
      </div>
      {props.ledgerEntry ? (
        <>
          <div className="hashline">
            <span className="lbl">Previous ledger hash</span>
            {props.ledgerEntry.previousHash}
          </div>
          <div className="hashline">
            <span className="lbl">Ledger entry #{props.ledgerEntry.seq} — current hash</span>
            {props.ledgerEntry.currentHash}
          </div>
        </>
      ) : (
        <div className="hashline">
          <span className="lbl">Ledger</span>
          Not entered — evidence is only ledgered once verified.
        </div>
      )}
    </>
  );
}

/**
 * Reusable Evidence Panel — the chain of proof for one evidence item.
 */
export function EvidencePanel(props: {
  evidence: EvidenceItem;
  verification: Verification | null;
  ledgerEntry: LedgerEntry | null;
  requirement: string;
  submittedBy?: User | null;
  approval?: ApprovalRequest | null;
  accountStatus?: AccountStatus;
}): VNode {
  const { evidence, verification, ledgerEntry } = props;
  return (
    <div className="panel">
      <div className="evidence-panel">
        <div className="photo">
          <img src={evidence.photoPath} alt="Field evidence photo" />
        </div>
        <div className="facts">
          <div className="ev-sec">Original evidence</div>
          <EvidenceStatusChips verification={verification} isDemoFallback={evidence.isDemoFallback} />
          <EvidenceFacts evidence={evidence} requirement={props.requirement} submittedBy={props.submittedBy} />
          {verification ? (
            <>
              <div className="ev-sec">Verification checks</div>
              <EvidenceChecks verification={verification} />
              <div className="ev-sec">AI verification result</div>
              <EvidenceAiResult verification={verification} />
            </>
          ) : null}
          <div className="ev-sec">Proof integrity</div>
          <EvidenceHashes evidence={evidence} ledgerEntry={ledgerEntry} />
        </div>
      </div>
      <ProofRail
        verification={verification}
        ledgerEntry={ledgerEntry}
        approval={props.approval}
        accountStatus={props.accountStatus}
      />
    </div>
  );
}

/** Chain-of-proof rail — the product story on one line. */
export function ProofRail(props: {
  verification: Verification | null;
  ledgerEntry: LedgerEntry | null;
  approval?: ApprovalRequest | null;
  accountStatus?: AccountStatus;
}): VNode {
  const { verification, ledgerEntry } = props;
  const passed = verification ? verification.checks.filter((c) => c.passed).length : 0;
  const total = verification ? verification.checks.length : 0;
  return (
    <div className="proof-rail">
      <span className="step">PHOTO</span>
      <span className="arrow">→</span>
      {verification ? (
        <>
          <span className={`step ${passed === total ? "ok" : "warn"}`}>
            {passed}/{total} CHECKS PASSED
          </span>
          <span className="arrow">→</span>
          <span className="step">{verification.confidence.toFixed(2)} CONFIDENCE</span>
          <span className="arrow">→</span>
          <span className={`step ${verification.verdict === "VERIFIED" ? "ok" : "warn"}`}>
            {verification.verdict.replace(/_/g, " ")}
          </span>
        </>
      ) : (
        <span className="step">AWAITING VERIFICATION</span>
      )}
      {ledgerEntry ? (
        <>
          <span className="arrow">→</span>
          <span className="step mono" title={ledgerEntry.currentHash}>
            LEDGER #{ledgerEntry.seq} · {shortHash(ledgerEntry.currentHash, 10)}
          </span>
        </>
      ) : null}
      {props.approval ? (
        <>
          <span className="arrow">→</span>
          <span className={`step ${props.approval.status === "APPROVED" ? "ok" : "warn"}`}>
            {props.approval.status === "APPROVED"
              ? "HUMAN APPROVED"
              : props.approval.status === "REJECTED"
                ? "APPROVAL REJECTED"
                : "HUMAN APPROVAL REQUIRED"}
          </span>
        </>
      ) : null}
      {props.accountStatus ? (
        <>
          <span className="arrow">→</span>
          <span className={`step ${props.accountStatus === "RELEASED" ? "ok" : "warn"}`}>
            FUNDS {props.accountStatus}
          </span>
        </>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------ activity feed

const ACTIVITY_META: Record<string, { tone: string; icon: () => VNode }> = {
  MILESTONE_VERIFIED: { tone: "ok", icon: () => icons.check() },
  EVIDENCE_NEEDS_REVIEW: { tone: "warn", icon: () => icons.alert() },
  EVIDENCE_REJECTED: { tone: "bad", icon: () => icons.x() },
  APPROVAL_RECORDED: { tone: "info", icon: () => icons.approvals() },
  APPROVAL_REJECTED: { tone: "bad", icon: () => icons.x() },
  TRANCHE_RELEASED: { tone: "ok", icon: () => icons.dollar() },
  INTEGRITY_CHECK: { tone: "info", icon: () => icons.shield() },
  REPORT_GENERATED: { tone: "info", icon: () => icons.reports() },
  AI_VISUAL_VERIFICATION_SUCCEEDED: { tone: "ok", icon: () => icons.insights() },
  AI_VISUAL_FALLBACK_USED: { tone: "warn", icon: () => icons.alert() },
  VERIFICATION_AGGREGATED: { tone: "info", icon: () => icons.activity() },
  APPROVAL_REQUEST_CREATED: { tone: "warn", icon: () => icons.approvals() },
  LEDGER_INTEGRITY_FAILURE: { tone: "bad", icon: () => icons.shield() },
  DEMO_RESET: { tone: "", icon: () => icons.refresh() },
};

export function ActivityFeed(props: { notifications: Notification[] }): VNode {
  if (props.notifications.length === 0) {
    return (
      <EmptyState
        icon={icons.activity()}
        title="No activity yet"
        message="Verification and governance events will appear here."
      />
    );
  }
  return (
    <ul className="activity">
      {props.notifications.map((n) => {
        const meta = ACTIVITY_META[n.type] ?? { tone: "", icon: () => icons.activity() };
        return (
          <li>
            <span className={`ico ${meta.tone}`}>{meta.icon()}</span>
            <span className="body">
              <span className="msg">{n.message}</span>
              <span className="meta">
                <span className="when">{fmtDate(n.createdAt)}</span>
                <span className="t-meta" style="font-size:9px">{n.type.replace(/_/g, " ")}</span>
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------- states

export function ConfidenceTrack(props: { confidence: number }): VNode {
  const pct = Math.round(props.confidence * 100);
  const cls = pct >= 80 ? "" : pct >= 50 ? "mid" : "low";
  return (
    <span className="track">
      <span className={`fill ${cls}`} style={`width:${pct}%;display:block`}></span>
    </span>
  );
}

export function EmptyState(props: { icon: VNode; title: string; message: string; children?: Child }): VNode {
  return (
    <div className="empty">
      <span className="ico">{props.icon}</span>
      <h4>{props.title}</h4>
      <p>{props.message}</p>
      {props.children}
    </div>
  );
}
