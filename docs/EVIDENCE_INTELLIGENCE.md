# OBV Evidence Intelligence Platform

Turns OBV's authoritative evidence and document records into an
**explainable, advisory** review aid. It helps a reviewer answer three
questions — *Is this evidence complete and consistent? Does it resemble
prior evidence? Does it deserve closer human review?* — and never the
question *Is this automatically fraud?*

Two rules govern everything here:

1. **Evidence Intelligence consumes the record; it never authors it.**
   The layer writes only to its own advisory tables. It never approves a
   draw, rejects evidence, releases funds, changes project progress,
   creates an exception on its own, or overrides a lender decision. Every
   output is advisory. This is enforced statically by the test battery
   (no `INSERT/UPDATE/DELETE` against any authoritative table; no call to
   an evidence/verification/ledger/document/release write path) and
   proven at runtime (authoritative tables are byte-identical before and
   after analysis).
2. **Every finding is explainable.** No black-box score. Each advisory
   signal carries a plain-language explanation of *why it was generated*,
   *which records were compared*, a *confidence*, and a *recommended
   reviewer action*.

Only a human reviewer can turn an advisory finding into a governed
exception, and that promotion runs through the existing exceptions
service and its authorization — not through this layer.

## Architecture

```
services/evidenceIntel/
  core.ts        EvidenceIntelError, ADVISORY_NOTICE, role gates,
                 config (OCR provider + double-consent), subject
                 resolution, accessible-subject scoping, recordSignal
  metadata.ts    metadata facts + advisory metadata findings
  ocr.ts         provider-neutral OCR: deterministic mock (active) +
                 3 vendor boundaries; normalization + fingerprint
  detectors.ts   duplicate-file / cross-project / cross-contractor /
                 device-pattern / document-duplicate detectors
  scoring.ts     completeness / quality / confidence scoring (0–100)
  futureAi.ts    provider-neutral future-engine catalog (all disabled)
  analyze.ts     the analysis pass: derive → detect → record → enqueue
  review.ts      review queue, reviewer actions, evidence timeline
  dashboard.ts   viewer-scoped advisory dashboard aggregation
  analytics.ts   executive evidence analytics (extends Portfolio Intel)
  index.ts       facade re-exporting the public surface
db/evidenceIntelRepo.ts   all SQL; append-only signals + review events
http/evidenceIntelRoutes.ts + view/evidenceIntelPages.tsx   the UI
```

Advisory tables (all additive, none authoritative):
`evidence_analysis_runs`, `evidence_signals` (append-only, idempotent on
`signal_key`), `evidence_metadata_facts`, `ocr_extractions` + `ocr_fields`
(fingerprinted), `evidence_review_queue`, `evidence_review_events`
(append-only), and `evidence_ai_engines` (future-engine registry,
constrained `status = 'DISABLED'` at the database level).

## What it analyzes

Evidence Intelligence reuses the existing evidence pipeline and draw
documents — it never creates a parallel evidence store.

- **Evidence items** (photos with capture/upload times, GPS, device
  metadata, content hash) — the physical-progress record.
- **Draw documents** (invoices, pay applications, lien waivers, permits,
  inspection reports, and other administrative records) — never treated
  as verified physical progress.

## Evidence Intelligence Engine (duplicates)

Exact-content comparison over the evidence content hash, and OCR
fingerprint comparison over documents, all **strictly within one
organization and restricted to the projects the caller can see** (a
collision under a tenant the caller cannot access is never surfaced):

| Finding | Severity | Fires when |
| --- | --- | --- |
| `DUPLICATE_FILE` | LOW | Same content hash, same project |
| `CROSS_PROJECT_DUPLICATE` | MEDIUM | Same content hash, different project |
| `CROSS_CONTRACTOR_DUPLICATE` | HIGH | Same content hash, different contractor |
| `DUPLICATE_DEVICE_PATTERN` | INFO | Same capture device across contractors |
| `DUPLICATE_INVOICE` / `DUPLICATE_RECEIPT` / `DUPLICATE_PERMIT` / `DUPLICATE_LIEN_WAIVER` | HIGH | Identical document fingerprint (kind-specialized) |
| `REUSED_DOCUMENT` | HIGH | Identical document fingerprint (generic kind) |
| `DUPLICATE_INVOICE_NUMBER` | MEDIUM | Same invoice number on another document |
| `CONTRACTOR_NAME_CONFLICT` | MEDIUM | Shared invoice number, different vendor names |
| `TOTAL_INCONSISTENCY` | MEDIUM | Shared invoice number, different totals |
| `DUPLICATE_PERMIT` (by number) | LOW | Same permit number across documents |
| `PROJECT_REFERENCE_INCONSISTENCY` | LOW | Document's project ≠ its draw's project |

Every duplicate finding explains that re-use is sometimes legitimate
(shared subcontractor, one permit spanning several draws, a harmless
re-upload) and recommends a reviewer confirm rather than assume.

## Metadata Intelligence

`metadata.ts` derives per-item facts (content hash copied for comparison,
device fingerprint) and emits advisory findings from whatever metadata is
**present** — missing metadata is explicitly *not* treated as evidence of
fraud:

