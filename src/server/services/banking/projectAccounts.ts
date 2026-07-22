/**
 * Banking programs, project virtual accounts and account holds.
 *
 * Balance semantics (whole-currency integers; every mutation is a guarded
 * single-statement UPDATE in bankingRepo, so a stale read can never drive
 * a column negative or double-apply):
 *
 *   availableBalance        unheld, unspent funds at the bank
 *   heldBalance             funds under an ACTIVE hold
 *   releaseEligibleBalance  available funds not yet committed to a
 *                           payment instruction (creation earmarks here)
 *   pendingOutboundAmount   submitted-to-provider, not yet settled
 *   settledOutboundAmount   provider-confirmed settled outbound
 *   returnedAmount          cumulative provider-confirmed returns
 *
 * Reconciliation invariant (suspense ≡ 0 in this phase):
 *   bankReported(program) = Σ accounts (available + held + pendingOutbound)
 *
 * Nothing here moves money: these are OBV's books about the partner
 * bank, and in demo mode the mock provider simulates the bank's side.
 */
import * as repo from "../../db/repo";
import * as brepo from "../../db/bankingRepo";
import { makeWholeCurrency } from "../money";
import { BankingError, assertBankingCapability, assertProjectAccess } from "./bankingAccess";
import { resolveBankingProvider, assertDemoSimulationAllowed } from "./registry";
import type {
  AccountHoldStatus,
  BankingAccountStructure,
  BankingEventType,
  BankingProgram,
  ProjectAccountHold,
  ProjectVirtualAccount,
  User,
} from "../../../shared/types";

const wholeAmount = makeWholeCurrency((m) => new BankingError(m, 400));

export const ACCOUNT_STRUCTURES: BankingAccountStructure[] = [
  "LENDER_CONTROLLED", "FBO", "CUSTODIAL", "ESCROW_PARTNER", "SEPARATE_PROJECT_ACCOUNTS",
];

export function logBankingEvent(input: {
  organizationId: string;
  projectId?: string | null;
  bankingProgramId?: string | null;
  projectVirtualAccountId?: string | null;
  drawRequestId?: string | null;
  paymentInstructionId?: string | null;
  bankTransactionId?: string | null;
  type: BankingEventType;
  detail: string;
  actorUserId?: string | null;
}): void {
  brepo.insertBankingEvent({
    id: brepo.newId(),
    organizationId: input.organizationId,
    projectId: input.projectId ?? null,
    bankingProgramId: input.bankingProgramId ?? null,
    projectVirtualAccountId: input.projectVirtualAccountId ?? null,
    drawRequestId: input.drawRequestId ?? null,
    paymentInstructionId: input.paymentInstructionId ?? null,
    bankTransactionId: input.bankTransactionId ?? null,
    type: input.type,
    detail: input.detail,
    actorUserId: input.actorUserId ?? null,
    createdAt: new Date().toISOString(),
  });
}

// ------------------------------------------------------------ programs

