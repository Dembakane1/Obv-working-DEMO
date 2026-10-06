/**
 * External field observation import format — provider-neutral, versioned,
 * deterministic.
 *
 * TWO ACCEPTED SHAPES
 *  1. The OBV import envelope ("obv-field-observation-import" v1.0): a
 *     list of observations in OBV's neutral vocabulary. Any field-data
 *     platform (KoBoToolbox, ODK, GEMS-style deployments, government
 *     collection apps) can be exported into it.
 *  2. A KoBoToolbox-style submissions export ("kobotoolbox-submissions"):
 *     the rows a KoBo/ODK JSON export produces (meta keys _id/_uuid/
 *     _submission_time/_geolocation/_attachments). It is translated
 *     deterministically into shape 1; the translation touches only the
 *     documented meta keys and keeps every other key verbatim as a form
 *     field. Attachments arrive as source URLs that OBV records and NEVER
 *     retrieves.
 *
 * Everything here is validation and normalization of caller-supplied
 * bytes: bounded sizes, explicit types, content sniffing for photos. No
 * network, no database.
 */
import type { FieldObservationSourceSystem } from "../../../../shared/types";
import { InteropError, isoOrNull, numOrNull, strOrNull } from "../core";

export const FIELD_OBSERVATION_FORMAT = "obv-field-observation-import";
export const FIELD_OBSERVATION_FORMAT_VERSION = "1.0";
export const KOBO_SUBMISSIONS_FORMAT = "kobotoolbox-submissions";
export const ADAPTER_ID = "obv-field-observation-import-v1";

export const IMPORT_LIMITS = {
  maxBodyBytes: 24 * 1024 * 1024,
  maxObservations: 200,
  maxPhotosPerObservation: 10,
  maxPhotoBytes: 6 * 1024 * 1024,
  minPhotoBytes: 64,
  maxFormFieldsJson: 64 * 1024,
  maxSourceMetadataJson: 16 * 1024,
  maxString: 2000,
  maxUrl: 2000,
} as const;

const SOURCE_SYSTEMS: readonly FieldObservationSourceSystem[] = ["KOBOTOOLBOX", "ODK", "GEMS_STYLE", "GENERIC"];

export interface ImportPhotoInput {
  fileName: string | null;
  contentType: string | null;
  /** Raw image bytes (decoded from base64), or null when only a URL came. */
  bytes: Buffer | null;
  sniffedType: "image/jpeg" | "image/png" | "image/webp" | null;
  sourceUrl: string | null;
  caption: string | null;
}

export interface ImportObservationInput {
  externalObservationId: string;
  projectReference: string | null;
  milestoneReference: string | null;
  collector: string | null;
  observedAt: string | null;
  observedAtVerbatim: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  formFields: Record<string, unknown>;
  comments: string | null;
  photos: ImportPhotoInput[];
  sourceMetadata: Record<string, unknown> | null;
  /** The verbatim source object this observation was normalized from. */
  verbatim: unknown;
}

export interface ImportEnvelope {
  format: string;
  formatVersion: string;
  sourceSystem: FieldObservationSourceSystem;
  providerLabel: string | null;
  projectReference: string | null;
  sourceMetadata: Record<string, unknown> | null;
  observations: ImportObservationInput[];
}

// ------------------------------------------------------------ sniffing

/** Magic-byte sniff for the raster types the evidence pipeline accepts. */
export function sniffImage(bytes: Buffer): ImportPhotoInput["sniffedType"] {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

// ------------------------------------------------------------ helpers

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function boundedJson(value: unknown, max: number, label: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new InteropError(`${label} must be a JSON object`);
  const text = JSON.stringify(value);
  if (text.length > max) throw new InteropError(`${label} exceeds ${max} bytes`);
  return value;
}

function httpUrlOrNull(value: unknown): string | null {
  const s = strOrNull(value, IMPORT_LIMITS.maxUrl);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return s;
  } catch {
    return null;
  }
}

function latOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n !== null && n >= -90 && n <= 90 ? n : null;
}
function lngOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n !== null && n >= -180 && n <= 180 ? n : null;
}

