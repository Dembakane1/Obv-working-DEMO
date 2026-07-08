/**
 * Project Setup Templates — reusable pilot configuration starting points.
 * A template creates CONFIGURATION only: milestones, evidence
 * requirements, and an approval-matrix default. It can never create
 * evidence, verifications, approvals, ledger entries, or release state,
 * and everything it creates is editable afterwards.
 */
import type {
  EvidenceRequirementType,
  PilotProjectCategory,
  UserRole,
} from "../../../shared/types";

export interface TemplateRequirement {
  type: EvidenceRequirementType;
  title: string;
  description: string;
  required: boolean;
  minCount: number;
  mediaTypes: string[];
  geolocationRequired: boolean;
  recencyDays: number | null;
}

export interface TemplateMilestone {
  title: string;
  requirement: string;
  /** Share of the OBV-controlled amount (all shares sum to 1). */
  trancheShare: number;
  requirements: TemplateRequirement[];
}

export interface ProjectTemplate {
  key: string;
  name: string;
  description: string;
  categories: PilotProjectCategory[];
  geometryHint: "CORRIDOR" | "POLYGON" | "POINT";
  approvalRoles: UserRole[];
  milestones: TemplateMilestone[];
}

const PHOTO_SET = (what: string, min = 3): TemplateRequirement => ({
  type: "PHOTO",
  title: `Site progress photo set — ${what}`,
  description: `Minimum ${min} geolocated photos showing ${what}.`,
  required: true,
  minCount: min,
  mediaTypes: ["image/jpeg", "image/png", "image/webp"],
  geolocationRequired: true,
  recencyDays: 7,
});

const DOC = (title: string, description: string): TemplateRequirement => ({
  type: "DOCUMENT",
  title,
  description,
  required: true,
  minCount: 1,
  mediaTypes: ["application/pdf"],
  geolocationRequired: false,
  recencyDays: null,
});

