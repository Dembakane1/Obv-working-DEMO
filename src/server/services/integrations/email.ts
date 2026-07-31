/**
 * Provider-neutral email. Business code sends an EmailMessage; the
 * configured provider adapter decides how it leaves the process.
 *
 *  - "outbox" (default): the message is recorded in email_outbox and
 *    marked SENT — the outbox IS the development mailbox. No network.
 *  - m365 / sendgrid / mailgun / ses / postmark: DISABLED BOUNDARIES.
 *    The adapters exist so a production deployment can plug credentials
 *    into exactly one place, but in this build every call refuses.
 *
 * SECRECY RULE: credential-bearing messages (MAGIC_LINK today) are
 * recorded with a REDACTED body. Raw sign-in links travel only through
 * the identity layer's delivery seam, never through this table.
 */
import { randomUUID } from "node:crypto";
import * as integrationsRepo from "../../db/integrationsRepo";
import type { EmailKind, EmailOutboxEntry, User } from "../../../shared/types";
import { IntegrationError, integrationsConfig, nowIso, recordIntegration } from "./core";

export interface EmailMessage {
  kind: EmailKind;
  to: string;
  subject: string;
  text: string;
  organizationId?: string | null;
  projectId?: string | null;
  /** True for credential-bearing bodies: the outbox stores a redaction. */
  containsCredential?: boolean;
}

export interface EmailProvider {
  name: string;
  displayName: string;
  active: boolean;
  /** Deliver one message. Disabled boundaries throw IntegrationError. */
  deliver(entry: EmailOutboxEntry): void;
}

const REDACTION = "[credential-bearing body withheld — delivered through the identity delivery seam]";

function disabledEmailProvider(name: string, displayName: string): EmailProvider {
  return {
    name,
    displayName,
    active: false,
    deliver: () => {
      throw new IntegrationError(
        `The ${displayName} email adapter is a disabled boundary in this build. ` +
          "It exists so production credentials can be configured in exactly one place; " +
          "no message can leave through it.",
        503
      );
    },
  };
}

const outboxProvider: EmailProvider = {
  name: "outbox",
  displayName: "Development Outbox",
  active: true,
  // Recording IS delivery for the development outbox.
  deliver: () => {},
};

export const EMAIL_PROVIDER_CATALOG: EmailProvider[] = [
  outboxProvider,
  disabledEmailProvider("m365", "Microsoft 365"),
  disabledEmailProvider("sendgrid", "SendGrid"),
  disabledEmailProvider("mailgun", "Mailgun"),
  disabledEmailProvider("ses", "Amazon SES"),
  disabledEmailProvider("postmark", "Postmark"),
];

