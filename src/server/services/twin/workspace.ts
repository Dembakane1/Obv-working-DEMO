/**
 * Timeline & Site Evidence workspace context — the CURRENT governed
 * state shown beside the historical record.
 *
 * READ-ONLY. Everything here is recomputed on read from the same
 * governed services the rest of the product uses (draw readiness, the
 * deterministic next-action engine); nothing is stored and nothing is
 * historical. The view labels every value from this module CURRENT so a
 * reader can never mistake it for what a historical event recorded —
 * historical truth comes only from the stored events themselves.
 */
import * as repo from "../../db/repo";
import { OPEN_STATUSES, drawNextAction } from "../pilot/lenderPilot";
import { drawReadiness } from "../drawReadiness";
import { requireVisibleProject } from "../timeline/core";
import type { User } from "../../../shared/types";

/** The live governed state of one draw, as of this read. */
export interface CurrentDrawState {
  drawRequestId: string;
  drawNumber: number;
  /** The draw workflow status stored on the request row. */
  status: string;
  requestedAmount: number;
  /** Live readiness evaluation — null when the evaluation could not be
   *  computed (reported as unavailable, never guessed). */
  readiness: string | null;
  /** The deterministic next action, from the existing engine — null when
   *  it could not be computed. */
  nextActionLabel: string | null;
  nextActionActor: string | null;
}

const safe = <T,>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

function stateOf(d: { id: string; drawNumber: number; status: string; requestedAmount: number }): CurrentDrawState {
  const readiness = safe(() => drawReadiness(d.id).status as string, null as string | null);
  const next = safe(() => drawNextAction(d.id), null);
  return {
    drawRequestId: d.id,
    drawNumber: d.drawNumber,
    status: d.status,
    requestedAmount: d.requestedAmount,
    readiness,
    nextActionLabel: next?.label ?? null,
    nextActionActor: next?.actor ?? null,
  };
}

/** Live state of every OPEN draw on the project (same open-statuses set
 *  the lender pilot uses), ordered by draw number. Same-404 applies. */
export function currentOpenDrawStates(user: User, projectId: string): CurrentDrawState[] {
  const project = requireVisibleProject(user, projectId);
  const open = new Set<string>(OPEN_STATUSES as string[]);
  return safe(() => repo.listDrawRequestsForProject(project.id), [])
    .filter((d) => open.has(d.status))
    .sort((a, b) => a.drawNumber - b.drawNumber)
    .map(stateOf);
}

/** Live state of ONE draw (open or settled — a historical event may link
 *  to a long-closed draw whose current state is still a fact). Null for
 *  a draw outside this project — same-404 shape, nothing leaked. */
export function currentDrawState(user: User, projectId: string, drawRequestId: string): CurrentDrawState | null {
  const project = requireVisibleProject(user, projectId);
  const draw = safe(() => repo.getDrawRequest(String(drawRequestId ?? "")), null);
  if (!draw || draw.projectId !== project.id) return null;
  return stateOf(draw);
}
