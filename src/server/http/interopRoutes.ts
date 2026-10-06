/**
 * Infrastructure Interoperability routes.
 *
 * Thin dispatch only: role gates, tenant scoping and same-404 live in the
 * interop services. Pages: the project-scoped Infrastructure Data area
 * (overview, OC4IDS export, external field observations) and the
 * observation review page. APIs: OC4IDS preview / export / validation
 * report / stored-export download, observation import / list / detail /
 * photo / reviewer decisions, and the provider-boundary registry.
 *
 * Nothing here approves evidence, a milestone, a draw, an exception or an
 * inspection, marks progress complete, authorizes payment or releases
 * funds. The only evidence-creating path is a reviewer's explicit accept,
 * which the service runs through the existing governed pipeline; this
 * module then re-evaluates draw readiness exactly as the existing
 * evidence routes do after a capture.
 */
import type * as http from "node:http";
import * as interop from "../services/interop";
import * as repo from "../db/repo";
import * as authz from "../services/authz";
import type { NavContext } from "../view/components";
import type { FieldObservationStatus, User } from "../../shared/types";
import {
  renderInteropWorkspace,
  renderOc4idsPreview,
  renderObservationDetail,
  renderObservationList,
  type InteropNotice,
} from "../view/interopPages";

export interface InteropRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  searchParams: URLSearchParams;
  getUser: () => User;
  signInLocation: string;
  navFor: (user: User, active: string) => NavContext;
  readParams: () => Promise<Record<string, string>>;
  /** Raw body with an explicit limit (imports carry photos). */
  readBody: (limitBytes: number) => Promise<Buffer>;
  isForm: () => boolean;
  /** The configured public base URL, or null when none is configured. */
  publicBaseUrl: () => string | null;
  redirect: (location: string) => void;
  sendJson: (data: unknown, status?: number) => void;
  sendHtml: (html: string, status?: number) => void;
  sendBytes: (bytes: Buffer, contentType: string, filename: string | null, extraHeaders?: Record<string, string>) => void;
  /** The existing post-capture hook (draw readiness re-evaluation). */
  afterEvidenceSubmitted: (milestoneId: string, userId: string) => void;
}

const PROJECT_PAGE = /^\/project\/([^/]+)\/infrastructure-data(?:\/(oc4ids|observations))?\/?$/;
const OBSERVATION_PAGE = /^\/interop\/field-observations\/([^/]+)$/;

