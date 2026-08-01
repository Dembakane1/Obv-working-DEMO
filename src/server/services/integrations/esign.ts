/**
 * E-signature platform: provider-neutral request lifecycle with a full
 * append-only trail.
 *
 * The active provider is "internal" — OBV records, tracks, and audits
 * signature requests (pending / signed / declined / expired / cancelled)
 * without an external vendor. DocuSign, Dropbox Sign, and Adobe Acrobat
 * Sign exist as DISABLED BOUNDARIES for later. document_ref points at
 * existing artifacts; nothing here creates or alters evidence.
 */
import { randomUUID } from "node:crypto";
import * as integrationsRepo from "../../db/integrationsRepo";
import * as repo from "../../db/repo";
import * as authz from "../authz";
import type { EsignKind, EsignRequest, EsignStatus, User } from "../../../shared/types";
import {
  IntegrationError,
  assertIntegrationManager,
  assertIntegrationViewer,
  integrationsConfig,
  nowIso,
  recordIntegration,
} from "./core";
import { emitWebhookEvent } from "./webhooks";

const ESIGN_KINDS: EsignKind[] = [
  "CONTRACTOR_AGREEMENT", "LIEN_WAIVER", "APPROVAL_ACKNOWLEDGEMENT", "COMPLETION_CERTIFICATE", "OTHER",
];
const DEFAULT_TTL_DAYS = 30;

export interface EsignProvider {
  name: string;
  displayName: string;
  active: boolean;
  /** Future vendor send — disabled boundaries throw. */
  sendRemote(request: EsignRequest): void;
}

function disabledEsignProvider(name: string, displayName: string): EsignProvider {
  return {
    name,
    displayName,
    active: false,
    sendRemote: () => {
      throw new IntegrationError(
        `The ${displayName} e-signature adapter is a disabled boundary in this build.`,
        503
      );
    },
  };
}

export const ESIGN_PROVIDER_CATALOG: EsignProvider[] = [
  { name: "internal", displayName: "OBV Internal Tracking", active: true, sendRemote: () => {} },
  disabledEsignProvider("docusign", "DocuSign"),
  disabledEsignProvider("dropbox_sign", "Dropbox Sign"),
  disabledEsignProvider("adobe_sign", "Adobe Acrobat Sign"),
];

export function resolveEsignProvider(): EsignProvider {
  const cfg = integrationsConfig();
  return ESIGN_PROVIDER_CATALOG.find((p) => p.name === cfg.esignProvider)!;
}

function trail(requestId: string, kind: "CREATED" | "SENT" | "REMINDED" | "SIGNED" | "DECLINED" | "EXPIRED" | "CANCELLED", actor: User | null, detail: string | null = null): void {
  integrationsRepo.insertEsignEvent({
    id: randomUUID(),
    requestId,
    occurredAt: nowIso(),
    actorUserId: actor?.id ?? null,
    kind,
    detail,
  });
}

/** Same-404: a request outside the caller's organization is
 *  indistinguishable from one that does not exist. */
function requireRequest(actor: User, id: string): EsignRequest {
  const request = integrationsRepo.getEsignRequest(String(id ?? ""));
  if (!request || request.organizationId !== actor.organizationId) {
    throw new IntegrationError("Not found", 404);
  }
  return request;
}

