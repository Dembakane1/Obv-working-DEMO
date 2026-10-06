# Infrastructure Interoperability v1

**OC4IDS = standardized infrastructure disclosure. OBV = verification,
provenance, review and financial control.**

Infrastructure Interoperability is a strictly additive module. It lets OBV
(1) publish a project as an OC4IDS (Open Contracting for Infrastructure
Data Standard) record built only from authoritative OBV data, and (2) take
in field observations collected by an external system (KoBoToolbox-style
forms, ODK, GEMS-style monitoring exports) without ever treating them as
verified. It is not a separate government product, not a live integration
with any external platform, and implies no partnership with the World
Bank, AfDB, GEMS or any provider.

Code: `src/server/services/interop/**`, `src/server/db/interopRepo.ts`,
`src/server/http/interopRoutes.ts`, `src/server/view/interopPages.tsx`.
Tests: `scripts/interop-test.js` (registered in `npm test`).

---

## 1. Where it lives in the product

The existing project workspace gains one tab, **Infrastructure Data**
(`/project/:id/infrastructure-data`). There is no new top-level navigation
section.

| Route | Purpose |
|---|---|
| `/project/:id/infrastructure-data` | Overview: OC4IDS status, schema version, last export, field coverage, unverified observations, provider boundaries |
| `/project/:id/infrastructure-data/oc4ids` | OC4IDS preview: populated values with their OBV source, omitted fields with reasons, validation problems, export history, Export JSON |
| `/project/:id/infrastructure-data/observations` | External Field Observations: import, list, status |
| `/interop/field-observations/:id` | One observation: imported record (unverified), OBV project record, matching, photos, reviewer decision |

Status values shown for the OC4IDS export:

| Status | Meaning |
|---|---|
| Ready | Validates against the implemented schema and every core disclosure field is populated from OBV records |
| Incomplete | Validates, but one or more core fields have no authoritative OBV source and are omitted |
| Not configured | The deployment has no registered OC4IDS project-id prefix; nothing can be published |
| Invalid | The mapped record fails validation; export is refused |

An export is never called valid unless the validator returned no errors.

## 2. OC4IDS export

### Schema and validation

* Version: **OC4IDS 0.9.5** project schema and package schema (package
  version `0.9`).
* The schema is **vendored as an explicit subset** in
  `oc4ids/schema.ts`; outbound network access to the standard's schema
  host was not available when this was built. The coverage statement is
  exported as `OC4IDS_SCHEMA_COVERAGE` and shown in the UI and the
  validation report: "A READY export is valid against the implemented
  subset; it has not been checked by the standard's own online validator."
* Not implemented: forecasts, metrics, transactions, lobbyingMeetings,
  social, environment, benefits, costMeasurements, assetLifetime, phase
  periods, budgetBreakdowns, language, policyAlignment.
* The validator (`oc4ids/validate.ts`) is hand-written (zero runtime
  dependencies) and implements the JSON-Schema draft-04 keywords the subset
  uses. Closed codelists are errors; open codelists produce warnings.

### Mapping (`oc4ids/mapping.ts`, mapping version `1.0.0`)

Every populated value records its OBV source (`table`, `recordId`,
`field`). Every unsupported field is omitted with a reason code:
`NOT_CONFIGURED`, `VALUE_ABSENT`, `NO_AUTHORITATIVE_SOURCE`,
`NOT_REPRESENTABLE`. Nothing is inferred to make an export look complete.

| OC4IDS field | OBV source | Rule |
|---|---|---|
| `id` | `projects.id` | Registered prefix (`OBV_OC4IDS_PROJECT_ID_PREFIX`) + OBV id; omitted when not configured |
| `title`, `description` | `projects.name`, `projects.description` | Verbatim |
| `status` | `projects.status` | DRAFT→preparation, ACTIVE→implementation, COMPLETED→completed; SUSPENDED omitted (no code) |
| `updated` | latest `config_audit` row for the project, else `launched_at` | Interoperability's own audit rows are excluded |
| `period.startDate/endDate` | `planned_start`, `planned_end` | Calendar date stated at 00:00:00Z |
| `sector` | pilot `category` | ROAD→transport.road, BRIDGE→transport, SCHOOL→education, CLINIC→health, WATER→waterAndWaste, ENERGY→energy; BUILDING / OTHER omitted |
| `locations` | `location`, `site_boundary`, country/region/locality, ROUTE spatial feature | Polygon only for a closed ring; LineString for a recorded route |
| `budget.amount` | `total_budget` + project (or owner) currency | Omitted when zero |
| `parties` | owner org, implementing agency, contractor, funder, party assignments, loan lender/contractor | Roles: publicAuthority, procuringEntity, supplier, funder only |
| `publicAuthority` | party with the publicAuthority role | A public-sector owner, or a recorded GOVERNMENT_AUTHORITY party. An implementing agency is the procuring entity, not automatically the owner |
| `milestones` | `milestones` | id, title, requirement as description, planned end as due date; status `met` only after human approval (VERIFIED stays `scheduled`); `dateMet` from the final approval record |
| `contractingProcesses[0]` | contractor organization(s), approved change orders | Suppliers and modifications (id, date applied, description, rationale, type) |

