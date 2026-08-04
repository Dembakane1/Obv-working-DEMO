/**
 * Project Story Mode + playback engines.
 *
 * Story Mode explains a project the way a person would tell it —
 * "evidence was submitted, a duplicate invoice was flagged, a reviewer
 * investigated, an exception was recorded, the contractor corrected it,
 * the inspection passed, the draw was approved" — instead of listing
 * rows. Every sentence is derived from a real event and links back to
 * the record that produced it, so a plain-language story never says
 * anything the governed records do not.
 *
 * Playback replays state as it accumulated. Both narrate only events
 * that have ACTUALLY HAPPENED (at or before `asOf`); recorded future
 * dates are schedule, not history.
 */
import * as repo from "../../db/repo";
import type {
  DrawPlaybackStage,
  PlaybackFrame,
  StoryStep,
  TimelineEvent,
  User,
} from "../../../shared/types";
import { pastEvents, projectTimeline } from "./aggregate";
import { requireVisibleProject } from "./core";

/** A linkage table that is empty or absent must never break playback. */
function safeList<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ story mode

/** Events that carry the story. Routine bookkeeping is summarized rather
 *  than narrated one row at a time. */
const STORY_TYPES = new Set([
  "PROJECT_LAUNCHED", "PERMIT_RECORDED", "PERMIT_ISSUED", "GOVERNING_CODE_DETERMINED",
  "PERMIT_BASIS_FINALIZED", "PERMIT_BASIS_CORRECTED",
  "INSPECTION_SCHEDULED", "INSPECTION_RESULT",
  "EVIDENCE_UPLOADED", "EVIDENCE_VERIFIED",
  "DRAW_SUBMITTED", "APPROVAL_REQUESTED",
  "DISPUTE_OPENED", "DISPUTE_RESOLVED",
  "EXCEPTION_RAISED", "EXCEPTION_RESOLVED",
  "PAYMENT_INSTRUCTION_CREATED", "PAYMENT_CONFIRMED",
  "SOURCE_VERIFICATION_RECORDED", "OFFICIAL_SOURCE_ATTACHED",
  "AUDIT_PACKAGE_GENERATED",
]);

function isStoryEvent(e: TimelineEvent): boolean {
  if (STORY_TYPES.has(e.type)) return true;
  // Advisory findings and lender decisions matter to the story whenever
  // they are consequential.
  if (e.category === "EVIDENCE_INTEL" && (e.severity === "HIGH" || e.severity === "MEDIUM")) return true;
  if (e.type.startsWith("LENDER_")) return true;
  if (e.category === "OFFICIAL_SOURCE" && e.severity === "HIGH") return true;
  return false;
}

