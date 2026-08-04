/**
 * Timeline Intelligence — advisory patterns the history reveals.
 *
 * ADVISORY ONLY. Every insight is a measurement over events that already
 * happened, stated with the numbers behind it so a reader can check the
 * reasoning. Nothing here approves, rejects, blocks, escalates, or
 * creates any record: insights are observations for a human, never
 * decisions, and never a judgement about a contractor's integrity.
 */
import type { TimelineEvent, TimelineInsight, User } from "../../../shared/types";
import { pastEvents, projectTimeline } from "./aggregate";

const MS_DAY = 86_400_000;

/** Thresholds are stated openly and reported with every insight, so a
 *  reader always knows what "long" or "repeated" meant here. */
export const THRESHOLDS = {
  approvalDelayDays: 14,
  permitDelayDays: 30,
  contractorResponseDays: 10,
  repeatedFailures: 2,
  repeatedDisputes: 2,
  reviewerRequestLoops: 3,
  evidenceGapDays: 45,
  inspectionBottleneckDays: 21,
};

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / MS_DAY);
}

/** Advisory insights for one project. Callers that already hold the
 *  project's timeline may pass it in to avoid recomputing it. */
export function timelineInsights(
  user: User,
  projectId: string,
  precomputed?: ReturnType<typeof projectTimeline>
): {
  projectId: string;
  insights: TimelineInsight[];
  asOf: string;
} {
  const timeline = precomputed ?? projectTimeline(user, projectId);
  const events = pastEvents(timeline.events, timeline.asOf);
  const insights: TimelineInsight[] = [];
  const pid = timeline.project.id;

  const add = (i: Omit<TimelineInsight, "projectId">) => insights.push({ ...i, projectId: pid });

  // Indexes built once. Each pattern below anchors on a subset of events
  // and then asks "did the matching follow-up happen?" — answering that
  // with a fresh scan per anchor made the whole pass quadratic in the
  // event count, which bites exactly on the long histories that need
  // these observations most. `events` is already in ascending order, so
  // every bucket below inherits that order.
  const decisionsByDraw = new Map<string, TimelineEvent[]>();
  const byTypeAndRecord = new Map<string, TimelineEvent>();
  let lastEvidenceAt: string | null = null;
  for (const e of events) {
    if (e.category === "DECISION" && e.drawRequestId) {
      const list = decisionsByDraw.get(e.drawRequestId);
      if (list) list.push(e);
      else decisionsByDraw.set(e.drawRequestId, [e]);
    }
    const key = `${e.type}::${e.sourceRecordId}`;
    if (!byTypeAndRecord.has(key)) byTypeAndRecord.set(key, e);
    if (e.category === "EVIDENCE" && (lastEvidenceAt === null || e.at > lastEvidenceAt)) lastEvidenceAt = e.at;
  }
  const firstDecisionAfter = (drawId: string | null, after: string): TimelineEvent | undefined =>
    drawId ? decisionsByDraw.get(drawId)?.find((d) => d.at > after) : undefined;
  const followUp = (type: string, sourceRecordId: string): TimelineEvent | undefined =>
    byTypeAndRecord.get(`${type}::${sourceRecordId}`);

  // 1. Long approval delays: submitted -> lender decision.
  const submissions = events.filter((e) => e.type === "DRAW_SUBMITTED");
  for (const sub of submissions) {
    const decision = firstDecisionAfter(sub.drawRequestId, sub.at);
    const endpoint = decision ? decision.at : timeline.asOf;
    const days = daysBetween(sub.at, endpoint);
    if (days >= THRESHOLDS.approvalDelayDays) {
      add({
        kind: "LONG_APPROVAL_DELAY",
        severity: days >= THRESHOLDS.approvalDelayDays * 2 ? "HIGH" : "MEDIUM",
        title: decision
          ? `A draw waited ${days} days for a lender decision`
          : `A draw has been waiting ${days} days with no recorded decision`,
        explanation:
          `${sub.title} was submitted on ${sub.at.slice(0, 10)} and ` +
          (decision
            ? `a decision was recorded on ${decision.at.slice(0, 10)} — ${days} days later.`
            : `no lender decision has been recorded in the ${days} days since.`) +
          ` This is measured against a ${THRESHOLDS.approvalDelayDays}-day advisory threshold.`,
        recommendation: "Check whether the draw is blocked on evidence, an inspection, or an open exception.",
        relatedEventIds: decision ? [sub.id, decision.id] : [sub.id],
        evidence: { submittedAt: sub.at, decisionAt: decision?.at ?? null, days, thresholdDays: THRESHOLDS.approvalDelayDays },
      });
    }
  }

  // 2. Repeated failed inspections (per milestone).
  const failedByMilestone = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    if (e.type === "INSPECTION_RESULT" && e.severity === "HIGH" && e.milestoneId) {
      const list = failedByMilestone.get(e.milestoneId) ?? [];
      list.push(e);
      failedByMilestone.set(e.milestoneId, list);
    }
  }
  for (const [milestoneId, list] of failedByMilestone) {
    if (list.length >= THRESHOLDS.repeatedFailures) {
      add({
        kind: "REPEATED_FAILED_INSPECTIONS",
        severity: "HIGH",
        title: `${list.length} inspections did not pass on the same milestone`,
        explanation:
          `This milestone has ${list.length} recorded inspection outcomes indicating failure, correction, or ` +
          `reinspection, between ${list[0].at.slice(0, 10)} and ${list[list.length - 1].at.slice(0, 10)}. ` +
          "Repeated corrective cycles are worth a closer look at scope or workmanship — this is an observation, " +
          "not a determination about any party.",
        recommendation: "Review the correction notices and confirm the underlying issue was addressed.",
        relatedEventIds: list.map((e) => e.id),
        evidence: { milestoneId, failures: list.length, threshold: THRESHOLDS.repeatedFailures },
      });
    }
  }

  // 3. Repeated disputes.
  const disputes = events.filter((e) => e.type === "DISPUTE_OPENED");
  if (disputes.length >= THRESHOLDS.repeatedDisputes) {
    add({
      kind: "REPEATED_DISPUTES",
      severity: disputes.length >= THRESHOLDS.repeatedDisputes * 2 ? "HIGH" : "MEDIUM",
      title: `${disputes.length} disputes were opened on this project`,
      explanation:
        `${disputes.length} disputes have been raised between ${disputes[0].at.slice(0, 10)} and ` +
        `${disputes[disputes.length - 1].at.slice(0, 10)}. Recurring disputes often point at an unresolved ` +
        "disagreement about scope, measurement, or documentation.",
      recommendation: "Review whether the disputes share a root cause that could be settled once.",
      relatedEventIds: disputes.map((e) => e.id),
      evidence: { disputes: disputes.length, threshold: THRESHOLDS.repeatedDisputes },
    });
  }

  // 4. Evidence gaps — long stretches with no evidence on an active project.
  const evidence = events.filter((e) => e.type === "EVIDENCE_UPLOADED");
  if (timeline.project.status === "ACTIVE") {
    const last = evidence.length > 0 ? evidence[evidence.length - 1] : null;
    const since = last ? daysBetween(last.at, timeline.asOf) : null;
    if (since !== null && since >= THRESHOLDS.evidenceGapDays) {
      add({
        kind: "EVIDENCE_GAP",
        severity: since >= THRESHOLDS.evidenceGapDays * 2 ? "HIGH" : "MEDIUM",
        title: `No new evidence for ${since} days`,
        explanation:
          `The most recent evidence upload was ${last!.at.slice(0, 10)}, ${since} days ago, while the project ` +
          `is ACTIVE. Measured against a ${THRESHOLDS.evidenceGapDays}-day advisory threshold. Quiet periods ` +
          "are normal between milestones; this is only a prompt to confirm.",
        recommendation: "Confirm whether work is paused, or whether evidence is simply outstanding.",
        relatedEventIds: last ? [last.id] : [],
        evidence: { lastEvidenceAt: last!.at, days: since, thresholdDays: THRESHOLDS.evidenceGapDays },
      });
    }
    if (evidence.length === 0 && events.length > 0) {
      add({
        kind: "EVIDENCE_GAP",
        severity: "MEDIUM",
        title: "No evidence has been uploaded for this project",
        explanation:
          "The project has recorded activity but no evidence uploads. Verified physical progress depends on " +
          "evidence, so this is worth confirming.",
        recommendation: "Confirm whether evidence capture has started for the active milestones.",
        relatedEventIds: [],
        evidence: { evidenceUploads: 0 },
      });
    }
  }

  // 5. Repeated reviewer requests — advisory findings returning to the
  //    same subject, or repeated review actions in a short window.
  const reviewerActions = events.filter(
    (e) => e.category === "EVIDENCE_INTEL" && e.type.startsWith("REVIEW_")
  );
  if (reviewerActions.length >= THRESHOLDS.reviewerRequestLoops) {
    add({
      kind: "REPEATED_REVIEWER_REQUESTS",
      severity: "MEDIUM",
      title: `${reviewerActions.length} reviewer actions on advisory findings`,
      explanation:
        `Reviewers have acted on advisory findings ${reviewerActions.length} times. A high volume can mean the ` +
        "same underlying documentation problem keeps resurfacing.",
      recommendation: "Check whether the findings share a cause that could be fixed at the source.",
      relatedEventIds: reviewerActions.slice(0, 10).map((e) => e.id),
      evidence: { reviewerActions: reviewerActions.length, threshold: THRESHOLDS.reviewerRequestLoops },
    });
  }

  // 6. Permit delays — permit recorded but not issued for a long time.
  const recorded = events.filter((e) => e.type === "PERMIT_RECORDED");
  for (const rec of recorded) {
    const issued = followUp("PERMIT_ISSUED", rec.sourceRecordId);
    if (!issued) {
      const days = daysBetween(rec.at, timeline.asOf);
      if (days >= THRESHOLDS.permitDelayDays) {
        add({
          kind: "PERMIT_DELAY",
          severity: "MEDIUM",
          title: `A permit has had no recorded issuance for ${days} days`,
          explanation:
            `${rec.title} was recorded on ${rec.at.slice(0, 10)} but carries no recorded issuance date after ` +
            `${days} days. The permit may be in process, or the issuance date may simply not be recorded yet.`,
          recommendation: "Check the official portal and record the issuance date if the permit has been issued.",
          relatedEventIds: [rec.id],
          evidence: { recordedAt: rec.at, days, thresholdDays: THRESHOLDS.permitDelayDays },
        });
      }
    }
  }

  // 7. Contractor response delay — an exception open a long time with no
  //    subsequent evidence from the field.
  const openExceptionEvents = events.filter((e) => e.type === "EXCEPTION_RAISED");
  for (const ex of openExceptionEvents) {
    const resolved = followUp("EXCEPTION_RESOLVED", ex.sourceRecordId);
    if (resolved) continue;
    const responded = lastEvidenceAt !== null && lastEvidenceAt > ex.at;
    const days = daysBetween(ex.at, timeline.asOf);
    if (!responded && days >= THRESHOLDS.contractorResponseDays) {
      add({
        kind: "CONTRACTOR_RESPONSE_DELAY",
        severity: "MEDIUM",
        title: `An exception has been open ${days} days with no field response`,
        explanation:
          `${ex.title} was raised on ${ex.at.slice(0, 10)} and no evidence has been submitted since. ` +
          `Measured against a ${THRESHOLDS.contractorResponseDays}-day advisory threshold.`,
        recommendation: "Confirm the exception reached the responsible party and what response is expected.",
        relatedEventIds: [ex.id],
        evidence: { raisedAt: ex.at, days, thresholdDays: THRESHOLDS.contractorResponseDays },
      });
    }
  }

  // 8. Inspection bottleneck — scheduled but no result for a long time.
  const scheduled = events.filter((e) => e.type === "INSPECTION_SCHEDULED");
  for (const s of scheduled) {
    const result = followUp("INSPECTION_RESULT", s.sourceRecordId);
    if (result) continue;
    const days = daysBetween(s.at, timeline.asOf);
    if (days >= THRESHOLDS.inspectionBottleneckDays) {
      add({
        kind: "INSPECTION_BOTTLENECK",
        severity: "MEDIUM",
        title: `An inspection has had no recorded result for ${days} days`,
        explanation:
          `An inspection was scheduled for ${s.at.slice(0, 10)} and no official result has been recorded in ` +
          `the ${days} days since. Measured against a ${THRESHOLDS.inspectionBottleneckDays}-day threshold.`,
        recommendation: "Check with the authority and record the official outcome when available.",
        relatedEventIds: [s.id],
        evidence: { scheduledAt: s.at, days, thresholdDays: THRESHOLDS.inspectionBottleneckDays },
      });
    }
  }

  // Most severe first, then most recent — deterministic for equal keys.
  const rank: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
  insights.sort((a, b) => rank[b.severity] - rank[a.severity] || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return { projectId: pid, insights, asOf: timeline.asOf };
}
