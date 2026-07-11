# Lender Draw Verification Package — schema & runbook

One standardized, downloadable record of a specific draw decision and
the evidence supporting it. The package ASSEMBLES authoritative records
only — draw lines and their formal reviews, linked governed evidence
(never re-verified), the document checklist (upload ≠ acceptance), the
exception register, the formal ApprovalRequest history and the
VirtualAccountService event stream. Nothing in this module can create
evidence, approvals, ledger entries or release state; it does not weaken
the Draw Review Summary, Funder Verification Report or Project Audit
Package — it composes them.

## Package schema (standalone ZIP)

```
manifest.json                       hashed file inventory + manifest hash
draw-verification-package.pdf       lender document (printable HTML when no renderer)
draw-summary.json                   ids, all amounts, methodology, relationships
draw-line-items.csv                 line register with formal review decisions
budget-lines.csv                    affected budget lines with cumulative figures
budget-vs-progress.csv              financial vs verified physical, per line
evidence-register.csv               timestamped, hash-anchored evidence rows
reviewer-register.csv               attributable identity per formal review action
permit-inspection-register.csv      precise permit / gov-inspection states
invoice-lien-waiver-register.csv    invoices + lien waivers, review states
exception-register.csv              draw-relevant exceptions with SLA state
approval-history.csv                formal decisions only
retainage-register.csv              draw + project retainage position
release-events.csv                  exactly-once financial transitions
integrity-summary.json              ledger state + reconciliation basis
```

`draw-summary.json` preserves relationships through stable internal IDs
(line items, evidence items, approval request, exceptions, account and
retainage events). Every CSV value reconciles to the PDF and the
database (proven by test).

## PDF structure (sections A–N)

A cover & draw decision summary · B financial summary (cumulative) ·
C approved scope & budget-line detail · D draw-line review register ·
E budget vs verified progress · F timestamped evidence register ·
G inspector/reviewer attestations · H permit & government-inspection
status · I invoice & lien-waiver status · J discrepancies & unresolved
exceptions · K approval history · L retainage & release state · M ledger
& package-integrity summary · N methodology & limitations.

The first two pages answer directly: how much was requested, how much is
supported, what remains disputed or missing, who reviewed it, what
approvals remain, what amount is retained, what was released, and
whether critical integrity findings are present.

## Cumulative amount methodology

- **Current Draw Requested** — the borrower's requested amount
  (authorizes nothing).
- **Current Draw Supported** — Σ of formal line reviews: SUPPORTED at
  requested value, PARTIALLY_SUPPORTED at the reviewer-recorded amount,
  EXCEPTION/REJECTED/PENDING at zero. Advisory.
- **Current Draw Exception** — requested − supported.
- **Gross Governed Amount** — `approvedAmount` once governance
  concluded; before that the reviewer-finalized advisory recommendation,
  labelled `RECOMMENDED_ADVISORY`; `NOT_FINALIZED` before that. Never
  merged with requested/supported.
- **Retainage Withheld / Net Release Eligible / Net Released** —
  policy-computed withholding; gross − retainage; and the exactly-once
  VirtualAccountService release event (0 when none).
- **Cumulative Requested/Supported/Approved/Released** — submitted,
  non-cancelled draws with drawNumber ≤ this draw.
- **Remaining Available Budget** — current contract value (original +
  approved change orders) − cumulative gross approved.
- **Balance to finish (per budget line)** — current budget − previously
  paid − cumulative requested (conservative). Per-line approved/released
  amounts are explicitly NOT ALLOCATED PER LINE — governance operates at
  draw level.

## Evidence traceability

Each linked evidence item carries capture/submission/upload timestamps,
GPS state, metadata integrity state (DEVICE_CAPTURE / DEMO_FALLBACK),
verification verdict + confidence + provenance + policy version, ledger
sequence, content hash and a protected application reference. Media
follows the audit-package media policy (hashes + references; raw media
only via the authorized audit-package opt-in). Missing capture data is
NOT AVAILABLE — never invented.

