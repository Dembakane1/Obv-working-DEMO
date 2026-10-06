/**
 * External field observation REVIEW — where an unverified observation
 * reaches a HUMAN, and the ONLY path by which one can become evidence.
 *
 *   accept  -> processEvidenceSubmission (the SAME governed pipeline direct
 *              field capture uses: WORM store, hash chain, verification,
 *              approval request on VERIFIED, notifications) + an immutable
 *              evidence_provenance row naming the external source
 *   reject / defer -> status only
 *   assign project -> match only
 *
 * This module never writes evidence_items, verifications, ledger,
 * milestone status, approvals, draws, exceptions, inspections or banking
 * records itself. Acceptance records the accepting reviewer as the
 * evidence submitter (the pipeline's separation-of-duties rule then bars
 * that reviewer from approving the milestone) and never pretends the
 * photo was captured in OBV.
 */
import * as fs from "node:fs";
import * as repo from "../../../db/repo";
import * as interopRepo from "../../../db/interopRepo";
import * as authz from "../../authz";
import * as evidenceIntel from "../../evidenceIntel";
import { pointInPolygon } from "../../geo";
import { processEvidenceSubmission, type SubmissionResult } from "../../../workflow/orchestrator";
import type {
  EvidenceProvenance,
  FieldObservation,
  FieldObservationEvent,
  FieldObservationImport,
  FieldObservationPhoto,
  FieldObservationStatus,
  Milestone,
  Project,
  User,
} from "../../../../shared/types";
import {
  FIELD_OBSERVATION_NOTICE,
  InteropError,
  assertInteropViewer,
  assertObservationReviewer,
  canImportObservations,
  canReviewObservations,
  nowIso,
  requireVisibleProject,
  resolveInteropKey,
  sha256Hex,
  strOrNull,
} from "../core";
import { providerDisplayName } from "./provenance";

// ------------------------------------------------------------ reads

export interface ObservationListRow {
  observation: FieldObservation;
  projectName: string | null;
  providerName: string;
  photosTransferred: number;
}

function providerName(o: FieldObservation): string {
  return o.providerLabel ?? providerDisplayName(o.sourceSystem);
}

function row(o: FieldObservation): ObservationListRow {
  const project = o.matchedProjectId ? repo.getProject(o.matchedProjectId) : null;
  return {
    observation: o,
    projectName: project?.name ?? null,
    providerName: providerName(o),
    photosTransferred: interopRepo.listPhotos(o.id).filter((p) => p.transferred).length,
  };
}

/** Observations matched to one project (same-404 on the project). */
export function listProjectObservations(user: User, projectId: string, status?: FieldObservationStatus): ObservationListRow[] {
  const project = requireVisibleProject(user, projectId);
  return interopRepo.listObservationsForProject(project.id, status).map(row);
}

/** Observations the caller's organization imported that have no project,
 *  plus those on projects the caller can see. Tenant-scoped twice: by the
 *  importing organization and by project visibility. */
export function listObservationsForUser(user: User, status?: FieldObservationStatus): ObservationListRow[] {
  assertInteropViewer(user);
  const visible = authz.accessibleProjectIds(user);
  return interopRepo
    .listObservationsForOrganization(user.organizationId, 500)
    .filter((o) => (status ? o.status === status : true))
    .filter((o) => o.matchedProjectId === null || visible.has(o.matchedProjectId))
    .map(row);
}

export function observationStats(user: User): Record<string, number> {
  assertInteropViewer(user);
  return interopRepo.countObservationsByStatus(user.organizationId);
}

export function listImports(user: User): FieldObservationImport[] {
  assertInteropViewer(user);
  return interopRepo.listImportsForOrganization(user.organizationId, 100);
}

export interface ObservationDetail {
  observation: FieldObservation;
  providerName: string;
  import: FieldObservationImport | null;
  project: Project | null;
  milestones: Milestone[];
  photos: Array<FieldObservationPhoto & { url: string | null }>;
  events: FieldObservationEvent[];
  geofence: { checked: boolean; inside: boolean | null; detail: string };
  acceptance: { possible: boolean; blockers: string[] };
  acceptedEvidence: { id: string; verdict: string | null; milestoneTitle: string | null } | null;
  notice: string;
}

/** Resolve an observation the caller may see: matched to a visible
 *  project, or unmatched and imported by the caller's organization.
 *  Anything else is "not found". */
