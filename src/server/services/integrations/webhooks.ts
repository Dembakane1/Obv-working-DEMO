/**
 * Secure outbound webhook framework.
 *
 *  - SIGNATURES: every delivery carries `x-obv-signature:
 *    t=<unix-seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 *    Receivers recompute and compare in constant time.
 *  - REPLAY PROTECTION: the signed timestamp bounds validity —
 *    `verifyWebhookSignature` rejects stale timestamps, so a captured
 *    request cannot be replayed later even with a valid signature.
 *  - IDEMPOTENCY: one delivery row per endpoint+event (database unique
 *    constraint) and an `x-obv-delivery` id receivers can dedupe on.
 *  - RETRIES: exponential backoff; after the attempt budget the delivery
 *    parks in a DEAD-LETTER state, visible on the dashboard and audited.
 *  - The endpoint signing secret is generated server-side, returned
 *    exactly once at registration, and never serialized again.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import * as integrationsRepo from "../../db/integrationsRepo";
import type { User, WebhookDelivery, WebhookEndpoint } from "../../../shared/types";
import {
  IntegrationError,
  assertIntegrationManager,
  assertIntegrationViewer,
  integrationsConfig,
  nowIso,
  recordIntegration,
} from "./core";

export const WEBHOOK_EVENT_KINDS = [
  "draw.submitted", "draw.approved", "dispute.opened", "inspection.completed",
  "fraud.alert", "portfolio.alert", "executive.summary", "esign.completed",
  "calendar.scheduled",
] as const;

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;
const DELIVERY_TIMEOUT_MS = 5_000;
/** Signed-timestamp tolerance for receivers (replay window bound). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

// ------------------------------------------------------ egress boundary

/**
 * Server-side request forgery guard.
 *
 * A customer administrator registers the destination URL, and the SERVER
 * makes the request — so without this an org admin could aim the
 * dispatcher at loopback, private ranges, or a cloud metadata endpoint
 * and read the outcome back off the dashboard (status code and error
 * text are stored per attempt). Webhook receivers are public services by
 * definition, so refusing internal destinations costs nothing real.
 *
 * `OBV_WEBHOOK_ALLOW_PRIVATE_HOSTS=1` re-enables loopback for local
 * development and the test battery, which needs a receiver on 127.0.0.1.
 */
export function privateHostsAllowed(): boolean {
  return /^(1|true)$/i.test(process.env.OBV_WEBHOOK_ALLOW_PRIVATE_HOSTS ?? "");
}

/** Literal IP forms we refuse outright (decimal-dotted IPv4 and IPv6). */
function isBlockedIpLiteral(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  // IPv6 loopback / unspecified / unique-local / link-local
  if (h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) reduces to its IPv4 tail
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  const v4 = mapped ? mapped[1] : h;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!octets) return false;
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  if (octets.slice(1).some((o) => Number(o) > 255)) return true; // malformed → refuse
  return (
    a === 0 || a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local, incl. 169.254.169.254 metadata
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast / reserved
  );
}

/** Validate a destination URL for egress. Throws IntegrationError. */
export function assertDeliverableUrl(raw: string): URL {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new IntegrationError("The endpoint URL is not a valid absolute URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new IntegrationError("The endpoint URL must be http(s)");
  }
  if (target.username || target.password) {
    throw new IntegrationError("The endpoint URL must not embed credentials");
  }
  if (isBlockedIpLiteral(target.hostname) && !privateHostsAllowed()) {
    throw new IntegrationError(
      "The endpoint URL must be a publicly reachable host — loopback, private, link-local, and metadata addresses are refused"
    );
  }
  return target;
}

/** Delivery errors are surfaced on the dashboard, so they are reduced to
 *  a coarse class: enough to diagnose, never a probe read-out. */
