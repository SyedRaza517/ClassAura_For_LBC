// Canvas LMS — this institution's own Canvas, read-only.
//
// Mirrors what src/moodle.js does for Moodle: an authenticated client over one
// college's credentials, plus the cheapest call that proves those credentials work.
// The credentials come from integrationConfig, which decrypts them per tenant, so
// nothing here knows or cares which college it is acting for.
//
// AUTHENTICATION — a manual access token, deliberately.
//
// Canvas offers two: a token the admin generates in their own Canvas profile, and a
// full OAuth2 developer key. The token is one field in a form and works immediately;
// the developer key needs a root-account admin to register an application and issues
// tokens that expire hourly.
//
// Canvas's API Policy says an application used by MULTIPLE USERS must use OAuth, and
// that asking other users to paste tokens violates it. What we do here is the narrow
// case that policy is not aimed at: ONE administrator configuring their OWN
// institution's sync, with their own token, acting as themselves. If this ever grows
// into asking individual tutors for tokens, that is the point at which OAuth stops
// being optional. Written down here so the decision is visible rather than assumed.
//
// RATE LIMITING — and the trap in it.
//
// Canvas throttles per access token with a leaky bucket, so one college's sync cannot
// throttle another's. But the default throttled response is **403, not 429** (429 is
// behind a per-instance flag that ships off), and 403 is also what permission-denied
// returns. Keying retries off the status alone would retry permission errors forever
// and report throttling to an administrator as "access denied". isRateLimited() below
// reads the body and the X-Rate-Limit-Remaining header instead.
const cfg = require("../integrationConfig");

// Canvas reserves 50 units of a 600-unit budget for every request in flight, so
// roughly twelve concurrent requests throttle regardless of how cheap they are. The
// docs say a client making one request at a time is "unlikely to be throttled"; four
// is comfortably inside that and still four times faster than serial.
const MAX_CONCURRENCY = 4;

// Canvas's page default is 10, which would turn one college's roster into hundreds of
// round trips. 100 is the practical ceiling; the docs decline to promise it, so the
// pager below treats a short page as ordinary rather than as the end.
const PER_PAGE = 100;

const TIMEOUT_MS = 30_000;

/** This college's Canvas settings, or null. `token` is the decrypted secret. */
function settings() {
  const s = cfg.peek("canvas") || {};
  return s.url && s.token ? s : null;
}

function isConfigured() {
  return Boolean(settings());
}

/**
 * The API root for this college.
 *
 * Administrators paste all sorts of things — a trailing slash, the full
 * `/api/v1`, a `/login` URL they had open. Normalising here rather than demanding a
 * canonical form means the setup screen accepts what a person actually has to hand.
 */
function apiBase(url) {
  let u = String(url || "").trim().replace(/\/+$/, "");
  u = u.replace(/\/(login|courses|accounts)(\/.*)?$/i, "");
  u = u.replace(/\/api\/v1$/i, "");
  return u + "/api/v1";
}

/** Canvas throttling, told apart from a genuine permission failure. */
function isRateLimited(res, body) {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  const remaining = res.headers.get("x-rate-limit-remaining");
  if (remaining !== null && Number(remaining) <= 0) return true;
  return /rate limit exceeded/i.test(String(body || ""));
}

/**
 * One authenticated GET.
 *
 * Returns { data, linkHeader }. Throws an Error whose message is fit to show an
 * administrator — this is what surfaces in the connection test and in a sync's issue
 * list, so "Canvas rejected the access token" beats "Request failed with status 401".
 */
