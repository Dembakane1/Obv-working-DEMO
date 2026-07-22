/**
 * Deterministic program reconciliation.
 *
 * Documented invariant (suspense balance ≡ 0 in this phase; a future
 * suspense account would be an additional ledger account, not a fudge):
 *
 *   bankReportedBalance(program)
 *     = Σ over program accounts (availableBalance
 *                                + heldBalance
 *                                + pendingOutboundAmount)
 *       + suspenseBalance
 *
 * pendingOutboundAmount is ADDED because a submitted-but-unsettled
 * payment has left OBV's spendable ledger while the funds are still at
 * the bank — it is the "unsettled outbound adjustment" between the two
 * books. Integer arithmetic only; no floating point ever touches a
 * reconciliation comparison.
 *
 * A MISMATCH:
 *   - records the reported and calculated values and the difference,
 *   - identifies the affected project accounts in its findings,
 *   - drives a CRITICAL deterministic exception (exceptions service rule
 *     `banking-reconciliation-mismatch:<program>:<project>`) which blocks
 *     new payment work for the program,
 *   - NEVER adjusts the ledger to force a match.
 * A later MATCHED run clears the deterministic exception (auto-resolve,
 * attributable in the exception's own event history) but the mismatch
 * run and its findings remain immutable history.
 */
import * as brepo from "../../db/bankingRepo";
import * as exceptions from "../exceptions";
import { BankingError, assertBankingCapability, assertProjectAccess } from "./bankingAccess";
import { resolveBankingProvider, assertDemoSimulationAllowed } from "./registry";
import { logBankingEvent } from "./projectAccounts";
import { makeWholeCurrency } from "../money";
import type { ReconciliationRun, User } from "../../../shared/types";

const wholeAmount = makeWholeCurrency((m) => new BankingError(m, 400));

/** The suspense balance for a program. Always zero in this phase. */
export function suspenseBalance(_bankingProgramId: string): number {
  return 0;
}

/** OBV-side calculated balance for the documented invariant. */
export function ledgerCalculatedBalance(bankingProgramId: string): {
  total: number;
  accountCount: number;
} {
  const accounts = brepo.listAccountsForProgram(bankingProgramId);
  let total = suspenseBalance(bankingProgramId);
  for (const a of accounts) {
    total += a.availableBalance + a.heldBalance + a.pendingOutboundAmount;
  }
  return { total, accountCount: accounts.length };
}

/** True while the program's most recent completed run is MISMATCH/FAILED.
 *  Payment creation, approval and submission consult this. */
export function reconciliationBlocked(bankingProgramId: string): boolean {
  const latest = brepo.latestCompletedRun(bankingProgramId);
  return latest !== null && latest.status !== "MATCHED";
}

