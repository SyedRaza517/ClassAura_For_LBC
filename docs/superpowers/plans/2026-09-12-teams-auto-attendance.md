# Teams Auto-Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an online class ends, the server fetches the Teams meeting's attendance
report from Microsoft Graph and fills the register automatically — discovered from
dedicated organizer accounts' calendars, never overwriting a human's mark.

**Architecture:** A new `teams` provider (credentials + organizer-account list) reuses
the app-only Graph pattern proven in `sharepoint.js`. A sync engine (`teamsSync.js`)
runs inside the existing hourly scheduler: it matches the organizer calendars' meetings
to timetable sessions by date+start-time (title tiebreak), resolves join URLs to meeting
ids, pulls attendance records after each session ends, and writes marks through the same
invariants every other machine writer holds. All decisions are pure functions in
`teamsAttendance.js`, tested without a database or network.

**Tech Stack:** Node 22 (CommonJS in `server/src`), Express, Prisma + PostgreSQL, plain
`fetch` (NO `@azure/*`, NO MSAL — deliberate, see `sharepoint.js:1-7`), React 18 client.

**Spec:** `docs/superpowers/specs/2026-09-11-teams-auto-attendance-design.md` — read it
first; every decision below argues from it.

## Global Constraints

- **Never overwrite an existing `AttendanceMark`.** Machine writers use
  `createMany({ skipDuplicates: true })` or an existence check — a person's mark always
  wins (`moodleAttendance.js:11-15` is the precedent).
- **Null means "not measurable"; zero means zero.** An unmatched participant gets NO
  mark, never a guessed Absent. Absent is written only after a *successful* report fetch.
- **Dates and times are strings** (`YYYY-MM-DD`, `HH:MM`), London wall clock via
  `server/src/clock.js` (`localDate()`, `localTime()`). Never the host clock, never a
  stored UTC instant re-zoned at render.
- **Ships switched off:** `enabled: false` in `DEFAULTS`; a college turns it on in
  Settings.
- **Do not touch `HndSession` uniqueness** — two partial unique indexes exist in raw SQL
  that Prisma cannot see (`schema.prisma:1181-1213`);
  `timetabling/schema-contract.test.js` guards this.
- **Migrations:** raw SQL directory named `YYYYMMDDTHHMMSS_snake_name` under
  `server/prisma/migrations/`; NEVER rename an applied migration; forward-only
  (`migrate:deploy`, never `migrate dev`).
- **Every DB-touching command carries `DATABASE_URL` inline** pointing at local
  `postgresql://postgres:postgres@localhost:5432/edtech_dev` — the guard hook refuses
  otherwise. Never let it fall through to `server/.env`.
- **Comments explain WHY, at length** — house style; match the density of the files you
  edit.
- Unit tests: `node --test` with the glob form, e.g.
  `node --test src/teamsAttendance.test.js` from `server/` — never a bare directory.
- Commit messages: plain descriptive sentence (see `git log` style), ending with the
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task 1: Schema — new columns, TeamsSync table, migration

**Files:**
- Modify: `server/prisma/schema.prisma` (models `Student`, `HndSession`,
  `TimetableEvent`; new model `TeamsSync`; `TagTap` outcome comment)
- Create: `server/prisma/migrations/20260912T120000_teams_attendance/migration.sql`

**Interfaces:**
- Produces (later tasks rely on these exact names): `Student.msUserId String?`,
  `HndSession.teamsJoinUrl String?`, `HndSession.teamsMeetingId String?`,
  `HndSession.teamsOrganizerId String?`, `HndSession.teamsCollectedAt DateTime?`,
  `TimetableEvent.teamsJoinUrl String?`, model `TeamsSync` (same shape as `MoodleSync`).

- [ ] **Step 1: Edit `schema.prisma`.** Add to `Student` (beside `moodleUserId`, with a
  comment mirroring its — cached external id so later syncs re-use the match):

```prisma
  // The Microsoft (Entra) user this student was matched to by the Teams attendance
  // sync, so later syncs re-use the match instead of re-resolving by email every time.
  // Same job, same reasoning, as moodleUserId above.
  msUserId     String?
```

  and `@@unique([msUserId])` beside `@@unique([moodleUserId])`.

  Add to `HndSession` (after `moodleSessionId`, whose comment it should reference):

```prisma
  // The Teams meeting this register's class ran in. All four are NULL for a class
  // that was never online. joinUrl arrives by calendar discovery or by an admin's
  // paste on the timetable event; meetingId + organizerId are resolved from it once
  // (every Graph artifact fetch is addressed through the meeting's ORGANIZER);
  // collectedAt marks the attendance report as fetched and written, so the poller
  // knows this register is done. NULL collectedAt with a joinUrl set means "still
  // eligible" — the retry, bounded to 7 days, is simply that this stays NULL.
  teamsJoinUrl     String?
  teamsMeetingId   String?
  teamsOrganizerId String?
  teamsCollectedAt DateTime?
```

  Add to `TimetableEvent` (after `notes`):

```prisma
  // The rescue hatch: an admin pastes the Teams join link here when automatic
  // calendar matching could not place the meeting. Carried down to this event's
  // registers on publish, where an explicit paste always beats the matcher.
  teamsJoinUrl String @default("")
```

  Add model `TeamsSync` after `MoodleSync`, mirroring it:

```prisma
// One row per Teams attendance sync run — what was matched, written and skipped, and
// anything that needs a human (an unmatched meeting, a participant whose email fits no
// student). Same job and shape as MoodleSync above.
model TeamsSync {
  id         String    @id @default(cuid())
  startedAt  DateTime  @default(now())
  finishedAt DateTime?
  status     String    @default("running") // running | ok | failed
  mode       String    @default("manual") // manual | scheduled
  startedBy  String? // admin name, or null for the scheduled run
  // Counters, as JSON: meetingsDiscovered, sessionsMatched, sessionsAmbiguous,
  // reportsFetched, marksCreated, marksSkippedExisting, participantsUnmatched.
  summary    String    @default("{}")
  // Anything skipped or unmatched, as a JSON array of readable messages.
  issues     String    @default("[]")
  error      String?

  @@index([startedAt])
}
```

  In the `TagTap.outcome` vocabulary comment (`schema.prisma:1337-1354`), append a
  paragraph:

```prisma
  //
  //   ...and, since 12 Sep 2026, the Teams attendance sync (method "teams") writes:
  //   marked          — a mark was written from the meeting's attendance report
  //   already_marked  — the report agreed or disagreed with a mark that already stood;
  //                     either way the standing mark won
```

- [ ] **Step 2: Write the migration SQL** at
  `server/prisma/migrations/20260912T120000_teams_attendance/migration.sql`:

```sql
-- Teams auto-attendance: the meeting link on the timetable and the register, the
-- resolved meeting identity, the "report fetched" marker, the student's Microsoft id,
-- and the sync run log. All nullable / defaulted — a college that never configures
-- Teams sees no behaviour change (null means "not an online class", not zero).

ALTER TABLE "TimetableEvent" ADD COLUMN "teamsJoinUrl" TEXT NOT NULL DEFAULT '';

ALTER TABLE "HndSession" ADD COLUMN "teamsJoinUrl" TEXT;
ALTER TABLE "HndSession" ADD COLUMN "teamsMeetingId" TEXT;
ALTER TABLE "HndSession" ADD COLUMN "teamsOrganizerId" TEXT;
ALTER TABLE "HndSession" ADD COLUMN "teamsCollectedAt" TIMESTAMP(3);

-- Nullable, unique when present — exactly moodleUserId's shape and for its reason:
-- the first sync matches by email, caches the id, and every later sync matches by id.
ALTER TABLE "Student" ADD COLUMN "msUserId" TEXT;
CREATE UNIQUE INDEX "Student_msUserId_key" ON "Student"("msUserId");

CREATE TABLE "TeamsSync" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "mode" TEXT NOT NULL DEFAULT 'manual',
    "startedBy" TEXT,
    "summary" TEXT NOT NULL DEFAULT '{}',
    "issues" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    CONSTRAINT "TeamsSync_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TeamsSync_startedAt_idx" ON "TeamsSync"("startedAt");
```

