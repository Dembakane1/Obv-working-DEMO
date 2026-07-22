/**
 * Seed script — one realistic infrastructure project in a state that makes
 * the hero loop demoable out of the box:
 *
 *   M1, M2  verified + approved + RELEASED (with evidence, verification and
 *           hash-chained ledger history)
 *   M3      PENDING_EVIDENCE  <- the hero-loop milestone
 *   M4, M5  NOT_STARTED
 *
 * Run: npm run seed   (drops and recreates data/obv.db)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AUDIT_PACKAGES_DIR, getDb, resetDb } from "./index";
import * as repo from "./repo";
import * as lrepo from "./lenderRepo";
import * as brepo from "./bankingRepo";
import { COMM_MEDIA_DIR } from "../services/whatsappSync/provider";
import { runVerificationPipeline } from "../services/verification/index";
import { wormEvidenceStore, sha256 } from "../services/WormEvidenceStore";
import { virtualAccountService } from "../services/VirtualAccountService";
import { evaluateExceptions } from "../services/exceptions";
import type {
  ApprovalRequest,
  ChatMessage,
  EvidenceItem,
  GeoPolygon,
  Milestone,
  Project,
  Verification,
} from "../../shared/types";

/**
 * Reset and reseed the demo data. Also used by POST /api/demo/reset.
 *
 * Two modes:
 *  - FULL (default): drops the entire database + storage and reseeds.
 *    Used by `npm run seed` and the gated Development Full Reset.
 *  - preservePilot: when user-created pilot projects exist, only the
 *    DEMO-SCOPED rows are removed and reseeded; pilot organizations,
 *    users, invitations, projects, and configuration are untouched.
 *    The Evidence Ledger is append-only and is NEVER deleted in this
 *    mode: the original seeded entries still describe the re-created
 *    (identical, fixed-id) demo evidence, and entries from mid-demo
 *    submissions remain as honest historical records whose evidence was
 *    removed by the demo reset.
 */
