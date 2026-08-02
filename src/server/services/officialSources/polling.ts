/**
 * Polling & refresh orchestration.
 *
 * No always-running daemon: refreshes happen on explicit authorized
 * request (single record, single project, portfolio) or via a scheduled
 * EXTERNAL invocation hitting the refresh entrypoint — and automated
 * polling stays DISABLED until OBV_SOURCES_POLLING_ENABLE is set.
 * Page loads never trigger retrieval; the UI shows cached state.
 *
 * Resilience per source: client-side rate limiting, retry with
 * exponential backoff + jitter, a circuit breaker that opens after
 * consecutive failures, a dead-letter queue for jobs that exhausted
 * retries, per-source pause, and maintenance windows. A connector
 * failure never blocks manual verification or draw workflows — it only
 * produces an ERROR snapshot and operational metadata.
 */
import * as authz from "../authz";
import * as repo from "../../db/repo";
import * as osRepo from "../../db/officialSourcesRepo";
import type { SourcePollState, User } from "../../../shared/types";
import { connectorFor } from "./connectors";
import {
  OfficialSourceError,
  assertSourceReviewer,
  assertSourceViewer,
  nowIso,
  pollingEnabled,
  requireVisibleProject,
  safeErrorLabel,
} from "./core";
import { evaluateCandidate } from "./matching";
import { detectChangesForRecord } from "./changes";
import { fetchSourceChanges, performRetrieval, searchSource, type RetrievalOutput } from "./retrieval";
import { enqueueFromRetrieval } from "./review";

const MAX_ATTEMPTS = 3;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_BASE_MS = 30_000;
const CIRCUIT_CAP_MS = 60 * 60_000;

function retryBaseMs(): number {
  const raw = Number(process.env.OBV_SOURCES_RETRY_BASE_MS ?? "250");
  return Number.isFinite(raw) && raw >= 0 ? raw : 250;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------ rate limiting

/** In-memory per-source minute window (client-side conservatism; the
 *  authoritative limits live with the source). */
const rateWindows = new Map<string, { windowStart: number; count: number }>();

function checkRateLimit(sourceId: string, perMinute: number | null): void {
  if (!perMinute || perMinute <= 0) return;
  const now = Date.now();
  const w = rateWindows.get(sourceId);
  if (!w || now - w.windowStart >= 60_000) {
    rateWindows.set(sourceId, { windowStart: now, count: 1 });
    return;
  }
  if (w.count >= perMinute) {
    throw new OfficialSourceError(
      "Rate limit reached for this source — try again shortly (client-side cap protecting the official service)",
      429
    );
  }
  w.count += 1;
}

/** Test seam: clear in-memory rate windows. */
export function resetRateLimiters(): void {
  rateWindows.clear();
}

// ------------------------------------------------------ circuit breaker

function pollState(sourceId: string): SourcePollState {
  return (
    osRepo.getPollState(sourceId) ?? {
      sourceId,
      cursor: null,
      lastPollAt: null,
      lastPollOutcome: null,
      consecutiveFailures: 0,
      circuitOpenUntil: null,
      paused: false,
      updatedAt: nowIso(),
    }
  );
}

function assertCircuitClosed(sourceId: string): SourcePollState {
  const state = pollState(sourceId);
  if (state.paused) {
    throw new OfficialSourceError("Polling for this source is paused by a reviewer", 409);
  }
  if (state.circuitOpenUntil && Date.parse(state.circuitOpenUntil) > Date.now()) {
    throw new OfficialSourceError(
      "This source's circuit breaker is open after repeated failures — retrieval resumes automatically after the cool-down",
      409
    );
  }
  return state;
}

function recordPollOutcome(sourceId: string, ok: boolean, outcome: string): void {
  const state = pollState(sourceId);
  const failures = ok ? 0 : state.consecutiveFailures + 1;
  const circuitOpenUntil =
    !ok && failures >= CIRCUIT_THRESHOLD
      ? new Date(Date.now() + Math.min(CIRCUIT_CAP_MS, CIRCUIT_BASE_MS * 2 ** (failures - CIRCUIT_THRESHOLD))).toISOString()
      : null;
  osRepo.upsertPollState({
    ...state,
    lastPollAt: nowIso(),
    lastPollOutcome: outcome,
    consecutiveFailures: failures,
    circuitOpenUntil,
    updatedAt: nowIso(),
  });
}

function saveCursor(sourceId: string, cursor: string | null): void {
  if (cursor === null) return;
  const state = pollState(sourceId);
  osRepo.upsertPollState({ ...state, cursor, updatedAt: nowIso() });
}

// ------------------------------------------------------ retries + DLQ

/** Run one retrieval with retry/backoff/jitter; dead-letter on final
 *  failure. Retries apply to transport failures (SOURCE_UNAVAILABLE),
 *  not to manual/not-configured outcomes. */
async function retrieveWithRetries(
  run: () => Promise<RetrievalOutput>,
  sourceId: string,
  requestType: string,
  lookupParams: unknown
): Promise<RetrievalOutput> {
  let last: RetrievalOutput | null = null;
  let firstFailedAt: string | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    last = await run();
    if (last.kind !== "SOURCE_UNAVAILABLE") {
      recordPollOutcome(sourceId, last.kind === "OK", last.kind);
      return last;
    }
    firstFailedAt = firstFailedAt ?? nowIso();
    if (attempt < MAX_ATTEMPTS) {
      const backoff = retryBaseMs() * 2 ** (attempt - 1);
      await sleep(backoff + Math.floor(Math.random() * (backoff / 2 + 1)));
    }
  }
  recordPollOutcome(sourceId, false, "SOURCE_UNAVAILABLE");
  osRepo.insertDeadLetter({
    id: repo.newId(),
    sourceId,
    requestType,
    lookupParams,
    firstFailedAt: firstFailedAt ?? nowIso(),
    lastFailedAt: nowIso(),
    attempts: MAX_ATTEMPTS,
    errorLabel: last?.errorLabel ?? "source unavailable",
    status: "OPEN",
    resolvedByUserId: null,
    resolvedAt: null,
  });
  return last!;
}

