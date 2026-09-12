// Teams meeting attendance, via Microsoft Graph (app-only / client credentials).
//
// The token-acquisition and fetch pattern here is sharepoint.js's, deliberately —
// plain fetch, no @azure/* and no MSAL (see that file's header for why), a cached
// token renewed 60s early, Graph's { error: { code, message } } surfaced verbatim so
// an admin can act rather than guess. It is a SEPARATE module with SEPARATE
// credentials (cfg.peek("teams")) because the two app registrations carry different
// permission grants — see integrationConfig.js.
//
// EVERYTHING here is read-only against Microsoft: calendars, meeting ids, attendance
// reports. Nothing is ever written back.
//
// THE FIXTURES SEAM. When TEAMS_GRAPH_FIXTURES names a JSON file, every exported
// call answers from that file and the network is never touched. This is how the
// smoke suite drives the whole pipeline without a Microsoft tenant: the suite writes
// fixtures, POSTs /teams-attendance/sync, and reads back what the API wrote. Read
// FRESH on every call (no cache) so one suite can play several scenarios.
const cfg = require("./integrationConfig");
const { readFileSync } = require("node:fs");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const ZONE = require("./clock").ZONE;

const TENANT_ID = () => cfg.peek("teams").tenantId || "";
const CLIENT_ID = () => cfg.peek("teams").clientId || "";
const CLIENT_SECRET = () => cfg.peek("teams").clientSecret || "";
const ORGANIZERS = () => String(cfg.peek("teams").organizerAccounts || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function fixtures() {
  // Unreachable in production, whatever the environment happens to carry. This seam
  // REPLACES Graph authentication entirely — every exported call below answers from a
  // JSON file instead of asking Microsoft anything — so a production process that
  // somehow inherited a stray TEAMS_GRAPH_FIXTURES (a copy-pasted .env, a variable left
  // set on a service after a smoke run) must not be able to have every "real" sync
  // silently answer from a file on disk and write fabricated marks onto real students'
  // registers. NODE_ENV, not a config flag, because it is the one signal that cannot be
  // saved through Settings by anyone — the same reason auth.js refuses to start without
  // a JWT_SECRET only in production rather than trusting a value that could be toggled.
  if (process.env.NODE_ENV === "production") return null;
  const path = process.env.TEAMS_GRAPH_FIXTURES;
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new Error(`TEAMS_GRAPH_FIXTURES is set but unreadable: ${e.message}`); }
}

function isConfigured() {
  return Boolean(TENANT_ID() && CLIENT_ID() && CLIENT_SECRET() && ORGANIZERS().length);
}

function describe() {
  if (!isConfigured()) return "not configured (Teams attendance needs tenantId, clientId, clientSecret and at least one organizer account)";
  return `Teams attendance (${ORGANIZERS().length} organizer account(s))`;
}

let cachedToken = null; // { value, expiresAt } | null
let cachedOrganizers = null; // [{ email, id }] | null — forgotten on credential change

function forgetCached() { cachedToken = null; cachedOrganizers = null; }