- [ ] **Step 3: Apply and regenerate** (from `server/`):

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma migrate deploy
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma generate
```

Expected: `20260912T120000_teams_attendance` applied; client generated.

- [ ] **Step 4: Prove the contract test still passes** (the partial-index comment must
  be untouched), from `server/`:

```bash
node --test src/timetabling/schema-contract.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit** — `git add server/prisma && git commit` with a message like
  "The Teams attendance columns and run log, all nullable so nothing changes yet".

---

### Task 2: The `teams` provider — registry, Settings form, test dispatch

**Files:**
- Modify: `server/src/integrationConfig.js` (add to `PROVIDERS`)
- Modify: `server/src/routes/integrations.js:148-152` (test dispatch)
- Modify: `client/src/IntegrationSettings.jsx` (add to `FORMS`)

**Interfaces:**
- Produces: `cfg.peek("teams")` → `{ tenantId, clientId, clientSecret,
  organizerAccounts }` where `organizerAccounts` is a comma-separated email string.
- Consumes: nothing from other tasks (Task 3's `require("./../teamsGraph")` is added
  here in the dispatch but the module arrives in Task 3 — do Task 3's Step 1 stub first
  if executing this task in isolation, or accept the require failing until Task 3 lands;
  if running sequentially, just order Task 3 before starting the server).

- [ ] **Step 1: Add the provider** to `PROVIDERS` in `integrationConfig.js`, after
  `sharepoint` (note the existing comment at `:92-95` about the word "tenant" — it
  covers this entry too, say so):

```js
  // Microsoft Teams attendance. A SEPARATE app registration from SharePoint even
  // though both talk to Graph, because the two need different application permissions
  // (Sites.* vs Calendars.Read + OnlineMeetings.Read.All + OnlineMeetingArtifact.
  // Read.All) and a college may legitimately grant one and not the other — one Test
  // button must not vouch for two unrelated capabilities. The "tenant" note above
  // sharepoint applies here unchanged: it is Microsoft's directory id.
  //
  // organizerAccounts is a comma-separated list of the dedicated scheduling accounts
  // that CREATE every online class meeting (teachers are co-organizers and are never
  // read). Graph exposes a meeting's attendance only through its organizer, which is
  // why these accounts, and only these, are what the sync reads.
  teams: {
    label: "Teams attendance",
    secretField: "clientSecret",
    settingFields: ["tenantId", "clientId", "organizerAccounts"],
    env: {
      clientSecret: "TEAMS_CLIENT_SECRET", tenantId: "TEAMS_TENANT_ID",
      clientId: "TEAMS_CLIENT_ID", organizerAccounts: "TEAMS_ORGANIZER_ACCOUNTS",
    },
    describe: (s) => {
      const n = String(s.organizerAccounts || "").split(",").map((x) => x.trim()).filter(Boolean).length;
      return n ? `${n} organizer account${n === 1 ? "" : "s"}` : "no organizer accounts set";
    },
  },
```

- [ ] **Step 2: Extend the test dispatch** in `routes/integrations.js` (the chain at
  `:148-152`) with a `teams` branch:

```js
  const mod = provider === "moodle" ? require("./../moodle")
    : provider === "canvas" ? require("./../vle/canvas")
    : provider === "blackboard" ? require("./../vle/blackboard")
    : provider === "email" ? require("./../email")
    : provider === "teams" ? require("./../teamsGraph")
    : require("./../sharepoint");
```

- [ ] **Step 3: Add the client form** to `FORMS` in `IntegrationSettings.jsx`, after
  `sharepoint`:

```jsx
  teams: {
    label: "Teams attendance",
    blurb: "Reads who attended each online class from Microsoft Teams and fills the register automatically after the class ends. Read-only — nothing is written to Microsoft.",
    secret: { key: "clientSecret", label: "Client secret", hint: "From the app registration you created in Microsoft Entra ID for Teams attendance (separate from SharePoint's). See TEAMS_SETUP.md." },
    fields: [
      { key: "tenantId", label: "Directory (tenant) ID" },
      { key: "clientId", label: "Application (client) ID" },
      { key: "organizerAccounts", label: "Organizer accounts", placeholder: "scheduling@yourcollege.ac.uk, dept2@yourcollege.ac.uk", hint: "The dedicated accounts that CREATE your online class meetings, comma-separated. Teachers join as co-organizers and are never read. Meetings must be scheduled (not “Meet now”) from these accounts at the timetabled class time." },
    ],
    note: "Your Microsoft 365 admin must grant the app three application permissions (Calendars.Read, OnlineMeetings.Read.All, OnlineMeetingArtifact.Read.All) and scope them to these accounts with the two access policies in TEAMS_SETUP.md. Until then, Test connection will say exactly which step is missing.",
  },
```

- [ ] **Step 4: Run the existing integration smoke to prove nothing regressed** (root):

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-security-regressions
```

Expected: PASS (this suite exercises the integrations routes' auth).

- [ ] **Step 5: Commit** — "A teams provider row: its own app registration, because its
  Graph permissions are not SharePoint's".

---

### Task 3: `teamsGraph.js` — the Graph client, with a fixtures seam

**Files:**
- Create: `server/src/teamsGraph.js`

**Interfaces:**
- Produces (Tasks 7, 8, 10 rely on these exact signatures):
  - `isConfigured() -> boolean`
  - `describe() -> string`
  - `forgetCached() -> void`
  - `testConnection() -> Promise<{ ok: boolean, note: string }>`
  - `resolveOrganizers() -> Promise<Array<{ email: string, id: string }>>`
  - `calendarView(organizerId, fromDate, toDate) -> Promise<Array<{ subject, date, startTime, endTime, joinUrl }>>`
    (`fromDate`/`toDate` are `YYYY-MM-DD` London; returns only events that carry a
    Teams join URL; `date`/`startTime`/`endTime` converted to London strings)
  - `resolveMeetingId(organizerId, joinUrl) -> Promise<string|null>`
  - `attendanceIntervals(organizerId, meetingId) -> Promise<Array<{ email, msUserId, intervals: Array<{ joinedAt: string, leftAt: string }> }>>`
    (`joinedAt`/`leftAt` are `HH:MM` London; records merged across ALL attendance
    reports of the meeting, because a meeting restarted mid-class produces one report
    per stretch and dropping any would mark real attendees short)
- Fixture seam: when `process.env.TEAMS_GRAPH_FIXTURES` names a JSON file, every public
  function above serves canned answers from it and never touches the network. The smoke
  suite (Task 10) writes that file; the API under test reads it.

- [ ] **Step 1: Write the module.** Follow `sharepoint.js` line by line for the parts it
  already solved — copy the shape, not the code, and say in the header that the token
  and fetch pattern are its (plain fetch, no SDK, same reasons). Skeleton with the
  Graph-specific parts in full:

```js
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

async function getAccessToken() { /* sharepoint.js:142-200 verbatim in shape, with
  cfg.load("teams"), TEAMS_* names in the error messages, and the same 60s-early renewal. */ }

async function graphFetch(path, init = {}) { /* sharepoint.js:207-247 in shape, priming
  cfg.load("teams"); keep err.status on the thrown error — the sync branches on 404. */ }

