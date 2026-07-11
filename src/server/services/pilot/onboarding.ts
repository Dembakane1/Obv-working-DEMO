/**
 * Pilot Readiness & Customer Onboarding.
 *
 * CUSTOMER CONFIGURATION DEFINES THE PROJECT RULES. FIELD EVIDENCE PROVES
 * PHYSICAL WORK. VERIFICATION ASSESSES. FORMAL GOVERNANCE AUTHORIZES.
 * THE LEDGER RECORDS. ONLY THE FORMAL APPROVAL STATE MACHINE CAN
 * AUTHORIZE RELEASE ELIGIBILITY.
 *
 * Everything in this module is CONFIGURATION: no function creates
 * evidence, verifications, ledger entries, approval records, or a
 * RELEASED account event. Launch activates configuration (project status
 * DRAFT -> ACTIVE, tranches recorded HELD, threads created) — it is not
 * proof of work. The readiness engine is fully deterministic.
 */
import { createHash, randomBytes } from "node:crypto";
import * as repo from "../../db/repo";
import { SubmissionError } from "../../workflow/orchestrator";
import { virtualAccountService } from "../VirtualAccountService";
import { getTemplate } from "./templates";
import type {
  ApprovalPolicy,
  ConfigAuditEntry,
  EvidenceRequirement,
  FieldAssignment,
  GeoPolygon,
  Invitation,
  Milestone,
  Project,
  ReadinessCheck,
  User,
  UserRole,
  VerificationPolicyConfig,
} from "../../../shared/types";

export const DEMO_PROJECT_ID = "proj-r47";
export const DEMO_ORG_IDS = ["org-cdfc", "org-crra"];

const VALID_ROLES: UserRole[] = ["FUNDER_REP", "PROJECT_MANAGER", "COMPLIANCE_REVIEWER", "FIELD"];
const APPROVER_ROLES: UserRole[] = ["FUNDER_REP", "PROJECT_MANAGER", "COMPLIANCE_REVIEWER"];
export const REQUIREMENT_MEDIA_TYPES = [
  "image/jpeg", "image/png", "image/webp", "video/mp4", "application/pdf",
];
const REQUIREMENT_TYPES = [
  "PHOTO", "VIDEO", "DOCUMENT", "LOCATION_CONFIRMATION", "FIELD_FORM",
  "INSPECTION", "CERTIFICATE", "TEST_RESULT", "OTHER",
];
const PROJECT_CATEGORIES = [
  "ROAD", "BUILDING", "SCHOOL", "CLINIC", "WATER", "ENERGY", "BRIDGE",
  "OTHER_INFRASTRUCTURE",
];
const ORG_KINDS = [
  "LENDER", "FUNDER", "GOVERNMENT_AGENCY", "DEVELOPMENT_INSTITUTION",
  "PROJECT_OWNER", "IMPLEMENTING_AGENCY", "CONTRACTOR", "CONSULTANT", "OTHER",
  // legacy seeded kinds
  "DEVELOPMENT_FINANCE", "GOVERNMENT",
];

export function canAdminPilot(user: User): boolean {
  return user.role === "PROJECT_MANAGER";
}
export function canViewPilot(user: User): boolean {
  return ["PROJECT_MANAGER", "FUNDER_REP", "COMPLIANCE_REVIEWER"].includes(user.role);
}

export function isPilotProject(projectId: string): boolean {
  return projectId !== DEMO_PROJECT_ID;
}

export function pilotProjectsExist(): boolean {
  return repo.listProjects().some((p) => isPilotProject(p.id));
}

// -------------------------------------------------------------- audit

export function audit(entry: Omit<ConfigAuditEntry, "id" | "createdAt">): void {
  repo.insertConfigAudit({
    ...entry,
    id: repo.newId(),
    createdAt: new Date().toISOString(),
  });
}

/** Post-launch change control: material changes need an explicit reason. */
function requireChangeReason(project: Project, reason: string | null, what: string): void {
  if (project.status !== "DRAFT" && !reason?.trim()) {
    throw new SubmissionError(
      `This project is launched — changing ${what} requires an explicit change reason`,
      422
    );
  }
}

function bumpConfigVersion(project: Project): number {
  const next = (project.pilot?.configVersion ?? 1) + 1;
  repo.updateProjectFields(project.id, { configVersion: next });
  return next;
}

// ----------------------------------------------------- organizations

export function createOrganization(
  input: { name: string; kind: string } & Partial<NonNullable<Project["pilot"]>> &
    Record<string, unknown>,
  actor: User
) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new SubmissionError("Organization name is required");
  const kind = String(input.kind ?? "OTHER").trim().toUpperCase();
  if (!ORG_KINDS.includes(kind)) throw new SubmissionError(`Unknown organization type: ${kind}`);
  const org = { id: repo.newId(), name, kind };
  repo.insertOrganization(org);
  repo.updateOrganization(org.id, sanitizeOrgProfile(input));
  audit({
    projectId: null, actorUserId: actor.id, action: "ORGANIZATION_CREATED",
    entityType: "organization", entityId: org.id, reason: null,
    beforeSummary: null, afterSummary: `${name} (${kind})`,
  });
  return repo.getOrganization(org.id)!;
}

export function updateOrganizationProfile(
  id: string,
  input: Record<string, unknown>,
  actor: User
) {
  const org = repo.getOrganization(id);
  if (!org) throw new SubmissionError("Unknown organization", 404);
  const fields = sanitizeOrgProfile(input);
  if (typeof input.name === "string" && input.name.trim()) fields.name = input.name.trim();
  if (typeof input.kind === "string" && input.kind.trim()) {
    const kind = input.kind.trim().toUpperCase();
    if (!ORG_KINDS.includes(kind)) throw new SubmissionError(`Unknown organization type: ${kind}`);
    fields.kind = kind;
  }
  repo.updateOrganization(id, fields);
  audit({
    projectId: null, actorUserId: actor.id, action: "ORGANIZATION_UPDATED",
    entityType: "organization", entityId: id, reason: null,
    beforeSummary: org.name, afterSummary: fields.name ?? org.name,
  });
  return repo.getOrganization(id)!;
}

function sanitizeOrgProfile(input: Record<string, unknown>) {
  const str = (k: string) => {
    const v = input[k];
    return typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null;
  };
  const out: Record<string, string | null> = {};
  for (const k of [
    "country", "region", "website", "primaryContact", "billingContact",
    "timezone", "currency", "language", "pilotStart", "pilotEnd",
    "pilotReference", "notes",
  ]) {
    const v = str(k);
    if (v !== null || k in input) out[k] = v;
  }
  return out as Record<string, string | null> & { name?: string; kind?: string };
}

// ------------------------------------------------------- invitations

const INVITATION_TTL_DAYS = 14;

export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Create an invitation. Returns the RAW token exactly once — only its
 *  sha256 hash is stored, and the raw value is never logged. */
export function createInvitation(
  input: { email: string; organizationId: string; role: string; projectId?: string | null },
  actor: User
): { invitation: Invitation; rawToken: string } {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SubmissionError("A valid email is required");
  if (!VALID_ROLES.includes(input.role as UserRole)) {
    throw new SubmissionError(`Unknown role: ${input.role}`);
  }
  if (!repo.getOrganization(input.organizationId)) {
    throw new SubmissionError("Unknown organization", 404);
  }
  if (input.projectId && !repo.getProject(input.projectId)) {
    throw new SubmissionError("Unknown project", 404);
  }
  const rawToken = randomBytes(24).toString("hex");
  const invitation: Invitation = {
    id: repo.newId(),
    email,
    organizationId: input.organizationId,
    role: input.role as UserRole,
    projectId: input.projectId ?? null,
    tokenHash: hashInviteToken(rawToken),
    status: "PENDING",
    expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86400_000).toISOString(),
    createdBy: actor.id,
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    acceptedUserId: null,
    revokedAt: null,
  };
  repo.insertInvitation(invitation);
  audit({
    projectId: invitation.projectId, actorUserId: actor.id, action: "USER_INVITED",
    entityType: "invitation", entityId: invitation.id, reason: null,
    beforeSummary: null, afterSummary: `${email} as ${invitation.role}`,
  });
  return { invitation, rawToken };
}

