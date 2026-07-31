# Organization Setup Guide

How to onboard a pilot organization. The guided wizard at `/onboarding`
layers over the existing pilot services (organizations, invitations,
draft projects) — those remain the single mutation paths for their
records, and onboarding state is additive configuration that never
touches verification, approvals, or any governed record. Implementation:
`src/server/services/pilotOps/onboarding.ts` and
`src/server/http/pilotOpsRoutes.ts`.

Onboarding is available to the administrative roles `FUNDER_REP`,
`PROJECT_MANAGER`, and `COMPLIANCE_REVIEWER` — `FIELD` users hold no
administrative authority (403). Every action described here is appended
to the platform `config_audit` trail.

## The wizard steps

Six steps, tracked in complete-only `onboarding_steps` rows **plus
derived checks**, so status stays honest even when the work happened
outside the wizard ("detected from records"):

| Step | Derived-complete when |
| --- | --- |
| `ORG_PROFILE` — Company profile | A legal name or display name is saved |
| `BRANDING` — Branding | A logo or brand color is on file |
| `SETTINGS` — Organization settings | A time zone is set |
| `TEAM_INVITED` — Team invited | More than one user exists, or any invitation was created |
| `PORTFOLIO_CREATED` — Initial portfolio | At least one project exists for the organization |
| `REVIEW` — Review & finish | Onboarding was explicitly completed |

Any step can also be marked complete manually
(`POST /api/pilot-ops/onboarding/step`). Marking `REVIEW` stamps
`onboardingCompletedAt` on the organization settings. Status
(`GET /api/pilot-ops/onboarding`) reports each step's completion,
whether it was derived, and an overall `complete` flag when all six
are done.

## Organization settings

Saved via `POST /api/pilot-ops/org-settings` (also editable on the
wizard page). Fields:

- `displayName`, `legalName`, `website`, `phone`
- `brandColor` — must be a `#RRGGBB` value
- `timezone`, `locale`
- `defaultNotificationChannel` — `IN_APP`, `EMAIL`, or `BOTH`

The first save stamps `onboardingStartedAt`; each save is audited as
`ORG_SETTINGS_UPDATED` recording which fields changed (names only,
never values).

## Logo upload

`POST /api/pilot-ops/org-logo` with a `dataUrl` field containing a
base64 PNG or JPEG data URL (`data:image/png;base64,...` or
`data:image/jpeg;base64,...`), **at most 512 KB decoded**. The file is
stored under `<data>/uploads/branding/<organizationId>.png|jpg` and the
path saved to organization settings. `GET /api/pilot-ops/org-logo`
serves it back (org administrators only).

## Inviting the team (Pilot Setup)

Invitations live in **Pilot Setup** (`/setup`), not the wizard — the
wizard links there. Creating an invitation
(`POST /api/pilot/invitations`: email, organization, role, optional
project) produces a **one-time activation link** (`/invite/<token>`):

- The raw token is surfaced exactly once to the administrator; only its
  SHA-256 hash is stored, and the raw value is never logged.
- Invitations expire after 14 days; resending issues a fresh token and
  expiry; revoking ends the invitation.
- Acceptance is one-time: it creates the user, consumes the token, and
  signs the new user in. Expired, revoked, and already-used links are
  refused with distinct messages.
- An invitation notice is additionally recorded in the transactional
  email outbox (`log` provider by default — nothing leaves the machine,
  and the raw token is never placed in the email body).

`/admin` shows the invitation register read-only; create, resend, and
revoke stay in Pilot Setup.

## Creating the initial portfolio

Also in Pilot Setup: `POST /api/pilot/projects` creates a draft
project, then `/setup/project/<id>` walks the staged configuration
(milestones, evidence requirements, field assignments) through to
launch. Any existing project counts toward the wizard's
`PORTFOLIO_CREATED` step — the wizard never duplicates the project
mutation path.

## Notification defaults

The organization's `defaultNotificationChannel` is the org-level
default. Each user additionally has personal preferences at
`/notifications` which default to: in-app on, email on, daily digest
off, weekly digest on, nothing muted.

## How completion is tracked

Two sources, merged per step: an explicit `onboarding_steps` row
(complete-only, one per step, recorded with who and when) or the
derived check above. The status payload marks derived-only steps so an
administrator can see the difference. Step completions are audited as
`ONBOARDING_STEP_COMPLETED`. The internal customer-success console
reads the same `onboardingCompletedAt` marker — there is no second
completion state anywhere.
