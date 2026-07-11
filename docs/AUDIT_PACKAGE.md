# Project Audit Package — architecture & runbook

One-click, auditor/funder/regulator-ready export of a project's complete
evidence and governance record. The package ASSEMBLES and REFERENCES the
governed sources — configuration snapshots, the Evidence Ledger,
verification results, approvals, draws, budget, exceptions, change
orders, retainage, and generated reports. It never rewrites them, never
creates evidence, approvals, ledger entries or release state, and never
weakens an existing control.

## Model

`AuditPackage`: id, organizationId, projectId, `packageVersion`
(monotonic per project, UNIQUE), requestedBy/requestedAt, status
(`QUEUED → GENERATING → READY | FAILED`; `SUPERSEDED` when a newer
version is generated), `asOfTimestamp` (the consistent audit point),
`configurationVersion`, `ledgerIntegrityState` (`INTACT` /
`TAMPERED_AT:<seq>`), `integrityState` (`CLEAN` / `WARNINGS` /
`NOT_EVALUATED` — READY never silently implies clean), `manifestHash`,
`storageObjectKey`, completedAt, failureCategory, options snapshot
(includeReports, includeCommMetadata), fileCount, sizeBytes.

## Folder schema (ZIP)

```
manifest.json
00_project_summary/  project-summary.pdf (or .html when no renderer) · project-config.json
01_configuration/    configuration-snapshots.json · configuration-audit.csv
                     approval-matrix.csv · verification-policy.json
02_milestones/       milestone-register.csv · evidence-requirements.csv
03_evidence/         evidence-register.csv · verification-register.csv
                     provenance-register.csv · ledger-references.csv
04_draws/            draw-register.csv · draw-line-items.csv · draw-report-index.csv
05_budget/           budget-register.csv · budget-vs-progress.csv
06_exceptions/       exception-register.csv · field-issues.csv · clarifications.csv
07_governance/       approval-requests.csv · approval-records.csv · approval-timeline.csv
08_financial_state/  tranche-state-register.csv · release-events.csv · retainage-register.csv
09_change_orders/    change-order-register.csv
10_integrity/        ledger-integrity-report.json · configuration-hash-validation.json
                     object-hash-validation.json
11_reports/          report-index.csv · files/<reportId>__<filename> (when included)
12_communications_metadata/ comm-metadata-summary.json (opt-in, counts only)
```

Sections appear only when applicable (a project without draws has no
`04_draws/`). The ZIP uses the STORE method (zero-dependency writer;
transparent, hash-friendly, small registers).

## Manifest schema

`manifest.json` (schemaVersion 1): kind `OBV_AUDIT_PACKAGE`, packageId +
packageVersion, project {id, name, location}, organization, generatedAt,
generatedBy {id, name, role}, asOfTimestamp, configurationVersion,
options (includeReports / includeCommMetadata / includeEvidenceMedia:
false / includeCommTranscripts: false), includedSections, recordCounts
(per register file), integrity block (ledger, configuration snapshots,
duplicate releases, approval consistency, evidence objects, warnings,
overall), coverSummaryFormat, notes, fileInventory `[{path, bytes,
sha256}]`, and `manifestHash` — sha256 over the manifest serialized with
`manifestHash: null`, so any verifier can recompute it. No secrets, no
tokens, no environment values.

## As-of consistency

`asOfTimestamp` defaults to generation time; an authorized user may pass
a historical timestamp (future timestamps are refused). Every register
with record timestamps (evidence, verifications, ledger, approvals and
decisions, draws, exceptions, issues, clarifications, change orders,
financial events, configuration audit, snapshots, reports) excludes
records after the audit point. Current-state registers (milestones,
budget lines, retainage position) reflect state at generation and the
manifest says so in `notes`.

## Evidence register

One row per evidence item: id, milestone, requirement text, submitted
by/at, capture-metadata state (`DEVICE_CAPTURE` / `DEMO_FALLBACK`), GPS
state (coords or `NO_FIX`), verification verdict + confidence +
provenance (`LIVE_AI` / `MOCK_*`) + policy version, ledger sequence,
evidence content hash, approval request + status, fund state, and a
protected application reference (`/evidence/:id`). Evidence media is NOT
copied into the package — the register carries content hashes and
references; media inclusion is reserved as a future explicit,
authorized option.