## Reviewer identity handling

`reviewer-register.csv` contains one row per FORMAL record, with
distinct capacities: EVIDENCE SUBMITTER (capture pipeline), FIELD
INSPECTOR (inspection-report documents; a prominent
`NO FORMAL INSPECTION RECORD` flag when none), DOCUMENT REVIEWER,
DRAW LINE REVIEWER, DRAW REVIEWER (ADVISORY RECOMMENDATION) and FORMAL
APPROVER. Communication participants never appear — only formal review
records are read.

## Permits & government inspections

Derived from the draw's configured document checklist plus authoritative
document review records, using precise states: ACCEPTED, RECEIVED —
PENDING REVIEW (an upload is never acceptance), REJECTED, EXPIRED,
MISSING, NOT YET RECORDED (inspections), NOT REQUIRED under current
project configuration, NOT AVAILABLE. Documents carry issuing authority,
reference number, inspection date/result and expiry where recorded
(additive `draw_documents` metadata columns).

## Invoices & lien waivers

One register: document id/type, invoice number, vendor, amount, related
line item and budget line, received date, review state, accept/reject
date, reviewer, deficiency reason; lien waivers add
conditional/unconditional kind, partial/final scope, covered
amount/period, expiry. A missing or unusable REQUIRED lien waiver is
flagged prominently on the document and in `draw-summary.json`
(`missingRequiredLienWaiver`).

## Exceptions & discrepancies

The exception register includes draw-linked exceptions (any status, as
history) plus unresolved project exceptions touching the draw's
milestones/budget lines or INTEGRITY, each with age, due date and SLA
state. A separate discrepancy summary (claimed vs verified, requested vs
supported, unsupported lines, unapproved change costs, missing
documents, open HIGH/CRITICAL issues, open clarifications, approval
delays, integrity findings) references the single underlying source
condition — the same condition is never counted as multiple unrelated
discrepancies.

## Approval history

REVIEW RECOMMENDATION (advisory), FORMAL APPROVAL (ApprovalRecords with
approver identity, organization, role, decision, timestamp, sequence,
required roles and matrix/config version) and FINANCIAL RELEASE STATE
(exactly-once release events) are presented as three distinct layers.
Chat messages can never appear as approvals.

## Audit Package integration

Every Project Audit Package now embeds, per draw, the full verification
sub-package under `04_draws/DRAW-nnn/` (lender document + all
registers). Each file is listed in the audit `manifest.json` with path,
byte size, sha256, kind, record count and schema version. A sub-package
that cannot be assembled becomes an honest availability WARNING finding.

## Generation, access & storage

- Draw detail → Governance tab → **Lender Draw Verification Package**
  (Preview document / Generate Verification Package). API:
  `POST /api/draws/:id/verification-package`,
  `GET /draw/:id/verification-package/preview`.
- Stored in the report registry (`reportType: DRAW_VERIFICATION_PACKAGE`,
  a write-once ZIP under the reports storage root) and listed on the
  Reports page.
- Generation, preview and download require FUNDER_REP / PROJECT_MANAGER /
  COMPLIANCE_REVIEWER with draw tenant access (cross-tenant → 404,
  FIELD → 403). Never included: chat transcripts, WhatsApp media,
  communication attachments, provider secrets, signed URLs, tokens.

## Tests

`scripts/drawpackage-test.js` — 27 checkpoints covering the 21 required
cases on an isolated server (:3188): budget/contract reconciliation,
current + cumulative amount reconciliation and distinctness, evidence
timestamp fidelity and NOT AVAILABLE states, reviewer identity fidelity
and submitter/inspector separation, truthful permit states and
upload≠acceptance, invoice reconciliation, prominent missing lien
waiver, exception inclusion/exclusion, approval history fidelity,
chat-never-approves, document totals = CSV/JSON = database, manifest
hash recomputation, audit-package embedding, tenant isolation and the
secret-leakage scan.