function requireObservation(user: User, id: string): { observation: FieldObservation; project: Project | null } {
  assertInteropViewer(user);
  const observation = interopRepo.getObservation(String(id ?? ""));
  if (!observation) throw new InteropError("Not found", 404);
  if (observation.matchedProjectId) {
    const project = requireVisibleProject(user, observation.matchedProjectId);
    return { observation, project };
  }
  if (observation.organizationId !== user.organizationId) throw new InteropError("Not found", 404);
  return { observation, project: null };
}

export function observationDetail(user: User, id: string): ObservationDetail {
  const { observation, project } = requireObservation(user, id);
  const photos = interopRepo.listPhotos(observation.id).map((p) => ({
    ...p,
    url: p.transferred ? `/api/interop/field-observations/${encodeURIComponent(observation.id)}/photos/${encodeURIComponent(p.id)}` : null,
  }));
  let geofence: ObservationDetail["geofence"] = { checked: false, inside: null, detail: "No matched project or no coordinates — boundary not checked." };
  if (project && observation.latitude !== null && observation.longitude !== null) {
    if (project.siteBoundary.length >= 4) {
      const inside = pointInPolygon(observation.longitude, observation.latitude, project.siteBoundary);
      geofence = { checked: true, inside, detail: inside ? "Source coordinates fall inside the project's recorded site boundary." : "Source coordinates fall outside the project's recorded site boundary." };
    } else {
      geofence = { checked: false, inside: null, detail: "The project has no recorded site boundary." };
    }
  }
  const blockers: string[] = [];
  if (!(observation.status === "UNVERIFIED" || observation.status === "DEFERRED")) blockers.push(`already ${observation.status.toLowerCase()}`);
  if (!project) blockers.push("no project assigned — assign the observation to a project first");
  if (!photos.some((p) => p.transferred)) blockers.push("no photo bytes were transferred (a source URL alone is recorded, never retrieved)");
  if (!observation.observedAt) blockers.push("no usable source timestamp — evidence requires the observation time");
  const accepted = observation.acceptedEvidenceId ? repo.getEvidence(observation.acceptedEvidenceId) : null;
  const acceptedVerification = accepted ? repo.getVerificationForEvidence(accepted.id) : null;
  const acceptedMilestone = accepted ? repo.getMilestone(accepted.milestoneId) : null;
  return {
    observation,
    providerName: providerName(observation),
    import: interopRepo.getImport(observation.importId),
    project,
    milestones: project ? repo.listMilestones(project.id).filter((m) => !m.archived) : [],
    photos,
    events: interopRepo.listObservationEvents(observation.id),
    geofence,
    acceptance: { possible: blockers.length === 0, blockers },
    acceptedEvidence: accepted
      ? { id: accepted.id, verdict: acceptedVerification?.verdict ?? null, milestoneTitle: acceptedMilestone?.title ?? null }
      : null,
    notice: FIELD_OBSERVATION_NOTICE,
  };
}

/** Photo bytes for a transferred photo — session + tenant gated, integrity
 *  re-checked against the recorded hash on every read. */
export function observationPhoto(user: User, observationId: string, photoId: string): { bytes: Buffer; contentType: string } {
  const { observation } = requireObservation(user, observationId);
  const photo = interopRepo.getPhoto(String(photoId ?? ""));
  if (!photo || photo.observationId !== observation.id || !photo.transferred || !photo.storedPath) {
    throw new InteropError("Not found", 404);
  }
  const bytes = fs.readFileSync(resolveInteropKey(photo.storedPath));
  if (sha256Hex(bytes) !== photo.sha256) throw new InteropError("Stored photo failed its integrity check", 409);
  return { bytes, contentType: photo.contentType ?? "application/octet-stream" };
}

// ------------------------------------------------------------ decisions

function event(observationId: string, actor: User, kind: FieldObservationEvent["kind"], detail: string | null): void {
  interopRepo.insertObservationEvent({ id: repo.newId(), observationId, occurredAt: nowIso(), actorUserId: actor.id, kind, detail });
}

function audit(projectId: string | null, actor: User, action: string, observation: FieldObservation, after: string, reason: string | null): void {
  repo.insertConfigAudit({
    id: repo.newId(), projectId, actorUserId: actor.id, action,
    entityType: "field_observation", entityId: observation.id, reason,
    beforeSummary: `${observation.status} · ${observation.providerLabel ?? observation.sourceSystem} ${observation.externalObservationId}`,
    afterSummary: after, createdAt: nowIso(),
  });
}

/** A reviewer assigns (or re-assigns) the project an unmatched or
 *  ambiguous observation belongs to. The target must be visible. */