// ------------------------------------------------------ post-processing

/** After a retrieval: evaluate matches, detect changes, enqueue review
 *  items. Pure derivation + advisory queueing — nothing authoritative. */
function postProcess(output: RetrievalOutput, allowed: Set<string>): {
  matches: number;
  changes: number;
  queued: number;
} {
  let matches = 0;
  let changes = 0;
  let queued = 0;
  const seenRecords = new Set<string>();
  for (const candidate of output.candidates) {
    const evaluation = evaluateCandidate(candidate, allowed);
    matches += evaluation.matches.length;
    let changeEvents: ReturnType<typeof detectChangesForRecord> = [];
    if (!seenRecords.has(candidate.externalId)) {
      seenRecords.add(candidate.externalId);
      changeEvents = detectChangesForRecord(candidate.sourceId, candidate.externalId);
      changes += changeEvents.length;
    }
    queued += enqueueFromRetrieval(candidate, evaluation, changeEvents);
  }
  // Disappearances: previously-seen records the source stopped returning.
  if (output.unavailableChanges.length > 0) {
    changes += output.unavailableChanges.length;
    queued += enqueueFromRetrieval(null, null, output.unavailableChanges);
  }
  return { matches, changes, queued };
}

export interface RefreshSummary {
  sourceId: string;
  kind: RetrievalOutput["kind"];
  snapshots: number;
  candidates: number;
  matches: number;
  changes: number;
  queued: number;
  manualInstructions: string | null;
  errorLabel: string | null;
}

// ------------------------------------------------------ public entrypoints

/** Manual refresh of one source (optionally scoped to one project whose
 *  permits/address seed the search). Authorized users only; never runs
 *  from a page load. */
