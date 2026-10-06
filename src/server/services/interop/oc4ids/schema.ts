/**
 * OC4IDS — the Open Contracting for Infrastructure Data Standard.
 *
 * This module vendors the PROJECT-LEVEL schema of OC4IDS 0.9.5 as a
 * JSON-Schema (draft-04 dialect) subset: every definition OBV's mapping
 * can emit, with the standard's closed codelists expressed as `enum` and
 * its open codelists carried as advisory `codelist` metadata (a value
 * outside an open codelist is permitted by the standard; the validator
 * reports it as a warning, never as an error).
 *
 * WHY VENDORED. OBV has no runtime dependencies and the deployment may
 * have no outbound network access, so the schema OBV validates against
 * must ship with the build. The subset is deliberately explicit about
 * what it covers (`OC4IDS_SCHEMA_COVERAGE`): an export is only ever
 * described as "valid against the implemented OC4IDS 0.9.5 schema
 * subset" — never as certified by the standard's own validator.
 *
 * NOTHING in this file is OBV-specific. OBV's verification, provenance,
 * review and financial-control information is NOT part of OC4IDS and is
 * carried beside an export as OBV metadata (see provenance.ts), never
 * inside these definitions.
 */

export const OC4IDS_VERSION = "0.9.5";
/** The `version` value OC4IDS packages carry (major.minor). */
export const OC4IDS_PACKAGE_VERSION = "0.9";
export const OC4IDS_SCHEMA_ID = `https://standard.open-contracting.org/infrastructure/${OC4IDS_VERSION}/en/_static/project-schema.json`;

// ------------------------------------------------------------ codelists

/** CLOSED codelists (a value outside the list is a validation error). */
export const CLOSED_CODELISTS = {
  projectStatus: ["identification", "preparation", "implementation", "completion", "completed", "cancelled"],
  projectType: ["construction", "expansion", "rehabilitation"],
  milestoneStatus: ["scheduled", "met", "notMet", "partiallyMet"],
  modificationType: ["duration", "value", "scope"],
  contractingProcessStatus: ["pre-award", "active", "closed"],
  procurementMethod: ["open", "selective", "limited", "direct"],
  geometryType: ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"],
  /** ISO 4217 — the currency codelist OC4IDS inherits from OCDS. */
  currency: [
    "AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT","BGN","BHD","BIF","BMD","BND",
    "BOB","BOV","BRL","BSD","BTN","BWP","BYN","BZD","CAD","CDF","CHE","CHF","CHW","CLF","CLP","CNY","COP","COU",
    "CRC","CUC","CUP","CVE","CZK","DJF","DKK","DOP","DZD","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS",
    "GIP","GMD","GNF","GTQ","GYD","HKD","HNL","HRK","HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK","JMD","JOD",
    "JPY","KES","KGS","KHR","KMF","KPW","KRW","KWD","KYD","KZT","LAK","LBP","LKR","LRD","LSL","LYD","MAD","MDL",
    "MGA","MKD","MMK","MNT","MOP","MRU","MUR","MVR","MWK","MXN","MXV","MYR","MZN","NAD","NGN","NIO","NOK","NPR",
    "NZD","OMR","PAB","PEN","PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR","SDG",
    "SEK","SGD","SHP","SLE","SLL","SOS","SRD","SSP","STN","SVC","SYP","SZL","THB","TJS","TMT","TND","TOP","TRY",
    "TTD","TWD","TZS","UAH","UGX","USD","USN","UYI","UYU","UYW","UZS","VED","VES","VND","VUV","WST","XAF","XAG",
    "XAU","XBA","XBB","XBC","XBD","XCD","XDR","XOF","XPD","XPF","XPT","XSU","XTS","XUA","XXX","YER","ZAR","ZMW",
    "ZWG","ZWL",
  ],
} as const;

/** OPEN codelists (values outside the list are permitted; reported as
 *  warnings so a publisher can review them). Only the codes OBV's mapping
 *  may emit are listed exhaustively; the rest of each codelist is
 *  intentionally not reproduced here. */
