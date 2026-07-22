/**
 * Payment instructions — the governed edge of the VAM foundation.
 *
 * A payment instruction is NOT a completed payment and NEVER becomes
 * SETTLED because an OBV user approved it. The lifecycle is:
 *
 *   PENDING_APPROVAL --approve (different authorized user)-->
 *   APPROVED_FOR_SUBMISSION --submit (demo simulation)-->
 *   SUBMITTED_TO_PROVIDER --provider events only-->
 *   PROCESSING / SETTLED / FAILED / RETURNED
 *
 * Release-eligibility boundary (create + re-validated at approve and at
 * submission): every check consumes the EXISTING authoritative services —
 * draw tenancy, formal governance (ApprovalRequest APPROVED), the current
 * fundable lender decision referencing that approval, decision
 * conditions, lien waivers, independent inspection acceptance under the
 * effective lender policy, jurisdictional completion gates, open critical
 * financial-integrity exceptions, reconciliation state, balances,
 * duplicates and idempotency. The label for a draw that passes is
 * "Eligible for payment instruction" — never "Paid", "Released",
 * "Settled" or "Funds transferred".
 *
 * Dual control (server-enforced, both authority modes):
 *   - creation and approval require distinct capabilities,
 *   - the instruction creator cannot be its final approver,
 *   - the draw submitter cannot approve a payment on their own draw,
 *   - the approval is a guarded exactly-once transition and the approval
 *     facts (who/when) are set once and never rewritten; the append-only
 *     banking event is the immutable approval record.
 */
import * as repo from "../../db/repo";
import * as lrepo from "../../db/lenderRepo";
import * as brepo from "../../db/bankingRepo";
import * as lenderDecisions from "../lenderDecisions";
import * as drawWorkflow from "../drawWorkflow";
import * as exceptions from "../exceptions";
import { makeWholeCurrency } from "../money";
import { BankingError, assertBankingCapability, assertProjectAccess } from "./bankingAccess";
import { assertDemoSimulationAllowed, resolveBankingProvider } from "./registry";
import { logBankingEvent } from "./projectAccounts";
import { reconciliationBlocked } from "./reconciliation";
import type {
  BankingWebhookInput,
} from "./provider";
import type {
  DrawRequest,
  LenderDrawDecision,
  PaymentInstruction,
  ProjectVirtualAccount,
  User,
} from "../../../shared/types";

const wholeAmount = makeWholeCurrency((m) => new BankingError(m, 400));

/** Instruction states that consume the lender-approved amount. FAILED,
 *  CANCELLED and RETURNED release their reservation (a return is a
 *  provider-confirmed round trip; paying again needs the full boundary
 *  to pass again, including the cap re-check). */
const CAP_CONSUMING: PaymentInstruction["status"][] = [
  "DRAFT", "PENDING_APPROVAL", "APPROVED_FOR_SUBMISSION", "SUBMITTED_TO_PROVIDER", "PROCESSING", "SETTLED",
];

const OUTSTANDING_WAIVER_STATES = ["REQUIRED", "REQUESTED", "RECEIVED", "UNDER_REVIEW", "REJECTED", "EXPIRED"];

export interface PaymentEligibility {
  eligible: boolean;
  /** Human-readable blockers, empty when eligible. */
  blockers: string[];
  decision: LenderDrawDecision | null;
  approvedRemaining: number | null;
}

/**
 * The full release-eligibility evaluation for a draw against its
 * project's virtual account. Consumes existing authoritative outputs
 * only; computes NO second verification or governance result.
 */