/** Turn one event into a sentence a non-technical lender can read. */
function narrate(e: TimelineEvent): { headline: string; detail: string } {
  const who = e.actorName ? ` by ${e.actorName}` : "";
  switch (e.type) {
    case "PROJECT_LAUNCHED":
      return { headline: "Project launched", detail: `Onboarding completed and governed workflows became active${who}.` };
    case "PERMIT_ISSUED":
      return { headline: e.title, detail: "The issuing authority's recorded issuance date for this permit." };
    case "GOVERNING_CODE_DETERMINED":
      return { headline: "Governing code basis determined", detail: `An authorized reviewer recorded which code governs this work${who}.` };
    case "PERMIT_BASIS_CORRECTED":
      return { headline: "Permit basis corrected", detail: "A versioned correction superseded the previous authoritative basis — the earlier version is preserved." };
    case "INSPECTION_SCHEDULED":
      return { headline: "Inspection scheduled", detail: "An official inspection was scheduled with the authority." };
    case "INSPECTION_RESULT":
      return {
        headline: e.severity === "HIGH" ? "Inspection did not pass" : "Inspection result recorded",
        detail: e.explanation,
      };
    case "EVIDENCE_UPLOADED":
      return { headline: "Evidence submitted", detail: `Field evidence was uploaded and hash-anchored into the ledger${who}.` };
    case "EVIDENCE_VERIFIED":
      return { headline: `Evidence reviewed`, detail: e.explanation };
    case "DRAW_SUBMITTED":
      return { headline: e.title, detail: "The contractor submitted a draw request with its supporting package." };
    case "APPROVAL_REQUESTED":
      return { headline: "Approval requested", detail: "The governed approval path opened against the configured approval matrix." };
    case "DISPUTE_OPENED":
      return { headline: "Dispute raised", detail: "A participant disputed a governed record; releases can be held while it is resolved." };
    case "DISPUTE_RESOLVED":
      return { headline: "Dispute resolved", detail: e.explanation };
    case "EXCEPTION_RAISED":
      return { headline: "Exception recorded", detail: e.explanation };
    case "EXCEPTION_RESOLVED":
      return { headline: "Exception cleared", detail: e.explanation };
    case "PAYMENT_INSTRUCTION_CREATED":
      return { headline: "Payment instruction created", detail: "An approved draw produced a payment instruction through the governed release path." };
    case "PAYMENT_CONFIRMED":
      return { headline: "Provider confirmed settlement", detail: "The banking provider confirmed the payment settled." };
    case "SOURCE_VERIFICATION_RECORDED":
      return { headline: "Official source checked", detail: e.explanation };
    case "OFFICIAL_SOURCE_ATTACHED":
      return { headline: "Official record attached", detail: e.explanation };
    case "AUDIT_PACKAGE_GENERATED":
      return { headline: "Audit package generated", detail: "A point-in-time package was produced; it is immutable once generated." };
    default:
      if (e.type.startsWith("LENDER_")) {
        return {
          headline: /REJECT|DECLINE/i.test(e.type) ? "Lender declined the draw" : "Lender approved the draw",
          detail: e.explanation,
        };
      }
      if (e.category === "EVIDENCE_INTEL") {
        return { headline: `Advisory finding — ${e.title.replace(/^Advisory finding — /, "")}`, detail: e.explanation };
      }
      return { headline: e.title, detail: e.explanation };
  }
}

export interface ProjectStory {
  projectId: string;
  projectName: string;
  /** Opening line — honest about what the records can and cannot say. */
  opening: string;
  steps: StoryStep[];
  /** Where the project stands right now, in one sentence. */
  currentState: string;
  /** Events omitted from the narrative (routine bookkeeping). */
  omitted: number;
  asOf: string;
}

export function projectStory(user: User, projectId: string): ProjectStory {
  const timeline = projectTimeline(user, projectId);
  const happened = pastEvents(timeline.events, timeline.asOf);
  const storyEvents = happened.filter(isStoryEvent);
  const steps: StoryStep[] = storyEvents.map((e) => {
    const { headline, detail } = narrate(e);
    return {
      at: e.at,
      headline,
      detail,
      category: e.category,
      recordStatus: e.recordStatus,
      eventId: e.id,
    };
  });

  // The projects table stores no creation timestamp, so the story opens
  // with the earliest RECORDED activity and says exactly that.
  const first = happened.length > 0 ? happened[0] : null;
  const opening = first
    ? `The earliest activity OBV holds for ${timeline.project.name} is ${first.at.slice(0, 10)}. ` +
      "OBV does not store a separate project-creation timestamp, so the story begins with the first recorded record."
    : `OBV holds no dated activity for ${timeline.project.name} yet.`;

  // Current state, assembled from governed records (not inferred).
  const openExceptions = repo.listExceptionsForProject(timeline.project.id)
    .filter((x) => x.status !== "RESOLVED" && x.status !== "CLOSED" && x.status !== "WAIVED").length;
  const milestones = repo.listMilestones(timeline.project.id);
  const released = milestones.filter((m) => m.status === "RELEASED").length;
  const currentState =
    `${released} of ${milestones.length} milestones released` +
    `${openExceptions > 0 ? `, ${openExceptions} open exception${openExceptions === 1 ? "" : "s"}` : ", no open exceptions"}` +
    `${timeline.upcomingCount > 0 ? `, ${timeline.upcomingCount} dated item${timeline.upcomingCount === 1 ? "" : "s"} still ahead` : ""}.`;

  return {
    projectId: timeline.project.id,
    projectName: timeline.project.name,
    opening,
    steps,
    currentState,
    omitted: happened.length - storyEvents.length,
    asOf: timeline.asOf,
  };
}

// ------------------------------------------------------------ draw playback

