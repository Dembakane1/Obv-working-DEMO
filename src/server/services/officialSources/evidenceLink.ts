/**
 * Evidence Intelligence linkage — official-source snapshots and changes
 * are treated as evidence INPUTS. When retrieval finds a condition worth
 * a reviewer's eye, this module records an ADVISORY Evidence
 * Intelligence signal (explainable, idempotent) and lets the existing
 * EI review queue carry it. Nothing here labels anything fraudulent,
 * and nothing here creates an exception — the EI promote action remains
 * the only advisory→governed bridge on that side.
 */
import * as ei from "../evidenceIntel";
import type {
  SourceCandidate,
  SourceChangeEvent,
  SourceMatch,
} from "../../../shared/types";
import { sha256Hex } from "./core";

/** A CONFLICT match: the official record and the OBV permit disagree on
 *  a load-bearing field (e.g. same number, different address). */
export function signalSourceConflict(candidate: SourceCandidate, match: SourceMatch): void {
  if (match.verdict !== "CONFLICT" || match.obvEntityType !== "PERMIT" || !match.obvEntityId) return;
  const signal = ei.recordSignal(
    {
      category: "SOURCE_STATUS_CONFLICT",
      severity: "MEDIUM",
      confidence: 0.7,
      subjectType: "PERMIT",
      subjectId: match.obvEntityId,
      organizationId: match.organizationId,
      projectId: match.projectId,
      title: "Official source record conflicts with this permit",
      explanation:
        `An official ${candidate.agency} record (${candidate.externalId}) matches this permit's number but ` +
        "disagrees on other recorded fields. The comparison below shows exactly what differs. Official records " +
        "can be delayed or mis-keyed — this is advisory, not a determination.",
      comparison: { candidateId: candidate.id, differences: match.differences, reasonCodes: match.reasonCodes },
      recommendation:
        "Review the official record side by side with the OBV permit in the Official Sources queue before " +
        "relying on either.",
      relatedRecords: { candidateId: candidate.id, matchId: match.id },
      signalKey: `src-conflict:${sha256Hex(`${candidate.id}:${match.obvEntityId}`)}`,
    },
    null
  );
  if (signal) ei.enqueueSignal(signal);
}

/** A record we had previously retrieved no longer appears at the source. */
export function signalRecordMissing(change: SourceChangeEvent): void {
  if (change.changeKind !== "RECORD_UNAVAILABLE" || !change.projectId) return;
  const signal = ei.recordSignal(
    {
      category: "SOURCE_RECORD_MISSING",
      severity: "LOW",
      confidence: 0.6,
      subjectType: "PROJECT",
      subjectId: change.projectId,
      organizationId: change.organizationId,
      projectId: change.projectId,
      title: "An official source record is no longer returned by the source",
      explanation:
        `External record ${change.externalId} was previously retrieved but the source no longer returns it. ` +
        "Records disappear from feeds for many reasons (renumbering, dataset lag, publication changes) — this " +
        "is NOT evidence of revocation.",
      comparison: { changeEventId: change.id, changedFields: change.changedFields },
      recommendation: "Confirm the record's status on the official portal before drawing any conclusion.",
      relatedRecords: { changeEventId: change.id },
      signalKey: `src-missing:${sha256Hex(`${change.sourceId}:${change.externalId}:${change.previousCandidateId ?? ""}`)}`,
    },
    null
  );
  if (signal) ei.enqueueSignal(signal);
}

/** Stop-work / enforcement / revocation wording detected at the source. */
export function signalEnforcement(change: SourceChangeEvent): void {
  const relevant = change.changeKind === "STOP_WORK" || change.changeKind === "ENFORCEMENT_ACTION" || change.changeKind === "REVOKED";
  if (!relevant || !change.projectId) return;
  const signal = ei.recordSignal(
    {
      category: "SOURCE_ENFORCEMENT_ALERT",
      severity: "HIGH",
      confidence: 0.75,
      subjectType: "PROJECT",
      subjectId: change.projectId,
      organizationId: change.organizationId,
      projectId: change.projectId,
      title: "Official source wording indicates an enforcement condition",
      explanation:
        `${change.explanation} The official wording is quoted verbatim; OBV does not interpret it as a legal ` +
        "determination. A reviewer should verify on the official portal and decide what follow-up is warranted.",
      comparison: { changeEventId: change.id, changedFields: change.changedFields },
      recommendation:
        "Verify the enforcement condition on the official portal; if confirmed, consider promoting the " +
        "Official Sources queue item to a governed exception.",
      relatedRecords: { changeEventId: change.id },
      signalKey: `src-enforcement:${change.changeKey ?? change.id}`,
    },
    null
  );
  if (signal) ei.enqueueSignal(signal);
}

/** License candidate whose official wording indicates expiry/suspension,
 *  matched to a contractor on an accessible project. A compliance signal
 *  for review — never proof of wrongdoing. */
export function signalLicenseInconsistent(candidate: SourceCandidate, match: SourceMatch): void {
  if (match.obvEntityType !== "CONTRACTOR" || !match.obvEntityId || !match.projectId) return;
  const status = (candidate.normalizedStatus ?? "").toLowerCase();
  const problem = /expir|suspend|revok|inactive|lapsed/.test(status);
  if (!problem) return;
  const signal = ei.recordSignal(
    {
      category: "SOURCE_LICENSE_INCONSISTENT",
      severity: "MEDIUM",
      confidence: 0.65,
      subjectType: "PROJECT",
      subjectId: match.projectId,
      organizationId: match.organizationId,
      projectId: match.projectId,
      title: "Official license record for a matched contractor needs review",
      explanation:
        `An official ${candidate.agency} license record matching this project's contractor reports status ` +
        `"${candidate.verbatimStatus ?? candidate.normalizedStatus}". An expired or missing license is a ` +
        "compliance signal requiring review — not automatic proof of wrongdoing, and never a statement about " +
        "construction quality.",
      comparison: { candidateId: candidate.id, licenseStatus: candidate.verbatimStatus, expirationDate: candidate.expirationDate },
      recommendation: "Verify the license on the official portal and review it with the contractor.",
      relatedRecords: { candidateId: candidate.id, matchId: match.id },
      signalKey: `src-license:${sha256Hex(`${candidate.externalId}:${match.obvEntityId}:${candidate.normalizedStatus ?? ""}`)}`,
    },
    null
  );
  if (signal) ei.enqueueSignal(signal);
}