// YYYY-MM-DD + HH:MM in London from a Graph dateTime (which arrives in the timezone
// we ASK for — every calendarView request below sends Prefer: outlook.timezone, so
// no re-zoning arithmetic happens here; slicing the string is the whole job).
const dateOf = (dt) => String(dt || "").slice(0, 10);
const timeOf = (dt) => String(dt || "").slice(11, 16);

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
  if (fx) return (fx.attendance || {})[meetingId] || [];
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
        byKey.get(key).intervals.push({ joinedAt: timeOf(iv.joinDateTime), leftAt: timeOf(iv.leaveDateTime) });
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
```

  Fill the two `/* … */` bodies from `sharepoint.js` as instructed in their comments.
  NOTE the Graph attendance-record interval fields are `joinDateTime` /
  `leaveDateTime` and arrive in **UTC** — attendance report timestamps do not honour
  the `Prefer` header the way calendarView does. Convert them with
  `new Date(x).toLocaleTimeString("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit" })`
  (the `clock.js` idiom) instead of slicing; write a small local `zonedTime(iso)`
  helper used by `attendanceIntervals` only, with a comment saying exactly this.

- [ ] **Step 2: Wire `forgetCached()` into the credentials save.** In
  `routes/integrations.js`, the PUT handler calls `cfg.invalidate(provider)` (line
  ~98). Immediately after it, add:

```js
  // A cached Graph token or organizer list survives a credentials change — the same
  // release valve sharepoint.js needs (see its forgetCached).
  if (provider === "teams") { try { require("./../teamsGraph").forgetCached(); } catch {} }
```

  (Check how/whether sharepoint's `forgetCached` is called there and mirror the
  existing pattern exactly if one exists.)

- [ ] **Step 3: Boot the server locally against the seeded DB and hit the test route**
  (or simply run the security smoke as in Task 2 Step 4) to prove the module loads and
  an unconfigured test answers `ok:false` with the "Not configured" note rather than
  throwing.

- [ ] **Step 4: Commit** — "A Graph client for Teams attendance, wearing sharepoint.js's
  proven shape, with a fixtures seam the smoke suite can drive".

---

### Task 4: `teamsAttendance.js` — the pure decisions, TDD

**Files:**
- Create: `server/src/teamsAttendance.js`
- Create: `server/src/teamsAttendance.test.js`

**Interfaces:**
- Consumes: `toMins`-style time handling — but implement locally (attendanceTap.js does
  not export `toMins`; re-implement the two-line parser with a comment saying it
  mirrors attendanceTap.js's).
- Produces (Task 7 relies on these exact signatures):
  - `parseJoinUrl(raw) -> string|null` — trims, validates it is a
    `https://teams.microsoft.com/l/meetup-join/...` URL, returns the canonical string
    (decoded → re-encoded is NOT attempted; the exact pasted/discovered string is the
    lookup key, so canonicalisation would break the Graph `$filter`). Null for
    anything else.
  - `matchMeeting(meeting, candidates) -> { kind: "one", id } | { kind: "ambiguous", ids } | { kind: "none" }`
    — `meeting`: `{ subject, date, startTime }`; `candidates`:
    `[{ id, date, startTime, title }]`. Same date AND same startTime narrows; if
    several remain, keep those whose `title` (case-insensitive) appears in the subject
    or vice-versa; one survivor → `one`, several → `ambiguous`, zero survivors of the
    title test → `ambiguous` (never guess), no time matches at all → `none`.
  - `attendedMinutes(intervals, session) -> { minutes, firstJoin }` — clips each
    `{ joinedAt, leftAt }` (HH:MM) to `[session.startTime, session.endTime]`, sums,
    merges overlaps (double joins must not double-count), returns total whole minutes
    and the earliest join (unclipped, HH:MM) or null when no interval parsed.
  - `decideStatus({ minutes, firstJoin, session, minAttendancePct, lateAfterMins }) ->
    { status: "P"|"L"|"A", remark: string }` — the spec's rules exactly: threshold on
    `minutes >= ceil((sessionMinutes * minAttendancePct) / 100)`; late when
    `firstJoin > startTime + lateAfterMins` (string compare after zero-padding, both
    ends inclusive on the P side, mirroring `attendanceTap.js:240`); below threshold →
    `A` with remark `"Joined N of M min"`; `firstJoin === null` → `A` with remark `""`.

