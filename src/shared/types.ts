/**
 * OBV (OpenBuild Verify) — shared domain types.
 *
 * These types are the single source of truth for the core data model.
 * The persistence layer (currently node:sqlite) maps rows to these shapes;
 * when the app migrates to Prisma + PostgreSQL the Prisma schema should
 * mirror these entities one-to-one.
 */

export type UserRole =
  | "FUNDER_REP"
  | "PROJECT_MANAGER"
  | "COMPLIANCE_REVIEWER"
  | "FIELD";

/** Future-ready: OBV may later verify mining supply chains, chain of
 *  custody and battery passports. Only INFRASTRUCTURE is used today. */
export type ProjectType =
  | "INFRASTRUCTURE"
  | "MINING_SUPPLY_CHAIN"
  | "BATTERY_PASSPORT";

export type ProjectStatus = "DRAFT" | "ACTIVE" | "COMPLETED" | "SUSPENDED";

export type MilestoneStatus =
  | "NOT_STARTED"
  | "PENDING_EVIDENCE" // waiting for field capture
  | "UNDER_REVIEW"     // evidence submitted, verification flagged NEEDS_REVIEW
  | "VERIFIED"         // AI verification passed; awaiting human approval
  | "APPROVED"         // human governance approved
  | "RELEASED";        // tranche released on the virtual account ledger

/** Virtual project-account state of a milestone tranche. This is
 *  project-level financial control logic — NOT cryptocurrency and NOT
 *  real bank movement. */
export type AccountStatus = "HELD" | "RELEASED";

export type Verdict = "VERIFIED" | "NEEDS_REVIEW" | "REJECTED";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface Organization {
  id: string;
  name: string;
  kind: string; // e.g. "DEVELOPMENT_FINANCE", "GOVERNMENT", "CONTRACTOR"
  /** Pilot-onboarding profile (additive; null-filled on legacy rows). */
  profile?: OrganizationProfile;
}

export interface User {
  id: string;
  organizationId: string;
  name: string;
  role: UserRole;
  title: string;
}

/** [longitude, latitude] pairs forming a closed polygon (geofence). */
export type GeoPolygon = Array<[number, number]>;

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  location: string;
  /** Demo-compatible geofence representation (GeoJSON-style ring). */
  siteBoundary: GeoPolygon;
  totalBudget: number; // whole currency units (USD)
  status: ProjectStatus;
  projectType: ProjectType;
  /** Pilot-onboarding configuration (additive; always present on rows
   *  read through the repository — optional only for constructors). */
  pilot?: ProjectPilotConfig;
}

export interface Milestone {
  id: string;
  projectId: string;
  seq: number;
  title: string;
  requirement: string; // what the evidence photo must show
  trancheAmount: number;
  status: MilestoneStatus;
  accountStatus: AccountStatus;
  /** Pilot-onboarding planning fields (additive; null on legacy rows). */
  plannedStart?: string | null;
  plannedEnd?: string | null;
  weight?: number | null;
  spatialLabel?: string | null;
  archived?: boolean;
}

export interface DeviceMetadata {
  userAgent: string;
  platform: string;
  screen: string;
  language: string;
}

