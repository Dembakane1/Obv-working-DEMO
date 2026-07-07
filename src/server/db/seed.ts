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
import { resetDb } from "./index";
import * as repo from "./repo";
import { runVerificationPipeline } from "../services/verification/index";
import { wormEvidenceStore, sha256 } from "../services/WormEvidenceStore";
import { virtualAccountService } from "../services/VirtualAccountService";
import type {
  ApprovalRequest,
  EvidenceItem,
  Milestone,
  Project,
  Verification,
} from "../../shared/types";

/** Reset and reseed the demo database. Also used by POST /api/demo/reset. */
export async function seedDemo(): Promise<void> {
  resetDb();

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
      photo: "/demo-evidence/m1-clearing.svg",
      lat: -11.9021,
      lng: 33.5714,
      capturedAt: "2026-03-11T08:42:00.000Z",
      uploadedAt: "2026-03-11T10:05:00.000Z",
      approvedAt: "2026-03-13T14:20:00.000Z",
      releasedAt: "2026-03-14T09:00:00.000Z",
    },
    {
      milestone: milestones[1],
      photo: "/demo-evidence/m2-drainage.svg",
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
    path: "/demo-evidence/m3-gravel-a.svg",
    label: "Gravel base laid and graded (km 3+400)",
  });
  repo.insertDemoFallbackPhoto({
    id: "demo-m3-b",
    milestoneId: "ms-3",
    path: "/demo-evidence/m3-gravel-b.svg",
    label: "Grader compacting base layer (km 9+100)",
  });
  repo.insertDemoFallbackPhoto({
    id: "demo-m3-c",
    milestoneId: "ms-3",
    path: "/demo-evidence/m3-gravel-c.svg",
    label: "Surfaced section with km marker (km 12+000)",
  });

  const chain = await wormEvidenceStore.verifyChain();
  console.log(
    `Seeded project "${project.name}" with ${milestones.length} milestones, ` +
    `4 users, ${chain.entries} ledger entries (chain valid: ${chain.valid}).`
  );
}

if (require.main === module) {
  seedDemo().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