- [ ] **Step 1: Write the failing tests** in `teamsAttendance.test.js` (node:test +
  assert, matching the style of `attendanceTap`'s neighbours). Cover at minimum:

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { parseJoinUrl, matchMeeting, attendedMinutes, decideStatus } = require("./teamsAttendance");

test("parseJoinUrl accepts a real meetup-join link and rejects everything else", () => {
  const url = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%2c%22Oid%22%3a%22o%22%7d";
  assert.equal(parseJoinUrl("  " + url + "  "), url);
  assert.equal(parseJoinUrl("https://example.com/x"), null);
  assert.equal(parseJoinUrl(""), null);
  assert.equal(parseJoinUrl(null), null);
});

test("matchMeeting: unique date+time match wins without any title help", () => {
  const r = matchMeeting({ subject: "anything", date: "2026-09-14", startTime: "09:00" },
    [{ id: "a", date: "2026-09-14", startTime: "09:00", title: "Databases" },
     { id: "b", date: "2026-09-14", startTime: "11:00", title: "Networks" }]);
  assert.deepEqual(r, { kind: "one", id: "a" });
});

test("matchMeeting: two classes at one time need the title, and no title match refuses", () => {
  const candidates = [
    { id: "a", date: "2026-09-14", startTime: "09:00", title: "Databases" },
    { id: "b", date: "2026-09-14", startTime: "09:00", title: "Networks" },
  ];
  assert.deepEqual(matchMeeting({ subject: "HND Databases week 3", date: "2026-09-14", startTime: "09:00" }, candidates), { kind: "one", id: "a" });
  assert.equal(matchMeeting({ subject: "Lecture", date: "2026-09-14", startTime: "09:00" }, candidates).kind, "ambiguous");
});

test("matchMeeting: nothing at that time is none, not ambiguous", () => {
  assert.equal(matchMeeting({ subject: "x", date: "2026-09-14", startTime: "13:00" },
    [{ id: "a", date: "2026-09-14", startTime: "09:00", title: "Databases" }]).kind, "none");
});

test("attendedMinutes clips to the session window and merges overlapping joins", () => {
  const session = { startTime: "09:00", endTime: "10:30" };
  // Joined early, left mid; rejoined overlapping; a stretch entirely after the end.
  const r = attendedMinutes([
    { joinedAt: "08:50", leftAt: "09:40" },   // clips to 09:00-09:40 = 40
    { joinedAt: "09:30", leftAt: "10:00" },   // overlap merges: 09:00-10:00 = 60 total
    { joinedAt: "11:00", leftAt: "11:30" },   // outside entirely = 0
  ], session);
  assert.equal(r.minutes, 60);
  assert.equal(r.firstJoin, "08:50");
});

test("attendedMinutes with no parseable interval is null firstJoin, zero minutes", () => {
  const r = attendedMinutes([], { startTime: "09:00", endTime: "10:00" });
  assert.equal(r.minutes, 0);
  assert.equal(r.firstJoin, null);
});

test("decideStatus: the threshold boundary is inclusive, lateness follows lateAfterMins", () => {
  const session = { startTime: "09:00", endTime: "10:30" }; // 90 min, 50% = 45
  const base = { session, minAttendancePct: 50, lateAfterMins: 10 };
  assert.equal(decideStatus({ ...base, minutes: 45, firstJoin: "09:05" }).status, "P");
  assert.equal(decideStatus({ ...base, minutes: 45, firstJoin: "09:10" }).status, "P"); // inclusive, like attendanceTap
  assert.equal(decideStatus({ ...base, minutes: 45, firstJoin: "09:11" }).status, "L");
  const a = decideStatus({ ...base, minutes: 44, firstJoin: "09:00" });
  assert.equal(a.status, "A");
  assert.equal(a.remark, "Joined 44 of 90 min");
  assert.equal(decideStatus({ ...base, minutes: 0, firstJoin: null }).status, "A");
});
```

- [ ] **Step 2: Run to verify failure** (from `server/`):

```bash
node --test src/teamsAttendance.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `teamsAttendance.js`** — pure, no requires beyond nothing at
  all. House-style header explaining why it is pure (the same argument as
  `attendanceTap.js:1-10`: every boundary case becomes an ordinary unit test). The
  matcher's refusal branch carries the spec's argument (never guess — a wrong automatic
  match writes wrong marks onto a real student's record). Interval merging: sort
  clipped `[from,to)` minute pairs, sweep, sum.

- [ ] **Step 4: Run to verify pass:** same command. Expected: all PASS.

- [ ] **Step 5: Commit** — "The Teams marking decisions, pure and tested: clip, merge,
  threshold, tiebreak, refuse".

---

### Task 5: The capture stamp — one line each side of the wire

**Files:**
- Modify: `server/src/attendanceTap.js:79-83` (the `SELF_CHECKIN_METHODS` map) and its
  constants block
- Modify: `client/src/checkInMethods.js` (read it first — mirror however nfc/qr/declared
  are labelled there)
- Check: run every test that pins stamps (`node --test "src/**/*.test.js"` from
  `server/`; also `client` unit tests if `checkInMethods` has one — see
  `client/src/checkInMethods.js`'s neighbours)

**Interfaces:**
- Produces: `TEAMS_AUTO_STAMP = "Auto check-in (Teams)"` exported from
  `attendanceTap.js`; token `"teams"` via the existing `checkInMethod()`.

- [ ] **Step 1: Add the constant and map entry** in `attendanceTap.js`, after
  `SELF_CHECKIN_DECLARED_STAMP`:

```js
// The FOURTH stamp: the machine observed the student in the online class.
//
// It sits in this map — "the student did this, not a member of staff" — because the
// underlying fact IS the student's own action: they joined the meeting, and Microsoft
// recorded when and for how long. What distinguishes it from its three neighbours is
// WHO WROTE THE ROW: no phone was tapped and no button pressed; the Teams attendance
// sync wrote it from the meeting's attendance report after the class ended. Borrowing
// the declared stamp was rejected for the same reason declared could not borrow NFC's:
// "what evidence stands behind this mark" has a different answer (a meeting-join
// record Microsoft holds, which is stronger than a declaration and weaker than a
// sticker), and the register, the live view and the dispute CSV all need to give it.
//
// Frozen on arrival, like its neighbours: the stamp is prose written into rows, the
// token crosses the wire into app builds not deployed in step with this server.
const TEAMS_AUTO_STAMP = "Auto check-in (Teams)";
```

  and in the map: `[TEAMS_AUTO_STAMP, "teams"],` — then export `TEAMS_AUTO_STAMP` from
  the `module.exports` list.

- [ ] **Step 2: Update the client mirror.** Read `client/src/checkInMethods.js`; add the
  `"teams"` token with a display label like `"Joined online (Teams)"`, following the
  file's exact existing shape. If a test beside it pins the token list, extend it.

- [ ] **Step 3: Run the full server unit tests** (some pin the stamp list):

```bash
node --test "src/**/*.test.js"
```

Expected: PASS (fix any stamp-pinning test by extending its expected list — the tests
exist to force exactly this deliberate step).

- [ ] **Step 4: Commit** — "The Teams stamp and token, one line in the map as promised".

---

### Task 6: `TeamsAttendanceConfig` — the switch and the threshold

**Files:**
- Create: `server/src/teamsAttendanceSettings.js` (pure merge/allowlist + DEFAULTS)
- Create: `server/src/teamsAttendanceSettings.test.js`
- Create: `server/src/teamsAttendanceConfig.js` (DB half)
- Modify: `server/prisma/schema.prisma` + new migration
  `server/prisma/migrations/20260912T121500_teams_attendance_config/migration.sql`

**Interfaces:**
- Produces: `teamsAttendanceConfig.get() -> Promise<{ enabled: boolean,
  minAttendancePct: number }>`; `save(patch, updatedBy)`; `invalidate()`.
  `DEFAULTS = { enabled: false, minAttendancePct: 50 }`.

The repo has an `add-config-table` skill for exactly this shape — invoke it if
available; it walks the singleton pattern end to end. The steps below are the same
content, self-contained.

- [ ] **Step 1: Schema + migration.** Add after `AttendanceTapConfig` in
  `schema.prisma`:

```prisma
// Whether the Teams attendance sync runs, and what "present" requires. Same shape as
// AttendanceTapConfig above (the reference implementation is AttendanceBandConfig):
// defaults in code with enabled:false, one JSON column merged over them, constant
// "singleton" key, allowlist on the way out, short cache invalidated on save.
model TeamsAttendanceConfig {
  id        String   @id @default("singleton")
  settings  Json     @default("{}")
  updatedBy String?
  updatedAt DateTime @updatedAt
}
```

  Migration SQL (`20260912T121500_teams_attendance_config/migration.sql`):

```sql
-- The Teams attendance switch and threshold. No row until the college edits
-- something; the code's defaults carry enabled:false, so an unconfigured college
-- behaves exactly as it did before this feature existed.
CREATE TABLE "TeamsAttendanceConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TeamsAttendanceConfig_pkey" PRIMARY KEY ("id")
);
```

  Apply + generate with the two inline-`DATABASE_URL` commands from Task 1 Step 3.

- [ ] **Step 2: Failing tests** for the pure half
  (`teamsAttendanceSettings.test.js`):

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { merge, DEFAULTS } = require("./teamsAttendanceSettings");

test("no stored settings yields the defaults, switched off", () => {
  assert.deepEqual(merge(undefined), { enabled: false, minAttendancePct: 50 });
  assert.equal(DEFAULTS.enabled, false);
});

test("a patch merges over a base without disturbing its neighbours", () => {
  assert.deepEqual(merge({ enabled: true }, DEFAULTS), { enabled: true, minAttendancePct: 50 });
});

test("an unusable value falls back to the base, never NaN or out of range", () => {
  assert.equal(merge({ minAttendancePct: "banana" }).minAttendancePct, 50);
  assert.equal(merge({ minAttendancePct: 0 }).minAttendancePct, 1);    // clamped: 0% would mark ghosts Present
  assert.equal(merge({ minAttendancePct: 250 }).minAttendancePct, 100); // clamped
  assert.equal(merge({ unknownKey: 1 }).unknownKey, undefined);         // allowlist
});
```

Run `node --test src/teamsAttendanceSettings.test.js` — expected FAIL.

- [ ] **Step 3: Implement `teamsAttendanceSettings.js`** — mirror
  `attendanceTapSettings.js`'s shape (read it): `DEFAULTS`, a `merge(patch, base)`
  that starts from `base || DEFAULTS`, coerces `enabled` with `=== true` /
  `String(v) === "true"`, clamps `minAttendancePct` to `[1, 100]` via
  `Number.isFinite`, drops unknown keys. Run tests — PASS.

- [ ] **Step 4: Implement `teamsAttendanceConfig.js`** by transcribing
  `attendanceTapConfig.js` (it is 140 lines and every one of its comments applies —
  keep the `lastConfirmed` failure semantics and the upsert-on-`"singleton"`; change
  only the model name, the settings module, and the cache-TTL env var name
  `TEAMS_ATTENDANCE_CACHE_MS`). No unit test, deliberately, for the same reason that
  file states at its top.

- [ ] **Step 5: Commit** — "The Teams attendance switch, shipped off, in the ninth-plus
  singleton config table".

---

### Task 7: `teamsSync.js` — the engine

**Files:**
- Create: `server/src/teamsSync.js`

**Interfaces:**
- Consumes: `teamsGraph` (Task 3), `teamsAttendance` (Task 4), `TEAMS_AUTO_STAMP`
  (Task 5), `teamsAttendanceConfig` (Task 6), `rosterForSession` from
  `./timetabling/registers`, `termOpenOn` from `./attendanceTap`, tap settings
  (`lateAfterMins`) from `./attendanceTapConfig`, `localDate`/`localTime` from
  `./clock`.
- Produces (Task 8 relies on): `runSync({ mode, startedBy }) -> Promise<{ run, summary,
  issues }>`; `isRunning() -> boolean`; `sweepStaleRuns() -> Promise<void>`.

- [ ] **Step 1: Write the engine.** Full shape (house-style comments abbreviated here —
  write them out, arguing from the spec):

```js
// The Teams attendance sync: discover meetings on the organizer accounts' calendars,
// match them to registers, and after each class ends write the marks its attendance
// report supports. Decisions live in teamsAttendance.js (pure, tested); Graph access
// in teamsGraph.js; this file only APPLIES them — the same split as
// timetabling/registers.js, for the same reason.
const prisma = require("./db");
const graph = require("./teamsGraph");
const { parseJoinUrl, matchMeeting, attendedMinutes, decideStatus } = require("./teamsAttendance");
const { TEAMS_AUTO_STAMP, termOpenOn } = require("./attendanceTap");
const { rosterForSession } = require("./timetabling/registers");
const teamsConfig = require("./teamsAttendanceConfig");
const tapConfig = require("./attendanceTapConfig");
const { localDate, localTime } = require("./clock");

// In-process, like every lock in this codebase (see conventions.md): correct for one
// Node process, and one process is what a deployment is.
let running = false;
function isRunning() { return running; }

// A run that died with status "running" must not block tomorrow's dedupe forever.
const STALE_MS = 60 * 60 * 1000;
async function sweepStaleRuns() {
  await prisma.teamsSync.updateMany({
    where: { status: "running", startedAt: { lt: new Date(Date.now() - STALE_MS) } },
    data: { status: "failed", error: "Abandoned — the process stopped mid-run.", finishedAt: new Date() },
  });
}

// The retry window. A session with a joinUrl and no teamsCollectedAt is simply still
// eligible; 7 days bounds that so a meeting nobody joined does not poll forever,
// while a weekend outage still self-heals on Monday. (Spec: "The flow", step 4.)
const RETRY_DAYS = 7;
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-CA", { timeZone: require("./clock").ZONE });
};
const daysAhead = (n) => {
  const d = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-CA", { timeZone: require("./clock").ZONE });
};

async function runSync({ mode = "manual", startedBy = null } = {}) {
  if (running) throw new Error("A Teams attendance sync is already running.");
  running = true;
  const run = await prisma.teamsSync.create({ data: { mode, startedBy } });
  const issues = [];
  const note = (m) => issues.push(String(m).slice(0, 500));
  const summary = {
    meetingsDiscovered: 0, sessionsMatched: 0, sessionsAmbiguous: 0,
    reportsFetched: 0, marksCreated: 0, marksSkippedExisting: 0,
    participantsUnmatched: 0,
  };
  try {
    // ---- DISCOVERY: put join URLs onto sessions that have none. -------------------
    const organizers = await graph.resolveOrganizers();
    const today = localDate();
    // Candidate registers: recent past (the retry window) through the coming week.
    const sessions = await prisma.hndSession.findMany({
      where: { date: { gte: daysAgo(RETRY_DAYS), lte: daysAhead(7) } },
      include: { unit: { select: { code: true, name: true, moodleSectionId: true, moodleCourseId: true, term: { select: { start: true, end: true } } } } },
    });
    // One matcher candidate per (date,startTime,title) GROUP OF SESSIONS, because a
    // merged class is several registers sharing one meeting — a match must land the
    // URL on every one of them, and counting each register as a separate candidate
    // would make every merged class "ambiguous" against itself.
    const groups = new Map(); // date|start|eventKey -> { id (rep), title, sessionIds }
    for (const s of sessions) {
      const key = `${s.date}|${s.startTime}|${s.timetableEventId || s.unitId}`;
      if (!groups.has(key)) groups.set(key, { id: key, date: s.date, startTime: s.startTime, title: s.description || s.unit?.name || s.unit?.code || "", sessionIds: [] });
      groups.get(key).sessionIds.push(s.id);
    }
    const candidates = [...groups.values()];
    for (const org of organizers) {
      let meetings = [];
      try { meetings = await graph.calendarView(org.id, daysAgo(RETRY_DAYS), daysAhead(7)); }
      catch (e) { note(`Calendar for ${org.email} could not be read: ${e.message}`); continue; }
      for (const m of meetings) {
        summary.meetingsDiscovered++;
        const url = parseJoinUrl(m.joinUrl);
        if (!url) continue;
        const verdict = matchMeeting({ subject: m.subject, date: m.date, startTime: m.startTime }, candidates);
        if (verdict.kind === "none") continue; // a staff meeting on the same calendar is not an issue
        if (verdict.kind === "ambiguous") {
          summary.sessionsAmbiguous++;
          note(`Meeting "${m.subject}" (${m.date} ${m.startTime}, organizer ${org.email}) matches more than one class — paste its join link onto the right timetable event to resolve it.`);
          continue;
        }
        const group = groups.get(verdict.id);
        // NEVER overwrite a URL already on the session: an admin's paste (carried
        // down from the event) or an earlier match stands. Fill blanks only.
        const r = await prisma.hndSession.updateMany({
          where: { id: { in: group.sessionIds }, teamsJoinUrl: null },
          data: { teamsJoinUrl: url, teamsOrganizerId: org.id },
        });
        if (r.count > 0) summary.sessionsMatched += r.count;
      }
    }

    // ---- COLLECTION: ended sessions with a URL and no collectedAt. ----------------
    const nowTime = localTime();
    const eligible = await prisma.hndSession.findMany({
      where: {
        teamsJoinUrl: { not: null }, teamsCollectedAt: null,
        date: { gte: daysAgo(RETRY_DAYS), lte: today },
      },
      include: { unit: { select: { code: true, name: true, moodleSectionId: true, moodleCourseId: true, term: { select: { start: true, end: true } } } } },
    });
    const tap = await tapConfig.get(); // lateAfterMins — the same lateness rule as taps
    const cfgTeams = await teamsConfig.get();
    for (const session of eligible) {
      // A future session is NEVER marked (global constraint). Zero-padded HH:MM
      // compares as strings, the codebase-wide convention.
      if (session.date === today && session.endTime >= nowTime) continue;
      // Term lock, as every write path honours it. Collected-and-refused, not
      // retried: the term will not reopen inside the retry window.
      if (!termOpenOn(session.unit?.term, session.date)) {
        note(`Register ${session.date} ${session.startTime} (${session.unit?.code || "?"}) is outside its term — no Teams marks written.`);
        await prisma.hndSession.update({ where: { id: session.id }, data: { teamsCollectedAt: new Date() } });
        continue;
      }
      // Resolve the meeting id once; an organizer id is on the session from
      // discovery, or must be findable by asking each organizer (the paste path has
      // no organizer) — try each until one answers.
      let meetingId = session.teamsMeetingId;
      let organizerId = session.teamsOrganizerId;
      if (!meetingId) {
        const tryOrgs = organizerId ? [{ id: organizerId }] : await graph.resolveOrganizers();
        for (const org of tryOrgs) {
          try {
            const id = await graph.resolveMeetingId(org.id, session.teamsJoinUrl);
            if (id) { meetingId = id; organizerId = org.id; break; }
          } catch (e) { note(`Resolving the meeting for ${session.date} ${session.startTime}: ${e.message}`); }
        }
        if (!meetingId) {
          note(`The Teams link on ${session.date} ${session.startTime} (${session.unit?.code || "?"}) resolves to no meeting on any organizer account — was it created elsewhere, or deleted?`);
          continue; // stays eligible; the retry window bounds this
        }
        await prisma.hndSession.update({ where: { id: session.id }, data: { teamsMeetingId: meetingId, teamsOrganizerId: organizerId } });
      }
      let participants;
      try { participants = await graph.attendanceIntervals(organizerId, meetingId); }
      catch (e) {
        note(`Attendance report for ${session.date} ${session.startTime} (${session.unit?.code || "?"}) could not be fetched: ${e.message}`);
        continue; // NO marks on a failed fetch — Absent is only written on success
      }
      summary.reportsFetched++;

      // Match participants to students: cached msUserId first, then email.
      const roster = await rosterForSession(session);
      const students = await prisma.student.findMany({
        where: { id: { in: roster.studentIds } },
        select: { id: true, email: true, msUserId: true },
      });
      const byMsId = new Map(students.filter((s) => s.msUserId).map((s) => [s.msUserId, s]));
      const byEmail = new Map(students.map((s) => [s.email.toLowerCase(), s]));
      const attendedBy = new Map(); // studentId -> participant
      for (const p of participants) {
        const s = (p.msUserId && byMsId.get(p.msUserId)) || (p.email && byEmail.get(p.email));
        if (!s) {
          // On the call but on no roster we can see. Reported, never guessed —
          // could be the teacher, could be a personal email. (Spec: "Unmatched
          // participants are reported, never guessed.")
          summary.participantsUnmatched++;
          note(`"${p.email || p.msUserId}" was in the ${session.date} ${session.startTime} meeting but matches no student on that register.`);
          continue;
        }
        if (p.msUserId && !s.msUserId) {
          // Cache the match, moodleUserId-style. Swallow a P2002: two students
          // sharing one Microsoft account is a data problem to report, not a crash.
          try { await prisma.student.update({ where: { id: s.id }, data: { msUserId: p.msUserId } }); }
          catch (e) { if (e?.code !== "P2002") throw e; note(`Microsoft account ${p.email} appears to belong to two students — id not cached.`); }
        }
        attendedBy.set(s.id, p);
      }

      // Decide every rostered student, then write ONLY where no mark stands.
      const rows = [];
      for (const studentId of roster.studentIds) {
        const p = attendedBy.get(studentId);
        const { minutes, firstJoin } = p
          ? attendedMinutes(p.intervals, session)
          : { minutes: 0, firstJoin: null };
        const d = decideStatus({ minutes, firstJoin, session, minAttendancePct: cfgTeams.minAttendancePct, lateAfterMins: tap.lateAfterMins });
        rows.push({
          sessionId: session.id, studentId, status: d.status, remark: d.remark,
          takenBy: TEAMS_AUTO_STAMP,
          // The arrival minute, only when they actually joined — null is "not
          // measurable", exactly as checkedInAt's own comment requires.
          checkedInAt: firstJoin,
        });
      }
      // createMany + skipDuplicates on @@unique([sessionId, studentId]) IS the
      // never-overwrite invariant, the same way moodleAttendance.js holds it.
      const before = await prisma.attendanceMark.count({ where: { sessionId: session.id } });
      const res = await prisma.attendanceMark.createMany({ data: rows, skipDuplicates: true });
      summary.marksCreated += res.count;
      summary.marksSkippedExisting += rows.length - res.count;
      // The audit trail, one row per written mark, in the tap log every other method
      // already writes. Refused (already-standing) marks get one line, not N rows.
      const written = res.count;
      if (written > 0) {
        await prisma.tagTap.createMany({
          data: rows.slice(0, 0).concat( // see note below
            []),
        }).catch(() => {});
      }
      await prisma.hndSession.update({ where: { id: session.id }, data: { teamsCollectedAt: new Date() } });
    }

    const finished = await prisma.teamsSync.update({
      where: { id: run.id },
      data: { status: "ok", finishedAt: new Date(), summary: JSON.stringify(summary), issues: JSON.stringify(issues) },
    });
    return { run: finished, summary, issues };
  } catch (e) {
    await prisma.teamsSync.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error: String(e.message || e).slice(0, 1000), summary: JSON.stringify(summary), issues: JSON.stringify(issues) },
    }).catch(() => {});
    throw e;
  } finally {
    running = false;
  }
}

