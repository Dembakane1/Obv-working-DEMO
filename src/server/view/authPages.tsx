/**
 * Production identity views: sign-in, magic-link confirmation, and the
 * account security console (sessions, devices, memberships, history).
 *
 * These are standalone documents (no AppShell): sign-in and confirmation
 * have no session, and the security console deliberately renders without
 * project navigation so it works identically for every role.
 */
import { h, Fragment, renderDocument } from "./jsx";
import { STYLESHEET_HREF, enumLabel } from "./components";
import { brandMark } from "./icons";
import type {
  AuthEvent,
  AuthSession,
  Identity,
  IdentityMembership,
  Organization,
  User,
} from "../../shared/types";

function AuthDoc(props: { title: string; wide?: boolean; children?: unknown }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} — OBV</title>
        <link rel="stylesheet" href={STYLESHEET_HREF} />
        <link rel="icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#0d1626" />
      </head>
      <body>
        <div className="auth-wrap">
          <div className={props.wide ? "auth-box idp-wide" : "auth-box idp-narrow"}>
            <div className="auth-brand">
              <span className="mark">{brandMark(22)}</span>
              <span>
                <span className="name" style="display:block">OpenBuild Verify</span>
                <span className="tagline" style="display:block">The truth layer for physical projects</span>
              </span>
            </div>
            {props.children}
          </div>
        </div>
      </body>
    </html>
  );
}

// ================================================================ sign-in

export function renderSignIn(input: { sent: boolean; demoAvailable: boolean }): string {
  return renderDocument(
    <AuthDoc title="Sign in">
      {input.sent ? (
        <Fragment>
          <h1 style="font-size:16px;margin:14px 0 6px">Check your email</h1>
          <p className="sub" style="font-size:12.5px">
            If that email address belongs to an account, a sign-in link has been
            sent to it. The link works once and expires shortly.
          </p>
          <p className="sub" style="font-size:12px;margin-top:12px">
            <a href="/signin">Use a different address</a>
          </p>
        </Fragment>
      ) : (
        <Fragment>
          <h1 style="font-size:16px;margin:14px 0 4px">Sign in to OBV</h1>
          <p className="sub" style="font-size:12.5px;margin:0 0 14px">
            Enter your work email. We send a one-time sign-in link — no password.
          </p>
          <form method="POST" action="/api/auth/magic-link" className="fo-form">
            <label>Email address
              <input name="email" type="email" required maxlength="254" placeholder="you@organization.org" autocomplete="email" />
            </label>
            <button className="btn" type="submit">Email Me a Sign-In Link</button>
          </form>
          {input.demoAvailable ? (
            <p className="sub" style="font-size:11.5px;margin-top:14px">
              Exploring the demonstration? <a href="/demo">Use the seeded demo roles instead.</a>
            </p>
          ) : null}
        </Fragment>
      )}
    </AuthDoc>
  );
}

// ==================================================== link confirmation

/** The GET landing for a magic link. It never consumes the token — the
 *  explicit POST below does — so inbox link-scanners cannot burn it. */
export function renderAuthComplete(input: {
  token: string;
  usable: boolean;
  email: string | null;
}): string {
  return renderDocument(
    <AuthDoc title="Complete sign-in">
      {input.usable ? (
        <Fragment>
          <h1 style="font-size:16px;margin:14px 0 4px">Confirm sign-in</h1>
          <p className="sub" style="font-size:12.5px;margin:0 0 14px">
            Continue as <b>{input.email}</b>. This link works once.
          </p>
          <form method="POST" action="/api/auth/complete" className="fo-form">
            <input type="hidden" name="token" value={input.token} />
            <label className="idp-check">
              <input type="checkbox" name="trust" value="1" />
              <span>Trust this device (stay signed in longer)</span>
            </label>
            <button className="btn" type="submit">Sign In</button>
          </form>
        </Fragment>
      ) : (
        <Fragment>
          <h1 style="font-size:16px;margin:14px 0 6px">Link unavailable</h1>
          <p className="sub" style="font-size:12.5px">
            This sign-in link is invalid, expired, or has already been used.
            Request a new one.
          </p>
          <p className="sub" style="font-size:12px;margin-top:12px">
            <a className="btn ghost sm" href="/signin">Back to sign-in</a>
          </p>
        </Fragment>
      )}
    </AuthDoc>
  );
}

