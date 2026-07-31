/**
 * Enterprise SSO + MFA READINESS — architecture only, deliberately inert.
 *
 * Follows the government-foundation pattern exactly: provider-neutral
 * shapes exist (schema + catalog below), the module refuses activation,
 * and NO authentication flow consults anything here. Magic-link sign-in
 * is the only active method. When SSO ships it will land on these shapes
 * without a schema change; until then `ssoEnabled()` is hard false and
 * `assertSsoEnabled()` throws a non-disclosing 404.
 */
import * as identityRepo from "../../db/identityRepo";
import type { Identity, IdentityProviderKind, MfaMethodRecord } from "../../../shared/types";
import { IdentityError } from "./core";

export interface SsoCatalogEntry {
  kind: IdentityProviderKind;
  protocol: "OIDC" | "SAML2";
  name: string;
}

/** Provider-neutral catalog: what the abstraction is shaped to carry. */
export const SSO_PROVIDER_CATALOG: SsoCatalogEntry[] = [
  { kind: "ENTRA_ID", protocol: "OIDC", name: "Microsoft Entra ID" },
  { kind: "OKTA", protocol: "OIDC", name: "Okta" },
  { kind: "GOOGLE_WORKSPACE", protocol: "OIDC", name: "Google Workspace" },
  { kind: "AUTH0", protocol: "OIDC", name: "Auth0" },
  { kind: "PING", protocol: "OIDC", name: "Ping Identity" },
  { kind: "GENERIC_OIDC", protocol: "OIDC", name: "Generic OIDC" },
  { kind: "GENERIC_SAML2", protocol: "SAML2", name: "Generic SAML 2.0" },
];

/** Hard false — not a flag, not configurable. Enabling SSO is a future
 *  code change, not an environment toggle. */
export function ssoEnabled(): boolean {
  return false;
}

export function assertSsoEnabled(): never {
  throw new IdentityError("Not found", 404);
}

export function ssoReadiness(): {
  enabled: false;
  catalog: SsoCatalogEntry[];
  configuredProviders: number;
  note: string;
} {
  return {
    enabled: false,
    catalog: SSO_PROVIDER_CATALOG,
    // Always 0 today — the registry has no write path — but reported
    // honestly rather than hardcoded.
    configuredProviders: identityRepo.listIdentityProviders().length,
    note:
      "SSO is architectural readiness only. No identity provider flow is implemented or can be activated; magic-link sign-in is the only active method.",
  };
}

export const MFA_METHOD_CATALOG = ["TOTP", "WEBAUTHN", "FIDO2"] as const;

export function mfaReadiness(identity: Identity): {
  enabled: false;
  catalog: readonly string[];
  enrolled: MfaMethodRecord[];
  note: string;
} {
  return {
    enabled: false,
    catalog: MFA_METHOD_CATALOG,
    enrolled: identityRepo.listMfaMethodsForIdentity(identity.id),
    note:
      "MFA and passkeys are architectural readiness only. No enrollment, challenge, or verification path exists.",
  };
}