module.exports = { runSync, isRunning, sweepStaleRuns };
```

  **Fix the TagTap block marked "see note below" properly:** after `createMany`,
  re-read which of `rows` now exist with `takenBy: TEAMS_AUTO_STAMP` and `sessionId`,
  and write one `tagTap.createMany` with
  `{ studentId, sessionId, method: "teams", outcome: "marked", status }` per actually
  written mark (the skipped ones get a single summary `note(...)` instead of rows —
  a lecturer-marked register would otherwise flood the log). Keep it simple:

```js
      if (res.count > 0) {
        const mine = await prisma.attendanceMark.findMany({
          where: { sessionId: session.id, takenBy: TEAMS_AUTO_STAMP },
          select: { studentId: true, status: true },
        });
        await prisma.tagTap.createMany({
          data: mine.map((m) => ({ studentId: m.studentId, sessionId: session.id, method: "teams", outcome: "marked", status: m.status })),
        });
      }
```

- [ ] **Step 2: Syntax-check and lint by loading it** (from `server/`):

```bash
node -e "require('./src/teamsSync.js'); console.log('loads')"
```

Expected: `loads`.

- [ ] **Step 3: Commit** — "The Teams sync engine: discover, match, resolve, fetch,
  decide, write — and never over a person's mark".

---

### Task 8: Scheduler hook + routes + mount

**Files:**
- Modify: `server/src/scheduler.js` (add `maybeSyncTeamsAttendance`, call it in
  `run()`, export it)
- Create: `server/src/routes/teamsAttendance.js`
- Modify: the server's app/router mounting file — find it with
  `grep -rn "routes/integrations" server/src --include=*.js` and mirror how
  `/api/integrations` is mounted, gated the same way.

**Interfaces:**
- Consumes: `teamsSync.runSync/isRunning/sweepStaleRuns` (Task 7),
  `teamsAttendanceConfig` (Task 6), `teamsGraph.isConfigured` (Task 3).
- Produces routes: `GET /api/teams-attendance/settings`,
  `PUT /api/teams-attendance/settings`, `POST /api/teams-attendance/sync`,
  `GET /api/teams-attendance/runs` — all `requireAuth, requirePage("settings")`.

- [ ] **Step 1: Scheduler.** In `scheduler.js`, after `maybeSyncMoodle`:

```js
// The Teams attendance poller. Unlike the Moodle import it runs at EVERY hourly tick
// rather than a fixed hour, because its work is "sessions that ended since last
// look" — naturally incremental, and cheap when there are none. The switch is the
// college's own (TeamsAttendanceConfig.enabled, shipped false); isConfigured() also
// gates it, so an enabled switch with no credentials does nothing rather than erroring
// hourly. Dedupe: the engine's own in-process lock plus a 30-minute window against
// the run log, so a restart inside the hour cannot double-run.
async function maybeSyncTeamsAttendance() {
  const teamsGraph = require("./teamsGraph");
  const teamsConfig = require("./teamsAttendanceConfig");
  const teamsSync = require("./teamsSync");
  const cfg = require("./integrationConfig");
  await cfg.load("teams");
  const settings = await teamsConfig.get();
  if (!settings.enabled) return false;
  if (!teamsGraph.isConfigured() || teamsSync.isRunning()) return false;
  await teamsSync.sweepStaleRuns();
  const recent = await prisma.teamsSync.count({
    where: { mode: "scheduled", status: { in: ["ok", "failed"] }, startedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
  });
  if (recent > 0) return false;
  console.log("Scheduler: starting the Teams attendance sync");
  const { summary } = await teamsSync.runSync({ mode: "scheduled" });
  console.log(`Scheduler: Teams attendance sync finished — ${summary.marksCreated} mark(s) written, ${summary.reportsFetched} report(s) read`);
  return true;
}
```

  In `run()` inside `startScheduler`, add (its own statement, like the others — a
  failing Teams sync must never stop the reminders):

```js
    maybeSyncTeamsAttendance()
      .catch((e) => console.error("Teams attendance sync failed:", e.message));
```

  Export it: add `maybeSyncTeamsAttendance` to `module.exports`.

- [ ] **Step 2: Routes.** Create `server/src/routes/teamsAttendance.js`:

```js
// The Teams attendance controls: the switch and threshold, a manual "Sync now", and
// the run history (which is where unmatched meetings and unmatched participants
// surface — the spec's "reported, never guessed" needs somewhere to report TO).
const express = require("express");
const prisma = require("./../db");
const { requireAuth, requirePage } = require("./../auth");
const audit = require("./../audit");
const config = require("./../teamsAttendanceConfig");
const teamsSync = require("./../teamsSync");
const graph = require("./../teamsGraph");

const router = express.Router();

router.get("/settings", requireAuth, requirePage("settings"), async (_req, res) => {
  res.json({ settings: await config.get(), configured: graph.isConfigured(), running: teamsSync.isRunning() });
});

router.put("/settings", requireAuth, requirePage("settings"), async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.minAttendancePct !== undefined) patch.minAttendancePct = body.minAttendancePct;
  const { settings } = await config.save(patch, req.user?.email || null);
  audit.record(req, {
    action: "teamsAttendance.settings", entity: "TeamsAttendanceConfig", entityId: "singleton",
    summary: `Teams attendance settings saved — ${settings.enabled ? "on" : "off"}, present needs ${settings.minAttendancePct}% of the class`,
    after: settings,
  });
  res.json({ settings });
});

