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
import { getDb, resetDb } from "./index";
import * as repo from "./repo";
import { COMM_MEDIA_DIR } from "../services/whatsappSync/provider";
import { runVerificationPipeline } from "../services/verification/index";
import { wormEvidenceStore, sha256 } from "../services/WormEvidenceStore";
import { virtualAccountService } from "../services/VirtualAccountService";
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

  const chain = await wormEvidenceStore.verifyChain();
  console.log(
    `Seeded project "${project.name}" with ${milestones.length} milestones, ` +
    `4 users, ${chain.entries} ledger entries (chain valid: ${chain.valid}).`
  );
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
  const DEMO_USERS = ["user-pm", "user-field", "user-funder", "user-compliance"];
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

if (require.main === module) {
  seedDemo().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
