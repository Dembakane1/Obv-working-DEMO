/**
 * Explainable matching engine — associates normalized source candidates
 * with OBV projects, permits, and contractor organizations.
 *
 * Every evaluation returns a verdict with a confidence score, reason
 * codes, the exact fields compared, and the differences found — no
 * black-box scoring. Ambiguous or conflicting results are NEVER
 * auto-linked; they go to the reviewer queue.
 *
 * TENANCY: candidates are only ever evaluated against entities in the
 * caller's accessible projects. A record in an inaccessible project is
 * never compared, counted, or disclosed by a match result.
 */
import * as repo from "../../db/repo";
import * as osRepo from "../../db/officialSourcesRepo";
import type {
  MatchVerdict,
  Permit,
  Project,
  SourceCandidate,
  SourceMatch,
} from "../../../shared/types";
import { normalizeAddress, normalizeIdentifier, normalizeText, nowIso, sha256Hex } from "./core";

interface ComparedField {
  field: string;
  candidate: string | null;
  obv: string | null;
  matched: boolean | null;   // null = not comparable (one side absent)
}

interface Evaluation {
  verdict: MatchVerdict;
  confidence: number;
  reasonCodes: string[];
  compared: ComparedField[];
  recommendation: string;
}

function compare(field: string, candidateValue: unknown, obvValue: unknown, normalizer: (v: unknown) => string): ComparedField {
  const c = candidateValue === null || candidateValue === undefined || candidateValue === "" ? null : normalizer(candidateValue);
  const o = obvValue === null || obvValue === undefined || obvValue === "" ? null : normalizer(obvValue);
  return {
    field,
    candidate: c,
    obv: o,
    matched: c !== null && o !== null ? c === o : null,
  };
}

/** Address comparison that refuses to over-read free text. Two
 *  addresses only genuinely CONFLICT when both carry house numbers that
 *  differ; a side without a street address (e.g. a project located as
 *  "Washington, DC") is NOT COMPARABLE (null), never a conflict. */
function addressCompare(field: string, candidateValue: unknown, obvValue: unknown): ComparedField {
  const c = candidateValue ? normalizeAddress(candidateValue) : null;
  const o = obvValue ? normalizeAddress(obvValue) : null;
  if (c === null || o === null || c.length === 0 || o.length === 0) {
    return { field, candidate: c, obv: o, matched: null };
  }
  if (c.includes(o) || o.includes(c)) return { field, candidate: c, obv: o, matched: true };
  const houseOf = (s: string) => /(^|\s)(\d{1,6})(\s)/.exec(` ${s} `)?.[2] ?? null;
  const streetTokens = (s: string) =>
    new Set(s.split(" ").filter((t) => t.length > 2 && !/^\d+$/.test(t)));
  const cHouse = houseOf(c);
  const oHouse = houseOf(o);
  if (cHouse === null || oHouse === null) {
    // One side has no street address — not comparable, not a conflict.
    return { field, candidate: c, obv: o, matched: null };
  }
  if (cHouse !== oHouse) return { field, candidate: c, obv: o, matched: false };
  const shared = [...streetTokens(c)].some((t) => streetTokens(o).has(t));
  return { field, candidate: c, obv: o, matched: shared ? true : null };
}

