# Lender-Pilot Domain Layer — Pre-Implementation Audit

Baseline: `94f1217` on `claude/obv-lender-pilot-domain-completion`.

## 1. Requested fields that already exist (reused, not duplicated)

| Requested concept | Existing record | Decision |
|---|---|---|
| Retainage percentage / withholding | `RetainagePolicy.retainagePercent`, `DrawRequest.retainageRate/retainageWithheld` | Authoritative. `LenderDrawPolicy.retainagePct` is a *lender target* label only; the governed retainage service stays truth. |
| Required document types | `DrawDocumentRequirement` + `draw_document_requirements` | Authoritative checklist. Policy lists lender-required doc types; draw creation continues to seed requirements. |
| Approval limits / reviewer hierarchy | `ApprovalPolicy` (`approval_policies`) + `resolveDrawApprovalRoles` | Authoritative for formal governance. Lender policy stores advisory limits only. |
| Lien-waiver document metadata | `DrawDocument` (`LIEN_WAIVER`/`CONDITIONAL_LIEN_WAIVER`, `waiverKind/waiverScope/coveredThrough/vendor/amount`) | Kept valid. New `LienWaiverRecord` is the governed lifecycle layer, linked by `drawDocumentId`. Upload ≠ accepted. |
| Project parties | `ProjectPilotConfig` org ids (`implementingOrgId/contractorOrgId/funderOrgId/engineerOrgId`) | Kept authoritative for tenant checks. New `ProjectPartyAssignment` normalizes + adds history; no invented rows. |
| Inspector assignment | `FieldAssignment` (field users), `governmentInspectorName` (text) | Neither fits independent draw inspectors → new `DrawInspection.inspectorUserId/inspectorDisplayName`. |
| Government inspections | `JurisdictionalInspection` (+ requirement/gate machinery) | Untouched. Independent draw inspections are a fully separate entity family. |
| Draw amounts | `DrawRequest.requestedAmount/approvedAmount/recommendedAmount`, line `supportedAmount` | Authoritative. `LenderDrawDecision` snapshots them at decision time and reconciles explicitly. |
| Funding / release | `VirtualAccountService` + `draw_account_events` (exactly-once) | Untouched. `ExternalFundingRecord` is administrative only; no import path. |

## 2. Entities reused
Organizations (parties incl. kind LENDER), projects, draw_requests/lines/documents,
approval_requests/records (formal governance source), exceptions engine
(ensureException idempotent seeds; `source_type` column has NO CHECK → additive),
notifications via `teamsNotifier.notify` (free-form UPPER_SNAKE types),
config_audit + config_snapshots (policy versioning), drawPackage/auditPackage
builders (`buildDrawPackageFiles`, `buildRegisters` with `atOrBefore` as-of).

## 3. Additive columns required
None on existing tables. The whole layer is NEW tables only — zero ALTERs to
existing entities, zero rebuilds (exceptions.source_type is unconstrained).

## 4. New normalized entities (16 tables)
loan_assets, loan_ownership_events, loan_servicing_events,
project_party_assignments, jurisdiction_profiles,
draw_inspections, draw_inspection_lines, draw_inspection_report_versions,
draw_inspection_attachments, draw_inspection_events,
lender_draw_decisions, lender_decision_conditions,
lien_waiver_records, external_funding_records,
project_memberships, lender_draw_policies, draw_stage_events (17 with stage log).

## 5. Ambiguity resolutions
- "Inspection" → `DrawInspection` (lender-ordered), never `JurisdictionalInspection`;
  new exception sourceType `DRAW_INSPECTION` (existing `INSPECTION` = government).
- "Policy" → `LenderDrawPolicy` / `lender_draw_policies` (vs verification_policies,
  retainage_policies, approval_policies).
- "Decision" → `LenderDrawDecision` = the lender's business decision AFTER formal
  governance; `ApprovalRequest`/`ApprovalRecord` remain the governance truth and the
  decision must reference the completed `approvalRequestId`.
- "Stage" → derived `DrawWorkflowStage` computed from authoritative records
  (never stored as mutable truth); transitions appended to `draw_stage_events`.
- `READY_FOR_GOVERNANCE`/`ELIGIBLE_FOR_LENDER_REVIEW`: the derived stage maps
  DrawRequestStatus READY_FOR_GOVERNANCE → ELIGIBLE_FOR_LENDER_REVIEW; the stored
  status enum is unchanged.

## 6. Migration & backward compatibility
- CREATE TABLE IF NOT EXISTS only; no data backfill; no invented records.
- Legacy draws: no LoanAsset/inspection/decision/waiver/funding rows → services and
  reports return explicit `NOT RECORDED`; derived stage still computes from the
  draw record alone.
- Existing RELEASED draws remain historical releases; no funding records are
  synthesized from `draw_account_events`/`virtual_account_events`.

## 7. Authorization boundaries
- Tenant: same 404-not-403 policy via `draws.canAccessDraw` /
  `budgetProgress.canAccessProjectFinance`.
- New capability layer (`project_memberships`) is additive and governs NEW
  endpoints only; existing role checks on existing routes are untouched.
- Conservative fallbacks (no membership rows needed for the pilot roles):
  FUNDER_REP → LENDER_REVIEWER caps; COMPLIANCE_REVIEWER → OBV_REVIEWER caps;
  PROJECT_MANAGER and FIELD get lender-layer caps ONLY via explicit membership;
  ADMINISTRATOR capability only via explicit membership.
- Submitter-cannot-decide reuses the draws.ts separation-of-duties precedent.

## 8. Reporting changes
- Draw Verification Package: + loan-summary.json and 11 lender CSFs (parties,
  ownership/servicing history, inspections, line findings, report versions,
  decisions, conditions, lien waivers, external funding, stage history) inside
  `buildDrawPackageFiles`; manifest/file hashing unchanged.
- Project Audit Package: new `07_lender/` registers with the same `atOrBefore`
  as-of filtering; report-version documentHash included so the audit package can
  flag hash mismatches (integrity finding).

## 9. Tests
New isolated suite `scripts/lender-test.js` on PORT 3178 with the shared
harness (mkdtemp DATA_DIR, signIn/api/q1/exec) covering Part 17; every existing
suite re-run (draws 3181, exceptions 3183, permits 3198, drawpackage 3188,
auditpackage 3186, plus the rest).
