/**
 * Production identity routes: passwordless sign-in, session management,
 * organization switching, owner administration, and readiness surfaces.
 *
 * Thin dispatch only — authorization, lockout, replay, CSRF, and same-404
 * decisions all live in the identity service. Every mutating route here
 * except the two anonymous sign-in steps requires BOTH a valid server-side
 * session and its synchronizer CSRF token.
 */
import type * as http from "node:http";
import { randomBytes } from "node:crypto";
import * as identity from "../services/identity";
import * as repo from "../db/repo";
import * as identityRepo from "../db/identityRepo";
import {
  renderAccountSecurity,
  renderAuthComplete,
  renderSignIn,
} from "../view/authPages";
import type { AuthSession } from "../../shared/types";

export interface IdentityRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  searchParams: URLSearchParams;
  readParams: () => Promise<Record<string, string>>;
  isForm: () => boolean;
  redirect: (location: string) => void;
  sendJson: (data: unknown, status?: number) => void;
  sendHtml: (html: string, status?: number) => void;
  secure: boolean;
  origin: string;
  demoAvailable: boolean;
}

function requestMeta(req: http.IncomingMessage): identity.RequestMeta {
  // LAST forwarded hop: appended by the trusted proxy. The first entry is
  // client-supplied, so keying lockouts on it would let an attacker both
  // dodge the ip: scope (rotate the header) and poison it for a victim.
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim() ?? "";
  return {
    ip: forwarded || req.socket.remoteAddress || null,
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) || null,
  };
}

/** Anti login-CSRF: the completion POST must present the value of a
 *  cookie our own GET confirmation page set. A cross-site page can post
 *  a token, but it can neither read nor set our cookie, so it cannot
 *  sign the victim's browser into an attacker-chosen account. */
const CONFIRM_COOKIE = "obv_confirm";

function confirmCookieHeader(secure: boolean, value: string): string {
  const flags = ["Path=/", "SameSite=Lax", "HttpOnly", "Max-Age=900"];
  if (secure) flags.push("Secure");
  return `${CONFIRM_COOKIE}=${value}; ${flags.join("; ")}`;
}

function clearConfirmCookieHeader(secure: boolean): string {
  const flags = ["Path=/", "SameSite=Lax", "HttpOnly", "Max-Age=0"];
  if (secure) flags.push("Secure");
  return `${CONFIRM_COOKIE}=; ${flags.join("; ")}`;
}

/** Expire the legacy signed demo cookie alongside the identity session:
 *  logout must not leave a second working credential in the browser. */
function clearLegacyCookieHeader(secure: boolean): string {
  const flags = ["Path=/", "SameSite=Lax", "HttpOnly", "Max-Age=0"];
  if (secure) flags.push("Secure");
  return `obv_user=; ${flags.join("; ")}`;
}

/** Session view model — the ONLY session shape that ever leaves the
 *  server. No secret hash, no CSRF token. */
function sessionView(s: AuthSession, currentId: string) {
  return {
    id: s.id,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    idleExpiresAt: s.idleExpiresAt,
    absoluteExpiresAt: s.absoluteExpiresAt,
    trustedDevice: s.trustedDevice,
    deviceLabel: s.deviceLabel,
    ip: s.ip,
    userAgent: s.userAgent,
    current: s.id === currentId,
  };
}

