/**
 * Banking provider registry — environment-driven provider resolution.
 *
 *   OBV_BANKING_PROVIDER = mock | unit | treasury_prime | qolo   (default mock)
 *   OBV_BANKING_MODE     = demo | production                     (default demo)
 *
 * Safety posture:
 *   - The application REFUSES to start a non-mock provider unless BOTH
 *     OBV_BANKING_MODE=production AND OBV_BANKING_PRODUCTION_ENABLE=true
 *     are present — and even then the shipped adapters are disabled
 *     boundaries that refuse every call (no credentials exist in this
 *     build to configure them with).
 *   - Demo-only simulation surfaces (simulated settlement/failure/return,
 *     demo credits, forced reconciliation mismatch) are available ONLY in
 *     demo mode; production mode refuses them even with the mock provider.
 */
import { MockBankingProvider } from "./mockProvider";
import { QoloBankingProvider, TreasuryPrimeBankingProvider, UnitBankingProvider } from "./adapters";
import { BankingProviderError, type BankingProvider } from "./provider";

let cached: BankingProvider | null = null;

export function bankingMode(): "demo" | "production" {
  return (process.env.OBV_BANKING_MODE ?? "demo").toLowerCase() === "production" ? "production" : "demo";
}

export function isDemoBankingMode(): boolean {
  return bankingMode() === "demo";
}

export function assertDemoSimulationAllowed(action: string): void {
  if (!isDemoBankingMode()) {
    throw new BankingProviderError(`${action} is a demo simulation and is not available in production mode`, 403);
  }
}

/** Resolve (and cache) the configured provider. Called once at startup so
 *  a misconfigured non-mock provider stops the process instead of failing
 *  lazily mid-request. */
export function resolveBankingProvider(): BankingProvider {
  if (cached) return cached;
  const raw = (process.env.OBV_BANKING_PROVIDER ?? "mock").toLowerCase();
  if (raw === "mock") {
    cached = new MockBankingProvider();
    return cached;
  }
  const productionEnabled =
    bankingMode() === "production" && process.env.OBV_BANKING_PRODUCTION_ENABLE === "true";
  if (!productionEnabled) {
    throw new BankingProviderError(
      `OBV_BANKING_PROVIDER=${raw} requires OBV_BANKING_MODE=production and ` +
        "OBV_BANKING_PRODUCTION_ENABLE=true plus full provider configuration. " +
        "This build refuses to start a non-mock banking provider without them.",
      500
    );
  }
  switch (raw) {
    case "unit": cached = UnitBankingProvider(); break;
    case "treasury_prime": cached = TreasuryPrimeBankingProvider(); break;
    case "qolo": cached = QoloBankingProvider(); break;
    default:
      throw new BankingProviderError(`Unknown OBV_BANKING_PROVIDER value: ${raw}`, 500);
  }
  return cached;
}

/** Test-only: drop the cached provider so env changes take effect. */
export function resetBankingProviderForTests(): void {
  cached = null;
}