export interface EvidenceItem {
  id: string;
  milestoneId: string;
  userId: string;
  photoPath: string; // served URL path, e.g. /uploads/... or /demo-evidence/...
  /** Null when the device provided no usable GPS fix (never silently passed). */
  latitude: number | null;
  longitude: number | null;
  capturedAt: string; // ISO 8601
  uploadedAt: string; // ISO 8601
  deviceMetadata: DeviceMetadata;
  /** sha256 of the photo bytes — anchors the photo into the ledger. */
  hash: string;
  /** Hash of the previous evidence item for the same milestone, if any. */
  previousHash: string | null;
  isDemoFallback: boolean;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Provenance of the visual assessment behind a Verification. */
export type VerificationSource = "LIVE_AI" | "MOCK_FALLBACK" | "MOCK_DEFAULT";

export interface Verification {
  id: string;
  evidenceItemId: string;
  verdict: Verdict;
  confidence: number; // 0..1
  checks: VerificationCheck[];
  reasoning: string;
  createdAt: string;
  /** Whether the visual check came from the live model or the mock. */
  source: VerificationSource;
  /** Project configuration version this verification was evaluated under. */
  policyVersion?: number | null;
}

/** What an ApprovalRequest governs. MILESTONE is the original evidence-
 *  driven tranche gate; DRAW governs a lender Draw Request. Both use the
 *  same ApprovalRecord machinery, matrices and separation of duties. */
export type ApprovalSubjectType = "MILESTONE" | "DRAW";

export interface ApprovalRequest {
  id: string;
  /** Set when subjectType is MILESTONE. */
  milestoneId: string | null;
  /** Set when subjectType is DRAW (additive; null on legacy rows). */
  drawRequestId?: string | null;
  subjectType?: ApprovalSubjectType;
  status: ApprovalStatus;
  requiredRoles: UserRole[];
  createdAt: string;
}

/** Placeholder relationship for the full multi-role approval workflow
 *  (added in a later prompt). */
export interface ApprovalRecord {
  id: string;
  approvalRequestId: string;
  userId: string;
  role: UserRole;
  decision: ApprovalStatus;
  createdAt: string;
}

export interface VirtualAccountEvent {
  id: string;
  milestoneId: string;
  type: AccountStatus; // HELD or RELEASED
  amount: number;
  createdAt: string;
}

export type NotificationDeliveryMode = "TEAMS_WEBHOOK" | "MOCK";
export type NotificationDeliveryStatus = "SENT" | "FAILED" | "SKIPPED";

export interface Notification {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  /** Optional context for the notification provenance view. */
  projectId?: string | null;
  milestoneId?: string | null;
  /** Delivery provenance — Teams is a notification channel only. */
  deliveryMode: NotificationDeliveryMode;
  deliveryStatus: NotificationDeliveryStatus;
  sentAt?: string | null;
  /** Sanitized failure category (never secrets or webhook URLs). */
  failureCategory?: string | null;
}

/** Append-only, hash-chained evidence ledger entry. */
export interface LedgerEntry {
  id: string;
  seq: number;
  evidenceItemId: string;
  milestoneId: string;
  verificationId: string;
  timestamp: string;
  payloadHash: string;
  previousHash: string;
  currentHash: string;
}

export interface DemoFallbackPhoto {
  id: string;
  milestoneId: string;
  path: string;
  label: string;
}

/** Payload the field PWA posts to /api/evidence. */
export interface EvidenceSubmission {
  milestoneId: string;
  /** data: URL of the captured photo, or absent when demoPhotoId is set. */
  photoDataUrl?: string;
  /** ID of a seeded DemoFallbackPhoto (DEMO FALLBACK path). */
  demoPhotoId?: string;
  latitude: number;
  longitude: number;
  capturedAt: string;
  deviceMetadata: DeviceMetadata;
  isDemoFallback: boolean;
}

/** A generated funder-report artifact (PDF stored under data/reports/). */
export interface Report {
  id: string;
  projectId: string;
  reportType: string; // 'VERIFICATION_FUND_RELEASE'
  filename: string;
  generatedAt: string;
  generatedBy: string; // user id
  /** 'INTACT' or 'TAMPERED_AT:<seq>' — ledger state when generated. */
  integrityStatus: string;
  ledgerEntries: number;
}

// ---------------------------------------------------------------------
// Spatial project intelligence (additive; presentation-layer data only —
// the map reads existing verification/governance state, never computes it)
// ---------------------------------------------------------------------

/**
 * Demonstration geometry for the seeded project: the road corridor
 * centerline (ROUTE) and per-milestone corridor segments (SEGMENT).
 * Labels are explicit demo metadata (e.g. "km 0–2"); OBV does not infer
 * engineering quantities from geometry.
 */
export interface SpatialFeature {
  id: string;
  projectId: string;
  milestoneId: string | null; // null for the project ROUTE
  kind: "ROUTE" | "SEGMENT";
  label: string;
  geometry: GeoPolygon; // [lng, lat] vertices (open polyline for routes)
}

// ---------------------------------------------------------------------
// Contextual project communications (additive)
//
// CHAT COORDINATES. MAP EXPLAINS WHERE. EVIDENCE PROVES. VERIFICATION
// ASSESSES. HUMANS AUTHORIZE. LEDGER RECORDS.
//
// Messages NEVER change financial or governance state. Only the existing
// ApprovalRequest workflow can create release eligibility.
// ---------------------------------------------------------------------

export type ThreadScope = "ORGANIZATION" | "PROJECT" | "MILESTONE" | "EVIDENCE" | "APPROVAL" | "DRAW";

/** OBV is the real internal provider; TEAMS/WHATSAPP are architecture-
 *  ready seams for future sync (see docs/COMMUNICATIONS_INTEGRATION.md). */
export type MessageProvider = "OBV" | "TEAMS" | "WHATSAPP";

export type ChatMessageType =
  | "TEXT"
  | "SYSTEM_EVENT"
  | "EVIDENCE_REFERENCE"
  | "MILESTONE_REFERENCE"
  | "APPROVAL_REFERENCE"
  | "REPORT_REFERENCE"
  | "ISSUE_REFERENCE"
  | "CLARIFICATION_REFERENCE"
  | "DRAW_REFERENCE"
  | "DRAW_LINE_REFERENCE"
  | "DRAW_DOCUMENT_REFERENCE";

export interface ConversationThread {
  id: string;
  organizationId: string;
  projectId: string | null;
  milestoneId: string | null;
  evidenceItemId: string | null;
  approvalRequestId: string | null;
  /** Set for DRAW-scope threads (additive; null on legacy rows). */
  drawRequestId?: string | null;
  title: string;
  scope: ThreadScope;
  createdAt: string;
  createdBy: string; // user id
}

export interface ChatMessage {
  id: string;
  threadId: string;
  senderUserId: string | null; // null for SYSTEM_EVENT
  senderDisplayName: string;
  provider: MessageProvider;
  externalThreadId: string | null; // future Teams/WhatsApp mapping
  externalMessageId: string | null;
  body: string;
  messageType: ChatMessageType;
  /** Referenced record id for *_REFERENCE types (evidence/milestone/approval/report). */
  refId: string | null;
  createdAt: string;
  deliveryStatus: "SENT" | "PENDING" | "DELIVERED" | "READ" | "FAILED" | "SKIPPED";
  /** Loop-prevention origin (see MessageOrigin below). */
  origin: MessageOrigin;
  /** External edit audit: original body is preserved on first edit. */
  editedAt: string | null;
  originalBody: string | null;
  /** Deleted in the external provider (content kept for audit). */
  externalDeleted: boolean;
  /** Communication attachments — never auto-promoted to evidence. */
  attachments: MessageAttachment[];
  /** Shared communication location (never evidence GPS by itself). */
  location: MessageLocation | null;
}

// ---------------------------------------------------------------------
// Teams conversation synchronization (additive).
//
// STRICT SEPARATION: TeamsNotifier stays the one-way EVENT NOTIFICATION
// channel (workflow cards). The conversation bridge below synchronizes
// COORDINATION MESSAGES only. Neither can create ApprovalRecords, touch
// the VirtualAccountService, or turn chat content into evidence.
// ---------------------------------------------------------------------

/** Where a message originated — the loop-prevention anchor.
 *  OBV_LOCAL messages may sync outbound once; TEAMS_INBOUND messages are
 *  never echoed back. */
export type MessageOrigin = "OBV_LOCAL" | "TEAMS_INBOUND" | "WHATSAPP_INBOUND";

/** Communication attachment metadata (a chat artifact — NEVER evidence;
 *  evidence enters only through the governed submission workflow). */
export interface MessageAttachment {
  name: string;
  url: string | null;
  /** Communication-media kind (IMAGE/VIDEO/AUDIO/DOCUMENT). */
  kind?: "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT";
  /** Provider media identifier (provenance; never a secret). */
  externalMediaId?: string;
  mimeType?: string;
}

/** A location shared in chat — COMMUNICATION context only, never
 *  evidence capture geolocation unless explicitly associated during a
 *  governed evidence-draft promotion. */
export interface MessageLocation {
  latitude: number;
  longitude: number;
  name?: string;
}

export type BindingStatus =
  | "CONNECTING"
  | "ACTIVE"
  | "DEGRADED"
  | "DISCONNECTED"
  | "PERMISSION_REQUIRED";

/** Maps one OBV thread to one Teams channel conversation target.
 *  Contains identifiers only — never credentials, tokens or secrets. */
export interface ExternalThreadBinding {
  id: string;
  threadId: string;
  provider: "TEAMS";
  tenantId: string;
  teamId: string;
  channelId: string;
  rootMessageId: string | null;
  /** Display names captured at connect time (verification succeeded). */
  teamName: string | null;
  channelName: string | null;
  subscriptionId: string | null;
  subscriptionExpiresAt: string | null;
  status: BindingStatus;
  lastSyncAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Explicit Teams identity -> OBV user mapping. Never inferred from
 *  display-name similarity; unmapped identities stay clearly external. */
export interface ExternalIdentityMapping {
  id: string;
  provider: "TEAMS" | "WHATSAPP";
  /** Teams: Entra tenant id. WhatsApp: business-account id. */
  tenantId: string;
  organizationId?: string | null;
  externalUserId: string;
  obvUserId: string | null;
  externalDisplayName: string;
  externalEmail: string | null;
  status: "MAPPED" | "UNMAPPED";
  createdAt: string;
  updatedAt: string;
}


// ---------------------------------------------------------------------
// WhatsApp field-operations bridge + field issue workflow (additive).
//
// WHATSAPP COORDINATES. OBV EVIDENCE PROVES. VERIFICATION ASSESSES.
// HUMANS AUTHORIZE THROUGH THE FORMAL APPROVAL WORKFLOW. THE LEDGER
// RECORDS. CHAT DOES NOT RELEASE FUNDS.
// ---------------------------------------------------------------------

/** Where an external participant's inbound messages currently belong.
 *  Explicit assignment only — context is NEVER guessed from text. */
export interface ExternalParticipantContext {
  id: string;
  provider: "WHATSAPP" | "TEAMS";
  /** External user key (WhatsApp: wa phone id). */
  externalUserId: string;
  activeProjectId: string | null;
  activeThreadId: string | null;
  activeMilestoneId: string | null;
  /** Last inbound time — drives the outbound service-window policy. */
  lastInboundAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
}

export type FieldIssueCategory =
  | "QUALITY" | "SAFETY" | "MATERIAL" | "SCHEDULE" | "ACCESS"
  | "ENVIRONMENTAL" | "DOCUMENTATION" | "EQUIPMENT" | "OTHER";
export type FieldIssueSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type FieldIssueStatus =
  | "OPEN" | "ACKNOWLEDGED" | "IN_PROGRESS" | "AWAITING_FIELD_RESPONSE"
  | "RESOLVED" | "CLOSED";

/** Operational field issue. Informs humans; NEVER changes financial
 *  state — release eligibility stays exclusively with the existing
 *  ApprovalRequest governance workflow. */
export interface FieldIssue {
  id: string;
  organizationId: string;
  projectId: string;
  milestoneId: string | null;
  evidenceItemId: string | null;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  title: string;
  description: string;
  category: FieldIssueCategory;
  severity: FieldIssueSeverity;
  status: FieldIssueStatus;
  reportedByUserId: string | null;
  reportedByExternalIdentityId: string | null;
  assignedToUserId: string | null;
  /** Optional coordinates from an explicitly linked location message. */
  latitude: number | null;
  longitude: number | null;
  dueAt: string | null;
  resolvedAt: string | null;
  resolutionSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Field-issue operational timeline entry (NOT the Evidence Ledger). */
export interface FieldIssueEvent {
  id: string;
  issueId: string;
  type: "CREATED" | "STATUS_CHANGED" | "ASSIGNED" | "COMMENT" | "RESOLVED";
  detail: string;
  actorUserId: string | null;
  createdAt: string;
}

export type ClarificationResponseType =
  | "TEXT" | "PHOTO" | "DOCUMENT" | "LOCATION" | "SITE_REVISIT";
export type ClarificationStatus =
  | "OPEN" | "RESPONDED" | "ACCEPTED" | "REOPENED" | "CLOSED";

/** Formal reviewer clarification request. A response arriving (from any
 *  channel) NEVER auto-accepts — the reviewer must accept/close it. */
export interface ClarificationRequest {
  id: string;
  milestoneId: string;
  evidenceItemId: string | null;
  question: string;
  responseType: ClarificationResponseType;
  dueAt: string | null;
  assignedToUserId: string | null;
  requestedByUserId: string;
  status: ClarificationStatus;
  responseMessageId: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Governed promotion of communication media toward evidence. A draft
 *  is NOT evidence: submission routes through the normal evidence
 *  pipeline (verification -> ledger -> governance) with honest
 *  provenance — missing GPS/metadata stays missing. */
export interface EvidenceDraft {
  id: string;
  projectId: string;
  milestoneId: string;
  sourceMessageId: string;
  sourceAttachmentIndex: number;
  mediaPath: string;
  sourceProvider: "WHATSAPP" | "TEAMS" | "OBV";
  sourceIdentity: string;
  /** Provider message timestamp (NOT an original capture timestamp). */
  sourceTimestamp: string;
  /** Only set by explicit association with a location message. */
  latitude: number | null;
  longitude: number | null;
  locationSourceMessageId: string | null;
  status: "DRAFT" | "SUBMITTED" | "DISCARDED";
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  evidenceItemId: string | null;
}

// ============================================================ pilot
// Pilot Readiness & Customer Onboarding. Configuration entities only —
// nothing here creates evidence, approvals, ledger entries, or release
// state. Launch is configuration activation, not proof of work.

/** Richer organization profile for pilot onboarding (additive; the
 *  original `kind` field stays authoritative for org type). */
export interface OrganizationProfile {
  country: string | null;
  region: string | null;
  website: string | null;
  primaryContact: string | null;
  billingContact: string | null;
  timezone: string | null;
  currency: string | null;
  language: string | null;
  pilotStart: string | null;
  pilotEnd: string | null;
  pilotReference: string | null;
  notes: string | null;
}

export type OrganizationKind =
  | "LENDER" | "FUNDER" | "GOVERNMENT_AGENCY" | "DEVELOPMENT_INSTITUTION"
  | "PROJECT_OWNER" | "IMPLEMENTING_AGENCY" | "CONTRACTOR" | "CONSULTANT"
  // legacy seeded kinds remain valid
  | "DEVELOPMENT_FINANCE" | "GOVERNMENT" | "OTHER" | string;

export type InvitationStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

/** Pilot-grade invitation. The raw token is shown once at creation and
 *  only its sha256 hash is stored; tokens are one-time and expire. */
export interface Invitation {
  id: string;
  email: string;
  organizationId: string;
  role: UserRole;
  projectId: string | null;
  tokenHash: string;
  status: InvitationStatus;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  acceptedAt: string | null;
  acceptedUserId: string | null;
  revokedAt: string | null;
}

export type PilotProjectCategory =
  | "ROAD" | "BUILDING" | "SCHOOL" | "CLINIC" | "WATER" | "ENERGY"
  | "BRIDGE" | "OTHER_INFRASTRUCTURE";

export type ProjectGeometryKind = "POINT" | "POLYGON" | "CORRIDOR";

/** Pilot configuration fields carried by a project (additive columns).
 *  Existing demo projects keep null/defaults and behave unchanged. */
export interface ProjectPilotConfig {
  code: string | null;
  category: PilotProjectCategory | null;
  country: string | null;
  region: string | null;
  locality: string | null;
  implementingOrgId: string | null;
  contractorOrgId: string | null;
  funderOrgId: string | null;
  engineerOrgId: string | null;
  obvControlledAmount: number | null;
  currency: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  timezone: string | null;
  geometryKind: ProjectGeometryKind | null;
  createdBy: string | null;
  launchedAt: string | null;
  launchedBy: string | null;
  /** Configuration version, bumped by audited post-launch changes. */
  configVersion: number;
}

export type EvidenceRequirementType =
  | "PHOTO" | "VIDEO" | "DOCUMENT" | "LOCATION_CONFIRMATION" | "FIELD_FORM"
  | "INSPECTION" | "CERTIFICATE" | "TEST_RESULT" | "OTHER";

/** Configured evidence expectation for one milestone. Drives the field
 *  checklist and readiness display; it never verifies anything itself. */
export interface EvidenceRequirement {
  id: string;
  milestoneId: string;
  sort: number;
  type: EvidenceRequirementType;
  title: string;
  description: string;
  required: boolean;
  minCount: number;
  mediaTypes: string[];
  geolocationRequired: boolean;
  recencyDays: number | null;
  notes: string | null;
}

export type GeofencePolicyLevel = "STRICT" | "STANDARD" | "EXTENDED_REVIEW";

/**
 * CUSTOMER POLICY — bounded, per-project verification parameters. Values
 * are clamped to OBV-validated bounds at read time. OBV NON-OVERRIDABLE
 * INTEGRITY RULES (missing GPS/timestamp -> review, corrupted media
 * rejected, impossible coordinates rejected, visual mismatch never
 * auto-verified) are hard-coded and cannot be configured away.
 */
export interface VerificationPolicyConfig {
  projectId: string;
  aiConfidenceThreshold: number | null;
  geofencePolicy: GeofencePolicyLevel | null;
  recencyDays: number | null;
  offlineAllowanceDays: number | null;
  updatedAt: string;
  updatedBy: string | null;
}

/** Approval matrix row: which roles (each approving once) a milestone's
 *  ApprovalRequest requires. milestone_id null = project default. */
export interface ApprovalPolicy {
  id: string;
  projectId: string;
  milestoneId: string | null;
  requiredRoles: UserRole[];
  updatedAt: string;
  updatedBy: string | null;
}

export interface FieldAssignment {
  id: string;
  projectId: string;
  userId: string;
  /** Empty array = all milestones on the project. */
  milestoneIds: string[];
  effectiveFrom: string | null;
  effectiveTo: string | null;
  active: boolean;
  createdBy: string;
  createdAt: string;
}

/** Immutable configuration snapshot captured at launch and on audited
 *  post-launch changes. Separate from the Evidence Ledger. */
export interface ConfigSnapshot {
  id: string;
  projectId: string;
  version: number;
  hash: string;
  data: string; // JSON of the full configuration
  reason: string;
  createdBy: string;
  createdAt: string;
}

/** Configuration audit trail — administrative record, NOT the Evidence
 *  Ledger. */
export interface ConfigAuditEntry {
  id: string;
  projectId: string | null;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  reason: string | null;
  beforeSummary: string | null;
  afterSummary: string | null;
  createdAt: string;
}

export interface PilotMetricTarget {
  id: string;
  projectId: string | null;
  metric: string;
  target: number;
  createdBy: string;
  createdAt: string;
}

export interface ReadinessCheck {
  key: string;
  group: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Setup stage slug the blocker links to. */
  stage: string;
  optional?: boolean;
}

// ============================================================ draws
// Construction Draw Request workflow (additive, lender-native).
//
// DOCTRINE — A DRAW REQUEST IS A REQUEST FOR REVIEW. It does not
// authorize money. A reviewer recommendation is ADVISORY. It does not
// authorize money. Only the existing formal ApprovalRequest governance
// path (matrices, separation of duties, exactly-once release through
// the VirtualAccountService) can create release eligibility. Nothing in
// this section weakens Field Capture, EvidenceItem, verification, the
// Evidence Ledger, or HELD/RELEASED milestone state.

export type DrawRequestStatus =
  | "DRAFT"                 // borrower/contractor assembling the request
  | "SUBMITTED"             // formally submitted for lender review
  | "UNDER_REVIEW"          // reviewer working line items / documents
  | "CLARIFICATION_REQUIRED"// reviewer sent it back with questions
  | "READY_FOR_GOVERNANCE"  // recommendation finalized; ApprovalRequest open
  | "PARTIALLY_APPROVED"    // governance approved less than requested
  | "APPROVED"              // governance approved the full requested amount
  | "RELEASED"              // governed release transition recorded
  | "RETURNED"              // returned to requester (rework or governance reject)
  | "CANCELLED";            // withdrawn before governance

export type DrawLineItemStatus =
  | "PENDING"               // not yet reviewed
  | "SUPPORTED"             // evidence/documents support the full amount
  | "PARTIALLY_SUPPORTED"   // a lower amount is supported (reason required)
  | "EXCEPTION"             // disputed / ahead of verified progress (reason required)
  | "REJECTED";             // not supported at all (reason required)

/** Advisory recommendation results. Deterministic — computed from real
 *  draw state only; never predictive, never able to release funds. */
export type DrawRecommendationResult =
  | "READY_FOR_GOVERNANCE"
  | "HOLD_DOCUMENTS_MISSING"
  | "HOLD_EVIDENCE_NEEDS_REVIEW"
  | "HOLD_OPEN_HIGH_SEVERITY_ISSUE"
  | "PARTIAL_SUPPORT"
  | "RETURN_FOR_CLARIFICATION";

export interface DrawRequest {
  id: string;
  /** Lender / governing organization (the project's organization). */
  organizationId: string;
  projectId: string;
  drawNumber: number;
  requestedByUserId: string | null;
  /** Borrower / implementing organization submitting the draw. */
  requestedByOrganizationId: string | null;
  submittedAt: string | null;
  requestedAmount: number;
  /** Set only by completed governance; null until then. */
  approvedAmount: number | null;
  /** Reviewer-finalized advisory amount carried into governance. */
  recommendedAmount: number | null;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: DrawRequestStatus;
  reviewRecommendation: DrawRecommendationResult | null;
  reviewSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DrawLineItem {
  id: string;
  drawRequestId: string;
  sort: number;
  /** Free-form budget line / cost-code reference (no budget ledger yet). */
  budgetLineId: string | null;
  /** Anchors the line to a governed milestone for verified-progress context. */
  milestoneId: string | null;
  description: string;
  scheduledValue: number;
  previouslyPaid: number;
  currentRequested: number;
  materialsStored: number | null;
  retainageAmount: number | null;
  /** Requester-claimed completion (0..100). */
  percentCompleteClaimed: number | null;
  /** Reviewer-recorded verified completion (0..100) — grounded in linked
   *  evidence and milestone verification state, never auto-fabricated. */
  percentCompleteVerified: number | null;
  /** Reviewer-entered supported amount for PARTIALLY_SUPPORTED lines. */
  supportedAmount: number | null;
  status: DrawLineItemStatus;
  reviewNotes: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  // ---- derived (computed at read time; never stored) ----
  totalCompletedAndStored: number;
  balanceToFinish: number;
  varianceAmount: number | null;
  variancePercent: number | null;
}

export type DrawDocumentType =
  | "CONTRACTOR_INVOICE" | "PAY_APPLICATION" | "LIEN_WAIVER"
  | "CONDITIONAL_LIEN_WAIVER" | "INSPECTION_REPORT" | "PROGRESS_PHOTOS"
  | "PERMIT" | "CERTIFICATE" | "MATERIAL_INVOICE" | "CHANGE_ORDER_SUPPORT"
  | "PROOF_OF_INSURANCE" | "OTHER";

/** Configured checklist entry: which documents this draw must carry.
 *  A document on file is an administrative record — NEVER verified
 *  physical progress (that stays with the evidence pipeline). */
export interface DrawDocumentRequirement {
  id: string;
  drawRequestId: string;
  sort: number;
  docType: DrawDocumentType;
  title: string;
  required: boolean;
  notes: string | null;
}

export type DrawDocumentStatus = "RECEIVED" | "ACCEPTED" | "REJECTED" | "EXPIRED";

/** Derived checklist state for one requirement (computed, not stored). */
export type DrawRequirementState = "REQUIRED" | "RECEIVED" | "ACCEPTED" | "MISSING" | "REJECTED" | "EXPIRED";

export interface DrawDocument {
  id: string;
  drawRequestId: string;
  requirementId: string | null;
  lineItemId: string | null;
  docType: DrawDocumentType;
  title: string;
  /** Optional stored file path (demo: metadata records are sufficient). */
  filePath: string | null;
  note: string | null;
  status: DrawDocumentStatus;
  expiresAt: string | null;
  uploadedByUserId: string | null;
  receivedAt: string;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

/** Reference from a draw (or a specific line) to an existing governed
 *  EvidenceItem. Linking NEVER re-verifies, copies or alters evidence —
 *  the item stays owned by its milestone workflow and ledger entry. */
export interface DrawEvidenceLink {
  id: string;
  drawRequestId: string;
  lineItemId: string | null;
  evidenceItemId: string;
  note: string | null;
  linkedByUserId: string;
  createdAt: string;
}

/** Draw operational timeline entry (administrative record — NOT the
 *  Evidence Ledger and NOT the virtual account event stream). */
export interface DrawEvent {
  id: string;
  drawRequestId: string;
  type:
    | "CREATED" | "UPDATED" | "SUBMITTED" | "LINE_ADDED" | "LINE_UPDATED"
    | "LINE_REVIEWED" | "DOCUMENT_RECORDED" | "DOCUMENT_REVIEWED"
    | "EVIDENCE_LINKED" | "EVIDENCE_UNLINKED" | "CLARIFICATION_REQUESTED"
    | "CLARIFICATION_RESOLVED" | "RECOMMENDATION_FINALIZED"
    | "SENT_TO_GOVERNANCE" | "GOVERNANCE_DECISION" | "RELEASE_TRANSITION"
    | "RETURNED" | "CANCELLED";
  detail: string;
  actorUserId: string | null;
  createdAt: string;
}

/** Draw-scoped virtual account event. Written ONLY by the
 *  VirtualAccountService, and only from the completed-governance path in
 *  the workflow orchestrator. UNIQUE(draw, type) in the schema enforces
 *  the exactly-once release transition at the database level. */
export interface DrawAccountEvent {
  id: string;
  drawRequestId: string;
  type: AccountStatus; // HELD or RELEASED
  amount: number;
  createdAt: string;
}

/** One reason line inside an advisory recommendation. */
export interface DrawRecommendationReason {
  /** Blocking reasons hold the draw; informational ones explain amounts. */
  kind: "BLOCKER" | "EXCEPTION" | "INFO";
  detail: string;
  amount: number | null;
  lineItemId: string | null;
}

/** Deterministic advisory recommendation. Computed from real draw state
 *  (line reviews, document checklist, linked evidence verification, open
 *  issues, clarifications). ADVISORY ONLY — carries no authority and no
 *  code path to the VirtualAccountService. */
export interface DrawRecommendation {
  drawRequestId: string;
  result: DrawRecommendationResult;
  requestedAmount: number;
  supportedAmount: number;
  exceptionAmount: number;
  retainageAmount: number;
  reasons: DrawRecommendationReason[];
  /** True when the draw may be sent to formal governance. */
  eligibleForGovernance: boolean;
  computedAt: string;
}

// ============================================================ budget
// Budget vs Verified Physical Progress (additive financial control).
//
// CORE PRINCIPLE — financial progress and physical progress are DIFFERENT
// MEASUREMENTS. OBV compares them side by side; it never merges them into
// one number, never predicts, and never claims a variance proves misuse.
// The strongest statement this module makes is: "financial progress is
// ahead of currently verified physical progress."
//
// Nothing in this section changes evidence verification, the approval
// workflow, HELD/RELEASED logic, the draw workflow, the Evidence Ledger,
// configuration snapshots, milestone configuration, launch, or reports.

/** A configured budget line (cost code) for a project. This is a
 *  financial-control record, not accounting software: OBV tracks the
 *  budget/paid figures it is given and compares them with verified
 *  physical progress. currentBudget is DERIVED (original + approved
 *  changes) — never stored, never silently edited. */
export interface BudgetLine {
  id: string;
  projectId: string;
  code: string;
  category: string;
  description: string;
  originalBudget: number;
  /** Sum of approved changes. When a Change Order module exists this must
   *  be derived from approved change records; until then it is only
   *  adjustable through the audited change-control path. */
  approvedChanges: number;
  committedAmount: number | null;
  paidToDate: number;
  retainageHeld: number | null;
  currency: string;
  sequence: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  // ---- derived (computed at read time; never stored) ----
  currentBudget: number;
}

/** Optional mapping of a budget line to milestones (physical basis) and
 *  evidence requirements. Draw line items map via their budgetLineId
 *  matching BudgetLine.code or BudgetLine.id. */
export interface BudgetLineMap {
  id: string;
  budgetLineId: string;
  milestoneId: string | null;
  evidenceRequirementId: string | null;
  createdAt: string;
}

/**
 * Explicit, reviewed partial-progress record for a milestone that is
 * measurably partial (e.g. "9.8 of 14 km base course laid"). NEVER
 * inferred from a photo: it must be entered by an authorized reviewer,
 * carry a reason, and reference a VERIFIED evidence item of the same
 * milestone. A new record supersedes the previous one (history kept).
 * It contributes only while the milestone itself is not yet fully
 * verified — a verified milestone always contributes its full weight.
 */
export interface VerifiedQuantity {
  id: string;
  milestoneId: string;
  /** 1..99 — full completion comes only from milestone verification. */
  percent: number;
  /** Human-readable measured basis, e.g. "9.8 of 14 km base laid". */
  quantityLabel: string;
  evidenceItemId: string;
  reason: string;
  enteredByUserId: string;
  superseded: boolean;
  createdAt: string;
}

/** Traceable source behind one milestone's physical-progress
 *  contribution. Every figure must be explainable — no percentage is
 *  ever shown without this basis. */
export interface ProgressBasis {
  evidenceItemId: string | null;
  verificationId: string | null;
  verdict: Verdict | null;
  confidence: number | null;
  policyVersion: number | null;
  ledgerSeq: number | null;
  quantityRecordId: string | null;
  quantityLabel: string | null;
}

export interface ProgressContribution {
  milestoneId: string;
  milestoneLabel: string;
  milestoneStatus: MilestoneStatus;
  /** Normalized weight, 0..1 (source documented in methodology). */
  weight: number;
  /** 0, quantity percent/100, or 1 — never inferred. */
  completion: number;
  /** weight × completion × 100 (percentage points contributed). */
  contributionPct: number;
  state: "VERIFIED" | "PARTIAL_MEASURED" | "NO_VERIFIED_PROGRESS";
  basis: ProgressBasis;
}

/** How milestone weights were derived for this assessment. */
export type WeightSource = "CONFIGURED_WEIGHTS" | "TRANCHE_PROPORTIONS" | "EQUAL_WEIGHTS";

/** Explainable physical-progress assessment. Deterministic: configured
 *  milestone weights × verified state (+ explicit reviewed quantities).
 *  No black-box scoring, no inference from photos. */
export interface PhysicalProgressAssessment {
  projectId: string;
  verifiedPct: number;
  weightSource: WeightSource;
  contributions: ProgressContribution[];
  dataComplete: boolean;
  methodology: string;
  computedAt: string;
}

export type VarianceState =
  | "WITHIN_RANGE"
  | "WATCH"
  | "FINANCIAL_AHEAD"
  | "PHYSICAL_AHEAD"
  | "DATA_INCOMPLETE";

export interface VarianceThresholds {
  /** |difference| ≤ withinPts → WITHIN RANGE. */
  withinPts: number;
  /** withinPts < difference ≤ watchPts → WATCH; beyond → FINANCIAL AHEAD. */
  watchPts: number;
}

/** Side-by-side financial vs verified-physical comparison for a project.
 *  All figures come from stored records (budget lines, released tranches,
 *  open draw requests, verifications). */
export interface FinancialProgress {
  projectId: string;
  /** Σ currentBudget of active budget lines, else project.totalBudget. */
  budgetBasis: number;
  budgetBasisSource: "BUDGET_LINES" | "PROJECT_TOTAL";
  originalBudget: number;
  approvedChanges: number;
  paidToDate: number;
  /** Requested on draws currently open (submitted → ready for governance). */
  openDrawRequested: number;
  retainageHeld: number;
  paidPct: number;
  claimedPct: number;
  verifiedPhysicalPct: number;
  /** claimedPct − verifiedPhysicalPct, percentage points (+ = financial ahead). */
  variancePts: number;
  varianceState: VarianceState;
  thresholds: VarianceThresholds;
  dataComplete: boolean;
  computedAt: string;
}

/** One row of the budget line register (financial vs verified per line). */
export interface BudgetLineProgressRow {
  line: BudgetLine;
  mappedMilestoneIds: string[];
  paid: number;
  openRequested: number;
  financialPct: number | null;
  verifiedPct: number | null;
  variancePts: number | null;
  varianceState: VarianceState;
  nextAction: string;
}