// ================================================== account security page

export interface SecurityPageInput {
  identity: Identity;
  user: User;
  currentSessionId: string;
  csrfToken: string;
  memberships: Array<{
    membership: IdentityMembership;
    org: Organization | null;
    user: User | null;
    current: boolean;
  }>;
  sessions: AuthSession[];
  history: AuthEvent[];
  /** Memberships the viewer can administer (owner orgs), excluding their own rows. */
  administrable: Array<{
    membership: IdentityMembership;
    org: Organization | null;
    user: User | null;
    identityEmail: string | null;
  }>;
  ssoNote: string;
  mfaNote: string;
}

const EVENT_LABELS: Record<string, string> = {
  SIGN_IN: "Signed in",
  SIGN_OUT: "Signed out",
  SIGN_OUT_EVERYWHERE: "Signed out everywhere",
  SESSION_REVOKED: "Session revoked",
  SESSION_EXPIRED: "Session expired",
  SESSION_ROTATED: "Session rotated",
  ORG_SWITCHED: "Switched organization",
  EMAIL_VERIFIED: "Email verified",
  LINK_ISSUED: "Sign-in link issued",
  LOGIN_REPLAY_BLOCKED: "Reused link blocked",
  LOGIN_FAILED_EXPIRED_LINK: "Expired link rejected",
  LOGIN_BLOCKED_LOCKED_OUT: "Attempt blocked (locked)",
  ACCOUNT_LOCKED: "Account locked",
  INVITATION_ACCEPTED: "Invitation accepted",
  IDENTITY_CREATED: "Account created",
  IDENTITY_BOOTSTRAPPED: "Account bootstrapped",
  MEMBERSHIP_SUSPENDED: "Membership suspended",
  MEMBERSHIP_RESTORED: "Membership restored",
  MEMBERSHIP_DEACTIVATED: "Membership deactivated",
  OWNERSHIP_TRANSFERRED: "Ownership transferred",
};

function when(iso: string): string {
  return iso.replace("T", " ").slice(0, 16) + " UTC";
}

function csrfField(token: string) {
  return <input type="hidden" name="csrf" value={token} />;
}

