/**
 * Source registry service — seeds and reads the Official Source
 * Registry, runs health checks, and manages operational status. Secrets
 * never appear in any returned view model: the registry exposes the
 * NAME of a credential env var and whether it is currently set — never
 * its value.
 */
import * as osRepo from "../../db/officialSourcesRepo";
import { allConnectors, connectorFor } from "./connectors";
import {
  OfficialSourceError,
  assertSourceReviewer,
  assertSourceViewer,
  endpointOverrideFor,
  nowIso,
} from "./core";
import type { OfficialSource, SourcePollState, User } from "../../../shared/types";

/** Upsert every registered connector's definition into the registry.
 *  Operational fields (health, last success/failure, status) survive
 *  re-seeding; definition fields follow the connector version. */
export function ensureSourceRegistry(): void {
  const at = nowIso();
  for (const { connector } of allConnectors()) {
    const def = connector.sourceMetadata();
    const existing = osRepo.getSource(def.id);
    osRepo.upsertSource({
      ...def,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    });
  }
}

export interface SourceRegistryView {
  source: OfficialSource;
  pollState: SourcePollState | null;
  /** Whether the endpoint override / credential env is SET (never values). */
  configured: { endpoint: boolean; credential: boolean };
  automatedRetrievalAvailable: boolean;
}

export function listSourceRegistry(user: User): SourceRegistryView[] {
  assertSourceViewer(user);
  return osRepo.listSources().map((source) => {
    const endpointSet = Boolean(endpointOverrideFor(source.id)) || source.id.startsWith("obv-mock");
    const credentialSet = source.authType === "NONE"
      ? true
      : Boolean(source.credentialEnv && (process.env[source.credentialEnv] ?? "").trim().length > 0);
    return {
      source,
      pollState: osRepo.getPollState(source.id),
      configured: { endpoint: endpointSet, credential: credentialSet },
      automatedRetrievalAvailable:
        source.category !== "OFFICIAL_PORTAL_MANUAL" &&
        source.category !== "UNAVAILABLE" &&
        source.operationalStatus === "ENABLED" &&
        endpointSet && credentialSet,
    };
  });
}

export function getSourceView(user: User, sourceId: string): SourceRegistryView {
  assertSourceViewer(user);
  const view = listSourceRegistry(user).find((v) => v.source.id === sourceId);
  if (!view) throw new OfficialSourceError("Not found", 404);
  return view;
}

/** Run a connector health check and record the outcome. */
export async function checkSourceHealth(user: User, sourceId: string): Promise<{ status: string; detail: string }> {
  assertSourceViewer(user);
  const source = osRepo.getSource(sourceId);
  const connector = connectorFor(sourceId);
  if (!source || !connector) throw new OfficialSourceError("Not found", 404);
  const health = await connector.healthCheck();
  const at = nowIso();
  const mapped =
    health.status === "HEALTHY" ? "HEALTHY"
    : health.status === "DEGRADED" ? "DEGRADED"
    : health.status === "DOWN" ? "DOWN"
    : health.status === "MANUAL" ? "MANUAL"
    : "UNKNOWN"; // NOT_CONFIGURED keeps UNKNOWN — nothing was probed
  osRepo.recordSourceOutcome(sourceId, {
    ok: health.status === "HEALTHY" || health.status === "MANUAL",
    at,
    failureReason: health.status === "DOWN" ? health.detail : null,
    health: mapped,
  });
  return { status: health.status, detail: health.detail };
}

/** Pause / resume / maintenance — a reviewer decision, audited via the
 *  registry row itself (operational metadata, not source truth). */
export function setSourceStatus(
  user: User,
  sourceId: string,
  status: "ENABLED" | "PAUSED" | "MAINTENANCE"
): OfficialSource {
  assertSourceReviewer(user);
  const source = osRepo.getSource(sourceId);
  if (!source) throw new OfficialSourceError("Not found", 404);
  osRepo.setSourceOperationalStatus(sourceId, status, nowIso());
  return osRepo.getSource(sourceId)!;
}
