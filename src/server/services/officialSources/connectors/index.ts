/**
 * Connector registry — the DC source map, each source classified by its
 * ACTUAL officially supported access method (verified against the
 * official documentation; see docs/OFFICIAL_SOURCES.md):
 *
 *   OFFICIAL_OPEN_DATA (ArcGIS adapter; endpoint operator-configured
 *   from the dataset's official API page):
 *     - DOB Building Permits            (Open Data DC dataset)
 *     - DOB Certificates of Occupancy   (Open Data DC dataset)
 *     - DLCP Basic Business Licenses    (Open Data DC dataset)
 *     - Property / parcel references    (Open Data DC dataset)
 *
 *   OFFICIAL_API:
 *     - DDOT TOPS public-space permits  (documented Web API, license key)
 *
 *   OFFICIAL_PORTAL_MANUAL (no supported automated access — manual
 *   verification boundaries; the portal is never scraped):
 *     - DOB inspection records          (Scout)
 *     - DOB enforcement / stop-work     (Scout)
 *     - DLCP professional & contractor licenses (Scout / Access DC)
 *
 *   Deterministic mock (demo/tests; clearly labeled, never presented as
 *   government data).
 */
import type { OfficialSourceConnector } from "./types";
import { makeArcgisConnector } from "./arcgisOpenData";
import { ddotTopsConnector, TOPS_SOURCE_ID } from "./ddotTops";
import { makeManualBoundary } from "./manualBoundary";
import { mockConnector, MOCK_SOURCE_ID } from "./mock";

const DC_GIS_HOSTS = ["maps2.dcgis.dc.gov", "maps.dcgis.dc.gov", "dcgis.dc.gov", "opendata.dc.gov", "services.arcgis.com"];

const dobBuildingPermits = makeArcgisConnector({
  sourceId: "dc-dob-building-permits",
  name: "DOB Building Permits (Open Data DC)",
  agency: "DOB",
  recordType: "PERMIT",
  recordTypes: ["PERMIT"],
  portalUrl: "https://opendata.dc.gov/search?tags=building%20permits",
  docsUrl: "https://opendata.dc.gov/datasets/930907e0c08843c8b30ab36a29b8ff0e/api",
  allowedHosts: DC_GIS_HOSTS,
  fieldCandidates: {
    externalId: ["PERMIT_ID", "PERMITNUMBER", "PERMIT_NO", "OBJECTID"],
    permitNumber: ["PERMIT_ID", "PERMITNUMBER", "PERMIT_NO"],
    status: ["PERMIT_STATUS_NAME", "STATUS", "PERMIT_STATUS", "APPLICATION_STATUS_NAME"],
    address: ["FULL_ADDRESS", "FULLADDRESS", "ADDRESS", "SITE_ADDRESS"],
    party: ["OWNER_NAME", "OWNERNAME", "APPLICANT_NAME", "CONTRACTOR_NAME"],
    applicationDate: ["APPLICATION_DATE", "APPLIED_DATE"],
    issuanceDate: ["ISSUE_DATE", "ISSUED_DATE", "ISSUEDATE"],
    expirationDate: ["EXPIRATION_DATE", "PERMIT_EXPIRATION_DATE", "EXPIRE_DATE"],
    inspectionDate: [],
    inspectionResult: [],
    lastModified: ["LASTMODIFIEDDATE", "LAST_EDITED_DATE", "EDITDATE"],
  },
  expectedUpdateFrequency: "daily (published dataset)",
  termsNotes:
    "Official Open Data DC dataset published for reuse; query via the documented dataset API. Respect the " +
    "platform's rate guidance. The dataset is a snapshot — not the DOB transactional system.",
  retentionNotes: "Published open data; snapshots retained for provenance.",
});