export function createProgram(
  user: User,
  input: {
    projectId: string;
    partnerBankName: string;
    accountStructure: string;
    currency?: string | null;
  }
): BankingProgram {
  const project = assertProjectAccess(user, input.projectId);
  assertBankingCapability(user, project.id, "MANAGE_BANKING_PROGRAM");
  const partnerBankName = (input.partnerBankName ?? "").trim();
  if (!partnerBankName) throw new BankingError("partnerBankName is required", 400);
  const structure = (input.accountStructure ?? "").trim() as BankingAccountStructure;
  if (!ACCOUNT_STRUCTURES.includes(structure)) {
    throw new BankingError(`accountStructure must be one of ${ACCOUNT_STRUCTURES.join(", ")}`, 400);
  }
  const existing = brepo
    .listProgramsForOrganization(project.organizationId)
    .find((p) => p.status === "ACTIVE" || p.status === "PENDING");
  if (existing) {
    throw new BankingError("An active banking program already exists for this organization", 409);
  }
  const provider = resolveBankingProvider();
  const now = new Date().toISOString();
  const id = brepo.newId();
  const result = provider.createProgramAccount({
    bankingProgramId: id,
    organizationId: project.organizationId,
    partnerBankName,
    accountStructure: structure,
    currency: input.currency?.trim() || "USD",
  });
  const program: BankingProgram = {
    id,
    organizationId: project.organizationId,
    provider: provider.kind,
    providerProgramReference: result.providerProgramReference,
    partnerBankName,
    accountStructure: structure,
    status: "ACTIVE",
    currency: input.currency?.trim() || "USD",
    createdAt: now,
    updatedAt: now,
    activatedAt: now,
    suspendedAt: null,
    metadata: null,
    createdByUserId: user.id,
  };
  brepo.insertProgram(program);
  logBankingEvent({
    organizationId: program.organizationId,
    projectId: project.id,
    bankingProgramId: program.id,
    type: "PROGRAM_CREATED",
    detail: `Banking program created at ${partnerBankName} (${structure}, ${program.provider} provider).`,
    actorUserId: user.id,
  });
  return program;
}

export function programForProject(projectId: string): BankingProgram | null {
  const project = repo.getProject(projectId);
  if (!project) return null;
  const account = brepo.getOpenAccountForProject(projectId);
  if (account) return brepo.getProgram(account.bankingProgramId);
  return (
    brepo
      .listProgramsForOrganization(project.organizationId)
      .find((p) => p.status === "ACTIVE" || p.status === "PENDING") ?? null
  );
}

// ------------------------------------------------------ project accounts

export function createProjectAccount(user: User, projectId: string): ProjectVirtualAccount {
  const project = assertProjectAccess(user, projectId);
  assertBankingCapability(user, project.id, "MANAGE_PROJECT_ACCOUNT");
  const program = programForProject(project.id);
  if (!program || program.status !== "ACTIVE") {
    throw new BankingError("An active banking program is required before creating a project account", 409);
  }
  if (brepo.getOpenAccountForProject(project.id)) {
    throw new BankingError("The project already has an open virtual account", 409);
  }
  const provider = resolveBankingProvider();
  const now = new Date().toISOString();
  const id = brepo.newId();
  const result = provider.createProjectVirtualAccount({
    bankingProgramId: program.id,
    projectVirtualAccountId: id,
    projectId: project.id,
    currency: program.currency,
  });
  const account: ProjectVirtualAccount = {
    id,
    bankingProgramId: program.id,
    projectId: project.id,
    providerAccountReference: result.providerAccountReference,
    virtualAccountNumberMasked: result.virtualAccountNumberMasked,
    routingNumberMasked: result.routingNumberMasked,
    currency: program.currency,
    status: "ACTIVE",
    availableBalance: 0,
    heldBalance: 0,
    releaseEligibleBalance: 0,
    pendingOutboundAmount: 0,
    settledOutboundAmount: 0,
    returnedAmount: 0,
    createdAt: now,
    activatedAt: now,
    suspendedAt: null,
    closedAt: null,
    lastReconciledAt: null,
  };
  try {
    brepo.insertAccount(account);
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint/.test(e.message)) {
      throw new BankingError("The project already has an open virtual account", 409);
    }
    throw e;
  }
  logBankingEvent({
    organizationId: program.organizationId,
    projectId: project.id,
    bankingProgramId: program.id,
    projectVirtualAccountId: account.id,
    type: "ACCOUNT_CREATED",
    detail: `Project virtual account ${account.virtualAccountNumberMasked} created (subledger identity under the ${program.partnerBankName} program).`,
    actorUserId: user.id,
  });
  return account;
}

/** View-side accessor with tenant boundary + view capability, logging an
 *  attributable ACCOUNT_ACCESSED audit event. */
