/**
 * Government portfolio foundation — ARCHITECTURE ONLY, PERMANENTLY
 * DISABLED IN THIS MILESTONE.
 *
 * The data shapes below (and the gov_* tables in the schema) exist so a
 * future milestone can host government portfolios, infrastructure
 * programs, donor-funded projects, grant portfolios, public reporting and
 * national dashboards WITHOUT restructuring the lender platform. Nothing
 * activates here:
 *
 *   - there is NO insert/update/delete path to any gov_* table anywhere
 *     in the application (statically asserted by the test suite);
 *   - every activation-shaped request is refused with a 404 so the
 *     module's existence discloses nothing;
 *   - the current lender workflow remains the primary workflow, untouched.
 */
import type { User } from "../../../shared/types";
import * as prepo from "../../db/portfolioRepo";
import { PortfolioError, assertPortfolioViewer } from "./context";

export type GovPortfolioKind =
  | "GOVERNMENT"
  | "INFRASTRUCTURE_PROGRAM"
  | "DONOR_FUNDED"
  | "GRANT";

/** Reserved reporting shape for future public dashboards (unused). */
export interface GovReportingFrame {
  publicIndicators: string[];
  reportingCadence: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  publicationChannel: "NATIONAL_DASHBOARD" | "DONOR_PORTAL" | "OPEN_DATA";
}

export interface GovernmentFoundationStatus {
  enabled: false;
  activationState: "ARCHITECTURE_ONLY";
  architectureVersion: number;
  supportedKinds: GovPortfolioKind[];
  tables: { portfolios: number; programs: number; links: number };
  note: string;
}

export const GOVERNMENT_FOUNDATION_NOTE =
  "Future-ready architecture for government, infrastructure-program, donor-funded and grant portfolios. " +
  "No government workflow is active, no data exists, and no write path exists. " +
  "The lender workflow remains the primary workflow.";

/**
 * The module is disabled by design in this milestone. There is no
 * configuration that turns it on: the flag exists so deployments can be
 * probed for readiness, but activation is a future milestone's decision.
 */
export function governmentModuleEnabled(): boolean {
  return false;
}

/** Every activation-shaped call lands here and refuses with a 404. */
export function assertGovernmentEnabled(): never {
  throw new PortfolioError("Not found", 404);
}

export function governmentFoundationStatus(user: User): GovernmentFoundationStatus {
  assertPortfolioViewer(user);
  return {
    enabled: false,
    activationState: "ARCHITECTURE_ONLY",
    architectureVersion: 1,
    supportedKinds: ["GOVERNMENT", "INFRASTRUCTURE_PROGRAM", "DONOR_FUNDED", "GRANT"],
    tables: prepo.govTableCounts(),
    note: GOVERNMENT_FOUNDATION_NOTE,
  };
}
