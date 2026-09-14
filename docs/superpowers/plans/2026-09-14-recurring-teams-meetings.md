# Recurring Teams Class Meetings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create one recurring Microsoft Teams meeting per class series (spanning the class's real first→last dates, teacher as co-organizer), fan its single join link onto the timetable, the student app and the register, and keep per-date attendance correct.

**Architecture:** A new `TeamsSeriesMeeting` table keyed by `seriesId` holds the one recurring meeting per series. `teamsMeetings.js` gains a *series pass* (reconcile one recurring Graph event per series) ahead of its existing *per-event pass* (unchanged, one-offs only). `teamsGraph.js` gains recurring-event create/update, a co-organizer write, and a per-occurrence attendance fetch that preserves each report's date. `teamsSync.js` collection is reworked to apply only the attendance report whose date equals the session's date.

**Tech Stack:** Node/Express, Prisma + PostgreSQL, Microsoft Graph (app-only), `node:test` for pure units, HTTP smoke suites in `scripts/` driven by the `TEAMS_GRAPH_FIXTURES`/`TEAMS_GRAPH_JOURNAL` seam.

**Spec:** `docs/superpowers/specs/2026-09-14-recurring-teams-meetings-design.md`

## Global Constraints

- **Dates are strings** `YYYY-MM-DD`, compared as strings; times `HH:MM` zero-padded. Never use the host clock for a user-facing date — `src/clock.js` pins `APP_TIMEZONE` (`ZONE`).
- **Null means "not measurable", never 0.** A register with no matching attendance report gets **no marks written**, never Absent-by-default.
- **Never overwrite a standing mark or an existing join URL.** `createMany({ skipDuplicates: true })` on `@@unique([sessionId, studentId])`; `updateMany` filtered on `teamsJoinUrl: null`.
- **Serialise through allowlists.** Any new field exposed to a client goes through the existing serialiser allowlists, never shipped by default.
- **Fixtures seam is production-guarded** in `teamsGraph.js:fixtures()` (`NODE_ENV === "production"` forces null). Every new Graph write MUST follow the fixture-branch-first shape: `const fx = fixtures(); if (fx) { journal("op", args); return <deterministic fixture>; }` then the real call.
- **Additive-only** for provisioning/membership; **the machine only cancels a meeting it created** (a non-null owned id is how it tells its own meeting from a matched one).
- **Forward-only migrations**; never rename an applied migration directory (`.claude/rules/migrations.md`).
- **Run unit tests with the glob**, never a bare dir: `node --test "src/**/*.test.js"` (a bare `src/` boots the server and never exits).
- **Rollout (a):** recurring meetings apply to **newly-published series only**. A series that already carries legacy per-event meetings (any event with `teamsCalendarEventId` set and no `TeamsSeriesMeeting` row) is left untouched, not converted.
- **Local DB only for tests:** `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev"`. Never let it fall through to `server/.env`.

---

### Task 1: `TeamsSeriesMeeting` table + migration

**Files:**
- Modify: `server/prisma/schema.prisma` (add model near the other `Teams*` models, e.g. after `TeamsProvisionSync`)
- Create: `server/prisma/migrations/20260914T120000_teams_series_meeting/migration.sql`

**Interfaces:**
- Produces: Prisma delegate `prisma.teamsSeriesMeeting` with fields `id, seriesId (unique), calendarEventId, joinUrl, meetingId?, organizerId, fingerprint, coorganizersSetAt?, lastSyncedAt, createdAt`.

- [ ] **Step 1: Add the model to `schema.prisma`**

```prisma
// The ONE recurring Teams meeting that covers a whole timetable series (every weekly
// occurrence sharing a TimetableEvent.seriesId). A recurring meeting belongs to the
// series, not to any one occurrence, so it gets its own row rather than being pinned to
// an arbitrary "first" event. One-off events (seriesId null) keep using the per-event
// columns on TimetableEvent instead — see teamsMeetings.js's two passes.
model TeamsSeriesMeeting {
  id       String @id @default(cuid())
  // The TimetableEvent.seriesId this meeting covers. Unique: one recurring meeting per
  // series, and the lookup key the reconcile uses.
  seriesId String @unique
  // The recurring Graph calendar event (the series master) on the creator's calendar,
  // so a later run can PATCH or DELETE it. Set only by the machine.
  calendarEventId String
  joinUrl         String
  // The stable onlineMeeting id behind joinUrl, resolved once — needed for the
  // co-organizer write and for attendance collection.
  meetingId   String?
  // The creator account's Entra id (every Graph artifact fetch is addressed through it).
  organizerId String
  // subject|firstDate|lastDate|weekdays|startTime|endTime|sorted(attendees)|sorted(staff).
  // The reconcile PATCHes the meeting only when this differs from a freshly computed one,
  // the same gate teamsMeetings.js's per-event meetingFingerprint provides.
  fingerprint String
  // When co-organizer roles were last written, so an unchanged staff set is not
  // re-written on every hourly tick.
  coorganizersSetAt DateTime?
  lastSyncedAt DateTime @default(now())
  createdAt    DateTime @default(now())

  @@index([seriesId])
}
```

