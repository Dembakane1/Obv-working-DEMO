/**
 * Pilot setup checklist — "is this lender ready to process its first
 * draw?" for organization administrators.
 *
 * DETERMINISTIC: every line derives from configuration and operational
 * records that already exist (the per-project readiness engine, the
 * email outbox, backup records, storage probes). It never changes
 * project governance, never writes, and contains no scores or guesses —
 * each item is ok/not-ok with the record that says so.
 */
import * as repo from "../../db/repo";
import * as lrepo from "../../db/lenderRepo";
import * as integrationsRepo from "../../db/integrationsRepo";
import { integrationsConfig } from "../integrations/core";
import { resolveEmailProvider } from "../integrations/email";
import { identityConfig } from "../identity/core";
import { evaluateReadiness } from "../pilot/onboarding";
import { hoursSinceLastBackup, latestVerifiedBackup } from "./backups";
import { storagePosture } from "./storage";
import { environmentName, productionPosture } from "../posture";
import type { User } from "../../../shared/types";

export interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface PilotChecklist {
  environment: string;
  ready: boolean;
  items: ChecklistItem[];
  /** Per-project readiness summaries from the existing engine. */
  projects: { projectId: string; name: string; ready: boolean; failing: string[] }[];
}

export function pilotSetupChecklist(user: User): PilotChecklist {
  const items: ChecklistItem[] = [];
  const add = (key: string, label: string, ok: boolean, detail: string) =>
    items.push({ key, label, ok, detail });

  // Organization + people (scoped to the caller's organization).
  const org = repo.getOrganization(user.organizationId);
  add("org", "Organization configured", Boolean(org), org ? org.name : "No organization record");
  const orgUsers = repo.listUsers().filter((u) => u.organizationId === user.organizationId);
  const reviewers = orgUsers.filter((u) => u.role === "FUNDER_REP" || u.role === "COMPLIANCE_REVIEWER");
  add(
    "reviewers",
    "At least one lender reviewer",
    reviewers.length > 0,
    reviewers.length ? reviewers.map((r) => r.name).join(", ") : "No FUNDER_REP or COMPLIANCE_REVIEWER users yet"
  );

  // Projects: reuse the deterministic per-project readiness engine.
  const projects = repo
    .listProjects()
    .filter((p) => p.organizationId === user.organizationId && p.pilot)
    .map((p) => {
      const r = evaluateReadiness(p.id);
      return {
        projectId: p.id,
        name: p.name,
        ready: r.ready,
        failing: r.checks.filter((c) => !c.ok && !c.optional).map((c) => c.label),
      };
    });
  add(
    "project",
    "Pilot project created and configured",
    projects.length > 0 && projects.some((p) => p.ready),
    projects.length === 0
      ? "No pilot project yet — create one from Setup"
      : projects.some((p) => p.ready)
        ? `${projects.filter((p) => p.ready).length}/${projects.length} project(s) fully configured`
        : `configuration incomplete: ${projects[0].failing.slice(0, 3).join("; ")}`
  );

  // Notification email operational.
  let emailOk = false;
  let emailDetail: string;
  try {
    integrationsConfig();
    identityConfig();
    const provider = resolveEmailProvider();
    emailOk = productionPosture() ? provider.name !== "outbox" : true;
    emailDetail = productionPosture()
      ? emailOk
        ? `${provider.name} configured`
        : "development outbox active — configure OBV_EMAIL_PROVIDER=postmark"
      : `${provider.name} (demo)`;
  } catch (e) {
    emailDetail = (e as Error).message.slice(0, 160);
  }
  add("email", "Notification email provider operational", emailOk, emailDetail);

  const delivered = integrationsRepo
    .listEmails({ status: "SENT", limit: 1 });
  add(
    "test-notification",
    "At least one notification delivered",
    delivered.length > 0,
    delivered.length ? `latest ${delivered[0].kind} at ${delivered[0].sentAt}` : "No delivered email yet — use the integrations test send"
  );

  // Operations.
  const latest = latestVerifiedBackup();
  const hours = hoursSinceLastBackup();
  add(
    "backup",
    "Backup verified recently",
    Boolean(latest) && hours <= 26,
    latest ? `verified backup ${latest.createdAt} (${hours.toFixed(1)}h ago)` : "No verified backup — run npm run backup"
  );
  const sp = storagePosture();
  const storageOk = sp.roots.every((r) => r.writable) && (!productionPosture() || sp.dataDirExplicit);
  add(
    "storage",
    "Production storage healthy",
    storageOk,
    storageOk ? `data root ${sp.dataDir}` : "storage roots unwritable or OBV_DATA_DIR unset"
  );

  return {
    environment: environmentName(),
    ready: items.every((i) => i.ok),
    items,
    projects,
  };
}