## Integrity validation (before READY)

1. **Evidence Ledger chain** — recomputed from genesis over every entry.
2. **Configuration snapshot hashes** — sha256 recomputed per snapshot.
3. **Duplicate-release checks** — milestone tranches, draw releases,
   retainage releases must each have at most one RELEASED event.
4. **Approval consistency** — one decision per role per request; an
   APPROVED request must hold an APPROVED record from every required
   role.
5. **Evidence object existence** — each item's stored object checked on
   locally accessible storage (worm/uploads/demo paths).
6. **Manifest file hashes** — sha256 per file, embedded in the manifest.

Any finding → the package still completes but carries
`integrityState: WARNINGS`, the manifest lists every warning, the cover
summary shows **READY WITH INTEGRITY WARNING**, and the register chip
reads `READY — INTEGRITY WARNING`. Failures are never hidden and never
silently "clean".

## Access control & audit

Generation, listing, status and download require FUNDER_REP,
PROJECT_MANAGER or COMPLIANCE_REVIEWER (FIELD → 403) AND project-finance
tenant access (cross-tenant → 404, existence not disclosed). Every
generation, failure and download writes a configuration-audit event
(`AUDIT_PACKAGE_GENERATED` / `AUDIT_PACKAGE_FAILED` /
`AUDIT_PACKAGE_DOWNLOADED`).

## Versioning & storage

Regeneration creates a new `packageVersion`; the previous READY package
becomes `SUPERSEDED` but its ZIP is retained and remains downloadable,
byte-identical (retention policy: keep prior versions; demo reset purges
demo-project packages). ZIPs are written once (`wx` flag) under
`DATA_DIR/audit-packages/<packageId>/` and never rewritten — packages
are immutable after READY. `storageObjectKey` is the data-root-relative
key, ready to map onto object storage in a hosted deployment.

## What is never included

- Secrets, environment values, provider tokens, webhook URLs
- Invitation tokens or token hashes
- Communication transcripts or message bodies (metadata COUNTS are an
  explicit opt-in: threads/messages counts only)
- Evidence media bytes (hashes + protected references instead)

## API

```
POST /api/projects/:id/audit-packages     generate {asOf?, includeReports?, includeCommMetadata?}
GET  /api/projects/:id/audit-packages     list (tenant+role gated)
GET  /api/audit-packages/:id              status
GET  /audit-packages/:id/download         ZIP download (audited)
```

UI: Reports page → "Project Audit Package" panel (as-of picker, include
options, transcripts always excluded) + audit package register with
status/integrity chips and downloads. OBV Intelligence offers at most
one INFO-level pointer ("Generate an audit package") when governed
releases exist and no READY package covers the current configuration
version — a pointer, never an audit conclusion.

## Tests

`scripts/auditpackage-test.js` — 30 checkpoints covering the 20 required
cases on an isolated server (:3186), including hash recomputation of
every file and the manifest, secret/token/transcript leakage scans with
planted secrets, cross-tenant + role blocks, immutability across
regeneration, retention of superseded versions, as-of exclusion, and
honest representation of a tampered ledger.

## Audit demo flow

1. Sign in as Margaret (funder) → Reports → Project Audit Package →
   Generate Audit Package (leave as-of blank).
2. The register shows v1 READY · CLEAN · ledger intact → Download ZIP.
3. Open `00_project_summary/project-summary.pdf` — the auditor cover:
   controlled/released/held, retainage, verified milestones, open
   exceptions, approvals, change orders, integrity, package id.
4. Open `manifest.json` — recompute any file's sha256 to verify.
5. Walk the registers: `03_evidence` (hashes + ledger references),
   `07_governance` (who approved what), `08_financial_state`
   (exactly-once releases), `09_change_orders`, `10_integrity`.
6. Regenerate → v2 READY, v1 SUPERSEDED yet still downloadable.
7. (Dev demo) tamper a ledger row and regenerate → READY WITH INTEGRITY
   WARNING, ledger `TAMPERED_AT:<seq>` — the package never claims clean.