- [ ] **Step 2: Write the migration SQL**

```sql
-- CreateTable
CREATE TABLE "TeamsSeriesMeeting" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "joinUrl" TEXT NOT NULL,
    "meetingId" TEXT,
    "organizerId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "coorganizersSetAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamsSeriesMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamsSeriesMeeting_seriesId_key" ON "TeamsSeriesMeeting"("seriesId");

-- CreateIndex
CREATE INDEX "TeamsSeriesMeeting_seriesId_idx" ON "TeamsSeriesMeeting"("seriesId");
```

- [ ] **Step 3: Validate + generate + apply locally**

Run:
```bash
cd server && npx prisma validate
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" npx prisma migrate deploy
npm --workspace server run generate
```
Expected: `validate` OK; `migrate deploy` reports the new migration applied (or "already applied" on a re-run); generate succeeds.

- [ ] **Step 4: Prove the delegate exists and round-trips**

Run:
```bash
cd server && node -e "const p=new (require('@prisma/client').PrismaClient)({datasources:{db:{url:'postgresql://postgres:postgres@localhost:5432/edtech_dev'}}}); p.teamsSeriesMeeting.findMany().then(r=>{console.log('rows',r.length);return p.\$disconnect();})"
```
Expected: prints `rows 0` (table exists, query works).

- [ ] **Step 5: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/20260914T120000_teams_series_meeting
git commit -m "Add TeamsSeriesMeeting: one recurring meeting per class series"
```

---

### Task 2: Graph weekday helper (pure, tested)

**Files:**
- Modify: `server/src/teamsGraph.js` (add near `slug`/`dateOf` helpers)
- Create: `server/src/teamsGraph.weekday.test.js`

**Interfaces:**
- Produces: `graphWeekday(date: "YYYY-MM-DD") -> "sunday"|"monday"|...|"saturday"` — exported for testing and used by Task 4's recurring-create.

- [ ] **Step 1: Write the failing test**

```js
// server/src/teamsGraph.weekday.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { graphWeekday } = require("./teamsGraph");

test("maps ISO dates to Microsoft Graph weekday names", () => {
  assert.equal(graphWeekday("2026-09-14"), "monday");    // a Monday
  assert.equal(graphWeekday("2026-09-17"), "thursday");
  assert.equal(graphWeekday("2026-09-20"), "sunday");
});