const dobCertificatesOfOccupancy = makeArcgisConnector({
  sourceId: "dc-dob-certificates-occupancy",
  name: "DOB Certificates of Occupancy (Open Data DC)",
  agency: "DOB",
  recordType: "OCCUPANCY_CERTIFICATE",
  recordTypes: ["OCCUPANCY_CERTIFICATE"],
  portalUrl: "https://opendata.dc.gov/datasets/DCGIS::certificate-of-occupancy/about",
  docsUrl: "https://opendata.dc.gov/datasets/DCGIS::certificate-of-occupancy/about",
  allowedHosts: DC_GIS_HOSTS,
  fieldCandidates: {
    externalId: ["COO_NUMBER", "CO_NUMBER", "PERMIT_ID", "OBJECTID"],
    permitNumber: ["COO_NUMBER", "CO_NUMBER", "PERMIT_ID"],
    status: ["STATUS", "COO_STATUS", "CO_STATUS"],
    address: ["FULL_ADDRESS", "FULLADDRESS", "ADDRESS"],
    party: ["BUSINESS_NAME", "TRADE_NAME", "OWNER_NAME"],
    applicationDate: ["APPLICATION_DATE"],
    issuanceDate: ["ISSUE_DATE", "ISSUED_DATE", "COO_ISSUE_DATE"],
    expirationDate: ["EXPIRATION_DATE"],
    inspectionDate: [],
    inspectionResult: [],
    lastModified: ["LASTMODIFIEDDATE", "LAST_EDITED_DATE", "EDITDATE"],
  },
  expectedUpdateFrequency: "regular (published dataset)",
  termsNotes: "Official Open Data DC dataset published for reuse; query via the documented dataset API.",
  retentionNotes: "Published open data; snapshots retained for provenance.",
});

const dlcpBusinessLicenses = makeArcgisConnector({
  sourceId: "dc-dlcp-business-licenses",
  name: "DLCP Basic Business Licenses (Open Data DC)",
  agency: "DLCP",
  recordType: "LICENSE",
  recordTypes: ["LICENSE", "BUSINESS_REGISTRATION"],
  portalUrl: "https://opendata.dc.gov/datasets/DCGIS::basic-business-licenses/about",
  docsUrl: "https://opendata.dc.gov/datasets/DCGIS::basic-business-licenses/about",
  allowedHosts: DC_GIS_HOSTS,
  fieldCandidates: {
    externalId: ["LICENSE_NUMBER", "LICENSENUMBER", "CUSTOMER_NUMBER", "OBJECTID"],
    permitNumber: ["LICENSE_NUMBER", "LICENSENUMBER"],
    status: ["LICENSE_STATUS", "LICENSESTATUS", "STATUS"],
    address: ["FULL_ADDRESS", "ADDRESS", "PREMISE_ADDRESS", "SITE_ADDRESS"],
    party: ["LICENSEE_NAME", "BUSINESS_NAME", "TRADE_NAME", "ENTITY_NAME"],
    applicationDate: ["APPLICATION_DATE"],
    issuanceDate: ["LICENSE_ISSUE_DATE", "ISSUE_DATE", "LICENSE_START_DATE"],
    expirationDate: ["LICENSE_EXPIRATION_DATE", "EXPIRATION_DATE"],
    inspectionDate: [],
    inspectionResult: [],
    lastModified: ["LASTMODIFIEDDATE", "LAST_EDITED_DATE", "EDITDATE"],
  },
  expectedUpdateFrequency: "regular (published dataset)",
  termsNotes:
    "Official Open Data DC dataset of Basic Business Licenses issued by DLCP, including historical records " +
    "that may be inactive. A license's presence proves licensure status only — never construction quality.",
  retentionNotes: "Published open data; snapshots retained for provenance.",
});

const propertyParcels = makeArcgisConnector({
  sourceId: "dc-property-parcels",
  name: "Property & parcel references (Open Data DC)",
  agency: "OCTO",
  recordType: "PROPERTY_REFERENCE",
  recordTypes: ["PROPERTY_REFERENCE"],
  portalUrl: "https://opendata.dc.gov/",
  docsUrl: "https://opendata.dc.gov/",
  allowedHosts: DC_GIS_HOSTS,
  fieldCandidates: {
    externalId: ["SSL", "LOT", "OBJECTID"],
    permitNumber: ["SSL", "LOT"],
    status: [],
    address: ["FULL_ADDRESS", "ADDRESS", "PREMISEADD", "SITE_ADDRESS"],
    party: ["OWNERNAME", "OWNER_NAME"],
    applicationDate: [],
    issuanceDate: [],
    expirationDate: [],
    inspectionDate: [],
    inspectionResult: [],
    lastModified: ["LASTMODIFIEDDATE", "LAST_EDITED_DATE", "EDITDATE"],
  },
  expectedUpdateFrequency: "regular (published dataset)",
  termsNotes: "Official Open Data DC parcel/lot dataset; used for address and parcel cross-references only.",
  retentionNotes: "Published open data; snapshots retained for provenance.",
});

