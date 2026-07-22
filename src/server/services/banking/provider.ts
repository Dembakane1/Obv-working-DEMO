/**
 * Provider-neutral banking integration boundary.
 *
 * The BankingProvider interface is the ONLY doorway between OBV and the
 * partner bank / Banking-as-a-Service platform. OBV's verification,
 * governance and authorization rules live entirely OUTSIDE this boundary
 * and never change per provider. A provider adapter:
 *
 *   - creates program- and project-level account identities at the bank,
 *   - relays holds and payment instructions to the bank,
 *   - reports the bank's transaction events back (webhooks),
 *   - reports the bank's balances for reconciliation.
 *
 * The bank controls the money. OBV supplies verified construction truth
 * and governed release authorization. Nothing OBV records — verification,
 * lender review, approval, or a virtual ledger update — is proof that
 * real money moved; only a provider-confirmed settled bank transaction
 * represents completed movement of funds.
 *
 * This phase ships ONLY the deterministic MockBankingProvider. The Unit,
 * Treasury Prime and Qolo adapters are disabled boundaries (adapters.ts)
 * with no SDKs, credentials, network calls or production logic.
 */
import type {
  BankTransaction,
  BankingAccountStructure,
  BankingProgram,
  PaymentInstruction,
  ProjectVirtualAccount,
} from "../../../shared/types";

export class BankingProviderError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// ------------------------------------------------------------ IO types

export interface CreateProgramAccountInput {
  bankingProgramId: string;
  organizationId: string;
  partnerBankName: string;
  accountStructure: BankingAccountStructure;
  currency: string;
}

export interface ProgramAccountResult {
  providerProgramReference: string;
}

export interface CreateProjectVirtualAccountInput {
  bankingProgramId: string;
  projectVirtualAccountId: string;
  projectId: string;
  currency: string;
}

export interface ProjectVirtualAccountResult {
  providerAccountReference: string;
  /** MASKED identifiers only — a provider adapter must never hand OBV a
   *  full account or routing number to store. */
  virtualAccountNumberMasked: string;
  routingNumberMasked: string | null;
}

export interface ProjectAccountBalance {
  projectVirtualAccountId: string;
  availableBalance: number;
  heldBalance: number;
  asOf: string;
}

export interface PlaceHoldInput {
  holdId: string;
  projectVirtualAccountId: string;
  amount: number;
  reasonCode: string;
}

export interface ReleaseHoldInput {
  holdId: string;
  providerReference: string | null;
}

export interface HoldResult {
  providerReference: string;
}

export interface SubmitPaymentInstructionInput {
  paymentInstructionId: string;
  projectVirtualAccountId: string;
  amount: number;
  currency: string;
  recipientName: string;
  recipientReference: string | null;
  paymentMethod: string;
  idempotencyKey: string;
}

export interface SubmitPaymentInstructionResult {
  providerReference: string;
  /** The bank-side transaction opened for this submission (PENDING). */
  providerTransactionReference: string;
}

/** Normalized provider webhook. `rawPayload` is hashed by the provider —
 *  the raw body itself is never retained in application records. */
export interface BankingWebhookInput {
  /** Provider-unique event id — the idempotency handle. */
  eventId: string;
  eventType:
    | "transaction.posted"
    | "payment.settled"
    | "payment.failed"
    | "payment.returned"
    | "payment.reversed"
    | "account.credited";
  providerTransactionReference: string;
  rawPayload: string;
  failureCode?: string | null;
  failureReason?: string | null;
}

export interface BankingWebhookResult {
  eventId: string;
  duplicate: boolean;
  providerTransactionReference: string;
  eventType: BankingWebhookInput["eventType"];
  rawEventHash: string;
  failureCode: string | null;
  /** Sanitized, provider-neutral failure text (no raw provider payloads). */
  failureReason: string | null;
}

export interface ReconcileProgramInput {
  bankingProgramId: string;
  /** Demo-only forced mismatch: the mock bank reports its balance offset
   *  by this amount. Rejected outside demo mode. */
  demoForceMismatchAmount?: number | null;
}

export interface ProviderReconciliationReport {
  bankingProgramId: string;
  bankReportedBalance: number;
  bankTransactionCount: number;
  asOf: string;
}

export interface DemoCreditInput {
  bankingProgramId: string;
  projectVirtualAccountId: string;
  amount: number;
  description: string;
}

export interface DemoCreditResult {
  providerTransactionReference: string;
}

// ------------------------------------------------------------ interface

export interface BankingProvider {
  readonly kind: BankingProgram["provider"];
  createProgramAccount(input: CreateProgramAccountInput): ProgramAccountResult;
  createProjectVirtualAccount(input: CreateProjectVirtualAccountInput): ProjectVirtualAccountResult;
  getProjectVirtualAccount(id: string): ProjectVirtualAccount | null;
  getBalance(id: string): ProjectAccountBalance;
  placeHold(input: PlaceHoldInput): HoldResult;
  releaseHold(input: ReleaseHoldInput): HoldResult;
  /** Submit an APPROVED_FOR_SUBMISSION instruction to the bank. Opens a
   *  PENDING bank-side transaction; settlement arrives later as an event. */
  submitPaymentInstruction(input: SubmitPaymentInstructionInput): SubmitPaymentInstructionResult;
  cancelPaymentInstruction(instruction: PaymentInstruction): void;
  getTransaction(providerTransactionReference: string): BankTransaction | null;
  /** Validate + normalize a provider event. Pure with respect to OBV's
   *  ledger: applying the result to OBV records is the services' job. */
  processWebhook(input: BankingWebhookInput): BankingWebhookResult;
  /** The bank's own reported program balance for reconciliation. */
  reconcileProgram(input: ReconcileProgramInput): ProviderReconciliationReport;
  /** Demo-only seeded funding credit. Non-mock adapters must reject. */
  creditDemoFunds(input: DemoCreditInput): DemoCreditResult;
}
