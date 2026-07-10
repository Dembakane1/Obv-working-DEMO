# Change Order Management + Retainage Control — model & runbook

Construction-native change control and retainage discipline on top of the
existing OBV trust chain. This is NOT real banking; the mock
VirtualAccountService remains the only financial gateway, and the existing
governed release path is preserved untouched.

## Core principles

- **A submitted change order changes nothing.** Budget, milestones and
  schedule stay exactly as configured until every required role approves
  through the formal ApprovalRequest path. There is no direct state-edit
  endpoint.
- **Approval applies impact exactly once, transactionally, audited.** The
  apply step runs inside a single database transaction, increments the
  project configuration version, writes a configuration snapshot linked to
  the change order, and records a `CHANGE_ORDER_APPLIED` audit event.
  Historic verifications keep their original policy/config references —
  they are never rewritten.
- **Retainage is computed transparently and withheld inside the governed
  draw release.** Released amounts are net of retainage; the withheld
  amount is a visible ledgered position, not a side effect.
- **Retainage release is its own formal approval.** It is condition-gated,
  requester-blocked (no self-approval), exactly-once (database UNIQUE
  constraints), and never automatic.

## Change order model

`ChangeOrder`: org/project, per-project `changeOrderNumber`, title,
description, `reasonCategory` (OWNER_REQUEST, DESIGN_CHANGE,
SITE_CONDITION, MATERIAL_CHANGE, SCOPE_CHANGE, REGULATORY, SCHEDULE,
CORRECTION, OTHER), requestedAmount / approvedAmount, currency,
`scheduleImpactDays`, affected milestone + budget-line ids, status
(DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED / PARTIALLY_APPROVED /
REJECTED, plus CLARIFICATION_REQUIRED, CANCELLED, IMPLEMENTED),
`appliedAt` + `appliedSnapshotVersion` (the exactly-once marker), and an
operational event timeline (`ChangeOrderEvent` — never merged with the
Evidence Ledger).