export async function refreshSource(
  user: User,
  sourceId: string,
  opts: { projectId?: string | null } = {}
): Promise<RefreshSummary> {
  assertSourceViewer(user);
  const source = osRepo.getSource(sourceId);
  if (!source || !connectorFor(sourceId)) throw new OfficialSourceError("Not found", 404);
  assertCircuitClosed(sourceId);
  checkRateLimit(sourceId, source.rateLimitPerMinute);
  const allowed = authz.accessibleProjectIds(user);

  if (opts.projectId) {
    const project = requireVisibleProject(user, opts.projectId);
    const scope = { actorUserId: user.id, organizationId: project.organizationId, projectId: project.id };
    // One search per known permit number plus one address search — the
    // narrow queries a reviewer would run by hand.
    const permits = repo.listPermitsForProject(project.id);
    let totals = { snapshots: 0, candidates: 0, matches: 0, changes: 0, queued: 0 };
    let lastKind: RetrievalOutput["kind"] = "OK";
    let manualInstructions: string | null = null;
    let errorLabel: string | null = null;
    const queries = permits.length > 0
      ? permits.map((p) => ({ permitNumber: p.permitNumber }))
      : [{ address: project.location } as { address?: string; permitNumber?: string }];
    for (const query of queries.slice(0, 10)) {
      const output = await retrieveWithRetries(
        () => searchSource(sourceId, query, scope),
        sourceId, "SEARCH", query
      );
      lastKind = output.kind;
      manualInstructions = output.manualInstructions ?? manualInstructions;
      errorLabel = output.errorLabel ?? errorLabel;
      totals.snapshots += 1;
      totals.candidates += output.candidates.length;
      if (output.kind === "OK") {
        const post = postProcess(output, allowed);
        totals.matches += post.matches;
        totals.changes += post.changes;
        totals.queued += post.queued;
      }
    }
    return { sourceId, kind: lastKind, ...totals, manualInstructions, errorLabel };
  }

  // Source-wide incremental refresh (cursor-based when supported).
  const state = pollState(sourceId);
  const scope = { actorUserId: user.id, organizationId: null, projectId: null };
  const output = await retrieveWithRetries(
    () => fetchSourceChanges(sourceId, state.cursor, scope),
    sourceId, "FETCH_CHANGES", { cursor: state.cursor }
  );
  saveCursor(sourceId, output.cursor);
  const post = output.kind === "OK" ? postProcess(output, allowed) : { matches: 0, changes: 0, queued: 0 };
  return {
    sourceId,
    kind: output.kind,
    snapshots: 1,
    candidates: output.candidates.length,
    ...post,
    manualInstructions: output.manualInstructions,
    errorLabel: output.errorLabel,
  };
}

/** Re-check ONE external record at its source (e.g. from a queue item):
 *  a targeted fetch that also detects disappearance. */
export async function refreshRecord(
  user: User,
  sourceId: string,
  externalId: string,
  opts: { projectId?: string | null } = {}
): Promise<RefreshSummary> {
  assertSourceViewer(user);
  const source = osRepo.getSource(sourceId);
  if (!source || !connectorFor(sourceId)) throw new OfficialSourceError("Not found", 404);
  assertCircuitClosed(sourceId);
  checkRateLimit(sourceId, source.rateLimitPerMinute);
  const project = opts.projectId ? requireVisibleProject(user, opts.projectId) : null;
  const scope = {
    actorUserId: user.id,
    organizationId: project?.organizationId ?? null,
    projectId: project?.id ?? null,
  };
  const output = await retrieveWithRetries(
    () => performRetrieval(sourceId, "FETCH_RECORD", { externalId }, scope),
    sourceId, "FETCH_RECORD", { externalId }
  );
  const allowed = authz.accessibleProjectIds(user);
  const post = output.kind === "OK" ? postProcess(output, allowed) : { matches: 0, changes: 0, queued: 0 };
  return {
    sourceId, kind: output.kind, snapshots: 1, candidates: output.candidates.length,
    ...post, manualInstructions: output.manualInstructions, errorLabel: output.errorLabel,
  };
}

/** Refresh every pollable source for one project. */
export async function refreshProject(user: User, projectId: string): Promise<RefreshSummary[]> {
  assertSourceViewer(user);
  requireVisibleProject(user, projectId);
  const summaries: RefreshSummary[] = [];
  for (const source of osRepo.listSources()) {
    if (source.category === "OFFICIAL_PORTAL_MANUAL" || source.category === "UNAVAILABLE") continue;
    if (source.operationalStatus !== "ENABLED") continue;
    try {
      summaries.push(await refreshSource(user, source.id, { projectId }));
    } catch (err) {
      summaries.push({
        sourceId: source.id, kind: "SOURCE_UNAVAILABLE", snapshots: 0, candidates: 0,
        matches: 0, changes: 0, queued: 0, manualInstructions: null,
        errorLabel: safeErrorLabel(err),
      });
    }
  }
  return summaries;
}