/** Evaluate one candidate against ONE permit. */
function evaluateAgainstPermit(candidate: SourceCandidate, permit: Permit, project: Project): Evaluation {
  const compared: ComparedField[] = [
    compare("permitNumber", candidate.permitNumber, permit.permitNumber, normalizeIdentifier),
    addressCompare("address", candidate.address, project.location),
    compare("permitType", candidate.fields.permitType?.value ?? null, permit.permitType, normalizeText),
    compare("issuanceDate", candidate.issuanceDate, permit.issuedAt ? permit.issuedAt.slice(0, 10) : null, normalizeText),
    compare("expirationDate", candidate.expirationDate, permit.expiresAt ? permit.expiresAt.slice(0, 10) : null, normalizeText),
  ];
  const byField = Object.fromEntries(compared.map((c) => [c.field, c]));
  const reasons: string[] = [];
  const numberMatch = byField.permitNumber.matched === true;
  const numberConflict = byField.permitNumber.matched === false;
  const addressMatch = byField.address.matched === true;
  const addressConflict = byField.address.matched === false;

  if (numberMatch) reasons.push("PERMIT_NUMBER_EXACT");
  if (numberConflict) reasons.push("PERMIT_NUMBER_DIFFERS");
  if (addressMatch) reasons.push("ADDRESS_MATCH");
  if (addressConflict) reasons.push("ADDRESS_MISMATCH");
  if (byField.issuanceDate.matched === true) reasons.push("ISSUANCE_DATE_CONSISTENT");
  if (byField.issuanceDate.matched === false) reasons.push("ISSUANCE_DATE_DIFFERS");
  if (byField.expirationDate.matched === false) reasons.push("EXPIRATION_DATE_DIFFERS");

  if (numberMatch && !addressConflict) {
    const dateConflicts = compared.filter((c) => c.field.endsWith("Date") && c.matched === false).length;
    if (dateConflicts === 0) {
      return {
        verdict: "EXACT_MATCH",
        confidence: 0.98,
        reasonCodes: reasons,
        compared,
        recommendation:
          "The official record's permit number matches this OBV permit exactly with no contradictions. " +
          "Confirm and attach it as the official source reference.",
      };
    }
    return {
      verdict: "HIGH_CONFIDENCE_MATCH",
      confidence: 0.85,
      reasonCodes: reasons,
      compared,
      recommendation:
        "The permit number matches but recorded dates differ. Review which side is stale before attaching; " +
        "if OBV's dates are outdated, a versioned correction through the DMV service may be warranted.",
    };
  }
  if (numberMatch && addressConflict) {
    return {
      verdict: "CONFLICT",
      confidence: 0.55,
      reasonCodes: reasons,
      compared,
      recommendation:
        "The permit number matches but the official record's address does not resemble the project location. " +
        "Do not attach without resolving the address discrepancy — this may be a different property's permit.",
    };
  }
  if (addressMatch && !candidate.permitNumber) {
    return {
      verdict: "POSSIBLE_MATCH",
      confidence: 0.55,
      reasonCodes: reasons,
      compared,
      recommendation:
        "The address matches but the official record carries no permit number to compare. A reviewer should " +
        "confirm against the official portal before relying on it.",
    };
  }
  if (addressMatch) {
    return {
      verdict: "POSSIBLE_MATCH",
      confidence: 0.5,
      reasonCodes: reasons,
      compared,
      recommendation:
        "Same address, different permit number — plausibly a different permit on the same property. Review " +
        "whether this permit should also be tracked in OBV.",
    };
  }
  return {
    verdict: "NO_MATCH",
    confidence: 0.9,
    reasonCodes: reasons.length > 0 ? reasons : ["NO_COMPARABLE_FIELDS"],
    compared,
    recommendation: "No meaningful overlap with this permit.",
  };
}

/** Evaluate a license/business candidate against a contractor org. */
function evaluateAgainstContractor(candidate: SourceCandidate, orgId: string, orgName: string): Evaluation {
  const compared: ComparedField[] = [
    compare("partyName", candidate.partyName, orgName, normalizeText),
  ];
  const nameMatch = compared[0].matched === true;
  const partial =
    !nameMatch &&
    candidate.partyName !== null &&
    (normalizeText(candidate.partyName).includes(normalizeText(orgName)) ||
      normalizeText(orgName).includes(normalizeText(candidate.partyName)));
  const reasons = nameMatch ? ["BUSINESS_NAME_EXACT"] : partial ? ["BUSINESS_NAME_PARTIAL"] : ["BUSINESS_NAME_DIFFERS"];
  if (nameMatch) {
    return {
      verdict: "HIGH_CONFIDENCE_MATCH",
      confidence: 0.85,
      reasonCodes: reasons,
      compared,
      recommendation:
        "The licensed business name matches this contractor. Confirm the license record and attach it; note " +
        "that a valid license never proves construction quality or performance.",
    };
  }
  if (partial) {
    return {
      verdict: "POSSIBLE_MATCH",
      confidence: 0.55,
      reasonCodes: reasons,
      compared,
      recommendation:
        "The licensed name partially overlaps this contractor's name (trade name vs. legal name is common). " +
        "A reviewer should confirm they are the same entity before attaching.",
    };
  }
  return {
    verdict: "NO_MATCH",
    confidence: 0.85,
    reasonCodes: reasons,
    compared,
    recommendation: "The licensed name does not resemble this contractor.",
  };
}

export interface CandidateEvaluation {
  matches: SourceMatch[];
  /** The strongest single verdict across targets (for queue routing). */
  overall: MatchVerdict;
}

const VERDICT_RANK: Record<MatchVerdict, number> = {
  EXACT_MATCH: 6, HIGH_CONFIDENCE_MATCH: 5, CONFLICT: 4, AMBIGUOUS: 3, POSSIBLE_MATCH: 2, NO_MATCH: 1,
};