/** Returns true when the request was handled by an identity route. */
export async function handleIdentityRoutes(ctx: IdentityRouteContext): Promise<boolean> {
  const { pathname, method, req } = ctx;
  const handles =
    pathname === "/signin" ||
    pathname === "/account/security" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/api/auth/");
  if (!handles) return false;
  const meta = requestMeta(req);

  // ---- anonymous: sign-in page + magic-link request + completion ----

  if (method === "GET" && pathname === "/signin") {
    if (identity.resolveSession(readAuthCookie(req))) {
      ctx.redirect("/overview");
      return true;
    }
    ctx.sendHtml(
      renderSignIn({
        sent: ctx.searchParams.get("sent") === "1",
        linked: ctx.searchParams.get("linked") === "1",
        demoAvailable: ctx.demoAvailable,
      })
    );
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/magic-link") {
    const params = await ctx.readParams();
    const result = identity.requestMagicLink(params.email, ctx.origin, meta);
    if (ctx.isForm()) ctx.redirect("/signin?sent=1");
    else ctx.sendJson(result, 200);
    return true;
  }

  if (method === "GET" && pathname === "/auth/complete") {
    const token = ctx.searchParams.get("token") ?? "";
    const preview = identity.previewMagicLink(token);
    // The GET never consumes the token; the rendered POST form does. It
    // also arms the anti-login-CSRF confirm cookie the POST must echo.
    const confirm = randomBytes(16).toString("hex");
    ctx.res.setHeader("Set-Cookie", confirmCookieHeader(ctx.secure, confirm));
    ctx.sendHtml(
      renderAuthComplete({ token, confirm, usable: preview.usable, email: preview.email }),
      preview.usable ? 200 : 400
    );
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/complete") {
    const params = await ctx.readParams();
    const cookies = parseAllCookies(req);
    const confirmCookie = cookies[CONFIRM_COOKIE] ?? "";
    const confirmField = String(params.confirm ?? "");
    if (!confirmCookie || !confirmField || !identity.safeStringEqual(confirmField, confirmCookie)) {
      // Not a token-validity oracle: this rejects the REQUEST SHAPE (no
      // browser round-trip through our confirmation page), never the token.
      throw new identity.IdentityError(
        "Sign-in must be confirmed from the sign-in link page. Open the link again.",
        403
      );
    }
    const trust = ["1", "true", "on"].includes(String(params.trust ?? "").toLowerCase());
    const result = identity.completeMagicLink(
      params.token ?? "",
      { trustDevice: trust, deviceLabel: params.deviceLabel?.trim() || null },
      meta
    );
    ctx.res.setHeader("Set-Cookie", [
      ...identity.authCookieHeaders(ctx.secure, result.cookieValue, result.session),
      clearConfirmCookieHeader(ctx.secure),
    ]);
    if (ctx.isForm()) ctx.redirect(result.user.role === "FIELD" ? "/field" : "/overview");
    else
      ctx.sendJson(
        {
          user: result.user,
          identity: {
            id: result.identity.id,
            email: result.identity.email,
            displayName: result.identity.displayName,
            emailVerifiedAt: result.identity.emailVerifiedAt,
          },
          session: sessionView(result.session, result.session.id),
        },
        201
      );
    return true;
  }

  // ---- everything below requires a live session ----

  const resolved = identity.resolveSession(readAuthCookie(req));
  if (!resolved) {
    if (method === "GET" && pathname === "/account/security") {
      ctx.redirect("/signin");
      return true;
    }
    ctx.sendJson({ error: "Sign in required" }, 401);
    return true;
  }

  const csrfCheck = async (): Promise<Record<string, string>> => {
    const params = await ctx.readParams();
    const submitted = params.csrf ?? String(req.headers["x-obv-csrf"] ?? "");
    identity.requireCsrf(resolved, submitted || null);
    return params;
  };

  if (method === "GET" && pathname === "/api/auth/me") {
    const memberships = identity.membershipsForIdentity(resolved.identity).map((m) => ({
      id: m.id,
      organizationId: m.organizationId,
      organizationName: repo.getOrganization(m.organizationId)?.name ?? null,
      userId: m.userId,
      role: repo.getUser(m.userId)?.role ?? null,
      status: m.status,
      isOwner: m.isOwner,
      current: m.userId === resolved.user.id,
    }));
    ctx.sendJson({
      identity: {
        id: resolved.identity.id,
        email: resolved.identity.email,
        displayName: resolved.identity.displayName,
        emailVerifiedAt: resolved.identity.emailVerifiedAt,
        status: resolved.identity.status,
      },
      user: resolved.user,
      memberships,
      session: sessionView(resolved.session, resolved.session.id),
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/auth/sessions") {
    ctx.sendJson({
      sessions: identityRepo
        .listSessionsForIdentity(resolved.identity.id)
        .map((s) => sessionView(s, resolved.session.id)),
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/auth/history") {
    ctx.sendJson({ events: identity.loginHistory(resolved.identity) });
    return true;
  }

  if (method === "GET" && pathname === "/api/auth/sso/readiness") {
    ctx.sendJson(identity.ssoReadiness());
    return true;
  }

  if (method === "GET" && pathname === "/api/auth/mfa/readiness") {
    ctx.sendJson(identity.mfaReadiness(resolved.identity));
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    await csrfCheck();
    identity.logout(resolved, meta);
    ctx.res.setHeader("Set-Cookie", [
      ...identity.clearAuthCookieHeaders(ctx.secure),
      clearLegacyCookieHeader(ctx.secure),
    ]);
    if (ctx.isForm()) ctx.redirect("/signin");
    else ctx.sendJson({ ok: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/logout-all") {
    await csrfCheck();
    const revoked = identity.logoutEverywhere(resolved, meta);
    ctx.res.setHeader("Set-Cookie", [
      ...identity.clearAuthCookieHeaders(ctx.secure),
      clearLegacyCookieHeader(ctx.secure),
    ]);
    if (ctx.isForm()) ctx.redirect("/signin");
    else ctx.sendJson({ ok: true, revoked });
    return true;
  }

  const revokeMatch = /^\/api\/auth\/sessions\/([a-f0-9]+)\/revoke$/.exec(pathname);
  if (method === "POST" && revokeMatch) {
    await csrfCheck();
    identity.revokeOwnSession(resolved, revokeMatch[1], meta);
    if (ctx.isForm()) ctx.redirect("/account/security");
    else ctx.sendJson({ ok: true });
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/switch-org") {
    const params = await csrfCheck();
    const result = identity.switchOrganization(resolved, params.membershipId ?? "", meta);
    ctx.res.setHeader("Set-Cookie", identity.authCookieHeaders(ctx.secure, result.cookieValue, result.session));
    if (ctx.isForm()) ctx.redirect(result.user.role === "FIELD" ? "/field" : "/overview");
    else ctx.sendJson({ user: result.user, session: sessionView(result.session, result.session.id) });
    return true;
  }

  const memberActionMatch = /^\/api\/auth\/memberships\/([^/]+)\/(suspend|restore|deactivate)$/.exec(pathname);
  if (method === "POST" && memberActionMatch) {
    await csrfCheck();
    const [, id, action] = memberActionMatch;
    const membership =
      action === "suspend"
        ? identity.suspendMembership(resolved, id, meta)
        : action === "restore"
          ? identity.restoreMembership(resolved, id, meta)
          : identity.deactivateMembership(resolved, id, meta);
    if (ctx.isForm()) ctx.redirect("/account/security");
    else ctx.sendJson({ membership });
    return true;
  }

  const transferMatch = /^\/api\/auth\/orgs\/([^/]+)\/transfer-ownership$/.exec(pathname);
  if (method === "POST" && transferMatch) {
    const params = await csrfCheck();
    const membership = identity.transferOwnership(resolved, transferMatch[1], params.membershipId ?? "", meta);
    if (ctx.isForm()) ctx.redirect("/account/security");
    else ctx.sendJson({ membership });
    return true;
  }

  if (method === "GET" && pathname === "/account/security") {
    const memberships = identity.membershipsForIdentity(resolved.identity).map((m) => ({
      membership: m,
      org: repo.getOrganization(m.organizationId),
      user: repo.getUser(m.userId),
      current: m.userId === resolved.user.id,
    }));
    const administrable = identity
      .administrableMemberships(resolved)
      .filter((m) => m.identityId !== resolved.identity.id)
      .map((m) => ({
        membership: m,
        org: repo.getOrganization(m.organizationId),
        user: repo.getUser(m.userId),
        identityEmail: identityRepo.getIdentity(m.identityId)?.email ?? null,
      }));
    ctx.sendHtml(
      renderAccountSecurity({
        identity: resolved.identity,
        user: resolved.user,
        currentSessionId: resolved.session.id,
        csrfToken: resolved.session.csrfToken,
        memberships,
        sessions: identityRepo.listSessionsForIdentity(resolved.identity.id),
        history: identity.loginHistory(resolved.identity),
        administrable,
        ssoNote: identity.ssoReadiness().note,
        mfaNote: identity.mfaReadiness(resolved.identity).note,
      })
    );
    return true;
  }

  // An unrecognized path under this module's prefixes is a plain 404.
  ctx.sendJson({ error: "Not found" }, 404);
  return true;
}

function parseAllCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      const raw = part.slice(eq + 1).trim();
      // Malformed percent-encoding reads as the raw value — a corrupt
      // cookie must mean "not signed in", never a URIError-driven 500.
      try {
        out[part.slice(0, eq).trim()] = decodeURIComponent(raw);
      } catch {
        out[part.slice(0, eq).trim()] = raw;
      }
    }
  }
  return out;
}

function readAuthCookie(req: http.IncomingMessage): string | undefined {
  return parseAllCookies(req)[identity.AUTH_COOKIE];
}