// --- Access token (client-credentials grant, cached) -----------------------------
// Sharepoint.js's getAccessToken (sharepoint.js:142-200) in shape: prime config, reuse
// an unexpired cached token, otherwise POST the client-credentials grant to Microsoft's
// login endpoint and cache the result, renewed 60s early. TEAMS_* names replace SP_*
// in the error messages because these are a different app registration's credentials.
async function getAccessToken() {
  await cfg.load("teams");
  if (cachedToken && cachedToken.value && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const tenant = TENANT_ID();
  if (!tenant || !CLIENT_ID() || !CLIENT_SECRET()) {
    throw new Error("Teams credentials are not configured (set TEAMS_TENANT_ID, TEAMS_CLIENT_ID and TEAMS_CLIENT_SECRET).");
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    grant_type: "client_credentials",
    // ".default" asks for exactly the application permissions granted to the app
    // registration in Azure AD — you don't list scopes for app-only, you consent to them
    // once as an admin and ".default" says "give me all of those".
    scope: "https://graph.microsoft.com/.default",
  });

  let res;
  try {
    res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    throw new Error(`Could not reach Microsoft's login endpoint to get a Teams token: ${e.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    // Azure returns a JSON body with error + error_description that names the actual
    // problem (wrong secret, wrong tenant, consent not granted…). Surface it so an admin
    // can act rather than guess.
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      if (j.error_description || j.error) detail = `${j.error || ""}: ${j.error_description || ""}`.trim();
    } catch (_) { /* not JSON — keep the raw snippet */ }
    throw new Error(`Failed to get a Teams access token (HTTP ${res.status}). Check TEAMS_TENANT_ID / TEAMS_CLIENT_ID / TEAMS_CLIENT_SECRET and that admin consent was granted. ${detail}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Microsoft's token endpoint returned a non-JSON response (HTTP ${res.status}).`); }
  if (!data.access_token) {
    throw new Error("Microsoft's token endpoint did not return an access_token.");
  }

  const ttlSeconds = Number(data.expires_in) || 3600;
  const nextToken = {
    value: data.access_token,
    // Renew 60s early so a request never sets out with a token about to expire.
    expiresAt: Date.now() + Math.max(0, ttlSeconds - 60) * 1000,
  };
  cachedToken = nextToken;
  return nextToken.value;
}

// --- Graph fetch helper ----------------------------------------------------------
// Sharepoint.js's graphFetch (sharepoint.js:207-247) in shape: attach the bearer
// token, call Graph, throw a clear admin-facing error on any non-2xx. err.status is
// kept on the thrown error — the sync (Task 7/8) branches on 404 the same way
// sharepoint's folder resolution does.
async function graphFetch(path, init = {}) {
  await cfg.load("teams");
  const token = await getAccessToken();
  let res;
  try {
    res = await fetch(`${GRAPH_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
    });
  } catch (e) {
    throw new Error(`Could not reach Microsoft Graph (${init.method || "GET"} ${path}): ${e.message}`);
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // Graph errors are JSON shaped as { error: { code, message } }. Prefer that message;
    // fall back to a snippet of whatever came back.
    let detail = raw.slice(0, 300);
    try {
      const j = JSON.parse(raw);
      if (j.error && (j.error.message || j.error.code)) {
        detail = `${j.error.code || ""} ${j.error.message || ""}`.trim();
      }
    } catch (_) { /* not JSON — keep the raw snippet */ }
    const err = new Error(`Microsoft Graph request failed (HTTP ${res.status}) for ${init.method || "GET"} ${path}: ${detail}`);
    // Callers branch on the status — a 404 means "not there yet" — so carry it along.
    err.status = res.status;
    throw err;
  }

  // 204 No Content and empty bodies have nothing to parse.
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`Microsoft Graph returned a non-JSON response (HTTP ${res.status}) for ${path}.`); }
}

// YYYY-MM-DD + HH:MM in London from a Graph dateTime (which arrives in the timezone
// we ASK for — every calendarView request below sends Prefer: outlook.timezone, so
// no re-zoning arithmetic happens here; slicing the string is the whole job).
const dateOf = (dt) => String(dt || "").slice(0, 10);
const timeOf = (dt) => String(dt || "").slice(11, 16);

// attendanceRecords' joinDateTime/leaveDateTime are the ONE place Graph does not
// honour the Prefer: outlook.timezone header — they arrive in UTC regardless, unlike
// calendarView's start/end above. So this is a real timezone conversion (via
// clock.js's toLocaleTimeString idiom), not a slice, and it is used only here.
function zonedTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" });
}

/** The organizer accounts resolved to Entra user ids, cached for the process. */
async function resolveOrganizers() {
  const fx = fixtures();
  if (fx) return fx.organizers || [];
  if (cachedOrganizers) return cachedOrganizers;
  const out = [];
  for (const email of ORGANIZERS()) {
    const u = await graphFetch(`/users/${encodeURIComponent(email)}?$select=id,mail,userPrincipalName`);
    out.push({ email, id: u.id });
  }
  cachedOrganizers = out;
  return out;
}

/** Scheduled events carrying a Teams join URL on one organizer's calendar. */
async function calendarView(organizerId, fromDate, toDate) {
  const fx = fixtures();
  if (fx) return (fx.calendars || {})[organizerId] || [];
  const qs = new URLSearchParams({
    startDateTime: `${fromDate}T00:00:00`, endDateTime: `${toDate}T23:59:59`,
    $select: "subject,start,end,isOnlineMeeting,onlineMeeting", $top: "100",
  });
  const page = await graphFetch(`/users/${organizerId}/calendarView?${qs}`, {
    headers: { Prefer: `outlook.timezone="${ZONE}"` },
  });
  return (page.value || [])
    .filter((e) => e.isOnlineMeeting && e.onlineMeeting && e.onlineMeeting.joinUrl)
    .map((e) => ({
      subject: e.subject || "",
      date: dateOf(e.start && e.start.dateTime),
      startTime: timeOf(e.start && e.start.dateTime),
      endTime: timeOf(e.end && e.end.dateTime),
      joinUrl: e.onlineMeeting.joinUrl,
    }));
}

/** The stable onlineMeeting id behind a join URL — Graph's ONLY lookup key for it. */
async function resolveMeetingId(organizerId, joinUrl) {
  const fx = fixtures();
  if (fx) return (fx.meetingIds || {})[joinUrl] ?? null;
  const filter = `JoinWebUrl eq '${String(joinUrl).replace(/'/g, "''")}'`;
  const page = await graphFetch(`/users/${organizerId}/onlineMeetings?$filter=${encodeURIComponent(filter)}`);
  return page.value && page.value[0] ? page.value[0].id : null;
}

/** Every participant's join/leave intervals, merged across ALL attendance reports. */
async function attendanceIntervals(organizerId, meetingId) {
  const fx = fixtures();
  // A missing key is not "no attendance", it is "the report could not be read" — the
  // real Graph call two lines below throws on any non-2xx, and a fixture that answered
  // [] for an unlisted meeting was a fake success where the real API would have failed.
  // The sync (teamsSync.js) branches on this throw: NO marks on a failed fetch, only on
  // a successful one that happens to report nobody there. Task 10's smoke suite is what
  // this distinction exists to prove, hence the one-line change rather than leaving the
  // fixture branch answering the safe-looking [].
  if (fx) {
    if (!(meetingId in (fx.attendance || {}))) throw new Error("fixture: no report");
    return fx.attendance[meetingId];
  }
  const reports = await graphFetch(`/users/${organizerId}/onlineMeetings/${meetingId}/attendanceReports`);
  const byKey = new Map(); // email|msUserId -> { email, msUserId, intervals }
  for (const r of reports.value || []) {
    const recs = await graphFetch(`/users/${organizerId}/onlineMeetings/${meetingId}/attendanceReports/${r.id}/attendanceRecords`);
    for (const rec of recs.value || []) {
      const email = String(rec.emailAddress || (rec.identity && rec.identity.user && rec.identity.user.email) || "").toLowerCase();
      const msUserId = (rec.identity && rec.identity.user && rec.identity.user.id) || null;
      const key = msUserId || email;
      if (!key) continue; // an anonymous dial-in is not evidence about any student
      if (!byKey.has(key)) byKey.set(key, { email, msUserId, intervals: [] });
      for (const iv of rec.attendanceIntervals || []) {
        byKey.get(key).intervals.push({ joinedAt: zonedTime(iv.joinDateTime), leftAt: zonedTime(iv.leaveDateTime) });
      }
    }
  }
  return [...byKey.values()];
}

/** The Settings screen's Test button: names the failing step, not just "failed". */
async function testConnection() {
  if (!isConfigured()) return { ok: false, note: "Not configured — enter the tenant ID, client ID, client secret and at least one organizer account." };
  try {
    const organizers = await resolveOrganizers();
    // Prove the CALENDAR permission too — it is the one the Exchange policy gates,
    // and the one whose absence otherwise only surfaces at the first scheduled run.
    const today = require("./clock").localDate();
    await calendarView(organizers[0].id, today, today);
    return { ok: true, note: `Connected. ${organizers.length} organizer account(s) resolved and the first calendar is readable.` };
  } catch (e) {
    return { ok: false, note: e.message };
  }
}

module.exports = {
  isConfigured, describe, forgetCached, testConnection,
  resolveOrganizers, calendarView, resolveMeetingId, attendanceIntervals, graphFetch,
};
