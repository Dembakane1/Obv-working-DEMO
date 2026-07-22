/**
 * Disabled future-provider adapter boundaries.
 *
 * These classes exist so the integration seams for Unit, Treasury Prime,
 * Qolo (or a direct partner-bank API) are explicit in the codebase, and
 * so the registry can name them. They contain NO SDK imports, NO network
 * calls, NO credentials and NO provider-specific production logic — every
 * method refuses with 501. A future adapter implements BankingProvider
 * behind this same boundary; OBV's verification, governance and
 * authorization rules do not change per provider.
 */
import { BankingProviderError, type BankingProvider } from "./provider";

function disabled(name: string): never {
  throw new BankingProviderError(
    `The ${name} banking adapter is a disabled boundary in this build. ` +
      "It ships without SDKs, credentials or network access; enabling a real provider " +
      "requires the provider configuration and an explicit production-enable flag.",
    501
  );
}

function makeDisabledProvider(kind: "UNIT" | "TREASURY_PRIME" | "QOLO", name: string): BankingProvider {
  return {
    kind,
    createProgramAccount: () => disabled(name),
    createProjectVirtualAccount: () => disabled(name),
    getProjectVirtualAccount: () => disabled(name),
    getBalance: () => disabled(name),
    placeHold: () => disabled(name),
    releaseHold: () => disabled(name),
    submitPaymentInstruction: () => disabled(name),
    cancelPaymentInstruction: () => disabled(name),
    getTransaction: () => disabled(name),
    processWebhook: () => disabled(name),
    reconcileProgram: () => disabled(name),
    creditDemoFunds: () => disabled(name),
  };
}

export const UnitBankingProvider = (): BankingProvider => makeDisabledProvider("UNIT", "Unit");
export const TreasuryPrimeBankingProvider = (): BankingProvider =>
  makeDisabledProvider("TREASURY_PRIME", "Treasury Prime");
export const QoloBankingProvider = (): BankingProvider => makeDisabledProvider("QOLO", "Qolo");