export async function runReconciliation(
  user: User,
  projectId: string,
  input: { demoForceMismatchAmount?: unknown } = {}
): Promise<ReconciliationRun> {
  const project = assertProjectAccess(user, projectId);
  assertBankingCapability(user, project.id, "RUN_RECONCILIATION");
  const account = brepo.getOpenAccountForProject(project.id);
  if (!account) throw new BankingError("The project has no virtual account to reconcile", 409);
  const program = brepo.getProgram(account.bankingProgramId)!;

  const force = wholeAmount(input.demoForceMismatchAmount, "demoForceMismatchAmount");
  if (force !== null && force !== 0) {
    assertDemoSimulationAllowed("Forcing a reconciliation mismatch");
  }

  const provider = resolveBankingProvider();
  const now = new Date().toISOString();
  const previous = brepo.latestSuccessfulRun(program.id);
  const run: ReconciliationRun = {
    id: brepo.newId(),
    bankingProgramId: program.id,
    startedAt: now,
    completedAt: null,
    status: "RUNNING",
    bankReportedBalance: null,
    ledgerCalculatedBalance: null,
    differenceAmount: null,
    projectAccountCount: null,
    transactionCount: null,
    findings: null,
    initiatedBy: user.id,
    previousSuccessfulRunId: previous?.id ?? null,
  };
  brepo.insertReconciliationRun(run);

  let status: ReconciliationRun["status"];
  let findings: string;
  let reported: number | null = null;
  let calculated: number | null = null;
  let accountCount = 0;
  let txCount = 0;
  try {
    const bankReport = provider.reconcileProgram({
      bankingProgramId: program.id,
      demoForceMismatchAmount: force,
    });
    const ledger = ledgerCalculatedBalance(program.id);
    reported = bankReport.bankReportedBalance;
    calculated = ledger.total;
    accountCount = ledger.accountCount;
    txCount = bankReport.bankTransactionCount;
    const difference = reported - calculated;
    if (difference === 0) {
      status = "MATCHED";
      findings = JSON.stringify({
        formula: "bankReported = sum(available + held + pendingOutbound) + suspense",
        suspenseBalance: suspenseBalance(program.id),
        accounts: brepo.listAccountsForProgram(program.id).map((a) => ({
          projectVirtualAccountId: a.id,
          projectId: a.projectId,
          availableBalance: a.availableBalance,
          heldBalance: a.heldBalance,
          pendingOutboundAmount: a.pendingOutboundAmount,
        })),
      });
    } else {
      status = "MISMATCH";
      findings = JSON.stringify({
        formula: "bankReported = sum(available + held + pendingOutbound) + suspense",
        suspenseBalance: suspenseBalance(program.id),
        bankReportedBalance: reported,
        ledgerCalculatedBalance: calculated,
        differenceAmount: difference,
        affectedProjects: brepo.listAccountsForProgram(program.id).map((a) => a.projectId),
        note: "The ledger is never adjusted to force a match; resolution must be attributable.",
      });
    }
    brepo.completeReconciliationRun(run.id, {
      status,
      completedAt: new Date().toISOString(),
      bankReportedBalance: reported,
      ledgerCalculatedBalance: calculated,
      differenceAmount: reported - calculated,
      projectAccountCount: accountCount,
      transactionCount: txCount,
      findings,
    });
  } catch (e) {
    brepo.completeReconciliationRun(run.id, {
      status: "FAILED",
      completedAt: new Date().toISOString(),
      bankReportedBalance: reported,
      ledgerCalculatedBalance: calculated,
      differenceAmount: null,
      projectAccountCount: accountCount,
      transactionCount: txCount,
      findings: JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 300) : "Reconciliation failed" }),
    });
    status = "FAILED";
  }

  const completed = brepo.getReconciliationRun(run.id)!;
  if (completed.status === "MATCHED") {
    const at = completed.completedAt ?? new Date().toISOString();
    for (const a of brepo.listAccountsForProgram(program.id)) {
      brepo.touchAccountReconciledAt(a.id, at);
    }
  }
  logBankingEvent({
    organizationId: program.organizationId,
    projectId: project.id,
    bankingProgramId: program.id,
    projectVirtualAccountId: account.id,
    type: completed.status === "MATCHED" ? "RECONCILIATION_MATCHED" : "RECONCILIATION_MISMATCH",
    detail:
      completed.status === "MATCHED"
        ? `Reconciliation matched: bank ${completed.bankReportedBalance} = ledger ${completed.ledgerCalculatedBalance}.`
        : `Reconciliation ${completed.status.toLowerCase()}: bank ${completed.bankReportedBalance ?? "n/a"} vs ledger ${completed.ledgerCalculatedBalance ?? "n/a"} (difference ${completed.differenceAmount ?? "n/a"}).`,
    actorUserId: user.id,
  });
  // Deterministic exception sweep: a mismatch/failure creates or reopens
  // the CRITICAL blocking exception; a matched run lets the sweep
  // auto-resolve it (history preserved).
  await exceptions.evaluateExceptions();
  return completed;
}

/** Read-model for the workspace's reconciliation panel. */
export function reconciliationView(user: User, projectId: string): {
  runs: ReconciliationRun[];
  latest: ReconciliationRun | null;
  lastSuccessful: ReconciliationRun | null;
  blocked: boolean;
} {
  const project = assertProjectAccess(user, projectId);
  assertBankingCapability(user, project.id, "VIEW_RECONCILIATION");
  const account = brepo.getOpenAccountForProject(project.id);
  if (!account) return { runs: [], latest: null, lastSuccessful: null, blocked: false };
  const runs = brepo.listReconciliationRuns(account.bankingProgramId);
  return {
    runs,
    latest: brepo.latestCompletedRun(account.bankingProgramId),
    lastSuccessful: brepo.latestSuccessfulRun(account.bankingProgramId),
    blocked: reconciliationBlocked(account.bankingProgramId),
  };
}