export const OPEN_CODELISTS: Record<string, readonly string[]> = {
  partyRole: ["publicAuthority", "procuringEntity", "buyer", "supplier", "tenderer", "funder", "payer", "payee", "reviewBody", "interestedParty", "administrativeEntity"],
  projectSector: [
    "agriculture", "communications", "culture", "economy", "education", "energy", "environment", "governance",
    "health", "housing", "mining", "socialProtection", "transport", "transport.air", "transport.rail",
    "transport.road", "transport.water", "waterAndWaste",
  ],
  documentType: ["projectPlan", "projectScope", "budgetApproval", "feasibilityStudy", "environmentalImpact", "physicalProgressReport", "financialProgressReport", "completionCertificate", "finalAudit", "contractSigned", "contractSchedule", "procurementPlan", "tenderNotice", "awardNotice"],
  milestoneType: ["approval", "assessment", "delivery", "engagement", "financing", "reporting"],
  contractNature: ["construction", "designAndConstruction", "design", "supervision"],
};

// ------------------------------------------------------------ schema

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly string[];
  format?: "date-time" | "uri" | "email";
  minLength?: number;
  minimum?: number;
  minItems?: number;
  uniqueItems?: boolean;
  $ref?: string;
  /** Advisory codelist metadata (standard's `codelist` + `openCodelist`). */
  codelist?: string;
  openCodelist?: boolean;
  description?: string;
  definitions?: Record<string, JsonSchema>;
  title?: string;
  $schema?: string;
  id?: string;
}

const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: ["string", "null"], description, ...extra });
const dateTime = (description: string): JsonSchema => ({ type: ["string", "null"], format: "date-time", description });
const ref = (name: string): JsonSchema => ({ $ref: `#/definitions/${name}` });
const arrayOf = (name: string, description: string): JsonSchema => ({ type: "array", items: ref(name), uniqueItems: true, description });
const closed = (codelist: keyof typeof CLOSED_CODELISTS, description: string): JsonSchema => ({
  type: ["string", "null"], enum: [...CLOSED_CODELISTS[codelist]], codelist: `${codelist}.csv`, openCodelist: false, description,
});
const open = (codelist: string, description: string): JsonSchema => ({
  type: ["string", "null"], codelist: `${codelist}.csv`, openCodelist: true, description,
});

