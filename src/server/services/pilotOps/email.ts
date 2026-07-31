/**
 * Transactional email abstraction.
 *
 * OBV_EMAIL_PROVIDER selects a registered adapter by name; nothing in the
 * application knows any provider's API. The default "log" adapter records
 * the send in the email_outbox and delivers nothing off the machine —
 * exactly right for pilots and tests. A real adapter would implement the
 * same three-line EmailProvider interface.
 *
 * Production posture mirrors the banking registry: a non-log provider is
 * refused unless OBV_EMAIL_MODE=production AND OBV_EMAIL_PRODUCTION_ENABLE
 * is explicitly true, so a demo deployment can never accidentally email
 * real people. The outbox row is the audit record of every send attempt;
 * failure categories are sanitized — never provider payloads.
 */
import type { User } from "../../../shared/types";
import * as prepo from "../../db/pilotOpsRepo";
import { PilotOpsError } from "./core";

export interface EmailMessage {
  toAddress: string;
  toUserId: string | null;
  template: string;
  subject: string;
  body: string;
  refType: string | null;
  refId: string | null;
}

export interface EmailProvider {
  name: string;
  send(message: EmailMessage): { ok: boolean; failureCategory?: string };
}

/** Records the send and delivers nothing — the pilot/test default. */
const logProvider: EmailProvider = {
  name: "log",
  send: () => ({ ok: true }),
};

/** Deterministic failure adapter so failure handling is testable. */
const failProvider: EmailProvider = {
  name: "always-fail",
  send: () => ({ ok: false, failureCategory: "PROVIDER_UNAVAILABLE" }),
};

const REGISTRY: Record<string, EmailProvider> = {
  log: logProvider,
  "always-fail": failProvider,
};

export function emailMode(): "demo" | "production" {
  return (process.env.OBV_EMAIL_MODE ?? "demo").toLowerCase() === "production" ? "production" : "demo";
}

export function resolveEmailProvider(): EmailProvider {
  const raw = (process.env.OBV_EMAIL_PROVIDER ?? "log").toLowerCase();
  const provider = REGISTRY[raw];
  if (!provider) {
    throw new PilotOpsError(`Unknown email provider "${raw}"`, 500);
  }
  if (provider.name !== "log" && provider.name !== "always-fail") {
    if (emailMode() !== "production" || process.env.OBV_EMAIL_PRODUCTION_ENABLE !== "true") {
      throw new PilotOpsError(
        "A live email provider requires OBV_EMAIL_MODE=production and OBV_EMAIL_PRODUCTION_ENABLE=true",
        403
      );
    }
  }
  return provider;
}

export interface EmailTemplateInput {
  recipientName: string;
  [key: string]: string;
}

/** Provider-neutral templates. Plain text, no tracking, no links to
 *  anything the recipient cannot already access. */
export const EMAIL_TEMPLATES: Record<string, { subject: (i: EmailTemplateInput) => string; body: (i: EmailTemplateInput) => string }> = {
  INVITATION: {
    subject: (i) => `You are invited to join ${i.organizationName} on OpenBuild Verify`,
    body: (i) =>
      `Hello ${i.recipientName},\n\n${i.inviterName} invited you to join ${i.organizationName} on OpenBuild Verify.\n` +
      `Open your activation link to accept. The link can be used once and expires.\n\n— OpenBuild Verify`,
  },
  ORG_INVITE: {
    subject: (i) => `Your organization has been set up on OpenBuild Verify`,
    body: (i) =>
      `Hello ${i.recipientName},\n\n${i.organizationName} is ready on OpenBuild Verify. Sign in to begin onboarding.\n\n— OpenBuild Verify`,
  },
  PASSWORD_RESET: {
    subject: () => "Reset your OpenBuild Verify access",
    body: (i) =>
      `Hello ${i.recipientName},\n\nA credential reset was requested for your account. If you did not request this, ignore this message.\n\n— OpenBuild Verify`,
  },
  DRAW_STATUS: {
    subject: (i) => `Draw #${i.drawNumber} — ${i.statusLabel}`,
    body: (i) =>
      `Hello ${i.recipientName},\n\nDraw #${i.drawNumber} on ${i.projectName} is now: ${i.statusLabel}.\n\n— OpenBuild Verify`,
  },
  APPROVAL_REQUEST: {
    subject: (i) => `Approval requested — ${i.subjectLabel}`,
    body: (i) =>
      `Hello ${i.recipientName},\n\nAn approval is waiting for your review: ${i.subjectLabel}.\n\n— OpenBuild Verify`,
  },
  WEEKLY_PORTFOLIO_SUMMARY: {
    subject: () => "Your weekly OpenBuild Verify portfolio summary",
    body: (i) => `Hello ${i.recipientName},\n\n${i.summaryText}\n\n— OpenBuild Verify`,
  },
  DAILY_DIGEST: {
    subject: () => "Your daily OpenBuild Verify digest",
    body: (i) => `Hello ${i.recipientName},\n\n${i.summaryText}\n\n— OpenBuild Verify`,
  },
  EXECUTIVE_REPORT: {
    subject: () => "Executive portfolio report generated",
    body: (i) =>
      `Hello ${i.recipientName},\n\nAn executive portfolio report was generated on ${i.generatedAt}. Open the Reports page to download it.\n\n— OpenBuild Verify`,
  },
  COMPLIANCE_REMINDER: {
    subject: (i) => `Compliance reminder — ${i.itemLabel}`,
    body: (i) =>
      `Hello ${i.recipientName},\n\nReminder: ${i.itemLabel} needs attention (${i.dueLabel}).\n\n— OpenBuild Verify`,
  },
};

/** Queue + dispatch one email through the configured provider. */
export function sendTemplatedEmail(
  template: keyof typeof EMAIL_TEMPLATES | string,
  to: { address: string; userId: string | null },
  input: EmailTemplateInput,
  ref: { type: string | null; id: string | null } = { type: null, id: null }
): prepo.OutboxEmail {
  const def = EMAIL_TEMPLATES[template as string];
  if (!def) throw new PilotOpsError(`Unknown email template "${template}"`, 400);
  const provider = resolveEmailProvider();
  const record = prepo.insertOutboxEmail({
    id: prepo.newId(),
    toUserId: to.userId,
    toAddress: to.address,
    template: String(template),
    subject: def.subject(input),
    body: def.body(input),
    refType: ref.type,
    refId: ref.id,
    provider: provider.name,
    status: "QUEUED",
    sentAt: null,
    failureCategory: null,
  });
  const result = provider.send({
    toAddress: to.address,
    toUserId: to.userId,
    template: String(template),
    subject: record.subject,
    body: record.body,
    refType: ref.type,
    refId: ref.id,
  });
  prepo.markOutboxEmail(record.id, result.ok ? "SENT" : "FAILED", result.ok ? null : result.failureCategory ?? "UNKNOWN");
  return prepo.listOutbox(1)[0];
}

/** Demo-safe recipient address for a seeded/demo user (no real inboxes). */
export function addressForUser(user: User): string {
  return `${user.id}@demo.openbuildverify.example`;
}
