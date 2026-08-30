// Blackboard Learn — this institution's own Learn site, read-only.
//
// The third VLE, alongside src/moodle.js and vle/canvas.js. Same job, and a
// noticeably more awkward setup than either.
//
// WHY THE SET-UP IS DIFFERENT FROM MOODLE AND CANVAS
//
// Moodle and Canvas both end with an administrator pasting a token they generated
// themselves. Blackboard does not work that way. An application is registered once at
// developer.anthology.com, which issues an Application ID, Key and Secret — and then
// the COLLEGE'S OWN Learn system administrator has to create a REST API Integration
// on their site, quoting that Application ID and nominating a Learn user account for
// the integration to act as. Until they do, every token request returns 401 no matter
// how correct the key and secret are.
//
// That is a second person, at the customer, doing a thing in a different system. It
// cannot be automated away, so the honest response is to say so at set-up time and to
// make the 401 message name it, rather than reporting "invalid credentials" to
// somebody whose credentials are fine.
//
// The key and secret are held in this deployment's integration settings, AES-encrypted
// like every other integration secret, rather than in code or in a shared registration.
// They used to be per tenant, and the reason they were is the reason they are still
// configuration: the daily call quota below is per developer registration, so a shared
// one would put every college the supplier serves under a single ceiling that one busy
// college can exhaust. Separate deployments now give that separation by themselves —
// but a college that brings its own developer registration must still be able to say
// so, and that is a value an administrator types, not one a deploy sets.
//
// ENTITLEMENTS, WHICH BLOCK READS IN NON-OBVIOUS WAYS
//
// The nominated Learn user's entitlements are the ceiling on everything. Two are
// counter-intuitive and worth stating in the setup text: reading gradebook ATTEMPTS
// requires `course.gradebook.MODIFY` (a write entitlement gating a read), and
// attendance requires `course.attendance.VIEW`. A service account short of either
// produces a sync that connects, runs, and silently returns nothing for that area.
//
// RATE LIMIT — 10,000 calls per site per day, an order of magnitude tighter than
// Canvas, and shared across every application in the developer group. A naive full
// sync of 200 courses with 15 columns each is over 6,000 calls. Everything here is
// built to spend as few as possible: `expand=user` so memberships never fan out to
// one call per student, `changeIndex` so grades are fetched only when they moved, and
// one cached token per site rather than one per request.
const cfg = require("../integrationConfig");
// The pure mapping decisions live in blackboardNormalise.js and are imported rather
// than repeated here. They were duplicated for a while, which is exactly how two
// implementations of "what is this student's mark" drift apart without anyone
// noticing — and only one of the copies had tests.
const normalise = require("./blackboardNormalise");

const TIMEOUT_MS = 30_000;

// Blackboard clamps collection responses at 100 server-side. Asking for more is
// harmless; relying on the number returned is not — see paginate().
const LIMIT = 100;

// Re-request the token this long before it expires. Blackboard issues one token per
// application per site and hands back the SAME one with a refreshed expiry if it is
// still alive, so an early request is cheap — but it still counts against the daily
// quota, hence the cache rather than a request per call.
const TOKEN_SKEW_MS = 5 * 60_000;

// host -> { token, expiresAt }. Keyed by HOST, and it stays a Map now the tenant is
// gone, because the host was always the right key: Blackboard issues one token per
// application per site, so the site is what a token belongs to. This deployment reads
// one Learn site today, but testConnection() hits whatever host an administrator has
// just typed, which is a second host in the same process.
const tokenCache = new Map();

/** Drop a cached token — after a 401, and available to tests. */
const forgetToken = (host) => (host ? void tokenCache.delete(host) : tokenCache.clear());

/** This college's Blackboard settings, or null. `secret` is the decrypted secret. */
function settings() {
  const s = cfg.peek("blackboard") || {};
  return s.url && s.applicationKey && s.secret ? s : null;
}

const isConfigured = () => Boolean(settings());

/**
 * The public API root for this site.
 *
 * Administrators paste the address they sign in at, which is frequently a Learn page
 * rather than the host. Normalising is kinder than demanding a canonical form.
 */