/** Reissue a pending invitation with a fresh token + expiry. */
export function resendInvitation(id: string, actor: User): { invitation: Invitation; rawToken: string } {
  const inv = repo.getInvitation(id);
  if (!inv) throw new SubmissionError("Unknown invitation", 404);
  if (inv.status === "ACCEPTED") throw new SubmissionError("Invitation already accepted", 409);
  if (inv.status === "REVOKED") throw new SubmissionError("Invitation was revoked", 409);
  const rawToken = randomBytes(24).toString("hex");
  repo.updateInvitation(id, {
    status: "PENDING",
    tokenHash: hashInviteToken(rawToken),
    expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86400_000).toISOString(),
  });
  audit({
    projectId: inv.projectId, actorUserId: actor.id, action: "INVITATION_RESENT",
    entityType: "invitation", entityId: id, reason: null,
    beforeSummary: null, afterSummary: inv.email,
  });
  return { invitation: repo.getInvitation(id)!, rawToken };
}

export function revokeInvitation(id: string, actor: User): Invitation {
  const inv = repo.getInvitation(id);
  if (!inv) throw new SubmissionError("Unknown invitation", 404);
  if (inv.status === "ACCEPTED") throw new SubmissionError("Invitation already accepted", 409);
  repo.updateInvitation(id, { status: "REVOKED", revokedAt: new Date().toISOString() });
  audit({
    projectId: inv.projectId, actorUserId: actor.id, action: "INVITATION_REVOKED",
    entityType: "invitation", entityId: id, reason: null,
    beforeSummary: inv.email, afterSummary: null,
  });
  return repo.getInvitation(id)!;
}

/** Look up an invitation by raw token; marks stale rows EXPIRED. */
export function findInvitationForToken(rawToken: string): Invitation | null {
  if (!rawToken || rawToken.length < 16) return null;
  const inv = repo.findInvitationByTokenHash(hashInviteToken(rawToken));
  if (!inv) return null;
  if (inv.status === "PENDING" && Date.parse(inv.expiresAt) < Date.now()) {
    repo.updateInvitation(inv.id, { status: "EXPIRED" });
    return repo.getInvitation(inv.id);
  }
  return inv;
}

/** One-time acceptance: creates the user and consumes the token. */
export function acceptInvitation(
  rawToken: string,
  profile: { name: string; title: string }
): { user: User; invitation: Invitation } {
  const inv = findInvitationForToken(rawToken);
  if (!inv) throw new SubmissionError("Invitation not found", 404);
  if (inv.status === "EXPIRED") throw new SubmissionError("This invitation has expired", 410);
  if (inv.status === "REVOKED") throw new SubmissionError("This invitation was revoked", 410);
  if (inv.status === "ACCEPTED") throw new SubmissionError("This invitation was already used", 409);
  const name = String(profile.name ?? "").trim().slice(0, 120);
  if (!name) throw new SubmissionError("Your name is required");
  const user: User = {
    id: repo.newId(),
    organizationId: inv.organizationId,
    name,
    role: inv.role,
    title: String(profile.title ?? "").trim().slice(0, 120) || inv.role.replace(/_/g, " "),
  };
  repo.insertUser(user);
  repo.updateInvitation(inv.id, {
    status: "ACCEPTED",
    acceptedAt: new Date().toISOString(),
    acceptedUserId: user.id,
  });
  if (inv.projectId && inv.role === "FIELD") {
    // Project-scoped field invitation becomes an active assignment.
    repo.insertAssignment({
      id: repo.newId(),
      projectId: inv.projectId,
      userId: user.id,
      milestoneIds: [],
      effectiveFrom: null,
      effectiveTo: null,
      active: true,
      createdBy: inv.createdBy,
      createdAt: new Date().toISOString(),
    });
  }
  audit({
    projectId: inv.projectId, actorUserId: user.id, action: "INVITATION_ACCEPTED",
    entityType: "invitation", entityId: inv.id, reason: null,
    beforeSummary: null, afterSummary: `${user.name} (${user.role})`,
  });
  return { user, invitation: repo.getInvitation(inv.id)! };
}

// ----------------------------------------------------------- projects

export function createDraftProject(
  input: Record<string, unknown>,
  actor: User
): Project {
  const name = String(input.name ?? "").trim().slice(0, 160);
  if (!name) throw new SubmissionError("Project name is required");
  const organizationId = String(input.organizationId ?? actor.organizationId);
  if (!repo.getOrganization(organizationId)) throw new SubmissionError("Unknown organization", 404);
  const category = input.category ? String(input.category).toUpperCase() : null;
  if (category && !PROJECT_CATEGORIES.includes(category)) {
    throw new SubmissionError(`Unknown project type: ${category}`);
  }
  const obvControlled = numOrNull(input.obvControlledAmount);
  const totalValue = numOrNull(input.totalValue) ?? obvControlled ?? 0;
  if (totalValue < 0 || (obvControlled !== null && obvControlled < 0)) {
    throw new SubmissionError("Amounts cannot be negative");
  }
  const project: Project = {
    id: repo.newId(),
    organizationId,
    name,
    description: String(input.description ?? "").trim().slice(0, 4000),
    location: String(input.locality ?? input.region ?? input.country ?? "").trim().slice(0, 200) || "—",
    siteBoundary: [],
    totalBudget: totalValue,
    status: "DRAFT",
    projectType: "INFRASTRUCTURE",
    pilot: {
      code: strOrNull(input.code, 60),
      category: category as never,
      country: strOrNull(input.country, 100),
      region: strOrNull(input.region, 100),
      locality: strOrNull(input.locality, 160),
      implementingOrgId: orgRef(input.implementingOrgId),
      contractorOrgId: orgRef(input.contractorOrgId),
      funderOrgId: orgRef(input.funderOrgId),
      engineerOrgId: orgRef(input.engineerOrgId),
      obvControlledAmount: obvControlled,
      currency: strOrNull(input.currency, 10) ?? "USD",
      plannedStart: strOrNull(input.plannedStart, 30),
      plannedEnd: strOrNull(input.plannedEnd, 30),
      timezone: strOrNull(input.timezone, 60),
      geometryKind: null,
      createdBy: actor.id,
      launchedAt: null,
      launchedBy: null,
      configVersion: 1,
    },
  };
  repo.insertProject(project);
  audit({
    projectId: project.id, actorUserId: actor.id, action: "PROJECT_CREATED",
    entityType: "project", entityId: project.id, reason: null,
    beforeSummary: null, afterSummary: `${name} (DRAFT)`,
  });
  return repo.getProject(project.id)!;
}

export function updateDraftProject(projectId: string, input: Record<string, unknown>, actor: User): Project {
  const project = mustProject(projectId);
  requireChangeReason(project, strOrNull(input.reason, 400), "project details");
  const category = input.category ? String(input.category).toUpperCase() : undefined;
  if (category && !PROJECT_CATEGORIES.includes(category)) {
    throw new SubmissionError(`Unknown project type: ${category}`);
  }
  const fields: Parameters<typeof repo.updateProjectFields>[1] = {};
  if (typeof input.name === "string" && input.name.trim()) fields.name = input.name.trim().slice(0, 160);
  if (typeof input.description === "string") fields.description = input.description.trim().slice(0, 4000);
  if (category !== undefined) fields.category = category as never;
  for (const k of ["code", "country", "region", "locality", "currency", "plannedStart", "plannedEnd", "timezone"] as const) {
    if (k in input) fields[k] = strOrNull(input[k], 200);
  }
  for (const k of ["implementingOrgId", "contractorOrgId", "funderOrgId", "engineerOrgId"] as const) {
    if (k in input) fields[k] = orgRef(input[k]);
  }
  if ("obvControlledAmount" in input) {
    const v = numOrNull(input.obvControlledAmount);
    if (v !== null && v < 0) throw new SubmissionError("Amounts cannot be negative");
    fields.obvControlledAmount = v;
  }
  if ("totalValue" in input) {
    const v = numOrNull(input.totalValue);
    if (v !== null && v < 0) throw new SubmissionError("Amounts cannot be negative");
    if (v !== null) fields.totalBudget = v;
  }
  if (typeof input.locality === "string" || typeof input.region === "string") {
    fields.location =
      [strOrNull(input.locality, 160), strOrNull(input.region, 100)].filter(Boolean).join(", ") ||
      project.location;
  }
  repo.updateProjectFields(projectId, fields);
  if (project.status !== "DRAFT") {
    bumpConfigVersion(repo.getProject(projectId)!);
    snapshotProject(projectId, `Post-launch project change: ${strOrNull(input.reason, 400)}`, actor);
  }
  audit({
    projectId, actorUserId: actor.id, action: "PROJECT_UPDATED",
    entityType: "project", entityId: projectId, reason: strOrNull(input.reason, 400),
    beforeSummary: project.name, afterSummary: (fields.name as string) ?? project.name,
  });
  return repo.getProject(projectId)!;
}