function parsePhoto(raw: unknown, where: string): ImportPhotoInput {
  if (!isObject(raw)) throw new InteropError(`${where}: each photo must be an object`);
  const sourceUrl = httpUrlOrNull(raw.sourceUrl);
  let bytes: Buffer | null = null;
  let sniffedType: ImportPhotoInput["sniffedType"] = null;
  if (typeof raw.base64 === "string" && raw.base64.length > 0) {
    const b64 = raw.base64.replace(/^data:[^;]+;base64,/, "");
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw new InteropError(`${where}: photo base64 payload is malformed`);
    bytes = Buffer.from(b64, "base64");
    if (bytes.length < IMPORT_LIMITS.minPhotoBytes) throw new InteropError(`${where}: photo payload is empty`);
    if (bytes.length > IMPORT_LIMITS.maxPhotoBytes) throw new InteropError(`${where}: photo exceeds ${IMPORT_LIMITS.maxPhotoBytes} bytes`, 413);
    sniffedType = sniffImage(bytes);
    if (!sniffedType) throw new InteropError(`${where}: photo bytes are not a JPEG, PNG or WebP image`);
    const declared = strOrNull(raw.contentType, 100)?.toLowerCase() ?? null;
    if (declared && declared !== sniffedType && !(declared === "image/jpg" && sniffedType === "image/jpeg")) {
      throw new InteropError(`${where}: declared content type ${declared} does not match the image bytes (${sniffedType})`);
    }
  }
  if (!bytes && !sourceUrl) {
    throw new InteropError(`${where}: a photo needs either base64 bytes or an http(s) sourceUrl`);
  }
  return {
    fileName: strOrNull(raw.fileName, 255),
    contentType: sniffedType ?? strOrNull(raw.contentType, 100),
    bytes,
    sniffedType,
    sourceUrl,
    caption: strOrNull(raw.caption, IMPORT_LIMITS.maxString),
  };
}

function parseObservation(raw: unknown, index: number, verbatim: unknown): ImportObservationInput {
  const where = `observations[${index}]`;
  if (!isObject(raw)) throw new InteropError(`${where} must be an object`);
  const externalObservationId = strOrNull(raw.externalObservationId, 200);
  if (!externalObservationId) throw new InteropError(`${where}: externalObservationId is required`);
  const photosRaw = raw.photos === undefined || raw.photos === null ? [] : raw.photos;
  if (!Array.isArray(photosRaw)) throw new InteropError(`${where}: photos must be an array`);
  if (photosRaw.length > IMPORT_LIMITS.maxPhotosPerObservation) {
    throw new InteropError(`${where}: at most ${IMPORT_LIMITS.maxPhotosPerObservation} photos per observation`);
  }
  const observedAtVerbatim = strOrNull(raw.observedAt, 100);
  return {
    externalObservationId,
    projectReference: strOrNull(raw.projectReference, 200),
    milestoneReference: strOrNull(raw.milestoneReference, 200),
    collector: strOrNull(raw.collector, 200),
    observedAt: isoOrNull(observedAtVerbatim),
    observedAtVerbatim,
    latitude: latOrNull(raw.latitude),
    longitude: lngOrNull(raw.longitude),
    accuracyMeters: (() => { const n = numOrNull(raw.accuracyMeters); return n !== null && n >= 0 ? n : null; })(),
    formFields: boundedJson(raw.formFields, IMPORT_LIMITS.maxFormFieldsJson, `${where}.formFields`) ?? {},
    comments: strOrNull(raw.comments, IMPORT_LIMITS.maxString),
    photos: photosRaw.map((p, j) => parsePhoto(p, `${where}.photos[${j}]`)),
    sourceMetadata: boundedJson(raw.sourceMetadata, IMPORT_LIMITS.maxSourceMetadataJson, `${where}.sourceMetadata`),
    verbatim,
  };
}

// ------------------------------------------------------------ envelope

/** Parse and validate a caller-supplied import body. Throws InteropError
 *  (400/413) with the exact offending path; never partially succeeds. */