export async function seedDemo(opts: { preservePilot?: boolean } = {}): Promise<void> {
  const scoped =
    Boolean(opts.preservePilot) &&
    (() => {
      try {
        return repo.listProjects().some((p) => p.id !== "proj-r47");
      } catch {
        return false; // fresh/empty database — full path
      }
    })();
  if (!scoped) {
    resetDb();
  } else {
    purgeDemoScopedRows();
  }

  // ---- organizations ----
  repo.insertOrganization({
    id: "org-cdfc",
    name: "Continental Development Finance Corporation",
    kind: "DEVELOPMENT_FINANCE",
  });
  repo.insertOrganization({
    id: "org-crra",
    name: "Central Region Roads Authority",
    kind: "GOVERNMENT",
  });

  // ---- users (one per role) ----
  repo.insertUser({
    id: "user-field",
    organizationId: "org-crra",
    name: "Chikondi Banda",
    role: "FIELD",
    title: "Field Engineer",
  });
  repo.insertUser({
    id: "user-funder",
    organizationId: "org-cdfc",
    name: "Margaret Osei",
    role: "FUNDER_REP",
    title: "Funder Representative",
  });
  repo.insertUser({
    id: "user-pm",
    organizationId: "org-crra",
    name: "Daniel Phiri",
    role: "PROJECT_MANAGER",
    title: "Project Manager",
  });
  repo.insertUser({
    id: "user-compliance",
    organizationId: "org-cdfc",
    name: "Amina Ndlovu",
    role: "COMPLIANCE_REVIEWER",
    title: "Compliance Reviewer",
  });

  // ---- project ----
  // Geofence: ring around the 14 km R47 road corridor, Mzimba District.
  const project: Project = {
    id: "proj-r47",
    organizationId: "org-cdfc",
    name: "Mzimba–Kafukule Rural Road Rehabilitation (R47)",
    description:
      "Rehabilitation of 14 km of rural access road between Mzimba Boma and " +
      "Kafukule trading centre: clearing, earthworks, drainage structures, " +
      "gravel base course, one river crossing and final surfacing. Financed " +
      "against five verified physical milestones.",
    location: "Mzimba District, Northern Region, Malawi",
    siteBoundary: [
      [33.5500, -11.9300],
      [33.6600, -11.9300],
      [33.6600, -11.7800],
      [33.5500, -11.7800],
      [33.5500, -11.9300],
    ],
    totalBudget: 2_400_000,
    status: "ACTIVE",
    projectType: "INFRASTRUCTURE",
  };
  repo.insertProject(project);

  // ---- milestones ----
  const milestones: Milestone[] = [
    {
      id: "ms-1",
      projectId: project.id,
      seq: 1,
      title: "Site mobilization & vegetation clearing",
      requirement:
        "Photo showing cleared 20 m right-of-way with contractor camp and " +
        "equipment on site at km 0–2 of the R47 alignment.",
      trancheAmount: 240_000,
      weight: 10,
      status: "RELEASED",
      accountStatus: "HELD", // corrected by releaseTranche() below
    },
    {
      id: "ms-2",
      projectId: project.id,
      seq: 2,
      title: "Earthworks, grading & drainage culverts",
      requirement:
        "Photo showing completed box culvert installation with headwalls and " +
        "compacted backfill at the km 6+850 stream crossing.",
      trancheAmount: 480_000,
      weight: 20,
      status: "RELEASED",
      accountStatus: "HELD",
    },
    {
      id: "ms-3",
      projectId: project.id,
      seq: 3,
      title: "Gravel base course, km 0–14",
      requirement:
        "Photo showing laid and compacted 150 mm gravel base course across " +
        "the full carriageway width, with grading equipment or a km marker " +
        "visible for location context.",
      trancheAmount: 600_000,
      weight: 25,
      status: "PENDING_EVIDENCE",
      accountStatus: "HELD",
    },
    {
      id: "ms-4",
      projectId: project.id,
      seq: 4,
      title: "River crossing bridge deck & approaches",
      requirement:
        "Photo showing cast bridge deck with guard rails and finished gravel " +
        "approaches on both banks at the Kasitu river crossing.",
      trancheAmount: 560_000,
      weight: 23,
      status: "NOT_STARTED",
      accountStatus: "HELD",
    },
    {
      id: "ms-5",
      projectId: project.id,
      seq: 5,
      title: "Final surfacing, signage & handover",
      requirement:
        "Photo showing finished running surface with road signs and edge " +
        "markers installed, taken at the Kafukule end point (km 14).",
      trancheAmount: 520_000,
      weight: 22,
      status: "NOT_STARTED",
      accountStatus: "HELD",
    },
  ];
  milestones.forEach(repo.insertMilestone);

  // ---- virtual account: all tranches held at financial close ----
  for (const m of milestones) {
    await virtualAccountService.holdTranche(m, "2026-02-02T09:00:00.000Z");
  }

  // ---- history for M1 and M2: evidence -> verification -> ledger ->
  //      approval (approved) -> release ----
  const history: Array<{
    milestone: Milestone;
    photo: string;
    lat: number;
    lng: number;
    capturedAt: string;
    uploadedAt: string;
    approvedAt: string;
    releasedAt: string;
  }> = [
    {
      milestone: milestones[0],
      photo: "/demo-evidence/m1-clearing.jpg",
      lat: -11.9021,
      lng: 33.5714,
      capturedAt: "2026-03-11T08:42:00.000Z",
      uploadedAt: "2026-03-11T10:05:00.000Z",
      approvedAt: "2026-03-13T14:20:00.000Z",
      releasedAt: "2026-03-14T09:00:00.000Z",
    },
    {
      milestone: milestones[1],
      photo: "/demo-evidence/m2-drainage.jpg",
      lat: -11.8544,
      lng: 33.6012,
      capturedAt: "2026-05-19T13:16:00.000Z",
      uploadedAt: "2026-05-19T13:40:00.000Z",
      approvedAt: "2026-05-21T11:05:00.000Z",
      releasedAt: "2026-05-22T09:00:00.000Z",
    },
  ];

  for (const h of history) {
    const evidence: EvidenceItem = {
      id: `ev-${h.milestone.id}`,
      milestoneId: h.milestone.id,
      userId: "user-field",
      photoPath: h.photo,
      latitude: h.lat,
      longitude: h.lng,
      capturedAt: h.capturedAt,
      uploadedAt: h.uploadedAt,
      deviceMetadata: {
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7a) Chrome/126 Mobile",
        platform: "Android",
        screen: "412x915",
        language: "en-GB",
      },
      hash: sha256(
        JSON.stringify({
          photoHash: sha256(`demo-fallback:${h.photo}`),
          latitude: h.lat,
          longitude: h.lng,
          capturedAt: h.capturedAt,
          uploadedAt: h.uploadedAt,
        })
      ),
      previousHash: null,
      isDemoFallback: false,
    };
    repo.insertEvidence(evidence);

    const project_ = repo.getProject(project.id)!;
    // Seeded history always uses the deterministic mock path (never live).
    const result = await runVerificationPipeline({
      milestone: h.milestone,
      project: project_,
      photoPath: evidence.photoPath,
      latitude: evidence.latitude,
      longitude: evidence.longitude,
      capturedAt: evidence.capturedAt,
      uploadedAt: evidence.uploadedAt,
      deviceMetadata: evidence.deviceMetadata,
      seedHash: evidence.hash,
      isDemoFallback: false,
      forceMock: true,
    });
    if (result.verdict !== "VERIFIED") {
      throw new Error(
        `Seed integrity error: milestone ${h.milestone.seq} evidence did not verify (${result.verdict})`
      );
    }
    const verification: Verification = {
      id: `vf-${h.milestone.id}`,
      evidenceItemId: evidence.id,
      verdict: result.verdict,
      confidence: result.confidence,
      checks: result.checks,
      reasoning: result.reasoning,
      createdAt: h.uploadedAt,
      source: "MOCK_DEFAULT",
    };
    repo.insertVerification(verification);

    // Append-only ledger: in preservePilot mode the original seeded
    // entry for this fixed-id evidence still exists and stays valid —
    // never append a duplicate, never delete.
    if (!repo.getLedgerEntryForEvidence(evidence.id)) {
      await wormEvidenceStore.appendLedgerEntry({
        evidenceItemId: evidence.id,
        milestoneId: h.milestone.id,
        verificationId: verification.id,
        payloadHash: sha256(
          JSON.stringify({
            evidenceHash: evidence.hash,
            verdict: verification.verdict,
            confidence: verification.confidence,
          })
        ),
        timestamp: h.uploadedAt,
      });
    }

    const approval: ApprovalRequest = {
      id: `ap-${h.milestone.id}`,
      milestoneId: h.milestone.id,
      status: "APPROVED",
      requiredRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"],
      createdAt: h.uploadedAt,
    };
    repo.insertApprovalRequest(approval);
    repo.insertApprovalRecord({
      id: `apr-${h.milestone.id}-funder`,
      approvalRequestId: approval.id,
      userId: "user-funder",
      role: "FUNDER_REP",
      decision: "APPROVED",
      createdAt: h.approvedAt,
    });
    repo.insertApprovalRecord({
      id: `apr-${h.milestone.id}-compliance`,
      approvalRequestId: approval.id,
      userId: "user-compliance",
      role: "COMPLIANCE_REVIEWER",
      decision: "APPROVED",
      createdAt: h.approvedAt,
    });

    await virtualAccountService.releaseTranche(h.milestone, h.releasedAt);
    repo.updateMilestoneStatus(h.milestone.id, "RELEASED");

    repo.insertNotification({
      id: repo.newId(),
      type: "TRANCHE_RELEASED",
      message: `Tranche of $${h.milestone.trancheAmount.toLocaleString("en-US")} released for milestone ${h.milestone.seq} "${h.milestone.title}" after funder and compliance approval.`,
      createdAt: h.releasedAt,
      projectId: project.id,
      milestoneId: h.milestone.id,
      deliveryMode: "MOCK",
      deliveryStatus: "SKIPPED",
    });
  }

  // ---- demo fallback photos for the pending milestone (M3) ----
  repo.insertDemoFallbackPhoto({
    id: "demo-m3-a",
    milestoneId: "ms-3",
    path: "/demo-evidence/m3-gravel-a.jpg",
    label: "Gravel base laid and graded (km 3+400)",
  });
  repo.insertDemoFallbackPhoto({
    id: "demo-m3-b",
    milestoneId: "ms-3",
    path: "/demo-evidence/m3-gravel-b.jpg",
    label: "Grader compacting base layer (km 9+100)",
  });
  repo.insertDemoFallbackPhoto({
    id: "demo-m3-c",
    milestoneId: "ms-3",
    path: "/demo-evidence/m3-gravel-c.jpg",
    label: "Surfaced section with km marker (km 12+000)",
  });

  // ---- spatial demo geometry (presentation only) ----
  // DEMONSTRATION corridor centerline for the seeded R47 project — not
  // real-world engineering geometry. It stays inside the registered site
  // boundary and passes near the seeded evidence coordinates so the map
  // reads coherently. Segment km labels are explicit demo metadata.
  const route: GeoPolygon = [
    [33.5560, -11.9120], // Mzimba Boma end (km 0)
    [33.5714, -11.9021], // near M1 evidence capture
    [33.5860, -11.8890],
    [33.5960, -11.8710],
    [33.6012, -11.8544], // near M2 culvert evidence capture
    [33.6050, -11.8400],
    [33.6180, -11.8210],
    [33.6350, -11.8050],
    [33.6520, -11.7880], // Kafukule trading centre end (km 14)
  ];
  repo.insertSpatialFeature({
    id: "geo-route",
    projectId: project.id,
    milestoneId: null,
    kind: "ROUTE",
    label: "R47 corridor centerline (demo geometry)",
    geometry: route,
  });
  // Sequential corridor segments, one per milestone. Slices share their
  // boundary vertex so segments join seamlessly.
  const segments: Array<{ milestoneId: string; label: string; slice: [number, number] }> = [
    { milestoneId: "ms-1", label: "km 0–2", slice: [0, 2] },
    { milestoneId: "ms-2", label: "km 2–7", slice: [1, 5] },
    { milestoneId: "ms-3", label: "km 7–11", slice: [4, 7] },
    { milestoneId: "ms-4", label: "km 11–12.5", slice: [6, 8] },
    { milestoneId: "ms-5", label: "km 12.5–14", slice: [7, 9] },
  ];
  for (const s of segments) {
    repo.insertSpatialFeature({
      id: `geo-${s.milestoneId}`,
      projectId: project.id,
      milestoneId: s.milestoneId,
      kind: "SEGMENT",
      label: s.label,
      geometry: route.slice(s.slice[0], s.slice[1] + 1),
    });
  }

  // ---- seeded communications (chat coordinates; it never authorizes) ----
  // Two default threads with realistic history consistent with the seeded
  // state: M1/M2 released, M3 awaiting evidence. No message claims an
  // approval or upload that the governance/evidence records don't show.
  repo.insertThread({
    id: "thread-project",
    organizationId: "org-cdfc",
    projectId: project.id,
    milestoneId: null,
    evidenceItemId: null,
    approvalRequestId: null,
    title: "Project General",
    scope: "PROJECT",
    createdAt: "2026-02-03T08:00:00.000Z",
    createdBy: "user-pm",
  });
  repo.insertThread({
    id: "thread-m3",
    organizationId: "org-cdfc",
    projectId: project.id,
    milestoneId: "ms-3",
    evidenceItemId: null,
    approvalRequestId: null,
    title: "M3 · Gravel Base Course Review",
    scope: "MILESTONE",
    createdAt: "2026-06-28T07:30:00.000Z",
    createdBy: "user-pm",
  });
  const msg = (
    m: Pick<ChatMessage, "id" | "threadId" | "body" | "createdAt"> & Partial<ChatMessage>
  ): void =>
    repo.insertChatMessage({
      senderUserId: null,
      senderDisplayName: "OBV",
      provider: "OBV",
      externalThreadId: null,
      externalMessageId: null,
      messageType: "SYSTEM_EVENT",
      refId: null,
      deliveryStatus: "SENT",
      origin: "OBV_LOCAL",
      editedAt: null,
      originalBody: null,
      externalDeleted: false,
      attachments: [],
      location: null,
      ...m,
    });
  // Project General: history mirroring the real M1/M2 record.
  msg({
    id: "pmsg-1", threadId: "thread-project",
    senderUserId: "user-pm", senderDisplayName: "Daniel Phiri", messageType: "TEXT",
    body: "Welcome to the R47 project workspace. Coordination happens here; evidence and approvals stay in their formal OBV workflows.",
    createdAt: "2026-02-03T08:05:00.000Z",
  });
  msg({
    id: "pmsg-2", threadId: "thread-project",
    body: "Verification completed: VERIFIED — M1 site mobilization & vegetation clearing.",
    refId: "ev-ms-1", messageType: "EVIDENCE_REFERENCE",
    createdAt: "2026-03-11T10:06:00.000Z",
  });
  msg({
    id: "pmsg-3", threadId: "thread-project",
    body: "All approvals complete for M1. Tranche of $240,000 RELEASED on the virtual project account.",
    refId: "ap-ms-1", messageType: "APPROVAL_REFERENCE",
    createdAt: "2026-03-14T09:00:00.000Z",
  });
  msg({
    id: "pmsg-4", threadId: "thread-project",
    body: "All approvals complete for M2. Tranche of $480,000 RELEASED on the virtual project account.",
    refId: "ap-ms-2", messageType: "APPROVAL_REFERENCE",
    createdAt: "2026-05-22T09:00:00.000Z",
  });
  msg({
    id: "pmsg-5", threadId: "thread-project",
    senderUserId: "user-funder", senderDisplayName: "Margaret Osei", messageType: "TEXT",
    body: "Thanks all — disbursement register is up to date through M2. M3 gravel base is the next verification gate.",
    createdAt: "2026-05-22T10:12:00.000Z",
  });
  // M3 review thread: coordination consistent with PENDING_EVIDENCE
  // (nobody claims evidence or approvals that don't exist).
  msg({
    id: "m3msg-1", threadId: "thread-m3",
    senderUserId: "user-field", senderDisplayName: "Chikondi Banda", messageType: "TEXT",
    body: "Gravel base compaction is complete from km 9–14. I will capture and submit evidence through OBV field capture from the site so GPS and metadata are attached.",
    createdAt: "2026-06-28T07:42:00.000Z",
  });
  msg({
    id: "m3msg-2", threadId: "thread-m3",
    senderUserId: "user-pm", senderDisplayName: "Daniel Phiri", messageType: "TEXT",
    body: "Received. Submit against the M3 requirement (full carriageway width, km marker or grading equipment visible) and it will route to verification automatically.",
    createdAt: "2026-06-28T08:15:00.000Z",
  });
  msg({
    id: "m3msg-3", threadId: "thread-m3",
    senderUserId: "user-compliance", senderDisplayName: "Amina Ndlovu", messageType: "TEXT",
    body: "Please confirm the compaction test certificate is attached to the project file before final sign-off. Reminder: release still requires the formal two-role approval in OBV — nothing in this thread authorizes funds.",
    createdAt: "2026-06-28T09:03:00.000Z",
  });

  // ---- seeded WhatsApp field scenario (coordination only; nothing here ----
  // touches evidence, verification, approvals or money). Chikondi's WhatsApp
  // identity is mapped and her context is explicitly bound to the M3 thread,
  // so the inbound coordination messages below land in the right place.
  // The gravel-shortfall report becomes a Field Issue — an OPERATIONAL
  // record. M3 remains PENDING_EVIDENCE; no financial state changes.
  const waPhone = "265991114821"; // demo wa_id (digits, no plus) — not a real subscriber
  repo.upsertIdentityMapping({
    id: "waid-field",
    provider: "WHATSAPP",
    tenantId: "whatsapp",
    organizationId: "org-cdfc",
    externalUserId: waPhone,
    obvUserId: "user-field",
    externalDisplayName: "Chikondi Banda",
    externalEmail: null,
    status: "MAPPED",
    createdAt: "2026-07-01T08:00:00.000Z",
    updatedAt: "2026-07-01T08:00:00.000Z",
  });
  repo.upsertParticipantContext({
    id: "wactx-field",
    provider: "WHATSAPP",
    externalUserId: waPhone,
    activeProjectId: project.id,
    activeThreadId: "thread-m3",
    activeMilestoneId: "ms-3",
    lastInboundAt: "2026-07-06T09:14:00.000Z",
    expiresAt: null,
    updatedAt: "2026-07-01T08:05:00.000Z",
  });
  // Communication media lives in data/comm-media (mutable, retention-managed)
  // — never in the WORM evidence store.
  fs.mkdirSync(COMM_MEDIA_DIR, { recursive: true });
  // Simulated stockpile photo (carries a burned-in "SIMULATED DEMO
  // EVIDENCE" watermark) — copied from the bundled demo assets.
  fs.copyFileSync(
    path.join(process.cwd(), "public", "demo-evidence", "comm-stockpile.jpg"),
    path.join(COMM_MEDIA_DIR, "seed-wa-stockpile.jpg"),
  );
  msg({
    id: "wamsg-1", threadId: "thread-m3",
    senderUserId: "user-field", senderDisplayName: "Chikondi Banda",
    provider: "WHATSAPP", origin: "WHATSAPP_INBOUND",
    externalMessageId: "wamid.SEED.DEMO.001", messageType: "TEXT",
    body: "Gravel deliveries to the km 12 stockpile stopped this morning — the supplier truck broke down near Ekwendeni. We are roughly 40 m³ short for tomorrow's lift on the last section.",
    createdAt: "2026-07-06T09:12:00.000Z",
  });
  msg({
    id: "wamsg-2", threadId: "thread-m3",
    senderUserId: "user-field", senderDisplayName: "Chikondi Banda",
    provider: "WHATSAPP", origin: "WHATSAPP_INBOUND",
    externalMessageId: "wamid.SEED.DEMO.002", messageType: "TEXT",
    body: "Photo of the stockpile as of this morning.",
    attachments: [{
      kind: "IMAGE", name: "km12-stockpile.jpg",
      url: "/comm-media/seed-wa-stockpile.jpg", mimeType: "image/jpeg",
    }],
    createdAt: "2026-07-06T09:13:00.000Z",
  });
  msg({
    id: "wamsg-3", threadId: "thread-m3",
    senderUserId: "user-field", senderDisplayName: "Chikondi Banda",
    provider: "WHATSAPP", origin: "WHATSAPP_INBOUND",
    externalMessageId: "wamid.SEED.DEMO.003", messageType: "TEXT",
    body: "Shared location: stockpile position on the alignment.",
    location: { latitude: -11.8062, longitude: 33.6329 },
    createdAt: "2026-07-06T09:14:00.000Z",
  });
  repo.insertFieldIssue({
    id: "issue-1",
    organizationId: "org-cdfc",
    projectId: project.id,
    milestoneId: "ms-3",
    evidenceItemId: null,
    sourceThreadId: "thread-m3",
    sourceMessageId: "wamsg-1",
    title: "Gravel shortfall at km 12 stockpile",
    description:
      "Supplier truck breakdown near Ekwendeni interrupted gravel deliveries; " +
      "approx. 40 m³ short for the next base-course lift on the final section. " +
      "Reported from the field via WhatsApp.",
    category: "MATERIAL",
    severity: "HIGH",
    status: "ACKNOWLEDGED",
    reportedByUserId: "user-field",
    reportedByExternalIdentityId: "waid-field",
    assignedToUserId: "user-pm",
    latitude: -11.8062,
    longitude: 33.6329,
    dueAt: "2026-07-10T00:00:00.000Z",
    resolvedAt: null,
    resolutionSummary: null,
    createdAt: "2026-07-06T09:30:00.000Z",
    updatedAt: "2026-07-06T10:05:00.000Z",
  });
  repo.insertIssueEvent({
    id: "issev-1", issueId: "issue-1", type: "CREATED",
    detail: "Field issue created from WhatsApp coordination message by Daniel Phiri.",
    actorUserId: "user-pm", createdAt: "2026-07-06T09:30:00.000Z",
  });
  repo.insertIssueEvent({
    id: "issev-2", issueId: "issue-1", type: "STATUS_CHANGED",
    detail: "Status OPEN → ACKNOWLEDGED. Alternate supplier contacted; delivery expected within 48h.",
    actorUserId: "user-pm", createdAt: "2026-07-06T10:05:00.000Z",
  });
  msg({
    id: "wamsg-4", threadId: "thread-m3",
    body: "Field issue created: “Gravel shortfall at km 12 stockpile” (MATERIAL, HIGH). Operational record only — release eligibility is controlled solely by the formal approval workflow.",
    messageType: "ISSUE_REFERENCE", refId: "issue-1",
    createdAt: "2026-07-06T09:30:30.000Z",
  });
  msg({
    id: "wamsg-5", threadId: "thread-m3",
    senderUserId: "user-pm", senderDisplayName: "Daniel Phiri", messageType: "TEXT",
    body: "Acknowledged — issue logged and an alternate supplier is being arranged. Reminder: this chat coordinates only; evidence still goes through OBV field capture and release needs the formal approvals.",
    createdAt: "2026-07-06T10:06:00.000Z",
  });

  // ---- seeded draw request (lender draw workflow demo) ----
  // Draw #1 covers the gravel-base phase and sits mid-review: one line is
  // supported by verified M2 evidence, one is held as an exception (cost
  // ahead of verified M3 progress), one is partially supported (stored
  // materials). The conditional lien waiver is still missing, so the
  // deterministic recommendation reads HOLD — DOCUMENTS MISSING with the
  // open HIGH gravel-shortfall issue also on record. Nothing here touches
  // approvals or the virtual account: it is a request for review.
  seedDemoDraw();

  // ---- seeded budget lines (budget vs verified progress demo) ----
  // Financial-control records: original budgets reconcile to the project
  // total ($2.4M); paid-to-date mirrors the released M1/M2 tranches. With
  // Draw #1 open ($600k claimed), financial progress (55%) reads ahead of
  // verified physical progress (30%) — a comparison, not an accusation.
  seedDemoBudget();

  // ---- seeded VAM banking layer (mock provider; demo simulation only) ----
  // A completed, governance-approved historical draw plus a lender-
  // controlled banking program with one settled payment, one hold and a
  // payment instruction awaiting its second approval. Every value is a
  // stored record — no money exists or moves.
  seedDemoBanking();

  // ---- retainage policy (10%, default closeout conditions) ----
  repo.upsertRetainagePolicy({
    projectId: "proj-r47",
    retainagePercent: 10,
    requiredConditions: ["FINAL_LIEN_WAIVER", "CERTIFICATE_OF_COMPLETION", "ALL_EXCEPTIONS_RESOLVED"],
    updatedAt: "2026-07-05T09:00:00.000Z",
    updatedBy: "user-funder",
  });

  // ---- seeded change order (SUBMITTED — pending review, nothing applied) ----
  // A submitted change order is a request: budget, milestones and schedule
  // stay untouched until the formal governance path approves it.
  seedDemoChangeOrder();

  // ---- unified exceptions: deterministic sweep over the seeded state ----
  // Creates the out-of-the-box register (HIGH field issue, missing lien
  // waiver, budget variance) from real conditions — nothing is invented.
  await evaluateExceptions();

  const chain = await wormEvidenceStore.verifyChain();
  console.log(
    `Seeded project "${project.name}" with ${milestones.length} milestones, ` +
    `4 users, ${chain.entries} ledger entries (chain valid: ${chain.valid}).`
  );
}

