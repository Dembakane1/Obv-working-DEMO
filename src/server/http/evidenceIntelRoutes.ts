/**
 * Evidence Intelligence routes.
 *
 * Thin dispatch only: role gates, tenant scoping, and same-404 decisions
 * live in the evidence-intelligence services. Everything reachable here
 * is advisory — the only state-changing calls are analysis (which writes
 * signals + queue items) and reviewer queue actions (acknowledge /
 * dismiss / promote). Promotion delegates to the exceptions service and
 * its authorization; nothing here approves, rejects, or releases.
 */
import type * as http from "node:http";
import * as ei from "../services/evidenceIntel";
import * as repo from "../db/repo";
import {
  renderEvidenceIntelDashboard,
  renderEvidenceReviewQueue,
  renderReviewItemDetail,
  renderEvidenceTimeline,
  renderEvidenceAnalytics,
  renderDuplicateViewer,
} from "../view/evidenceIntelPages";
import type { NavContext } from "../view/components";
import type { User } from "../../shared/types";

export interface EvidenceIntelRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  searchParams: URLSearchParams;
  getUser: () => User;
  signInLocation: string;
  navFor: (user: User, active: string) => NavContext;
  readParams: () => Promise<Record<string, string>>;
  isForm: () => boolean;
  redirect: (location: string) => void;
  sendJson: (data: unknown, status?: number) => void;
  sendHtml: (html: string, status?: number) => void;
}

const PAGE_PREFIX = "/evidence-intelligence";