function apiBase(url) {
  let u = String(url || "").trim().replace(/\/+$/, "");
  u = u.replace(/\/learn\/api\/public(\/v\d+)?$/i, "");
  u = u.replace(/\/(webapps|ultra|learn)(\/.*)?$/i, "");
  return u.replace(/\/+$/, "") + "/learn/api/public";
}

/** Just the scheme and host, for resolving a relative nextPage. */
function origin(url) {
  try {
    return new URL(apiBase(url)).origin;
  } catch {
    return "";
  }
}

/**
 * The next page of a collection, as an absolute URL.
 *
 * Blackboard's `paging.nextPage` is a RELATIVE path — unlike Canvas, whose Link
 * header carries absolute URLs. Handing it straight to fetch resolves it against the
 * wrong base. Its ABSENCE is the only end-of-collection signal there is: there is no
 * total, no page count, and a short page is not the last one.
 */
function nextPageUrl(body, host) {
  const next = body && body.paging && body.paging.nextPage;
  if (!next) return null;
  if (/^https?:\/\//i.test(next)) return next;
  return String(host || "").replace(/\/+$/, "") + next;
}

/* -------------------------------------------------------------------------- */
/* Interpreting what comes back                                                */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* The wire                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A bearer token for this site, cached until shortly before it expires.
 *
 * Blackboard issues ONE token per application per site and returns the same one with
 * a refreshed expiry while it lives, so this cache is an optimisation against the
 * daily quota rather than against Blackboard's willingness to issue.
 */
async function token(s, opts = {}) {
  const base = apiBase(s.url);
  const hit = tokenCache.get(base);
  if (!opts.force && hit && hit.expiresAt > Date.now() + TOKEN_SKEW_MS) return hit.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);

  let res, text;
  try {
    res = await fetch(base + "/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(s.applicationKey + ":" + s.secret).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Blackboard did not respond within " + Math.round((opts.timeoutMs || TIMEOUT_MS) / 1000) + " seconds.");
    throw new Error("Could not reach Blackboard at " + base + " — " + e.message);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    // On a correct key and secret this almost always means the customer's Learn
    // administrator has not created the REST API Integration. Saying "invalid
    // credentials" to somebody whose credentials are correct sends them to check the
    // one thing that is not wrong.
    throw new Error(
      "Blackboard refused these credentials. If the Application Key and Secret are correct, the most likely cause is that this college's Blackboard administrator has not yet created the REST API Integration for the Application ID — System Admin → Building Blocks → REST API Integrations."
    );
  }
  if (!res.ok) throw new Error("Blackboard returned HTTP " + res.status + " when asking for an access token.");

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That address did not return Blackboard API data. Check it is this college's Blackboard Learn address.");
  }
  if (!data.access_token) throw new Error("Blackboard did not return an access token.");

  tokenCache.set(base, {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

/** One authenticated GET. `path` is either "/v3/courses" or an absolute nextPage. */
async function get(path, params = {}, opts = {}) {
  const s = opts.settings || settings();
  if (!s) throw new Error("Blackboard is not configured for this institution.");

  const absolute = /^https?:\/\//i.test(path);
  const url = new URL(absolute ? path : apiBase(s.url) + path);
  if (!absolute) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }

  const send = async (bearer) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
    try {
      return await fetch(url.toString(), {
        headers: { Authorization: "Bearer " + bearer, Accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res;
  try {
    res = await send(await token(s, opts));
    // A cached token can be invalidated at the far end — a site restart, an admin
    // disabling and re-enabling the integration. One forced retry costs one request
    // and turns a spurious failure into a success.
    if (res.status === 401) {
      forgetToken(apiBase(s.url));
      res = await send(await token(s, { ...opts, force: true }));
    }
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Blackboard did not respond in time.");
    throw e;
  }

  if (res.status === 429) {
    const e = new Error("Blackboard is rate limiting this site. It allows 10,000 API calls per day, shared across every integration on the site.");
    e.rateLimited = true;
    throw e;
  }
  if (res.status === 403) {
    throw new Error(
      "Blackboard allowed the connection but refused this data. The Learn user the integration acts as does not have the entitlements it needs — reading gradebook attempts requires course.gradebook.MODIFY, and attendance requires course.attendance.VIEW."
    );
  }
  if (res.status === 404) throw new Error("Blackboard returned 'not found' for " + url.pathname + ".");
  if (!res.ok) throw new Error("Blackboard returned HTTP " + res.status + ".");

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("That address did not return Blackboard API data. Check it is this college's Blackboard Learn address.");
  }
}

/**
 * Every page of a collection.
 *
 * Terminates ONLY on the absence of paging.nextPage. There is no total and no page
 * count, and Blackboard clamps `limit` server-side, so a page shorter than requested
 * is ordinary rather than final.
 */
async function paginate(path, params = {}, opts = {}) {
  const s = opts.settings || settings();
  if (!s) throw new Error("Blackboard is not configured for this institution.");

  const host = origin(s.url);
  const out = [];
  let url = null;
  let pages = 0;
  const MAX_PAGES = 200; // a runaway guard, not a limit anybody reaches

  for (;;) {
    const body = await get(url || path, url ? {} : { limit: LIMIT, ...params }, opts);
    if (Array.isArray(body && body.results)) out.push(...body.results);
    url = nextPageUrl(body, host);
    if (!url || ++pages >= MAX_PAGES) break;
  }
  return out;
}

/**
 * Does this college's Blackboard configuration work?
 *
 * THREE checks, because they fail for three different reasons and only naming the
 * right one is any use to whoever is setting it up:
 *
 *   1. The token request — proves the key and secret AND that the college's Learn
 *      administrator has created the REST API Integration. This is the step most
 *      likely to be outstanding, and a 401 here says so rather than blaming the key.
 *   2. /system/info — names the site, so an administrator who pasted the wrong
 *      institution's address sees the wrong institution's identity back. Only exists
 *      from build 3900.56.0, so its absence is not a failure.
 *   3. One course read — proves the nominated Learn user can actually SEE course
 *      data. A service account with too few entitlements passes 1 and 2 and then
 *      returns nothing, which is the worst outcome to discover a term later.
 */
async function testConnection() {
  await cfg.load("blackboard");
  const s = settings();
  if (!s) {
    return {
      ok: false,
      note: "Not configured — a Blackboard address, an Application Key and an Application Secret are all required.",
    };
  }

  forgetToken(apiBase(s.url)); // a test must test what was just entered, not a cached token
  try {
    await token(s, { settings: s, timeoutMs: 15_000, force: true });
  } catch (e) {
    return { ok: false, note: e.message };
  }

  let site = "";
  try {
    // `info.tenantId` here is BLACKBOARD's own identifier for the Learn site — nothing
    // to do with the multi-tenancy this platform used to have. Newer builds report
    // siteId; older ones only tenantId, hence reading both.
    const info = await get("/v1/system/info", {}, { settings: s, timeoutMs: 15_000 });
    if (info && (info.siteId || info.tenantId)) site = " (site " + (info.siteId || info.tenantId) + ")";
  } catch {
    // Older Learn builds have no /system/info. Not a failure — the token already
    // proved the connection, and the course read below proves the reach.
  }

  try {
    const courses = await get("/v3/courses", { limit: 1, fields: "id,courseId,name" }, { settings: s, timeoutMs: 20_000 });
    const n = Array.isArray(courses && courses.results) ? courses.results.length : 0;
    if (n === 0) {
      return {
        ok: false,
        note: "Connected to Blackboard" + site + ", but no courses are visible. The Learn user this integration acts as needs permission to read courses, rosters and grades — ask the Blackboard administrator to check which account they nominated on the REST API Integration.",
      };
    }
    return { ok: true, note: "Connected to Blackboard" + site + ". Courses are readable." };
  } catch (e) {
    return { ok: false, note: "Connected to Blackboard" + site + ", but course data could not be read — " + e.message };
  }
}

module.exports = {
  key: "blackboard",
  label: "Blackboard",
  isConfigured,
  testConnection,
  get,
  paginate,
  token,
  forgetToken,
  apiBase,
  origin,
  nextPageUrl,
  LIMIT,
  // Re-exported from blackboardNormalise so callers have one place to reach for and
  // there is only one implementation of each behind it.
  attendanceToStatus: normalise.attendanceToStatus,
  markOf: normalise.markOf,
  isLate: normalise.isLate,
  isChildCourse: normalise.isChildCourse,
  ATTENDANCE: normalise.ATTENDANCE,
};