function seedDemoChangeOrder(): void {
  const t = (s: string) => `2026-07-0${s}`;
  repo.insertChangeOrder({
    id: "co-1",
    organizationId: "org-cdfc",
    projectId: "proj-r47",
    changeOrderNumber: 1,
    title: "Additional drainage structures — km 9+200",
    description:
      "Unrecorded seasonal stream crossing at km 9+200 requires two extra " +
      "box culverts and headwalls beyond the contracted drainage scope. " +
      "Submitted for review; no budget or schedule change until approved.",
    reasonCategory: "SITE_CONDITION",
    requestedByUserId: "user-pm",
    requestedAt: t("6T10:30:00.000Z"),
    requestedAmount: 85_000,
    approvedAmount: null,
    currency: "USD",
    scheduleImpactDays: 6,
    status: "SUBMITTED",
    affectedMilestoneIds: ["ms-2"],
    affectedBudgetLineIds: ["bl-2"],
    appliedAt: null,
    appliedSnapshotVersion: null,
    createdAt: t("5T14:00:00.000Z"),
    updatedAt: t("6T10:30:00.000Z"),
    supportingDocumentCount: 0,
  });
  repo.insertCoAllocation({
    id: "coa-1",
    changeOrderId: "co-1",
    budgetLineId: "bl-2",
    amount: 85_000,
    note: "Two box culverts + headwalls, km 9+200",
  });
  const events: Array<[string, "CREATED" | "SUBMITTED", string, string]> = [
    ["coe-1", "CREATED", "Change order drafted", t("5T14:00:00.000Z")],
    ["coe-2", "SUBMITTED", "Submitted for review — allocations reconcile to $85,000", t("6T10:30:00.000Z")],
  ];
  for (const [id, type, detail, createdAt] of events) {
    repo.insertCoEvent({ id, changeOrderId: "co-1", type, detail, actorUserId: "user-pm", createdAt });
  }
}