/** Evaluate one candidate against every OBV entity in the allowed
 *  projects, persist the explainable evaluations (idempotently), and
 *  return them. AMBIGUITY: two or more equally strong number/name
 *  matches downgrade to AMBIGUOUS — never auto-linked. */
export function evaluateCandidate(
  candidate: SourceCandidate,
  allowedProjectIds: Set<string>
): CandidateEvaluation {
  const evaluations: Array<{ entityType: SourceMatch["obvEntityType"]; entityId: string; projectId: string | null; organizationId: string | null; result: Evaluation }> = [];

  if (candidate.recordType === "LICENSE" || candidate.recordType === "BUSINESS_REGISTRATION") {
    // Compare against the contractor orgs of accessible projects.
    const seenOrg = new Set<string>();
    for (const projectId of allowedProjectIds) {
      const project = repo.getProject(projectId);
      const contractorOrgId = project?.pilot?.contractorOrgId ?? null;
      if (!project || !contractorOrgId || seenOrg.has(contractorOrgId)) continue;
      seenOrg.add(contractorOrgId);
      const org = repo.getOrganization(contractorOrgId);
      if (!org) continue;
      const result = evaluateAgainstContractor(candidate, contractorOrgId, org.name);
      if (result.verdict !== "NO_MATCH") {
        evaluations.push({ entityType: "CONTRACTOR", entityId: contractorOrgId, projectId: project.id, organizationId: project.organizationId, result });
      }
    }
  } else {
    // Permit-shaped records (permits, occupancy certs, enforcement,
    // inspections referencing a permit number) → compare against permits.
    for (const projectId of allowedProjectIds) {
      const project = repo.getProject(projectId);
      if (!project) continue;
      for (const permit of repo.listPermitsForProject(projectId)) {
        const result = evaluateAgainstPermit(candidate, permit, project);
        if (result.verdict !== "NO_MATCH") {
          evaluations.push({ entityType: "PERMIT", entityId: permit.id, projectId, organizationId: project.organizationId, result });
        }
      }
    }
  }

  // Ambiguity: multiple equally-top verdicts of EXACT/HIGH on DIFFERENT
  // entities cannot be auto-trusted.
  const top = evaluations
    .filter((e) => e.result.verdict === "EXACT_MATCH" || e.result.verdict === "HIGH_CONFIDENCE_MATCH")
    .sort((a, b) => VERDICT_RANK[b.result.verdict] - VERDICT_RANK[a.result.verdict]);
  const ambiguous = top.length > 1 && new Set(top.map((t) => t.entityId)).size > 1;
  if (ambiguous) {
    for (const e of top) {
      e.result = {
        ...e.result,
        verdict: "AMBIGUOUS",
        confidence: Math.min(e.result.confidence, 0.6),
        reasonCodes: [...e.result.reasonCodes, "MULTIPLE_STRONG_TARGETS"],
        recommendation:
          "This official record matches more than one OBV record with similar strength. A reviewer must " +
          "decide which (if any) it belongs to — it will not be linked automatically.",
      };
    }
  }

  const matches: SourceMatch[] = [];
  for (const e of evaluations) {
    const match: SourceMatch = {
      id: repo.newId(),
      candidateId: candidate.id,
      organizationId: e.organizationId,
      projectId: e.projectId,
      obvEntityType: e.entityType,
      obvEntityId: e.entityId,
      verdict: e.result.verdict,
      confidence: e.result.confidence,
      reasonCodes: e.result.reasonCodes,
      fieldsCompared: e.result.compared,
      differences: e.result.compared.filter((c) => c.matched === false),
      recommendation: e.result.recommendation,
      evaluatedAt: nowIso(),
      matchKey: sha256Hex(`${candidate.id}:${e.entityType}:${e.entityId}`),
    };
    const inserted = osRepo.insertMatch(match);
    if (inserted) {
      matches.push(match);
    } else {
      // Same candidate content + same entity was already evaluated.
      const existing = osRepo.listMatchesForCandidate(candidate.id).find(
        (m) => m.obvEntityType === e.entityType && m.obvEntityId === e.entityId
      );
      if (existing) matches.push(existing);
    }
  }

  const overall = matches.length === 0
    ? "NO_MATCH"
    : matches.reduce<MatchVerdict>(
        (best, m) => (VERDICT_RANK[m.verdict] > VERDICT_RANK[best] ? m.verdict : best),
        "NO_MATCH"
      );
  return { matches, overall };
}
