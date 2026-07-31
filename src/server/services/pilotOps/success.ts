/**
 * Customer Success workspace (internal-only), the feedback portal, and
 * pilot adoption analytics.
 *
 * The success console is gated by assertInternalOperator — lender-side
 * roles get a nondisclosing 404. Feedback is org-scoped for customers
 * (internal notes are never returned to them) and cross-org only for
 * the internal operator. Analytics derive from sign-in history, the
 * opt-in usage log, and existing governed timelines.
 */
import type { User } from "../../../shared/types";
import * as repo from "../../db/repo";
import * as prepo from "../../db/pilotOpsRepo";
import * as authz from "../authz";
import { PilotOpsError, assertInternalOperator, assertMember, assertOrgAdmin, audit } from "./core";

// ----------------------------------------------------- customer success

export interface CsWorkspaceRow {
  organizationId: string;
  organizationName: string;
  organizationKind: string;
  account: prepo.CsAccount;
  onboardingComplete: boolean;
  userCount: number;
  projectCount: number;
  openFeedback: number;
  openNotes: number;
  suggestedHealthScore: number;
}

function suggestedHealth(organizationId: string): number {
  // Deterministic suggestion an operator can override: onboarding done
  // (+30), any project (+20), multi-user (+20), recent sign-in (+20),
  // no open critical feedback (+10).
  let score = 0;
  const settings = prepo.getOrganizationSettings(organizationId);
  if (settings?.onboardingCompletedAt) score += 30;
  const projects = repo.listProjects().filter((p) => p.organizationId === organizationId);
  if (projects.length > 0) score += 20;
  const users = repo.listUsers().filter((u) => u.organizationId === organizationId);
  if (users.length > 1) score += 20;
  const lastSignIn = prepo.lastSignInByUser();
  const recent = users.some((u) => {
    const last = lastSignIn.get(u.id);
    return last !== undefined && Date.now() - Date.parse(last) < 7 * 86_400_000;
  });
  if (recent) score += 20;
  const critical = prepo
    .listFeedbackForOrganization(organizationId)
    .some((item) => item.severity === "CRITICAL" && !["RESOLVED", "CLOSED"].includes(item.status));
  if (!critical) score += 10;
  return score;
}

export function csWorkspace(user: User): CsWorkspaceRow[] {
  assertInternalOperator(user);
  return repo.listOrganizations().map((org) => {
    const account = prepo.upsertCsAccount(org.id, {});
    const settings = prepo.getOrganizationSettings(org.id);
    const feedback = prepo.listFeedbackForOrganization(org.id);
    return {
      organizationId: org.id,
      organizationName: org.name,
      organizationKind: org.kind,
      account,
      onboardingComplete: Boolean(settings?.onboardingCompletedAt),
      userCount: repo.listUsers().filter((u) => u.organizationId === org.id).length,
      projectCount: repo.listProjects().filter((p) => p.organizationId === org.id).length,
      openFeedback: feedback.filter((item) => !["RESOLVED", "CLOSED"].includes(item.status)).length,
      openNotes: prepo.listCsNotes(org.id).filter((note) => note.status === "OPEN").length,
      suggestedHealthScore: suggestedHealth(org.id),
    };
  });
}

export function updateCsAccount(
  user: User,
  organizationId: string,
  patch: {
    pilotStatus?: string;
    goLiveDate?: string | null;
    successManager?: string | null;
    healthScore?: number | null;
    renewalProbability?: number | null;
  }
): prepo.CsAccount {
  assertInternalOperator(user);
  if (!repo.getOrganization(organizationId)) throw new PilotOpsError("Organization not found", 404);
  if (
    patch.pilotStatus &&
    !["PROSPECT", "ONBOARDING", "LIVE", "PAUSED", "COMPLETED", "CHURNED"].includes(patch.pilotStatus)
  ) {
    throw new PilotOpsError("Unknown pilot status", 400);
  }
  for (const bounded of [patch.healthScore, patch.renewalProbability]) {
    if (bounded !== undefined && bounded !== null && (bounded < 0 || bounded > 100)) {
      throw new PilotOpsError("Scores are 0–100", 400);
    }
  }
  const account = prepo.upsertCsAccount(organizationId, patch);
  audit(user, "CS_ACCOUNT_UPDATED", "cs_account", organizationId, {
    after: JSON.stringify(Object.keys(patch)),
  });
  return account;
}

export function addChecklistItem(user: User, organizationId: string, title: string): prepo.CsChecklistItem {
  assertInternalOperator(user);
  if (!title.trim()) throw new PilotOpsError("Checklist title required", 400);
  const existing = prepo.listCsChecklist(organizationId);
  const item = prepo.insertCsChecklistItem(organizationId, title.trim().slice(0, 200), existing.length);
  audit(user, "CS_CHECKLIST_ADDED", "cs_checklist", item.id);
  return item;
}