export function renderAccountSecurity(input: SecurityPageInput): string {
  const tone: Record<string, string> = { ACTIVE: "ok", SUSPENDED: "warn", DEACTIVATED: "neutral" };
  return renderDocument(
    <AuthDoc title="Account security" wide>
      <div className="idp-head">
        <div>
          <h1 style="font-size:17px;margin:14px 0 2px">Account security</h1>
          <p className="sub" style="font-size:12.5px;margin:0">
            <b>{input.identity.displayName}</b> · {input.identity.email}
            {input.identity.emailVerifiedAt ? " · email verified" : " · email not yet verified"}
          </p>
        </div>
        <div className="idp-head-actions">
          <a className="btn ghost sm" href="/overview">← Back to OBV</a>
          <form method="POST" action="/api/auth/logout" style="display:inline">
            {csrfField(input.csrfToken)}
            <button className="btn secondary sm" type="submit">Sign Out</button>
          </form>
          <form method="POST" action="/api/auth/logout-all" style="display:inline">
            {csrfField(input.csrfToken)}
            <button className="btn ghost sm" type="submit">Sign Out Everywhere</button>
          </form>
        </div>
      </div>

      <section className="idp-card">
        <h2>Organizations</h2>
        <p className="sub">
          One account, every organization you belong to. Switching rotates your
          session; it never changes what any organization can see.
        </p>
        <table className="idp-table">
          <thead><tr><th>Organization</th><th>Role</th><th>Status</th><th>Ownership</th><th></th></tr></thead>
          <tbody>
            {input.memberships.map((m) => (
              <tr>
                <td><b>{m.org?.name ?? "—"}</b></td>
                <td>{m.user ? enumLabel(m.user.role) : "—"}</td>
                <td><span className={`chip ${tone[m.membership.status] ?? "neutral"}`}>{enumLabel(m.membership.status)}</span></td>
                <td>{m.membership.isOwner ? "Owner" : "Member"}</td>
                <td>
                  {m.current ? (
                    <span className="chip ok">Current</span>
                  ) : m.membership.status === "ACTIVE" ? (
                    <form method="POST" action="/api/auth/switch-org" style="display:inline">
                      {csrfField(input.csrfToken)}
                      <input type="hidden" name="membershipId" value={m.membership.id} />
                      <button className="btn ghost sm" type="submit">Switch</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="idp-card">
        <h2>Active sessions</h2>
        <p className="sub">Every signed-in device. Revoking a session signs that device out immediately.</p>
        <table className="idp-table">
          <thead><tr><th>Device</th><th>Signed in</th><th>Last activity</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {input.sessions.map((s) => (
              <tr>
                <td>
                  <b>{s.deviceLabel ?? (s.userAgent ? s.userAgent.slice(0, 48) : "Unknown device")}</b>
                  {s.trustedDevice ? <span className="chip ok" style="margin-left:6px">Trusted</span> : null}
                  {s.id === input.currentSessionId ? <span className="chip" style="margin-left:6px">This device</span> : null}
                </td>
                <td>{when(s.createdAt)}</td>
                <td>{when(s.lastSeenAt)}</td>
                <td>{when(s.absoluteExpiresAt)}</td>
                <td>
                  {s.id !== input.currentSessionId ? (
                    <form method="POST" action={`/api/auth/sessions/${s.id}/revoke`} style="display:inline">
                      {csrfField(input.csrfToken)}
                      <button className="btn ghost sm" type="submit">Revoke</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {input.administrable.length > 0 ? (
        <section className="idp-card">
          <h2>Members you administer</h2>
          <p className="sub">
            Organization owner controls. Suspension revokes the member's live
            sessions; every action is recorded in the immutable audit log.
          </p>
          <table className="idp-table">
            <thead><tr><th>Member</th><th>Organization</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {input.administrable.map((m) => (
                <tr>
                  <td><b>{m.user?.name ?? "—"}</b>{m.identityEmail ? <span className="sub" style="display:block;font-size:11px">{m.identityEmail}</span> : null}</td>
                  <td>{m.org?.name ?? "—"}</td>
                  <td><span className={`chip ${tone[m.membership.status] ?? "neutral"}`}>{enumLabel(m.membership.status)}</span></td>
                  <td className="idp-actions">
                    {m.membership.status === "ACTIVE" && !m.membership.isOwner ? (
                      <Fragment>
                        <form method="POST" action={`/api/auth/memberships/${m.membership.id}/suspend`} style="display:inline">
                          {csrfField(input.csrfToken)}
                          <button className="btn ghost sm" type="submit">Suspend</button>
                        </form>
                        <form method="POST" action={`/api/auth/memberships/${m.membership.id}/deactivate`} style="display:inline">
                          {csrfField(input.csrfToken)}
                          <button className="btn ghost sm" type="submit">Deactivate</button>
                        </form>
                        <form method="POST" action={`/api/auth/orgs/${m.membership.organizationId}/transfer-ownership`} style="display:inline">
                          {csrfField(input.csrfToken)}
                          <input type="hidden" name="membershipId" value={m.membership.id} />
                          <button className="btn ghost sm" type="submit">Make Owner</button>
                        </form>
                      </Fragment>
                    ) : m.membership.status === "SUSPENDED" ? (
                      <form method="POST" action={`/api/auth/memberships/${m.membership.id}/restore`} style="display:inline">
                        {csrfField(input.csrfToken)}
                        <button className="btn ghost sm" type="submit">Restore</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="idp-card">
        <h2>Sign-in history</h2>
        <table className="idp-table">
          <thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
          <tbody>
            {input.history.slice(0, 25).map((e) => (
              <tr>
                <td>{when(e.occurredAt)}</td>
                <td>{EVENT_LABELS[e.kind] ?? enumLabel(e.kind)}</td>
                <td className="sub">{[e.ip, e.detail].filter(Boolean).join(" · ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="idp-card">
        <h2>Enterprise sign-in &amp; MFA</h2>
        <p className="sub">{input.ssoNote}</p>
        <p className="sub">{input.mfaNote}</p>
      </section>
    </AuthDoc>
  );
}