export function accountForProjectView(user: User, projectId: string): ProjectVirtualAccount | null {
  const project = assertProjectAccess(user, projectId);
  assertBankingCapability(user, project.id, "VIEW_PROJECT_ACCOUNT");
  const account = brepo.getOpenAccountForProject(project.id);
  if (account) {
    logBankingEvent({
      organizationId: project.organizationId,
      projectId: project.id,
      bankingProgramId: account.bankingProgramId,
      projectVirtualAccountId: account.id,
      type: "ACCOUNT_ACCESSED",
      detail: "Project account workspace viewed.",
      actorUserId: user.id,
    });
  }
  return account;
}

/** Account by id with tenant boundary: unknown id and out-of-tenant id
 *  are the same 404. */
export function getAccountChecked(user: User, accountId: string): ProjectVirtualAccount {
  const account = brepo.getAccount(accountId);
  if (!account) throw new BankingError("Account not found", 404);
  assertProjectAccess(user, account.projectId); // throws the same 404 out-of-tenant
  return account;
}

// -------------------------------------------------------- demo credits

export function creditDemoFunds(
  user: User,
  accountId: string,
  input: { amount: unknown; description?: string | null }
): ProjectVirtualAccount {
  assertDemoSimulationAllowed("Crediting demo funds");
  const account = getAccountChecked(user, accountId);
  assertBankingCapability(user, account.projectId, "MANAGE_PROJECT_ACCOUNT");
  if (account.status !== "ACTIVE") throw new BankingError("The account is not active", 409);
  const amount = wholeAmount(input.amount, "amount");
  if (amount === null || amount <= 0) throw new BankingError("amount must be a positive whole-currency amount", 400);
  const provider = resolveBankingProvider();
  const description = (input.description ?? "Demo funding credit").trim().slice(0, 200);
  const now = new Date().toISOString();
  const project = repo.getProject(account.projectId)!;
  const txId = brepo.newId();
  brepo.withBankingTx(() => {
    const credit = provider.creditDemoFunds({
      bankingProgramId: account.bankingProgramId,
      projectVirtualAccountId: account.id,
      amount,
      description,
    });
    brepo.insertTransaction({
      id: txId,
      projectVirtualAccountId: account.id,
      paymentInstructionId: null,
      providerTransactionReference: credit.providerTransactionReference,
      direction: "CREDIT",
      amount,
      currency: account.currency,
      status: "SETTLED",
      transactionType: "DEMO_DEPOSIT",
      initiatedAt: now,
      postedAt: now,
      settledAt: now,
      returnedAt: null,
      description,
      rawEventHash: brepo.sha256Hex(`demo-credit:${txId}`),
    });
    if (!brepo.adjustAccountBalances(account.id, { available_balance: amount, release_eligible_balance: amount })) {
      throw new BankingError("The account balance could not be updated", 409);
    }
    logBankingEvent({
      organizationId: project.organizationId,
      projectId: project.id,
      bankingProgramId: account.bankingProgramId,
      projectVirtualAccountId: account.id,
      bankTransactionId: txId,
      type: "DEMO_CREDIT_POSTED",
      detail: `Demo simulation only: ${description} (+${amount} ${account.currency}).`,
      actorUserId: user.id,
    });
  });
  return brepo.getAccount(account.id)!;
}

// -------------------------------------------------------------- holds

