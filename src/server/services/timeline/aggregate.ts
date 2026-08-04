/**
 * Timeline aggregation — the public read entry points.
 *
 * Everything here is derived on read and tenant-scoped: a project the
 * caller cannot see is a plain 404 (same-404), and the events returned
 * are exactly those derived from records the caller could already reach
 * through the governed pages.
 */
import * as repo from "../../db/repo";
import * as authz from "../authz";
import type {
  Project,
  TimelineEvent,
  TimelineFilters,
  TimelineGroup,
  User,
} from "../../../shared/types";
import {
  ActorResolver,
  TimelineError,
  applyFilters,
  assertTimelineViewer,
  requireVisibleProject,
  sortEvents,
} from "./core";
import { collectAll } from "./collectors";

export interface ProjectTimeline {
  project: Project;
  events: TimelineEvent[];
  /** Totals BEFORE filtering, so a filtered view can say what it hid. */
  totalEvents: number;
  categoryCounts: Record<string, number>;
  firstEventAt: string | null;
  lastEventAt: string | null;
  /** True when a limit truncated the returned window. */
  truncated: boolean;
  /** Some records carry dates that have not arrived yet (a recorded
   *  permit expiry, a scheduled inspection). They belong on the timeline
   *  but have NOT happened — history and schedule are never conflated. */
  upcomingCount: number;
  /** Any source-level read cap that applied, stated openly. */
  sourceCaps: string[];
  /** The instant this view was computed, so "upcoming" is reproducible. */
  asOf: string;
}

/** Events at or before `asOf` — what actually happened. Story Mode and
 *  playback narrate only these. */
export function pastEvents(events: TimelineEvent[], asOf: string): TimelineEvent[] {
  return events.filter((e) => e.at <= asOf);
}

/** Events dated after `asOf` — scheduled, not history. */
export function upcomingEvents(events: TimelineEvent[], asOf: string): TimelineEvent[] {
  return events.filter((e) => e.at > asOf);
}

/** Full ordered timeline for one project, filtered on read. */
export function projectTimeline(
  user: User,
  projectId: string,
  filters: TimelineFilters = {}
): ProjectTimeline {
  const project = requireVisibleProject(user, projectId);
  const asOf = new Date().toISOString();
  const actors = new ActorResolver();
  const collected = collectAll(project, actors, user);
  const all = sortEvents(collected.events);
  const counts: Record<string, number> = {};
  for (const e of all) counts[e.category] = (counts[e.category] ?? 0) + 1;
  const filtered = applyFilters(all, filters);
  return {
    project,
    events: filtered,
    totalEvents: all.length,
    categoryCounts: counts,
    firstEventAt: all.length > 0 ? all[0].at : null,
    lastEventAt: all.length > 0 ? all[all.length - 1].at : null,
    truncated: filtered.length < all.length,
    upcomingCount: upcomingEvents(all, asOf).length,
    sourceCaps: collected.caps,
    asOf,
  };
}

/** One event by id, with its neighbours — powers the detail drawer. */
export function eventDetail(
  user: User,
  projectId: string,
  eventId: string
): { event: TimelineEvent; previous: TimelineEvent | null; next: TimelineEvent | null; related: TimelineEvent[] } {
  const { events } = projectTimeline(user, projectId);
  const index = events.findIndex((e) => e.id === eventId);
  // A real TimelineError, not a shaped plain Error: the server's known-error
  // predicate tests `instanceof`, so a look-alike would surface as a 500
  // "Internal server error" and break same-404 — an unknown event id and an
  // event the caller may not see must be indistinguishable.
  if (index === -1) throw new TimelineError("Not found", 404);
  const event = events[index];
  // "Related" = events sharing the same milestone or draw, which is how a
  // reader actually asks "what else happened around this?".
  const related = events.filter(
    (e) =>
      e.id !== event.id &&
      ((event.milestoneId && e.milestoneId === event.milestoneId) ||
        (event.drawRequestId && e.drawRequestId === event.drawRequestId))
  ).slice(0, 25);
  return {
    event,
    previous: index > 0 ? events[index - 1] : null,
    next: index < events.length - 1 ? events[index + 1] : null,
    related,
  };
}

// ------------------------------------------------------------ grouping