export async function handleInteropRoutes(ctx: InteropRouteContext): Promise<boolean> {
  const { pathname, method } = ctx;
  const isApi = pathname.startsWith("/api/interop/");
  const pageMatch = PROJECT_PAGE.exec(pathname);
  const obsPageMatch = OBSERVATION_PAGE.exec(pathname);
  if (!isApi && !pageMatch && !obsPageMatch) return false;

  const pageUser = (): User | null => {
    try {
      return ctx.getUser();
    } catch {
      ctx.redirect(ctx.signInLocation);
      return null;
    }
  };
  const notice = (): InteropNotice | null => {
    const err = ctx.searchParams.get("err");
    const ok = ctx.searchParams.get("ok");
    if (err) return { kind: "err", text: err.slice(0, 400) };
    if (ok) return { kind: "ok", text: ok.slice(0, 400) };
    return null;
  };
  const users = () => new Map(repo.listUsers().map((u) => [u.id, { name: u.name }]));

  // ---- pages ----
  if (method === "GET" && pageMatch) {
    const user = pageUser();
    if (!user) return true;
    const projectId = pageMatch[1];
    const section = pageMatch[2] ?? "overview";
    const project = interop.requireVisibleProject(user, projectId);
    const stats = interop.listProjectObservations(user, project.id).reduce<Record<string, number>>(
      (acc, r) => ({ ...acc, [r.observation.status]: (acc[r.observation.status] ?? 0) + 1 }),
      { UNVERIFIED: 0, ACCEPTED: 0, REJECTED: 0, DEFERRED: 0 }
    );
    const nav = ctx.navFor(user, "projects");
    if (section === "oc4ids") {
      ctx.sendHtml(
        renderOc4idsPreview({
          nav,
          project,
          preview: interop.previewOc4ids(user, project.id, ctx.publicBaseUrl() || null),
          exports: interop.listOc4idsExports(user, project.id),
          users: users(),
          canExport: interop.canExportOc4ids(user),
          unverified: stats.UNVERIFIED,
          notice: notice(),
        })
      );
      return true;
    }
    if (section === "observations") {
      ctx.sendHtml(
        renderObservationList({
          nav,
          project,
          rows: interop.listProjectObservations(user, project.id),
          stats,
          imports: interop.listImports(user).filter((i) => i.declaredProjectId === project.id || i.declaredProjectId === null),
          providers: interop.interopProviderReadiness(),
          formats: {
            envelope: interop.FIELD_OBSERVATION_FORMAT,
            version: interop.FIELD_OBSERVATION_FORMAT_VERSION,
            kobo: interop.KOBO_SUBMISSIONS_FORMAT,
            limits: { ...interop.IMPORT_LIMITS },
          },
          canImport: interop.canImportObservations(user),
          canReview: interop.canReviewObservations(user),
          notice: notice(),
          doctrine: interop.FIELD_OBSERVATION_NOTICE,
        })
      );
      return true;
    }
    ctx.sendHtml(
      renderInteropWorkspace({
        nav,
        project,
        preview: interop.previewOc4ids(user, project.id, ctx.publicBaseUrl() || null),
        observations: interop.listProjectObservations(user, project.id),
        stats,
        providers: interop.interopProviderReadiness(),
        canExport: interop.canExportOc4ids(user),
        canImport: interop.canImportObservations(user),
        canReview: interop.canReviewObservations(user),
        notice: notice(),
        observationNotice: interop.FIELD_OBSERVATION_NOTICE,
      })
    );
    return true;
  }

  if (method === "GET" && obsPageMatch) {
    const user = pageUser();
    if (!user) return true;
    const detail = interop.observationDetail(user, obsPageMatch[1]);
    ctx.sendHtml(
      renderObservationDetail({
        nav: ctx.navFor(user, "projects"),
        detail,
        assignableProjects: authz.accessibleProjects(user),
        users: users(),
        canReview: interop.canReviewObservations(user),
        canAssign: interop.canReviewObservations(user) || interop.canImportObservations(user),
        notice: notice(),
      })
    );
    return true;
  }

  if (!isApi) return false;

  // ---- API: OC4IDS ----
  const previewApi = /^\/api\/interop\/oc4ids\/([^/]+)\/preview$/.exec(pathname);
  if (method === "GET" && previewApi) {
    ctx.sendJson(interop.previewOc4ids(ctx.getUser(), previewApi[1], ctx.publicBaseUrl() || null));
    return true;
  }
  const reportApi = /^\/api\/interop\/oc4ids\/([^/]+)\/validation-report$/.exec(pathname);
  if (method === "GET" && reportApi) {
    const report = interop.oc4idsValidationReport(ctx.getUser(), reportApi[1], ctx.publicBaseUrl() || null);
    ctx.sendBytes(
      Buffer.from(JSON.stringify(report, null, 2), "utf8"),
      "application/json; charset=utf-8",
      `oc4ids-validation-${report.projectId}.json`
    );
    return true;
  }
  const exportsApi = /^\/api\/interop\/oc4ids\/([^/]+)\/exports$/.exec(pathname);
  if (method === "GET" && exportsApi) {
    ctx.sendJson({ exports: interop.listOc4idsExports(ctx.getUser(), exportsApi[1]) });
    return true;
  }
  const exportApi = /^\/api\/interop\/oc4ids\/([^/]+)\/export$/.exec(pathname);
  if (method === "POST" && exportApi) {
    const user = ctx.getUser();
    const result = interop.exportOc4ids(user, exportApi[1], ctx.publicBaseUrl() || null);
    if (ctx.isForm()) {
      ctx.redirect(`/project/${exportApi[1]}/infrastructure-data/oc4ids?ok=${encodeURIComponent(`Export ${result.record.id.slice(0, 8)} produced · SHA-256 ${result.record.payloadSha256.slice(0, 16)}…`)}`);
    } else {
      ctx.sendJson({ record: result.record, url: result.url }, 201);
    }
    return true;
  }
  const storedApi = /^\/api\/interop\/oc4ids\/exports\/([^/]+)$/.exec(pathname);
  if (method === "GET" && storedApi) {
    const stored = interop.getOc4idsExport(ctx.getUser(), storedApi[1]);
    if (!stored.integrityIntact) {
      // Never serve bytes that no longer match their provenance record.
      ctx.sendJson({ error: "The stored export does not match its recorded hash; it is not served", exportId: stored.record.id, expectedSha256: stored.record.payloadSha256 }, 409);
      return true;
    }
    ctx.sendBytes(stored.bytes, "application/json; charset=utf-8", `oc4ids-${stored.record.projectId}-${stored.record.id.slice(0, 8)}.json`, {
      "X-OBV-Export-SHA256": stored.record.payloadSha256,
      "X-OBV-Export-Schema": `OC4IDS ${stored.record.schemaVersion}`,
    });
    return true;
  }

  // ---- API: providers ----
  if (method === "GET" && pathname === "/api/interop/providers") {
    interop.assertInteropViewer(ctx.getUser());
    ctx.sendJson(interop.interopProviderReadiness());
    return true;
  }

  // ---- API: field observations ----
  if (method === "POST" && pathname === "/api/interop/field-observations/import") {
    const user = ctx.getUser();
    const raw = await ctx.readBody(interop.IMPORT_LIMITS.maxBodyBytes);
    let payload: Buffer;
    let projectId: string | null;
    let notes: string | null;
    if (ctx.isForm()) {
      const form = new URLSearchParams(raw.toString("utf8"));
      payload = Buffer.from(form.get("payload") ?? "", "utf8");
      projectId = form.get("projectId") || null;
      notes = form.get("notes") || null;
    } else {
      payload = raw;
      projectId = ctx.searchParams.get("projectId") || null;
      notes = ctx.searchParams.get("notes") || null;
    }
    const summary = interop.importObservations(user, payload, { declaredProjectId: projectId, notes });
    if (ctx.isForm()) {
      const back = projectId ? `/project/${projectId}/infrastructure-data/observations` : "/projects";
      ctx.redirect(`${back}?ok=${encodeURIComponent(`${summary.observations.length} observation(s) imported as unverified · ${summary.duplicates.length} duplicate(s) skipped · ${summary.unmatched} unmatched`)}`);
    } else {
      ctx.sendJson(summary, 201);
    }
    return true;
  }
  if (method === "GET" && pathname === "/api/interop/field-observations") {
    const user = ctx.getUser();
    const projectId = ctx.searchParams.get("projectId");
    const status = (ctx.searchParams.get("status") || undefined) as FieldObservationStatus | undefined;
    ctx.sendJson({
      observations: projectId
        ? interop.listProjectObservations(user, projectId, status)
        : interop.listObservationsForUser(user, status),
    });
    return true;
  }
  const photoApi = /^\/api\/interop\/field-observations\/([^/]+)\/photos\/([^/]+)$/.exec(pathname);
  if (method === "GET" && photoApi) {
    const photo = interop.observationPhoto(ctx.getUser(), photoApi[1], photoApi[2]);
    ctx.sendBytes(photo.bytes, photo.contentType, null, { "Cache-Control": "private, no-store" });
    return true;
  }
  const detailApi = /^\/api\/interop\/field-observations\/([^/]+)$/.exec(pathname);
  if (method === "GET" && detailApi) {
    ctx.sendJson(interop.observationDetail(ctx.getUser(), detailApi[1]));
    return true;
  }
  const actionApi = /^\/api\/interop\/field-observations\/([^/]+)\/(accept|reject|defer|assign|note)$/.exec(pathname);
  if (method === "POST" && actionApi) {
    const user = ctx.getUser();
    const params = await ctx.readParams();
    const [, id, action] = actionApi;
    const note = params.note?.trim() || null;
    let payload: unknown;
    let okText: string;
    if (action === "accept") {
      const result = await interop.acceptObservation(user, id, {
        milestoneId: String(params.milestoneId ?? ""),
        photoId: params.photoId || null,
        note,
      });
      // The same advisory hook the capture and draft routes run after the
      // pipeline: draw readiness re-evaluation. Failures are swallowed there.
      ctx.afterEvidenceSubmitted(result.submission.milestone.id, user.id);
      payload = result;
      okText = `Accepted as evidence ${result.submission.evidence.id.slice(0, 8)} · pipeline verdict ${result.submission.verification.verdict}`;
    } else if (action === "reject") {
      payload = { observation: interop.rejectObservation(user, id, note) };
      okText = "Observation rejected";
    } else if (action === "defer") {
      payload = { observation: interop.deferObservation(user, id, note) };
      okText = "Observation deferred";
    } else if (action === "assign") {
      payload = { observation: interop.assignObservationProject(user, id, String(params.projectId ?? ""), note) };
      okText = "Project assigned";
    } else {
      payload = { observation: interop.noteObservation(user, id, String(params.note ?? "")) };
      okText = "Note recorded";
    }
    if (ctx.isForm()) ctx.redirect(`/interop/field-observations/${id}?ok=${encodeURIComponent(okText)}`);
    else ctx.sendJson(payload, 201);
    return true;
  }

  ctx.sendJson({ error: "Not found" }, 404);
  return true;
}
