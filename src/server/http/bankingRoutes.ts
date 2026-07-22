/**
 * Banking (VAM) HTTP routes — kept out of server.ts so the provider,
 * domain, persistence and view responsibilities stay separate.
 *
 * Every mutation is authorized inside the banking services (tenant-safe
 * 404, capability 403, dual control, demo gating); these handlers only
 * parse input and content-negotiate the response. Browser form posts
 * bounce back to the Project Account workspace with ?ok= / ?err=; JSON
 * clients receive plain JSON. Nothing here writes SQLite directly.
 */
import type * as http from "node:http";
import * as repo from "../db/repo";
import * as brepo from "../db/bankingRepo";
import * as bankingAccess from "../services/banking/bankingAccess";
import * as projectAccounts from "../services/banking/projectAccounts";
import * as paymentInstructions from "../services/banking/paymentInstructions";
import * as reconciliation from "../services/banking/reconciliation";
import { BankingError } from "../services/banking/bankingAccess";
import { isDemoBankingMode } from "../services/banking/registry";
import type { User } from "../../shared/types";

export interface BankingRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  getUser: () => User;
  readParams: () => Promise<Record<string, string>>;
  isForm: () => boolean;
  redirect: (location: string) => void;
  sendJson: (data: unknown, status?: number) => void;
}