const MS_DAY = 86_400_000;

/**
 * ISO-8601 week key.
 *
 * The day is normalized to UTC midnight FIRST: without that, the raw
 * millisecond difference carries a fractional day, so two events on the
 * same calendar date could round into different weeks purely because one
 * happened in the morning and one at night. The ISO year comes from the
 * week's Thursday, which is what makes the last days of December and the
 * first days of January land in the same week where they belong.
 */
function isoWeekKey(iso: string): string {
  const parsed = new Date(iso);
  const day = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  const dayNum = (day.getUTCDay() + 6) % 7; // Monday = 0 … Sunday = 6
  const thursday = new Date(day.getTime());
  thursday.setUTCDate(thursday.getUTCDate() - dayNum + 3);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * MS_DAY));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Group events for the grouped / milestone views. */
export function groupEvents(
  events: TimelineEvent[],
  mode: "week" | "month" | "category" | "milestone",
  milestoneLabels: Map<string, string> = new Map()
): TimelineGroup[] {
  const buckets = new Map<string, TimelineEvent[]>();
  const labels = new Map<string, string>();
  for (const e of events) {
    let key: string;
    let label: string;
    if (mode === "week") {
      key = isoWeekKey(e.at);
      label = `Week ${key}`;
    } else if (mode === "month") {
      key = e.at.slice(0, 7);
      label = key;
    } else if (mode === "category") {
      key = e.category;
      label = e.category.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
    } else {
      key = e.milestoneId ?? "__project__";
      label = e.milestoneId ? milestoneLabels.get(e.milestoneId) ?? e.milestoneId : "Project-level";
    }
    if (!buckets.has(key)) {
      buckets.set(key, []);
      labels.set(key, label);
    }
    buckets.get(key)!.push(e);
  }
  const groups: TimelineGroup[] = [...buckets.entries()].map(([key, list]) => ({
    key,
    label: labels.get(key) ?? key,
    from: list.length > 0 ? list[0].at : null,
    to: list.length > 0 ? list[list.length - 1].at : null,
    events: list,
  }));
  // Chronological for time buckets; by volume then name for the others,
  // so the ordering is deterministic in every mode.
  if (mode === "week" || mode === "month") {
    groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  } else {
    groups.sort((a, b) =>
      b.events.length - a.events.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
    );
  }
  return groups;
}

/** Milestone titles for the milestone-grouped view. */
export function milestoneLabels(project: Project): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of repo.listMilestones(project.id)) map.set(m.id, m.title);
  return map;
}

// ------------------------------------------------------------ portfolio

export interface PortfolioTimelineEntry {
  projectId: string;
  projectName: string;
  status: string;
  totalEvents: number;
  lastEventAt: string | null;
  categoryCounts: Record<string, number>;
  recent: TimelineEvent[];
}

export interface PortfolioTimeline {
  entries: PortfolioTimelineEntry[];
  /** Portfolio-wide activity by ISO week, for the trend strip. */
  activityByWeek: Array<{ week: string; count: number }>;
  /** Events counted AFTER the active filters — see `filtered`. */
  totalEvents: number;
  /** Projects actually aggregated (see `projectsAvailable` when capped). */
  projects: number;
  /** How many the caller can reach, whether or not all were aggregated. */
  projectsAvailable: number;
  /** True when any filter narrowed the counts, so the view can say the
   *  totals are of the filtered set and not of the whole portfolio. */
  filtered: boolean;
  /** Any cap or omission that applied, stated openly. */
  notes: string[];
}

/** Aggregating a portfolio runs the full per-project pipeline once per
 *  project, so the breadth is bounded and the bound is reported. */
export const PORTFOLIO_PROJECT_CAP = 50;