export function assignObservationProject(user: User, id: string, projectId: string, note: string | null): FieldObservation {
  // Assigning a project is a MATCHING step, not a verification decision:
  // the importer may correct a mis-keyed reference as well as a reviewer.
  // The observation stays UNVERIFIED either way; only a reviewer accepts.
  assertInteropViewer(user);
  if (!canImportObservations(user) && !canReviewObservations(user)) {
    throw new InteropError("Assigning a project requires the importer or reviewer role", 403);
  }
  const { observation } = requireObservation(user, id);
  const project = requireVisibleProject(user, projectId);
  if (!(observation.status === "UNVERIFIED" || observation.status === "DEFERRED")) {
    throw new InteropError("This observation has already been decided", 409);
  }
  const reasons = [`assigned to ${project.id} by ${user.name}`, ...(note ? [`note: ${note}`] : [])];
  if (observation.latitude !== null && observation.longitude !== null && project.siteBoundary.length >= 4) {
    reasons.push(pointInPolygon(observation.longitude, observation.latitude, project.siteBoundary)
      ? "coordinates fall inside the recorded site boundary (advisory)"
      : "coordinates fall OUTSIDE the recorded site boundary (advisory — review carefully)");
  }
  let suggested: string | null = null;
  if (observation.milestoneReference) {
    const ref = observation.milestoneReference.trim().toLowerCase();
    suggested = repo.listMilestones(project.id).find((m) => !m.archived && (m.id.toLowerCase() === ref || String(m.seq) === ref || m.title.trim().toLowerCase() === ref))?.id ?? null;
  }
  if (!interopRepo.setObservationMatch(observation.id, { matchedProjectId: project.id, matchVerdict: "REVIEWER_ASSIGNED", matchReasons: reasons, suggestedMilestoneId: suggested })) {
    throw new InteropError("This observation has already been decided", 409);
  }
  event(observation.id, user, "MATCHED", `REVIEWER_ASSIGNED: ${reasons.join("; ")}`);
  audit(project.id, user, "FIELD_OBSERVATION_ASSIGNED", observation, `assigned to project ${project.id}`, strOrNull(note, 400));
  return interopRepo.getObservation(observation.id)!;
}

export interface AcceptResult {
  observation: FieldObservation;
  submission: SubmissionResult;
  provenance: EvidenceProvenance;
}

/**
 * Accept an observation as evidence for one milestone. Runs the governed
 * evidence pipeline; whatever verdict it reaches (VERIFIED, NEEDS_REVIEW,
 * REJECTED) is the pipeline's own — acceptance never sets a verdict,
 * approves a milestone or releases anything.
 */
