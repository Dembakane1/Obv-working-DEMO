/**
 * Adaptive Card builders — restrained institutional cards for the Teams
 * notification channel. Teams is a notification channel only: no card may
 * imply that AI released funds, that Teams approved anything, or that a
 * real bank transfer occurred in the demo.
 */
import type {
  ApprovalRecord,
  ApprovalRequest,
  Milestone,
  Project,
  User,
  UserRole,
  Verification,
} from "../../shared/types";

type CardElement = Record<string, unknown>;
export type AdaptiveCard = Record<string, unknown>;

const NAVY = "default";

function roleLabel(r: UserRole): string {
  return {
    FUNDER_REP: "Funder Representative",
    PROJECT_MANAGER: "Project Manager",
    COMPLIANCE_REVIEWER: "Compliance Reviewer",
    FIELD: "Field Engineer",
  }[r];
}

const money = (n: number) => "$" + n.toLocaleString("en-US");
const ts = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, " UTC");

function facts(pairs: Array<[string, string | null | undefined]>): CardElement {
  return {
    type: "FactSet",
    facts: pairs
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([title, value]) => ({ title, value })),
  };
}

function header(eventLabel: string, tone: "good" | "warning" | "attention" | "accent"): CardElement[] {
  return [
    {
      type: "TextBlock",
      text: "OBV · OpenBuild Verify",
      size: "small",
      weight: "bolder",
      color: NAVY,
      spacing: "none",
    },
    {
      type: "TextBlock",
      text: eventLabel,
      size: "medium",
      weight: "bolder",
      color: tone,
      spacing: "small",
      wrap: true,
    },
  ];
}

function card(body: CardElement[], linkPath?: string): AdaptiveCard {
  // Explicit OBV_PUBLIC_BASE_URL wins; RENDER_EXTERNAL_URL is provided
  // automatically by Render so links work without extra configuration.
  const base = (
    process.env.OBV_PUBLIC_BASE_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    ""
  ).replace(/\/$/, "");
  const actions =
    base && linkPath
      ? [{ type: "Action.OpenUrl", title: "Open in OBV", url: `${base}${linkPath}` }]
      : undefined;
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
    ...(actions ? { actions } : {}),
  };
}

export interface EvidenceCardContext {
  project: Project;
  milestone: Milestone;
  verification: Verification;
  submittedBy?: User | null;
}

/** CARD 1 — Milestone Verified. */
export function milestoneVerifiedCard(c: EvidenceCardContext): AdaptiveCard {
  const method =
    c.verification.source === "LIVE_AI"
      ? "Live multimodal visual assessment + deterministic checks"
      : "Demo fallback visual assessment + deterministic checks";
  return card(
    [
      ...header("Milestone Verified", "good"),
      facts([
        ["Project", c.project.name],
        ["Milestone", `M${c.milestone.seq} · ${c.milestone.title}`],
        ["Verification result", "VERIFIED"],
        ["Confidence", c.verification.confidence.toFixed(2)],
        ["Verification method", method],
        ["Evidence source", c.submittedBy ? `${c.submittedBy.name} (${c.submittedBy.title})` : "Field submission"],
        ["Financial state", `HELD — ${money(c.milestone.trancheAmount)}`],
        ["Timestamp", ts(c.verification.createdAt)],
      ]),
      {
        type: "TextBlock",
        text: "**Funds remain HELD pending required human approval.**",
        wrap: true,
        spacing: "medium",
      },
    ],
    `/milestone/${c.milestone.id}`
  );
}

/** CARD 2 — Evidence Needs Review. */
export function needsReviewCard(c: EvidenceCardContext): AdaptiveCard {
  const flagged = c.verification.checks.filter((ch) => !ch.passed);
  return card(
    [
      ...header("Evidence Needs Review", "warning"),
      facts([
        ["Project", c.project.name],
        ["Milestone", `M${c.milestone.seq} · ${c.milestone.title}`],
        ["Reason", c.verification.reasoning],
        ["Flagged checks", flagged.map((ch) => ch.name).join("; ") || "aggregate confidence"],
        ["Confidence", c.verification.confidence.toFixed(2)],
        ["Submitted by", c.submittedBy ? c.submittedBy.name : "Field submission"],
        ["Timestamp", ts(c.verification.createdAt)],
      ]),
      {
        type: "TextBlock",
        text: "**Human review required.** No release eligibility exists for this evidence.",
        wrap: true,
        spacing: "medium",
      },
    ],
    `/milestone/${c.milestone.id}`
  );
}

/** CARD 3 — Evidence Rejected. */
export function rejectedCard(c: EvidenceCardContext): AdaptiveCard {
  const failed = c.verification.checks.filter((ch) => !ch.passed);
  return card(
    [
      ...header("Evidence Rejected", "attention"),
      facts([
        ["Project", c.project.name],
        ["Milestone", `M${c.milestone.seq} · ${c.milestone.title}`],
        ["Reason", c.verification.reasoning],
        ["Failed checks", failed.map((ch) => ch.name).join("; ")],
        ["Submitted by", c.submittedBy ? c.submittedBy.name : "Field submission"],
        ["Timestamp", ts(c.verification.createdAt)],
      ]),
      {
        type: "TextBlock",
        text: "No release eligibility created. Funds remain HELD.",
        wrap: true,
        spacing: "medium",
      },
    ],
    `/milestone/${c.milestone.id}`
  );
}

