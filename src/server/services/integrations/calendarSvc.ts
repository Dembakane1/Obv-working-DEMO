/**
 * Provider-neutral calendar & scheduling: inspections, draw reviews,
 * lender/contractor meetings, and permit deadlines as first-class
 * records, exportable as ICS for any client (Outlook included).
 *
 * Derived deadlines: permit expirations become SUGGESTED events computed
 * on read from the permit register — scheduling one stores a record;
 * nothing is auto-written.
 */
import { randomUUID } from "node:crypto";
import * as integrationsRepo from "../../db/integrationsRepo";
import * as repo from "../../db/repo";
import * as authz from "../authz";
import type { CalendarEvent, CalendarKind, User } from "../../../shared/types";
import {
  IntegrationError,
  assertIntegrationManager,
  assertIntegrationViewer,
  nowIso,
  recordIntegration,
} from "./core";
import { emitWebhookEvent } from "./webhooks";

const CALENDAR_KINDS: CalendarKind[] = [
  "INSPECTION", "DRAW_REVIEW", "LENDER_MEETING", "CONTRACTOR_MEETING", "PERMIT_DEADLINE", "REMINDER",
];

function requireEvent(actor: User, id: string): CalendarEvent {
  const event = integrationsRepo.getCalendarEvent(String(id ?? ""));
  if (!event || event.organizationId !== actor.organizationId) {
    throw new IntegrationError("Not found", 404);
  }
  return event;
}

export function createCalendarEvent(
  actor: User,
  input: {
    kind: string;
    title: string;
    startsAt: string;
    endsAt?: string | null;
    projectId?: string | null;
    location?: string | null;
    notes?: string | null;
    subjectType?: string | null;
    subjectId?: string | null;
  }
): CalendarEvent {
  assertIntegrationManager(actor);
  const kind = String(input.kind ?? "").toUpperCase() as CalendarKind;
  if (!CALENDAR_KINDS.includes(kind)) throw new IntegrationError(`Unknown event kind: ${input.kind}`);
  const title = String(input.title ?? "").trim().slice(0, 200);
  if (!title) throw new IntegrationError("An event title is required");
  const starts = Date.parse(String(input.startsAt ?? ""));
  if (Number.isNaN(starts)) throw new IntegrationError("A valid start time is required");
  const ends = input.endsAt ? Date.parse(String(input.endsAt)) : null;
  if (ends !== null && (Number.isNaN(ends) || ends <= starts)) {
    throw new IntegrationError("The end time must be after the start time");
  }
  if (input.projectId) {
    if (!authz.accessibleProjects(actor).some((p) => p.id === input.projectId)) {
      throw new IntegrationError("Not found", 404);
    }
  }
  const event: CalendarEvent = {
    id: randomUUID(),
    kind,
    title,
    organizationId: actor.organizationId,
    projectId: input.projectId ?? null,
    subjectType: input.subjectType?.slice(0, 60) ?? null,
    subjectId: input.subjectId?.slice(0, 80) ?? null,
    startsAt: new Date(starts).toISOString(),
    endsAt: ends !== null ? new Date(ends).toISOString() : null,
    location: input.location?.trim().slice(0, 200) || null,
    notes: input.notes?.trim().slice(0, 2000) || null,
    status: "SCHEDULED",
    createdBy: actor.id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  integrationsRepo.insertCalendarEvent(event);
  recordIntegration({
    category: "CALENDAR",
    provider: "internal",
    operation: "EVENT_SCHEDULED",
    outcome: "SUCCESS",
    actorUserId: actor.id,
    organizationId: actor.organizationId,
    subjectType: "calendar_event",
    subjectId: event.id,
    detail: kind,
  });
  emitWebhookEvent(actor.organizationId, "calendar.scheduled", `calendar-${event.id}`, {
    eventId: event.id,
    kind: event.kind,
    startsAt: event.startsAt,
  });
  return event;
}

export function setCalendarEventStatus(
  actor: User,
  id: string,
  status: "COMPLETED" | "CANCELLED"
): CalendarEvent {
  assertIntegrationManager(actor);
  const event = requireEvent(actor, id);
  if (event.status !== "SCHEDULED") {
    throw new IntegrationError(`This event is already ${event.status.toLowerCase()}`, 409);
  }
  integrationsRepo.updateCalendarStatus(event.id, status);
  recordIntegration({
    category: "CALENDAR",
    provider: "internal",
    operation: `EVENT_${status}`,
    outcome: "SUCCESS",
    actorUserId: actor.id,
    organizationId: actor.organizationId,
    subjectType: "calendar_event",
    subjectId: event.id,
  });
  return integrationsRepo.getCalendarEvent(event.id)!;
}

export function listCalendar(actor: User): CalendarEvent[] {
  assertIntegrationViewer(actor);
  return integrationsRepo.listCalendarEventsForOrgs([actor.organizationId]);
}

export function calendarEventForIcs(actor: User, id: string): CalendarEvent {
  assertIntegrationViewer(actor);
  return requireEvent(actor, id);
}

/** Permit deadlines the caller can see that have no scheduled event yet —
 *  DERIVED on read from the permit register, never auto-written. */
export function suggestedPermitDeadlines(
  actor: User
): Array<{ projectId: string; projectName: string; permitId: string; permitNumber: string; expiresAt: string }> {
  assertIntegrationViewer(actor);
  const scheduled = new Set(
    integrationsRepo
      .listCalendarEventsForOrgs([actor.organizationId])
      .filter((e) => e.kind === "PERMIT_DEADLINE" && e.subjectId)
      .map((e) => e.subjectId as string)
  );
  const out: Array<{ projectId: string; projectName: string; permitId: string; permitNumber: string; expiresAt: string }> = [];
  for (const project of authz.accessibleProjects(actor)) {
    for (const permit of repo.listPermitsForProject(project.id)) {
      if (permit.expiresAt && !scheduled.has(permit.id)) {
        out.push({
          projectId: project.id,
          projectName: project.name,
          permitId: permit.id,
          permitNumber: permit.permitNumber,
          expiresAt: permit.expiresAt,
        });
      }
    }
  }
  return out.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)).slice(0, 100);
}
