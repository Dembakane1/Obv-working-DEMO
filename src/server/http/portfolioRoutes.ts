/**
 * Portfolio Intelligence API routes.
 *
 * Thin dispatch only: every authorization decision (viewer-role gate,
 * tenancy scoping, same-404 on project/entity detail) lives inside the
 * portfolio service. These endpoints are all read-only except the
 * snapshot recorder, which appends one derived observation row.
 */
import type * as http from "node:http";
import * as portfolio from "../services/portfolio";
import type { User } from "../../shared/types";

export interface PortfolioRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  searchParams: URLSearchParams;
  getUser: () => User;
  readParams: () => Promise<Record<string, string>>;
  isForm: () => boolean;
  redirect: (location: string) => void;
  sendJson: (data: unknown, status?: number) => void;
}

/** Malformed percent-encoding in an entity key is indistinguishable from
 *  an entity that does not exist. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new portfolio.PortfolioError("Not found", 404);
  }
}

function filtersFrom(searchParams: URLSearchParams): portfolio.PortfolioFilters {
  const pick = (key: string): string | undefined => {
    const value = searchParams.get(key);
    return value && value.trim().length > 0 ? value.trim() : undefined;
  };
  return {
    status: pick("status"),
    state: pick("state"),
    lenderOrgId: pick("lender"),
    contractorOrgId: pick("contractor"),
    stage: pick("stage"),
    riskBand: pick("risk"),
  };
}

/** Returns true when the request was handled by a portfolio route. */
export async function handlePortfolioRoutes(ctx: PortfolioRouteContext): Promise<boolean> {
  const { pathname, method } = ctx;
  if (!pathname.startsWith("/api/portfolio/")) return false;

  const get = (handler: (user: User) => unknown): boolean => {
    if (method !== "GET") throw new portfolio.PortfolioError("Method not allowed", 405);
    const user = ctx.getUser();
    ctx.sendJson(handler(user));
    return true;
  };

  if (pathname === "/api/portfolio/overview") {
    return get((user) => portfolio.overview(user, filtersFrom(ctx.searchParams)));
  }
  if (pathname === "/api/portfolio/risk") {
    return get((user) => portfolio.risk(user));
  }
  const projectRiskMatch = /^\/api\/portfolio\/project\/([^/]+)\/risk$/.exec(pathname);
  if (projectRiskMatch) {
    return get((user) => portfolio.projectRisk(user, projectRiskMatch[1]));
  }
  const projectForecastMatch = /^\/api\/portfolio\/project\/([^/]+)\/forecast$/.exec(pathname);
  if (projectForecastMatch) {
    return get((user) => portfolio.forecastForProject(user, projectForecastMatch[1]));
  }
  if (pathname === "/api/portfolio/contractors") {
    return get((user) => ({ contractors: portfolio.contractors(user) }));
  }
  const contractorMatch = /^\/api\/portfolio\/contractor\/([^/]+)$/.exec(pathname);
  if (contractorMatch) {
    return get((user) => portfolio.contractorDetail(user, safeDecode(contractorMatch[1])));
  }
  if (pathname === "/api/portfolio/inspectors") {
    return get((user) => ({ inspectors: portfolio.inspectors(user) }));
  }
  const inspectorMatch = /^\/api\/portfolio\/inspector\/([^/]+)$/.exec(pathname);
  if (inspectorMatch) {
    return get((user) => portfolio.inspectorDetail(user, safeDecode(inspectorMatch[1])));
  }
  if (pathname === "/api/portfolio/vendors") {
    return get((user) => ({ vendors: portfolio.vendors(user) }));
  }
  const vendorMatch = /^\/api\/portfolio\/vendor\/([^/]+)$/.exec(pathname);
  if (vendorMatch) {
    return get((user) => portfolio.vendorDetail(user, safeDecode(vendorMatch[1])));
  }
  if (pathname === "/api/portfolio/forecast") {
    return get((user) => portfolio.forecast(user));
  }
  if (pathname === "/api/portfolio/fraud") {
    return get((user) => portfolio.fraud(user));
  }
  if (pathname === "/api/portfolio/summary") {
    return get((user) => {
      const raw = (ctx.searchParams.get("period") ?? "WEEKLY").toUpperCase();
      if (!["WEEKLY", "MONTHLY", "BRIEFING"].includes(raw)) {
        throw new portfolio.PortfolioError("Unknown summary period", 400);
      }
      return portfolio.summary(user, raw as portfolio.SummaryPeriod);
    });
  }
  if (pathname === "/api/portfolio/snapshots") {
    if (method === "GET") {
      const user = ctx.getUser();
      ctx.sendJson({ snapshots: portfolio.listSnapshots(user) });
      return true;
    }
    if (method === "POST") {
      const user = ctx.getUser();
      const snapshot = portfolio.recordSnapshot(user);
      if (ctx.isForm()) {
        ctx.redirect("/executive?ok=1");
        return true;
      }
      ctx.sendJson({ snapshot }, 201);
      return true;
    }
    throw new portfolio.PortfolioError("Method not allowed", 405);
  }
  if (pathname === "/api/portfolio/government") {
    return get((user) => portfolio.government(user));
  }
  // Any other portfolio path — including every government activation
  // shape — is indistinguishable from nonexistent.
  throw new portfolio.PortfolioError("Not found", 404);
}
