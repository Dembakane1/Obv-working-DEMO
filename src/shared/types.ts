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

export type ProjectStatus = "ACTIVE" | "COMPLETED" | "SUSPENDED";

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
}

export interface ApprovalRequest {
  id: string;
  milestoneId: string;
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

export type ThreadScope = "ORGANIZATION" | "PROJECT" | "MILESTONE" | "EVIDENCE" | "APPROVAL";

/** OBV is the real internal provider; TEAMS/WHATSAPP are architecture-
 *  ready seams for future sync (see docs/COMMUNICATIONS_INTEGRATION.md). */
export type MessageProvider = "OBV" | "TEAMS" | "WHATSAPP";

export type ChatMessageType =
  | "TEXT"
  | "SYSTEM_EVENT"
  | "EVIDENCE_REFERENCE"
  | "MILESTONE_REFERENCE"
  | "APPROVAL_REFERENCE"
  | "REPORT_REFERENCE";

export interface ConversationThread {
  id: string;
  organizationId: string;
  projectId: string | null;
  milestoneId: string | null;
  evidenceItemId: string | null;
  approvalRequestId: string | null;
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
  deliveryStatus: "SENT" | "PENDING" | "FAILED";
  /** Loop-prevention origin (see MessageOrigin below). */
  origin: MessageOrigin;
  /** External edit audit: original body is preserved on first edit. */
  editedAt: string | null;
  originalBody: string | null;
  /** Deleted in the external provider (content kept for audit). */
  externalDeleted: boolean;
  /** Communication attachments — never auto-promoted to evidence. */
  attachments: MessageAttachment[];
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
export type MessageOrigin = "OBV_LOCAL" | "TEAMS_INBOUND";

/** Communication attachment metadata (a chat artifact — NEVER evidence;
 *  evidence enters only through the governed submission workflow). */
export interface MessageAttachment {
  name: string;
  url: string | null;
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
  provider: "TEAMS";
  tenantId: string;
  externalUserId: string;
  obvUserId: string | null;
  externalDisplayName: string;
  externalEmail: string | null;
  status: "MAPPED" | "UNMAPPED";
  createdAt: string;
  updatedAt: string;
}