test("is stable regardless of host timezone (parses as UTC)", () => {
  // 2026-09-14 is a Monday everywhere; a naive local parse near midnight must not drift.
  assert.equal(graphWeekday("2026-09-14"), "monday");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && node --test src/teamsGraph.weekday.test.js`
Expected: FAIL — `graphWeekday is not a function`.

- [ ] **Step 3: Implement `graphWeekday` and export it**

Add beside the other small helpers (after `slug`, ~line 79):
```js
// Microsoft Graph recurrence uses lowercase English weekday names. Parse the date as
// UTC (append T00:00:00Z) so the weekday never drifts by one near midnight on a host in
// a behind-UTC timezone — our date strings are calendar dates, not instants.
const GRAPH_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function graphWeekday(date) {
  return GRAPH_WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}
```
Add `graphWeekday` to `module.exports`.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd server && node --test src/teamsGraph.weekday.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/teamsGraph.js server/src/teamsGraph.weekday.test.js
git commit -m "Graph weekday name helper for recurring meetings"
```

---

### Task 3: Graph — create/update recurring meeting + set co-organizers

**Files:**
- Modify: `server/src/teamsGraph.js` (add after `cancelClassMeeting`, ~line 408; export all three)

**Interfaces:**
- Consumes: `graphFetch`, `fixtures`, `journal`, `slug`, `graphWeekday`, `resolveMeetingId`, `ZONE`.
- Produces:
  - `createRecurringClassMeeting({ organizerId, subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails }) -> { calendarEventId, joinUrl }` — `weekdays` is an array of Graph weekday names.
  - `updateRecurringClassMeeting({ organizerId, calendarEventId, subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails }) -> void`
  - `setMeetingCoorganizers({ organizerId, meetingId, coorganizerUserIds }) -> void`

- [ ] **Step 1: Implement `createRecurringClassMeeting`**

```js
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
```

- [ ] **Step 2: Implement `updateRecurringClassMeeting`**

```js
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
```

- [ ] **Step 3: Implement `setMeetingCoorganizers`**

```js
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
```

- [ ] **Step 4: Export the three**

Add to `module.exports` beside `createClassMeeting`:
```js
  createRecurringClassMeeting, updateRecurringClassMeeting, setMeetingCoorganizers,
```

- [ ] **Step 5: Verify nothing is broken and the file parses**

Run: `cd server && node -e "const g=require('./src/teamsGraph'); console.log(typeof g.createRecurringClassMeeting, typeof g.updateRecurringClassMeeting, typeof g.setMeetingCoorganizers)"`
Expected: prints `function function function`.

- [ ] **Step 6: Commit**

```bash
git add server/src/teamsGraph.js
git commit -m "Graph: recurring meeting create/update + co-organizer write"
```

---

### Task 4: Graph — per-occurrence attendance (preserve each report's date)

**Files:**
- Modify: `server/src/teamsGraph.js` (add `attendanceByOccurrence`; keep `attendanceIntervals` for now, remove its export in Task 6 once unused)
- Create: `server/src/teamsGraph.attendance.test.js`

**Interfaces:**
- Produces: `attendanceByOccurrence(organizerId, meetingId) -> [{ date: "YYYY-MM-DD", intervals: [{ email, msUserId, joinedAt, leftAt }] }]` — one entry per attendance report, tagged with the report's own local date. Also a pure exported helper `localDateFromGraph(dt) -> "YYYY-MM-DD"` and `mergeRecords(records) -> [{ email, msUserId, intervals }]` for unit testing.
- Fixture shape: `fx.attendanceByOccurrence[meetingId] = [{ date, intervals: [...] }]`. A missing key still throws `"fixture: no report"` (a missing report is a failed fetch, not "nobody attended").

- [ ] **Step 1: Write the failing test**

```js
// server/src/teamsGraph.attendance.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeRecords, localDateFromGraph } = require("./teamsGraph");

test("localDateFromGraph slices the calendar date from a Graph dateTime", () => {
  assert.equal(localDateFromGraph("2026-09-14T10:00:00.0000000Z"), "2026-09-14");
});

test("mergeRecords keys by person and concatenates intervals", () => {
  const recs = [
    { emailAddress: "a@x.ac.uk", identity: { user: { id: "u1" } }, attendanceIntervals: [{ joinDateTime: "2026-09-14T09:00:00Z", leaveDateTime: "2026-09-14T10:00:00Z" }] },
    { emailAddress: "a@x.ac.uk", identity: { user: { id: "u1" } }, attendanceIntervals: [{ joinDateTime: "2026-09-14T10:05:00Z", leaveDateTime: "2026-09-14T11:00:00Z" }] },
  ];
  const merged = mergeRecords(recs);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].msUserId, "u1");
  assert.equal(merged[0].intervals.length, 2);
});

test("mergeRecords drops an anonymous participant with no email and no id", () => {
  assert.equal(mergeRecords([{ attendanceIntervals: [] }]).length, 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && node --test src/teamsGraph.attendance.test.js`
Expected: FAIL — `mergeRecords is not a function`.

- [ ] **Step 3: Extract the pure helpers and add `attendanceByOccurrence`**

Add the two pure helpers (near `zonedTime`, ~line 220) and the new fetch (near `attendanceIntervals`, ~line 290):
```js
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
```
Add `attendanceByOccurrence, mergeRecords, localDateFromGraph` to `module.exports`.

> **Confirm during implementation:** that the attendanceReport resource returns `meetingStartDateTime`. If the live field name differs, adjust `localDateFromGraph`'s caller only — the pure helpers are unaffected. (Graph docs list `meetingStartDateTime`/`meetingEndDateTime` on attendanceReport.)

- [ ] **Step 4: Run it and watch it pass**

Run: `cd server && node --test src/teamsGraph.attendance.test.js`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add server/src/teamsGraph.js server/src/teamsGraph.attendance.test.js
git commit -m "Graph: per-occurrence attendance keeps each report's date"
```

---

### Task 5: Pure helper — pick the occurrence for a session's date

**Files:**
- Modify: `server/src/teamsAttendance.js` (add `occurrenceForDate`, export it)
- Modify: `server/src/teamsAttendance.test.js` (add tests; if the file does not exist, create it with the `node:test` header shown)

**Interfaces:**
- Produces: `occurrenceForDate(occurrences, date) -> { date, intervals } | null` — returns the occurrence whose `date` equals `date`, else null. `occurrences` is the shape from `attendanceByOccurrence`.

- [ ] **Step 1: Write the failing test**

```js
// add to server/src/teamsAttendance.test.js (create with this header if absent)
// const test = require("node:test");
// const assert = require("node:assert/strict");
// const { occurrenceForDate } = require("./teamsAttendance");

test("occurrenceForDate returns only the matching date's occurrence", () => {
  const occ = [
    { date: "2026-09-14", intervals: [{ email: "a@x", msUserId: "u1", intervals: [] }] },
    { date: "2026-09-21", intervals: [{ email: "b@x", msUserId: "u2", intervals: [] }] },
  ];
  assert.equal(occurrenceForDate(occ, "2026-09-21").intervals[0].email, "b@x");
});

test("occurrenceForDate returns null when no occurrence matches (no marks written)", () => {
  assert.equal(occurrenceForDate([{ date: "2026-09-14", intervals: [] }], "2026-09-28"), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && node --test src/teamsAttendance.test.js`
Expected: FAIL — `occurrenceForDate is not a function`.

- [ ] **Step 3: Implement `occurrenceForDate`**

```js
// One weekly occurrence's attendance, by date. A recurring meeting hands back one
// report per week (teamsGraph.attendanceByOccurrence); a register is one date, so it may
// only ever read its OWN week's report. No match returns null, and the caller writes NO
// marks — null is "not measurable", never Absent-by-default (conventions.md).
function occurrenceForDate(occurrences, date) {
  return (occurrences || []).find((o) => o.date === date) || null;
}
```
Add `occurrenceForDate` to `module.exports`.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd server && node --test src/teamsAttendance.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/teamsAttendance.js server/src/teamsAttendance.test.js
git commit -m "Pure helper: pick a recurring meeting's occurrence by date"
```

---

### Task 6: Rework `teamsSync.js` collection to be per-occurrence

**Files:**
- Modify: `server/src/teamsSync.js:162-186` (the meeting-id resolution + attendance fetch region) and its imports
- Modify: `server/src/teamsGraph.js` (drop `attendanceIntervals` from exports once unused — leave the function body, unexported, to keep the diff small)

**Interfaces:**
- Consumes: `graph.attendanceByOccurrence` (Task 4), `occurrenceForDate` (Task 5).
- Produces: no new exports; behaviour change only. Covered by the smoke suite in Task 9.

- [ ] **Step 1: Add the import**

At the top of `teamsSync.js`, extend the `teamsAttendance` destructure (line 12):
```js
const { parseJoinUrl, matchMeeting, attendedMinutes, decideStatus, occurrenceForDate } = require("./teamsAttendance");
```

- [ ] **Step 2: Memoise per-meeting occurrence fetches across the run**

Just inside `runSync`, beside the other run-scoped state (after `const summary = {...}`), add:
```js
// One recurring meeting id is shared by every week of a series, so its attendance
// reports are fetched ONCE per run and reused for each week's register — twelve weeks
// must not be twelve identical Graph calls. Keyed by meetingId; the value is the
// attendanceByOccurrence list (or the Error it threw, cached so a failed fetch is not
// retried twelve times in one run either).
const occurrencesByMeeting = new Map();
async function occurrencesFor(organizerId, meetingId) {
  if (!occurrencesByMeeting.has(meetingId)) {
    try { occurrencesByMeeting.set(meetingId, { ok: await graph.attendanceByOccurrence(organizerId, meetingId) }); }
    catch (e) { occurrencesByMeeting.set(meetingId, { err: e }); }
  }
  const hit = occurrencesByMeeting.get(meetingId);
  if (hit.err) throw hit.err;
  return hit.ok;
}
```

- [ ] **Step 3: Replace the attendance fetch (was `graph.attendanceIntervals`)**

Replace lines 181-187 (the `let participants; try { participants = await graph.attendanceIntervals(...) } ... summary.reportsFetched++;`) with:
```js
      let occurrences;
      try { occurrences = await occurrencesFor(organizerId, meetingId); }
      catch (e) {
        note(`Attendance report for ${session.date} ${session.startTime} (${session.unit?.code || "?"}) could not be fetched: ${e.message}`);
        continue; // NO marks on a failed fetch — Absent is only written on success
      }
      // A recurring meeting reports one occurrence per week; this register may read ONLY
      // its own date's occurrence, or the shared join URL would credit a student present
      // in any week to every week. A one-off meeting reports a single occurrence whose
      // date equals this session's date, so the same lookup serves both.
      const thisOccurrence = occurrenceForDate(occurrences, session.date);
      if (!thisOccurrence) {
        note(`No attendance report for ${session.date} ${session.startTime} (${session.unit?.code || "?"}) — the meeting had no session on that date yet.`);
        continue; // stays eligible inside the retry window
      }
      const participants = thisOccurrence.intervals;
      summary.reportsFetched++;
```

- [ ] **Step 4: Drop the now-unused export**

In `teamsGraph.js` `module.exports`, remove `attendanceIntervals` from the export list (leave the function defined but unexported — a later cleanup can delete it; keeping it avoids a large diff here). Confirm nothing else imports it:
```bash
cd server && grep -rn "attendanceIntervals" src/ | grep -v "attendanceByOccurrence"
```
Expected: only the (now unexported) definition in `teamsGraph.js`, no `require`/`graph.attendanceIntervals` call sites.

- [ ] **Step 5: Run the unit tests + confirm the server still boots-parse**

Run:
```bash
cd server && node --test "src/**/*.test.js"
node -e "require('./src/teamsSync'); console.log('teamsSync loads')"
```
Expected: all unit tests pass; prints `teamsSync loads`.

- [ ] **Step 6: Commit**

```bash
git add server/src/teamsSync.js server/src/teamsGraph.js
git commit -m "Collection: mark each register from its own week's attendance report"
```

---

### Task 7: `seriesFingerprint` pure helper (tested)

**Files:**
- Modify: `server/src/teamsMeetings.js` (add `seriesFingerprint`, export it)
- Modify: `server/src/teamsMeetings.test.js` (add tests)

**Interfaces:**
- Produces: `seriesFingerprint({ subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails, staffEmails }) -> string` — order-independent for `weekdays`, `attendeeEmails`, `staffEmails`; changes when any input changes.

- [ ] **Step 1: Write the failing test**

```js
// add to server/src/teamsMeetings.test.js
// const { seriesFingerprint } = require("./teamsMeetings");
const sbase = { subject: "OBM", firstDate: "2026-09-14", lastDate: "2026-12-07", weekdays: ["monday", "thursday"], startTime: "10:00", endTime: "12:00", attendeeEmails: ["a@x", "b@x"], staffEmails: ["t@x"] };

test("series: same inputs (any order) -> same fingerprint", () => {
  assert.equal(seriesFingerprint(sbase), seriesFingerprint({ ...sbase, weekdays: ["thursday", "monday"], attendeeEmails: ["b@x", "a@x"] }));
});
test("series: a changed lecturer changes the fingerprint", () => {
  assert.notEqual(seriesFingerprint(sbase), seriesFingerprint({ ...sbase, staffEmails: ["u@x"] }));
});
test("series: a changed end date changes the fingerprint", () => {
  assert.notEqual(seriesFingerprint(sbase), seriesFingerprint({ ...sbase, lastDate: "2026-12-14" }));
});
test("series: an added weekday changes the fingerprint", () => {
  assert.notEqual(seriesFingerprint(sbase), seriesFingerprint({ ...sbase, weekdays: ["monday", "thursday", "friday"] }));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && node --test src/teamsMeetings.test.js`
Expected: FAIL — `seriesFingerprint is not a function`.

- [ ] **Step 3: Implement `seriesFingerprint`**

```js
/**
 * A fingerprint of exactly the fields sent to Graph for a recurring series meeting —
 * subject, the date range, the weekly pattern, the times, the attendee list AND the
 * teaching-staff list (staff drive co-organizer, so a lecturer change must re-sync even
 * though attendees may already contain that email). All list fields sorted so order,
 * which owes nothing to a real change, does not read as one. The series pass PATCHes the
 * meeting only when this differs from the stored fingerprint — the same gate
 * meetingFingerprint gives the per-event pass.
 */
function seriesFingerprint({ subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails, staffEmails }) {
  return [
    subject, firstDate, lastDate, startTime, endTime,
    [...(weekdays || [])].sort().join(","),
    [...(attendeeEmails || [])].sort().join(","),
    [...(staffEmails || [])].sort().join(","),
  ].join("|");
}
```
Add `seriesFingerprint` to `module.exports`.

- [ ] **Step 4: Run it and watch it pass**

Run: `cd server && node --test src/teamsMeetings.test.js`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add server/src/teamsMeetings.js server/src/teamsMeetings.test.js
git commit -m "Pure helper: recurring-series meeting fingerprint"
```

---

### Task 8: `teamsMeetings.js` — the series pass

**Files:**
- Modify: `server/src/teamsMeetings.js` (add `reconcileSeries`, call it from `runMeetingsSync` before the per-event loop; make the per-event loop skip `seriesId != null`)

**Interfaces:**
- Consumes: `graph.createRecurringClassMeeting`, `graph.updateRecurringClassMeeting`, `graph.setMeetingCoorganizers`, `graph.resolveMeetingId`, `graph.resolveUserId`, `graph.resolveCreatorId`, `graphWeekday` (via `graph.graphWeekday`), `seriesFingerprint`, `prisma.teamsSeriesMeeting`.
- Produces: summary counters `seriesMeetingsCreated`, `seriesMeetingsUpdated`, `seriesMeetingsCancelled`; the recurring join URL fanned to `TimetableEvent.teamsJoinUrl` and `HndSession.teamsJoinUrl`/`teamsOrganizerId`/`teamsMeetingId`.

- [ ] **Step 1: Make the per-event loop skip series events (Rollout (a))**

In `runMeetingsSync`, the existing event loop (`for (const ev of events)`) must process one-offs only. At the top of that loop body, before `const wants = ...` (line 127), add:
```js
        // Series events are owned by the series pass (reconcileSeries), not this
        // per-event loop. EXCEPTION for rollout (a): a legacy series whose events already
        // carry a per-event teamsCalendarEventId (created before recurring meetings
        // existed) keeps being maintained here — reconcileSeries leaves those alone — so
        // only skip a series event that has NO legacy owned meeting.
        if (ev.seriesId && !ev.teamsCalendarEventId) continue;
```
And add `seriesId: true, teamsCalendarEventId: true` are already on the event (they are columns; the existing `findMany` selects the whole row, so no select change needed — confirm the query has no `select` narrowing them out).

- [ ] **Step 2: Implement `reconcileSeries`**

Add this function and call it. It runs before the per-event loop, inside the same `try` in `runMeetingsSync`, after `organizerId` is resolved:
```js
async function reconcileSeries({ organizerId, note, summary }) {
  // Candidate series: those with at least one still-relevant (>= yesterday) published,
  // wanted occurrence. Grouped by seriesId.
  const events = await prisma.timetableEvent.findMany({
    where: { seriesId: { not: null }, date: { gte: daysAgo(1) } },
    include: {
      unit: { select: { code: true, name: true } },
      staff: { select: { staff: { select: { email: true } } } },
      groups: { select: { cohortId: true } },
    },
    orderBy: { date: "asc" },
  });
  const bySeries = new Map();
  for (const ev of events) {
    if (!bySeries.has(ev.seriesId)) bySeries.set(ev.seriesId, []);
    bySeries.get(ev.seriesId).push(ev);
  }

  for (const [seriesId, group] of bySeries) {
    try {
      const wantedEvents = group.filter((e) => e.published && e.teamsAutoMeeting);
      const existing = await prisma.teamsSeriesMeeting.findUnique({ where: { seriesId } });

      // Rollout (a): a legacy series (per-event meetings already exist, no series row)
      // is left to the per-event loop; never converted here.
      const hasLegacyMeetings = group.some((e) => e.teamsCalendarEventId);
      if (!existing && hasLegacyMeetings) continue;

      // Not wanted (unpublished / checkbox cleared across the whole series) but we own a
      // recurring meeting: cancel OURS and clear the links.
      if (!wantedEvents.length) {
        if (existing) {
          await graph.cancelClassMeeting({ organizerId, calendarEventId: existing.calendarEventId });
          const ids = group.map((e) => e.id);
          await prisma.timetableEvent.updateMany({ where: { id: { in: ids } }, data: { teamsJoinUrl: "" } });
          await prisma.hndSession.updateMany({ where: { timetableEventId: { in: ids } }, data: { teamsJoinUrl: null, teamsMeetingId: null, teamsOrganizerId: null } });
          await prisma.teamsSeriesMeeting.delete({ where: { seriesId } });
          summary.seriesMeetingsCancelled++;
        }
        continue;
      }

      // Build the recurring meeting's inputs from the whole wanted series.
      const dates = wantedEvents.map((e) => e.date).sort();
      const firstDate = dates[0];
      const lastDate = dates[dates.length - 1];
      const weekdays = [...new Set(wantedEvents.map((e) => graph.graphWeekday(e.date)))].sort();
      const startTime = wantedEvents[0].startTime;
      const endTime = wantedEvents[0].endTime;
      const subject = wantedEvents[0].title || wantedEvents[0].unit?.name || wantedEvents[0].unit?.code || "Class";
      const staffEmails = [...new Set(wantedEvents.flatMap((e) => e.staff.map((s) => s.staff.email)))].filter(Boolean);
      // Attendees = staff + the unit's channel (one cohort only), same rule as the
      // per-event pass. Reuse channelEmailsFor on a representative event.
      const channelEmails = await channelEmailsFor(wantedEvents[0]);
      const attendeeEmails = [...new Set([...staffEmails, ...channelEmails])].filter(Boolean);
      const fp = seriesFingerprint({ subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails, staffEmails });

      let row = existing;
      if (!row) {
        const { calendarEventId, joinUrl } = await graph.createRecurringClassMeeting({ organizerId, subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails });
        row = await prisma.teamsSeriesMeeting.create({ data: { seriesId, calendarEventId, joinUrl, organizerId, fingerprint: fp } });
        summary.seriesMeetingsCreated++;
      } else if (fp !== row.fingerprint) {
        await graph.updateRecurringClassMeeting({ organizerId, calendarEventId: row.calendarEventId, subject, firstDate, lastDate, weekdays, startTime, endTime, attendeeEmails });
        row = await prisma.teamsSeriesMeeting.update({ where: { seriesId }, data: { fingerprint: fp, lastSyncedAt: new Date() } });
        summary.seriesMeetingsUpdated++;
      }

      // Fan the ONE join URL onto every occurrence's event + registers (blanks only, so
      // an admin's paste and an already-set link both stand — the never-overwrite rule).
      const ids = group.map((e) => e.id);
      await prisma.timetableEvent.updateMany({ where: { id: { in: ids }, teamsJoinUrl: "" }, data: { teamsJoinUrl: row.joinUrl } });
      await prisma.hndSession.updateMany({ where: { timetableEventId: { in: ids }, teamsJoinUrl: null }, data: { teamsJoinUrl: row.joinUrl, teamsOrganizerId: organizerId } });

      // Resolve the onlineMeeting id once, then promote staff to co-organizers when the
      // staff set changed (or was never written). Failure to resolve/promote is a NOTE,
      // never a thrown run — the meeting and its link already stand.
      if (!row.meetingId) {
        try {
          const mid = await graph.resolveMeetingId(organizerId, row.joinUrl);
          if (mid) row = await prisma.teamsSeriesMeeting.update({ where: { seriesId }, data: { meetingId: mid } });
        } catch (e) { note(`Series "${subject}": resolving its meeting id for co-organizers: ${e.message}`); }
      }
      if (row.meetingId && (!row.coorganizersSetAt || fp !== existing?.fingerprint)) {
        try {
          const ids2 = [];
          for (const email of staffEmails) { const uid = await graph.resolveUserId(email); if (uid) ids2.push(uid); else note(`Series "${subject}": ${email} has no Microsoft account — not made a co-organizer.`); }
          await graph.setMeetingCoorganizers({ organizerId, meetingId: row.meetingId, coorganizerUserIds: ids2 });
          await prisma.teamsSeriesMeeting.update({ where: { seriesId }, data: { coorganizersSetAt: new Date() } });
        } catch (e) { note(`Series "${subject}": setting co-organizers: ${e.message}`); }
      }
    } catch (e) {
      note(`Series ${seriesId}: ${e.message}`);
    }
  }
}
```

- [ ] **Step 3: Call it and extend the summary**

In `runMeetingsSync`, extend the `summary` object (line 100) with the new counters:
```js
  const summary = { meetingsCreated: 0, meetingsUpdated: 0, meetingsCancelled: 0, seriesMeetingsCreated: 0, seriesMeetingsUpdated: 0, seriesMeetingsCancelled: 0 };
```
Then, right after `organizerId` is resolved (after line 114's check), call:
```js
    await reconcileSeries({ organizerId, note, summary });
```

- [ ] **Step 4: Confirm it loads and unit tests pass**

Run:
```bash
cd server && node -e "require('./src/teamsMeetings'); console.log('teamsMeetings loads')"
node --test "src/**/*.test.js"
```
Expected: prints `teamsMeetings loads`; all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/teamsMeetings.js
git commit -m "Meetings sync: one recurring meeting per series, teacher as co-organizer"
```

---

### Task 9: Smoke — recurring meeting creation, co-organizer, idempotence (automation suite)

**Files:**
- Modify: `scripts/smoke-teams-automation.mjs` (add a scenario; extend the fixtures `users` with the teacher, add `meetingIds` for the fixture join URL so co-organizer resolution works)

**Interfaces:**
- Consumes: the running spawned API with `TEAMS_GRAPH_FIXTURES`/`TEAMS_GRAPH_JOURNAL`; `POST /api/teams-automation/meetings/sync` (confirm the exact route in `routes/teamsAutomation.js`); the journal file.

- [ ] **Step 1: Seed a published weekly series with a teacher and auto-meeting on**

Add a scenario that creates (via the timetabling API or directly via Prisma in the suite, matching how the suite seeds today) a series of ≥3 `TimetableEvent` rows sharing one `seriesId`, `published: true`, `teamsAutoMeeting: true`, one `TimetableEventStaff` (the teacher, whose email is in the fixtures `users` map), all on the same weekday/time. Fixtures file must map the teacher email → an Entra id and the deterministic series join URL → a meeting id:
```js
// in the fixtures object this suite writes:
users: { /* existing */ "teacher@edtech.co.uk": "ms-teacher-1" },
meetingIds: { "https://teams.microsoft.com/l/meetup-join/fixture-series-<subjectslug>-<firstdate>": "mtg-series-1" },
```

- [ ] **Step 2: Run the meetings sync and assert ONE recurring meeting, not N**

```js
// after POSTing the meetings sync:
const lines = readFileSync(JOURNAL, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const created = lines.filter((l) => l.op === "createRecurringClassMeeting");
assert.equal(created.length, 1, "exactly one recurring meeting for the whole series");
assert.equal(created[0].args.weekdays.length >= 1, true);
const perEvent = lines.filter((l) => l.op === "createClassMeeting");
assert.equal(perEvent.length, 0, "series events must NOT get per-occurrence meetings");
const coorg = lines.filter((l) => l.op === "setMeetingCoorganizers");
assert.equal(coorg.length, 1, "co-organizers written once");
assert.deepEqual(coorg[0].args.coorganizerUserIds, ["ms-teacher-1"]);
```

- [ ] **Step 3: Assert the link landed on every occurrence's session**

Query the DB for the series' `HndSession` rows and assert all carry the same non-null `teamsJoinUrl` equal to the fixture series URL.

- [ ] **Step 4: Re-run the sync and assert idempotence (the gate)**

Run the meetings sync a second time with nothing changed; assert **no** new `createRecurringClassMeeting`, `updateRecurringClassMeeting` or `setMeetingCoorganizers` line was appended (compare journal line counts before/after), and `seriesMeetingsCreated`/`seriesMeetingsUpdated` are 0 in the second run's summary.

- [ ] **Step 5: Change the lecturer, re-run, assert exactly one update + one co-organizer rewrite**

Swap the `TimetableEventStaff` to a different teacher (also in `users`), re-run; assert exactly one `updateRecurringClassMeeting` and one `setMeetingCoorganizers` line were added.

- [ ] **Step 6: Run the suite**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node scripts/smoke-teams-automation.mjs`
Expected: prints PASS with the new assertions; exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/smoke-teams-automation.mjs
git commit -m "Smoke: one recurring meeting per series, co-organizer, idempotent"
```

---

### Task 10: Smoke — per-week attendance does not cross-contaminate (attendance suite)

**Files:**
- Modify: `scripts/smoke-teams-attendance.mjs` (add a scenario using `attendanceByOccurrence` fixtures)

**Interfaces:**
- Consumes: the attendance sync route the suite already calls; the `TEAMS_GRAPH_FIXTURES` seam, now with `attendanceByOccurrence` keyed by meeting id.

- [ ] **Step 1: Seed two registers on different dates sharing ONE meeting id**

Create two `HndSession` rows for the same unit/roster on two dates (e.g. `2026-09-14` and `2026-09-21`), both with the SAME `teamsJoinUrl` and the same resolved `teamsMeetingId` (`mtg-series-1`) — i.e. one recurring meeting. Roster: two students, `alice` (present week 1 only) and `bob` (present week 2 only).

- [ ] **Step 2: Fixtures: one meeting id, reports on two dates**

```js
attendanceByOccurrence: {
  "mtg-series-1": [
    { date: "2026-09-14", intervals: [{ email: "alice@edtech.co.uk", msUserId: "ms-alice", intervals: [{ joinedAt: "10:00", leftAt: "12:00" }] }] },
    { date: "2026-09-21", intervals: [{ email: "bob@edtech.co.uk",   msUserId: "ms-bob",   intervals: [{ joinedAt: "10:00", leftAt: "12:00" }] }] },
  ],
},
```

- [ ] **Step 3: Run the attendance sync and assert per-date separation**

```js
// week 1 register: alice Present, bob NOT present (Absent/no-Present)
// week 2 register: bob Present, alice NOT present
// The bug this pins: without per-occurrence dates, BOTH would show BOTH present.
```
Assert via the marks API / DB: on the `2026-09-14` session alice's mark is Present and bob's is not Present; on the `2026-09-21` session bob's is Present and alice's is not. Neither student is Present on the other's week.

- [ ] **Step 4: Prove it can fail**

Temporarily point the sync at the old merge behaviour (or hand a fixture with both weeks' intervals under one date) and confirm the assertion catches the cross-contamination; then revert. (Per `.claude/rules/testing.md`: a regression test must be shown to fail on the bug.)

- [ ] **Step 5: Run the suite**

Run: `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/edtech_dev" node scripts/smoke-teams-attendance.mjs`
Expected: PASS; exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-teams-attendance.mjs
git commit -m "Smoke: a recurring link marks each week from its own report only"
```

---

### Task 11: Document the new Microsoft permission (`TEAMS_SETUP.md`)

**Files:**
- Modify: `TEAMS_SETUP.md` (Step 4 and/or Step 13 — the permissions list)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add `OnlineMeetings.ReadWrite.All`**

In the Phase-A permissions area (Step 13, where `Calendars.Read → Calendars.ReadWrite` is already described), add a paragraph: to make the teacher a **co-organizer**, replace `OnlineMeetings.Read.All` with **`OnlineMeetings.ReadWrite.All`** (write implies the read attendance needs) on the same app registration, and **grant admin consent** again. Note it is still scoped to the organizer accounts by the **existing** Teams application access policy (Step 7) — a policy scopes an app to *mailboxes*, not to a permission, so no policy change is needed, exactly as the `Calendars` upgrade needed none.

- [ ] **Step 2: Note the behaviour in the summary/intro**

Add one line where the doc explains meeting creation: online classes are now booked as **one recurring meeting per class** (not one per week), spanning the class's real dates, with the teacher as co-organizer.

- [ ] **Step 3: Commit**

```bash
git add TEAMS_SETUP.md
git commit -m "Docs: OnlineMeetings.ReadWrite.All for teacher co-organizers; recurring meetings"
```

---

## Self-review

**Spec coverage:**
- Recurring meeting per series spanning real dates → Tasks 3, 8. ✓
- One organizer + teacher co-organizer → Tasks 3, 8 (+ permission Task 11). ✓
- Students in standard channel → already built (provisioning); no task needed, noted in spec. ✓
- Link on timetable + student app + Teams → Task 8 fan-out (`TimetableEvent.teamsJoinUrl`, `HndSession.teamsJoinUrl`) + native recurring meeting. ✓
- Updates propagate (lecturer/details) → Task 8 fingerprint + co-organizer rewrite; Task 7 fingerprint. ✓
- Attendance correctness (the load-bearing risk) → Tasks 4, 5, 6, 10. ✓
- Rollout (a) leave legacy per-event meetings → Task 8 Step 1 + `reconcileSeries` legacy guard. ✓
- New permission documented → Task 11. ✓

**Placeholder scan:** the two "confirm during implementation" notes (attendanceReport field name in Task 4; the exact sync route in Task 9) are genuine live-Graph/route confirmations, each with the documented default to use and a fallback; not deferred implementation. No TODOs, no "handle edge cases", every code step has code.

**Type consistency:** `attendanceByOccurrence` returns `[{ date, intervals }]` (Task 4) — consumed by `occurrenceForDate(occurrences, date)` (Task 5) and `occurrencesFor`/`thisOccurrence.intervals` (Task 6). `seriesFingerprint` signature (Task 7) matches its call in `reconcileSeries` (Task 8). `graphWeekday` (Task 2) is used as `graph.graphWeekday` (Task 8) — both refer to the same export. `TeamsSeriesMeeting` fields (Task 1) match every `prisma.teamsSeriesMeeting.*` use in Task 8. Consistent.