async function get(path, params = {}, opts = {}) {
  const s = opts.settings || settings();
  if (!s) throw new Error("Canvas is not configured for this institution.");

  const url = new URL(path.startsWith("http") ? path : apiBase(s.url) + path);
  // A `next` link already carries its own query; re-adding ours would fight it.
  if (!path.startsWith("http")) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const one of v) url.searchParams.append(k, one);
      else if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: "Bearer " + s.token, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Canvas did not respond within " + Math.round((opts.timeoutMs || TIMEOUT_MS) / 1000) + " seconds.");
    throw new Error("Could not reach Canvas at " + apiBase(s.url) + " — " + e.message);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  if (isRateLimited(res, text)) {
    const e = new Error("Canvas is rate limiting this token. Try again shortly.");
    e.rateLimited = true;
    throw e;
  }

  if (res.status === 401) {
    throw new Error("Canvas rejected the access token. It may have been revoked, expired, or it belongs to a different Canvas site.");
  }
  if (res.status === 403) {
    throw new Error("The access token is valid but not permitted to read this. It needs an account role with permission to read courses, rosters and grades.");
  }
  if (res.status === 404) {
    throw new Error("Canvas returned 'not found' for " + url.pathname + ". Check the site address is this institution's Canvas.");
  }
  if (!res.ok) {
    throw new Error("Canvas returned HTTP " + res.status + ".");
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Almost always a login page: the address points at something that is not a
    // Canvas API, and saying so is far more use than a JSON parse error.
    throw new Error("That address did not return Canvas API data. Check it is the institution's Canvas site address, e.g. https://yourcollege.instructure.com");
  }

  return { data, linkHeader: res.headers.get("link") };
}

/**
 * Follow Canvas's RFC5988 `Link` header to the end of a collection.
 *
 * The `next` URL is treated as OPAQUE and re-requested verbatim. Several Canvas
 * endpoints paginate by bookmark rather than page number, so rebuilding the URL from
 * a counter silently returns the same page forever. `rel="last"` is frequently absent
 * — Canvas omits it when counting rows is expensive — so nothing here may depend on
 * knowing the total, and a page shorter than PER_PAGE is not evidence of the end.
 */
function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return null;
}

async function paginate(path, params = {}, opts = {}) {
  const out = [];
  let next = null;
  let page = 0;
  // A guard, not a limit anybody reaches: 200 pages at 100 per page is 20,000 rows
  // from one endpoint. Without it a malformed `next` that points at itself loops for
  // as long as the process lives.
  const MAX_PAGES = 200;

  for (;;) {
    const { data, linkHeader } = await get(next || path, next ? {} : { per_page: PER_PAGE, ...params }, opts);
    if (Array.isArray(data)) out.push(...data);
    else if (data) out.push(data);

    next = nextLink(linkHeader);
    if (!next || ++page >= MAX_PAGES) break;
  }
  return out;
}

/**
 * Does this college's Canvas configuration work?
 *
 * TWO calls, because they answer different questions and only the pair is useful.
 * `users/self` succeeds for ANY Canvas user, a student included, so on its own it
 * proves the token is live and nothing else. The sync needs to read the account's
 * courses, which is an admin capability. Reporting them separately means an
 * administrator whose token works but lacks reach gets told exactly that, rather than
 * a flat "connected" followed by an empty sync they cannot explain.
 */
async function testConnection() {
  await cfg.load("canvas");
  const s = settings();
  if (!s) return { ok: false, note: "Not configured — a Canvas site address and an access token are both required." };

  let me;
  try {
    ({ data: me } = await get("/users/self", {}, { settings: s, timeoutMs: 15_000 }));
  } catch (e) {
    return { ok: false, note: e.message };
  }

  const who = me?.name || me?.short_name || "an unnamed user";
  const login = me?.login_id ? " (" + me.login_id + ")" : "";

  try {
    const { data: accounts } = await get("/accounts", { per_page: 1 }, { settings: s, timeoutMs: 15_000 });
    if (Array.isArray(accounts) && accounts.length) {
      return { ok: true, note: "Connected to " + (accounts[0].name || "Canvas") + " as " + who + login + "." };
    }
    // Token valid, no account visible. Deliberately ok:false — a sync configured this
    // way runs, finds nothing, and reports success, which is the most confusing
    // possible outcome for whoever set it up.
    return {
      ok: false,
      note: "The token works and belongs to " + who + login + ", but that user is not an account administrator, so no courses are visible to it. Generate the token from an account with permission to read courses, rosters and grades.",
    };
  } catch (e) {
    return { ok: false, note: "Signed in as " + who + login + ", but the account list could not be read — " + e.message };
  }
}

module.exports = {
  key: "canvas",
  label: "Canvas",
  isConfigured,
  testConnection,
  get,
  paginate,
  apiBase,
  isRateLimited,
  nextLink,
  MAX_CONCURRENCY,
  PER_PAGE,
};
