/**
 * Integrations dashboard — configured providers, connection status, last
 * sync, failures, retry queue, provider health. NO SECRETS: every value
 * rendered here comes from the secret-free dashboard view models.
 */
import { h, Fragment, renderDocument } from "./jsx";
import { AppShell, NavContext, PageHeader, enumLabel } from "./components";
import type { IntegrationsDashboard } from "../services/integrations";
import type {
  CalendarEvent,
  EsignRequest,
  WebhookDelivery,
  WebhookEndpoint,
} from "../../shared/types";

export interface IntegrationsPageInput {
  nav: NavContext;
  dashboard: IntegrationsDashboard;
  calendar: CalendarEvent[];
  esign: EsignRequest[];
  endpoints: Array<Omit<WebhookEndpoint, "secret">>;
  deliveries: WebhookDelivery[];
  permitDeadlines: Array<{ projectName: string; permitNumber: string; expiresAt: string }>;
  canManage: boolean;
}

const STATUS_TONE: Record<string, string> = {
  ACTIVE: "ok",
  CONFIGURED: "ok",
  DISABLED_BOUNDARY: "neutral",
  NOT_CONFIGURED: "warn",
  DELIVERED: "ok",
  QUEUED: "warn",
  RETRY: "warn",
  DEAD_LETTER: "bad",
  PENDING: "warn",
  SIGNED: "ok",
  DECLINED: "bad",
  EXPIRED: "neutral",
  CANCELLED: "neutral",
  SCHEDULED: "warn",
  COMPLETED: "ok",
  SUCCESS: "ok",
  FAILURE: "bad",
};

function when(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(0, 16) : "—";
}

function chip(value: string) {
  return <span className={`chip ${STATUS_TONE[value] ?? "neutral"}`}>{enumLabel(value)}</span>;
}

