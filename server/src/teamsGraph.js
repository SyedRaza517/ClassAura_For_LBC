// Teams meeting attendance, via Microsoft Graph (app-only / client credentials).
//
// The token-acquisition and fetch pattern here is sharepoint.js's, deliberately —
// plain fetch, no @azure/* and no MSAL (see that file's header for why), a cached
// token renewed 60s early, Graph's { error: { code, message } } surfaced verbatim so
// an admin can act rather than guess. It is a SEPARATE module with SEPARATE
// credentials (cfg.peek("teams")) because the two app registrations carry different
// permission grants — see integrationConfig.js.
//
// Originally EVERYTHING here was read-only against Microsoft: calendars, meeting ids,
// attendance reports, nothing ever written back. The Teams automation feature (class
// meeting creation/update/cancellation, Team + channel provisioning, membership sync)
// added the write operations below the read ones — same credentials, same app
// registration, because Graph does not split "read a calendar" and "create an event"
// across separate app registrations the way it splits Calendars vs Sites permissions.
//
// THE FIXTURES SEAM. When TEAMS_GRAPH_FIXTURES names a JSON file, every exported
// call answers from that file and the network is never touched. This is how the
// smoke suite drives the whole pipeline without a Microsoft tenant: the suite writes
// fixtures, POSTs /teams-attendance/sync, and reads back what the API wrote. Read
// FRESH on every call (no cache) so one suite can play several scenarios.
//
// THE JOURNAL. A fixture run has no real Graph to check against, so a write operation
// in fixture mode also appends one JSON line `{ op, args }` to the file named by
// TEAMS_GRAPH_JOURNAL (created if missing) — the smoke suite's only way to assert
// "a meeting was created with these attendees" without a tenant to look inside. Reads
// (getChannelEmail, resolveUserId, resolveCreatorId, resolveOrganizers) do not journal:
// they observe state rather than change it, and journalling them would let a suite
// mistake "we looked" for "we wrote". The production guard already lives on fixtures()
// below (NODE_ENV === "production" forces it null) — every write op below reaches its
// journal line only through that same fixtures() result, so there is exactly one guard
// to keep correct, not two copies of it.
const cfg = require("./integrationConfig");
const { readFileSync, appendFileSync } = require("node:fs");

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

// Appends one write op to TEAMS_GRAPH_JOURNAL, if set. Only ever called from inside a
// fixture-mode branch (i.e. after fixtures() has already returned non-null), which is
// what makes the NODE_ENV guard on fixtures() sufficient here too — this function
// itself carries no production check because it is unreachable in production by
// construction, not by a second copy of the same test.
function journal(op, args) {
  const path = process.env.TEAMS_GRAPH_JOURNAL;
  if (!path) return;
  appendFileSync(path, JSON.stringify({ op, args }) + "\n");
}

// Fixture-mode fixed ids are derived from names rather than random, so a suite that
// creates "Tuesday BTEC IT" twice (retry, or two runs against the same fixture file)
// gets the same id back both times instead of silently multiplying fixture rows.
const slug = (s) => String(s || "")
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

