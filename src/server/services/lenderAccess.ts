/**
 * Lender-layer access control: tenant boundary + additive project
 * participant/capability model.
 *
 * The existing UserRole authorization on existing routes is untouched.
 * Capabilities govern the NEW lender endpoints only, with conservative
 * role fallbacks:
 *   FUNDER_REP          → LENDER_REVIEWER capabilities
 *   COMPLIANCE_REVIEWER → OBV_REVIEWER capabilities
 *   PROJECT_MANAGER     → nothing by default (borrower/contractor
 *                         operational capabilities only via membership)
 *   FIELD               → nothing by default (inspector capabilities only
 *                         via explicit membership)
 *   ADMINISTRATOR       → explicit membership only, never inferred.
 * Server-enforced: unauthorized calls get 403; out-of-tenant gets 404 so
 * existence is never disclosed (existing policy).
 */
import * as repo from "../db/repo";
import * as lrepo from "../db/lenderRepo";
import { canAccessProjectFinance } from "./budgetProgress";
import type {
  Project,
  ProjectCapability,
  ProjectMembership,
  ProjectParticipantType,
  User,
} from "../../shared/types";

export class LenderError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Capability defaults per participant type (documented capability matrix). */
export const PARTICIPANT_CAPABILITIES: Record<ProjectParticipantType, ProjectCapability[]> = {
  BORROWER: ["SUBMIT_DRAW", "UPLOAD_DRAW_DOCUMENT"],
  CONTRACTOR: ["UPLOAD_DRAW_DOCUMENT", "REPORT_CONTRACTOR_COMPLETION"],
  INSPECTOR: ["RECORD_INSPECTION_FINDINGS", "FINALIZE_INSPECTION_REPORT"],
  OBV_REVIEWER: ["REVIEW_EVIDENCE", "REVIEW_DRAW", "SCHEDULE_DRAW_INSPECTION"],
  LENDER_REVIEWER: [
    "REVIEW_DRAW", "SCHEDULE_DRAW_INSPECTION", "RECORD_LENDER_DECISION",
    "ACCEPT_EXCEPTION", "RECORD_EXTERNAL_FUNDING",
  ],
  ADMINISTRATOR: [
    "MANAGE_PROJECT_CONFIGURATION", "MANAGE_USERS", "SCHEDULE_DRAW_INSPECTION",
    "REVIEW_DRAW",
  ],
};

/** Conservative role → participant fallback (no membership rows needed for
 *  the two review roles; everything else requires explicit assignment). */
const ROLE_FALLBACK: Partial<Record<User["role"], ProjectParticipantType>> = {
  FUNDER_REP: "LENDER_REVIEWER",
  COMPLIANCE_REVIEWER: "OBV_REVIEWER",
};

function membershipActive(m: ProjectMembership, nowIso: string): boolean {
  if (!m.active) return false;
  if (m.effectiveFrom && m.effectiveFrom > nowIso) return false;
  if (m.effectiveTo && m.effectiveTo < nowIso) return false;
  return true;
}

/** All capabilities the user holds on the project (memberships ∪ fallback). */
export function capabilitiesFor(user: User, projectId: string): Set<ProjectCapability> {
  const now = new Date().toISOString();
  const caps = new Set<ProjectCapability>();
  for (const m of lrepo.listMembershipsForUser(user.id)) {
    if (m.projectId !== projectId || !membershipActive(m, now)) continue;
    const base = m.capabilitySet.length > 0 ? m.capabilitySet : PARTICIPANT_CAPABILITIES[m.participantType];
    for (const c of base) caps.add(c);
  }
  const fallback = ROLE_FALLBACK[user.role];
  if (fallback) for (const c of PARTICIPANT_CAPABILITIES[fallback]) caps.add(c);
  return caps;
}

export function hasCapability(user: User, projectId: string, cap: ProjectCapability): boolean {
  return capabilitiesFor(user, projectId).has(cap);
}

/** Tenant boundary: unrelated organizations receive the same 404 as a
 *  nonexistent record — existence is not disclosed. */
export function assertProjectAccess(user: User, projectId: string): Project {
  const project = repo.getProject(projectId);
  if (!project || !canAccessProjectFinance(user, project)) {
    throw new LenderError("Project not found", 404);
  }
  return project;
}

export function assertCapability(user: User, projectId: string, cap: ProjectCapability): void {
  if (!hasCapability(user, projectId, cap)) {
    throw new LenderError(`This action requires the ${cap} capability`, 403);
  }
}

/** Explicit membership management — MANAGE_USERS or an org-admin fallback
 *  is deliberately NOT granted by role; the first membership for a project
 *  may be created by a FUNDER_REP (lender bootstrap), after which
 *  MANAGE_USERS governs. */
export function assignMembership(
  user: User,
  input: {
    projectId: string;
    userId: string;
    participantType: ProjectParticipantType;
    capabilitySet?: ProjectCapability[];
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
  }
): ProjectMembership {
  const project = assertProjectAccess(user, input.projectId);
  const existing = lrepo.listMemberships(project.id).filter((m) => m.active);
  const bootstrap = existing.length === 0 && user.role === "FUNDER_REP";
  if (!bootstrap) assertCapability(user, project.id, "MANAGE_USERS");
  const member = repo.getUser(input.userId);
  if (!member) throw new LenderError("Assigned user not found", 422);
  const valid: ProjectParticipantType[] = [
    "BORROWER", "CONTRACTOR", "INSPECTOR", "OBV_REVIEWER", "LENDER_REVIEWER", "ADMINISTRATOR",
  ];
  if (!valid.includes(input.participantType)) {
    throw new LenderError(`participantType must be one of ${valid.join(", ")}`, 400);
  }
  const caps = input.capabilitySet ?? [];
  const allCaps = new Set(Object.values(PARTICIPANT_CAPABILITIES).flat());
  for (const c of caps) {
    if (!allCaps.has(c)) throw new LenderError(`Unknown capability ${c}`, 400);
  }
  const now = new Date().toISOString();
  const membership: ProjectMembership = {
    id: lrepo.newId(),
    projectId: project.id,
    userId: member.id,
    participantType: input.participantType,
    capabilitySet: caps,
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveTo: input.effectiveTo ?? null,
    active: true,
    assignedByUserId: user.id,
    createdAt: now,
  };
  lrepo.insertMembership(membership);
  return membership;
}

export function endMembership(user: User, projectId: string, membershipId: string): void {
  const project = assertProjectAccess(user, projectId);
  assertCapability(user, project.id, "MANAGE_USERS");
  lrepo.deactivateMembership(membershipId, new Date().toISOString());
}
