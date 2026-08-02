/**
 * Official Source Connectors routes.
 *
 * Thin dispatch only: role gates, tenant scoping, and same-404 decisions
 * live in the officialSources services. Everything reachable here is
 * either a read of connector-layer state or an explicit authorized
 * retrieval/review action; a route here never approves, rejects, or
 * releases funds, and none changes an authoritative verification,
 * permit-basis, inspection, or historical record — reviewer
 * confirmations delegate to the existing governed DMV/permits/exceptions
 * commands with their own authorization. Page loads never trigger
 * retrieval; refreshes are explicit POSTs.
 */
import type * as http from "node:http";
import * as src from "../services/officialSources";
import type { NavContext } from "../view/components";
import type { User } from "../../shared/types";
import {
  renderSourceWorkspace,
  renderSourceQueue,
  renderSourceQueueItem,
  renderSourceDetail,
  renderSourceLookup,
  renderProjectSources,
  renderSourceChanges,
  renderSnapshotPreview,
} from "../view/officialSourcePages";

export interface OfficialSourceRouteContext {
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

const PAGE_PREFIX = "/official-sources";

/** Returns true when the request was handled by an official-sources route. */
export async function handleOfficialSourceRoutes(ctx: OfficialSourceRouteContext): Promise<boolean> {
  const { pathname, method } = ctx;
  const isApi = pathname.startsWith("/api/official-sources/");
  if (!pathname.startsWith(PAGE_PREFIX) && !isApi) return false;

  const pageUser = (): User | null => {
    try {
      return ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return null;
    }
  };

  // ---- pages ----
  if (method === "GET" && (pathname === PAGE_PREFIX || pathname === `${PAGE_PREFIX}/`)) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderSourceWorkspace({
        nav: ctx.navFor(user, "official-sources"),
        registry: src.listSourceRegistry(user),
        stats: src.queueStats(user),
        analytics: src.officialSourceAnalytics(user),
        canReview: src.canReviewSources(user),
      })
    );
    return true;
  }

  if (method === "GET" && pathname === `${PAGE_PREFIX}/queue`) {
    const user = pageUser();
    if (!user) return true;
    const status = ctx.searchParams.get("status") || "OPEN";
    ctx.sendHtml(
      renderSourceQueue({
        nav: ctx.navFor(user, "official-sources"),
        items: src.listQueue(user, status),
        activeStatus: status,
        canReview: src.canReviewSources(user),
      })
    );
    return true;
  }

  const queueItemMatch = /^\/official-sources\/queue\/([^/]+)$/.exec(pathname);
  if (method === "GET" && queueItemMatch) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderSourceQueueItem({
        nav: ctx.navFor(user, "official-sources"),
        detail: src.queueItemDetail(user, queueItemMatch[1]),
        canReview: src.canReviewSources(user),
      })
    );
    return true;
  }

  const sourceMatch = /^\/official-sources\/source\/([^/]+)$/.exec(pathname);
  if (method === "GET" && sourceMatch) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderSourceDetail({
        nav: ctx.navFor(user, "official-sources"),
        view: src.getSourceView(user, sourceMatch[1]),
        canReview: src.canReviewSources(user),
      })
    );
    return true;
  }

  if (pathname === `${PAGE_PREFIX}/lookup` && (method === "GET" || method === "POST")) {
    const user = pageUser();
    if (!user) return true;
    let results = null;
    let query: Record<string, string> = {};
    if (method === "POST") {
      const params = await ctx.readParams();
      query = {
        sourceId: params.sourceId ?? "",
        permitNumber: params.permitNumber ?? "",
        address: params.address ?? "",
        party: params.party ?? "",
        projectId: params.projectId ?? "",
      };
      if (query.sourceId) {
        const scopeProject = query.projectId
          ? src.requireVisibleProject(user, query.projectId)
          : null;
        results = await src.searchSource(
          query.sourceId,
          {
            permitNumber: query.permitNumber || undefined,
            address: query.address || undefined,
            party: query.party || undefined,
            limit: 25,
          },
          {
            actorUserId: user.id,
            organizationId: scopeProject?.organizationId ?? null,
            projectId: scopeProject?.id ?? null,
          }
        );
      }
    }
    ctx.sendHtml(
      renderSourceLookup({
        nav: ctx.navFor(user, "official-sources"),
        registry: src.listSourceRegistry(user),
        query,
        results,
      })
    );
    return true;
  }

  const projectMatch = /^\/official-sources\/project\/([^/]+)$/.exec(pathname);
  if (method === "GET" && projectMatch) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderProjectSources({
        nav: ctx.navFor(user, "official-sources"),
        records: src.projectSourceRecords(user, projectMatch[1]),
        registry: src.listSourceRegistry(user),
      })
    );
    return true;
  }

  if (method === "GET" && pathname === `${PAGE_PREFIX}/changes`) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderSourceChanges({
        nav: ctx.navFor(user, "official-sources"),
        analytics: src.officialSourceAnalytics(user),
        items: src.listQueue(user),
      })
    );
    return true;
  }

  const snapshotMatch = /^\/official-sources\/snapshot\/([^/]+)$/.exec(pathname);
  if (method === "GET" && snapshotMatch) {
    const user = pageUser();
    if (!user) return true;
    ctx.sendHtml(
      renderSnapshotPreview({
        nav: ctx.navFor(user, "official-sources"),
        ...src.snapshotPreview(user, snapshotMatch[1]),
      })
    );
    return true;
  }

  // ---- API: reads ----
  if (method === "GET" && pathname === "/api/official-sources/registry") {
    ctx.sendJson({ registry: src.listSourceRegistry(ctx.getUser()) });
    return true;
  }
  if (method === "GET" && pathname === "/api/official-sources/queue") {
    ctx.sendJson({ items: src.listQueue(ctx.getUser(), ctx.searchParams.get("status") || undefined) });
    return true;
  }
  if (method === "GET" && pathname === "/api/official-sources/analytics") {
    ctx.sendJson(src.officialSourceAnalytics(ctx.getUser()));
    return true;
  }
  if (method === "GET" && pathname === "/api/official-sources/dead-letters") {
    ctx.sendJson({ deadLetters: src.listDeadLetterQueue(ctx.getUser()) });
    return true;
  }

  // ---- API: health + refresh (explicit actions, never page loads) ----
  const healthMatch = /^\/api\/official-sources\/source\/([^/]+)\/health$/.exec(pathname);
  if (method === "POST" && healthMatch) {
    ctx.sendJson(await src.checkSourceHealth(ctx.getUser(), healthMatch[1]));
    return true;
  }
  const refreshMatch = /^\/api\/official-sources\/source\/([^/]+)\/refresh$/.exec(pathname);
  if (method === "POST" && refreshMatch) {
    const user = ctx.getUser();
    const params = await ctx.readParams();
    const summary = await src.refreshSource(user, refreshMatch[1], { projectId: params.projectId || null });
    if (ctx.isForm()) ctx.redirect(params.projectId ? `${PAGE_PREFIX}/project/${params.projectId}` : `${PAGE_PREFIX}/source/${refreshMatch[1]}`);
    else ctx.sendJson(summary, 201);
    return true;
  }
  if (method === "POST" && pathname === "/api/official-sources/refresh-project") {
    const user = ctx.getUser();
    const params = await ctx.readParams();
    const summaries = await src.refreshProject(user, params.projectId ?? "");
    if (ctx.isForm()) ctx.redirect(`${PAGE_PREFIX}/project/${params.projectId}`);
    else ctx.sendJson({ summaries }, 201);
    return true;
  }
  if (method === "POST" && pathname === "/api/official-sources/refresh-portfolio") {
    const user = ctx.getUser();
    const summaries = await src.refreshPortfolio(user);
    if (ctx.isForm()) ctx.redirect(PAGE_PREFIX);
    else ctx.sendJson({ summaries }, 201);
    return true;
  }
  if (method === "POST" && pathname === "/api/official-sources/poll") {
    // Scheduled external invocation (cron hitting the API with reviewer
    // credentials); refuses unless polling is explicitly enabled.
    ctx.sendJson({ summaries: await src.runScheduledPoll(ctx.getUser()) }, 201);
    return true;
  }

  // ---- API: source operational controls ----
  const pauseMatch = /^\/api\/official-sources\/source\/([^/]+)\/(pause|resume)$/.exec(pathname);
  if (method === "POST" && pauseMatch) {
    const user = ctx.getUser();
    src.setSourcePaused(user, pauseMatch[1], pauseMatch[2] === "pause");
    if (ctx.isForm()) ctx.redirect(`${PAGE_PREFIX}/source/${pauseMatch[1]}`);
    else ctx.sendJson({ ok: true });
    return true;
  }

  // ---- API: dead letters ----
  const dlqMatch = /^\/api\/official-sources\/dead-letters\/([^/]+)\/(requeue|discard)$/.exec(pathname);
  if (method === "POST" && dlqMatch) {
    const user = ctx.getUser();
    if (dlqMatch[2] === "requeue") {
      ctx.sendJson(await src.requeueDeadLetter(user, dlqMatch[1]), 201);
    } else {
      src.discardDeadLetter(user, dlqMatch[1]);
      ctx.sendJson({ ok: true });
    }
    return true;
  }

  // ---- API: reviewer actions ----
  const actionMatch = /^\/api\/official-sources\/queue\/([^/]+)\/(confirm|reject|defer|manual|discrepancy|promote)$/.exec(pathname);
  if (method === "POST" && actionMatch) {
    const user = ctx.getUser();
    const params = await ctx.readParams();
    const note = params.note?.trim() || null;
    const [, id, action] = actionMatch;
    let payload: unknown;
    if (action === "confirm") payload = src.confirmAndAttach(user, id, { note });
    else if (action === "reject") payload = { item: src.rejectMatch(user, id, note) };
    else if (action === "defer") payload = { item: src.deferItem(user, id, note) };
    else if (action === "manual") payload = { item: src.requestManualVerification(user, id, note) };
    else if (action === "discrepancy") payload = src.recordDiscrepancy(user, id, { summary: params.summary ?? "", note });
    else payload = src.promoteToException(user, id, note);
    if (ctx.isForm()) ctx.redirect(`${PAGE_PREFIX}/queue/${id}`);
    else ctx.sendJson(payload, 201);
    return true;
  }

  // Unrecognized path under this module's prefixes: plain 404.
  if (isApi) {
    ctx.sendJson({ error: "Not found" }, 404);
    return true;
  }
  return false;
}
