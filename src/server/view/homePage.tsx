/**
 * OpenBuild Verify — public enterprise homepage (/).
 *
 * Marketing/positioning surface only: server-rendered, no application
 * shell, no session, no mutation. The product frame in the hero renders
 * REAL values read from the seeded demo records (never predictions, never
 * invented figures); when the database is empty it shows an honest empty
 * state. All calls to action lead to /demo (the seeded role selector) or
 * to existing application routes — no fake authentication, no invented
 * pages.
 */
import { h, Fragment, renderDocument, VNode } from "./jsx";
import { brandMark, icons } from "./icons";
import { money, STYLESHEET_HREF } from "./components";

export interface HomeSnapshot {
  projectName: string;
  verifiedPhysicalPct: number;
  claimedFinancialPct: number;
  drawRequested: number;
  /** Reviewer-recorded supportable value; null until reviewed. */
  drawSupportable: number | null;
  /** Open draw value carrying missing-document or HIGH/CRITICAL exception blockers. */
  blockedAmount: number;
  pendingInspections: number;
  highCriticalExceptions: number;
  fundsHeld: number;
  retainageWithheld: number;
  evidenceAwaitingReview: number;
  recentExceptions: Array<{ severity: string; title: string }>;
  milestones: Array<{ label: string; state: "RELEASED" | "HELD" }>;
}

const NAV = [
  ["#platform", "Platform"],
  ["#how", "How It Works"],
  ["#solutions", "Solutions"],
  ["#security", "Security"],
] as const;

const WORKFLOW: Array<[string, string]> = [
  ["Field Evidence", "Timestamped photos, GPS and device metadata captured in the field by attributable users."],
  ["Verification", "Deterministic location, metadata and integrity checks with labeled assessment provenance."],
  ["Completion & Inspection Gates", "Contractor reports, evidence review, inspection requirements and jurisdictional results are evaluated separately."],
  ["Draw Review", "Draw lines are reviewed against verified progress, budget and document requirements."],
  ["Human Governance", "Authorized reviewers approve with attributable decisions and a complete approval history."],
  ["Controlled Release", "Funds remain held until every required governance decision is recorded — exactly once."],
  ["Audit Package", "Complete, exportable registers for lenders, auditors and regulators with integrity records."],
];

const CAPABILITIES: Array<{ title: string; copy: string; href: string; icon: () => VNode }> = [
  {
    title: "Evidence Verification",
    copy: "Timestamped field evidence, GPS and metadata checks, reviewer attribution, and verification provenance.",
    href: "/compliance",
    icon: () => icons.camera(),
  },
  {
    title: "Draw Control",
    copy: "Requested, supportable, recommended, formally approved, retained, blocked, held, and released values remain distinct.",
    href: "/draws",
    icon: () => icons.dollar(),
  },
  {
    title: "Completion & Inspection Gates",
    copy: "Contractor completion, OBV evidence review, inspection requirements, jurisdictional results, governance, and funds state remain separate.",
    href: "/projects",
    icon: () => icons.check(),
  },
  {
    title: "Exceptions & Risk Controls",
    copy: "Source-linked blockers, missing documents, failed inspections, approval delays, budget variance, and control failures.",
    href: "/exceptions",
    icon: () => icons.alert(),
  },
  {
    title: "Audit-Ready Reporting",
    copy: "Lender draw packages, project audit exports, evidence registers, approval history, and package integrity records.",
    href: "/reports",
    icon: () => icons.reports(),
  },
  {
    title: "Control Intelligence",
    copy: "Portfolio health, governed action queues, blocked capital, inspection exposure, workload, and project attention priorities.",
    href: "/insights",
    icon: () => icons.insights(),
  },
];

const AUDIENCES: Array<[string, string]> = [
  ["Construction Lenders", "Reduce manual draw administration while preserving controlled, attributable approval decisions."],
  ["Infrastructure Funders", "Connect milestone payments to verified physical evidence and governed completion requirements."],
  ["Compliance & Review Teams", "Trace important statuses to evidence, source records, policy logic, reviewer activity, and audit history."],
  ["Field & Project Teams", "Capture evidence, respond to clarifications, document issues, and maintain an attributable field record."],
];