function safeErrorLabel(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return "connection refused or unreachable";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "endpoint host could not be resolved";
  if (code === "CERT_HAS_EXPIRED" || String(code ?? "").startsWith("ERR_TLS")) return "TLS handshake failed";
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(message)) return "delivery timed out";
  if (/refused/i.test(message)) return "endpoint refused the request";
  return "delivery failed";
}

// ------------------------------------------------------------ signatures

export function signWebhookBody(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

/**
 * Receiver-side verification (also used by the test battery): constant-
 * time MAC comparison plus timestamp freshness — an old capture replayed
 * later fails even though its MAC is genuine.
 */
export function verifyWebhookSignature(
  secret: string,
  signatureHeader: string,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS
): boolean {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(String(signatureHeader ?? ""));
  if (!match) return false;
  const t = Number(match[1]);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(match[2]);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ------------------------------------------------------------- endpoints

function requireEndpoint(actor: User, id: string): WebhookEndpoint {
  const endpoint = integrationsRepo.getWebhookEndpoint(String(id ?? ""));
  if (!endpoint || endpoint.organizationId !== actor.organizationId) {
    throw new IntegrationError("Not found", 404);
  }
  return endpoint;
}

/** Register an endpoint. The signing secret appears in THIS return value
 *  and nowhere else, ever. */
export function registerEndpoint(
  actor: User,
  input: { url: string; description?: string | null; events?: string[] | string }
): { endpoint: Omit<WebhookEndpoint, "secret">; secret: string } {
  assertIntegrationManager(actor);
  const url = String(input.url ?? "").trim();
  // Egress boundary: registration is where an internal destination gets
  // rejected, before any delivery can probe the host network.
  assertDeliverableUrl(url);
  const requested = Array.isArray(input.events)
    ? input.events
    : String(input.events ?? "*").split(",").map((s) => s.trim()).filter(Boolean);
  const events = requested.length === 0 ? ["*"] : requested;
  for (const e of events) {
    if (e !== "*" && !(WEBHOOK_EVENT_KINDS as readonly string[]).includes(e)) {
      throw new IntegrationError(`Unknown webhook event kind: ${e}`);
    }
  }
  const secret = randomBytes(24).toString("hex");
  const endpoint: WebhookEndpoint = {
    id: randomUUID(),
    organizationId: actor.organizationId,
    url,
    description: input.description?.trim().slice(0, 300) || null,
    secret,
    events,
    active: true,
    createdBy: actor.id,
    createdAt: nowIso(),
  };
  integrationsRepo.insertWebhookEndpoint(endpoint);
  recordIntegration({
    category: "WEBHOOK",
    provider: "internal",
    operation: "ENDPOINT_REGISTERED",
    outcome: "SUCCESS",
    actorUserId: actor.id,
    organizationId: actor.organizationId,
    subjectType: "webhook_endpoint",
    subjectId: endpoint.id,
    detail: events.join(","),
  });
  const { secret: _secret, ...safe } = endpoint;
  return { endpoint: safe, secret };
}

export function setEndpointActive(actor: User, id: string, active: boolean): void {
  assertIntegrationManager(actor);
  const endpoint = requireEndpoint(actor, id);
  integrationsRepo.setWebhookEndpointActive(endpoint.id, active);
  recordIntegration({
    category: "WEBHOOK",
    provider: "internal",
    operation: active ? "ENDPOINT_ENABLED" : "ENDPOINT_DISABLED",
    outcome: "SUCCESS",
    actorUserId: actor.id,
    organizationId: actor.organizationId,
    subjectType: "webhook_endpoint",
    subjectId: endpoint.id,
  });
}

/** Endpoint view models — the secret never leaves the server. */
export function listEndpoints(actor: User): Array<Omit<WebhookEndpoint, "secret">> {
  assertIntegrationViewer(actor);
  return integrationsRepo.listWebhookEndpointsForOrgs([actor.organizationId]).map((e) => {
    const { secret: _secret, ...safe } = e;
    return safe;
  });
}

export function listDeliveries(actor: User): WebhookDelivery[] {
  assertIntegrationViewer(actor);
  const ids = integrationsRepo.listWebhookEndpointsForOrgs([actor.organizationId]).map((e) => e.id);
  return integrationsRepo.listDeliveriesForEndpoints(ids);
}

// --------------------------------------------------------------- emitting

/**
 * Queue one domain event for every subscribed endpoint of the
 * organization. `eventId` is the idempotency key: emitting the same
 * event twice enqueues nothing new.
 */
export function emitWebhookEvent(
  organizationId: string,
  eventKind: string,
  eventId: string,
  payload: Record<string, unknown>
): number {
  if (!(WEBHOOK_EVENT_KINDS as readonly string[]).includes(eventKind)) {
    throw new IntegrationError(`Unknown webhook event kind: ${eventKind}`);
  }
  const endpoints = integrationsRepo.listActiveEndpointsForEvent(organizationId, eventKind);
  let queued = 0;
  for (const endpoint of endpoints) {
    const inserted = integrationsRepo.insertWebhookDelivery({
      id: randomUUID(),
      endpointId: endpoint.id,
      eventKind,
      eventId,
      payload: JSON.stringify({ id: eventId, kind: eventKind, createdAt: nowIso(), data: payload }),
      status: "QUEUED",
      attemptCount: 0,
      nextAttemptAt: null,
      lastAttemptAt: null,
      lastStatusCode: null,
      lastError: null,
      deliveredAt: null,
      createdAt: nowIso(),
    });
    if (inserted) {
      queued += 1;
      recordIntegration({
        category: "WEBHOOK",
        provider: "internal",
        operation: `EMIT_${eventKind}`,
        outcome: "QUEUED",
        organizationId,
        subjectType: "webhook_delivery",
        subjectId: eventId,
      });
    }
  }
  return queued;
}

// -------------------------------------------------------------- dispatch

function postJson(url: string, body: string, headers: Record<string, string>): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      // Re-validated at dispatch time, not only at registration: the
      // guard must hold even for rows written before it existed.
      target = assertDeliverableUrl(url);
    } catch {
      reject(new Error("endpoint URL is not deliverable"));
      return;
    }
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      target,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
        timeout: DELIVERY_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve({ statusCode: res.statusCode ?? 0 });
      }
    );
    req.on("timeout", () => req.destroy(new Error("delivery timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/**
 * One dispatch pass over due deliveries. Explicitly invoked (route or
 * interval timer) so tests and demos stay deterministic; each delivery is
 * claimed atomically, so overlapping passes never double-send.
 */
export async function dispatchDueDeliveries(
  limit = 20,
  organizationId: string | null = null
): Promise<{ attempted: number; delivered: number; deadLettered: number }> {
  const cfg = integrationsConfig();
  const now = nowIso();
  // A caller-triggered pass works ONLY on that organization's queue, so
  // the route can never report another tenant's counts; the background
  // interval (organizationId null) drains everything.
  const due = organizationId
    ? integrationsRepo.listDueDeliveriesForOrg(organizationId, now, limit)
    : integrationsRepo.listDueDeliveries(now, limit);
  let attempted = 0;
  let delivered = 0;
  let deadLettered = 0;
  for (const delivery of due) {
    const provisionalNext = new Date(Date.now() + backoffMs(delivery.attemptCount + 1)).toISOString();
    if (!integrationsRepo.claimWebhookDelivery(delivery.id, nowIso(), provisionalNext)) continue;
    attempted += 1;
    const endpoint = integrationsRepo.getWebhookEndpoint(delivery.endpointId);
    if (!endpoint || !endpoint.active) {
      integrationsRepo.settleWebhookDelivery(delivery.id, {
        status: "DISABLED",
        nextAttemptAt: null,
        lastStatusCode: null,
        lastError: "endpoint inactive",
        deliveredAt: null,
      });
      continue;
    }
    const t = Math.floor(Date.now() / 1000);
    const signature = signWebhookBody(endpoint.secret, t, delivery.payload);
    try {
      const res = await postJson(endpoint.url, delivery.payload, {
        "x-obv-signature": signature,
        "x-obv-event": delivery.eventKind,
        "x-obv-delivery": delivery.id,
        "x-obv-timestamp": String(t),
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        integrationsRepo.settleWebhookDelivery(delivery.id, {
          status: "DELIVERED",
          nextAttemptAt: null,
          lastStatusCode: res.statusCode,
          lastError: null,
          deliveredAt: nowIso(),
        });
        delivered += 1;
        recordIntegration({
          category: "WEBHOOK",
          provider: "internal",
          operation: `DELIVER_${delivery.eventKind}`,
          outcome: "SUCCESS",
          organizationId: endpoint.organizationId,
          subjectType: "webhook_delivery",
          subjectId: delivery.id,
          detail: `status=${res.statusCode} attempt=${delivery.attemptCount + 1}`,
        });
      } else {
        settleFailure(delivery, endpoint, cfg.webhookMaxAttempts, `status=${res.statusCode}`, res.statusCode);
        if (delivery.attemptCount + 1 >= cfg.webhookMaxAttempts) deadLettered += 1;
      }
    } catch (err) {
      // Coarse label only: the stored text reaches the dashboard, and a
      // verbatim socket error would narrate the host network.
      settleFailure(delivery, endpoint, cfg.webhookMaxAttempts, safeErrorLabel(err), null);
      if (delivery.attemptCount + 1 >= cfg.webhookMaxAttempts) deadLettered += 1;
    }
  }
  return { attempted, delivered, deadLettered };
}

function settleFailure(
  delivery: WebhookDelivery,
  endpoint: WebhookEndpoint,
  maxAttempts: number,
  error: string,
  statusCode: number | null
): void {
  const attempts = delivery.attemptCount + 1;
  const dead = attempts >= maxAttempts;
  integrationsRepo.settleWebhookDelivery(delivery.id, {
    status: dead ? "DEAD_LETTER" : "RETRY",
    nextAttemptAt: dead ? null : new Date(Date.now() + backoffMs(attempts)).toISOString(),
    lastStatusCode: statusCode,
    lastError: error.slice(0, 500),
    deliveredAt: null,
  });
  recordIntegration({
    category: "WEBHOOK",
    provider: "internal",
    operation: `DELIVER_${delivery.eventKind}`,
    outcome: dead ? "DEAD_LETTER" : "RETRY",
    organizationId: endpoint.organizationId,
    subjectType: "webhook_delivery",
    subjectId: delivery.id,
    detail: `attempt=${attempts} ${error.slice(0, 200)}`,
  });
}

/** Requeue one dead-lettered delivery (administrative, audited). */
export function requeueDeadLetter(actor: User, deliveryId: string): void {
  assertIntegrationManager(actor);
  const delivery = integrationsRepo.getWebhookDelivery(String(deliveryId ?? ""));
  const endpoint = delivery ? integrationsRepo.getWebhookEndpoint(delivery.endpointId) : null;
  if (!delivery || !endpoint || endpoint.organizationId !== actor.organizationId) {
    throw new IntegrationError("Not found", 404);
  }
  if (delivery.status !== "DEAD_LETTER") {
    throw new IntegrationError("Only dead-lettered deliveries can be requeued", 409);
  }
  // The requeue grants a FRESH attempt budget. Leaving attempt_count at
  // the maximum would dead-letter the delivery again after a single
  // failure, which is not what an administrator asking for a retry means.
  if (!integrationsRepo.requeueWebhookDelivery(delivery.id, nowIso())) {
    throw new IntegrationError("This delivery was requeued concurrently", 409);
  }
  recordIntegration({
    category: "WEBHOOK",
    provider: "internal",
    operation: "DEAD_LETTER_REQUEUED",
    outcome: "QUEUED",
    actorUserId: actor.id,
    organizationId: actor.organizationId,
    subjectType: "webhook_delivery",
    subjectId: delivery.id,
  });
}
