/**
 * External field observation INGEST — the write path for imports.
 *
 *   external system
 *     -> immutable source snapshot      (payload file, write-once + sha256)
 *     -> normalized observation candidate (field_observations, UNVERIFIED)
 *     -> project matching               (declared / reference; advisory
 *                                        geometry reasons; never geometry
 *                                        alone)
 *
 * Nothing here is evidence. No evidence_items, verifications, ledger,
 * milestone, approval, draw, exception, inspection or banking row is
 * touched by an import. Reviewer decisions live in review.ts.
 */
import * as fs from "node:fs";
import * as repo from "../../../db/repo";
import * as interopRepo from "../../../db/interopRepo";
import * as authz from "../../authz";
import { pointInPolygon } from "../../geo";
import type {
  FieldObservation,
  FieldObservationImport,
  FieldObservationPhoto,
  Project,
  User,
} from "../../../../shared/types";
import { InteropError, assertImporter, interopKey, nowIso, requireVisibleProject, resolveInteropKey, sha256Hex, strOrNull } from "../core";
import { canonicalJson } from "../../interop/oc4ids/validate";
import { ADAPTER_ID, IMPORT_LIMITS, parseImportEnvelope, type ImportObservationInput } from "./format";

export interface ImportSummary {
  import: FieldObservationImport;
  observations: FieldObservation[];
  duplicates: Array<{ externalObservationId: string; existingObservationId: string }>;
  unmatched: number;
}

interface MatchOutcome {
  projectId: string | null;
  verdict: FieldObservation["matchVerdict"];
  reasons: string[];
  suggestedMilestoneId: string | null;
}

/** Deterministic project matching restricted to projects the importer can
 *  see. A declared project wins; otherwise the observation's own
 *  reference must equal exactly one accessible project's id or code. */
export function matchObservation(
  obs: ImportObservationInput,
  declared: Project | null,
  envelopeReference: string | null,
  accessible: Project[]
): MatchOutcome {
  const reasons: string[] = [];
  let project: Project | null = null;
  let verdict: FieldObservation["matchVerdict"] = "NO_MATCH";
  if (declared) {
    project = declared;
    verdict = "DECLARED_PROJECT";
    reasons.push(`the import declared project ${declared.id} as its target`);
  } else {
    const ref = (obs.projectReference ?? envelopeReference ?? "").trim().toLowerCase();
    if (!ref) {
      reasons.push("no project reference was supplied");
    } else {
      const hits = accessible.filter(
        (p) => p.id.toLowerCase() === ref || (p.pilot?.code ?? "").trim().toLowerCase() === ref
      );
      if (hits.length === 1) {
        project = hits[0];
        verdict = "REFERENCE_MATCH";
        reasons.push(`reference "${obs.projectReference ?? envelopeReference}" equals the project's ${project.id.toLowerCase() === ref ? "id" : "code"}`);
      } else if (hits.length > 1) {
        verdict = "AMBIGUOUS";
        reasons.push(`reference "${ref}" matches ${hits.length} projects: ${hits.map((p) => p.id).join(", ")}`);
      } else {
        reasons.push(`reference "${obs.projectReference ?? envelopeReference}" matches no project the importer can see`);
      }
    }
  }
  let suggestedMilestoneId: string | null = null;
  if (project) {
    if (obs.latitude !== null && obs.longitude !== null) {
      if (Array.isArray(project.siteBoundary) && project.siteBoundary.length >= 4) {
        const inside = pointInPolygon(obs.longitude, obs.latitude, project.siteBoundary);
        reasons.push(inside ? "coordinates fall inside the recorded site boundary (advisory)" : "coordinates fall OUTSIDE the recorded site boundary (advisory — review carefully)");
      } else {
        reasons.push("the project has no recorded site boundary; coordinates could not be checked");
      }
    } else {
      reasons.push("no coordinates were supplied");
    }
    if (obs.milestoneReference) {
      const ref = obs.milestoneReference.trim().toLowerCase();
      const ms = repo.listMilestones(project.id).filter((m) => !m.archived);
      const hit = ms.find((m) => m.id.toLowerCase() === ref || String(m.seq) === ref || m.title.trim().toLowerCase() === ref);
      if (hit) {
        suggestedMilestoneId = hit.id;
        reasons.push(`milestone reference "${obs.milestoneReference}" suggests milestone ${hit.seq} — ${hit.title} (a suggestion; the reviewer decides)`);
      } else {
        reasons.push(`milestone reference "${obs.milestoneReference}" matches no milestone of the project`);
      }
    }
  }
  return { projectId: project?.id ?? null, verdict, reasons, suggestedMilestoneId };
}

/**
 * Import a batch. The caller passes the raw bytes it received so the
 * snapshot is byte-exact; the parsed envelope is validated in full before
 * anything is written.
 */