/** CARD 4 — Approval Request Created. */
export function approvalRequestCard(c: EvidenceCardContext & { approval: ApprovalRequest }): AdaptiveCard {
  return card(
    [
      ...header("Approval Request Created", "accent"),
      facts([
        ["Project", c.project.name],
        ["Milestone", `M${c.milestone.seq} · ${c.milestone.title}`],
        ["Tranche amount", money(c.milestone.trancheAmount)],
        ["Verification verdict", c.verification.verdict],
        ["Confidence", c.verification.confidence.toFixed(2)],
        ["Required roles", c.approval.requiredRoles.map(roleLabel).join(" + ")],
        ["Approval progress", `0 of ${c.approval.requiredRoles.length}`],
        ["Financial state", "HELD"],
        ["Timestamp", ts(c.approval.createdAt)],
      ]),
    ],
    `/approvals`
  );
}

export interface ApprovalCardContext {
  project: Project;
  milestone: Milestone;
  approval: ApprovalRequest;
  records: ApprovalRecord[];
  actor: User;
  decision: "APPROVED" | "REJECTED";
}

/** CARD 5 — Approval Recorded. */
export function approvalRecordedCard(c: ApprovalCardContext): AdaptiveCard {
  const approved = c.records.filter((r) => r.decision === "APPROVED").length;
  const missing = c.approval.requiredRoles.filter(
    (role) => !c.records.some((r) => r.role === role)
  );
  return card(
    [
      ...header("Approval Recorded", "good"),
      facts([
        ["Project", c.project.name],
        ["Milestone", `M${c.milestone.seq} · ${c.milestone.title}`],
        ["Approver", c.actor.name],
        ["Role", roleLabel(c.actor.role)],
        ["Decision", "APPROVED"],
        ["Progress", `${approved} of ${c.approval.requiredRoles.length} approvals complete`],
        ["Still awaiting", missing.length > 0 ? missing.map(roleLabel).join(", ") : "—"],
        ["Funds", "HELD"],
      ]),
    ],
    `/approvals`
  );
}

/** CARD 6 — Approval Rejected / Returned for Review. */
export function approvalRejectedCard(c: ApprovalCardContext): AdaptiveCard {
  return card(
    [
      ...header("Approval Rejected — Returned for Review", "attention"),
      facts([
        ["Project", c.project.name],
        ["Milestone", `M${c.milestone.seq} · ${c.milestone.title}`],
        ["Decided by", c.actor.name],
        ["Role", roleLabel(c.actor.role)],
        ["Amount affected", money(c.milestone.trancheAmount)],
        ["Financial state", "HELD — new evidence required"],
      ]),
    ],
    `/approvals`
  );
}

/** CARD 7 — Tranche Released (virtual account state transition). */
export function trancheReleasedCard(c: {
  project: Project;
  milestone: Milestone;
  approval: ApprovalRequest;
  records: ApprovalRecord[];
  approversByRecord: Map<string, User | undefined>;
  verification: Verification | null;
  chainValid: boolean;
}): AdaptiveCard {
  const approvers = c.records
    .filter((r) => r.decision === "APPROVED")
    .map((r) => {
      const u = c.approversByRecord.get(r.id);
      return `${u?.name ?? roleLabel(r.role)} (${roleLabel(r.role)}) — ${ts(r.createdAt)}`;
    })
    .join("\n\n");
  return card(
    [
      ...header("Tranche Released — Virtual Account State Transition", "good"),
      facts([
        ["Project", c.project.name],
        ["Milestone", `M${c.milestone.seq} · ${c.milestone.title}`],
        ["Amount", money(c.milestone.trancheAmount)],
        ["Final verification verdict", c.verification?.verdict ?? "VERIFIED"],
        ["Confidence", c.verification ? c.verification.confidence.toFixed(2) : "—"],
        ["Ledger integrity", c.chainValid ? "CHAIN INTACT" : "TAMPERING DETECTED"],
        ["Virtual account state", "RELEASED"],
      ]),
      {
        type: "TextBlock",
        text: "**Authorized by:**\n\n" + approvers,
        wrap: true,
        spacing: "medium",
      },
      {
        type: "TextBlock",
        text:
          "Demo environment: this event represents the OBV Virtual Account state transition. " +
          "Production disbursement would occur through regulated banking rails.",
        wrap: true,
        isSubtle: true,
        size: "small",
        spacing: "medium",
      },
    ],
    `/project/${c.project.id}`
  );
}

/** CARD 8 — Evidence Ledger Integrity Alert. */
export function integrityFailureCard(c: {
  project: Project | null;
  brokenAt: number | undefined;
  checkedAt: string;
}): AdaptiveCard {
  return card(
    [
      ...header("Evidence Ledger Integrity Alert", "attention"),
      facts([
        ["Project", c.project?.name ?? "All projects (global ledger)"],
        ["First affected entry", c.brokenAt !== undefined ? `#${c.brokenAt}` : "unknown"],
        ["Integrity check run", ts(c.checkedAt)],
        ["Current state", "TAMPERING DETECTED"],
      ]),
      {
        type: "TextBlock",
        text:
          "**Entries at and after the affected position cannot be relied upon.** " +
          "Investigate before accepting reports or authorizing releases.",
        wrap: true,
        spacing: "medium",
      },
    ],
    `/ledger`
  );
}
