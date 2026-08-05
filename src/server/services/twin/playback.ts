/**
 * Construction playback — the twin animated over time.
 *
 * NEVER SIMULATES. Every step is exactly one recorded timeline event
 * that has actually happened (at or before the read instant), in the
 * timeline's own deterministic order, mapped to the scene element that
 * represents its record. The animation is a replay of the record, not a
 * model of construction.
 */
import { pastEvents, projectTimeline } from "../timeline/aggregate";
import type { TwinPlayback, User } from "../../../shared/types";
import { twinScene } from "./scene";

/** Steps are capped (and the cap stated) so one enormous history cannot
 *  make the player unusable. The full record stays on the Timeline. */
export const PLAYBACK_STEP_CAP = 600;

export function twinPlayback(user: User, projectId: string): TwinPlayback {
  const scene = twinScene(user, projectId);
  const timeline = projectTimeline(user, projectId);
  const happened = pastEvents(timeline.events, timeline.asOf);
  const elementByEvent = new Map(scene.sync.map((s) => [s.eventId, s.elementId]));
  const truncated = happened.length > PLAYBACK_STEP_CAP;
  const window = truncated ? happened.slice(happened.length - PLAYBACK_STEP_CAP) : happened;
  return {
    projectId: scene.projectId,
    steps: window.map((e) => ({
      eventId: e.id,
      at: e.at,
      category: e.category,
      type: e.type,
      title: e.title,
      explanation: e.explanation,
      elementId: elementByEvent.get(e.id) ?? null,
      recordStatus: e.recordStatus,
    })),
    totalEvents: happened.length,
    truncated,
    asOf: timeline.asOf,
  };
}
