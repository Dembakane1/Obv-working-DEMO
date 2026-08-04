/**
 * Project Timeline & Site Intelligence routes.
 *
 * Thin dispatch only: role gates, tenant scoping, and same-404 decisions
 * live in the timeline services. EVERY route here is a READ — this
 * module has no POST handler at all, because the timeline never creates
 * approvals, changes project state, or releases funds. The only
 * side-effect-free export path is the timeline export, which serializes
 * what the caller can already see.
 */
import type * as http from "node:http";
import * as tl from "../services/timeline";
import type { NavContext } from "../view/components";
import type { TimelineCategory, User } from "../../shared/types";
import {
  renderProjectTimeline,
  renderSiteIntelligence,
  renderProjectStory,
  renderExecutivePlayback,
  renderDrawPlayback,
  renderRelationshipGraph,
  renderPortfolioTimeline,
  renderProjectMap,
  renderEventDetail,
} from "../view/timelinePages";

export interface TimelineRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  searchParams: URLSearchParams;
  getUser: () => User;
  signInLocation: string;
  navFor: (user: User, active: string) => NavContext;
  redirect: (location: string) => void;
  sendJson: (data: unknown, status?: number) => void;
  sendHtml: (html: string, status?: number) => void;
  sendText: (text: string, contentType: string, status?: number) => void;
}

const PAGE_PREFIX = "/timeline";

/** A malformed percent-escape (`%`, `%zz`) makes decodeURIComponent throw
 *  a URIError, which would surface as a 500 "Internal server error" on
 *  what is really just an unknown event id. Returning the raw segment
 *  lets the normal lookup miss and produce the ordinary 404. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Read the shared filter set from the query string. */
function filtersFrom(searchParams: URLSearchParams) {
  const view = searchParams.get("view");
  const categoriesParam = searchParams.get("categories");
  const explicit = categoriesParam
    ? (categoriesParam.split(",").map((c) => c.trim()).filter(Boolean) as TimelineCategory[])
    : undefined;
  const limitRaw = Number(searchParams.get("limit") ?? "");
  return {
    categories: explicit ?? tl.categoriesForView(view),
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    search: searchParams.get("q"),
    milestoneId: searchParams.get("milestone"),
    drawRequestId: searchParams.get("draw"),
    actorUserId: searchParams.get("actor"),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : undefined,
  };
}