export function placeHold(
  user: User,
  accountId: string,
  input: { drawRequestId?: string | null; amount: unknown; reasonCode: string; reason?: string | null }
): ProjectAccountHold {
  const account = getAccountChecked(user, accountId);
  assertBankingCapability(user, account.projectId, "MANAGE_PROJECT_ACCOUNT");
  if (account.status !== "ACTIVE") throw new BankingError("The account is not active", 409);
  const amount = wholeAmount(input.amount, "amount");
  if (amount === null || amount <= 0) throw new BankingError("amount must be a positive whole-currency amount", 400);
  const reasonCode = (input.reasonCode ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40);
  if (!reasonCode) throw new BankingError("reasonCode is required", 400);
  const drawRequestId = (input.drawRequestId ?? "").toString().trim() || null;
  if (drawRequestId) {
    const draw = repo.getDrawRequest(drawRequestId);
    if (!draw || draw.projectId !== account.projectId) {
      throw new BankingError("drawRequestId must reference a draw of this project", 422);
    }
  }
  const provider = resolveBankingProvider();
  const now = new Date().toISOString();
  const project = repo.getProject(account.projectId)!;
  const hold: ProjectAccountHold = {
    id: brepo.newId(),
    projectVirtualAccountId: account.id,
    drawRequestId,
    amount,
    reasonCode,
    reason: (input.reason ?? "").toString().trim().slice(0, 300) || null,
    status: "ACTIVE",
    placedAt: now,
    releasedAt: null,
    placedByUserId: user.id,
    releasedByUserId: null,
    providerReference: null,
  };
  brepo.withBankingTx(() => {
    // Guarded move: available → held (and out of release-eligible). Fails
    // as one unit if unheld funds are insufficient.
    if (
      !brepo.adjustAccountBalances(account.id, {
        available_balance: -amount,
        held_balance: amount,
        release_eligible_balance: -amount,
      })
    ) {
      throw new BankingError("Insufficient unheld funds for this hold", 409);
    }
    hold.providerReference = provider.placeHold({
      holdId: hold.id,
      projectVirtualAccountId: account.id,
      amount,
      reasonCode,
    }).providerReference;
    brepo.insertHold(hold);
    logBankingEvent({
      organizationId: project.organizationId,
      projectId: project.id,
      bankingProgramId: account.bankingProgramId,
      projectVirtualAccountId: account.id,
      drawRequestId,
      type: "HOLD_PLACED",
      detail: `Hold of ${amount} ${account.currency} placed (${reasonCode}).`,
      actorUserId: user.id,
    });
  });
  return brepo.getHold(hold.id)!;
}

export function releaseHold(
  user: User,
  holdId: string,
  outcome: Exclude<AccountHoldStatus, "ACTIVE"> = "RELEASED"
): ProjectAccountHold {
  const hold = brepo.getHold(holdId);
  if (!hold) throw new BankingError("Hold not found", 404);
  const account = getAccountChecked(user, hold.projectVirtualAccountId);
  assertBankingCapability(user, account.projectId, "MANAGE_PROJECT_ACCOUNT");
  if (!["RELEASED", "CANCELLED", "EXPIRED"].includes(outcome)) {
    throw new BankingError("outcome must be RELEASED, CANCELLED or EXPIRED", 400);
  }
  const provider = resolveBankingProvider();
  const now = new Date().toISOString();
  const project = repo.getProject(account.projectId)!;
  brepo.withBankingTx(() => {
    // Exactly-once: the ACTIVE→terminal transition is the guard; the
    // balance move happens only when THIS caller won the transition.
    if (!brepo.transitionHoldGuarded(hold.id, outcome, user.id, now)) {
      throw new BankingError("The hold was already released (or released concurrently)", 409);
    }
    if (
      !brepo.adjustAccountBalances(account.id, {
        available_balance: hold.amount,
        held_balance: -hold.amount,
        release_eligible_balance: hold.amount,
      })
    ) {
      throw new BankingError("The account balance could not be updated", 409);
    }
    provider.releaseHold({ holdId: hold.id, providerReference: hold.providerReference });
    logBankingEvent({
      organizationId: project.organizationId,
      projectId: project.id,
      bankingProgramId: account.bankingProgramId,
      projectVirtualAccountId: account.id,
      drawRequestId: hold.drawRequestId,
      type: "HOLD_RELEASED",
      detail: `Hold of ${hold.amount} ${account.currency} ${outcome.toLowerCase()} (${hold.reasonCode}).`,
      actorUserId: user.id,
    });
  });
  return brepo.getHold(hold.id)!;
}
