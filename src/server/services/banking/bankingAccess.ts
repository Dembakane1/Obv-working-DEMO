/**
 * Banking-layer access control.
 *
 * Rides the existing membership/capability framework (lenderAccess) —
 * nothing here replaces it. Banking capabilities are project-scoped
 * ProjectCapability values that are NEVER part of a participant-type
 * default set: they arrive only through an explicit membership
 * capabilitySet grant, or through the conservative legacy role fallback
 * below (mirroring the lender layer's fallback doctrine):
 *
 *   FUNDER_REP          → full banking capabilities (the lender operates
 *                         the program in the demo)
 *   COMPLIANCE_REVIEWER → view + reconciliation capabilities
 *   everyone else       → nothing without an explicit grant
 *
 * Tenant boundary is unchanged: out-of-tenant callers receive the same
 * 404 as a nonexistent record (lenderAccess.assertProjectAccess).
 * Separation-of-duties checks (creator-cannot-approve,
 * submitter-cannot-approve) are instance-level rules enforced in
 * paymentInstructions in BOTH authority modes — they are not role gates.
 */
import * as lenderAccess from "../lenderAccess";
import type { BankingCapability, Project, User } from "../../../shared/types";

export class BankingError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const FULL_BANKING: BankingCapability[] = [
  "VIEW_PROJECT_ACCOUNT",
  "MANAGE_PROJECT_ACCOUNT",
  "CREATE_PAYMENT_INSTRUCTION",
  "APPROVE_PAYMENT_INSTRUCTION",
  "CANCEL_PAYMENT_INSTRUCTION",
  "VIEW_RECONCILIATION",
  "RUN_RECONCILIATION",
  "MANAGE_BANKING_PROGRAM",
];

const OVERSIGHT_BANKING: BankingCapability[] = [
  "VIEW_PROJECT_ACCOUNT",
  "VIEW_RECONCILIATION",
  "RUN_RECONCILIATION",
];

const BANKING_ROLE_FALLBACK: Partial<Record<User["role"], BankingCapability[]>> = {
  FUNDER_REP: FULL_BANKING,
  COMPLIANCE_REVIEWER: OVERSIGHT_BANKING,
};

/** All banking capabilities the user holds on the project:
 *  membership capabilitySet grants ∪ conservative role fallback. */
export function bankingCapabilitiesFor(user: User, projectId: string): Set<BankingCapability> {
  const caps = new Set<BankingCapability>();
  const all = lenderAccess.capabilitiesFor(user, projectId);
  for (const c of FULL_BANKING) if (all.has(c)) caps.add(c);
  const fallback = BANKING_ROLE_FALLBACK[user.role];
  if (fallback) for (const c of fallback) caps.add(c);
  return caps;
}

export function hasBankingCapability(user: User, projectId: string, cap: BankingCapability): boolean {
  return bankingCapabilitiesFor(user, projectId).has(cap);
}

/** Tenant boundary (same-404 doctrine) — delegates to lenderAccess. */
export function assertProjectAccess(user: User, projectId: string): Project {
  try {
    return lenderAccess.assertProjectAccess(user, projectId);
  } catch (e) {
    if (e instanceof lenderAccess.LenderError) throw new BankingError(e.message, e.statusCode);
    throw e;
  }
}

export function assertBankingCapability(user: User, projectId: string, cap: BankingCapability): void {
  if (!hasBankingCapability(user, projectId, cap)) {
    throw new BankingError(`This action requires the ${cap} capability`, 403);
  }
}

/** Capability flags for rendering the workspace's action controls. The
 *  browser controls are convenience only — every POST re-runs these
 *  checks server-side. */
export interface BankingCapabilityFlags {
  viewAccount: boolean;
  manageAccount: boolean;
  createInstruction: boolean;
  approveInstruction: boolean;
  cancelInstruction: boolean;
  viewReconciliation: boolean;
  runReconciliation: boolean;
  manageProgram: boolean;
}

export function bankingCapabilityFlags(user: User, projectId: string): BankingCapabilityFlags {
  const caps = bankingCapabilitiesFor(user, projectId);
  return {
    viewAccount: caps.has("VIEW_PROJECT_ACCOUNT"),
    manageAccount: caps.has("MANAGE_PROJECT_ACCOUNT"),
    createInstruction: caps.has("CREATE_PAYMENT_INSTRUCTION"),
    approveInstruction: caps.has("APPROVE_PAYMENT_INSTRUCTION"),
    cancelInstruction: caps.has("CANCEL_PAYMENT_INSTRUCTION"),
    viewReconciliation: caps.has("VIEW_RECONCILIATION"),
    runReconciliation: caps.has("RUN_RECONCILIATION"),
    manageProgram: caps.has("MANAGE_BANKING_PROGRAM"),
  };
}