// Microsoft Graph recurrence uses lowercase English weekday names. Parse the date as
// UTC (append T00:00:00Z) so the weekday never drifts by one near midnight on a host in
// a behind-UTC timezone — our date strings are calendar dates, not instants.
const GRAPH_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function graphWeekday(date) {
  return GRAPH_WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
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
let cachedCreator = null; // { email, id } | null — forgotten alongside cachedOrganizers

function forgetCached() { cachedToken = null; cachedOrganizers = null; cachedCreator = null; }

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

/** The calendar date (YYYY-MM-DD) of a Graph attendance report's meetingStartDateTime. */
function localDateFromGraph(dt) {
  // attendanceReport.meetingStartDateTime arrives in UTC; convert to the app zone's date.
  return new Date(dt).toLocaleDateString("en-CA", { timeZone: ZONE });
}

/** Merge a report's attendanceRecords into one entry per person, intervals concatenated. */
function mergeRecords(records) {
  const byKey = new Map();
  for (const rec of records || []) {
    const email = String(rec.emailAddress || (rec.identity && rec.identity.user && rec.identity.user.email) || "").toLowerCase();
    const msUserId = (rec.identity && rec.identity.user && rec.identity.user.id) || null;
    const key = msUserId || email;
    if (!key) continue; // an anonymous dial-in is not evidence about any student
    if (!byKey.has(key)) byKey.set(key, { email, msUserId, intervals: [] });
    for (const iv of rec.attendanceIntervals || []) {
      byKey.get(key).intervals.push({ joinedAt: zonedTime(iv.joinDateTime), leftAt: zonedTime(iv.leaveDateTime) });
    }
  }
  return [...byKey.values()];
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

/**
 * The account that CREATES class meetings and OWNS new class Teams (Task 4's
 * `creatorAccount` setting). Defaults to the first organizer account so a college
 * that only ever filled in organizerAccounts — and never notices this newer field —
 * keeps working exactly as before rather than ending up with no creator at all.
 */
function creatorEmail() {
  return cfg.peek("teams").creatorAccount?.trim() || ORGANIZERS()[0] || "";
}

/** creatorEmail() resolved to its Entra user id, cached for the process like resolveOrganizers(). */
async function resolveCreatorId() {
  const email = creatorEmail();
  if (!email) return null;
  const fx = fixtures();
  if (fx) return (fx.users || {})[email.toLowerCase()] ?? null;
  if (cachedCreator && cachedCreator.email === email) return cachedCreator.id;
  const u = await graphFetch(`/users/${encodeURIComponent(email)}?$select=id`);
  cachedCreator = { email, id: u.id };
  return cachedCreator.id;
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

/**
 * One entry per attendance report (i.e. per held occurrence of a recurring meeting),
 * tagged with the report's own DATE. This is what makes a single recurring join URL
 * safe: without the per-report date, all weeks' intervals merge into one set and a
 * student present in any week is credited to every week (the bug the design doc warns
 * of). Each report's records are merged per person by mergeRecords.
 */
async function attendanceByOccurrence(organizerId, meetingId) {
  const fx = fixtures();
  if (fx) {
    if (!(meetingId in (fx.attendanceByOccurrence || {}))) throw new Error("fixture: no report");
    return fx.attendanceByOccurrence[meetingId];
  }
  const reports = await graphFetch(`/users/${organizerId}/onlineMeetings/${meetingId}/attendanceReports`);
  const out = [];
  for (const r of reports.value || []) {
    const recs = await graphFetch(`/users/${organizerId}/onlineMeetings/${meetingId}/attendanceReports/${r.id}/attendanceRecords`);
    out.push({ date: localDateFromGraph(r.meetingStartDateTime), intervals: mergeRecords(recs.value || []) });
  }
  return out;
}

// --- Write operations (Teams automation) ------------------------------------------
// Everything below actually changes something in the tenant: a calendar event, a
// Team, a channel, a membership. Each follows the same shape — fixture branch first
// (fixed id, journal the call, return), real Graph call second — so a diff against
// the read functions above stays easy to spot-check.

/**
 * Schedules one online class as a calendar event on the organizer's own calendar.
 * `isOnlineMeeting` + `onlineMeetingProvider: "teamsForBusiness"` is what turns a
 * plain event into a Teams meeting; Graph creates the underlying online meeting
 * itself, so there is no separate POST to /onlineMeetings to make first.
 */
async function createClassMeeting({ organizerId, subject, date, startTime, endTime, attendeeEmails }) {
  const fx = fixtures();
  if (fx) {
    const id = `cal-${slug(subject)}`;
    const joinUrl = `https://teams.microsoft.com/l/meetup-join/fixture-${slug(subject)}`;
    journal("createClassMeeting", { organizerId, subject, date, startTime, endTime, attendeeEmails });
    return { calendarEventId: id, joinUrl };
  }
  const body = {
    subject,
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
    start: { dateTime: `${date}T${startTime}:00`, timeZone: ZONE },
    end: { dateTime: `${date}T${endTime}:00`, timeZone: ZONE },
    attendees: (attendeeEmails || []).map((address) => ({ emailAddress: { address }, type: "required" })),
  };
  const event = await graphFetch(`/users/${organizerId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let joinUrl = event.onlineMeeting && event.onlineMeeting.joinUrl;
  if (!joinUrl) {
    // Teams attaches the join URL to the event asynchronously on Microsoft's side —
    // a request that wins the race can see the creation response come back before
    // that happens. One re-GET catches the ordinary case; if it's STILL missing,
    // something is actually wrong (the tenant rejected the online-meeting provider,
    // say) and the caller needs to know rather than silently store an event nobody
    // can join.
    const refetched = await graphFetch(`/users/${organizerId}/events/${event.id}?$select=onlineMeeting`);
    joinUrl = refetched.onlineMeeting && refetched.onlineMeeting.joinUrl;
  }
  if (!joinUrl) {
    throw new Error(`Created the calendar event for "${subject}" but Microsoft never attached a Teams join URL to it.`);
  }
  return { calendarEventId: event.id, joinUrl };
}

/** Rewrites a class meeting this system created (time, subject or roster changed). */
async function updateClassMeeting({ organizerId, calendarEventId, subject, date, startTime, endTime, attendeeEmails }) {
  const fx = fixtures();
  if (fx) {
    journal("updateClassMeeting", { organizerId, calendarEventId, subject, date, startTime, endTime, attendeeEmails });
    return;
  }
  const body = {
    subject,
    start: { dateTime: `${date}T${startTime}:00`, timeZone: ZONE },
    end: { dateTime: `${date}T${endTime}:00`, timeZone: ZONE },
    attendees: (attendeeEmails || []).map((address) => ({ emailAddress: { address }, type: "required" })),
  };
  await graphFetch(`/users/${organizerId}/events/${calendarEventId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Removes a class meeting this system created (the class was cancelled/rescheduled off it). */
async function cancelClassMeeting({ organizerId, calendarEventId }) {
  const fx = fixtures();
  if (fx) {
    journal("cancelClassMeeting", { organizerId, calendarEventId });
    return;
  }
  try {
    await graphFetch(`/users/${organizerId}/events/${calendarEventId}`, { method: "DELETE" });
  } catch (e) {
    // A 404 means the event is already gone — deleted by hand in Outlook, or this is
    // a second cancel racing a first one that already succeeded. Either way the
    // outcome the caller wants (no meeting left on the calendar) already holds, so
    // this is success rather than failure. Anything else (wrong permissions, a Graph
    // outage) is a real problem and still has to surface.
    if (e.status !== 404) throw e;
  }
}

/**
 * Schedules ONE recurring online class as a weekly calendar event on the organizer's
 * calendar. Same isOnlineMeeting/teamsForBusiness shape as createClassMeeting, plus a
 * weekly recurrence bounded by an explicit end date — the series' last occurrence, so
 * the meeting can never out-run or under-run the real lessons. start/end carry the FIRST
 * occurrence's wall-clock; the pattern repeats it.
 */
async function createRecurringClassMeeting({ organizerId, subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails }) {
  const fx = fixtures();
  if (fx) {
    const id = `cal-series-${slug(subject)}-${firstDate}`;
    const joinUrl = `https://teams.microsoft.com/l/meetup-join/fixture-series-${slug(subject)}-${firstDate}`;
    journal("createRecurringClassMeeting", { organizerId, subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails });
    return { calendarEventId: id, joinUrl };
  }
  const body = {
    subject,
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
    start: { dateTime: `${firstDate}T${startTime}:00`, timeZone: ZONE },
    end: { dateTime: `${firstDate}T${endTime}:00`, timeZone: ZONE },
    attendees: (attendeeEmails || []).map((address) => ({ emailAddress: { address }, type: "required" })),
    recurrence: {
      pattern: { type: "weekly", interval: 1, daysOfWeek: weekdays },
      range: { type: "endDate", startDate: firstDate, endDate: lastDate },
    },
  };
  const event = await graphFetch(`/users/${organizerId}/events`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let joinUrl = event.onlineMeeting && event.onlineMeeting.joinUrl;
  if (!joinUrl) {
    const refetched = await graphFetch(`/users/${organizerId}/events/${event.id}?$select=onlineMeeting`);
    joinUrl = refetched.onlineMeeting && refetched.onlineMeeting.joinUrl;
  }
  if (!joinUrl) throw new Error(`Created the recurring event for "${subject}" but Microsoft never attached a Teams join URL to it.`);
  return { calendarEventId: event.id, joinUrl };
}

/** Rewrites the recurring series master this system created (times, subject, range, roster changed). */
async function updateRecurringClassMeeting({ organizerId, calendarEventId, subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails }) {
  const fx = fixtures();
  if (fx) { journal("updateRecurringClassMeeting", { organizerId, calendarEventId, subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails }); return; }
  const body = {
    subject,
    start: { dateTime: `${firstDate}T${startTime}:00`, timeZone: ZONE },
    end: { dateTime: `${firstDate}T${endTime}:00`, timeZone: ZONE },
    attendees: (attendeeEmails || []).map((address) => ({ emailAddress: { address }, type: "required" })),
    recurrence: {
      pattern: { type: "weekly", interval: 1, daysOfWeek: weekdays },
      range: { type: "endDate", startDate: firstDate, endDate: lastDate },
    },
  };
  await graphFetch(`/users/${organizerId}/events/${calendarEventId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

/**
 * Promotes the teaching staff to Teams co-organizers on an online meeting. Needs the
 * OnlineMeetings.ReadWrite.All application permission (see TEAMS_SETUP.md). Idempotent:
 * re-writing the same roles is harmless, so the caller gates on coorganizersSetAt rather
 * than this refusing. Empty coorganizerUserIds is a no-op (nobody to promote).
 */
async function setMeetingCoorganizers({ organizerId, meetingId, coorganizerUserIds }) {
  const fx = fixtures();
  if (fx) { journal("setMeetingCoorganizers", { organizerId, meetingId, coorganizerUserIds }); return; }
  if (!meetingId || !coorganizerUserIds || !coorganizerUserIds.length) return;
  const body = {
    participants: {
      attendees: coorganizerUserIds.map((id) => ({
        identity: { "@odata.type": "#microsoft.graph.identitySet", user: { "@odata.type": "#microsoft.graph.identity", id } },
        role: "coorganizer",
      })),
    },
  };
  await graphFetch(`/users/${organizerId}/onlineMeetings/${meetingId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

/**
 * Provisions a new Team from the standard template, owned by `ownerUserId`. Graph
 * answers 202 with a Location header rather than the team itself, because team
 * creation is genuinely asynchronous on Microsoft's side — the underlying Microsoft
 * 365 Group, SharePoint site and Teams-specific resources are provisioned by a
 * backend job, not inline in the request. So the group id has to be recovered by
 * polling the operation Graph handed back, bounded to a handful of short waits: a
 * real create finishes in a few seconds, and an unattended automation run should
 * fail loudly rather than hang if that job stalls.
 */
async function createTeam({ displayName, ownerUserId }) {
  const fx = fixtures();
  if (fx) {
    const groupId = `team-${slug(displayName)}`;
    journal("createTeam", { displayName, ownerUserId });
    return { groupId };
  }
  await cfg.load("teams");
  const token = await getAccessToken();
  const body = {
    "template@odata.bind": "https://graph.microsoft.com/v1.0/teamsTemplates('standard')",
    displayName,
    members: [{
      "@odata.type": "#microsoft.graph.aadUserConversationMember",
      roles: ["owner"],
      "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${ownerUserId}')`,
    }],
  };
  let res;
  try {
    res = await fetch(`${GRAPH_BASE}/teams`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Could not reach Microsoft Graph (POST /teams) creating "${displayName}": ${e.message}`);
  }
  if (res.status !== 202) {
    const raw = await res.text().catch(() => "");
    throw new Error(`Creating the Team "${displayName}" failed (HTTP ${res.status}): ${raw.slice(0, 300)}`);
  }
  const location = res.headers.get("location");
  if (!location) {
    throw new Error(`Creating the Team "${displayName}" returned 202 but no Location header to poll for the result.`);
  }
  // graphFetch always prefixes GRAPH_BASE — strip it back off if Graph handed back an
  // absolute URL (it does), so the poll below goes through the same helper (and its
  // error surfacing) as everything else in this file rather than a second raw fetch.
  let opPath = location.startsWith(GRAPH_BASE) ? location.slice(GRAPH_BASE.length) : location;
  if (!opPath.startsWith("/")) opPath = `/${opPath}`;

  const MAX_POLLS = 5;
  for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const op = await graphFetch(opPath);
    if (op && op.status === "succeeded" && op.targetResourceId) {
      return { groupId: op.targetResourceId };
    }
    if (op && op.status === "failed") {
      throw new Error(`Creating the Team "${displayName}" failed: ${(op.error && op.error.message) || "Graph reported failure with no further detail"}.`);
    }
    // status is "notStarted" or "running" — keep polling.
  }
  throw new Error(`Creating the Team "${displayName}" had not finished after ${MAX_POLLS} polls — check the Teams admin center for a stuck provisioning operation.`);
}

/** Adds a channel to an already-provisioned Team. */
async function createChannel({ groupId, displayName }) {
  const fx = fixtures();
  if (fx) {
    const channelId = `chan-${slug(displayName)}`;
    journal("createChannel", { groupId, displayName });
    return { channelId };
  }
  const channel = await graphFetch(`/teams/${groupId}/channels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName, membershipType: "standard" }),
  });
  return { channelId: channel.id };
}

/** A channel's own email address, for routing (e.g. forwarding). Read, not a write — no journal. */
async function getChannelEmail({ groupId, channelId }) {
  const fx = fixtures();
  if (fx) return (fx.channelEmails || {})[channelId] ?? null;
  const channel = await graphFetch(`/teams/${groupId}/channels/${channelId}?$select=email`);
  return channel.email || null;
}

/** Adds one user to a Team, as owner or ordinary member. Additive-only — never removes anyone. */
async function addTeamMember({ groupId, userId, owner }) {
  const fx = fixtures();
  if (fx) {
    journal("addTeamMember", { groupId, userId, owner });
    return;
  }
  const body = {
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    roles: owner ? ["owner"] : [],
    "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${userId}')`,
  };
  try {
    await graphFetch(`/teams/${groupId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Provisioning is additive-only and this runs on every sync (constraints.md), so
    // the SAME roster gets re-added every time — a teacher's class list barely
    // changes week to week, but this call fires for all of it regardless. Graph
    // answers "already a member" with a 400 or a 409 depending on exactly how the
    // duplicate collides, and both mean the desired end state (this person is a
    // member) already holds. Treating them as failure would block everyone ELSE in
    // the same batch behind someone who was already fine.
    //
    // BUT A 400 IS NOT ALWAYS THAT ONE THING, and swallowing every 400 here (as this
    // used to) hides a real failure mode: a STALE CACHED msUserId. resolveAndCacheMsId
    // resolves a person's email to a Microsoft user id once and caches it; if that
    // Entra account is later deleted or replaced (a leaver, a re-provisioned account),
    // Graph answers 400 for "user@odata.bind does not resolve to a member of this
    // tenant" — a genuine failure that means this person was NEVER added, not that they
    // already were. Swallowing that unconditionally would have this run report success
    // while quietly adding nobody, for as long as the stale id stays cached. So only a
    // 400 whose Graph error TEXT actually reads as a duplicate is treated as the
    // harmless case; anything else throws, and resolveAndCacheMsId's caller reports it
    // in `issues` (constraints.md: "unmatched people are reported, never guessed") so a
    // human sees the stale id rather than a false all-clear. 409 stays unconditional —
    // Graph does not appear to use it for anything else on this endpoint, so there is
    // no ambiguous case on that status code to guard against.
    if (e.status === 409) return;
    if (e.status === 400 && /already|duplicate|conflict/i.test(e.message || "")) return;
    throw e;
  }
}

/** An Entra user id from an email, or null if there is no such user. Read — no journal. */
async function resolveUserId(email) {
  const fx = fixtures();
  if (fx) return (fx.users || {})[String(email || "").toLowerCase()] ?? null;
  try {
    const u = await graphFetch(`/users/${encodeURIComponent(email)}?$select=id`);
    return u.id;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** The Settings screen's Test button: names the failing step, not just "failed". */
async function testConnection() {
  // Prime the saved-credentials cache BEFORE the synchronous isConfigured() gate,
  // exactly as sharepoint.js's testConnection does. Without this, a cold process
  // answers "Not configured" to the very Test press that follows Save — peek() falls
  // back to the environment, which on a deployed server carries no TEAMS_* variables —
  // and the admin is told their freshly saved credentials do not exist. Found by the
  // 12 Sep end-to-end UI run, not by the smoke suites, whose /test calls happened to
  // follow other requests that had already primed the cache.
  await cfg.load("teams");
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
  resolveOrganizers, calendarView, resolveMeetingId, attendanceIntervals, attendanceByOccurrence, graphFetch,
  // Teams automation (Task 2): writes, plus the reads they depend on.
  createClassMeeting, updateClassMeeting, cancelClassMeeting,
  createRecurringClassMeeting, updateRecurringClassMeeting, setMeetingCoorganizers,
  createTeam, createChannel, getChannelEmail, addTeamMember, resolveUserId,
  // Teams automation (Task 4): the creator-account setting.
  creatorEmail, resolveCreatorId,
  // Task 2: weekday helper for recurring meetings.
  graphWeekday,
  // Task 4: per-occurrence attendance helpers.
  mergeRecords, localDateFromGraph,
};