export function paymentEligibility(
  draw: DrawRequest,
  account: ProjectVirtualAccount | null,
  amount: number | null
): PaymentEligibility {
  const blockers: string[] = [];
  const approval = repo.getApprovalRequestForDraw(draw.id);
  if (!approval || approval.status !== "APPROVED") {
    blockers.push("Formal governance is not complete — the draw's approval request is not approved.");
  }
  const decision = lenderDecisions.currentDecision(draw.id);
  if (!decision) {
    blockers.push("No lender business decision is recorded for the draw.");
  } else {
    if (decision.supersededByDecisionId) {
      blockers.push("The lender decision has been superseded.");
    }
    if (!["APPROVED", "CONDITIONALLY_APPROVED", "REDUCED"].includes(decision.decision)) {
      blockers.push(`The current lender decision (${decision.decision}) is not fundable.`);
    }
    if (approval && approval.status === "APPROVED" && decision.approvalRequestId !== approval.id) {
      blockers.push("The lender decision does not reference the completed approval request.");
    }
    const blocking = lenderDecisions.blockingConditions(decision.id);
    if (blocking.length > 0) {
      blockers.push(`${blocking.length} decision condition(s) are not satisfied or waived.`);
    }
  }
  const project = repo.getProject(draw.projectId)!;
  const policy = lrepo.getEffectivePolicy(project.organizationId, project.id);
  if (policy?.independentInspectionRequired) {
    const inspections = lrepo.listDrawInspections(draw.id);
    const latest = inspections.length > 0 ? inspections[inspections.length - 1] : null;
    if (!latest || latest.status !== "FINALIZED" || latest.lenderAcceptanceStatus !== "ACCEPTED") {
      blockers.push("The required independent draw inspection is not finalized and lender-accepted.");
    }
  }
  if (!drawWorkflow.governmentInspectionsChecked(draw)) {
    blockers.push("Jurisdictional inspections/permits do not satisfy the existing completion gates.");
  }
  const outstandingWaivers = lrepo
    .listLienWaivers(draw.id)
    .filter((w) => OUTSTANDING_WAIVER_STATES.includes(w.status));
  if (outstandingWaivers.length > 0) {
    blockers.push(`${outstandingWaivers.length} required lien waiver(s) are not accepted.`);
  }
  const criticalIntegrity = repo
    .listExceptions()
    .filter(
      (e) =>
        e.projectId === draw.projectId &&
        exceptions.isOpen(e) &&
        e.severity === "CRITICAL" &&
        (e.category === "INTEGRITY" ||
          e.sourceType === "LEDGER_INTEGRITY" ||
          e.sourceType === "BANKING_RECONCILIATION")
    );
  if (criticalIntegrity.length > 0) {
    blockers.push("A critical financial-integrity exception is open for the project.");
  }
  let approvedRemaining: number | null = null;
  if (decision && decision.approvedAmount !== null) {
    const committed = brepo
      .listInstructionsForDraw(draw.id)
      .filter((i) => CAP_CONSUMING.includes(i.status))
      .reduce((sum, i) => sum + i.amount, 0);
    approvedRemaining = decision.approvedAmount - committed;
    if (amount !== null && amount > approvedRemaining) {
      blockers.push(
        `The requested amount (${amount}) exceeds the remaining lender-approved amount (${approvedRemaining}). Retainage held by the decision is never available to instructions.`
      );
    }
  } else if (decision) {
    blockers.push("The lender decision records no approved amount.");
  }
  if (!account) {
    blockers.push("The project has no active virtual account.");
  } else {
    if (account.status !== "ACTIVE") blockers.push("The project virtual account is not active.");
    if (reconciliationBlocked(account.bankingProgramId)) {
      blockers.push("Reconciliation mismatch — new payment work for the program is blocked.");
    }
    if (amount !== null && amount > account.releaseEligibleBalance) {
      blockers.push(
        `The requested amount (${amount}) exceeds the release-eligible balance (${account.releaseEligibleBalance}).`
      );
    }
  }
  return { eligible: blockers.length === 0, blockers, decision, approvedRemaining };
}

function assertEligible(draw: DrawRequest, account: ProjectVirtualAccount, amount: number): LenderDrawDecision {
  const result = paymentEligibility(draw, account, amount);
  if (!result.eligible) {
    throw new BankingError(`Not eligible for payment instruction: ${result.blockers[0]}`, 409);
  }
  return result.decision!;
}

function getDrawChecked(user: User, drawRequestId: string): DrawRequest {
  const draw = repo.getDrawRequest(drawRequestId);
  if (!draw) throw new BankingError("Draw request not found", 404);
  assertProjectAccess(user, draw.projectId);
  return draw;
}

