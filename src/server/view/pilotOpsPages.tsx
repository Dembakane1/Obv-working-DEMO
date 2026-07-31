/** Pilot Readiness pages: onboarding wizard, organization administration,
 *  notification center, feedback portal, internal operator console, and
 *  the maintenance page. Same design language as the rest of OBV. */
import { h, Fragment, renderDocument, raw, VNode } from "./jsx";
import {
  AppShell,
  EmptyStateV2,
  MetricStrip,
  NavContext,
  PageHeader,
  SectionHead,
  enumLabel,
  fmtDate,
  money,
} from "./components";
import { icons } from "./icons";
import type * as pilotOps from "../services/pilotOps";
import type {
  AccountingConnection,
  AccountingRun,
  BackupRecord,
  EsignRequest,
  FeedbackItem,
  RecoveryTest,
  SystemBanner,
} from "../db/pilotOpsRepo";

type Notice = { kind: "ok" | "err"; text: string } | null;

const noticeBanner = (notice: Notice): VNode | null =>
  notice ? <div className={`banner ${notice.kind === "ok" ? "ok" : "warn"}`}>{notice.text}</div> : null;

function statusChip(ok: boolean, okLabel: string, badLabel: string): VNode {
  return ok ? (
    <span className="status ok"><span className="g">✓</span>{okLabel}</span>
  ) : (
    <span className="status warn"><span className="g">○</span>{badLabel}</span>
  );
}

// ------------------------------------------------------------ onboarding