/** Returns true when the request was handled by a timeline route. */
export async function handleTimelineRoutes(ctx: TimelineRouteContext): Promise<boolean> {
  const { pathname, method } = ctx;
  const isApi = pathname.startsWith("/api/timeline/");
  if (!pathname.startsWith(PAGE_PREFIX) && !isApi) return false;

  // The timeline is read-only by construction: nothing here mutates, so
  // any non-GET is refused rather than silently treated as a read.
  if (method !== "GET") {
    if (isApi) {
      ctx.sendJson({ error: "The timeline is read-only" }, 405);
      return true;
    }
    return false;
  }

  const pageUser = (): User | null => {
    try {
      return ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return null;
    }
  };

  // ---- pages ----

  // Portfolio-wide timeline.
  if (pathname === PAGE_PREFIX || pathname === `${PAGE_PREFIX}/`) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderPortfolioTimeline({
        nav: ctx.navFor(user, "timeline"),
        portfolio: tl.portfolioTimeline(user, filtersFrom(ctx.searchParams)),
      })
    );
    return true;
  }

  const projectMatch = /^\/timeline\/project\/([^/]+)$/.exec(pathname);
  if (projectMatch) {
    const user = pageUser();
    if (!user) return true;
    const timeline = tl.projectTimeline(user, projectMatch[1], filtersFrom(ctx.searchParams));
    const group = ctx.searchParams.get("group");
    ctx.sendHtml(
      renderProjectTimeline({
        nav: ctx.navFor(user, "timeline"),
        timeline,
        view: ctx.searchParams.get("view") ?? "all",
        group,
        groups: group
          ? tl.groupEvents(
              timeline.events,
              group === "month" ? "month" : group === "category" ? "category" : group === "milestone" ? "milestone" : "week",
              tl.milestoneLabels(timeline.project)
            )
          : null,
        query: {
          q: ctx.searchParams.get("q") ?? "",
          from: ctx.searchParams.get("from") ?? "",
          to: ctx.searchParams.get("to") ?? "",
        },
      })
    );
    return true;
  }

  const siteMatch = /^\/timeline\/site\/([^/]+)$/.exec(pathname);
  if (siteMatch) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderSiteIntelligence({
        nav: ctx.navFor(user, "timeline"),
        site: tl.siteIntelligence(user, siteMatch[1]),
      })
    );
    return true;
  }

  const storyMatch = /^\/timeline\/story\/([^/]+)$/.exec(pathname);
  if (storyMatch) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderProjectStory({ nav: ctx.navFor(user, "timeline"), story: tl.projectStory(user, storyMatch[1]) })
    );
    return true;
  }

  const playbackMatch = /^\/timeline\/playback\/([^/]+)$/.exec(pathname);
  if (playbackMatch) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderExecutivePlayback({
        nav: ctx.navFor(user, "timeline"),
        playback: tl.executivePlayback(user, playbackMatch[1]),
      })
    );
    return true;
  }

  const drawMatch = /^\/timeline\/draw\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (drawMatch) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderDrawPlayback({
        nav: ctx.navFor(user, "timeline"),
        playback: tl.drawPlayback(user, drawMatch[1], drawMatch[2]),
      })
    );
    return true;
  }

  const graphMatch = /^\/timeline\/graph\/([^/]+)$/.exec(pathname);
  if (graphMatch) {
    const user = pageUser();
    if (!user) return true;
    const project = tl.requireVisibleProject(user, graphMatch[1]);
    ctx.sendHtml(
      renderRelationshipGraph({
        nav: ctx.navFor(user, "timeline"),
        project,
        graph: tl.relationshipGraph(user, graphMatch[1]),
      })
    );
    return true;
  }

  const mapMatch = /^\/timeline\/map\/([^/]+)$/.exec(pathname);
  if (mapMatch) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderProjectMap({
        nav: ctx.navFor(user, "timeline"),
        map: tl.projectMapData(user, mapMatch[1]),
        spatial: tl.spatialReadiness(),
      })
    );
    return true;
  }

  const eventMatch = /^\/timeline\/event\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (eventMatch) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderEventDetail({
        nav: ctx.navFor(user, "timeline"),
        projectId: eventMatch[1],
        detail: tl.eventDetail(user, eventMatch[1], safeDecode(eventMatch[2])),
      })
    );
    return true;
  }

  // ---- API ----
  const apiProject = /^\/api\/timeline\/project\/([^/]+)$/.exec(pathname);
  if (apiProject) {
    const timeline = tl.projectTimeline(ctx.getUser(), apiProject[1], filtersFrom(ctx.searchParams));
    ctx.sendJson({
      projectId: timeline.project.id,
      totalEvents: timeline.totalEvents,
      upcomingCount: timeline.upcomingCount,
      categoryCounts: timeline.categoryCounts,
      // A caller reading JSON is as entitled to the doctrine and to any
      // applied cap as a caller reading the page.
      notice: tl.TIMELINE_NOTICE,
      truncated: timeline.truncated,
      sourceCaps: timeline.sourceCaps,
      asOf: timeline.asOf,
      events: timeline.events,
    });
    return true;
  }
  const apiSite = /^\/api\/timeline\/site\/([^/]+)$/.exec(pathname);
  if (apiSite) {
    ctx.sendJson(tl.siteIntelligence(ctx.getUser(), apiSite[1]));
    return true;
  }
  const apiStory = /^\/api\/timeline\/story\/([^/]+)$/.exec(pathname);
  if (apiStory) {
    ctx.sendJson(tl.projectStory(ctx.getUser(), apiStory[1]));
    return true;
  }
  const apiInsights = /^\/api\/timeline\/insights\/([^/]+)$/.exec(pathname);
  if (apiInsights) {
    ctx.sendJson(tl.timelineInsights(ctx.getUser(), apiInsights[1]));
    return true;
  }
  const apiPlayback = /^\/api\/timeline\/playback\/([^/]+)$/.exec(pathname);
  if (apiPlayback) {
    ctx.sendJson(tl.executivePlayback(ctx.getUser(), apiPlayback[1]));
    return true;
  }
  const apiDraw = /^\/api\/timeline\/draw\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (apiDraw) {
    ctx.sendJson(tl.drawPlayback(ctx.getUser(), apiDraw[1], apiDraw[2]));
    return true;
  }
  const apiGraph = /^\/api\/timeline\/graph\/([^/]+)$/.exec(pathname);
  if (apiGraph) {
    ctx.sendJson(tl.relationshipGraph(ctx.getUser(), apiGraph[1]));
    return true;
  }
  const apiMap = /^\/api\/timeline\/map\/([^/]+)$/.exec(pathname);
  if (apiMap) {
    ctx.sendJson(tl.projectMapData(ctx.getUser(), apiMap[1]));
    return true;
  }
  if (pathname === "/api/timeline/portfolio") {
    ctx.sendJson(tl.portfolioTimeline(ctx.getUser(), filtersFrom(ctx.searchParams)));
    return true;
  }
  if (pathname === "/api/timeline/spatial") {
    ctx.getUser(); // gate to a signed-in user
    ctx.sendJson(tl.spatialReadiness());
    return true;
  }

  // Export — a serialization of exactly what this caller can already
  // read. Same gating as the page; no new data is exposed.
  const apiExport = /^\/api\/timeline\/export\/([^/]+)$/.exec(pathname);
  if (apiExport) {
    const user = ctx.getUser();
    const timeline = tl.projectTimeline(user, apiExport[1], filtersFrom(ctx.searchParams));
    const format = (ctx.searchParams.get("format") ?? "json").toLowerCase();
    if (format === "csv") {
      const header = "at,category,type,title,actor,record_status,severity,source_table,source_record_id";
      // CSV formula injection: a spreadsheet executes a cell beginning
      // with = + - @ (or a leading tab/CR) as a formula. Exported values
      // include record-derived text such as actor names and titles, so
      // every field is neutralized with a leading apostrophe before the
      // normal quote-doubling.
      const escape = (v: unknown) => {
        const raw = String(v ?? "");
        const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const rows = timeline.events.map((e) =>
        [e.at, e.category, e.type, e.title, e.actorName ?? "", e.recordStatus, e.severity ?? "", e.sourceTable, e.sourceRecordId]
          .map(escape)
          .join(",")
      );
      // Served as a download with nosniff: a CSV rendered inline would
      // let record-derived text be interpreted by the browser.
      ctx.res.setHeader("Content-Disposition", `attachment; filename="timeline-${timeline.project.id}.csv"`);
      ctx.res.setHeader("X-Content-Type-Options", "nosniff");
      ctx.sendText([header, ...rows].join("\n"), "text/csv; charset=utf-8");
      return true;
    }
    ctx.sendJson({
      project: { id: timeline.project.id, name: timeline.project.name },
      asOf: timeline.asOf,
      notice: tl.TIMELINE_NOTICE,
      totalEvents: timeline.totalEvents,
      exportedEvents: timeline.events.length,
      truncated: timeline.truncated,
      sourceCaps: timeline.sourceCaps,
      events: timeline.events,
    });
    return true;
  }

  if (isApi) {
    ctx.sendJson({ error: "Not found" }, 404);
    return true;
  }
  return false;
}