router.post("/sync", requireAuth, requirePage("settings"), async (req, res) => {
  if (!graph.isConfigured()) return res.status(409).json({ error: "Teams attendance is not configured — enter the credentials under Connected systems first." });
  if (teamsSync.isRunning()) return res.status(409).json({ error: "A sync is already running." });
  try {
    const { summary, issues } = await teamsSync.runSync({ mode: "manual", startedBy: req.user?.name || req.user?.email || null });
    res.json({ ok: true, summary, issues });
  } catch (e) {
    res.status(502).json({ error: "The sync failed: " + e.message });
  }
});

router.get("/runs", requireAuth, requirePage("settings"), async (_req, res) => {
  const runs = await prisma.teamsSync.findMany({ orderBy: { startedAt: "desc" }, take: 20 });
  res.json({ runs: runs.map((r) => ({ ...r, summary: JSON.parse(r.summary || "{}"), issues: JSON.parse(r.issues || "[]") })) });
});

module.exports = router;
```

- [ ] **Step 3: Mount it** beside the integrations router (same file, same style):
  `app.use("/api/teams-attendance", require("./routes/teamsAttendance"))` — copy the
  exact mounting idiom the file uses.

- [ ] **Step 4: Prove auth-gating** by booting the API and curling
  `GET /api/teams-attendance/settings` unauthenticated — expect 401 — or defer to the
  smoke suite (Task 10 asserts it). Run the unit tests again
  (`node --test "src/**/*.test.js"`) to catch any require cycle.

- [ ] **Step 5: Commit** — "Teams sync on the hourly tick, with a Sync-now and the run
  history it reports into".

---

### Task 9: The rescue hatch — paste on the event, carried to the registers

**Files:**
- Modify: `server/src/routes/timetabling.js` (accept `teamsJoinUrl` on event
  create/update — find the field allowlist where `notes` is read and mirror it,
  validating through `parseJoinUrl` from `./teamsAttendance`: store the parsed value or
  `""`; a non-empty paste that does not parse answers 400
  `{ error: "That does not look like a Teams meeting link — copy it from the meeting's Join link." }`)
- Modify: `server/src/timetabling/registers.js` (carry-down)
- Modify: `client/src/AdminTimetablePlanner.jsx` (the event form — one text input)

**Interfaces:**
- Consumes: `parseJoinUrl` (Task 4); schema columns (Task 1).
- Produces: sessions created/updated from an event with a pasted link carry
  `teamsJoinUrl`, and a paste CHANGE resets the resolved meeting identity.

- [ ] **Step 1: Carry-down in `registers.js`.** In `syncEventRegisters`, extend the
  event read to select `teamsJoinUrl`, then after `shape` is built add:

```js
  // The admin's pasted link beats the calendar matcher (spec: "an explicit paste
  // always wins"), so it is written on create AND update — and a CHANGED paste
  // resets the resolved meeting identity, or the sync would keep reading the old
  // meeting's report against the new link. An EMPTY event field writes nothing:
  // blank is "no paste", not "remove the discovered link".
  const paste = (event.teamsJoinUrl || "").trim() || null;
