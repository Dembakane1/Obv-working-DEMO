/**
 * Project Timeline — core: error type, doctrine notice, role gates,
 * tenant scoping, event construction, and deterministic ordering.
 *
 * DOCTRINE. The timeline is a VISUALIZATION AND INTELLIGENCE LAYER over
 * records that already exist. This module owns no tables and performs no
 * writes of any kind: every event is derived on read from a record some
 * governed subsystem already authored. It never creates approvals,
 * changes project state, releases funds, or bypasses governance — and
 * every event is labeled AUTHORITATIVE or ADVISORY so no reader mistakes
 * an observation for a governed decision.
 */
import * as repo from "../../db/repo";
import * as authz from "../authz";
import type {
  Project,
  TimelineCategory,
  TimelineEvent,
  TimelineFilters,
  TimelineRecordStatus,
  TimelineSpatial,
  TimelineTruthClass,
  User,
} from "../../../shared/types";

export class TimelineError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "TimelineError";
    this.statusCode = statusCode;
  }
}

/** Stamped onto every timeline surface. */
export const TIMELINE_NOTICE =
  "The project timeline is a read-only view of records OBV already holds. It never creates approvals, " +
  "changes project state, releases funds, or replaces the governed workflows that authored these records. " +
  "Advisory observations are labeled as such and are never decisions.";

// ------------------------------------------------------------ role gates

/** Anyone who can see a project can read its history; the timeline shows
 *  only what the caller could already reach through the governed pages. */
const VIEW_ROLES = new Set(["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER", "FIELD"]);

export function canViewTimeline(user: User): boolean {
  return VIEW_ROLES.has(user.role);
}

export function assertTimelineViewer(user: User): void {
  if (!canViewTimeline(user)) {
    throw new TimelineError("The project timeline is not available for this role", 403);
  }
}

/** Same-404: a project the caller cannot see is indistinguishable from
 *  one that does not exist. */
export function requireVisibleProject(user: User, projectId: string): Project {
  assertTimelineViewer(user);
  const project = repo.getProject(String(projectId ?? ""));
  if (!project || !authz.accessibleProjectIds(user).has(project.id)) {
    throw new TimelineError("Not found", 404);
  }
  return project;
}

// ------------------------------------------------------------ helpers

/** Actor display names are resolved once per aggregation, not per row. */
export class ActorResolver {
  private cache = new Map<string, string | null>();
  name(userId: string | null | undefined): string | null {
    const id = userId ?? null;
    if (!id) return null;
    if (this.cache.has(id)) return this.cache.get(id) ?? null;
    const user = repo.getUser(id);
    const name = user ? user.name : null;
    this.cache.set(id, name);
    return name;
  }
}

/** Normalize a stored timestamp to a comparable ISO string. Returns null
 *  for absent or unparseable values — a timeline never invents a time. */
