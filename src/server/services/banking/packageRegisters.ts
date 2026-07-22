/**
 * Banking-layer registers for the Draw Verification Package and the
 * Project Audit Package.
 *
 * Honesty rules:
 *   - explicit as-of filtering: only records that existed at the
 *     package's generatedAt instant are included;
 *   - ledger state and bank-reported state are separate columns/files —
 *     a payment instruction is not a submitted payment, and a submitted
 *     payment is not a settled transaction;
 *   - legacy projects with no banking records get a summary that says
 *     "Not recorded" — values are never fabricated, and provider
 *     references are only ever copied from stored records;
 *   - only masked account identifiers appear; no credentials, raw
 *     provider payloads or full account/routing numbers exist to leak.
 */
import * as brepo from "../../db/bankingRepo";
import { csv, type PackageFile } from "../auditPackage";
import type { User } from "../../../shared/types";

const NOT_RECORDED = "Not recorded";

const asOfFilter = (asOf: string) => (iso: string): boolean => iso <= asOf;

export function bankingRegisterFiles(input: {
  projectId: string;
  /** Restrict the instruction/transaction registers to one draw (draw
   *  package); null includes the whole project (audit package). */
  drawRequestId: string | null;
  asOf: string;
  /** ZIP directory prefix, e.g. "" or "07_banking/". */
  prefix: string;
  users: Map<string, User>;
}): { files: PackageFile[]; counts: Record<string, number> } {
  const { projectId, drawRequestId, asOf, prefix } = input;
  const inWindow = asOfFilter(asOf);
  const userName = (id: string | null): string => (id ? input.users.get(id)?.name ?? id : NOT_RECORDED);

  const files: PackageFile[] = [];
  const counts: Record<string, number> = {};
  const add = (name: string, content: string, count: number): void => {
    files.push({ name: `${prefix}${name}`, data: Buffer.from(content, "utf8") });
    counts[`${prefix}${name}`] = count;
  };

  const account = brepo.getOpenAccountForProject(projectId);
  const program = account ? brepo.getProgram(account.bankingProgramId) : null;

  // ---- banking-program-summary.json (always present; honest when empty)
  const summary = program && account && inWindow(account.createdAt)
    ? {
        state: "RECORDED",
        asOf,
        program: {
          id: program.id,
          provider: program.provider,
          providerProgramReference: program.providerProgramReference,
          partnerBankName: program.partnerBankName,
          accountStructure: program.accountStructure,
          status: program.status,
          currency: program.currency,
          createdAt: program.createdAt,
        },
        projectVirtualAccountId: account.id,
        note:
          "The virtual account may be a subledger balance at the partner bank rather than a separate bank deposit account. " +
          "Ledger balances are OBV's records; only provider-confirmed settled bank transactions represent completed movement of funds.",
      }
    : {
        state: "NOT_RECORDED",
        asOf,
        note: `${NOT_RECORDED} — this project has no banking-layer records at the as-of instant. Nothing is inferred or fabricated.`,
      };
  add("banking-program-summary.json", JSON.stringify(summary, null, 2), summary.state === "RECORDED" ? 1 : 0);

  // ---- project-virtual-account.csv (ledger state, masked identifiers)
  const accountRows =
    account && inWindow(account.createdAt)
      ? [[
          account.id,
          account.bankingProgramId,
          account.virtualAccountNumberMasked,
          account.routingNumberMasked ?? NOT_RECORDED,
          account.currency,
          account.status,
          account.availableBalance,
          account.heldBalance,
          account.releaseEligibleBalance,
          account.pendingOutboundAmount,
          account.settledOutboundAmount,
          account.returnedAmount,
          account.createdAt,
          account.lastReconciledAt ?? NOT_RECORDED,
        ]]
      : [];
  add(
    "project-virtual-account.csv",
    csv(
      ["accountId", "bankingProgramId", "virtualAccountMasked", "routingMasked", "currency", "status",
       "availableBalance", "heldBalance", "releaseEligibleBalance", "pendingOutboundAmount",
       "settledOutboundAmount", "returnedAmount", "createdAt", "lastReconciledAt"],
      accountRows
    ),
    accountRows.length
  );

  // ---- account-holds.csv
  const holds = account
    ? brepo.listHoldsForAccount(account.id).filter((h) => inWindow(h.placedAt))
    : [];
  add(
    "account-holds.csv",
    csv(
      ["holdId", "accountId", "drawRequestId", "amount", "reasonCode", "reason", "status",
       "placedBy", "placedAt", "releasedBy", "releasedAt", "providerReference"],
      holds.map((h) => [
        h.id, h.projectVirtualAccountId, h.drawRequestId ?? "", h.amount, h.reasonCode,
        h.reason ?? "", h.status, userName(h.placedByUserId), h.placedAt,
        userName(h.releasedByUserId), h.releasedAt ?? "", h.providerReference ?? "",
      ])
    ),
    holds.length
  );

  // ---- payment-instructions.csv (OBV ledger state — an instruction is
  //      NOT a submitted payment; submittedAt/settledAt make the
  //      distinction explicit per row)
  const instructions = (account ? brepo.listInstructionsForAccount(account.id) : [])
    .filter((i) => inWindow(i.requestedAt))
    .filter((i) => drawRequestId === null || i.drawRequestId === drawRequestId);
  add(
    "payment-instructions.csv",
    csv(
      ["instructionId", "drawRequestId", "lenderDecisionId", "approvalRequestId", "amount", "currency",
       "recipientName", "recipientReference", "paymentMethod", "ledgerStatus",
       "createdBy", "requestedAt", "approvedBy", "approvedAt",
       "submittedToProviderAt", "settledAt", "failedAt", "cancelledAt",
       "providerReference", "failureCode", "failureReason", "idempotencyKey"],
      instructions.map((i) => [
        i.id, i.drawRequestId, i.lenderDecisionId, i.approvalRequestId, i.amount, i.currency,
        i.recipientName, i.recipientReference ?? "", i.paymentMethod, i.status,
        userName(i.requestedByUserId), i.requestedAt, userName(i.approvedByUserId), i.approvedAt ?? "",
        i.submittedAt ?? "", i.settledAt ?? "", i.failedAt ?? "", i.cancelledAt ?? "",
        i.providerReference ?? "", i.failureCode ?? "", i.failureReason ?? "", i.idempotencyKey,
      ])
    ),
    instructions.length
  );

  // ---- bank-transactions.csv (BANK-REPORTED state, mirrored from the
  //      provider — the only settlement truth)
  const instructionIds = new Set(instructions.map((i) => i.id));
  const transactions = (account ? brepo.listTransactionsForAccount(account.id) : [])
    .filter((t) => inWindow(t.initiatedAt))
    .filter(
      (t) =>
        drawRequestId === null ||
        (t.paymentInstructionId !== null && instructionIds.has(t.paymentInstructionId))
    );
  add(
    "bank-transactions.csv",
    csv(
      ["transactionId", "paymentInstructionId", "providerTransactionReference", "direction", "amount",
       "currency", "bankReportedStatus", "transactionType", "initiatedAt", "postedAt", "settledAt",
       "returnedAt", "description", "rawEventHash"],
      transactions.map((t) => [
        t.id, t.paymentInstructionId ?? "", t.providerTransactionReference, t.direction, t.amount,
        t.currency, t.status, t.transactionType, t.initiatedAt, t.postedAt ?? "", t.settledAt ?? "",
        t.returnedAt ?? "", t.description ?? "", t.rawEventHash ?? "",
      ])
    ),
    transactions.length
  );

  // ---- reconciliation-runs.csv (mismatches stay in history forever;
  //      mismatch rows are integrity findings by definition)
  const runs = (program ? brepo.listReconciliationRuns(program.id) : []).filter((r) => inWindow(r.startedAt));
  add(
    "reconciliation-runs.csv",
    csv(
      ["runId", "bankingProgramId", "startedAt", "completedAt", "status", "bankReportedBalance",
       "ledgerCalculatedBalance", "differenceAmount", "projectAccountCount", "transactionCount",
       "initiatedBy", "previousSuccessfulRunId", "integrityFinding"],
      runs.map((r) => [
        r.id, r.bankingProgramId, r.startedAt, r.completedAt ?? "", r.status,
        r.bankReportedBalance ?? "", r.ledgerCalculatedBalance ?? "", r.differenceAmount ?? "",
        r.projectAccountCount ?? "", r.transactionCount ?? "", userName(r.initiatedBy),
        r.previousSuccessfulRunId ?? "",
        r.status === "MISMATCH" || r.status === "FAILED" ? "INTEGRITY_FINDING" : "",
      ])
    ),
    runs.length
  );

  // ---- banking-events.csv (append-only audit history)
  const events = brepo
    .listBankingEventsForProject(projectId)
    .filter((e) => inWindow(e.createdAt))
    .filter((e) => drawRequestId === null || e.drawRequestId === null || e.drawRequestId === drawRequestId);
  add(
    "banking-events.csv",
    csv(
      ["eventId", "type", "detail", "actor", "drawRequestId", "paymentInstructionId", "bankTransactionId", "createdAt"],
      events.map((e) => [
        e.id, e.type, e.detail, userName(e.actorUserId), e.drawRequestId ?? "",
        e.paymentInstructionId ?? "", e.bankTransactionId ?? "", e.createdAt,
      ])
    ),
    events.length
  );

  return { files, counts };
}
