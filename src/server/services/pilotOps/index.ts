/**
 * Pilot Readiness facade — single entry point for routes and pages.
 * Authorization lives in the services (org-admin 403s, internal-operator
 * nondisclosing 404s, same-404 tenancy on every detail lookup).
 */
export { PilotOpsError, assertInternalOperator, assertOrgAdmin, audit } from "./core";
export * as onboarding from "./onboarding";
export * as userAdmin from "./userAdmin";
export * as notifications from "./notifications";
export * as email from "./email";
export * as integrations from "./integrations";
export * as operations from "./operations";
export * as success from "./success";
export * as demoData from "./demoData";