function seedDemoDraw(): void {
  const t = (s: string) => `2026-07-0${s}`;
  repo.insertDrawRequest({
    id: "draw-1",
    organizationId: "org-cdfc",
    projectId: "proj-r47",
    drawNumber: 1,
    requestedByUserId: "user-pm",
    requestedByOrganizationId: "org-crra",
    submittedAt: t("7T09:00:00.000Z"),
    requestedAmount: 600_000,
    approvedAmount: null,
    recommendedAmount: null,
    currency: "USD",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    retainageRate: null,
    retainageWithheld: null,
    status: "UNDER_REVIEW",
    reviewRecommendation: null,
    reviewSummary: null,
    createdAt: t("6T15:00:00.000Z"),
    updatedAt: t("8T11:00:00.000Z"),
  });
  const reqs: Array<[string, string, string, number]> = [
    ["dreq-1", "PAY_APPLICATION", "Pay application / schedule of values", 1],
    ["dreq-2", "CONTRACTOR_INVOICE", "Contractor invoice", 1],
    ["dreq-3", "CONDITIONAL_LIEN_WAIVER", "Conditional lien waiver", 1],
    ["dreq-4", "INSPECTION_REPORT", "Inspection report", 0],
    ["dreq-5", "MATERIAL_INVOICE", "Material invoices (stored materials)", 0],
  ];
  reqs.forEach(([id, docType, title, required], i) =>
    repo.insertDrawRequirement({
      id, drawRequestId: "draw-1", sort: i,
      docType: docType as never, title, required: Boolean(required), notes: null,
    })
  );
  const lineBase = {
    drawRequestId: "draw-1",
    totalCompletedAndStored: 0, balanceToFinish: 0,
    varianceAmount: null, variancePercent: null,
  };
  repo.insertDrawLine({
    ...lineBase,
    id: "dline-1", sort: 0, budgetLineId: "02-300",
    milestoneId: "ms-2", description: "Drainage structures — completion balance",
    scheduledValue: 480_000, previouslyPaid: 400_000, currentRequested: 80_000,
    materialsStored: null, retainageAmount: 8_000,
    percentCompleteClaimed: 100, percentCompleteVerified: 100,
    supportedAmount: null, status: "SUPPORTED",
    reviewNotes: null, reviewedByUserId: "user-compliance",
    reviewedAt: t("8T10:20:00.000Z"),
  });
  repo.insertDrawLine({
    ...lineBase,
    id: "dline-2", sort: 1, budgetLineId: "02-610",
    milestoneId: "ms-3", description: "Gravel base course placement, km 7–11",
    scheduledValue: 600_000, previouslyPaid: 0, currentRequested: 450_000,
    materialsStored: null, retainageAmount: 45_000,
    percentCompleteClaimed: 75, percentCompleteVerified: 0,
    supportedAmount: null, status: "EXCEPTION",
    reviewNotes: "Claimed 75% exceeds verified physical progress — M3 evidence not yet verified through the OBV pipeline.",
    reviewedByUserId: "user-compliance", reviewedAt: t("8T10:35:00.000Z"),
  });
  repo.insertDrawLine({
    ...lineBase,
    id: "dline-3", sort: 2, budgetLineId: "02-615",
    milestoneId: "ms-3", description: "Stored materials — gravel stockpile km 12",
    scheduledValue: 90_000, previouslyPaid: 0, currentRequested: 70_000,
    materialsStored: 70_000, retainageAmount: 7_000,
    percentCompleteClaimed: null, percentCompleteVerified: null,
    supportedAmount: 40_000, status: "PARTIALLY_SUPPORTED",
    reviewNotes: "Delivery documentation covers ≈$40,000 of the stored material; supplier interruption (field issue) leaves the balance unsupported.",
    reviewedByUserId: "user-funder", reviewedAt: t("8T10:50:00.000Z"),
  });
  repo.insertDrawDocument({
    id: "ddoc-1", drawRequestId: "draw-1", requirementId: "dreq-1",
    lineItemId: null, docType: "PAY_APPLICATION", title: "Pay Application #1 (June 2026)",
    filePath: null, note: null, status: "RECEIVED", expiresAt: null,
    uploadedByUserId: "user-pm", receivedAt: t("7T09:05:00.000Z"),
    reviewedByUserId: null, reviewedAt: null, reviewNote: null,
  });
  repo.insertDrawDocument({
    id: "ddoc-2", drawRequestId: "draw-1", requirementId: "dreq-2",
    lineItemId: null, docType: "CONTRACTOR_INVOICE", title: "Contractor invoice CRRA-2026-014",
    filePath: null, note: null, status: "ACCEPTED", expiresAt: null,
    uploadedByUserId: "user-pm", receivedAt: t("7T09:06:00.000Z"),
    reviewedByUserId: "user-compliance", reviewedAt: t("8T10:10:00.000Z"),
    reviewNote: "Amounts agree with the schedule of values.",
    vendor: "Central Region Roads Authority (civil works)",
    invoiceNumber: "CRRA-2026-014", amount: 600_000,
  });
  repo.insertDrawEvidenceLink({
    id: "dlink-1", drawRequestId: "draw-1", lineItemId: "dline-1",
    evidenceItemId: "ev-ms-2",
    note: "Verified culvert completion evidence supports the drainage balance.",
    linkedByUserId: "user-pm", createdAt: t("7T09:10:00.000Z"),
  });
  const drawEvents: Array<[string, string, string, string | null, string]> = [
    ["dev-1", "CREATED", "Draft draw #1 created by Daniel Phiri for $600,000.", "user-pm", t("6T15:00:00.000Z")],
    ["dev-2", "SUBMITTED", "Draw #1 submitted by Daniel Phiri — $600,000 requested. Awaiting lender review; no funds are authorized by submission.", "user-pm", t("7T09:00:00.000Z")],
    ["dev-3", "LINE_REVIEWED", "Line \"Drainage structures — completion balance\" marked SUPPORTED by Amina Ndlovu. Line review is advisory: it cannot release funds.", "user-compliance", t("8T10:20:00.000Z")],
    ["dev-4", "LINE_REVIEWED", "Line \"Gravel base course placement, km 7–11\" marked EXCEPTION by Amina Ndlovu — claimed progress exceeds verified physical progress.", "user-compliance", t("8T10:35:00.000Z")],
    ["dev-5", "LINE_REVIEWED", "Line \"Stored materials — gravel stockpile km 12\" marked PARTIALLY SUPPORTED by Margaret Osei ($40,000 of $70,000 supported).", "user-funder", t("8T10:50:00.000Z")],
  ];
  for (const [id, type, detail, actor, createdAt] of drawEvents) {
    repo.insertDrawEvent({ id, drawRequestId: "draw-1", type: type as never, detail, actorUserId: actor, createdAt });
  }
  repo.insertThread({
    id: "thread-draw-1",
    organizationId: "org-cdfc",
    projectId: "proj-r47",
    milestoneId: null,
    evidenceItemId: null,
    approvalRequestId: null,
    drawRequestId: "draw-1",
    title: "Draw #1 · Review",
    scope: "DRAW",
    createdAt: t("7T09:00:30.000Z"),
    createdBy: "user-pm",
  });
  repo.insertChatMessage({
    id: "dmsg-1", threadId: "thread-draw-1",
    senderUserId: null, senderDisplayName: "OBV", provider: "OBV",
    externalThreadId: null, externalMessageId: null,
    body: "Draw #1 submitted for review — $600,000 requested. Review and formal governance still required; nothing is released by submission.",
    messageType: "DRAW_REFERENCE", refId: "draw-1",
    createdAt: t("7T09:00:31.000Z"), deliveryStatus: "SENT", origin: "OBV_LOCAL",
    editedAt: null, originalBody: null, externalDeleted: false,
    attachments: [], location: null,
  });
  repo.insertChatMessage({
    id: "dmsg-2", threadId: "thread-draw-1",
    senderUserId: "user-compliance", senderDisplayName: "Amina Ndlovu", provider: "OBV",
    externalThreadId: null, externalMessageId: null,
    body: "Reviewing the June draw now. The conditional lien waiver is still outstanding — the draw stays on documents-hold until it is on file, whatever we conclude on the line items.",
    messageType: "TEXT", refId: null,
    createdAt: t("8T10:00:00.000Z"), deliveryStatus: "SENT", origin: "OBV_LOCAL",
    editedAt: null, originalBody: null, externalDeleted: false,
    attachments: [], location: null,
  });
}