const INSPECTION = (what: string): TemplateRequirement => ({
  type: "INSPECTION",
  title: `Supervising engineer inspection — ${what}`,
  description: `Inspection confirmation for ${what}, recorded before approval.`,
  required: true,
  minCount: 1,
  mediaTypes: [],
  geolocationRequired: false,
  recencyDays: null,
});

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    key: "road-rehabilitation",
    name: "Road Rehabilitation",
    description:
      "Corridor road works: mobilization, earthworks & drainage, base course, surfacing, handover.",
    categories: ["ROAD", "BRIDGE"],
    geometryHint: "CORRIDOR",
    approvalRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"],
    milestones: [
      {
        title: "Site mobilization & clearing",
        requirement:
          "Photo evidence of contractor mobilization: equipment on site and cleared alignment at the corridor start.",
        trancheShare: 0.1,
        requirements: [PHOTO_SET("mobilized equipment and cleared alignment")],
      },
      {
        title: "Earthworks, grading & drainage",
        requirement:
          "Photo evidence of completed earthworks and installed drainage structures along the corridor.",
        trancheShare: 0.2,
        requirements: [
          PHOTO_SET("completed earthworks and drainage structures"),
          DOC("Drainage works completion certificate", "Contractor certificate for drainage structures."),
        ],
      },
      {
        title: "Base course placement & compaction",
        requirement:
          "Photo evidence of placed and compacted base course across the full carriageway width.",
        trancheShare: 0.3,
        requirements: [
          PHOTO_SET("compacted base course across full width"),
          DOC("Compaction test results", "Laboratory compaction test results (PDF)."),
          INSPECTION("base course"),
        ],
      },
      {
        title: "Surfacing",
        requirement: "Photo evidence of the finished running surface over the works section.",
        trancheShare: 0.25,
        requirements: [PHOTO_SET("finished running surface"), INSPECTION("surfacing")],
      },
      {
        title: "Signage, furniture & handover",
        requirement:
          "Photo evidence of installed signage and road furniture plus the signed handover certificate.",
        trancheShare: 0.15,
        requirements: [
          PHOTO_SET("installed signage and road furniture"),
          DOC("Signed handover certificate", "Signed handover / taking-over certificate."),
        ],
      },
    ],
  },
  {
    key: "school-construction",
    name: "School Construction",
    description:
      "Classroom-block construction: foundations, superstructure, roofing, finishes, furniture & handover.",
    categories: ["SCHOOL", "BUILDING"],
    geometryHint: "POLYGON",
    approvalRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"],
    milestones: [
      {
        title: "Foundations complete",
        requirement: "Photo evidence of excavated and cast foundations for the classroom block.",
        trancheShare: 0.2,
        requirements: [PHOTO_SET("cast foundations"), INSPECTION("foundations")],
      },
      {
        title: "Superstructure to wall plate",
        requirement: "Photo evidence of walls raised to wall-plate level.",
        trancheShare: 0.3,
        requirements: [PHOTO_SET("walls at wall-plate level")],
      },
      {
        title: "Roofing complete",
        requirement: "Photo evidence of the completed roof structure and covering.",
        trancheShare: 0.2,
        requirements: [PHOTO_SET("completed roof"), DOC("Roofing material delivery notes", "Delivery notes for roofing materials.")],
      },
      {
        title: "Finishes & fittings",
        requirement: "Photo evidence of internal/external finishes, doors, windows and fittings.",
        trancheShare: 0.2,
        requirements: [PHOTO_SET("finishes and fittings")],
      },
      {
        title: "Furniture & handover",
        requirement: "Photo evidence of furnished classrooms and the signed handover certificate.",
        trancheShare: 0.1,
        requirements: [
          PHOTO_SET("furnished classrooms"),
          DOC("Signed handover certificate", "Signed handover certificate."),
        ],
      },
    ],
  },
  {
    key: "clinic-rehabilitation",
    name: "Clinic / Small Building Rehabilitation",
    description: "Rehabilitation of an existing clinic or small public building in three stages.",
    categories: ["CLINIC", "BUILDING"],
    geometryHint: "POLYGON",
    approvalRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"],
    milestones: [
      {
        title: "Strip-out & structural repairs",
        requirement: "Photo evidence of completed strip-out and structural repair works.",
        trancheShare: 0.35,
        requirements: [PHOTO_SET("strip-out and structural repairs")],
      },
      {
        title: "Services & finishes",
        requirement: "Photo evidence of renewed electrical/water services and finishes.",
        trancheShare: 0.4,
        requirements: [
          PHOTO_SET("renewed services and finishes"),
          DOC("Electrical test certificate", "Electrical installation test certificate."),
        ],
      },
      {
        title: "Equipment & handover",
        requirement: "Photo evidence of installed equipment and the signed handover certificate.",
        trancheShare: 0.25,
        requirements: [
          PHOTO_SET("installed equipment"),
          DOC("Signed handover certificate", "Signed handover certificate."),
        ],
      },
    ],
  },
  {
    key: "water-infrastructure",
    name: "Water Infrastructure",
    description: "Borehole / small piped-water scheme: drilling, civil works, distribution, commissioning.",
    categories: ["WATER"],
    geometryHint: "POINT",
    approvalRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"],
    milestones: [
      {
        title: "Drilling & casing complete",
        requirement: "Photo evidence of the drilled and cased borehole with drilling log.",
        trancheShare: 0.3,
        requirements: [PHOTO_SET("drilled and cased borehole"), DOC("Drilling log", "Contractor drilling log (PDF).")],
      },
      {
        title: "Civil works & pump installation",
        requirement: "Photo evidence of completed civil works and installed pump.",
        trancheShare: 0.35,
        requirements: [PHOTO_SET("civil works and installed pump")],
      },
      {
        title: "Distribution & taps",
        requirement: "Photo evidence of the distribution line and installed tap points.",
        trancheShare: 0.2,
        requirements: [PHOTO_SET("distribution line and tap points")],
      },
      {
        title: "Water quality & commissioning",
        requirement: "Water-quality test results and photo evidence of the commissioned scheme.",
        trancheShare: 0.15,
        requirements: [
          DOC("Water quality test results", "Laboratory water-quality test results."),
          PHOTO_SET("commissioned scheme in operation", 2),
        ],
      },
    ],
  },
  {
    key: "generic-infrastructure",
    name: "Generic Infrastructure",
    description: "A minimal three-milestone structure for any physical works project.",
    categories: ["OTHER_INFRASTRUCTURE", "ENERGY", "BUILDING"],
    geometryHint: "POLYGON",
    approvalRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"],
    milestones: [
      {
        title: "Works commenced",
        requirement: "Photo evidence of mobilization and commencement of works on site.",
        trancheShare: 0.25,
        requirements: [PHOTO_SET("mobilization and commencement")],
      },
      {
        title: "Works substantially complete",
        requirement: "Photo evidence of substantially completed works.",
        trancheShare: 0.5,
        requirements: [PHOTO_SET("substantially completed works"), INSPECTION("substantial completion")],
      },
      {
        title: "Completion & handover",
        requirement: "Photo evidence of completed works and the signed handover certificate.",
        trancheShare: 0.25,
        requirements: [
          PHOTO_SET("completed works"),
          DOC("Signed handover certificate", "Signed handover certificate."),
        ],
      },
    ],
  },
];

export function getTemplate(key: string): ProjectTemplate | null {
  return PROJECT_TEMPLATES.find((t) => t.key === key) ?? null;
}

export function templatesForCategory(category: string | null): ProjectTemplate[] {
  if (!category) return PROJECT_TEMPLATES;
  const matching = PROJECT_TEMPLATES.filter((t) => t.categories.includes(category as never));
  return matching.length ? matching : PROJECT_TEMPLATES;
}
