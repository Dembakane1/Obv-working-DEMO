/**
 * Microsoft Outlook readiness: provider-neutral calendar artifacts today,
 * Microsoft Graph-ready adapter boundary for later.
 *
 * The active capability is ICS (RFC 5545) generation — a pure text
 * artifact every calendar client (Outlook included) imports natively, so
 * inspection scheduling, draw-review meetings, and reminders work with
 * zero vendor coupling and zero credentials. The Graph adapter exists as
 * a disabled boundary: no Microsoft credentials are required or accepted
 * in this milestone.
 */
import type { CalendarEvent } from "../../../shared/types";
import { IntegrationError } from "./core";

/** RFC 5545 text escaping. */
function icsEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** 2026-07-31T22:00:00.000Z → 20260731T220000Z */
function icsUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new IntegrationError("Invalid event timestamp");
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Fold long ICS lines at 74 octets with a leading space (RFC 5545 §3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = " " + rest.slice(74);
  }
  out.push(rest);
  return out.join("\r\n");
}

/** Build a single-event iCalendar document for a scheduling record. */
export function buildIcs(event: CalendarEvent, options: { organizerEmail?: string | null } = {}): string {
  const ends = event.endsAt ?? new Date(Date.parse(event.startsAt) + 60 * 60_000).toISOString();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OpenBuild Verify//Integrations//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:obv-${event.id}`,
    `DTSTAMP:${icsUtc(event.createdAt)}`,
    `DTSTART:${icsUtc(event.startsAt)}`,
    `DTEND:${icsUtc(ends)}`,
    `SUMMARY:${icsEscape(event.title)}`,
    `CATEGORIES:${icsEscape(event.kind)}`,
  ];
  if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
  if (event.notes) lines.push(`DESCRIPTION:${icsEscape(event.notes)}`);
  if (options.organizerEmail) lines.push(`ORGANIZER:mailto:${icsEscape(options.organizerEmail)}`);
  if (event.status === "CANCELLED") lines.push("STATUS:CANCELLED");
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// ------------------------------------------------ Graph-ready boundary

export interface OutlookProvider {
  name: string;
  displayName: string;
  active: boolean;
  /** Future Microsoft Graph event creation — disabled in this build. */
  createRemoteEvent(event: CalendarEvent): never;
}

export const outlookGraphProvider: OutlookProvider = {
  name: "ms_graph",
  displayName: "Microsoft Outlook (Graph)",
  active: false,
  createRemoteEvent: () => {
    throw new IntegrationError(
      "The Microsoft Graph calendar adapter is a disabled boundary in this build. " +
        "Export the event as ICS instead — Outlook imports it natively without credentials.",
      503
    );
  },
};