export function createSignatureRequest(
  actor: User,
  input: {
    kind: string;
    title: string;
    signerName: string;
    signerEmail: string;
    projectId?: string | null;
    documentRef?: string | null;
    expiresInDays?: number | null;
  }
): EsignRequest {
  assertIntegrationManager(actor);
  const kind = String(input.kind ?? "").toUpperCase() as EsignKind;
  if (!ESIGN_KINDS.includes(kind)) throw new IntegrationError(`Unknown signature request kind: ${input.kind}`);
  const title = String(input.title ?? "").trim().slice(0, 200);
  if (!title) throw new IntegrationError("A request title is required");
  const signerName = String(input.signerName ?? "").trim().slice(0, 120);
  const signerEmail = String(input.signerEmail ?? "").trim().toLowerCase();
  if (!signerName) throw new IntegrationError("The signer's name is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail)) throw new IntegrationError("A valid signer email is required");
  if (input.projectId) {
    // Tenancy: a project the actor cannot see is a plain 404.
    if (!authz.accessibleProjects(actor).some((p) => p.id === input.projectId)) {
      throw new IntegrationError("Not found", 404);
    }
  }
  const provider = resolveEsignProvider();
  const days = Math.min(365, Math.max(1, Number(input.expiresInDays ?? DEFAULT_TTL_DAYS) || DEFAULT_TTL_DAYS));
  const request: EsignRequest = {
    id: randomUUID(),
    provider: provider.name,
    kind,
    title,
    organizationId: actor.organizationId,
    projectId: input.projectId ?? null,
    signerName,
    signerEmail,
    documentRef: input.documentRef?.trim().slice(0, 300) || null,
    status: "PENDING",
    requestedBy: actor.id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    completedAt: null,
  };
  integrationsRepo.insertEsignRequest(request);
  trail(request.id, "CREATED", actor, `${kind} for ${signerName}`);
  provider.sendRemote(request); // internal provider: no-op; boundaries throw before audit says SUCCESS
  trail(request.id, "SENT", actor, `via ${provider.displayName}`);
  recordIntegration({
    category: "ESIGN",
    provider: provider.name,
    operation: "REQUEST_CREATED",
    outcome: "SUCCESS",
    actorUserId: actor.id,
    organizationId: actor.organizationId,
    subjectType: "esign_request",
    subjectId: request.id,
    detail: kind,
  });
  return integrationsRepo.getEsignRequest(request.id)!;
}

/** Signer decision or administrative settlement. Guarded: a request
 *  settles exactly once. */
export function settleSignatureRequest(
  actor: User,
  id: string,
  decision: "SIGNED" | "DECLINED" | "CANCELLED",
  detail: string | null = null
): EsignRequest {
  assertIntegrationManager(actor);
  const request = requireRequest(actor, id);
  expireIfOverdue(request);
  const fresh = integrationsRepo.getEsignRequest(request.id)!;
  if (fresh.status !== "PENDING") {
    throw new IntegrationError(`This request is already ${fresh.status.toLowerCase()}`, 409);
  }
  const completedAt = decision === "SIGNED" ? nowIso() : null;
  if (!integrationsRepo.updateEsignStatus(request.id, decision, completedAt)) {
    throw new IntegrationError("This request was settled concurrently", 409);
  }
  trail(request.id, decision, actor, detail);
  recordIntegration({
    category: "ESIGN",
    provider: fresh.provider,
    operation: `REQUEST_${decision}`,
    outcome: "SUCCESS",
    actorUserId: actor.id,
    organizationId: actor.organizationId,
    subjectType: "esign_request",
    subjectId: request.id,
  });
  if (decision === "SIGNED" || decision === "DECLINED") {
    emitWebhookEvent(actor.organizationId, "esign.completed", `esign-${request.id}`, {
      requestId: request.id,
      kind: fresh.kind,
      decision,
    });
  }
  return integrationsRepo.getEsignRequest(request.id)!;
}

/** Lazily expire an overdue PENDING request (audited when it happens). */
function expireIfOverdue(request: EsignRequest): void {
  if (
    request.status === "PENDING" &&
    request.expiresAt &&
    Date.parse(request.expiresAt) <= Date.now() &&
    integrationsRepo.updateEsignStatus(request.id, "EXPIRED", null)
  ) {
    trail(request.id, "EXPIRED", null, "expired on read");
    recordIntegration({
      category: "ESIGN",
      provider: request.provider,
      operation: "REQUEST_EXPIRED",
      outcome: "SUCCESS",
      organizationId: request.organizationId,
      subjectType: "esign_request",
      subjectId: request.id,
    });
  }
}

export function listSignatureRequests(actor: User): EsignRequest[] {
  assertIntegrationViewer(actor);
  const requests = integrationsRepo.listEsignRequestsForOrgs([actor.organizationId]);
  for (const r of requests) expireIfOverdue(r);
  return integrationsRepo.listEsignRequestsForOrgs([actor.organizationId]);
}

export function signatureRequestDetail(actor: User, id: string): { request: EsignRequest; trail: ReturnType<typeof integrationsRepo.listEsignEvents> } {
  assertIntegrationViewer(actor);
  const request = requireRequest(actor, id);
  expireIfOverdue(request);
  return {
    request: integrationsRepo.getEsignRequest(request.id)!,
    trail: integrationsRepo.listEsignEvents(request.id),
  };
}

/** Requester display helper (kept here so views stay dumb). */
export function requesterName(request: EsignRequest): string {
  return repo.getUser(request.requestedBy)?.name ?? "—";
}
