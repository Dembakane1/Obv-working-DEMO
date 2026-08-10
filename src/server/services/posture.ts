/**
 * Environment posture — the ONE resolver every production-vs-demo
 * boundary keys on.
 *
 *   OBV_ENVIRONMENT = demo | pilot | production
 *
 * "pilot" is a production posture with a friendlier name: the first
 * external lender runs there. "demo" keeps every development affordance
 * (role switcher, golden seed, banking simulation, demo reset, file
 * outbox). "pilot" and "production" behave identically today; the two
 * names exist so an operator can distinguish the first controlled
 * external deployment from a later full production estate without a
 * config migration.
 *
 * LEGACY COMPATIBILITY — the flags that predate OBV_ENVIRONMENT keep
 * working: with OBV_ENVIRONMENT unset, production posture is inferred
 * exactly as before (OBV_BANKING_MODE=production or
 * OBV_SESSION_REQUIRE_SECRET). With OBV_ENVIRONMENT set, contradictory
 * legacy flags REFUSE STARTUP instead of silently picking a winner: a
 * deployment that says both "this is a demo" and "this is production
 * banking" is misconfigured, and guessing which half it meant would be
 * worse than stopping.
 *
 * This module deliberately has no imports from the rest of the app so
 * every layer (sessions, identity, banking, seeds, routes, scripts) can
 * depend on it without cycles.
 */

export type ObvEnvironment = "demo" | "pilot" | "production";

export class PostureConfigError extends Error {}

const TRUTHY = /^(1|true)$/i;

function rawEnvName(): string {
  return (process.env.OBV_ENVIRONMENT ?? "").trim().toLowerCase();
}

function legacyProductionSignal(): boolean {
  return (
    process.env.OBV_BANKING_MODE === "production" ||
    TRUTHY.test(process.env.OBV_SESSION_REQUIRE_SECRET ?? "")
  );
}

/**
 * Resolve the declared environment, validating conflicts. Throws
 * PostureConfigError with a one-line operator instruction on any
 * contradiction — callers surface it as a controlled startup failure.
 */
export function environmentName(): ObvEnvironment {
  const raw = rawEnvName();
  if (!raw) return legacyProductionSignal() ? "production" : "demo";
  if (raw !== "demo" && raw !== "pilot" && raw !== "production") {
    throw new PostureConfigError(
      `OBV_ENVIRONMENT must be "demo", "pilot" or "production" (got "${raw}")`
    );
  }
  if (raw === "demo" && legacyProductionSignal()) {
    throw new PostureConfigError(
      "OBV_ENVIRONMENT=demo contradicts a production flag " +
        "(OBV_BANKING_MODE=production or OBV_SESSION_REQUIRE_SECRET is set). " +
        "Remove the production flag or change OBV_ENVIRONMENT — a deployment " +
        "cannot be both."
    );
  }
  if (raw !== "demo" && process.env.OBV_BANKING_MODE === "demo") {
    throw new PostureConfigError(
      `OBV_ENVIRONMENT=${raw} contradicts OBV_BANKING_MODE=demo. An external ` +
        "pilot never exposes banking simulation; remove OBV_BANKING_MODE " +
        "(the posture already implies production banking mode)."
    );
  }
  return raw;
}

/** True in pilot and production. Every security boundary keys on this. */
export function productionPosture(): boolean {
  return environmentName() !== "demo";
}

/**
 * Startup validation for posture-adjacent flags. Beyond environmentName()'s
 * own contradiction checks, refuse the demo affordances that must never be
 * switched on in a pilot/production deployment — an env var is exactly the
 * kind of thing that survives a copy-pasted demo config.
 *
 * The refusals apply only when OBV_ENVIRONMENT is DECLARED: the legacy
 * inference path (production posture via OBV_BANKING_MODE alone) keeps its
 * historical behavior, where OBV_DEMO_AUTH=1 remains a code-supported
 * test override — the adversarial suite uses it to prove the banking-mode
 * wall independently of the identity wall. A real pilot declares
 * OBV_ENVIRONMENT=pilot and gets the strict wall.
 */
export function assertPostureConfig(): void {
  const env = environmentName();
  if (env === "demo" || !rawEnvName()) return;
  if (TRUTHY.test(process.env.OBV_DEMO_AUTH ?? "")) {
    throw new PostureConfigError(
      `OBV_DEMO_AUTH=1 is not allowed with OBV_ENVIRONMENT=${env}: the ` +
        "passwordless demo role switcher is an authentication bypass. Remove " +
        "OBV_DEMO_AUTH from the pilot/production environment."
    );
  }
  if (TRUTHY.test(process.env.OBV_SEED_GOLDEN ?? "")) {
    throw new PostureConfigError(
      `OBV_SEED_GOLDEN=1 is not allowed with OBV_ENVIRONMENT=${env}: the ` +
        "golden demo project is fictional demo data. Remove OBV_SEED_GOLDEN " +
        "from the pilot/production environment."
    );
  }
}

/** One-line boot disclosure. Never prints secrets. */
export function postureStartupNotice(): string {
  const env = environmentName();
  return env === "demo"
    ? "environment: DEMO — role switcher, golden seed, demo reset and banking simulation available"
    : `environment: ${env.toUpperCase()} — demo switcher/reset/seed and banking simulation are DISABLED`;
}