export async function acceptObservation(
  user: User,
  id: string,
  input: { milestoneId: string; photoId?: string | null; note?: string | null }
): Promise<AcceptResult> {
  assertObservationReviewer(user);
  const { observation, project } = requireObservation(user, id);
  if (!project) throw new InteropError("Assign the observation to a project before accepting it", 409);
  if (!(observation.status === "UNVERIFIED" || observation.status === "DEFERRED")) {
    throw new InteropError("This observation has already been decided", 409);
  }
  // Nested-object guard: the milestone must belong to the matched project.
  let milestone: Milestone;
  try {
    milestone = authz.requireMilestoneInProject(user, project.id, String(input.milestoneId ?? "")).milestone;
  } catch {
    throw new InteropError("Not found", 404);
  }
  if (milestone.archived) throw new InteropError("That milestone is archived", 409);
  if (!observation.observedAt) {
    throw new InteropError("The observation carries no usable source timestamp, so it cannot enter the evidence pipeline", 409);
  }
  const photos = interopRepo.listPhotos(observation.id).filter((p) => p.transferred && p.storedPath);
  const photo = input.photoId ? photos.find((p) => p.id === input.photoId) : photos[0];
  if (!photo || !photo.storedPath) {
    throw new InteropError("No transferred photo is available for this observation (source URLs are recorded, never retrieved)", 409);
  }
  const bytes = fs.readFileSync(resolveInteropKey(photo.storedPath));
  if (sha256Hex(bytes) !== photo.sha256) throw new InteropError("Stored photo failed its integrity check", 409);
  const mime = photo.contentType === "image/png" ? "png" : photo.contentType === "image/webp" ? "webp" : "jpeg";
  const provider = providerName(observation);

  // THE governed pipeline. capturedAt is the SOURCE's observation time —
  // honestly carried, never replaced by the import or acceptance time.
  // deviceMetadata states the external origin in plain words; the real
  // device metadata (if any) stays in the observation's source metadata.
  const submission = await processEvidenceSubmission(
    {
      milestoneId: milestone.id,
      photoDataUrl: `data:image/${mime};base64,${bytes.toString("base64")}`,
      latitude: observation.latitude as unknown as number,   // null preserved — geofence handles it
      longitude: observation.longitude as unknown as number,
      capturedAt: observation.observedAt,
      deviceMetadata: {
        userAgent: `External field observation (source: ${provider}; external record ${observation.externalObservationId}; no OBV device capture metadata)`,
        platform: provider,
        screen: "external",
        language: "unknown",
      },
      isDemoFallback: false,
    },
    user.id
  );

  const acceptedAt = nowIso();
  const note = strOrNull(input.note, 1000);
  if (!interopRepo.resolveObservation(observation.id, {
    status: "ACCEPTED", milestoneId: milestone.id, acceptedEvidenceId: submission.evidence.id,
    reviewedByUserId: user.id, reviewedAt: acceptedAt, reviewNote: note,
  })) {
    throw new InteropError("This observation was decided concurrently", 409);
  }
  const provenance: EvidenceProvenance = {
    evidenceItemId: submission.evidence.id,
    origin: "EXTERNAL_FIELD_OBSERVATION",
    observationId: observation.id,
    importId: observation.importId,
    sourceSystem: observation.sourceSystem,
    providerLabel: provider,
    externalObservationId: observation.externalObservationId,
    collector: observation.collector,
    sourceObservedAt: observation.observedAt,
    sourceLatitude: observation.latitude,
    sourceLongitude: observation.longitude,
    sourceAccuracyMeters: observation.accuracyMeters,
    sourceRecordSha256: observation.sourceRecordSha256,
    acceptedByUserId: user.id,
    acceptedAt,
  };
  // A replayed identical submission returns the existing evidence item,
  // which may already carry provenance; never overwrite it.
  if (!interopRepo.getEvidenceProvenance(submission.evidence.id)) interopRepo.insertEvidenceProvenance(provenance);
  event(observation.id, user, "ACCEPTED", `accepted for milestone ${milestone.seq} — ${milestone.title}${note ? `; note: ${note}` : ""}`);
  event(observation.id, user, "EVIDENCE_CREATED", `evidence ${submission.evidence.id} created through the governed pipeline; verification verdict ${submission.verification.verdict}`);
  audit(project.id, user, "FIELD_OBSERVATION_ACCEPTED", observation,
    `ACCEPTED → evidence ${submission.evidence.id} on milestone ${milestone.seq} (pipeline verdict ${submission.verification.verdict})`, note);

  // Evidence Intelligence analyses the new item under the SAME rules as
  // native evidence; its findings stay advisory. A failure here never
  // undoes the acceptance.
  try {
    evidenceIntel.analyzeEvidenceItem(user, submission.evidence.id);
  } catch {
    /* advisory */
  }

  return { observation: interopRepo.getObservation(observation.id)!, submission, provenance };
}

export function rejectObservation(user: User, id: string, note: string | null): FieldObservation {
  return decide(user, id, "REJECTED", note);
}

export function deferObservation(user: User, id: string, note: string | null): FieldObservation {
  return decide(user, id, "DEFERRED", note);
}

function decide(user: User, id: string, status: "REJECTED" | "DEFERRED", note: string | null): FieldObservation {
  assertObservationReviewer(user);
  const { observation, project } = requireObservation(user, id);
  if (!(observation.status === "UNVERIFIED" || observation.status === "DEFERRED")) {
    throw new InteropError("This observation has already been decided", 409);
  }
  if (status === "DEFERRED" && observation.status === "DEFERRED") {
    throw new InteropError("This observation is already deferred", 409);
  }
  const at = nowIso();
  const cleanNote = strOrNull(note, 1000);
  if (!interopRepo.resolveObservation(observation.id, {
    status, milestoneId: null, acceptedEvidenceId: null, reviewedByUserId: user.id, reviewedAt: at, reviewNote: cleanNote,
  })) {
    throw new InteropError("This observation was decided concurrently", 409);
  }
  event(observation.id, user, status, cleanNote);
  audit(project?.id ?? null, user, status === "REJECTED" ? "FIELD_OBSERVATION_REJECTED" : "FIELD_OBSERVATION_DEFERRED", observation, status, cleanNote);
  return interopRepo.getObservation(observation.id)!;
}

export function noteObservation(user: User, id: string, note: string): FieldObservation {
  assertObservationReviewer(user);
  const { observation } = requireObservation(user, id);
  const clean = strOrNull(note, 1000);
  if (!clean) throw new InteropError("A note needs text");
  event(observation.id, user, "NOTE", clean);
  return observation;
}
