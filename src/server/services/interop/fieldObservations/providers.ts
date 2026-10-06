/**
 * Future external provider boundaries — declared interfaces ONLY.
 *
 * No provider is implemented, contacted, configured or simulated. These
 * specs exist so a future adapter has a named boundary to implement, and
 * so the UI can state plainly that each one is NOT CONNECTED instead of
 * showing demo- or live-looking data. The deterministic import format
 * (format.ts) is the only path field observations take into OBV today.
 */
import type { InteropProviderSpec } from "../../../../shared/types";

export const INTEROP_PROVIDER_SPECS: InteropProviderSpec[] = [
  {
    key: "kobotoolbox-api",
    displayName: "KoBoToolbox API",
    category: "FIELD_DATA",
    status: "NOT_CONNECTED",
    description: "Pull form submissions and attachments directly from a KoBoToolbox server.",
    requires: ["Server URL and API token governance", "Asset (form) mapping to OBV projects", "Egress approval", "Attachment retention policy"],
  },
  {
    key: "odk-central",
    displayName: "ODK Central",
    category: "FIELD_DATA",
    status: "NOT_CONNECTED",
    description: "Pull submissions from an ODK Central project via its OData feed.",
    requires: ["Server URL and app-user credentials", "Form mapping to OBV projects", "Egress approval", "Attachment retention policy"],
  },
  {
    key: "government-procurement-portal",
    displayName: "Government procurement portals",
    category: "PROCUREMENT_PORTAL",
    status: "NOT_CONNECTED",
    description: "Publish OC4IDS packages to, or reconcile contract data from, a national procurement portal.",
    requires: ["Portal endpoint and publisher registration", "Publication policy and license", "Data-protection review"],
  },
  {
    key: "development-bank-monitoring",
    displayName: "Development-bank project-monitoring systems",
    category: "PROJECT_MONITORING",
    status: "NOT_CONNECTED",
    description: "Exchange project disclosure and field observations with a development-bank monitoring platform (GEMS-style deployments).",
    requires: ["Institutional agreement", "Endpoint, identity and credential governance", "Egress approval", "Field-data retention policy"],
  },
];

export function interopProviderReadiness(): {
  providers: InteropProviderSpec[];
  connected: number;
  notice: string;
} {
  return {
    providers: INTEROP_PROVIDER_SPECS,
    connected: 0,
    notice:
      "No external provider is connected. OBV neither pulls from nor publishes to any field-data platform, " +
      "procurement portal or monitoring system; the only data path is the deterministic import format, and " +
      "every imported observation stays unverified until a reviewer decides. OBV has no partnership with, and " +
      "no integration into, the World Bank, AfDB or GEMS.",
  };
}
