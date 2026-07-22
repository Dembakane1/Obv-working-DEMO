/**
 * VAM foundation — banking repository.
 *
 * Additive module: all SQL for the banking layer lives here so the core
 * repo remains untouched. Conventions match lenderRepo: snake_case
 * columns, hand row-mapping, ISO string timestamps, whole-currency
 * INTEGER amounts. banking_events is append-only — no update or delete
 * functions exist for it. Balance mutations are GUARDED single UPDATE
 * statements (arithmetic + precondition in one statement) so a stale
 * read can never drive an account negative or double-apply a change.
 *
 * Nothing in this module moves money. These tables are OBV's bookkeeping
 * about an external partner bank; the mock provider simulates the bank's
 * side in demo mode.
 */
import { randomUUID, createHash } from "node:crypto";
import { getDb } from "./index";
import type {
  AccountHoldStatus,
  BankTransaction,
  BankingEvent,
  BankingEventType,
  BankingProgram,
  PaymentInstruction,
  PaymentInstructionStatus,
  ProjectAccountHold,
  ProjectVirtualAccount,
  ReconciliationRun,
} from "../../shared/types";

type Row = Record<string, unknown>;

export function newId(): string {
  return randomUUID();
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// ------------------------------------------------------------ programs

function toProgram(r: Row): BankingProgram {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    provider: String(r.provider) as BankingProgram["provider"],
    providerProgramReference: s(r.provider_program_reference),
    partnerBankName: String(r.partner_bank_name),
    accountStructure: String(r.account_structure) as BankingProgram["accountStructure"],
    status: String(r.status) as BankingProgram["status"],
    currency: String(r.currency),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    activatedAt: s(r.activated_at),
    suspendedAt: s(r.suspended_at),
    metadata: s(r.metadata),
    createdByUserId: String(r.created_by_user_id),
  };
}