```

  On the `update` branch, replace the plain `data: shape` with:

```js
      const data = { ...shape };
      if (paste && paste !== existing.teamsJoinUrl) {
        Object.assign(data, { teamsJoinUrl: paste, teamsMeetingId: null, teamsOrganizerId: null, teamsCollectedAt: null });
      }
      await prisma.hndSession.update({ where: { id: existing.id }, data });
```

  (extend the `existing` select with `teamsJoinUrl: true`). On the `create` branch add
  `teamsJoinUrl: paste,` to the created data.

- [ ] **Step 2: Route validation** in `routes/timetabling.js`, at both create and
  update where body fields are read:

```js
  const { parseJoinUrl } = require("../teamsAttendance"); // top of file with the other requires
  // In the handler:
  let teamsJoinUrl = "";
  if (typeof body.teamsJoinUrl === "string" && body.teamsJoinUrl.trim()) {
    const parsed = parseJoinUrl(body.teamsJoinUrl);
    if (!parsed) return res.status(400).json({ error: "That does not look like a Teams meeting link — copy it from the meeting's Join link." });
    teamsJoinUrl = parsed;
  }
```

  and include `teamsJoinUrl` in the event create/update data. Read the file first —
  mirror exactly how `notes` flows through, including any zod/validate layer.

- [ ] **Step 3: Client field.** In `AdminTimetablePlanner.jsx`, find the event form
  (search for the `notes` input); add beneath it, following the form's exact input
  idiom:

```jsx
  {/* The rescue hatch for Teams auto-attendance: pasted only when automatic calendar
      matching could not place this class's meeting. */}
  <input
    className={/* the form's existing input class */}
    value={form.teamsJoinUrl || ""}
    onChange={(e) => setForm((f) => ({ ...f, teamsJoinUrl: e.target.value }))}
    placeholder="Teams meeting link (optional — only if attendance didn't match automatically)"
  />
```

  and include `teamsJoinUrl` in the submit payload beside `notes`.

- [ ] **Step 4: Run the timetabling suites** (root):

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-timetable-registers
```

  and from `server/`: `node --test "src/timetabling/*.test.js"`. Expected: PASS.

- [ ] **Step 5: Commit** — "The paste rescue: a link on the event carries to its
  registers and beats the matcher".

---

### Task 10: `smoke-teams-attendance.mjs` — the pipeline, weighted toward refusals

**Files:**
- Create: `scripts/smoke-teams-attendance.mjs`
- Check: how the runner discovers suites (`scripts/` test runner picks up every
  `smoke-*.mjs` per CLAUDE.md — no registration needed) and whether it must export
  anything (read the head of `smoke-qr-checkin.mjs` and `scripts/setup.mjs`).

