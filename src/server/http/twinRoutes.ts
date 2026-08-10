/**
 * Digital Twin routes.
 *
 * EVERY route is a READ. This module has no POST handler at all: the
 * twin visualizes existing records and can change nothing, so any
 * non-GET is refused rather than silently treated as a read. Role gates,
 * tenant scoping, and same-404 live in the twin/timeline services.
 */
import type * as http from "node:http";
import * as twin from "../services/twin";
import type { NavContext } from "../view/components";
import type { User } from "../../shared/types";
import { renderDigitalTwin, renderTwinProviders } from "../view/twinPages";
import * as timeline from "../services/timeline";

export interface TwinRouteContext {
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
}

const PAGE_PREFIX = "/timeline/twin";

/** Returns true when the request was handled by a twin route. */
export async function handleTwinRoutes(ctx: TwinRouteContext): Promise<boolean> {
  const { pathname, method } = ctx;
  const isApi = pathname.startsWith("/api/twin/");
  if (!pathname.startsWith(PAGE_PREFIX) && !isApi) return false;

  if (method !== "GET") {
    if (isApi) {
      ctx.sendJson({ error: "The Digital Twin is read-only" }, 405);
      return true;
    }
    return false;
  }

  // ---- page ----
  const pageMatch = /^\/timeline\/twin\/([^/]+)$/.exec(pathname);
  if (pageMatch) {
    let user: User;
    try {
      user = ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return true;
    }
    const projectId = pageMatch[1];
    const scene = twin.twinScene(user, projectId);
    const pinId = ctx.searchParams.get("pin");
    ctx.sendHtml(
      renderDigitalTwin({
        nav: ctx.navFor(user, "twin"),
        scene,
        focusEventId: ctx.searchParams.get("focus"),
        pinDetail: pinId ? safePin(() => twin.twinPinDetail(user, projectId, pinId)) : null,
        providers: twin.twinProviderReadiness(),
        // The workspace's left pane: the SAME governed events the Timeline
        // page reads, through the same viewer-scoped service. Read-only.
        events: timeline.projectTimeline(user, projectId).events,
        mode: ctx.searchParams.get("mode"),
      })
    );
    return true;
  }
  if (pathname === `${PAGE_PREFIX}/providers` || pathname === "/timeline/twin-providers") {
    let user: User;
    try {
      user = ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return true;
    }
    ctx.sendHtml(
      renderTwinProviders({ nav: ctx.navFor(user, "twin"), providers: twin.twinProviderReadiness() })
    );
    return true;
  }

  // ---- API ----
  const apiScene = /^\/api\/twin\/scene\/([^/]+)$/.exec(pathname);
  if (apiScene) {
    ctx.sendJson(twin.twinScene(ctx.getUser(), apiScene[1]));
    return true;
  }
  const apiPlayback = /^\/api\/twin\/playback\/([^/]+)$/.exec(pathname);
  if (apiPlayback) {
    ctx.sendJson(twin.twinPlayback(ctx.getUser(), apiPlayback[1]));
    return true;
  }
  const apiPin = /^\/api\/twin\/pin\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (apiPin) {
    ctx.sendJson(twin.twinPinDetail(ctx.getUser(), apiPin[1], safeDecode(apiPin[2])));
    return true;
  }
  const apiCoverage = /^\/api\/twin\/coverage\/([^/]+)$/.exec(pathname);
  if (apiCoverage) {
    ctx.sendJson(twin.twinCoverage(ctx.getUser(), apiCoverage[1]));
    return true;
  }
  if (pathname === "/api/twin/snapshots") {
    ctx.sendJson(twin.twinSnapshots(ctx.getUser()));
    return true;
  }
  if (pathname === "/api/twin/providers") {
    ctx.getUser(); // signed-in only
    ctx.sendJson(twin.twinProviderReadiness());
    return true;
  }

  if (isApi) {
    ctx.sendJson({ error: "Not found" }, 404);
    return true;
  }
  return false;
}

/** A missing pin renders the page without a drawer instead of failing
 *  the whole scene view; the API path still 404s precisely. */
function safePin<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Malformed percent-escapes are an ordinary miss (404), never a 500. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