export function renderOnboardingWizard(input: {
  nav: NavContext;
  status: ReturnType<typeof pilotOps.onboarding.onboardingStatus>;
  notice: Notice;
}): string {
  const { status } = input;
  const settings = status.settings;
  return renderDocument(
    <AppShell title="Onboarding" nav={input.nav} context="Guided organization setup">
      <div className="page-wrap">
        <PageHeader
          title="Organization onboarding"
          sub="A guided setup for pilot organizations: profile, branding, settings, team and portfolio."
          asOf={`${status.completedCount} of ${status.totalSteps} steps complete`}
        />
        {noticeBanner(input.notice)}
        <MetricStrip
          metrics={[
            { value: `${status.completedCount}/${status.totalSteps}`, label: "Steps complete" },
            {
              value: status.complete ? "Complete" : "In progress",
              label: "Onboarding",
              tone: status.complete ? "ok" : undefined,
            },
            { value: settings?.timezone ?? "—", label: "Time zone", dim: !settings?.timezone },
          ]}
        />

        <section className="panel">
          <div className="panel-head"><h3>Setup checklist</h3><span className="hint">derived from real records — work done outside the wizard counts</span></div>
          <div className="queue">
            {status.steps.map((step) => (
              <div className="queue-row">
                <span className={`q-ico ${step.completed ? "ok" : ""}`} aria-hidden="true">
                  {step.completed ? icons.check() : icons.clock()}
                </span>
                <span className="q-body">
                  <span className="q-t">{step.title}</span>
                  <span className="q-s">{step.description}{step.derived ? " · detected from records" : ""}</span>
                </span>
                <span className="q-meta">
                  {step.completed ? (
                    statusChip(true, "Done", "")
                  ) : (
                    <form method="POST" action="/api/pilot-ops/onboarding/step" style="margin:0">
                      <input type="hidden" name="stepKey" value={step.key} />
                      <button className="btn secondary sm" type="submit" data-busy-label="Saving…">Mark complete</button>
                    </form>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>

        <div className="intel-duo">
          <section className="panel">
            <div className="panel-head"><h3>Company profile &amp; settings</h3></div>
            <div className="panel-pad">
              <form method="POST" action="/api/pilot-ops/org-settings" className="po-form">
                <label>Display name<input name="displayName" value={settings?.displayName ?? ""} /></label>
                <label>Legal name<input name="legalName" value={settings?.legalName ?? ""} /></label>
                <label>Website<input name="website" value={settings?.website ?? ""} placeholder="https://…" /></label>
                <label>Phone<input name="phone" value={settings?.phone ?? ""} /></label>
                <label>Time zone
                  <select name="timezone">
                    {["", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC"].map((tz) => (
                      <option value={tz} selected={tz === (settings?.timezone ?? "")}>{tz || "Select…"}</option>
                    ))}
                  </select>
                </label>
                <label>Brand color<input name="brandColor" value={settings?.brandColor ?? ""} placeholder="#0B1323" /></label>
                <label>Default notifications
                  <select name="defaultNotificationChannel">
                    {["IN_APP", "EMAIL", "BOTH"].map((channel) => (
                      <option value={channel} selected={channel === (settings?.defaultNotificationChannel ?? "IN_APP")}>
                        {enumLabel(channel)}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn" type="submit" data-busy-label="Saving…">Save settings</button>
              </form>
              <p className="t-quiet po-note">
                Logo upload: POST a PNG/JPEG data URL to /api/pilot-ops/org-logo (≤512 KB).
                {settings?.logoPath ? " A logo is on file." : " No logo uploaded yet."}
              </p>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h3>Next actions</h3></div>
            <div className="panel-pad">
              <ul className="tl">
                <li><span className="tl-t"><a href="/setup">Invite teammates and create projects</a></span><span className="tl-m">Invitations and draft projects live in Pilot Setup.</span></li>
                <li><span className="tl-t"><a href="/admin">Review user administration</a></span><span className="tl-m">Roles, suspension, MFA readiness and sign-in history.</span></li>
                <li><span className="tl-t"><a href="/notifications">Set notification preferences</a></span><span className="tl-m">In-app, email and digest choices per user.</span></li>
              </ul>
            </div>
          </section>
        </div>
        <p className="footer-note">Onboarding state is additive configuration; it never changes verification, approvals, or any governed record.</p>
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------------------- org admin

export function renderOrgAdmin(input: {
  nav: NavContext;
  directory: ReturnType<typeof pilotOps.userAdmin.userDirectory>;
  matrix: typeof pilotOps.userAdmin.PERMISSION_MATRIX;
  analytics: ReturnType<typeof pilotOps.success.pilotAnalytics>;
  esign: EsignRequest[];
  accounting: { connections: AccountingConnection[]; runs: AccountingRun[] };
  notice: Notice;
}): string {
  const { directory, analytics } = input;
  return renderDocument(
    <AppShell title="Administration" nav={input.nav} context="Organization administration">
      <div className="page-wrap">
        <PageHeader
          title="Organization administration"
          sub="Users, invitations, permissions, adoption analytics and integrations for your organization."
        >
          <a className="btn ghost" href="/onboarding">Onboarding wizard</a>
        </PageHeader>
        {noticeBanner(input.notice)}
        <MetricStrip
          metrics={[
            { value: String(directory.users.length), label: "Users" },
            { value: String(directory.users.filter((entry) => entry.status === "SUSPENDED").length), label: "Suspended", dim: true },
            { value: String(directory.invitations.filter((inv) => inv.status === "PENDING").length), label: "Pending invitations", dim: true },
            { value: String(analytics.activeUsers.weekly), label: "Weekly active users" },
            { value: analytics.timeToApprovalDays === null ? "—" : `${analytics.timeToApprovalDays}d`, label: "Avg approval time" },
          ]}
        />

        <SectionHead title="User directory" hint="suspension takes effect on the user's next request; every action is audited" />
        <div className="register">
          <div className="reg-scroll">
            <table className="reg">
              <thead>
                <tr>
                  <th>User</th><th>Role</th><th>Status</th><th>MFA ready</th><th>Last sign-in</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {directory.users.map((entry) => (
                  <tr>
                    <td className="p">{entry.user.name}<span className="s">{entry.user.title}</span></td>
                    <td className="s">{enumLabel(entry.user.role)}</td>
                    <td>{entry.status === "ACTIVE" ? statusChip(true, "Active", "") : <span className="status bad"><span className="g">✕</span>Suspended</span>}</td>
                    <td>{statusChip(entry.mfaReady, "Ready", "Not set up")}</td>
                    <td className="s">{entry.lastSignInAt ? fmtDate(entry.lastSignInAt).slice(0, 16) : "—"}</td>
                    <td>
                      <span style="display:flex;gap:6px;flex-wrap:wrap">
                        {entry.status === "ACTIVE" ? (
                          <form method="POST" action={`/api/pilot-ops/users/${entry.user.id}/suspend`} style="margin:0">
                            <input type="hidden" name="reason" value="Suspended by administrator" />
                            <button className="btn danger sm" type="submit" data-busy-label="Suspending…">Suspend</button>
                          </form>
                        ) : (
                          <form method="POST" action={`/api/pilot-ops/users/${entry.user.id}/restore`} style="margin:0">
                            <button className="btn secondary sm" type="submit" data-busy-label="Restoring…">Restore</button>
                          </form>
                        )}
                        <form method="POST" action={`/api/pilot-ops/users/${entry.user.id}/mfa`} style="margin:0">
                          <input type="hidden" name="ready" value={entry.mfaReady ? "" : "1"} />
                          <button className="btn ghost sm" type="submit" data-busy-label="Saving…">
                            {entry.mfaReady ? "Clear MFA" : "Mark MFA ready"}
                          </button>
                        </form>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <SectionHead title="Invitations" hint="create and accept invitations in Pilot Setup; resend/revoke there too" />
        {directory.invitations.length === 0 ? (
          <EmptyStateV2 icon={icons.user()} title="No invitations" what="Invite teammates from Pilot Setup — activation links are one-time and expire." condition="unconfigured" />
        ) : (
          <div className="register">
            <div className="reg-scroll">
              <table className="reg">
                <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th></tr></thead>
                <tbody>
                  {input.directory.invitations.map((inv) => (
                    <tr>
                      <td className="p">{inv.email}</td>
                      <td className="s">{enumLabel(inv.role)}</td>
                      <td className="s">{enumLabel(inv.status)}</td>
                      <td className="s">{inv.expiresAt.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="intel-duo">
          <section className="panel">
            <div className="panel-head"><h3>Permission matrix</h3><span className="hint">descriptive — enforcement lives in the services</span></div>
            <div className="panel-pad">
              <div className="table-scroll">
                <table className="data">
                  <thead><tr><th>Area</th><th>Funder rep</th><th>Project manager</th><th>Compliance</th><th>Field</th></tr></thead>
                  <tbody>
                    {input.matrix.map((row) => (
                      <tr>
                        <td>{row.area}</td>
                        <td className="s">{row.FUNDER_REP}</td>
                        <td className="s">{row.PROJECT_MANAGER}</td>
                        <td className="s">{row.COMPLIANCE_REVIEWER}</td>
                        <td className="s">{row.FIELD}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h3>Pilot adoption</h3><span className="hint">{analytics.usageTrackingEnabled ? "usage tracking on" : "usage tracking off (OBV_USAGE_ANALYTICS)"}</span></div>
            <div className="panel-pad">
              <div className="iv-stats">
                <div className="iv-cell"><span className="n num">{analytics.activeUsers.daily}</span><span className="l">DAU</span></div>
                <div className="iv-cell"><span className="n num">{analytics.activeUsers.weekly}</span><span className="l">WAU</span></div>
                <div className="iv-cell"><span className="n num">{analytics.timeToFirstDrawDays ?? "—"}</span><span className="l">Days to first draw</span></div>
                <div className="iv-cell"><span className="n num">{analytics.notificationEngagement.readReceipts}</span><span className="l">Read receipts</span></div>
              </div>
              <ul className="tl">
                {analytics.featureAdoption.map((feature) => (
                  <li className={feature.used ? "ok" : ""}>
                    <span className="tl-t">{feature.feature}</span>
                    <span className="tl-m">{feature.used ? "Adopted" : "Not used yet"}</span>
                  </li>
                ))}
              </ul>
              {analytics.abandonedWorkflows.map((workflow) => (
                <p className="t-quiet">{workflow.workflow}: <b className="num">{workflow.count}</b> — {workflow.note}</p>
              ))}
            </div>
          </section>
        </div>

        <div className="intel-duo">
          <section className="panel">
            <div className="panel-head"><h3>E-signature requests</h3><span className="hint">provider-neutral · MOCK adapter installed</span></div>
            <div className="panel-pad">
              <form method="POST" action="/api/pilot-ops/esign" className="po-form po-inline">
                <label>Title<input name="title" placeholder="Draw certification" /></label>
                <label>Signer name<input name="signerName" /></label>
                <label>Signer email<input name="signerEmail" placeholder="name@example.com" /></label>
                <button className="btn sm" type="submit" data-busy-label="Creating…">Create request</button>
              </form>
              {input.esign.length === 0 ? (
                <p className="t-quiet">No signature requests yet.</p>
              ) : (
                <div className="table-scroll">
                  <table className="data">
                    <thead><tr><th>Title</th><th>Signer</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      {input.esign.slice(0, 8).map((request) => (
                        <tr>
                          <td>{request.title}</td>
                          <td className="s">{request.signerName}</td>
                          <td className="s">{enumLabel(request.status)}</td>
                          <td>
                            {request.status === "DRAFT" ? (
                              <form method="POST" action={`/api/pilot-ops/esign/${request.id}/send`} style="margin:0">
                                <button className="btn secondary sm" type="submit" data-busy-label="Sending…">Send</button>
                              </form>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h3>Accounting integration</h3><span className="hint">exports are normalized CSV; imports stage only</span></div>
            <div className="panel-pad">
              <form method="POST" action="/api/pilot-ops/accounting/export" className="po-form po-inline">
                <label>Provider
                  <select name="provider">
                    {input.accounting.connections.map((connection) => (
                      <option value={connection.provider}>{enumLabel(connection.provider)}</option>
                    ))}
                  </select>
                </label>
                <label>Dataset
                  <select name="dataset">
                    {["PROJECTS", "BUDGETS", "INVOICES", "PAYMENTS", "CONTRACTORS"].map((dataset) => (
                      <option value={dataset}>{enumLabel(dataset)}</option>
                    ))}
                  </select>
                </label>
                <button className="btn sm" type="submit" data-busy-label="Exporting…">Export</button>
              </form>
              {input.accounting.runs.length === 0 ? (
                <p className="t-quiet">No export/import runs yet.</p>
              ) : (
                <ul className="tl">
                  {input.accounting.runs.map((run) => (
                    <li className="ok">
                      <span className="tl-t">{enumLabel(run.direction)} · {enumLabel(run.dataset)} · {run.rowCount} rows</span>
                      <span className="tl-m">{fmtDate(run.createdAt).slice(0, 16)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="t-quiet po-note">Accounting integrations can never modify verified evidence or any governed record — imports land in a staging register for human review.</p>
            </div>
          </section>
        </div>
        <p className="footer-note">Every administrative action on this page is appended to the platform audit trail.</p>
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ---------------------------------------------------- notification center

export function renderNotificationCenter(input: {
  nav: NavContext;
  feed: ReturnType<typeof pilotOps.notifications.notificationFeed>;
  prefs: ReturnType<typeof pilotOps.notifications.preferences>;
  notice: Notice;
}): string {
  const { feed, prefs } = input;
  return renderDocument(
    <AppShell title="Notifications" nav={input.nav} context="Notification center">
      <div className="page-wrap">
        <PageHeader
          title="Notifications"
          sub="A single feed derived from your accessible records — draws, inspections, permits, risk and fraud intelligence."
          asOf={`${feed.unread} unread`}
        >
          <form method="POST" action="/api/pilot-ops/notifications/read-all" style="display:inline">
            <button className="btn secondary" type="submit" data-busy-label="Marking…">Mark all read</button>
          </form>
          <form method="POST" action="/api/pilot-ops/digest" style="display:inline">
            <input type="hidden" name="period" value="WEEKLY" />
            <button className="btn ghost" type="submit" data-busy-label="Composing…">Send weekly digest</button>
          </form>
        </PageHeader>
        {noticeBanner(input.notice)}

        <div className="work-grid">
          <div>
            {feed.items.length === 0 ? (
              <EmptyStateV2 icon={icons.activity()} title="No notifications" what="Activity on your accessible projects will appear here." condition="healthy" />
            ) : (
              <section className="panel">
                <div className="queue">
                  {feed.items.map((item) => (
                    <div className={`queue-row ${item.read ? "po-read" : ""}`}>
                      <span className={`q-ico ${item.type === "FRAUD_ALERT" || item.type === "RISK_ALERT" ? "warn" : ""}`} aria-hidden="true">
                        {item.type.startsWith("DRAW") ? icons.dollar() : item.type.startsWith("INSPECTION") ? icons.check() : icons.activity()}
                      </span>
                      <span className="q-body">
                        <span className="q-t">{item.href ? <a href={item.href}>{item.title}</a> : item.title}</span>
                        <span className="q-s">{item.body}</span>
                      </span>
                      <span className="q-meta">
                        <span className="t-meta">{fmtDate(item.at).slice(0, 16)}</span>
                        {!item.read ? (
                          <form method="POST" action="/api/pilot-ops/notifications/read" style="margin:0">
                            <input type="hidden" name="key" value={item.key} />
                            <button className="btn ghost sm" type="submit" data-busy-label="…">Mark read</button>
                          </form>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
          <aside>
            <section className="panel">
              <div className="panel-head"><h3>Preferences</h3></div>
              <div className="panel-pad">
                <form method="POST" action="/api/pilot-ops/notification-prefs" className="po-form">
                  {(
                    [
                      ["inApp", "In-app notifications", prefs.inApp],
                      ["email", "Email notifications", prefs.email],
                      ["dailyDigest", "Daily digest", prefs.dailyDigest],
                      ["weeklyDigest", "Weekly digest", prefs.weeklyDigest],
                    ] as [string, string, boolean][]
                  ).map(([name, label, value]) => (
                    <label className="po-check">
                      <input type="checkbox" name={name} value="1" checked={value} />
                      {label}
                    </label>
                  ))}
                  <label>Muted types<input name="mutedTypes" value={prefs.mutedTypes.join(",")} placeholder="SYSTEM,PERMIT_ISSUE" /></label>
                  <button className="btn sm" type="submit" data-busy-label="Saving…">Save preferences</button>
                </form>
                <p className="t-quiet po-note">Unchecked boxes are submitted as off. Digests use the transactional email outbox (log provider by default — nothing leaves the machine in demo mode).</p>
              </div>
            </section>
          </aside>
        </div>
        <p className="footer-note">The feed is derived from governed records; marking items read never changes any business state.</p>
      </div>
      <script src="/js/poll.js" defer></script>
      <script>{raw(
        `document.querySelectorAll('.po-check input[type=checkbox]').forEach(function (box) {
           var hidden = document.createElement('input');
           hidden.type = 'hidden'; hidden.name = box.name; hidden.value = '0';
           box.parentElement.insertBefore(hidden, box);
           box.addEventListener('change', function () { hidden.value = box.checked ? '1' : '0'; box.value='1'; });
           hidden.value = box.checked ? '1' : '0'; box.removeAttribute('name');
         });`
      )}</script>
    </AppShell>
  );
}

// ------------------------------------------------------------- feedback

export function renderFeedbackPortal(input: {
  nav: NavContext;
  feedback: FeedbackItem[];
  notice: Notice;
}): string {
  return renderDocument(
    <AppShell title="Feedback" nav={input.nav} context="Feedback portal">
      <div className="page-wrap">
        <PageHeader
          title="Feedback"
          sub="Report bugs, request features, and flag workflow pain points. Responses appear here."
        />
        {noticeBanner(input.notice)}
        <div className="work-grid">
          <div>
            {input.feedback.length === 0 ? (
              <EmptyStateV2 icon={icons.chat()} title="No feedback yet" what="Your organization's submissions and our responses will appear here." condition="unconfigured" />
            ) : (
              <div className="register">
                <div className="reg-scroll">
                  <table className="reg">
                    <thead><tr><th>Title</th><th>Kind</th><th>Severity</th><th>Status</th><th>Submitted</th></tr></thead>
                    <tbody>
                      {input.feedback.map((item) => (
                        <tr>
                          <td className="p">{item.title}<span className="s">{item.body.slice(0, 90)}{item.body.length > 90 ? "…" : ""}</span></td>
                          <td className="s">{enumLabel(item.kind)}</td>
                          <td className="s">{enumLabel(item.severity)}</td>
                          <td>{["RESOLVED", "CLOSED"].includes(item.status) ? statusChip(true, enumLabel(item.status), "") : <span className="status info"><span className="g">◔</span>{enumLabel(item.status)}</span>}</td>
                          <td className="s">{item.createdAt.slice(0, 10)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
          <aside>
            <section className="panel">
              <div className="panel-head"><h3>Submit feedback</h3></div>
              <div className="panel-pad">
                <form method="POST" action="/api/pilot-ops/feedback" className="po-form">
                  <label>Kind
                    <select name="kind">
                      {["BUG", "FEATURE", "IMPROVEMENT", "PAIN_POINT"].map((kind) => (
                        <option value={kind}>{enumLabel(kind)}</option>
                      ))}
                    </select>
                  </label>
                  <label>Severity
                    <select name="severity">
                      {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((severity) => (
                        <option value={severity} selected={severity === "MEDIUM"}>{enumLabel(severity)}</option>
                      ))}
                    </select>
                  </label>
                  <label>Title<input name="title" required /></label>
                  <label>Description<textarea name="body" rows="5" required></textarea></label>
                  <label>Page (optional)<input name="pagePath" placeholder="/draws" /></label>
                  <button className="btn" type="submit" data-busy-label="Submitting…">Submit</button>
                </form>
              </div>
            </section>
          </aside>
        </div>
        <p className="footer-note">Feedback is org-scoped: other organizations never see your submissions, and internal triage notes are never shown to customers.</p>
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ------------------------------------------------------ internal console

export function renderInternalConsole(input: {
  nav: NavContext;
  workspace: ReturnType<typeof pilotOps.success.csWorkspace>;
  ops: ReturnType<typeof pilotOps.operations.opsDashboard>;
  backups: { backups: BackupRecord[]; recoveryTests: RecoveryTest[]; retentionDays: number };
  config: ReturnType<typeof pilotOps.operations.productionConfig>;
  feedback: FeedbackItem[];
  demoDataExists: boolean;
  notice: Notice;
}): string {
  const { ops, config } = input;
  const mb = (bytes: number): string => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  return renderDocument(
    <AppShell title="Internal console" nav={input.nav} context="Operator console (internal)">
      <div className="page-wrap">
        <PageHeader
          title="Internal operator console"
          sub="Customer success, operations, backups and production configuration. Never visible to lender users."
          asOf={`Deploy ${config.deployVersion} · Node ${ops.application.nodeVersion}`}
        />
        {noticeBanner(input.notice)}
        <MetricStrip
          metrics={[
            { value: String(input.workspace.length), label: "Organizations" },
            { value: ops.database.quickCheck === "ok" ? "OK" : "Attention", label: "Database", tone: ops.database.quickCheck === "ok" ? "ok" : "bad" },
            { value: ops.apiPerformance.averageMs === null ? "—" : `${ops.apiPerformance.averageMs}ms`, label: "Avg response" },
            { value: String(ops.failedJobs.failedEmails + ops.failedJobs.failedBackups), label: "Failed jobs", dim: ops.failedJobs.failedEmails + ops.failedJobs.failedBackups === 0 },
            { value: String(ops.auditActivity.last24h), label: "Audit events (24h)" },
          ]}
        />

        <SectionHead title="Customer success" hint="pilot status, go-live, health and renewal — internal only" />
        <div className="register">
          <div className="reg-scroll">
            <table className="reg">
              <thead>
                <tr><th>Organization</th><th>Pilot status</th><th>Go-live</th><th>Manager</th><th>Health</th><th>Renewal %</th><th>Onboarding</th><th>Open feedback</th></tr>
              </thead>
              <tbody>
                {input.workspace.map((row) => (
                  <tr>
                    <td className="p">{row.organizationName}<span className="s">{row.userCount} users · {row.projectCount} projects</span></td>
                    <td className="s">{enumLabel(row.account.pilotStatus)}</td>
                    <td className="s">{row.account.goLiveDate ?? "—"}</td>
                    <td className="s">{row.account.successManager ?? "—"}</td>
                    <td className="r num">{row.account.healthScore ?? row.suggestedHealthScore}</td>
                    <td className="r num">{row.account.renewalProbability ?? "—"}</td>
                    <td>{statusChip(row.onboardingComplete, "Complete", "In progress")}</td>
                    <td className="r num">{row.openFeedback}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="intel-duo">
          <section className="panel">
            <div className="panel-head"><h3>Operations</h3><span className="hint">in-memory monitoring · no sensitive data</span></div>
            <div className="panel-pad">
              <div className="iv-stats">
                <div className="iv-cell"><span className="n num">{ops.apiPerformance.samples}</span><span className="l">Samples</span></div>
                <div className="iv-cell"><span className="n num">{ops.apiPerformance.p95Ms ?? "—"}</span><span className="l">p95 ms</span></div>
                <div className="iv-cell"><span className="n num">{ops.emailQueue.SENT ?? 0}</span><span className="l">Emails sent</span></div>
                <div className="iv-cell"><span className="n num">{ops.emailQueue.FAILED ?? 0}</span><span className="l">Email failures</span></div>
              </div>
              <p className="t-quiet">Storage: {ops.storage.map((entry) => `${entry.name} ${mb(entry.sizeBytes)}`).join(" · ")}</p>
              {ops.recentErrors.length === 0 ? (
                <p className="t-quiet">No recent errors.</p>
              ) : (
                <ul className="tl">
                  {ops.recentErrors.slice(0, 6).map((error) => (
                    <li className="warn"><span className="tl-t">{error.status} on {error.path}</span><span className="tl-m">{error.message} · {fmtDate(error.at).slice(0, 16)}</span></li>
                  ))}
                </ul>
              )}
              <p className="t-quiet">Background jobs: {ops.backgroundJobs.map((job) => `${job.name} (${enumLabel(job.state)})`).join(" · ")}</p>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h3>Backups &amp; recovery</h3><span className="hint">retention {input.backups.retentionDays} days · no automatic restore</span></div>
            <div className="panel-pad">
              <form method="POST" action="/api/internal/backups" style="margin:0 0 10px">
                <button className="btn sm" type="submit" data-busy-label="Backing up…">Create backup</button>
              </form>
              {input.backups.backups.length === 0 ? (
                <p className="t-quiet">No backups recorded yet.</p>
              ) : (
                <div className="table-scroll">
                  <table className="data">
                    <thead><tr><th>Taken</th><th>Size</th><th>Status</th><th>Verified</th><th></th></tr></thead>
                    <tbody>
                      {input.backups.backups.slice(0, 6).map((backup) => (
                        <tr>
                          <td className="s">{fmtDate(backup.takenAt).slice(0, 16)}</td>
                          <td className="s num">{mb(backup.sizeBytes)}</td>
                          <td>{statusChip(backup.status === "COMPLETED", "Completed", "Failed")}</td>
                          <td className="s">{backup.verifyStatus ? enumLabel(backup.verifyStatus) : "—"}</td>
                          <td>
                            <span style="display:flex;gap:6px">
                              <form method="POST" action={`/api/internal/backups/${backup.id}/verify`} style="margin:0">
                                <button className="btn ghost sm" type="submit" data-busy-label="…">Verify</button>
                              </form>
                              <form method="POST" action={`/api/internal/backups/${backup.id}/recovery-test`} style="margin:0">
                                <button className="btn ghost sm" type="submit" data-busy-label="…">Recovery test</button>
                              </form>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {input.backups.recoveryTests.length > 0 ? (
                <p className="t-quiet">Last recovery test: {enumLabel(input.backups.recoveryTests[0].outcome)} — {input.backups.recoveryTests[0].detail.slice(0, 80)}</p>
              ) : null}
            </div>
          </section>
        </div>

        <div className="intel-duo">
          <section className="panel">
            <div className="panel-head"><h3>Production configuration</h3><span className="hint">names + set/unset only — values are never displayed</span></div>
            <div className="panel-pad">
              <div className="table-scroll">
                <table className="data">
                  <thead><tr><th>Environment variable</th><th>State</th></tr></thead>
                  <tbody>
                    {config.environment.map((entry) => (
                      <tr><td className="s">{entry.name}</td><td>{statusChip(entry.set, "Set", "Unset")}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="t-quiet">Maintenance mode: {config.maintenance ? "ON" : "off"} · sign-in rate limit: {config.rateLimitPerMinute > 0 ? `${config.rateLimitPerMinute}/min` : "off"}</p>
              <form method="POST" action="/api/internal/flags" className="po-form po-inline">
                <label>Flag key<input name="key" placeholder="maintenance_mode" /></label>
                <label className="po-check"><input type="checkbox" name="enabled" value="1" />Enabled</label>
                <button className="btn sm" type="submit" data-busy-label="Saving…">Set flag</button>
              </form>
              {config.featureFlags.length > 0 ? (
                <ul className="tl">
                  {config.featureFlags.map((flagRow) => (
                    <li className={flagRow.enabled ? "ok" : ""}><span className="tl-t">{flagRow.key}</span><span className="tl-m">{flagRow.enabled ? "enabled" : "disabled"}{flagRow.description ? ` — ${flagRow.description}` : ""}</span></li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h3>System banners &amp; demo data</h3></div>
            <div className="panel-pad">
              <form method="POST" action="/api/internal/banners" className="po-form po-inline">
                <label>Message<input name="message" placeholder="Planned maintenance Saturday 02:00 UTC" /></label>
                <label>Level
                  <select name="level">
                    {["INFO", "WARN", "CRITICAL"].map((level) => (
                      <option value={level}>{enumLabel(level)}</option>
                    ))}
                  </select>
                </label>
                <button className="btn sm" type="submit" data-busy-label="Publishing…">Publish banner</button>
              </form>
              {config.banners.filter((banner) => banner.active).map((banner: SystemBanner) => (
                <div className="queue-row">
                  <span className="q-body"><span className="q-t">{banner.message}</span><span className="q-s">{enumLabel(banner.level)}</span></span>
                  <span className="q-meta">
                    <form method="POST" action={`/api/internal/banners/${banner.id}/remove`} style="margin:0">
                      <button className="btn ghost sm" type="submit" data-busy-label="…">Remove</button>
                    </form>
                  </span>
                </div>
              ))}
              <hr style="border:none;border-top:1px solid var(--line);margin:12px 0" />
              {input.demoDataExists ? (
                <p className="t-quiet">Demo data has been generated in this database (all records carry the DEMO prefix).</p>
              ) : (
                <form method="POST" action="/api/internal/demo-data" style="margin:0">
                  <button className="btn secondary sm" type="submit" data-busy-label="Generating…">Generate clearly-marked demo data</button>
                </form>
              )}
              <p className="t-quiet po-note">Open feedback across all organizations: {input.feedback.filter((item) => !["RESOLVED", "CLOSED"].includes(item.status)).length} — triage via /api/internal/feedback/:id/respond.</p>
            </div>
          </section>
        </div>
        <p className="footer-note">This console is internal-only: lender-side roles receive a 404 for every /internal and /api/internal surface.</p>
      </div>
      <script src="/js/poll.js" defer></script>
    </AppShell>
  );
}

// ---------------------------------------------------------- maintenance

export function renderMaintenancePage(): string {
  return renderDocument(
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Maintenance — OBV</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <div style="max-width:520px;margin:18vh auto 0;padding:0 20px;text-align:center">
          <h1 style="font-size:22px;margin-bottom:8px">Scheduled maintenance</h1>
          <p className="sub" style="color:var(--ink-3)">
            OpenBuild Verify is briefly offline for maintenance. Your records are safe and no
            governed state changes during maintenance. Please try again shortly.
          </p>
        </div>
      </body>
    </html>
  );
}