**Omitted because OBV holds no authoritative record:** `type`, `purpose`,
`additionalClassifications`, `completion`, `relatedProjects`,
`budget.approvalDate`, contract value, contract period, contracting
process status and nature, tender, `newContractValue` on modifications,
the supervising engineer's role, milestone due dates without a planned
end.

**Omitted because the OBV record is not disclosure data:** `documents`
and contract documents (pay applications, invoices, lien waivers, reports
and audit packages are tenant-gated financial-control artifacts).

### What never enters an export

Evidence Integrity Score, advisory signals and authenticity findings,
duplicate detection, OCR findings, GPS consistency, official-source
verification provenance, evidence and ledger hashes, reviewer history,
draw readiness, lender decisions, release controls and payment
authorization, Digital Twin state. The list is shown on every preview and
is asserted by the test suite.

### Export provenance

`POST /api/interop/oc4ids/:projectId/export` (project manager or funder
representative):

1. rebuilds the preview, refuses `NOT_CONFIGURED` and `INVALID` (409);
2. validates the complete package again at publication time;
3. writes the bytes write-once to `interop/exports/oc4ids-<id>.json`
   under the data root (the record stores this **logical key**, never an
   absolute path);
4. appends an `interop_exports` row: tenant, project, exporting user,
   timestamp, schema and mapping versions, project config version, canonical
   project hash, payload SHA-256, the OBV source records and their versions,
   field counts, validation counts;
5. audits `OC4IDS_EXPORT_CREATED`.

The project is never mutated. `GET /api/interop/oc4ids/exports/:id`
re-hashes the stored bytes on every read and refuses with 409 if they no
longer match the record. Historical exports stay reproducible byte for
byte.

## 3. External Field Observation adapter

### Flow

```
external dataset (JSON envelope or KoBo-style rows)
  -> immutable snapshot   interop/imports/<importId>/snapshot.json (write-once, hashed)
  -> normalized candidate  field_observations, status UNVERIFIED
  -> project matching      declared project / exact reference / NO_MATCH / AMBIGUOUS
  -> reviewer decision     accept | reject | defer   (assign project = matching step)
  -> existing evidence pipeline  processEvidenceSubmission (the only path)
  -> Evidence Intelligence  advisory analysis under the same rules
```

### Import formats (deterministic, no live provider)

* `obv-field-observation-import` v1.0: `sourceSystem` (KOBOTOOLBOX, ODK,
  GEMS_STYLE, GENERIC), optional `providerLabel`, `projectReference`,
  `sourceMetadata`, and `observations[]` with `externalObservationId`,
  `projectReference`, `milestoneReference`, `collector`, `observedAt`,
  `latitude`, `longitude`, `accuracyMeters`, `photos[]` (`base64` bytes or
  `sourceUrl`, `contentType`, `fileName`, `caption`), `formFields`,
  `comments`, `sourceMetadata`.
* `kobotoolbox-submissions`: KoBoToolbox-style JSON rows (`_uuid`, `_id`,
  `_submission_time`, `_geolocation`, `_attachments`, form answers),
  translated deterministically; unknown keys are kept as form fields.

`POST /api/interop/field-observations/import` (project manager or funder
representative), JSON body, optional `?projectId=` to declare the target.

### Limits and validation

| Limit | Value |
|---|---|
| Request body | 24 MiB |
| Observations per import | 200 |
| Photos per observation | 10 |
| Photo size | 64 bytes to 6 MiB |
| Form fields JSON | 64 KiB |
| Source metadata JSON | 16 KiB |

Photos are accepted only when the bytes are JPEG, PNG or WebP by magic
number; a declared type that contradicts the bytes is refused. Coordinates
outside valid ranges are dropped, never clamped. Timestamps without a
timezone are kept verbatim and not assigned one. Re-importing the same
records is idempotent (deduplicated by organization, source system,
external id and record hash).

**Source URLs are recorded and never fetched.** The module performs no
network egress at all, so there is no SSRF surface; an observation whose
only photo is a URL cannot become evidence.

### No automatic verification