/** The project-level schema subset (definition names follow the standard). */
export const OC4IDS_PROJECT_SCHEMA: JsonSchema = {
  $schema: "http://json-schema.org/draft-04/schema#",
  id: OC4IDS_SCHEMA_ID,
  title: `OC4IDS ${OC4IDS_VERSION} project schema (OBV-implemented subset)`,
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1, description: "A globally unique identifier for the project: {prefix}-{identifier}, where the prefix is registered with the OC4IDS publisher registry." },
    updated: dateTime("The date and time at which the project information was last updated."),
    title: str("The project's title."),
    description: str("A description of the project."),
    status: closed("projectStatus", "The current phase of the project."),
    period: ref("Period"),
    sector: { type: "array", items: open("projectSector", "A sector code."), uniqueItems: true, codelist: "projectSector.csv", openCodelist: true, description: "The sector(s) the project belongs to." },
    additionalClassifications: arrayOf("Classification", "Additional classifications of the project."),
    type: closed("projectType", "The type of project: whether it creates, expands or rehabilitates an asset."),
    purpose: str("The purpose of the project."),
    locations: arrayOf("Location", "The locations where the project is being carried out."),
    budget: ref("Budget"),
    parties: arrayOf("Organization", "Organizations involved in the project."),
    publicAuthority: ref("OrganizationReference"),
    documents: arrayOf("Document", "Documents related to the project."),
    contractingProcesses: arrayOf("ContractingProcess", "The contracting processes associated with the project."),
    milestones: arrayOf("Milestone", "Milestones associated with the project."),
    completion: ref("Completion"),
    relatedProjects: arrayOf("RelatedProject", "Related projects."),
  },
  definitions: {
    Period: {
      type: "object",
      properties: {
        startDate: dateTime("The start date for the period."),
        endDate: dateTime("The end date for the period."),
        maxExtentDate: dateTime("The latest possible end date of the period."),
        durationInDays: { type: ["integer", "null"], minimum: 0, description: "The duration of the period in days." },
      },
    },
    Classification: {
      type: "object",
      properties: {
        scheme: str("The scheme or codelist from which the classification code is taken."),
        id: str("The classification code."),
        description: str("A textual description of the code."),
        uri: str("A URI identifying the code.", { format: "uri" }),
      },
    },
    Geometry: {
      type: "object",
      properties: {
        type: closed("geometryType", "The GeoJSON geometry type."),
        coordinates: { type: ["array", "null"], description: "GeoJSON coordinates: [longitude, latitude] pairs, nested per geometry type." },
      },
    },
    Address: {
      type: "object",
      properties: {
        streetAddress: str("The street address."),
        locality: str("The locality (e.g. city)."),
        region: str("The region (e.g. state or province)."),
        postalCode: str("The postal code."),
        countryName: str("The country name."),
      },
    },
    Location: {
      type: "object",
      properties: {
        id: str("A local identifier for the location."),
        description: str("A name or description of the location."),
        geometry: ref("Geometry"),
        uri: str("A URI to a further description of the location.", { format: "uri" }),
        address: ref("Address"),
      },
    },
    Value: {
      type: "object",
      properties: {
        amount: { type: ["number", "null"], description: "Amount as a number." },
        currency: closed("currency", "The ISO 4217 currency of the amount."),
      },
    },
    Budget: {
      type: "object",
      properties: {
        amount: ref("Value"),
        approvalDate: dateTime("The date the project budget was approved."),
      },
    },
    Identifier: {
      type: "object",
      properties: {
        scheme: str("The identifier scheme (e.g. org-id.guide)."),
        id: str("The identifier."),
        legalName: str("The legally registered name."),
        uri: str("A URI for the identifier.", { format: "uri" }),
      },
    },
    ContactPoint: {
      type: "object",
      properties: {
        name: str("Contact name."),
        email: str("Contact email.", { format: "email" }),
        telephone: str("Contact telephone."),
        url: str("Contact web address.", { format: "uri" }),
      },
    },
    Organization: {
      type: "object",
      properties: {
        name: str("The organization's common name."),
        id: str("The organization's identifier within this package (parties cross-reference it)."),
        identifier: ref("Identifier"),
        additionalIdentifiers: arrayOf("Identifier", "Additional identifiers."),
        address: ref("Address"),
        contactPoint: ref("ContactPoint"),
        roles: { type: "array", items: open("partyRole", "A party role."), uniqueItems: true, codelist: "partyRole.csv", openCodelist: true, description: "The roles the organization plays in the project." },
      },
    },
    OrganizationReference: {
      type: "object",
      properties: {
        name: str("The organization's name, matching its parties entry."),
        id: str("The organization's id in the parties array."),
      },
    },
    Document: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "A local identifier for the document." },
        documentType: open("documentType", "The document type."),
        title: str("The document title."),
        description: str("A short description of the document."),
        url: str("A direct link to the document.", { format: "uri" }),
        datePublished: dateTime("The date the document was first published."),
        dateModified: dateTime("The date the document was last modified."),
        format: str("The document format (IANA media type)."),
        language: str("The document language (BCP47)."),
        author: str("The document author."),
      },
    },
    Milestone: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "A local identifier for the milestone." },
        title: str("Milestone title."),
        type: open("milestoneType", "The milestone type."),
        description: str("A description of the milestone."),
        code: str("Milestone code."),
        dueDate: dateTime("The date the milestone is due."),
        dateMet: dateTime("The date the milestone was met."),
        dateModified: dateTime("The date the milestone was last reviewed or modified."),
        status: closed("milestoneStatus", "The milestone status."),
        documents: arrayOf("Document", "Documents about the milestone."),
      },
    },
    Modification: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "A local identifier for the modification." },
        date: dateTime("The date of the modification."),
        description: str("A description of the modification."),
        rationale: str("The rationale for the modification."),
        type: closed("modificationType", "The nature of the modification."),
        oldContractValue: ref("Value"),
        newContractValue: ref("Value"),
        oldContractPeriod: ref("Period"),
        newContractPeriod: ref("Period"),
      },
    },
    Tender: {
      type: "object",
      properties: {
        procurementMethod: closed("procurementMethod", "The procurement method."),
        procurementMethodDetails: str("Additional detail on the procurement method."),
        costEstimate: ref("Value"),
        numberOfTenderers: { type: ["integer", "null"], minimum: 0, description: "The number of tenderers." },
        tenderers: arrayOf("OrganizationReference", "Tenderers."),
        administrativeEntity: ref("OrganizationReference"),
        tenderPeriod: ref("Period"),
      },
    },
    ContractingProcessSummary: {
      type: "object",
      properties: {
        ocid: str("The OCDS contracting process identifier, when one exists."),
        externalReference: str("An external reference for the contracting process."),
        nature: { type: "array", items: open("contractNature", "Contract nature."), uniqueItems: true, codelist: "contractNature.csv", openCodelist: true, description: "The nature of the contract." },
        title: str("The contracting process title."),
        description: str("A description of the contracting process."),
        status: closed("contractingProcessStatus", "The contracting process status."),
        tender: ref("Tender"),
        suppliers: arrayOf("OrganizationReference", "The suppliers."),
        contractValue: ref("Value"),
        contractPeriod: ref("Period"),
        finalValue: ref("Value"),
        documents: arrayOf("Document", "Documents about the contracting process."),
        modifications: arrayOf("Modification", "Modifications to the contract."),
      },
    },
    LinkedRelease: {
      type: "object",
      properties: {
        id: str("The release id."),
        tag: { type: "array", items: { type: "string" }, description: "Release tags." },
        date: dateTime("The release date."),
        url: str("The release URL.", { format: "uri" }),
      },
    },
    ContractingProcess: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "A local identifier for the contracting process." },
        summary: ref("ContractingProcessSummary"),
        releases: arrayOf("LinkedRelease", "Linked OCDS releases."),
      },
    },
    Completion: {
      type: "object",
      properties: {
        endDate: dateTime("The actual completion date."),
        endDateDetails: str("Details about the completion date."),
        finalValue: ref("Value"),
        finalValueDetails: str("Details about the final value."),
        finalScope: str("The final scope of the project."),
        finalScopeDetails: str("Details about the final scope."),
      },
    },
    RelatedProject: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", minLength: 1, description: "A local identifier for the relationship." },
        scheme: str("The scheme of the related project's identifier."),
        identifier: str("The related project's identifier."),
        relationship: str("The nature of the relationship."),
        title: str("The related project's title."),
        uri: str("A URI for the related project.", { format: "uri" }),
      },
    },
  },
};

