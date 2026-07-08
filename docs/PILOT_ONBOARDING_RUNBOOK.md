# OBV Pilot Onboarding Runbook

A practical, day-by-day guide for taking a real organization from
"we want to pilot OBV" to a launched, operating project. Everything below
happens in the product (Pilot Setup at `/setup`) — no database editing.

> The trust model never bends for onboarding: customer configuration
> defines the project rules; field evidence proves physical work;
> verification assesses; formal governance authorizes; the ledger records.
> Launch is configuration activation, not proof of work.

## Roles and responsibilities

| Role | Responsibility |
|---|---|
| **Pilot administrator** (customer, PROJECT_MANAGER) | Organization setup, project configuration, invitations, launch |
| **Funder representative** | Approval matrix participation, release approvals |
| **Compliance reviewer** | Evidence review, clarifications, release approvals |
| **Field engineer(s)** (FIELD) | Mobile evidence capture, WhatsApp coordination, issue response |
| **OBV pilot lead** (vendor) | Kickoff facilitation, integration support, weekly reviews |

## Day 0 — Kickoff

- Agree pilot scope: one project, which milestones, which draw structure.
- Identify the pilot administrator (must hold PROJECT_MANAGER).
- Confirm deployment (Render URL, access code if gated), sign-in flow, and
  who owns environment configuration.
- Record pilot success criteria (see Metrics below) and the pilot end date.

## Day 1 — Organization, team, project

1. **Organization** (`/setup`): create the primary organization (type,
   country, timezone, reporting currency, primary contact) and each
   counterparty — implementing agency, contractor, engineer/consultant.
2. **Team**: invite users by email with organization + role. The
   activation link is surfaced once to the administrator (the pilot demo
   build uses safe preview delivery — no real email is sent; hand the
   link to the user directly). Tokens are one-time, hashed at rest, and
   expire in 14 days; revoke and reissue from the same panel.
3. **Project**: create the draft project — name, code, type, counterparty
   organizations, total value, OBV-controlled amount, currency, dates,
   timezone. The project stays DRAFT (invisible to operations) until launch.

## Day 2 — Configuration

4. **Geography** (`/setup/project/<id>` → Geography): corridor polyline,
   site polygon, or point. Coordinates are validated; the geofence used by
   the deterministic location check derives from this geometry. It is
   user-defined precision, not survey-grade — say so to the customer.
5. **Milestones**: apply the closest template (Road Rehabilitation, School
   Construction, Clinic Rehabilitation, Water Infrastructure, Generic) and
   edit, or build from blank / CSV import. Every milestone needs
   requirement text — it drives the field checklist and verification.
6. **Evidence requirements**: per milestone — photo sets (min count,
   geolocation, capture recency), documents (PDF), inspections, test
   results. Media types are allowlisted.
7. **Draw structure**: tranche per milestone. The page reconciles the sum
   against the OBV-controlled amount and blocks launch until they match.
8. **Approval matrix**: which roles must approve every release (default
   Funder Rep + Compliance Reviewer). At least two distinct roles; FIELD
   can never approve; the evidence submitter can never approve their own
   submission. Verification policy (AI confidence threshold, geofence
   strictness, offline allowance) is configurable within OBV-validated
   bounds — the non-overridable integrity rules are listed on that page.

## Day 3 — Field onboarding & readiness

9. **Field assignments**: invite FIELD users (a project-scoped FIELD
   invitation auto-assigns on activation) and scope them to milestones.
   Assigned engineers see exactly their projects in Field Capture.
10. **External participants**: map WhatsApp identities and assign
    participant contexts under Communications → Integrations. A
    communication-only participant does not become an OBV user.
11. **Integrations** (OPTIONAL — never required): Teams conversation sync,
    WhatsApp field bridge. Internal OBV Communications is sufficient.
12. **Readiness Review**: run the deterministic checklist. Every blocker
    links to its stage. Fix until READY TO LAUNCH.

## Day 4 — Dry run

With the project still in DRAFT (or on the seeded demo project):

- Field engineer captures sample evidence end-to-end (photo, GPS, offline
  queue if relevant).
- Reviewer exercises: verification outcomes, clarification request +
  response, field issue creation/resolution.
- Approvers exercise a full approval → release on the demo project.
- Walk the Funder Verification Report and the Evidence Ledger.

## Day 5 — Launch

- Re-run Readiness Review → **Launch Project**. Launch: snapshots the
  configuration (versioned, hashed), sets the project ACTIVE, records all
  tranches HELD, opens the Project General thread. It creates **no
  evidence, no approvals, no ledger entries, no releases**.
- Confirm the empty operational state with the customer, then begin real
  field capture.

## Operating the pilot

- **Pilot Operations** (`/pilot`): live counts of evidence, verification
  outcomes, pending approvals, funds held/released, open issues and
  clarifications, integration health, draft-project readiness.
- **Post-launch changes** (tranche amounts, approval matrix, evidence
  requirements, geography, milestone content) require an explicit change
  reason, bump the configuration version, capture a new snapshot, and land
  in the configuration audit trail. Historic evidence keeps the policy
  version it was evaluated under.
- **Weekly review** (customer + OBV pilot lead): dashboard walk-through,
  open blockers, clarification/issue backlog, approval turnaround.
- **Escalation**: field issues (severity CRITICAL) → project manager same
  day; verification disputes → compliance reviewer decision recorded via
  clarification; platform faults → OBV pilot lead.

## Pilot success metrics

Define targets at kickoff; measure only what OBV actually records:

- milestones processed end-to-end
- median evidence review time
- % of submissions verified without resubmission
- clarification requests raised / resolved
- duplicate submissions prevented (idempotency)
- field issues resolved
- approval turnaround time
- reports generated

Do not claim savings figures unless the customer provides and validates
the methodology.

## Pilot closeout

1. Final Funder Verification Report per project.
2. **Pilot Export Package** (Readiness Review stage → Download): project
   configuration, participant matrix, milestone + evidence-requirement
   registers, draw structure, approval matrix, open issues/clarifications,
   readiness result, report index, snapshot history. No tokens or secrets.
3. Metrics review against Day-0 targets.
4. Decision meeting: expand, extend, or close.

## Reset semantics (demo vs pilot data)

- **Reset demo data** (Overview): restores the seeded R47 demo and
  **preserves** all pilot organizations, users, and projects. The Evidence
  Ledger is append-only — reset never rewrites it.
- **Development Full Reset** (Pilot Setup → danger zone; typed
  confirmation required): drops everything including pilot data. Never use
  it on a live pilot.
