# User Guide

A practical guide for lender-side users during a pilot. No technical
background needed. OBV's job is simple to state: money moves only when
verified physical evidence supports it, and everything you see is
derived from those verified records.

## Signing in

- **Invited by your administrator?** You received a one-time activation
  link. Opening it and confirming your name creates your account and
  signs you in. The link works once and expires after 14 days — ask
  your administrator to resend it if it has lapsed.
- **Demo deployment?** The front page leads to a role picker (`/demo`)
  with seeded example identities. This picker only ever lists demo
  identities, never real invited staff, and is disabled entirely on
  production-posture deployments.
- Some deployments ask for a shared **access code** before anything
  else; your administrator will give it to you.
- Sessions last 24 hours, then you sign in again. If your account has
  been suspended, sign-in is refused.

## Finding your way around

The left navigation groups the main surfaces:

- **Overview** (`/overview`) — your portfolio control center: what
  needs attention across every project you can access.
- **Projects** (`/projects`) — the project register; each project page
  has Overview, Evidence, and Approvals tabs.
- **Draw Requests** (`/draws`) — funding requests and where each one
  stands. A draw's page shows its evidence, documents, inspections, and
  lender review workspace.
- **Approvals** (`/approvals`) — decisions waiting on you, with the
  evidence basis alongside.
- **Evidence Review** (`/compliance`) — evidence flagged by automated
  checks or AI assessment, awaiting a human decision. The **Evidence
  Ledger** (`/ledger`) lists only evidence that completed verification.
- **Executive** (`/executive`) — the portfolio command center: health
  and risk per project, an attention queue, forecasts, fraud signals,
  and executive summaries. Everything there is advisory — it never
  approves or decides anything.

Field staff use **Field Capture** (`/field`) to photograph and submit
evidence; field accounts do not see the lender surfaces above.

## Notifications (`/notifications`)

One feed, derived from the records you can already access: draw
submissions, approvals and returns, inspections scheduled and
completed, permit problems, portfolio risk and fraud alerts, mentions,
and the executive summary. Because the feed is derived, marking items
read (or "Mark all read") changes nothing about the underlying work —
it only tracks what you have seen.

Preferences on the same page:

- In-app and email notifications on/off
- Daily digest (off by default) and weekly digest (on by default)
- Muted types — e.g. mute `SYSTEM` notices while keeping draw alerts

Digests bundle your unread items into one email. On pilot deployments
email uses a log-only delivery mode, so nothing actually leaves the
machine — your administrator can confirm how your deployment is set.

## Sending feedback (`/feedback`)

Pilots run on your feedback. Submit an item with:

- **Kind** — Bug, Feature, Improvement, or Pain point
- **Severity** — Low, Medium (default), High, or Critical
- A title, a description, and optionally the page it concerns

What happens next: the OBV team triages it, and its status moves
through Open → Triaged → In progress → Resolved/Closed. Responses to
you appear on the same page. Feedback is scoped to your organization —
other organizations never see your submissions, and internal triage
notes are never shown to customers.

## Where administration lives

If you hold an administrative role (Funder Representative, Project
Manager, or Compliance), three more pages appear:

- **Administration** (`/admin`) — your organization's user directory,
  suspend/restore, invitation register, the permission matrix, adoption
  analytics, e-signature requests, and accounting export/import.
- **Onboarding** (`/onboarding`) — the guided setup wizard for your
  organization's profile, branding, settings, team, and first project.
- **Pilot Setup** (`/setup`) — where organizations, invitations, and
  projects are actually created.

Field accounts have none of these. Every administrative action is
recorded in the platform audit trail.

## What OBV never does on your behalf

OBV does not approve draws, authorize payments, or replace your review.
Risk scores, forecasts, and fraud signals are advisory context for the
decisions that remain yours.
