/**
 * Microsoft Teams integration: adaptive-card-READY payload builders.
 *
 * Pure functions from verified-record facts to Adaptive Card 1.5 JSON —
 * no live Teams dependency, no network, no credentials. Delivery remains
 * the concern of the existing Teams notifier (when a webhook is
 * configured) or the outbound webhook framework; this module only shapes
 * what would be sent, so every event kind has a stable, testable payload.
 */
import { IntegrationError } from "./core";

export const TEAMS_EVENT_KINDS = [
  "DRAW_SUBMITTED",
  "DRAW_APPROVED",
  "DISPUTE_OPENED",
  "INSPECTION_COMPLETED",
  "FRAUD_ALERT",
  "PORTFOLIO_ALERT",
  "EXECUTIVE_SUMMARY",
] as const;
export type TeamsEventKind = (typeof TEAMS_EVENT_KINDS)[number];

export interface TeamsCardInput {
  kind: TeamsEventKind;
  title: string;
  projectName?: string | null;
  organizationName?: string | null;
  amount?: string | null;
  status?: string | null;
  summary?: string | null;
  facts?: Array<{ label: string; value: string }>;
  advisory?: string | null;
}

const ACCENT: Record<TeamsEventKind, "default" | "good" | "attention" | "warning" | "accent"> = {
  DRAW_SUBMITTED: "accent",
  DRAW_APPROVED: "good",
  DISPUTE_OPENED: "attention",
  INSPECTION_COMPLETED: "good",
  FRAUD_ALERT: "attention",
  PORTFOLIO_ALERT: "warning",
  EXECUTIVE_SUMMARY: "default",
};

/** Build one Teams message payload carrying an Adaptive Card 1.5. */
export function buildTeamsCard(input: TeamsCardInput): Record<string, unknown> {
  if (!TEAMS_EVENT_KINDS.includes(input.kind)) {
    throw new IntegrationError(`Unknown Teams event kind: ${String(input.kind)}`);
  }
  const title = String(input.title ?? "").trim();
  if (!title) throw new IntegrationError("A card title is required");
  const facts = [
    ...(input.projectName ? [{ title: "Project", value: input.projectName }] : []),
    ...(input.organizationName ? [{ title: "Organization", value: input.organizationName }] : []),
    ...(input.amount ? [{ title: "Amount", value: input.amount }] : []),
    ...(input.status ? [{ title: "Status", value: input.status }] : []),
    ...(input.facts ?? []).map((f) => ({ title: f.label, value: f.value })),
  ];
  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      size: "Medium",
      weight: "Bolder",
      color: ACCENT[input.kind] === "attention" ? "Attention" : "Default",
      text: title,
      wrap: true,
    },
    { type: "TextBlock", spacing: "None", isSubtle: true, text: input.kind.replace(/_/g, " "), wrap: true },
  ];
  if (facts.length > 0) body.push({ type: "FactSet", facts });
  if (input.summary) body.push({ type: "TextBlock", text: input.summary, wrap: true });
  // Advisory framing is part of the payload, not a UI nicety: cards about
  // fraud signals and portfolio analytics must state they approve nothing.
  const advisory =
    input.advisory ??
    (input.kind === "FRAUD_ALERT" || input.kind === "PORTFOLIO_ALERT" || input.kind === "EXECUTIVE_SUMMARY"
      ? "Advisory only — this signal does not approve draws or alter records."
      : null);
  if (advisory) {
    body.push({ type: "TextBlock", size: "Small", isSubtle: true, text: advisory, wrap: true });
  }
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.5",
          body,
        },
      },
    ],
  };
}