export function parseImportEnvelope(body: unknown): ImportEnvelope {
  if (!isObject(body)) throw new InteropError("The import body must be a JSON object");
  const format = strOrNull(body.format, 100);
  if (format === KOBO_SUBMISSIONS_FORMAT) return parseImportEnvelope(fromKoboSubmissions(body));
  if (format !== FIELD_OBSERVATION_FORMAT) {
    throw new InteropError(`format must be "${FIELD_OBSERVATION_FORMAT}" or "${KOBO_SUBMISSIONS_FORMAT}"`);
  }
  const formatVersion = strOrNull(body.formatVersion, 20);
  if (formatVersion !== FIELD_OBSERVATION_FORMAT_VERSION) {
    throw new InteropError(`formatVersion must be "${FIELD_OBSERVATION_FORMAT_VERSION}"`);
  }
  const sourceSystem = String(body.sourceSystem ?? "").toUpperCase() as FieldObservationSourceSystem;
  if (!SOURCE_SYSTEMS.includes(sourceSystem)) {
    throw new InteropError(`sourceSystem must be one of ${SOURCE_SYSTEMS.join(", ")}`);
  }
  if (!Array.isArray(body.observations) || body.observations.length === 0) {
    throw new InteropError("observations must be a non-empty array");
  }
  if (body.observations.length > IMPORT_LIMITS.maxObservations) {
    throw new InteropError(`at most ${IMPORT_LIMITS.maxObservations} observations per import`, 413);
  }
  const verbatimList: unknown[] = Array.isArray(body.__verbatim) ? (body.__verbatim as unknown[]) : body.observations;
  const observations = body.observations.map((o, i) => parseObservation(o, i, verbatimList[i] ?? o));
  const ids = new Set<string>();
  for (const o of observations) {
    if (ids.has(o.externalObservationId)) {
      throw new InteropError(`externalObservationId "${o.externalObservationId}" appears more than once in this import`);
    }
    ids.add(o.externalObservationId);
  }
  return {
    format,
    formatVersion,
    sourceSystem,
    providerLabel: strOrNull(body.providerLabel, 120),
    projectReference: strOrNull(body.projectReference, 200),
    sourceMetadata: boundedJson(body.sourceMetadata, IMPORT_LIMITS.maxSourceMetadataJson, "sourceMetadata"),
    observations,
  };
}

// ------------------------------------------------------------ KoBo / ODK

/** Meta keys a KoBoToolbox / ODK JSON export carries beside form answers. */
const KOBO_META_KEYS = new Set([
  "_id", "_uuid", "_submission_time", "_geolocation", "_attachments", "_status", "_validation_status",
  "_submitted_by", "_xform_id_string", "_tags", "_notes", "_version_", "__version__", "_index",
  "formhub/uuid", "meta/instanceID", "meta/deprecatedID", "start", "end", "today", "deviceid",
  "username", "phonenumber", "subscriberid", "simserial",
]);
const KOBO_PROJECT_KEYS = ["project_reference", "project_code", "project_id", "project", "obv_project"];
const KOBO_MILESTONE_KEYS = ["milestone_reference", "milestone", "milestone_id", "obv_milestone"];
const KOBO_COMMENT_KEYS = ["comments", "comment", "notes", "remarks", "observations"];

/** Parse a KoBo/ODK geopoint string "lat lng [alt [accuracy]]". */
function parseGeopoint(value: unknown): { lat: number | null; lng: number | null; acc: number | null } {
  if (typeof value !== "string") return { lat: null, lng: null, acc: null };
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length < 2 || !parts.slice(0, 2).every(Number.isFinite)) return { lat: null, lng: null, acc: null };
  return { lat: parts[0], lng: parts[1], acc: parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : null };
}

/**
 * Deterministic translation of KoBoToolbox-style submission rows into the
 * OBV envelope. Only the documented meta keys are interpreted; every other
 * key is kept verbatim as a form field. Attachments become source URLs
 * (recorded, never retrieved). The original rows are preserved as the
 * verbatim snapshot.
 */
