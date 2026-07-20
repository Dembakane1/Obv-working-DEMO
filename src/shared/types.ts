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
  // ---- gate 1: contractor completion (additive; never verification) ----
  contractorCompletionStatus?: ContractorCompletionStatus;
  contractorReportedByUserId?: string | null;
  contractorReportedAt?: string | null;
  contractorCompletionNotes?: string | null;
  /** Evidence submissions the contractor cited with the report. */
  contractorLinkedEvidenceIds?: string[];
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
export type ApprovalSubjectType = "MILESTONE" | "DRAW" | "CHANGE_ORDER" | "RETAINAGE";

export interface ApprovalRequest {
  id: string;
  /** Set when subjectType is MILESTONE. */
  milestoneId: string | null;
  /** Set when subjectType is DRAW (additive; null on legacy rows). */
  drawRequestId?: string | null;
  /** Set when subjectType is CHANGE_ORDER / RETAINAGE respectively. */
  changeOrderId?: string | null;
  retainageReleaseId?: string | null;
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
  | "DRAW_DOCUMENT_REFERENCE"
  | "EXCEPTION_REFERENCE";

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
  /** Retainage computed at governance-finalize from the project policy
   *  (or a bounded draw override). Null until finalized / no policy. */
  retainageRate: number | null;
  retainageWithheld: number | null;
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
  /** Links the line to a change order. Billing against a change order
   *  that is not yet APPROVED requires an explicit exception
   *  acknowledgement and is surfaced for review — never silent. */
  changeOrderId?: string | null;
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
  // ---- structured metadata (all optional; shown as NOT AVAILABLE when
  // absent — never invented). Additive for the lender draw package. ----
  /** Vendor / contractor named on an invoice or waiver. */
  vendor?: string | null;
  invoiceNumber?: string | null;
  /** Invoice / covered amount in whole currency units. */
  amount?: number | null;
  /** Lien waivers: CONDITIONAL | UNCONDITIONAL. */
  waiverKind?: string | null;
  /** Lien waivers: PARTIAL | FINAL. */
  waiverScope?: string | null;
  /** Period or milestone the waiver/invoice covers. */
  coveredThrough?: string | null;
  /** Permits / certificates / inspections: issuing authority. */
  issuingAuthority?: string | null;
  /** Permit / inspection identifier. */
  referenceNumber?: string | null;
  inspectionDate?: string | null;
  inspectionResult?: string | null;
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

// ============================================================ exceptions
// Unified Exception Management (additive operational control layer).
//
// CORE PRINCIPLE — an Exception is a CONTROL RECORD that references a
// source problem. The underlying source record (verification verdict,
// field issue, clarification, approval, draw document, budget variance,
// ledger integrity state, integration binding) remains authoritative:
// exceptions never duplicate or rewrite that truth, and no exception
// action can release money or bypass governance.

export type ExceptionSourceType =
  | "EVIDENCE_VERIFICATION"
  | "DRAW_REQUEST"
  | "DRAW_LINE_ITEM"
  | "DRAW_DOCUMENT"
  | "BUDGET_VARIANCE"
  | "FIELD_ISSUE"
  | "CLARIFICATION"
  | "APPROVAL_REQUEST"
  | "LEDGER_INTEGRITY"
  | "INTEGRATION"
  | "INSPECTION"
  | "INSPECTION_REQUIREMENT"
  | "DRAW_INSPECTION"
  | "LENDER_DECISION"
  | "LIEN_WAIVER"
  | "EXTERNAL_FUNDING"
  | "LOAN_ASSET"
  | "PERMIT"
  | "OFFICIAL_SOURCE"
  | "MANUAL";

export type ExceptionCategory =
  | "EVIDENCE" | "DOCUMENT" | "LOCATION" | "METADATA" | "QUALITY"
  | "MATERIAL" | "COST" | "SCHEDULE" | "APPROVAL" | "CLARIFICATION"
  | "INTEGRITY" | "INTEGRATION" | "OTHER";

export type ExceptionSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ExceptionStatus =
  | "OPEN" | "ACKNOWLEDGED" | "IN_PROGRESS" | "AWAITING_RESPONSE"
  | "RESOLVED" | "CLOSED" | "WAIVED";

export type ExceptionResolutionType =
  | "SOURCE_CLEARED"   // the underlying condition no longer holds
  | "MANUAL"           // resolved by a user after the source allowed it
  | "WAIVED";          // formally waived (authorized role + reason + audit)

export interface ObvException {
  id: string;
  organizationId: string;
  projectId: string;
  milestoneId: string | null;
  drawRequestId: string | null;
  budgetLineId: string | null;
  sourceType: ExceptionSourceType;
  /** Id of the authoritative source record (evidence, issue, approval…). */
  sourceId: string;
  /** Deterministic idempotency key for auto-created exceptions, e.g.
   *  "evidence-rejected:<evidenceId>" — repeated rule evaluation can
   *  never create a duplicate (UNIQUE in the schema). */
  sourceKey: string;
  category: ExceptionCategory;
  severity: ExceptionSeverity;
  status: ExceptionStatus;
  title: string;
  description: string;
  ownerUserId: string | null;
  dueAt: string | null;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionSummary: string | null;
  resolutionType: ExceptionResolutionType | null;
  /** User id, or "system" for deterministic auto-created exceptions. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Exception operational timeline entry (administrative record — NOT the
 *  Evidence Ledger and never merged with it). */
export interface ExceptionEvent {
  id: string;
  exceptionId: string;
  type:
    | "CREATED" | "ACKNOWLEDGED" | "ASSIGNED" | "STATUS_CHANGED" | "COMMENT"
    | "RESPONSE_REQUESTED" | "SOURCE_UPDATED" | "RESOLVED" | "REOPENED"
    | "WAIVED" | "CLOSED";
  detail: string;
  actorUserId: string | null;
  createdAt: string;
}

/** SLA age state, derived from openedAt/dueAt — descriptive only, never a
 *  compliance claim. */
export type ExceptionSlaState = "WITHIN_TARGET" | "DUE_SOON" | "OVERDUE" | "NO_TARGET";

// ========================================================= change orders
// Change Order Management (additive construction financial governance).
//
// A submitted change order NEVER modifies budget or milestone
// configuration. Only a change order approved through the formal
// ApprovalRequest governance path is applied — transactionally, with a
// configuration audit event and a new configuration snapshot/version
// linked back to the change order. Historic evidence keeps the policy /
// configuration version it was evaluated under.

export type ChangeOrderReason =
  | "OWNER_REQUEST" | "DESIGN_CHANGE" | "SITE_CONDITION" | "MATERIAL_CHANGE"
  | "SCOPE_CHANGE" | "REGULATORY" | "SCHEDULE" | "CORRECTION" | "OTHER";

export type ChangeOrderStatus =
  | "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "CLARIFICATION_REQUIRED"
  | "APPROVED" | "PARTIALLY_APPROVED" | "REJECTED" | "CANCELLED" | "IMPLEMENTED";

export interface ChangeOrder {
  id: string;
  organizationId: string;
  projectId: string;
  changeOrderNumber: number;
  title: string;
  description: string;
  reasonCategory: ChangeOrderReason;
  requestedByUserId: string;
  requestedAt: string | null;
  requestedAmount: number;
  approvedAmount: number | null;
  currency: string;
  scheduleImpactDays: number | null;
  status: ChangeOrderStatus;
  affectedMilestoneIds: string[];
  affectedBudgetLineIds: string[];
  /** When the approved impact was applied (exactly once) and the
   *  configuration snapshot version it produced. */
  appliedAt: string | null;
  appliedSnapshotVersion: number | null;
  createdAt: string;
  updatedAt: string;
  // ---- derived ----
  supportingDocumentCount: number;
}

/** How the requested amount distributes across budget lines. Must
 *  reconcile exactly to requestedAmount before submission. On approval
 *  each allocation becomes part of the line's approvedChanges. */
export interface ChangeOrderAllocation {
  id: string;
  changeOrderId: string;
  budgetLineId: string;
  amount: number;
  note: string | null;
}

/** Supporting document metadata (administrative record). */
export interface ChangeOrderDocument {
  id: string;
  changeOrderId: string;
  title: string;
  docType: string;
  note: string | null;
  uploadedByUserId: string;
  createdAt: string;
}

/** Change-order operational timeline (NOT the Evidence Ledger). */
export interface ChangeOrderEvent {
  id: string;
  changeOrderId: string;
  type:
    | "CREATED" | "UPDATED" | "SUBMITTED" | "CLARIFICATION_REQUESTED"
    | "CLARIFICATION_RESOLVED" | "SENT_TO_GOVERNANCE" | "GOVERNANCE_DECISION"
    | "APPLIED" | "IMPLEMENTED" | "RETURNED" | "CANCELLED" | "COMMENT";
  detail: string;
  actorUserId: string | null;
  createdAt: string;
}

// ============================================================ retainage
// Retainage control (additive). Retainage is financial-control state on
// the virtual project account — not real bank movement. Withholding
// happens only inside the governed draw release transition; releasing
// retainage requires its own RetainageReleaseRequest approved through
// the formal ApprovalRequest governance path, exactly once.

/** Project retainage policy. Percent is clamped to safe bounds (0–20%).
 *  No policy configured = 0% (nothing is ever withheld silently). */
export interface RetainagePolicy {
  projectId: string;
  retainagePercent: number;
  /** Conditions every release request must satisfy (configurable). */
  requiredConditions: RetainageConditionType[];
  updatedAt: string;
  updatedBy: string | null;
}

export type RetainageConditionType =
  | "SUBSTANTIAL_COMPLETION" | "FINAL_COMPLETION" | "PUNCH_LIST_CLOSURE"
  | "FINAL_LIEN_WAIVER" | "CERTIFICATE_OF_COMPLETION" | "FINAL_INSPECTION"
  | "ALL_EXCEPTIONS_RESOLVED";

export type RetainageReleaseStatus =
  | "PENDING_CONDITIONS" | "READY_FOR_GOVERNANCE" | "APPROVED"
  | "RELEASED" | "RETURNED" | "CANCELLED";

export interface RetainageReleaseRequest {
  id: string;
  projectId: string;
  requestedByUserId: string;
  amount: number;
  status: RetainageReleaseStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One required condition on a release request. ALL_EXCEPTIONS_RESOLVED
 *  is computed live from the exception register; the others are recorded
 *  by an authorized reviewer with a note (audited). */
export interface RetainageCondition {
  id: string;
  releaseRequestId: string;
  condition: RetainageConditionType;
  satisfied: boolean;
  note: string | null;
  satisfiedByUserId: string | null;
  satisfiedAt: string | null;
}

/** Retainage financial-control events, written ONLY by the
 *  VirtualAccountService from governed transitions. WITHHELD accompanies
 *  a draw release; RELEASED accompanies a completed retainage-release
 *  approval (UNIQUE per release request — exactly once). */
export interface RetainageEvent {
  id: string;
  projectId: string;
  drawRequestId: string | null;
  retainageReleaseId: string | null;
  type: "WITHHELD" | "RELEASED";
  amount: number;
  createdAt: string;
}

/** Per-project retainage position, derived from events. */
export interface RetainageSummary {
  projectId: string;
  retainagePercent: number;
  withheldToDate: number;
  releasedToDate: number;
  remaining: number;
  pendingReleaseRequests: number;
  conditionsOutstanding: number;
}

// ============================================================ audit package

/** Lifecycle of a generated Project Audit Package. */
export type AuditPackageStatus =
  | "QUEUED"
  | "GENERATING"
  | "READY"
  | "FAILED"
  | "SUPERSEDED";

/** Explicit integrity outcome — READY never silently implies clean. */
export type AuditPackageIntegrityState = "CLEAN" | "WARNINGS" | "NOT_EVALUATED";

/**
 * One-click auditor/funder/regulator-ready project export. The package
 * REFERENCES and assembles the governed sources (configuration snapshots,
 * Evidence Ledger, verification results, approvals, draws, budget,
 * exceptions, change orders, retainage, reports) — it never rewrites them.
 * Generation and download are audited; packages are immutable once READY
 * and regeneration creates a new version (prior versions are retained as
 * SUPERSEDED, still downloadable).
 */
export interface AuditPackage {
  id: string;
  organizationId: string;
  projectId: string;
  /** Monotonic per-project version; regeneration bumps it. */
  packageVersion: number;
  requestedBy: string; // user id
  requestedAt: string;
  status: AuditPackageStatus;
  /** Consistent audit point — registers exclude records after this. */
  asOfTimestamp: string;
  configurationVersion: number;
  /** 'INTACT' or 'TAMPERED_AT:<seq>' — ledger state at generation. */
  ledgerIntegrityState: string;
  /** Overall integrity outcome across all validations. */
  integrityState: AuditPackageIntegrityState;
  /** Count of CRITICAL-severity integrity findings (ledger chain failure,
   *  snapshot hash mismatch, duplicate governed release, approval-record
   *  anomaly). 0 when findings are availability warnings only. */
  integrityCritical: number;
  /** sha256 over the canonical manifest (without this field). */
  manifestHash: string | null;
  /** Storage key of the ZIP relative to the data root. */
  storageObjectKey: string | null;
  completedAt: string | null;
  failureCategory: string | null;
  /** Options snapshot (no secrets): what the requester included. */
  includeReports: boolean;
  includeCommMetadata: boolean;
  /** Raw evidence media copies — explicit, role-restricted opt-in. */
  includeEvidenceMedia: boolean;
  fileCount: number;
  sizeBytes: number;
}

// ======================================================= completion gates

/** Gate 1 — the contractor's own representation. REPORTED_COMPLETE means
 *  only "the contractor represents that the configured milestone work is
 *  complete". It is NOT an OBV verification result, NOT an inspection
 *  result, NOT an approval and NOT a release authorization. */
export type ContractorCompletionStatus =
  | "NOT_REPORTED" | "IN_PROGRESS" | "REPORTED_COMPLETE" | "WITHDRAWN";

/** Gate 2 — DERIVED from the governed evidence pipeline (EvidenceItems +
 *  VerificationAggregator results). Never a second verification truth.
 *  VERIFIED means only "the submitted evidence satisfies the configured
 *  OBV evidence-verification policy" — not a jurisdictional inspection. */
export type EvidenceReviewStatus =
  | "NOT_SUBMITTED" | "SUBMITTED" | "UNDER_REVIEW" | "NEEDS_REVIEW"
  | "REJECTED" | "VERIFIED";

/** Gate 3 — configured / determined, never inferred. Absence of a
 *  determination is UNKNOWN; UNKNOWN never behaves as NOT_REQUIRED. */
export type InspectionRequirementValue = "UNKNOWN" | "NOT_REQUIRED" | "REQUIRED";

export interface InspectionRequirement {
  id: string;
  projectId: string;
  milestoneId: string;
  requirement: InspectionRequirementValue;
  /** Why: statute/code reference, configured template, reviewed
   *  determination — REQUIRED for NOT_REQUIRED determinations. */
  requirementBasis: string;
  determinedBy: string; // user id (attributable reviewed determination)
  determinedAt: string;
  jurisdiction: string | null;
  inspectionType: string | null;
  issuingAuthority: string | null;
  /** Gate configuration (snapshotted with project configuration). */
  mustPassBeforeDrawReview: boolean;
  mustPassBeforeGovernance: boolean;
  finalCompletionOnly: boolean;
  resultDocumentRequired: boolean;
  /** Permit / code-basis / official-source control configuration.
   *  Conservative defaults (false) preserve legacy behavior; UNKNOWN
   *  never behaves as NOT_REQUIRED anywhere in this model. */
  permitRequired: boolean;
  requiredPermitType: string | null;
  officialSourceRequired: boolean;
  codeBasisRequired: boolean;
  permitMustBeActiveBeforeDrawReview: boolean;
  permitMustBeActiveBeforeGovernance: boolean;
  configurationVersion: number;
  createdAt: string;
  updatedAt: string;
}

// ======================================================= permit register

/** First-class permit record. UNKNOWN is never treated as ACTIVE. */
export type PermitStatus =
  | "DRAFT" | "APPLIED" | "ISSUED" | "ACTIVE" | "SUSPENDED"
  | "EXPIRED" | "CLOSED" | "REVOKED" | "UNKNOWN";

export interface Permit {
  id: string;
  organizationId: string;
  projectId: string;
  permitNumber: string;
  permitType: string;
  issuingAuthority: string | null;
  jurisdiction: string | null;
  status: PermitStatus;
  issuedAt: string | null;
  effectiveAt: string | null;
  expiresAt: string | null;
  closedAt: string | null;
  scopeDescription: string | null;
  /** Structured code basis — the reviewed governing basis supplied by an
   *  authorized user or official source. OBV records it; it never
   *  independently determines legal compliance. */
  applicableCodeEdition: string | null;
  codeEffectiveDate: string | null;
  codeBasis: string | null;
  codeDeterminedBy: string | null; // user id (attributable)
  codeDeterminedAt: string | null;
  officialRecordUrl: string | null;
  officialRecordNumber: string | null;
  notes: string | null;
  /** Preserved free-text reference from legacy inspection records that
   *  could not be safely migrated. Never an invented Permit. */
  legacyReference: string | null;
  configurationVersion: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** Normalized permit ↔ milestone relationship (no comma-separated ids). */
export interface PermitMilestoneLink {
  id: string;
  permitId: string;
  milestoneId: string;
  scopeNote: string | null;
  createdByUserId: string;
  createdAt: string;
}

// ================================================ official source records

export type OfficialSourceType =
  | "OFFICIAL_PORTAL_LOOKUP" | "OFFICIAL_DOCUMENT" | "INSPECTION_REPORT"
  | "EMAIL_FROM_AUTHORITY" | "MANUAL_OFFICIAL_REFERENCE" | "API_LOOKUP" | "OTHER";

/** Provenance for official permit/inspection information. Supports a
 *  reviewed result; NEVER creates one automatically. A URL alone is a
 *  reference, not verified evidence. */
export interface OfficialSourceRecord {
  id: string;
  organizationId: string;
  projectId: string;
  milestoneId: string | null;
  permitId: string | null;
  inspectionId: string | null;
  sourceType: OfficialSourceType;
  officialSystemName: string | null;
  officialRecordNumber: string | null;
  officialRecordUrl: string | null;
  /** When the lookup was performed vs when the artifact was captured. */
  lookupPerformedAt: string | null;
  lookupPerformedByUserId: string;
  capturedAt: string | null;
  /** The official system's own status text, preserved verbatim and kept
   *  separate from OBV's normalized statuses. */
  officialStatusText: string | null;
  sourceDocumentPath: string | null;
  sourceArtifactHash: string | null;
  notes: string | null;
  createdAt: string;
}

/** Gates 4–5 — the inspection record lifecycle. An uploaded document can
 *  NEVER become PASSED automatically: a formal reviewed result recorded
 *  by an attributable internal reviewer is required. */
export type JurisdictionalInspectionStatus =
  | "REQUIRED_UNSCHEDULED" | "SCHEDULED" | "COMPLETED_PENDING_RESULT"
  | "PASSED" | "FAILED" | "CORRECTIONS_REQUIRED" | "CANCELLED" | "EXPIRED";

export interface JurisdictionalInspection {
  id: string;
  organizationId: string;
  projectId: string;
  milestoneId: string;
  /** Legacy free-text permit reference (pre-register records). Preserved
   *  as-is; the first-class relationship is permitRefId. */
  permitId: string | null;
  /** Foreign key to the first-class Permit register. */
  permitRefId: string | null;
  inspectionType: string | null;
  jurisdiction: string | null;
  issuingAuthority: string | null;
  inspectionReference: string | null;
  required: boolean;
  status: JurisdictionalInspectionStatus;
  scheduledAt: string | null;
  completedAt: string | null;
  resultRecordedAt: string | null;
  result: "PASSED" | "FAILED" | "CORRECTIONS_REQUIRED" | null;
  /** External government inspector — recorded as text, NEVER an OBV user
   *  unless they actually hold an authenticated OBV identity. */
  governmentInspectorName: string | null;
  /** Attributable internal reviewer who recorded the external result. */
  reviewedByUserId: string | null;
  supportingDocumentId: string | null;
  /** Corrections / reinspection chain. The original result is immutable:
   *  a later reinspection NEVER rewrites it. */
  reinspectionOfInspectionId: string | null;
  supersededByInspectionId: string | null;
  correctionNoticeReference: string | null;
  correctionSummary: string | null;
  correctionDueAt: string | null;
  correctionClearedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Milestone-level inspection gate, derived from the requirement + the
 *  latest active inspection record. */
export type InspectionGateState =
  | "REQUIREMENT_UNKNOWN" | "NOT_APPLICABLE" | "REQUIRED_UNSCHEDULED"
  | "SCHEDULED" | "COMPLETED_PENDING_RESULT" | "PASSED" | "FAILED" | "EXPIRED"
  | "CORRECTIONS_REQUIRED" | "AWAITING_REINSPECTION";

/** Gate 6 — DERIVED governance state. Deterministic; never a synonym for
 *  physical completion and never able to release funds itself. */
export type MilestoneDrawEligibilityResult =
  | "NOT_ELIGIBLE" | "ELIGIBLE_FOR_DRAW_REVIEW" | "READY_FOR_GOVERNANCE"
  | "BLOCKED" | "RELEASED";

export interface GateReason {
  code: string; // machine-readable, e.g. JURISDICTIONAL_INSPECTION_NOT_PASSED
  detail: string; // plain-language explanation
  blocking: boolean;
}

export interface MilestoneDrawEligibility {
  milestoneId: string;
  result: MilestoneDrawEligibilityResult;
  reasons: GateReason[];
  /** Stage-specific permit/code-basis gate results. A draw-review-only
   *  rule is never silently treated as a governance-only rule. */
  permitBlocksDrawReview: boolean;
  permitBlocksGovernance: boolean;
  codeBasisBlocksDrawReview: boolean;
  codeBasisBlocksGovernance: boolean;
  computedAt: string;
}

/** The six-gate view of one milestone. PHOTOGRAPHIC COMPLETION IS NOT
 *  LEGAL OR CONTRACTUAL COMPLETION — each dimension stays separate. */
export interface MilestoneGates {
  milestoneId: string;
  contractor: {
    status: ContractorCompletionStatus;
    reportedByUserId: string | null;
    reportedAt: string | null;
    notes: string | null;
    linkedEvidenceIds: string[];
  };
  evidenceReview: {
    status: EvidenceReviewStatus;
    evidenceCount: number;
    latestVerdict: string | null;
    policyVersion: number | null;
  };
  requirement: InspectionRequirement | null; // null = UNKNOWN (undetermined)
  requirementValue: InspectionRequirementValue;
  inspection: JurisdictionalInspection | null; // latest active record
  inspectionGate: InspectionGateState;
  eligibility: MilestoneDrawEligibility;
}

// ===================================================================
// Lender-pilot operating layer (additive; administrative records that
// never replace the governed verification/approval/release truth).
// ===================================================================


// ---------------------------------------------------------------- loan & asset

export type LoanAssetStatus =
  | "ACTIVE" | "PAID_OFF" | "DEFAULTED" | "TRANSFERRED" | "CLOSED" | "UNKNOWN";
export type LoanRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNRATED";

export interface LoanAsset {
  id: string;
  organizationId: string;
  projectId: string;
  loanNumber: string;
  propertyAddress: string | null;
  propertyType: string | null;
  borrowerOrganizationId: string | null;
  primaryContractorOrganizationId: string | null;
  lenderOrganizationId: string | null;
  originalLoanAmount: number | null;
  currentLoanAmount: number | null;
  /** External reference figures. The governed OBV budget remains
   *  authoritative for verification; differences are surfaced, never
   *  silently synchronized. */
  originalConstructionBudget: number | null;
  currentApprovedConstructionBudget: number | null;
  originalConstructionReserve: number | null;
  currentConstructionReserve: number | null;
  closingDate: string | null;
  estimatedConstructionCompletionDate: string | null;
  originalMaturityDate: string | null;
  currentMaturityDate: string | null;
  servicingSystemName: string | null;
  servicingSystemReference: string | null;
  currentServicerOrganizationId: string | null;
  currentLoanOwnerOrganizationId: string | null;
  warehouseLenderOrganizationId: string | null;
  secondaryMarketPurchaserOrganizationId: string | null;
  occupancyType: string | null;
  loanPurpose: string | null;
  riskLevel: LoanRiskLevel;
  status: LoanAssetStatus;
  inspectorAssignedUserId: string | null;
  lenderReviewerAssignedUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoanOwnershipEvent {
  id: string;
  loanAssetId: string;
  priorOwnerOrganizationId: string | null;
  newOwnerOrganizationId: string;
  effectiveAt: string;
  transferType: string | null;
  reference: string | null;
  recordedByUserId: string;
  createdAt: string;
}

export interface LoanServicingEvent {
  id: string;
  loanAssetId: string;
  priorServicerOrganizationId: string | null;
  newServicerOrganizationId: string;
  effectiveAt: string;
  reference: string | null;
  recordedByUserId: string;
  createdAt: string;
}

// ---------------------------------------------------------------- parties

export type ProjectPartyType =
  | "BORROWER" | "CONTRACTOR" | "LENDER" | "SERVICER" | "WAREHOUSE_LENDER"
  | "SECONDARY_MARKET_PURCHASER" | "TITLE_COMPANY" | "INSPECTION_COMPANY"
  | "GOVERNMENT_AUTHORITY" | "CONSULTANT" | "OTHER";

export interface ProjectPartyAssignment {
  id: string;
  organizationId: string;
  projectId: string;
  partyOrganizationId: string;
  partyType: ProjectPartyType;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  active: boolean;
  reference: string | null;
  notes: string | null;
  createdByUserId: string;
  createdAt: string;
}

// ---------------------------------------------------------------- jurisdiction

export type JurisdictionTemplateKey =
  | "DISTRICT_OF_COLUMBIA" | "MONTGOMERY_COUNTY_MD" | "PRINCE_GEORGES_COUNTY_MD"
  | "FAIRFAX_COUNTY_VA" | "ARLINGTON_COUNTY_VA" | "ALEXANDRIA_VA"
  | "LOUDOUN_COUNTY_VA" | "PRINCE_WILLIAM_COUNTY_VA" | "FALLS_CHURCH_VA" | "OTHER";

export interface JurisdictionProfile {
  id: string;
  projectId: string;
  templateKey: JurisdictionTemplateKey;
  state: string | null;
  countyOrCity: string | null;
  jurisdictionName: string | null;
  permitAuthority: string | null;
  permitSystemName: string | null;
  officialSystemUrl: string | null;
  timezone: string | null;
  jurisdictionCode: string | null;
  notes: string | null;
  configuredByUserId: string;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------- independent draw inspections

export type DrawInspectionStatus =
  | "NOT_REQUIRED" | "REQUESTED" | "SCHEDULING" | "SCHEDULED" | "ACCESS_FAILED"
  | "COMPLETED" | "REPORT_PENDING" | "REPORT_RECEIVED" | "UNDER_OBV_REVIEW"
  | "CORRECTION_REQUIRED" | "FINALIZED" | "ACCEPTED" | "FAILED"
  | "REINSPECTION_REQUIRED" | "CANCELLED";

export interface DrawInspection {
  id: string;
  organizationId: string;
  projectId: string;
  drawRequestId: string;
  inspectionType: string;
  inspectionCompanyOrganizationId: string | null;
  inspectorUserId: string | null;
  inspectorDisplayName: string | null;
  inspectorCredential: string | null;
  inspectorContact: string | null;
  requestedAt: string | null;
  requestedByUserId: string | null;
  scheduledAt: string | null;
  propertyAccessContact: string | null;
  preferredInspectionStart: string | null;
  preferredInspectionEnd: string | null;
  completedAt: string | null;
  reportReceivedAt: string | null;
  finalizedAt: string | null;
  status: DrawInspectionStatus;
  reinspectionOfInspectionId: string | null;
  borrowerResponseStatus: "NOT_REQUESTED" | "REQUESTED" | "RESPONDED" | null;
  borrowerResponseNote: string | null;
  obvReviewStatus: "PENDING" | "REVIEWED" | "CORRECTION_REQUIRED" | null;
  obvReviewedByUserId: string | null;
  lenderAcceptanceStatus: "PENDING" | "ACCEPTED" | "NOT_ACCEPTED" | null;
  lenderAcceptedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DrawInspectionLine {
  id: string;
  drawInspectionId: string;
  drawLineItemId: string | null;
  budgetLineId: string | null;
  milestoneId: string | null;
  percentCompleteReported: number | null;
  materialsPresent: boolean | null;
  materialsStoredOnSite: boolean | null;
  materialsStoredOffSite: boolean | null;
  workConsistentWithPlans: boolean | null;
  workmanshipObservation: string | null;
  visibleDefects: string | null;
  safetyConcerns: string | null;
  inaccessibleAreas: string | null;
  inspectorNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export type InspectionReportVersionStatus = "DRAFT" | "FINALIZED" | "SUPERSEDED";

export interface DrawInspectionReportVersion {
  id: string;
  drawInspectionId: string;
  version: number;
  status: InspectionReportVersionStatus;
  reportDate: string | null;
  summary: string | null;
  conclusion: string | null;
  preparedByUserId: string;
  finalizedByUserId: string | null;
  createdAt: string;
  finalizedAt: string | null;
  priorVersionId: string | null;
  correctionReason: string | null;
  documentPath: string | null;
  documentHash: string | null;
}

export interface DrawInspectionEvent {
  id: string;
  drawInspectionId: string;
  type: string;
  detail: string;
  actorUserId: string | null;
  createdAt: string;
}

// ------------------------------------------------------- lender decision

export type LenderDecisionType =
  | "PENDING" | "APPROVED" | "CONDITIONALLY_APPROVED" | "REDUCED"
  | "REJECTED" | "WITHDRAWN" | "FUNDED";

export interface LenderDrawDecision {
  id: string;
  organizationId: string;
  projectId: string;
  drawRequestId: string;
  requestedAmount: number;
  verifiedAmount: number | null;
  recommendedAmount: number | null;
  approvedAmount: number | null;
  reducedAmount: number | null;
  rejectedAmount: number | null;
  decision: LenderDecisionType;
  reviewerUserId: string;
  decisionAt: string | null;
  decisionReason: string | null;
  holdbackAmount: number | null;
  retainageAmount: number | null;
  exceptionsAccepted: string | null;
  governmentInspectionRequirement: string | null;
  lienReleaseRequirement: string | null;
  fundingInstructions: string | null;
  notes: string | null;
  approvalRequestId: string | null;
  supersedesDecisionId: string | null;
  supersededByDecisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LenderConditionStatus =
  | "OPEN" | "IN_PROGRESS" | "SATISFIED" | "WAIVED" | "FAILED" | "CANCELLED";

export interface LenderDecisionCondition {
  id: string;
  lenderDecisionId: string;
  conditionType: string;
  description: string;
  responsiblePartyOrganizationId: string | null;
  dueAt: string | null;
  status: LenderConditionStatus;
  supportingDocumentId: string | null;
  satisfiedByUserId: string | null;
  satisfiedAt: string | null;
  waiverReason: string | null;
  waivedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------- lien waivers

export type LienWaiverStatus =
  | "NOT_REQUIRED" | "REQUIRED" | "REQUESTED" | "RECEIVED" | "UNDER_REVIEW"
  | "ACCEPTED" | "REJECTED" | "EXPIRED" | "SUPERSEDED";

export interface LienWaiverRecord {
  id: string;
  organizationId: string;
  projectId: string;
  drawRequestId: string;
  drawLineItemId: string | null;
  drawDocumentId: string | null;
  contractorOrSupplierOrganizationId: string | null;
  signingParty: string | null;
  waiverType: string | null;
  waiverScope: string | null;
  relatedAmount: number | null;
  coveredThrough: string | null;
  requestedAt: string | null;
  receivedAt: string | null;
  reviewedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  signatureDate: string | null;
  status: LienWaiverStatus;
  reviewedByUserId: string | null;
  rejectionReason: string | null;
  documentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------ external funding

export type ExternalFundingStatus =
  | "NOT_SCHEDULED" | "SCHEDULED" | "PROCESSING" | "DISBURSED" | "FAILED"
  | "REVERSED" | "CANCELLED" | "CLOSED";

export interface ExternalFundingRecord {
  id: string;
  organizationId: string;
  projectId: string;
  drawRequestId: string;
  lenderDecisionId: string | null;
  fundingMethod: string | null;
  scheduledAt: string | null;
  fundedAt: string | null;
  amountScheduled: number | null;
  amountDisbursed: number | null;
  wireFee: number | null;
  transactionReference: string | null;
  confirmationDocumentId: string | null;
  status: ExternalFundingStatus;
  failureReason: string | null;
  reversalReference: string | null;
  reversedAt: string | null;
  closedAt: string | null;
  recordedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

// -------------------------------------------------- membership & capability

export type ProjectParticipantType =
  | "BORROWER" | "CONTRACTOR" | "INSPECTOR" | "OBV_REVIEWER"
  | "LENDER_REVIEWER" | "ADMINISTRATOR";

export type ProjectCapability =
  | "SUBMIT_DRAW" | "UPLOAD_DRAW_DOCUMENT" | "REPORT_CONTRACTOR_COMPLETION"
  | "SCHEDULE_DRAW_INSPECTION" | "RECORD_INSPECTION_FINDINGS"
  | "FINALIZE_INSPECTION_REPORT" | "REVIEW_EVIDENCE" | "REVIEW_DRAW"
  | "RECORD_LENDER_DECISION" | "ACCEPT_EXCEPTION" | "MANAGE_PROJECT_CONFIGURATION"
  | "MANAGE_USERS" | "RECORD_EXTERNAL_FUNDING";

export interface ProjectMembership {
  id: string;
  projectId: string;
  userId: string;
  participantType: ProjectParticipantType;
  capabilitySet: ProjectCapability[];
  effectiveFrom: string | null;
  effectiveTo: string | null;
  active: boolean;
  assignedByUserId: string;
  createdAt: string;
}

// -------------------------------------------------------- lender policy

export interface LenderDrawPolicy {
  id: string;
  organizationId: string;
  projectId: string | null;
  version: number;
  requiredDocumentTypes: string[];
  requiredEvidence: string | null;
  independentInspectionRequired: boolean;
  governmentInspectionRequired: boolean;
  maxDrawFrequencyDays: number | null;
  minDrawAmount: number | null;
  retainagePct: number | null;
  storedMaterialRule: string | null;
  offsiteMaterialRule: string | null;
  changeOrderRule: string | null;
  budgetTransferRule: string | null;
  lienWaiverRule: string | null;
  approvalLimit: number | null;
  reviewerHierarchy: string | null;
  exceptionSeverityMap: string | null;
  mandatoryFundingConditions: string[];
  turnaroundTargetDays: number | null;
  borrowerCertification: string | null;
  contractorCertification: string | null;
  active: boolean;
  configuredByUserId: string;
  reason: string | null;
  createdAt: string;
}

// ----------------------------------------------------- derived workflow stage

export type DrawWorkflowStage =
  | "DRAW_REQUEST_SUBMITTED" | "INITIAL_COMPLETENESS_REVIEW"
  | "MISSING_INFORMATION_REQUESTED" | "INSPECTION_REQUESTED"
  | "INSPECTION_SCHEDULED" | "PHYSICAL_INSPECTION_COMPLETED"
  | "EVIDENCE_REVIEW_COMPLETED" | "GOVERNMENT_INSPECTION_CHECKED"
  | "FINANCIAL_DOCUMENTS_REVIEWED" | "EXCEPTIONS_IDENTIFIED"
  | "CORRECTIONS_REQUESTED" | "ELIGIBLE_FOR_LENDER_REVIEW"
  | "LENDER_REVIEW_IN_PROGRESS" | "APPROVED" | "CONDITIONALLY_APPROVED"
  | "REDUCED" | "REJECTED" | "LIEN_RELEASE_REQUESTED" | "LIEN_RELEASE_COMPLETED"
  | "FUNDS_SCHEDULED" | "FUNDS_DISBURSED" | "DRAW_CLOSED";

export interface DrawStageEvent {
  id: string;
  drawRequestId: string;
  priorStage: DrawWorkflowStage | null;
  newStage: DrawWorkflowStage;
  actorUserId: string | null;
  reason: string | null;
  sourceRecordId: string | null;
  createdAt: string;
}