- `MISSING_METADATA` (INFO) — recorded for awareness, never an accusation.
- `TIMESTAMP_INCONSISTENCY` (MEDIUM) — capture time after upload time.
- `SUSPICIOUS_UPLOAD_TIMING` — a large capture-to-upload gap.
- `GPS_CONFLICT` — capture location outside the project's site boundary
  (point-in-polygon), when both a GPS fix and a boundary exist.

## OCR framework (provider-neutral)

`ocr.ts` defines a single `OcrProvider` interface with no vendor lock-in.
The active provider is a **deterministic mock** that derives typed fields
(contractor name, invoice/permit number, total, date, address, line item)
from a document's own recorded structured metadata, with stable
confidences — honest about being a stand-in, and stable enough to test.
Extracted text, fields, and per-field confidences are preserved verbatim.

Azure Document Intelligence, AWS Textract, and Google Document AI ship as
**disabled boundary adapters**: they exist so a production deployment
plugs credentials into exactly one place, but every vendor call refuses
in this build. A normalized, order-independent **fingerprint** over the
salient fields is the basis of the reused-document / duplicate-document
signals.

## Document Intelligence

Normalizes and compares invoice numbers, permit numbers, contractor
names, totals, and project references across a tenant's documents,
emitting the document-duplicate and consistency findings above. Each
finding names the specific documents it compared.

## Evidence Review Queue

Actionable findings (everything above INFO) are enqueued for reviewers;
INFO findings stay out of the actionable queue. The layer **does not**
create formal exceptions automatically. A reviewer may:

- **Acknowledge** — mark a finding seen (open → acknowledged).
- **Dismiss** — close an open/acknowledged finding with a note.
- **Promote** — turn a finding into a governed exception. Promotion
  delegates to `exceptions.createManualException` and its authorization
  (`canManageExceptions` + `canAccessProjectFinance`); a promoted finding
  can no longer be dismissed. Each queue transition appends an immutable
  `evidence_review_events` row.

## Evidence Timeline

A unified, chronological timeline for an evidence item — upload, review,
and the surrounding governed activity — so a reviewer can see the record
in order rather than as scattered rows.

## Executive analytics (extends Portfolio Intelligence)

`analytics.ts` derives, on read and viewer-scoped: documentation
completeness, average evidence quality and confidence, a duplicate-
evidence trend, a confidence trend, contractor evidence quality (never
labelled "fraudulent"), reviewer workload, and repeated advisory
categories. The **Executive command center** (`/executive`, Portfolio
Intelligence) surfaces a compact advisory *Evidence quality* band that
links into the full Evidence Intelligence analytics and review queue.

## Future AI boundaries

`futureAi.ts` publishes a provider-neutral catalog of seven future
capabilities — perceptual image hashing, computer vision, drone imagery,
satellite imagery, photogrammetry, volumetric analysis, and LiDAR — as
declared interfaces only. No placeholder algorithm pretends to perform
any of them: `engineEnabled()` is hard-`false`, activating an engine
refuses with a non-disclosing `404`, and the `evidence_ai_engines`
registry is constrained to `DISABLED` at the database level with no write
path anywhere in the codebase.

## Authorization & tenant isolation

Three viewer roles (funder rep, project manager, compliance reviewer) may
view Evidence Intelligence; the field role is refused (`403`). Every
read, analysis, and queue action is scoped by
`authz.accessibleProjectIds` — OBV's multi-participant tenancy source of
truth — and a subject the caller cannot see is a plain `404`
(indistinguishable from nonexistent). Cross-project and cross-contractor
duplicate peers are filtered to the caller's accessible projects, so
analysis never leaks the existence of another tenant's records.

## Configuration

Everything runs credential-free by default. Two optional environment
variables (see `.env.example`):

- `OBV_OCR_PROVIDER` — `mock` (default), or a vendor name to select a
  boundary adapter.
- `OBV_EVIDENCE_AI_PRODUCTION_ENABLE` — must be `true` to select any
  vendor OCR provider (a second explicit consent, mirroring the
  integrations/banking double-consent pattern). Startup refuses a vendor
  provider without it — and the vendor adapters refuse every call anyway.

## Testing

`scripts/evidence-intel-test.js` (registered in the standalone runner)
covers, across eleven sections: static advisory-only guards, duplicate
file/photo detection (same-project, cross-project, cross-contractor),
metadata analysis, OCR extraction and fingerprinting, document
intelligence (duplicate invoice number, identical-invoice content, reused
generic document), the review queue including guarded promote-to-
exception, authorization and tenant isolation (`403`, same-`404`,
cross-tenant scoping), the advisory-only guarantee (authoritative tables
byte-identical after analysis), append-only signal immutability,
future-AI disabled boundaries, and frontend rendering + HTTP
authorization.

## Known limitations

- The active OCR provider is a deterministic stand-in that reads a
  document's recorded metadata rather than real file bytes; vendor OCR is
  a disabled boundary. Fingerprint-based duplicate detection is therefore
  honest about comparing derived fields, not pixels.
- Perceptual/CV/drone/satellite/LiDAR analysis is interface-only by
  design; no such algorithm runs in this build.
- Findings are advisory aids for human reviewers and are never a control
  decision.
