/**
 * Provider-neutral email. Business code sends an EmailMessage; the
 * configured provider adapter decides how it leaves the process.
 *
 *  - "outbox" (default): the message is recorded in email_outbox and
 *    marked SENT — the outbox IS the development mailbox. No network.
 *  - "postmark": the REAL production transactional provider. Credentials
 *    come ONLY from environment variables (OBV_POSTMARK_SERVER_TOKEN,
 *    OBV_EMAIL_FROM), are never stored in the database and never logged.
 *    Delivery is asynchronous with a timeout; the outbox row records the
 *    outcome (SENT / FAILED with a sanitized error).
 *  - m365 / sendgrid / mailgun / ses: DISABLED BOUNDARIES. The adapters
 *    exist so a later deployment can plug credentials into exactly one
 *    place; in this build every call refuses.
 *
 * SECRECY RULE: credential-bearing messages (MAGIC_LINK, INVITATION,
 * PASSWORD_RESET) are recorded with a REDACTED body — enforced by KIND,
 * not caller opt-in. The raw content still reaches the wire provider
 * (that is the point of sending mail), but it can never be read back out
 * of the database, an outbox dashboard, or a log line.
 *
 * FAILURE RULE: a notification can never break the domain action it
 * follows. Provider refusal and delivery failure are recorded outcomes,
 * never exceptions that reach workflow code.
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
  /**
   * Duplicate-send protection: when set, a second send with the same key
   * within the dedupe window returns the ORIGINAL outbox row — nothing new
   * is recorded and nothing reaches the provider. Use for governed-event
   * notifications where a retried workflow call must not double-mail a
   * recipient.
   */
  dedupeKey?: string | null;
}

export interface EmailProvider {
  name: string;
  displayName: string;
  active: boolean;
  /**
   * Deliver one message. `entry` is the (possibly redacted) outbox row;
   * `message` carries the REAL content for the wire. May be async —
   * sendEmail records the outcome when the promise settles. Disabled
   * boundaries throw IntegrationError synchronously.
   */
  deliver(entry: EmailOutboxEntry, message: EmailMessage): void | Promise<void>;
}

const REDACTION = "[credential-bearing body withheld — delivered through the identity delivery seam]";

/**
 * Kinds whose bodies carry a credential. Redaction is enforced by KIND,
 * not by caller opt-in: a future caller that forgets the flag must not be
 * able to write a live sign-in or activation link into the outbox table.
 * INVITATION is here because activation links mint sessions for
 * newly-created identities.
 */
const CREDENTIAL_KINDS = new Set<EmailKind>(["MAGIC_LINK", "PASSWORD_RESET", "INVITATION"]);

/** How far back a dedupeKey suppresses a duplicate send. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

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

// ------------------------------------------------------------- postmark

export interface PostmarkConfig {
  serverToken: string;
  from: string;
  messageStream: string;
  timeoutMs: number;
  apiBaseUrl: string;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Read and validate the Postmark configuration from the environment.
 * Throws a one-line operator instruction when required values are missing
 * or malformed — callers surface it as a controlled startup failure. The
 * token value itself never appears in any error or log.
 */
export function postmarkConfig(): PostmarkConfig {
  const serverToken = (process.env.OBV_POSTMARK_SERVER_TOKEN ?? "").trim();
  const from = (process.env.OBV_EMAIL_FROM ?? "").trim().toLowerCase();
  if (!serverToken) {
    throw new IntegrationError(
      "OBV_EMAIL_PROVIDER=postmark requires OBV_POSTMARK_SERVER_TOKEN (the Postmark " +
        "server API token, from Postmark → Servers → API Tokens). Set it in the " +
        "deployment environment only — it is never stored in the database.",
      500
    );
  }
  if (!EMAIL_SHAPE.test(from)) {
    throw new IntegrationError(
      "OBV_EMAIL_PROVIDER=postmark requires OBV_EMAIL_FROM — a verified sender " +
        "signature address (e.g. obv@yourlender.com) registered in Postmark.",
      500
    );
  }
  const timeoutRaw = Number(process.env.OBV_EMAIL_TIMEOUT_MS ?? 10_000);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.min(60_000, Math.max(1_000, timeoutRaw)) : 10_000;
  return {
    serverToken,
    from,
    messageStream: (process.env.OBV_POSTMARK_MESSAGE_STREAM ?? "").trim() || "outbound",
    // Overridable base URL exists ONLY so the test suite can point the
    // adapter at a local capture server; a real deployment leaves it unset.
    apiBaseUrl: (process.env.OBV_POSTMARK_API_BASE_URL ?? "").trim() || "https://api.postmarkapp.com",
    timeoutMs,
  };
}

/** Strip anything that could carry a secret or a recipient's content out
 *  of a provider error before it is stored: keep an HTTP status, a
 *  Postmark ErrorCode and a short trimmed message only. */
function sanitizeProviderError(status: number | null, body: string | null, fallback: string): string {
  let detail = fallback;
  if (body) {
    try {
      const parsed = JSON.parse(body) as { ErrorCode?: number; Message?: string };
      detail = `ErrorCode=${parsed.ErrorCode ?? "?"} ${String(parsed.Message ?? "").slice(0, 160)}`;
    } catch {
      detail = body.replace(/\s+/g, " ").slice(0, 160);
    }
  }
  return `${status !== null ? `HTTP ${status}: ` : ""}${detail}`.slice(0, 300);
}