/** The project package envelope (project-package-schema.json). */
export const OC4IDS_PACKAGE_SCHEMA: JsonSchema = {
  $schema: "http://json-schema.org/draft-04/schema#",
  title: `OC4IDS ${OC4IDS_VERSION} project package (OBV-implemented subset)`,
  type: "object",
  required: ["uri", "publishedDate", "publisher", "version", "projects"],
  properties: {
    uri: { type: "string", format: "uri", description: "The URI of this package that identifies it uniquely." },
    publishedDate: { type: "string", format: "date-time", description: "The date this package was published." },
    publisher: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, description: "The name of the organization publishing the package." },
        scheme: str("The scheme of the publisher identifier."),
        uid: str("The publisher's identifier under the scheme."),
        uri: str("A URI for the publisher.", { format: "uri" }),
      },
    },
    license: str("A link to the license under which the data is published.", { format: "uri" }),
    publicationPolicy: str("A link to the publication policy.", { format: "uri" }),
    version: { type: "string", enum: [OC4IDS_PACKAGE_VERSION], description: "The OC4IDS version the package conforms to." },
    projects: { type: "array", items: OC4IDS_PROJECT_SCHEMA, minItems: 1, description: "One or more projects." },
  },
};

/** Stated, inspectable coverage of the vendored subset. */
export const OC4IDS_SCHEMA_COVERAGE = {
  standard: "OC4IDS",
  version: OC4IDS_VERSION,
  packageVersion: OC4IDS_PACKAGE_VERSION,
  schemaId: OC4IDS_SCHEMA_ID,
  implementedProjectFields: Object.keys(OC4IDS_PROJECT_SCHEMA.properties ?? {}),
  implementedDefinitions: Object.keys(OC4IDS_PROJECT_SCHEMA.definitions ?? {}),
  closedCodelists: Object.keys(CLOSED_CODELISTS),
  openCodelists: Object.keys(OPEN_CODELISTS),
  /** JSON-Schema keywords the validator enforces. Anything else in the
   *  standard's full schema is not evaluated here and is said so. */
  validatorKeywords: ["type", "properties", "required", "items", "enum", "format", "minLength", "minimum", "minItems", "uniqueItems", "$ref"],
  notImplemented: [
    "forecasts", "metrics", "transactions", "lobbyingMeetings", "social", "environment", "benefits",
    "costMeasurements", "assetLifetime", "phase periods (identificationPeriod … decommissioningPeriod)",
    "budgetBreakdowns", "language", "policyAlignment",
  ],
  statement:
    "Validation is performed against this vendored subset of the OC4IDS 0.9.5 project and package schemas. " +
    "A READY export is valid against the implemented subset; it has not been checked by the standard's own online validator.",
} as const;
