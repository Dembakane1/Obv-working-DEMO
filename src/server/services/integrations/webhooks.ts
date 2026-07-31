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
  if (!/^https?:\/\/[^\s]+$/i.test(url)) {
    throw new IntegrationError("The endpoint URL must be http(s)");
  }
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
      target = new URL(url);
    } catch {
      reject(new Error("invalid endpoint URL"));
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
export async function dispatchDueDeliveries(limit = 20): Promise<{ attempted: number; delivered: number; deadLettered: number }> {
  const cfg = integrationsConfig();
  const now = nowIso();
  const due = integrationsRepo.listDueDeliveries(now, limit);
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
      const message = err instanceof Error ? err.message : String(err);
      settleFailure(delivery, endpoint, cfg.webhookMaxAttempts, message, null);
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
  integrationsRepo.settleWebhookDelivery(delivery.id, {
    status: "RETRY",
    nextAttemptAt: nowIso(),
    lastStatusCode: delivery.lastStatusCode,
    lastError: delivery.lastError,
    deliveredAt: null,
  });
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
