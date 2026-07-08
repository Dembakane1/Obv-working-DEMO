/**
 * One-time delegated-send onboarding — administrator tool.
 *
 *   node scripts/teams-delegated-auth.js
 *
 * Runs the OAuth 2.0 DEVICE CODE flow for the dedicated OBV send service
 * account and prints the refresh token ONCE so the administrator can set
 * MICROSOFT_SEND_REFRESH_TOKEN in the hosting environment. Nothing is
 * written to disk. Sign in with the dedicated service account (e.g.
 * obv-sync@tenant) — outbound Teams messages will be attributed to it.
 *
 * Requires: MICROSOFT_TENANT_ID + MICROSOFT_CLIENT_ID in env/.env, the
 * app registration to have "Allow public client flows" enabled OR the
 * device-code flow permitted, and delegated ChannelMessage.Send +
 * offline_access permissions consented.
 */
const fs = require("node:fs");
const path = require("node:path");

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
const LOGIN = (process.env.OBV_GRAPH_LOGIN_URL ?? "https://login.microsoftonline.com").replace(/\/$/, "");
const GRAPH = (process.env.OBV_GRAPH_BASE_URL ?? "https://graph.microsoft.com").replace(/\/$/, "");
const SCOPE = `${GRAPH}/ChannelMessage.Send offline_access openid profile`;

(async () => {
  if (!TENANT || !CLIENT) {
    console.error("Set MICROSOFT_TENANT_ID and MICROSOFT_CLIENT_ID first.");
    process.exit(2);
  }
  const dc = await fetch(`${LOGIN}/${TENANT}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT, scope: SCOPE }).toString(),
  }).then((r) => r.json());
  if (!dc.device_code) {
    console.error("Device-code request failed:", dc.error ?? "unknown", "—", dc.error_description?.split(".")[0] ?? "");
    process.exit(1);
  }
  console.log("\n" + dc.message + "\n");
  console.log("Waiting for the OBV service account to complete sign-in…");
  const interval = (dc.interval ?? 5) * 1000;
  const deadline = Date.now() + (dc.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const tok = await fetch(`${LOGIN}/${TENANT}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT,
        device_code: dc.device_code,
      }).toString(),
    }).then((r) => r.json());
    if (tok.refresh_token) {
      console.log("\nSign-in complete. Set this ONCE in your hosting environment");
      console.log("(never commit it; it is a credential):\n");
      console.log("MICROSOFT_SEND_REFRESH_TOKEN=" + tok.refresh_token + "\n");
      process.exit(0);
    }
    if (tok.error && tok.error !== "authorization_pending" && tok.error !== "slow_down") {
      console.error("Sign-in failed:", tok.error);
      process.exit(1);
    }
  }
  console.error("Device-code flow expired — run again.");
  process.exit(1);
})().catch((err) => {
  console.error("error:", err.message);
  process.exit(1);
});