const GOVERNANCE_POINTS: string[] = [
  "Role-based access with organization-scoped records",
  "Attributable reviewer actions on every decision",
  "Deterministic control rules with documented precedence",
  "Human approval requirements — no automatic approvals",
  "Evidence provenance labeled on every assessment",
  "Ledger-backed, hash-chained audit sequencing",
  "Source-linked exceptions with reconciliation semantics",
  "Controlled financial-state transitions, exactly once",
  "Funds remain held until required governance is satisfied",
  "No AI authorization of funds release",
];

function metric(label: string, value: string, tone?: string, sub?: string): VNode {
  return (
    <div className={`hp-metric ${tone ?? ""}`}>
      <span className="v">{value}</span>
      <span className="l">{label}</span>
      {sub ? <span className="s">{sub}</span> : null}
    </div>
  );
}

/** The hero product frame — real seeded values, honest empty state. */
function ProductFrame(props: { snap: HomeSnapshot | null }): VNode {
  const s = props.snap;
  if (!s) {
    return (
      <div className="hp-frame" role="img" aria-label="OBV project control overview (demo data not seeded)">
        <div className="hp-frame-bar"><span className="hp-frame-brand">{brandMark(14)} OBV</span></div>
        <p className="hp-frame-empty">Demo data has not been seeded on this deployment yet.</p>
      </div>
    );
  }
  return (
    <div
      className="hp-frame"
      role="img"
      aria-label={`OBV project control overview for ${s.projectName}: verified physical progress ${s.verifiedPhysicalPct}%, claimed financial progress ${s.claimedFinancialPct}%, funds held ${money(s.fundsHeld)}`}
    >
      <div className="hp-frame-bar">
        <span className="hp-frame-brand">{brandMark(14)} OBV</span>
        <span className="hp-frame-proj">{s.projectName}</span>
        <span className="hp-frame-live">LIVE DEMO DATA</span>
      </div>
      <div className="hp-frame-title">Project control overview</div>
      <div className="hp-frame-grid">
        {metric("Verified physical progress", `${s.verifiedPhysicalPct}%`, "", "milestone-verification grounded")}
        {metric("Financial progress (claimed)", `${s.claimedFinancialPct}%`, "", "includes open draw requests")}
        {metric("Draw requested", money(s.drawRequested))}
        {metric("Supportable (reviewed)", s.drawSupportable === null ? "NOT AVAILABLE" : money(s.drawSupportable))}
        {metric("Blocked amount", money(s.blockedAmount), "bad", "missing documents / open exceptions")}
        {metric("Pending inspections", String(s.pendingInspections), s.pendingInspections > 0 ? "warn" : "")}
        {metric("HIGH / CRITICAL exceptions", String(s.highCriticalExceptions), s.highCriticalExceptions > 0 ? "bad" : "")}
        {metric("Funds currently held", money(s.fundsHeld), "hold")}
      </div>
      <div className="hp-frame-cols">
        <div className="hp-frame-panel">
          <span className="h">Budget vs verified progress</span>
          <div className="hp-bar-row">
            <span className="m">Financial (claimed)</span>
            <span className="bar"><span className="fl fin" style={`width:${Math.min(100, s.claimedFinancialPct)}%`}></span></span>
            <span className="n">{s.claimedFinancialPct}%</span>
          </div>
          <div className="hp-bar-row">
            <span className="m">Verified physical</span>
            <span className="bar"><span className="fl phys" style={`width:${Math.min(100, s.verifiedPhysicalPct)}%`}></span></span>
            <span className="n">{s.verifiedPhysicalPct}%</span>
          </div>
          <span className="h" style="margin-top:12px">Milestone funds state</span>
          <div className="hp-ms-strip">
            {s.milestones.map((m) => (
              <span className={`hp-ms ${m.state === "RELEASED" ? "ok" : "hold"}`} title={`${m.label} — ${m.state}`}>
                {m.label.split(" ")[0]}
              </span>
            ))}
          </div>
        </div>
        <div className="hp-frame-panel">
          <span className="h">Recent exceptions</span>
          {s.recentExceptions.length === 0 ? (
            <p className="hp-frame-none">No open exceptions.</p>
          ) : (
            s.recentExceptions.map((e) => (
              <div className="hp-exc">
                <span className={`sev ${e.severity === "HIGH" || e.severity === "CRITICAL" ? "bad" : "warn"}`}>{e.severity}</span>
                <span className="t">{e.title}</span>
              </div>
            ))
          )}
          <span className="h" style="margin-top:12px">Also tracked</span>
          <p className="hp-frame-note">
            {s.evidenceAwaitingReview} evidence item(s) awaiting review · {money(s.retainageWithheld)} retainage withheld
          </p>
        </div>
      </div>
    </div>
  );
}

