/**
 * Production Identity Platform facade.
 *
 * Layering: routes and server.ts import from HERE. Sessions resolve to
 * the existing per-organization users rows, so everything downstream
 * (authorization, tenancy, same-404, portfolio, banking, compliance)
 * is structurally untouched by this platform.
 */
export {
  IdentityError,
  GENERIC_AUTH_FAILURE,
  GENERIC_LINK_RESPONSE,
  assertIdentityConfig,
  identityConfig,
  identityStartupNotice,
  normalizeEmail,
  authOutboxPath,
} from "./core";
export {
  AUTH_COOKIE,
  CSRF_COOKIE,
  requestMagicLink,
  previewMagicLink,
  completeMagicLink,
  resolveSession,
  logout,
  logoutEverywhere,
  revokeOwnSession,
  switchOrganization,
  requireCsrf,
  authCookieHeaders,
  clearAuthCookieHeaders,
  isLockedOut,
  type RequestMeta,
  type ResolvedSession,
} from "./auth";
export {
  ensureBootstrapIdentity,
  acceptInvitationWithIdentity,
  suspendMembership,
  restoreMembership,
  deactivateMembership,
  transferOwnership,
  membershipsForIdentity,
  administrableMemberships,
  loginHistory,
} from "./identities";
export {
  SSO_PROVIDER_CATALOG,
  MFA_METHOD_CATALOG,
  ssoEnabled,
  assertSsoEnabled,
  ssoReadiness,
  mfaReadiness,
} from "./ssoReadiness";