function seedDemoBudget(): void {
  const now = "2026-07-05T09:00:00.000Z";
  const lines: Array<[string, string, string, string, number, number, number | null, string | null]> = [
    // id, code, category, description, originalBudget, paidToDate, retainage, milestoneId
    ["bl-1", "01-000", "Site Work", "Mobilization & vegetation clearing", 240_000, 240_000, null, "ms-1"],
    ["bl-2", "02-300", "Drainage & Earthworks", "Grading, culverts and drainage structures", 560_000, 480_000, 24_000, "ms-2"],
    ["bl-3", "02-610", "Base Course", "Gravel base course placement km 0-14", 600_000, 0, null, "ms-3"],
    ["bl-4", "02-615", "Base Course", "Stored materials - gravel stockpiles", 90_000, 0, null, "ms-3"],
    ["bl-5", "03-100", "Structures", "Kasitu river crossing bridge deck", 560_000, 0, null, "ms-4"],
    ["bl-6", "04-100", "Surfacing", "Final surfacing, signage & handover", 350_000, 0, null, "ms-5"],
  ];
  lines.forEach(([id, code, category, description, originalBudget, paidToDate, retainageHeld, milestoneId], i) => {
    repo.insertBudgetLine({
      id, projectId: "proj-r47", code, category, description,
      originalBudget, approvedChanges: 0, committedAmount: null, paidToDate,
      retainageHeld, currency: "USD", sequence: i, active: true,
      createdAt: now, updatedAt: now, currentBudget: 0,
    });
    if (milestoneId) {
      repo.insertBudgetLineMap({
        id: `blm-${id}`, budgetLineId: id, milestoneId,
        evidenceRequirementId: null, createdAt: now,
      });
    }
  });
}

/**
 * Remove demo-scoped rows only (projects/orgs/users/threads/records of
 * the seeded R47 demo). Ledger entries and WORM objects are append-only
 * and are intentionally NOT touched. Pilot data is never matched here —
 * everything is keyed off the fixed demo ids.
 */