/** The canonical draw lifecycle, in the order a reviewer expects it. */
const DRAW_STAGES: Array<{ key: string; label: string; match: (e: TimelineEvent) => boolean }> = [
  { key: "requested", label: "Requested", match: (e) => e.type === "DRAW_CREATED" || e.type === "DRAW_SUBMITTED" },
  { key: "evidence", label: "Evidence submitted", match: (e) => e.type === "EVIDENCE_UPLOADED" || e.type === "EVIDENCE_CAPTURED" },
  { key: "evidence_review", label: "Evidence reviewed", match: (e) => e.type === "EVIDENCE_VERIFIED" || e.category === "EVIDENCE_INTEL" },
  { key: "official_sources", label: "Official sources checked", match: (e) => e.category === "OFFICIAL_SOURCE" },
  { key: "inspection", label: "Inspection", match: (e) => e.category === "INSPECTION" },
  { key: "exceptions", label: "Exceptions", match: (e) => e.category === "EXCEPTION" },
  { key: "disputes", label: "Disputes", match: (e) => e.category === "DISPUTE" },
  { key: "decision", label: "Lender decision", match: (e) => e.category === "DECISION" },
  { key: "instruction", label: "Payment instruction", match: (e) => e.type === "PAYMENT_INSTRUCTION_CREATED" },
  { key: "confirmation", label: "Provider confirmation", match: (e) => e.type === "PAYMENT_CONFIRMED" },
];

export interface DrawPlayback {
  drawRequestId: string;
  drawNumber: number | string;
  projectId: string;
  stages: DrawPlaybackStage[];
  asOf: string;
}

export function drawPlayback(user: User, projectId: string, drawRequestId: string): DrawPlayback {
  const timeline = projectTimeline(user, projectId);
  const draw = repo.getDrawRequest(String(drawRequestId ?? ""));
  if (!draw || draw.projectId !== timeline.project.id) {
    throw Object.assign(new Error("Not found"), { statusCode: 404, name: "TimelineError" });
  }
  const happened = pastEvents(timeline.events, timeline.asOf);
  // A draw's story includes its own events plus the milestone-level
  // evidence/inspection work it relies on. Draws reach milestones two
  // ways — through their line items and through explicit evidence links
  // — and both must be followed or the evidence stage looks empty on a
  // draw that plainly has evidence.
  const milestoneIds = new Set<string>();
  for (const line of safeList(() => repo.listDrawLines(draw.id))) {
    if (line.milestoneId) milestoneIds.add(line.milestoneId);
  }
  const linkedEvidenceIds = new Set<string>();
  for (const link of safeList(() => repo.listDrawEvidenceLinks(draw.id))) {
    linkedEvidenceIds.add(link.evidenceItemId);
    const evidence = repo.getEvidence(link.evidenceItemId);
    if (evidence?.milestoneId) milestoneIds.add(evidence.milestoneId);
  }
  for (const e of happened) {
    if (e.drawRequestId === draw.id && e.milestoneId) milestoneIds.add(e.milestoneId);
  }
  const relevant = happened.filter(
    (e) =>
      e.drawRequestId === draw.id ||
      (e.milestoneId && milestoneIds.has(e.milestoneId)) ||
      linkedEvidenceIds.has(e.sourceRecordId)
  );

  const openExceptions = repo.listExceptionsForProject(timeline.project.id).filter(
    (x) => x.drawRequestId === draw.id && x.status !== "RESOLVED" && x.status !== "CLOSED" && x.status !== "WAIVED"
  ).length;

  const stages: DrawPlaybackStage[] = DRAW_STAGES.map((stage) => {
    const events = relevant.filter(stage.match);
    const at = events.length > 0 ? events[0].at : null;
    let state: DrawPlaybackStage["state"] = events.length > 0 ? "COMPLETE" : "NOT_REACHED";
    let detail = events.length > 0
      ? `${events.length} recorded event${events.length === 1 ? "" : "s"}.`
      : "No record of this stage yet.";
    if (stage.key === "exceptions") {
      if (openExceptions > 0) {
        state = "BLOCKED";
        detail = `${openExceptions} open exception${openExceptions === 1 ? "" : "s"} on this draw.`;
      } else if (events.length > 0) {
        detail = `${events.length} exception event${events.length === 1 ? "" : "s"}, none open.`;
      } else {
        detail = "No exceptions recorded.";
      }
    }
    if (stage.key === "disputes" && events.length === 0) detail = "No disputes recorded.";
    return { key: stage.key, label: stage.label, state, at, detail, events };
  });

  // The first stage with no record after a completed one is where the
  // draw actually sits.
  const firstGap = stages.findIndex((s) => s.state === "NOT_REACHED");
  if (firstGap > 0 && stages.slice(0, firstGap).some((s) => s.state === "COMPLETE")) {
    stages[firstGap].state = "IN_PROGRESS";
    stages[firstGap].detail = "This is where the draw currently sits.";
  }

  return {
    drawRequestId: draw.id,
    drawNumber: draw.drawNumber,
    projectId: timeline.project.id,
    stages,
    asOf: timeline.asOf,
  };
}