export function renderIntegrations(input: IntegrationsPageInput): string {
  const d = input.dashboard;
  return renderDocument(
    <AppShell title="Integrations" nav={input.nav} context="Integrations">
      <PageHeader
        title="Integrations"
        sub="Provider-neutral connections to the systems a lender already runs. External vendor adapters are disabled boundaries until production credentials exist; nothing here can alter verified records."
      />

      <section className="int-grid">
        {d.providers.map((p) => (
          <div className="int-card">
            <div className="int-card-head">
              <b>{p.displayName}</b>
              {chip(p.status)}
            </div>
            <div className="int-card-cat">{enumLabel(p.category)}</div>
            <p className="sub">{p.detail}</p>
            {p.alternatives.length > 0 ? (
              <p className="sub int-alt">Ready for: {p.alternatives.join(", ")}</p>
            ) : null}
          </div>
        ))}
      </section>

      <section className="int-stats">
        <div className="int-stat">
          <b>{String(d.email.sent)}</b>
          <span>Emails sent</span>
          <span className="sub">{d.email.failed} failed · {d.email.queued} queued</span>
        </div>
        <div className="int-stat">
          <b>{String(d.webhooks.delivered)}</b>
          <span>Webhooks delivered</span>
          <span className="sub">
            {d.webhooks.queued + d.webhooks.retry} in retry queue · {d.webhooks.deadLetter} dead-lettered
          </span>
        </div>
        <div className="int-stat">
          <b>{d.lastAccountingSync ? enumLabel(d.lastAccountingSync.status) : "Never"}</b>
          <span>Last accounting sync</span>
          <span className="sub">
            {d.lastAccountingSync ? `${d.lastAccountingSync.provider} · ${when(d.lastAccountingSync.startedAt)}` : "Run an export to begin"}
          </span>
        </div>
        <div className="int-stat">
          <b>{String(d.failures.length)}</b>
          <span>Recent failures</span>
          <span className="sub">{d.failures.length === 0 ? "No failures recorded" : "See the log below"}</span>
        </div>
      </section>

      <section className="int-card">
        <h2>Scheduling</h2>
        <table className="int-table">
          <thead><tr><th>When</th><th>Event</th><th>Kind</th><th>Status</th></tr></thead>
          <tbody>
            {input.calendar.length === 0 ? (
              <tr><td colspan="4" className="sub">Nothing scheduled. Inspections, draw reviews, meetings, and permit deadlines appear here; every event exports as ICS for Outlook or any calendar.</td></tr>
            ) : (
              input.calendar.slice(0, 12).map((e) => (
                <tr>
                  <td>{when(e.startsAt)}</td>
                  <td><b>{e.title}</b></td>
                  <td>{enumLabel(e.kind)}</td>
                  <td>{chip(e.status)}{" "}
                    <a className="btn ghost sm" href={`/api/integrations/calendar/${e.id}.ics`}>ICS</a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {input.permitDeadlines.length > 0 ? (
          <p className="sub int-alt">
            {String(input.permitDeadlines.length)} permit deadline(s) not yet scheduled — first:{" "}
            {input.permitDeadlines[0].permitNumber} ({input.permitDeadlines[0].projectName}) expires{" "}
            {when(input.permitDeadlines[0].expiresAt)}.
          </p>
        ) : null}
      </section>

      <section className="int-card">
        <h2>E-signature requests</h2>
        <table className="int-table">
          <thead><tr><th>Title</th><th>Signer</th><th>Kind</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>
            {input.esign.length === 0 ? (
              <tr><td colspan="5" className="sub">No signature requests. Contractor agreements, lien waivers, acknowledgements, and completion certificates are tracked here with a full audit trail.</td></tr>
            ) : (
              input.esign.slice(0, 12).map((r) => (
                <tr>
                  <td><b>{r.title}</b></td>
                  <td>{r.signerName}</td>
                  <td>{enumLabel(r.kind)}</td>
                  <td>{chip(r.status)}</td>
                  <td>{when(r.updatedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      <section className="int-card">
        <h2>Webhook endpoints</h2>
        <table className="int-table">
          <thead><tr><th>URL</th><th>Events</th><th>Active</th><th>Registered</th></tr></thead>
          <tbody>
            {input.endpoints.length === 0 ? (
              <tr><td colspan="4" className="sub">No endpoints registered. Deliveries are HMAC-signed with replay-bounded timestamps, idempotent per event, retried with backoff, and dead-lettered after repeated failure.</td></tr>
            ) : (
              input.endpoints.map((e) => (
                <tr>
                  <td><b>{e.url}</b></td>
                  <td>{e.events.join(", ")}</td>
                  <td>{chip(e.active ? "ACTIVE" : "NOT_CONFIGURED")}</td>
                  <td>{when(e.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {input.deliveries.length > 0 ? (
          <table className="int-table" style="margin-top:10px">
            <thead><tr><th>Delivery</th><th>Event</th><th>Status</th><th>Attempts</th><th>Last error</th></tr></thead>
            <tbody>
              {input.deliveries.slice(0, 10).map((dl) => (
                <tr>
                  <td className="sub">{dl.id.slice(0, 8)}…</td>
                  <td>{dl.eventKind}</td>
                  <td>{chip(dl.status)}</td>
                  <td>{String(dl.attemptCount)}</td>
                  <td className="sub">{dl.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section className="int-card">
        <h2>Integration audit</h2>
        <p className="sub">Append-only: provider, operation, actor, organization, request id, outcome.</p>
        <table className="int-table">
          <thead><tr><th>When</th><th>Category</th><th>Operation</th><th>Provider</th><th>Outcome</th></tr></thead>
          <tbody>
            {d.lastEvents.length === 0 ? (
              <tr><td colspan="5" className="sub">No integration activity yet.</td></tr>
            ) : (
              d.lastEvents.slice(0, 15).map((e) => (
                <tr>
                  <td>{when(e.occurredAt)}</td>
                  <td>{enumLabel(e.category)}</td>
                  <td>{e.operation}</td>
                  <td>{e.provider}</td>
                  <td>{chip(e.outcome)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {input.canManage ? (
        <section className="int-card">
          <h2>Administrator actions</h2>
          <div className="int-actions">
            <form method="POST" action="/api/integrations/accounting/export">
              <button className="btn secondary sm" type="submit">Run Accounting Export</button>
            </form>
            <form method="POST" action="/api/integrations/webhooks/dispatch">
              <button className="btn ghost sm" type="submit">Dispatch Webhook Queue</button>
            </form>
            <form method="POST" action="/api/integrations/email/test" className="int-inline">
              <input name="to" type="email" required placeholder="test@yourdomain.example" />
              <button className="btn ghost sm" type="submit">Send Test Email</button>
            </form>
          </div>
        </section>
      ) : null}
    </AppShell>
  );
}
