/**
 * Test sign-in helper.
 *
 * Identity cookies are signed (HMAC) rather than raw user ids, so a suite can
 * no longer fabricate one by writing `obv_user=user-funder`. It must obtain a
 * real cookie the way a browser does: POST /api/session and keep the
 * Set-Cookie value.
 *
 * `signInAll` is awaited once after the server is up; `sessionCookie` is then
 * synchronous, so existing synchronous header builders keep working unchanged.
 */
const { randomBytes } = require("node:crypto");

/**
 * A stable signing secret for this test process, established at require time
 * so every server the suite spawns inherits it through process.env. Without
 * this each restart would mint a fresh ephemeral secret and invalidate every
 * cookie the suite already holds. Random per run, never committed.
 */
if (!process.env.OBV_SESSION_SECRET) {
  process.env.OBV_SESSION_SECRET = randomBytes(32).toString("hex");
}

const jar = new Map();

/** The seeded demo identities every suite draws from. */
const SEEDED_USERS = [
  "user-funder",
  "user-pm",
  "user-field",
  "user-compliance",
  "user-lender2",
];

/** Sign in and cache the cookie for each user id. Unknown ids are skipped. */
async function signInAll(base, userIds = SEEDED_USERS) {
  for (const userId of userIds) {
    const res = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
      redirect: "manual",
    });
    if (res.status >= 400) continue; // not seeded in this database
    const setCookie = res.headers.getSetCookie();
    if (!setCookie.length) throw new Error(`no Set-Cookie for ${userId}`);
    jar.set(`${base}|${userId}`, setCookie[0].split(";")[0]);
  }
}

/** The signed cookie string for a signed-in user (`obv_user=v1....`). */
function sessionCookie(base, userId) {
  const value = jar.get(`${base}|${userId}`);
  if (!value) {
    throw new Error(
      `not signed in as ${userId} — call await signInAll(BASE) after the server starts`
    );
  }
  return value;
}

/**
 * The same signed session as a Playwright cookie object. Browser suites
 * used to inject `{ name: "obv_user", value: "user-funder" }` directly,
 * which is precisely the forgery the signed cookie now rejects.
 */
function playwrightCookie(base, userId) {
  const raw = sessionCookie(base, userId);
  const eq = raw.indexOf("=");
  return { name: raw.slice(0, eq), value: raw.slice(eq + 1), url: base };
}

module.exports = { SEEDED_USERS, signInAll, sessionCookie, playwrightCookie };
