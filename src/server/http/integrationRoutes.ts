/**
 * Production Integrations Platform routes. Thin dispatch only: role
 * gates, org scoping, and same-404 decisions live in the integrations
 * services. No response here ever carries a secret — the single
 * exception is the webhook signing secret at REGISTRATION, which the
 * service returns exactly once by design.
 */
import type * as http from "node:http";
import * as integrations from "../services/integrations";
import { renderIntegrations } from "../view/integrationPages";
import type { NavContext } from "../view/components";
import type { User } from "../../shared/types";

export interface IntegrationRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  searchParams: URLSearchParams;
  getUser: () => User;
  /** Where an unauthenticated page GET goes (posture-aware sign-in). */
  signInLocation: string;
  navFor: (user: User, active: string) => NavContext;
  readParams: () => Promise<Record<string, string>>;
  isForm: () => boolean;
  redirect: (location: string) => void;
  sendJson: (data: unknown, status?: number) => void;
  sendHtml: (html: string, status?: number) => void;
  sendText: (body: string, contentType: string, filename?: string) => void;
}

/** Returns true when the request was handled by an integration route. */
export async function handleIntegrationRoutes(ctx: IntegrationRouteContext): Promise<boolean> {
  const { pathname, method } = ctx;
  if (pathname !== "/integrations" && !pathname.startsWith("/api/integrations/")) return false;

  // ---- dashboard page ----
  if (method === "GET" && pathname === "/integrations") {
    let user: User;
    try {
      user = ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return true;
    }
    const dashboard = integrations.integrationsDashboard(user);
    ctx.sendHtml(
      renderIntegrations({
        nav: ctx.navFor(user, "integrations"),
        dashboard,
        calendar: integrations.listCalendar(user),
        esign: integrations.listSignatureRequests(user),
        endpoints: integrations.listEndpoints(user),
        deliveries: integrations.listDeliveries(user),
        permitDeadlines: integrations.suggestedPermitDeadlines(user),
        canManage: integrations.canManageIntegrations(user),
      })
    );
    return true;
  }

  if (method === "GET" && pathname === "/api/integrations/dashboard") {
    ctx.sendJson(integrations.integrationsDashboard(ctx.getUser()));
    return true;
  }

  // ---- email ----
  if (method === "POST" && pathname === "/api/integrations/email/test") {
    const user = ctx.getUser();
    integrations.assertIntegrationManager(user);
    const params = await ctx.readParams();
    const composed = integrations.composeEmail("EXECUTIVE_SUMMARY", {
      period: "integration test",
      summaryText: "This is a delivery test from the OBV integrations dashboard.",
    });
    const entry = integrations.sendEmail(
      {
        kind: "EXECUTIVE_SUMMARY",
        to: params.to ?? "",
        subject: composed.subject,
        text: composed.text,
        organizationId: user.organizationId,
      },
      user
    );
    if (ctx.isForm()) ctx.redirect("/integrations");
    else ctx.sendJson({ email: entry }, 201);
    return true;
  }

  // ---- Teams payload preview (pure builder — no delivery) ----
  if (method === "POST" && pathname === "/api/integrations/teams/preview") {
    const user = ctx.getUser();
    integrations.assertIntegrationViewer(user);
    const params = await ctx.readParams();
    const card = integrations.buildTeamsCard({
      kind: (params.kind ?? "") as integrations.TeamsEventKind,
      title: params.title ?? "",
      projectName: params.projectName ?? null,
      organizationName: params.organizationName ?? null,
      amount: params.amount ?? null,
      status: params.status ?? null,
      summary: params.summary ?? null,
    });
    ctx.sendJson({ card });
    return true;
  }

  // ---- calendar ----
  if (method === "GET" && pathname === "/api/integrations/calendar") {
    ctx.sendJson({ events: integrations.listCalendar(ctx.getUser()) });
    return true;
  }
  if (method === "GET" && pathname === "/api/integrations/calendar/permit-deadlines") {
    ctx.sendJson({ deadlines: integrations.suggestedPermitDeadlines(ctx.getUser()) });
    return true;
  }
  if (method === "POST" && pathname === "/api/integrations/calendar") {
    const user = ctx.getUser();
    const params = await ctx.readParams();
    const event = integrations.createCalendarEvent(user, params as never);
    if (ctx.isForm()) ctx.redirect("/integrations");
    else ctx.sendJson({ event }, 201);
    return true;
  }
  const calActionMatch = /^\/api\/integrations\/calendar\/([^/]+)\/(complete|cancel)$/.exec(pathname);
  if (method === "POST" && calActionMatch) {
    const user = ctx.getUser();
    const event = integrations.setCalendarEventStatus(
      user,
      calActionMatch[1],
      calActionMatch[2] === "complete" ? "COMPLETED" : "CANCELLED"
    );
    if (ctx.isForm()) ctx.redirect("/integrations");
    else ctx.sendJson({ event });
    return true;
  }
  const icsMatch = /^\/api\/integrations\/calendar\/([^/]+)\.ics$/.exec(pathname);
  if (method === "GET" && icsMatch) {
    const user = ctx.getUser();
    const event = integrations.calendarEventForIcs(user, icsMatch[1]);
    ctx.sendText(integrations.buildIcs(event), "text/calendar; charset=utf-8", `obv-${event.id}.ics`);
    return true;
  }

  // ---- e-signature ----
  if (method === "GET" && pathname === "/api/integrations/esign") {
    ctx.sendJson({ requests: integrations.listSignatureRequests(ctx.getUser()) });
    return true;
  }
  if (method === "POST" && pathname === "/api/integrations/esign") {
    const user = ctx.getUser();
    const params = await ctx.readParams();
    const request = integrations.createSignatureRequest(user, params as never);
    if (ctx.isForm()) ctx.redirect("/integrations");
    else ctx.sendJson({ request }, 201);
    return true;
  }
  const esignActionMatch = /^\/api\/integrations\/esign\/([^/]+)\/(signed|declined|cancel)$/.exec(pathname);
  if (method === "POST" && esignActionMatch) {
    const user = ctx.getUser();
    const decision =
      esignActionMatch[2] === "signed" ? "SIGNED" : esignActionMatch[2] === "declined" ? "DECLINED" : "CANCELLED";
    const params = await ctx.readParams();
    const request = integrations.settleSignatureRequest(user, esignActionMatch[1], decision, params.detail ?? null);
    if (ctx.isForm()) ctx.redirect("/integrations");
    else ctx.sendJson({ request });
    return true;
  }
  const esignDetailMatch = /^\/api\/integrations\/esign\/([^/]+)$/.exec(pathname);
  if (method === "GET" && esignDetailMatch) {
    ctx.sendJson(integrations.signatureRequestDetail(ctx.getUser(), esignDetailMatch[1]));
    return true;
  }

  // ---- accounting (export-only) ----
  if (method === "POST" && pathname === "/api/integrations/accounting/export") {
    const user = ctx.getUser();
    const result = integrations.runExport(user);
    if (ctx.isForm()) ctx.redirect("/integrations");
    else ctx.sendJson(result, 201);
    return true;
  }
  if (method === "GET" && pathname === "/api/integrations/accounting/runs") {
    ctx.sendJson({ runs: integrations.listSyncRuns(ctx.getUser()) });
    return true;
  }
  if (method === "GET" && pathname === "/api/integrations/accounting/links") {
    ctx.sendJson({ links: integrations.listLinks(ctx.getUser()) });
    return true;
  }

  // ---- webhooks ----
  if (method === "GET" && pathname === "/api/integrations/webhooks") {
    ctx.sendJson({ endpoints: integrations.listEndpoints(ctx.getUser()) });
    return true;
  }
  if (method === "POST" && pathname === "/api/integrations/webhooks") {
    const user = ctx.getUser();
    const params = await ctx.readParams();
    const result = integrations.registerEndpoint(user, {
      url: params.url ?? "",
      description: params.description ?? null,
      events: params.events ?? "*",
    });
    if (ctx.isForm()) ctx.redirect("/integrations");
    else ctx.sendJson(result, 201);
    return true;
  }
  const hookActionMatch = /^\/api\/integrations\/webhooks\/([^/]+)\/(enable|disable)$/.exec(pathname);
  if (method === "POST" && hookActionMatch) {
    const user = ctx.getUser();
    integrations.setEndpointActive(user, hookActionMatch[1], hookActionMatch[2] === "enable");
    if (ctx.isForm()) ctx.redirect("/integrations");
    else ctx.sendJson({ ok: true });
    return true;
  }
  if (method === "GET" && pathname === "/api/integrations/webhooks/deliveries") {
    ctx.sendJson({ deliveries: integrations.listDeliveries(ctx.getUser()) });
    return true;
  }
  if (method === "POST" && pathname === "/api/integrations/webhooks/dispatch") {
    const user = ctx.getUser();
    integrations.assertIntegrationManager(user);
    const result = await integrations.dispatchDueDeliveries();
    if (ctx.isForm()) ctx.redirect("/integrations");
    else ctx.sendJson(result);
    return true;
  }
  const requeueMatch = /^\/api\/integrations\/webhooks\/deliveries\/([^/]+)\/requeue$/.exec(pathname);
  if (method === "POST" && requeueMatch) {
    const user = ctx.getUser();
    integrations.requeueDeadLetter(user, requeueMatch[1]);
    if (ctx.isForm()) ctx.redirect("/integrations");
    else ctx.sendJson({ ok: true });
    return true;
  }
  if (method === "POST" && pathname === "/api/integrations/webhooks/emit-test") {
    // Manager-scoped test emission so a lender can validate an endpoint
    // end-to-end without waiting for a real domain event.
    const user = ctx.getUser();
    integrations.assertIntegrationManager(user);
    const params = await ctx.readParams();
    const kind = params.eventKind ?? "portfolio.alert";
    const eventId = params.eventId ?? `test-${Date.now()}`;
    const queued = integrations.emitWebhookEvent(user.organizationId, kind, eventId, {
      test: true,
      requestedBy: user.id,
    });
    if (ctx.isForm()) ctx.redirect("/integrations");
    else ctx.sendJson({ queued });
    return true;
  }

  // Unrecognized path under this module's prefix: plain 404.
  ctx.sendJson({ error: "Not found" }, 404);
  return true;
}
