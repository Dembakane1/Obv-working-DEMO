# Construction Draw Requests — lender demo runbook

The draw workflow is a lender-native review layer on top of the existing
OBV trust architecture. Nothing in it weakens Field Capture, EvidenceItem,
the verification aggregator, geofence/metadata integrity, the Evidence
Ledger, ApprovalRequest/ApprovalRecord governance, separation of duties,
HELD/RELEASED state, the VirtualAccountService abstraction, configuration
snapshots, project launch, the Funder Report, Map, Communications, Field
Issues, Clarifications, Teams or WhatsApp.

## Standing doctrine

- **A Draw Request is a REQUEST FOR REVIEW.** It does not authorize money.
- **A reviewer recommendation is ADVISORY.** It does not authorize money.
- **Only the formal OBV governance path** — a DRAW-subject
  `ApprovalRequest` resolved against the project's approval matrix, one
  decision per required role, separation of duties enforced — creates
  release eligibility.
- The governed release transition is recorded **exactly once** through the
  `VirtualAccountService` into `draw_account_events`
  (`UNIQUE(draw_request_id, type)` at the database level).
- Draw releases are draw-scoped records. Milestone tranche HELD/RELEASED
  state on the virtual project account is governed separately by the
  milestone evidence workflow and is never changed by a draw.

## Data model

| Entity | Purpose |
| --- | --- |
| `DrawRequest` | The draw itself: project, draw number, period, requested/recommended/approved amounts, status. Statuses: DRAFT, SUBMITTED, UNDER_REVIEW, CLARIFICATION_REQUIRED, READY_FOR_GOVERNANCE, PARTIALLY_APPROVED, APPROVED, RELEASED, RETURNED, CANCELLED. All transitions run through the draws service — no route mutates status directly. |
| `DrawLineItem` | Pay-application line: scheduled value, previously paid, this-draw request, stored materials, retainage, claimed/verified %, review status (PENDING / SUPPORTED / PARTIALLY_SUPPORTED / EXCEPTION / REJECTED) with reviewer notes. Completed+stored, balance-to-finish and variance are derived server-side. Line totals must reconcile exactly to the requested amount before submission. |
| `DrawDocumentRequirement` / `DrawDocument` | Configurable checklist (pay application, invoice, lien waiver, inspection report, …) and received documents (RECEIVED / ACCEPTED / REJECTED / EXPIRED; requirement states derive REQUIRED / RECEIVED / ACCEPTED / MISSING / REJECTED / EXPIRED). A document on file is an administrative record — never verified physical progress. |
| `DrawEvidenceLink` | Reference to an existing governed `EvidenceItem` (draw-level or per line). Linking never copies, re-verifies, or alters the evidence or its ledger entry. |
| `DrawEvent` | Operational activity timeline (NOT the Evidence Ledger). |
| `DrawAccountEvent` | Draw-scoped virtual-account record, written ONLY by the `VirtualAccountService` from the completed-governance orchestration path. |

`approval_requests` gained a nullable subject: `milestone_id` (original
workflow) or `draw_request_id` + `subject_type='DRAW'`. Legacy databases
are rebuilt in place on first open; ids, records and threads are preserved
byte-for-byte.

## Recommendation rules (deterministic, advisory)

Computed from real draw state only, in priority order:

1. Open clarification → **RETURN FOR CLARIFICATION**
2. Any required document without a usable (received/accepted) file →
   **HOLD — DOCUMENTS MISSING**
3. Any unreviewed (PENDING) line → **HOLD — EVIDENCE NEEDS REVIEW**
4. Any open HIGH/CRITICAL field issue on the project →
   **HOLD — OPEN HIGH-SEVERITY ISSUE**
5. Every line SUPPORTED (supported = requested) → **READY FOR GOVERNANCE**
6. Otherwise → **PARTIAL SUPPORT** (supported = Σ supported line amounts)

Every result lists its reasons (missing documents by name, per-line
exception amounts with the reviewer's reason, claimed-vs-verified progress
mismatches). The engine has no code path to the `VirtualAccountService`
or the approval workflow.

## Exact lender demo flow (seeded)

Seeded state: **Draw #1** on the R47 road project is UNDER_REVIEW —
$600,000 requested, one line supported by verified M2 evidence ($80k), one
line held as an exception (gravel base claimed 75% vs no verified M3
evidence, $450k), one line partially supported (stored materials, $40k of
$70k), and the conditional lien waiver still missing.

1. Sign in as **Margaret Osei (Funder Representative)** → **Draw
   Requests** in the sidebar. The register answers requested / supported /
   exception / retainage / recommendation / governance / age / next action
   at a glance.
2. Open **Draw #1**. The header band answers: how much was requested
   ($600,000), how much is supported ($120,000), what is disputed
   ($480,000), retainage ($60,000), what is recommended, what was
   released.
3. **Line Items** — show the pay-application register and reviewer
   decisions with reasons; the reconciliation line proves lines equal the
   request exactly.
4. **Evidence** — the linked M2 culvert photo is the same governed record
   from the milestone workflow (verdict, confidence, ledger # shown).
   Point out: linking references, never copies.
5. **Documents** — checklist shows the conditional lien waiver MISSING.
   Record it (Record received document → fulfils "Conditional lien
   waiver").
6. **Review** — the deterministic recommendation and its reasons. Resolve
   the HIGH gravel-shortfall field issue (Field Issues) and watch the
   recommendation move from HOLD to **PARTIAL SUPPORT** with
   $120,000 supported. Emphasize the standing line: *this recommendation
   is advisory — it cannot release funds.*
7. Optionally open the draw thread from Overview and type “Approve Draw
   1” — nothing changes; chat coordinates only.
8. **Send to formal governance** — the draw becomes READY_FOR_GOVERNANCE
   and a DRAW-subject ApprovalRequest opens against the project matrix
   (Funder Representative + Compliance Reviewer).
9. **Governance** tab as Margaret → Approve. Funds remain HELD (1 of 2).
10. Switch to **Amina Ndlovu (Compliance Reviewer)** → Approve. All roles
    complete → the draw releases the recommended amount with **exactly one**
    governed release transition; the account record panel shows it.
    Note the milestone tranches did not move — the draw is its own
    governed record.
11. Generate the **Draw Review Summary** (Governance tab) — line register,
    document checklist, evidence references with ledger entries,
    recommendation reasons, approval history, financial-state and ledger
    integrity status.

## Safety tests

`node scripts/draws-test.js` (45 checkpoints; isolated server) covers the
21 required cases: draft creation, line reconciliation blocking
submission, document gating, evidence linking that leaves verification
untouched, reviewer decisions with mandatory reasons, deterministic
recommendation, chat/review/recommendation unable to move money,
DRAW-subject ApprovalRequest creation, HELD-until-final-approval,
exactly-once release, duplicate-approval rejection, submitter
separation-of-duties, unauthorized-reviewer rejection, unrelated-tenant
isolation (404), and report totals matching database records.

Run the full regression afterwards (all suites pass as of v13):
`acceptance` (needs `NODE_PATH=/opt/node22/lib/node_modules` + running
server), `chat`, `fieldops`, `idempotency`, `map`, `pilot`, `report`
(needs running server), `teams`, `teams-sync`, `verification`,
`whatsapp-sync`, `draws`.

## Out of scope (deliberately not started)

Real bank transfers, ACH, wires, title-company integration, accounting
integration, mining, blockchain. The virtual project account remains
financial control state, not money movement.
