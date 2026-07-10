# Unified Exception Management — model & runbook

One governed operational register for anything preventing clean
progression of a project, milestone, draw, evidence package, approval,
document set, schedule, or integrity state.

## Core principle

An Exception is a **control record that references a source problem**.
The underlying source record (verification verdict, field issue,
clarification, approval request, draw document checklist, budget
variance, ledger integrity state, integration binding) remains
authoritative. Exceptions never duplicate or rewrite that truth, waivers
never touch the source, and **no exception action can release money** —
the exceptions module has no code path to the VirtualAccountService or
the approval workflow (proven by test).

## Model

`ObvException`: org/project (+ optional milestone, draw, budget line),
sourceType + sourceId + **sourceKey** (deterministic idempotency key,
UNIQUE at the database level), category (EVIDENCE, DOCUMENT, LOCATION,
METADATA, QUALITY, MATERIAL, COST, SCHEDULE, APPROVAL, CLARIFICATION,
INTEGRITY, INTEGRATION, OTHER), severity (LOW→CRITICAL), status (OPEN,
ACKNOWLEDGED, IN_PROGRESS, AWAITING_RESPONSE, RESOLVED, CLOSED, WAIVED),
owner, dueAt, opened/acknowledged/resolved timestamps, resolution
summary/type, audit fields. `ExceptionEvent` is the operational timeline
(CREATED, ACKNOWLEDGED, ASSIGNED, STATUS_CHANGED, COMMENT,
RESPONSE_REQUESTED, SOURCE_UPDATED, RESOLVED, REOPENED, WAIVED, CLOSED)
— an administrative record, never merged with the Evidence Ledger.

## Deterministic auto-creation rules (idempotent)

| Rule key | Severity | Condition |
| --- | --- | --- |
| `evidence-rejected` | HIGH | Latest evidence for an active milestone REJECTED by verification |
| `evidence-review` | MEDIUM | Latest evidence NEEDS_REVIEW, milestone awaiting reviewer |
| `ledger-integrity` | CRITICAL | Evidence Ledger hash chain failed verification |
| `approval-delay` | MEDIUM | Approval pending beyond `OBV_EXC_APPROVAL_SLA_HOURS` (48h default) |
| `budget-variance` | HIGH/MEDIUM | Financial progress materially ahead of verified physical progress (HIGH beyond 2× watch threshold) |
| `draw-doc-missing` | MEDIUM | Required draw document missing while the draw is in review |
| `field-issue` | mirrors issue | Open HIGH/CRITICAL field issue |
| `clarification-overdue` | MEDIUM | Clarification past due or open >3 days |
| `integration-binding` | MEDIUM | Teams binding degraded / permissions required |

The sweep (`evaluateExceptions`, run on register/overview/intelligence
views and via `POST /api/exceptions/evaluate`) is convergent: an open
exception is never duplicated; a cleared condition auto-resolves the
exception (`SOURCE_CLEARED`, with `SOURCE_UPDATED` + `RESOLVED` timeline
events); a recurring condition reopens a resolved/closed exception
(`REOPENED`); a WAIVED exception is never reopened by the sweep — the
waiver stands as the formal record.

## Source reconciliation (resolution rules)

Manual **Resolve** consults the same rule set: an exception cannot be
resolved while its source condition still holds (HTTP 409 — e.g. an
evidence exception whose latest verification is still REJECTED). Clearing
the source (new verified evidence, accepted/received document, completed
approval, closed clarification, resolved issue) is what unlocks
resolution — usually automatically. MANUAL exceptions are governed by
human judgment.

**Waiver** is a formal control decision: lender review roles only
(FUNDER_REP / COMPLIANCE_REVIEWER), INTEGRITY exceptions only by the
compliance reviewer, reason required, written to the configuration audit
trail. A waiver records a decision about the exception — the source
record is untouched.

## SLA / age policy

Configurable per-severity targets set `dueAt` at creation:
Critical/High 1 day, Medium 3 days, Low 7 days
(`OBV_EXC_SLA_*_HOURS`). Displayed as **Within target / Due soon /
Overdue** — operational targets, never compliance certifications.

## Surfaces

- **/exceptions** — register with severity/category/project/owner/
  status/source/overdue filters, stats strip, documented rule list, and
  compact cards on mobile.
- **/exception/:id** — why it exists, authoritative source link
  ("remains authoritative"), source state, timeline, and the action set
  (Acknowledge / Assign / Start work / Request response / Resolve —
  source-gated / Close / Waive — authorized). Location-bearing exceptions
  link to the map through their source layer (issue/evidence markers),
  so no duplicate markers are drawn.
- **Overview** — action queue row: open exceptions with high/critical,
  overdue, and awaiting-response counts.
- **OBV Intelligence** — `exception-overdue` signals and a top
  recommendation pointing at the oldest overdue high/critical exception,
  each linking to the exception detail (which drills into the source).
- **Communications** — "Reference in project discussion" posts an
  EXCEPTION_REFERENCE card; chat remains coordination-only (a message
  cannot resolve an exception — proven by test).

## Tests

`node scripts/exceptions-test.js` — 34 checkpoints covering the 16
required cases: single-exception creation from rejected evidence,
duplicate-proof evaluation, approval-delay / missing-document /
financial-variance rules, source links, waiver authorization + reason +
audit (+ source truth untouched, sweep respects waiver), no
fund-release path, source-gated resolution, auto-resolution on source
clearance (with timeline), tenant isolation, map link, intelligence
link, communications reference, and SLA age states.
