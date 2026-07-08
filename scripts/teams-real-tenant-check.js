/**
 * Real Microsoft tenant connection diagnostic — administrator tool.
 *
 *   node scripts/teams-real-tenant-check.js <teamId> <channelId> [publicBaseUrl]
 *
 * Reads MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET
 * / MICROSOFT_SEND_REFRESH_TOKEN from the environment (or .env) and probes
 * each capability the Teams Conversation Bridge needs. Prints PASS / FAIL /
 * NOT CONFIGURED / REQUIRES ADMIN CONSENT per check with actionable
 * remediation. NEVER prints tokens, secrets, or raw Graph payloads.
 *
 * Read-only except: the subscription check creates a short-lived
 * subscription and deletes it immediately. No channel message is posted
 * (send capability is verified by acquiring the delegated token only).
 */
const fs = require("node:fs");
const path = require("node:path");

// minimal .env loader (matches the server's)
try {
  const envFile = path.join(process.cwd(), ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch { /* optional */ }

const TENANT = process.env.MICROSOFT_TENANT_ID ?? "";
const CLIENT = process.env.MICROSOFT_CLIENT_ID ?? "";
const SECRET = process.env.MICROSOFT_CLIENT_SECRET ?? "";
const REFRESH = process.env.MICROSOFT_SEND_REFRESH_TOKEN ?? "";
const GRAPH = (process.env.OBV_GRAPH_BASE_URL ?? "https://graph.microsoft.com").replace(/\/$/, "");
const LOGIN = (process.env.OBV_GRAPH_LOGIN_URL ?? "https://login.microsoftonline.com").replace(/\/$/, "");
const TEAM = process.argv[2] ?? "";
const CHANNEL = process.argv[3] ?? "";
const PUBLIC_BASE = (process.argv[4] ?? process.env.OBV_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

let failures = 0;
function report(check, status, detail) {
  const pad = check.padEnd(26);
  console.log(`${pad} ${status}${detail ? `\n${" ".repeat(4)}${detail}` : ""}`);
  if (status === "FAIL") failures++;
}

async function timedFetch(url, init = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function token(form) {
  const res = await timedFetch(`${LOGIN}/${encodeURIComponent(TENANT)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, errorCode: body.error ?? null, accessToken: body.access_token ?? null };
}

async function graph(pathname, accessToken, init = {}) {
  const res = await timedFetch(`${GRAPH}/v1.0${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return res;
}

(async () => {
  console.log("OBV Teams Conversation Bridge — real tenant diagnostic\n");
  if (!TENANT || !CLIENT || !SECRET) {
    report("CONFIGURATION", "NOT CONFIGURED",
      "Set MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET (server-side env).");
    process.exit(2);
  }
  if (!TEAM || !CHANNEL) {
    console.log("Usage: node scripts/teams-real-tenant-check.js <teamId> <channelId> [publicBaseUrl]\n");
  }

  // 1. READ token acquisition (client credentials).
  let readToken = null;
  try {
    const t = await token({
      client_id: CLIENT, client_secret: SECRET,
      scope: `${GRAPH}/.default`, grant_type: "client_credentials",
    });
    if (t.ok && t.accessToken) {
      readToken = t.accessToken;
      report("READ TOKEN", "PASS");
    } else if (t.errorCode === "invalid_client") {
      report("READ TOKEN", "FAIL", "Reason: client id/secret rejected. Action: verify the app registration and rotate the client secret if expired.");
    } else {
      report("READ TOKEN", "FAIL", `Reason: token endpoint rejected the request (${t.errorCode ?? t.status}). Action: verify tenant id and app registration.`);
    }
  } catch {
    report("READ TOKEN", "FAIL", "Reason: login endpoint unreachable from this host. Action: check outbound network access to login.microsoftonline.com.");
  }

  // 2-4. Team access / channel access / message read.
  if (readToken && TEAM) {
    const teamRes = await graph(`/teams/${TEAM}`, readToken).catch(() => null);
    if (teamRes?.ok) report("TEAM ACCESS", "PASS");
    else if (teamRes && (teamRes.status === 401 || teamRes.status === 403))
      report("TEAM ACCESS", "REQUIRES ADMIN CONSENT",
        "Action: grant admin consent for ChannelMessage.Read.All, or install the OBV Teams app (RSC ChannelMessage.Read.Group) in this Team.");
    else report("TEAM ACCESS", "FAIL", `Reason: team not found or unreachable (${teamRes?.status ?? "network"}). Action: verify the team id.`);

    if (CHANNEL) {
      const chRes = await graph(`/teams/${TEAM}/channels/${CHANNEL}`, readToken).catch(() => null);
      if (chRes?.ok) report("CHANNEL ACCESS", "PASS");
      else if (chRes && (chRes.status === 401 || chRes.status === 403))
        report("CHANNEL ACCESS", "REQUIRES ADMIN CONSENT", "Action: same consent/installation as TEAM ACCESS.");
      else report("CHANNEL ACCESS", "FAIL", `Reason: channel not found (${chRes?.status ?? "network"}). Action: verify the channel id.`);

      const msgRes = await graph(`/teams/${TEAM}/channels/${CHANNEL}/messages?$top=1`, readToken).catch(() => null);
      if (msgRes?.ok) report("MESSAGE READ", "PASS");
      else if (msgRes && (msgRes.status === 401 || msgRes.status === 403))
        report("MESSAGE READ", "REQUIRES ADMIN CONSENT",
          "Action: ChannelMessage.Read.All (application) needs tenant-admin consent; RSC installs need ChannelMessage.Read.Group in the app manifest.");
      else report("MESSAGE READ", "FAIL", `Reason: read rejected (${msgRes?.status ?? "network"}).`);
    }
  } else if (!TEAM) {
    report("TEAM ACCESS", "NOT CONFIGURED", "Pass a teamId argument to probe team/channel access.");
  }

  // 5. SEND capability (delegated token only — no message is posted).
  if (!REFRESH) {
    report("SEND CAPABILITY", "NOT CONFIGURED",
      "Reason: no MICROSOFT_SEND_REFRESH_TOKEN. Application permissions cannot post channel messages operationally.\n    Action: run scripts/teams-delegated-auth.js with the dedicated OBV service account to obtain one (delegated ChannelMessage.Send).");
  } else {
    try {
      const t = await token({
        client_id: CLIENT, client_secret: SECRET,
        scope: `${GRAPH}/ChannelMessage.Send offline_access`,
        grant_type: "refresh_token", refresh_token: REFRESH,
      });
      if (t.ok && t.accessToken) report("SEND CAPABILITY", "PASS", "Delegated ChannelMessage.Send token acquired (no message posted).");
      else if (t.errorCode === "invalid_grant")
        report("SEND CAPABILITY", "FAIL", "Reason: refresh token expired or revoked. Action: re-run scripts/teams-delegated-auth.js and update MICROSOFT_SEND_REFRESH_TOKEN.");
      else report("SEND CAPABILITY", "REQUIRES ADMIN CONSENT", `Reason: ${t.errorCode ?? t.status}. Action: consent the delegated ChannelMessage.Send permission for the app.`);
    } catch {
      report("SEND CAPABILITY", "FAIL", "Reason: login endpoint unreachable.");
    }
  }

  // 6-7. Subscription creation + webhook reachability.
  if (readToken && TEAM && CHANNEL && PUBLIC_BASE) {
    const notificationUrl = `${PUBLIC_BASE}/api/teams-sync/notifications`;
    try {
      const subRes = await graph("/subscriptions", readToken, {
        method: "POST",
        body: JSON.stringify({
          changeType: "created,updated,deleted",
          notificationUrl,
          resource: `/teams/${TEAM}/channels/${CHANNEL}/messages`,
          expirationDateTime: new Date(Date.now() + 20 * 60000).toISOString(),
          clientState: "diagnostic-probe",
        }),
      });
      if (subRes.ok) {
        const sub = await subRes.json().catch(() => ({}));
        report("SUBSCRIPTION", "PASS", "Short-lived probe subscription created (deleting).");
        report("WEBHOOK REACHABILITY", "PASS", "Graph completed the validation handshake against the public URL.");
        if (sub.id) await graph(`/subscriptions/${sub.id}`, readToken, { method: "DELETE" }).catch(() => {});
      } else if (subRes.status === 401 || subRes.status === 403) {
        report("SUBSCRIPTION", "REQUIRES ADMIN CONSENT", "Action: consent ChannelMessage.Read.All (application) — required for channel-message subscriptions.");
      } else {
        report("SUBSCRIPTION", "FAIL",
          `Reason: subscription rejected (${subRes.status}). If validation failed, Graph could not reach ${notificationUrl} — verify the public HTTPS URL and that the deployment is awake.`);
        report("WEBHOOK REACHABILITY", "FAIL", "Reason: see SUBSCRIPTION. Action: confirm the deployed OBV answers GET/POST ?validationToken=… on the notification URL.");
      }
    } catch {
      report("SUBSCRIPTION", "FAIL", "Reason: Graph unreachable from this host.");
    }
  } else {
    report("SUBSCRIPTION", "NOT CONFIGURED", "Needs teamId, channelId and a public base URL argument (or OBV_PUBLIC_BASE_URL).");
  }

  // 8. Identity lookup capability (optional — improves mapping ergonomics).
  if (readToken) {
    const meRes = await graph(`/users?$top=1&$select=id,displayName`, readToken).catch(() => null);
    if (meRes?.ok) report("IDENTITY LOOKUP", "PASS", "User.Read.All available — admin can resolve Teams user ids to names.");
    else if (meRes && (meRes.status === 401 || meRes.status === 403))
      report("IDENTITY LOOKUP", "REQUIRES ADMIN CONSENT", "Optional: consent User.Read.All (application) to list directory names; mapping works without it using ids from inbound messages.");
    else report("IDENTITY LOOKUP", "FAIL", `Reason: directory query rejected (${meRes?.status ?? "network"}).`);
  }

  console.log(`\n${failures === 0 ? "Diagnostic complete." : `Diagnostic complete — ${failures} failing check(s).`}`);
  console.log("No tokens, secrets, or raw Graph payloads were printed.");
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("diagnostic error:", err.message);
  process.exit(1);
});