/** Returns true when the request was handled by a banking route. */
export async function handleBankingRoutes(ctx: BankingRouteContext): Promise<boolean> {
  const { pathname, method } = ctx;

  const finish = (projectId: string | null, json: unknown, status = 200): void => {
    if (ctx.isForm() && projectId) {
      ctx.redirect(`/project/${projectId}/account?ok=1`);
    } else {
      ctx.sendJson(json, status);
    }
  };

  // ---------------- project-scoped banking surface ----------------
  const projectApi = /^\/api\/projects\/([^/]+)\/banking(?:\/(program|account|reconcile))?$/.exec(pathname);
  if (projectApi) {
    const user = ctx.getUser();
    const projectId = projectApi[1];
    const section = projectApi[2] ?? null;
    if (method === "GET" && section === null) {
      const project = bankingAccess.assertProjectAccess(user, projectId);
      bankingAccess.assertBankingCapability(user, project.id, "VIEW_PROJECT_ACCOUNT");
      const account = brepo.getOpenAccountForProject(project.id);
      const program = projectAccounts.programForProject(project.id);
      ctx.sendJson({
        program,
        account,
        holds: account ? brepo.listHoldsForAccount(account.id) : [],
        instructions: account ? brepo.listInstructionsForAccount(account.id) : [],
        transactions: account ? brepo.listTransactionsForAccount(account.id) : [],
        reconciliationRuns: account ? brepo.listReconciliationRuns(account.bankingProgramId) : [],
        demoMode: isDemoBankingMode(),
      });
      return true;
    }
    if (method === "POST" && section === "program") {
      const body = await ctx.readParams();
      const program = projectAccounts.createProgram(user, {
        projectId,
        partnerBankName: body.partnerBankName ?? "",
        accountStructure: body.accountStructure ?? "",
        currency: body.currency || null,
      });
      finish(projectId, { program }, 201);
      return true;
    }
    if (method === "POST" && section === "account") {
      const account = projectAccounts.createProjectAccount(user, projectId);
      finish(projectId, { account }, 201);
      return true;
    }
    if (method === "POST" && section === "reconcile") {
      const body = await ctx.readParams();
      const run = await reconciliation.runReconciliation(user, projectId, {
        demoForceMismatchAmount: body.demoForceMismatchAmount || null,
      });
      finish(projectId, { run }, 201);
      return true;
    }
    throw new BankingError("Method not allowed", 405);
  }

  // ------------------------- account actions -----------------------
  const accountApi = /^\/api\/banking\/accounts\/([^/]+)\/(credit|holds)$/.exec(pathname);
  if (accountApi && method === "POST") {
    const user = ctx.getUser();
    const accountId = accountApi[1];
    const body = await ctx.readParams();
    if (accountApi[2] === "credit") {
      const account = projectAccounts.creditDemoFunds(user, accountId, {
        amount: body.amount,
        description: body.description || null,
      });
      finish(account.projectId, { account }, 201);
      return true;
    }
    const hold = projectAccounts.placeHold(user, accountId, {
      drawRequestId: body.drawRequestId || null,
      amount: body.amount,
      reasonCode: body.reasonCode ?? "",
      reason: body.reason || null,
    });
    finish(brepo.getAccount(accountId)!.projectId, { hold }, 201);
    return true;
  }

  const holdApi = /^\/api\/banking\/holds\/([^/]+)\/release$/.exec(pathname);
  if (holdApi && method === "POST") {
    const user = ctx.getUser();
    const body = await ctx.readParams();
    const outcome = (body.outcome || "RELEASED") as "RELEASED" | "CANCELLED" | "EXPIRED";
    const hold = projectAccounts.releaseHold(user, holdApi[1], outcome);
    const account = brepo.getAccount(hold.projectVirtualAccountId)!;
    finish(account.projectId, { hold });
    return true;
  }

  // --------------------- draw-scoped payment surface ---------------
  const drawApi = /^\/api\/draws\/([^/]+)\/(payment-instructions|payment-eligibility)$/.exec(pathname);
  if (drawApi) {
    const user = ctx.getUser();
    const drawId = drawApi[1];
    if (drawApi[2] === "payment-eligibility" && method === "GET") {
      const draw = repo.getDrawRequest(drawId);
      if (!draw) throw new BankingError("Draw request not found", 404);
      const project = bankingAccess.assertProjectAccess(user, draw.projectId);
      bankingAccess.assertBankingCapability(user, project.id, "VIEW_PROJECT_ACCOUNT");
      const account = brepo.getOpenAccountForProject(project.id);
      const result = paymentInstructions.paymentEligibility(draw, account, null);
      ctx.sendJson({
        label: result.eligible ? "Eligible for payment instruction" : "Not eligible for payment instruction",
        ...result,
      });
      return true;
    }
    if (drawApi[2] === "payment-instructions" && method === "POST") {
      const body = await ctx.readParams();
      const instruction = paymentInstructions.createPaymentInstruction(user, {
        drawRequestId: drawId,
        amount: body.amount,
        recipientName: body.recipientName ?? "",
        recipientReference: body.recipientReference || null,
        paymentMethod: body.paymentMethod || null,
        idempotencyKey: body.idempotencyKey || null,
      });
      const draw = repo.getDrawRequest(drawId)!;
      finish(draw.projectId, { instruction }, 201);
      return true;
    }
    throw new BankingError("Method not allowed", 405);
  }

  // ----------------------- instruction actions ---------------------
  const instructionApi = /^\/api\/payment-instructions\/([^/]+)\/(approve|cancel|simulate\/(submit|posted|settled|failed|returned|reversed))$/.exec(
    pathname
  );
  if (instructionApi && method === "POST") {
    const user = ctx.getUser();
    const id = instructionApi[1];
    const action = instructionApi[2];
    const body = await ctx.readParams();
    let instruction;
    if (action === "approve") {
      instruction = paymentInstructions.approvePaymentInstruction(user, id);
    } else if (action === "cancel") {
      instruction = paymentInstructions.cancelPaymentInstruction(user, id, body.reason || null);
    } else if (action === "simulate/submit") {
      instruction = paymentInstructions.submitPaymentInstruction(user, id);
    } else {
      const event = instructionApi[3] as paymentInstructions.SimulatedProviderEvent;
      instruction = paymentInstructions.processProviderEvent(user, id, event, {
        eventId: body.eventId || null,
        failureCode: body.failureCode || null,
        failureReason: body.failureReason || null,
      });
    }
    const account = brepo.getAccount(instruction.projectVirtualAccountId)!;
    finish(account.projectId, { instruction });
    return true;
  }

  return false;
}