function mustProject(id: string): Project {
  const p = repo.getProject(id);
  if (!p) throw new SubmissionError("Unknown project", 404);
  return p;
}

function strOrNull(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function orgRef(v: unknown): string | null {
  const id = strOrNull(v, 80);
  if (!id) return null;
  if (!repo.getOrganization(id)) throw new SubmissionError("Unknown counterparty organization", 404);
  return id;
}

// ----------------------------------------------------------- template

/** Apply a setup template: creates milestones + evidence requirements +
 *  a project-default approval matrix. Pre-launch only; replaces any
 *  existing draft milestone configuration. */
export function applyTemplate(projectId: string, templateKey: string, actor: User): Milestone[] {
  const project = mustProject(projectId);
  if (project.status !== "DRAFT") {
    throw new SubmissionError("Templates can only be applied to a draft project", 409);
  }
  const template = getTemplate(templateKey);
  if (!template) throw new SubmissionError("Unknown template", 404);
  // Replace existing draft configuration (guarded: drafts have no
  // evidence, approvals, or account events).
  for (const m of repo.listMilestones(projectId)) {
    if (repo.latestEvidenceForMilestone(m.id)) {
      throw new SubmissionError("Draft milestone unexpectedly has evidence — cannot re-template", 409);
    }
    repo.deleteMilestone(m.id);
  }
  const controlled = project.pilot?.obvControlledAmount ?? project.totalBudget;
  const created: Milestone[] = [];
  template.milestones.forEach((tm, i) => {
    const milestone: Milestone = {
      id: repo.newId(),
      projectId,
      seq: i + 1,
      title: tm.title,
      requirement: tm.requirement,
      trancheAmount: Math.round(controlled * tm.trancheShare),
      status: "NOT_STARTED",
      accountStatus: "HELD",
      plannedStart: null,
      plannedEnd: null,
      weight: tm.trancheShare,
      spatialLabel: null,
      archived: false,
    };
    repo.insertMilestone(milestone);
    tm.requirements.forEach((tr, j) => {
      repo.insertRequirement({
        id: repo.newId(),
        milestoneId: milestone.id,
        sort: j,
        type: tr.type,
        title: tr.title,
        description: tr.description,
        required: tr.required,
        minCount: tr.minCount,
        mediaTypes: tr.mediaTypes,
        geolocationRequired: tr.geolocationRequired,
        recencyDays: tr.recencyDays,
        notes: null,
      });
    });
    created.push(milestone);
  });
  // Rounding: pin the last milestone so the tranches sum exactly.
  const sum = created.reduce((acc, m) => acc + m.trancheAmount, 0);
  if (created.length && sum !== controlled) {
    const last = created[created.length - 1];
    repo.updateMilestoneFields(last.id, { trancheAmount: last.trancheAmount + (controlled - sum) });
  }
  repo.upsertApprovalPolicy({
    id: repo.newId(),
    projectId,
    milestoneId: null,
    requiredRoles: template.approvalRoles,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.id,
  });
  if (template.geometryHint) {
    repo.updateProjectFields(projectId, { geometryKind: template.geometryHint });
  }
  audit({
    projectId, actorUserId: actor.id, action: "TEMPLATE_APPLIED",
    entityType: "project", entityId: projectId, reason: null,
    beforeSummary: null, afterSummary: `${template.name} (${template.milestones.length} milestones)`,
  });
  return repo.listMilestones(projectId);
}

// ----------------------------------------------------------- geography

/** Validate + store project geography. POLYGON/POINT write the site
 *  boundary (geofence); CORRIDOR also stores the ROUTE spatial feature
 *  and derives a bounding geofence around the centerline. */
export function setGeography(
  projectId: string,
  input: { kind: string; coordinates: Array<[number, number]>; label?: string; reason?: string | null },
  actor: User
): Project {
  const project = mustProject(projectId);
  requireChangeReason(project, input.reason ?? null, "project geography");
  const kind = String(input.kind ?? "").toUpperCase();
  if (!["POINT", "POLYGON", "CORRIDOR"].includes(kind)) {
    throw new SubmissionError("Geometry kind must be POINT, POLYGON, or CORRIDOR");
  }
  const coords = (input.coordinates ?? []).map(([lng, lat]) => [Number(lng), Number(lat)] as [number, number]);
  if (coords.some(([lng, lat]) => !Number.isFinite(lng) || !Number.isFinite(lat))) {
    throw new SubmissionError("Coordinates must be numeric [lng, lat] pairs");
  }
  if (coords.some(([lng, lat]) => Math.abs(lat) > 90 || Math.abs(lng) > 180)) {
    throw new SubmissionError("Coordinates out of range: latitude within ±90, longitude within ±180");
  }
  let boundary: GeoPolygon;
  if (kind === "POINT") {
    if (coords.length !== 1) throw new SubmissionError("A point site needs exactly one [lng, lat] pair");
    boundary = ringAround(coords, 0.01);
  } else if (kind === "POLYGON") {
    if (coords.length < 3) throw new SubmissionError("A boundary polygon needs at least 3 vertices");
    if (ringArea(coords) === 0) throw new SubmissionError("Boundary polygon has no area (collinear vertices)");
    boundary = closeRing(coords);
  } else {
    if (coords.length < 2) throw new SubmissionError("A corridor route needs at least 2 vertices");
    if (pathLengthDeg(coords) === 0) throw new SubmissionError("Corridor route has zero length");
    boundary = ringAround(coords, 0.015);
  }
  repo.updateProjectFields(projectId, { siteBoundary: boundary, geometryKind: kind as never });
  if (kind === "CORRIDOR") {
    repo.deleteSpatialFeatures(projectId);
    repo.insertSpatialFeature({
      id: repo.newId(),
      projectId,
      milestoneId: null,
      kind: "ROUTE",
      label: strOrNull(input.label, 160) ?? "Project corridor (user-defined geometry)",
      geometry: coords,
    });
  } else {
    repo.deleteSpatialFeatures(projectId);
  }
  if (project.status !== "DRAFT") {
    bumpConfigVersion(repo.getProject(projectId)!);
    snapshotProject(projectId, `Post-launch geography change: ${input.reason}`, actor);
  }
  audit({
    projectId, actorUserId: actor.id, action: "GEOGRAPHY_CONFIGURED",
    entityType: "project", entityId: projectId, reason: input.reason ?? null,
    beforeSummary: project.pilot?.geometryKind ?? "none",
    afterSummary: `${kind} (${coords.length} vertices, user-defined precision — not survey-grade)`,
  });
  return repo.getProject(projectId)!;
}

function closeRing(coords: GeoPolygon): GeoPolygon {
  const [fx, fy] = coords[0];
  const [lx, ly] = coords[coords.length - 1];
  return fx === lx && fy === ly ? coords : [...coords, [fx, fy]];
}
function ringAround(coords: GeoPolygon, marginDeg: number): GeoPolygon {
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const minLng = Math.min(...lngs) - marginDeg;
  const maxLng = Math.max(...lngs) + marginDeg;
  const minLat = Math.min(...lats) - marginDeg;
  const maxLat = Math.max(...lats) + marginDeg;
  return [
    [minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat],
  ];
}
function ringArea(coords: GeoPolygon): number {
  let area = 0;
  for (let i = 0; i < coords.length; i++) {
    const [x1, y1] = coords[i];
    const [x2, y2] = coords[(i + 1) % coords.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}
function pathLengthDeg(coords: GeoPolygon): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  }
  return len;
}

// ---------------------------------------------------------- milestones

export function addMilestone(projectId: string, input: Record<string, unknown>, actor: User): Milestone {
  const project = mustProject(projectId);
  requireChangeReason(project, strOrNull(input.reason, 400), "the milestone structure");
  const title = strOrNull(input.title, 160);
  const requirement = strOrNull(input.requirement, 2000);
  if (!title) throw new SubmissionError("Milestone title is required");
  if (!requirement) throw new SubmissionError("Milestone requirement is required");
  const tranche = numOrNull(input.trancheAmount) ?? 0;
  if (tranche < 0) throw new SubmissionError("Tranche amount cannot be negative");
  const existing = repo.listMilestones(projectId);
  const seq = numOrNull(input.seq) ?? existing.length + 1;
  if (existing.some((m) => m.seq === seq)) {
    throw new SubmissionError(`Sequence ${seq} is already in use`, 409);
  }
  const milestone: Milestone = {
    id: repo.newId(),
    projectId,
    seq,
    title,
    requirement,
    trancheAmount: tranche,
    status: "NOT_STARTED",
    accountStatus: "HELD",
    plannedStart: strOrNull(input.plannedStart, 30),
    plannedEnd: strOrNull(input.plannedEnd, 30),
    weight: null,
    spatialLabel: strOrNull(input.spatialLabel, 120),
    archived: false,
  };
  repo.insertMilestone(milestone);
  if (project.status !== "DRAFT") {
    // A milestone added post-launch starts HELD on the virtual account.
    void virtualAccountService.holdTranche(milestone);
    bumpConfigVersion(repo.getProject(projectId)!);
    snapshotProject(projectId, `Post-launch milestone added: ${strOrNull(input.reason, 400)}`, actor);
  }
  audit({
    projectId, actorUserId: actor.id, action: "MILESTONE_ADDED",
    entityType: "milestone", entityId: milestone.id, reason: strOrNull(input.reason, 400),
    beforeSummary: null, afterSummary: `M${seq} ${title}`,
  });
  return milestone;
}

export function updateMilestone(
  milestoneId: string,
  input: Record<string, unknown>,
  actor: User
): Milestone {
  const milestone = repo.getMilestone(milestoneId);
  if (!milestone) throw new SubmissionError("Unknown milestone", 404);
  const project = mustProject(milestone.projectId);
  const reason = strOrNull(input.reason, 400);
  requireChangeReason(project, reason, `milestone M${milestone.seq}`);
  // NEVER silent after operational records exist.
  const hasRecords =
    Boolean(repo.latestEvidenceForMilestone(milestoneId)) ||
    Boolean(repo.getApprovalRequestForMilestone(milestoneId));
  if (hasRecords && !reason) {
    throw new SubmissionError(
      "Evidence or approvals already exist for this milestone — a change reason is required",
      422
    );
  }
  const fields: Parameters<typeof repo.updateMilestoneFields>[1] = {};
  const title = strOrNull(input.title, 160);
  const requirement = strOrNull(input.requirement, 2000);
  if (title) fields.title = title;
  if (requirement) fields.requirement = requirement;
  if ("trancheAmount" in input) {
    const v = numOrNull(input.trancheAmount);
    if (v === null || v < 0) throw new SubmissionError("Tranche amount must be a non-negative number");
    if (milestone.accountStatus === "RELEASED" && v !== milestone.trancheAmount) {
      throw new SubmissionError("This tranche has already been released — its amount cannot change", 409);
    }
    fields.trancheAmount = v;
  }
  if ("seq" in input) {
    const v = numOrNull(input.seq);
    if (v === null || v < 1) throw new SubmissionError("Sequence must be a positive number");
    if (repo.listMilestones(project.id).some((m) => m.id !== milestoneId && m.seq === v)) {
      throw new SubmissionError(`Sequence ${v} is already in use`, 409);
    }
    fields.seq = v;
  }
  for (const k of ["plannedStart", "plannedEnd", "spatialLabel"] as const) {
    if (k in input) fields[k] = strOrNull(input[k], 160);
  }
  if ("archived" in input) {
    if (project.status !== "DRAFT") {
      throw new SubmissionError("Milestones can only be archived before launch", 409);
    }
    fields.archived = input.archived === true || input.archived === "true" || input.archived === "1";
  }
  repo.updateMilestoneFields(milestoneId, fields);
  if (project.status !== "DRAFT") {
    bumpConfigVersion(repo.getProject(project.id)!);
    snapshotProject(project.id, `Post-launch milestone change: ${reason}`, actor);
  }
  audit({
    projectId: project.id, actorUserId: actor.id, action: "MILESTONE_UPDATED",
    entityType: "milestone", entityId: milestoneId, reason,
    beforeSummary: `M${milestone.seq} ${milestone.title} · $${milestone.trancheAmount.toLocaleString("en-US")}`,
    afterSummary: `M${fields.seq ?? milestone.seq} ${fields.title ?? milestone.title} · $${(fields.trancheAmount ?? milestone.trancheAmount).toLocaleString("en-US")}`,
  });
  return repo.getMilestone(milestoneId)!;
}

export function removeMilestone(milestoneId: string, actor: User): void {
  const milestone = repo.getMilestone(milestoneId);
  if (!milestone) throw new SubmissionError("Unknown milestone", 404);
  const project = mustProject(milestone.projectId);
  if (project.status !== "DRAFT") {
    throw new SubmissionError("Milestones can only be deleted before launch — archive requires a draft", 409);
  }
  if (repo.latestEvidenceForMilestone(milestoneId)) {
    throw new SubmissionError("This milestone has evidence and cannot be deleted", 409);
  }
  repo.deleteMilestone(milestoneId);
  audit({
    projectId: project.id, actorUserId: actor.id, action: "MILESTONE_DELETED",
    entityType: "milestone", entityId: milestoneId, reason: null,
    beforeSummary: `M${milestone.seq} ${milestone.title}`, afterSummary: null,
  });
}

// ------------------------------------------------ evidence requirements

export function saveRequirement(
  input: Record<string, unknown>,
  actor: User
): EvidenceRequirement {
  const milestoneId = String(input.milestoneId ?? "");
  const milestone = repo.getMilestone(milestoneId);
  if (!milestone) throw new SubmissionError("Unknown milestone", 404);
  const project = mustProject(milestone.projectId);
  const reason = strOrNull(input.reason, 400);
  requireChangeReason(project, reason, "evidence requirements");
  const type = String(input.type ?? "PHOTO").toUpperCase();
  if (!REQUIREMENT_TYPES.includes(type)) throw new SubmissionError(`Unknown requirement type: ${type}`);
  const title = strOrNull(input.title, 200);
  if (!title) throw new SubmissionError("Requirement title is required");
  const mediaTypes = parseMediaTypes(input.mediaTypes);
  const minCount = Math.max(1, Math.min(50, numOrNull(input.minCount) ?? 1));
  const recencyDays = numOrNull(input.recencyDays);
  if (recencyDays !== null && (recencyDays < 1 || recencyDays > 90)) {
    throw new SubmissionError("Capture recency must be between 1 and 90 days");
  }
  const req: EvidenceRequirement = {
    id: strOrNull(input.id, 80) ?? repo.newId(),
    milestoneId,
    sort: numOrNull(input.sort) ?? repo.listRequirementsForMilestone(milestoneId).length,
    type: type as never,
    title,
    description: strOrNull(input.description, 2000) ?? "",
    required: input.required !== "false" && input.required !== false && input.required !== "0",
    minCount,
    mediaTypes,
    geolocationRequired:
      input.geolocationRequired === true || input.geolocationRequired === "true" || input.geolocationRequired === "1",
    recencyDays,
    notes: strOrNull(input.notes, 1000),
  };
  const existing = repo.getRequirement(req.id);
  if (existing) repo.updateRequirement(req.id, req);
  else repo.insertRequirement(req);
  if (project.status !== "DRAFT") {
    bumpConfigVersion(repo.getProject(project.id)!);
    snapshotProject(project.id, `Post-launch requirement change: ${reason}`, actor);
  }
  audit({
    projectId: project.id, actorUserId: actor.id,
    action: existing ? "REQUIREMENT_UPDATED" : "REQUIREMENT_ADDED",
    entityType: "evidence_requirement", entityId: req.id, reason,
    beforeSummary: existing ? existing.title : null,
    afterSummary: `${req.type} · ${req.title} (min ${req.minCount})`,
  });
  return req;
}

export function removeRequirement(id: string, actor: User): void {
  const req = repo.getRequirement(id);
  if (!req) throw new SubmissionError("Unknown requirement", 404);
  const milestone = repo.getMilestone(req.milestoneId)!;
  const project = mustProject(milestone.projectId);
  if (project.status !== "DRAFT") {
    throw new SubmissionError("Launched projects edit requirements with a change reason instead of deleting", 409);
  }
  repo.deleteRequirement(id);
  audit({
    projectId: project.id, actorUserId: actor.id, action: "REQUIREMENT_DELETED",
    entityType: "evidence_requirement", entityId: id, reason: null,
    beforeSummary: req.title, afterSummary: null,
  });
}

function parseMediaTypes(v: unknown): string[] {
  const list = Array.isArray(v)
    ? v.map(String)
    : typeof v === "string"
      ? v.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  for (const mt of list) {
    if (!REQUIREMENT_MEDIA_TYPES.includes(mt)) {
      throw new SubmissionError(
        `Media type ${mt} is not allowed (allowed: ${REQUIREMENT_MEDIA_TYPES.join(", ")})`
      );
    }
  }
  return list;
}

// -------------------------------------------------- verification policy

/** OBV-validated bounds. Values outside are rejected, not clamped
 *  silently — the customer sees the constraint. */
const POLICY_BOUNDS = {
  aiConfidenceThreshold: { min: 0.5, max: 0.95 },
  recencyDays: { min: 1, max: 30 },
  offlineAllowanceDays: { min: 0, max: 14 },
};

export function saveVerificationPolicy(
  projectId: string,
  input: Record<string, unknown>,
  actor: User
): VerificationPolicyConfig {
  const project = mustProject(projectId);
  const reason = strOrNull(input.reason, 400);
  requireChangeReason(project, reason, "the verification policy");
  const threshold = input.aiConfidenceThreshold === "" || input.aiConfidenceThreshold == null
    ? null
    : Number(input.aiConfidenceThreshold);
  if (threshold !== null) {
    if (!Number.isFinite(threshold) || threshold < POLICY_BOUNDS.aiConfidenceThreshold.min || threshold > POLICY_BOUNDS.aiConfidenceThreshold.max) {
      throw new SubmissionError(
        `AI confidence threshold must be between ${POLICY_BOUNDS.aiConfidenceThreshold.min} and ${POLICY_BOUNDS.aiConfidenceThreshold.max}`
      );
    }
  }
  const geofencePolicy = input.geofencePolicy ? String(input.geofencePolicy).toUpperCase() : null;
  if (geofencePolicy && !["STRICT", "STANDARD", "EXTENDED_REVIEW"].includes(geofencePolicy)) {
    throw new SubmissionError("Geofence policy must be STRICT, STANDARD, or EXTENDED_REVIEW");
  }
  const recencyDays = numOrNull(input.recencyDays);
  if (recencyDays !== null && (recencyDays < POLICY_BOUNDS.recencyDays.min || recencyDays > POLICY_BOUNDS.recencyDays.max)) {
    throw new SubmissionError(`Capture recency must be between ${POLICY_BOUNDS.recencyDays.min} and ${POLICY_BOUNDS.recencyDays.max} days`);
  }
  const offlineDays = numOrNull(input.offlineAllowanceDays);
  if (offlineDays !== null && (offlineDays < POLICY_BOUNDS.offlineAllowanceDays.min || offlineDays > POLICY_BOUNDS.offlineAllowanceDays.max)) {
    throw new SubmissionError(`Offline allowance must be between ${POLICY_BOUNDS.offlineAllowanceDays.min} and ${POLICY_BOUNDS.offlineAllowanceDays.max} days`);
  }
  const policy: VerificationPolicyConfig = {
    projectId,
    aiConfidenceThreshold: threshold,
    geofencePolicy: geofencePolicy as never,
    recencyDays,
    offlineAllowanceDays: offlineDays,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.id,
  };
  repo.upsertVerificationPolicy(policy);
  if (project.status !== "DRAFT") {
    bumpConfigVersion(repo.getProject(projectId)!);
    snapshotProject(projectId, `Post-launch verification policy change: ${reason}`, actor);
  }
  audit({
    projectId, actorUserId: actor.id, action: "VERIFICATION_POLICY_UPDATED",
    entityType: "verification_policy", entityId: projectId, reason,
    beforeSummary: null,
    afterSummary: `threshold ${threshold ?? "default"} · geofence ${geofencePolicy ?? "default"} · recency ${recencyDays ?? "default"}d`,
  });
  return policy;
}

// -------------------------------------------------------- draw structure

export interface DrawReconciliation {
  trancheTotal: number;
  controlledAmount: number;
  matched: boolean;
  currency: string;
}

export function drawReconciliation(projectId: string): DrawReconciliation {
  const project = mustProject(projectId);
  const milestones = repo.listMilestones(projectId).filter((m) => !m.archived);
  const trancheTotal = milestones.reduce((sum, m) => sum + m.trancheAmount, 0);
  const controlledAmount = project.pilot?.obvControlledAmount ?? project.totalBudget;
  return {
    trancheTotal,
    controlledAmount,
    matched: trancheTotal === controlledAmount,
    currency: project.pilot?.currency ?? "USD",
  };
}

// ------------------------------------------------------ approval matrix

export function setApprovalMatrix(
  projectId: string,
  milestoneId: string | null,
  roles: string[],
  actor: User,
  reason?: string | null
): ApprovalPolicy {
  const project = mustProject(projectId);
  requireChangeReason(project, reason ?? null, "the approval matrix");
  const unique = [...new Set(roles.map((r) => String(r).toUpperCase()))] as UserRole[];
  if (unique.length === 0) throw new SubmissionError("At least one approval role is required");
  for (const role of unique) {
    if (!APPROVER_ROLES.includes(role)) {
      throw new SubmissionError(
        `Role ${role} cannot be part of the approval matrix (allowed: ${APPROVER_ROLES.join(", ")})`
      );
    }
  }
  if (unique.length < 2) {
    throw new SubmissionError(
      "Separation of duties: at least two distinct approval roles are required"
    );
  }
  if (milestoneId && !repo.getMilestone(milestoneId)) throw new SubmissionError("Unknown milestone", 404);
  const policy: ApprovalPolicy = {
    id: repo.newId(),
    projectId,
    milestoneId,
    requiredRoles: unique,
    updatedAt: new Date().toISOString(),
    updatedBy: actor.id,
  };
  repo.upsertApprovalPolicy(policy);
  if (project.status !== "DRAFT") {
    bumpConfigVersion(repo.getProject(projectId)!);
    snapshotProject(projectId, `Post-launch approval matrix change: ${reason}`, actor);
  }
  audit({
    projectId, actorUserId: actor.id, action: "APPROVAL_MATRIX_UPDATED",
    entityType: "approval_policy", entityId: milestoneId ?? "project-default", reason: reason ?? null,
    beforeSummary: null, afterSummary: unique.join(" + "),
  });
  return policy;
}

/** Users considered project participants for matrix/readiness purposes. */
export function projectParticipants(projectId: string): User[] {
  const project = mustProject(projectId);
  const orgIds = new Set(
    [
      project.organizationId,
      project.pilot?.implementingOrgId,
      project.pilot?.contractorOrgId,
      project.pilot?.funderOrgId,
      project.pilot?.engineerOrgId,
    ].filter(Boolean) as string[]
  );
  const assigned = new Set(repo.listAssignmentsForProject(projectId).filter((a) => a.active).map((a) => a.userId));
  // The creating administrator and anyone who accepted a project-scoped
  // invitation participate regardless of organization membership.
  if (project.pilot?.createdBy) assigned.add(project.pilot.createdBy);
  for (const inv of repo.listInvitations()) {
    if (inv.projectId === projectId && inv.status === "ACCEPTED" && inv.acceptedUserId) {
      assigned.add(inv.acceptedUserId);
    }
  }
  return repo.listUsers().filter((u) => orgIds.has(u.organizationId) || assigned.has(u.id));
}

// ------------------------------------------------------ field assignment

export function assignField(
  projectId: string,
  input: { userId: string; milestoneIds?: string[]; effectiveFrom?: string | null; effectiveTo?: string | null },
  actor: User
): FieldAssignment {
  mustProject(projectId);
  const user = repo.getUser(input.userId);
  if (!user) throw new SubmissionError("Unknown user", 404);
  const milestoneIds = (input.milestoneIds ?? []).filter(Boolean);
  for (const id of milestoneIds) {
    const m = repo.getMilestone(id);
    if (!m || m.projectId !== projectId) throw new SubmissionError("Milestone not on this project", 400);
  }
  const assignment: FieldAssignment = {
    id: repo.newId(),
    projectId,
    userId: user.id,
    milestoneIds,
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveTo: input.effectiveTo ?? null,
    active: true,
    createdBy: actor.id,
    createdAt: new Date().toISOString(),
  };
  repo.insertAssignment(assignment);
  audit({
    projectId, actorUserId: actor.id, action: "FIELD_ASSIGNED",
    entityType: "field_assignment", entityId: assignment.id, reason: null,
    beforeSummary: null,
    afterSummary: `${user.name} → ${milestoneIds.length ? `${milestoneIds.length} milestone(s)` : "all milestones"}`,
  });
  return assignment;
}

// ------------------------------------------------------------ readiness

/** Deterministic Project Readiness evaluation — configuration checks
 *  only, no AI anywhere. */
export function evaluateReadiness(projectId: string): { ready: boolean; checks: ReadinessCheck[] } {
  const project = mustProject(projectId);
  const org = repo.getOrganization(project.organizationId);
  const milestones = repo.listMilestones(projectId).filter((m) => !m.archived);
  const participants = projectParticipants(projectId);
  const assignments = repo.listAssignmentsForProject(projectId).filter((a) => a.active);
  const recon = drawReconciliation(projectId);
  const checks: ReadinessCheck[] = [];
  const add = (c: Omit<ReadinessCheck, "group"> & { group?: string }) =>
    checks.push({ group: c.group ?? "PROJECT", ...c } as ReadinessCheck);

  // ORGANIZATION
  add({
    key: "org-primary", group: "ORGANIZATION", stage: "organization",
    label: "Primary organization configured",
    ok: Boolean(org), detail: org ? org.name : "No primary organization",
  });
  add({
    key: "org-implementing", group: "ORGANIZATION", stage: "project",
    label: "Implementing organization configured",
    ok: Boolean(project.pilot?.implementingOrgId),
    detail: project.pilot?.implementingOrgId
      ? repo.getOrganization(project.pilot.implementingOrgId)?.name ?? "configured"
      : "No implementing organization selected",
  });

  // USERS
  const hasRole = (role: UserRole) => participants.some((u) => u.role === role);
  add({
    key: "user-pm", group: "USERS", stage: "team",
    label: "Project manager available",
    ok: hasRole("PROJECT_MANAGER"),
    detail: hasRole("PROJECT_MANAGER") ? "Assigned" : "No PROJECT_MANAGER among project participants",
  });
  const matrixRoles = new Set<UserRole>();
  for (const m of milestones) repo.resolveApprovalRoles(projectId, m.id).forEach((r) => matrixRoles.add(r));
  for (const role of matrixRoles) {
    add({
      key: `user-${role}`, group: "GOVERNANCE", stage: "team",
      label: `${role.replace(/_/g, " ")} available for approvals`,
      ok: hasRole(role),
      detail: hasRole(role) ? "Available" : `Approval matrix requires ${role} but no participant holds it`,
    });
  }

  // PROJECT
  add({
    key: "project-dates", group: "PROJECT", stage: "project",
    label: "Project dates configured",
    ok: Boolean(project.pilot?.plannedStart && project.pilot?.plannedEnd),
    detail: project.pilot?.plannedStart
      ? `${project.pilot.plannedStart} → ${project.pilot?.plannedEnd ?? "?"}`
      : "Planned start/completion dates missing",
  });
  add({
    key: "project-currency", group: "PROJECT", stage: "project",
    label: "Currency configured",
    ok: Boolean(project.pilot?.currency),
    detail: project.pilot?.currency ?? "No reporting currency",
  });
  add({
    key: "project-amount", group: "FINANCE", stage: "project",
    label: "OBV-controlled amount valid",
    ok: recon.controlledAmount > 0,
    detail: recon.controlledAmount > 0
      ? `${recon.currency} ${recon.controlledAmount.toLocaleString("en-US")}`
      : "OBV-controlled amount must be greater than zero",
  });

  // GEOGRAPHY
  const geomOk = Boolean(project.pilot?.geometryKind) && project.siteBoundary.length >= 4;
  add({
    key: "geography", group: "GEOGRAPHY", stage: "geography",
    label: "Valid project geography exists",
    ok: geomOk,
    detail: geomOk
      ? `${project.pilot!.geometryKind} geometry (${project.siteBoundary.length}-vertex geofence)`
      : "No valid project geometry configured",
  });

  // MILESTONES
  add({
    key: "milestones-exist", group: "MILESTONES", stage: "milestones",
    label: "At least one active milestone",
    ok: milestones.length > 0,
    detail: milestones.length ? `${milestones.length} milestone(s)` : "No milestones configured",
  });
  const seqs = milestones.map((m) => m.seq);
  const seqValid = new Set(seqs).size === seqs.length && milestones.every((m) => m.seq >= 1);
  add({
    key: "milestones-seq", group: "MILESTONES", stage: "milestones",
    label: "Milestone sequence valid",
    ok: milestones.length === 0 ? false : seqValid,
    detail: seqValid ? "No duplicates" : "Duplicate or invalid sequence numbers",
  });
  const missingReq = milestones.filter((m) => !m.requirement.trim());
  add({
    key: "milestones-req", group: "MILESTONES", stage: "milestones",
    label: "Each milestone has requirement text",
    ok: milestones.length > 0 && missingReq.length === 0,
    detail: missingReq.length ? `${missingReq.length} milestone(s) missing requirement text` : "Complete",
  });

  // EVIDENCE
  const withoutEvidence = milestones.filter(
    (m) => !repo.listRequirementsForMilestone(m.id).some((r) => r.required)
  );
  add({
    key: "evidence-config", group: "EVIDENCE", stage: "evidence",
    label: "Required evidence configured for every milestone",
    ok: milestones.length > 0 && withoutEvidence.length === 0,
    detail: withoutEvidence.length
      ? `${withoutEvidence.length} milestone(s) have no required evidence: ${withoutEvidence.map((m) => `M${m.seq}`).join(", ")}`
      : "Complete",
  });

  // FINANCE
  add({
    key: "draw-reconciled", group: "FINANCE", stage: "draw",
    label: "Tranche totals reconcile with the OBV-controlled amount",
    ok: recon.matched && recon.controlledAmount > 0,
    detail: recon.matched
      ? `${recon.currency} ${recon.trancheTotal.toLocaleString("en-US")} across ${milestones.length} tranche(s)`
      : `SUM OF TRANCHES (${recon.trancheTotal.toLocaleString("en-US")}) ≠ OBV-CONTROLLED AMOUNT (${recon.controlledAmount.toLocaleString("en-US")})`,
  });
  add({
    key: "draw-amounts", group: "FINANCE", stage: "draw",
    label: "No negative tranche amounts",
    ok: milestones.every((m) => m.trancheAmount >= 0),
    detail: "Validated",
  });

  // GOVERNANCE
  const matrixConfigured = repo.listApprovalPolicies(projectId).length > 0;
  add({
    key: "matrix", group: "GOVERNANCE", stage: "approvals",
    label: "Approval matrix configured",
    ok: matrixConfigured,
    detail: matrixConfigured
      ? [...matrixRoles].join(" + ")
      : "No approval matrix configured (OBV default would apply — configure explicitly for a pilot)",
  });

  // FIELD
  add({
    key: "field", group: "FIELD", stage: "field",
    label: "At least one field participant assigned",
    ok: assignments.length > 0,
    detail: assignments.length ? `${assignments.length} assignment(s)` : "No field staff assigned",
  });

  // REPORTING
  add({
    key: "reporting", group: "REPORTING", stage: "project",
    label: "Reporting timezone configured",
    ok: Boolean(project.pilot?.timezone),
    detail: project.pilot?.timezone ?? "No timezone configured",
  });

  // INTEGRATIONS (optional — never block launch)
  add({
    key: "integrations", group: "INTEGRATIONS", stage: "integrations",
    label: "Communication integrations (optional)",
    ok: true,
    optional: true,
    detail: "Optional — internal OBV Communications is sufficient",
  });

  return { ready: checks.filter((c) => !c.optional).every((c) => c.ok), checks };
}

// --------------------------------------------------------------- launch

/**
 * LAUNCH PROJECT — configuration activation, not proof of work.
 * Creates: configuration snapshot, ACTIVE status, HELD tranche events,
 * default communication thread, audit entry. Creates NO evidence, NO
 * approvals, NO ledger entries, NO release state.
 */
export async function launchProject(projectId: string, actor: User) {
  const project = mustProject(projectId);
  if (project.status !== "DRAFT") throw new SubmissionError("Only a draft project can be launched", 409);
  const readiness = evaluateReadiness(projectId);
  if (!readiness.ready) {
    const blockers = readiness.checks.filter((c) => !c.ok && !c.optional).map((c) => c.label);
    throw new SubmissionError(`NOT READY — ${blockers.length} blocker(s): ${blockers.join("; ")}`, 422);
  }
  const snapshot = snapshotProject(projectId, "Project launch", actor);
  repo.updateProjectFields(projectId, {
    status: "ACTIVE",
    launchedAt: new Date().toISOString(),
    launchedBy: actor.id,
  });
  const milestones = repo.listMilestones(projectId).filter((m) => !m.archived);
  for (const m of milestones) {
    repo.updateMilestoneStatus(m.id, m.seq === Math.min(...milestones.map((x) => x.seq)) ? "PENDING_EVIDENCE" : "NOT_STARTED");
    await virtualAccountService.holdTranche(m);
  }
  repo.insertThread({
    id: repo.newId(),
    organizationId: project.organizationId,
    projectId,
    milestoneId: null,
    evidenceItemId: null,
    approvalRequestId: null,
    title: "Project General",
    scope: "PROJECT",
    createdAt: new Date().toISOString(),
    createdBy: actor.id,
  });
  audit({
    projectId, actorUserId: actor.id, action: "PROJECT_LAUNCHED",
    entityType: "project", entityId: projectId, reason: null,
    beforeSummary: "DRAFT", afterSummary: `ACTIVE (config v${snapshot.version}, ${milestones.length} milestones HELD)`,
  });
  return { project: repo.getProject(projectId)!, snapshot };
}

/** Immutable configuration snapshot (separate from the Evidence Ledger). */
export function snapshotProject(projectId: string, reason: string, actor: User) {
  const project = mustProject(projectId);
  const milestones = repo.listMilestones(projectId);
  const data = {
    project: { ...project },
    milestones: milestones.map((m) => ({
      ...m,
      requirements: repo.listRequirementsForMilestone(m.id),
    })),
    verificationPolicy: repo.getVerificationPolicy(projectId),
    approvalPolicies: repo.listApprovalPolicies(projectId),
    inspectionRequirements: repo.listInspectionRequirementsForProject(projectId),
    assignments: repo.listAssignmentsForProject(projectId),
    participants: projectParticipants(projectId).map((u) => ({ id: u.id, name: u.name, role: u.role })),
  };
  const json = JSON.stringify(data);
  const existing = repo.listConfigSnapshots(projectId);
  const version = existing.length ? existing[existing.length - 1].version + 1 : project.pilot?.configVersion ?? 1;
  const snapshot = {
    id: repo.newId(),
    projectId,
    version,
    hash: createHash("sha256").update(json).digest("hex"),
    data: json,
    reason,
    createdBy: actor.id,
    createdAt: new Date().toISOString(),
  };
  repo.insertConfigSnapshot(snapshot);
  return snapshot;
}

// ------------------------------------------------------------- export

/** Pilot Export Package — configuration + registers as one JSON document.
 *  Never includes tokens, secrets, or invitation token hashes. */
export function buildExportPackage(projectId: string) {
  const project = mustProject(projectId);
  const milestones = repo.listMilestones(projectId);
  const readiness = evaluateReadiness(projectId);
  const users = new Map(repo.listUsers().map((u) => [u.id, u]));
  return {
    generatedAt: new Date().toISOString(),
    kind: "OBV_PILOT_EXPORT_V1",
    project: {
      id: project.id, name: project.name, code: project.pilot?.code,
      category: project.pilot?.category, status: project.status,
      country: project.pilot?.country, region: project.pilot?.region,
      currency: project.pilot?.currency,
      obvControlledAmount: project.pilot?.obvControlledAmount ?? project.totalBudget,
      plannedStart: project.pilot?.plannedStart, plannedEnd: project.pilot?.plannedEnd,
      launchedAt: project.pilot?.launchedAt, configVersion: project.pilot?.configVersion,
    },
    participants: projectParticipants(projectId).map((u) => ({
      name: u.name, role: u.role, title: u.title,
      organization: repo.getOrganization(u.organizationId)?.name ?? null,
    })),
    milestoneRegister: milestones.map((m) => ({
      seq: m.seq, title: m.title, requirement: m.requirement,
      trancheAmount: m.trancheAmount, status: m.status, accountStatus: m.accountStatus,
      plannedStart: m.plannedStart, plannedEnd: m.plannedEnd, archived: m.archived,
    })),
    evidenceRequirementRegister: milestones.flatMap((m) =>
      repo.listRequirementsForMilestone(m.id).map((r) => ({
        milestone: `M${m.seq}`, type: r.type, title: r.title, required: r.required,
        minCount: r.minCount, mediaTypes: r.mediaTypes,
        geolocationRequired: r.geolocationRequired, recencyDays: r.recencyDays,
      }))
    ),
    drawStructure: {
      ...drawReconciliation(projectId),
      tranches: milestones.filter((m) => !m.archived).map((m) => ({
        seq: m.seq, milestone: m.title, amount: m.trancheAmount, accountStatus: m.accountStatus,
      })),
    },
    approvalMatrix: repo.listApprovalPolicies(projectId).map((p) => ({
      scope: p.milestoneId ? `milestone ${repo.getMilestone(p.milestoneId)?.seq}` : "project default",
      requiredRoles: p.requiredRoles,
    })),
    verificationPolicy: repo.getVerificationPolicy(projectId),
    openIssues: repo.listFieldIssues()
      .filter((i) => i.projectId === projectId && !["RESOLVED", "CLOSED"].includes(i.status))
      .map((i) => ({ title: i.title, category: i.category, severity: i.severity, status: i.status })),
    clarifications: milestones.flatMap((m) =>
      repo.listClarificationsForMilestone(m.id).map((c) => ({
        milestone: `M${m.seq}`, question: c.question, status: c.status,
      }))
    ),
    readiness: { ready: readiness.ready, checks: readiness.checks },
    reportIndex: repo.listReports()
      .filter((r) => r.projectId === projectId)
      .map((r) => ({ filename: r.filename, generatedAt: r.generatedAt, integrity: r.integrityStatus })),
    configSnapshots: repo.listConfigSnapshots(projectId).map((s) => ({
      version: s.version, hash: s.hash, reason: s.reason, createdAt: s.createdAt,
      createdBy: users.get(s.createdBy)?.name ?? s.createdBy,
    })),
  };
}

// ----------------------------------------------------------- CSV import

/** Minimal RFC-4180-ish CSV parser (quotes, commas, newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

export interface CsvImportResult {
  ok: boolean;
  imported: number;
  errors: string[];
  preview: Array<Record<string, string>>;
}

export const CSV_TEMPLATES: Record<string, { columns: string[]; example: string[] }> = {
  milestones: {
    columns: ["sequence", "title", "requirement", "planned_start", "planned_end", "tranche_amount", "spatial_label"],
    example: ["1", "Site mobilization", "Photo of mobilized equipment on site", "2026-08-01", "2026-08-20", "120000", "km 0-2"],
  },
  requirements: {
    columns: ["milestone_sequence", "type", "title", "required", "min_count", "media_types", "geolocation_required", "recency_days"],
    example: ["1", "PHOTO", "Site progress photo set", "true", "3", "image/jpeg;image/png", "true", "7"],
  },
  invitations: {
    columns: ["email", "role", "organization_name"],
    example: ["engineer@example.org", "FIELD", "ABC Civil Works"],
  },
};

export function csvTemplateText(kind: string): string {
  const t = CSV_TEMPLATES[kind];
  if (!t) throw new SubmissionError("Unknown CSV template", 404);
  return `${t.columns.join(",")}\n${t.example.join(",")}\n`;
}

/** Validate + (optionally) import CSV rows. Transactional: any row error
 *  aborts the whole import — no partial silent corruption. */
export function importCsv(
  kind: string,
  projectId: string,
  text: string,
  commit: boolean,
  actor: User
): CsvImportResult {
  const template = CSV_TEMPLATES[kind];
  if (!template) throw new SubmissionError("Unknown import kind", 404);
  const project = mustProject(projectId);
  if (kind !== "invitations" && project.status !== "DRAFT") {
    throw new SubmissionError("CSV import of configuration is available before launch only", 409);
  }
  const rows = parseCsv(text ?? "");
  if (rows.length < 2) return { ok: false, imported: 0, errors: ["CSV needs a header row and at least one data row"], preview: [] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = template.columns.filter((c) => !header.includes(c));
  if (missing.length) {
    return { ok: false, imported: 0, errors: [`Missing column(s): ${missing.join(", ")}`], preview: [] };
  }
  const records = rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => (rec[h] = (r[i] ?? "").trim()));
    return rec;
  });
  const errors: string[] = [];
  const milestonesBySeq = new Map(repo.listMilestones(projectId).map((m) => [String(m.seq), m]));
  const seenSeq = new Set<string>();
  const seenEmail = new Set<string>();
  records.forEach((rec, idx) => {
    const line = idx + 2;
    if (kind === "milestones") {
      if (!/^\d+$/.test(rec.sequence)) errors.push(`Line ${line}: sequence must be a positive integer`);
      else if (seenSeq.has(rec.sequence) || milestonesBySeq.has(rec.sequence))
        errors.push(`Line ${line}: duplicate sequence ${rec.sequence}`);
      seenSeq.add(rec.sequence);
      if (!rec.title) errors.push(`Line ${line}: title required`);
      if (!rec.requirement) errors.push(`Line ${line}: requirement required`);
      if (rec.tranche_amount && !/^\d+$/.test(rec.tranche_amount))
        errors.push(`Line ${line}: tranche_amount must be a non-negative integer`);
    } else if (kind === "requirements") {
      if (!milestonesBySeq.has(rec.milestone_sequence))
        errors.push(`Line ${line}: no milestone with sequence ${rec.milestone_sequence}`);
      if (!REQUIREMENT_TYPES.includes(rec.type.toUpperCase()))
        errors.push(`Line ${line}: unknown type ${rec.type}`);
      if (!rec.title) errors.push(`Line ${line}: title required`);
      for (const mt of rec.media_types.split(";").map((s) => s.trim()).filter(Boolean)) {
        if (!REQUIREMENT_MEDIA_TYPES.includes(mt)) errors.push(`Line ${line}: media type ${mt} not allowed`);
      }
    } else {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) errors.push(`Line ${line}: invalid email`);
      else if (seenEmail.has(rec.email.toLowerCase())) errors.push(`Line ${line}: duplicate email ${rec.email}`);
      seenEmail.add(rec.email.toLowerCase());
      if (!VALID_ROLES.includes(rec.role.toUpperCase() as UserRole))
        errors.push(`Line ${line}: unknown role ${rec.role}`);
      if (!repo.listOrganizations().some((o) => o.name.toLowerCase() === rec.organization_name.toLowerCase()))
        errors.push(`Line ${line}: unknown organization "${rec.organization_name}"`);
    }
  });
  if (errors.length || !commit) {
    return { ok: errors.length === 0, imported: 0, errors, preview: records.slice(0, 10) };
  }
  // Commit — validation passed for every row.
  for (const rec of records) {
    if (kind === "milestones") {
      addMilestone(
        projectId,
        {
          seq: rec.sequence, title: rec.title, requirement: rec.requirement,
          plannedStart: rec.planned_start, plannedEnd: rec.planned_end,
          trancheAmount: rec.tranche_amount || 0, spatialLabel: rec.spatial_label,
        },
        actor
      );
    } else if (kind === "requirements") {
      saveRequirement(
        {
          milestoneId: milestonesBySeq.get(rec.milestone_sequence)!.id,
          type: rec.type.toUpperCase(), title: rec.title,
          required: rec.required !== "false", minCount: rec.min_count || 1,
          mediaTypes: rec.media_types.split(";").map((s) => s.trim()).filter(Boolean),
          geolocationRequired: rec.geolocation_required === "true",
          recencyDays: rec.recency_days || null,
        },
        actor
      );
    } else {
      const org = repo.listOrganizations().find(
        (o) => o.name.toLowerCase() === rec.organization_name.toLowerCase()
      )!;
      createInvitation(
        { email: rec.email, organizationId: org.id, role: rec.role.toUpperCase(), projectId },
        actor
      );
    }
  }
  audit({
    projectId, actorUserId: actor.id, action: "CSV_IMPORTED",
    entityType: "csv", entityId: kind, reason: null,
    beforeSummary: null, afterSummary: `${records.length} row(s) of ${kind}`,
  });
  return { ok: true, imported: records.length, errors: [], preview: [] };
}