const dobInspections = makeManualBoundary({
  sourceId: "dc-dob-inspections",
  name: "DOB Inspection Records (Scout — manual lookup)",
  agency: "DOB",
  portalUrl: "https://dob.dc.gov/service/online-resources",
  docsUrl: "https://dob.dc.gov/service/online-resources",
  recordTypes: ["INSPECTION"],
  instructions:
    "Look the permit up in DOB's Scout portal and read its inspection history (inspection type, date, result, " +
    "and any correction notices) exactly as the portal shows it.",
  termsNotes:
    "Scout is a public lookup portal without a documented automation API; OBV does not scrape it. Inspections " +
    "are verified by an authorized reviewer performing the portal lookup.",
});

const dobEnforcement = makeManualBoundary({
  sourceId: "dc-dob-enforcement",
  name: "DOB Enforcement & Stop-Work Records (Scout — manual lookup)",
  agency: "DOB",
  portalUrl: "https://dob.dc.gov/service/online-resources",
  docsUrl: "https://dob.dc.gov/service/online-resources",
  recordTypes: ["ENFORCEMENT", "STOP_WORK"],
  instructions:
    "Check DOB's Scout portal and enforcement listings for notices of infraction, stop-work orders, or other " +
    "compliance actions on the property, and record the official wording verbatim.",
  termsNotes:
    "Enforcement and stop-work information is published for portal lookup; no documented automation API. " +
    "OBV does not scrape it.",
});

const dlcpProfessionalLicenses = makeManualBoundary({
  sourceId: "dc-dlcp-professional-licenses",
  name: "DLCP Professional & Contractor Licenses (Scout / Access DC — manual lookup)",
  agency: "DLCP",
  portalUrl: "https://dlcp.dc.gov/node/1619751",
  docsUrl: "https://dlcp.dc.gov/node/1619751",
  recordTypes: ["LICENSE"],
  instructions:
    "Verify the professional or contractor license in DLCP's official license search (Scout / Access DC): " +
    "legal business name, trade name, license number, type, status, issuance and expiration dates, and any " +
    "public disciplinary indicator.",
  termsNotes:
    "Occupational & professional license verification is offered through DLCP's public portals without a " +
    "documented automation API; OBV does not scrape them. A valid license never proves construction quality; " +
    "an expired or missing license is a compliance signal for review — not proof of wrongdoing.",
});

// ------------------------------------------------------------ registry

const CONNECTORS = new Map<string, OfficialSourceConnector>([
  [MOCK_SOURCE_ID, mockConnector],
  ["dc-dob-building-permits", dobBuildingPermits],
  ["dc-dob-certificates-occupancy", dobCertificatesOfOccupancy],
  ["dc-dlcp-business-licenses", dlcpBusinessLicenses],
  ["dc-property-parcels", propertyParcels],
  [TOPS_SOURCE_ID, ddotTopsConnector],
  ["dc-dob-inspections", dobInspections],
  ["dc-dob-enforcement", dobEnforcement],
  ["dc-dlcp-professional-licenses", dlcpProfessionalLicenses],
]);

export function connectorFor(sourceId: string): OfficialSourceConnector | null {
  return CONNECTORS.get(sourceId) ?? null;
}

export function allConnectors(): Array<{ sourceId: string; connector: OfficialSourceConnector }> {
  return [...CONNECTORS.entries()].map(([sourceId, connector]) => ({ sourceId, connector }));
}

/** Test seam: register an additional connector (e.g. an ArcGIS-shaped
 *  connector pointed at a deterministic local mock server). Production
 *  code never calls this. */
export function registerConnectorForTests(sourceId: string, connector: OfficialSourceConnector): void {
  CONNECTORS.set(sourceId, connector);
}

export { MOCK_SOURCE_ID } from "./mock";
export { TOPS_SOURCE_ID } from "./ddotTops";
export { makeArcgisConnector, envNameFor } from "./arcgisOpenData";
export { makeManualBoundary } from "./manualBoundary";
export {
  mockConnector, resetMockFixtures, setMockFixtures, mutateMockRecord,
  removeMockRecord, currentMockRevision,
} from "./mock";
export type {
  ConnectorHealth, ConnectorResult, NormalizedSourceRecord,
  OfficialSourceConnector, RawSourceRecord, SourceProvenance, SourceSearchQuery,
} from "./types";