function purgeDemoScopedRows(): void {
  const db = getDb();
  // ledger_entries intentionally keeps its rows (append-only doctrine —
  // a reset never rewrites history). Their references to purged demo
  // evidence/verification rows become historical: the seeded fixed-id
  // records are re-created identically, and mid-demo records show as
  // "removed by demo reset" in the UI. FK enforcement is suspended for
  // exactly this purge so the ledger can stay untouched.
  db.exec("PRAGMA foreign_keys = OFF;");
  const DEMO_PROJECT = "proj-r47";
  const DEMO_ORGS = ["org-cdfc", "org-crra"];
  const DEMO_USERS = ["user-pm", "user-field", "user-funder", "user-compliance", "user-lender2"];
  const inList = (ids: string[]) => ids.map(() => "?").join(",");

  const threadIds = db
    .prepare(
      `SELECT id FROM conversation_threads
        WHERE project_id = ? OR (project_id IS NULL AND organization_id IN (${inList(DEMO_ORGS)}))`
    )
    .all(DEMO_PROJECT, ...DEMO_ORGS)
    .map((r) => (r as { id: string }).id);
  const msIds = db
    .prepare("SELECT id FROM milestones WHERE project_id = ?")
    .all(DEMO_PROJECT)
    .map((r) => (r as { id: string }).id);

  // Message-referencing rows first (field issues, clarifications, drafts),
  // then messages/threads, then the milestone-scoped records.
  db.prepare(
    `DELETE FROM field_issue_events WHERE issue_id IN
       (SELECT id FROM field_issues WHERE project_id = ?)`
  ).run(DEMO_PROJECT);
  db.prepare("DELETE FROM field_issues WHERE project_id = ?").run(DEMO_PROJECT);
  if (msIds.length) {
    db.prepare(`DELETE FROM clarification_requests WHERE milestone_id IN (${inList(msIds)})`).run(...msIds);
  }
  db.prepare("DELETE FROM evidence_drafts WHERE project_id = ?").run(DEMO_PROJECT);

  if (threadIds.length) {
    db.prepare(`DELETE FROM messages WHERE thread_id IN (${inList(threadIds)})`).run(...threadIds);
    db.prepare(`DELETE FROM external_thread_bindings WHERE thread_id IN (${inList(threadIds)})`).run(...threadIds);
    db.prepare(
      `DELETE FROM external_participant_contexts WHERE active_thread_id IN (${inList(threadIds)})`
    ).run(...threadIds);
    db.prepare(`DELETE FROM conversation_threads WHERE id IN (${inList(threadIds)})`).run(...threadIds);
  }
  db.prepare("DELETE FROM external_participant_contexts WHERE active_project_id = ?").run(DEMO_PROJECT);
  db.prepare(
    `DELETE FROM external_identity_mappings
      WHERE obv_user_id IN (${inList(DEMO_USERS)}) OR id = 'waid-field'`
  ).run(...DEMO_USERS);

  if (msIds.length) {
    const ph = inList(msIds);
    db.prepare(
      `DELETE FROM approval_records WHERE approval_request_id IN
         (SELECT id FROM approval_requests WHERE milestone_id IN (${ph}))`
    ).run(...msIds);
    db.prepare(`DELETE FROM approval_requests WHERE milestone_id IN (${ph})`).run(...msIds);
    db.prepare(`DELETE FROM virtual_account_events WHERE milestone_id IN (${ph})`).run(...msIds);
    db.prepare(
      `DELETE FROM verifications WHERE evidence_item_id IN
         (SELECT id FROM evidence_items WHERE milestone_id IN (${ph}))`
    ).run(...msIds);
    db.prepare(`DELETE FROM evidence_items WHERE milestone_id IN (${ph})`).run(...msIds);
    db.prepare(`DELETE FROM demo_fallback_photos WHERE milestone_id IN (${ph})`).run(...msIds);
    db.prepare(`DELETE FROM evidence_requirements WHERE milestone_id IN (${ph})`).run(...msIds);
    db.prepare(`DELETE FROM approval_policies WHERE project_id = ?`).run(DEMO_PROJECT);
  }
  // Draw-workflow rows for the demo project (draw threads/messages were
  // already removed with the project threads above).
  const drawIds = db
    .prepare("SELECT id FROM draw_requests WHERE project_id = ?")
    .all(DEMO_PROJECT)
    .map((r) => (r as { id: string }).id);
  if (drawIds.length) {
    const dph = inList(drawIds);
    db.prepare(
      `DELETE FROM approval_records WHERE approval_request_id IN
         (SELECT id FROM approval_requests WHERE draw_request_id IN (${dph}))`
    ).run(...drawIds);
    db.prepare(`DELETE FROM approval_requests WHERE draw_request_id IN (${dph})`).run(...drawIds);
    db.prepare(`DELETE FROM draw_account_events WHERE draw_request_id IN (${dph})`).run(...drawIds);
    db.prepare(`DELETE FROM draw_events WHERE draw_request_id IN (${dph})`).run(...drawIds);
    db.prepare(`DELETE FROM draw_evidence_links WHERE draw_request_id IN (${dph})`).run(...drawIds);
    db.prepare(`DELETE FROM draw_documents WHERE draw_request_id IN (${dph})`).run(...drawIds);
    db.prepare(`DELETE FROM draw_document_requirements WHERE draw_request_id IN (${dph})`).run(...drawIds);
    db.prepare(`DELETE FROM draw_line_items WHERE draw_request_id IN (${dph})`).run(...drawIds);
    // Lender decisions/conditions attached to demo draws (seeded or
    // created during a demo session) — cleaned so fixed seed ids can be
    // re-inserted.
    db.prepare(
      `DELETE FROM lender_condition_events WHERE condition_id IN
         (SELECT id FROM lender_decision_conditions WHERE lender_decision_id IN
            (SELECT id FROM lender_draw_decisions WHERE draw_request_id IN (${dph})))`
    ).run(...drawIds);
    db.prepare(
      `DELETE FROM lender_decision_conditions WHERE lender_decision_id IN
         (SELECT id FROM lender_draw_decisions WHERE draw_request_id IN (${dph}))`
    ).run(...drawIds);
    db.prepare(`DELETE FROM lender_draw_decisions WHERE draw_request_id IN (${dph})`).run(...drawIds);
    db.prepare(`DELETE FROM draw_requests WHERE id IN (${dph})`).run(...drawIds);

  // ---- VAM banking layer (project + demo-org scoped) ----
  db.prepare("DELETE FROM banking_events WHERE project_id = ?").run(DEMO_PROJECT);
  db.prepare(
    "DELETE FROM bank_transactions WHERE project_virtual_account_id IN (SELECT id FROM project_virtual_accounts WHERE project_id = ?)"
  ).run(DEMO_PROJECT);
  db.prepare(
    "DELETE FROM payment_instructions WHERE project_virtual_account_id IN (SELECT id FROM project_virtual_accounts WHERE project_id = ?)"
  ).run(DEMO_PROJECT);
  db.prepare(
    "DELETE FROM project_account_holds WHERE project_virtual_account_id IN (SELECT id FROM project_virtual_accounts WHERE project_id = ?)"
  ).run(DEMO_PROJECT);
  db.prepare("DELETE FROM project_virtual_accounts WHERE project_id = ?").run(DEMO_PROJECT);
  db.prepare(`DELETE FROM reconciliation_runs WHERE banking_program_id IN (SELECT id FROM banking_programs WHERE organization_id IN (${inList(DEMO_ORGS)}))`).run(...DEMO_ORGS);
  db.prepare(`DELETE FROM mock_provider_ledger WHERE banking_program_id IN (SELECT id FROM banking_programs WHERE organization_id IN (${inList(DEMO_ORGS)}))`).run(...DEMO_ORGS);
  db.prepare(`DELETE FROM banking_programs WHERE organization_id IN (${inList(DEMO_ORGS)})`).run(...DEMO_ORGS);
  }
  // Change orders + retainage rows for the demo project.
  const coIds = db
    .prepare("SELECT id FROM change_orders WHERE project_id = ?")
    .all(DEMO_PROJECT)
    .map((r) => (r as { id: string }).id);
  if (coIds.length) {
    const cph = inList(coIds);
    db.prepare(
      `DELETE FROM approval_records WHERE approval_request_id IN
         (SELECT id FROM approval_requests WHERE change_order_id IN (${cph}))`
    ).run(...coIds);
    db.prepare(`DELETE FROM approval_requests WHERE change_order_id IN (${cph})`).run(...coIds);
    db.prepare(`DELETE FROM change_order_events WHERE change_order_id IN (${cph})`).run(...coIds);
    db.prepare(`DELETE FROM change_order_documents WHERE change_order_id IN (${cph})`).run(...coIds);
    db.prepare(`DELETE FROM change_order_allocations WHERE change_order_id IN (${cph})`).run(...coIds);
    db.prepare(`DELETE FROM change_orders WHERE id IN (${cph})`).run(...coIds);
  }
  const relIds = db
    .prepare("SELECT id FROM retainage_release_requests WHERE project_id = ?")
    .all(DEMO_PROJECT)
    .map((r) => (r as { id: string }).id);
  if (relIds.length) {
    const rph = inList(relIds);
    db.prepare(
      `DELETE FROM approval_records WHERE approval_request_id IN
         (SELECT id FROM approval_requests WHERE retainage_release_id IN (${rph}))`
    ).run(...relIds);
    db.prepare(`DELETE FROM approval_requests WHERE retainage_release_id IN (${rph})`).run(...relIds);
    db.prepare(`DELETE FROM retainage_conditions WHERE release_request_id IN (${rph})`).run(...relIds);
    db.prepare(`DELETE FROM retainage_release_requests WHERE id IN (${rph})`).run(...relIds);
  }
  db.prepare("DELETE FROM retainage_events WHERE project_id = ?").run(DEMO_PROJECT);
  db.prepare("DELETE FROM retainage_policies WHERE project_id = ?").run(DEMO_PROJECT);
  // Milestone completion gate records for the demo project.
  db.prepare("DELETE FROM jurisdictional_inspections WHERE project_id = ?").run(DEMO_PROJECT);
  db.prepare("DELETE FROM inspection_requirements WHERE project_id = ?").run(DEMO_PROJECT);
  // Audit packages generated against the demo project (rows + ZIP files).
  const apIds = db
    .prepare("SELECT id FROM audit_packages WHERE project_id = ?")
    .all(DEMO_PROJECT)
    .map((r) => (r as { id: string }).id);
  for (const id of apIds) {
    fs.rmSync(path.join(AUDIT_PACKAGES_DIR, id), { recursive: true, force: true });
  }
  db.prepare("DELETE FROM audit_packages WHERE project_id = ?").run(DEMO_PROJECT);
  // Exception control records for the demo project.
  db.prepare(
    `DELETE FROM exception_events WHERE exception_id IN
       (SELECT id FROM exceptions WHERE project_id = ?)`
  ).run(DEMO_PROJECT);
  db.prepare("DELETE FROM exceptions WHERE project_id = ?").run(DEMO_PROJECT);
  // Budget vs verified-progress rows for the demo project.
  db.prepare(
    `DELETE FROM budget_line_maps WHERE budget_line_id IN
       (SELECT id FROM budget_lines WHERE project_id = ?)`
  ).run(DEMO_PROJECT);
  db.prepare("DELETE FROM budget_lines WHERE project_id = ?").run(DEMO_PROJECT);
  if (msIds.length) {
    db.prepare(`DELETE FROM verified_quantities WHERE milestone_id IN (${inList(msIds)})`).run(...msIds);
  }
  db.prepare("DELETE FROM field_assignments WHERE project_id = ?").run(DEMO_PROJECT);
  db.prepare("DELETE FROM verification_policies WHERE project_id = ?").run(DEMO_PROJECT);
  db.prepare("DELETE FROM spatial_features WHERE project_id = ?").run(DEMO_PROJECT);
  db.prepare("DELETE FROM notifications WHERE project_id = ? OR project_id IS NULL").run(DEMO_PROJECT);
  db.prepare("DELETE FROM reports WHERE project_id = ?").run(DEMO_PROJECT);
  db.prepare("DELETE FROM milestones WHERE project_id = ?").run(DEMO_PROJECT);
  db.prepare("DELETE FROM projects WHERE id = ?").run(DEMO_PROJECT);
  db.prepare(`DELETE FROM users WHERE id IN (${inList(DEMO_USERS)})`).run(...DEMO_USERS);
  db.prepare(`DELETE FROM organizations WHERE id IN (${inList(DEMO_ORGS)})`).run(...DEMO_ORGS);
  db.exec("PRAGMA foreign_keys = ON;");
}

