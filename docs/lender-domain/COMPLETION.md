# Lender-Pilot Domain Layer — Completion Report

Branch `claude/obv-lender-pilot-domain-completion`, based on `94f1217` (main backend
baseline). main untouched.

## Files changed
- `src/shared/types.ts` — lender-layer types + 5 additive ExceptionSourceType values
- `src/server/db/index.ts` — 17 additive CREATE TABLE IF NOT EXISTS declarations
- `src/server/db/lenderRepo.ts` (new) — all lender-domain SQL
- `src/server/services/lenderAccess.ts` (new) — capability layer + tenant boundary
- `src/server/services/loanProfile.ts` (new) — loan asset, histories, parties,
  jurisdiction templates, lender policy
- `src/server/services/drawInspections.ts` (new) — independent inspection lifecycle
- `src/server/services/lenderDecisions.ts` (new) — decisions, conditions, lien
  waivers, external funding
- `src/server/services/drawWorkflow.ts` (new) — derived stage + append-only stage log
- `src/server/services/lenderReporting.ts` (new) — package registers
- `src/server/services/exceptions.ts` — 15 additive rules + seeds + source contexts
- `src/server/services/drawPackage.ts` / `auditPackage.ts` — register wiring
- `src/server/http/server.ts` — lender API routes, LenderError mapping, stage-sync
  hook in finishDrawPost
- `scripts/lender-test.js` (new) — 73-checkpoint isolated suite (:3178)
- `docs/lender-domain/AUDIT.md` — pre-implementation audit

## Schema (all additive; no ALTERs, no rebuilds, no backfill)
loan_assets (UNIQUE org+loanNumber), loan_ownership_events, loan_servicing_events
(append-only), project_party_assignments, jurisdiction_profiles (1:1 project),
draw_inspections (15-state CHECK), draw_inspection_lines,
draw_inspection_report_versions (UNIQUE inspection+version; DRAFT/FINALIZED/
SUPERSEDED), draw_inspection_attachments, draw_inspection_events,
lender_draw_decisions (supersede chain), lender_decision_conditions,
lien_waiver_records (9-state CHECK), external_funding_records (8-state CHECK),
project_memberships, lender_draw_policies (versioned rows), draw_stage_events.

## Capability matrix (server-enforced; additive)
| Participant | Default capabilities |
|---|---|
| BORROWER | SUBMIT_DRAW, UPLOAD_DRAW_DOCUMENT |
| CONTRACTOR | UPLOAD_DRAW_DOCUMENT, REPORT_CONTRACTOR_COMPLETION |
| INSPECTOR | RECORD_INSPECTION_FINDINGS, FINALIZE_INSPECTION_REPORT |
| OBV_REVIEWER | REVIEW_EVIDENCE, REVIEW_DRAW, SCHEDULE_DRAW_INSPECTION |
| LENDER_REVIEWER | REVIEW_DRAW, SCHEDULE_DRAW_INSPECTION, RECORD_LENDER_DECISION, ACCEPT_EXCEPTION, RECORD_EXTERNAL_FUNDING |
| ADMINISTRATOR | MANAGE_PROJECT_CONFIGURATION, MANAGE_USERS, SCHEDULE_DRAW_INSPECTION, REVIEW_DRAW |

Role fallbacks: FUNDER_REP→LENDER_REVIEWER, COMPLIANCE_REVIEWER→OBV_REVIEWER;
PROJECT_MANAGER / FIELD / ADMINISTRATOR only via explicit membership. Existing
role checks on existing routes unchanged. Unauthorized → 403; out-of-tenant → 404.

## Derived workflow stage
`deriveDrawStage()` computes the 22-stage view from DrawRequest status, approval
records, inspections, decisions, lien waivers and funding records — top-of-ladder
wins (funding → lien → decision → governance → corrections → review pipeline).
READY_FOR_GOVERNANCE ⇒ ELIGIBLE_FOR_LENDER_REVIEW (never automatic approval).
`draw_stage_events` records observed transitions from mutations only; GETs derive
without writing. Stage timestamps + inspection/draw events supply every Part-15
duration metric deterministically.

## Exceptions & notifications
15 new deterministic rules (sweep-integrated, auto-resolve on clear, reopen on
recurrence, waiver never rewrites source): inspection missing/scheduling overdue/
access failed/report pending/correction/reinspection, condition overdue, lien
waiver missing/rejected, funding mismatch/failure/reversal, loan maturity,
reserve insufficiency, servicing/ownership incompleteness. 15 notification types
delivered through the existing Teams mock/webhook notifier.

## Reporting
Draw Verification Package: + loan-summary.json, lender-policy-applied.json,
draw-workflow-stage.json and 11 CSV registers. Project Audit Package: same
registers project-wide under 07_lender/ with as-of filtering. Manifest/file
hashing, tenant isolation, immutability and NOT RECORDED marker rows preserved.

## Legacy migration behavior
No invented loans, parties, inspections, decisions, waivers or funding records.
Legacy draws behave exactly as before; RELEASED stays historical; missing lender
records read NOT RECORDED; nothing synthesized from virtual-account history.

## Test results
- NEW `scripts/lender-test.js`: **73/73** (loan/history/parties/jurisdiction/policy/
  memberships/inspections/report immutability/decisions/waivers/funding/stage/
  packages/financial boundary/tenant isolation/SoD).
- All existing suites green: gates 35, permits 82, draws 45, exceptions 34,
  draw package 27, audit package 43, change orders 40, budget 39, field ops 40,
  pilot 70, idempotency 17, chat 17, verification 11, teams 8, teams-sync 52,
  whatsapp-sync 48, acceptance 17, intelligence 10, map 26, homepage 14,
  report 10, deploy-check 22.

## Guarantees
- **No real money movement added**: external funding records are administrative;
  the compiled lender modules contain no require or call path to
  VirtualAccountService (test-enforced), and the whole funding lifecycle is
  proven to leave virtual_account_events / draw_account_events / released
  milestones unchanged.
- Verification, EvidenceItem truth, ledger construction, completion gates,
  permits/inspections (government), approval matrices, exactly-once release,
  change orders, retainage, exception source truth and report integrity rules
  are all untouched — enforced by the unchanged existing suites.

## Known limitations
- Independent-inspection attachments table exists but has no upload endpoint yet
  (report versions carry document hashes; binary upload can reuse the official-
  source artifact pattern later).
- Lender policy is stored configuration only — it feeds the inspection-missing
  exception and reports; it does not yet gate draw submission (deliberate:
  non-overridable integrity rules stay in the existing draw engine).
- No UI pages were added (backend layer only, per the non-goals).
