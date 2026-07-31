/**
 * Pilot Readiness API routes: /api/pilot-ops/* (org-scoped surfaces),
 * /api/internal/* (operator console — nondisclosing 404 for lender-side
 * roles), and the provider-neutral e-sign webhook intake.
 *
 * Thin dispatch only — every authorization decision lives in the
 * services. Reads are pure; writes are the explicitly modeled actions
 * (settings, suspension, preferences, read receipts, feedback, exports,
 * backups, flags, banners, demo generation), each audited in-service.
 */
import type * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { User } from "../../shared/types";
import { DATA_DIR } from "../db/index";
import * as pilotOps from "../services/pilotOps";
import { PilotOpsError } from "../services/pilotOps";
import * as prepo from "../db/pilotOpsRepo";

export interface PilotOpsRouteContext {
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

export async function handlePilotOpsRoutes(ctx: PilotOpsRouteContext): Promise<boolean> {
  const { pathname, method } = ctx;

  // ---- e-sign webhook (token-gated; no session) ----
  const webhookMatch = /^\/api\/esign\/webhook\/([^/]+)$/.exec(pathname);
  if (webhookMatch) {
    if (method !== "POST") throw new PilotOpsError("Not found", 404);
    const body = await ctx.readParams();
    const token = ctx.searchParams.get("token");
    const result = pilotOps.integrations.handleEsignWebhook(webhookMatch[1], token, {
      reference: body.reference,
      event: body.event,
      detail: body.detail,
    });
    ctx.sendJson(result);
    return true;
  }

  const isOps = pathname.startsWith("/api/pilot-ops/");
  const isInternal = pathname.startsWith("/api/internal/");
  if (!isOps && !isInternal) return false;

  const user = ctx.getUser();
  const body = method === "POST" ? await ctx.readParams() : {};
  const finish = (backTo: string | null, json: unknown, status = 200): true => {
    if (ctx.isForm() && backTo) ctx.redirect(`${backTo}?ok=1`);
    else ctx.sendJson(json, status);
    return true;
  };
  const flag = (value: unknown): boolean => value === true || value === "1" || value === "true" || value === "on";

  // ================= org-scoped surfaces =================
  if (pathname === "/api/pilot-ops/onboarding" && method === "GET") {
    ctx.sendJson(pilotOps.onboarding.onboardingStatus(user));
    return true;
  }
  if (pathname === "/api/pilot-ops/onboarding/step" && method === "POST") {
    return finish("/onboarding", pilotOps.onboarding.completeStep(user, String(body.stepKey ?? "")));
  }
  if (pathname === "/api/pilot-ops/org-settings" && method === "POST") {
    const settings = pilotOps.onboarding.updateOrganizationSettings(user, {
      displayName: body.displayName ?? undefined,
      legalName: body.legalName ?? undefined,
      website: body.website ?? undefined,
      phone: body.phone ?? undefined,
      brandColor: body.brandColor ?? undefined,
      timezone: body.timezone ?? undefined,
      locale: body.locale ?? undefined,
      defaultNotificationChannel: body.defaultNotificationChannel ?? undefined,
    });
    return finish("/onboarding", { settings });
  }
  if (pathname === "/api/pilot-ops/org-logo" && method === "POST") {
    // Logo upload as a base64 data URL (PNG/JPEG, ≤512 KB decoded).
    pilotOps.assertOrgAdmin(user);
    const dataUrl = String(body.dataUrl ?? "");
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) throw new PilotOpsError("Logo must be a PNG or JPEG data URL", 400);
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length === 0 || bytes.length > 512 * 1024) {
      throw new PilotOpsError("Logo must be between 1 byte and 512 KB", 400);
    }
    const dir = path.join(DATA_DIR, "uploads", "branding");
    fs.mkdirSync(dir, { recursive: true });
    const logoPath = path.join(dir, `${user.organizationId}.${match[1] === "png" ? "png" : "jpg"}`);
    fs.writeFileSync(logoPath, bytes);
    const settings = pilotOps.onboarding.updateOrganizationSettings(user, { logoPath });
    return finish("/onboarding", { settings });
  }
  if (pathname === "/api/pilot-ops/org-logo" && method === "GET") {
    pilotOps.assertOrgAdmin(user);
    const settings = prepo.getOrganizationSettings(user.organizationId);
    if (!settings?.logoPath || !fs.existsSync(settings.logoPath)) {
      throw new PilotOpsError("Logo not found", 404);
    }
    const type = settings.logoPath.endsWith(".png") ? "image/png" : "image/jpeg";
    ctx.res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    ctx.res.end(fs.readFileSync(settings.logoPath));
    return true;
  }

  if (pathname === "/api/pilot-ops/users" && method === "GET") {
    ctx.sendJson(pilotOps.userAdmin.userDirectory(user));
    return true;
  }
  const userActionMatch = /^\/api\/pilot-ops\/users\/([^/]+)\/(suspend|restore|mfa)$/.exec(pathname);
  if (userActionMatch && method === "POST") {
    const [, targetId, action] = userActionMatch;
    if (action === "suspend") {
      return finish("/admin", { state: pilotOps.userAdmin.suspendUser(user, targetId, String(body.reason ?? "")) });
    }
    if (action === "restore") {
      return finish("/admin", { state: pilotOps.userAdmin.restoreUser(user, targetId) });
    }
    return finish("/admin", { state: pilotOps.userAdmin.setMfaReadiness(user, targetId, flag(body.ready)) });
  }
  const accessMatch = /^\/api\/pilot-ops\/users\/([^/]+)\/access$/.exec(pathname);
  if (accessMatch && method === "GET") {
    ctx.sendJson({
      events: pilotOps.userAdmin.accessHistory(user, accessMatch[1]),
      devices: pilotOps.userAdmin.deviceHistory(user, accessMatch[1]),
    });
    return true;
  }
  if (pathname === "/api/pilot-ops/permission-matrix" && method === "GET") {
    pilotOps.assertOrgAdmin(user);
    ctx.sendJson({ matrix: pilotOps.userAdmin.PERMISSION_MATRIX });
    return true;
  }

  if (pathname === "/api/pilot-ops/notifications" && method === "GET") {
    ctx.sendJson(pilotOps.notifications.notificationFeed(user));
    return true;
  }
  if (pathname === "/api/pilot-ops/notifications/read" && method === "POST") {
    pilotOps.notifications.markRead(user, String(body.key ?? ""));
    return finish("/notifications", { ok: true });
  }
  if (pathname === "/api/pilot-ops/notifications/read-all" && method === "POST") {
    return finish("/notifications", { marked: pilotOps.notifications.markAllRead(user) });
  }
  if (pathname === "/api/pilot-ops/notification-prefs") {
    if (method === "GET") {
      ctx.sendJson(pilotOps.notifications.preferences(user));
      return true;
    }
    if (method === "POST") {
      const prefs = pilotOps.notifications.updatePreferences(user, {
        inApp: body.inApp !== undefined ? flag(body.inApp) : undefined,
        email: body.email !== undefined ? flag(body.email) : undefined,
        dailyDigest: body.dailyDigest !== undefined ? flag(body.dailyDigest) : undefined,
        weeklyDigest: body.weeklyDigest !== undefined ? flag(body.weeklyDigest) : undefined,
        mutedTypes: body.mutedTypes !== undefined ? String(body.mutedTypes).split(",").filter(Boolean) : undefined,
      });
      return finish("/notifications", { prefs });
    }
  }
  if (pathname === "/api/pilot-ops/digest" && method === "POST") {
    const period = String(body.period ?? "WEEKLY").toUpperCase();
    if (!["DAILY", "WEEKLY"].includes(period)) throw new PilotOpsError("Unknown digest period", 400);
    const emailRecord = pilotOps.notifications.sendDigest(user, period as "DAILY" | "WEEKLY");
    return finish("/notifications", { email: emailRecord, skipped: emailRecord === null });
  }
  if (pathname === "/api/pilot-ops/emails" && method === "GET") {
    // Org-scoped outbox: administrators see only mail addressed to their
    // own organization's users (or queued by templates they own).
    pilotOps.assertOrgAdmin(user);
    const orgUserIds = new Set(
      (await Promise.resolve(pilotOps.userAdmin.userDirectory(user).users)).map((entry) => entry.user.id)
    );
    ctx.sendJson({
      emails: prepo.listOutbox(200).filter((email) => email.toUserId === null || orgUserIds.has(email.toUserId)),
    });
    return true;
  }

  // ---- e-sign (org-scoped) ----
  if (pathname === "/api/pilot-ops/esign") {
    if (method === "GET") {
      ctx.sendJson({
        requests: pilotOps.integrations.listSignatureRequests(user),
        knownProviders: pilotOps.integrations.ESIGN_KNOWN_PROVIDERS,
      });
      return true;
    }
    if (method === "POST") {
      const request = pilotOps.integrations.createSignatureRequest(user, {
        title: String(body.title ?? ""),
        signerName: String(body.signerName ?? ""),
        signerEmail: String(body.signerEmail ?? ""),
        projectId: body.projectId ? String(body.projectId) : null,
        documentPath: body.documentPath ? String(body.documentPath) : null,
      });
      return finish("/admin", { request }, 201);
    }
  }
  const esignSendMatch = /^\/api\/pilot-ops\/esign\/([^/]+)\/send$/.exec(pathname);
  if (esignSendMatch && method === "POST") {
    return finish("/admin", { request: pilotOps.integrations.sendSignatureRequest(user, esignSendMatch[1]) });
  }
  const esignDetailMatch = /^\/api\/pilot-ops\/esign\/([^/]+)$/.exec(pathname);
  if (esignDetailMatch && method === "GET") {
    ctx.sendJson(pilotOps.integrations.signatureRequestDetail(user, esignDetailMatch[1]));
    return true;
  }

  // ---- accounting (org-scoped) ----
  if (pathname === "/api/pilot-ops/accounting" && method === "GET") {
    ctx.sendJson({
      connections: pilotOps.integrations.listConnections(user),
      runs: pilotOps.integrations.listRuns(user),
      datasets: pilotOps.integrations.ACCOUNTING_DATASETS,
    });
    return true;
  }
  if (pathname === "/api/pilot-ops/accounting/export" && method === "POST") {
    const { run } = pilotOps.integrations.exportDataset(
      user,
      String(body.provider ?? "CSV").toUpperCase(),
      String(body.dataset ?? "").toUpperCase() as pilotOps.integrations.AccountingDataset
    );
    return finish("/admin", { run }, 201);
  }
  if (pathname === "/api/pilot-ops/accounting/import" && method === "POST") {
    const run = pilotOps.integrations.importCsv(
      user,
      String(body.dataset ?? "").toUpperCase() as pilotOps.integrations.AccountingDataset,
      String(body.csv ?? "")
    );
    return finish("/admin", { run }, 201);
  }

  // ---- feedback ----
  if (pathname === "/api/pilot-ops/feedback") {
    if (method === "GET") {
      ctx.sendJson(pilotOps.success.feedbackForUser(user));
      return true;
    }
    if (method === "POST") {
      const item = pilotOps.success.submitFeedback(user, {
        kind: String(body.kind ?? ""),
        title: String(body.title ?? ""),
        body: String(body.body ?? ""),
        severity: body.severity ? String(body.severity) : undefined,
        pagePath: body.pagePath ? String(body.pagePath) : null,
        screenshotPath: null,
      });
      return finish("/feedback", { item }, 201);
    }
  }
  const feedbackDetailMatch = /^\/api\/pilot-ops\/feedback\/([^/]+)$/.exec(pathname);
  if (feedbackDetailMatch && method === "GET") {
    ctx.sendJson(pilotOps.success.feedbackDetail(user, feedbackDetailMatch[1]));
    return true;
  }

  if (pathname === "/api/pilot-ops/analytics" && method === "GET") {
    ctx.sendJson(pilotOps.success.pilotAnalytics(user));
    return true;
  }
  if (pathname === "/api/pilot-ops/banners" && method === "GET") {
    ctx.sendJson({ banners: pilotOps.operations.activeBanners() });
    return true;
  }

  // ================= internal operator console =================
  if (isInternal) {
    if (pathname === "/api/internal/success" && method === "GET") {
      ctx.sendJson({ accounts: pilotOps.success.csWorkspace(user) });
      return true;
    }
    const successOrgMatch = /^\/api\/internal\/success\/([^/]+)$/.exec(pathname);
    if (successOrgMatch) {
      if (method === "GET") {
        ctx.sendJson(pilotOps.success.csAccountDetail(user, successOrgMatch[1]));
        return true;
      }
      if (method === "POST") {
        const account = pilotOps.success.updateCsAccount(user, successOrgMatch[1], {
          pilotStatus: body.pilotStatus ? String(body.pilotStatus) : undefined,
          goLiveDate: body.goLiveDate !== undefined ? String(body.goLiveDate) || null : undefined,
          successManager: body.successManager !== undefined ? String(body.successManager) || null : undefined,
          healthScore: body.healthScore !== undefined ? Number(body.healthScore) : undefined,
          renewalProbability:
            body.renewalProbability !== undefined ? Number(body.renewalProbability) : undefined,
        });
        return finish("/internal", { account });
      }
    }
    const checklistAddMatch = /^\/api\/internal\/success\/([^/]+)\/checklist$/.exec(pathname);
    if (checklistAddMatch && method === "POST") {
      return finish("/internal", {
        item: pilotOps.success.addChecklistItem(user, checklistAddMatch[1], String(body.title ?? "")),
      }, 201);
    }
    const checklistDoneMatch = /^\/api\/internal\/checklist\/([^/]+)\/done$/.exec(pathname);
    if (checklistDoneMatch && method === "POST") {
      pilotOps.success.setChecklistDone(user, checklistDoneMatch[1], flag(body.done ?? "1"));
      return finish("/internal", { ok: true });
    }
    const noteMatch = /^\/api\/internal\/success\/([^/]+)\/note$/.exec(pathname);
    if (noteMatch && method === "POST") {
      const kind = String(body.kind ?? "NOTE").toUpperCase();
      if (!["NOTE", "ISSUE", "FEATURE_REQUEST"].includes(kind)) throw new PilotOpsError("Unknown note kind", 400);
      return finish("/internal", {
        note: pilotOps.success.addCsNote(user, noteMatch[1], kind as "NOTE" | "ISSUE" | "FEATURE_REQUEST", String(body.body ?? "")),
      }, 201);
    }
    const feedbackRespondMatch = /^\/api\/internal\/feedback\/([^/]+)\/respond$/.exec(pathname);
    if (feedbackRespondMatch && method === "POST") {
      const kind = String(body.kind ?? "CUSTOMER_RESPONSE").toUpperCase();
      if (!["INTERNAL_NOTE", "CUSTOMER_RESPONSE"].includes(kind)) throw new PilotOpsError("Unknown response kind", 400);
      pilotOps.success.respondToFeedback(user, feedbackRespondMatch[1], {
        kind: kind as "INTERNAL_NOTE" | "CUSTOMER_RESPONSE",
        body: String(body.body ?? ""),
        status: body.status ? String(body.status).toUpperCase() : undefined,
      });
      return finish("/internal", { ok: true });
    }

    if (pathname === "/api/internal/ops" && method === "GET") {
      ctx.sendJson(pilotOps.operations.opsDashboard(user));
      return true;
    }
    if (pathname === "/api/internal/backups") {
      if (method === "GET") {
        ctx.sendJson(pilotOps.operations.backupOverview(user));
        return true;
      }
      if (method === "POST") {
        return finish("/internal", { backup: pilotOps.operations.createBackup(user, body.notes ? String(body.notes) : null) }, 201);
      }
    }
    const backupActionMatch = /^\/api\/internal\/backups\/([^/]+)\/(verify|recovery-test)$/.exec(pathname);
    if (backupActionMatch && method === "POST") {
      if (backupActionMatch[2] === "verify") {
        return finish("/internal", { backup: pilotOps.operations.verifyBackup(user, backupActionMatch[1]) });
      }
      return finish("/internal", pilotOps.operations.runRecoveryTest(user, backupActionMatch[1]));
    }

    if (pathname === "/api/internal/config" && method === "GET") {
      ctx.sendJson(pilotOps.operations.productionConfig(user));
      return true;
    }
    if (pathname === "/api/internal/flags" && method === "POST") {
      return finish("/internal", {
        flag: pilotOps.operations.setFlag(user, String(body.key ?? ""), flag(body.enabled), String(body.description ?? "")),
      });
    }
    if (pathname === "/api/internal/banners" && method === "POST") {
      const level = String(body.level ?? "INFO").toUpperCase();
      if (!["INFO", "WARN", "CRITICAL"].includes(level)) throw new PilotOpsError("Unknown banner level", 400);
      return finish("/internal", {
        banner: pilotOps.operations.createBanner(user, String(body.message ?? ""), level as "INFO" | "WARN" | "CRITICAL"),
      }, 201);
    }
    const bannerRemoveMatch = /^\/api\/internal\/banners\/([^/]+)\/remove$/.exec(pathname);
    if (bannerRemoveMatch && method === "POST") {
      pilotOps.operations.removeBanner(user, bannerRemoveMatch[1]);
      return finish("/internal", { ok: true });
    }
    if (pathname === "/api/internal/demo-data" && method === "POST") {
      return finish("/internal", { summary: pilotOps.demoData.generateDemoData(user) }, 201);
    }
    // Unknown internal path: indistinguishable from nonexistent.
    throw new PilotOpsError("Not found", 404);
  }

  // Unknown pilot-ops path.
  throw new PilotOpsError("Not found", 404);
}