`ChangeOrderAllocation` distributes the requested amount across budget
lines and must reconcile exactly to `requestedAmount` before submission
(HTTP 422 otherwise). `ChangeOrderDocument` records supporting document
metadata (estimates, RFIs, engineer's instructions).

## Workflow

```
DRAFT --submit(reconciled)--> SUBMITTED --governance--> UNDER_REVIEW
   --all required roles approve--> APPROVED (applied once) --> IMPLEMENTED
   --any role rejects-->           REJECTED
SUBMITTED/UNDER_REVIEW --clarification--> CLARIFICATION_REQUIRED --resolve--> SUBMITTED
DRAFT/SUBMITTED/CLARIFICATION_REQUIRED --cancel--> CANCELLED
```

Approval uses the same ApprovalRequest machinery as milestones and draws
(`subjectType: "CHANGE_ORDER"`). Default safe matrix: at least two
distinct lender roles (FUNDER_REP + COMPLIANCE_REVIEWER, from the pilot
approval matrix when configured). One decision per role; the submitter can
never approve their own change order (HTTP 403). A reviewer may set a
partial `approvedAmount` — allocations scale proportionally with the
rounding remainder on the last allocation so the applied sum is exact.

## Impact preview vs applied impact

`GET /api/change-orders/:id/preview` computes projected revised budget,
projected completion dates and affected evidence requirements — marked
**PREVIEW ONLY** on the page and in the payload (`preview: true`). It
writes nothing. Only `applyApprovedChangeOrder` (reached exclusively
through the final approval decision) mutates configuration:
`approvedChanges` on each allocated budget line, planned-end shifts on
affected milestones with a configured date, config version + snapshot +
audit. Duplicate/late approval decisions cannot re-apply (409 / no-op
guard on `appliedAt`).

## Draw integration

- Draw line items may reference a change order (`changeOrderId`).
- Billing against an unapproved change order is refused (422) unless the
  line is explicitly submitted with `exceptionAcknowledged: true`; the
  line is then held for review, the deterministic exception rule
  `draw-unapproved-co` opens a COST exception, and OBV Intelligence emits
  the exact signal **UNAPPROVED CHANGE COST INCLUDED IN DRAW**.
- The draw reviewer recommendation gains the reason "UNAPPROVED CHANGE
  COST INCLUDED IN DRAW" — advisory only, as always.
- Draw pages and the Draw Review Summary report show original contract
  value, approved change orders, and current contract value, with
  CO-linked lines tagged (UNAPPROVED when applicable).

## Retainage model

`RetainagePolicy` (per project, audited): `retainagePercent` clamped 0–20,
required closeout conditions (default FINAL_LIEN_WAIVER,
CERTIFICATE_OF_COMPLETION, ALL_EXCEPTIONS_RESOLVED). At draw finalize
(send-to-governance) the retainage is computed transparently:
`withheld = round(recommended × rate%)`, stored on the draw
(`retainageRate`, `retainageWithheld`) and shown as gross / retainage /
net on the governance tab and report. When the final draw approval
releases funds, the VirtualAccountService releases the NET amount and
records the withhold in the same governed transition
(`retainage_events` UNIQUE(draw_request_id, type) makes it
exactly-once).

## Retainage release

`RetainageReleaseRequest` (amount ≤ retainage remaining) carries its
policy's condition checklist. `ALL_EXCEPTIONS_RESOLVED` is computed live
from the exception register; document conditions are satisfied explicitly
with a note. Sending to governance is refused while any required
condition is outstanding (422). The release then follows the formal
ApprovalRequest path (`subjectType: "RETAINAGE"`, ≥2 distinct roles, no
requester self-approval); the final approval releases the retainage
position exactly once via the VirtualAccountService
(`retainage_events` UNIQUE(retainage_release_id)). Nothing is ever
released automatically.

## Intelligence signals (deterministic)

| Rule | Severity | Condition |
| --- | --- | --- |
| `change-order-aging` | MEDIUM | Submitted/under-review CO unapproved > 7 days |
| `change-order-not-snapshotted` | HIGH | Approved CO without a linked configuration snapshot |
| `unapproved-change-cost-in-draw` | MEDIUM | Open draw line billing against a non-approved CO |
| `change-order-volume` | MEDIUM | Approved CO total > 10% of original budget |
| `retainage-blocked-by-exception` | MEDIUM | Pending release request blocked by open exceptions |
| `retainage-missing-closeout` | MEDIUM | Pending release request with unsatisfied document conditions |

## Surfaces

- **Change Orders** register (`/change-orders`) + create form + detail
  (`/change-order/:id`): summary, impact preview (PREVIEW ONLY banner),
  allocations, documents, workflow, formal approval panel, activity.
- **Budget & Progress**: retainage dashboard panel — held / released /
  remaining, conditions outstanding, pending release requests with their
  condition checklists, audited policy form, release-request form.
- **Draw detail + report**: contract value block, CO-tagged lines,
  gross/retainage/net governance figures.
- **OBV Intelligence**: the six signals above.

## API sketch

```
POST /api/change-orders                      create draft
POST /api/change-orders/:id/allocations      add allocation (draft only)
POST /api/change-orders/:id/documents        record document metadata
POST /api/change-orders/:id/submit           submit (reconciliation-gated)
GET  /api/change-orders/:id/preview          impact preview (writes nothing)
POST /api/change-orders/:id/governance       open formal ApprovalRequest
POST /api/change-orders/:id/clarification    request / resolve clarification
POST /api/change-orders/:id/cancel           cancel (pre-approval)
POST /api/change-orders/:id/implemented      mark applied CO implemented
POST /api/approvals/:id/decision             shared decision endpoint (all subject types)
POST /api/projects/:id/retainage-policy      audited policy update
POST /api/projects/:id/retainage-releases    create release request
POST /api/retainage-releases/:id/conditions/:key/satisfy
POST /api/retainage-releases/:id/governance  condition-gated formal approval
```

Tenant isolation: all pages/APIs return 404 for users outside the
project's organizations.

## Tests

`scripts/changeorders-test.js` — 40 checkpoints covering the 18 required
cases on an isolated server (:3184): draft/submit reconciliation, no
mutation before approval, preview-only, unapproved-CO-in-draw guard +
exception + exact signal, multi-role approval with separation of duties,
exactly-once apply, config version + snapshot + audit, historic
references preserved, schedule shift, retainage compute / net release /
held position, condition-gated release, exactly-once release, duplicate
approval no-ops, tenant isolation, and report/database consistency.

## Demo flow

1. Sign in as the PM → Change Orders → CO-1 (seeded, SUBMITTED) or create
   a new one; allocations must reconcile before submit.
2. As the funder, open CO-1 → review the impact preview (nothing changes)
   → Send to formal approval.
3. Approve as funder, then compliance — the second decision applies the
   impact: budget line updated, config version incremented, snapshot
   linked, audit written.
4. Draw Requests → add a line against an unapproved CO → refused; retry
   with the exception acknowledgement → exception + UNAPPROVED CHANGE
   COST INCLUDED IN DRAW signal.
5. Finalize a draw → governance shows gross / retainage (10%) / net; the
   governed release moves net and holds retainage.
6. Budget & Progress → Retainage panel → request release → blocked until
   conditions are satisfied → satisfy → formal approval (two roles) →
   released exactly once.
