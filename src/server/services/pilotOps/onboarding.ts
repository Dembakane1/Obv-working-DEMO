/**
 * Guided organization onboarding: company profile, branding, settings,
 * team invitations, and initial portfolio — layered over the existing
 * pilot services (createOrganization / invitations / draft projects),
 * which remain the single mutation paths for those records.
 *
 * The wizard tracks completion in complete-only onboarding_steps rows
 * plus derived checks (users invited, project created), so the status is
 * honest even when work happened outside the wizard.
 */
import type { User } from "../../../shared/types";
import * as repo from "../../db/repo";
import * as prepo from "../../db/pilotOpsRepo";
import { PilotOpsError, assertOrgAdmin, audit } from "./core";

export const ONBOARDING_STEPS: { key: string; title: string; description: string }[] = [
  { key: "ORG_PROFILE", title: "Company profile", description: "Legal name, website and contact details" },
  { key: "BRANDING", title: "Branding", description: "Logo and brand color" },
  { key: "SETTINGS", title: "Organization settings", description: "Time zone, locale and notification defaults" },
  { key: "TEAM_INVITED", title: "Team invited", description: "At least one teammate invited or active" },
  { key: "PORTFOLIO_CREATED", title: "Initial portfolio", description: "At least one project exists" },
  { key: "REVIEW", title: "Review & finish", description: "Confirm setup and complete onboarding" },
];

export interface OnboardingStatus {
  organizationId: string;
  settings: prepo.OrganizationSettings | null;
  steps: {
    key: string;
    title: string;
    description: string;
    completed: boolean;
    completedAt: string | null;
    derived: boolean;
  }[];
  completedCount: number;
  totalSteps: number;
  complete: boolean;
}

export function onboardingStatus(user: User): OnboardingStatus {
  assertOrgAdmin(user);
  const organizationId = user.organizationId;
  const settings = prepo.getOrganizationSettings(organizationId);
  const recorded = new Map(prepo.listOnboardingSteps(organizationId).map((step) => [step.stepKey, step]));

  // Derived completion: real records count even without the wizard.
  const orgUsers = repo.listUsers().filter((u) => u.organizationId === organizationId);
  const invitations = repo.listInvitations().filter((i) => i.organizationId === organizationId);
  const hasTeam = orgUsers.length > 1 || invitations.length > 0;
  const hasProject = repo.listProjects().some((p) => p.organizationId === organizationId);
  const hasProfile = Boolean(settings?.legalName || settings?.displayName);
  const hasBranding = Boolean(settings?.logoPath || settings?.brandColor);
  const hasSettings = Boolean(settings?.timezone);

  const derivedDone: Record<string, boolean> = {
    ORG_PROFILE: hasProfile,
    BRANDING: hasBranding,
    SETTINGS: hasSettings,
    TEAM_INVITED: hasTeam,
    PORTFOLIO_CREATED: hasProject,
    REVIEW: Boolean(settings?.onboardingCompletedAt),
  };

  const steps = ONBOARDING_STEPS.map((step) => {
    const row = recorded.get(step.key);
    const derived = derivedDone[step.key] ?? false;
    return {
      key: step.key,
      title: step.title,
      description: step.description,
      completed: Boolean(row) || derived,
      completedAt: row?.completedAt ?? null,
      derived: !row && derived,
    };
  });
  const completedCount = steps.filter((step) => step.completed).length;
  return {
    organizationId,
    settings,
    steps,
    completedCount,
    totalSteps: steps.length,
    complete: completedCount === steps.length,
  };
}

export function updateOrganizationSettings(
  user: User,
  patch: {
    displayName?: string | null;
    legalName?: string | null;
    website?: string | null;
    phone?: string | null;
    brandColor?: string | null;
    logoPath?: string | null;
    timezone?: string | null;
    locale?: string | null;
    defaultNotificationChannel?: string;
  }
): prepo.OrganizationSettings {
  assertOrgAdmin(user);
  if (
    patch.defaultNotificationChannel &&
    !["IN_APP", "EMAIL", "BOTH"].includes(patch.defaultNotificationChannel)
  ) {
    throw new PilotOpsError("Unknown notification channel", 400);
  }
  if (patch.brandColor && !/^#[0-9a-fA-F]{6}$/.test(patch.brandColor)) {
    throw new PilotOpsError("Brand color must be a #RRGGBB value", 400);
  }
  const existing = prepo.getOrganizationSettings(user.organizationId);
  const updated = prepo.upsertOrganizationSettings(
    user.organizationId,
    {
      ...patch,
      onboardingStartedAt: existing?.onboardingStartedAt ?? new Date().toISOString(),
    },
    user.id
  );
  audit(user, "ORG_SETTINGS_UPDATED", "organization_settings", user.organizationId, {
    after: JSON.stringify(Object.keys(patch)),
  });
  return updated;
}

export function completeStep(user: User, stepKey: string): OnboardingStatus {
  assertOrgAdmin(user);
  if (!ONBOARDING_STEPS.some((step) => step.key === stepKey)) {
    throw new PilotOpsError("Unknown onboarding step", 400);
  }
  prepo.completeOnboardingStep(user.organizationId, stepKey, user.id);
  if (stepKey === "REVIEW") {
    prepo.upsertOrganizationSettings(
      user.organizationId,
      { onboardingCompletedAt: new Date().toISOString() },
      user.id
    );
  }
  audit(user, "ONBOARDING_STEP_COMPLETED", "onboarding_step", `${user.organizationId}:${stepKey}`);
  return onboardingStatus(user);
}
