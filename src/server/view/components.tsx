/** Shared UI components (server-rendered TSX). */
import { h, Fragment, VNode, Child } from "./jsx";
import type {
  AccountStatus,
  ApprovalStatus,
  EvidenceItem,
  LedgerEntry,
  MilestoneStatus,
  User,
  Verdict,
  Verification,
} from "../../shared/types";

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

const MILESTONE_STATUS_META: Record<MilestoneStatus, { label: string; tone: string }> = {
  NOT_STARTED: { label: "Not started", tone: "neutral" },
  PENDING_EVIDENCE: { label: "Awaiting evidence", tone: "warn" },
  UNDER_REVIEW: { label: "Under review", tone: "info" },
  VERIFIED: { label: "Verified", tone: "info" },
  APPROVED: { label: "Approved", tone: "ok" },
  RELEASED: { label: "Released", tone: "ok" },
};

export function MilestoneStatusBadge(props: { status: MilestoneStatus }): VNode {
  const meta = MILESTONE_STATUS_META[props.status];
  return <span className={`badge ${meta.tone}`}>{meta.label}</span>;
}

export function AccountBadge(props: { status: AccountStatus }): VNode {
  return props.status === "RELEASED" ? (
    <span className="badge ok">Released</span>
  ) : (
    <span className="badge warn">Held</span>
  );
}

export function VerdictBadge(props: { verdict: Verdict }): VNode {
  const tone =
    props.verdict === "VERIFIED" ? "ok" : props.verdict === "NEEDS_REVIEW" ? "warn" : "bad";
  const label =
    props.verdict === "VERIFIED"
      ? "Verified"
      : props.verdict === "NEEDS_REVIEW"
        ? "Needs review"
        : "Rejected";
  return <span className={`badge ${tone}`}>{label}</span>;
}

export function ApprovalBadge(props: { status: ApprovalStatus }): VNode {
  const tone = props.status === "APPROVED" ? "ok" : props.status === "REJECTED" ? "bad" : "warn";
  const label =
    props.status === "APPROVED"
      ? "Approved"
      : props.status === "REJECTED"
        ? "Rejected"
        : "Pending approval";
  return <span className={`badge ${tone}`}>{label}</span>;
}

export function ConfidenceBar(props: { confidence: number }): VNode {
  const pct = Math.round(props.confidence * 100);
  const cls = pct >= 80 ? "" : pct >= 50 ? "mid" : "low";
  return (
    <div className="confbar">
      <span style="font-weight:600">Confidence</span>
      <div className="track">
        <div className={`fill ${cls}`} style={`width:${pct}%`}></div>
      </div>
      <span className="mono">{props.confidence.toFixed(2)}</span>
    </div>
  );
}

/**
 * Reusable Evidence Panel — the chain of proof for one evidence item:
 * photo -> GPS/time/device facts -> verification checks -> confidence ->
 * verdict -> ledger hash.
 */
export function EvidencePanel(props: {
  evidence: EvidenceItem;
  verification: Verification | null;
  ledgerEntry: LedgerEntry | null;
  requirement: string;
  submittedBy?: User | null;
}): VNode {
  const { evidence, verification, ledgerEntry } = props;
  return (
    <div className="panel">
      <div className="evidence-panel">
        <div className="photo">
          <img src={evidence.photoPath} alt="Field evidence photo" />
        </div>
        <div className="facts">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            {verification ? <VerdictBadge verdict={verification.verdict} /> : <span className="badge neutral">Unverified</span>}
            {evidence.isDemoFallback ? <span className="badge fallback">Demo fallback</span> : null}
          </div>

          <dl className="kv" style="margin-top:12px">
            <dt>Requirement</dt>
            <dd>{props.requirement}</dd>
            <dt>GPS</dt>
            <dd className="mono">
              {evidence.latitude.toFixed(5)}, {evidence.longitude.toFixed(5)}
            </dd>
            <dt>Captured</dt>
            <dd className="mono">{fmtDate(evidence.capturedAt)}</dd>
            <dt>Uploaded</dt>
            <dd className="mono">{fmtDate(evidence.uploadedAt)}</dd>
            <dt>Device</dt>
            <dd>
              {evidence.deviceMetadata.platform} · {evidence.deviceMetadata.screen} ·{" "}
              {evidence.deviceMetadata.language}
              <span className="mono" style="display:block;font-size:11px;color:var(--ink-mute);word-break:break-all">
                {evidence.deviceMetadata.userAgent}
              </span>
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

          {verification ? (
            <>
              <ul className="checks">
                {verification.checks.map((c) => (
                  <li className={c.passed ? "pass" : "fail"}>
                    <span className="mark">{c.passed ? "PASS" : "FAIL"}</span>
                    <span>
                      <span className="name">{c.name}</span>
                      <span className="detail">{c.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <ConfidenceBar confidence={verification.confidence} />
              <p className="sub" style="margin:6px 0 10px">{verification.reasoning}</p>
            </>
          ) : null}

          <div className="hashline">
            <span className="lbl">Evidence hash (sha-256)</span>
            <br />
            {evidence.hash}
          </div>
          {ledgerEntry ? (
            <div className="hashline">
              <span className="lbl">Ledger entry #{ledgerEntry.seq} — chained hash</span>
              <br />
              {ledgerEntry.currentHash}
              <br />
              <span className="lbl">prev</span> {shortHash(ledgerEntry.previousHash, 24)}
            </div>
          ) : (
            <div className="hashline">
              <span className="lbl">Ledger</span> not entered — evidence is only ledgered once verified
            </div>
          )}
        </div>
      </div>
      <div className="chainflow">
        <b>Chain of proof:</b>
        <span>Photo</span>→<span>{verification ? verification.checks.filter((c) => c.passed).length + "/" + verification.checks.length + " checks" : "checks pending"}</span>
        →<span>{verification ? "confidence " + verification.confidence.toFixed(2) : "confidence –"}</span>
        →<span>{verification ? verification.verdict : "verdict –"}</span>
        →<span className="mono">{ledgerEntry ? "ledger " + shortHash(ledgerEntry.currentHash, 12) : "no ledger entry"}</span>
      </div>
    </div>
  );
}

export function Layout(props: {
  title: string;
  user?: User | null;
  active?: string;
  children?: Child;
}): VNode {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} — OBV</title>
        <link rel="stylesheet" href="/styles.css" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#16283f" />
      </head>
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <span className="brand">
              <a href="/dashboard">OBV</a>
              <span className="tag">OpenBuild Verify — the truth layer for physical projects</span>
            </span>
            <nav>
              <a href="/dashboard" className={props.active === "dashboard" ? "active" : ""}>
                Dashboard
              </a>
              <a href="/field" className={props.active === "field" ? "active" : ""}>
                Field capture
              </a>
            </nav>
            <span className="who">
              {props.user ? (
                <>
                  <span>
                    {props.user.name} · {props.user.title}
                  </span>
                  <a href="/">Switch user</a>
                </>
              ) : (
                <a href="/">Select demo user</a>
              )}
            </span>
          </div>
        </header>
        <main className="wrap">{props.children}</main>
      </body>
    </html>
  );
}