Every observation enters as **External Observation — Unverified**.
Importing writes only the six interoperability tables. Nothing in the
module can approve evidence or a milestone, mark progress complete,
approve a draw, clear an exception, satisfy an inspection, authorize
payment or release funds. The static guards in the test suite assert the
module references none of those commands and writes no authoritative
table.

Acceptance (funder representative or compliance reviewer) calls the
existing `processEvidenceSubmission` with the source photo, the source
coordinates (or none), the **source** observation time as `capturedAt`
and device metadata that names the external source. The pipeline issues
its own verdict. The accepting reviewer is recorded as the evidence
submitter, so separation of duties bars them from approving that
milestone. After the pipeline, the existing draw-readiness hook runs and
Evidence Intelligence analyzes the new item (advisory, failure-tolerant).

Assigning a project to an unmatched observation is a matching step that
the importer or a reviewer may perform; it never changes the unverified
status. Unmatched observations are visible only to the importing
organization until assigned.

### Provenance (`evidence_provenance`)

Insert-only row per accepted evidence item: origin
`EXTERNAL_FIELD_OBSERVATION`, observation and import ids, source system,
provider label, external id, collector, source timestamp, source
coordinates and accuracy, source record hash, accepting user and time.
With the observation (ingestion time, normalized fields, source metadata)
and the import (snapshot hash) it forms a complete chain back to the
original bytes. OBV never rewrites external provenance as an OBV capture.

### Where the source is shown

* Evidence panels (milestone and draw pages), the Evidence Intelligence
  evidence page and timeline: "Source: External Field Observation ·
  Provider: KoBoToolbox" or "Source: OBV Capture".
* Project Timeline: "External field observation received", "reviewed",
  "accepted as evidence" (visible to the roles that may use the area), and
  the evidence capture event states its external source.
* Digital Twin: an accepted observation with real coordinates becomes a
  normal evidence pin whose detail names the external source. Evidence
  without source coordinates gets no pin; coordinates are never
  manufactured.

### Provider boundaries

KoBoToolbox API, ODK Central, government procurement portals and
development-bank monitoring systems are declared and report **Not
Connected** (`GET /api/interop/providers`). No credentials exist for them.

## 4. Security and authorization

| Action | Roles | Tenant rule |
|---|---|---|
| View area, preview, validation report, export history | PM, funder rep, compliance reviewer | Same 404 for foreign and missing projects |
| Create export | PM, funder rep | Same 404 |
| Import observations | PM, funder rep | Matching limited to projects the importer can see |
| Accept / reject / defer | Funder rep, compliance reviewer | Same 404; milestone must belong to the matched project |
| Assign project | Importer or reviewer roles | Target project must be visible to the caller |

The FIELD role gets 403 on the area. Role checks run before any project
lookup. `InteropError` is registered with the central error handler so
404s stay 404s. Downloads are served as attachments with `nosniff` and are
re-hashed on read. Photo bytes are re-hashed on every read. The interop
data directory is never served statically. Exports, imports, observation
events and evidence provenance are append-only; observation status changes
are guarded single-transition updates (409 on a repeat). No secret is
introduced; the three configuration variables below are public settings
and never reach the frontend.

## 5. Database additions (additive)

| Table | Purpose |
|---|---|
| `interop_exports` | Append-only OC4IDS export provenance records |
| `field_observation_imports` | One row per import: source system, adapter, snapshot key and hash |
| `field_observations` | Normalized observations, match verdict, status, decision |
| `field_observation_photos` | Photo metadata, hash, logical storage key or recorded source URL |
| `field_observation_events` | Append-only observation event trail |
| `evidence_provenance` | Insert-only link from an evidence item to its external origin |

Files live under `<data root>/interop/` (`exports/`, `imports/<id>/`).
Include this directory with `worm/`, `uploads/`, `reports/` and
`audit-packages/` when copying artifacts during a restore.

## 6. Configuration

```
OBV_OC4IDS_PROJECT_ID_PREFIX=oc4ids-xxxxxx   # registered prefix; unset = Not configured
OBV_OC4IDS_LICENSE_URL=                      # optional, published in the package
OBV_OC4IDS_PUBLICATION_POLICY_URL=           # optional, published in the package
```

## 7. Known limitations

* Validation uses a vendored subset of OC4IDS 0.9.5, not the official
  schema files or the standard's online validator.
* OBV holds no contract value, tender, project type, purpose, completion
  or public documents, so a typical export is Incomplete until a public
  authority is recorded and those fields remain omitted by design.
* Import is a deterministic file adapter. No provider API is connected and
  source photo URLs are never retrieved.
* Only JPEG, PNG and WebP photos can become evidence; other attachments
  are recorded only.
* The publisher name is the exporting user's organization.