// --------------------------------------------------- executive playback

const MS_WEEK = 7 * 86_400_000;

/** Replay a project week by week: what accumulated, and what it meant. */
export function executivePlayback(user: User, projectId: string, maxFrames = 16): {
  projectId: string;
  projectName: string;
  frames: PlaybackFrame[];
  asOf: string;
} {
  const timeline = projectTimeline(user, projectId);
  const happened = pastEvents(timeline.events, timeline.asOf);
  if (happened.length === 0) {
    return { projectId: timeline.project.id, projectName: timeline.project.name, frames: [], asOf: timeline.asOf };
  }
  const start = Date.parse(happened[0].at);
  const end = Date.parse(happened[happened.length - 1].at);
  const span = Math.max(end - start, 1);
  // Weekly frames, collapsed to `maxFrames` buckets for long projects so
  // the playback stays readable without hiding anything.
  const bucketMs = Math.max(MS_WEEK, Math.ceil(span / maxFrames));
  const frames: PlaybackFrame[] = [];
  let cumulative = 0;
  for (let from = start; from <= end; from += bucketMs) {
    const to = Math.min(from + bucketMs - 1, end);
    const inFrame = happened.filter((e) => {
      const t = Date.parse(e.at);
      return t >= from && t <= to;
    });
    cumulative += inFrame.length;
    const upTo = happened.filter((e) => Date.parse(e.at) <= to);
    const milestonesReleased = new Set(
      upTo.filter((e) => e.type === "MILESTONE_RELEASED").map((e) => e.milestoneId)
    ).size;
    const drawsApproved = new Set(
      upTo.filter((e) => e.type.startsWith("LENDER_") && !/REJECT|DECLINE/i.test(e.type)).map((e) => e.drawRequestId)
    ).size;
    const openExceptions =
      upTo.filter((e) => e.type === "EXCEPTION_RAISED").length -
      upTo.filter((e) => e.type === "EXCEPTION_RESOLVED").length;
    const openDisputes =
      upTo.filter((e) => e.type === "DISPUTE_OPENED").length -
      upTo.filter((e) => e.type === "DISPUTE_RESOLVED").length;
    const headline = inFrame.length === 0
      ? "No recorded activity in this period."
      : summarizeFrame(inFrame);
    frames.push({
      label: `${new Date(from).toISOString().slice(0, 10)} → ${new Date(to).toISOString().slice(0, 10)}`,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      cumulativeEvents: cumulative,
      newEvents: inFrame.length,
      milestonesReleased,
      drawsApproved,
      openExceptions: Math.max(0, openExceptions),
      openDisputes: Math.max(0, openDisputes),
      narrative: headline,
    });
  }
  return { projectId: timeline.project.id, projectName: timeline.project.name, frames, asOf: timeline.asOf };
}

function summarizeFrame(events: TimelineEvent[]): string {
  const byCategory = new Map<string, number>();
  for (const e of events) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1);
  const parts = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([cat, n]) => `${n} ${cat.replace(/_/g, " ").toLowerCase()}`);
  const notable = events.find((e) => e.severity === "HIGH");
  return `${parts.join(", ")}${notable ? ` — including: ${notable.title}` : ""}.`;
}

/** Guard used by routes that take a projectId before doing work. */
export function assertProjectVisible(user: User, projectId: string) {
  return requireVisibleProject(user, projectId);
}