export function normalizeAt(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * A bare `to=YYYY-MM-DD` means "through that day", not "up to midnight
 * that morning". Normalizing it as-is would silently drop every event on
 * the end date the reader explicitly asked to include, so a date-only
 * bound is widened to the last instant of that UTC day. Values that
 * already carry a time are left exactly as given.
 */
export function endOfDayIfDateOnly(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T23:59:59.999Z` : value;
}

export interface EventDraft {
  at: unknown;
  category: TimelineCategory;
  type: string;
  title: string;
  explanation: string;
  actorUserId?: string | null;
  organizationId?: string | null;
  projectId: string;
  milestoneId?: string | null;
  drawRequestId?: string | null;
  sourceTable: string;
  sourceRecordId: string;
  href?: string | null;
  recordStatus: TimelineRecordStatus;
  severity?: TimelineEvent["severity"];
  change?: TimelineEvent["change"];
  /** Recorded coordinates COPIED from the source record's own stored
   *  fields. A collector may only set this from values the record
   *  actually holds — never from the project's location or any default. */
  spatial?: TimelineSpatial | null;
}

/** Categories whose authoritative events always assert governed state
 *  or a governed decision, whatever their shape. */
const GOVERNED_CATEGORIES = new Set<TimelineCategory>([
  "DECISION", "GOVERNANCE", "EXCEPTION", "PAYMENT",
]);

/**
 * Derive the truth class in ONE place so collectors cannot drift:
 * advisory records are ADVISORY_SIGNAL; an authoritative event that
 * asserts a governed state value (it belongs to a governed category, or
 * its source record expresses a state transition via `change`) is a
 * GOVERNED_FACT; the remaining authoritative events record that
 * something happened — HISTORICAL_EVENT.
 */
export function truthClassOf(draft: EventDraft): TimelineTruthClass {
  if (draft.recordStatus === "ADVISORY") return "ADVISORY_SIGNAL";
  if (GOVERNED_CATEGORIES.has(draft.category) || (draft.change ?? null) !== null) {
    return "GOVERNED_FACT";
  }
  return "HISTORICAL_EVENT";
}

/** True when a value is a real recorded coordinate pair. Anything else
 *  (missing, partial, non-finite) is treated as "no location recorded". */
function realSpatial(value: TimelineSpatial | null | undefined): TimelineSpatial | null {
  if (!value) return null;
  if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) return null;
  return { latitude: value.latitude, longitude: value.longitude };
}

/** Build one event, or null when the source record carries no usable
 *  timestamp (dropped rather than guessed). */
export function makeEvent(draft: EventDraft, actors: ActorResolver): TimelineEvent | null {
  const at = normalizeAt(draft.at);
  if (!at) return null;
  return {
    id: `${draft.category}:${draft.type}:${draft.sourceRecordId}`,
    at,
    category: draft.category,
    type: draft.type,
    title: draft.title,
    explanation: draft.explanation,
    actorUserId: draft.actorUserId ?? null,
    actorName: actors.name(draft.actorUserId),
    organizationId: draft.organizationId ?? null,
    projectId: draft.projectId,
    milestoneId: draft.milestoneId ?? null,
    drawRequestId: draft.drawRequestId ?? null,
    sourceTable: draft.sourceTable,
    sourceRecordId: draft.sourceRecordId,
    href: draft.href ?? null,
    recordStatus: draft.recordStatus,
    truthClass: truthClassOf(draft),
    spatial: realSpatial(draft.spatial),
    severity: draft.severity ?? null,
    change: draft.change ?? null,
  };
}

/** Deterministic ordering: time first, then category, then type, then
 *  the synthetic id. Same-millisecond events (common in seeded and
 *  batch-written data) therefore never reorder between runs — the same
 *  lesson the append-only logs learned, applied to a derived view. */
export function sortEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Apply the read filters. Search matches title, explanation, actor, and
 *  type so one box covers the ways a reader describes what they want. */
export function applyFilters(events: TimelineEvent[], filters: TimelineFilters = {}): TimelineEvent[] {
  let out = events;
  if (filters.categories && filters.categories.length > 0) {
    const wanted = new Set(filters.categories);
    out = out.filter((e) => wanted.has(e.category));
  }
  const from = normalizeAt(filters.from);
  if (from) out = out.filter((e) => e.at >= from);
  const to = normalizeAt(endOfDayIfDateOnly(filters.to));
  if (to) out = out.filter((e) => e.at <= to);
  if (filters.milestoneId) out = out.filter((e) => e.milestoneId === filters.milestoneId);
  if (filters.drawRequestId) out = out.filter((e) => e.drawRequestId === filters.drawRequestId);
  if (filters.actorUserId) out = out.filter((e) => e.actorUserId === filters.actorUserId);
  const needle = (filters.search ?? "").trim().toLowerCase();
  if (needle) {
    out = out.filter((e) =>
      e.title.toLowerCase().includes(needle) ||
      e.explanation.toLowerCase().includes(needle) ||
      e.type.toLowerCase().includes(needle) ||
      (e.actorName ?? "").toLowerCase().includes(needle)
    );
  }
  if (filters.limit && filters.limit > 0 && out.length > filters.limit) {
    // Keep the MOST RECENT window when a cap applies, and say so at the
    // call site — a silently truncated history would mislead a reader.
    out = out.slice(out.length - filters.limit);
  }
  return out;
}

/** The named views the UI offers, expressed as category sets. */
export const VIEW_CATEGORIES: Record<string, TimelineCategory[] | null> = {
  all: null,
  evidence: ["EVIDENCE", "EVIDENCE_INTEL"],
  inspections: ["INSPECTION"],
  permits: ["PERMIT", "OFFICIAL_SOURCE"],
  financial: ["BUDGET", "DRAW", "DECISION", "PAYMENT"],
  disputes: ["DISPUTE", "EXCEPTION"],
  reviewer: ["EVIDENCE_INTEL", "OFFICIAL_SOURCE", "EXCEPTION", "DECISION"],
  milestones: ["MILESTONE"],
};

export function categoriesForView(view: string | null | undefined): TimelineCategory[] | undefined {
  if (!view) return undefined;
  const key = String(view).toLowerCase();
  const cats = VIEW_CATEGORIES[key];
  return cats ?? undefined;
}