const postmarkProvider: EmailProvider = {
  name: "postmark",
  displayName: "Postmark",
  active: true,
  async deliver(entry: EmailOutboxEntry, message: EmailMessage): Promise<void> {
    const cfg = postmarkConfig();
    let res: Response;
    try {
      res = await fetch(`${cfg.apiBaseUrl}/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-postmark-server-token": cfg.serverToken,
        },
        body: JSON.stringify({
          From: cfg.from,
          To: entry.toEmail,
          Subject: entry.subject,
          TextBody: message.text,
          MessageStream: cfg.messageStream,
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new IntegrationError(
        timedOut
          ? `Postmark delivery timed out after ${cfg.timeoutMs}ms`
          : "Postmark delivery failed before a response was received (network error)",
        504
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => null);
      throw new IntegrationError(sanitizeProviderError(res.status, body, "delivery refused"), 502);
    }
  },
};

export const EMAIL_PROVIDER_CATALOG: EmailProvider[] = [
  outboxProvider,
  postmarkProvider,
  disabledEmailProvider("m365", "Microsoft 365"),
  disabledEmailProvider("sendgrid", "SendGrid"),
  disabledEmailProvider("mailgun", "Mailgun"),
  disabledEmailProvider("ses", "Amazon SES"),
];

export function resolveEmailProvider(): EmailProvider {
  const cfg = integrationsConfig();
  const provider = EMAIL_PROVIDER_CATALOG.find((p) => p.name === cfg.emailProvider);
  if (!provider) throw new IntegrationError(`Unknown email provider ${cfg.emailProvider}`, 500);
  return provider;
}

/** Startup validation for the configured provider's own requirements —
 *  called from assertIntegrationsConfig so a misconfigured production
 *  provider stops the process with an instruction, never at first send. */
export function assertEmailProviderConfig(): void {
  const provider = resolveEmailProvider();
  if (provider.name === "postmark") postmarkConfig();
}

/**
 * In-flight async deliveries. Tests (and graceful shutdown, if ever
 * needed) can await settlement; workflow code never does.
 */
const inFlight = new Set<Promise<void>>();
export function emailDeliveriesSettled(): Promise<void> {
  return Promise.allSettled([...inFlight]).then(() => undefined);
}

function recordOutcome(
  entryId: string,
  provider: EmailProvider,
  message: EmailMessage,
  actor: User | null,
  organizationId: string | null,
  outcome: "SUCCESS" | "FAILURE",
  detail?: string
): void {
  if (outcome === "SUCCESS") {
    integrationsRepo.markEmail(entryId, "SENT", null, nowIso());
  } else {
    integrationsRepo.markEmail(entryId, "FAILED", (detail ?? "delivery failed").slice(0, 500), null);
  }
  recordIntegration({
    category: "EMAIL",
    provider: provider.name,
    operation: `SEND_${message.kind}`,
    outcome,
    actorUserId: actor?.id ?? null,
    organizationId,
    subjectType: "email",
    subjectId: entryId,
    detail: outcome === "FAILURE" ? (detail ?? "").slice(0, 500) : undefined,
  });
}

/**
 * Send (or queue) one email through the configured provider. Records the
 * outbox row and the integration audit event; throws only on caller
 * errors (bad address) — provider refusal or failure is recorded as
 * FAILED, never thrown, so a notification can never break the domain
 * action it follows. Async providers (Postmark) return with the row in
 * QUEUED state; the outcome is recorded when delivery settles.
 */
export function sendEmail(message: EmailMessage, actor: User | null = null): EmailOutboxEntry {
  const to = String(message.to ?? "").trim().toLowerCase();
  if (!EMAIL_SHAPE.test(to)) throw new IntegrationError("A valid recipient email is required");
  const provider = resolveEmailProvider();
  const dedupeKey = (message.dedupeKey ?? "").trim() || null;
  if (dedupeKey) {
    const windowStart = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
    const prior = integrationsRepo.findRecentEmailByDedupeKey(dedupeKey, windowStart);
    if (prior) return prior;
  }
  const entry: EmailOutboxEntry = {
    id: randomUUID(),
    kind: message.kind,
    provider: provider.name,
    toEmail: to,
    subject: message.subject.slice(0, 300),
    bodyText:
      message.containsCredential || CREDENTIAL_KINDS.has(message.kind)
        ? REDACTION
        : message.text.slice(0, 20_000),
    organizationId: message.organizationId ?? null,
    projectId: message.projectId ?? null,
    status: "QUEUED",
    error: null,
    createdAt: nowIso(),
    sentAt: null,
    dedupeKey,
  };
  integrationsRepo.insertEmail(entry);
  try {
    const result = provider.deliver(entry, message);
    if (result && typeof (result as Promise<void>).then === "function") {
      const settled = (result as Promise<void>)
        .then(() => recordOutcome(entry.id, provider, message, actor, entry.organizationId, "SUCCESS"))
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          recordOutcome(entry.id, provider, message, actor, entry.organizationId, "FAILURE", detail);
        })
        .finally(() => inFlight.delete(settled));
      inFlight.add(settled);
      return integrationsRepo.getEmail(entry.id)!;
    }
    recordOutcome(entry.id, provider, message, actor, entry.organizationId, "SUCCESS");
    return integrationsRepo.getEmail(entry.id)!;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordOutcome(entry.id, provider, message, actor, entry.organizationId, "FAILURE", detail);
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
      `${c.inviterName ?? "An administrator"} invited you to join ${c.orgName ?? "an organization"} on OpenBuild Verify as ${c.role ?? "a team member"}.\n\n` +
      (c.activationLink ? `Activate your access:\n${c.activationLink}\n\n` : "Activate your access with the link in this message.\n\n") +
      `The link works once and expires.\n`,
  },
  MAGIC_LINK: {
    subject: () => "Your OBV sign-in link",
    body: (c) =>
      c.link
        ? `Use this one-time link to sign in:\n${c.link}\n\nIt expires shortly and works once. If you did not request it, ignore this message.\n`
        : "Use the one-time link in this message to sign in. It expires shortly and works once.\n",
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
