/**
 * VirtualAccountService — project-level financial control ledger.
 *
 * Each milestone tranche is represented on a virtual project account as
 * HELD or RELEASED. This is governance/accounting state only: no real
 * money moves, and this is NOT cryptocurrency.
 *
 * TODO: production sponsor-bank / BaaS integration (e.g. a sponsor bank's
 *       virtual-account API or a BaaS provider), mapped behind this exact
 *       interface so application logic is unchanged.
 */
import * as repo from "../db/repo";
import type { DrawAccountEvent, DrawRequest, Milestone, VirtualAccountEvent } from "../../shared/types";

export interface ProjectAccountSummary {
  totalBudget: number;
  held: number;
  released: number;
  events: VirtualAccountEvent[];
}

export interface VirtualAccountService {
  /** Record that a milestone tranche is held pending verification+approval. */
  holdTranche(milestone: Milestone, createdAt?: string): Promise<VirtualAccountEvent>;
  /** Mark a tranche released (only after human approval — later prompt). */
  releaseTranche(milestone: Milestone, createdAt?: string): Promise<VirtualAccountEvent>;
  /**
   * Record the governed release transition of a Draw Request. Callable
   * ONLY from the completed-governance path in the workflow orchestrator
   * (all required ApprovalRecords in place). The draw_account_events
   * UNIQUE(draw, type) constraint makes this exactly-once at the database
   * level — a duplicate call throws instead of double-recording. Draw
   * releases never touch milestone tranche HELD/RELEASED state.
   */
  releaseDraw(draw: DrawRequest, amount: number, createdAt?: string): Promise<DrawAccountEvent>;
  /** Aggregate held/released amounts for a project. */
  getProjectSummary(projectId: string): Promise<ProjectAccountSummary>;
}

export class MockVirtualAccountService implements VirtualAccountService {
  async holdTranche(milestone: Milestone, createdAt?: string): Promise<VirtualAccountEvent> {
    const event: VirtualAccountEvent = {
      id: repo.newId(),
      milestoneId: milestone.id,
      type: "HELD",
      amount: milestone.trancheAmount,
      createdAt: createdAt ?? new Date().toISOString(),
    };
    repo.insertAccountEvent(event);
    repo.updateMilestoneAccountStatus(milestone.id, "HELD");
    return event;
  }

  async releaseTranche(milestone: Milestone, createdAt?: string): Promise<VirtualAccountEvent> {
    const event: VirtualAccountEvent = {
      id: repo.newId(),
      milestoneId: milestone.id,
      type: "RELEASED",
      amount: milestone.trancheAmount,
      createdAt: createdAt ?? new Date().toISOString(),
    };
    repo.insertAccountEvent(event);
    repo.updateMilestoneAccountStatus(milestone.id, "RELEASED");
    return event;
  }

  async releaseDraw(draw: DrawRequest, amount: number, createdAt?: string): Promise<DrawAccountEvent> {
    if (repo.listDrawAccountEvents(draw.id).some((e) => e.type === "RELEASED")) {
      throw new Error(`Draw ${draw.drawNumber} already has a governed release transition`);
    }
    const event: DrawAccountEvent = {
      id: repo.newId(),
      drawRequestId: draw.id,
      type: "RELEASED",
      amount,
      createdAt: createdAt ?? new Date().toISOString(),
    };
    // UNIQUE(draw_request_id, type) backstops the check above at the DB
    // level — concurrent duplicates throw here rather than double-insert.
    repo.insertDrawAccountEvent(event);
    return event;
  }

  async getProjectSummary(projectId: string): Promise<ProjectAccountSummary> {
    const project = repo.getProject(projectId);
    const milestones = repo.listMilestones(projectId);
    const released = milestones
      .filter((m) => m.accountStatus === "RELEASED")
      .reduce((sum, m) => sum + m.trancheAmount, 0);
    return {
      totalBudget: project?.totalBudget ?? 0,
      released,
      held: (project?.totalBudget ?? 0) - released,
      events: repo.listAccountEventsForProject(projectId),
    };
  }
}

export const virtualAccountService: VirtualAccountService = new MockVirtualAccountService();