export function setChecklistDone(user: User, itemId: string, done: boolean): void {
  assertInternalOperator(user);
  if (!prepo.setCsChecklistDone(itemId, done, user.id)) {
    throw new PilotOpsError("Checklist item not found", 404);
  }
  audit(user, done ? "CS_CHECKLIST_DONE" : "CS_CHECKLIST_REOPENED", "cs_checklist", itemId);
}

export function addCsNote(
  user: User,
  organizationId: string,
  kind: "NOTE" | "ISSUE" | "FEATURE_REQUEST",
  body: string
): prepo.CsNote {
  assertInternalOperator(user);
  if (!body.trim()) throw new PilotOpsError("Note body required", 400);
  const note = prepo.insertCsNote(organizationId, kind, body.trim().slice(0, 2000), user.id);
  audit(user, "CS_NOTE_ADDED", "cs_note", note.id);
  return note;
}

export function csAccountDetail(
  user: User,
  organizationId: string
): {
  row: CsWorkspaceRow;
  checklist: prepo.CsChecklistItem[];
  notes: prepo.CsNote[];
  feedback: prepo.FeedbackItem[];
} {
  assertInternalOperator(user);
  const row = csWorkspace(user).find((entry) => entry.organizationId === organizationId);
  if (!row) throw new PilotOpsError("Organization not found", 404);
  return {
    row,
    checklist: prepo.listCsChecklist(organizationId),
    notes: prepo.listCsNotes(organizationId),
    feedback: prepo.listFeedbackForOrganization(organizationId),
  };
}

// --------------------------------------------------------------- feedback

export function submitFeedback(
  user: User,
  input: {
    kind: string;
    title: string;
    body: string;
    severity?: string;
    pagePath?: string | null;
    screenshotPath?: string | null;
  }
): prepo.FeedbackItem {
  assertMember(user);
  if (!["BUG", "FEATURE", "IMPROVEMENT", "PAIN_POINT"].includes(input.kind)) {
    throw new PilotOpsError("Unknown feedback kind", 400);
  }
  const severity = input.severity ?? "MEDIUM";
  if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(severity)) {
    throw new PilotOpsError("Unknown severity", 400);
  }
  if (!input.title.trim() || !input.body.trim()) {
    throw new PilotOpsError("Title and description are required", 400);
  }
  const item = prepo.insertFeedback({
    id: prepo.newId(),
    organizationId: user.organizationId,
    userId: user.id,
    kind: input.kind,
    title: input.title.trim().slice(0, 200),
    body: input.body.trim().slice(0, 5000),
    severity,
    pagePath: input.pagePath?.slice(0, 200) ?? null,
    screenshotPath: input.screenshotPath ?? null,
  });
  return item;
}

/** Customer view: own org only, internal notes excluded. */
export function feedbackForUser(user: User): { items: prepo.FeedbackItem[] } {
  assertMember(user);
  return { items: prepo.listFeedbackForOrganization(user.organizationId) };
}

export function feedbackDetail(
  user: User,
  id: string
): { item: prepo.FeedbackItem; events: prepo.FeedbackEvent[] } {
  assertMember(user);
  const item = prepo.getFeedback(id);
  const internal = user.role === "COMPLIANCE_REVIEWER";
  // Same-404: another organization's feedback does not exist for you.
  if (!item || (!internal && item.organizationId !== user.organizationId)) {
    throw new PilotOpsError("Feedback not found", 404);
  }
  return { item, events: prepo.listFeedbackEvents(id, internal) };
}

export function respondToFeedback(
  user: User,
  id: string,
  input: { kind: "INTERNAL_NOTE" | "CUSTOMER_RESPONSE"; body: string; status?: string }
): void {
  assertInternalOperator(user);
  const item = prepo.getFeedback(id);
  if (!item) throw new PilotOpsError("Feedback not found", 404);
  if (!input.body.trim() && !input.status) throw new PilotOpsError("Nothing to record", 400);
  if (input.body.trim()) {
    prepo.insertFeedbackEvent(id, input.kind, input.body.trim().slice(0, 3000), user.id);
  }
  if (input.status) {
    if (!["OPEN", "TRIAGED", "IN_PROGRESS", "RESOLVED", "CLOSED"].includes(input.status)) {
      throw new PilotOpsError("Unknown status", 400);
    }
    prepo.setFeedbackStatus(id, input.status);
    prepo.insertFeedbackEvent(id, "STATUS_CHANGE", `Status → ${input.status}`, user.id);
  }
  audit(user, "FEEDBACK_TRIAGED", "feedback", id, { after: input.status ?? input.kind });
}

// --------------------------------------------------------- pilot analytics

export function usageAnalyticsEnabled(): boolean {
  return process.env.OBV_USAGE_ANALYTICS === "1";
}