export function insertProgram(p: BankingProgram): void {
  getDb()
    .prepare(
      `INSERT INTO banking_programs (id, organization_id, provider, provider_program_reference,
        partner_bank_name, account_structure, status, currency, created_at, updated_at,
        activated_at, suspended_at, metadata, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.id, p.organizationId, p.provider, p.providerProgramReference, p.partnerBankName,
      p.accountStructure, p.status, p.currency, p.createdAt, p.updatedAt,
      p.activatedAt, p.suspendedAt, p.metadata, p.createdByUserId
    );
}

export function getProgram(id: string): BankingProgram | null {
  const r = getDb().prepare(`SELECT * FROM banking_programs WHERE id = ?`).get(id) as Row | undefined;
  return r ? toProgram(r) : null;
}

export function listProgramsForOrganization(organizationId: string): BankingProgram[] {
  return (getDb()
    .prepare(`SELECT * FROM banking_programs WHERE organization_id = ? ORDER BY created_at`)
    .all(organizationId) as Row[]).map(toProgram);
}

export function updateProgramStatus(
  id: string,
  status: BankingProgram["status"],
  patch: { activatedAt?: string | null; suspendedAt?: string | null }
): void {
  getDb()
    .prepare(
      `UPDATE banking_programs SET status = ?, updated_at = ?,
        activated_at = COALESCE(?, activated_at),
        suspended_at = COALESCE(?, suspended_at)
       WHERE id = ?`
    )
    .run(status, new Date().toISOString(), patch.activatedAt ?? null, patch.suspendedAt ?? null, id);
}

// ------------------------------------------------------ project accounts

function toAccount(r: Row): ProjectVirtualAccount {
  return {
    id: String(r.id),
    bankingProgramId: String(r.banking_program_id),
    projectId: String(r.project_id),
    providerAccountReference: s(r.provider_account_reference),
    virtualAccountNumberMasked: String(r.virtual_account_number_masked),
    routingNumberMasked: s(r.routing_number_masked),
    currency: String(r.currency),
    status: String(r.status) as ProjectVirtualAccount["status"],
    availableBalance: num(r.available_balance),
    heldBalance: num(r.held_balance),
    releaseEligibleBalance: num(r.release_eligible_balance),
    pendingOutboundAmount: num(r.pending_outbound_amount),
    settledOutboundAmount: num(r.settled_outbound_amount),
    returnedAmount: num(r.returned_amount),
    createdAt: String(r.created_at),
    activatedAt: s(r.activated_at),
    suspendedAt: s(r.suspended_at),
    closedAt: s(r.closed_at),
    lastReconciledAt: s(r.last_reconciled_at),
  };
}

export function insertAccount(a: ProjectVirtualAccount): void {
  getDb()
    .prepare(
      `INSERT INTO project_virtual_accounts (id, banking_program_id, project_id,
        provider_account_reference, virtual_account_number_masked, routing_number_masked,
        currency, status, available_balance, held_balance, release_eligible_balance,
        pending_outbound_amount, settled_outbound_amount, returned_amount,
        created_at, activated_at, suspended_at, closed_at, last_reconciled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      a.id, a.bankingProgramId, a.projectId, a.providerAccountReference,
      a.virtualAccountNumberMasked, a.routingNumberMasked, a.currency, a.status,
      a.availableBalance, a.heldBalance, a.releaseEligibleBalance,
      a.pendingOutboundAmount, a.settledOutboundAmount, a.returnedAmount,
      a.createdAt, a.activatedAt, a.suspendedAt, a.closedAt, a.lastReconciledAt
    );
}

export function getAccount(id: string): ProjectVirtualAccount | null {
  const r = getDb().prepare(`SELECT * FROM project_virtual_accounts WHERE id = ?`).get(id) as Row | undefined;
  return r ? toAccount(r) : null;
}

/** The project's single non-closed account (or null). */
export function getOpenAccountForProject(projectId: string): ProjectVirtualAccount | null {
  const r = getDb()
    .prepare(`SELECT * FROM project_virtual_accounts WHERE project_id = ? AND status != 'CLOSED'`)
    .get(projectId) as Row | undefined;
  return r ? toAccount(r) : null;
}

export function listAccountsForProgram(bankingProgramId: string): ProjectVirtualAccount[] {
  return (getDb()
    .prepare(`SELECT * FROM project_virtual_accounts WHERE banking_program_id = ? ORDER BY created_at`)
    .all(bankingProgramId) as Row[]).map(toAccount);
}

export function updateAccountStatus(
  id: string,
  status: ProjectVirtualAccount["status"],
  patch: { activatedAt?: string | null; suspendedAt?: string | null; closedAt?: string | null }
): void {
  getDb()
    .prepare(
      `UPDATE project_virtual_accounts SET status = ?,
        activated_at = COALESCE(?, activated_at),
        suspended_at = COALESCE(?, suspended_at),
        closed_at = COALESCE(?, closed_at)
       WHERE id = ?`
    )
    .run(status, patch.activatedAt ?? null, patch.suspendedAt ?? null, patch.closedAt ?? null, id);
}

export function touchAccountReconciledAt(id: string, at: string): void {
  getDb().prepare(`UPDATE project_virtual_accounts SET last_reconciled_at = ? WHERE id = ?`).run(at, id);
}

/**
 * Guarded balance arithmetic. Each mutation is ONE UPDATE whose WHERE
 * clause re-checks the precondition, so concurrent or stale callers get
 * `false` (no change) instead of a negative balance or double-apply.
 * Deltas are applied to the named columns; `require` lists columns that
 * must remain >= 0 after the change.
 */
export function adjustAccountBalances(
  id: string,
  deltas: Partial<
    Record<
      | "available_balance"
      | "held_balance"
      | "release_eligible_balance"
      | "pending_outbound_amount"
      | "settled_outbound_amount"
      | "returned_amount",
      number
    >
  >
): boolean {
  const cols = Object.keys(deltas) as Array<keyof typeof deltas>;
  if (cols.length === 0) return true;
  const set = cols.map((c) => `${c} = ${c} + ?`).join(", ");
  // Non-negativity is enforced for every adjusted column.
  const guard = cols.map((c) => `${c} + ? >= 0`).join(" AND ");
  const setVals = cols.map((c) => deltas[c]!);
  const guardVals = cols.map((c) => deltas[c]!);
  const res = getDb()
    .prepare(`UPDATE project_virtual_accounts SET ${set} WHERE id = ? AND status = 'ACTIVE' AND ${guard}`)
    .run(...setVals, id, ...guardVals);
  return Number(res.changes) === 1;
}

// -------------------------------------------------------------- holds

function toHold(r: Row): ProjectAccountHold {
  return {
    id: String(r.id),
    projectVirtualAccountId: String(r.project_virtual_account_id),
    drawRequestId: s(r.draw_request_id),
    amount: num(r.amount),
    reasonCode: String(r.reason_code),
    reason: s(r.reason),
    status: String(r.status) as AccountHoldStatus,
    placedAt: String(r.placed_at),
    releasedAt: s(r.released_at),
    placedByUserId: String(r.placed_by_user_id),
    releasedByUserId: s(r.released_by_user_id),
    providerReference: s(r.provider_reference),
  };
}

export function insertHold(h: ProjectAccountHold): void {
  getDb()
    .prepare(
      `INSERT INTO project_account_holds (id, project_virtual_account_id, draw_request_id,
        amount, reason_code, reason, status, placed_at, released_at,
        placed_by_user_id, released_by_user_id, provider_reference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      h.id, h.projectVirtualAccountId, h.drawRequestId, h.amount, h.reasonCode, h.reason,
      h.status, h.placedAt, h.releasedAt, h.placedByUserId, h.releasedByUserId, h.providerReference
    );
}

export function getHold(id: string): ProjectAccountHold | null {
  const r = getDb().prepare(`SELECT * FROM project_account_holds WHERE id = ?`).get(id) as Row | undefined;
  return r ? toHold(r) : null;
}

export function listHoldsForAccount(accountId: string): ProjectAccountHold[] {
  return (getDb()
    .prepare(`SELECT * FROM project_account_holds WHERE project_virtual_account_id = ? ORDER BY placed_at`)
    .all(accountId) as Row[]).map(toHold);
}

/** Guarded ACTIVE → terminal transition; false when already transitioned. */
export function transitionHoldGuarded(
  id: string,
  toStatus: Exclude<AccountHoldStatus, "ACTIVE">,
  releasedByUserId: string,
  releasedAt: string
): boolean {
  const res = getDb()
    .prepare(
      `UPDATE project_account_holds SET status = ?, released_at = ?, released_by_user_id = ?
       WHERE id = ? AND status = 'ACTIVE'`
    )
    .run(toStatus, releasedAt, releasedByUserId, id);
  return Number(res.changes) === 1;
}

// ------------------------------------------------------- instructions

function toInstruction(r: Row): PaymentInstruction {
  return {
    id: String(r.id),
    projectVirtualAccountId: String(r.project_virtual_account_id),
    drawRequestId: String(r.draw_request_id),
    lenderDecisionId: String(r.lender_decision_id),
    approvalRequestId: String(r.approval_request_id),
    amount: num(r.amount),
    currency: String(r.currency),
    recipientName: String(r.recipient_name),
    recipientReference: s(r.recipient_reference),
    paymentMethod: String(r.payment_method),
    status: String(r.status) as PaymentInstructionStatus,
    requestedByUserId: String(r.requested_by_user_id),
    approvedByUserId: s(r.approved_by_user_id),
    requestedAt: String(r.requested_at),
    approvedAt: s(r.approved_at),
    submittedAt: s(r.submitted_at),
    settledAt: s(r.settled_at),
    failedAt: s(r.failed_at),
    cancelledAt: s(r.cancelled_at),
    providerReference: s(r.provider_reference),
    failureCode: s(r.failure_code),
    failureReason: s(r.failure_reason),
    idempotencyKey: String(r.idempotency_key),
  };
}

export function insertInstruction(i: PaymentInstruction): void {
  getDb()
    .prepare(
      `INSERT INTO payment_instructions (id, project_virtual_account_id, draw_request_id,
        lender_decision_id, approval_request_id, amount, currency, recipient_name,
        recipient_reference, payment_method, status, requested_by_user_id, approved_by_user_id,
        requested_at, approved_at, submitted_at, settled_at, failed_at, cancelled_at,
        provider_reference, failure_code, failure_reason, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      i.id, i.projectVirtualAccountId, i.drawRequestId, i.lenderDecisionId, i.approvalRequestId,
      i.amount, i.currency, i.recipientName, i.recipientReference, i.paymentMethod, i.status,
      i.requestedByUserId, i.approvedByUserId, i.requestedAt, i.approvedAt, i.submittedAt,
      i.settledAt, i.failedAt, i.cancelledAt, i.providerReference, i.failureCode,
      i.failureReason, i.idempotencyKey
    );
}

export function getInstruction(id: string): PaymentInstruction | null {
  const r = getDb().prepare(`SELECT * FROM payment_instructions WHERE id = ?`).get(id) as Row | undefined;
  return r ? toInstruction(r) : null;
}

export function getInstructionByIdempotencyKey(key: string): PaymentInstruction | null {
  const r = getDb().prepare(`SELECT * FROM payment_instructions WHERE idempotency_key = ?`).get(key) as
    | Row
    | undefined;
  return r ? toInstruction(r) : null;
}

export function listInstructionsForAccount(accountId: string): PaymentInstruction[] {
  return (getDb()
    .prepare(`SELECT * FROM payment_instructions WHERE project_virtual_account_id = ? ORDER BY requested_at`)
    .all(accountId) as Row[]).map(toInstruction);
}

export function listInstructionsForDraw(drawRequestId: string): PaymentInstruction[] {
  return (getDb()
    .prepare(`SELECT * FROM payment_instructions WHERE draw_request_id = ? ORDER BY requested_at`)
    .all(drawRequestId) as Row[]).map(toInstruction);
}

/**
 * Guarded status transition: succeeds only from one of `fromStatuses`
 * (exactly-once approve / submit / settle / cancel). Optional field patch
 * applies with the transition atomically.
 */
export function transitionInstructionGuarded(
  id: string,
  fromStatuses: PaymentInstructionStatus[],
  toStatus: PaymentInstructionStatus,
  patch: Partial<{
    approvedByUserId: string;
    approvedAt: string;
    submittedAt: string;
    settledAt: string;
    failedAt: string;
    cancelledAt: string;
    providerReference: string;
    failureCode: string;
    failureReason: string;
  }> = {}
): boolean {
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const res = getDb()
    .prepare(
      `UPDATE payment_instructions SET status = ?,
        approved_by_user_id = COALESCE(?, approved_by_user_id),
        approved_at = COALESCE(?, approved_at),
        submitted_at = COALESCE(?, submitted_at),
        settled_at = COALESCE(?, settled_at),
        failed_at = COALESCE(?, failed_at),
        cancelled_at = COALESCE(?, cancelled_at),
        provider_reference = COALESCE(?, provider_reference),
        failure_code = COALESCE(?, failure_code),
        failure_reason = COALESCE(?, failure_reason)
       WHERE id = ? AND status IN (${placeholders})`
    )
    .run(
      toStatus,
      patch.approvedByUserId ?? null, patch.approvedAt ?? null, patch.submittedAt ?? null,
      patch.settledAt ?? null, patch.failedAt ?? null, patch.cancelledAt ?? null,
      patch.providerReference ?? null, patch.failureCode ?? null, patch.failureReason ?? null,
      id, ...fromStatuses
    );
  return Number(res.changes) === 1;
}

// ------------------------------------------------------- transactions

function toTransaction(r: Row): BankTransaction {
  return {
    id: String(r.id),
    projectVirtualAccountId: String(r.project_virtual_account_id),
    paymentInstructionId: s(r.payment_instruction_id),
    providerTransactionReference: String(r.provider_transaction_reference),
    direction: String(r.direction) as BankTransaction["direction"],
    amount: num(r.amount),
    currency: String(r.currency),
    status: String(r.status) as BankTransaction["status"],
    transactionType: String(r.transaction_type),
    initiatedAt: String(r.initiated_at),
    postedAt: s(r.posted_at),
    settledAt: s(r.settled_at),
    returnedAt: s(r.returned_at),
    description: s(r.description),
    rawEventHash: s(r.raw_event_hash),
  };
}

export function insertTransaction(t: BankTransaction): void {
  getDb()
    .prepare(
      `INSERT INTO bank_transactions (id, project_virtual_account_id, payment_instruction_id,
        provider_transaction_reference, direction, amount, currency, status, transaction_type,
        initiated_at, posted_at, settled_at, returned_at, description, raw_event_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      t.id, t.projectVirtualAccountId, t.paymentInstructionId, t.providerTransactionReference,
      t.direction, t.amount, t.currency, t.status, t.transactionType, t.initiatedAt,
      t.postedAt, t.settledAt, t.returnedAt, t.description, t.rawEventHash
    );
}

export function getTransaction(id: string): BankTransaction | null {
  const r = getDb().prepare(`SELECT * FROM bank_transactions WHERE id = ?`).get(id) as Row | undefined;
  return r ? toTransaction(r) : null;
}

export function getTransactionByProviderReference(ref: string): BankTransaction | null {
  const r = getDb()
    .prepare(`SELECT * FROM bank_transactions WHERE provider_transaction_reference = ?`)
    .get(ref) as Row | undefined;
  return r ? toTransaction(r) : null;
}

export function listTransactionsForAccount(accountId: string): BankTransaction[] {
  return (getDb()
    .prepare(`SELECT * FROM bank_transactions WHERE project_virtual_account_id = ? ORDER BY initiated_at`)
    .all(accountId) as Row[]).map(toTransaction);
}

export function listTransactionsForInstruction(instructionId: string): BankTransaction[] {
  return (getDb()
    .prepare(`SELECT * FROM bank_transactions WHERE payment_instruction_id = ? ORDER BY initiated_at`)
    .all(instructionId) as Row[]).map(toTransaction);
}

/** Guarded transaction status transition (provider-event driven). */
export function transitionTransactionGuarded(
  id: string,
  fromStatuses: BankTransaction["status"][],
  toStatus: BankTransaction["status"],
  patch: Partial<{ postedAt: string; settledAt: string; returnedAt: string; rawEventHash: string }> = {}
): boolean {
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const res = getDb()
    .prepare(
      `UPDATE bank_transactions SET status = ?,
        posted_at = COALESCE(?, posted_at),
        settled_at = COALESCE(?, settled_at),
        returned_at = COALESCE(?, returned_at),
        raw_event_hash = COALESCE(?, raw_event_hash)
       WHERE id = ? AND status IN (${placeholders})`
    )
    .run(
      toStatus, patch.postedAt ?? null, patch.settledAt ?? null, patch.returnedAt ?? null,
      patch.rawEventHash ?? null, id, ...fromStatuses
    );
  return Number(res.changes) === 1;
}

// ---------------------------------------------------- reconciliation

function toRun(r: Row): ReconciliationRun {
  return {
    id: String(r.id),
    bankingProgramId: String(r.banking_program_id),
    startedAt: String(r.started_at),
    completedAt: s(r.completed_at),
    status: String(r.status) as ReconciliationRun["status"],
    bankReportedBalance: numOrNull(r.bank_reported_balance),
    ledgerCalculatedBalance: numOrNull(r.ledger_calculated_balance),
    differenceAmount: numOrNull(r.difference_amount),
    projectAccountCount: numOrNull(r.project_account_count),
    transactionCount: numOrNull(r.transaction_count),
    findings: s(r.findings),
    initiatedBy: String(r.initiated_by),
    previousSuccessfulRunId: s(r.previous_successful_run_id),
  };
}

export function insertReconciliationRun(run: ReconciliationRun): void {
  getDb()
    .prepare(
      `INSERT INTO reconciliation_runs (id, banking_program_id, started_at, completed_at, status,
        bank_reported_balance, ledger_calculated_balance, difference_amount,
        project_account_count, transaction_count, findings, initiated_by, previous_successful_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      run.id, run.bankingProgramId, run.startedAt, run.completedAt, run.status,
      run.bankReportedBalance, run.ledgerCalculatedBalance, run.differenceAmount,
      run.projectAccountCount, run.transactionCount, run.findings, run.initiatedBy,
      run.previousSuccessfulRunId
    );
}

export function getReconciliationRun(id: string): ReconciliationRun | null {
  const r = getDb().prepare(`SELECT * FROM reconciliation_runs WHERE id = ?`).get(id) as Row | undefined;
  return r ? toRun(r) : null;
}

export function listReconciliationRuns(bankingProgramId: string): ReconciliationRun[] {
  return (getDb()
    .prepare(`SELECT * FROM reconciliation_runs WHERE banking_program_id = ? ORDER BY started_at`)
    .all(bankingProgramId) as Row[]).map(toRun);
}

/** Latest COMPLETED run (MATCHED / MISMATCH / FAILED) for the program. */
export function latestCompletedRun(bankingProgramId: string): ReconciliationRun | null {
  const r = getDb()
    .prepare(
      `SELECT * FROM reconciliation_runs
       WHERE banking_program_id = ? AND status != 'RUNNING'
       ORDER BY started_at DESC, rowid DESC LIMIT 1`
    )
    .get(bankingProgramId) as Row | undefined;
  return r ? toRun(r) : null;
}

export function latestSuccessfulRun(bankingProgramId: string): ReconciliationRun | null {
  const r = getDb()
    .prepare(
      `SELECT * FROM reconciliation_runs
       WHERE banking_program_id = ? AND status = 'MATCHED'
       ORDER BY started_at DESC, rowid DESC LIMIT 1`
    )
    .get(bankingProgramId) as Row | undefined;
  return r ? toRun(r) : null;
}

export function completeReconciliationRun(
  id: string,
  patch: {
    status: ReconciliationRun["status"];
    completedAt: string;
    bankReportedBalance: number | null;
    ledgerCalculatedBalance: number | null;
    differenceAmount: number | null;
    projectAccountCount: number;
    transactionCount: number;
    findings: string | null;
  }
): void {
  getDb()
    .prepare(
      `UPDATE reconciliation_runs SET status = ?, completed_at = ?, bank_reported_balance = ?,
        ledger_calculated_balance = ?, difference_amount = ?, project_account_count = ?,
        transaction_count = ?, findings = ?
       WHERE id = ? AND status = 'RUNNING'`
    )
    .run(
      patch.status, patch.completedAt, patch.bankReportedBalance, patch.ledgerCalculatedBalance,
      patch.differenceAmount, patch.projectAccountCount, patch.transactionCount, patch.findings, id
    );
}

// ------------------------------------------------------------- events

function toEvent(r: Row): BankingEvent {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    projectId: s(r.project_id),
    bankingProgramId: s(r.banking_program_id),
    projectVirtualAccountId: s(r.project_virtual_account_id),
    drawRequestId: s(r.draw_request_id),
    paymentInstructionId: s(r.payment_instruction_id),
    bankTransactionId: s(r.bank_transaction_id),
    type: String(r.type) as BankingEventType,
    detail: String(r.detail),
    actorUserId: s(r.actor_user_id),
    createdAt: String(r.created_at),
  };
}

/** Append-only insert. There is intentionally no update/delete function. */
export function insertBankingEvent(e: BankingEvent): void {
  getDb()
    .prepare(
      `INSERT INTO banking_events (id, organization_id, project_id, banking_program_id,
        project_virtual_account_id, draw_request_id, payment_instruction_id, bank_transaction_id,
        type, detail, actor_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      e.id, e.organizationId, e.projectId, e.bankingProgramId, e.projectVirtualAccountId,
      e.drawRequestId, e.paymentInstructionId, e.bankTransactionId, e.type, e.detail,
      e.actorUserId, e.createdAt
    );
}

export function listBankingEventsForAccount(accountId: string): BankingEvent[] {
  return (getDb()
    .prepare(`SELECT * FROM banking_events WHERE project_virtual_account_id = ? ORDER BY created_at, rowid`)
    .all(accountId) as Row[]).map(toEvent);
}

export function listBankingEventsForProgram(bankingProgramId: string): BankingEvent[] {
  return (getDb()
    .prepare(`SELECT * FROM banking_events WHERE banking_program_id = ? ORDER BY created_at, rowid`)
    .all(bankingProgramId) as Row[]).map(toEvent);
}

export function listBankingEventsForProject(projectId: string): BankingEvent[] {
  return (getDb()
    .prepare(`SELECT * FROM banking_events WHERE project_id = ? ORDER BY created_at, rowid`)
    .all(projectId) as Row[]).map(toEvent);
}

// ------------------------------------------- mock provider ledger (demo)

export interface MockLedgerEntry {
  id: string;
  bankingProgramId: string;
  entryType: string;
  amount: number;
  reference: string | null;
  createdAt: string;
}

export function insertMockLedgerEntry(e: MockLedgerEntry): void {
  getDb()
    .prepare(
      `INSERT INTO mock_provider_ledger (id, banking_program_id, entry_type, amount, reference, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(e.id, e.bankingProgramId, e.entryType, e.amount, e.reference, e.createdAt);
}

export function listMockLedgerEntries(bankingProgramId: string): MockLedgerEntry[] {
  return (getDb()
    .prepare(`SELECT * FROM mock_provider_ledger WHERE banking_program_id = ? ORDER BY created_at, rowid`)
    .all(bankingProgramId) as Row[]).map((r) => ({
    id: String(r.id),
    bankingProgramId: String(r.banking_program_id),
    entryType: String(r.entry_type),
    amount: num(r.amount),
    reference: s(r.reference),
    createdAt: String(r.created_at),
  }));
}

/** Sum of the mock provider's own (bank-side) ledger for a program. */
export function mockLedgerBalance(bankingProgramId: string): number {
  const r = getDb()
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM mock_provider_ledger WHERE banking_program_id = ?`)
    .get(bankingProgramId) as Row;
  return num(r.total);
}

// -------------------------------------------------------- transactions helper

/** Serialized write transaction (same doctrine as lenderRepo Tx helpers). */
export function withBankingTx<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
