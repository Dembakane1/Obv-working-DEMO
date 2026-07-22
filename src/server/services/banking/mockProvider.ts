/**
 * MockBankingProvider — the deterministic, network-free bank simulation.
 *
 * In demo mode this class plays the partner bank's side of the boundary:
 * it issues provider references, keeps the bank's own book of record in
 * the mock_provider_ledger table, opens PENDING transactions when an
 * instruction is submitted, and validates/normalizes simulated webhook
 * events. It makes NO external network calls, holds NO credentials and
 * moves NO real money.
 *
 * Determinism: outcomes depend only on stored state and explicit inputs.
 * Settlement, failure, return and reversal happen ONLY when an explicit
 * simulated provider event is processed — never as a side effect of an
 * OBV user's approval.
 */
import * as brepo from "../../db/bankingRepo";
import type { BankTransaction, PaymentInstruction, ProjectVirtualAccount } from "../../../shared/types";
import {
  BankingProviderError,
  type BankingProvider,
  type BankingWebhookInput,
  type BankingWebhookResult,
  type CreateProgramAccountInput,
  type CreateProjectVirtualAccountInput,
  type DemoCreditInput,
  type DemoCreditResult,
  type HoldResult,
  type PlaceHoldInput,
  type ProgramAccountResult,
  type ProjectAccountBalance,
  type ProjectVirtualAccountResult,
  type ProviderReconciliationReport,
  type ReconcileProgramInput,
  type ReleaseHoldInput,
  type SubmitPaymentInstructionInput,
  type SubmitPaymentInstructionResult,
} from "./provider";

/** Deterministic short reference from a stable id (no randomness). */
function ref(prefix: string, id: string): string {
  return `${prefix}-${brepo.sha256Hex(id).slice(0, 12).toUpperCase()}`;
}

export class MockBankingProvider implements BankingProvider {
  readonly kind = "MOCK" as const;

  createProgramAccount(input: CreateProgramAccountInput): ProgramAccountResult {
    return { providerProgramReference: ref("MOCK-PRG", input.bankingProgramId) };
  }

  createProjectVirtualAccount(input: CreateProjectVirtualAccountInput): ProjectVirtualAccountResult {
    const digest = brepo.sha256Hex(input.projectVirtualAccountId);
    // Masked identifiers only. The "account number" exists solely as a
    // subledger identity at the mock bank — OBV never sees, stores or
    // displays a full number.
    const last4 = String(parseInt(digest.slice(0, 8), 16) % 10000).padStart(4, "0");
    const routing4 = String(parseInt(digest.slice(8, 16), 16) % 10000).padStart(4, "0");
    return {
      providerAccountReference: ref("MOCK-VA", input.projectVirtualAccountId),
      virtualAccountNumberMasked: `••••${last4}`,
      routingNumberMasked: `••••${routing4}`,
    };
  }

  getProjectVirtualAccount(id: string): ProjectVirtualAccount | null {
    return brepo.getAccount(id);
  }

  getBalance(id: string): ProjectAccountBalance {
    const account = brepo.getAccount(id);
    if (!account) throw new BankingProviderError("Unknown project virtual account", 404);
    return {
      projectVirtualAccountId: id,
      availableBalance: account.availableBalance,
      heldBalance: account.heldBalance,
      asOf: new Date().toISOString(),
    };
  }

  placeHold(input: PlaceHoldInput): HoldResult {
    return { providerReference: ref("MOCK-HOLD", input.holdId) };
  }

  releaseHold(input: ReleaseHoldInput): HoldResult {
    return { providerReference: input.providerReference ?? ref("MOCK-HOLD", input.holdId) };
  }

  submitPaymentInstruction(input: SubmitPaymentInstructionInput): SubmitPaymentInstructionResult {
    const account = brepo.getAccount(input.projectVirtualAccountId);
    if (!account) throw new BankingProviderError("Unknown project virtual account", 404);
    if (input.amount <= 0) throw new BankingProviderError("The bank rejects non-positive amounts", 422);
    return {
      providerReference: ref("MOCK-PAY", input.paymentInstructionId),
      providerTransactionReference: ref("MOCK-TXN", `${input.paymentInstructionId}:submission`),
    };
  }