**Interfaces:**
- Consumes: every earlier task. The suite drives the REAL API over HTTP with the Graph
  layer faked via `TEAMS_GRAPH_FIXTURES` (Task 3's seam).
- **The API process must receive the env var.** The runner boots the API itself, so the
  suite cannot set it after the fact: write the fixtures file to a KNOWN path the suite
  creates at a location passed through, and have the suite RESTART nothing — instead,
  the suite sets the fixture path in the database? No — keep it simple and honest: the
  suite spawns its OWN API process on a spare port with `TEAMS_GRAPH_FIXTURES` set,
  the same way the runner does (read `scripts/setup.mjs` / the runner to copy the boot
  incantation), runs its assertions against that instance, and kills it. If the runner
  already supports per-suite env (check first), use that instead and note it in the
  suite header. SKIP (exit 2) with a printed reason if the port cannot be bound.

- [ ] **Step 1: Write the suite.** Header comment in the house style (what a Teams sync
  must never do). Skeleton of the scenario — seed via a bare PrismaClient exactly as
  `smoke-qr-checkin.mjs` does (copy its seeding of staff/course/unit/cohort/students /
  admin login helpers; use its `RUN` suffix idiom for unique emails):

  1. Seed: a unit, a cohort, three students (emails `s1-${RUN}@x.ac.uk` etc.), an
     enrolment each, an admin with the `settings` page, a published `TimetableEvent`
     with one group and a register (`HndSession`) dated YESTERDAY 09:00–10:30 (ended,
     inside the retry window), plus a SECOND register dated TOMORROW (must never be
     marked).
  2. Write the fixtures JSON: one organizer; a calendar containing (a) a meeting
     matching yesterday 09:00 with a join URL, (b) a meeting matching tomorrow's
     session, (c) a personal meeting at an unmatched time; `meetingIds` mapping the
     URL; `attendance` for the meeting id: student1 joined 09:00–10:20 (Present),
     student2 joined 09:20–10:30 (Late — with `lateAfterMins` default), student3
     absent from the report entirely, plus a participant `stranger-${RUN}@gmail.com`
     (must be reported unmatched, never marked).
  3. Before enabling: `POST /api/teams-attendance/sync` → asserts 409 ("not
     configured") — the ship-switched-off proof.
  4. Configure the `teams` integration via `PUT /api/integrations/teams` (requires
     `CREDENTIALS_KEY` — the suite sets a throwaway 32-byte key in the spawned API's
     env and SKIPs if it cannot spawn); enable via
     `PUT /api/teams-attendance/settings { enabled: true }`.
  5. Plant a lecturer's mark for student1 with status `A` (the disagreement case).
  6. `POST /api/teams-attendance/sync` → 200. Assertions:
     - student1's mark is STILL the lecturer's `A` (`takenBy` unchanged) — the
       never-overwrite invariant, the suite's most valuable assertion;
     - student2 has `L`, `takenBy === "Auto check-in (Teams)"`, `checkedInAt === "09:20"`;
     - student3 has `A` with `takenBy` the Teams stamp (rostered, report fetched,
       never joined);
     - TOMORROW's register has ZERO marks;
     - the run row (`GET /api/teams-attendance/runs`) reports
       `participantsUnmatched === 1` and an issue naming the stranger;
     - `TagTap` holds `method: "teams", outcome: "marked"` rows for the written marks
       and NONE for student1;
     - yesterday's session now carries `teamsMeetingId` and `teamsCollectedAt`;
     - a SECOND `POST /sync` writes nothing new (collectedAt idempotence).
  7. Failed-fetch case: a second session dated yesterday 11:00–12:30 whose meeting id
     resolves but whose `attendance` key is ABSENT from fixtures (Task 3's fixture
     code must throw for a missing key rather than answer `[]` — implement it as:
     `if (!(meetingId in (fx.attendance || {}))) throw new Error("fixture: no report")`;
     adjust Task 3 accordingly) → assert the session has NO marks and NO
     `teamsCollectedAt`, and the run lists the issue. **Absent is only written on a
     successful fetch.**
  8. Ambiguity case: two events at the same date+time with unhelpful titles and a
     fixture meeting at that time → assert neither register got a URL and the run's
     issues name the collision.
  9. Cleanup: delete everything seeded (the suites' standard practice — read how
     `smoke-qr-checkin.mjs` tears down and mirror it), kill the spawned API.

- [ ] **Step 2: Run it** (root):

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test -- smoke-teams-attendance
```

Expected: PASS with every assertion counted, or SKIP (exit 2) with a reason if the
spawn preconditions fail — never a vacuous PASS.

- [ ] **Step 3: Run the WHOLE suite** to prove nothing else regressed:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npm test
```

Expected: unit tests pass; every smoke suite PASS or its documented SKIP.

- [ ] **Step 4: Commit** — "The Teams smoke suite: most of its assertions are marks it
  proves were never written".

---

### Task 11: Settings surface + docs

**Files:**
- Modify: the attendance settings client screen (find it:
  `grep -rn "check-in-settings\|attendance-settings" client/src --include=*.jsx` — the
  screen added by `20260907T160000_attendance_settings_page`) — add a "Teams online
  classes" section: the enabled toggle, the minimum-% number input (1–100), a "Sync
  now" button calling `POST /api/teams-attendance/sync`, and the last runs list from
  `GET /api/teams-attendance/runs` rendering each run's counts and its `issues` lines
  (this is where "unmatched" surfaces to a human). Follow the screen's existing
  section/card idiom exactly; add the API calls to `client/src/api.js` beside
  `testIntegration`.
- Create: `TEAMS_SETUP.md` (repo root, beside `SHAREPOINT_SETUP.md` — read that file
  first and mirror its structure): the app registration; the three application
  permissions (`Calendars.Read`, `OnlineMeetings.Read.All`,
  `OnlineMeetingArtifact.Read.All`); admin consent; the **Teams application access
  policy** (`New-CsApplicationAccessPolicy` + `Grant-CsApplicationAccessPolicy` to the
  organizer accounts); the **Exchange application access policy**
  (`New-ApplicationAccessPolicy -AccessRight RestrictAccess` with a mail-enabled
  security group holding exactly the organizer accounts) — with the spec's sentence
  about why the calendar permission must be scoped; that `CREDENTIALS_KEY` must be set
  on the server; that meetings must be *scheduled* from the organizer accounts at the
  timetabled time with the class name in the title, teachers added as co-organizers;
  that Teams admin settings must leave attendance reports ON.
- Modify: `API.md` (the four new endpoints, in its existing format) and `STATUS.md`
  (a section under attendance: built, switched off by default, what is demonstrated by
  `smoke-teams-attendance.mjs` versus code-read — STATUS.md is explicit about that
  distinction; honour it).

- [ ] **Step 1:** Client section + `api.js` helpers; build check:
  `npm run --workspace client build` — expected: builds clean.
- [ ] **Step 2:** Write `TEAMS_SETUP.md`.
- [ ] **Step 3:** Update `API.md` and `STATUS.md`.
- [ ] **Step 4:** Full test run again (root, inline DATABASE_URL as always) — PASS.
- [ ] **Step 5: Commit** — "The Teams attendance controls on the settings screen, and
  the setup guide IT actually needs".

---

## Self-Review (done at planning time)

- **Spec coverage:** organizer accounts in Settings (T2), calendar discovery + matching
  (T3/T4/T7), paste rescue beats matcher (T7 fills blanks only + T9 resets identity),
  marking rules with clipping and configurable threshold (T4/T6), never overwrite
  (T7 `skipDuplicates`, proven T10), unmatched reported never guessed (T7, proven T10),
  Absent only on successful fetch (T7 `continue` on fetch error, proven T10 step 7),
  ships off (T6 DEFAULTS, proven T10 step 3), stamp + TagTap audit (T5/T7), run log +
  retry window (T1/T7), scheduler polling (T8), setup docs + scoped permissions (T11),
  smoke suite weighted to refusals (T10). "Live in-meeting presence", Zoom,
  platform-created meetings: out of scope per spec — no tasks, correctly.
- **Known judgement calls recorded for executors:** merged-class groups are matched as
  one candidate (T7) — this implements "one meeting, several registers"; Graph
  attendance timestamps are UTC while calendarView honours the Prefer header (T3 Step 1
  note) — do not "simplify" the two into one conversion path.