/** Portfolio-wide timeline across the caller's accessible projects. */
export function portfolioTimeline(user: User, filters: TimelineFilters = {}): PortfolioTimeline {
  // Every other timeline entry point gates the role before doing work;
  // the portfolio view must not be the one door that skips it.
  assertTimelineViewer(user);
  const available = authz.accessibleProjects(user);
  const notes: string[] = [];
  const projects = available.slice(0, PORTFOLIO_PROJECT_CAP);
  if (available.length > projects.length) {
    notes.push(
      `Showing ${projects.length} of ${available.length} accessible projects — open a project for its full history.`
    );
  }
  const filtered = Boolean(
    (filters.categories && filters.categories.length > 0) ||
      filters.from ||
      filters.to ||
      filters.search ||
      filters.milestoneId ||
      filters.drawRequestId ||
      filters.actorUserId ||
      filters.limit
  );
  if (filtered) notes.push("Counts below are of the filtered set, not of the whole portfolio.");
  const actors = new ActorResolver();
  const entries: PortfolioTimelineEntry[] = [];
  const byWeek = new Map<string, number>();
  let totalEvents = 0;
  for (const project of projects) {
    const all = sortEvents(collectAll(project, actors, user).events);
    const scoped = applyFilters(all, filters);
    const counts: Record<string, number> = {};
    for (const e of scoped) {
      counts[e.category] = (counts[e.category] ?? 0) + 1;
      const week = isoWeekKey(e.at);
      byWeek.set(week, (byWeek.get(week) ?? 0) + 1);
    }
    totalEvents += scoped.length;
    entries.push({
      projectId: project.id,
      projectName: project.name,
      status: project.status,
      totalEvents: scoped.length,
      lastEventAt: scoped.length > 0 ? scoped[scoped.length - 1].at : null,
      categoryCounts: counts,
      recent: scoped.slice(-8).reverse(),
    });
  }
  entries.sort((a, b) => {
    if (a.lastEventAt === b.lastEventAt) return a.projectName < b.projectName ? -1 : 1;
    if (!a.lastEventAt) return 1;
    if (!b.lastEventAt) return -1;
    return a.lastEventAt < b.lastEventAt ? 1 : -1;
  });
  return {
    entries,
    activityByWeek: [...byWeek.entries()]
      .map(([week, count]) => ({ week, count }))
      .sort((a, b) => (a.week < b.week ? -1 : 1)),
    totalEvents,
    projects: projects.length,
    projectsAvailable: available.length,
    filtered,
    notes,
  };
}

// ------------------------------------------------------- relationship graph

/** A graph of how this project's records connect — milestones to
 *  evidence to draws to decisions to payments. Derived from the same
 *  events, so it can never disagree with the timeline. */
export function relationshipGraph(user: User, projectId: string) {
  const { project, events } = projectTimeline(user, projectId);
  const nodes = new Map<string, { id: string; kind: string; label: string; href: string | null }>();
  const edges: Array<{ from: string; to: string; label: string }> = [];
  const addNode = (id: string, kind: string, label: string, href: string | null) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, label, href });
  };
  const projectNode = `project:${project.id}`;
  addNode(projectNode, "PROJECT", project.name, `/projects/${project.id}`);

  const labels = milestoneLabels(project);
  const seenEdge = new Set<string>();
  const addEdge = (from: string, to: string, label: string) => {
    const key = `${from}->${to}:${label}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ from, to, label });
  };

  for (const e of events) {
    if (e.milestoneId) {
      const id = `milestone:${e.milestoneId}`;
      addNode(id, "MILESTONE", labels.get(e.milestoneId) ?? e.milestoneId, `/projects/${project.id}`);
      addEdge(projectNode, id, "has milestone");
    }
    if (e.drawRequestId) {
      const id = `draw:${e.drawRequestId}`;
      addNode(id, "DRAW", `Draw ${e.drawRequestId.slice(0, 8)}`, `/draws/${e.drawRequestId}`);
      addEdge(projectNode, id, "has draw");
      if (e.milestoneId) addEdge(`milestone:${e.milestoneId}`, id, "supports");
    }
    const recordNode = `${e.category.toLowerCase()}:${e.sourceRecordId}`;
    addNode(recordNode, e.category, e.title, e.href);
    if (e.drawRequestId) addEdge(`draw:${e.drawRequestId}`, recordNode, e.type.toLowerCase().replace(/_/g, " "));
    else if (e.milestoneId) addEdge(`milestone:${e.milestoneId}`, recordNode, e.type.toLowerCase().replace(/_/g, " "));
    else addEdge(projectNode, recordNode, e.type.toLowerCase().replace(/_/g, " "));
  }
  return { nodes: [...nodes.values()], edges };
}