function getInstructionChecked(user: User, instructionId: string): PaymentInstruction {
  const instruction = brepo.getInstruction(instructionId);
  if (!instruction) throw new BankingError("Payment instruction not found", 404);
  const account = brepo.getAccount(instruction.projectVirtualAccountId)!;
  assertProjectAccess(user, account.projectId);
  return instruction;
}

// ------------------------------------------------------------ creation

export function createPaymentInstruction(
  user: User,
  input: {
    drawRequestId: string;
    amount: unknown;
    recipientName: string;
    recipientReference?: string | null;
    paymentMethod?: string | null;
    idempotencyKey?: string | null;
  }
): PaymentInstruction {
  const draw = getDrawChecked(user, input.drawRequestId);
  assertBankingCapability(user, draw.projectId, "CREATE_PAYMENT_INSTRUCTION");
  const account = brepo.getOpenAccountForProject(draw.projectId);
  if (!account) throw new BankingError("The project has no active virtual account", 409);
  const amount = wholeAmount(input.amount, "amount");
  if (amount === null || amount <= 0) throw new BankingError("amount must be a positive whole-currency amount", 400);
  const recipientName = (input.recipientName ?? "").trim();
  if (!recipientName) throw new BankingError("recipientName is required", 400);
  const paymentMethod = (input.paymentMethod ?? "ACH_SIMULATED").trim().toUpperCase().slice(0, 30);
  const idempotencyKey = (input.idempotencyKey ?? "").trim() || brepo.newId();

  // Idempotency: an already-processed key returns the original record
  // when the request is byte-identical, and refuses otherwise. It never
  // creates a second instruction.
  const existingByKey = brepo.getInstructionByIdempotencyKey(idempotencyKey);
  if (existingByKey) {
    if (
      existingByKey.drawRequestId === draw.id &&
      existingByKey.amount === amount &&
      existingByKey.recipientName === recipientName
    ) {
      return existingByKey;
    }
    throw new BankingError("The idempotency key was already processed with different parameters", 409);
  }

  // Duplicate protection independent of the key: an equivalent
  // instruction that is still consuming the approved amount blocks a
  // second one.
  const duplicate = brepo
    .listInstructionsForDraw(draw.id)
    .find(
      (i) =>
        CAP_CONSUMING.includes(i.status) &&
        i.status !== "SETTLED" &&
        i.amount === amount &&
        i.recipientName.toLowerCase() === recipientName.toLowerCase()
    );
  if (duplicate) {
    throw new BankingError("An equivalent payment instruction is already in progress for this draw", 409);
  }

  const now = new Date().toISOString();
  let created: PaymentInstruction | null = null;
  brepo.withBankingTx(() => {
    // Full boundary INSIDE the write lock: governance, decision,
    // conditions, waivers, inspections, gates, exceptions,
    // reconciliation, cap and balance are all re-read here.
    const decision = assertEligible(draw, brepo.getAccount(account.id)!, amount);
    const approval = repo.getApprovalRequestForDraw(draw.id)!;
    const instruction: PaymentInstruction = {
      id: brepo.newId(),
      projectVirtualAccountId: account.id,
      drawRequestId: draw.id,
      lenderDecisionId: decision.id,
      approvalRequestId: approval.id,
      amount,
      currency: account.currency,
      recipientName,
      recipientReference: (input.recipientReference ?? "").toString().trim().slice(0, 100) || null,
      paymentMethod,
      status: "PENDING_APPROVAL",
      requestedByUserId: user.id,
      approvedByUserId: null,
      requestedAt: now,
      approvedAt: null,
      submittedAt: null,
      settledAt: null,
      failedAt: null,
      cancelledAt: null,
      providerReference: null,
      failureCode: null,
      failureReason: null,
      idempotencyKey,
    };
    // Earmark: creation reserves release-eligible funds (guarded ≥ 0).
    if (!brepo.adjustAccountBalances(account.id, { release_eligible_balance: -amount })) {
      throw new BankingError("Insufficient release-eligible balance for this instruction", 409);
    }
    brepo.insertInstruction(instruction);
    const project = repo.getProject(draw.projectId)!;
    logBankingEvent({
      organizationId: project.organizationId,
      projectId: project.id,
      bankingProgramId: account.bankingProgramId,
      projectVirtualAccountId: account.id,
      drawRequestId: draw.id,
      paymentInstructionId: instruction.id,
      type: "INSTRUCTION_CREATED",
      detail: `Payment instruction of ${amount} ${account.currency} to ${recipientName} created (${paymentMethod}); awaiting approval by a second authorized user.`,
      actorUserId: user.id,
    });
    created = instruction;
  });
  return created!;
}

