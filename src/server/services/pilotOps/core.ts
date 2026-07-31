/**
 * Pilot Readiness core: error type, authorization gates, and the audit
 * hook. Authorization is service-level, matching the rest of OBV:
 *
 *  - Organization administration (settings, users, onboarding, feedback
 *    triage) is limited to review-capable roles WITHIN the caller's own
 *    organization — FIELD users hold no administrative authority.
 *  - The internal operator console (customer success, operations,
 *    backups, production configuration, demo generator) exists only for
 *    the OBV reviewer identity (COMPLIANCE_REVIEWER). For every other
 *    role those surfaces answer 404 — their existence is not disclosed
 *    to lender-side users.
 *
 * Every administrative action is appended to the existing config_audit
 * trail via audit() — one audit surface for the whole platform.
 */
import type { User } from "../../../shared/types";
import * as repo from "../../db/repo";

export class PilotOpsError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = "PilotOpsError";
  }
}

const ADMIN_ROLES = new Set(["FUNDER_REP", "PROJECT_MANAGER", "COMPLIANCE_REVIEWER"]);

/** Org-scoped administration gate (in-tenant capability check → 403). */
export function assertOrgAdmin(user: User): void {
  if (!ADMIN_ROLES.has(user.role)) {
    throw new PilotOpsError(
      `Your role (${user.role}) is not authorized to administer the organization`,
      403
    );
  }
}

/** Any signed-in member surface (notification center, feedback). */
export function assertMember(user: User): void {
  if (!user) throw new PilotOpsError("Select a demo user first", 401);
}

/**
 * Internal operator console gate. Nondisclosing: anything behind this
 * gate is indistinguishable from nonexistent for lender-side users.
 */
export function assertInternalOperator(user: User): void {
  if (user.role !== "COMPLIANCE_REVIEWER") {
    throw new PilotOpsError("Not found", 404);
  }
}

/** Same-tenant guard for org-scoped records (same-404 doctrine). */
export function assertSameOrganization(user: User, organizationId: string): void {
  if (user.organizationId !== organizationId) {
    throw new PilotOpsError("Not found", 404);
  }
}

/** Append an administrative action to the platform audit trail. */
export function audit(
  actor: User,
  action: string,
  entityType: string,
  entityId: string,
  detail: { reason?: string | null; before?: string | null; after?: string | null } = {}
): void {
  repo.insertConfigAudit({
    id: repo.newId(),
    projectId: null,
    actorUserId: actor.id,
    action,
    entityType,
    entityId,
    reason: detail.reason ?? null,
    beforeSummary: detail.before ?? null,
    afterSummary: detail.after ?? null,
    createdAt: new Date().toISOString(),
  });
}
