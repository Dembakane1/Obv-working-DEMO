/**
 * Runtime platform boundary.
 *
 * OBV runs as an ordinary container: an image, environment variables, a
 * port, a data root. Nothing in the governed application should care
 * WHICH platform started it — so every platform-specific environment
 * variable is read here and nowhere else.
 *
 * PRECEDENCE RULE: the generic `OBV_*` variable always wins. Platform
 * variables (Render's `RENDER_*`, Azure's `CONTAINER_APP_*`, Kubernetes'
 * injected service host) are read only as compatibility fallbacks, so an
 * existing deployment that sets none of the generic names keeps working
 * exactly as before, and a deployment that sets them is never overridden
 * by whatever the host happens to inject.
 *
 * DISCLOSURE ONLY: `platformName()` exists so an operator reading a log
 * or a readiness payload can tell where the process is running. No
 * application behaviour may branch on it — a governed workflow that acts
 * differently on Azure than on Render is a portability defect, not a
 * feature.
 */

/** First non-empty environment value, in the order given. */
function firstSet(...names: string[]): string {
  for (const n of names) {
    const v = (process.env[n] ?? "").trim();
    if (v) return v;
  }
  return "";
}

/**
 * The externally reachable base URL, without a trailing slash.
 *
 * Used to build links that leave the process (emails, webhook callbacks,
 * Teams cards). Empty when unset: callers already treat that as "cannot
 * build an absolute link" rather than guessing a hostname.
 */
export function publicBaseUrl(): string {
  return firstSet("OBV_PUBLIC_BASE_URL", "RENDER_EXTERNAL_URL", "WEBSITE_HOSTNAME_URL").replace(/\/$/, "");
}

/**
 * The deployed commit, for support correlation ("which build is live?").
 * `OBV_GIT_COMMIT` is kept as a fallback because earlier deployments were
 * documented with that name.
 */
export function appCommit(): string {
  return firstSet("OBV_APP_COMMIT", "OBV_GIT_COMMIT", "RENDER_GIT_COMMIT", "CONTAINER_APP_REVISION");
}

/** Short form used in operator-facing surfaces. */
export function shortCommit(): string {
  return appCommit().slice(0, 7) || "unknown";
}

/** The deployed branch, where the platform discloses one. */
export function appBranch(): string {
  return firstSet("OBV_APP_BRANCH", "OBV_PREVIEW_BRANCH", "RENDER_GIT_BRANCH");
}

/**
 * Where this process appears to be running. Detection is best-effort and
 * exists for operator disclosure only — see the file header.
 */
export function platformName(): string {
  if (process.env.OBV_PLATFORM) return process.env.OBV_PLATFORM.trim();
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) return "render";
  if (process.env.CONTAINER_APP_NAME) return "azure-container-apps";
  if (process.env.WEBSITE_SITE_NAME) return "azure-app-service";
  if (process.env.KUBERNETES_SERVICE_HOST) return "kubernetes";
  if (process.env.ECS_CONTAINER_METADATA_URI_V4) return "aws-ecs";
  return "generic-container";
}

/**
 * A stable-ish identifier for THIS process, for log correlation when more
 * than one instance runs. Never used for coordination: OBV does no
 * cross-instance leader election, and the SQLite deployment is
 * single-writer by construction (see services/platform/datastore.ts).
 */
export function instanceId(): string {
  return firstSet("OBV_INSTANCE_ID", "CONTAINER_APP_REPLICA_NAME", "HOSTNAME", "RENDER_INSTANCE_ID") || "local";
}

/** Operator-facing boot disclosure. Contains no secrets. */
export function runtimeStartupNotice(): string {
  const base = publicBaseUrl();
  return [
    `Runtime: platform=${platformName()}`,
    `instance=${instanceId()}`,
    `commit=${shortCommit()}`,
    `publicBaseUrl=${base || "(unset — absolute links disabled)"}`,
  ].join(" · ");
}