// ------------------------------------------------------------ approval

export function approvePaymentInstruction(user: User, instructionId: string): PaymentInstruction {
  const instruction = getInstructionChecked(user, instructionId);
  const account = brepo.getAccount(instruction.projectVirtualAccountId)!;
  assertBankingCapability(user, account.projectId, "APPROVE_PAYMENT_INSTRUCTION");
  // Dual control — instance rules, enforced in both authority modes:
  if (instruction.requestedByUserId === user.id) {
    throw new BankingError("The instruction creator cannot be its final approver", 403);
  }
  const draw = repo.getDrawRequest(instruction.drawRequestId)!;
  if (draw.requestedByUserId === user.id) {
    throw new BankingError("The draw submitter cannot approve a payment instruction on their own draw", 403);
  }
  const now = new Date().toISOString();
  brepo.withBankingTx(() => {
    // The boundary is re-validated at approval: a decision supersede, a
    // reopened condition or a reconciliation mismatch committed after
    // creation is observed here and blocks with no mutation.
    assertEligible(draw, brepo.getAccount(account.id)!, 0);
    if (
      !brepo.transitionInstructionGuarded(instruction.id, ["PENDING_APPROVAL"], "APPROVED_FOR_SUBMISSION", {
        approvedByUserId: user.id,
        approvedAt: now,
      })
    ) {
      throw new BankingError("The instruction is not awaiting approval (or was decided concurrently)", 409);
    }
    const project = repo.getProject(account.projectId)!;
    logBankingEvent({
      organizationId: project.organizationId,
      projectId: project.id,
      bankingProgramId: account.bankingProgramId,
      projectVirtualAccountId: account.id,
      drawRequestId: draw.id,
      paymentInstructionId: instruction.id,
      type: "INSTRUCTION_APPROVED",
      detail: `Second-user approval recorded. Approval does NOT settle the payment — settlement can only come from a provider-confirmed bank transaction event.`,
      actorUserId: user.id,
    });
  });
  return brepo.getInstruction(instruction.id)!;
}

// ------------------------------------------------------------ cancel

export function cancelPaymentInstruction(
  user: User,
  instructionId: string,
  reason?: string | null
): PaymentInstruction {
  const instruction = getInstructionChecked(user, instructionId);
  const account = brepo.getAccount(instruction.projectVirtualAccountId)!;
  assertBankingCapability(user, account.projectId, "CANCEL_PAYMENT_INSTRUCTION");
  const now = new Date().toISOString();
  brepo.withBankingTx(() => {
    // Only pre-submission states are cancellable by OBV. After
    // submission, only provider events can terminate the payment.
    if (
      !brepo.transitionInstructionGuarded(
        instruction.id,
        ["DRAFT", "PENDING_APPROVAL", "APPROVED_FOR_SUBMISSION"],
        "CANCELLED",
        { cancelledAt: now, failureReason: (reason ?? "").toString().trim().slice(0, 300) || undefined }
      )
    ) {
      throw new BankingError(
        "Only an unsubmitted instruction can be cancelled — a submitted payment terminates via provider events",
        409
      );
    }
    // Release the creation earmark.
    if (!brepo.adjustAccountBalances(account.id, { release_eligible_balance: instruction.amount })) {
      throw new BankingError("The account balance could not be updated", 409);
    }
    resolveBankingProvider().cancelPaymentInstruction(instruction);
    const project = repo.getProject(account.projectId)!;
    logBankingEvent({
      organizationId: project.organizationId,
      projectId: project.id,
      bankingProgramId: account.bankingProgramId,
      projectVirtualAccountId: account.id,
      drawRequestId: instruction.drawRequestId,
      paymentInstructionId: instruction.id,
      type: "INSTRUCTION_CANCELLED",
      detail: `Payment instruction cancelled before submission.`,
      actorUserId: user.id,
    });
  });
  return brepo.getInstruction(instruction.id)!;
}