export function importObservations(
  user: User,
  rawBody: Buffer,
  options: { declaredProjectId: string | null; notes: string | null }
): ImportSummary {
  assertImporter(user);
  if (rawBody.length > IMPORT_LIMITS.maxBodyBytes) throw new InteropError("Import body too large", 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new InteropError("The import body is not valid JSON");
  }
  const envelope = parseImportEnvelope(parsed);
  const declared = options.declaredProjectId ? requireVisibleProject(user, options.declaredProjectId) : null;
  const accessible = authz.accessibleProjects(user);
  const importedAt = nowIso();
  const importId = repo.newId();

  // ---- immutable snapshot (write-once) ----
  const dirKey = interopKey("imports", importId);
  fs.mkdirSync(resolveInteropKey(dirKey), { recursive: true });
  const payloadPath = interopKey(dirKey, "snapshot.json");
  fs.writeFileSync(resolveInteropKey(payloadPath), rawBody, { flag: "wx" });

  // ---- normalize + dedupe BEFORE any row is written ----
  const planned: Array<{ obs: FieldObservation; input: ImportObservationInput }> = [];
  const duplicates: ImportSummary["duplicates"] = [];
  for (const input of envelope.observations) {
    const sourceRecordSha256 = sha256Hex(canonicalJson(input.verbatim));
    const dedupeKey = sha256Hex(`${user.organizationId}|${envelope.sourceSystem}|${input.externalObservationId}|${sourceRecordSha256}`);
    const existing = interopRepo.findObservationByDedupeKey(dedupeKey);
    if (existing) {
      duplicates.push({ externalObservationId: input.externalObservationId, existingObservationId: existing.id });
      continue;
    }
    const match = matchObservation(input, declared, envelope.projectReference, accessible);
    planned.push({
      input,
      obs: {
        id: repo.newId(),
        importId,
        organizationId: user.organizationId,
        sourceSystem: envelope.sourceSystem,
        providerLabel: envelope.providerLabel,
        externalObservationId: input.externalObservationId,
        projectReference: input.projectReference ?? envelope.projectReference,
        matchedProjectId: match.projectId,
        matchVerdict: match.verdict,
        matchReasons: match.reasons,
        milestoneReference: input.milestoneReference,
        suggestedMilestoneId: match.suggestedMilestoneId,
        collector: input.collector,
        observedAt: input.observedAt,
        observedAtVerbatim: input.observedAtVerbatim,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracyMeters: input.accuracyMeters,
        formFields: input.formFields,
        comments: input.comments,
        photoCount: input.photos.length,
        sourceMetadata: input.sourceMetadata,
        sourceRecordSha256,
        ingestedAt: importedAt,
        status: "UNVERIFIED",
        milestoneId: null,
        acceptedEvidenceId: null,
        reviewedByUserId: null,
        reviewedAt: null,
        reviewNote: null,
        dedupeKey,
      },
    });
  }

  const record: FieldObservationImport = {
    id: importId,
    organizationId: user.organizationId,
    declaredProjectId: declared?.id ?? null,
    sourceSystem: envelope.sourceSystem,
    providerLabel: envelope.providerLabel,
    adapterId: ADAPTER_ID,
    formatVersion: envelope.formatVersion,
    importedAt,
    importedByUserId: user.id,
    payloadPath,
    payloadSha256: sha256Hex(rawBody),
    payloadBytes: rawBody.length,
    observationCount: planned.length,
    duplicateCount: duplicates.length,
    sourceMetadata: envelope.sourceMetadata,
    notes: strOrNull(options.notes, 1000),
  };
  interopRepo.insertImport(record);

  const observations: FieldObservation[] = [];
  for (const { obs, input } of planned) {
    if (!interopRepo.insertObservation(obs)) {
      // A concurrent import of the same record won the race: it is a duplicate.
      const existing = interopRepo.findObservationByDedupeKey(obs.dedupeKey);
      duplicates.push({ externalObservationId: obs.externalObservationId, existingObservationId: existing?.id ?? "unknown" });
      continue;
    }
    storePhotos(dirKey, obs, input);
    interopRepo.insertObservationEvent({
      id: repo.newId(), observationId: obs.id, occurredAt: importedAt, actorUserId: user.id,
      kind: "RECEIVED",
      detail: `received from ${obs.providerLabel ?? obs.sourceSystem} as external record ${obs.externalObservationId}` +
        `${obs.observedAt ? ` observed ${obs.observedAt}` : " (no source timestamp)"}; ${obs.photoCount} photo(s)`,
    });
    interopRepo.insertObservationEvent({
      id: repo.newId(), observationId: obs.id, occurredAt: importedAt, actorUserId: null,
      kind: "MATCHED",
      detail: `${obs.matchVerdict}: ${obs.matchReasons.join("; ")}`,
    });
    observations.push(obs);
  }

  repo.insertConfigAudit({
    id: repo.newId(),
    projectId: declared?.id ?? null,
    actorUserId: user.id,
    action: "FIELD_OBSERVATIONS_IMPORTED",
    entityType: "field_observation_import",
    entityId: importId,
    reason: record.notes,
    beforeSummary: null,
    afterSummary: `${observations.length} observation(s) from ${record.providerLabel ?? record.sourceSystem} (${duplicates.length} duplicate(s) skipped) · snapshot sha256 ${record.payloadSha256.slice(0, 16)}…`,
    createdAt: importedAt,
  });

  return {
    import: record,
    observations,
    duplicates,
    unmatched: observations.filter((o) => o.matchedProjectId === null).length,
  };
}

const EXT_BY_TYPE: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function storePhotos(dir: string, obs: FieldObservation, input: ImportObservationInput): void {
  input.photos.forEach((p, seq) => {
    let storedPath: string | null = null;
    let sha: string | null = null;
    if (p.bytes && p.sniffedType) {
      sha = sha256Hex(p.bytes);
      storedPath = interopKey(dir, `${sha}.${EXT_BY_TYPE[p.sniffedType]}`);
      const full = resolveInteropKey(storedPath);
      if (!fs.existsSync(full)) fs.writeFileSync(full, p.bytes, { flag: "wx" });
    }
    const photo: FieldObservationPhoto = {
      id: repo.newId(),
      observationId: obs.id,
      seq,
      fileName: p.fileName,
      contentType: p.sniffedType ?? p.contentType,
      sha256: sha,
      bytes: p.bytes ? p.bytes.length : null,
      storedPath,
      sourceUrl: p.sourceUrl,
      caption: p.caption,
      transferred: Boolean(p.bytes),
    };
    interopRepo.insertPhoto(photo);
  });
}