export interface PilotAnalytics {
  generatedAt: string;
  usageTrackingEnabled: boolean;
  activeUsers: { daily: number; weekly: number; monthly: number };
  timeToFirstDrawDays: number | null;
  timeToApprovalDays: number | null;
  averageReviewTimeDays: number | null;
  featureAdoption: { feature: string; used: boolean }[];
  mostUsedPages: { path: string; views: number }[];
  abandonedWorkflows: { workflow: string; count: number; note: string }[];
  notificationEngagement: { readReceipts: number };
  pilotSuccess: { metric: string; value: string }[];
}

export function pilotAnalytics(user: User): PilotAnalytics {
  assertOrgAdmin(user);
  const nowMs = Date.now();
  const orgUsers = new Set(
    repo.listUsers().filter((u) => u.organizationId === user.organizationId).map((u) => u.id)
  );
  const lastSignIn = prepo.lastSignInByUser();
  const activeWithin = (days: number): number =>
    [...orgUsers].filter((id) => {
      const last = lastSignIn.get(id);
      return last !== undefined && nowMs - Date.parse(last) < days * 86_400_000;
    }).length;

  const projects = authz.accessibleProjects(user);
  const submittedDates: number[] = [];
  const approvalDurations: number[] = [];
  for (const project of projects) {
    for (const draw of repo.listDrawRequestsForProject(project.id)) {
      if (draw.submittedAt) {
        submittedDates.push(Date.parse(draw.submittedAt));
        if (["APPROVED", "RELEASED", "PARTIALLY_APPROVED"].includes(draw.status)) {
          const duration = Date.parse(draw.updatedAt) - Date.parse(draw.submittedAt);
          if (Number.isFinite(duration) && duration >= 0) approvalDurations.push(duration);
        }
      }
    }
  }
  const settings = prepo.getOrganizationSettings(user.organizationId);
  const startMs = settings?.onboardingStartedAt ? Date.parse(settings.onboardingStartedAt) : null;
  const firstDrawMs = submittedDates.length > 0 ? Math.min(...submittedDates) : null;

  const usage = usageAnalyticsEnabled() ? prepo.listUsageEvents() : [];
  const orgUsage = usage.filter((event) => event.organizationId === user.organizationId);
  const pageCounts = new Map<string, number>();
  for (const event of orgUsage.filter((e) => e.kind === "PAGE_VIEW")) {
    pageCounts.set(event.path, (pageCounts.get(event.path) ?? 0) + 1);
  }

  const drafts = projects
    .flatMap((project) => repo.listDrawRequestsForProject(project.id))
    .filter((draw) => draw.status === "DRAFT" && nowMs - Date.parse(draw.createdAt) > 14 * 86_400_000);
  const onboardingIncomplete = settings?.onboardingCompletedAt ? 0 : 1;

  const readReceipts = prepo.readKeysForUser(user.id).size;
  const avg = (values: number[]): number | null =>
    values.length > 0 ? Math.round((values.reduce((a, v) => a + v, 0) / values.length / 86_400_000) * 10) / 10 : null;

  return {
    generatedAt: new Date().toISOString(),
    usageTrackingEnabled: usageAnalyticsEnabled(),
    activeUsers: { daily: activeWithin(1), weekly: activeWithin(7), monthly: activeWithin(30) },
    timeToFirstDrawDays:
      startMs !== null && firstDrawMs !== null && firstDrawMs >= startMs
        ? Math.round(((firstDrawMs - startMs) / 86_400_000) * 10) / 10
        : null,
    timeToApprovalDays: avg(approvalDurations),
    averageReviewTimeDays: avg(approvalDurations),
    featureAdoption: [
      { feature: "Draw requests", used: submittedDates.length > 0 },
      { feature: "Portfolio intelligence", used: orgUsage.some((e) => e.path.startsWith("/executive")) },
      { feature: "Notification center", used: readReceipts > 0 },
      { feature: "Feedback portal", used: prepo.listFeedbackForOrganization(user.organizationId).length > 0 },
      { feature: "Accounting export", used: prepo.listAccountingConnections(user.organizationId).length > 0 },
    ],
    mostUsedPages: [...pageCounts.entries()]
      .map(([path, views]) => ({ path, views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10),
    abandonedWorkflows: [
      { workflow: "Draft draws older than 14 days", count: drafts.length, note: "Draws created but never submitted" },
      { workflow: "Onboarding incomplete", count: onboardingIncomplete, note: "Organization has not finished the wizard" },
    ],
    notificationEngagement: { readReceipts },
    pilotSuccess: [
      { metric: "Projects under management", value: String(projects.length) },
      { metric: "Draws submitted", value: String(submittedDates.length) },
      { metric: "Weekly active users", value: String(activeWithin(7)) },
      { metric: "Onboarding complete", value: settings?.onboardingCompletedAt ? "Yes" : "No" },
    ],
  };
}