/** Returns true when the request was handled by an evidence-intel route. */
export async function handleEvidenceIntelRoutes(ctx: EvidenceIntelRouteContext): Promise<boolean> {
  const { pathname, method } = ctx;
  const isApi = pathname.startsWith("/api/evidence-intel/");
  if (!pathname.startsWith(PAGE_PREFIX) && !isApi) return false;

  // ---- pages ----
  if (method === "GET" && (pathname === PAGE_PREFIX || pathname === `${PAGE_PREFIX}/`)) {
    let user: User;
    try {
      user = ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return true;
    }
    ctx.sendHtml(
      renderEvidenceIntelDashboard({
        nav: ctx.navFor(user, "evidence-intel"),
        dashboard: ei.evidenceIntelDashboard(user),
        canReview: ei.canReviewEvidence(user),
      })
    );
    return true;
  }

  if (method === "GET" && pathname === `${PAGE_PREFIX}/queue`) {
    let user: User;
    try {
      user = ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return true;
    }
    const status = ctx.searchParams.get("status") || undefined;
    ctx.sendHtml(
      renderEvidenceReviewQueue({
        nav: ctx.navFor(user, "evidence-intel"),
        items: ei.listQueue(user, status),
        activeStatus: status ?? "OPEN",
        canReview: ei.canReviewEvidence(user),
      })
    );
    return true;
  }

  const queueDetailMatch = /^\/evidence-intelligence\/queue\/([^/]+)$/.exec(pathname);
  if (method === "GET" && queueDetailMatch) {
    let user: User;
    try {
      user = ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return true;
    }
    const detail = ei.queueItemDetail(user, queueDetailMatch[1]);
    ctx.sendHtml(
      renderReviewItemDetail({
        nav: ctx.navFor(user, "evidence-intel"),
        ...detail,
        canReview: ei.canReviewEvidence(user),
      })
    );
    return true;
  }

  if (method === "GET" && pathname === `${PAGE_PREFIX}/analytics`) {
    let user: User;
    try {
      user = ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return true;
    }
    ctx.sendHtml(
      renderEvidenceAnalytics({ nav: ctx.navFor(user, "evidence-intel"), analytics: ei.evidenceAnalytics(user) })
    );
    return true;
  }

  const timelineMatch = /^\/evidence-intelligence\/timeline\/([^/]+)$/.exec(pathname);
  if (method === "GET" && timelineMatch) {
    let user: User;
    try {
      user = ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return true;
    }
    const { evidence, entries } = ei.evidenceTimeline(user, timelineMatch[1]);
    ctx.sendHtml(
      renderEvidenceTimeline({ nav: ctx.navFor(user, "evidence-intel"), evidence, entries })
    );
    return true;
  }

  const dupMatch = /^\/evidence-intelligence\/evidence\/([^/]+)$/.exec(pathname);
  if (method === "GET" && dupMatch) {
    let user: User;
    try {
      user = ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return true;
    }
    const evidence = repo.getEvidence(dupMatch[1]);
    if (!evidence) {
      ctx.sendHtml("<!doctype html><title>Not found</title><p>No such evidence.</p>", 404);
      return true;
    }
    // Analyze this item on demand so the viewer is current, then render.
    ei.analyzeEvidenceItem(user, evidence.id);
    ctx.sendHtml(
      renderDuplicateViewer({
        nav: ctx.navFor(user, "evidence-intel"),
        evidence,
        signals: ei.listSignalsForSubject("EVIDENCE_ITEM", evidence.id),
        metadata: ei.getMetadataFacts(evidence.id),
        score: ei.scoreEvidenceItem(evidence),
      })
    );
    return true;
  }

  // ---- API: reads ----
  if (method === "GET" && pathname === "/api/evidence-intel/dashboard") {
    ctx.sendJson(ei.evidenceIntelDashboard(ctx.getUser()));
    return true;
  }
  if (method === "GET" && pathname === "/api/evidence-intel/analytics") {
    ctx.sendJson(ei.evidenceAnalytics(ctx.getUser()));
    return true;
  }
  if (method === "GET" && pathname === "/api/evidence-intel/queue") {
    ctx.sendJson({ items: ei.listQueue(ctx.getUser(), ctx.searchParams.get("status") || undefined) });
    return true;
  }
  if (method === "GET" && pathname === "/api/evidence-intel/future-ai") {
    ctx.getUser(); // gate to a signed-in user
    ctx.sendJson(ei.futureAiReadiness());
    return true;
  }
  const signalsMatch = /^\/api\/evidence-intel\/signals\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (method === "GET" && signalsMatch) {
    ctx.getUser();
    ctx.sendJson({ signals: ei.listSignalsForSubject(signalsMatch[1].toUpperCase(), signalsMatch[2]) });
    return true;
  }
  const timelineApi = /^\/api\/evidence-intel\/timeline\/([^/]+)$/.exec(pathname);
  if (method === "GET" && timelineApi) {
    ctx.sendJson(ei.evidenceTimeline(ctx.getUser(), timelineApi[1]));
    return true;
  }

  // ---- API: analysis ----
  if (method === "POST" && pathname === "/api/evidence-intel/analyze") {
    const user = ctx.getUser();
    const params = await ctx.readParams();
    const result = params.projectId
      ? ei.analyzeProject(user, params.projectId, "ON_DEMAND")
      : ei.analyzePortfolio(user, "ON_DEMAND");
    if (ctx.isForm()) ctx.redirect(PAGE_PREFIX);
    else ctx.sendJson(result, 201);
    return true;
  }

  // ---- API: reviewer actions ----
  const actionMatch = /^\/api\/evidence-intel\/queue\/([^/]+)\/(acknowledge|dismiss|promote)$/.exec(pathname);
  if (method === "POST" && actionMatch) {
    const user = ctx.getUser();
    const params = await ctx.readParams();
    const note = params.note?.trim() || null;
    const [, id, action] = actionMatch;
    if (action === "acknowledge") {
      const item = ei.acknowledge(user, id, note);
      if (ctx.isForm()) ctx.redirect(`${PAGE_PREFIX}/queue/${id}`);
      else ctx.sendJson({ item });
    } else if (action === "dismiss") {
      const item = ei.dismiss(user, id, note);
      if (ctx.isForm()) ctx.redirect(`${PAGE_PREFIX}/queue/${id}`);
      else ctx.sendJson({ item });
    } else {
      const result = ei.promote(user, id, note);
      if (ctx.isForm()) ctx.redirect(`${PAGE_PREFIX}/queue/${id}`);
      else ctx.sendJson(result, 201);
    }
    return true;
  }

  // Unrecognized path under this module's prefixes: plain 404.
  if (isApi) {
    ctx.sendJson({ error: "Not found" }, 404);
    return true;
  }
  return false;
}