function seedDemoBanking(): void {
  const t = (s: string) => `2026-07-${s}`;

  // Second lender officer: dual control needs a second authorized user
  // who is neither the instruction creator nor the draw submitter.
  repo.insertUser({
    id: "user-lender2",
    organizationId: "org-cdfc",
    name: "Elena Vargas",
    role: "FUNDER_REP",
    title: "Lender Operations Officer",
  });

  // Attributable inspection-requirement determination for the milestone
  // the historical draw bills. The payment-eligibility boundary consults
  // the existing completion-gate machinery, and an UNDETERMINED
  // requirement honestly blocks payment — this is the reviewed
  // NOT_REQUIRED determination that makes the seeded draw payable.
  repo.upsertInspectionRequirement({
    id: "insreq-ms-2",
    projectId: "proj-r47",
    milestoneId: "ms-2",
    requirement: "NOT_REQUIRED",
    requirementBasis:
      "Drainage-structure tranche below the district permit threshold; reviewed determination for the rehabilitation scope.",
    determinedBy: "user-compliance",
    determinedAt: t("01T09:00:00.000Z"),
    jurisdiction: null,
    inspectionType: null,
    issuingAuthority: null,
    mustPassBeforeDrawReview: false,
    mustPassBeforeGovernance: true,
    finalCompletionOnly: false,
    resultDocumentRequired: false,
    permitRequired: false,
    requiredPermitType: null,
    officialSourceRequired: false,
    codeBasisRequired: false,
    permitMustBeActiveBeforeDrawReview: false,
    permitMustBeActiveBeforeGovernance: false,
    configurationVersion: 1,
    createdAt: t("01T09:00:00.000Z"),
    updatedAt: t("01T09:00:00.000Z"),
  });

  // ---- historical governance-approved draw (basis for payments) ----
  repo.insertDrawRequest({
    id: "draw-vam",
    organizationId: "org-cdfc",
    projectId: "proj-r47",
    drawNumber: 2,
    requestedByUserId: "user-pm",
    requestedByOrganizationId: "org-crra",
    submittedAt: t("02T09:00:00.000Z"),
    requestedAmount: 200_000,
    approvedAmount: 200_000,
    recommendedAmount: 200_000,
    currency: "USD",
    periodStart: "2026-05-01",
    periodEnd: "2026-05-31",
    retainageRate: 10,
    retainageWithheld: 20_000,
    status: "APPROVED",
    reviewRecommendation: null,
    reviewSummary: "Historical draw — governance approved before the VAM demo window.",
    createdAt: t("01T15:00:00.000Z"),
    updatedAt: t("03T11:00:00.000Z"),
  });
  repo.insertDrawLine({
    id: "dline-vam-1",
    drawRequestId: "draw-vam",
    sort: 0,
    budgetLineId: "02-300",
    milestoneId: "ms-2",
    description: "Drainage structures — May completion tranche",
    scheduledValue: 200_000,
    previouslyPaid: 0,
    currentRequested: 200_000,
    materialsStored: null,
    retainageAmount: 20_000,
    percentCompleteClaimed: 100,
    percentCompleteVerified: 100,
    supportedAmount: 200_000,
    status: "SUPPORTED",
    reviewNotes: null,
    reviewedByUserId: "user-compliance",
    reviewedAt: t("02T16:00:00.000Z"),
    totalCompletedAndStored: 0,
    balanceToFinish: 0,
    varianceAmount: null,
    variancePercent: null,
  });
  repo.insertApprovalRequest({
    id: "appr-draw-vam",
    milestoneId: null,
    drawRequestId: "draw-vam",
    subjectType: "DRAW",
    status: "APPROVED",
    requiredRoles: ["FUNDER_REP", "COMPLIANCE_REVIEWER"],
    createdAt: t("03T09:00:00.000Z"),
  });
  repo.insertApprovalRecord({
    id: "apprec-vam-1", approvalRequestId: "appr-draw-vam", userId: "user-funder",
    role: "FUNDER_REP", decision: "APPROVED", createdAt: t("03T10:00:00.000Z"),
  });
  repo.insertApprovalRecord({
    id: "apprec-vam-2", approvalRequestId: "appr-draw-vam", userId: "user-compliance",
    role: "COMPLIANCE_REVIEWER", decision: "APPROVED", createdAt: t("03T10:30:00.000Z"),
  });
  lrepo.insertLenderDecision({
    id: "ldec-vam",
    organizationId: "org-cdfc",
    projectId: "proj-r47",
    drawRequestId: "draw-vam",
    requestedAmount: 200_000,
    verifiedAmount: 200_000,
    recommendedAmount: 200_000,
    approvedAmount: 200_000,
    reducedAmount: null,
    rejectedAmount: null,
    decision: "APPROVED",
    reviewerUserId: "user-funder",
    decisionAt: t("03T11:00:00.000Z"),
    decisionReason: "Verified line support equals the requested amount; governance approval appr-draw-vam is complete.",
    holdbackAmount: null,
    retainageAmount: 20_000,
    exceptionsAccepted: null,
    governmentInspectionRequirement: null,
    lienReleaseRequirement: null,
    fundingInstructions: null,
    notes: null,
    approvalRequestId: "appr-draw-vam",
    supersedesDecisionId: null,
    supersededByDecisionId: null,
    verifiedAmountSource: "SUPPORTED_LINE_TOTAL",
    recommendedAmountSource: "REVIEW",
    createdAt: t("03T11:00:00.000Z"),
    updatedAt: t("03T11:00:00.000Z"),
  });

  // ---- banking program + project virtual account (mock provider) ----
  brepo.insertProgram({
    id: "bank-prog-1",
    organizationId: "org-cdfc",
    provider: "MOCK",
    providerProgramReference: "MOCK-PRG-SEED0001",
    partnerBankName: "First Community Bank, N.A.",
    accountStructure: "LENDER_CONTROLLED",
    status: "ACTIVE",
    currency: "USD",
    createdAt: t("04T09:00:00.000Z"),
    updatedAt: t("04T09:00:00.000Z"),
    activatedAt: t("04T09:00:00.000Z"),
    suspendedAt: null,
    metadata: null,
    createdByUserId: "user-funder",
  });
  brepo.insertAccount({
    id: "pva-r47",
    bankingProgramId: "bank-prog-1",
    projectId: "proj-r47",
    providerAccountReference: "MOCK-VA-SEED0001",
    virtualAccountNumberMasked: "\u2022\u2022\u2022\u20224207",
    routingNumberMasked: "\u2022\u2022\u2022\u20220031",
    currency: "USD",
    status: "ACTIVE",
    // End state of: +500,000 demo credit, 50,000 retainage hold,
    // 80,000 settled payment, 120,000 instruction awaiting approval
    // (earmarked out of release-eligible only).
    availableBalance: 370_000,
    heldBalance: 50_000,
    releaseEligibleBalance: 250_000,
    pendingOutboundAmount: 0,
    settledOutboundAmount: 80_000,
    returnedAmount: 0,
    createdAt: t("04T09:05:00.000Z"),
    activatedAt: t("04T09:05:00.000Z"),
    suspendedAt: null,
    closedAt: null,
    lastReconciledAt: t("06T08:00:00.000Z"),
  });

  // ---- the mock bank's own book (independent of OBV's ledger) ----
  brepo.insertMockLedgerEntry({
    id: "mockled-1", bankingProgramId: "bank-prog-1", entryType: "DEMO_DEPOSIT",
    amount: 500_000, reference: "MOCK-DEP-SEED0001", createdAt: t("04T09:10:00.000Z"),
  });
  brepo.insertMockLedgerEntry({
    // entry_type carries the event identity (type:transactionRef) so a
    // conflicting reuse of the eventId is detectable, not silent.
    id: "mockled-2", bankingProgramId: "bank-prog-1", entryType: "PAYMENT_SETTLED:MOCK-TXN-SEED0001",
    amount: -80_000, reference: "EVT:seed-settle-1", createdAt: t("05T14:00:00.000Z"),
  });

  // ---- bank transactions (bank-reported truth, mirrored) ----
  brepo.insertTransaction({
    id: "btx-credit-1",
    projectVirtualAccountId: "pva-r47",
    paymentInstructionId: null,
    providerTransactionReference: "MOCK-DEP-SEED0001",
    direction: "CREDIT",
    amount: 500_000,
    currency: "USD",
    status: "SETTLED",
    transactionType: "DEMO_DEPOSIT",
    initiatedAt: t("04T09:10:00.000Z"),
    postedAt: t("04T09:10:00.000Z"),
    settledAt: t("04T09:10:00.000Z"),
    returnedAt: null,
    description: "Construction reserve deposit (demo simulation)",
    rawEventHash: brepo.sha256Hex("seed-credit-1"),
  });

  // ---- settled historical payment (dual-controlled, provider-settled) ----
  brepo.insertInstruction({
    id: "pi-settled-1",
    projectVirtualAccountId: "pva-r47",
    drawRequestId: "draw-vam",
    lenderDecisionId: "ldec-vam",
    approvalRequestId: "appr-draw-vam",
    amount: 80_000,
    currency: "USD",
    recipientName: "Lakeshore Rehab Contractors LLC",
    recipientReference: "PAY-APP-2026-05",
    paymentMethod: "ACH_SIMULATED",
    status: "SETTLED",
    requestedByUserId: "user-funder",
    approvedByUserId: "user-lender2",
    requestedAt: t("05T09:00:00.000Z"),
    approvedAt: t("05T10:00:00.000Z"),
    submittedAt: t("05T11:00:00.000Z"),
    settledAt: t("05T14:00:00.000Z"),
    failedAt: null,
    cancelledAt: null,
    providerReference: "MOCK-PAY-SEED0001",
    failureCode: null,
    failureReason: null,
    idempotencyKey: "seed-pi-settled-1",
  });
  brepo.insertTransaction({
    id: "btx-pay-1",
    projectVirtualAccountId: "pva-r47",
    paymentInstructionId: "pi-settled-1",
    providerTransactionReference: "MOCK-TXN-SEED0001",
    direction: "DEBIT",
    amount: 80_000,
    currency: "USD",
    status: "SETTLED",
    transactionType: "ACH_SIMULATED",
    initiatedAt: t("05T11:00:00.000Z"),
    postedAt: t("05T12:00:00.000Z"),
    settledAt: t("05T14:00:00.000Z"),
    returnedAt: null,
    description: "Payment to Lakeshore Rehab Contractors LLC",
    rawEventHash: brepo.sha256Hex("seed-settle-1"),
  });

  // ---- active retainage-protection hold ----
  brepo.insertHold({
    id: "hold-1",
    projectVirtualAccountId: "pva-r47",
    drawRequestId: "draw-vam",
    amount: 50_000,
    reasonCode: "RETAINAGE_PROTECTION",
    reason: "Retainage protection pending closeout conditions",
    status: "ACTIVE",
    placedAt: t("04T10:00:00.000Z"),
    releasedAt: null,
    placedByUserId: "user-funder",
    releasedByUserId: null,
    providerReference: "MOCK-HOLD-SEED0001",
  });

  // ---- payment instruction awaiting its second approval ----
  brepo.insertInstruction({
    id: "pi-pending-1",
    projectVirtualAccountId: "pva-r47",
    drawRequestId: "draw-vam",
    lenderDecisionId: "ldec-vam",
    approvalRequestId: "appr-draw-vam",
    amount: 120_000,
    currency: "USD",
    recipientName: "Lakeshore Rehab Contractors LLC",
    recipientReference: "PAY-APP-2026-05-FINAL",
    paymentMethod: "ACH_SIMULATED",
    status: "PENDING_APPROVAL",
    requestedByUserId: "user-funder",
    approvedByUserId: null,
    requestedAt: t("06T09:00:00.000Z"),
    approvedAt: null,
    submittedAt: null,
    settledAt: null,
    failedAt: null,
    cancelledAt: null,
    providerReference: null,
    failureCode: null,
    failureReason: null,
    idempotencyKey: "seed-pi-pending-1",
  });

  // ---- successful reconciliation: bank 420,000 = 370,000 + 50,000 + 0 ----
  brepo.insertReconciliationRun({
    id: "recon-1",
    bankingProgramId: "bank-prog-1",
    startedAt: t("06T08:00:00.000Z"),
    completedAt: t("06T08:00:05.000Z"),
    status: "MATCHED",
    bankReportedBalance: 420_000,
    ledgerCalculatedBalance: 420_000,
    differenceAmount: 0,
    projectAccountCount: 1,
    transactionCount: 2,
    findings: JSON.stringify({
      formula: "bankReported = sum(available + held + pendingOutbound) + suspense",
      suspenseBalance: 0,
    }),
    initiatedBy: "user-funder",
    previousSuccessfulRunId: null,
  });

  // ---- append-only, attributable banking events ----
  const ev = (
    id: string, type: string, detail: string, actor: string | null, createdAt: string,
    extra: Partial<{ drawRequestId: string; paymentInstructionId: string; bankTransactionId: string }> = {}
  ) =>
    brepo.insertBankingEvent({
      id,
      organizationId: "org-cdfc",
      projectId: "proj-r47",
      bankingProgramId: "bank-prog-1",
      projectVirtualAccountId: id === "bev-1" ? null : "pva-r47",
      drawRequestId: extra.drawRequestId ?? null,
      paymentInstructionId: extra.paymentInstructionId ?? null,
      bankTransactionId: extra.bankTransactionId ?? null,
      type: type as never,
      detail,
      actorUserId: actor,
      createdAt,
    });
  ev("bev-1", "PROGRAM_CREATED", "Banking program created at First Community Bank, N.A. (LENDER_CONTROLLED, MOCK provider).", "user-funder", t("04T09:00:00.000Z"));
  ev("bev-2", "ACCOUNT_CREATED", "Project virtual account \u2022\u2022\u2022\u20224207 created (subledger identity).", "user-funder", t("04T09:05:00.000Z"));
  ev("bev-3", "DEMO_CREDIT_POSTED", "Demo simulation only: construction reserve deposit (+500000 USD).", "user-funder", t("04T09:10:00.000Z"), { bankTransactionId: "btx-credit-1" });
  ev("bev-4", "HOLD_PLACED", "Hold of 50000 USD placed (RETAINAGE_PROTECTION).", "user-funder", t("04T10:00:00.000Z"), { drawRequestId: "draw-vam" });
  ev("bev-5", "INSTRUCTION_CREATED", "Payment instruction of 80000 USD to Lakeshore Rehab Contractors LLC created; awaiting approval by a second authorized user.", "user-funder", t("05T09:00:00.000Z"), { drawRequestId: "draw-vam", paymentInstructionId: "pi-settled-1" });
  ev("bev-6", "INSTRUCTION_APPROVED", "Second-user approval recorded. Approval does NOT settle the payment.", "user-lender2", t("05T10:00:00.000Z"), { drawRequestId: "draw-vam", paymentInstructionId: "pi-settled-1" });
  ev("bev-7", "PROVIDER_SUBMISSION_SIMULATED", "Demo simulation only: instruction submitted to the MOCK provider; bank transaction opened PENDING.", "user-funder", t("05T11:00:00.000Z"), { drawRequestId: "draw-vam", paymentInstructionId: "pi-settled-1", bankTransactionId: "btx-pay-1" });
  ev("bev-8", "SETTLEMENT_RECORDED", "Provider-confirmed settlement of 80000 USD. This event — not any OBV approval — is the only settlement truth.", "user-funder", t("05T14:00:00.000Z"), { drawRequestId: "draw-vam", paymentInstructionId: "pi-settled-1", bankTransactionId: "btx-pay-1" });
  ev("bev-9", "INSTRUCTION_CREATED", "Payment instruction of 120000 USD to Lakeshore Rehab Contractors LLC created; awaiting approval by a second authorized user.", "user-funder", t("06T09:00:00.000Z"), { drawRequestId: "draw-vam", paymentInstructionId: "pi-pending-1" });
  ev("bev-10", "RECONCILIATION_MATCHED", "Reconciliation matched: bank 420000 = ledger 420000.", "user-funder", t("06T08:00:05.000Z"));
}

if (require.main === module) {
  seedDemo().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