export function renderHome(snap: HomeSnapshot | null): string {
  return renderDocument(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>OpenBuild Verify — Verify physical progress before capital moves</title>
        <meta
          name="description"
          content="OBV gives construction lenders and infrastructure funders an evidence-grounded control layer for draw verification, inspections, approvals, exceptions, and audit-ready reporting."
        />
        <link rel="stylesheet" href={STYLESHEET_HREF} />
        <link rel="icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#0d1626" />
      </head>
      <body className="hp-body">
        {/* ---- 1 · enterprise navigation ---- */}
        <header className="hp-nav">
          <a className="hp-brand" href="/" aria-label="OpenBuild Verify home">
            <span className="mark">{brandMark(20)}</span>
            <span className="n">OBV</span>
            <span className="w">OpenBuild Verify</span>
          </a>
          <nav className="hp-links" aria-label="Primary">
            {NAV.map(([href, label]) => (
              <a href={href}>{label}</a>
            ))}
          </nav>
          <div className="hp-nav-cta">
            <a className="hp-btn ghost sm" href="/demo">Enter Demo</a>
            <a className="hp-btn primary sm" href="/demo" title="Demonstration access — production authentication uses organization accounts">
              Sign In
            </a>
          </div>
          <details className="hp-burger">
            <summary aria-label="Open navigation menu">{icons.more(18)}</summary>
            <nav aria-label="Mobile">
              {NAV.map(([href, label]) => (
                <a href={href}>{label}</a>
              ))}
              <a href="/demo">Enter Demo</a>
              <a href="/demo" title="Demonstration access">Sign In</a>
            </nav>
          </details>
        </header>

        {/* ---- 2 · hero ---- */}
        <section className="hp-hero" id="top">
          <div className="hp-hero-inner">
            <div className="hp-hero-copy">
              <h1>Verify physical progress before capital moves.</h1>
              <p className="lead">
                OBV gives construction lenders and infrastructure funders an evidence-grounded
                control layer for draw verification, inspections, approvals, exceptions, and
                audit-ready reporting.
              </p>
              <div className="hp-cta-row">
                <a className="hp-btn primary" href="#platform">Explore the Platform</a>
                <a className="hp-btn ghost" href="/demo">Enter Live Demo</a>
              </div>
            </div>
            <ProductFrame snap={snap} />
          </div>

          {/* ---- 3 · trust statement ---- */}
          <div className="hp-trust" role="list">
            {[
              [icons.camera(), "Evidence captured in the field."],
              [icons.check(), "Controls evaluated consistently."],
              [icons.user(), "Approvals governed by accountable people."],
              [icons.ledger(), "Every material decision preserved for audit."],
            ].map(([ic, t]) => (
              <span className="hp-trust-item" role="listitem">
                <i aria-hidden="true">{ic}</i>
                {t}
              </span>
            ))}
          </div>
        </section>

        {/* ---- 4 · control workflow ---- */}
        <section className="hp-section" id="how">
          <h2>How OBV works</h2>
          <p className="hp-section-sub">
            AI can assess and explain evidence. Deterministic services evaluate controlled
            conditions. Authorized humans approve. Funds remain held until required governance is
            satisfied — and the ledger preserves every material event.
          </p>
          <ol className="hp-flow">
            {WORKFLOW.map(([title, copy], i) => (
              <li className="hp-step">
                <span className="num" aria-hidden="true">{i + 1}</span>
                <span className="t">{title}</span>
                <span className="c">{copy}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* ---- 5 · platform capabilities ---- */}
        <section className="hp-section alt" id="platform">
          <h2>Platform capabilities</h2>
          <div className="hp-caps">
            {CAPABILITIES.map((c) => (
              <a className="hp-cap" href={c.href}>
                <i aria-hidden="true">{c.icon()}</i>
                <span className="t">{c.title}</span>
                <span className="c">{c.copy}</span>
                <span className="go">View in the demo →</span>
              </a>
            ))}
          </div>
          <p className="hp-fine">
            Capability links open the corresponding screen of the demonstration environment after
            role selection.
          </p>
        </section>

        {/* ---- 6 · solutions by audience ---- */}
        <section className="hp-section" id="solutions">
          <h2>Solutions by audience</h2>
          <div className="hp-aud">
            {AUDIENCES.map(([t, c]) => (
              <div className="hp-aud-card">
                <span className="t">{t}</span>
                <span className="c">{c}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ---- 7 · control intelligence ---- */}
        <section className="hp-section alt" id="intelligence">
          <h2>Know what requires attention before approving the next draw.</h2>
          <p className="hp-section-sub">
            OBV Control Intelligence surfaces grounded, source-linked conditions from governed
            records — never success probabilities, never invented forecasts.
          </p>
          {snap ? (
            <div className="hp-int-chips" role="list">
              <span className="hp-int-chip bad" role="listitem">{money(snap.blockedAmount)} draw value blocked</span>
              <span className="hp-int-chip" role="listitem">{snap.evidenceAwaitingReview} evidence item(s) awaiting review</span>
              <span className="hp-int-chip warn" role="listitem">{snap.pendingInspections} required inspection(s) pending</span>
              <span className="hp-int-chip bad" role="listitem">{snap.highCriticalExceptions} HIGH / CRITICAL exception(s)</span>
              <span className="hp-int-chip warn" role="listitem">
                Financial progress {snap.claimedFinancialPct}% vs verified physical {snap.verifiedPhysicalPct}%
              </span>
              <span className="hp-int-chip hold" role="listitem">{money(snap.fundsHeld)} funds held</span>
              <span className="hp-int-chip" role="listitem">{money(snap.retainageWithheld)} retainage withheld</span>
            </div>
          ) : null}
          <p className="hp-fine">Figures above are live values from the seeded demonstration project.</p>
        </section>

        {/* ---- 8 · enterprise trust & governance ---- */}
        <section className="hp-section dark" id="security">
          <h2>Enterprise trust &amp; governance</h2>
          <div className="hp-gov">
            <ul className="hp-gov-list">
              {GOVERNANCE_POINTS.map((p) => (
                <li>{icons.check(13)} {p}</li>
              ))}
            </ul>
            <div className="hp-gov-note">
              <p className="hp-ai-boundary">
                OBV may use AI to assess image semantics and explain governed results. AI does not
                independently approve work, verify location, resolve authoritative exceptions,
                change financial state, or authorize funds release.
              </p>
              <p className="hp-fine">
                This demonstration build makes no certification claims. Production deployments are
                assessed against the customer's compliance requirements.
              </p>
            </div>
          </div>
        </section>

        {/* ---- 9 · enterprise demo CTA ---- */}
        <section className="hp-section hp-final">
          <h2>See how OBV governs a construction draw from evidence to release.</h2>
          <div className="hp-cta-row center">
            <a className="hp-btn primary" href="/demo">Enter the Demonstration</a>
            <a className="hp-btn ghost" href="#platform">Explore the Platform</a>
          </div>
        </section>

        {/* ---- 10 · footer ---- */}
        <footer className="hp-footer">
          <span className="hp-brand small">
            <span className="mark">{brandMark(16)}</span> OpenBuild Verify
          </span>
          <nav aria-label="Footer">
            <a href="#platform">Platform</a>
            <a href="#solutions">Solutions</a>
            <a href="#security">Security</a>
            <a href="/demo">Enter Demo</a>
            <span className="hp-dis" title="Available when the legal pages are published">Privacy</span>
            <span className="hp-dis" title="Available when the legal pages are published">Terms</span>
          </nav>
        </footer>
      </body>
    </html>
  );
}