export function fromKoboSubmissions(body: Record<string, unknown>): Record<string, unknown> {
  const rows = body.submissions;
  if (!Array.isArray(rows) || rows.length === 0) throw new InteropError("submissions must be a non-empty array");
  if (rows.length > IMPORT_LIMITS.maxObservations) throw new InteropError(`at most ${IMPORT_LIMITS.maxObservations} submissions per import`, 413);
  const observations = rows.map((row, i) => {
    if (!isObject(row)) throw new InteropError(`submissions[${i}] must be an object`);
    const externalObservationId = strOrNull(row._uuid, 200) ?? strOrNull(row["meta/instanceID"], 200) ?? (row._id !== undefined ? String(row._id) : null);
    let lat: number | null = null;
    let lng: number | null = null;
    let acc: number | null = null;
    if (Array.isArray(row._geolocation) && row._geolocation.length >= 2) {
      // KoBo's _geolocation is [latitude, longitude].
      lat = latOrNull(row._geolocation[0]);
      lng = lngOrNull(row._geolocation[1]);
    }
    const formFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (KOBO_META_KEYS.has(k)) continue;
      formFields[k] = v;
      if (lat === null && lng === null && /geopoint|location|gps/i.test(k)) {
        const g = parseGeopoint(v);
        if (g.lat !== null && g.lng !== null) { lat = latOrNull(g.lat); lng = lngOrNull(g.lng); acc = g.acc; }
      }
    }
    const pick = (keys: string[]): string | null => {
      for (const k of keys) if (typeof row[k] === "string" && (row[k] as string).trim()) return row[k] as string;
      return null;
    };
    const attachments = Array.isArray(row._attachments) ? row._attachments : [];
    const photos = attachments
      .filter(isObject)
      .map((a) => ({
        fileName: typeof a.filename === "string" ? a.filename.split("/").pop() ?? null : null,
        contentType: typeof a.mimetype === "string" ? a.mimetype : null,
        sourceUrl: typeof a.download_url === "string" ? a.download_url : typeof a.download_large_url === "string" ? a.download_large_url : null,
      }))
      .filter((p) => p.sourceUrl);
    const sourceMetadata: Record<string, unknown> = {};
    for (const k of ["_id", "_uuid", "_status", "_validation_status", "_xform_id_string", "__version__", "_version_", "formhub/uuid", "meta/instanceID", "deviceid", "start", "end"]) {
      if (row[k] !== undefined) sourceMetadata[k] = row[k];
    }
    return {
      externalObservationId,
      projectReference: pick(KOBO_PROJECT_KEYS) ?? (typeof body.projectReference === "string" ? body.projectReference : null),
      milestoneReference: pick(KOBO_MILESTONE_KEYS),
      collector: strOrNull(row._submitted_by, 200) ?? strOrNull(row.username, 200),
      observedAt: strOrNull(row._submission_time, 100) ?? strOrNull(row.end, 100) ?? strOrNull(row.start, 100),
      latitude: lat,
      longitude: lng,
      accuracyMeters: acc,
      formFields,
      comments: pick(KOBO_COMMENT_KEYS),
      photos,
      sourceMetadata,
    };
  });
  return {
    format: FIELD_OBSERVATION_FORMAT,
    formatVersion: FIELD_OBSERVATION_FORMAT_VERSION,
    sourceSystem: typeof body.sourceSystem === "string" && SOURCE_SYSTEMS.includes(body.sourceSystem.toUpperCase() as FieldObservationSourceSystem)
      ? body.sourceSystem.toUpperCase()
      : "KOBOTOOLBOX",
    providerLabel: typeof body.providerLabel === "string" ? body.providerLabel : "KoBoToolbox",
    projectReference: typeof body.projectReference === "string" ? body.projectReference : null,
    sourceMetadata: isObject(body.sourceMetadata) ? body.sourceMetadata : { translatedFrom: KOBO_SUBMISSIONS_FORMAT },
    observations,
    __verbatim: rows,
  };
}