// ------------------------------------------- provider submission (demo)

export function submitPaymentInstruction(user: User, instructionId: string): PaymentInstruction {
  assertDemoSimulationAllowed("Simulating provider submission");
  const instruction = getInstructionChecked(user, instructionId);
  const account = brepo.getAccount(instruction.projectVirtualAccountId)!;
  assertBankingCapability(user, account.projectId, "CREATE_PAYMENT_INSTRUCTION");
  const draw = repo.getDrawRequest(instruction.drawRequestId)!;
  const provider = resolveBankingProvider();
  const now = new Date().toISOString();
  brepo.withBankingTx(() => {
    // Boundary re-validation at submission (including reconciliation
    // blocking), then the guarded exactly-once transition.
    assertEligible(draw, brepo.getAccount(account.id)!, 0);
    const submission = provider.submitPaymentInstruction({
      paymentInstructionId: instruction.id,
      projectVirtualAccountId: account.id,
      amount: instruction.amount,
      currency: instruction.currency,
      recipientName: instruction.recipientName,
      recipientReference: instruction.recipientReference,
      paymentMethod: instruction.paymentMethod,
      idempotencyKey: instruction.idempotencyKey,
    });
    if (
      !brepo.transitionInstructionGuarded(instruction.id, ["APPROVED_FOR_SUBMISSION"], "SUBMITTED_TO_PROVIDER", {
        submittedAt: now,
        providerReference: submission.providerReference,
      })
    ) {
      throw new BankingError("Only an approved instruction can be submitted (or it was submitted concurrently)", 409);
    }
    // Funds leave the spendable ledger and become in-flight outbound.
    if (
      !brepo.adjustAccountBalances(account.id, {
        available_balance: -instruction.amount,
        pending_outbound_amount: instruction.amount,
      })
    ) {
      throw new BankingError("Insufficient available balance to submit this instruction", 409);
    }
    const txId = brepo.newId();
    brepo.insertTransaction({
      id: txId,
      projectVirtualAccountId: account.id,
      paymentInstructionId: instruction.id,
      providerTransactionReference: submission.providerTransactionReference,
      direction: "DEBIT",
      amount: instruction.amount,
      currency: instruction.currency,
      status: "PENDING",
      transactionType: instruction.paymentMethod,
      initiatedAt: now,
      postedAt: null,
      settledAt: null,
      returnedAt: null,
      description: `Payment to ${instruction.recipientName}`,
      rawEventHash: null,
    });
    const project = repo.getProject(account.projectId)!;
    logBankingEvent({
      organizationId: project.organizationId,
      projectId: project.id,
      bankingProgramId: account.bankingProgramId,
      projectVirtualAccountId: account.id,
      drawRequestId: draw.id,
      paymentInstructionId: instruction.id,
      bankTransactionId: txId,
      type: "PROVIDER_SUBMISSION_SIMULATED",
      detail: `Demo simulation only: instruction submitted to the ${provider.kind} provider; bank transaction opened PENDING.`,
      actorUserId: user.id,
    });
  });
  return brepo.getInstruction(instruction.id)!;
}

// --------------------------------------------- provider events (demo)

export type SimulatedProviderEvent = "posted" | "settled" | "failed" | "returned" | "reversed";

/**
 * Process a simulated provider event for an instruction's bank
 * transaction. Settlement truth lives HERE and only here: no OBV
 * approval path can mark anything settled.
 */
