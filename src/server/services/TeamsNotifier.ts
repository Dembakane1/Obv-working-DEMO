/**
 * TeamsNotifier — pushes governance events to the funder's collaboration
 * channel.
 *
 * TODO: production implementation posting an Adaptive Card to a Microsoft
 *       Teams incoming webhook (URL from Azure Key Vault). The mock writes
 *       to the in-app notifications feed and the server log instead, so the
 *       demo works with no external connectivity.
 */
import * as repo from "../db/repo";
import type { Notification } from "../../shared/types";

export interface TeamsNotifier {
  notify(type: string, message: string): Promise<Notification>;
}

export class MockTeamsNotifier implements TeamsNotifier {
  async notify(type: string, message: string): Promise<Notification> {
    const notification: Notification = {
      id: repo.newId(),
      type,
      message,
      createdAt: new Date().toISOString(),
    };
    repo.insertNotification(notification);
    console.log(`[TeamsNotifier mock] ${type}: ${message}`);
    return notification;
  }
}

export const teamsNotifier: TeamsNotifier = new MockTeamsNotifier();