// ------------------------------------------------------ setup progress

export interface SetupStage {
  slug: string;
  title: string;
  complete: boolean;
  detail: string;
}

/** Stage completion for the setup workspace progress display. */
export function setupStages(projectId: string): SetupStage[] {
  const project = mustProject(projectId);
  const milestones = repo.listMilestones(projectId).filter((m) => !m.archived);
  const recon = drawReconciliation(projectId);
  const readiness = evaluateReadiness(projectId);
  const check = (key: string) => readiness.checks.find((c) => c.key === key)?.ok ?? false;
  const reqCount = milestones.reduce((n, m) => n + repo.listRequirementsForMilestone(m.id).length, 0);
  return [
    { slug: "project", title: "Project", complete: Boolean(project.name && project.pilot?.plannedStart && project.pilot?.currency), detail: project.pilot?.code ?? project.name },
    { slug: "geography", title: "Geography", complete: check("geography"), detail: project.pilot?.geometryKind ?? "Not configured" },
    { slug: "milestones", title: "Milestones", complete: check("milestones-exist") && check("milestones-seq") && check("milestones-req"), detail: `${milestones.length} configured` },
    { slug: "evidence", title: "Evidence Requirements", complete: check("evidence-config"), detail: `${reqCount} requirement(s)` },
    { slug: "draw", title: "Draw Structure", complete: recon.matched && recon.controlledAmount > 0, detail: `${recon.currency} ${recon.trancheTotal.toLocaleString("en-US")}` },
    { slug: "approvals", title: "Approval Rules", complete: check("matrix"), detail: repo.listApprovalPolicies(projectId).length ? "Configured" : "Not configured" },
    { slug: "field", title: "Field Assignments", complete: check("field"), detail: `${repo.listAssignmentsForProject(projectId).filter((a) => a.active).length} assignment(s)` },
    { slug: "integrations", title: "Integrations", complete: true, detail: "Optional" },
    { slug: "review", title: "Readiness Review", complete: readiness.ready, detail: readiness.ready ? "READY TO LAUNCH" : `${readiness.checks.filter((c) => !c.ok && !c.optional).length} blocker(s)` },
  ];
}