/** Portfolio-wide refresh across the caller's accessible projects. */
export async function refreshPortfolio(user: User): Promise<RefreshSummary[]> {
  assertSourceViewer(user);
  const summaries: RefreshSummary[] = [];
  for (const project of authz.accessibleProjects(user)) {
    summaries.push(...(await refreshProject(user, project.id)));
  }
  return summaries;
}

/** Scheduled external invocation (cron/CI hitting the API). Refuses
 *  unless automated polling was explicitly enabled. System-scoped:
 *  candidates are recorded unscoped; matching/enqueueing happens on the
 *  next authorized view or refresh. */
export async function runScheduledPoll(user: User): Promise<RefreshSummary[]> {
  assertSourceReviewer(user);
  if (!pollingEnabled()) {
    throw new OfficialSourceError(
      "Automated polling is disabled (set OBV_SOURCES_POLLING_ENABLE=true to allow scheduled refreshes)",
      409
    );
  }
  const summaries: RefreshSummary[] = [];
  for (const source of osRepo.listSources()) {
    if (!source.pollingSupported || source.operationalStatus !== "ENABLED") continue;
    if (source.category === "OFFICIAL_PORTAL_MANUAL" || source.category === "UNAVAILABLE") continue;
    try {
      summaries.push(await refreshSource(user, source.id));
    } catch (err) {
      summaries.push({
        sourceId: source.id, kind: "SOURCE_UNAVAILABLE", snapshots: 0, candidates: 0,
        matches: 0, changes: 0, queued: 0, manualInstructions: null,
        errorLabel: safeErrorLabel(err),
      });
    }
  }
  return summaries;
}

// ------------------------------------------------------ DLQ management

export function listDeadLetterQueue(user: User): ReturnType<typeof osRepo.listDeadLetters> {
  assertSourceViewer(user);
  return osRepo.listDeadLetters();
}

/** Requeue one dead letter: re-run its request once, guarded. */
export async function requeueDeadLetter(user: User, id: string): Promise<RefreshSummary> {
  assertSourceReviewer(user);
  const letter = osRepo.getDeadLetter(id);
  if (!letter) throw new OfficialSourceError("Not found", 404);
  if (!osRepo.resolveDeadLetter(id, "REQUEUED", user.id, nowIso())) {
    throw new OfficialSourceError("This dead letter was already resolved", 409);
  }
  const params = (letter.lookupParams ?? {}) as { cursor?: string | null } & Record<string, unknown>;
  const scope = { actorUserId: user.id, organizationId: null, projectId: null };
  const request =
    letter.requestType === "FETCH_CHANGES"
      ? { cursor: params.cursor ?? null }
      : { query: params as { permitNumber?: string; address?: string; party?: string } };
  const output = await performRetrieval(
    letter.sourceId,
    letter.requestType === "FETCH_CHANGES" ? "FETCH_CHANGES" : "SEARCH",
    request,
    scope
  );
  const allowed = authz.accessibleProjectIds(user);
  const post = output.kind === "OK" ? postProcess(output, allowed) : { matches: 0, changes: 0, queued: 0 };
  recordPollOutcome(letter.sourceId, output.kind === "OK", output.kind);
  return {
    sourceId: letter.sourceId, kind: output.kind, snapshots: 1,
    candidates: output.candidates.length, ...post,
    manualInstructions: output.manualInstructions, errorLabel: output.errorLabel,
  };
}

export function discardDeadLetter(user: User, id: string): void {
  assertSourceReviewer(user);
  const letter = osRepo.getDeadLetter(id);
  if (!letter) throw new OfficialSourceError("Not found", 404);
  if (!osRepo.resolveDeadLetter(id, "DISCARDED", user.id, nowIso())) {
    throw new OfficialSourceError("This dead letter was already resolved", 409);
  }
}

/** Pause/resume polling for one source (reviewer decision). */
export function setSourcePaused(user: User, sourceId: string, paused: boolean): void {
  assertSourceReviewer(user);
  if (!osRepo.getSource(sourceId)) throw new OfficialSourceError("Not found", 404);
  const state = pollState(sourceId);
  osRepo.upsertPollState({ ...state, paused, updatedAt: nowIso() });
}