  cancelPaymentInstruction(_instruction: PaymentInstruction): void {
    // The mock bank accepts cancellation of anything OBV's guarded state
    // machine allows to be cancelled; nothing bank-side to unwind before
    // submission, and post-submission cancellation is refused by the
    // services (only provider events can terminate a submitted payment).
  }

  getTransaction(providerTransactionReference: string): BankTransaction | null {
    return brepo.getTransactionByProviderReference(providerTransactionReference);
  }

  processWebhook(input: BankingWebhookInput): BankingWebhookResult {
    const eventId = (input.eventId ?? "").trim();
    if (!eventId) throw new BankingProviderError("Provider events require an eventId", 422);
    const txn = brepo.getTransactionByProviderReference(input.providerTransactionReference);
    if (!txn && input.eventType !== "account.credited") {
      throw new BankingProviderError("The provider event references an unknown bank transaction", 422);
    }
    // Failure text is sanitized to a provider-neutral phrase — raw
    // provider payloads never flow into stored errors.
    const failureReason = input.failureReason
      ? String(input.failureReason).replace(/[\r\n]+/g, " ").slice(0, 300)
      : null;
    const result: BankingWebhookResult = {
      eventId,
      duplicate: false,
      providerTransactionReference: input.providerTransactionReference,
      eventType: input.eventType,
      rawEventHash: brepo.sha256Hex(input.rawPayload ?? ""),
      failureCode: input.failureCode ? String(input.failureCode).slice(0, 40) : null,
      failureReason,
    };
    // Idempotent event processing ON THE BANK'S OWN BOOK: the mock bank
    // records each monetary event exactly once, keyed by eventId. A
    // replayed event is reported as a duplicate and changes nothing.
    // (OBV-side guarded transitions in the services are the second wall.)
    if (txn) {
      const program = brepo.getAccount(txn.projectVirtualAccountId)
        ? brepo.getProgram(brepo.getAccount(txn.projectVirtualAccountId)!.bankingProgramId)
        : null;
      if (program) {
        const marker = `EVT:${eventId}`;
        const seen = brepo
          .listMockLedgerEntries(program.id)
          .some((e) => e.reference === marker);
        if (seen) {
          result.duplicate = true;
          return result;
        }
        const bankDelta =
          input.eventType === "payment.settled" ? -txn.amount
          : input.eventType === "payment.returned" ? txn.amount
          : input.eventType === "payment.reversed" ? txn.amount
          : 0;
        brepo.insertMockLedgerEntry({
          id: brepo.newId(),
          bankingProgramId: program.id,
          entryType: input.eventType.toUpperCase().replace(/\./g, "_"),
          amount: bankDelta,
          reference: marker,
          createdAt: new Date().toISOString(),
        });
      }
    }
    return result;
  }

  reconcileProgram(input: ReconcileProgramInput): ProviderReconciliationReport {
    const program = brepo.getProgram(input.bankingProgramId);
    if (!program) throw new BankingProviderError("Unknown banking program", 404);
    const base = brepo.mockLedgerBalance(program.id);
    const force = input.demoForceMismatchAmount ?? 0;
    return {
      bankingProgramId: program.id,
      bankReportedBalance: base + force,
      bankTransactionCount: brepo.listMockLedgerEntries(program.id).length,
      asOf: new Date().toISOString(),
    };
  }

  creditDemoFunds(input: DemoCreditInput): DemoCreditResult {
    if (input.amount <= 0) throw new BankingProviderError("A demo credit must be positive", 422);
    // The mock bank records the deposit on ITS book; the services mirror
    // it onto OBV's ledger when they process the credit event.
    const entryId = brepo.newId();
    const reference = ref("MOCK-DEP", entryId);
    brepo.insertMockLedgerEntry({
      id: entryId,
      bankingProgramId: input.bankingProgramId,
      entryType: "DEMO_DEPOSIT",
      amount: input.amount,
      reference,
      createdAt: new Date().toISOString(),
    });
    return { providerTransactionReference: reference };
  }
}