export function resolveEmailProvider(): EmailProvider {
  const cfg = integrationsConfig();
  const provider = EMAIL_PROVIDER_CATALOG.find((p) => p.name === cfg.emailProvider);
  if (!provider) throw new IntegrationError(`Unknown email provider ${cfg.emailProvider}`, 500);
  return provider;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Send (or queue) one email through the configured provider. Records the
 * outbox row and the integration audit event; throws only on caller
 * errors (bad address) — provider refusal is recorded as FAILED, not
 * thrown, so a notification can never break the domain action it follows.
 */
export function sendEmail(message: EmailMessage, actor: User | null = null): EmailOutboxEntry {
  const to = String(message.to ?? "").trim().toLowerCase();
  if (!EMAIL_SHAPE.test(to)) throw new IntegrationError("A valid recipient email is required");
  const provider = resolveEmailProvider();
  const entry: EmailOutboxEntry = {
    id: randomUUID(),
    kind: message.kind,
    provider: provider.name,
    toEmail: to,
    subject: message.subject.slice(0, 300),
    bodyText: message.containsCredential ? REDACTION : message.text.slice(0, 20_000),
    organizationId: message.organizationId ?? null,
    projectId: message.projectId ?? null,
    status: "QUEUED",
    error: null,
    createdAt: nowIso(),
    sentAt: null,
  };
  integrationsRepo.insertEmail(entry);
  try {
    provider.deliver(entry);
    integrationsRepo.markEmail(entry.id, "SENT", null, nowIso());
    recordIntegration({
      category: "EMAIL",
      provider: provider.name,
      operation: `SEND_${message.kind}`,
      outcome: "SUCCESS",
      actorUserId: actor?.id ?? null,
      organizationId: entry.organizationId,
      subjectType: "email",
      subjectId: entry.id,
    });
    return integrationsRepo.getEmail(entry.id)!;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    integrationsRepo.markEmail(entry.id, "FAILED", detail.slice(0, 500), null);
    recordIntegration({
      category: "EMAIL",
      provider: provider.name,
      operation: `SEND_${message.kind}`,
      outcome: "FAILURE",
      actorUserId: actor?.id ?? null,
      organizationId: entry.organizationId,
      subjectType: "email",
      subjectId: entry.id,
      detail: detail.slice(0, 500),
    });
    return integrationsRepo.getEmail(entry.id)!;
  }
}

// -------------------------------------------------------------- templates

/** Deterministic template composition — subjects and bodies come from the
 *  verified records the caller passes in; nothing generative. */
export const EMAIL_TEMPLATES: Record<EmailKind, { subject: (c: Record<string, string>) => string; body: (c: Record<string, string>) => string }> = {
  INVITATION: {
    subject: (c) => `You are invited to OBV — ${c.orgName ?? "your organization"}`,
    body: (c) =>
      `${c.inviterName ?? "An administrator"} invited you to join ${c.orgName ?? "an organization"} on OpenBuild Verify as ${c.role ?? "a team member"}.\n\nActivate your access with the link in this message. The link works once and expires.\n`,
  },
  MAGIC_LINK: {
    subject: () => "Your OBV sign-in link",
    body: () => "Use the one-time link in this message to sign in. It expires shortly and works once.\n",
  },
  PASSWORD_RESET: {
    // ARCHITECTURAL TEMPLATE ONLY: passwords are not implemented — no
    // route or service composes or sends this kind.
    subject: () => "Reset your OBV password",
    body: () => "Password reset is reserved architecture; passwordless sign-in is the active method.\n",
  },
  DRAW_NOTIFICATION: {
    subject: (c) => `Draw ${c.drawNumber ?? ""} ${c.status ?? "update"} — ${c.projectName ?? "project"}`,
    body: (c) =>
      `Draw ${c.drawNumber ?? ""} on ${c.projectName ?? "the project"} is now ${c.status ?? "updated"}.\nRequested: ${c.amount ?? "—"}.\nReview it in OBV.\n`,
  },
  APPROVAL_REQUEST: {
    subject: (c) => `Approval requested — ${c.subject ?? "OBV item"}`,
    body: (c) =>
      `${c.requesterName ?? "A teammate"} requests your approval on ${c.subject ?? "an item"} (${c.projectName ?? "project"}).\nOpen OBV to review the evidence and decide.\n`,
  },
  DISPUTE_NOTIFICATION: {
    subject: (c) => `Dispute ${c.status ?? "update"} — ${c.projectName ?? "project"}`,
    body: (c) =>
      `A dispute on ${c.projectName ?? "the project"} is now ${c.status ?? "updated"}.\n${c.summary ?? ""}\nRelease holds remain governed by the dispute workflow.\n`,
  },
  EXECUTIVE_SUMMARY: {
    subject: (c) => `Executive summary — ${c.period ?? "current period"}`,
    body: (c) => `${c.summaryText ?? "See the attached executive summary."}\n\nThis summary is advisory and does not approve draws.\n`,
  },
  WEEKLY_PORTFOLIO_REPORT: {
    subject: (c) => `Weekly portfolio report — ${c.weekLabel ?? "this week"}`,
    body: (c) => `${c.summaryText ?? "Your weekly portfolio figures are ready in OBV."}\n\nDerived from verified records; advisory only.\n`,
  },
};

export function composeEmail(kind: EmailKind, context: Record<string, string>): { subject: string; text: string } {
  const t = EMAIL_TEMPLATES[kind];
  return { subject: t.subject(context), text: t.body(context) };
}