export function processProviderEvent(
  user: User,
  instructionId: string,
  event: SimulatedProviderEvent,
  input: { eventId?: string | null; failureCode?: string | null; failureReason?: string | null } = {}
): PaymentInstruction {
  assertDemoSimulationAllowed("Simulating a provider event");
  const instruction = getInstructionChecked(user, instructionId);
  const account = brepo.getAccount(instruction.projectVirtualAccountId)!;
  assertBankingCapability(user, account.projectId, "MANAGE_PROJECT_ACCOUNT");
  const txns = brepo.listTransactionsForInstruction(instruction.id);
  const txn = txns.length > 0 ? txns[txns.length - 1] : null;
  if (!txn) throw new BankingError("The instruction has no bank transaction — submit it to the provider first", 409);
  const provider = resolveBankingProvider();
  const eventId = (input.eventId ?? "").toString().trim() || `demo-${event}-${txn.id}`;
  const eventType: BankingWebhookInput["eventType"] =
    event === "posted" ? "transaction.posted"
    : event === "settled" ? "payment.settled"
    : event === "failed" ? "payment.failed"
    : event === "returned" ? "payment.returned"
    : "payment.reversed";
  const now = new Date().toISOString();
  const project = repo.getProject(account.projectId)!;

  brepo.withBankingTx(() => {
    const webhook = provider.processWebhook({
      eventId,
      eventType,
      providerTransactionReference: txn.providerTransactionReference,
      rawPayload: JSON.stringify({ eventId, eventType, reference: txn.providerTransactionReference }),
      failureCode: input.failureCode ?? null,
      failureReason: input.failureReason ?? null,
    });
    if (webhook.duplicate) return; // idempotent replay — nothing changes

    const amount = txn.amount;
    let applied = false;
    switch (eventType) {
      case "transaction.posted": {
        applied = brepo.transitionTransactionGuarded(txn.id, ["PENDING"], "POSTED", {
          postedAt: now,
          rawEventHash: webhook.rawEventHash,
        });
        if (applied) {
          brepo.transitionInstructionGuarded(instruction.id, ["SUBMITTED_TO_PROVIDER"], "PROCESSING", {});
          logBankingEvent({
            organizationId: project.organizationId, projectId: project.id,
            bankingProgramId: account.bankingProgramId, projectVirtualAccountId: account.id,
            drawRequestId: instruction.drawRequestId, paymentInstructionId: instruction.id,
            bankTransactionId: txn.id, type: "TRANSACTION_POSTED",
            detail: "Bank reported the transaction as posted.", actorUserId: user.id,
          });
        }
        break;
      }
      case "payment.settled": {
        applied = brepo.transitionTransactionGuarded(txn.id, ["PENDING", "POSTED"], "SETTLED", {
          settledAt: now,
          rawEventHash: webhook.rawEventHash,
        });
        if (applied) {
          if (
            !brepo.transitionInstructionGuarded(
              instruction.id,
              ["SUBMITTED_TO_PROVIDER", "PROCESSING"],
              "SETTLED",
              { settledAt: now }
            )
          ) {
            throw new BankingError("The instruction is not in a settleable state", 409);
          }
          if (
            !brepo.adjustAccountBalances(account.id, {
              pending_outbound_amount: -amount,
              settled_outbound_amount: amount,
            })
          ) {
            throw new BankingError("The account balance could not be updated", 409);
          }
          logBankingEvent({
            organizationId: project.organizationId, projectId: project.id,
            bankingProgramId: account.bankingProgramId, projectVirtualAccountId: account.id,
            drawRequestId: instruction.drawRequestId, paymentInstructionId: instruction.id,
            bankTransactionId: txn.id, type: "SETTLEMENT_RECORDED",
            detail: `Provider-confirmed settlement of ${amount} ${txn.currency}. This event — not any OBV approval — is the only settlement truth.`,
            actorUserId: user.id,
          });
        }
        break;
      }
      case "payment.failed": {
        applied = brepo.transitionTransactionGuarded(txn.id, ["PENDING", "POSTED"], "FAILED", {
          rawEventHash: webhook.rawEventHash,
        });
        if (applied) {
          brepo.transitionInstructionGuarded(
            instruction.id,
            ["SUBMITTED_TO_PROVIDER", "PROCESSING"],
            "FAILED",
            {
              failedAt: now,
              failureCode: webhook.failureCode ?? "PROVIDER_FAILURE",
              failureReason: webhook.failureReason ?? "The provider reported the payment as failed.",
            }
          );
          // In-flight funds never left the bank: back to spendable.
          if (
            !brepo.adjustAccountBalances(account.id, {
              pending_outbound_amount: -amount,
              available_balance: amount,
              release_eligible_balance: amount,
            })
          ) {
            throw new BankingError("The account balance could not be updated", 409);
          }
          logBankingEvent({
            organizationId: project.organizationId, projectId: project.id,
            bankingProgramId: account.bankingProgramId, projectVirtualAccountId: account.id,
            drawRequestId: instruction.drawRequestId, paymentInstructionId: instruction.id,
            bankTransactionId: txn.id, type: "PAYMENT_FAILED",
            detail: `Provider reported the payment failed (${webhook.failureCode ?? "PROVIDER_FAILURE"}).`,
            actorUserId: user.id,
          });
        }
        break;
      }
      case "payment.returned": {
        applied = brepo.transitionTransactionGuarded(txn.id, ["SETTLED"], "RETURNED", {
          returnedAt: now,
          rawEventHash: webhook.rawEventHash,
        });
        if (applied) {
          brepo.transitionInstructionGuarded(instruction.id, ["SETTLED"], "RETURNED", {
            failureCode: webhook.failureCode ?? "RETURNED",
            failureReason: webhook.failureReason ?? "The provider returned the settled payment.",
          });
          if (
            !brepo.adjustAccountBalances(account.id, {
              available_balance: amount,
              release_eligible_balance: amount,
              returned_amount: amount,
            })
          ) {
            throw new BankingError("The account balance could not be updated", 409);
          }
          logBankingEvent({
            organizationId: project.organizationId, projectId: project.id,
            bankingProgramId: account.bankingProgramId, projectVirtualAccountId: account.id,
            drawRequestId: instruction.drawRequestId, paymentInstructionId: instruction.id,
            bankTransactionId: txn.id, type: "PAYMENT_RETURNED",
            detail: `Provider returned the settled payment of ${amount} ${txn.currency}.`,
            actorUserId: user.id,
          });
        }
        break;
      }
      case "payment.reversed": {
        applied = brepo.transitionTransactionGuarded(txn.id, ["SETTLED"], "REVERSED", {
          returnedAt: now,
          rawEventHash: webhook.rawEventHash,
        });
        if (applied) {
          brepo.transitionInstructionGuarded(instruction.id, ["SETTLED"], "RETURNED", {
            failureCode: webhook.failureCode ?? "REVERSED",
            failureReason: webhook.failureReason ?? "The provider reversed the settled transaction.",
          });
          if (
            !brepo.adjustAccountBalances(account.id, {
              available_balance: amount,
              release_eligible_balance: amount,
              settled_outbound_amount: -amount,
            })
          ) {
            throw new BankingError("The account balance could not be updated", 409);
          }
          logBankingEvent({
            organizationId: project.organizationId, projectId: project.id,
            bankingProgramId: account.bankingProgramId, projectVirtualAccountId: account.id,
            drawRequestId: instruction.drawRequestId, paymentInstructionId: instruction.id,
            bankTransactionId: txn.id, type: "PAYMENT_REVERSED",
            detail: `Provider reversed the settled transaction of ${amount} ${txn.currency}.`,
            actorUserId: user.id,
          });
        }
        break;
      }
      default:
        break;
    }
    if (!applied) {
      throw new BankingError(
        `The ${event} event does not apply to the transaction's current state (${txn.status})`,
        409
      );
    }
    logBankingEvent({
      organizationId: project.organizationId, projectId: project.id,
      bankingProgramId: account.bankingProgramId, projectVirtualAccountId: account.id,
      drawRequestId: instruction.drawRequestId, paymentInstructionId: instruction.id,
      bankTransactionId: txn.id, type: "PROVIDER_EVENT_PROCESSED",
      detail: `Provider event ${eventType} (${eventId}) processed exactly once.`,
      actorUserId: user.id,
    });
  });
  return brepo.getInstruction(instruction.id)!;
}
